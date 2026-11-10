/**
 * LOCAL MODELS, READ WHERE THEIR CHATS ARE KEPT (owner, 2026-11-09: "local models through Ollama with Qwen 3, measure those
 * hours on the passport"). A model used through OpenCode, Goose, Hermes or OpenClaw is already read with that client's
 * session (session-databases.mjs). Used DIRECTLY, a local model leaves its chats in two stores:
 *
 *   · the Ollama app (ollama/ollama app/store/database.go and internal/onboarding/app_state.go, read 2026-11-09): one SQLite
 *     file, `db.sqlite` under ~/Library/Application Support/Ollama (macOS) or %LOCALAPPDATA%\Ollama (Windows); Linux has no
 *     desktop app. `chats` (one per conversation) and `messages` (role, model_name, created_at and updated_at as Go writes a
 *     time). It keeps NO token counts: the lines carry none, never an estimate from the text.
 *   · Open WebUI (open-webui/open-webui backend/open_webui/models/chats.py, chat_messages.py and env.py): `webui.db` under its
 *     DATA_DIR. Since the `chat_message` table, one row per message with role, model_id, created_at (seconds) and a `usage`
 *     JSON normalised to input_tokens / output_tokens (Ollama's prompt_eval_count / eval_count and OpenAI's names read as
 *     fallbacks, as Open WebUI's own reader does); before it, the messages inside `chat.chat` under history.messages.
 *     Open WebUI is a server for several accounts: a database that holds more than one account is NOT read (whose chats
 *     they are cannot be told from here), and the counter says so.
 *
 * Each query selects roles, clocks, model ids and token counts and NO text column: never a title, a message, its thinking,
 * a tool call's arguments or result, a file, a URL or a prompt (scripts/test-local-model-readers.mjs holds every query to
 * that and plants text that must appear nowhere). Read through node:sqlite, read-only; a store that is missing is skipped,
 * one that is present and cannot be read (locked, damaged, another schema) is named by `stores`, never a crash.
 *
 * NOT READ: Ollama's server log (~/.ollama/logs/server.log). Its request lines carry a time, a status and a latency, no
 * model and no conversation, and every request a client above already measures appears there too (docs/OPEN.md §0p).
 * NOT VERIFIED on a real install here: the paths and schemas are read from the two projects' source; the tests run on
 * fixtures of that shape.
 */
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { cleanModel } from "./transcript-readers.mjs";

let sqlite;
/** The database read-only, or the reason it is not: `missing` (no file), `unreadable` (present, not openable). */
function openStore(file) {
  try { if (!statSync(file).isFile()) return { why: "missing" }; } catch { return { why: "missing" }; }
  if (sqlite === undefined) {
    const warn = process.emitWarning; // node:sqlite says it is experimental on some versions: not the person's business in a hook
    try { process.emitWarning = () => {}; sqlite = createRequire(import.meta.url)("node:sqlite"); } catch { sqlite = null; } finally { process.emitWarning = warn; }
  }
  if (!sqlite) return { why: "no_sqlite" };
  try { return { db: new sqlite.DatabaseSync(file, { readOnly: true, timeout: 250 }) }; } catch { return { why: "unreadable" }; }
}
const splitSession = (pseudo) => { const at = pseudo.lastIndexOf("#"); return { file: pseudo.slice(pseudo.indexOf(":") + 1, at), id: pseudo.slice(at + 1) }; };
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const hasTable = (db, name) => Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
/** A clock as SQLite holds it, as milliseconds: Go's text time through julianday inside SQLite, epoch seconds or ms as they are. */
const CLOCK = (column) => `case when typeof(${column}) in ('integer', 'real') then ${column} else (julianday(${column}) - 2440587.5) * 86400000.0 end`;
const msOf = (value) => { const n = Number(value); return value === null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n > 1e11 ? n : n * 1000); };
const isoOf = (value) => { const ms = msOf(value); return ms === null ? null : new Date(ms).toISOString(); };
const count = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Math.round(Number(value)));
const user = (timestamp) => ({ type: "user", timestamp, message: { content: [{ type: "text" }] } });
const toolResult = (timestamp) => ({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] } });

// ── ollama app session reader ──
export function ollamaHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  if (platform() === "darwin") return [join(homedir(), "Library", "Application Support", "Ollama")];
  if (platform() === "win32" && process.env.LOCALAPPDATA) return [join(process.env.LOCALAPPDATA, "Ollama")];
  return [];
}
const OLLAMA_SESSIONS = `select c.id as id, max(${CLOCK("coalesce(m.updated_at, m.created_at)")}) as last from chats c join messages m on m.chat_id = c.id group by c.id order by c.id`;
export function* ollamaSessions(homes) {
  for (const home of homes) {
    const file = join(home, "db.sqlite"), { db } = openStore(file);
    if (!db) continue;
    try {
      for (const row of db.prepare(OLLAMA_SESSIONS).all()) if (SESSION_ID.test(String(row.id))) yield { sessionId: String(row.id), file: `ollama:${file}#${row.id}`, cwd: null, writtenAt: msOf(row.last) ?? 0 };
    } catch { /* locked or another schema: named by ollamaStores */ } finally { db.close(); }
  }
}
/** One chat → lines in Claude Code's shape: the person's turns, the model's answers at the moment each was finished, tool results. No text, no tokens (none kept). */
export function ollamaLines(pseudo) {
  const { file, id } = splitSession(pseudo), { db } = openStore(file);
  if (!db) return null;
  try {
    const rows = db.prepare(`select role, ${CLOCK("created_at")} as asked, ${CLOCK("coalesce(updated_at, created_at)")} as done, model_name as model from messages where chat_id = ? order by created_at, id`).all(id);
    const lines = [{ type: "meta", steered: "desk" }]; // the desktop app, at the computer
    for (const row of rows) {
      if (row.role === "user") { const at = isoOf(row.asked); if (at) lines.push(user(at)); continue; }
      if (row.role === "tool") { const at = isoOf(row.asked); if (at) lines.push(toolResult(at)); continue; }
      if (row.role !== "assistant") continue;
      const at = isoOf(row.done); if (at) lines.push({ type: "assistant", timestamp: at, message: { model: cleanModel(row.model), content: [] } });
    }
    return lines;
  } catch { return null; } finally { db.close(); }
}
export function ollamaStores(homes) {
  return homes.map((home) => {
    const opened = openStore(join(home, "db.sqlite"));
    if (!opened.db) return opened.why === "missing" ? null : { client: "ollama", state: opened.why };
    try { return hasTable(opened.db, "chats") && hasTable(opened.db, "messages") ? { client: "ollama", state: "read", chats: Number(opened.db.prepare("select count(*) as n from chats").get().n) || 0 } : { client: "ollama", state: "unknown_schema" }; }
    catch { return { client: "ollama", state: "unreadable" }; } finally { opened.db.close(); }
  }).filter(Boolean);
}
// ── end ollama app session reader ──

// ── open-webui session reader ──
/** Where Open WebUI keeps webui.db: DATA_DIR, and the package's own data folder in a uv tool or pipx install (`open_webui/data`). */
export function openWebuiHomes(given) {
  if (given) return [given.replace(/^~(?=\/|$)/, homedir())];
  const homes = process.env.DATA_DIR ? [process.env.DATA_DIR] : [];
  for (const venv of [join(homedir(), ".local", "share", "uv", "tools", "open-webui"), join(homedir(), ".local", "pipx", "venvs", "open-webui"), join(homedir(), ".local", "share", "pipx", "venvs", "open-webui")]) {
    let pythons = []; try { pythons = readdirSync(join(venv, "lib")).filter((name) => /^python3\.\d+$/.test(name)).sort(); } catch { continue; }
    for (const python of pythons) homes.push(join(venv, "lib", python, "site-packages", "open_webui", "data"));
  }
  return homes;
}
const accountsOf = (db) => (hasTable(db, "user") ? Number(db.prepare('select count(*) as n from "user"').get().n) || 0 : 0);
const USAGE = (...keys) => `case when json_valid(usage) then ${keys.length > 1 ? `coalesce(${keys.map((k) => `json_extract(usage, '$.${k}')`).join(", ")})` : `json_extract(usage, '$.${keys[0]}')`} end`;
const HISTORY = (key) => `json_extract(m.value, '$.${key}')`;
export function* openWebuiSessions(homes) {
  for (const home of homes) {
    const file = join(home, "webui.db"), { db } = openStore(file);
    if (!db) continue;
    try {
      if (accountsOf(db) > 1) continue; // several accounts: whose chat is whose is not this computer's to say
      const rows = hasTable(db, "chat_message") ? db.prepare("select chat_id as id, max(created_at) as last from chat_message group by chat_id order by chat_id").all() : db.prepare("select id, updated_at as last from chat order by id").all();
      for (const row of rows) if (SESSION_ID.test(String(row.id))) yield { sessionId: String(row.id), file: `open-webui:${file}#${row.id}`, cwd: null, writtenAt: msOf(row.last) ?? 0 };
    } catch { /* locked or another schema: named by openWebuiStores */ } finally { db.close(); }
  }
}
/** One chat → lines: every message of every branch at its own clock (a regenerated answer was produced, and waited for), the model, the tokens Open WebUI kept. */
export function openWebuiLines(pseudo) {
  const { file, id } = splitSession(pseudo), { db } = openStore(file);
  if (!db) return null;
  try {
    if (accountsOf(db) > 1) return [];
    const rows = hasTable(db, "chat_message")
      ? db.prepare(`select role, created_at as at, model_id as model, ${USAGE("input_tokens", "prompt_tokens", "prompt_eval_count")} as input, ${USAGE("output_tokens", "completion_tokens", "eval_count")} as output, ${USAGE("cache_read_input_tokens")} as cache_read
          from chat_message where chat_id = ? order by created_at, id`).all(id)
      : db.prepare(`select ${HISTORY("role")} as role, ${HISTORY("timestamp")} as at, ${HISTORY("model")} as model,
          coalesce(${HISTORY("usage.input_tokens")}, ${HISTORY("usage.prompt_tokens")}, ${HISTORY("usage.prompt_eval_count")}, ${HISTORY("info.prompt_eval_count")}) as input,
          coalesce(${HISTORY("usage.output_tokens")}, ${HISTORY("usage.completion_tokens")}, ${HISTORY("usage.eval_count")}, ${HISTORY("info.eval_count")}) as output, ${HISTORY("usage.cache_read_input_tokens")} as cache_read
          from chat c, json_each(c.chat, '$.history.messages') m where c.id = ? and json_valid(c.chat) order by ${HISTORY("timestamp")}`).all(id);
    const lines = [{ type: "meta" }]; // a browser on this computer or on a phone in the same network look alike here: not said
    for (const row of rows) {
      const at = isoOf(row.at); if (!at) continue;
      if (row.role === "user") { lines.push(user(at)); continue; }
      if (row.role !== "assistant") continue;
      const input = count(row.input), output = count(row.output), cacheRead = count(row.cache_read);
      const usage = input !== null || output !== null ? { usage: { input_tokens: Math.max(0, (input ?? 0) - (cacheRead ?? 0)), output_tokens: output ?? 0, cache_read_input_tokens: cacheRead ?? 0, cache_creation_input_tokens: 0 } } : {};
      lines.push({ type: "assistant", timestamp: at, message: { model: cleanModel(row.model), ...usage, content: [] } });
    }
    return lines;
  } catch { return null; } finally { db.close(); }
}
export function openWebuiStores(homes) {
  return homes.map((home) => {
    const opened = openStore(join(home, "webui.db"));
    if (!opened.db) return opened.why === "missing" ? null : { client: "open-webui", state: opened.why };
    try {
      if (!hasTable(opened.db, "chat")) return { client: "open-webui", state: "unknown_schema" };
      if (accountsOf(opened.db) > 1) return { client: "open-webui", state: "several_accounts" };
      return { client: "open-webui", state: "read", chats: Number(opened.db.prepare("select count(*) as n from chat").get().n) || 0 };
    } catch { return { client: "open-webui", state: "unreadable" }; } finally { opened.db.close(); }
  }).filter(Boolean);
}
// ── end open-webui session reader ──

/** The registry entries session-databases.mjs takes in: the same shape as its own clients, and a store report beside. */
export const LOCAL_MODEL_CLIENTS = {
  ollama: { homes: ollamaHomes, sessions: ollamaSessions, lines: ollamaLines, stores: ollamaStores },
  "open-webui": { homes: openWebuiHomes, sessions: openWebuiSessions, lines: openWebuiLines, stores: openWebuiStores },
};
