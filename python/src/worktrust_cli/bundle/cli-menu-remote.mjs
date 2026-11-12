/**
 * THE MENU'S DEEPER LEVELS (CLI 0.11.7): Remote Agent ›, its projects, roots, allowed modes and connections, and the history and
 * preservation choices. Each item still runs one direct command (runShown), named in its muted line; this file only reads
 * the remote settings to label the items and never writes one itself: a change goes through the command, so it goes
 * through applySettingsChange (remote-settings.mjs) like a typed one. Folders are chosen without typing (folder-picker.mjs).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { choose, muted, runShown, typed } from "./cli-menu.mjs";
import { makeProjectsFolder, pickFolder, pickerCommand, suggestedFolders } from "./folder-picker.mjs";
import { connections } from "./remote-connections.mjs";
import { loadIdentity, loadProjects, loadRoots, loadSettings } from "./remote-store.mjs";
import { allowedModes } from "./remote-settings.mjs";

const BACK = { label: "← Back", back: true };
const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** Loop one level: each pick runs, Back or Esc returns; a pick that returns false ends the menu (Ctrl+C after a command). */
async function level(term, header, title, build) {
  for (;;) {
    const picked = await choose(term, { header, title, items: build() });
    if (picked === "quit") return false;
    if (picked === "back" || picked.item.back) return true;
    if (picked.item.run && (await picked.item.run()) === false) return false;
  }
}

/** The folder the system picker chose, or a typed path where there is no picker. */
async function chooseFolder(term) {
  const command = pickerCommand();
  if (command) { term.restore(); const path = await pickFolder(command); term.enter(); return path; }
  return typed(term, "No folder picker on this system. Type the folder's path:");
}

/** Roots › Add folders: the suggested folders, ticked with Space, a new folder, or the system's picker. */
async function addRoots(term, io, header) {
  const have = new Set(loadRoots().map((r) => r.path));
  const offered = suggestedFolders().filter((f) => !have.has(f.path));
  const items = [
    ...offered.map((f) => ({ label: `${tilde(f.path)}  ${muted(`${f.projects} project${f.projects === 1 ? "" : "s"} found`)}`, tick: true, path: f.path })),
    { label: "+ Make a new folder for my projects", make: true, hint: "~/Projects by default; new projects in it get git init" },
    { label: "Choose another folder…", pick: true, hint: "the system's folder picker" },
    BACK,
  ];
  const picked = await choose(term, { header, title: "Add folders where your projects live", items, multi: true });
  if (picked === "quit") return false;
  if (picked === "back" || picked.item.back) return true;
  const chosen = picked.ticked.map((i) => ({ path: i.path, gitInit: false }));
  if (picked.item.make) {
    const name = await typed(term, "Name of the new folder in your home folder:", "Projects");
    term.enter();
    if (name) { const made = makeProjectsFolder(name); if (made.ok) chosen.push({ path: made.path, gitInit: true }); else { term.write(`  ${made.reason}\n`); await term.key(); } }
  }
  if (picked.item.pick) { const path = await chooseFolder(term); term.enter(); if (path) chosen.push({ path, gitInit: false }); }
  for (const c of chosen) if ((await runShown(term, io, ["remote", "roots", "add", c.path, ...(c.gitInit ? ["--git-init"] : [])])) === false) return false;
  return true;
}

function rootsMenu(term, io, header) {
  return level(term, header, "Roots for new projects", () => [
    { label: "+ Add folders", hint: "npx worktrust remote roots add <folder>   a phone opens the projects in it and may create new ones", run: () => addRoots(term, io, header) },
    ...loadRoots().map((r) => ({ label: `Remove ${tilde(r.path)}`, hint: `npx worktrust remote roots remove ${tilde(r.path)}`, run: () => runShown(term, io, ["remote", "roots", "remove", r.path]) })),
    BACK,
  ]);
}

function projectsMenu(term, io, header) {
  return level(term, header, "Projects a phone may steer an agent in", () => [
    { label: "+ Add a project folder…", hint: "npx worktrust remote projects add <folder>   the system's folder picker", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["remote", "projects", "add", path]) : true; } },
    ...loadProjects().map((p) => ({ label: `Remove ${tilde(p.path)}`, hint: `npx worktrust remote projects remove ${tilde(p.path)}`, run: () => runShown(term, io, ["remote", "projects", "remove", p.path]) })),
    BACK,
  ]);
}

function modesMenu(term, io, header) {
  return level(term, header, "Agent modes a phone may start here", () => {
    const allowed = allowedModes(loadSettings());
    const toggle = (mode, words) => ({ label: `${words}: ${allowed.includes(mode) ? "allowed" : "not allowed"}`, hint: `npx worktrust remote modes ${allowed.includes(mode) ? "deny" : "allow"} ${mode}${mode === "auto" ? "   allowing auto allows edit too" : ""}`,
      run: () => runShown(term, io, ["remote", "modes", allowed.includes(mode) ? "deny" : "allow", mode]) });
    return [
      { label: "Manual (asks for every change): always allowed", disabled: true },
      { label: "Plan (read-only): always allowed", disabled: true },
      toggle("edit", "Edit automatically"),
      toggle("auto", "Auto (the agent's own automatic mode)"),
      { label: "Status", hint: "npx worktrust remote modes status", run: () => runShown(term, io, ["remote", "modes", "status"]) },
      BACK,
    ];
  });
}

function connectionsMenu(term, io, header) {
  return level(term, header, "Connections to this computer", () => {
    const list = connections();
    return [
      { label: "List them", hint: "npx worktrust remote connections", run: () => runShown(term, io, ["remote", "connections"]) },
      ...list.filter((c) => c.state === "pending").map((c) => ({ label: `Confirm ${c.name} (pending)`, hint: `npx worktrust remote phones confirm ${c.fingerprint}`, run: () => runShown(term, io, ["remote", "phones", "confirm", c.fingerprint]) })),
      ...list.map((c) => ({ label: `${c.name} · ${c.kind} · ${c.fingerprint}`, hint: `npx worktrust remote disconnect ${c.n}   Enter: disconnect (asks twice)`, run: () => runShown(term, io, ["remote", "disconnect", c.fingerprint]) })),
      ...(list.length > 0 ? [{ label: "Close all connections", hint: "npx worktrust remote disconnect --all   type close all to confirm", run: () => runShown(term, io, ["remote", "disconnect", "--all"]) }] : []),
      BACK,
    ];
  });
}

/** Remote Agent ›. Approved already: "Link a phone" comes first and approving reads "approve again". */
export function remoteMenu(term, io, header) {
  return level(term, header, "Remote Agent", () => {
    const approved = Boolean(loadIdentity()), settings = loadSettings();
    const approveMenu = { label: approved ? "Approved ✓ · approve again ›" : "Approve this computer ›", hint: approved ? "npx worktrust remote app --repair   new keys for this computer" : "npx worktrust remote app | web",
      run: () => level(term, header, approved ? "Approve this computer again (new keys)" : "Approve this computer", () => [
        { label: "With the WorkTrust app", hint: `npx worktrust remote app${approved ? " --repair" : ""}   a QR here, approved on your phone`, run: () => runShown(term, io, ["remote", "app", ...(approved ? ["--repair"] : [])]) },
        { label: "In the browser", hint: `npx worktrust remote web${approved ? " --repair" : ""}`, run: () => runShown(term, io, ["remote", "web", ...(approved ? ["--repair"] : [])]) },
        BACK,
      ]) };
    const link = { label: "Link a phone (QR here)", hint: "npx worktrust remote pair", run: () => runShown(term, io, ["remote", "pair"]) };
    const paused = settings.paused !== null;
    return [
      ...(approved ? [link, approveMenu] : [approveMenu, link]),
      { label: "Projects ›", hint: "npx worktrust remote projects", run: () => projectsMenu(term, io, header) },
      { label: "Roots for new projects ›", hint: "npx worktrust remote roots", run: () => rootsMenu(term, io, header) },
      { label: "Allowed modes ›", hint: "npx worktrust remote modes", run: () => modesMenu(term, io, header) },
      { label: "Connections ›", hint: "npx worktrust remote connections", run: () => connectionsMenu(term, io, header) },
      { label: paused ? "Resume" : "Pause", hint: `npx worktrust remote ${paused ? "resume" : "pause"}`, run: () => runShown(term, io, ["remote", paused ? "resume" : "pause"]) },
      { label: "Status", hint: "npx worktrust remote status", run: () => runShown(term, io, ["remote", "status"]) },
      BACK,
    ];
  });
}

export function historyMenu(term, io, header) {
  return level(term, header, "Import earlier history", () => [
    { label: "This computer's earlier sessions", hint: "npx worktrust history   shows the plan, asks first", run: () => runShown(term, io, ["history"]) },
    { label: "From your local archive", hint: "npx worktrust history --from-archive", run: () => runShown(term, io, ["history", "--from-archive"]) },
    { label: "From a ChatGPT or Claude export…", hint: "npx worktrust history --export <path>   reconstructed, never verified hours", run: async () => { const path = await typed(term, "The export's path (the zip, its folder or conversations.json):", join(homedir(), "Downloads")); term.enter(); return path ? runShown(term, io, ["history", "--export", path]) : true; } },
    { label: "From a copied session folder…", hint: "npx worktrust history --from-folder <dir>", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["history", "--from-folder", path]) : true; } },
    BACK,
  ]);
}

export function preserveMenu(term, io, header) {
  return level(term, header, "Preserve evidence", () => [
    { label: "How long each AI app keeps its sessions", hint: "npx worktrust preserve   local only", run: () => runShown(term, io, ["preserve"]) },
    { label: "Keep them longer", hint: "npx worktrust preserve --apply   asks per change", run: () => runShown(term, io, ["preserve", "--apply"]) },
    { label: "Make a local archive", hint: "npx worktrust preserve --archive", run: () => runShown(term, io, ["preserve", "--archive"]) },
    { label: "Check the archive", hint: "npx worktrust preserve --verify", run: () => runShown(term, io, ["preserve", "--verify"]) },
    { label: "Count hours from the archive", hint: "npx worktrust preserve --summary", run: () => runShown(term, io, ["preserve", "--summary"]) },
    BACK,
  ]);
}
