/**
 * THE JOURNAL AGAIN, FOR ONE PHONE, AT THE SPEED OF THE PACER (the catch-up of release 37, moved here and made
 * asynchronous 2026-11-16; docs/remote-agents/PROTOCOL.md §Catch-up, CHAT-HISTORY.md §4.1).
 *
 *   catchUp  session.attach with `after`, `max_events` and `max_bytes`: the journaled events after `after`, in order, at
 *            most max_events of them and at most max_bytes of their canonical records (one always, so every page moves;
 *            both capped by the bounds of the protocol whatever was asked), sealed again for the asking phone alone. A
 *            session this computer never ran or journaled is `not_found`. Reading only: it runs no agent, writes no event
 *            of its own, and is answered while the computer is paused, like status.get.
 *   replay   the older attach without `after`: what the journal keeps of the session, also for the phone that asked only
 *            (until 0.11.15 it went to every channel, which is how one phone could bury another under a journal).
 *
 * Both seal BATCH records, then wait until the pacer has room (remote-pace.mjs `room`), so a live event is never behind
 * more than about a second of replay; and ONE runs per phone at a time, in the order asked: a phone that asks for twenty
 * sessions at once (build 23 after every handshake) gets them one after another, each page closed by its own acceptance.
 */
import * as P from "./remote-protocol.mjs";

export const BATCH = 20;

export function createCatchUp({ journal, known, sealFor, room = async () => {}, log = () => {} }) {
  const lines = new Map(); // phone -> the end of its line
  const inLine = (phone, work) => {
    const run = (lines.get(phone) ?? Promise.resolve()).then(work);
    const end = run.catch(() => {});
    lines.set(phone, end);
    end.then(() => { if (lines.get(phone) === end) lines.delete(phone); });
    return run;
  };
  /** The records, sealed again for `phone` alone, BATCH at a time, each batch only once the pacer has room. */
  async function sealed(records, phone) {
    if (!phone) return; // never for every phone: a record sealed here is for the one that asked
    for (let i = 0; i < records.length; i += 1) {
      if (i % BATCH === 0) await room();
      sealFor(records[i], phone);
    }
  }
  function catchUp(sessionId, payload, phone) {
    if (!known(sessionId)) return "not_found";
    return inLine(phone, async () => {
      const most = Math.min(payload.max_events, P.CATCH_UP_MAX_EVENTS), limit = Math.min(payload.max_bytes, P.CATCH_UP_MAX_BYTES);
      const page = [];
      let bytes = 0;
      for (const record of journal.eventsAfter(sessionId, payload.after)) {
        const weight = P.canonicalJson(record).length;
        if (page.length >= most || (page.length > 0 && bytes + weight > limit)) break;
        page.push(record); bytes += weight;
      }
      await sealed(page, phone);
      log("catch_up", { sent: page.length });
      return "taken";
    });
  }
  /** → a promise: resolved once the last record was handed to the pacer. No phone named: nothing is sent. */
  const replay = (sessionId, after, phone) => (phone ? inLine(phone, () => sealed(journal.eventsAfter(sessionId, after), phone)) : Promise.resolve());
  return { catchUp, replay, waiting: () => lines.size };
}
