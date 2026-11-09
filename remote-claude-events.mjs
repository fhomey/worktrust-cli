/**
 * CLAUDE CODE'S STREAM, AS THE PROTOCOL'S EVENTS: ONE PURE FUNCTION (2026-11-07). `claude -p --input-format stream-json
 * --output-format stream-json --verbose [--include-partial-messages]` writes one JSON object per line;
 * `mapClaudeLine(state, line, mint, now)` turns one of them into the protocol's sealed events and says when a turn starts
 * or ends. No I/O and no clock of its own: `mint(prefix)` makes opaque ids, `now` is the computer's clock or null. Held by
 * scripts/test-remote-claude-events.mjs against two recorded Claude Code 2.1.286 runs (scripts/fixtures/remote/), one
 * with partial messages, and a third in the same format with a plan and subagents. The plan, the agent map and the
 * tokens are remote-claude-progress.mjs (owner, 2026-11-07).
 *
 *   Claude Code line                                   protocol event(s)                                   turn
 *   system/init                                        (the session's own id, model and folder noted;      started
 *                                                      the turn's started_at)
 *   stream_event text_delta (partial messages)         agent.output_delta {assistant}, coalesced: one event
 *                                                      per 2,048 characters or at the block's end
 *   stream_event message_start / message_delta         agent.usage {running}, the main agent's only
 *   assistant: text block (no partial messages)        agent.output_delta {assistant}, cut at 65,536
 *   assistant: tool_use block                          agent.step_started {label, kind, steps, plan_item_id}
 *   assistant: TodoWrite, TaskCreate, TaskUpdate       + agent.plan, whole, when the plan changed
 *   assistant: Task or Agent tool_use                  + agent.subagent {started}
 *   assistant: a message's usage                       + agent.usage {running}, the main agent's only
 *   assistant: thinking block, thinking deltas         (nothing: never sent)
 *   user: tool_result block                            agent.step_completed {ok | failed, duration_ms}
 *   user: tool_result, is_error                        + agent.output_delta {tool} with the reason
 *   user: tool_result of a test command                (its outcome and counts kept for the result)
 *   user: a Task's result (tool_use_result)            + agent.subagent {done | failed, tokens, steps, duration}
 *   a tracked subagent's assistant / user line         its steps {subagent_id}, agent.subagent {working, steps};
 *     (parent_tool_use_id)                             its text is never sent as the reply
 *   system task_started / task_progress /              agent.subagent {the tokens, tool uses, duration, end}
 *     task_notification
 *   result, success                                    agent.usage {final}, agent.completed {summary, steps,
 *                                                      result: the full answer and the tests; the files are
 *                                                      added by the session; started_at, duration_ms}      ended
 *   result, an error subtype or is_error               agent.usage, agent.failed {adapter_error | timeout} ended
 *   an untracked subagent's line, system/status, system/thinking_tokens, rate_limit_event, other stream_event types,
 *   anything else: nothing, counted
 */
import { emptyProgress, planItemNow, progressAssistant, progressEndSubagents, progressInit, progressResult, progressStream, progressTask, progressUser, subagentLine, subagentOf } from "./remote-claude-progress.mjs";

/** The agent's run ended (a stop, its exit): every subagent not ended is stopped, background ones too. */
export function endClaudeRun(state, now = null) {
  const p = progressEndSubagents(state.progress, Number.isSafeInteger(now) ? now : null, { background: true });
  return { state: { ...state, progress: p.state }, events: p.events };
}

export const CHUNK_CHARS = 2048;
const MAX_ANSWER = 262_144;
export const emptyClaudeState = () => ({ steps: {}, stepAt: {}, tests: {}, testRuns: [], started: 0, completed: 0, offset: 0, pending: "", streamed: false, cwd: null, sessionRef: null, model: null, ignored: 0, turnStartedAt: null, progress: emptyProgress() });

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const relative = (cwd, path) => (typeof path !== "string" ? "" : cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
export const TEST_COMMAND = /(^|\s)(test|tests|pytest|jest|vitest|mocha|--test)(\s|$)/;

/** The step's words and kind, from the tool's own name and input. */
export function stepOf(name, input, cwd) {
  const a = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Bash": { const command = String(a.command ?? ""); return { label: cut(`Run ${command}`, 500), kind: TEST_COMMAND.test(command) ? "test" : "command" }; }
    case "Read": case "NotebookRead": return { label: cut(`Read ${relative(cwd, a.file_path ?? a.notebook_path)}`, 500), kind: "read" };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { label: cut(`Edit ${relative(cwd, a.file_path ?? a.notebook_path)}`, 500), kind: "edit" };
    case "Write": return { label: cut(`Write ${relative(cwd, a.file_path)}`, 500), kind: "edit" };
    case "Glob": case "Grep": return { label: cut(`Search ${String(a.pattern ?? "")}`, 500), kind: "search" };
    case "WebFetch": case "WebSearch": return { label: cut(`Look up ${String(a.url ?? a.query ?? "")}`, 500), kind: "search" };
    case "Task": case "Agent": return { label: cut(`Delegate ${String(a.description ?? "")}`, 500), kind: "tool" };
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": return { label: "Plan the work", kind: "think" };
    default: return { label: cut(`Use ${String(name ?? "a tool")}`, 500), kind: "tool" };
  }
}

/** Counts a test runner printed: node --test, Jest, Vitest, pytest, Go and cargo. Null when it named none. */
export function testCounts(output) {
  const t = String(output ?? "");
  const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  let passed = num(/(?:^|\n)[ℹ#] pass (\d+)/), failed = num(/(?:^|\n)[ℹ#] fail (\d+)/), total = num(/(?:^|\n)[ℹ#] tests (\d+)/);
  if (passed === null) { const jest = /Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?(\d+) total/.exec(t); if (jest) { failed = Number(jest[1] ?? 0); passed = Number(jest[2] ?? 0); total = Number(jest[3]); } }
  if (passed === null) { const vitest = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(t); if (vitest) { failed = Number(vitest[1] ?? 0); passed = Number(vitest[2]); } }
  if (passed === null) { const py = /=+ (?:(\d+) failed, )?(\d+) passed/.exec(t) ?? /(\d+) passed/.exec(t); if (py) { passed = Number(py[2] ?? py[1]); failed = num(/(\d+) failed/) ?? 0; } }
  if (passed === null) { const cargo = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(t); if (cargo) { passed = Number(cargo[1]); failed = Number(cargo[2]); } }
  return passed === null && failed === null ? null : { passed, failed, total: total ?? (passed !== null && failed !== null ? passed + failed : null) };
}

const steps = (s) => ({ kind: "steps", started: s.started, completed: s.completed });
const textOfResult = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
function flush(s, events, all) {
  while (s.pending.length >= CHUNK_CHARS || (all && s.pending.length > 0)) {
    const text = s.pending.slice(0, CHUNK_CHARS);
    s.pending = s.pending.slice(text.length);
    events.push({ type: "agent.output_delta", body: { stream: "assistant", offset: s.offset, text } });
    s.offset += text.length;
  }
}

const toolUses = (content) => content.filter((b) => b?.type === "tool_use" && typeof b.id === "string").length;
const at = (now) => (Number.isSafeInteger(now) && now >= 0 ? now : null);
/** started_at and duration_ms of the turn that ends now, where the clock was given. */
const turnTime = (s, now) => (s.turnStartedAt !== null && at(now) !== null && now >= s.turnStartedAt ? { started_at: s.turnStartedAt, duration_ms: now - s.turnStartedAt } : s.turnStartedAt !== null ? { started_at: s.turnStartedAt } : {});

/**
 * "READY, BUT A JOB IS STILL RUNNING" (owner, 2026-11-08): the background jobs the agent itself reports, by Claude Code's
 * own task lines (system task_started with is_backgrounded, then its task_notification). Counted only: never a process
 * looked at, never a job's output read. → the open task ids, or null while the agent reported no background job at all
 * (a surface then shows nothing, never a 0 it cannot know).
 */
export function backgroundJobs(open, line) {
  if (line?.type !== "system" || typeof line.task_id !== "string") return open;
  if (line.subtype === "task_started" && line.is_backgrounded === true) return new Set([...(open ?? []), line.task_id]);
  if (line.subtype === "task_notification" && open?.has(line.task_id)) { const next = new Set(open); next.delete(line.task_id); return next; }
  return open;
}

/**
 * One line in, the protocol's events out. `mint(prefix)` makes an opaque id of that kind ("stp" by default); `now` is the
 * computer's clock in milliseconds, or null (no times are then sent).
 */
export function mapClaudeLine(state, line, mint, now = null) {
  const s = { ...state, steps: { ...state.steps }, tests: { ...state.tests }, testRuns: [...state.testRuns], stepAt: { ...state.stepAt } };
  const events = [];
  const id = (prefix = "stp") => mint(prefix);
  if (!line || typeof line !== "object") return { state: { ...s, ignored: s.ignored + 1 }, events, turn: null };
  const parent = typeof line.parent_tool_use_id === "string" && line.parent_tool_use_id ? line.parent_tool_use_id : null;
  const sub = parent ? subagentOf(s.progress, parent) : null;
  // A line of a subagent this computer does not track (past the cap, or of an untracked parent): nothing, counted.
  if (parent && (!sub || (line.type !== "assistant" && line.type !== "user"))) return { state: { ...s, ignored: s.ignored + 1 }, events, turn: null };
  if (line.type === "system" && line.subtype === "init") {
    s.sessionRef = typeof line.session_id === "string" ? line.session_id : s.sessionRef;
    s.model = typeof line.model === "string" ? line.model : s.model;
    s.cwd = typeof line.cwd === "string" ? line.cwd : s.cwd;
    s.turnStartedAt = at(now);
    s.progress = progressInit(s.progress, line);
    return { state: s, events, turn: "started" };
  }
  if (line.type === "system" && /^task_(started|progress|notification)$/.test(line.subtype ?? "")) {
    const p = progressTask(s.progress, line, at(now));
    return { state: { ...s, progress: p.state }, events: p.events, turn: null };
  }
  if (line.type === "stream_event") {
    const e = line.event ?? {};
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") { s.streamed = true; s.pending += e.delta.text; flush(s, events, false); }
    else if (e.type === "content_block_stop" || e.type === "message_stop") flush(s, events, true);
    const p = progressStream(s.progress, line);
    s.progress = p.state;
    events.push(...p.events);
    return { state: s, events, turn: null };
  }
  if (line.type === "assistant" && Array.isArray(line.message?.content)) {
    const minted = {};
    for (const block of line.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0 && !s.streamed && !sub) {
        const text = block.text.slice(0, 65_536);
        events.push({ type: "agent.output_delta", body: { stream: "assistant", offset: s.offset, text } });
        s.offset += text.length;
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        if (!sub) flush(s, events, true);
        const step_id = id("stp");
        minted[block.id] = step_id;
        s.steps[block.id] = step_id;
        s.stepAt[block.id] = at(now);
        s.started += 1;
        const step = stepOf(block.name, block.input, s.cwd);
        if (step.kind === "test") s.tests[block.id] = String(block.input?.command ?? "").slice(0, 500);
        const item = planItemNow(s.progress);
        events.push({ type: "agent.step_started", body: { step_id, ...step, progress: steps(s), ...(item ? { plan_item_id: item } : {}), ...(sub ? { subagent_id: sub.subagent_id } : {}) } });
      }
    }
    const p = progressAssistant(s.progress, line, { now: at(now), mint: id, stepFor: (b) => minted[b.id] });
    s.progress = p.state;
    events.push(...p.events);
    if (sub) { const e = subagentLine(s.progress, parent, toolUses(line.message.content)); if (e) events.push(e); }
    return { state: s, events, turn: null };
  }
  if (line.type === "user" && Array.isArray(line.message?.content)) {
    for (const block of line.message.content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const step_id = s.steps[block.tool_use_id];
      if (!step_id) { s.ignored += 1; continue; }
      const began = s.stepAt[block.tool_use_id];
      delete s.steps[block.tool_use_id];
      delete s.stepAt[block.tool_use_id];
      s.completed += 1;
      const duration = began !== null && began !== undefined && at(now) !== null && now >= began ? { duration_ms: now - began } : {};
      events.push({ type: "agent.step_completed", body: { step_id, outcome: block.is_error ? "failed" : "ok", progress: steps(s), ...duration } });
      const output = textOfResult(block.content);
      if (s.tests[block.tool_use_id] !== undefined && s.testRuns.length < 20) {
        const counts = testCounts(output);
        const outcome = block.is_error || (counts?.failed ?? 0) > 0 ? "failed" : counts ? "passed" : "unknown";
        s.testRuns.push({ command: s.tests[block.tool_use_id] || "tests", outcome, passed: counts?.passed ?? null, failed: counts?.failed ?? null, total: counts?.total ?? null });
        delete s.tests[block.tool_use_id];
      }
      const reason = block.is_error && !sub ? output.trim() : "";
      if (reason) events.push({ type: "agent.output_delta", body: { stream: "tool", offset: 0, text: cut(reason, 2000) } });
    }
    const p = progressUser(s.progress, line, { now: at(now), textOf: (b) => textOfResult(b.content) });
    s.progress = p.state;
    events.push(...p.events);
    if (sub) { const e = subagentLine(s.progress, parent, 0); if (e) events.push(e); }
    return { state: s, events, turn: null };
  }
  if (line.type === "result") {
    flush(s, events, true);
    const failed = line.is_error === true || (typeof line.subtype === "string" && line.subtype !== "success");
    const answer = typeof line.result === "string" && line.result.trim() ? line.result.trim() : null;
    let p = progressResult(s.progress, line);
    events.push(...p.events);
    if (failed) { const ended = progressEndSubagents(p.state, at(now), { background: false }); p = { ...p, state: ended.state }; events.push(...ended.events); }
    const time = turnTime(s, now);
    events.push(failed
      ? { type: "agent.failed", body: { reason: line.subtype === "error_max_turns" ? "timeout" : "adapter_error", message: answer ? cut(answer, 4000) : null, ...time } }
      : { type: "agent.completed", body: { summary: answer ? cut(answer, 4000) : null, progress: steps(s), result: { answer: answer ? answer.slice(0, MAX_ANSWER) : null, answer_cut: (answer?.length ?? 0) > MAX_ANSWER, source: "none", files: [], files_cut: false, tests: s.testRuns }, ...time } });
    // A new turn counts its own steps and tests; the plan, the subagents and the session's tokens go on.
    return { state: { ...s, progress: p.state, steps: {}, stepAt: {}, tests: {}, testRuns: [], started: 0, completed: 0, streamed: false, pending: "", turnStartedAt: null }, events, turn: "ended" };
  }
  return { state: { ...s, ignored: s.ignored + 1 }, events, turn: null };
}
