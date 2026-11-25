/**
 * OUTLOOK AND MICROSOFT 365 OVER MICROSOFT GRAPH, PLAIN fetch (docs/remote-agents/MAIL.md §Providers; owner, 2026-11-24).
 *
 *   sign-in   authorization code with PKCE on a loopback port of THIS computer: a server on 127.0.0.1, the person's own
 *             browser opened here, scopes openid offline_access User.Read Mail.ReadWrite Mail.Send. The client id comes from
 *             the CLI's configuration: GRAPH_CLIENT_ID below is EMPTY until the owner registers the Entra app, and
 *             WORKTRUST_MAIL_ENTRA_CLIENT_ID stands in for it; without either, an outlook account is `not_configured`.
 *   read      delta per folder (inbox, sentitems) with Prefer odata.maxpagesize=50 and IdType="ImmutableId"; the baseline
 *             is the last 30 days; a deltaLink per folder; 410 means a full resync; a body as text on request
 *   send      after the phone's approval only (remote-mail-outbox.mjs): createReply / createReplyAll / createForward or
 *             POST messages, PATCH the draft, POST /send (202). A send call is never repeated: a 5xx is `rejected`, a lost
 *             connection `interrupted`; a token is refreshed BEFORE a send, never by repeating one after a 401
 *   limits    at most four requests at once per mailbox
 * The endpoints are constants; a test hands in its own through code (`hosts`), never through the environment.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { basicToHtml } from "./remote-mail-mime.mjs";

export const GRAPH_CLIENT_ID = ""; // PLACEHOLDER: set when the owner has registered the Entra app (MAIL.md §Open 2)
/** Graph's simple file attachment takes at most 3 MiB a file (an upload session takes more: later work, MAIL.md). */
export const GRAPH_SIMPLE_ATTACHMENT = 3 * 1024 * 1024;
export const GRAPH_SCOPES = "openid offline_access User.Read Mail.ReadWrite Mail.Send";
export const GRAPH_HOSTS = Object.freeze({ graph: "https://graph.microsoft.com/v1.0", login: "https://login.microsoftonline.com/common/oauth2/v2.0" });
export const graphClientId = (env = process.env) => (GRAPH_CLIENT_ID || (/^[0-9a-f-]{36}$/i.test(env.WORKTRUST_MAIL_ENTRA_CLIENT_ID ?? "") ? env.WORKTRUST_MAIL_ENTRA_CLIENT_ID : "")) || null;
const SELECT = "id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,isRead,flag,hasAttachments,bodyPreview,categories";
const FOLDERS = Object.freeze([["inbox", "inbox"], ["sentitems", "sent"]]);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function pkce() { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }; }

async function tokenCall(hosts, form, fetchImpl) {
  const res = await fetchImpl(`${hosts.login}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.access_token !== "string") return null;
  return { access_token: json.access_token, refresh_token: json.refresh_token ?? form.refresh_token ?? null, expires_at: Date.now() + Math.max(60, Number(json.expires_in) || 3600) * 1000 };
}

/**
 * The browser sign-in, ON THIS COMPUTER. → { ok: true, tokens } or { ok: false, code } (`not_configured`, `auth_failed`,
 * `timeout`). `open(url)` opens the person's browser; the code comes back to 127.0.0.1 only, its `state` checked.
 */
export function signIn({ clientId, address, open, hosts = GRAPH_HOSTS, fetchImpl = fetch, timeoutMs = 300_000 }) {
  if (!clientId) return Promise.resolve({ ok: false, code: "not_configured" });
  const { verifier, challenge } = pkce(), state = b64url(randomBytes(16));
  return new Promise((resolve) => {
    let done = false, redirect = null;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); server.close(); resolve(value); };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/" || url.searchParams.get("state") !== state) { res.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(code ? "WorkTrust: signed in. You can close this window." : "WorkTrust: sign-in was not completed.");
      if (!code) return finish({ ok: false, code: "auth_failed" });
      const tokens = await tokenCall(hosts, { client_id: clientId, grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, scope: GRAPH_SCOPES }, fetchImpl).catch(() => null);
      finish(tokens ? { ok: true, tokens } : { ok: false, code: "auth_failed" });
    });
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${server.address().port}/`; // the loopback literal Entra prefers for a public client: no ::1 lookup
      const q = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirect, response_mode: "query", scope: GRAPH_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", ...(address ? { login_hint: address } : {}) });
      Promise.resolve(open(`${hosts.login}/authorize?${q}`)).catch(() => finish({ ok: false, code: "auth_failed" }));
    });
  });
}

const person = (r) => (r?.emailAddress?.address ? { name: r.emailAddress.name || null, address: String(r.emailAddress.address).toLowerCase() } : null);
/** A Graph message as the sync engine's normalised message (remote-mail-sync.mjs). */
export function normalise(m, folder) {
  return {
    remote_ref: m.id, folder, header_message_id: m.internetMessageId ?? null, references: [], in_reply_to: null, thread_key: m.conversationId ? `graph:${m.conversationId}` : null,
    from: person(m.from) ?? { name: null, address: "unknown@unknown.invalid" }, to: (m.toRecipients ?? []).map(person).filter(Boolean), cc: (m.ccRecipients ?? []).map(person).filter(Boolean),
    reply_to: (m.replyTo ?? []).map(person).filter(Boolean), date: Date.parse(m.receivedDateTime) || 0, subject: m.subject ?? "", text: m.bodyPreview ?? "", text_is_preview: true,
    unread: m.isRead === false, starred: m.flag?.flagStatus === "flagged", has_attachments: m.hasAttachments === true, attachments: [], labels: (m.categories ?? []).slice(0, 10),
  };
}

/**
 * One mailbox. `tokens()` / `saveTokens(t)`: the account's tokens (kept sealed by the caller); `clientId`. → the transport
 * interface the sync engine and the outbox use: sync(state), body(ref), setFlags(ref, flags), send(held, original).
 */
export function createGraphMailbox({ clientId, tokens, saveTokens, hosts = GRAPH_HOSTS, fetchImpl = fetch, now = Date.now }) {
  let running = 0;
  const waiting = [];
  const slot = async () => { if (running >= 4) await new Promise((r) => waiting.push(r)); running += 1; };
  const free = () => { running -= 1; waiting.shift()?.(); };
  async function access(force = false) {
    const t = tokens();
    if (!t) return null;
    if (!force && t.access_token && t.expires_at - 60_000 > now()) return t.access_token;
    const fresh = t.refresh_token ? await tokenCall(hosts, { client_id: clientId, grant_type: "refresh_token", refresh_token: t.refresh_token, scope: GRAPH_SCOPES }, fetchImpl).catch(() => null) : null;
    if (!fresh) return null;
    saveTokens(fresh);
    return fresh.access_token;
  }
  /** One call. `once`: a send step, never repeated (no second try after a 401). → { status, json } or { status: 0 } offline. */
  async function call(method, path, { body, prefer = [], once = false } = {}) {
    await slot();
    try {
      for (let attempt = 0; attempt < (once ? 1 : 2); attempt += 1) {
        const token = await access(attempt > 0);
        if (!token) return { status: 401 };
        let res;
        try {
          res = await fetchImpl(path.startsWith("http") ? path : `${hosts.graph}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...(prefer.length ? { prefer: prefer.join(", ") } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        } catch { return { status: 0 }; }
        if (res.status === 401 && !once && attempt === 0) continue;
        return { status: res.status, json: res.status === 204 || res.status === 202 ? {} : await res.json().catch(() => ({})) };
      }
      return { status: 401 };
    } finally { free(); }
  }
  const PREFER = ['odata.maxpagesize=50', 'IdType="ImmutableId"'];
  return {
    kind: "graph",
    /** `state`: { [folder]: deltaLink }. → { ok, messages, removed, state } or { ok: false, code: auth_failed | offline }. */
    async sync(state = {}) {
      const messages = [], removed = [], next = { ...state };
      for (const [folder, role] of FOLDERS) {
        let url = state[folder] ?? `/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=receivedDateTime+ge+${new Date(now() - 30 * 86400_000).toISOString()}&$orderby=receivedDateTime+desc`;
        for (let page = 0; page < 40 && url; page += 1) {
          const r = await call("GET", url, { prefer: PREFER });
          if (r.status === 410) { next[folder] = undefined; url = null; return { ok: true, messages, removed, state: { ...next, [folder]: undefined }, resync: true }; }
          if (r.status === 401 || r.status === 403) return { ok: false, code: "auth_failed" };
          if (r.status !== 200) return { ok: false, code: "offline" };
          for (const m of r.json.value ?? []) (m["@removed"] ? removed.push(m.id) : messages.push(normalise(m, role)));
          if (r.json["@odata.deltaLink"]) { next[folder] = r.json["@odata.deltaLink"]; url = null; } else url = r.json["@odata.nextLink"] ?? null;
        }
      }
      return { ok: true, messages, removed, state: next };
    },
    /** The whole body as text (Graph converts HTML), or null. */
    async body(ref) {
      const r = await call("GET", `/me/messages/${encodeURIComponent(ref)}?$select=body`, { prefer: ['outlook.body-content-type="text"', 'IdType="ImmutableId"'] });
      return r.status === 200 && typeof r.json.body?.content === "string" ? r.json.body.content : null;
    },
    async setFlags(ref, { read, starred }) {
      const r = await call("PATCH", `/me/messages/${encodeURIComponent(ref)}`, { body: { ...(read === undefined ? {} : { isRead: read }), ...(starred === undefined ? {} : { flag: { flagStatus: starred ? "flagged" : "notFlagged" } }) } });
      return r.status === 200;
    },
    /** AFTER the phone's approval only. `original`: the replied or forwarded message's Graph id, or null for new. */
    async send(held, original, files = []) {
      const d = held.draft, rcpt = (list) => list.map((address) => ({ emailAddress: { address } }));
      // basic: Graph is handed the HTML generated from the approved text (remote-mail-mime.mjs basicToHtml), nothing else.
      const content = d.format === "basic" ? basicToHtml(d.body) : d.body.replace(/\r?\n/g, "\r\n");
      const fields = { subject: d.subject, body: { contentType: d.format === "basic" ? "html" : "text", content }, toRecipients: rcpt(d.to), ccRecipients: rcpt(d.cc), bccRecipients: rcpt(d.bcc) };
      if (files.some((f) => f.bytes.length > GRAPH_SIMPLE_ATTACHMENT)) return { ok: false, code: "rejected" }; // an upload session is later work (MAIL.md)
      const fail = (status) => ({ ok: false, code: status === 0 ? "interrupted" : status === 401 || status === 403 ? "auth_failed" : "rejected" });
      if (!(await access())) return { ok: false, code: "auth_failed" };
      const step = { reply: "createReply", reply_all: "createReplyAll", forward: "createForward" }[d.mode];
      const made = step && original ? await call("POST", `/me/messages/${encodeURIComponent(original)}/${step}`, { body: {}, once: true }) : await call("POST", "/me/messages", { body: fields, once: true });
      if (made.status !== 201 || typeof made.json.id !== "string") return fail(made.status);
      if (step && original) { const patched = await call("PATCH", `/me/messages/${encodeURIComponent(made.json.id)}`, { body: fields, once: true }); if (patched.status !== 200) return fail(patched.status); }
      for (const f of files) {
        const added = await call("POST", `/me/messages/${encodeURIComponent(made.json.id)}/attachments`, { body: { "@odata.type": "#microsoft.graph.fileAttachment", name: f.name, contentType: f.mime, contentBytes: Buffer.from(f.bytes).toString("base64") }, once: true });
        if (added.status !== 201) return fail(added.status);
      }
      const sent = await call("POST", `/me/messages/${encodeURIComponent(made.json.id)}/send`, { once: true });
      return sent.status === 202 ? { ok: true } : fail(sent.status);
    },
  };
}
