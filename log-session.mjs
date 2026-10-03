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
 *   (as a hook)                                reads the hook's JSON on stdin, logs, exits
 *   (from Codex)                               notify = ["node", "~/.worktrust/log-session.mjs", "--codex-notify"]
 *                                              in ~/.codex/config.toml: Codex calls it at every turn's end and
 *                                              the sweep below finds the thread's rollout; its argument, which
 *                                              carries text, is never read
 *
 * CODEX ROLLOUTS (2026-09-27) are swept beside the Claude Code transcripts: ~/.codex/sessions holds
 * the same clocks, the model per turn and a token record per response, and the reader below turns
 * them into the lines this script already measures. One hook, two clients, one rule for both.
 *
 * WHAT CANNOT LEAVE. The payload is built from a fixed allowlist of keys, all of them numbers,
 * dates or vocabulary from the door's own enums. No prompt, no answer, no file path, no commit
 * message, no branch, no project name. File paths ARE read locally to decide one layer keyword,
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
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes, sign as cryptoSign } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const DRY = flag("dry-run");

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
const readState = () => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (state) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 1)); };

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
// ── codex rollout reader (the same text in count-behaviour.mjs and log-session.mjs; test-codex-rollout holds them equal) ──
/**
 * A CODEX ROLLOUT, READ AS A TRANSCRIPT (2026-09-27). Codex keeps one JSONL per thread under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl: a session_meta line, then per turn a
 * turn_context (model, effort, cwd), response_items (messages, tool calls, their outputs) and a
 * token_usage_record per model response. On the machine this was built on five of them held 679
 * million tokens that nothing read. This turns the records into the lines Claude Code writes, so
 * ONE rubric and ONE clock read both:
 *   · a user or assistant message → a user or assistant line with a text part; the developer line
 *     and the harness's own user-role messages (<environment_context>, <recommended_plugins> and
 *     the like: a tag opening the text) are the harness, not the person, and are dropped;
 *   · a tool call → an assistant line with a tool_use part: `exec` becomes Bash with the command
 *     as input, `apply_patch` an Edit with the first path it names, `spawn_agent` an Agent; its
 *     output → a user line with a tool_result, is_error read from Codex's own "exit code N";
 *   · a token_usage_record → an assistant line carrying the usage in Claude's keys, ONCE per
 *     response_id (Codex writes a response more than once): input minus cached is new input,
 *     cached is a cache read, cache_write a cache write, output already holds the reasoning tokens.
 * The running total in event_msg/token_count is never read: it is a counter, not a record.
 * Text is read here for the rubric and the layer and travels nowhere, as with every transcript.
 */
const CODEX_ROLLOUT = /(^|\/)rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{36}\.jsonl$/;
const CODEX_HARNESS_TURN = /^\s*<[a-z][a-z_]*[\s>]/i;
const codexToolName = (name) => (name === "exec" || name === "shell" || name === "container.exec" || name === "local_shell" ? "Bash" : name === "apply_patch" ? "Edit" : name === "spawn_agent" ? "Agent" : String(name ?? "tool"));
const codexToolInput = (name, raw) => {
  const mapped = codexToolName(name);
  if (mapped === "Bash") {
    if (typeof raw === "string") { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return { command: Array.isArray(parsed.command) ? parsed.command.join(" ") : String(parsed.command ?? parsed.cmd ?? raw) }; } catch { /* the string is the command */ } return { command: raw }; }
    return { command: Array.isArray(raw?.command) ? raw.command.join(" ") : String(raw?.command ?? raw?.cmd ?? "") };
  }
  if (mapped === "Edit") { const path = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/.exec(typeof raw === "string" ? raw : JSON.stringify(raw ?? "")); return { file_path: path ? path[1].trim() : "" }; }
  return {};
};
const codexOutputText = (output) => (typeof output === "string" ? output : Array.isArray(output) ? output.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n") : "");
/** The rollout's raw JSON lines → transcript-shaped line objects, in file order. */
function* codexLines(records) {
  let cwd = null, model = null;
  const seenResponses = new Set();
  for (const raw of records) {
    if (!raw || !String(raw).trim()) continue;
    let record; try { record = JSON.parse(raw); } catch { continue; }
    const timestamp = typeof record?.timestamp === "string" ? record.timestamp : null;
    const payload = record?.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta") { if (typeof payload.cwd === "string") cwd = payload.cwd; continue; }
    if (record.type === "turn_context") { if (typeof payload.cwd === "string") cwd = payload.cwd; if (typeof payload.model === "string") model = payload.model; continue; }
    if (record.type === "token_usage_record") {
      const id = String(payload.response_id ?? "");
      const usage = payload.usage;
      if (!usage || typeof usage !== "object" || (id && seenResponses.has(id))) continue;
      if (id) seenResponses.add(id);
      const n = (key) => (typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0);
      yield { type: "assistant", timestamp, cwd, uuid: id ? `codex-usage-${id}` : undefined, message: { ...(model ? { model } : {}), content: [], usage: { input_tokens: Math.max(0, n("input_tokens") - n("cached_input_tokens")), output_tokens: n("output_tokens"), cache_read_input_tokens: n("cached_input_tokens"), cache_creation_input_tokens: n("cache_write_input_tokens") } } };
      continue;
    }
    if (record.type !== "response_item") continue;
    const kind = payload.type;
    if (kind === "message") {
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      const text = Array.isArray(payload.content) ? payload.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n") : typeof payload.content === "string" ? payload.content : "";
      if (payload.role === "user" && CODEX_HARNESS_TURN.test(text)) continue;
      yield { type: payload.role, timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { ...(payload.role === "assistant" && model ? { model } : {}), content: [{ type: "text", text }] } };
      continue;
    }
    if (kind === "custom_tool_call" || kind === "function_call") {
      const input = kind === "function_call" ? (() => { try { return JSON.parse(payload.arguments ?? "{}"); } catch { return {}; } })() : payload.input;
      yield { type: "assistant", timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { ...(model ? { model } : {}), content: [{ type: "tool_use", ...(payload.call_id ? { id: String(payload.call_id) } : {}), name: codexToolName(payload.name), input: codexToolInput(payload.name, input) }] } };
      continue;
    }
    if (kind === "custom_tool_call_output" || kind === "function_call_output") {
      const text = codexOutputText(payload.output);
      const exit = /(?:failed with|exited with|exit code)[:\s]+(-?\d+)/i.exec(text.slice(-400));
      yield { type: "user", timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { content: [{ type: "tool_result", ...(payload.call_id ? { tool_use_id: String(payload.call_id) } : {}), content: text, is_error: exit ? exit[1] !== "0" : false }] } };
    }
  }
}
/** Every rollout under a Codex sessions root, in a stable order. */
function* codexRolloutFiles(root) {
  let entries = []; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* codexRolloutFiles(full);
    else if (CODEX_ROLLOUT.test(entry.name)) yield full;
  }
}
/** The rollout's working directory, from its first line alone: the file is not read for it. */
function codexCwd(file) {
  let fd; try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.toString("utf8", 0, read).split("\n")[0] ?? "";
    const meta = JSON.parse(first);
    return meta?.type === "session_meta" && typeof meta.payload?.cwd === "string" ? meta.payload.cwd : null;
  } catch { return null; } finally { closeSync(fd); }
}
// ── end codex rollout reader ──

/** The roots this machine's transcripts live under; a test names its own. */
const claudeRoot = () => value("transcript-root") ?? join(homedir(), ".claude", "projects");
const codexRoot = () => { const given = value("codex-root"); if (given) return given.replace(/^~(?=\/|$)/, homedir()); return value("transcript-root") ? null : join(homedir(), ".codex", "sessions"); };
/** Every Codex rollout on this machine, an excluded project's threads skipped by their working directory. */
function* codexRollouts() {
  const root = codexRoot();
  if (!root) return;
  for (const file of codexRolloutFiles(root)) {
    const cwd = codexCwd(file);
    if (cwd && excluded(cwd)) continue;
    yield { id: `codex:${file.split("/").at(-1).replace(/\.jsonl$/, "")}`, file };
  }
}
/** A transcript's lines as objects, whichever client wrote it; null when the file cannot be read. */
const parsedLines = (file) => {
  let lines; try { lines = readFileSync(file, "utf8").split("\n"); } catch { return null; }
  if (CODEX_ROLLOUT.test(file)) return [...codexLines(lines)];
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
  let cwd = null;
  for (const line of lines) {
    if (typeof line.cwd === "string") cwd = line.cwd;
    if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
    const at = Date.parse(line.timestamp);
    if (!Number.isFinite(at)) continue;
    if (since && at <= since) continue;
    messages.push({ at, type: line.type, usage: line.message?.usage ?? null, model: line.message?.model ?? null, meta: line.isMeta === true, content: line.message?.content ?? null });
  }
  if (messages.length === 0) return [];
  messages.sort((a, b) => a.at - b.at);
  const byDay = new Map();
  for (const message of messages) {
    const day = new Date(message.at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(message);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ofDay]) => measure(cwd, ofDay)).filter(Boolean);
}

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
    if (message.type === "user" && !message.meta && isHumanTurn(message.content)) exchanges += 1;
    if (message.model) models.set(message.model, (models.get(message.model) ?? 0) + 1);
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tokens = tokensOf(messages);
  return { cwd, seconds: measured, ...tokens, exchanges, model, from: messages[0].at, to: messages[messages.length - 1].at };
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
  for (const message of messages) {
    const usage = message.usage;
    if (!usage) continue;
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

/** The one payload shape this script can build. Every key is a number, a date or an enum value. */
function payloadFor(stretch) {
  const cwd = stretch.cwd && existsSync(stretch.cwd) ? stretch.cwd : null;
  const repo = cwd ? repoOf(cwd) : null;
  const touched = cwd ? pathsTouched(cwd, new Date(stretch.from).toISOString(), new Date(stretch.to).toISOString()) : { paths: [], committed: false, shas: [] };
  const { layer, layers } = layersOf(touched.paths);
  // The seventh kind, used as it is defined: a stretch that changed no artefact is knowing
  // something, not building something, and it earns neither an artefact's nor a validation's credit.
  const kind = touched.paths.length === 0 ? "researched" : touched.committed ? "changed" : "built";
  return {
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
    at: new Date(stretch.to).toISOString(),
  };
}

/**
 * The history door, in the batch size it asks for. Oldest first, and a resend is safe: every entry
 * is deduplicated on its content, and one that knows more than a stored line FILLS it rather than
 * adding a twin. Returns how many entries were accepted, so a caller can advance a watermark over
 * exactly what landed. `announce` because one caller is a person watching a terminal and the other
 * is a hook holding a session's exit open.
 */
async function sendHistory(door, entries, announce = false) {
  let accepted = 0;
  // A Codex entry goes through Codex's own coupling where one exists (see codexDoor), the rest
  // through the door given: the record files a line under the coupling that sent it.
  for (const [source, group] of [["claude", entries.filter((entry) => entrySource.get(entry) !== "codex")], ["codex", entries.filter((entry) => entrySource.get(entry) === "codex")]]) {
  const target = source === "codex" ? codexDoor ?? door : door;
  if (group.length === 0 || !target) continue;
  for (let i = 0; i < group.length; i += 200) {
    const batch = group.slice(i, i + 200);
    // History carries no shas: an imported line forms no session, and the join is the live route's.
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { entries: batch.map((entry) => { const { commits, ...rest } = entry; void commits; return rest; }) } } });
    const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...proofFor(target.url, body) }, body });
    const text = await response.text();
    if (announce) console.log(`batch ${Math.floor(i / 200) + 1}: ${response.status} ${text.slice(0, 200).replace(/\\n/g, " ")}`);
    if (!response.ok) break;
    accepted += batch.length;
  }
  }
  return accepted;
}

/** DEVICE PROOF (2026-10-03): through `worktrust hook` a bound computer hands over WORKTRUST_DEVICE_KEY; every call is then signed. */
const proofFor = (url, body) => {
  const device = process.env.WORKTRUST_DEVICE_KEY;
  if (!device) return {};
  const seconds = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return { "worktrust-proof": `${seconds}.${nonce}.${cryptoSign(null, Buffer.from(`POST\n${new URL(url).pathname}\n${seconds}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`), device).toString("base64url")}` };
};

async function send(door, payload) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_work", arguments: payload } });
  const response = await fetch(door.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${door.token}`, ...proofFor(door.url, body) }, body });
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
function historyEntries() {
  const entries = [];
  for (const { file } of allTranscripts()) {
    const lines = parsedLines(file);
    if (!lines) continue;
    let cwd = null;
    const byDay = new Map();
    for (const line of lines) {
      if (typeof line.cwd === "string") cwd = line.cwd;
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) continue;
      const day = new Date(at).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ at, type: line.type, usage: line.message?.usage ?? null, model: line.message?.model ?? null, meta: line.isMeta === true, content: line.message?.content ?? null });
    }
    for (const [day, messages] of byDay) {
      if (messages.length === 0) continue;
      messages.sort((a, b) => a.at - b.at);
      const last = messages[messages.length - 1].at;
      // The live window belongs to the hook: a stretch that log_work may still report is not history.
      if (Date.now() - last < WINDOW_HOURS * 3600_000) continue;
      let seconds = 0;
      for (let i = 1; i < messages.length; i += 1) seconds += Math.min(IDLE_CAP, Math.round((messages[i].at - messages[i - 1].at) / 1000));
      const models = new Map();
      let exchanges = 0;
      for (const message of messages) {
        if (message.type === "user" && !message.meta && isHumanTurn(message.content)) exchanges += 1;
        if (message.model) models.set(message.model, (models.get(message.model) ?? 0) + 1);
      }
      const { tokensIn, tokensOut, cacheRead, cacheWrite, shapeKnown } = tokensOf(messages);
      const entry = payloadFor({
        cwd, seconds: seconds >= MIN_SECONDS ? Math.min(MAX_SECONDS, seconds) : null,
        tokensIn, tokensOut, cacheRead, cacheWrite, shapeKnown, exchanges, model: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        from: messages[0].at, to: last,
      });
      if (CODEX_ROLLOUT.test(file)) entrySource.set(entry, "codex");
      entries.push(entry);
      void day;
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
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
  if (process.stdin.isTTY) return null;
  try {
    const raw = readFileSync(0, "utf8");
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
  if (flag("purge")) for (const path of [COUNTER, PINNED, join(homedir(), ".worktrust", "log-session.mjs"), STATE]) { try { rmSync(path); } catch { /* already gone */ } }
  console.log(`${removed ? "removed" : "nothing wired"}: ${file}${flag("purge") ? "\n         purged ~/.worktrust" : ""}`);
  console.log("the coupling itself still exists: end it in the app (Sources → the computer's row → end this coupling)");
  process.exit(0);
}

if (flag("install")) {
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
  if (already && !repaired) { console.log(hookRefreshed ? `hook updated: ${home} now runs the version you downloaded; the wiring was already right (${command})` : `already installed — nothing changed (${command})`); process.exit(0); }
  for (const event of added) settings.hooks[event].push({ hooks: [{ type: "command", command }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(repaired
    ? `repaired: ${file} pointed at ${repaired}\n          it now runs ${command}`
    : `installed: ${home}\n           ${file} → ${HOOK_EVENTS.join(", ")} run it\n           the file you downloaded may be deleted; this copy is the one that runs`);
  // Codex has no settings.json to wire; its notify hook is one line in config.toml, added by hand so
  // this script never rewrites a TOML file it did not create. Without it, Codex rollouts are still
  // swept whenever the Claude Code hook runs.
  if (existsSync(join(homedir(), ".codex"))) console.log(`codex:      to have Codex wake this hook too, add to ~/.codex/config.toml:\n            notify = ${via ? `["${process.execPath}", "${via}", "hook", "--codex-notify"]` : `["node", "${home}", "--codex-notify"]`}\n            (its rollouts are swept on every run either way)`);
  process.exit(0);
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
const entrySource = new WeakMap(); // a history entry → "codex" when its rollout was Codex's; sendHistory routes by it
if (!door && !codexDoor && !DRY) { process.exit(0); } // Not coupled on this machine: nothing to do, quietly.

if (flag("history")) {
  const entries = historyEntries();
  const hours = entries.reduce((sum, entry) => sum + (entry.seconds ?? 0), 0) / 3600;
  const months = [...new Set(entries.map((entry) => entry.at.slice(0, 7)))].sort();
  console.log(`${entries.length} day-stretches · ${hours.toFixed(1)} measured hours · ${months.join(", ")}`);
  if (DRY) {
    // One example in full: the shape is the argument for trusting it, and a summary hides it.
    if (entries[0]) console.log(`\nthe oldest of them, in full:\n${JSON.stringify(entries[0], null, 1)}`);
    console.log("\ndry run — nothing sent. Add --history without --dry-run to import them.");
    process.exit(0);
  }
  await sendHistory(door, entries, true);
  process.exit(0);
}

const input = hookInput();
const state = readState();
const work = [];
if (input?.transcript_path && existsSync(input.transcript_path) && !excluded(input.transcript_path)) {
  work.push({ id: String(input.session_id ?? input.transcript_path), file: input.transcript_path });
}
// A session that ended with the terminal closed fires no hook, so every run also sweeps the
// transcripts that have gone quiet and were never logged. Self-healing, and it can only ever
// report a stretch it can measure.
for (const found of candidates()) if (!work.some((entry) => entry.file === found.file)) work.push(found);

let sent = 0;
let filed = 0;
/** Measured days the live door will no longer take. They are not dropped; they are filed. */
const late = [];
for (const entry of work) {
  const since = state[entry.id]?.through ? Date.parse(state[entry.id].through) : null;
  // Nothing has been written since we last read this one — no need to open it at all. This is what
  // keeps a sweep over every transcript on the machine to one `stat` each.
  if (since !== null && entry.writtenAt && entry.writtenAt <= since) continue;
  const stretches = stretchesOf(entry.file, since);
  // THE WATERMARK ADVANCES OVER WHAT WAS ACCEPTED, AND STOPS AT THE FIRST REFUSAL. A door that is
  // down must never cost the person a day, so the loop breaks rather than skipping ahead.
  let through = null;
  for (const stretch of stretches) {
    // The day still being worked in is not finished. A fortnight-long session therefore reports
    // every day but today, on whichever run comes first — it no longer waits for its own end.
    if (Date.now() - stretch.to < IDLE_BEFORE_SWEEP) break;
    const payload = payloadFor(stretch);
    if (String(entry.id).startsWith("codex:")) entrySource.set(payload, "codex");
    if (DRY) { console.log(JSON.stringify({ ...payload, route: Date.now() - stretch.to > WINDOW_HOURS * 3600_000 ? "history" : "log_work" }, null, 1)); through = stretch.to; continue; }
    // MEASURED TIME IS NEVER DROPPED. The live door takes work as it happens and refuses anything
    // older than two days — which is right, and used to mean a machine that was closed for a
    // fortnight lost the fortnight. The same measured numbers go through the history door instead:
    // recorded, marked as history, standing as history stands. Late is not the same as untrue.
    if (Date.now() - stretch.to > WINDOW_HOURS * 3600_000) { late.push(payload); through = stretch.to; continue; }
    try {
      await send(doorFor(entry), payload);
      through = stretch.to;
      sent += 1;
    } catch (error) {
      if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`);
      break;
    }
  }
  if (through !== null) state[entry.id] = { through: new Date(through).toISOString() };
}
// The history door, in one batch per two hundred, exactly as `--history` sends them. A resend
// FILLS a line that was missing something rather than adding a twin, so a repeated run is safe.
if (!DRY && late.length > 0) {
  try { filed = await sendHistory(door, late); } catch (error) {
    if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`);
  }
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
process.exit(0);
