/**
 * A PROJECT'S MODE ON THIS COMPUTER (owner, 2026-11-09; docs/CONFIDENTIAL-WORK.md). One file, ~/.worktrust-counter.json,
 * holds two lists the person writes with `worktrust project exclude|confidential|normal [path]`:
 *
 *   exclude       the project is never read: no hours, no tokens, nothing (as since 2026-09-27)
 *   confidential  hours and token counts still count, but nothing that names the client leaves this computer: no repository
 *                 name, no HMAC code, no branch, no remote, no path, no commit; one fixed marker instead, the same for every
 *                 confidential project, so their lines cannot be told apart
 *   normal        neither (the default)
 *
 * EVERY READER ASKS HERE (scripts/check-project-modes.mjs refuses one that reads the file itself or sends work without asking):
 * a reader that knew only `exclude` would send a confidential project's name, which is the one thing this mode exists to stop.
 * Exclude wins over confidential; an entry is an absolute folder (what the command writes: the folder and everything under it)
 * or a hand-written text (any folder whose name contains it, ignoring case, as the file always meant).
 *
 * AN OLDER READER FAILS CLOSED. A reader from before this mode knows only `exclude`, and it matched Claude Code's folders by a
 * text inside their encoded name. So the command writes a folder into `exclude` twice (its path and its encoded name, which an
 * older reader matches) and, for a confidential folder, into `confidential` as well: an older reader leaves the project out
 * entirely, never names it; a reader that knows this file reads the pair as confidential.
 */
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export const COUNTER_CONFIG = ".worktrust-counter.json";
/** The one marker a confidential line carries in place of a repository (a repo_code's shape, never an HMAC of anything). */
export const CONFIDENTIAL_REPO_CODE = "0000000000000000";
/** What an AI app's free-text title becomes on a confidential line: the title is the person's words and may name the client. */
export const CONFIDENTIAL_TITLE = "Confidential client work";
export const MODES = ["exclude", "confidential", "normal"];

const configFile = (home) => join(home, COUNTER_CONFIG);
const strings = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : []);

/** The whole file as it stands (other keys, such as leaveOut, kept), or an empty one. A damaged file reads as empty lists. */
function readConfig(home) {
  try { const parsed = JSON.parse(readFileSync(configFile(home), "utf8")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

/** The two lists. A reader calls this once per run and hands the answer to projectModeOf. */
export function readProjectModes(home = homedir()) {
  const config = readConfig(home);
  const confidential = strings(config.confidential);
  const shadows = new Set(confidential.flatMap(shadowsOf));
  // leaveOut: the words a turn must not carry (count-behaviour), kept in the same file and read here with it.
  return { exclude: strings(config.exclude).filter((entry) => !shadows.has(entry)), confidential, leaveOut: strings(config.leaveOut) };
}

/** Claude Code names a project's folder by its path with every character that is not a letter or digit as "-". */
const encoded = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
/** The entries the command writes into `exclude` for one folder: its path and its encoded name (what an older reader matches). */
const shadowsOf = (folder) => (isAbsolute(folder) ? [folder, encoded(folder)] : [folder]);
const real = (path) => { try { return realpathSync(path); } catch { return path; } };

/**
 * Whether one entry covers a candidate. A candidate is what a reader holds: an absolute working directory, Claude Code's
 * encoded project folder, or only a folder's name (Codex, Copilot). Wider rather than narrower: a confidential or excluded
 * project that matches too much stays private; one that matches too little leaks.
 */
export function entryCovers(entry, candidate) {
  if (!entry || !candidate) return false;
  const text = String(candidate);
  if (isAbsolute(entry)) {
    const root = resolve(entry);
    if (isAbsolute(text)) return [resolve(text), real(resolve(text))].some((path) => path === root || path.startsWith(root + sep));
    const folder = encoded(root);
    if (text === folder || text.startsWith(`${folder}-`)) return true;
    return !/[\\/]/.test(text) && text.toLowerCase() === basename(root).toLowerCase();
  }
  return text.toLowerCase().includes(entry.toLowerCase());
}

/** "exclude" | "confidential" | "normal" for a candidate; exclude wins. No candidate is normal (nothing to name). */
export function projectModeOf(candidate, modes = readProjectModes()) {
  if (!candidate) return "normal";
  if (modes.exclude.some((entry) => entryCovers(entry, candidate))) return "exclude";
  if (modes.confidential.some((entry) => entryCovers(entry, candidate))) return "confidential";
  return "normal";
}

/** The mode of the first candidate that has one, exclude before confidential (a reader may know a folder and a repo name). */
export function strictestMode(candidates, modes = readProjectModes()) {
  const found = candidates.filter(Boolean).map((candidate) => projectModeOf(candidate, modes));
  return found.includes("exclude") ? "exclude" : found.includes("confidential") ? "confidential" : "normal";
}

/** The keys that could name a client or a place: never on a confidential line, whatever sent them. */
const IDENTIFYING = ["repo", "repo_code", "repo_reported", "commits", "branch", "remote", "remote_url", "origin", "path", "paths", "files", "cwd", "project", "project_ref", "workspace", "folder", "schedule_ref"];

/**
 * A line as it may leave this computer from a confidential project: the identifying keys out, the marker in. `title` is
 * replaced only when the caller asks (an AI app's own title is free text; the hook's titles are fixed words).
 */
export function confidentialPayload(payload, { replaceTitle = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload ?? {})) if (!IDENTIFYING.includes(key)) out[key] = value;
  out.repo_code = CONFIDENTIAL_REPO_CODE;
  if (replaceTitle) out.title = CONFIDENTIAL_TITLE;
  return out;
}

/** Writes one folder's mode: out of both lists, into the one named (normal: into neither). The file stays 0600, other keys kept. */
export function writeProjectMode(path, mode, home = homedir()) {
  if (!MODES.includes(mode)) throw new Error(`mode: one of ${MODES.join(", ")}`);
  const folder = real(resolve(path));
  const config = readConfig(home);
  const mine = new Set(shadowsOf(folder));
  const exclude = strings(config.exclude).filter((entry) => !mine.has(entry));
  const confidential = strings(config.confidential).filter((entry) => entry !== folder);
  // Both modes go into `exclude` (an older reader leaves the folder out); confidential also into its own list.
  if (mode !== "normal") exclude.push(...shadowsOf(folder));
  if (mode === "confidential") confidential.push(folder);
  const next = { ...config, exclude, confidential };
  const file = configFile(home), temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(temp, 0o600); } catch { /* Windows */ }
  renameSync(temp, file);
  const modes = readProjectModes(home);
  return { folder, mode, effective: projectModeOf(folder, modes), modes };
}

/**
 * `worktrust project exclude|confidential|normal [path]` and `worktrust project list`. The person's own file, written for
 * them; nothing is sent. `io` carries say and fail; `home` and `cwd` are a test's.
 */
export function projectCommand(argv, io) {
  const { say, fail, home = homedir(), cwd = process.cwd() } = io;
  const [sub, given] = argv;
  if (!sub || sub === "list") {
    const modes = readProjectModes(home);
    modes.exclude = modes.exclude.filter((entry) => !(/^-/.test(entry) && modes.exclude.some((other) => isAbsolute(other) && encoded(other) === entry)));
    say();
    if (!modes.exclude.length && !modes.confidential.length) { say("  Every project is normal on this computer."); say("  Change one with: worktrust project exclude|confidential|normal [folder]"); return 0; }
    for (const entry of modes.confidential) say(`  confidential  ${entry}`);
    for (const entry of modes.exclude) say(`  excluded      ${entry}`);
    say();
    say("  Confidential: hours and tokens count, nothing that names the client is sent. Excluded: nothing is read.");
    return 0;
  }
  if (!MODES.includes(sub)) return fail("project: exclude, confidential, normal or list");
  const folder = resolve(cwd, given ?? ".");
  if (!existsSync(folder)) return fail(`project: ${folder} does not exist`);
  const done = writeProjectMode(folder, sub, home);
  say();
  if (sub === "exclude") say(`  Excluded: ${done.folder}. Nothing from it is read or sent.`);
  else if (sub === "confidential") say(`  Confidential: ${done.folder}. Hours and tokens count; no name, branch, path or commit is sent.`);
  else say(`  Normal: ${done.folder}.`);
  if (done.effective !== sub) {
    const word = done.effective === "exclude" ? "excluded" : done.effective;
    say(`  It stays ${word}: another entry covers it. See \`worktrust project list\`.`);
  }
  say("  Lines already on your record keep what they were sent with.");
  return 0;
}

/** A repository name's last segment ("acme/portal" → "portal"), what a folder entry can be matched by. */
const repoTail = (repo) => (typeof repo === "string" && repo.trim() ? repo.trim().replace(/\.git$/, "").split(/[\\/:]/).filter(Boolean).at(-1) ?? null : null);
const receipt = (id, note) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ receipt: "excluded", note }) }] } });
const EXCLUDED_NOTE = "This project is excluded on this computer (worktrust project list); nothing was sent.";

/**
 * AN AI APP'S OWN CALL THROUGH THE BRIDGE (`worktrust mcp`). `log_work` and `import_history` are the AI app's words, so the
 * mode is decided here, before anything leaves: by the folder the app started the bridge in and by the repository name the call
 * carries. Excluded: answered here, nothing sent. Confidential: sealed (confidentialPayload, the title replaced). Any other
 * message passes unchanged. Returns { forward } (the message to send) or { answer } (the reply to give, nothing sent).
 */
export function sealToolCall(message, cwd, modes = readProjectModes()) {
  const name = message?.method === "tools/call" ? message.params?.name : null;
  if (name !== "log_work" && name !== "import_history") return { forward: message };
  const args = message.params?.arguments ?? {};
  const here = projectModeOf(cwd, modes);
  if (here === "exclude") return { answer: receipt(message.id, EXCLUDED_NOTE) };
  const modeOf = (line) => strictestMode([cwd, repoTail(line?.repo)], modes); // the folder's mode, or stricter by the name
  if (name === "log_work") {
    const mode = modeOf(args);
    if (mode === "exclude") return { answer: receipt(message.id, EXCLUDED_NOTE) };
    if (mode === "normal") return { forward: message };
    return { forward: { ...message, params: { ...message.params, arguments: confidentialPayload(args, { replaceTitle: true }) } } };
  }
  if (!Array.isArray(args.entries)) return { forward: message };
  const entries = args.entries.flatMap((entry) => { const mode = modeOf(entry); return mode === "exclude" ? [] : mode === "confidential" ? [confidentialPayload(entry, { replaceTitle: true })] : [entry]; });
  if (entries.length === 0 && args.entries.length > 0) return { answer: receipt(message.id, EXCLUDED_NOTE) };
  return { forward: { ...message, params: { ...message.params, arguments: { ...args, entries } } } };
}
