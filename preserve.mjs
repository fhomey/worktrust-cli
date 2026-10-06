#!/usr/bin/env node
/**
 * KEEP YOUR HISTORY: `npx worktrust@latest preserve` (2026-10-06). Local only: no account, no network, no key needed.
 * The bare command walks every step on its own yes (see `guided` below); the flags do one step each, for scripts:
 * --apply [--yes] keep the settings · --archive [dir] the metadata-only archive (default ~/AI-Evidence) · --verify [dir]
 * its hashes, chain, roots and signatures · --summary [dir] hours, tokens per model, cache share, parallel sessions.
 *
 * WHY. The session hook measures from the AI apps' own session files, and several apps delete them: Claude Code after
 * 30 days (`cleanupPeriodDays`, minimum 1, 0 is invalid), Gemini CLI after 30 (`general.sessionRetention`), Hermes Agent
 * 90 days after a session ended (`sessions.auto_prune`). A deleted file is a day never measured again. Codex documents
 * no deletion; Cursor, Copilot Chat, OpenCode, Goose and LM Studio document none, so nothing is claimed or changed for
 * them (their docs, 2026-10-06).
 *
 * WHAT CHANGES, only on a typed y (Enter is No; --yes agrees in advance; no terminal and no --yes changes nothing):
 * Claude Code's `cleanupPeriodDays` to 3650 when unset or lower, and Gemini CLI's `sessionRetention.enabled` to false;
 * the file is copied beside itself first, every other key kept, a higher value never lowered, a file that is not plain
 * JSON left alone. Hermes's YAML is never edited: the line is printed.
 *
 * WHAT THE ARCHIVE HOLDS. The hook's own day-stretches (`log-session.mjs --archive-lines`; nothing is parsed here) as
 * allowlisted JSON lines in <dir>/YYYY/MM/stretches.jsonl: clocks, seconds and their layers, tokens, subagents, the
 * model, the hook's own words, a hash of the project, the computer and profile as hashes. Never a prompt, an answer,
 * code, a path, a branch or a title; a measurement not made is absent, never 0. Each line chains to the one before
 * (`prev`, `hash`), appended and never rewritten; each day has proofs/<day>.json, its root, signed with the device key
 * (~/.worktrust/key.json) when there is one. Today waits for the next run. Nothing leaves this computer.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { summaryLines } from "./preserve-summary.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "preserve");
const has = (name) => args.includes(`--${name}`);
/** `--archive [dir]`: the folder named after the flag, or the default. */
const folderAfter = (name) => { const at = args.indexOf(`--${name}`); const next = args[at + 1]; return next && !next.startsWith("--") ? next.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), "AI-Evidence"); };
const HERE = dirname(fileURLToPath(import.meta.url));
const home = (...parts) => join(homedir(), ...parts);
const say = (line = "") => process.stdout.write(`${line}\n`);
const today = () => new Date().toISOString().slice(0, 10);
/** Which collector wrote a line: the CLI's version when worktrust.mjs starts this, else the package's beside it. */
const COLLECTOR = process.env.WORKTRUST_COLLECTOR || (() => { try { return `worktrust-cli/${JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version}`; } catch { return "worktrust-cli/source"; } })();
const KEEP_DAYS = 3650;
let IDS = {}; // filled once per archive run (computerIds), never read at import
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** Keys sorted at every level: the same object always hashes the same, whatever order it was written in. */
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value));
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** A settings file: { value } when it is a JSON object or absent ({}), { value: null } when it exists and is not one. */
function readJson(file) {
  if (!existsSync(file)) return { exists: false, value: {} };
  try { const value = JSON.parse(readFileSync(file, "utf8")); return { exists: true, value: value && typeof value === "object" && !Array.isArray(value) ? value : null }; } catch { return { exists: true, value: null }; }
}
const appData = (app) => (platform() === "win32" && process.env.APPDATA ? join(process.env.APPDATA, app) : platform() === "darwin" ? home("Library", "Application Support", app) : join(process.env.XDG_CONFIG_HOME || home(".config"), app));

/** CLAUDE CODE: ~/.claude/projects/<project>/<session>.jsonl, deleted after `cleanupPeriodDays` (default 30). */
function claudeCode() {
  const file = home(".claude", "settings.json");
  const { value } = readJson(file);
  const set = typeof value?.cleanupPeriodDays === "number" ? value.cleanupPeriodDays : null;
  const days = set ?? 30;
  return {
    name: "Claude Code", found: isDir(home(".claude")), file,
    keeps: value === null ? `${file} is not plain JSON; the default is 30 days` : set === null ? "30 days (the default; cleanupPeriodDays is not set)" : `${set} days (cleanupPeriodDays)`,
    risk: days >= KEEP_DAYS ? "none: transcripts are kept ten years or more" : `transcripts not written for ${days} days are deleted in the background, and the hours in them with them`,
    change: value === null ? { manual: [`add "cleanupPeriodDays": ${KEEP_DAYS} to ${file}`] } : days < KEEP_DAYS ? { says: `cleanupPeriodDays ${set ?? "unset"} → ${KEEP_DAYS} in ${file}`, next: (settings) => ({ ...settings, cleanupPeriodDays: KEEP_DAYS }) } : null,
  };
}
/** GEMINI CLI: ~/.gemini/tmp/<project_hash>/chats, cleaned by `general.sessionRetention` (on by default, maxAge "30d"). */
function geminiCli() {
  const file = home(".gemini", "settings.json");
  const { exists, value } = readJson(file);
  const retention = value?.general?.sessionRetention;
  const on = retention?.enabled !== false;
  const age = typeof retention?.maxAge === "string" ? retention.maxAge : "30d";
  return {
    name: "Gemini CLI", found: isDir(home(".gemini", "tmp")) || exists, file,
    keeps: value === null ? `${file} is not plain JSON (comments?); the default is 30d` : !on ? "kept (general.sessionRetention.enabled: false)" : `${age}${retention?.maxAge ? " (general.sessionRetention.maxAge)" : " (the default; general.sessionRetention is not set)"}`,
    risk: on ? `chats older than ${age} are deleted when Gemini CLI starts` : "none: the cleanup is off",
    change: value === null ? { manual: [`set "general": { "sessionRetention": { "enabled": false } } in ${file}`] } : on ? { says: `general.sessionRetention.enabled → false in ${file}`, next: (settings) => ({ ...settings, general: { ...(settings.general ?? {}), sessionRetention: { ...(settings.general?.sessionRetention ?? {}), enabled: false } } }) } : null,
  };
}
/** HERMES AGENT: ~/.hermes/state.db, pruned by `sessions.auto_prune` (default true) after `sessions.retention_days` (90). */
function hermesAgent() {
  const base = platform() === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : home(".hermes");
  const file = join(base, "config.yaml");
  let rows = [];
  try { rows = readFileSync(file, "utf8").split("\n"); } catch { /* none */ }
  // Read only, never written: the `sessions:` block at the top level and its two keys, plainly written.
  const start = rows.findIndex((row) => /^sessions:\s*(#.*)?$/.test(row));
  const block = start < 0 ? [] : rows.slice(start + 1, (() => { const end = rows.findIndex((row, at) => at > start && /^\S/.test(row)); return end < 0 ? rows.length : end; })());
  const read = (key) => block.map((row) => new RegExp(`^\\s+${key}:\\s*([^#\\s]+)`).exec(row)?.[1]).find(Boolean);
  const prune = read("auto_prune") !== "false";
  const days = Number(read("retention_days") ?? 90);
  return {
    name: "Hermes Agent", found: isDir(base), file,
    keeps: prune ? `${days} days after a session ended${read("auto_prune") || read("retention_days") ? " (sessions in config.yaml)" : " (the default: sessions.auto_prune is on)"}` : "kept (sessions.auto_prune: false)",
    risk: prune ? `ended sessions are pruned from state.db after ${days} days` : "none: pruning is off",
    change: prune ? { manual: start < 0 ? [`add to ${file}:`, "  sessions:", "    auto_prune: false"] : [`in ${file}, under sessions:, set`, "    auto_prune: false"] } : null,
  };
}
const codexCli = () => ({ name: "Codex", found: isDir(home(".codex")), keeps: "no deletion documented (older rollouts are compressed)", risk: "none documented", change: null });
/** Retention not documented: said plainly, nothing changed. */
const undocumented = (name, places, note) => ({ name, found: places.some(isDir), keeps: "not documented", risk: note ?? "unknown: the app documents no retention", change: null });
const clients = () => [
  claudeCode(), geminiCli(), hermesAgent(), codexCli(),
  undocumented("Cursor", [appData("Cursor"), home(".cursor")]),
  undocumented("Copilot Chat", ["Code", "Code - Insiders"].map((app) => join(appData(app), "User", "globalStorage", "github.copilot-chat")), "unknown: no retention documented; VS Code also syncs chat sessions to GitHub by default (chat.sessionSync.enabled)"),
  undocumented("OpenCode", [join(process.env.XDG_DATA_HOME || home(".local", "share"), "opencode")]),
  undocumented("Goose", [home(".local", "share", "goose"), home("Library", "Application Support", "Block", "goose"), home(".config", "goose")]),
  undocumented("LM Studio", [home(".lmstudio"), home(".cache", "lm-studio")]),
];

function report(list) {
  say();
  say("  WorkTrust · preserve: how long each AI app on this computer keeps its sessions");
  say("  Nothing is sent anywhere, and nothing changes without your yes.");
  for (const client of list) {
    say();
    if (!client.found) { say(`  ${client.name.padEnd(14)} not on this computer`); continue; }
    say(`  ${client.name.padEnd(14)} found`);
    say(`    keeps    ${client.keeps}`);
    say(`    risk     ${client.risk}`);
    if (client.change?.says) say(`    --apply  ${client.change.says}`);
    else if (client.change?.manual) { say(`    by hand  ${client.change.manual[0]}`); for (const row of client.change.manual.slice(1)) say(`             ${row}`); }
    else say("    --apply  nothing to change");
  }
  say();
}

async function ask(question) {
  if (has("yes")) return true;
  if (!process.stdin.isTTY) return null;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`  ${question} [y/N] `)).trim().toLowerCase();
  prompt.close();
  return answer === "y" || answer === "yes";
}

/** A dated copy beside the file, never over an earlier one; then the new JSON, every other key as it was. */
function writeWithBackup(file, next) {
  let backup = null;
  if (existsSync(file)) {
    backup = `${file}.worktrust-backup-${today()}`;
    for (let n = 2; existsSync(backup); n += 1) backup = `${file}.worktrust-backup-${today()}-${n}`;
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return backup;
}

async function apply(list, agreed = false) {
  for (const client of list.filter((entry) => entry.found && entry.change)) {
    if (client.change.manual) { say(`  ${client.name}: not edited here; ${client.change.manual[0]}`); for (const row of client.change.manual.slice(1)) say(`    ${row}`); continue; }
    const yes = agreed || await ask(`${client.name}: ${client.change.says}?`);
    if (yes === null) { say(`  ${client.name}: not a terminal, nothing changed. Add --yes to agree in advance.`); continue; }
    if (!yes) { say(`  ${client.name}: left as it is.`); continue; }
    const { value } = readJson(client.file);
    if (value === null) { say(`  ${client.name}: ${client.file} is no longer plain JSON; left as it is.`); continue; }
    const backup = writeWithBackup(client.file, client.change.next(value));
    say(`  ✓ ${client.name}: ${client.change.says}${backup ? ` (the earlier file is kept as ${backup})` : ""}`);
  }
  say();
  say("  Restart the apps whose settings changed. Nothing was sent anywhere.");
}

/** THE ALLOWLIST: what a line may carry, each value checked for its type. A key not named here never reaches the archive. */
const COUNTS = ["seconds", "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write", "model_seconds", "tool_seconds", "human_seconds", "idle_seconds", "agent_runs", "agent_seconds", "agent_peak"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The hook's own words for a stretch (work area, kind, how it was steered, the measuring bases), kept as the hook sends them. */
const WORDS = ["layer", "kind", "steered_from", "duration_basis", "token_basis", "turn_basis"];
const WORD = /^[a-z][A-Za-z]{1,31}$/;
/** WHICH COMPUTER, WHICH PROFILE: the one-way hashes `worktrust connect` derives (worktrust.mjs `computerIds`), the same text, so they match. */
function computerIds() {
  let machine = null;
  try {
    const os = platform();
    if (os === "darwin") machine = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 3000 }).match(/"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/)?.[1] ?? null;
    else if (os === "win32") machine = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 3000 }).match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/)?.[1] ?? null;
    else for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) if (!machine && existsSync(file)) { const id = readFileSync(file, "utf8").trim(); if (/^[0-9a-f]{32}$/.test(id)) machine = id; }
  } catch { /* unreadable: no identity */ }
  if (process.env.WORKTRUST_MACHINE_ID) machine = process.env.WORKTRUST_MACHINE_ID; // tests only
  if (!machine) return {};
  const hash = (text) => createHash("sha256").update(text).digest("base64url");
  return { device_id: hash(`worktrust-machine|${machine.toLowerCase()}`), profile_id: hash(`worktrust-profile|${machine.toLowerCase()}|${homedir()}`) };
}
function archiveLine(entry) {
  if (typeof entry?.client !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.client) || !ISO.test(entry.started_at ?? "") || !ISO.test(entry.at ?? "") || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.stretch_ref ?? "")) return null;
  const line = { client: entry.client, day: entry.started_at.slice(0, 10), started_at: entry.started_at, ended_at: entry.at };
  for (const key of COUNTS) if (typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0) line[key] = entry[key];
  if (typeof entry.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,63}$/.test(entry.model)) line.model = entry.model;
  for (const key of WORDS) if (typeof entry[key] === "string" && WORD.test(entry[key])) line[key] = entry[key];
  if (Array.isArray(entry.layers) && entry.layers.length > 1 && entry.layers.every((word) => typeof word === "string" && WORD.test(word))) line.layers = entry.layers.slice(0, 8);
  if (typeof entry.exchanges === "number" && Number.isInteger(entry.exchanges) && entry.exchanges > 0) line.exchanges = entry.exchanges;
  // Commit hashes the stretch made, never a message: what ties AI time to delivered work in the repository.
  if (Array.isArray(entry.commits) && entry.commits.length > 0 && entry.commits.every((sha) => typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha))) line.commits = entry.commits.slice(0, 50);
  // The project as a one-way hash of its name (owner/name, else the folder's own name): which days belong together, never which project.
  const name = entry.repo ?? entry.folder;
  if (typeof name === "string" && name) line.project = sha256(`worktrust-project|${name}`);
  return { ...line, stretch_ref: entry.stretch_ref, ...IDS, collector_version: COLLECTOR };
}

/** The device key, when this computer is coupled: its private half signs, its public half goes into the proof. */
function deviceKey() {
  try {
    const key = JSON.parse(Buffer.from(readFileSync(home(".worktrust", "key.json"), "utf8"), "base64").toString("utf8"));
    const privateKey = createPrivateKey(key.device);
    return { privateKey, publicX: createPublicKey(privateKey).export({ format: "jwk" }).x };
  } catch { return null; }
}

/** Every line of an archive, where it lives, parsed or not. */
function readArchive(dir) {
  const rows = [];
  for (const year of readdirSafe(dir).filter((name) => /^\d{4}$/.test(name)).sort()) for (const month of readdirSafe(join(dir, year)).filter((name) => /^\d{2}$/.test(name)).sort()) {
    const file = join(dir, year, month, "stretches.jsonl");
    if (!existsSync(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((text, at) => { if (text.trim()) { let line = null; try { line = JSON.parse(text); } catch { /* reported by check */ } rows.push({ line, where: `${year}/${month}/stretches.jsonl line ${at + 1}`, month: `${year}-${month}` }); } });
  }
  return rows;
}
function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }
const rootOf = (hashes) => sha256(hashes.join("\n"));
const proofBody = (date, lines, key) => ({ date, count: lines.length, root: rootOf(lines.map((line) => line.hash)), collector_version: COLLECTOR, ...(key ? { public_key: key.publicX } : {}) });

/** THE CHECK, shared by --verify and by --archive before it appends: the first break, or the archive's facts. */
function check(dir) {
  const rows = readArchive(dir);
  const broken = (where, why) => ({ broken: `${where}: ${why}` });
  for (const { line, where, month } of rows) {
    if (!line || typeof line !== "object") return broken(where, "not a JSON line");
    const { hash, ...rest } = line;
    if (hash !== sha256(canonical(rest))) return broken(where, "its hash does not match its content");
    if (line.day?.slice(0, 7) !== month) return broken(where, `a line of ${line.day} in the month folder ${month}`);
  }
  const lines = rows.map((row) => row.line).sort((a, b) => a.seq - b.seq);
  for (const [at, line] of lines.entries()) {
    const where = rows.find((row) => row.line === line).where;
    if (line.seq !== at + 1) return broken(where, `seq ${line.seq} where ${at + 1} was expected (a line is missing or doubled)`);
    if (line.prev !== (at === 0 ? null : lines[at - 1].hash)) return broken(where, "prev does not name the line before it: the chain is broken");
  }
  const manifest = readJson(join(dir, "manifest.json")).value;
  if (rows.length > 0 && (!manifest || manifest.count !== lines.length || manifest.head !== lines.at(-1).hash)) return broken("manifest.json", "its count or head does not match the lines (lines were removed or added outside preserve)");
  const days = new Map();
  for (const line of lines) days.set(line.day, [...(days.get(line.day) ?? []), line]);
  const mine = deviceKey()?.publicX ?? null;
  let signed = 0, ours = 0;
  for (const name of readdirSafe(join(dir, "proofs"))) if (!days.has(name.replace(/\.json$/, ""))) return broken(`proofs/${name}`, "a proof for a day with no lines");
  for (const [day, ofDay] of days) {
    const where = `proofs/${day}.json`;
    const proof = readJson(join(dir, "proofs", `${day}.json`)).value;
    if (!proof || proof.date !== day) return broken(where, "missing or unreadable");
    if (proof.count !== ofDay.length || proof.root !== rootOf(ofDay.map((line) => line.hash))) return broken(where, "the day's root does not match its lines");
    if (proof.signature === null) continue;
    const { signature, ...body } = proof;
    let valid = false;
    try { valid = verify(null, Buffer.from(canonical(body)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: body.public_key }, format: "jwk" }), Buffer.from(signature, "base64url")); } catch { valid = false; }
    if (!valid) return broken(where, "the signature does not verify with the key named in it");
    signed += 1;
    if (body.public_key === mine) ours += 1;
  }
  return { lines, days, signed, ours, manifest };
}

function archive(dir) {
  IDS = computerIds();
  const existing = existsSync(join(dir, "manifest.json")) || readArchive(dir).length > 0 ? check(dir) : { lines: [], manifest: null };
  if (existing.broken) { say(`  The archive in ${dir} does not verify, so nothing was added: ${existing.broken}`); process.exit(1); }
  const hook = spawnSync(process.execPath, [join(HERE, "log-session.mjs"), "--archive-lines"], { encoding: "utf8", maxBuffer: 1 << 29, env: { ...process.env, WORKTRUST_MCP_URL: "", WORKTRUST_MCP_TOKEN: "", WORKTRUST_HOOK_INPUT: "" } });
  if (hook.status !== 0) { say(`  The session hook could not read this computer's sessions: ${(hook.stderr || "").trim().split("\n").pop()}`); process.exit(1); }
  const known = new Set(existing.lines.map((line) => line.stretch_ref));
  const fresh = [];
  let waiting = 0;
  for (const text of hook.stdout.split("\n")) {
    let entry; try { entry = JSON.parse(text); } catch { continue; }
    const line = archiveLine(entry);
    if (!line || known.has(line.stretch_ref)) continue;
    if (line.day >= today()) { waiting += 1; continue; }
    known.add(line.stretch_ref);
    fresh.push(line);
  }
  fresh.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.client.localeCompare(b.client) || a.stretch_ref.localeCompare(b.stretch_ref));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let prev = existing.lines.at(-1)?.hash ?? null, seq = existing.lines.length;
  const all = [...existing.lines];
  for (const line of fresh) {
    const chained = { ...line, seq: (seq += 1), prev };
    const hashed = { ...chained, hash: sha256(canonical(chained)) };
    mkdirSync(join(dir, line.day.slice(0, 4), line.day.slice(5, 7)), { recursive: true });
    appendFileSync(join(dir, line.day.slice(0, 4), line.day.slice(5, 7), "stretches.jsonl"), `${JSON.stringify(hashed)}\n`);
    all.push(hashed);
    prev = hashed.hash;
  }
  // A day that gained lines gets its root again over all of its lines; the lines themselves are never rewritten.
  const key = deviceKey();
  mkdirSync(join(dir, "proofs"), { recursive: true });
  for (const day of new Set(fresh.map((line) => line.day))) {
    const body = proofBody(day, all.filter((line) => line.day === day), key);
    writeFileSync(join(dir, "proofs", `${day}.json`), `${JSON.stringify({ ...body, signature: key ? sign(null, Buffer.from(canonical(body)), key.privateKey).toString("base64url") : null }, null, 1)}\n`);
  }
  if (fresh.length > 0 || !existing.manifest) writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ format: "worktrust-ai-evidence/1", collector_version: COLLECTOR, created: existing.manifest?.created ?? new Date().toISOString(), updated: new Date().toISOString(), clients: [...new Set(all.map((line) => line.client))].sort(), ...IDS, count: all.length, head: prev }, null, 1)}\n`);
  say();
  say(`  ✓ ${fresh.length} new day-stretch${fresh.length === 1 ? "" : "es"} archived in ${dir} (${all.length} in all)${key ? ", each day's root signed with this computer's device key" : ", unsigned (no device key on this computer)"}.`);
  if (waiting > 0) say(`    ${waiting} of today wait for tomorrow's run: a day is archived once it is over.`);
  say("    Metadata only: clocks, counts, model names, a hash of each project's name. Nothing was sent.");
}

function verifyArchive(dir) {
  const result = check(dir);
  if (result.broken) { say(`  BROKEN  ${result.broken}`); process.exit(1); }
  if (result.lines.length === 0) { say(`  Nothing to verify in ${dir}.`); return; }
  const signedBy = result.signed === 0 ? "no day signed" : result.ours === result.signed ? `${result.signed} signed by this computer's key` : `${result.signed} signed (${result.ours} by this computer's key, ${result.signed - result.ours} by another key named in them)`;
  say(`  OK  ${result.lines.length} stretches · ${result.days.size} days · the chain is whole · every day's root matches · ${signedBy}`);
}

/** --summary: what a person or a team reads from the archive, counted locally (preserve-summary.mjs) once the chain checks out. */
function summary(dir) {
  const result = check(dir);
  if (result.broken) { say(`  BROKEN  ${result.broken}`); process.exit(1); }
  for (const line of summaryLines(result.lines)) say(line);
  if (result.lines.length === 0) say(`  Nothing archived in ${dir} yet. Run: npx worktrust@latest preserve --archive`);
}

/** THE ONE COMMAND (owner, 2026-10-07: typed from a video): the report; the settings on a yes (--apply); an archive on a yes
 *  (--archive; one already there is added to); then its check and summary. Enter is No; no terminal changes nothing. */
async function guided() {
  const list = clients(), dir = join(homedir(), "AI-Evidence");
  report(list);
  if (list.some((client) => client.found && client.change?.says)) {
    const keep = await ask("Keep these settings?");
    if (keep) await apply(list, true);
    else say(keep === null ? "  Not a terminal: no setting changed. Add --yes to agree in advance." : "  Settings left as they are.");
  }
  const kept = existsSync(join(dir, "manifest.json"));
  const write = kept ? (has("yes") || process.stdin.isTTY ? true : null) : await ask(`Keep a local archive in ${dir}?`);
  if (write) archive(dir);
  else if (!kept) say(write === null ? "  Not a terminal: no archive written. Add --yes to agree in advance." : "  No archive written.");
  if (existsSync(join(dir, "manifest.json"))) { say(); verifyArchive(dir); summary(dir); }
}

if (has("summary")) summary(folderAfter("summary"));
else if (has("verify")) verifyArchive(folderAfter("verify"));
else if (has("archive")) archive(folderAfter("archive"));
else if (has("apply")) { const list = clients(); report(list); await apply(list); }
else await guided();
