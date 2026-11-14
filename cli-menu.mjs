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
 *
 * 0.11.9 (owner, 2026-11-14): a computer that is NOT connected gets a short menu (firstItems: Connect, Preserve, Help, Quit),
 * and the full one the moment Connect succeeds, without running anything again (menuLoop reads the state after every command).
 * And an Update with nothing to update is still drawn, dimmed and in words, and cannot be chosen (updateNote's `settled`).
 * ONE ROW PER ITEM (owner, 2026-11-14: "the text under 1 is annoying"): number, action, command, explanation on one line
 * where the terminal is wide enough, else the chosen row's explanation on one fixed line under the list (menuFrame). No row
 * moves when the choice moves. A ROW THAT CANNOT BE CHOSEN is one mechanism for every menu: `disabled`, with `quiet`, the
 * line its digit answers; the arrows pass it, it is dimmed, and its words say why (a note beside its name), never colour alone.
 * Esc quits at the top like q and goes back one level below it. The head of a connected computer is a summary (headerLines):
 * account, this computer, Remote Agent and its connections, and what this computer shares, from local files only.
 */
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { busyWith, clip, coloursFor, visibleLength } from "./cli-colour.mjs";
import { loadIdentity, loadPhones, loadSettings } from "./remote-store.mjs";

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

const wrap = (text, width) => { const out = []; let line = ""; for (const word of text.split(" ")) { if (line && line.length + 1 + word.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word; } return line ? [...out, line] : out; };

/**
 * The lines of one list, as text. Pure: `view` is what choose holds, `columns` and `rows` the terminal's size. ONE ROW PER
 * ITEM (0.11.9), and the rows never move when the choice moves:
 *   wide      four columns on one line: number, action, command (dim), explanation (dim). Only when EVERY row's explanation
 *             fits whole (no sentence is ever cut), so the form does not depend on which row is chosen.
 *   narrower  three columns, and the chosen row's explanation on fixed lines under the list, above the keys: as many lines as
 *             the longest explanation of this list needs at this width, always, so nothing jumps. 80 columns is this form.
 *   < 60      the command column goes too; and at any width a command that would not fit whole on its row is left out.
 * The chosen item is marked by `>` and by its ground, never by colour alone. `asked` is the row whose digit was pressed
 * though it cannot be chosen: its `quiet` line (and its explanation, where that is not on its row) is said under the list.
 * A list taller than the terminal shows the items around the chosen one: a menu taller than the screen could not be redrawn in place.
 */
export function menuFrame({ header = [], title = null, items, at = 0, ticked = new Set(), multi = false, top = false, footer = null, asked = null }, { rows = 24, columns = 100, p = paint } = {}) {
  const width = columns - 1;
  const heads = (lines) => [...lines, ...(title ? ["", `  ${p.bold(title)}`] : []), ""];
  const keys = `  ${p.dim(footer ?? (multi ? "↑/↓ move · Space tick · Enter confirm · Esc back" : `↑/↓ move · Enter open · Esc ${top ? "quit" : "back"} · 1-9 jump`))}`;
  const box = (item) => (multi && item.tick ? `[${ticked.has(item.label) ? "x" : " "}] ` : "");
  const size = (item) => visibleLength(`${box(item)}${item.label}${item.note ? ` · ${item.note.text}` : ""}`);
  // The commands stand in one column beside the names (a name longer than 64 pushes only its own command; a table row is a name).
  const nameCol = Math.min(64, Math.max(0, ...items.map(size))), hintCol = Math.max(0, ...items.map((item) => (item.hint ?? "").length));
  const upTo = (item) => 6 + Math.max(nameCol, size(item)) + 3; // where this row's command starts
  const wide = columns >= 60 && items.every((item) => !item.info || upTo(item) + hintCol + 3 + item.info.length <= width);
  const line = (item, i) => {
    const label = ` ${i < 9 ? i + 1 : " "}  ${box(item)}${item.label} `;
    const note = item.note ? `· ${p[item.note.tone]?.(item.note.text) ?? item.note.text}` : "";
    const name = i === at ? p.inverse(label) : item.disabled ? p.dim(label) : p.bold(label);
    const gap = " ".repeat(Math.max(0, nameCol - size(item)) + (item.note ? 3 : 2)); // a name without a note ends in its own space
    if (wide) return `${i === at ? ">" : " "} ${name}${note}${gap}${p.dim(item.info ? (item.hint ?? "").padEnd(hintCol) : item.hint ?? "")}${item.info ? `   ${p.dim(item.info)}` : ""}`;
    return `${i === at ? ">" : " "} ${name}${note}${columns >= 60 && item.hint && upTo(item) + item.hint.length <= width ? `${gap}${p.dim(item.hint)}` : ""}`;
  };
  // Under the list: what the chosen row does or, after the digit of a row that cannot be chosen, why not.
  const told = (item, refused) => [refused ? item.quiet : null, item.info].filter(Boolean).join(" ");
  const need = Math.max(1, ...items.map((item) => wrap(told(item, item.disabled), width - 2).length));
  const said = wrap(asked === null ? told(items[at], false) : told(items[asked], true), width - 2).map((part) => `  ${part}`);
  const foot = wide ? ["", keys, ...(asked === null ? [] : [`  ${p.dim(items[asked].quiet ?? items[asked].info ?? "")}`])] : ["", ...said, ...Array(Math.max(0, need - said.length)).fill(""), "", keys];
  // A terminal too short for the list under the whole head keeps the head's first line only: the list matters more than the summary.
  const all = items.map(line), fits = (lines) => all.length <= rows - 1 - lines.length - foot.length;
  const head = fits(heads(header)) ? heads(header) : heads(header.slice(0, 1)), room = Math.max(3, rows - 1 - head.length - foot.length);
  if (all.length <= room) return [...head, ...all, ...foot];
  const span = Math.max(1, room - 2), from = Math.max(0, Math.min(at - Math.floor(span / 2), items.length - span));
  return [...head, `  ${p.dim(from > 0 ? "↑ more" : "")}`, ...all.slice(from, from + span), `  ${p.dim(from + span < items.length ? "↓ more" : "")}`, ...foot];
}

/**
 * One list: → { item } (Enter or a digit), "back" (Esc, ←), "quit" (q at the top, Ctrl+C). `items`: { label, hint?, info?,
 * note?, disabled?, quiet? }. A disabled item is never chosen: the arrows pass it, the list opens on the first item that can
 * be, and its digit only says its `quiet` line. `multi`: Space ticks an item that has `tick: true`; the ticked items come back as `ticked`. `header`:
 * the lines, or a function giving them, asked at every draw so a state a command just changed shows at once.
 */
export async function choose(term, { header = [], title, items, top = false, multi = false, footer = null }) {
  let at = Math.max(0, items.findIndex((i) => !i.disabled));
  const ticked = new Set(items.filter((i) => i.ticked).map((i) => i.label));
  let asked = null; // the row whose digit was pressed though it cannot be chosen (0.11.9), said under the list until the next key
  for (;;) {
    term.draw(menuFrame({ header: typeof header === "function" ? header() : header, title, items, at, ticked, multi, top, footer, asked }, term.size()));
    const k = await term.key();
    if (k.name === "resize") { term.reset(); continue; }
    asked = /^[1-9]$/.test(k.str ?? "") && items[Number(k.str) - 1]?.disabled ? Number(k.str) - 1 : null;
    if (k.ctrl && k.name === "c") return "quit";
    if (k.name === "up" || k.name === "k") { do at = (at - 1 + items.length) % items.length; while (items[at].disabled); continue; }
    if (k.name === "down" || k.name === "j") { do at = (at + 1) % items.length; while (items[at].disabled); continue; }
    if (k.name === "escape") return top ? "quit" : "back"; // 0.11.9: Esc leaves the top like q (a lone Esc: readline tells it from an arrow's sequence)
    if (k.name === "left") { if (!top) return "back"; continue; }
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
export const REMOTE_NEEDS = "Needs Node 22.4 or later. Enter shows the ways to get it.";

const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/**
 * What the Update item says beside its name (owner, 2026-11-13), from the state read again after every command, so it is
 * true the moment an update finishes: this computer's installed version behind this CLI's ("0.11.7 → 0.11.8 available"),
 * a newer CLI published than the one running, or "up to date (0.11.8)". Null when this computer is not connected.
 *
 * THREE STATES, NEVER TWO (0.11.9, owner 2026-11-14: "now you can do the update twice"). Something to update; nothing to
 * update and KNOWN so (`settled`: this computer runs this CLI's version and the registry answered that none is newer), which
 * is the one state where the item cannot be chosen; and not known (the registry did not answer, or this computer's version
 * is not this CLI's): that one says what it knows, claims no "up to date", and can still be chosen.
 */
export function updateNote(state) {
  if (!state.connected) return null;
  if (state.installed && newer(state.version, state.installed)) return { text: `${state.installed} → ${state.version} available`, tone: "yellow", behind: "computer" };
  if (state.latest && newer(state.latest, state.version)) return { text: `${state.version} → ${state.latest} available`, tone: "yellow", behind: "cli" };
  if (!state.latestKnown) return { text: "newest not checked", tone: "dim", behind: null };
  return { text: `up to date (${state.version})`, tone: state.installed === state.version ? "dim" : "green", behind: null, settled: state.installed === state.version };
}

/**
 * Remote Agent here, in one word, with its confirmed connections; from this computer's own files. A file that cannot be read
 * is "not known", never "not set up" (remote-store readJson refuses an unreadable or non-private one).
 */
export function remoteState() {
  try { const s = loadSettings(), links = loadPhones().confirmed.length; return { links, word: !loadIdentity() ? "not set up" : !s.enabled ? "off" : s.paused ? "paused" : "approved" }; }
  catch { return { links: null, word: "not known" }; }
}

/**
 * The head. Not connected: the version and the one fact. Connected (0.11.9, owner 2026-11-14): a summary, label and value,
 * of what this computer's own files say; never the key, never a secret; a date not recorded is a dash, a state that could
 * not be read is "not known". `state`: version, latest, account, host, since, hook, door, apps (worktrust.mjs).
 */
export function headerLines(state) {
  const title = `  ${paint.bold(`WorkTrust CLI ${state.version}`)}${state.latest ? `   ${paint.yellow(`! ${state.latest} is out: quit, then npx -y worktrust@latest`)}` : ""}`;
  if (!state.connected) return [title, "  Not connected yet"];
  const row = (label, value) => `  ${paint.dim(label.padEnd(14))} ${value}`, remote = remoteState(), host = String(state.host ?? "this computer");
  const known = (value, yes, no) => (value === true ? yes : value === false ? no : "not known");
  return [
    title,
    row("Account", state.account ?? "not recorded: run Check this computer"),
    row("This computer", `${host.length > 28 ? `${host.slice(0, 27)}…` : host} · connected since ${/^\d{4}-\d{2}-\d{2}/.test(String(state.since ?? "")) ? String(state.since).slice(0, 10) : "-"}`),
    row("Remote Agent", remote.links === null || ["not set up", "off"].includes(remote.word) ? remote.word : `${remote.word}, ${remote.links} connection${remote.links === 1 ? "" : "s"}`),
    row("Sharing", `session hook ${known(state.hook, "on", "not installed")} · AI apps ${state.door === "off" ? "off" : state.door === "on" ? `on${Number.isInteger(state.apps) ? ` (${state.apps})` : ""}` : "not known"} · Remote Agent ${remote.word === "not set up" ? "off" : remote.word}`),
  ];
}

const HELP = (open) => ({ label: "Help · all commands", hint: "npx worktrust help", info: "Lists all commands. npx -y worktrust skips npm's question.", run: () => open(["help"]) });
const QUIT = { label: "Quit", hint: "q", info: "Leaves the menu. Nothing keeps running.", quit: true };
const PRESERVE = (sub, info) => ({ label: "Preserve evidence ›", hint: "npx worktrust preserve …", info, run: () => sub.preserve?.() });

/**
 * THE FIRST MENU (0.11.9, owner 2026-11-14): what a computer that is not connected can do, and nothing that needs a
 * connected one (no Update, Remote Agent, Import, AI apps switch, Status, Disconnect). Preserve needs no account, no key
 * and no network at any of its levels (preserve.mjs; worktrust.mjs loads no key for it), so all of it stays.
 */
export function firstItems(open = () => true, sub = {}) {
  return [
    { label: "Connect this computer", hint: "npx worktrust connect", info: "Asks before it writes; your browser signs in to WorkTrust.", run: () => open(["connect"]) },
    PRESERVE(sub, "Keep your AI history here. No account; nothing is sent."),
    HELP(open), QUIT,
  ];
}

/** Why the first menu still stands after Connect ran, in one line, by how the command ended (0 without a key: a No or a dry run). */
export function connectReason(code) {
  if (code === 0) return "Connect stopped before the sign-in; nothing was written. 1 tries again.";
  if (code === 130) return "Connect was cancelled; this computer is not connected. 1 tries again.";
  return "Connect ended with the message above; not connected. 1 tries again.";
}

/**
 * The top list (owner, 2026-11-13): Update first, then Check, then the rest as before. Pure but for the `run` closures.
 * `open(args)` runs one direct command; `sub` holds the deeper levels.
 */
export function topItems(state, open = () => true, sub = {}) {
  if (!state.connected) return firstItems(open, sub);
  const note = updateNote(state);
  const same = state.installed === state.version; // then `update` changes nothing and says so (worktrust.mjs update, 0.11.9)
  const updateInfo = note.behind === "cli" ? "Newer CLI: quit, then npx -y worktrust@latest update."
    : note.behind === "computer" ? `Brings this computer from ${state.installed} to ${state.version}. Your key stays.`
    : note.settled ? "Nothing to update: this computer runs the latest version."
    : same ? "Newest version not checked. Enter changes nothing here."
    : "Sets up this computer's hook and AI-app doors again.";
  return [
    { label: "Update WorkTrust", note, hint: "npx worktrust update", info: updateInfo, run: () => open(["update"]), ...(note.settled ? { disabled: true, quiet: "Already up to date." } : {}) },
    { label: "Check this computer", hint: "npx worktrust", info: "Shows what is coupled here and finishes what waits.", run: () => open([]) },
    // Node before 22.4 has no WebSocket (0.11.8): the item stays, says why, and Enter opens the ways forward, not the levels.
    state.remoteBlocked
      ? { label: "Remote Agent", note: { text: "needs Node 22.4+", tone: "yellow" }, hint: "npx worktrust remote …", info: REMOTE_NEEDS, run: () => open(["remote"]) }
      : { label: "Remote Agent ›", hint: "npx worktrust remote …", info: "Steer this computer's agents from your phone.", run: () => sub.remote?.() },
    { label: "Import earlier history ›", hint: "npx worktrust history …", info: "Send earlier sessions as history. Each way asks first.", run: () => sub.history?.() },
    PRESERVE(sub, "Keep your AI history on this computer. Nothing is sent."),
    { label: "Sharing ›", hint: "npx worktrust mcp …", info: "What this computer sends, and the switches for it.", run: () => sub.sharing?.() },
    { label: "Status", hint: "npx worktrust status", info: "Shows the key, the hook and the door. It only reads.", run: () => open(["status"]) },
    { label: "Disconnect this computer", hint: "npx worktrust disconnect", info: "Takes WorkTrust out and ends this computer's key. It asks.", run: () => open(["disconnect"]) },
    HELP(open), QUIT,
  ];
}

/**
 * The menu's loop, apart from the process (0.11.9) so a test can drive it. The state is read again after every command: the
 * version line and the Update item say the new state the moment an update ends, and the first menu becomes the full one the
 * moment Connect leaves a key. When Connect ran and there is still no key, the first menu stays and its header says why.
 */
export async function menuLoop(term, io, levels) {
  let last = null, state = null; // the command the top level ran last and how it ended; this computer's state as last read
  const read = async () => (state = { ...(await busyWith("Reading this computer's state", () => io.state())), remoteBlocked: typeof globalThis.WebSocket !== "function" });
  // A deeper level reads the state again after each of its commands (inner.state), so the head above it is true at once.
  const inner = { runCli: (args) => io.runCli(args), state: read };
  for (;;) {
    await read();
    const why = !state.connected && last?.args[0] === "connect" ? connectReason(last.code) : null;
    const header = () => [...headerLines(state), ...(why ? [`  ${paint.yellow(`! ${why}`)}`] : [])];
    const open = (args) => { const ran = { args, code: 1 }; last = ran; return runShown(term, { runCli: async (given) => (ran.code = await io.runCli(given)) }, args); };
    const items = topItems(state, open, Object.fromEntries(["remote", "history", "preserve", "sharing"].map((name) => [name, () => levels[`${name}Menu`](term, inner, header)])));
    const picked = await choose(term, { header, items, top: true });
    if (picked === "quit" || picked === "back" || picked.item.quit) break;
    last = null;
    if ((await picked.item.run()) === false) break;
  }
}

/** The top of the menu. `io`: { runCli(args) → Promise<code>, state() → { version, installed, latest, latestKnown, account, connected, door, host, since, hook, apps } }. */
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
    await menuLoop(term, io, await import("./cli-menu-remote.mjs"));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    quit();
  }
}
