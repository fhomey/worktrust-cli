/**
 * APPROVALS ON THE COMPUTER: CLASSIFIED HERE, DECIDED ONCE, FAIL CLOSED (2026-11-07; owner decision 6).
 *
 * Claude Code's permission-prompt tool (remote-approval-bridge.mjs) asks over a local socket in ~/.worktrust/remote/run/
 * (this user only) with its session's one-time token. Each request is classified by remote-policy.mjs. Only a class
 * `phoneMayDecide` admits becomes an agent.approval_required for the phone, with the exact input and its action hash;
 * every other request is denied here at once and the phone is told why (an agent.output_delta on the tool stream). Then:
 *   - a signed decision counts only from a CONFIRMED phone, for a pending approval, bound to its hash, in time, of an
 *     approvable class (verifyApprovalDecision), and is spent in the journal BEFORE the agent hears it;
 *   - no phone online means deny; no decision in five minutes means deny; a daemon that stops denies everything open.
 * This file is the only place that may send agent.approval_required (scripts/check-remote-cli.mjs holds it). The same
 * socket takes the session's planning calls (`{ token, plan: { op, args } }`, 2026-11-08) and hands them to ctx.plan,
 * the release queue's: they never reach the approval path and never run anything.
 */
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { classifyAction, phoneMayDecide } from "./remote-policy.mjs";

export const APPROVAL_LIFETIME_MS = 5 * 60_000;

export function createApprovals(ctx) {
  const byToken = new Map(); // token -> session
  const pending = new Map(); // approval_id -> { record, resolve, timer, session_id }
  let server = null;

  const deny = (message) => ({ behavior: "deny", message });
  const finish = (approvalId, answer) => {
    const open = pending.get(approvalId);
    if (!open) return;
    pending.delete(approvalId);
    clearTimeout(open.timer);
    open.resolve(answer);
    ctx.onApprovalSettled?.(open.session_id, approvalId);
  };

  /** One permission request from the bridge → the answer the bridge gives Claude Code. */
  async function request(session, toolName, input) {
    if (ctx.paused()) return deny("WorkTrust remote is paused on this computer; denied");
    const { action, reason } = classifyAction(session.adapter, toolName, input, session.projectPath);
    if (!phoneMayDecide(action)) {
      ctx.emit(session.session_id, "agent.output_delta", { stream: "tool", offset: 0, text: `Denied on the computer (${action.tool}): ${reason}` }, session.command_id);
      return deny(`WorkTrust remote: ${reason}`);
    }
    if (!ctx.phoneOnline()) return deny("WorkTrust remote: no confirmed phone is connected; denied");
    const approval_id = P.mintId("apr", ctx.random), expires_at = ctx.now() + APPROVAL_LIFETIME_MS;
    const action_hash = P.actionHash({ approval_id, session_id: session.session_id, project_id: session.project_id, adapter: session.adapter }, action);
    const record = { approval_id, session_id: session.session_id, computer_device_id: ctx.deviceId, action_hash, class: action.class, expires_at };
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => finish(approval_id, deny("WorkTrust remote: no decision in time; denied")), Math.max(0, expires_at - ctx.now()));
      pending.set(approval_id, { record, resolve, timer, session_id: session.session_id, input });
    });
    ctx.onApprovalOpened?.(session.session_id, approval_id);
    ctx.emit(session.session_id, "agent.approval_required", { approval_id, action, action_hash, expires_at }, session.command_id, "needs_you");
    return answer;
  }

  return {
    pendingOf: (sessionId) => [...pending.values()].filter((p) => p.session_id === sessionId).map((p) => p.record.approval_id),
    register(session) { const token = P.toBase64Url(ctx.random(24)); byToken.set(token, session); return token; },
    unregister(token) {
      const session = byToken.get(token);
      byToken.delete(token);
      if (session) for (const [id, p] of pending) if (p.session_id === session.session_id) finish(id, deny("WorkTrust remote: the session ended; denied"));
    },
    /** A signed decision from approval.decision. Spent before the agent hears it; a refusal leaves the action unapproved. */
    decide(token) {
      const checked = P.verifyApprovalDecision(token, {
        controllers: ctx.controllers(),
        pending: new Map([...pending].map(([id, p]) => [id, p.record])),
        decided: ctx.journal.decidedSet(),
        now: ctx.now(),
      });
      if (!checked.ok) return checked;
      const open = pending.get(checked.value.approval_id);
      ctx.journal.spend(checked.value.approval_id, ctx.now());
      finish(checked.value.approval_id, checked.value.decision === "approve" ? { behavior: "allow", updatedInput: open.input } : deny("WorkTrust remote: denied on your phone"));
      return checked;
    },
    denyAll() { for (const id of [...pending.keys()]) finish(id, deny("WorkTrust remote: the daemon stopped; denied")); },
    async listen(dir) {
      let path;
      if (process.platform === "win32") path = `\\\\.\\pipe\\worktrust-remote-${P.toBase64Url(ctx.random(12))}`;
      else {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        path = join(dir, "a.sock");
        rmSync(path, { force: true });
      }
      server = createServer((conn) => {
        let buffer = "";
        conn.setEncoding("utf8");
        conn.on("error", () => {});
        conn.on("data", async (chunk) => {
          buffer += chunk;
          if (buffer.length > 1_048_576) { conn.destroy(); return; }
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          let msg = null;
          try { msg = JSON.parse(buffer.slice(0, end)); } catch { msg = null; }
          buffer = "";
          const session = msg && byToken.get(msg.token);
          // A planning call (the bridge's plan_* tools): the session's own project, answered by the release queue.
          if (msg && msg.plan && typeof msg.plan === "object") {
            const planned = !session ? { ok: false, reason: "unknown session" } : typeof msg.plan.op !== "string" || !ctx.plan ? { ok: false, reason: "unsupported" } : await ctx.plan(session, msg.plan.op, msg.plan.args ?? {});
            conn.end(`${JSON.stringify(planned)}\n`);
            return;
          }
          const answer = !session || typeof msg.tool_name !== "string" || !msg.input || typeof msg.input !== "object"
            ? deny("WorkTrust remote: unknown session; denied")
            : await request(session, msg.tool_name, msg.input);
          conn.end(`${JSON.stringify(answer)}\n`);
        });
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return path;
    },
    close() { this.denyAll(); try { server?.close(); } catch { /* closed */ } },
    /** For tests: the request path without a socket. */
    request,
  };
}
