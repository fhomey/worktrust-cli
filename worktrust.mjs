#!/usr/bin/env node
/**
 * WorkTrust on a computer, in one command — like `gh auth login` (2026-10-03).
 *   npx worktrust                       show the plan, ask, approve this computer in the app, couple (0.10.7: a person's
 *                                       command always runs the newest version, whatever npx had cached);
 *                                       on a computer already coupled: what is coupled here
 *   npx worktrust --dry-run             show the plan only; nothing is written, nothing is sent
 *   npx worktrust --yes                 no question (for scripts); the computer is still approved in the app
 *   npx worktrust --device              a computer without a browser (SSH): type a code on another device
 *   npx worktrust connect                      couple again, also on a computer already coupled
 *   npx worktrust update                       this computer onto the newest CLI, same key, no new pairing (0.10.30: what
 *                                              was agreed before is refreshed unasked; --rebuild agrees to the re-measure)
 *   npx worktrust history                      send this computer's earlier sessions as history (asks first)
 *   npx worktrust history --rebuild            the same as history (0.10.5: history always re-measures); WorkTrust replaces this computer's
 *                                              earlier lines day by day, never counting a day twice (shows the plan, asks first)
 *   npx worktrust history --from-archive [dir]   send what your local archive holds of sessions your AI apps have
 *                                              already deleted, marked as from your archive (shows the plan, asks first):
 *                                              a day this computer's device key signed as measured, every other day
 *                                              (unsigned, the local archive key's, another computer's) as reconstructed
 *   npx worktrust history --from-folder <dir>  your own copy of an AI app's session folder (a backed-up ~/.claude/projects,
 *                                              ~/.codex/sessions): the days this computer's own sessions lack, reconstructed,
 *                                              never verified hours (shows the plan, asks first; 0.10.10)
 *   npx worktrust history --export <path>      a ChatGPT or Claude data export (the zip, its folder, conversations.json, a conversations part or the manifest)
 *                                              as history: hours RECONSTRUCTED from its clocks, shown with their origin,
 *                                              never verified hours (shows the plan, asks first; 0.10.10). The bare
 *                                              command on a coupled computer offers an export lying in ~/Downloads once.
 *   npx worktrust disconnect                   show what comes out, ask, take it out again
 *   npx worktrust status                       what is coupled here
 *   npx worktrust@latest preserve              how long each AI app here keeps its sessions (--apply keeps them,
 *                                       --archive [dir] a local metadata-only record, --verify [dir] checks it,
 *                                       --summary [dir] counts hours, tokens and parallel sessions from it);
 *                                       local only: no account, no key, no network (preserve.mjs)
 * WHAT RUNS. From the npm package, everything that runs is in the package: this file,
 * `setup-mcp.mjs` (gives every AI app here the WorkTrust door), `log-session.mjs` (the session hook)
 * and `count-behaviour.mjs` (the local counter, pinned: never replaced from the network), with
 * `transcript-readers.mjs` (how Codex and Antigravity logs are read, imported by the last two). Individual support scripts are never downloaded or executed outside the complete release.
 * HOW THE ACCOUNT IS DECIDED. By default this terminal listens on 127.0.0.1 for one answer and holds
 * a PKCE secret. Your browser opens WorkTrust, you approve this computer there (signed in, second
 * factor), and the browser is sent back to 127.0.0.1 with a one-time code that only this terminal,
 * with its secret, can exchange for the key. Nothing is typed, and a link forwarded to someone else
 * approves nothing they can collect. Without a browser (`--device`, or over SSH) the terminal shows
 * a code that you type yourself at app.worktrust.io/connect/computer.
 * WHERE THE KEY LIVES. A private local file until the person runs protect-key; then an encrypted
 * envelope in that file, with its wrapping key in the OS vault. AI apps run the bridge and never
 * receive these credentials in their settings. Protected mode refuses --direct.
 * SIGNATURES PROVE POSSESSION. connect makes an Ed25519 pair and registers the public half.
 * Requests carry fresh signatures and single-use nonces. Software authorized as the same OS user
 * may still use the private key; neither file encryption nor signatures prove truthful activity.
 *
 * THE KEY RENEWS ITSELF EVERY WEEK. The bridge or the hook makes a new secret on this computer, sends
 * only its hash, signed with the current key, and stores the new one; a copy of last week's key stops
 * working. If the answer is lost on the way, the next run finds out which of the two still works.
 *
 * WHAT IS SENT. To pair: this computer's system (macOS, Windows, Linux) and host name. After: what
 * the scripts send, which is metadata only — no prompt, no answer, no code, no file path. The key
 * reaches the scripts in their environment, never on a command line, and is written only into the
 * AI apps' own settings, where an MCP key always lives.
 *
 * No dependencies: Node 18 or later.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { createInterface as lines } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const { moduleArgs, moduleExecutable, readPrivateFile, writePrivateFile } = await import("./package-integrity.mjs").catch(() => ({}));

const args = process.argv.slice(2);
const VALUED = ["--name", "--origin", "--url", "--export", "--from-folder"];
const command = args.includes("--help") ? "help" : args.includes("--version") ? "version" : args.find((arg, at) => !arg.startsWith("--") && !(at > 0 && VALUED.includes(args[at - 1]))) ?? "default";
const flag = (name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
/** This CLI's version, said to the door so the app can tell which computer runs an old one (check-cli-package holds it equal to package.json). */
const CLI_VERSION = "0.10.33";
/**
 * HOW THIS CLI MEASURES, AS A NUMBER OF ITS OWN (0.10.31; owner, 2026-10-28: 0.10.30 offered a re-measure it had no reason
 * to offer). Raised ONLY when what is measured changes: the timeline, the seconds, the tokens, the steering, the session
 * kinds, the readers. A release that changes consent, coupling or words keeps it. `update` offers the re-measure only when
 * the earlier install measured by other rules, and names what changed from MEASURE_CHANGES; installed-release.json and
 * history.json record it. 1 is the rules of 0.10.29, which 0.10.30 and 0.10.31 kept; 2 (0.10.32) adds the subagent runs, each
 * agent call's outcome and who wrote each turn of a run no person started.
 * 0.10.33 KEEPS 2 (release 9, 2026-10-29): one line per autonomous process per day changes how finished headless and
 * scheduled runs are PACKED into lines, not what is measured: the timeline, the seconds (the minute compaction keeps every
 * counted second), the tokens, the steering, the session kinds and the readers are the same. On production (read-only) the
 * existing data a re-measure would repack is 4 headless lines of one person on 2 days, none scheduled, none with a person's
 * second and none under the 60 s floor, so a re-measure would move no figure the passport shows; raising would offer every
 * person a re-measure for nothing. New runs arrive folded from 0.10.33 on.
 */
const MEASURE_RULES = 2;
/** What each measure-rules version changed, in the words the re-measure offer says (one entry per raise, never rewritten). */
const MEASURE_CHANGES = {
  1: ["each answer's tokens counted once", "nothing lost at midnight", "when each stretch began", "how you steered the agent", "what the seconds were", "more AI apps", "how each session was started"],
  2: ["which subagents were active at once, and how their failed steps were recovered", "whether each agent call completed", "who wrote each turn of a run no person started"],
};
const ORIGIN = (flag("origin") ?? process.env.WORKTRUST_ORIGIN ?? "https://app.worktrust.io").replace(/\/$/, "");
const MCP = flag("url") ?? process.env.WORKTRUST_MCP_URL ?? `${ORIGIN}/api/mcp`;
const HOME_DIR = join(homedir(), ".worktrust");
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ["credential-store.mjs", "credential-vault.mjs", "credential-vault-scripts.mjs", "history-outbox.mjs", "setup-mcp.mjs", "log-session.mjs", "count-behaviour.mjs", "transcript-readers.mjs", "session-databases.mjs", "config-edits.mjs", "stretch-evidence.mjs", "chat-exports.mjs", "stack-rules.mjs", "runtime-install.mjs", "orchestration-contract.mjs", "orchestration-evidence.mjs", "orchestration-report.mjs", "claude-mod.mjs", "package-integrity.mjs", "worktrust-launch.mjs"];
/** The modules the scripts import by name from beside them; a download keeps that name. */
const IMPORTED = new Set(["transcript-readers.mjs", "session-databases.mjs", "config-edits.mjs", "stretch-evidence.mjs", "chat-exports.mjs", "stack-rules.mjs", "runtime-install.mjs", "orchestration-contract.mjs", "orchestration-evidence.mjs", "orchestration-report.mjs"]);
const downloaded = (name) => (IMPORTED.has(name) ? name : `${name}.download.mjs`);
const BUNDLED = SCRIPTS.every((name) => existsSync(join(HERE, name)));
const PLACEHOLDER = `wt_${"0".repeat(43)}`;
const say = (line = "") => process.stdout.write(`${line}\n`);
// A reader that closed the pipe (`worktrust status | head`) wants no more: stop quietly, never an EPIPE stack (0.6.16, audit L4).
process.stdout.on("error", (error) => { if (error?.code === "EPIPE") process.exit(0); throw error; });
class CliFailure extends Error {}
const fail = (line) => { process.stderr.write(`worktrust: ${line}\n`); throw new CliFailure(); };
const NODE_FLAGS = process.versions.node === "26.5.0" ? ["--no-concurrent-sparkplug"] : [];
const OS = { darwin: "macos", win32: "windows", linux: "linux" }[platform()] ?? "other";
const OS_NAME = { macos: "macOS", windows: "Windows", linux: "Linux", other: "this system" }[OS];

/**
 * WHICH COMPUTER, WHICH PROFILE (0.6.10, owner 2026-10-05: one computer coupled twice sent its history twice). The
 * machine's own id (macOS hardware UUID, Windows MachineGuid, Linux machine-id) and, for the profile, that id with this
 * user's home folder: two people or two environments on one computer stay two. Only one-way hashes leave the computer,
 * and WorkTrust keeps them only mixed with the account, so the same machine under two accounts matches nothing.
 * A machine whose id cannot be read sends nothing, and is a computer as before.
 */
function machineId() {
  try {
    if (OS === "macos") return execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3000 }).match(/"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/)?.[1] ?? null;
    if (OS === "windows") return execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 3000 }).match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/)?.[1] ?? null;
    if (OS === "linux") for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) if (existsSync(file)) { const id = readFileSync(file, "utf8").trim(); if (/^[0-9a-f]{32}$/.test(id)) return id; }
  } catch { /* unreadable: no identity */ }
  return null;
}
function computerIds() {
  const machine = machineId();
  if (!machine) return {};
  const hash = (text) => createHash("sha256").update(text).digest("base64url");
  return { device_id: hash(`worktrust-machine|${machine.toLowerCase()}`), profile_id: hash(`worktrust-profile|${machine.toLowerCase()}|${homedir()}`) };
}

async function post(path, body) {
  const response = await fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

/** Every helper belongs to this complete release. No loose-file download fallback. */
async function scripts() {
  if (BUNDLED) return Object.fromEntries(SCRIPTS.map((name) => [name, join(HERE, name)]));
  fail("Use the complete official npm/Python package or preservation kit. Individual scripts are not downloaded or executed without release verification.");
}

/** Stable across bearer renewal, distinct across account/device replacement. Never sent to the server. */
function historyQueueScope(token) {
  const key = keyStore.load();
  if (!key || key.token !== token || !key.accountRef || !key.device) return "";
  try { return createHash("sha256").update(`${key.accountRef}\0${createPublicKey(key.device).export({ format: "jwk" }).x}`).digest("hex"); }
  catch { return ""; }
}

/** Run a script; its output is shown, or collected for the plan. The key travels in the environment only. */
function run(path, scriptArgs, token, collect = false, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(moduleExecutable(HERE), [...moduleArgs(HERE, basename(path), scriptArgs)], { stdio: collect ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, WORKTRUST_MCP_URL: MCP, WORKTRUST_MCP_TOKEN: token, WORKTRUST_NODE: NODE, WORKTRUST_NODE_ARGS: JSON.stringify(NODE_ARGS), WORKTRUST_CLI_VERSION: CLI_VERSION, WORKTRUST_MEASURE_RULES: String(MEASURE_RULES), WORKTRUST_HISTORY_SCOPE: historyQueueScope(token), ...extraEnv } });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** `yes` is the answer Enter gives, and the one `--yes` gives: a question whose default is No stays No under --yes. */
async function ask(question, yes = true) {
  if (has("yes")) return yes;
  if (!process.stdin.isTTY) fail("not a terminal: nothing was changed. Run it in a terminal, or add --yes to agree in advance.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`  ${question} ${yes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  prompt.close();
  return answer === "" ? yes : answer === "y" || answer === "yes";
}

function openBrowser(url) {
  const [cmd, cmdArgs] = OS === "macos" ? ["open", [url]] : OS === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the code can be typed */ }
}

/** The apps setup-mcp found and the file each would change, from its own dry run. */
const planLines = (out, replacing = false) => out.split("\n").filter((line) => /^\s+[+✓!−-] /.test(line)).map((line) => {
  const text = line.trim()
    // connect takes the old entry out and writes the new key, so "already there" means "replaced".
    .replace(/^✓ (.+?): already names the door \((.+)\)$/, replacing ? "↻ $1: the WorkTrust entry is replaced ($2)" : "✓ $1: already names the door ($2)")
    .replace(/^✓ Claude Code: already coupled$/, replacing ? "↻ Claude Code: the WorkTrust entry is replaced (`claude mcp`)" : "✓ Claude Code: already coupled")
    .replace(/^! Claude Code: run `(claude mcp remove[^`]*)`$/, "− Claude Code: `$1`");
  return `    ${text}`;
});

/** No browser to send back: a session over SSH, a Linux box without a display, or asked for. */
const useDevice = () => has("device") || has("no-browser") || Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) || (OS === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

const DONE_PAGE = "<!doctype html><meta charset=utf-8><title>WorkTrust</title><body style=\"font:16px system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem\"><h1 style=\"font-size:1.25rem\">This computer is connected</h1><p>Return to your terminal: it finishes setting up by itself. You can close this tab.</p>";

/**
 * THE DEFAULT: approve in the browser, come back to this computer. The terminal listens on 127.0.0.1
 * (a random free port, this machine only) for exactly one answer that carries the state it chose,
 * and exchanges the one-time code with its PKCE verifier. Ten minutes, then it gives up.
 */
async function pairByBrowser(host, extra) {
  const extraBound = Boolean(extra.device_key);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  let deliver;
  const answer = new Promise((resolve) => { deliver = resolve; });
  // Where the browser goes once this terminal has its code (0.6.11, owner 2026-10-06): WorkTrust's own "connected" page in
  // the house style, not a bare page on 127.0.0.1. Known once the pairing has its code; until then the plain page.
  let doneUrl = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) { response.writeHead(404).end(); return; }
    if (doneUrl) response.writeHead(303, { location: doneUrl, "cache-control": "no-store" }).end();
    else response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(DONE_PAGE);
    deliver(url.searchParams.get("code"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const pairing = await post("/api/cli/pair", { host, os: OS, flow: "loopback", code_challenge: challenge, port, state, ...extra }).catch(() => null);
  if (!pairing) { server.close(); fail(`cannot reach ${ORIGIN}.`); }
  if (pairing.status !== 200) { server.close(); fail(pairing.json.error === "rate_limited" ? "too many attempts from this network; wait a minute." : `pairing refused (${pairing.json.error ?? pairing.status}).`); }
  const { device_code: secret, authorize_url: url, user_code: shown, expires_in: lifetime = 600, features = [] } = pairing.json;
  doneUrl = `${ORIGIN}/connect/computer/done?code=${encodeURIComponent(shown)}`;
  if (!features.includes("loopback")) { server.close(); fail(`${ORIGIN} is older than this command. Use the command WorkTrust shows under Sources → Add a computer.`); }
  say();
  say(`  Your code:  ${shown}  (the WorkTrust page shows the same; approve only if it matches)`);
  say("  Approve this computer in your browser (opening it now).");
  say(`  If it does not open, open this link on THIS computer: ${url}`);
  openBrowser(url);
  const timer = setTimeout(() => deliver(null), lifetime * 1000);
  const code = await answer;
  clearTimeout(timer);
  server.close();
  if (!code) fail("no approval arrived in time. Run `worktrust connect` again.");
  const exchange = await post("/api/cli/token", { device_code: secret, code, code_verifier: verifier }).catch(() => null);
  if (exchange?.json?.error === "device_limit") fail("The devices your plan allows are already connected. In WorkTrust Sources, disconnect a device (or upgrade to Premium for more), then connect again. Every connected device keeps working and earlier measurements are kept.");
  if (!exchange || exchange.status !== 200 || !exchange.json.token) fail(`the approval could not be exchanged (${exchange?.json?.error ?? "no answer"}). Run \`worktrust connect\` again.`);
  say(`  ✓ Approved as "${exchange.json.label}"${exchange.json.account ? ` for the WorkTrust account ${exchange.json.account}` : ""}`);
  if (exchange.json.account) say("    Not your account? Run `npx worktrust disconnect` now and revoke it in WorkTrust.");
  if (extraBound && exchange.json.bound === false) say("  ! WorkTrust did not bind the key to this computer; it works like a key made by hand.");
  return paired(exchange.json);
}

/**
 * What a pairing hands back: the key, its prefix (which names it to /api/cli/release), the account
 * masked (to show), and `account_ref`, an opaque name for the account that is the same on every
 * pairing of it, so a computer coupled again can tell "the same account" from "another one".
 */
const paired = (json) => ({ token: json.token, prefix: typeof json.prefix === "string" ? json.prefix : null, account: json.account ?? null, accountRef: json.account_ref ?? null });

/** WITHOUT A BROWSER: a code you type yourself on another device. Never a link with the code in it. */
async function pairByCode(host, extra) {
  const pairing = await post("/api/cli/pair", { host, os: OS, flow: "device", ...extra }).catch(() => fail(`cannot reach ${ORIGIN}.`));
  if (pairing.status !== 200) fail(pairing.json.error === "rate_limited" ? "too many attempts from this network; wait a minute." : `pairing refused (${pairing.json.error ?? pairing.status}).`);
  const { user_code: code, device_code: secret, verification_uri: page, interval = 3, expires_in: lifetime = 600 } = pairing.json;
  say();
  say(`  On any device, open ${page}`);
  say(`  and type this code:  ${code}`);
  say("  Only you should type it: never approve a code someone else sent you.");
  const until = Date.now() + lifetime * 1000;
  let wait = interval * 1000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const answer = await post("/api/cli/token", { device_code: secret }).catch(() => null);
    if (!answer) continue;
    if (answer.status === 200 && answer.json.token) {
      say(`  ✓ Approved as "${answer.json.label}"${answer.json.account ? ` for the WorkTrust account ${answer.json.account}` : ""}`);
      if (answer.json.account) say("    Not your account? Run `npx worktrust disconnect` now and revoke it in WorkTrust.");
      return paired(answer.json);
    }
    if (answer.json.error === "device_limit") fail("The devices your plan allows are already connected. In WorkTrust Sources, disconnect a device (or upgrade to Premium for more), then connect again. Every connected device keeps working and earlier measurements are kept.");
    if (answer.json.error === "slow_down") wait += 2000;
    else if (answer.json.error === "expired_token") fail("the code expired. Run `worktrust connect` again.");
    else if (answer.json.error === "invalid_grant") fail("this pairing was already used. Run `worktrust connect` again.");
  }
  fail("the code expired. Run `worktrust connect` again.");
}

/**
 * The node the AI apps will start the bridge with: the one on PATH (a link such as /opt/homebrew/bin/node
 * that survives an upgrade), not this process's resolved path, which names one version and breaks
 * with the next `brew upgrade node`.
 */
let NODE = process.env.WORKTRUST_BUNDLED_RUNTIME_DIR ? process.execPath : (process.env.PATH ?? "").split(OS === "windows" ? ";" : ":").map((dir) => join(dir, OS === "windows" ? "node.exe" : "node")).find((path) => existsSync(path)) ?? process.execPath;
const KEY_FILE = join(HOME_DIR, "key.json");
const STABLE_FILE = join(HOME_DIR, "worktrust.mjs");
let STABLE = join(HERE, "worktrust-launch.mjs"), runtimePrepared = false, NODE_ARGS = [];
const RENEW_EVERY_MS = 7 * 24 * 3600_000;
const KEY_PLACE = "~/.worktrust/key.json (storage protection is shown by worktrust status)";
const ensureHome = () => { mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 }); try { chmodSync(HOME_DIR, 0o700); } catch { /* Windows */ } };

/** A tool-runner cache is disposable. Install the whole verified runtime/engine before changing wiring. */
async function prepareBundledRuntime() {
  if (runtimePrepared) return;
  const installedLauncher = join(dirname(HERE), "worktrust-launch.py");
  if (moduleExecutable(HERE) !== process.execPath) {
    NODE = process.env.WORKTRUST_BUNDLED_PYTHON; NODE_ARGS = ["-I"]; STABLE = installedLauncher; runtimePrepared = true; return;
  }
  if (!process.env.WORKTRUST_BUNDLED_RUNTIME_DIR) {
    if (existsSync(join(HERE, "package-release.json"))) {
      if (existsSync(HOME_DIR) && (!lstatSync(HOME_DIR).isDirectory() || lstatSync(HOME_DIR).isSymbolicLink())) fail("the WorkTrust directory must be a directory, not a symlink.");
      ensureHome(); const { installSignedPackage } = await import("./package-integrity.mjs"); STABLE = installSignedPackage(HERE, HOME_DIR); runtimePrepared = true;
    }
    return;
  }
  const { installRuntime } = await import("./runtime-install.mjs");
  if (existsSync(HOME_DIR) && (!lstatSync(HOME_DIR).isDirectory() || lstatSync(HOME_DIR).isSymbolicLink())) fail("the WorkTrust directory must be a directory, not a symlink.");
  ensureHome();
  const installed = installRuntime(process.env.WORKTRUST_BUNDLED_RUNTIME_DIR, HERE, HOME_DIR, ["worktrust.mjs", ...SCRIPTS, "preserve.mjs", "preserve-lines.mjs", "preserve-summary.mjs"]);
  NODE = installed.executable; NODE_ARGS = installed.args; STABLE = installed.bridge; runtimePrepared = true;
}
function saveStableEntry() {
  const target = join(HOME_DIR, "installed-release.json"), temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try { writeFileSync(temporary, JSON.stringify({ version: CLI_VERSION, measureRules: MEASURE_RULES }), { flag: "wx", mode: 0o600 }); renameSync(temporary, target); }
  finally { try { rmSync(temporary); } catch { /* already renamed */ } }
}

/** Existing file credentials remain readable until the person explicitly protects them.
 * The OS wrapping key is never written into an AI app or the encrypted credential file.
 */
const { createCredentialStore } = await import("./credential-store.mjs").catch(() => ({}));
const keyStore = createCredentialStore?.(KEY_FILE);
async function protectKey() {
  say("  Protect the WorkTrust token and signing key with this OS account's credential vault.");
  say("  Quit AI apps first; restart them after this finishes. Older bridges cannot read protected credentials.");
  say("  This protects stored secrets. It does not prove that local activity is genuine.");
  if (has("dry-run")) { say("  Dry run: no vault or credential was changed."); return; }
  if (keyStore.load() && stableVersion() !== CLI_VERSION) fail("Run worktrust update from this release first, then quit your AI apps and run worktrust protect-key.");
  if (!(await ask("Protect the local credentials?"))) return;
  try { keyStore.protect(); }
  catch { fail("OS credential storage was unavailable or the credential file could not be safely replaced. Existing credentials were preserved. Unlock your OS vault, check worktrust status, and retry. No keychain reset is needed."); }
  say("  Credentials are protected by the OS vault. Restart your AI apps. No account data or Passport was changed.");
}

/**
 * WHICH ACCOUNT THIS COMPUTER LAST FED, after `disconnect` (owner, 2026-10-04). The key file goes; this
 * small note stays (the masked address and the opaque account name, nothing secret), so that a later
 * `connect` by ANOTHER account is recognised as a change of hands and offers none of the first
 * person's earlier work. A successful `connect` deletes it.
 */
const PREVIOUS_FILE = join(HOME_DIR, "previous.json");
const previousNote = {
  save(entry) { if (!entry?.accountRef && !entry?.account) return; ensureHome(); writeFileSync(PREVIOUS_FILE, JSON.stringify({ account: entry.account ?? null, accountRef: entry.accountRef ?? null, until: new Date().toISOString() }), { mode: 0o600 }); },
  load() { try { return JSON.parse(readFileSync(PREVIOUS_FILE, "utf8")); } catch { return null; } },
  erase() { try { rmSync(PREVIOUS_FILE); } catch { /* gone */ } },
};

/**
 * WHAT THE PERSON ALREADY AGREED TO (0.10.30, owner 2026-10-28: "an update should need fewer y + Enter"). One small file,
 * ~/.worktrust/consent.json (0600): per coupling the person said yes to, its name only (`door:<app>`, `session-hook`,
 * `codex-notify`, `antigravity-stop`), the day, the CLI version and how (`typed`, `flag`: --yes / --codex / --antigravity
 * said in advance, `found`: a WorkTrust entry already here when this file was first made, which only a yes ever wrote).
 * Never a key, a path or a config's content. `update` refreshes an agreed entry whose only change is the launcher's path
 * without asking; a NEW app or hook still asks, and under --yes is skipped. A No drops the entry; disconnect deletes the
 * file; a coupling to another account starts it empty. An unreadable file counts as no agreement at all.
 */
const CONSENT_FILE = join(HOME_DIR, "consent.json");
const CONSENT_NAME = /^(?:door:[^\n,]{1,80}|session-hook|codex-notify|antigravity-stop)$/;
const CONSENT_HOW = new Set(["typed", "flag", "found"]);
let consentLoaded = null;
async function consent() {
  if (consentLoaded) return consentLoaded;
  let file = null;
  try { const text = readPrivateFile(CONSENT_FILE); file = text === null ? null : JSON.parse(text); } catch { file = {}; }
  const entries = {};
  for (const [name, entry] of Object.entries(file?.entries ?? {})) if (CONSENT_NAME.test(name) && /^\d{4}-\d{2}-\d{2}$/.test(entry?.at ?? "") && CONSENT_HOW.has(entry?.how)) entries[name] = { at: entry.at, cli: String(entry.cli ?? "").slice(0, 16), how: entry.how };
  let dirty = false;
  const today = () => new Date().toISOString().slice(0, 10);
  // THE FIRST RUN THAT KEEPS THIS FILE: what WorkTrust already wrote here on an earlier yes counts as that yes, once.
  if (file === null) { for (const name of await consentFound()) entries[name] = { at: today(), cli: CLI_VERSION, how: "found" }; dirty = Object.keys(entries).length > 0; }
  const save = () => { if (!dirty || has("dry-run")) return; try { ensureHome(); writePrivateFile(CONSENT_FILE, `${JSON.stringify({ version: 1, entries })}\n`); dirty = false; } catch { /* not kept: the next run asks again */ } };
  consentLoaded = {
    has: (name) => Boolean(entries[name]),
    said: (name) => (entries[name]?.how === "found" ? "you agreed with an earlier version" : `you agreed on ${entries[name]?.at}`),
    agree(name, how) { if (!entries[name]) { entries[name] = { at: today(), cli: CLI_VERSION, how }; dirty = true; } save(); },
    drop(name) { if (entries[name]) { delete entries[name]; dirty = true; } save(); },
    reset() { for (const name of Object.keys(entries)) delete entries[name]; dirty = true; save(); },
    save,
  };
  return consentLoaded;
}
function eraseConsent() { try { rmSync(CONSENT_FILE); } catch { /* none */ } consentLoaded = null; }
/** The WorkTrust entries already standing here: each app's door (setup-mcp's own removal plan), the session hook, Codex's and Antigravity's wake hooks. */
async function consentFound() {
  const found = [];
  try {
    const plan = await run((await scripts())["setup-mcp.mjs"], ["--remove"], PLACEHOLDER, true);
    for (const line of plan.out.split("\n")) { const match = /^\s+− ([^:]+): would (?:remove from|run)/.exec(line); if (match && match[1] !== "Claude Code") found.push(`door:${match[1]}`); }
  } catch { /* no plan: nothing found */ }
  if (claudeDoorHere()) found.push("door:Claude Code");
  if (sessionHookHere()) found.push("session-hook");
  if (existsSync(join(homedir(), ".codex")) && isOurNotify(codexNotify().text ?? "")) found.push("codex-notify");
  if (antigravityHere() && agyHooks()?.worktrust) found.push("antigravity-stop");
  return found.filter((name) => CONSENT_NAME.test(name));
}
/** Claude Code's own entry for the door, as status reads it; the session hook in its settings. */
function claudeDoorHere() {
  const servers = {};
  try { const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")); Object.assign(servers, config.mcpServers ?? {}); for (const project of Object.values(config.projects ?? {})) Object.assign(servers, project.mcpServers ?? {}); } catch { /* no Claude Code here */ }
  return Object.entries(servers).find(([name, server]) => /worktrust/i.test(`${name} ${server?.url ?? ""} ${(server?.args ?? []).join(" ")}`)) ?? null;
}
function sessionHookHere() { try { return /log-session|worktrust(?:-launch)?\.(?:mjs|py)\\?" hook/.test(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")); } catch { return false; } }
/** The app a plan line names: "    ✓ Cursor: …" → Cursor. */
const labelOf = (line) => /^\s*[↻+✓!−-] ([^:]+):/.exec(line)?.[1] ?? null;

/**
 * THE OLD KEY ENDS WHEN THE COMPUTER IS COUPLED AGAIN (owner, 2026-10-04). Signed with the old key's own
 * device key, which only this computer holds, and naming the new key by its prefix: WorkTrust ends the
 * old one at once (an AI app still open on it is refused, reads the key file again and continues on the
 * new key) and, when the two keys belong to different accounts, tells the old account its computer
 * moved, without saying to whom.
 */
async function releasePrevious(previous, nextPrefix) {
  if (!previous?.token || !nextPrefix) return;
  if (!previous.device) { say("  ! The previous key was not bound to this computer: end it in WorkTrust → Sources → Devices."); return; }
  try {
    const url = `${new URL(previous.url).origin}/api/cli/release`;
    const body = JSON.stringify({ next_prefix: nextPrefix });
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${previous.token}`, ...proof(previous.device, url, body) }, body });
    if (response.ok) say("  ✓ The previous key ended; WorkTrust no longer accepts it.");
    else say(`  ! The previous key could not be ended (${response.status}): end it in WorkTrust → Sources → Devices.`);
  } catch { say("  ! WorkTrust could not be reached to end the previous key: end it in WorkTrust → Sources → Devices."); }
}

/** `WorkTrust-Proof` for one request: seconds, a one-time nonce, and the Ed25519 signature over method, path, both and the body's hash. */
function proof(device, url, body) {
  if (!device) return {};
  const seconds = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const message = `POST\n${new URL(url).pathname}\n${seconds}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`;
  return { "worktrust-proof": `${seconds}.${nonce}.${sign(null, Buffer.from(message), device).toString("base64url")}` };
}

/** Whether the door accepts a key: one call that reads nothing back. */
async function accepted(url, token, device) {
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" });
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, "user-agent": `worktrust-bridge worktrust-cli/${CLI_VERSION}`, ...proof(device, url, body) }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) return false;
    if (response.status !== 200) return null;
    const answer = await response.json();
    return answer?.jsonrpc === "2.0" && answer.id === 0 && !answer.error && Array.isArray(answer.result?.tools) ? true : null;
  } catch { return null; }
}

/**
 * RENEW WHEN DUE. The new secret is made here and stored as `pending` BEFORE it is announced, so a
 * lost answer is recoverable: next time, whichever of the two keys the door accepts is kept.
 */
/**
 * ONE RENEWAL AT A TIME (security audit 2026-10-03, MEDIUM-2). Claude Code starts the hook and every
 * AI app starts a bridge at the same moment, and two renewals racing used to leave the file holding a
 * dead key. Now a renewal holds ~/.worktrust/renew.lock (created exclusively; a lock older than a minute
 * is a crashed run's and is taken over), re-reads the file inside it, and writes back only what it
 * just read. Whoever does not get the lock reads the file again afterwards and uses what is there.
 */
const LOCK_FILE = join(HOME_DIR, "renew.lock");
function withLock(work) {
  ensureHome();
  try { if (Date.now() - statSync(LOCK_FILE).mtimeMs > 60_000) rmSync(LOCK_FILE); } catch { /* no lock */ }
  let handle;
  try { handle = openSync(LOCK_FILE, "wx", 0o600); } catch { return null; }
  return work().finally(() => { closeSync(handle); try { rmSync(LOCK_FILE); } catch { /* gone */ } });
}

/**
 * A KEY FILE ON OTHER HARDWARE (0.6.10, owner 2026-10-05: "a backup restored onto a new device must not upload to the
 * passport unseen"). The key file remembers the profile it was made on; on any other computer it sends nothing, and
 * WorkTrust is told once (`/api/cli/moved`), so the key is ended and the owner sees it. `npx worktrust@latest connect` couples this one.
 */
async function copiedHere(key) {
  const here = computerIds().profile_id;
  if (!key.profile || !here || key.profile === here) return false;
  try {
    // Its own door, which only ends and marks the key: nothing is renewed, so no new secret is ever announced here.
    const url = `${new URL(key.url).origin}/api/cli/moved`, body = JSON.stringify(computerIds());
    await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.token}`, ...proof(key.device, url, body) }, body });
  } catch { /* offline: it is told next time */ }
  process.stderr.write("WorkTrust: this key was made on another computer (copied from a backup?). Nothing is sent from here; run `npx worktrust connect` on this computer.\n");
  return true;
}

async function freshKey() {
  const first = keyStore.load();
  if (!first) return null;
  if (await copiedHere(first)) return null;
  // A key made before 0.6.10 renews now, once: the renewal carries the computer's identity. `identified` means it was
  // tried, so a machine whose id cannot be read does not renew on every use.
  if (!first.pending && first.identified && Date.now() - Date.parse(first.renewedAt ?? 0) < RENEW_EVERY_MS) return first;
  const settled = await withLock(async () => {
    const value = keyStore.load();
    if (!value) return null;
    if (value.pending) {
      const next = await accepted(value.url, value.pending, value.device);
      if (next === true) { const promoted = { ...value, token: value.pending, renewedAt: new Date().toISOString() }; delete promoted.pending; keyStore.save(promoted); return promoted; }
      if (next === false) { delete value.pending; keyStore.save(value); }
      // Unknown means the pending token may already be the server's only accepted key. Never replace it on an outage.
      if (next === null) return value;
    }
    if (value.identified && Date.now() - Date.parse(value.renewedAt ?? 0) < RENEW_EVERY_MS) return value;
    const pending = `wt_${randomBytes(32).toString("base64url")}`;
    keyStore.save({ ...value, pending });
    try {
      const renewUrl = `${new URL(value.url).origin}/api/cli/renew`;
      const ids = computerIds();
      const body = JSON.stringify({ token_hash: createHash("sha256").update(pending).digest("hex"), token_prefix: pending.slice(0, 11), ...ids });
      const response = await fetch(renewUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${value.token}`, ...proof(value.device, renewUrl, body) }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status === 200) {
        const answer = await response.json();
        if (typeof answer?.renewed_at === "string" && Number.isFinite(Date.parse(answer.renewed_at))) {
          const renewed = { ...value, token: pending, renewedAt: new Date().toISOString(), identified: true, profile: value.profile ?? ids.profile_id }; keyStore.save(renewed); return renewed;
        }
      }
      // Refused: drop the pending key only if the file still holds the value this renewal read.
      if (response.status === 400 || response.status === 401) { const now = keyStore.load(); if (now?.token === value.token && now?.pending === pending) keyStore.save(value); }
    } catch { /* offline: the pending key is settled next time */ }
    return keyStore.load();
  });
  if (settled) return settled;
  // Someone else holds the lock: wait for them (ten seconds at most), then their result is in the file.
  for (let waited = 0; waited < 10_000 && existsSync(LOCK_FILE); waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
  return keyStore.load();
}

/**
 * THE BRIDGE an AI app runs (`worktrust.mjs mcp`): JSON-RPC lines on stdin, forwarded to the door with
 * the key from the key file, answers on stdout. It names the app that started it (from `initialize`),
 * so WorkTrust still sees Claude Code or Cursor, not the bridge.
 */
/**
 * A SWEEP WHEN AN AI APP OPENS THE DOOR (0.6.11, owner 2026-10-06). Cursor and VS Code run no hook WorkTrust can give
 * them, so the session hook never woke for a person who works there all day; both do start this bridge whenever they
 * open. So the bridge starts the sweep once, detached and silent (stdout stays the MCP channel), at most once an hour.
 */
function sweepAtMostHourly() {
  const stamp = join(HOME_DIR, "bridge-swept-at");
  try { if (Date.now() - Number(readFileSync(stamp, "utf8")) < 3_600_000) return; } catch { /* never swept here */ }
  try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(stamp, String(Date.now())); } catch { return; }
  try { spawn(moduleExecutable(HERE), [...moduleArgs(HERE, "worktrust.mjs", ["hook"])], { detached: true, stdio: "ignore" }).unref(); } catch { /* the next start sweeps */ }
}

async function bridge() {
  let key = await freshKey();
  if (key) sweepAtMostHourly();
  const answer = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);
  let session = null;
  let agent = "worktrust-bridge";
  for await (const line of lines({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize" && message.params?.clientInfo?.name) agent = `${message.params.clientInfo.name}/${message.params.clientInfo.version ?? "0"} (worktrust-bridge) worktrust-cli/${CLI_VERSION}`;
    // A long-lived bridge must not keep using a cached key after local disconnect or vault lock.
    try { key = await freshKey(); }
    catch { key = null; if (message.id !== undefined) answer(message.id, "WorkTrust credential storage is unavailable. Unlock your OS vault and retry; no request was sent."); continue; }
    if (!key) { if (message.id !== undefined) answer(message.id, "WorkTrust is not connected on this computer: run `npx worktrust connect`."); continue; }
    try {
      const response = await fetch(key.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key.token}`, "user-agent": agent, ...(session ? { "mcp-session-id": session } : {}), ...proof(key.device, key.url, line) }, body: line });
      session = response.headers.get("mcp-session-id") ?? session;
      if (message.id === undefined) continue;
      if (response.status === 401) {
        // Another process may just have renewed the key: read the file again and try once more.
        const reread = keyStore.load();
        if (reread?.token && reread.token !== key.token) {
          key = reread;
          const again = await fetch(key.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key.token}`, "user-agent": agent, ...(session ? { "mcp-session-id": session } : {}), ...proof(key.device, key.url, line) }, body: line });
          if (again.status !== 401) { const text = await again.text(); const parts = (again.headers.get("content-type") ?? "").includes("event-stream") ? text.split("\n").filter((part) => part.startsWith("data:")).map((part) => part.slice(5).trim()) : [text.trim()]; for (const part of parts.filter(Boolean)) process.stdout.write(`${part}\n`); continue; }
        }
        answer(message.id, "WorkTrust did not accept this computer's key: run `npx worktrust connect` again.");
        continue;
      }
      const text = await response.text();
      const parts = (response.headers.get("content-type") ?? "").includes("event-stream") ? text.split("\n").filter((part) => part.startsWith("data:")).map((part) => part.slice(5).trim()) : [text.trim()];
      for (const part of parts.filter(Boolean)) process.stdout.write(`${part}\n`);
    } catch { if (message.id !== undefined) answer(message.id, "WorkTrust is unreachable from this computer right now."); }
  }
}

/** THE HOOK Claude Code runs (`worktrust.mjs hook`): the key from the key file, handed to the session hook. */
async function hook() {
  if (has("antigravity-stop")) return antigravityStop();
  if (has("hermes") || has("goose")) return sessionEnd();
  const key = await freshKey();
  if (!key) return;
  const child = spawn(moduleExecutable(HERE), [...moduleArgs(HERE, "log-session.mjs", args.filter((arg) => arg !== "hook"))], { stdio: "inherit", env: { ...process.env, WORKTRUST_MCP_URL: key.url, WORKTRUST_MCP_TOKEN: key.token, WORKTRUST_CLI_VERSION: CLI_VERSION, WORKTRUST_MEASURE_RULES: String(MEASURE_RULES), WORKTRUST_HISTORY_SCOPE: historyQueueScope(key.token), ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) } }); // 0.10.20: the hook names the version that started it, beside each line
  process.exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve(code ?? 1)); });
}

/**
 * ANTIGRAVITY'S STOP HOOK (`worktrust.mjs hook --antigravity-stop`, 2026-10-04). Antigravity runs it
 * synchronously when its agent loop ends and reads its stdout as JSON whose `decision` is required: "continue"
 * would send the agent back to work, any other value lets it stop (antigravity.google/docs/hooks/). So this
 * prints `{"decision":"stop"}` FIRST, synchronously, changing nothing, and exits 0 at once: the sweep runs detached, as
 * `hook --antigravity`, with the payload (ids, paths and the model name; no text) in its environment.
 * Offline, or with no key, the sweep ends quietly; Antigravity never waits for it.
 */
const STOP_ANSWER = { decision: "stop" };
async function antigravityStop() {
  writeSync(1, `${JSON.stringify(STOP_ANSWER)}\n`);
  const input = await new Promise((resolve) => {
    let text = "";
    if (process.stdin.isTTY) { resolve(text); return; }
    const timer = setTimeout(() => resolve(text), 2000);
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(text); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(text); });
  });
  try { spawn(moduleExecutable(HERE), [...moduleArgs(HERE, "worktrust.mjs", ["hook", "--antigravity"])], { detached: true, stdio: "ignore", env: { ...process.env, WORKTRUST_HOOK_INPUT: input.slice(0, 65536) } }).unref(); } catch { /* the next run sweeps it */ }
  process.stdin.pause(); return;
}

/**
 * A SESSION-END HOOK THAT READS JSON AND ANSWERS JSON: Hermes Agent's (`hook --hermes`) and Goose's SessionEnd
 * (`hook --goose`, an Open Plugins hook: JSON on stdin, run with sh -c), 2026-10-05. Hermes pipes a JSON payload (ids, the
 * model, the platform; no message body) to a shell hook on every `on_session_end` and reads stdout as JSON
 * (hermes-agent.nousresearch.com/docs/user-guide/features/hooks). This answers `{}` (nothing to change), reads and drops
 * the payload, and runs the sweep detached: the session hook reads Hermes's own database (transcript-readers.mjs).
 */
async function sessionEnd() {
  writeSync(1, "{}\n");
  if (!process.stdin.isTTY) await new Promise((resolve) => { const timer = setTimeout(resolve, 2000); process.stdin.on("data", () => {}); process.stdin.on("end", () => { clearTimeout(timer); resolve(); }); process.stdin.on("error", () => { clearTimeout(timer); resolve(); }); });
  try { spawn(moduleExecutable(HERE), [...moduleArgs(HERE, "worktrust.mjs", ["hook"])], { detached: true, stdio: "ignore" }).unref(); } catch { /* the next run sweeps it */ }
  process.stdin.pause(); return;
}

/**
 * `npx worktrust@latest update` (owner, 2026-10-04): THIS COMPUTER ONTO THE NEWEST CLI, WITHOUT PAIRING IT
 * AGAIN. `connect` mints a new key and so a new device row to merge; an update keeps the key and the
 * row. It writes what `connect` writes after its pairing: the bridge copy in ~/.worktrust, every
 * WorkTrust entry in the AI apps taken out (a hand-made one with a key in it too) and the bridge put
 * in, and the session hook. A computer coupled by hand, without the key file, is sent to `connect`.
 */
async function update() {
  const key = await freshKey();
  if (!key) fail("this computer has no WorkTrust key file yet. Run npx worktrust connect.");
  say();
  say(`  WorkTrust · update ${hostname().replace(/\.local$/i, "")} to ${CLI_VERSION}`);
  say();
  const paths = await scripts();
  const plan = await run(paths["setup-mcp.mjs"], ["--bridge", STABLE], PLACEHOLDER, true);
  // AGREED BEFORE, REFRESHED WITHOUT A QUESTION (0.10.30): an app or hook the person said yes to is brought onto this
  // version's launcher; only what is NEW here is shown in full and asked about, and --yes leaves the new ones as they are.
  const agreed = await consent();
  say("  Every AI app found here gets the WorkTrust door, the local command that reads the key:");
  const found = planLines(plan.out, true).filter((line) => !line.includes("not on this machine"));
  const apps = [...new Set(found.map(labelOf).filter(Boolean))], fresh = apps.filter((app) => !agreed.has(`door:${app}`));
  for (const app of apps) if (!fresh.includes(app)) say(`    ✓ ${app}: refreshed (${agreed.said(`door:${app}`)})`);
  for (const line of found) if (fresh.includes(labelOf(line))) say(`${line} · new`);
  if (found.length === 0) say("    (no AI app found here)");
  const hookFresh = !agreed.has("session-hook");
  say(`  The session hook and ${STABLE} are brought to ${CLI_VERSION}.`);
  say(hookFresh ? `    + Session hook: ${join(homedir(), ".claude", "settings.json")} → SessionStart, SessionEnd, PreCompact and (at most once an hour) Stop run it · new` : `    ✓ Session hook: refreshed (${agreed.said("session-hook")}; since 0.10.32 it also runs after an answer, at most once an hour, so a long session's finished days arrive the same day)`);
  say("  The key stays as it is: no new pairing, the same computer in WorkTrust.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was written and nothing was sent."); return; }
  const newOnes = [...fresh, ...(hookFresh ? ["Session hook"] : [])];
  let takeNew = false;
  if (newOnes.length > 0 && has("yes")) say(`  skipped: new, run without --yes to decide: ${newOnes.join(", ")}`);
  else if (newOnes.length > 0) takeNew = await ask(`Couple the new ${newOnes.length === 1 ? "one" : "ones"} marked "new" (${newOnes.join(", ")})?`, false);
  if (newOnes.length > 0 && !takeNew && !has("yes")) say("  The new ones stay as they are. npx worktrust update asks again.");
  const skip = takeNew ? [] : fresh, hookOn = !hookFresh || takeNew;
  const previous = stableInstall();
  await prepareBundledRuntime();
  ensureHome();
  saveStableEntry();
  say(`  ✓ ${STABLE} is now ${CLI_VERSION}`);
  // Out first, then in: an app that held a key of its own (a hand-made entry) moves onto the bridge. An app not agreed to is not touched.
  const skipArgs = skip.length > 0 ? ["--skip", skip.join(",")] : [];
  await run(paths["setup-mcp.mjs"], ["--remove", "--write", ...skipArgs], key.token, true);
  if ((await run(paths["setup-mcp.mjs"], ["--write", "--bridge", STABLE, ...skipArgs], key.token)).code !== 0) fail("coupling the AI apps failed; the output above says where.");
  const hookArgs = ["--install", "--via", STABLE];
  if (hookOn && (await run(paths["log-session.mjs"], hookArgs, key.token, false)).code !== 0) fail("installing the session hook failed; the output above says where.");
  for (const name of [...apps.filter((app) => !skip.includes(app)).map((app) => `door:${app}`), ...(hookOn ? ["session-hook"] : [])]) agreed.agree(name, "typed");
  agreed.save();
  // Codex installed since, or a No said at connect: the one question, asked again (or "already set").
  await offerCodex();
  await offerAntigravity();
  const reported = await accepted(key.url, key.token, key.device);
  say(reported === true ? `  ✓ WorkTrust received CLI version ${CLI_VERSION}.` : "  ! Installed locally. WorkTrust could not confirm the version yet; it will be reported on the next connection.");
  await offerRebuild(previous, paths, key);
  say();
  say("  Done. Quit your AI apps completely and open them again to use the updated CLI.");
}

async function connect() {
  if (has("direct") && keyStore.protected()) fail("Protected credentials use the local bridge; --direct would expose them in app settings.");
  const host = (flag("name") ?? hostname()).replace(/\.local$/i, "").slice(0, 64);
  say();
  say(`  WorkTrust · connect ${host} (${OS_NAME})`);
  say();
  // ALREADY COUPLED: SAY TO WHOM, AND ASK (owner, 2026-10-04). Coupling again moves this computer to
  // whichever account approves it next and ends the current key; Enter, --yes and a closed terminal
  // mean No, `--replace` says yes in advance.
  const previous = keyStore.load();
  const before = previous ?? previousNote.load();
  if (previous) {
    say(previous.account ? `  This computer is coupled to the WorkTrust account ${previous.account}.` : "  This computer is already coupled (by an older version, which did not record the account).");
    say("  Coupling it again sends its work to the account you approve next, and its current key ends.");
    if (!has("replace") && !(await ask("Couple it again?", false))) { say("  Stopped. Nothing was changed: this computer stays coupled as it is."); return; }
    say();
  }
  const paths = await scripts();
  const direct = has("direct");
  const plan = await run(paths["setup-mcp.mjs"], direct ? [] : ["--bridge", STABLE], PLACEHOLDER, true);
  say(useDevice() ? "  1. You type a code at WorkTrust on another device, signed in. That decides the account." : "  1. You approve this computer in WorkTrust, in your browser, signed in. That decides the account.");
  say(`     WorkTrust receives this computer's system and name: ${OS_NAME}, "${host}".`);
  say(direct ? "  2. Every AI app found here gets the WorkTrust door, with the key in its settings:" : "  2. Every AI app found here gets the WorkTrust door, a local command that reads the key for it:");
  const foundApps = planLines(plan.out, true).filter((line) => !line.includes("not on this machine"));
  for (const line of foundApps) say(line);
  if (foundApps.length === 0) say("    (no AI app found here yet; run connect again after installing one)");
  if (!direct) say(`  3. The key is kept in ${KEY_PLACE}, works only on this computer (every call is signed) and is renewed every week.`);
  say(`  ${direct ? 3 : 4}. The session hook is installed:`);
  say("    + The hook and counter from the checked release, retained outside the package-manager cache");
  say(`    + ${join(homedir(), ".claude", "settings.json")} → SessionStart, SessionEnd, PreCompact and (at most once an hour) Stop run it`);
  say();
  say("  Sent to WorkTrust afterwards: durations, token counts, model names, a layer keyword, counts,");
  say("  and, to match the work to GitHub, the repository's owner/name and the commit hashes.");
  say("  Never sent: prompts, answers, code, file paths, commit messages.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was written and nothing was sent."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was written and nothing was sent."); return; }
  await prepareBundledRuntime();
  const agreed = await consent(); // read before anything is written, so what this run writes is not taken for an earlier yes

  // The device key: made here, its private half kept with the key, its public half bound at WorkTrust.
  const device = direct ? null : generateKeyPairSync("ed25519");
  // Claude Code is coupled through its own command, so its plan line reads "! … couple with": it is coupled all the same (0.10.4).
  const apps = foundApps.map((line) => /^\s*(?:[↻+✓] ([^:]+):|! ([^:]+): couple with)/.exec(line)).map((match) => match?.[1] ?? match?.[2]).filter(Boolean).slice(0, 12);
  const extra = { apps, ...computerIds(), ...(device ? { device_key: device.publicKey.export({ format: "jwk" }).x } : {}) };
  const pairing = useDevice() ? await pairByCode(host, extra) : await pairByBrowser(host, extra);
  const { token } = pairing;
  // ANOTHER ACCOUNT THAN BEFORE: told by the opaque account names. Unknown counts as another, the safe side.
  const switched = Boolean(before) && !(before.accountRef && pairing.accountRef && before.accountRef === pairing.accountRef);

  say();
  // Out first, then in: an app that already held a WorkTrust key moves to the new one.
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], token, true);
  if (!direct) {
    keyStore.save({ url: MCP, token, renewedAt: new Date().toISOString(), coupledAt: new Date().toISOString(), identified: true, profile: computerIds().profile_id, account: pairing.account, accountRef: pairing.accountRef, device: device.privateKey.export({ format: "pem", type: "pkcs8" }) });
    previousNote.erase();
    ensureHome();
    saveStableEntry();
    say(`  ✓ Key kept in ${KEY_PLACE}`);
  }
  if ((await run(paths["setup-mcp.mjs"], direct ? ["--write"] : ["--write", "--bridge", STABLE], token)).code !== 0) fail("coupling the AI apps failed; the output above says where.");
  say();
  // The old key ends now that the new one is in place (never before: a failed pairing must not leave the computer uncoupled).
  if (previous?.token) await releasePrevious(previous, pairing.prefix);
  // A NEW COUPLING SENDS NOTHING FROM BEFORE IT (log-session THE FLOORS): `--from-now` for a first coupling and a change
  // of account; the same account coupled again keeps its watermarks. A change of account also closes the history offer.
  const floors = !previous || switched ? ["--from-now", ...(switched ? ["--history-floor", "now"] : [])] : [];
  const hookArgs = ["--install", ...floors, "--via", STABLE, ...(direct ? ["--direct"] : [])];
  if ((await run(paths["log-session.mjs"], hookArgs, token, false, { WORKTRUST_CODEX_OFFER: "1" })).code !== 0) fail("installing the session hook failed; the output above says where.");
  // WHAT WAS AGREED HERE (0.10.30): the apps and the hook this "Continue?" covered; another account starts with none from before.
  if (switched) agreed.reset();
  for (const name of [...new Set(foundApps.map(labelOf).filter(Boolean))].map((app) => `door:${app}`).concat("session-hook")) agreed.agree(name, has("yes") ? "flag" : "typed");
  await offerCodex();
  await offerAntigravity();
  if (switched) { say(); say("  Earlier work on this computer is not offered: it was coupled to another account before. Only work from now on goes to this account."); }
  else await offerHistory(paths, token, device ? device.privateKey.export({ format: "pem", type: "pkcs8" }) : null, MCP, true);
  say();
  // ONE LINE, NO CHANGE (2026-10-06): Claude Code deletes what the hook measures from; `preserve --apply` keeps it, on a yes.
  const keeps = claudeKeepsDays();
  if (keeps !== null && keeps < 90) say(`  Claude Code deletes sessions after ${keeps} days. Keep them: npx worktrust@latest preserve --apply`);
  say("  Done. Quit your AI apps completely and open them again. This computer appears in WorkTrust");
  say("  under Sources → CLI once one of them has spoken.");
}

/**
 * EARLIER WORK IS SENT ONLY ON A YES (owner, 2026-10-03). After coupling, or as `npx worktrust@latest history`:
 * what this computer holds is counted here and shown, and nothing leaves before the person types y.
 * Enter, --yes and a closed terminal all mean No; `--history` says yes in advance. What goes is hours
 * and tokens per day, filed as history (never verified hours, never text).
 */
async function offerHistory(paths, token, devicePem, url = MCP, rebuild = false, agreedInAdvance = false) {
  const env = { WORKTRUST_MCP_URL: url, ...(devicePem ? { WORKTRUST_DEVICE_KEY: devicePem } : {}) };
  const counted = await run(paths["log-session.mjs"], ["--history", "--dry-run", "--summary"], token, true, env);
  let found = null;
  try { found = JSON.parse(counted.out.trim().split("\n").pop()); } catch { /* no line: nothing to offer */ }
  say();
  if (!found?.sessions) { historyDone(true); say(rebuild ? "  Your AI apps hold no earlier sessions on this computer to re-measure." : "  Your AI apps hold no earlier sessions on this computer to send."); return; }
  say(`  This computer holds ${found.sessions} earlier sessions of your AI apps · ${found.days} days · ${found.first} … ${found.last}. WorkTrust measures the hours when they arrive.`);
  // REBUILD (owner, 2026-10-07): the plan per AI app, in days and hours, and what it replaces, before the one question. Enter is No.
  if (rebuild) {
    for (const row of found.clients ?? []) say(`    ${row.client.padEnd(12)} ${String(row.days).padStart(4)} days   ${row.first} … ${row.last}`);
    say("  Re-measured with the current rules (what the seconds were, your own turns, tokens with the cache, every AI app above).");
    say("  Changed measured history is held for review; earlier measurements remain in your record.");
    say("  For older unmeasured history only:");
    say("  WorkTrust REPLACES this computer's earlier lines for those days and apps: each earlier line is withdrawn and kept,");
    say("  never deleted, so a day is counted once. Other computers, web sources and days not listed are not touched.");
  }
  if (has("dry-run")) { say("  Dry run: nothing was sent."); return; }
  if (!has("history") && !agreedInAdvance && !(rebuild ? await ask("Send them (re-measured; this computer's earlier lines for these days are replaced, a day is counted once)?", false) : await ask("Send these as history (hours and tokens per day; never text)?", false))) { historyDone(false); say("  Not sent. Send them later with: npx worktrust"); return; }
  // Marked unfinished before the first batch leaves (0.10.9): a send stopped halfway (Ctrl+C, a closed lid) is finished by the next run.
  historyDone(false);
  const sent = await run(paths["log-session.mjs"], ["--history", ...(rebuild ? ["--rebuild"] : []), ...(has("retry-review") ? ["--retry-review"] : [])], token, true, env);
  historyDone(sent.code === 0);
  // WHAT ACTUALLY HAPPENED, FROM THE DOOR'S RECEIPTS (owner, 2026-10-10): a re-measure in which nothing changed must not say
  // "replaced". The hook sums the receipts of every batch and prints one line; without it (an older hook) the sentence stays neutral.
  const did = (() => { try { return JSON.parse(sent.out.trim().split("\n").reverse().find((line) => line.startsWith('{"history_sent"')) ?? "null"); } catch { return null; } })();
  const n = (value) => Number(value) || 0;
  // AN HONEST RECEIPT (owner, 2026-10-22; 0.10.28): a re-measure that landed as new lines over lines WorkTrust had withdrawn or
  // cut off is said as new lines, never as "Nothing changed"; `restored` counts the ones WorkTrust landed over a support-withdrawn
  // original with its own clock (the withdrawn line stays withdrawn). `untimed` names entries refused for carrying no timeline.
  const landed = n(did.new) + n(did.restored);
  const outcome = !did ? "The record shows what changed."
    : n(did.replaced) > 0 ? `${n(did.replaced)} of this computer's earlier lines were replaced (withdrawn and kept, never deleted)${landed > 0 ? `, ${landed} new` : ""}${n(did.filled) > 0 ? `, ${n(did.filled)} lines gained what was missing` : ""}.`
    : landed === 0 ? `Nothing changed: the same measurement${n(did.filled) > 0 ? `; ${n(did.filled)} lines gained what was missing (the stack, the tools seen, a layer)` : ""}; ${n(did.alreadyHeld)} lines already held.`
    : `${landed} new lines${n(did.restored) > 0 ? ` (${n(did.restored)} timed by WorkTrust in place of lines it had withdrawn)` : ""}${n(did.filled) > 0 ? `, ${n(did.filled)} lines gained what was missing` : ""}; ${n(did.alreadyHeld)} already held.`;
  // ONLY THE DAYS THAT CHANGED (0.10.32): the hook asked WorkTrust which of this computer's days it holds as this CLI measures
  // them and sent the others; every day it compared unchanged is nothing sent, said once. Not asked (an older WorkTrust) says nothing.
  const compared = Number.isInteger(did?.days?.compared) ? did.days.compared : null, changed = Number.isInteger(did?.days?.changed) ? did.days.changed : null;
  if (rebuild && sent.code === 0 && compared !== null && compared > 0 && changed === 0 && n(did.of) === 0) { say(`  Nothing changed: WorkTrust holds all ${compared} days as this computer measures them. Nothing was sent.`); return; }
  if (rebuild && compared !== null && changed !== null && compared > changed) say(`  ${compared - changed} of ${compared} days unchanged on WorkTrust; sending the ${changed} that changed.`);
  if (n(did?.unreadable) > 0) say(`  ${n(did.unreadable)} transcript${n(did.unreadable) === 1 ? "" : "s"} could not be read; ${n(did.unreadable) === 1 ? "its" : "their"} days were not measured. WorkTrust was told the count, nothing else.`);
  if (n(did?.untimed) > 0) say(`  ${n(did.untimed)} lines were refused: they carried no timeline, so WorkTrust could not time them itself. This CLI sends every session's timeline; a line without one came from an older copy or an archive.`);
  if (Number(did?.delivery?.review) > 0) say(`  ${did.delivery.review} lines are waiting for review. Earlier measurements remain unchanged. Reconnecting or repeating the import does not approve them.`);
  // KEPT ON THE SERVER (0.10.27; owner, 2026-10-21): what did not arrive stays here and goes again by itself; nothing to resume by hand.
  if (Number(did?.delivery?.waiting) > 0) say("  Some batches did not reach WorkTrust yet. They stay on this computer and are sent again by themselves the next time npx worktrust or your AI app's hook runs.");
  if (Number(did?.delivery?.refused) > 0) say(`  WorkTrust closed an earlier run of ${did.delivery.refused} lines (it missed a batch for seven days): run npx worktrust@latest history again to send them as a new run.`);
  // A STAGED RUN (0.10.27): WorkTrust holds every batch and rebuilds the days itself once the run is whole; the receipts say what it kept.
  if (rebuild && n(did?.staged) > 0 && !Number(did?.delivery?.review) && !Number(did?.delivery?.waiting)) {
    say(`  ✓ Re-measured. WorkTrust holds all ${n(did.staged)} batches (${n(did.kept)} lines) and rebuilds these days itself, every AI app together, a day counted once. Sources › Logs shows it while it works.`);
    // WHERE IT WAITS (0.10.32): the receipt of the run's last batch names its place in WorkTrust's queue and a time; absent, nothing is guessed.
    const queued = did?.queued;
    if (queued && Number.isInteger(queued.position) && queued.position >= 1 && Number.isFinite(Number(queued.eta_minutes))) say(`  queued, position ${queued.position}, about ${Math.max(1, Math.ceil(Number(queued.eta_minutes)))} min`);
  }
  else if (rebuild && !Number(did?.delivery?.review) && !Number(did?.delivery?.waiting)) say(sent.code === 0 ? `  ✓ Re-measured. ${outcome}` : "  Not all of it arrived. Run npx worktrust again: it finishes what did not arrive, a day already rebuilt is counted once.");
  else if (!rebuild) say(sent.code === 0 ? "  ✓ Sent as history. Activity is recorded with its origin; independent verification and passport publication are separate. A day WorkTrust already holds is kept once." : "  Not all of it arrived. Run npx worktrust history again: a line already received is kept once.");
  if (did && Number(did.measuredSeconds) > 0) say(`  Measured by WorkTrust: ${(Number(did.measuredSeconds) / 3600).toFixed(1)} h for what this send stored${n(did.corrected) > 0 ? ` (${n(did.corrected)} lines corrected: a figure sent beside the timeline differed)` : ""}.`);
}

/** The version stamped in the stable copy in ~/.worktrust, the CLI this computer ran before an update; null without one. */
const stableVersion = () => { try { const installed = JSON.parse(readFileSync(join(HOME_DIR, "installed-release.json"), "utf8")); if (/^\d+\.\d+\.\d+$/.test(installed.version)) return installed.version; } catch { /* older registration */ } try { return /const CLI_VERSION = "([^"]+)";/.exec(readFileSync(STABLE_FILE, "utf8"))?.[1] ?? null; } catch { return null; } };

/**
 * THE RULES AN EARLIER CLI MEASURED BY (0.10.31). Recorded since 0.10.31 (installed-release.json, history.json, or the
 * stable copy's own MEASURE_RULES); before that, read from its version: 0.10.29 and 0.10.30 measured by rules 1, anything
 * older by earlier rules (0). Null when the version is unknown too.
 */
const rulesOf = (record) => (Number.isInteger(record?.measureRules) && record.measureRules >= 0 ? record.measureRules
  : typeof record?.version === "string" && /^\d+\.\d+\.\d+$/.test(record.version) ? (record.version.split(".").map(Number).reduce((order, part, at) => order || Math.sign(part - [0, 10, 29][at]), 0) < 0 ? 0 : 1) : null);
/** The stable copy's version and measure rules, what this computer ran before an update; both null without one. */
function stableInstall() {
  const version = stableVersion();
  if (!version) return { version: null, rules: null };
  try { const installed = JSON.parse(readFileSync(join(HOME_DIR, "installed-release.json"), "utf8")); if (installed.version === version && rulesOf(installed) !== null) return { version, rules: rulesOf(installed) }; } catch { /* older registration */ }
  try { const own = /const MEASURE_RULES = (\d+);/.exec(readFileSync(STABLE_FILE, "utf8"))?.[1]; if (own) return { version, rules: Number(own) }; } catch { /* no stable copy */ }
  return { version, rules: rulesOf({ version }) };
}
/** What changed between two measure-rules versions, in MEASURE_CHANGES' words, oldest first. */
const measureChanges = (from, to) => Object.keys(MEASURE_CHANGES).map(Number).filter((rules) => rules > Math.min(from, to) && rules <= Math.max(from, to)).sort((x, y) => x - y).flatMap((rules) => MEASURE_CHANGES[rules]);

/**
 * OFFERED ONCE, BY `update`, IN PLAIN WORDS (owner, 2026-10-07): when the computer's earlier lines were measured by OTHER
 * RULES than this CLI's (0.10.31: the measure-rules version, not the CLI version; 0.10.30 offered on every version and
 * invited a re-send of history measured exactly as before). The CLI cannot read the record, so it is an offer, not a
 * finding: the plan is shown and the question asked by the same path as `history --rebuild`; Enter is No. The offer
 * names what changed. The same rules updated again offer nothing.
 */
async function offerRebuild(previous, paths, key) {
  if (!previous?.version || previous.rules === null || previous.rules === MEASURE_RULES) return;
  const changes = measureChanges(previous.rules, MEASURE_RULES);
  say();
  say(`  This computer's earlier lines in WorkTrust were measured by worktrust ${previous.version}. Version ${CLI_VERSION} measures`);
  say(changes.length > 0 ? "  differently:" : "  differently.");
  for (const change of changes) say(`    · ${change}`);
  say("  You can re-measure the sessions still on this computer and have WorkTrust replace this computer's earlier lines,");
  say("  day by day, never counting a day twice. Later: npx worktrust");
  // ONE QUESTION, AFTER THE PLAN (0.10.30): counting the plan reads this computer only and sends nothing, so it is shown
  // first and the send is asked once, Enter is No; `--rebuild` agrees in advance, --yes alone never does.
  await offerHistory(paths, key.token, key.device ?? null, key.url, true, has("rebuild"));
}

/**
 * WHETHER THE HISTORY ARRIVED (0.10.5, owner: "someone with little experience never knows to rebuild"). Written after each
 * send: complete when every batch arrived or there was nothing to send. Only the outcome and the version, never a session.
 */
const HISTORY_STATE = join(HOME_DIR, "history.json");
function historyDone(complete) {
  try { ensureHome(); writeFileSync(HISTORY_STATE, JSON.stringify({ version: CLI_VERSION, measureRules: MEASURE_RULES, at: new Date().toISOString(), complete }), { mode: 0o600 }); } catch { /* the next run asks again */ }
}
/** Complete AND measured by this CLI's rules (0.10.9; the rules, not the version, since 0.10.31): a run stopped after the
 *  update, before the history, leaves the history measured by older rules, and the next run must offer it again rather
 *  than read "complete" as done. A version that measures as the one before finds its history done. */
const historyComplete = () => { try { const state = JSON.parse(readFileSync(HISTORY_STATE, "utf8")); return state.complete === true && rulesOf(state) === MEASURE_RULES; } catch { return false; } };

/**
 * THE SAME COMMAND AGAIN DOES WHAT IS LEFT (0.10.5). On a computer already coupled, `npx worktrust@latest` brings it onto
 * this CLI when an earlier one is installed (the update, which also offers the re-measure), else finishes the history
 * when it never arrived whole (a failed send, a question answered No, a computer coupled before this marker existed);
 * then says what is coupled. Each step still shows its plan and asks; Enter is No.
 */
async function again() {
  const before = stableVersion();
  if (before && before !== CLI_VERSION) { await update(); return; }
  { const key = await freshKey(); if (key) await resendHistory(key); }
  if (!historyComplete()) {
    const key = await freshKey();
    if (key) { say(); say(`  Your earlier sessions are not yet measured by worktrust ${CLI_VERSION} in WorkTrust, or did not all arrive. This finishes them.`); await offerHistory(await scripts(), key.token, key.device ?? null, key.url, true); }
  }
  // A WEB CHAT'S EXPORT LYING IN DOWNLOADS (0.10.10): offered once, Enter is No.
  { const key = await freshKey(); if (key) await offerDownloads(await scripts(), key); }
  say();
  await status();
  say();
  say("  This computer is coupled. `npx worktrust connect` couples it again; `npx worktrust disconnect` takes it out.");
}

/**
 * PENDING HISTORY GOES BY ITSELF (0.10.27; owner, 2026-10-21): batches an earlier history run planned and the server never
 * received (no network, a closed lid, the upload limit) are sent again here, without a question: the person said yes when the
 * run was planned. Held-for-review batches stay held. Quiet when nothing was pending.
 */
async function resendHistory(key) {
  const paths = await scripts(), sent = await run(paths["log-session.mjs"], ["--history", "--resume"], key.token, true, { WORKTRUST_MCP_URL: key.url, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) });
  let did = null;
  try { did = JSON.parse(sent.out.trim().split("\n").reverse().find((line) => line.startsWith('{"resumed"')) ?? "null"); } catch { /* nothing pending, or an older hook */ }
  if (Number(did?.resumed) > 0) { say(); say(`  ✓ ${did.resumed} lines of earlier history that had not reached WorkTrust were sent; WorkTrust keeps them and rebuilds the days itself.`); }
  if (Number(did?.waiting) > 0) say("  Some earlier history is still on this computer; it is sent again by itself the next time npx worktrust or your AI app's hook runs.");
}

async function history() {
  const key = await freshKey();
  if (!key) fail("this computer is not coupled through the key file. Run npx worktrust first.");
  if (has("resume")) {
    if (!has("dry-run") && !has("history") && !(await ask("Resume previously approved metadata uploads? Lines held for review stay held.", false))) return;
    const paths = await scripts(), sent = await run(paths["log-session.mjs"], ["--history", "--resume", ...(has("dry-run") ? ["--dry-run"] : []), ...(has("retry-review") ? ["--retry-review"] : [])], key.token, true, { WORKTRUST_MCP_URL: key.url, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) });
    say(sent.out.trim()); process.exitCode = sent.code; return;
  }
  if (has("from-archive")) return offerArchive(await scripts(), key);
  if (has("export")) { if (!flag("export") || flag("export").startsWith("--")) fail("--export needs the export's path: the zip, its folder, conversations.json, a conversations-000.zip part, or the manifest"); await offerExport(await scripts(), key, flag("export")); return; }
  if (has("from-folder")) { if (!flag("from-folder") || flag("from-folder").startsWith("--")) fail("--from-folder needs the copied folder's path"); await offerFolder(await scripts(), key, flag("from-folder")); return; }
  // ONE PATH (0.10.5): sending is re-measuring. On a computer WorkTrust has never heard from nothing is replaced, so it is a
  // plain send; after a failure, a merge or an older CLI, the same command replaces day by day. `--rebuild` still reads.
  await offerHistory(await scripts(), key.token, key.device ?? null, key.url, true);
}

/**
 * THE ARCHIVE AS HISTORY (0.8.0): the plan first (how many signed stretches, how many of them gone from the AI apps
 * here), then one question, Enter is No; the hook refuses by name whatever does not hold (no device key, an archive
 * that does not verify, a door that does not know the mark).
 */
async function offerArchive(paths, key) {
  const at = process.argv.indexOf("--from-archive"), named = process.argv[at + 1], dir = named && !named.startsWith("--") ? [named] : [];
  const env = { WORKTRUST_MCP_URL: key.url, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) };
  const plan = await run(paths["log-session.mjs"], ["--history", "--from-archive", ...dir, "--dry-run"], key.token, true, env);
  say();
  for (const line of plan.out.trim().split("\n").filter((text) => !text.startsWith(" ") && !text.startsWith("{") && !text.startsWith("}") && text.trim())) say(`  ${line}`);
  if (plan.code !== 0 || /Nothing to send/.test(plan.out) || has("dry-run")) return;
  if (!(await ask("Send them as history, marked as from your archive?", false))) { say("  Not sent."); return; }
  const sent = await run(paths["log-session.mjs"], ["--history", "--from-archive", ...dir], key.token, true, env);
  say(sent.code === 0 ? "  ✓ Sent as history from your archive. It shows in WorkTrust as earlier work, marked as such, never as verified hours." : `  Not sent: ${sent.out.trim().split("\n").pop()}`);
}

/**
 * A WEB CHAT'S DATA EXPORT AS HISTORY (0.10.10, owner 2026-10-10). ChatGPT's and Claude's exports (the zip, its folder, or
 * conversations.json) go through the history door as RECONSTRUCTED hours: shown with their origin, never verified
 * hours, because the file can be edited before it is read and no device key witnessed it. Nothing of a conversation
 * leaves: not its title, not a message; the hook reads the clocks, the person's own turns and the model's name. The
 * plan first (the product, conversations, days, hours, first and last month), then one question; Enter is No;
 * `--dry-run` stops before it; `--history` says yes in advance. Answers whether the export arrived whole.
 */
const EXPORT_PRODUCT = { chatgpt: "ChatGPT", "claude-web": "Claude on the web" };
/** The connector of the export's vendor (0.10.19): the only lines an export may withdraw are the ones this connector reported. */
const EXPORT_CONNECTOR = { chatgpt: "ChatGPT", "claude-web": "Claude" };
async function offerExport(paths, key, path) {
  const env = { WORKTRUST_MCP_URL: key.url, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) };
  const counted = await run(paths["log-session.mjs"], ["--history", "--export", path, "--dry-run", "--summary"], key.token, true, env);
  let found = null;
  try { found = JSON.parse(counted.out.trim().split("\n").pop()); } catch { /* no line: the export could not be read */ }
  const report = found?.exports?.[0];
  say();
  if (counted.code !== 0 || !report) { say(`  ${counted.out.trim().split("\n").filter(Boolean).pop() ?? "export: it could not be read"}. Nothing was sent.`); return false; }
  const product = EXPORT_PRODUCT[report.vendor] ?? report.vendor, connector = EXPORT_CONNECTOR[report.vendor] ?? report.vendor;
  if (!report.days) { say(`  ${product} export · ${report.conversations} conversations, none with a clock to place: nothing to send.`); return true; }
  say(`  ${product} export · ${report.conversations} conversations · ${report.days} days · ${String(report.first).slice(0, 7)} … ${String(report.last).slice(0, 7)}`);
  say("  WorkTrust reconstructs the hours from the export's own clocks when they arrive: shown with their origin, never verified hours. Never a title or a message.");
  // LEFT OUT AND COUNTED (0.10.18): a conversation whose kept fields outgrew the reader's budget is passed over, never the export.
  if (report.oversized > 0) say(`  ${report.oversized} conversation${report.oversized === 1 ? "" : "s"} too large to read ${report.oversized === 1 ? "is" : "are"} left out; the rest is read.`);
  if (has("dry-run")) { say("  Dry run: nothing was sent."); return false; }
  if (!has("history") && !(await ask("Send it as history (reconstructed hours per day; never text)?", false))) { say(`  Not sent. Send it later with: npx worktrust history --export ${path}`); return false; }
  const sent = await run(paths["log-session.mjs"], ["--history", "--export", path], key.token, true, env);
  say(sent.code === 0 ? `  ✓ Sent as history. It shows in WorkTrust as ${product}, reconstructed, never as verified hours; a line already received is kept once.` : `  Not all of it arrived. Run npx worktrust history --export ${path} again: a line already received is kept once.`);
  if (sent.code !== 0) return false;
  // THE EXPORT REPLACES (owner, 2026-10-10): the door withdrew the product's earlier connector lines on the export's days by itself and
  // says so; the lines an AI app reported under no product on those days may describe the same conversations, and go only on a yes.
  const counts = lastCounts(sent.out);
  // WHAT AN EXPORT MAY WITHDRAW (0.10.19, after the incident of 2026-10-18): lines your connector of the same vendor reported, and nothing a computer of yours wrote;
  // the door holds the rule, the counts here are the door's own, and the question names exactly what the second send will touch.
  if (counts.superseded > 0) say(`  ${counts.superseded} earlier line${counts.superseded === 1 ? "" : "s"} of ${product} your ${connector} connector reported for those days ${counts.superseded === 1 ? "is" : "are"} withdrawn and kept (each with a correction row): the export's lines count, a day counts once.`);
  // ONE STRETCH PER RUN (0.10.17): a conversation-day sent before as one envelope is now its runs; the door withdrew the envelope.
  if (counts.recut > 0) say(`  ${counts.recut} earlier line${counts.recut === 1 ? "" : "s"} of this export, one per conversation and day, ${counts.recut === 1 ? "is" : "are"} replaced by one line per run of activity (withdrawn and kept, the same total).`);
  if (counts.unknownOnDays > 0) {
    const n = counts.unknownOnDays;
    say(`  ${n} earlier line${n === 1 ? "" : "s"} your ${connector} connector reported for these days under no product may describe the same conversations. Your own computers' lines are never touched.`);
    if (has("withdraw-unknown") || (await ask(`Also withdraw ${n} earlier line${n === 1 ? "" : "s"} your ${connector} connector reported for these days?`, false))) {
      const again = await run(paths["log-session.mjs"], ["--history", "--export", path, "--withdraw-unknown"], key.token, true, env);
      const done = lastCounts(again.out);
      say(again.code === 0 ? `  ✓ Withdrawn and kept: ${done.unknownWithdrawn} earlier line${done.unknownWithdrawn === 1 ? "" : "s"}, each with a correction row; never deleted.` : `  Not withdrawn: ${again.out.trim().split("\n").pop()}`);
    } else say(`  Kept. Later: npx worktrust history --export ${path} --withdraw-unknown`);
  }
  return true;
}
/** The hook's last line of counts after an export send (superseded, unknownOnDays, unknownWithdrawn); zeros when there is none. */
function lastCounts(out) {
  try { const line = out.trim().split("\n").filter((text) => text.startsWith("{")).pop(); const json = JSON.parse(line ?? "{}"); return { superseded: Number(json.superseded) || 0, unknownOnDays: Number(json.unknownOnDays) || 0, unknownWithdrawn: Number(json.unknownWithdrawn) || 0 }; } catch { return { superseded: 0, unknownOnDays: 0, unknownWithdrawn: 0 }; }
}

/**
 * THE EXPORT LYING IN DOWNLOADS (0.10.10): on a coupled computer the bare command looks in ~/Downloads, its top level
 * only, for a ChatGPT or Claude export it has neither sent nor asked about, and offers each once by the same path as
 * `history --export`; a No is remembered by the file's digest (never a conversation), and the command to send it later is
 * said. A dry run remembers nothing.
 */
async function offerDownloads(paths, key) {
  const found = await run(paths["log-session.mjs"], ["--find-exports"], "", true, { WORKTRUST_MCP_URL: "" });
  let exports = [];
  try { exports = JSON.parse(found.out.trim().split("\n").pop()); } catch { return; }
  for (const one of Array.isArray(exports) ? exports : []) {
    if (one.sent || one.offered) continue;
    say();
    say(`  A ${EXPORT_PRODUCT[one.vendor] ?? one.vendor} export lies in your Downloads folder: ${one.path}`);
    const sent = await offerExport(paths, key, one.path);
    if (!sent && !has("dry-run")) await run(paths["log-session.mjs"], ["--export-offered", one.digest], "", true, { WORKTRUST_MCP_URL: "" });
  }
}

/**
 * A COPIED SESSION FOLDER AS HISTORY (owner, 2026-10-10, one rule): a person's own backup of ~/.claude/projects, ~/.codex/sessions
 * or an Antigravity brain folder, read by the hook with the same readers and clock as the live folders (never those), its days
 * RECONSTRUCTED and titled as from a copied folder; a stretch the live folders already hold is skipped (they win). The plan
 * first, then one question; Enter is No; `--dry-run` stops before it; `--history` says yes in advance.
 */
async function offerFolder(paths, key, dir) {
  const env = { WORKTRUST_MCP_URL: key.url, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) };
  const counted = await run(paths["log-session.mjs"], ["--history", "--from-folder", dir, "--dry-run", "--summary"], key.token, true, env);
  let found = null;
  try { found = JSON.parse(counted.out.trim().split("\n").pop()); } catch { /* no line: the folder could not be read */ }
  const report = found?.folder;
  say();
  if (counted.code !== 0 || !report) { say(`  ${counted.out.trim().split("\n").filter(Boolean).pop() ?? "folder: it could not be read"}. Nothing was sent.`); return; }
  say(`  Copied session folder · ${report.stretches} stretch${report.stretches === 1 ? "" : "es"} (${report.skipped} already among this computer's own sessions, skipped) · ${report.days} day${report.days === 1 ? "" : "s"} · measured by WorkTrust on arrival${report.first ? ` · ${report.first} … ${report.last}` : ""}`);
  if (!report.days) { say("  Nothing to send: every day of the copy is already among this computer's own sessions."); return; }
  say("  Hours reconstructed from the copy's own clocks: shown with their origin, never verified hours. Never text.");
  if (has("dry-run")) { say("  Dry run: nothing was sent."); return; }
  if (!has("history") && !(await ask("Send it as history (reconstructed hours per day; never text)?", false))) { say(`  Not sent. Send it later with: npx worktrust history --from-folder ${dir}`); return; }
  const sent = await run(paths["log-session.mjs"], ["--history", "--from-folder", dir], key.token, true, env);
  say(sent.code === 0 ? "  ✓ Sent as history. It shows in WorkTrust as reconstructed, from a copied session folder, never as verified hours; a line already received is kept once." : `  Not all of it arrived. Run npx worktrust history --from-folder ${dir} again: a line already received is kept once.`);
}

/**
 * CODEX WAKES THE HOOK ON A YES (owner, 2026-10-04). Codex has no hook settings: it runs ONE `notify`
 * program at the end of every turn, named on a top-level line of ~/.codex/config.toml. Without it
 * Codex sessions are still swept whenever the Claude Code hook runs; with it they arrive when Codex
 * works alone. Asked by `connect` and by `update`; Enter, --yes and a closed terminal mean No; `--codex` says yes in advance. Only a
 * WorkTrust line is ever replaced or removed: another program's notify belongs to the person, and
 * Codex takes one. The file is kept beside itself before it is changed.
 */
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const isOurNotify = (text) => /--codex-notify/.test(text) && /worktrust|log-session\.mjs/i.test(text);

/** The top-level `notify = [...]` of a Codex config (it may span lines), or where one would go: before the first table. */
function codexNotify() {
  let toml = "";
  try { toml = readFileSync(CODEX_CONFIG, "utf8"); } catch { /* none yet */ }
  const rows = toml === "" ? [] : toml.split("\n");
  for (let at = 0; at < rows.length; at += 1) {
    if (/^\s*\[/.test(rows[at])) return { rows, at: -1, end: -1, insert: at };
    if (/^\s*notify\s*=/.test(rows[at])) {
      let end = at;
      while (!rows[end].includes("]") && end < rows.length - 1) end += 1;
      return { rows, at, end, text: rows.slice(at, end + 1).join("\n") };
    }
  }
  return { rows, at: -1, end: -1, insert: rows.at(-1) === "" ? rows.length - 1 : rows.length };
}

function writeCodex(rows) {
  if (existsSync(CODEX_CONFIG)) copyFileSync(CODEX_CONFIG, `${CODEX_CONFIG}.worktrust-backup`);
  writeFileSync(CODEX_CONFIG, rows.join("\n"));
}

async function offerCodex() {
  if (!existsSync(join(homedir(), ".codex"))) { if (command === "codex") say("  Codex is not on this computer (no ~/.codex)."); return; }
  const viaBridge = existsSync(STABLE);
  const hookFile = STABLE;
  if (!existsSync(hookFile)) { say("  Couple this computer first: npx worktrust"); return; }
  const desired = () => `notify = [${(viaBridge ? [NODE, ...NODE_ARGS, STABLE, "hook", "--codex-notify"] : [NODE, ...NODE_ARGS, hookFile, "--codex-notify"]).map((part) => JSON.stringify(part)).join(", ")}]`;
  let want = desired();
  const found = codexNotify();
  say();
  if (found.text === want) { say("  ✓ Codex already wakes the session hook at the end of every turn."); return; }
  if (found.text && !isOurNotify(found.text)) {
    say("  Codex already runs another program at the end of each turn (notify in ~/.codex/config.toml).");
    say("  Codex takes one, so it stays as it is; Codex sessions are still sent whenever the Claude Code hook runs.");
    return;
  }
  // AGREED BEFORE (0.10.30): WorkTrust's own line, already said yes to, whose launcher path moved: refreshed without a question.
  const agreed = await consent(), known = Boolean(found.text) && agreed.has("codex-notify");
  if (known) say(`  ✓ Codex wakes the session hook: refreshed (${agreed.said("codex-notify")}).`);
  else {
    say("  Codex can wake the session hook at the end of every turn, so Codex work arrives without Claude Code running:");
    say(`    ${found.text ? "↻" : "+"} ${CODEX_CONFIG} → ${want}`);
  }
  if (has("dry-run")) { say("  Dry run: nothing was written."); return; }
  if (!known && !has("codex") && has("yes")) { say("  Not set (skipped: new, run without --yes to decide)."); return; }
  if (!known && !has("codex") && !(await ask("Let Codex wake the session hook?", false))) { agreed.drop("codex-notify"); say("  Not set. npx worktrust update asks again."); return; }
  await prepareBundledRuntime(); want = desired();
  const rows = [...found.rows];
  if (found.text) rows.splice(found.at, found.end - found.at + 1, want);
  else rows.splice(found.insert, 0, ...(found.insert < rows.length && rows[found.insert] !== "" ? [want, ""] : [want]));
  if (rows.at(-1) !== "") rows.push("");
  writeCodex(rows);
  agreed.agree("codex-notify", has("codex") ? "flag" : "typed");
  say(known ? "    Restart Codex to pick it up; the earlier file is kept as config.toml.worktrust-backup." : "  ✓ Codex wakes the session hook. Restart Codex to pick it up; the earlier file is kept as config.toml.worktrust-backup.");
}

/**
 * ANTIGRAVITY WAKES THE HOOK ON A YES (owner, 2026-10-04), the way Codex does. Antigravity (the 2.0 app,
 * the `agy` CLI, the IDE) reads named hooks from ~/.gemini/config/hooks.json, each with its events
 * (antigravity.google/docs/hooks/). This adds one hook named `worktrust` with a single Stop command, merged
 * into whatever else the file holds, the file kept beside itself first. Enter, --yes and a closed
 * terminal mean No; `--antigravity` says yes in advance. Without it, Antigravity conversations are still
 * swept whenever another client's hook runs.
 */
const AGY_HOOKS = join(homedir(), ".gemini", "config", "hooks.json");
const antigravityHere = () => ["config", ...readdirSafe(join(homedir(), ".gemini")).filter((name) => /^antigravity/.test(name))].some((name) => existsSync(join(homedir(), ".gemini", name)));
function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }
/** The hooks file as an object; null when it exists and is not JSON, which is never overwritten. */
function agyHooks() {
  if (!existsSync(AGY_HOOKS)) return {};
  try { const parsed = JSON.parse(readFileSync(AGY_HOOKS, "utf8") || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function writeAgyHooks(hooks) {
  mkdirSync(dirname(AGY_HOOKS), { recursive: true });
  if (existsSync(AGY_HOOKS)) copyFileSync(AGY_HOOKS, `${AGY_HOOKS}.worktrust-backup`);
  writeFileSync(AGY_HOOKS, `${JSON.stringify(hooks, null, 2)}\n`);
}
async function offerAntigravity() {
  if (!antigravityHere()) { if (command === "antigravity") say("  Antigravity is not on this computer (no ~/.gemini/config or ~/.gemini/antigravity*)."); return; }
  if (!existsSync(STABLE)) { say("  Couple this computer first: npx worktrust"); return; }
  const desired = () => ({ enabled: true, Stop: [{ type: "command", command: `"${NODE}" ${NODE_ARGS.map(arg => JSON.stringify(arg)).join(" ")}${NODE_ARGS.length ? " " : ""}"${STABLE}" hook --antigravity-stop`, timeout: 10 }] });
  let want = desired();
  const hooks = agyHooks();
  say();
  if (hooks === null) { say(`  ${AGY_HOOKS} is not readable JSON, so it is left as it is; Antigravity sessions are still sent whenever another hook runs.`); return; }
  if (JSON.stringify(hooks.worktrust) === JSON.stringify(want)) { say("  ✓ Antigravity already wakes the session hook when its agent stops."); return; }
  // AGREED BEFORE (0.10.30): WorkTrust's own hook, already said yes to, whose launcher path moved: refreshed without a question.
  const agreed = await consent(), known = Boolean(hooks.worktrust) && agreed.has("antigravity-stop");
  if (known) say(`  ✓ Antigravity wakes the session hook: refreshed (${agreed.said("antigravity-stop")}).`);
  else {
    say("  Antigravity can wake the session hook when its agent stops, so Antigravity work arrives without Claude Code running:");
    say(`    ${hooks.worktrust ? "↻" : "+"} ${AGY_HOOKS} → worktrust: Stop runs ${want.Stop[0].command}`);
  }
  if (has("dry-run")) { say("  Dry run: nothing was written."); return; }
  if (!known && !has("antigravity") && has("yes")) { say("  Not set (skipped: new, run without --yes to decide)."); return; }
  if (!known && !has("antigravity") && !(await ask("Let Antigravity wake the session hook?", false))) { agreed.drop("antigravity-stop"); say("  Not set. npx worktrust update asks again."); return; }
  await prepareBundledRuntime(); want = desired();
  writeAgyHooks({ ...hooks, worktrust: want });
  agreed.agree("antigravity-stop", has("antigravity") ? "flag" : "typed");
  say(`  ${known ? "  Restart" : "✓ Antigravity wakes the session hook. Restart"} Antigravity to pick it up${existsSync(`${AGY_HOOKS}.worktrust-backup`) ? "; the earlier file is kept as hooks.json.worktrust-backup" : ""}.`);
}
/** Disconnect takes the hook named worktrust out of Antigravity's hooks, and nothing else. */
function removeAntigravityHook() {
  const hooks = agyHooks();
  if (!hooks?.worktrust) return false;
  delete hooks.worktrust;
  writeAgyHooks(hooks);
  return true;
}

/** Disconnect takes WorkTrust's notify line out, never another program's: the hook it named is about to be deleted. */
function removeCodexNotify() {
  const found = codexNotify();
  if (!found.text || !isOurNotify(found.text)) return false;
  const rows = [...found.rows];
  rows.splice(found.at, found.end - found.at + 1);
  writeCodex(rows);
  return true;
}

async function disconnect() {
  say();
  say(`  WorkTrust · disconnect ${hostname().replace(/\.local$/i, "")}`);
  say();
  const paths = await scripts();
  const plan = await run(paths["setup-mcp.mjs"], ["--remove"], PLACEHOLDER, true);
  say("  1. The WorkTrust door comes out of every AI app here:");
  for (const line of planLines(plan.out)) say(line);
  say("  2. The session hook comes out of ~/.claude/settings.json (and Codex's notify line and Antigravity's worktrust hook, when WorkTrust set them), credentials are removed (an encrypted empty slot keeps the OS-vault preference), and so is the record of what you agreed to (consent.json)");
  say("     but for one note of which account this computer fed (masked), so a later coupling by another account starts clean.");
  say("  3. The key itself stays valid until you revoke it: WorkTrust → Sources → Devices → this computer → Revoke.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was changed."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was changed."); return; }
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], PLACEHOLDER);
  await run(paths["log-session.mjs"], ["--uninstall", "--purge"], PLACEHOLDER);
  // 0.10.15: the WorkTrust mod goes with the coupling, and what it counted with it.
  try { const mod = await import(pathToFileURL(paths["claude-mod.mjs"]).href); if (mod.modInstalled()) { mod.uninstallMod(); say("  ✓ The WorkTrust mod is out of Claude Code, and what it counted is deleted."); } } catch { /* never installed */ }
  if (removeCodexNotify()) say("  ✓ Codex no longer wakes the session hook.");
  if (removeAntigravityHook()) say("  ✓ Antigravity no longer wakes the session hook.");
  previousNote.save(keyStore.load());
  keyStore.erase();
  eraseConsent(); // 0.10.30: what was agreed goes with the coupling; a later connect asks again

  // Everything of ours on this computer goes; the folder too, when nothing else is left in it.
  for (const name of [STABLE_FILE, ...SCRIPTS.map((script) => join(HOME_DIR, downloaded(script))), join(HOME_DIR, "pinned")]) { try { rmSync(name); } catch { /* gone */ } }
  try { rmSync(HOME_DIR, { recursive: false }); } catch { /* not empty, or gone */ }
  say();
  say("  Done. Revoke the key in WorkTrust to finish.");
}

/**
 * THE WORKTRUST MOD FOR CLAUDE CODE (0.10.15, owner 2026-10-16; claude-mod.mjs, docs/CLAUDE-CODE-MOD.md). The person turns
 * it on and off here; nothing else installs it. On: Claude Code (2.1.287 or later) loads it in every session, and it
 * counts, per session and day, what a transcript cannot show. Its counts stay in ~/.worktrust/claude-mod-counts until
 * the session hook reports that session's stretch, beside the rest; they reach the person's own mirror, never a score.
 */
async function mod() {
  const paths = await scripts();
  const kit = await import(pathToFileURL(paths["claude-mod.mjs"]).href);
  const sub = args[1] ?? "status";
  const on = kit.modInstalled();
  say();
  say(`  WorkTrust mod for Claude Code · ${on ? "on" : "off"}`);
  say();
  if (sub === "install") {
    say("  It runs inside Claude Code and counts, per session and day, what a transcript cannot show:");
    say("    · permission questions put to you, and how often you said yes or no");
    say("    · model requests per effort level, the models that answered, requests sent to another model");
    say("    · the peak context fill and plan-limit use, compactions you asked for or that ran by themselves");
    say("    · subagents and teammates started, and how many mods, MCP servers and own agent types are active");
    say("  Counts only: never a prompt, an answer, a command, a file or a name. It sends nothing itself: your session hook");
    say("  reports the counts with the session, and they show in your own mirror, not on your passport.");
    say(`  It names ~/.worktrust/claude-mod in ~/.claude/settings.json (CLAUDE_CODE_PLUGIN_DIRS), backed up first. Claude Code ${kit.MIN_CLAUDE_CODE} or later.`);
    say();
    if (on && !has("yes")) { kit.installMod(); say("  Already on. Its file is refreshed; nothing else changed."); return; }
    if (!(await ask("Turn it on?"))) { say("  Stopped. Nothing was changed."); return; }
    const done = kit.installMod();
    say(`  ✓ On: ${done.dir}${done.settingsChanged ? " (named in ~/.claude/settings.json)" : ""}. Start a new Claude Code session, or run /reload-plugins in an open one.`);
    say("    In Claude Code, /plugin then shows: 1 mod active · worktrust-measure.");
    return;
  }
  if (sub === "remove" || sub === "uninstall") {
    if (!on) { say("  It is not on. Nothing to remove."); return; }
    if (!(await ask("Turn it off and delete what it counted?"))) { say("  Stopped. Nothing was changed."); return; }
    kit.uninstallMod();
    say("  ✓ Off. It is out of ~/.claude/settings.json and its counts are deleted. Counts already reported stay in your mirror.");
    return;
  }
  say(on ? "  On: Claude Code loads it in every new session. `worktrust mod remove` turns it off." : "  Off. `worktrust mod install` shows what it counts and asks first.");
}

async function status() {
  const door = claudeDoorHere();
  say(door ? `  Claude Code: coupled (${door[1].url ?? "through the local bridge"})` : "  Claude Code: not coupled. Run `npx worktrust connect`.");
  const key = keyStore.load();
  say(`  Credential storage: ${keyStore.protected() ? "OS vault + encrypted local file" : "private local file; use worktrust protect-key after updating"}`);
  say(key ? `  Key: in ${KEY_PLACE}, ${key.device ? "bound to this computer, " : ""}last renewed ${String(key.renewedAt ?? "").slice(0, 10) || "never"}` : "  Key: not on this computer (or written into the apps' settings with --direct)");
  if (key) say(key.account ? `  Account: ${key.account}${key.coupledAt ? `, coupled ${String(key.coupledAt).slice(0, 10)}` : ""}` : "  Account: not recorded (coupled by an older version; `npx worktrust connect` records it)");
  say(sessionHookHere() ? "  Session hook: installed" : "  Session hook: not installed");
  // A TRANSCRIPT THE HOOK COULD NOT READ (0.10.32): the count of its last run that had any, never which file; WorkTrust has the count too.
  { let unread = null; try { unread = JSON.parse(readFileSync(join(HOME_DIR, "sessions.json"), "utf8")).__unreadable ?? null; } catch { /* no state yet */ }
    if (Number(unread?.count) > 0) say(`  Transcripts: ${unread.count} could not be read on ${String(unread.at).slice(0, 10)}; their days are not measured until they can be (WorkTrust was told the count, nothing else)`); }
  if (existsSync(join(homedir(), ".codex"))) { const notify = codexNotify().text ?? ""; say(isOurNotify(notify) ? "  Codex: wakes the session hook" : "  Codex: does not wake the session hook (npx worktrust update asks)"); }
  if (existsSync(join(homedir(), ".hermes"))) { let text = ""; try { text = readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf8"); } catch { /* none */ } say(/worktrust(?:-launch)?\.(?:mjs|py)\\?" hook --hermes/.test(text) ? "  Hermes Agent: wakes the session hook" : "  Hermes Agent: does not wake the session hook (npx worktrust update writes it)"); }
  if (antigravityHere()) say(agyHooks()?.worktrust ? "  Antigravity: wakes the session hook" : "  Antigravity: does not wake the session hook (npx worktrust update asks)");
  say("  Counter: from this release, checked by the official launcher");
  await measuredHere();
}

/**
 * WHAT THIS COMPUTER MEASURES (0.8.3): the last thirty days of its own sessions, as the hook derives them and sends them
 * with each stretch (kinds and counts, never text). Read here by the hook beside this file; nothing is sent to show it.
 */
async function measuredHere() {
  const hook = join(HERE, "log-session.mjs");
  if (!hook) return;
  // Through the CLI's one way of starting a script (never a synchronous child: check-computer-pairing), with no door to send to.
  const read = await run(hook, ["--evidence-summary"], "", true, { WORKTRUST_MCP_URL: "", WORKTRUST_HOOK_INPUT: "" });
  let m = null;
  try { m = JSON.parse(read.out.trim().split("\n").filter((text) => text.startsWith("{")).pop()); } catch { return; }
  if (!m || !m.stretches) { say("  Measured here, last 30 days: no finished work stretch yet."); return; }
  const of = (part, whole, one, many) => `${part} of ${whole} ${whole === 1 ? one : many}`;
  say();
  say(`  Measured here, last 30 days: ${m.stretches} work stretch${m.stretches === 1 ? "" : "es"} (the hours are WorkTrust's: see the app)`);
  if (m.delivered) say(`    verified before delivery   ${of(m.verified_first, m.delivered, "stretch that delivered", "stretches that delivered")}`);
  if (m.failures) say(`    recovered failures         ${of(m.recovered, m.failures, "failed tool call", "failed tool calls")} (${m.blind_retries} retried unchanged)`);
  if (m.steers) say(`    steering that worked       ${of(m.effective_steers, m.steers, "time you stepped in", "times you stepped in")}`);
  if (m.refused || m.guard_denied) say(`    refused                    ${m.refused} by you · ${m.guard_denied} by a guard`);
  if (m.planned) say(`    planned                    ${m.planned} stretch${m.planned === 1 ? "" : "es"} with a to-do list`);
  if (m.files) say(`    tests among changed files  ${of(m.test_files, m.files, "file", "files")}`);
  const tiers = Object.entries(m.complexity ?? {}).sort();
  if (tiers.length) say(`    task complexity            ${tiers.map(([tier, n]) => `${tier} ${n}`).join(" · ")}`);
  say("  Sent with each stretch as kinds and counts, never text. Keep your own copy: npx worktrust@latest preserve");
}

/** Claude Code's `cleanupPeriodDays` (its default 30), or null without Claude Code here. Read only: preserve.mjs changes it, on a yes. */
function claudeKeepsDays() {
  if (!existsSync(join(homedir(), ".claude"))) return null;
  try { const days = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).cleanupPeriodDays; return typeof days === "number" ? days : 30; } catch { return 30; }
}

/**
 * KEEP YOUR HISTORY (`npx worktrust@latest preserve`, 2026-10-06): preserve.mjs beside this file, run as it is. Local only: no
 * key, no account, no connection. From a single downloaded file it is not offered, since fetching it would be one.
 */
async function preserve() {
  const script = join(HERE, "preserve.mjs");
  if (!existsSync(script)) fail("preserve runs from the package: npx worktrust@latest preserve");
  const child = spawn(moduleExecutable(HERE), [...moduleArgs(HERE, "preserve.mjs", args.filter((arg) => arg !== "preserve"))], { stdio: "inherit", env: { ...process.env, WORKTRUST_COLLECTOR: `worktrust-cli/${CLI_VERSION}` } });
  process.exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

function help() {
  say("WorkTrust: couple this computer to your record. Metadata only.");
  say();
  say("  worktrust              couple this computer: show the plan, ask, approve in your browser");
  say("                         (already coupled: shows what is coupled here)");
  say("    --dry-run            the plan only: nothing is written, nothing is sent");
  say("    --yes                no question (the computer is still approved in the browser)");
  say("    --device             no browser here (SSH): type a code on another device");
  say("    --name <name>        the name this computer gets (default: its host name)");
  say("    --direct             put the key in each app's settings instead of the key file");
  say("  worktrust connect      couple again, also when this computer is already coupled (asks first)");
  say("    --replace            yes in advance to coupling a computer that is already coupled");
  say("  worktrust update       this computer onto the newest CLI: same key, no new pairing; what you agreed to before is");
  say("                         refreshed without a question, a new AI app or hook is asked about (--yes: skipped)");
  say("    --rebuild            yes in advance to the re-measure update offers after a new version (the plan is still shown)");
  say("    --codex              yes in advance to letting Codex wake the session hook (also for connect)");
  say("    --antigravity        yes in advance to letting Antigravity wake the session hook (also for connect)");
  say("  worktrust history      send this computer's earlier sessions as history (asks first)");
  say("    --resume             retry saved metadata batches, even if source files are gone (asks first)");
  say("    --retry-review       explicitly retry held batches after support resolves their review");
  say("    --rebuild            re-measure them with the current rules; WorkTrust replaces this computer's earlier lines,");
  say("                         day by day, never counting a day twice (shows the plan per AI app, asks first; --dry-run: the plan only)");
  say("    --from-archive [dir] send what your archive (preserve --archive) holds of sessions your AI apps already deleted,");
  say("                         marked as from your archive: a day this computer's key signed as measured, every other day");
  say("                         as reconstructed, never verified hours (shows the plan, asks first)");
  say("    --export <path>      a ChatGPT or Claude data export (the zip, its folder, conversations.json, a conversations part or the manifest) as history:");
  say("                         hours reconstructed from its clocks, shown with their origin, never verified hours (asks first);");
  say("                         on its days the export replaces the product's earlier connector lines (withdrawn, kept)");
  say("    --withdraw-unknown   with --export: yes in advance to withdrawing the earlier lines your connector of that vendor reported for those days under no product");
  say("    --from-folder <dir>  your own copy of an AI app's session folder (a backed-up ~/.claude/projects, ~/.codex/sessions):");
  say("                         days this computer's own sessions lack, reconstructed, never verified hours (asks first)");
  say("  worktrust disconnect   take WorkTrust out of every AI app here (asks first)");
  say("  worktrust status       what is coupled here");
  say("  worktrust protect-key  after update: move credential protection into the OS vault (asks first)");
  say("  worktrust orchestration report --file recording.jsonl   inspect local agent metadata; sends nothing");
  say("  worktrust mod          the WorkTrust mod for Claude Code: what it counts, and whether it is on");
  say("    install              turn it on: counts permission answers, effort levels, context peaks and subagents (asks first)");
  say("    remove               turn it off and delete what it counted");
  say("  worktrust preserve     keep your AI history: the report, then the settings and a local archive, each on your yes");
  say("    --apply              keep them: asks per change, backs the file up first (--yes: no question)");
  say("    --archive [dir]      a local, metadata-only, hash-chained record of the measured days (~/AI-Evidence)");
  say("    --verify [dir]       check that record: every hash, the chain, each day's root and signature");
  say("    --summary [dir]      hours, tokens per model, cache share and parallel sessions, counted from that record");
}

// THE BARE COMMAND COUPLES (owner, 2026-10-03: "zo kort mogelijk"). `npx worktrust` on a computer
// An existing key shows the current coupling; no key starts the pairing plan.
// AN AGENT DOES NOT RUN WORKTRUST FOR A PERSON (owner, 2026-10-08; AGENTS.md). The commands that change what this
// computer sends, couples or rebuilds are the person's to run in their own terminal: in an AI agent's shell they stop
// before anything is read or written, --yes included. The hook and the MCP bridge are started by the agent's client
// itself and stay as they are; `status` only reads.
async function main() {
if (!moduleArgs || !moduleExecutable || !createCredentialStore) fail("Use the complete WorkTrust package from npm/PyPI or the signed preservation kit; individual scripts cannot run.");
if (Number(process.versions.node.split(".")[0]) < 18) fail("needs Node 18 or later (fetch is built in from 18).");
const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_CI", "GEMINI_CLI", "CURSOR_AGENT", "OPENCODE", "CLINE_ACTIVE", "AIDER_CHAT", "ANTIGRAVITY_AGENT", "WINDSURF_AGENT"];
const PERSON_ONLY = new Set(["default", "connect", "update", "history", "disconnect", "preserve", "codex", "antigravity", "sources", "web", "import", "orchestration", "mod", "protect-key"]);
const agentShell = AGENT_ENV.find((name) => process.env[name] && process.env[name] !== "0");
if (agentShell && PERSON_ONLY.has(command)) {
  say();
  say(`  worktrust${command === "default" ? "" : ` ${command}`} is run by the person, in their own terminal, never by an AI agent for them (this shell is an agent's: ${agentShell}).`);
  say("  Nothing was read, sent or changed. See AGENTS.md in the package: https://www.npmjs.com/package/worktrust");
  return (process.exitCode = 3);
}

/** Interactive version notice only. Registry metadata is not a trusted signed release catalogue.
 * Hooks, bridge and offline preserve never check. Installation remains with the person's package manager
 * until the signed release updater has a provisioned trust root and has passed the distribution gates.
 */
const RELAY_COMMANDS = new Set(["default", "connect", "update", "history", "status", "disconnect", "codex", "antigravity"]);
const semverNewer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
async function newestVersion() {
  try {
    const response = await fetch(process.env.WORKTRUST_REGISTRY_URL || "https://registry.npmjs.org/worktrust/latest", { signal: AbortSignal.timeout(2000), headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const version = (await response.json())?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch { return null; }
}
async function relayToNewest() {
  if (process.env.WORKTRUST_RELAYED === "1" || !RELAY_COMMANDS.has(command) || !process.stdin.isTTY || !process.stdout.isTTY) return;
  const latest = await newestVersion();
  if (!latest || !semverNewer(latest, CLI_VERSION)) return;
  say(`  WorkTrust ${latest} is available. Automatic execution is paused until signed release verification is configured.`);
  say("  Update explicitly using the package manager you installed with. This invocation keeps its current version.");
}
if (await relayToNewest()) return;

if (!["version", "help", "preserve"].includes(command)) {
  try { keyStore.load(); }
  catch { fail("The local WorkTrust key file is unsafe or damaged, or the OS vault is locked or unavailable. Upload stopped. Unlock your OS vault and retry. Do not delete the key file or reset the keychain."); }
}
if (command === "version") say(CLI_VERSION);
else if (command === "default") { if (keyStore.load()) await again(); else await connect(); }
else if (command === "mcp") await bridge();
else if (command === "hook") await hook();
else if (command === "connect") await connect();
else if (command === "update") await update();
else if (command === "protect-key") await protectKey();
else if (command === "history") await history();
// NOT FROM THE TERMINAL (owner, 2026-10-04): an ACCOUNT is connected under Sources in the app, where the
// page also says what is already connected: Claude and ChatGPT on the web and their earlier
// conversations, GitHub, Vercel, Supabase and Hugging Face. The CLI does what happens on this
// computer. The old words still answer, with the address.
else if (command === "sources" || command === "web" || command === "import") { say(); say(`  Claude and ChatGPT on the web, their earlier conversations, GitHub, Vercel, Supabase and Hugging Face`); say(`  are connected in WorkTrust, under Sources: ${new URL("/sources", ORIGIN)}`); }
// CODEX IS ASKED BY CONNECT AND BY UPDATE (owner, 2026-10-04): a person knows those two. `codex` stays, unlisted,
// as plumbing like `mcp` and `hook`: the one question alone, which is also what check-cli-package runs on real configs.
else if (command === "codex") await offerCodex();
else if (command === "antigravity") await offerAntigravity();
else if (command === "disconnect") await disconnect();
else if (command === "status") await status();
else if (command === "preserve") await preserve();
else if (command === "mod") await mod();
else if (command === "orchestration") {
  if (!["orchestration-report.mjs", "orchestration-evidence.mjs", "orchestration-contract.mjs"].every((name) => existsSync(join(HERE, name)))) fail("Local agent reports need the complete WorkTrust npm/Python package or preservation kit. No file was read or sent.");
  const { reportFile } = await import("./orchestration-report.mjs"); reportFile(args.slice(1));
}
else help();

}
try { await main(); } catch (error) { if (!(error instanceof CliFailure)) throw error; process.exitCode = 1; }
