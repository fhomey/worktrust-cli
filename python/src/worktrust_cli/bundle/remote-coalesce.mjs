/**
 * AT MOST ONE EVENT PER KEY PER WINDOW (moved from remote-sessions.mjs, 2026-11-07, unchanged). Used for tokens, a running
 * subagent's counts, a pipeline's live counts and the live feed.
 */
import * as P from "./remote-protocol.mjs";

/**
 * AT MOST ONE EVENT PER KEY PER WINDOW (docs/remote-agents/PROTOCOL.md, "Progress the phone can trust"). `offer` sends at
 * once when the key's window has passed, else keeps the latest and sends it when the window ends; `now` sends at once and
 * drops what waited (a turn's final total, a subagent's end); `flush` sends everything that waits (before a turn's end).
 */
export function createCoalescer({ now, windowMs = P.USAGE_MIN_INTERVAL_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const keys = new Map(); // key -> { last, pending, timer }
  const fire = (key) => {
    const k = keys.get(key);
    if (!k) return;
    k.timer = null;
    if (!k.pending) return;
    const go = k.pending;
    k.pending = null; k.last = now();
    go();
  };
  return {
    offer(key, go) {
      const k = keys.get(key) ?? { last: -Infinity, pending: null, timer: null };
      keys.set(key, k);
      if (k.timer === null && now() - k.last >= windowMs) { k.last = now(); go(); return; }
      k.pending = go;
      if (k.timer === null) { k.timer = setTimer(() => fire(key), Math.max(0, k.last + windowMs - now())); k.timer?.unref?.(); }
    },
    now(key, go) {
      const k = keys.get(key);
      if (k?.timer) clearTimer(k.timer);
      keys.set(key, { last: now(), pending: null, timer: null });
      go();
    },
    flush() { for (const [key, k] of keys) { if (k.timer) clearTimer(k.timer); fire(key); } },
    waiting: () => [...keys.values()].filter((k) => k.pending).length,
  };
}
