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
import { createInterface } from "node:readline/promises";
import { gatewayOf, loadIdentity, loadKeys, loadPhones, loadSettings, random, removeFile, savePhones, writeJson } from "./remote-store.mjs";
import * as P from "./remote-protocol.mjs";
import { terminalQr } from "./remote-qr.mjs";
import { compactForQr } from "./remote-pairing.mjs";

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
 * invite (five minutes, one phone, once), its QR, its link and the typed code, as before. With `ready` (the one-scan invite
 * `remote app` wrote once the issuer named this computer, remote-pairing.mjs `oneScanInvite`): no second QR while the phone
 * that scanned the first one links by itself; after `waitMs`, or for a phone that opened the code with the camera or runs an
 * older app, the SAME invite as the pairing QR, with one line why. A phone that proves the secret is confirmed by the daemon
 * (PROTOCOL.md §Pairing); a phone that asked by the typed code waits for `remote phones confirm` at this keyboard.
 */
export async function linkPhone(io, ready = null, { waitMs = ONE_SCAN_WAIT_MS, now = Date.now, tick = 1000 } = {}) {
  const keys = loadKeys(), identity = loadIdentity(), settings = loadSettings();
  if (!keys || !identity) io.fail("this computer is not paired for remote yet: run `npx worktrust remote app` (or `remote web`)");
  // Off is its own state (owner, 2026-11-14): a missing gateway no longer exists, WorkTrust's is the default (gatewayOf).
  if (!settings.enabled) io.fail("remote is off on this computer: run `npx worktrust remote app` (or `remote web`)");
  const started = now();
  const invite = ready ?? { ...P.createPairingInvite({ gateway: gatewayOf(settings), deviceId: identity.device_id, ed25519_pub: keys.public.ed25519_pub, x25519_pub: keys.public.x25519_pub, nowMs: started, random }), code: P.generatePairingCode(random), used: false, created_at: started };
  if (!ready) writeJson("invite.json", invite);
  const { code, used: _used, created_at: since, ...bare } = invite;
  const link = P.encodePairingInvite(bare);
  let shown = false;
  const show = (why) => {
    shown = true;
    io.say();
    io.say(why ?? "  Scan this with the WorkTrust app (or the phone's camera):");
    io.say(terminalQr(compactForQr(link), { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }));
    io.say(`  Link: ${link}`);
    io.say(`  No camera? Type this code in the app: ${pretty(code)} (then confirm the phone here with \`npx worktrust remote phones\`)`);
    io.say("  The code and the QR work once, for five minutes. Ctrl+C cancels.");
  };
  if (ready) io.say("  Linking the phone that scanned the code …"); else show();
  const cancel = () => { removeFile("invite.json"); process.exit(130); };
  process.once("SIGINT", cancel);
  const before = new Set(loadPhones().pending.map((p) => p.fingerprint));
  try {
    while (now() < invite.e * 1000) {
      await new Promise((resolve) => setTimeout(resolve, tick));
      const phones = loadPhones();
      const paired = phones.confirmed.find((p) => p.how === "qr" && p.confirmed_at >= since);
      if (paired) { io.say(`  ✓ Paired: phone · ${paired.fingerprint}`); return paired; }
      const asked = phones.pending.find((p) => !before.has(p.fingerprint));
      if (asked) { io.say(`  A phone asked by code (${asked.fingerprint}). Confirm it at this keyboard: npx worktrust remote phones confirm ${asked.fingerprint}`); return null; }
      if (!shown && now() - started >= waitMs) show("  No phone linked by itself (the code was opened with the camera, or the app is older): scan this in the WorkTrust app.");
    }
  } finally { process.off("SIGINT", cancel); }
  removeFile("invite.json");
  io.say("  The pairing code expired. Run `npx worktrust remote pair` for a new one.");
  return null;
}
