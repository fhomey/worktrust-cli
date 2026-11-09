/**
 * FILES FROM THE PHONE, INTO THE SESSION'S PROJECT (owner, 2026-11-07; docs/remote-agents/PROTOCOL.md "Attachments").
 *
 * `attachment.put` brings one chunk of one file. Chunks are kept apart under the session's inbox (`.parts/<id>/<n>`,
 * 0600) until all arrived; then they are joined, the SHA-256 the phone named is checked, the bytes are checked to be what
 * the type says (magic numbers; text is UTF-8 without NUL), and the file is written ONCE, 0600, never executable, at
 * `<project>/.worktrust/inbox/<session_id>/<safe name>`: a name of [A-Za-z0-9._-] from the phone's, no leading dot, made
 * unique. Every folder on the way is a real folder inside the project (a link anywhere on the way refuses the file). A HEIC
 * photo is converted to JPEG with macOS `sips` when it is there (Claude Code reads JPEG, not HEIC), else kept as it is.
 * Caps: 25 MB a file, 100 MB a session. `attachment.clear` removes the session's inbox. Nothing here is ever run.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import * as P from "./remote-protocol.mjs";

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/heic": ".heic", "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx" };
const starts = (b, ...bytes) => bytes.every((x, i) => b[i] === x);
const ascii = (b, at, s) => b.subarray(at, at + s.length).toString("latin1") === s;

/** The bytes are what the type says. */
export function looksLike(type, b) {
  if (type === "image/png") return starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (type === "image/jpeg") return starts(b, 0xff, 0xd8, 0xff);
  if (type === "image/webp") return ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP");
  if (type === "image/heic") return ascii(b, 4, "ftyp") && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString("latin1"));
  if (type === "application/pdf") return ascii(b, 0, "%PDF-");
  if (type.endsWith(".document") || type.endsWith(".sheet")) return starts(b, 0x50, 0x4b, 0x03, 0x04);
  if (type.startsWith("text/")) { if (b.includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } }
  return false;
}

/** A name for the file on disk: [A-Za-z0-9._-] only, no leading dot, the type's extension, at most 100 characters. */
export function safeName(name, type) {
  const stem = basename(String(name)).replace(extname(String(name)), "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/\.+$/, "").slice(0, 80) || "attachment";
  return `${stem}${EXT[type]}`;
}

/** Make each folder from the project down, refusing a link or a file on the way. → the folder, or null. */
function realDir(project, parts) {
  let at;
  try { at = realpathSync(project); } catch { return null; }
  for (const part of parts) {
    at = join(at, part);
    if (existsSync(at)) { const st = lstatSync(at); if (st.isSymbolicLink() || !st.isDirectory()) return null; } else mkdirSync(at, { mode: 0o700 });
  }
  return at;
}

const writeOnce = (file, bytes) => { const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); try { writeSync(fd, bytes); } finally { closeSync(fd); } };
const sizeOf = (dir) => { try { return readdirSync(dir).reduce((n, f) => { const st = lstatSync(join(dir, f)); return n + (st.isFile() ? st.size : st.isDirectory() ? sizeOf(join(dir, f)) : 0); }, 0); } catch { return 0; } };

export function createAttachments(ctx) {
  // ctx: { journal, now, emit, projects(), sessionProject(session_id) → project | null, log }
  const done = new Map(); // `${session_id}/${attachment_id}` -> relative path

  function put(env, a) {
    const project = ctx.sessionProject(env.session_id);
    if (!project) return "not_found";
    const bad = P.attachmentRule(a);
    if (bad) return "unsupported";
    const key = `${env.session_id}/${a.attachment_id}`;
    if (done.has(key)) return "conflict";
    const inbox = realDir(project.path, [".worktrust", "inbox", env.session_id]);
    const parts = inbox && realDir(inbox, [".parts", a.attachment_id]);
    if (!inbox || !parts) return "unsupported";
    const chunk = Buffer.from(P.fromBase64Url(a.data));
    const expected = a.chunk < a.chunks - 1 ? P.ATTACHMENT_CHUNK_BYTES : a.size - P.ATTACHMENT_CHUNK_BYTES * (a.chunks - 1);
    if (chunk.length !== expected) return "unsupported";
    if (sizeOf(inbox) + chunk.length > P.MAX_SESSION_ATTACHMENT_BYTES) return "busy";
    const part = join(parts, String(a.chunk));
    if (!existsSync(part)) writeOnce(part, chunk);
    const received = readdirSync(parts).filter((f) => /^\d+$/.test(f)).length;
    let path = null;
    if (received === a.chunks) {
      const whole = Buffer.concat(Array.from({ length: a.chunks }, (_, n) => readFileSync(join(parts, String(n)))));
      rmSync(parts, { recursive: true, force: true });
      if (whole.length !== a.size || !createHash("sha256").update(whole).digest().equals(Buffer.from(P.fromBase64Url(a.sha256))) || !looksLike(a.content_type, whole)) return "unsupported";
      let name = safeName(a.name, a.content_type);
      for (let i = 2; existsSync(join(inbox, name)); i += 1) name = name.replace(/(-\d+)?(\.[a-z]+)$/, `-${i}$2`);
      const file = join(inbox, name);
      writeOnce(file, whole);
      const kept = a.content_type === "image/heic" ? heicToJpeg(file) : file;
      if (dirname(realpathSync(kept)) !== realpathSync(inbox)) { rmSync(kept, { force: true }); return "unsupported"; }
      path = [".worktrust", "inbox", env.session_id, basename(kept)].join("/");
      done.set(key, path);
    }
    ctx.emit(env.session_id, "attachment.stored", { attachment_id: a.attachment_id, received, chunks: a.chunks, path, size: a.size, content_type: a.content_type }, env.command_id);
    return "taken";
  }

  function heicToJpeg(file) {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sips")) return file;
    const out = file.replace(/\.heic$/, ".jpg");
    try { execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", out], { stdio: "ignore", timeout: 30_000 }); } catch { return file; }
    if (!existsSync(out)) return file;
    rmSync(file, { force: true });
    try { statSync(out); } catch { return file; }
    return out;
  }

  function clear(env) {
    const project = ctx.sessionProject(env.session_id);
    if (!project) return "not_found";
    const inbox = realDir(project.path, [".worktrust", "inbox", env.session_id]);
    if (!inbox) return "unsupported";
    const removed = readdirSync(inbox).filter((f) => f !== ".parts").length;
    rmSync(inbox, { recursive: true, force: true });
    for (const key of [...done.keys()]) if (key.startsWith(`${env.session_id}/`)) done.delete(key);
    ctx.emit(env.session_id, "attachment.cleared", { removed }, env.command_id);
    return "taken";
  }

  return {
    handle: (env, payload) => (env.type === "attachment.put" ? put(env, payload) : clear(env)),
    /**
     * The words that tell the agent where its attachments are, appended to a prompt; null when one is not stored whole
     * in this session (the prompt is then refused, never sent without the file it names).
     */
    referenceText(sessionId, ids) {
      if (!ids?.length) return "";
      const paths = ids.map((id) => done.get(`${sessionId}/${id}`));
      if (paths.some((p) => !p)) return null;
      return `\n\nAttached from the phone (files in this project, read them as needed):\n${paths.map((p) => `- ${p}`).join("\n")}`;
    },
  };
}
