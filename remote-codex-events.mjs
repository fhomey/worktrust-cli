/**
 * CODEX'S APP-SERVER STREAM, MAPPED TO THE PROTOCOL (2026-11-07; owner: "for Codex there must be specific steering").
 * Pure: one JSON-RPC notification in, the protocol's events out. Read from Codex 0.154.0 on this machine
 * (`codex app-server generate-json-schema`, and a recorded session: scripts/fixtures/remote/codex-0.154.0-app-server.jsonl).
 *
 *   thread/started                        the agent's own session id (the thread id: what the steered ledger names)
 *   turn/started                          a turn began (acceptance; started_at on the computer's clock)
 *   item/started  commandExecution        agent.step_started { kind: command | test, label: the command }
 *                 fileChange              agent.step_started { kind: edit, label: the paths }
 *                 mcpToolCall, dynamicToolCall, webSearch, imageView   agent.step_started { kind: tool | search }
 *                 userMessage             a message entered the turn: the first is the turn's prompt, any later one a
 *                                         live steer that landed (`landed` counts them)
 *   item/completed                        agent.step_completed { ok | failed }; an agentMessage keeps the turn's answer
 *   item/agentMessage/delta               agent.output_delta { assistant }
 *   turn/plan/updated                     agent.plan, item ids stable by the step's words
 *   thread/tokenUsage/updated             agent.usage: the turn's own counts (the thread total minus its total when the
 *                                         turn began) and the thread's; input excludes the cached part
 *   turn/completed  completed             agent.completed with the answer; interrupted: agent.stopped; failed: agent.failed
 * Anything else is counted and sends nothing. Words are cut to the protocol's sizes.
 */
import { isAbsolute, relative, resolve } from "node:path";
import * as P from "./remote-protocol.mjs";

const cut = (text, max) => (typeof text === "string" ? (text.length > max ? text.slice(0, max) : text) : "");
const TEST = /(^|\s)(pnpm|npm|yarn|bun)\s+(run\s+)?test\b|(^|\s)(pytest|vitest|jest|go\s+test|cargo\s+test|node\s+--test)\b/;
const STEP_KIND = { commandExecution: "command", fileChange: "edit", mcpToolCall: "tool", dynamicToolCall: "tool", webSearch: "search", imageView: "read" };
const PLAN_STATE = { pending: "pending", inProgress: "in_progress", completed: "completed" };

export const emptyCodexState = () => ({ threadId: null, turnId: null, turnStartedAt: null, items: {}, started: 0, completed: 0, offset: 0, answer: null, userMessages: 0, landed: 0,
  planIds: {}, planVersion: 0, plan: null, totalAtTurn: null, total: null, ignored: 0 });

const commandOf = (item) => cut(unwrapShell(item.command ?? ""), 500) || "command";
function labelOf(item) {
  if (item.type === "commandExecution") return commandOf(item);
  if (item.type === "fileChange") return cut((item.changes ?? []).map((c) => c?.path).filter(Boolean).join(", "), 500) || "file change";
  if (item.type === "mcpToolCall") return cut(`${item.server ?? "mcp"}.${item.tool ?? "tool"}`, 500);
  if (item.type === "webSearch") return cut(item.query ?? "web search", 500);
  return cut(item.type, 500);
}

const tokens = (t) => {
  if (!t || typeof t !== "object") return P.NO_TOKENS;
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const input = n(t.inputTokens), cached = n(t.cachedInputTokens);
  return { input: input !== null && cached !== null ? Math.max(0, input - cached) : null, output: n(t.outputTokens), cache_read: cached, cache_creation: n(t.cacheWriteInputTokens ?? 0) };
};
const minus = (a, b) => Object.fromEntries(P.TOKEN_FIELDS.map((f) => [f, a[f] === null || b?.[f] === null || b?.[f] === undefined ? (b ? null : a[f]) : Math.max(0, a[f] - b[f])]));
const steps = (s) => ({ kind: "steps", started: s.started, completed: s.completed });

/** One notification → { state, events, turn: "started" | "ended" | null, sessionRef? }. `mint(prefix)` makes ids. */
export function mapCodexMessage(state, msg, mint, now) {
  const s = { ...state, items: { ...state.items }, planIds: { ...state.planIds } };
  const m = msg?.method, p = msg?.params ?? {};
  const events = [];
  if (m === "thread/started") { s.threadId = typeof p.thread?.id === "string" ? p.thread.id : s.threadId; return { state: s, events, turn: null, sessionRef: s.threadId }; }
  if (m === "turn/started") {
    Object.assign(s, { turnId: p.turn?.id ?? null, turnStartedAt: now, items: {}, started: 0, completed: 0, offset: 0, answer: null, userMessages: 0, landed: 0, totalAtTurn: s.total });
    return { state: s, events, turn: "started" };
  }
  if (m === "item/started" && p.item) {
    if (p.item.type === "userMessage") { s.userMessages += 1; if (s.userMessages > 1) s.landed += 1; return { state: s, events, turn: null, landed: s.userMessages > 1 }; }
    const kind = STEP_KIND[p.item.type];
    if (!kind) { s.ignored += 1; return { state: s, events, turn: null }; }
    const step_id = mint("stp");
    s.items[p.item.id] = { step_id, at: now };
    s.started += 1;
    const label = labelOf(p.item);
    events.push({ type: "agent.step_started", body: { step_id, label, kind: kind === "command" && TEST.test(label) ? "test" : kind, progress: steps(s) } });
    return { state: s, events, turn: null };
  }
  if (m === "item/completed" && p.item) {
    if (p.item.type === "agentMessage" && typeof p.item.text === "string") s.answer = p.item.text;
    const open = s.items[p.item.id];
    if (!open) return { state: s, events, turn: null };
    delete s.items[p.item.id];
    s.completed += 1;
    const failed = p.item.status === "failed" || p.item.status === "declined" || (Number.isSafeInteger(p.item.exitCode) && p.item.exitCode !== 0);
    events.push({ type: "agent.step_completed", body: { step_id: open.step_id, outcome: failed ? "failed" : "ok", progress: steps(s), duration_ms: Math.max(0, now - open.at) } });
    return { state: s, events, turn: null };
  }
  if (m === "item/agentMessage/delta" && typeof p.delta === "string" && p.delta.length > 0) {
    const text = cut(p.delta, 65_536);
    events.push({ type: "agent.output_delta", body: { stream: "assistant", offset: s.offset, text } });
    s.offset += text.length;
    return { state: s, events, turn: null };
  }
  if (m === "turn/plan/updated" && Array.isArray(p.plan)) {
    const items = p.plan.slice(0, P.MAX_PLAN_ITEMS).filter((x) => typeof x?.step === "string" && x.step.trim()).map((x) => {
      const label = cut(x.step.trim(), P.MAX_PLAN_LABEL);
      s.planIds[label] ??= mint("pli");
      const st = PLAN_STATE[x.status] ?? "pending";
      return { item_id: s.planIds[label], label, state: st, active: st === "in_progress" ? label : null };
    }).filter((x, i, all) => all.findIndex((y) => y.item_id === x.item_id) === i);
    const plan = { plan_version: s.planVersion + 1, change: "created", items, items_cut: p.plan.length > P.MAX_PLAN_ITEMS };
    plan.change = P.planChange(s.plan, plan);
    s.plan = plan; s.planVersion = plan.plan_version;
    events.push({ type: "agent.plan", body: plan });
    return { state: s, events, turn: null };
  }
  if (m === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
    s.total = tokens(p.tokenUsage.total);
    events.push({ type: "agent.usage", body: { model: null, turn: minus(s.total, s.totalAtTurn), turn_final: false, session: s.total } });
    return { state: s, events, turn: null };
  }
  if (m === "turn/completed") {
    const status = p.turn?.status;
    const time = s.turnStartedAt !== null ? { started_at: s.turnStartedAt, duration_ms: Math.max(0, now - s.turnStartedAt) } : {};
    if (s.total) events.push({ type: "agent.usage", body: { model: null, turn: minus(s.total, s.totalAtTurn), turn_final: true, session: s.total } });
    if (status === "completed") {
      const answer = s.answer ?? p.turn?.items?.findLast?.((i) => i.type === "agentMessage")?.text ?? null;
      events.push({ type: "agent.completed", body: { summary: answer ? cut(answer, 4000) : null, progress: steps(s), result: { answer: answer ? cut(answer, P.MAX_ANSWER_CHARS) : null, answer_cut: (answer?.length ?? 0) > P.MAX_ANSWER_CHARS, source: "none", files: [], files_cut: false, tests: [] }, ...time } });
    } else if (status === "interrupted") events.push({ type: "agent.stopped", body: {} });
    else events.push({ type: "agent.failed", body: { reason: "adapter_error", message: p.turn?.error?.message ? cut(String(p.turn.error.message), 4000) : null, ...time } });
    Object.assign(s, { turnId: null, turnStartedAt: null, items: {} });
    return { state: s, events, turn: "ended" };
  }
  s.ignored += 1;
  return { state: s, events, turn: null };
}

const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
/** A shell wrapper Codex puts around a command, removed only when it is exactly that wrapper. */
export const unwrapShell = (command) => String(command).replace(/^\/bin\/(zsh|bash|sh) -lc '([^']*)'$/s, "$2");
/** Every path a file change touches: its own and, for a move, its destination (review 2026-11-07, P1-2). */
export const changePaths = (changes) => (Array.isArray(changes) ? changes : []).flatMap((c) => [c?.path, c?.kind?.move_path, c?.move_path]).filter((p) => typeof p === "string" && p.length > 0);

/**
 * A Codex approval request → the tool calls the computer's policy classifies (remote-policy.mjs), every one of which must
 * be approvable, or null (declined here). Review 2026-11-07: the WHOLE command Codex will run (never its `commandActions`
 * summary, which drops a leading `cd … &&`), refused when it runs outside the project (`cwd`); a file change by every path
 * it touches, a move's destination included; a request that asks to widen the writable root (`grantRoot`) is refused.
 */
export function codexApprovalAsTool(method, params, fileChanges, projectPath) {
  const cwd = typeof params?.cwd === "string" ? params.cwd : null;
  if (cwd !== null && (typeof projectPath !== "string" || !inside(projectPath, resolve(projectPath, cwd)))) return null;
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = Array.isArray(params?.command) ? params.command.join(" ") : params?.command;
    return typeof command === "string" && command.trim() ? [{ tool: "Bash", input: { command: unwrapShell(command) } }] : null;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    if (params?.grantRoot !== undefined && params?.grantRoot !== null) return null;
    const legacy = Object.entries(params?.fileChanges ?? {}).flatMap(([path, change]) => [path, change?.move_path].filter((p) => typeof p === "string"));
    const paths = [...new Set([...(fileChanges?.[params?.itemId] ?? []), ...legacy])];
    return paths.length > 0 ? paths.map((file_path) => ({ tool: "Edit", input: { file_path } })) : null;
  }
  return null; // permissions, elicitations, anything new: not classifiable here, so denied
}

/** The answer Codex takes for a refusal: `decline` where the request lists it, else `cancel` (which also ends the turn). */
export function refusalFor(params) {
  const offered = Array.isArray(params?.availableDecisions) ? params.availableDecisions.filter((d) => typeof d === "string") : null;
  return offered === null || offered.includes("decline") ? "decline" : "cancel";
}
