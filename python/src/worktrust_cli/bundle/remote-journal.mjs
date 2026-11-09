/**
 * THE COMMAND JOURNAL: AT MOST ONCE, AND NO LOST NEWS (2026-11-07, docs/remote-agents/PROTOCOL.md "At most once").
 *
 * ~/.worktrust/remote/journal.jsonl, mode 0600, one JSON record per line, each appended with O_APPEND and flushed to disk
 * (fsync) before the call returns. The rules it holds, with the protocol's own ledger functions (findCommand,
 * admitCommand, advanceCommand) over the records it reads back:
 *
 *   1. A command is written here BEFORE any agent is invoked for it (`admit` returns only after the fsync). The daemon's
 *      order, held by scripts/check-remote-cli.mjs: find, open, admit, receipt, then the agent.
 *   2. A duplicate (same id and bytes, or the same sender's idempotency key under another id) returns the stored entry:
 *      its receipts are sent again and nothing runs again. The same id with other bytes is a conflict.
 *   3. A command the journal holds in a non-final state when the daemon starts was interrupted: it is closed as FAILED
 *      (`interrupted`), never run again. A daemon killed between the journal write and the agent's start therefore never
 *      runs that command twice, and never silently.
 *   4. Every event the daemon sends is kept with its event_seq, so the stream continues where it was after a restart and
 *      a phone that attaches can be sent what it missed (`eventsAfter`).
 *   5. An approval decision is spent once, across restarts (`spend`).
 *   6. Releases, their tasks (a queued task's prompt until it starts) and pipeline runs (2026-11-07, PROTOCOL.md "Releases"),
 *      each written whole on every change, the latest record winning: a task is journaled `running` before its agent is
 *      started, so a restart closes it `interrupted` and never starts it twice. Compaction keeps every release (the
 *      backlog the phone scrolls back through) and the last 200 pipeline runs. The file is mode 0600, not encrypted.
 *
 * A torn last line (a crash mid-write) is skipped and counted; the journal is compacted above 8 MB to the last 500 events
 * per stream and a week of commands.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync, constants, chmodSync, rmSync } from "node:fs";
import * as P from "./remote-protocol.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_EVENTS = 500;
const KEEP_COMMANDS_MS = 7 * 24 * 3600_000;
const KEEP_PIPELINES = 200;
export const DEVICE_STREAM = "device";

function appendLine(file, record) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, `${P.canonicalJson(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

export function openJournal(file) {
  let ledger = P.emptyLedger();
  const meta = new Map(); // command_id -> { type, session_id, at }
  const events = new Map(); // stream -> [record]
  const seq = new Map(); // stream -> last event_seq
  const decided = new Set();
  const sessions = new Map();
  const releases = new Map(); // release_id -> its latest record
  const pipelines = new Map(); // pipeline_run_id -> its latest body
  let releaseOrder = [];
  const pipelinePids = new Map(); // pipeline_run_id -> { pid, file } of its running stage
  let unreadable = 0;

  const apply = (r) => {
    if (r.t === "cmd") {
      const admitted = P.admitCommand(ledger, { command_id: r.command_id, idempotency_key: r.idempotency_key, sender_device_id: r.sender_device_id, digest: r.digest }, r.state);
      if (admitted.verdict === "new") { ledger = admitted.ledger; meta.set(r.command_id, { type: r.type, session_id: r.session_id, at: r.at }); }
    } else if (r.t === "state") {
      const entry = ledger.entries[r.command_id];
      if (entry) ledger = { ...ledger, entries: { ...ledger.entries, [r.command_id]: { ...entry, state: r.state } } };
      if (entry && r.reason) meta.set(r.command_id, { ...meta.get(r.command_id), reason: r.reason });
    } else if (r.t === "event") {
      const stream = r.session_id ?? DEVICE_STREAM;
      const list = events.get(stream) ?? [];
      list.push(r);
      if (list.length > KEEP_EVENTS * 2) list.splice(0, list.length - KEEP_EVENTS);
      events.set(stream, list);
      seq.set(stream, Math.max(seq.get(stream) ?? 0, r.event_seq));
    } else if (r.t === "decided") decided.add(r.approval_id);
    else if (r.t === "session") sessions.set(r.session_id, { ...(sessions.get(r.session_id) ?? {}), ...r });
    else if (r.t === "release" && r.release?.release_id) releases.set(r.release.release_id, structuredClone(r.release)); // what was written, not the caller's live object
    else if (r.t === "pipeline" && r.pipeline?.pipeline_run_id) { pipelines.delete(r.pipeline.pipeline_run_id); pipelines.set(r.pipeline.pipeline_run_id, structuredClone(r.pipeline)); }
    else if (r.t === "release_order" && Array.isArray(r.ids)) releaseOrder = r.ids;
    else if (r.t === "pipeline_pid" && r.pipeline_run_id) pipelinePids.set(r.pipeline_run_id, { pid: r.pid, file: r.file });
  };

  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let record;
      try { record = JSON.parse(line); } catch { unreadable += 1; continue; }
      if (record && typeof record === "object" && typeof record.t === "string") apply(record); else unreadable += 1;
    }
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
  }
  const write = (record) => { appendLine(file, record); apply(record); };

  const journal = {
    file,
    get unreadable() { return unreadable; },
    find: (input) => P.findCommand(ledger, input),
    entry: (commandId) => ledger.entries[commandId] ?? null,
    meta: (commandId) => meta.get(commandId) ?? null,
    /** Rule 1: the command is on disk when this returns "new". */
    admit(input, { type, session_id, now }) {
      const admitted = P.admitCommand(ledger, input, "DEVICE_RECEIVED");
      if (admitted.verdict !== "new") return admitted;
      write({ t: "cmd", ...input, type, session_id, at: now, state: "DEVICE_RECEIVED" });
      return { verdict: "new", entry: ledger.entries[input.command_id] };
    },
    advance(commandId, input, now, reason = null) {
      const entry = ledger.entries[commandId];
      if (!entry) return null;
      const next = P.transition(entry.state, input);
      if (next.changed) write({ t: "state", command_id: commandId, state: next.state, at: now, ...(reason ? { reason } : {}) });
      return ledger.entries[commandId].state;
    },
    /** Rule 3: commands left mid-way by an earlier daemon. */
    interrupted: () => Object.values(ledger.entries).filter((e) => !P.isTerminal(e.state)).map((e) => e.command_id),
    commandsOf: (sessionId) => [...meta.entries()].filter(([, m]) => m.session_id === sessionId).map(([id]) => ({ command_id: id, state: ledger.entries[id].state })),
    nextSeq: (stream) => (seq.get(stream ?? DEVICE_STREAM) ?? 0) + 1,
    lastSeq: (stream) => seq.get(stream ?? DEVICE_STREAM) ?? 0,
    /** When the stream's latest kept event happened, or null: a session's "last run" on the phone's project tree. */
    lastAt: (stream) => (events.get(stream ?? DEVICE_STREAM) ?? []).reduce((at, e) => Math.max(at ?? 0, e.occurred_at ?? 0), null),
    recordEvent: (record) => write({ t: "event", ...record }),
    eventsAfter: (stream, after) => (events.get(stream ?? DEVICE_STREAM) ?? []).filter((e) => e.event_seq > after).sort((a, b) => a.event_seq - b.event_seq),
    isDecided: (approvalId) => decided.has(approvalId),
    decidedSet: () => new Set(decided),
    /** Rule 5. */
    spend: (approvalId, now) => { if (!decided.has(approvalId)) write({ t: "decided", approval_id: approvalId, at: now }); },
    recordSession: (record) => write({ t: "session", ...record }),
    session: (sessionId) => sessions.get(sessionId) ?? null,
    sessions: () => [...sessions.values()],
    /** Rule 6: on disk when this returns. */
    recordRelease: (release) => write({ t: "release", release }),
    releases: () => [...releases.values()],
    recordPipeline: (pipeline) => write({ t: "pipeline", pipeline }),
    /** Oldest first (by the order they were first written, an update keeping its place last). */
    pipelines: () => [...pipelines.values()].sort((a, b) => a.started_at - b.started_at),
    recordReleaseOrder: (ids) => write({ t: "release_order", ids }),
    /** The running stage's process, so a later daemon can end it (review 2026-11-07, P2-4). */
    recordPipelinePid: (pipeline_run_id, { pid, file }) => write({ t: "pipeline_pid", pipeline_run_id, pid, file }),
    pipelinePid: (pipelineRunId) => pipelinePids.get(pipelineRunId) ?? null,
    releaseOrder: () => [...releaseOrder],
    compact(now) {
      if (!existsSync(file) || statSync(file).size < MAX_BYTES) return false;
      const keepCmd = new Set([...meta.entries()].filter(([id, m]) => now - m.at < KEEP_COMMANDS_MS || !P.isTerminal(ledger.entries[id].state)).map(([id]) => id));
      const lines = [];
      for (const [id, m] of meta) if (keepCmd.has(id)) { const e = ledger.entries[id]; lines.push({ t: "cmd", command_id: id, idempotency_key: e.idempotency_key, sender_device_id: e.sender_device_id, digest: e.digest, type: m.type, session_id: m.session_id, at: m.at, state: e.state }); }
      for (const s of sessions.values()) lines.push({ t: "session", ...s });
      for (const id of decided) lines.push({ t: "decided", approval_id: id, at: now });
      for (const list of events.values()) for (const e of list.slice(-KEEP_EVENTS)) lines.push(e);
      for (const release of releases.values()) lines.push({ t: "release", release });
      for (const pipeline of journal.pipelines().slice(-KEEP_PIPELINES)) lines.push({ t: "pipeline", pipeline });
      if (releaseOrder.length > 0) lines.push({ t: "release_order", ids: releaseOrder });
      for (const p of journal.pipelines()) if (!P.isFinalPipelineState(p.state) && pipelinePids.has(p.pipeline_run_id)) lines.push({ t: "pipeline_pid", pipeline_run_id: p.pipeline_run_id, ...pipelinePids.get(p.pipeline_run_id) });
      const temporary = `${file}.${process.pid}.tmp`;
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
      try { writeSync(fd, lines.map((l) => `${P.canonicalJson(l)}\n`).join("")); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
      rmSync(temporary, { force: true });
      return true;
    },
  };
  return journal;
}
