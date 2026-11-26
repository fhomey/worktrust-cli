/**
 * VOICE PROMPTS WITH SIRI (CLI 0.11.21; owner 2026-11-19 and 2026-11-22; docs/remote-agents/VOICE-SIRI.md). A spoken prompt from a
 * paired phone, unlocked or LOCKED, goes into the NEWEST steerable desk session of one project, through the desk door release 51
 * shipped (remote-desk-steer.mjs): this module adds a sender, never a second door.
 *
 *   the switch   `voice`, at this keyboard only (`npx worktrust remote voice on|off|status|remove`), default off; on needs desk
 *                steering on (which needs read along); steering or read along off takes it with it (remote-settings.mjs).
 *   enrolment    `voice.enrol { binding }` (acceptVoiceEnrol, pure): only while the switch is on, only from a phone this keyboard
 *                confirmed (or a scanned QR; never a browser, never a voice key), and only for an issuer binding of kind
 *                voice whose `parent` is that sender and whose account is this computer's. One voice key per phone.
 *   the peer     a voice key is its OWN role, listed apart from controllers (voice.json): it lives while its phone is
 *                confirmed here and its binding has not run out; removing or revoking the phone takes it.
 *   one command  from a voice peer the daemon takes agent.prompt `voice_ref` and nothing else (`not_allowed`): words only, a
 *                prompt of two minutes at most, one per 20 s and 30 a day per voice key, then the project (granted, listed)
 *                and its newest steerable session (none: `not_found`); `locked: true` reaches only a session in `default`
 *                or `plan` (else `locked_mode`); then every desk-steer rule, unchanged.
 *   what it hears  only the receipts of its OWN commands (gate below; remote-daemon.mjs sealAll): never an inventory, a
 *                history, a live step or an approval; its channel ends after its last receipt or two minutes.
 *   read aloud   (owner, 2026-11-22, also on a locked phone) only when its binding says `read` (the phone's own switch, signed
 *                by the phone) AND this keyboard said `remote voice read on`: the reply that ends the turn its own prompt
 *                started (replyAfter, at the mod's `ended`, while its channel is still open), and for `voice.read_last` the
 *                last completed reply of the project's newest desk session (one per 10 s, 60 a day per key). Sealed to that
 *                key alone as `voice.reply` on the transient lane, cut at 4,000 characters, sent once, kept nowhere.
 */
import * as P from "./remote-protocol.mjs";
import { knownBrowser, readJson, saveChosen, writeJson } from "./remote-store.mjs";
import { deskPromptOk, refreshSteerMod, steerOff } from "./remote-desk-steer.mjs";
import { spokenAnswer } from "./remote-voice-speech.mjs";
import { keyboardYes } from "./remote-keyboard.mjs";

export const VOICE_MIN_GAP_MS = 20_000;
export const VOICE_PER_DAY = 30;
export const VOICE_CHANNEL_MS = 2 * 60_000;
export const VOICE_READ_GAP_MS = 10_000, VOICE_READS_PER_DAY = 60;
const DAY_MS = 86_400_000;
const HEARS = new Set(["command.device_received", "command.agent_accepted", "command.rejected"]);
const LAST = new Set(["command.agent_accepted", "command.rejected"]);

/** Anything but every switch on (voice, desk steering, read along, the closed turns) is off. */
export const voiceOff = (s) => steerOff(s) || s?.voice !== true;
export const loadVoice = () => { const v = readJson("voice.json") ?? {}; return { peers: Array.isArray(v.peers) ? v.peers : [], sends: v.sends && typeof v.sends === "object" ? v.sends : {}, reads: v.reads && typeof v.reads === "object" ? v.reads : {} }; };
export const saveVoice = (v) => writeJson("voice.json", { v: 1, peers: v.peers, sends: v.sends, reads: v.reads ?? {} });
/** The last of a key's uses within a day, and whether one more fits `gap` and `perDay`. */
const within = (list, now) => (list ?? []).filter((at) => Number.isSafeInteger(at) && now - at < DAY_MS && at <= now + 60_000);
const roomFor = (list, now, gap, perDay) => list.length < perDay && (list.length === 0 || now - Math.max(...list) >= gap);
/**
 * The voice keys that may still speak: their phone confirmed here. NOT the expiry of the binding seen at enrolment (voice audit
 * P2-3: that killed voice seven days after enrolment although the phone renews the binding at each unlock): every hello presents
 * a binding the handshake checks for its own time (acceptHello), and opened() keeps the newest one's expiry, read flag and iat.
 * `_nowMs` stays in the signature for the callers.
 */
export const livePeers = (voice, phones, _nowMs) => voice.peers.filter((v) => phones.confirmed.some((p) => p.device_id === v.parent?.device_id));
/** Voice audit P2-1: whether a voice prompt was sent unlocked, by the unlock key's signature over its command id. */
export const unlockedSend = (peer, commandId, ref) => ref?.locked === false && typeof peer?.unlock_pub === "string" && P.deviceSignatureValid(P.voiceUnlockBytes(commandId), ref.unlock_sig, peer.unlock_pub);
/** Voice audit P2-1: a hello whose binding is OLDER than the newest one this computer saw for that key (an extracted key replaying a read:true binding after its phone renewed it without) is refused. */
export const bindingFresh = (voice, binding) => { const v = voice.peers.find((x) => x.device_id === binding?.device_id); return !v || !Number.isSafeInteger(v.binding_iat) || (Number.isSafeInteger(binding?.iat) && binding.iat >= v.binding_iat); };

/** → { ok: true, peer, voice, replaced } | { ok: false, reason } (a protocol reject reason). Pure. */
export function acceptVoiceEnrol({ settings, phones, voice, sender, payload, issuerKeys, account, now }) {
  if (voiceOff(settings)) return { ok: false, reason: "not_allowed" };
  const from = phones.confirmed.find((p) => p.device_id === sender);
  if (!from || (from.how !== "keyboard" && from.how !== "qr") || knownBrowser(sender, phones)) return { ok: false, reason: "not_allowed" };
  const b = P.verifyBinding(payload?.binding, { issuerKeys, now, kind: "voice", sub: account });
  if (!b.ok) return { ok: false, reason: b.code === "expired" ? "expired" : "not_allowed" };
  if (b.value.parent !== sender) return { ok: false, reason: "not_allowed" };
  if (!bindingFresh(voice, b.value)) return { ok: false, reason: "not_allowed" }; // re-review 2026-11-22: an older binding of the same key never takes the newest back (read off stays off)
  const peer = { device_id: b.value.device_id, fingerprint: P.bindingFingerprint(b.value), ed25519_pub: b.value.ed25519_pub, x25519_pub: b.value.x25519_pub, parent: { device_id: from.device_id, fingerprint: from.fingerprint }, enrolled_at: now, binding_exp: b.value.exp, binding_iat: b.value.iat, read: b.value.read === true, ...(b.value.unlock_pub ? { unlock_pub: b.value.unlock_pub } : {}) };
  const replaced = voice.peers.filter((v) => v.parent?.device_id === sender || v.device_id === peer.device_id).map((v) => v.device_id);
  return { ok: true, peer, replaced, voice: { ...voice, peers: [...voice.peers.filter((v) => !replaced.includes(v.device_id)), peer] } };
}

export function createVoice(o) {
  // o: { settings(), phones(), desk, steer, projects(), now(), log(kind, fields), issuerKeys, account, lastAnswer(ref, projectId), answer(peer, body) }
  const owned = new Map(); // command_id → { peer, kind: "prompt" | "read" }: its receipts (and a reply) go to that key's channel alone
  const readFlag = new Map(); // voice key → the `read` its binding said at its last handshake (the phone renews the binding at each unlock)
  const live = () => livePeers(loadVoice(), o.phones(), o.now());
  const peerOf = (id) => live().find((v) => v.device_id === id) ?? null;
  const isVoice = (id) => peerOf(id) !== null;
  /** Both gates: the key's binding says read (its phone's own switch) AND the keyboard said `remote voice read on`. */
  const mayRead = (id) => { const s = o.settings(), peer = peerOf(id); return peer !== null && !voiceOff(s) && s.voice_read === true && (readFlag.get(id) ?? peer.read) === true; };
  const expecting = new Set(); // a voice key whose read_last answer is being sealed right now (that answer names no command)
  /** voice.answer for one key: spoken text made here (remote-voice-speech.mjs), sealed to it alone. → whether anything was said. */
  const say = (peer, commandId, answer, running) => {
    const spoken = spokenAnswer(answer.text);
    if (!spoken.parts.length) return false;
    if (commandId === null) expecting.add(peer);
    try { o.answer(peer, { command_id: commandId, parts: spoken.parts, running, truncated: spoken.truncated }); } finally { expecting.delete(peer); }
    return true;
  };

  async function readLast(env, payload) {
    const peer = peerOf(env.sender_device_id);
    if (!peer || !mayRead(peer.device_id)) return "not_allowed";
    if (!P.voiceLifetimeOk(env.issued_at, env.expires_at)) return "unsupported";
    const voice = loadVoice(), now = o.now(), reads = within(voice.reads[peer.device_id], now);
    if (!roomFor(reads, now, VOICE_READ_GAP_MS, VOICE_READS_PER_DAY)) return "busy";
    saveVoice({ ...voice, reads: { ...voice.reads, [peer.device_id]: [...reads, now].slice(-VOICE_READS_PER_DAY) } }); // audit P3-4: every attempt counts
    if (!o.projects().some((p) => p.project_id === payload.project_id)) return "not_found";
    let rows = [];
    try { rows = o.desk.list().filter((d) => d.project_id === payload.project_id); } catch { return "not_found"; }
    const newest = rows.sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))[0];
    if (!newest) return "not_found";
    const answer = await o.lastAnswer(newest.session_ref, payload.project_id);
    if (typeof answer === "string") return answer;
    if (!say(peer.device_id, null, answer, answer.running === true)) return "not_found"; // before the acceptance: the acceptance ends the channel
    o.log("voice_read", { phone: peer.parent.fingerprint, project_id: payload.project_id });
    return "taken";
  }

  function enrol(env, payload) {
    const decided = acceptVoiceEnrol({ settings: o.settings(), phones: o.phones(), voice: loadVoice(), sender: env.sender_device_id, payload, issuerKeys: o.issuerKeys, account: o.account, now: o.now() });
    if (!decided.ok) { o.log("voice_refused", { reason: decided.reason }); return decided.reason; }
    saveVoice(decided.voice);
    readFlag.set(decided.peer.device_id, decided.peer.read); // re-review 2026-11-22: the newest binding speaks for a channel opened before it (read off at once)
    o.log("voice_enrolled", { phone: decided.peer.parent.fingerprint, fingerprint: decided.peer.fingerprint });
    return "taken";
  }

  function prompt(env, payload) {
    const settings = o.settings(), ref = payload?.voice_ref, peer = peerOf(env.sender_device_id);
    if (env.type !== "agent.prompt" || !ref || !peer || voiceOff(settings)) return "not_allowed";
    if (!P.voiceLifetimeOk(env.issued_at, env.expires_at) || payload.desk_ref !== undefined || payload.attachments !== undefined || payload.model !== undefined || payload.interrupt !== undefined) return "unsupported";
    if (!deskPromptOk(payload.text)) return "not_prompt";
    const voice = loadVoice(), now = o.now(), sent = (voice.sends[peer.device_id] ?? []).filter((at) => Number.isSafeInteger(at) && now - at < DAY_MS && at <= now + 60_000);
    if (sent.length >= VOICE_PER_DAY || (sent.length > 0 && now - Math.max(...sent) < VOICE_MIN_GAP_MS)) return "busy";
    // Voice audit P3-4: EVERY attempt past the switch counts toward the key's limits, refused or not, so a key cannot probe projects,
    // sessions or modes faster than it may send.
    saveVoice({ ...voice, sends: { ...voice.sends, [peer.device_id]: [...sent, now].slice(-VOICE_PER_DAY) } });
    if (!o.projects().some((p) => p.project_id === ref.project_id)) return "not_found"; // granted and listed here, by its id only
    let rows = [];
    try { rows = o.desk.list().filter((d) => d.project_id === ref.project_id && o.steer.steerable(d, settings)); } catch { return "not_found"; }
    const newest = rows.sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))[0];
    if (!newest) return "not_found";
    // Voice audit P2-1: "sent unlocked" is believed only with the unlock key's signature over this command id (that key is readable
    // on the phone only while it is unlocked); without it, or with one that does not verify under the binding's unlock_pub, the
    // prompt counts as sent LOCKED (default and plan only), whatever `locked` says.
    const locked = !unlockedSend(peer, env.command_id, ref);
    const out = o.steer.prompt(env, { text: payload.text, desk_ref: { session_ref: newest.session_ref, project_id: ref.project_id } }, { voice: true, modes: locked ? P.VOICE_LOCKED_MODES : null, route: ref.route });
    if (out !== null) return out;
    o.log("voice_steered", { phone: peer.parent.fingerprint, locked, project_id: ref.project_id });
    return null;
  }

  return {
    enrol, prompt, isVoice, mayRead,
    /** Everything a voice key sends: its prompt, or (reading aloud) the last reply; nothing else (`not_allowed`). */
    handle: (env, payload) => (env.type === "voice.read_last" ? readLast(env, payload) : prompt(env, payload)),
    /** A voice hello's binding (handshake): what it says of reading, as the phone set it at its last unlock. */
    /** A voice hello the handshake accepted: its binding's read flag, expiry and iat are kept (P2-3: the renewed binding is the one that counts). */
    opened(binding) {
      if (binding?.kind !== "voice") return;
      readFlag.set(binding.device_id, binding.read === true);
      const voice = loadVoice(), at = voice.peers.findIndex((v) => v.device_id === binding.device_id);
      if (at >= 0 && bindingFresh(voice, binding)) saveVoice({ ...voice, peers: voice.peers.map((v, i) => (i === at ? { ...v, binding_exp: binding.exp, binding_iat: binding.iat, read: binding.read === true, unlock_pub: binding.unlock_pub ?? null } : v)) });
    },
    /** Whether a voice hello's binding is not older than the newest seen for that key (P2-1); the daemon refuses it otherwise. */
    fresh: (binding) => binding?.kind !== "voice" || bindingFresh(loadVoice(), binding),
    /** The steer mod said the turn a voice prompt started ENDED: its reply, to that key alone, if both gates let it read. */
    /**
     * "ANSWER READY" (build 31, protocol device-notice.ts): a voice-steered desk turn ended (the steer mod's `ended`): its voice
     * key's PARENT phone gets the content-free device notice, sealed under that phone's notice key, only if that phone asked
     * `voice_notice` (the daemon's deviceNotice checks it). Two names and the time; nothing the agent wrote.
     */
    answerReady(p) {
      if (!p?.voice) return false;
      const key = loadVoice().peers.find((v) => v.device_id === p.phone), parent = key?.parent?.device_id;
      if (!parent || !o.phones().confirmed.some((x) => x.device_id === parent) || typeof o.deviceNotice !== "function") return false;
      const project = o.projects().find((x) => x.project_id === p.project_id);
      return o.deviceNotice(parent, project ? String(project.path ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? null : null);
    },
    async replyAfter(commandId, p) {
      const mine = owned.get(commandId);
      if (!p?.voice || !mine || mine.kind !== "prompt" || !mayRead(mine.peer)) return;
      const answer = await o.lastAnswer(p.ref, p.project_id);
      if (typeof answer === "string" || (Number.isSafeInteger(answer.at) && answer.at < p.first - 1_000)) return; // never an older reply
      say(mine.peer, commandId, answer, false);
    },
    /** Whether this phone's voice key is enrolled here (device.inventory `voice.enrolled`, for that phone alone). */
    enrolledFor: (phone) => live().some((v) => v.parent?.device_id === phone),
    /** The fingerprints a voice hello may present (handshake.ts `confirmedVoice`). */
    fingerprints: () => new Set(live().map((v) => v.fingerprint)),
    /** A command opened from a voice key: its receipts are that key's alone. */
    claim(envelope) { if (isVoice(envelope.sender_device_id)) owned.set(envelope.command_id, { peer: envelope.sender_device_id, kind: envelope.type === "voice.read_last" ? "read" : "prompt" }); },
    /** Still waiting may a voice prompt (remote-desk-steer.mjs tick): its key live and every switch on. */
    still: (id) => isVoice(id) && !voiceOff(o.settings()),
    /**
     * For one channel and one record (null: a command arriving): "send", "skip", "last" (send, then the voice channel ends) or
     * "drop" (a voice channel over its two minutes, or of a key no longer live: it ends now).
     */
    gate(channel, record) {
      const peer = channel.peer_device_id, voice = isVoice(peer) || [...owned.values()].some((m) => m.peer === peer);
      if (!voice) return record && (owned.has(record.command_id) || record.type === "voice.answer") ? "skip" : "send";
      if (!isVoice(peer) || o.now() - (channel.established_at ?? 0) > VOICE_CHANNEL_MS) return "drop";
      if (record?.type === "voice.answer") { // the reply to its own prompt (ends the channel), or its read_last answer, sealed before that command's acceptance
        if (record.lane !== "transient") return "skip";
        if (record.body?.command_id === null) return expecting.has(peer) ? "send" : "skip";
        const mine = owned.get(record.body?.command_id);
        return mine?.peer === peer && mine.kind === "prompt" ? "last" : "skip";
      }
      const mine = record ? owned.get(record.command_id) : null;
      if (!record || !HEARS.has(record.type) || record.lane || mine?.peer !== peer) return "skip";
      if (record.type === "command.agent_accepted" && mine.kind === "prompt" && mayRead(peer)) return "send"; // it may read: the channel waits for the reply (two minutes at most)
      return LAST.has(record.type) ? "last" : "send";
    },
    /** A phone or a voice key gone (removed here, unpaired, revoked): its voice keys go. → the voice keys removed. */
    drop(deviceId) {
      const voice = loadVoice(), gone = voice.peers.filter((v) => v.device_id === deviceId || v.parent?.device_id === deviceId).map((v) => v.device_id);
      if (gone.length) { saveVoice({ peers: voice.peers.filter((v) => !gone.includes(v.device_id)), sends: Object.fromEntries(Object.entries(voice.sends).filter(([k]) => !gone.includes(k))), reads: Object.fromEntries(Object.entries(voice.reads).filter(([k]) => !gone.includes(k))) }); o.log("voice_removed", { count: gone.length }); } // audit P3-4: the other keys' reads stay
      return gone;
    },
  };
}

/** What `remote status` and `remote voice status` say. */
export function voiceLine(settings, voice = loadVoice()) {
  const n = voice.peers.length;
  return `  Voice prompts from a phone with Siri: ${voiceOff(settings) ? "off" : "on"}${n ? ` (${n} voice key${n === 1 ? "" : "s"})` : ""}, replies read aloud: ${!voiceOff(settings) && settings?.voice_read === true ? "on" : "off"} (npx worktrust remote voice on|off|read on|off|remove)`;
}

/**
 * `remote voice on|off|remove [<fingerprint>] | status` (CLI 0.11.21), at this keyboard only. On: desk steering must be on (else
 * nothing changes and the command to run is said). Off and remove take every voice key's waiting prompt with them (the steer
 * door's tick withdraws a prompt whose key is no longer live); remove forgets the voice keys (of one phone when named).
 */
export async function voiceCommand(io, rest, { apply, settings }) { // `read on|off` (owner, 2026-11-22): may a voice key that may read hear replies
  if (rest[0] === "on" && !(await keyboardYes(io, "Siri on a confirmed phone may then send a prompt into a session open at this desk, also while that phone is locked, and read its replies aloud. Turn voice on?"))) return;
  if (rest[0] === "on" || rest[0] === "off") {
    const done = apply({ what: "voice", on: rest[0] === "on" }, { kind: "keyboard" });
    if (!done.ok) return io.fail(`  ${done.reason}`);
    if (rest[0] === "on") { try { refreshSteerMod(); } catch { io.say("  ! The steer mod was not refreshed: npx worktrust remote desk-steer on writes it again."); } } // audit P1-1: a mod that checks a locked send's modes
    saveChosen("voice", rest[0] === "on"); // typed by the person: a link or an update never turns an off back on (CLI 0.11.26)
    return io.say(`  ✓ ${done.message}`);
  }
  if (rest[0] === "read" && (rest[1] === "on" || rest[1] === "off")) {
    if (rest[1] === "on" && !(await keyboardYes(io, "Siri may then read the reply to a voice prompt aloud on that phone. Turn reading aloud on?"))) return;
    const done = apply({ what: "voice_read", on: rest[1] === "on" }, { kind: "keyboard" });
    if (!done.ok) return io.fail(`  ${done.reason}`);
    saveChosen("voice_read", rest[1] === "on"); // typed by the person: voice on, a link or an update never turns this off back on (owner, 2026-11-25)
    return io.say(`  ✓ ${done.message}`);
  }
  if (rest[0] === "remove") {
    const voice = loadVoice(), named = rest[1] ? String(rest[1]).toUpperCase() : null;
    const gone = voice.peers.filter((v) => !named || v.fingerprint === named || v.parent?.fingerprint === named);
    saveVoice({ peers: voice.peers.filter((v) => !gone.includes(v)), sends: Object.fromEntries(Object.entries(voice.sends).filter(([k]) => !gone.some((v) => v.device_id === k))), reads: Object.fromEntries(Object.entries(voice.reads).filter(([k]) => !gone.some((v) => v.device_id === k))) }); // audit P3-4: the other keys' reads stay
    return io.say(gone.length ? `  ✓ Removed ${gone.length} voice key${gone.length === 1 ? "" : "s"}${named ? ` of phone ${named}` : ""}. The phone can enrol a new one while voice is on.` : "  No voice key to remove.");
  }
  if (rest[0] !== undefined && rest[0] !== "status") return io.fail("npx worktrust remote voice on|off | read on|off | remove [<fingerprint>] | status");
  io.say(voiceLine(settings()));
  for (const v of loadVoice().peers) io.say(`    voice key ${v.fingerprint} of phone ${v.parent?.fingerprint ?? "?"}, enrolled ${new Date(v.enrolled_at).toISOString().slice(0, 10)}`);
}
