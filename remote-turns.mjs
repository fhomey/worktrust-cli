/**
 * WHAT WAS SAID, EACH TURN, AND HOW CLAUDE CODE IS STARTED AGAIN (2026-11-16, CLI 0.11.16; docs/remote-agents/
 * CHAT-HISTORY.md §4.2 and bug (c)). Called by remote-sessions.mjs; every write goes through the journal (0600).
 *
 *   said        the words of a start, a prompt or a steer, once the session TOOK them (never refused words): who sent
 *               them, under which command, when; the files sent with them as a count, never a name.
 *   turns       openTurn at the first line of a turn (its first event_seq), closeTurn when it ends: one `turn` record
 *               with its number, command, agent session, first and last event_seq, times and outcome (completed, failed
 *               or stopped, read from the events the turn journaled; interrupted when it left none). A turn a daemon
 *               died in has no record: a reader calls it interrupted.
 *   refs        every agent session the remote session ran in (`agent_refs`): a forked resume changes the one ref.
 *   withActive  the active time of the session (owner, 2026-11-08: Hours in the session details): each turn from its
 *               start to its end, summed, counted once per turn and kept with the session. A turn that ended without a
 *               measured start makes the sum unknown (null) from then on: a part is never sent as the whole.
 *
 * HOW CLAUDE CODE IS STARTED AGAIN (bug (c): the "Failed" of the owner, 2026-11-16). A session stopped before its first
 * turn has an id and no transcript: Claude Code only writes one with the first turn. The next prompt revived it with
 * `--resume <id>`, and Claude Code answered that no such conversation exists; the phone showed a failed turn, 0 tokens.
 * Measured on Claude Code 2.1.325 with a config folder of its own and no model call (2026-11-16):
 *     --resume <id never written>     one line on stdout, { type: "result", is_error: true, num_turns: 0,
 *                                     errors: ["No conversation found with session ID: <id>"] }, then exit 1
 *     --session-id <id with a file>   nothing on stdout; stderr "Error: Session ID <id> is already in use."; exit 1
 * So: `--resume` only once Claude Code wrote the session (`transcript_seen`, set at its first init line, or at the start
 * of a session continued from the desk; for a session journaled before 0.11.16, the transcript file itself), else
 * `--session-id` with the same id. And when Claude Code still refuses the start, the other way with the same id, ONCE,
 * the waiting words kept: nothing is failed for a start that was only asked the wrong way. One start is left to fail: a
 * session of the desk the phone asked to CONTINUE whose transcript is not there (a blank session is not that one).
 */
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "./remote-desk-sessions.mjs";

const END = { "agent.completed": "completed", "agent.failed": "failed", "agent.stopped": "stopped" };
const MAX_REFS = 20;

/** Words the session took. → the item, so a queue can take it in the same breath. */
export function said(ctx, s, kind, item, sender, text = item.text, attachments = 0) {
  ctx.journal.recordSaid?.({ session_id: s.session_id, command_id: item.command_id ?? null, sender_device_id: sender ?? null, kind, at: item.received_at ?? ctx.now(), text, ...(attachments > 0 ? { attachments } : {}) });
  return item;
}

/** The fields of a session record that name its agent session: the one now, and every one it ever ran in. */
export function refs(ctx, s) {
  const saved = ctx.journal.session(s.session_id);
  const known = saved?.agent_refs ?? (saved?.agent_session_ref ? [saved.agent_session_ref] : []);
  return { agent_session_ref: s.agent_ref, ...(s.agent_ref ? { agent_refs: known.includes(s.agent_ref) ? known : [...known, s.agent_ref].slice(-MAX_REFS) } : {}) };
}

export function openTurn(ctx, s, startedAt = null) {
  if (s.turn || !ctx.journal.recordTurn) return;
  s.turn = { n: (ctx.journal.turnsOf(s.session_id).at(-1)?.n ?? 0) + 1, from_seq: ctx.journal.nextSeq(s.session_id), started_at: startedAt ?? ctx.now() };
}

export function closeTurn(ctx, s) {
  const t = s.turn;
  if (!t) return;
  s.turn = null;
  const end = ctx.journal.eventsAfter(s.session_id, t.from_seq - 1).findLast((e) => Object.hasOwn(END, e.type));
  ctx.journal.recordTurn({ session_id: s.session_id, n: t.n, command_id: s.command_id ?? null, agent_ref: s.agent_ref ?? null, from_seq: t.from_seq, to_seq: ctx.journal.lastSeq(s.session_id), started_at: t.started_at, ended_at: ctx.now(), outcome: end ? END[end.type] : "interrupted" });
}

export function withActive(ctx, s, body) {
  if (s.active !== null && s.countedTurn !== s.turnStartedAt) {
    const span = typeof body.duration_ms === "number" ? body.duration_ms : s.turnStartedAt !== null ? Math.max(0, ctx.now() - s.turnStartedAt) : s.turnOpen ? null : 0;
    s.active = span === null ? null : s.active + span;
    s.countedTurn = s.turnStartedAt;
    ctx.journal.recordSession({ session_id: s.session_id, active_ms: s.active });
  }
  return s.active === null ? body : { ...body, session_active_ms: s.active };
}

/** Whether Claude Code holds a transcript of this session for this project: a regular file in its own store, never a link. */
export function transcriptExists(env, projectPath, ref, home = homedir()) {
  try { return lstatSync(join(env?.CLAUDE_CONFIG_DIR || join(env?.HOME || home, ".claude"), "projects", encodeProjectDir(projectPath), `${ref}.jsonl`)).isFile(); } catch { return false; }
}

/**
 * WHERE THE TRANSCRIPT STOOD WHEN A TURN'S WORDS WERE HANDED TO THE AGENT (CLI 0.11.17, remote-history.mjs): the agent
 * session and its file's size at that moment, so the history knows exactly where what is closed ends, however long the
 * running turn becomes. Size 0 where no transcript exists yet; null where the agent session is not known. Nothing is read.
 */
export function transcriptMark(env, projectPath, ref, home = homedir()) {
  if (typeof ref !== "string" || !ref) return null;
  try { const st = lstatSync(join(env?.CLAUDE_CONFIG_DIR || join(env?.HOME || home, ".claude"), "projects", encodeProjectDir(projectPath), `${ref}.jsonl`)); return st.isFile() ? { ref, size: st.size } : null; } catch { return { ref, size: 0 }; }
}

/** Claude Code answering a resume of a session it never wrote (measured, see the head of this file). */
export const noConversation = (line) => line?.type === "result" && line.is_error === true && Array.isArray(line.errors) && line.errors.some((e) => typeof e === "string" && e.startsWith("No conversation found with session ID"));

/**
 * → the `resume` of claudeArgs for this start: the id to resume, or null for `--session-id <s.agent_ref>`. `resume` is
 * null for a new session, else the session id of the agent itself (a desk session, a revival, a model switch). A start
 * of the session itself may take the other way once (otherWay); the one the other way forces takes no second.
 */
export function claudeResume(ctx, s, resume, exists = transcriptExists) {
  const forced = s.turnedTo ?? null;
  s.turnedTo = null; s.heard = 0; s.refused = false;
  if (!forced) s.turned = false;
  if (resume === null) { s.way = null; return null; }
  const seen = s.seen === true || ctx.journal.session(s.session_id)?.transcript_seen === true || exists(ctx.agentEnv(), s.projectPath, resume);
  s.way = forced ?? (seen ? "resume" : "fresh");
  return s.way === "resume" ? resume : null;
}

/** One line of Claude Code, before it is mapped. → true: its refusal to resume, kept from the phone (onExit starts it fresh). */
export function claudeHeard(ctx, s, line) {
  s.heard = (s.heard ?? 0) + 1;
  if (line?.type === "system" && line.subtype === "init" && !s.seen) {
    s.seen = true;
    if (ctx.journal.session(s.session_id)?.transcript_seen !== true) ctx.journal.recordSession({ session_id: s.session_id, transcript_seen: true });
  }
  // A session continued from the desk whose transcript is not there is NOT started blank in its place: that start fails, as it always did.
  if (s.way !== "resume" || s.turned || (s.how === "attached" && !s.seen) || !noConversation(line)) return false;
  s.refused = true;
  return true;
}

/** The process of the agent ended. → true when Claude Code only refused the START and the other way is due, once. */
export function otherWay(s, how) {
  if (s.adapter !== "claude-code" || s.stopping || s.closed || s.switching || s.turned || how?.error) return false;
  const to = s.refused ? "fresh" : s.way === "fresh" && s.heard === 0 && Number.isInteger(how?.code) && how.code !== 0 ? "resume" : null;
  if (!to) return false;
  s.turned = true; s.turnedTo = to;
  return true;
}
