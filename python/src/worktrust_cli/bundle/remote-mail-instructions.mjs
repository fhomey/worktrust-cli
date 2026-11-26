/**
 * THE PERSON'S E-MAIL INSTRUCTIONS, AS TYPES THEY KEEP (CLI 0.11.26; owner, 2026-11-25: "Business, Shipping, Personal …",
 * kept as files on the computer, visible and editable in the app and kept in sync). This is the LOCAL STORE, pure over one
 * directory (~/.worktrust/remote/mail/instructions): the sync messages and the phone's screens build on it elsewhere.
 *
 *   profiles  one markdown file per profile, `<id>.md` (ids are slugs), and `index.json` beside them: each profile's name,
 *             version (monotonic), updated_at, updated_by ("computer" | "phone"), the hash of its text; and the per-mailbox
 *             default profile. Every write is atomic and 0600 (remote-mail-files.mjs).
 *   default   the built-in `default` profile, shipped below, made on first use: it can be edited or reset, never removed
 *   by hand   a file edited in an editor on this computer is picked up at the next read (its hash changed): version + 1,
 *             updated_by "computer"; a new `<slug>.md` dropped in is adopted (its name from its first heading)
 *   conflict  put(id, { base_version }) on a profile whose version moved on answers { ok: false, code: "conflict", current }
 *             and writes nothing: two editors never overwrite each other silently
 *   caps      MAX_PROFILES profiles, PROFILE_MAX bytes each, a name of NAME_MAX characters
 *   trusted   the text is the PERSON's: it goes into the instruction side of the prompt, before any mail, and the mail it
 *             drafts stays fenced as untrusted data that can never change it (remote-mail-draft.mjs draftPrompt).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";

export const MAX_PROFILES = 20, PROFILE_MAX = 8_192, NAME_MAX = 60, DEFAULT_ID = "default";
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_INSTRUCTIONS = `# Default

These are my own instructions. My agent follows them for every e-mail draft and rewrite that uses this type.
Edit this file with any editor; the next draft uses it. \`npx worktrust mail instructions --reset default\` restores this text.

## Answer
- Answer with the e-mail only: the salutation, the body and the closing. Nothing before it, nothing after it.
- One version. No explanation, no remark about the draft, no question to me, no options.
- No headings, no code blocks, no "Subject:" line (the subject is set separately).

## Tone and length
- Friendly and professional; direct; no filler.
- As short as the message allows: usually three to six sentences.

## Salutation and sign-off
- Start with "Hi <first name>," in English and "Hoi <voornaam>," in Dutch, or follow the thread's own register.
- End with "Best," (English) or "Groet," (Dutch) and my first name.

## Language
- Write in the language of my instruction; with no instruction, in the language of the e-mail I answer.

## What you cannot know
- Choose when my instruction is ambiguous, and write the e-mail.
- Put a fact you cannot know in [square brackets], for example [date], and never invent it.
- Cover every bullet I give.
`;

const hash = (text) => createHash("sha256").update(text).digest("hex");
const nameOf = (text, id) => (/^\s*#\s+(.+)$/m.exec(text)?.[1]?.trim() || id).slice(0, NAME_MAX);
const bytes = (text) => Buffer.byteLength(text, "utf8");

/** The store over `dir`. `now` is the clock (updated_at). */
export function createInstructionStore({ dir, now = Date.now }) {
  const indexFile = join(dir, "index.json"), fileOf = (id) => join(dir, `${id}.md`);
  const readText = (id) => { try { const st = lstatSync(fileOf(id)); if (!st.isFile() || st.isSymbolicLink() || st.size > PROFILE_MAX) return null; return readMailFile(fileOf(id)); } catch { return null; } };
  const loadIndex = () => { try { const v = JSON.parse(readMailFile(indexFile)); return { v: 1, profiles: v?.profiles && typeof v.profiles === "object" ? v.profiles : {}, mailbox_defaults: v?.mailbox_defaults && typeof v.mailbox_defaults === "object" ? v.mailbox_defaults : {} }; } catch { return { v: 1, profiles: {}, mailbox_defaults: {} }; } };
  const saveIndex = (index) => writeMailFile(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  /** Bring the index in line with the files: the built-in default made, hand edits and dropped-in files picked up. */
  function scan() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const index = loadIndex();
    let changed = false;
    if (!existsSync(fileOf(DEFAULT_ID))) { writeMailFile(fileOf(DEFAULT_ID), DEFAULT_INSTRUCTIONS); }
    const ids = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((id) => SLUG.test(id));
    for (const id of ids) {
      const text = readText(id);
      if (text === null) continue;
      const h = hash(text), p = index.profiles[id];
      if (!p) { index.profiles[id] = { name: nameOf(text, id), version: 1, updated_at: now(), updated_by: "computer", hash: h }; changed = true; }
      else if (p.hash !== h) { index.profiles[id] = { ...p, version: p.version + 1, updated_at: now(), updated_by: "computer", hash: h }; changed = true; }
    }
    for (const id of Object.keys(index.profiles)) if (!ids.includes(id)) { delete index.profiles[id]; changed = true; } // removed by hand
    for (const [mailbox, id] of Object.entries(index.mailbox_defaults)) if (!index.profiles[id]) { delete index.mailbox_defaults[mailbox]; changed = true; }
    if (changed) saveIndex(index);
    return index;
  }
  const row = (id, p) => ({ id, name: p.name, version: p.version, updated_at: p.updated_at, updated_by: p.updated_by });

  return {
    path: (id = DEFAULT_ID) => fileOf(id),
    /** Every profile, the built-in default first. */
    list() { const index = scan(); return Object.entries(index.profiles).map(([id, p]) => ({ ...row(id, p), bytes: bytes(readText(id) ?? ""), mailboxes: Object.entries(index.mailbox_defaults).filter(([, d]) => d === id).map(([m]) => m) })).sort((a, b) => (a.id === DEFAULT_ID ? -1 : b.id === DEFAULT_ID ? 1 : a.name.localeCompare(b.name))); },
    get(id) { if (!SLUG.test(String(id))) return null; const index = scan(), p = index.profiles[id], text = p ? readText(id) : null; return p && text !== null ? { ...row(id, p), text } : null; },
    /** Write a profile. A new one: base_version 0 (or absent). An existing one: base_version must be its current version. */
    put(id, { name, text, base_version = 0, by = "computer" }) {
      if (!SLUG.test(String(id))) return { ok: false, code: "invalid" };
      if (typeof text !== "string" || !text.trim() || bytes(text) > PROFILE_MAX) return { ok: false, code: "too_large" };
      if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > NAME_MAX)) return { ok: false, code: "invalid" };
      const index = scan(), p = index.profiles[id];
      if (p ? base_version !== p.version : base_version !== 0) return { ok: false, code: "conflict", current: p ? row(id, p) : null };
      if (!p && Object.keys(index.profiles).length >= MAX_PROFILES) return { ok: false, code: "limit" };
      writeMailFile(fileOf(id), text);
      index.profiles[id] = { name: (name ?? p?.name ?? nameOf(text, id)).trim(), version: (p?.version ?? 0) + 1, updated_at: now(), updated_by: by === "phone" ? "phone" : "computer", hash: hash(text) };
      saveIndex(index);
      return { ok: true, profile: row(id, index.profiles[id]) };
    },
    /** Any profile but the built-in default. */
    remove(id) {
      if (id === DEFAULT_ID) return { ok: false, code: "not_allowed" };
      const index = scan();
      if (!index.profiles[id]) return { ok: false, code: "not_found" };
      rmSync(fileOf(id), { force: true }); delete index.profiles[id];
      for (const [m, d] of Object.entries(index.mailbox_defaults)) if (d === id) delete index.mailbox_defaults[m];
      saveIndex(index);
      return { ok: true };
    },
    /** The shipped default text again (the default profile, or any profile asked). */
    reset(id = DEFAULT_ID) { const p = scan().profiles[id]; if (!p) return { ok: false, code: "not_found" }; return this.put(id, { text: id === DEFAULT_ID ? DEFAULT_INSTRUCTIONS : DEFAULT_INSTRUCTIONS.replace("# Default", `# ${p.name}`), base_version: p.version }); },
    /** A mailbox's own default profile (null: the built-in default). */
    setMailboxDefault(mailbox, id) { const index = scan(); if (id !== null && !index.profiles[id]) return { ok: false, code: "not_found" }; if (id === null) delete index.mailbox_defaults[mailbox]; else index.mailbox_defaults[mailbox] = id; saveIndex(index); return { ok: true }; },
    /**
     * The text for one draft, read now: the profile chosen, else the mailbox's default, else the built-in default. A profile
     * that is gone or unreadable falls back with a note. → { id, name, text, version, updated_at, note }
     */
    resolve(mailbox = null, chosen = null) {
      const index = scan(), want = chosen ?? (mailbox ? index.mailbox_defaults[mailbox] : null) ?? DEFAULT_ID;
      for (const id of [want, DEFAULT_ID]) {
        const p = index.profiles[id], text = p ? readText(id) : null;
        if (p && text !== null) return { id, name: p.name, text, version: p.version, updated_at: p.updated_at, note: id === want ? null : `The instructions "${want}" could not be read: "${id}" was used.` };
      }
      return { id: DEFAULT_ID, name: "Default", text: DEFAULT_INSTRUCTIONS, version: 0, updated_at: null, note: "Your instructions could not be read: the shipped default was used." };
    },
  };
}
