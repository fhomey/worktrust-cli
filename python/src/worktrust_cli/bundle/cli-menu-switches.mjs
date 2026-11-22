/**
 * THE KEYBOARD'S SWITCHES IN THE MENU (CLI 0.11.21; owner, 2026-11-22: "every keyboard command must also be in the menu, easy to
 * find and switch"). Pure rows: each says its live state, its command as the muted hint, one sentence of at most 60 characters,
 * and RUNS THAT COMMAND (the caller's `run(args)`: runShown, a child of this CLI, so the same code path as typed, with its own
 * questions and refusals; there is no second implementation here). What cannot be switched yet is drawn, dimmed, with why
 * (`quiet`, one sentence): steering needs read along, voice needs steering, reading answers aloud needs voice. The menu itself
 * only opens in a person's terminal (cli-menu.mjs menuWanted: never --yes, --json, a pipe or an agent's shell).
 */
const word = (on) => (on ? "on" : "off");
const not = (quiet) => ({ disabled: true, quiet, note: { text: "later", tone: "dim" } });

/** `s`: the remote settings (remote-store.mjs loadSettings). → the four rows for Remote Agent ›. */
export function switchItems(s, run = () => true) {
  const reading = s?.desk_history === true && s?.desk_live === true;
  const steering = reading && s?.desk_steer === true, voice = steering && s?.voice === true, aloud = voice && s?.voice_read === true;
  return [
    { label: `Read along: ${word(reading)}`, hint: `npx worktrust remote read-along ${reading ? "off" : "on"}`, info: reading ? "Phones read your sessions here live. Enter stops it." : "Lets your phones read sessions here live, read-only.", run: () => run(["remote", "read-along", reading ? "off" : "on"]) },
    { label: `Steer from the phone: ${word(steering)}`, hint: `npx worktrust remote desk-steer ${steering ? "off" : "on"}`, info: steering ? "Phone prompts reach open sessions. Enter stops it." : "Phone prompts into open sessions; restart them to take it.", run: () => run(["remote", "desk-steer", steering ? "off" : "on"]), ...(reading || steering ? {} : not("Turn on read along first.")) },
    { label: `Voice prompts with Siri: ${word(voice)}`, hint: `npx worktrust remote voice ${voice ? "off" : "on"}`, info: voice ? "Siri sends spoken prompts here. Enter stops it." : "Lets your phone's Siri send a spoken prompt here.", run: () => run(["remote", "voice", voice ? "off" : "on"]), ...(steering || voice ? {} : not("Turn on steering from the phone first.")) },
    { label: `Read answers aloud: ${word(aloud)}`, hint: `npx worktrust remote voice read ${aloud ? "off" : "on"}`, info: aloud ? "Siri reads replies aloud. Enter stops it." : "Lets Siri read a reply aloud on your phone.", run: () => run(["remote", "voice", "read", aloud ? "off" : "on"]), ...(voice || aloud ? {} : not("Turn on voice prompts first.")) },
  ];
}

/** Roots for new projects ›: the default folder for new sessions (remote-default-root.mjs), `on` its live state; a short label so its command fits 80 columns. */
export function defaultRootItem(on, run = () => true) {
  return { label: `Desktop/WorkTrust: ${word(on)}`, hint: `npx worktrust remote roots default ${on ? "off" : "on"}`, info: on ? "Off keeps the folder and its projects. Enter turns it off." : "A phone's New session makes projects in ~/Desktop/WorkTrust.", run: () => run(["remote", "roots", "default", on ? "off" : "on"]) };
}
