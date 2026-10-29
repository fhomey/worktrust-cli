#!/usr/bin/env node
/**
 * THE MOMENT OF THE WORK, RECORDED — a Claude Code hook that logs a finished stretch.
 * Session observations complement repository and CI evidence with locally recorded AI activity.
 * They do not establish independent verification or human presence by themselves.
 * IT NEVER LOSES A MEASURED DAY. A session is reported day by day, on whichever run comes first,
 * so a session that stays open for a fortnight is not a fortnight of silence; a machine that was
 * closed for four months hands over its months when it comes back, through the history door; and
 * a day the network refused is sent again on the next run, because the watermark advances over
 * what was accepted and stops at the first refusal.
 * This hook supplies exactly that half, and nothing else. It NEVER decides how good the work was:
 * scoring calls no model, and a stretch reported here is corroborated by the commit and the CI run
 * that land beside it or it counts for nothing. What it sends is what a clock and a token counter
 * recorded.
 *   node log-session.mjs --install            wire it into Claude Code (SessionEnd, SessionStart, PreCompact)
 *   node log-session.mjs --uninstall [--purge] take it out again (--purge also deletes the copies)
 *   node log-session.mjs --dry-run            show what the current transcripts would send
 *   node log-session.mjs --history [--dry-run] send the months already on this machine, as HISTORY
 *   node log-session.mjs --history --rebuild   the same, re-measured: the door REPLACES this computer's earlier lines, day by day
 *   node log-session.mjs --history --summary   one JSON line: sessions, hours, first and last month, per client (sends nothing)
 *   node log-session.mjs --history --export <path>  a ChatGPT or Claude data export (zip, folder or conversations.json) as
 *                                              HISTORY: hours RECONSTRUCTED from its clocks, never measured, never tokens;
 *                                              the door withdraws the product's earlier connector lines on its days (the
 *                                              export replaces, 2026-10-10); `--withdraw-unknown` (after the person's yes)
 *                                              also withdraws the AI-app lines under no product on exactly those days
 *   node log-session.mjs --find-exports [dir]  the exports lying in a folder (default ~/Downloads), and which were sent
 *   node log-session.mjs --history --from-folder <dir>  a person's own COPY of an AI app's session folder (a backed-up
 *                                              ~/.claude/projects or ~/.codex/sessions), read with the same readers and
 *                                              clock, never the live folders: days the live folders lack, RECONSTRUCTED
 *   node log-session.mjs --history --from-archive [dir]  the archive's stretches no longer in any AI app here: a day this
 *                                              computer's device key signed as measured, every other day reconstructed
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
 * WHAT IS MEASURED, AND BY WHOM (0.10.20, owner 2026-10-18: "the calculation must be done by our system; we only get
 * metadata"). This hook sends a stretch's TIMELINE: one step per transcript line, as the kind of line it was and the whole
 * seconds since the previous step, never a word. WorkTrust computes the seconds and the hours in layers from that timeline
 * with its own rules; nothing here counts an hour, and no constant in this file decides a figure. `duration_basis:
 * "measured"` says the timeline was read from the app's own folder on this computer; copied or exported history is
 * reconstructed. A local stretch without timestamps is skipped rather than estimated. Tokens are what each request ADDED
 * (input plus cache creation, cache reads excluded), which the door calls `newInput`. The figures the terminal shows come
 * from WorkTrust's receipts.
 *
 * CONFIDENTIAL PROJECTS never open: `~/.worktrust-counter.json` { "exclude": ["client-x"] } is
 * honoured here too, matched against the transcript's project directory, before a file is read.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, lstatSync, openSync, closeSync, fsyncSync, fstatSync, linkSync, unlinkSync, readSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from "node:crypto";

import { moduleArgs, moduleExecutable, readPrivateFile, createPrivateFile } from "./package-integrity.mjs";

async function main() {
const args = process.argv.slice(2), NODE_FLAGS = process.versions.node === "26.5.0" ? ["--no-concurrent-sparkplug"] : [];
const flag = (name) => args.includes(`--${name}`), value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }, DRY = flag("dry-run");
// Return from every terminal branch and drain naturally: forced exit can deadlock Node 26.5 while V8 compiles.
const exitFlushed = (code) => new Promise((resolve) => process.stdout.write("", resolve)).then(() => { process.exitCode = code; });

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
const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
const COUNTER = join(RELEASE_DIR, "count-behaviour.mjs");
/** Legacy marker, used only when the person explicitly purges the old installation. */
const PINNED = join(homedir(), ".worktrust", "pinned");
/** A hook command is ours when it runs this file, or the `worktrust hook` wrapper that hands it the key from the key file. */
const ours = (command) => /log-session|worktrust(?:-launch)?\.(?:mjs|py)" (?:hook|--internal-module)|worktrust(?:-launch)?\.(?:mjs|py) hook/.test(String(command ?? ""));
const COUNTER_EVERY_MS = 24 * 3600_000;
/**
 * The live door refuses stretches older than two days; older work uses the history door.
 *
 * It is not a reason to lose the work. Past this line a measured day is filed through
 * `import_history` instead: the same counted seconds, marked as history, standing as history
 * stands (it corroborates, and it never lifts a level on its own). Late is not the same as untrue.
 */
const WINDOW_HOURS = 48;
/** A stretch still being worked in is not finished; half an hour of quiet says it is. The one timing rule this hook keeps: WHEN to sweep, never how long a stretch was. */
const IDLE_BEFORE_SWEEP = 30 * 60 * 1000;
/** Tools whose result waits for the person: the gap to it is the person's time. Names only; nothing of the call is read. */
const WAITS_FOR_PERSON = new Set(["AskUserQuestion", "ExitPlanMode"]);
/**
 * CONTEXT ENGINEERING (0.8.8, framework L6): which of an AI app's own context files the stretch changed, by category,
 * counted; read from the changed paths here, a path never leaves. Instructions (CLAUDE.md, AGENTS.md, GEMINI.md, Cursor
 * rules, Copilot instructions), skills, subagents, commands, the client's settings (permissions, hooks), MCP servers.
 */
const CONTEXT_FILES = [
  ["instructions", /(^|[\\/])(CLAUDE|AGENTS|GEMINI)\.md$|(^|[\\/])\.cursorrules$|(^|[\\/])\.cursor[\\/]rules[\\/]|copilot-instructions\.md$|\.instructions\.md$|(^|[\\/])\.windsurfrules$/i],
  ["skills", /(^|[\\/])\.claude[\\/]skills[\\/]|(^|[\\/])SKILL\.md$/],
  ["agents", /(^|[\\/])\.claude[\\/]agents[\\/]|(^|[\\/])\.github[\\/]agents[\\/]/],
  ["commands", /(^|[\\/])\.claude[\\/]commands[\\/]|(^|[\\/])\.github[\\/]prompts[\\/]/],
  ["settings", /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$|(^|[\\/])\.codex[\\/]config\.toml$/],
  ["mcp", /(^|[\\/])\.?mcp\.json$|(^|[\\/])\.cursor[\\/]mcp\.json$|(^|[\\/])\.vscode[\\/]mcp\.json$/],
];
const contextFilesOf = (paths) => { const out = {}; for (const path of paths) for (const [kind, pattern] of CONTEXT_FILES) if (pattern.test(path)) { out[kind] = (out[kind] ?? 0) + 1; break; } return Object.keys(out).length ? out : null; };
/** An AI named as a commit's co-author by the tools that sign their work that way (read locally; the name never leaves). */
const AI_COAUTHOR = /\b(claude|anthropic|codex|openai|chatgpt|copilot|cursor|devin|gemini|jules|aider|windsurf|cline)\b/i;
/** A path that holds tests, by the conventions of the common test runners (read here; the path never leaves). */
const TEST_PATH = /(^|[\\/])(__tests__|tests?|spec|e2e)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|[\\/])test_[^\\/]+\.py$|Tests?\.(java|kt|cs|swift)$/;
/**
 * THE ROUTE FROM GIT (0.9.2), of the stretch's own commits, read here and never kept: commits over twenty files, a fix
 * that followed another commit of the stretch, a commit naming an issue (#12, ABC-123); and of the changed files, how
 * many are CI, scripts or docs (what lets another person run it again). Subjects and paths never leave.
 */
const CI_PATH = /(^|[\\/])\.github[\\/]workflows[\\/]|(^|[\\/])\.gitlab-ci\.ya?ml$|(^|[\\/])Jenkinsfile$|(^|[\\/])\.circleci[\\/]|(^|[\\/])azure-pipelines\.ya?ml$/;
const SCRIPT_PATH = /(^|[\\/])scripts?[\\/]|(^|[\\/])Makefile$|(^|[\\/])justfile$|\.(sh|ps1)$/;
const DOC_PATH = /(^|[\\/])docs?[\\/]|(^|[\\/])README(\.[a-z]+)?$|(^|[\\/])CHANGELOG\.md$/i;
const FIX_SUBJECT = /^(fix|hotfix|revert)\b/i, ISSUE_REF = /#\d+\b|\b[A-Z][A-Z0-9]+-\d+\b/;
const gitRouteOf = (cwd, shas, paths) => {
  const out = {};
  if (cwd && shas.length > 0) {
    const commits = git(cwd, "log", "--no-walk", "--date-order", "--reverse", "--format=%x1e%s", "--shortstat", ...shas.slice(0, 50)).split("\x1e").map((block) => block.trim()).filter(Boolean)
      .map((block) => ({ subject: block.split("\n")[0], files: Number(/(\d+) files? changed/.exec(block)?.[1] ?? 0) }));
    const large = commits.filter((commit) => commit.files > 20).length, fixes = commits.slice(1).filter((commit) => FIX_SUBJECT.test(commit.subject)).length, issues = commits.filter((commit) => ISSUE_REF.test(commit.subject)).length;
    if (large) out.commits_large = large;
    if (fixes) out.fix_followups = fixes;
    if (issues) out.issue_refs = issues;
  }
  const ci = paths.filter((path) => CI_PATH.test(path)).length, scripts = paths.filter((path) => SCRIPT_PATH.test(path)).length, docs = paths.filter((path) => DOC_PATH.test(path)).length;
  if (ci) out.ci_files = ci;
  if (scripts) out.script_files = scripts;
  if (docs) out.doc_files = docs;
  return out;
};
/** The derived record of a stretch, kept for the local archive only (see payloadFor). */
const DERIVED = new WeakMap();

/**
 * WHEN THE HOOK RUNS. SessionEnd alone was a bet that sessions end, and a session that stays open
 * for a fortnight — resumed through every compaction — reported nothing for a fortnight. These
 * three are the moments Claude Code offers that come round on their own: a session closing, a
 * session opening, and a compaction, which on a long session happens several times a day.
 *
 * Running more often costs nothing extra: the watermark means a run with nothing new to say opens
 * no file, and a day still being worked in is never sent twice.
 */
const HOOK_EVENTS = ["SessionEnd", "SessionStart", "PreCompact", "Stop"];
/**
 * STOP, AT MOST ONCE AN HOUR (0.10.32, after the owner's session of 2026-10-04 to 10-28). A VS Code session that stays open
 * for weeks fires SessionStart once and compacts rarely, and the live door takes a day for 48 hours only: every finished
 * day arrived late. Claude Code's Stop fires after every answer; the hook answers it at once unless an hour has passed
 * since its last Stop sweep, and then sweeps in a detached copy of itself so the answer is never held. The same hook the
 * person agreed to (the "session hook" of consent.json), on one more of Claude Code's moments.
 */
const STOP_SWEEP_MS = 3600_000;

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
/** WorkTrust's own local doors (the app in development, 3011; a module branch, 3021). Another product's local MCP server
 * (the Advisory Board on 3007, 2026-10-09) is not one: it was offered for removal on update, and could have been adopted. */
const LOCAL_DOOR_PORTS = new Set(["3011", "3021"]);
const isWorkTrustDoor = (url) => {
  try {
    const parsed = new URL(String(url));
    if (!/\/api\/mcp\/?$/.test(parsed.pathname)) return false;
    const own = process.env.WORKTRUST_MCP_URL ? new URL(process.env.WORKTRUST_MCP_URL).host : null;
    return parsed.protocol === "https:" && (parsed.hostname === "worktrust.io" || parsed.hostname.endsWith(".worktrust.io")) || (own !== null && parsed.host === own) || ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && LOCAL_DOOR_PORTS.has(parsed.port));
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
const { CODEX_ROLLOUT = /(?!)/, codexIdOf = (file) => String(file).split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""), antigravityIdOf = (file) => String(file).split(/[\\/]/).at(-4), codexLines, codexRolloutFiles = function* () {}, codexCwd = () => null, ANTIGRAVITY_TRANSCRIPT = /(?!)/, antigravityLines, antigravityRoots = () => [], antigravityTranscripts = function* () {}, antigravityContext = () => ({}), rememberAntigravity = () => null, codexLive = () => null, sessionKindReader = () => ({ note() {}, kind: () => "unknown" }), turnByPerson = () => null, timerSchedule = () => null } = (await import("./transcript-readers.mjs").catch(() => null)) ?? {};
// THE STRETCH'S DERIVED RECORD (0.7.4: split from this file): tool calls named by kind, verification, recovery, delegation,
// context and routing, for the local archive only. A copy without the module still measures and sends exactly as before.
const { callOf = (block) => ({ id: block.id, kinds: [], family: String(block.name), digest: "" }), deriveStretch = () => ({}), complexityOf = null, recoveryOf = null, resultOf = (block) => ({ id: block.tool_use_id, failed: block.is_error === true, refusal: null }) } = (await import("./stretch-evidence.mjs").catch(() => null)) ?? {};
const { DATABASE_SESSION = /(?!)/, databaseLines = () => null, databaseSessions = function* () {} } = (await import("./session-databases.mjs").catch(() => null)) ?? {};
// A WEB CHAT'S DATA EXPORT AS HISTORY (0.10.10, owner 2026-10-10): chat-exports.mjs reads a ChatGPT or Claude export (the counter
// imports the same reader); `--history --export <path>` sends its conversations as RECONSTRUCTED days, never measured, never tokens.
const { EXPORT_CLIENTS = [], EXPORT_TITLES = {}, exportSessions = null, exportRef = null, exportRunRef = null, findExports = null } = (await import("./chat-exports.mjs").catch(() => null)) ?? {};
const { modCounts = () => null } = (await import("./claude-mod.mjs").catch(() => null)) ?? {}; // 0.10.15: the WorkTrust mod's live counts per Claude Code session and day; absent → no `live` group, never zeros
const liveOf = (file, day) => modCounts(String(file).split(/[\\/]/).pop().replace(/\.jsonl$/, ""), day) ?? codexLive(file, day); // 0.10.16: a Codex rollout's own
const { stackOfFiles = () => [], displayStackOfFiles = () => [] } = (await import("./stack-rules.mjs").catch(() => null)) ?? {}; // 0.10.11: core's stack rules and the display-only keys (tools_seen), generated (build-stack-rules --check); absent → nothing named, never a guess
const EXPORT_PATHS = []; for (let i = 0; i < args.length; i += 1) if (args[i] === "--export" && args[i + 1]) EXPORT_PATHS.push(args[i + 1]);
const DATABASE_CLIENTS = ["hermes", "goose", "opencode", "openclaw", "cursor", "copilot"]; // the registry's keys, the name each line carries
const LIVE_SOURCE = new RegExp(`^(codex|antigravity|${DATABASE_CLIENTS.join("|")}):`); // a sweep entry's id → the client it names (every database client, 0.6.16)
const READER_FILES = ["history-outbox.mjs", "transcript-readers.mjs", "session-databases.mjs", "stretch-evidence.mjs", "chat-exports.mjs", "stack-rules.mjs", "claude-mod.mjs"]; // 0.7.4: the derived record travels with the hook; 0.10.10: the export reader; 0.10.11: the stack rules; 0.10.15: the mod
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
/**
 * A FILE'S LINES, READ IN CHUNKS (0.10.32). A whole-file `readFileSync(file, "utf8")` throws past the longest string Node
 * makes (about 512 MB), and that throw was read as "this file cannot be read": the owner's VS Code session passed it on
 * 2026-10-18 (797 MB by 10-28) and from then on measured no day at all, live or re-measured. Read 8 MB at a time, one
 * line at a time; re-iterable (each pass opens the file again); null only when the file cannot be opened.
 */
const CHUNK_BYTES = 8 << 20;
/**
 * A READ THAT FAILS IS COUNTED, NEVER SILENT (0.10.32): a transcript that exists and cannot be opened or read to its end
 * is one failure. The run keeps the count in sessions.json (`npx worktrust status` says it) and tells WorkTrust the
 * count alone, never which file or what was in it (reportUnreadable).
 */
const READ_FAILURES = { n: 0 };
/** The bytes this run read from transcripts (the resume's own measure, below): said on stderr under WORKTRUST_HOOK_DEBUG, never sent. */
const READ_BYTES = { n: 0 };
/**
 * What a resume trusts of the bytes it does not read again: eight 4 KB samples before the offset, the first and the last of
 * them at its edges and six spread evenly between, hashed with the offset (32 KB read, whatever the file's length).
 */
const EDGE_BYTES = 4096, EDGE_SAMPLES = 8;
const edgesOf = (fd, end) => {
  const hash = createHash("sha256").update(`worktrust-read-position|${end}|`), buffer = Buffer.allocUnsafe(EDGE_BYTES);
  const starts = end <= EDGE_BYTES ? [0] : [...new Set(Array.from({ length: EDGE_SAMPLES }, (_, k) => Math.floor((k * (end - EDGE_BYTES)) / (EDGE_SAMPLES - 1))))];
  for (const from of starts) {
    const want = Math.min(EDGE_BYTES, end - from);
    let got = 0;
    while (got < want) { const n = readSync(fd, buffer, got, want - got, from + got); if (n <= 0) break; got += n; }
    READ_BYTES.n += got;
    hash.update(buffer.subarray(0, got));
  }
  return hash.digest("base64url").slice(0, 22);
};
/**
 * The lines from byte `from` (a line boundary), split on the newline BYTE, which no UTF-8 sequence holds, and decoded line by
 * line. `at`, when given, says where each yielded line starts (`at.line`) and, read through the same descriptor the lines came
 * from: the file's identity (`at.dev`, `at.ino`), the offset after its last newline (`at.end`, set before an unterminated last
 * line is yielded) and the hash of its edges before that offset (`at.hash`). `at.failed` is a read that failed (counted, as
 * always); `at.moved` a file that is not the one `expect` names (another identity, shorter than its offset, other bytes at its
 * edges): nothing is yielded and nothing counted, and the caller reads it whole.
 */
function* chunkedLines(file, from = 0, at = null, expect = null) {
  let fd;
  try { fd = openSync(file, "r"); } catch { READ_FAILURES.n += 1; if (at) at.failed = true; return; }
  try {
    if (at || expect) {
      let stat; try { stat = fstatSync(fd); } catch { READ_FAILURES.n += 1; if (at) at.failed = true; return; }
      if (at) { at.dev = String(stat.dev); at.ino = String(stat.ino); }
      if (expect) {
        let same = false;
        try { same = String(stat.dev) === expect.dev && String(stat.ino) === expect.ino && stat.size >= expect.end && expect.end >= from && (expect.end === 0 ? expect.hash === null : edgesOf(fd, expect.end) === expect.hash); } catch { same = false; }
        if (!same) { if (at) at.moved = true; return; }
      }
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = [], position = from, lineStart = from;
    for (;;) {
      let n;
      try { n = readSync(fd, buffer, 0, CHUNK_BYTES, position); } catch { READ_FAILURES.n += 1; if (at) at.failed = true; return; }
      if (n <= 0) break;
      READ_BYTES.n += n;
      const chunk = buffer.subarray(0, n);
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        const text = pending.length > 0 ? Buffer.concat([...pending, chunk.subarray(start, nl)]).toString("utf8") : chunk.toString("utf8", start, nl);
        pending = [];
        if (at) at.line = lineStart;
        lineStart = position + nl + 1; start = nl + 1;
        yield text;
      }
      if (start < n) pending.push(Buffer.from(chunk.subarray(start)));
      position += n;
    }
    if (at) { at.end = lineStart; try { at.hash = lineStart > 0 ? edgesOf(fd, lineStart) : null; } catch { READ_FAILURES.n += 1; at.failed = true; } }
    const rest = pending.length > 0 ? Buffer.concat(pending).toString("utf8") : "";
    if (rest) { if (at) at.line = lineStart; yield rest; }
  } finally { closeSync(fd); }
}
/** A Claude Code transcript's lines as objects from byte `from`, `at` and `expect` as chunkedLines takes them. */
function* claudeLinesFrom(file, from, at, expect) { for (const raw of chunkedLines(file, from, at, expect)) { if (!raw.trim()) continue; let line; try { line = JSON.parse(raw); } catch { continue; } yield line; } }
const fileLines = (file) => {
  try { closeSync(openSync(file, "r")); } catch (error) { if (error?.code !== "ENOENT") READ_FAILURES.n += 1; return null; }
  return { [Symbol.iterator]: () => chunkedLines(file) };
};
/** A transcript's lines as objects, whichever client wrote it; null when the file cannot be read. A Claude Code transcript is parsed lazily, as it is read. */
const parsedLines = (file) => {
  if (DATABASE_SESSION.test(file)) return databaseLines(file);
  const lines = fileLines(file);
  if (!lines) return null;
  if (CODEX_ROLLOUT.test(file)) return [...codexLines(lines)];
  if (ANTIGRAVITY_TRANSCRIPT.test(file)) { const id = antigravityIdOf(file); return [...antigravityLines(lines, { id, ...antigravityContext(id) })]; }
  return { *[Symbol.iterator]() { for (const raw of lines) { if (!raw.trim()) continue; try { yield JSON.parse(raw); } catch { /* a torn line */ } } } };
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
/**
 * owner/name of a remote WorkTrust can couple, or null (0.8.6, privacy by design). Only a repository on GitHub, GitLab or
 * Bitbucket can be joined to its commits, CI and deploys; the name of one on the person's own or a client's server
 * proves nothing and could name the client, so it is never sent. Nothing else of the remote is read.
 */
const CODE_HOSTS = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(github\.com|gitlab\.com|bitbucket\.org)[:/]/i;
const repoOf = (cwd) => {
  const remote = git(cwd, "remote", "get-url", "origin");
  if (!CODE_HOSTS.test(remote)) return null;
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : null;
};
/**
 * A REPOSITORY IT MAY NOT NAME, AS A CODE ONLY THIS COMPUTER CAN MAKE (owner, 2026-10-21). For a git repository whose remote is
 * on no host WorkTrust can couple (or that has no remote), the name still never travels (0.8.6); what travels is 16 hex of an
 * HMAC-SHA256, keyed with this computer's own secret (~/.worktrust/archive-salt, the archive's, made once with mode 600, never
 * sent), over the normalised remote (host and path, no user, no secret, no .git) or, without one, the repository's root. The
 * same repository gives the same code here, so its lines can be grouped and filed once; WorkTrust cannot turn a code back into
 * a name, because it never holds the key. A folder that is no git repository gets no code.
 */
let repoSecret;
const repoCodeSecret = () => {
  if (repoSecret !== undefined) return repoSecret;
  const file = join(homedir(), ".worktrust", "archive-salt");
  try { const kept = readPrivateFile(file)?.trim(); if (/^[0-9a-f]{64}$/.test(kept ?? "")) return (repoSecret = kept); } catch { /* first run */ }
  try { const made = randomBytes(32).toString("hex"); createPrivateFile(file, `${made}\n`); return (repoSecret = made); } catch { try { const kept = readPrivateFile(file)?.trim(); return (repoSecret = /^[0-9a-f]{64}$/.test(kept ?? "") ? kept : null); } catch { return (repoSecret = null); } }
};
const repoCodeOf = (cwd) => {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  if (!root) return null;
  const remote = git(cwd, "remote", "get-url", "origin");
  if (remote && CODE_HOSTS.test(remote)) return null;
  const name = remote
    ? `remote:${remote.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "").replace(/:(?!\d)/, "/").replace(/\.git$/, "").replace(/\/+$/, "")}`
    : `root:${root}`;
  const secret = repoCodeSecret();
  return secret ? createHmac("sha256", secret).update(`worktrust-repo-code|${name}`).digest("hex").slice(0, 16) : null;
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
/**
 * HOW THE SESSION WAS STARTED (owner, 2026-10-22; 0.10.29; docs/AGENT-HOURS.md): one word the client itself recorded, never a
 * guess, read by `sessionKindReader` in transcript-readers.mjs over the whole session (its entrypoint, its first turn's origin, a
 * Codex rollout's source) and sent beside a timeline as `session_kind` when it is interactive, headless or scheduled; unknown is
 * left unsaid, and WorkTrust reads an unsaid kind as interactive. A copy without the readers reads every session as unknown.
 * WorkTrust counts a headless or scheduled session as Agent operations, never as the person's hours.
 */
/**
 * THE READ POSITION (0.10.32, owner 2026-10-28: the owner's session was 805 MB after 24 days, and every hook run and every
 * hourly Stop sweep read it from its first byte, because the watermark is a TIME filter). Beside a Claude Code transcript's
 * watermark the hook keeps where its last read ended, and the next run reads only what it has to. Per file (the session's
 * own and each of its subagents'):
 *   d, i   the file's identity (device and inode), read through the descriptor the lines came from;
 *   e      the offset after the last newline read (an unterminated last line is read again next time);
 *   h      a hash of eight 4 KB samples before `e` (its edges and six between): a file truncated, rewritten, rotated or compacted
 *          fails it, or its identity or length does (a change between the samples of a file the client only appends to is not seen);
 *   c / s  the CARRY: what a full read would know at `e` of the lines it does not read again (the session's last cwd, the last
 *          `steered` a line said, the session-kind reader's state; a subagent's first moment);
 *   b      the offset of the first line holding a message after `t`: every line before it holds none, so a run whose watermark
 *          is `t` or later skips it unread. `b` is at or before the start of the earliest day not yet sent, and a day that spans
 *          the offset is therefore read again whole, from its first message: nothing of a stretch is kept between runs.
 * and per transcript: `t` (the watermark `b` was cut for) and `v` (this hook's digest and the measure rules it ran under).
 * A run resumes only with the same `v`, a watermark at or past `t`, and a file whose identity, length (at least `e`) and edges
 * agree; it then reads from `b`, letting the lines between `b` and `e` add messages only and the lines from `e` on add both
 * messages and carry. Anything else is a full read, as before 0.10.32: a new CLI, other measure rules, a state written without
 * positions, a watermark moved back, a file that changed. The re-measure (`--history`, `--history --rebuild`, the offer after
 * an update) never resumes. Proven equal to a full read by scripts/test-cli-read-position.mjs.
 */
const positionKey = () => (selfDigest ? `${selfDigest.slice(0, 16)}|${DAY_RULES}` : null);
const resumesHere = (file) => /\.jsonl$/.test(String(file)) && !CODEX_ROLLOUT.test(file) && !ANTIGRAVITY_TRANSCRIPT.test(file) && !DATABASE_SESSION.test(file) && typeof sessionKindReader().state === "function";
const resumable = (saved, since) => Boolean(saved && typeof saved === "object" && positionKey() !== null && saved.v === positionKey() && (saved.t === null || (Number.isFinite(saved.t) && since !== null && since >= saved.t)));
const fileMarkOk = (mark) => Boolean(mark && typeof mark === "object" && typeof mark.d === "string" && typeof mark.i === "string" && Number.isSafeInteger(mark.e) && Number.isSafeInteger(mark.b) && mark.b >= 0 && mark.b <= mark.e && (mark.h === null ? mark.e === 0 : typeof mark.h === "string"));
const expectOf = (mark) => ({ dev: mark.d, ino: mark.i, end: mark.e, hash: mark.h });
/** The first line holding a message after `t`, among the messages read ([moment, line start]); `end` when there is none. */
const firstAfter = (pairs, t, end) => { let b = end; for (const [ms, start] of pairs) if ((t === null || ms > t) && start < b) b = start; return b; };
function stretchesOf(file, since, saved = null) {
  if (resumesHere(file)) return claudeStretchesOf(file, since, resumable(saved, since) ? saved : null);
  // A file we cannot read is no days, never a null the caller has to remember to check: this
  // returns a list now, and one caller forgetting that is one silent crash inside a hook.
  const lines = parsedLines(file);
  if (!lines) return [];
  const messages = [];
  let cwd = null, steered = STEERED_HERE;
  const kind = sessionKindReader();
  for (const line of lines) {
    if (typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.steered === "string") steered = line.steered; // a client that says how it was steered (Hermes's source)
    kind.note(line);
    if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
    const at = Date.parse(line.timestamp);
    if (!Number.isFinite(at)) continue;
    if (since && at <= since) continue;
    messages.push(messageOf(line, at));
  }
  if (messages.length === 0) return [];
  messages.sort((a, b) => a.at - b.at);
  const byDay = byDayOf(messages);
  const agents = agentsByDay(file, since), session = kind.kind();
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ofDay]) => { const stretch = measure(cwd, ofDay, session); return stretch && { ...stretch, ref: stretchRef(file, day), steered, session, agents: agents.get(day) ?? null, live: liveOf(file, day) }; }).filter(Boolean);
}
/** stretchesOf for a Claude Code transcript, from its read position when `saved` holds a usable one; `positionAt(t)` on the list is the position to keep. */
function claudeStretchesOf(file, since, saved) {
  if (!fileLines(file)) return [];
  const prior = saved && fileMarkOk(saved.f) && saved.f.c && typeof saved.f.c === "object" ? saved.f : null;
  const at = {}, pairs = [], messages = [];
  let cwd = typeof prior?.c.cwd === "string" ? prior.c.cwd : null, lineSteered = typeof prior?.c.steered === "string" ? prior.c.steered : null, carry = null;
  const kind = sessionKindReader(prior?.c.kind ?? null), scanFrom = prior ? prior.e : 0;
  const snap = () => ({ cwd, steered: lineSteered, kind: kind.state() });
  for (const line of claudeLinesFrom(file, prior ? prior.b : 0, at, prior ? expectOf(prior) : null)) {
    if (carry === null && at.end !== undefined) carry = snap(); // the unterminated last line is past `e`: the carry stops before it
    if (at.line >= scanFrom) {
      if (typeof line.cwd === "string") cwd = line.cwd;
      if (typeof line.steered === "string") lineSteered = line.steered;
      kind.note(line);
    }
    if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
    const ms = Date.parse(line.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (since && ms <= since) continue;
    messages.push(messageOf(line, ms)); pairs.push([ms, at.line]);
  }
  if (at.moved) return claudeStretchesOf(file, since, null);
  if (carry === null && at.end !== undefined) carry = snap();
  const steered = lineSteered ?? STEERED_HERE;
  let stretches = [], subs = null;
  if (messages.length > 0) {
    messages.sort((a, b) => a.at - b.at);
    const byDay = byDayOf(messages), positions = {};
    const agents = agentsByDay(file, since, saved?.a ?? null, positions), session = kind.kind();
    subs = positions;
    stretches = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ofDay]) => { const stretch = measure(cwd, ofDay, session); return stretch && { ...stretch, ref: stretchRef(file, day), steered, session, agents: agents.get(day) ?? null, live: liveOf(file, day) }; }).filter(Boolean);
  }
  // A read that failed keeps no position: the next run reads the file whole.
  if (!at.failed && at.end !== undefined && carry !== null) {
    stretches.positionAt = (t) => ({ v: positionKey(), t: t ?? null, f: { d: at.dev, i: at.ino, e: at.end, b: firstAfter(pairs, t ?? null, at.end), h: at.hash ?? null, c: carry },
      // Subagents not read this run (no message after the watermark) keep the marks they had: each was cut for a watermark at or before this one.
      a: subs ? Object.fromEntries(Object.entries(subs).map(([name, markAt]) => [name, markAt(t ?? null)]).filter(([, mark]) => mark)) : (saved?.a && typeof saved.a === "object" ? saved.a : {}) });
  }
  return stretches;
}

/**
 * DAYS SPLIT ON THE CLOCK, NOTHING LOST AT MIDNIGHT (0.6.18, audit C14). A stretch is one session's UTC day, and the gap
 * between a day's last message and the next day's first belonged to neither, so a run through the night lost one gap
 * per midnight. A day whose first message follows the last one within the sweep's half hour (the session never went quiet)
 * now opens with a BRIDGE: the message before it, carrying no tokens, no model and no turn, so the gap that crosses midnight
 * is in the day's timeline once, on the day it ends, for the server to count as it counts any other gap.
 * Messages must arrive sorted.
 */
function byDayOf(messages) {
  const byDay = new Map();
  let prev = null;
  for (const message of messages) {
    const day = new Date(message.at).toISOString().slice(0, 10);
    // Only a gap the work could have run through (no half hour of quiet): a session resumed the next morning opens its day as it always did.
    if (!byDay.has(day)) byDay.set(day, prev && message.at - prev.at <= IDLE_BEFORE_SWEEP ? [{ ...prev, usage: null, model: null, cumulative: false, bridge: true }] : []);
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
    // 0.8.7: the permission mode the client recorded for this turn (Claude Code's own word; a reader's for Codex), never more.
    permissionMode: typeof line.permissionMode === "string" ? line.permissionMode : null,
    // A tool's answer comes back on the user role; a line a reader marks `agentic` is an agent run (Copilot's asked → completed).
    kind: line.type === "assistant" ? "assistant" : blocks.some((block) => block && block.type === "tool_result") ? "tool_result" : "user",
    toolUse: line.type === "assistant" && blocks.some((block) => block && block.type === "tool_use"),
    // A tool that waits for the PERSON (a question, a plan to approve): the gap to its result is the person's, not the tool's. The name is read, never the input.
    waitsForPerson: line.type === "assistant" && blocks.some((block) => block && block.type === "tool_use" && WAITS_FOR_PERSON.has(String(block.name))),
    agentic: line.agentic === true, cumulative: line.cumulative === true, // the session's running totals (Hermes, Goose without a ledger)
    // 0.10.32 (owner, 2026-10-28): who wrote a turn on the person's role (true the person, false a program or a timer, null not said),
    // and an answer that did not complete (the app's own API-error line, a refusal), read for the call's outcome and never kept.
    byPerson: line.type === "user" ? turnByPerson(line) : null,
    failedAnswer: line.type === "assistant" && (line.isApiErrorMessage === true || line.message?.stop_reason === "refusal"),
    // 0.7.1: each tool call's kinds (never its command) and each tool result's outcome, joined on the call's id in `measure`.
    // 0.7.2: and the call's FAMILY (the tool, and its check kinds) and a digest of its input, compared here and never kept.
    calls: line.type === "assistant" ? blocks.filter((block) => block && block.type === "tool_use" && typeof block.id === "string").map(callOf) : [],
    results: blocks.filter((block) => block && block.type === "tool_result" && typeof block.tool_use_id === "string").map(resultOf),
  };
};

/**
 * SUBAGENTS AS AGENT TIME, NEVER AS HOURS (owner, 2026-10-06; AGENTS ACTIVE AT ONCE, 0.10.32, owner 2026-10-28). Claude Code
 * writes each subagent's transcript beside its session (`<session>/subagents/*.jsonl`, and a `.meta.json` saying how it was
 * started). Each run that started on a day rides with that day's stretch as one entry of `agents`, by position (the ordinal),
 * never a name, a prompt, a path or an id: its kind (`fork`, else `background`, else `builtin` or the person's `own` type), its
 * start in whole seconds from the stretch's start, its ACTIVE intervals from that start ([from, to, from, to, …]; a gap over
 * 300 s ends one) and its tool failures and recoveries (stretch-evidence's own rule). At most AGENT_RUNS runs a stretch,
 * AGENT_INTERVALS intervals a run and AGENT_INTERVALS_TOTAL in all, the longest kept: a dropped one reads as less, never more.
 * WorkTrust counts a run only inside its parent's steered window (docs/AGENT-HOURS.md). Only Claude Code keeps subagents this way.
 */
const AGENT_RUNS = 64, AGENT_INTERVALS = 12, AGENT_INTERVALS_TOTAL = 256, AGENT_GAP_MS = 300_000, BUILTIN_AGENTS = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "output-style-setup", "claude-code-guide"]);
const agentKindOf = (meta) => (meta?.isFork === true || meta?.agentType === "fork" ? "fork" : meta?.requestShape === "background" ? "background" : meta?.isBuiltIn === true || !meta || BUILTIN_AGENTS.has(meta.agentType) ? "builtin" : "own");
function subagentFiles(file) {
  if (!/\.jsonl$/.test(String(file)) || CODEX_ROLLOUT.test(file) || ANTIGRAVITY_TRANSCRIPT.test(file) || DATABASE_SESSION.test(file)) return [];
  const dir = join(String(file).replace(/\.jsonl$/, ""), "subagents");
  try { return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)); } catch { return []; }
}
/** A file whose identity, length and edges are still those of its mark: the bytes before `e` are the ones read then. */
const unchangedSince = (file, mark) => { let fd; try { fd = openSync(file, "r"); } catch { return false; } try { const stat = fstatSync(fd); return String(stat.dev) === mark.d && String(stat.ino) === mark.i && stat.size >= mark.e && (mark.e === 0 ? mark.h === null : edgesOf(fd, mark.e) === mark.h); } catch { return false; } finally { closeSync(fd); } };
/** One subagent transcript's lines, from its mark when it has a usable one: its first moment, its stamps and messages after `since`, and the mark to keep. */
function subagentRead(sub, since, prior) {
  const at = {}, stamps = [], messages = [], pairs = [];
  let started = prior ? (Number.isFinite(prior.s) ? prior.s : Infinity) : Infinity, carry = null;
  for (const line of claudeLinesFrom(sub, prior ? prior.b : 0, at, prior ? expectOf(prior) : null)) {
    if (carry === null && at.end !== undefined) carry = started;
    if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
    const ms = Date.parse(line.timestamp);
    if (!Number.isFinite(ms)) continue;
    started = Math.min(started, ms); // a line between `b` and `e` is in the carried minimum already: a minimum taken twice is the same
    if (!(since && ms <= since)) { stamps.push(ms); messages.push(messageOf(line, ms)); pairs.push([ms, at.line]); }
  }
  if (at.moved) return subagentRead(sub, since, null);
  if (carry === null && at.end !== undefined) carry = started;
  const markAt = at.failed || at.end === undefined || carry === null ? () => null : (t) => ({ d: at.dev, i: at.ino, e: at.end, b: firstAfter(pairs, t, at.end), h: at.hash ?? null, s: Number.isFinite(carry) ? carry : null });
  return { started, stamps, messages, markAt };
}
function agentsByDay(file, since, saved = null, positions = null) {
  const byDay = new Map();
  for (const sub of subagentFiles(file)) {
    const name = String(sub).split(/[\\/]/).pop(), prior = positions && saved && typeof saved === "object" && fileMarkOk(saved[name]) && (saved[name].s === null || Number.isFinite(saved[name].s)) ? saved[name] : null;
    // A RUN THAT STARTED AT OR BEFORE THE WATERMARK is not counted (below), and lines appended since cannot make it start later:
    // a subagent whose kept first moment is at or before the watermark, its bytes unchanged, is not opened again.
    if (prior && since && prior.s !== null && prior.s <= since && unchangedSince(sub, prior)) { positions[name] = () => prior; continue; }
    if (positions ? !fileLines(sub) : false) continue;
    let stamps, messages, started;
    if (positions) { const read = subagentRead(sub, since, prior); ({ stamps, messages, started } = read); positions[name] = read.markAt; }
    else {
    const lines = parsedLines(sub);
    if (!lines) continue;
    stamps = []; messages = [];
    started = Infinity;
    for (const line of lines) {
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) continue;
      started = Math.min(started, at);
      if (!(since && at <= since)) { stamps.push(at); messages.push(messageOf(line, at)); }
    }
    }
    // A RUN IS COUNTED ONCE, on the side of the watermark where it STARTED (review, 2026-10-06), and on the day it started: a run
    // that straddles the watermark was sent with the day it began; what it did after the watermark stays unsent (the safe direction).
    if (stamps.length === 0 || (since && started <= since)) continue;
    stamps.sort((a, b) => a - b); messages.sort((a, b) => a.at - b.at);
    const day = new Date(stamps[0]).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { runs: 0, spans: [], list: [] });
    const entry = byDay.get(day), recovery = recoveryOf ? recoveryOf(messages) : null;
    let meta = null; try { meta = JSON.parse(readFileSync(sub.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { /* an older client wrote none */ }
    entry.runs += 1; entry.spans.push([stamps[0], stamps[stamps.length - 1]]);
    entry.list.push({ stamps, kind: agentKindOf(meta), failures: recovery?.failures ?? 0, recovered: recovery?.recovered ?? 0 });
  }
  for (const entry of byDay.values()) entry.peak = peakOf(entry.spans);
  return byDay;
}
/** A day's runs → the payload's `agents`, from the stretch's first moment: whole seconds, the caps applied, null when none ran. */
function agentRunsOf(list, from) {
  const longest = (items, cap, length) => (items.length <= cap ? items : items.map((item, at) => ({ item, at })).sort((a, b) => length(b.item) - length(a.item) || a.at - b.at).slice(0, cap).sort((a, b) => a.at - b.at).map(({ item }) => item));
  const runs = (list ?? []).map((run) => {
    const spans = [];
    for (const at of run.stamps) { const last = spans.at(-1); if (last && at - last[1] <= AGENT_GAP_MS) last[1] = at; else spans.push([at, at]); }
    return { ...run, spans: spans.map(([lo, hi]) => [Math.max(0, Math.round((lo - from) / 1000)), Math.max(0, Math.round((hi - from) / 1000))]).filter(([lo, hi]) => hi > lo) };
  }).filter((run) => run.spans.length > 0);
  const kept = longest(runs, AGENT_RUNS, (run) => run.spans.reduce((total, [lo, hi]) => total + hi - lo, 0)), length = ([lo, hi]) => hi - lo;
  let per = AGENT_INTERVALS; // the most intervals a run keeps so that all of them together stay inside AGENT_INTERVALS_TOTAL
  while (per > 1 && kept.reduce((total, run) => total + Math.min(per, run.spans.length), 0) > AGENT_INTERVALS_TOTAL) per -= 1;
  return kept.length > 0 ? kept.map((run) => { const spans = longest(run.spans, per, length), start = spans[0][0];
    return { kind: run.kind, start, active: spans.flatMap(([lo, hi]) => [lo - start, hi - start]), failures: run.failures, recovered: Math.min(run.recovered, run.failures) }; }).sort((a, b) => a.start - b.start) : null;
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

/** One day's messages → the stretch: its timeline, its tokens, its model. The server measures it. */
function measure(cwd, messages, session = null) {
  // THE CLOCK IS THE SERVER'S (0.10.20). This hook sends the stretch's timeline and never a duration of its own: every
  // second WorkTrust counts lies between two recorded timestamps in that timeline, under WorkTrust's rules, and a stretch
  // too short to time is a stretch WorkTrust answers without a duration. A stretch whose clocks give nothing is still
  // reported, so a commit beside it can be joined to a moment somebody was there.
  const models = new Map();
  for (const message of messages) if (message.model) models.set(message.model, (models.get(message.model) ?? 0) + 1);
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tokens = tokensOf(messages);
  const from = firstOf(messages);
  const unattended = session === "headless" || session === "scheduled";
  return { cwd, derived: deriveStretch(messages, { isHumanTurn, INTERRUPTED, textOf }), timeline: messages.length > 0 ? timelineOf(messages, unattended) : null, outcomes: messages.length > 0 ? callOutcomesOf(messages) : null, lengths: inputLengthsOf(messages, unattended), ...tokens, cumulative: messages.some((message) => message.cumulative), model, from, to: messages[messages.length - 1].at, offset: offsetAt(from) };
}

/**
 * THE TIMELINE, FOR THE SERVER'S OWN CLOCK (0.10.20, owner 2026-10-18: "the calculation must be done by our system; we only get
 * metadata"). One step per message, as the KIND the measure read it as and the whole seconds since the previous step; the
 * first step carries 0, a bridge is lowercase, an agent run is marked G. Nothing of a message travels: not a word, not a
 * tool's name, not a path. WorkTrust computes `seconds`, the hours in layers, the turns, the interruptions and the mid-task
 * turns from this with its own rules (private to the server); this file sends no figure of its own, so nothing in it can
 * move the passport.
 */
// 0.10.32: in a run no person started (headless, scheduled) a turn is H only when the app marked it the person's; a program's or
// a timer's prompt is U, so WorkTrust's clock steers only from a person's input.
const stepKindOf = (message, unattended) => message.kind === "assistant" ? (message.waitsForPerson ? "W" : message.toolUse ? "T" : "A") : message.kind === "tool_result" ? "R" : INTERRUPTED.test(textOf(message.content).trim()) && !message.meta ? "I" : !message.meta && isHumanTurn(message.content) && (!unattended || message.byPerson === true) ? "H" : "U";
function timelineOf(messages, unattended = false) {
  let out = "";
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const gap = i === 0 ? 0 : Math.max(0, Math.round((message.at - messages[i - 1].at) / 1000));
    const kind = stepKindOf(message, unattended);
    out += `${message.agentic ? "G" : ""}${message.bridge ? kind.toLowerCase() : kind}${Math.min(999999, gap)}`;
  }
  return out;
}
/**
 * THE PERSON'S INPUTS, AS LENGTH BUCKETS (owner, 2026-10-28; 0.10.32): in a run no person started, one character per H step of
 * the timeline: s up to 80 characters, m up to 400, l longer. Counted here, never sent as text; WorkTrust's steering cap reads it
 * to tell a regular rhythm of short nudges from real steering, as a review signal only.
 */
function inputLengthsOf(messages, unattended) {
  if (!unattended) return null;
  let out = "";
  for (const message of messages) if (stepKindOf(message, unattended) === "H") { const n = textOf(message.content).trim().length; out += n <= 80 ? "s" : n <= 400 ? "m" : "l"; }
  return out.length > 0 ? out : null;
}
/**
 * EACH CALL'S OUTCOME (owner, 2026-10-28; 0.10.32; docs/AGENTIC-OPERATIONS.md "2b"): one character per model answer step of the
 * timeline (A, T, W), in its order. 1: it completed; 0: it did not (a tool result the app marked as an error, a timeout or a
 * refusal among them; an API-error or refusal answer); ?: not known (a tool call without its result, a result no reader could see).
 * A question to the person (W) completed when it was put. Read from the app's own markers, never from a duration; nothing of a
 * message travels.
 */
function callOutcomesOf(messages) {
  const failed = new Map();
  for (const message of messages) for (const result of message.results ?? []) if (result && typeof result.id === "string") failed.set(result.id, result.failed);
  let out = "";
  for (const message of messages) {
    if (message.kind !== "assistant") continue;
    if (message.failedAnswer) { out += "0"; continue; }
    if (message.waitsForPerson || !message.toolUse) { out += "1"; continue; }
    const outcomes = (message.calls ?? []).map((call) => (failed.has(call.id) ? failed.get(call.id) : null));
    out += outcomes.some((one) => one === true) ? "0" : outcomes.length > 0 && outcomes.every((one) => one === false) ? "1" : "?";
  }
  return /[01]/.test(out) ? out : null;
}
/** A digest of this hook and the readers beside it, as installed: the door records it beside each line as a signal of which code ran, never as proof. */
const selfDigest = (() => { try { const here = dirname(fileURLToPath(import.meta.url)); const hash = createHash("sha256"); for (const name of ["log-session.mjs", ...READER_FILES].sort()) { try { hash.update(`${name}\0`).update(readFileSync(join(here, name))).update("\0"); } catch { hash.update(`${name}\0missing\0`); } } return hash.digest("hex"); } catch { return null; } })();
const CLI_VERSION_SENT = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/.test(process.env.WORKTRUST_CLI_VERSION ?? "") ? process.env.WORKTRUST_CLI_VERSION : null; // `worktrust.mjs` hands its own version to the hook it starts

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
  const repoCode = cwd && !repo ? repoCodeOf(cwd) : null; // a code, never a name, for a repository it may not name
  const touched = cwd ? pathsTouched(cwd, new Date(stretch.from).toISOString(), new Date(stretch.to).toISOString()) : { paths: [], committed: false, shas: [] };
  const { layer, layers } = layersOf(touched.paths), stack = stackOfFiles(touched.paths), toolsSeen = displayStackOfFiles(touched.paths); // 0.10.11: the stack and the tools seen, from the same paths, keys only, two fields
  // The seventh kind, used as it is defined: a stretch that changed no artefact is knowing
  // something, not building something, and it earns neither an artefact's nor a validation's credit.
  const kind = touched.paths.length === 0 ? "researched" : touched.committed ? "changed" : "built";
  // 0.8.1: what the stretch changed, as counts of files (never their paths): how many, and how many of them tests.
  // 0.7.6: and the stretch's complexity class, read from what the hook knows here (layers, subagents, duration) and the record.
  const changed = [...new Set(touched.paths)], tests = changed.filter((path) => TEST_PATH.test(path)).length;
  // 0.8.7: of the stretch's commits, how many name an AI as co-author (the Co-authored-by trailer, read here, never kept).
  const coauthored = cwd && touched.shas.length > 0 ? git(cwd, "log", "--no-walk", "--format=%(trailers:key=Co-authored-by,valueonly,separator=%x01)%x00", ...touched.shas.slice(0, 50)).split("\0").filter((entry, index) => index < Math.min(50, touched.shas.length) && AI_COAUTHOR.test(entry)).length : 0;
  const route = { ...(stretch.derived?.route ?? {}), ...(touched.committed ? gitRouteOf(cwd, touched.shas, changed) : {}) };
  const derived = stretch.derived ? { ...stretch.derived, ...(Object.keys(route).length > 0 ? { route } : {}), ...(changed.length > 0 ? { changes: { files: changed.length, test_files: tests } } : {}), ...(touched.shas.length > 0 ? { authorship: { commits: Math.min(50, touched.shas.length), ai_coauthored: coauthored } } : {}), ...(contextFilesOf(changed) ? { context_files: contextFilesOf(changed) } : {}), ...(complexityOf ? { complexity: complexityOf(stretch.derived, { layers: Math.max(layers.length, layer ? 1 : 0), agentRuns: stretch.agents?.runs ?? 0, agentPeak: stretch.agents?.peak ?? 0, seconds: null }) } : {}) } : null;
  const agents = agentRunsOf(stretch.agents?.list, stretch.from);
  const evidence = derived || stretch.live ? { ...(derived ?? {}), ...(stretch.live ? { live: stretch.live } : {}) } : null; // 0.10.15: the mod's counts ride as their own group
  const payload = {
    title: layer ? `AI-assisted work · ${layer}` : "AI-assisted work",
    kind,
    ...(layer ? { layer } : {}),
    ...(layers.length > 1 ? { layers } : {}),
    ...(stack.length > 0 ? { stack } : {}),
    ...(toolsSeen.length > 0 ? { tools_seen: toolsSeen } : {}), // its own line: the payload allowlist (hook-presence) reads the key here
    // THE TIMELINE AND ITS BASIS, both or neither (0.10.20): the basis says the timeline was read from the app's own folder
    // on this computer; WorkTrust computes the duration from the timeline, and a timeline too short to time gets none.
    ...(stretch.timeline ? { timeline: stretch.timeline, duration_basis: "measured" } : {}),
    // Tokens only when the usage block's shape is the one this script knows — otherwise nothing, never a guess.
    ...(stretch.shapeKnown && stretch.tokensIn + stretch.tokensOut > 0 ? { tokens_in: stretch.tokensIn, tokens_out: stretch.tokensOut, token_basis: "newInput" } : {}),
    // The turns WorkTrust counts from the timeline are the person's own messages, tool results excluded — said explicitly,
    // because a row that does not say reads as the old count, which included them.
    ...(stretch.timeline ? { turn_basis: "humanOnly" } : {}),
    // The cache halves, as counts, beside the tokens (roadmap 16): read from a cache, written into one.
    ...(stretch.shapeKnown && stretch.cacheRead > 0 ? { tokens_cache_read: stretch.cacheRead } : {}),
    ...(stretch.shapeKnown && stretch.cacheWrite > 0 ? { tokens_cache_write: stretch.cacheWrite } : {}),
    ...(stretch.model ? { model: stretch.model } : {}),
    ...(repo ? { repo } : {}),
    ...(repoCode ? { repo_code: repoCode } : {}),
    ...(touched.shas.length > 0 ? { commits: touched.shas.slice(0, 50) } : {}),
    ...(stretch.ref ? { stretch_ref: stretch.ref } : {}), ...(stretch.steered ? { steered_from: stretch.steered } : {}),
    // HOW THE SESSION WAS STARTED (owner, 2026-10-22): interactive | headless | scheduled, beside the timeline; unknown is unsaid.
    ...(stretch.timeline && (stretch.session === "interactive" || stretch.session === "headless" || stretch.session === "scheduled") ? { session_kind: stretch.session } : {}),
    // EACH CALL'S OUTCOME and THE TIMER'S SCHEDULE (owner, 2026-10-28; 0.10.32): beside the timeline; a schedule only for a run no person started.
    ...(stretch.timeline && stretch.outcomes ? { call_outcomes: stretch.outcomes } : {}),
    ...(stretch.timeline && stretch.lengths && (stretch.session === "headless" || stretch.session === "scheduled") ? { input_lengths: stretch.lengths } : {}),
    ...(stretch.timeline && stretch.schedule && (stretch.session === "headless" || stretch.session === "scheduled") ? { schedule_cadence: stretch.schedule.cadence, schedule_ref: stretch.schedule.ref } : {}),
    // AGENTS ACTIVE AT ONCE (0.10.32, owner 2026-10-28): the subagent runs that started this day, beside the timeline (agentRunsOf).
    ...(stretch.timeline && agents ? { agents } : {}),
    // WHICH CODE SENT IT (0.10.20): a version and a digest of this hook's own files, signals never proof.
    ...(CLI_VERSION_SENT ? { cli_version: CLI_VERSION_SENT } : {}),
    ...(selfDigest ? { cli_digest: selfDigest } : {}),
    // WHEN (0.6.18): the stretch's first moment and the computer's UTC offset then; the interruptions and mid-task turns are WorkTrust's.
    started_at: new Date(stretch.from).toISOString(), utc_offset: stretch.offset,
    // THE STRETCH'S EVIDENCE (0.8.3): what the CLI derived from it here, kinds and counts only (stretch-evidence.mjs); the door keeps it from a CLI key alone.
    ...(evidence ? { evidence } : {}),
    at: new Date(stretch.to).toISOString(),
  };
  // WHAT STAYS ON THIS COMPUTER (0.7.1): the stretch's derived record rides beside the payload for the local archive, never in it.
  // The same record rides beside the payload for the local archive (preserve --archive).
  if (evidence) DERIVED.set(payload, evidence);
  return payload;
}

/**
 * The history door, in the batch size it asks for. Oldest first, and a resend is safe: every entry
 * is deduplicated on its content, and one that knows more than a stored line FILLS it rather than
 * adding a twin. Returns how many entries were accepted, so a caller can advance a watermark over
 * exactly what landed. `announce` because one caller is a person watching a terminal and the other
 * is a hook holding a session's exit open.
 */
/**
 * THE BATCHES: at most two hundred lines each. `byDay` (an export, 2026-10-10) never splits a UTC day across two batches unless
 * one day alone exceeds the cap: the door's receipt counts per day what it replaced and how many AI-app lines lie there, and a
 * day in two batches would be counted twice.
 */
/**
 * A batch stays under the door's ceilings for one history call (2026-10-23, docs/INTAKE-HARDENING.md): 2 MB a call and 1.5 MB of
 * timelines a call, each with room for the envelope. A timeline (0.10.20) is up to 200 KB a line, so a batch is cut by bytes
 * and by timeline bytes as well as by count. Until 0.10.28 the cut was 3.5 MB, under the door's 4.5 MB outer bound only.
 */
const BATCH_BYTES = 1_900_000;
const BATCH_TIMELINE_BYTES = 1_400_000;
/** One call's ceiling as the cut reads it: lines, bytes of the lines, bytes of their timelines (0.10.29: a re-split passes a tighter one). */
const BATCH_LIMIT = { lines: 200, bytes: BATCH_BYTES, timelineBytes: BATCH_TIMELINE_BYTES };
const bytesOf = (entry) => Buffer.byteLength(JSON.stringify(entry), "utf8");
const timelineOfEntry = (entry) => (typeof entry.timeline === "string" ? Buffer.byteLength(entry.timeline, "utf8") : 0);
const byBytes = (entries, limit = BATCH_LIMIT) => { const out = []; let current = [], size = 0, timelines = 0; for (const entry of entries) { const bytes = bytesOf(entry), timeline = timelineOfEntry(entry); if (current.length > 0 && (current.length >= limit.lines || size + bytes > limit.bytes || timelines + timeline > limit.timelineBytes)) { out.push(current); current = []; size = 0; timelines = 0; } current.push(entry); size += bytes; timelines += timeline; } if (current.length) out.push(current); return out; };
/** Whether a set of lines fits one call: the count, the bytes and the timelines. */
const fits = (entries, limit = BATCH_LIMIT) => entries.length <= limit.lines && entries.reduce((n, entry) => n + bytesOf(entry), 0) <= limit.bytes && entries.reduce((n, entry) => n + timelineOfEntry(entry), 0) <= limit.timelineBytes;
/** HALF OF A BATCH THE DOOR REFUSED (0.10.29): when WorkTrust answers 413 to lines this cut thought fit, the next cut is half of them. */
const halfOf = (entries) => ({ lines: Math.max(1, Math.ceil(entries.length / 2)), bytes: Math.ceil(entries.reduce((n, entry) => n + bytesOf(entry), 0) / 2), timelineBytes: Math.max(1, Math.ceil(entries.reduce((n, entry) => n + timelineOfEntry(entry), 0) / 2)) });
function batchesOf(group, byDay, limit = BATCH_LIMIT) {
  if (!byDay) return byBytes(group, limit);
  const days = new Map();
  for (const entry of group) { const day = String(entry.at).slice(0, 10); days.set(day, [...(days.get(day) ?? []), entry]); }
  const out = []; let current = [];
  for (const ofDay of days.values()) {
    // A day that alone does not fit one call is cut by bytes on its own; otherwise a day is never split across two calls.
    if (!fits(ofDay, limit)) { if (current.length) { out.push(current); current = []; } out.push(...byBytes(ofDay, limit)); continue; }
    if (!fits([...current, ...ofDay], limit)) { out.push(current); current = []; }
    current.push(...ofDay);
  }
  if (current.length) out.push(current);
  return out;
}
/** THE RECEIPTS' COUNTS (2026-10-10): what an export send replaced, how many AI-app lines lie on its days, how many were withdrawn; summed over the batches, read for the counts alone. */
const RECEIPTS = { new: 0, alreadyHeld: 0, filled: 0, replaced: 0, superseded: 0, recut: 0, unknownOnDays: 0, unknownWithdrawn: 0, corrected: 0, measuredSeconds: 0, staged: 0, kept: 0, restored: 0, untimed: 0 }; // 0.10.27: staged, the batches WorkTrust keeps on its server, and kept, their lines // 0.10.20: measuredSeconds is WorkTrust's own figure for what the batch stored, the one the terminal shows // 0.10.17: recut, the one-envelope export lines its runs replaced // 2026-10-10: and what a re-measure did (new, held, filled, replaced), so the command can say it
const noteReceipt = (answer) => {
  try {
    const json = JSON.parse(answer.trim().startsWith("{") ? answer : answer.split("\n").find((row) => row.startsWith("data:"))?.slice(5) ?? "null");
    const receipt = JSON.parse(json?.result?.content?.[0]?.text ?? "{}");
    for (const key of Object.keys(RECEIPTS)) RECEIPTS[key] += Number(receipt[key]) || 0;
    // THE QUEUE (0.10.32): the receipt of the batch that completes a run says where the run waits; the last one seen is kept.
    const queued = receipt.queued;
    if (queued && Number.isInteger(queued.position) && queued.position >= 1 && Number.isFinite(Number(queued.eta_minutes)) && Number(queued.eta_minutes) >= 0) QUEUED.at = { position: queued.position, eta_minutes: Math.max(1, Math.ceil(Number(queued.eta_minutes))) };
  } catch { /* a receipt unread leaves the counts short, never the send */ }
};
/** Where the last completed run waits in WorkTrust's queue (0.10.32): null when no receipt said so (an older server, or not complete yet). */
const QUEUED = { at: null };
/** Only explicit durable receipts authorize a checkpoint. HTTP 200 alone says nothing. */
function confirmedReceipt(answer, expectedCount = null) {
  try {
    const candidates = answer.trim().startsWith("{") ? [answer] : answer.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(line => line && line !== "[DONE]");
    const replies = candidates.map(text => JSON.parse(text)).filter(reply => reply?.id === 1);
    if (replies.length !== 1) throw Error();
    const reply = replies[0];
    if (reply.jsonrpc !== "2.0" || reply.error || !reply.result || reply.result.isError === true) throw Error();
    const content = reply.result.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0].type !== "text") throw Error();
    const receipt = JSON.parse(content[0].text);
    if (expectedCount === null) {
      if (!(receipt.receipt === "received" && ["accepted", "flagged", "pending"].includes(receipt.status)) && !(receipt.receipt === "unchanged" && receipt.reason === "duplicate")) throw Error();
    } else if (receipt.staged === true) {
      // KEPT ON THE SERVER (0.10.27): a batch of a run WorkTrust holds and rebuilds itself; every line counted as kept or refused.
      if (receipt.receipt !== "received" || receipt.received !== expectedCount || !Number.isInteger(receipt.kept) || receipt.kept < 0
        || !Number.isInteger(receipt.refused) || receipt.refused < 0 || receipt.kept + receipt.refused > expectedCount) throw Error();
    } else if (receipt.receipt !== "received" || receipt.received !== expectedCount || receipt.refused !== 0
      || !Number.isInteger(receipt.new) || receipt.new < 0 || !Number.isInteger(receipt.alreadyHeld) || receipt.alreadyHeld < 0
      || receipt.new + receipt.alreadyHeld !== expectedCount) throw Error();
    return receipt;
  } catch { throw Error("WorkTrust did not confirm every line; progress was not advanced. Retained metadata and safe retries remain available."); }
}
/** A private metadata journal survives retries, an edited transcript and a later CLI update. */
function retainMeasurement(payload, source) {
  const fields = ["stretch_ref", "at", "started_at", "timeline", "seconds", "client_seconds", "model_seconds", "tool_seconds", "human_seconds", "idle_seconds", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "exchanges", "interrupts", "steers", "agent_runs", "agent_seconds", "agent_peak", "agents", "duration_basis", "token_basis", "turn_basis", "cli_version", "cli_digest"];
  const metadata = Object.fromEntries(fields.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
  const body = JSON.stringify({ format: "worktrust-measurement/1", source: source ?? "claude", metadata }) + "\n";
  const parent = join(homedir(), ".worktrust"), dir = join(parent, "measurements");
  for (const path of [parent, dir]) { mkdirSync(path, { recursive: true, mode: 0o700 }); const st = lstatSync(path); if (!st.isDirectory() || st.isSymbolicLink()) throw Error("WorkTrust metadata directory is not a private directory"); }
  const file = join(dir, createHash("sha256").update(body).digest("hex") + ".json");
  if (existsSync(file)) { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || readFileSync(file, "utf8") !== body) throw Error("WorkTrust retained metadata did not match its digest"); return; }
  const temporary = join(dir, ".pending-" + randomBytes(18).toString("hex"));
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, body); fsyncSync(fd);
    try { linkSync(temporary, file); } catch (error) {
      if (error.code !== "EEXIST" || lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== body) throw error;
    }
  } finally { closeSync(fd); unlinkSync(temporary); }
}
const HISTORY_DELIVERY = { review: 0, waiting: 0, refused: 0 };
const HISTORY_PERSISTED = { n: 0 }; // 0.10.32: entries this run put in the outbox on disk (sent now or later, never lost)
/**
 * ONLY THE DAYS THAT CHANGED (0.10.32; owner, 2026-10-28: an identical re-run sends 0 days). Each UTC day of each AI app gets a
 * digest of its entries exactly as they are sent (the canonical JSON of each, `commits` gone, the CLI's own version and digest
 * left out, so an update that measures the same sends nothing), under the measure rules the command started this hook with.
 * Before a re-measure the door is asked, per AI app, which of this computer's days it still holds as current; it answers the
 * digests this computer sent with them (its own submissions, never the record). A day whose digest is the same is not sent.
 * An answer that is not one (an error, an older WorkTrust, no network) is NOT KNOWN, and every day goes, as before.
 */
const DAY_RULES = /^[1-9][0-9]{0,3}$/.test(process.env.WORKTRUST_MEASURE_RULES ?? "") ? process.env.WORKTRUST_MEASURE_RULES : "unknown";
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null");
const entryDigest = (entry) => { const { commits: _commits, cli_version: _version, cli_digest: _digest, ...rest } = entry; void _commits; void _version; void _digest; return createHash("sha256").update(canonical(rest)).digest("hex"); };
const dayOf = (entry) => new Date(entry.at).toISOString().slice(0, 10);
/** One AI app's entries → day → digest, over all of that app's entries of the day (a day cut across two batches has one digest). */
function dayDigests(entries) {
  const byDay = new Map();
  for (const entry of entries) { const day = dayOf(entry); byDay.set(day, [...(byDay.get(day) ?? []), entryDigest(entry)]); }
  return new Map([...byDay].map(([day, digests]) => [day, createHash("sha256").update(`worktrust-day/1|rules=${DAY_RULES}|${digests.sort().join("\n")}`).digest("hex")]));
}
/** The days the door holds as current for this computer and this AI app, or null when that is not known. Never throws. */
async function heldDays(target, source) {
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { rebuild: true, fingerprint: true } } });
    const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...clientOf(source, true), ...proofFor(target.url, body) }, body, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const text = await response.text();
    const json = JSON.parse(text.trim().startsWith("{") ? text : text.split("\n").find((row) => row.startsWith("data:"))?.slice(5) ?? "null");
    if (json?.jsonrpc !== "2.0" || json.error || !json.result || json.result.isError === true) return null;
    const answer = JSON.parse(json.result.content?.[0]?.text ?? "null");
    if (answer?.receipt !== "fingerprint" || !answer.days || typeof answer.days !== "object" || Array.isArray(answer.days)) return null;
    const held = new Map();
    for (const [day, digest] of Object.entries(answer.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) held.set(day, digest);
    return held;
  } catch { return null; }
}
/**
 * A READ FAILURE, KEPT AND TOLD (0.10.32): the count lands in sessions.json (`__unreadable`, which `npx worktrust status`
 * prints) and, at most once a day, reaches WorkTrust as the fingerprint question with the count beside it
 * (`unreadable: n`): a number, never a file name, a path or a line. A run that read everything clears the count.
 */
async function settleReadFailures(target, held = null) {
  // `held`: the hook's own state object, which later steps write back whole; the count goes into it, not beside it.
  const state = held ?? readState(), now = new Date().toISOString();
  if (READ_FAILURES.n === 0) { if (state.__unreadable?.count) { state.__unreadable = { count: 0, at: now }; writeState(state); } return; }
  state.__unreadable = { count: READ_FAILURES.n, at: now };
  const told = Date.parse(state.__unreadableTold ?? "") || 0;
  if (target?.url && target?.token && Date.now() - told > 24 * 3600_000) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { rebuild: true, fingerprint: true, unreadable: Math.min(1000, READ_FAILURES.n) } } });
      const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...clientOf(undefined, true), ...proofFor(target.url, body) }, body, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (response.ok) state.__unreadableTold = now;
    } catch { /* told next time */ }
  }
  writeState(state);
}
/** What the comparison found, for the command's one line: distinct days compared, and of them how many changed. */
const COMPARED = { days: 0, changed: 0, asked: false };
/** A re-measure's entries, less every (AI app, day) whose digest WorkTrust holds as current. */
async function changedOnly(entries) {
  const bySource = new Map();
  for (const entry of entries) { const source = entrySource.get(entry) ?? "claude"; bySource.set(source, [...(bySource.get(source) ?? []), entry]); }
  const keep = new Set(), allDays = new Set(), changedDays = new Set();
  for (const [source, group] of bySource) {
    const target = source === "codex" ? codexDoor ?? door : door;
    const digests = dayDigests(group);
    const held = target ? await heldDays(target, source) : null;
    if (held !== null) COMPARED.asked = true;
    for (const [day, digest] of digests) { allDays.add(day); if (held?.get(day) !== digest) changedDays.add(`${source}|${day}`); }
    for (const entry of group) if (changedDays.has(`${source}|${dayOf(entry)}`)) keep.add(entry);
  }
  COMPARED.days = allDays.size;
  COMPARED.changed = new Set([...changedDays].map((key) => key.split("|")[1])).size;
  return entries.filter((entry) => keep.has(entry));
}
/**
 * ONE RUN PER COUPLING (0.10.27; owner, 2026-10-21: re-measured history is kept on the server). The batches of a re-measure
 * to one key are one run: an id, each batch's number and the run's count ride in every batch, and WorkTrust keeps each batch
 * it receives and rebuilds the run's days itself, every AI app of the run together, once all of them have arrived. The id is
 * a digest of the UTC day and the run's batches, never of a key: the same plan sent again the same day is the same run, so a
 * batch already received is neither uploaded nor kept twice. Never an export, a copied folder or the hook's late days.
 */
const historyRunId = (bodies) => {
  const h = createHash("sha256").update(`worktrust-history-run|${new Date().toISOString().slice(0, 10)}|${bodies.join("\n")}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/**
 * THE PLAN OF A HISTORY SEND (0.10.29: one function, read by the send and by `--summary`, so the numbers a dry run prints are the
 * batches the send would make). Each source and its approved coupling separate; a re-measure is one staged run per coupling.
 */
function historyPlan(door, entries, rebuild = false, { byDay = false, withdrawUnknown = false } = {}) {
  const groups = [["claude", entries.filter((entry) => !entrySource.has(entry))], ["codex", entries.filter((entry) => entrySource.get(entry) === "codex")], ...["antigravity", ...DATABASE_CLIENTS, ...EXPORT_CLIENTS].map((client) => [client, entries.filter((entry) => entrySource.get(entry) === client)])];
  // Imported entries carry no live commit/session join.
  const encodeBatch = (batch, run = null, days = null) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { ...(rebuild ? { rebuild: true } : {}), ...(withdrawUnknown ? { withdraw_unknown: true } : {}), entries: batch.map(({commits, ...rest}) => { void commits; return rest; }), ...(run ? { run } : {}), ...(days ? { days } : {}) } } });
  const plan = groups.flatMap(([source, group]) => { const target = source === "codex" ? codexDoor ?? door : door; return group.length > 0 && target ? batchesOf(group, byDay).map((batch) => ({ source, target, batch, run: null })) : []; });
  if (rebuild && !byDay) for (const token of new Set(plan.map((item) => item.target.token))) {
    const run = plan.filter((item) => item.target.token === token), id = historyRunId(run.map((item) => encodeBatch(item.batch)));
    run.forEach((item, index) => { item.run = { id, index, count: run.length }; });
  }
  // 0.10.32: each batch of a staged run names its days' digests (of the AI app's whole plan for the day), only the days it carries.
  const digestsOf = new Map(groups.map(([source, group]) => [source, dayDigests(group)]));
  for (const item of plan) item.body = encodeBatch(item.batch, item.run, item.run ? daysOf(item.batch, digestsOf.get(item.source)) : null);
  return plan;
}
/**
 * THE OUTBOX'S CUT (0.10.29). history-outbox.mjs never reads a transcript, so the hook hands it this one: `fits` is the door's
 * ceiling as above; `split` cuts one plain batch again (an export's by whole days, as it was planned); `replan` cuts a staged
 * run's batches again, each AI app on its own, under a new run id and count. `tighter` is a batch WorkTrust answered 413 although
 * it fit here: the next cut is half of it, so every piece is smaller than what was refused and a refused batch never goes again.
 */
/** A batch's own days and their digests, from the AI app's day digests. */
const daysOf = (batch, digests) => Object.fromEntries([...new Set(batch.map(dayOf))].sort().filter((day) => digests?.has(day)).map((day) => [day, digests.get(day)]));
const outboxCut = {
  fits: (entries) => fits(entries),
  split(rpc, source, tighter) {
    const args = rpc.params.arguments, pieces = batchesOf(args.entries, EXPORT_CLIENTS.includes(source), tighter ? halfOf(tighter) : BATCH_LIMIT);
    return pieces.length < 2 ? [] : pieces.map((batch) => { const { days, ...rest } = args; const own = days && typeof days === "object" ? Object.fromEntries(Object.entries(days).filter(([day]) => batch.some((entry) => dayOf(entry) === day))) : null; return JSON.stringify({ ...rpc, params: { ...rpc.params, arguments: { ...rest, entries: batch, ...(own ? { days: own } : {}) } } }); });
  },
  replan(batches, tighter) {
    const limit = tighter ? halfOf(tighter) : BATCH_LIMIT, bySource = new Map();
    for (const { rpc, source } of batches) bySource.set(source, [...(bySource.get(source) ?? []), ...rpc.params.arguments.entries]);
    const { run: _run, entries: _entries, days: _days, ...args } = batches[0].rpc.params.arguments; void _run; void _entries; void _days;
    const plan = [...bySource].flatMap(([source, group]) => batchesOf(group, false, limit).map((batch) => ({ source, batch })));
    if (plan.length > 1000) return [];
    // 0.10.32: the days' digests follow the new cut, each batch naming only the days it carries.
    const digests = new Map([...bySource].map(([source, group]) => [source, dayDigests(group)]));
    const encode = (batch, run = null, days = null) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_history", arguments: { ...args, entries: batch, ...(run ? { run } : {}), ...(days ? { days } : {}) } } });
    const id = historyRunId(plan.map(({ batch }) => encode(batch)));
    return plan.map(({ source, batch }, index) => ({ source, body: encode(batch, { id, index, count: plan.length }, daysOf(batch, digests.get(source))) }));
  },
};
async function sendHistory(door, entries, announce = false, rebuild = false, named = false, { byDay = false, withdrawUnknown = false } = {}) {
  let accepted = 0;
  const { queuedHistory, historyRefusal, historyIdOf, resumeHistory } = await import("./history-outbox.mjs");
  const plan = historyPlan(door, entries, rebuild, { byDay, withdrawUnknown });
  // Persist the approved plan before sending, so later batches survive removed source files too.
  try { for (const item of plan) queuedHistory(item.target, item.body, item.source); }
  catch { console.error("History queue is full, busy or unavailable. Resume the saved batches before retrying this import; nothing was marked complete."); HISTORY_DELIVERY.waiting += entries.length; return 0; }
  // Every entry is now in the outbox, on disk, and goes again by itself until WorkTrust takes it (0.10.32: what the hook's
  // late days may count on, so a late day not yet filed never holds a transcript's newer days back).
  HISTORY_PERSISTED.n += entries.length;
  const numbers = new Map(), stopped = new Set();
  // TOO LARGE FOR ONE CALL (0.10.29): a batch WorkTrust answered 413, or one an earlier run already cut, is handed after the loop to
  // the outbox's cut with the rest of its run, never sent again as it was. `stoppedRuns`: a run with a refused batch sends no more.
  const later = new Map(), stoppedRuns = new Set();
  const handLater = (item) => { const row = later.get(item.target.token) ?? { target: item.target, ids: [] }; row.ids.push(historyIdOf(item.target, item.body, item.source)); later.set(item.target.token, row); };
  for (const item of plan) {
    const { source, target, batch, body } = item;
    if (stopped.has(source)) continue;
    if (item.run && stoppedRuns.has(item.run.id)) { handLater(item); continue; }
    const number = (numbers.get(source) ?? 0) + 1; numbers.set(source, number);
    for (const entry of batch) retainMeasurement(entry, source);
    // `named` (0.10.10): a copied folder's lines name their client too, so the record says which app the copy came from.
    let queued;
    try { queued = queuedHistory(target, body, source); }
    catch { console.error("Pending history could not be stored safely. Nothing was marked complete; keep the local WorkTrust folder for recovery."); HISTORY_DELIVERY.waiting += batch.length; stopped.add(source); continue; }
    if (queued.status === "acknowledged" && !byDay) { accepted += batch.length; RECEIPTS.alreadyHeld += batch.length; continue; }
    if (queued.status === "replaced" || queued.status === "oversize") { handLater(item); if (item.run) stoppedRuns.add(item.run.id); continue; }
    if (queued.status === "review" && !flag("retry-review")) { HISTORY_DELIVERY.review += batch.length; continue; }
    if (queued.status === "waiting") { HISTORY_DELIVERY.waiting += batch.length; continue; }
    try {
      const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...clientOf(source, rebuild || named), ...proofFor(target.url, body) }, body, redirect: "error", signal: AbortSignal.timeout(65_000) });
      const text = await response.text();
      try { if (!response.ok) throw Error(); confirmedReceipt(text, batch.length); }
      catch {
        const refusal = historyRefusal(text, response);
        // A run WorkTrust closed (seven days without its last batch, another computer's key) is final: kept here it would wait forever.
        if (refusal.reason === "closed") { queued.close(); HISTORY_DELIVERY.refused += batch.length; continue; }
        if (refusal.reason === "oversize") { queued.oversize(); handLater(item); if (item.run) stoppedRuns.add(item.run.id); continue; }
        queued.defer(refusal.reason, refusal.seconds);
        if (refusal.reason === "review") { HISTORY_DELIVERY.review += batch.length; continue; }
        HISTORY_DELIVERY.waiting += batch.length; stopped.add(source); continue;
      }
      queued.confirm(batch.length); accepted += batch.length; noteReceipt(text);
      if (announce) console.log(`batch ${number}: received ${batch.length}`);
    } catch { queued.defer("unconfirmed"); HISTORY_DELIVERY.waiting += batch.length; stopped.add(source); }
  }
  for (const { target, ids } of later.values()) {
    try {
      const totals = await resumeHistory(target, { only: ids, cutter: outboxCut, retryReview: flag("retry-review"), confirmed: confirmedReceipt, note: noteReceipt, send: sendQueued(target) });
      accepted += totals.received + totals.held; RECEIPTS.alreadyHeld += totals.held;
      HISTORY_DELIVERY.waiting += totals.waiting; HISTORY_DELIVERY.review += totals.review; HISTORY_DELIVERY.refused += totals.refused;
      if (announce && totals.split) console.log(`${totals.split} batch${totals.split === 1 ? "" : "es"} too large for one call: cut smaller and sent again in pieces`);
      if (announce && totals.refused) console.log(`${totals.refused} line${totals.refused === 1 ? "" : "s"} could not be sent in a call WorkTrust takes; the earlier lines keep counting. Run npx worktrust@latest history again to measure them anew.`);
    } catch { console.error("Pending history could not be read safely. Nothing was marked complete; keep the local WorkTrust folder for recovery."); }
  }
  return accepted;
}

/** The outbox's batches for one coupling, sent as `--resume` and the hook send them: signed, named, bounded in time. */
const sendQueued = (target, ms = 65_000) => (body, source) => fetch(target.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${target.token}`, ...clientOf(source, true), ...proofFor(target.url, body) }, body, redirect: "error", signal: AbortSignal.timeout(ms) });
/**
 * PENDING HISTORY GOES BY ITSELF (0.10.27; owner, 2026-10-21). A batch the server did not receive (no network, a closed lid,
 * the upload limit) stays in ~/.worktrust/history-outbox and is sent again by the next hook run, a few at a time, without a
 * question: the person said yes when the run was planned, and once WorkTrust has the batch nothing waits here. A batch held
 * for review is never resent this way (`--retry-review` is the person's own).
 */
async function resendPending(limit) {
  try {
    const { resumeHistory } = await import("./history-outbox.mjs");
    for (const target of [door, ...(codexDoor && codexDoor.token !== door?.token ? [codexDoor] : [])].filter(Boolean))
      await resumeHistory(target, { limit, cutter: outboxCut, confirmed: confirmedReceipt, note: noteReceipt, send: sendQueued(target, 20_000) });
  } catch (error) { if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`); }
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
const clientOf = (source, always = false) => (CLI_VERSION_SENT || always || source === "antigravity" || DATABASE_CLIENTS.includes(source) || EXPORT_CLIENTS.includes(source) ? { "user-agent": `${source ?? "claude"}/hook (worktrust-hook)${CLI_VERSION_SENT ? ` worktrust-cli/${CLI_VERSION_SENT}` : ""}` } : {});

async function send(door, payload) {
  retainMeasurement(payload, entrySource.get(payload));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_work", arguments: payload } });
  const response = await fetch(door.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${door.token}`, ...clientOf(entrySource.get(payload)), ...proofFor(door.url, body) }, body });
  if (!response.ok) throw new Error(`door said ${response.status}`);
  const text = await response.text();
  confirmedReceipt(text);
  return text;
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
    const read = [], kind = sessionKindReader();
    for (const line of lines) {
      if (typeof line.cwd === "string") cwd = line.cwd;
      if (typeof line.steered === "string") steered = line.steered;
      kind.note(line);
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at)) continue;
      read.push(messageOf(line, at));
    }
    read.sort((a, b) => a.at - b.at);
    const byDay = byDayOf(read);
    const agents = agentsByDay(file, null), session = kind.kind();
    for (const [day, messages] of byDay) {
      if (messages.length === 0) continue;
      // Under-reporting is the safe side (THE FLOORS): a day that began before the account changed is not offered at all.
      if (floor !== null && firstOf(messages) < floor) continue;
      const last = messages[messages.length - 1].at;
      // The live window belongs to the hook: a stretch that log_work may still report is not history.
      if (!all && Date.now() - last < WINDOW_HOURS * 3600_000) continue;
      // The same measure as a live day (seconds, layers, tokens, turns, model); history differs only in the door it goes through.
      const entry = payloadFor({ ...measure(cwd, messages, session), ref: stretchRef(file, day), steered, session, agents: agents.get(day) ?? null, live: liveOf(file, day) });
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

/**
 * A DATA EXPORT'S CONVERSATIONS AS HISTORY (0.10.10, owner 2026-10-10: "hours from an export count as reconstructed, shown,
 * never in verified hours"). Since 0.10.17 one line per RUN of activity in a conversation-day (runsOf, below), no longer one
 * envelope per conversation and day. Each run travels as its TIMELINE (0.10.20) and WorkTrust computes its reconstructed
 * seconds and the person's turns from it; the line says `reconstructed`: the file can be edited before it is read and no
 * device key witnessed it. No tokens (the export carries none and none are estimated), no evidence; the title names the
 * product and never the conversation; the stretch's name is the vendor, the conversation's id and the day, so the same
 * export sent twice is each line once. The database keeps a reconstructed stretch inside eight hours (20261009170000).
 */
/**
 * WHERE A CONVERSATION-DAY IS CUT (CLI 0.10.17, owner 2026-10-17): the hook's own stretch-finished gap, IDLE_BEFORE_SWEEP
 * (half an hour of quiet says a stretch is finished), never a new constant. The gap the cut falls in belongs to the run
 * BEFORE it: that run's timeline ends with a closing step carrying the gap (kind U, the loop's own, never a turn), so
 * WorkTrust counts the gap after the last message as it did when the day was one envelope, and only the windows sharpen.
 */
const RUN_GAP = IDLE_BEFORE_SWEEP;
function runsOf(messages) {
  const runs = [];
  let current = null;
  for (let i = 0; i < messages.length; i += 1) {
    const gap = i === 0 ? null : messages[i].at - messages[i - 1].at;
    if (current && gap > RUN_GAP) { current.tail = messages[i].at; current = null; }
    if (!current) { current = { messages: [], tail: null }; runs.push(current); }
    current.messages.push(messages[i]);
  }
  return runs;
}
const EXPORTS_STATE = join(homedir(), ".worktrust", "exports.json"); // per export digest: sent, or offered and declined; nothing of a conversation
const readExportsState = () => { try { return JSON.parse(readFileSync(EXPORTS_STATE, "utf8")); } catch { return {}; } };
const rememberExport = (digest, note) => { const state = readExportsState(); state[digest] = { ...(state[digest] ?? {}), ...note }; mkdirSync(dirname(EXPORTS_STATE), { recursive: true }); writeFileSync(EXPORTS_STATE, JSON.stringify(state, null, 1)); };
async function exportEntries() {
  if (!exportSessions || !exportRunRef) throw Error("chat-exports.mjs is not beside this file, or is older than this hook: a data export cannot be read");
  const entries = [], reports = [];
  for (const given of EXPORT_PATHS) {
    const read = {}, report = { days: new Set() }; // 0.10.18: the reader streams the export and fills `read` as it goes (path and vendor first; digest, count and the conversations left out as too large at the end)
    for await (const { id, lines } of exportSessions(given, { excluded, report: read })) {
      const messages = [];
      for (const line of lines) { const at = line.timestamp ? Date.parse(line.timestamp) : NaN; if (Number.isFinite(at)) messages.push(messageOf(line, at)); }
      messages.sort((a, b) => a.at - b.at);
      for (const [day, ofDay] of byDayOf(messages)) {
        if (ofDay.length === 0) continue;
        // ONE STRETCH PER RUN OF ACTIVITY (0.10.17): the day's messages cut where the hook calls a stretch finished; one run
        // is the day as before, under the name it always had; several name the one-envelope line they replace.
        const runs = runsOf(ofDay), old = exportRef(read.vendor, id, day);
        runs.forEach(({ messages: run, tail }, index) => {
          const stretch = measure(null, run), ref = runs.length === 1 ? old : exportRunRef(read.vendor, id, day, index);
          // The run's timeline, with the gap to the next run as a closing step (the loop's own, never a turn), so WorkTrust
          // counts it with this run as the one envelope did; the last run of the day closes where the day did.
          const timeline = stretch.timeline ? `${stretch.timeline}${tail ? `U${Math.min(999999, Math.max(0, Math.round((tail - run[run.length - 1].at) / 1000)))}` : ""}` : null;
          const entry = {
            title: EXPORT_TITLES[read.vendor], kind: "researched",
            ...(timeline ? { timeline, duration_basis: "reconstructed", turn_basis: "humanOnly" } : {}),
            ...(stretch.model ? { model: stretch.model } : {}),
            stretch_ref: ref, source_event_id: `exp_${ref}`,
            ...(runs.length > 1 ? { supersedes_ref: old } : {}),
            started_at: new Date(stretch.from).toISOString(), utc_offset: stretch.offset, at: new Date(stretch.to).toISOString(),
          };
          entrySource.set(entry, read.vendor);
          entryFile.set(entry, { file: `${read.vendor}:${id}`, from: stretch.from, folder: null });
          entries.push(entry);
        });
        report.days.add(day);
      }
    }
    const days = [...report.days].sort();
    reports.push({ path: read.path, vendor: read.vendor, digest: read.digest, conversations: read.conversations, days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null, oversized: read.oversized }); // no hours (0.10.20): WorkTrust computes them on arrival and the receipt says
  }
  const seen = new Set();
  return { entries: entries.filter((entry) => !seen.has(entry.stretch_ref) && seen.add(entry.stretch_ref)).sort((a, b) => a.at.localeCompare(b.at)), reports };
}

/**
 * A PERSON'S OWN COPY OF AN AI APP'S SESSION FOLDER (owner, 2026-10-10, one rule): a backed-up ~/.claude/projects, ~/.codex/sessions
 * or an Antigravity brain folder, read with the same readers and the same clock as the live folders, never the live folders
 * themselves (a copy of one of them, or one holding them, is refused by name). Each day is named exactly as the live folder
 * would name it (the session file's name and the day), so a stretch the live folders already hold, or an earlier send of the
 * same copy, is skipped: the live folders win. What travels is RECONSTRUCTED: no device key witnessed the copy, and a copy can
 * be edited. The timeline, the tokens, the model and the evidence travel as they do for a live day; WorkTrust computes the
 * reconstructed seconds from the timeline. The title says where the line came from.
 */
function folderEntries(given) {
  const dir = given.replace(/^~(?=\/|$)/, homedir());
  let stat; try { stat = statSync(dir); } catch { throw Error(`no session files: ${given} does not exist`); }
  if (!stat.isDirectory()) throw Error(`no session files: ${given} is not a folder`);
  const here = resolve(dir), live = [claudeRoot(), codexRoot(), ...antigravityRoots(value("antigravity-root"))].filter(Boolean).map((root) => resolve(root));
  if (live.some((root) => here === root || here.startsWith(root + sep) || root.startsWith(here + sep))) throw Error(`${given} is an AI app's own session folder on this computer, or holds one: the hook measures those itself; a copy lives elsewhere`);
  const files = [];
  const walk = (at, depth) => {
    if (depth > 12) return;
    let names = []; try { names = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "subagents" && !excluded(entry.name)) walk(path, depth + 1); }
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  walk(here, 0);
  if (files.length === 0) throw Error(`no session files under ${given} (Claude Code transcripts, Codex rollouts or Antigravity transcripts, as .jsonl)`);
  const present = new Set(historyEntries(null, true).map((entry) => entry.stretch_ref)), seen = new Set();
  const entries = [], report = { stretches: 0, skipped: 0, days: new Set() };
  for (const file of files) {
    const client = CODEX_ROLLOUT.test(file) ? "codex" : ANTIGRAVITY_TRANSCRIPT.test(file) ? "antigravity" : "claude";
    const lines = parsedLines(file);
    if (!lines) continue;
    let cwd = null;
    const read = [];
    for (const line of lines) {
      if (typeof line.cwd === "string") cwd = line.cwd;
      if (!line.timestamp || (line.type !== "user" && line.type !== "assistant")) continue;
      const at = Date.parse(line.timestamp);
      if (Number.isFinite(at)) read.push(messageOf(line, at));
    }
    read.sort((a, b) => a.at - b.at);
    for (const [day, messages] of byDayOf(read)) {
      if (messages.length === 0) continue;
      const ref = stretchRef(file, day);
      report.stretches += 1;
      if (present.has(ref) || seen.has(ref)) { report.skipped += 1; continue; }
      seen.add(ref);
      const rest = payloadFor({ ...measure(cwd, messages), ref, steered: null, agents: null });
      const entry = { ...rest, title: rest.layer ? `AI-assisted work from a copied session folder · ${rest.layer}` : "AI-assisted work from a copied session folder", ...(rest.timeline ? { duration_basis: "reconstructed" } : {}) };
      if (client !== "claude") entrySource.set(entry, client);
      entryFile.set(entry, { file, from: firstOf(messages), folder: null });
      report.days.add(day); entries.push(entry);
    }
  }
  const days = [...report.days].sort();
  return { entries: entries.sort((a, b) => a.at.localeCompare(b.at)), report: { stretches: report.stretches, skipped: report.skipped, days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null } };
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
  if (flag("purge")) for (const path of [join(homedir(), ".worktrust", "count-behaviour.mjs"), PINNED, join(homedir(), ".worktrust", "log-session.mjs"), STATE, ...READER_FILES.map((name) => join(homedir(), ".worktrust", name)), join(homedir(), ".worktrust", "antigravity.json")]) { try { rmSync(path); } catch { /* already gone */ } }
  console.log(`${removed ? "removed" : "nothing wired"}: ${file}${flag("purge") ? "\n         purged ~/.worktrust" : ""}`);
  console.log("the coupling itself still exists: end it in the app (Sources → the computer's row → end this coupling)");
  return await exitFlushed(0);
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
  // Only complete, verified releases may be installed. Old loose scripts are never copied or fetched.
  const home = join(RELEASE_DIR, "log-session.mjs");
  let via = value("via");
  if (!via) {
    const { installSignedPackage } = await import("./package-integrity.mjs");
    via = installSignedPackage(RELEASE_DIR, join(homedir(), ".worktrust"));
  }
  const file = join(homedir(), ".claude", "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const direct = flag("direct");
  const command = `"${process.env.WORKTRUST_NODE || process.execPath}"${process.env.WORKTRUST_NODE_ARGS === '["-I"]' ? " -I" : ""} "${via}"${direct ? " --internal-module log-session.mjs" : " hook"}`;
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
  if (already && !repaired) { console.log(`already installed — nothing changed (${command})`); return await exitFlushed(0); }
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
  return await exitFlushed(0);
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
// WHAT THIS COMPUTER MEASURES (0.8.3, for `npx worktrust status`): the last thirty days of its own sessions, summed from
// the same derived record the hook sends, counts only; reads, prints and exits, nothing sent.
if (flag("evidence-summary")) {
  const since = Date.now() - 30 * 86400_000, rows = historyEntries(null, true).filter((entry) => Date.parse(entry.at) >= since);
  const sum = (pick) => rows.reduce((total, entry) => total + (pick(DERIVED.get(entry) ?? {}) ?? 0), 0);
  const complexity = {};
  for (const entry of rows) { const tier = DERIVED.get(entry)?.complexity?.class; if (tier) complexity[tier] = (complexity[tier] ?? 0) + 1; }
  const summary = {
    stretches: rows.length, // the hours are WorkTrust's (0.10.20): the app shows them
    delivered: sum((d) => (d.delivery ? 1 : 0)), verified_first: sum((d) => (d.delivery?.verified_first ? 1 : 0)),
    failures: sum((d) => d.recovery?.failures), recovered: sum((d) => d.recovery?.recovered), blind_retries: sum((d) => d.recovery?.blind_retries),
    steers: sum((d) => d.steering?.moments), effective_steers: sum((d) => d.steering?.effective),
    refused: sum((d) => (d.oversight ? d.oversight.refused + d.oversight.plans_rejected : 0)), guard_denied: sum((d) => d.oversight?.guard_denied),
    planned: sum((d) => (d.planning ? 1 : 0)), files: sum((d) => d.changes?.files), test_files: sum((d) => d.changes?.test_files), complexity,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return await exitFlushed(0);
}
if (flag("archive-lines")) { const lines = historyEntries(null, true).map((entry) => JSON.stringify({ ...entry, ...(DERIVED.get(entry) ?? {}), client: entrySource.get(entry) ?? "claude", started_at: new Date(entryFile.get(entry).from).toISOString(), folder: entryFile.get(entry).folder })); process.stdout.write(`${[...lines, JSON.stringify({ archive_end: lines.length })].join("\n")}\n`); return await exitFlushed(0); } // one write and a count, so the reader tells a whole answer from a cut one
// THE EXPORTS IN A FOLDER (0.10.10, for the bare `npx worktrust`): which lie there, by vendor and digest, and which this computer
// already sent or was asked about; reads, prints one JSON line, sends nothing. `--export-offered <digest>` records a No.
if (flag("find-exports")) { const named = value("find-exports"), state = readExportsState(); const found = (findExports ? await findExports(named && !named.startsWith("--") ? named : undefined) : []).map((one) => ({ ...one, sent: state[one.digest]?.sent === true, offered: Boolean(state[one.digest]) })); process.stdout.write(`${JSON.stringify(found)}\n`); return await exitFlushed(0); }
if (value("export-offered")) { rememberExport(value("export-offered"), { offered: new Date().toISOString() }); return await exitFlushed(0); }
if (!door && !codexDoor && !DRY) { return await exitFlushed(0); } // Not coupled on this machine: nothing to do, quietly.

/**
 * HISTORY FROM THE ARCHIVE (0.8.0; framework §22). When an AI app has deleted its sessions, the stretches this computer
 * archived (`preserve --archive`) can still be filed, marked `from_archive`. Five conditions, each refused by name: a
 * device key (only lines this computer signed travel), an archive that verifies, a stretch whose session is gone from
 * this computer (one still here goes through the ordinary history), a door that knows the mark, and the person asking.
 */
if (flag("history") && flag("resume")) {
  const { resumeHistory } = await import("./history-outbox.mjs");
  const totals = { received: 0, review: 0, waiting: 0, batches: 0, refused: 0, split: 0 };
  try {
    for (const target of [door, ...(codexDoor && codexDoor.token !== door?.token ? [codexDoor] : [])].filter(Boolean)) {
      const result = await resumeHistory(target, { dry: DRY, retryReview: flag("retry-review"), cutter: outboxCut, confirmed: confirmedReceipt, note: noteReceipt, send: sendQueued(target) });
      for (const key of Object.keys(totals)) totals[key] += result[key];
    }
    console.log(JSON.stringify({ resumed: totals.received, ...totals, ...RECEIPTS }));
    return await exitFlushed(DRY || (!totals.waiting && !totals.review) ? 0 : 1);
  } catch { console.log("Pending history could not be read safely. Nothing was marked complete; keep the local WorkTrust folder for recovery."); return await exitFlushed(1); }
}

if (flag("history") && flag("from-archive")) {
  const named = value("from-archive"), dir = named && !named.startsWith("--") ? named.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), "AI-Evidence");
  const say = (text) => console.log(text);
  const pem = process.env.WORKTRUST_DEVICE_KEY;
  // ONE RULE (owner, 2026-10-10): VERIFIED is what this computer's coupled key witnessed. A day the device key signed goes as it was
  // measured; a day unsigned, signed by the local archive key, or by another computer's key goes too, as RECONSTRUCTED, inside the
  // database's ceiling for an unmeasured stretch. No device key is no longer a refusal: it means every day is reconstructed. The
  // archive must still verify whole, and only stretches no longer in any AI app here travel.
  let ownKey = null;
  try { ownKey = pem ? createPublicKey(createPrivateKey(pem)).export({ format: "jwk" }).x : null; } catch { ownKey = null; }
  const verified = spawnSync(moduleExecutable(RELEASE_DIR), [...moduleArgs(RELEASE_DIR, "preserve.mjs", ["--verify", dir])], { encoding: "utf8" });
  if (verified.status !== 0) { say(`The archive in ${dir} does not verify, so nothing was sent: ${(verified.stdout || verified.stderr || "").trim().split("\n").pop()}`); return await exitFlushed(1); }
  const { archiveEntries = null } = (await import("./preserve-lines.mjs").catch(() => null)) ?? {};
  if (!archiveEntries) { say("preserve-lines.mjs is not beside this file. Nothing was sent."); return await exitFlushed(1); }
  const present = new Set(historyEntries(null, true).map((entry) => entry.stretch_ref));
  const all = archiveEntries(dir, ownKey), gone = all.filter(({ entry }) => !present.has(entry.stretch_ref));
  const entries = gone.map(({ entry, client, signed }) => {
    if (client !== "claude") entrySource.set(entry, client);
    if (!signed && (typeof entry.seconds === "number" || typeof entry.timeline === "string")) entry.duration_basis = "reconstructed"; // the door keeps an unmeasured stretch inside its own ceiling
    return entry;
  });
  const signedCount = all.filter(({ signed }) => signed).length;
  say(`${all.length} stretches in the archive · ${signedCount} signed by this computer's key (signature checked) · ${all.length - signedCount} unsigned or signed by another key (reconstructed) · ${entries.length} of them no longer in any AI app here`);
  if (DRY || entries.length === 0) { if (entries[0]) say(`\nthe oldest of them, in full:\n${JSON.stringify(entries[0], null, 1)}`); say(entries.length === 0 ? "Nothing to send." : "\ndry run — nothing sent."); return await exitFlushed(0); }
  if (!(await doorKnowsArchive(door))) { say("WorkTrust does not accept history from an archive yet (the door does not know the mark). Nothing was sent."); return await exitFlushed(1); }
  return await exitFlushed((await sendHistory(door, entries, true)) === entries.length ? 0 : 1);
}

if (flag("history")) {
  const historyFloor = floorOf(readState(), "__historyFloor");
  // AN EXPORT IS ITS OWN HISTORY (0.10.10): its lines alone, reconstructed, and never a rebuild (a rebuild replaces this computer's own measured days).
  let fromExports = null, fromFolder = null;
  if (EXPORT_PATHS.length > 0) { try { fromExports = await exportEntries(); } catch (error) { console.log(`export: ${error.message}`); return await exitFlushed(1); } }
  // A COPIED SESSION FOLDER (0.10.10): its own history, reconstructed, the live folders' stretches skipped; never a rebuild.
  if (flag("from-folder")) {
    const given = value("from-folder");
    if (!given || given.startsWith("--")) { console.log("folder: --from-folder needs the copied folder's path"); return await exitFlushed(1); }
    try { fromFolder = folderEntries(given); } catch (error) { console.log(`folder: ${error.message}`); return await exitFlushed(1); }
  }
  if ((fromExports || fromFolder) && flag("rebuild")) { console.log("An export or a copied folder is never a rebuild: its hours are reconstructed and replace nothing. Run it without --rebuild."); return await exitFlushed(1); }
  // THE EXPORT REPLACES (owner, 2026-10-10): the door withdraws the product's earlier connector lines on the export's days by itself; the AI-app
  // lines under no product go only with `--withdraw-unknown`, which the command sends after the person's yes, with an export alone.
  if (flag("withdraw-unknown") && !fromExports) { console.log("--withdraw-unknown goes with --export alone: it withdraws, on the days an export covers, the earlier lines an AI app reported under no product."); return await exitFlushed(1); }
  const entries = fromExports ? fromExports.entries : fromFolder ? fromFolder.entries : historyEntries(historyFloor);
  const months = [...new Set(entries.map((entry) => entry.at.slice(0, 7)))].sort();
  // ONE LINE FOR `npx worktrust` TO ASK WITH (2026-10-03): sessions, days, first and last month; per client its days (the rebuild's plan,
  // 2026-10-07); nothing sent. NO HOURS (0.10.20): the hours are WorkTrust's to compute; the receipt after the send carries them.
  const clients = [...entries.reduce((map, entry) => { const client = entrySource.get(entry) ?? "claude", row = map.get(client) ?? { client, days: new Set() }; row.days.add(entry.at.slice(0, 10)); return map.set(client, row); }, new Map()).values()].map((row) => ({ client: row.client, days: row.days.size, first: [...row.days].sort()[0], last: [...row.days].sort().at(-1) }));
  if (flag("summary")) {
    // 0.10.29: the batches this send would make (lines, bytes, timeline bytes of each, the largest) and how many day-stretches carry
    // each session kind (`unknown`: none said, or no timeline to say it beside). Counts and sizes only, nothing of the work.
    const plan = historyPlan(door ?? codexDoor ?? { url: "", token: "" }, entries, flag("rebuild"), fromExports ? { byDay: true, withdrawUnknown: flag("withdraw-unknown") } : {});
    const sizes = plan.map((item) => ({ lines: item.batch.length, bytes: Buffer.byteLength(item.body, "utf8"), timeline_bytes: item.batch.reduce((n, entry) => n + timelineOfEntry(entry), 0) }));
    const kinds = { interactive: 0, headless: 0, scheduled: 0, unknown: 0 };
    for (const entry of entries) kinds[entry.session_kind ?? "unknown"] += 1;
    console.log(JSON.stringify({ sessions: new Set(entries.map((entry) => entryFile.get(entry)?.file)).size, unreadable: READ_FAILURES.n, days: new Set(entries.map((entry) => entry.at.slice(0, 10))).size, first: months[0] ?? null, last: months.at(-1) ?? null, ...(fromExports ? { exports: fromExports.reports } : {}), ...(fromFolder ? { folder: fromFolder.report } : {}), clients,
      batches: { count: sizes.length, largest_bytes: Math.max(0, ...sizes.map((one) => one.bytes)), largest_timeline_bytes: Math.max(0, ...sizes.map((one) => one.timeline_bytes)), largest_lines: Math.max(0, ...sizes.map((one) => one.lines)), each: sizes }, session_kinds: kinds }));
    return await exitFlushed(0);
  }
  console.log(`${entries.length} day-stretches · ${fromExports || fromFolder ? "reconstructed" : "measured"} by WorkTrust on arrival · ${months.join(", ")}${flag("rebuild") ? " · rebuild: this computer's earlier lines for these days and clients are replaced at the door" : ""}`);
  if (DRY) {
    // One example in full: the shape is the argument for trusting it, and a summary hides it.
    if (entries[0]) console.log(`\nthe oldest of them, in full:\n${JSON.stringify(entries[0], null, 1)}`);
    console.log(`\ndry run — nothing sent. Add --history${flag("rebuild") ? " --rebuild" : ""} without --dry-run to ${flag("rebuild") ? "rebuild" : "import"} them.`);
    return await exitFlushed(0);
  }
  // ONLY THE DAYS THAT CHANGED (0.10.32): a re-measure of this computer's own sessions asks the door first; an export, a copied
  // folder and a plain history never do. Not known is every day.
  const staged = flag("rebuild") && !fromExports && !fromFolder;
  const sending = staged ? await changedOnly(entries) : entries;
  if (staged && COMPARED.asked && COMPARED.days > COMPARED.changed) console.log(sending.length === 0 ? `nothing changed: WorkTrust holds all ${COMPARED.days} days as this computer measures them` : `${COMPARED.days - COMPARED.changed} of ${COMPARED.days} days unchanged on WorkTrust; sending the ${COMPARED.changed} that changed`);
  // A batch the door refused is a failure the caller must see, not a quiet zero.
  const accepted = sending.length === 0 ? 0 : await sendHistory(door, sending, true, flag("rebuild"), Boolean(fromFolder), fromExports ? { byDay: true, withdrawUnknown: flag("withdraw-unknown") } : {});
  // An export that arrived whole is remembered by its digest (never by a conversation), so the bare command offers it no more.
  if (fromExports && accepted === entries.length) for (const report of fromExports.reports) rememberExport(report.digest, { vendor: report.vendor, sent: true, at: new Date().toISOString(), conversations: report.conversations });
  // ONE LINE FOR THE COMMAND TO ASK WITH (2026-10-10): what the door replaced, how many AI-app lines lie on the export's days, how many it withdrew.
  if (!fromExports && !fromFolder) await settleReadFailures(door ?? codexDoor); // 0.10.32: a transcript that could not be read is counted and told
  if (fromExports) console.log(JSON.stringify({ export_sent: accepted, of: entries.length, ...RECEIPTS })); else console.log(JSON.stringify({ history_sent: accepted, of: sending.length, unreadable: READ_FAILURES.n, ...RECEIPTS, delivery: HISTORY_DELIVERY, ...(staged ? { days: { compared: COMPARED.asked ? COMPARED.days : null, changed: COMPARED.asked ? COMPARED.changed : null }, queued: QUEUED.at } : {}) })); // the same line for a history send: what the door did with it, and WorkTrust's measuredSeconds for what it stored
  return await exitFlushed(accepted === sending.length ? 0 : 1);
}

const input = hookInput();
const state = readState();
if (input?.hook_event_name === "Stop" && !process.env.WORKTRUST_STOP_CHILD) {
  if (Date.now() - (Date.parse(state.__stopSweep ?? "") || 0) < STOP_SWEEP_MS) return await exitFlushed(0);
  if (!DRY) { state.__stopSweep = new Date().toISOString(); writeState(state); }
  // The sweep itself in a detached copy, so the answer that fired Stop is not held while a large transcript is read.
  if (!DRY && !process.env.WORKTRUST_STOP_INLINE && existsSync(join(RELEASE_DIR, "log-session.mjs"))) {
    try {
      spawn(moduleExecutable(RELEASE_DIR), moduleArgs(RELEASE_DIR, "log-session.mjs", []), { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, WORKTRUST_STOP_CHILD: "1", WORKTRUST_HOOK_INPUT: JSON.stringify(input) } }).unref();
      return await exitFlushed(0);
    } catch { /* no detached copy: the sweep runs here */ }
  }
}
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
// THE TIMER THAT STARTED THIS RUN (0.10.32): read once, for the session the hook was called for, and kept beside its watermark, so a
// day sent by a later run (the day was not finished) still carries it. A run no timer started reads none.
let scheduleNoted = false;
if (work.length > 0 && input?.transcript_path && work[0].file === input.transcript_path) {
  const found = timerSchedule(), secret = found ? repoCodeSecret() : null, timer = found && secret ? { cadence: found.cadence, ref: createHmac("sha256", secret).update(`worktrust-schedule-ref|${found.ref}`).digest("base64url") } : null; // the label's hash keyed with this computer's secret, as repo_code (L4)
  if (timer &&state[work[0].id]?.schedule?.ref !== timer.ref) { state[work[0].id] = { ...(state[work[0].id] ?? {}), schedule: timer }; scheduleNoted = true; }
}
let sent = 0, filed = 0, positioned = false;
const late = []; // measured days the live door will no longer take: they are not dropped, they are filed
const heldBack = new Map(); // per transcript with a late day: its state before that day, put back unless history took every late day
for (const entry of work) {
  const mark = state[entry.id]?.through ? Date.parse(state[entry.id].through) : null;
  // Never before the coupling (THE FLOORS): a transcript with no watermark starts at `__from`, not at its first line.
  const since = mark !== null && floor !== null ? Math.max(mark, floor) : mark ?? floor;
  // Nothing written since we last read this one: it is not opened. This keeps a sweep over every transcript to one `stat` each.
  if (since !== null && entry.writtenAt && entry.writtenAt <= since) continue;
  // THE READ POSITION (0.10.32, at stretchesOf): a Claude Code transcript is read from where the last run left it, when nothing says otherwise.
  const stretches = stretchesOf(entry.file, since, state[entry.id]?.pos ?? null);
  // THE WATERMARK ADVANCES OVER WHAT WAS ACCEPTED, AND STOPS AT THE FIRST REFUSAL. A door that is
  // down must never cost the person a day, so the loop breaks rather than skipping ahead.
  let through = null, before, reported = state[entry.id]?.reported;
  for (const stretch of stretches) {
    // The day still being worked in is not finished. A fortnight-long session therefore reports
    // every day but today, on whichever run comes first — it no longer waits for its own end.
    if (Date.now() - stretch.to < IDLE_BEFORE_SWEEP) break;
    const total = grownBy(stretch, reported);
    const payload = payloadFor({ ...stretch, schedule: state[entry.id]?.schedule ?? null });
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
  // The position is cut for the watermark kept beside it: the new one, or the one this run read under.
  const pos = stretches.positionAt?.(through ?? since) ?? null;
  if (through !== null) state[entry.id] = { through: new Date(through).toISOString(), ...(reported ? { reported } : {}), ...(state[entry.id]?.schedule ? { schedule: state[entry.id].schedule } : {}), ...(pos ? { pos } : {}) };
  else if (pos && !DRY && canonical(pos) !== canonical(state[entry.id]?.pos ?? null)) { state[entry.id] = { ...(state[entry.id] ?? {}), pos }; positioned = true; }
}
// The history door, in batches of two hundred as `--history` sends them. A resend FILLS a line that was missing something, never a twin.
if (!DRY && late.length > 0) {
  try { filed = await sendHistory(door, late); } catch (error) { if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: ${error.message}`); }
  // A LATE DAY THAT IS NOWHERE IS NOT PASSED: when the outbox could not keep it, its transcript's mark goes back to before it, so
  // the next run reads it again. A late day the outbox KEEPS is passed (0.10.32): the outbox sends it again by itself until
  // WorkTrust takes it, and putting the mark back made every newer day of a long session late too, a day at a time, so a
  // session whose first late day waited (the owner's, from 2026-10-18) never moved again.
  if (filed < late.length && HISTORY_PERSISTED.n < late.length) for (const [id, mark] of heldBack) { if (mark) state[id] = mark; else delete state[id]; }
}
if (!DRY && (sent > 0 || filed > 0 || scheduleNoted || positioned || (late.length > 0 && HISTORY_PERSISTED.n >= late.length))) writeState(state);
// What an earlier run left in the outbox because the server never received it: a few batches a run, by itself; not in a run
// that just sent late days itself (a batch it just tried waits for the next run). Since 0.10.32 the mark passes a late day the
// outbox keeps, so the next run has no late day of its own and asks; before, a long session always had one and never asked.
if (!DRY && late.length === 0) await resendPending(4);
// A transcript that could not be read is counted here and told as a count (0.10.32), never skipped in silence.
if (!DRY) await settleReadFailures(door, state);
if (process.env.WORKTRUST_HOOK_DEBUG) console.error(`worktrust: read ${READ_BYTES.n} transcript bytes`);

// The counter, at most once a day, detached: reading every transcript takes longer than a hook
// may hold a session's exit, and its result waits for a click either way. `--stage` and never
// `--send`: staging is idempotent on the reading's own digest, so a day that changed nothing
// leaves nothing behind.
if (!DRY && existsSync(COUNTER)) {
  const last = state.__counter?.at ? Date.parse(state.__counter.at) : 0;
  if (Date.now() - last > COUNTER_EVERY_MS) {
    try {
      const child = spawn(moduleExecutable(RELEASE_DIR), moduleArgs(RELEASE_DIR, "count-behaviour.mjs", ["--stage"]), { detached: true, stdio: ["ignore", "ignore", "inherit"] });
      child.unref();
      state.__counter = { at: new Date().toISOString() };
      writeState(state);
    } catch { /* the counter is a bonus; a hook that fails on it would cost the stretch it just logged */ }
  }
}
return await exitFlushed(0);

}
await main();
