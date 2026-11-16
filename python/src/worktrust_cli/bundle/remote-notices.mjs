/**
 * THE SEALED NOTICES THIS COMPUTER SENDS (release 38, owner 2026-11-16; packages/remote-protocol/src/notice.ts,
 * docs/LIVE-ACTIVITY-PUSH.md §4). A phone follows a session with its app closed: the Live Activity on its lock screen and
 * the "Done" / "Needs your approval" alerts. The words on that lock screen are opened ON THE PHONE by its notification
 * extensions; the gateway and Apple carry a box they cannot open.
 *
 *   keys      a phone hands this computer its notice key with the sealed command `notice.key` (one per phone, the previous
 *             one kept a day for notices in flight); `key: null` ends them; a phone that goes takes its keys along
 *             (dropPhone in the daemon, dropNoticeKeysOf when `remote disconnect` or `remote phones remove` takes it off
 *             at this keyboard; `remote disable --forget` deletes the file). Kept in ~/.worktrust/remote/notice-keys.json
 *             (0600, like every file here); the daemon reads the file again before each change, so a removal made by
 *             another process is never written back
 *   tracker   reads the events this computer is about to seal (never a replay, never the transient lane) and names a
 *             milestone: started, a step, needs you, done, failed, stopped. `n of m` only from the agent's own plan (its
 *             completed items of all items); without a plan, `n` is the steps started and `m` is null. A step of the same
 *             phase at most once per ten seconds; a change of phase at once
 *   seal      two names (this computer's, the session's project folder), the two counts, the kind and the event's time:
 *             nothing an agent wrote can enter a notice, because the plaintext has no field for it
 */
import { basename } from "node:path";
import { hostname } from "node:os";
import * as P from "./remote-protocol.mjs";
import { readJson, writeJson } from "./remote-store.mjs";

export const STEP_EVERY_MS = 10_000;
const PREVIOUS_KEY_MS = 24 * 60 * 60 * 1000;
const LONGEST_KEY_MS = 8 * 24 * 60 * 60 * 1000;
const MILESTONES = { "agent.approval_required": "needs_you", "agent.question": "needs_you", "agent.attention": "needs_you", "agent.completed": "done", "agent.failed": "failed", "agent.stopped": "stopped" };

/** This computer's name on a lock screen: its host name without `.local`, as `worktrust remote` pairs it. */
export const computerName = (host = hostname()) => P.noticeName(String(host).replace(/\.local$/i, ""));

/** A phone's `notice.key`: the new key kept, the previous one for a day at most, or (key null) none of that phone's. */
export function takeNoticeKey(keys, phone, payload, now) {
  const others = keys.filter((k) => k.phone !== phone);
  if (payload.key === null) return others;
  const mine = keys.filter((k) => k.phone === phone && k.kid !== payload.kid && k.not_after > now).sort((a, b) => b.at - a.at).slice(0, 1)
    .map((k) => ({ ...k, not_after: Math.min(k.not_after, now + PREVIOUS_KEY_MS) }));
  return [...others, ...mine, { phone, kid: payload.kid, key: payload.key, not_after: Math.min(payload.not_after, now + LONGEST_KEY_MS), at: now }];
}

const KEYS_FILE = "notice-keys.json";
const readKeys = () => (readJson(KEYS_FILE) ?? { keys: [] }).keys ?? [];
const writeKeys = (keys) => writeJson(KEYS_FILE, { v: 1, keys });

/** Phones taken off this computer at the keyboard (remote-connections.mjs removePhones): their notice keys go with them. */
export function dropNoticeKeysOf(deviceIds) {
  const gone = new Set(deviceIds), keys = readKeys();
  if (keys.some((k) => gone.has(k.phone))) writeKeys(keys.filter((k) => !gone.has(k.phone)));
}

/** The milestone an event is, from what this session showed before (`s`, changed in place), or null. */
export function milestoneOf(s, record, now) {
  const { type, body } = record;
  if (type === "session.created") { s.project = typeof body?.project_label === "string" ? body.project_label : s.project; return phase(s, "started", now); }
  if (type === "agent.plan") {
    const items = Array.isArray(body?.items) ? body.items : [];
    const done = items.filter((i) => i.state === "completed").length;
    const before = s.plan;
    s.plan = body?.items_cut === true || items.length === 0 ? { done: null, all: null } : { done, all: items.length };
    if (before && before.done === s.plan.done && before.all === s.plan.all) return null;
    return step(s, now);
  }
  if (type === "agent.step_started") { s.steps += 1; return s.plan && s.plan.all !== null ? null : step(s, now); }
  if (type === "agent.resumed") return step(s, now);
  if (Object.hasOwn(MILESTONES, type)) return phase(s, MILESTONES[type], now);
  return null;
}
const counts = (s) => (s.plan && s.plan.all !== null ? { n: s.plan.done, m: s.plan.all } : { n: s.steps, m: null });
function phase(s, kind, now) {
  s.phase = P.phaseOfKind(kind);
  if (kind === "started") s.lastStepAt = now;
  return { kind, ...counts(s) };
}
function step(s, now) {
  if (s.phase === "running" && now - s.lastStepAt < STEP_EVERY_MS) return null;
  s.phase = "running";
  s.lastStepAt = now;
  return { kind: "step", ...counts(s) };
}

/**
 * o: { now(), random, projectOf(session_id) -> folder name or null, host? }. `observe` before the channels are sealed,
 * `sealFor` once per channel (its phone's key), `takeKey` for notice.key, `dropPhone` when a phone goes.
 */
export function createNotices(o) {
  let keys = readKeys();
  const sessions = new Map();
  const computer = computerName(o.host);
  const save = () => writeKeys(keys);
  return {
    observe(record) {
      if (!record.session_id || record.lane) return null;
      const s = sessions.get(record.session_id) ?? { project: null, plan: null, steps: 0, phase: null, lastStepAt: 0 };
      sessions.set(record.session_id, s);
      const m = milestoneOf(s, record, o.now());
      if (m && P.FINAL_PHASES.has(P.phaseOfKind(m.kind))) sessions.delete(record.session_id);
      return m && keys.length > 0 ? { ...m, project: s.project } : null;
    },
    sealFor(phone, record, m) {
      const k = keys.filter((x) => x.phone === phone && x.not_after > o.now()).sort((a, b) => b.at - a.at)[0];
      const key = k ? P.fromBase64Url(k.key) : null;
      if (!key) return null;
      const project = m.project ?? o.projectOf?.(record.session_id) ?? null;
      const plain = { v: 1, kind: m.kind, c: computer, p: P.noticeName(project), n: Math.min(m.n, P.MAX_NOTICE_COUNT), m: m.m === null ? null : Math.min(m.m, P.MAX_NOTICE_COUNT), at: record.occurred_at };
      return P.sealNotice({ key, kid: k.kid, session_id: record.session_id, seq: record.event_seq, plain }, o.random);
    },
    takeKey(phone, payload) { keys = takeNoticeKey(readKeys(), phone, payload, o.now()); save(); },
    dropPhone(phone) { keys = readKeys(); if (keys.some((k) => k.phone === phone)) { keys = keys.filter((k) => k.phone !== phone); save(); } },
    /** Tests only. */
    _keys: () => keys,
  };
}

/** The project folder's name for a session the tracker never saw start (a desk session followed later). */
export const projectNameOf = (sessions, projects) => (sessionId) => {
  const row = sessions?.()?.find((x) => x.session_id === sessionId);
  const project = row?.project_id ? projects().find((p) => p.project_id === row.project_id) : null;
  return project ? basename(project.path) || null : null;
};
