/**
 * AN ACCOUNT'S SIGNATURES ON THIS COMPUTER (docs/remote-agents/MAIL.md §Composing by hand). Plain text, at most 10 per account,
 * a name of 60 and a text of 2,000 characters (the protocol's schema refuses longer, and this refuses it again), one default.
 * `<mail>/signatures.json`, 0600. The phone places a signature's text in the body, in sight, so the approval hash covers it.
 * Logs carry ids, never a name or a text.
 */
import { existsSync } from "node:fs";
import * as P from "./remote-protocol.mjs";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";

/** o: { file, random, log } */
export function createSignatures(o) {
  let all = {};
  try { if (existsSync(o.file)) all = JSON.parse(readMailFile(o.file)) ?? {}; } catch { all = {}; }
  const save = () => writeMailFile(o.file, JSON.stringify(all));
  const of = (accountId) => ({ account_id: accountId, signatures: all[accountId]?.signatures ?? [], default_id: all[accountId]?.default_id ?? null });
  return {
    of,
    /** → { ok: true, value } or { ok: false, code } (not_found, limit, too_long). */
    set(p) {
      if (p.name.length > P.MAIL_SIGNATURE_NAME_MAX || p.text.length > P.MAIL_SIGNATURE_TEXT_MAX || !p.name.trim() || !p.text.trim()) return { ok: false, code: "too_long" };
      const held = of(p.account_id);
      if (p.signature_id && !held.signatures.some((x) => x.signature_id === p.signature_id)) return { ok: false, code: "not_found" };
      if (!p.signature_id && held.signatures.length >= P.MAIL_SIGNATURES_MAX) return { ok: false, code: "limit" };
      const one = { signature_id: p.signature_id ?? P.mintId("sig", o.random), name: p.name, text: p.text };
      const signatures = [...held.signatures.filter((x) => x.signature_id !== one.signature_id), one];
      all[p.account_id] = { signatures, default_id: p.default === true ? one.signature_id : p.default === false && held.default_id === one.signature_id ? null : held.default_id };
      save(); o.log("mail_signature", { account_id: p.account_id, signature_id: one.signature_id, outcome: "set" });
      return { ok: true, value: of(p.account_id) };
    },
    remove(accountId, signatureId) {
      const held = of(accountId);
      if (!held.signatures.some((x) => x.signature_id === signatureId)) return { ok: false, code: "not_found" };
      all[accountId] = { signatures: held.signatures.filter((x) => x.signature_id !== signatureId), default_id: held.default_id === signatureId ? null : held.default_id };
      save(); o.log("mail_signature", { account_id: accountId, signature_id: signatureId, outcome: "removed" });
      return { ok: true, value: of(accountId) };
    },
    forget(accountId) { delete all[accountId]; save(); },
  };
}
