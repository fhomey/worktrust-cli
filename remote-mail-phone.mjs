/**
 * A DRAFT FOR A MAILBOX THAT LIVES ON THE PHONE (CLI 0.11.26; docs/remote-agents/MAIL-ON-PHONE.md §6, owner 2026-11-25: AI is
 * always the person's own agent on their own computer). The phone holds the mailbox; this computer has no copy of it. The
 * phone sends the thread SEALED (`mail.draft.request` with `source`), this runs the SAME tool-less, project-less personal job
 * (remote-mail-draft.mjs: a fresh empty temp folder, removed after; the texts fenced as untrusted data; no voice samples, since
 * the computer holds none of this mailbox's sent mail), and answers `mail.draft` with `account_id: null`, `origin: "phone"`.
 *
 *   held      WORDS ONLY, in memory: `mail.send` for it is refused `not_allowed` (the PHONE sends through its provider), a
 *             rewrite works (on the thread kept with it, in memory), `mail.decline` drops it, and it is gone after 24 hours
 *   kept      nothing of the phone's mail reaches the mail store, the index, a file or a log: logs carry ids and codes only
 *   choice    the person's agent and model ride in the request; a model the inventory does not report is `model_unknown`
 */
import * as P from "./remote-protocol.mjs";
import { draftPrompt } from "./remote-mail-draft.mjs";
import { recipientsFor } from "./remote-mail-compose.mjs";
import { subjectFor } from "./remote-mail-text.mjs";
import { finishDraft } from "./remote-mail-clean.mjs";

export const PHONE_DRAFT_MS = 24 * 60 * 60_000;

/** The phone's messages as the drafter reads a thread: oldest first, the last one the message replied to. */
export const phoneThread = (source) => source.messages.map((m) => ({ from_address: m.from.address.toLowerCase(), from_name: m.from.name, to: m.to, cc: m.cc, date: m.date, text: m.text, subject: source.subject }));

/** c: { o, drafts, run({ agent, model, prompt, onText, signal }) → { ok, draft } | { ok: false, code }, beginLive (remote-mail.mjs: the text live, for `stream`) } */
export function createPhoneDrafts(c) {
  const sweep = () => { const now = c.o.now(); for (const [id, held] of c.drafts) if (held.phone_origin && now >= held.expires_at) { c.drafts.delete(id); c.o.log("mail_draft", { outcome: "expired", draft_id: id }); } };
  /** The job, in the background (the caller holds the one-at-a-time lock). → true when a draft was told. */
  async function draft({ p, req, tell, agent, draftId = P.mintId("mdr", c.o.random) }) {
    const thread = phoneThread(p.source), self = p.source.own_address.toLowerCase(), target = thread.at(-1) ?? null;
    const on = c.beginLive?.({ req, tell, draftId, stream: p.stream === true }) ?? { extra: {}, end: () => {} };
    tell("mail.draft.progress", { request_id: req, phase: "drafting", ...on.extra });
    const rules = c.instructions.resolve(null, p.instructions_id ?? null); on.mark?.(rules); // the type chosen, else the default: a phone's mailbox has no default of its own here
    const prompt = draftPrompt({ mode: p.mode, style: p.style, instruction: p.instruction, thread, samples: [], self, random: c.o.random, instructions: rules.text });
    let r = await c.run({ agent, model: p.model ?? null, prompt, onText: on.onText, signal: on.signal });
    if (!r.ok && r.code === "cancelled") { on.end(); return false; } // stopped from the phone: no draft follows
    if (r.ok) r = await finishDraft({ r, prompt, instruction: p.instruction, again: (p2) => c.run({ agent, model: p.model ?? null, prompt: p2, signal: on.signal }) });
    on.end();
    if (r.ok && rules.note) r = { ...r, draft: { ...r.draft, notes: [...r.draft.notes, rules.note].slice(0, P.MAIL_NOTES_MAX) } };
    if (!r.ok && r.code === "cancelled") return false;
    if (!r.ok) { c.o.log("mail_draft", { outcome: r.code, origin: "phone" }); tell("mail.draft.refused", { request_id: req, code: r.code }); return false; }
    const rcpt = recipientsFor(p.mode, target, self, p.to ?? []);
    const body = { request_id: req, draft_id: draftId, account_id: null, thread_id: null, mode: p.mode, to: rcpt.to, cc: rcpt.cc, bcc: [], subject: target ? subjectFor(p.mode, p.source.subject) : p.source.subject,
      body: r.draft.body, confidence: r.draft.confidence, notes: r.draft.notes, attachments: [], format: "plain", origin: "phone", ...(on.written ?? {}) };
    if (!P.validateEventBody("mail.draft", body).ok) { tell("mail.draft.refused", { request_id: req, code: "unparseable" }); return false; }
    sweep();
    c.drafts.set(draftId, { draft: body, state: "ready", phone: null, request_id: req, original: null, target: null, phone_origin: true, thread, self, expires_at: c.o.now() + PHONE_DRAFT_MS });
    c.o.log("mail_draft", { outcome: "ready", origin: "phone", draft_id: draftId, confidence: body.confidence });
    tell("mail.draft", body);
    return true;
  }
  return { draft, sweep, isPhone: (id) => c.drafts.get(id)?.phone_origin === true };
}
