/**
 * WHAT THIS COMPUTER'S AGENTS CAN DO, MEASURED (2026-11-07; "adapters report; the UI believes only reports"). Each agent
 * CLI is found on the agents' PATH and asked for its version and its own help; a capability is reported only when the
 * help names it, and a model list only when the agent has a lister its help names (`codex debug models`, `opencode models`,
 * `cursor-agent models`). Claude Code has no lister: since 2026-11-08 (owner: the phone chooses Claude's models as it
 * does Codex's) its models are the ALIASES its own --model help names ("an alias for the latest model (e.g. 'fable',
 * 'opus', or 'sonnet')"), read from this computer's version, each a value `claude --model` takes; a help without that
 * line lists nothing ("not listed"), never a guess. Claude Code and Codex have adapters; the others report "installed, no
 * adapter yet" (every capability false).
 *
 * No shell: each probe is execFile with fixed arguments, a timeout and no input. Nothing here leaves the computer except
 * inside a sealed device.inventory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { codexReport } from "./remote-adapter-codex.mjs";
import { terminalReport, tmuxVersion } from "./remote-adapter-terminal.mjs";
import { typingTrusted } from "./remote-screen-states.mjs";

const NO = Object.freeze({ start: false, attach: false, prompt: false, steer: false, pause: false, resume: false, stop: false, structured_events: false, screen: false, focus: false, resume_by_id: false, permission_modes: ["ask"], approvals: "none", acceptance: "acknowledged" });
export const AGENTS = Object.freeze({ "claude-code": "claude", codex: "codex", "cursor-agent": "cursor-agent", opencode: "opencode" });

export function findOnPath(bin, path = process.env.PATH ?? "") {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]) {
      const file = join(dir, name);
      try { if (existsSync(file) && statSync(file).isFile()) return file; } catch { /* unreadable */ }
    }
  }
  return null;
}

function probe(file, args, env, timeout = 10_000) {
  const out = spawnSync(file, args, { encoding: "utf8", timeout, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return out.status === 0 ? `${out.stdout ?? ""}` : null;
}

/** The --permission-mode choices Claude Code's help lists. */
export const permissionChoices = (help) => (/--permission-mode <mode>[\s\S]*?\(choices: ([^)]*)\)/.exec(help ?? "")?.[1].match(/"([a-zA-Z]+)"/g) ?? []).map((q) => q.slice(1, -1));

/**
 * Claude Code, from its own help: the flags the adapter needs, each read, never assumed. `askMode` is the mode that asks
 * for every permission the person's rules do not decide ("manual" in 2.1.x, "default" before), `planMode` the read-only one.
 */
export function claudeFeatures(help) {
  const h = help ?? "", choices = permissionChoices(h);
  return {
    askMode: choices.includes("manual") ? "manual" : choices.includes("default") ? "default" : null,
    planMode: choices.includes("plan") ? "plan" : null,
    streamJson: /--input-format[\s\S]{0,200}stream-json/.test(h) && /--output-format[\s\S]{0,300}stream-json/.test(h),
    permissionTool: /--permission-prompt-tool/.test(h),
    mcpConfig: /--mcp-config/.test(h),
    sessionId: /--session-id/.test(h),
    resume: /--resume/.test(h),
    partial: /--include-partial-messages/.test(h),
    disallowed: /--disallowedTools/.test(h),
    settingSources: /--setting-sources/.test(h),
    replay: /--replay-user-messages/.test(h),
    // The agent's planning tools run without a prompt (they only write a plan), and one line says to use them (2026-11-08).
    allowed: /--allowedTools/.test(h),
    appendPrompt: /--append-system-prompt/.test(h),
  };
}

/** The model aliases Claude Code's own --model help names, in its order; none when the help names none. */
export function claudeAliases(help) {
  const block = /--model <model>([\s\S]*?)(?=\n\s{2}-|\n\s*\n|$)/.exec(help ?? "")?.[1]?.replace(/\s+/g, " ") ?? "";
  const named = /\balias\b[^(]*\(e\.g\.([^)]*)\)/i.exec(block)?.[1] ?? "";
  return [...new Set([...named.matchAll(/'([a-z][a-z0-9.-]{0,39})'/g)].map((m) => m[1]))].slice(0, P.MAX_MODELS_PER_ADAPTER);
}

export function claudeReport(version, help, now = Date.now()) {
  const f = claudeFeatures(help);
  // The adapter starts only when every piece it relies on is there: stream-json both ways, approvals routed to our tool,
  // the session id chosen before the start (so the steered ledger names it first), and an asking mode.
  const usable = Boolean(f.askMode && f.streamJson && f.permissionTool && f.mcpConfig && f.sessionId && f.disallowed && f.settingSources);
  const capabilities = usable
    ? { ...NO, start: true, prompt: true, stop: true, structured_events: true, resume_by_id: f.resume, permission_modes: f.planMode ? ["ask", "plan"] : ["ask"], approvals: "structured",
      // A live steer needs the replay that confirms it was read; the interrupt is stream-json's control request (2.1.286).
      steer: true, steer_mode: f.replay ? "live" : "queued", interrupt: f.replay }
    : NO;
  const aliases = claudeAliases(help);
  const models = aliases.length ? { models: aliases, models_status: "listed", models_at: now } : { models: null, models_status: "not_listed", models_at: null };
  return { adapter: "claude-code", mode: "structured", installed: true, version: version ? version.trim().slice(0, 200) : null, signed_in: null, capabilities, ...models, default_model: null };
}

function listModels(adapter, file, env, now) {
  const help = adapter === "codex" ? probe(file, ["debug", "--help"], env) : probe(file, ["--help"], env);
  if (!help || !/^\s+models\b/m.test(help)) return { models: null, models_status: "not_listed", models_at: null };
  const out = adapter === "codex" ? probe(file, ["debug", "models"], env, 20_000) : probe(file, ["models"], env, 20_000);
  if (out === null) return { models: null, models_status: "lister_failed", models_at: null };
  let names = [];
  if (adapter === "codex") { try { names = (JSON.parse(out).models ?? []).filter((m) => m?.visibility !== "hide").map((m) => m?.slug); } catch { return { models: null, models_status: "lister_failed", models_at: null }; } }
  else names = out.split("\n").map((l) => l.trim()).filter((l) => l && !/\s/.test(l));
  const models = [...new Set(names.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 128))].slice(0, P.MAX_MODELS_PER_ADAPTER);
  return { models, models_status: "listed", models_at: now };
}

let cache = null;
/** Every known agent: installed or not, version, capabilities, models. `refresh` re-runs the probes and the listers. */
export function inventory({ env = process.env, refresh = false, now = Date.now() } = {}) {
  if (cache && !refresh) return cache;
  const reports = [], features = {};
  for (const [adapter, bin] of Object.entries(AGENTS)) {
    const file = findOnPath(bin, env.PATH);
    if (!file) { reports.push({ adapter, mode: "structured", installed: false, version: null, signed_in: null, capabilities: NO, models: null, models_status: "not_listed", models_at: null, default_model: null }); continue; }
    const version = probe(file, ["--version"], env);
    if (adapter === "claude-code") { const help = probe(file, ["--help"], env); features["claude-code"] = claudeFeatures(help); reports.push(claudeReport(version, help, now)); continue; }
    // Codex (2026-11-07): its app-server, when this version has one (remote-adapter-codex.mjs); models from `codex debug models`.
    const codex = adapter === "codex" ? codexReport(version, probe(file, ["app-server", "--help"], env)) : null;
    reports.push({ adapter, mode: "structured", installed: true, version: version ? version.trim().slice(0, 200) : null, signed_in: null, capabilities: codex?.usable ? { ...NO, ...codex.capabilities } : NO, ...listModels(adapter, file, env, now), default_model: null });
  }
  for (const report of reports) {
    const checked = P.validateAdapterReport(report);
    if (!checked.ok) throw new Error(`inventory: ${report.adapter}: ${checked.detail}`);
  }
  // Claude Code in a terminal (release 19): tmux on its own socket. Kept beside the reports, sent only when turned on (offered).
  const tmux = findOnPath("tmux", env.PATH), claude = reports.find((r) => r.adapter === "claude-code");
  const terminal = terminalReport({ claude: claude?.installed ? { ...claude, features: features["claude-code"] } : null, tmux: tmux ? tmuxVersion(probe(tmux, ["-V"], env)) : null });
  const checkedTerminal = P.validateAdapterReport(terminal);
  if (!checkedTerminal.ok) throw new Error(`inventory: claude-code (terminal): ${checkedTerminal.detail}`);
  cache = { reports, features, terminal, files: { ...Object.fromEntries(Object.keys(AGENTS).map((a) => [a, findOnPath(AGENTS[a], env.PATH)])), tmux }, at: now };
  return cache;
}
export const adapterOf = (inv, id) => inv.reports.find((r) => r.adapter === id);

/**
 * What this computer OFFERS a phone (review 2026-11-07, P1-3): Codex runs the reads it deems safe without asking, so
 * a phone's prompt could have it read a secret file before the computer can refuse it. Codex is offered only after the
 * person turned it on at the keyboard (`worktrust remote codex on`, settings.codex), the gap stated; until then it is
 * listed as installed and offered nothing.
 */
export function offered(inv, settings) {
  const reports = settings?.codex === true ? inv.reports : inv.reports.map((r) => (r.adapter === "codex" && r.capabilities.start ? { ...r, capabilities: NO } : r));
  // Terminal sessions (release 19) only after `worktrust remote terminal on`: an older phone refuses a second report of one adapter.
  // Typing from a phone only on a screen detector whose fixtures were recorded from the real agent (remote-screen-states.mjs).
  // Answering its dialogs from a phone (screen-hash approvals) needs the same: approvals "screen" only then.
  const terminal = inv.terminal?.capabilities.start && typingTrusted("claude-code") ? { ...inv.terminal, capabilities: { ...inv.terminal.capabilities, prompt: true, approvals: "screen" } } : inv.terminal;
  return { ...inv, reports: settings?.terminal === true && terminal ? [...reports, terminal] : reports };
}
