/**
 * MAIL AS PLAIN TEXT, SAFE TO READ (docs/remote-agents/MAIL.md §Events; rules 5, 11 and 12 of the 2026-11-24 brief).
 *
 *   cleanText       zero-width, bidi-control and other control characters out (a hidden instruction to the drafter, a
 *                   reversed address shown as another), line endings to \n, runs of blank lines to one
 *   htmlToText      tags out, scripts, styles and heads out, and every element HIDDEN by its style (display:none,
 *                   visibility:hidden, font-size:0, opacity:0, max-height:0 / height:0) or the `hidden` attribute out with
 *                   all it holds; blocks become lines, list items "- ", entities decoded. No HTML reaches a phone in v1.
 *   collapseQuote   a quoted tail is cut only when about 80% of its lines already stand in an earlier message of the same
 *                   thread; a forward keeps its quote
 *   threadKey       the first References id, else In-Reply-To, else the message's own Message-ID
 *   decodeWords     RFC 2047 encoded words in a header (B and Q, UTF-8 and Latin-1)
 * Pure functions, no I/O.
 */
const INVISIBLE = /[­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{e0000}-\u{e007f}]/gu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function cleanText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", reg: "(R)", euro: "EUR" };
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, name) => {
    if (name[0] === "#") { const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ""; }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

const VOID = new Set(["br", "hr", "img", "meta", "link", "input", "wbr", "col", "area", "base", "source", "track", "embed", "param"]);
const BLOCK = new Set(["p", "div", "br", "tr", "li", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article", "header", "footer", "hr", "dd", "dt"]);
const DROP = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object", "iframe"]);
/** A style that hides what it holds from a reader's eye, which a model would still read. */
export function hiddenStyle(style) {
  const s = String(style ?? "").toLowerCase().replace(/\s+/g, "");
  return /display:none|visibility:hidden|visibility:collapse|font-size:0(?![.\d]*[1-9])|opacity:0(?![.\d]*[1-9])|max-height:0(?![.\d]*[1-9])|(?:^|;)height:0(?![.\d]*[1-9])|(?:^|;)width:0(?![.\d]*[1-9])|clip:rect\(0|text-indent:-\d{3,}/.test(s);
}

export function htmlToText(html) {
  const out = [];
  const stack = []; // { tag, hidden }
  let hiddenDepth = 0;
  const source = String(html ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (const m of source.matchAll(re)) {
    if (m[3] !== undefined || m[0] === "<") { if (hiddenDepth === 0) out.push(m[3] ?? "<"); continue; }
    const tag = m[1].toLowerCase(), closing = m[0][1] === "/", attrs = m[2] ?? "";
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at < 0) continue;
      for (const e of stack.splice(at)) if (e.hidden) hiddenDepth -= 1;
      if (hiddenDepth === 0 && BLOCK.has(tag)) out.push("\n");
      continue;
    }
    const style = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const hidden = DROP.has(tag) || /\shidden(\s|=|\/|$)/i.test(` ${attrs}`) || hiddenStyle(style?.[2] ?? style?.[3]);
    if (hiddenDepth === 0) { if (tag === "li") out.push("\n- "); else if (BLOCK.has(tag)) out.push("\n"); }
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    stack.push({ tag, hidden });
    if (hidden) hiddenDepth += 1;
  }
  return cleanText(decodeEntities(out.join("")).replace(/[ \t ]+/g, " ").replace(/\n /g, "\n"));
}

const normalLine = (line) => line.replace(/^(\s*>)+/, "").replace(/\s+/g, " ").trim().toLowerCase();
const FORWARD = /^-{2,}\s*(forwarded message|original message|doorgestuurd bericht)/im;
const QUOTE_HEAD = /^(on .{3,200}wrote:|op .{3,200}schreef .{0,80}:|-{2,}\s*original message\s*-{2,}|from: .+)$/i;

/** → { text, collapsed }. `earlier` the texts of the thread's earlier messages; `forward` keeps the quote whole. */
export function collapseQuote(text, earlier, { forward = false } = {}) {
  const lines = String(text ?? "").split("\n");
  if (forward || FORWARD.test(text)) return { text, collapsed: false };
  let start = lines.length;
  while (start > 0 && (/^\s*>/.test(lines[start - 1]) || lines[start - 1].trim() === "")) start -= 1;
  if (start > 0 && QUOTE_HEAD.test(lines[start - 1].trim())) start -= 1;
  if (start === lines.length) {
    const head = lines.findIndex((l) => QUOTE_HEAD.test(l.trim()));
    if (head < 0) return { text, collapsed: false };
    start = head;
  }
  const quoted = lines.slice(start).map(normalLine).filter((l) => l.length > 2 && !QUOTE_HEAD.test(l));
  if (quoted.length === 0) return { text, collapsed: false };
  const seen = new Set(earlier.flatMap((t) => String(t).split("\n").map(normalLine)).filter(Boolean));
  const found = quoted.filter((l) => seen.has(l)).length;
  if (found / quoted.length < 0.8) return { text, collapsed: false };
  return { text: lines.slice(0, start).join("\n").trimEnd(), collapsed: true };
}

/** A Message-ID as one token: angle brackets kept, surrounding space and folding removed. */
export const messageIdOf = (value) => { const m = /<[^<>\s]+>/.exec(String(value ?? "")); return m ? m[0] : null; };
export const referencesOf = (value) => [...String(value ?? "").matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
/** The thread key (rule 11): the first References id, else In-Reply-To, else the message's own id. */
export function threadKey({ references = [], inReplyTo = null, messageId = null, fallback = null }) {
  return references[0] ?? messageIdOf(inReplyTo) ?? messageIdOf(messageId) ?? fallback;
}

export function snippetOf(text, max = 200) {
  const flat = cleanText(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** "Name <a@b.example>" → { name, address }; a bare address → { name: null, address }. */
export function parseAddress(value) {
  const s = cleanText(value).replace(/\s+/g, " ");
  const m = /^"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return { name: m[1].trim() || null, address: m[2].toLowerCase() };
  const bare = /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(s);
  return bare ? { name: null, address: bare[1].toLowerCase() } : null;
}

/** RFC 2047 encoded words. Unknown charsets decode as UTF-8; a broken word is kept as it stood. */
export function decodeWords(header) {
  return String(header ?? "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (all, charset, kind, data) => {
    try {
      const bytes = kind.toUpperCase() === "B" ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      const cs = charset.replace(/\*.*$/, "").toLowerCase(); // RFC 2231 language suffix
      try { return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
    } catch { return all; }
  });
}

/** A reply's or forward's subject: one "Re:" / "Fwd:", never two. */
export function subjectFor(mode, subject) {
  const s = cleanText(subject).replace(/\s+/g, " ");
  if (mode === "forward") return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
  if (mode === "reply" || mode === "reply_all") return /^re:/i.test(s) ? s : `Re: ${s}`;
  return s;
}
