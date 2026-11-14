/**
 * THE MENU (CLI 0.11.7, owner 2026-11-12: "a navigable menu"). Bare `npx worktrust` in a person's own terminal opens it;
 * everything else is exactly as before. It opens ONLY when menuWanted says so: stdin and stdout are both terminals, no
 * argument at all (so no --yes, --dry-run or --device), not relayed (WORKTRUST_RELAYED), not started by a hook or the MCP
 * door (their WORKTRUST_HOOK_INPUT / WORKTRUST_MCP_TOKEN), not in an AI agent's shell (worktrust.mjs refuses the bare
 * command there before it gets here), and not turned off (WORKTRUST_MENU=off). Hooks, MCP and scripts never wait for a key.
 *
 * Each item runs the direct command it shows in its muted line, as a child of this CLI with the terminal handed over
 * (io.runCli), so people learn the short form and every command keeps its own questions and its own guards. Keys: ↑/↓
 * move, Enter opens, Esc or ← goes back one level, q quits from the top, 1 to 9 jump, Ctrl+C quits. Raw mode and the
 * cursor are restored on every way out (quit, Ctrl+C, an error).
 *
 * 0.11.8 (owner, 2026-11-13): Update comes first and says whether there is something to update; every item carries one plain
 * sentence under it; the menu is redrawn IN PLACE (createTerminal) and never left in the scrollback; colours carry meaning
 * and are off wherever cli-colour.mjs says so (NO_COLOR, --no-color, a pipe). A terminal without cursor addressing
 * (TERM=dumb) gets no menu: the bare command runs as it always did.
 */
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { busyWith, clip, coloursFor, visibleLength } from "./cli-colour.mjs";
import { loadIdentity, loadSettings } from "./remote-store.mjs";

/** Whether bare `npx worktrust` opens the menu here. Pure: the caller passes what it knows. */
export function menuWanted({ args: given = [], env = {}, stdinTTY = false, stdoutTTY = false, agentShell = null } = {}) {
  const args = given.filter((arg) => arg !== "--no-color" && arg !== "--no-colour"); // how it looks, not what it does
  if (args.length !== 0 || !stdinTTY || !stdoutTTY || agentShell) return false;
  if (env.WORKTRUST_MENU === "off" || env.WORKTRUST_RELAYED === "1" || env.WORKTRUST_HOOK_INPUT || env.WORKTRUST_MCP_TOKEN) return false;
  if (env.TERM === "dumb") return false; // no cursor addressing: the menu could only be printed again and again
  return true;
}

/** The menu's painters: by this process's own terminal, environment and arguments (cli-colour.mjs colourWanted). */
let paint = coloursFor(process.stdout);
export const muted = (text) => paint.dim(text);

/**
 * The terminal, in raw mode while a list waits for a key; restore() always puts it back.
 *
 * THE MENU IS REDRAWN IN PLACE (0.11.8, owner 2026-11-13: the whole menu stood four times in the scrollback before the chosen
 * command ran). 0.11.7 cleared the screen for every redraw, and a terminal keeps a cleared screen in its scrollback: each arrow
 * key and each return from a command left one more copy. Now draw() remembers how many lines the menu took and the next
 * draw goes the cursor up that many, clears to the end of the screen and writes the new lines, in ONE write (no flicker).
 * erase() takes the menu's own lines away before anything else speaks (a command's output, a question), so what stays in
 * the scrollback is what happened, never a menu. A resize cannot trust the count (lines may have wrapped): reset() clears
 * the visible screen once and the menu is drawn once. No line ever wraps: draw() cuts each to the terminal's width.
 */
export function createTerminal(input = process.stdin, output = process.stdout) {
  let raw = false, drawn = 0;
  const size = () => ({ columns: output.columns || 80, rows: output.rows || 24 });
  const up = () => (drawn > 0 ? `\x1b[${drawn}A\r\x1b[J` : "");
  const draw = (lines) => { const { columns } = size(); output.write(`${up()}${lines.map((line) => clip(line, columns - 1)).join("\n")}\n`); drawn = lines.length; };
  const erase = () => { if (drawn > 0) output.write(up()); drawn = 0; };
  const reset = () => { output.write("\x1b[H\x1b[J"); drawn = 0; };
  /** Text that is not the menu (a reason, a result): the menu's lines go first, and the next draw starts below it. */
  const write = (text) => { erase(); output.write(text); };
  const enter = () => { emitKeypressEvents(input); if (input.isTTY && !raw) { input.setRawMode(true); raw = true; } input.resume(); output.write("\x1b[?25l"); };
  const restore = () => { if (input.isTTY && raw) { try { input.setRawMode(false); } catch { /* gone */ } raw = false; } input.pause(); output.write("\x1b[?25h"); };
  /** The next key, or { name: "resize" } once the terminal's size has settled (many resize events, one answer). */
  const key = () => new Promise((resolve) => {
    let timer = null;
    const done = (value) => { input.off("keypress", onKey); output.off?.("resize", onResize); clearTimeout(timer); resolve(value); };
    const onKey = (str, k = {}) => done({ str, name: k.name ?? str, ctrl: Boolean(k.ctrl) });
    const onResize = () => { clearTimeout(timer); timer = setTimeout(() => done({ name: "resize" }), 60); };
    input.on("keypress", onKey);
    output.on?.("resize", onResize);
  });
  /** A real key: a resize while "Press any key" stands is not one. */
  const anyKey = async () => { for (;;) { const k = await key(); if (k.name !== "resize") return k; } };
  return { write, draw, erase, reset, size, enter, restore, key, anyKey };
}

/**
 * The lines of one list, as text. Pure: `view` is what choose holds, `columns` and `rows` the terminal's size. Each item is
 * its label with the command it runs dimmed beside it, and under it ONE plain sentence saying what it does and what Enter
 * does (owner, 2026-11-13; folded over two lines where the terminal is narrow). The chosen item is marked by `>` and by its ground, never by colour alone. A list taller than
 * the terminal first keeps the sentence for the chosen item only, then shows the items around it: a menu taller than the
 * screen could not be redrawn in place.
 */
export function menuFrame({ header = [], title = null, items, at = 0, ticked = new Set(), multi = false, top = false, footer = null }, { rows = 24, columns = 100, p = paint } = {}) {
  const head = [...header, ...(title ? ["", `  ${p.bold(title)}`] : []), ""];
  const foot = ["", `  ${p.dim(footer ?? (multi ? "↑/↓ move · Space tick · Enter confirm · Esc back" : `↑/↓ move · Enter open · ${top ? "q quit" : "Esc back"} · 1-9 jump`))}`];
  const room = Math.max(3, rows - 1 - head.length - foot.length);
  const box = (item) => (multi && item.tick ? `[${ticked.has(item.label) ? "x" : " "}] ` : "");
  const named = (item) => `${box(item)}${item.label}${item.note ? ` · ${item.note.text}` : ""}`;
  // The commands stand in one column beside the names (a name longer than 44 pushes only its own command).
  const column = Math.min(44, Math.max(0, ...items.filter((item) => item.hint).map((item) => visibleLength(named(item)))));
  const line = (item, i) => {
    const label = ` ${i < 9 ? i + 1 : " "}  ${box(item)}${item.label} `;
    const note = item.note ? `· ${p[item.note.tone]?.(item.note.text) ?? item.note.text}` : "";
    const name = i === at ? p.inverse(label) : item.disabled ? p.dim(label) : p.bold(label);
    return `${i === at ? ">" : " "} ${name}${note}${item.hint ? `${" ".repeat(Math.max(0, column - visibleLength(named(item))) + 3)}${p.dim(item.hint)}` : ""}`;
  };
  // The sentence, on a narrow terminal over two lines at most: folded at a space, never cut by the terminal itself.
  const fold = (text, width) => { if (text.length <= width) return [text]; const cut = text.lastIndexOf(" ", width); return cut < 20 ? [text] : [text.slice(0, cut), text.slice(cut + 1)]; };
  const about = (item) => (item.info ? fold(item.info, Math.max(30, columns - 9)).map((part) => `        ${part}`) : []);
  const all = items.map((item, i) => ({ i, lines: [line(item, i), ...about(item)] }));
  if (all.reduce((n, entry) => n + entry.lines.length, 0) <= room) return [...head, ...all.flatMap((entry) => entry.lines), ...foot];
  const short = items.map((item, i) => (i === at ? [line(item, i), ...about(item)] : [line(item, i)]));
  if (items.length + 2 <= room) return [...head, ...short.flat(), ...foot];
  const span = Math.max(1, room - 4), from = Math.max(0, Math.min(at - Math.floor(span / 2), items.length - span));
  return [...head, `  ${p.dim(from > 0 ? "↑ more" : "")}`, ...short.slice(from, from + span).flat(), `  ${p.dim(from + span < items.length ? "↓ more" : "")}`, ...foot];
}

/**
 * One list: → { item } (Enter or a digit), "back" (Esc, ←), "quit" (q at the top, Ctrl+C). `items`: { label, hint?, info?,
 * note?, disabled? }. `multi`: Space ticks an item that has `tick: true`; the ticked items come back as `ticked`. `header`:
 * the lines, or a function giving them, asked at every draw so a state a command just changed shows at once.
 */
export async function choose(term, { header = [], title, items, top = false, multi = false, footer = null }) {
  let at = Math.max(0, items.findIndex((i) => !i.disabled));
  const ticked = new Set(items.filter((i) => i.ticked).map((i) => i.label));
  for (;;) {
    term.draw(menuFrame({ header: typeof header === "function" ? header() : header, title, items, at, ticked, multi, top, footer }, term.size()));
    const k = await term.key();
    if (k.name === "resize") { term.reset(); continue; }
    if (k.ctrl && k.name === "c") return "quit";
    if (k.name === "up" || k.name === "k") { do at = (at - 1 + items.length) % items.length; while (items[at].disabled); continue; }
    if (k.name === "down" || k.name === "j") { do at = (at + 1) % items.length; while (items[at].disabled); continue; }
    if (k.name === "escape" || k.name === "left") { if (!top) return "back"; continue; }
    if (k.name === "q" && top) return "quit";
    if (multi && k.name === "space" && items[at].tick) { ticked.has(items[at].label) ? ticked.delete(items[at].label) : ticked.add(items[at].label); continue; }
    if (/^[1-9]$/.test(k.str ?? "") && items[Number(k.str) - 1] && !items[Number(k.str) - 1].disabled) { at = Number(k.str) - 1; if (!multi) return { item: items[at] }; continue; }
    if (k.name === "return" || k.name === "enter") return { item: items[at], ticked: items.filter((i) => ticked.has(i.label)) };
  }
}

/** A line of text typed at the keyboard (out of raw mode), the default already there to edit; null when left empty. */
export async function typed(term, question, value = "") {
  term.erase();
  term.restore();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = prompt.question(`  ${question} `);
  if (value) prompt.write(value);
  const text = (await answer).trim();
  prompt.close();
  return text || null;
}

/** While a command runs, Ctrl+C is the command's (it reaches the child too); the menu stays. */
let busy = false;

/**
 * Run one direct command with the terminal handed over, then wait for a key before the menu comes back. The menu's own
 * lines are taken away first, so the scrollback reads: the command, its output, how it ended. The menu is then drawn once
 * below (the next draw starts fresh).
 */
export async function runShown(term, io, args, label = null) {
  term.restore();
  busy = true;
  term.write(`  ${muted(`› npx worktrust ${args.join(" ")}`.trimEnd())}${label ? `   ${label}` : ""}\n\n`);
  let code = 1;
  try { code = await io.runCli(args); } catch { code = 1; } finally { busy = false; }
  term.enter();
  term.write(`\n  ${code === 0 ? paint.green("✓ Done.") : paint.yellow("! It ended with a message above.")} ${muted("Press any key for the menu.")}\n`);
  const k = await term.anyKey();
  return !(k.ctrl && k.name === "c");
}

/** What the Remote Agent item says where this Node has no WebSocket; Enter opens the ways forward (node-guide.mjs). */
export const REMOTE_NEEDS = "Needs Node 22.4 or later; the Python package bundles one. Enter shows the ways to get there.";

const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/**
 * What the Update item says beside its name (owner, 2026-11-13), from the state read again after every command, so it is
 * true the moment an update finishes: this computer's installed version behind this CLI's ("0.11.7 → 0.11.8 available"),
 * a newer CLI published than the one running, or "up to date (0.11.8)". Null when this computer is not connected.
 */
export function updateNote(state) {
  if (!state.connected) return null;
  if (state.installed && newer(state.version, state.installed)) return { text: `${state.installed} → ${state.version} available`, tone: "yellow", behind: "computer" };
  if (state.latest && newer(state.latest, state.version)) return { text: `${state.version} → ${state.latest} available`, tone: "yellow", behind: "cli" };
  return { text: `up to date (${state.version})`, tone: "green", behind: null };
}

/** The header: the version, a newer one when the check says so, and this computer's state in one line. */
export function headerLines(state) {
  const remote = (() => {
    try {
      const s = loadSettings();
      if (!loadIdentity()) return "not set up";
      return s.enabled ? (s.paused ? "paused" : "on") : "off";
    } catch { return "unknown"; }
  })();
  return [
    `  ${paint.bold(`WorkTrust CLI ${state.version}`)}${state.latest ? `   ${paint.yellow(`! ${state.latest} is out: quit, then npx -y worktrust@latest`)}` : ""}`,
    `  ${state.connected ? `Connected as ${state.account ?? "this computer's account (not recorded: run Check this computer)"}` : "Not connected yet"} · Remote Agent ${remote}`,
  ];
}

/**
 * The top list (owner, 2026-11-13): Update first, then Check, then the rest as before. Pure but for the `run` closures.
 * `open(args)` runs one direct command; `sub` holds the deeper levels.
 */
export function topItems(state, open = () => true, sub = {}) {
  const door = state.door === "off" ? "Off" : "On";
  const note = updateNote(state);
  const updateInfo = !state.connected ? "Needs a connected computer first: Check this computer connects it."
    : note.behind === "cli" ? `A newer CLI is out. Quit (q) and run npx -y worktrust@latest to get it; Enter here refreshes this computer with ${state.version}.`
    : note.behind === "computer" ? `Brings this computer's hook and AI-app doors from ${state.installed} to ${state.version}; your key and pairing stay.`
    : "Brings this computer's hook and AI-app doors to this version again; your key and pairing stay.";
  return [
    { label: "Update WorkTrust", note, hint: "npx worktrust update", info: updateInfo, run: () => open(["update"]) },
    { label: "Check this computer", hint: "npx worktrust", info: state.connected ? "Shows what is coupled here and finishes what still waits; a change asks first." : "Connects this computer: shows the plan, asks, then you approve it in your browser.", run: () => open([]) },
    // Node before 22.4 has no WebSocket (0.11.8): the item stays, says why, and Enter opens the ways forward, not the levels.
    state.remoteBlocked
      ? { label: "Remote Agent", note: { text: "needs Node 22.4+", tone: "yellow" }, hint: "npx worktrust remote …", info: REMOTE_NEEDS, run: () => open(["remote"]) }
      : { label: "Remote Agent ›", hint: "npx worktrust remote …", info: "Opens the choices for steering this computer's agents from your phone. Nothing changes yet.", run: () => sub.remote?.() },
    { label: "Import earlier history ›", hint: "npx worktrust history …", info: "Opens the ways to send earlier sessions as history. Each one shows its plan and asks first.", run: () => sub.history?.() },
    { label: "Preserve evidence ›", hint: "npx worktrust preserve …", info: "Opens the ways to keep your AI history on this computer. Nothing is sent.", run: () => sub.preserve?.() },
    { label: `WorkTrust in your AI apps: ${door}`, hint: `npx worktrust mcp ${door === "On" ? "off" : "on"}`, info: door === "On" ? "Takes the WorkTrust door out of every AI app here; the session hook keeps measuring your hours." : "Puts the WorkTrust door back in your AI apps, so your AI can log finished work.", run: () => open(["mcp", door === "On" ? "off" : "on"]) },
    { label: "Status", hint: "npx worktrust status", info: "Shows the key, the hook, the door and what this computer measured. It only reads.", run: () => open(["status"]) },
    { label: "Disconnect this computer", hint: "npx worktrust disconnect", info: "Takes WorkTrust out of every AI app here and ends this computer's key. It asks first.", run: () => open(["disconnect"]) },
    { label: "Help · all commands", hint: "npx worktrust help", info: "Lists every command and option. Tip: npx -y worktrust skips npm's own \"Ok to proceed?\" question.", run: () => open(["help"]) },
    { label: "Quit", hint: "q", info: "Leaves the menu. Nothing keeps running.", quit: true },
  ];
}

/** The top of the menu. `io`: { runCli(args) → Promise<code>, state() → { version, installed, latest, account, connected, door } }. */
// (remoteBlocked is added here: whether this Node lacks the WebSocket Remote Agent needs.)
export async function runMenu(io) {
  paint = coloursFor(process.stdout);
  const term = createTerminal();
  const quit = () => { term.erase(); term.restore(); };
  const onSignal = () => { if (busy) return; quit(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    term.enter();
    const { remoteMenu, historyMenu, preserveMenu } = await import("./cli-menu-remote.mjs");
    for (;;) {
      // Read again after every command: the version line and the Update item say the new state the moment an update ends.
      const state = { ...(await busyWith("Reading this computer's state", () => io.state())), remoteBlocked: typeof globalThis.WebSocket !== "function" };
      const header = () => headerLines(state);
      const items = topItems(state, (args) => runShown(term, io, args), { remote: () => remoteMenu(term, io, header), history: () => historyMenu(term, io, header), preserve: () => preserveMenu(term, io, header) });
      const picked = await choose(term, { header, items, top: true });
      if (picked === "quit" || picked === "back" || picked.item.quit) break;
      if ((await picked.item.run()) === false) break;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    quit();
  }
}
