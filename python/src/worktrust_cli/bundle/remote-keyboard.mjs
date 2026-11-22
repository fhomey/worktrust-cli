/**
 * A SWITCH THAT ONLY THE PERSON AT THIS KEYBOARD TURNS ON (CLI 0.11.21, S0; coordinator re-review 2026-11-22).
 *
 * `remote voice on`, `remote voice read on`, `remote desk-steer on`, `remote read-along on` and `remote roots default on`
 * each open this computer a little further to a phone. Like `phones confirm` and `phones allow-endorse on`
 * (remote-cli.mjs), the ON direction needs all three of:
 *   a terminal       stdin and stdout are a TTY (a script, a pipe or an agent's tool call has none)
 *   no agent shell   none of the variables an AI agent's client sets (the CLI's own AGENT_ENV, worktrust.mjs; the
 *                    test-cli-agent-brake check holds the three copies equal), and not `io.agentShell`
 *   a typed yes      the word itself; Enter, `y` and `--yes` are No
 * OFF stays scriptable: closing never needs the person. The menu's rows satisfy this without a second path: each row
 * runs the same command as a child of the CLI in the person's own terminal (cli-menu.mjs runShown), so this asks there.
 * `io.tty` and `io.prompt` are the tests' seams (an object handed in by code, never something an environment can set);
 * worktrust.mjs passes neither. check-remote-cli rule W refuses an ON path that does not come through here first.
 */
import { createInterface } from "node:readline";

export const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_CI", "GEMINI_CLI", "CURSOR_AGENT", "OPENCODE", "CLINE_ACTIVE", "AIDER_CHAT", "ANTIGRAVITY_AGENT", "WINDSURF_AGENT"];
const ANSWER_WAIT_MS = 120_000;

function askLine(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const end = (value) => { if (done) return; done = true; clearTimeout(timer); rl.close(); resolve(value); };
    const timer = setTimeout(() => end(null), ANSWER_WAIT_MS);
    rl.on("close", () => end(null));
    rl.question(question, (answer) => end(answer));
  });
}

/** → true only when the person at this terminal typed yes; otherwise it refused (io.fail) or said "Not changed." and → false. */
export async function keyboardYes(io, question, env = process.env) {
  const terminal = (io.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) === true;
  const agent = io.agentShell === true || AGENT_ENV.some((name) => env[name] && env[name] !== "0");
  if (!terminal || agent) { io.fail(agent ? "this is turned on by the person, in their own terminal, never in an AI agent's shell" : "this is turned on at this keyboard, in a terminal (turning it off works anywhere)"); return false; }
  const said = await (io.prompt ?? askLine)(`  ${question} Type yes to confirm: `);
  if (typeof said !== "string" || said.trim().toLowerCase() !== "yes") { io.say("  Not changed."); return false; }
  return true;
}
