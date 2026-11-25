/**
 * A MINIMAL IMAP4rev1 CLIENT, NO DEPENDENCY (docs/remote-agents/MAIL.md §Providers; owner decision 2026-11-24).
 *
 *   wire      over TLS (993) or STARTTLS (143), certificates ALWAYS verified: there is no option that turns that off, and a
 *             self-signed or mismatched server fails `untrusted_certificate`. A test hands its own CA in through code (`ca`).
 *   parse     responses with literals `{n}` and LITERAL+ `{n+}` read by byte count, across any split of the TCP stream; atoms,
 *             quoted strings, NIL and nested lists; a status response keeps its line and its [CODE]
 *   commands  CAPABILITY, LOGIN or AUTHENTICATE PLAIN (SASL-IR where offered), LIST (SPECIAL-USE flags read when the server
 *             sends them), SELECT / EXAMINE, UID SEARCH, UID FETCH, UID STORE, APPEND (a literal, synchronising unless
 *             LITERAL+), IDLE and DONE, NOOP, LOGOUT; EVERY command has a hard timeout, after which the socket is closed
 *   errors    ImapError { code }: auth_failed, app_password_needed (Gmail's "application-specific password required"),
 *             untrusted_certificate, unreachable, timeout, closed, rejected (NO / BAD), unsupported
 * Nothing here logs a word of mail or a password; a caller logs codes.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export class ImapError extends Error { constructor(code, detail = "") { super(code); this.code = code; this.detail = detail; } }
export const IMAP_TIMEOUT_MS = 30_000;
const CERT = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME|UNABLE_TO_GET_ISSUER|HOSTNAME_MISMATCH/;
export const tlsCode = (error) => (CERT.test(String(error?.code ?? "")) || CERT.test(String(error?.message ?? "")) ? "untrusted_certificate" : "unreachable");

/**
 * One response from `buf` at `at`, or null while bytes are missing. → { value: tokens | { status line }, end }.
 * Literals are taken by their byte count, so a CRLF or a brace inside one is data.
 */
export function parseResponse(buf, at = 0) {
  const tokens = [], stack = [tokens];
  let i = at;
  const top = () => stack[stack.length - 1];
  const lineEnd = buf.indexOf("\r\n", i);
  if (lineEnd < 0) return null;
  const head = buf.toString("latin1", i, Math.min(lineEnd, i + 40));
  const st = /^(\S+) (OK|NO|BAD|BYE|PREAUTH)(?: |$)/i.exec(head);
  if (st && !buf.toString("latin1", i, lineEnd).includes("{")) {
    const line = buf.toString("utf8", i, lineEnd), code = /\[([^\]]*)\]/.exec(line);
    return { value: { tag: st[1], status: st[2].toUpperCase(), line, code: code ? code[1] : null }, end: lineEnd + 2 };
  }
  while (i < buf.length) {
    const c = buf[i];
    if (c === 0x0d && buf[i + 1] === 0x0a) { if (stack.length === 1) return { value: tokens, end: i + 2 }; i += 2; continue; }
    if (c === 0x0d || c === 0x0a) { if (i + 1 >= buf.length) return null; i += 1; continue; }
    if (c === 0x20) { i += 1; continue; }
    if (c === 0x28) { const l = []; top().push(l); stack.push(l); i += 1; continue; }
    if (c === 0x29) { if (stack.length > 1) stack.pop(); i += 1; continue; }
    if (c === 0x22) {
      let j = i + 1, s = "";
      for (; j < buf.length && buf[j] !== 0x22; j += 1) { if (buf[j] === 0x5c) j += 1; s += String.fromCharCode(buf[j]); }
      if (j >= buf.length) return null;
      top().push(Buffer.from(s, "latin1").toString("utf8")); i = j + 1; continue;
    }
    if (c === 0x7b) {
      const close = buf.indexOf("}", i), m = close > 0 ? /^\{(\d+)\+?\}$/.exec(buf.toString("latin1", i, close + 1)) : null;
      if (!m) { if (close < 0) return null; top().push(buf.toString("latin1", i, close + 1)); i = close + 1; continue; }
      const n = Number(m[1]), start = close + 3;
      if (buf.length < start + n) return null;
      top().push(Buffer.from(buf.subarray(start, start + n))); i = start + n; continue;
    }
    let j = i, depth = 0;
    while (j < buf.length) { const d = buf[j]; if (d === 0x5b) depth += 1; else if (d === 0x5d) depth -= 1; else if (depth <= 0 && (d === 0x20 || d === 0x28 || d === 0x29 || d === 0x0d)) break; j += 1; }
    if (j >= buf.length) return null;
    const atom = buf.toString("utf8", i, j);
    top().push(atom.toUpperCase() === "NIL" ? null : atom); i = j;
  }
  return null;
}

/** A string as an IMAP quoted string; anything that is not printable ASCII is refused (a caller uses AUTHENTICATE). */
export const quote = (s) => { if (!/^[\x20-\x7e]*$/.test(String(s))) throw new ImapError("unsupported", "non-ASCII"); return `"${String(s).replace(/(["\\])/g, "\\$1")}"`; };
const str = (t) => (Buffer.isBuffer(t) ? t.toString("utf8") : t == null ? null : String(t));
const flagsOf = (list) => (Array.isArray(list) ? list.map(String) : []);

/**
 * Open a connection. `connectHost`: where to dial (a test's 127.0.0.1); `servername`: the name the certificate must carry
 * (the provider's host). → the client, once the greeting and CAPABILITY are read.
 */
export async function openImap({ host, port = 993, security = "tls", connectHost = host, servername = host, ca, timeoutMs = IMAP_TIMEOUT_MS }) {
  let socket = null, buf = Buffer.alloc(0), waiter = null, closed = null, seq = 0;
  const queue = [];
  const feed = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) { const r = parseResponse(buf, 0); if (!r) break; buf = buf.subarray(r.end); queue.push(r.value); }
    if (waiter && queue.length) { const w = waiter; waiter = null; w(); }
  };
  /** The next response within `ms`; past it the socket is closed (`timeout`), or with `soft` null is given and it stays open (IDLE). */
  const next = (ms, soft = false) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    if (closed) return reject(new ImapError(closed));
    const timer = setTimeout(() => { waiter = null; if (soft) return resolve(null); socket?.destroy(); closed = "timeout"; reject(new ImapError("timeout")); }, ms);
    waiter = () => { clearTimeout(timer); if (queue.length) resolve(queue.shift()); else reject(new ImapError(closed ?? "closed")); };
  });
  const attach = (s) => { socket = s; s.on("data", feed); s.on("close", () => { closed ??= "closed"; if (waiter) { const w = waiter; waiter = null; w(); } }); s.on("error", () => {}); };
  const dial = (make) => new Promise((resolve, reject) => {
    const s = make();
    const timer = setTimeout(() => { s.destroy(); reject(new ImapError("unreachable", "connect timeout")); }, timeoutMs);
    s.once(security === "tls" || s.encrypted ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e) => { clearTimeout(timer); reject(new ImapError(tlsCode(e), e?.code ?? "")); });
  });
  const tlsOpts = { servername, ca, minVersion: "TLSv1.2" }; // rejectUnauthorized stays its default: true
  try { return await setup(); } catch (e) { socket?.destroy(); throw e; } // a connection that failed to open is never left open
  async function setup() {
  if (security === "tls") attach(await dial(() => tlsConnect({ host: connectHost, port, ...tlsOpts })));
  else attach(await dial(() => netConnect({ host: connectHost, port })));
  const greeting = await next(timeoutMs);
  if (greeting?.status === "BYE") throw new ImapError("unreachable", "BYE");

  /** One command: its untagged responses and its tagged status. `literal`: bytes sent after a continuation. */
  async function run(command, { literal = null, ms = timeoutMs, untagged = null } = {}) {
    const tag = `W${(seq += 1).toString(36)}`;
    const plus = literal && caps.has("LITERAL+");
    socket.write(literal ? `${tag} ${command} {${literal.length}${plus ? "+" : ""}}\r\n` : `${tag} ${command}\r\n`);
    if (literal && plus) socket.write(Buffer.concat([literal, Buffer.from("\r\n")]));
    const got = [];
    for (;;) {
      let r = await next(ms);
      if (Array.isArray(r) && r[0] === "+") { if (literal && !plus) socket.write(Buffer.concat([literal, Buffer.from("\r\n")])); continue; }
      if (Array.isArray(r) && r[0] === tag) r = { tag, status: String(r[1]).toUpperCase(), line: r.map(String).join(" "), code: null };
      if (!Array.isArray(r) && r.tag === tag) {
        if (r.status === "OK") return { status: r, untagged: got };
        throw new ImapError(/application-specific password|app password|ALERT\].*password/i.test(r.line) ? "app_password_needed" : /AUTHENTICATIONFAILED|AUTH|LOGIN|credentials|password|invalid user/i.test(r.line) ? "auth_failed" : "rejected", r.code ?? "");
      }
      if (!Array.isArray(r) && r.status === "BYE") { closed = "closed"; throw new ImapError("closed"); }
      untagged?.(r); got.push(r);
    }
  }
  let caps = new Set();
  const readCaps = (list) => { for (const r of list) if (Array.isArray(r) && String(r[1]).toUpperCase() === "CAPABILITY") caps = new Set(r.slice(2).map((c) => String(c).toUpperCase())); };
  const askCaps = async () => readCaps((await run("CAPABILITY")).untagged);
  await askCaps();
  if (security === "starttls") {
    if (!caps.has("STARTTLS")) throw new ImapError("unsupported", "no STARTTLS");
    await run("STARTTLS");
    socket.removeAllListeners("data");
    const plain = socket;
    attach(await dial(() => tlsConnect({ socket: plain, ...tlsOpts })));
    await askCaps();
  }
  let selected = null;
  const client = {
    get capabilities() { return caps; },
    /** AUTHENTICATE PLAIN where offered (any characters), else LOGIN with quoted strings. */
    async login(user, pass) {
      if (caps.has("AUTH=PLAIN")) {
        const b64 = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
        if (caps.has("SASL-IR")) await run(`AUTHENTICATE PLAIN ${b64}`);
        else { const tag = `W${(seq += 1).toString(36)}`; socket.write(`${tag} AUTHENTICATE PLAIN\r\n`); for (;;) { const r = await next(timeoutMs); if (Array.isArray(r) && r[0] === "+") { socket.write(`${b64}\r\n`); continue; } if (!Array.isArray(r) && r.tag === tag) { if (r.status !== "OK") throw new ImapError(/application-specific/i.test(r.line) ? "app_password_needed" : "auth_failed", r.code ?? ""); break; } } }
      } else {
        if (caps.has("LOGINDISABLED")) throw new ImapError("unsupported", "LOGINDISABLED");
        await run(`LOGIN ${quote(user)} ${quote(pass)}`);
      }
      await askCaps();
    },
    /** Every mailbox: { name, flags, delimiter }. */
    async list() {
      const { untagged } = await run('LIST "" "*"');
      return untagged.filter((r) => Array.isArray(r) && String(r[1]).toUpperCase() === "LIST").map((r) => ({ flags: flagsOf(r[2]), delimiter: str(r[3]), name: str(r[4]) }));
    },
    /** SELECT (read-write) or EXAMINE. → { exists, uidvalidity, uidnext }. */
    async select(name, { readOnly = true } = {}) {
      const { untagged } = await run(`${readOnly ? "EXAMINE" : "SELECT"} ${quote(name)}`);
      const out = { exists: 0, uidvalidity: null, uidnext: null };
      for (const r of untagged) {
        if (Array.isArray(r) && String(r[2]).toUpperCase() === "EXISTS") out.exists = Number(r[1]);
        const code = Array.isArray(r) ? null : r.code;
        if (code) { const m = /^(UIDVALIDITY|UIDNEXT) (\d+)/i.exec(code); if (m) out[m[1].toLowerCase()] = Number(m[2]); }
      }
      selected = name;
      return out;
    },
    /** UID SEARCH `criteria` (an IMAP search key the caller built from numbers and dates only). → UIDs ascending. */
    async uidSearch(criteria) {
      const { untagged } = await run(`UID SEARCH ${criteria}`);
      return untagged.filter((r) => Array.isArray(r) && String(r[1]).toUpperCase() === "SEARCH").flatMap((r) => r.slice(2).map(Number)).filter(Number.isSafeInteger).sort((a, b) => a - b);
    },
    /** UID FETCH `set` `items`. → [{ uid, flags, size, internaldate, envelope, bodystructure, body }]. */
    async uidFetch(set, items, { ms = timeoutMs } = {}) {
      const { untagged } = await run(`UID FETCH ${set} (${items})`, { ms });
      return untagged.filter((r) => Array.isArray(r) && String(r[2]).toUpperCase() === "FETCH" && Array.isArray(r[3])).map((r) => {
        const kv = r[3], o = {};
        for (let k = 0; k + 1 < kv.length; k += 2) {
          const key = String(kv[k]).toUpperCase(), v = kv[k + 1];
          if (key === "UID") o.uid = Number(v); else if (key === "FLAGS") o.flags = flagsOf(v); else if (key === "RFC822.SIZE") o.size = Number(v);
          else if (key === "INTERNALDATE") o.internaldate = Date.parse(str(v)) || null; else if (key === "ENVELOPE") o.envelope = v; else if (key === "BODYSTRUCTURE") o.bodystructure = v;
          else if (key.startsWith("BODY[")) o.body = Buffer.isBuffer(v) ? v : Buffer.from(str(v) ?? "", "utf8");
        }
        return o;
      }).filter((o) => Number.isSafeInteger(o.uid));
    },
    uidStore: (uid, op, flags) => run(`UID STORE ${Number(uid)} ${op}FLAGS.SILENT (${flags.join(" ")})`),
    append: (mailbox, flags, raw) => run(`APPEND ${quote(mailbox)} (${flags.join(" ")})`, { literal: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8") }),
    noop: () => run("NOOP"),
    /**
     * IDLE (where advertised) for at most `ms`: → "exists" when the server says new mail arrived, "timeout" when the time is
     * up (the caller sends NOOP before the next IDLE: a half-dead socket then fails its timeout). → "unsupported" without IDLE.
     */
    async idle(ms) {
      if (!caps.has("IDLE")) return "unsupported";
      const tag = `W${(seq += 1).toString(36)}`;
      socket.write(`${tag} IDLE\r\n`);
      const first = await next(timeoutMs);
      if (!(Array.isArray(first) && first[0] === "+")) throw new ImapError("rejected", "IDLE");
      let seen = "timeout";
      const end = Date.now() + ms;
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) break;
        const r = await next(left, true);
        if (r === null) break;
        if (Array.isArray(r) && String(r[2]).toUpperCase() === "EXISTS") { seen = "exists"; break; }
      }
      if (closed) throw new ImapError(closed);
      socket.write("DONE\r\n");
      for (;;) { const r = await next(timeoutMs); if (!Array.isArray(r) && r.tag === tag) break; }
      return seen;
    },
    get selected() { return selected; },
    async logout() { try { await run("LOGOUT", { ms: 5_000 }); } catch { /* closing anyway */ } socket.destroy(); },
    close: () => socket.destroy(),
  };
  return client;
  }
}
