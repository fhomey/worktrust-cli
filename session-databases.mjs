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
import { readdirSync, statSync } from "node:fs";
import * as zlib from "node:zlib"; // zstd since Node 22.15; older Node reads OpenClaw's uncompressed rows only
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { cleanModel } from "./transcript-readers.mjs";

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
      const timestamp = new Date(Number(message.timestamp) * 1000).toISOString();
      if (message.role === "user") out.push({ type: "user", timestamp, message: { content: [{ type: "text" }] } });
      else if (message.role === "tool") out.push({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] } });
      else if (message.role === "assistant") out.push({ type: "assistant", timestamp, message: { model, ...(i === lastAssistant ? { usage: { input_tokens: Number(session.input_tokens) || 0, output_tokens: Number(session.output_tokens) || 0, cache_read_input_tokens: Number(session.cache_read_tokens) || 0, cache_creation_input_tokens: Number(session.cache_write_tokens) || 0 } } : {}), content: [] } });
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
    const ledger = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'usage_ledger'").get()
      ? db.prepare("select created_timestamp as at, model, input_tokens as input, output_tokens as output, cache_read_tokens as cache_read, cache_write_tokens as cache_write from usage_ledger where session_id = ? order by created_timestamp, id").all(id)
      : null;
    const fallbackModel = cleanModel(session.model);
    const lines = messages.map((message) => {
      const kinds = new Set(String(message.kinds ?? "").split(","));
      const timestamp = new Date(ms(message.at)).toISOString();
      if (message.role === "user") return { type: "user", timestamp, message: { content: [{ type: kinds.has("toolResponse") ? "tool_result" : kinds.has("text") || kinds.has("image") ? "text" : "tool_result" }] } };
      return { type: "assistant", timestamp, at: ms(message.at), message: { model: fallbackModel, content: [] } };
    });
    const assistants = lines.filter((line) => line.type === "assistant");
    const usageOf = (row) => ({ input_tokens: Number(row.input) || 0, output_tokens: Number(row.output) || 0, cache_read_input_tokens: Number(row.cache_read) || 0, cache_creation_input_tokens: Number(row.cache_write) || 0 });
    const add = (line, usage) => { const was = line.message.usage; line.message.usage = was ? Object.fromEntries(Object.entries(usage).map(([key, n]) => [key, n + (was[key] ?? 0)])) : usage; };
    if (ledger) for (const row of ledger) {
      const at = ms(row.at) + 1000;
      const line = [...assistants].reverse().find((one) => one.at <= at) ?? assistants[0];
      if (!line) continue;
      add(line, usageOf(row));
      if (cleanModel(row.model)) line.message.model = cleanModel(row.model);
    } else if (assistants.length) add(assistants.at(-1), usageOf(session));
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
      const timestamp = new Date(Number(message.at)).toISOString();
      if (message.role === "user") return { type: "user", timestamp, message: { content: [{ type: "text" }] } };
      const counted = message.input !== null || message.output !== null;
      return { type: "assistant", timestamp, message: { model: cleanModel(message.model), ...(counted ? { usage: { input_tokens: Number(message.input) || 0, output_tokens: (Number(message.output) || 0) + (Number(message.reasoning) || 0), cache_read_input_tokens: Number(message.cache_read) || 0, cache_creation_input_tokens: Number(message.cache_write) || 0 } } : {}), content: [] } };
    });
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

// ── database clients ──
/** The clients whose sessions live in a database, one registry: the hook and the counter ask it, not each client. */
const DATABASE_CLIENTS = {
  hermes: { homes: hermesHomes, sessions: hermesSessions, lines: hermesLines },
  goose: { homes: gooseHomes, sessions: gooseSessions, lines: gooseLines },
  opencode: { homes: opencodeHomes, sessions: opencodeSessions, lines: opencodeLines },
  openclaw: { homes: openclawHomes, sessions: openclawSessions, lines: openclawLines },
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
