/**
 * A WEB CHAT'S DATA EXPORT, READ ONCE FOR TWO READERS (CLI 0.10.10, owner 2026-10-10). ChatGPT (Settings → Data
 * controls → Export data) and Claude on the web (Settings → Privacy → Export data) each hand a person a zip with a
 * `conversations.json` in it. The counter reads it for signals; the session hook reads it as HISTORY, so a person's
 * years of browser chats appear on their record. One reader here, imported by both, so the two cannot drift.
 *
 * WHAT IT NEVER DOES. It opens nothing of the zip but `conversations.json` (a vendor's export carries the account's
 * profile, memories and files beside it: those are never inflated). Claude's split export (2026-10-17: a manifest and one
 * zip per category) is read through its `conversations-NNN.zip` parts alone, in part order; the manifest only names them,
 * its links are never fetched, and every other category's zip is refused by name. It hands the text to the counter's rubric on this
 * computer, as it always did, and to the hook it hands clocks, roles and a model name only: the conversation's title
 * and every message stay here. Hours from an export are RECONSTRUCTED, never measured: the file can be edited before
 * it is read and no device key witnessed it, so the record shows them with their origin and never in verified hours.
 *
 *   readExport(path)          { vendor, conversations, digest }   a folder holding conversations.json or conversations
 *                             parts, the file, the zip, one conversations-NNN.zip part, or Claude's manifest json
 *   exportSessions(path, …)   one session per conversation, in the transcript's own shape (type, timestamp, message)
 *   exportRef(vendor, id, day) the stretch's stable name: the same on any computer, so a second send is the same line
 *   exportRunRef(vendor, id, day, index) one run's name, when the hook cuts a conversation-day into runs (0.10.17)
 *   findExports(dir)          the exports lying in one folder (its top level only), by path and vendor
 */
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** The two vendors, by the client name the door reads as their product (chatgpt → chatgpt_web, claude-web → claude_web). */
export const EXPORT_CLIENTS = ["chatgpt", "claude-web"];
/** The neutral line each vendor's conversation is filed under: never the conversation's own title. */
export const EXPORT_TITLES = { chatgpt: "A conversation in ChatGPT", "claude-web": "A conversation in Claude on the web" };
const PRODUCT_NAMES = { chatgpt: "ChatGPT", "claude-web": "Claude on the web" };
export const exportProductName = (vendor) => PRODUCT_NAMES[vendor] ?? vendor;
const FILE = "conversations.json";
const expand = (path) => String(path).replace(/^~(?=\/|$)/, homedir());

// Bound allocations and parsing work before touching untrusted sizes. Large attachment-bearing ZIPs
// need not fit in memory; only the directory and conversations entry are ever read. No limit override.
export const EXPORT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 ** 3, directoryBytes: 8 * 1024 ** 2,
  jsonBytes: 64 * 1024 ** 2, compressedBytes: 64 * 1024 ** 2, depth: 64, structure: 1_000_000, conversations: 50_000,
  parts: 64, manifestBytes: 1024 ** 2 });
const limit = (condition, label) => { if (!condition) throw Error(`export limit exceeded: ${label}`); };
const damaged = (condition) => { if (!condition) throw Error("a damaged zip archive"); };
/** One descriptor, bounded reads: reject special files/short reads and bound concurrent file growth. */
function openExport(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error("export must be a regular file");
    limit(stat.size <= maximum, "file bytes");
    const readAt = (at, length, end = stat.size) => {
      damaged(Number.isSafeInteger(at) && Number.isSafeInteger(length) && at >= 0 && length >= 0 && at + length <= end && end <= stat.size);
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) { const count = readSync(fd, buffer, got, length - got, at + got); damaged(count > 0); got += count; }
      return buffer;
    };
    return { fd, size: stat.size, readAt };
  } catch (error) { closeSync(fd); throw error; }
}

/**
 * A ZIP, READ FOR ITS CONVERSATIONS ENTRIES. No dependency: the end-of-central-directory record is found from the back, the
 * central directory walked for the names `accept` takes, and only those entries' bytes inflated (stored or deflated;
 * anything else, and a zip64 archive, is refused by name), in part order. Nothing else in the archive is touched. Two
 * entries of one name are ambiguous and refused.
 */
function zipEntries(path, accept) {
  const { fd, size, readAt } = openExport(path, EXPORT_LIMITS.fileBytes);
  try {
    const tailLength = Math.min(size, 65_557);
    const tail = readAt(size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { eocd = at; break; }
    if (eocd < 0) throw Error(`not a zip archive: ${path}`);
    const entries = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryAt = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw Error(`a zip64 archive is not read: ${path}`);
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw Error("unsupported zip: multiple disks");
    damaged(tail.readUInt16LE(eocd + 8) === entries);
    limit(directorySize <= EXPORT_LIMITS.directoryBytes, "zip directory bytes");
    damaged(directoryAt + directorySize === size - tailLength + eocd);
    const directory = readAt(directoryAt, directorySize);
    let at = 0;
    const selected = new Map();
    for (let index = 0; index < entries; index += 1) {
      damaged(at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50);
      const method = directory.readUInt16LE(at + 10), compressed = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32), localAt = directory.readUInt32LE(at + 42);
      const flags = directory.readUInt16LE(at + 8), disk = directory.readUInt16LE(at + 34);
      damaged(at + 46 + nameLength + extraLength + commentLength <= directory.length);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (!accept(basename(name)) || name.endsWith("/")) continue;
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localAt === 0xffffffff) throw Error(`a zip64 entry is not read: ${path}`);
      limit(compressed <= EXPORT_LIMITS.compressedBytes, "compressed entry bytes");
      limit(uncompressed <= EXPORT_LIMITS.jsonBytes, "expanded entry bytes");
      if ((flags & (1 | 64)) !== 0 || disk !== 0) throw Error("unsupported zip: encrypted or multi-disk entry");
      damaged(!selected.has(basename(name)));
      selected.set(basename(name), { name, method, flags, compressed, uncompressed, localAt });
    }
    damaged(at === directory.length);
    limit(selected.size <= EXPORT_LIMITS.parts, "conversations parts");
    let total = 0;
    return [...selected.keys()].sort(byPart).map((key) => {
      const { name, method, flags, compressed, uncompressed, localAt } = selected.get(key);
      total += uncompressed;
      limit(total <= EXPORT_LIMITS.jsonBytes, "expanded entry bytes");
      const local = readAt(localAt, 30, directoryAt);
      damaged(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(8) === method && local.readUInt16LE(6) === flags);
      const nameLength = local.readUInt16LE(26), dataAt = localAt + 30 + nameLength + local.readUInt16LE(28);
      damaged(readAt(localAt + 30, nameLength, directoryAt).toString("utf8") === name);
      if (!(flags & 8)) damaged(local.readUInt32LE(18) === compressed && local.readUInt32LE(22) === uncompressed);
      const bytes = readAt(dataAt, compressed, directoryAt);
      if (method === 0) { damaged(compressed === uncompressed); return bytes; }
      if (method !== 8) throw Error(`${basename(name)} in ${path} is compressed in a way this reader does not open (method ${method})`);
      let inflated;
      try { inflated = inflateRawSync(bytes, { maxOutputLength: Math.max(1, uncompressed) }); }
      catch { throw Error("a damaged zip archive or export limit exceeded: expanded entry bytes"); }
      damaged(inflated.length === uncompressed);
      return inflated;
    });
  } finally { closeSync(fd); }
}

/**
 * THE CONVERSATIONS, AND ONLY THEM (owner, 2026-10-17). Inside a zip: `conversations.json`, or a part-numbered
 * `conversations-000.json`. Claude on the web now hands a person a manifest and one zip per category; of those only the
 * `conversations-NNN.zip` parts are read. The other categories (memories, projects, artifacts, frames, design chats, the
 * light metadata) are refused by their name, never opened.
 */
const CONVERSATIONS_ENTRY = /^conversations(?:[-_]\d{1,6})?\.json$/i;
const CONVERSATIONS_PART = /^conversations[-_](\d{1,6})\.zip$/i;
const OTHER_PART = /^(light_metadata|projects|memories|design_chats|frames|artifact_data|users?|attachments?)[-_]\d{1,6}\.zip$/i;
const partOf = (name) => Number(/(\d{1,6})\.(?:json|zip)$/i.exec(name)?.[1] ?? -1);
const byPart = (a, b) => partOf(a) - partOf(b) || a.localeCompare(b);
const refuseOther = (path) => { const other = OTHER_PART.exec(basename(path)); if (other) throw Error(`${basename(path)} is the export's ${other[1].toLowerCase()} part: only its conversations parts are read`); };
/** One conversations zip: its conversations entries, or a refusal that names the zip. */
function zipParts(path, given) {
  refuseOther(path);
  const parts = zipEntries(path, (name) => CONVERSATIONS_ENTRY.test(name));
  if (parts.length === 0) throw Error(`no ${FILE} in ${given}`);
  return parts.map((bytes) => ({ bytes, path }));
}
/** A folder's conversations zips (conversations-000.zip, -001.zip …), in part order; nothing else of the folder is read. */
const folderParts = (dir) => { let names = []; try { names = readdirSync(dir); } catch { return []; } return names.filter((name) => CONVERSATIONS_PART.test(name)).sort(byPart).map((name) => join(dir, name)); };
/**
 * THE MANIFEST (Claude on the web, version "1.0"): a list of `data_files` with a category, a part, a file name and a link.
 * It is read for the file names of its conversations parts alone, which must lie beside it; a link in it is NEVER fetched
 * (this reader opens no network), and a name that is not a plain conversations zip in the same folder is refused.
 */
function manifestParts(manifest, path) {
  const files = Array.isArray(manifest?.data_files) ? manifest.data_files : null;
  if (!files) throw Error(`${path} is neither an export nor its manifest`);
  limit(files.length <= 10_000, "manifest entries");
  const wanted = files.filter((file) => file && typeof file === "object" && file.category === "conversations").map((file) => String(file.filename ?? ""));
  if (wanted.length === 0) throw Error(`${path} names no conversations part`);
  const missing = [], found = [];
  for (const name of wanted.sort(byPart)) {
    if (!/^[\w.-]{1,200}$/.test(name) || !CONVERSATIONS_PART.test(name)) throw Error(`${path} names a conversations part that is not a plain conversations zip beside it`);
    const at = join(dirname(path), name);
    if (existsSync(at)) found.push(at); else missing.push(name);
  }
  if (missing.length > 0) throw Error(`the manifest names conversations parts that are not beside it: ${missing.join(", ")} (download them into the same folder; the links in the manifest are never followed)`);
  return found;
}
/** Several parts together stay inside one export's budget. */
const withinBudget = (parts) => { limit(parts.length <= EXPORT_LIMITS.parts && parts.reduce((sum, part) => sum + part.bytes.length, 0) <= EXPORT_LIMITS.jsonBytes * 4, "conversations parts"); return parts; };

/** The bytes of every conversations part, wherever the given path keeps them: a folder, the file itself, a zip, a part, or the manifest. */
function exportParts(given) {
  let path = expand(given);
  let stat; try { stat = statSync(path); } catch { throw Error(`export not found: ${given}`); }
  if (stat.isDirectory()) {
    if (existsSync(join(path, FILE))) path = join(path, FILE);
    else {
      const zips = folderParts(path);
      if (zips.length === 0) throw Error(`no ${FILE} in ${given}`);
      limit(zips.length <= EXPORT_LIMITS.parts, "conversations parts");
      return withinBudget(zips.flatMap((zip) => zipParts(zip, given)));
    }
  }
  if (/\.zip$/i.test(path)) return zipParts(path, given);
  const { fd, size, readAt } = openExport(path, EXPORT_LIMITS.jsonBytes);
  let bytes; try { bytes = readAt(0, size); } finally { closeSync(fd); }
  // A json holding an object, not an array of conversations, may be the vendor's manifest: read for its conversations parts alone.
  if (basename(path) !== FILE && size <= EXPORT_LIMITS.manifestBytes && /^\s*\{/.test(bytes.subarray(0, 64).toString("utf8"))) {
    boundJson(bytes);
    let manifest; try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw Error(`export unreadable: ${path}`); }
    const zips = manifestParts(manifest, path);
    limit(zips.length <= EXPORT_LIMITS.parts, "conversations parts");
    return withinBudget(zips.flatMap((zip) => zipParts(zip, given)));
  }
  return [{ bytes, path }];
}

/** Scan bytes before JSON.parse allocates an object graph; escaped quotes/brackets inside strings
 * are content, not structure. JSON.parse remains responsible for syntax and UTF-8 string handling. */
function boundJson(bytes) {
  let quoted = false, escaped = false, depth = 0, structure = 0;
  for (const byte of bytes) {
    if (quoted) { if (escaped) escaped = false; else if (byte === 92) escaped = true; else if (byte === 34) quoted = false; continue; }
    if (byte === 34) quoted = true;
    else if (byte === 91 || byte === 123) { depth += 1; structure += 1; limit(depth <= EXPORT_LIMITS.depth, "JSON depth"); }
    else if (byte === 93 || byte === 125) depth -= 1;
    else if (byte === 44 || byte === 58) structure += 1;
    limit(structure <= EXPORT_LIMITS.structure, "JSON structure");
  }
}

/** Which vendor wrote these conversations, by their shape alone; mixed or unknown shapes are refused, never guessed. */
export function vendorOf(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) return null;
  const shapes = new Set(conversations.map((c) => (c && typeof c === "object" && c.mapping && typeof c.mapping === "object" ? "chatgpt" : c && typeof c === "object" && Array.isArray(c.chat_messages) ? "claude-web" : "unknown")));
  return shapes.size === 1 ? [...shapes][0] : null;
}

/** One export, read: its vendor by shape, its conversations, and the digest of its bytes (what `sent` is remembered by). */
export function readExport(given, expect = null) {
  const parts = exportParts(given), digest = createHash("sha256");
  const path = parts[0].path;
  const conversations = [];
  for (const { bytes, path: from } of parts) {
    boundJson(bytes);
    let some; try { some = JSON.parse(bytes.toString("utf8")); } catch { throw Error(`export unreadable: ${from}`); }
    if (!Array.isArray(some)) throw Error(`${from} must contain an array of conversations`);
    limit(conversations.length + some.length <= EXPORT_LIMITS.conversations, "conversation count");
    for (const conversation of some) conversations.push(conversation);
    digest.update(bytes); // one part: the digest of its bytes, as before; several: of their bytes in part order
  }
  const vendor = vendorOf(conversations);
  if (conversations.length > 0 && !vendor) throw Error(`${path} is neither a ChatGPT nor a Claude export (or mixes the two)`);
  if (expect && vendor && vendor !== expect) throw Error(`${path} is a ${exportProductName(vendor)} export, not ${exportProductName(expect)}`);
  return { vendor: vendor ?? expect, conversations, digest: digest.digest("hex"), path, parts: parts.length };
}

/** The kept branch of one ChatGPT conversation, oldest first: from `current_node` up through the parents. */
function chatgptBranch(conversation) {
  const mapping = conversation?.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};
  const branch = [];
  const seen = new Set();
  for (let id = conversation?.current_node; id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); branch.push(mapping[id]); }
  return branch.reverse();
}
/** A ChatGPT conversation's lines: the person and the model only; system prompts, tools and what the app hides are neither. */
function chatgptLines(conversation) {
  const lines = [];
  for (const node of chatgptBranch(conversation)) {
    const m = node?.message;
    const role = m?.author?.role;
    if ((role !== "user" && role !== "assistant") || m?.metadata?.is_visually_hidden_from_conversation) continue;
    const parts = Array.isArray(m?.content?.parts) ? m.content.parts.filter((part) => typeof part === "string") : [];
    const text = parts.join("\n");
    if (text.length === 0) continue;
    const seconds = Number(m?.create_time ?? conversation?.create_time);
    const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
    const model = typeof m?.metadata?.model_slug === "string" ? m.metadata.model_slug : undefined;
    lines.push({ type: role === "user" ? "user" : "assistant", timestamp: at, message: { ...(role === "assistant" && model ? { model } : {}), content: [{ type: "text", text }] } });
  }
  return lines;
}
/** A claude.ai conversation's messages in the transcript's own shape; the export names no model. */
function claudeLines(conversation) {
  const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
  return messages.map((m) => {
    const text = typeof m?.text === "string" && m.text.length > 0 ? m.text : (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "");
    const at = m?.created_at ?? conversation?.created_at ?? null;
    return { type: m?.sender === "human" ? "user" : "assistant", timestamp: at, message: { content: [{ type: "text", text }] } };
  });
}
const titleOf = (vendor, conversation) => String((vendor === "chatgpt" ? conversation?.title : conversation?.name) ?? "");
const idOf = (vendor, conversation, index) => String((vendor === "chatgpt" ? conversation?.conversation_id ?? conversation?.id : conversation?.uuid) ?? `#${index}`);

/**
 * Every conversation of an export as one session: `key` names the vendor and the conversation's id, `lines` carry
 * the transcript shape both readers measure. `excluded(title)` skips a conversation by its title before anything of
 * it is read (the same `--exclude` as a project directory); the title itself goes no further than that call.
 * `given` is a path, or an export `readExport` already returned (so a zip is inflated once).
 */
export function* exportSessions(given, { expect = null, excluded = () => false, skipped = null } = {}) {
  const { vendor, conversations } = typeof given === "string" ? readExport(given, expect) : given;
  for (let index = 0; index < conversations.length; index += 1) {
    const conversation = conversations[index];
    const title = titleOf(vendor, conversation);
    if (excluded(title)) { skipped?.push(title.slice(0, 40)); continue; }
    const lines = vendor === "chatgpt" ? chatgptLines(conversation) : claudeLines(conversation);
    if (lines.length === 0) continue;
    const id = idOf(vendor, conversation, index);
    yield { key: `${vendor === "chatgpt" ? "chatgpt" : "claude.ai"}:${id}`, projectDir: vendor === "chatgpt" ? "chatgpt" : "claude-ai", basename: vendor === "chatgpt" ? "chatgpt" : "claude.ai", vendor, id, lines };
  }
}

/**
 * THE STRETCH'S NAME (the hook's `stretch_ref`, 43 characters): a hash of the vendor, the conversation's id and the
 * UTC day, the same on any computer and on any copy of the export, so the same export sent twice, or from two
 * computers, is each line once. The conversation's id is a vendor's opaque id; the hash carries nothing readable.
 */
export const exportRef = (vendor, id, day) => createHash("sha256").update(`worktrust-export|${vendor}|${id}|${day}`).digest("base64url");
/**
 * ONE RUN'S NAME (CLI 0.10.17, owner 2026-10-17): a conversation-day the hook cuts into runs of activity names each run by
 * the same three and the run's index, in order from the day's first message. A day of one run keeps `exportRef`, the name
 * it always had, so a day sent before the cut is the same line; a day of several runs names that old line as the one its
 * runs replace (the hook's `supersedes_ref`).
 */
export const exportRunRef = (vendor, id, day, index) => createHash("sha256").update(`worktrust-export|${vendor}|${id}|${day}|run|${index}`).digest("base64url");

/**
 * THE EXPORTS IN ONE FOLDER, its top level only (the Downloads folder, where a vendor's export lands): a zip holding
 * `conversations.json`, a folder holding one, or the file itself. Each is read to tell its vendor and digest; a file
 * that is none of these, or not an export, is passed over without a word.
 */
export function findExports(dir = join(homedir(), "Downloads")) {
  const root = expand(dir);
  let names = []; try { names = readdirSync(root); } catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    let stat; try { stat = statSync(path); } catch { continue; }
    const candidate = stat.isDirectory() ? existsSync(join(path, FILE)) || folderParts(path).length > 0 : (/\.zip$/i.test(name) && !OTHER_PART.test(name)) || name === FILE;
    if (!candidate) continue;
    try {
      const { vendor, conversations, digest } = readExport(path);
      if (vendor && conversations.length > 0) found.push({ path, vendor, digest, conversations: conversations.length });
    } catch { /* not an export, or not one this reader opens */ }
  }
  return found;
}
