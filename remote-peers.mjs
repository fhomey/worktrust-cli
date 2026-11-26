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
 *   probe_failed    CLI 0.11.22: the reject reason `probe_failed` (remote-inventory.mjs checkStartProbed: Claude Code's version and
 *                   help could not be read, asked again once); every other phone hears `busy` ("try again"), never `unsupported`
 *
 * The daemon seals NOTHING for a channel that did not pass through `bodyFor` (remote-daemon.mjs sealAll).
 */
import { deskBodyFor } from "./remote-desk-sessions.mjs";
import { knownBrowser } from "./remote-store.mjs";

/** CLI 0.11.21: `voiceOf(phone)` whether that phone's voice key is enrolled here; `voiceKey(peer)` whether the peer IS a voice key. */
export function createPeers({ voiceOf = () => false, voiceKey = () => false, isBrowser = (peer) => knownBrowser(peer) } = {}) { // isBrowser (CLI 0.11.25): whether a peer is known as a browser (remote-store.mjs, fails closed: a peer not listed counts as one), so it never gets a wake card
  // THE 0.11.7 INVENTORY FIELDS REACH ONLY A PHONE THAT ASKED FOR THEM (inventory.get `extended`): an older phone refuses unknown
  // keys, so every other channel gets the inventory without them. Kept per phone for the daemon's life; a phone asks again on every inventory.get.
  const extendedPeers = new Set(), switchPeers = new Set(); // release 33: `model_switch` only for a phone that asked for it
  const deskPeers = new Set(); // release 36: `desk_sessions` (and the `in_use` refusal) only for a phone that asked for them
  const cliPeers = new Set(); // CLI 0.11.16: `cli` (this daemon's own release, its restart; protocol cli.ts): only for a phone that asked
  const livePeers = new Set(); // CLI 0.11.19: `desk_read`, and reading along (history.get `follow`): only for a phone that asked `desk_live`
  const steerPeers = new Set(); // CLI 0.11.20: `steerable`, `bypass_mode`, and agent.prompt `desk_ref`: only for a phone that asked `desk_steer`
  const rootPeers = new Set(), refPeers = new Set(), readyPeers = new Set(); // readyPeers (build 31): a phone that asked `voice_notice` hears "Answer ready" as a device notice // CLI 0.11.21: `default_root` (asked `default_root`) and a session row's `agent_ref` (asked `agent_ref`)
  // CLI 0.11.25 (protocol wake.ts, docs/remote-agents/WAKE.md): `wake` only for a phone that asked it, and its `card` (this computer's MAC and network) never for a browser.
  const wakePeers = new Set();
  // CLI 0.11.26 (protocol setup-steps.ts, rule S): `setup`, the linking flow's keyboard steps, only for the phone it names and only after that phone asked.
  const setupPeers = new Set();
  const setupBodyFor = (peer, type, body) => (type !== "device.inventory" || !("setup" in body) || (setupPeers.has(peer) && body.setup?.phone === peer) ? body : (({ setup: _drop, ...rest }) => rest)(body));
  const wakeBodyFor = (peer, type, body) => (type !== "device.inventory" || !("wake" in body) ? body : !wakePeers.has(peer) ? (({ wake: _drop, ...rest }) => rest)(body) : isBrowser(peer) === false ? body : { ...body, wake: { ...body.wake, card: null } });
  const probePeers = new Set(); // CLI 0.11.22: the reject reason `probe_failed`, only for a phone that asked it (others hear `busy`)
  const probeBodyFor = (peer, type, body) => (type === "command.rejected" && body?.reason === "probe_failed" && !probePeers.has(peer) ? { ...body, reason: "busy" } : body);
  const voicePeers = new Set(), readPeers = new Set(), viaPeers = new Set(); // CLI 0.11.21: `voice` { on, enrolled }, its `read` (asked `voice_read`), and a user turn's `via` (asked `steer_via`)
  // `via` on a desk session's user turn (CLI 0.11.21, remote-desk-steer.mjs withOrigins): only for a phone or browser that asked `steer_via`.
  const withoutVia = (body) => ({ ...body, items: body.items.map(({ via: _drop, ...item }) => item) });
  const viaBodyFor = (peer, type, body) => (type === "history.page" && !viaPeers.has(peer) && Array.isArray(body?.items) && body.items.some((i) => "via" in i) ? withoutVia(body) : body);
  const voiceBodyFor = (peer, type, body) => (type !== "device.inventory" || !("voice" in body) ? body : voicePeers.has(peer) ? { ...body, voice: { on: body.voice.on === true, enrolled: voiceOf(peer) === true, ...(readPeers.has(peer) ? { read: body.voice.read === true } : {}) } } : (({ voice: _drop, ...rest }) => rest)(body));
  const EXTENDED_KEYS = ["agent_options", "modes_allowed", "admin", "folders", "connections", "voice", "desk_sessions", "desk_read", "cli"];
  const withoutRoot = ({ default_root: _drop, ...body }) => body;
  const withoutRefs = (body) => ({ ...body, sessions: body.sessions.map(({ agent_ref: _drop, ...row }) => row) });
  const startBodyFor = (peer, type, body) => {
    if (type !== "device.inventory") return probeBodyFor(peer, type, body); // CLI 0.11.22: `probe_failed` becomes `busy` last, for every peer that did not ask it
    body = setupBodyFor(peer, type, wakeBodyFor(peer, type, body)); // CLI 0.11.25: `wake` only for a phone that asked, its card never for a browser; 0.11.26: `setup` only for its own phone, asked
    const rooted = "default_root" in body && !rootPeers.has(peer) ? withoutRoot(body) : body;
    return !refPeers.has(peer) && Array.isArray(rooted.sessions) && rooted.sessions.some((row) => "agent_ref" in row) ? withoutRefs(rooted) : rooted;
  };
  const withoutSwitch = (body) => (body.agent_options ? { ...body, agent_options: body.agent_options.map(({ model_switch: _drop, ...o }) => o) } : body);
  const withoutCli = ({ cli: _drop, ...body }) => body;
  const cliBodyFor = (peer, type, body) => (type === "device.inventory" && body.cli && !cliPeers.has(peer) ? withoutCli(body) : body);
  const withoutRead = ({ desk_read: _drop, ...body }) => body;
  const liveBodyFor = (peer, type, body) => (type === "device.inventory" && "desk_read" in body && !livePeers.has(peer) ? withoutRead(body) : body);
  // CLI 0.11.27: a desk row's `activity` only for a phone that asked `desk_activity`, a desk page's `tasks` only for one that asked `desk_tasks`.
  const activityPeers = new Set(), tasksPeers = new Set();
  const deskWorkBodyFor = (peer, type, body) => (type === "device.inventory" && Array.isArray(body.desk_sessions) && !activityPeers.has(peer) && body.desk_sessions.some((d) => "activity" in d) ? { ...body, desk_sessions: body.desk_sessions.map(({ activity: _drop, ...row }) => row) } : type === "history.page" && body && "tasks" in body && !tasksPeers.has(peer) ? (({ tasks: _drop, ...rest }) => rest)(body) : body);
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
    if (payload.extended === true && payload.probe_failed === true && env.sender_device_id) probePeers.add(env.sender_device_id);
    if (payload.extended === true && payload.wake === true && env.sender_device_id) wakePeers.add(env.sender_device_id);
    if (payload.extended === true && payload.setup === true && env.sender_device_id) setupPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.desk_activity === true && env.sender_device_id) activityPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.desk_tasks === true && env.sender_device_id) tasksPeers.add(env.sender_device_id);
  }
  // CLI 0.11.21: `default_root` and a row's `agent_ref` leave every inventory last, for a phone that did not ask each (asking needs `extended`, so a phone that never asked that loses both too).
  return { bodyFor: (channel, record) => deskWorkBodyFor(channel.peer_device_id, record.type, startBodyFor(channel.peer_device_id, record.type, bodyFor(channel, record))), note, readsActivity: () => activityPeers.size > 0, readsTasks: (peer) => tasksPeers.has(peer), readsWake: () => wakePeers.size > 0, readsSetup: () => setupPeers.size > 0, readsDesk: () => deskPeers.size > 0, readsCli: () => cliPeers.size > 0, readsLive: (peer) => (peer === undefined ? livePeers.size > 0 : livePeers.has(peer)), readsSteer: (peer) => (peer === undefined ? steerPeers.size > 0 : steerPeers.has(peer)), readsVoice: () => voicePeers.size > 0, readsDefaultRoot: () => rootPeers.size > 0, readsVoiceNotice: (peer) => readyPeers.has(peer) };
}

/**
 * CHANNELS NOTHING SHOULD BE SEALED FOR (CLI 0.11.22; the owner's log: 15,509 lines of `not_paired`). The gateway keeps its
 * channels in memory: after it restarts, a channel whose phone or browser has not said hello since is unknown to it, and every
 * event sealed for that channel (the health sample every 15 seconds, each receipt and inventory) is refused `not_paired`.
 *
 *   forgotten   a newer gateway (with CLI 0.11.22) names the channel it refused (`channel_id`): nothing more is sealed for it. It is never
 *               learnt again (a hello opens a NEW channel, and the daemon drops the old one); `drop` forgets it with its channel.
 *   quiet       an older gateway names none, so the transient lane (the health sample, a pushed screen, a history page) is not
 *               sealed for a channel whose peer was not heard (a hello, or a command on that channel) for QUIET_AFTER_MS. A phone
 *               or browser that watches says something at every connect and whenever the computer returns (an inventory ask),
 *               so three days covers a weekend of a tab left open; a peer silent longer is gone or will speak at its next connect,
 *               and then hears the next sample. Receipts and inventories still go: a peer that just sent a command was heard.
 * Kept in memory: after a daemon restart a forgotten channel costs one refusal again; the quiet clock starts at the peer's last
 * hello (phones.json `seen_at`), or, for a peer with none recorded (paired before 0.11.7), when this daemon first seals for it.
 */
export const QUIET_AFTER_MS = 3 * 86_400_000;
export function createQuietChannels({ now, seenAt = () => null }) {
  const forgotten = new Set(), heard = new Map();
  const heardAt = (c) => { if (!heard.has(c.channel_id)) heard.set(c.channel_id, seenAt(c.peer_device_id) ?? now()); return heard.get(c.channel_id); };
  return {
    /** The gateway refused this channel by name. → whether it is news. */
    forgot: (id) => !forgotten.has(id) && Boolean(forgotten.add(id)),
    heard: (id) => { heard.set(id, now()); },
    drop: (id) => { forgotten.delete(id); heard.delete(id); },
    skip: (channel, record) => forgotten.has(channel.channel_id) || (record.lane === "transient" && now() - heardAt(channel) > QUIET_AFTER_MS),
  };
}

/**
 * A BURST OF PROBES, ONE BODY (CLI 0.11.27; owner, 2026-11-26: build 38 told him to update a computer on 0.11.26). A phone asks
 * each optional field by a probe of its own, about twenty `inventory.get` at a link; the daemon answered each with a whole
 * inventory built synchronously (the desk scan, the process list, the projects), one after another through the pacer, so on a
 * loaded or just-restarted computer the last receipts came after the phone's ten-second wait and read as an older CLI.
 *
 *   probe(refresh)   the body built once, FULL (every optional part: remote-daemon.mjs inventoryBody(refresh, true)), kept
 *                    PROBE_BODY_MS and only while `key` (the settings and the granted projects and roots) is the same; each
 *                    phone's own `bodyFor` still strips what it did not ask, so the full body is never sealed whole for anyone
 *   clear()          any other inventory the daemon builds (a session started, a grant changed, a setting, the 15-second desk
 *                    push) clears it: a probe never answers older than the last inventory sent
 * Probes keep their arrival order: the daemon dispatches one command at a time, and a probe now costs a lookup.
 */
export const PROBE_BODY_MS = 2_000;
/**
 * WHAT A HELD PROBE BODY DEPENDS ON beyond the inventories that clear it (release 62): the settings, the granted projects and roots,
 * and the phones and browsers linked here by id and name (the body's `connections`): a phone linked, renamed (inventory.get
 * `device_name`, kept just before the probe is answered) or removed, by this daemon or by `remote pair` / `disconnect` at the
 * keyboard, changes the answer, so the held body is built again.
 */
/**
 * THE EVENTS AFTER WHICH A HELD PROBE BODY IS STALE (release 62 integration; test-remote-cli-daemon's desk case found it: a session
 * started from the phone (agent.start, voice included) is journaled as session.created and pushes no inventory, so a probe within
 * PROBE_BODY_MS answered the list from before it). Each changes a row of the body's `sessions` (one added, its state or attention,
 * its release task) or its projects; anything else (an output delta, a step) moves only a row's time, which the window may hold.
 */
export const PROBE_STALE_ON = new Set(["session.created", "agent.attention", "agent.completed", "agent.failed", "agent.stopped", "agent.paused", "project.created", "release.updated"]);
export const probeKey = ({ settings, projects, roots, phones }) => JSON.stringify([settings, projects.map((p) => p.project_id), roots.map((r) => r.root_id), [...(phones?.confirmed ?? []), ...(phones?.pending ?? [])].map((p) => [p.device_id, p.name ?? null])]);
export function createInventoryCache({ build, key, now, ttl = PROBE_BODY_MS }) {
  let held = null, builds = 0;
  return {
    probe(refresh) {
      const k = `${refresh === true}|${key()}`;
      if (held && held.key === k && now() - held.at < ttl) return held.body;
      builds += 1;
      const body = build(refresh === true);
      held = { key: k, at: now(), body };
      return body;
    },
    clear() { held = null; },
    get builds() { return builds; },
  };
}
