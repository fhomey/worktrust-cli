/**
 * THE SESSION READERS: where each AI app keeps its sessions on this computer, and how a session file is read (CLI 0.11.10,
 * split from log-session.mjs unchanged, so the hook and `npx worktrust look` find and read sessions by ONE set of rules).
 *
 * Two halves. READING: a transcript read in 8 MB chunks, line by line, never whole; a read that fails is counted
 * (READ_FAILURES), never silent; a resumed read checks the file is still the one it read (edgesOf). FINDING: every session
 * of every AI app the readers know (Claude Code transcripts, Codex rollouts, Antigravity conversations and the database
 * clients of session-databases.mjs), an excluded project skipped before a file is opened.
 *
 * The per-app parsing stays in transcript-readers.mjs and session-databases.mjs; this module takes their functions as
 * arguments (transcriptLines, sessionFinders), so a copy without one of them still reads Claude Code, as before. Nothing
 * here writes a file or opens a connection: it reads, counts and yields.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ── reading a session file ──
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
export { READ_FAILURES, READ_BYTES, chunkedLines, claudeLinesFrom, fileLines };

/** The line reader for any client's session, given the per-client readers (transcript-readers.mjs, session-databases.mjs). */
export function transcriptLines({ DATABASE_SESSION, databaseLines, CODEX_ROLLOUT, codexLines, ANTIGRAVITY_TRANSCRIPT, antigravityIdOf, antigravityLines, antigravityContext }) {
/** A transcript's lines as objects, whichever client wrote it; null when the file cannot be read. A Claude Code transcript is parsed lazily, as it is read. */
const parsedLines = (file) => {
  if (DATABASE_SESSION.test(file)) return databaseLines(file);
  const lines = fileLines(file);
  if (!lines) return null;
  if (CODEX_ROLLOUT.test(file)) return [...codexLines(lines)];
  if (ANTIGRAVITY_TRANSCRIPT.test(file)) { const id = antigravityIdOf(file); return [...antigravityLines(lines, { id, ...antigravityContext(id) })]; }
  return { *[Symbol.iterator]() { for (const raw of lines) { if (!raw.trim()) continue; try { yield JSON.parse(raw); } catch { /* a torn line */ } } } };
};
return parsedLines;
}

// ── finding each AI app's sessions ──
/**
 * The finders, given the hook's arguments (`value`: a test names its own roots), its project modes (`excluded`) and the
 * per-client readers. Returns the roots and the walks the hook and `look` share.
 */
export function sessionFinders({ value, excluded, DATABASE_CLIENTS, codexRolloutFiles, codexCwd, codexIdOf, antigravityRoots, antigravityTranscripts, antigravityContext, databaseSessions }) {
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
return { claudeRoot, codexRoot, codexRollouts, databaseConversations, antigravityConversations, allTranscripts, candidates };
}
