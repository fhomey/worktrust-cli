#!/usr/bin/env node
/**
 * THE NODE FLOOR, HELD FROM BOTH SIDES (CLI 0.11.8; an outside review of the public mirror found no test holding it).
 * package.json promises Node 18. Measuring keeps that promise; Remote Agent needs the WebSocket Node has from 22.4.
 *
 *   refusal    without a global WebSocket every `remote` command that would start, link or change something prints the ways
 *              forward, ends with the one sentence on stderr and exit 1, and leaves the home folder as it was; the same
 *              bytes on every run (no question without a terminal)
 *   the rest   the commands that are not Remote Agent still work there: version, help, status (which names the reason),
 *              the bare command, preserve's report, history's own answer; `remote status` and `remote pause` still answer
 *   ways       how Node is installed is read from where it lives; only a user-level manager's command can be run, never
 *              sudo, never a system package manager; nothing runs without a typed yes; a Node that is still old after an
 *              update says so; `update` and the original command go on only under the new Node
 *
 * Runs on any Node from 18: on a Node that has a WebSocket the CLI is started with a preload that takes it away; on Node 18
 * and 20 (the mirror's node-floor job) it is absent by itself. Synthetic home, a dead origin, no account.
 *
 *   node scripts/test-cli-node-floor.mjs          (the mirror: WORKTRUST_TEST_CLI_SOURCE=. node tests/test-cli-node-floor.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.env.WORKTRUST_TEST_CLI_SOURCE || "tools/worktrust-cli");
const dir = mkdtempSync(join(tmpdir(), "wt-node-floor-"));
const home = join(dir, "home");
mkdirSync(home);
let held = 0;
const ok = (value, what) => { assert.ok(value, what); held += 1; };
const eq = (a, b, what) => { assert.deepEqual(a, b, what); held += 1; };

const native = typeof globalThis.WebSocket === "function";
const preload = join(dir, "no-websocket.mjs");
writeFileSync(preload, "delete globalThis.WebSocket;\n");
const cli = (args, { websocket = false } = {}) => spawnSync(process.execPath, [...(native && !websocket ? ["--import", pathToFileURL(preload).href] : []), join(source, "worktrust.mjs"), ...args],
  { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, WORKTRUST_ORIGIN: "http://127.0.0.1:9", WORKTRUST_REGISTRY_URL: "http://127.0.0.1:9/" }, input: "", encoding: "utf8", timeout: 120_000 });
const tree = (at = home) => readdirSync(at).sort().flatMap((name) => { const path = join(at, name), s = statSync(path); return s.isDirectory() ? [`${path}/`, ...tree(path)] : [`${path} ${s.size}`]; });
const SENTENCE = `worktrust: remote needs Node 22.4 or later for its connection (this is ${process.versions.node}); the Python package bundles one\n`;

// THE REFUSAL: every remote command that starts, links, allows or changes something
const before = tree();
const refused = [["remote", "app"], ["remote", "web"], ["remote", "pair"], ["remote", "run"], ["remote", "resume"], ["remote", "projects"], ["remote", "projects", "add", home], ["remote", "roots"], ["remote", "modes", "allow", "edit"],
  ["remote", "connections"], ["remote", "phones"], ["remote", "terminal"], ["remote", "codex", "on"], ["remote", "admin"], ["remote"], ["remote", "app", "--yes"]];
for (const args of refused) {
  const r = cli(args);
  ok(r.status === 1 && r.stderr === SENTENCE, `worktrust ${args.join(" ")}: exit 1 with exactly the sentence (${r.status}, ${JSON.stringify(r.stderr.slice(0, 90))})`);
  ok(/Remote Agent needs Node 22\.4 or later for its live connection\. This computer runs Node /.test(r.stdout) && /Measuring your work keeps working as it is\./.test(r.stdout) && /\n {4}1 {2}Update this computer's Node \(/.test(r.stdout) && /\n {4}2 {2}Use the Python package, which brings its own Node\n/.test(r.stdout) && r.stdout.endsWith("  Nothing was installed or changed.\n"),
    `worktrust ${args.join(" ")}: says it plainly, shows the ways forward, and that nothing was changed`);
  ok(!/Choose 1 or 2|Run it now|Continue\?/.test(r.stdout), `worktrust ${args.join(" ")}: asks nothing without a terminal`);
  ok(!/\bsudo\b/.test(r.stdout), `worktrust ${args.join(" ")}: no sudo in what is shown`);
}
eq(tree(), before, "after every refused command the home folder is as it was: no key, no setting, no service, no file");
eq(cli(["remote", "app"]).stdout, cli(["remote", "app"]).stdout, "the same bytes on every run");
if (native) ok(!cli(["remote", "app"], { websocket: true }).stderr.includes("needs Node 22.4"), "with the WebSocket this Node has, the same command is not refused for it (the preload is what the refusal saw)");

// THE REST still works on that Node
const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
{ const r = cli(["version"]); ok(r.status === 0 && r.stdout.trim() === version, `version answers ${version}`); }
{ const r = cli(["help"]); ok(r.status === 0 && /worktrust remote/.test(r.stdout) && /worktrust preserve/.test(r.stdout), "help lists the commands"); }
{ const r = cli(["status"]); ok(r.status === 0 && /Session hook: /.test(r.stdout) && r.stdout.includes(`  Remote Agent: needs Node 22.4 or later (this is ${process.versions.node})\n`), "status works and names why Remote Agent cannot run here"); }
{ const r = cli([]); ok(r.status === 1 && /not a terminal: nothing was changed/.test(r.stderr) && !r.stderr.includes("22.4"), "the bare command runs as it does without a terminal"); }
{ const r = cli(["preserve"]); ok(r.status === 0 && r.stdout.length > 0 && !`${r.stdout}${r.stderr}`.includes("22.4"), `preserve's report works (${r.status})`); }
{ const r = cli(["history", "--dry-run"]); ok(r.status === 1 && /not coupled through the key file/.test(r.stderr), "history gives its own answer (no key here), not the Node one"); }
for (const sub of ["status", "pause"]) { const r = cli(["remote", sub]); ok(r.status === 0 && !r.stderr.includes("22.4"), `remote ${sub} still answers: the ways to look and to stop stay (${r.status})`); }

// THE WAYS: detection, the closed list, and nothing without a yes
const guide = await import(pathToFileURL(join(source, "node-guide.mjs")).href);
const all = () => true, none = () => false;
const cases = [
  ["nvm", "/Users/p/.nvm/versions/node/v20.11.0/bin/node", {}, "darwin", "nvm install 22 && nvm alias default 22", false],
  ["fnm", "/Users/p/.local/state/fnm_multishells/123/bin/node", {}, "darwin", "fnm install 22 && fnm default 22", true],
  ["volta", "/Users/p/.volta/tools/image/node/20.11.0/bin/node", {}, "darwin", "volta install node@22", true],
  ["asdf", "/home/p/.asdf/installs/nodejs/20.11.0/bin/node", {}, "linux", null, false],
  ["brew", "/opt/homebrew/Cellar/node/21.7.1/bin/node", {}, "darwin", "brew upgrade node", true],
  ["brew", "/opt/homebrew/Cellar/node@20/20.11.0/bin/node", {}, "darwin", "brew install node@22 && brew link --overwrite --force node@22", false],
  ["brew", "/home/linuxbrew/.linuxbrew/Cellar/node/21.0.0/bin/node", {}, "linux", "brew upgrade node", true],
  ["windows", "C:\\Program Files\\nodejs\\node.exe", {}, "win32", null, false],
  ["system", "/usr/bin/node", {}, "linux", null, false],
  ["system", "/usr/local/bin/node", {}, "darwin", null, false],
];
for (const [id, execPath, env, platform, shown, runnable] of cases) {
  const way = guide.nodeManager({ execPath, env, platform, has: all });
  ok(way.id === id && (shown === null || way.shown === shown) && Boolean(way.argv) === runnable, `${execPath}: ${id}, ${runnable ? "can be run for the person" : "shown only"} (${way.shown})`);
  ok(!/\bsudo\b/.test(way.shown) && !(way.argv ?? []).flat().includes("sudo"), `${execPath}: no sudo`);
  if (way.argv) ok(way.argv.every((argv) => ["fnm", "volta", "brew"].includes(argv[0])) && way.shown === way.argv.map((argv) => argv.join(" ")).join(" && "), `${execPath}: what would run is what is shown, a user-level tool`);
  ok(guide.nodeManager({ execPath, env, platform, has: none }).argv === null, `${execPath}: without the tool on PATH nothing is offered to run`);
}
eq([guide.pythonWay(["remote", "app"], all).shown, guide.pythonWay(["remote", "app"], none).argv, guide.pythonWay(["remote", "app"], (n) => n === "python3").argv], ["pipx run worktrust remote app", null, null], "the Python package: through pipx where pipx is, else only the line that installs it");
ok(guide.nodeIsEnough("22.4.0") && guide.nodeIsEnough("v24.1.0") && !guide.nodeIsEnough("22.3.9") && !guide.nodeIsEnough("20.19.0") && !guide.nodeIsEnough("18.20.4"), "22.4 is the floor");

class Stopped extends Error {}
const session = async ({ answers, yes, manager, python, node, runs = () => 0 }) => {
  const said = [], ran = [], reran = [];
  const io = { say: (line = "") => said.push(line), fail: (line) => { said.push(`FAIL ${line}`); throw new Stopped(); }, ask: async (question) => { said.push(`ASK ${question}`); return yes; }, has: () => false };
  let ended = "returned";
  const exitBefore = process.exitCode;
  try { await guide.guideToNode(io, ["remote", "app"], { interactive: true, version: "20.11.0", manager, python, connected: true, line: async () => answers.shift() ?? "q", run: async (argv) => { ran.push(argv.join(" ")); return runs(argv); }, findNode: () => node, rerun: async (path, args) => { reran.push(`${path} ${args.join(" ")}`); return 0; } }); }
  catch (error) { if (!(error instanceof Stopped)) throw error; ended = "failed"; }
  process.exitCode = exitBefore;
  return { said: said.join("\n"), ran, reran, ended };
};
const brew = guide.nodeManager({ execPath: "/opt/homebrew/Cellar/node/21.7.1/bin/node", has: all, platform: "darwin", env: {} }), nvm = guide.nodeManager({ execPath: "/Users/p/.nvm/versions/node/v20.11.0/bin/node", has: all, platform: "darwin", env: {} });
const pipx = guide.pythonWay(["remote", "app"], all);
{ const s = await session({ answers: ["q"], yes: true, manager: brew, python: pipx }); eq([s.ran, s.reran, s.ended], [[], [], "failed"], "q leaves: nothing ran"); }
{ const s = await session({ answers: [""], yes: false, manager: brew, python: pipx }); ok(s.said.includes("This runs: brew upgrade node") && s.said.includes("ASK Run it now?") && s.ran.length === 0 && s.ended === "failed", "Enter takes the first way, shows its exact command and asks; a No runs nothing"); }
{ const s = await session({ answers: ["1"], yes: true, manager: nvm, python: pipx }); ok(s.ran.length === 0 && !s.said.includes("ASK") && /yours to run: nvm install 22/.test(s.said) && s.ended === "failed", "a way that is the person's to run (nvm) is never offered to be run"); }
{ const s = await session({ answers: ["1"], yes: true, manager: brew, python: pipx, node: { path: "/opt/homebrew/bin/node", version: "20.11.0" } }); eq([s.ran, s.reran, s.ended], [["brew upgrade node"], [], "failed"], "after a yes the command runs; a Node still old says so and goes no further (no silent success)"); ok(/Open a new terminal/.test(s.said), "and says to open a new terminal"); }
{ const s = await session({ answers: ["1"], yes: true, manager: brew, python: pipx, runs: () => 1 }); eq([s.reran, s.ended], [[], "failed"], "a failed update goes no further"); }
{ const s = await session({ answers: ["1"], yes: true, manager: brew, python: pipx, node: { path: "/opt/homebrew/bin/node", version: "24.1.0" } }); eq([s.ran, s.reran, s.ended], [["brew upgrade node"], ["/opt/homebrew/bin/node update", "/opt/homebrew/bin/node remote app"], "returned"], "a new Node: update repairs the hook's and the doors' Node path, then the original command goes on, both under the new Node"); ok(s.said.indexOf("This runs: brew upgrade node") < s.said.indexOf("ASK Run it now?") && s.said.includes("✓ Node is now 24.1.0."), "shown before asked, and the new version said"); }
{ const s = await session({ answers: ["2"], yes: true, manager: brew, python: pipx }); eq([s.ran, s.reran, s.ended], [["pipx run worktrust remote app"], [], "returned"], "the Python way runs the same command through pipx, after a yes"); }
{ const s = await session({ answers: ["2"], yes: false, manager: brew, python: pipx }); eq(s.ran, [], "and not without one"); }

rmSync(dir, { recursive: true, force: true });
console.log(`cli-node-floor: ${held} checks passed on Node ${process.versions.node} (${native ? "WebSocket taken away by a preload" : "no WebSocket in this Node"}: every starting remote command refused with the ways forward and nothing written; the other commands work; no sudo, no run without a yes)`);
