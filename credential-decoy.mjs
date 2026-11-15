/**
 * DECOY CREDENTIALS, A TRIPWIRE (owner, 2026-11-15, B18; the honeywords pattern, Juels & Rivest 2013; SECURITY.md §Decoy
 * credentials). Beside the real coupling in ~/.worktrust this writes credential files in the real file's exact legacy
 * format (base64 of the same JSON: url, a `wt_` token of the real shape, an Ed25519 device key, the dates, the masked
 * account), each with its own fresh random token and key. No legitimate path ever reads or sends one: the CLI, the hook
 * and the MCP bridge read only key.json (credential-store.mjs); scripts/test-cli-decoys.mjs proves no module but this one
 * names a decoy file, and that this module sends only SHA-256 hashes. WorkTrust keeps those hashes per computer under the
 * owner (POST /api/cli/decoys, signed by this computer's own key); a decoy presented at any token door ends every Remote
 * Agent link of the account at once and mails the owner.
 *
 *   PROTECTED (the OS keystore seals the real secret: key.json is an envelope that opens nowhere else): FIVE decoys. Every
 *     readable credential in the folder is then a decoy, so a copy of the folder holds only decoys and any use trips.
 *   FILE MODE (no keystore: the real key must stay a readable file): NINE decoys beside key.json. key.json is the name the
 *     open-source CLI reads, so an attacker who reads the code knows which file is real; the decoys catch the copy that is
 *     used without reading it (an automated stealer, a careless replay): one of ten files picked blind is a decoy nine
 *     times in ten, and trying them all always trips. The keystore mode is the real protection; file mode is detection.
 *
 * Written only after WorkTrust confirmed the hashes, so no decoy exists that would not trip. Never throws, never prints,
 * never asks: a failure leaves the folder as it was and the next `update` tries again.
 */
import { createHash, generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./package-integrity.mjs";

/**
 * Plausible names in the real file's folder, in the order they are used (five protected, nine in file mode). Each reads as
 * ANOTHER credential, never as a backup of key.json: a name that suggests a restore invites the owner to trip the wire
 * (audit B18 P3c).
 */
export const DECOY_NAMES = Object.freeze(["credentials.json", "mcp-key.json", "api-key.json", "token.json", "auth.json", "session-key.json", "bridge-key.json", "access-token.json", "device-key.json"]);
export const DECOYS_PROTECTED = 5;
export const DECOYS_FILE_MODE = 9;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const DAY = 24 * 3600_000;

/** One decoy entry, the real entry's shape with every secret its own. */
function decoyEntry(real, now) {
  const device = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  const renewedAt = new Date(now - randomInt(1, 7 * DAY)).toISOString();
  const coupledAt = new Date(Date.parse(real.coupledAt ?? "") || now - randomInt(30 * DAY, 120 * DAY)).toISOString();
  return { url: real.url, token: `wt_${randomBytes(32).toString("base64url")}`, renewedAt, coupledAt, identified: true, ...(real.profile ? { profile: real.profile } : {}), ...(real.account ? { account: real.account } : {}), ...(real.accountRef ? { accountRef: real.accountRef } : {}), device };
}

/** Whether this folder already holds decoys (`update` plants once). */
export const decoysPlanted = (dir) => DECOY_NAMES.some((name) => existsSync(join(dir, name)));

/**
 * Make, register and write the decoys. `key` is the real entry (its token and device sign the ONE request, as every CLI
 * door asks); `proof` is the CLI's WorkTrust-Proof builder; `once` skips a folder that already holds decoys. Answers what
 * happened: "planted", "present", "skipped" (no bound key), "refused" or "offline". The decoy tokens leave this function
 * only as files; the network sees their hashes.
 */
export async function plantDecoys({ dir, key, protectedMode, proof, agent, once = false, fetchImpl = fetch, now = Date.now() }) {
  try {
    if (!key?.token || !key.device || !key.url) return "skipped";
    if (once && decoysPlanted(dir)) return "present";
    const names = DECOY_NAMES.slice(0, protectedMode ? DECOYS_PROTECTED : DECOYS_FILE_MODE);
    const entries = names.map(() => decoyEntry(key, now));
    // Never the real token (a 2^-256 chance, refused here and by the database all the same).
    if (entries.some((entry) => entry.token === key.token)) return "refused";
    const url = new URL("/api/cli/decoys", key.url).href;
    const body = JSON.stringify({ hashes: entries.map((entry) => sha256(entry.token)) });
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.token}`, "user-agent": agent, ...proof(key.device, url, body) }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
    } catch { return "offline"; }
    if (!response.ok || (await response.json().catch(() => null))?.outcome !== "registered") return "refused";
    names.forEach((name, i) => writePrivateFile(join(dir, name), Buffer.from(JSON.stringify(entries[i])).toString("base64")));
    return "planted";
  } catch {
    return "refused";
  }
}
