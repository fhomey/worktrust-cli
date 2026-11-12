/**
 * WHAT A PHONE MAY DO ON THIS COMPUTER, CHANGED IN ONE PLACE (CLI 0.11.7, owner 2026-11-12). Every change to the remote
 * settings that widens or narrows a phone's reach (the ceiling of agent modes, the roots, the granted projects, the admin
 * switch) goes through applySettingsChange(change, source). Today the only source is THIS KEYBOARD (`{ kind: "keyboard" }`,
 * a `remote …` command or the menu, both refused in an AI agent's shell by worktrust.mjs). Part B adds a second source, a
 * change the person approved in the WorkTrust app or on the web and the server signed (`{ kind: "admin", proof }`); it will
 * be honoured only while `remote admin on` (the default) and only once its proof verifies here. Until part B ships, an
 * admin change is refused: nothing but this keyboard changes these settings (docs/remote-agents/PROTOCOL.md "Agent modes").
 *
 * PART B (owner, 2026-11-12): the second source is here. A change from the app or the web arrives as `{ kind: "admin",
 * proof, issuerKeys, claims, now }` (remote-daemon.mjs, from a sealed device.configure): remote-admin.mjs adminRefusal
 * checks `remote admin on` and the issuer-signed proof (this computer, this account, this change, five minutes, one use),
 * resolveAdminChange names its folder, root or connection from this computer's own lists by id, and the result goes
 * through the same rules below as a typed command. The admin switch itself never changes from the app.
 *
 * THE CEILING OF AGENT MODES (protocol adapters.ts AGENT_MODES). Manual and plan are always allowed (today's behaviour);
 * `allow edit` lets a phone start a session that edits files inside its projects without asking; `allow auto` lets it start
 * the agent's own automatic mode, and, being above edit, allows edit too. `deny edit` takes both away again. The ceiling is
 * read by the daemon on every start (checkAgentOptions), never taken from a phone.
 */
import { readdirSync } from "node:fs";
import { adminRefusal, resolveAdminChange } from "./remote-admin.mjs";
import { removePhones } from "./remote-connections.mjs";
import { protectedFolder } from "./folder-picker.mjs";
import { canonicalProject } from "./remote-policy.mjs";
import { probeFolders } from "./remote-service.mjs";
import { checkRoot, MAX_ROOTS, rootIdOf } from "./remote-projects.mjs";
import { agentOptionsOf } from "./remote-inventory.mjs";
import * as P from "./remote-protocol.mjs";
import { ensureRemoteDir, loadKeys, loadProjects, loadRoots, loadSettings, projectIdOf, saveProjects, saveRoots, saveSettings, writeJson } from "./remote-store.mjs";

export const RAISABLE_MODES = Object.freeze(["edit", "auto"]);
const ORDER = ["manual", "edit", "plan", "auto"];

/** The modes this computer allows: manual and plan always, edit and auto when the person allowed them (auto brings edit). */
export function allowedModes(settings = loadSettings()) {
  const set = new Set(["manual", "plan"]);
  const asked = Array.isArray(settings.modes_allowed) ? settings.modes_allowed : [];
  if (asked.includes("auto")) { set.add("auto"); set.add("edit"); }
  if (asked.includes("edit")) set.add("edit");
  return ORDER.filter((m) => set.has(m));
}

const refused = (reason) => ({ ok: false, reason });

/**
 * A START'S 0.11.7 OPTIONS, decided here (remote-sessions.mjs calls it before anything is set up): the adapter's options as
 * this computer reads them from its own agent, the ceiling from the settings file, and the extra projects from the
 * computer's own list by id. → a reject reason, or { agentMode, effort, extraProjectIds, extras: [{ project_id, path }] }.
 */
export function startChoice(payload, projectId, inventory, settings, known) {
  const options = agentOptionsOf(inventory).find((o) => o.adapter === payload.adapter && o.mode === (payload.mode ?? "structured")) ?? null;
  const choice = P.checkAgentOptions(payload, projectId, options, allowedModes(settings), new Set(known.map((p) => p.project_id)));
  if (typeof choice === "string") return choice;
  return { ...choice, extras: choice.extraProjectIds.map((id) => known.find((p) => p.project_id === id)) };
}

/**
 * The one door for a settings change. `change`: { what: "modes", allow|deny: "edit"|"auto" } | { what: "roots", add: dir,
 * git_init } | { what: "roots", remove: id|dir } | { what: "projects", add: dir } | { what: "projects", remove: id|dir } |
 * { what: "admin", on: boolean } | { what: "connections", remove: fingerprint } (resolved from the app's change only).
 * `source`: { kind: "keyboard" }, or { kind: "admin", proof, issuerKeys, claims, now, via } (part B; its change is
 * crypto/admin.ts's ADMIN_CHANGE_SPEC, resolved by id before it reaches the rules below).
 * → { ok: true, message, paths?, setting? } or { ok: false, reason, code? } (code: the protocol's reject reason).
 */
export function applySettingsChange(change, source) {
  if (source?.kind === "admin") {
    // From the app or the web: `remote admin on`, then the issuer-signed proof, then this computer's own lists by id.
    const gate = adminRefusal(change, source, loadSettings());
    if (gate) return { ok: false, reason: gate.reason, code: gate.code };
    const resolved = resolveAdminChange(change);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, code: resolved.code };
    const done = applyRules(resolved.change, true);
    return done.ok ? { ...done, setting: resolved.setting } : { ...done, code: done.code ?? "unsupported" };
  }
  if (source?.kind !== "keyboard") return refused("this computer's remote settings are changed at its keyboard");
  return applyRules(change, false);
}

/** The rules every change meets, typed here or resolved from the app (`fromApp`): the same checks, the same files. */
function applyRules(change, fromApp) {
  const settings = loadSettings();
  if (change?.what === "modes") {
    const mode = change.allow ?? change.deny;
    if (!RAISABLE_MODES.includes(mode)) return refused("name edit or auto (manual and plan are always allowed)");
    const now = new Set(allowedModes(settings));
    if (change.allow) { now.add(mode); if (mode === "auto") now.add("edit"); }
    else { now.delete(mode); if (mode === "edit") now.delete("auto"); }
    saveSettings({ ...settings, modes_allowed: ORDER.filter((m) => now.has(m)) });
    return { ok: true, message: `Allowed modes: ${allowedModes(loadSettings()).join(", ")}` };
  }
  if (change?.what === "connections" && fromApp) {
    // From the app only (the keyboard's own `remote disconnect` asks twice and calls removePhones itself).
    const n = removePhones([String(change.remove ?? "")]);
    return n > 0 ? { ok: true, message: "Disconnected: it can no longer steer this computer." } : { ...refused("no phone or browser by that fingerprint"), code: "not_found" };
  }
  if (change?.what === "admin") {
    if (fromApp) return refused("the admin switch changes at this keyboard only");
    if (typeof change.on !== "boolean") return refused("on or off");
    saveSettings({ ...settings, admin: change.on });
    return { ok: true, message: change.on ? "Managing this computer from the app or the web: on. Each change there asks your authenticator, and this computer checks WorkTrust's signature on it." : "Managing this computer from the app or the web: off. Only this keyboard changes its remote settings." };
  }
  const keys = loadKeys();
  if (change?.what === "roots") {
    const list = loadRoots();
    if (change.add !== undefined) {
      if (!keys) return refused("this computer is not paired for remote yet: run `npx worktrust remote app`");
      const root = checkRoot(change.add ?? "");
      if (!root.ok) return refused(`not added: ${root.reason}`);
      if (list.length >= MAX_ROOTS && !list.some((r) => r.path === root.path)) return refused(`at most ${MAX_ROOTS} roots`);
      const root_id = rootIdOf(keys.projectSecret, root.path);
      saveRoots([...list.filter((r) => r.root_id !== root_id), { root_id, path: root.path, git_init: change.git_init === true, added_at: Date.now() }]);
      return { ok: true, paths: [root.path], message: `Root: ${root.path}. A phone may open the projects already in it and create one new, empty folder in it per request${change.git_init === true ? ", with git init" : ""}.` };
    }
    const key = String(change.remove ?? "");
    const kept = list.filter((r) => r.root_id !== key && r.path !== key && r.path !== checkRoot(key).path);
    if (kept.length === list.length) return refused("no root by that path or id");
    saveRoots(kept);
    return { ok: true, message: "Removed. Projects made in it stay granted: npx worktrust remote projects remove <folder>." };
  }
  if (change?.what === "projects") {
    const list = loadProjects();
    if (change.add !== undefined) {
      if (!keys) return refused("this computer is not paired for remote yet: run `npx worktrust remote app`");
      const canonical = canonicalProject(change.add ?? "");
      if (!canonical.ok) return refused(`not granted: ${canonical.reason}`);
      const project_id = projectIdOf(keys.projectSecret, canonical.path);
      if (!list.some((p) => p.project_id === project_id)) saveProjects([...list, { project_id, path: canonical.path, added_at: Date.now() }]);
      return { ok: true, paths: [canonical.path], message: `Granted: ${canonical.path}` };
    }
    const key = String(change.remove ?? "");
    const canonical = canonicalProject(key);
    const kept = list.filter((p) => p.project_id !== key && p.path !== key && !(canonical.ok && p.path === canonical.path));
    if (kept.length === list.length) return refused("no granted folder by that path or id");
    saveProjects(kept);
    return { ok: true, message: "Removed." };
  }
  return refused("not a setting this computer knows");
}

/** `remote modes allow|deny edit|auto | status`. */
export function modesCommand(io, rest) {
  if (rest[0] === "allow" || rest[0] === "deny") {
    const done = applySettingsChange({ what: "modes", [rest[0]]: rest[1] }, { kind: "keyboard" });
    if (!done.ok) io.fail(`npx worktrust remote modes allow|deny edit|auto: ${done.reason}`);
    io.say(`  ✓ ${done.message}`);
    if (rest[0] === "allow") io.say("    A phone may now start sessions in it; the deny rules (no push, no install, no deploy, no secret) hold in every mode.");
    return;
  }
  if (rest[0] !== undefined && rest[0] !== "status") io.fail("npx worktrust remote modes allow|deny edit|auto | status");
  const allowed = allowedModes();
  const WORDS = { manual: "Manual (asks for every change)", edit: "Edit automatically (edits inside the project without asking)", plan: "Plan (read-only)", auto: "Auto (the agent's own automatic mode)" };
  io.say("  Agent modes a phone may start on this computer:");
  for (const m of ORDER) io.say(`    ${allowed.includes(m) ? "✓" : "·"} ${WORDS[m]}${allowed.includes(m) || m === "manual" || m === "plan" ? "" : `   allow: npx worktrust remote modes allow ${m}`}`);
}

/** `remote admin on|off | status`: whether a change approved in the app or on the web (with the authenticator) is honoured here. */
export function adminCommand(io, rest) {
  if (rest[0] === "on" || rest[0] === "off") {
    const done = applySettingsChange({ what: "admin", on: rest[0] === "on" }, { kind: "keyboard" });
    io.say(`  ✓ ${done.message}`);
    return;
  }
  io.say(`  Managing this computer from the app or the web: ${loadSettings().admin === false ? "off" : "on"} (npx worktrust remote admin on|off; each change there asks your authenticator)`);
}

/**
 * `remote folder-check` (internal; run by probeFolders as the service's own program): can each root and project in a folder
 * macOS guards be listed? Writes { at, folders: [{ path, folder, ok }] } to folder-check.json and nothing else.
 */
export function folderCheck() {
  const folders = [...loadRoots(), ...loadProjects()].map((x) => x.path).filter((path, i, all) => all.indexOf(path) === i && protectedFolder(path))
    .map((path) => { try { readdirSync(path); return { path, folder: protectedFolder(path), ok: true }; } catch { return { path, folder: protectedFolder(path), ok: false }; } });
  ensureRemoteDir();
  writeJson("folder-check.json", { at: Date.now(), folders });
}

/** After a folder was added at the keyboard: when macOS guards it, ask at once, from the program that will run the agents. */
export async function askMacFolderAccess(io, paths) {
  const guarded = [...new Set((paths ?? []).map((p) => protectedFolder(p)).filter(Boolean))];
  if (guarded.length === 0) return null;
  io.say(`  macOS guards your ${guarded.join(" and ")} folder. It now asks once whether the program that runs your agents (shown as "node" or "python") may read it.`);
  io.say("  Click OK (Allow). Without it, a session there stops at a prompt nobody sees, or fails with \"Operation not permitted\".");
  const runtime = await io.prepare();
  const result = await probeFolders({ program: [runtime.node, ...runtime.nodeArgs, runtime.entry, "remote", "folder-check"], path: loadSettings().agent_path ?? process.env.PATH ?? "" });
  const refusedHere = (result?.folders ?? []).filter((f) => !f.ok);
  if (result && refusedHere.length === 0) { io.say("  ✓ macOS lets the Remote Agent service read it."); return true; }
  io.say(`  ! ${result ? `macOS refused: ${refusedHere.map((f) => f.path).join(", ")}` : "No answer from macOS in time"}. To allow it later: System Settings › Privacy & Security › Files and Folders,`);
  io.say(`    then turn on ${guarded.join(" and ")} for "node" (or "python"); or add that program under Full Disk Access.`);
  return false;
}
