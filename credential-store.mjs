/** OS-backed wrapping key, AES-256-GCM credentials. The OS account can still request decryption.
 * No attestation: signed input remains subject to the server's claim-specific trust gates.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readPrivateFile, writePrivateFile, createPrivateFile } from './package-integrity.mjs';
import { nativeKeyStore } from './credential-vault.mjs';
const FORMAT = 'worktrust-os-key/1';
function validEntry(entry) {
  if (entry !== null && (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.token !== 'string' || !entry.token)) throw Error('KEY_FILE_INVALID');
  return entry;
}
function decode(bytes) {
  if (bytes === null) return null;
  try {
    if (bytes.startsWith('{')) {
      const e = JSON.parse(bytes);
      if (e.format !== FORMAT || !/^[a-f0-9]{64}$/.test(e.id) || !/^[a-z-]{1,40}$/.test(e.provider)
        || !/^[a-f0-9]{24}$/.test(e.iv) || !/^[a-f0-9]{32}$/.test(e.tag) || typeof e.ciphertext !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.ciphertext)
        || Object.keys(e).sort().join(',') !== 'ciphertext,format,id,iv,provider,tag') throw Error();
      return e;
    }
    return validEntry(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8')));
  } catch { throw Error('KEY_FILE_INVALID'); }
}
function wrappingKey(vault, envelope) {
  if (envelope.provider !== vault.name) throw Error('KEYSTORE_UNAVAILABLE');
  const value = vault.get(envelope.id);
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('KEYSTORE_UNAVAILABLE');
  return Buffer.from(value, 'hex');
}
const aad = e => Buffer.from(`${FORMAT}\n${e.provider}\n${e.id}`);
function open(vault, e) {
  if (!e || e.format !== FORMAT) return e;
  const key = wrappingKey(vault, e);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
    cipher.setAAD(aad(e)); cipher.setAuthTag(Buffer.from(e.tag, 'hex'));
    return validEntry(JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.ciphertext, 'base64')), cipher.final()]).toString('utf8')));
  } catch { throw Error('KEY_FILE_INVALID'); }
  finally { key.fill(0); }
}
function seal(vault, reference, entry) {
  const key = wrappingKey(vault, reference);
  try {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(reference));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(validEntry(entry)), 'utf8'), cipher.final()]);
    return JSON.stringify({ format: FORMAT, provider: reference.provider, id: reference.id, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
  } finally { key.fill(0); }
}
export function createCredentialStore(file, vault = nativeKeyStore()) {
  const read = () => decode(readPrivateFile(file));
  function locked(action) {
    const lock = `${file}.lock`;
    try { createPrivateFile(lock, JSON.stringify({ pid: process.pid })); }
    catch (error) { throw Error(error.code === 'EEXIST' ? 'KEY_STORE_BUSY' : 'KEY_FILE_UNSAFE'); }
    try { return action(); } finally { rmSync(lock); }
  }
  return {
    load() { return open(vault, read()); },
    protected() { return read()?.format === FORMAT; },
    save(entry) {
      return locked(() => {
        const old = read();
        // Authenticate the previous envelope before replacing it; corruption is never reset quietly.
        if (old?.format === FORMAT) { open(vault, old); writePrivateFile(file, seal(vault, old, entry)); }
        else writePrivateFile(file, Buffer.from(JSON.stringify(validEntry(entry))).toString('base64'));
      });
    },
    protect() {
      return locked(() => {
        const old = read();
        if (old?.format === FORMAT) { open(vault, old); return; }
        const reference = { format: FORMAT, provider: vault.name, id: randomBytes(32).toString('hex') };
        const secret = randomBytes(32).toString('hex'); let committed = false;
        try {
          vault.put(reference.id, secret);
          if (vault.get(reference.id) !== secret) throw Error('KEYSTORE_UNAVAILABLE');
          const envelope = seal(vault, reference, old);
          if (JSON.stringify(open(vault, JSON.parse(envelope))) !== JSON.stringify(old)) throw Error('KEYSTORE_UNAVAILABLE');
          writePrivateFile(file, envelope); committed = true;
        } finally {
          // If preparation fails the old credentials survive. No backup containing plaintext is made.
          if (!committed) { try { vault.remove(reference.id); } catch { /* orphan random wrapping key, no credentials */ } }
        }
      });
    },
    erase() {
      return locked(() => {
        const old = read();
        // An encrypted empty slot keeps the storage preference through disconnect/reconnect.
        if (old?.format === FORMAT) { open(vault, old); writePrivateFile(file, seal(vault, old, null)); }
        else rmSync(file, { force: true });
      });
    },
  };
}

/**
 * THE KEY IN THE OS VAULT BY DEFAULT (0.11.12, owner 2026-11-15: "make protect-key happen automatically when you make the
 * coupling"). The same protect() the command runs, after a new coupling and once at an update. → what happened:
 *   "protected"  the vault holds the wrapping key, read back once without asking (protect() checks it), the file is sealed
 *   "already"    it was protected before (a coupling again keeps its sealed slot)
 *   "kept"       the vault was unavailable or refused: the private 0600 file stays exactly as it was; never a failed coupling
 *   "remote"     not tried: an SSH session, or Linux without a desktop. There the login keychain or the Secret Service
 *                collection can be LOCKED when an AI app later starts the hook, and a read never asks (credential-vault.mjs:
 *                no unlock prompt by design), so the hook would stop measuring until someone unlocks it. The file stays.
 *   "elsewhere"  not tried: this run's HOME is not the OS account's own home (a test harness, a sandbox). The vault is the
 *                account's, whatever HOME says (macOS reads it as the OS user, credential-vault.mjs), so a key file in
 *                another folder would leave an item in the person's own vault that nothing there needs. Found 2026-11-15:
 *                the CLI's regression suite, coupling synthetic homes, wrote 22 such items into the login keychain.
 * A read never raises a prompt: macOS reads go through /usr/bin/osascript with user interaction turned off, the one client
 * that created the item (its default access list), whatever node, npx cache or CLI version asks; Linux `secret-tool search`
 * never unlocks; Windows Credential Manager has no prompt. So the move cannot flood anyone with questions.
 */
export function protectByDefault(store, { remote = false, elsewhere = false } = {}) {
  try { if (store.protected()) return "already"; } catch { return "kept"; }
  if (elsewhere) return "elsewhere";
  if (remote) return "remote";
  try { store.protect(); return "protected"; } catch { return "kept"; }
}

/** Archive signing shares the coupling store; an unavailable vault is not an absent device. */
export function readDeviceSigningKey(file) {
  const entry = createCredentialStore(file).load();
  if (!entry?.device) return null;
  try {
    const privateKey = createPrivateKey(entry.device);
    return { privateKey, publicX: createPublicKey(privateKey).export({ format: "jwk" }).x, kind: "device" };
  } catch { return null; }
}
