/**
 * THE PROJECT TREE'S SESSION LIST, split out of remote-sessions.mjs (its size), unchanged: the journal's sessions and the
 * live ones, as device.inventory lists them.
 */

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
