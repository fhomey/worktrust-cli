/**
 * THE APPROVAL'S CLOCK IN THE TERMINAL (CLI 0.11.7, owner 2026-11-12, after testing `remote app` live). While `remote app`
 * or `remote web` waits for the approval, a bar under the QR or link drains over the request's own window (the issuer's
 * answer, never a fixed ten minutes), redrawn in place once a second: `[████████░░░░] 7:41 left`. Without a terminal the
 * expiry time is printed once. The bar reads no key and never touches raw mode; waitKey (the "new QR code?" question after
 * an expiry) does, and always gives it back.
 */
import { emitKeypressEvents } from "node:readline";

export const BAR_WIDTH = 24;
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** One line of the bar for `left` of `windowMs` milliseconds. Pure. */
export function barLine(left, windowMs, width = BAR_WIDTH) {
  const share = windowMs > 0 ? Math.min(1, Math.max(0, left / windowMs)) : 0;
  const full = Math.round(share * width);
  return `[${"█".repeat(full)}${"░".repeat(width - full)}] ${clock(left)} left`;
}

/** Start the bar; → { stop(finalLine?) }. `out` is stdout, `tty` whether it is a terminal, `now` the clock. */
export function startCountdown({ expiresAt, windowMs, out = process.stdout, tty = Boolean(process.stdout.isTTY), now = Date.now }) {
  if (!tty) {
    out.write(`  This request expires at ${new Date(expiresAt).toTimeString().slice(0, 5)} (in ${clock(expiresAt - now())}).\n`);
    return { stop: (line) => { if (line) out.write(`  ${line}\n`); } };
  }
  const draw = () => out.write(`\r\x1b[2K  ${barLine(expiresAt - now(), windowMs)}`);
  draw();
  const timer = setInterval(draw, 1000);
  timer.unref?.();
  let stopped = false;
  return {
    stop(line) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      out.write(`\r\x1b[2K${line ? `  ${line}` : ""}\n`);
    },
  };
}

/** One key from a terminal: "enter", "q" or another; null without a terminal. Raw mode only for that key, always restored. */
export function waitKey(input = process.stdin) {
  if (!input.isTTY) return Promise.resolve(null);
  emitKeypressEvents(input);
  return new Promise((resolve) => {
    const done = (value) => { input.off("keypress", on); try { input.setRawMode(false); } catch { /* gone */ } input.pause(); resolve(value); };
    const on = (str, k = {}) => done(k.ctrl && k.name === "c" ? "q" : k.name === "return" || k.name === "enter" ? "enter" : (k.name ?? str ?? "").toLowerCase());
    try { input.setRawMode(true); } catch { resolve(null); return; }
    input.resume();
    input.on("keypress", on);
  });
}
