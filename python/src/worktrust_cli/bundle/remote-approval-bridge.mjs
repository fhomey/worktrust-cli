#!/usr/bin/env node
/**
 * THE PERMISSION-PROMPT TOOL CLAUDE CODE CALLS IN A REMOTE SESSION (2026-11-07). A tiny MCP server on stdio, started by
 * Claude Code itself from the --mcp-config the daemon wrote for one session (`--permission-prompt-tool
 * mcp__worktrust_remote__approve`). Claude Code calls it whenever the person's own permission rules would have asked; the
 * person's allow and deny rules still apply first, at the desk's settings.
 *
 * It decides nothing. It forwards each request ({ tool_name, input, tool_use_id }) over the daemon's local socket
 * (~/.worktrust/remote/run/, this user only), with the session's one-time token, and answers what the daemon answers:
 *   { "behavior": "allow", "updatedInput": <the input, unchanged> }   only after a signed phone approval of that exact input
 *   { "behavior": "deny", "message": "<why>" }                         everything else, including any failure here
 * Fail closed: no daemon, a lost socket, a malformed answer or six minutes without one is a denial. This is not the
 * WorkTrust MCP door and opens no network connection. It also carries the agent's PLANNING tools (plan_release,
 * plan_task, plan_list; 2026-11-08), answered by the daemon's release queue for the session's own project.
 */
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export const TOOL = "approve";
const SOCKET = process.env.WORKTRUST_REMOTE_APPROVAL_SOCKET ?? "";
const TOKEN = process.env.WORKTRUST_REMOTE_APPROVAL_TOKEN ?? "";
const WAIT_MS = 6 * 60_000;
const deny = (message) => ({ behavior: "deny", message });

/** Ask the daemon; any failure is a denial. */
export function askDaemon(request, socket = SOCKET, token = TOKEN, waitMs = WAIT_MS) {
  return new Promise((resolve) => {
    if (!socket || !token) { resolve(deny("WorkTrust remote: no approval channel for this session; denied")); return; }
    let settled = false, buffer = "";
    const done = (answer) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.destroy(); } catch { /* closed */ } resolve(answer); };
    const conn = createConnection(socket);
    const timer = setTimeout(() => done(deny("WorkTrust remote: no decision in time; denied")), waitMs);
    conn.on("connect", () => conn.write(`${JSON.stringify({ token, ...request })}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) { done(deny("WorkTrust remote: malformed answer; denied")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let answer = null;
      try { answer = JSON.parse(buffer.slice(0, end)); } catch { answer = null; }
      if (answer?.behavior === "allow" && answer.updatedInput && typeof answer.updatedInput === "object") done({ behavior: "allow", updatedInput: answer.updatedInput });
      else done(deny(typeof answer?.message === "string" ? answer.message.slice(0, 2000) : "WorkTrust remote: denied"));
    });
    conn.on("error", () => done(deny("WorkTrust remote: the daemon is not reachable; denied")));
    conn.on("close", () => done(deny("WorkTrust remote: the daemon closed the request; denied")));
  });
}

/** A planning call over the same socket: the daemon's answer ({ ok, ... }), or a refusal on any failure. */
export function askPlan(op, args, socket = SOCKET, token = TOKEN, waitMs = 30_000) {
  return new Promise((resolve) => {
    const refuse = (reason) => ({ ok: false, reason });
    if (!socket || !token) { resolve(refuse("no planning channel for this session")); return; }
    let settled = false, buffer = "";
    const done = (answer) => { if (settled) return; settled = true; clearTimeout(timer); try { conn.destroy(); } catch { /* closed */ } resolve(answer); };
    const conn = createConnection(socket);
    const timer = setTimeout(() => done(refuse("no answer in time")), waitMs);
    conn.on("connect", () => conn.write(`${JSON.stringify({ token, plan: { op, args } })}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) { done(refuse("malformed answer")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let answer = null;
      try { answer = JSON.parse(buffer.slice(0, end)); } catch { answer = null; }
      done(answer && typeof answer === "object" && typeof answer.ok === "boolean" ? answer : refuse("malformed answer"));
    });
    conn.on("error", () => done(refuse("the daemon is not reachable")));
    conn.on("close", () => done(refuse("the daemon closed the request")));
  });
}

/**
 * THE PLANNING TOOLS (owner, 2026-11-08: the agent arranges its own work, the phone shows it on Status). Short on
 * purpose: their descriptions travel with every turn. The project is the session's own; nothing here runs anything.
 */
const n = (description) => ({ type: "integer", description });
const PLAN_TOOLS = [
  { name: "plan_release", op: "release", description: "Plan multi-step work as a release on the phone's Status: tasks you then do yourself. Check plan_list first.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, label: { type: "string", description: "short name, e.g. CLI 0.11.0" }, estimate_min: n("your estimate, minutes"), after: n("release number it waits for"),
      tasks: { type: "array", items: { type: "object", properties: { title: { type: "string" }, estimate_min: n("minutes") }, required: ["title"] } } }, required: ["title"] } },
  { name: "plan_task", op: "task", description: "Add a task to a release, or report yours: running, done or failed (note: one line).",
    inputSchema: { type: "object", properties: { release: n("release number, to add"), title: { type: "string" }, estimate_min: n("minutes"), task_id: { type: "string" }, state: { type: "string", enum: ["running", "done", "failed"] }, note: { type: "string" } } } },
  { name: "plan_list", op: "list", description: "This project's open releases and tasks.", inputSchema: { type: "object", properties: {} } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const error = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);

export async function handle(message, ask = askDaemon, plan = askPlan) {
  const { id, method, params } = message ?? {};
  if (method === "initialize") return { id, result: { protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "worktrust-remote", version: "1" } } };
  if (method === "ping") return { id, result: {} };
  if (method === "tools/list") return { id, result: { tools: [{ name: TOOL, description: "WorkTrust remote: asks the person's confirmed phone to approve one permission request, or denies it.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } },
    ...PLAN_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))] } };
  if (method === "tools/call") {
    const planTool = PLAN_TOOLS.find((t) => t.name === params?.name);
    if (planTool) {
      const answer = await plan(planTool.op, params.arguments && typeof params.arguments === "object" ? params.arguments : {});
      return { id, result: { content: [{ type: "text", text: JSON.stringify(answer) }], ...(answer?.ok ? {} : { isError: true }) } };
    }
    if (params?.name !== TOOL) return { id, error: { code: -32602, message: "unknown tool" } };
    const a = params.arguments ?? {};
    const answer = typeof a.tool_name === "string" && a.input && typeof a.input === "object"
      ? await ask({ tool_name: a.tool_name, input: a.input, tool_use_id: typeof a.tool_use_id === "string" ? a.tool_use_id : null })
      : deny("WorkTrust remote: malformed permission request; denied");
    return { id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } };
  }
  if (id === undefined) return null; // a notification
  return { id, error: { code: -32601, message: "method not found" } };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const answer = await handle(message);
    if (!answer) return;
    if (answer.error) error(answer.id, answer.error.code, answer.error.message); else reply(answer.id, answer.result);
  });
}
