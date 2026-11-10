/**
 * OPENCODE'S `run --format json` STREAM, MAPPED TO THE PROTOCOL (owner, 2026-11-09: steer OpenCode, and through it Qwen on
 * Ollama, from Remote Agent). Pure: one line in, the protocol's events out. Read from OpenCode's source (anomalyco/opencode,
 * packages/cli/src/run/noninteractive.ts, the `renderer`'s `emit`, read 2026-11-09): every line is
 * `{ type, timestamp, sessionID, ... }`, and these are the ones it writes:
 *
 *   text          part.text, the NEW words of an answer since the last line   agent.output_delta { assistant }; kept as the answer
 *   tool_use      one per finished tool call: part.tool, part.state.status     agent.step_started and agent.step_completed together
 *                 (completed | error), state.input, state.time { start, end }  (OpenCode writes a call only when it is done)
 *   step_finish   part.tokens { input, output, reasoning, cache { read, write } } per model step: agent.usage, the turn's sum
 *   error         error.message                                                 kept: the failed turn's reason
 *   reasoning, step_start, retry, background_wait                               counted, nothing sent
 *
 * The adapter (remote-adapter-opencode.mjs) adds two lines of its own around the runs of one turn: `wt.turn_started`
 * and `wt.turn_ended { outcome: completed | interrupted | failed }`. Words are cut to the protocol's sizes.
 */
import * as P from "./remote-protocol.mjs";

const cut = (text, max) => (typeof text === "string" ? (text.length > max ? text.slice(0, max) : text) : "");
const TEST = /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?test\b|(^|\s)(pytest|vitest|jest|go\s+test|cargo\s+test|node\s+--test)\b/;
const STEP_KIND = { bash: "command", edit: "edit", write: "edit", patch: "edit", multiedit: "edit", read: "read", list: "read", glob: "search", grep: "search", webfetch: "search", websearch: "search", task: "tool", todowrite: "think", todoread: "think" };
const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const steps = (s) => ({ kind: "steps", started: s.started, completed: s.completed });

export const emptyOpenCodeState = () => ({ turnStartedAt: null, started: 0, completed: 0, offset: 0, answer: "", turnTokens: null, session: null, error: null, ignored: 0 });

/** One step's counts in the protocol's fields: OpenCode's input is new input (the cache read apart), output holds the reasoning. */
export function openCodeTokens(t) {
  if (!t || typeof t !== "object") return null;
  const input = n(t.input), output = n(t.output), reasoning = n(t.reasoning) ?? 0;
  return { input, output: output === null ? null : output + reasoning, cache_read: n(t.cache?.read), cache_creation: n(t.cache?.write) };
}
/** What a tool call is about, as the phone's step label: the command, the file, or the tool's name. */
function labelOf(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  if (tool === "bash") return cut(String(i.command ?? ""), 500) || "command";
  const file = i.filePath ?? i.file_path ?? i.path;
  if (typeof file === "string" && file) return cut(file, 500);
  if (tool === "grep" || tool === "glob") return cut(`${tool} ${String(i.pattern ?? "")}`.trim(), 500);
  return cut(String(tool || "tool"), 500);
}

/** One line → { state, events, turn: "started" | "ended" | null }. `mint(prefix)` makes ids; `model` is the session's chosen model. */
export function mapOpenCodeLine(state, line, mint, now, model = null) {
  const s = { ...state };
  const events = [];
  const type = line?.type, part = line?.part ?? {};
  if (type === "wt.turn_started") {
    Object.assign(s, { turnStartedAt: now, started: 0, completed: 0, offset: 0, answer: "", turnTokens: null, error: null });
    return { state: s, events, turn: "started" };
  }
  if (type === "text" && typeof part.text === "string" && part.text.length > 0) {
    const text = cut(part.text, 65_536);
    events.push({ type: "agent.output_delta", body: { stream: "assistant", offset: s.offset, text } });
    s.offset += text.length;
    s.answer = cut(s.answer + text, P.MAX_ANSWER_CHARS + 1);
    return { state: s, events, turn: null };
  }
  if (type === "tool_use" && typeof part.tool === "string") {
    const label = labelOf(part.tool, part.state?.input), kind = STEP_KIND[part.tool] ?? "tool";
    const step_id = mint("stp");
    s.started += 1;
    events.push({ type: "agent.step_started", body: { step_id, label, kind: kind === "command" && TEST.test(label) ? "test" : kind, progress: steps(s) } });
    s.completed += 1;
    const start = Number(part.state?.time?.start), end = Number(part.state?.time?.end);
    events.push({ type: "agent.step_completed", body: { step_id, outcome: part.state?.status === "completed" ? "ok" : "failed", progress: steps(s), duration_ms: Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round(end - start) : 0 } });
    return { state: s, events, turn: null };
  }
  if (type === "step_finish") {
    const t = openCodeTokens(part.tokens);
    if (!t) { s.ignored += 1; return { state: s, events, turn: null }; }
    s.turnTokens = s.turnTokens ? P.addTokens(s.turnTokens, t) : t;
    s.session = s.session ? P.addTokens(s.session, t) : t;
    events.push({ type: "agent.usage", body: { model, turn: s.turnTokens, turn_final: false, session: s.session } });
    return { state: s, events, turn: null };
  }
  if (type === "error") { s.error = typeof line.error?.message === "string" ? cut(line.error.message, 4000) : "OpenCode reported an error"; return { state: s, events, turn: null }; }
  if (type === "wt.turn_ended") {
    const time = s.turnStartedAt !== null ? { started_at: s.turnStartedAt, duration_ms: Math.max(0, now - s.turnStartedAt) } : {};
    if (s.turnTokens) events.push({ type: "agent.usage", body: { model, turn: s.turnTokens, turn_final: true, session: s.session } });
    const answer = s.answer || null;
    if (line.outcome === "completed") events.push({ type: "agent.completed", body: { summary: answer ? cut(answer, 4000) : null, progress: steps(s), result: { answer: answer ? cut(answer, P.MAX_ANSWER_CHARS) : null, answer_cut: (answer?.length ?? 0) > P.MAX_ANSWER_CHARS, source: "none", files: [], files_cut: false, tests: [] }, ...time } });
    else if (line.outcome === "interrupted") events.push({ type: "agent.stopped", body: {} });
    else events.push({ type: "agent.failed", body: { reason: "adapter_error", message: s.error, ...time } });
    Object.assign(s, { turnStartedAt: null });
    return { state: s, events, turn: "ended" };
  }
  s.ignored += 1;
  return { state: s, events, turn: null };
}
