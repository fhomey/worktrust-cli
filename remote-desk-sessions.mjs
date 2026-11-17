/**
 * CONTINUE A SESSION ON THIS COMPUTER (release 36, owner 2026-11-15: "via the remote link, get into the current session, so
 * we don't have to scan tomorrow"; docs/remote-agents/DESK-SESSIONS.md). The phone or the browser lists this computer's
 * recent Claude Code sessions and continues one through the daemon's own start (`agent.start` with `resume`).
 *
 * WHAT IS READ: Claude Code's own transcript store, `~/.claude/projects/<the folder, encoded>/<session uuid>.jsonl`, and only
 * the folders of GRANTED projects (the inventory's own list, roots' projects included): the encoded folder of each granted
 * path is opened, never the store as a whole, and a transcript whose recorded `cwd` is not that project's path is dropped.
 * Of a file only its first and last 64 KB are read, for the working folder, a title and the model.
 *
 * WHAT IS SENT, sealed in device.inventory and only to a phone that asked `desk_sessions` (remote-daemon.mjs): per session
 * its uuid, its project's id, the last activity time, a title (Claude Code's own name or summary line when the transcript
 * has one, else the first line the person typed, cut to 80 characters) and the model when one is recorded. Never more of the
 * transcript. The last 20 by activity; sessions the remote already runs or ran (its journal) are its own rows.
 *
 * ONE OWNER PER CONVERSATION: a resume is refused (`in_use`) while the session is held on the computer: its transcript was
 * written in the last 30 seconds, a Claude Code process names its id (`--resume <id>`, `--session-id <id>`), or a Claude
 * Code process that names no session (an open interactive window, `--continue`) works in that project folder and started
 * before the transcript's last line. A computer whose processes cannot be read counts as holding it (fails closed).
 */
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";

export const HELD_WINDOW_MS = 30_000;
const SLICE = 64 * 1024;
const MAX_READS = 60; // transcripts opened per listing at most, newest first
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Claude Code's name for a project's folder in its store: every character that is not a letter or a digit becomes "-". */
export const encodeProjectDir = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
const real = (path) => { try { return realpathSync(path); } catch { return path; } };
export const samePath = (a, b) => typeof a === "string" && typeof b === "string" && (a === b || real(a) === real(b));

/** The first and the last 64 KB of a file, as whole JSON lines (a line cut at a slice's edge is left out). */
function headAndTail(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (at, length) => { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, at); return buf.subarray(0, n).toString("utf8"); };
    const head = read(0, Math.min(size, SLICE));
    const tail = size > SLICE ? read(Math.max(SLICE, size - SLICE), Math.min(SLICE, size - SLICE)) : "";
    const lines = (text, cutFirst, cutLast) => { const all = text.split("\n"); if (cutFirst) all.shift(); if (cutLast) all.pop(); return all; };
    const parse = (all) => all.map((l) => { try { const v = JSON.parse(l); return v && typeof v === "object" ? v : null; } catch { return null; } }).filter(Boolean);
    return { head: parse(lines(head, false, size > SLICE)), tail: parse(lines(tail, true, false)) };
  } finally { closeSync(fd); }
}

const oneLine = (text) => text.replace(/\s+/g, " ").trim();
const cut = (text, max) => { const t = oneLine(text); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
/** The words of a person's own message: a string, or its text blocks; never a tool result, a command's output or a caveat. */
function typed(line) {
  if (line.type !== "user" || line.isMeta === true || line.isSidechain === true || line.message?.role !== "user") return null;
  const c = line.message.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && c.every((b) => b?.type === "text") ? c.map((b) => b.text ?? "").join(" ") : null;
  if (!text || /^\s*<(command-|local-command-|bash-|system-reminder)/.test(text) || /^\s*Caveat:/.test(text)) return null;
  return oneLine(text) || null;
}

/** What one transcript tells: its working folder, a title and the model. Nothing else is kept. */
export function transcriptFacts(file) {
  const { head, tail } = headAndTail(file);
  const all = [...head, ...tail];
  const cwd = head.find((l) => typeof l.cwd === "string")?.cwd ?? null;
  const named = all.filter((l) => l.type === "custom-title" && typeof l.customTitle === "string").at(-1)?.customTitle
    ?? all.filter((l) => l.type === "summary" && typeof l.summary === "string").at(-1)?.summary ?? null;
  const first = head.map(typed).find(Boolean) ?? null;
  const title = named && oneLine(named) ? cut(named, P.MAX_DESK_TITLE) : first ? cut(first, P.MAX_DESK_TITLE) : null;
  const models = all.filter((l) => l.type === "assistant" && typeof l.message?.model === "string" && /^[A-Za-z0-9._:@\[\]-]{1,128}$/.test(l.message.model) && l.message.model !== "<synthetic>");
  return { cwd, title, model: models.at(-1)?.message.model ?? null };
}

/**
 * The newest Claude Code sessions of the granted projects, at most MAX_DESK_SESSIONS: `{ session_ref, project_id,
 * last_activity_at, title, model }` plus, kept on this computer, the transcript's file and the project's path.
 * `exclude`: the agent ids the remote's own journal holds. `cache`: facts by file, size and time, so a listing rereads none.
 */
export function deskSessions({ home = homedir(), projects, exclude = new Set(), cache = new Map() }) {
  const store = join(home, ".claude", "projects"), found = [];
  for (const project of projects) {
    const dir = join(store, encodeProjectDir(project.path));
    let names = [];
    try { if (!lstatSync(dir).isDirectory()) continue; names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const ref = name.endsWith(".jsonl") ? name.slice(0, -6) : null;
      if (!ref || !UUID.test(ref) || exclude.has(ref)) continue;
      try { const st = lstatSync(join(dir, name)); if (st.isFile()) found.push({ ref, file: join(dir, name), project, mtime: Math.floor(st.mtimeMs), size: st.size }); } catch { /* gone */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out = [], seen = new Set();
  for (const f of found.slice(0, MAX_READS)) {
    if (out.length >= P.MAX_DESK_SESSIONS) break;
    if (seen.has(f.ref)) continue; // two granted paths, one folder
    const key = `${f.file}|${f.size}|${f.mtime}`;
    let facts = cache.get(key);
    if (!facts) { try { facts = transcriptFacts(f.file); } catch { continue; } cache.set(key, facts); }
    if (!samePath(facts.cwd, f.project.path)) continue; // another folder whose name encodes the same: not this project
    seen.add(f.ref);
    out.push({ session_ref: f.ref, project_id: f.project.project_id, last_activity_at: f.mtime, title: facts.title, model: facts.model, file: f.file, projectPath: f.project.path });
  }
  if (cache.size > 200) for (const k of [...cache.keys()].slice(0, cache.size - 200)) cache.delete(k);
  return out;
}

/** What leaves the computer, field by field: never the file or the path. */
export const deskRow = (d) => ({ session_ref: d.session_ref, project_id: d.project_id, last_activity_at: d.last_activity_at, title: d.title, model: d.model });

/** "[[dd-]hh:]mm:ss" from ps, in milliseconds. */
export function elapsedMs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000 : null;
}

const CLAUDE_BIN = /(^|[/\\])claude(\.exe)?$/i;
/** Whether a command line is Claude Code: its `claude` program, its npm package, or a native build in its versions folder. */
export const isClaudeCommand = (args) => {
  const first = String(args).trim().split(/\s+/)[0] ?? "";
  return CLAUDE_BIN.test(first) || /@anthropic-ai[/\\]claude-code[/\\]/.test(args) || /[/\\]claude[/\\]versions[/\\][^\s/\\]+(\s|$)/.test(args);
};
/** One process as the held rule reads it: the session ids its command line names, whether it continues the newest one. */
export const processOf = (pid, args, startedAt, cwd) => ({ pid, startedAt, cwd, ids: [...new Set((String(args).match(UUIDS) ?? []).map((u) => u.toLowerCase()))], continues: /(^|\s)(-c|--continue)(\s|$)/.test(args) });

/**
 * The Claude Code processes running on this computer, or null when they cannot be read. Fixed arguments, no shell: `ps`
 * (and the working folder from /proc on Linux, `lsof` on macOS). Windows has no process list without a shell, so there the
 * answer is null: nothing can be shown free, and the desk lists nothing (createDesk).
 */
export function claudeProcesses({ platform = process.platform, now = Date.now(), run = spawnSync } = {}) {
  if (platform === "win32") return null;
  const output = (file, args) => { const r = run(file, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024, windowsHide: true }); return r.status === 0 ? `${r.stdout ?? ""}` : null; };
  const out = output("ps", ["axww", "-o", "pid=,etime=,args="]);
  if (out === null) return null;
  const procs = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !isClaudeCommand(m[3])) continue;
    const age = elapsedMs(m[2]);
    procs.push(processOf(Number(m[1]), m[3], age === null ? 0 : now - age, null));
  }
  if (procs.length === 0) return procs;
  if (platform === "linux") for (const p of procs) { try { p.cwd = readlinkSync(`/proc/${p.pid}/cwd`); } catch { /* not ours to read: unknown */ } }
  else {
    const lsof = output("lsof", ["-a", "-d", "cwd", "-Fn", "-p", procs.map((p) => p.pid).join(",")]);
    let pid = null;
    for (const l of (lsof ?? "").split("\n")) { if (l.startsWith("p")) pid = Number(l.slice(1)); else if (l.startsWith("n") && pid !== null) { const p = procs.find((x) => x.pid === pid); if (p) p.cwd = l.slice(1); } }
  }
  return procs;
}

/** Why a session is held on the computer, or null when it is free to continue here. */
export function heldBy(entry, { now, procs }) {
  if (now - entry.last_activity_at < HELD_WINDOW_MS) return "recent";
  if (procs === null) return "unknown";
  for (const p of procs) {
    if (p.ids.includes(entry.session_ref)) return "process";
    if (p.ids.length === 0 && (p.cwd === null || samePath(p.cwd, entry.projectPath)) && (p.continues || p.startedAt <= entry.last_activity_at)) return "window";
  }
  return null;
}

/**
 * The daemon's desk: `list()` the inventory's rows, `resumable(ref, projectId)` → null, `not_found` (not in this computer's
 * own list, or not under that project) or `in_use` (held). Both read the store afresh; nothing from a phone is trusted.
 */
export function createDesk({ projects, journal, now = Date.now, home = homedir(), processes = () => claudeProcesses(), platform = process.platform }) {
  const cache = new Map();
  const own = () => new Set(journal.sessions().map((j) => j.agent_session_ref).filter((r) => typeof r === "string"));
  const scan = () => deskSessions({ home, projects: projects(), exclude: own(), cache });
  return {
    list: () => (platform === "win32" ? [] : scan().map(deskRow)), // Windows: no process list without a shell, so none is shown free
    /** For the history (remote-history.mjs): the transcript of a session of this list under that project, or null. Kept on this computer. */
    find(ref, projectId) { const d = platform === "win32" || typeof ref !== "string" ? null : scan().find((x) => x.session_ref === ref && x.project_id === projectId); return d ? { file: d.file, projectPath: d.projectPath, last_activity_at: d.last_activity_at } : null; },
    resumable(ref, projectId) {
      const found = typeof ref === "string" ? scan().find((d) => d.session_ref === ref) : null;
      if (!found || found.project_id !== projectId) return "not_found";
      return heldBy(found, { now: now(), procs: processes() }) ? "in_use" : null;
    },
  };
}

/**
 * What a channel hears of the desk (remote-daemon.mjs bodyFor): a phone that asked `desk_sessions` hears all of it; any
 * other never receives the key it would refuse, and a refusal it does not know (`in_use`) reaches it as `busy`.
 */
export function deskBodyFor(asked, type, body) {
  if (asked) return body;
  if (type === "device.inventory" && body && "desk_sessions" in body) { const { desk_sessions: _drop, ...rest } = body; return rest; }
  if (type === "command.rejected" && body?.reason === "in_use") return { ...body, reason: "busy" };
  return body;
}
