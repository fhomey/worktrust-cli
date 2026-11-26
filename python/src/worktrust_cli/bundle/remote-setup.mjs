/**
 * THE LINKING FLOW'S KEYBOARD STEPS, MIRRORED ON THE PHONE THAT JUST LINKED (CLI 0.11.26; owner, build 37 screenshot 65;
 * CLI-LINK-STEPS.md item D; protocol setup-steps.ts, check-remote-protocol rule S). After "✓ Phone linked" the CLI still asks
 * at this keyboard: what the phone may reach, the macOS folder permission per guarded folder, may phones add a browser, the
 * agent modes, the default folder (and its own folder permission). The phone showed "done" meanwhile. Before them, read along,
 * steering, voice and reading answers aloud are turned on without a question (owner, 2026-11-25; remote-read-along.mjs): four informational steps,
 * done or skipped with why.
 *
 *   the CLI    `createSetup` (remote-cli.mjs linkAndGrant, only with a person at a terminal) writes where it stands to
 *              remote-setup.json (0600): each question by its id in the CLI's order, a folder question by the folder's
 *              generic NAME (never a path), its state and, when skipped, why in one word. Ended at the end of the flow, and
 *              at the process's exit: every step still open becomes skipped, later.
 *   the daemon `keptSetup` reads it for device.inventory `setup`; remote-peers.mjs seals it ONLY in the inventory of the
 *              phone it names, and only when that phone asked `setup`. Dropped ten minutes after it ended, half an hour after
 *              it was last written when it never ended (a flow killed hard), and when that phone is no longer linked.
 * MIRROR ONLY: no command answers a step; settings stay at the keyboard (rule S holds no text, path or answer in it).
 */
import * as P from "./remote-protocol.mjs";
import { defaultRootOf, loadDefaultRoot, loadPhones, readJson, removeFile, writeJson } from "./remote-store.mjs";

export const SETUP_FILE = "remote-setup.json", ENDED_KEEP_MS = 10 * 60_000, STALE_MS = 30 * 60_000;
/** folder-picker.mjs protectedFolder's names → the protocol's folder ids. */
export const FOLDER_IDS = Object.freeze({ Desktop: "desktop", Documents: "documents", Downloads: "downloads", "iCloud Drive": "icloud" });
const open = (s) => s.state === "pending" || s.state === "asked";
const clean = (s) => ({ id: s.id, ...(s.folder ? { folder: s.folder } : {}), state: s.state, ...(s.state === "skipped" ? { why: s.why } : {}) });

/** `steps`: the questions this flow will ask, in the CLI's order. → { asked, done, skipped, folders(names), end, body() } */
export function createSetup({ phone, steps, now = Date.now, write = (body) => writeJson(SETUP_FILE, body), onExit = (fn) => { process.on("exit", fn); return () => process.off("exit", fn); } }) {
  const list = steps.map((id) => ({ id, state: "pending" }));
  let ended = false;
  const body = () => ({ v: 1, phone, steps: list.map(clean), ended, at: now() });
  const save = () => { const b = body(); if (P.setupRule(b) === null && P.validate(P.SETUP_SPEC, (({ v: _v, ...x }) => x)(b)).ok) { try { write(b); } catch { /* unsaid: the phone keeps its own line */ } } };
  const find = (id, folder = null) => list.find((s) => s.id === id && (s.folder ?? null) === folder && open(s)) ?? null;
  const settle = (s, state, why = null) => { if (!s || ended) return; s.state = state; if (why) s.why = why; else delete s.why; save(); };
  const off = onExit(() => end());
  /** A folder question the moment a guarded folder was added; placed right after the step that asked last. */
  function folder(name) {
    const id = FOLDER_IDS[name];
    // Once per folder per question (two roots in Desktop: one dialog); the default folder's own question may ask it again.
    const last = list.reduce((n, s, i) => (s.id !== "folder_access" && s.state !== "pending" ? i : n), -1);
    if (!id || ended || list.slice(last + 1).some((s) => s.id === "folder_access" && s.folder === id) || list.length >= P.MAX_SETUP_STEPS) return null;
    const next = list.findIndex((s) => s.state === "pending" && s.id !== "folder_access"); // before the next question, after the folders already added
    list.splice(next < 0 ? list.length : next, 0, { id: "folder_access", folder: id, state: "pending" });
    save();
    return id;
  }
  function end() { if (ended) return; for (const s of list) if (open(s)) { s.state = "skipped"; s.why = "later"; } ended = true; off(); save(); }
  return {
    /** On the keyboard's screen now; one at a time (a step left asked is taken as answered). */
    asked(id, folder = null) { if (ended) return; for (const s of list) if (s.state === "asked") s.state = "done"; const s = find(id, folder); if (s) settle(s, "asked"); },
    done: (id, folder = null) => settle(find(id, folder), "done"),
    skipped: (id, why, folder = null) => settle(find(id, folder), "skipped", P.SETUP_WHY.includes(why) ? why : "later"),
    folders: (names) => names.map(folder).filter(Boolean), end, body,
  };
}

/** The setup to send, or null; an expired one, or one whose phone is no longer linked, is removed. */
export function keptSetup({ now = Date.now(), phones = () => loadPhones() } = {}) {
  let s;
  try { s = readJson(SETUP_FILE); } catch { return null; }
  if (!s) return null;
  const linked = (() => { try { const p = phones(); return [...p.confirmed, ...p.pending].some((x) => x.device_id === s.phone); } catch { return false; } })();
  const { v: _v, ...setup } = s;
  if (!linked || !P.validate(P.SETUP_SPEC, setup).ok || P.setupRule(setup) !== null || now - s.at > (s.ended ? ENDED_KEEP_MS : STALE_MS)) { try { removeFile(SETUP_FILE); } catch { /* next look */ } return null; }
  return setup;
}
/** What the daemon's tick compares to send the inventory again (remote-run.mjs). */
export const setupStamp = () => { try { return readJson(SETUP_FILE)?.at ?? 0; } catch { return 0; } };

/** The questions linkAndGrant will ask, for a person at a terminal; null when nobody is asked (the phone keeps its own line). */
export function plannedSteps({ person, defaultRoot }) {
  return person ? ["read_along", "desk_steering", "voice", "voice_read", "reach", "endorse", "modes", ...(defaultRoot ? ["default_root"] : [])] : null;
}

/**
 * linkAndGrant's setup (remote-cli.mjs): the questions it will ask this person, with every one pending; null when nobody is
 * asked (no terminal at both ends, --yes, an agent's shell), so no `setup` is ever sent and the phone keeps its own line.
 * `tty` is the tests' seam.
 */
export function linkSetup(io, phone, { tty = Boolean(process.stdin.isTTY && process.stdout.isTTY), ...options } = {}) {
  let defaultRoot = false;
  try { defaultRoot = defaultRootOf() === null && loadDefaultRoot().answer === null; } catch { /* asked as before; the phone mirrors what it can */ }
  const steps = plannedSteps({ person: tty && !io.has?.("yes") && io.agentShell !== true, defaultRoot });
  return steps ? createSetup({ phone, steps, ...options }) : null;
}
