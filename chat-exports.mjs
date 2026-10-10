/**
 * A WEB CHAT'S DATA EXPORT, READ ONCE FOR TWO READERS (CLI 0.10.10, owner 2026-10-10). ChatGPT (Settings → Data
 * controls → Export data) and Claude on the web (Settings → Privacy → Export data) each hand a person a zip with a
 * `conversations.json` in it. The counter reads it for signals; the session hook reads it as HISTORY, so a person's
 * years of browser chats appear on their record. One reader here, imported by both, so the two cannot drift.
 *
 * WHAT IT NEVER DOES. It opens nothing of the zip but `conversations.json` (a vendor's export carries the account's
 * profile, memories and files beside it: those are never inflated). It hands the text to the counter's rubric on this
 * computer, as it always did, and to the hook it hands clocks, roles and a model name only: the conversation's title
 * and every message stay here. Hours from an export are RECONSTRUCTED, never measured: the file can be edited before
 * it is read and no device key witnessed it, so the record shows them with their origin and never in verified hours.
 *
 *   readExport(path)          { vendor, conversations, digest }   a folder holding conversations.json, the file, or the zip
 *   exportSessions(path, …)   one session per conversation, in the transcript's own shape (type, timestamp, message)
 *   exportRef(vendor, id, day) the stretch's stable name: the same on any computer, so a second send is the same line
 *   findExports(dir)          the exports lying in one folder (its top level only), by path and vendor
 */
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** The two vendors, by the client name the door reads as their product (chatgpt → chatgpt_web, claude-web → claude_web). */
export const EXPORT_CLIENTS = ["chatgpt", "claude-web"];
/** The neutral line each vendor's conversation is filed under: never the conversation's own title. */
export const EXPORT_TITLES = { chatgpt: "A conversation in ChatGPT", "claude-web": "A conversation in Claude on the web" };
const PRODUCT_NAMES = { chatgpt: "ChatGPT", "claude-web": "Claude on the web" };
export const exportProductName = (vendor) => PRODUCT_NAMES[vendor] ?? vendor;
const FILE = "conversations.json";
const expand = (path) => String(path).replace(/^~(?=\/|$)/, homedir());

/**
 * A ZIP, READ FOR ONE ENTRY. No dependency: the end-of-central-directory record is found from the back, the central
 * directory walked for the one name, and only that entry's bytes inflated (stored or deflated; anything else, and a
 * zip64 archive, is refused by name). Nothing else in the archive is touched.
 */
function zipEntry(path, wanted) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const readAt = (at, length) => { const buffer = Buffer.alloc(length); const got = readSync(fd, buffer, 0, length, at); return buffer.subarray(0, got); };
  try {
    const tailLength = Math.min(size, 65_557);
    const tail = readAt(size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
    if (eocd < 0) throw Error(`not a zip archive: ${path}`);
    const entries = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryAt = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw Error(`a zip64 archive is not read: ${path}`);
    const directory = readAt(directoryAt, directorySize);
    let at = 0;
    for (let index = 0; index < entries && at + 46 <= directory.length; index += 1) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw Error(`a damaged zip archive: ${path}`);
      const method = directory.readUInt16LE(at + 10), compressed = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32), localAt = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (basename(name) !== wanted || name.endsWith("/")) continue;
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localAt === 0xffffffff) throw Error(`a zip64 entry is not read: ${path}`);
      const local = readAt(localAt, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw Error(`a damaged zip archive: ${path}`);
      const dataAt = localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const bytes = readAt(dataAt, compressed);
      if (method === 0) return bytes;
      if (method === 8) return inflateRawSync(bytes);
      throw Error(`${wanted} in ${path} is compressed in a way this reader does not open (method ${method})`);
    }
    return null;
  } finally { closeSync(fd); }
}

/** The bytes of `conversations.json`, wherever the given path keeps them: a folder, the file itself, or the vendor's zip. */
function exportBytes(given) {
  const path = expand(given);
  let stat; try { stat = statSync(path); } catch { throw Error(`export not found: ${given}`); }
  if (stat.isDirectory()) { const file = join(path, FILE); if (!existsSync(file)) throw Error(`no ${FILE} in ${given}`); return { bytes: readFileSync(file), path: file }; }
  if (/\.zip$/i.test(path)) { const bytes = zipEntry(path, FILE); if (!bytes) throw Error(`no ${FILE} in ${given}`); return { bytes, path }; }
  return { bytes: readFileSync(path), path };
}

/** Which vendor wrote these conversations, by their shape alone; mixed or unknown shapes are refused, never guessed. */
export function vendorOf(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) return null;
  const shapes = new Set(conversations.map((c) => (c && typeof c === "object" && c.mapping && typeof c.mapping === "object" ? "chatgpt" : c && typeof c === "object" && Array.isArray(c.chat_messages) ? "claude-web" : "unknown")));
  return shapes.size === 1 ? [...shapes][0] : null;
}

/** One export, read: its vendor by shape, its conversations, and the digest of its bytes (what `sent` is remembered by). */
export function readExport(given, expect = null) {
  const { bytes, path } = exportBytes(given);
  let conversations; try { conversations = JSON.parse(bytes.toString("utf8")); } catch { throw Error(`export unreadable: ${path}`); }
  if (!Array.isArray(conversations)) throw Error(`${path} must contain an array of conversations`);
  const vendor = vendorOf(conversations);
  if (conversations.length > 0 && !vendor) throw Error(`${path} is neither a ChatGPT nor a Claude export (or mixes the two)`);
  if (expect && vendor && vendor !== expect) throw Error(`${path} is a ${exportProductName(vendor)} export, not ${exportProductName(expect)}`);
  return { vendor: vendor ?? expect, conversations, digest: createHash("sha256").update(bytes).digest("hex"), path };
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
    const candidate = stat.isDirectory() ? existsSync(join(path, FILE)) : /\.zip$/i.test(name) || name === FILE;
    if (!candidate) continue;
    try {
      const { vendor, conversations, digest } = readExport(path);
      if (vendor && conversations.length > 0) found.push({ path, vendor, digest, conversations: conversations.length });
    } catch { /* not an export, or not one this reader opens */ }
  }
  return found;
}
