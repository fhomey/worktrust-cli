/** Official launcher verification. Pinned keys are generated from reviewed release configuration. */
import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmSync, constants, openSync, closeSync, fstatSync, fchmodSync, readSync, fsyncSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';

export const RELEASE_KEYS = {"608168ccdef72562fc91f9c0f9f2c2d6876bece7f7362cb545b818f7947da6b5":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxe/h8yLe+e4iKYSx/2lzS7MgHIgzM+mi1XjofW1VKo4=\n-----END PUBLIC KEY-----\n"}; // GENERATED_RELEASE_KEYS
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  throw Error('PACKAGE_INVALID_MANIFEST');
};
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === keys.sort().join(',');
const safe = name => {
  if (typeof name !== 'string' || name.length > 240) return false;
  const parts = name.split('/');
  return parts.every((p, i) => (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(p) && p !== '..')
    || (p === '.claude-plugin' && i > 0 && i < parts.length - 1 && parts[i - 1] === 'agent'));
};
function regular(path) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !s.isFile()) throw Error('PACKAGE_NON_REGULAR_FILE');
  return s;
}
function filesIn(root, prefix = '') {
  const s = lstatSync(root);
  if (s.isSymbolicLink() || !s.isDirectory()) throw Error('PACKAGE_NON_REGULAR_DIRECTORY');
  return readdirSync(root).flatMap(name => {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('PACKAGE_NON_REGULAR_FILE');
    return stat.isDirectory() ? filesIn(path, prefix + name + '/') : [prefix + name];
  });
}
export function verifyPackage(root, kind = 'npm') {
  const signatureName = kind === 'engine' ? 'engine-release.json' : 'package-release.json';
  const path = join(root, signatureName);
  if (regular(path).size > 1024 * 1024) throw Error('PACKAGE_MANIFEST_TOO_LARGE');
  const signed = JSON.parse(readFileSync(path, 'utf8'));
  if (!exact(signed, ['keyId', 'payload', 'signature']) || !Object.hasOwn(RELEASE_KEYS, signed.keyId) || !/^[A-Za-z0-9_-]{86}$/.test(signed.signature)) throw Error('PACKAGE_UNTRUSTED_SIGNATURE');
  const pem = RELEASE_KEYS[signed.keyId], key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || hash(key.export({ format: 'der', type: 'spki' })) !== signed.keyId
    || !verify(null, Buffer.from('worktrust:package:1\n' + canonical(signed.payload)), key, Buffer.from(signed.signature, 'base64url'))) throw Error('PACKAGE_UNTRUSTED_SIGNATURE');
  const m = signed.payload;
  if (!exact(m, ['format', 'kind', 'version', 'files']) || m.format !== 'worktrust-package/1' || m.kind !== kind || !/^\d+\.\d+\.\d+$/.test(m.version)
    || !m.files || Array.isArray(m.files) || typeof m.files !== 'object' || Object.keys(m.files).length > 2000 || !Object.hasOwn(m.files, kind === 'python' ? 'bundle/worktrust.mjs' : 'worktrust.mjs')) throw Error('PACKAGE_INVALID_MANIFEST');
  const expected = Object.keys(m.files).sort();
  for (const name of expected) {
    if (!safe(name) || name === signatureName || !/^[a-f0-9]{64}$/.test(m.files[name])) throw Error('PACKAGE_INVALID_MANIFEST');
    let parent = root;
    for (const part of name.split('/').slice(0, -1)) { parent = join(parent, part); const s = lstatSync(parent); if (s.isSymbolicLink() || !s.isDirectory()) throw Error('PACKAGE_NON_REGULAR_DIRECTORY'); }
    const file = join(root, name);
    if (regular(file).size > 128 * 1024 * 1024 || hash(readFileSync(file)) !== m.files[name]) throw Error('PACKAGE_FILE_CHANGED');
  }
  const found = filesIn(root).filter(name => (kind !== 'python' || !name.split('/').includes('__pycache__')) && name !== signatureName && (kind !== 'engine' || name.endsWith('.mjs'))).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) throw Error('PACKAGE_FILE_LIST_CHANGED');
  if (/const CLI_VERSION = "([^"]+)";/.exec(readFileSync(join(root, kind === 'python' ? 'bundle/worktrust.mjs' : 'worktrust.mjs'), 'utf8'))?.[1] !== m.version) throw Error('PACKAGE_VERSION_MISMATCH');
  return { manifest: m, identity: hash(readFileSync(path)), signatureName };
}
export function installSignedPackage(source, home) {
  const checked = verifyPackage(source), store = join(home, 'verified');
  if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
  const owned = lstatSync(home);
  if (owned.isSymbolicLink() || !owned.isDirectory()) throw Error('PACKAGE_NON_REGULAR_DIRECTORY');
  if (!existsSync(store)) mkdirSync(store, { mode: 0o700 });
  const stored = lstatSync(store);
  if (stored.isSymbolicLink() || !stored.isDirectory()) throw Error('PACKAGE_NON_REGULAR_DIRECTORY');
  const target = join(store, checked.identity);
  if (existsSync(target)) { if (verifyPackage(target).identity !== checked.identity) throw Error('PACKAGE_INSTALLATION_IDENTITY_MISMATCH'); return join(target, 'worktrust-launch.mjs'); }
  const pending = join(store, '.pending-' + randomBytes(16).toString('hex'));
  mkdirSync(pending, { mode: 0o700 });
  try {
    for (const name of [...Object.keys(checked.manifest.files), checked.signatureName]) {
      const path = join(pending, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, readFileSync(join(source, name)), { flag: 'wx', mode: 0o600 });
    }
    if (verifyPackage(pending).identity !== checked.identity) throw Error('PACKAGE_INSTALLATION_IDENTITY_MISMATCH');
    try { renameSync(pending, target); } catch (error) { if (!existsSync(target)) throw error; if (verifyPackage(target).identity !== checked.identity) throw Error('PACKAGE_INSTALLATION_IDENTITY_MISMATCH'); }
  } finally { rmSync(pending, { recursive: true, force: true }); }
  return join(target, 'worktrust-launch.mjs');
}

/** Child processes of the official launcher re-enter verification, including long-lived MCP bridges.
 * Raw source test harnesses retain direct entry; they are not authenticated release launches.
 */
function persistentPython(root) {
  return globalThis[Symbol.for("worktrust.verifiedReleaseRoot")] === root
    && basename(root) === "engine" && /^[a-f0-9]{64}$/.test(basename(dirname(root)))
    && basename(dirname(dirname(root))) === "installations"
    && typeof process.env.WORKTRUST_BUNDLED_PYTHON === "string" && isAbsolute(process.env.WORKTRUST_BUNDLED_PYTHON)
    && process.env.WORKTRUST_INSTALLED_LAUNCHER === join(dirname(root), "worktrust-launch.py")
    && process.env.WORKTRUST_BUNDLED_PYTHON;
}
export function moduleExecutable(root) { return persistentPython(root) || process.execPath; }
export function moduleArgs(root, name, args = []) {
  if (!["worktrust.mjs", "setup-mcp.mjs", "log-session.mjs", "count-behaviour.mjs", "preserve.mjs"].includes(name)) throw Error("PACKAGE_INVALID_ENTRY");
  if (persistentPython(root)) return ["-I", process.env.WORKTRUST_INSTALLED_LAUNCHER, "--internal-module", name, ...args];
  const flags = process.versions.node === "26.5.0" ? ["--no-concurrent-sparkplug"] : [];
  return globalThis[Symbol.for("worktrust.verifiedReleaseRoot")] === root
    ? [...flags, join(root, "worktrust-launch.mjs"), "--internal-module", name, ...args]
    : [...flags, join(root, name), ...args];
}

// Credentials stay outside the immutable release. File hygiene reduces cross-user theft;
// it does not attest the machine owner or the truth of data they choose to sign.
function privateDirectory(path, create) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (process.getuid && before.uid !== process.getuid())) throw Error('KEY_FILE_UNSAFE');
  // Windows ACLs remain the responsibility of the user's private profile directory.
  if (process.platform !== 'win32') {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const current = fstatSync(fd); if (current.ino !== before.ino || current.dev !== before.dev) throw Error('KEY_FILE_UNSAFE'); fchmodSync(fd, 0o700); }
    finally { closeSync(fd); }
  }
}
function privateStat(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) throw Error('KEY_FILE_UNSAFE');
}
/** Bounded descriptor read; never follow a linked credential, pipe, device or directory. */
export function readPrivateFile(file) {
  let fd;
  try {
    privateDirectory(dirname(file), false);
    const before = lstatSync(file); privateStat(before);
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const current = fstatSync(fd); privateStat(current);
    if (current.ino !== before.ino || current.dev !== before.dev) throw Error('KEY_FILE_UNSAFE');
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const bytes = Buffer.alloc(65537); let size = 0, next;
    while (size < bytes.length && (next = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += next;
    if (size > 65536) throw Error('KEY_FILE_UNSAFE');
    return bytes.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('KEY_FILE_UNSAFE');
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Exclusive random temp, flush, atomic replace. Existing credentials survive a failed write. */
export function writePrivateFile(file, bytes) {
  if (Buffer.byteLength(bytes) > 65536) throw Error('KEY_FILE_UNSAFE');
  privateDirectory(dirname(file), true);
  try { privateStat(lstatSync(file)); } catch (error) { if (error.code !== 'ENOENT') throw Error('KEY_FILE_UNSAFE'); }
  const temporary = file + '.' + randomBytes(16).toString('hex') + '.tmp'; let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

/** First creation only, used by offline archive secrets; never overwrite an existing key. */
export function createPrivateFile(file, bytes) {
  if (Buffer.byteLength(bytes) > 65536) throw Error('KEY_FILE_UNSAFE');
  privateDirectory(dirname(file), true);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
