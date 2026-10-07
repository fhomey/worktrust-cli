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
];
const CHECK_KINDS = ["test", "typecheck", "lint", "build", "gate", "ci"];
const DELIVERY_KINDS = ["commit", "pr", "push", "deploy"];
export const callKindsOf = (block) => {
  const command = block && SHELL_TOOLS.has(String(block.name)) ? block.input?.command ?? block.input?.CommandLine ?? block.input?.cmd : null;
  return typeof command === "string" ? CALL_KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind) : [];
};
/** One tool call as the stretch reads it: its id, its kinds, its FAMILY (the tool and its check kinds) and a digest of its input (compared, never kept). */
export const callOf = (block) => { const kinds = callKindsOf(block); return { id: block.id, kinds, family: `${String(block.name)}|${kinds.join("+")}`, digest: createHash("sha256").update(JSON.stringify(block.input ?? null)).digest("base64url").slice(0, 16) }; };

/**
 * VERIFICATION PER STRETCH (0.7.1; framework L7, L12): per kind of check, how many ran and how many failed; per step of
 * delivery, how many succeeded; and whether a check had PASSED before the first delivery step. Null where the stretch
 * ran neither, so "no check seen" is never written as "zero checks".
 */
function verificationOf(messages, helpers) {
  const kinds = new Map();
  for (const message of messages) for (const call of message.calls ?? []) kinds.set(call.id, call.kinds);
  const checks = {}, delivered = {};
  let deliveredAt = null, passedFirst = false;
  for (const message of messages) for (const result of message.results ?? []) {
    for (const kind of kinds.get(result.id) ?? []) {
      if (CHECK_KINDS.includes(kind)) { const tally = (checks[kind] ??= [0, 0]); tally[0] += 1; if (result.failed) tally[1] += 1; else if (deliveredAt === null) passedFirst = true; }
      else if (DELIVERY_KINDS.includes(kind) && !result.failed) { delivered[kind] = (delivered[kind] ?? 0) + 1; if (deliveredAt === null) deliveredAt = message.at; }
    }
  }
  const any = (record) => Object.keys(record).length > 0;
  const recovery = recoveryOf(messages), delegation = delegationOf(messages, helpers);
  return { ...(any(checks) ? { verification: checks } : {}), ...(any(delivered) ? { delivery: { ...delivered, verified_first: passedFirst } } : {}), ...(recovery ? { recovery } : {}), ...(delegation ? { delegation } : {}) };
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

/** The stretch's whole derived record; `helpers` are the hook's own readers of a human turn, so both read it the same way. */
export function deriveStretch(messages, helpers) {
  const context = contextOf(messages, helpers), routing = routingOf(messages), steering = steeringOf(messages, helpers);
  const tools = toolsOf(messages);
  return { ...verificationOf(messages, helpers), ...(context ? { context } : {}), ...(routing ? { routing } : {}), ...(steering ? { steering } : {}), ...(tools ? { tools } : {}) };
}
