/**
 * WHAT LINKING A PHONE TURNS ON, WITHOUT A QUESTION (CLI 0.11.26; the owner, 2026-11-25: "combine steering and reading along so
 * that they are ON automatically and NOT asked"). Replaces the read-along question of 0.11.19 (2026-11-21, "offered at pairing")
 * and the voice switch that stayed OFF until typed (2026-11-19). docs/remote-agents/DESK-STEERING.md, VOICE-SIRI.md.
 *
 *   the three     read along (`desk_live`, with the closed turns), steering from the phone (`desk_steer`, with WorkTrust's steer
 *                 mod written into Claude Code's settings here) and voice prompts with Siri (`voice`), in that order: each needs
 *                 the one before it, and with voice reading answers aloud (`voice_read`; owner, 2026-11-25: Siri on is all of
 *                 its functions; each phone still turns its own "Read answers aloud" on). Turned on through the keyboard's one
 *                 door (remote-settings.mjs applySettingsChange, `{ kind: "keyboard" }`), never written here.
 *   when          right after "✓ Phone linked" at this keyboard (`remote app`, `remote web`, `remote pair`) and after a phone was
 *                 confirmed here (`remote phones confirm`): switchesAtLink. A computer linked BEFORE this release: at the end of
 *                 the next `npx worktrust update` a person runs in a terminal (switchesAfterUpdate). Nothing else turns them on.
 *   who           a person at this terminal (remote-keyboard.mjs personAtKeyboard: both ends a TTY, not an AI agent's shell).
 *                 `--yes` changes nothing at a link (there is no question left to answer); at an update, `--yes`, `--json` and
 *                 the self-update (no terminal, `update --yes`) change nothing.
 *   an off stays  what the person turned off HERE (remote-store.mjs chosen.json, written by their own `read-along off`,
 *                 `desk-history off`, `desk-steer off`, `voice off`, `voice read off`, never by this module) is never turned back on; one that
 *                 needs it stays off with it.
 *   the mod       written before the switch (atomic, with the backup remote-steer-mod.mjs keeps); when it cannot be written, read
 *                 along stays on, steering and voice stay off, the link still succeeds, and the block says why in one line.
 *   said          one block of four lines and the commands to turn them off; mirrored on the phone that linked as four
 *                 informational steps (remote-setup.mjs): done, or skipped with why (`turned_off`, `unavailable`).
 *
 * NEVER FROM ANYWHERE ELSE: imported by remote-cli.mjs and, for the update, by worktrust.mjs alone. No daemon module, no settings
 * change from the app or the web, no phone, browser or MCP door reaches it (check-remote-cli rules R and W).
 */
import { homedir } from "node:os";
import { applySettingsChange } from "./remote-settings.mjs";
import { personAtKeyboard } from "./remote-keyboard.mjs";
import { steerOff } from "./remote-desk-steer.mjs";
import { voiceOff } from "./remote-voice.mjs";
import { installSteerMod, steerModInstalled, uninstallSteerMod } from "./remote-steer-mod.mjs";
import { deskReadOf, loadChosen, loadIdentity, loadPhones, loadSettings } from "./remote-store.mjs";

export const READ_ALONG_COMMAND = "npx worktrust remote read-along on";
/** In the order they depend on each other; `what` is the settings door's change, `command` what a person types. */
export const SWITCHES = Object.freeze([
  { name: "read_along", what: "desk_live", label: "Read along", command: "read-along", note: "" },
  { name: "desk_steering", what: "desk_steer", label: "Steering from your phone", command: "desk-steer", note: " (WorkTrust's steering mod added to Claude Code)", needs: "read along" },
  { name: "voice", what: "voice", label: "Voice prompts with Siri", command: "voice", note: "", needs: "steering from your phone" },
  // Owner, 2026-11-25: Siri on is all of it. The settings door brings reading aloud with voice (unless `voice read off` was typed);
  // here it is turned on for a computer whose voice was already on, and said.
  { name: "voice_read", what: "voice_read", label: "Read answers aloud", command: "voice read", note: "", needs: "voice prompts with Siri" },
]);
export const switchOn = (name, settings) => (name === "read_along" ? deskReadOf(settings) === "live" : name === "desk_steering" ? !steerOff(settings) : name === "voice" ? !voiceOff(settings) : !voiceOff(settings) && settings?.voice_read === true);

/** Why Claude Code's settings could not take the mod, in a few words (never the file's content). */
export function modWhy(error) {
  if (error instanceof SyntaxError) return "Claude Code's settings file (~/.claude/settings.json) is not valid JSON, so it was left as it is";
  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") return "Claude Code's settings could not be written here (no permission)";
  return `Claude Code's settings could not be written (${error?.code ?? "error"})`;
}

/**
 * Each switch in order: already on, turned off here by the person, waiting on the one before it, or turned on now through the
 * keyboard's door (steering: the mod first, the switch after it). → [{ name, state: "on" | "was_on" | "chosen_off" | "needs" |
 * "failed" | "mod_missing", why? }]
 */
function turnOn(home) {
  const chosen = loadChosen(), out = [];
  for (const sw of SWITCHES) {
    const before = out.at(-1), ready = !before || before.state === "on" || before.state === "was_on" || before.state === "mod_missing";
    if (switchOn(sw.name, loadSettings())) {
      if (sw.name === "desk_steering" && !steerModInstalled(home)) { try { installSteerMod(home); } catch (error) { out.push({ name: sw.name, state: "mod_missing", why: modWhy(error) }); continue; } }
      out.push({ name: sw.name, state: "was_on" }); continue;
    }
    if (chosen[sw.name] === "off") { out.push({ name: sw.name, state: "chosen_off" }); continue; }
    if (!ready) { out.push({ name: sw.name, state: "needs" }); continue; }
    if (sw.name === "desk_steering") {
      try { installSteerMod(home); } catch (error) { try { uninstallSteerMod(home); } catch { /* nothing of ours is named there */ } out.push({ name: sw.name, state: "failed", why: modWhy(error) }); continue; }
    }
    const done = applySettingsChange({ what: sw.what, on: true }, { kind: "keyboard" });
    if (!done.ok) { if (sw.name === "desk_steering") { try { uninstallSteerMod(home); } catch { /* as above */ } } out.push({ name: sw.name, state: "failed", why: done.reason }); continue; }
    out.push({ name: sw.name, state: "on" });
  }
  return out;
}

const SW = Object.fromEntries(SWITCHES.map((s) => [s.name, s]));
export function lineOf(r) {
  const s = SW[r.name], again = `npx worktrust remote ${s.command} on`;
  if (r.state === "on" || r.state === "was_on") return `  ✓ ${s.label}: on${s.note}`;
  if (r.state === "mod_missing") return `  ! ${s.label}: on, but its mod is missing: ${r.why} (${again} writes it again)`;
  if (r.state === "chosen_off") return `  · ${s.label}: off, as you turned it off here (on again: ${again})`;
  if (r.state === "needs") return `  · ${s.label}: off (it needs ${s.needs} on)`;
  return `  ! ${s.label}: off: ${r.why} (again: ${again})`;
}
/** The block: one line a switch, then how to turn off what is on. */
export function blockLines(results) {
  const on = results.filter((r) => r.state === "on" || r.state === "was_on" || r.state === "mod_missing").map((r) => `${SW[r.name].command} off`);
  return [...results.map(lineOf), ...(on.length ? [`  Turn ${on.length === 1 ? "it" : "any of them"} off: npx worktrust remote ${on.join(" | ")}`] : [])];
}
/** The phone that linked sees each as an informational step (remote-setup.mjs). */
function mirror(io, results) {
  for (const r of results) {
    if (r.state === "chosen_off") io.setup?.skipped(r.name, "turned_off");
    else if (r.state === "needs" || r.state === "failed") io.setup?.skipped(r.name, "unavailable");
    else io.setup?.done(r.name);
  }
}

/** Right after "✓ Phone linked" (remote-cli.mjs linkAndGrant) and `remote phones confirm`. `io.tty` is the tests' seam. */
export function switchesAtLink(io, { home = homedir(), env = process.env } = {}) {
  if (!personAtKeyboard(io, env)) {
    if (SWITCHES.some((s) => !switchOn(s.name, loadSettings()))) io.say(`  Read along, steering and voice were not turned on: that happens when a phone is linked in your own terminal. Or: ${READ_ALONG_COMMAND}`);
    return "not_here";
  }
  const results = turnOn(home);
  io.say("");
  for (const line of blockLines(results)) io.say(line);
  mirror(io, results);
  return results;
}

/**
 * The end of `npx worktrust update` (worktrust.mjs), for a computer linked before this release: what was never chosen here is
 * turned on and the block is said; when nothing changed, nothing is said. Never fails the update.
 */
export function switchesAfterUpdate(io, { home = homedir(), env = process.env } = {}) {
  try {
    if (!loadIdentity() || loadPhones().confirmed.length === 0) return "not_paired";
    if (!personAtKeyboard(io, env) || io.has?.("yes") || io.has?.("json")) return "not_here";
    const results = turnOn(home);
    if (!results.some((r) => r.state === "on" || r.state === "failed")) return "nothing";
    io.say("");
    io.say("  Remote Agent: a linked phone now has these on by default (turned off here stays off):");
    for (const line of blockLines(results)) io.say(line);
    return results;
  } catch { return "failed"; }
}

/** `remote status`: what is off, and the command that turns it on. */
export function switchesOffLines(settings = loadSettings(), chosen = loadChosen()) {
  return SWITCHES.filter((s) => !switchOn(s.name, settings)).map((s) => `  Off: ${s.label[0].toLowerCase()}${s.label.slice(1)}${chosen[s.name] === "off" ? ", as you turned it off here" : ""} · on: npx worktrust remote ${s.command} on`);
}
