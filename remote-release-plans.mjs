/**
 * THE LOCAL AGENT'S PLANS ON THE COMPUTER'S ONE RELEASE QUEUE (owner, 2026-11-08), split out of remote-releases.mjs (its
 * size), unchanged: the queue hands in what a plan may touch (its releases, its order, release.create, save, reopen,
 * evaluate, the live feed, every task) and gets back `plan(session, op, args)`.
 */
import * as P from "./remote-protocol.mjs";

/**
 * THE LOCAL AGENT PLANS ITS OWN WORK (owner, 2026-11-08; remote-approval-bridge.mjs's plan_* tools, over the daemon's
 * socket with the session's token). Scoped to the session's own project, validated as the phone's commands are, and it
 * never runs anything: a planned task is the agent's own (`own`, its session), skipped by the scheduler, moved only by
 * that session's plan_task. Each change is saved and sent at once (release.updated), so the phone sees it.
 */
export function createPlanner(q) {
  // q: { ctx, releases, order(), commands, save, reopen, evaluate, liveSoon, allTasks }, the queue's own (remote-releases.mjs)
  const { ctx, releases, commands, save, reopen, evaluate, liveSoon, allTasks } = q;
  const SELF_STATES = new Set(["running", "done", "failed"]);
  const minutes = (m) => (m === undefined ? null : Number.isSafeInteger(m) && m >= 1 && m <= 7 * 24 * 60 ? { total_s: m * 60, confidence: "medium" } : false);
  const text = (v, max) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
  const own = (session, t) => ({ task_id: P.mintId("tsk", ctx.random), label: t.title, adapter: session.adapter, model: session.model ?? null, mode: null, prompt: null, state: "queued", reason: null, note: null,
    after_release: null, follow_up_of: null, session_id: null, started_at: null, ended_at: null, own: session.session_id, estimate: t.estimate });
  const tasksOf = (list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > P.MAX_RELEASE_TASKS) return null;
    const out = list.map((t) => ({ title: text(t?.title, P.MAX_TASK_LABEL), estimate: minutes(t?.estimate_min) }));
    return out.some((t) => t.title === null || t.estimate === false) ? null : out;
  };
  const inProject = (session, number) => [...releases.values()].find((r) => r.number === number && r.project_id === session.project_id) ?? null;
  const KNOWN = { release: ["title", "label", "estimate_min", "after", "tasks"], task: ["release", "title", "estimate_min", "task_id", "state", "note"], list: [] };

  function plan(session, op, args) {
    if (!Object.hasOwn(KNOWN, op)) return { ok: false, reason: "unknown_type" };
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (Object.keys(a).some((k) => !KNOWN[op].includes(k))) return { ok: false, reason: "payload" }; // no project, no path: the session's own
    if (!ctx.projects().some((p) => p.project_id === session.project_id)) return { ok: false, reason: "not_found" };
    if (op === "list") {
      const open = [...releases.values()].filter((r) => r.project_id === session.project_id && !P.isEndedRelease(r.state)).sort((x, y) => q.order().indexOf(x.release_id) - q.order().indexOf(y.release_id));
      return { ok: true, releases: open.map((r) => ({ release: r.number, ...(r.label ? { label: r.label } : {}), title: r.title, state: r.state, after: r.after_release ? releases.get(r.after_release)?.number ?? null : null,
        tasks: r.tasks.map((t) => ({ task_id: t.task_id, title: t.label, state: t.state, mine: t.own === session.session_id })) })) };
    }
    if (op === "release") {
      const tasks = tasksOf(a.tasks), estimate = minutes(a.estimate_min);
      const after = a.after === undefined ? null : inProject(session, a.after);
      if (a.after !== undefined && !after) return { ok: false, reason: "not_found" };
      if (!tasks || estimate === false) return { ok: false, reason: "payload" };
      const payload = { release_id: P.mintId("rel", ctx.random), title: typeof a.title === "string" ? a.title.trim() : "", ...(typeof a.label === "string" ? { label: a.label.trim() } : {}), ...(estimate ? { estimate } : {}),
        project_id: session.project_id, after_release: after?.release_id ?? null, parallel: 1 };
      if (!P.validateCommandPayload("release.create", payload).ok) return { ok: false, reason: "payload" };
      const made = commands["release.create"](payload, { command_id: null });
      if (made !== "taken") return { ok: false, reason: made };
      const r = releases.get(payload.release_id);
      r.tasks.push(...tasks.map((t) => own(session, t)));
      save(r);
      return { ok: true, release: r.number, release_id: r.release_id, tasks: r.tasks.map((t) => ({ task_id: t.task_id, title: t.label })) };
    }
    // op === "task": add one to a release of the project, or move one of the agent's own
    if (a.task_id === undefined) {
      const r = typeof a.release === "number" ? inProject(session, a.release) : null;
      const [t] = tasksOf([{ title: a.title, estimate_min: a.estimate_min }]) ?? [];
      if (!r) return { ok: false, reason: "not_found" };
      if (!t) return { ok: false, reason: "payload" };
      if (r.state === "released") return { ok: false, reason: "unsupported" };
      if (r.tasks.length >= P.MAX_RELEASE_TASKS) return { ok: false, reason: "busy" };
      reopen(r);
      const task = own(session, t);
      r.tasks.push(task);
      save(r);
      return { ok: true, release: r.number, task_id: task.task_id };
    }
    const found = allTasks().find(({ t }) => t.task_id === a.task_id);
    if (!found || found.t.own !== session.session_id || found.r.project_id !== session.project_id) return { ok: false, reason: "not_found" };
    const note = a.note === undefined ? null : text(a.note, P.MAX_TASK_NOTE);
    if (!SELF_STATES.has(a.state) || (a.note !== undefined && note === null)) return { ok: false, reason: "payload" };
    const { r, t } = found;
    if (P.isEndedTask(t.state) || (a.state !== "running" && t.state !== "running")) return { ok: false, reason: "unsupported" };
    if (a.state === "running") {
      if (t.state === "running") return { ok: true, release: r.number, task_id: t.task_id };
      Object.assign(t, { state: "running", session_id: session.session_id, started_at: ctx.now() });
      if (r.state === "planned") Object.assign(r, { state: "in_progress", started_at: ctx.now() });
    } else Object.assign(t, a.state === "done" ? { state: "done" } : { state: "failed", reason: "agent_failed", note }, { ended_at: ctx.now() });
    save(r);
    evaluate(r);
    liveSoon();
    return { ok: true, release: r.number, task_id: t.task_id };
  }

  return plan;
}
