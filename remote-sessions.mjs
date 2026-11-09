/**
 * SEVERAL AGENT SESSIONS ON ONE COMPUTER (2026-11-07; owner: the phone prompts and manages several sessions). Each remote
 * session has its own session_id, project, agent and process; they run side by side up to a maximum (settings
 * max_sessions, default 4), are listed in device.inventory and status.report, can be attached (their journal replayed),
 * stopped and closed, and resume by the agent's own session id.
 *
 * Order inside a start, held by tests: the steered ledger names the agent's session id BEFORE the agent is spawned (owner
 * decision 1: a remote-steered session is never the person's AI Hours), then session.created, then the agent. A command
 * that starts a turn is AGENT_ACCEPTED only when Claude Code begins that turn (its init line), never when the prompt went in.
 */
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { appendSteered } from "./remote-steered.mjs";
import { adapterOf } from "./remote-inventory.mjs";
import { claudeArgs, isClaudeSessionId, removeQuietly, startClaude, writeMcpConfig } from "./remote-adapter-claude-code.mjs";
import { backgroundJobs, emptyClaudeState, endClaudeRun, mapClaudeLine } from "./remote-claude-events.mjs";
import { collectChanges, snapshotChanges } from "./remote-changes.mjs";
import { isCodexThreadId, startCodex } from "./remote-adapter-codex.mjs";
import { emptyCodexState, mapCodexMessage, unwrapShell } from "./remote-codex-events.mjs";
import { createCoalescer } from "./remote-coalesce.mjs";
import { accept, announceQueue, claudeReplay, codexLanded, dropWaiting, interruptedEnd, interruptOf, steerLive, steerModeOf } from "./remote-steering.mjs";
import { classifyAction } from "./remote-policy.mjs";
import { listSessions } from "./remote-session-list.mjs";

export const DEFAULT_MAX_SESSIONS = 4;
const LEDGER_EVERY_MS = 10 * 60_000;
const NO_ETA = { kind: "unavailable", source: "none", reason: "no_source" };

export { createCoalescer } from "./remote-coalesce.mjs"; // kept here for the modules that import it from sessions

export function createSessions(ctx) {
  const live = new Map(); // session_id -> session

  const attention = (s, activity, needs = null, finished = false) => {
    const prev = s.attention;
    const next = { activity, needs, state_change_seq: (prev?.state_change_seq ?? 0) + 1, completion_seq: finished ? (prev?.completion_seq ?? 0) + 1 : prev?.completion_seq ?? null };
    s.attention = next;
    ctx.emit(s.session_id, "agent.attention", next, s.command_id, P.notifyHint(prev, next));
  };
  const mark = (s) => s.agent_ref && appendSteered({ v: 1, steered: "remote", adapter: s.adapter, agent_session_ref: s.agent_ref, remote_session_id: s.session_id, project_id: s.project_id, how: s.how, first_steered_at: s.first, last_steered_at: ctx.now() });
  const advance = (s, kind) => { if (s.command_id) ctx.journal.advance(s.command_id, { kind }, ctx.now()); };

  function nextTurn(s) {
    // A Claude Code steer not yet read may become a turn of its own: the next prompt waits until it was (P3-7).
    if (s.turnOpen || s.queue.length === 0 || !s.run?.alive() || (s.adapter !== "codex" && s.steers.length > 0)) return;
    const item = s.queue.shift();
    s.waiting = item;
    s.turnOpen = true;
    s.run.write(item.text);
    announceQueue(ctx, s); // the ones still waiting moved up
  }

  /** A release's task ends with its turn (remote-releases.mjs), once. */
  const taskEnded = (s, outcome) => { if (s.task && !s.taskEnded) { s.taskEnded = true; ctx.onTaskEnded?.(s.session_id, outcome); } };

  /**
   * THE SESSION'S ACTIVE TIME (owner, 2026-11-08: Hours in the phone's session details): each turn's span from its start
   * (turnStartedAt, the clock the turn's own duration_ms is read from) to its end, summed over the session's turns, counted
   * once per turn and kept with the session in the journal. A turn that ended without a measured start makes the sum
   * unknown (null) from then on, and the field is left out: a part is never sent as the whole.
   */
  function withActive(s, body) {
    if (s.active !== null && s.countedTurn !== s.turnStartedAt) {
      const span = typeof body.duration_ms === "number" ? body.duration_ms : s.turnStartedAt !== null ? Math.max(0, ctx.now() - s.turnStartedAt) : s.turnOpen ? null : 0;
      s.active = span === null ? null : s.active + span;
      s.countedTurn = s.turnStartedAt;
      ctx.journal.recordSession({ session_id: s.session_id, active_ms: s.active });
    }
    return s.active === null ? body : { ...body, session_active_ms: s.active };
  }

  function send(s, event) {
    event = interruptedEnd(ctx, s, event); // a turn the person interrupted was stopped, not failed
    if (event.type === "agent.stopped" && s.stopping) return; // stop() sends its own
    if (event.type === "agent.completed" || event.type === "agent.failed" || event.type === "agent.stopped") event = { ...event, body: withActive(s, event.body) };
    if (event.type === "agent.stopped") taskEnded(s, "stopped");
    if (event.type === "agent.usage") s.tokens = event.body.session;
    if (event.type === "agent.subagent") s.subagents.set(event.body.subagent_id, { subagent_id: event.body.subagent_id, parent_id: event.body.parent_id, label: event.body.label, state: event.body.state, tokens_total: event.body.tokens.total });
    if (event.type === "agent.completed" && event.body.result) Object.assign(event.body.result, collectChanges(s.snapshot ?? { source: "agent_tools" }, s.projectPath, s.agentFiles ?? [], ctx.runDir));
    if (event.type === "agent.step_started") advance(s, "running");
    if (event.type === "agent.completed") advance(s, "completed");
    if (event.type === "agent.failed") advance(s, "failed");
    ctx.emit(s.session_id, event.type, event.body, s.command_id, event.type === "agent.completed" ? "finished" : "none");
    if (event.type === "agent.completed") taskEnded(s, "completed");
    if (event.type === "agent.failed") taskEnded(s, "failed");
    ctx.onActivity?.();
  }

  /** Tokens and a running subagent's counts at most once per two seconds (the latest wins); an end goes at once. */
  function deliver(s, event) {
    const go = () => send(s, event);
    if (event.type === "agent.usage") return event.body.turn_final ? s.coalesce.now("usage", go) : s.coalesce.offer("usage", go);
    if (event.type === "agent.subagent") return event.body.state === "working" ? s.coalesce.offer(`sag:${event.body.subagent_id}`, go) : s.coalesce.now(`sag:${event.body.subagent_id}`, go);
    if (event.type === "agent.completed" || event.type === "agent.failed") s.coalesce.flush();
    go();
  }

  /** What still waits goes out, then every subagent still open is stopped: the map never shows one working forever. */
  function endRun(s) {
    s.coalesce.flush();
    if (s.adapter === "codex") return; // Codex reports no subagents to close
    const end = endClaudeRun(s.state, ctx.now());
    s.state = end.state;
    for (const e of end.events) deliver(s, e);
  }

  function onLine(s, line) {
    claudeReplay(ctx, s, line); // a live steer Claude Code read: accepted now
    // Background jobs the agent reports (2026-11-08): a change in the count re-sends the project tree, nothing else.
    const jobs = backgroundJobs(s.jobs ?? null, line);
    if (jobs !== (s.jobs ?? null)) { const was = s.jobs?.size ?? null; s.jobs = jobs; if (jobs.size !== was) ctx.onSessionsChanged?.(); }
    const mapped = mapClaudeLine(s.state, line, (prefix = "stp") => P.mintId(prefix, ctx.random), ctx.now());
    s.state = mapped.state;
    // Claude Code wrote under another id than the ledger names (a forked resume, a new version): the ledger names that one
    // too before the turn is accepted, so its log is never read as the person's (review 2026-11-07, P2-c).
    if (mapped.state.sessionRef && mapped.state.sessionRef !== s.agent_ref) { s.agent_ref = mapped.state.sessionRef; mark(s); ctx.journal.recordSession({ session_id: s.session_id, agent_session_ref: s.agent_ref }); }
    if (line.type === "assistant") for (const b of line.message?.content ?? []) if (b?.type === "tool_use" && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(b.name) && typeof (b.input?.file_path ?? b.input?.notebook_path) === "string") s.agentFiles.push(b.input.file_path ?? b.input.notebook_path);
    afterMapped(s, mapped);
  }

  /**
   * Codex's app-server stream (remote-codex-events.mjs), through the same turn handling as Claude Code's. Codex runs the
   * reads it deems safe without asking, so a command that reads a secret path ends the turn here, on the computer, as it
   * starts (review 2026-11-07, P1-3; the person accepted that gap when they turned Codex on).
   */
  function onCodex(s, msg) {
    if (msg?.method === "item/started" && msg.params?.item?.type === "commandExecution" && classifyAction("codex", "Bash", { command: unwrapShell(msg.params.item.command ?? "") }, s.projectPath).action.class === "secret_read") {
      s.run.interrupt();
      ctx.emit(s.session_id, "agent.output_delta", { stream: "tool", offset: 0, text: "Stopped on the computer: the agent began to read a secret path (keys, .env, credentials)." }, s.command_id);
    }
    const mapped = mapCodexMessage(s.state, msg, (prefix = "stp") => P.mintId(prefix, ctx.random), ctx.now());
    s.state = mapped.state;
    if (mapped.landed) codexLanded(ctx, s);
    afterMapped(s, mapped);
  }

  function afterMapped(s, mapped) {
    if (mapped.turn === "started") s.ownTurn = Boolean(s.waiting);
    if (mapped.turn === "started" && !s.waiting && s.adapter === "codex" && s.steers.length > 0) { const item = s.steers.shift(); s.command_id = item.command_id; accept(ctx, s, item, "new_turn"); }
    if (mapped.turn === "started" && s.waiting) {
      const item = s.waiting;
      s.command_id = item.command_id; s.waiting = null;
      accept(ctx, s, item, "new_turn", mapped.state.turnStartedAt ?? null);
      attention(s, "working");
    }
    if (mapped.turn === "started") { s.turnOpen = true; s.snapshot = snapshotChanges(s.projectPath); s.agentFiles = []; s.turnStartedAt = mapped.state.turnStartedAt ?? ctx.now(); }
    for (const event of mapped.events) deliver(s, event);
    if (mapped.turn === "ended") {
      s.interrupting = false;
      s.turnOpen = false;
      if (s.jobs?.size) ctx.onSessionsChanged?.(); // "ready, but a job is still running": the tree hears the turn ended
      mark(s);
      attention(s, "idle", null, true);
      nextTurn(s);
    }
  }

  function onExit(s, how) {
    clearInterval(s.ledgerTimer);
    if (s.jobs?.size) { s.jobs = new Set(); ctx.onSessionsChanged?.(); } // its jobs ended with the agent's process group
    endRun(s);
    ctx.journal.recordSession({ session_id: s.session_id, pid: null });
    ctx.approvals.unregister(s.token);
    removeQuietly(s.mcpFile);
    if (s.turnOpen && !s.stopping) { advance(s, "failed"); ctx.emit(s.session_id, "agent.failed", { reason: "agent_exited", message: how.code === null ? null : `Claude Code exited (${how.code}).` }, s.command_id); taskEnded(s, "failed"); }
    if (!s.stopping) taskEnded(s, "failed"); // an agent that exits before its task's turn ended did not do the task
    s.turnOpen = false;
    s.run = null;
    dropWaiting(ctx, s); // a revived session never runs words sent to the agent that died
    ctx.onActivity?.();
  }

  /** Codex: the thread id reaches the ledger before its first turn (startCodex calls onThread before turn/start). */
  function spawnCodex(s, resume) {
    s.token = ctx.approvals.register(s); // so its open approvals are denied when it ends (P3-8)
    s.run = startCodex({ file: ctx.inventory().files.codex, cwd: s.projectPath, env: ctx.agentEnv(), model: s.model, mode: s.mode, resume,
      onMessage: (msg) => onCodex(s, msg), onExit: (how) => onExit(s, how),
      onThread: (id) => { s.agent_ref = id; mark(s); ctx.journal.recordSession({ session_id: s.session_id, agent_session_ref: id }); },
      approve: async (tool, input) => (await ctx.approvals.request(s, tool, input))?.behavior === "allow" });
    ctx.journal.recordSession({ session_id: s.session_id, pid: s.run.pid ?? null });
    s.ledgerTimer = setInterval(() => { if (s.turnOpen) mark(s); }, LEDGER_EVERY_MS);
    s.ledgerTimer.unref?.();
  }

  function spawnAgent(s, resume) {
    if (s.adapter === "codex") return spawnCodex(s, resume);
    const features = ctx.inventory().features["claude-code"];
    s.token = ctx.approvals.register(s);
    s.mcpFile = writeMcpConfig(join(ctx.runDir, `${s.session_id}.mcp.json`), { node: ctx.node, bridge: ctx.bridgePath, socket: ctx.socket(), token: s.token });
    const args = claudeArgs({ features, mode: s.mode, model: s.model, resume, sessionRef: s.agent_ref, mcpConfig: s.mcpFile });
    mark(s); // the ledger names the session before the agent writes a line
    s.run = startClaude({ file: ctx.inventory().files["claude-code"], cwd: s.projectPath, env: ctx.agentEnv(), args, onLine: (line) => onLine(s, line), onExit: (how) => onExit(s, how) });
    ctx.journal.recordSession({ session_id: s.session_id, pid: s.run.pid ?? null, agent_session_ref: s.agent_ref }); // a later daemon ends it if this one dies (P2-b)
    s.ledgerTimer = setInterval(() => { if (s.turnOpen) mark(s); }, LEDGER_EVERY_MS);
    s.ledgerTimer.unref?.();
  }

  function start(env, payload) {
    if (live.has(env.session_id) || ctx.journal.session(env.session_id)) return "conflict";
    if ([...live.values()].filter((s) => s.run).length >= (ctx.settings().max_sessions ?? DEFAULT_MAX_SESSIONS)) return "busy";
    const project = ctx.projects().find((p) => p.project_id === env.project_id);
    if (!project) return "not_found";
    const refused = P.checkStart(payload, adapterOf(ctx.inventory(), payload.adapter));
    if (refused) return refused;
    if (payload.adapter !== "claude-code" && payload.adapter !== "codex") return "unsupported";
    if (payload.resume !== null && !(payload.adapter === "codex" ? isCodexThreadId : isClaudeSessionId)(payload.resume)) return "unsupported";
    const s = { session_id: env.session_id, project_id: project.project_id, projectPath: project.path, adapter: payload.adapter, model: payload.model, mode: payload.permission_mode,
      agent_ref: payload.resume ?? (payload.adapter === "codex" ? null : randomUUID()), how: "started", first: ctx.now(), queue: [], state: payload.adapter === "codex" ? emptyCodexState() : emptyClaudeState(),
      coalesce: createCoalescer({ now: ctx.now }), attention: null, command_id: null, waiting: null, turnOpen: false, run: null, steers: [], interrupting: false, ownTurn: null, task: env.task === true, tokens: P.NO_TOKENS, subagents: new Map(), turnStartedAt: null, name: payload.name ?? null, active: 0, countedTurn: null };
    live.set(s.session_id, s);
    ctx.journal.recordSession({ session_id: s.session_id, adapter: s.adapter, project_id: s.project_id, agent_session_ref: s.agent_ref, model: s.model, mode: s.mode, at: ctx.now(), name: s.name, active_ms: 0 });
    ctx.emit(s.session_id, "session.created", { adapter: s.adapter, model: s.model, origin: "phone", title: null, project_label: basename(project.path).slice(0, 256) || null, name: s.name }, env.command_id);
    spawnAgent(s, payload.resume);
    if (payload.prompt) s.queue.push({ text: payload.prompt, command_id: env.command_id, received_at: ctx.now() });
    else { ctx.journal.advance(env.command_id, { kind: "agent_accepted" }, ctx.now()); ctx.emit(s.session_id, "command.agent_accepted", {}, env.command_id); attention(s, "idle"); }
    nextTurn(s);
    return null;
  }

  /** A known session whose agent is gone (a daemon restart) resumes by the agent's own id. */
  function revive(sessionId) {
    let s = live.get(sessionId);
    if (s?.run) return s;
    const saved = s ?? ctx.journal.session(sessionId);
    if (!saved || saved.closed) return null;
    const project = ctx.projects().find((p) => p.project_id === saved.project_id);
    const ref = s?.agent_ref ?? saved.agent_session_ref;
    if (!project || !(saved.adapter === "codex" ? isCodexThreadId : isClaudeSessionId)(ref)) return null;
    if ([...live.values()].filter((x) => x.run).length >= (ctx.settings().max_sessions ?? DEFAULT_MAX_SESSIONS)) return null;
    s = s ?? { session_id: sessionId, project_id: saved.project_id, projectPath: project.path, adapter: saved.adapter, model: saved.model ?? null, mode: saved.mode ?? "ask", agent_ref: ref, how: "started", first: ctx.now(), queue: [], state: saved.adapter === "codex" ? emptyCodexState() : emptyClaudeState(),
      coalesce: createCoalescer({ now: ctx.now }), attention: null, command_id: null, waiting: null, turnOpen: false, run: null, steers: [], interrupting: false, ownTurn: null, task: false, tokens: P.NO_TOKENS, subagents: new Map(), turnStartedAt: null, name: saved.name ?? null, active: saved.active_ms ?? null, countedTurn: null };
    live.set(sessionId, s);
    spawnAgent(s, s.agent_ref);
    return s;
  }

  async function stop(s) {
    if (!s.run) return;
    s.stopping = true;
    const command = s.command_id;
    await s.run.stop();
    endRun(s);
    s.stopping = false;
    if (command) ctx.journal.advance(command, { kind: "cancelled" }, ctx.now());
    ctx.emit(s.session_id, "agent.stopped", withActive(s, {}), command);
    taskEnded(s, "stopped");
    ctx.emit(s.session_id, "agent.output_delta", { stream: "tool", offset: 0, text: "Stopped. What the agent changed before the stop stays in the project: review it at the computer." }, command);
    dropWaiting(ctx, s);
    attention(s, "idle");
  }

  /**
   * A prompt or a steer (remote-steering.mjs): a live steer into the running turn; a prompt with interrupt ends that turn
   * and runs next; anything else waits its turn, and the phone is told its place (command.queued).
   */
  async function words(s, type, payload, command_id) {
    if (s.task) return "unsupported"; // a release task's session takes no words: add a task to the release instead (P2-2)
    const report = adapterOf(ctx.inventory(), s.adapter);
    const named = ctx.attachments ? ctx.attachments.referenceText(s.session_id, payload.attachments) : payload.attachments?.length ? null : ""; // null: refused, never ""
    if (named === null) return "not_found"; // a file it names is not here whole: never a prompt without its file
    const item = { text: payload.text + named, command_id, received_at: ctx.now() };
    if (type === "agent.steer" && steerModeOf(report) === "none") return "unsupported";
    mark(s);
    if (type === "agent.steer" && s.turnOpen && steerModeOf(report) === "live" && (await steerLive(ctx, s, item))) return null;
    if (type === "agent.prompt" && payload.interrupt === true && s.turnOpen) {
      if (!interruptOf(report)) return "unsupported";
      s.queue.unshift(item);
      s.interrupting = true;
      announceQueue(ctx, s, "interrupting");
      if (!(await s.run.interrupt())) s.interrupting = false; // nothing to end: it simply runs next (P3-6)
      return null;
    }
    s.queue.push(item);
    if (s.turnOpen) announceQueue(ctx, s);
    nextTurn(s);
    return null;
  }

  /** The agent's own plan as the denominator when it has one; otherwise the steps counted (never a percentage). */
  const progressOf = (s) => {
    const plan = P.planProgress(s.state.progress?.plan ?? null);
    return plan.kind === "measured" ? plan : { kind: "steps", started: s.state.started, completed: s.state.completed };
  };

  const statusOf = (s) => {
    const commands = ctx.journal.commandsOf(s.session_id).slice(-100);
    return { state: commands.at(-1)?.state ?? "DEVICE_RECEIVED", control: "none", attention: s.attention, last_event_seq: ctx.journal.lastSeq(s.session_id),
      progress: progressOf(s), eta: NO_ETA, pending_approvals: ctx.approvals.pendingOf(s.session_id).slice(0, 16), commands };
  };

  return {
    list: () => [...live.values()].filter((s) => !s.closed).map((s) => ({ session_id: s.session_id, project_id: s.project_id, adapter: s.adapter, origin: "phone", attention: s.attention ?? { activity: "unknown", needs: null, state_change_seq: 0, completion_seq: null }, title: null })),
    get: (id) => live.get(id) ?? null,
    statusOf,
    onApprovalOpened: (id) => { const s = live.get(id); if (s) { advance(s, "waiting_approval"); attention(s, "needs_you", "approval"); } },
    onApprovalSettled: (id) => { const s = live.get(id); if (s && s.turnOpen) { advance(s, "approval_resolved"); attention(s, "working"); } },
    /** One session command → null when it was taken, or the reject reason. */
    async handle(env, payload) {
      const type = env.type;
      if (type === "agent.start") return start(env, payload);
      if (type === "agent.pause" || type === "agent.resume" || type === "session.focus" || type === "screen.read" || type === "question.answer") return type === "question.answer" ? "not_found" : "unsupported";
      if (type === "session.rename" && !live.has(env.session_id)) {
        // A session from the journal (closed, or before a restart) keeps its history and takes a new name all the same.
        if (!ctx.journal.session(env.session_id)) return "not_found";
        ctx.journal.recordSession({ session_id: env.session_id, name: payload.name });
        ctx.onSessionsChanged?.();
        return "taken";
      }
      const s = type === "agent.prompt" || type === "agent.steer" ? revive(env.session_id) : live.get(env.session_id);
      if (!s) return "not_found";
      if (type === "agent.prompt" || type === "agent.steer") return words(s, type, payload, env.command_id);
      if (type === "agent.stop") { await stop(s); return "taken"; }
      if (type === "status.get") { ctx.emit(s.session_id, "status.report", statusOf(s), env.command_id); return "taken"; }
      if (type === "session.attach") { ctx.replay(s.session_id, 0); return "taken"; }
      if (type === "session.rename") { s.name = payload.name; ctx.journal.recordSession({ session_id: s.session_id, name: s.name }); ctx.onSessionsChanged?.(); return "taken"; }
      if (type === "session.close") { await stop(s); s.closed = true; live.delete(s.session_id); ctx.journal.recordSession({ session_id: s.session_id, closed: true }); return "taken"; }
      return "unsupported";
    },
    /**
     * A release's task, started by the scheduler (remote-releases.mjs): the same start as the phone's agent.start (the
     * steered ledger before the agent, checkStart, the cap), with no command of its own. → null, or a reject reason.
     */
    startTask: (t) => start({ session_id: t.session_id, project_id: t.project_id, command_id: null, task: true }, { adapter: t.adapter, model: t.model, permission_mode: t.permission_mode, resume: t.resume, prompt: t.prompt, name: t.name ?? null }),
    /** The project tree (2026-11-07): every session this computer knows, as remote-session-list.mjs lists them. */
    listAll: () => listSessions(ctx, live),
    /** Stop a running task's turn (release.cancel_task) → false when its agent was already gone. */
    async stopTask(sessionId) { const s = live.get(sessionId); if (!s?.run) return false; await stop(s); return true; },
    /** A task's session ends with its task: the agent exits and the slot frees. Nothing more is sent on its stream. */
    async closeTask(sessionId) {
      const s = live.get(sessionId);
      if (!s) return;
      s.closed = true;
      dropWaiting(ctx, s);
      if (s.run) { s.stopping = true; await s.run.stop(); }
      live.delete(sessionId);
      ctx.journal.recordSession({ session_id: sessionId, closed: true });
    },
    runningCount: () => [...live.values()].filter((s) => s.run).length,
    /** The live feed's rows (live.ts), without the release mapping the scheduler adds. */
    activeList: () => [...live.values()].filter((s) => s.run && !s.closed).map((s) => {
      const open = [...s.subagents.values()].filter((a) => !P.isFinalSubagentState(a.state));
      return { session_id: s.session_id, project_id: s.project_id, adapter: s.adapter, activity: s.attention?.activity ?? "unknown", progress: progressOf(s), tokens: s.tokens,
        started_at: s.turnOpen ? s.turnStartedAt : null, subagents: open.slice(0, P.MAX_ACTIVE_SUBAGENTS), subagents_cut: open.length > P.MAX_ACTIVE_SUBAGENTS };
    }),
    async stopAll() { for (const s of live.values()) if (s.run) { s.stopping = true; await s.run.stop(500); } },
  };
}
