/**
 * WHAT A DESK SESSION IS DOING, AS FAR AS ITS FILES SAY (CLI 0.11.27; owner, 2026-11-26: "several sessions are busy, but this is
 * not visible at Overview, nor at Remote Agent under Sessions" and "Tasks is empty, while this session has several jobs";
 * docs/remote-agents/DESK-SESSIONS.md §Activity and tasks). Two readings of Claude Code's own transcript of a session in a
 * GRANTED project (the desk list's own, remote-desk-sessions.mjs), never more:
 *
 *   ACTIVITY  `turnOf(lines)` reads the transcript's last lines (the main agent's alone) for whether a turn is open: the
 *             person's words, a tool's result or a background notice wait for the model (`open`), a step waits for its
 *             result (`open`, counted), or the agent answered or was interrupted (`ended`; an answer without its own stop
 *             reason is `maybe`: it may still be written). `deskActivity` then decides ONE state from that, the times the
 *             transcript and the session's own sub-agent transcripts (`<session>/subagents/*.jsonl`) were last written, and
 *             whether a Claude Code process holds the session (remote-desk-sessions.mjs heldBy). Counts and a time only:
 *             sealed in the inventory's desk row for a phone that asked `desk_activity` (protocol desk.ts).
 *   TASKS     `createDeskTasks` keeps, per transcript, Claude Code's own plan as remote-claude-progress.mjs rebuilds it (the
 *             main agent's TaskCreate and TaskUpdate, else its last TodoWrite) and its jobs (the sub-agents it started, the
 *             commands it ran in the background), reading each file forward from where it stopped (at most READ_MAX a
 *             call; a longer file starts at its last READ_MAX and the plan says it is cut). Words the agent wrote, masked
 *             like every desk prose (remote-history-mask.mjs), added ONLY to a desk session's own history page for a phone
 *             that asked `desk_tasks`, while the keyboard lets phones read along (protocol history.ts `tasks`).
 *
 * WHAT IT CANNOT KNOW, and therefore never says: whether a step that waits is a long command or a question at the desk (both
 * are `step_open`); whether a background command ended (Claude Code writes no end for it in the transcript this reads: it is
 * `unknown`, "end not seen"); whether an answer without a stop reason is the last word (it reads as working for at most
 * ACTIVE_MS after it was written). Nothing here is written anywhere; the cache is memory, by file, size and time.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { emptyProgress, isDelegation, progressAssistant, progressUser } from "./remote-claude-progress.mjs";
import { stepOf } from "./remote-claude-events.mjs";
import { maskKeys } from "./remote-history-mask.mjs";

/** Something of the session written this recently is work going on; a quiet open turn counts for an hour; an ended turn waits half an hour. */
export const ACTIVE_MS = 2 * 60_000, STEP_MAX_MS = 60 * 60_000, WAITING_MS = 30 * 60_000;
/** The most of a transcript one task read takes; jobs older than JOB_KEEP_MS that are not running are left out. */
export const READ_MAX = 8 * 1024 * 1024, JOB_KEEP_MS = 60 * 60_000, MAX_SIDE_FILES = 200;
const MAX_TASKS = 50, MAX_JOBS = 20, TITLE = 200;

const INTERRUPTED = /^\s*\[Request interrupted/;
/** A line Claude Code adds that opens no turn: a slash command's echo, its output, a caveat. */
const NO_TURN = /^\s*(<(local-command-|command-name|command-message|command-args)|Caveat:)/;
const STOPPED = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
const mainLine = (l) => l && typeof l === "object" && l.isSidechain !== true && !l.parent_tool_use_id && (l.type === "user" || l.type === "assistant") && l.message && typeof l.message === "object";
const textsOf = (content) => (typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text) : []);

/**
 * WHETHER A TURN IS OPEN, from the transcript's last lines (oldest first). → { turn: open | maybe | ended | unknown, openSteps,
 * openAgents }: the main agent's tool calls whose result is not written yet, and how many of them delegate to a sub-agent.
 */
export function turnOf(lines) {
  const open = new Map();
  let last = null;
  for (const l of lines) {
    if (!mainLine(l) || l.isMeta === true || l.isCompactSummary === true) continue;
    const content = l.message.content;
    if (l.type === "assistant") {
      const blocks = Array.isArray(content) ? content : [];
      const uses = blocks.filter((b) => b?.type === "tool_use" && typeof b.id === "string");
      for (const u of uses) open.set(u.id, String(u.name ?? ""));
      if (uses.length) last = "tool";
      else if (blocks.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())) last = STOPPED.has(l.message.stop_reason) ? "reply" : "maybe";
      else if (blocks.length) last = "model"; // thinking alone: the model is still at it
      continue;
    }
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string");
    for (const r of results) open.delete(r.tool_use_id);
    const words = textsOf(content).join("\n");
    if (INTERRUPTED.test(words) || results.some((r) => textsOf(r.content).some((t) => INTERRUPTED.test(t)))) { last = "interrupted"; open.clear(); continue; }
    if (results.length) { last = "result"; continue; }
    if (!words.trim() && !blocks.length) continue;
    if (NO_TURN.test(words)) continue;
    last = "prompt";
  }
  const turn = last === null ? "unknown" : last === "reply" || last === "interrupted" ? "ended" : last === "maybe" ? "maybe" : "open";
  return { turn, openSteps: open.size, openAgents: [...open.values()].filter(isDelegation).length };
}

/**
 * ONE STATE (protocol desk.ts DESK_ACTIVITY_STATES). `wroteAt` the transcript's last write, `side` the session's sub-agent
 * transcripts' last writes, `held` whether a Claude Code process holds the session (true, false, or null when processes
 * cannot be read: then a quiet open turn is not called work). → { state, since, agents }.
 */
export function deskActivity(facts, { now, wroteAt, side = [], held = null }) {
  const sideAt = side.length ? Math.max(...side) : 0;
  const since = Math.max(wroteAt, sideAt);
  const agents = Math.min(100, side.filter((at) => now - at <= ACTIVE_MS && at - now <= ACTIVE_MS).length);
  const fresh = (at) => now - at <= ACTIVE_MS;
  if (agents > 0) return { state: "working", since, agents };
  if (facts.turn === "open" && fresh(since)) return { state: "working", since, agents };
  if (facts.turn === "maybe" && fresh(wroteAt)) return { state: "working", since, agents };
  if (facts.turn === "open" && held === true && now - since <= STEP_MAX_MS) return { state: "step_open", since, agents };
  if ((facts.turn === "ended" || facts.turn === "maybe") && now - since <= WAITING_MS) return { state: "waiting", since, agents };
  return { state: "idle", since, agents };
}

/** The last writes of a session's own sub-agent transcripts (`<transcript without .jsonl>/subagents/*.jsonl`), newest first, bounded. */
export function sideWrites(file) {
  const dir = join(file.replace(/\.jsonl$/, ""), "subagents");
  let names = [];
  try { if (!lstatSync(dir).isDirectory()) return []; names = readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/.test(n)).slice(0, MAX_SIDE_FILES); } catch { return []; }
  const out = [];
  for (const n of names) { try { const st = lstatSync(join(dir, n)); if (st.isFile()) out.push(Math.floor(st.mtimeMs)); } catch { /* gone */ } }
  return out.sort((a, b) => b - a);
}

const oneLine = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const cut = (t, max) => { const s = oneLine(t); if (s.length <= max) return s; let out = ""; for (const ch of s) { if (out.length + ch.length > max - 1) break; out += ch; } return `${out.trimEnd()}…`; };
/** Words the agent wrote, for the phone: masked before the cut (a key the cut would split is never sent in part), never empty. */
const words = (t) => { const s = cut(maskKeys(oneLine(t)), TITLE); return s || null; };
const timeOf = (line) => { const t = typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : NaN; return Number.isSafeInteger(t) && t >= 0 ? t : null; };

/** A fresh task reading of one transcript: the progress module's state, the background commands seen, and whether the start was skipped. */
const fresh = () => ({ ps: emptyProgress(), minted: 0, commands: new Map(), skipped: false });

/** One line into a task reading (the main agent's lines only, as Claude Code's own screen builds its list). */
export function taskLine(reading, line) {
  if (!mainLine(line) || !Array.isArray(line.message.content)) return reading;
  const now = timeOf(line);
  const mint = (prefix) => { reading.minted += 1; return `${prefix}_desk${reading.minted}`; };
  if (line.type === "assistant") {
    for (const b of line.message.content) if (b?.type === "tool_use" && b.name === "Bash" && b.input?.run_in_background === true && typeof b.id === "string") reading.commands.set(b.id, { label: stepOf("Bash", b.input, "").label, since: now, state: "starting" });
    reading.ps = progressAssistant(reading.ps, line, { now, mint, stepFor: () => null }).state;
    return reading;
  }
  for (const b of line.message.content) if (b?.type === "tool_result" && reading.commands.has(b.tool_use_id)) { const c = reading.commands.get(b.tool_use_id); reading.commands.set(b.tool_use_id, { ...c, state: b.is_error === true ? "failed" : "unknown" }); }
  const text = (b) => textsOf(b.content).join("\n");
  reading.ps = progressUser(reading.ps, { ...line, tool_use_result: line.toolUseResult }, { now, textOf: text }).state;
  return reading;
}

/**
 * WHAT THE PHONE IS SENT (protocol history.ts HistoryTasks): the plan's items and the jobs, newest job first. A sub-agent
 * delegated in the foreground is running until its result is written; one launched in the background is running while a
 * sub-agent transcript of the session was written in the last ACTIVE_MS, else its end is not seen. A background command's
 * end is never seen here. A job neither running nor started within JOB_KEEP_MS is left out.
 */
export function tasksOf(reading, { now, side = [] }) {
  const plan = reading.ps.plan;
  const items = (plan?.items ?? []).slice(0, MAX_TASKS).flatMap((i) => { const title = words(i.label); return title ? [{ title, state: i.state }] : []; });
  const sideFresh = side.some((at) => now - at <= ACTIVE_MS);
  const agents = Object.values(reading.ps.subagents).map((r) => {
    const state = r.state === "done" ? "done" : r.state === "failed" || r.state === "stopped" ? "failed" : r.background ? (sideFresh ? "running" : "unknown") : "running";
    return { label: words(r.label) ?? "Sub-agent", kind: "agent", state, since: r.started_at };
  });
  const commands = [...reading.commands.values()].map((c) => ({ label: words(c.label.replace(/^Run /, "")) ?? "Command", kind: "command", state: c.state === "failed" ? "failed" : c.state === "starting" ? "running" : "unknown", since: c.since }));
  const jobs = [...agents, ...commands].filter((j) => j.state === "running" || (j.since !== null && now - j.since <= JOB_KEEP_MS)).sort((a, b) => (b.since ?? 0) - (a.since ?? 0)).slice(0, MAX_JOBS);
  return { items, cut: (plan?.items_cut ?? false) || (plan?.items?.length ?? 0) > MAX_TASKS || (reading.skipped && reading.ps.partial), jobs };
}

/** Whole JSON lines of a byte range; the bytes after the last newline are left for the next read. */
function linesFrom(fd, from, to) {
  const buf = Buffer.alloc(to - from);
  const n = readSync(fd, buf, 0, buf.length, from);
  const text = buf.subarray(0, n).toString("utf8");
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], used: 0 };
  const lines = text.slice(0, end).split("\n").map((l) => { try { const v = JSON.parse(l); return v && typeof v === "object" ? v : null; } catch { return null; } }).filter(Boolean);
  return { lines, used: Buffer.byteLength(text.slice(0, end + 1), "utf8") };
}

/**
 * THE DESK SESSIONS' TASKS, kept per transcript in memory (`read(file, now)` → HistoryTasks or null when the file cannot be
 * read), and `forPage(body, phone)`: the page with `tasks` added when its phone asked `desk_tasks`, the page is a desk
 * session's own, and the keyboard lets phones read along; any other page leaves unchanged.
 */
export function createDeskTasks({ desk, live = () => false, reads = () => false, now = Date.now, max = READ_MAX } = {}) {
  const cache = new Map();
  function read(file, at = now()) {
    let fd;
    try {
      fd = openSync(file, "r");
      const st = fstatSync(fd);
      let held = cache.get(file);
      if (!held || st.size < held.offset || held.ino !== st.ino) { held = { ino: st.ino, offset: Math.max(0, st.size - max), reading: fresh() }; held.reading.skipped = held.offset > 0; if (held.offset > 0) held.offset = startOfLine(fd, held.offset); }
      while (held.offset < st.size) {
        const to = Math.min(st.size, held.offset + 1024 * 1024);
        const { lines, used } = linesFrom(fd, held.offset, to);
        if (used === 0) break;
        for (const line of lines) held.reading = taskLine(held.reading, line);
        held.offset += used;
      }
      cache.set(file, held);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return tasksOf(held.reading, { now: at, side: sideWrites(file) });
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
  function forPage(body, phone) {
    if (!body || typeof body.session_ref !== "string" || body.item !== undefined || body.parent !== undefined || body.follow?.end !== undefined || !reads(phone) || !live()) return body;
    const found = desk?.find?.(body.session_ref, body.project_id);
    const tasks = found ? read(found.file) : null;
    return tasks ? { ...body, tasks } : body;
  }
  return { read, forPage };
}

/** The first line start at or after `at` (a read that starts mid-file skips the cut line). */
function startOfLine(fd, at) {
  const buf = Buffer.alloc(64 * 1024);
  for (let from = at; ; from += buf.length) {
    const n = readSync(fd, buf, 0, buf.length, from);
    if (n <= 0) return from;
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl >= 0) return from + nl + 1;
  }
}
