/**
 * THE COMPUTER PACES ITS OWN FRAMES (2026-11-16, docs/remote-agents/CHAT-HISTORY.md §4.1; PROTOCOL.md §Catch-up).
 *
 * The gateway allows a socket 50 frames a second (burst 200) and 16 MiB per ten seconds, drops a frame over the limit
 * with `error: rate_limited`, and closes the socket with 4029 on the twenty-first such frame. A phone that came back and
 * asked for several sessions at once got more than a thousand re-sealed events in one tick, and the computer's link was
 * closed for it (the owner's build 23, 2026-11-16). So every frame the computer sends to the relay goes through here,
 * and remote-transport.mjs has no other way to write to its socket (check-remote-cli rule N):
 *
 *   ONE FIFO   order is kept (the channel's replay window of 128, and a catch-up page ends with its acceptance).
 *   TWO BUCKETS  40 frames a second with a burst of 120, and 1 MiB a second with a burst of 4 MiB, by the gateway's own
 *              weight of a frame (three quarters of its characters): 80 % and about 60 % of what the gateway allows.
 *   BACK OFF   the gateway's `rate_limited` empties both buckets and halves both rates for ten seconds (logged
 *              `paced_back`): another process's clock, a gateway with lower limits.
 *   DEPTH      above 2,000 waiting frames or 8 MiB, waiting transient frames older than two seconds go first (a stale
 *              screen), then waiting replayed frames (the phone asks its page again); a journaled live event is NEVER
 *              dropped here, whatever the depth. And a transient frame that reaches the head of the queue older than two
 *              seconds is not written at all: a stale screen is not worth the place of the live event behind it (a live
 *              preview at five frames a second would otherwise hold everything back by the seconds it is behind).
 *   ROOM       `room()` resolves once fewer than a batch waits: a catch-up seals its next twenty events only then, so a
 *              live event never waits behind more than about a second of replay (remote-catch-up.mjs).
 *   URGENT     the answer to a challenge and the heartbeat go at once and are counted (the buckets may go below zero).
 *
 * Pure over `write`, `now` and `later`: scripts/test-remote-pace.mjs runs it against the real gateway's hub.
 */
export const PACE = Object.freeze({
  framesPerSecond: 40, frameBurst: 120, bytesPerSecond: 1024 * 1024, byteBurst: 4 * 1024 * 1024,
  backMs: 10_000, maxFrames: 2000, maxBytes: 8 * 1024 * 1024, staleMs: 2000, batch: 20, roomBytes: 256 * 1024,
});
/** The gateway's own weight of a frame (apps/worktrust/remote/src/limits.mjs): base64 text is four characters per three bytes. */
export const frameWeight = (chars) => Math.ceil((chars * 3) / 4);
/** What a frame is to the depth rule: a control frame and a journaled live event are never dropped. */
export const KINDS = Object.freeze(["control", "live", "replay", "transient"]);

export function createPacer({ write, now = Date.now, log = () => {}, limits = PACE, later = setTimeout, cancel = clearTimeout }) {
  const queue = []; // { text, weight, kind, at }
  let frames = limits.frameBurst, bytes = limits.byteBurst, filledAt = now(), slowUntil = 0, queued = 0, timer = null;
  const waiters = [];

  const refill = () => {
    const t = now(), elapsed = Math.max(0, t - filledAt) / 1000, rate = t < slowUntil ? 0.5 : 1;
    filledAt = t; // a clock that stepped back refills nothing
    frames = Math.min(limits.frameBurst, frames + elapsed * limits.framesPerSecond * rate);
    bytes = Math.min(limits.byteBurst, bytes + elapsed * limits.bytesPerSecond * rate);
  };
  const hasRoom = () => queue.length < limits.batch && queued < limits.roomBytes;
  const settle = () => { if (hasRoom()) for (const done of waiters.splice(0)) done(); };

  function pump() {
    if (timer !== null) { cancel(timer); timer = null; }
    refill();
    let late = 0;
    for (;;) {
      while (queue.length > 0 && queue[0].kind === "transient" && now() - queue[0].at > limits.staleMs) { queued -= queue.shift().weight; late += 1; }
      if (queue.length === 0 || frames < 1 || bytes < queue[0].weight) break;
      const next = queue.shift();
      frames -= 1; bytes -= next.weight; queued -= next.weight;
      write(next.text);
    }
    if (late > 0) log("paced_dropped", { transient: late, replayed: 0 });
    settle();
    if (queue.length === 0) return;
    const rate = now() < slowUntil ? 0.5 : 1;
    const wait = Math.max((1 - frames) / (limits.framesPerSecond * rate), (queue[0].weight - bytes) / (limits.bytesPerSecond * rate));
    timer = later(() => { timer = null; pump(); }, Math.max(5, Math.ceil(wait * 1000)));
  }

  /** THE DEPTH RULE: stale transient frames, then replayed ones; never a control frame, never a journaled live event. */
  function trim() {
    const over = () => queue.length > limits.maxFrames || queued > limits.maxBytes;
    if (!over()) return;
    const t = now(), dropped = { transient: 0, replayed: 0 };
    const drop = (test, counted) => { for (let i = 0; i < queue.length && over();) { if (test(queue[i])) { queued -= queue[i].weight; queue.splice(i, 1); dropped[counted] += 1; } else i += 1; } };
    drop((f) => f.kind === "transient" && t - f.at > limits.staleMs, "transient");
    drop((f) => f.kind === "replay", "replayed");
    if (dropped.transient + dropped.replayed > 0) log("paced_dropped", dropped);
  }

  return {
    /** One frame, in order. → true: it will be written (or dropped by the depth rule, never a live event). */
    push(text, kind = "live") {
      const weight = frameWeight(text.length);
      queue.push({ text, weight, kind: KINDS.includes(kind) ? kind : "live", at: now() });
      queued += weight;
      trim();
      pump();
      return true;
    },
    /** Written now, counted: the answer to a challenge, the heartbeat. */
    urgent(text) { refill(); frames -= 1; bytes -= frameWeight(text.length); write(text); },
    /** Resolves when fewer than a batch waits (at once when so): the next batch of a catch-up is sealed only then. */
    room() { return hasRoom() ? Promise.resolve() : new Promise((done) => waiters.push(done)); },
    /** The gateway said `rate_limited`: nothing more now, and half the rate for ten seconds. */
    slow() { refill(); frames = Math.min(frames, 0); bytes = Math.min(bytes, 0); slowUntil = now() + limits.backMs; log("paced_back", { ms: limits.backMs, waiting: queue.length }); pump(); },
    /** The socket closed: what waited was sealed for it and is gone with it (a phone asks its journal page again). */
    clear() { if (timer !== null) { cancel(timer); timer = null; } queue.length = 0; queued = 0; settle(); },
    depth: () => ({ frames: queue.length, bytes: queued }),
  };
}
