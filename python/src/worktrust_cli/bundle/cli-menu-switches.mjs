/**
 * THE KEYBOARD'S SWITCHES IN THE MENU (CLI 0.11.21; owner, 2026-11-22: "every keyboard command must also be in the menu, easy to
 * find and switch"). Pure rows: each says its live state, its command as the muted hint, one sentence of at most 60 characters,
 * and RUNS THAT COMMAND (the caller's `run(args)`: runShown, a child of this CLI, so the same code path as typed, with its own
 * questions and refusals; there is no second implementation here). What cannot be switched yet is drawn, dimmed, with why
 * (`quiet`, one sentence): steering needs read along, voice needs steering, reading answers aloud needs voice. The menu itself
 * only opens in a person's terminal (cli-menu.mjs menuWanted: never --yes, --json, a pipe or an agent's shell).
 *
 * CLI 0.11.22 (owner, 2026-11-23): EVERY ON/OFF SWITCH ASKS FIRST. A switch row carries `confirm` (what it does, what changes
 * now, the question); Enter or its digit opens that step (cli-menu.mjs choose → confirmStep below), and only `y` runs the
 * command. Enter, n, Esc and Backspace change nothing. The step comes BEFORE the command, so a keyboard-only ON switch still
 * asks its own y/n there (remote-keyboard.mjs, after its terminal and agent-shell checks): this step never stands in for it. The four phone permissions live in
 * Remote Agent › Permissions ›, in the order each needs the one before (permissionsRow).
 */
const word = (on) => (on ? "on" : "off");
const not = (quiet) => ({ disabled: true, quiet, note: { text: "later", tone: "dim" } });

/** The step a switch asks first (0.11.22): `what` it does, what changes when it goes `toOn` (true) or off, and the question. */
export const ask = (name, what, onText, offText, toOn) => ({ name, what, change: toOn ? onText : offText, question: `Turn ${name} ${toOn ? "on" : "off"}?` });

/** `s`: the remote settings (remote-store.mjs loadSettings). → the four rows of Remote Agent › Permissions ›, each needing the one before. */
export function switchItems(s, run = () => true) {
  const reading = s?.desk_history === true && s?.desk_live === true;
  const steering = reading && s?.desk_steer === true, voice = steering && s?.voice === true, aloud = voice && s?.voice_read === true;
  return [
    { label: `Read along: ${word(reading)}`, hint: `npx worktrust remote read-along ${reading ? "off" : "on"}`, info: reading ? "Phones read your sessions here live. Enter stops it." : "Lets your phones read sessions here live, read-only.", run: () => run(["remote", "read-along", reading ? "off" : "on"]),
      confirm: ask("read along", "Your phones and browsers read the sessions open on this computer, live and read-only.", "They can read along from now on. You confirm with y at the next step.", "They stop reading along at once. Steering, voice and reading aloud go off with it.", !reading) },
    { label: `Steer from the phone: ${word(steering)}`, hint: `npx worktrust remote desk-steer ${steering ? "off" : "on"}`, info: steering ? "Phone prompts reach open sessions. Enter stops it." : "Phone prompts into open sessions; restart them to take it.", run: () => run(["remote", "desk-steer", steering ? "off" : "on"]), ...(reading || steering ? {} : not("Needs Read along: turn it on first.")),
      confirm: ask("steering from the phone", "A prompt from your phone goes into a session open on this computer.", "Phone prompts reach sessions you restart after this. You confirm with y at the next step.", "Phone prompts no longer reach open sessions. Voice prompts go off with it.", !steering) },
    { label: `Voice prompts with Siri: ${word(voice)}`, hint: `npx worktrust remote voice ${voice ? "off" : "on"}`, info: voice ? "Siri sends spoken prompts here. Enter stops it." : "Lets your phone's Siri send a spoken prompt here.", run: () => run(["remote", "voice", voice ? "off" : "on"]), ...(steering || voice ? {} : not("Needs Steer from the phone: turn it on first.")),
      confirm: ask("voice prompts", "Your phone's Siri sends a prompt you speak into the newest open session of a project.", "Siri can send spoken prompts from now on. You confirm with y at the next step.", "Siri can no longer send prompts here. Reading answers aloud goes off with it.", !voice) },
    { label: `Read answers aloud: ${word(aloud)}`, hint: `npx worktrust remote voice read ${aloud ? "off" : "on"}`, info: aloud ? "Siri reads replies aloud. Enter stops it." : "Lets Siri read a reply aloud on your phone.", run: () => run(["remote", "voice", "read", aloud ? "off" : "on"]), ...(voice || aloud ? {} : not("Needs Voice prompts with Siri: turn it on first.")),
      confirm: ask("reading answers aloud", "Siri reads the reply to your own spoken prompt aloud on your phone.", "Siri can read replies aloud from now on. You confirm with y at the next step.", "Siri stops reading replies aloud. Voice prompts stay as they are.", !aloud) },
  ];
}

/** Remote Agent › Permissions › (0.11.22): one row, with how many of the four are on; `modes` the ceiling in a word, beside it. */
export function permissionsRow(s, run) {
  const rows = switchItems(s, () => true), on = rows.filter((r) => r.label.endsWith(": on")).length;
  return { label: "Permissions ›", note: { text: `${on} of ${rows.length} on`, tone: "dim" }, hint: "npx worktrust remote status", info: "What a phone may do here: read along, steer, voice, modes.", run };
}

/**
 * THE STEP A SWITCH ASKS FIRST (0.11.22), drawn in place of the list: → true only for `y`. Enter, n, Esc, Backspace and Ctrl+C
 * change nothing. `p` the menu's colours.
 */
export function confirmFrame({ header = [], title = null, item }, { columns = 100, p } = {}) {
  const c = item.confirm, width = Math.max(20, columns - 3), wrap = (text) => text.split(" ").reduce((out, w) => { const last = out.at(-1) ?? ""; if (last && last.length + 1 + w.length > width) out.push(w); else out[Math.max(0, out.length - 1)] = last ? `${last} ${w}` : w; return out; }, [""]);
  return [...header, ...(title ? ["", `  ${p.bold(title)}`] : []), "", `  ${p.bold(item.label)}`, "", ...wrap(c.what).map((l) => `  ${l}`), ...wrap(c.change).map((l) => `  ${l}`), "", `  ${p.bold(c.question)}`, "", `  ${p.dim("y yes · Enter, Esc or ⌫ no: nothing changes")}`];
}
export async function confirmStep(term, frame, p) {
  for (;;) {
    term.draw(confirmFrame(frame, { columns: term.size().columns, p }));
    const k = await term.key();
    if (k.name === "resize") { term.reset(); continue; }
    return (k.str === "y" || k.str === "Y") && !k.ctrl;
  }
}

/** Roots for new projects ›: the default folder for new sessions (remote-default-root.mjs), `on` its live state; a short label so its command fits 80 columns. */
export function defaultRootItem(on, run = () => true) {
  return { label: `Desktop/WorkTrust: ${word(on)}`, hint: `npx worktrust remote roots default ${on ? "off" : "on"}`, info: on ? "Off keeps the folder and its projects. Enter turns it off." : "A phone's New session makes projects in ~/Desktop/WorkTrust.", run: () => run(["remote", "roots", "default", on ? "off" : "on"]),
    confirm: ask("the default folder", "A phone's New session makes its project in ~/Desktop/WorkTrust, a root of this computer.", "The folder is made and added as a root. You confirm with y at the next step.", "It is no longer a root. The folder and its projects stay on disk.", !on) };
}
