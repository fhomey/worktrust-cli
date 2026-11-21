/**
 * READ ALONG WITH A SESSION AT THE DESK (CLI 0.11.19; owner, 2026-11-21; docs/remote-agents/DESK-SESSIONS.md §Read along).
 * A paired phone follows ONE Claude Code session of this computer's own desk list, live and read-only: the answer to its
 * `history.get` `follow` is the newest page read to the end of the transcript, and what is written after it is pushed as
 * further `history.page`s on the same transient lane, sealed for that phone alone, journaled nowhere.
 *
 *   who       remote-history.mjs hands a follow over only after its own line, pacer and resolve (the session is in the
 *             desk's own list, under a project granted now, `desk_history` and `desk_live` both the keyboard's yes) and only
 *             for a phone that asked to read `desk_live`. One subject per phone (another replaces it), MAX_FOLLOWERS in all.
 *   window    P.HISTORY_FOLLOW_MS from the ask or its last renewal (the same ask again, `known` the head the phone holds).
 *             A phone that stops asking is forgotten without a word; `follow: false` stops at once.
 *   the tick  ONE timer, only while someone follows, every TICK_MS. Per follower: the settings (remote on, not paused, both
 *             switches), the phone still confirmed and its project still granted; then the transcript's name is looked at (lstat) and NOTHING is opened
 *             or read while its size stands. Every RESOLVE_MS, and when the name is gone, the whole resolve again.
 *   a push    read from the anchor to the last whole line (the anchor: what was sent, or earlier where a step had no result
 *             yet or a text may still become the answer; at most LOOK_BACK behind), mapped by the history's one mapping
 *             (the same withholding, caps and mask), without what was already sent unchanged (by item hash). One page, at
 *             most PUSH_BYTES, after the pacer's room, in the phone's own line (so never beside another read for it).
 *   joined    a push names the head it builds on (`follow.after`) and its own `head`. Whatever does not join (a delta too
 *             large, the transcript replaced or cut: `stale`, a renewal that holds another head) is answered with a WHOLE
 *             newest page (`after: null`), never with a gap.
 *   ended     once, with why (`follow.end`: off, paused, gone, busy), in a page that carries nothing else. FOLLOW_MAX_MS after
 *             it began a follow ends whatever its renewals (`busy`: the phone opens the screen again to go on).
 *
 * READING ONLY: no import here opens a file by itself (remote-history-file.mjs does, through the history's own checks),
 * writes one, touches the journal or reaches an agent. Sub-agent lines are never pushed (the mapping leaves them to a page
 * asked for that sub-agent).
 */
import * as P from "./remote-protocol.mjs";
import { closePlain, cursorAt, identOf, lineEnd, lookPlain, readForward } from "./remote-history-file.mjs";
import { mapTranscript } from "./remote-history-claude.mjs";

export const TICK_MS = 1_000, RESOLVE_MS = 15_000, MAX_FOLLOWERS = 4, PUSH_BYTES = 98_304, LOOK_BACK = 1024 * 1024, KEEP_SENT = 2_000, KEEP_OPEN = 64;
/** A follow's whole life, however often it is renewed (review 2026-11-21, P3-6): then it ends, and the phone asks again when its screen is opened again. */
export const FOLLOW_MAX_MS = 60 * 60_000;
const hashOf = (item) => P.toBase64Url(P.sha256(P.utf8Encode(JSON.stringify(item)))).slice(0, 12);
/** Why nobody reads along now, by the settings file alone; null: they may. Anything but the keyboard's own yes is off. */
export const followOff = (s) => (s?.enabled !== true ? "off" : (s.paused ?? null) !== null ? "paused" : s.desk_history !== true || s.desk_live !== true ? "off" : null);

export function createFollow(o) {
  // o: { settings(), projects(), resolve(payload), open(subject), page(subject, payload, phone, base, live), fit(entries, bytes), inLine(phone, work), sealPage(body, phone),
  //      confirmed(phone), room(), now(), log(kind, fields), every?(run, ms) → stop() }
  const followers = new Map(); // phone -> follower
  let stopTimer = null;
  const every = o.every ?? ((run, ms) => { const t = setInterval(run, ms); t.unref?.(); return () => clearInterval(t); });
  // Said once when its first page left, and once when it is over; a follow that never started is never said to have stopped.
  const said = (f, on, why = null) => { if (on === f.announced) return; f.announced = on; o.log("read_along", { on, phone: f.phone, project_id: f.name.project_id, ...(why ? { why } : {}) }); };
  /** The timer runs exactly while someone follows. */
  const settle = () => {
    if (followers.size > 0 && stopTimer === null) stopTimer = every(() => { tick().catch(() => o.log("follow_failed", {})); }, TICK_MS);
    if (followers.size === 0 && stopTimer !== null) { stopTimer(); stopTimer = null; }
  };
  const drop = (f, why) => { if (followers.get(f.phone) !== f) return false; followers.delete(f.phone); said(f, false, why); settle(); return true; };

  /** THE ONE SEAL OF THIS MODULE: a page the protocol takes, for the phone that follows, and only while it still does. */
  function send(f, page) {
    if (followers.get(f.phone) !== f) return false;
    const shaped = P.validateEventBody("history.page", page);
    if (!shaped.ok || page.follow === undefined) { o.log("history_invalid", { code: String(shaped.code ?? "follow").slice(0, 32) }); return false; }
    // THE SWITCH, ASKED AGAIN RIGHT BEFORE THE SEAL (review 2026-11-21, P3-5): a page read while reading along was on never leaves once it is off or paused; only the page that says so does.
    if (page.follow.end === undefined && followOff(o.settings()) !== null) return false;
    o.sealPage(page, f.phone);
    if (page.follow.after === null || page.follow.end !== undefined) o.log("history_page", { source: page.source, status: page.status, items: page.items.length }); // a whole page and an end are logged; a push a second is not (a log that grows by the second)
    return true;
  }
  /** The follow is over: one last page that says why, and carries nothing else. */
  function finish(f, end, why = end) {
    send(f, { request: f.request, ...f.name, status: "not_modified", source: "transcript", items: [], next_before: null, older: "more", head: f.head ?? "t.0", live_seq: 0, open_turn: null, follow: { after: f.head, end } });
    drop(f, why);
  }

  /** What `f` was sent: each item's hash, the steps that had no result yet and the newest text (both may still change), by their line. */
  function remember(f, entries, end, head) {
    for (const { item, line } of entries) {
      f.sent.delete(item.id); f.sent.set(item.id, hashOf(item));
      if ((item.kind === "step" || item.kind === "subagent") && item.state === "unknown") f.open.set(item.id, line); else f.open.delete(item.id);
      if (item.kind === "text" && (f.text === null || line >= f.text.line)) f.text = { id: item.id, line }; else if (f.text?.id === item.id) f.text = null;
    }
    for (const id of [...f.sent.keys()].slice(0, Math.max(0, f.sent.size - KEEP_SENT))) f.sent.delete(id);
    for (const id of [...f.open.keys()].slice(0, Math.max(0, f.open.size - KEEP_OPEN))) f.open.delete(id);
    f.upTo = end; f.head = head;
  }

  /** A whole newest page for `f`: the first answer, and whatever a push cannot join. What `f` held is replaced. → the page, or the refusal. */
  async function whole(f, subject, bytes, status = null) {
    const live = {};
    let page = null;
    try { page = await o.page(subject, { ...f.name, before: null, max_bytes: bytes }, f.phone, { request: f.request, ...f.name, live_seq: 0 }, live); } catch { o.log("history_unreadable", {}); }
    if (page === null || typeof page === "string") return page ?? "not_found";
    f.sent.clear(); f.open.clear(); f.text = null; f.id = live.id; f.seen = live.size; f.file = subject.files.at(-1).file; f.subject = subject;
    remember(f, live.entries, live.end, page.head);
    return { ...page, ...(status ? { status } : {}), follow: { after: null } };
  }

  /** What was written since `f` was last sent to. → { page, entries, end }, "whole" or "stale" (a whole page instead), "gone", or null: nothing to send. */
  function delta(f, subject) {
    const opened = o.open(subject);
    if (!opened) return "gone";
    try {
      if (identOf(opened) !== f.id || opened.size < f.upTo) return "stale";
      f.seen = opened.size;
      const end = lineEnd(opened.fd, opened.size);
      if (end === null || end <= f.upTo) return null;
      if (end - f.upTo > LOOK_BACK) return "whole";
      for (const [id, line] of f.open) if (line < end - LOOK_BACK) f.open.delete(id);
      if (f.text !== null && f.text.line < end - LOOK_BACK) f.text = null;
      const from = Math.min(f.upTo, f.text?.line ?? f.upTo, ...f.open.values());
      const lines = readForward(opened.fd, from, end, end - from).lines;
      // New lines whole; an item sent before only when it changed (a step got its result, a text became the answer).
      const entries = mapTranscript(lines, { scope: subject.scope, cwd: subject.projectPath, mask: true, closed: false }).filter((e) => (f.sent.has(e.item.id) ? f.sent.get(e.item.id) !== hashOf(e.item) : e.line >= f.upTo));
      if (entries.length === 0) { f.upTo = end; return null; }
      if (o.fit(entries, PUSH_BYTES) > 0) return "whole";
      const before = f.upTo > 0 ? cursorAt(opened.fd, 0, f.upTo, opened.size) : null;
      return { entries, end, page: { request: f.request, ...f.name, status: "ok", source: "transcript", items: entries.map((e) => e.item), next_before: before, older: before === null ? "start" : "more", head: `t.1.${end}.0`, live_seq: 0, open_turn: null, follow: { after: f.head } } };
    } finally { closePlain(opened); }
  }

  /** One push for `f`, or its end. → whether a page left. Run inside the phone's line only. */
  async function push(f, subject) {
    let made = null;
    try { made = delta(f, subject); } catch { o.log("history_unreadable", {}); made = "gone"; }
    if (made === "gone") { finish(f, "gone"); return true; }
    if (made === "whole" || made === "stale") {
      const page = await whole(f, subject, PUSH_BYTES, made === "stale" ? "stale" : null);
      if (typeof page === "string") { finish(f, page === "remote_paused" ? "paused" : "gone"); return true; }
      made = { page };
    }
    if (made === null) return false;
    await o.room?.();
    if (!send(f, made.page)) { finish(f, followOff(o.settings()) ?? "busy"); return true; } // off or paused while it waited for room: said as that
    if (made.entries) remember(f, made.entries, made.end, made.page.head);
    return true;
  }

  /** Why an ask's page did not leave: the switch or a pause meanwhile, else load. */
  const refusal = () => ({ off: "not_allowed", paused: "remote_paused" })[followOff(o.settings())] ?? "busy";

  /** A follow ask or its renewal, from remote-history.mjs: resolved there, in the phone's line, after the pacer's room. → "taken" or the refusal. */
  async function ask(subject, payload, phone, commandId) {
    const name = subject.name, was = followers.get(phone) ?? null, same = was !== null && was.name.session_ref === name.session_ref && was.name.project_id === name.project_id;
    if (was === null && followers.size >= MAX_FOLLOWERS) return "busy";
    const f = same ? was : { phone, name, request: commandId, until: 0, sent: new Map(), open: new Map(), text: null, upTo: 0, head: null, id: null, seen: 0, file: null, subject, checkedAt: 0, queued: false, announced: false, since: o.now() };
    f.request = commandId; f.until = o.now() + P.HISTORY_FOLLOW_MS; f.checkedAt = o.now(); f.subject = subject;
    if (!same) { followers.set(phone, f); settle(); } // another subject of this phone is replaced without a word: it asked for this one
    if (same && payload.known !== undefined && payload.known === f.head && subject.files.at(-1).file === f.file) {
      // The renewal of a phone that holds what was sent: what was written since, under this ask, or nothing.
      if (await push(f, subject)) return "taken";
      return send(f, { request: commandId, ...name, status: "not_modified", source: "transcript", items: [], next_before: null, older: "more", head: f.head, live_seq: 0, open_turn: null, follow: { after: f.head } }) ? "taken" : refusal();
    }
    const page = await whole(f, subject, Math.min(payload.max_bytes, P.HISTORY_PAGE_MAX_BYTES));
    if (typeof page === "string") { drop(f, "refused"); return page; }
    if (send(f, page)) { if (!same) said(f, true); return "taken"; } // said in the run terminal once its first page left
    drop(f, "refused");
    return refusal();
  }

  /** `follow: false`: at once. */
  function stop(phone, payload) {
    const f = followers.get(phone);
    if (f && f.name.session_ref === payload.session_ref && f.name.project_id === payload.project_id) drop(f, "asked");
    return "taken";
  }

  async function tick() {
    const now = o.now(), off = followOff(o.settings());
    // The grants, read once a tick (review 2026-11-21, P3-4: a project taken away kept streaming until the next resolve, up to 15 s). Unreadable: nobody's is granted.
    let granted = new Set();
    try { granted = new Set(o.projects().map((p) => p.project_id)); } catch { o.log("history_unreadable", {}); }
    for (const f of [...followers.values()]) {
      if (o.confirmed?.(f.phone) !== true) { drop(f, "removed"); continue; } // a phone the keyboard removed hears nothing more, not even why
      if (now >= f.until) { drop(f, "expired"); continue; }
      if (now - f.since >= FOLLOW_MAX_MS) { finish(f, "busy", "capped"); continue; } // the hour: said with the reason a phone already has words for (no fifth reason an older screen would not know)
      if (off !== null) { finish(f, off); continue; }
      if (!granted.has(f.name.project_id)) { finish(f, "gone"); continue; }
      if (f.queued || f.file === null) continue; // its first page is still being read
      const again = now - f.checkedAt >= RESOLVE_MS, look = again ? null : lookPlain(f.file);
      if (!again && look !== null && look.id === f.id && look.size === f.seen) continue; // nothing was written: nothing is opened, nothing read
      f.queued = true;
      const ran = o.inLine(f.phone, async () => {
        if (followers.get(f.phone) !== f) return;
        // The grant, the switches and the desk's own list, asked again: every RESOLVE_MS, and at once when the name is gone or another file.
        const subject = again || look === null || look.id !== f.id ? o.resolve({ ...f.name, before: null, max_bytes: P.HISTORY_PAGE_MIN_BYTES, follow: true }) : f.subject;
        if (typeof subject === "string") return finish(f, subject === "remote_paused" ? "paused" : followOff(o.settings()) ?? "gone");
        f.checkedAt = again ? now : f.checkedAt; f.subject = subject;
        if (subject.files.at(-1).file !== f.file) f.id = null; // another transcript under this name: a whole page, said stale
        await push(f, subject);
      });
      if (ran === "busy") f.queued = false; else ran.catch(() => o.log("follow_failed", {})).finally(() => { f.queued = false; });
    }
    settle();
  }

  return {
    ask, stop, tick,
    /** Whether `phone` follows this subject now: its other asks for it then read to the end of the transcript too. */
    reads: (phone, subject) => { const f = followers.get(phone); return Boolean(f) && subject.kind === "desk" && f.name.session_ref === subject.name.session_ref && f.name.project_id === subject.name.project_id && o.now() < f.until && followOff(o.settings()) === null; }, // only while reading along is still on (review P3-5): the tick may not have ended the follow yet
    count: () => followers.size,
  };
}
