/**
 * REMOTE-STEERED SESSIONS, MARKED (2026-11-07; owner decision 1, binding: a session steered from a phone is NEVER the
 * person's AI Hours; agent work in it counts only under the existing headless rules).
 *
 * The daemon (`worktrust remote`) writes one record per agent session it started or steered to
 * ~/.worktrust/remote/steered.jsonl (mode 0600), the protocol's STEERED_RECORD_SPEC as canonical JSON, BEFORE the agent
 * runs: it chooses Claude Code's session id itself (--session-id) or resumes a known one, so the ledger names the session
 * before its first line is written. The measurement readers (log-session.mjs) ask `remoteSteeredOf(file, messages)` for
 * each day of each session they read; a day that overlaps a steered window is measured as a headless session and sent
 * with steered_from "remote", so none of its seconds is the person's.
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

/** Every valid record by agent_session_ref, the widest window kept; unreadable lines counted, never fatal. */
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
    byRef.set(record.agent_session_ref, prior
      ? { ...record, first_steered_at: Math.min(prior.first_steered_at, record.first_steered_at), last_steered_at: Math.max(prior.last_steered_at, record.last_steered_at) }
      : record);
  }
  return { byRef, unreadable, pipelines };
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
  const from = record.first_steered_at - STEERED_SLACK_MS, to = record.last_steered_at + STEERED_SLACK_MS;
  return messages.some((m) => Number.isFinite(m?.at) && m.at >= from && m.at <= to);
}
