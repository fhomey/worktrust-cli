/**
 * WHAT IS LINKED TO THIS COMPUTER, AND CLOSING IT (CLI 0.11.7, owner 2026-11-12). `remote connections` lists every phone and
 * browser linked to this computer (name, kind, fingerprint, since, last seen) and this computer's own link; `remote
 * disconnect <number | name | fingerprint>` closes one after TWO confirmations (y, then its short fingerprint or its name
 * typed), and `remote disconnect --all` closes every one after `close all` typed exactly. Both are the same removal as
 * `remote phones remove` (kept, and folded onto removePhones here): the phone leaves the confirmed and pending lists for
 * `removed`, which the daemon reads per message, so it can no longer steer this computer. Its key for the whole account
 * is ended in WorkTrust (Settings › Remote Agent), as before. No prompt without a terminal: the command refuses instead.
 *
 * The computer knows a phone by its keys only: the "name" is its kind and the start of its fingerprint ("Phone 9M8N"),
 * never a model name it was not told.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { gatewayOf, loadIdentity, loadKeys, loadPhones, loadProjects, loadRoots, loadSettings, random, removeFile, savePhones, writeJson } from "./remote-store.mjs";
import * as P from "./remote-protocol.mjs";
import { terminalQr } from "./remote-qr.mjs";
import { pairingQrText, seededInvite } from "./remote-pairing.mjs";
import { watchKeys } from "./cli-stop.mjs";
import { startCountdown } from "./remote-countdown.mjs";
import { suggestedFolders } from "./folder-picker.mjs";

const KEEP_REMOVED = 20;
const when = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "never");
export const shortPrint = (fingerprint) => String(fingerprint ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase();

/** A line typed at this keyboard (the typed confirmations below). */
export async function askLine(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} `);
  prompt.close();
  return answer;
}

/** Every phone and browser, numbered from 1: confirmed first, then pending. */
export function connections(phones = loadPhones()) {
  const row = (p, state) => {
    const kind = p.how === "endorsed" ? "browser" : p.kind === "browser" ? "browser" : "phone";
    return { device_id: p.device_id, fingerprint: p.fingerprint, kind, state, name: p.name ?? `${kind === "browser" ? "Browser" : "Phone"} ${shortPrint(p.fingerprint)}`, since: p.confirmed_at ?? p.seen_at ?? null, last_seen: p.seen_at ?? null };
  };
  return [...phones.confirmed.map((p) => row(p, "confirmed")), ...phones.pending.map((p) => row(p, "pending"))].map((c, i) => ({ n: i + 1, ...c }));
}

/** One connection by its number in the list, its name, its fingerprint (whole, or its first four) or its device id. */
export function findConnection(list, key) {
  const k = String(key ?? "").trim();
  if (!k) return null;
  if (/^\d{1,3}$/.test(k)) return list.find((c) => c.n === Number(k)) ?? null;
  const upper = k.toUpperCase();
  return list.find((c) => c.device_id === k || c.fingerprint.toUpperCase() === upper || c.name.toLowerCase() === k.toLowerCase())
    ?? (shortPrint(k).length === 4 ? list.filter((c) => shortPrint(c.fingerprint) === shortPrint(k)).at(0) ?? null : null);
}

/** Take phones off this computer, the one removal `remote phones remove` and `remote disconnect` share. */
export function removePhones(fingerprints, at = Date.now()) {
  const phones = loadPhones(), gone = new Set(fingerprints);
  const out = [...phones.confirmed, ...phones.pending].filter((p) => gone.has(p.fingerprint));
  savePhones({ ...phones, pending: phones.pending.filter((p) => !gone.has(p.fingerprint)), confirmed: phones.confirmed.filter((p) => !gone.has(p.fingerprint)),
    removed: [...phones.removed.filter((p) => !out.some((x) => x.device_id === p.device_id)), ...out.map((p) => ({ device_id: p.device_id, fingerprint: p.fingerprint, how: "keyboard", removed_at: at }))].slice(-KEEP_REMOVED) });
  return out.length;
}

/** `remote connections`. */
export function connectionsCommand(io) {
  const identity = loadIdentity(), keys = identity ? loadKeys() : null;
  io.say(identity ? `  This computer: ${identity.device_id} · key ${P.deviceFingerprint(keys.public)} · linked ${when(identity.paired_at)}` : "  This computer: not linked to Remote Agent (npx worktrust remote app)");
  const list = connections();
  io.say(`  Linked to it (${list.length}):`);
  for (const c of list) io.say(`    ${String(c.n).padStart(2)}  ${c.name.padEnd(16)} ${c.kind.padEnd(8)} ${c.fingerprint}  since ${when(c.since)} · last seen ${when(c.last_seen)}${c.state === "pending" ? "  (pending: npx worktrust remote phones confirm " + c.fingerprint + ")" : ""}`);
  if (list.length) io.say("  Close one: npx worktrust remote disconnect <number|name|fingerprint>   all: npx worktrust remote disconnect --all");
}

/**
 * `remote disconnect <key> | --all`. `ask(question)` → the typed answer (a terminal's line); tests pass their own. Without a
 * terminal it refuses: closing a link is confirmed by a person at this keyboard.
 */
export async function disconnectCommand(io, rest, ask, tty = Boolean(process.stdin.isTTY)) {
  const list = connections();
  const all = rest[0] === "--all" || io.has("all");
  if (!tty) return io.fail("closing a connection is confirmed at this keyboard: run it in a terminal");
  if (list.length === 0) return io.say("  No phone or browser is linked to this computer.");
  if (all) {
    io.say(`  This closes every connection to this computer (${list.length}):`);
    for (const c of list) io.say(`    ${c.name} (${c.kind}, ${c.fingerprint})`);
    if ((await ask("  Type close all to confirm:")).trim() !== "close all") return io.say("  Cancelled. Nothing was closed.");
    const n = removePhones(list.map((c) => c.fingerprint));
    io.say(`  ✓ Closed ${n}: none of them can steer this computer any more. End their keys for your whole account too: app.worktrust.io › Settings › Remote Agent.`);
    return;
  }
  const c = findConnection(list, rest[0]);
  if (!c) return io.fail("no connection by that number, name or fingerprint (npx worktrust remote connections lists them)");
  if (!/^y(es)?$/i.test((await ask(`  Disconnect ${c.name} (${c.fingerprint})? It can no longer steer this computer. [y/N]`)).trim())) return io.say("  Cancelled. Nothing was closed.");
  const typed = (await ask(`  To confirm, type ${shortPrint(c.fingerprint)} (the start of its fingerprint) or its name:`)).trim();
  if (typed.toUpperCase() !== shortPrint(c.fingerprint) && typed.toLowerCase() !== c.name.toLowerCase()) return io.say("  That does not match. Cancelled. Nothing was closed.");
  removePhones([c.fingerprint]);
  io.say(`  ✓ Disconnected ${c.name}: it can no longer steer this computer. End its key for your whole account too: app.worktrust.io › Settings › Remote Agent.`);
}

/** How long `remote app` waits for the phone that scanned its one QR before it shows the pairing QR (0.11.10). */
export const ONE_SCAN_WAIT_MS = 30_000;
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * LINK A PHONE (`remote pair`, and the end of `remote app`; moved here from remote-cli.mjs in 0.11.10). Without `ready`: a new
 * invite (ten minutes, one phone, once), its QR and the typed code, as before. With `ready` (the one-scan invite `remote app`
 * wrote once the issuer named this computer, remote-pairing.mjs `oneScanInvite`): no second QR while the phone that scanned
 * the first one links by itself; after `waitMs`, or for a phone that opened the code with the camera or runs an older app,
 * the SAME invite as the pairing QR, with one line why. A phone that proves the secret is confirmed by the daemon
 * (PROTOCOL.md §Pairing); a phone that asked by the typed code waits for `remote phones confirm` at this keyboard.
 *
 * 0.11.12 (owner, 2026-11-15): the QR is the compact code for WorkTrust's relay (remote-pairing.mjs pairingQrText), with an
 * empty line above and below it; ten minutes instead of five, drained by the countdown under it (remote-countdown.mjs: one
 * line rewritten in place on a terminal, the expiry said once without one; no colour). The printed link carried the pairing
 * secret into the scrollback; it is printed only with --show-link (`showLink`), as `remote app` does since 0.11.10.
 * → the phone the daemon confirmed by the QR, or null.
 */
export async function linkPhone(io, ready = null, { waitMs = ONE_SCAN_WAIT_MS, now = Date.now, tick = 1000, countdown = startCountdown, showLink = Boolean(io.has?.("show-link")) } = {}) {
  const keys = loadKeys(), identity = loadIdentity(), settings = loadSettings();
  if (!keys || !identity) io.fail("this computer is not paired for remote yet: run `npx worktrust remote app` (or `remote web`)");
  // Off is its own state (owner, 2026-11-14): a missing gateway no longer exists, WorkTrust's is the default (gatewayOf).
  if (!settings.enabled) io.fail("remote is off on this computer: run `npx worktrust remote app` (or `remote web`)");
  const started = now();
  const invite = ready ?? { ...seededInvite({ gateway: gatewayOf(settings), deviceId: identity.device_id, publicKeys: keys.public, nowMs: started, random }), code: P.generatePairingCode(random), used: false, created_at: started };
  if (!ready) writeJson("invite.json", invite);
  const { code, created_at: since } = invite;
  const until = invite.e * 1000;
  let shown = false, bar = null;
  const settle = (line) => { bar?.stop(line); bar = null; };
  const show = (why) => {
    shown = true;
    io.say();
    io.say(why ?? "  Scan this with the WorkTrust app (or the phone's camera):");
    io.say();
    io.say(terminalQr(pairingQrText(invite), { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }));
    io.say();
    if (showLink) io.say(`  Link: ${pairingQrText(invite)}`);
    io.say(`  No camera? Type this code in the app: ${pretty(code)} (then confirm the phone here with \`npx worktrust remote phones\`)`);
    io.say("  The code and the QR work once, for ten minutes. Ctrl+C cancels.");
    bar = countdown?.({ expiresAt: until, windowMs: Math.max(1, until - since) }) ?? null;
  };
  if (ready) io.say("  Linking the phone that scanned the code …"); else show();
  const cancel = () => { settle(); removeFile("invite.json"); process.exit(130); };
  process.once("SIGINT", cancel);
  const before = new Set(loadPhones().pending.map((p) => p.fingerprint));
  const release = watchKeys(); // 0.11.12: in a command the menu started, Esc cancels the wait like Ctrl+C (cli-stop.mjs)
  try {
    while (now() < until) {
      await new Promise((resolve) => setTimeout(resolve, tick));
      const phones = loadPhones();
      const paired = phones.confirmed.find((p) => p.how === "qr" && p.confirmed_at >= since);
      if (paired) { settle(); return paired; }
      const asked = phones.pending.find((p) => !before.has(p.fingerprint));
      if (asked) { settle(); io.say(`  A phone asked by code (${asked.fingerprint}). Confirm it at this keyboard: npx worktrust remote phones confirm ${asked.fingerprint}`); return null; }
      if (!shown && now() - started >= waitMs) show("  No phone linked by itself (the code was opened with the camera, or the app is older): scan this in the WorkTrust app.");
    }
  } finally { settle(); process.off("SIGINT", cancel); release(); }
  removeFile("invite.json");
  io.say("  The pairing code expired. Run `npx worktrust remote pair` for a new one.");
  return null;
}

/**
 * WHEN A PHONE HAS LINKED (CLI 0.11.12, owner 2026-11-15: "when the phone has linked, the CLI says so at once"). The wait
 * for the scan (linkPhone above) ends with a summary of the phone the daemon just confirmed, and goes
 * straight on to what that phone may reach on this computer:
 *
 *   ✓ Phone linked
 *     Device id   dev_… · ABCD-EFGH-JKMN-PQRS
 *     Type        iPhone
 *
 * The type is the phone's own name for its kind ("iPhone", "iPad", "Pixel 9", "Browser on macOS"), sent sealed with its first
 * inventory ask (remote-daemon.mjs rememberName); it is waited for a few seconds, and said as "phone" when it did not come.
 * The computer never guesses a model it was not told.
 *
 * THE ACCESS STEP USES THE GRANTS THAT EXIST, nothing new: this computer's ROOTS (folders whose projects a phone may open and
 * add to) and PROJECTS (single folders), the same lists Remote Agent › Roots and › Projects change, through the same door
 * (remote-settings.mjs applySettingsChange, handed in as `apply`, which also asks macOS for a guarded folder). Grants belong
 * to this computer, not to one phone, as they always did; the step ends in exactly the state the menu leaves.
 *   Allow all project folders  every suggested folder that exists here (~/Desktop, ~/Projects, ~/code …) as a root. "All
 *                              files" is not offered: the root rule refuses the home folder and anything above it, and
 *                              folders of secrets, by design (remote-policy.mjs canonicalProject).
 *   Choose projects            a multi-select of the git projects this computer already knows (directly inside a suggested
 *                              folder or a root, newest first), each granted as a project.
 *   Later                      nothing changes; the commands are named.
 * Without a terminal, or with --yes, nothing is asked: the commands are named.
 */
/** How long the summary waits for the phone's own name (its first inventory ask follows the welcome at once). */
export const NAME_WAIT_MS = 4_000;
/** At most this many projects are offered (the inventory's own limit). */
export const MAX_OFFERED = 30;
const tildePath = (path) => (path === homedir() || path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path);

/** The phone's type in words: its own name when it sent one, else its kind. */
export const phoneType = (phone) => (typeof phone?.name === "string" && phone.name.trim() ? phone.name.trim().slice(0, 64) : phone?.how === "endorsed" || phone?.kind === "browser" ? "browser" : "phone");

/** The summary's lines. Pure. */
export function linkedSummary(phone) {
  return ["  ✓ Phone linked", `    Device id   ${phone.device_id} · ${phone.fingerprint}`, `    Type        ${phoneType(phone)}`];
}

/** The phone's record again once it carries its name, or as it is after `waitMs`. */
export async function withName(phone, { waitMs = NAME_WAIT_MS, tick = 250, now = Date.now } = {}) {
  const until = now() + waitMs;
  for (;;) {
    const found = loadPhones().confirmed.find((p) => p.device_id === phone.device_id) ?? phone;
    if (found.name || now() >= until) return found;
    await new Promise((resolve) => setTimeout(resolve, tick));
  }
}

/** The git projects directly inside the suggested folders and the roots, not granted yet, newest first. */
export function knownProjects({ home = homedir(), roots = loadRoots(), granted = loadProjects() } = {}) {
  const have = new Set(granted.map((p) => p.path)), seen = new Set(), out = [];
  for (const dir of [...suggestedFolders(home).map((f) => f.path), ...roots.map((r) => r.path)]) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).slice(0, 2000); } catch { continue; }
    for (const d of entries) {
      if (d.name.startsWith(".") || !d.isDirectory()) continue;
      const path = join(dir, d.name);
      if (seen.has(path) || have.has(path)) continue;
      try { statSync(join(path, ".git")); } catch { continue; }
      seen.add(path);
      let at = 0;
      try { at = statSync(path).mtimeMs; } catch { /* unread: last */ }
      out.push({ path, at });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_OFFERED).map((p) => p.path);
}

/** The step's three rows (pure, for the menu's own list, cli-menu.mjs choose). */
export function accessItems(folders) {
  return [
    { label: "Allow all project folders", hint: "npx worktrust remote roots add <folder>", info: folders.length ? `Adds ${folders.map(tildePath).join(", ")} as roots.` : "No usual project folder exists here: choose projects.", value: "all", ...(folders.length ? {} : { disabled: true, quiet: "No usual project folder here." }) },
    { label: "Choose projects ›", hint: "npx worktrust remote projects add <folder>", info: "Tick the projects this phone may steer an agent in.", value: "choose" },
    { label: "Later", hint: "npx worktrust remote roots", info: "Grant nothing now. The menu's Remote Agent › Roots does it later.", value: "later" },
  ];
}

const LATER = ["  A phone may steer agents only in folders you grant here:", "    npx worktrust remote roots add <folder>      a folder whose projects it may open", "    npx worktrust remote projects add <folder>   one project folder"];

/**
 * The access step. `apply(change)` is the keyboard's one door (remote-cli.mjs settingsChange); `term` a menu terminal
 * (cli-menu.mjs createTerminal) and `choose` its list; `interactive` false names the commands and asks nothing.
 * → "all" | "chosen" | "later".
 */
export async function accessStep(io, { apply, interactive, term = null, choose = null, folders = suggestedFolders().map((f) => f.path), projects = null }) {
  if (!interactive || !term || !choose) { for (const line of LATER) io.say(line); return "later"; }
  io.say();
  term.enter();
  try {
    const picked = await choose(term, { title: "What may this phone reach on this computer?", items: accessItems(folders) });
    if (picked === "quit" || picked === "back" || picked.item.value === "later") { term.erase(); for (const line of LATER) io.say(line); return "later"; }
    if (picked.item.value === "all") {
      term.erase(); term.restore();
      for (const path of folders) await apply({ what: "roots", add: path });
      return "all";
    }
    const offered = projects ?? knownProjects();
    if (offered.length === 0) { term.erase(); io.say("  No git project found in the usual folders. Grant one: npx worktrust remote projects add <folder>"); return "later"; }
    const ticked = await choose(term, { title: "Projects this phone may steer an agent in", multi: true, items: [...offered.map((path) => ({ label: tildePath(path), info: "Space ticks it; Enter grants the ticked projects.", tick: true, path })), { label: "Grant the ticked projects", info: "Enter grants every ticked project.", done: true }] });
    term.erase(); term.restore();
    const chosen = ticked === "quit" || ticked === "back" ? [] : ticked.ticked;
    if (chosen.length === 0) { for (const line of LATER) io.say(line); return "later"; }
    for (const item of chosen) await apply({ what: "projects", add: item.path });
    return "chosen";
  } finally { term.restore(); }
}
/**
 * A LINKED PHONE THAT WAS NEVER GIVEN A REACH (0.11.12, owner 2026-11-15: "what if someone closes the CLI before choosing?").
 * Nothing is shared by default: the roots and projects lists start empty (remote-store.mjs: a missing file is an empty list)
 * and only the keyboard's door or a signed change from the app fills them, so a phone linked with no choice made reaches no
 * folder at all. While a phone is confirmed and BOTH lists are still empty, the menu's first screen and Remote Agent say
 * "<name> is linked: choose what it may reach" and open this step (`remote access`). Derived from the lists themselves, no
 * new state: Ctrl+C, Esc or Later write nothing, so the lists stay empty and the question stays. Grants belong to the
 * computer: once a folder is granted, every phone linked to it reaches that folder, as before.
 * → the newest confirmed phone's connection row, or null. An unreadable file throws (the caller says not known).
 */
const newestFirst = (list) => [...list].sort((a, b) => (b.confirmed_at ?? 0) - (a.confirmed_at ?? 0));
export function awaitingAccess(phones = loadPhones(), roots = loadRoots(), projects = loadProjects()) {
  if (roots.length > 0 || projects.length > 0 || phones.confirmed.length === 0) return null;
  const newest = newestFirst(phones.confirmed)[0];
  return connections({ ...phones, pending: [] }).find((c) => c.device_id === newest.device_id) ?? null;
}

/** The access step in this terminal (interactive only with a terminal on both ends and no --yes), then the 0.11.14 questions. */
export async function reachStep(io, apply) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !io.has?.("yes");
  const menu = interactive ? await import("./cli-menu.mjs") : null, term = menu?.createTerminal() ?? null;
  const reach = await accessStep(io, { apply, interactive, term, choose: menu?.choose ?? null });
  await (await import("./remote-settings.mjs")).trustStep(io, { apply, interactive, term, choose: menu?.choose ?? null }); // may phones add a browser; the modes
  return reach;
}

/** `remote access`: the newest linked phone, then the same step. */
export async function accessCommand(io, apply) {
  if (loadPhones().confirmed.length === 0) return io.say("  No phone is linked to this computer yet: npx worktrust remote pair");
  const waiting = awaitingAccess();
  io.say(waiting ? `  ${waiting.name} is linked. Nothing on this computer is shared with it yet; choose what it may reach.` : `  Granted here: ${loadRoots().length} root folder(s), ${loadProjects().length} project(s). Every linked phone reaches them. Add more:`);
  return reachStep(io, apply);
}

/**
 * A LINKED PHONE WITH NO REACH CHOSEN (0.11.12, remote-connections.mjs awaitingAccess): the first row, until a folder is
 * granted. Nothing is shared meanwhile; the row opens the same access step `remote pair` ends with.
 */
export const awaitingRow = (name, open) => ({ label: `${name} is linked: choose what it may reach ›`, note: { text: "nothing shared yet", tone: "yellow" }, hint: "npx worktrust remote access", info: "Nothing is shared until you choose. Opens the access step.", run: () => open(["remote", "access"]) });
/** The name of a linked phone still waiting for its reach, or null (also when a file cannot be read: never a guess). */
export function awaitingName() { try { return awaitingAccess()?.name ?? null; } catch { return null; } }
