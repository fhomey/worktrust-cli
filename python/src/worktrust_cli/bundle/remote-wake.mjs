/**
 * WAKE-ON-LAN THROUGH ANOTHER OF THE PERSON'S COMPUTERS (CLI 0.11.25; owner, 2026-11-24; docs/remote-agents/WAKE.md).
 *
 *   ownCard      this computer's wake address from os.networkInterfaces() (no process, no ifconfig): the interface its
 *                own gateway connection uses when known, else the first physical-looking IPv4 one with a real MAC. Made
 *                fresh at every inventory, signed with this computer's remote key, never written, never logged.
 *   inventory    device.inventory `wake` { awake, lan, card }: `card` only while `remote awake lan on`, and never for a
 *                browser (remote-peers.mjs strips it there; this module seals nothing itself).
 *   the helper   device.wake { target }: only while `lan` is on here, never from a browser, only for a card signed by a
 *                computer of THIS account (the issuer keys pinned in this build, P.verifyWakeCard), never this computer,
 *                and only to the directed broadcast of one of THIS computer's own IPv4 networks, computed here (the card
 *                only selects it). One per target per WAKE_TARGET_GAP_MS, WAKE_PER_HOUR in all. The packet goes out
 *                through remote-wake-doors.mjs systemWaker, the one socket, guarded by ownHome.
 * Refusals are the reasons every phone knows: not_allowed, not_found, busy, unsupported (WAKE.md §Messages).
 */
import { homedir, networkInterfaces } from "node:os";
import * as P from "./remote-protocol.mjs";
import { loadAwake } from "./remote-awake.mjs";
import { systemWaker } from "./remote-wake-doors.mjs";

const VIRTUAL = /^(lo|utun|bridge|docker|veth|vmnet|vboxnet|awdl|llw|tailscale|zt|wg|tun|tap|gif|stf|anpi|ap\d|virbr|br-)/i;
const PHYSICAL = /^(en|eth|enp|eno|ens|enx|wl|wlan|wlp)/i;
const NO_MAC = new Set(["00:00:00:00:00:00", ""]);

/** Every IPv4 network of this computer that could send or receive a wake: { name, address, mac, prefix, broadcast }. */
export function ownNetworks(interfaces = networkInterfaces()) {
  const out = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    if (VIRTUAL.test(name)) continue;
    for (const e of entries ?? []) {
      if (!e || e.internal || (e.family !== "IPv4" && e.family !== 4)) continue;
      const prefix = P.prefixOfNetmask(e.netmask ?? ""), mac = String(e.mac ?? "").toLowerCase();
      const broadcast = prefix === null ? null : P.broadcastOf(e.address, prefix);
      if (!broadcast) continue;
      out.push({ name, address: e.address, mac, prefix, broadcast });
    }
  }
  return out;
}

/** This computer's own card fields, or null: the network `preferred` (the gateway connection's local address) is on, else the first physical one. */
export function ownCard({ interfaces = networkInterfaces(), preferred = null } = {}) {
  const usable = ownNetworks(interfaces).filter((n) => !NO_MAC.has(n.mac) && P.wakeCardRule({ v: 1, device_id: "dev_AAAAAAAAAAAAAAAAAAAAAA", mac: n.mac, broadcast: n.broadcast, prefix: n.prefix, at: 0 }) === null);
  const pick = usable.find((n) => preferred && n.address === preferred) ?? usable.find((n) => PHYSICAL.test(n.name)) ?? null;
  return pick ? { mac: pick.mac, broadcast: pick.broadcast, prefix: pick.prefix } : null;
}

/** device.inventory's `wake` body: the switch states and, while `lan` is on, the signed card. */
export function wakeInventory({ local, awakeState, settings = loadAwake, interfaces = networkInterfaces, preferred = () => null, now = Date.now }) {
  const kept = settings();
  let card = null;
  if (kept.lan) {
    try {
      const own = ownCard({ interfaces: interfaces(), preferred: preferred() });
      if (own) card = P.signWakeCard({ v: 1, device_id: local.claims.device_id, ...own, at: now() }, local.secret.ed25519, local.binding);
    } catch { card = null; } // an unreadable interface list: no card, never a guess
  }
  return { awake: P.AWAKE_STATES.includes(awakeState) ? awakeState : "off", lan: kept.lan, card };
}

/**
 * THE HELPER. o: { local, issuerKeys, isBrowser(senderId), settings?, interfaces?, send? (the door; a test's recorder),
 * now?, log? }. `handle(env, payload)` → "taken" (the packets left) or a reject reason.
 */
export function createWakeHelper({ local, issuerKeys, isBrowser, settings = loadAwake, interfaces = networkInterfaces, home = homedir(), send = systemWaker(home), now = Date.now, log = () => {} }) {
  const sent = []; // { target, at } of the last hour, in memory only
  function limited(target, at) {
    while (sent.length && at - sent[0].at >= 3_600_000) sent.shift();
    return sent.length >= P.WAKE_PER_HOUR || sent.some((s) => s.target === target && at - s.at < P.WAKE_TARGET_GAP_MS);
  }
  return {
    async handle(env, payload) {
      if (settings().lan !== true) { log("wake_refused", { why: "lan_off" }); return "not_allowed"; }
      if (isBrowser(env.sender_device_id) !== false) { log("wake_refused", { why: "browser" }); return "not_allowed"; }
      const at = now();
      const checked = P.verifyWakeCard(payload.target, { issuerKeys, now: at, account: local.claims.sub, self: local.claims.device_id });
      if (!checked.ok) { log("wake_refused", { why: checked.code }); return "not_allowed"; }
      const card = checked.value;
      let mine = [];
      try { mine = ownNetworks(interfaces()); } catch { mine = []; }
      const net = mine.find((n) => n.broadcast === card.broadcast && n.prefix === card.prefix);
      if (!net) { log("wake_refused", { why: "other_network", target: card.device_id }); return "not_found"; }
      if (limited(card.device_id, at)) { log("wake_refused", { why: "rate", target: card.device_id }); return "busy"; }
      sent.push({ target: card.device_id, at });
      let ok = false;
      try { ok = await send({ bind: net.address, broadcast: P.broadcastOf(net.address, net.prefix), packet: P.magicPacket(card.mac) }); } catch { ok = false; }
      log(ok ? "wake_sent" : "wake_failed", { target: card.device_id });
      return ok ? "taken" : "unsupported";
    },
  };
}
