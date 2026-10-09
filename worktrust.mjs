#!/usr/bin/env node
/**
 * WorkTrust on a computer, in one command — like `gh auth login` (2026-10-03).
 *
 *   npx worktrust                       show the plan, ask, approve this computer in the app, couple (0.10.7: a person's
 *                                       command always runs the newest version, whatever npx had cached);
 *                                       on a computer already coupled: what is coupled here
 *   npx worktrust --dry-run             show the plan only; nothing is written, nothing is sent
 *   npx worktrust --yes                 no question (for scripts); the computer is still approved in the app
 *   npx worktrust --device              a computer without a browser (SSH): type a code on another device
 *   npx worktrust@latest connect               couple again, also on a computer already coupled
 *   npx worktrust@latest update                this computer onto the newest CLI, same key, no new pairing
 *   npx worktrust@latest history               send this computer's earlier sessions as history (asks first)
 *   npx worktrust@latest history --rebuild     the same as history (0.10.5: history always re-measures); WorkTrust replaces this computer's
 *                                              earlier lines day by day, never counting a day twice (shows the plan, asks first)
 *   npx worktrust@latest history --from-archive [dir]   send what your local archive holds of sessions your AI apps have
 *                                              already deleted, marked as from your archive (shows the plan, asks first)
 *   npx worktrust@latest disconnect            show what comes out, ask, take it out again
 *   npx worktrust@latest status                what is coupled here
 *   npx worktrust@latest preserve              how long each AI app here keeps its sessions (--apply keeps them,
 *                                       --archive [dir] a local metadata-only record, --verify [dir] checks it,
 *                                       --summary [dir] counts hours, tokens and parallel sessions from it);
 *                                       local only: no account, no key, no network (preserve.mjs)
 *
 * WHAT RUNS. From the npm package, everything that runs is in the package: this file,
 * `setup-mcp.mjs` (gives every AI app here the WorkTrust door), `log-session.mjs` (the session hook)
 * and `count-behaviour.mjs` (the local counter, pinned: never replaced from the network), with
 * `transcript-readers.mjs` (how Codex and Antigravity logs are read, imported by the last two). Nothing
 * is downloaded. Run as a single file from WorkTrust's site instead, it fetches those from that
 * same site, and says so before it asks.
 *
 * HOW THE ACCOUNT IS DECIDED. By default this terminal listens on 127.0.0.1 for one answer and holds
 * a PKCE secret. Your browser opens WorkTrust, you approve this computer there (signed in, second
 * factor), and the browser is sent back to 127.0.0.1 with a one-time code that only this terminal,
 * with its secret, can exchange for the key. Nothing is typed, and a link forwarded to someone else
 * approves nothing they can collect. Without a browser (`--device`, or over SSH) the terminal shows
 * a code that you type yourself at app.worktrust.io/connect/computer.
 *
 * WHERE THE KEY LIVES. In one file only you can read (~/.worktrust/key.json, mode 600, folder 700).
 * No keychain is touched. The AI apps never hold it:
 * each runs `worktrust.mjs mcp`, a small local bridge that reads the key and speaks to WorkTrust for
 * them, and the session hook runs through `worktrust.mjs hook` the same way. `--direct` writes the
 * key into each app's settings instead (for an app that cannot run a local command).
 *
 * THE KEY ONLY WORKS ON THIS COMPUTER. connect makes an Ed25519 key pair; the public half goes to
 * WorkTrust, the private half stays in the key file. Every call the bridge, the hook and
 * the counter make carries a fresh signature (`WorkTrust-Proof`), and WorkTrust refuses a call
 * through this key without one: a copied key alone is worth nothing.
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
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createInterface as lines } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const VALUED = ["--name", "--origin", "--url"];
const command = args.find((arg, at) => !arg.startsWith("--") && !(at > 0 && VALUED.includes(args[at - 1]))) ?? (args.includes("--help") ? "help" : "default");
const flag = (name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
/** This CLI's version, said to the door so the app can tell which computer runs an old one (check-cli-package holds it equal to package.json). */
const CLI_VERSION = "0.10.8";
const ORIGIN = (flag("origin") ?? process.env.WORKTRUST_ORIGIN ?? "https://app.worktrust.io").replace(/\/$/, "");
const MCP = flag("url") ?? process.env.WORKTRUST_MCP_URL ?? `${ORIGIN}/api/mcp`;
const HOME_DIR = join(homedir(), ".worktrust");
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ["setup-mcp.mjs", "log-session.mjs", "count-behaviour.mjs", "transcript-readers.mjs", "session-databases.mjs", "config-edits.mjs", "stretch-evidence.mjs"];
/** The modules the scripts import by name from beside them; a download keeps that name. */
const IMPORTED = new Set(["transcript-readers.mjs", "session-databases.mjs", "config-edits.mjs", "stretch-evidence.mjs"]);
const downloaded = (name) => (IMPORTED.has(name) ? name : `${name}.download.mjs`);
const BUNDLED = SCRIPTS.every((name) => existsSync(join(HERE, name)));
const PLACEHOLDER = `wt_${"0".repeat(43)}`;
const say = (line = "") => process.stdout.write(`${line}\n`);
// A reader that closed the pipe (`worktrust status | head`) wants no more: stop quietly, never an EPIPE stack (0.6.16, audit L4).
process.stdout.on("error", (error) => { if (error?.code === "EPIPE") process.exit(0); throw error; });
const fail = (line) => { process.stderr.write(`worktrust: ${line}\n`); process.exit(1); };
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

if (Number(process.versions.node.split(".")[0]) < 18) fail("needs Node 18 or later (fetch is built in from 18).");

async function post(path, body) {
  const response = await fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

/** The three scripts: from the package when it carries them; otherwise from the same site, once, into ~/.worktrust. */
async function scripts() {
  if (BUNDLED) return Object.fromEntries(SCRIPTS.map((name) => [name, join(HERE, name)]));
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const paths = {};
  for (const name of SCRIPTS) {
    const response = await fetch(`${ORIGIN}/counter/${name}`);
    if (!response.ok) fail(`could not download ${name} (${response.status}).`);
    paths[name] = join(HOME_DIR, downloaded(name));
    writeFileSync(paths[name], await response.text(), { mode: 0o600 });
  }
  return paths;
}

/** Run a script; its output is shown, or collected for the plan. The key travels in the environment only. */
function run(path, scriptArgs, token, collect = false, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, ...scriptArgs], { stdio: collect ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, WORKTRUST_MCP_URL: MCP, WORKTRUST_MCP_TOKEN: token, WORKTRUST_NODE: NODE, ...extraEnv } });
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
  if (!exchange || exchange.status !== 200 || !exchange.json.token) fail(`the approval could not be exchanged (${exchange?.json?.error ?? "no answer"}). Run \`worktrust connect\` again.`);
  say(`  ✓ Approved as "${exchange.json.label}"${exchange.json.account ? ` for the WorkTrust account ${exchange.json.account}` : ""}`);
  if (exchange.json.account) say("    Not your account? Run `npx worktrust@latest disconnect` now and revoke it in WorkTrust.");
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
      if (answer.json.account) say("    Not your account? Run `npx worktrust@latest disconnect` now and revoke it in WorkTrust.");
      return paired(answer.json);
    }
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
const NODE = (process.env.PATH ?? "").split(OS === "windows" ? ";" : ":").map((dir) => join(dir, OS === "windows" ? "node.exe" : "node")).find((path) => existsSync(path)) ?? process.execPath;
const KEY_FILE = join(HOME_DIR, "key.json");
const STABLE = join(HOME_DIR, "worktrust.mjs");
const RENEW_EVERY_MS = 7 * 24 * 3600_000;
const KEY_PLACE = "~/.worktrust/key.json (only you can read it)";
const ensureHome = () => { mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 }); try { chmodSync(HOME_DIR, 0o700); } catch { /* Windows */ } };

/**
 * THE KEY'S PLACE: one file only you can read (mode 600 in a 700 folder), holding the key, its device
 * private key and when it was last renewed. NO KEYCHAIN (owner, 2026-10-03): a keychain tool can ask
 * the person to "reset" a keychain it cannot find, which deletes every password on the machine, and
 * many will not let a tool near their keychain at all. This file is never written into an AI app's
 * settings: the apps run the bridge, which reads it.
 */
const keyStore = {
  /** Written whole or not at all: a temporary file renamed over the old one. */
  save(entry) {
    ensureHome();
    const temporary = `${KEY_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, Buffer.from(JSON.stringify(entry)).toString("base64"), { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Windows */ }
    renameSync(temporary, KEY_FILE);
  },
  load() {
    try { return JSON.parse(Buffer.from(readFileSync(KEY_FILE, "utf8"), "base64").toString("utf8")); } catch { return null; }
  },
  erase() { try { rmSync(KEY_FILE); } catch { /* gone */ } },
};

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
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "user-agent": "worktrust-bridge", ...proof(device, url, body) }, body });
    return response.status !== 401 && response.status !== 403;
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
  process.stderr.write("WorkTrust: this key was made on another computer (copied from a backup?). Nothing is sent from here; run `npx worktrust@latest connect` on this computer.\n");
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
    }
    if (value.identified && Date.now() - Date.parse(value.renewedAt ?? 0) < RENEW_EVERY_MS) return value;
    const pending = `wt_${randomBytes(32).toString("base64url")}`;
    keyStore.save({ ...value, pending });
    try {
      const renewUrl = `${new URL(value.url).origin}/api/cli/renew`;
      const ids = computerIds();
      const body = JSON.stringify({ token_hash: createHash("sha256").update(pending).digest("hex"), token_prefix: pending.slice(0, 11), ...ids });
      const response = await fetch(renewUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${value.token}`, ...proof(value.device, renewUrl, body) }, body });
      if (response.ok) { const renewed = { ...value, token: pending, renewedAt: new Date().toISOString(), identified: true, profile: value.profile ?? ids.profile_id }; keyStore.save(renewed); return renewed; }
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
  try { spawn(process.execPath, [fileURLToPath(import.meta.url), "hook"], { detached: true, stdio: "ignore" }).unref(); } catch { /* the next start sweeps */ }
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
    if (!key) { if (message.id !== undefined) answer(message.id, "WorkTrust is not connected on this computer: run `npx worktrust@latest connect`."); continue; }
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
        answer(message.id, "WorkTrust did not accept this computer's key: run `npx worktrust@latest connect` again.");
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
  if (!key) process.exit(0);
  const child = spawn(process.execPath, [join(HOME_DIR, "log-session.mjs"), ...args.filter((arg) => arg !== "hook")], { stdio: "inherit", env: { ...process.env, WORKTRUST_MCP_URL: key.url, WORKTRUST_MCP_TOKEN: key.token, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) } });
  child.on("exit", (code) => process.exit(code ?? 0));
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
  try { spawn(process.execPath, [fileURLToPath(import.meta.url), "hook", "--antigravity"], { detached: true, stdio: "ignore", env: { ...process.env, WORKTRUST_HOOK_INPUT: input.slice(0, 65536) } }).unref(); } catch { /* the next run sweeps it */ }
  process.exit(0);
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
  try { spawn(process.execPath, [fileURLToPath(import.meta.url), "hook"], { detached: true, stdio: "ignore" }).unref(); } catch { /* the next run sweeps it */ }
  process.exit(0);
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
  if (!key) fail("this computer has no WorkTrust key file yet. Run npx worktrust@latest connect.");
  say();
  say(`  WorkTrust · update ${hostname().replace(/\.local$/i, "")} to ${CLI_VERSION}`);
  say();
  const paths = await scripts();
  const plan = await run(paths["setup-mcp.mjs"], ["--bridge", STABLE], PLACEHOLDER, true);
  say("  Every AI app found here gets the WorkTrust door, the local command that reads the key:");
  const found = planLines(plan.out, true).filter((line) => !line.includes("not on this machine"));
  for (const line of found) say(line);
  if (found.length === 0) say("    (no AI app found here)");
  say(`  The session hook and ${STABLE} are brought to ${CLI_VERSION}.`);
  say("  The key stays as it is: no new pairing, the same computer in WorkTrust.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was written and nothing was sent."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was written."); return; }
  ensureHome();
  const previousVersion = stableVersion();
  copyFileSync(fileURLToPath(import.meta.url), STABLE);
  say(`  ✓ ${STABLE} is now ${CLI_VERSION}`);
  // Out first, then in: an app that held a key of its own (a hand-made entry) moves onto the bridge.
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], key.token, true);
  if ((await run(paths["setup-mcp.mjs"], ["--write", "--bridge", STABLE], key.token)).code !== 0) fail("coupling the AI apps failed; the output above says where.");
  const hookArgs = ["--install", ...(BUNDLED ? ["--counter", paths["count-behaviour.mjs"]] : []), "--via", STABLE];
  if ((await run(paths["log-session.mjs"], hookArgs, key.token, false)).code !== 0) fail("installing the session hook failed; the output above says where.");
  // Codex installed since, or a No said at connect: the one question, asked again (or "already set").
  await offerCodex();
  await offerAntigravity();
  await offerRebuild(previousVersion, paths, key);
  say();
  say("  Done. Quit your AI apps completely and open them again; the CLI version shows in WorkTrust");
  say("  under Sources → CLI once one of them has spoken. A key an app held by hand still works until you end it there.");
}

async function connect() {
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
  if (!BUNDLED) say(`  The three scripts that do the work are downloaded from ${ORIGIN} first. From npm they come in the package.\n`);
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
  say(`    + ${join(HOME_DIR, "log-session.mjs")} and ${join(HOME_DIR, "count-behaviour.mjs")}${BUNDLED ? " (from this package, not updated from the network)" : ""}`);
  say(`    + ${join(homedir(), ".claude", "settings.json")} → SessionStart, SessionEnd and PreCompact run it`);
  say();
  say("  Sent to WorkTrust afterwards: durations, token counts, model names, a layer keyword, counts,");
  say("  and, to match the work to GitHub, the repository's owner/name and the commit hashes.");
  say("  Never sent: prompts, answers, code, file paths, commit messages.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was written and nothing was sent."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was written and nothing was sent."); return; }

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
    copyFileSync(fileURLToPath(import.meta.url), STABLE);
    say(`  ✓ Key kept in ${KEY_PLACE}`);
  }
  if ((await run(paths["setup-mcp.mjs"], direct ? ["--write"] : ["--write", "--bridge", STABLE], token)).code !== 0) fail("coupling the AI apps failed; the output above says where.");
  say();
  // The old key ends now that the new one is in place (never before: a failed pairing must not leave the computer uncoupled).
  if (previous?.token) await releasePrevious(previous, pairing.prefix);
  // A NEW COUPLING SENDS NOTHING FROM BEFORE IT (log-session THE FLOORS): `--from-now` for a first coupling and a change
  // of account; the same account coupled again keeps its watermarks. A change of account also closes the history offer.
  const floors = !previous || switched ? ["--from-now", ...(switched ? ["--history-floor", "now"] : [])] : [];
  const hookArgs = ["--install", ...floors, ...(BUNDLED ? ["--counter", paths["count-behaviour.mjs"]] : []), ...(direct ? [] : ["--via", STABLE])];
  if ((await run(paths["log-session.mjs"], hookArgs, token, false, { WORKTRUST_CODEX_OFFER: "1" })).code !== 0) fail("installing the session hook failed; the output above says where.");
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
async function offerHistory(paths, token, devicePem, url = MCP, rebuild = false) {
  const env = { WORKTRUST_MCP_URL: url, ...(devicePem ? { WORKTRUST_DEVICE_KEY: devicePem } : {}) };
  const counted = await run(paths["log-session.mjs"], ["--history", "--dry-run", "--summary"], token, true, env);
  let found = null;
  try { found = JSON.parse(counted.out.trim().split("\n").pop()); } catch { /* no line: nothing to offer */ }
  say();
  if (!found?.sessions) { historyDone(true); say(rebuild ? "  Your AI apps hold no earlier sessions on this computer to re-measure." : "  Your AI apps hold no earlier sessions on this computer to send."); return; }
  say(`  This computer holds ${found.sessions} earlier sessions of your AI apps · ${found.hours} measured hours · ${found.first} … ${found.last}.`);
  // REBUILD (owner, 2026-10-07): the plan per AI app, in days and hours, and what it replaces, before the one question. Enter is No.
  if (rebuild) {
    for (const row of found.clients ?? []) say(`    ${row.client.padEnd(12)} ${String(row.days).padStart(4)} days  ${String(row.hours).padStart(7)} h   ${row.first} … ${row.last}`);
    say("  Re-measured with the current rules (what the seconds were, your own turns, tokens with the cache, every AI app above).");
    say("  WorkTrust REPLACES this computer's earlier lines for those days and apps: each earlier line is withdrawn and kept,");
    say("  never deleted, so a day is counted once. Other computers, web sources and days not listed are not touched.");
  }
  if (has("dry-run")) { say("  Dry run: nothing was sent."); return; }
  if (!has("history") && !(rebuild ? await ask("Send them (re-measured; this computer's earlier lines for these days are replaced, a day is counted once)?", false) : await ask("Send these as history (hours and tokens per day; never text)?", false))) { historyDone(false); say("  Not sent. Send them later with: npx worktrust@latest"); return; }
  const sent = await run(paths["log-session.mjs"], ["--history", ...(rebuild ? ["--rebuild"] : [])], token, true, env);
  historyDone(sent.code === 0);
  if (rebuild) say(sent.code === 0 ? "  ✓ Rebuilt. This computer's earlier lines for those days were replaced; the record shows each replacement." : "  Not all of it arrived. Run npx worktrust@latest again: it finishes what did not arrive, a day already rebuilt is counted once.");
  else say(sent.code === 0 ? "  ✓ Sent as history. Measured sessions count toward your verified hours; a day WorkTrust already holds is kept once." : "  Not all of it arrived. Run npx worktrust@latest history again: a line already received is kept once.");
}

/** The version stamped in the stable copy in ~/.worktrust, the CLI this computer ran before an update; null without one. */
const stableVersion = () => { try { return /const CLI_VERSION = "([^"]+)";/.exec(readFileSync(STABLE, "utf8"))?.[1] ?? null; } catch { return null; } };

/**
 * OFFERED ONCE, BY `update`, IN PLAIN WORDS (owner, 2026-10-07): when the computer's earlier lines were made by an earlier CLI
 * (the version the stable copy carried before this update). The CLI cannot read the record, so it is an offer, not a
 * finding: the plan is shown and the question asked by the same path as `history --rebuild`; Enter is No. The same
 * version updated again offers nothing.
 */
async function offerRebuild(previousVersion, paths, key) {
  if (!previousVersion || previousVersion === CLI_VERSION) return;
  say();
  say(`  This computer's earlier lines in WorkTrust were measured by worktrust ${previousVersion}. Version ${CLI_VERSION} measures`);
  say("  differently (each answer's tokens counted once, nothing lost at midnight, when each stretch began, how you steered");
  say("  the agent, what the seconds were, more AI apps). You can re-measure the");
  say("  sessions still on this computer and have WorkTrust replace this computer's earlier lines, day by day, never counting");
  say("  a day twice. Later: npx worktrust@latest");
  if (!(await ask("Show the plan and rebuild now?", false))) { say("  Not now."); return; }
  await offerHistory(paths, key.token, key.device ?? null, key.url, true);
}

/**
 * WHETHER THE HISTORY ARRIVED (0.10.5, owner: "someone with little experience never knows to rebuild"). Written after each
 * send: complete when every batch arrived or there was nothing to send. Only the outcome and the version, never a session.
 */
const HISTORY_STATE = join(HOME_DIR, "history.json");
function historyDone(complete) {
  try { ensureHome(); writeFileSync(HISTORY_STATE, JSON.stringify({ version: CLI_VERSION, at: new Date().toISOString(), complete }), { mode: 0o600 }); } catch { /* the next run asks again */ }
}
const historyComplete = () => { try { return JSON.parse(readFileSync(HISTORY_STATE, "utf8")).complete === true; } catch { return false; } };

/**
 * THE SAME COMMAND AGAIN DOES WHAT IS LEFT (0.10.5). On a computer already coupled, `npx worktrust@latest` brings it onto
 * this CLI when an earlier one is installed (the update, which also offers the re-measure), else finishes the history
 * when it never arrived whole (a failed send, a question answered No, a computer coupled before this marker existed);
 * then says what is coupled. Each step still shows its plan and asks; Enter is No.
 */
async function again() {
  const before = stableVersion();
  if (before && before !== CLI_VERSION) { await update(); return; }
  if (!historyComplete()) {
    const key = await freshKey();
    if (key) { say(); say("  Your earlier sessions have not all reached WorkTrust from this computer yet. This finishes them."); await offerHistory(await scripts(), key.token, key.device ?? null, key.url, true); }
  }
  say();
  await status();
  say();
  say("  This computer is coupled. `npx worktrust@latest connect` couples it again; `npx worktrust@latest disconnect` takes it out.");
}

async function history() {
  const key = await freshKey();
  if (!key) fail("this computer is not coupled through the key file. Run npx worktrust first.");
  if (has("from-archive")) return offerArchive(await scripts(), key);
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
  const hookFile = viaBridge ? STABLE : join(HOME_DIR, "log-session.mjs");
  if (!existsSync(hookFile)) { say("  Couple this computer first: npx worktrust"); return; }
  const want = `notify = [${(viaBridge ? [NODE, STABLE, "hook", "--codex-notify"] : [NODE, hookFile, "--codex-notify"]).map((part) => JSON.stringify(part)).join(", ")}]`;
  const found = codexNotify();
  say();
  if (found.text === want) { say("  ✓ Codex already wakes the session hook at the end of every turn."); return; }
  if (found.text && !isOurNotify(found.text)) {
    say("  Codex already runs another program at the end of each turn (notify in ~/.codex/config.toml).");
    say("  Codex takes one, so it stays as it is; Codex sessions are still sent whenever the Claude Code hook runs.");
    return;
  }
  say("  Codex can wake the session hook at the end of every turn, so Codex work arrives without Claude Code running:");
  say(`    ${found.text ? "↻" : "+"} ${CODEX_CONFIG} → ${want}`);
  if (has("dry-run")) { say("  Dry run: nothing was written."); return; }
  if (!has("codex") && !(await ask("Let Codex wake the session hook?", false))) { say("  Not set. npx worktrust@latest update asks again."); return; }
  const rows = [...found.rows];
  if (found.text) rows.splice(found.at, found.end - found.at + 1, want);
  else rows.splice(found.insert, 0, ...(found.insert < rows.length && rows[found.insert] !== "" ? [want, ""] : [want]));
  if (rows.at(-1) !== "") rows.push("");
  writeCodex(rows);
  say("  ✓ Codex wakes the session hook. Restart Codex to pick it up; the earlier file is kept as config.toml.worktrust-backup.");
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
  const want = { enabled: true, Stop: [{ type: "command", command: `"${NODE}" "${STABLE}" hook --antigravity-stop`, timeout: 10 }] };
  const hooks = agyHooks();
  say();
  if (hooks === null) { say(`  ${AGY_HOOKS} is not readable JSON, so it is left as it is; Antigravity sessions are still sent whenever another hook runs.`); return; }
  if (JSON.stringify(hooks.worktrust) === JSON.stringify(want)) { say("  ✓ Antigravity already wakes the session hook when its agent stops."); return; }
  say("  Antigravity can wake the session hook when its agent stops, so Antigravity work arrives without Claude Code running:");
  say(`    ${hooks.worktrust ? "↻" : "+"} ${AGY_HOOKS} → worktrust: Stop runs ${want.Stop[0].command}`);
  if (has("dry-run")) { say("  Dry run: nothing was written."); return; }
  if (!has("antigravity") && !(await ask("Let Antigravity wake the session hook?", false))) { say("  Not set. npx worktrust@latest update asks again."); return; }
  writeAgyHooks({ ...hooks, worktrust: want });
  say(`  ✓ Antigravity wakes the session hook. Restart Antigravity to pick it up${existsSync(`${AGY_HOOKS}.worktrust-backup`) ? "; the earlier file is kept as hooks.json.worktrust-backup" : ""}.`);
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
  say("  2. The session hook comes out of ~/.claude/settings.json (and Codex's notify line and Antigravity's worktrust hook, when WorkTrust set them), the key file is deleted, and ~/.worktrust is emptied");
  say("     but for one note of which account this computer fed (masked), so a later coupling by another account starts clean.");
  say("  3. The key itself stays valid until you revoke it: WorkTrust → Sources → Devices → this computer → Revoke.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was changed."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was changed."); return; }
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], PLACEHOLDER);
  await run(paths["log-session.mjs"], ["--uninstall", "--purge"], PLACEHOLDER);
  if (removeCodexNotify()) say("  ✓ Codex no longer wakes the session hook.");
  if (removeAntigravityHook()) say("  ✓ Antigravity no longer wakes the session hook.");
  previousNote.save(keyStore.load());
  keyStore.erase();
  // Everything of ours on this computer goes; the folder too, when nothing else is left in it.
  for (const name of [STABLE, ...SCRIPTS.map((script) => join(HOME_DIR, downloaded(script))), join(HOME_DIR, "pinned")]) { try { rmSync(name); } catch { /* gone */ } }
  try { rmSync(HOME_DIR, { recursive: false }); } catch { /* not empty, or gone */ }
  say();
  say("  Done. Revoke the key in WorkTrust to finish.");
}

async function status() {
  const servers = {};
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    Object.assign(servers, config.mcpServers ?? {});
    for (const project of Object.values(config.projects ?? {})) Object.assign(servers, project.mcpServers ?? {});
  } catch { /* no Claude Code here */ }
  const door = Object.entries(servers).find(([name, server]) => /worktrust/i.test(`${name} ${server?.url ?? ""} ${(server?.args ?? []).join(" ")}`));
  say(door ? `  Claude Code: coupled (${door[1].url ?? "through the local bridge"})` : "  Claude Code: not coupled. Run `npx worktrust@latest connect`.");
  const key = keyStore.load();
  say(key ? `  Key: in ${KEY_PLACE}, ${key.device ? "bound to this computer, " : ""}last renewed ${String(key.renewedAt ?? "").slice(0, 10) || "never"}` : "  Key: not on this computer (or written into the apps' settings with --direct)");
  if (key) say(key.account ? `  Account: ${key.account}${key.coupledAt ? `, coupled ${String(key.coupledAt).slice(0, 10)}` : ""}` : "  Account: not recorded (coupled by an older version; `npx worktrust@latest connect` records it)");
  let hook = false;
  try { hook = /log-session|worktrust\.mjs\\?" hook/.test(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")); } catch { /* none */ }
  say(hook ? "  Session hook: installed" : "  Session hook: not installed");
  if (existsSync(join(homedir(), ".codex"))) { const notify = codexNotify().text ?? ""; say(isOurNotify(notify) ? "  Codex: wakes the session hook" : "  Codex: does not wake the session hook (npx worktrust@latest update asks)"); }
  if (existsSync(join(homedir(), ".hermes"))) { let text = ""; try { text = readFileSync(join(homedir(), ".hermes", "config.yaml"), "utf8"); } catch { /* none */ } say(/worktrust\.mjs\\?" hook --hermes/.test(text) ? "  Hermes Agent: wakes the session hook" : "  Hermes Agent: does not wake the session hook (npx worktrust@latest update writes it)"); }
  if (antigravityHere()) say(agyHooks()?.worktrust ? "  Antigravity: wakes the session hook" : "  Antigravity: does not wake the session hook (npx worktrust@latest update asks)");
  say(existsSync(join(HOME_DIR, "pinned")) ? "  Counter: from the package, pinned" : existsSync(join(HOME_DIR, "count-behaviour.mjs")) ? "  Counter: follows the site" : "  Counter: not installed");
  await measuredHere();
}

/**
 * WHAT THIS COMPUTER MEASURES (0.8.3): the last thirty days of its own sessions, as the hook derives them and sends them
 * with each stretch (kinds and counts, never text). Read here by the hook beside this file; nothing is sent to show it.
 */
async function measuredHere() {
  const hook = [join(HERE, "log-session.mjs"), join(HOME_DIR, "log-session.mjs")].find((path) => existsSync(path));
  if (!hook) return;
  // Through the CLI's one way of starting a script (never a synchronous child: check-computer-pairing), with no door to send to.
  const read = await run(hook, ["--evidence-summary"], "", true, { WORKTRUST_MCP_URL: "", WORKTRUST_HOOK_INPUT: "" });
  let m = null;
  try { m = JSON.parse(read.out.trim().split("\n").filter((text) => text.startsWith("{")).pop()); } catch { return; }
  if (!m || !m.stretches) { say("  Measured here, last 30 days: no finished work stretch yet."); return; }
  const of = (part, whole, unit) => `${part} of ${whole} ${unit}`;
  say();
  say(`  Measured here, last 30 days: ${m.stretches} work stretches · ${m.hours} h`);
  if (m.delivered) say(`    verified before delivery   ${of(m.verified_first, m.delivered, "stretches that delivered")}`);
  if (m.failures) say(`    recovered failures         ${of(m.recovered, m.failures, "failed tool calls")} (${m.blind_retries} retried unchanged)`);
  if (m.steers) say(`    steering that worked       ${of(m.effective_steers, m.steers, "times you stepped in")}`);
  if (m.refused || m.guard_denied) say(`    refused                    ${m.refused} by you · ${m.guard_denied} by a guard`);
  if (m.planned) say(`    planned                    ${m.planned} stretches with a to-do list`);
  if (m.files) say(`    tests among changed files  ${of(m.test_files, m.files, "files")}`);
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
  const child = spawn(process.execPath, [script, ...args.filter((arg) => arg !== "preserve")], { stdio: "inherit", env: { ...process.env, WORKTRUST_COLLECTOR: `worktrust-cli/${CLI_VERSION}` } });
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
  say("  worktrust update       this computer onto the newest CLI: same key, no new pairing");
  say("  worktrust history      send this computer's earlier sessions as history (asks first)");
  say("    --rebuild            re-measure them with the current rules; WorkTrust replaces this computer's earlier lines,");
  say("                         day by day, never counting a day twice (shows the plan per AI app, asks first; --dry-run: the plan only)");
  say("    --from-archive [dir] send what your archive (preserve --archive) holds of sessions your AI apps already deleted,");
  say("                         only days this computer signed, marked as from your archive (shows the plan, asks first)");
  say("  worktrust disconnect   take WorkTrust out of every AI app here (asks first)");
  say("  worktrust status       what is coupled here");
  say("  worktrust preserve     keep your AI history: the report, then the settings and a local archive, each on your yes");
  say("    --apply              keep them: asks per change, backs the file up first (--yes: no question)");
  say("    --archive [dir]      a local, metadata-only, hash-chained record of the measured days (~/AI-Evidence)");
  say("    --verify [dir]       check that record: every hash, the chain, each day's root and signature");
  say("    --summary [dir]      hours, tokens per model, cache share and parallel sessions, counted from that record");
}

// THE BARE COMMAND COUPLES (owner, 2026-10-03: "zo kort mogelijk"). `npx worktrust` on a computer
// without a key here shows the plan and asks, exactly as `connect` does; with one it says what is
// coupled, so running it twice never re-pairs by surprise.
// AN AGENT DOES NOT RUN WORKTRUST FOR A PERSON (owner, 2026-10-08; AGENTS.md). The commands that change what this
// computer sends, couples or rebuilds are the person's to run in their own terminal: in an AI agent's shell they stop
// before anything is read or written, --yes included. The hook and the MCP bridge are started by the agent's client
// itself and stay as they are; `status` only reads.
const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_CI", "GEMINI_CLI", "CURSOR_AGENT", "OPENCODE", "CLINE_ACTIVE", "AIDER_CHAT", "ANTIGRAVITY_AGENT", "WINDSURF_AGENT"];
const PERSON_ONLY = new Set(["connect", "update", "history", "disconnect", "preserve", "codex", "antigravity", "sources", "web", "import"]);
const agentShell = AGENT_ENV.find((name) => process.env[name] && process.env[name] !== "0");
if (agentShell && PERSON_ONLY.has(command)) {
  say();
  say(`  worktrust ${command} is run by the person, in their own terminal, never by an AI agent for them (this shell is an agent's: ${agentShell}).`);
  say("  Nothing was read, sent or changed. See AGENTS.md in the package: https://www.npmjs.com/package/worktrust");
  process.exit(3);
}

/**
 * ALWAYS THE NEWEST, WHATEVER WAS TYPED (0.10.7, owner: "npx worktrust should simply be right"). npx runs whatever version
 * it cached, and a person should never need `@latest` or `--prefer-online`. A command a PERSON runs in a terminal asks npm
 * which version is newest (the version string only, nothing of this computer, two seconds at most) and, when this one is
 * older, hands the same command to the newest through npx and steps aside. Offline, npm slow, no terminal (a script, a
 * test), an AI agent's shell: this version runs as it is. The bridge and the hook, which run many times a day from the
 * stable copy, never ask.
 */
// NOT `preserve` (0.10.8): it promises no network connection at all (the site and its kit say so), so it never asks npm.
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
  say(`  worktrust ${CLI_VERSION} is not the newest: running ${latest} instead.`);
  const argv = ["--yes", `worktrust@${latest}`, ...args];
  const env = { ...process.env, WORKTRUST_RELAYED: "1" };
  // A .cmd shim on Windows needs a shell: one line, each argument quoted for cmd.exe, never an argument list beside it.
  const quote = (arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '\\"')}"`);
  const child = platform() === "win32" ? spawn(["npx", ...argv].map(quote).join(" "), { stdio: "inherit", env, shell: true }) : spawn("npx", argv, { stdio: "inherit", env });
  const code = await new Promise((done) => { child.on("error", () => done(null)); child.on("close", (exit) => done(exit)); });
  if (code === null) { say("  The newest could not be started; this version runs instead."); return; }
  process.exit(code);
}
await relayToNewest();

if (command === "default") { if (keyStore.load()) await again(); else await connect(); }
else if (command === "mcp") await bridge();
else if (command === "hook") await hook();
else if (command === "connect") await connect();
else if (command === "update") await update();
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
else help();
