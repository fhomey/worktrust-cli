/**
 * A PHONE ADDS A BROWSER TO THIS COMPUTER (2026-11-09, docs/remote-agents/PROTOCOL.md §A phone endorses a browser). The
 * daemon's decision on a sealed `browser.endorse`, pure: it takes the state and answers the next state, so
 * scripts/check-remote-cli.mjs proves each refusal on its own. The browser becomes a controller ONLY when all hold:
 *   1. this computer allowed endorsements at its keyboard (`worktrust remote phones allow-endorse on`; default off);
 *   2. the sender is a controller confirmed here at the keyboard or by a scanned QR, never one added by endorsement (no
 *      chains: an endorsed browser endorses nobody);
 *   3. the browser's issuer binding verifies, as a controller, for THIS computer's own account (crypto/endorse.ts);
 *   4. the endorsement is in time (five minutes at most) and its nonce was never spent here (single use).
 * The browser is listed with who added it and when; removing the endorsing phone later does not remove the browsers it
 * added (each stays revocable here and in WorkTrust, and `remote phones` names the phone that added it).
 */
import * as P from "./remote-protocol.mjs";

const KEEP_SPENT_MS = (P.ENDORSE_LIFETIME_S * 1000) + 10 * 60_000;
const MAX_SPENT = 200;

/**
 * → { ok: true, phones, spent, added } | { ok: false, reason } where reason is a protocol reject reason:
 * `not_allowed` (no opt-in, a sender that may not, another account, a binding that does not verify), `expired`, `conflict`
 * (a nonce already spent). An endorsement of a browser already confirmed is taken again without a change.
 */
export function acceptEndorsement({ allowed, phones, spent, sender, payload, issuerKeys, account, now }) {
  if (allowed !== true) return { ok: false, reason: "not_allowed" };
  const from = phones.confirmed.find((p) => p.device_id === sender);
  if (!from || (from.how !== "keyboard" && from.how !== "qr")) return { ok: false, reason: "not_allowed" };
  const checked = P.checkEndorsement(payload, { issuerKeys, now, account });
  if (!checked.ok) return { ok: false, reason: checked.code === "expired" ? "expired" : "not_allowed" };
  const live = (spent ?? []).filter((s) => s.at + KEEP_SPENT_MS > now);
  if (live.some((s) => s.nonce === checked.value.nonce)) return { ok: false, reason: "conflict" };
  const b = checked.value;
  const nextSpent = [...live, { nonce: b.nonce, at: now }].slice(-MAX_SPENT);
  if (phones.confirmed.some((p) => p.fingerprint === b.fingerprint)) return { ok: true, phones, spent: nextSpent, added: null };
  const browser = { device_id: b.device_id, fingerprint: b.fingerprint, ed25519_pub: b.keys.ed25519_pub, x25519_pub: b.keys.x25519_pub, how: "endorsed", confirmed_at: now,
    endorsed_by: { device_id: from.device_id, fingerprint: from.fingerprint } };
  return {
    ok: true,
    spent: nextSpent,
    added: browser,
    phones: { ...phones, pending: phones.pending.filter((p) => p.fingerprint !== b.fingerprint), removed: (phones.removed ?? []).filter((p) => p.device_id !== b.device_id),
      confirmed: [...phones.confirmed.filter((p) => p.fingerprint !== b.fingerprint), browser] },
  };
}
