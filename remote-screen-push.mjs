/**
 * A TERMINAL'S SCREEN, PUSHED WHEN IT CHANGES (release 19, 2026-11-09). A phone that shows a terminal session asks with
 * `screen.read { follow: true }`; from then on, for FOLLOW_MS after its latest such read, the computer sends the screen
 * (agent.screen, no command) whenever a look at it (remote-terminal-sessions.mjs; tmux's control mode says when) finds it
 * changed. `follow: false` stops it at once for that phone. A push travels on the session's TRANSIENT LANE (envelopes.ts):
 * the computer journals none, the relay keeps none, and a phone that reconnects reads the screen again.
 *
 *   - At most one push per PUSH_MS per session; within that time the newest screen wins (a burst is one push now and one
 *     at the end of the window, never one per change).
 *   - Nothing is pushed when the screen hashes as it was last sent (a read's answer counts as sent).
 *   - Nothing is pushed while no phone follows the session, and nothing after it closed.
 *
 * WHO RECEIVES IT. Every event of a session is one ordered stream per session, sealed for each of the person's confirmed
 * phones (remote-daemon.mjs sealAll): a push to one phone only would leave a gap in the others' sequence and send each
 * of them through a reconciliation. So following decides WHETHER the computer pushes; what it pushes reaches the
 * person's confirmed phones like every other event of the session (as a read's answer already does).
 */
import { createHash } from "node:crypto";

export const PUSH_MS = 500;
export const FOLLOW_MS = 10 * 60_000;
const DEFAULT_LINES = 200;

/** The screen's lines, hashed (not the cut flag: one screen read through two windows is still one screen). */
const hashOf = (cap) => createHash("sha256").update(cap.lines.join("\n")).digest("base64url");

// ctx: { now, emit, pushMs?, followMs?, setTimer?(fn, ms), clearTimer?(t) }
export function createScreenPush(ctx) {
  const pushMs = ctx.pushMs ?? PUSH_MS, followMs = ctx.followMs ?? FOLLOW_MS;
  const later = ctx.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const cancel = ctx.clearTimer ?? clearTimeout;
  const state = (s) => (s.push ??= { followers: new Map(), sentHash: null, sentAt: -Infinity, waiting: null, timer: null });

  /** The phones following this session now (their device ids), the expired ones dropped. */
  function followers(s) {
    const p = state(s), now = ctx.now();
    for (const [phone, f] of p.followers) if (f.until <= now) p.followers.delete(phone);
    return p.followers;
  }
  const following = (s) => !s.closed && followers(s).size > 0;
  /** How many lines a look should read for the followers (the most any of them asked for). */
  const linesFor = (s) => Math.max(0, ...[...followers(s).values()].map((f) => f.lines));

  function send(s) {
    const p = state(s);
    const next = p.waiting;
    p.waiting = null;
    if (!next || !following(s) || next.hash === p.sentHash) return;
    p.sentHash = next.hash; p.sentAt = ctx.now();
    ctx.emit(s.session_id, "agent.screen", next.cap, null, "none", { transient: true }); // the transient lane: never journaled
  }

  return {
    following, linesFor,
    /** A screen.read from a phone: follow (renewed), unfollow, or neither. */
    follow(s, phone, follow, lines = DEFAULT_LINES) {
      if (typeof phone !== "string" || follow === undefined) return;
      if (follow) followers(s).set(phone, { until: ctx.now() + followMs, lines });
      else { followers(s).delete(phone); if (!following(s)) this.stop(s); }
    },
    /** A read's answer went out: the same screen is not pushed again. */
    answered(s, cap) { const p = state(s); p.sentHash = hashOf(cap); p.sentAt = ctx.now(); },
    /** A look found this screen: pushed now, or at the end of the window with the newest, or not at all. */
    offer(s, cap) {
      if (!cap || !following(s)) return;
      const p = state(s), hash = hashOf(cap);
      if (hash === p.sentHash) { p.waiting = null; return; }
      p.waiting = { cap, hash };
      const wait = p.sentAt + pushMs - ctx.now();
      if (wait <= 0) { if (p.timer) { cancel(p.timer); p.timer = null; } return send(s); }
      if (!p.timer) p.timer = later(() => { p.timer = null; send(s); }, wait);
    },
    /** The session closed or nobody follows: nothing waiting is sent. */
    stop(s) { const p = state(s); p.waiting = null; if (p.timer) { cancel(p.timer); p.timer = null; } },
  };
}
