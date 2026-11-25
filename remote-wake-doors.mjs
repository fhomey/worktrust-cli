/**
 * THE TWO DOORS OF REMOTE WAKE TO THE OPERATING SYSTEM (CLI 0.11.25; docs/remote-agents/WAKE.md). remote-awake.mjs and
 * remote-wake.mjs never run a process or open a socket themselves: the sleep hold's one child and the magic packet's one
 * socket are made here, and only for THIS USER'S OWN HOME (remote-service-home.mjs ownHome, the rule of 2026-11-24: a test
 * or an agent with a synthetic HOME must never hold the person's Mac awake or send a packet on their network).
 *
 *   systemInhibitor(home)   (platform, pid) → the child holding idle sleep until `pid` exits, or null (refused, or no hold on
 *                           this OS). Fixed argv; only the daemon's own pid, an integer, reaches it. A test's stand-in folder
 *                           (WORKTRUST_SERVICE_STUBS, absolute) is run by full path, never found on PATH.
 *   systemPower(home)       () → "ac", "battery" or "unknown": READ ONLY (macOS `pmset -g ps`, fixed argv, its output read and
 *                           nothing written; Linux /sys/class/power_supply, files read). The hold applies on AC power only
 *                           (owner, 2026-11-24): on battery the daemon ends it and `remote awake status` says "on battery: not held".
 *   systemWaker(home)       ({ bind, broadcast, packet }) → whether the packets left: a udp4 socket bound to this computer's own
 *                           address, broadcast on, WAKE_COPIES sends to WAKE_PORT. Never under a stand-in folder (there is no
 *                           program to stand in for: a test hands its own sender), never for another home.
 * Held by scripts/check-cli-service-home.mjs rule F, which proves an unguarded door is seen.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { isAbsolute, join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { ownHome } from "./remote-service-home.mjs";

/** The one program per OS and its fixed arguments; `pid` is the daemon's own (an integer, checked). Windows: none (WAKE.md). */
export const INHIBITORS = Object.freeze({
  darwin: Object.freeze({ file: "caffeinate", args: (pid) => ["-s", "-w", String(pid)] }), // -s: system sleep, held on AC power only (owner, 2026-11-24)
  linux: Object.freeze({ file: "systemd-inhibit", args: (pid) => ["--what=idle:sleep", "--who=WorkTrust", "--why=Remote Agent: stay reachable", "--mode=block", "tail", `--pid=${pid}`, "-f", "/dev/null"] }),
});
const stubsDir = (env = process.env) => (env.WORKTRUST_SERVICE_STUBS && isAbsolute(env.WORKTRUST_SERVICE_STUBS) ? env.WORKTRUST_SERVICE_STUBS : null);

export const systemInhibitor = (home) => Object.assign((platform, pid) => {
  const how = Object.hasOwn(INHIBITORS, platform) ? INHIBITORS[platform] : null;
  if (!how || !Number.isSafeInteger(pid) || pid <= 1) return null;
  const stand = stubsDir();
  if (!stand && !ownHome(home)) return null;
  return spawn(stand ? join(stand, how.file) : how.file, how.args(pid), { stdio: "ignore", windowsHide: true });
}, { gated: true });

/** `pmset -g ps` says "Now drawing from 'AC Power'" or "'Battery Power'"; Linux: a Mains supply online, or a battery discharging. */
export function powerOf(platform, read) {
  if (platform === "darwin") { const t = read.pmset(); return /'AC Power'/.test(t) ? "ac" : /'Battery Power'/.test(t) ? "battery" : "unknown"; }
  if (platform === "linux") {
    const supplies = read.supplies();
    if (supplies.some((s) => s.type === "Mains" && s.online === "1")) return "ac";
    if (supplies.some((s) => s.type === "Battery" && s.status === "Discharging")) return "battery";
    return supplies.length ? "ac" : "unknown"; // a desktop without a battery is on mains
  }
  return "unknown";
}
const SUPPLY = "/sys/class/power_supply";
const readSupplies = () => readdirSync(SUPPLY).map((n) => { const f = (k) => { try { return readFileSync(`${SUPPLY}/${n}/${k}`, "utf8").trim(); } catch { return ""; } }; return { type: f("type"), online: f("online"), status: f("status") }; });
export const systemPower = (home) => Object.assign((platform = process.platform) => {
  if (stubsDir() || !ownHome(home)) return "unknown";
  try { return powerOf(platform, { pmset: () => execFileSync("pmset", ["-g", "ps"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }), supplies: readSupplies }); } catch { return "unknown"; }
}, { gated: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const systemWaker = (home, { dgram = { createSocket }, gapMs = 100 } = {}) => Object.assign(async ({ bind, broadcast, packet }) => {
  if (stubsDir() || !ownHome(home)) return false;
  if (P.ipv4ToInt(bind) === null || P.ipv4ToInt(broadcast) === null || !(packet instanceof Uint8Array) || packet.length !== P.MAGIC_PACKET_BYTES) return false;
  let socket;
  try {
    socket = dgram.createSocket({ type: "udp4" });
    await new Promise((resolve, reject) => { socket.once("error", reject); socket.bind({ address: bind, port: 0 }, () => { socket.off("error", reject); resolve(); }); });
    socket.setBroadcast(true);
    for (let n = 0; n < P.WAKE_COPIES; n += 1) {
      await new Promise((resolve, reject) => socket.send(packet, 0, packet.length, P.WAKE_PORT, broadcast, (error) => (error ? reject(error) : resolve())));
      if (n + 1 < P.WAKE_COPIES) await pause(gapMs);
    }
    return true;
  } catch { return false; } finally { try { socket?.close(); } catch { /* closed */ } }
}, { gated: true });
