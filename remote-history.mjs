/**
 * THE HISTORY OF A SESSION, READ ON THE COMPUTER THAT RAN IT (CLI 0.11.17; docs/remote-agents/CHAT-HISTORY.md §4.3,
 * PROTOCOL.md §History). `history.get` from a phone or a browser → ONE `history.page`, sealed for the asker alone on the
 * transient lane. READING ONLY: nothing here starts, revives, resumes or stops an agent, nothing is written to the journal
 * or to any file, and a page is no event of a session's stream.
 *
 *   resolve   the subject comes from THIS computer's records, never from the ask: a remote session by the journal's own
 *             record (its project still granted, else `not_allowed`; a terminal session `unsupported`), its transcript by
 *             the agent sessions the journal names; a desk session only when it is in the desk's own list under that
 *             project and reading desk sessions is on (`worktrust remote desk-history on|off`). A phone never names a path.
 *   source    Claude Code's transcript when the computer can read it (remote-history-file.mjs opens it, a regular file
 *             that is no link, whose recorded folder is the project's); the journal otherwise (remote-history-journal.mjs).
 *   page      backwards from a cursor, at most the asked bytes (never above the protocol's page), 120 items, 4 MiB read per
 *             ask; a line always moves the cursor, a cursor that no longer holds answers `stale` with the newest page.
 *   valid     a page is checked against the protocol before it is sealed; one that fails is refused (`busy`: the client
 *             says it could not load), never "taken". A line of more than 100 blocks is cut and says so, so a page of
 *             whole lines always fits and the cursor moves past it.
 *   closed    the running turn is never in a page: what was written since its words were taken is named (`open_turn`) and
 *             left to the live stream.
 *   one line  one read per phone at a time, in the order asked, each waiting for the pacer's room; more than MAX_WAITING
 *             behind it is `busy`, and so is more than 30 asks a minute, both before anything is looked up. The subject is resolved after that wait, right before the read: what the keyboard took
 *             back meanwhile (a grant, the desk switch, a pause) refuses the ask.
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as P from "./remote-protocol.mjs";
import { encodeProjectDir, HELD_WINDOW_MS, samePath } from "./remote-desk-sessions.mjs";
import { atLineStart, closePlain, cursorAt, cursorHolds, openPlainUnder, parseCursor, PEEK, readBack, readForward } from "./remote-history-file.mjs";
import { cutTo, detailOf, itemBytes, mapTranscript, typedWords } from "./remote-history-claude.mjs";
import { journalHistory } from "./remote-history-journal.mjs";

export const MAX_WAITING = 4, ROOM_ITEMS = 110, ASKS_A_MINUTE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOURNAL_CURSOR = /^v1\.j\.(\d{1,9})\.([A-Za-z0-9_-]{8})$/;
const MATCH_MS = 600_000;
const tsOf = (v) => { const t = typeof v?.timestamp === "string" ? Date.parse(v.timestamp) : NaN; return Number.isSafeInteger(t) ? t : null; };
const mark = (id) => P.toBase64Url(P.sha256(P.utf8Encode(id))).slice(0, 8);

/** The newest items that fit, whole lines only. → the index of the first one kept (at least one line, so a page moves). */
function fit(entries, bytes, most = ROOM_ITEMS) {
  let from = entries.length, used = 0;
  while (from > 0) {
    let line = from - 1;
    while (line > 0 && entries[line - 1].line === entries[from - 1].line) line -= 1;
    const cost = entries.slice(line, from).reduce((n, e) => n + itemBytes(e.item), 0);
    if (from < entries.length && (used + cost > bytes || entries.length - line > most)) break;
    used += cost; from = line;
  }
  return from;
}

export function createHistory(o) {
  // o: { journal, sessions() (live, or null), projects(), desk, settings(), agentEnv(), sealPage(body, phone), room(), now(), log(kind, fields), home? }
  const lines = new Map(); // phone -> { end, waiting }
  const inLine = (phone, work) => {
    const line = lines.get(phone) ?? { end: Promise.resolve(), waiting: 0 };
    if (line.waiting >= MAX_WAITING) return "busy";
    line.waiting += 1;
    const run = line.end.then(work).finally(() => { line.waiting -= 1; if (line.waiting === 0) lines.delete(phone); });
    line.end = run.catch(() => {});
    lines.set(phone, line);
    return run;
  };
  // 30 ASKS A MINUTE PER PHONE (review 2026-11-17, F6), whatever they ask and however they end: a bucket that fills by the clock.
  const asked = new Map(); // phone -> { left, at }
  const mayAsk = (phone) => {
    const now = o.now(), was = asked.get(phone) ?? { left: ASKS_A_MINUTE, at: now };
    const left = Math.min(ASKS_A_MINUTE, was.left + (Math.max(0, now - was.at) * ASKS_A_MINUTE) / 60_000);
    if (asked.size > 256) for (const [other, b] of asked) if (now - b.at >= 60_000) asked.delete(other); // full again: nothing to remember
    asked.set(phone, { left: left >= 1 ? left - 1 : left, at: now });
    return left >= 1;
  };
  const storeOf = () => { const env = o.agentEnv?.() ?? {}; return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || o.home || homedir(), ".claude"), "projects"); };

  /** → the subject, from this computer's own records, or the reason it is refused. */
  function resolve(payload) {
    if ((o.settings().paused ?? null) !== null) return "remote_paused";
    if (payload.session_ref !== undefined) {
      if (o.settings().desk_history !== true) return "not_allowed"; // anything but the keyboard's own yes is off
      if (!o.projects().some((p) => p.project_id === payload.project_id)) return "not_allowed";
      const found = o.desk?.find?.(payload.session_ref, payload.project_id) ?? null;
      if (!found) return "not_found";
      return { kind: "desk", scope: payload.session_ref, name: { session_ref: payload.session_ref, project_id: payload.project_id }, files: [{ ref: payload.session_ref, file: found.file }], store: dirname(dirname(found.file)), projectPath: found.projectPath, saved: null, live: null, held: o.now() - found.last_activity_at < HELD_WINDOW_MS };
    }
    const id = payload.session_id, saved = o.journal.session(id), live = o.sessions?.()?.get?.(id) ?? null;
    if (!saved || !saved.adapter) return "not_found";
    if (saved.terminal === true) return "unsupported";
    const project = o.projects().find((p) => p.project_id === saved.project_id);
    if (!project) return "not_allowed";
    const refs = saved.adapter === "claude-code" ? (saved.agent_refs ?? [saved.agent_session_ref]).filter((r) => typeof r === "string" && UUID.test(r)) : [];
    return { kind: "remote", scope: id, name: { session_id: id }, files: refs.map((ref) => ({ ref, file: join(storeOf(), encodeProjectDir(project.path), `${ref}.jsonl`) })), store: storeOf(), projectPath: project.path, saved, live, held: false };
  }

  /** The transcript at `index`, opened, when it is a plain file whose recorded folder is the project's. The caller closes it. */
  function openTranscript(subject, index) {
    const opened = openPlainUnder(subject.store, subject.files[index]?.file ?? "");
    if (!opened) return null;
    const cwd = readForward(opened.fd, 0, opened.size, 65_536).lines.find((l) => typeof l.value?.cwd === "string")?.value.cwd ?? null;
    if (cwd === null || !samePath(cwd, subject.projectPath)) { closePlain(opened); return null; }
    return opened;
  }
  const firstUuid = (opened) => readForward(opened.fd, 0, opened.size, 65_536).lines.find((l) => typeof l.value?.uuid === "string")?.value.uuid ?? null;

  /** The running turn, from the moment its words were handed to the agent (before the agent's first line opens the journal's turn). */
  function openTurn(subject) {
    const live = subject.live, t = live?.turn, own = (id) => (P.isOpaqueId(id, "cmd") ? id : null);
    if (t && Number.isSafeInteger(t.from_seq)) return { from_seq: Math.max(1, t.from_seq), started_at: t.started_at, command_id: own(live.command_id) };
    return live?.turnOpen === true ? { from_seq: o.journal.lastSeq(subject.scope) + 1, started_at: Number.isSafeInteger(live.turnMark?.at) ? live.turnMark.at : o.now(), command_id: own(live.waiting?.command_id) } : null;
  }

  /**
   * NO LIVE RECORD IS NOT A CLOSED TURN (review 2026-11-17, F4): a remote session the daemon holds no live record of (it
   * just started, or the session went on at the desk) may still be written to. → the time of words the journal holds
   * that no closed turn answers (what was written since is left out, by the clock), else null.
   */
  function unanswered(subject) {
    if (subject.kind !== "remote" || subject.live) return null;
    const last = o.journal.saidOf(subject.scope).findLast((s) => s.kind === "prompt" && Number.isSafeInteger(s.at)), turns = o.journal.turnsOf(subject.scope);
    if (!last || turns.some((t) => (last.command_id && t.command_id === last.command_id) || t.ended_at >= last.at)) return null;
    return last.at;
  }

  /** Where what is closed ends in the newest transcript: before everything written since the running turn's words were taken. → an offset, or null: not known. */
  async function closedEnd(subject, opened, open) {
    const orphan = open ? null : unanswered(subject);
    // ... or written to a moment ago with no live record: cut at its last typed words, as a held desk session is (a clock that runs behind the file counts as a moment ago).
    const held = subject.held || (subject.kind === "remote" && !subject.live && !(o.now() - opened.at >= HELD_WINDOW_MS));
    if (!open && orphan === null && !held) return opened.size;
    // Exactly where the transcript stood when the turn's words were handed over (remote-turns.mjs transcriptMark), when it is this file and a line's start.
    const at = open ? subject.live?.turnMark : null;
    if (at && at.ref === subject.files.at(-1).ref && Number.isSafeInteger(at.size) && at.size >= 0 && at.size <= opened.size && atLineStart(opened.fd, at.size)) return at.size;
    // Otherwise by the clock: everything written since the words were taken (the journal's `said`, the hand-over, else the turn's start less five seconds).
    const taken = open ? o.journal.saidOf(subject.scope).findLast((s) => s.command_id && s.command_id === open.command_id)?.at ?? (Number.isSafeInteger(at?.at) ? at.at : open.started_at - 5_000) : orphan;
    let end = opened.size, done = false;
    const scan = await readBack(opened.fd, opened.size, { enough: (read) => {
      for (let i = read.length - 1; i >= 0 && !done; i -= 1) {
        const v = read[i].value, t = tsOf(v);
        if (taken !== null) { if (t !== null && t < taken) done = true; else if (t !== null) end = read[i].at; }
        else if (typedWords(v) && v.isSidechain !== true) { end = read[i].at; done = true; } // a held desk session: its last words onwards may still run
      }
      return done;
    } });
    // A running turn longer than one read can pass over, and no mark to cut it by: the transcript is not read at all (the journal answers).
    return done || scan.whole ? end : null;
  }

  /** What the journal adds to a transcript's items: who sent the words, how long an answer took, how a turn ended otherwise. */
  function withJournal(subject, entries, read, peek, phone, index, start, end) {
    if (subject.kind !== "remote") return entries;
    const said = o.journal.saidOf(subject.scope), turns = o.journal.turnsOf(subject.scope), ref = subject.files[index].ref, out = [...entries];
    for (const e of out) {
      const item = e.item;
      if (item.kind === "user" && item.at !== null) {
        const near = said.filter((s) => Math.abs(s.at - item.at) <= MATCH_MS && typeof s.text === "string" && (item.text.startsWith(s.text.trim().slice(0, 200)) || s.text.trim().startsWith(item.text.slice(0, 200)))).sort((a, b) => Math.abs(a.at - item.at) - Math.abs(b.at - item.at))[0];
        // Its words as the person sent them (the transcript's line also names where its attached files were put on this computer).
        if (near) e.item = { ...item, text: cutTo(near.text.trim(), P.HISTORY_MAX_TEXT).text, from: near.sender_device_id ? (near.sender_device_id === phone ? "this_device" : "other_device") : "computer", ...(P.isOpaqueId(near.command_id, "cmd") ? { command_id: near.command_id } : {}), ...(near.attachments > 0 ? { attachments: Math.min(99, near.attachments) } : {}) };
      } else if (item.kind === "answer" && item.at !== null && item.duration_ms === undefined) {
        const turn = turns.find((t) => t.started_at - 2_000 <= item.at && item.at <= t.ended_at + 2_000);
        if (turn && turn.ended_at >= turn.started_at) e.item = { ...item, duration_ms: turn.ended_at - turn.started_at };
      }
    }
    const stamped = [...read, ...peek].map((l) => ({ at: l.at, t: tsOf(l.value) })).filter((l) => l.t !== null);
    for (const turn of turns) {
      if (turn.outcome === "completed" || (turn.agent_ref && turn.agent_ref !== ref)) continue;
      const anchor = stamped.findLast((l) => l.t <= turn.ended_at + 500)?.at ?? (start === 0 && index === 0 && stamped.length ? -1 : null);
      if (anchor === null || anchor >= end || (anchor < start && anchor !== -1)) continue;
      const item = { id: P.historyItemId(subject.scope, `end:${turn.n}`, 0), kind: "end", at: turn.ended_at, outcome: P.HISTORY_ENDS.includes(turn.outcome) ? turn.outcome : "interrupted" };
      const place = out.findLastIndex((e) => e.line <= anchor);
      out.splice(place + 1, 0, { line: Math.max(anchor, 0), item });
    }
    // The first line written after the remote session began, where the transcript is older than that: continued from the desk.
    const since = subject.saved?.at, first = Number.isSafeInteger(since) ? stamped.findIndex((l) => l.t >= since) : -1;
    if (first > 0 && stamped[first - 1].t < since && index === 0) {
      const place = out.findIndex((e) => e.line >= stamped[first].at);
      if (place >= 0) out.splice(place, 0, { line: out[place].line, item: { id: P.historyItemId(subject.scope, "continued", 0), kind: "notice", at: since, notice: "continued_from_desk" } });
    }
    return out;
  }

  /** One page from the transcripts, or null when none can be read (the journal answers then). */
  async function fromTranscript(subject, payload, phone, base) {
    const last = subject.files.length - 1;
    let opened = last >= 0 ? openTranscript(subject, last) : null;
    if (!opened) return null;
    try {
      const open = openTurn(subject), newest = await closedEnd(subject, opened, open);
      if (newest === null) return null;
      const head = `t.${subject.files.length}.${newest}.${subject.kind === "remote" ? o.journal.turnsOf(subject.scope).length : 0}`;
      const common = { ...base, source: "transcript", head, open_turn: open };
      if (payload.known !== undefined && payload.known === head) return { ...common, status: "not_modified", items: [], next_before: null, older: "more" };
      let index = last, end = newest, status = "ok";
      const cursor = payload.before === null ? null : parseCursor(payload.before);
      if (payload.before !== null) {
        let held = false;
        if (cursor && cursor.index <= last) {
          const at = cursor.index === last ? opened : openTranscript(subject, cursor.index);
          held = Boolean(at) && cursorHolds(at.fd, at.size, cursor) && (cursor.index !== last || cursor.offset <= newest);
          if (held && at !== opened) { closePlain(opened); opened = at; } else if (!held && at && at !== opened) closePlain(at);
        }
        if (held) { index = cursor.index; end = cursor.offset; } else status = "stale";
      }
      const limit = index === last ? newest : opened.size, peek = readForward(opened.fd, end, limit, PEEK), closed = peek.ended;
      const map = (read, side = null) => mapTranscript(read, { scope: subject.scope, cwd: subject.projectPath, after: peek.lines, closed, side });
      const want = payload.item || payload.parent ? Infinity : Math.min(payload.max_bytes, P.HISTORY_PAGE_MAX_BYTES), wanted = payload.item ?? payload.parent ?? null;
      let entries = [], read = [];
      const scan = await readBack(opened.fd, end, { enough: (so) => { read = so; entries = map(so); return wanted ? entries.some((e) => e.item.id === wanted) : entries.length > ROOM_ITEMS || entries.reduce((n, e) => n + itemBytes(e.item), 0) > want; } });
      if (wanted) {
        const entry = entries.find((e) => e.item.id === wanted);
        if (!entry) return "not_found";
        if (payload.item) return { ...common, status, items: [entry.item], next_before: null, older: "start", item: wanted, detail: detailOf(entry) };
        return { ...common, status, ...sidePage(subject, opened, entry, limit, payload, index), parent: wanted };
      }
      const merged = withJournal(subject, entries, read, peek.lines, phone, index, scan.start, end);
      const from = fit(merged, want), start = from === 0 ? scan.start : merged[from].line;
      let next = null, older = "start";
      if (start > 0) { next = cursorAt(opened.fd, index, start, opened.size); older = "more"; }
      else if (index > 0) {
        // The agent session before this one, unless this transcript begins with the same line (a resume that copied it whole).
        const before = openTranscript(subject, index - 1);
        if (before) { if (firstUuid(before) !== firstUuid(opened)) { next = cursorAt(before.fd, index - 1, before.size, before.size); older = "more"; } closePlain(before); }
        else older = "trimmed";
      }
      return { ...common, status, items: merged.slice(from).map((e) => e.item), next_before: next, older };
    } finally { closePlain(opened); }
  }

  /** A subagent's own items: its file beside the transcript when Claude Code keeps one, else its lines inside the transcript. */
  function sidePage(subject, opened, entry, limit, payload, index) {
    if (entry.item.kind !== "subagent") return { items: [], next_before: null, older: "start" };
    if (!entry.raw?.agentId) return { items: [], next_before: null, older: "start" }; // Claude Code named no agent for it: nothing is guessed
    const agentId = entry.raw.agentId, ref = subject.files[index].file.replace(/\.jsonl$/, "");
    const beside = openPlainUnder(subject.store, join(ref, "subagents", `agent-${agentId}.jsonl`));
    let read;
    try { read = beside ? readForward(beside.fd, Math.max(0, beside.size - PEEK * 8), beside.size, PEEK * 8).lines : readForward(opened.fd, entry.line, limit, PEEK * 8).lines; } finally { closePlain(beside); }
    const steps = mapTranscript(read, { scope: subject.scope, cwd: subject.projectPath, closed: true, side: { parent: entry.item.id, agentId: beside ? null : agentId } });
    const from = fit(steps, Math.min(payload.max_bytes, P.HISTORY_PAGE_MAX_BYTES), P.HISTORY_MAX_ITEMS);
    return { items: steps.slice(from).map((e) => e.item), next_before: null, older: from > 0 ? "more" : "start" };
  }

  function fromJournal(subject, payload, phone, base) {
    const open = openTurn(subject), id = subject.scope;
    const { items, older } = journalHistory({ scope: id, said: o.journal.saidOf(id), turns: o.journal.turnsOf(id), events: o.journal.eventsAfter(id, 0), asker: phone, open, model: typeof subject.saved?.model === "string" && subject.saved.model ? subject.saved.model.slice(0, 128) : null });
    const head = `j.${items.length}.${items.length ? mark(items.at(-1).id) : "0"}`, common = { ...base, source: "journal", head, open_turn: open };
    if (payload.item || payload.parent) return "unsupported"; // the journal keeps no input, no output and no subagent's own steps
    if (payload.known !== undefined && payload.known === head) return { ...common, status: "not_modified", items: [], next_before: null, older: "more" };
    let end = items.length, status = "ok";
    if (payload.before !== null) {
      const m = JOURNAL_CURSOR.exec(payload.before), at = m ? Number(m[1]) : -1;
      if (m && at >= 1 && at <= items.length && mark(items[at - 1].id) === m[2]) end = at; else status = "stale";
    }
    const window = items.slice(0, end).map((item, line) => ({ line, item })), from = fit(window, Math.min(payload.max_bytes, P.HISTORY_PAGE_MAX_BYTES));
    return { ...common, status, items: window.slice(from).map((e) => e.item), next_before: from > 0 ? `v1.j.${from}.${mark(items[from - 1].id)}` : null, older: from > 0 ? "more" : older };
  }

  /** One ask. → "taken" once its page was sealed for `phone`, or the reason it is refused. Never for a phone not named. */
  function get(payload, phone, commandId) {
    if (!phone) return "not_allowed";
    // Busy is said BEFORE anything is looked up: an ask that is refused for load scans no folder and reads no record.
    if ((lines.get(phone)?.waiting ?? 0) >= MAX_WAITING || !mayAsk(phone)) return "busy";
    return inLine(phone, async () => {
      await o.room?.();
      // Resolved HERE, after the wait and right before the read (review 2026-11-17, F5): a project removed, the desk switch
      // turned off or a pause while the ask stood in line refuses it, and nothing is read on an answer that no longer holds.
      const subject = resolve(payload);
      if (typeof subject === "string") return subject;
      const base = { request: commandId, ...subject.name, live_seq: subject.kind === "remote" ? o.journal.lastSeq(subject.scope) : 0 };
      let page = null;
      try { page = await fromTranscript(subject, payload, phone, base); } catch { o.log("history_unreadable", {}); page = null; }
      if (page === null) page = subject.kind === "remote" ? fromJournal(subject, payload, phone, base) : "not_found";
      if (typeof page === "string") return page;
      // A page the protocol would refuse is never sealed and its ask never "taken" (review 2026-11-17, F7): the daemon would drop
      // it and the phone would wait on an acceptance that carries nothing. Refused instead, so the client says it could not load.
      const shaped = P.validateEventBody("history.page", page);
      if (!shaped.ok) { o.log("history_invalid", { code: String(shaped.code).slice(0, 32) }); return "busy"; }
      o.sealPage(page, phone);
      o.log("history_page", { source: page.source, status: page.status, items: page.items.length });
      return "taken";
    });
  }
  return { get, waiting: () => lines.size };
}
