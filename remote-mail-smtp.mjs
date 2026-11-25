/**
 * A MINIMAL SMTP SUBMISSION CLIENT, NO DEPENDENCY (docs/remote-agents/MAIL.md §Providers, §The outbox; owner decision
 * 2026-11-24). ONE MESSAGE PER CONNECTION, called only by the outbox after the phone's approval matched.
 *
 *   wire      465 implicit TLS or 587 STARTTLS; certificates ALWAYS verified (no option turns it off): a self-signed or
 *             mismatched server is `untrusted_certificate`. A test hands its CA in through code (`ca`).
 *   dialogue  EHLO, STARTTLS and EHLO again, AUTH PLAIN (else LOGIN), MAIL FROM (SMTPUTF8 when an address is not ASCII and
 *             the server offers it; BODY=8BITMIME offered only when the message has 8-bit bytes), RCPT TO each recipient, DATA
 *             with dot-stuffing and CRLF line ends, QUIT. Every reply has a hard timeout.
 *   outcome   { ok: true } only on 250 after the final dot. A 5xx or 4xx at RCPT or DATA is `rejected`; a 535 `auth_failed`
 *             (`app_password_needed` where Gmail says so); a connection lost after DATA began `interrupted`; one that never
 *             opened `unreachable`. The caller NEVER sends again by itself.
 * `verify` (adding an account) goes as far as AUTH and QUITs: nothing is sent.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tlsCode } from "./remote-mail-imap.mjs";

export const SMTP_TIMEOUT_MS = 60_000;
class SmtpError extends Error { constructor(code, reply = "") { super(code); this.code = code; this.reply = reply; } }

/** "a.b\r\n.x" → every line that starts with a dot gets a second one; bare LF and CR become CRLF; the terminator is added. */
export function dotStuff(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const body = text.replace(/\r\n|\r|\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
  return `${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

async function session({ host, port, security, connectHost = host, servername = host, ca, timeoutMs = SMTP_TIMEOUT_MS }) {
  let socket = null, buf = "", waiter = null, closed = false;
  const replies = [];
  const feed = (chunk) => {
    buf += chunk.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) continue;
      const last = replies.at(-1);
      if (last && !last.done && last.code === Number(m[1])) last.lines.push(m[3]); else replies.push({ code: Number(m[1]), lines: [m[3]], done: false });
      if (m[2] !== "-") replies.at(-1).done = true;
    }
    if (waiter && replies[0]?.done) { const w = waiter; waiter = null; w(); }
  };
  const reply = (ms = timeoutMs) => new Promise((resolve, reject) => {
    if (replies[0]?.done) return resolve(replies.shift());
    if (closed) return reject(new SmtpError("closed"));
    const timer = setTimeout(() => { waiter = null; socket.destroy(); reject(new SmtpError("timeout")); }, ms);
    waiter = () => { clearTimeout(timer); if (replies[0]?.done) resolve(replies.shift()); else reject(new SmtpError("closed")); };
  });
  const attach = (s) => { socket = s; s.on("data", feed); s.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(); } }); s.on("error", () => {}); };
  const dial = (make, secure) => new Promise((resolve, reject) => {
    const s = make();
    const timer = setTimeout(() => { s.destroy(); reject(new SmtpError("unreachable")); }, timeoutMs);
    s.once(secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e) => { clearTimeout(timer); reject(new SmtpError(tlsCode(e))); });
  });
  const tlsOpts = { servername, ca, minVersion: "TLSv1.2" }; // rejectUnauthorized stays true
  try { return await setup(); } catch (e) { socket?.destroy(); throw e; } // a session that failed to open is never left open
  async function setup() {
  attach(await dial(() => (security === "tls" ? tlsConnect({ host: connectHost, port, ...tlsOpts }) : netConnect({ host: connectHost, port })), security === "tls"));
  const say = async (line, want, ms) => { if (line !== null) socket.write(`${line}\r\n`); const r = await reply(ms); if (!want.includes(Math.floor(r.code / 100) * 100) && !want.includes(r.code)) throw new SmtpError(r.code === 535 || r.code === 534 ? (/application-specific|app password/i.test(r.lines.join(" ")) ? "app_password_needed" : "auth_failed") : r.code === 530 ? "auth_failed" : "rejected", `${r.code}`); return r; };
  await say(null, [200], timeoutMs);
  const name = "worktrust.local";
  let ext = new Set((await say(`EHLO ${name}`, [200])).lines.slice(1).map((l) => l.toUpperCase()));
  if (security === "starttls") {
    if (!ext.has("STARTTLS")) throw new SmtpError("unsupported");
    await say("STARTTLS", [200]);
    socket.removeAllListeners("data");
    const plain = socket;
    attach(await dial(() => tlsConnect({ socket: plain, ...tlsOpts }), true));
    ext = new Set((await say(`EHLO ${name}`, [200])).lines.slice(1).map((l) => l.toUpperCase()));
  }
  const auth = [...ext].find((l) => l.startsWith("AUTH ") || l.startsWith("AUTH="))?.slice(5).split(/\s+/) ?? [];
  return { socket, say, ext, auth, close: () => socket.destroy(), get closed() { return closed; } };
  }
}

async function login(s, user, pass) {
  if (s.auth.includes("PLAIN")) return s.say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64")}`, [235]);
  if (s.auth.includes("LOGIN")) { await s.say("AUTH LOGIN", [334]); await s.say(Buffer.from(user, "utf8").toString("base64"), [334]); return s.say(Buffer.from(pass, "utf8").toString("base64"), [235]); }
  throw new SmtpError("unsupported");
}

/** Adding an account: connect, (STARTTLS), AUTH, QUIT. → { ok } or { ok: false, code }. */
export async function verifySmtp(o) {
  let s = null;
  try { s = await session(o); await login(s, o.user, o.pass); await s.say("QUIT", [200]).catch(() => {}); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code ?? "unreachable" }; } finally { s?.close(); }
}

/**
 * ONE MESSAGE. o: { host, port, security, user, pass, from, rcpt: [addresses], raw (the MIME message), ca?, connectHost?, servername? }.
 * → { ok: true } or { ok: false, code } (MAIL_SEND_FAILURES). Never retried here, never retried by the caller.
 */
export async function sendSmtp(o) {
  let s = null, dataBegun = false;
  try {
    s = await session(o);
    await login(s, o.user, o.pass);
    const raw = Buffer.isBuffer(o.raw) ? o.raw : Buffer.from(o.raw, "utf8");
    const wide = [o.from, ...o.rcpt].some((a) => !/^[\x20-\x7e]*$/.test(a));
    if (wide && !s.ext.has("SMTPUTF8")) return { ok: false, code: "rejected" };
    const eight = raw.some((b) => b > 0x7f);
    await s.say(`MAIL FROM:<${o.from}>${eight && s.ext.has("8BITMIME") ? " BODY=8BITMIME" : ""}${wide ? " SMTPUTF8" : ""}`, [250]);
    for (const r of o.rcpt) await s.say(`RCPT TO:<${r}>`, [250, 251]);
    await s.say("DATA", [354]);
    dataBegun = true;
    s.socket.write(dotStuff(raw));
    await s.say(null, [250], o.timeoutMs ?? SMTP_TIMEOUT_MS);
    await s.say("QUIT", [200]).catch(() => {});
    return { ok: true };
  } catch (e) {
    const code = e.code === "timeout" || e.code === "closed" ? (dataBegun ? "interrupted" : "unreachable") : e.code ?? "rejected";
    return { ok: false, code: ["untrusted_certificate", "auth_failed", "app_password_needed", "rejected", "interrupted", "unreachable"].includes(code) ? (code === "app_password_needed" ? "auth_failed" : code) : "rejected" };
  } finally { s?.close(); }
}
