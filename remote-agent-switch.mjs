/**
 * `npx worktrust remote codex on | off` and `npx worktrust remote opencode on | off` (2026-11-07; OpenCode 2026-11-09, owner:
 * "the same on/off switch as Codex"). An agent that reads without asking is offered to a phone only after the person turned it
 * on at this keyboard, the gap stated and a typed yes; until then the inventory lists it as installed and offers it nothing
 * (remote-inventory.mjs `offered`, settings.codex / settings.opencode, off by default in remote-store.mjs).
 *
 *   agentSwitch(io, agent, rest, askTyped)    agent: "codex" | "opencode"
 */
import { loadSettings, saveSettings } from "./remote-store.mjs";

const AGENTS = {
  codex: { name: "Codex", gap: [
    "  Codex from a phone: it asks before every command it does not trust and every edit, and the computer classifies those.",
    "  But it runs the reads it deems safe (cat, rg, head, sed -n) WITHOUT asking. This computer ends a turn as soon as a",
    "  command reads a secret path (keys, .env, credentials), but by then the read has started. MCP servers a Codex plugin",
    "  brings still start. Claude Code has deny rules for those reads; Codex has none on this version."] },
  opencode: { name: "OpenCode", gap: [
    "  OpenCode from a phone: every command, edit, fetch and subagent is refused by OpenCode and comes to the computer, which",
    "  classifies it; secret files and paths outside the project are denied. But it reads the project's other files WITHOUT",
    "  asking, and OpenCode merges its configuration key by key, so an agent file the repository brings can loosen a rule.",
    "  MCP servers in your OpenCode configuration still start."] },
};

export async function agentSwitch(io, agent, rest, askTyped) {
  const { name, gap } = AGENTS[agent];
  const s = loadSettings();
  if (rest[0] === "off") { saveSettings({ ...s, [agent]: false }); io.say(`  ${name} is no longer offered to a phone.`); return; }
  if (rest[0] !== "on") { io.say(`  ${name} is ${s[agent] ? "on" : "off"} for remote. npx worktrust remote ${agent} on | off`); return; }
  for (const line of gap) io.say(line);
  if (!(await askTyped(`  Offer ${name} to your phones anyway? Type yes: `))) io.fail(`${name} stays off`);
  saveSettings({ ...s, [agent]: true });
  io.say(`  ✓ ${name} is offered to your phones. npx worktrust remote ${agent} off takes it back.`);
}
