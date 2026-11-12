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
 * cursor are restored on every way out (quit, Ctrl+C, an error). NO_COLOR is respected.
 */
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { loadIdentity, loadSettings } from "./remote-store.mjs";

/** Whether bare `npx worktrust` opens the menu here. Pure: the caller passes what it knows. */
export function menuWanted({ args = [], env = {}, stdinTTY = false, stdoutTTY = false, agentShell = null } = {}) {
  if (args.length !== 0 || !stdinTTY || !stdoutTTY || agentShell) return false;
  if (env.WORKTRUST_MENU === "off" || env.WORKTRUST_RELAYED === "1" || env.WORKTRUST_HOOK_INPUT || env.WORKTRUST_MCP_TOKEN) return false;
  return true;
}

const colour = () => !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code, text) => (colour() ? `\x1b[${code}m${text}\x1b[0m` : text);
export const muted = (text) => paint("2", text);
const strong = (text) => paint("1", text);
const chosen = (text) => (colour() ? `\x1b[7m${text}\x1b[0m` : `> ${text}`);

/** The terminal, in raw mode while a list waits for a key; restore() always puts it back. */
export function createTerminal(input = process.stdin, output = process.stdout) {
  let raw = false;
  const write = (text) => output.write(text);
  const enter = () => { emitKeypressEvents(input); if (input.isTTY && !raw) { input.setRawMode(true); raw = true; } input.resume(); write("\x1b[?25l"); };
  const restore = () => { if (input.isTTY && raw) { try { input.setRawMode(false); } catch { /* gone */ } raw = false; } input.pause(); write("\x1b[?25h"); };
  const key = () => new Promise((resolve) => {
    const on = (str, k = {}) => { input.off("keypress", on); resolve({ str, name: k.name ?? str, ctrl: Boolean(k.ctrl) }); };
    input.on("keypress", on);
  });
  return { write, enter, restore, key, clear: () => write(colour() ? "\x1b[2J\x1b[H" : "\n") };
}

/**
 * One list: → { item } (Enter or a digit), "back" (Esc, ←), "quit" (q at the top, Ctrl+C). `items`: { label, hint?, info?,
 * disabled? }. `multi`: Space ticks an item that has `tick: true`; the ticked items come back as `ticked`.
 */
export async function choose(term, { header = [], title, items, top = false, multi = false, footer = null }) {
  let at = Math.max(0, items.findIndex((i) => !i.disabled));
  const ticked = new Set(items.filter((i) => i.ticked).map((i) => i.label));
  for (;;) {
    term.clear();
    for (const line of header) term.write(`${line}\n`);
    if (title) term.write(`\n  ${strong(title)}\n`);
    term.write("\n");
    items.forEach((item, i) => {
      const n = i < 9 ? `${i + 1}` : " ";
      const box = multi && item.tick ? `[${ticked.has(item.label) ? "x" : " "}] ` : "";
      const label = `${n}  ${box}${item.label}`;
      term.write(`  ${i === at ? chosen(` ${label} `) : item.disabled ? muted(` ${label} `) : ` ${label} `}\n`);
      if (item.hint) term.write(`       ${muted(item.hint)}\n`);
    });
    term.write(`\n  ${muted(footer ?? (multi ? "↑/↓ move · Space tick · Enter confirm · Esc back" : `↑/↓ move · Enter open · ${top ? "q quit" : "Esc back"} · 1-9 jump`))}\n`);
    const k = await term.key();
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

/** Run one direct command with the terminal handed over, then wait for a key before the menu comes back. */
export async function runShown(term, io, args, label = null) {
  term.restore();
  busy = true;
  term.clear();
  process.stdout.write(`  ${muted(`› npx worktrust ${args.join(" ")}`.trimEnd())}${label ? `   ${label}` : ""}\n\n`);
  let code = 1;
  try { code = await io.runCli(args); } catch { code = 1; } finally { busy = false; }
  term.enter();
  term.write(`\n  ${muted(code === 0 ? "Done." : "It ended with a message above.")} ${muted("Press any key for the menu.")}\n`);
  const k = await term.key();
  return !(k.ctrl && k.name === "c");
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
    `  ${strong(`WorkTrust CLI ${state.version}`)}${state.latest ? `   ${paint("33", `a new version is available: ${state.latest}`)}` : ""}`,
    `  ${state.connected ? `Connected as ${state.account ?? "this computer's account (not recorded: run Check this computer)"}` : "Not connected yet"} · Remote Agent ${remote}`,
  ];
}

/** The top of the menu. `io`: { runCli(args) → Promise<code>, state() → { version, latest, account, connected, door } }. */
export async function runMenu(io) {
  const term = createTerminal();
  const quit = () => { term.restore(); process.stdout.write("\n"); };
  const onSignal = () => { if (busy) return; quit(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    term.enter();
    const { remoteMenu, historyMenu, preserveMenu } = await import("./cli-menu-remote.mjs");
    for (;;) {
      const state = await io.state();
      const header = headerLines(state);
      const door = state.door === "off" ? "Off" : "On";
      const items = [
        { label: "Check this computer", hint: state.connected ? "npx worktrust   what is coupled here" : "npx worktrust   connect this computer", run: () => runShown(term, io, []) },
        { label: "Update WorkTrust", hint: "npx worktrust update", run: () => runShown(term, io, ["update"]) },
        { label: "Remote Agent ›", hint: "npx worktrust remote …", run: () => remoteMenu(term, io, header) },
        { label: "Import earlier history ›", hint: "npx worktrust history …", run: () => historyMenu(term, io, header) },
        { label: "Preserve evidence ›", hint: "npx worktrust preserve …", run: () => preserveMenu(term, io, header) },
        { label: `WorkTrust in your AI apps: ${door}`, hint: `npx worktrust mcp ${door === "On" ? "off" : "on"}   your hours stay measured by the session hook`, run: () => runShown(term, io, ["mcp", door === "On" ? "off" : "on"]) },
        { label: "Status", hint: "npx worktrust status", run: () => runShown(term, io, ["status"]) },
        { label: "Disconnect this computer", hint: "npx worktrust disconnect   asks first", run: () => runShown(term, io, ["disconnect"]) },
        { label: "Help · all commands", hint: "npx worktrust help", run: () => runShown(term, io, ["help"]) },
        { label: "Quit", hint: "q", quit: true },
      ];
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
