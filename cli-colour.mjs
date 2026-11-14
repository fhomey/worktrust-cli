/**
 * COLOUR WITH MEANING (CLI 0.11.8, owner 2026-11-13). One small module, no dependency, used by the menu (cli-menu.mjs) and by
 * the commands' status lines (worktrust.mjs `say`, so update, check, status, remote and the rest speak the same way):
 *
 *   accent   a spinner while something runs        green   a success line (✓, Done)
 *   yellow   a warning (!)                         red     an error (✗, `worktrust: …` on stderr; the exit code stays as it was)
 *   dim      secondary text: the command an item runs, a hint          bold    a title
 *
 * NEVER COLOUR ALONE: a colour only wraps a line that already carries its word or symbol; with colours off the text is byte
 * for byte what it was before 0.11.8. And colours are OFF (colourWanted) for anything a program reads: a hook, the MCP door,
 * a pipe, CI. In order: a hook or the MCP door never, whatever is set; `--no-color` and NO_COLOR turn them off; FORCE_COLOR
 * turns them on (0 or false: off); otherwise only on a terminal whose TERM is not `dumb`. Windows: Node's console layer
 * translates these sequences on a real terminal from Windows 10 on; an older console stays plain.
 */
import { release } from "node:os";

/** Whether this stream gets colours. Pure: the caller passes what it knows. `machine`: a hook or the MCP door is speaking. */
export function colourWanted({ env = {}, args = [], isTTY = false, platform = "", osRelease = "", machine = false } = {}) {
  if (machine || env.WORKTRUST_HOOK_INPUT || env.WORKTRUST_MCP_TOKEN) return false;
  if (args.includes("--no-color") || args.includes("--no-colour")) return false;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return !["0", "false"].includes(String(env.FORCE_COLOR).toLowerCase());
  if (!isTTY || env.TERM === "dumb") return false;
  if (platform === "win32" && Number(String(osRelease).split(".")[0]) < 10) return false;
  return true;
}

const SGR = { bold: "1", dim: "2", inverse: "7", red: "31", green: "32", yellow: "33", accent: "36" };

/** The painters for one answer of colourWanted. Off, each returns its text unchanged. */
export function painter(on) {
  const wrap = (code) => (text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
  const p = Object.fromEntries(Object.entries(SGR).map(([name, code]) => [name, wrap(code)]));
  /** A whole status line by the symbol or word it already carries; any other line is returned as it is. */
  const status = (line) => {
    if (!on || typeof line !== "string" || line === "") return line;
    if (/^\s*✓ /.test(line) || /^\s*Done\b/.test(line)) return p.green(line);
    if (/^\s*! /.test(line)) return p.yellow(line);
    if (/^\s*✗ /.test(line) || /^worktrust: /.test(line)) return p.red(line);
    if (/^\s*WorkTrust · /.test(line)) return p.bold(line);
    return line;
  };
  return { on: Boolean(on), ...p, status };
}

/** The painters for a stream of this process (stdout by default), by this process's own environment and arguments. */
export function coloursFor(stream = process.stdout, { machine = false } = {}) {
  return painter(colourWanted({ env: process.env, args: process.argv.slice(2), isTTY: Boolean(stream?.isTTY), platform: process.platform, osRelease: release(), machine }));
}

/** What a person sees of a text: its length without the colour sequences. */
export const visibleLength = (text) => [...String(text).replace(/\x1b\[[0-9;]*m/g, "")].length;

/** A text cut to `width` visible characters (… at the cut), its colour sequences kept and closed. A line never wraps. */
export function clip(text, width) {
  if (width < 1 || visibleLength(text) <= width) return text;
  let out = "", seen = 0;
  for (const part of String(text).split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    for (const char of part) { if (seen === width - 1) return `${out}…${text.includes("\x1b[") ? "\x1b[0m" : ""}`; out += char; seen += 1; }
  }
  return out;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A spinner in the accent colour while something runs: → stop(). Only on a real terminal with colours on; anywhere else it
 * writes nothing at all, so a pipe, a hook and CI read the same bytes as before. stop() removes the line it drew.
 * It draws on the line the cursor is on, which must be empty: start it between lines, never in the middle of one.
 */
export function spinner(words, { stream = process.stdout, paint = coloursFor(stream), interval = 80, delay = 150 } = {}) {
  if (!paint.on || !stream?.isTTY) return () => {};
  let at = 0, shown = false, stopped = false, timer = null;
  const frame = () => { shown = true; stream.write(`\r  ${paint.accent(FRAMES[at % FRAMES.length])} ${paint.dim(words)}\x1b[K`); at += 1; };
  // Work that ends at once shows no spinner at all: a line that flashes is worse than none.
  const wait = setTimeout(() => { frame(); timer = setInterval(frame, interval); timer.unref?.(); }, delay);
  wait.unref?.();
  return () => { if (stopped) return; stopped = true; clearTimeout(wait); clearInterval(timer); if (shown) stream.write("\r\x1b[K"); };
}

/** Run `work` behind a spinner; the spinner is gone before anything else is said, also when the work fails. */
export async function busyWith(words, work, options) {
  const stop = spinner(words, options);
  try { return await work(); } finally { stop(); }
}
