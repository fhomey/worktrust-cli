/**
 * THE LOCAL MAIL INDEX (docs/remote-agents/MAIL.md §The local index). One row per message, on this computer only, mode
 * 0600, in ~/.worktrust/remote/mail/. Two stores behind one interface:
 *
 *   sqlite   node:sqlite with an FTS5 trigram table, when this Node has both (22.13 and later; probed, never assumed)
 *   json     the documented fallback: index.json, the same rows, searched by a lower-cased substring over subject, sender
 *            and text, the newest MAIL_KEEP_PER_ACCOUNT messages per account
 *
 * Listing, threads and unread counts are the same code over the rows either store returns. Nothing here leaves the computer
 * except what a phone asks for, sealed by the daemon. A row holds no secret.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { snippetOf } from "./remote-mail-text.mjs";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";

export const MAIL_KEEP_PER_ACCOUNT = 5_000;

/** The sqlite store, or null when this Node has no node:sqlite or its SQLite has no FTS5. */
async function openSqlite(file) {
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { return null; }
  if (typeof sqlite?.DatabaseSync !== "function") return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, account_id TEXT NOT NULL, row TEXT NOT NULL)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(subject, sender, body, tokenize='trigram')");
  } catch { try { db?.close(); } catch { /* none */ } return null; }
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  const upsert = db.prepare("INSERT INTO messages (message_id, account_id, row) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET row = excluded.row RETURNING id");
  const ftsDel = db.prepare("DELETE FROM msg_fts WHERE rowid = ?"), ftsIns = db.prepare("INSERT INTO msg_fts (rowid, subject, sender, body) VALUES (?, ?, ?, ?)");
  return {
    kind: "sqlite",
    put(row) {
      const { id } = upsert.get(row.message_id, row.account_id, JSON.stringify(row));
      ftsDel.run(id); ftsIns.run(id, row.subject, `${row.from_name ?? ""} ${row.from_address}`, row.text);
    },
    all: (account) => (account ? db.prepare("SELECT row FROM messages WHERE account_id = ?").all(account) : db.prepare("SELECT row FROM messages").all()).map((r) => JSON.parse(r.row)),
    search(query) {
      const q = query.trim();
      if (q.length < 3) return null; // the trigram tokenizer needs three characters: the shared substring match decides
      const ids = db.prepare("SELECT m.message_id AS id FROM msg_fts f JOIN messages m ON m.id = f.rowid WHERE msg_fts MATCH ?").all(`"${q.replace(/"/g, '""')}"`);
      return new Set(ids.map((r) => r.id));
    },
    remove(account) { for (const r of db.prepare("SELECT id FROM messages WHERE account_id = ?").all(account)) ftsDel.run(r.id); db.prepare("DELETE FROM messages WHERE account_id = ?").run(account); },
    flush() {},
    close() { db.close(); },
  };
}

function openJson(file) {
  let rows = new Map();
  try { if (existsSync(file)) for (const r of JSON.parse(readMailFile(file)).rows ?? []) rows.set(r.message_id, r); } catch { rows = new Map(); }
  let held = 0; // puts not yet written: a batch (putMany) writes once
  const save = () => { const counts = {}; for (const r of rows.values()) counts[r.account_id] = (counts[r.account_id] ?? 0) + 1;
    for (const [account, n] of Object.entries(counts)) if (n > MAIL_KEEP_PER_ACCOUNT) for (const r of [...rows.values()].filter((x) => x.account_id === account).sort((a, b) => a.date - b.date).slice(0, n - MAIL_KEEP_PER_ACCOUNT)) rows.delete(r.message_id);
    writeMailFile(file, JSON.stringify({ v: 1, rows: [...rows.values()] })); };
  return {
    kind: "json",
    put(row, { batch = false } = {}) { rows.set(row.message_id, row); if (batch) held += 1; else save(); },
    flush() { if (held > 0) { held = 0; save(); } },
    all: (account) => [...rows.values()].filter((r) => !account || r.account_id === account),
    search: () => null,
    remove(account) { for (const [k, r] of rows) if (r.account_id === account) rows.delete(k); save(); },
    close() {},
  };
}

const matches = (row, q) => `${row.subject}\n${row.from_name ?? ""} ${row.from_address}\n${row.text}`.toLowerCase().includes(q.toLowerCase());
const cursorOf = (row) => `${row.date}.${row.thread_id}`;
const before = (row, cursor) => { const [date, id] = [Number(cursor.split(".")[0]), cursor.slice(cursor.indexOf(".") + 1)]; return row.date < date || (row.date === date && row.thread_id < id); };

/**
 * Open the index in `dir`. `{ fallback: true }` forces the json store (the tests run both). → the store and:
 *   put(row)  a normalised message (remote-mail-sync.mjs) keyed by its derived message_id; flags a person changed locally win
 */
export async function openMailIndex(dir, { fallback = false } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = (!fallback && (await openSqlite(join(dir, "index.sqlite")))) || openJson(join(dir, "index.json"));
  const threadsOf = (rows) => {
    const by = new Map();
    for (const r of rows) { const t = by.get(r.thread_id) ?? []; t.push(r); by.set(r.thread_id, t); }
    return by;
  };
  const rowOf = (msgs) => {
    const sorted = [...msgs].sort((a, b) => b.date - a.date), top = sorted.find((m) => m.folder === "inbox") ?? sorted[0];
    return {
      thread_id: top.thread_id, account_id: top.account_id, from_name: top.from_name ?? null, from_address: top.from_address, subject: top.subject.slice(0, P.MAIL_SUBJECT_MAX),
      snippet: snippetOf(sorted[0].text, P.MAIL_SNIPPET_MAX), received_at: sorted[0].date, unread: msgs.some((m) => m.unread), starred: msgs.some((m) => m.starred),
      has_attachments: msgs.some((m) => m.attachments.length > 0), labels: [...new Set(msgs.flatMap((m) => m.labels))].slice(0, P.MAIL_LABELS_MAX),
    };
  };
  const unread = (rows) => { const n = {}; for (const [, msgs] of threadsOf(rows)) if (msgs.some((m) => m.unread && !m.labels.includes("archived"))) n[msgs[0].account_id] = (n[msgs[0].account_id] ?? 0) + 1; return n; };
  const putOne = (row, batch) => {
    const held = store.all(row.account_id).find((r) => r.message_id === row.message_id);
    store.put(held?.local ? { ...row, unread: held.unread, starred: held.starred, labels: held.labels, local: held.local } : row, { batch });
  };
  return {
    kind: store.kind,
    put(row) { putOne(row, false); },
    /** A sync's rows, written once (the JSON store writes its file once per batch). */
    putMany(rows) { for (const row of rows) putOne(row, true); store.flush(); },
    rows: (account) => store.all(account),
    /** One page of threads, newest first: `account` (null: every one), `query`, `label`, `cursor`, `limit`. */
    list({ account = null, query = null, label = null, cursor = null, limit = P.MAIL_LIST_DEFAULT }) {
      let rows = store.all(account);
      if (query) { const hits = store.search(query); rows = rows.filter((r) => (hits ? hits.has(r.message_id) : matches(r, query))); }
      const threads = [...threadsOf(rows).values()].map((msgs) => ({ row: rowOf(msgs), msgs }))
        .filter((t) => (label ? t.row.labels.includes(label) : !t.row.labels.includes("archived")))
        .map((t) => ({ ...t.row, date: t.row.received_at })).sort((a, b) => b.date - a.date || (a.thread_id < b.thread_id ? 1 : -1));
      const after = cursor ? threads.filter((t) => before(t, cursor)) : threads;
      const page = after.slice(0, limit), more = after.length > limit;
      const counts = unread(store.all(account));
      return { items: page.map(({ date: _d, ...item }) => item), next_cursor: more ? cursorOf(page.at(-1)) : null, unread_by_account: Object.entries(counts).map(([account_id, n]) => ({ account_id, unread: n })), total_unread: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
    /** A thread's messages, oldest first. */
    thread: (threadId) => store.all(null).filter((r) => r.thread_id === threadId).sort((a, b) => a.date - b.date),
    /** A local change of read or starred, marked `local` so the next sync does not turn it back (rule 10: local pending wins). */
    flag(threadId, { read, starred, addLabel, archive }) {
      const msgs = store.all(null).filter((r) => r.thread_id === threadId);
      for (const m of msgs) store.put({ ...m, ...(read === undefined ? {} : { unread: !read }), ...(starred === undefined ? {} : { starred }), labels: [...new Set([...m.labels, ...(addLabel ? [addLabel] : []), ...(archive ? ["archived"] : [])])], local: true });
      return msgs.length;
    },
    /** The provider took the change: the next sync's flags count again. */
    settle(threadId) { for (const m of store.all(null).filter((r) => r.thread_id === threadId && r.local)) { const { local: _l, ...rest } = m; store.put(rest); } },
    unreadByAccount: () => unread(store.all(null)),
    /** The person's own earlier mails to `address` (voice samples, rule 6), newest first. */
    sentTo: (account, address, n = 2) => store.all(account).filter((r) => r.folder === "sent" && r.to.some((t) => t.address === address)).sort((a, b) => b.date - a.date).slice(0, n),
    removeAccount: (account) => store.remove(account),
    close: () => store.close(),
  };
}
