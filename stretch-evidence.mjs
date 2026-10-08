/**
 * THE WORK STRETCH'S DERIVED RECORD (CLI 0.7.4; the capability roadmap, docs/CAPABILITY-EVIDENCE-ROADMAP.md). Read by the
 * session hook from one stretch's messages, on this computer: what each tool call WAS as a kind (never its command),
 * verification and delivery, recovery, delegation, context and routing. Everything here goes into the local archive
 * (`preserve --archive`) and nothing into what the hook sends; each field is null where the stretch shows none of it.
 * Split from log-session.mjs so each tranche adds a function here, with its own test, instead of growing the hook.
 */
import { createHash } from "node:crypto";

/**
 * WHAT A TOOL CALL WAS, AS A CATEGORY (0.7.1, verification per stretch; the capability roadmap's second tranche). A shell
 * command is read HERE to name its kind: a check (test, typecheck, lint, build, CI, the project's own gate) or a step of
 * delivery (commit, PR, push, deploy). The command itself never leaves this function; only the kind does, and only into
 * the local archive. A chained command can be several kinds; its one outcome counts for each.
 */
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "run_command", "run_shell_command", "execute_command", "terminal"]);
const CALL_KINDS = [
  ["test", /(^|[\s/;&|])(vitest|jest|pytest|mocha|rspec|phpunit)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bgo test\b|\bcargo test\b|\bnode --test\b|\bplaywright test\b|scripts\/test-[\w-]+\.m?[jt]s\b/],
  ["typecheck", /\btsc\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?typecheck\b|\bmypy\b|\bpyright\b/],
  ["lint", /\beslint\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b|\bruff\b|\bflake8\b|\bclippy\b|\bbiome\s+(check|lint)\b/],
  ["build", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bnext build\b|\bvite build\b|\bcargo build\b|\bgo build\b/],
  ["gate", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(gate|verify|check)\b|scripts\/check-[\w-]+\.m?[jt]s\b/],
  ["ci", /\bgh\s+(run\s+(watch|view)|pr\s+checks)\b/],
  ["commit", /\bgit\s+commit\b/],
  ["pr", /\bgh\s+pr\s+(create|merge)\b/],
  ["push", /\bgit\s+push\b/],
  ["deploy", /\b(vercel(\s+deploy)?\s+--prod|fly\s+deploy|netlify\s+deploy|wrangler\s+deploy)\b/],
  // 0.8.8: a security scan is a check of its own; looking at the change before delivering it; and a destructive command.
  ["security", /\b(gitleaks|trufflehog|semgrep|snyk|osv-scanner|trivy|bandit)\b|\b(npm|pnpm|yarn)\s+audit\b/],
  ["inspect", /\bgit\s+(diff|show|status)\b/],
  ["destructive", /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bgit\s+(reset\s+--hard|push\s+(-f\b|--force)|clean\s+-[a-z]*f)|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b/i],
];
const CHECK_KINDS = ["test", "typecheck", "lint", "build", "gate", "ci", "security"];
const DELIVERY_KINDS = ["commit", "pr", "push", "deploy"];
export const callKindsOf = (block) => {
  const command = block && SHELL_TOOLS.has(String(block.name)) ? block.input?.command ?? block.input?.CommandLine ?? block.input?.cmd : null;
  return typeof command === "string" ? CALL_KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind) : [];
};
/**
 * RISK AND HYGIENE MARKS (0.9.1), beside the kinds and outside a call's family so no earlier measure moves: a ROLLBACK
 * (git revert or restore, a hard reset, a deploy rolled back), a PRIVILEGED command (sudo, a forced push, a world-
 * writable chmod), a BYPASS (hooks skipped with --no-verify), and a SECRET touched (a .env, a private key, a credentials
 * or token file read or printed). The path and the command are read here and never kept; only the mark travels.
 */
const MARKS = [
  ["rollback", /\bgit\s+(revert|restore)\b|\bgit\s+reset\s+--hard\b|\b(vercel|fly|netlify)\s+rollback\b|\bkubectl\s+rollout\s+undo\b/],
  ["privilege", /(^|[\s;&|])sudo\s|\bgit\s+push\b[^\n]*\s(-f|--force(-with-lease)?)\b|\bchmod\s+(-R\s+)?777\b/],
  ["bypass", /\s--no-verify\b/],
  // 0.9.2: the route the work took: a branch of its own, or a push straight to the default branch.
  ["branch", /\bgit\s+(checkout\s+-b|switch\s+-c)\s|\bgit\s+branch\s+(?!-)[\w./-]+/],
  ["push_main", /\bgit\s+push\b[^\n;&|]*\s(main|master)\b/],
  // 0.9.4: the kind of system a command worked on, and reviews and issues handled from the terminal.
  ["infra", /(^|[\s;&|(])(terraform|tofu|pulumi|kubectl|helm|kustomize|ansible(-playbook)?|docker(\s+compose)?|docker-compose|podman)\s/],
  ["data", /(^|[\s;&|(])(psql|pg_dump|pg_restore|mysql|sqlite3|duckdb|mongosh|redis-cli|bq|snowsql|dbt|clickhouse(-client)?)\b/],
  ["cloud", /(^|[\s;&|(])(aws|gcloud|gsutil|az|vercel|netlify|fly|flyctl|wrangler|supabase|firebase|heroku|doctl)\s/],
  ["review_approve", /\bgh\s+pr\s+review\b[^\n;&|]*\s(-a|--approve)\b/],
  ["review_changes", /\bgh\s+pr\s+review\b[^\n;&|]*\s(-r|--request-changes)\b/],
  ["review_comment", /\bgh\s+pr\s+review\b[^\n;&|]*\s(-c|--comment)\b/],
  ["issue_open", /\bgh\s+issue\s+create\b/],
  ["issue_close", /\bgh\s+issue\s+close\b/],
];
/** A plan or roadmap the work wrote down (0.9.4), by the file's name; the name never leaves. */
const PLAN_DOC = /(^|[\\/])(PLAN|ROADMAP|DESIGN|SPEC|RFC|ADR)[\w.-]*\.(md|mdx|txt)$|(^|[\\/])(plans?|roadmaps?|rfcs?|adrs?|specs?)[\\/][^\\/]+\.(md|mdx)$|\.plan\.md$/i;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "write_file", "edit_file", "create_file"]);
// 0.9.5: a file that holds a secret by its name, as a path token; "credentials" only as a file (a search for the word is no read).
// 0.9.6: a file that holds a secret by its name, as a path token; a template (.env.example, .sample, .template, .dist) holds none.
const SECRET_FILE = /(^|[\/\s'"])(\.env(\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?|id_(rsa|ed25519|ecdsa)|[\w.-]+\.(pem|p12|pfx)|credentials\.json|\.aws[\/]credentials|\.npmrc|\.netrc|\.pgpass)(['"\s]|$)/;
// 0.9.5: a command that shows or copies a file's content; a search (grep, sed, awk) names a word and is no read.
// 0.9.6: a piece of the pipeline whose command IS a reader (cat, head, tail, cp ...) and whose own arguments name the file;
// `node --env-file .env.local x | tail` uses the file and reads the output, and is no secret shown (2,000 such counted before).
const READER = /^\s*(sudo\s+)?(cat|less|more|head|tail|bat|base64|xxd|strings|cp|scp|Get-Content)\b/;
const readsSecret = (command) => command.split(/\|\|?|&&|;|\n/).some((segment) => READER.test(segment) && SECRET_FILE.test(segment.replace(READER, " ")));
const READ_TOOLS = new Set(["Read", "read_file", "view", "open_file"]);
export const marksOf = (block) => {
  const name = String(block?.name ?? "");
  const command = SHELL_TOOLS.has(name) ? block.input?.command ?? block.input?.CommandLine ?? block.input?.cmd : null;
  const path = READ_TOOLS.has(name) ? block.input?.file_path ?? block.input?.path ?? null : null;
  const marks = typeof command === "string" ? MARKS.filter(([, pattern]) => pattern.test(command)).map(([mark]) => mark) : [];
  const written = WRITE_TOOLS.has(name) ? block.input?.file_path ?? block.input?.path ?? null : null;
  if (typeof written === "string" && PLAN_DOC.test(written)) marks.push("plan_doc");
  if ((typeof path === "string" && SECRET_FILE.test(path)) || (typeof command === "string" && readsSecret(command))) marks.push("secret");
  return marks;
};

/**
 * WHAT A READ WAS (0.9.3), by kind: docs, tests, logs, config, source, or the web. The path is read here and never kept.
 */
const READ_KINDS = [
  ["docs", /(^|[\\/])docs?[\\/]|(^|[\\/])README|\.(md|mdx|rst|txt)$/i],
  ["tests", /(^|[\\/])(__tests__|tests?|spec|e2e)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/],
  ["logs", /\.log$|(^|[\\/])logs?[\\/]/i],
  ["config", /\.(json|ya?ml|toml|ini|env\.example)$|(^|[\\/])\.[\w-]+rc$|config/i],
];
export const readKindOf = (block) => {
  const name = String(block?.name ?? "");
  if (/^(WebFetch|WebSearch|web_fetch|web_search)$/.test(name)) return "web";
  const path = READ_TOOLS.has(name) ? block.input?.file_path ?? block.input?.path ?? null : null;
  if (typeof path !== "string") return null;
  return READ_KINDS.find(([, pattern]) => pattern.test(path))?.[0] ?? "source";
};

/**
 * A TOOL RESULT AS THE STRETCH READS IT (0.8.1): its call's id, whether it failed, and, read here and never kept, WHO
 * refused it when it was refused: the PERSON (Claude Code's fixed sentence when they decline a tool use or a plan) or a
 * GUARD (the client's own safety layer or auto-mode classifier). Framework L8 and L5.
 */
const PERSON_REFUSED = /^\s*(The user doesn't want to (proceed|take this action)|User rejected|The user rejected|The user declined)/i;
const GUARD_REFUSED = /^\s*Permission for this (command|action) was denied by/i;
const OUTAGE = /\b(overloaded|rate[ -]?limit(ed)?|too many requests|429|503|service unavailable|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND)\b/i;
export const resultOf = (block) => {
  const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("") : "";
  const failed = block.is_error === true;
  // 0.8.5: a reader that could not see the outcome (Codex's code mode, a background terminal) says so; unknown is never a pass.
  if (!failed && block.outcome === "unknown") return { id: block.tool_use_id, failed: null, refusal: null };
  // 0.9.3: an OUTAGE (the model or a tool overloaded, rate-limited, timed out, unreachable), read here and never kept.
  const outage = failed && OUTAGE.test(text);
  return { id: block.tool_use_id, failed, refusal: failed && PERSON_REFUSED.test(text) ? "person" : failed && GUARD_REFUSED.test(text) ? "guard" : null, ...(outage ? { outage: true } : {}) };
};
/** A to-do list the agent wrote (TodoWrite): how many items and how many done, never what they say. */
const planOf = (block) => (block.name === "TodoWrite" && Array.isArray(block.input?.todos) ? { items: block.input.todos.length, done: block.input.todos.filter((todo) => todo && todo.status === "completed").length } : null);

/** One tool call as the stretch reads it: its id, its kinds, its FAMILY (the tool and its check kinds) and a digest of its input (compared, never kept). */
export const callOf = (block) => { const kinds = callKindsOf(block), plan = planOf(block), marks = marksOf(block), read = readKindOf(block); return { id: block.id, kinds, ...(marks.length ? { marks } : {}), ...(read ? { read } : {}), family: `${String(block.name)}|${kinds.join("+")}`, digest: createHash("sha256").update(JSON.stringify(block.input ?? null)).digest("base64url").slice(0, 16), ...(plan ? { plan } : {}) }; };

/**
 * VERIFICATION PER STRETCH (0.7.1; framework L7, L12): per kind of check, how many ran and how many failed; per step of
 * delivery, how many succeeded; and whether a check had PASSED before the first delivery step. Null where the stretch
 * ran neither, so "no check seen" is never written as "zero checks".
 */
function verificationOf(messages, helpers) {
  const kinds = new Map();
  for (const message of messages) for (const call of message.calls ?? []) kinds.set(call.id, call.kinds);
  const checks = {}, delivered = {}, unconfirmed = {};
  let deliveredAt = null, passedFirst = false;
  for (const message of messages) for (const result of message.results ?? []) {
    for (const kind of kinds.get(result.id) ?? []) {
      // A check whose outcome nobody could see is counted as run and unconfirmed, apart from the known tallies (0.8.5).
      if (CHECK_KINDS.includes(kind) && result.failed === null) { unconfirmed[kind] = (unconfirmed[kind] ?? 0) + 1; continue; }
      if (DELIVERY_KINDS.includes(kind) && result.failed === null) continue;
      if (CHECK_KINDS.includes(kind)) { const tally = (checks[kind] ??= [0, 0]); tally[0] += 1; if (result.failed) tally[1] += 1; else if (deliveredAt === null) passedFirst = true; }
      else if (DELIVERY_KINDS.includes(kind) && !result.failed) { delivered[kind] = (delivered[kind] ?? 0) + 1; if (deliveredAt === null) deliveredAt = message.at; }
    }
  }
  const any = (record) => Object.keys(record).length > 0;
  const recovery = recoveryOf(messages), delegation = delegationOf(messages, helpers);
  return { ...(any(checks) ? { verification: checks } : {}), ...(any(unconfirmed) ? { unconfirmed } : {}), ...(any(delivered) ? { delivery: { ...delivered, verified_first: passedFirst } } : {}), ...(recovery ? { recovery } : {}), ...(delegation ? { delegation } : {}) };
}

/**
 * DELEGATION AND CHECKPOINTS PER STRETCH (0.7.3; framework L3, L5): how many tool actions the agent took on its own
 * between two moments the person stepped in (their own turn, or stopping it), as the longest and the middle chain; and
 * how often the agent stopped for the person on purpose: a question it asked them, a plan it asked them to approve.
 * Null when the stretch made no tool call.
 */
function delegationOf(messages, { isHumanTurn, INTERRUPTED, textOf }) {
  const chains = [];
  let chain = 0, calls = 0, questions = 0, plans = 0;
  for (const message of messages) {
    if (message.bridge) continue;
    const stepIn = message.type === "user" && !message.meta && message.kind !== "tool_result" && (isHumanTurn(message.content) || INTERRUPTED.test(textOf(message.content).trim()));
    if (stepIn) { if (chain > 0) chains.push(chain); chain = 0; continue; }
    for (const call of message.calls ?? []) {
      const tool = call.family.split("|")[0];
      calls += 1; chain += 1;
      if (tool === "AskUserQuestion") questions += 1;
      if (tool === "ExitPlanMode") plans += 1;
    }
  }
  if (chain > 0) chains.push(chain);
  if (calls === 0) return null;
  chains.sort((a, b) => a - b);
  return { chain_max: chains.at(-1), chain_median: chains[Math.floor((chains.length - 1) / 2)], questions, plans };
}

/**
 * RECOVERY PER STRETCH (0.7.2; framework L9): of the tool calls that failed, how many were followed by a success of the
 * same family (the same tool, the same kind of check) later in the stretch, the middle time that took, and what came
 * next: the same input again (a blind retry) or a different one (a changed strategy). Inputs are compared by digest on
 * this computer and never kept. Null when nothing failed.
 */
function recoveryOf(messages) {
  const calls = [];
  const byId = new Map();
  for (const message of messages) {
    for (const call of message.calls ?? []) { const entry = { ...call, at: message.at, failed: null }; calls.push(entry); byId.set(call.id, entry); }
    for (const result of message.results ?? []) { const call = byId.get(result.id); if (call) call.failed = result.failed; }
  }
  const done = calls.filter((call) => call.failed !== null);
  let failures = 0, recovered = 0, blind = 0, changed = 0;
  const latencies = [];
  done.forEach((call, index) => {
    if (!call.failed) return;
    failures += 1;
    const later = done.slice(index + 1).filter((next) => next.family === call.family);
    if (later.length > 0) { if (later[0].digest === call.digest) blind += 1; else changed += 1; }
    const success = later.find((next) => !next.failed);
    if (success) { recovered += 1; latencies.push(Math.max(0, Math.round((success.at - call.at) / 1000))); }
  });
  if (failures === 0) return null;
  latencies.sort((a, b) => a - b);
  return { failures, recovered, blind_retries: blind, strategy_changed: changed, ...(latencies.length ? { median_seconds: latencies[Math.floor((latencies.length - 1) / 2)] } : {}) };
}


/**
 * CONTEXT AND ROUTING PER STRETCH (0.7.4; framework L6, L10): how often the context was compacted (Claude Code's own
 * summary line), which of the client's context commands the person used (a fixed list: a command of their own could
 * carry a name), how many models answered and how often the model changed between answers. Null where none shows.
 */
const CONTEXT_COMMANDS = ["compact", "clear", "resume", "context", "model", "memory"];
const COMMAND = /<command-name>\/?([a-z-]+)<\/command-name>/;
function contextOf(messages, { textOf }) {
  let compactions = 0;
  const commands = {};
  for (const message of messages) {
    if (message.bridge) continue;
    if (message.compacted) compactions += 1;
    const name = message.type === "user" ? COMMAND.exec(textOf(message.content))?.[1] : null;
    if (name && CONTEXT_COMMANDS.includes(name)) commands[name] = (commands[name] ?? 0) + 1;
  }
  return compactions > 0 || Object.keys(commands).length > 0 ? { compactions, ...(Object.keys(commands).length ? { commands } : {}) } : null;
}
function routingOf(messages) {
  const models = new Set();
  let last = null, switches = 0;
  for (const message of messages) {
    if (message.bridge || message.type !== "assistant" || !message.model || message.model === "<synthetic>") continue;
    models.add(message.model);
    if (last !== null && message.model !== last) switches += 1;
    last = message.model;
  }
  return models.size > 0 ? { models: models.size, switches } : null;
}

/**
 * STEERING THAT WORKED (0.7.5; framework L4: "effective steering, not the raw number of interventions"). A moment the
 * person stepped in while the agent was working: they stopped it, or their turn arrived right after a tool call or its
 * result. It CHANGED COURSE when the agent's next action differed from its last one before (by kind, or by input
 * digest), and it was EFFECTIVE when, after it, a check passed in the same stretch. Null when nobody stepped in.
 */
function steeringOf(messages, { isHumanTurn, INTERRUPTED, textOf }) {
  const moments = [];
  let lastCall = null, prev = null;
  const passedAfter = new Map(), results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result.failed);
  for (const message of messages) {
    if (message.bridge) { prev = message; continue; }
    const person = message.type === "user" && !message.meta && message.kind !== "tool_result";
    const stopped = person && INTERRUPTED.test(textOf(message.content).trim());
    const midTask = person && !stopped && isHumanTurn(message.content) && prev && (prev.kind === "tool_result" || prev.toolUse);
    if (stopped || midTask) moments.push({ before: lastCall, after: null, effective: false });
    for (const call of message.calls ?? []) {
      for (const moment of moments) if (moment.after === null) moment.after = call;
      if (CHECK_KINDS.some((kind) => call.kinds.includes(kind)) && results.get(call.id) === false) for (const moment of moments) if (moment.after) moment.effective = true;
      lastCall = call;
    }
    prev = message;
  }
  if (moments.length === 0) return null;
  const changed = moments.filter((moment) => moment.after && (!moment.before || moment.after.family !== moment.before.family || moment.after.digest !== moment.before.digest));
  return { moments: moments.length, changed_course: changed.length, effective: changed.filter((moment) => moment.effective).length };
}

/**
 * TASK COMPLEXITY C1 TO C5 (0.7.6; framework §14 "Task complexity C1-C5"), by a VERSIONED rule, `complexity/1`, every
 * point of it stated here and in the README so anyone can recount a class. Proposed, not calibrated: it weighs evidence,
 * it is not a score of anyone.
 *   layers touched          ≤1: 0 · 2: 1 · 3+: 2          distinct tools used     <3: 0 · 3–6: 1 · 7+: 2
 *   subagents               none: 0 · ran: 1 · 3+ at once: 2
 *   measured duration       <30 min: 0 · 30–120 min: 1 · >120 min: 2
 *   a failure recovered     1                              kinds of check run      0: 0 · 1–2: 1 · 3+: 2
 *   something delivered     1
 *   points 0–1 → C1 · 2–3 → C2 · 4–6 → C3 · 7–9 → C4 · 10+ → C5
 */
export const COMPLEXITY_RULE = "complexity/1";
export function complexityOf(derived, { layers = 0, agentRuns = 0, agentPeak = 0, seconds = null } = {}) {
  const step = (value, low, high) => (value >= high ? 2 : value >= low ? 1 : 0);
  const points = step(layers, 2, 3) + step(derived.tools ?? 0, 3, 7) + (agentPeak >= 3 ? 2 : agentRuns > 0 ? 1 : 0)
    + (seconds === null ? 0 : seconds > 7200 ? 2 : seconds >= 1800 ? 1 : 0) + ((derived.recovery?.recovered ?? 0) > 0 ? 1 : 0)
    + step(Object.keys(derived.verification ?? {}).length, 1, 3) + (derived.delivery ? 1 : 0);
  const tier = points >= 10 ? 5 : points >= 7 ? 4 : points >= 4 ? 3 : points >= 2 ? 2 : 1;
  return { class: `C${tier}`, points, rule: COMPLEXITY_RULE };
}
/** How many different tools the stretch's agent used (framework L11: tool breadth); null without a tool call. */
const toolsOf = (messages) => { const names = new Set(); for (const message of messages) for (const call of message.calls ?? []) names.add(call.family.split("|")[0]); return names.size > 0 ? names.size : null; };

/**
 * OVERSIGHT AND PLANNING PER STRETCH (0.8.1; framework L8, L5, L2). Oversight: how often the PERSON refused an action
 * or a plan the agent proposed, and how often a GUARD (the client's safety layer) refused one. Planning: how often the
 * agent wrote its to-do list, the most items one list held, and of the last list how many were done. Null where none.
 */
function oversightOf(messages) {
  let person = 0, plans = 0, guard = 0;
  const tools = new Map();
  for (const message of messages) for (const call of message.calls ?? []) tools.set(call.id, call.family.split("|")[0]);
  for (const message of messages) for (const result of message.results ?? []) {
    if (result.refusal === "person") { if (tools.get(result.id) === "ExitPlanMode") plans += 1; else person += 1; }
    if (result.refusal === "guard") guard += 1;
  }
  return person + plans + guard > 0 ? { refused: person, plans_rejected: plans, guard_denied: guard } : null;
}
function planningOf(messages) {
  const lists = [];
  for (const message of messages) for (const call of message.calls ?? []) if (call.plan) lists.push(call.plan);
  if (lists.length === 0) return null;
  const last = lists.at(-1);
  return { lists: lists.length, items_max: Math.max(...lists.map((list) => list.items)), items_last: last.items, done_last: last.done };
}

/**
 * THE AUTONOMY THE PERSON GAVE (0.8.7; framework L5, "autonomy calibration"): the permission mode the client ran in, on
 * one common scale (ask, edits, plan, auto, full), as the mode most turns ran in, how often it changed, and how many
 * turns ran in plan mode. Claude Code records its own word per turn; the Codex reader maps its approval policy and
 * sandbox. Null where no client recorded one.
 */
const MODE_SCALE = { default: "ask", ask: "ask", acceptEdits: "edits", edits: "edits", plan: "plan", auto: "auto", bypassPermissions: "full", dontAsk: "full", full: "full" };
function autonomyOf(messages) {
  const modes = [];
  for (const message of messages) if (!message.bridge && message.permissionMode && MODE_SCALE[message.permissionMode]) modes.push(MODE_SCALE[message.permissionMode]);
  if (modes.length === 0) return null;
  const tally = {};
  for (const mode of modes) tally[mode] = (tally[mode] ?? 0) + 1;
  const mode = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  let switches = 0;
  for (let i = 1; i < modes.length; i += 1) if (modes[i] !== modes[i - 1]) switches += 1;
  return { mode, switches, plan_turns: tally.plan ?? 0 };
}

/**
 * HOW THE WORK WAS FRAMED, CHECKED AND RISKED (0.8.8; the owner's capability list: problem framing, verification quality,
 * acceptance discipline, risk awareness, tool selection, context efficiency, recovery cycles). All structural, read from
 * the order of turns and calls; nothing of their content.
 *   framing: the person's turns before the agent's first action (an edit, a write or a shell command), and whether a plan
 *            (plan mode, a plan approved, a to-do list) came before it.
 *   quality: whether a check passed AFTER the stretch's last change; the most failures one check family took before it
 *            passed; whether the change was looked at (git diff, show, status) before the first delivery step.
 *            0.8.9: change BLOCKS (edits with no check between them) and how many a check followed before the next one;
 *            REWORK cycles (a check failed, then a change before that check ran again: change, fail, change).
 *   stage:   the furthest step the stretch reached on this computer: attempted (it changed something), verified (a check
 *            passed), committed, pushed, pr, deployed (0.8.9). Merged and confirmed are the server's, from GitHub.
 *   risk:    destructive commands proposed, refused (by the person or a guard) and run.
 *   tool_mix: calls per kind of tool (search, read, edit, shell, agent, web, data, mcp, plan).
 *   reads:   files read again unchanged (the same read twice), the cost of context that did not hold.
 */
const ACTION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_TOOLS = new Set(["TodoWrite", "ExitPlanMode", "AskUserQuestion"]);
const toolKind = (tool) => EDIT_TOOLS.has(tool) ? "edit" : tool === "Read" ? "read" : ["Grep", "Glob", "WebSearch", "ToolSearch"].includes(tool) ? "search" : tool === "Bash" ? "shell" : ["Agent", "Task"].includes(tool) ? "agent" : /^(WebFetch|browser|mcp__.*(playwright|browser|chrome))/i.test(tool) ? "web" : /sql|postgres|supabase|database|bigquery|snowflake/i.test(tool) ? "data" : /^mcp__/.test(tool) ? "mcp" : PLAN_TOOLS.has(tool) ? "plan" : "other";
function practiceOf(messages, { isHumanTurn }) {
  const results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result);
  let turns = 0, acted = false, planned = false, turnsBefore = 0, plannedFirst = false;
  let lastChange = -1, passedAfter = false, delivered = false, inspectedFirst = false;
  const failuresBefore = new Map(); let cyclesMax = 0;
  let blocks = 0, checkedBlocks = 0, inBlock = false, rework = 0, passedAny = false;
  const pendingFail = new Set(), reached = new Set();
  const risk = { proposed: 0, refused: 0, run: 0 }, mix = {}, reads = new Map();
  let index = 0;
  for (const message of messages) {
    if (message.bridge) continue;
    if (message.type === "user" && !message.meta && message.kind !== "tool_result" && isHumanTurn(message.content)) turns += 1;
    if (message.permissionMode === "plan") planned = true;
    for (const call of message.calls ?? []) {
      index += 1;
      const tool = call.family.split("|")[0], result = results.get(call.id);
      mix[toolKind(tool)] = (mix[toolKind(tool)] ?? 0) + 1;
      if (PLAN_TOOLS.has(tool) && tool !== "AskUserQuestion") planned = true;
      if (!acted && ACTION_TOOLS.has(tool)) { acted = true; turnsBefore = turns; plannedFirst = planned; }
      if (EDIT_TOOLS.has(tool)) {
        lastChange = index; passedAfter = false;
        if (!inBlock) { blocks += 1; inBlock = true; }
        rework += pendingFail.size; pendingFail.clear();
      }
      if (tool === "Read") reads.set(call.digest, (reads.get(call.digest) ?? 0) + 1);
      const checks = call.kinds.filter((kind) => CHECK_KINDS.includes(kind));
      if (checks.length > 0 && inBlock) { checkedBlocks += 1; inBlock = false; }
      for (const kind of checks) {
        if (result?.failed === true) { failuresBefore.set(kind, (failuresBefore.get(kind) ?? 0) + 1); pendingFail.add(kind); }
        if (result?.failed === false) { passedAny = true; pendingFail.delete(kind); }
        if (result?.failed === false) { cyclesMax = Math.max(cyclesMax, failuresBefore.get(kind) ?? 0); failuresBefore.set(kind, 0); if (index > lastChange) passedAfter = true; }
      }
      if (call.kinds.includes("inspect") && !delivered) inspectedFirst = true;
      if (call.kinds.some((kind) => DELIVERY_KINDS.includes(kind)) && result?.failed === false) { delivered = true; for (const kind of call.kinds) if (DELIVERY_KINDS.includes(kind)) reached.add(kind); }
      if (call.kinds.includes("destructive")) {
        risk.proposed += 1;
        if (result?.refusal) risk.refused += 1; else if (result?.failed === false) risk.run += 1;
      }
    }
  }
  if (index === 0) return null;
  const repeated = [...reads.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  const stage = ["deploy", "pr", "push", "commit"].find((kind) => reached.has(kind)) ?? (lastChange > 0 ? (passedAny ? "verified" : "attempted") : null);
  return {
    framing: { turns_before_action: acted ? turnsBefore : turns, planned_first: acted ? plannedFirst : planned },
    quality: { checked_after_change: lastChange > 0 ? passedAfter : null, fix_cycles_max: cyclesMax, inspected_first: delivered ? inspectedFirst : null, change_blocks: blocks, checked_blocks: checkedBlocks, rework_cycles: rework },
    ...(stage ? { stage: { deploy: "deployed", pr: "pr", push: "pushed", commit: "committed" }[stage] ?? stage } : {}),
    ...(risk.proposed > 0 ? { risk } : {}),
    tool_mix: mix,
    reads: { repeated },
  };
}

/**
 * HOW FAST A STRETCH MOVED (0.9.0): seconds from the person's first turn to the agent's first action (an edit, a write or
 * a shell command) and from the first change to the first check; per failure, the actions and seconds until the next
 * change that answered it (detection), and the calls from a failed check to that check passing (recovery depth); after
 * a resume, a clear or a compaction, the calls until the next change or check (back to work). Medians, from the order
 * and the clocks alone; nothing of what was said or run.
 */
const median = (values) => { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2); };
function timingOf(messages, { isHumanTurn, textOf }) {
  let firstTurn = null, firstAction = null, firstChange = null, firstCheck = null, index = 0, resumedAt = null;
  const kindsById = new Map(), open = [], openChecks = new Map(), detect = [], detectSeconds = [], depth = [], resume = [];
  for (const message of messages) {
    if (message.bridge || !Number.isFinite(message.at)) continue;
    const text = message.type === "user" ? textOf(message.content) : "";
    if (message.compacted || ["compact", "clear", "resume"].includes(COMMAND.exec(text)?.[1] ?? "")) resumedAt = index;
    if (message.type === "user" && !message.meta && message.kind !== "tool_result" && isHumanTurn(message.content) && firstTurn === null) firstTurn = message.at;
    for (const result of message.results ?? []) {
      const kinds = kindsById.get(result.id) ?? [];
      if (result.failed !== true) {
        for (const kind of kinds.filter((item) => CHECK_KINDS.includes(item) && result.failed === false)) { const at = openChecks.get(kind); if (at !== undefined) { depth.push(index - at); openChecks.delete(kind); } }
        continue;
      }
      open.push({ index, at: message.at });
      for (const kind of kinds.filter((item) => CHECK_KINDS.includes(item))) if (!openChecks.has(kind)) openChecks.set(kind, index);
    }
    for (const call of message.calls ?? []) {
      index += 1;
      kindsById.set(call.id, call.kinds);
      const tool = call.family.split("|")[0];
      if (firstAction === null && ACTION_TOOLS.has(tool)) firstAction = message.at;
      if (EDIT_TOOLS.has(tool)) {
        if (firstChange === null) firstChange = message.at;
        for (const failure of open.splice(0)) { detect.push(index - failure.index); detectSeconds.push(Math.max(0, (message.at - failure.at) / 1000)); }
      }
      if (firstChange !== null && firstCheck === null && call.kinds.some((kind) => CHECK_KINDS.includes(kind))) firstCheck = message.at;
      if (resumedAt !== null && (EDIT_TOOLS.has(tool) || call.kinds.some((kind) => CHECK_KINDS.includes(kind)))) { resume.push(index - resumedAt); resumedAt = null; }
    }
  }
  const out = {
    first_action_s: firstTurn !== null && firstAction !== null && firstAction >= firstTurn ? Math.round((firstAction - firstTurn) / 1000) : null,
    first_check_s: firstChange !== null && firstCheck !== null ? Math.round((firstCheck - firstChange) / 1000) : null,
    detect_actions: median(detect), detect_s: median(detectSeconds), recovery_calls: median(depth), resume_actions: median(resume),
  };
  const kept = Object.fromEntries(Object.entries(out).filter(([, value]) => value !== null));
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * RISK AND HYGIENE PER STRETCH (0.9.1): rollbacks, privileged commands, hooks skipped, secrets touched; destructive
 * commands and how many a look (git diff, show, status) or a check came before since the last change; after a guard
 * refused a call, whether the next call was the same one again (retried), another (changed), or none (stopped); and
 * whether a check ran after the stretch's first delivery step (a push, a deploy). Counts only.
 */
function hygieneOf(messages) {
  const results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result);
  const out = { rollbacks: 0, privileged: 0, bypasses: 0, secrets: 0, destructive: 0, destructive_checked: 0, guard_retried: 0, guard_changed: 0, guard_stopped: 0 };
  let lookedSinceChange = false, delivered = false, checkedAfterDelivery = false, refusedDigest = null;
  for (const message of messages) {
    if (message.bridge) continue;
    for (const call of message.calls ?? []) {
      const tool = call.family.split("|")[0], result = results.get(call.id), marks = call.marks ?? [];
      if (refusedDigest !== null) { if (call.digest === refusedDigest) out.guard_retried += 1; else out.guard_changed += 1; refusedDigest = null; }
      if (marks.includes("rollback")) out.rollbacks += 1;
      if (marks.includes("privilege")) out.privileged += 1;
      if (marks.includes("bypass")) out.bypasses += 1;
      if (marks.includes("secret")) out.secrets += 1;
      if (call.kinds.includes("destructive")) { out.destructive += 1; if (lookedSinceChange) out.destructive_checked += 1; }
      if (EDIT_TOOLS.has(tool)) lookedSinceChange = false;
      if (call.kinds.includes("inspect") || call.kinds.some((kind) => CHECK_KINDS.includes(kind))) { lookedSinceChange = true; if (delivered) checkedAfterDelivery = true; }
      if ((call.kinds.includes("push") || call.kinds.includes("deploy")) && result?.failed === false) delivered = true;
      if (result?.refusal === "guard") refusedDigest = call.digest;
    }
  }
  if (refusedDigest !== null) out.guard_stopped += 1;
  const kept = Object.fromEntries(Object.entries(out).filter(([, value]) => value > 0));
  if (delivered) kept.checked_after_delivery = checkedAfterDelivery;
  return Object.keys(kept).length > 0 ? kept : null;
}

/** THE ROUTE (0.9.2), from the commands: branches made, pushes straight to the default branch that went through. */
function routeOf(messages) {
  const results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result);
  let branches = 0, pushesToMain = 0;
  for (const message of messages) for (const call of message.calls ?? []) {
    const marks = call.marks ?? [];
    if (marks.includes("branch")) branches += 1;
    if (marks.includes("push_main") && results.get(call.id)?.failed === false) pushesToMain += 1;
  }
  return branches + pushesToMain > 0 ? { ...(branches ? { branches } : {}), ...(pushesToMain ? { pushes_to_main: pushesToMain } : {}) } : null;
}

/**
 * EVIDENCE AND ADAPTATION (0.9.3): what the stretch read, by kind; a plan written again after a failure; a model change
 * within three calls after a failure (escalation); two or more agents whose work a check met before the next delivery
 * (reconciliation, a proxy); and outages (the model or a tool overloaded, rate-limited, timed out) and how many the work
 * went on past (a later call succeeded). Counts only.
 */
function adaptationOf(messages) {
  const results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result);
  const sources = {}, out = { replans: 0, escalations: 0, reconciled: 0, outages: 0, outages_continued: 0 };
  let failedSince = false, lastFailureCall = null, index = 0, model = null, agentsOpen = 0, outageOpen = false;
  for (const message of messages) {
    if (message.bridge) continue;
    if (message.type === "assistant" && message.model) {
      // Once per failure: the change that answered it, not every switch after it.
      if (model && message.model !== model && lastFailureCall !== null && index - lastFailureCall <= 3) { out.escalations += 1; lastFailureCall = null; }
      model = message.model;
    }
    for (const call of message.calls ?? []) {
      index += 1;
      const tool = call.family.split("|")[0], result = results.get(call.id);
      if (call.read) sources[call.read] = (sources[call.read] ?? 0) + 1;
      if (call.plan && failedSince) { out.replans += 1; failedSince = false; }
      if (tool === "Agent" || tool === "Task") agentsOpen += 1;
      if (call.kinds.some((kind) => CHECK_KINDS.includes(kind)) && agentsOpen >= 2) { out.reconciled += 1; agentsOpen = 0; }
      if (call.kinds.some((kind) => DELIVERY_KINDS.includes(kind))) agentsOpen = 0;
      if (result?.outage) { out.outages += 1; outageOpen = true; }
      else if (outageOpen && result?.failed === false) { out.outages_continued += 1; outageOpen = false; }
      if (result?.failed === true) { failedSince = true; lastFailureCall = index; }
    }
  }
  const kept = Object.fromEntries(Object.entries(out).filter(([, value]) => value > 0));
  if (Object.keys(sources).length > 0) kept.sources = sources;
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * THE WORK'S REACH AND ITS PLAN (0.9.4): commands on infrastructure, data and cloud; plan or roadmap documents written,
 * and whether one came before the first code change; reviews approved, sent back or commented and issues opened or closed
 * from the terminal. Counts, and one flag.
 */
function reachOf(messages) {
  const results = new Map();
  for (const message of messages) for (const result of message.results ?? []) results.set(result.id, result);
  const out = { infra: 0, data: 0, cloud: 0, plan_docs: 0, reviews_approved: 0, reviews_changes: 0, reviews_commented: 0, issues_opened: 0, issues_closed: 0 };
  const KEY = { infra: "infra", data: "data", cloud: "cloud", plan_doc: "plan_docs", review_approve: "reviews_approved", review_changes: "reviews_changes", review_comment: "reviews_commented", issue_open: "issues_opened", issue_close: "issues_closed" };
  let changed = false, planFirst = null;
  for (const message of messages) {
    if (message.bridge) continue;
    for (const call of message.calls ?? []) {
      const tool = call.family.split("|")[0], marks = call.marks ?? [], result = results.get(call.id);
      if (marks.includes("plan_doc") && !changed && planFirst === null) planFirst = true;
      if (EDIT_TOOLS.has(tool) && !marks.includes("plan_doc")) { if (!changed && planFirst === null) planFirst = false; changed = true; }
      for (const mark of marks) if (KEY[mark] && result?.failed !== true) out[KEY[mark]] += 1;
    }
  }
  const kept = Object.fromEntries(Object.entries(out).filter(([, value]) => value > 0));
  if (out.plan_docs > 0) kept.plan_first = planFirst === true;
  return Object.keys(kept).length > 0 ? kept : null;
}

/** The stretch's whole derived record; `helpers` are the hook's own readers of a human turn, so both read it the same way. */
export function deriveStretch(messages, helpers) {
  const context = contextOf(messages, helpers), routing = routingOf(messages), steering = steeringOf(messages, helpers);
  const timing = timingOf(messages, helpers), hygiene = hygieneOf(messages), route = routeOf(messages), adaptation = adaptationOf(messages), reach = reachOf(messages), tools = toolsOf(messages), oversight = oversightOf(messages), planning = planningOf(messages), autonomy = autonomyOf(messages), practice = practiceOf(messages, helpers);
  return { ...(practice ?? {}), ...(oversight ? { oversight } : {}), ...(planning ? { planning } : {}), ...(autonomy ? { autonomy } : {}), ...verificationOf(messages, helpers), ...(context ? { context } : {}), ...(routing ? { routing } : {}), ...(steering ? { steering } : {}), ...(tools ? { tools } : {}), ...(timing ? { timing } : {}), ...(hygiene ? { hygiene } : {}), ...(route ? { route } : {}), ...(adaptation ? { adaptation } : {}), ...(reach ? { reach } : {}) };
}
