/**
 * CONFIG EDITS — a YAML file edited line by line, never re-serialised (2026-10-05).
 *
 * Hermes Agent and Goose keep their settings in YAML, written by people, with comments and their own indentation.
 * setup-mcp.mjs puts WorkTrust's entry into them and takes it out again with these: a section is found by its key at
 * a known indent, an entry is added at the indent its siblings use, and a removal leaves every other byte as it was.
 * Only block style is handled; a section written inline (`key: { … }`) makes placeUnder return false, and the caller
 * leaves the file alone. No dependency: it ships beside setup-mcp.mjs.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
const indentOf = (line) => line.length - line.trimStart().length;
const meaningful = (line) => line.trim() !== "" && !line.trimStart().startsWith("#");
/** `key:` at `indent` between start and stop: its line and the end of its block, or the inline value it carries. */
function section(lines, start, stop, indent, key) {
  for (let i = start; i < stop; i += 1) {
    if (!meaningful(lines[i]) || indentOf(lines[i]) !== indent) continue;
    const match = new RegExp(`^\\s*${key}:(?:\\s+(.*?))?\\s*$`).exec(lines[i]);
    if (!match) continue;
    const inline = match[1] && !match[1].startsWith("#") ? match[1] : null;
    let end = i + 1;
    while (end < stop && (!meaningful(lines[end]) || indentOf(lines[end]) > indent || (indentOf(lines[end]) === indent && lines[end].trimStart().startsWith("-")))) end += 1;
    while (end > i + 1 && !meaningful(lines[end - 1])) end -= 1;
    return { at: i, end, inline };
  }
  return null;
}
/** The entries of a block (a mapping's keys or a list's items), each [from, to). */
function entries(lines, at, end) {
  const starts = [];
  const first = lines.slice(at + 1, end).find(meaningful);
  const child = first === undefined ? null : indentOf(first);
  for (let i = at + 1; i < end; i += 1) if (meaningful(lines[i]) && indentOf(lines[i]) === child) starts.push(i);
  return { child, ranges: starts.map((from, n) => [from, starts[n + 1] ?? end]) };
}
const EMPTY_INLINE = new Set(["{}", "[]", "null", "~"]);
/** Puts `unit` under the path, making each section that is missing; false when one is written inline. */
export function placeUnder(lines, path, unit) {
  let start = 0, stop = lines.length, indent = 0;
  for (const [n, key] of path.entries()) {
    let found = section(lines, start, stop, indent, key);
    if (found?.inline && !EMPTY_INLINE.has(found.inline)) return false;
    if (found?.inline) lines[found.at] = `${" ".repeat(indent)}${key}:`;
    if (!found) { lines.splice(stop, 0, `${" ".repeat(indent)}${key}:`); found = { at: stop, end: stop + 1 }; }
    const child = entries(lines, found.at, found.end).child ?? indent + 2;
    if (n === path.length - 1) { lines.splice(found.end, 0, ...unit.map((line) => " ".repeat(child) + line)); return true; }
    start = found.at + 1; stop = found.end; indent = child;
  }
  return true;
}
/** The section at the end of a path, in block style; null when absent or inline. */
function find(lines, path) {
  let start = 0, stop = lines.length, indent = 0, found = null;
  for (const key of path) {
    found = section(lines, start, stop, indent, key);
    if (!found || found.inline) return null;
    start = found.at + 1; stop = found.end; indent = entries(lines, found.at, found.end).child ?? indent + 2;
  }
  return found;
}
/** Takes out every entry under the path that is ours, and a section that leaves empty. */
export function takeOut(lines, path, mine) {
  const found = find(lines, path);
  if (!found) return;
  let removed = 0;
  for (const [from, to] of entries(lines, found.at, found.end).ranges.reverse()) if (mine(lines.slice(from, to).join("\n"))) { lines.splice(from, to - from); removed += 1; }
  if (removed > 0) for (let depth = path.length; depth > 0; depth -= 1) {
    const left = find(lines, path.slice(0, depth));
    if (left && !lines.slice(left.at + 1, left.end).some(meaningful)) lines.splice(left.at, left.end - left.at);
  }
}

/**
 * ONLY THE HOUSE'S OWN DOOR (0.6.16, audit L5; the same rule as log-session.mjs and count-behaviour.mjs): an MCP address is
 * WorkTrust's when its path is /api/mcp and its host is worktrust.io or a subdomain over https, the host WORKTRUST_MCP_URL
 * names, or WorkTrust's own port on this computer. `/api/mcp` alone is every hosted MCP server's conventional path, so another product's entry is
 * never adopted as the coupling, and never taken out with it.
 */
/** WorkTrust's own local doors (the app in development, 3011; a module branch, 3021). Another product's local MCP server
 * (the Advisory Board on 3007, 2026-10-09) is not one: it was offered for removal on update, and could have been adopted. */
const LOCAL_DOOR_PORTS = new Set(["3011", "3021"]);
export const isWorkTrustDoor = (url) => {
  try {
    const parsed = new URL(String(url));
    if (!/\/api\/mcp\/?$/.test(parsed.pathname)) return false;
    const own = process.env.WORKTRUST_MCP_URL ? new URL(process.env.WORKTRUST_MCP_URL).host : null;
    return parsed.protocol === "https:" && (parsed.hostname === "worktrust.io" || parsed.hostname.endsWith(".worktrust.io")) || (own !== null && parsed.host === own) || ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && LOCAL_DOOR_PORTS.has(parsed.port));
  } catch { return false; }
};

/**
 * PUT BACK WHAT A FAILED RUN TOOK OUT (security review L3, 2026-11-05). `doorSnapshot`: every config FILE setup-mcp may write
 * (its bytes, or null when absent) and Claude Code's own user-scope entry, read only. `putDoorsBack(text, name, claude)`:
 * writes those files back as they were and, with `claude` (a runner of Claude Code's own command), puts its entry back
 * through `claude mcp add-json`. Claude Code's file is never rewritten (Claude Code writes it all the time); Goose's plugin
 * folder and OpenClaw (its own command) are not kept. The snapshot travels in memory and on stdin, never in a file.
 */
export function doorSnapshot(files, claudeFile, name) {
  const regular = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
  let claude = null;
  try { claude = JSON.parse(readFileSync(claudeFile, "utf8")).mcpServers?.[name] ?? null; } catch { /* no Claude Code here */ }
  return { files: Object.fromEntries([...new Set(files)].filter((file) => regular(file) || !existsSync(file)).map((file) => [file, regular(file) ? readFileSync(file).toString("base64") : null])), claude };
}
export function putDoorsBack(text, name, claude) {
  let snapshot = null, back = 0;
  try { snapshot = JSON.parse(text); } catch { snapshot = null; }
  for (const [file, data] of Object.entries(snapshot?.files ?? {})) {
    try { if (data === null) { if (existsSync(file)) rmSync(file); } else writeFileSync(file, Buffer.from(String(data), "base64")); back += 1; }
    catch { console.log(`  ! ${file} could not be put back as it was`); }
  }
  if (snapshot?.claude && claude) { claude(["mcp", "remove", "-s", "user", name]); console.log(claude(["mcp", "add-json", "-s", "user", name, JSON.stringify(snapshot.claude)]) ? "  ↺ Claude Code: its WorkTrust entry put back" : "  ! Claude Code: its WorkTrust entry could not be put back"); }
  console.log(`  ↺ ${back} config file(s) put back as they were before this run`);
}
