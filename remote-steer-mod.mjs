/**
 * THE SECOND MOD: `worktrust-steer`, A PROMPT FROM THE PHONE INTO A SESSION OPEN AT THE DESK (CLI 0.11.20; owner, 2026-11-21:
 * "Je moet onderweg ook kunnen aansturen"; docs/remote-agents/DESK-STEERING.md, docs/CLAUDE-CODE-MOD.md §The second mod).
 *
 * WHY A SECOND MOD: the measuring mod (claude-mod.mjs, `worktrust-measure`) promises it reads no text and changes nothing.
 * This one hands words to the session, so it is its own plugin, written only when the person turns steering on at the
 * keyboard (`npx worktrust remote desk-steer on`) and deleted when they turn it off (or read along off, or remote disable).
 *
 * WHAT IT DOES, inside each Claude Code session (the terminal, the Desktop app, the VS Code extension), every 1.5 seconds on
 * `$.clock.every`, under ~/.worktrust/remote/desk-steer/<its own session id>/:
 *   alive.json      written every tick: the time, Claude Code's version and the session's permission mode as the last
 *                   classic hook told it (null while none did). The daemon offers steering only for a fresh one.
 *   inbox/<cmd>.json  the oldest one the daemon wrote (0600, an atomic rename) is read; one older than 60 s is dropped
 *                   `stale` and a leading `!` or `/` `not_prompt`; else a receipt `taken` is written FIRST, the inbox file is asked for again (the daemon withdraws it by renaming it away after 60 s: gone means
 *                   withdrawn), then `$.prompt.submit({ text, asUser: true })`: the words start a turn as the person's own,
 *                   once the session is idle. Never while the mode is bypassPermissions or unknown.
 *   receipts/<cmd>.json  `taken`, then `submitted` (the turn started) or `dropped` with a reason, then `ended` at the turn's end.
 * The mod deletes nothing (the mods API has no delete): the daemon removes the inbox file and the receipts it has read.
 * A last guard: `classic.UserPromptSubmit` blocks its own prompt when the mode it carries is bypassPermissions.
 *
 * WHAT IT NEVER DOES: no network call, no port, no process, no other file; it never reads the transcript and never writes
 * a word of the session anywhere. Text arrives only through the inbox, written by the daemon after its own checks
 * (remote-desk-steer.mjs).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STEER_MOD_NAME = "worktrust-steer";
export const STEER_MOD_VERSION = "1.0.0";
/** `$.prompt.submit` after an interrupt, and the VS Code extension's mods (2.1.299), both settled from this release. */
export const MIN_CLAUDE_CODE_STEER = "2.1.304";
/** How often the mod looks, and how old a heartbeat may be for the daemon to offer the session. */
export const STEER_TICK_MS = 1500;
export const ALIVE_FRESH_MS = 5000;
/** The modes that still ask the person (or a classifier) before a tool runs. Anything else, unknown included, takes no phone prompt. */
export const SAFE_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"];

export const STEER_REGISTER_SOURCE = `// WorkTrust steer ${STEER_MOD_VERSION}: a prompt from your phone into this session, after the WorkTrust CLI's checks.
// No network, no port, no process: files under ~/.worktrust/remote/desk-steer/<this session>/ only. Written by the WorkTrust CLI.
const SAFE = new Set(${JSON.stringify(SAFE_MODES)});
const MIN = ${JSON.stringify(MIN_CLAUDE_CODE_STEER.split(".").map(Number))};
const CMD = /^cmd_[A-Za-z0-9_-]{22}\\.json$/;
let dir = null, version = null, mode = null, busy = false, inFlight = null, running = null;
const seen = new Set();
const atLeast = (v) => { const p = String(v ?? "").split(/[.-]/).slice(0, 3).map(Number); for (let i = 0; i < 3; i += 1) { if ((p[i] ?? 0) > MIN[i]) return true; if ((p[i] ?? 0) < MIN[i]) return false; } return true; };
const receipt = ($, id, body) => $.fs.write(dir + "/receipts/" + id + ".json", JSON.stringify({ v: 1, command_id: id, at: Date.now(), ...body }));
const alive = ($, extra = {}) => $.fs.write(dir + "/alive.json", JSON.stringify({ v: 1, at: Date.now(), version, mode, ...extra }));
async function look($) {
  if (!dir) return;
  await alive($);
  if (busy || inFlight || running) return;
  busy = true;
  try {
    const names = (await $.fs.list(dir + "/inbox").catch(() => [])).filter((f) => f.kind === "file" && CMD.test(f.name) && !seen.has(f.name)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const next = names[0];
    if (!next) return;
    seen.add(next.name);
    const id = next.name.slice(0, -5), file = dir + "/inbox/" + next.name;
    let sent = null;
    try { sent = JSON.parse(await $.fs.read(file)); } catch { return; }
    if (!sent || sent.command_id !== id || typeof sent.text !== "string" || !sent.text.trim()) return receipt($, id, { state: "dropped", reason: "unreadable" });
    // Older than a minute (a daemon that died never withdrew it): never delivered late. Never a shell line or a command.
    if (!Number.isFinite(sent.at) || Date.now() - sent.at > 60000) return receipt($, id, { state: "dropped", reason: "stale" });
    if (/^\s*[!/]/.test(sent.text)) return receipt($, id, { state: "dropped", reason: "not_prompt" });
    await receipt($, id, { state: "taken" });
    if (!SAFE.has(mode)) return receipt($, id, { state: "dropped", reason: "bypass" });
    // Asked again right before the submit: the daemon withdraws by renaming the file away, and turning steering off removes the folder.
    if (!(await $.fs.exists(file))) return receipt($, id, { state: "dropped", reason: "withdrawn" });
    inFlight = { id, text: sent.text };
    $.prompt.submit({ text: sent.text, asUser: true }).then(async (r) => {
      const dropped = r && typeof r === "object" && "drop" in r;
      if (inFlight?.blocked) await receipt($, id, { state: "dropped", reason: "bypass" });
      else if (dropped) await receipt($, id, { state: "dropped", reason: "stopped" });
      else { running = id; await receipt($, id, { state: "submitted" }); }
    }, async () => { await receipt($, id, { state: "dropped", reason: "refused" }); }).finally(() => { inFlight = null; });
  } finally { busy = false; }
}

async function heard($, e, next) {
  try { if (typeof e.permission_mode === "string") mode = e.permission_mode; } catch {}
  return next(e);
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    try {
      version = String((await $.session.version())?.version ?? "");
      const session = String(await $.session.id()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
      const root = String($.plugin.root).replace(/[\\\\/]+$/, "").replace(/[\\\\/][^\\\\/]+$/, "");
      if (session && atLeast(version)) { dir = root + "/remote/desk-steer/" + session; $.clock.every(${STEER_TICK_MS}, () => look($)); }
    } catch {}
    return next(e);
  });
  // The session's permission mode, as every classic hook carries it: the last one heard is what alive.json says.
  on("classic.SessionStart", heard);
  on("classic.Stop", heard);
  on("classic.PostToolUse", heard);
  on("classic.Notification", heard);
  on("classic.PermissionRequest", heard);
  // The last guard: while a phone prompt is in flight, a prompt that starts under a mode that does not ask is blocked before the turn,
  // WHATEVER its text (review P2-2: the mode reaches the mod only through classic hooks, Shift+Tab into bypass raises none, and
  // this hook carries the mode the turn would start under). The mods API of 2.1.330 has no mode-change event to listen to.
  on("classic.UserPromptSubmit", async ($, e, next) => {
    try {
      if (typeof e.permission_mode === "string") mode = e.permission_mode;
      if (inFlight && !SAFE.has(mode)) { inFlight.blocked = true; return { block: "WorkTrust: a prompt from your phone is not run while this session skips permission questions." }; }
    } catch {}
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    try { if (running && dir) { const id = running; running = null; await receipt($, id, { state: "ended" }); } } catch {}
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    try { if (dir) await alive($, { ended: true }); } catch {}
    return next(e);
  });
}
`;

export const STEER_PLUGIN_JSON = { name: STEER_MOD_NAME, version: STEER_MOD_VERSION, description: "WorkTrust: lets your paired phone send a prompt into this Claude Code session, after the WorkTrust CLI's checks at this computer. No network, no port. Installed by `npx worktrust remote desk-steer on`.", author: { name: "WorkTrust", url: "https://worktrust.io" }, homepage: "https://worktrust.io", license: "LicenseRef-WorkTrust-CLI" };
export const STEER_HOOKS_JSON = { modules: ["./register.js"] };

const SEP = process.platform === "win32" ? ";" : ":";
const at = (home) => ({ plugin: join(home, ".worktrust", "claude-steer-mod"), settings: join(home, ".claude", "settings.json") });
/** Where the daemon and the mod meet: one folder per Claude Code session id. */
export const steerDir = (home = homedir()) => join(home, ".worktrust", "remote", "desk-steer");
const readSettings = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const named = (settings) => String(settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(SEP).filter(Boolean);
function writeSettings(file, settings) {
  mkdirSync(join(file, ".."), { recursive: true });
  if (existsSync(file)) writeFileSync(`${file}.worktrust-backup`, readFileSync(file));
  writeFileSync(`${file}.worktrust-tmp`, JSON.stringify(settings, null, 2));
  renameSync(`${file}.worktrust-tmp`, file);
}

/** Writes the mod and names its folder in Claude Code's settings (CLAUDE_CODE_PLUGIN_DIRS), as installMod does for the measuring mod. Idempotent. */
export function installSteerMod(home = homedir()) {
  const p = at(home);
  mkdirSync(join(p.plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(p.plugin, "hooks"), { recursive: true });
  mkdirSync(steerDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(p.plugin, ".claude-plugin", "plugin.json"), JSON.stringify(STEER_PLUGIN_JSON, null, 2) + "\n");
  writeFileSync(join(p.plugin, "hooks", "hooks.json"), JSON.stringify(STEER_HOOKS_JSON, null, 2) + "\n");
  writeFileSync(join(p.plugin, "hooks", "register.js"), STEER_REGISTER_SOURCE);
  const settings = readSettings(p.settings), dirs = named(settings);
  if (dirs.includes(p.plugin)) return { dir: p.plugin, settingsChanged: false };
  settings.env = { ...(settings.env ?? {}), CLAUDE_CODE_PLUGIN_DIRS: [...dirs, p.plugin].join(SEP) };
  writeSettings(p.settings, settings);
  return { dir: p.plugin, settingsChanged: true };
}

/** Takes the mod out of Claude Code's settings and deletes it and every inbox, receipt and heartbeat. Other named folders stay. */
export function uninstallSteerMod(home = homedir()) {
  const p = at(home);
  let settingsChanged = false;
  try {
    const settings = readSettings(p.settings), dirs = named(settings);
    if (dirs.includes(p.plugin)) {
      const rest = dirs.filter((d) => d !== p.plugin), env = { ...settings.env };
      if (rest.length) env.CLAUDE_CODE_PLUGIN_DIRS = rest.join(SEP); else delete env.CLAUDE_CODE_PLUGIN_DIRS;
      if (Object.keys(env).length) settings.env = env; else delete settings.env;
      writeSettings(p.settings, settings);
      settingsChanged = true;
    }
  } catch { /* an unreadable settings file names nothing we wrote */ }
  rmSync(p.plugin, { recursive: true, force: true });
  rmSync(steerDir(home), { recursive: true, force: true });
  return { settingsChanged };
}

/** Whether the mod is in place: its file written and its folder named in Claude Code's settings. */
export function steerModInstalled(home = homedir()) {
  const p = at(home);
  if (!existsSync(join(p.plugin, "hooks", "register.js"))) return false;
  try { return named(readSettings(p.settings)).includes(p.plugin); } catch { return false; }
}
