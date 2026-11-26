/**
 * THE ANSWER IS THE E-MAIL AND NOTHING ELSE (CLI 0.11.26; owner, 2026-11-25: "only the e-mail text: the salutation, the body,
 * the closing … ONE clean answer, with the bullets you gave"). Pure: a check, a repair by rule, and the bullets' cover.
 *
 *   check     a preface line ("Here is a draft:", "Hier is een concept:", "Sure:"), a paragraph AFTER the sign-off that talks
 *             about the draft, asks the person something or offers options ("Let me know if you want", "Wil je dat ik",
 *             "Option 2"), a code fence, a markdown heading, a "Subject:" line (the subject is its own field), a second
 *             version. A last paragraph BEFORE the sign-off that asks the RECIPIENT something is mail, never meta.
 *   repair    used only after one re-ask with the violation named still broke the rule: the meta lines and paragraphs go,
 *             the rest stays word for word, and a note says what was trimmed (never a silent cut)
 *   bullets   each bullet of the person's instruction should leave a key term in the mail; one that does not becomes the
 *             note "Not covered: …" (soft: never a refusal)
 * English and Dutch: the person's words decide the mail's language (the prompt says so); the phrase lists hold both.
 */
import * as P from "./remote-protocol.mjs";

const DRAFT_WORDS = /\b(draft|e-?mail|mail|reply|response|version|concept|antwoord|reactie|versie|bericht)\b/i;
const LEAD = /^(here is|here's|hereby|below is|below you|sure|certainly|of course|absolutely|draft|hier is|hierbij|hieronder|zeker|natuurlijk|graag|concept)\b/i;
const TAIL = /\b(let me know if (you|you'd|you would) (like|want)|would you like (me|a)|do you want me|shall i|i can also|i could also|feel free to (ask|let me)|hope this (helps|works)|happy to adjust|wil je dat ik|zal ik|laat (me|het) weten als je|ik kan (ook|het)|ik pas .* aan|optie \d|option \d|alternatively|alternatief|een andere versie|another version)\b/i;
const SIGN_OFF = /^(best( regards)?|kind regards|warm regards|regards|many thanks|thanks( again)?|thank you|cheers|yours( sincerely| truly)?|sincerely|met vriendelijke groet(en)?|vriendelijke groet(en)?|hartelijke groet(en)?|groet(en|jes)?|mvg|bedankt|dank je( wel)?|alvast bedankt)\b[,!.]?\s*$/i;
const FENCE = /^\s*```/, HEADING = /^\s{0,3}#{1,6}\s+\S/, SUBJECT = /^\s*(subject|onderwerp)\s*:/i, VERSION = /^\s*\**\s*(version|versie|option|optie|variant)\s*(\d|[ab])\b/i;

const paragraphs = (body) => body.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
const signOffAt = (paras) => { for (let i = paras.length - 1; i >= 0; i -= 1) if (paras[i].split("\n").some((l) => SIGN_OFF.test(l.trim()))) return i; return -1; };
const tailIsMeta = (para) => TAIL.test(para) || (DRAFT_WORDS.test(para) && /\?\s*$/.test(para.trim()) && /\b(you|je|jij|u)\b/i.test(para));

/** → { ok, violations: string[] } (each the rule's name: "preface", "remark after the closing", "code fence", "heading", "subject line", "two versions") */
export function mailOnlyCheck(body) {
  const v = new Set(), lines = String(body).replace(/\r\n?/g, "\n").split("\n"), first = lines.find((l) => l.trim()) ?? "";
  if (LEAD.test(first.trim()) && (/:\s*$/.test(first) || DRAFT_WORDS.test(first)) && !SIGN_OFF.test(first.trim())) v.add("preface");
  if (SUBJECT.test(first)) v.add("subject line");
  if (lines.some((l) => FENCE.test(l))) v.add("code fence");
  if (lines.some((l) => HEADING.test(l))) v.add("heading");
  if (lines.filter((l) => VERSION.test(l)).length >= 1 && lines.filter((l) => VERSION.test(l)).length >= 2) v.add("two versions");
  const paras = paragraphs(body), at = signOffAt(paras);
  if (at >= 0 && paras.slice(at + 1).some((p) => p.trim() && !/^[\p{L}.'-]+( [\p{L}.'-]+){0,3}$/u.test(p.trim()) /* a name on its own line, four words at most */ && (tailIsMeta(p) || DRAFT_WORDS.test(p)))) v.add("remark after the closing");
  if (at < 0) { const last = paras.at(-1) ?? ""; if (tailIsMeta(last) && DRAFT_WORDS.test(last)) v.add("remark after the closing"); }
  return { ok: v.size === 0, violations: [...v] };
}

/** The rule's repair, after the re-ask failed: → { body, trimmed: string[] }. Only what the rule names goes; every other word stays. */
export function repairMail(body) {
  const found = mailOnlyCheck(body).violations;
  let lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const firstAt = lines.findIndex((l) => l.trim());
  if (found.includes("preface") || found.includes("subject line")) { lines.splice(firstAt, 1); while (lines[0] !== undefined && !lines[0].trim()) lines.shift(); }
  if (found.includes("subject line") && found.includes("preface")) { const s = lines.findIndex((l) => l.trim()); if (s >= 0 && SUBJECT.test(lines[s])) lines.splice(s, 1); }
  lines = lines.filter((l) => !FENCE.test(l)).map((l) => (HEADING.test(l) ? l.replace(/^\s{0,3}#{1,6}\s+/, "") : l));
  let paras = paragraphs(lines.join("\n"));
  if (found.includes("two versions")) { const second = paras.findIndex((p, i) => i > 0 && VERSION.test(p.split("\n")[0])); if (second > 0) paras = paras.slice(0, second); paras = paras.map((p, i) => (i === 0 ? p.split("\n").filter((l) => !VERSION.test(l)).join("\n") : p)); }
  const at = signOffAt(paras);
  if (at >= 0) { let end = paras.length; while (end - 1 > at && (tailIsMeta(paras[end - 1]) || DRAFT_WORDS.test(paras[end - 1]))) end -= 1; paras = paras.slice(0, end); }
  else if (paras.length > 1 && tailIsMeta(paras.at(-1)) && DRAFT_WORDS.test(paras.at(-1))) paras = paras.slice(0, -1);
  return { body: paras.join("\n\n").trim(), trimmed: found };
}

const STOP = new Set(["about", "after", "again", "also", "and", "because", "before", "being", "that", "their", "there", "these", "this", "with", "would", "could", "should", "please", "dat", "deze", "die", "een", "het", "met", "niet", "naar", "over", "voor", "wordt", "zijn", "graag", "even", "ook", "maar", "want", "omdat"]);
/** The person's bullets (lines that start with -, *, •, or 1. / 1)) and each one's key terms. */
export function bulletsOf(instruction) {
  return String(instruction ?? "").split(/\r?\n/).map((l) => /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(l)?.[1]?.trim()).filter(Boolean)
    .map((text) => ({ text, terms: [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter((w) => !STOP.has(w)) }));
}
/** The bullets whose key terms all stay out of the mail. → their texts, cut for a note. */
export const notCovered = (instruction, body) => { const low = String(body).toLowerCase(); return bulletsOf(instruction).filter((b) => b.terms.length > 0 && !b.terms.some((t) => low.includes(t))).map((b) => b.text.slice(0, 120)); };

/**
 * THE FINAL ANSWER (every draft and rewrite): the check, ONE re-ask with the violation named (`again(prompt)`), then the
 * repair with a note; the bullets' cover as notes. `r` is the run's { ok: true, draft }. → the draft to hold, or the re-ask's failure.
 */
export async function finishDraft({ r, prompt, instruction = "", again }) {
  let draft = r.draft;
  const first = mailOnlyCheck(draft.body);
  const notes = [...draft.notes];
  if (!first.ok) {
    const retry = await again(`${prompt}\n\nYour previous answer broke this rule: ${first.violations.join(", ")}. Answer again with ONLY the e-mail itself (salutation, body, closing), in one version, nothing before or after it.`);
    if (retry.ok && mailOnlyCheck(retry.draft.body).ok) { draft = retry.draft; notes.splice(0, notes.length, ...retry.draft.notes); }
    else {
      const base = retry.ok ? retry.draft : draft, fixed = repairMail(base.body);
      draft = { ...base, body: fixed.body || base.body };
      notes.splice(0, notes.length, ...base.notes);
      notes.push(`Trimmed from the agent's answer: ${fixed.trimmed.join(", ")}`);
    }
  }
  for (const missing of notCovered(instruction, draft.body)) notes.push(`Not covered: ${missing}`);
  const kept = [...new Set(notes)].map((n) => n.slice(0, P.MAIL_NOTE_MAX)).slice(0, P.MAIL_NOTES_MAX);
  return { ok: true, draft: { ...draft, notes: kept } };
}
