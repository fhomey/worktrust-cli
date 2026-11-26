/**
 * EVERY DEVICE EVER LINKED HERE, AND HOW LONG (CLI 0.11.22; owner, 2026-11-23). `npx worktrust remote phones --history` (and
 * Remote Agent › Connections › History ›) reads ~/.worktrust/remote/devices-history.jsonl (remote-store.mjs: append-only, ids,
 * a kind, a name, how and when, and counts) and shows one line per link, newest first:
 *
 *   kind · name · fingerprint · device id · linked since · link ended (or active) · how long · how linked · how ended ·
 *   sessions / commands / prompts · last seen
 *
 * CLI 0.11.26 (owner, 2026-11-25: one long wrapped line per device was unreadable): a short aligned table instead, one row per
 * link (device, its short number, linked since, last seen, linked or ended), each row cut to the terminal's width; the menu's
 * History › opens one row's DETAIL (every field, labelled, "not known" in words) with Disconnect for a live one. A pipe or
 * `--plain` gets one tab-separated line per link; `--history <number|device id>` prints one device's detail.
 *
 * `--json` gives the same periods as records. Counts are what the daemon counted while it ran; a device from before 0.11.22
 * (backfilled) has none until it is counted ("not counted"), and a count that is not known is absent, never 0. `remote phones`
 * itself lists the active devices only; a removed one is here.
 */
import { ensureHistory, loadPhones, readHistory } from "./remote-store.mjs";

const HOW_LINKED = { qr: "scanned the QR", keyboard: "typed code, confirmed here", endorsed: "added by a phone" };
const HOW_ENDED = { keyboard: "removed here", keyboard_all: "remove --all", phone: "disconnected from the phone", revoked: "revoked in WorkTrust" };

/** "6d 10h 20m"; under a day "3h 5m"; under an hour "20m". */
export function durationWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "not known";
  const m = Math.floor(ms / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  return d > 0 ? `${d}d ${h}h ${r}m` : h > 0 ? `${h}h ${r}m` : `${r}m`;
}
const local = (ms) => { if (!Number.isFinite(ms)) return "not known"; const t = new Date(ms), p = (n) => String(n).padStart(2, "0"); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`; };

/** The records folded into periods (one per link), newest first (active links, then ended ones). `seen`: device_id → phones.json seen_at. */
export function foldHistory(records, seen = new Map()) {
  const periods = [], open = new Map();
  for (const r of records) {
    if (r.t === "linked") { const p = { device_id: r.device_id, fingerprint: r.fingerprint ?? null, kind: r.kind ?? null, name: r.name ?? null, how: r.how ?? null, endorsed_by: r.endorsed_by ?? null, linked_at: r.linked_at ?? null, ended_at: null, ended_how: null, backfill: r.backfill === true }; periods.push(p); open.set(r.device_id, p); }
    const p = open.get(r.device_id);
    if (!p) continue;
    if (r.t === "named" && r.name) p.name = r.name;
    if (r.t === "ended") { p.ended_at = r.ended_at ?? null; p.ended_how = r.how ?? null; open.delete(r.device_id); }
    if (r.t === "counts") {
      for (const k of ["sessions", "commands", "prompts", "voice_prompts"]) if (Number.isInteger(r[k])) p[k] = (p[k] ?? 0) + r[k];
      if (Number.isFinite(r.last_seen)) p.last_seen = Math.max(p.last_seen ?? 0, r.last_seen);
      p.counted_since ??= r.at ?? null;
    }
  }
  for (const p of open.values()) { const s = seen.get(p.device_id); if (Number.isFinite(s)) p.last_seen = Math.max(p.last_seen ?? 0, s); }
  // Newest first: the links still active (newest link first), then the ended ones by when they ended.
  const active = (p) => p.ended_at === null && p.ended_how === null;
  return periods.sort((a, b) => (active(b) - active(a)) || (active(a) ? (b.linked_at ?? 0) - (a.linked_at ?? 0) : (b.ended_at ?? 0) - (a.ended_at ?? 0)));
}

/** One line per period. */
export function historyLine(p, now = Date.now()) {
  const kind = p.kind ? `${p.kind[0].toUpperCase()}${p.kind.slice(1)}` : "Device";
  const name = p.name ?? `${p.kind === "browser" ? "Browser" : "Phone"} ${String(p.fingerprint ?? "").slice(0, 4)}`;
  const until = p.ended_at ?? (p.ended_how ? null : now);
  const long = Number.isFinite(p.linked_at) && Number.isFinite(until) ? durationWords(until - p.linked_at) : "not known";
  const linked = p.how === "endorsed" && p.endorsed_by ? `added by phone ${p.endorsed_by}` : HOW_LINKED[p.how] ?? "not known";
  const ended = p.ended_how !== null || p.ended_at !== null ? HOW_ENDED[p.ended_how] ?? "ended" : "active";
  const counted = ["sessions", "commands", "prompts"].some((k) => Number.isInteger(p[k]))
    ? `sessions ${p.sessions ?? 0} · commands ${p.commands ?? 0} · prompts ${p.prompts ?? 0}${p.voice_prompts ? ` (${p.voice_prompts} by voice)` : ""}${p.backfill && p.counted_since ? ` (counted since ${local(p.counted_since)})` : ""}`
    : "not counted";
  return `${kind} · ${name} · ${p.fingerprint ?? "?"} · ${p.device_id} · linked ${local(p.linked_at)} · ${ended === "active" ? "active" : `ended ${local(p.ended_at)}`} · ${long} · ${linked} · ${ended === "active" ? "still linked" : ended} · ${counted} · last seen ${local(p.last_seen)}`;
}

const isActive = (p) => p.ended_at === null && p.ended_how === null;
const day = (ms) => (Number.isFinite(ms) ? local(ms).slice(0, 10) : "not known");
const kindWord = (p) => (p.kind ? `${p.kind[0].toUpperCase()}${p.kind.slice(1)}` : "Device");
/** "Phone · iPhone", "Browser on macOS" (a name that already says its kind), "Phone 42GS" when it has no name, "Device 42GS" when not even its kind is known. */
export function deviceLabel(p) {
  if (!p.kind && !p.name) return `Device ${shortNumber(p)}`; // a link from before 0.11.22: its kind was never written, so none is claimed
  const kind = kindWord(p), name = p.name ?? `${p.kind === "browser" ? "Browser" : "Phone"} ${shortNumber(p)}`;
  return name.toLowerCase().startsWith(kind.toLowerCase()) ? name : `${kind} · ${name}`;
}
/** The fingerprint's first group ("JFA2"): the short number a person reads and types. */
export const shortNumber = (p) => String(p.fingerprint ?? "").split("-")[0] || "?";
export const historyCells = (p) => ({ device: deviceLabel(p), number: shortNumber(p), since: day(p.linked_at), last: isActive(p) ? "active" : day(p.last_seen), state: isActive(p) ? "linked" : "ended" });
const cut = (text, n) => (text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1)).trimEnd()}…`);
/** The aligned rows, newest first, none longer than `width` (the device's name gives way first, then the words "since"/"last"). */
export function historyRows(periods, width = 72) {
  const cells = periods.map(historyCells), words = width >= 64;
  const tail = (c) => `  ${c.number.padEnd(4)}  ${words ? "since " : ""}${c.since.padEnd(10)}  ${(words && c.last !== "active" ? `last ${c.last}` : c.last).padEnd(words ? 15 : 10)}  ${c.state}`;
  const tails = cells.map(tail), room = Math.max(4, width - Math.max(0, ...tails.map((t) => t.length)));
  const name = Math.min(room, Math.max(4, ...cells.map((c) => c.device.length)));
  return cells.map((c, i) => cut(`${cut(c.device, name).padEnd(name)}${tails[i]}`, width).trimEnd());
}
/** One device, every field the long line had, labelled; "not known" (or "not counted yet") in words. → [[label, value]] */
export function historyDetail(p, now = Date.now()) {
  const active = isActive(p), until = p.ended_at ?? (p.ended_how ? null : now);
  const counted = ["sessions", "commands", "prompts"].some((k) => Number.isInteger(p[k])), count = (k) => (counted ? String(p[k] ?? 0) : "not counted yet");
  return [
    ["Type", p.kind ? kindWord(p) : "not known"], ["Name", p.name ?? "not known"], ["Device id", p.device_id ?? "not known"], ["Fingerprint", p.fingerprint ?? "not known"],
    ["Linked at", local(p.linked_at)], ["How it was linked", p.how === "endorsed" && p.endorsed_by ? `added by phone ${p.endorsed_by}` : HOW_LINKED[p.how] ?? "not known"],
    ["State", active ? "linked" : "ended"], ["Ended at", active ? "still linked" : local(p.ended_at)], ["How it ended", active ? "still linked" : HOW_ENDED[p.ended_how] ?? "not known"],
    ["Duration", Number.isFinite(p.linked_at) && Number.isFinite(until) ? `${durationWords(until - p.linked_at)}${active ? " so far" : ""}` : "not known"],
    ["Sessions", count("sessions")], ["Commands", count("commands")],
    ["Prompts", counted ? `${p.prompts ?? 0}${p.voice_prompts ? ` (${p.voice_prompts} by voice)` : ""}${Number.isFinite(p.counted_since) ? `, counted since ${local(p.counted_since)}` : ""}` : "not counted yet"],
    ["Last seen", local(p.last_seen)],
  ];
}
export const detailLines = (p, width = 79, now = Date.now()) => historyDetail(p, now).map(([label, value]) => cut(`  ${label.padEnd(19)}${value}`, width));
/** A device by its short number, full fingerprint or device id (the newest link of it). */
export const findPeriod = (periods, key) => periods.find((p) => [shortNumber(p), p.fingerprint, p.device_id].some((v) => typeof v === "string" && v.toUpperCase() === String(key).toUpperCase())) ?? null;

export function deviceHistory() {
  const phones = loadPhones();
  ensureHistory(phones);
  return foldHistory(readHistory(), new Map(phones.confirmed.map((p) => [p.device_id, p.seen_at])));
}

/** `remote phones --history [<number|device id>] [--plain|--json]`: a table in a terminal, tab-separated in a pipe or with --plain. */
export function historyCommand(io, { json = false, plain = false, pick = null, tty = Boolean(process.stdout.isTTY), columns = process.stdout.columns || 80 } = {}) {
  const periods = deviceHistory();
  if (json) return io.say(JSON.stringify(periods, null, 2));
  if (pick) {
    const p = findPeriod(periods, pick);
    if (!p) return io.fail(`no device "${pick}" in this computer's history (npx worktrust remote phones --history lists them)`);
    return void detailLines(p, tty && !plain ? columns - 1 : Infinity).forEach((line) => io.say(line));
  }
  if (plain || !tty) return void periods.forEach((p) => { const c = historyCells(p); io.say([c.device, c.number, c.since, c.last, c.state].join("\t")); });
  io.say(`  Devices linked to this computer, newest first (${periods.length}):`);
  for (const row of historyRows(periods, columns - 5)) io.say(`    ${row}`);
  io.say(periods.length === 0 ? "    None yet." : "  One device in full: npx worktrust remote phones --history <number>");
}
