/**
 * WHAT AN ARCHIVE LINE MAY CARRY (split from preserve.mjs, CLI 0.7.1): the allowlist, each value checked for its type,
 * and the behaviour signals joined on `stretch_ref`. A key not named here never reaches the archive. The capability
 * tranches (docs/CAPABILITY-EVIDENCE-ROADMAP.md) add their fields here, each with its own check.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const CHECK_KINDS = ["test", "typecheck", "lint", "build", "gate", "ci"], DELIVERY_KINDS = ["commit", "pr", "push", "deploy"];

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
export function archiveLine(entry, behaviour = null, { ids = {}, collector } = {}) {
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
  if (typeof name === "string" && name) line.project = sha256(`worktrust-project|${name}`);
  // VERIFICATION AND DELIVERY (0.7.1): per kind of check [ran, failed], per delivery step a count, and whether a check had
  // passed before the first; known kinds and whole numbers only, a failure count never above its runs.
  const whole = (value) => Number.isInteger(value) && value >= 0 && value <= 100000;
  if (entry.verification && typeof entry.verification === "object") {
    const kept = Object.entries(entry.verification).filter(([kind, tally]) => CHECK_KINDS.includes(kind) && Array.isArray(tally) && tally.length === 2 && tally.every(whole) && tally[1] <= tally[0] && tally[0] > 0).sort();
    if (kept.length > 0) line.verification = Object.fromEntries(kept);
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
  // The behaviour signals of this stretch (0.7.0): keys of the counter's rubric and whole counts, never a word of a turn.
  if (behaviour && behaviour.signals && typeof behaviour.analyzer_version === "string" && /^counter@\d+\.\d+\.\d+$/.test(behaviour.analyzer_version)) {
    const kept = Object.entries(behaviour.signals).filter(([key, count]) => SIGNAL.test(key) && Number.isInteger(count) && count > 0).sort();
    if (kept.length > 0) { line.signals = Object.fromEntries(kept); line.analyzer_version = behaviour.analyzer_version; }
  }
  return { ...line, stretch_ref: entry.stretch_ref, ...ids, collector_version: collector };
}

