/**
 * THE DAEMON'S MAIL DOOR (docs/remote-agents/MAIL.md; owner, 2026-11-24). remote-daemon.mjs hands every mail.* and personal.*
 * command here after it opened, journaled (the digest, never the payload) and received it; this answers with sealed events
 * on the TRANSIENT lane for the asking phone alone (`tell`), and returns "taken" or a reject reason, as every door does.
 *
 *   accounts   the vault (remote-mail-vault.mjs, the OS keystore); Outlook signs in ON THIS COMPUTER by PKCE on loopback
 *              (remote-mail-graph.mjs) while the phone shows "browser_on_computer"; an app-password account (Gmail, iCloud,
 *              Yahoo, IMAP) is refused `unsupported` until the IMAP and SMTP clients are decided (MAIL.md §Open 1)
 *   reading    the local index (remote-mail-index.mjs), kept by the sync (remote-mail-sync.mjs)
 *   drafting   the personal job (remote-mail-draft.mjs): no tools, no project, one at a time
 *   sending    the outbox (remote-mail-outbox.mjs) alone, on mail.send with the hash of exactly the held draft
 *   templates  remote-mail-templates.mjs: label, archive, draft; a new one runs once as a visible test producing a draft
 * Logs carry ids, types, counts and codes: never an address, a subject, a body or a secret. Mail is never Passport hours: no
 * steered ledger is written here and the draft run keeps no transcript.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import * as P from "./remote-protocol.mjs";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";
import { createMailVault } from "./remote-mail-vault.mjs";
import { openMailIndex } from "./remote-mail-index.mjs";
import { createMailSync } from "./remote-mail-sync.mjs";
import { createOutbox } from "./remote-mail-outbox.mjs";
import { createAutomations, createTemplates } from "./remote-mail-templates.mjs";
import { createGraphMailbox, graphClientId, signIn } from "./remote-mail-graph.mjs";
import { draftPrompt, runDraft, runVerdict, verdictPrompt } from "./remote-mail-draft.mjs";
import { draftContext, recipientsFor, threadBody } from "./remote-mail-compose.mjs";
import { cleanText } from "./remote-mail-text.mjs";
import { createImapMailbox } from "./remote-mail-imapbox.mjs";
import { knownBrowser } from "./remote-store.mjs";
import { createAttachmentStore } from "./remote-mail-attach.mjs";
import { createSignatures } from "./remote-mail-signatures.mjs";
import { createComposeDoor } from "./remote-mail-compose-door.mjs";

/**
 * o: { dir, emit (the daemon's), now, random, log, every(ms, fn) → stop, later(ms, fn), agentFile(adapter) → path | null,
 *      agentEnv(), openBrowser(url), defaultAgent(), and for tests: vault, indexFallback, fetchImpl, hosts, clientId,
 *      draftRun(args) → { ok, draft } | { ok: false, code } }
 */
export async function createMail(o) {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const vault = createMailVault(join(o.dir, "accounts.sealed"), o.vault);
  const index = await openMailIndex(o.dir, { fallback: o.indexFallback === true });
  const stateFile = join(o.dir, "sync.json");
  const drafts = new Map(); // draft_id → { draft, state, phone, original }; in memory only, never on disk
  const attach = createAttachmentStore({ dir: o.dir, now: o.now, log: o.log }); // a draft's files: the outbox folder, 0600, 24 h at most
  const signatures = createSignatures({ file: join(o.dir, "signatures.json"), random: o.random, log: o.log });
  const transports = new Map();
  const clientId = o.clientId !== undefined ? o.clientId : graphClientId();
  const accounts = () => { try { return vault.accounts(); } catch { return []; } };
  const accountOf = (id) => accounts().find((a) => a.account_id === id) ?? null;
  const tellTo = (phone) => (type, body) => o.emit(null, type, body, null, "none", { transient: true, only: phone });

  function transportOf(account) {
    if (account.provider !== "outlook") { if (!transports.has(account.account_id)) transports.set(account.account_id, createImapMailbox({ account, connect: o.connect, now: o.now, credentials: () => { const a = accountOf(account.account_id) ?? account; return { user: a.address, pass: a.secret }; } })); return transports.get(account.account_id); }
    if (!clientId) return null;
    if (!transports.has(account.account_id)) transports.set(account.account_id, createGraphMailbox({ clientId, hosts: o.hosts, fetchImpl: o.fetchImpl,
      tokens: () => accountOf(account.account_id)?.oauth ?? null, saveTokens: (t) => { const a = accountOf(account.account_id); if (a) vault.put({ ...a, oauth: { ...a.oauth, ...t } }); } }));
    return transports.get(account.account_id);
  }
  const sync = createMailSync({ index, transportOf, accounts, now: o.now, log: o.log, every: o.every,
    loadState: () => { try { return JSON.parse(readMailFile(stateFile)); } catch { return {}; } }, saveState: (s) => writeMailFile(stateFile, JSON.stringify(s)),
    onChange: () => pushAccounts(), onNew: (account, rows) => automations.run(account, rows) });
  const outbox = createOutbox({ file: join(o.dir, "outbox.json"), now: o.now, later: o.later, log: o.log,
    drafts: { get: (id) => drafts.get(id) ?? null, set: (id, held) => drafts.set(id, held) },
    deliver: async (held) => { const a = accountOf(held.draft.account_id), t = a && transportOf(a); if (!t) return { ok: false, code: "transport_unavailable" };
      const files = attach.verify(held.draft); // what is approved is what is sent: every file hashed again now
      if (!files.ok) return { ok: false, code: "hash_mismatch" };
      return t.kind === "graph" ? t.send(held, held.original, files.files) : t.send(held, held.target ? index.thread(held.draft.thread_id ?? "").find((r) => r.message_id === held.target) ?? null : null, files.files); },
    told: (type, held, extra) => { if (type === "mail.sent") attach.dropDraft(held.draft.draft_id); tellTo(held.phone)(type, { request_id: held.request_id, draft_id: held.draft.draft_id, ...extra }); } });
  outbox.recover();
  const templates = createTemplates({ file: join(o.dir, "templates.json"), now: o.now, random: o.random, log: o.log });
  const tellAll = (type, body) => o.emit(null, type, body, null, "none", { transient: true });
  // TEMPLATES ON NEW MAIL: a verdict by the person's own agent (no tools), then label, archive or draft; every phone hears the result.
  const automations = createAutomations({ templates, index, log: o.log, told: (template) => tellAll("personal.template", { request_id: null, template, test_draft_id: null }),
    verdict: (row, when) => { const prompt = verdictPrompt({ when, message: row, random: o.random }), agent = o.defaultAgent?.() ?? "claude-code"; return exclusive(() => (o.verdictRun ? o.verdictRun({ agent, prompt, row, when }) : runVerdict({ agent, file: o.agentFile(agent), env: o.agentEnv(), prompt }))); },
    draft: (account, row) => exclusive(() => draftRun({ account, threadId: row.thread_id, mode: "reply", style: "text", instruction: "", req: null, tell: tellAll })) });

  const accountsBody = (request_id) => {
    const unread = index.unreadByAccount();
    return { request_id, features: [...P.MAIL_FEATURES], accounts: accounts().slice(0, P.MAIL_MAX_ACCOUNTS).map((a) => ({ account_id: a.account_id, provider: a.provider, address: a.address, display_name: a.display_name ?? null, status: sync.statusOf(a.account_id), unread: unread[a.account_id] ?? 0, last_sync_at: sync.lastSyncOf(a.account_id) })) };
  };
  function pushAccounts() { o.emit(null, "mail.accounts", accountsBody(null), null, "none", { transient: true }); }

  function addAccount(p, tell, req) {
    const all = accounts();
    if (all.length >= P.MAIL_MAX_ACCOUNTS) return tell("mail.account.refused", { request_id: req, code: "limit" });
    if (all.some((a) => a.address === p.address.toLowerCase())) return tell("mail.account.refused", { request_id: req, code: "duplicate" });
    if (p.provider !== "outlook") return addPasswordAccount(p, tell, req);
    if (!clientId) return tell("mail.account.refused", { request_id: req, code: "not_configured" });
    const account = { account_id: P.mintId("mac", o.random), provider: "outlook", address: p.address.toLowerCase(), display_name: p.display_name ?? null, added_at: o.now() };
    vault.put(account);
    sync.reset(account.account_id, "needs_consent");
    tell("mail.account.pending", { request_id: req, account_id: account.account_id, step: "browser_on_computer" });
    o.log("mail_account_pending", { account_id: account.account_id, provider: "outlook" });
    signIn({ clientId, address: account.address, open: o.openBrowser, hosts: o.hosts, fetchImpl: o.fetchImpl }).then(async (r) => {
      if (!accountOf(account.account_id)) return;
      if (!r.ok) { o.log("mail_account_signin", { account_id: account.account_id, outcome: r.code }); return pushAccounts(); }
      vault.put({ ...accountOf(account.account_id), oauth: r.tokens });
      sync.reset(account.account_id);
      o.log("mail_account_signin", { account_id: account.account_id, outcome: "ok" });
      pushAccounts();
      await sync.syncOne(accountOf(account.account_id));
      pushAccounts();
    }).catch(() => o.log("mail_account_signin", { account_id: account.account_id, outcome: "failed" }));
  }

  /**
   * AN APP-PASSWORD ACCOUNT (Gmail, iCloud, Yahoo, IMAP): signed in to IMAP and SMTP BEFORE anything is kept; refused with
   * the server's reason (auth_failed, app_password_needed, untrusted_certificate, unreachable, unsupported). In the background:
   * the answer follows when both servers said yes.
   */
  function addPasswordAccount(p, tell, req) {
    const account = { account_id: P.mintId("mac", o.random), provider: p.provider, address: p.address.toLowerCase(), display_name: p.display_name ?? null, secret: p.secret, ...(p.imap ? { imap: p.imap, smtp: p.smtp } : {}), added_at: o.now() };
    createImapMailbox({ account, connect: o.connect, now: o.now }).verify().then(async (v) => {
      if (!v.ok) {
        const code = P.MAIL_ADD_REFUSALS.includes(v.code) ? v.code : v.code === "timeout" ? "unreachable" : v.code === "rejected" ? "auth_failed" : "unreachable";
        o.log("mail_account_refused", { provider: p.provider, code }); return tell("mail.account.refused", { request_id: req, code });
      }
      vault.put(account); sync.reset(account.account_id);
      o.log("mail_account_added", { account_id: account.account_id, provider: p.provider });
      tell("mail.account.added", { request_id: req, account_id: account.account_id });
      await sync.syncOne(account); pushAccounts(); watch(account);
    }).catch(() => tell("mail.account.refused", { request_id: req, code: "unreachable" }));
  }
  /** New mail by IDLE where the server offers it; the minute's poll stays either way. */
  const watching = new Map();
  function watch(account) {
    if (account.provider === "outlook" || watching.has(account.account_id)) return;
    const w = { stopped: false };
    watching.set(account.account_id, w);
    transportOf(account).watch({ onNew: () => { sync.syncOne(accountOf(account.account_id) ?? account).then(() => pushAccounts()).catch(() => {}); }, stopped: () => w.stopped || !accountOf(account.account_id), hold: (c) => { w.client = c; } })
      .then((r) => { o.log("mail_watch", { account_id: account.account_id, outcome: r }); }).catch(() => {}).finally(() => watching.delete(account.account_id));
  }

  async function openThread(threadId) {
    const msgs = index.thread(threadId);
    if (msgs.length === 0) return null;
    const a = accountOf(msgs[0].account_id), t = a && transportOf(a);
    for (const m of msgs.slice(-P.MAIL_THREAD_MAX_MESSAGES)) {
      if (!m.text_is_preview || !t?.body || !m.remote_ref) continue;
      const body = await t.body(m.remote_ref).catch(() => null);
      if (typeof body === "string") index.put({ ...m, text: cleanText(body).slice(0, P.MAIL_TEXT_MAX * 2), text_is_preview: false });
    }
    return index.thread(threadId);
  }

  let drafting = false, agentTail = Promise.resolve();
  /** One personal agent run at a time on this computer (a phone's draft, an automation's verdict or draft). */
  const exclusive = (job) => { const run = agentTail.then(async () => { drafting = true; try { return await job(); } finally { drafting = false; } }); agentTail = run.catch(() => {}); return run; };
  const agentDraft = (prompt) => { const adapter = o.defaultAgent?.() ?? "claude-code"; return o.draftRun ? o.draftRun({ agent: adapter, prompt }) : runDraft({ agent: adapter, file: o.agentFile(adapter), env: o.agentEnv(), prompt }); };
  const compose = createComposeDoor({ o, drafts, index, accountOf, attach, signatures, exclusive, agentDraft });
  /** One draft run, in the background; its answers go to `tell`. `instruction` already the person's (or a template's test). */
  async function draftRun({ account, threadId, mode, style, instruction, to, agent, req, tell, draftId = P.mintId("mdr", o.random) }) {
    const msgs = threadId ? await openThread(threadId) : [];
    const ctx = draftContext({ msgs: msgs ?? [], mode, account, index });
    if (req) tell("mail.draft.progress", { request_id: req, phase: "drafting" });
    const prompt = draftPrompt({ mode, style, instruction, thread: ctx.thread, samples: ctx.samples, self: account.address, random: o.random });
    const adapter = agent ?? o.defaultAgent?.() ?? "claude-code";
    const r = o.draftRun ? await o.draftRun({ agent: adapter, prompt }) : await runDraft({ agent: adapter, file: o.agentFile(adapter), env: o.agentEnv(), prompt });
    if (!r.ok) { o.log("mail_draft", { outcome: r.code }); if (req) tell("mail.draft.refused", { request_id: req, code: r.code }); return false; }
    const rcpt = recipientsFor(mode, ctx.target, account.address, to ?? []);
    const draft = { request_id: req, draft_id: draftId, account_id: account.account_id, thread_id: threadId ?? null, mode, to: rcpt.to, cc: rcpt.cc, bcc: [], subject: ctx.subject, body: r.draft.body, confidence: r.draft.confidence, notes: r.draft.notes, attachments: [], format: "plain" };
    if (!P.validateEventBody("mail.draft", draft).ok) { if (req) tell("mail.draft.refused", { request_id: req, code: "unparseable" }); return false; }
    drafts.set(draftId, { draft, state: "ready", phone: null, request_id: req, original: ctx.target?.remote_ref ?? null, target: ctx.target?.message_id ?? null });
    o.log("mail_draft", { outcome: "ready", draft_id: draftId, confidence: draft.confidence });
    tell("mail.draft", draft);
    return true;
  }
  function startDraft(args) {
    if (drafting) { args.tell("mail.draft.refused", { request_id: args.req, code: "busy" }); return; }
    args.tell("mail.draft.progress", { request_id: args.req, phase: "reading" });
    exclusive(() => draftRun(args)).catch(() => { args.tell("mail.draft.refused", { request_id: args.req, code: "agent_failed" }); return false; }).then((ok) => { args.after?.(ok); });
  }

  /** The door. → "taken" or a REJECT_REASONS word; a store that fails (a keychain that said no) is `unsupported`, never a stuck command. */
  async function handle(env, p) {
    try { return await door(env, p); } catch (error) { o.log("mail_failed", { type: env.type, reason: /KEYSTORE/.test(error?.message ?? "") ? "keystore" : "internal" }); return "unsupported"; }
  }
  async function door(env, p) {
    const req = env.command_id, phone = env.sender_device_id, tell = tellTo(phone);
    // A PHONE ONLY, FOR NOW (owner, 2026-11-24): a browser's mail command is refused `not_allowed` before anything is read.
    if (!(o.isPhone ?? ((id) => !knownBrowser(id)))(phone)) { o.log("mail_refused", { type: env.type, reason: "not_a_phone" }); return "not_allowed"; }
    if (compose.handles(env.type, p)) return compose.handle(env.type, p, req, tell); // remote-mail-compose-door.mjs
    switch (env.type) {
      case "mail.accounts.get": tell("mail.accounts", accountsBody(req)); return "taken";
      case "mail.account.add": addAccount(p, tell, req); return "taken";
      case "mail.account.remove": {
        if (!vault.remove(p.account_id)) return "not_found";
        index.removeAccount(p.account_id); sync.forget(p.account_id); transports.delete(p.account_id);
        for (const [id, held] of drafts) if (held.draft.account_id === p.account_id) { drafts.delete(id); attach.dropDraft(id); }
        signatures.forget(p.account_id);
        o.log("mail_account_removed", { account_id: p.account_id });
        tell("mail.account.removed", { request_id: req, account_id: p.account_id }); return "taken";
      }
      case "mail.list.get": {
        if (p.account_id && !accountOf(p.account_id)) return "not_found";
        tell("mail.list", { request_id: req, ...index.list({ account: p.account_id ?? null, query: p.query ?? null, label: p.label ?? null, cursor: p.cursor ?? null, limit: p.limit ?? P.MAIL_LIST_DEFAULT }) }); return "taken";
      }
      case "mail.thread.get": { const msgs = await openThread(p.thread_id); if (!msgs) return "not_found"; tell("mail.thread", { request_id: req, ...threadBody(msgs) }); return "taken"; }
      case "mail.flag": {
        if (index.flag(p.thread_id, { read: p.read, starred: p.starred }) === 0) return "not_found";
        const msgs = index.thread(p.thread_id), a = accountOf(msgs[0].account_id), t = a && transportOf(a);
        if (t?.setFlags) Promise.all(msgs.filter((m) => m.remote_ref).map((m) => t.setFlags(m.remote_ref, { read: p.read, starred: p.starred }))).then((oks) => { if (oks.every(Boolean)) index.settle(p.thread_id); }).catch(() => {});
        tell("mail.flagged", { request_id: req, thread_id: p.thread_id }); return "taken";
      }
      case "mail.draft.request": {
        const account = accountOf(p.account_id);
        if (!account || (p.thread_id && index.thread(p.thread_id)[0]?.account_id !== account.account_id)) return "not_found";
        startDraft({ account, threadId: p.thread_id ?? null, mode: p.mode, style: p.style, instruction: p.instruction, to: p.to, agent: p.agent, req, tell }); return "taken";
      }
      case "mail.draft.edit": {
        const held = drafts.get(p.draft_id);
        if (!held) return "not_found";
        if (held.state !== "ready" && held.state !== "failed") return "busy";
        const { draft_id: _d, ...change } = p, draft = { ...held.draft, ...change, request_id: req };
        if (!P.validateEventBody("mail.draft", draft).ok) return "not_allowed";
        drafts.set(p.draft_id, { ...held, draft, state: "ready" }); tell("mail.draft", draft); return "taken";
      }
      case "mail.decline": { if (!drafts.delete(p.draft_id)) return "not_found"; attach.dropDraft(p.draft_id); o.log("mail_draft", { outcome: "declined", draft_id: p.draft_id }); tell("mail.declined", { request_id: req, draft_id: p.draft_id }); return "taken"; }
      case "mail.send": {
        const held = drafts.get(p.draft_id);
        if (held) drafts.set(p.draft_id, { ...held, phone, request_id: req });
        const r = outbox.submit(p.draft_id, p.approval_hash, { phone, request_id: req });
        tell(r.ok ? "mail.send.queued" : "mail.send.failed", r.ok ? { request_id: req, draft_id: p.draft_id, undo_until: r.undo_until } : { request_id: req, draft_id: p.draft_id, code: r.code }); return "taken";
      }
      case "mail.send.undo": { if (!outbox.undo(p.draft_id)) return drafts.has(p.draft_id) ? "expired" : "not_found"; tell("mail.send.undone", { request_id: req, draft_id: p.draft_id }); return "taken"; }
      case "personal.templates.get": tell("personal.templates", { request_id: req, templates: templates.all() }); return "taken";
      case "personal.template.set": return setTemplate(p, req, tell);
      default: return "unsupported";
    }
  }

  function setTemplate(p, req, tell) {
    if (p.account_id && !accountOf(p.account_id)) return "not_found";
    const r = templates.set(p);
    if (!r.ok) return r.code === "not_found" ? "not_found" : "not_allowed";
    const t = r.template, account = t.account_id ? accountOf(t.account_id) : accounts()[0] ?? null;
    const newest = account ? index.list({ account: account.account_id, limit: 1 }).items[0] ?? null : null;
    if (r.removed || !t.enabled || !t.actions.includes("draft") || !account || !newest) {
      tell("personal.template", { request_id: req, template: r.removed ? t : templates.ran(t.template_id, "skipped"), test_draft_id: null }); return "taken";
    }
    const draftId = P.mintId("mdr", o.random); // THE VISIBLE TEST: one draft, shown on the phone; never a send
    tell("personal.template", { request_id: req, template: t, test_draft_id: draftId });
    startDraft({ account, threadId: newest.thread_id, mode: "reply", style: "text", instruction: `This draft tests the person's automation, which applies when: ${t.when}`, req, tell, draftId, after: (ok) => templates.ran(t.template_id, ok ? "test_draft" : "failed") });
    return "taken";
  }

  return { handle, start: () => { attach.sweep(); o.every(60 * 60_000, () => attach.sweep()); sync.start(); sync.syncAll().catch(() => {}); for (const a of accounts()) watch(a); }, stop: () => { sync.stop(); for (const w of watching.values()) { w.stopped = true; w.client?.close(); } index.close(); }, sync, outbox, index, vault, drafts };
}
