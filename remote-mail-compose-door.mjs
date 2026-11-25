/**
 * THE MAIL DOOR'S COMPOSE HALF (docs/remote-agents/MAIL.md §Composing by hand; owner, 2026-11-24, screenshots 55 and 56).
 * remote-mail.mjs hands it these, after the phone-only gate:
 *
 *   mail.draft.create      a draft written by hand: no agent runs; it is held like any draft and goes through the same
 *                          approval (the hash over exactly what is shown, files and format included) and the same outbox
 *   mail.draft.edit        with `rewrite`: the person's own agent rewrites the current body (or the body sent beside it) on the
 *                          SAME draft id, one agent run at a time (`exclusive`), progress then the whole draft; it never sends
 *                          and never queues: a queued draft is refused `busy`
 *   mail.attachment.*      a draft's files (remote-mail-attach.mjs): chunks joined and checked, the draft sent back whole
 *   mail.signature*        an account's signatures (remote-mail-signatures.mjs)
 * Answers are sealed for the asking phone alone (`tell`). Logs carry ids and codes, never a name, a subject or a body.
 */
import * as P from "./remote-protocol.mjs";
import { rewritePrompt } from "./remote-mail-draft.mjs";

export const COMPOSE_TYPES = new Set(["mail.draft.create", "mail.attachment.put", "mail.attachment.remove", "mail.signatures.get", "mail.signature.set", "mail.signature.remove"]);

/** c: { o, drafts, index, accountOf, attach, signatures, exclusive(job), agentDraft(prompt) → { ok, draft } | { ok: false, code } } */
export function createComposeDoor(c) {
  const held = (id) => c.drafts.get(id) ?? null;
  const editable = (h) => h.state === "ready" || h.state === "failed"; // a failed send is changed and approved again; a queued one waits
  const replace = (h, draft, tell) => { c.drafts.set(draft.draft_id, { ...h, draft, state: "ready" }); tell("mail.draft", draft); };

  function create(p, req, tell) {
    const account = c.accountOf(p.account_id);
    if (!account || (p.thread_id && c.index.thread(p.thread_id)[0]?.account_id !== account.account_id)) return "not_found";
    const target = p.thread_id ? c.index.thread(p.thread_id).at(-1) ?? null : null;
    const draft = { request_id: req, draft_id: P.mintId("mdr", c.o.random), account_id: account.account_id, thread_id: p.thread_id ?? null, mode: p.mode, to: [...p.to], cc: [...p.cc], bcc: [...p.bcc],
      subject: p.subject, body: p.body, confidence: "high", notes: [], attachments: [], format: p.format ?? "plain" };
    if (!P.validateEventBody("mail.draft", draft).ok) return "not_allowed";
    c.drafts.set(draft.draft_id, { draft, state: "ready", phone: null, request_id: req, original: target?.remote_ref ?? null, target: target?.message_id ?? null });
    c.o.log("mail_draft", { outcome: "written", draft_id: draft.draft_id });
    tell("mail.draft", draft);
    return "taken";
  }

  /** The rewrite: in the background, one agent run at a time; the answer is the same draft with its new body. */
  function rewrite(p, req, tell) {
    const h = held(p.draft_id);
    if (!h) return "not_found";
    if (!editable(h)) return "busy";
    const account = c.accountOf(h.draft.account_id);
    const body = p.body ?? h.draft.body;
    tell("mail.draft.progress", { request_id: req, phase: "reading" });
    c.exclusive(async () => {
      tell("mail.draft.progress", { request_id: req, phase: "drafting" });
      const thread = h.draft.thread_id ? c.index.thread(h.draft.thread_id) : [];
      const r = await c.agentDraft(rewritePrompt({ kind: p.rewrite.kind, body, thread, self: account?.address ?? null, random: c.o.random }));
      const now = held(p.draft_id);
      if (!now || !editable(now)) return tell("mail.draft.refused", { request_id: req, code: "busy" });
      if (!r.ok) { c.o.log("mail_draft", { outcome: r.code, draft_id: p.draft_id }); return tell("mail.draft.refused", { request_id: req, code: r.code }); }
      const { rewrite: _r, draft_id: _d, ...fields } = p;
      const draft = { ...now.draft, ...fields, body: r.draft.body, notes: r.draft.notes, confidence: r.draft.confidence, request_id: req };
      if (!P.validateEventBody("mail.draft", draft).ok) return tell("mail.draft.refused", { request_id: req, code: "unparseable" });
      c.o.log("mail_draft", { outcome: "rewritten", draft_id: p.draft_id, kind: p.rewrite.kind });
      replace(now, draft, tell); // a READY draft, never queued: a rewrite cannot send
    }).catch(() => tell("mail.draft.refused", { request_id: req, code: "agent_failed" }));
    return "taken";
  }

  function attachment(type, p, req, tell) {
    const h = held(p.draft_id);
    if (!h) return "not_found";
    if (!editable(h)) return "busy";
    if (type === "mail.attachment.remove") {
      c.attach.remove(p.draft_id, p.attachment_id);
      replace(h, { ...h.draft, attachments: h.draft.attachments.filter((a) => a.attachment_id !== p.attachment_id), request_id: req }, tell);
      return "taken";
    }
    const r = c.attach.put(p.draft_id, p, h.draft.attachments);
    if (r.state === "refused") { tell("mail.attachment.refused", { request_id: req, draft_id: p.draft_id, attachment_id: p.attachment_id, code: r.code }); return "taken"; }
    tell("mail.attachment.added", { request_id: req, draft_id: p.draft_id, attachment_id: p.attachment_id, received: r.state === "done" ? p.chunks : r.received, chunks: p.chunks });
    if (r.state === "done") replace(h, { ...h.draft, attachments: [...h.draft.attachments.filter((a) => a.attachment_id !== p.attachment_id), r.meta], request_id: req }, tell);
    return "taken";
  }

  function signature(type, p, req, tell) {
    if (!c.accountOf(p.account_id)) return "not_found";
    const r = type === "mail.signatures.get" ? { ok: true, value: c.signatures.of(p.account_id) } : type === "mail.signature.set" ? c.signatures.set(p) : c.signatures.remove(p.account_id, p.signature_id);
    if (!r.ok) return r.code === "not_found" ? "not_found" : "not_allowed";
    tell("mail.signatures", { request_id: req, ...r.value });
    return "taken";
  }

  return {
    handles: (type, p) => COMPOSE_TYPES.has(type) || (type === "mail.draft.edit" && p?.rewrite !== undefined),
    handle(type, p, req, tell) {
      if (type === "mail.draft.create") return create(p, req, tell);
      if (type === "mail.draft.edit") return rewrite(p, req, tell);
      if (type.startsWith("mail.attachment.")) return attachment(type, p, req, tell);
      return signature(type, p, req, tell);
    },
  };
}
