/**
 * WHICH FILES A TURN CHANGED, WITH A BOUNDED DIFF EACH (owner, 2026-11-07: the phone shows the code so the person can
 * steer). Read-only on the person's repository: nothing is staged, stashed, committed or written into .git.
 *
 * When the turn begins (`snapshotChanges`): HEAD, and the content of every file that was already changed or untracked
 * then (bounded). When it ends (`collectChanges`): every file whose content differs from that snapshot, inside the project
 * folder only, as a unified diff from git itself (`git diff HEAD -- <file>` for a file that was clean, `git diff --no-index`
 * against the kept content for one that was not). Caps: 32 KiB per file, 256 KiB per result, 200 files; each cut is said.
 * A binary file is named, never shown; a secret file (remote-policy.mjs) is named with its diff withheld (diff_cut).
 * Outside a repository the files come from the agent's own edit tools, named without a diff (`agent_tools`).
 * Every git call is execFile with fixed arguments, `--` before paths, and no shell.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSecretPath } from "./remote-policy.mjs";

export const PER_FILE = 32_768, PER_RESULT = 262_144, MAX_FILES = 200;
const KEEP_BYTES = 1_048_576, KEEP_FILES = 500;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd, args, okCodes = [0]) {
  try { return execFileSync("git", args, { cwd, encoding: "buffer", timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" } }); }
  catch (error) { if (okCodes.includes(error.status) && error.stdout) return error.stdout; return null; }
}
const lines0 = (buf) => (buf ? buf.toString("utf8").split("\0").filter(Boolean) : []);
const hashOf = (file) => { try { return statSync(file).size > KEEP_BYTES ? `size:${statSync(file).size}:${statSync(file).mtimeMs}` : createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return null; } };
const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

/** The state when a turn begins. `{ source: "none" }` outside a repository or without git. */
export function snapshotChanges(cwd) {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"])?.toString().trim() !== "true") return { source: "agent_tools" };
  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.toString().trim() || EMPTY_TREE;
  const dirty = [...new Set([...lines0(git(cwd, ["diff", "--relative", "--name-only", "-z", head])), ...lines0(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))])].slice(0, KEEP_FILES);
  const kept = new Map();
  for (const path of dirty) {
    const file = join(cwd, path);
    try { kept.set(path, statSync(file).size <= KEEP_BYTES ? { hash: hashOf(file), bytes: readFileSync(file) } : { hash: hashOf(file), bytes: null }); } catch { kept.set(path, { hash: null, bytes: null }); }
  }
  return { source: "vcs", head, kept, untracked: new Set(lines0(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))) };
}

function capDiff(text) {
  if (!text) return { diff: null, diff_cut: false };
  return text.length > PER_FILE ? { diff: `${text.slice(0, PER_FILE - 64)}\n[cut: the rest of this diff is not shown]`, diff_cut: true } : { diff: text, diff_cut: false };
}

/** The files the turn changed, for agent.completed's result. `agentFiles` are the edit tools' own paths (outside a repo). */
export function collectChanges(snapshot, cwd, agentFiles = [], scratchDir = null) {
  if (snapshot.source !== "vcs") {
    const files = [...new Set(agentFiles)].slice(0, MAX_FILES).map((path) => ({ path: String(path).slice(0, 4096), change: "modified", binary: false, diff: null, diff_cut: false }));
    return { source: files.length ? "agent_tools" : "none", files, files_cut: new Set(agentFiles).size > MAX_FILES };
  }
  const changed = new Map(); // path -> change
  const status = lines0(git(cwd, ["diff", "--relative", "--name-status", "-z", "--no-renames", snapshot.head]));
  for (let i = 0; i + 1 < status.length; i += 2) changed.set(status[i + 1], status[i] === "A" ? "added" : status[i] === "D" ? "deleted" : "modified");
  for (const path of lines0(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))) changed.set(path, snapshot.untracked.has(path) ? "modified" : "added");
  for (const [path, before] of snapshot.kept) {
    const now = existsSync(join(cwd, path)) ? hashOf(join(cwd, path)) : null;
    if (now === before.hash) changed.delete(path); // unchanged during the turn: not this turn's work
    else if (now === null) changed.set(path, "deleted");
  }
  const paths = [...changed.keys()].sort();
  const files = [];
  let budget = PER_RESULT;
  const tmp = scratchDir ? mkdtempSync(join(scratchDir, "diff-")) : null;
  try {
    for (const path of paths.slice(0, MAX_FILES)) {
      const change = changed.get(path), file = join(cwd, path);
      const entry = { path: path.slice(0, 4096), change, binary: false, diff: null, diff_cut: false };
      let current = null;
      try { current = change === "deleted" ? null : readFileSync(file); } catch { current = null; }
      const before = snapshot.kept.get(path);
      if ((current && isBinary(current)) || (before?.bytes && isBinary(before.bytes))) { files.push({ ...entry, binary: true }); continue; }
      if (isSecretPath(file)) { files.push({ ...entry, diff_cut: true }); continue; }
      let text = null;
      if (before && before.bytes && tmp) {
        const old = join(tmp, "before");
        writeFileSync(old, before.bytes);
        text = git(cwd, ["diff", "--no-index", "--no-color", "-U3", "--", old, change === "deleted" ? "/dev/null" : file], [0, 1])?.toString("utf8").replace(/^(diff --git |--- |\+\+\+ )[^\n]*\n/gm, "") ?? null;
        if (text) text = `--- a/${path}\n+++ b/${path}\n${text}`;
      } else if (change === "added" && current && !snapshot.untracked.has(path) && !before) {
        const body = current.toString("utf8"), rows = body.split("\n"); if (rows.at(-1) === "") rows.pop();
        text = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${rows.length} @@\n${rows.map((r) => `+${r}`).join("\n")}\n`;
      } else if (!before) text = git(cwd, ["diff", "--relative", "--no-color", "--no-ext-diff", "-U3", snapshot.head, "--", path])?.toString("utf8") ?? null;
      const capped = capDiff(text && text.trim() ? text : null);
      if (capped.diff && capped.diff.length > budget) { files.push({ ...entry, diff_cut: true }); continue; }
      budget -= capped.diff?.length ?? 0;
      files.push({ ...entry, ...capped });
    }
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  return { source: "vcs", files, files_cut: paths.length > MAX_FILES };
}
