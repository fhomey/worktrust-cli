/**
 * THE SESSION DATABASES — the clients that keep their sessions in SQLite, read into Claude Code's shape (2026-10-05).
 *
 * Hermes Agent, Goose, OpenCode and OpenClaw keep no transcript file: each writes its sessions to its own SQLite
 * database. This reads them through node:sqlite (Node 22.5+), read-only, into the same lines transcript-readers.mjs
 * makes of the files, so the session hook's one clock reads them all. Each query takes roles, clocks, models and token
 * counts and no text column (scripts/test-database-clients.mjs holds every query to that). It ships beside the hook,
 * like transcript-readers.mjs; without it, or without node:sqlite, these clients are not read and nothing else changes.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as zlib from "node:zlib"; // zstd since Node 22.15; older Node reads OpenClaw's uncompressed rows only
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { cleanModel, cursorCall, copilotCall } from "./transcript-readers.mjs";

// ── hermes session reader ──
/**
 * HERMES AGENT, READ FROM ITS OWN DATABASE (Nous Research, 2026-10-05). Hermes keeps every session in one SQLite file
 * per profile: `state.db` under its home (~/.hermes, %LOCALAPPDATA%/hermes on Windows, HERMES_HOME when set) and under
 * each profile in profiles/<name>/ (hermes-agent.nousresearch.com/docs/developer-guide/session-storage, /user-guide/profiles).
 * A session is read as a transcript: each message's role and clock, never its `content`, which this query does not
 * select. A user message is a human turn, a tool message the loop's own result. The session's token totals ride on its
 * last assistant message (Hermes keeps them per session, not per response). `source` says how it was steered: the
 * terminal or the desktop app is the desk, a chat app (Telegram, WhatsApp, Slack …) is the computer driven from
 * elsewhere. A subagent's, a scheduled job's or a board task's session has no person at the controls and its time
 * already lies inside its parent's: it is not read. Needs node:sqlite (Node 22.5+); without it Hermes is not read.
 */
const HERMES_DESK = new Set(["cli", "desktop", "dashboard", "tui"]);
const HERMES_REMOTE = new Set(["telegram", "discord", "slack", "whatsapp", "signal", "matrix", "mattermost", "email", "sms", "homeassistant", "feishu", "dingtalk", "wecom", "weixin", "bluebubbles", "qqbot"]);
const HERMES_UNATTENDED = new Set(["subagent", "cron", "kanban"]);
export const hermesSteered = (source) => (HERMES_DESK.has(source) ? "desk" : HERMES_REMOTE.has(source) ? "remote" : null);
let sqlite;
/** A database session's pseudo-file, `<client>:<database>#<session id>`, back into its parts. */
const splitSession = (pseudo) => { const at = pseudo.lastIndexOf("#"); return { file: pseudo.slice(pseudo.indexOf(":") + 1, at), id: pseudo.slice(at + 1) }; };
const isoOf = (value) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toISOString() : null; }; // null: that row is skipped, never the session (0.6.16, M2)
const openDatabase = (file) => {
  if (sqlite === undefined) {
    // node:sqlite says it is experimental on some Node versions; that line is not the person's business inside a hook.
    const warn = process.emitWarning;
    try { process.emitWarning = () => {}; sqlite = createRequire(import.meta.url)("node:sqlite"); } catch { sqlite = null; } finally { process.emitWarning = warn; }
  }
  if (!sqlite) return null;
  try { return new sqlite.DatabaseSync(file, { readOnly: true }); } catch { return null; }
};
/** Hermes's homes on this machine: the default, HERMES_HOME, and every profile's. A test names its own. */
export function hermesHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  const base = platform() === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : join(homedir(), ".hermes");
  const homes = new Set([base, ...(process.env.HERMES_HOME ? [process.env.HERMES_HOME] : [])]);
  try { for (const name of readdirSync(join(base, "profiles")).sort()) homes.add(join(base, "profiles", name)); } catch { /* no profiles */ }
  return [...homes];
}
export const hermesHere = () => hermesHomes().some((home) => { try { return statSync(join(home, "config.yaml")).isFile() || statSync(join(home, "state.db")).isFile(); } catch { return false; } });
const columnsOf = (db, table) => new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
/** Every attended session under the homes: its id, its pseudo-file, its folder and its last message's moment. */
export function* hermesSessions(homes) {
  for (const home of homes) {
    const file = join(home, "state.db");
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const db = openDatabase(file);
    if (!db) continue;
    try {
      const has = columnsOf(db, "sessions");
      const rows = db.prepare(`select s.id, s.source, s.parent_session_id as parent, ${has.has("cwd") ? "s.cwd" : "null"} as cwd, max(m.timestamp) as last
        from sessions s join messages m on m.session_id = s.id group by s.id order by s.id`).all();
      for (const row of rows) {
        if (row.parent || HERMES_UNATTENDED.has(row.source) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(row.id))) continue;
        yield { sessionId: String(row.id), file: `hermes:${file}#${row.id}`, cwd: typeof row.cwd === "string" ? row.cwd : null, writtenAt: Number(row.last) * 1000 };
      }
    } catch { /* an older or foreign schema: not read */ } finally { db.close(); }
  }
}
/** One session → lines in Claude Code's shape: roles, clocks, the model, the totals, the folder and the steering. No text. */
export function hermesLines(pseudo) {
  const { file, id } = splitSession(pseudo);
  const db = openDatabase(file);
  if (!db) return null;
  try {
    const has = columnsOf(db, "sessions");
    const pick = (name) => (has.has(name) ? `${name}` : `0 as ${name}`);
    const session = db.prepare(`select source, model, ${has.has("cwd") ? "cwd" : "null as cwd"}, ${["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].map(pick).join(", ")} from sessions where id = ?`).get(id);
    if (!session) return [];
    const messages = db.prepare("select role, timestamp from messages where session_id = ? and timestamp is not null order by timestamp, id").all(id);
    const model = cleanModel(session.model);
    const out = [{ type: "meta", ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}), steered: hermesSteered(session.source) }];
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    messages.forEach((message, i) => {
      const timestamp = isoOf(Number(message.timestamp) * 1000); if (!timestamp) return;
      if (message.role === "user") out.push({ type: "user", timestamp, message: { content: [{ type: "text" }] } });
      else if (message.role === "tool") out.push({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] } });
      else if (message.role === "assistant") out.push({ type: "assistant", timestamp, ...(i === lastAssistant ? { cumulative: true } : {}), message: { model, ...(i === lastAssistant ? { usage: { input_tokens: Number(session.input_tokens) || 0, output_tokens: Number(session.output_tokens) || 0, cache_read_input_tokens: Number(session.cache_read_tokens) || 0, cache_creation_input_tokens: Number(session.cache_write_tokens) || 0 } } : {}), content: [] } });
    });
    return out;
  } catch { return null; } finally { db.close(); }
}
// ── end hermes session reader ──

// ── goose session reader ──
/**
 * GOOSE, READ FROM ITS OWN DATABASE (2026-10-05). Goose (aaif-goose/goose, formerly block/goose) keeps every session in
 * one SQLite file since 1.10, `sessions/sessions.db` under its data folder (~/.local/share/goose, %APPDATA%\\Block\\goose\\data
 * on Windows, <GOOSE_PATH_ROOT>/data when set; crates/goose/src/session/session_manager.rs, config/paths.rs). A session
 * is read as a transcript: each message's role, its clock (`created_timestamp`, seconds) and the TYPE of each content
 * block, read inside SQLite with json_extract so the text never leaves the database: a user message that answers a tool
 * (`toolResponse`) is the loop, one with text or an image is the person. Tokens come from the per-call `usage_ledger`
 * rows (model per call), each on the assistant message at or before it; without that table, the session's accumulated
 * totals ride on its last assistant message. A subagent's, a scheduled run's or a hidden session is not read; a session
 * through the gateway (a chat app) is steered from elsewhere, any other from the desk.
 */
const GOOSE_UNATTENDED = new Set(["sub_agent", "scheduled", "hidden"]);
export const gooseSteered = (type) => (type === "gateway" ? "remote" : type ? "desk" : null);
export function gooseHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  const homes = [join(homedir(), ".local", "share", "goose"), join(homedir(), "Library", "Application Support", "Block", "goose")];
  if (process.env.GOOSE_PATH_ROOT) homes.unshift(join(process.env.GOOSE_PATH_ROOT, "data"));
  if (platform() === "win32" && process.env.APPDATA) homes.push(join(process.env.APPDATA, "Block", "goose", "data"));
  return homes;
}
export function* gooseSessions(homes) {
  for (const home of homes) {
    const file = join(home, "sessions", "sessions.db");
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const db = openDatabase(file);
    if (!db) continue;
    try {
      const rows = db.prepare(`select s.id, s.session_type as type, s.parent_session_id as parent, s.working_dir as cwd, max(m.created_timestamp) as last
        from sessions s join messages m on m.session_id = s.id group by s.id order by s.id`).all();
      for (const row of rows) {
        if (row.parent || GOOSE_UNATTENDED.has(row.type) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(row.id))) continue;
        const last = Number(row.last);
        yield { sessionId: String(row.id), file: `goose:${file}#${row.id}`, cwd: typeof row.cwd === "string" ? row.cwd : null, writtenAt: (last > 1e10 ? last : last * 1000) };
      }
    } catch { /* an older or foreign schema: not read */ } finally { db.close(); }
  }
}
export function gooseLines(pseudo) {
  const { file, id } = splitSession(pseudo);
  const db = openDatabase(file);
  if (!db) return null;
  const ms = (value) => { const n = Number(value); return n > 1e10 ? n : n * 1000; };
  try {
    const session = db.prepare(`select session_type as type, working_dir as cwd, json_extract(model_config_json, '$.model_name') as model,
      accumulated_input_tokens as input, accumulated_output_tokens as output, accumulated_cache_read_tokens as cache_read, accumulated_cache_write_tokens as cache_write
      from sessions where id = ?`).get(id);
    if (!session) return [];
    const messages = db.prepare(`select role, created_timestamp as at,
      case when json_valid(content_json) then (select group_concat(json_extract(value, '$.type')) from json_each(content_json)) end as kinds
      from messages where session_id = ? order by created_timestamp, id`).all(id);
    const ledger = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'usage_ledger'").get() ? db.prepare("select created_timestamp as at, model, input_tokens as input, output_tokens as output, cache_read_tokens as cache_read, cache_write_tokens as cache_write from usage_ledger where session_id = ? order by created_timestamp, id").all(id)
      : null;
    const fallbackModel = cleanModel(session.model);
    const lines = messages.map((message) => {
      const kinds = new Set(String(message.kinds ?? "").split(","));
      const timestamp = isoOf(ms(message.at)); if (!timestamp) return null;
      if (message.role === "user") return { type: "user", timestamp, message: { content: [{ type: kinds.has("toolResponse") ? "tool_result" : kinds.has("text") || kinds.has("image") ? "text" : "tool_result" }] } };
      return { type: "assistant", timestamp, at: ms(message.at), message: { model: fallbackModel, content: [] } };
    }).filter(Boolean);
    const assistants = lines.filter((line) => line.type === "assistant");
    const usageOf = (row) => ({ input_tokens: Number(row.input) || 0, output_tokens: Number(row.output) || 0, cache_read_input_tokens: Number(row.cache_read) || 0, cache_creation_input_tokens: Number(row.cache_write) || 0 });
    const add = (line, usage) => { const was = line.message.usage; line.message.usage = was ? Object.fromEntries(Object.entries(usage).map(([key, n]) => [key, n + (was[key] ?? 0)])) : usage; };
    if (ledger) for (const row of ledger) {
      const at = ms(row.at) + 1000;
      const line = [...assistants].reverse().find((one) => one.at <= at) ?? assistants[0];
      if (!line) continue;
      add(line, usageOf(row));
      if (cleanModel(row.model)) line.message.model = cleanModel(row.model);
    } else if (assistants.length) { add(assistants.at(-1), usageOf(session)); assistants.at(-1).cumulative = true; } // the session's totals: sent as what they grew by
    for (const line of assistants) delete line.at;
    return [{ type: "meta", ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}), steered: gooseSteered(session.type) }, ...lines];
  } catch { return null; } finally { db.close(); }
}
// ── end goose session reader ──

// ── opencode session reader ──
/**
 * OPENCODE, READ FROM ITS OWN DATABASE (2026-10-05). OpenCode (anomalyco/opencode, formerly sst/opencode) keeps its
 * sessions in SQLite, `opencode.db` (or `opencode-<channel>.db`) under ~/.local/share/opencode on every system
 * (packages/core/src/database/database.ts, session/sql.ts). A message's `data` is JSON; only its role, its clock
 * (`time.created`, ms), its model and its token counts are taken out, inside SQLite with json_extract, so no text
 * leaves the database (text lives in the `part` table, which is never read). A subagent's session (`parent_id`) is not
 * read. How it was steered is not said: the terminal, the desktop app and a phone on `opencode serve` look alike here.
 */
export function opencodeHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  return [join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")];
}
const opencodeDatabases = (home) => { try { return readdirSync(home).filter((name) => /^opencode(-[A-Za-z0-9_.-]+)?\.db$/.test(name)).sort().map((name) => join(home, name)); } catch { return []; } };
export function* opencodeSessions(homes) {
  for (const home of homes) for (const file of opencodeDatabases(home)) {
    const db = openDatabase(file);
    if (!db) continue;
    try {
      const rows = db.prepare(`select s.id, s.parent_id as parent, s.directory as cwd, max(m.time_created) as last
        from session s join message m on m.session_id = s.id group by s.id order by s.id`).all();
      for (const row of rows) {
        if (row.parent || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(row.id))) continue;
        yield { sessionId: String(row.id), file: `opencode:${file}#${row.id}`, cwd: typeof row.cwd === "string" ? row.cwd : null, writtenAt: Number(row.last) };
      }
    } catch { /* an older or foreign schema: not read */ } finally { db.close(); }
  }
}
export function opencodeLines(pseudo) {
  const { file, id } = splitSession(pseudo);
  const db = openDatabase(file);
  if (!db) return null;
  try {
    const session = db.prepare("select directory as cwd from session where id = ?").get(id);
    if (!session) return [];
    const messages = db.prepare(`select json_extract(data, '$.role') as role, coalesce(json_extract(data, '$.time.created'), time_created) as at,
      json_extract(data, '$.modelID') as model, json_extract(data, '$.tokens.input') as input, json_extract(data, '$.tokens.output') as output,
      json_extract(data, '$.tokens.reasoning') as reasoning, json_extract(data, '$.tokens.cache.read') as cache_read, json_extract(data, '$.tokens.cache.write') as cache_write
      from message where session_id = ? order by time_created, id`).all(id);
    const lines = messages.map((message) => {
      const timestamp = isoOf(Number(message.at)); if (!timestamp) return null;
      if (message.role === "user") return { type: "user", timestamp, message: { content: [{ type: "text" }] } };
      const counted = message.input !== null || message.output !== null;
      return { type: "assistant", timestamp, message: { model: cleanModel(message.model), ...(counted ? { usage: { input_tokens: Number(message.input) || 0, output_tokens: (Number(message.output) || 0) + (Number(message.reasoning) || 0), cache_read_input_tokens: Number(message.cache_read) || 0, cache_creation_input_tokens: Number(message.cache_write) || 0 } } : {}), content: [] } };
    }).filter(Boolean);
    return [{ type: "meta", ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}) }, ...lines];
  } catch { return null; } finally { db.close(); }
}
// ── end opencode session reader ──

// ── openclaw session reader ──
/**
 * OPENCLAW, READ FROM ITS OWN DATABASE (2026-10-05). OpenClaw keeps each agent's sessions in SQLite,
 * ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite (OPENCLAW_STATE_DIR moves ~/.openclaw;
 * src/state/openclaw-agent-schema.sql). A window (`session_windows`) is one session; its transcript is
 * `transcript_events`, one JSON event per row, or the same JSON zstd-compressed when large. From a `message` event only
 * the role, the clock (ms), the model and the usage are taken: in SQLite with json_extract for the plain rows, and in
 * memory for a compressed row, whose text is dropped as soon as those four are read. A spawned, scheduled, plugin or
 * internal session is not read. Steering: a Talk session (`created_via = 'talk'`) is voice; one that came through a
 * chat channel (WhatsApp, Telegram, Slack …) is remote; the rest is not said.
 */
const OPENCLAW_UNATTENDED = new Set(["spawn", "cron", "plugin", "internal"]);
const OPENCLAW_LOCAL = new Set(["webchat", "cli", "tui", "terminal", "desktop", "macos", "control-ui"]);
export const openclawSteered = (createdVia, channel) => (createdVia === "talk" ? "voice" : channel && !OPENCLAW_LOCAL.has(String(channel).toLowerCase()) ? "remote" : null);
export function openclawHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  const base = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  try { return readdirSync(join(base, "agents")).sort().map((agent) => join(base, "agents", agent, "agent")); } catch { return []; }
}
const msOf = (value) => { const n = Number(value); return n > 1e11 ? n : n * 1000; };
export function* openclawSessions(homes) {
  for (const home of homes) {
    const file = join(home, "openclaw-agent.sqlite");
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const db = openDatabase(file);
    if (!db) continue;
    try {
      const rows = db.prepare(`select w.session_id as id, n.created_via as via, coalesce(w.spawned_by, w.parent_session_key, n.spawned_by, n.parent_session_key) as parent, max(e.created_at) as last
        from session_windows w join session_nodes n on n.session_key = w.session_key join transcript_events e on e.session_id = w.session_id group by w.session_id order by w.session_id`).all();
      for (const row of rows) {
        if (row.parent || OPENCLAW_UNATTENDED.has(row.via) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(row.id))) continue;
        yield { sessionId: String(row.id), file: `openclaw:${file}#${row.id}`, cwd: null, writtenAt: msOf(row.last) };
      }
    } catch { /* an older or foreign schema: not read */ } finally { db.close(); }
  }
}
export function openclawLines(pseudo) {
  const { file, id } = splitSession(pseudo);
  const db = openDatabase(file);
  if (!db) return null;
  try {
    const session = db.prepare("select n.created_via as via, w.channel as channel, w.model as model from session_windows w join session_nodes n on n.session_key = w.session_key where w.session_id = ?").get(id);
    if (!session) return [];
    const plain = db.prepare(`select seq, json_extract(event_json, '$.message.role') as role, json_extract(event_json, '$.message.timestamp') as at, json_extract(event_json, '$.message.model') as model,
      json_extract(event_json, '$.message.usage.input') as input, json_extract(event_json, '$.message.usage.output') as output, json_extract(event_json, '$.message.usage.cacheRead') as cache_read, json_extract(event_json, '$.message.usage.cacheWrite') as cache_write
      from transcript_events where session_id = ? and event_json is not null and json_extract(event_json, '$.type') = 'message'`).all(id);
    const packed = db.prepare("select seq, event_zstd as packed from transcript_events where session_id = ? and event_json is null and event_zstd is not null").all(id).map(({ seq, packed: blob }) => {
      try {
        const event = JSON.parse(zlib.zstdDecompressSync(Buffer.from(blob)).toString("utf8"));
        if (event?.type !== "message") return null;
        const { role, timestamp, model, usage } = event.message ?? {};
        return { seq, role, at: timestamp, model, input: usage?.input ?? null, output: usage?.output ?? null, cache_read: usage?.cacheRead ?? null, cache_write: usage?.cacheWrite ?? null };
      } catch { return null; }
    }).filter(Boolean);
    const lines = [...plain, ...packed].filter((event) => Number.isFinite(Number(event.at))).sort((a, b) => a.seq - b.seq).map((event) => {
      const timestamp = new Date(msOf(event.at)).toISOString();
      if (event.role === "user") return { type: "user", timestamp, message: { content: [{ type: "text" }] } };
      if (event.role === "toolResult") return { type: "user", timestamp, message: { content: [{ type: "tool_result" }] } };
      const counted = event.input !== null || event.output !== null;
      return { type: "assistant", timestamp, message: { model: cleanModel(event.model) ?? cleanModel(session.model), ...(counted ? { usage: { input_tokens: Number(event.input) || 0, output_tokens: Number(event.output) || 0, cache_read_input_tokens: Number(event.cache_read) || 0, cache_creation_input_tokens: Number(event.cache_write) || 0 } } : {}), content: [] } };
    });
    return [{ type: "meta", steered: openclawSteered(session.via, session.channel) }, ...lines];
  } catch { return null; } finally { db.close(); }
}
// ── end openclaw session reader ──

// ── cursor session reader ──
/**
 * CURSOR, READ FROM ITS OWN DATABASE (2026-10-06, the owner: "a person who works in Cursor all day has no measured
 * hours"). Cursor keeps every chat ("composer") in one SQLite file, `User/globalStorage/state.vscdb` (~/Library/Application
 * Support/Cursor on macOS, %APPDATA%\Cursor on Windows, ~/.config/Cursor on Linux), table cursorDiskKV: `composerData:<id>`
 * per chat and `bubbleId:<id>:<bubble>` per message. Each message is read through json_extract INSIDE SQLite, its type
 * (1 the person, 2 the model), its clock and its token counts, so no text ever leaves the database. A model message that
 * carries a tool call is the loop's own step. The folder a chat belongs to is read from each workspace's own state
 * (`composer.composerData`); a chat in no workspace has none. Needs node:sqlite (Node 22.5+).
 */
const userDirs = (app) => {
  const base = platform() === "win32" && process.env.APPDATA ? process.env.APPDATA : platform() === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config");
  return [join(base, app, "User")];
};
const folderOf = (uri) => { try { return typeof uri === "string" && uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, "$1") : null; } catch { return null; } };
export function cursorHomes(given) { return given ? [given.replace(/^~(?=\/|$)/, homedir())] : userDirs("Cursor"); }
/** Which folder each composer belongs to, from every workspace's own state. */
function cursorFolders(home) {
  const folders = new Map();
  let dirs = []; try { dirs = readdirSync(join(home, "workspaceStorage")); } catch { return folders; }
  for (const dir of dirs) {
    let folder = null; try { folder = folderOf(JSON.parse(readFileSync(join(home, "workspaceStorage", dir, "workspace.json"), "utf8")).folder); } catch { continue; }
    if (!folder) continue;
    const db = openDatabase(join(home, "workspaceStorage", dir, "state.vscdb"));
    if (!db) continue;
    try {
      const row = db.prepare("select json_extract(value, '$.allComposers') as ids from ItemTable where key = 'composer.composerData'").get();
      for (const one of JSON.parse(row?.ids ?? "[]")) if (one?.composerId) folders.set(String(one.composerId), folder);
    } catch { /* an older schema */ } finally { db.close(); }
  }
  return folders;
}
export function* cursorSessions(homes) {
  for (const home of homes) {
    const file = join(home, "globalStorage", "state.vscdb");
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const folders = cursorFolders(home);
    const db = openDatabase(file);
    if (!db) continue;
    try {
      const rows = db.prepare("select substr(key, 14) as id, json_extract(value, '$.lastUpdatedAt') as last from cursorDiskKV where key like 'composerData:%'").all();
      for (const row of rows) {
        if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(String(row.id))) continue;
        yield { sessionId: String(row.id), file: `cursor:${file}#${row.id}`, cwd: folders.get(String(row.id)) ?? null, writtenAt: Number(row.last) || 0 };
      }
    } catch { /* an older or foreign schema: not read */ } finally { db.close(); }
  }
}
export function cursorLines(pseudo) {
  const { file, id } = splitSession(pseudo);
  const db = openDatabase(file);
  if (!db) return null;
  try {
    const chat = db.prepare("select json_extract(value, '$.modelConfig.modelName') as model from cursorDiskKV where key = ?").get(`composerData:${id}`);
    const bubbles = db.prepare(`select json_extract(value, '$.type') as type, json_extract(value, '$.createdAt') as at,
        json_extract(value, '$.tokenCount.inputTokens') as input, json_extract(value, '$.tokenCount.outputTokens') as output,
        json_extract(value, '$.toolFormerData') is not null as tool,
        json_extract(value, '$.toolFormerData.name') as toolName, json_extract(value, '$.toolFormerData.toolCallId') as callId,
        json_extract(value, '$.toolFormerData.status') as status, json_extract(value, '$.toolFormerData.userDecision') as decision,
        json_extract(value, '$.toolFormerData.additionalData.status') as outcome,
        json_extract(json_extract(value, '$.toolFormerData.params'), '$.command') as command,
        json_extract(json_extract(value, '$.toolFormerData.result'), '$.exitCode') as exitCode,
        json_extract(json_extract(value, '$.toolFormerData.result'), '$.rejected') as rejected,
        json_extract(json_extract(value, '$.toolFormerData.result'), '$.backgroundShellId') is not null as background,
        json_type(json_extract(value, '$.toolFormerData.result'), '$.output') = 'text' as hasOutput,
        (select json_group_array(json_extract(todo.value, '$.status')) from json_each(json_extract(cursorDiskKV.value, '$.toolFormerData.result'), '$.finalTodos') as todo) as todoStatuses
      from cursorDiskKV where key > ? and key < ? and json_extract(value, '$.createdAt') is not null`).all(`bubbleId:${id}:`, `bubbleId:${id};`);
    const model = cleanModel(chat?.model);
    const lines = [];
    let pending = null;
    for (const bubble of bubbles.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
      const timestamp = isoOf(bubble.at); if (!timestamp) continue;
      if (pending) { lines.push({ ...pending, timestamp }); pending = null; }
      if (Number(bubble.type) === 1) lines.push({ type: "user", timestamp, message: { content: [{ type: "text" }] } });
      else if (Number(bubble.type) === 2) {
        const usage = Number(bubble.input) || Number(bubble.output) ? { usage: { input_tokens: Number(bubble.input) || 0, output_tokens: Number(bubble.output) || 0 } } : {};
        const call = bubble.tool ? cursorCall(bubble) : null;
        lines.push({ type: "assistant", timestamp, message: { model, ...usage, content: call ? [call.use] : [] } });
        // THE CALL'S RESULT (0.8.5) lands at the NEXT bubble's moment: the gap after a call stays tool time and no gap is
        // added, so the stretch's seconds and layers are exactly as before; a call that ends the session closes on its own moment.
        if (call) pending = { type: "user", timestamp, message: { content: [call.result] } };
      }
    }
    if (pending) lines.push(pending);
    return lines;
  } catch { return null; } finally { db.close(); }
}
// ── end cursor session reader ──

// ── copilot session reader ──
/**
 * GITHUB COPILOT IN VS CODE (2026-10-06). VS Code keeps each Copilot chat as a file: `chatSessions/<id>.jsonl` under
 * every workspace's storage (`User/workspaceStorage/<hash>/`, its folder in `workspace.json`) and, for a window with no
 * folder, under `User/globalStorage/emptyWindowChatSessions/`. A .jsonl file is a log of edits (kind 0 the whole
 * session, 1 a value set at a path, 2 items appended at a path); an older .json file is the session whole. Each
 * request is read for its clocks and counts only: when it was asked (`timestamp`, the person's turn) and when the
 * model finished (`modelState.completedAt`), the model it resolved to and the prompt and output tokens. The messages,
 * the responses and the tool calls' text are parsed with the file and never kept. Agent mode runs a request's tools
 * between those two clocks without stamping each step, so under the same rule as every other client that span counts
 * up to the idle cap, as one gap, in `seconds`; in the layers it is the agent's run, whole (the assistant line says `agentic`).
 */
export function copilotHomes(given) { return given ? [given.replace(/^~(?=\/|$)/, homedir())] : [...userDirs("Code"), ...userDirs("Code - Insiders")]; }
export function* copilotSessions(homes) {
  for (const home of homes) {
    const places = [];
    try { for (const dir of readdirSync(join(home, "workspaceStorage"))) places.push({ dir: join(home, "workspaceStorage", dir, "chatSessions"), workspace: join(home, "workspaceStorage", dir, "workspace.json") }); } catch { /* none */ }
    places.push({ dir: join(home, "globalStorage", "emptyWindowChatSessions"), workspace: null });
    for (const place of places) {
      let names = []; try { names = readdirSync(place.dir); } catch { continue; }
      let cwd = null; if (place.workspace) { try { cwd = folderOf(JSON.parse(readFileSync(place.workspace, "utf8")).folder); } catch { /* none */ } }
      for (const name of names) {
        const id = name.replace(/\.jsonl?$/, "");
        if (!/\.jsonl?$/.test(name) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) continue;
        let writtenAt = 0; try { writtenAt = statSync(join(place.dir, name)).mtimeMs; } catch { continue; }
        yield { sessionId: id, file: `copilot:${join(place.dir, name)}#${id}`, cwd, writtenAt };
      }
    }
  }
}
/** A session file back into the session: the whole object, or the edit log replayed. */
function copilotSession(text, jsonl) {
  if (!jsonl) return JSON.parse(text);
  let session = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let edit; try { edit = JSON.parse(raw); } catch { continue; }
    if (edit.kind === 0) { session = edit.v; continue; }
    if (!session || !Array.isArray(edit.k) || edit.k.length === 0) continue;
    const parent = edit.k.slice(0, -1).reduce((at, key) => (at == null ? at : at[key]), session);
    const key = edit.k.at(-1);
    if (parent == null || typeof parent !== "object") continue;
    if (edit.kind === 1) parent[key] = edit.v;
    else if (edit.kind === 2) { if (!Array.isArray(parent[key])) parent[key] = []; parent[key].push(...(Array.isArray(edit.v) ? edit.v : [edit.v])); }
  }
  return session;
}
export function copilotLines(pseudo) {
  const { file } = splitSession(pseudo);
  let session; try { session = copilotSession(readFileSync(file, "utf8"), file.endsWith(".jsonl")); } catch { return null; }
  const lines = [];
  for (const request of Array.isArray(session?.requests) ? session.requests : []) {
    const asked = Number(request?.timestamp);
    if (!Number.isFinite(asked) || asked <= 0) continue;
    lines.push({ type: "user", timestamp: new Date(asked).toISOString(), message: { content: [{ type: "text" }] } });
    const done = Number(request?.modelState?.completedAt) || (Number(request?.result?.timings?.totalElapsed) ? asked + Number(request.result.timings.totalElapsed) : 0);
    if (!done || done < asked) continue;
    const meta = request?.result?.metadata ?? {};
    const usage = Number(meta.promptTokens) || Number(meta.outputTokens) ? { usage: { input_tokens: Number(meta.promptTokens) || 0, output_tokens: Number(meta.outputTokens) || 0 } } : {};
    // `agentic` (owner, 2026-10-06): the request's own run, asked → completed, is the agent's time; the hook files that gap as tool time, uncapped.
    // THE REQUEST'S TOOL CALLS (0.8.5), all at the moment it was asked: no gap is added, so its seconds and layers are as before.
    for (const part of Array.isArray(request?.response) ? request.response : []) {
      const call = part && part.kind === "toolInvocationSerialized" ? copilotCall(part) : null;
      if (!call) continue;
      lines.push({ type: "assistant", timestamp: new Date(asked).toISOString(), message: { content: [call.use] } });
      lines.push({ type: "user", timestamp: new Date(asked).toISOString(), message: { content: [call.result] } });
    }
    lines.push({ type: "assistant", timestamp: new Date(done).toISOString(), agentic: true, message: { model: cleanModel(String(meta.resolvedModel ?? request?.modelId ?? "").replace(/^copilot\//, "")), ...usage, content: [] } });
  }
  return lines;
}
// ── end copilot session reader ──

// ── database clients ──
/** The clients whose sessions live in a database, one registry: the hook and the counter ask it, not each client. */
const DATABASE_CLIENTS = {
  hermes: { homes: hermesHomes, sessions: hermesSessions, lines: hermesLines },
  goose: { homes: gooseHomes, sessions: gooseSessions, lines: gooseLines },
  opencode: { homes: opencodeHomes, sessions: opencodeSessions, lines: opencodeLines },
  openclaw: { homes: openclawHomes, sessions: openclawSessions, lines: openclawLines },
  cursor: { homes: cursorHomes, sessions: cursorSessions, lines: cursorLines },
  copilot: { homes: copilotHomes, sessions: copilotSessions, lines: copilotLines },
};
export const DATABASE_SESSION = new RegExp(`^(${Object.keys(DATABASE_CLIENTS).join("|")}):.+#[A-Za-z0-9_.:-]{1,120}$`);
/** Every attended session of every database client; `given` names a client's own home (a test), `onlyGiven` reads no other. */
export function* databaseSessions(given = {}, onlyGiven = false) {
  for (const [client, reader] of Object.entries(DATABASE_CLIENTS)) {
    const homes = given[client] ? reader.homes(given[client]) : onlyGiven ? [] : reader.homes();
    for (const session of reader.sessions(homes)) yield { client, ...session };
  }
}
export const databaseLines = (pseudo) => DATABASE_CLIENTS[pseudo.slice(0, pseudo.indexOf(":"))]?.lines(pseudo) ?? null;
// ── end database clients ──
