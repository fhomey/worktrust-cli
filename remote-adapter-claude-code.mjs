/**
 * THE CLAUDE CODE ADAPTER, STRUCTURED (2026-11-07). One managed process per remote session:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --permission-mode <the mode its help lists for "ask", or plan>
 *          --permission-prompt-tool mcp__worktrust_remote__approve --mcp-config <this session's file>
 *          [--model <a model the computer listed>] (--session-id <uuid chosen here> | --resume <the agent's own id>)
 *
 * in the granted project folder, in a process group of its own. Every argument comes from this file and the closed start
 * options the computer checked again (checkStart); no text from the phone becomes an argument except a resume id that is
 * a UUID. Prompts go in as stream-json user messages; Claude Code takes one turn at a time, so a prompt (or a steer) that
 * arrives mid-turn waits for the next turn and is accepted only when that turn begins. There is no pause: Claude Code has
 * none, the report says so, and a pause is refused. Stop interrupts the group (SIGINT), then ends it (SIGTERM, SIGKILL).
 * The approval tool is remote-approval-bridge.mjs, started by Claude Code itself from the MCP config written here.
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { PLAN_HINT } from "./remote-approval-bridge.mjs";

export const APPROVAL_TOOL = "mcp__worktrust_remote__approve";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isClaudeSessionId = (value) => typeof value === "string" && UUID.test(value);

/** The command line, from closed options only. Throws on anything else: nothing unchecked is passed through. */
/**
 * WHAT A REMOTE SESSION MAY NEVER DO, AS CLAUDE CODE'S OWN DENY RULES (review 2026-11-07, P1-c). The person's allow rules
 * and a repository's committed settings apply before the permission-prompt tool is asked, so a phone prompt could otherwise
 * push, install or deploy with no approval at all. Deny beats allow in Claude Code, so these are passed with
 * --disallowedTools; and --setting-sources user keeps a granted repository's own rules and hooks out of a remote session.
 */
export const REMOTE_DENY = Object.freeze([
  "Bash(git push:*)", "Bash(git push)", "Bash(git remote:*)", "Bash(npm install:*)", "Bash(npm i:*)", "Bash(npm ci:*)", "Bash(npm publish:*)", "Bash(npm exec:*)",
  "Bash(pnpm add:*)", "Bash(pnpm install:*)", "Bash(pnpm i:*)", "Bash(pnpm dlx:*)", "Bash(pnpm publish:*)", "Bash(yarn add:*)", "Bash(yarn install:*)", "Bash(yarn dlx:*)",
  "Bash(npx:*)", "Bash(bunx:*)", "Bash(bun add:*)", "Bash(bun install:*)", "Bash(pip install:*)", "Bash(pip3 install:*)", "Bash(pipx:*)", "Bash(uv pip:*)", "Bash(poetry add:*)",
  "Bash(brew:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(gem install:*)", "Bash(cargo install:*)", "Bash(go install:*)", "Bash(go get:*)",
  "Bash(vercel:*)", "Bash(netlify:*)", "Bash(fly:*)", "Bash(flyctl:*)", "Bash(firebase:*)", "Bash(heroku:*)", "Bash(wrangler:*)", "Bash(kubectl:*)", "Bash(helm:*)", "Bash(terraform:*)", "Bash(pulumi:*)", "Bash(eas:*)",
  "Bash(rm -rf:*)", "Bash(sudo:*)", "Read(**/.env)", "Read(**/.env.*)", "Read(~/.ssh/**)", "Read(**/*.pem)", "Read(**/*.key)", "Read(~/.aws/**)", "Read(~/.worktrust/**)",
  "Edit(~/.worktrust/**)", "Write(~/.worktrust/**)", "Edit(**/.env)", "Edit(**/.env.*)",
]);

/** The planning tools of the session's own MCP server (remote-approval-bridge.mjs): they only write a plan, so no prompt. */
export const PLAN_TOOLS = Object.freeze(["mcp__worktrust_remote__plan_release", "mcp__worktrust_remote__plan_task", "mcp__worktrust_remote__plan_list"]);
/** The one line the session's system prompt gains (owner, 2026-11-08: the agent arranges its own work); one text, the bridge's. */
export { PLAN_HINT };

export function claudeArgs({ features, mode, model, resume, sessionRef, mcpConfig }) {
  if (mode !== "ask" && mode !== "plan") throw new Error("the protocol offers the ask and plan modes only");
  const permission = mode === "plan" ? features.planMode : features.askMode;
  if (!permission) throw new Error("this Claude Code offers no such permission mode");
  if (resume !== null && !isClaudeSessionId(resume)) throw new Error("a resume id is Claude Code's own session uuid");
  if (resume === null && !isClaudeSessionId(sessionRef)) throw new Error("a new session needs its uuid");
  if (model !== null && (typeof model !== "string" || model.startsWith("-") || !/^[A-Za-z0-9._:@\[\]-]{1,128}$/.test(model))) throw new Error("not a model name");
  if (!features.disallowed || !features.settingSources) throw new Error("this Claude Code cannot take deny rules or limit its setting sources");
  // --replay-user-messages: Claude Code echoes each user message as it reads it (isReplay), which is how a live steer is
  // known to have entered the running turn (remote-steering.mjs; measured on 2.1.286: at the next tool boundary).
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(features.replay ? ["--replay-user-messages"] : []), "--permission-mode", permission, "--setting-sources", "user", "--disallowedTools", ...REMOTE_DENY,
    ...(features.allowed ? ["--allowedTools", ...PLAN_TOOLS] : []), ...(features.appendPrompt ? ["--append-system-prompt", PLAN_HINT] : []),
    "--permission-prompt-tool", APPROVAL_TOOL, "--mcp-config", mcpConfig, ...(features.partial ? ["--include-partial-messages"] : []), ...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : ["--session-id", sessionRef])];
}

/** The session's MCP config: our bridge only, its socket and its one-time token. Mode 0600, removed with the session. */
export function writeMcpConfig(file, { node, bridge, socket, token }) {
  writeFileSync(file, JSON.stringify({ mcpServers: { worktrust_remote: { command: node, args: [bridge], env: { WORKTRUST_REMOTE_APPROVAL_SOCKET: socket, WORKTRUST_REMOTE_APPROVAL_TOKEN: token } } } }), { mode: 0o600 });
  return file;
}

/** A user message on stdin, as Claude Code's stream-json input reads it. */
export const userMessage = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

export function startClaude({ file, cwd, env, args, onLine, onExit, onNoise = () => {} }) {
  const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  let buffer = "", exited = false, interrupts = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { buffer = ""; onNoise("line too long"); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw.trim()) continue;
      let line = null;
      try { line = JSON.parse(raw); } catch { onNoise("not JSON"); continue; }
      onLine(line);
    }
  });
  child.stderr.on("data", () => onNoise("stderr")); // never logged: it may hold the agent's words
  child.stdin.on("error", () => {});
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => { exited = true; onExit({ code, signal }); resolve({ code, signal }); }));
  child.on("error", () => { if (!exited) { exited = true; onExit({ code: null, signal: null, error: true }); } });
  const signal = (sig) => { try { if (process.platform === "win32") child.kill(sig); else process.kill(-child.pid, sig); } catch { /* gone */ } };
  return {
    pid: child.pid,
    alive: () => !exited,
    write: (text) => { if (!exited) child.stdin.write(userMessage(text)); },
    /**
     * End the running turn and keep the session: stream-json's control request (measured on 2.1.286: the turn ends
     * error_during_execution about 0.3 s later, the process stays, the next user message runs as a new turn).
     */
    interrupt: async () => { if (exited) return false; interrupts += 1; child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: `wt_interrupt_${interrupts}`, request: { subtype: "interrupt" } })}\n`); return true; },
    /** Interrupt, then end, the whole process group; resolves when it is gone. */
    async stop(graceMs = 3000) {
      if (exited) return;
      for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"]) {
        signal(sig);
        if (await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), graceMs))])) return;
      }
    },
    close: () => { try { child.stdin.end(); } catch { /* closed */ } },
  };
}

/** A session's file, gone; a session that never had one (a Codex run without the bridge) is no error that ends onExit early. */
export const removeQuietly = (file) => { if (typeof file === "string" && file) rmSync(file, { force: true }); };
