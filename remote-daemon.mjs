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
import { confirmedFingerprints, controllerKeys, loadChannels, loadEndorsements, loadPhones, loadProjects, loadRoots, loadSettings, readJson, saveChannels, saveEndorsements, savePhones, saveProjects, saveSettings, writeJson } from "./remote-store.mjs";
import { acceptEndorsement } from "./remote-endorse.mjs";
import { createProject, rootLabel, sessionProjects, worktreeMain } from "./remote-projects.mjs";
import { agentOptionsOf } from "./remote-inventory.mjs";
import { allowedModes, applySettingsChange } from "./remote-settings.mjs";
import { adminInventory } from "./remote-admin.mjs";

// What a paused computer still answers: reading, configuring, disconnecting, and taking work away (a pipeline's cancel).
const LIVE_COMMANDS = new Set(["preview.live_start", "preview.live_input", "preview.live_viewport", "preview.live_follow"]);
const DEVICE_COMMANDS = new Set(["inventory.get", "device.configure", "status.get", "pairing.revoke", "release.list", "pipeline.cancel"]);
const KEEP_REMOVED = 20;
const MAX_PENDING_PHONES = 10;

export function createDaemonCore(o) {
  // o: { local, issuerKeys, journal, now, random, send(frame), inventory(refresh), log(kind, fields), sessions?, approvals? }
  const channels = new Map(loadChannels().map((c) => [c.channel_id, c]));
  const confirmed = () => confirmedFingerprints(loadPhones());
  const self = o.local.claims.device_id;
  const persist = () => saveChannels([...channels.values()]);
  let sessions = null, approvals = o.approvals ?? null, releases = null;

  /**
   * THE 0.11.7 INVENTORY FIELDS REACH ONLY A PHONE THAT ASKED FOR THEM (inventory.get `extended`): an older phone refuses
   * unknown keys, so every other channel gets the inventory without them. Kept per phone for the daemon's life; a phone
   * asks again on every inventory.get.
   */
  const extendedPeers = new Set();
  const EXTENDED_KEYS = ["agent_options", "modes_allowed", "admin", "folders", "connections"];
  const bodyFor = (channel, record) => (record.type !== "device.inventory" || extendedPeers.has(channel.peer_device_id) ? record.body
    : Object.fromEntries(Object.entries(record.body).filter(([key]) => !EXTENDED_KEYS.includes(key))));

  function sealAll(record) {
    for (const [id, channel] of channels) {
      if (!confirmed().has(channel.peer_fingerprint)) { channels.delete(id); continue; } // a revoked phone hears nothing
      const draft = { protocol_version: channel.protocol_version, session_id: record.session_id, device_id: self, event_seq: record.event_seq, type: record.type, occurred_at: record.occurred_at, command_id: record.command_id, notify: record.notify, ...(record.lane ? { lane: record.lane } : {}) };
      const sealed = P.sealEvent(channel, draft, bodyFor(channel, record), o.random);
      if (!sealed.ok) { o.log("seal_refused", { type: record.type, code: sealed.code }); continue; }
      channels.set(id, sealed.value.channel);
      o.send({ frame: "event", envelope: sealed.value.envelope });
    }
    persist();
  }

  /**
   * `transient` (release 19; a pushed terminal screen, remote-screen-push.mjs): the session's TRANSIENT LANE
   * (envelopes.ts), sealed for the phones and never journaled, so a replay never brings back a stale screen and the
   * session's own sequence has no number missing. Its numbers rise per session from this computer's clock.
   */
  const laneSeq = new Map();
  function emit(sessionId, type, body, commandId = null, notify = "none", { transient = false } = {}) {
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
      return sealAll({ session_id: sessionId, event_seq: seq, type, occurred_at: o.now(), command_id: null, notify: "none", lane: "transient", body });
    }
    const record = { session_id: sessionId, event_seq: o.journal.nextSeq(sessionId), type, occurred_at: o.now(), command_id: commandId, notify, body };
    o.journal.recordEvent(record);
    sealAll(record);
  }

  /** Re-seal what the journal holds for a session after `after` (session.attach): same event_seq, so the phone dedups. */
  const replay = (sessionId, after) => { for (const record of o.journal.eventsAfter(sessionId, after)) sealAll(record); };

  function inventoryBody(refresh) {
    const settings = loadSettings();
    const inv = o.inventory(refresh);
    return {
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
      roots: loadRoots().slice(0, 20).map((r) => ({ root_id: r.root_id, label: rootLabel(r.path), git_init: r.git_init === true })),
      // Sealed only for a phone that asked `extended` (bodyFor above): what each agent offers, and the keyboard's ceiling.
      ...(inv.features ? { agent_options: agentOptionsOf(inv), modes_allowed: allowedModes(settings) } : {}),
      // Part B, also only for an `extended` phone: the admin switch, the folders this computer suggests (by its own ids),
      // and the phones and browsers linked to it (remote-admin.mjs).
      ...adminInventory({ projectSecret: o.projectSecret, settings }),
      // Every session this computer knows, live or in the journal, newest activity first, with its name and its release task.
      sessions: (sessions?.listAll?.() ?? sessions?.list() ?? []).map((s) => ({ ...s, ...(releases?.ownerOf(s.session_id) ?? {}) })).slice(0, 100),
    };
  }

  function resendReceipts(entry) {
    const meta = o.journal.meta(entry.command_id) ?? {};
    emit(meta.session_id ?? null, "command.device_received", {}, entry.command_id);
    if (entry.state === "REJECTED" || entry.state === "EXPIRED") emit(meta.session_id ?? null, "command.rejected", { reason: meta.reason ?? (entry.state === "EXPIRED" ? "expired" : "conflict") }, entry.command_id);
    else if (P.DELIVERY_RANK[entry.state] >= P.DELIVERY_RANK.AGENT_ACCEPTED) emit(meta.session_id ?? null, "command.agent_accepted", {}, entry.command_id);
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
    for (const [id, c] of channels) if (c.peer_device_id === deviceId) channels.delete(id);
    persist();
    if (!gone) return false;
    savePhones({ ...phones, confirmed: phones.confirmed.filter((p) => p.device_id !== deviceId), pending: phones.pending.filter((p) => p.device_id !== deviceId),
      removed: [...(phones.removed ?? []).filter((p) => p.device_id !== deviceId), { device_id: deviceId, fingerprint: gone.fingerprint, how, removed_at: o.now() }].slice(-KEEP_REMOVED) });
    o.log("phone_removed", { how });
    return true;
  }

  async function dispatch(env, payload) {
    const settings = loadSettings();
    if (!settings.enabled) return "remote_paused";
    if (settings.paused !== null && !DEVICE_COMMANDS.has(env.type)) return "remote_paused";
    if (env.type === "inventory.get") {
      if (payload.extended === true && env.sender_device_id) extendedPeers.add(env.sender_device_id);
      if (payload.device_name && env.sender_device_id) rememberName(env.sender_device_id, payload.device_name);
      emit(null, "device.inventory", inventoryBody(payload.refresh_models));
      return "taken";
    }
    if (env.type === "device.configure") return configure(payload, env);
    if (env.type === "status.get" && payload.scope === "device") { emit(null, "device.inventory", inventoryBody(false)); return "taken"; }
    if (env.type === "pairing.revoke") return "taken";
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
    if (env.type === "approval.decision") return approvals.decide(payload.decision_token).ok ? "taken" : "approval_invalid";
    if (P.RELEASE_COMMANDS.has(env.type)) return releases ? releases.handle(env, payload) : "unsupported"; // remote-releases.mjs
    if (env.type === "attachment.put" || env.type === "attachment.clear") return o.attachments ? o.attachments.handle(env, payload) : "unsupported"; // remote-attachments.mjs
    if (env.type === "preview.targets" || env.type === "preview.render") return o.preview ? o.preview.handle(env, payload) : "unsupported"; // remote-preview.mjs
    if (LIVE_COMMANDS.has(env.type)) return o.live ? o.live.handle(env, payload) : "unsupported"; // remote-live-preview.mjs
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
    if (!confirmed().has(channel.peer_fingerprint)) { channels.delete(channel.channel_id); persist(); return o.log("command_dropped", { code: "not_confirmed" }); }
    const input = { command_id: envelope.command_id, idempotency_key: envelope.idempotency_key, sender_device_id: envelope.sender_device_id, digest: P.envelopeDigest(envelope) };
    const found = o.journal.find(input);
    if (found === "conflict") return o.log("command_dropped", { code: "conflict", command_id: envelope.command_id });
    if (found !== "unknown") return resendReceipts(found.duplicate);
    const opened = P.openCommand(channel, envelope, o.now());
    if (!opened.ok && opened.code !== "expired") return o.log("command_dropped", { code: opened.code, command_id: envelope.command_id });
    if (opened.ok) { channels.set(channel.channel_id, opened.value.channel); persist(); }
    const admitted = o.journal.admit(input, { type: envelope.type, session_id: envelope.session_id, now: o.now() });
    if (admitted.verdict !== "new") return resendReceipts(admitted.entry);
    emit(envelope.session_id, "command.device_received", {}, envelope.command_id);
    if (!opened.ok) return reject(envelope, "expired"); // authentic (the signature verified first) but late
    const outcome = await dispatch(opened.value.envelope, opened.value.payload);
    if (outcome === "taken") { o.journal.advance(envelope.command_id, { kind: "agent_accepted" }, o.now()); emit(envelope.session_id, "command.agent_accepted", {}, envelope.command_id); }
    else if (outcome !== null) reject(envelope, outcome);
    if (outcome === "taken" && envelope.type === "pairing.revoke") dropPhone(envelope.sender_device_id, "phone");
  }

  function receiveHello(hello) {
    const inspected = P.inspectHello(hello, o.local, { issuerKeys: o.issuerKeys, now: o.now() });
    if (!inspected.ok) return o.log("hello_refused", { code: inspected.code });
    const invite = readJson("invite.json");
    const live = invite && !invite.used && invite.e * 1000 > o.now() ? invite : null;
    const accepted = P.acceptHello({ self: o.local, hello, issuerKeys: o.issuerKeys, now: o.now(), random: o.random, knownChannels: new Set(channels.keys()), confirmedPhones: confirmed(), ...(live ? { psk: P.pairingPsk(live.s) } : {}) });
    const phones = loadPhones();
    const phone = { device_id: inspected.value.phone.device_id, fingerprint: inspected.value.fingerprint, ed25519_pub: inspected.value.phone.ed25519_pub, x25519_pub: inspected.value.phone.x25519_pub };
    if (!accepted.ok) {
      if (accepted.code === "not_confirmed" && hello.pair_proof === undefined && !phones.pending.some((p) => p.fingerprint === phone.fingerprint)) {
        savePhones({ ...phones, pending: [...phones.pending, { ...phone, seen_at: o.now() }].slice(-MAX_PENDING_PHONES) });
      }
      return o.log("hello_refused", { code: accepted.code });
    }
    if (accepted.value.paired) {
      // Spent before the welcome leaves: an invite pairs one phone, once.
      writeJson("invite.json", { ...live, used: true, used_at: o.now(), used_by: phone.fingerprint });
      savePhones({ ...phones, removed: phones.removed.filter((p) => p.device_id !== phone.device_id), pending: phones.pending.filter((p) => p.fingerprint !== phone.fingerprint), confirmed: [...phones.confirmed.filter((p) => p.fingerprint !== phone.fingerprint), { ...phone, how: "qr", confirmed_at: o.now() }] });
    }
    // Last seen (0.11.7, `remote connections`): the moment this phone last opened a channel, kept with it on this computer only.
    { const now = loadPhones(); savePhones({ ...now, confirmed: now.confirmed.map((p) => (p.fingerprint === phone.fingerprint ? { ...p, seen_at: o.now() } : p)) }); }
    for (const [id, c] of channels) if (c.peer_device_id === phone.device_id) channels.delete(id);
    channels.set(accepted.value.channel.channel_id, accepted.value.channel);
    persist();
    o.send({ frame: "welcome", welcome: accepted.value.welcome });
    emit(null, "device.inventory", inventoryBody(false));
  }

  return {
    emit, replay, receiveCommand, receiveHello, inventoryBody,
    /** The gateway's device.revoked: a phone this computer will no longer hear from. */
    peerRevoked(event) { return dropPhone(event.device_id, event.reason === "unpaired" ? "phone" : "revoked"); },
    attach(s, a, r = null) { sessions = s; approvals = a; releases = r; },
    controllers: () => controllerKeys(loadPhones()),
    phoneOnline: () => channels.size > 0 && (o.online?.() ?? true),
    channels: () => [...channels.values()],
  };
}
