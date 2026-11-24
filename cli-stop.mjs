/**
 * STOP WITH ESC (CLI 0.11.12, owner 2026-11-15: "while a command is running, stop it early with Esc: then it stops and you
 * get a message: go back to the menu, or press Esc to close"). Two halves, one file, no dependency.
 *
 * THE CHILD (a command the MENU started: WORKTRUST_MENU_CHILD=1 and an IPC channel to the menu, cli-menu.mjs runShown).
 * Only while the command shows it is busy (a spinner, the history progress line, the approval's countdown, the phone link
 * wait) does it read keys, in raw mode: Esc tells the menu, which stops the command (below); Ctrl+C keeps its meaning (the
 * command's own SIGINT path). Raw mode there also means a key typed while a spinner turns is never ECHOED by the terminal:
 * an echoed Enter moved the cursor down a line, and the spinner's `\r` went on drawing on the new line while the old frame
 * stayed above (the doubled "Counting what this computer measured", owner 2026-11-15; reproduced under a pty). Everywhere
 * else the command reads the terminal as before: its questions are its own and no key is taken from them.
 *
 * WHAT A STOP DOES, by what the command is doing (the stop is SIGINT, SIGTERM later; on Windows the menu's IPC "stop"):
 *   reading, waiting   it ends at once (exit 130); the scripts it started for the read are ended with it. A wait for an
 *                      approval or a phone ends its request (the phone link's invite is removed, remote-connections.mjs).
 *   writing            inside critical() a stop is held: one line "Finishing a write, then stopping…", the menu is told to
 *                      wait, and the command exits 130 the moment the write step is whole. A file is never left half-written.
 *   its own safe stop  a command that already stops safely on SIGINT (the history send, preserve, the phone link) keeps
 *                      that path; the menu is told to wait for it.
 * A menu child holds the stop handler for its whole life, so a stop lands between two steps, never inside a synchronous one
 * (Node runs a signal handler on its event loop). The exception is a command that only reads and asks nothing (status, look,
 * help: WORKTRUST_MENU_KEYS=menu): the MENU reads its keys, and outside a busy phase a stop ends it at once, mid-read.
 * Direct use (`npx worktrust <command>`, no menu) is untouched: no raw mode, no key read, Ctrl+C exactly as before.
 *
 * THE MENU (superviseChild): on the child's "esc" it sends SIGINT; when the child is still there after a short grace and has
 * not said it is finishing a write, SIGTERM, then SIGKILL as the last resort. A child finishing a write is given up to a
 * minute before that last resort; every file the CLI writes is replaced whole (temp file, then rename), so even then no file
 * is half one version and half the other.
 */
export const STOPPED = -130; // what the menu's runCli answers for a command stopped with Esc: never a real exit code

const env = process.env;
const MENU_CHILD = env.WORKTRUST_MENU_CHILD === "1" && typeof process.send === "function";
const MENU_KEYS = MENU_CHILD && env.WORKTRUST_MENU_KEYS === "menu"; // a read-only command: the menu reads its keys
const ALWAYS = MENU_CHILD && !MENU_KEYS; // the stop handler stands for the whole command
const tell = (message) => { try { process.send?.(message); } catch { /* the menu is gone */ } };

const children = new Set();
/** A script this command started; a stop during a read or a wait ends it with the command. */
export function track(child) { children.add(child); child.once?.("exit", () => children.delete(child)); return child; }

let writing = 0, watching = 0, wanted = false, said = false, input = null, raw = false;
function restore() {
  if (raw && input) { try { input.setRawMode(false); } catch { /* gone */ } raw = false; }
  try { process.stdout.write("\r\x1b[K\x1b[?25h"); } catch { /* closed */ }
}
function end() {
  for (const child of children) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
  restore();
  process.exit(130);
}
function onStop() {
  if (writing > 0) {
    wanted = true;
    tell({ wt: "finishing" });
    if (!said) { said = true; process.stderr.write("\r\x1b[K  Finishing a write, then stopping…\n"); }
    return;
  }
  if (process.listenerCount("SIGINT") > 1) { tell({ wt: "finishing" }); return; } // the command's own safe stop runs
  end();
}
const listen = () => { if (!ALWAYS && writing + watching === 1) { process.on("SIGINT", onStop); process.on("SIGTERM", onStop); } };
const unlisten = () => { if (!ALWAYS && writing + watching === 0) { process.off("SIGINT", onStop); process.off("SIGTERM", onStop); } };
if (MENU_CHILD) {
  process.channel?.unref?.(); // the channel never keeps a finished command alive
  // Windows has no SIGINT for one process: the menu's "stop" is the same stop.
  process.on("message", (message) => { if (message?.wt === "stop") { if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT", "SIGINT"); else process.exit(130); } });
  process.on("exit", () => { if (raw && input) { try { input.setRawMode(false); } catch { /* gone */ } } }); // never leave the terminal raw
  if (ALWAYS) { process.on("SIGINT", onStop); process.on("SIGTERM", onStop); }
}

/** Run one write step whole: a stop that comes during it waits for its end (menu children only; elsewhere it just runs). */
export async function critical(work) {
  if (!MENU_CHILD) return work();
  writing += 1; listen();
  try { return await work(); }
  finally { writing -= 1; unlisten(); if (writing === 0 && wanted) end(); }
}

/**
 * Read keys while the command is busy: → release(). Esc asks the menu to stop the command; Ctrl+C is the command's SIGINT,
 * as in a terminal (raw mode turns the terminal's own Ctrl+C off). Any other key is swallowed, never echoed. No-op outside
 * a menu child or without a terminal.
 */
export function watchKeys(stream = process.stdin) {
  if (!MENU_CHILD) return () => {};
  watching += 1; listen();
  if (MENU_KEYS || !stream?.isTTY) { let done = false; return () => { if (!done) { done = true; watching -= 1; unlisten(); } }; } // the menu reads the keys
  const first = watching === 1;
  const onData = (chunk) => {
    const text = String(chunk);
    if (/^\x1b+$/.test(text)) tell({ wt: "esc" }); // a lone Esc: an arrow key is ESC [ A, one chunk
    else if (text.includes("\x03")) process.emit("SIGINT", "SIGINT");
  };
  if (first) { input = stream; try { stream.setRawMode(true); raw = true; } catch { raw = false; } stream.resume(); }
  stream.on("data", onData);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stream.off("data", onData);
    watching -= 1;
    if (watching === 0) { if (raw) { try { stream.setRawMode(false); } catch { /* gone */ } raw = false; } stream.pause(); input = null; }
    unlisten();
  };
}

/**
 * ONE LETTER WHILE A COMMAND WAITS (CLI 0.11.22: `o` opens the pairing QR in a window). In a terminal only; raw mode is taken
 * (and given back) unless watchKeys above already holds it, and Ctrl+C keeps its meaning (the command's own SIGINT path).
 * → release().
 */
export function onLetter(letter, run, stream = process.stdin) {
  if (!stream?.isTTY) return () => {};
  const mine = !stream.isRaw;
  if (mine) { try { stream.setRawMode(true); } catch { /* not a terminal after all */ } }
  stream.resume();
  const onData = (chunk) => { const text = String(chunk); if (text.includes("\x03")) process.emit("SIGINT", "SIGINT"); else if (text.toLowerCase() === letter) run(); };
  stream.on("data", onData);
  return () => { stream.off("data", onData); if (mine) { try { stream.setRawMode(false); } catch { /* gone */ } stream.pause(); } };
}

/** `work` with keys watched for its whole length; released also when it fails. */
export async function watched(work) {
  const release = watchKeys();
  try { return await work(); } finally { release(); }
}

/** Whether this process is a command the menu started (for a script it starts: pass the channel on, or not). */
export const menuChild = () => MENU_CHILD;

/**
 * THE MENU'S SIDE: watch one child. → { stopped() }: whether Esc stopped it. `kill` and `timers` are for the tests.
 * Grace: SIGINT, then SIGTERM after `grace`, then SIGKILL after another `grace`; a child that said it is finishing a write
 * gets `ceiling` before SIGKILL instead.
 */
export function superviseChild(child, { platform = process.platform, grace = 1500, ceiling = 60_000, timers = { setTimeout, clearTimeout } } = {}) {
  let asked = false, finishing = false, alive = true, timer = null;
  const later = (ms, then) => { timers.clearTimeout(timer); timer = timers.setTimeout(then, ms); timer?.unref?.(); };
  const kill = (signal) => { if (!alive) return; try { child.kill(signal); } catch { /* gone */ } };
  const last = () => kill("SIGKILL");
  const escalate = () => { if (!alive) return; if (finishing) { later(ceiling, last); return; } kill("SIGTERM"); later(grace, last); };
  const stop = () => {
    if (asked || !alive) return;
    asked = true;
    if (platform === "win32") { try { child.send({ wt: "stop" }); } catch { kill("SIGTERM"); } }
    else kill("SIGINT");
    later(grace, escalate);
  };
  child.on("message", (message) => { if (message?.wt === "finishing") finishing = true; if (message?.wt === "esc") stop(); });
  child.once("exit", () => { alive = false; timers.clearTimeout(timer); });
  return { stopped: () => asked, stop };
}

/**
 * The menu reading the keys itself, for a command that only reads and asks nothing (WORKTRUST_MENU_KEYS=menu): Esc is
 * `onEsc`, Ctrl+C is `onCtrlC` (raw mode turns the terminal's own off); → release(). Without a terminal: nothing.
 */
export function menuKeys(stream, { onEsc, onCtrlC }) {
  if (!stream?.isTTY) return () => {};
  const onData = (chunk) => { const text = String(chunk); if (/^\x1b+$/.test(text)) onEsc(); else if (text.includes("\x03")) onCtrlC(); };
  try { stream.setRawMode(true); } catch { return () => {}; }
  stream.on("data", onData); stream.resume();
  return () => { stream.off("data", onData); try { stream.setRawMode(false); } catch { /* gone */ } stream.pause(); };
}

/** The commands the menu starts that only read and ask nothing: the menu reads their keys, so Esc stops even a busy read. */
export function readsOnly(args) {
  const [first = "", second = "", third = ""] = args.filter((arg) => !arg.startsWith("--")), flags = args.filter((arg) => arg.startsWith("--"));
  if (["status", "look", "help", "version"].includes(first) && second === "") return true;
  if (first === "remote" && (second === "status" || (second === "modes" && third === "status"))) return true;
  return first === "preserve" && second === "" && flags.every((flag) => ["--verify", "--summary"].includes(flag)) && flags.length <= 1;
}
