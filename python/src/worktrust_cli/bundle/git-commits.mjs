/**
 * YOUR OWN COMMITS, MEASURED ON THIS COMPUTER (`npx worktrust git`, CLI 0.10.34; option C, owner 2026-10-29;
 * docs/GITHUB.md). GitHub shows a commit-reading App as "Read access to code", and there is no narrower permission. So
 * the commits are read HERE, with `git log`, filtered to the person's own author e-mails; each commit's file names are
 * turned into the GitHub walk's own closed keys on this computer (commit-rules.mjs, generated from core), and what is
 * sent is counts, keys and markers, never a path, a message, a diff, a sha or the remote's address. A commit travels as
 * its owner-keyed reference: HMAC-SHA256 under `worktrust-commit:<owner id>` over `uuidFrom("commit", sha)`, the bytes
 * the server computes from GitHub's own head sha (docs/GITHUB.md §1), so a GitHub-observed check run on the same commit
 * can corroborate it without this computer ever sending the sha.
 *
 * Asked once, with the list of repositories: what is not shown is not read, and Enter (or --yes) is No. The answers are
 * kept in ~/.worktrust/git.json (0600): this computer's own paths, never sent.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as rules from "./commit-rules.mjs";

/** The walker's id primitive (apps/worktrust/app/src/lib/scoring/ids.ts), byte for byte. */
export function uuidFrom(...parts) {
  const hex = createHash("sha256").update(parts.join(" ")).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) % 64) + 128).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
/** The commit's owner-keyed reference (docs/GITHUB.md §1). */
export const commitRefOf = (owner, sha) => createHmac("sha256", `worktrust-commit:${owner}`).update(uuidFrom("commit", sha)).digest("hex");
/** A Supabase migration's version as the walk marks it (packages/integrations/src/providers/supabase/api.ts). */
const migrationMarkerOf = (owner, version) => createHash("sha256").update(`supabase-migration:${owner}:${version}`).digest("hex");
export const migrationMarkersOf = (paths, owner) => [...new Set(paths.flatMap((path) => { const match = /(?:^|\/)supabase\/migrations\/(\d{1,30})_[^/]+\.sql$/.exec(path); return match ? [migrationMarkerOf(owner, match[1])] : []; }))].slice(0, 50);

/** GitHub's commit detail lists at most 300 files on the page the walk reads; the same paths are read here. */
const DETAIL_FILES = 300;
export const LIMITS = { perRepo: 1000, perRun: 2000, perBatch: 400, batchBytes: 1_500_000, transcripts: 2000 };
const HOSTS = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(github\.com|gitlab\.com|bitbucket\.org)[:/]/i;

function git(cwd, ...argv) {
  try { return execFileSync("git", ["-C", cwd, "-c", "core.quotePath=false", ...argv], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

/** The work tree a folder sits in, or null. */
export function repoRootOf(dir) {
  if (!dir || !existsSync(dir)) return null;
  const top = git(dir, "rev-parse", "--show-toplevel").trim();
  if (!top) return null;
  try { return realpathSync(top); } catch { return top; }
}

/**
 * What a repository is called on the way out: owner/name, lowercased, for a remote on a host WorkTrust couples (what a
 * session already names, CLI 0.8.6), so it is filed under the GitHub walk's project; otherwise a code only this
 * computer can make (HMAC under its archive salt over the normalised remote or the root), never a name.
 */
export function repoIdentity(root, salt) {
  const remote = git(root, "remote", "get-url", "origin").trim();
  if (remote && HOSTS.test(remote)) {
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
    const name = match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
    if (name && /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(name)) return { name, github: /github\.com/i.test(remote) };
  }
  const basis = remote ? `remote:${remote.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "").replace(/:(?!\d)/, "/").replace(/\.git$/, "").replace(/\/+$/, "")}` : `root:${root}`;
  return salt ? { code: createHmac("sha256", salt).update(`worktrust-repo-code|${basis}`).digest("hex").slice(0, 16), github: false } : null;
}

/** The person's author e-mails: git's own setting here and globally, plus what they added. Lowercased, once each. */
export function authorEmails(root, extra = []) {
  const found = [git(root, "config", "user.email"), git(root, "config", "--global", "user.email"), ...extra].map((email) => String(email).trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+$/.test(email));
  return [...new Set(found)];
}

/** A numstat path as GitHub's detail names it: a rename is its new path. */
export function numstatPath(text) {
  let path = text.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/\/{2,}/g, "/").replace(/^\//, "");
  if (path.includes(" => ")) path = path.slice(path.lastIndexOf(" => ") + 4);
  return path;
}

/**
 * The person's own commits in one work tree, newest first, at most `limit`: every local branch, merges diffed against
 * their first parent (as GitHub's detail is), only commits whose author e-mail is one of theirs. Read: the sha, the
 * parents, two dates, the author e-mail (to filter, never kept) and per file the added and deleted lines and the path.
 * Never the message, never the content.
 */
export function readCommits(root, { emails, since = null, limit = LIMITS.perRepo }) {
  if (!emails.length) return [];
  const argv = ["log", "--branches", "--no-color", "--no-ext-diff", "--numstat", "--diff-merges=first-parent", "--format=%x01%H%x09%P%x09%aI%x09%cI%x09%aE", `--max-count=${limit}`, "--fixed-strings", "--regexp-ignore-case", ...emails.map((email) => `--author=<${email}>`)];
  if (since) argv.push(`--since=${since}`);
  const out = git(root, ...argv);
  const mine = new Set(emails);
  const commits = [];
  for (const block of out.split("\x01").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [sha, parents, authored, committed, email] = head.split("\t");
    if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !mine.has(String(email).toLowerCase())) continue;
    let additions = 0, deletions = 0;
    const paths = [];
    for (const line of rest) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!match) continue;
      if (match[1] !== "-") additions += Number(match[1]);
      if (match[2] !== "-") deletions += Number(match[2]);
      paths.push(numstatPath(match[3]));
    }
    commits.push({ sha, parents: (parents ?? "").split(" ").filter((p) => /^[0-9a-f]{40}$/.test(p)), authored, committed, additions, deletions, paths });
  }
  return commits;
}

/** When the repository began, as a day: its first commit. The walk reads GitHub's creation date for the work mode. */
export function repoSince(root) {
  const days = git(root, "log", "--max-parents=0", "--format=%cI", "HEAD").split("\n").map((line) => line.trim()).filter(Boolean).map((at) => new Date(at)).filter((at) => Number.isFinite(at.getTime()));
  return days.length ? new Date(Math.min(...days.map(Number))).toISOString().slice(0, 10) : null;
}

/**
 * ONE COMMIT AS THE GITHUB WALK WOULD FILE IT (walk.ts processNode), computed here. The paths go in and never come
 * out: what comes out is the reference, the counts and the closed keys. `projectRef` is the project the server filed
 * the repository under (the walk's own for a GitHub repository); without it no path marker is made.
 */
export function commitPayload(commit, { owner, projectRef }) {
  const paths = commit.paths.slice(0, DETAIL_FILES);
  const features = rules.featuresOfFiles(paths);
  const authoredMs = Date.parse(commit.authored ?? ""), committedMs = Date.parse(commit.committed);
  return {
    ref: commitRefOf(owner, commit.sha),
    at: new Date(committedMs).toISOString().replace(/\.000Z$/, "Z"),
    replayDays: Number.isFinite(authoredMs) ? Math.max(0, Math.round((committedMs - authoredMs) / 86_400_000)) : null,
    additions: commit.additions,
    deletions: commit.deletions,
    files: paths.length,
    parents: commit.parents.length,
    parentRefs: commit.parents.slice(0, 8).map((sha) => commitRefOf(owner, sha)),
    classes: rules.classesOfFiles(paths),
    stack: rules.stackOfFiles(paths),
    arch: rules.archOfFiles(paths),
    security: rules.securityMarkersOfFiles(paths),
    agents: rules.agentMarkersOfFiles(paths),
    rootMarkers: rules.rootPrefixesOf(paths).map((prefix) => uuidFrom("root", owner, prefix)),
    pathMarkers: projectRef ? [...new Set(paths)].slice(0, 40).map((path) => uuidFrom("path", owner, projectRef, path)) : [],
    migrationMarkers: migrationMarkersOf(paths, owner),
    extensions: features.extensions,
    classRules: features.classRules,
    manifests: features.manifests,
    archPoints: features.archPoints,
    classifier: rules.CLASSIFIER_VERSION,
    markerVersion: rules.MARKER_VERSION,
  };
}

/**
 * NOTHING THAT NAMES THE WORK LEAVES (the planted-leak test holds it). Before a batch is sent it is read as text for
 * every path it was made from, every sha, every remote and root it came from: one found refuses the whole batch. A
 * commit's fields are a closed set, so a field nobody wrote here is refused as well.
 */
const COMMIT_FIELDS = new Set(["ref", "at", "replayDays", "additions", "deletions", "files", "parents", "parentRefs", "classes", "stack", "arch", "security", "agents", "rootMarkers", "pathMarkers", "migrationMarkers", "extensions", "classRules", "manifests", "archPoints", "classifier", "markerVersion"]);
const REF = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const CLOSED = {
  classes: new Set([...rules.CLASS_RULES.map((rule) => rule.cls), "code"]), classRules: new Set(rules.CLASS_RULES.map((rule) => rule.id)),
  stack: new Set(rules.TECHNOLOGIES), manifests: new Set(rules.TECHNOLOGIES), arch: new Set(rules.ARCHITECTURE_POINTS), archPoints: new Set(rules.ARCHITECTURE_POINTS),
  security: new Set(rules.SECURITY_MARKERS), agents: new Set(rules.AGENT_MARKERS),
};
const SHAPED = { parentRefs: REF, migrationMarkers: REF, rootMarkers: UUID, pathMarkers: UUID };
const isCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
/** Why a commit is not of the closed shape the door takes, or null: every word from a list, every string a pattern. */
function shapeRefusal(commit) {
  for (const key of Object.keys(commit)) if (!COMMIT_FIELDS.has(key)) return `an unknown field (${key})`;
  if (!REF.test(commit.ref ?? "") || typeof commit.at !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(commit.at)) return "a reference or an instant of the wrong shape";
  for (const key of ["replayDays", "additions", "deletions", "files", "parents"]) if (!isCount(commit[key])) return `${key} is not a count`;
  for (const [key, words] of Object.entries(CLOSED)) if (!Array.isArray(commit[key]) || commit[key].some((word) => !words.has(word))) return `a word outside the list in ${key}`;
  for (const [key, shape] of Object.entries(SHAPED)) if (!Array.isArray(commit[key]) || commit[key].some((value) => typeof value !== "string" || !shape.test(value))) return `${key} is not markers`;
  if (!commit.extensions || typeof commit.extensions !== "object" || Object.entries(commit.extensions).some(([key, n]) => !/^([A-Za-z0-9]{1,12}|\(none\))$/.test(key) || !isCount(n))) return "extensions are not counts by file type";
  if (!VERSION.test(commit.classifier ?? "") || !VERSION.test(commit.markerVersion ?? "")) return "a version of the wrong shape";
  return null;
}
export function leakIn(body, secrets) {
  const text = JSON.stringify(body);
  for (const repo of body.repos ?? []) for (const commit of repo.commits ?? []) { const refused = shapeRefusal(commit); if (refused) return refused; }
  if (/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/.test(text)) return "a sha";
  for (const path of secrets.paths ?? []) if ((path.includes("/") || path.includes(".") || path.length >= 6) && text.includes(JSON.stringify(path).slice(1, -1))) return "a path";
  for (const other of [...(secrets.remotes ?? []), ...(secrets.roots ?? [])]) if (other && text.includes(JSON.stringify(other).slice(1, -1))) return "a remote or a folder";
  return null;
}

/** The folders the AI apps' sessions ran in, newest first: Claude Code's transcripts name their `cwd`. */
export function transcriptCwds(home = homedir(), limit = LIMITS.transcripts) {
  const root = join(home, ".claude", "projects");
  const files = [];
  try {
    for (const project of readdirSync(root)) {
      const dir = join(root, project);
      try { for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) { const file = join(dir, name); files.push([file, statSync(file).mtimeMs]); } } catch { /* not a folder */ }
    }
  } catch { return []; }
  const cwds = new Set();
  const buffer = Buffer.alloc(65_536);
  for (const [file] of files.sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    let fd = null;
    try { fd = openSync(file, "r"); const read = readSync(fd, buffer, 0, buffer.length, 0); const match = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buffer.toString("utf8", 0, read)); if (match) cwds.add(JSON.parse(`"${match[1]}"`)); }
    catch { /* unreadable: skipped */ }
    finally { if (fd !== null) closeSync(fd); }
  }
  return [...cwds];
}

/** The person's own exclusions (~/.worktrust-counter.json `exclude`, the counter's file): a folder under one is never read. */
function excluded(dir, home) {
  try { const list = JSON.parse(readFileSync(join(home, ".worktrust-counter.json"), "utf8")).exclude; return Array.isArray(list) && list.some((prefix) => typeof prefix === "string" && prefix && resolve(dir).startsWith(resolve(prefix))); } catch { return false; }
}

// ── this computer's answers ──
export function stateFile(home = homedir()) { return join(home, ".worktrust", "git.json"); }
export function loadState(home = homedir()) {
  try { const state = JSON.parse(readFileSync(stateFile(home), "utf8")); if (state && typeof state === "object" && state.version === 1) return { version: 1, owner: typeof state.owner === "string" ? state.owner : null, emails: Array.isArray(state.emails) ? state.emails.filter((e) => typeof e === "string") : [], repos: state.repos && typeof state.repos === "object" ? state.repos : {} }; } catch { /* none yet */ }
  return { version: 1, owner: null, emails: [], repos: {} };
}
export function saveState(state, home = homedir()) {
  mkdirSync(join(home, ".worktrust"), { recursive: true });
  writeFileSync(stateFile(home), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  try { chmodSync(stateFile(home), 0o600); } catch { /* best effort */ }
}

/** The work trees to offer: the folders the sessions named, plus the ones the person added; none they removed. */
export function discoverRepos(state, home = homedir()) {
  const roots = new Set();
  for (const cwd of transcriptCwds(home)) { if (excluded(cwd, home)) continue; const root = repoRootOf(cwd); if (root) roots.add(root); }
  for (const [root, entry] of Object.entries(state.repos)) if (entry?.how === "typed" && existsSync(root)) roots.add(root);
  return [...roots].sort();
}

/** What each of the three ways in reads: the table the consent shows (and the Sources card, in the app's words). */
export const READS_TABLE = [
  "                           GitHub Basic      GitHub Full       This computer (worktrust git)",
  "  GitHub permission        checks, statuses  + code (contents) none",
  "                           deploys, actions",
  "  Commits                  no                yes               yes, your own (author e-mail)",
  "  File names               no                yes, as keys      yes, as keys, here only",
  "  Code, diffs, messages    never             never             never",
  "  Sent                     outcomes          counts and keys   counts and keys, no path, no sha",
];

/**
 * `npx worktrust git [add <path> | remove <path> | list | emails [add|remove <e-mail>]] [--dry-run] [--yes]`.
 * `io` lends the CLI's own: say, ask (Enter is No here), send(body) → the receipt or null, consent, salt, home.
 */
export async function gitMain(argv, io) {
  const home = io.home ?? homedir();
  const state = loadState(home);
  const [sub, value, extra] = argv;
  if (sub === "emails") {
    if ((value === "add" || value === "remove") && extra) {
      const email = extra.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) { io.say("  Not an e-mail address. Nothing changed."); return 1; }
      state.emails = value === "add" ? [...new Set([...state.emails, email])] : state.emails.filter((e) => e !== email);
      if (!io.dryRun) saveState(state, home);
      io.say(`  ${value === "add" ? "Added" : "Removed"}. Commits by these e-mails are yours here: ${state.emails.join(", ") || "(only git's own user.email)"}`);
      return 0;
    }
    io.say(`  Your author e-mails beyond git's own user.email: ${state.emails.join(", ") || "none"}`);
    io.say("  Add one: npx worktrust git emails add <e-mail>");
    return 0;
  }
  if (sub === "add" || sub === "remove") {
    const root = repoRootOf(resolve(value ?? "."));
    if (!root) { io.say("  Not a git work tree. Nothing changed."); return 1; }
    if (sub === "remove") { state.repos[root] = { ...(state.repos[root] ?? {}), how: "removed", agreed: false }; if (!io.dryRun) saveState(state, home); io.say("  Removed: nothing more is read or sent from it. What was sent stays on your record until you remove it under Sources."); return 0; }
    state.repos[root] = { ...(state.repos[root] ?? {}), how: "typed", agreed: null };
    if (!io.dryRun) saveState(state, home);
    io.say("  Added.");
  }
  const roots = discoverRepos(state, home).filter((root) => state.repos[root]?.how !== "removed");
  if (sub === "list") {
    io.say("  Repositories WorkTrust may read on this computer:");
    for (const root of roots) {
      const entry = state.repos[root], id = repoIdentity(root, io.salt);
      const status = entry?.agreed === true ? `sending${entry.sentThrough ? `, through ${entry.sentThrough.slice(0, 10)}` : ""}` : entry?.agreed === false ? "not agreed" : "not asked yet";
      io.say(`    ${root}  (${id?.name ?? "by code"})  ${status}`);
    }
    io.say(`  Author e-mails: git's user.email${state.emails.length ? `, ${state.emails.join(", ")}` : ""}`);
    return 0;
  }

  // ── consent: once, with the list; what is not shown is not read ──
  const unasked = roots.filter((root) => state.repos[root]?.agreed !== true && state.repos[root]?.agreed !== false);
  if (unasked.length) {
    io.say();
    io.say("  WorkTrust can read your own commits in these repositories, on this computer:");
    for (const root of unasked) io.say(`    ${root}`);
    io.say();
    io.say("  What WorkTrust reads:");
    for (const line of READS_TABLE) io.say(line);
    io.say();
    io.say("  Only commits whose author e-mail is yours. Sent: per commit its counts, kinds of files and markers,");
    io.say("  never a file name, a message, code or the commit's id.");
    const yes = await io.ask(`Send your own commits of these ${unasked.length} repositories?`, false);
    for (const root of unasked) state.repos[root] = { ...(state.repos[root] ?? { how: "found" }), agreed: yes };
    if (yes) io.consent?.agree("git-commits", "typed");
    if (!io.dryRun) saveState(state, home);
  }
  const agreed = roots.filter((root) => state.repos[root]?.agreed === true);
  if (!agreed.length) { io.say("  Nothing to send: no repository agreed. Add one: npx worktrust git add <folder>"); return 0; }

  // ── where each repository is filed, and the owner the references are keyed with ──
  const repos = agreed.map((root) => ({ root, identity: repoIdentity(root, io.salt) })).filter((repo) => repo.identity);
  const label = (repo) => (repo.identity.name ? { name: repo.identity.name } : { code: repo.identity.code });
  const where = io.dryRun ? null : await io.send({ repos: repos.map((repo) => ({ ...label(repo), commits: [] })) });
  if (!io.dryRun && !where?.owner) { io.say("  WorkTrust could not be reached, or refused this computer. Nothing was sent."); return 1; }
  const owner = where?.owner ?? state.owner ?? "00000000-0000-0000-0000-000000000000";
  if (where?.owner) state.owner = where.owner;
  let budget = LIMITS.perRun, landed = 0, already = 0, read = 0;
  for (const repo of repos) {
    if (budget <= 0) break;
    const entry = state.repos[repo.root];
    const key = repo.identity.name ?? `code:${repo.identity.code}`;
    const projectRef = where?.projects?.[key] ?? null;
    const emails = authorEmails(repo.root, state.emails);
    // Incremental: from two days before the last commit sent (a late rebase), each commit once by its reference.
    const since = entry.sentThrough ? new Date(Date.parse(entry.sentThrough) - 2 * 86_400_000).toISOString() : null;
    const sent = new Set(entry.sent ?? []);
    const commits = readCommits(repo.root, { emails, since, limit: Math.min(LIMITS.perRepo, budget) });
    const fresh = commits.map((commit) => ({ commit, payload: commitPayload(commit, { owner, projectRef }) })).filter(({ payload }) => !sent.has(payload.ref.slice(0, 16)));
    budget -= fresh.length; read += fresh.length;
    if (io.dryRun) { io.say(`  ${key}: ${fresh.length} commit(s) would be sent (nothing sent: --dry-run)`); continue; }
    const since0 = repoSince(repo.root);
    let through = entry.sentThrough ?? "";
    for (let at = 0; at < fresh.length; at += LIMITS.perBatch) {
      const part = fresh.slice(at, at + LIMITS.perBatch);
      const body = { repos: [{ ...label(repo), ...(since0 ? { since: since0 } : {}), commits: part.map(({ payload }) => payload) }] };
      const leak = leakIn(body, { paths: part.flatMap(({ commit }) => commit.paths), roots: [repo.root], remotes: [git(repo.root, "remote", "get-url", "origin").trim()] });
      if (leak) { io.say(`  Refused before sending: the batch would carry ${leak}. Nothing of ${key} was sent.`); return 1; }
      const receipt = await io.send(body);
      // Not landed, nothing lost: the mark does not move, so the next run reads and sends these commits again.
      if (receipt?.refused) { io.say(`  ${key}: not sent. ${receipt.refused.message}`); if (!io.dryRun) saveState(state, home); return 1; }
      if (!receipt) { io.say(`  ${key}: not sent (WorkTrust unreachable or refused); the next run tries again.`); if (!io.dryRun) saveState(state, home); return 1; }
      landed += receipt.landed ?? 0; already += receipt.already ?? 0;
      for (const { payload } of part) sent.add(payload.ref.slice(0, 16));
      through = part.reduce((max, { payload }) => (payload.at > max ? payload.at : max), through);
      state.repos[repo.root] = { ...state.repos[repo.root], sentThrough: through, sent: [...sent].slice(-5000) };
      saveState(state, home);
    }
  }
  if (!io.dryRun) saveState(state, home);
  io.say(io.dryRun ? `  ${read} commit(s) read; nothing sent.` : `  Sent: ${landed} commit(s) landed, ${already} already on your record through GitHub.`);
  return 0;
}
