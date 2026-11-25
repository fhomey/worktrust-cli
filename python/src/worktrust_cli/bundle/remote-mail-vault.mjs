/**
 * MAIL ACCOUNTS IN THE OS KEYSTORE (docs/remote-agents/MAIL.md §Accounts and the keystore; owner, 2026-11-24).
 *
 * Every account record, its app password and OAuth tokens included, is sealed with AES-256-GCM under a wrapping key that the
 * OS keystore holds (macOS Keychain, Windows Credential Manager, the Secret Service) through the CLI's existing native
 * keystore, credential-vault.mjs `nativeKeyStore`, and nothing else of it: this module is the one remote module that may
 * name it (check-remote-cli rule A's named exception), and it never names the measurement credential, its file or its store.
 * The sealed file is `~/.worktrust/remote/mail/accounts.sealed` (0600) with its own keystore item; never a plain file.
 *
 * WHEN HOME IS NOT THE OS ACCOUNT'S OWN HOME (a test harness, a sandbox) the OS keystore is never touched: without a vault
 * handed in by code the mail vault refuses (`KEYSTORE_ELSEWHERE`). The tests hand in a vault of their own.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { readMailFile, writeMailFile } from "./remote-mail-files.mjs";
import { nativeKeyStore } from "./credential-vault.mjs";

const FORMAT = "worktrust-mail-vault/1";
const aad = (e) => Buffer.from(`${FORMAT}\n${e.provider}\n${e.id}`);

const canonical = (path) => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };
/**
 * THE KEYSTORE DOOR, GUARDED LIKE THE SERVICE MANAGER'S (remote-service.mjs ownHome; check-cli-service-home D): the OS
 * keystore belongs to the logged-in user whatever HOME says, so it is opened only when HOME is that user's own home,
 * compared after resolving links. Anywhere else (a test, a sandbox, an agent with a synthetic HOME) → null, and nothing asks
 * the keychain.
 */
export function keystoreHome(env = process.env) {
  let own = null;
  try { own = userInfo().homedir; } catch { own = null; }
  const home = env.HOME ?? homedir();
  return Boolean(own) && typeof home === "string" && home !== "" && canonical(home) === canonical(own);
}
export const defaultMailVault = (env = process.env) => (keystoreHome(env) ? nativeKeyStore() : null);

/**
 * `file`: the sealed file; `vault`: { name, get(id), put(id, hex), remove(id) } (the OS keystore by default). The wrapping
 * key is read once and kept in memory for this process, so a sync never asks the keystore again.
 */
export function createMailVault(file, vault = defaultMailVault()) {
  let key = null;
  const need = () => { if (!vault) throw new Error("KEYSTORE_ELSEWHERE"); return vault; };
  const read = () => {
    if (!existsSync(file)) return null;
    const e = JSON.parse(readMailFile(file));
    if (e.format !== FORMAT || !/^[a-f0-9]{64}$/.test(e.id) || !/^[a-f0-9]{24}$/.test(e.iv) || !/^[a-f0-9]{32}$/.test(e.tag) || typeof e.ciphertext !== "string") throw new Error("MAIL_VAULT_INVALID");
    return e;
  };
  const keyFor = (e) => {
    if (key?.id === e.id) return key.bytes;
    const v = need();
    if (e.provider !== v.name) throw new Error("KEYSTORE_UNAVAILABLE");
    const hex = v.get(e.id);
    if (typeof hex !== "string" || !/^[a-f0-9]{64}$/.test(hex)) throw new Error("KEYSTORE_UNAVAILABLE");
    key = { id: e.id, bytes: Buffer.from(hex, "hex") };
    return key.bytes;
  };
  function open() {
    const e = read();
    if (!e) return { accounts: [] };
    try {
      const d = createDecipheriv("aes-256-gcm", keyFor(e), Buffer.from(e.iv, "hex"));
      d.setAAD(aad(e)); d.setAuthTag(Buffer.from(e.tag, "hex"));
      const value = JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]).toString("utf8"));
      return { accounts: Array.isArray(value?.accounts) ? value.accounts : [] };
    } catch (error) { throw new Error(/KEYSTORE/.test(error?.message) ? error.message : "MAIL_VAULT_INVALID"); }
  }
  function seal(value) {
    let e = read();
    if (!e) {
      const v = need(), id = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
      v.put(id, secret);
      if (v.get(id) !== secret) throw new Error("KEYSTORE_UNAVAILABLE");
      key = { id, bytes: Buffer.from(secret, "hex") };
      e = { format: FORMAT, provider: v.name, id };
    }
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", keyFor(e), iv);
    c.setAAD(aad(e));
    const ciphertext = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    writeMailFile(file, JSON.stringify({ format: FORMAT, provider: e.provider, id: e.id, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") }));
  }
  return {
    /** Every account, secrets included: for the daemon's memory only, never a log or a phone. */
    accounts: () => open().accounts,
    /** The accounts as a phone or the terminal may see them: no secret, no token. */
    publicAccounts: () => open().accounts.map(({ secret: _s, oauth: _o, ...rest }) => rest),
    put(account) { const { accounts } = open(); seal({ accounts: [...accounts.filter((a) => a.account_id !== account.account_id), account] }); },
    remove(accountId) {
      const { accounts } = open(), left = accounts.filter((a) => a.account_id !== accountId);
      if (left.length === accounts.length) return false;
      if (left.length > 0) { seal({ accounts: left }); return true; }
      const e = read();
      rmSync(file, { force: true });
      try { if (e) need().remove(e.id); } catch { /* an orphan random key: no account in it */ }
      key = null;
      return true;
    },
    exists: () => existsSync(file),
  };
}
