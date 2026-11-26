/**
 * FILES FROM THE PHONE, INTO THE SESSION'S PROJECT (owner, 2026-11-07; docs/remote-agents/PROTOCOL.md "Attachments").
 *
 * `attachment.put` brings one chunk of one file. Chunks are kept apart under the session's inbox (`.parts/<id>/<n>`,
 * 0600) until all arrived; then they are joined, the SHA-256 the phone named is checked, the bytes are checked to be what
 * the type says (magic numbers; text is UTF-8 without NUL), and the file is written ONCE, 0600, never executable, at
 * `<project>/.worktrust/inbox/<session_id>/<safe name>`: a name of [A-Za-z0-9._-] from the phone's, no leading dot, made
 * unique. Every folder on the way is a real folder inside the project (a link anywhere on the way refuses the file). A HEIC
 * photo is converted to JPEG with macOS `sips` when it is there (Claude Code reads JPEG, not HEIC), else kept as it is.
 * Caps: 25 MB a file, 100 MB a session. `attachment.clear` removes the session's inbox, or with an `attachment_id` what
 * arrived of that one file. Nothing here is ever run.
 *
 * SECURITY REVIEW, 2026-11-19:
 *   out of git     the inbox ignores itself (`.worktrust/inbox/.gitignore`, `*`, written once and only when nothing is
 *                  there: a person's own file, or a link, is left as it is), so an agent's `git add -A` in the project
 *                  never stages a file from the phone. Not `.worktrust/.gitignore`: `.worktrust/pipeline.json` is the
 *                  project's own reviewed file and stays committable.
 *   HEIC           the name is free for BOTH `.heic` and `.jpg` before anything is written; `sips` converts into `.parts`
 *                  and the JPEG is placed with a hard link, which never replaces a file and never follows a link.
 *   a full disk    a filesystem error refuses the command (`not_allowed`) instead of leaving the phone without an answer;
 *                  a clear too (P3-3), which also never makes the inbox it clears and never removes through a linked `.parts`.
 *   a restart      which file an id names is memory; after a restart it is read back from this computer's own journal
 *                  (the `attachment.stored` it recorded for a whole, checked file), only when no clear came after it and
 *                  the file is still a regular file in that session's inbox.
 *
 * A SESSION OPEN AT THE DESK (owner, 2026-11-26; DESK-STEERING.md §Files): a chunk naming `desk_ref` goes to that desk session's
 * own granted project, as the desk door resolves it (`ctx.deskProject`: steering on, a phone that asked `desk_steer`, the session in
 * this computer's own list), into `.worktrust/inbox/desk-<uuid>/`: the same checks, caps, names and modes, the receipts device
 * receipts, no `attachment.stored` (no daemon session to put it on), the id held in memory only. The prompt names the files by
 * their ABSOLUTE paths (referenceText with the project's root), the way Claude Code's Read tool takes a file, an image as an image.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
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

/** What stands at a path, a link not followed; null when nothing does. */
const statOf = (path) => { try { return lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } };
/** Each folder from the project down as it stands, never made → the folder; null when one is absent; false for a link or a file on the way, or no project. */
function existingDir(project, parts) {
  let at;
  try { at = realpathSync(project); } catch { return false; }
  for (const part of parts) {
    at = join(at, part);
    const st = statOf(at);
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return at;
}

const writeOnce = (file, bytes) => { const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); try { writeSync(fd, bytes); } finally { closeSync(fd); } };
/** Anything at this path, a dangling link included (existsSync follows links and would call that free). */
const there = (path) => { try { lstatSync(path); return true; } catch { return false; } };
/** A regular file, never a link, directly inside `dir`. */
const plainIn = (dir, path) => { try { return lstatSync(path).isFile() && dirname(realpathSync(path)) === realpathSync(dir); } catch { return false; } };
/** The inbox keeps itself out of the project's git: written once, and only where nothing is (never over a person's own file, never through a link). */
const ignoreInbox = (inboxes) => { const file = join(inboxes, ".gitignore"); if (there(file)) return; try { writeOnce(file, Buffer.from("*\n")); } catch { /* raced, or not writable: the file from the phone is still stored */ } };
const sizeOf = (dir) => { try { return readdirSync(dir).reduce((n, f) => { const st = lstatSync(join(dir, f)); return n + (st.isFile() ? st.size : st.isDirectory() ? sizeOf(join(dir, f)) : 0); }, 0); } catch { return 0; } };

export function createAttachments(ctx) {
  // ctx: { journal, now, emit, projects(), sessionProject(session_id) → project | null, log, deskProject?(desk_ref, sender) → { path, space } | null (owner, 2026-11-26) }
  const done = new Map(); // `${session_id}/${attachment_id}` -> relative path
  let lastPut = -Infinity; // 0.11.15: an upload in the last two minutes holds a handover (its file is named by the next prompt)

  /** The path an id names in this session: from memory, else from the journal's own record of a whole, checked file. */
  function storedPath(sessionId, id) {
    const key = `${sessionId}/${id}`;
    if (done.has(key)) return done.get(key);
    const events = ctx.journal?.eventsAfter?.(sessionId, 0) ?? [];
    const stored = events.findLast((e) => e.type === "attachment.stored" && e.body?.attachment_id === id && typeof e.body.path === "string");
    // A clear after it: the inbox's (no id), or this one file's. The clear of ANOTHER file leaves this one standing (P3-1).
    // The id is the journal record's own (`local`), never the sealed body: an older phone refuses a key it does not know.
    const clearedAfter = (e) => e.type === "attachment.cleared" && e.event_seq > stored.event_seq && (!e.local?.attachment_id || e.local.attachment_id === id);
    if (!stored || events.some(clearedAfter)) return null;
    const project = ctx.sessionProject(sessionId), name = basename(stored.body.path);
    if (!project || stored.body.path !== [".worktrust", "inbox", sessionId, name].join("/")) return null;
    let inbox;
    try { inbox = join(realpathSync(project.path), ".worktrust", "inbox", sessionId); } catch { return null; }
    if (!plainIn(inbox, join(inbox, name))) return null;
    done.set(key, stored.body.path);
    return stored.body.path;
  }

  /** Where a command's files live: a desk session's granted project (`desk_ref`, by the desk door's word) or the daemon session's. → { project, space, desk } | null. */
  function placeOf(env, payload) {
    if (payload?.desk_ref !== undefined) { const d = ctx.deskProject?.(payload.desk_ref, env.sender_device_id) ?? null; return d && /^desk-[0-9a-f-]{36}$/.test(d.space) ? { project: { path: d.path }, space: d.space, desk: true } : null; }
    const project = ctx.sessionProject(env.session_id);
    return project ? { project, space: env.session_id, desk: false } : null;
  }

  function put(env, a) {
    lastPut = ctx.now();
    const place = placeOf(env, a);
    if (!place) return "not_found";
    const bad = P.attachmentRule(a);
    if (bad) return "unsupported";
    // A read-only project, a full disk: the phone is told no, never left waiting for an answer.
    try { return store(env, a, place); } catch (error) { ctx.log?.("attachment_failed", { code: String(error?.code ?? error?.name ?? "Error").slice(0, 40) }); return "not_allowed"; }
  }

  function store(env, a, { project, space, desk }) {
    const key = `${space}/${a.attachment_id}`;
    if (done.has(key)) return "conflict";
    const inbox = realDir(project.path, [".worktrust", "inbox", space]);
    const parts = inbox && realDir(inbox, [".parts", a.attachment_id]);
    if (!inbox || !parts) return "unsupported";
    ignoreInbox(dirname(inbox));
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
      // A name nothing holds: for a HEIC photo both its own name and the JPEG's it may become.
      const heic = a.content_type === "image/heic";
      const taken = (n) => there(join(inbox, n)) || (heic && there(join(inbox, n.replace(/\.heic$/, ".jpg"))));
      let name = safeName(a.name, a.content_type);
      for (let i = 2; taken(name); i += 1) name = name.replace(/(-\d+)?(\.[a-z]+)$/, `-${i}$2`);
      const file = join(inbox, name);
      writeOnce(file, whole);
      const kept = heic ? heicToJpeg(file, join(dirname(parts), `${a.attachment_id}.jpg`)) : file;
      if (!plainIn(inbox, kept)) { rmSync(kept, { force: true }); return "unsupported"; }
      path = [".worktrust", "inbox", space, basename(kept)].join("/");
      done.set(key, path);
    }
    if (!desk) ctx.emit(env.session_id, "attachment.stored", { attachment_id: a.attachment_id, received, chunks: a.chunks, path, size: a.size, content_type: a.content_type }, env.command_id); // a desk file: its receipt says it, no session to put a record on
    return "taken";
  }

  /**
   * A HEIC photo as a JPEG beside it, then instead of it. `sips` writes into `.parts` (`temp`, removed first, so no link
   * stands there), and the result is placed with a hard link: that fails when anything holds the name and never follows
   * a link, so no file of the inbox is replaced. Any failure keeps the HEIC as it arrived.
   */
  function heicToJpeg(file, temp) {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sips")) return file;
    const out = file.replace(/\.heic$/, ".jpg");
    try {
      rmSync(temp, { force: true });
      execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", temp], { stdio: "ignore", timeout: 30_000 });
      if (!lstatSync(temp).isFile()) return file;
      linkSync(temp, out);
    } catch { return file; } finally { rmSync(temp, { force: true }); }
    rmSync(file, { force: true });
    return out;
  }

  function clear(env, payload) {
    const place = placeOf(env, payload);
    if (!place) return "not_found";
    // A read-only project, a full disk: a refusal with a receipt, as for a put, never a frame that failed (review P3-3).
    try { return clearIn(env, payload, place); } catch (error) { ctx.log?.("attachment_failed", { code: String(error?.code ?? error?.name ?? "Error").slice(0, 40) }); return "not_allowed"; }
  }

  function clearIn(env, payload, { project, space, desk }) {
    const id = payload?.attachment_id ?? null;
    const forget = () => { for (const key of [...done.keys()]) if (id ? key === `${space}/${id}` : key.startsWith(`${space}/`)) done.delete(key); };
    // Sealed as `{ removed }` alone, every time; the clear of one file names its id for this computer's journal only.
    const cleared = (removed) => { forget(); if (!desk) ctx.emit(env.session_id, "attachment.cleared", { removed }, env.command_id, "none", id ? { local: { attachment_id: id } } : {}); return "taken"; };
    // The inbox as it stands, never made: a clear of a session with no inbox removes nothing and leaves no folder behind.
    const inbox = existingDir(project.path, [".worktrust", "inbox", space]);
    if (inbox === false) return "unsupported";
    if (inbox === null) return cleared(0);
    if (id) {
      // ONE file (the phone gave up on it, or its message did not go): what arrived of it, and the file when it was stored whole.
      // Never through a `.parts` that is a link or a file: only a real folder of this inbox is removed from.
      const path = storedPath(space, id), parts = join(inbox, ".parts"), st = statOf(parts);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) return "unsupported";
      if (st) { rmSync(join(parts, id), { recursive: true, force: true }); rmSync(join(parts, `${id}.jpg`), { force: true }); }
      if (path) rmSync(join(inbox, basename(path)), { force: true });
      return cleared(path ? 1 : 0);
    }
    const removed = readdirSync(inbox).filter((f) => f !== ".parts").length;
    rmSync(inbox, { recursive: true, force: true });
    return cleared(removed);
  }

  return {
    handle: (env, payload) => (env.type === "attachment.put" ? put(env, payload) : clear(env, payload)),
    uploading: () => ctx.now() - lastPut < 120_000,
    /**
     * The words that tell the agent where its attachments are, appended to a prompt; null when one is not stored whole
     * in this session (the prompt is then refused, never sent without the file it names).
     */
    referenceText(sessionId, ids, root = null) {
      if (!ids?.length) return "";
      const paths = ids.map((id) => storedPath(sessionId, id));
      if (paths.some((p) => !p)) return null;
      // A desk session (owner, 2026-11-26): `root` its project, the paths absolute, as Claude Code's Read tool takes a file (an image read as an image).
      let base = null;
      if (root !== null) { try { base = realpathSync(root); } catch { return null; } }
      return `\n\nAttached from the phone (files in this project, read them as needed):\n${paths.map((p) => `- ${base ? join(base, ...p.split("/")) : p}`).join("\n")}`;
    },
  };
}
