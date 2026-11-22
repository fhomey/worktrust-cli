/**
 * STEER A DESK SESSION FROM THE PHONE (CLI 0.11.20; owner, 2026-11-21; docs/remote-agents/DESK-STEERING.md). A prompt from a
 * paired phone (or a browser, whose key the issuer lets onto the relay only after its Remote PIN) goes INTO a Claude Code
 * session that stays open at the desk, through the `worktrust-steer` mod inside that session (remote-steer-mod.mjs).
 *
 *   the switch   `desk_steer`, at this keyboard only (`npx worktrust remote desk-steer on|off|status`), default off; on needs
 *                read along on (`desk_live`, which needs `desk_history`); read along off takes it with it (remote-settings.mjs);
 *                on installs the mod, off removes it. Never from the phone, the web, MCP, the app's proof or this daemon.
 *   a prompt     agent.prompt with `desk_ref` (protocol desk.ts): `prompt(env, payload)` checks, in this order, the switch and
 *                read along; the sender asked `desk_steer` (it knows the answers below); the session in this computer's own
 *                desk list under a granted folder or root; the mod's heartbeat for it fresh, its Claude Code new enough and its
 *                mode one that still asks (unknown counts as bypass); one prompt waiting per session; ten a minute per
 *                computer; words only (no leading `!` or `/`: `not_prompt`). The switch and the grant are read AGAIN just
 *                before the write. Then the inbox file (0600, an atomic rename). → null
 *                (waiting: the phone has `command.device_received`, "Sent to the computer") or a reject reason.
 *   receipts     `tick()` reads what the mod wrote: `submitted` → command.agent_accepted ("In the session"), `dropped` → a
 *                refusal; no receipt in 60 s → the inbox file is renamed away (the mod asks for it again before it submits,
 *                so the rename decides) and the phone hears `expired`; a pause, the switch off or its phone removed withdraw at
 *                once; a taken prompt never resolved is settled after 30 minutes. The steered ledger names the session only at
 *                `submitted` and widens that turn's window at `ended` (one window per turn, remote-steered.mjs): a refused or
 *                withdrawn prompt marks nothing. A new daemon withdraws every inbox file the last one left.
 *                Every receipt names the command, never the session: device receipts, so no session is made anywhere.
 */
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendSteered } from "./remote-steered.mjs";
import { ALIVE_FRESH_MS, MIN_CLAUDE_CODE_STEER, SAFE_MODES, installSteerMod, steerDir, steerModInstalled, uninstallSteerMod } from "./remote-steer-mod.mjs";

export const STEER_WAIT_MS = 60_000;
export const STEER_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CMD = /^cmd_[A-Za-z0-9_-]{22}$/;
const DROPS = { bypass: "bypass_mode", withdrawn: "expired", stale: "expired", not_prompt: "not_prompt" };
/** A taken prompt that never resolves (the session stuck, Claude Code closed mid-queue) is settled after this long (review P3-2). */
export const STEER_TAKEN_MAX_MS = 30 * 60_000;
/**
 * WORDS ONLY (reviewer, 2026-11-21, unverified on a device): whether `$.prompt.submit({ asUser: true })` runs a leading `!` as a
 * shell line or a leading `/` as a command is not known, so a desk prompt whose first non-space character is either is
 * refused here (`not_prompt`), by the mod again, and by the phone and the web before it is sent.
 */
export const deskPromptOk = (text) => !/^\s*[!/]/.test(String(text ?? ""));
/**
 * Every prompt left in an inbox, withdrawn (renamed away, then removed): a daemon that starts (the one before it may have
 * died with prompts waiting, review P2-1) and `remote pause` at the keyboard (P3-1). The mod asks for the file again before
 * it submits, so a renamed file is never sent. → how many.
 */
export function withdrawInboxes(home = homedir()) {
  let n = 0;
  let refs = [];
  try { refs = readdirSync(steerDir(home)); } catch { return 0; }
  for (const ref of refs) {
    let names = [];
    try { names = readdirSync(join(steerDir(home), ref, "inbox")).filter((f) => /^cmd_[A-Za-z0-9_-]{22}\.json$/.test(f)); } catch { continue; }
    for (const name of names) { const file = join(steerDir(home), ref, "inbox", name); try { renameSync(file, file.replace(/\.json$/, ".withdrawn")); rmSync(file.replace(/\.json$/, ".withdrawn"), { force: true }); n += 1; } catch { /* gone already */ } }
  }
  return n;
}
/** What a steering prompt meets when the keyboard says no: anything but every switch on. */
export const steerOff = (s) => (s?.desk_steer !== true || s.desk_live !== true || s.desk_history !== true);

const newer = (a, b) => { const x = String(a ?? "").split(/[.-]/).slice(0, 3).map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i += 1) { if ((x[i] || 0) !== y[i]) return (x[i] || 0) > y[i]; } return true; };
const readJsonFile = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/**
 * The mod's heartbeat for one session: "ok", or why it cannot take a prompt now: `unsupported` (no fresh heartbeat: the
 * mod is not loaded, the session closed, Claude Code too old) or `bypass_mode` (the mode skips the questions, or is unknown).
 */
export function aliveOf(dir, ref, now) {
  const a = readJsonFile(join(dir, ref, "alive.json"));
  if (!a || a.v !== 1 || a.ended === true || !Number.isSafeInteger(a.at) || now - a.at > ALIVE_FRESH_MS || a.at - now > ALIVE_FRESH_MS || !newer(a.version, MIN_CLAUDE_CODE_STEER)) return "unsupported";
  return SAFE_MODES.includes(a.mode) ? "ok" : "bypass_mode";
}

function writePrivate(file, text) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

export function createDeskSteer(o) {
  // o: { desk (remote-desk-sessions.mjs createDesk), settings(), readsSteer(phone), now(), every?(run, ms), log(kind, fields), settle(commandId, outcome) (outcome "taken" or a reject reason), home? }
  const dir = () => steerDir(o.home ?? homedir());
  withdrawInboxes(o.home ?? homedir()); // what a daemon before this one left waiting is never delivered later (review P2-1)
  const pending = new Map(); // command_id → { ref, project_id, session_id, phone, at, taken }
  const running = new Map(); // command_id → { ref, project_id, session_id, first }: submitted, waiting for its turn's end (the ledger)
  const sent = []; // when each prompt of the last minute was written
  let stop = null;
  const every = o.every ?? ((run, ms) => { const t = setInterval(run, ms); t.unref?.(); return () => clearInterval(t); });
  const mark = (p, first, last) => { try { appendSteered({ v: 1, steered: "remote", adapter: "claude-code", agent_session_ref: p.ref, remote_session_id: p.session_id, project_id: p.project_id, how: "attached", first_steered_at: first, last_steered_at: last }); return true; } catch { return false; } };
  const waiting = (ref) => [...pending.values()].some((p) => p.ref === ref) || (() => { try { return readdirSync(join(dir(), ref, "inbox")).some((n) => n.endsWith(".json")); } catch { return false; } })();
  const clean = (ref, id) => { for (const f of [join(dir(), ref, "inbox", `${id}.json`), join(dir(), ref, "inbox", `${id}.withdrawn`), join(dir(), ref, "receipts", `${id}.json`)]) rmSync(f, { force: true }); };

  /** Whether a row of the desk list may be offered for steering now (device.inventory `steerable`, for a phone that asked). */
  function steerable(row, settings = o.settings()) {
    return !steerOff(settings) && UUID.test(row.session_ref) && aliveOf(dir(), row.session_ref, o.now()) === "ok";
  }

  function prompt(env, payload) {
    const ref = payload.desk_ref?.session_ref, projectId = payload.desk_ref?.project_id;
    if (steerOff(o.settings())) return "not_allowed";
    if (o.readsSteer(env.sender_device_id) !== true) return "not_allowed"; // it never asked: it would not know the answers
    if (!UUID.test(ref ?? "") || !CMD.test(env.command_id) || payload.attachments !== undefined || payload.model !== undefined || payload.interrupt !== undefined) return "unsupported";
    if (!deskPromptOk(payload.text)) return "not_prompt"; // a shell line or a command, maybe run as such in the session: never sent
    if (!o.desk?.find(ref, projectId)) return "not_found"; // not in this computer's own list, or not under that granted project
    const alive = aliveOf(dir(), ref, o.now());
    if (alive !== "ok") return alive;
    if (waiting(ref)) return "busy";
    while (sent.length && o.now() - sent[0] >= RATE_WINDOW_MS) sent.shift();
    if (sent.length >= STEER_PER_MINUTE) return "busy";
    // Asked AGAIN just before the write: the keyboard may have said no, or the grant gone, while the checks above ran.
    if (steerOff(o.settings()) || !o.desk.find(ref, projectId)) return steerOff(o.settings()) ? "not_allowed" : "not_found";
    const p = { ref, project_id: projectId, session_id: env.session_id, phone: env.sender_device_id, at: o.now(), taken: false };
    // The ledger names the desk session only once the turn started (`submitted`, tick below; review P2-3): a refused or withdrawn prompt marks nothing.
    try {
      for (const sub of ["inbox", "receipts"]) mkdirSync(join(dir(), ref, sub), { recursive: true, mode: 0o700 });
      writePrivate(join(dir(), ref, "inbox", `${env.command_id}.json`), JSON.stringify({ v: 1, command_id: env.command_id, text: payload.text, at: p.at }));
    } catch { o.log("steer_unwritable", {}); return "unsupported"; }
    sent.push(p.at);
    pending.set(env.command_id, p);
    if (stop === null) stop = every(() => { try { tick(); } catch { o.log("steer_tick_failed", {}); } }, 1000);
    o.log("desk_steered", { phone: env.sender_device_id, project_id: projectId });
    return null;
  }

  function tick() {
    const now = o.now(), s = o.settings();
    const withdraw = (id, p, reason) => { const inbox = join(dir(), p.ref, "inbox", `${id}.json`); try { if (existsSync(inbox)) renameSync(inbox, join(dir(), p.ref, "inbox", `${id}.withdrawn`)); } catch { /* gone */ } if (readJsonFile(join(dir(), p.ref, "receipts", `${id}.json`))?.state) { p.taken = true; return false; } pending.delete(id); clean(p.ref, id); o.settle(id, reason); return true; };
    for (const [id, p] of [...pending]) {
      const r = readJsonFile(join(dir(), p.ref, "receipts", `${id}.json`));
      if (r?.command_id === id && r.state === "submitted") { pending.delete(id); const first = Number.isSafeInteger(r.at) && Math.abs(r.at - now) < 3_600_000 ? r.at : now; running.set(id, { ...p, first }); mark(p, first, first); rmSync(join(dir(), p.ref, "inbox", `${id}.json`), { force: true }); o.settle(id, "taken"); continue; }
      if (r?.command_id === id && r.state === "dropped") { pending.delete(id); clean(p.ref, id); o.settle(id, DROPS[r.reason] ?? "unsupported"); continue; }
      if (r?.command_id === id && r.state === "taken") p.taken = true;
      // Taken and never resolved (the session stuck): settled after 30 minutes and cleaned, so the session takes the next (review P3-2).
      if (p.taken) { if (now - p.at >= STEER_TAKEN_MAX_MS) { pending.delete(id); clean(p.ref, id); o.settle(id, "expired"); } continue; }
      // While it waits: a pause, the switch off, or its phone removed withdraws it at once (review P3-1); else after 60 s.
      // Withdrawn = renamed away, then the receipt asked again (the mod asks for the file again before it submits: the rename decides).
      if (s?.enabled === false || (s?.paused ?? null) !== null) { withdraw(id, p, "remote_paused"); continue; }
      if (steerOff(s) || o.readsSteer(p.phone) !== true) { withdraw(id, p, "not_allowed"); continue; }
      if (now - p.at >= STEER_WAIT_MS) withdraw(id, p, "expired");
    }
    for (const [id, p] of [...running]) {
      const r = readJsonFile(join(dir(), p.ref, "receipts", `${id}.json`));
      // The steered turn's window: from its start to its end (the mod's `ended`), clamped to now; a turn never seen to end keeps its start alone.
      if (r?.state === "ended" || now - p.first > 6 * 3_600_000) { running.delete(id); if (r?.state === "ended") mark(p, p.first, Math.max(p.first, Math.min(now, Number(r.at) || now))); clean(p.ref, id); }
    }
    if (pending.size === 0 && running.size === 0 && stop) { stop(); stop = null; }
  }

  return { prompt, steerable, tick, pending: () => pending.size, stop: () => { stop?.(); stop = null; } };
}

/** What `remote status` and `remote desk-steer status` say. */
export function deskSteerLine(settings, installed = steerModInstalled()) {
  const on = !steerOff(settings);
  return `  Sending a prompt from a phone into a session open here: ${on ? "on" : "off"}${on && !installed ? " (the mod is missing: run npx worktrust remote desk-steer on again)" : ""} (npx worktrust remote desk-steer on|off)`;
}

/**
 * `remote desk-steer on|off | status` (CLI 0.11.20), at this keyboard only (worktrust.mjs refuses every remote act in an agent's
 * shell). On: read along must be on (else nothing changes and the command to run is said), then the switch, then the mod.
 * Off: the switch, then the mod is removed. `apply`: remote-settings.mjs applySettingsChange, handed in (no import cycle).
 */
export function deskSteerCommand(io, rest, { apply, settings, home = homedir() }) {
  if (rest[0] === "on" || rest[0] === "off") {
    const done = apply({ what: "desk_steer", on: rest[0] === "on" }, { kind: "keyboard" });
    if (!done.ok) return io.fail(`  ${done.reason}`);
    if (rest[0] === "on") installSteerMod(home); else uninstallSteerMod(home);
    return io.say(`  ✓ ${done.message}`);
  }
  if (rest[0] !== undefined && rest[0] !== "status") return io.fail("npx worktrust remote desk-steer on|off | status");
  io.say(deskSteerLine(settings(), steerModInstalled(home)));
}
