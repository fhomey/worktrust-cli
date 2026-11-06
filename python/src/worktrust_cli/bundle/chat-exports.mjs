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
  conversationBytes: 8 * 1024 ** 2, conversationTextBytes: 64 * 1024 ** 2, keptBytes: 512 * 1024 ** 2, keyBytes: 256, parts: 64, manifestBytes: 1024 ** 2, zipEntries: 1_000_000 });
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
 * A ZIP, READ FOR ITS CONVERSATIONS ENTRIES. No dependency: the end-of-central-directory record is found from the back (and,
 * for an archive past 4 GB, the zip64 record its locator names), the central directory walked for the names `accept` takes,
 * and only those entries' bytes read (stored or deflated, as a stream; anything else is refused by name), in part order.
 * Nothing else in the archive is touched. Two entries of one name, or a numbered part missing from the run, are refused. The
 * descriptor stays open until `close`, so the bytes read are the bytes the directory described. An archive with no end
 * record that begins with an entry is a download CUT OFF (2026-10-31): its local headers are walked instead (`walkLocal`).
 */
function zipEntries(path, accept) {
  const { size, readAt, chunksOf, close } = openExport(path, EXPORT_LIMITS.fileBytes);
  try {
    const tailLength = Math.min(size, 65_557);
    const tail = readAt(size - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { eocd = at; break; }
    if (eocd < 0) {
      if (size < 30 || readAt(0, 4).readUInt32LE(0) !== LOCAL) throw Error(`not a zip archive: ${path}`);
      const { selected, cut } = walkLocal(path, size, readAt, accept);
      return { parts: entryParts(path, selected, size, readAt, chunksOf, true), close, cut };
    }
    const endAt = size - tailLength + eocd;
    let entries = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryAt = tail.readUInt32LE(eocd + 16), directoryEnd = endAt;
    if (entries === 0xffff || directorySize === U32 || directoryAt === U32) {
      // ZIP64 (an archive past 4 GB or 65,535 entries): the locator lies just before the end record and names the zip64 end record, which holds the true counts.
      damaged(endAt >= 20);
      const locator = readAt(endAt - 20, 20);
      damaged(locator.readUInt32LE(0) === 0x07064b50);
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw Error("unsupported zip: multiple disks");
      const recordAt = big(locator, 8), record = readAt(recordAt, 56, endAt - 20);
      damaged(record.readUInt32LE(0) === 0x06064b50 && recordAt + 12 + big(record, 4) === endAt - 20);
      if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw Error("unsupported zip: multiple disks");
      entries = big(record, 32); damaged(big(record, 24) === entries);
      directorySize = big(record, 40); directoryAt = big(record, 48); directoryEnd = recordAt;
    } else {
      if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw Error("unsupported zip: multiple disks");
      damaged(tail.readUInt16LE(eocd + 8) === entries);
    }
    limit(directorySize <= EXPORT_LIMITS.directoryBytes, "zip directory bytes");
    damaged(directoryAt + directorySize === directoryEnd);
    const directory = readAt(directoryAt, directorySize);
    let at = 0;
    const selected = new Map();
    for (let index = 0; index < entries; index += 1) {
      damaged(at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50);
      const method = directory.readUInt16LE(at + 10);
      let compressed = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24), localAt = directory.readUInt32LE(at + 42);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
      const flags = directory.readUInt16LE(at + 8), disk = directory.readUInt16LE(at + 34);
      damaged(at + 46 + nameLength + extraLength + commentLength <= directory.length);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength), extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (!accept(basename(name)) || name.endsWith("/")) continue;
      if (compressed === U32 || uncompressed === U32 || localAt === U32) [uncompressed, compressed, localAt] = zip64Extra(extra, [uncompressed, compressed, localAt]);
      if ((flags & (1 | 64)) !== 0 || disk !== 0) throw Error("unsupported zip: encrypted or multi-disk entry");
      damaged(!selected.has(basename(name)));
      selected.set(basename(name), { name, method, flags, compressed, uncompressed, localAt });
    }
    damaged(at === directory.length);
    return { parts: entryParts(path, selected, directoryAt, readAt, chunksOf, false), close, cut: null };
  } catch (error) { close(); throw error; }
}
const LOCAL = 0x04034b50, U32 = 0xffffffff;
/** An eight-byte length or offset, held to what a number can say exactly. */
const big = (buffer, at) => { const value = buffer.readBigUInt64LE(at); damaged(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); };
/** The zip64 extended-information field (id 0x0001): an eight-byte value for each of `words` that reads 0xffffffff, in the spec's order; the others as they are. */
function zip64Extra(extra, words) {
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
    const end = at + 4 + extra.readUInt16LE(at + 2);
    damaged(end <= extra.length);
    if (extra.readUInt16LE(at) !== 1) continue;
    let next = at + 4;
    return words.map((word) => { if (word !== U32) return word; damaged(next + 8 <= end); const value = big(extra, next); next += 8; return value; });
  }
  return damaged(false);
}
/** The selected entries as parts in part order, each held to its local header (method, flags, name and lengths) and its bytes before `end`. */
function entryParts(path, selected, end, readAt, chunksOf, walked) {
  limit(selected.size <= EXPORT_LIMITS.parts, "conversations parts");
  contiguous([...selected.keys()], path);
  return [...selected.keys()].sort(byPart).map((key) => {
    const { name, method, flags, compressed, uncompressed, localAt } = selected.get(key);
    const local = readAt(localAt, 30, end);
    damaged(local.readUInt32LE(0) === LOCAL && local.readUInt16LE(8) === method && local.readUInt16LE(6) === flags);
    const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28), dataAt = localAt + 30 + nameLength + extraLength;
    damaged(readAt(localAt + 30, nameLength, end).toString("utf8") === name);
    if (!walked && !(flags & 8)) {
      let sizes = [local.readUInt32LE(22), local.readUInt32LE(18)];
      if (sizes.includes(U32)) sizes = zip64Extra(readAt(localAt + 30 + nameLength, extraLength, end), [U32, U32]);
      damaged(sizes[1] === compressed && sizes[0] === uncompressed);
    }
    damaged(dataAt + compressed <= end);
    if (method === 0) damaged(compressed === uncompressed);
    else if (method !== 8) throw Error(`${basename(name)} in ${path} is compressed in a way this reader does not open (method ${method})`);
    return { path, bytes: uncompressed, chunks: () => (method === 0 ? chunksOf(dataAt, compressed, end) : inflated(chunksOf(dataAt, compressed, end), uncompressed)) };
  });
}
/**
 * A ZIP CUT OFF (2026-10-31: the owner's 4 GB ChatGPT export, downloaded, stopped inside an attachment; it has no central
 * directory and no end record). Its LOCAL headers are walked from the front, each passed by the lengths it carries, its data
 * never read: only an entry `accept` takes is kept, and only one whose header carries its real lengths (an entry that defers
 * them to a data descriptor cannot be passed without inflating it, so the walk stops there and says so). The walk ends at the
 * first entry the file does not hold whole, or at the directory if the cut came later. A cut inside a conversations entry
 * refuses the export by that entry's name; otherwise what was read is handed over WITH the cut (`cut`), never as the whole.
 */
function walkLocal(path, size, readAt, accept) {
  const selected = new Map();
  let at = 0, walked = 0, where = null;
  for (;;) {
    if (at === size) { where = "at the end of an entry"; break; }
    if (at + 30 > size) { where = "inside an entry's header"; break; }
    const local = readAt(at, 30), signature = local.readUInt32LE(0);
    if (signature === 0x02014b50 || signature === 0x06064b50) { where = "inside its directory"; break; }
    damaged(signature === LOCAL);
    limit((walked += 1) <= EXPORT_LIMITS.zipEntries, "zip entries");
    const flags = local.readUInt16LE(6), method = local.readUInt16LE(8), nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
    if (at + 30 + nameLength + extraLength > size) { where = "inside an entry's header"; break; }
    const name = readAt(at + 30, nameLength).toString("utf8"), extra = readAt(at + 30 + nameLength, extraLength);
    let compressed = local.readUInt32LE(18), uncompressed = local.readUInt32LE(22);
    const wide = compressed === U32 || uncompressed === U32;
    if (wide) [uncompressed, compressed] = zip64Extra(extra, [U32, U32]);
    const wanted = accept(basename(name)) && !name.endsWith("/"), dataAt = at + 30 + nameLength + extraLength;
    if ((flags & 8) && compressed === 0 && uncompressed === 0) {
      if (wanted) throw Error(`${basename(name)} in ${path} carries no length in its header and the archive has no directory: it cannot be read without one`);
      where = "at an entry whose header carries no length"; break;
    }
    if (dataAt + compressed > size) {
      if (wanted) throw Error(`${path} is cut off inside ${basename(name)} (the file ends at byte ${size}; the entry needs ${dataAt + compressed}): download the export again`);
      where = "inside an entry that is not a conversations part"; break;
    }
    if (wanted) {
      if ((flags & (1 | 64)) !== 0) throw Error("unsupported zip: encrypted or multi-disk entry");
      damaged(!selected.has(basename(name)));
      selected.set(basename(name), { name, method, flags, compressed, uncompressed, localAt: at });
    }
    at = dataAt + compressed;
    if (flags & 8) { // the data descriptor after the data: an optional signature, the crc and two lengths (eight bytes each in zip64)
      const length = (at + 4 <= size && readAt(at, 4).readUInt32LE(0) === 0x08074b50 ? 4 : 0) + 4 + (wide ? 16 : 8);
      if (at + length > size) { where = "at the end of an entry"; break; }
      at += length;
    }
  }
  if (selected.size === 0) throw Error(`${path} is cut off (no directory at its end) and holds no whole conversations part before the cut: download the export again`);
  const names = [...selected.keys()].sort(byPart);
  return { selected, cut: { size, at, where, entries: walked, parts: names.length, first: names[0], last: names.at(-1) } };
}
/** Numbered parts run without a gap: a part missing from the middle of the run is a partial export, never read as the whole. */
function contiguous(names, where, fromZero = false) {
  const numbers = names.map(partOf).filter((n) => n >= 0).sort((a, b) => a - b), missing = [];
  if (fromZero) for (let n = 0; n < (numbers[0] ?? 0) && missing.length < 8; n += 1) missing.push(`conversations-${String(n).padStart(3, "0")}`);
  for (let i = 1; i < numbers.length; i += 1) {
    damaged(numbers[i] !== numbers[i - 1]);
    for (let n = numbers[i - 1] + 1; n < numbers[i] && missing.length < 8; n += 1) missing.push(`conversations-${String(n).padStart(3, "0")}`);
  }
  if (missing.length > 0) throw Error(`${where} is missing conversations part${missing.length === 1 ? "" : "s"} ${missing.join(", ")}: a partial export is never read as the whole`);
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
  const { parts, close, cut } = zipEntries(path, (name) => CONVERSATIONS_ENTRY.test(name));
  if (parts.length === 0) { close(); throw Error(`no ${FILE} in ${given}`); }
  return { parts, close, cuts: cut ? [cut] : [] };
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
    return { parts, close: () => { for (const one of opened) one.close(); }, cuts: opened.flatMap((one) => one.cuts) };
  } catch (error) { for (const one of opened) one.close(); throw error; }
}
/**
 * CHATGPT'S OWN SPLIT, UNPACKED (2026-10-31): conversations-000.json … -050.json loose in a folder. The folder, or any one of
 * its parts given, is ONE export: every sibling part, in part order, the digest of their bytes in that order (as the same
 * parts inside a zip). The run starts at 000 and has no gap, or the export is refused by the missing part's name; a folder
 * holding loose parts AND conversations zips is ambiguous and refused. Nothing else of the folder is opened.
 */
const LOOSE_PART = /^conversations[-_](\d{1,6})\.json$/i;
const looseOf = (dir) => { let names = []; try { names = readdirSync(dir); } catch { return []; } return names.filter((name) => LOOSE_PART.test(name)).sort(byPart); };
function looseParts(dir, given) {
  if (folderParts(dir).length > 0) throw Error(`${given} holds both loose conversations parts and conversations zips: give the one or the other`);
  const names = looseOf(dir);
  limit(names.length <= EXPORT_LIMITS.parts, "conversations parts");
  contiguous(names, dir, true);
  const opened = [];
  try {
    for (const name of names) { const path = join(dir, name); opened.push({ path, file: openExport(path, EXPORT_LIMITS.fileBytes) }); }
    limit(opened.reduce((sum, one) => sum + one.file.size, 0) <= EXPORT_LIMITS.fileBytes, "conversations parts");
    return { parts: opened.map(({ path, file }) => ({ path, bytes: file.size, chunks: () => file.chunksOf(0, file.size, file.size) })), close: () => { for (const one of opened) one.file.close(); }, cuts: [] };
  } catch (error) { for (const one of opened) one.file.close(); throw error; }
}

/** Every conversations part, wherever the given path keeps them (a folder, the file itself, a zip, a part, or the manifest), each a source of chunks. */
function exportParts(given) {
  let path = expand(given);
  let stat; try { stat = statSync(path); } catch { throw Error(`export not found: ${given}`); }
  if (stat.isDirectory()) {
    if (existsSync(join(path, FILE))) path = join(path, FILE);
    else if (looseOf(path).length > 0) return looseParts(path, given);
    else {
      const zips = folderParts(path);
      if (zips.length === 0) throw Error(`no ${FILE} in ${given}`);
      return zipsParts(zips, given);
    }
  }
  if (/\.zip$/i.test(path)) return zipParts(path, given);
  if (LOOSE_PART.test(basename(path)) && stat.isFile()) return looseParts(dirname(path), given); // one loose part given: the export is it and its siblings
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
const P = "presence"; // a string that is never kept: only that it was there (`true`); any other value as a scalar would be
/** The leaf a plan gives a string: the plan itself, or the `leaf` of a plan that also keeps an object's keys (a list of strings and objects). A function maps the string as it ends, and only what it returns is kept. */
const leafOf = (plan) => (plan !== null && typeof plan === "object" ? plan.leaf ?? null : plan);
const NODE = { keys: { parent: S, message: { keys: { author: { keys: { role: S } }, create_time: S, content: { keys: { parts: { items: T } } }, metadata: { keys: { model_slug: S, is_visually_hidden_from_conversation: S } } } } } };
const CONVERSATION = { keys: { title: S, name: S, conversation_id: S, id: S, uuid: S, create_time: S, created_at: S, current_node: S, mapping: { any: NODE },
  chat_messages: { items: { keys: { sender: S, created_at: S, text: T, content: { items: { keys: { type: S, text: T } } } } } } } };
/**
 * AN EXPORT'S METADATA, COUNTS ONLY (owner, 2026-10-31). Asked for (`metadata: true`, the hook's way: never with the text),
 * the walk keeps a few more fields of a ChatGPT message, each MAPPED as it is read to a word of a closed list or to nothing, so
 * the export's own string (a favicon URL, a file's name or type, a quoted reply, a task's title, a GPT's id) is never kept:
 * the person's attachments by category; the answer's searches, source references, reasoning and tool icons (only the fixed
 * names globe, code, thoughts, run-command and api_tool, and an app's icon path, which says an app was used, never which);
 * a deep-research task, a quote reply and voice by their presence. The field names are the ones the owner's own export
 * carries (2026-10-31, read by key name only). conversation_asset_file_names.json, ads.json and chat.html are never opened.
 */
const ICONS = Object.freeze({ globe: "web_search", code: "code", thoughts: "reasoning", "run-command": "run_command", api_tool: "connected_app" });
const iconOf = (name) => (Object.hasOwn(ICONS, name) ? ICONS[name] : /^\/(?:[\w-]{1,64}\/){1,8}[\w.-]{1,128}$/.test(name) ? "connected_app" : null); // a URL, a path with "//" or anything else: nothing
const SOURCE_REFERENCES = new Set(["grouped_webpages", "grouped_webpages_model_predicted_fallback", "webpage", "webpage_extended", "sources_footnote"]);
const FILE_TYPES = [["pdf", /^application\/pdf$/], ["image", /^image\//], ["audio", /^audio\//], ["video", /^video\//], ["spreadsheet", /^text\/(?:csv|tab-separated-values)$|spreadsheet|excel|\.sheet$|numbers$/], ["presentation", /presentation|powerpoint|keynote/],
  ["document", /msword|wordprocessing|opendocument\.text|rtf|epub|pages$/], ["archive", /zip|tar|gzip|7z|rar|compressed/], ["data", /json|xml|yaml|toml|x-ndjson|sqlite/], ["code", /javascript|typescript|jsx|tsx|python|x-sh|x-sql|x-c|java|ruby|php|golang|x-go|rust|swift|kotlin|css|x-shellscript/], ["text", /^text\//]];
const fileOf = (mime) => FILE_TYPES.find(([, test]) => test.test(String(mime).toLowerCase().slice(0, 128)))?.[0] ?? "other";
const META_NODE = { keys: { parent: S, message: { keys: { author: { keys: { role: S } }, create_time: S,
  content: { keys: { content_type: (type) => (type === "thoughts" || type === "reasoning_recap" ? "reasoning" : null), parts: { items: { keys: { content_type: (type) => (/^(?:audio_transcription|audio_asset_pointer|real_time_user_audio_video_asset_pointer)$/.test(type) ? "voice" : null) }, leaf: T } } } },
  metadata: { keys: { model_slug: S, is_visually_hidden_from_conversation: S, attachments: { items: { keys: { mime_type: fileOf, mimeType: fileOf, is_big_paste: S } } }, search_result_groups: { items: P }, content_references: { items: { keys: { type: (type) => SOURCE_REFERENCES.has(type) || null } } },
    tool_icons: { items: iconOf }, async_task_title: P, is_async_task_result_message: S, targeted_reply_label: P, targeted_reply_source_message_id: P, bidi_voice_mode_message: S } } } } } };
const META_CONVERSATION = { keys: { ...CONVERSATION.keys, mapping: { any: META_NODE }, conversation_template_id: (id) => (/^g-p-/.test(id) ? "project" : /^g-/.test(id) ? "gpt" : null) } };
/** The closed list (owner, 2026-10-31): what a conversation-day's counts may name, and nothing else. `files` and `depth` count by category. */
export const EXPORT_METADATA = Object.freeze(["files", "web_search", "sources_cited", "reasoning", "model_switch", "code", "run_command", "connected_app", "custom_gpt_or_project", "deep_research_agent", "voice", "quote_reply", "depth"]);
/**
 * A MODEL'S FAMILY (owner, 2026-11-03): a switch counts between families, never ChatGPT's own routing inside one. The closed table names
 * the slugs that carry no family in their shape; every other slug is normalised by one documented rule, never guessed: lower case;
 * `gpt-N` or `gpt-No` (omni) is the generation, whatever follows (a point version such as -2 or .6, thinking, auto, instant, mini,
 * a codename); `oN` is that o-series generation; anything else drops its routing suffixes (thinking, auto, instant, mini, t-mini,
 * high, medium, low, pro, mobile, a bare number) and is its own family. A slug that names no model (auto, empty) has none.
 */
const FAMILY_TABLE = Object.freeze({ "text-davinci-002-render": "gpt-3.5", "text-davinci-002-render-sha": "gpt-3.5", "text-davinci-002-render-sha-mobile": "gpt-3.5", "text-davinci-002-render-paid": "gpt-3.5", auto: null });
export function modelFamily(slug) {
  const name = String(slug ?? "").trim().toLowerCase().slice(0, 64);
  if (name === "") return null;
  if (Object.hasOwn(FAMILY_TABLE, name)) return FAMILY_TABLE[name];
  const gpt = /^gpt-(\d+)(o)?(?=$|[.-])/.exec(name);
  if (gpt) return `gpt-${gpt[1]}${gpt[2] ?? ""}`;
  const o = /^o(\d+)(?=$|-)/.exec(name);
  if (o) return `o${o[1]}`;
  let family = name, before;
  do { before = family; family = family.replace(/-(?:thinking|auto|instant|t-mini|mini|high|medium|low|pro|mobile|\d+)$/, ""); } while (family !== before);
  return family || null;
}
const DEPTH = (bytes) => (bytes < 200 ? "short" : bytes < 1000 ? "medium" : "long"); // PROPOSED bounds (bytes of the person's text as the export writes it), uncalibrated
const list = (value) => (Array.isArray(value) ? value : []);
/**
 * One ChatGPT conversation's counts per UTC day, on its kept branch: an EXCHANGE is a person's turn and the answers to it, and
 * each kind is counted once per exchange (a search run twice for one question is one); files, a model switch between answers,
 * the person's prompts by depth and a day inside a custom GPT or a project are counted as they are. Integers, never a string.
 */
function chatgptMetadata(kept) {
  const days = {}, template = kept.conversation_template_id === "gpt" || kept.conversation_template_id === "project";
  let seen = new Set(), model = null;
  const day = (m) => { const seconds = Number(m?.create_time ?? kept.create_time); return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : null; };
  const add = (counts, key, sub = null) => { if (sub) { counts[key] ??= {}; counts[key][sub] = (counts[key][sub] ?? 0) + 1; } else counts[key] = (counts[key] ?? 0) + 1; };
  const once = (counts, key) => { if (!seen.has(key)) { seen.add(key); add(counts, key); } };
  for (const node of chatgptBranch(kept)) {
    const m = node?.message, role = m?.author?.role, meta = m?.metadata && typeof m.metadata === "object" ? m.metadata : {}, at = day(m);
    if ((role !== "user" && role !== "assistant") || meta.is_visually_hidden_from_conversation || at === null) continue;
    const counts = (days[at] ??= {});
    if (template) counts.custom_gpt_or_project = 1;
    const parts = list(m.content?.parts);
    if (role === "user") {
      seen = new Set();
      for (const file of list(meta.attachments)) if (file && typeof file === "object" && file !== NONSCALAR && file.is_big_paste !== true) add(counts, "files", file.mime_type ?? file.mimeType ?? "other");
      if (meta.bidi_voice_mode_message === true || parts.some((part) => part?.content_type === "voice")) once(counts, "voice");
      if (meta.targeted_reply_label === true || meta.targeted_reply_source_message_id === true) once(counts, "quote_reply");
      const bytes = parts.reduce((sum, part) => sum + (typeof part === "number" ? part : 0), 0);
      if (bytes > 0) add(counts, "depth", DEPTH(bytes));
      continue;
    }
    const family = typeof meta.model_slug === "string" ? modelFamily(meta.model_slug) : null; // a switch between families, never routing inside one
    if (family !== null) { if (model !== null && family !== model) add(counts, "model_switch"); model = family; }
    const icons = new Set(list(meta.tool_icons).filter((icon) => typeof icon === "string"));
    if (list(meta.search_result_groups).length > 0 || icons.has("web_search")) once(counts, "web_search");
    if (list(meta.content_references).some((reference) => reference?.type === true)) once(counts, "sources_cited");
    if (m.content?.content_type === "reasoning" || icons.has("reasoning")) once(counts, "reasoning");
    for (const kind of ["code", "run_command", "connected_app"]) if (icons.has(kind)) once(counts, kind);
    if (meta.async_task_title === true || meta.is_async_task_result_message === true) once(counts, "deep_research_agent");
    if (meta.bidi_voice_mode_message === true) once(counts, "voice");
  }
  for (const [at, counts] of Object.entries(days)) if (Object.keys(counts).length === 0) delete days[at];
  return days;
}
/** Counts added into totals, category by category. */
function addCounts(totals, counts) {
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
    else { totals[key] ??= {}; for (const [sub, n] of Object.entries(value)) totals[key][sub] = (totals[key][sub] ?? 0) + n; }
  }
  return totals;
}
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
  const beginString = (key) => { const leaf = key ? null : leafOf(vPlan); state = STRING; sKey = key; sKeep = key ? top().out !== null : leaf === S || (leaf === T && text) || typeof leaf === "function"; sRaw = sKeep ? [] : null; sLen = 0; sEsc = 0; sEscaped = false; };
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
    } else {
      const leaf = leafOf(vPlan);
      if (sKeep) store(typeof leaf === "function" ? leaf(decode()) : decode(), 0); // a mapped string: only the mapper's answer is kept
      else store(leaf === T ? sLen : leaf === P ? true : NONSCALAR, 8); // a text the hook never reads: its byte length says whether there was one
    }
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
async function* exportRecords(given, { expect = null, excluded = () => false, skipped = null, text = false, report = null, metadata = false } = {}) {
  if (metadata && text) throw Error("an export's metadata is counted without the text, never with it");
  const totals = {};
  const { parts, close, cuts = [] } = exportParts(given);
  const path = parts[0].path, digest = createHash("sha256");
  let vendor = null, count = 0, oversized = 0, empty = 0, bytes = 0, next = PROGRESS_BYTES, offset = 0, tick = 0, at = 0; const size = parts.reduce((n, one) => n + (Number(one.bytes) || 0), 0);
  if (report) { report.path = path; report.vendor = expect; report.digest = null; report.conversations = 0; report.oversized = 0; report.empty = 0; report.parts = parts.length; report.cut = cuts.length > 0 ? cuts : null; }
  const one = (kept, index) => {
    limit(count < EXPORT_LIMITS.conversations, "conversation count");
    count += 1;
    if (kept === OVERSIZED) { oversized += 1; return { vendor, oversized: true, lines: [] }; }
    // AN EMPTY ELEMENT (2026-10-31: one `{}` in the owner's conversations-043.json refused the whole export): none of the fields read, so
    // it is counted and left out and decides no vendor; an export of nothing else is refused below as no export at all.
    if (kept && typeof kept === "object" && kept.constructor === Object && kept !== NONSCALAR && Object.keys(kept).length === 0) { empty += 1; return { vendor, empty: true, lines: [] }; }
    const shape = kept && typeof kept === "object" && kept !== NONSCALAR ? (kept.mapping instanceof Map || kept.mapping === NONSCALAR ? "chatgpt" : Array.isArray(kept.chat_messages) ? "claude-web" : "unknown") : "unknown";
    if (vendor === null) vendor = shape;
    if (shape === "unknown" || shape !== vendor) throw Error(`${path} is neither a ChatGPT nor a Claude export (or mixes the two)`);
    if (expect && vendor !== expect) throw Error(`${path} is a ${exportProductName(vendor)} export, not ${exportProductName(expect)}`);
    if (report) report.vendor = vendor;
    const title = String((vendor === "chatgpt" ? kept.title : kept.name) ?? "");
    if (excluded(title)) { skipped?.push(title.slice(0, 40)); return { vendor, excluded: true, lines: [] }; }
    const record = { vendor, id: String((vendor === "chatgpt" ? kept.conversation_id ?? kept.id : kept.uuid) ?? `#${index}`), lines: vendor === "chatgpt" ? chatgptLines(kept, text) : claudeLines(kept, text) };
    if (metadata) { record.metadata = vendor === "chatgpt" ? chatgptMetadata(kept) : null; for (const counts of Object.values(record.metadata ?? {})) addCounts(totals, counts); } // a Claude export carries no such fields: null, never zeros
    return record;
  };
  try {
    for (const part of parts) {
      let queue = [], seen = 0; at += 1;
      const walk = walker(metadata ? META_CONVERSATION : CONVERSATION, { text, budget: text ? EXPORT_LIMITS.conversationTextBytes : EXPORT_LIMITS.conversationBytes, onElement: (kept, index) => queue.push([kept, offset + index]) });
      const drain = function* () { const due = queue; queue = []; for (const [kept, index] of due) { seen = index + 1 - offset; yield one(kept, index); } };
      try {
        for await (const chunk of part.chunks()) {
          digest.update(chunk); bytes += chunk.length; walk.push(chunk);
          if (bytes >= next) { process.stderr.write(`export: ${Math.round(bytes / 1024 ** 2)} MB read, ${count} conversations\n`); next += PROGRESS_BYTES; }
          yield* drain(); if (report?.onProgress && !(Date.now() < tick)) { tick = Date.now() + 250; report.onProgress({ part: at, parts: parts.length, bytes, size, conversations: count }); } // the read as it goes (2026-11-05), counts only
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
  if (vendor === null && empty > 0) throw Error(`${path} is neither a ChatGPT nor a Claude export (or mixes the two)`);
  report?.onProgress?.({ part: at, parts: parts.length, bytes, size, conversations: count }); if (report) { report.vendor = vendor ?? expect; report.digest = digest.digest("hex"); report.conversations = count; report.oversized = oversized; report.empty = empty; if (metadata) report.metadata = vendor === "chatgpt" ? totals : null; }
}

/** One export, read whole but compact: its vendor by shape, one record per conversation (its kept lines; none for an excluded or oversized one), and the digest of its bytes (what `sent` is remembered by). */
export async function readExport(given, expect = null, { excluded = () => false, skipped = null, text = false, metadata = false } = {}) {
  const report = {}, conversations = [];
  let kept = 0;
  for await (const record of exportRecords(given, { expect, excluded, skipped, text, report, metadata })) {
    kept += 64 + (record.id?.length ?? 0) + Object.keys(record.metadata ?? {}).length * 256 + record.lines.reduce((sum, line) => sum + 64 + (line.model?.length ?? 0) + (line.text?.length ?? 0), 0);
    limit(kept <= EXPORT_LIMITS.keptBytes, "kept bytes");
    conversations.push(record);
  }
  return { vendor: report.vendor, conversations, digest: report.digest, path: report.path, parts: report.parts, oversized: report.oversized, empty: report.empty, cut: report.cut, ...(metadata ? { metadata: report.metadata } : {}) };
}

/**
 * Every conversation of an export as one session, as it streams: `key` names the vendor and the conversation's id,
 * `lines` carry the transcript shape both readers measure. `excluded(title)` skips a conversation by its title before
 * anything else of it is kept (the same `--exclude` as a project directory); the title itself goes no further than that
 * call. `text` hands the counter the messages' text (read here, for its rubric); the hook leaves it out and gets clocks,
 * roles and a model name. `given` is a path, or an export `readExport` already returned; `report` is filled as above.
 */
export async function* exportSessions(given, { expect = null, excluded = () => false, skipped = null, text = false, report = null, metadata = false } = {}) {
  const records = typeof given === "string" ? exportRecords(given, { expect, excluded, skipped, text, report, metadata }) : given.conversations;
  for await (const { vendor, id, lines, metadata: counts = null } of records) {
    if (lines.length === 0) continue; // excluded, left out as too large, or without a message
    yield { key: `${vendor === "chatgpt" ? "chatgpt" : "claude.ai"}:${id}`, projectDir: vendor === "chatgpt" ? "chatgpt" : "claude-ai", basename: vendor === "chatgpt" ? "chatgpt" : "claude.ai", vendor, id, lines: lines.map(transcriptLine), ...(metadata ? { metadata: counts } : {}) };
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
    const candidate = stat.isDirectory() ? existsSync(join(path, FILE)) || folderParts(path).length > 0 || looseOf(path).length > 0 : (/\.zip$/i.test(name) && !OTHER_PART.test(name)) || name === FILE;
    if (!candidate) continue;
    try {
      const { vendor, conversations, digest } = await readExport(path);
      if (vendor && conversations.length > 0) found.push({ path, vendor, digest, conversations: conversations.length });
    } catch { /* not an export, or not one this reader opens */ }
  }
  return found;
}
