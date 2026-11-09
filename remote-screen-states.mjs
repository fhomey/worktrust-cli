/**
 * WHAT A TERMINAL SESSION'S SCREEN SAYS (release 19, 2026-11-09). One pure function per agent from the screen's last lines
 * (remote-adapter-terminal.mjs capture, escapes already removed) to one of: working, idle, blocked (needs_you with a reason:
 * dialog, question, trust, login) or unknown. No imports, no I/O.
 *
 * UNKNOWN IS THE DEFAULT. A screen is idle only on a positive match (the agent's empty input line) with no sign of anything
 * else; the order is blocked, then working, then idle, so a dialog is never read as idle even when an input box is also
 * drawn. A half-drawn dialog, a person's draft in the input line, a blank or unfamiliar screen, a dead pane: unknown, and
 * nothing is typed into unknown (attention.ts, promptAllowed). Only the screen's BOTTOM counts (the last REGION non-empty
 * lines): a dialog answered earlier and scrolled up is history, not a wait.
 *
 * BASIS. A detector says what its fixtures are: `recorded` (captured from the real agent) or `authored` (written by hand
 * from the agent's known layout). Typing from a phone is offered only on a recorded basis (typingTrusted); the Claude
 * Code fixtures are AUTHORED (its interactive start needs the person's sign-in and the network, which the recording rule
 * forbids), so its detector drives what the phone SHOWS (working, needs you, idle) and never what it may type.
 * Fixtures: scripts/fixtures/remote/terminal-screens/<agent>/, held by test-remote-screen-states.mjs.
 */
export const REGION = 25;

const rule = (l) => /^\s*[─━]{20,}\s*$/.test(l) || /^\s*╭─{10,}/.test(l) || /^\s*╰─{10,}/.test(l);
const BOXED_INPUT = /^\s*│\s*>\s?(.*?)\s*│\s*$/;
const BARE_INPUT = /^\s*>\s?(.*?)\s*$/;
const PLACEHOLDER = /^Try "[^"]*"$/;
const MENU_FIRST = /^\s*[│|]?\s*[❯›>]\s*1\.\s+\S/;
const MENU_NEXT = /^\s*[│|]?\s*[❯›>]?\s*2\.\s+\S/;
/** Words that only a waiting screen shows; seen without the whole dialog, the screen is unknown, never idle. */
const WAITING_WORDS = /Do you want to|Do you trust|\(y\/n\)|\[y\/N\]|Enter to select|Esc to cancel|Select login method|Paste code here|Press Enter to continue/i;

const result = (activity, needs, confident, why) => ({ activity, needs, confident, why });
export const UNKNOWN_SCREEN = Object.freeze(result("unknown", null, false, "default"));

/** Claude Code's interactive screen (shaped after 2.1.x). */
export function claudeCodeScreen(lines) {
  if (!Array.isArray(lines)) return result("unknown", null, false, "no screen");
  const tail = lines.map((l) => String(l ?? "").replace(/\s+$/, "")).filter((l) => l.trim() !== "").slice(-REGION);
  if (tail.length === 0) return result("unknown", null, false, "blank");
  if (tail.some((l) => /^Pane is dead\b/.test(l))) return result("unknown", null, false, "exited");
  const text = tail.join("\n");
  const menu = tail.some((l) => MENU_FIRST.test(l)) && tail.some((l) => MENU_NEXT.test(l));
  // blocked: what waits for a person, most specific first
  if (/Do you trust the files in this folder\?/.test(text)) return menu ? result("needs_you", "trust", true, "trust") : result("unknown", null, false, "trust, half drawn");
  if (/Select login method|Paste code here if prompted|Invalid API key|Please run \/login/i.test(text)) return result("needs_you", "login", true, "login");
  if (menu && /Do you want to [^\n]*\?/.test(text)) return result("needs_you", "dialog", true, "permission dialog");
  if (menu) return result("needs_you", "question", true, "a choice the agent asks");
  if (/\(y\/n\)|\[y\/N\]/i.test(text)) return result("needs_you", "dialog", true, "yes or no");
  if (WAITING_WORDS.test(text)) return result("unknown", null, false, "a waiting screen, half drawn");
  // working: the agent's own line while it runs
  if (tail.some((l) => /esc to interrupt/i.test(l))) return result("working", null, true, "esc to interrupt");
  // idle: the input line, empty (or its placeholder), inside its box or between its rules, at the very bottom
  const near = tail.slice(-6);
  for (let i = near.length - 1; i >= 0; i -= 1) {
    const boxed = BOXED_INPUT.exec(near[i]);
    const bare = boxed ? null : BARE_INPUT.exec(near[i]);
    const framed = boxed ? (rule(near[i - 1] ?? "") || rule(near[i + 1] ?? "")) : bare ? rule(near[i - 1] ?? "") && rule(near[i + 1] ?? "") : false;
    if (!framed) continue;
    const typed = (boxed ?? bare)[1].trim();
    if (typed === "" || PLACEHOLDER.test(typed)) return result("idle", null, true, "empty input line");
    return result("unknown", null, false, "a draft in the input line"); // never type into the person's half-typed words
  }
  return result("unknown", null, false, "unrecognised");
}

const unbox = (l) => l.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").trim();
const OPTION = /^\s*[│|]?\s*([❯›>])?\s*(\d)\.\s+(.*?)\s*│?\s*$/;
const HEADER = /^\s*[│|]?\s*(Bash command|Edit file|Create file|Write file)\s*│?\s*$/;

/**
 * Claude Code's permission dialog on the screen, as a phone may answer it (remote-screen-approvals.mjs), or null.
 * `region` is the dialog's own lines, exactly as drawn, header to last option: what the phone shows and the computer
 * hashes, and hashes again just before it presses a key. `tool` and `target` are read from it (a command after
 * "Bash command", a file after "Edit file" or in "create <file>?"); anything not read is null, and the computer's policy
 * then refuses it. `approve` is true only while the cursor is on option 1 and that option is exactly "Yes" (never "Yes,
 * and don't ask again"); `dismiss` only while an option answers with Esc.
 */
export function claudeCodeDialog(lines) {
  const state = claudeCodeScreen(lines);
  if (state.activity !== "needs_you" || state.needs !== "dialog") return null;
  const tail = lines.map((l) => String(l ?? "").replace(/\s+$/, "")).filter((l) => l.trim() !== "").slice(-REGION);
  const ask = tail.findIndex((l) => /Do you want to [^\n]*\?/.test(l));
  if (ask < 0) return null;
  let start = ask;
  for (let i = ask - 1; i >= Math.max(0, ask - 12); i -= 1) if (HEADER.test(tail[i])) { start = i; break; }
  let last = ask;
  for (let i = ask + 1; i < tail.length; i += 1) if (OPTION.test(tail[i])) last = i;
  const region = tail.slice(start, last + 1);
  const options = region.map((l) => OPTION.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[2]), text: m[3], cursor: Boolean(m[1]) }));
  if (options.length < 2 || options[0].n !== 1) return null;
  const header = HEADER.exec(region[0])?.[1] ?? null;
  const question = unbox(tail[ask]);
  let tool = null, target = null;
  if (header === "Bash command") { tool = "Bash"; target = region.slice(1).map(unbox).find((l) => l !== "") ?? null; }
  else if (header === "Edit file" || /^Do you want to make this edit to /.test(question)) { tool = "Edit"; target = header === "Edit file" ? region.slice(1).map(unbox).find((l) => l !== "") ?? null : null; }
  else if (/^Do you want to create (.+)\?$/.test(question)) { tool = "Write"; target = /^Do you want to create (.+)\?$/.exec(question)[1]; }
  return { region, tool, target, approve: options[0].cursor && options[0].text === "Yes", dismiss: options.some((o) => /\(esc\)$/i.test(o.text)) };
}

/**
 * The keys that answer a screen dialog, per agent, by our own names (remote-adapter-terminal.mjs KEYS), from the
 * fixtures: Claude Code takes the highlighted option with Enter (the cursor on "1. Yes") and "No" with Esc.
 */
export const SCREEN_ANSWERS = Object.freeze({ "claude-code": Object.freeze({ approve: Object.freeze(["enter"]), deny: Object.freeze(["dismiss"]) }) });

/** The detectors by agent, each with the basis of its fixtures. Codex has none yet: no terminal start runs it. */
export const DETECTORS = Object.freeze({ "claude-code": Object.freeze({ detect: claudeCodeScreen, dialog: claudeCodeDialog, basis: "authored", shapedAfter: "2.1.x" }) });

/** The dialog a phone may answer for an agent this file knows, or null. */
export const screenDialog = (agent, lines) => (Object.hasOwn(DETECTORS, agent) && Array.isArray(lines) ? DETECTORS[agent].dialog(lines) : null);

/** The screen's state for an agent this file knows; any other agent is unknown. */
export const detectScreen = (agent, lines) => (Object.hasOwn(DETECTORS, agent) ? DETECTORS[agent].detect(lines) : UNKNOWN_SCREEN);

/** Whether a phone may be offered typing into this agent's terminal: only on fixtures recorded from the real agent. */
export const typingTrusted = (agent) => Object.hasOwn(DETECTORS, agent) && DETECTORS[agent].basis === "recorded";
