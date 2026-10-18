/**
 * A WEB CHAT'S DATA EXPORT, READ ONCE FOR TWO READERS (CLI 0.10.10, owner 2026-10-10). ChatGPT (Settings → Data
 * controls → Export data) and Claude on the web (Settings → Privacy → Export data) each hand a person a zip with a
 * `conversations.json` in it. The counter reads it for signals; the session hook reads it as HISTORY, so a person's
 * years of browser chats appear on their record. One reader here, imported by both, so the two cannot drift.
 *
 * READ AS A STREAM (0.10.18, owner 2026-10-17: a real 375 MB export was refused at the old 64 MB ceiling, and some
 * exports run past 10 GB). The file is never read whole: its bytes pass through a small JSON walk of our own that keeps,
 * per conversation, only the fields the two readers use (the conversation's id and clock; per message the role, the
 * clock, ChatGPT's model name and, for ChatGPT, the tree's parent links to find the kept branch) and skips every other
 * value as it passes, never building it. A zip entry is inflated as a stream the same way. One conversation lives in
 * memory at a time; a conversation whose kept fields outgrow their budget is left out and counted, never the export.
 * The counter alone asks for the messages' text (`text: true`), read on this computer for its rubric as it always was;
 * the hook never does. A title is read for the --exclude test alone and dropped there.
 *
 * WHAT IT NEVER DOES. It opens nothing of the zip but `conversations.json` (a vendor's export carries the account's
 * profile, memories and files beside it: those are never inflated). Claude's split export (2026-10-17: a manifest and one
 * zip per category) is read through its `conversations-NNN.zip` parts alone, in part order; the manifest only names them,
 * its links are never fetched, and every other category's zip is refused by name. To the hook it hands clocks, roles and
 * a model name only: the conversation's title and every message stay here. Hours from an export are RECONSTRUCTED, never
 * measured: the file can be edited before it is read and no device key witnessed it, so the record shows them with their
 * origin and never in verified hours.
 *
 *   readExport(path)          Promise of { vendor, conversations, digest }: every conversation's kept fields, bounded
 *   exportSessions(path, …)   async: one session per conversation as it streams, in the transcript's own shape
 *   exportRef(vendor, id, day) the stretch's stable name: the same on any computer, so a second send is the same line
 *   exportRunRef(vendor, id, day, index) one run's name, when the hook cuts a conversation-day into runs (0.10.17)
 *   findExports(dir)          Promise of the exports lying in one folder (its top level only), by path and vendor
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInflateRaw } from "node:zlib";

/** The two vendors, by the client name the door reads as their product (chatgpt → chatgpt_web, claude-web → claude_web). */
export const EXPORT_CLIENTS = ["chatgpt", "claude-web"];
/** The neutral line each vendor's conversation is filed under: never the conversation's own title. */
export const EXPORT_TITLES = { chatgpt: "A conversation in ChatGPT", "claude-web": "A conversation in Claude on the web" };
const PRODUCT_NAMES = { chatgpt: "ChatGPT", "claude-web": "Claude on the web" };
export const exportProductName = (vendor) => PRODUCT_NAMES[vendor] ?? vendor;
const FILE = "conversations.json";
const expand = (path) => String(path).replace(/^~(?=\/|$)/, homedir());

// THE BOUNDS (0.10.18). A file, bare or a zip, up to 64 GB, read as a stream; a zip's directory 8 MB; up to 64 parts; a
// manifest 1 MB; nesting 64 deep; up to 2,000,000 conversations. Per conversation the KEPT fields (never the file's bytes)
// up to 8 MB (the counter's text, read here alone, 64 MB): past that the conversation is left out and counted. An export
// held whole (readExport) stops at 512 MB of kept fields. A zip64 archive (one over 4 GB) is refused by name: unpack it
// and give conversations.json itself. No limit override.
export const EXPORT_LIMITS = Object.freeze({ fileBytes: 64 * 1024 ** 3, directoryBytes: 8 * 1024 ** 2, depth: 64, conversations: 2_000_000,
  conversationBytes: 8 * 1024 ** 2, conversationTextBytes: 64 * 1024 ** 2, keptBytes: 512 * 1024 ** 2, keyBytes: 256, parts: 64, manifestBytes: 1024 ** 2 });
const PROGRESS_BYTES = 64 * 1024 ** 2, CHUNK_BYTES = 1024 ** 2;
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
      const buffer = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) { const count = readSync(fd, buffer, got, length - got, at + got); damaged(count > 0); got += count; }
      return buffer;
    };
    /** The bytes from `at`, a megabyte at a time into ONE buffer (the walk copies what it keeps, so the resident set stays flat), under the same checks: a file that shrinks while it is read is damaged. */
    const chunksOf = function* (at, length, end) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, length));
      for (let done = 0; done < length; done += CHUNK_BYTES) {
        const count = Math.min(CHUNK_BYTES, length - done);
        damaged(Number.isSafeInteger(at + done) && at >= 0 && at + done + count <= end && end <= stat.size);
        let got = 0;
        while (got < count) { const read = readSync(fd, buffer, got, count - got, at + done + got); damaged(read > 0); got += read; }
        yield buffer.subarray(0, count);
      }
    };
    return { fd, size: stat.size, readAt, chunksOf, close: () => closeSync(fd) };
  } catch (error) { closeSync(fd); throw error; }
}
/** A deflated entry, inflated as it is read: never more than a chunk of it in memory, its length held to the directory's word. */
async function* inflated(chunks, uncompressed) {
  const inflate = createInflateRaw();
  let total = 0;
  const feed = (async () => { for (const chunk of chunks) { if (inflate.destroyed) return; if (!inflate.write(chunk)) await once(inflate, "drain"); } inflate.end(); })().catch(() => null);
  try {
    for await (const piece of inflate) { total += piece.length; damaged(total <= uncompressed); yield piece; }
  } catch (error) {
    if (/^a damaged zip|^export limit/.test(error?.message ?? "")) throw error;
    throw Error("a damaged zip archive or export limit exceeded: expanded entry bytes");
  } finally { inflate.destroy(); await feed; }
  damaged(total === uncompressed);
}

/**
 * A ZIP, READ FOR ITS CONVERSATIONS ENTRIES. No dependency: the end-of-central-directory record is found from the back, the
 * central directory walked for the names `accept` takes, and only those entries' bytes read (stored or deflated, as a
 * stream; anything else, and a zip64 archive, is refused by name), in part order. Nothing else in the archive is touched.
 * Two entries of one name are ambiguous and refused. The descriptor stays open until `close`, so the bytes read are the
 * bytes the directory described.
 */
function zipEntries(path, accept) {
  const { size, readAt, chunksOf, close } = openExport(path, EXPORT_LIMITS.fileBytes);
  try {
    const tailLength = Math.min(size, 65_557);
    const tail = readAt(size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { eocd = at; break; }
    if (eocd < 0) throw Error(`not a zip archive: ${path}`);
    const entries = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryAt = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) throw Error(`a zip64 archive is not read: ${path} (unpack it and give its ${FILE})`);
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
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localAt === 0xffffffff) throw Error(`a zip64 entry is not read: ${path} (unpack it and give its ${FILE})`);
      if ((flags & (1 | 64)) !== 0 || disk !== 0) throw Error("unsupported zip: encrypted or multi-disk entry");
      damaged(!selected.has(basename(name)));
      selected.set(basename(name), { name, method, flags, compressed, uncompressed, localAt });
    }
    damaged(at === directory.length);
    limit(selected.size <= EXPORT_LIMITS.parts, "conversations parts");
    const parts = [...selected.keys()].sort(byPart).map((key) => {
      const { name, method, flags, compressed, uncompressed, localAt } = selected.get(key);
      const local = readAt(localAt, 30, directoryAt);
      damaged(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(8) === method && local.readUInt16LE(6) === flags);
      const nameLength = local.readUInt16LE(26), dataAt = localAt + 30 + nameLength + local.readUInt16LE(28);
      damaged(readAt(localAt + 30, nameLength, directoryAt).toString("utf8") === name);
      if (!(flags & 8)) damaged(local.readUInt32LE(18) === compressed && local.readUInt32LE(22) === uncompressed);
      damaged(dataAt + compressed <= directoryAt);
      if (method === 0) damaged(compressed === uncompressed);
      else if (method !== 8) throw Error(`${basename(name)} in ${path} is compressed in a way this reader does not open (method ${method})`);
      return { path, bytes: uncompressed, chunks: () => (method === 0 ? chunksOf(dataAt, compressed, directoryAt) : inflated(chunksOf(dataAt, compressed, directoryAt), uncompressed)) };
    });
    return { parts, close };
  } catch (error) { close(); throw error; }
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
  const { parts, close } = zipEntries(path, (name) => CONVERSATIONS_ENTRY.test(name));
  if (parts.length === 0) { close(); throw Error(`no ${FILE} in ${given}`); }
  return { parts, close };
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
/** Several zips' parts together: one export, inside one budget, every descriptor closed together. */
function zipsParts(zips, given) {
  limit(zips.length <= EXPORT_LIMITS.parts, "conversations parts");
  const opened = [];
  try {
    for (const zip of zips) opened.push(zipParts(zip, given));
    const parts = opened.flatMap((one) => one.parts);
    limit(parts.length <= EXPORT_LIMITS.parts && parts.reduce((sum, part) => sum + part.bytes, 0) <= EXPORT_LIMITS.fileBytes, "conversations parts");
    return { parts, close: () => { for (const one of opened) one.close(); } };
  } catch (error) { for (const one of opened) one.close(); throw error; }
}

/** Every conversations part, wherever the given path keeps them (a folder, the file itself, a zip, a part, or the manifest), each a source of chunks. */
function exportParts(given) {
  let path = expand(given);
  let stat; try { stat = statSync(path); } catch { throw Error(`export not found: ${given}`); }
  if (stat.isDirectory()) {
    if (existsSync(join(path, FILE))) path = join(path, FILE);
    else {
      const zips = folderParts(path);
      if (zips.length === 0) throw Error(`no ${FILE} in ${given}`);
      return zipsParts(zips, given);
    }
  }
  if (/\.zip$/i.test(path)) return zipParts(path, given);
  const file = openExport(path, EXPORT_LIMITS.fileBytes);
  let manifest;
  try {
    // A json holding an object, not an array of conversations, may be the vendor's manifest: read for its conversations parts alone.
    if (basename(path) === FILE || file.size > EXPORT_LIMITS.manifestBytes || !/^\s*\{/.test(file.readAt(0, Math.min(64, file.size)).toString("utf8"))) return { parts: [{ path, bytes: file.size, chunks: () => file.chunksOf(0, file.size, file.size) }], close: file.close };
    try { manifest = JSON.parse(file.readAt(0, file.size).toString("utf8")); } catch { throw Error(`export unreadable: ${path}`); }
  } catch (error) { file.close(); throw error; }
  file.close();
  return zipsParts(manifestParts(manifest, path), given);
}

// ─── THE WALK: an incremental JSON tokenizer that keeps a plan's fields and skips the rest without building it ───
/** A kept field that held an object or array where a scalar was expected: String() and Number() of it read as JSON.parse's object would. */
const NONSCALAR = Object.freeze({});
/** An element whose kept fields outgrew their budget: handed over as this, counted, never built. */
const OVERSIZED = Symbol("oversized");
const S = "scalar", T = "text"; // a scalar kept as it is; a text kept as a string for the counter, as its byte length for the hook
const NODE = { keys: { parent: S, message: { keys: { author: { keys: { role: S } }, create_time: S, content: { keys: { parts: { items: T } } }, metadata: { keys: { model_slug: S, is_visually_hidden_from_conversation: S } } } } } };
const CONVERSATION = { keys: { title: S, name: S, conversation_id: S, id: S, uuid: S, create_time: S, created_at: S, current_node: S, mapping: { any: NODE },
  chat_messages: { items: { keys: { sender: S, created_at: S, text: T, content: { items: { keys: { type: S, text: T } } } } } } } };
const malformed = () => { throw Object.assign(Error("malformed"), { malformed: true }); };
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const VALUE = 0, KEY = 1, COLON = 2, AFTER = 3, STRING = 4, TOKEN = 5, DONE = 6;
/**
 * The walk over one part's bytes, chunk by chunk, in any chunking. The top level must be an array; each of its elements is
 * handed to `onElement` as the fields of `plan` (a tree of `keys`, `any` for a dictionary, `items` for a list; `scalar`
 * and `text` at the leaves), with what `budget` allows: past it the element's kept fields are dropped and it is handed over
 * as OVERSIZED. Depth is bounded; a string's escapes and a number's shape are checked as JSON.parse would, kept or skipped.
 */
function walker(plan, { text, budget, onElement }) {
  const stack = []; // { out, plan, key, kind, fresh, root }: out is the kept container, null while skipping
  let state = VALUE, used = 0, over = false, index = 0, started = false, vPlan = null, tok = "";
  let sRaw = null, sLen = 0, sEsc = 0, sKey = false, sKeep = false, sEscaped = false;
  const top = () => stack[stack.length - 1];
  const oversize = () => { over = true; for (let i = 1; i < stack.length; i += 1) { stack[i].out = null; stack[i].plan = null; stack[i].key = null; } sRaw = null; sKeep = false; };
  const spend = (cost) => { used += cost; if (used > budget) oversize(); };
  const store = (value, cost) => {
    const frame = top();
    if (frame.root) { onElement(over ? OVERSIZED : value, index); index += 1; used = 0; over = false; }
    else if (frame.out !== null) {
      if (frame.out instanceof Map) { if (frame.key !== null) frame.out.set(frame.key, value); }
      else if (Array.isArray(frame.out)) frame.out.push(value);
      else if (frame.key !== null) frame.out[frame.key] = value;
      spend(cost + 16);
    }
    frame.key = null; vPlan = null; state = AFTER;
  };
  const open = (kind) => {
    limit(stack.length < EXPORT_LIMITS.depth, "JSON depth");
    const root = stack.length === 0, wanted = root ? { items: plan } : vPlan && typeof vPlan === "object" ? vPlan : null;
    const out = root ? null : kind === "{" && wanted?.keys ? {} : kind === "{" && wanted?.any ? new Map() : kind === "[" && wanted?.items ? [] : null;
    stack.push({ out, plan: root || out !== null ? wanted : null, key: null, kind, fresh: true, root });
    vPlan = kind === "[" ? top().plan?.items ?? null : null; state = kind === "{" ? KEY : VALUE;
  };
  const close = (kind) => { const frame = stack.pop(); if (frame.kind !== kind) malformed(); if (frame.root) state = DONE; else store(frame.out ?? NONSCALAR, 0); };
  const beginString = (key) => { state = STRING; sKey = key; sKeep = key ? top().out !== null : vPlan === S || (vPlan === T && text); sRaw = sKeep ? [] : null; sLen = 0; sEsc = 0; sEscaped = false; };
  /** Kept bytes of the string in flight: a key past its bound stops being one; a value past the budget takes the element with it. */
  const take = (chunk, from, to) => {
    sLen += to - from;
    if (!sKeep) return;
    if (sKey) { if (sLen > EXPORT_LIMITS.keyBytes) { sKeep = false; sRaw = null; return; } } else spend(to - from);
    if (sKeep) sRaw.push(Buffer.from(chunk.subarray(from, to))); // a copy: the chunk's buffer is reused for the next read
  };
  const finishString = () => {
    const raw = sRaw ? Buffer.concat(sRaw) : null;
    sRaw = null;
    const decode = () => (sEscaped ? JSON.parse(`"${raw.toString("utf8")}"`) : raw.toString("utf8"));
    if (sKey) {
      const frame = top(), key = raw ? decode() : null;
      if (frame.plan?.any && key !== null) { frame.key = key; vPlan = frame.plan.any; spend(raw.length); }
      else if (frame.plan?.keys && key !== null && Object.hasOwn(frame.plan.keys, key)) { frame.key = key; vPlan = frame.plan.keys[key]; }
      else { frame.key = null; vPlan = null; }
      state = COLON;
    } else if (sKeep) store(decode(), 0);
    else store(vPlan === T ? sLen : NONSCALAR, 8); // a text the hook never reads: its byte length says whether there was one
  };
  const finishToken = () => {
    let value;
    if (tok === "true") value = true; else if (tok === "false") value = false; else if (tok === "null") value = null;
    else if (NUMBER.test(tok)) value = Number(tok); else malformed();
    tok = ""; store(value, 8);
  };
  const push = (chunk) => {
    const n = chunk.length;
    for (let i = 0; i < n; i += 1) {
      const b = chunk[i];
      if (state === STRING) {
        if (sEsc === 0) {
          let j = i; // the common run: bytes that are neither a quote, a backslash nor a control character, taken at once
          while (j < n && chunk[j] !== 34 && chunk[j] !== 92 && chunk[j] >= 32) j += 1;
          if (j > i) { take(chunk, i, j); if (j === n) break; i = j; }
          if (chunk[i] === 34) { finishString(); continue; }
          if (chunk[i] !== 92) malformed();
          sEsc = 1; sEscaped = true; take(chunk, i, i + 1); continue;
        }
        if (sEsc === 1) { if (b === 117) sEsc = 2; else if (b === 34 || b === 92 || b === 47 || b === 98 || b === 102 || b === 110 || b === 114 || b === 116) sEsc = 0; else malformed(); }
        else { if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102))) malformed(); sEsc = sEsc === 5 ? 0 : sEsc + 1; }
        take(chunk, i, i + 1);
        continue;
      }
      if (state === TOKEN) {
        if ((b >= 48 && b <= 57) || b === 45 || b === 43 || b === 46 || (b >= 97 && b <= 122) || b === 69) { tok += String.fromCharCode(b); if (tok.length > 4096) malformed(); continue; }
        finishToken();
      }
      if (b === 32 || b === 10 || b === 13 || b === 9) continue;
      if (state === VALUE) {
        if (!started) { started = true; if (b === 123) throw Object.assign(Error("not an array"), { notArray: true }); if (b !== 91) malformed(); }
        const frame = top();
        if (b === 93) { if (frame?.kind === "[" && frame.fresh) { close("["); continue; } malformed(); }
        if (frame) frame.fresh = false;
        if (b === 34) beginString(false);
        else if (b === 123) open("{");
        else if (b === 91) open("[");
        else if ((b >= 48 && b <= 57) || b === 45 || b === 116 || b === 102 || b === 110) { state = TOKEN; tok = String.fromCharCode(b); }
        else malformed();
      } else if (state === KEY) {
        const frame = top();
        if (b === 34) { frame.fresh = false; beginString(true); }
        else if (b === 125 && frame.fresh) close("{");
        else malformed();
      } else if (state === COLON) { if (b !== 58) malformed(); state = VALUE; }
      else if (state === AFTER) {
        const frame = top();
        if (b === 44) { if (frame.kind === "{") state = KEY; else { state = VALUE; vPlan = frame.plan?.items ?? null; } }
        else if (b === 93) close("[");
        else if (b === 125) close("{");
        else malformed();
      } else malformed(); // DONE: nothing may follow the array
    }
  };
  const end = () => { if (state === TOKEN) finishToken(); if (state !== DONE) malformed(); };
  return { push, end };
}

// ─── ONE CONVERSATION'S KEPT FIELDS → ITS LINES (the shapes the old whole-file reader produced, line for line) ───
/** The kept branch of one ChatGPT conversation, oldest first: from `current_node` up through the parents. */
function chatgptBranch(kept) {
  const mapping = kept.mapping instanceof Map ? kept.mapping : new Map();
  const branch = [], seen = new Set();
  for (let id = kept.current_node; id && mapping.get(String(id)) && !seen.has(String(id)); id = mapping.get(String(id))?.parent) { seen.add(String(id)); branch.push(mapping.get(String(id))); }
  return branch.reverse();
}
/** A ChatGPT conversation's lines: the person and the model only; system prompts, tools and what the app hides are neither. */
function chatgptLines(kept, text) {
  const lines = [];
  for (const node of chatgptBranch(kept)) {
    const m = node?.message, role = m?.author?.role;
    if ((role !== "user" && role !== "assistant") || m?.metadata?.is_visually_hidden_from_conversation) continue;
    const parts = Array.isArray(m?.content?.parts) ? m.content.parts : [];
    // With the text: the string parts joined. Without: the parts' byte lengths say whether the join is empty.
    let body;
    if (text) { body = parts.filter((part) => typeof part === "string").join("\n"); if (body.length === 0) continue; }
    else { const lengths = parts.filter((part) => typeof part === "number"); if (lengths.length === 0 || (lengths.length === 1 && lengths[0] === 0)) continue; }
    const seconds = Number(m?.create_time ?? kept.create_time);
    const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
    const model = typeof m?.metadata?.model_slug === "string" ? m.metadata.model_slug : undefined;
    lines.push({ type: role === "user" ? "user" : "assistant", timestamp: at, ...(role === "assistant" && model ? { model } : {}), ...(text ? { text: body } : {}) });
  }
  return lines;
}
/** A claude.ai conversation's messages; the export names no model. */
function claudeLines(kept, text) {
  const messages = Array.isArray(kept.chat_messages) ? kept.chat_messages : [];
  return messages.map((m) => {
    const body = !text ? undefined : typeof m?.text === "string" && m.text.length > 0 ? m.text : (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "");
    return { type: m?.sender === "human" ? "user" : "assistant", timestamp: m?.created_at ?? kept.created_at ?? null, ...(text ? { text: body } : {}) };
  });
}
/** A kept line in the transcript's own shape, as the counter and the hook read every client's lines. */
const transcriptLine = ({ type, timestamp, model, text }) => ({ type, timestamp, message: { ...(model ? { model } : {}), content: [{ type: "text", text: text ?? "" }] } });

/**
 * THE EXPORT, ONE CONVERSATION AT A TIME: each part's bytes through the walk, the digest taken as they pass, the vendor
 * told from the first conversation's shape and held to (a second shape, or an unknown one, refuses the export; `expect`
 * refuses the other vendor by name), the title read for `excluded` and dropped there, a conversation whose kept fields
 * outgrow their budget counted and left out. Yields one { vendor, id, lines } per conversation (an excluded or oversized
 * one without an id, marked); `report` receives the path and vendor before the first conversation, the digest, the counts
 * and the number of parts when the stream ends. Counts only on stderr.
 */
async function* exportRecords(given, { expect = null, excluded = () => false, skipped = null, text = false, report = null } = {}) {
  const { parts, close } = exportParts(given);
  const path = parts[0].path, digest = createHash("sha256");
  let vendor = null, count = 0, oversized = 0, bytes = 0, next = PROGRESS_BYTES, offset = 0;
  if (report) { report.path = path; report.vendor = expect; report.digest = null; report.conversations = 0; report.oversized = 0; report.parts = parts.length; }
  const one = (kept, index) => {
    limit(count < EXPORT_LIMITS.conversations, "conversation count");
    count += 1;
    if (kept === OVERSIZED) { oversized += 1; return { vendor, oversized: true, lines: [] }; }
    const shape = kept && typeof kept === "object" && kept !== NONSCALAR ? (kept.mapping instanceof Map || kept.mapping === NONSCALAR ? "chatgpt" : Array.isArray(kept.chat_messages) ? "claude-web" : "unknown") : "unknown";
    if (vendor === null) vendor = shape;
    if (shape === "unknown" || shape !== vendor) throw Error(`${path} is neither a ChatGPT nor a Claude export (or mixes the two)`);
    if (expect && vendor !== expect) throw Error(`${path} is a ${exportProductName(vendor)} export, not ${exportProductName(expect)}`);
    if (report) report.vendor = vendor;
    const title = String((vendor === "chatgpt" ? kept.title : kept.name) ?? "");
    if (excluded(title)) { skipped?.push(title.slice(0, 40)); return { vendor, excluded: true, lines: [] }; }
    return { vendor, id: String((vendor === "chatgpt" ? kept.conversation_id ?? kept.id : kept.uuid) ?? `#${index}`), lines: vendor === "chatgpt" ? chatgptLines(kept, text) : claudeLines(kept, text) };
  };
  try {
    for (const part of parts) {
      let queue = [], seen = 0;
      const walk = walker(CONVERSATION, { text, budget: text ? EXPORT_LIMITS.conversationTextBytes : EXPORT_LIMITS.conversationBytes, onElement: (kept, index) => queue.push([kept, offset + index]) });
      const drain = function* () { const due = queue; queue = []; for (const [kept, index] of due) { seen = index + 1 - offset; yield one(kept, index); } };
      try {
        for await (const chunk of part.chunks()) {
          digest.update(chunk); bytes += chunk.length; walk.push(chunk);
          if (bytes >= next) { process.stderr.write(`export: ${Math.round(bytes / 1024 ** 2)} MB read, ${count} conversations\n`); next += PROGRESS_BYTES; }
          yield* drain();
        }
        walk.end();
        yield* drain();
      } catch (error) {
        if (error?.malformed) throw Error(`export unreadable: ${part.path}`);
        if (error?.notArray) throw Error(`${part.path} must contain an array of conversations`);
        throw error;
      }
      offset += seen;
    }
  } finally { close(); }
  if (report) { report.vendor = vendor ?? expect; report.digest = digest.digest("hex"); report.conversations = count; report.oversized = oversized; }
}

/** One export, read whole but compact: its vendor by shape, one record per conversation (its kept lines; none for an excluded or oversized one), and the digest of its bytes (what `sent` is remembered by). */
export async function readExport(given, expect = null, { excluded = () => false, skipped = null, text = false } = {}) {
  const report = {}, conversations = [];
  let kept = 0;
  for await (const record of exportRecords(given, { expect, excluded, skipped, text, report })) {
    kept += 64 + (record.id?.length ?? 0) + record.lines.reduce((sum, line) => sum + 64 + (line.model?.length ?? 0) + (line.text?.length ?? 0), 0);
    limit(kept <= EXPORT_LIMITS.keptBytes, "kept bytes");
    conversations.push(record);
  }
  return { vendor: report.vendor, conversations, digest: report.digest, path: report.path, parts: report.parts, oversized: report.oversized };
}

/**
 * Every conversation of an export as one session, as it streams: `key` names the vendor and the conversation's id,
 * `lines` carry the transcript shape both readers measure. `excluded(title)` skips a conversation by its title before
 * anything else of it is kept (the same `--exclude` as a project directory); the title itself goes no further than that
 * call. `text` hands the counter the messages' text (read here, for its rubric); the hook leaves it out and gets clocks,
 * roles and a model name. `given` is a path, or an export `readExport` already returned; `report` is filled as above.
 */
export async function* exportSessions(given, { expect = null, excluded = () => false, skipped = null, text = false, report = null } = {}) {
  const records = typeof given === "string" ? exportRecords(given, { expect, excluded, skipped, text, report }) : given.conversations;
  for await (const { vendor, id, lines } of records) {
    if (lines.length === 0) continue; // excluded, left out as too large, or without a message
    yield { key: `${vendor === "chatgpt" ? "chatgpt" : "claude.ai"}:${id}`, projectDir: vendor === "chatgpt" ? "chatgpt" : "claude-ai", basename: vendor === "chatgpt" ? "chatgpt" : "claude.ai", vendor, id, lines: lines.map(transcriptLine) };
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
export async function findExports(dir = join(homedir(), "Downloads")) {
  const root = expand(dir);
  let names = []; try { names = readdirSync(root); } catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    const path = join(root, name);
    let stat; try { stat = statSync(path); } catch { continue; }
    const candidate = stat.isDirectory() ? existsSync(join(path, FILE)) || folderParts(path).length > 0 : (/\.zip$/i.test(name) && !OTHER_PART.test(name)) || name === FILE;
    if (!candidate) continue;
    try {
      const { vendor, conversations, digest } = await readExport(path);
      if (vendor && conversations.length > 0) found.push({ path, vendor, digest, conversations: conversations.length });
    } catch { /* not an export, or not one this reader opens */ }
  }
  return found;
}
