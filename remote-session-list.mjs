/**
 * WHAT THE SESSIONS REPORT, split out of remote-sessions.mjs (its size), unchanged: the project tree's session list (the
 * journal's sessions and the live ones, as device.inventory lists them), a session's status.report and the live feed's rows.
 */
import * as P from "./remote-protocol.mjs";

const NO_ETA = { kind: "unavailable", source: "none", reason: "no_source" };

/** The agent's own plan as the denominator when it has one; otherwise the steps counted (never a percentage). */
export const progressOf = (s) => {
  const plan = P.planProgress(s.state.progress?.plan ?? null);
  return plan.kind === "measured" ? plan : { kind: "steps", started: s.state.started, completed: s.state.completed };
};

/** One session's status.report: its commands, attention, progress and open approvals. */
export const statusReport = (ctx, s) => {
  const commands = ctx.journal.commandsOf(s.session_id).slice(-100);
  return { state: commands.at(-1)?.state ?? "DEVICE_RECEIVED", control: "none", attention: s.attention, last_event_seq: ctx.journal.lastSeq(s.session_id),
    progress: progressOf(s), eta: NO_ETA, pending_approvals: ctx.approvals.pendingOf(s.session_id).slice(0, 16), commands };
};

/** The live feed's rows (live.ts), without the release mapping the scheduler adds. */
export const activeRows = (live) => [...live.values()].filter((s) => s.run && !s.closed).map((s) => {
  const open = [...s.subagents.values()].filter((a) => !P.isFinalSubagentState(a.state));
  return { session_id: s.session_id, project_id: s.project_id, adapter: s.adapter, activity: s.attention?.activity ?? "unknown", progress: progressOf(s), tokens: s.tokens,
    started_at: s.turnOpen ? s.turnStartedAt : null, subagents: open.slice(0, P.MAX_ACTIVE_SUBAGENTS), subagents_cut: open.length > P.MAX_ACTIVE_SUBAGENTS };
});

/**
 * The project tree (2026-11-07): every session this computer knows, live first in its state, then those the journal
 * holds (closed, or waiting to resume after a restart), newest activity first. Names and models are sealed.
 */
export function listSessions(ctx, live) {
  const rows = new Map();
  for (const j of ctx.journal.sessions()) {
    if (!j.session_id || !j.adapter) continue;
    rows.set(j.session_id, { session_id: j.session_id, project_id: j.project_id ?? null, adapter: j.adapter, origin: "phone", attention: { activity: "unknown", needs: null, state_change_seq: 0, completion_seq: null }, title: null,
      name: j.name ?? null, model: j.model ?? null, state: j.closed ? "closed" : "idle", last_activity_at: ctx.journal.lastAt(j.session_id) ?? j.at ?? null });
  }
  for (const s of live.values()) {
    if (s.closed) continue;
    const prior = rows.get(s.session_id);
    rows.set(s.session_id, { ...(prior ?? {}), session_id: s.session_id, project_id: s.project_id, adapter: s.adapter, origin: "phone", attention: s.attention ?? { activity: "unknown", needs: null, state_change_seq: 0, completion_seq: null }, title: null,
      name: s.name ?? null, model: s.model ?? null, state: s.turnOpen ? "running" : "idle", last_activity_at: ctx.journal.lastAt(s.session_id) ?? prior?.last_activity_at ?? null,
      ...(s.jobs ? { background_jobs: Math.min(99, s.jobs.size) } : {}) });
  }
  return [...rows.values()].sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
}
