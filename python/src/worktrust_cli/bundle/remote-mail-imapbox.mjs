/**
 * AN APP-PASSWORD MAILBOX: GMAIL, ICLOUD, YAHOO OR ANY IMAP + SMTP SERVER (docs/remote-agents/MAIL.md §Providers). The
 * transport the sync engine (remote-mail-sync.mjs), the thread view and the outbox use, on remote-mail-imap.mjs,
 * remote-mail-smtp.mjs and remote-mail-mime.mjs.
 *
 *   presets   gmail imap.gmail.com 993 / smtp.gmail.com 465; icloud imap.mail.me.com 993 / smtp.mail.me.com 587 STARTTLS
 *             (polled: no IDLE); yahoo imap.mail.yahoo.com 993 / smtp.mail.yahoo.com 465; imap: the hosts the person gave
 *             (a cPanel / Dovecot server such as Vimexx: LOGIN, often no SPECIAL-USE)
 *   folders   INBOX and Sent: Sent by its \Sent flag (SPECIAL-USE), else the first of the usual names that exists
 *   reading   UID SEARCH SINCE for the baseline (30 days, the newest MAIL_BASELINE), UID n:* after it; UID FETCH of FLAGS,
 *             INTERNALDATE, RFC822.SIZE, ENVELOPE, BODYSTRUCTURE and the first MAIL_FETCH_CAP bytes (BODY.PEEK[]: never
 *             marks read); a cut message says so (`text_is_preview`) and the thread view fetches it again up to 1 MiB
 *   sending   one SMTP connection per message, then APPEND to Sent where the server does not keep a copy itself (Gmail
 *             does). The APPEND failing never turns a sent message into a failed one.
 *   watching  IDLE where advertised (renewed every four minutes with a NOOP between, so a half-dead socket fails its
 *             timeout), polling otherwise
 * `connect` maps a server to where a test dials and which CA it trusts (code only, never the environment).
 */
import * as P from "./remote-protocol.mjs";
import { ImapError, openImap } from "./remote-mail-imap.mjs";
import { sendSmtp, verifySmtp } from "./remote-mail-smtp.mjs";
import { readMessage, writeMessage } from "./remote-mail-mime.mjs";
import { decodeWords } from "./remote-mail-text.mjs";

export const MAIL_FETCH_CAP = 65_536, MAIL_BODY_CAP = 1_048_576, IDLE_MS = 4 * 60_000;
export const IMAP_PRESETS = Object.freeze({
  gmail: { imap: { host: "imap.gmail.com", port: 993, tls: "tls" }, smtp: { host: "smtp.gmail.com", port: 465, tls: "tls" }, appendSent: false, idle: true },
  icloud: { imap: { host: "imap.mail.me.com", port: 993, tls: "tls" }, smtp: { host: "smtp.mail.me.com", port: 587, tls: "starttls" }, appendSent: true, idle: false },
  yahoo: { imap: { host: "imap.mail.yahoo.com", port: 993, tls: "tls" }, smtp: { host: "smtp.mail.yahoo.com", port: 465, tls: "tls" }, appendSent: true, idle: true },
});
export const SENT_NAMES = Object.freeze(["Sent", "INBOX.Sent", "INBOX/Sent", "Sent Items", "Sent Messages", "Sent Mail", "[Gmail]/Sent Mail", "Verzonden items", "INBOX.Sent Items"]);
export const serversOf = (a) => (IMAP_PRESETS[a.provider] ?? { imap: a.imap, smtp: a.smtp, appendSent: true, idle: true });

const str = (t) => (Buffer.isBuffer(t) ? t.toString("utf8") : t == null ? null : String(t));
const pairs = (list) => { const o = {}; if (Array.isArray(list)) for (let i = 0; i + 1 < list.length; i += 2) o[String(str(list[i])).toLowerCase()] = str(list[i + 1]); return o; };
/** An RFC 2231 value ("UTF-8''r%C3%A9sum%C3%A9.pdf") as text, or null. */
const ext = (v) => { const m = /^([^']*)'[^']*'(.*)$/.exec(v ?? ""); if (!m) return null; try { return new TextDecoder(m[1] || "utf-8").decode(Buffer.from(m[2].replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1")); } catch { return null; } };
/** The parts of a BODYSTRUCTURE that are attachments: name, size (decoded estimate) and type. Nothing is fetched or opened. */
export function attachmentsOf(bs) {
  const out = [];
  const walk = (p, depth) => {
    if (!Array.isArray(p) || depth > 12) return;
    if (Array.isArray(p[0])) { for (const c of p) if (Array.isArray(c)) walk(c, depth + 1); return; }
    const type = `${str(p[0])}/${str(p[1])}`.toLowerCase(), params = pairs(p[2]), text = type.startsWith("text/");
    const disp = text ? p[9] : type === "message/rfc822" ? p[11] : p[8];
    const dp = Array.isArray(disp) ? pairs(disp[1]) : {}, kind = Array.isArray(disp) ? String(str(disp[0])).toLowerCase() : null;
    const name = dp.filename ?? ext(dp["filename*"]) ?? params.name ?? ext(params["name*"]) ?? null;
    if (kind === "attachment" || (name && !text) || (!text && type !== "message/rfc822")) {
      const size = Number(str(p[6])) || 0;
      out.push({ name: decodeWords(name ?? "attachment").slice(0, 255) || "attachment", size: String(str(p[5])).toLowerCase() === "base64" ? Math.floor(size * 3 / 4) : size, mime: type.slice(0, 127) });
    }
  };
  walk(bs, 0);
  return out.slice(0, P.MAIL_ATTACHMENTS_MAX);
}
const imapDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const ITEMS = (cap) => `UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE BODY.PEEK[]<0.${cap}>`;

/** A fetched message as the sync engine's normalised message. */
export function normaliseImap(f, folder, role, uidvalidity, cap = MAIL_FETCH_CAP) {
  const m = readMessage(f.body ?? Buffer.alloc(0), { truncated: (f.size ?? 0) > cap });
  const fromBs = f.bodystructure ? attachmentsOf(f.bodystructure) : null;
  return {
    uid: f.uid, uidvalidity, folder: role, remote_ref: `${folder}\n${uidvalidity}\n${f.uid}`, header_message_id: m.message_id, references: m.references, in_reply_to: m.in_reply_to,
    from: m.from ?? { name: null, address: "unknown@unknown.invalid" }, to: m.to, cc: m.cc, reply_to: m.reply_to, date: m.date ?? f.internaldate ?? 0, subject: m.subject, text: m.text,
    text_is_preview: m.truncated, unread: !(f.flags ?? []).includes("\\Seen"), starred: (f.flags ?? []).includes("\\Flagged"), attachments: fromBs ?? m.attachments, labels: [],
  };
}

/**
 * account: the vault's record (provider, address, secret, imap?, smtp?). connect(server) → { connectHost, servername, ca } or {}
 * (tests only). → the transport: begin() / end() around a sync, status, latest, since, body, setFlags, send, verify, watch.
 */
export function createImapMailbox({ account, connect = () => ({}), now = Date.now, credentials = () => ({ user: account.address, pass: account.secret }) }) {
  const servers = serversOf(account);
  const open = async () => {
    const s = servers.imap, c = await openImap({ host: s.host, port: s.port, security: s.tls, ...connect(s) });
    try { const { user, pass } = credentials(); await c.login(user, pass); } catch (e) { c.close(); throw e; }
    return c;
  };
  let conn = null, uidv = new Map();
  const sentOf = async (c) => {
    const boxes = await c.list();
    return boxes.find((b) => b.flags.some((f) => f.toLowerCase() === "\\sent"))?.name ?? SENT_NAMES.find((n) => boxes.some((b) => b.name === n)) ?? null;
  };
  const fetch = async (c, folder, role, uids, cap) => {
    if (uids.length === 0) return [];
    const got = await c.uidFetch(uids.join(","), ITEMS(cap), { ms: 120_000 });
    return got.map((f) => normaliseImap(f, folder, role, uidv.get(folder), cap));
  };
  return {
    kind: "imap",
    /** Open for one sync: → [[folder, role]] (INBOX, and Sent when there is one). */
    async begin() { conn = await open(); const sent = await sentOf(conn); return [["INBOX", "inbox"], ...(sent ? [[sent, "sent"]] : [])]; },
    async end() { await conn?.logout(); conn = null; },
    async status(folder) { const s = await conn.select(folder); uidv.set(folder, s.uidvalidity); return { uidvalidity: s.uidvalidity, uidnext: s.uidnext ?? 1 }; },
    async latest(folder, n) {
      const role = folder === "INBOX" ? "inbox" : "sent";
      const uids = (await conn.uidSearch(`SINCE ${imapDate(now() - 30 * 86400_000)}`)).slice(-n);
      return fetch(conn, folder, role, uids, MAIL_FETCH_CAP);
    },
    async since(folder, uid, n) {
      const role = folder === "INBOX" ? "inbox" : "sent";
      const uids = (await conn.uidSearch(`UID ${Math.max(1, Math.trunc(uid))}:*`)).filter((u) => u >= uid).slice(0, n);
      return fetch(conn, folder, role, uids, MAIL_FETCH_CAP);
    },
    /** The whole text of one message (up to MAIL_BODY_CAP), or null when the folder was re-keyed or it is gone. */
    async body(ref) {
      const [folder, validity, uid] = String(ref).split("\n"), c = await open();
      try {
        const s = await c.select(folder);
        if (String(s.uidvalidity) !== validity) return null;
        const [f] = await c.uidFetch(String(Number(uid)), `UID RFC822.SIZE BODY.PEEK[]<0.${MAIL_BODY_CAP}>`, { ms: 120_000 });
        return f?.body ? readMessage(f.body).text : null;
      } finally { await c.logout(); }
    },
    async setFlags(ref, { read, starred }) {
      const [folder, validity, uid] = String(ref).split("\n"), c = await open();
      try {
        const s = await c.select(folder, { readOnly: false });
        if (String(s.uidvalidity) !== validity) return false;
        if (read !== undefined) await c.uidStore(uid, read ? "+" : "-", ["\\Seen"]);
        if (starred !== undefined) await c.uidStore(uid, starred ? "+" : "-", ["\\Flagged"]);
        return true;
      } catch { return false; } finally { await c.logout(); }
    },
    /** AFTER the phone's approval only (the outbox). `target`: the index row replied to or forwarded, or null. */
    async send(held, target, files = []) {
      const d = held.draft;
      const { raw } = writeMessage({ from: { name: account.display_name ?? null, address: account.address }, to: d.to, cc: d.cc, subject: d.subject, body: d.body, format: d.format, attachments: files,
        in_reply_to: d.mode === "reply" || d.mode === "reply_all" ? target?.header_message_id ?? null : null, references: d.mode === "new" ? [] : [...(target?.references ?? []), ...(target?.header_message_id ? [target.header_message_id] : [])], date: now() });
      const s = servers.smtp, { user, pass } = credentials(), sent = await sendSmtp({ host: s.host, port: s.port, security: s.tls, user, pass, from: account.address, rcpt: [...d.to, ...d.cc, ...d.bcc], raw, ...connect(s) });
      if (sent.ok && servers.appendSent) { try { const c = await open(); try { const box = await sentOf(c); if (box) await c.append(box, ["\\Seen"], raw); } finally { await c.logout(); } } catch { /* the copy in Sent is a convenience; the message went */ } }
      return sent;
    },
    /** Adding the account: IMAP sign-in and folders, then SMTP sign-in. → { ok } or { ok: false, code }. */
    async verify() {
      try { const c = await open(); try { await c.list(); } finally { await c.logout(); } } catch (e) { return { ok: false, code: e instanceof ImapError ? e.code : "unreachable" }; }
      const s = servers.smtp, { user, pass } = credentials(), v = await verifySmtp({ host: s.host, port: s.port, security: s.tls, user, pass, ...connect(s) });
      return v.ok ? { ok: true } : { ok: false, code: v.code };
    },
    /** IDLE on INBOX until `stopped()`; `onNew()` on new mail. → "unsupported" at once when the server has no IDLE (poll). */
    async watch({ onNew, stopped, hold = () => {}, pause = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); }) }) {
      if (servers.idle === false) return "unsupported";
      let failures = 0;
      while (!stopped()) {
        let c = null;
        try {
          c = await open(); hold(c);
          if (!c.capabilities.has("IDLE")) return "unsupported";
          await c.select("INBOX");
          failures = 0;
          while (!stopped()) { const r = await c.idle(IDLE_MS); if (r === "exists") onNew(); await c.noop(); }
        } catch (e) {
          if (e?.code === "auth_failed" || e?.code === "app_password_needed") return "auth_failed";
          if (stopped()) break;
          failures += 1;
          await pause(Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6)));
        } finally { c?.close(); }
      }
      return "stopped";
    },
  };
}
