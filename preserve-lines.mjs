/**
 * WHAT AN ARCHIVE LINE MAY CARRY (split from preserve.mjs, CLI 0.7.1): the allowlist, each value checked for its type,
 * and the behaviour signals joined on `stretch_ref`. A key not named here never reaches the archive. The capability
 * tranches (docs/CAPABILITY-EVIDENCE-ROADMAP.md) add their fields here, each with its own check.
 */
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const CHECK_KINDS = ["test", "typecheck", "lint", "build", "gate", "ci", "security"], DELIVERY_KINDS = ["commit", "pr", "push", "deploy"];

/** THE ALLOWLIST: what a line may carry, each value checked for its type. A key not named here never reaches the archive. */
export const COUNTS = ["seconds", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "model_seconds", "tool_seconds", "human_seconds", "idle_seconds", "agent_runs", "agent_seconds", "agent_peak", "interrupts", "steers"];
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The hook's own words for a stretch (work area, kind, how it was steered, the measuring bases), kept as the hook sends them. */
const WORDS = ["layer", "kind", "steered_from", "duration_basis", "token_basis", "turn_basis"];
const WORD = /^[a-z][A-Za-z]{1,31}$/;
/**
 * THE STRETCH'S BEHAVIOUR SIGNALS (0.7.0): the local counter's keys and counts per stretch, joined on `stretch_ref`,
 * with the rubric's version. Read on this computer by count-behaviour.mjs --stretch-signals, which sends nothing; a
 * counter that is missing, fails or answers cut leaves the archive without signals and says so, never half of them.
 */
export function stretchSignals(here, say) {
  const counter = join(here, "count-behaviour.mjs");
  if (!existsSync(counter)) return null;
  const run = spawnSync(process.execPath, [counter, "--stretch-signals", "--months", "120"], { encoding: "utf8", maxBuffer: 1 << 29, env: { ...process.env, WORKTRUST_MCP_URL: "", WORKTRUST_MCP_TOKEN: "" } });
  const rows = (run.stdout ?? "").split("\n").filter((text) => text.startsWith("{")).map((text) => { try { return JSON.parse(text); } catch { return null; } });
  const end = rows.at(-1)?.stretch_signals_end;
  if (run.status !== 0 || !Number.isInteger(end) || end !== rows.length - 1) { say("  The behaviour counter did not answer whole, so these lines carry no signals; the next run adds them to new lines."); return null; }
  return new Map(rows.slice(0, -1).filter(Boolean).map((row) => [row.stretch_ref, row]));
}
const SIGNAL = /^[a-zA-Z][A-Za-z0-9._-]{1,63}$/;
export function archiveLine(entry, behaviour = null, { ids = {}, collector, salt = null } = {}) {
  if (typeof entry?.client !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.client) || !ISO.test(entry.started_at ?? "") || !ISO.test(entry.at ?? "") || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.stretch_ref ?? "")) return null;
  const line = { client: entry.client, day: entry.started_at.slice(0, 10), started_at: entry.started_at, ended_at: entry.at };
  for (const key of COUNTS) if (typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0) line[key] = entry[key];
  if (typeof entry.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,63}$/.test(entry.model)) line.model = entry.model;
  for (const key of WORDS) if (typeof entry[key] === "string" && WORD.test(entry[key])) line[key] = entry[key];
  if (Array.isArray(entry.layers) && entry.layers.length > 1 && entry.layers.every((word) => typeof word === "string" && WORD.test(word))) line.layers = entry.layers.slice(0, 8);
  if (typeof entry.exchanges === "number" && Number.isInteger(entry.exchanges) && entry.exchanges > 0) line.exchanges = entry.exchanges;
  // The computer's offset from UTC when the stretch began (0.6.18), so a working day can be read in local time.
  if (typeof entry.utc_offset === "string" && /^[+-]\d{2}:\d{2}$/.test(entry.utc_offset)) line.utc_offset = entry.utc_offset;
  // Commit hashes the stretch made, never a message: what ties AI time to delivered work in the repository.
  if (Array.isArray(entry.commits) && entry.commits.length > 0 && entry.commits.every((sha) => typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha))) line.commits = entry.commits.slice(0, 50);
  // The project as a one-way hash of its name (owner/name, else the folder's own name): which days belong together, never which project.
  const name = entry.repo ?? entry.folder;
  // KEYED (0.8.6, audit S6): with this computer's own secret (~/.worktrust/archive-salt, never in the archive) a guessed
  // repository name can no longer be tested against the archive; without one the plain hash, as before.
  if (typeof name === "string" && name) line.project = salt ? createHmac("sha256", salt).update(`worktrust-project|${name}`).digest("hex") : sha256(`worktrust-project|${name}`);
  // VERIFICATION AND DELIVERY (0.7.1): per kind of check [ran, failed], per delivery step a count, and whether a check had
  // passed before the first; known kinds and whole numbers only, a failure count never above its runs.
  const whole = (value) => Number.isInteger(value) && value >= 0 && value <= 100000;
  if (entry.verification && typeof entry.verification === "object") {
    const kept = Object.entries(entry.verification).filter(([kind, tally]) => CHECK_KINDS.includes(kind) && Array.isArray(tally) && tally.length === 2 && tally.every(whole) && tally[1] <= tally[0] && tally[0] > 0).sort();
    if (kept.length > 0) line.verification = Object.fromEntries(kept);
  }
  // UNCONFIRMED (0.8.5): checks run whose outcome no reader could see, per kind, whole counts.
  if (entry.unconfirmed && typeof entry.unconfirmed === "object") {
    const kept = Object.entries(entry.unconfirmed).filter(([kind, count]) => CHECK_KINDS.includes(kind) && whole(count) && count > 0).sort();
    if (kept.length > 0) line.unconfirmed = Object.fromEntries(kept);
  }
  if (entry.delivery && typeof entry.delivery === "object") {
    const kept = Object.entries(entry.delivery).filter(([kind, count]) => DELIVERY_KINDS.includes(kind) && whole(count) && count > 0).sort();
    if (kept.length > 0) line.delivery = { ...Object.fromEntries(kept), verified_first: entry.delivery.verified_first === true };
  }
  // RECOVERY (0.7.2): failures, recoveries, blind retries, changed strategies and the middle time to recover, whole numbers.
  if (entry.recovery && typeof entry.recovery === "object") {
    const { failures, recovered, blind_retries: blind, strategy_changed: changed, median_seconds: median } = entry.recovery;
    if ([failures, recovered, blind, changed].every(whole) && failures > 0 && recovered <= failures && blind + changed <= failures && (median === undefined || whole(median))) line.recovery = { failures, recovered, blind_retries: blind, strategy_changed: changed, ...(median !== undefined ? { median_seconds: median } : {}) };
  }
  // DELEGATION (0.7.3): the longest and middle chain of the agent's own actions between the person's steps, questions, plans.
  if (entry.delegation && typeof entry.delegation === "object") {
    const { chain_max: most, chain_median: middle, questions, plans } = entry.delegation;
    if ([most, middle, questions, plans].every(whole) && most > 0 && middle <= most) line.delegation = { chain_max: most, chain_median: middle, questions, plans };
  }
  // CONTEXT AND ROUTING (0.7.4): compactions and the known context commands; how many models, how many switches.
  const COMMANDS = ["compact", "clear", "resume", "context", "model", "memory"];
  if (entry.context && typeof entry.context === "object" && whole(entry.context.compactions)) {
    const commands = Object.entries(entry.context.commands ?? {}).filter(([name, count]) => COMMANDS.includes(name) && whole(count) && count > 0).sort();
    if (entry.context.compactions > 0 || commands.length > 0) line.context = { compactions: entry.context.compactions, ...(commands.length ? { commands: Object.fromEntries(commands) } : {}) };
  }
  if (entry.routing && typeof entry.routing === "object" && whole(entry.routing.models) && whole(entry.routing.switches) && entry.routing.models > 0) line.routing = { models: entry.routing.models, switches: entry.routing.switches };
  // STEERING (0.7.5): moments the person stepped in, how many changed the agent's course, how many led to a passing check.
  if (entry.steering && typeof entry.steering === "object") {
    const { moments, changed_course: changed, effective } = entry.steering;
    if ([moments, changed, effective].every(whole) && moments > 0 && changed <= moments && effective <= changed) line.steering = { moments, changed_course: changed, effective };
  }
  // TOOL BREADTH AND COMPLEXITY (0.7.6): distinct tools; a class C1–C5 with its points and the rule's version.
  if (whole(entry.tools) && entry.tools > 0) line.tools = entry.tools;
  if (entry.complexity && /^C[1-5]$/.test(entry.complexity.class ?? "") && whole(entry.complexity.points) && /^complexity\/\d+$/.test(entry.complexity.rule ?? "")) line.complexity = { class: entry.complexity.class, points: entry.complexity.points, rule: entry.complexity.rule };
  // OVERSIGHT, PLANNING AND CHANGES (0.8.1): refusals by the person and by a guard; the agent's to-do lists; files changed and test files among them.
  const pick = (record, keys) => (record && typeof record === "object" && keys.every((key) => whole(record[key])) ? Object.fromEntries(keys.map((key) => [key, record[key]])) : null);
  const oversight = pick(entry.oversight, ["refused", "plans_rejected", "guard_denied"]);
  if (oversight) line.oversight = oversight;
  const planning = pick(entry.planning, ["lists", "items_max", "items_last", "done_last"]);
  if (planning && planning.lists > 0 && planning.done_last <= planning.items_last && planning.items_last <= planning.items_max) line.planning = planning;
  const changes = pick(entry.changes, ["files", "test_files"]);
  if (changes && changes.test_files <= changes.files) line.changes = changes;
  // AUTONOMY AND AUTHORSHIP (0.8.7): the permission mode on one scale; commits and those naming an AI as co-author.
  if (entry.autonomy && ["ask", "edits", "plan", "auto", "full"].includes(entry.autonomy.mode) && whole(entry.autonomy.switches) && whole(entry.autonomy.plan_turns)) line.autonomy = { mode: entry.autonomy.mode, switches: entry.autonomy.switches, plan_turns: entry.autonomy.plan_turns };
  const authorship = pick(entry.authorship, ["commits", "ai_coauthored"]);
  if (authorship && authorship.commits > 0 && authorship.ai_coauthored <= authorship.commits) line.authorship = authorship;
  // PRACTICE (0.8.8): framing, verification quality, risk, tool mix, re-reads, context files; whole counts and flags only.
  const bool = (value) => value === true || value === false;
  if (entry.framing && whole(entry.framing.turns_before_action) && bool(entry.framing.planned_first)) line.framing = { turns_before_action: entry.framing.turns_before_action, planned_first: entry.framing.planned_first };
  if (entry.quality && whole(entry.quality.fix_cycles_max) && (bool(entry.quality.checked_after_change) || entry.quality.checked_after_change === null) && (bool(entry.quality.inspected_first) || entry.quality.inspected_first === null)) line.quality = { checked_after_change: entry.quality.checked_after_change, fix_cycles_max: entry.quality.fix_cycles_max, inspected_first: entry.quality.inspected_first };
  const risk = pick(entry.risk, ["proposed", "refused", "run"]);
  if (risk && risk.proposed > 0 && risk.refused + risk.run <= risk.proposed) line.risk = risk;
  const keyed = (record, keys) => { const kept = Object.entries(record && typeof record === "object" ? record : {}).filter(([key, n]) => keys.includes(key) && whole(n) && n > 0).sort(); return kept.length ? Object.fromEntries(kept) : null; };
  const mix = keyed(entry.tool_mix, ["search", "read", "edit", "shell", "agent", "web", "data", "mcp", "plan", "other"]);
  if (mix) line.tool_mix = mix;
  const reads = pick(entry.reads, ["repeated"]);
  if (reads) line.reads = reads;
  const files = keyed(entry.context_files, ["instructions", "skills", "agents", "commands", "settings", "mcp"]);
  if (files) line.context_files = files;
  // The behaviour signals of this stretch (0.7.0): keys of the counter's rubric and whole counts, never a word of a turn.
  if (behaviour && behaviour.signals && typeof behaviour.analyzer_version === "string" && /^counter@\d+\.\d+\.\d+$/.test(behaviour.analyzer_version)) {
    const kept = Object.entries(behaviour.signals).filter(([key, count]) => SIGNAL.test(key) && Number.isInteger(count) && count > 0).sort();
    if (kept.length > 0) { line.signals = Object.fromEntries(kept); line.analyzer_version = behaviour.analyzer_version; }
  }
  return { ...line, stretch_ref: entry.stretch_ref, ...ids, collector_version: collector };
}


/**
 * THE ARCHIVE AS HISTORY (0.8.0; framework §22: "preserve as evidence continuity"). The lines of an archive this
 * computer wrote AND signed (a day whose proof carries this computer's key), as `import_history` entries, each marked
 * `from_archive` so the record shows it came from the person's own archive after the AI app had deleted the session.
 * The caller verifies the archive first, sends only stretches whose session is gone, and only to a door that knows the
 * mark. Nothing here sends.
 */
const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const readdir = (dir) => { try { return readdirSync(dir); } catch { return []; } };
export function archiveEntries(dir, ownKey) {
  const out = [];
  for (const year of readdir(dir).filter((name) => /^\d{4}$/.test(name)).sort()) for (const month of readdir(join(dir, year)).filter((name) => /^\d{2}$/.test(name)).sort()) {
    const file = join(dir, year, month, "stretches.jsonl");
    if (!existsSync(file)) continue;
    for (const text of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      let line; try { line = JSON.parse(text); } catch { continue; }
      if (line.supplements) continue; // a supplement adds fields to a stretch, it is no stretch of its own
      const proof = read(join(dir, "proofs", `${line.day}.json`));
      if (!ownKey || !proof || typeof proof.signature !== "string" || proof.public_key !== ownKey) continue;
      const entry = {
        title: line.layer ? `AI-assisted work · ${line.layer}` : "AI-assisted work",
        ...(line.kind ? { kind: line.kind } : {}), ...(line.layer ? { layer: line.layer } : {}), ...(line.layers ? { layers: line.layers } : {}),
        ...(typeof line.seconds === "number" ? { seconds: line.seconds, duration_basis: line.duration_basis ?? "measured" } : {}),
        ...Object.fromEntries(["tokens_in", "tokens_out", "token_basis", "tokens_cache_read", "tokens_cache_write", "exchanges", "turn_basis", "model", "steered_from", "model_seconds", "tool_seconds", "human_seconds", "idle_seconds", "agent_runs", "agent_seconds", "agent_peak", "interrupts", "steers", "utc_offset"].filter((key) => line[key] !== undefined).map((key) => [key, line[key]])),
        stretch_ref: line.stretch_ref, started_at: line.started_at, at: line.ended_at, from_archive: true,
      };
      out.push({ entry, client: line.client ?? "claude" });
    }
  }
  return out;
}

/**
 * A SUPPLEMENT FOR A STRETCH ALREADY ARCHIVED (0.8.2). The archive only grows: a line is never rewritten. When a newer
 * CLI measures more of a stretch that is already in it (verification, recovery, the signals …), the new fields go into
 * a line of their own that names the stretch it adds to (`supplements`) and carries only what no earlier line of that
 * stretch carries, in the same chain, under the same day's root. Null when there is nothing new.
 */
export const DERIVED_KEYS = ["signals", "analyzer_version", "verification", "unconfirmed", "delivery", "recovery", "delegation", "context", "routing", "steering", "tools", "complexity", "oversight", "planning", "changes", "autonomy", "authorship", "framing", "quality", "risk", "tool_mix", "reads", "context_files", "interrupts", "steers", "utc_offset"];
export function supplementFor(line, earlier) {
  const missing = DERIVED_KEYS.filter((key) => line[key] !== undefined && !earlier.some((old) => old[key] !== undefined));
  if (missing.length === 0) return null;
  const { device_id: device, profile_id: profile } = line;
  return { client: line.client, day: line.day, started_at: line.started_at, ended_at: line.ended_at, supplements: line.stretch_ref, ...Object.fromEntries(missing.map((key) => [key, line[key]])), ...(device ? { device_id: device } : {}), ...(profile ? { profile_id: profile } : {}), collector_version: line.collector_version };
}
