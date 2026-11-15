/**
 * WORDS SENT WHILE A TURN RUNS (owner, 2026-11-07: "when I send a message while the agent is still busy, it is only picked
 * up minutes later; this must be visible in the app"). docs/remote-agents/PROTOCOL.md "Steering a running turn".
 *
 *   agent.prompt during a turn   waits in the session's queue; `command.queued { position, reason }` is sent when it
 *                                starts waiting and whenever its place changes, until command.agent_accepted (with
 *                                `received_at`, so the phone shows how long it waited on the computer).
 *   agent.prompt, interrupt      (only where the adapter reports `interrupt`) goes first in the queue and the running
 *                                turn is ended; that turn ends `agent.stopped`, never failed, and this prompt runs next.
 *   agent.steer, live adapter    goes INTO the running turn now: Claude Code reads a stream-json user message at its next
 *                                tool boundary (accepted when it replays the message, `isReplay`); Codex takes
 *                                `turn/steer` against the running turn's id (accepted on its answer). Both measured on this
 *                                computer (Claude Code 2.1.286, Codex 0.154.0). A steer that finds no running turn waits
 *                                as the next prompt.
 * Pure helpers over a session record `s`; the sessions module owns the agent processes.
 */
import * as P from "./remote-protocol.mjs";
import { agentOptionsOf } from "./remote-inventory.mjs";

/** Tell the phone where each waiting command stands, once per change of place. */
export function announceQueue(ctx, s, reason = "turn_running") {
  s.queue.forEach((item, i) => {
    if (item.position === i + 1 && item.reason === reason) return;
    item.position = i + 1; item.reason = reason;
    ctx.emit(s.session_id, "command.queued", { position: i + 1, reason }, item.command_id);
  });
}

/** A command is taken by the agent: the journal first, then the receipt with when it arrived and where it went. */
export function accept(ctx, s, item, landed, startedAt = null) {
  if (!item.command_id) return; // a release task's own turn: no command of the phone's to answer
  ctx.journal.advance(item.command_id, { kind: "agent_accepted" }, ctx.now());
  ctx.emit(s.session_id, "command.agent_accepted", { ...(startedAt !== null ? { started_at: startedAt } : {}), ...(Number.isSafeInteger(item.received_at) ? { received_at: item.received_at } : {}), landed }, item.command_id);
}

/**
 * A live steer into the running turn. → true when it went in (or is on its way), false when it must wait as a prompt.
 * It is accepted only when the agent shows it read the words (review 2026-11-07, P3-7): Claude Code's replay, Codex's
 * user-message item inside the turn (codexLanded), never the RPC's answer alone.
 */
export async function steerLive(ctx, s, item) {
  if (s.adapter === "codex") {
    s.steers.push(item);
    const r = await s.run.steer(item.text);
    if (!r.ok) s.steers.splice(s.steers.indexOf(item), 1);
    return r.ok;
  }
  s.steers.push(item); // Claude Code: accepted when it replays the message (claudeReplay)
  s.run.write(item.text);
  return true;
}

/** Codex put a steer's words into the turn (a later userMessage item): the oldest waiting steer is accepted. */
export function codexLanded(ctx, s) {
  const item = s.steers.shift();
  if (item) accept(ctx, s, item, "running_turn");
}

/**
 * Every command still waiting on this session is settled when its turn can no longer come (a stop, the agent's exit, a
 * task's session closing): journaled cancelled and told agent.stopped, so the phone never shows a place in a queue that
 * will not move (review 2026-11-07, P2-2).
 */
export function dropWaiting(ctx, s) {
  const items = [...s.queue.splice(0), ...s.steers.splice(0), ...(s.waiting ? [s.waiting] : [])];
  s.waiting = null;
  for (const item of items) {
    if (!item.command_id) continue;
    ctx.journal.advance(item.command_id, { kind: "cancelled" }, ctx.now());
    ctx.emit(s.session_id, "agent.stopped", {}, item.command_id);
  }
  return items.length;
}

/** Claude Code's replay of a user message (--replay-user-messages): the first waiting steer with these words landed. */
export function claudeReplay(ctx, s, line) {
  if (line?.type !== "user" || line.isReplay !== true || line.parent_tool_use_id) return;
  const words = (line.message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  const at = s.steers.findIndex((x) => x.text === words);
  if (at < 0) return;
  const [item] = s.steers.splice(at, 1);
  // A turn this computer did not start (no prompt was waiting for it) is the steer's own new turn: Claude Code read the
  // words after the turn they were sent into had ended (review 2026-11-07, P3-7).
  if (s.ownTurn === false) { s.command_id = item.command_id; accept(ctx, s, item, "new_turn"); return; }
  accept(ctx, s, item, "running_turn");
}

/** The end of a turn the person interrupted: it was stopped, not failed. → the event to send instead, or the event itself. */
export function interruptedEnd(ctx, s, event) {
  if (!s.interrupting || (event.type !== "agent.failed" && event.type !== "agent.stopped")) return event;
  s.interrupting = false;
  if (s.command_id) ctx.journal.advance(s.command_id, { kind: "cancelled" }, ctx.now());
  return { type: "agent.stopped", body: {} };
}

/** What the adapter reports for words sent mid-turn (the phone offers only this). */
export const steerModeOf = (report) => (report ? P.steerOffered(report.capabilities) : "none");
export const interruptOf = (report) => Boolean(report && P.interruptOffered(report.capabilities));

/**
 * ANOTHER MODEL OF THE SAME AGENT INSIDE A SESSION (release 33; owner, 2026-11-13: option A; docs/remote-agents/PROTOCOL.md
 * "A model is chosen per session"). An agent.prompt may carry `model`: one of the session's OWN adapter's listed models,
 * for that turn and the turns after it. Another agent is never a model (the payload names no adapter): it is a new chat,
 * with no hand-over. Verified per adapter from the adapters themselves (2026-11-14):
 *
 *   Claude Code  its own resume with another model flag: the idle process ends and starts again with
 *                `--resume <its own session id> --model <model>` (claudeArgs takes both; `--model` is "Model for the current
 *                session" in 2.1.322's help). NOT run against a live model here: the restart is proven on a fake Claude Code.
 *   Codex        `turn/start` carries `model`: "Override the model for this turn and subsequent turns" (the app-server's own
 *                JSON schema, `codex app-server generate-json-schema`, 0.154.0); the thread and its process stay.
 *   OpenCode     one process per run, `--session <id> --model <p/m>`: the next run takes the new model. NOT VERIFIED on a
 *                real install (OpenCode is not on the build machine), as the adapter itself says.
 *   terminal     no switch: nothing is typed into a terminal session that the phone composed (a `/model` would be one).
 *
 *   modelRefusal(ctx, s, model)            on receipt: null, or why the prompt is refused (it then runs nothing)
 *   switchModel(ctx, s, model, o)          at the turn's start: "now" (switched in place) or "later" (Claude Code restarts;
 *                                          o.respawn() then o.resumeTurns() run when its process is gone)
 *
 * The check is the protocol's own (checkModelSwitch) against the computer's CURRENT report and its own options, never the
 * phone's: a model the agent did not list, or a switch for an adapter whose options do not say `model_switch`, is refused.
 */
/** → null when the session may continue on `model`, else the reject reason (unsupported, unknown_model). */
export function modelRefusal(ctx, s, model) {
  const inv = ctx.inventory();
  const report = P.reportFor(inv.reports, s.adapter, "structured");
  const options = agentOptionsOf(inv).find((o) => o.adapter === s.adapter && o.mode === "structured") ?? null;
  return P.checkModelSwitch(model, report, options);
}

/**
 * Switch the session to `model` before its next turn. Codex and OpenCode take it in place (`run.setModel`). Claude Code's
 * process is idle here (a turn starts only when none is open), so it ends and comes back on its own session id with the new
 * model; the queue is held aside meanwhile and nothing waiting is dropped (`s.switching`, remote-sessions.mjs onExit).
 */
export function switchModel(ctx, s, model, o) {
  const record = () => { s.model = model; ctx.journal.recordSession({ session_id: s.session_id, model }); ctx.onSessionsChanged?.(); };
  if (typeof s.run?.setModel === "function") { s.run.setModel(model); record(); return "now"; }
  if (s.adapter !== "claude-code") throw new Error("this adapter has no model switch"); // modelRefusal kept it out
  s.switching = true;
  s.stopping = true;
  const held = s.queue.splice(0);
  (async () => {
    try {
      await s.run?.stop();
      s.stopping = false;
      record();
      o.respawn(); // spawnAgent(s, s.agent_ref): the ledger names the session first, then --resume <id> --model <model>
    } catch {
      s.stopping = false;
    }
    s.queue.unshift(...held, ...s.queue.splice(0)); // what arrived during the restart waits behind what was held
    s.switching = false;
    if (!s.run) dropWaiting(ctx, s); // the agent did not come back: what waited is cancelled, never left hanging
    o.resumeTurns();
  })();
  return "later";
}
