/**
 * MAIL SYNC (docs/remote-agents/MAIL.md §Providers; rules 10 and 11, OpenClaw rule 6). One engine over two transport shapes:
 *
 *   graph     transport.sync(state) → messages since the folder's deltaLink (remote-mail-graph.mjs); 410 is a resync
 *   imap      transport.status(folder) → { uidvalidity, uidnext }, transport.latest(folder, n), transport.since(folder, uid, n)
 *             for INBOX and Sent. UIDVALIDITY is checked on EVERY sync: when it changed, the folder is fetched again and
 *             re-keyed by Message-ID (the derived ids do not change, so nothing doubles); the first sync records a BASELINE
 *             (the newest MAIL_BASELINE per folder), older mail is never replayed as new; dedupe on uidvalidity:uid.
 *             The IMAP wire client is not in this release (MAIL.md §Open 1): this engine is ready for whichever is chosen.
 *
 * Every message becomes one index row: its id and thread id DERIVED (protocol mailMessageId / mailThreadId: the thread key is
 * the first References id, else In-Reply-To, else the Message-ID), its text sanitised (remote-mail-text.mjs). Three
 * authentication failures in a row stop the account at `auth_failed` until it is signed in again. Logs carry ids and
 * counts, never a subject or an address. Nothing here sends.
 */
import * as P from "./remote-protocol.mjs";
import { cleanText, htmlToText, messageIdOf, threadKey } from "./remote-mail-text.mjs";

export const MAIL_BASELINE = 200, MAIL_POLL_MS = 60_000, MAIL_AUTH_STRIKES = 3;

/** A transport's message as an index row for `accountId`. */
export function rowOf(accountId, m) {
  const header = messageIdOf(m.header_message_id);
  const key = header ?? (m.uid !== undefined ? `${m.folder}:${m.uidvalidity}:${m.uid}` : `ref:${m.remote_ref}`);
  const tkey = m.thread_key ?? threadKey({ references: m.references ?? [], inReplyTo: m.in_reply_to, messageId: header, fallback: key });
  const text = cleanText(m.html && !m.text ? htmlToText(m.html) : m.text ?? "");
  return {
    message_id: P.mailMessageId(accountId, key), thread_id: P.mailThreadId(accountId, tkey), account_id: accountId, folder: m.folder === "sent" ? "sent" : "inbox",
    header_message_id: header, references: (m.references ?? []).slice(-20), remote_ref: m.remote_ref ?? null, uid: m.uid ?? null, uidvalidity: m.uidvalidity ?? null,
    from_name: m.from?.name ? cleanText(m.from.name).slice(0, P.MAIL_NAME_MAX) || null : null, from_address: String(m.from?.address ?? "").slice(0, P.MAIL_ADDRESS_MAX) || "unknown@unknown.invalid",
    to: (m.to ?? []).slice(0, P.MAIL_RECIPIENTS_MAX), cc: (m.cc ?? []).slice(0, P.MAIL_RECIPIENTS_MAX), reply_to: (m.reply_to ?? []).slice(0, 10),
    date: Number.isSafeInteger(m.date) ? m.date : 0, subject: cleanText(m.subject ?? "").replace(/\s+/g, " ").slice(0, P.MAIL_SUBJECT_MAX),
    text: text.slice(0, P.MAIL_TEXT_MAX * 2), text_is_preview: m.text_is_preview === true, unread: m.unread === true, starred: m.starred === true,
    attachments: (m.attachments ?? []).slice(0, P.MAIL_ATTACHMENTS_MAX), labels: (m.labels ?? []).filter((l) => typeof l === "string" && l.trim()).map((l) => l.slice(0, P.MAIL_LABEL_MAX)).slice(0, P.MAIL_LABELS_MAX),
  };
}

/** One IMAP-shaped folder, one sync. `st`: { uidvalidity, last_uid } or undefined. → { rows, state, rekeyed, baseline }. */
export async function syncImapFolder(accountId, transport, folder, role, st) {
  const status = await transport.status(folder);
  const tag = (list) => list.map((m) => rowOf(accountId, { ...m, folder: role, uidvalidity: status.uidvalidity }));
  if (!st || st.uidvalidity !== status.uidvalidity) {
    const latest = await transport.latest(folder, MAIL_BASELINE);
    const last = latest.reduce((n, m) => Math.max(n, m.uid), 0);
    return { rows: tag(latest), state: { uidvalidity: status.uidvalidity, last_uid: Math.max(last, status.uidnext - 1) }, rekeyed: Boolean(st), baseline: !st };
  }
  const fresh = (await transport.since(folder, st.last_uid + 1, MAIL_BASELINE)).filter((m) => m.uid > st.last_uid);
  return { rows: tag(fresh), state: { uidvalidity: status.uidvalidity, last_uid: fresh.reduce((n, m) => Math.max(n, m.uid), st.last_uid) }, rekeyed: false, baseline: false };
}

/**
 * o: { index, transportOf(account) → transport | null, loadState() / saveState(state) (per account: cursors, status, strikes;
 *      no secret, no address), accounts() → the vault's accounts, now, log, every(ms, fn) → stop, onChange(accountId) }
 */
export function createMailSync(o) {
  let state = o.loadState() ?? {};
  const put = (id, change) => { state = { ...state, [id]: { ...(state[id] ?? {}), ...change } }; o.saveState(state); };
  const running = new Set();

  async function syncOne(account) {
    if (running.has(account.account_id)) return { ok: false, code: "busy" };
    const s = state[account.account_id] ?? {};
    if (s.status === "auth_failed" || s.status === "needs_consent") return { ok: false, code: s.status };
    const transport = o.transportOf(account);
    if (!transport) { put(account.account_id, { status: "offline" }); return { ok: false, code: "unsupported" }; }
    running.add(account.account_id);
    put(account.account_id, { status: "syncing" });
    try {
      let rows = [], cursors = s.cursors ?? {}, baseline = false, rekeyed = false;
      if (transport.kind === "graph") {
        const r = await transport.sync(cursors);
        if (!r.ok) return fail(account, r.code);
        rows = r.messages.map((m) => rowOf(account.account_id, m)); cursors = r.state; baseline = !s.cursors;
      } else {
        const folders = transport.begin ? await transport.begin() : transport.folders ?? [["INBOX", "inbox"], ["Sent", "sent"]];
        try {
          for (const [folder, role] of folders) {
            const r = await syncImapFolder(account.account_id, transport, folder, role, cursors[folder]);
            rows.push(...r.rows); cursors = { ...cursors, [folder]: r.state }; baseline ||= r.baseline; rekeyed ||= r.rekeyed;
          }
        } finally { await transport.end?.(); }
      }
      const known = new Set(o.index.rows(account.account_id).map((r) => r.message_id));
      const fresh = rows.filter((r) => r.folder === "inbox" && !known.has(r.message_id));
      o.index.putMany(rows);
      put(account.account_id, { cursors, status: "synced", strikes: 0, last_sync_at: o.now() });
      o.log("mail_sync", { account_id: account.account_id, rows: rows.length, ...(baseline ? { baseline: true } : {}), ...(rekeyed ? { rekeyed: true } : {}) });
      if (rows.length > 0) o.onChange?.(account.account_id);
      if (!baseline && !rekeyed && fresh.length > 0) o.onNew?.(account, fresh); // new mail, never a baseline or a re-key replayed (OpenClaw rule 6)
      return { ok: true, rows: rows.length, baseline, rekeyed };
    } catch (error) {
      return fail(account, error?.code === "auth_failed" || error?.code === "app_password_needed" ? "auth_failed" : "offline");
    } finally { running.delete(account.account_id); }
  }
  function fail(account, code) {
    const strikes = code === "auth_failed" ? (state[account.account_id]?.strikes ?? 0) + 1 : state[account.account_id]?.strikes ?? 0;
    const status = strikes >= MAIL_AUTH_STRIKES ? "auth_failed" : "offline";
    put(account.account_id, { status, strikes });
    o.log("mail_sync", { account_id: account.account_id, outcome: code, ...(status === "auth_failed" ? { stopped: true } : {}) });
    o.onChange?.(account.account_id);
    return { ok: false, code };
  }
  let stop = null;
  return {
    syncOne,
    syncAll: async () => { const out = []; for (const a of o.accounts()) out.push(await syncOne(a)); return out; },
    start() { stop ??= o.every(MAIL_POLL_MS, () => { for (const a of o.accounts()) syncOne(a).catch(() => {}); }); },
    stop() { stop?.(); stop = null; },
    statusOf: (id) => state[id]?.status ?? "syncing",
    lastSyncOf: (id) => state[id]?.last_sync_at ?? null,
    /** An account signed in again (or newly added): its strikes forgotten, its cursors kept. */
    reset(id, status = "syncing") { put(id, { status, strikes: 0 }); },
    forget(id) { const { [id]: _gone, ...rest } = state; state = rest; o.saveState(state); },
  };
}
