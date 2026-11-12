/**
 * THIS COMPUTER'S SETTINGS FROM THE APP OR THE WEB (part B of CLI 0.11.7, owner 2026-11-12; docs/remote-agents/PROTOCOL.md
 * §Managing a computer from the app). A phone or a browser sends ONE change, sealed in `device.configure { settings_change:
 * { change, proof } }`, with a proof the Passport app signed after the person's authenticator answered for that exact change
 * (crypto/admin.ts). This file is the computer's half:
 *
 *   adminRefusal  the gate, in this order: `remote admin on` at the keyboard (off: refused, whatever the proof); the proof
 *                 verified against the issuer keys PINNED in this build, for THIS computer's device id and account, for
 *                 the change as it arrived, unexpired, and its jti never spent here (spent ones are kept in
 *                 admin-proofs.json past their expiry). Every refusal leaves every setting as it was.
 *   resolveAdminChange  the change in the keyboard's own terms, resolved from THIS computer's lists by id: a folder by
 *                 the id of a folder this computer suggested (folderSuggestions, its own HMAC), a new folder by one name
 *                 made in the home folder (makeProjectsFolder), a root by its id, a connection by its device id. No
 *                 path is ever read from the change: there is no field to read one from, and none is looked for.
 *   adminInventory  what the settings page draws, sealed only for a phone that asked `extended`: the admin switch, the
 *                 suggested folders with their project counts, and the connections by name.
 *
 * remote-settings.mjs applySettingsChange calls adminRefusal and resolveAdminChange for a source `{ kind: "admin" }` and
 * then applies the result through the SAME rules as a typed command (checkRoot, MAX_ROOTS, removePhones).
 */
import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { makeProjectsFolder, suggestedFolders } from "./folder-picker.mjs";
import { connections } from "./remote-connections.mjs";
import { checkRoot, rootLabel } from "./remote-projects.mjs";
import * as P from "./remote-protocol.mjs";
import { ensureRemoteDir, loadKeys, loadRoots, readJson, writeJson } from "./remote-store.mjs";

const SPENT_FILE = "admin-proofs.json";
const MAX_SPENT = 500;

/** A stable opaque id for a folder this computer suggests: an HMAC of its path under the computer's own secret. */
export const folderIdOf = (projectSecret, path) =>
  `fld_${P.toBase64Url(createHmac("sha256", Buffer.from(projectSecret)).update(`worktrust-remote/v1/folder\n${path}`).digest().subarray(0, 16))}`;

/** The folders this computer suggests for projects (its own detected ones), each with its id and the root it already is. */
export function folderSuggestions(projectSecret, home = homedir(), roots = loadRoots()) {
  return suggestedFolders(home).slice(0, 12).map((f) => {
    const canonical = checkRoot(f.path);
    const root = canonical.ok ? roots.find((r) => r.path === canonical.path) : null;
    return { folder_id: folderIdOf(projectSecret, f.path), label: rootLabel(f.path), projects: Math.min(2000, f.projects), root_id: root?.root_id ?? null, path: f.path };
  });
}

/** The inventory's part-B fields (sealed for an `extended` phone only, remote-daemon.mjs bodyFor). */
export function adminInventory({ projectSecret, settings }) {
  return {
    admin: settings.admin !== false,
    folders: projectSecret ? folderSuggestions(projectSecret).map(({ path: _path, ...f }) => f) : [],
    connections: connections().slice(0, 40).map((c) => ({ device_id: c.device_id, name: String(c.name).slice(0, 64), kind: c.kind, fingerprint: c.fingerprint, state: c.state, since: c.since ?? null, last_seen: c.last_seen ?? null })),
  };
}

/** One use per proof: a jti is spent here before its change is applied, and kept until its proof has expired. */
export function spendAdminJti(jti, expSeconds, now = Date.now()) {
  const kept = (readJson(SPENT_FILE, { spent: [] })?.spent ?? []).filter((s) => s && typeof s.jti === "string" && Number.isFinite(s.exp) && s.exp * 1000 + P.CLOCK_SKEW_MS >= now);
  if (kept.some((s) => s.jti === jti)) return "seen";
  ensureRemoteDir();
  writeJson(SPENT_FILE, { spent: [...kept, { jti, exp: expSeconds }].slice(-MAX_SPENT) });
  return "fresh";
}

const CODE_OF = { expired: "expired", lifetime: "expired", not_yet_valid: "expired", replay: "conflict" };
const SAID = { expired: "the approval expired (five minutes): change it again", conflict: "that approval was used already", not_allowed: "the approval does not hold for this computer and this change" };

/**
 * THE GATE. `source`: { kind: "admin", proof, issuerKeys, claims, now } where issuerKeys are the daemon's pinned keys and
 * claims this computer's own verified binding. → null when the change may be applied, else { reason, code } (the code is
 * the protocol's reject reason: not_allowed, expired, conflict).
 */
export function adminRefusal(change, source, settings) {
  if (settings.admin === false) return { code: "not_allowed", reason: "managing this computer from the app or the web is off here (npx worktrust remote admin on)" };
  const shaped = P.validate(P.ADMIN_CHANGE_SPEC, change);
  if (!shaped.ok || P.adminChangeRule(change)) return { code: "not_allowed", reason: "not a change this computer takes from the app" };
  if (typeof source?.proof !== "string" || !source.claims || !source.issuerKeys) return { code: "not_allowed", reason: SAID.not_allowed };
  const verified = P.verifyAdminProof(source.proof, { issuerKeys: source.issuerKeys, now: source.now ?? Date.now(), deviceId: source.claims.device_id, sub: source.claims.sub, change, spendJti: (jti, exp) => spendAdminJti(jti, exp, source.now ?? Date.now()) });
  if (!verified.ok) { const code = CODE_OF[verified.code] ?? "not_allowed"; return { code, reason: SAID[code] }; }
  return null;
}

/**
 * The change in the keyboard's terms, resolved from this computer's own lists by id; → { ok: true, change, setting } or
 * { ok: false, code: "not_found" | "unsupported", reason }.
 */
export function resolveAdminChange(change, projectSecret = loadKeys()?.projectSecret) {
  const missing = (reason) => ({ ok: false, code: "not_found", reason });
  const setting = P.settingOf(change);
  if (change.what === "modes") return { ok: true, setting, change: { what: "modes", [change.allowed ? "allow" : "deny"]: change.mode } };
  if (change.what === "folder") {
    const found = projectSecret ? folderSuggestions(projectSecret).find((f) => f.folder_id === change.folder_id) : null;
    return found ? { ok: true, setting, change: { what: "roots", add: found.path, git_init: false } } : missing("that folder is not one this computer suggests any more");
  }
  if (change.what === "new_folder") {
    if (!P.adminFolderNameOk(change.name)) return { ok: false, code: "unsupported", reason: "one folder name" };
    const made = makeProjectsFolder(change.name);
    return made.ok ? { ok: true, setting, change: { what: "roots", add: made.path, git_init: true } } : { ok: false, code: "unsupported", reason: made.reason };
  }
  if (change.what === "root") {
    const root = loadRoots().find((r) => r.root_id === change.root_id);
    if (!root) return missing("no root by that id here");
    if (change.act === "remove") return { ok: true, setting, change: { what: "roots", remove: root.root_id } };
    return { ok: true, setting, change: { what: "roots", add: root.path, git_init: change.act === "git_init_on" } };
  }
  const link = connections().find((c) => c.device_id === change.device_id);
  return link ? { ok: true, setting, change: { what: "connections", remove: link.fingerprint } } : missing("no phone or browser by that id is linked here");
}

/** The words the run terminal shows for a change from the app (remote-run.mjs notice). */
export const SETTING_WORDS = Object.freeze({ modes: "This computer's allowed modes", folders: "This computer's folders", roots: "This computer's roots", connections: "This computer's connections" });
