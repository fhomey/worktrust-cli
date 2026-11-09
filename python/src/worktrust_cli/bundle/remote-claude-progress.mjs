/**
 * CLAUDE CODE'S PLAN, SUBAGENTS AND TOKENS, AS THE PROTOCOL'S SEALED PROGRESS (owner, 2026-11-07: a roadmap with a 0 to
 * 100% loader, an agent map, the token usage and the elapsed time while a prompt runs on the phone). Pure: no I/O and no
 * clock; `now` and `mint` are parameters. remote-claude-events.mjs calls it line by line; no model is asked anything.
 *
 * THE PLAN is Claude Code's own to-do list, rebuilt the way Claude Code 2.1.286 rebuilds it for its own screen (read from
 * its bundle, 2026-11-07): the main agent's lines only (a subagent's to-do list is its own); TaskCreate `{ subject,
 * activeForm? }` is a pending item until its result says "Task #<id> created successfully" (an error drops it); TaskUpdate
 * `{ taskId, status?, subject?, activeForm? }` changes one ("deleted" removes it) once its result is not an error (stricter
 * than Claude Code's screen, which applies it at once: a refused update moves no bar); an update to a task never seen
 * created here (a resumed session) or a list past the cap marks the plan cut, so it shows no percentage; a create or an
 * update whose result never came leaves at the turn's end; when any task exists the tasks are the
 * plan, otherwise the last TodoWrite `{ todos: [{ content, status, activeForm }] }` is (a list that does not parse is
 * empty). Item ids are opaque and stable: a task keeps its id, a to-do item keeps the id of the same words in the version
 * before. `agent.plan` is sent whole when an item, a label or a state changed, with planChange's marker.
 *
 * SUBAGENTS: a Task or Agent tool_use starts one (`description`, `subagent_type`); a line carrying its tool use id as
 * parent_tool_use_id is its own (state working, its steps counted and sent with its subagent_id, nested when it delegates
 * again); system task_started / task_progress / task_notification lines add what they report (the tokens' total, tool
 * uses, duration, the end); the delegating step's result ends it: `status: "completed"` with totalTokens, usage,
 * totalToolUseCount and totalDurationMs is done, `async_launched` keeps it working, an error is failed. At most
 * MAX_SUBAGENTS per session; past that, and below one not tracked, nothing is drawn or attributed.
 *
 * TOKENS: while a turn runs, the main agent's messages' own `usage` reports summed (one count per message id, the
 * highest it reported, since a message reports its output when it starts and again when it ends); the turn's result
 * replaces the sum with its own total. A field never reported is null.
 */
import * as P from "./remote-protocol.mjs";

const LABEL = 500;
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const words = (v) => (typeof v === "string" && v.trim() ? cut(v.trim(), LABEL) : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const STATES = new Set(["pending", "in_progress", "completed"]);
const CREATED = /^Task #(\S+) created successfully/;
export const isDelegation = (name) => name === "Task" || name === "Agent";

export const emptyProgress = () => ({
  todos: null, todoIds: [], tasks: [], pending: [], updates: [], partial: false, plan: null,
  subagents: {}, subagentCount: 0,
  model: null, messages: {}, current: null, sessionFinal: null, lastUsage: null,
});

const copy = (ps) => ({ ...ps, todoIds: [...ps.todoIds], tasks: ps.tasks.map((t) => ({ ...t })), pending: ps.pending.map((t) => ({ ...t })), updates: ps.updates.map((u) => ({ ...u })), subagents: { ...ps.subagents }, messages: { ...ps.messages } });

// THE PLAN
const aliased = (input) => {
  const a = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  for (const k of ["id", "task_id"]) if (!("taskId" in a) && typeof a[k] === "string" && a[k].trim()) a.taskId = a[k];
  if (!("activeForm" in a) && typeof a.active_form === "string" && a.active_form.trim()) a.activeForm = a.active_form;
  return a;
};
function parseTodos(input) {
  const list = input?.todos;
  if (!Array.isArray(list)) return [];
  const ok = list.every((t) => t && typeof t.content === "string" && t.content.length > 0 && STATES.has(t.status) && typeof t.activeForm === "string" && t.activeForm.length > 0);
  return ok ? list.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm })) : [];
}

/** One main-agent tool_use block's effect on the plan. True when it was a plan tool. */
function planTool(ps, block, mint) {
  const a = aliased(block.input);
  if (block.name === "TaskCreate") {
    if (typeof a.subject !== "string") return false;
    // Past the cap the list is no longer whole: no item is added and the plan has no percentage (items_cut).
    if (ps.tasks.length + ps.pending.length >= P.MAX_PLAN_ITEMS) { ps.partial = true; return true; }
    ps.pending.push({ tool_use_id: block.id, item_id: mint("pli"), content: a.subject, activeForm: typeof a.activeForm === "string" ? a.activeForm : a.subject, status: "pending" });
    return true;
  }
  if (block.name === "TaskUpdate") {
    // Held until its result, like a create: an update Claude Code refused moves nothing (review 2026-11-07).
    if (typeof a.taskId !== "string" || (a.status !== undefined && !STATES.has(a.status) && a.status !== "deleted") || ps.updates.length >= P.MAX_PLAN_ITEMS) return false;
    ps.updates.push({ tool_use_id: block.id, taskId: a.taskId, status: a.status, subject: typeof a.subject === "string" ? a.subject : undefined, activeForm: typeof a.activeForm === "string" ? a.activeForm : undefined });
    return false;
  }
  if (block.name === "TodoWrite") {
    const todos = parseTodos(block.input);
    const free = [...ps.todoIds];
    ps.todoIds = todos.map((t) => {
      const at = free.findIndex((f) => f.label === t.content);
      return at >= 0 ? free.splice(at, 1)[0] : { label: t.content, item_id: mint("pli") };
    });
    ps.todos = todos.map((t, i) => ({ ...t, item_id: ps.todoIds[i].item_id }));
    return true;
  }
  return false;
}

/** A tool_result for a pending TaskCreate: its id from Claude Code's own words, or dropped on an error. */
function planResult(ps, block, text) {
  const u = ps.updates.findIndex((x) => x.tool_use_id === block.tool_use_id);
  if (u >= 0) {
    const [a] = ps.updates.splice(u, 1);
    if (block.is_error) return false;
    const at = ps.tasks.findIndex((t) => t.task_id === a.taskId);
    // A task this computer never saw created (a resumed session, a restarted daemon): the list is not whole, so the
    // plan says so and shows no percentage, rather than a one-item plan that is "100%".
    if (at < 0) { ps.partial = true; return true; }
    if (a.status === "deleted") { ps.tasks.splice(at, 1); return true; }
    const was = ps.tasks[at];
    ps.tasks[at] = { ...was, content: a.subject ?? was.content, activeForm: a.activeForm ?? was.activeForm, status: a.status ?? was.status };
    return true;
  }
  const at = ps.pending.findIndex((p) => p.tool_use_id === block.tool_use_id);
  if (at < 0) return false;
  if (block.is_error) { ps.pending.splice(at, 1); return true; }
  const task_id = CREATED.exec(text)?.[1];
  if (!task_id) return false;
  const [p] = ps.pending.splice(at, 1);
  if (!ps.tasks.some((t) => t.task_id === task_id)) ps.tasks.push({ task_id, item_id: p.item_id, content: p.content, activeForm: p.activeForm, status: p.status });
  return true;
}

/** The plan Claude Code would show now, as the protocol's items; null while it never had one. */
function planItems(ps) {
  const tasks = [...ps.tasks, ...ps.pending];
  const list = tasks.length > 0 ? tasks : ps.todos;
  // Never a plan: nothing to send. A plan whose last item went (a failed TaskCreate, a deleted task): an empty plan, not a stale one.
  if (list === null) return ps.plan ? { items: [], items_cut: false } : null;
  const items = list.slice(0, P.MAX_PLAN_ITEMS).map((t) => ({ item_id: t.item_id, label: words(t.content) ?? "…", state: t.status, active: t.status === "in_progress" ? words(t.activeForm) ?? words(t.content) : null }));
  return { items, items_cut: list.length > P.MAX_PLAN_ITEMS || (list !== ps.todos && ps.partial) };
}

/** The agent.plan event when the plan changed, else null; the state keeps the version sent. */
function planEvent(ps) {
  const next = planItems(ps);
  if (next === null) return null;
  const prev = ps.plan;
  if (prev && JSON.stringify(prev.items) === JSON.stringify(next.items) && prev.items_cut === next.items_cut) return null;
  ps.plan = { plan_version: (prev?.plan_version ?? 0) + 1, change: P.planChange(prev, next), ...next };
  return { type: "agent.plan", body: ps.plan };
}

/** The plan item a step starting now belongs to. */
export const planItemNow = (ps) => P.currentPlanItem(ps.plan)?.item_id ?? null;

// SUBAGENTS
const NO_SUB_TOKENS = { total: null, input: null, output: null, cache_read: null, cache_creation: null };
const subEvent = (r) => ({ type: "agent.subagent", body: { subagent_id: r.subagent_id, parent_id: r.parent_id, step_id: r.step_id, label: r.label, agent_type: r.agent_type, state: r.state, steps: r.steps, tokens: r.tokens, started_at: r.started_at, duration_ms: r.duration_ms } });
const final = (r) => P.isFinalSubagentState(r.state);

/** The tracked subagent a line belongs to, by its parent_tool_use_id, or null. */
export const subagentOf = (ps, parentToolUseId) => (typeof parentToolUseId === "string" ? ps.subagents[parentToolUseId] ?? null : null);

/** A Task or Agent tool_use: a new subagent, under the subagent whose line carried it. */
function delegate(ps, block, parentToolUseId, stepId, now, mint) {
  const parent = parentToolUseId ? subagentOf(ps, parentToolUseId) : null;
  if ((parentToolUseId && !parent) || ps.subagentCount >= P.MAX_SUBAGENTS || ps.subagents[block.id]) return null;
  ps.subagentCount += 1;
  const a = block.input && typeof block.input === "object" ? block.input : {};
  const r = { subagent_id: mint("sag"), parent_id: parent?.subagent_id ?? null, step_id: stepId, label: words(a.description), agent_type: typeof a.subagent_type === "string" && a.subagent_type.trim() ? cut(a.subagent_type.trim(), 128) : null,
    state: "started", steps: 0, tokens: NO_SUB_TOKENS, started_at: count(now), duration_ms: null };
  ps.subagents[block.id] = r;
  return subEvent(r);
}

function updateSub(ps, toolUseId, change) {
  const r = ps.subagents[toolUseId];
  if (!r || final(r)) return null;
  const next = { ...r, ...change(r) };
  if (JSON.stringify(next) === JSON.stringify(r)) return null;
  ps.subagents[toolUseId] = next;
  return subEvent(next);
}
const measured = (r, now) => (count(now) !== null && r.started_at !== null && now >= r.started_at ? now - r.started_at : null);

/** A line of the subagent's own: working, and one more step for each tool it used. */
export function subagentLine(ps, parentToolUseId, steps) {
  const r = subagentOf(ps, parentToolUseId);
  if (!r) return null;
  return updateSub(ps, parentToolUseId, (x) => ({ state: "working", steps: x.steps + steps }));
}

/** system task_started / task_progress / task_notification. */
function taskLine(ps, line, now) {
  const r = ps.subagents[line.tool_use_id];
  if (!r) return null;
  const u = line.usage && typeof line.usage === "object" ? line.usage : {};
  const total = count(u.total_tokens), uses = count(u.tool_uses);
  if (line.subtype === "task_started") return updateSub(ps, line.tool_use_id, (x) => ({ label: x.label ?? words(line.description), agent_type: x.agent_type ?? (typeof line.subagent_type === "string" && line.subagent_type.trim() ? cut(line.subagent_type.trim(), 128) : null) }));
  const base = (x) => ({ tokens: total === null ? x.tokens : { ...x.tokens, total }, steps: Math.max(x.steps, uses ?? 0) });
  if (line.subtype === "task_progress") return updateSub(ps, line.tool_use_id, (x) => ({ ...base(x), state: "working" }));
  const state = { completed: "done", failed: "failed", stopped: "stopped", killed: "stopped" }[line.status];
  if (!state) return updateSub(ps, line.tool_use_id, (x) => base(x)); // a status not known here ends nothing
  return updateSub(ps, line.tool_use_id, (x) => ({ ...base(x), state, duration_ms: count(u.duration_ms) ?? measured(x, now) }));
}

/** The delegating step's own result. */
function delegationResult(ps, block, report, now) {
  if (!ps.subagents[block.tool_use_id]) return null;
  const rep = report && typeof report === "object" ? report : {};
  if (block.is_error) return updateSub(ps, block.tool_use_id, (x) => ({ state: "failed", duration_ms: measured(x, now) }));
  if (rep.status === "async_launched") return updateSub(ps, block.tool_use_id, () => ({ state: "working", background: true }));
  const u = rep.usage && typeof rep.usage === "object" ? rep.usage : {};
  return updateSub(ps, block.tool_use_id, (x) => ({
    state: "done",
    steps: Math.max(x.steps, count(rep.totalToolUseCount) ?? 0),
    tokens: { total: count(rep.totalTokens) ?? x.tokens.total, input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_creation: count(u.cache_creation_input_tokens) },
    duration_ms: count(rep.totalDurationMs) ?? measured(x, now),
  }));
}

// TOKENS
export const tokensOf = (u) => (u && typeof u === "object" ? { input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_creation: count(u.cache_creation_input_tokens) } : null);
const higher = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
const maxTokens = (a, b) => (a ? { input: higher(a.input, b.input), output: higher(a.output, b.output), cache_read: higher(a.cache_read, b.cache_read), cache_creation: higher(a.cache_creation, b.cache_creation) } : b);

function runningTurn(ps) {
  const all = Object.values(ps.messages);
  return all.length === 0 ? null : all.reduce((sum, t) => P.addTokens(sum, t));
}
function usageEvent(ps, turn, turnFinal) {
  const session = ps.sessionFinal === null ? turn ?? P.NO_TOKENS : turn === null ? ps.sessionFinal : P.addTokens(ps.sessionFinal, turn);
  const body = { model: ps.model, turn: turn ?? P.NO_TOKENS, turn_final: turnFinal, session };
  const key = JSON.stringify(body);
  if (key === ps.lastUsage) return null;
  ps.lastUsage = key;
  return { type: "agent.usage", body };
}

/** A main-agent message's usage report (an assistant line, or a stream_event message_start / message_delta). */
function messageUsage(ps, messageId, usage, model) {
  const t = tokensOf(usage);
  if (typeof model === "string" && model.trim()) ps.model = cut(model.trim(), 128);
  if (!t || typeof messageId !== "string") return null;
  ps.messages[messageId] = maxTokens(ps.messages[messageId] ?? null, t);
  return usageEvent(ps, runningTurn(ps), false);
}

// THE ENTRY POINTS remote-claude-events.mjs CALLS

/** The turn began (system/init): the model it names; nothing is sent until a report arrives. */
export function progressInit(state, line) {
  const ps = copy(state);
  if (typeof line.model === "string" && line.model.trim()) ps.model = cut(line.model.trim(), 128);
  // A turn before this one ended without its own total (stopped, crashed): the session's sum is no longer whole.
  if (Object.keys(ps.messages).length > 0) ps.sessionFinal = P.NO_TOKENS;
  ps.messages = {}; ps.current = null;
  return ps;
}

/**
 * The run ended another way (a stop, the agent's exit, a failed turn): every subagent not ended is `stopped`, at once,
 * so the map never shows one working forever. A failed turn leaves a background subagent (async_launched) alone: its
 * own notification ends it.
 */
export function progressEndSubagents(state, now, { background }) {
  const ps = copy(state), events = [];
  for (const [key, r] of Object.entries(ps.subagents)) {
    if (final(r) || (r.background && !background)) continue;
    ps.subagents[key] = { ...r, state: "stopped", duration_ms: measured(r, now) };
    events.push(subEvent(ps.subagents[key]));
  }
  return { state: ps, events };
}

/**
 * One assistant line's progress: the plan tools (main agent only) and its usage (main agent only). `stepFor(block)`
 * gives the step id the caller minted for a tool_use block, so a subagent names the step that delegated it.
 */
export function progressAssistant(state, line, { now, mint, stepFor }) {
  const ps = copy(state), events = [];
  const parent = typeof line.parent_tool_use_id === "string" ? line.parent_tool_use_id : null;
  let planned = false;
  for (const block of line.message.content) {
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    if (!parent && planTool(ps, block, mint)) planned = true;
    if (isDelegation(block.name)) { const e = delegate(ps, block, parent, stepFor(block) ?? null, now, mint); if (e) events.push(e); }
  }
  if (planned) { const e = planEvent(ps); if (e) events.push(e); }
  if (!parent) { const e = messageUsage(ps, line.message.id, line.message.usage, line.message.model); if (e) events.push(e); }
  return { state: ps, events };
}

/** One user line's tool_results: a pending task's id, a delegation's end. `textOf(block)` is the result's text. */
export function progressUser(state, line, { now, textOf }) {
  const ps = copy(state), events = [];
  let planned = false;
  for (const block of line.message.content) {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    if (!line.parent_tool_use_id && planResult(ps, block, textOf(block))) planned = true;
    const e = delegationResult(ps, block, line.tool_use_result, now);
    if (e) events.push(e);
  }
  if (planned) { const e = planEvent(ps); if (e) events.push(e); }
  return { state: ps, events };
}

/** stream_event message_start / message_delta of the main agent. */
export function progressStream(state, line) {
  const e = line.event ?? {};
  if (line.parent_tool_use_id) return { state, events: [] };
  const ps = copy(state);
  if (e.type === "message_start" && e.message && typeof e.message.id === "string") {
    ps.current = e.message.id;
    const u = messageUsage(ps, e.message.id, e.message.usage, e.message.model);
    return { state: ps, events: u ? [u] : [] };
  }
  if (e.type === "message_delta" && ps.current) {
    const u = messageUsage(ps, ps.current, e.usage, null);
    return { state: ps, events: u ? [u] : [] };
  }
  return { state, events: [] };
}

/** system task_* lines. */
export function progressTask(state, line, now) {
  const ps = copy(state);
  const e = taskLine(ps, line, now);
  return { state: ps, events: e ? [e] : [] };
}

/** The turn's result: its own usage total replaces the running sum, and the session adds it. */
export function progressResult(state, line) {
  const ps = copy(state);
  const reported = tokensOf(line.usage);
  const turn = reported ?? runningTurn(ps);
  // A turn without its own total leaves the session's sum not whole: its fields are null from here on, never a part
  // shown as the whole (review 2026-11-07).
  if (reported === null) ps.sessionFinal = P.NO_TOKENS;
  // A turn that reported no tokens at all sends no usage: nothing is not a count of zero.
  const e = turn === null ? null : usageEvent(ps, turn, reported !== null);
  if (reported !== null) ps.sessionFinal = ps.sessionFinal === null ? reported : P.addTokens(ps.sessionFinal, reported);
  // A create or an update whose result never came did not happen as far as anyone can tell: it leaves the plan.
  ps.messages = {}; ps.current = null; ps.pending = []; ps.updates = [];
  const plan = planEvent(ps);
  return { state: ps, events: [...(e ? [e] : []), ...(plan ? [plan] : [])] };
}
