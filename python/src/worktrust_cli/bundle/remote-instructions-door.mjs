/**
 * THE INSTRUCTION FILES' DOOR (owner, 2026-11-25 12:50; docs/remote-agents/MAIL-INSTRUCTIONS.md). remote-mail.mjs hands it
 * every instructions.* command AFTER the mail door's phone-only gate (a browser never reaches it). It answers over the store
 * (remote-mail-instructions.mjs: profiles with versions, the built-in `default`) and never keeps a text of its own.
 *
 *   read      instructions.list.get / instructions.get: the store's list (each type's mailboxes by their account id) and one text
 *   write     put (a new type gets its id from its name), remove, reset and assign: each names the version it edited; a stale
 *             one answers instructions.conflict with the computer's copy WHOLE, so the phone shows both and the person
 *             chooses. Rate-limited per phone (WRITES_PER_MINUTE, WRITES_PER_HOUR). The phone sends a write only after a fresh
 *             unlock (check-mobile `instructions`); this side cannot see that and does not pretend to.
 *   audit     one log line per write: action, kind, id, version and the phone's device id. Never a name, never a text.
 *   pushed    instructions.changed to the person's PHONES when the copy here changes: written by another phone, or by hand
 *             in an editor (`watch`, once a minute, compares the versions)
 *   improve   the person's own agent proposes a better text through the mail drafter's job (remote-mail-draft.mjs runDraft:
 *             a constant command line, no tools, an empty folder: check-remote-cli rule G), one run at a time; the prompt
 *             holds the person's text and the person's ask, each between its own boundary, and nothing else; the answer is a
 *             PROPOSAL only, saved by nothing here
 * check-remote-cli rule U holds this; scripts/test-remote-instructions-door.mjs runs it over a real store in a synthetic home.
 */
import * as P from "./remote-protocol.mjs";
import { neutralise } from "./remote-mail-draft.mjs";

export const INSTRUCTION_TYPES = new Set(P.MAIL_COMMAND_TYPES.filter((t) => t.startsWith("instructions.")));
export const WRITES = new Set(["instructions.put", "instructions.remove", "instructions.reset", "instructions.assign"]);
export const WRITES_PER_MINUTE = 10, WRITES_PER_HOUR = 60;
const PRESET_WORDS = { tighten: "Tighten it: fewer words, the same rules.", friendlier: "Make the tone it asks for friendlier.", formal: "Make the tone it asks for more formal.", shorter: "Make it shorter.", clearer: "Make every rule clear and unambiguous." };

/** A new type's id from its name: a slug, unique among the ids there. */
export function slugFrom(name, taken) {
  const base = String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "type";
  const start = /^[a-z0-9]/.test(base) ? base : `t-${base}`;
  for (let n = 1; n < 100; n += 1) { const id = n === 1 ? start : `${start}-${n}`; if (!taken.has(id) && P.instructionsIdOk(id)) return id; }
  return null;
}

/** The improve job's prompt: the person's text and the person's ask, each fenced by a boundary of its own, and nothing else. */
export function improvePrompt({ text, ask, preset = null, random }) {
  const fence = () => `INSTRUCTIONS-${Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const a = fence(), b = fence();
  const wants = [preset ? PRESET_WORDS[preset] : null, ask?.trim() || null].filter(Boolean).join("\n");
  return [
    "You improve one instruction file that a person wrote for their own e-mail agent. Both the file and the request below are the person's own words.",
    "Return the WHOLE improved file as markdown in `body`: keep its meaning, its headings and its language unless the request says otherwise; change only what the request asks.",
    "Set `mode` to text, `confidence` to how sure you are, and `notes` to at most three short lines on what you changed.",
    `The current file, between ${a} lines:`, a, neutralise(text, a), a,
    `What the person wants changed, between ${b} lines:`, b, neutralise(wants, b), b,
  ].join("\n");
}

/**
 * c: { store, kind: "mail", now, random, log(event, fields), exclusive(job) → Promise, agentDraft(prompt) → { ok, draft } | { ok: false, code },
 *      tellPhones(type, body): to every confirmed phone, never a browser }
 */
export function createInstructionsDoor(c) {
  const writes = new Map(); // phone → write times in the last hour
  let known = null; // id → version, for `watch`
  const accountsOf = (row) => (row.mailboxes ?? []).filter((m) => P.isOpaqueId(m, "mac")).slice(0, 10);
  const rowOf = (r) => ({ id: r.id, name: r.name, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by, bytes: Math.min(r.bytes, P.INSTRUCTIONS_TEXT_MAX), accounts: accountsOf(r) });
  const list = () => c.store.list().filter((r) => P.instructionsIdOk(r.id)).slice(0, P.INSTRUCTIONS_MAX_ITEMS).map(rowOf);
  const itemOf = (g) => ({ kind: c.kind, id: g.id, name: g.name, text: g.text, version: g.version, updated_at: g.updated_at, updated_by: g.updated_by });
  const remember = () => { known = Object.fromEntries(c.store.list().map((r) => [r.id, r.version])); };
  const pushed = (id, version, by) => c.tellPhones("instructions.changed", { request_id: null, kind: c.kind, id, version, updated_by: by });
  const audit = (action, id, version, phone) => c.log("instructions", { action, kind: c.kind, id, version, by: phone });

  function limited(phone) {
    const now = c.now(), times = (writes.get(phone) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= WRITES_PER_HOUR || times.filter((t) => now - t < 60_000).length >= WRITES_PER_MINUTE) { writes.set(phone, times); return true; }
    writes.set(phone, [...times, now]);
    return false;
  }
  const conflict = (id, req, tell) => { const g = c.store.get(id); if (!g) return tell("instructions.refused", { request_id: req, code: "not_found" }); tell("instructions.conflict", { request_id: req, ...itemOf(g) }); };
  const saved = (profile, req, tell, action, phone) => {
    audit(action, profile.id, profile.version, phone);
    tell("instructions.saved", { request_id: req, kind: c.kind, id: profile.id, version: profile.version, updated_at: profile.updated_at });
    remember(); pushed(profile.id, profile.version, "phone");
  };
  const refusal = (code) => (code === "too_large" ? "too_large" : code === "limit" ? "limit" : code === "not_found" ? "not_found" : code === "not_allowed" ? "builtin" : "invalid");

  function put(p, req, tell, phone) {
    const rows = c.store.list();
    if (p.id === undefined && rows.some((r) => r.name.trim().toLowerCase() === p.name.trim().toLowerCase())) return tell("instructions.refused", { request_id: req, code: "name_taken" });
    const id = p.id ?? slugFrom(p.name, new Set(rows.map((r) => r.id)));
    if (!id) return tell("instructions.refused", { request_id: req, code: "invalid" });
    const r = c.store.put(id, { name: p.name, text: p.text, base_version: p.base_version, by: "phone" });
    if (r.ok) return saved(r.profile, req, tell, p.id === undefined ? "created" : "saved", phone);
    if (r.code === "conflict") return conflict(id, req, tell);
    tell("instructions.refused", { request_id: req, code: refusal(r.code) });
  }
  /** Remove and reset name the version they were asked on: a profile that moved on meanwhile is a conflict, never a silent loss. */
  function onVersion(p, req, tell, run) {
    const g = c.store.get(p.id);
    if (!g) return tell("instructions.refused", { request_id: req, code: "not_found" });
    if (g.version !== p.base_version) return conflict(p.id, req, tell);
    return run(g);
  }

  function improve(p, req, tell) {
    tell("instructions.improve.progress", { request_id: req, phase: "reading" });
    c.exclusive(async () => {
      tell("instructions.improve.progress", { request_id: req, phase: "drafting" });
      const r = await c.agentDraft(improvePrompt({ text: p.text, ask: p.ask, preset: p.preset ?? null, random: c.random }));
      if (!r.ok) { c.log("instructions", { action: "improve", kind: c.kind, id: p.id, outcome: r.code }); return tell("instructions.improve.refused", { request_id: req, code: P.INSTRUCTIONS_IMPROVE_REFUSALS.includes(r.code) ? r.code : "agent_failed" }); }
      const text = r.draft.body.trim();
      if (!text || Buffer.byteLength(text, "utf8") > P.INSTRUCTIONS_TEXT_MAX) return tell("instructions.improve.refused", { request_id: req, code: "unparseable" });
      c.log("instructions", { action: "improve", kind: c.kind, id: p.id, outcome: "proposed" });
      tell("instructions.improve.proposal", { request_id: req, kind: c.kind, id: p.id, base_version: p.base_version, text }); // a proposal: nothing is written
    }).catch(() => tell("instructions.improve.refused", { request_id: req, code: "agent_failed" }));
  }

  return {
    handles: (type) => INSTRUCTION_TYPES.has(type),
    /** → "taken" or a REJECT_REASONS word. `phone` is the sender (the mail door let only a phone through). */
    handle(type, p, req, phone, tell) {
      if (p.kind !== c.kind) return "not_allowed";
      if (WRITES.has(type) && limited(phone)) { tell("instructions.refused", { request_id: req, code: "rate_limited" }); return "taken"; }
      switch (type) {
        case "instructions.list.get": tell("instructions.list", { request_id: req, kind: c.kind, items: list() }); return "taken";
        case "instructions.get": { const g = c.store.get(p.id); if (!g) return "not_found"; tell("instructions.item", { request_id: req, ...itemOf(g) }); return "taken"; }
        case "instructions.put": put(p, req, tell, phone); return "taken";
        case "instructions.remove":
          onVersion(p, req, tell, () => { const r = c.store.remove(p.id); if (!r.ok) return tell("instructions.refused", { request_id: req, code: refusal(r.code) }); audit("removed", p.id, p.base_version, phone); tell("instructions.removed", { request_id: req, kind: c.kind, id: p.id }); remember(); pushed(p.id, 0, "phone"); });
          return "taken";
        case "instructions.reset":
          onVersion(p, req, tell, () => { const r = c.store.reset(p.id); if (!r.ok) return r.code === "conflict" ? conflict(p.id, req, tell) : tell("instructions.refused", { request_id: req, code: refusal(r.code) }); saved(r.profile, req, tell, "reset", phone); });
          return "taken";
        case "instructions.assign": {
          const r = c.store.setMailboxDefault(p.account_id, p.id);
          if (!r.ok) { tell("instructions.refused", { request_id: req, code: "not_found" }); return "taken"; }
          audit("assigned", p.id ?? P.INSTRUCTIONS_DEFAULT_ID, 0, phone);
          tell("instructions.list", { request_id: req, kind: c.kind, items: list() });
          return "taken";
        }
        case "instructions.improve.request": improve(p, req, tell); return "taken";
        default: return "unknown_type";
      }
    },
    /** Once a minute: a copy changed by hand here (or a file dropped in or removed) is pushed to the phones. */
    watch() {
      const before = known;
      remember();
      if (!before) return;
      for (const r of c.store.list()) if (before[r.id] !== r.version) pushed(r.id, r.version, r.updated_by);
      for (const id of Object.keys(before)) if (!(id in known)) pushed(id, 0, "computer");
    },
  };
}
