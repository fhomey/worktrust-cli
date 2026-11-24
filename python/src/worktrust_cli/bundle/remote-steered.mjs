/**
 * REMOTE-STEERED SESSIONS, MARKED (2026-11-07; owner decision 1, binding: a session steered from a phone is NEVER the
 * person's AI Hours; agent work in it counts only under the existing headless rules).
 *
 * The daemon (`worktrust remote`) writes one record per agent session it started or steered to
 * ~/.worktrust/remote/steered.jsonl (mode 0600), the protocol's STEERED_RECORD_SPEC as canonical JSON, BEFORE the agent
 * runs: it chooses Claude Code's session id itself (--session-id) or resumes a known one, so the ledger names the session
 * before its first line is written. The measurement readers (log-session.mjs) ask `steeredTurnsOf(file, messages, isPrompt)`
 * for each day of each session they read (CLI 0.11.23; owner, 2026-11-23): only the STEERED TURNS (a prompt inside a steered
 * window, and the agent work answering it until the next prompt typed at the desk) are measured as a headless session and
 * sent with steered_from "remote", so none of their seconds is the person's; the rest of that session's day stays the
 * person's own work. Until 0.11.23 one message inside a window made the WHOLE day steered (`remoteSteeredOf`, kept for a
 * client whose running totals cannot be cut per turn), so the person's own typing in a desk session steered once that day
 * counted as steered.
 *
 * Self-contained on purpose: the session hook imports it on every run, and a measurement that fails open because a
 * larger module did not load would count remote work as a person's. scripts/test-remote-steered-hours.mjs holds this
 * reader to the protocol's validateSteeredRecord, line for line, and proves the hours rule end to end.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync, constants, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const steeredFile = () => join(homedir(), ".worktrust", "remote", "steered.jsonl");
const ADAPTERS = new Set(["claude-code", "codex", "cursor-agent", "opencode", "local"]);
const REF = /^[A-Za-z0-9._:-]{1,256}$/;
const ID = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`);
const KEYS = "adapter,agent_session_ref,first_steered_at,how,last_steered_at,project_id,remote_session_id,steered,v";
const time = (n) => Number.isSafeInteger(n) && n >= 0;
/** A message's time may lead or trail the daemon's own stamps by this much and still be the steered run. */
export const STEERED_SLACK_MS = 5 * 60_000;
/**
 * A PROMPT is the steered turn's when it lies this close to a window (CLI 0.11.23): the daemon stamps the window as it hands the
 * words over (`submitted`, a session's start) and widens it at the turn's end, and the client writes the prompt's line within
 * seconds on the same clock. A prompt typed at the desk a minute or more after a steered turn ended is the person's.
 */
export const STEERED_PROMPT_SLACK_MS = 60_000;

/** The protocol's validateSteeredRecord, without the protocol module (held equal by the test). */
export function steeredRecordOk(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join(",") !== KEYS) return false;
  return r.v === 1 && r.steered === "remote" && ADAPTERS.has(r.adapter) && typeof r.agent_session_ref === "string" && REF.test(r.agent_session_ref)
    && ID("ses").test(r.remote_session_id) && (r.project_id === null || ID("prj").test(r.project_id)) && (r.how === "started" || r.how === "attached")
    && time(r.first_steered_at) && time(r.last_steered_at) && r.last_steered_at >= r.first_steered_at;
}

const PIPELINE_KEYS = "agent,ended_at,pipeline_run_id,project_id,release_id,started_at,steered,v";
/**
 * A pipeline run (2026-11-07): `steered: "pipeline"`, `agent: false`. Builds, tests and scanners the daemon ran for a
 * release, never agent work and never hours; the reader knows it and skips it (the protocol's validatePipelineLedgerRecord,
 * held equal by the test).
 */
export function pipelineRecordOk(r) {
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join(",") !== PIPELINE_KEYS) return false;
  return r.v === 1 && r.steered === "pipeline" && r.agent === false && ID("plr").test(r.pipeline_run_id) && (r.release_id === null || ID("rel").test(r.release_id))
    && (r.project_id === null || ID("prj").test(r.project_id)) && time(r.started_at) && (r.ended_at === null || (time(r.ended_at) && r.ended_at >= r.started_at));
}

/** Canonical JSON for a flat record of strings, integers and null: keys sorted, no whitespace. */
const canonical = (r) => `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(r[k])}`).join(",")}}`;

/**
 * Every valid record by agent_session_ref: the widest span (as before) and, since the review of 2026-11-21 (P2-3), its
 * WINDOWS: records of one session that overlap (the same turn marked at its start and again at its end, a remote session
 * marked as it goes) are one window; records apart stay apart. A desk session steered from the phone on Monday morning
 * and Wednesday evening is two windows, so Tuesday's own typing in it is the person's. Unreadable lines counted, never fatal.
 */
export function readSteered(file = steeredFile()) {
  const byRef = new Map();
  let unreadable = 0, pipelines = 0;
  let text = "";
  try { if (existsSync(file) && !lstatSync(file).isSymbolicLink()) text = readFileSync(file, "utf8"); } catch { text = ""; }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record = null;
    try { record = JSON.parse(line); } catch { record = null; }
    if (pipelineRecordOk(record)) { pipelines += 1; continue; } // not agent work: no session for a reader to match
    if (!steeredRecordOk(record)) { unreadable += 1; continue; }
    const prior = byRef.get(record.agent_session_ref);
    const windows = [...(prior?.windows ?? []), { first_steered_at: record.first_steered_at, last_steered_at: record.last_steered_at }];
    byRef.set(record.agent_session_ref, prior
      ? { ...record, first_steered_at: Math.min(prior.first_steered_at, record.first_steered_at), last_steered_at: Math.max(prior.last_steered_at, record.last_steered_at), windows }
      : { ...record, windows });
  }
  for (const record of byRef.values()) record.windows = mergeWindows(record.windows);
  return { byRef, unreadable, pipelines };
}

/** Windows that overlap (or touch) become one, the earliest start and the latest end; apart they stay apart. */
function mergeWindows(windows) {
  const out = [];
  for (const w of [...windows].sort((a, b) => a.first_steered_at - b.first_steered_at)) {
    const last = out.at(-1);
    if (last && w.first_steered_at <= last.last_steered_at) last.last_steered_at = Math.max(last.last_steered_at, w.last_steered_at);
    else out.push({ ...w });
  }
  return out;
}

/** The daemon's write: one canonical line, appended and flushed to disk before the agent is started. */
export function appendSteered(record, file = steeredFile()) {
  if (!steeredRecordOk(record)) throw new TypeError("not a steered record");
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, `${canonical(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

/** A pipeline run's mark (remote-pipeline.mjs), written at its start and again at its end. */
export function appendPipelineMark(record, file = steeredFile()) {
  if (!pipelineRecordOk(record)) throw new TypeError("not a pipeline record");
  const dir = join(file, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, `${canonical(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The agent's own session id a reader file names: Claude Code's <uuid>.jsonl, a Codex rollout's trailing uuid, a database
 * session's id (`<client>:<database>#<session id>`, session-databases.mjs: the part after the last `#`; 2026-11-09, before
 * which an OpenCode session steered from a phone named no ref and was measured as the person's).
 */
export function sessionRefsOf(file) {
  const name = String(file).split(/[\\/]/).at(-1).replace(/\.jsonl$/, "");
  const refs = new Set([name]);
  const hash = name.lastIndexOf("#");
  if (hash >= 0) refs.add(name.slice(hash + 1));
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)?.[1];
  if (uuid) refs.add(uuid);
  const colon = name.lastIndexOf(":");
  if (colon > 0) refs.add(name.slice(colon + 1));
  return [...refs].filter((ref) => REF.test(ref));
}

let cached = null;
/**
 * True when this day's messages of this session fall inside a window the daemon steered from a phone. Read once per
 * process (the hook is short-lived); `ledger` may be passed for a test.
 */
export function remoteSteeredOf(file, messages, ledger = null) {
  const { byRef } = ledger ?? (cached ??= readSteered());
  if (byRef.size === 0 || !Array.isArray(messages) || messages.length === 0) return false;
  const record = sessionRefsOf(file).map((ref) => byRef.get(ref)).find(Boolean);
  if (!record) return false;
  // Each steered window alone (P2-3), with its slack: a day between two windows is the person's.
  const windows = record.windows ?? [record];
  return messages.some((m) => Number.isFinite(m?.at) && windows.some((w) => m.at >= w.first_steered_at - STEERED_SLACK_MS && m.at <= w.last_steered_at + STEERED_SLACK_MS));
}

/**
 * ONLY THE STEERED TURNS (CLI 0.11.23; owner, 2026-11-23: "only the steered turns are steered; the rest of that session stays
 * the person's own work"). One day's messages of one session, sorted, split by TURN: a turn opens at a prompt (`isPrompt`, the
 * reader's own rule for a person's message) and runs until the next prompt. A turn whose prompt lies inside a steered window
 * (STEERED_PROMPT_SLACK_MS) is steered, with every message answering it (the agent's answers, its tool calls and results, an
 * interruption) up to the next prompt; every other turn is the person's. Messages before the day's first prompt answer a turn
 * opened before this read: their first moment decides, with the reader's old slack (STEERED_SLACK_MS). The day before's
 * BRIDGE goes with the message after it, so it stays the first step of whichever part holds it.
 * Null when the ledger names no window for this session or no turn of the day is steered; else `{ steered, own, flags }`:
 * the steered messages, the person's, and per message (in the order given) whether it is steered. Read once per process.
 */
export function steeredTurnsOf(file, messages, isPrompt, ledger = null) {
  const { byRef } = ledger ?? (cached ??= readSteered());
  if (byRef.size === 0 || !Array.isArray(messages) || messages.length === 0) return null;
  const record = sessionRefsOf(file).map((ref) => byRef.get(ref)).find(Boolean);
  if (!record) return null;
  const windows = record.windows ?? [record];
  const inside = (at, slack) => Number.isFinite(at) && windows.some((w) => at >= w.first_steered_at - slack && at <= w.last_steered_at + slack);
  const flags = new Array(messages.length).fill(null);
  let turn = null; // the open turn: true steered, false the person's, null before the day's first prompt
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.bridge) continue;
    if (isPrompt(m)) turn = inside(m?.at, STEERED_PROMPT_SLACK_MS);
    else if (turn === null) turn = inside(m?.at, STEERED_SLACK_MS);
    flags[i] = turn;
  }
  for (let i = flags.length - 1, next = false; i >= 0; i -= 1) { if (flags[i] === null) flags[i] = next; else next = flags[i]; } // a bridge: its next message's
  if (!flags.some(Boolean)) return null;
  return { steered: messages.filter((_, i) => flags[i]), own: messages.filter((_, i) => !flags[i]), flags };
}

/**
 * A SESSION'S DAY IN PARTS, FOR THE HOOK (CLI 0.11.23; log-session.mjs dayParts). One part, as before, when the ledger names no
 * steered turn of the day: the day's ref, the session's own kind and steering. One part, headless and steered_from "remote",
 * under the day's ref, when every turn of it was steered. Else two: the person's turns under the day's ref with the session's
 * kind, steering and the mod's counts, and the steered turns, headless and steered_from "remote", under `steeredRef` (a process
 * run, folded into its folder's Agent-operations line as any headless run). Nothing is counted twice: each message is in one
 * part, the pause across a steered turn is one gap of the person's timeline, capped by the server's clock as any pause is, and
 * where the two parts overlap on the wall clock the server gives the time to the interactive line (20261027130600,
 * `analysis.exclusive_measured_share`). A client's running token totals (`cumulative`) cannot be cut per turn: such a day is
 * steered whole when any message is in a window, as before 0.11.23.
 */
export function steeredParts(file, messages, { session, steered, isPrompt, ref, steeredRef, ledger = null }) {
  const split = messages.some((m) => m?.cumulative) ? (remoteSteeredOf(file, messages, ledger) ? { own: [] } : null) : steeredTurnsOf(file, messages, isPrompt, ledger);
  if (!split) return [{ messages, session, steered, ref, own: true, flags: null }];
  if (!split.own.some((m) => !m.bridge)) return [{ messages, session: "headless", steered: "remote", ref, own: false, flags: null }];
  return [{ messages: split.own, session, steered, ref, own: true, flags: split.flags, flag: false }, { messages: split.steered, session: "headless", steered: "remote", ref: steeredRef, own: false, flags: split.flags, flag: true }];
}

/** A day's subagent runs (the hook's agentsByDay entry) for one part of a split day: each run with the part of the last message at or before its start. */
export function agentsOfPart(entry, messages, part, peakOf) {
  if (!entry || !part.flags) return entry;
  const steeredAt = (at) => { let flag = part.flags[0]; for (let i = 0; i < messages.length && messages[i].at <= at; i += 1) flag = part.flags[i]; return flag; };
  const keep = entry.list.map((run, i) => (steeredAt(run.stamps[0]) === part.flag ? i : -1)).filter((i) => i >= 0);
  if (keep.length === 0) return null;
  const spans = keep.map((i) => entry.spans[i]);
  return { runs: keep.length, spans, list: keep.map((i) => entry.list[i]), peak: peakOf(spans) };
}

/**
 * The parts → the hook's stretches (`measure(part)`, the mod's `live()` for the person's part only, the day's subagent runs per
 * part), in the order they end. A split day's stretches carry `dayTo` (the day's last message) and all but the last `holdMark`:
 * the hook's live loop waits for the whole day and moves its watermark only past the last part, so a part refused never leaves
 * the other part's earlier messages behind the mark.
 */
export function steeredStretches(parts, messages, { measure, live, agents, peakOf }) {
  const out = parts.map((part) => { const stretch = measure(part); return stretch && { ...stretch, ref: part.ref, steered: part.steered, session: part.session, agents: agentsOfPart(agents, messages, part, peakOf), live: part.own ? live() : null }; }).filter(Boolean).sort((a, b) => a.to - b.to);
  if (out.length > 1) out.forEach((stretch, i) => { stretch.dayTo = messages[messages.length - 1].at; if (i < out.length - 1) stretch.holdMark = true; });
  return out;
}
