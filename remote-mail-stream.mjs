/**
 * A DRAFT, LIVE (CLI 0.11.26; owner, 2026-11-25: "the local agent must send the answer back so you see the answer on the phone
 * … by the same method as Remote Agent control: you have the session LIVE on it"). For a mail.draft.request (or a rewrite)
 * with `stream`, while the person's agent writes, the text as it grows goes to the phone that asked, and to it alone, as
 * mail.draft.progress { phase: "drafting", draft_id, seq, text_delta }, sealed on the transient lane like every mail event.
 *
 *   paced      at most one piece every MAIL_DRAFT_STREAM_MS (four a second): the agent's many small deltas are joined here;
 *              each piece at most MAIL_DRAFT_DELTA_MAX, the whole at most MAIL_DRAFT_BODY_MAX; the daemon's pacer below that
 *   order      `seq` from 0; a text that is not the one already sent, grown, is not sent (the final draft settles it)
 *   final      the final mail.draft is the authority: every check runs on it, and only it (its id, its approval hash) can be
 *              sent; the phone replaces what streamed with it. A stop (mail.decline of its draft_id) ends the stream: nothing
 *              more is sent, and no draft follows
 * Pure over `tell` and `later`; it never reads the agent's output itself (remote-mail-draft.mjs draftTextSoFar does).
 */
import * as P from "./remote-protocol.mjs";

/** → { push(textSoFar), stop() } */
export function createDraftStream({ tell, req, draftId, later, firstAt = () => null, every = P.MAIL_DRAFT_STREAM_MS, max = P.MAIL_DRAFT_BODY_MAX }) {
  let sent = "", latest = "", seq = 0, pending = false, stopped = false;
  function flush() {
    pending = false;
    if (stopped || !latest.startsWith(sent)) return;
    let rest = latest.slice(sent.length, max);
    while (rest.length > 0) {
      const piece = rest.slice(0, P.MAIL_DRAFT_DELTA_MAX);
      const first = seq === 0 ? firstAt() : null; // the first piece says when the agent's first text came (the computer's clock)
      tell("mail.draft.progress", { request_id: req, phase: "drafting", draft_id: draftId, seq, text_delta: piece, ...(first !== null ? { first_text_at: first } : {}) });
      seq += 1; sent += piece; rest = rest.slice(piece.length);
    }
  }
  return {
    push(text) {
      if (stopped || typeof text !== "string" || text.length <= sent.length || !text.startsWith(sent)) return;
      latest = text.slice(0, max);
      if (!pending) { pending = true; later(every, flush); }
    },
    stop() { stopped = true; },
    get sent() { return sent; },
  };
}
