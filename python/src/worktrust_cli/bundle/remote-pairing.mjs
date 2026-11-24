/**
 * BINDING THIS COMPUTER'S REMOTE KEYS TO THE PERSON'S ACCOUNT (2026-11-07; docs/remote-agents/ISSUER.md is the contract).
 *
 * The same shape as `worktrust connect`, on its own audience and with its own key: this terminal listens on 127.0.0.1 for
 * one answer, holds a PKCE verifier, and sends only the PUBLIC halves of a fresh remote key pair with a proof that it holds
 * them. The person approves in the Passport app, signed in, with their second factor; the browser comes back to
 * 127.0.0.1 with a one-time code that only this terminal, with its verifier, can exchange for the issuer's signed binding.
 * Without a browser (`--device`, SSH) a typed code instead. The binding is verified against the issuer keys pinned in this
 * release before anything is saved.
 *
 * TWO ROADS (owner, 2026-11-12): `remote web` opens the browser's approval page, as before; `remote app` opens nothing and
 * shows the same approval link as a QR here, which the WorkTrust app scans and approves with the authenticator (ISSUER.md
 * §2b). Nothing comes back to 127.0.0.1 from a phone, so on both roads this terminal also polls the token door with its
 * device code and verifier: a phone's approval is collected that way, a browser's still by its one-time code. A Passport app without the issuer answers 404, and this says so and changes nothing.
 * The measurement key is never read, sent or used here.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import * as P from "./remote-protocol.mjs";
import { PRODUCTION_GATEWAY } from "./remote-store.mjs";

const PROOF = P.utf8Encode("worktrust-remote/v1/pair-request\n");
const RENEW = P.utf8Encode("worktrust-remote/v1/renew\n");
export const pairProofBytes = (body) => P.concatBytes(PROOF, P.canonicalBytes(body));
export const renewBytes = (body) => P.concatBytes(RENEW, P.canonicalBytes(body));

export class IssuerMissing extends Error {}
export class PairingRefused extends Error {}
/** The request's window ended with no approval (0.11.7: the terminal offers a new QR code). */
export class PairingExpired extends PairingRefused {}
/** The person denied it on the phone or in the browser (0.11.7). */
export class PairingDenied extends PairingRefused {}
/** A new computer the issuer held for the phone's confirmation was not confirmed in its window (CLI 0.11.23, ISSUER.md §11). */
export class ConfirmationExpired extends PairingRefused {}

/**
 * THIS COMPUTER, NAMED TO THE ISSUER (CLI 0.11.23; owner, 2026-11-23; ISSUER.md §11 "A new computer waits for the phone"): the
 * 43-character hash of the machine id, the same one `api/cli/renew` receives as `device_id` (worktrust.mjs computerIds), sent
 * as `computer_id` in every POST /api/remote/token body, so the issuer computes this computer's machine reference itself
 * (never sent by the CLI) and can hold the coupling key of a computer the phone has not confirmed yet. Anything not of that
 * shape is not sent; an issuer before 2026-11-23 reads only its own fields and ignores it.
 */
export const COMPUTER_ID = /^[A-Za-z0-9_-]{43}$/;
/** The words, said once, while the issuer holds a new computer for the phone's confirmation. */
export const WAITING_FOR_PHONE = "  Waiting for confirmation on your phone.";
export const CONFIRMATION_EXPIRED = "The confirmation on your phone expired. Run `npx worktrust remote app` again.";

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

/**
 * ONE SCAN (CLI 0.11.10, owner 2026-11-14: "once you have done that, do you still have to pair? Otherwise you go through the
 * same step twice"). `remote app` draws the approval link with the PAIRING material in its fragment, which no browser sends
 * to a server: `<authorize_url>#v=1&g=<gateway>&k=<Ed25519 pub>&x=<X25519 pub>&s=<32-byte secret>&e=<expiry>` (0.11.12: the compact code, below), the pairing
 * invite of PROTOCOL.md §Pairing without `d` (the issuer names this computer's device id only when it approves). The
 * WorkTrust app's own scanner approves with the authenticator, finds this computer in the account's device list by the
 * fingerprint of `k` and `x`, and makes the invite whole with its device id; the daemon then confirms the phone by the
 * secret's proof, exactly as a scanned `remote pair` QR. The camera app or a browser opens the approve link and ignores the
 * fragment: pairing a phone is then the second step it always was (`linkPhone` shows the QR after its wait).
 */
export const ONE_SCAN_KEYS = Object.freeze(["v", "g", "k", "x", "s", "e"]);
/**
 * 0.11.12 (owner, 2026-11-15: "the QR must be about 4 x 4 cm"): for WorkTrust's own relay the fragment is the COMPACT code of
 * remote-protocol pairing.ts (a 16-byte seed, a 128-bit commitment to `k` and `x`, the expiry; 58 base32 characters), the
 * same one the pairing QR draws; the secret `s` is the seed expanded, so the daemon's invite is unchanged. Another relay keeps
 * the long fragment above. The WorkTrust app reads both since build 17 (docs/OPEN.md: build 16 reads only the long one).
 */
export function oneScan({ gateway, publicKeys, nowMs, random }) {
  if (!gateway || !P.isGatewayOrigin(gateway)) return null;
  const seed = random(P.PAIRING_SEED_BYTES);
  const fields = { v: 1, g: gateway, k: publicKeys.ed25519_pub, x: publicKeys.x25519_pub, s: P.expandPairingSeed(seed), e: Math.floor(nowMs / 1000) + P.PAIRING_INVITE_LIFETIME_S };
  const fragment = gateway === PRODUCTION_GATEWAY ? P.encodeCompactPairing({ seed, commitment: P.deviceCommitment(publicKeys), e: fields.e }) : ONE_SCAN_KEYS.map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`).join("&");
  return { ...fields, seed: P.toBase64Url(seed), fragment };
}
/**
 * THE QR'S OWN, SHORTER FORM OF A LINK (owner, 2026-11-14: "make the QR more compact"): `g` is left out when it names
 * WorkTrust's production relay, the one the phone assumes when `g` is missing (CLI 0.11.10 with the app's 2026-11-14
 * JavaScript, which reads both forms). Since 0.11.12 only a long link meets it (another relay, or an invite without a seed).
 */
const DEFAULT_G = `&g=${encodeURIComponent(PRODUCTION_GATEWAY)}`;
export const compactForQr = (link) => link.replace(DEFAULT_G, "");
/**
 * A PAIRING INVITE WHOSE SECRET COMES FROM A 16-BYTE SEED (0.11.12): the long invite of PROTOCOL.md §Pairing (its `s` the seed
 * expanded, ten minutes), checked by the protocol's own encoder, with the seed kept beside it for the compact QR.
 */
export function seededInvite({ gateway, deviceId, publicKeys, nowMs, random }) {
  const seed = random(P.PAIRING_SEED_BYTES);
  const invite = { v: 1, g: gateway, d: deviceId, k: publicKeys.ed25519_pub, x: publicKeys.x25519_pub, s: P.expandPairingSeed(seed), e: Math.floor(nowMs / 1000) + P.PAIRING_INVITE_LIFETIME_S };
  P.encodePairingInvite(invite);
  return { ...invite, seed: P.toBase64Url(seed) };
}
/** The long link of an invite (its seven keys, whatever else it carries beside them). */
export const inviteLink = (invite) => P.encodePairingInvite({ v: invite.v, g: invite.g, d: invite.d, k: invite.k, x: invite.x, s: invite.s, e: invite.e });
/**
 * WHAT THE PAIRING QR DRAWS (0.11.12): for WorkTrust's relay and an invite with its seed, the compact code
 * `https://app.worktrust.io/remote/pair#<58 characters>` (version 4 at level L, 33 modules); else the long link without the
 * default `g` (version 9 or more). The seed must expand to the invite's own secret, so the code can only name this invite.
 */
export function pairingQrText(invite) {
  const seed = typeof invite.seed === "string" ? P.fromBase64Url(invite.seed) : null;
  if (seed?.length === P.PAIRING_SEED_BYTES && invite.g === PRODUCTION_GATEWAY && P.expandPairingSeed(seed) === invite.s)
    return `${P.PAIRING_LINK_BASE}#${P.encodeCompactPairing({ seed, commitment: P.deviceCommitment({ ed25519_pub: invite.k, x25519_pub: invite.x }), e: invite.e })}`;
  return compactForQr(inviteLink(invite));
}
/** The approval link with the pairing material in its fragment, or the link as it was (no gateway, the browser's road). */
export const withPairing = (url, once) => (once ? `${url}#${once.fragment}` : url);
/** The invite the daemon reads (invite.json) once the issuer named this computer: the one-scan secret, now with its `d`; checked by the protocol's own encoder. */
export function oneScanInvite(once, deviceId, code, nowMs) {
  const invite = { v: once.v, g: once.g, d: deviceId, k: once.k, x: once.x, s: once.s, e: once.e };
  P.encodePairingInvite(invite);
  return { ...invite, ...(once.seed ? { seed: once.seed } : {}), code, used: false, created_at: nowMs };
}

/** Which road, the app's QR here (Enter) or the browser; not a terminal, or --yes: the browser. Since 0.11.7 the person names the road (`remote app` | `remote web`, or the menu); kept for a caller that asks. */
export async function chooseRoad({ interactive = Boolean(process.stdin.isTTY), yes = false, prompt = null } = {}) {
  if (!interactive || yes) return "web";
  const rl = prompt ? null : createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await (prompt ?? ((q) => rl.question(q)))("  Approve with the WorkTrust app (QR here) or in the browser? [A/w] ")).trim().toLowerCase();
  rl?.close();
  return ["w", "web", "b", "browser"].includes(answer) ? "web" : "app";
}

/**
 * Pair, and return the verified binding. `keys` holds the secret pair (never sent), `issuerKeys` the pinned keys. `road`:
 * "web" opens the approval page in the browser; "app" draws its link with `showQr` for the WorkTrust app and opens nothing.
 */
export async function pairComputer({ origin, secret, publicKeys, host, os, device = false, road = "web", showQr = () => {}, issuerKeys, say, openBrowser, now = Date.now, countdown = null, once = null, showLink = false, computerId = null }) {
  const verifier = randomBytes(32).toString("base64url");
  const named = typeof computerId === "string" && COMPUTER_ID.test(computerId) ? { computer_id: computerId } : {};
  let pairingCode = null, waitingSaid = false;
  const tokenAsk = (extra = {}) => post(origin, "/api/remote/token", { device_code: pairingCode, ...extra, code_verifier: verifier, ...named });
  /** A token answer that names the phone's confirmation (CLI 0.11.23): said once, then polled on; its expiry ends the pairing. */
  const confirming = (reply) => {
    const error = reply?.json?.error;
    if (error === "pending_expired") { settle(CONFIRMATION_EXPIRED); throw new ConfirmationExpired("pairing ended (pending_expired)"); }
    if (error !== "pending_confirmation") return false;
    if (!waitingSaid) { waitingSaid = true; say(WAITING_FOR_PHONE); }
    return true;
  };
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
  let bar = null;
  const settle = (line) => { bar?.stop(line); bar = null; };
  try {
    const pairing = await post(origin, "/api/remote/pair", { flow: device ? "device" : "loopback", host, os, ...claim, code_challenge_method: "S256", proof, ...(device ? {} : { port: server.address().port, state }) }).catch(() => null);
    if (!pairing) throw new PairingRefused(`cannot reach ${origin}`);
    if (pairing.status === 404) throw new IssuerMissing(`${origin} has no remote-key issuer yet (POST /api/remote/pair answered 404). Nothing was changed; remote control needs a Passport app with the issuer (docs/remote-agents/ISSUER.md).`);
    if (pairing.status !== 200) throw new PairingRefused(`pairing refused (${pairing.json.error ?? pairing.status})`);
    const { device_code, user_code, expires_in = 600, interval = 3, authorize_url, verification_uri, features = [] } = pairing.json;
    pairingCode = device_code;
    // THE WINDOW IS THE ISSUER'S (0.11.7): its expires_at when it says one, else its expires_in from now; the bar drains over it.
    const asked = now(), until = Number.isFinite(pairing.json.expires_at) ? pairing.json.expires_at : asked + expires_in * 1000;
    if (!features.includes("remote-binding-v1")) throw new PairingRefused(`${origin} does not offer remote bindings (remote-binding-v1)`);
    const fingerprint = P.deviceFingerprint(publicKeys);
    say(`  Your code: ${user_code}   This computer's remote key: ${fingerprint}`);
    say("  Approve only if the WorkTrust page shows the same code and key.");
    let exchanged = null;
    if (!device) {
      if (road === "app") {
        // One scan (0.11.10): the app's scanner approves AND links this phone; the camera app only approves.
        say(once ? "  Scan this in the WorkTrust app (Scan › Connect agent): approve with your authenticator code, and the phone links too." : "  Scan this with the WorkTrust app (or the phone's camera) and approve with your authenticator code:");
        // Room around the code (0.11.12, owner 2026-11-15): one empty line above it and one below.
        say("");
        showQr(withPairing(authorize_url, once));
        say("");
        // The printed link leaves the pairing secret out (scrollback, a shared screen; review 2026-11-14, P3-7): the QR carries
        // it, and --show-link prints it whole for a phone that cannot scan.
        say(`  Link: ${showLink ? withPairing(authorize_url, once) : authorize_url}`);
      } else {
        say(`  Approve in your browser (opening it). If it does not open: ${authorize_url}`);
        openBrowser(authorize_url);
      }
      // The browser's one-time code arrives at 127.0.0.1; a phone's approval only by polling (device code and verifier).
      let code = null;
      void answer.then((c) => { code = c; });
      bar = countdown?.({ expiresAt: until, windowMs: until - asked }) ?? null;
      let wait = Math.max(1, interval) * 1000;
      while (!code && !exchanged && now() < until) {
        await Promise.race([answer, new Promise((resolve) => setTimeout(resolve, wait))]);
        if (code) break;
        const reply = await tokenAsk().catch(() => null);
        if (reply?.status === 200) exchanged = reply;
        else if (confirming(reply)) continue;
        else if (reply?.json?.error === "slow_down") wait += 2000;
        else if (reply?.json?.error === "access_denied") { settle(`Denied ${road === "app" ? "on your phone" : "in the browser"}. Nothing was changed.`); throw new PairingDenied("pairing ended (access_denied)"); }
        else if (reply?.json?.error === "expired_token") { settle("This request expired."); throw new PairingExpired("pairing ended (expired_token)"); }
        // authorization_pending, or invalid_grant from an issuer before 2026-11-12 (no codeless loopback poll): wait on.
      }
      if (!exchanged && !code) { settle("This request expired."); throw new PairingExpired("no approval arrived in time"); }
      settle(code || road !== "app" ? "✓ Approved in the browser" : "✓ Approved on your phone");
      if (!exchanged) exchanged = await tokenAsk({ code });
      if (exchanged?.json?.error === "pending_expired") confirming(exchanged); // a code's exchange is one ask: nothing to wait on, only the expiry to name
    } else {
      say(`  On any device open ${verification_uri} and type the code.`);
      bar = countdown?.({ expiresAt: until, windowMs: until - asked }) ?? null;
      let wait = interval * 1000;
      while (now() < until) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        const reply = await tokenAsk().catch(() => null);
        if (reply?.status === 200) { exchanged = reply; settle("✓ Approved"); break; }
        if (confirming(reply)) continue;
        if (reply?.json?.error === "slow_down") wait += 2000;
        else if (reply?.json?.error === "access_denied") { settle("Denied. Nothing was changed."); throw new PairingDenied("pairing ended (access_denied)"); }
        else if (reply?.json?.error === "expired_token") { settle("This request expired."); throw new PairingExpired("pairing ended (expired_token)"); }
        else if (reply?.json?.error && reply.json.error !== "authorization_pending") { settle(); throw new PairingRefused(`pairing ended (${reply.json.error})`); }
      }
      if (!exchanged) { settle("This request expired."); throw new PairingExpired("no approval arrived in time"); }
    }
    if (!exchanged || exchanged.status !== 200 || typeof exchanged.json.binding !== "string") throw new PairingRefused(`the approval could not be exchanged (${exchanged?.json?.error ?? "no answer"})`);
    if (Object.keys(issuerKeys).length === 0) throw new PairingRefused("this release pins no WorkTrust issuer key yet, so the binding cannot be verified; nothing was saved");
    const verified = P.verifyBinding(exchanged.json.binding, { issuerKeys, now: now(), kind: "computer", deviceId: exchanged.json.device_id });
    if (!verified.ok) throw new PairingRefused(`the binding does not verify (${verified.code}); nothing was saved`);
    if (verified.value.ed25519_pub !== publicKeys.ed25519_pub || verified.value.x25519_pub !== publicKeys.x25519_pub) throw new PairingRefused("the binding names other keys; nothing was saved");
    // HELD FOR THE PHONE (CLI 0.11.23): the binding is issued, the computer waits until the person confirms it on the phone.
    const pending = exchanged.json.confirmation === "phone" || exchanged.json.status === "pending_confirmation";
    return { binding: exchanged.json.binding, device_id: verified.value.device_id, sub: verified.value.sub, exp: verified.value.exp, account: typeof exchanged.json.account === "string" ? exchanged.json.account.slice(0, 120) : null, pending };
  } finally { settle(); server?.close(); }
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
  const reply = await assertionReply({ origin, deviceId, secret, now, random });
  return reply?.status === 200 && typeof reply.json.assertion === "string" && reply.json.assertion.length <= 4096 ? reply.json.assertion : null;
}
/** The issuer's whole answer to an assertion request, or null when it is unreachable. */
async function assertionReply({ origin, deviceId, secret, now = Date.now, random = (n) => new Uint8Array(randomBytes(n)) }) {
  const body = { device_id: deviceId, iat: now(), nonce: P.toBase64Url(random(32)) };
  return post(origin, "/api/remote/assertion", { ...body, signature: P.toBase64Url(P.ed25519Sign(P.assertionRequestBytes(body), secret.ed25519)) }).catch(() => null);
}

export const CONFIRM_POLL_MS = 5_000;
export const CONFIRM_WAIT_MS = 10 * 60_000;
/**
 * WAITING FOR THE PHONE (CLI 0.11.23; ISSUER.md §11): a computer the issuer created pending gets no assertion until the person
 * confirms it on the phone (403 `pending_confirmation`), and is revoked when they say it is not theirs (403 `revoked`) or its
 * window passed (403 `pending_expired`). This asks for an assertion every few seconds, as the pairing polls for an approval,
 * and answers `confirmed`, `expired`, `refused`, `waiting` (this terminal's ten minutes passed; the service keeps asking), or
 * another refusal's own word. Says the waiting line once. An assertion it is handed is not kept: the service asks its own.
 */
export async function awaitConfirmation({ origin, deviceId, secret, say, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), every = CONFIRM_POLL_MS, waitMs = CONFIRM_WAIT_MS, random }) {
  say(WAITING_FOR_PHONE);
  const until = now() + waitMs;
  while (now() < until) {
    const reply = await assertionReply({ origin, deviceId, secret, now, ...(random ? { random } : {}) });
    if (reply?.status === 200 && typeof reply.json?.assertion === "string") return "confirmed";
    const error = reply?.json?.error ?? null;
    if (error === "pending_expired") return "expired";
    if (error === "revoked") return "refused";
    // Still pending, paced, or the issuer not answering: wait on. Anything else is the issuer's own word, returned.
    if (error !== null && error !== "pending_confirmation" && error !== "rate_limited" && error !== "unavailable") return error;
    await sleep(error === "rate_limited" ? every * 3 : every);
  }
  return "waiting";
}

/**
 * THE DEVICES' COUNTS, REPORTED TO THE ISSUER (CLI 0.11.23; owner, 2026-11-23; ISSUER.md §13, POST /api/remote/counts). The
 * daemon counts per phone and browser in memory (remote-store.mjs createDeviceCounts) and its flush, at most once a minute,
 * hands the deltas here (`add`). `tick` sends them at most once a minute, only when something is owed: one report, a fresh
 * `rpt_` id, at most fifty devices, signed by this computer's remote key over deviceCountsBytes. Counts only, never content.
 *   200 ok / duplicate   forgotten
 *   429 (paced, rate)    the deltas folded back into what is owed, sent next time under a NEW id
 *   503, no answer, 401  the same report again next time, the same id (the issuer takes an id once)
 *   400                  dropped (it can never be taken); 403 revoked or 404 (an issuer without the door): no report again
 * Kept in memory only: a stop sends what it can once, and the local history keeps every count anyway.
 */
export const COUNTS_EVERY_MS = 60_000;
const COUNT_KEYS = ["sessions", "commands", "prompts", "voice_prompts"];
const foldCounts = (into, entry) => {
  const c = into.get(entry.device_id) ?? { device_id: entry.device_id };
  for (const k of COUNT_KEYS) if (Number.isSafeInteger(entry[k])) c[k] = Math.min(1_000_000, (c[k] ?? 0) + entry[k]);
  if (Number.isSafeInteger(entry.last_seen)) c.last_seen = Math.max(c.last_seen ?? 0, entry.last_seen);
  into.set(entry.device_id, c);
};
export function createCountsReporter({ origin, deviceId, secret, now = Date.now, random = (n) => new Uint8Array(randomBytes(n)), log = () => {}, everyMs = COUNTS_EVERY_MS }) {
  const owed = new Map();
  let report = null, sentAt = -Infinity, stopped = false, busy = false;
  return {
    add(entries) { if (!stopped) for (const e of entries ?? []) if (P.isOpaqueId(e?.device_id, "dev")) foldCounts(owed, e); },
    async tick(force = false) {
      if (stopped || busy || (!force && now() - sentAt < everyMs)) return null;
      if (!report && owed.size === 0) return null;
      if (!report) { const devices = [...owed.values()].slice(0, 50); for (const d of devices) owed.delete(d.device_id); report = { report_id: P.mintId("rpt", random), devices }; }
      busy = true; sentAt = now();
      try {
        const body = { device_id: deviceId, devices: report.devices, iat: now(), report_id: report.report_id };
        const reply = await post(origin, "/api/remote/counts", { ...body, signature: P.deviceSign(P.deviceCountsBytes(body), secret.ed25519) }).catch(() => null);
        const error = reply?.json?.error ?? null;
        if (reply?.status === 200) { report = null; return reply.json.outcome ?? "ok"; }
        if (reply?.status === 429) { for (const d of report.devices) foldCounts(owed, d); report = null; return error ?? "paced"; }
        if (reply?.status === 403 || reply?.status === 404) { stopped = true; owed.clear(); report = null; log("counts_stopped", { status: reply.status }); return "stopped"; }
        if (reply?.status === 400) { report = null; log("counts_refused", {}); return "invalid"; }
        return "retry"; // 503, 401, no answer: the same id next time
      } finally { busy = false; }
    },
  };
}
