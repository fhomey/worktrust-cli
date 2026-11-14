/**
 * THE MENU'S DEEPER LEVELS (CLI 0.11.7; 0.11.8: every item says in one sentence what it does, `info`, beside its command, `hint`): Remote Agent ›, its projects, roots, allowed modes and connections, and the history and
 * preservation choices. Each item still runs one direct command (runShown), named in its muted line; this file only reads
 * the remote settings to label the items and never writes one itself: a change goes through the command, so it goes
 * through applySettingsChange (remote-settings.mjs) like a typed one. Folders are chosen without typing (folder-picker.mjs).
 *
 * 0.11.9 (owner, 2026-11-14): every sentence fits the one-row form (60 characters at most), and Remote Agent asks for the
 * approval FIRST: what cannot work before it cannot be chosen (remoteItems).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { choose, remoteState, runShown, typed } from "./cli-menu.mjs";
import { makeProjectsFolder, pickFolder, pickerCommand, suggestedFolders } from "./folder-picker.mjs";
import { connections } from "./remote-connections.mjs";
import { loadIdentity, loadProjects, loadRoots, loadSettings } from "./remote-store.mjs";
import { allowedModes } from "./remote-settings.mjs";

const BACK = { label: "← Back", hint: "Esc", back: true }; // its name and its key say it: no sentence of its own (owner, 2026-11-14)
const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** Loop one level: each pick runs, Back or Esc returns; a pick that returns false ends the menu (Ctrl+C after a command). */
async function level(term, header, title, build, io = null) {
  for (;;) {
    const picked = await choose(term, { header, title: typeof title === "function" ? title() : title, items: build() });
    if (picked === "quit") return false;
    if (picked === "back" || picked.item.back) return true;
    const result = picked.item.run ? await picked.item.run() : true;
    await io?.state?.(); // the head above reads this computer again: what the command changed shows at once
    if (result === false) return false;
    if (result === "back") return true; // the step this level was for is done (0.11.9: approved): the level above draws again
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
    { label: "+ Make a new folder for my projects", make: true, hint: "npx worktrust remote roots add <folder> --git-init", info: "Makes a folder in your home folder and adds it as a root." },
    { label: "Choose another folder…", pick: true, hint: "npx worktrust remote roots add <folder>", info: "Opens the folder picker and adds the folder you choose." },
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
    { label: "+ Add folders", hint: "npx worktrust remote roots add <folder>", info: "Choose folders whose projects a phone may open or add to.", run: () => addRoots(term, io, header) },
    ...loadRoots().map((r) => ({ label: `Remove ${tilde(r.path)}`, hint: `npx worktrust remote roots remove ${tilde(r.path)}`, info: "A phone can no longer use this folder. No file is touched.", run: () => runShown(term, io, ["remote", "roots", "remove", r.path]) })),
    BACK,
  ]);
}

function projectsMenu(term, io, header) {
  return level(term, header, "Projects a phone may steer an agent in", () => [
    { label: "+ Add a project folder…", hint: "npx worktrust remote projects add <folder>", info: "Pick a folder a phone may steer an agent in.", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["remote", "projects", "add", path]) : true; } },
    ...loadProjects().map((p) => ({ label: `Remove ${tilde(p.path)}`, hint: `npx worktrust remote projects remove ${tilde(p.path)}`, info: "A phone can no longer start an agent here. No file changes.", run: () => runShown(term, io, ["remote", "projects", "remove", p.path]) })),
    BACK,
  ]);
}

function modesMenu(term, io, header) {
  return level(term, header, "Agent modes a phone may start here", () => {
    const allowed = allowedModes(loadSettings());
    const toggle = (mode, words) => ({ label: `${words}: ${allowed.includes(mode) ? "allowed" : "not allowed"}`, hint: `npx worktrust remote modes ${allowed.includes(mode) ? "deny" : "allow"} ${mode}`, info: allowed.includes(mode) ? `Stops a phone from starting this mode${mode === "edit" ? "; auto goes too" : ""}.` : `Lets a phone start this mode${mode === "auto" ? "; that allows edit too" : ""}.`,
      run: () => runShown(term, io, ["remote", "modes", allowed.includes(mode) ? "deny" : "allow", mode]) });
    return [
      { label: "Manual: always allowed", info: "Always there: the agent asks before every change.", disabled: true },
      { label: "Plan: always allowed", info: "Always there: the agent reads and plans, changes nothing.", disabled: true },
      toggle("edit", "Edit automatically"),
      toggle("auto", "Auto mode"),
      { label: "Status", hint: "npx worktrust remote modes status", info: "Shows which modes a phone may start. It only reads.", run: () => runShown(term, io, ["remote", "modes", "status"]) },
      BACK,
    ];
  });
}

/**
 * THE LINKED DEVICES, AS A TABLE (0.11.9, owner 2026-11-14): one row per connection: name, kind, since, last activity. Enter
 * opens that connection's acts. Disconnect runs the same `remote disconnect <fingerprint>` a person types, with its typed
 * confirmation (remote-connections.mjs, a security decision of 2026-11-12): the menu confirms nothing itself and fills nothing in.
 */
const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "not known");
function connectionsMenu(term, io, header) {
  return level(term, header, "Connections to this computer", () => {
    const list = connections(), wide = Math.min(20, Math.max(4, ...list.map((c) => c.name.length))), last = term.size().columns >= 72; // a narrow terminal keeps name, kind and since
    if (list.length === 0) return [
      { label: "No phone or browser is linked yet.", info: "Link one with the row below.", disabled: true, quiet: "Nothing to open here." },
      { label: "Link a phone (QR here)", hint: "npx worktrust remote pair", info: "Shows a QR that links a phone to this computer.", run: () => runShown(term, io, ["remote", "pair"]) },
      BACK,
    ];
    const acts = (c) => () => level(term, header, `${c.name} · ${c.kind} · ${c.fingerprint}`, () => [
      ...(c.state === "pending" ? [{ label: "Confirm it", hint: `npx worktrust remote phones confirm ${c.fingerprint}`, info: "Confirms this link. Check the fingerprint on the device.", run: async () => ((await runShown(term, io, ["remote", "phones", "confirm", c.fingerprint])) === false ? false : "back") }] : []),
      { label: "Disconnect", hint: `npx worktrust remote disconnect ${c.fingerprint}`, info: "Closes it. You type its name or code to confirm.", run: async () => ((await runShown(term, io, ["remote", "disconnect", c.fingerprint])) === false ? false : "back") },
      BACK,
    ], io);
    return [
      ...list.map((c) => ({ label: `${c.name.length > wide ? `${c.name.slice(0, wide - 1)}…` : c.name.padEnd(wide)}  ${c.kind.padEnd(7)}  since ${day(c.since)}${last ? `  last ${day(c.last_seen)}` : ""}${c.state === "pending" ? "  pending" : ""}`, hint: `npx worktrust remote disconnect ${c.n}`, info: `Enter opens ${c.name} · ${c.fingerprint}.`, run: acts(c) })),
      { label: "Disconnect all…", hint: "npx worktrust remote disconnect --all", info: "Closes every connection. You type close all to confirm.", run: () => runShown(term, io, ["remote", "disconnect", "--all"]) },
      BACK,
    ];
  }, io);
}

/**
 * SHARING (0.11.9, owner 2026-11-14): what this computer sends, in words, and the switches that exist. Each switch runs the
 * command a person types (`mcp off | on`, `remote pause | resume`); the session hook has no switch in the CLI (measuring is
 * paused in WorkTrust under Sources, and `disconnect` takes it out), so its row says so and cannot be chosen. One app alone
 * cannot be coupled or uncoupled by a command today, so there is no row per app. The state is read again at every draw.
 */
export function sharingItems(state, remote, act = {}) {
  const doorOn = state.door === "on", live = ["approved", "paused"].includes(remote.word), paused = remote.word === "paused";
  return [
    { label: `Session hook: ${state.hook === true ? "on" : state.hook === false ? "not installed" : "not known"}`, note: { text: "no switch here", tone: "dim" }, info: "Sends times, tokens, models and tools. Never content.", disabled: true, quiet: "Pause it under Sources." },
    state.door === "on" || state.door === "off"
      ? { label: `WorkTrust in your AI apps: ${doorOn ? `on${Number.isInteger(state.apps) ? ` (${state.apps} app${state.apps === 1 ? "" : "s"})` : ""}` : "off"}`, hint: `npx worktrust mcp ${doorOn ? "off" : "on"}`, info: doorOn ? "On: your AI logs finished work. Enter takes the door out." : "Off: hours only. Enter puts the door back in your AI apps.", run: () => act.door?.(doorOn ? "off" : "on") }
      : { label: "WorkTrust in your AI apps: not known", hint: "npx worktrust mcp status", info: "Its state could not be read. Enter shows it.", run: () => act.door?.("status") },
    live
      ? { label: `Remote Agent: ${paused ? "paused" : "on"}`, hint: `npx worktrust remote ${paused ? "resume" : "pause"}`, info: paused ? "Paused: no phone steers agents here. Enter resumes." : "On: linked phones steer agents here. Enter pauses.", run: () => act.remote?.(paused ? "resume" : "pause") }
      : { label: `Remote Agent: ${remote.word}`, hint: "npx worktrust remote …", info: "Lets your phone steer this computer's agents.", disabled: true, quiet: remote.word === "not known" ? "Its state could not be read." : "Set it up under Remote Agent." },
    BACK,
  ];
}
export async function sharingMenu(term, io, header) {
  for (;;) {
    const state = await io.state();
    const picked = await choose(term, { header, title: "Sharing", items: sharingItems(state, remoteState(), { door: (to) => runShown(term, io, ["mcp", to]), remote: (to) => runShown(term, io, ["remote", to]) }) });
    if (picked === "quit") return false;
    if (picked === "back" || picked.item.back) return true;
    if ((await picked.item.run()) === false) return false;
  }
}

/**
 * WHETHER THIS COMPUTER IS APPROVED FOR REMOTE AGENT, in three states (0.11.9): true (its identity is here), false (none),
 * null when the file could not be read (remote-store readJson refuses an unreadable or non-private one): not known is
 * never "not approved".
 */
export function approval() { try { return Boolean(loadIdentity()); } catch { return null; } }

/**
 * Remote Agent's rows (owner, 2026-11-14: "first the approve, and once that succeeded you go on to the other steps"). Pure:
 * `approved` is approval()'s answer, `act` what each row does. NOT APPROVED: the approval is first and chosen, and what
 * cannot work before it cannot be chosen. By the code: `remote pair` and adding a project or a root refuse without this
 * computer's remote keys (remote-cli.mjs needPaired, remote-settings.mjs applyRules), and no phone can be linked, so there
 * is no connection to list and nothing to pause. Allowed modes is a local setting and Status only reads: both stay.
 * APPROVED: Link a phone first, and approving again stays (new keys). NOT KNOWN: every row can be chosen and the title says so.
 */
export function remoteItems(approved, paused, act = {}) {
  const wait = approved === false ? { disabled: true, quiet: "Approve this computer first.", note: { text: "not yet", tone: "dim" } } : {};
  const approve = { label: approved ? "Approved ✓ · approve again ›" : "Approve this computer ›", hint: approved ? "npx worktrust remote app --repair" : "npx worktrust remote app | web", info: approved ? "Approve again: new keys, and linked phones link again." : "Needed once: your account allows steering this computer.", run: act.approve };
  const link = { label: "Link a phone (QR here)", hint: "npx worktrust remote pair", info: "Shows a QR that links a phone to this computer.", run: act.link, ...wait };
  return [
    ...(approved ? [link, approve] : [approve, link]),
    { label: "Projects ›", hint: "npx worktrust remote projects", info: "Folders a phone may steer an agent in.", run: act.projects, ...wait },
    { label: "Roots for new projects ›", hint: "npx worktrust remote roots", info: "Where a phone may open and create projects.", run: act.roots, ...wait },
    { label: "Allowed modes ›", hint: "npx worktrust remote modes", info: "Agent modes a phone may start. This computer is the limit.", run: act.modes },
    { label: "Connections ›", hint: "npx worktrust remote connections", info: "Phones and browsers linked here.", run: act.connections, ...wait },
    { label: paused ? "Resume" : "Pause", hint: `npx worktrust remote ${paused ? "resume" : "pause"}`, info: paused ? "Lets linked phones steer agents here again." : "Stops every phone until you resume. Links stay.", run: act.pause, ...wait },
    { label: "Status", hint: "npx worktrust remote status", info: "Shows if Remote Agent is on and what is linked. Only reads.", run: act.status },
    BACK,
  ];
}

/** Remote Agent ›. The rows are read again after every command, so an approval made here opens the other steps at once. */
export function remoteMenu(term, io, header) {
  const title = () => (approval() === null ? "Remote Agent · its state could not be read" : "Remote Agent");
  return level(term, header, title, () => {
    const approved = approval(), paused = (() => { try { return loadSettings().paused !== null; } catch { return false; } })();
    // The two roads; one that leaves this computer approved returns to the list above, which now opens on Link a phone.
    const road = (which) => async () => ((await runShown(term, io, ["remote", which, ...(approved ? ["--repair"] : [])])) === false ? false : approved === false && approval() === true ? "back" : true);
    return remoteItems(approved, paused, {
      approve: () => level(term, header, approved ? "Approve this computer again (new keys)" : "Approve this computer", () => [
        { label: "With the WorkTrust app", hint: `npx worktrust remote app${approved ? " --repair" : ""}`, info: "Shows a QR; scan it with the WorkTrust app and approve.", run: road("app") },
        { label: "In the browser", hint: `npx worktrust remote web${approved ? " --repair" : ""}`, info: "Opens WorkTrust in your browser, where you approve.", run: road("web") },
        BACK,
      ], io),
      link: () => runShown(term, io, ["remote", "pair"]),
      projects: () => projectsMenu(term, io, header), roots: () => rootsMenu(term, io, header), modes: () => modesMenu(term, io, header), connections: () => connectionsMenu(term, io, header),
      pause: () => runShown(term, io, ["remote", paused ? "resume" : "pause"]),
      status: () => runShown(term, io, ["remote", "status"]),
    });
  }, io);
}

export function historyMenu(term, io, header) {
  return level(term, header, "Import earlier history", () => [
    { label: "Sessions on this computer", hint: "npx worktrust history", info: "Sessions your AI apps still hold. Shows a plan, asks first.", run: () => runShown(term, io, ["history"]) },
    { label: "Your local archive", hint: "npx worktrust history --from-archive", info: "Sessions your apps deleted, from your archive. Asks first.", run: () => runShown(term, io, ["history", "--from-archive"]) },
    { label: "A ChatGPT or Claude export…", hint: "npx worktrust history --export <path>", info: "Asks for its path. Reconstructed hours, never verified.", run: async () => { const path = await typed(term, "The export's path (the zip, its folder or conversations.json):", join(homedir(), "Downloads")); term.enter(); return path ? runShown(term, io, ["history", "--export", path]) : true; } },
    { label: "A copied session folder…", hint: "npx worktrust history --from-folder <dir>", info: "Your copy of a session folder. Reconstructed, not verified.", run: async () => { const path = await chooseFolder(term); term.enter(); return path ? runShown(term, io, ["history", "--from-folder", path]) : true; } },
    BACK,
  ]);
}

export function preserveMenu(term, io, header) {
  return level(term, header, "Preserve evidence", () => [
    { label: "How long each AI app keeps sessions", hint: "npx worktrust preserve", info: "Shows how long each AI app keeps sessions. Changes nothing.", run: () => runShown(term, io, ["preserve"]) },
    { label: "Keep them longer", hint: "npx worktrust preserve --apply", info: "Keeps sessions longer. Asks per change, backs up first.", run: () => runShown(term, io, ["preserve", "--apply"]) },
    { label: "Make a local archive", hint: "npx worktrust preserve --archive", info: "Writes a metadata-only record to ~/AI-Evidence. Not sent.", run: () => runShown(term, io, ["preserve", "--archive"]) },
    { label: "Check the archive", hint: "npx worktrust preserve --verify", info: "Checks that record's hashes and signatures. It only reads.", run: () => runShown(term, io, ["preserve", "--verify"]) },
    { label: "Count hours from the archive", hint: "npx worktrust preserve --summary", info: "Counts hours and tokens from that record. It only reads.", run: () => runShown(term, io, ["preserve", "--summary"]) },
    BACK,
  ]);
}
