/**
 * THE OUTBOX: THE ONE PLACE MAIL IS SENT (docs/remote-agents/MAIL.md §The approval hash, §The outbox; rules 1 and 2).
 *
 *   approve   `submit` takes a draft only in state `ready` and only when the phone's hash is the hash of the draft as held
 *             (the protocol's mailApprovalHash, recomputed here); a mismatch is `hash_mismatch`, a draft already queued or
 *             sent `already_used`, an unknown one `not_found`
 *   undo      queued for MAIL_UNDO_MS; `undo` before that returns the draft to `ready` (a new send needs a new approval)
 *   flip      at its time the entry turns `sending` and is WRITTEN TO DISK before the transport is called (the guarded flip)
 *   once      the transport's answer ends it `sent` or `failed`; NOTHING IS RETRIED: an interrupted connection, a 5xx or a
 *             timeout is `failed`; a daemon that starts and finds `queued` or `sending` marks them `failed interrupted`
 * The outbox file holds ids, states and times only: never a subject, an address or a body (those stay in memory with the
 * draft). Logs say decisions by id.
 */
import { existsSync } from "node:fs";
import * as P from "./remote-protocol.mjs";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";

const KEEP = 200;

/**
 * o: { file, now, later(ms, fn) (a timer), drafts: { get(id), set(id, held) }, deliver(held) → Promise<{ ok } | { ok: false, code }>,
 *      log(kind, fields), told(kind, held, extra) (the daemon's answer to the phone that asked) }
 */
export function createOutbox(o) {
  let entries = [];
  try { if (existsSync(o.file)) entries = JSON.parse(readMailFile(o.file)).entries ?? []; } catch { entries = []; }
  const save = () => writeMailFile(o.file, JSON.stringify({ v: 1, entries: entries.slice(-KEEP) }));
  const entry = (id) => entries.find((e) => e.draft_id === id) ?? null;
  const set = (id, change) => { entries = entries.map((e) => (e.draft_id === id ? { ...e, ...change } : e)); save(); };

  async function fire(id) {
    const e = entry(id);
    if (!e || e.state !== "queued") return; // undone, or already handled
    const held = o.drafts.get(id);
    if (!held) { set(id, { state: "failed", code: "not_found", at: o.now() }); o.log("mail_send", { draft_id: id, outcome: "not_found" }); return o.told("mail.send.failed", { draft: { draft_id: id }, request_id: e.request_id, phone: e.phone }, { code: "not_found" }); }
    set(id, { state: "sending", at: o.now() }); // ON DISK before the transport is called
    let result;
    try { result = await o.deliver(held); } catch { result = { ok: false, code: "interrupted" }; }
    if (result?.ok) {
      set(id, { state: "sent", at: o.now() });
      o.drafts.set(id, { ...held, state: "sent" });
      o.log("mail_send", { draft_id: id, outcome: "sent" });
      return o.told("mail.sent", { ...held, request_id: e.request_id, phone: e.phone }, {});
    }
    const code = P.MAIL_SEND_FAILURES.includes(result?.code) ? result.code : "rejected";
    set(id, { state: "failed", code, at: o.now() });
    o.drafts.set(id, { ...held, state: "failed" });
    o.log("mail_send", { draft_id: id, outcome: "failed", code }); // never retried: the person approves again if they want it sent
    return o.told("mail.send.failed", { ...held, request_id: e.request_id, phone: e.phone }, { code });
  }

  return {
    /** A daemon's start: whatever an earlier one left queued or mid-send is failed, never sent. → their ids. */
    recover() {
      const left = entries.filter((e) => e.state === "queued" || e.state === "sending").map((e) => e.draft_id);
      for (const id of left) { set(id, { state: "failed", code: "interrupted", at: o.now() }); o.log("mail_send", { draft_id: id, outcome: "failed", code: "interrupted" }); }
      return left;
    },
    /** → { ok: true, undo_until } or { ok: false, code }. `phone` and `request_id`: where the answers go. */
    submit(draftId, approvalHash, { phone, request_id }) {
      const held = o.drafts.get(draftId);
      if (!held) return { ok: false, code: "not_found" };
      if (held.state !== "ready" && held.state !== "failed") return { ok: false, code: "already_used" }; // a failed send is approved again, never retried by itself
      const want = P.mailApprovalHash(held.draft);
      if (typeof approvalHash !== "string" || approvalHash !== want) { o.log("mail_send", { draft_id: draftId, outcome: "refused", code: "hash_mismatch" }); return { ok: false, code: "hash_mismatch" }; }
      const undo_until = o.now() + P.MAIL_UNDO_MS;
      o.drafts.set(draftId, { ...held, state: "queued" });
      entries = [...entries.filter((e) => e.draft_id !== draftId), { draft_id: draftId, state: "queued", due: undo_until, request_id, phone, at: o.now() }];
      save();
      o.log("mail_send", { draft_id: draftId, outcome: "queued" });
      o.later(P.MAIL_UNDO_MS, () => { fire(draftId).catch(() => o.log("mail_send", { draft_id: draftId, outcome: "failed", code: "interrupted" })); });
      return { ok: true, undo_until };
    },
    /** → true when it was still queued and in its window: the draft is `ready` again. */
    undo(draftId) {
      const e = entry(draftId), held = o.drafts.get(draftId);
      if (!e || e.state !== "queued" || o.now() >= e.due || !held) return false;
      set(draftId, { state: "undone", at: o.now() });
      o.drafts.set(draftId, { ...held, state: "ready" });
      o.log("mail_send", { draft_id: draftId, outcome: "undone" });
      return true;
    },
    state: (draftId) => entry(draftId)?.state ?? null,
    /** For the tests and `worktrust mail status`: counts by state, never content. */
    counts: () => entries.reduce((n, e) => ({ ...n, [e.state]: (n[e.state] ?? 0) + 1 }), {}),
    fire,
  };
}
