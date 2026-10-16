/**
 * THE WORKTRUST MOD FOR CLAUDE CODE (owner, 2026-10-16: "implement mods so we can collect additional data relevant to
 * human-AI capability"). Claude Code 2.1.287 runs mods: plugins whose functions run INSIDE Claude Code on its events
 * (docs/CLAUDE-CODE-MOD.md). This file is the whole of ours, and how the CLI puts it in place and reads it back.
 *
 * WHAT IT ADDS, ONLY WHAT A TRANSCRIPT CANNOT SHOW (owner: "what fits and adds value, without noise"):
 *   oversight  a permission question put to the PERSON, and whether they said yes or no (a transcript shows a refusal,
 *              never an approval after a question); not counted where a classifier or a mode answers instead
 *   effort     each model request by its effort level, how many models answered, requests on another model than
 *              the main conversation's (routing)
 *   context    the peak context fill and the peak plan-limit use, as percentages; compactions asked for or automatic
 *   delegation subagents started (built-in, the person's own, in the background, forks), teammates; and the setup in
 *              force: other mods, MCP servers and the person's own agent types, as counts
 *
 * WHAT IT NEVER DOES: it reads no text it keeps (a prompt, an answer, a command, a path, a name), it makes no network
 * call, it changes no event (every hook returns what `next` gave it), and it writes one file per session of integer
 * counts under ~/.worktrust/claude-mod-counts. The CLI reads that file when it reports the session's stretch and sends
 * the counts, as the `live` evidence group, through the same signed door as everything else; the door keeps only the
 * keys of `MOD_FIELDS` (packages/core/src/stretch-evidence.ts holds the same list, check-cli-package holds them equal).
 * The figures reach the person's own mirror and nothing that scores: no dimension, no level, no passport, until they
 * are validated (CLAUDE.md rules 6 and 11; the owner's choice, 2026-10-16).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MOD_NAME = "worktrust-measure";
export const MOD_VERSION = "1.0.0";
/** The first Claude Code whose terminal runs installed mods (the Desktop app from 2.1.286). */
export const MIN_CLAUDE_CODE = "2.1.287";

/** The closed list of what the mod counts: integers per UTC day; the two `_pct` fields are peaks from 0 to 100. */
export const MOD_FIELDS = [
  "asked", "approved", "declined",
  "effort_low", "effort_medium", "effort_high", "effort_xhigh", "effort_max", "models", "routed",
  "context_peak_pct", "limit_peak_pct", "compact_manual", "compact_auto",
  "spawned_builtin", "spawned_custom", "spawned_background", "forks", "teammates",
  "mods", "mcp_servers", "custom_agents",
];
export const PEAK_FIELDS = ["context_peak_pct", "limit_peak_pct"];

/**
 * The mod itself: a hooks module as Claude Code loads it (`register(on)`), written out by `installMod`. Plain
 * JavaScript, no import, so the file Claude Code runs is the text below and nothing else; `claude plugin validate`
 * lists what it uses: the events below, `fs.write`, `session.id` and `tool.list`.
 */
export const REGISTER_SOURCE = `// WorkTrust measure ${MOD_VERSION}: counts what a transcript cannot show, never a word of the session.
// Every hook returns what next() gave it: this mod observes and changes nothing. Written by the WorkTrust CLI.
const FIELDS = ${JSON.stringify(MOD_FIELDS)};
const PEAKS = new Set(${JSON.stringify(PEAK_FIELDS)});
const NOBODY_ASKED = new Set(["auto", "dontAsk", "bypassPermissions"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const days = {};
let file = null, session = null, mode = "default", main = null, dirty = false, written = 0;
const seen = { models: new Set(), servers: new Set(), agents: new Set(), mods: new Set() };
const asked = new Set();
const day = () => new Date().toISOString().slice(0, 10);
const row = () => (days[day()] ??= {});
const bump = (key) => { const r = row(); r[key] = Math.min(100000, (r[key] ?? 0) + 1); dirty = true; };
const set = (key, value) => { const r = row(); const v = Math.max(0, Math.min(PEAKS.has(key) ? 100 : 100000, Math.round(value))); if ((r[key] ?? -1) < v) { r[key] = v; dirty = true; } };
// The file's text when it is due (at most every five seconds, or now at the session's end); null when nothing changed.
function due(now) {
  if (!file || !dirty || (!now && Date.now() - written < 5000)) return null;
  dirty = false; written = Date.now();
  const clean = {};
  for (const [d, r] of Object.entries(days)) clean[d] = Object.fromEntries(FIELDS.filter((k) => Number.isInteger(r[k]) && r[k] > 0).map((k) => [k, r[k]]));
  return JSON.stringify({ v: 1, mod: "${MOD_NAME}@${MOD_VERSION}", session, days: clean });
}
const MCP = /^mcp__(.+?)__/;

export function register(on) {
  on("session.start", async ($, e, next) => {
    try {
      session = String(await $.session.id()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null;
      const root = String($.plugin.root).replace(/[\\/]+$/, "");
      if (session) file = root.replace(/[\\/][^\\/]+$/, "") + "/claude-mod-counts/" + session + ".json";
      for (const tool of await $.tool.list()) { const m = MCP.exec(String(tool.name ?? "")); if (m) seen.servers.add(m[1]); }
      set("mcp_servers", seen.servers.size);
      set("mods", seen.mods.size);
      set("custom_agents", seen.agents.size);
    } catch {}
    return next(e);
  });
  // The other mods the person runs, by count: a fact of their setup, never a name kept.
  on("plugin.register", async ($, e, next) => {
    try { if (e.tier === "user" && e.name !== "${MOD_NAME}") { seen.mods.add(e.name); set("mods", seen.mods.size); } } catch {}
    return next(e);
  });
  // Their own agent types, offered beside the built-in ones.
  on("agent.offer", async ($, e, next) => {
    try { if (e.provider?.tier !== "core") { seen.agents.add(e.agent); set("custom_agents", seen.agents.size); } } catch {}
    return next(e);
  });
  // Who answers a permission question: the person, unless a mode or a classifier does.
  on("classic.UserPromptSubmit", async ($, e, next) => {
    try { if (typeof e.permission_mode === "string") mode = e.permission_mode; } catch {}
    return next(e);
  });
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    try { if (verdict?.decision === "ask" && !verdict.decider && !NOBODY_ASKED.has(mode) && e.tool_use_id) { asked.add(e.tool_use_id); bump("asked"); } } catch {}
    return verdict;
  });
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    try { if (e.tool_use_id && asked.delete(e.tool_use_id)) bump(result && "deny" in result && typeof result.deny === "string" ? "declined" : "approved"); } catch {}
    return result;
  });
  on("turn.step", async function* ($, e, next) {
    try {
      if (!e.agentId) main = e.model;
      if (typeof e.effort === "string" && EFFORTS.has(e.effort)) bump("effort_" + e.effort);
      if (e.model) { seen.models.add(e.model); set("models", seen.models.size); }
      if (e.agentId && main && e.model && e.model !== main) bump("routed");
    } catch {}
    return yield* next(e);
  });
  on("agent.spawn", async ($, e, next) => {
    try {
      if (e.isTeammate) bump("teammates");
      else if (e.fork) bump("forks");
      else bump(e.provider?.tier === "core" ? "spawned_builtin" : "spawned_custom");
      if (e.background) bump("spawned_background");
    } catch {}
    return next(e);
  });
  on("session.compact", async ($, e, next) => {
    try { bump(e.trigger === "manual" ? "compact_manual" : "compact_auto"); } catch {}
    return next(e);
  });
  on("session.measure", async ($, e, next) => {
    try {
      if (Number.isFinite(e.context?.percent)) set("context_peak_pct", e.context.percent);
      for (const limit of e.rateLimits ?? []) if (Number.isFinite(limit?.percentUsed)) set("limit_peak_pct", limit.percentUsed);
    } catch {}
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    try { const text = due(false); if (text) await $.fs.write(file, text); } catch {}
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    try { const text = due(true); if (text) await $.fs.write(file, text); } catch {}
    return next(e);
  });
}
`;

export const PLUGIN_JSON = { name: MOD_NAME, version: MOD_VERSION, description: "WorkTrust: counts how you work with Claude Code (permission answers, effort levels, context peaks, subagents), never a word of the session. Counts stay on this computer until the WorkTrust CLI reports a session.", author: { name: "WorkTrust", url: "https://worktrust.io" }, homepage: "https://worktrust.io", license: "MIT" };
export const HOOKS_JSON = { modules: ["./register.js"] };

const dirs = (home) => ({ plugin: join(home, ".worktrust", "claude-mod"), counts: join(home, ".worktrust", "claude-mod-counts"), settings: join(home, ".claude", "settings.json") });
const SEP = process.platform === "win32" ? ";" : ":";
const readSettings = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
function writeSettings(file, settings) {
  mkdirSync(join(file, ".."), { recursive: true });
  if (existsSync(file)) writeFileSync(`${file}.worktrust-backup`, readFileSync(file));
  writeFileSync(`${file}.worktrust-tmp`, JSON.stringify(settings, null, 2));
  renameSync(`${file}.worktrust-tmp`, file);
}

/**
 * Writes the mod to ~/.worktrust/claude-mod and names that directory in Claude Code's own settings
 * (`env.CLAUDE_CODE_PLUGIN_DIRS`, the documented way to load a plugin directory in every session), keeping any
 * directory already named there. The settings file is backed up beside itself first. Idempotent: a second run
 * rewrites the files and changes no setting.
 */
export function installMod(home = homedir()) {
  const at = dirs(home);
  mkdirSync(join(at.plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(at.plugin, "hooks"), { recursive: true });
  mkdirSync(at.counts, { recursive: true });
  writeFileSync(join(at.plugin, ".claude-plugin", "plugin.json"), JSON.stringify(PLUGIN_JSON, null, 2) + "\n");
  writeFileSync(join(at.plugin, "hooks", "hooks.json"), JSON.stringify(HOOKS_JSON, null, 2) + "\n");
  writeFileSync(join(at.plugin, "hooks", "register.js"), REGISTER_SOURCE);
  const settings = readSettings(at.settings);
  const named = String(settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(SEP).filter(Boolean);
  if (named.includes(at.plugin)) return { dir: at.plugin, settingsChanged: false };
  settings.env = { ...(settings.env ?? {}), CLAUDE_CODE_PLUGIN_DIRS: [...named, at.plugin].join(SEP) };
  writeSettings(at.settings, settings);
  return { dir: at.plugin, settingsChanged: true };
}

/** Takes the mod out of Claude Code's settings and deletes it and the counts it kept. Other named directories stay. */
export function uninstallMod(home = homedir()) {
  const at = dirs(home);
  const settings = readSettings(at.settings);
  const named = String(settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(SEP).filter(Boolean);
  let settingsChanged = false;
  if (named.includes(at.plugin)) {
    const rest = named.filter((one) => one !== at.plugin);
    const env = { ...settings.env };
    if (rest.length) env.CLAUDE_CODE_PLUGIN_DIRS = rest.join(SEP); else delete env.CLAUDE_CODE_PLUGIN_DIRS;
    if (Object.keys(env).length) settings.env = env; else delete settings.env;
    writeSettings(at.settings, settings);
    settingsChanged = true;
  }
  rmSync(at.plugin, { recursive: true, force: true });
  rmSync(at.counts, { recursive: true, force: true });
  return { settingsChanged };
}

/** Whether the mod is in place: its file written and its directory named in Claude Code's settings. */
export function modInstalled(home = homedir()) {
  const at = dirs(home);
  if (!existsSync(join(at.plugin, "hooks", "register.js"))) return false;
  try { return String(readSettings(at.settings).env?.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(SEP).includes(at.plugin); } catch { return false; }
}

/**
 * The counts the mod kept for one Claude Code session on one UTC day, as the `live` evidence group: only the keys of
 * `MOD_FIELDS`, only positive integers (the peaks at most 100, the rest at most 100,000). Null when the mod kept
 * nothing for that session and day, so a stretch without the mod carries no group at all, never zeros.
 */
export function modCounts(sessionId, day, home = homedir()) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(sessionId ?? "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return null;
  const file = join(dirs(home).counts, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  let kept;
  try { kept = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const row = kept?.days?.[day];
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const key of MOD_FIELDS) {
    const value = row[key];
    if (!Number.isInteger(value) || value <= 0) continue;
    out[key] = Math.min(PEAK_FIELDS.includes(key) ? 100 : 100000, value);
  }
  return Object.keys(out).length ? out : null;
}
