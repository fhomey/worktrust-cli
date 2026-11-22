/**
 * AN AGENT'S REPLY AS SPOKEN TEXT (CLI 0.11.21; owner, 2026-11-22; docs/remote-agents/VOICE-SIRI.md §8). Made HERE, on the
 * computer, in one tested implementation; the phone's Siri extension only speaks what it gets (protocol voice.ts voice.answer).
 *
 *   masked first   anything shaped like a key is replaced (remote-history-mask.mjs, the read-along's own mask)
 *   code           a fenced block becomes "A code block of N lines." (owner); inline code of up to 40 characters is read,
 *                  longer "some code"
 *   links          read by their words, never their address; a bare address is "a link"
 *   structure      markdown marks go; a heading and a list item each become a sentence; a quote is read as text
 *   tables         at most 3 rows and 4 columns: read row by row as "header, value" pairs; larger: "A table of R rows: <its
 *                  header names>."
 *   length         at most 4,000 characters, cut at a sentence end (`truncated`), in parts of at most 600 characters each cut
 *                  at sentence ends (a sentence longer than a part is cut at a word)
 */
import { maskKeys } from "./remote-history-mask.mjs";

export const SPEECH_MAX_CHARS = 4_000, SPEECH_PART_CHARS = 600, INLINE_CODE_SPOKEN = 40;
const TABLE_ROWS = 3, TABLE_COLS = 4;

const sentence = (s) => { const t = s.replace(/\s+/g, " ").trim(); return t === "" ? "" : /[.!?:;]$/.test(t) ? t : `${t}.`; };
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Inline markdown of one line to plain words. */
export function inlineWords(line) {
  return line
    .replace(/`([^`]+)`/g, (_, code) => (code.length <= INLINE_CODE_SPOKEN ? code : "some code"))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `an image of ${alt}` : "an image"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, "a link")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

function tableSentences(rows) {
  const [head, , ...body] = rows.map(cells);
  if (body.length <= TABLE_ROWS && head.length <= TABLE_COLS) return body.map((r) => sentence(head.map((h, i) => `${inlineWords(h)}, ${inlineWords(r[i] ?? "")}`).join("; ")));
  return [sentence(`A table of ${body.length} row${body.length === 1 ? "" : "s"}: ${head.map(inlineWords).join(", ")}`)];
}

/** The reply's markdown as spoken sentences, in order. */
export function spokenSentences(markdown) {
  const lines = maskKeys(String(markdown ?? "")).replace(/\r\n?/g, "\n").split("\n"), out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(...inlineWords(para.join(" ")).split(/(?<=[.!?])\s+/).map(sentence).filter(Boolean)); para = []; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      let n = 0, j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) { n += 1; j += 1; }
      out.push(`A code block of ${n} line${n === 1 ? "" : "s"}.`);
      i = j;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      i -= 1;
      out.push(...tableSentences(rows));
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); continue; }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line), item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line), quote = /^\s*>\s?(.*)$/.exec(line);
    if (heading || item) { flush(); const s = sentence(inlineWords((heading ?? item)[1])); if (s) out.push(s); continue; }
    para.push(quote ? quote[1] : line);
  }
  flush();
  return out;
}

/** → { parts, truncated }: at most 4,000 characters cut at a sentence end, in parts of at most 600. */
export function spokenAnswer(markdown) {
  const parts = [];
  let total = 0, truncated = false, part = "";
  const push = () => { if (part) { parts.push(part); part = ""; } };
  for (let s of spokenSentences(markdown)) {
    while (s.length > SPEECH_PART_CHARS) { const cut = s.lastIndexOf(" ", SPEECH_PART_CHARS - 1); const head = s.slice(0, cut > 0 ? cut : SPEECH_PART_CHARS - 1); if (total + head.length > SPEECH_MAX_CHARS) { truncated = true; break; } push(); parts.push(head); total += head.length; s = s.slice(head.length).trim(); }
    if (truncated) break;
    if (total + s.length + (part ? 1 : 0) > SPEECH_MAX_CHARS) { truncated = true; break; }
    if (part && part.length + 1 + s.length > SPEECH_PART_CHARS) push();
    part = part ? `${part} ${s}` : s;
    total += s.length + (part === s ? 0 : 1);
  }
  push();
  return { parts: parts.filter(Boolean), truncated };
}
