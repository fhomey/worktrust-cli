/**
 * ROOTS AND NEW PROJECTS (owner, 2026-11-07: the phone's projects, each with its sessions, and a "New session" sheet
 * whose project may be New, with a storage location). docs/remote-agents/PROTOCOL.md "Projects and sessions".
 *
 * A ROOT is a parent folder the person added at the keyboard (`worktrust remote roots add <dir> [--git-init]`), held to
 * the same rule as a granted project (canonical, every symlink resolved, never the disk's root, the home folder or above
 * it, never a folder of secrets). A phone may ask for ONE new, empty folder inside a root (`project.create`): a single
 * name of [A-Za-z0-9._-] that does not start with a dot and does not exist yet. The computer makes that folder and nothing
 * else (no parents, no files), checks after making it that it sits directly inside the root, grants it as a project, and
 * runs `git init` in it only when the person enabled that for the root. Nothing a phone sends names a path.
 *
 * BROAD ROOTS OPEN EXISTING PROJECTS (owner, 2026-11-12: "broad roots, not full access"; CLI 0.11.7). The inventory also
 * lists the git projects that already lie DIRECTLY inside each root (rootProjects), most recently changed first, within
 * the inventory's 30; a phone may start a session in one by the id the inventory gave, never by a path. Each is held to
 * the granted-project rule (canonicalProject: never the home folder or above it, never a folder of secrets) and must
 * still sit directly inside its root once every link is resolved, so a link in a root that points elsewhere opens nothing.
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import * as P from "./remote-protocol.mjs";
import { canonicalProject } from "./remote-policy.mjs";
import { projectIdOf } from "./remote-store.mjs";

export const MAX_ROOTS = 20;
/** The inventory lists 30 projects; a phone creates no more than that (review 2026-11-07, P3-9). */
export const MAX_PROJECTS = 30;

export const rootIdOf = (projectSecret, canonicalPath) =>
  `rot_${P.toBase64Url(createHmac("sha256", Buffer.from(projectSecret)).update(`worktrust-remote/v1/root\n${canonicalPath}`).digest().subarray(0, 16))}`;

/** "Desktop/WorkTrust" for a folder under the home folder; else its last two segments. Sealed, for the phone's picker. */
export function rootLabel(path) {
  const home = homedir();
  const inside = path.startsWith(home + sep) ? relative(home, path) : path.split(sep).filter(Boolean).slice(-2).join("/");
  return (inside || basename(path) || path).split(sep).join("/").slice(0, 256);
}

/** `roots add`: the folder's canonical path under the project rule, or why not. */
export function checkRoot(dir) {
  const canonical = canonicalProject(dir);
  return canonical.ok ? { ok: true, path: canonical.path } : { ok: false, reason: canonical.reason.replace("granted: grant one project folder", "a root: add the folder your projects go in") };
}

/**
 * The main repository a project's folder is a git WORKTREE of (owner, 2026-11-08: a worktree's sessions sit under its
 * main repository on the phone), or null: the main checkout itself, a folder outside git, or git not answering in time.
 * `git rev-parse --git-common-dir` names the main repository's .git for a worktree and the folder's own for the main
 * checkout. Asked once per folder per run of the daemon; never a path a phone sent.
 */
const mains = new Map();
export function worktreeMain(path) {
  if (mains.has(path)) return mains.get(path);
  let main = null;
  try {
    const ask = (flag) => execFileSync("git", ["rev-parse", "--path-format=absolute", flag], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true }).trim();
    const common = ask("--git-common-dir");
    const top = realpathSync(ask("--show-toplevel"));
    if (basename(common) === ".git") { const repo = realpathSync(dirname(common)); if (repo !== top) main = repo; }
  } catch { main = null; }
  mains.set(path, main);
  return main;
}

/**
 * project.create: → { ok: true, project, git } or { ok: false, reason } with a protocol reject reason. `o`: { name,
 * root (a roots.json entry), projectSecret, projects, saveProjects, now }.
 */
export function createProject(o) {
  if (!P.projectNameOk(o.name)) return { ok: false, reason: "unsupported" };
  if (!o.root) return { ok: false, reason: "not_found" };
  if (o.projects().length >= MAX_PROJECTS) return { ok: false, reason: "busy" };
  const root = checkRoot(o.root.path);
  if (!root.ok || root.path !== o.root.path) return { ok: false, reason: "not_found" }; // moved, gone, or now a link elsewhere
  const target = join(root.path, o.name);
  let exists = existsSync(target);
  try { lstatSync(target); exists = true; } catch { /* free */ }
  if (exists) return { ok: false, reason: "conflict" };
  try { mkdirSync(target, { mode: 0o755 }); } catch { return { ok: false, reason: "conflict" }; } // one folder, no parents
  const made = realpathSync(target);
  if (dirname(made) !== root.path || basename(made) !== o.name) { try { rmdirSync(target); } catch { /* left empty */ } return { ok: false, reason: "conflict" }; }
  let git = false;
  if (o.root.git_init === true) {
    try { execFileSync("git", ["init", "-q"], { cwd: made, stdio: "ignore", timeout: 15_000, windowsHide: true }); git = true; } catch { git = false; }
  }
  const list = o.projects();
  const project_id = projectIdOf(o.projectSecret, made); // the id `worktrust remote projects add` gives the folder
  o.saveProjects([...list.filter((p) => p.project_id !== project_id), { project_id, path: made, added_at: o.now(), root_id: o.root.root_id }]);
  return { ok: true, git, project: { project_id, label: o.name.slice(0, 256), path: made.slice(0, 4096), root_id: o.root.root_id } };
}


/** A git project's folder: it holds `.git` (a folder, or a worktree's file). */
const isGitProject = (path) => { try { lstatSync(join(path, ".git")); return true; } catch { return false; } };

/**
 * The existing git projects directly inside the roots, as session projects { project_id, path, root_id, from_root: true },
 * newest change first, leaving out what `granted` already lists; at most `limit`. Read at the computer, every time.
 */
export function rootProjects(roots, projectSecret, granted = [], limit = MAX_PROJECTS) {
  const taken = new Set(granted.map((p) => p.path)), found = [];
  for (const r of roots) {
    const root = checkRoot(r.path);
    if (!root.ok || root.path !== r.path) continue; // moved, gone, or now a link elsewhere
    let names = [];
    try { names = readdirSync(root.path, { withFileTypes: true }).filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith(".")).map((d) => d.name); } catch { continue; }
    for (const name of names.slice(0, 2000)) {
      const canonical = canonicalProject(join(root.path, name));
      if (!canonical.ok || dirname(canonical.path) !== root.path || taken.has(canonical.path) || !isGitProject(canonical.path)) continue;
      let changed = 0;
      try { changed = statSync(canonical.path).mtimeMs; } catch { continue; }
      taken.add(canonical.path);
      found.push({ project_id: projectIdOf(projectSecret, canonical.path), path: canonical.path, root_id: r.root_id, from_root: true, changed });
    }
  }
  return found.sort((a, b) => b.changed - a.changed).slice(0, Math.max(0, limit)).map(({ changed, ...p }) => p);
}

/** What a session may run in: the granted projects, then the existing projects inside the roots, 30 in all (the inventory's). */
export function sessionProjects({ projects, roots, projectSecret }) {
  const granted = projects().slice(0, MAX_PROJECTS);
  return [...granted, ...rootProjects(roots(), projectSecret, granted, MAX_PROJECTS - granted.length)];
}
