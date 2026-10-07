/**
 * THE TRANSCRIPT READERS — the clients that do not write Claude Code's shape, read into it (2026-10-04).
 *
 * The counter (`count-behaviour.mjs`) and the session hook (`log-session.mjs`) both read other
 * clients' local logs as if they were Claude Code transcripts, so ONE rubric and ONE clock read them
 * all. The readers used to be one block of text copied into both files and held equal by a test;
 * both files had grown past the line ratchet, so the readers now live here, once, and both import
 * this file. It ships beside them: in the npm package, on the site (/counter/transcript-readers.mjs)
 * and in ~/.worktrust, where the hook's install copies it. Without it, both still run and read
 * Claude Code alone, and say so.
 *
 * Text is read here for the rubric and the layer and travels nowhere: what these yield goes to the
 * counter's named rules and the hook's measure(), whose payloads are fixed allowlists of numbers,
 * dates and enum values (log-session.mjs, "WHAT CANNOT LEAVE").
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── codex rollout reader ──
/**
 * A CODEX ROLLOUT, READ AS A TRANSCRIPT (2026-09-27). Codex keeps one JSONL per thread under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl: a session_meta line, then per turn a
 * turn_context (model, effort, cwd), response_items (messages, tool calls, their outputs) and a
 * token_usage_record per model response. On the machine this was built on five of them held 679
 * million tokens that nothing read. This turns the records into the lines Claude Code writes, so
 * ONE rubric and ONE clock read both:
 *   · a user or assistant message → a user or assistant line with a text part; the developer line
 *     and the harness's own user-role messages (<environment_context>, <recommended_plugins> and
 *     the like: a tag opening the text) are the harness, not the person, and are dropped;
 *   · a tool call → an assistant line with a tool_use part: `exec` becomes Bash with the command
 *     as input, `apply_patch` an Edit with the first path it names, `spawn_agent` an Agent; its
 *     output → a user line with a tool_result, is_error read from Codex's own "exit code N";
 *   · a token_usage_record → an assistant line carrying the usage in Claude's keys, ONCE per
 *     response_id (Codex writes a response more than once): input minus cached is new input,
 *     cached is a cache read, cache_write a cache write, output already holds the reasoning tokens.
 * The running total in event_msg/token_count is never read: it is a counter, not a record.
 * Text is read here for the rubric and the layer and travels nowhere, as with every transcript.
 */
// Either separator (0.6.16, audit H4): on Windows a path reads C:\Users\…\rollout-….jsonl, and a pattern of `/` alone matched none.
export const CODEX_ROLLOUT = /(^|[\\/])rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{36}\.jsonl$/;
/** A rollout's thread id: its file's name without .jsonl, split on either separator. */
export const codexIdOf = (file) => String(file).split(/[\\/]/).at(-1).replace(/\.jsonl$/, "");
export const CODEX_HARNESS_TURN = /^\s*<[a-z][a-z_]*[\s>]/i;
export const codexToolName = (name) => (name === "exec" || name === "shell" || name === "container.exec" || name === "local_shell" ? "Bash" : name === "apply_patch" ? "Edit" : name === "spawn_agent" ? "Agent" : String(name ?? "tool"));
export const codexToolInput = (name, raw) => {
  const mapped = codexToolName(name);
  if (mapped === "Bash") {
    if (typeof raw === "string") { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return { command: Array.isArray(parsed.command) ? parsed.command.join(" ") : String(parsed.command ?? parsed.cmd ?? raw) }; } catch { /* the string is the command */ } return { command: raw }; }
    return { command: Array.isArray(raw?.command) ? raw.command.join(" ") : String(raw?.command ?? raw?.cmd ?? "") };
  }
  if (mapped === "Edit") { const path = /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/.exec(typeof raw === "string" ? raw : JSON.stringify(raw ?? "")); return { file_path: path ? path[1].trim() : "" }; }
  return {};
};
export const codexOutputText = (output) => (typeof output === "string" ? output : Array.isArray(output) ? output.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n") : "");
/** The rollout's raw JSON lines → transcript-shaped line objects, in file order. */
export function* codexLines(records) {
  let cwd = null, model = null;
  const seenResponses = new Set();
  for (const raw of records) {
    if (!raw || !String(raw).trim()) continue;
    let record; try { record = JSON.parse(raw); } catch { continue; }
    const timestamp = typeof record?.timestamp === "string" ? record.timestamp : null;
    const payload = record?.payload && typeof record.payload === "object" ? record.payload : {};
    if (record.type === "session_meta") { if (typeof payload.cwd === "string") cwd = payload.cwd; continue; }
    if (record.type === "turn_context") { if (typeof payload.cwd === "string") cwd = payload.cwd; if (typeof payload.model === "string") model = payload.model; continue; }
    if (record.type === "token_usage_record") {
      const id = String(payload.response_id ?? "");
      const usage = payload.usage;
      if (!usage || typeof usage !== "object" || (id && seenResponses.has(id))) continue;
      if (id) seenResponses.add(id);
      const n = (key) => (typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0);
      yield { type: "assistant", timestamp, cwd, uuid: id ? `codex-usage-${id}` : undefined, message: { ...(model ? { model } : {}), content: [], usage: { input_tokens: Math.max(0, n("input_tokens") - n("cached_input_tokens")), output_tokens: n("output_tokens"), cache_read_input_tokens: n("cached_input_tokens"), cache_creation_input_tokens: n("cache_write_input_tokens") } } };
      continue;
    }
    if (record.type !== "response_item") continue;
    const kind = payload.type;
    if (kind === "message") {
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      const text = Array.isArray(payload.content) ? payload.content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n") : typeof payload.content === "string" ? payload.content : "";
      if (payload.role === "user" && CODEX_HARNESS_TURN.test(text)) continue;
      yield { type: payload.role, timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { ...(payload.role === "assistant" && model ? { model } : {}), content: [{ type: "text", text }] } };
      continue;
    }
    if (kind === "custom_tool_call" || kind === "function_call") {
      const input = kind === "function_call" ? (() => { try { return JSON.parse(payload.arguments ?? "{}"); } catch { return {}; } })() : payload.input;
      yield { type: "assistant", timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { ...(model ? { model } : {}), content: [{ type: "tool_use", ...(payload.call_id ? { id: String(payload.call_id) } : {}), name: codexToolName(payload.name), input: codexToolInput(payload.name, input) }] } };
      continue;
    }
    if (kind === "custom_tool_call_output" || kind === "function_call_output") {
      const text = codexOutputText(payload.output);
      const exit = /(?:failed with|exited with|exit code)[:\s]+(-?\d+)/i.exec(text.slice(-400));
      yield { type: "user", timestamp, cwd, uuid: payload.id ? `codex-${payload.id}` : undefined, message: { content: [{ type: "tool_result", ...(payload.call_id ? { tool_use_id: String(payload.call_id) } : {}), content: text, is_error: exit ? exit[1] !== "0" : false }] } };
    }
  }
}
/** Every rollout under a Codex sessions root, in a stable order. */
export function* codexRolloutFiles(root) {
  let entries = []; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* codexRolloutFiles(full);
    else if (CODEX_ROLLOUT.test(entry.name)) yield full;
  }
}
/** The rollout's working directory, from its first line alone: the file is not read for it. */
export function codexCwd(file) {
  let fd; try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.toString("utf8", 0, read).split("\n")[0] ?? "";
    const meta = JSON.parse(first);
    return meta?.type === "session_meta" && typeof meta.payload?.cwd === "string" ? meta.payload.cwd : null;
  } catch { return null; } finally { closeSync(fd); }
}
// ── end codex rollout reader ──

// ── antigravity transcript reader ──
/**
 * A GOOGLE ANTIGRAVITY CONVERSATION, READ AS A TRANSCRIPT (2026-10-04). Antigravity (the 2.0 app,
 * the `agy` CLI and the IDE) keeps one plaintext JSONL per conversation at
 * <app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl, app_data_dir being
 * ~/.gemini/antigravity (2.0), ~/.gemini/antigravity-cli (CLI) or, likely, ~/.gemini/antigravity-ide
 * (antigravity.google/docs/hooks/ names the path as the hook's transcriptPath; the step fields from
 * jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html). One object per
 * step: step_index, source (USER_EXPLICIT | MODEL | SYSTEM), type (USER_INPUT, PLANNER_RESPONSE,
 * RUN_COMMAND, VIEW_FILE, CODE_ACTION …, CONVERSATION_HISTORY, CHECKPOINT, SYSTEM_MESSAGE),
 * status, created_at, content, optional thinking and tool_calls. NO token and NO model field:
 *   · a USER_INPUT the person wrote (USER_EXPLICIT) → a user line with a text part: a human turn;
 *   · a PLANNER_RESPONSE → an assistant line: its content as text, each tool call a tool_use
 *     (a command → Bash, a file write → Edit, a subagent → Agent), the model the HOOK named;
 *   · any other step of the loop (a command run, a file viewed) → a user line with a tool_result,
 *     which is never a human turn, is_error from its status or the exit phrase;
 *   · replayed history, checkpoints, system and ephemeral messages → nothing: the harness, not work.
 * `thinking` is never read. No usage block is made up: such a stretch is sent without tokens.
 * A step written twice (RUNNING, then DONE) is read once, on its step_index.
 */
export const ANTIGRAVITY_TRANSCRIPT = /(^|[\\/])brain[\\/][^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/; // either separator (0.6.16, H4)
/** A transcript's conversation id: the folder under brain/, split on either separator. */
export const antigravityIdOf = (file) => String(file).split(/[\\/]/).at(-4);
const ANTIGRAVITY_SKIPPED = new Set(["CONVERSATION_HISTORY", "CHECKPOINT", "SYSTEM_MESSAGE", "EPHEMERAL_MESSAGE"]);
/** A model name as a client names it, or null: the hook's modelName is the only one, and a name is all it may be. */
export const cleanModel = (name) => (typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,63}$/.test(name.trim()) ? name.trim() : null);
const antigravityTime = (value) => {
  if (typeof value === "string") { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toISOString() : null; }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (value && typeof value === "object" && Number.isFinite(Number(value.seconds))) return new Date(Number(value.seconds) * 1000 + Math.floor(Number(value.nanos ?? 0) / 1e6)).toISOString();
  return null;
};
const antigravityArgs = (call) => { const raw = call?.args ?? call?.arguments ?? call?.input ?? {}; if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : {}; try { return JSON.parse(raw) ?? {}; } catch { return {}; } };
const antigravityTool = (call) => {
  const name = String(call?.name ?? "tool");
  const args = antigravityArgs(call);
  if (/run_command|shell|exec|terminal/i.test(name)) return { type: "tool_use", name: "Bash", input: { command: String(args.CommandLine ?? args.command ?? args.cmd ?? "") } };
  if (/write|replace|edit|code_action|create_file/i.test(name)) return { type: "tool_use", name: "Edit", input: { file_path: String(args.TargetFile ?? args.AbsolutePath ?? args.file_path ?? args.path ?? "") } };
  if (/subagent|spawn|delegate/i.test(name)) return { type: "tool_use", name: "Agent", input: {} };
  return { type: "tool_use", name, input: {} };
};
/** The transcript's raw JSON lines → transcript-shaped line objects. `context`: { id, model, cwd } from the hook. */
export function* antigravityLines(records, context = {}) {
  const model = cleanModel(context.model);
  const cwd = typeof context.cwd === "string" ? context.cwd : null;
  const seen = new Set();
  for (const raw of records) {
    if (!raw || !String(raw).trim()) continue;
    let step; try { step = JSON.parse(raw); } catch { continue; }
    if (!step || typeof step !== "object") continue;
    const index = Number.isInteger(step.step_index) ? step.step_index : null;
    if (index !== null) { if (seen.has(index)) continue; seen.add(index); }
    const timestamp = antigravityTime(step.created_at);
    const type = String(step.type ?? "");
    if (!timestamp || ANTIGRAVITY_SKIPPED.has(type)) continue;
    const uuid = index !== null && context.id ? `antigravity-${context.id}-${index}` : undefined;
    const text = typeof step.content === "string" ? step.content : "";
    if (type === "USER_INPUT") { if (step.source === "USER_EXPLICIT") yield { type: "user", timestamp, cwd, uuid, message: { content: [{ type: "text", text }] } }; continue; }
    if (type === "PLANNER_RESPONSE") {
      // No tool_use id: a result names no call, so the counter pairs a run with the next result in order.
      const calls = (Array.isArray(step.tool_calls) ? step.tool_calls : []).map(antigravityTool);
      yield { type: "assistant", timestamp, cwd, uuid, message: { ...(model ? { model } : {}), content: [...(text ? [{ type: "text", text }] : []), ...calls] } };
      continue;
    }
    const exit = /(?:failed with|exited with|exit code)[:\s]+(-?\d+)/i.exec(text.slice(-400));
    yield { type: "user", timestamp, cwd, uuid, message: { content: [{ type: "tool_result", content: text, is_error: /^(ERROR|FAILED)$/i.test(String(step.status ?? "")) || (exit ? exit[1] !== "0" : false) }] } };
  }
}
/** The app data directories Antigravity may write to: the 2.0 app, the CLI, the IDE; a test names its own. */
export const antigravityRoots = (given) => (given ? [given.replace(/^~(?=\/|$)/, homedir())] : ["antigravity", "antigravity-cli", "antigravity-ide"].map((name) => join(homedir(), ".gemini", name)));
/** Whether Antigravity is on this machine: its config folder or one of its data folders. */
export const antigravityHere = () => [join(homedir(), ".gemini", "config"), ...antigravityRoots()].some((path) => { try { return statSync(path).isDirectory(); } catch { return false; } });
/** Every conversation's transcript under the roots, in a stable order. */
export function* antigravityTranscripts(roots) {
  for (const root of roots) {
    let ids = []; try { ids = readdirSync(join(root, "brain")).sort(); } catch { continue; }
    for (const id of ids) {
      const file = join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl");
      try { if (statSync(file).isFile()) yield { conversationId: id, file }; } catch { /* no transcript in this conversation */ }
    }
  }
}
/**
 * WHAT THE HOOK SAID, KEPT ON THIS MACHINE. The transcript names neither the model nor the folder;
 * the Stop hook's payload does (modelName, workspacePaths). Both are kept in ~/.worktrust/antigravity.json
 * per conversation, so a day swept later still knows its model and its repository; the folder never
 * leaves (the hook reads it for the repository's owner/name and a layer keyword, as for Claude Code).
 */
const MEMORY = () => join(homedir(), ".worktrust", "antigravity.json");
const readMemory = () => { try { return JSON.parse(readFileSync(MEMORY(), "utf8")) ?? {}; } catch { return {}; } };
export const antigravityContext = (conversationId) => readMemory()[conversationId] ?? {};
export function rememberAntigravity(input) {
  const id = typeof input?.conversationId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(input.conversationId) ? input.conversationId : null;
  if (!id) return null;
  const first = Array.isArray(input.workspacePaths) ? input.workspacePaths.find((path) => typeof path === "string") : null;
  let cwd = null; try { cwd = first ? (first.startsWith("file://") ? fileURLToPath(first) : first) : null; } catch { cwd = null; }
  const memory = readMemory();
  memory[id] = { ...(memory[id] ?? {}), ...(cleanModel(input.modelName) ? { model: cleanModel(input.modelName) } : {}), ...(cwd ? { cwd } : {}), at: new Date().toISOString() };
  const kept = Object.fromEntries(Object.entries(memory).sort((a, b) => String(b[1]?.at ?? "").localeCompare(String(a[1]?.at ?? ""))).slice(0, 500));
  try { mkdirSync(join(homedir(), ".worktrust"), { recursive: true }); writeFileSync(MEMORY(), JSON.stringify(kept)); } catch { /* the sweep still runs, without the model */ }
  return id;
}
// ── end antigravity transcript reader ──
