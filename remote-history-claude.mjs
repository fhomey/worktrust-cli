/**
 * CLAUDE CODE'S TRANSCRIPT, AS THE ITEMS OF A HISTORY PAGE: ONE PURE MAPPING (CLI 0.11.17; docs/remote-agents/
 * CHAT-HISTORY.md §4.3). No I/O, no clock: remote-history.mjs reads the lines (remote-history-file.mjs) and hands them
 * here with what follows them (`after`: the bounded look ahead).
 *
 *   transcript line                               item
 *   user, typed words                             user {text, attachments: its images and documents, counted, never sent}
 *   assistant text followed by more work          text
 *   assistant text, the turn's last               answer {model}       (only when the turn's end was SEEN; else text)
 *   assistant thinking                            thinking             (a marker; never a word of it)
 *   assistant tool_use + its user tool_result     step {label, kind (stepOf, as a live step), state, duration, previews}
 *   assistant Task / Agent tool_use               subagent {label, type, state, steps, duration}; its own lines only in
 *                                                 a page asked for it (`side`)
 *   system compact_boundary                       notice compacted
 *   meta lines, command echoes, a compact summary, sidechain lines in a main page, anything else: nothing
 *
 * A STEP'S STATE IS NEVER GUESSED: its result seen → ok or failed; no result and the end of what is closed was seen →
 * interrupted; no result and the look ahead ran out → unknown, and an unknown step carries its label alone (its input is held until
 * its output can be judged with it). PREVIEWS ONLY: input and output cut at the preview cap with
 * ANSI stripped, `more` when either was cut; a step `historyWithholds` names (a secret by name, by command or by shape, a
 * path outside the project, a connector's or an unknown tool) carries its label and `withheld`, nothing of its input or output; an output of images only is `binary`. The whole input and output
 * leave only through `detailOf`, for one item asked by id, cut at the detail cap, and never for a withheld step.
 *
 * AN ID IS DERIVED (protocol historyItemId): the subject, the line's own uuid (a tool call: its tool_use id) and the
 * block's index, so every read of the same line gives the same id.
 *
 * PROSE OF A DESK SESSION IS MASKED (CLI 0.11.19, `mask`; remote-history-mask.mjs): a key's shape in the words a person typed or in
 * an agent's text is replaced in place, before the cut, on every page of a session of this computer's own desk, closed and
 * live. Which items there are never changes.
 */
import { isAbsolute, relative, resolve } from "node:path";
import * as P from "./remote-protocol.mjs";
import { stepOf } from "./remote-claude-events.mjs";
import { SECRET_DIRS, SECRET_FILE } from "./remote-policy.mjs";
import { keyShaped, maskKeys } from "./remote-history-mask.mjs";

export { keyShaped }; // a key's shape: the step filter's rule and the prose mask's (remote-history-mask.mjs)

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** A sealed body refuses a lone surrogate (canonical.ts): one in a transcript, or made by a cut, becomes U+FFFD. */
export const sound = (text) => String(text ?? "").replace(LONE, "\uFFFD");
const clean = (text) => sound(String(text ?? "").replace(ANSI, "").replace(CONTROL, ""));
export const cutTo = (text, max) => (text.length > max ? { text: sound(text.slice(0, max)), cut: true } : { text: sound(text), cut: false });
const timeOf = (line) => { const t = typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : NaN; return Number.isSafeInteger(t) && t >= 0 ? t : null; };
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
/** The most items one line gives (review 2026-11-17, F7): a page holds whole lines and 120 items, so a line of more blocks is cut here and says so, and the cursor moves past it. */
export const LINE_ITEMS = 100;
/** What stands beside a person's words and was never typed: a command's echo, a reminder, what the editor adds (the open file, a selection). */
const ECHO = /^\s*<(command-|local-command-|bash-|system-reminder|task-notification|ide_selection|ide_opened_file)|^\s*Caveat:|^\[Request interrupted/;
/** Pasted content: counted with the files, never sent. */
const PASTED = /^\s*<pasted[_-]content/;

/**
 * The words a person typed and how many files they carried, or null: never a tool result, a command's echo, a caveat or a
 * summary. BLOCK BY BLOCK (review 2026-11-17, F2): a block that begins with one of those is dropped wherever it stands, so
 * a selection or an opened file beside typed words never crosses as typed words; a pasted block is counted, not sent.
 */
export function typedWords(line) {
  if (line?.type !== "user" || line.isMeta === true || line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true || line.message?.role !== "user") return null;
  const c = line.message.content, blocks = Array.isArray(c) ? c : null;
  if (blocks && blocks.some((b) => b?.type === "tool_result")) return null;
  const texts = (typeof c === "string" ? [c] : blocks ? blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text) : []);
  const text = texts.filter((t) => !ECHO.test(t) && !PASTED.test(t)).join("\n").trim();
  const files = (blocks ? blocks.filter((b) => b?.type === "image" || b?.type === "document").length : 0) + texts.filter((t) => PASTED.test(t)).length;
  if (!text && files === 0) return null;
  return { text, files };
}

const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "");
const onlyBinary = (content) => Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "image" || b?.type === "document");
const inputText = (name, input) => {
  if (name === "Bash" && typeof input?.command === "string") return input.command;
  try { return JSON.stringify(input ?? {}, null, 2); } catch { return ""; }
};

/**
 * WHAT A STEP OF THE HISTORY MAY NEVER CARRY (security review 2026-11-17, F1). The history's OWN rule, apart from the
 * approval policy (remote-policy.mjs decides what a phone may approve; only its lists of secret names are shared): a step
 * shows its input and output only when nothing below holds, and anything this cannot judge is withheld. The label and the
 * state are still shown.
 *
 *   the tool     a connector's tool (mcp__*) and every tool not on the short list below: withheld, input and output;
 *   a path       Read, Edit, Write, Grep, Glob: a path or a glob that names a secret file or folder, or a path outside the
 *                project (by its words: the look below is the guard for a link inside the project);
 *   a command    the WHOLE line, whatever its verb: quotes stripped, split on | ; & < > ( ) = , : and spaces, every word
 *                tested against the secret names and folders; a command that prints credentials (env, printenv, set,
 *                export -p, security, op, gh auth, aws configure, vercel env …); a variable whose name says secret; an
 *                interpreter reading the environment;
 *   the look     what went in and what came out, for a key's shape: a PEM block, scheme://user:password@, a GitHub, an
 *                API or an AWS key, a JWT, two lines of NAME=value in a row;
 *   a throw      withheld.
 */
const SHOWN_TOOLS = new Set(["Bash", "Read", "NotebookRead", "Edit", "MultiEdit", "NotebookEdit", "Write", "Grep", "Glob", "TodoWrite", "WebSearch", "WebFetch"]);
const PATH_FIELDS = ["file_path", "notebook_path", "path"], NAME_FIELDS = [...PATH_FIELDS, "glob"];
/** Folders the history keeps closed beside the policy's own: where command line tools keep their tokens. */
const TOKEN_DIRS = [".config/worktrust", ".config/gh", ".config/op", ".config/vercel", ".config/netlify", ".config/stripe", ".config/doctl", ".config/configstore", ".local/share/com.vercel.cli", ".terraform.d", ".supabase", ".expo", ".claude.json", ".codex"];
const ALL_DIRS = [...SECRET_DIRS, ...TOKEN_DIRS].map((d) => d.toLowerCase());
const GLOB = /[*?[\]{}!]/g;
/** Whether a word, a path or a glob names a secret file (any part of it, glob marks aside) or lies in a secret folder. */
function namesSecret(text) {
  const plain = String(text).replace(/['"`\\]/g, "").toLowerCase();
  for (const word of plain.split(/[\s|;&<>(){}=,:]+/)) for (const part of word.split("/")) if (part && (SECRET_FILE.test(part) || SECRET_FILE.test(part.replace(GLOB, "")))) return true;
  return ALL_DIRS.some((d) => { for (let at = plain.indexOf(d); at >= 0; at = plain.indexOf(d, at + 1)) { const before = plain[at - 1], after = plain[at + d.length]; if ((before === undefined || /[\s/~|;&<>(){}=,:]/.test(before)) && (after === undefined || /[\s/|;&<>(){}=,:*]/.test(after))) return true; } return false; });
}
const PRINTS_ANYWHERE = new Set(["printenv", "security", "secret-tool", "aws-vault", "ssh-add", "doppler", "keyring", "pbpaste"]);
const PRINTS_AS_COMMAND = new Set(["env", "op", "pass", "gpg", "gpg2", "vault", "declare", "typeset", "compgen", "bw", "lpass", "chamber", "sops", "age"]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "time", "nohup", "xargs", "nice", "npx", "bunx"]);
/** A tool's own words that print what it holds: the tool, then one of these among its next words. */
const PRINTS_WITH = { gh: ["auth", "secret", "variable"], git: ["credential", "credential-osxkeychain"], npm: ["token"], aws: ["configure", "sts", "secretsmanager", "ssm", "kms", "iam"], gcloud: ["auth", "secrets", "config"], az: ["account", "keyvault", "login"],
  vercel: ["env", "secrets", "login"], netlify: ["env", "login"], eas: ["env", "secret", "credentials"], expo: ["login"], wrangler: ["secret", "login"], fly: ["secrets", "auth"], flyctl: ["secrets", "auth"], heroku: ["config", "auth"], railway: ["variables", "login"], supabase: ["secrets", "status", "login", "projects"], firebase: ["login", "login:ci", "functions:config:get"],
  stripe: ["config", "login"], kubectl: ["config", "secret", "secrets"], docker: ["login", "inspect", "config", "secret"], helm: ["get"], terraform: ["output", "show", "state"], pulumi: ["config", "stack"] };
const SECRET_VARIABLE = /\$\{?[A-Za-z0-9_]*(TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE|AUTH|_KEY|DATABASE_URL|_DSN)/i;
const READS_ENVIRONMENT = /process\.env|os\.environ|getenv|\bENV\[|\$ENV\b|\/proc\/[^\s/]+\/environ|Deno\.env/;
function printsCredentials(command) {
  const line = String(command);
  if (SECRET_VARIABLE.test(line) || READS_ENVIRONMENT.test(line)) return true;
  for (const part of line.replace(/['"`\\]/g, " ").split(/[|;&()\n]+|\$\(/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map((w) => w.split("/").at(-1).toLowerCase());
    let first = 0;
    while (first < words.length && (WRAPPERS.has(words[first]) || /^[a-z_][a-z0-9_]*=/.test(words[first]) || words[first].startsWith("-"))) first += 1;
    const verb = words[first], rest = words.slice(first + 1);
    if (verb === undefined) continue;
    if (first > 0 && words.some((w) => PRINTS_AS_COMMAND.has(w))) return true; // behind a wrapper or an assignment, wherever it stands
    if (PRINTS_AS_COMMAND.has(verb) || (verb === "set" && rest.length === 0) || (verb === "export" && (rest.length === 0 || rest.includes("-p")))) return true;
    for (let i = 0; i < words.length; i += 1) {
      if (PRINTS_ANYWHERE.has(words[i])) return true;
      const said = Object.hasOwn(PRINTS_WITH, words[i]) ? PRINTS_WITH[words[i]] : null;
      if (said && words.slice(i + 1).filter((w) => !w.startsWith("-")).slice(0, 4).some((w) => said.includes(w))) return true;
    }
  }
  return false;
}
/** → true: nothing of this step's input or output is sent. `project`: the granted folder, canonical; null: no path can be judged. */
export function historyWithholds(name, input, output, project = null) {
  try {
    if (typeof name !== "string" || !SHOWN_TOOLS.has(name)) return true;
    const a = input && typeof input === "object" ? input : {};
    if (keyShaped(inputText(name, a)) || keyShaped(output)) return true;
    if (name === "Bash") { const command = String(a.command ?? ""); return namesSecret(command) || printsCredentials(command); }
    for (const field of NAME_FIELDS) if (a[field] !== undefined && (typeof a[field] !== "string" || namesSecret(a[field]))) return true;
    if (name === "Glob" && (typeof a.pattern !== "string" || namesSecret(a.pattern))) return true;
    for (const field of PATH_FIELDS) {
      if (a[field] === undefined) continue;
      if (project === null) return true;
      const rel = relative(project, resolve(project, a[field]));
      if (a[field].startsWith("~") || rel.startsWith("..") || isAbsolute(rel)) return true;
    }
    return false;
  } catch { return true; }
}

/** Every tool result in these lines by its tool_use id: whether it failed, its content, its time, the line's own record of it. */
function resultsOf(lines) {
  const found = new Map();
  for (const { value } of lines) {
    if (value?.type !== "user" || !Array.isArray(value.message?.content)) continue;
    for (const b of value.message.content) if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && !found.has(b.tool_use_id)) found.set(b.tool_use_id, { failed: b.is_error === true, content: b.content, at: timeOf(value), record: value.toolUseResult && typeof value.toolUseResult === "object" ? value.toolUseResult : null });
  }
  return found;
}

/** Main-chain lines only, or (side) the lines of one subagent. */
const inChain = (value, side) => (side ? value?.isSidechain === true && (side.agentId === null || value.agentId === side.agentId) : value?.isSidechain !== true && !value?.parent_tool_use_id);

/**
 * `lines` and `after`: `{ at (byte offset), value }`, oldest first, `after` following `lines` directly. `closed`: `after`
 * reaches the end of what is closed (the end of the file, or the start of the running turn), so what has no result by then
 * has none. A step's input and output pass `historyWithholds` first, always: no caller can leave it out. `side`: `{ parent (the subagent's item id),
 * agentId }` for a subagent's own page. `mask`: the page is a desk session's (above). → entries `{ line, item, raw? }` oldest first; `raw` stays on this computer.
 */
export function mapTranscript(lines, { scope, cwd = null, mask = false, after = [], closed = false, side = null }) {
  const prose = (text) => (mask ? maskKeys(text) : text);
  const all = [...lines, ...after], results = resultsOf(all), entries = [], marks = []; // marks: what happened, in order, to tell a text from an answer
  const inPage = lines.length;
  for (let n = 0; n < all.length; n += 1) {
    const { at: offset, value } = all[n], mine = n < inPage;
    if (!value || !inChain(value, side)) continue;
    const at = timeOf(value), key = typeof value.uuid === "string" && value.uuid ? value.uuid : `o${offset}`;
    if (value.type === "system" && value.subtype === "compact_boundary" && !side) {
      if (mine) entries.push({ line: offset, item: { id: P.historyItemId(scope, key, 0), kind: "notice", at, notice: "compacted" } });
      continue;
    }
    const words = typedWords(value);
    if (words) {
      marks.push({ kind: "user" });
      if (!mine || side) continue;
      const t = cutTo(prose(words.text), P.HISTORY_MAX_TEXT);
      entries.push({ line: offset, item: { id: P.historyItemId(scope, key, 0), kind: "user", at, text: t.text, ...(t.cut ? { cut: true } : {}), from: "computer", ...(words.files > 0 ? { attachments: Math.min(99, words.files) } : {}) } });
      continue;
    }
    if (value.type !== "assistant" || !Array.isArray(value.message?.content)) continue;
    const model = typeof value.message.model === "string" && /^[A-Za-z0-9._:@\[\]-]{1,128}$/.test(value.message.model) && value.message.model !== "<synthetic>" ? value.message.model : null;
    let made = 0, left = 0; // items this line gave, and blocks left out above LINE_ITEMS
    const room = () => { if (made < LINE_ITEMS) { made += 1; return true; } left += 1; return false; };
    value.message.content.forEach((block, index) => {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const mark = { kind: "text", entry: null };
        marks.push(mark);
        if (!mine || !room()) return;
        const t = cutTo(prose(block.text.trim()), P.HISTORY_MAX_TEXT);
        mark.entry = { line: offset, item: { id: P.historyItemId(scope, key, index), kind: "text", at, text: t.text, ...(t.cut ? { cut: true } : {}) }, model };
        entries.push(mark.entry);
      } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
        marks.push({ kind: "work" });
        if (mine && !side && room()) entries.push({ line: offset, item: { id: P.historyItemId(scope, key, index), kind: "thinking", at } });
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        marks.push({ kind: "work" });
        if (mine && room()) entries.push(stepEntry({ scope, cwd, offset, at, block, result: results.get(block.id) ?? null, closed, side }));
      }
    });
    // What was left out is said, as one step that carries nothing (`too_large`): never a silent gap.
    if (left > 0) entries.push({ line: offset, item: { id: P.historyItemId(scope, key, value.message.content.length), kind: "step", at, label: `${left} more parts of this message`, step: "other", state: "unknown", withheld: "too_large", ...(side ? { subagent: side.parent } : {}) }, raw: { withheld: true } });
  }
  // A text is the answer only when the turn's end came next and was seen: the person's next words, or the end of what is closed.
  if (!side) for (let m = 0; m < marks.length; m += 1) {
    const mark = marks[m];
    if (mark.kind !== "text" || !mark.entry) continue;
    const next = marks[m + 1];
    if (next ? next.kind === "user" : closed) { mark.entry.item = { ...mark.entry.item, kind: "answer", ...(mark.entry.model ? { model: mark.entry.model } : {}) }; }
  }
  return entries.map(({ model: _model, ...entry }) => entry);
}

/** A label that may leave: keys masked BEFORE it is cleaned and cut, and `generic` when what is left is still key-shaped or empty. */
function safeLabel(words, generic) {
  const label = cutTo(clean(maskKeys(words)).trim(), P.HISTORY_MAX_LABEL).text;
  return label && !keyShaped(label) ? label : generic;
}

function stepEntry({ scope, cwd, offset, at, block, result, closed, side }) {
  const id = P.historyItemId(scope, block.id, 0), input = block.input && typeof block.input === "object" ? block.input : {};
  const state = result ? (result.failed ? "failed" : "ok") : closed ? "interrupted" : "unknown";
  const record = result?.record ?? null;
  const spent = Number.isSafeInteger(record?.totalDurationMs) && record.totalDurationMs >= 0 ? record.totalDurationMs : result && result.at !== null && at !== null && result.at >= at ? result.at - at : null;
  const duration = spent === null ? {} : { duration_ms: spent };
  if (SUBAGENT_TOOLS.has(block.name) && !side) {
    const label = safeLabel(String(input.description ?? ""), "") || String(block.name);
    const type = typeof input.subagent_type === "string" ? cutTo(clean(input.subagent_type).trim(), 64).text || null : null; // cleaned as a label is
    const steps = Number.isSafeInteger(record?.totalToolUseCount) && record.totalToolUseCount >= 0 ? Math.min(100_000, record.totalToolUseCount) : null;
    const agentId = typeof record?.agentId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(record.agentId) ? record.agentId : null;
    return { line: offset, item: { id, kind: "subagent", at, label, state, ...(type ? { agent_type: type } : {}), ...(steps !== null ? { steps } : {}), ...duration }, raw: { tool_use_id: block.id, agentId, ended: result ? offset : null } };
  }
  // A LABEL NEVER CARRIES WHAT THE STEP WITHHOLDS (security review 2026-11-21, P2-1; true of closed history since 0.11.17): a
  // withheld step says only what kind of step it was (the command, the path or the tool's name was the secret's own place);
  // any other label is the live step's own, with a key's shape masked, and generic when the mask cannot unpick it.
  const step = stepOf(block.name, input, cwd), generic = block.name === "Bash" ? "Run a command" : "Use a tool";
  const withheld = historyWithholds(block.name, input, result ? resultText(result.content) : null, cwd);
  const base = { id, kind: "step", at, label: withheld ? generic : safeLabel(step.label, generic), step: step.kind, state, ...duration, ...(side ? { subagent: side.parent } : {}) };
  if (withheld) return { line: offset, item: { ...base, withheld: "secret_path" }, raw: { withheld: true } };
  if (result && onlyBinary(result.content)) return { line: offset, item: { ...base, withheld: "binary" }, raw: { withheld: true } };
  // A STEP WHOSE END WAS NOT SEEN CARRIES ITS LABEL ALONE (review 2026-11-21, P3-7): what it prints cannot be judged yet, so its input is
  // not sent either (a running step while a phone reads along; a result past a page's look ahead), not in a preview and not as a detail.
  if (state === "unknown") return { line: offset, item: base, raw: { withheld: true } };
  const whole = { input: clean(inputText(block.name, input)), output: result ? clean(resultText(result.content)) : null };
  const i = cutTo(whole.input, P.HISTORY_MAX_PREVIEW), o = whole.output === null ? null : cutTo(whole.output, P.HISTORY_MAX_PREVIEW);
  return { line: offset, item: { ...base, ...(i.text ? { input: i.text } : {}), ...(o && o.text ? { output: o.text } : {}), ...(i.cut || o?.cut ? { more: true } : {}) }, raw: whole };
}

/** The whole input and output of one step entry, each cut at the detail cap. A withheld step has none. */
export function detailOf(entry) {
  if (!entry?.raw || entry.raw.withheld || entry.item.kind !== "step") return { input: null, output: null, input_cut: false, output_cut: false };
  const i = cutTo(entry.raw.input ?? "", P.HISTORY_MAX_DETAIL), o = entry.raw.output === null || entry.raw.output === undefined ? null : cutTo(entry.raw.output, P.HISTORY_MAX_DETAIL);
  return { input: i.text || null, output: o ? o.text : null, input_cut: i.cut, output_cut: o?.cut ?? false };
}

/** What a page costs against its byte budget: an item's canonical JSON in UTF-8. */
export const itemBytes = (item) => Buffer.byteLength(JSON.stringify(item), "utf8");
