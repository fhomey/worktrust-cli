/**
 * THE DEFAULT ROOT, ASKED ONCE AT THE KEYBOARD (CLI 0.11.21; the owner, 2026-11-22: "a new session from the app without
 * choosing a project"). docs/remote-agents/PROTOCOL.md "Projects and sessions", protocol phone-start.ts.
 *
 * `~/Desktop/WorkTrust` becomes a ROOT (remote-projects.mjs: a parent folder in which a phone may create ONE new, empty
 * project folder per request with `project.create`, a single name of [A-Za-z0-9._-], never a path), and the phone is told
 * which root it is (device.inventory `default_root`, sealed only for a phone that asked; remote-peers.mjs). A phone's
 * "New session" without a project then asks a project name, sends project.create into this root and starts there.
 *
 * WHO TURNS IT ON: a person at this keyboard, and nobody else (S0). The folder is made and added through the keyboard's one
 * door (remote-settings.mjs applySettingsChange, `{ kind: "keyboard" }`), and the mark that makes it the default is written
 * here alone (remote-store.mjs default-root.json). No daemon module, no settings change from the app or the web, no phone,
 * browser or MCP door imports this module or writes that file (check-remote-cli rule D). Asked once, Enter is yes, exactly
 * as the read-along question of 0.11.19 (remote-read-along.mjs): after a phone was linked here, at the end of
 * `npx worktrust remote status`, and at the end of `npx worktrust update` on a computer paired for Remote Agent. Without a
 * person at a terminal (no TTY, --yes, --json, an AI agent's shell) nothing is asked, nothing is made, nothing is
 * remembered. An answer that never comes, or one that is neither yes nor no, is "no" for now and is NOT remembered.
 * `npx worktrust remote roots default on|off|status` is the same switch, typed; either word counts as the answer.
 *
 * OFF takes the mark and the root away (the folder and every project made in it stay on the disk, and those projects stay
 * granted, as `roots remove` says); a phone then hears `default_root: null` and says how to turn it on here.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as P from "./remote-protocol.mjs";
import { answerWord, keyboardYes } from "./remote-keyboard.mjs";
import { applySettingsChange, askMacFolderAccess } from "./remote-settings.mjs";
import { defaultRootOf, loadDefaultRoot, loadIdentity, loadPhones, loadRoots, writeJson } from "./remote-store.mjs";

export const ANSWER_WAIT_MS = 120_000;
export const DEFAULT_ROOT_COMMAND = P.DEFAULT_ROOT_COMMAND;
/** The folder, read where it is used (a test's synthetic HOME moves it). */
export const defaultRootDir = () => join(homedir(), "Desktop", "WorkTrust");
let offered = false; // once per CLI process: a command that asked already does not ask again at its end

/** macOS guards ~/Desktop: the folder question the keyboard's other root changes ask (remote-settings.mjs), where the CLI can run it. */
const askAccess = async (io, paths) => { if (paths && typeof io.prepare === "function" && !io.has?.("no-folder-check")) await askMacFolderAccess(io, paths).catch(() => null); };
const mark = (fields) => writeJson("default-root.json", { v: 1, ...loadDefaultRoot(), ...fields });

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

/** Make the folder and add it as a root at this keyboard, then mark it the default. → { ok, message } or { ok: false, reason }. */
export function turnOn() {
  const dir = defaultRootDir();
  try { mkdirSync(dir, { recursive: true, mode: 0o755 }); } catch (error) { return { ok: false, reason: `${dir} could not be made (${error?.code ?? "error"})` }; }
  const added = applySettingsChange({ what: "roots", add: dir, git_init: true }, { kind: "keyboard" });
  if (!added.ok) return { ok: false, reason: added.reason };
  const root = loadRoots().find((r) => r.path === added.paths?.[0]);
  if (!root) return { ok: false, reason: "the root was not kept" };
  mark({ root_id: root.root_id, answer: "yes", at: Date.now() });
  return { ok: true, paths: added.paths, message: `Default folder for new projects: ${root.path}. "New session" on your phone, without a project, asks a name and makes that project here (one new, empty folder, with git init). Turn it off: npx worktrust remote roots default off` };
}

/** Take the mark and the root away; the folder and its projects stay. */
export function turnOff() {
  const kept = loadDefaultRoot();
  if (kept.root_id && loadRoots().some((r) => r.root_id === kept.root_id)) applySettingsChange({ what: "roots", remove: kept.root_id }, { kind: "keyboard" });
  mark({ root_id: null, answer: "no", at: Date.now() });
  return { ok: true, message: `No default folder: "New session" on a phone asks for a project. The folder and the projects in it stay where they are. Again: ${DEFAULT_ROOT_COMMAND}` };
}

/**
 * `at`: "paired" (a phone was just linked here), "later" (the end of `remote status`) or "update" (the end of
 * `npx worktrust update`). → "on", "asked_before", "not_paired", "not_asked", "yes", "no" or "unanswered". `io.tty` and
 * `io.prompt` are the tests' seams.
 */
export async function offerDefaultRoot(io, { at = "paired" } = {}) {
  if (offered && at !== "paired") return "asked_before";
  if (defaultRootOf() !== null) return "on";
  if (loadDefaultRoot().answer !== null) return "asked_before";
  if (at !== "paired" && (!loadIdentity() || loadPhones().confirmed.length === 0)) return "not_paired";
  const person = (io.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) === true && io.agentShell !== true && !io.has?.("yes") && !io.has?.("json");
  if (!person) { if (at === "paired") io.say(`  To start sessions from your phone without choosing a project: ${DEFAULT_ROOT_COMMAND}`); return "not_asked"; }
  offered = true;
  io.say("");
  io.say(`  A default folder for new projects: ${defaultRootDir()}. "New session" on your phone, without a project,`);
  io.say("  asks a project name and makes that one new, empty folder there. Nothing else is opened to the phone.");
  io.say("  Turn it off any time: npx worktrust remote roots default off");
  io.setup?.asked("default_root"); // CLI 0.11.26: mirrored on the phone that just linked (remote-setup.mjs); its folder question follows in askAccess
  const said = await (io.prompt ?? askKeyboard)("  Make the default folder? [Y/n] ");
  const answer = answerWord(said); // owner, 2026-11-24: y / yes / n / no, any case
  if (answer === "" || answer === "yes") {
    const done = turnOn();
    if (!done.ok) { io.setup?.skipped("default_root", "later"); io.say(`  ! Not made: ${done.reason}`); return "unanswered"; }
    io.setup?.done("default_root"); io.say(`  ✓ ${done.message}`);
    await askAccess(io, done.paths);
    return "yes";
  }
  if (answer === "no") { mark({ root_id: null, answer: "no", at: Date.now() }); io.setup?.done("default_root"); io.say(`  No default folder. Later: ${DEFAULT_ROOT_COMMAND}`); return "no"; }
  io.setup?.skipped("default_root", said === null ? "no_answer" : "later");
  io.say(`  No answer: no default folder for now. Later: ${DEFAULT_ROOT_COMMAND}`);
  return "unanswered";
}

/** `npx worktrust remote roots default on|off|status`, typed at this keyboard. */
export async function defaultRootCommand(io, rest) {
  const word = rest[0] ?? "status";
  if (word === "on" || word === "off") {
    if (word === "on" && !(await keyboardYes(io, `A phone may then make one new project folder in ${defaultRootDir()} by name. Make the default folder?`))) return;
    const done = word === "on" ? turnOn() : turnOff();
    if (!done.ok) io.fail(done.reason);
    io.say(`  ✓ ${done.message}`);
    return askAccess(io, done.paths);
  }
  if (word !== "status") io.fail("npx worktrust remote roots default on|off|status");
  const id = defaultRootOf(), root = id ? loadRoots().find((r) => r.root_id === id) : null;
  io.say(root ? `  Default folder for new projects: ${root.path}` : `  No default folder for new projects. Turn it on: ${DEFAULT_ROOT_COMMAND}`);
}

/** The end of `npx worktrust update` (worktrust.mjs): a computer paired for Remote Agent is asked once; a question that cannot be asked never fails the update. */
export async function offerAfterUpdate(io) {
  try { return await offerDefaultRoot(io, { at: "update" }); } catch { return "unanswered"; }
}
