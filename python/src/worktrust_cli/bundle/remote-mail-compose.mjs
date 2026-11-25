/**
 * A THREAD FOR THE PHONE, AND THE PARTS OF A DRAFT (docs/remote-agents/MAIL.md §Events, §The personal draft job). Pure.
 *
 *   threadBody      the newest MAIL_THREAD_MAX_MESSAGES of a thread as `mail.thread` messages: quotes collapsed only where
 *                   ~80% is already in an earlier message (a forward keeps its quote), each text under MAIL_TEXT_MAX, and
 *                   all texts under MAIL_THREAD_BUDGET_BYTES, the OLDEST cut first so the newest stays whole
 *   recipientsFor   reply: the target's Reply-To, else its sender (the person's own message: its recipients); reply_all:
 *                   that and every other recipient, the person's own address left out; forward and new: the phone's `to`
 *   draftContext    the thread cut at the target (the newest message: thread_up_to), the subject, the voice samples
 */
import * as P from "./remote-protocol.mjs";
import { collapseQuote, subjectFor } from "./remote-mail-text.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");
const cutTo = (text, max) => { let t = text; while (bytes(t) > max) t = t.slice(0, Math.max(0, Math.floor(t.length * (max / bytes(t))) - 1)); return t; };
const person = (p) => ({ name: p?.name ? String(p.name).slice(0, P.MAIL_NAME_MAX) || null : null, address: String(p?.address ?? "").slice(0, P.MAIL_ADDRESS_MAX) || "unknown@unknown.invalid" });

/** `msgs`: the index's rows of one thread, oldest first. → the body of mail.thread without request_id. */
export function threadBody(msgs) {
  const newest = msgs.slice(-P.MAIL_THREAD_MAX_MESSAGES), older = msgs.length - newest.length;
  const forward = (m) => /^(fwd?|fw):/i.test(m.subject);
  let out = newest.map((m, i) => {
    const earlier = msgs.slice(0, older + i).map((e) => e.text);
    const q = collapseQuote(m.text, earlier, { forward: forward(m) });
    const text = q.text.slice(0, P.MAIL_TEXT_MAX);
    return { message_id: m.message_id, from: person({ name: m.from_name, address: m.from_address }), to: m.to.map(person), cc: m.cc.map(person), date: m.date, text, cut: text.length < q.text.length || m.text_is_preview === true, quote_collapsed: q.collapsed, attachments: m.attachments.map((a) => ({ name: String(a.name).slice(0, P.MAIL_ATTACHMENT_NAME_MAX) || "attachment", size: Math.max(0, Math.trunc(a.size) || 0), mime: String(a.mime || "application/octet-stream").slice(0, 127) })) };
  });
  let total = out.reduce((n, m) => n + bytes(m.text), 0);
  for (let i = 0; i < out.length - 1 && total > P.MAIL_THREAD_BUDGET_BYTES; i += 1) {
    const over = total - P.MAIL_THREAD_BUDGET_BYTES, had = bytes(out[i].text), text = cutTo(out[i].text, Math.max(0, had - over));
    total -= had - bytes(text);
    out[i] = { ...out[i], text, cut: true };
  }
  if (total > P.MAIL_THREAD_BUDGET_BYTES) { const last = out.length - 1, text = cutTo(out[last].text, P.MAIL_THREAD_BUDGET_BYTES - (total - bytes(out[last].text))); out[last] = { ...out[last], text, cut: true }; }
  const top = msgs.at(-1);
  return { thread_id: top.thread_id, account_id: top.account_id, subject: top.subject.slice(0, P.MAIL_SUBJECT_MAX), messages: out, older };
}

const unique = (list) => [...new Set(list.map((a) => a.toLowerCase()))];
/** → { to, cc } as address strings. `self`: the account's own address; `given`: the phone's `to` (forward, new). */
export function recipientsFor(mode, target, self, given = []) {
  const me = String(self).toLowerCase();
  if (mode === "forward" || mode === "new" || !target) return { to: unique(given), cc: [] };
  const mine = target.from_address === me;
  const primary = mine ? target.to.map((p) => p.address) : target.reply_to?.length ? target.reply_to.map((p) => p.address) : [target.from_address];
  if (mode === "reply") return { to: unique(primary).filter((a) => a !== me), cc: [] };
  const to = unique([...primary, ...(mine ? [] : target.to.map((p) => p.address))]).filter((a) => a !== me);
  const cc = unique(target.cc.map((p) => p.address)).filter((a) => a !== me && !to.includes(a));
  return { to: to.slice(0, P.MAIL_RECIPIENTS_MAX), cc: cc.slice(0, P.MAIL_RECIPIENTS_MAX) };
}

/** → { target, thread (cut at the target), subject, samples } for the drafter. `index` gives the samples. */
export function draftContext({ msgs, mode, account, index }) {
  const target = msgs.at(-1) ?? null;
  const thread = target ? msgs.slice(0, msgs.indexOf(target) + 1) : [];
  const subject = target ? subjectFor(mode, target.subject) : "";
  const { to } = recipientsFor(mode, target, account.address);
  const samples = to[0] ? index.sentTo(account.account_id, to[0], 2) : [];
  return { target, thread, subject, samples };
}
