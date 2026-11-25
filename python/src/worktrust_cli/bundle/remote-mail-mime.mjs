/**
 * MIME, READ AND WRITTEN, WITH NO DEPENDENCY (docs/remote-agents/MAIL.md §Providers; owner decision 2026-11-24: the CLI
 * keeps zero runtime dependencies, so IMAP, SMTP and MIME are written here).
 *
 *   read    headers unfolded and their encoded words decoded (RFC 2047), a multipart walk by boundary (nested), the
 *           transfer encodings quoted-printable and base64, charsets through TextDecoder (an unknown one read as UTF-8),
 *           text/plain preferred and text/html reduced to text by remote-mail-text.mjs's sanitiser; attachments are LISTED
 *           by name, size and type and never decoded beyond counting, never written, never run. A message cut at the
 *           fetch's byte cap reads as far as it goes and says `truncated`.
 *   write   one plain-text message (a reply, a forward or a new mail): Date, Message-ID, In-Reply-To and References, From,
 *           To, Cc (never Bcc: those are envelope recipients only), Subject encoded where it is not ASCII, headers folded
 *           at 78, the body UTF-8 in quoted-printable, CRLF throughout.
 * Pure functions, no I/O.
 */
import { randomBytes } from "node:crypto";
import { cleanText, decodeWords, htmlToText, parseAddress } from "./remote-mail-text.mjs";

const CRLF = "\r\n";
const decoderFor = (charset) => { try { return new TextDecoder(String(charset || "utf-8").trim().toLowerCase().replace(/^(us-ascii|ascii)$/, "utf-8"), { fatal: false }); } catch { return new TextDecoder("utf-8"); } };

/** "a=1; b=\"x y\"" → { value, params } (RFC 2231 continuations and charset'lang' values joined). */
export function headerValue(raw = "") {
  const parts = []; let cur = "", quoted = false;
  for (const ch of String(raw)) { if (ch === '"') quoted = !quoted; if (ch === ";" && !quoted) { parts.push(cur); cur = ""; } else cur += ch; }
  parts.push(cur);
  const params = {}, star = {};
  for (const p of parts.slice(1)) {
    const at = p.indexOf("="); if (at < 0) continue;
    const key = p.slice(0, at).trim().toLowerCase(); let v = p.slice(at + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) { (star[m[1]] ??= []).push({ n: Number(m[2] ?? 0), v, enc: Boolean(m[3]) || (m[2] === undefined && key.endsWith("*")) }); continue; }
    params[key] = decodeWords(v);
  }
  for (const [k, list] of Object.entries(star)) {
    const joined = list.sort((a, b) => a.n - b.n);
    const first = joined[0], cs = first.enc ? /^([^']*)'[^']*'/.exec(first.v) : null;
    const text = joined.map((x, i) => (i === 0 && cs ? x.v.slice(cs[0].length) : x.v)).join("");
    params[k] = joined.some((x) => x.enc) ? decoderFor(cs?.[1]).decode(Buffer.from(text.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1")) : text;
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** A block of headers → Map(name → [values]) with folding undone. */
export function parseHeaders(text) {
  const out = new Map();
  for (const line of String(text).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":"); if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase(), list = out.get(name) ?? [];
    list.push(line.slice(at + 1).trim()); out.set(name, list);
  }
  return out;
}
const splitHead = (buf) => {
  const s = buf.toString("latin1"); const m = /\r?\n\r?\n/.exec(s);
  return m ? { head: s.slice(0, m.index), body: buf.subarray(m.index + m[0].length) } : { head: s, body: Buffer.alloc(0) };
};

export function decodeQuotedPrintable(text) {
  const s = String(text).replace(/=\r?\n/g, ""), out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
const decodeBody = (buf, encoding) => {
  const e = String(encoding ?? "7bit").toLowerCase().trim();
  if (e === "base64") return Buffer.from(buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return decodeQuotedPrintable(buf.toString("latin1"));
  return buf;
};

/**
 * A raw message (Buffer or string) → { headers, subject, from, to, cc, reply_to, date, message_id, in_reply_to, references,
 * text, html_used, attachments, truncated }. `truncated`: the caller fetched only the first bytes (the byte cap).
 */
export function readMessage(raw, { truncated = false } = {}) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  const top = splitHead(buf), headers = parseHeaders(top.head);
  const texts = [], htmls = [], attachments = [];
  const walk = (headMap, body, depth) => {
    const type = headerValue(headMap.get("content-type")?.[0] ?? "text/plain"), disp = headerValue(headMap.get("content-disposition")?.[0] ?? "");
    const encoding = headMap.get("content-transfer-encoding")?.[0];
    if (type.value.startsWith("multipart/") && type.params.boundary && depth < 12) {
      const b = `--${type.params.boundary}`, s = body.toString("latin1");
      const pieces = s.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      for (const piece of pieces.slice(1)) { if (!piece.trim()) continue; const p = splitHead(Buffer.from(piece, "latin1")); walk(parseHeaders(p.head), p.body, depth + 1); }
      return;
    }
    const name = disp.params.filename ?? type.params.name ?? null;
    if (disp.value === "attachment" || (name && !type.value.startsWith("text/")) || (!type.value.startsWith("text/") && !type.value.startsWith("message/"))) {
      const size = String(encoding ?? "").toLowerCase().trim() === "base64" ? Math.floor(body.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "").length * 3 / 4) : body.length;
      attachments.push({ name: cleanText(name ?? "attachment").slice(0, 255) || "attachment", size, mime: type.value.slice(0, 127) || "application/octet-stream" });
      return;
    }
    const text = decoderFor(type.params.charset).decode(decodeBody(body, encoding));
    if (type.value === "text/html") htmls.push(text); else if (type.value === "text/plain") texts.push(text);
  };
  walk(headers, top.body, 0);
  const one = (n) => decodeWords(headers.get(n)?.[0] ?? "");
  const people = (n) => (headers.get(n) ?? []).flatMap((v) => splitAddresses(decodeWords(v))).map(parseAddress).filter(Boolean);
  const html_used = texts.length === 0 && htmls.length > 0;
  return {
    headers, subject: cleanText(one("subject")).replace(/\s+/g, " "), from: people("from")[0] ?? null, to: people("to"), cc: people("cc"), reply_to: people("reply-to"),
    date: Date.parse(one("date")) || null, message_id: (/<[^<>\s]+>/.exec(one("message-id")) ?? [null])[0], in_reply_to: (/<[^<>\s]+>/.exec(one("in-reply-to")) ?? [null])[0],
    references: [...one("references").matchAll(/<[^<>\s]+>/g)].map((m) => m[0]),
    text: cleanText(html_used ? htmls.map(htmlToText).join("\n\n") : texts.join("\n\n")), html_used, attachments, truncated,
  };
}

/** "a <x@y>, \"B, C\" <z@w>" → each address, commas inside quotes kept. */
export function splitAddresses(value) {
  const out = []; let cur = "", quoted = false, angle = 0;
  for (const ch of String(value)) { if (ch === '"') quoted = !quoted; else if (ch === "<") angle += 1; else if (ch === ">") angle = Math.max(0, angle - 1); if (ch === "," && !quoted && angle === 0) { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
/** An RFC 2047 encoded word sequence for a header value that is not printable ASCII, each word within 75 characters. */
export function encodeWords(text) {
  if (ascii(text)) return text;
  const words = []; let chunk = "";
  for (const ch of text) { if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; } chunk += ch; }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}
/** A header line folded at whitespace so no line passes 78 characters where it can be helped. */
export function foldHeader(name, value) {
  const words = `${name}: ${value}`.split(" "), lines = []; let line = "";
  for (const w of words) { if (line && line.length + 1 + w.length > 78) { lines.push(line); line = ` ${w}`; } else line = line ? `${line} ${w}` : w; }
  lines.push(line);
  return lines.join(CRLF);
}
const mailbox = (p) => (typeof p === "string" ? p : p.name ? `${ascii(p.name) && !/[",;<>@()]/.test(p.name) ? p.name : ascii(p.name) ? `"${p.name.replace(/(["\\])/g, "\\$1")}"` : encodeWords(p.name)} <${p.address}>` : p.address);

export function encodeQuotedPrintable(text) {
  const out = [];
  for (const line of String(text).replace(/\r?\n/g, "\n").split("\n")) {
    let enc = "";
    for (const byte of Buffer.from(line, "utf8")) enc += (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    enc = enc.replace(/ $/, "=20");
    let rest = enc;
    while (rest.length > 76) { let cut = 75; while (cut > 70 && /=[0-9A-F]?$/.test(rest.slice(0, cut))) cut -= 1; out.push(`${rest.slice(0, cut)}=`); rest = rest.slice(cut); }
    out.push(rest);
  }
  return out.join(CRLF);
}

/**
 * One plain-text message. `m`: { from: {name, address}, to, cc (address strings), subject, body, in_reply_to?, references?,
 * date?, message_id?, domain? }. → { raw (CRLF), message_id }. Bcc is never written into the message.
 */
export function writeMessage(m) {
  const domain = m.domain ?? String(m.from.address).split("@")[1] ?? "localhost";
  const message_id = m.message_id ?? `<${randomBytes(12).toString("hex")}.${Date.now().toString(36)}@${domain}>`;
  const refs = [...new Set([...(m.references ?? []), ...(m.in_reply_to ? [m.in_reply_to] : [])])].slice(-20);
  const head = [
    foldHeader("Date", new Date(m.date ?? Date.now()).toUTCString().replace("GMT", "+0000")),
    foldHeader("From", mailbox(m.from)),
    ...(m.to.length ? [foldHeader("To", m.to.map(mailbox).join(", "))] : []),
    ...(m.cc?.length ? [foldHeader("Cc", m.cc.map(mailbox).join(", "))] : []),
    foldHeader("Subject", encodeWords(m.subject ?? "")),
    `Message-ID: ${message_id}`,
    ...(m.in_reply_to ? [`In-Reply-To: ${m.in_reply_to}`] : []),
    ...(refs.length ? [foldHeader("References", refs.join(" "))] : []),
    "MIME-Version: 1.0",
  ];
  const body = bodyPart(m);
  return { raw: `${head.join(CRLF)}${CRLF}${body.head}${CRLF}${CRLF}${body.text}${CRLF}`, message_id };
}

const boundary = (tag) => `=_wt_${tag}_${randomBytes(9).toString("hex")}`;
const textPart = (type, text) => ({ head: `Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: quoted-printable`, text: encodeQuotedPrintable(text) });
const multipart = (kind, parts) => { const b = boundary(kind); return { head: `Content-Type: multipart/${kind}; boundary="${b}"`, text: `${parts.map((p) => `--${b}${CRLF}${p.head}${CRLF}${CRLF}${p.text}`).join(CRLF)}${CRLF}--${b}--` }; };
/** A file part: base64 in lines of 76, its name RFC 2231-encoded where it is not ASCII (and a plain fallback name). */
function filePart(f) {
  const plain = ascii(f.name) && !/["\\]/.test(f.name) ? f.name : f.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const star = ascii(f.name) ? "" : `; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(f.mime) ? f.mime : "application/octet-stream";
  return { head: `Content-Type: ${mime}; name="${plain}"${CRLF}Content-Disposition: attachment; filename="${plain}"${star}${CRLF}Content-Transfer-Encoding: base64`, text: Buffer.from(f.bytes).toString("base64").replace(/.{1,76}/g, (l) => `${l}${CRLF}`).trimEnd() };
}
/** The body: plain text; `basic` as plain + generated HTML (multipart/alternative); with files, all inside multipart/mixed. */
function bodyPart(m) {
  const plain = textPart("text/plain", m.body ?? "");
  const text = m.format === "basic" ? multipart("alternative", [plain, textPart("text/html", basicToHtml(m.body ?? ""))]) : plain;
  return m.attachments?.length ? multipart("mixed", [text, ...m.attachments.map(filePart)]) : text;
}

/**
 * THE HTML OF A `basic` MAIL (MAIL.md §Composing by hand), from the approved text alone: every &, <, >, ", ', ` and = is
 * escaped FIRST, so nothing the person typed can become a tag; then only three constructs become tags: **bold**, _italics_ and
 * lines starting "• " (a list). Line breaks are <br>. No link, no image, no style, no remote content.
 */
export function basicToHtml(text) {
  const esc = (t) => t.replace(/[&<>"'`=]/g, (c) => `&#${c.charCodeAt(0)};`);
  const inline = (t) => t.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s.,;:!?)])/g, "$1<i>$2</i>");
  const out = [];
  let list = false;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("• ")) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(esc(line.slice(2)))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    out.push(`${inline(esc(line))}<br>`);
  }
  if (list) out.push("</ul>");
  return `<div>${out.join("\n")}</div>`;
}
