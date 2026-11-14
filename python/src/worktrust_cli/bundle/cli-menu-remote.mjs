/**
 * THE MENU'S DEEPER LEVELS (CLI 0.11.7; 0.11.8: every item says in one sentence what it does, `info`, beside its command, `hint`): Remote Agent ›, its projects, roots, allowed modes and connections, and the history and
 * preservation choices. Each item still runs one direct command (runShown), named in its muted line; this file only reads
 * the remote settings to label the items and never writes one itself: a change goes through the command, so it goes
 * through applySettingsChange (remote-settings.mjs) like a typed one. Folders are chosen without typing (folder-picker.mjs).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { choose, runShown, typed } from "./cli-menu.mjs";
import { makeProjectsFolder, pickFolder, pickerCommand, suggestedFolders } from "./folder-picker.mjs";
import { connections } from "./remote-connections.mjs";
import { loadIdentity, loadProjects, loadRoots, loadSettings } from "./remote-store.mjs";
import { allowedModes } from "./remote-settings.mjs";

const BACK = { label: "← Back", hint: "Esc", info: "Returns to the list before this one.", back: true };
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
    ...offered.map((f) => ({ label: tilde(f.path), note: { text: `${f.projects} project${f.projects === 1 ? "" : "s"} found`, tone: "dim" }, info: "Space ticks it; Enter adds the ticked folders as roots.", tick: true, path: f.path })),
    { label: "+ Make a new folder for my projects", make: true, hint: "npx worktrust remote roots add <folder> --git-init", info: "Asks for a name (Projects by default), makes the folder in your home folder and adds it; new projects in it get git init." },
    { label: "Choose another folder…", pick: true, hint: "npx worktrust remote roots add <folder>", info: "Opens the system's folder picker and adds the folder you choose." },
    BACK,
  ];
  const picked = await choose(term, { header, title: "Add folders where your projects live", items, multi: true });
  if (picked === "quit") return false;
  if (picked === "back" || picked.item.back) return true;
  const chosen = picked.ticked.map((i) => ({ path: i.path, gitInit: false }));
  if (picked.item.make) {
    const name = await typed(term, "Name of the new folder in your home folder:", "Projects");
    term.enter();
    if (name) { const made = makeProjectsFolder(name); if (made.ok) chosen.push({ path: made.path, gitInit: true }); else { term.write(`  ${made.reason}\n`); await term.anyKey(); } }
  }
  if (picked.item.pick) { const path = await chooseFolder(term); term.enter(); if (path) chosen.push({ path, gitInit: false }); }
  for (const c of chosen) if ((await runShown(term, io, ["remote", "roots", "add", c.path, ...(c.gitInit ? ["--git-init"] : [])])) === false) return false;
  return true;
}

function rootsMenu(term, io, header) {
  return level(term, header, "Roots for new projects", () => [
    { label: "+ Add folders", hint: "npx worktrust remote roots add <folder>", info: "Opens a list of folders to tick. A phone may open the projects in a root and create new ones there.", run: () => addRoots(term, io, header) },
    ...loadRoots().map((r) => ({ label: `Remove ${tilde(r.path)}`, hint: `npx worktrust remote roots remove ${tilde(r.path)}`, info: "Takes this folder off the list; a phone can no longer open or create projects in it. No file is touched.", run: () => runShown(term, io, ["remote", "roots", "remove", r.path]) })),
    BACK,
  ]);
}

function projectsMenu(term, io, header) {
  return level(term, header, "Projects a phone may steer an agent in", () => [
    { label: "+ Add a project folder…", hint: "npx worktrust remote projects add <folder>", info: "Opens the system's folder picker; a phone may then steer an agent in the folder you choose.", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["remote", "projects", "add", path]) : true; } },
    ...loadProjects().map((p) => ({ label: `Remove ${tilde(p.path)}`, hint: `npx worktrust remote projects remove ${tilde(p.path)}`, info: "Takes this folder off the list; a phone can no longer start an agent in it. No file is touched.", run: () => runShown(term, io, ["remote", "projects", "remove", p.path]) })),
    BACK,
  ]);
}

function modesMenu(term, io, header) {
  return level(term, header, "Agent modes a phone may start here", () => {
    const allowed = allowedModes(loadSettings());
    const toggle = (mode, words) => ({ label: `${words}: ${allowed.includes(mode) ? "allowed" : "not allowed"}`, hint: `npx worktrust remote modes ${allowed.includes(mode) ? "deny" : "allow"} ${mode}`, info: allowed.includes(mode) ? `Stops a phone from starting an agent in this mode${mode === "edit" ? "; auto goes with it" : ""}.` : `Lets a phone start an agent in this mode${mode === "auto" ? "; allowing auto allows edit too" : ""}.`,
      run: () => runShown(term, io, ["remote", "modes", allowed.includes(mode) ? "deny" : "allow", mode]) });
    return [
      { label: "Manual (asks for every change): always allowed", info: "Always there: the agent asks you before every change.", disabled: true },
      { label: "Plan (read-only): always allowed", info: "Always there: the agent reads and plans, and changes nothing.", disabled: true },
      toggle("edit", "Edit automatically"),
      toggle("auto", "Auto (the agent's own automatic mode)"),
      { label: "Status", hint: "npx worktrust remote modes status", info: "Shows which modes a phone may start here. It only reads.", run: () => runShown(term, io, ["remote", "modes", "status"]) },
      BACK,
    ];
  });
}

function connectionsMenu(term, io, header) {
  return level(term, header, "Connections to this computer", () => {
    const list = connections();
    return [
      { label: "List them", hint: "npx worktrust remote connections", info: "Shows every phone and browser linked to this computer. It only reads.", run: () => runShown(term, io, ["remote", "connections"]) },
      ...list.filter((c) => c.state === "pending").map((c) => ({ label: `Confirm ${c.name} (pending)`, hint: `npx worktrust remote phones confirm ${c.fingerprint}`, info: "Confirms this pending link, so it may steer agents here. Check the fingerprint on the device first.", run: () => runShown(term, io, ["remote", "phones", "confirm", c.fingerprint]) })),
      ...list.map((c) => ({ label: `${c.name} · ${c.kind} · ${c.fingerprint}`, hint: `npx worktrust remote disconnect ${c.n}`, info: "Closes this connection; that device has to be linked again to come back. It asks twice.", run: () => runShown(term, io, ["remote", "disconnect", c.fingerprint]) })),
      ...(list.length > 0 ? [{ label: "Close all connections", hint: "npx worktrust remote disconnect --all", info: "Closes every connection to this computer. You type close all to confirm.", run: () => runShown(term, io, ["remote", "disconnect", "--all"]) }] : []),
      BACK,
    ];
  });
}

/** Remote Agent ›. Approved already: "Link a phone" comes first and approving reads "approve again". */
export function remoteMenu(term, io, header) {
  return level(term, header, "Remote Agent", () => {
    const approved = Boolean(loadIdentity()), settings = loadSettings();
    const approveMenu = { label: approved ? "Approved ✓ · approve again ›" : "Approve this computer ›", hint: approved ? "npx worktrust remote app --repair" : "npx worktrust remote app | web", info: approved ? "Opens the two ways to approve this computer again; that gives it new keys, and linked phones link again." : "Opens the two ways to approve this computer for Remote Agent. Nothing changes yet.",
      run: () => level(term, header, approved ? "Approve this computer again (new keys)" : "Approve this computer", () => [
        { label: "With the WorkTrust app", hint: `npx worktrust remote app${approved ? " --repair" : ""}`, info: "Shows a QR here; you scan it with the WorkTrust app and approve this computer on your phone.", run: () => runShown(term, io, ["remote", "app", ...(approved ? ["--repair"] : [])]) },
        { label: "In the browser", hint: `npx worktrust remote web${approved ? " --repair" : ""}`, info: "Opens WorkTrust in your browser, where you approve this computer.", run: () => runShown(term, io, ["remote", "web", ...(approved ? ["--repair"] : [])]) },
        BACK,
      ]) };
    const link = { label: "Link a phone (QR here)", hint: "npx worktrust remote pair", info: "Shows a QR here; scanning it with the WorkTrust app links that phone to this computer.", run: () => runShown(term, io, ["remote", "pair"]) };
    const paused = settings.paused !== null;
    return [
      ...(approved ? [link, approveMenu] : [approveMenu, link]),
      { label: "Projects ›", hint: "npx worktrust remote projects", info: "Opens the folders a phone may steer an agent in, to add or remove one.", run: () => projectsMenu(term, io, header) },
      { label: "Roots for new projects ›", hint: "npx worktrust remote roots", info: "Opens the folders whose projects a phone may open, and where it may create new ones.", run: () => rootsMenu(term, io, header) },
      { label: "Allowed modes ›", hint: "npx worktrust remote modes", info: "Opens the agent modes a phone may start here: this computer is the ceiling.", run: () => modesMenu(term, io, header) },
      { label: "Connections ›", hint: "npx worktrust remote connections", info: "Opens the phones and browsers linked here, to confirm or close one.", run: () => connectionsMenu(term, io, header) },
      { label: paused ? "Resume" : "Pause", hint: `npx worktrust remote ${paused ? "resume" : "pause"}`, info: paused ? "Lets linked phones steer agents here again." : "Stops every phone from steering agents here until you resume; links and settings stay.", run: () => runShown(term, io, ["remote", paused ? "resume" : "pause"]) },
      { label: "Status", hint: "npx worktrust remote status", info: "Shows whether Remote Agent is on, its service and what is linked. It only reads.", run: () => runShown(term, io, ["remote", "status"]) },
      BACK,
    ];
  });
}

export function historyMenu(term, io, header) {
  return level(term, header, "Import earlier history", () => [
    { label: "This computer's earlier sessions", hint: "npx worktrust history", info: "Sends the sessions your AI apps still hold here as history. It shows the plan and asks first.", run: () => runShown(term, io, ["history"]) },
    { label: "From your local archive", hint: "npx worktrust history --from-archive", info: "Sends what your local archive holds of sessions your AI apps already deleted. It shows the plan and asks first.", run: () => runShown(term, io, ["history", "--from-archive"]) },
    { label: "From a ChatGPT or Claude export…", hint: "npx worktrust history --export <path>", info: "Asks for the export's path, then shows the plan and asks. These hours are reconstructed, never verified hours.", run: async () => { const path = await typed(term, "The export's path (the zip, its folder or conversations.json):", join(homedir(), "Downloads")); term.enter(); return path ? runShown(term, io, ["history", "--export", path]) : true; } },
    { label: "From a copied session folder…", hint: "npx worktrust history --from-folder <dir>", info: "Opens the folder picker for your own copy of a session folder, then shows the plan and asks. Reconstructed hours.", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["history", "--from-folder", path]) : true; } },
    BACK,
  ]);
}

export function preserveMenu(term, io, header) {
  return level(term, header, "Preserve evidence", () => [
    { label: "How long each AI app keeps its sessions", hint: "npx worktrust preserve", info: "Shows a report of how long each AI app here keeps its sessions. Nothing is changed or sent.", run: () => runShown(term, io, ["preserve"]) },
    { label: "Keep them longer", hint: "npx worktrust preserve --apply", info: "Sets your AI apps to keep their sessions longer. It asks per change and backs each file up first.", run: () => runShown(term, io, ["preserve", "--apply"]) },
    { label: "Make a local archive", hint: "npx worktrust preserve --archive", info: "Writes a metadata-only, hash-chained record of the measured days to ~/AI-Evidence. Nothing is sent.", run: () => runShown(term, io, ["preserve", "--archive"]) },
    { label: "Check the archive", hint: "npx worktrust preserve --verify", info: "Checks that record: every hash, the chain, each day's root and signature. It only reads.", run: () => runShown(term, io, ["preserve", "--verify"]) },
    { label: "Count hours from the archive", hint: "npx worktrust preserve --summary", info: "Counts hours, tokens per model and parallel sessions from that record. It only reads.", run: () => runShown(term, io, ["preserve", "--summary"]) },
    BACK,
  ]);
}
