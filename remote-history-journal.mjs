/**
 * A SESSION'S HISTORY FROM THE REMOTE JOURNAL ALONE: ONE PURE FOLD (CLI 0.11.17; docs/remote-agents/CHAT-HISTORY.md §4.3,
 * slice 2a). The source for every session that has no transcript this computer can read: Codex and OpenCode (until their
 * own readers), a Claude Code session whose transcript is gone, and the words and endings a transcript never held.
 *
 *   journal record                              item
 *   said (start, prompt, steer, answer)         user {text, from: the asker, another device, or the computer; command}
 *   agent.output_delta, assistant               the words between two steps → text; before agent.completed → answer
 *   agent.step_started / agent.step_completed   step {label, kind, state, duration}; a failed step's reason → its output
 *   agent.subagent (a main agent's own)         subagent {label, type, state, steps, duration}, in place of its step
 *   agent.completed                             answer {the full answer when the result holds it}
 *   agent.failed / agent.stopped                end {failed + reason | stopped}
 *   a closed turn without an ending             end {interrupted}
 *
 * CLOSED TURNS ONLY: a turn is closed by its `turn` record; what the running turn said and did is the live stream's and is
 * never in a page. A step with no completion in a closed turn was `interrupted`. The journal keeps the last 500 events of
 * a session and 500 said and turn records for 30 days: a turn whose events are gone keeps its words and its ending, and
 * the page says `trimmed` where the first turn is no longer here. Nothing is read from disk here and nothing is written.
 */
import * as P from "./remote-protocol.mjs";
import { cutTo, sound } from "./remote-history-claude.mjs";

const STEP_END = { ok: "ok", failed: "failed", skipped: "interrupted" };
const SUB_END = { done: "ok", failed: "failed", stopped: "interrupted" };
const stepKind = (kind) => (P.HISTORY_STEP_KINDS.includes(kind) ? kind : "other");

function turnItems(scope, turn, events, model) {
  const items = [], steps = new Map(), subs = new Map();
  let words = "", wordsAt = null, wordsSeq = 0, ended = false;
  const flush = (kind, extra = {}) => {
    const text = words.trim();
    if (text) { const t = cutTo(text, P.HISTORY_MAX_TEXT); items.push({ id: P.historyItemId(scope, `text:${wordsSeq}`, 0), kind, at: wordsAt, text: t.text, ...(t.cut ? { cut: true } : {}), ...extra }); }
    words = ""; wordsAt = null;
  };
  for (const e of events) {
    const b = e.body ?? {};
    if (e.type === "agent.output_delta" && b.stream === "assistant") { if (!words) { wordsAt = e.occurred_at; wordsSeq = e.event_seq; } words = (words + b.text).slice(0, P.HISTORY_MAX_TEXT + 1); }
    else if (e.type === "agent.output_delta" && b.stream === "tool") {
      const failed = [...steps.values()].reverse().find((s) => s.state === "failed" && s.output === undefined);
      if (failed) { const o = cutTo(sound(b.text), P.HISTORY_MAX_PREVIEW); failed.output = o.text; if (o.cut) failed.more = true; }
    } else if (e.type === "agent.step_started" && !b.subagent_id) {
      flush("text");
      const item = { id: P.historyItemId(scope, b.step_id, 0), kind: "step", at: e.occurred_at, label: cutTo(b.label, P.HISTORY_MAX_LABEL).text, step: stepKind(b.kind), state: "interrupted" };
      steps.set(b.step_id, item); items.push(item);
    } else if (e.type === "agent.step_completed" && steps.has(b.step_id)) {
      const item = steps.get(b.step_id);
      item.state = STEP_END[b.outcome] ?? "interrupted";
      if (Number.isSafeInteger(b.duration_ms)) item.duration_ms = b.duration_ms;
    } else if (e.type === "agent.subagent" && b.parent_id === null) {
      // The main agent's own subagent stands where its step stood (a live chat shows the agent, not "Delegate ...").
      let item = subs.get(b.subagent_id);
      if (!item) {
        const at = steps.get(b.step_id), place = at ? items.indexOf(at) : -1;
        item = { id: P.historyItemId(scope, b.step_id ?? b.subagent_id, 0), kind: "subagent", at: at?.at ?? e.occurred_at, label: "Agent", state: "interrupted" };
        if (place >= 0) items[place] = item; else items.push(item);
        if (b.step_id) steps.delete(b.step_id);
        subs.set(b.subagent_id, item);
      }
      if (b.label) item.label = cutTo(b.label, P.HISTORY_MAX_LABEL).text;
      if (b.agent_type) item.agent_type = b.agent_type.slice(0, 64);
      if (SUB_END[b.state]) item.state = SUB_END[b.state];
      item.steps = Math.min(100_000, b.steps);
      if (Number.isSafeInteger(b.duration_ms)) item.duration_ms = b.duration_ms;
    } else if (e.type === "agent.completed") {
      const answer = typeof b.result?.answer === "string" && b.result.answer.trim() ? b.result.answer : null;
      if (answer) { words = answer; wordsAt = e.occurred_at; wordsSeq = e.event_seq; }
      else if (!words.trim() && typeof b.summary === "string") { words = b.summary; wordsAt = e.occurred_at; wordsSeq = e.event_seq; }
      flush("answer", { ...(model ? { model } : {}), ...(Number.isSafeInteger(b.duration_ms) ? { duration_ms: b.duration_ms } : {}) });
      ended = true;
    } else if (e.type === "agent.failed" || e.type === "agent.stopped") {
      flush("text");
      items.push({ id: P.historyItemId(scope, `end:${turn.n}`, 0), kind: "end", at: e.occurred_at, outcome: e.type === "agent.failed" ? "failed" : "stopped", ...(e.type === "agent.failed" && P.HISTORY_END_REASONS.includes(b.reason) ? { reason: b.reason } : {}) });
      ended = true;
    }
  }
  flush("text");
  // Its events are gone, or it never ended by itself: the turn record's own word on how it closed.
  if (!ended && turn.outcome !== "completed") items.push({ id: P.historyItemId(scope, `end:${turn.n}`, 0), kind: "end", at: turn.ended_at ?? null, outcome: P.HISTORY_ENDS.includes(turn.outcome) ? turn.outcome : "interrupted" });
  return items;
}

/** `nth`: how many earlier records share its key (words without a command taken in the same millisecond), so an id never depends on the list's length. */
const userItem = (scope, said, asker, nth) => {
  const t = cutTo(sound(said.text ?? ""), P.HISTORY_MAX_TEXT);
  return { id: P.historyItemId(scope, `said:${said.command_id ?? said.at}`, nth), kind: "user", at: Number.isSafeInteger(said.at) ? said.at : null, text: t.text, ...(t.cut || said.cut ? { cut: true } : {}),
    from: said.sender_device_id ? (said.sender_device_id === asker ? "this_device" : "other_device") : "computer",
    ...(P.isOpaqueId(said.command_id, "cmd") ? { command_id: said.command_id } : {}), ...(Number.isSafeInteger(said.attachments) && said.attachments > 0 ? { attachments: Math.min(99, said.attachments) } : {}) };
};

/**
 * `said`, `turns` (closed, by number) and `events` of one session, as the journal holds them; `asker`: the device that
 * asks; `open`: the running turn (`{ from_seq, started_at, command_id }`) or null; `model`: the session's.
 * → { items (oldest first, closed turns only), older: "start" | "trimmed" }.
 */
export function journalHistory({ scope, said, turns, events, asker, open = null, model = null }) {
  const closed = [...turns].sort((a, b) => a.n - b.n), items = [], used = new Set();
  const firstSeq = events.length ? events[0].event_seq : Infinity;
  const seen = new Map(), nth = said.map((s) => { const key = `${s.command_id ?? s.at}`, n = seen.get(key) ?? 0; seen.set(key, n + 1); return n; });
  const own = new Set(closed.map((t) => t.command_id).filter(Boolean));
  if (open?.command_id) own.add(open.command_id);
  let after = -Infinity;
  for (const turn of closed) {
    const until = turn.ended_at ?? Infinity;
    // The words that led to this turn or steered it: said since the turn before it closed, in the order they were taken.
    // Words that are a turn's own command belong to that turn whatever the clock says (a prompt taken in the millisecond the turn before ended).
    said.forEach((s, n) => { if (!used.has(n) && (s.command_id && own.has(s.command_id) ? s.command_id === turn.command_id : s.at > after && s.at <= until)) { used.add(n); items.push(userItem(scope, s, asker, nth[n])); } });
    items.push(...turnItems(scope, turn, events.filter((e) => e.event_seq >= turn.from_seq && e.event_seq <= turn.to_seq), model));
    after = until;
  }
  // Words no turn took (the agent never started on them) are closed too, unless a turn runs now: then they are its own.
  if (!open) said.forEach((s, n) => { if (!used.has(n) && !(s.command_id && own.has(s.command_id))) items.push(userItem(scope, s, asker, nth[n])); });
  const whole = closed.length === 0 ? true : closed[0].n === 1 && closed[0].from_seq >= firstSeq;
  return { items, older: whole ? "start" : "trimmed" };
}
