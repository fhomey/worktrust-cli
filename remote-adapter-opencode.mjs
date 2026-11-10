/**
 * THE OPENCODE ADAPTER (owner, 2026-11-09: steer OpenCode, and through it Qwen on Ollama, from Remote Agent). OpenCode runs as
 * `opencode run --format json`, ONE PROCESS PER RUN, no shell between us and it; read from OpenCode's source
 * (anomalyco/opencode packages/cli/src/commands/commands.ts, run/run.ts, run/noninteractive.ts, session-target.ts; the
 * permission docs; read 2026-11-09). NOT VERIFIED on a real install: OpenCode is not on the build machine; the tests run a
 * fake of that shape, and the inventory offers OpenCode only when its own `run --help` names every flag used here.
 *
 *   --session <id>      "Session ID to continue, or to create if it does not exist": the id is minted HERE, in OpenCode's
 *                       own shape (`ses_` + 26), so the steered ledger names the session before OpenCode writes a line
 *   --format json       one JSON line per event (remote-opencode-events.mjs maps them)
 *   --model <p/m>       the model, exactly as `opencode models` listed it (Qwen through Ollama is `ollama/qwen3:…`, OpenCode's
 *                       own provider configuration; nothing here knows Ollama)
 *   --agent plan        the plan mode: OpenCode's read-only agent, and edits denied by the run's own config besides
 *   the prompt          on stdin, never in argv: a prompt that begins with "-" is never read as a flag
 *
 * APPROVALS. A non-interactive run cannot ask: OpenCode REJECTS every permission request (unless --auto, which is never
 * passed, nor --yolo or --dangerously-skip-permissions) and tells the model so. The run's own config, inline through
 * OPENCODE_CONFIG_CONTENT (above the project's opencode.json in OpenCode's order, beside the agents' own), asks for every
 * command, edit, fetch, search and subagent, denies paths outside the project and the secret files Claude Code's deny rules
 * name. So anything outside the computer's policy is refused BY OPENCODE first; the adapter then hands each refused call
 * to `approve` (the computer's policy, then the phone, remote-approvals.mjs), and when one is approved runs ONE follow-up
 * in the same session and the same turn, with exactly that command or that file allowed, and says so to the agent. Never
 * an auto-approval, never a wildcard: a command or path that holds `*` or `?` is not carried (it would allow more).
 * Steering is queued (the next run takes it); interrupt is SIGINT, on which OpenCode cancels its session and exits.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,127}$/;
const SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const isOpenCodeSessionId = (value) => typeof value === "string" && SESSION.test(value);
/** The flags that make OpenCode approve by itself: never on our command line (check-remote-cli, rule D). */
export const OPENCODE_NEVER = Object.freeze(["--auto", "--yolo", "--dangerously-skip-permissions"]);
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A new session id as OpenCode mints one (packages/schema identifier.ts `descending`): newest sorts first, 14 random characters. */
export function mintOpenCodeSessionId(now = Date.now(), random = randomBytes) {
  const value = ~(BigInt(now) * 0x1000n + 1n);
  const time = Array.from({ length: 6 }, (_, i) => Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
  return `ses_${time}${Array.from(random(14), (byte) => BASE62[byte % 62]).join("")}`;
}

/** The fixed command line: no free argument reaches OpenCode, and the prompt goes on stdin. */
export function openCodeArgs({ sessionRef, model, mode }) {
  if (!isOpenCodeSessionId(sessionRef)) throw new Error("an OpenCode session id is ses_ and 26 characters");
  if (model !== null && !MODEL.test(model)) throw new Error("not a model name");
  if (mode !== "ask" && mode !== "plan") throw new Error("the protocol offers the ask and plan modes only");
  return ["run", "--format", "json", "--session", sessionRef, ...(model ? ["--model", model] : []), ...(mode === "plan" ? ["--agent", "plan"] : [])];
}

const SECRET_READS = ["*.env", "*.env.*", "*.envrc", "*.netrc", "*.npmrc", "*.pypirc", "*.git-credentials", "*.pem", "*.key", "*.p12", "*.pfx", "*id_rsa*", "*id_ed25519*", "*id_ecdsa*", "*credentials*", "*secret*"];
const noWildcard = (text) => typeof text === "string" && text.length > 0 && !/[*?]/.test(text);
/**
 * The run's own permission config. `allow`: the actions approved for this one run, each `{ tool: "Bash", command }` or
 * `{ tool: "Edit", path }` (relative to the project), allowed by their exact text on top of "ask". String values replace
 * whatever a person's or a repository's config set for the same key (OpenCode merges configs key by key).
 */
export function permissionConfig(mode, allow = []) {
  const read = Object.fromEntries([["*", "allow"], ...SECRET_READS.map((p) => [p, "deny"])]);
  const bash = allow.filter((a) => a.tool === "Bash" && noWildcard(a.command)), edit = allow.filter((a) => a.tool === "Edit" && noWildcard(a.path));
  const permission = { "*": "ask", read, glob: "allow", grep: "allow", list: "allow", todowrite: "allow", external_directory: "deny", question: "deny", doom_loop: "deny",
    bash: bash.length ? Object.fromEntries([["*", "ask"], ...bash.map((a) => [a.command, "allow"])]) : "ask",
    edit: mode === "plan" ? "deny" : edit.length ? Object.fromEntries([["*", "ask"], ...edit.map((a) => [a.path, "allow"])]) : "ask" };
  return { permission, agent: { build: { permission }, plan: { permission: { ...permission, edit: "deny" } } } };
}

const REFUSED = /cannot ask the user for permission/i; // OpenCode's own words to the model for a request this run rejected
const EDITS = new Set(["edit", "write", "patch", "multiedit"]);
/**
 * A tool call OpenCode refused because nobody could answer → the call as the computer's policy classifies it, or null.
 * Only a refusal is asked about; a call OpenCode's config denied outright (outside the project, a secret file) is not.
 */
export function openCodeRefusal(line, projectPath) {
  const part = line?.type === "tool_use" ? line.part : null;
  if (!part || part.state?.status !== "error" || !REFUSED.test(String(part.state?.error ?? ""))) return null;
  const input = part.state?.input && typeof part.state.input === "object" ? part.state.input : {};
  if (part.tool === "bash") return noWildcard(input.command) ? { tool: "Bash", input: { command: input.command }, carry: { tool: "Bash", command: input.command } } : null;
  if (EDITS.has(part.tool)) {
    const file = input.filePath ?? input.file_path ?? input.path;
    if (typeof file !== "string" || !file) return null;
    const absolute = isAbsolute(file) ? file : `${projectPath}/${file}`;
    let real = projectPath; try { real = realpathSync(projectPath); } catch { /* as given */ }
    const rel = [projectPath, real].map((root) => relative(root, absolute).split("\\").join("/")).find((r) => !r.startsWith("..") && !isAbsolute(r));
    if (rel === undefined || !noWildcard(rel)) return null;
    return { tool: part.tool === "write" ? "Write" : "Edit", input: { file_path: absolute }, carry: { tool: "Edit", path: rel } };
  }
  if (part.tool === "webfetch") return { tool: "WebFetch", input: { url: String(input.url ?? "") }, carry: null }; // never approvable: the phone hears why
  return null;
}
const followUp = (carried) => `The person approved on their phone what was refused a moment ago: ${carried.map((a) => (a.tool === "Bash" ? `run \`${a.command}\`` : `edit ${a.path}`)).join("; ")}. Do exactly that now, then continue the task.`;
const MAX_FOLLOW_UPS = 3;

/**
 * o: { file, cwd, env, model, mode, sessionRef, onMessage(line), onExit(how), approve(tool, input) → Promise<boolean> }.
 * → { pid, alive, write(text), interrupt() → Promise<boolean>, stop(), close() }. A turn is one run and its follow-ups;
 * onMessage hears each JSON line and `wt.turn_started` / `wt.turn_ended` around them.
 */
export function startOpenCode(o) {
  const args = openCodeArgs({ sessionRef: o.sessionRef, model: o.model, mode: o.mode });
  let child = null, closed = false, interrupted = false, busy = false, exited = false;
  const queue = [];
  const runOnce = (text, allow) => new Promise((resolve) => {
    const env = { ...o.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig(o.mode, allow)) };
    const run = child = spawn(o.file, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const asks = [];
    let buffer = "";
    run.stdout.setEncoding("utf8");
    run.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { buffer = ""; return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let line; try { line = JSON.parse(raw); } catch { continue; }
        o.onMessage(line);
        const refused = openCodeRefusal(line, o.cwd);
        if (refused) asks.push(Promise.resolve(o.approve(refused.tool, refused.input)).then((ok) => (ok && refused.carry ? refused.carry : null), () => null));
      }
    });
    run.stderr.on("data", () => {}); // never logged: it may hold the agent's words
    run.stdin.on("error", () => {});
    run.stdin.end(text);
    let done = false;
    const finish = (how) => { if (!done) { done = true; if (child === run) child = null; resolve({ ...how, asks }); } };
    run.on("exit", (code, signal) => finish({ code, signal }));
    run.on("error", () => finish({ code: null, signal: null, error: true }));
  });
  async function turn(text) {
    busy = true; interrupted = false;
    o.onMessage({ type: "wt.turn_started" });
    let prompt = text, allow = [], last = { code: null };
    for (let round = 0; round <= MAX_FOLLOW_UPS; round += 1) {
      last = await runOnce(prompt, allow);
      if (interrupted || closed || last.code !== 0) break;
      const carried = (await Promise.all(last.asks)).filter(Boolean); // an approval still open holds the turn, as it holds Claude Code's
      if (carried.length === 0 || interrupted || closed) break;
      allow = carried; prompt = followUp(carried);
    }
    busy = false;
    o.onMessage({ type: "wt.turn_ended", outcome: interrupted || closed ? "interrupted" : last.code === 0 ? "completed" : "failed" });
    if (!closed && queue.length > 0) turn(queue.shift());
  }
  const signal = (run, sig) => { try { if (process.platform === "win32") run.kill(sig); else process.kill(-run.pid, sig); } catch { /* gone */ } };
  const waitExit = (run, ms) => new Promise((resolve) => { if (run.exitCode !== null || run.signalCode !== null) { resolve(true); return; } const t = setTimeout(() => resolve(false), ms); run.once("exit", () => { clearTimeout(t); resolve(true); }); });
  async function halt(graceMs) {
    const run = child;
    if (!run) return;
    for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"]) { signal(run, sig); if (await waitExit(run, graceMs)) return; }
  }
  return {
    get pid() { return child?.pid ?? null; },
    alive: () => !closed,
    sessionRef: () => o.sessionRef,
    write: (t) => { if (closed) return; if (busy) queue.push(t); else turn(t); },
    /** End the running turn: OpenCode cancels its session's work on SIGINT and exits; the session stays for the next prompt. */
    async interrupt() { if (!child) return false; interrupted = true; await halt(3000); return true; },
    async stop(graceMs = 3000) {
      if (exited) return;
      closed = true; interrupted = true; queue.length = 0;
      await halt(graceMs);
      exited = true;
      o.onExit({ code: null, signal: null });
    },
    close() { return this.stop(); },
  };
}

/** What `opencode --version` and `opencode run --help` say this OpenCode can do: every flag above, read from its help, never assumed. */
export function openCodeReport(version, runHelp) {
  const h = runHelp ?? "";
  const usable = Boolean(String(version ?? "").trim()) && /--format\b[\s\S]{0,200}?\bjson\b/.test(h) && /--session\b[\s\S]{0,200}?create if it does not exist/i.test(h) && /--model\b/.test(h) && /--agent\b/.test(h);
  return { usable, capabilities: usable ? { start: true, prompt: true, steer: true, steer_mode: "queued", interrupt: true, stop: true, structured_events: true, resume_by_id: true, permission_modes: ["ask", "plan"], approvals: "structured" } : null };
}
