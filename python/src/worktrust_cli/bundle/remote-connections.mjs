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
import { loadIdentity, loadKeys, loadPhones, savePhones } from "./remote-store.mjs";
import * as P from "./remote-protocol.mjs";

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
