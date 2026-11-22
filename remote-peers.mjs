/**
 * WHAT EACH PHONE ASKED TO READ, AND WHAT IS SEALED FOR IT (moved out of remote-daemon.mjs for CLI 0.11.19; nothing changed).
 *
 * An older phone or browser REFUSES a sealed body with a key it does not know, and its session stalls. So every field
 * that came after the first release is asked for (`inventory.get` with `extended` and the field's own name), remembered
 * here per phone for as long as the daemon lives (a phone asks again on every inventory.get), and `bodyFor` takes out of
 * every body what its phone did not ask for:
 *
 *   extended        the 0.11.7 inventory fields (EXTENDED_KEYS): all of them go for a phone that never asked `extended`
 *   model_switch    release 33: `agent_options[].model_switch`
 *   desk_sessions   release 36: `desk_sessions`, and the `in_use` refusal (others hear `busy`; remote-desk-sessions.mjs deskBodyFor)
 *   cli             CLI 0.11.16: `cli`, this daemon's own release and its restart (protocol cli.ts)
 *   desk_live       CLI 0.11.19: `desk_read` (what the keyboard lets a phone read of the desk: off, history, live), and the
 *                   right to follow a desk session at all (remote-history.mjs refuses a `follow` from any other phone, so a
 *                   page that carries `follow` is only ever made for a phone in this set). 0.11.19 kept browsers out; since
 *                   0.11.20 (owner, 2026-11-21: "een browser moet ook lukken als die de pincode doet") a browser joins too: the
 *                   issuer lets a browser's key onto the relay only with a live Remote PIN unlock of that browser
 *                   (WEB-CLIENT.md §PIN, issuer-link.ts controllerRefusal), and the keyboard's switch stays the gate
 *   desk_steer      CLI 0.11.20: a desk row's `steerable`, the `bypass_mode` refusal (others hear `not_allowed`), and the right
 *                   to send agent.prompt `desk_ref` at all (remote-desk-steer.mjs refuses a sender outside this set)
 *   voice           CLI 0.11.21: device.inventory `voice` `{ on, enrolled }` (this computer's keyboard switch, and whether THIS
 *                   phone's voice key is enrolled here; remote-voice.mjs), only for a phone that asked `voice`; `locked_mode`
 *                   is sealed only for a voice key (anyone else hears `not_allowed`)
 *   voice_read      CLI 0.11.21: `voice.read` (the keyboard's `remote voice read`), only for a phone that asked it
 *   steer_via       CLI 0.11.21: a desk session's user turn's `via` in a history page (where a steered prompt came from)
 *   default_root    CLI 0.11.21: device.inventory `default_root` (the root the keyboard made at ~/Desktop/WorkTrust, or null;
 *                   remote-default-root.mjs), so a phone starts a session without choosing a project (protocol phone-start.ts)
 *   agent_ref       CLI 0.11.21: a claude-code session row's `agent_ref` (Claude Code's own uuid, for `claude --resume`)
 *
 * The daemon seals NOTHING for a channel that did not pass through `bodyFor` (remote-daemon.mjs sealAll).
 */
import { deskBodyFor } from "./remote-desk-sessions.mjs";

/** CLI 0.11.21: `voiceOf(phone)` whether that phone's voice key is enrolled here; `voiceKey(peer)` whether the peer IS a voice key. */
export function createPeers({ voiceOf = () => false, voiceKey = () => false } = {}) {
  // THE 0.11.7 INVENTORY FIELDS REACH ONLY A PHONE THAT ASKED FOR THEM (inventory.get `extended`): an older phone refuses unknown
  // keys, so every other channel gets the inventory without them. Kept per phone for the daemon's life; a phone asks again on every inventory.get.
  const extendedPeers = new Set(), switchPeers = new Set(); // release 33: `model_switch` only for a phone that asked for it
  const deskPeers = new Set(); // release 36: `desk_sessions` (and the `in_use` refusal) only for a phone that asked for them
  const cliPeers = new Set(); // CLI 0.11.16: `cli` (this daemon's own release, its restart; protocol cli.ts): only for a phone that asked
  const livePeers = new Set(); // CLI 0.11.19: `desk_read`, and reading along (history.get `follow`): only for a phone that asked `desk_live`
  const steerPeers = new Set(); // CLI 0.11.20: `steerable`, `bypass_mode`, and agent.prompt `desk_ref`: only for a phone that asked `desk_steer`
  const rootPeers = new Set(), refPeers = new Set(), readyPeers = new Set(); // readyPeers (build 31): a phone that asked `voice_notice` hears "Answer ready" as a device notice // CLI 0.11.21: `default_root` (asked `default_root`) and a session row's `agent_ref` (asked `agent_ref`)
  const voicePeers = new Set(), readPeers = new Set(), viaPeers = new Set(); // CLI 0.11.21: `voice` { on, enrolled }, its `read` (asked `voice_read`), and a user turn's `via` (asked `steer_via`)
  // `via` on a desk session's user turn (CLI 0.11.21, remote-desk-steer.mjs withOrigins): only for a phone or browser that asked `steer_via`.
  const withoutVia = (body) => ({ ...body, items: body.items.map(({ via: _drop, ...item }) => item) });
  const viaBodyFor = (peer, type, body) => (type === "history.page" && !viaPeers.has(peer) && Array.isArray(body?.items) && body.items.some((i) => "via" in i) ? withoutVia(body) : body);
  const voiceBodyFor = (peer, type, body) => (type !== "device.inventory" || !("voice" in body) ? body : voicePeers.has(peer) ? { ...body, voice: { on: body.voice.on === true, enrolled: voiceOf(peer) === true, ...(readPeers.has(peer) ? { read: body.voice.read === true } : {}) } } : (({ voice: _drop, ...rest }) => rest)(body));
  const EXTENDED_KEYS = ["agent_options", "modes_allowed", "admin", "folders", "connections", "voice", "desk_sessions", "desk_read", "cli"];
  const withoutRoot = ({ default_root: _drop, ...body }) => body;
  const withoutRefs = (body) => ({ ...body, sessions: body.sessions.map(({ agent_ref: _drop, ...row }) => row) });
  const startBodyFor = (peer, type, body) => {
    if (type !== "device.inventory") return body;
    const rooted = "default_root" in body && !rootPeers.has(peer) ? withoutRoot(body) : body;
    return !refPeers.has(peer) && Array.isArray(rooted.sessions) && rooted.sessions.some((row) => "agent_ref" in row) ? withoutRefs(rooted) : rooted;
  };
  const withoutSwitch = (body) => (body.agent_options ? { ...body, agent_options: body.agent_options.map(({ model_switch: _drop, ...o }) => o) } : body);
  const withoutCli = ({ cli: _drop, ...body }) => body;
  const cliBodyFor = (peer, type, body) => (type === "device.inventory" && body.cli && !cliPeers.has(peer) ? withoutCli(body) : body);
  const withoutRead = ({ desk_read: _drop, ...body }) => body;
  const liveBodyFor = (peer, type, body) => (type === "device.inventory" && "desk_read" in body && !livePeers.has(peer) ? withoutRead(body) : body);
  const withoutSteer = (body) => ({ ...body, desk_sessions: body.desk_sessions.map(({ steerable: _drop, ...row }) => row) });
  const steerBodyFor = (peer, type, body) => (steerPeers.has(peer) ? body : type === "device.inventory" && Array.isArray(body.desk_sessions) ? withoutSteer(body) : type === "command.rejected" && (body?.reason === "bypass_mode" || body?.reason === "not_prompt") ? { ...body, reason: "not_allowed" } : body);
  // `locked_mode` (0.11.21) only ever reaches a voice key (remote-voice.mjs gate): any other peer, older or not, hears `not_allowed`.
  const lockedBodyFor = (type, body) => (type === "command.rejected" && body?.reason === "locked_mode" ? { ...body, reason: "not_allowed" } : body);
  // A voice key (0.11.21, never older) knows every reason; the daemon seals for it only the receipts of its own commands (remote-voice.mjs gate).
  const bodyFor = (channel, record) => (voiceKey(channel.peer_device_id) ? record.body : lockedBodyFor(record.type, viaBodyFor(channel.peer_device_id, record.type, voiceBodyFor(channel.peer_device_id, record.type, steerBodyFor(channel.peer_device_id, record.type, liveBodyFor(channel.peer_device_id, record.type, deskBodyFor(deskPeers.has(channel.peer_device_id), record.type, cliBodyFor(channel.peer_device_id, record.type, record.type !== "device.inventory" ? record.body
    : extendedPeers.has(channel.peer_device_id) ? (switchPeers.has(channel.peer_device_id) ? record.body : withoutSwitch(record.body))
    : Object.fromEntries(Object.entries(record.body).filter(([key]) => !EXTENDED_KEYS.includes(key)))))))))));
  /** An `inventory.get` a confirmed phone sent (`env`: its opened envelope): what it reads from now on. */
  function note(payload, env) {
    if (payload.extended === true && env.sender_device_id) extendedPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.model_switch === true && env.sender_device_id) switchPeers.add(env.sender_device_id); // kept, as extendedPeers
    if (payload.extended === true && payload.desk_sessions === true && env.sender_device_id) deskPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.cli === true && env.sender_device_id) cliPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.desk_live === true && env.sender_device_id) livePeers.add(env.sender_device_id); // a browser too since 0.11.20: its key reaches the relay only after its Remote PIN
    if (payload.extended === true && payload.desk_steer === true && env.sender_device_id) steerPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.voice === true && env.sender_device_id) voicePeers.add(env.sender_device_id);
    if (payload.extended === true && payload.voice_read === true && env.sender_device_id) readPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.steer_via === true && env.sender_device_id) viaPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.default_root === true && env.sender_device_id) rootPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.agent_ref === true && env.sender_device_id) refPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.voice_notice === true && env.sender_device_id) readyPeers.add(env.sender_device_id);
  }
  // CLI 0.11.21: `default_root` and a row's `agent_ref` leave every inventory last, for a phone that did not ask each (asking needs `extended`, so a phone that never asked that loses both too).
  return { bodyFor: (channel, record) => startBodyFor(channel.peer_device_id, record.type, bodyFor(channel, record)), note, readsDesk: () => deskPeers.size > 0, readsCli: () => cliPeers.size > 0, readsLive: (peer) => (peer === undefined ? livePeers.size > 0 : livePeers.has(peer)), readsSteer: (peer) => (peer === undefined ? steerPeers.size > 0 : steerPeers.has(peer)), readsVoice: () => voicePeers.size > 0, readsDefaultRoot: () => rootPeers.size > 0, readsVoiceNotice: (peer) => readyPeers.has(peer) };
}
