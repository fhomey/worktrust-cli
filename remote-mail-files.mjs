/**
 * PRIVATE FILES OF MAIL (docs/remote-agents/MAIL.md): the sealed accounts, the index fallback, the sync state, the outbox and
 * the templates, each mode 0600, owned by this user, never a link, written to an exclusive random temporary, flushed and
 * renamed, and bounded at MAIL_FILE_MAX. package-integrity's private files stop at 64 KB, which suits a key, not a mailbox.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const MAIL_FILE_MAX = 256 * 1024 * 1024;

/** `text`: a string (UTF-8) or a Buffer (written as it is). */
export function writeMailFile(file, text) {
  if (Buffer.byteLength(text) > MAIL_FILE_MAX) throw new Error("MAIL_FILE_TOO_LARGE");
  try { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error("MAIL_FILE_UNSAFE"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tmp = `${file}.${randomBytes(16).toString("hex")}.tmp`;
  let fd;
  try { fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(tmp, file); }
  finally { if (fd !== undefined) closeSync(fd); rmSync(tmp, { force: true }); }
}
/** The same read as bytes (a draft's attachment): no link followed, this user's own file, bounded. */
export function readMailBytes(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const st = fstatSync(fd); if (!st.isFile() || st.size > MAIL_FILE_MAX || (process.getuid && st.uid !== process.getuid())) throw new Error("MAIL_FILE_UNSAFE"); return readFileSync(fd); } finally { closeSync(fd); }
}
export function readMailFile(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const st = fstatSync(fd); if (!st.isFile() || st.size > MAIL_FILE_MAX || (process.getuid && st.uid !== process.getuid())) throw new Error("MAIL_FILE_UNSAFE"); return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}

