/**
 * THE LONG STEPS, AS THEY GO, AND A STOP THAT LEAVES NOTHING HALF DONE (owner, incident 2026-11-05). `npx worktrust history
 * --export` of 5,003 conversations read a 4 GB archive and sent about 45 batches for many minutes with nothing on the screen,
 * and Ctrl+C had no handler. Reads no file and no network; counts only, never a title, a text or a file's name.
 *
 * THE EVENTS. The hook, asked by WORKTRUST_HISTORY_PROGRESS, hands each step's counts on (`progressSink`): "1" prints one JSON
 * line each on stdout ({"history_progress":{phase,…}}) for the command to draw; "stderr" draws them here, on stderr (preserve
 * reads the hook's stdout as the archive's lines). Written with writeSync, so a long synchronous read still shows as it goes.
 *
 *   phase read    { unit, part, parts, bytes?, size?, conversations? }   reading an export's parts, or the sessions here
 *   phase plan    { batches, lines }                  what the send will be (the read is closed, the stop hint said once)
 *   phase batch   { lines, landed }                   a batch confirmed (or already held), or one that did not arrive
 *   phase resend  { lines, stored?, unsent? }         a batch the door landed in part, sent again at once
 *   phase wait    { seconds }                         the door's upload limit per minute, waited out
 *
 * THE DISPLAY. On a terminal ONE line rewritten in place (\r, no spinner), redrawn each second: a bar, the counts, percent,
 * elapsed and, sending, the time left from the rate so far, waits included (said once two batches landed). A resend and a wait
 * are said on lines of their own. Not a terminal (piped, CI): a reading line per tenth, a line per batch, never a carriage
 * return or an escape. `end()` closes with the totals; `stop()` with where it stopped and how to go on.
 */
import { writeSync } from "node:fs";

const thousands = (n) => Number(n).toLocaleString("en-US");
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
/** 12s, 4m10s, 1h04m. */
export const took = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const UNITS = { parts: ["part", "parts"], sessions: ["session", "sessions"] };
const bar = (percent) => { const full = Math.min(16, Math.floor((16 * percent) / 100)); return "▓".repeat(full) + "░".repeat(16 - full); };
export const CONTINUE = "Run the same command again to continue: a line already received is kept once.";

export function historyProgress({ stream = process.stdout, now = Date.now } = {}) {
  const tty = stream?.isTTY === true;
  let plan = null, started = null, landed = 0, lines = 0, tried = 0, open = false, ticking = null, read = null, ended = false;
  const of = () => Math.max(plan?.lines ?? 0, lines);
  const percent = () => (of() ? Math.floor((100 * lines) / of()) : 0);
  const elapsed = (from = started) => took(now() - (from ?? now()));
  // The rate so far, over the whole time since the send began (a wait or a resend included), never a guess before two batches.
  const left = () => {
    if (landed < 2 || lines >= of()) return "";
    const spent = now() - started;
    if (!(spent > 0)) return "";
    const seconds = ((of() - lines) * spent) / lines / 1000;
    return seconds < 60 ? " · <1 min left" : ` · ~${Math.round(seconds / 60)} min left`;
  };
  const totals = () => `${landed}/${Math.max(plan?.batches ?? 0, landed)} batches · ${thousands(lines)}/${thousands(of())} lines · ${percent()}% · ${elapsed()}`;
  // Reading: by bytes when the size is known (an export's parts), else by the count (the sessions here).
  const readPercent = () => (read.size > 0 ? Math.min(100, Math.floor((100 * read.bytes) / read.size)) : read.parts > 0 ? Math.floor((100 * read.part) / read.parts) : 0);
  const readCounts = () => `${thousands(read.part)}/${thousands(read.parts)} ${UNITS[read.unit]?.[read.parts === 1 ? 0 : 1] ?? "parts"}${read.conversations !== null ? ` · ${thousands(read.conversations)} conversations` : ""}`;
  const line = () => (read && !plan ? `  Reading  ${bar(readPercent())}  ${readCounts()} · ${readPercent()}% · ${elapsed(read.started)}` : `  Sending  ${bar(percent())}  ${totals()}${left()}`);
  const draw = () => { if (!tty || (!plan && !read)) return; stream.write(`\r\x1b[K${line()}`); open = true; };
  const clear = () => { if (open) stream.write("\r\x1b[K"); open = false; };
  const note = (text) => { if (tty) { clear(); stream.write(`  ${text}\n`); draw(); } else stream.write(`  ${text}\n`); };
  const tick = () => { if (tty && !ticking) { ticking = setInterval(() => { if (open) draw(); }, 1000); ticking.unref?.(); } };
  const closeRead = () => { if (!read || read.closed) return; read.closed = true; clear(); stream.write(`  Read ${readCounts()} · ${elapsed(read.started)}\n`); };
  const handle = (event) => {
    if (event.phase === "read") {
      if (plan) return;
      const unit = event.unit === "sessions" ? "sessions" : "parts";
      if (!read || read.unit !== unit) read = { unit, started: now(), step: -1, closed: false };
      Object.assign(read, { part: count(event.part), parts: Math.max(count(event.parts), count(event.part)), bytes: count(event.bytes), size: count(event.size), conversations: Number.isSafeInteger(event.conversations) ? event.conversations : null });
      if (tty) { draw(); tick(); return; }
      const step = Math.floor(readPercent() / 10);
      if (step > read.step) { read.step = step; stream.write(`  reading ${readCounts()} · ${readPercent()}% · ${elapsed(read.started)}\n`); }
      return;
    }
    if (event.phase === "plan") {
      closeRead();
      plan = { batches: count(event.batches), lines: count(event.lines) };
      started ??= now();
      stream.write(tty ? "\x1b[2m  Ctrl+C stops; run it again to continue.\x1b[22m\n" : "  Ctrl+C stops; run it again to continue.\n");
      draw(); tick();
      return;
    }
    started ??= now();
    if (event.phase === "batch") {
      tried += 1;
      if (event.landed === true) { landed += 1; lines += count(event.lines); }
      if (tty) draw();
      else stream.write(`  batch ${tried}/${Math.max(plan?.batches ?? 0, tried)} · ${thousands(lines)}/${thousands(of())} lines · ${percent()}% · ${elapsed()}${left()}${event.landed === true ? "" : " · not confirmed"}\n`);
      return;
    }
    if (event.phase === "resend") {
      const n = count(event.lines), unsent = Number.isSafeInteger(event.unsent) ? event.unsent : null, stored = Number.isSafeInteger(event.stored) ? event.stored : null;
      const what = unsent !== null && n >= unsent ? `${n - unsent} of ${n} stored` : stored !== null ? `${stored} new lines stored` : "not confirmed";
      note(`batch ${tried + 1}: ${what}, ${unsent !== null || stored !== null ? "resending the rest" : "sending it once more"}`);
      return;
    }
    if (event.phase === "wait") note(`waiting ${count(event.seconds)} s: upload limit per minute`);
  };
  const quiet = () => { if (ticking) { clearInterval(ticking); ticking = null; } };
  return {
    event(event) { if (event && typeof event === "object") handle(event); },
    line(text) {
      if (typeof text !== "string" || !text.startsWith('{"history_progress":')) return false;
      try { const event = JSON.parse(text).history_progress; if (event && typeof event === "object") handle(event); } catch { /* a torn event is dropped, never printed */ }
      return true;
    },
    end() {
      quiet();
      if (ended) return; ended = true;
      if (!plan) { closeRead(); return; }
      clear();
      stream.write(`  ${lines >= of() && of() > 0 ? "Sent" : "Stopped"} ${totals()}\n`);
    },
    /** Ctrl+C: the line restored, where it stopped, and how to go on. */
    stop({ sending = CONTINUE, reading = "Nothing was sent; run the same command again to start again." } = {}) {
      quiet(); clear(); ended = true;
      if (plan) stream.write(`  Stopped at ${landed}/${Math.max(plan.batches, landed)} batches · ${thousands(lines)}/${thousands(of())} lines. ${sending}\n`);
      else stream.write(`  Stopped${read ? ` while reading, at ${readCounts()}` : ""}. ${reading}\n`);
    },
  };
}

/** The hook's side of the events (see above); null when nobody asked. */
export function progressSink(mode = process.env.WORKTRUST_HISTORY_PROGRESS) {
  const out = (fd) => (text) => { try { writeSync(fd, text); } catch { /* a full or closed pipe drops an event, never the run */ } return true; };
  if (mode === "1") { const write = out(1); return { event: (event) => write(`${JSON.stringify({ history_progress: event })}\n`), end() {} }; }
  if (mode !== "stderr") return null;
  const shown = historyProgress({ stream: { isTTY: process.stderr.isTTY === true, write: out(2) } });
  process.once("exit", () => shown.end()); // the totals, however the hook ends (writeSync: an exit handler may write)
  return { event: (event) => shown.event(event), end: () => shown.end() };
}

/**
 * STOPPING SAFELY (owner, 2026-11-05). The first SIGINT or SIGTERM asks a send to stop: the call in flight is abandoned through
 * `signal` (a line it carried that WorkTrust already received is kept once, so the next run sends it again safely), no batch
 * starts after it, the outbox keeps every batch not confirmed (its files are written to a temporary name and renamed, and a
 * signal is handled between, never inside, those synchronous writes), and the hook exits 130. A second one exits at once.
 */
export function stopSignals() {
  const controller = new AbortController();
  let asked = 0;
  const stop = () => { asked += 1; if (asked > 1) process.exit(130); controller.abort(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  return { get asked() { return asked > 0; }, signal: controller.signal };
}
