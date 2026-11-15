/**
 * LOOK AT THIS COMPUTER (`npx worktrust look`, CLI 0.11.10; owner, 2026-11-14): the first thing a person can do, before any
 * account. Per AI app the readers know, how many SESSIONS its own files on this computer hold, and the first and the last
 * day; a total line. COUNTS ONLY: sessions, apps, days. No hours, no level, no score, no tokens: hours are measured by
 * WorkTrust from what the hook sends, and a figure counted here would differ from the verified one.
 *
 * It finds and reads sessions with the hook's own readers (session-readers.mjs, transcript-readers.mjs,
 * session-databases.mjs), an excluded project skipped before a file is opened, exactly as the hook skips it. A session is a
 * session file (or a database client's session) with at least one timestamped turn; a day is a UTC date, as the hook cuts
 * days. Three states per app, never two: none found; found N (and how many could not be read); could not read. An app that
 * is not on this computer is left out.
 *
 * IT WRITES NOTHING AND SENDS NOTHING: no key, no file, no cache, no consent record, no network call
 * (scripts/test-cli-look.mjs runs it with every file write and every network function made to throw).
 *
 * measuredLines (0.11.10): the lines `Check this computer` prints from the hook's --evidence-summary, pure so a test reads
 * them; what the two misleading lines count is now said in their words.
 */
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectModeOf, readProjectModes } from "./project-modes.mjs";
import { READ_FAILURES, sessionFinders, transcriptLines } from "./session-readers.mjs";

const readers = (await import("./transcript-readers.mjs").catch(() => null)) ?? {};
const databases = (await import("./session-databases.mjs").catch(() => null)) ?? {};
const localModels = (await import("./session-local-models.mjs").catch(() => null)) ?? {};

const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** A folder that is there and cannot be listed: its app's sessions could not be read. */
const unlistable = (path) => { if (!isDir(path)) return false; try { readdirSync(path); return false; } catch { return true; } };
/** Whether this Node can open the database clients' stores (node:sqlite, Node 22.5+), asked without opening one. */
const sqliteHere = () => { const warn = process.emitWarning; try { process.emitWarning = () => {}; createRequire(import.meta.url)("node:sqlite"); return true; } catch { return false; } finally { process.emitWarning = warn; } };

/**
 * The apps the readers know, in the order the table shows them. `here`: whether the app is on this computer (its own folder);
 * `roots`: the folders whose listing must work for its sessions to be read; `database`: read through node:sqlite.
 */
const homesOf = (fn) => (typeof fn === "function" ? fn() : []);
export const LOOK_APPS = [
  { key: "claude", name: "Claude Code", here: () => isDir(join(homedir(), ".claude")), roots: () => [join(homedir(), ".claude", "projects")] },
  { key: "codex", name: "Codex", here: () => isDir(join(homedir(), ".codex")), roots: () => [join(homedir(), ".codex", "sessions")] },
  { key: "antigravity", name: "Antigravity", here: () => Boolean(readers.antigravityHere?.()), roots: () => homesOf(readers.antigravityRoots).map((root) => join(root, "brain")) },
  { key: "cursor", name: "Cursor", database: true, here: () => homesOf(databases.cursorHomes).some(isDir) },
  { key: "copilot", name: "Copilot in VS Code", database: true, here: () => homesOf(databases.copilotHomes).some(isDir) },
  { key: "gemini-cli", name: "Gemini CLI", database: true, here: () => homesOf(databases.geminiHomes).some((home) => isDir(join(home, "tmp"))) },
  { key: "opencode", name: "OpenCode", database: true, here: () => homesOf(databases.opencodeHomes).some(isDir) },
  { key: "hermes", name: "Hermes Agent", database: true, here: () => Boolean(databases.hermesHere?.()) },
  { key: "goose", name: "Goose", database: true, here: () => homesOf(databases.gooseHomes).some(isDir) },
  { key: "openclaw", name: "OpenClaw", database: true, here: () => isDir(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw")) },
  { key: "ollama", name: "Ollama", database: true, here: () => homesOf(localModels.ollamaHomes).some(isDir) },
  { key: "open-webui", name: "Open WebUI", database: true, here: () => homesOf(localModels.openWebuiHomes).some(isDir) },
];
/** A found session's app, by the id the finders give it: Claude Code's carry no prefix, every other client's names it. */
const appOf = (id) => /^([a-z][a-z-]*):/.exec(String(id))?.[1] ?? "claude";
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * What the AI apps on this computer recorded: { apps: [{ key, name, state, sessions, unreadable, first, last, why }], total }.
 * `state`: "none" | "found" | "unreadable". `progress(name)` is told each app as its sessions are read. Reads only.
 */
export function lookAt({ progress = null } = {}) {
  const present = LOOK_APPS.filter((app) => { try { return app.here(); } catch { return false; } });
  const rows = new Map(present.map((app) => [app.key, { key: app.key, name: app.name, state: "none", sessions: 0, unreadable: 0, first: null, last: null, why: null }]));
  const modes = readProjectModes(), excluded = (path) => projectModeOf(path, modes) === "exclude";
  const { CODEX_ROLLOUT = /(?!)/, codexIdOf = (file) => String(file).split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""), antigravityIdOf = (file) => String(file).split(/[\\/]/).at(-4), codexLines, codexRolloutFiles = function* () {}, codexCwd = () => null, ANTIGRAVITY_TRANSCRIPT = /(?!)/, antigravityLines, antigravityRoots = () => [], antigravityTranscripts = function* () {}, antigravityContext = () => ({}) } = readers;
  const { DATABASE_SESSION = /(?!)/, databaseLines = () => null, databaseSessions = function* () {}, databaseStores = () => [] } = databases;
  const DATABASE_CLIENTS = LOOK_APPS.filter((app) => app.database).map((app) => app.key);
  const finders = sessionFinders({ value: () => undefined, excluded, DATABASE_CLIENTS, codexRolloutFiles, codexCwd, codexIdOf, antigravityRoots, antigravityTranscripts, antigravityContext, databaseSessions });
  const parsedLines = transcriptLines({ DATABASE_SESSION, databaseLines, CODEX_ROLLOUT, codexLines, ANTIGRAVITY_TRANSCRIPT, antigravityIdOf, antigravityLines, antigravityContext });
  // A folder that is there and cannot be listed is an app that could not be read (the walks pass it over in silence).
  for (const app of present) if ((app.roots?.() ?? []).some(unlistable)) rows.get(app.key).why = "folder";
  // The database clients need node:sqlite; a store the local-model readers opened and could not read is said by them.
  const sqlite = sqliteHere();
  for (const app of present) if (app.database && !sqlite) rows.get(app.key).why = "node";
  for (const store of (() => { try { return sqlite ? databaseStores() : []; } catch { return []; } })()) if (store?.state && store.state !== "read" && rows.has(store.client)) rows.get(store.client).why ??= "store";
  const walk = rows.get("claude")?.why === "folder" ? finders.codexRollouts() : finders.allTranscripts();
  let current = null;
  for (const { id, file } of walk) {
    const key = appOf(id), row = rows.get(key);
    if (!row) continue; // an app the table does not show (none today): never counted under another's name
    if (key !== current) { current = key; progress?.(row.name); }
    const failedBefore = READ_FAILURES.n;
    let first = Infinity, last = -Infinity, lines = null;
    try { lines = parsedLines(file); } catch { lines = null; }
    if (lines) { try { for (const line of lines) { if (!line?.timestamp || (line.type !== "user" && line.type !== "assistant")) continue; const at = Date.parse(line.timestamp); if (Number.isFinite(at)) { if (at < first) first = at; if (at > last) last = at; } } } catch { READ_FAILURES.n += 1; } }
    if (READ_FAILURES.n > failedBefore || (!lines && DATABASE_SESSION.test(file))) { row.unreadable += 1; continue; }
    if (!lines) continue; // a file gone between the walk and the read is no session
    if (first === Infinity) continue; // no timestamped turn: nothing was recorded in it
    row.sessions += 1;
    if (!row.first || dayOf(first) < row.first) row.first = dayOf(first);
    if (!row.last || dayOf(last) > row.last) row.last = dayOf(last);
  }
  const apps = [...rows.values()].map((row) => ({ ...row, state: row.sessions > 0 ? "found" : row.unreadable > 0 || row.why ? "unreadable" : "none" }));
  const found = apps.filter((row) => row.sessions > 0);
  const total = { sessions: found.reduce((n, row) => n + row.sessions, 0), apps: found.length, first: found.map((row) => row.first).sort()[0] ?? null, last: found.map((row) => row.last).sort().at(-1) ?? null };
  return { apps, total };
}

const WHY = { node: "needs Node 22.5+", folder: "folder not readable", store: "database locked or unknown" };
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The table, as lines. `columns`: the terminal's width; below 64 a row's days go to a line of their own. Pure. */
export function lookLines({ apps, total }, { columns = 80 } = {}) {
  // A sentence wraps at the terminal's width, two spaces in, as the menu's fixed line does.
  const said = (text) => text.split(" ").reduce((lines, word) => { const last = lines.at(-1); if (last && last.length + 1 + word.length <= columns - 3) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); return lines; }, []).map((line) => `  ${line}`);
  const out = ["", ...said("What your AI apps recorded on this computer. Nothing was sent or kept."), ""];
  if (apps.length === 0) return [...out, ...said("No AI app this CLI reads was found on this computer."), ""];
  const nameCol = Math.max(...apps.map((row) => row.name.length), "Total".length);
  const state = (row) => (row.state === "found" ? `${plural(row.sessions, "session", "sessions")}${row.unreadable ? ` · ${row.unreadable} could not be read` : ""}` : row.state === "none" ? "none found" : `could not read${row.why ? ` (${WHY[row.why]})` : ""}`);
  const days = (row) => (row.first ? (row.first === row.last ? row.first : `${row.first} to ${row.last}`) : "");
  const totalSaid = total.sessions ? `${plural(total.sessions, "session", "sessions")} in ${plural(total.apps, "app", "apps")}` : "no sessions found";
  const stateCol = Math.max(totalSaid.length, ...apps.map((row) => state(row).length));
  const narrow = 2 + nameCol + 3 + stateCol + 3 + "2026-01-01 to 2026-01-01".length > columns - 1;
  const row = (name, said, span) => (narrow ? [`  ${name.padEnd(nameCol)}   ${said}`, ...(span ? [`  ${"".padEnd(nameCol)}   ${span}`] : [])] : [`  ${name.padEnd(nameCol)}   ${span ? said.padEnd(stateCol) : said}${span ? `   ${span}` : ""}`]);
  for (const app of apps) out.push(...row(app.name, state(app), days(app)));
  out.push("", ...row("Total", totalSaid, days(total)));
  out.push("", ...said("Sessions and days only: WorkTrust measures the hours when you send them."));
  return out;
}

/**
 * THE MEASURED SUMMARY OF `Check this computer` (0.8.3; words corrected 0.11.10 from the owner's own output): one line per
 * evidence group, from the hook's --evidence-summary JSON. Pure. Two lines said less than they count:
 *   · the changed files are, per stretch, every path of every commit in that repository during the stretch's window, any
 *     author, generated files and lockfiles included (or its uncommitted files when nothing was committed), a file counted
 *     once per stretch and again in the next: the line now says so;
 *   · the complexity classes come from the derived record, which not every stretch has: the stretches without one are said.
 */
export function measuredLines(m) {
  if (!m || !m.stretches) return ["  Measured here, last 30 days: no finished work stretch yet."];
  const of = (part, whole, one, many) => `${part} of ${whole} ${whole === 1 ? one : many}`;
  const out = ["", `  Measured here, last 30 days: ${m.stretches} work stretch${m.stretches === 1 ? "" : "es"} (the hours are WorkTrust's: see the app)`];
  if (m.delivered) out.push(`    verified before delivery   ${of(m.verified_first, m.delivered, "stretch that delivered", "stretches that delivered")}`);
  if (m.failures) out.push(`    recovered failures         ${of(m.recovered, m.failures, "failed tool call", "failed tool calls")} (${m.blind_retries} retried unchanged)`);
  if (m.steers) out.push(`    steering that worked       ${of(m.effective_steers, m.steers, "time you stepped in", "times you stepped in")}`);
  if (m.refused || m.guard_denied) out.push(`    refused                    ${m.refused} by you · ${m.guard_denied} by a guard`);
  if (m.planned) out.push(`    planned                    ${m.planned} stretch${m.planned === 1 ? "" : "es"} with a to-do list`);
  if (m.files) out.push(`    tests among changed files  ${of(m.test_files, m.files, "file", "files")}, a file once per stretch`, "                               (any author's commits in the stretch's window)");
  const tiers = Object.entries(m.complexity ?? {}).sort(), classed = tiers.reduce((n, [, count]) => n + (Number(count) || 0), 0);
  const classes = `    task complexity            ${tiers.map(([tier, n]) => `${tier} ${n}`).join(" · ")}`, unclassed = m.stretches > classed ? `${m.stretches - classed} not classed` : null;
  // The stretches without a class are said on the line, or under it where 80 columns would cut it.
  if (tiers.length) out.push(...(!unclassed ? [classes] : classes.length + 3 + unclassed.length <= 79 ? [`${classes} · ${unclassed}`] : [classes, `${" ".repeat(31)}${unclassed}`]));
  out.push("  Sent with each stretch as kinds and counts, never text. Keep your own copy: npx worktrust@latest preserve");
  return out;
}

/**
 * WHAT TO DO WITH IT (owner, 2026-11-14): a short list in the menu's own renderer under the table. Not connected: connect
 * (the existing flow, which offers the past once after the sign-in); connected: send them as earlier history (it asks
 * first). Preserve needs no account. Each names the command it runs, as every menu row does.
 */
export function lookItems(connected = false) {
  return [
    connected
      ? { label: "Send these to your WorkTrust account", hint: "npx worktrust history", info: "Sends them as earlier history. Shows a plan, asks first.", args: ["history"] }
      : { label: "Connect and send these to your WorkTrust account", hint: "npx worktrust connect", info: "Asks before it writes; your browser signs in to WorkTrust.", args: ["connect"] },
    { label: "Preserve them here as evidence ›", hint: "npx worktrust preserve", info: "Keep your AI history here. No account; nothing is sent.", preserve: true },
    { label: "← Back", hint: "Esc", back: true },
  ];
}

/** The menu's Look row (cli-menu.mjs firstItems): the `look` command as a child, no key waited for, then the list. */
export async function lookMenu(term, io, levels) {
  const menu = await import("./cli-menu.mjs");
  const code = await menu.runShown(term, io, ["look"], null, { pause: false });
  if (code !== 0) { term.write(`\n  ! It ended with a message above. ${menu.muted("Press any key for the menu.")}\n`); const k = await term.anyKey(); return !(k.ctrl && k.name === "c"); }
  const picked = await menu.choose(term, { title: "What next", items: lookItems(false) });
  if (picked === "quit") return false;
  if (picked === "back" || picked.item.back) return true;
  return picked.item.preserve ? levels.preserveMenu(term, io, []) : menu.runShown(term, io, picked.item.args);
}

/**
 * The same list after `npx worktrust look` in a person's own terminal (worktrust.mjs asks menuWanted first). Ctrl+C while a
 * command it started runs is that command's; the list's own Ctrl+C and Esc leave. → the exit code of what it ran, else 0.
 * `term` and `levels` are this process's terminal and the menu's deeper levels unless a test hands its own.
 */
export async function lookNext(io, { connected = false, term: given = null, levels: deeper = null } = {}) {
  const menu = await import("./cli-menu.mjs"), levels = deeper ?? (await import("./cli-menu-remote.mjs"));
  const term = given ?? menu.createTerminal(), hold = () => {};
  process.on("SIGINT", hold);
  try {
    term.enter();
    const picked = await menu.choose(term, { title: "What next", items: lookItems(connected) });
    if (picked === "quit" || picked === "back" || picked.item.back) return 0;
    if (picked.item.preserve) { await levels.preserveMenu(term, io, []); return 0; }
    term.erase(); term.restore();
    return await io.runCli(picked.item.args);
  } finally { term.erase(); term.restore(); process.off("SIGINT", hold); }
}
