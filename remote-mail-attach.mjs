/**
 * A DRAFT'S FILES ON THIS COMPUTER (docs/remote-agents/MAIL.md §Composing by hand; owner, 2026-11-24). A phone sends a file in
 * chunks (mail.attachment.put); this joins them in memory, checks the size and SHA-256 the chunks named, and only then writes ONE
 * file: `<mail>/files/<draft_id>/<attachment_id>`, mode 0600 in a 0700 folder. The bytes are never executed, never opened by
 * anything but the MIME writer at send time, never shown to the agent. Caps: 10 files a draft, 10 MiB a file, 25 MiB together.
 * A name keeps its last part only, no control or bidi character. Executables and scripts are refused by name and type.
 * `verify(draft)` reads every file again at send time: a byte changed since the approval is `hash_mismatch` (what is approved is
 * what is sent). Files go when the draft is sent, declined or its account removed, and after 24 hours in any case (`sweep`).
 * Logs carry ids and codes, never a name.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { readMailBytes, writeMailFile } from "./remote-mail-files.mjs";

export const MAIL_FILES_KEEP_MS = 24 * 60 * 60_000;
const EXECUTABLE = /\.(exe|msi|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|app|sh|bash|zsh|command|dmg|pkg|apk|ipa|lnk|reg|dll|so|dylib|iso)$/i;
const EXEC_MIME = /^(application\/(x-msdownload|x-msdos-program|x-ms-installer|x-sh|x-csh|javascript|x-javascript|java-archive|x-apple-diskimage|vnd\.android\.package-archive|x-executable|x-mach-binary|x-elf|vnd\.microsoft\.portable-executable)|text\/(javascript|x-shellscript))$/i;
const OPAQUE = /^[a-z]{3}_[A-Za-z0-9_-]{22}$/;

/** A file name as it may be stored and sent: its last part, no control, bidi or zero-width character, at most 255. */
export function safeName(name) {
  const last = String(name ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁯﻿]/g, "").trim().slice(0, 255);
  return last && last !== "." && last !== ".." ? last : "attachment";
}
export const blockedType = (name, mime) => EXECUTABLE.test(String(name)) || EXEC_MIME.test(String(mime ?? "").trim());
const sha = (bytes) => P.toBase64Url(createHash("sha256").update(bytes).digest());

/** o: { dir (the mail folder), now, log } */
export function createAttachmentStore(o) {
  const root = join(o.dir, "files");
  const pending = new Map(); // `${draft}/${attachment}` → { meta, parts: Map(chunk → Buffer), at }
  const folder = (draftId) => { if (!OPAQUE.test(draftId)) throw new Error("bad id"); const d = join(root, draftId); mkdirSync(d, { recursive: true, mode: 0o700 }); try { chmodSync(root, 0o700); chmodSync(d, 0o700); } catch { /* Windows */ } return d; };
  return {
    /**
     * One chunk. `held`: the draft's current attachments (for the caps). → { state: "partial", received, chunks } |
     * { state: "done", meta } | { state: "refused", code } (too_large, too_many, type, hash_mismatch).
     */
    put(draftId, p, held) {
      const name = safeName(p.name);
      if (blockedType(name, p.mime)) { o.log("mail_attachment", { draft_id: draftId, outcome: "refused", code: "type" }); return { state: "refused", code: "type" }; }
      const others = held.filter((a) => a.attachment_id !== p.attachment_id);
      if (others.length >= P.MAIL_ATTACHMENT_MAX_FILES) return { state: "refused", code: "too_many" };
      if (p.size > P.MAIL_ATTACHMENT_MAX_BYTES || others.reduce((n, a) => n + a.size, 0) + p.size > P.MAIL_ATTACHMENT_MAX_TOTAL) return { state: "refused", code: "too_large" };
      const key = `${draftId}/${p.attachment_id}`;
      const job = pending.get(key) ?? { meta: { attachment_id: p.attachment_id, name, size: p.size, mime: String(p.mime).slice(0, 127), sha256: p.sha256 }, parts: new Map(), at: o.now() };
      if (job.meta.size !== p.size || job.meta.sha256 !== p.sha256) { pending.delete(key); return { state: "refused", code: "hash_mismatch" }; }
      job.parts.set(p.chunk, Buffer.from(p.data, "base64url"));
      pending.set(key, job);
      if (job.parts.size < p.chunks) return { state: "partial", received: job.parts.size, chunks: p.chunks };
      pending.delete(key);
      const bytes = Buffer.concat([...Array(p.chunks).keys()].map((n) => job.parts.get(n) ?? Buffer.alloc(0)));
      if (bytes.length !== p.size || sha(bytes) !== p.sha256) { o.log("mail_attachment", { draft_id: draftId, outcome: "refused", code: "hash_mismatch" }); return { state: "refused", code: "hash_mismatch" }; }
      writeMailFile(join(folder(draftId), p.attachment_id), bytes);
      o.log("mail_attachment", { draft_id: draftId, attachment_id: p.attachment_id, outcome: "stored" });
      return { state: "done", meta: job.meta };
    },
    remove(draftId, attachmentId) { if (OPAQUE.test(draftId) && OPAQUE.test(attachmentId)) rmSync(join(root, draftId, attachmentId), { force: true }); },
    /** At send time: every approved file read again and hashed. → { ok: true, files: [{ name, mime, bytes }] } | { ok: false }. */
    verify(draft) {
      const files = [];
      for (const a of draft.attachments ?? []) {
        let bytes;
        try { bytes = readMailBytes(join(root, draft.draft_id, a.attachment_id)); } catch { return { ok: false }; }
        if (bytes.length !== a.size || sha(bytes) !== a.sha256) { o.log("mail_attachment", { draft_id: draft.draft_id, outcome: "changed" }); return { ok: false }; }
        files.push({ name: a.name, mime: a.mime, bytes });
      }
      return { ok: true, files };
    },
    dropDraft(draftId) { if (OPAQUE.test(draftId)) rmSync(join(root, draftId), { recursive: true, force: true }); for (const k of pending.keys()) if (k.startsWith(`${draftId}/`)) pending.delete(k); },
    /** Every draft folder older than MAIL_FILES_KEEP_MS, and every half-sent file of an hour, gone. → how many folders. */
    sweep() {
      let gone = 0;
      for (const [k, job] of pending) if (o.now() - job.at > 60 * 60_000) pending.delete(k);
      if (!existsSync(root)) return 0;
      for (const d of readdirSync(root)) { const p = join(root, d); try { if (o.now() - statSync(p).mtimeMs > MAIL_FILES_KEEP_MS) { rmSync(p, { recursive: true, force: true }); gone += 1; } } catch { /* gone */ } }
      return gone;
    },
  };
}
