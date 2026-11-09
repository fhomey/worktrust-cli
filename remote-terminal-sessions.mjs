/**
 * TERMINAL SESSIONS, BESIDE THE STRUCTURED ONES (release 19, 2026-11-09). A terminal session is Claude Code, interactive,
 * in a tmux session on WorkTrust's own socket (remote-adapter-terminal.mjs): started from a phone (`agent.start` with
 * `mode: "terminal"`) or at the desk (`worktrust remote terminal start`), seen on both, attached at the desk with
 * `worktrust remote attach <id>`. It outlives the daemon: a restart finds it again by its name, and stopping the daemon
 * never ends it.
 *
 * The rules this file holds (test-remote-terminal):
 *   - OFF unless the person turned it on at the keyboard (`worktrust remote terminal on`, settings.terminal): no report,
 *     no start, no desk session listed. A session it already knows stays its own (never revived as a structured one).
 *   - The steered ledger names the agent's session BEFORE tmux starts it (a phone start), and BEFORE the first word a phone
 *     types into a desk session. Reading a desk session's screen is not steering it and writes nothing.
 *   - A desk session is offered only in a granted project folder and only when it carries its agent's session id
 *     (@worktrust_ref): a session the ledger could not name is never steered.
 *   - Nothing is typed unless the adapter reports prompts AND the screen's state says idle (promptAllowed); a typed prompt
 *     is accepted only when that state is seen to change afterwards (PROTOCOL.md, delivery rule 5). In this slice no
 *     screen detector exists, so the report says `prompt: false` and every prompt is refused.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as P from "./remote-protocol.mjs";
import { appendSteered } from "./remote-steered.mjs";
import { terminalClaudeArgs, terminalTextOk, tmuxNameOf } from "./remote-adapter-terminal.mjs";
import { createScreenApprovals } from "./remote-screen-approvals.mjs";
import { createScreenPush } from "./remote-screen-push.mjs";

const UNKNOWN = Object.freeze({ activity: "unknown", needs: null, state_change_seq: 0, completion_seq: null });
const NO_ETA = { kind: "unavailable", source: "none", reason: "no_source" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TERMINAL_POLL_MS = 2000;
/** With control mode, a change is looked at this long after tmux reported it (a burst of output is one look). */
export const CONTROL_DEBOUNCE_MS = 150;
/** With control mode alive, the poll still looks at each session every this many rounds (a missed event costs 10 s). */
const CONTROL_SAFETY_ROUNDS = 5;
const CONTROL_TRIES = 3;
const STOP_GRACE_MS = 1500;

// ctx: { journal, now, emit, settings(), projects(), inventory() (offered), tmux, claudeFile(), replay, onSessionsChanged?,
//        running() (structured sessions running), detect?(lines) -> { activity, needs } | null, sleep?(ms), markLedger?,
//        approvals? (remote-approvals.mjs: screen dialogs), control? (false: never control mode, the poll only),
//        pushMs?, followMs?, setTimer?, clearTimer? (remote-screen-push.mjs, for tests) }
export function createTerminalSessions(ctx) {
  const live = new Map();
  let desk = [];
  let recovered = false;
  const on = () => ctx.settings().terminal === true;
  const markLedger = ctx.markLedger ?? appendSteered;
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const report = () => ctx.inventory().reports.find((r) => r.adapter === "claude-code" && r.mode === "terminal") ?? null;
  const push = createScreenPush({ now: ctx.now, emit: ctx.emit, pushMs: ctx.pushMs, followMs: ctx.followMs, setTimer: ctx.setTimer, clearTimer: ctx.clearTimer });
  const screen = ctx.approvals ? createScreenApprovals({ approvals: ctx.approvals, emit: ctx.emit, tmux: ctx.tmux, report, agent: "claude-code" }) : null;
  const projectAt = (path) => ctx.projects().find((p) => p.path === path) ?? null;
  const owns = (id) => live.has(id) || ctx.journal.session(id)?.terminal === true || desk.some((d) => d.session_id === id);
  const advance = (id, kind) => { if (id) ctx.journal.advance(id, { kind }, ctx.now()); };
  const mark = (s) => { markLedger({ v: 1, steered: "remote", adapter: "claude-code", agent_session_ref: s.agent_ref, remote_session_id: s.session_id, project_id: s.project_id, how: s.how, first_steered_at: s.first, last_steered_at: ctx.now() }); s.steered = true; };

  function attention(s, activity, needs = null) {
    const prev = s.attention;
    if (prev && prev.activity === activity && prev.needs === needs) return false;
    const next = { activity, needs, state_change_seq: (prev?.state_change_seq ?? 0) + 1, completion_seq: prev?.completion_seq ?? null };
    s.attention = next;
    ctx.emit(s.session_id, "agent.attention", next, s.command_id, P.notifyHint(prev, next));
    return true;
  }

  const sessionOf = (fields) => ({ adapter: "claude-code", attention: null, command_id: null, closed: false, stopping: false, pending: null, steered: false, name: null, model: null, first: ctx.now(), ...fields });
  const created = (s, command_id) => ctx.emit(s.session_id, "session.created", { adapter: "claude-code", model: s.model, origin: s.origin, title: null, project_label: basename(s.projectPath).slice(0, 256) || null, name: s.name, mode: "terminal" }, command_id);

  function close(s) {
    s.closed = true;
    s.watch?.close(); clearTimeout(s.soon); push.stop(s);
    ctx.approvals?.withdraw(s.session_id, "the session ended");
    live.delete(s.session_id);
    ctx.journal.recordSession({ session_id: s.session_id, closed: true });
    ctx.onSessionsChanged?.();
  }

  async function start(env, payload) {
    if (!on()) return "unsupported";
    const refused = P.checkStart(payload, report() ?? undefined);
    if (refused) return refused;
    if (payload.prompt !== null) return "unsupported"; // nothing is typed until the screen's state is read
    if (live.has(env.session_id) || ctx.journal.session(env.session_id)) return "conflict";
    if (ctx.running() + live.size >= (ctx.settings().max_sessions ?? 4)) return "busy";
    const project = ctx.projects().find((p) => p.project_id === env.project_id);
    if (!project) return "not_found";
    if (payload.resume !== null && !UUID.test(payload.resume)) return "unsupported";
    const s = sessionOf({ session_id: env.session_id, project_id: project.project_id, projectPath: project.path, name: payload.name ?? null, model: payload.model, origin: "phone", how: "started",
      tmux: tmuxNameOf(env.session_id), agent_ref: payload.resume ?? randomUUID(), command_id: env.command_id });
    let argv;
    try { argv = [ctx.claudeFile(), ...terminalClaudeArgs({ features: ctx.inventory().features["claude-code"], mode: payload.permission_mode, model: payload.model, resume: payload.resume, sessionRef: s.agent_ref })]; } catch { return "unsupported"; }
    if (typeof argv[0] !== "string") return "unsupported";
    live.set(s.session_id, s);
    ctx.journal.recordSession({ session_id: s.session_id, adapter: "claude-code", terminal: true, origin: "phone", project_id: s.project_id, agent_session_ref: s.agent_ref, model: s.model, mode: payload.permission_mode, at: ctx.now(), name: s.name });
    mark(s); // the ledger names the agent's session before tmux starts it
    created(s, env.command_id);
    if (!(await ctx.tmux.start({ name: s.tmux, cwd: project.path, argv, ref: s.agent_ref }))) {
      advance(env.command_id, "failed");
      ctx.emit(s.session_id, "agent.failed", { reason: "adapter_error", message: null }, env.command_id);
      close(s);
      return null;
    }
    advance(env.command_id, "agent_accepted");
    ctx.emit(s.session_id, "command.agent_accepted", {}, env.command_id);
    attention(s, "unknown");
    watch(s);
    ctx.onSessionsChanged?.();
    return null;
  }

  /** A desk session the phone opened: known from now on (journal), read-only until a word is typed into it. */
  function adopt(d) {
    const project = projectAt(d.path);
    if (!project || !d.ref) return null;
    const s = sessionOf({ session_id: d.session_id, project_id: project.project_id, projectPath: project.path, origin: "desk", how: "attached", tmux: d.name, agent_ref: d.ref });
    live.set(s.session_id, s);
    desk = desk.filter((x) => x.session_id !== d.session_id);
    ctx.journal.recordSession({ session_id: s.session_id, adapter: "claude-code", terminal: true, origin: "desk", project_id: s.project_id, agent_session_ref: s.agent_ref, model: null, mode: "ask", at: ctx.now(), name: null });
    created(s, null);
    attention(s, "unknown");
    watch(s);
    return s;
  }

  async function stop(s) {
    s.stopping = true;
    await ctx.tmux.sendKey(s.tmux, "interrupt").catch(() => false);
    for (let waited = 0; waited < STOP_GRACE_MS; waited += 250) { if ((await ctx.tmux.state(s.tmux)).dead) break; await sleep(250); }
    await ctx.tmux.kill(s.tmux);
    advance(s.command_id, "cancelled");
    ctx.emit(s.session_id, "agent.stopped", {}, s.command_id);
    close(s);
  }

  function ended(s, state) {
    if (s.stopping) return;
    if (state.status === 0) ctx.emit(s.session_id, "agent.stopped", {}, s.command_id);
    else ctx.emit(s.session_id, "agent.failed", { reason: "agent_exited", message: state.status === null ? null : `The agent exited (${state.status}).` }, s.command_id);
    ctx.tmux.kill(s.tmux).catch(() => false); // the dead pane remain-on-exit kept to read its status
    close(s);
  }

  /**
   * What the screen says now (remote-screen-states.mjs). A prompt typed before is accepted only once the agent is SEEN
   * taking it afterwards: working, or waiting for the person; a change to unknown (the words still in the input line, a
   * redraw) proves nothing.
   */
  function seen(s, looked) {
    if (!looked) return;
    const changed = attention(s, looked.activity, looked.activity === "needs_you" ? looked.needs ?? "dialog" : null);
    if (changed && s.pending && s.attention.state_change_seq > s.pending.seq && (looked.activity === "working" || looked.activity === "needs_you")) {
      advance(s.pending.command_id, "agent_accepted");
      ctx.emit(s.session_id, "command.agent_accepted", {}, s.pending.command_id);
      s.command_id = s.pending.command_id;
      s.pending = null;
    }
  }

  /** One look at a session: its end, then what its screen says, then a dialog a phone may answer. Never two at once. */
  async function look(s) {
    if (s.looking) { s.again = true; return; }
    s.looking = true;
    try {
      do {
        s.again = false;
        const state = await ctx.tmux.state(s.tmux);
        if (!state.exists || state.dead) { ended(s, state); return; }
        // What the followers asked for, at least what the detector reads; a follower is pushed the screen when it changed.
        const want = push.linesFor(s);
        if (ctx.detect || want > 0) {
          const cap = await ctx.tmux.capture(s.tmux, Math.max(100, want));
          if (cap && ctx.detect) { seen(s, ctx.detect(cap.lines)); screen?.consider(s, cap.lines); }
          if (cap && want > 0) push.offer(s, cap.lines.length > want ? { lines: cap.lines.slice(-want), cut: true } : cap);
        }
      } while (s.again && !s.closed);
    } finally { s.looking = false; }
  }

  /** tmux's control mode says WHEN to look (remote-adapter-terminal.mjs control); without it the poll looks every round. */
  function watch(s) {
    if (ctx.control === false || s.closed || s.watch?.alive() || (s.tries ?? 0) >= CONTROL_TRIES) return;
    s.tries = (s.tries ?? 0) + 1;
    s.watch = ctx.tmux.control?.(s.tmux, (kind) => {
      if (kind === "exit") { look(s); return; }
      clearTimeout(s.soon);
      s.soon = setTimeout(() => look(s), CONTROL_DEBOUNCE_MS);
      s.soon.unref?.();
    }) ?? null;
  }

  async function poll() {
    if (!recovered) { recovered = true; await recover(); }
    for (const s of [...live.values()]) {
      watch(s);
      s.rounds = (s.rounds ?? 0) + 1;
      if (!s.watch?.alive() || s.rounds % CONTROL_SAFETY_ROUNDS === 0) await look(s);
    }
    const before = desk.map((d) => d.session_id).join(",");
    desk = on() ? (await ctx.tmux.list()).filter((d) => !d.dead && d.ref && !owns(d.session_id) && projectAt(d.path)) : [];
    if (desk.map((d) => d.session_id).join(",") !== before) ctx.onSessionsChanged?.();
  }

  /** After a restart: a known session whose tmux session is still there is live again; one that is gone is closed. */
  async function recover() {
    const ours = new Map((await ctx.tmux.list()).map((d) => [d.session_id, d]));
    for (const j of ctx.journal.sessions()) {
      if (j.terminal !== true || j.closed || live.has(j.session_id)) continue;
      const d = ours.get(j.session_id), project = ctx.projects().find((p) => p.project_id === j.project_id);
      if (!d || d.dead || !project) { ctx.journal.recordSession({ session_id: j.session_id, closed: true }); continue; }
      live.set(j.session_id, sessionOf({ session_id: j.session_id, project_id: project.project_id, projectPath: project.path, origin: j.origin ?? "phone", how: j.origin === "desk" ? "attached" : "started",
        tmux: d.name, agent_ref: j.agent_session_ref, model: j.model ?? null, name: j.name ?? null, attention: { ...UNKNOWN } }));
    }
  }

  async function words(s, type, payload, command_id) {
    if (!on() || !report()?.capabilities.prompt || type === "agent.steer" || payload.interrupt === true || payload.attachments?.length) return "unsupported";
    if (ctx.detect) { const cap = await ctx.tmux.capture(s.tmux, 100); seen(s, cap ? ctx.detect(cap.lines) : { activity: "unknown", needs: null }); } // the screen again, just before the keys
    if (!P.promptAllowed(s.attention)) return s.attention?.activity === "needs_you" ? "agent_blocked" : "busy";
    if (!terminalTextOk(payload.text)) return "unsupported"; // a control character is never typed
    mark(s); // the ledger names the session before a phone's word reaches it
    if (!(await ctx.tmux.sendText(s.tmux, payload.text)) || !(await ctx.tmux.sendKey(s.tmux, "enter"))) return "not_found";
    s.pending = { command_id, seq: s.attention.state_change_seq };
    return null;
  }

  const statusOf = (s) => {
    const commands = ctx.journal.commandsOf(s.session_id).slice(-100);
    return { state: commands.at(-1)?.state ?? "DEVICE_RECEIVED", control: "none", attention: s.attention, last_event_seq: ctx.journal.lastSeq(s.session_id),
      progress: { kind: "indeterminate" }, eta: NO_ETA, pending_approvals: [], commands };
  };
  const row = (s) => ({ session_id: s.session_id, project_id: s.project_id, adapter: "claude-code", mode: "terminal", origin: s.origin, attention: s.attention ?? UNKNOWN, title: null,
    name: s.name, model: s.model, state: s.attention?.activity === "working" ? "running" : "idle", last_activity_at: ctx.journal.lastAt(s.session_id) ?? s.first });

  return {
    owns, start, poll, statusOf,
    get: (id) => live.get(id) ?? null,
    runningCount: () => live.size,
    /** The daemon stops: its control clients go, the tmux sessions stay. */
    release() { for (const s of live.values()) { s.watch?.close(); clearTimeout(s.soon); } },
    rows: () => [...[...live.values()].map(row),
      ...desk.map((d) => ({ session_id: d.session_id, project_id: projectAt(d.path)?.project_id ?? null, adapter: "claude-code", mode: "terminal", origin: "desk", attention: UNKNOWN, title: null, name: null, model: null, state: "idle", last_activity_at: d.created_at }))],
    async handle(env, payload) {
      const type = env.type;
      let s = live.get(env.session_id) ?? null;
      if (type === "session.rename") { if (!s && !ctx.journal.session(env.session_id)) return "not_found"; if (s) s.name = payload.name; ctx.journal.recordSession({ session_id: env.session_id, name: payload.name }); ctx.onSessionsChanged?.(); return "taken"; }
      if (!s && type === "session.attach" && on()) { const d = desk.find((x) => x.session_id === env.session_id); if (d) s = adopt(d); }
      if (!s) return "not_found";
      if (type === "session.attach") { ctx.replay(s.session_id, 0); return "taken"; }
      if (type === "screen.read") {
        push.follow(s, env.sender_device_id, payload.follow, payload.lines); // remote-screen-push.mjs
        const cap = await ctx.tmux.capture(s.tmux, payload.lines);
        if (!cap) return "not_found";
        ctx.emit(s.session_id, "agent.screen", cap, env.command_id);
        push.answered(s, cap);
        return "taken";
      }
      if (type === "status.get") { ctx.emit(s.session_id, "status.report", statusOf(s), env.command_id); return "taken"; }
      if (type === "agent.stop" || type === "session.close") { await stop(s); return "taken"; }
      if (type === "agent.prompt" || type === "agent.steer") return words(s, type, payload, env.command_id);
      if (type === "question.answer") return "not_found";
      return "unsupported"; // pause, resume, focus (tmux cannot raise a window: the phone shows `worktrust remote attach <id>`)
    },
  };
}

/**
 * One registry for the daemon: terminal sessions answered by their own module, every other one by remote-sessions.mjs.
 * The daemon stopping ends the structured agents and never a terminal session (it lives in tmux, perhaps at the desk).
 */
export function withTerminal(structured, terminal, { pollMs = TERMINAL_POLL_MS } = {}) {
  const timer = setInterval(() => { terminal.poll().catch(() => {}); }, pollMs);
  timer.unref?.();
  const merged = () => {
    const rows = terminal.rows(), ids = new Set(rows.map((r) => r.session_id));
    const rest = structured.listAll().filter((r) => !ids.has(r.session_id)).map((r) => (terminal.owns(r.session_id) ? { ...r, mode: "terminal" } : r));
    return [...rows, ...rest].sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
  };
  return {
    ...structured,
    async handle(env, payload) {
      if (env.type === "agent.start") return payload.mode === "terminal" ? terminal.start(env, payload) : structured.handle(env, payload);
      return terminal.owns(env.session_id) ? terminal.handle(env, payload) : structured.handle(env, payload);
    },
    list: () => [...structured.list().filter((r) => !terminal.owns(r.session_id)), ...terminal.rows()],
    listAll: merged,
    get: (id) => structured.get(id) ?? terminal.get(id),
    statusOf: (s) => (terminal.get(s.session_id) === s ? terminal.statusOf(s) : structured.statusOf(s)),
    runningCount: () => structured.runningCount() + terminal.runningCount(),
    async stopAll() { clearInterval(timer); terminal.release?.(); await structured.stopAll(); },
  };
}
