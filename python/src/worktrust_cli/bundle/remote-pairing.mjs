/**
 * BINDING THIS COMPUTER'S REMOTE KEYS TO THE PERSON'S ACCOUNT (2026-11-07; docs/remote-agents/ISSUER.md is the contract).
 *
 * The same shape as `worktrust connect`, on its own audience and with its own key: this terminal listens on 127.0.0.1 for
 * one answer, holds a PKCE verifier, and sends only the PUBLIC halves of a fresh remote key pair with a proof that it holds
 * them. The person approves in the Passport app, signed in, with their second factor; the browser comes back to
 * 127.0.0.1 with a one-time code that only this terminal, with its verifier, can exchange for the issuer's signed binding.
 * Without a browser (`--device`, SSH) a typed code instead. The binding is verified against the issuer keys pinned in this
 * release before anything is saved. A Passport app without the issuer answers 404, and this says so and changes nothing.
 * The measurement key is never read, sent or used here.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import * as P from "./remote-protocol.mjs";

const PROOF = P.utf8Encode("worktrust-remote/v1/pair-request\n");
const RENEW = P.utf8Encode("worktrust-remote/v1/renew\n");
export const pairProofBytes = (body) => P.concatBytes(PROOF, P.canonicalBytes(body));
export const renewBytes = (body) => P.concatBytes(RENEW, P.canonicalBytes(body));

export class IssuerMissing extends Error {}
export class PairingRefused extends Error {}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

/** Pair, and return the verified binding. `keys` holds the secret pair (never sent), `issuerKeys` the pinned keys. */
export async function pairComputer({ origin, secret, publicKeys, host, os, device = false, issuerKeys, say, openBrowser, now = Date.now }) {
  const verifier = randomBytes(32).toString("base64url");
  const code_challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const claim = { code_challenge, ed25519_pub: publicKeys.ed25519_pub, kind: "computer", x25519_pub: publicKeys.x25519_pub };
  const proof = P.toBase64Url(P.ed25519Sign(pairProofBytes(claim), secret.ed25519));
  let server = null, deliver = null;
  const answer = new Promise((resolve) => { deliver = resolve; });
  if (!device) {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("This computer is approved for WorkTrust remote. Return to your terminal.");
      deliver(url.searchParams.get("code"));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  try {
    const pairing = await post(origin, "/api/remote/pair", { flow: device ? "device" : "loopback", host, os, ...claim, code_challenge_method: "S256", proof, ...(device ? {} : { port: server.address().port, state }) }).catch(() => null);
    if (!pairing) throw new PairingRefused(`cannot reach ${origin}`);
    if (pairing.status === 404) throw new IssuerMissing(`${origin} has no remote-key issuer yet (POST /api/remote/pair answered 404). Nothing was changed; remote control needs a Passport app with the issuer (docs/remote-agents/ISSUER.md).`);
    if (pairing.status !== 200) throw new PairingRefused(`pairing refused (${pairing.json.error ?? pairing.status})`);
    const { device_code, user_code, expires_in = 600, interval = 3, authorize_url, verification_uri, features = [] } = pairing.json;
    if (!features.includes("remote-binding-v1")) throw new PairingRefused(`${origin} does not offer remote bindings (remote-binding-v1)`);
    const fingerprint = P.deviceFingerprint(publicKeys);
    say(`  Your code: ${user_code}   This computer's remote key: ${fingerprint}`);
    say("  Approve only if the WorkTrust page shows the same code and key.");
    let exchanged = null;
    if (!device) {
      say(`  Approve in your browser (opening it). If it does not open: ${authorize_url}`);
      openBrowser(authorize_url);
      const timer = setTimeout(() => deliver(null), expires_in * 1000);
      const code = await answer;
      clearTimeout(timer);
      if (!code) throw new PairingRefused("no approval arrived in time");
      exchanged = await post(origin, "/api/remote/token", { device_code, code, code_verifier: verifier });
    } else {
      say(`  On any device open ${verification_uri} and type the code.`);
      const until = now() + expires_in * 1000;
      let wait = interval * 1000;
      while (now() < until) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const reply = await post(origin, "/api/remote/token", { device_code, code_verifier: verifier }).catch(() => null);
        if (reply?.status === 200) { exchanged = reply; break; }
        if (reply?.json?.error === "slow_down") wait += 2000;
        else if (reply?.json?.error && reply.json.error !== "authorization_pending") throw new PairingRefused(`pairing ended (${reply.json.error})`);
      }
    }
    if (!exchanged || exchanged.status !== 200 || typeof exchanged.json.binding !== "string") throw new PairingRefused(`the approval could not be exchanged (${exchanged?.json?.error ?? "no answer"})`);
    if (Object.keys(issuerKeys).length === 0) throw new PairingRefused("this release pins no WorkTrust issuer key yet, so the binding cannot be verified; nothing was saved");
    const verified = P.verifyBinding(exchanged.json.binding, { issuerKeys, now: now(), kind: "computer", deviceId: exchanged.json.device_id });
    if (!verified.ok) throw new PairingRefused(`the binding does not verify (${verified.code}); nothing was saved`);
    if (verified.value.ed25519_pub !== publicKeys.ed25519_pub || verified.value.x25519_pub !== publicKeys.x25519_pub) throw new PairingRefused("the binding names other keys; nothing was saved");
    return { binding: exchanged.json.binding, device_id: verified.value.device_id, sub: verified.value.sub, exp: verified.value.exp, account: typeof exchanged.json.account === "string" ? exchanged.json.account.slice(0, 120) : null };
  } finally { server?.close(); }
}

/** A fresh binding for the same keys before the old one ends (POST /api/remote/renew). Null when the issuer has none. */
export async function renewBinding({ origin, identity, secret, now = Date.now }) {
  const jti = JSON.parse(Buffer.from(identity.binding.split(".")[1], "base64url").toString("utf8")).jti;
  const body = { binding_jti: jti, device_id: identity.device_id, iat: now() };
  const reply = await post(origin, "/api/remote/renew", { binding: identity.binding, iat: body.iat, signature: P.toBase64Url(P.ed25519Sign(renewBytes(body), secret.ed25519)) }).catch(() => null);
  return reply?.status === 200 && typeof reply.json.binding === "string" ? reply.json.binding : null;
}

/**
 * A FIVE-MINUTE GATEWAY ASSERTION (POST /api/remote/assertion, ISSUER.md §5): asked fresh for every gateway challenge,
 * signed by this computer's REMOTE key over its device id, the time and a fresh nonce. Null when the issuer refuses or is
 * unreachable: the gateway then refuses this connection and the transport backs off; nothing else changes.
 */
export async function requestAssertion({ origin, deviceId, secret, now = Date.now, random = (n) => new Uint8Array(randomBytes(n)) }) {
  const body = { device_id: deviceId, iat: now(), nonce: P.toBase64Url(random(32)) };
  const reply = await post(origin, "/api/remote/assertion", { ...body, signature: P.toBase64Url(P.ed25519Sign(P.assertionRequestBytes(body), secret.ed25519)) }).catch(() => null);
  return reply?.status === 200 && typeof reply.json.assertion === "string" && reply.json.assertion.length <= 4096 ? reply.json.assertion : null;
}
