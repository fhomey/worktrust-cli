/**
 * READ ALONG, ASKED ONCE AT THE KEYBOARD (CLI 0.11.19; the owner, 2026-11-21: "at remote pairing in the CLI, after pairing
 * you have the option read along on as default; why would you turn this off if it is your own account").
 *
 * After a phone was linked or confirmed at this keyboard (`remote app`, `remote web`, `remote pair`, `remote phones
 * confirm`), and once for a computer that was paired before this release (at the end of the next `worktrust remote …`
 * command a person runs in a terminal), the CLI explains reading along in three lines and asks. THE DEFAULT ANSWER IS YES:
 * Enter turns it on, exactly as `worktrust remote read-along on` does (the keyboard's one door, applySettingsChange, both
 * keys, the same printed words). `n` leaves it off. Either answer is remembered (remote-store.mjs read-along.json), so a
 * computer is asked once; `read-along on|off` typed by the person counts as the answer too.
 *
 * WHO IS ASKED: a person at a terminal, and nobody else. Both ends a TTY, no `--yes`, no `--json`, not an AI agent's
 * shell (worktrust.mjs refuses every remote act there and says so in `io.agentShell`). Without that: nothing is asked,
 * NOTHING IS TURNED ON, the one command is printed where a phone was just linked, and no answer is remembered. An answer
 * that never comes (the end of the input, two minutes of silence) and one that is neither yes nor no are "no" for now and
 * are NOT remembered: the person is asked again another time.
 *
 * NEVER FROM ANYWHERE ELSE: this module is imported by remote-cli.mjs alone. No daemon module, no settings change from the
 * app or the web, no phone, browser or MCP door reaches it, the mark it writes or the switch (check-remote-cli rule R).
 */
import { createInterface } from "node:readline";
import { applySettingsChange } from "./remote-settings.mjs";
import { deskReadOf, loadIdentity, loadPhones, loadReadAlongAsk, loadSettings, saveReadAlongAsk } from "./remote-store.mjs";

export const ANSWER_WAIT_MS = 120_000;
export const READ_ALONG_COMMAND = "npx worktrust remote read-along on";
/** Commands after which a computer paired before this release is never asked: the service, internal jobs, the switch's own commands, a way out. */
const NEVER_AFTER = new Set(["run", "folder-check", "handover", "help", "read-along", "desk-history", "desk-steer", "disable", "pause", "attach"]);
let offered = false; // once per CLI process: a command that links a phone has asked already

/** One line from the keyboard: the words typed, or null when the input ended or nothing came in time. */
function askKeyboard(question, ms = ANSWER_WAIT_MS) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const end = (value) => { if (done) return; done = true; clearTimeout(timer); rl.close(); resolve(value); };
    const timer = setTimeout(() => end(null), ms);
    rl.on("close", () => end(null));
    rl.question(question, (answer) => end(answer));
  });
}

/**
 * `at`: "paired" (a phone was just linked or confirmed here) or "later" (the end of another remote command, for a computer
 * paired before). → "on" (already), "asked_before", "not_paired", "not_asked" (no person at a terminal), "yes", "no", or
 * "unanswered". `io.tty` and `io.prompt` are the tests' seams; worktrust.mjs passes neither.
 */
export async function offerReadAlong(io, { at = "paired" } = {}) {
  if (offered && at === "later") return "asked_before";
  if (deskReadOf(loadSettings()) === "live") return "on";
  if (loadReadAlongAsk() !== null) return "asked_before";
  if (at === "later" && (!loadIdentity() || loadPhones().confirmed.length === 0)) return "not_paired";
  const person = (io.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) === true && io.agentShell !== true && !io.has?.("yes") && !io.has?.("json");
  if (!person) { if (at === "paired") io.say(`  Reading along with your sessions from your phone is off. To turn it on: ${READ_ALONG_COMMAND}`); return "not_asked"; }
  offered = true;
  io.say("");
  io.say("  Read along from your phone: the Claude Code sessions you run at this computer, in the folders it shares,");
  io.say("  can be read live on the phones you paired. Read-only: nothing can be sent into a session from there.");
  io.say("  Turn it off any time: npx worktrust remote read-along off");
  const said = await (io.prompt ?? askKeyboard)("  Turn read along on? [Y/n] ");
  const answer = typeof said === "string" ? said.trim().toLowerCase() : null;
  if (answer === "" || answer === "y" || answer === "yes") {
    const done = applySettingsChange({ what: "desk_live", on: true }, { kind: "keyboard" });
    if (!done.ok) { io.say(`  ! Not turned on: ${done.reason}`); return "unanswered"; }
    saveReadAlongAsk({ answer: "yes", at: Date.now() });
    io.say(`  ✓ ${done.message}`);
    return "yes";
  }
  if (answer === "n" || answer === "no") {
    saveReadAlongAsk({ answer: "no", at: Date.now() });
    io.say(`  Read along stays off. Later: ${READ_ALONG_COMMAND}`);
    return "no";
  }
  io.say(`  No answer: read along stays off for now. Later: ${READ_ALONG_COMMAND}`);
  return "unanswered";
}

/** The end of a `worktrust remote …` command (remote-cli.mjs): a computer paired before this release is asked once, by a person's own command. */
export async function offerAfter(io, sub) {
  if (NEVER_AFTER.has(sub)) return "not_asked";
  try { return await offerReadAlong(io, { at: "later" }); } catch { return "unanswered"; } // a question that cannot be asked never fails the command it follows
}
