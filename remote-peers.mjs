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
 *
 * The daemon seals NOTHING for a channel that did not pass through `bodyFor` (remote-daemon.mjs sealAll).
 */
import { deskBodyFor } from "./remote-desk-sessions.mjs";

export function createPeers() {
  // THE 0.11.7 INVENTORY FIELDS REACH ONLY A PHONE THAT ASKED FOR THEM (inventory.get `extended`): an older phone refuses unknown
  // keys, so every other channel gets the inventory without them. Kept per phone for the daemon's life; a phone asks again on every inventory.get.
  const extendedPeers = new Set(), switchPeers = new Set(); // release 33: `model_switch` only for a phone that asked for it
  const deskPeers = new Set(); // release 36: `desk_sessions` (and the `in_use` refusal) only for a phone that asked for them
  const cliPeers = new Set(); // CLI 0.11.16: `cli` (this daemon's own release, its restart; protocol cli.ts): only for a phone that asked
  const livePeers = new Set(); // CLI 0.11.19: `desk_read`, and reading along (history.get `follow`): only for a phone that asked `desk_live`
  const steerPeers = new Set(); // CLI 0.11.20: `steerable`, `bypass_mode`, and agent.prompt `desk_ref`: only for a phone that asked `desk_steer`
  const EXTENDED_KEYS = ["agent_options", "modes_allowed", "admin", "folders", "connections", "desk_sessions", "desk_read", "cli"];
  const withoutSwitch = (body) => (body.agent_options ? { ...body, agent_options: body.agent_options.map(({ model_switch: _drop, ...o }) => o) } : body);
  const withoutCli = ({ cli: _drop, ...body }) => body;
  const cliBodyFor = (peer, type, body) => (type === "device.inventory" && body.cli && !cliPeers.has(peer) ? withoutCli(body) : body);
  const withoutRead = ({ desk_read: _drop, ...body }) => body;
  const liveBodyFor = (peer, type, body) => (type === "device.inventory" && "desk_read" in body && !livePeers.has(peer) ? withoutRead(body) : body);
  const withoutSteer = (body) => ({ ...body, desk_sessions: body.desk_sessions.map(({ steerable: _drop, ...row }) => row) });
  const steerBodyFor = (peer, type, body) => (steerPeers.has(peer) ? body : type === "device.inventory" && Array.isArray(body.desk_sessions) ? withoutSteer(body) : type === "command.rejected" && (body?.reason === "bypass_mode" || body?.reason === "not_prompt") ? { ...body, reason: "not_allowed" } : body);
  const bodyFor = (channel, record) => steerBodyFor(channel.peer_device_id, record.type, liveBodyFor(channel.peer_device_id, record.type, deskBodyFor(deskPeers.has(channel.peer_device_id), record.type, cliBodyFor(channel.peer_device_id, record.type, record.type !== "device.inventory" ? record.body
    : extendedPeers.has(channel.peer_device_id) ? (switchPeers.has(channel.peer_device_id) ? record.body : withoutSwitch(record.body))
    : Object.fromEntries(Object.entries(record.body).filter(([key]) => !EXTENDED_KEYS.includes(key)))))));
  /** An `inventory.get` a confirmed phone sent (`env`: its opened envelope): what it reads from now on. */
  function note(payload, env) {
    if (payload.extended === true && env.sender_device_id) extendedPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.model_switch === true && env.sender_device_id) switchPeers.add(env.sender_device_id); // kept, as extendedPeers
    if (payload.extended === true && payload.desk_sessions === true && env.sender_device_id) deskPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.cli === true && env.sender_device_id) cliPeers.add(env.sender_device_id);
    if (payload.extended === true && payload.desk_live === true && env.sender_device_id) livePeers.add(env.sender_device_id); // a browser too since 0.11.20: its key reaches the relay only after its Remote PIN
    if (payload.extended === true && payload.desk_steer === true && env.sender_device_id) steerPeers.add(env.sender_device_id);
  }
  return { bodyFor, note, readsDesk: () => deskPeers.size > 0, readsCli: () => cliPeers.size > 0, readsLive: (peer) => (peer === undefined ? livePeers.size > 0 : livePeers.has(peer)), readsSteer: (peer) => (peer === undefined ? steerPeers.size > 0 : steerPeers.has(peer)) };
}
