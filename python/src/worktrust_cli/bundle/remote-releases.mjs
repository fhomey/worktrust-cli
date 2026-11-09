/**
 * RELEASES AND THE ONE TASK QUEUE OF A COMPUTER (owner, 2026-11-07; docs/remote-agents/PROTOCOL.md "Releases").
 *
 * A release is a bundle of tasks in one project; several run at once and share ONE scheduler, so every task of every
 * release waits in the same queue and none runs twice. A task runs as an ordinary remote session (remote-sessions.mjs:
 * the steered ledger before the agent, events on the session's own stream), under the computer's session cap
 * (settings max_sessions, default 4, the same cap the phone's own sessions count against). When a slot frees, the
 * scheduler takes passes over the releases in their queue order and starts at most one task per release per pass, up to
 * the release's own `parallel` (1 by default: its tasks share a working tree), so a long release never starves the next
 * one and the first in line always goes first. A task or a release that waits for another release (`after_release`)
 * starts once that release is ready or released; a follow-up task waits for the task it continues and resumes its agent
 * session.
 *
 * At most once: a task is journaled `running`, with its session id, BEFORE its agent is started; a daemon that stops
 * leaves it `running` in the journal and the next daemon closes it `failed` / `interrupted`, never starting it again.
 * Queued tasks survive a restart and run. The prompt of a queued task is kept in the journal until it starts, then
 * dropped (its label stays). When a release's tasks are all done, its reviewed pipeline runs (remote-pipeline.mjs); a
 * release is `ready` only after that pipeline passed, or when the project has no pipeline at all. `released` is set at
 * the desk (`worktrust remote releases released <number>`), never from the phone. A release may carry its own short name
 * (`label`, "CLI 0.11.0") and its creator's estimate for the whole of it; the body sends the label and what is left of
 * that estimate (releaseEta), only while the release has not ended and only as etaForDisplay shows it.
 */
import * as P from "./remote-protocol.mjs";
import { adapterOf } from "./remote-inventory.mjs";
import { createPlanner } from "./remote-release-plans.mjs";
import { createCoalescer, DEFAULT_MAX_SESSIONS } from "./remote-sessions.mjs";

const HISTORY = 40;
/** The backlog is kept whole, so it is bounded (review 2026-11-07, P3-9). */
export const MAX_RELEASES = 500;

export function createReleases(ctx) {
  // ctx: { journal, now, random, emit, projects(), settings(), paused(), inventory(), sessions, pipelines, deskMarks(), log }
  const releases = new Map(ctx.journal.releases().map((r) => [r.release_id, structuredClone(r)]));
  let order = [...new Set([...ctx.journal.releaseOrder().filter((id) => releases.has(id)), ...[...releases.values()].sort((a, b) => a.number - b.number).map((r) => r.release_id)])];
  const coalesce = createCoalescer({ now: ctx.now });
  const allTasks = () => [...releases.values()].flatMap((r) => r.tasks.map((t) => ({ r, t })));
  const taskBySession = (sessionId) => { const all = allTasks().filter(({ t }) => t.session_id === sessionId); return all.find(({ t }) => t.state === "running") ?? all[0] ?? null; };
  const delivered = (id) => id === null || P.releaseDelivered(releases.get(id)?.state ?? "planned");
  const projectOf = (r) => ctx.projects().find((p) => p.project_id === r.project_id) ?? null;
  const cap = () => ctx.settings().max_sessions ?? DEFAULT_MAX_SESSIONS;

  function etaOf(r, t) {
    if (t.state !== "queued" && t.state !== "running") return undefined;
    // A task the agent planned: what is left of its own estimate, if it gave one; never history's guess for its work.
    if (t.own) return P.releaseEta({ state: "in_progress", started_at: t.started_at }, t.estimate, ctx.now());
    const durations = allTasks().filter(({ r: x, t: y }) => x.project_id === r.project_id && y.adapter === t.adapter && y.state === "done" && y.started_at !== null && y.ended_at !== null)
      .slice(-HISTORY).map(({ t: y }) => (y.ended_at - y.started_at) / 1000);
    const elapsed = t.state === "running" ? Math.max(0, (ctx.now() - t.started_at) / 1000) : 0;
    const eta = P.etaForDisplay(P.etaFromHistory(durations, elapsed));
    return eta.kind === "estimate" ? eta : undefined;
  }

  function body(r) {
    const project = projectOf(r);
    const tasks = r.tasks.map((t) => {
      const eta = etaOf(r, t);
      return { task_id: t.task_id, label: t.label, adapter: t.adapter, model: t.model, state: t.state, reason: t.reason, after_release: t.after_release, follow_up_of: t.follow_up_of,
        session_id: t.session_id, started_at: t.started_at, duration_ms: t.started_at !== null && t.ended_at !== null ? Math.max(0, t.ended_at - t.started_at) : null, ...(eta ? { eta } : {}), ...(t.note && t.state === "failed" ? { note: t.note } : {}) };
    });
    // Its own name and what is left of its creator's estimate, only when it has them: nothing summed, nothing made up.
    const eta = P.releaseEta(r, r.estimate, ctx.now());
    return { release_id: r.release_id, number: r.number, title: r.title, ...(r.label ? { label: r.label } : {}), project_id: r.project_id, state: r.state, after_release: r.after_release, position: Math.max(0, order.indexOf(r.release_id)),
      parallel: r.parallel, tasks, counts: P.releaseCounts(tasks), pipeline_config: project ? ctx.pipelines.state(project) : "absent", pipeline_run_id: r.pipeline_run_id,
      created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at, ...(eta ? { eta } : {}) };
  }

  /** Journal first (fsync), then the phone. */
  function save(r, commandId = null) {
    ctx.journal.recordRelease(r);
    ctx.emit(null, "release.updated", body(r), commandId);
  }

  function live() {
    const sessions = ctx.sessions.activeList().slice(0, P.MAX_ACTIVE_SESSIONS).map((s) => {
      const owner = taskBySession(s.session_id);
      return { ...s, release_id: owner?.r.release_id ?? null, task_id: owner?.t.task_id ?? null };
    });
    const queued = allTasks().filter(({ r, t }) => t.state === "queued" && !t.own && r.state === "in_progress").length;
    return { sessions, slots: { cap: Math.min(64, Math.max(1, cap())), running: ctx.sessions.runningCount(), queued }, pipelines: ctx.pipelines.running().slice(0, 16) };
  }
  const sendLive = () => ctx.emit(null, "agents.active", live());
  const liveSoon = () => coalesce.offer("agents.active", sendLive);
  const liveNow = () => coalesce.now("agents.active", sendLive);

  function end(r, state) {
    r.state = state;
    r.ended_at = Math.max(ctx.now(), r.started_at ?? r.created_at);
    save(r);
    schedule(); // a release others wait for may have delivered
  }

  function startPipeline(r) {
    const started = ctx.pipelines.start({ release_id: r.release_id, project_id: r.project_id });
    if (!started.ok) return started.reason;
    r.state = "verifying";
    r.pipeline_run_id = started.run.pipeline_run_id;
    save(r);
    return "taken";
  }

  /** Every task ended: failed, or verify (a reviewed pipeline), or ready (no pipeline); an unreviewed one waits for the desk. */
  function evaluate(r) {
    if (r.state !== "in_progress" || r.tasks.length === 0) return;
    const c = P.releaseCounts(r.tasks);
    if (c.queued + c.running > 0) return;
    if (c.failed > 0) return end(r, "failed");
    if (c.done === 0) return;
    const project = projectOf(r);
    const state = project ? ctx.pipelines.state(project) : "absent";
    if (state === "absent") return end(r, "ready");
    if (state === "reviewed" && ctx.pipelines.runsAfterTasks(project)) startPipeline(r);
  }

  function startTask(r, t) {
    const prior = t.follow_up_of ? r.tasks.find((x) => x.task_id === t.follow_up_of) : null;
    const resume = prior?.session_id ? ctx.journal.session(prior.session_id)?.agent_session_ref ?? null : null;
    const prompt = t.prompt;
    Object.assign(t, { state: "running", session_id: P.mintId("ses", ctx.random), started_at: ctx.now(), prompt: null });
    ctx.journal.recordRelease(r); // running, with its session, on disk before the agent starts
    const refused = ctx.sessions.startTask({ session_id: t.session_id, project_id: r.project_id, adapter: t.adapter, model: t.model, permission_mode: t.mode, prompt, resume, name: t.label.slice(0, P.MAX_SESSION_NAME) });
    if (refused) { Object.assign(t, { state: "failed", reason: "refused", ended_at: ctx.now() }); ctx.log("task_refused", { reason: refused }); }
    save(r);
    liveNow();
    return !refused;
  }

  /** Free slots go to releases in queue order, one task per release per pass, each release up to its parallel. */
  function schedule() {
    if (ctx.paused()) return;
    let free = cap() - ctx.sessions.runningCount();
    let progressed = true;
    while (free > 0 && progressed) {
      progressed = false;
      for (const id of order) {
        if (free <= 0) break;
        const r = releases.get(id);
        if (!r || r.state !== "in_progress" || !delivered(r.after_release)) continue;
        if (r.tasks.filter((t) => t.state === "running").length >= r.parallel) continue;
        const t = r.tasks.find((x) => x.state === "queued" && !x.own && delivered(x.after_release) && (!x.follow_up_of || P.isEndedTask(r.tasks.find((y) => y.task_id === x.follow_up_of)?.state ?? "done")));
        if (!t) continue;
        if (startTask(r, t)) free -= 1;
        progressed = true;
      }
    }
    for (const r of releases.values()) evaluate(r);
  }

  /** remote-sessions.mjs reports a task's turn: completed, failed or stopped. */
  function taskEnded(sessionId, outcome) {
    const owner = taskBySession(sessionId);
    if (!owner || owner.t.state !== "running") return;
    const { r, t } = owner;
    Object.assign(t, outcome === "completed" ? { state: "done" } : outcome === "stopped" ? { state: "cancelled", reason: "stopped" } : { state: "failed", reason: "agent_failed" }, { ended_at: ctx.now() });
    save(r);
    Promise.resolve(ctx.sessions.closeTask(sessionId)).catch(() => {}).finally(() => { schedule(); liveNow(); });
    evaluate(r);
  }

  /** remote-pipeline.mjs reports a run's end. */
  function pipelineEnded(p) {
    const r = p.release_id ? releases.get(p.release_id) : null;
    // A run journaled before its release was saved verifying (a stop in between) still ends that release (P3-6).
    const unsaved = r && r.state === "in_progress" && r.pipeline_run_id === null && p.reason === "interrupted";
    if (unsaved) { r.pipeline_run_id = p.pipeline_run_id; r.state = "verifying"; }
    if (!r || r.pipeline_run_id !== p.pipeline_run_id || r.state !== "verifying") { liveSoon(); return; }
    if (p.state === "passed") end(r, "ready");
    else if (p.state === "cancelled") { r.state = "in_progress"; save(r); }
    else end(r, "failed");
    liveNow();
  }

  const reopen = (r) => {
    if (r.state === "verifying" && r.pipeline_run_id) ctx.pipelines.cancel(r.pipeline_run_id);
    if (r.state === "verifying" || r.state === "ready" || r.state === "failed") Object.assign(r, { state: "in_progress", ended_at: null });
  };

  const commands = {
    "release.create"(p, env) {
      if (releases.has(p.release_id)) return "conflict";
      if (releases.size >= MAX_RELEASES) return "busy";
      if (!ctx.projects().some((x) => x.project_id === p.project_id) || (p.after_release && !releases.has(p.after_release))) return "not_found";
      const number = Math.max(0, ...[...releases.values()].map((r) => r.number)) + 1;
      // The label is the creator's own words (the person's or the agent's), trimmed and capped; never a path or a folder name.
      const label = typeof p.label === "string" ? p.label.trim().slice(0, P.MAX_RELEASE_LABEL) || null : null;
      const r = { release_id: p.release_id, number, title: p.title, label, estimate: p.estimate ?? null, project_id: p.project_id, state: "planned", after_release: p.after_release, parallel: p.parallel, tasks: [], pipeline_run_id: null, created_at: ctx.now(), started_at: null, ended_at: null };
      releases.set(r.release_id, r);
      order.push(r.release_id);
      ctx.journal.recordReleaseOrder(order);
      save(r, env.command_id);
      return "taken";
    },
    "release.add_task"(p, env) {
      const r = releases.get(p.release_id);
      if (!r || (p.after_release && !releases.has(p.after_release)) || (p.follow_up_of && !r.tasks.some((t) => t.task_id === p.follow_up_of))) return "not_found";
      if (allTasks().some(({ t }) => t.task_id === p.task_id)) return "conflict";
      if (r.state === "released") return "unsupported";
      if (r.tasks.length >= P.MAX_RELEASE_TASKS) return "busy";
      const refused = P.checkStart({ adapter: p.adapter, model: p.model, permission_mode: p.permission_mode, resume: null, prompt: p.prompt }, adapterOf(ctx.inventory(), p.adapter));
      if (refused) return refused;
      if (p.adapter !== "claude-code") return "unsupported";
      const label = (p.label ?? p.prompt.split("\n").map((l) => l.trim()).find(Boolean) ?? "Task").slice(0, P.MAX_TASK_LABEL);
      reopen(r);
      r.tasks.push({ task_id: p.task_id, label, adapter: p.adapter, model: p.model, mode: p.permission_mode, prompt: p.prompt, state: "queued", reason: null, after_release: p.after_release, follow_up_of: p.follow_up_of, session_id: null, started_at: null, ended_at: null });
      save(r, env.command_id);
      schedule();
      return "taken";
    },
    "release.reorder"(p, env) {
      if (p.what === "tasks") {
        const r = releases.get(p.release_id);
        if (!r) return "not_found";
        const queued = r.tasks.filter((t) => t.state === "queued").map((t) => t.task_id);
        if (queued.length !== p.task_ids.length || !queued.every((id) => p.task_ids.includes(id))) return "conflict";
        const next = [...p.task_ids], byId = new Map(r.tasks.map((t) => [t.task_id, t]));
        r.tasks = r.tasks.map((t) => (t.state === "queued" ? byId.get(next.shift()) : t)); // the queued slots, in the new order
        save(r, env.command_id);
      } else {
        const open = order.filter((id) => !P.isEndedRelease(releases.get(id).state));
        if (open.length !== p.release_ids.length || !open.every((id) => p.release_ids.includes(id))) return "conflict";
        order = [...p.release_ids, ...order.filter((id) => !p.release_ids.includes(id))];
        ctx.journal.recordReleaseOrder(order);
        for (const id of p.release_ids) save(releases.get(id), env.command_id);
      }
      schedule();
      return "taken";
    },
    async "release.cancel_task"(p) {
      const r = releases.get(p.release_id);
      const t = r?.tasks.find((x) => x.task_id === p.task_id);
      if (!t) return "not_found";
      if (t.state === "queued") { Object.assign(t, { state: "cancelled", prompt: null, ended_at: ctx.now() }); save(r); evaluate(r); schedule(); return "taken"; }
      if (t.state !== "running") return "unsupported";
      if (!(await ctx.sessions.stopTask(t.session_id))) taskEnded(t.session_id, "stopped"); // its agent was already gone
      return "taken";
    },
    "release.start"(p, env) {
      const r = releases.get(p.release_id);
      if (!r) return "not_found";
      if (r.state !== "planned") return r.state === "in_progress" ? "taken" : "unsupported";
      Object.assign(r, { state: "in_progress", started_at: ctx.now() });
      save(r, env.command_id);
      schedule();
      return "taken";
    },
    "release.list"(p, env) {
      const all = [...releases.values()].filter((r) => p.project_id === null || r.project_id === p.project_id).sort((a, b) => b.number - a.number);
      const after = all.filter((r) => p.before_number === null || r.number < p.before_number);
      const page = after.slice(0, p.limit);
      ctx.emit(null, "release.page", { releases: page.map(body), next_before: after.length > page.length ? page.at(-1).number : null, total: all.length }, env.command_id);
      return "taken";
    },
    "pipeline.start"(p) {
      const r = releases.get(p.release_id);
      if (!r) return "not_found";
      if (!["in_progress", "ready", "failed"].includes(r.state)) return r.state === "verifying" ? "busy" : "unsupported";
      const c = P.releaseCounts(r.tasks);
      if (c.queued + c.running > 0) return "busy";
      return startPipeline(r);
    },
    "pipeline.cancel"(p) { return ctx.pipelines.cancel(p.pipeline_run_id) ? "taken" : "not_found"; },
  };

  // The local agent plans its own work (remote-release-plans.mjs): the same queue, scoped to the session's project.
  const plan = createPlanner({ ctx, releases, order: () => order, commands, save, reopen, evaluate, liveSoon, allTasks });

  return {
    plan,
    /** One release or pipeline command → "taken" or a reject reason. */
    handle: async (env, payload) => (Object.hasOwn(commands, env.type) ? commands[env.type](payload, env) : "unknown_type"),
    taskEnded,
    pipelineEnded,
    activity: liveSoon,
    /** At start: tasks an earlier daemon left running are interrupted (never run again); queued ones wait and run. */
    recover() {
      let interrupted = 0;
      for (const r of releases.values()) {
        const open = r.tasks.filter((t) => t.state === "running");
        for (const t of open) Object.assign(t, { state: "failed", reason: "interrupted", ended_at: Math.max(ctx.now(), t.started_at ?? 0) });
        if (open.length > 0) { interrupted += open.length; save(r); }
      }
      return interrupted;
    },
    /** The desk's marks (`worktrust remote releases released <n>`), and whatever a freed slot or a lifted pause allows. */
    poll() {
      const marks = new Set(ctx.deskMarks());
      for (const r of releases.values()) if (r.state === "ready" && marks.has(r.number)) { r.state = "released"; save(r); }
      schedule();
    },
    schedule,
    /** The release task a session runs for, or null (the inventory's project tree). */
    ownerOf: (sessionId) => { const o = taskBySession(sessionId); return o ? { release_id: o.r.release_id, task_id: o.t.task_id } : null; },
    body: (id) => (releases.has(id) ? body(releases.get(id)) : null),
    all: () => [...releases.values()].map(body),
    live,
  };
}
