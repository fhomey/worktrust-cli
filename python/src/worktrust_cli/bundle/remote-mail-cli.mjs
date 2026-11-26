/**
 * `worktrust mail` AT THE KEYBOARD (docs/remote-agents/MAIL.md §Accounts and the keystore; owner, 2026-11-24).
 *
 *   worktrust mail [status]              the accounts, their sync state, the index's store, whether Outlook is configured
 *   worktrust mail accounts              the accounts: provider, address, status (this terminal only; nothing is sent)
 *   worktrust mail add outlook <address> sign in in this computer's browser (PKCE on loopback); y / n first
 *   worktrust mail remove <address>      the account, its tokens and its local mail gone from this computer; y / n first
 *   worktrust mail instructions [<id>] [--reset <id>]  (CLI 0.11.26) your instruction types, one in full; --reset: its shipped text, y / n first
 *   worktrust mail draft-timing [model]  (CLI 0.11.26) one draft of a canned sample by your own agent, timed: start, first text, done
 *
 * Every confirmation is the CLI's one question (remote-keyboard.mjs CONFIRM: y / yes / n / no), asked in a terminal only.
 * An app-password account (Gmail, iCloud, Yahoo, IMAP) is not in this release: the IMAP and SMTP clients wait for the
 * owner's choice (MAIL.md §Open 1), and the command says so instead of storing a password it cannot use.
 */
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { ensureRemoteDir, remotePath } from "./remote-store.mjs";
import { CONFIRM, confirmYes } from "./remote-keyboard.mjs";
import { createMailVault, keystoreHome } from "./remote-mail-vault.mjs";
import { openMailIndex } from "./remote-mail-index.mjs";
import { graphClientId, signIn } from "./remote-mail-graph.mjs";
import { readMailFile } from "./remote-mail-files.mjs";
import { mkdirSync } from "node:fs";

export const mailDir = () => remotePath("mail");
const PROVIDER_WORDS = { gmail: "Gmail", outlook: "Outlook", icloud: "iCloud", yahoo: "Yahoo", imap: "IMAP" };

async function askYes(io, question) {
  if (io.prompt) return confirmYes(await io.prompt(`  ${question} ${CONFIRM} `));
  if (!process.stdin.isTTY || !process.stdout.isTTY) { io.say("  Not changed: this asks y / n in a terminal."); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return confirmYes(await rl.question(`  ${question} ${CONFIRM} `)); } finally { rl.close(); }
}

const syncState = () => { try { return JSON.parse(readMailFile(join(mailDir(), "sync.json"))); } catch { return {}; } };

/**
 * HOW LONG A DRAFT TAKES ON THIS COMPUTER (CLI 0.11.26, owner): one run of the personal job on a canned sample (no mail of
 * yours), streamed, timed on the monotonic clock: until the agent started answering, until its first text, until done.
 * `run` and `now` are the tests' seams; the real one starts the person's own agent, so it is never run by a test.
 */
export const TIMING_SAMPLE = { from: "ada@example.org", subject: "Thursday review", text: "Hi,\n\nCould we move Thursday's review to ten? The agenda is the same.\n\nThanks,\nAda" };
export async function draftTiming({ file, env, model = null, now = () => performance.now(), run, random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const { draftPrompt, runDraft } = await import("./remote-mail-draft.mjs");
  const prompt = draftPrompt({ mode: "reply", style: "text", instruction: "Say yes to ten.", thread: [{ from_address: TIMING_SAMPLE.from, subject: TIMING_SAMPLE.subject, text: TIMING_SAMPLE.text, date: Date.UTC(2026, 10, 25) }], self: "me@example.org", random });
  const t0 = now(); let first = null;
  const r = await runDraft({ agent: "claude-code", file, env, prompt, model, onText: (t) => { if (first === null && t) first = now(); }, ...(run ? { run } : {}) });
  const done = now();
  return { ok: r.ok, code: r.ok ? null : r.code, first_text_ms: first === null ? null : Math.round(first - t0), total_ms: Math.round(done - t0) };
}

/** `args`: the words after `mail`. io: { say, fail, openBrowser, has?, vault?, prompt? (tests) } */
export async function mailCommand(args, io) {
  if (args[0] === "instructions" || args[0] === "draft-timing") return mailOwnCommand(args, io); // no keystore needed: your own file, your own agent
  // THE KEYSTORE DOOR'S GUARD (check-cli-service-home D): a HOME that is not this user's own opens no keychain, at all.
  if (!io.vault && !keystoreHome()) return io.say("  This home folder is not this user's own: the OS keystore is not opened from another home folder, so no mail account is read or changed here.");
  ensureRemoteDir();
  const vault = createMailVault(join(mailDir(), "accounts.sealed"), io.vault);
  const [sub = "status", ...rest] = args;
  const list = () => { try { return vault.publicAccounts(); } catch (error) { io.fail(/ELSEWHERE/.test(error?.message) ? "the OS keystore belongs to another home folder here: nothing was read" : "the mail accounts could not be opened (the OS keystore said no)"); return []; } };

  if (sub === "accounts" || sub === "status") {
    const accounts = list(), state = syncState();
    if (accounts.length === 0) io.say("  No e-mail account on this computer. Add one from the WorkTrust app (E-mail), or: npx worktrust mail add outlook <address>");
    for (const a of accounts) io.say(`  ${PROVIDER_WORDS[a.provider] ?? a.provider}  ${a.address}  ${state[a.account_id]?.status ?? "not synced yet"}${state[a.account_id]?.last_sync_at ? `, last sync ${new Date(state[a.account_id].last_sync_at).toLocaleString()}` : ""}`);
    if (sub === "status") {
      const index = await openMailIndex(mailDir());
      io.say(`  Local index: ${index.kind === "sqlite" ? "SQLite with full-text search" : "a private file (this Node has no SQLite full-text search)"}, ${index.rows(null).length} messages, on this computer only.`);
      index.close();
      io.say(graphClientId() ? "  Outlook: ready to sign in." : "  Outlook: not configured yet (WorkTrust's Microsoft app is not registered).");
      io.say("  Gmail, iCloud, Yahoo and IMAP: not in this release yet.");
    }
    return;
  }
  if (sub === "add") {
    const [provider, address] = rest;
    if (!P.MAIL_PROVIDERS.includes(provider) || !P.mailAddressOk(address ?? "")) return io.fail("usage: npx worktrust mail add outlook <address>");
    if (provider !== "outlook") return io.say(`  ${PROVIDER_WORDS[provider]} by app password is not in this release yet. Outlook works now: npx worktrust mail add outlook <address>`);
    const clientId = graphClientId();
    if (!clientId) return io.say("  Outlook is not configured yet: WorkTrust's Microsoft app is not registered. Nothing was changed.");
    const accounts = list();
    if (accounts.some((a) => a.address === address.toLowerCase())) return io.say("  That address is already on this computer.");
    if (accounts.length >= P.MAIL_MAX_ACCOUNTS) return io.say(`  This computer holds ${P.MAIL_MAX_ACCOUNTS} accounts already.`);
    if (!(await askYes(io, `Sign in to ${address} in this computer's browser, and keep its sign-in in this computer's keychain?`))) return io.say("  Not changed.");
    io.say("  Your browser opens on this computer. Sign in there; this waits up to five minutes.");
    const r = await signIn({ clientId, address, open: io.openBrowser });
    if (!r.ok) return io.say(r.code === "timeout" ? "  Not signed in in time. Nothing was changed." : "  The sign-in did not complete. Nothing was changed.");
    vault.put({ account_id: P.mintId("mac", P.systemRandom), provider: "outlook", address: address.toLowerCase(), display_name: null, added_at: Date.now(), oauth: r.tokens });
    return io.say("  Added. The remote service syncs it within a minute; your phone shows it under E-mail.");
  }
  if (sub === "remove") {
    const [which] = rest, a = list().find((x) => x.address === String(which ?? "").toLowerCase() || x.account_id === which);
    if (!a) return io.fail("usage: npx worktrust mail remove <address> (see npx worktrust mail accounts)");
    if (!(await askYes(io, `Remove ${a.address} from this computer: its sign-in and the mail kept here? Nothing is deleted in the mailbox itself.`))) return io.say("  Not changed.");
    vault.remove(a.account_id);
    const index = await openMailIndex(mailDir());
    index.removeAccount(a.account_id); index.close();
    return io.say("  Removed from this computer.");
  }
  io.fail("usage: npx worktrust mail [status | accounts | add outlook <address> | remove <address>]");
}

/** `mail instructions [--reset]` and `mail draft-timing [model]` (CLI 0.11.26). */
async function mailOwnCommand([sub, word], io) {
  const { createInstructionStore, DEFAULT_ID } = await import("./remote-mail-instructions.mjs");
  ensureRemoteDir(); mkdirSync(mailDir(), { recursive: true, mode: 0o700 });
  if (sub === "instructions") {
    const store = createInstructionStore({ dir: join(mailDir(), "instructions") }), when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    if (io.has?.("reset")) {
      const id = word ?? DEFAULT_ID;
      if (!store.get(id)) return io.fail(`no instruction type "${id}" (npx worktrust mail instructions lists them)`);
      if (!(await askYes(io, `Put the shipped default text back in "${id}"? Your own text there is replaced.`))) return io.say("  Not changed.");
      store.reset(id); return io.say(`  ✓ The default text is back in ${store.path(id)}`);
    }
    if (word) {
      const p = store.get(word);
      if (!p) return io.fail(`no instruction type "${word}" (npx worktrust mail instructions lists them)`);
      io.say(`  ${p.name} (${p.id}), version ${p.version}, changed ${when(p.updated_at)} on the ${p.updated_by}: ${store.path(p.id)}`); io.say("");
      for (const line of p.text.split("\n")) io.say(`    ${line}`);
      return;
    }
    io.say(`  Your e-mail instruction types (${join(mailDir(), "instructions")}); edit a file with any editor, the next draft reads it:`);
    for (const p of store.list()) io.say(`    ${p.id.padEnd(16)} ${p.name.slice(0, 30).padEnd(30)} v${p.version} · ${when(p.updated_at)} · ${p.updated_by}${p.mailboxes.length ? ` · default of ${p.mailboxes.length} mailbox(es)` : ""}`);
    io.say("  One in full: npx worktrust mail instructions <id>   The shipped text back: npx worktrust mail instructions --reset <id>");
    io.say("  A new type: a new <name>.md file in that folder (its first heading is its name).");
    return;
  }
  const { inventory } = await import("./remote-inventory.mjs"), { loadSettings } = await import("./remote-store.mjs");
  const env = Object.fromEntries(Object.entries({ ...process.env, PATH: loadSettings().agent_path ?? process.env.PATH }).filter(([k]) => !k.startsWith("WORKTRUST_")));
  const inv = inventory({ env }), claude = inv.reports.find((r) => r.adapter === "claude-code");
  if (!inv.files["claude-code"]) return io.fail("Claude Code is not found on this computer's PATH: the draft job runs Claude Code only");
  if (word && !(claude?.models ?? []).includes(word)) return io.fail(`"${word}" is not a model this computer's Claude Code lists (${(claude?.models ?? []).join(", ") || "none listed"})`);
  io.say(`  One draft of a canned sample (no mail of yours) by Claude Code${word ? ` (${word})` : ""}, timed. This takes up to three minutes…`);
  const t = await draftTiming({ file: inv.files["claude-code"], env, model: word ?? null });
  if (!t.ok) return io.fail(`the draft did not finish (${t.code}) after ${(t.total_ms / 1000).toFixed(1)} s`);
  io.say(`  First text after ${t.first_text_ms === null ? "not known (this Claude Code does not stream)" : `${(t.first_text_ms / 1000).toFixed(1)} s`} · done after ${(t.total_ms / 1000).toFixed(1)} s`);
  io.say("  What dominates: until the first text, the agent starting and reading the prompt; after it, the writing itself.");
}
