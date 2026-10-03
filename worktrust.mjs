#!/usr/bin/env node
/**
 * WorkTrust on a computer, in one command — like `gh auth login` (2026-10-03).
 *
 *   npx worktrust                       show the plan, ask, approve this computer in the app, couple;
 *                                       on a computer already coupled: what is coupled here
 *   npx worktrust --dry-run             show the plan only; nothing is written, nothing is sent
 *   npx worktrust --yes                 no question (for scripts); the computer is still approved in the app
 *   npx worktrust --device              a computer without a browser (SSH): type a code on another device
 *   npx worktrust connect               couple again, also on a computer already coupled
 *   npx worktrust disconnect            show what comes out, ask, take it out again
 *   npx worktrust status                what is coupled here
 *
 * WHAT RUNS. From the npm package, everything that runs is in the package: this file,
 * `setup-mcp.mjs` (gives every AI app here the WorkTrust door), `log-session.mjs` (the session hook)
 * and `count-behaviour.mjs` (the local counter, pinned: never replaced from the network). Nothing is
 * downloaded. Run as a single file from WorkTrust's site instead, it fetches those three from that
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
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const ORIGIN = (flag("origin") ?? process.env.WORKTRUST_ORIGIN ?? "https://app.worktrust.io").replace(/\/$/, "");
const MCP = flag("url") ?? process.env.WORKTRUST_MCP_URL ?? `${ORIGIN}/api/mcp`;
const HOME_DIR = join(homedir(), ".worktrust");
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ["setup-mcp.mjs", "log-session.mjs", "count-behaviour.mjs"];
const BUNDLED = SCRIPTS.every((name) => existsSync(join(HERE, name)));
const PLACEHOLDER = `wt_${"0".repeat(43)}`;
const say = (line = "") => process.stdout.write(`${line}\n`);
const fail = (line) => { process.stderr.write(`worktrust: ${line}\n`); process.exit(1); };
const OS = { darwin: "macos", win32: "windows", linux: "linux" }[platform()] ?? "other";
const OS_NAME = { macos: "macOS", windows: "Windows", linux: "Linux", other: "this system" }[OS];

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
    paths[name] = join(HOME_DIR, `${name}.download.mjs`);
    writeFileSync(paths[name], await response.text(), { mode: 0o600 });
  }
  return paths;
}

/** Run a script; its output is shown, or collected for the plan. The key travels in the environment only. */
function run(path, scriptArgs, token, collect = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, ...scriptArgs], { stdio: collect ? ["ignore", "pipe", "pipe"] : "inherit", env: { ...process.env, WORKTRUST_MCP_URL: MCP, WORKTRUST_MCP_TOKEN: token, WORKTRUST_NODE: NODE } });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function ask(question) {
  if (has("yes")) return true;
  if (!process.stdin.isTTY) fail("not a terminal: nothing was changed. Run it in a terminal, or add --yes to agree in advance.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`  ${question} [Y/n] `)).trim().toLowerCase();
  prompt.close();
  return answer === "" || answer === "y" || answer === "yes";
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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(DONE_PAGE);
    deliver(url.searchParams.get("code"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const pairing = await post("/api/cli/pair", { host, os: OS, flow: "loopback", code_challenge: challenge, port, state, ...extra }).catch(() => null);
  if (!pairing) { server.close(); fail(`cannot reach ${ORIGIN}.`); }
  if (pairing.status !== 200) { server.close(); fail(pairing.json.error === "rate_limited" ? "too many attempts from this network; wait a minute." : `pairing refused (${pairing.json.error ?? pairing.status}).`); }
  const { device_code: secret, authorize_url: url, user_code: shown, expires_in: lifetime = 600, features = [] } = pairing.json;
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
  if (exchange.json.account) say("    Not your account? Run `npx worktrust disconnect` now and revoke it in WorkTrust.");
  if (extraBound && exchange.json.bound === false) say("  ! WorkTrust did not bind the key to this computer; it works like a key made by hand.");
  return exchange.json.token;
}

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
      return answer.json.token;
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

async function freshKey() {
  const first = keyStore.load();
  if (!first) return null;
  if (!first.pending && Date.now() - Date.parse(first.renewedAt ?? 0) < RENEW_EVERY_MS) return first;
  const settled = await withLock(async () => {
    const value = keyStore.load();
    if (!value) return null;
    if (value.pending) {
      const next = await accepted(value.url, value.pending, value.device);
      if (next === true) { const promoted = { ...value, token: value.pending, renewedAt: new Date().toISOString() }; delete promoted.pending; keyStore.save(promoted); return promoted; }
      if (next === false) { delete value.pending; keyStore.save(value); }
    }
    if (Date.now() - Date.parse(value.renewedAt ?? 0) < RENEW_EVERY_MS) return value;
    const pending = `wt_${randomBytes(32).toString("base64url")}`;
    keyStore.save({ ...value, pending });
    try {
      const renewUrl = `${new URL(value.url).origin}/api/cli/renew`;
      const body = JSON.stringify({ token_hash: createHash("sha256").update(pending).digest("hex"), token_prefix: pending.slice(0, 11) });
      const response = await fetch(renewUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${value.token}`, ...proof(value.device, renewUrl, body) }, body });
      if (response.ok) { const renewed = { ...value, token: pending, renewedAt: new Date().toISOString() }; keyStore.save(renewed); return renewed; }
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
async function bridge() {
  let key = await freshKey();
  const answer = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);
  let session = null;
  let agent = "worktrust-bridge";
  for await (const line of lines({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize" && message.params?.clientInfo?.name) agent = `${message.params.clientInfo.name}/${message.params.clientInfo.version ?? "0"} (worktrust-bridge)`;
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
  const key = await freshKey();
  if (!key) process.exit(0);
  const child = spawn(process.execPath, [join(HOME_DIR, "log-session.mjs"), ...args.filter((arg) => arg !== "hook")], { stdio: "inherit", env: { ...process.env, WORKTRUST_MCP_URL: key.url, WORKTRUST_MCP_TOKEN: key.token, ...(key.device ? { WORKTRUST_DEVICE_KEY: key.device } : {}) } });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function connect() {
  const host = (flag("name") ?? hostname()).replace(/\.local$/i, "").slice(0, 64);
  say();
  say(`  WorkTrust · connect ${host} (${OS_NAME})`);
  say();
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
  say("  Sent to WorkTrust afterwards: durations, token counts, model names, a layer keyword, counts.");
  say("  Never sent: prompts, answers, code, file paths, commit messages.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was written and nothing was sent."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was written and nothing was sent."); return; }

  // The device key: made here, its private half kept with the key, its public half bound at WorkTrust.
  const device = direct ? null : generateKeyPairSync("ed25519");
  const apps = foundApps.map((line) => /^\s*[↻+✓] ([^:]+):/.exec(line)?.[1]).filter(Boolean).slice(0, 12);
  const extra = { apps, ...(device ? { device_key: device.publicKey.export({ format: "jwk" }).x } : {}) };
  const token = useDevice() ? await pairByCode(host, extra) : await pairByBrowser(host, extra);

  say();
  // Out first, then in: an app that already held a WorkTrust key moves to the new one.
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], token, true);
  if (!direct) {
    keyStore.save({ url: MCP, token, renewedAt: new Date().toISOString(), device: device.privateKey.export({ format: "pem", type: "pkcs8" }) });
    ensureHome();
    copyFileSync(fileURLToPath(import.meta.url), STABLE);
    say(`  ✓ Key kept in ${KEY_PLACE}`);
  }
  if ((await run(paths["setup-mcp.mjs"], direct ? ["--write"] : ["--write", "--bridge", STABLE], token)).code !== 0) fail("coupling the AI apps failed; the output above says where.");
  say();
  const hookArgs = ["--install", ...(BUNDLED ? ["--counter", paths["count-behaviour.mjs"]] : []), ...(direct ? [] : ["--via", STABLE])];
  if ((await run(paths["log-session.mjs"], hookArgs, token)).code !== 0) fail("installing the session hook failed; the output above says where.");
  say();
  say("  Done. Quit your AI apps completely and open them again. This computer appears in WorkTrust");
  say("  under Sources → Devices once one of them has spoken.");
}

async function disconnect() {
  say();
  say(`  WorkTrust · disconnect ${hostname().replace(/\.local$/i, "")}`);
  say();
  const paths = await scripts();
  const plan = await run(paths["setup-mcp.mjs"], ["--remove"], PLACEHOLDER, true);
  say("  1. The WorkTrust door comes out of every AI app here:");
  for (const line of planLines(plan.out)) say(line);
  say("  2. The session hook comes out of ~/.claude/settings.json, the key file is deleted, and ~/.worktrust is emptied.");
  say("  3. The key itself stays valid until you revoke it: WorkTrust → Sources → Devices → this computer → Revoke.");
  say();
  if (has("dry-run")) { say("  Dry run: nothing was changed."); return; }
  if (!(await ask("Continue?"))) { say("  Stopped. Nothing was changed."); return; }
  await run(paths["setup-mcp.mjs"], ["--remove", "--write"], PLACEHOLDER);
  await run(paths["log-session.mjs"], ["--uninstall", "--purge"], PLACEHOLDER);
  keyStore.erase();
  // Everything of ours on this computer goes; the folder too, when nothing else is left in it.
  for (const name of [STABLE, ...SCRIPTS.map((script) => join(HOME_DIR, `${script}.download.mjs`)), join(HOME_DIR, "pinned")]) { try { rmSync(name); } catch { /* gone */ } }
  try { rmSync(HOME_DIR, { recursive: false }); } catch { /* not empty, or gone */ }
  say();
  say("  Done. Revoke the key in WorkTrust to finish.");
}

function status() {
  const servers = {};
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    Object.assign(servers, config.mcpServers ?? {});
    for (const project of Object.values(config.projects ?? {})) Object.assign(servers, project.mcpServers ?? {});
  } catch { /* no Claude Code here */ }
  const door = Object.entries(servers).find(([name, server]) => /worktrust/i.test(`${name} ${server?.url ?? ""} ${(server?.args ?? []).join(" ")}`));
  say(door ? `  Claude Code: coupled (${door[1].url ?? "through the local bridge"})` : "  Claude Code: not coupled. Run `npx worktrust connect`.");
  const key = keyStore.load();
  say(key ? `  Key: in ${KEY_PLACE}, ${key.device ? "bound to this computer, " : ""}last renewed ${String(key.renewedAt ?? "").slice(0, 10) || "never"}` : "  Key: not on this computer (or written into the apps' settings with --direct)");
  let hook = false;
  try { hook = /log-session|worktrust\.mjs\\?" hook/.test(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")); } catch { /* none */ }
  say(hook ? "  Session hook: installed" : "  Session hook: not installed");
  say(existsSync(join(HOME_DIR, "pinned")) ? "  Counter: from the package, pinned" : existsSync(join(HOME_DIR, "count-behaviour.mjs")) ? "  Counter: follows the site" : "  Counter: not installed");
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
  say("  worktrust connect      couple again, also when this computer is already coupled");
  say("  worktrust disconnect   take WorkTrust out of every AI app here (asks first)");
  say("  worktrust status       what is coupled here");
}

// THE BARE COMMAND COUPLES (owner, 2026-10-03: "zo kort mogelijk"). `npx worktrust` on a computer
// without a key here shows the plan and asks, exactly as `connect` does; with one it says what is
// coupled, so running it twice never re-pairs by surprise.
if (command === "default") { if (keyStore.load()) { status(); say(); say("  This computer is coupled. `npx worktrust connect` couples it again; `npx worktrust disconnect` takes it out."); } else await connect(); }
else if (command === "mcp") await bridge();
else if (command === "hook") await hook();
else if (command === "connect") await connect();
else if (command === "disconnect") await disconnect();
else if (command === "status") status();
else help();
