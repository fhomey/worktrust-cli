#!/usr/bin/env node
/**
 * THE MOMENT OF THE WORK, RECORDED — a Claude Code hook that logs a finished stretch.
 *
 * The record already holds the commits: 3,760 of them on the first record this was built for,
 * with green CI on a third. What it did not hold was that a person and an agent were there while
 * they were made, so a session carried an artefact change and a validation and no AI interaction
 * — and a work unit needs all three. Nine units on seventeen months of work, and the missing half
 * was not judgement. It was presence.
 *
 * IT NEVER LOSES A MEASURED DAY. A session is reported day by day, on whichever run comes first,
 * so a session that stays open for a fortnight is not a fortnight of silence; a machine that was
 * closed for four months hands over its months when it comes back, through the history door; and
 * a day the network refused is sent again on the next run, because the watermark advances over
 * what was accepted and stops at the first refusal.
 *
 * This hook supplies exactly that half, and nothing else. It NEVER decides how good the work was:
 * scoring calls no model, and a stretch reported here is corroborated by the commit and the CI run
 * that land beside it or it counts for nothing. What it sends is what a clock and a token counter
 * recorded.
 *
 *   node log-session.mjs --install            wire it into Claude Code (SessionEnd, SessionStart, PreCompact)
 *   node log-session.mjs --uninstall [--purge] take it out again (--purge also deletes the copies)
 *   node log-session.mjs --dry-run            show what the current transcripts would send
 *   node log-session.mjs --history [--dry-run] send the months already on this machine, as HISTORY
 *   node log-session.mjs --history --rebuild   the same, re-measured: the door REPLACES this computer's earlier lines, day by day
 *   node log-session.mjs --history --summary   one JSON line: sessions, hours, first and last month, per client (sends nothing)
 *   (as a hook)                                reads the hook's JSON on stdin, logs, exits
 *   (from Codex)                               notify = ["node", "~/.worktrust/log-session.mjs", "--codex-notify"]
 *                                              in ~/.codex/config.toml: Codex calls it at every turn's end and
 *                                              the sweep below finds the thread's rollout; its argument, which
 *                                              carries text, is never read
 *
 * CODEX ROLLOUTS (2026-09-27) are swept beside the Claude Code transcripts: ~/.codex/sessions holds
 * the same clocks, the model per turn and a token record per response, and the reader below turns
 * them into the lines this script already measures. One hook, two clients, one rule for both.
 * ANTIGRAVITY (2026-10-04) the same way: its brain/<id>/.system_generated/logs/transcript.jsonl is swept
 * as a third client (clocks and turns; it records no tokens), woken by its own Stop hook through
 * `worktrust.mjs hook --antigravity-stop`. The readers live in transcript-readers.mjs beside this file.
 *
 * WHAT CANNOT LEAVE. The payload is built from a fixed allowlist of keys, all of them numbers,
 * dates or vocabulary from the door's own enums, and the repository as owner/name and commit hashes. No prompt, no
 * answer, no file path, no commit message, no branch, no folder name. File paths ARE read locally to decide one layer keyword,
 * the way the connector reads them to decide an activity class, and only the keyword travels.
 *
 * WHAT IS MEASURED, AND WHAT IS THEREFORE NOT SENT. A stretch's seconds are the sum of the gaps
 * between consecutive messages in the transcript, each gap counted only up to IDLE_CAP: two
 * recorded timestamps at both ends, and a pause longer than the cap is not work. That is what
 * `duration_basis: "measured"` means and it is the only basis this script ever sends — a stretch
 * whose transcript carries no timestamps is skipped rather than estimated. Tokens are what each
 * request ADDED (input plus cache creation, cache reads excluded), which the door calls
 * `newInput`.
 *
 * CONFIDENTIAL PROJECTS never open: `~/.worktrust-counter.json` { "exclude": ["client-x"] } is
 * honoured here too, matched against the transcript's project directory, before a file is read.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`), value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }, DRY = flag("dry-run");
// Exit once stdout is written: to a pipe it is asynchronous and process.exit drops what is queued (0.6.13 cut --archive-lines).
const exitFlushed = (code) => new Promise((resolve) => process.stdout.write("", resolve)).then(() => process.exit(code));

/**
 * THE OTHER HALF OF A SESSION: HOW IT WAS ASKED.
 *
 * This hook records that somebody was there. What KIND of work it was — the questions asked, the
 * assumptions surfaced, the counter-arguments, the verification requests — is the local counter's
 * job (`count-behaviour.mjs`, a named rubric over the same transcripts), and it was a thing a
 * person had to remember to run. Now the hook runs it, once a day, in STAGING mode: the reading
 * waits in the app until the owner clicks Import. That is not politeness, it is F-04 — the token
 * may stage, only the owner may count — and a hook that could send counts by itself would put an
 * automatic writer on the one surface that describes how a person thinks.
 */
const COUNTER = join(homedir(), ".worktrust", "count-behaviour.mjs");
/** PINNED (2026-10-03): from the npm package, the counter is the package's copy, never refreshed from the network. */
const PINNED = join(homedir(), ".worktrust", "pinned");
/** A hook command is ours when it runs this file, or the `worktrust hook` wrapper that hands it the key from the key file. */
const ours = (command) => /log-session|worktrust\.mjs" hook|worktrust\.mjs hook/.test(String(command ?? ""));
const COUNTER_EVERY_MS = 24 * 3600_000;
/**
 * THE COUNTER KEEPS UP WITH THE DEPLOYMENT. The install fetched it once and never again, so a
 * machine set up in August counted with an August rubric in September while the door already
 * spoke a newer vocabulary. Now the version stamped in the local copy is compared with the one the
 * deployment serves — numerically, the way the door picks its newest rubric — and a newer copy
 * replaces the old one. A rubric bump is what makes the previous reading superseded on the
 * mirror; this is how the machine hears about it. Nothing else is read off the network here.
 */
const versionOf = (text) => /export const ANALYZER_VERSION = "counter@(\d+)\.(\d+)\.(\d+)"/.exec(text ?? "")?.slice(1, 4).map(Number) ?? null;
const newer = (a, b) => { if (!a || !b) return false; for (let i = 0; i < 3; i += 1) { if (a[i] === b[i]) continue; return a[i] > b[i]; } return false; };
async function refreshCounter(origin, announce) {
  if (!origin || !existsSync(COUNTER) || existsSync(PINNED)) return false;
  try {
    const response = await fetch(`${origin}/counter/count-behaviour.mjs`);
    if (!response.ok) return false;
    const remote = await response.text();
    const have = versionOf(readFileSync(COUNTER, "utf8")), theirs = versionOf(remote);
    if (!newer(theirs, have)) return false;
    writeFileSync(COUNTER, remote);
    await installReaders(origin, true);
    announce?.(`counter: updated to counter@${theirs.join(".")} (was counter@${have?.join(".") ?? "?"}) — the next reading counts under the new rubric`);
    return true;
  } catch { return false; }
}

/** A pause longer than this is not work, so it is not counted. Five minutes. */
const IDLE_CAP = 300;
/**
 * The live door refuses a stretch older than two days, because it records work AS IT HAPPENS —
 * that rule is what stops a year of invented afternoons walking in through the same door.
 *
 * It is not a reason to lose the work. Past this line a measured day is filed through
 * `import_history` instead: the same counted seconds, marked as history, standing as history
 * stands (it corroborates, and it never lifts a level on its own). Late is not the same as untrue.
 */
const WINDOW_HOURS = 48;
/** A stretch still being worked in is not finished; half an hour of quiet says it is. */
const IDLE_BEFORE_SWEEP = 30 * 60 * 1000;
/** Under a minute is not a piece of work. */
const MIN_SECONDS = 60;
/**
 * The door's own ceiling for one stretch. A day past it is reported SHORT: under-reporting is the
 * safe direction. Stretches are split by DAY, which is a boundary the clock draws — never by
 * guessing where one piece of work ended and the next began.
 */
const MAX_SECONDS = 28800;
/** The door's ceilings for the layers (a day) and for a day's subagents: the same bounds its columns check. */
const DAY_SECONDS = 86400;
/** A tool gap is tool time up to thirty minutes (proposed, owner 2026-10-06); past that it is a wait, counted as idle. */
const TOOL_CAP = 1800;
/** Tools whose result waits for the person: the gap to it is the person's time. Names only; nothing of the call is read. */
const WAITS_FOR_PERSON = new Set(["AskUserQuestion", "ExitPlanMode"]);
/** The derived record of a stretch, kept for the local archive only (see payloadFor). */
const DERIVED = new WeakMap();
const AGENT_RUNS_MAX = 10000, AGENT_SECONDS_MAX = 2592000;

/**
 * WHEN THE HOOK RUNS. SessionEnd alone was a bet that sessions end, and a session that stays open
 * for a fortnight — resumed through every compaction — reported nothing for a fortnight. These
 * three are the moments Claude Code offers that come round on their own: a session closing, a
 * session opening, and a compaction, which on a long session happens several times a day.
 *
 * Running more often costs nothing extra: the watermark means a run with nothing new to say opens
 * no file, and a day still being worked in is never sent twice.
 */
const HOOK_EVENTS = ["SessionEnd", "SessionStart", "PreCompact"];

const STATE = join(homedir(), ".worktrust", "sessions.json");
const readState = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }, writeState = (state) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 1)); };
/**
 * THE FLOORS (owner, 2026-10-04: "history is never sent silently"). `__from` is the moment this
 * computer was coupled: the hook sends nothing measured before it, so a fresh coupling (or one after
 * `disconnect` purged the watermarks) never sweeps the computer's past into the record unasked. That
 * past is offered once, by `npx worktrust`, and goes only on a yes. `__historyFloor` is set when the
 * computer changed ACCOUNT: even that offer then starts at the change, so one person's earlier work
 * is never offered to the next account.
 */
const floorOf = (state, key) => { const at = typeof state?.[key] === "string" ? Date.parse(state[key]) : NaN; return Number.isFinite(at) ? at : null; };

/**
 * ONLY THE HOUSE'S OWN DOOR (2026-09-27, audit): the coupling used to be "any MCP server whose URL
 * contains /api/mcp", the conventional path of every hosted MCP server, so a person who also held
 * another product's server would have sent their work metadata there under that product's token and
 * fetched a script to run from its origin. A door is WorkTrust's when its host is worktrust.io or a
 * subdomain, or a local one named by WORKTRUST_MCP_URL; nothing else is a coupling.
 */
const isWorkTrustDoor = (url) => {
  try {
    const parsed = new URL(String(url));
    if (!/\/api\/mcp\/?$/.test(parsed.pathname)) return false;
    const own = process.env.WORKTRUST_MCP_URL ? new URL(process.env.WORKTRUST_MCP_URL).host : null;
    return parsed.protocol === "https:" && (parsed.hostname === "worktrust.io" || parsed.hostname.endsWith(".worktrust.io")) || (own !== null && parsed.host === own) || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch { return false; }
};
/** The coupling: given, or the one Claude Code already holds — the same read the counter does. */
function coupling() {
  const url = value("url") ?? process.env.WORKTRUST_MCP_URL;
  const token = value("token") ?? process.env.WORKTRUST_MCP_TOKEN;
  if (url && token) return { url, token };
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.url === "string" && isWorkTrustDoor(node.url)) {
        const auth = node.headers?.Authorization ?? node.headers?.authorization ?? "";
        if (auth.startsWith("Bearer ")) found.push({ url: node.url, token: auth.slice(7) });
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(config);
    if (found[0]) return found[0];
  } catch { /* no Claude Code config on this machine; Codex may hold the coupling */ }
  return codexCoupling();
}

const excludes = (() => {
  try { return (JSON.parse(readFileSync(join(homedir(), ".worktrust-counter.json"), "utf8")).exclude ?? []).map(String); } catch { return []; }
})();
const excluded = (path) => excludes.some((text) => text && path.includes(text));
/**
 * THE READERS live beside this file: Codex and Antigravity in transcript-readers.mjs (the counter imports it too, one
 * reader), the database clients in session-databases.mjs. The install copies both into ~/.worktrust with this hook.
 * Without them this hook still reads Claude Code; the never-matching patterns keep every other client out.
 */
const { CODEX_ROLLOUT = /(?!)/, codexIdOf = (file) => String(file).split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""), antigravityIdOf = (file) => String(file).split(/[\\/]/).at(-4), codexLines, codexRolloutFiles = function* () {}, codexCwd = () => null, ANTIGRAVITY_TRANSCRIPT = /(?!)/, antigravityLines, antigravityRoots = () => [], antigravityTranscripts = function* () {}, antigravityContext = () => ({}), rememberAntigravity = () => null } = (await import("./transcript-readers.mjs").catch(() => null)) ?? {};
// THE STRETCH'S DERIVED RECORD (0.7.4: split from this file): tool calls named by kind, verification, recovery, delegation,
// context and routing, for the local archive only. A copy without the module still measures and sends exactly as before.
const { callOf = (block) => ({ id: block.id, kinds: [], family: String(block.name), digest: "" }), deriveStretch = () => ({}), complexityOf = null } = (await import("./stretch-evidence.mjs").catch(() => null)) ?? {};
const { DATABASE_SESSION = /(?!)/, databaseLines = () => null, databaseSessions = function* () {} } = (await import("./session-databases.mjs").catch(() => null)) ?? {};
const DATABASE_CLIENTS = ["hermes", "goose", "opencode", "openclaw", "cursor", "copilot"]; // the registry's keys, the name each line carries
const LIVE_SOURCE = new RegExp(`^(codex|antigravity|${DATABASE_CLIENTS.join("|")}):`); // a sweep entry's id → the client it names (every database client, 0.6.16)
const READER_FILES = ["transcript-readers.mjs", "session-databases.mjs", "stretch-evidence.mjs"]; // 0.7.4: the derived record travels with the hook
/** The readers go where the hook and the counter run: copied from beside this file, else (or for a newer counter) from the deployment. */
async function installReaders(origin, fromNetwork = false) {
  let installed = true;
  for (const name of READER_FILES) { // Hermes, Goose, OpenCode and OpenClaw are read by session-databases.mjs
    const here = join(dirname(fileURLToPath(import.meta.url)), name), home = join(homedir(), ".worktrust", name);
    try {
      if (!fromNetwork && existsSync(here)) { mkdirSync(dirname(home), { recursive: true }); if (here !== home) copyFileSync(here, home); continue; }
      const response = origin ? await fetch(`${origin}/counter/${name}`) : null;
      if (response?.ok) writeFileSync(home, await response.text()); else installed = false;
    } catch { installed = false; }
  }
  return installed;
}

/** The roots this machine's transcripts live under; a test names its own. */
const claudeRoot = () => value("transcript-root") ?? join(homedir(), ".claude", "projects");
const codexRoot = () => { const given = value("codex-root"); if (given) return given.replace(/^~(?=\/|$)/, homedir()); return value("transcript-root") ? null : join(homedir(), ".codex", "sessions"); };
/** Every Codex rollout and Antigravity conversation on this machine, an excluded project's threads skipped by their working directory. */
function* codexRollouts() {
  const root = codexRoot();
  for (const file of root ? codexRolloutFiles(root) : []) {
    const cwd = codexCwd(file);
    if (cwd && excluded(cwd)) continue;
    yield { id: `codex:${codexIdOf(file)}`, file };
  }
  yield* antigravityConversations();
  yield* databaseConversations();
}
/** The attended sessions of the clients that keep a database (session-databases.mjs); an excluded folder skipped. */
function* databaseConversations() {
  const given = Object.fromEntries(DATABASE_CLIENTS.map((client) => [client, value(`${client}-root`)]).filter(([, root]) => root));
  for (const { client, sessionId, file, cwd, writtenAt } of databaseSessions(given, Boolean(value("transcript-root")))) {
    if (!(cwd && excluded(cwd))) yield { id: `${client}:${sessionId}`, file, writtenAt };
  }
}
/** Antigravity beside Codex: one transcript per conversation, its folder known only from the Stop hook. */
function* antigravityConversations() {
  const given = value("antigravity-root");
  for (const { conversationId, file } of antigravityTranscripts(given || !value("transcript-root") ? antigravityRoots(given) : [])) {
    const { cwd } = antigravityContext(conversationId);
    if (!(cwd && excluded(cwd))) yield { id: `antigravity:${conversationId}`, file };
  }
}
/** A transcript's lines as objects, whichever client wrote it; null when the file cannot be read. */
const parsedLines = (file) => {
  if (DATABASE_SESSION.test(file)) return databaseLines(file);
  let lines; try { lines = readFileSync(file, "utf8").split("\n"); } catch { return null; }
  if (CODEX_ROLLOUT.test(file)) return [...codexLines(lines)];
  if (ANTIGRAVITY_TRANSCRIPT.test(file)) { const id = antigravityIdOf(file); return [...antigravityLines(lines, { id, ...antigravityContext(id) })]; }
  const out = [];
  for (const raw of lines) { if (!raw.trim()) continue; try { out.push(JSON.parse(raw)); } catch { /* a torn line */ } }
  return out;
};
/** The coupling Codex holds, when Claude Code holds none: the same door, read from ~/.codex/config.toml. */
function codexCoupling() {
  let toml; try { toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"); } catch { return null; }
  for (const block of toml.split(/\n(?=\[)/)) {
    if (!/^\[mcp_servers\./.test(block)) continue;
    const url = /^\s*url\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const token = /Bearer\s+([A-Za-z0-9_.-]+)/.exec(block)?.[1];
    if (url && isWorkTrustDoor(url) && token) return { url, token };
  }
  return null;
}

/** Which layer a set of paths touched — the same plain reading the connector uses for classes. */
const LAYER_RULES = [
  ["database", /(^|\/)migrations?\/|\.sql$|(^|\/)(schema|seed)s?\.(prisma|sql|ts|rb)$/i],
  ["integration", /(^|\/)(integrations?|connectors?|webhooks?|clients?|sdk)\/|\.(proto|graphql|gql)$|(^|\/)openapi\.(yaml|yml|json)$/i],
  ["tooling", /(^|\/)\.github\/|(^|\/)(infra|terraform|k8s|helm|deploy|scripts?)\/|\.(tf|tfvars)$|(^|\/)(Dockerfile|docker-compose[^/]*|Makefile)$|(^|\/)\.claude\//i],
  ["frontend", /\.(css|scss|less|html|vue|svelte|astro|jsx|tsx)$/i],
  ["backend", /\.(py|go|rs|java|kt|rb|php|cs|ex|exs|swift|c|cc|cpp|h|hpp)$|(^|\/)(api|server|lib)\//i],
  ["docs", /\.(md|mdx|rst|adoc)$|(^|\/)docs?\//i],
];
const layersOf = (paths) => {
  const tally = new Map();
  for (const path of paths) for (const [layer, rule] of LAYER_RULES) if (rule.test(path)) { tally.set(layer, (tally.get(layer) ?? 0) + 1); break; }
  // MOST FILES FIRST, BUT ALL OF THEM. One stretch through the front end, the back end and the
  // docs is one piece of work with one duration and three layers; reporting only the winner threw
  // two thirds of what it touched away, and a layer is what a dimension is attributed by.
  const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([layer]) => layer);
  return { layer: ordered[0] ?? null, layers: ordered };
};

const git = (cwd, ...argv) => { try { return execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
/** owner/name from any remote shape, or null. Nothing else of the remote is read. */
const repoOf = (cwd) => {
  const remote = git(cwd, "remote", "get-url", "origin");
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : null;
};
/** The paths this stretch touched: what was committed inside it, else what is still uncommitted. */
const pathsTouched = (cwd, from, to) => {
  const committed = git(cwd, "log", `--since=${from}`, `--until=${to}`, "--name-only", "--pretty=format:", "--no-merges");
  const paths = committed.split("\n").map((line) => line.trim()).filter(Boolean);
  // The commits themselves, as shas — a hash and nothing of the message. They let the record
  // join this stretch to its own artefacts (roadmap R8); the paths above never travel.
  const shas = git(cwd, "log", `--since=${from}`, `--until=${to}`, "--format=%H", "--no-merges").split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{40}$/.test(line));
  if (paths.length > 0) return { paths, committed: true, shas };
  const dirty = git(cwd, "status", "--porcelain").split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
  return { paths: dirty, committed: false, shas };
};

/**
 * One transcript → the unlogged stretches, measured, ONE PER DAY.
 *
 * It used to return a single stretch covering everything since the watermark, which was right for
 * a session that lasts an afternoon and wrong in three ways for one that lasts a fortnight: the
 * whole fortnight arrived as one record dated at its end, it was truncated at the door's
 * per-stretch ceiling, and none of it existed until the session finally closed. A day is the
 * boundary the history path already uses, it needs no guess about where one piece of work ended,
 * and it is the unit the record reads back anyway.
 */
function stretchesOf(file, since) {
  // A file we cannot read is no days, never a null the caller has to remember to check: this
  // returns a list now, and one caller forgetting that is one silent crash inside a hook.
  const lines = parsedLines(file);
  if (!lines) return [];
  const messages = [];
  let cwd = null, steered = STEERED_HERE;
  for (const line of lines) {
    if (typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.steered === "string") steered = line.steered; // a client that says how it was steered (Hermes's source)
    if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
    const at = Date.parse(line.timestamp);
    if (!Number.isFinite(at)) continue;
    if (since && at <= since) continue;
    messages.push(messageOf(line, at));
  }
  if (messages.length === 0) return [];
  messages.sort((a, b) => a.at - b.at);
  const byDay = byDayOf(messages);
  const agents = agentsByDay(file, since);
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ofDay]) => { const stretch = measure(cwd, ofDay); return stretch && { ...stretch, ref: stretchRef(file, day), steered, agents: agents.get(day) ?? null }; }).filter(Boolean);
}

/**
 * DAYS SPLIT ON THE CLOCK, NOTHING LOST AT MIDNIGHT (0.6.18, audit C14). A stretch is one session's UTC day, and the gap
 * between a day's last message and the next day's first belonged to neither, so a run through the night lost one gap
 * per midnight. A day whose first message follows the last one within the tool cap now opens with a BRIDGE: the message
 * before it, carrying no tokens, no model and no turn, so the gap that crosses midnight is counted once, on the day it
 * ends, under the same caps as any other.
 * Messages must arrive sorted.
 */
function byDayOf(messages) {
  const byDay = new Map();
  let prev = null;
  for (const message of messages) {
    const day = new Date(message.at).toISOString().slice(0, 10);
    // Only a gap the work could have run through (within the tool cap): a session resumed the next morning opens its day as it always did.
    if (!byDay.has(day)) byDay.set(day, prev && message.at - prev.at <= TOOL_CAP * 1000 ? [{ ...prev, usage: null, model: null, cumulative: false, bridge: true }] : []);
    byDay.get(day).push(message);
    prev = message;
  }
  return byDay;
}
/** The first message a day really holds (a bridge is the day before's). */
const firstOf = (messages) => (messages.find((message) => !message.bridge) ?? messages[0]).at;
/** The computer's offset from UTC at a moment, as +02:00: what the owner's mirror needs to read a working day in local time. */
const offsetAt = (ms) => { const minutes = -new Date(ms).getTimezoneOffset(), abs = Math.abs(minutes); return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`; };
/** Claude Code's own line when the person stops the agent mid-answer (Esc), read for its marker only. */
const INTERRUPTED = /^\[Request interrupted by user/;
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("") : "");

/** One transcript line as the measure reads it: the clock, the role, what KIND of message it is (for the layers), its counts. */
const messageOf = (line, at) => {
  const content = line.message?.content ?? null;
  const blocks = Array.isArray(content) ? content : [];
  return {
    // A COMPACTION'S SUMMARY IS NOT THE PERSON (0.7.4): Claude Code writes it on the user role; the counter always left it
    // out, the hook counted it as a turn and the gap before it as the person's time. It is the loop's own, like a meta line.
    at, type: line.type, usage: line.message?.usage ?? null, model: line.message?.model ?? null, messageId: typeof line.message?.id === "string" ? line.message.id : null, meta: line.isMeta === true || line.isCompactSummary === true, content,
    compacted: line.isCompactSummary === true,
    // A tool's answer comes back on the user role; a line a reader marks `agentic` is an agent run (Copilot's asked → completed).
    kind: line.type === "assistant" ? "assistant" : blocks.some((block) => block && block.type === "tool_result") ? "tool_result" : "user",
    toolUse: line.type === "assistant" && blocks.some((block) => block && block.type === "tool_use"),
    // A tool that waits for the PERSON (a question, a plan to approve): the gap to its result is the person's, not the tool's. The name is read, never the input.
    waitsForPerson: line.type === "assistant" && blocks.some((block) => block && block.type === "tool_use" && WAITS_FOR_PERSON.has(String(block.name))),
    agentic: line.agentic === true, cumulative: line.cumulative === true, // the session's running totals (Hermes, Goose without a ledger)
    // 0.7.1: each tool call's kinds (never its command) and each tool result's outcome, joined on the call's id in `measure`.
    // 0.7.2: and the call's FAMILY (the tool, and its check kinds) and a digest of its input, compared here and never kept.
    calls: line.type === "assistant" ? blocks.filter((block) => block && block.type === "tool_use" && typeof block.id === "string").map(callOf) : [],
    results: blocks.filter((block) => block && block.type === "tool_result" && typeof block.tool_use_id === "string").map((block) => ({ id: block.tool_use_id, failed: block.is_error === true })),
  };
};

/**
 * SUBAGENTS AS AGENT TIME, NEVER AS HOURS (owner, 2026-10-06). Claude Code writes each subagent's transcript beside its
 * session (`<session>/subagents/*.jsonl`: 279 of them beside 48 sessions on the computer this was built on), and the
 * sweep read only the sessions, so delegated work was invisible. Now each run is read for its clocks and sent as
 * METADATA beside the parent's day: how many runs started that day, their own measured seconds (the same gap rule, the
 * same cap), and how many were open at once at the busiest moment. None of it enters `seconds`: four agents working an
 * hour are four agent-hours and one hour of the person's, and the record says which is which. Only Claude Code keeps
 * subagents this way; every other client answers an empty map.
 */
function subagentFiles(file) {
  if (!/\.jsonl$/.test(String(file)) || CODEX_ROLLOUT.test(file) || ANTIGRAVITY_TRANSCRIPT.test(file) || DATABASE_SESSION.test(file)) return [];
  const dir = join(String(file).replace(/\.jsonl$/, ""), "subagents");
  try { return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)); } catch { return []; }
}
function agentsByDay(file, since) {
  const byDay = new Map();
  for (const sub of subagentFiles(file)) {
    const lines = parsedLines(sub);
    if (!lines) continue;
    const stamps = [];
    let started = Infinity;
    for (const line of lines) {
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) continue;
      started = Math.min(started, at);
      if (!(since && at <= since)) stamps.push(at);
    }
    // A RUN IS COUNTED ONCE, on the side of the watermark where it STARTED (review, 2026-10-06): a run that straddles the
    // watermark was sent with the day it began and is not a second run on the next sweep; what it did after the
    // watermark stays unsent, which is the safe direction.
    if (stamps.length === 0 || (since && started <= since)) continue;
    stamps.sort((a, b) => a - b);
    // A run is counted on the day it started; its seconds go with it, the same rule as the parent's.
    const day = new Date(stamps[0]).toISOString().slice(0, 10);
    let seconds = 0;
    for (let i = 1; i < stamps.length; i += 1) seconds += Math.min(IDLE_CAP, Math.round((stamps[i] - stamps[i - 1]) / 1000));
    if (!byDay.has(day)) byDay.set(day, { runs: 0, seconds: 0, spans: [] });
    const entry = byDay.get(day);
    entry.runs += 1; entry.seconds += seconds; entry.spans.push([stamps[0], stamps[stamps.length - 1]]);
  }
  for (const entry of byDay.values()) entry.peak = peakOf(entry.spans);
  return byDay;
}
/** The most spans open at one instant; a span that ends where another starts does not overlap it. */
const peakOf = (spans) => {
  const events = spans.flatMap(([from, to]) => [[from, 1], [to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, peak = 0;
  for (const [, delta] of events) { open += delta; peak = Math.max(peak, open); }
  return peak;
};

/**
 * IS THIS A HUMAN TURN? (2026-09-20)
 *
 * It used to be "every user-role message that is not meta", and in agentic work that is
 * overwhelmingly the AGENT's own tool results coming back — they arrive on the user role, because
 * that is how the protocol carries them. Measured on one real session: 959 counted, 910 of them
 * tool results, 49 actual prompts. A 19.6x inflation, and it grows with how autonomous the work is,
 * so the number moved the WRONG WAY exactly where it mattered: more agent loop read as more human
 * turns. The door's own field description has always said "one turn is one message from the
 * person"; this makes the hook agree with it.
 *
 * A human turn carries text (a string, or blocks with `text`/`image`) and NO `tool_result` block.
 * A message carrying both is a tool result with commentary attached, which is still the loop.
 */
function isHumanTurn(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const types = new Set(content.map((block) => block && block.type));
  if (types.has("tool_result")) return false;
  return types.has("text") || types.has("image");
}

/** One day's messages → the stretch, measured. Null when there is nothing honest to send. */
function measure(cwd, messages) {
  // MEASURED, AND ONLY MEASURED: every second counted lies between two recorded timestamps, and a
  // gap longer than the cap is a pause rather than work. No stretch is ever inferred from a count.
  let seconds = 0;
  for (let i = 1; i < messages.length; i += 1) seconds += Math.min(IDLE_CAP, Math.round((messages[i].at - messages[i - 1].at) / 1000));
  // A DURATION MAY BE ABSENT; THE STRETCH MAY NOT. What corroborates a commit is that a person and
  // an agent were there at that moment, not how long they stayed — so a stretch too short to time,
  // or one whose clocks give nothing, is still reported, WITHOUT seconds and without a basis. The
  // alternative is a hook that goes quiet exactly where the record is thinnest, or one that fills
  // the gap with a guess: the same fabrication in a smaller jacket.
  const measured = seconds >= MIN_SECONDS ? Math.min(MAX_SECONDS, seconds) : null;
  const models = new Map();
  let exchanges = 0;
  for (const message of messages) {
    if (message.type === "user" && !message.meta && !message.bridge && isHumanTurn(message.content)) exchanges += 1;
    if (message.model) models.set(message.model, (models.get(message.model) ?? 0) + 1);
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tokens = tokensOf(messages);
  // HOW THE PERSON STEERED (owner, 2026-10-08): how often they stopped the agent (Claude Code's interruption line), and how
  // often their next turn arrived while the agent was still mid-task (right after a tool call or its result). Counts only.
  let interrupts = 0, steers = 0;
  for (let i = 1; i < messages.length; i += 1) {
    const message = messages[i], prev = messages[i - 1];
    if (message.bridge || message.type !== "user" || message.meta || message.kind === "tool_result") continue;
    if (INTERRUPTED.test(textOf(message.content).trim())) interrupts += 1;
    else if (isHumanTurn(message.content) && (prev.kind === "tool_result" || prev.toolUse)) steers += 1;
  }
  const from = firstOf(messages);
  return { cwd, seconds: measured, derived: deriveStretch(messages, { isHumanTurn, INTERRUPTED, textOf }), layers: measured !== null ? timeLayers(messages) : null, ...tokens, cumulative: messages.some((message) => message.cumulative), exchanges, interrupts, steers, model, from, to: messages[messages.length - 1].at, offset: offsetAt(from) };
}

/**
 * HOW THE SECONDS WERE SPENT (owner, 2026-10-06: "observed time → AI active → agent-directed → verified work activity").
 * `seconds` keeps its exact meaning above; this reads the same gaps a second time and says what each one WAS, by the
 * message that ends it: the model's message (model time, capped as before), a tool's result or an agent run (tool time,
 * NOT capped at five minutes, because a test suite that ran twenty minutes was twenty minutes of the agent's work; bounded
 * by the stretch's own ceiling), or the person's next turn (human time, capped). What a cap cut off is idle, counted as
 * idle and never as work. The four sum to the stretch's span, so nothing is hidden and nothing is double-counted.
 */
function timeLayers(messages) {
  const split = { model: 0, tool: 0, human: 0, idle: 0 };
  for (let i = 1; i < messages.length; i += 1) {
    const gap = Math.max(0, Math.round((messages[i].at - messages[i - 1].at) / 1000));
    const next = messages[i], prev = messages[i - 1];
    // WAITS FOR THE PERSON ARE NOT TOOL TIME (review, 2026-10-06). A tool's result arrives when the tool is done, or when the
    // person answered a question, approved a plan, or sat on a permission prompt. The first two are named by the tool and
    // counted as human time; the third is invisible in the transcript, so a tool gap is counted as tool time only up to
    // TOOL_CAP, and the rest as idle: a tool runs minutes, a person away from the keyboard does not.
    const tool = (next.kind === "tool_result" || next.agentic || (prev.toolUse && next.kind === "assistant")) && !prev.waitsForPerson;
    // ONE DEFINITION OF A HUMAN TURN (review, 2026-10-06): the same `isHumanTurn` that counts `exchanges`; a user line that
    // is not one (a meta line the client injected, a textless line) is the loop's own and counts as model time.
    const human = !tool && ((prev.waitsForPerson && next.kind === "tool_result") || (next.kind === "user" && !next.meta && isHumanTurn(next.content)));
    const counted = Math.min(tool ? TOOL_CAP : IDLE_CAP, gap);
    split[tool ? "tool" : human ? "human" : "model"] += counted;
    split.idle += gap - counted;
  }
  return split;
}

/**
 * THE TOKENS, AND THE CACHE HALVES APART (roadmap 16). Claude Code's usage block carries input_tokens, output_tokens,
 * cache_creation_input_tokens and cache_read_input_tokens. `tokensIn` stays what it was — new input plus what was written
 * into the cache (the `newInput` basis) — and the two cache halves travel beside it as their own counts, so the mirror can
 * read a hit ratio. A usage block of a SHAPE this script does not know (a key that is present and not a number, or a block
 * without input and output) means the parser is behind the client: the stretch is then sent WITHOUT tokens — never with a
 * guess, the same rule as an untimed stretch. `shapeKnown` says which happened.
 */
const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
function usageShapeKnown(usage) {
  if (!usage || typeof usage !== "object") return false;
  if (!("input_tokens" in usage) && !("output_tokens" in usage)) return false;
  return USAGE_KEYS.every((key) => !(key in usage) || usage[key] === null || (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0));
}
function tokensOf(messages) {
  let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheWrite = 0, counted = 0, shapeKnown = true;
  // ONE ANSWER, ONE USAGE (0.6.18): Claude Code writes an answer as a line per content block (thinking, text, each tool
  // call), every one repeating the answer's usage; summed per line, a real session read 2.6 times its output tokens. An
  // answer with an id is counted once; a line without one (Codex's token events) is its own.
  const seen = new Set();
  for (const message of messages) {
    const usage = message.usage;
    if (!usage) continue;
    if (message.messageId) { if (seen.has(message.messageId)) continue; seen.add(message.messageId); }
    if (!usageShapeKnown(usage)) { shapeKnown = false; break; }
    counted += 1;
    tokensIn += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    tokensOut += usage.output_tokens ?? 0;
    cacheRead += usage.cache_read_input_tokens ?? 0;
    cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }
  if (!shapeKnown) return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, shapeKnown: false };
  return { tokensIn, tokensOut, cacheRead, cacheWrite, shapeKnown: counted > 0 };
}
// A SESSION'S TOTALS ARE SENT ONCE (0.6.16, audit H2). Hermes, and Goose without its ledger, keep tokens per SESSION on its last answer, so a resumed
// session sent its whole total again. Such a stretch sends what the total grew by since the one reported (kept beside the watermark), never a negative.
const TOTALS = ["tokensIn", "tokensOut", "cacheRead", "cacheWrite"];
const grownBy = (stretch, reported) => { if (!stretch.cumulative || !stretch.shapeKnown) return reported; const total = Object.fromEntries(TOTALS.map((key) => [key, Math.max(stretch[key], reported?.[key] ?? 0)]));
  for (const key of TOTALS) stretch[key] = Math.max(0, stretch[key] - (reported?.[key] ?? 0)); return total; }; // the total to keep; a fresh session sends its total, as before

// WHICH STRETCH, HOW STEERED (0.6.10): a hash of the session id (the file name; Antigravity's, always transcript.jsonl, its conversation's folder) and the day,
// the same on any computer, so a restored backup is never counted twice; `remote` only when the session runs over SSH, otherwise nothing is said.
const stretchRef = (file, day) => createHash("sha256").update(`worktrust-stretch|${ANTIGRAVITY_TRANSCRIPT.test(file) ? antigravityIdOf(file) : String(file).split(/[\\/]/).pop().replace(/\.jsonl?$/, "")}|${day}`).digest("base64url");
const STEERED_HERE = process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY ? "remote" : null;

/** The one payload shape this script can build. Every key is a number, a date or an enum value. */
function payloadFor(stretch) {
  const cwd = stretch.cwd && existsSync(stretch.cwd) ? stretch.cwd : null;
  const repo = cwd ? repoOf(cwd) : null;
  const touched = cwd ? pathsTouched(cwd, new Date(stretch.from).toISOString(), new Date(stretch.to).toISOString()) : { paths: [], committed: false, shas: [] };
  const { layer, layers } = layersOf(touched.paths);
  // The seventh kind, used as it is defined: a stretch that changed no artefact is knowing
  // something, not building something, and it earns neither an artefact's nor a validation's credit.
  const kind = touched.paths.length === 0 ? "researched" : touched.committed ? "changed" : "built";
  const payload = {
    title: layer ? `AI-assisted work · ${layer}` : "AI-assisted work",
    kind,
    ...(layer ? { layer } : {}),
    ...(layers.length > 1 ? { layers } : {}),
    // Both, or neither: seconds without a basis is exactly the ambiguity the record is trying to
    // lose, and a basis without seconds says nothing.
    ...(stretch.seconds !== null ? { seconds: stretch.seconds, duration_basis: "measured" } : {}),
    // Tokens only when the usage block's shape is the one this script knows — otherwise nothing, never a guess.
    ...(stretch.shapeKnown && stretch.tokensIn + stretch.tokensOut > 0 ? { tokens_in: stretch.tokensIn, tokens_out: stretch.tokensOut, token_basis: "newInput" } : {}),
    // The turns are the person's own messages, tool results excluded — said explicitly, because a
    // row that does not say reads as the old count, which included them.
    ...(stretch.exchanges > 0 ? { turn_basis: "humanOnly" } : {}),
    // The cache halves, as counts, beside the tokens (roadmap 16): read from a cache, written into one.
    ...(stretch.shapeKnown && stretch.cacheRead > 0 ? { tokens_cache_read: stretch.cacheRead } : {}),
    ...(stretch.shapeKnown && stretch.cacheWrite > 0 ? { tokens_cache_write: stretch.cacheWrite } : {}),
    ...(stretch.exchanges > 0 ? { exchanges: stretch.exchanges } : {}),
    ...(stretch.model ? { model: stretch.model } : {}),
    ...(repo ? { repo } : {}),
    ...(touched.shas.length > 0 ? { commits: touched.shas.slice(0, 50) } : {}),
    ...(stretch.ref ? { stretch_ref: stretch.ref } : {}), ...(stretch.steered ? { steered_from: stretch.steered } : {}),
    // THE LAYERS (2026-10-06), only on a measured stretch, each bounded by a day: what the seconds were. `seconds` above is untouched.
    ...(stretch.seconds !== null && stretch.layers ? { model_seconds: Math.min(DAY_SECONDS, stretch.layers.model), tool_seconds: Math.min(DAY_SECONDS, stretch.layers.tool), human_seconds: Math.min(DAY_SECONDS, stretch.layers.human), idle_seconds: Math.min(DAY_SECONDS, stretch.layers.idle) } : {}),
    // THE SUBAGENTS, as agent metadata beside the day: runs, their own seconds, the peak open at once. Never in `seconds`.
    // WHEN AND HOW (0.6.18): the stretch's first moment and the computer's UTC offset then; the person's interruptions and mid-task turns, counts only.
    started_at: new Date(stretch.from).toISOString(), utc_offset: stretch.offset,
    ...(stretch.interrupts > 0 ? { interrupts: Math.min(10000, stretch.interrupts) } : {}),
    ...(stretch.steers > 0 ? { steers: Math.min(10000, stretch.steers) } : {}),
    ...(stretch.agents && stretch.agents.runs > 0 ? { agent_runs: Math.min(AGENT_RUNS_MAX, stretch.agents.runs), agent_seconds: Math.min(AGENT_SECONDS_MAX, stretch.agents.seconds), agent_peak: Math.min(AGENT_RUNS_MAX, stretch.agents.peak) } : {}),
    at: new Date(stretch.to).toISOString(),
  };
  // WHAT STAYS ON THIS COMPUTER (0.7.1): the stretch's derived record rides beside the payload for the local archive, never in it.
  // 0.7.6: and the stretch's complexity class, read from what the hook knows here (layers, subagents, duration) and the record.
  if (stretch.derived) DERIVED.set(payload, { ...stretch.derived, ...(complexityOf ? { complexity: complexityOf(stretch.derived, { layers: Math.max(layers.length, layer ? 1 : 0), agentRuns: stretch.agents?.runs ?? 0, agentPeak: stretch.agents?.peak ?? 0, seconds: stretch.seconds }) } : {}) });
  return payload;
}

/**
 * The history door, in the batch size it asks for. Oldest first, and a resend is safe: every entry
 * is deduplicated on its content, and one that knows more than a stored line FILLS it rather than
 * adding a twin. Returns how many entries were accepted, so a caller can advance a watermark over
 * exactly what landed. `announce` because one caller is a person watching a terminal and the other
 * is a hook holding a session's exit open.
 */
async function sendHistory(door, entries, announce = false, rebuild = false) {
  let accepted = 0;
  // A Codex entry goes through Codex's own coupling where one exists (see codexDoor), the rest
  // through the door given: the record files a line under the coupling that sent it. Antigravity's
  // go apart too, so their batch can name the client (clientOf).
  for (const [source, group] of [["claude", entries.filter((entry) => !entrySource.has(entry))], ["codex", entries.filter((entry) => entrySource.get(entry) === "codex")], ...["antigravity", ...DATABASE_CLIENTS].map((client) => [client, entries.filter((entry) => entrySource.get(entry) === client)])]) {
  const target = source === "codex" ? codexDoor ?? door : door;
  if (group.length === 0 || !target) continue;
  for (let i = 0; i < group.length; i += 200) {
    const batch = group.slice(i, i + 200);
    // History carries no shas: an imported line forms no session, and the join is the live route's. REBUILD (owner, 2026-10-07): `rebuild: true`
    // tells the door to replace this computer's earlier lines on the days and for the client the batch carries, and every group names its client.
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { ...(rebuild ? { rebuild: true } : {}), entries: batch.map((entry) => { const { commits, ...rest } = entry; void commits; return rest; }) } } });
    const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...clientOf(source, rebuild), ...proofFor(target.url, body) }, body });
    const text = await response.text();
    if (announce) console.log(`batch ${Math.floor(i / 200) + 1}: ${response.status} ${text.slice(0, 200).replace(/\\n/g, " ")}`);
    if (!response.ok) break;
    accepted += batch.length;
  }
  }
  return accepted;
}

/** Whether the door's import_history takes `from_archive` (0.8.0): asked with tools/list, never assumed. */
async function doorKnowsArchive(target) {
  if (!target) return false;
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" });
    const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...proofFor(target.url, body) }, body });
    const text = await response.text();
    const json = JSON.parse(text.trim().startsWith("{") ? text : text.split("\n").find((row) => row.startsWith("data:"))?.slice(5) ?? "null");
    const tool = json?.result?.tools?.find((one) => one.name === "import_history");
    return Boolean(tool?.inputSchema?.properties?.entries?.items?.properties?.from_archive);
  } catch { return false; }
}

/** DEVICE PROOF (2026-10-03): through `worktrust hook` a bound computer hands over WORKTRUST_DEVICE_KEY; every call is then signed. */
const proofFor = (url, body) => {
  const device = process.env.WORKTRUST_DEVICE_KEY;
  if (!device) return {};
  const seconds = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return { "worktrust-proof": `${seconds}.${nonce}.${cryptoSign(null, Buffer.from(`POST\n${new URL(url).pathname}\n${seconds}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`), device).toString("base64url")}` };
};

/**
 * WHICH CLIENT A LINE CAME FROM, FOR THE DOOR (2026-10-04). Through the bridge one key serves every app
 * on this computer, and the door names a coupling's clients by the user-agent it hears (mcp_identify's
 * agents_seen). An Antigravity line names Antigravity: the product name, nothing of the work.
 */
const clientOf = (source, always = false) => (always || source === "antigravity" || DATABASE_CLIENTS.includes(source) ? { "user-agent": `${source ?? "claude"}/hook (worktrust-hook)` } : {});

async function send(door, payload) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_work", arguments: payload } });
  const response = await fetch(door.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${door.token}`, ...clientOf(entrySource.get(payload)), ...proofFor(door.url, body) }, body });
  if (!response.ok) throw new Error(`door said ${response.status}`);
  return response.text();
}

/**
 * THE MONTHS ALREADY ON THIS MACHINE, AS HISTORY.
 *
 * The hook records what happens from today. Everything before it sits in the same transcripts,
 * with the same clocks, and the door has a separate path for it — `import_history`, which marks a
 * line as imported: it forms no session, adds no verified hour and carries no level, so nothing
 * here can inflate a credential. What it CAN do is give the record days, months, layers and a
 * rhythm it had no way to know about, and it is the only half of the past that is honest to send:
 * a measured stretch from the person's own machine, not an estimate of what probably happened.
 *
 * One entry per DAY per transcript. A file may span a week; a day is the unit the reconstruction
 * matches commits by, and cutting on the calendar keeps `at` a real instant rather than an
 * average of one. Younger than the live window is left alone — that is `log_work`'s half.
 */
function historyEntries(floor = null, all = false) {
  const entries = [];
  for (const { file } of allTranscripts()) {
    const lines = parsedLines(file);
    if (!lines) continue;
    let cwd = null, steered = null;
    const read = [];
    for (const line of lines) {
      if (typeof line.cwd === "string") cwd = line.cwd;
      if (typeof line.steered === "string") steered = line.steered;
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) continue;
      read.push(messageOf(line, at));
    }
    read.sort((a, b) => a.at - b.at);
    const byDay = byDayOf(read);
    const agents = agentsByDay(file, null);
    for (const [day, messages] of byDay) {
      if (messages.length === 0) continue;
      // Under-reporting is the safe side (THE FLOORS): a day that began before the account changed is not offered at all.
      if (floor !== null && firstOf(messages) < floor) continue;
      const last = messages[messages.length - 1].at;
      // The live window belongs to the hook: a stretch that log_work may still report is not history.
      if (!all && Date.now() - last < WINDOW_HOURS * 3600_000) continue;
      // The same measure as a live day (seconds, layers, tokens, turns, model); history differs only in the door it goes through.
      const entry = payloadFor({ ...measure(cwd, messages), ref: stretchRef(file, day), steered, agents: agents.get(day) ?? null });
      if (CODEX_ROLLOUT.test(file)) entrySource.set(entry, "codex");
      if (ANTIGRAVITY_TRANSCRIPT.test(file)) entrySource.set(entry, "antigravity");
      if (DATABASE_SESSION.test(file)) entrySource.set(entry, file.slice(0, file.indexOf(":")));
      entryFile.set(entry, { file, from: firstOf(messages), folder: cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() ?? null : null });
      entries.push(entry);
    }
  }
  const seen = new Set(); // ONE SESSION FILE IN TWO PROJECT FOLDERS (a copied folder) IS ONE STRETCH (0.6.16, audit M6), as live and preserve count it
  return entries.filter((entry) => !seen.has(entry.stretch_ref) && seen.add(entry.stretch_ref)).sort((a, b) => a.at.localeCompare(b.at));
}

/** Every transcript this machine holds, excluded projects skipped before a file is opened. */
function* allTranscripts() {
  const root = claudeRoot();
  if (existsSync(root)) for (const dir of readdirSync(root)) {
    if (excluded(dir)) continue;
    let files;
    try { files = readdirSync(join(root, dir)); } catch { continue; }
    for (const file of files) if (file.endsWith(".jsonl")) yield { id: file.replace(/\.jsonl$/, ""), file: join(root, dir, file) };
  }
  yield* codexRollouts();
}

/**
 * EVERY TRANSCRIPT, with what it was last written. The two filters that used to live here decided
 * the wrong thing at the wrong level:
 *
 * - "idle 30 minutes" skipped the file being typed into, and with it every earlier day of a
 *   session that has been open for a fortnight. Whether a DAY is finished is a fact about the day.
 * - "not older than 48 hours" skipped the machine that was closed for four months, which is
 *   exactly the person whose work needs collecting when they come back.
 *
 * The caller opens a file only when it has been written since the watermark says we last read it,
 * so a sweep over a hundred transcripts costs a hundred `stat` calls and nothing more.
 */
function* candidates() {
  for (const rollout of codexRollouts()) {
    if (rollout.writtenAt) { yield rollout; continue; } // a database session knows its own last moment
    let stat; try { stat = statSync(rollout.file); } catch { continue; }
    yield { ...rollout, writtenAt: stat.mtimeMs };
  }
  const root = claudeRoot();
  if (!existsSync(root)) return;
  for (const dir of readdirSync(root)) {
    if (excluded(dir)) continue;
    const path = join(root, dir);
    let files;
    try { files = readdirSync(path); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(path, file);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      yield { id: file.replace(/\.jsonl$/, ""), file: full, writtenAt: stat.mtimeMs };
    }
  }
}

function hookInput() {
  // Only when something was piped in. Reading fd 0 on a terminal waits for an EOF that never
  // comes, and a hook that hangs is worse than one that does nothing. A dry run READS it, so the
  // hook path is the one a person can rehearse: `echo '<the hook JSON>' | node log-session.mjs
  // --dry-run` shows exactly what that session would send.
  // Antigravity's Stop hook hands its JSON over in the environment (worktrust.mjs hook --antigravity-stop).
  if (process.stdin.isTTY && !process.env.WORKTRUST_HOOK_INPUT) return null;
  try {
    const raw = process.env.WORKTRUST_HOOK_INPUT ?? readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch { return null; }
}

if (flag("uninstall")) {
  // THE WAY OUT IS THE SAME SIZE AS THE WAY IN. A hook that can only be installed is a hook
  // somebody has to reverse-engineer out of a settings file, and it keeps sending in the
  // meantime. This removes the wiring; --purge also removes the copies and the state.
  const file = join(homedir(), ".claude", "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const before = JSON.stringify(HOOK_EVENTS.map((event) => settings.hooks?.[event] ?? []));
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks?.[event]) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((entry) => ({ ...entry, hooks: (entry?.hooks ?? []).filter((item) => !ours(item?.command)) }))
      .filter((entry) => (entry.hooks ?? []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  const removed = before !== JSON.stringify(HOOK_EVENTS.map((event) => settings.hooks?.[event] ?? []));
  if (removed) writeFileSync(file, JSON.stringify(settings, null, 2));
  if (flag("purge")) for (const path of [COUNTER, PINNED, join(homedir(), ".worktrust", "log-session.mjs"), STATE, ...READER_FILES.map((name) => join(homedir(), ".worktrust", name)), join(homedir(), ".worktrust", "antigravity.json")]) { try { rmSync(path); } catch { /* already gone */ } }
  console.log(`${removed ? "removed" : "nothing wired"}: ${file}${flag("purge") ? "\n         purged ~/.worktrust" : ""}`);
  console.log("the coupling itself still exists: end it in the app (Sources → the computer's row → end this coupling)");
  await exitFlushed(0);
}

if (flag("install")) {
  // `--from-now` (every new coupling) and `--history-floor now` (a coupling to another account): see THE FLOORS.
  if (flag("from-now") || value("history-floor") === "now") {
    const floors = readState();
    const now = new Date().toISOString();
    if (flag("from-now")) floors.__from = now;
    if (value("history-floor") === "now") floors.__historyFloor = now;
    writeState(floors);
  }
  // Wired to SessionEnd, not to every reply: the door asks for one call per PIECE of work, and a
  // hook that fired per message would report a hundred stretches for one afternoon.
  //
  // AND WIRED TO A PATH THAT SURVIVES. `curl -O` leaves the file wherever the terminal happened to
  // be — a Downloads folder, a repository, a temp directory somebody empties on Monday — and a
  // hook whose command has gone missing fails silently, which on this record is indistinguishable
  // from a person who stopped working. So install copies itself to ~/.worktrust and wires that.
  const home = join(homedir(), ".worktrust", "log-session.mjs");
  const self = process.argv[1];
  // The copy that runs is refreshed from the file you ran — and SAYS so, because "already installed —
  // nothing changed" after a newer download read as "your hook is old" to the person who had just updated it.
  let hookRefreshed = false;
  if (self !== home) {
    const next = readFileSync(self, "utf8");
    const current = existsSync(home) ? readFileSync(home, "utf8") : null;
    mkdirSync(dirname(home), { recursive: true });
    if (current !== next) { writeFileSync(home, next); hookRefreshed = current !== null; }
  }
  // A counter handed over by the package (`--counter <path>`) is copied and pinned: nothing below fetches one.
  const given = args.indexOf("--counter") >= 0 ? args[args.indexOf("--counter") + 1] : null;
  if (given) { mkdirSync(dirname(COUNTER), { recursive: true }); writeFileSync(COUNTER, readFileSync(given, "utf8")); writeFileSync(PINNED, "the counter comes with the worktrust package; it is not refreshed from the network\n"); console.log(`counter: ${COUNTER} — from the package, pinned`); }
  const file = join(homedir(), ".claude", "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  // `--via <worktrust.mjs>`: the key lives in ~/.worktrust/key.json, so Claude Code runs the wrapper, which reads it and starts this hook.
  const via = args.indexOf("--via") >= 0 ? args[args.indexOf("--via") + 1] : null;
  const command = via ? `"${process.env.WORKTRUST_NODE || process.execPath}" "${via}" hook` : `node ${home}`;
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) settings.hooks[event] ??= [];
  // A WIRING THAT POINTS SOMEWHERE ELSE IS REPAIRED, NOT LEFT. An earlier install wired whatever
  // path `curl -O` had left the file at — a repository working tree, in the first real install —
  // and answering "already installed" to the run that would have fixed it leaves the person
  // certain it is right. So an entry that names this hook and a different path is rewritten.
  let repaired = null;
  const wired = new Set();
  for (const event of HOOK_EVENTS) {
    for (const entry of settings.hooks[event]) {
      for (const item of entry?.hooks ?? []) {
        if (typeof item?.command !== "string" || !ours(item.command)) continue;
        if (item.command === command) { wired.add(event); continue; }
        repaired = item.command;
        item.command = command;
        wired.add(event);
      }
    }
  }
  // An earlier install wired SessionEnd alone. Adding the two that were missing is a repair, not a
  // second installation, and saying "already installed" to the run that would have added them is
  // how a person ends up certain that a thing works which does not.
  const added = HOOK_EVENTS.filter((event) => !wired.has(event));
  const already = added.length === 0;
  // The counting half, from the same deployment the hook came from: one command installs both, or
  // says plainly that it could not — a half nobody knows is missing is the worse outcome.
  const counterOrigin = coupling()?.url ? new URL(coupling().url).origin : null;
  if (!(await installReaders(counterOrigin))) console.log("readers:   transcript-readers.mjs or session-databases.mjs not found beside this file nor at the deployment; the clients they read are not read until they are");
  if (existsSync(COUNTER)) await refreshCounter(counterOrigin, (line) => console.log(line));
  if (!existsSync(COUNTER)) {
    const origin = counterOrigin;
    if (!origin) console.log("counter: not installed — no coupling found to name the deployment; fetch /counter/count-behaviour.mjs yourself");
    else {
      try {
        const response = await fetch(`${origin}/counter/count-behaviour.mjs`);
        if (!response.ok) throw new Error(String(response.status));
        writeFileSync(COUNTER, await response.text());
        console.log(`counter: ${COUNTER} — it runs once a day from this hook and STAGES its reading; nothing counts until you click Import in the app`);
      } catch (error) { console.log(`counter: could not fetch it (${error.message}) — the hook works without it; fetch /counter/count-behaviour.mjs later`); }
    }
  }
  if (already && !repaired) { console.log(hookRefreshed ? `hook updated: ${home} now runs the version you downloaded; the wiring was already right (${command})` : `already installed — nothing changed (${command})`); await exitFlushed(0); }
  for (const event of added) settings.hooks[event].push({ hooks: [{ type: "command", command }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(repaired
    ? `repaired: ${file} pointed at ${repaired}\n          it now runs ${command}`
    : `installed: ${home}\n           ${file} → ${HOOK_EVENTS.join(", ")} run it\n           the file you downloaded may be deleted; this copy is the one that runs`);
  // Codex has no settings.json to wire; its notify hook is one line in config.toml, which this script
  // never rewrites: `npx worktrust` asks and writes it (WORKTRUST_CODEX_OFFER, so no hint twice), and
  // without it Codex rollouts are still swept whenever the Claude Code hook runs.
  if (existsSync(join(homedir(), ".codex")) && !process.env.WORKTRUST_CODEX_OFFER) console.log(`codex:      to have Codex wake this hook too, add to ~/.codex/config.toml:\n            notify = ${via ? `["${process.env.WORKTRUST_NODE || process.execPath}", "${via}", "hook", "--codex-notify"]` : `["node", "${home}", "--codex-notify"]`}\n            (its rollouts are swept on every run either way)`);
  await exitFlushed(0);
}

const door = coupling();
/**
 * A CODEX STRETCH GOES THROUGH CODEX'S OWN COUPLING. Both clients hold a token to the same door,
 * and the record files a stretch under the coupling that sent it: a Codex thread sent with Claude
 * Code's token would read as Claude Code work. Where only one of the two is coupled, that one
 * carries both, and the model on every stretch still says which it was.
 */
const codexDoor = codexCoupling();
const doorFor = (entry) => (String(entry?.id ?? "").startsWith("codex:") ? codexDoor ?? door : door);
const entrySource = new WeakMap(); // an entry → "codex" or "antigravity" by the client that wrote it; the sends route and name by it
const entryFile = new WeakMap(); // a history entry → its transcript (`--summary` counts sessions), first moment and folder name (`--archive-lines`)
// THE LOCAL ARCHIVE (`npx worktrust preserve --archive`, 2026-10-06): every measured day, live window and floors aside, as JSON lines to preserve.mjs on this computer, which keeps metadata only; nothing is sent.
if (flag("archive-lines")) { const lines = historyEntries(null, true).map((entry) => JSON.stringify({ ...entry, ...(DERIVED.get(entry) ?? {}), client: entrySource.get(entry) ?? "claude", started_at: new Date(entryFile.get(entry).from).toISOString(), folder: entryFile.get(entry).folder })); process.stdout.write(`${[...lines, JSON.stringify({ archive_end: lines.length })].join("\n")}\n`); await exitFlushed(0); } // one write and a count, so the reader tells a whole answer from a cut one
if (!door && !codexDoor && !DRY) { process.exit(0); } // Not coupled on this machine: nothing to do, quietly.

/**
 * HISTORY FROM THE ARCHIVE (0.8.0; framework §22). When an AI app has deleted its sessions, the stretches this computer
 * archived (`preserve --archive`) can still be filed, marked `from_archive`. Five conditions, each refused by name: a
 * device key (only lines this computer signed travel), an archive that verifies, a stretch whose session is gone from
 * this computer (one still here goes through the ordinary history), a door that knows the mark, and the person asking.
 */
if (flag("history") && flag("from-archive")) {
  const named = value("from-archive"), dir = named && !named.startsWith("--") ? named.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), "AI-Evidence");
  const say = (text) => console.log(text);
  const pem = process.env.WORKTRUST_DEVICE_KEY;
  let ownKey = null;
  try { ownKey = pem ? createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }).x : null; } catch { ownKey = null; }
  if (!ownKey) { say("No device key on this computer: only lines this computer signed can be sent from its archive. Nothing was sent."); await exitFlushed(1); }
  const verified = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "preserve.mjs"), "--verify", dir], { encoding: "utf8" });
  if (verified.status !== 0) { say(`The archive in ${dir} does not verify, so nothing was sent: ${(verified.stdout || verified.stderr || "").trim().split("\n").pop()}`); await exitFlushed(1); }
  const { archiveEntries = null } = (await import("./preserve-lines.mjs").catch(() => null)) ?? {};
  if (!archiveEntries) { say("preserve-lines.mjs is not beside this file. Nothing was sent."); await exitFlushed(1); }
  const present = new Set(historyEntries(null, true).map((entry) => entry.stretch_ref));
  const signed = archiveEntries(dir, ownKey), gone = signed.filter(({ entry }) => !present.has(entry.stretch_ref));
  const entries = gone.map(({ entry, client }) => { if (client !== "claude") entrySource.set(entry, client); return entry; });
  say(`${signed.length} stretches in the archive signed by this computer · ${entries.length} of them no longer in any AI app here`);
  if (DRY || entries.length === 0) { if (entries[0]) say(`\nthe oldest of them, in full:\n${JSON.stringify(entries[0], null, 1)}`); say(entries.length === 0 ? "Nothing to send." : "\ndry run — nothing sent."); await exitFlushed(0); }
  if (!(await doorKnowsArchive(door))) { say("WorkTrust does not accept history from an archive yet (the door does not know the mark). Nothing was sent."); await exitFlushed(1); }
  await exitFlushed((await sendHistory(door, entries, true)) === entries.length ? 0 : 1);
}

if (flag("history")) {
  const historyFloor = floorOf(readState(), "__historyFloor");
  const entries = historyEntries(historyFloor);
  const hours = entries.reduce((sum, entry) => sum + (entry.seconds ?? 0), 0) / 3600;
  const months = [...new Set(entries.map((entry) => entry.at.slice(0, 7)))].sort();
  // ONE LINE FOR `npx worktrust` TO ASK WITH (2026-10-03): sessions, hours, first and last month; per client its days and hours (the rebuild's plan, 2026-10-07); nothing sent.
  const clients = [...entries.reduce((map, entry) => { const client = entrySource.get(entry) ?? "claude", row = map.get(client) ?? { client, days: new Set(), seconds: 0 }; row.days.add(entry.at.slice(0, 10)); row.seconds += entry.seconds ?? 0; return map.set(client, row); }, new Map()).values()].map((row) => ({ client: row.client, days: row.days.size, hours: Math.round(row.seconds / 360) / 10, first: [...row.days].sort()[0], last: [...row.days].sort().at(-1) }));
  if (flag("summary")) { console.log(JSON.stringify({ sessions: new Set(entries.map((entry) => entryFile.get(entry).file)).size, hours: Math.round(hours * 10) / 10, first: months[0] ?? null, last: months.at(-1) ?? null, clients })); await exitFlushed(0); }
  console.log(`${entries.length} day-stretches · ${hours.toFixed(1)} measured hours · ${months.join(", ")}${flag("rebuild") ? " · rebuild: this computer's earlier lines for these days and clients are replaced at the door" : ""}`);
  if (DRY) {
    // One example in full: the shape is the argument for trusting it, and a summary hides it.
    if (entries[0]) console.log(`\nthe oldest of them, in full:\n${JSON.stringify(entries[0], null, 1)}`);
    console.log(`\ndry run — nothing sent. Add --history${flag("rebuild") ? " --rebuild" : ""} without --dry-run to ${flag("rebuild") ? "rebuild" : "import"} them.`);
    await exitFlushed(0);
  }
  // A batch the door refused is a failure the caller must see, not a quiet zero.
  await exitFlushed((await sendHistory(door, entries, true, flag("rebuild"))) === entries.length ? 0 : 1);
}

const input = hookInput();
const state = readState();
const work = [];
if (input?.transcript_path && existsSync(input.transcript_path) && !excluded(input.transcript_path)) {
  work.push({ id: String(input.session_id ?? input.transcript_path), file: input.transcript_path });
}
// ANTIGRAVITY'S STOP (camelCase, antigravity.google/docs/hooks/): its model and folder are kept for the sweep; no text is in it.
if (typeof input?.transcriptPath === "string" && ANTIGRAVITY_TRANSCRIPT.test(input.transcriptPath) && existsSync(input.transcriptPath)) {
  const id = rememberAntigravity(input);
  const { cwd } = id ? antigravityContext(id) : {};
  if (id && !(cwd && excluded(cwd))) work.push({ id: `antigravity:${id}`, file: input.transcriptPath });
}
// A session that ended with the terminal closed fires no hook, so every run also sweeps the
// transcripts that have gone quiet and were never logged. Self-healing, and it can only ever
// report a stretch it can measure.
for (const found of candidates()) if (!work.some((entry) => entry.file === found.file)) work.push(found);

// A computer coupled by an older CLI has no `__from`: it is set to the first watermark this computer
// ever wrote (when it first sent), or to now on a computer that has sent nothing, and kept.
if (floorOf(state, "__from") === null) {
  const marks = Object.entries(state).filter(([key, entry]) => !key.startsWith("__") && entry?.through).map(([, entry]) => Date.parse(entry.through)).filter(Number.isFinite);
  state.__from = new Date(marks.length > 0 ? Math.min(...marks) : Date.now()).toISOString();
  if (!DRY) writeState(state);
}
const floor = floorOf(state, "__from");
let sent = 0, filed = 0;
const late = []; // measured days the live door will no longer take: they are not dropped, they are filed
const heldBack = new Map(); // per transcript with a late day: its state before that day, put back unless history took every late day
for (const entry of work) {
  const mark = state[entry.id]?.through ? Date.parse(state[entry.id].through) : null;
  // Never before the coupling (THE FLOORS): a transcript with no watermark starts at `__from`, not at its first line.
  const since = mark !== null && floor !== null ? Math.max(mark, floor) : mark ?? floor;
  // Nothing written since we last read this one: it is not opened. This keeps a sweep over every transcript to one `stat` each.
  if (since !== null && entry.writtenAt && entry.writtenAt <= since) continue;
  const stretches = stretchesOf(entry.file, since);
  // THE WATERMARK ADVANCES OVER WHAT WAS ACCEPTED, AND STOPS AT THE FIRST REFUSAL. A door that is
  // down must never cost the person a day, so the loop breaks rather than skipping ahead.
  let through = null, before, reported = state[entry.id]?.reported;
  for (const stretch of stretches) {
    // The day still being worked in is not finished. A fortnight-long session therefore reports
    // every day but today, on whichever run comes first — it no longer waits for its own end.
    if (Date.now() - stretch.to < IDLE_BEFORE_SWEEP) break;
    const total = grownBy(stretch, reported);
    const payload = payloadFor(stretch);
    const source = LIVE_SOURCE.exec(String(entry.id))?.[1];
    if (source) entrySource.set(payload, source);
    if (DRY) { console.log(JSON.stringify({ ...payload, client: source ?? "claude", route: Date.now() - stretch.to > WINDOW_HOURS * 3600_000 ? "history" : "log_work" }, null, 1)); through = stretch.to; reported = total; continue; }
    // MEASURED TIME IS NEVER DROPPED. The live door refuses anything older than two days, which is right, and used to mean a machine closed
    // for a fortnight lost the fortnight. The same numbers go through the history door instead, standing as history stands. Late is not untrue.
    if (Date.now() - stretch.to > WINDOW_HOURS * 3600_000) { before ??= { mark: through === null ? state[entry.id] : { ...state[entry.id], through: new Date(through).toISOString() } }; late.push(payload); through = stretch.to; reported = total; continue; }
    try { await send(doorFor(entry), payload); through = stretch.to; reported = total; sent += 1; } catch (error) {
      if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`);
      break;
    }
  }
  if (before && !heldBack.has(entry.id)) heldBack.set(entry.id, before.mark);
  if (through !== null) state[entry.id] = { through: new Date(through).toISOString(), ...(reported ? { reported } : {}) };
}
// The history door, in batches of two hundred as `--history` sends them. A resend FILLS a line that was missing something, never a twin.
if (!DRY && late.length > 0) {
  try { filed = await sendHistory(door, late); } catch (error) { if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`); }
  // A LATE DAY THE HISTORY DOOR REFUSED IS NOT PASSED: its transcript's mark goes back to before it, so the next run sends it again.
  if (filed < late.length) for (const [id, mark] of heldBack) { if (mark) state[id] = mark; else delete state[id]; }
}
if (!DRY && (sent > 0 || filed > 0)) writeState(state);

// The counter, at most once a day, detached: reading every transcript takes longer than a hook
// may hold a session's exit, and its result waits for a click either way. `--stage` and never
// `--send`: staging is idempotent on the reading's own digest, so a day that changed nothing
// leaves nothing behind.
if (!DRY && existsSync(COUNTER)) {
  // Before the day's count: the deployment's counter, if it is newer than the one on this machine.
  await refreshCounter(door?.url ? new URL(door.url).origin : null, (line) => console.log(line));
  const last = state.__counter?.at ? Date.parse(state.__counter.at) : 0;
  if (Date.now() - last > COUNTER_EVERY_MS) {
    try {
      const child = spawn(process.execPath, [COUNTER, "--stage"], { detached: true, stdio: "ignore" });
      child.unref();
      state.__counter = { at: new Date().toISOString() };
      writeState(state);
    } catch { /* the counter is a bonus; a hook that fails on it would cost the stretch it just logged */ }
  }
}
await exitFlushed(0);
