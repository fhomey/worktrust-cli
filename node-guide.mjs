/**
 * REMOTE AGENT ON A NODE THAT IS TOO OLD: THE WAYS FORWARD (CLI 0.11.8, owner 2026-11-13). package.json promises Node 18
 * for measuring; Remote Agent's one live connection needs the WebSocket Node has from 22.4. A `remote` command there does
 * not end at a refusal: it says so plainly, says measuring keeps working, and shows the ways to a working Remote Agent,
 * each with its exact command.
 *
 * WHAT THIS MODULE MAY RUN, AND HOW (held by check-cli-package's node-guide rule):
 *   - only a command from its OWN CLOSED LIST below (RUNNABLE): never a word from a person's input, a file or the network;
 *   - as an argv array handed to spawn, never a shell string, never `shell: true`;
 *   - only a user-level tool (fnm, volta, Homebrew, pipx): never sudo, never a system package manager, never an installer
 *     that asks for an administrator; those are printed for the person to run;
 *   - only after the exact command was shown and the person typed yes (Enter is No). Without a terminal, or with --yes,
 *     nothing is asked and nothing runs: the text is printed and the command ends with a failure code.
 * nvm is a shell function and asdf's words differ per version: both are printed, never run. There is no "newer Node just
 * for WorkTrust through npx": that Node would come from npm's `node` package, which nothing here verifies; the Python
 * package is that way, with the official Node it locks by hash.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";

export const NODE_FLOOR = [22, 4];
/** The one sentence a script reads (stderr, exit 1); null where this Node can hold the connection. */
export const remoteNeedsNode = (has = typeof globalThis.WebSocket === "function", version = process.versions.node) =>
  (has ? null : `remote needs Node 22.4 or later for its connection (this is ${version}); the Python package bundles one`);
export const nodeIsEnough = (version) => { const [a, b] = String(version).replace(/^v/, "").split(".").map(Number); return a > NODE_FLOOR[0] || (a === NODE_FLOOR[0] && b >= NODE_FLOOR[1]); };

/**
 * Whether a `remote <sub>` command stops at the ways forward on this Node (asked by remote-cli.mjs before anything is read,
 * asked, written or sent). Node before 22.4 has no WebSocket, so nothing that starts, links, allows or changes something
 * runs. The ways to LOOK and to STOP stay: a person who moved to an older Node can still see the state, pause it, turn it
 * off and close its connections.
 */
const REMOTE_WITHOUT = new Set(["status", "pause", "disable", "disconnect"]);
export const remoteStopsHere = (sub, has = typeof globalThis.WebSocket === "function") => !REMOTE_WITHOUT.has(sub) && !has;

/** The closed list: every command this module can run. A way's `argv` is built from these words and nothing else. */
const RUNNABLE = Object.freeze({
  fnm: [["fnm", "install", "22"], ["fnm", "default", "22"]],
  volta: [["volta", "install", "node@22"]],
  brew: [["brew", "upgrade", "node"]],
});
const shown = (argvs) => argvs.map((argv) => argv.join(" ")).join(" && ");

/** An executable of this name on PATH (its full path), or null. Reads directories only; runs nothing. */
export function onPath(name, env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) for (const ext of exts) { const file = join(dir, name + ext); if (existsSync(file)) return file; }
  return null;
}

/**
 * How this computer's Node is installed, by where the running Node lives, and the command that updates it. Pure: `has(name)`
 * says whether a tool is on PATH. `argv` is set only for a user-level manager this module may run; otherwise the command
 * is for the person (`argv: null`).
 */
export function nodeManager({ execPath = process.execPath, env = process.env, platform = process.platform, has = (name) => Boolean(onPath(name)) } = {}) {
  const path = String(execPath).replace(/\\/g, "/");
  const way = (id, name, text, argv = null) => ({ id, name, shown: text, argv });
  if (path.includes("/.nvm/") || (env.NVM_DIR && path.startsWith(String(env.NVM_DIR).replace(/\\/g, "/")))) return way("nvm", "nvm", "nvm install 22 && nvm alias default 22");
  if (/\/fnm(_multishells)?\/|\/\.fnm\//.test(path) || (env.FNM_DIR && path.startsWith(String(env.FNM_DIR).replace(/\\/g, "/")))) return way("fnm", "fnm", shown(RUNNABLE.fnm), has("fnm") ? RUNNABLE.fnm : null);
  if (path.includes("/.volta/") || (env.VOLTA_HOME && path.startsWith(String(env.VOLTA_HOME).replace(/\\/g, "/")))) return way("volta", "Volta", shown(RUNNABLE.volta), has("volta") ? RUNNABLE.volta : null);
  if (path.includes("/.asdf/")) return way("asdf", "asdf", "asdf install nodejs latest:22 (then make it your default: asdf set -u nodejs latest:22, or asdf global on asdf before 0.16)");
  if (/^\/opt\/homebrew\/|^\/usr\/local\/(Cellar|opt)\/|^\/home\/linuxbrew\//.test(path)) {
    if (/\/node@\d+\//.test(path)) return way("brew", "Homebrew", "brew install node@22 && brew link --overwrite --force node@22");
    return way("brew", "Homebrew", shown(RUNNABLE.brew), has("brew") ? RUNNABLE.brew : null);
  }
  if (platform === "win32") return way("windows", "the Windows installer", "winget upgrade OpenJS.NodeJS.LTS (or the installer from https://nodejs.org/en/download)");
  return way("system", "your system's own package", "install Node 22 from https://nodejs.org/en/download (or your distribution's NodeSource package)");
}

/** The Python package: run through pipx where pipx is, else the line that installs it. */
export function pythonWay(args, has = (name) => Boolean(onPath(name))) {
  if (has("pipx")) return { id: "pipx", shown: `pipx run worktrust ${args.join(" ")}`.trimEnd(), argv: [["pipx", "run", "worktrust", ...args]] };
  if (has("python3") || has("python")) return { id: "pip", shown: `${has("python3") ? "python3" : "python"} -m pip install worktrust (then: worktrust ${args.join(" ")})`.replace(/ \)$/, ")"), argv: null };
  return { id: "none", shown: "install Python 3.10 or later, then: pip install worktrust", argv: null };
}

/** What is said, the same bytes with or without a terminal. */
export function guidanceLines({ version = process.versions.node, manager, python }) {
  return [
    "",
    `  Remote Agent needs Node 22.4 or later for its live connection. This computer runs Node ${version}.`,
    "  Measuring your work keeps working as it is.",
    "",
    "  Ways forward:",
    `    1  Update this computer's Node (${manager.name})`,
    `         ${manager.shown}`,
    "    2  Use the Python package, which brings its own Node",
    `         ${python.shown}`,
  ];
}

const runArgv = (argv) => new Promise((resolve) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  child.on("error", () => resolve(1));
  child.on("exit", (code) => resolve(code ?? 1));
});
const typedLine = async (question) => { const prompt = createInterface({ input: process.stdin, output: process.stdout }); const answer = (await prompt.question(question)).trim().toLowerCase(); prompt.close(); return answer; };
const nodeOnPath = () => { const node = onPath("node"); if (!node) return null; const asked = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 }); return asked.status === 0 ? { path: realpathSync(node), version: asked.stdout.trim().replace(/^v/, "") } : null; };

/**
 * A `remote` command on a Node without the WebSocket: say it, show the ways, and (a person's terminal only) take one on a
 * typed yes. `io`: the CLI's say, fail, ask and has. `deps` are the seams the tests hold: interactive, line, run, findNode,
 * rerun(nodePath, args) → the exit code of this same CLI started again under that Node, connected.
 */
export async function guideToNode(io, args, deps = {}) {
  const sentence = remoteNeedsNode(false, deps.version ?? process.versions.node);
  const manager = deps.manager ?? nodeManager(), python = deps.python ?? pythonWay(args);
  const interactive = deps.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !io.has("yes"));
  // Started again: this same CLI (the launcher this process was started with, verified as always) under the Node just found.
  const rerun = deps.rerun ?? ((nodePath, cliArgs) => runArgv([nodePath, process.argv[1], ...cliArgs]));
  const run = deps.run ?? runArgv, again = `npx worktrust ${args.join(" ")}`.trimEnd();
  for (const line of guidanceLines({ version: deps.version, manager, python })) io.say(line);
  const leave = (words) => { io.say(`  ${words}`); io.fail(sentence); };
  if (!interactive) leave("Nothing was installed or changed.");
  io.say("    q  Leave");
  const pick = await (deps.line ?? typedLine)("  Choose 1 or 2, or q to leave [1]: ");
  const way = pick === "" || pick === "1" ? manager : pick === "2" ? python : null;
  if (!way) leave("Nothing was installed or changed.");
  if (!way.argv) leave(`That one is yours to run: ${way.shown}. Then run \`${again}\` again. Nothing was installed or changed.`);
  io.say(`  This runs: ${way.shown}`);
  if (!(await io.ask("Run it now?", false))) leave("Nothing was run. Nothing was installed or changed.");
  for (const argv of way.argv) { const code = await run(argv); if (code !== 0) leave(`\`${argv.join(" ")}\` ended with code ${code}. WorkTrust changed nothing.`); }
  if (way === python) return; // pipx ran this same command with the Python package's own Node
  const node = (deps.findNode ?? nodeOnPath)();
  if (!node || !nodeIsEnough(node.version)) leave(`Node on this terminal's PATH is ${node ? `still ${node.version}` : "not found"}. Open a new terminal and run \`${again}\` again.`);
  io.say(`  ✓ Node is now ${node.version}.`);
  // The session hook and the AI-app doors name a Node by its path: `update` under the new one repairs a path that moved.
  if (deps.connected) { io.say("  Bringing the session hook and your AI apps onto it (npx worktrust update):"); await rerun(node.path, ["update"]); }
  io.say(`  Continuing: ${again}`);
  process.exitCode = await rerun(node.path, args);
}
