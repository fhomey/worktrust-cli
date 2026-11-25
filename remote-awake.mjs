/**
 * STAY REACHABLE, AND WAKE-ON-LAN'S SWITCH (CLI 0.11.25; owner, 2026-11-24; docs/remote-agents/WAKE.md). Two keyboard
 * switches in ~/.worktrust/remote/awake.json (0600), both OFF until the person says y or yes at this keyboard
 * (remote-keyboard.mjs keyboardYes; check-remote-cli rule W lists both ON paths). OFF is scriptable. The phone only reads them.
 *
 *   awake   while the daemon runs ON AC POWER, one child holds system sleep off (remote-wake-doors.mjs systemInhibitor: macOS
 *           `caffeinate -s -w <pid>`, Linux `systemd-inhibit … tail --pid=<pid>`); the display may sleep. On battery nothing is
 *           held (owner, 2026-11-24): the read-only power probe (systemPower) says so and the hold ends. Windows has no
 *           hold (a PowerShell child is a shell, refused by check-remote-cli rule B): `unsupported`.
 *   lan     this computer shares its wake card with its phones and may wake its account's other computers on its own
 *           network when a phone asks (remote-wake.mjs).
 *
 * createAwake is the hold: `sync()` reads the switch (every 15 s from remote-run.mjs) and starts or ends the one child;
 * `state()` is what device.inventory `wake.awake` says. A child that ended by itself while wanted is `failed`, tried again
 * after RETRY_MS. The runner is the door's (systemInhibitor(home)); a test hands its own recorder.
 */
import { homedir } from "node:os";
import { readJson, removeFile, writeJson } from "./remote-store.mjs";
import { systemInhibitor, systemPower } from "./remote-wake-doors.mjs";
import { keyboardYes } from "./remote-keyboard.mjs";

export const AWAKE_FILE = "awake.json";
export const RETRY_MS = 60_000;
export function loadAwake() {
  let kept = null;
  try { kept = readJson(AWAKE_FILE); } catch { kept = null; } // unreadable or not private: both switches read OFF
  return { awake: kept?.awake === true, lan: kept?.lan === true, at: Number.isSafeInteger(kept?.at) ? kept.at : null };
}
export const saveAwake = ({ awake, lan }, now = Date.now()) => writeJson(AWAKE_FILE, { v: 1, awake: awake === true, lan: lan === true, at: now });
export const forgetAwake = () => removeFile(AWAKE_FILE);
/** Whether this OS has a hold at all (the door's list: darwin and linux). */
export const holdPossible = (platform = process.platform) => platform === "darwin" || platform === "linux";

export function createAwake({ platform = process.platform, pid = process.pid, home = homedir(), runner = systemInhibitor(home), power = systemPower(home), settings = loadAwake, now = Date.now, log = () => {} } = {}) {
  let child = null, state = "off", failedAt = null, unsupported = !holdPossible(platform);
  const end = () => { const c = child; child = null; if (c) { try { c.kill("SIGTERM"); } catch { /* gone */ } } };
  function begin() {
    let made = null;
    try { made = runner(platform, pid); } catch { made = null; }
    if (!made) { state = "unsupported"; unsupported = true; log("awake_unsupported", {}); return; }
    child = made; state = "holding"; failedAt = null;
    made.on?.("error", (error) => { if (child !== made) return; child = null; unsupported = error?.code === "ENOENT"; state = unsupported ? "unsupported" : "failed"; failedAt = now(); log(unsupported ? "awake_unsupported" : "awake_failed", {}); });
    made.on?.("exit", () => { if (child !== made) return; child = null; state = "failed"; failedAt = now(); log("awake_failed", {}); });
    log("awake_holding", {});
  }
  return {
    /** Read the switch and make the hold match it. → the state. */
    sync() {
      const wanted = settings().awake === true;
      if (!wanted) { if (child) { end(); log("awake_released", {}); } state = "off"; return state; }
      let source = "unknown";
      try { source = power(platform); } catch { source = "unknown"; }
      if (source === "battery") { if (child) { end(); log("awake_battery", {}); } state = "battery"; return state; } // AC power only
      if (child) return state;
      if (unsupported) { state = "unsupported"; return state; }
      if (state === "failed" && failedAt !== null && now() - failedAt < RETRY_MS) return state;
      begin();
      return state;
    },
    state: () => (settings().awake === true ? state : "off"),
    stop() { end(); state = "off"; },
  };
}

const STATE_WORDS = { off: "off", battery: "on battery: not held (this computer is kept awake on AC power only)", holding: "on: sleep is held on AC power while the Remote Agent runs (the display may sleep)", unsupported: "on, but this computer cannot hold sleep from here", failed: "on, but the hold ended by itself; it is tried again every minute" };
/** One line per switch for `remote status` and `remote awake status`. `held` is the daemon's word when known, else null. */
export function awakeLines(kept = loadAwake(), { platform = process.platform, held = null, power = null } = {}) {
  const awake = !kept.awake ? "off" : !holdPossible(platform) ? STATE_WORDS.unsupported : power === "battery" ? STATE_WORDS.battery : held ? STATE_WORDS[held] ?? STATE_WORDS.holding : "on (held on AC power while the Remote Agent service runs)";
  return [`  Stay reachable: ${awake}`, `  Wake-on-LAN: ${kept.lan ? "on: your phones get this computer's wake address, sealed, and it may wake your other computers on its network" : "off"}`];
}

/** `npx worktrust remote awake on|off|status`, `remote awake lan on|off`. `card` (remote-wake.mjs ownCard) names this computer's address in status. */
export async function awakeCommand(io, rest, { card = () => null, platform = process.platform, power = systemPower(homedir()) } = {}) {
  const kept = loadAwake();
  if (rest[0] === "on" || rest[0] === "off") {
    if (rest[0] === "on" && !(await keyboardYes(io, "This computer then stays awake on AC power while the Remote Agent runs (the display may still sleep; on battery it sleeps as usual). Keep it awake?"))) return;
    saveAwake({ ...kept, awake: rest[0] === "on" });
    if (rest[0] === "on" && !holdPossible(platform)) return io.say("  ✓ Saved, but this computer cannot hold sleep from here (Windows): set its power plan to never sleep instead.");
    return io.say(rest[0] === "on" ? "  ✓ Stay reachable is on: the Remote Agent service keeps idle sleep off while it runs (within 15 seconds)." : "  ✓ Stay reachable is off: this computer sleeps as its own settings say.");
  }
  if (rest[0] === "lan" && (rest[1] === "on" || rest[1] === "off")) {
    if (rest[1] === "on" && !(await keyboardYes(io, "Your phones then receive this computer's wake address (sealed), and this computer may wake your other computers on its network when your phone asks. Turn Wake-on-LAN on?"))) return;
    saveAwake({ ...kept, lan: rest[1] === "on" });
    if (rest[1] === "off") return io.say("  ✓ Wake-on-LAN is off: no wake address is shared, and no wake is sent from here.");
    io.say("  ✓ Wake-on-LAN is on.");
    return io.say(platform === "darwin" ? "  For this Mac to wake, turn on System Settings › Energy › Wake for network access (on a laptop: Battery › Options). Ethernet works; most Macs do not wake over Wi-Fi." : "  For this computer to wake, its network card must allow Wake-on-LAN (firmware or driver setting). Ethernet works; most do not wake over Wi-Fi.");
  }
  if (rest[0] !== undefined && rest[0] !== "status") return io.fail("npx worktrust remote awake on|off | lan on|off | status");
  let source = null;
  try { source = kept.awake ? power(platform) : null; } catch { source = null; }
  for (const line of awakeLines(kept, { platform, power: source })) io.say(line);
  let own = null;
  try { own = card(); } catch { own = null; }
  io.say(own ? `  This computer's wake address: ${own.mac}, broadcast ${own.broadcast} (/${own.prefix}), shared only while Wake-on-LAN is on` :"  This computer's wake address: none found (no wired or wireless IPv4 network with a hardware address)");
}
