/**
 * A TRANSCRIPT READ BACKWARDS, BOUNDED (CLI 0.11.17; docs/remote-agents/CHAT-HISTORY.md §4.3). The only code of the
 * history that opens a file, and it opens only what remote-history.mjs resolved from this computer's own records: a
 * regular file that is not a link (lstat, then O_NOFOLLOW, then the same inode; a second look where the platform has no
 * O_NOFOLLOW), read-only, and only inside the agent's
 * own store by real paths (a linked folder on the way leads nowhere).
 *
 *   readBack     whole lines ending at an offset, towards the start of the file, CHUNK bytes at a time with a yield
 *                between chunks (a page never holds the daemon's loop), until the caller has enough or the scan budget is
 *                spent. A line longer than MAX_LINE is not kept in memory: its bytes are passed over and it is returned
 *                as `skipped`.
 *   readForward  the whole lines of a bounded window after an offset (a page's look ahead: how a step ended, whether a
 *                text was the turn's last).
 *   cursor       `v1.<file index>.<byte offset>.<check>`: the check is 8 characters of the hash of the bytes at the
 *                offset, so a cursor made for another file, another offset or a file that was rewritten is `stale`, and an
 *                offset is only ever used inside the file the computer chose. A phone never names a path.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import * as P from "./remote-protocol.mjs";

export const CHUNK = 256 * 1024, SCAN_BUDGET = 4 * 1024 * 1024, MAX_LINE = 1024 * 1024, PEEK = 256 * 1024;
const CHECK_BYTES = 256;
const CURSOR = /^v1\.(\d{1,2})\.(\d{1,15})\.([A-Za-z0-9_-]{8})$/;

/**
 * A regular file, never a link, read-only. → { fd, size, at (when it was last written) } or null. The caller closes it.
 * The name is looked at first (a link is refused there by name), opened without following a link, and the open file must
 * be the one that was looked at (the same inode on the same device, compared whole: 64 bits).
 * WHERE THE PLATFORM HAS NO O_NOFOLLOW (Windows; review 2026-11-17, F4) the open itself would follow a link put there
 * after the first look, so nothing is left to the open: the name is looked at AGAIN after it and must still be no link
 * and the same file, and a filesystem that gives no inode number (0, so every file would compare equal) is not read at
 * all. What remains there: a name swapped to a link and back between the two looks, which the inode check still refuses
 * unless the link pointed at the very same file.
 */
export function openPlain(file, nofollow = constants.O_NOFOLLOW) {
  let fd = null;
  try {
    const seen = lstatSync(file, { bigint: true });
    if (seen.isSymbolicLink() || !seen.isFile()) return null;
    fd = openSync(file, constants.O_RDONLY | (nofollow ?? 0));
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.ino !== seen.ino || st.dev !== seen.dev) { closeSync(fd); return null; }
    if (nofollow === undefined) {
      const again = lstatSync(file, { bigint: true });
      if (again.isSymbolicLink() || !again.isFile() || again.ino !== st.ino || again.dev !== st.dev || st.ino === 0n) { closeSync(fd); return null; }
    }
    return { fd, size: Number(st.size), at: Number(st.mtimeMs) };
  } catch { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } return null; }
}
/**
 * The same, and only INSIDE `root` by real paths: a folder on the way that is a link to somewhere else is refused too
 * (O_NOFOLLOW guards the last name only). → { fd, size } or null.
 */
export function openPlainUnder(root, file) {
  try { const base = realpathSync(root); if (!realpathSync(file).startsWith(base + sep)) return null; } catch { return null; }
  return openPlain(file);
}
export const closePlain = (opened) => { try { if (opened) closeSync(opened.fd); } catch { /* closed */ } };

const read = (fd, at, length) => { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, at); return n === length ? buf : buf.subarray(0, n); };
const parse = (buf) => { try { const v = JSON.parse(buf.toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Lines that end at or before `end`, oldest first: `{ at, bytes, value | null, skipped }` (`value` null: not a JSON object).
 * `enough(lines)` is asked after each chunk with what was read so far (oldest first) and stops the read when true.
 * → { lines, start (the offset of the earliest line returned, or where the scan stopped), scanned, whole (the start of the
 * file was reached) }.
 */
export async function readBack(fd, end, { budget = SCAN_BUDGET, enough = () => false } = {}) {
  const out = []; // newest first
  let pos = end, carry = null, scanned = 0, skipFrom = null; // skipFrom: the end offset of an oversize line being passed over
  while (pos > 0 && scanned < budget) {
    const n = Math.min(CHUNK, pos), buf = read(fd, pos - n, n);
    pos -= n; scanned += n;
    let block = buf, hi = buf.length;
    if (skipFrom !== null) {
      const nl = buf.lastIndexOf(10);
      if (nl === -1 && pos > 0) { await tick(); continue; }
      out.push({ at: pos + nl + 1, bytes: skipFrom - (pos + nl + 1), value: null, skipped: true });
      skipFrom = null; hi = nl + 1;
    } else if (carry) { block = Buffer.concat([buf, carry]); hi = block.length; carry = null; }
    while (hi > 0) {
      const nl = block.lastIndexOf(10, hi - 2);
      if (nl === -1 && pos > 0) {
        // The line began before this chunk: kept for the next one, or passed over once it is longer than a line may be.
        if (hi > MAX_LINE) skipFrom = pos + hi; else carry = block.subarray(0, hi);
        break;
      }
      const line = block.subarray(nl + 1, hi);
      if (line.length > 1 || (line.length === 1 && line[0] !== 10)) out.push({ at: pos + nl + 1, bytes: hi - nl - 1, value: line.length > MAX_LINE ? null : parse(line), skipped: line.length > MAX_LINE });
      hi = nl + 1;
    }
    if (await enough([...out].reverse())) break;
    await tick();
  }
  const whole = pos === 0 && carry === null && skipFrom === null;
  return { lines: out.reverse(), start: out.length ? out[0].at : whole ? 0 : pos + (carry?.length ?? 0), scanned, whole };
}

/** The whole lines that begin in [from, from + max): `{ at, bytes, value | null }`, and whether the file ended inside the window. */
export function readForward(fd, from, size, max = PEEK) {
  const length = Math.max(0, Math.min(max, size - from)), buf = length ? read(fd, from, length) : Buffer.alloc(0), lines = [];
  let lo = 0;
  while (lo < buf.length) {
    const nl = buf.indexOf(10, lo);
    if (nl === -1) { if (from + buf.length >= size && buf.length - lo <= MAX_LINE) lines.push({ at: from + lo, bytes: buf.length - lo, value: parse(buf.subarray(lo)) }); break; }
    if (nl > lo) lines.push({ at: from + lo, bytes: nl - lo + 1, value: parse(buf.subarray(lo, nl)) });
    lo = nl + 1;
  }
  return { lines, ended: from + buf.length >= size };
}

/** Whether an offset is where a line begins: the start of the file, or just after a newline. */
export const atLineStart = (fd, offset) => offset === 0 || read(fd, offset - 1, 1)[0] === 10;
const checkOf = (bytes) => P.toBase64Url(P.sha256(bytes)).slice(0, 8);
/** The cursor of an offset in the file at `index` of the session's own list. */
export const cursorAt = (fd, index, offset, size) => `v1.${index}.${offset}.${checkOf(read(fd, offset, Math.max(0, Math.min(CHECK_BYTES, size - offset))))}`;
/** → { index, offset, check } or null when it is not a cursor's shape. */
export function parseCursor(text) {
  const m = typeof text === "string" && text.length <= P.HISTORY_MAX_CURSOR ? CURSOR.exec(text) : null;
  return m ? { index: Number(m[1]), offset: Number(m[2]), check: m[3] } : null;
}
/** Whether a parsed cursor still names this offset of this file: inside it, at a line's start, the same bytes there. */
export function cursorHolds(fd, size, cursor) {
  if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > size) return false;
  if (cursor.offset > 0 && read(fd, cursor.offset - 1, 1)[0] !== 10) return false;
  return checkOf(read(fd, cursor.offset, Math.max(0, Math.min(CHECK_BYTES, size - cursor.offset)))) === cursor.check;
}
