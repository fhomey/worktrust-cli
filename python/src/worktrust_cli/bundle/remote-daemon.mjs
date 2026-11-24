/**
 * THE REMOTE DAEMON'S CORE (2026-11-07, docs/remote-agents/PROTOCOL.md). One per computer, `worktrust remote run`.
 *
 * It answers phones' handshakes (a scanned invite confirms the phone; otherwise a confirmed phone is required and a new
 * one is listed as pending for `worktrust remote phones`), opens their commands, and runs the agents. A command is taken in
 * this order, and scripts/check-remote-cli.mjs refuses a change to it:
 *   1. validate the outer shape;  2. look it up in the journal WITHOUT admitting it (a duplicate is answered from the
 *   journal: its receipts again, nothing run again; another command under the same id is a conflict, dropped);
 *   3. open it (signature, time, replay window, seal, payload) - a failure never touches the journal;
 *   4. admit it to the journal, flushed to disk;  5. command.device_received;  6. only then dispatch it to an agent.
 * Events are journaled with their event_seq, then sealed once per open channel. Logs carry ids and types, never a body.
 */
import { basename } from "node:path";
import * as P from "./remote-protocol.mjs";
import { confirmedFingerprints, controllerKeys, defaultRootOf, deskReadOf, loadChannels, loadEndorsements, loadPhones, loadProjects, loadRoots, loadSettings, readJson, saveChannels, saveEndorsements, savePhones, saveProjects, saveSettings, writeJson } from "./remote-store.mjs";
import { acceptEndorsement } from "./remote-endorse.mjs";
import { createProject, rootLabel, sessionProjects, worktreeMain } from "./remote-projects.mjs";
import { agentOptionsOf } from "./remote-inventory.mjs";
import { allowedModes, applySettingsChange } from "./remote-settings.mjs";
import { adminInventory } from "./remote-admin.mjs";
import { createPeers, createQuietChannels } from "./remote-peers.mjs";
import { createNotices, projectNameOf } from "./remote-notices.mjs";
import { createCatchUp } from "./remote-catch-up.mjs";
import { createHistory } from "./remote-history.mjs";
import { createDeskSteer, withOrigins } from "./remote-desk-steer.mjs"; import { createVoice, voiceOff } from "./remote-voice.mjs";

// What a paused computer still answers: reading, configuring, disconnecting, and taking work away (a pipeline's cancel).
const LIVE_COMMANDS = new Set(["preview.live_start", "preview.live_input", "preview.live_viewport", "preview.live_follow"]);
const DEVICE_COMMANDS = new Set(["inventory.get", "device.configure", "status.get", "pairing.revoke", "notice.key", "release.list", "pipeline.cancel"]);
const NEW_SESSIONS = new Set(["agent.start", "release.start"]);
const KEEP_REMOVED = 20, MAX_PENDING_PHONES = 10;

export function createDaemonCore(o) {
  // o: { local, issuerKeys, journal, now, random, send(frame, { replayed }), room?() (the pacer, remote-pace.mjs), inventory(refresh), log(kind, fields), sessions?, approvals?, health?(), version? (this release: device.inventory `cli`) }
  const channels = new Map(loadChannels().map((c) => [c.channel_id, c]));
  const confirmed = () => new Set([...confirmedFingerprints(loadPhones()), ...voice.fingerprints()]); // a channel stays while its peer is confirmed here: a phone or browser at this keyboard, or (CLI 0.11.21) a voice key one of them enrolled
  const self = o.local.claims.device_id, persist = () => saveChannels([...channels.values()]);
  let sessions = null, approvals = o.approvals ?? null, releases = null;

  const peers = createPeers({ voiceOf: (phone) => voice.enrolledFor(phone), voiceKey: (peer) => voice.isVoice(peer) }); // what each phone asked to read, and what is sealed for it (remote-peers.mjs); a browser reads along since 0.11.20 (its key reaches the relay only after its Remote PIN)
  const quiet = createQuietChannels({ now: o.now, seenAt: (peer) => loadPhones().confirmed.find((p) => p.device_id === peer)?.seen_at ?? null }); // CLI 0.11.22: a channel the gateway refused by name, or (an older gateway) a peer silent for days, gets no transient event (remote-peers.mjs)
  // THE RESTART, SAID BEFORE IT HAPPENS (remote-service.mjs createHandover, remote-run.mjs stop): one ordinary inventory naming
  // `cli.restarting` (the relay lists what may be transient, and an inventory is not). announceRestart(false) withdraws it.
  let restarting = null;

  /**
   * THE SEALED NOTICE (release 38, remote-notices.mjs): a milestone of a session, sealed per channel under that phone's own
   * notice key, for its lock screen. Named from the record before any channel, never for a replay or the transient lane,
   * and only on a channel whose phone sent `notice.key`.
   */
  const notices = createNotices({ now: o.now, random: o.random, projectOf: projectNameOf(() => sessions?.listAll?.() ?? sessions?.list() ?? [], loadProjects) });

  // `only`: one phone's channel (a catch-up page is for the phone that asked, and a replay: it names no milestone).
  function sealAll(record, { replayed = false, only = null } = {}) {
    const milestone = replayed ? null : notices.observe(record);
    for (const [id, channel] of channels) {
      if (!confirmed().has(channel.peer_fingerprint)) { channels.delete(id); continue; } // a revoked phone hears nothing
      if (only !== null && channel.peer_device_id !== only) continue;
      if (quiet.skip(channel, record)) continue; // CLI 0.11.22: a channel the gateway forgot, or a silent peer's transient lane
      const voiced = voice.gate(channel, record); // a voice key hears its own receipts alone, and its channel ends with its last one (remote-voice.mjs)
      if (voiced === "drop") { channels.delete(id); continue; } if (voiced === "skip") continue;
      try { // one body the seal cannot take (review 2026-11-21, P2-2: half an emoji, canonicalBytes throws) is logged and skipped, never the end of every later inventory
      const notice = milestone ? notices.sealFor(channel.peer_device_id, record, milestone) : null;
      const draft = { protocol_version: channel.protocol_version, session_id: record.session_id, device_id: self, event_seq: record.event_seq, type: record.type, occurred_at: record.occurred_at, command_id: record.command_id, notify: record.notify, ...(record.lane ? { lane: record.lane } : {}), ...(notice ? { notice } : {}) };
      const sealed = P.sealEvent(channel, draft, peers.bodyFor(channel, record), o.random);
      if (!sealed.ok) { o.log("seal_refused", { type: record.type, code: sealed.code }); continue; }
      channels.set(id, sealed.value.channel);
      o.send({ frame: "event", envelope: sealed.value.envelope }, { replayed }); if (voiced === "last") channels.delete(id);
      } catch { o.log("seal_refused", { type: record.type, code: "unsealable" }); }
    }
    persist();
  }

  // `transient` (release 19; a pushed terminal screen, remote-screen-push.mjs): the session's TRANSIENT LANE (envelopes.ts), sealed for the phones and never
  // journaled, so a replay never brings back a stale screen and the session's own sequence has no number missing. Its numbers rise per session from this computer's clock.
  const laneSeq = new Map();
  // `local` (CLI 0.11.18): fields for THIS computer's journal record alone, beside the body and never sealed (sealAll seals
  // the body through peers.bodyFor), so a fact the computer reads back after a restart never reaches a phone that would refuse it.
  function emit(sessionId, type, body, commandId = null, notify = "none", { transient = false, only = null, local = null } = {}) {
    let shaped = P.validateEventBody(type, body);
    if (!shaped.ok && type === "agent.completed" && body.result) {
      // A result over its caps keeps the reply and names the files; the diffs are said to be cut.
      const files = body.result.files.map((f) => ({ ...f, diff: null, diff_cut: f.diff !== null || f.diff_cut }));
      body = { ...body, result: { ...body.result, files } };
      shaped = P.validateEventBody(type, body);
    }
    if (!shaped.ok) { o.log("event_refused", { type, detail: shaped.code }); return; }
    if (transient) {
      const seq = Math.max((laneSeq.get(sessionId) ?? 0) + 1, o.now());
      laneSeq.set(sessionId, seq);
      return sealAll({ session_id: sessionId, event_seq: seq, type, occurred_at: o.now(), command_id: null, notify: "none", lane: "transient", body }, { replayed: only !== null, only });
    }
    const record = { session_id: sessionId, event_seq: o.journal.nextSeq(sessionId), type, occurred_at: o.now(), command_id: commandId, notify, body, ...(local ? { local } : {}) };
    o.journal.recordEvent(record);
    sealAll(record);
  }

  // THE JOURNAL AGAIN (remote-catch-up.mjs; PROTOCOL.md §Catch-up): a page after a sequence (session.attach `after`) and the older whole attach, each sealed again
  // with its own event_seq (the phone dedups) for the ASKING phone alone, never as a milestone, in batches that wait for the pacer (`o.room`), one per phone at a time.
  const { catchUp, replay } = createCatchUp({ journal: o.journal, known: (id) => Boolean(sessions?.get?.(id) || o.journal.session(id)), room: () => o.room?.(), log: o.log,
    sealFor: (record, phone) => sealAll(record, { replayed: true, only: phone }) });
  // A PAGE OF HISTORY (remote-history.mjs; PROTOCOL.md §History): read here, sealed for the phone that asked ALONE, on the transient lane, journaled nowhere.
  // READING ALONG (CLI 0.11.19, remote-history-follow.mjs): only for a phone that asked `desk_live` and that the keyboard still confirms; its pages leave through the same one seal.
  const history = createHistory({ journal: o.journal, sessions: () => sessions, desk: o.desk, settings: loadSettings, agentEnv: o.agentEnv, now: o.now, room: () => o.room?.(), log: o.log, every: o.every,
    readsLive: (phone) => peers.readsLive(phone), confirmed: (phone) => [...channels.values()].some((c) => c.peer_device_id === phone && confirmed().has(c.peer_fingerprint)),
    projects: () => (o.projectSecret ? sessionProjects({ projects: loadProjects, roots: loadRoots, projectSecret: o.projectSecret }) : loadProjects()),
    sealPage: (body, phone) => { if (phone) emit(null, "history.page", withOrigins(body), null, "none", { transient: true, only: phone }); } }); // the guard is `only` and confirmed() in sealAll: one channel, of a phone the keyboard still confirms

  // STEERING A DESK SESSION (CLI 0.11.20, remote-desk-steer.mjs): its receipts name the command alone (device receipts), journaled as every other.
  const steer = createDeskSteer({ desk: o.desk, settings: loadSettings, readsSteer: (phone) => peers.readsSteer(phone) && [...channels.values()].some((c) => c.peer_device_id === phone && confirmed().has(c.peer_fingerprint)), voiceStill: (key) => voice.still(key), ended: (id, p) => { voice.replyAfter(id, p).catch(() => o.log("voice_answer_failed", {})); voice.answerReady(p); }, now: o.now, every: o.every, log: o.log,
    settle: (id, outcome) => { if (outcome === "taken") { o.journal.advance(id, { kind: "agent_accepted" }, o.now()); emit(null, "command.agent_accepted", {}, id); } else { o.journal.advance(id, { kind: "device_rejected", expired: outcome === "expired" }, o.now(), outcome); emit(null, "command.rejected", { reason: outcome }, id); } } });

  const voice = createVoice({ settings: loadSettings, phones: loadPhones, desk: o.desk, steer, projects: () => (o.projectSecret ? sessionProjects({ projects: loadProjects, roots: loadRoots, projectSecret: o.projectSecret }) : loadProjects()), now: o.now, log: o.log, issuerKeys: o.issuerKeys, account: o.local.claims.sub, lastAnswer: (ref, project) => history.lastAnswer(ref, project), deviceNotice: (phone, label) => { const n = peers.readsVoiceNotice(phone) ? notices.sealDevice(phone, self, label) : null; if (n) o.send({ frame: "device_notice", phone, notice: n }); return n !== null; }, answer: (peer, body) => emit(null, "voice.answer", body, null, "none", { transient: true, only: peer }) }); // VOICE PROMPTS WITH SIRI (CLI 0.11.21, remote-voice.mjs): a phone's voice key, enrolled by its phone, sends agent.prompt `voice_ref` alone
  function inventoryBody(refresh) {
    const settings = loadSettings();
    const inv = o.inventory(refresh);
    const body = {
      remote_enabled: settings.enabled && settings.paused === null,
      default_adapter: settings.default_adapter ?? null,
      default_model: settings.default_model ?? null,
      adapters: inv.reports,
      // A worktree names its main repository (`main`), only when it is one: a phone groups its sessions under that project.
      // 0.11.7: the existing git projects inside each root follow the granted ones (root_id set), 30 in all.
      projects: (o.projectSecret ? sessionProjects({ projects: loadProjects, roots: loadRoots, projectSecret: o.projectSecret }) : loadProjects().slice(0, 30)).map((p) => {
        const main = worktreeMain(p.path);
        return { project_id: p.project_id, label: (basename(p.path) || p.path).slice(0, 256), path: p.path.slice(0, 4096), last_used_at: null, root_id: p.root_id ?? null, ...(main ? { main: main.slice(0, 4096) } : {}) };
      }),
      roots: loadRoots().slice(0, 20).map((r) => ({ root_id: r.root_id, label: rootLabel(r.path), git_init: r.git_init === true })), ...(peers.readsDefaultRoot() ? { default_root: ((id) => (loadRoots().slice(0, 20).some((r) => r.root_id === id) ? id : null))(defaultRootOf()) } : {}), // CLI 0.11.21: the root the keyboard made (remote-default-root.mjs), read only; sealed only for a phone that asked `default_root`
      // Sealed only for a phone that asked `extended` (remote-peers.mjs bodyFor): what each agent offers, and the keyboard's ceiling.
      ...(inv.features ? { agent_options: agentOptionsOf(inv), modes_allowed: allowedModes(settings) } : {}),
      // Part B, also only for an `extended` phone: the admin switch, the folders this computer suggests (by its own ids),
      // and the phones and browsers linked to it (remote-admin.mjs).
      ...adminInventory({ projectSecret: o.projectSecret, settings }),
      ...(P.CLI_RELEASE.test(o.version ?? "") ? { cli: { version: o.version, ...(restarting ? { restarting } : {}) } } : {}),
      ...(peers.readsLive() ? { desk_read: deskReadOf(settings) } : {}), ...(peers.readsVoice() ? { voice: { on: !voiceOff(settings), enrolled: false, read: !voiceOff(settings) && settings.voice_read === true } } : {}), // what the keyboard lets a phone read of the desk; sealed only for a phone that asked `desk_live`
      // Every session this computer knows, live or in the journal, newest activity first, with its name and its release task.
      sessions: (sessions?.listAll?.() ?? sessions?.list() ?? []).map((s) => ({ ...s, ...(releases?.ownerOf(s.session_id) ?? {}) })).slice(0, 100),
    };
    // Release 36, read only while a phone that asked is linked: this computer's own Claude Code sessions, under the projects above.
    if (o.desk && peers.readsDesk()) { try { body.desk_sessions = o.desk.list().filter((d) => body.projects.some((p) => p.project_id === d.project_id)).map((d) => (peers.readsSteer() ? { ...d, steerable: steer.steerable(d, settings) } : d)); } catch { o.log("desk_unreadable", {}); } } // `steerable` sealed only for a phone that asked `desk_steer` (remote-peers.mjs)
    return body;
  }

  function resendReceipts(entry) {
    const meta = o.journal.meta(entry.command_id) ?? {};
    emit(meta.session_id ?? null, "command.device_received", {}, entry.command_id);
    if (entry.state === "REJECTED" || entry.state === "EXPIRED") emit(meta.session_id ?? null, "command.rejected", { reason: meta.reason ?? (entry.state === "EXPIRED" ? "expired" : "conflict") }, entry.command_id);
    else if (P.DELIVERY_RANK[entry.state] >= P.DELIVERY_RANK.AGENT_ACCEPTED) emit(meta.session_id ?? null, "command.agent_accepted", {}, entry.command_id);
  }

  /**
   * THE PHONE'S OWN RESEND UNDER A NEW SEAL (release 37). A phone that was away comes back on a new channel and sends a
   * message it kept, unconfirmed, sealed again under its OWN id and idempotency key (remote-client outbox-store.ts): other
   * bytes, so the ledger calls it a conflict, and dropping it left the phone at "Delivery unconfirmed" for ever while the
   * agent ran. Same id, same key, same sender, and it OPENS (the phone's signature, this channel): it is that duplicate,
   * answered with the stored receipts again. It is never admitted and never dispatched, so nothing runs twice; anything
   * else under a stored id stays a conflict and is dropped, as before.
   */
  function resealed(channel, envelope, input) {
    const entry = o.journal.entry(envelope.command_id);
    const same = entry !== null && entry.idempotency_key === input.idempotency_key && entry.sender_device_id === input.sender_device_id;
    const opened = same ? P.openCommand(channel, envelope, o.now()) : null;
    if (!opened || (!opened.ok && opened.code !== "expired")) return o.log("command_dropped", { code: "conflict", command_id: envelope.command_id });
    if (opened.ok) { channels.set(channel.channel_id, opened.value.channel); persist(); }
    o.log("command_resealed", { command_id: envelope.command_id });
    return resendReceipts(entry);
  }

  function reject(env, reason) {
    o.journal.advance(env.command_id, { kind: "device_rejected", expired: reason === "expired" }, o.now(), reason);
    emit(env.session_id, "command.rejected", { reason }, env.command_id);
  }

  /**
   * PART B: one settings change from the app or the web (device.configure `settings_change`). applySettingsChange checks
   * `remote admin on`, then the issuer-signed proof against THIS computer's pinned keys, device id and account (o.local,
   * never the payload), then resolves the change from this computer's own lists by id. The run terminal says it in words.
   */
  function settingsChange(env, sent) {
    const done = applySettingsChange(sent.change, { kind: "admin", proof: sent.proof, issuerKeys: o.issuerKeys, claims: o.local.claims, now: o.now() });
    if (!done.ok) { o.log("settings_refused", { code: done.code ?? "not_allowed" }); return done.code ?? "not_allowed"; }
    const by = loadPhones().confirmed.find((p) => p.device_id === env.sender_device_id);
    o.log("settings_changed", { setting: done.setting, by: by?.name ?? by?.fingerprint ?? env.sender_device_id });
    emit(null, "device.inventory", inventoryBody(false));
    return "taken";
  }

  /** A phone's or browser's own name (inventory.get `device_name`, validated by the protocol), kept with its record here. */
  function rememberName(deviceId, name) {
    const phones = loadPhones();
    if (!phones.confirmed.some((p) => p.device_id === deviceId && p.name !== name)) return;
    savePhones({ ...phones, confirmed: phones.confirmed.map((p) => (p.device_id === deviceId ? { ...p, name: name.slice(0, 64) } : p)) });
  }

  async function configure(payload, env) {
    if (payload.settings_change) return settingsChange(env, payload.settings_change);
    const settings = loadSettings();
    if (payload.remote_enabled === true && settings.paused === "desk") return "remote_paused"; // the desk's pause is the person's, at the keyboard
    const next = { ...settings };
    if (payload.remote_enabled !== undefined) next.paused = payload.remote_enabled ? null : settings.paused ?? "phone";
    if (payload.default_adapter !== undefined) next.default_adapter = payload.default_adapter;
    if (payload.default_model !== undefined) {
      const report = o.inventory(false).reports.find((r) => r.adapter === (next.default_adapter ?? "claude-code"));
      if (payload.default_model !== null && !(report && P.isModelReported(report, payload.default_model))) return "unknown_model";
      next.default_model = payload.default_model;
    }
    saveSettings(next);
    emit(null, "device.inventory", inventoryBody(false));
    return "taken";
  }

  /**
   * A phone goes (owner, 2026-11-07): it disconnected itself (its sealed pairing.revoke, or the gateway's device.revoked
   * after it), or the Passport revoked it. It leaves the confirmed and pending lists for `removed`, which `remote phones`
   * shows, and every channel with it closes now. Dropping a phone only ever takes power away, so the relay's word suffices.
   */
  function dropPhone(deviceId, how) {
    const phones = loadPhones();
    const gone = [...phones.confirmed, ...phones.pending].find((p) => p.device_id === deviceId);
    const keys = voice.drop(deviceId); // its voice keys go with it, or the voice key itself (CLI 0.11.21)
    for (const [id, c] of channels) if (c.peer_device_id === deviceId || keys.includes(c.peer_device_id)) channels.delete(id);
    persist();
    notices.dropPhone(deviceId);
    if (!gone) return false;
    savePhones({ ...phones, confirmed: phones.confirmed.filter((p) => p.device_id !== deviceId), pending: phones.pending.filter((p) => p.device_id !== deviceId),
      removed: [...(phones.removed ?? []).filter((p) => p.device_id !== deviceId), { device_id: deviceId, fingerprint: gone.fingerprint, how, removed_at: o.now() }].slice(-KEEP_REMOVED) });
    o.log("phone_removed", { how });
    return true;
  }

  async function dispatch(env, payload) {
    const settings = loadSettings();
    if (!settings.enabled) return "remote_paused";
    if (voice.isVoice(env.sender_device_id)) return settings.paused !== null ? "remote_paused" : voice.handle(env, payload); // a voice key's one command (remote-voice.mjs), nothing else
    if (env.type === "session.attach" && payload.after !== undefined) return catchUp(env.session_id, payload, env.sender_device_id); // reading, also while paused
    if (env.type === "history.get") { if (settings.paused !== null) return "remote_paused"; return history.get(payload, env.sender_device_id, env.command_id); } // a paused computer reads no transcript and no journal for anyone (review 2026-11-17, F3)
    if (settings.paused !== null && !DEVICE_COMMANDS.has(env.type)) return "remote_paused";
    if (env.type === "inventory.get") {
      peers.note(payload, env);
      if (payload.device_name && env.sender_device_id) rememberName(env.sender_device_id, payload.device_name);
      emit(null, "device.inventory", inventoryBody(payload.refresh_models));
      return "taken";
    }
    if (env.type === "device.configure") return configure(payload, env);
    if (env.type === "status.get" && payload.scope === "device") { emit(null, "device.inventory", inventoryBody(false)); return "taken"; }
    if (env.type === "pairing.revoke") return "taken"; if (env.type === "notice.key") { notices.takeKey(env.sender_device_id, payload); return "taken"; }
    if (env.type === "project.create") {
      const made = createProject({ name: payload.name, root: loadRoots().find((r) => r.root_id === payload.root_id), projectSecret: o.projectSecret, projects: loadProjects, saveProjects, now: o.now });
      if (!made.ok) return made.reason;
      emit(null, "project.created", { ...made.project, git: made.git }, env.command_id);
      emit(null, "device.inventory", inventoryBody(false));
      o.log("project_created", { git: made.git });
      return "taken";
    }
    if (env.type === "browser.endorse") {
      // A confirmed phone adds a browser it scanned (remote-endorse.mjs): only with this computer's opt-in, for its own account.
      const decided = acceptEndorsement({ allowed: settings.allow_endorse, phones: loadPhones(), spent: loadEndorsements().spent, sender: env.sender_device_id, payload, issuerKeys: o.issuerKeys, account: o.local.claims.sub, now: o.now() });
      if (!decided.ok) { o.log("endorse_refused", { reason: decided.reason }); return decided.reason; }
      saveEndorsements({ spent: decided.spent });
      if (decided.added) { savePhones(decided.phones); o.log("browser_endorsed", { device_id: decided.added.device_id, fingerprint: decided.added.fingerprint, by: decided.added.endorsed_by.device_id }); }
      return "taken";
    }
    if (env.type === "voice.enrol") return voice.enrol(env, payload); // a confirmed phone enrols its voice key: the keyboard's switch on, its own binding (remote-voice.mjs)
    if (env.type === "approval.decision") return approvals.decide(payload.decision_token).ok ? "taken" : "approval_invalid";
    // HEAVY MEMORY LOAD (remote-health.mjs, 2026-11-15): while red, no NEW session starts; running sessions continue. `busy`
    // is the reason every phone already knows; the run terminal says "This computer is under heavy memory load".
    if (NEW_SESSIONS.has(env.type) && o.health?.()?.refusing === true) { o.log("session_refused", { reason: "memory_load", type: env.type }); return "busy"; }
    if (P.RELEASE_COMMANDS.has(env.type)) return releases ? releases.handle(env, payload) : "unsupported"; // remote-releases.mjs
    if (env.type === "attachment.put" || env.type === "attachment.clear") return o.attachments ? o.attachments.handle(env, payload) : "unsupported"; // remote-attachments.mjs
    if (env.type === "preview.targets" || env.type === "preview.render") return o.preview ? o.preview.handle(env, payload) : "unsupported"; // remote-preview.mjs
    if (LIVE_COMMANDS.has(env.type)) return o.live ? o.live.handle(env, payload) : "unsupported"; // remote-live-preview.mjs
    if (env.type === "agent.prompt" && payload.desk_ref) return steer.prompt(env, payload); // into a session open at the desk (CLI 0.11.20): never a session of this daemon's
    const handled = await sessions.handle(env, payload);
    if (env.type === "session.close") await o.live?.sessionClosed(env.session_id); // its live preview ends with it
    return handled;
  }

  /** The order of this function is the at-most-once rule (see the header). */
  async function receiveCommand(envelope) {
    const shaped = P.validateCommandEnvelope(envelope);
    if (!shaped.ok) return o.log("command_dropped", { code: shaped.code });
    const channel = channels.get(envelope.payload_ciphertext.channel_id);
    if (!channel) return o.log("command_dropped", { code: "wrong_channel" });
    if (!confirmed().has(channel.peer_fingerprint) || voice.gate(channel, null) === "drop") { channels.delete(channel.channel_id); persist(); return o.log("command_dropped", { code: "not_confirmed" }); } quiet.heard(channel.channel_id);
    const input = { command_id: envelope.command_id, idempotency_key: envelope.idempotency_key, sender_device_id: envelope.sender_device_id, digest: P.envelopeDigest(envelope) };
    const found = o.journal.find(input);
    if (found === "conflict") return resealed(channel, envelope, input);
    if (found !== "unknown") return resendReceipts(found.duplicate);
    const opened = P.openCommand(channel, envelope, o.now());
    // A payload refused AFTER the signature and the seal verified names its (authenticated) type, never a byte of the payload (0.11.15).
    if (!opened.ok && opened.code !== "expired") return o.log("command_dropped", { code: opened.code, command_id: envelope.command_id, ...(opened.code === "payload" ? { type: envelope.type } : {}) });
    if (opened.ok) { channels.set(channel.channel_id, opened.value.channel); persist(); voice.claim(envelope); }
    const sid = (opened.ok && opened.value.payload?.desk_ref) || voice.isVoice(envelope.sender_device_id) ? null : envelope.session_id; // a prompt into a desk session, or anything from a voice key: device receipts, no session made
    const admitted = o.journal.admit(input, { type: envelope.type, session_id: sid, now: o.now() });
    if (admitted.verdict !== "new") return resendReceipts(admitted.entry);
    emit(sid, "command.device_received", {}, envelope.command_id);
    if (!opened.ok) return reject(envelope, "expired"); // authentic (the signature verified first) but late
    const outcome = await dispatch(opened.value.envelope, opened.value.payload); o.counts?.note(envelope.sender_device_id, outcome === "taken" ? envelope.type : null); // 0.11.22: counts only, in memory (remote-store.mjs createDeviceCounts)
    if (outcome === "taken") { o.journal.advance(envelope.command_id, { kind: "agent_accepted" }, o.now()); emit(sid, "command.agent_accepted", {}, envelope.command_id); }
    else if (outcome !== null) reject({ ...envelope, session_id: sid }, outcome);
    if (outcome === "taken" && envelope.type === "pairing.revoke") dropPhone(envelope.sender_device_id, "phone");
  }

  function receiveHello(hello) {
    const inspected = P.inspectHello(hello, o.local, { issuerKeys: o.issuerKeys, now: o.now() });
    if (!inspected.ok) return o.log("hello_refused", { code: inspected.code });
    const invite = readJson("invite.json");
    const live = invite && !invite.used && invite.e * 1000 > o.now() ? invite : null;
    const accepted = P.acceptHello({ self: o.local, hello, issuerKeys: o.issuerKeys, now: o.now(), random: o.random, knownChannels: new Set(channels.keys()), confirmedPhones: confirmedFingerprints(loadPhones()), confirmedVoice: voice.fingerprints(), ...(live ? { psk: P.pairingPsk(live.s) } : {}) });
    const phones = loadPhones();
    const phone = { device_id: inspected.value.phone.device_id, fingerprint: inspected.value.fingerprint, ed25519_pub: inspected.value.phone.ed25519_pub, x25519_pub: inspected.value.phone.x25519_pub };
    if (!accepted.ok) {
      if (accepted.code === "not_confirmed" && hello.pair_proof === undefined && inspected.value.phone.kind === "phone" && !phones.pending.some((p) => p.fingerprint === phone.fingerprint)) { // a voice key is never listed as a pending phone
        savePhones({ ...phones, pending: [...phones.pending, { ...phone, seen_at: o.now() }].slice(-MAX_PENDING_PHONES) });
      }
      return o.log("hello_refused", { code: accepted.code });
    }
    if (accepted.value.phone.kind === "voice" && !voice.fresh(accepted.value.phone)) return o.log("hello_refused", { code: "stale_binding" }); if (accepted.value.paired) { // voice audit P2-1: an older binding than the newest seen for that key is refused
      // Spent before the welcome leaves: an invite pairs one phone, once.
      writeJson("invite.json", { ...live, used: true, used_at: o.now(), used_by: phone.fingerprint });
      savePhones({ ...phones, removed: phones.removed.filter((p) => p.device_id !== phone.device_id), pending: phones.pending.filter((p) => p.fingerprint !== phone.fingerprint), confirmed: [...phones.confirmed.filter((p) => p.fingerprint !== phone.fingerprint), { ...phone, how: "qr", confirmed_at: o.now() }] });
    }
    const spoken = accepted.value.phone.kind === "voice"; // a voice key: its one short channel, no inventory, no last seen (CLI 0.11.21). Last seen (0.11.7, `remote connections`): the moment this phone last opened a channel, kept on this computer only
    if (spoken) voice.opened(accepted.value.phone); else { const now = loadPhones(); savePhones({ ...now, confirmed: now.confirmed.map((p) => (p.fingerprint === phone.fingerprint ? { ...p, seen_at: o.now() } : p)) }); }
    for (const [id, c] of channels) if (c.peer_device_id === phone.device_id) { channels.delete(id); quiet.drop(id); }
    channels.set(accepted.value.channel.channel_id, accepted.value.channel); quiet.heard(accepted.value.channel.channel_id); persist();
    o.send({ frame: "welcome", welcome: accepted.value.welcome });
    if (!spoken) emit(null, "device.inventory", inventoryBody(false));
  }

  return {
    emit, replay, receiveCommand, receiveHello, inventoryBody,
    /** `to`: the release it moves to, or null. → whether a phone was told (none reads `cli`, or nothing changed: nothing sent). */
    announceRestart(to) {
      const next = to === false ? null : { to: P.CLI_RELEASE.test(to ?? "") ? to : null, at: o.now() };
      if ((next === null) === (restarting === null) && next?.to === restarting?.to) return false;
      restarting = next;
      if (!peers.readsCli() || channels.size === 0 || !P.CLI_RELEASE.test(o.version ?? "")) return false;
      return emit(null, "device.inventory", inventoryBody(false)), true;
    },
    /** The computer's health (remote-health.mjs): device-wide on the transient lane, to every open channel, never journaled. */
    emitHealth(body) { if (channels.size > 0) emit(null, "device.health", body, null, "none", { transient: true }); },
    channelForgotten(id) { if (channels.has(id) && quiet.forgot(id)) o.log("channel_forgotten", { channel_id: id }); }, // the gateway's `not_paired` naming a channel (CLI 0.11.22): nothing more is sealed for it until its peer says hello again
    peerRevoked(event) { return dropPhone(event.device_id, event.reason === "unpaired" ? "phone" : "revoked"); }, // the gateway's device.revoked: a phone this computer will no longer hear from
    attach(s, a, r = null) { sessions = s; approvals = a; releases = r; },
    controllers: () => controllerKeys(loadPhones()),
    phoneOnline: () => channels.size > 0 && (o.online?.() ?? true),
    channels: () => [...channels.values()],
  };
}
