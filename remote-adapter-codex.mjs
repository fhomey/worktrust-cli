/**
 * THE CODEX ADAPTER (2026-11-07; docs/remote-agents/PROTOCOL.md "Steering a running turn"). Codex runs as
 * `codex app-server` (JSON-RPC over stdio, Codex 0.154.0), one process per remote session, no shell between us and it.
 *
 *   initialize, initialized               once
 *   thread/start | thread/resume          the session (resume by the agent's own thread id); its id reaches `onThread`
 *                                         BEFORE the first turn starts, so the steered ledger names it first
 *   turn/start                            a prompt
 *   turn/steer { expectedTurnId }         words into the RUNNING turn: measured on 0.154.0, they enter it at the next
 *                                         item boundary (a running command finishes first) and the turn's answer heeds them
 *   turn/interrupt                        end the running turn; the thread stays (measured: 0.7 s to `interrupted`)
 *   item/.../requestApproval              Codex asks: classified by the computer's own policy as Bash or Edit actions;
 *                                         only an approvable class reaches the phone, everything else is declined here
 * The approval policy is `untrusted` and the sandbox `workspace-write` (`read-only` in the plan mode): Codex asks before
 * anything it does not already trust, and never writes outside the project on its own. No free argument reaches Codex.
 */
import { spawn } from "node:child_process";
import { changePaths, codexApprovalAsTool, refusalFor } from "./remote-codex-events.mjs";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCodexThreadId = (value) => typeof value === "string" && THREAD.test(value);

/**
 * The fixed command line. The person's own Codex config stays (its model, its notify hook), but a remote session never
 * widens the sandbox or reaches a configured MCP server (review 2026-11-07, P2-1): no extra writable roots, no network in
 * the sandbox, no mcp_servers. MCP servers a Codex PLUGIN brings still start (measured on 0.154.0); that is part of the
 * risk the person accepts when they turn Codex on (`worktrust remote codex on`).
 */
export function codexArgs() {
  return ["app-server", "--config", "sandbox_workspace_write.network_access=false", "--config", "sandbox_workspace_write.writable_roots=[]", "--config", "mcp_servers={}"];
}

/** thread/start or thread/resume parameters from the protocol's closed options. */
export function threadParams({ cwd, model, mode, resume }) {
  if (mode !== "ask" && mode !== "plan") throw new Error("the protocol offers the ask and plan modes only");
  if (model !== null && !MODEL.test(model)) throw new Error("not a model name");
  if (resume !== null && !isCodexThreadId(resume)) throw new Error("a resume id is Codex's own thread id");
  const common = { cwd, approvalPolicy: "untrusted", sandbox: mode === "plan" ? "read-only" : "workspace-write", ...(model ? { model } : {}) };
  return resume ? { method: "thread/resume", params: { threadId: resume, ...common } } : { method: "thread/start", params: common };
}

const text = (t) => [{ type: "text", text: t }];

/**
 * o: { file, cwd, env, model, mode, resume, onMessage(msg), onThread(threadId), onExit(how), approve(tool, input) → Promise<boolean> }.
 * → { pid, alive, write(text), steer(text) → Promise<{ ok }>, interrupt() → Promise<boolean>, stop(), close() }.
 */
export function startCodex(o) {
  const child = spawn(o.file, codexArgs(), { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  let buffer = "", exited = false, nextId = 1, threadId = null, turnId = null, ready = false;
  const waiting = new Map(), queue = [], fileChanges = {};
  const send = (msg) => { if (!exited) child.stdin.write(`${JSON.stringify(msg)}\n`); };
  const call = (method, params) => new Promise((resolve) => { if (exited) { resolve({ error: { message: "codex exited" } }); return; } const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
  const turn = (t) => call("turn/start", { threadId, input: text(t) });
  async function answer(msg) {
    const asks = msg.method === "item/permissions/requestApproval" ? null : codexApprovalAsTool(msg.method, msg.params, fileChanges, o.cwd);
    let allowed = false;
    if (asks) { allowed = true; for (const a of asks) if (!(await o.approve(a.tool, a.input))) { allowed = false; break; } }
    send({ id: msg.id, result: { decision: allowed ? "accept" : refusalFor(msg.params) } });
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { buffer = ""; return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id !== undefined && msg.method === undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); continue; }
      if (msg.id !== undefined && typeof msg.method === "string") { answer(msg).catch(() => send({ id: msg.id, result: { decision: refusalFor(msg.params) } })); continue; }
      if (msg.method === "turn/started") turnId = msg.params?.turn?.id ?? turnId;
      if (msg.method === "turn/completed") turnId = null;
      if (msg.method === "item/started" && msg.params?.item?.type === "fileChange") fileChanges[msg.params.item.id] = changePaths(msg.params.item.changes);
      o.onMessage(msg);
    }
  });
  child.stderr.on("data", () => {}); // never logged: it may hold the agent's words
  child.stdin.on("error", () => {});
  // A call never hangs on a Codex that is gone: every one waiting is answered with an error (review 2026-11-07, P2-3).
  const settle = () => { for (const [id, resolve] of waiting) resolve({ id, error: { message: "codex exited" } }); waiting.clear(); };
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => { exited = true; settle(); o.onExit({ code, signal }); resolve(); }));
  child.on("error", () => { if (!exited) { exited = true; settle(); o.onExit({ code: null, signal: null, error: true }); } });
  (async () => {
    await call("initialize", { clientInfo: { name: "worktrust-remote", version: "1" } });
    send({ method: "initialized" });
    const { method, params } = threadParams({ cwd: o.cwd, model: o.model, mode: o.mode, resume: o.resume });
    const started = await call(method, params);
    threadId = started.result?.thread?.id ?? null;
    if (!isCodexThreadId(threadId)) { child.kill("SIGTERM"); return; }
    o.onThread(threadId); // the ledger names the thread before its first turn
    ready = true;
    for (const t of queue.splice(0)) turn(t);
  })().catch(() => child.kill("SIGTERM"));
  const signal = (sig) => { try { if (process.platform === "win32") child.kill(sig); else process.kill(-child.pid, sig); } catch { /* gone */ } };
  return {
    pid: child.pid,
    alive: () => !exited,
    threadId: () => threadId,
    write: (t) => { if (ready) turn(t); else queue.push(t); },
    /** Words into the running turn, guarded by its id: a turn that just ended refuses them, and they wait for the next. */
    async steer(t) { if (!ready || !turnId) return { ok: false }; const r = await call("turn/steer", { threadId, expectedTurnId: turnId, input: text(t) }); return { ok: !r.error }; },
    async interrupt() { if (!ready || !turnId) return false; const r = await call("turn/interrupt", { threadId, turnId }); return !r.error; },
    async stop(graceMs = 3000) {
      if (exited) return;
      if (turnId) await Promise.race([this.interrupt(), new Promise((r) => setTimeout(r, 1000))]);
      for (const sig of ["SIGTERM", "SIGKILL"]) { signal(sig); if (await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), graceMs))])) return; }
    },
    close: () => { try { child.stdin.end(); } catch { /* closed */ } },
  };
}

/** What `codex --version` and its help say this Codex can do; the app-server's methods are fixed per version. */
export function codexReport(version, appServerHelp) {
  const v = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  const usable = Boolean(v) && /generate-json-schema|--listen/.test(appServerHelp ?? "") && (Number(v[1]) > 0 || Number(v[2]) >= 154);
  return { usable, capabilities: usable ? { start: true, prompt: true, steer: true, steer_mode: "live", interrupt: true, stop: true, structured_events: true, resume_by_id: true, permission_modes: ["ask", "plan"], approvals: "structured" } : null };
}
