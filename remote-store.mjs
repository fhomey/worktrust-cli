/**
 * WHERE REMOTE AGENTS KEEP THEIR STATE ON THIS COMPUTER (2026-11-07, docs/remote-agents/PROTOCOL.md).
 *
 * Everything lives in ~/.worktrust/remote/ (a directory of mode 0700, never a symlink), each file 0600, written by
 * temporary file, fsync and rename. Nothing here is the measurement key: the remote device keys are their own pair
 * (Ed25519 to sign, X25519 to agree keys), in their own file, for their own audience. scripts/check-remote-cli.mjs refuses
 * a remote module that names the measurement credentials.
 *
 *   remote-keys.json    the remote device keys and the secret that derives project ids (never leaves the computer)
 *   identity.json       this computer's device id and the issuer's binding of its keys
 *   settings.json       on or off, paused (and by whom), the gateway address, default agent and model, PATH for agents
 *   phones.json         phones pending a keyboard confirmation, and the confirmed ones with their fingerprints (and, for a
 *                       browser a phone added, which phone and when)
 *   endorsements.json   the one-time nonces of browser endorsements already taken, kept a little past their expiry
 *   projects.json       the folders a phone may steer an agent in, canonical paths
 *   channels.json       the open end-to-end channels (their keys are secrets)
 *   journal.jsonl       the command journal (remote-journal.mjs); steered.jsonl the steered ledger (remote-steered.mjs)
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "./package-integrity.mjs";
import * as P from "./remote-protocol.mjs";

export const remoteDir = () => join(homedir(), ".worktrust", "remote");
export const remotePath = (name) => join(remoteDir(), name);

export function ensureRemoteDir() {
  const base = join(homedir(), ".worktrust"), dir = remoteDir();
  for (const path of [base, dir]) {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a directory, not a link`);
    } else mkdirSync(path, { mode: 0o700 });
    try { chmodSync(path, 0o700); } catch { /* Windows */ }
  }
  return dir;
}

export function readJson(name, fallback = null) {
  const file = remotePath(name);
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readPrivateFile(file)); } catch { throw new Error(`${file} is unreadable or not private (mode 0600)`); }
}

export function writeJson(name, value) {
  ensureRemoteDir();
  writePrivateFile(remotePath(name), `${JSON.stringify(value, null, 2)}\n`);
}

export const removeFile = (name) => rmSync(remotePath(name), { force: true });

/** The remote device keys: a fresh pair, kept in memory until a pairing succeeded (then saveKeys). */
export function newKeys(random = P.systemRandom) {
  return { ...P.exportSecretKeys(P.generateDeviceKeys(random)), project_secret: P.toBase64Url(random(32)) };
}
export const saveKeys = (keys) => writeJson("remote-keys.json", { v: 1, ...keys });
export function loadKeys() {
  const stored = readJson("remote-keys.json");
  if (!stored) return null;
  const secret = P.importSecretKeys(stored);
  if (!secret || typeof stored.project_secret !== "string") throw new Error("remote-keys.json is malformed");
  return { secret, public: P.publicKeysOf(secret), projectSecret: P.fromBase64Url(stored.project_secret) };
}

export const loadIdentity = () => readJson("identity.json");
export const saveIdentity = (identity) => writeJson("identity.json", identity);

// allow_endorse (2026-11-09): may a confirmed phone add a browser it scanned (remote-endorse.mjs)? Off until the person says so
// here, at the keyboard (`worktrust remote phones allow-endorse on`).
// modes_allowed (0.11.7, owner 2026-11-12): the CEILING of agent modes a phone may start, set here only (`worktrust remote
// modes allow|deny edit|auto`); manual and plan always. admin (0.11.7): RESERVED for managing this computer from the app or
// the web with a server-signed proof (part B); on by default, honoured by nothing yet (remote-settings.mjs).
export const DEFAULT_SETTINGS = Object.freeze({ v: 1, enabled: false, paused: null, gateway: null, default_adapter: "claude-code", default_model: null, agent_path: null, codex: false, opencode: false, terminal: false, allow_endorse: false, modes_allowed: Object.freeze(["manual", "plan"]), admin: true });
export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...(readJson("settings.json") ?? {}) });
export const saveSettings = (settings) => writeJson("settings.json", { ...DEFAULT_SETTINGS, ...settings });

export const loadPhones = () => ({ pending: [], confirmed: [], removed: [], ...(readJson("phones.json") ?? {}) });
export const savePhones = (phones) => writeJson("phones.json", phones);
export const loadEndorsements = () => readJson("endorsements.json", { spent: [] }) ?? { spent: [] };
export const saveEndorsements = (value) => writeJson("endorsements.json", value);
export const confirmedFingerprints = (phones = loadPhones()) => new Set(phones.confirmed.map((p) => p.fingerprint));
/** The signing keys of the confirmed phones, by device id: the only keys whose approval decisions count. */
export const controllerKeys = (phones = loadPhones()) => Object.fromEntries(phones.confirmed.map((p) => [p.device_id, P.fromBase64Url(p.ed25519_pub)]));

export const loadProjects = () => readJson("projects.json", []);
/** Parent folders where a phone may create a new project (remote-projects.mjs): [{ root_id, path, git_init, added_at }]. */
export const loadRoots = () => readJson("roots.json", []) ?? [];
/** What a phone may preview per project, granted at the keyboard (remote-preview.mjs): { [project_id]: { ports, files } }. */
export const loadPreviewGrants = () => readJson("previews.json", {}) ?? {};
export const savePreviewGrants = (grants) => writeJson("previews.json", grants);
export const saveRoots = (roots) => writeJson("roots.json", roots);
/** The pipeline reviews made at the keyboard: { [project_id]: { sha256, reviewed_at, stages } } (remote-pipeline-config.mjs). */
export const loadPipelineReviews = () => readJson("pipelines.json", {}) ?? {};
export const savePipelineReviews = (reviews) => writeJson("pipelines.json", reviews);
/** Release numbers the person marked released at the desk (`worktrust remote releases released <n>`); the phone cannot. */
export const loadDeskMarks = () => (readJson("released.json", []) ?? []).filter((n) => Number.isSafeInteger(n) && n > 0);
export const saveDeskMarks = (numbers) => writeJson("released.json", [...new Set(numbers)].sort((a, b) => a - b));
export const saveProjects = (projects) => writeJson("projects.json", projects);
/** A stable opaque id for a folder: an HMAC of its canonical path under a key that never leaves this computer. */
export const projectIdOf = (projectSecret, canonicalPath) =>
  `prj_${P.toBase64Url(createHmac("sha256", Buffer.from(projectSecret)).update(`worktrust-remote/v1/project\n${canonicalPath}`).digest().subarray(0, 16))}`;

export function loadChannels() {
  const stored = readJson("channels.json", []);
  return stored.map((c) => P.importChannel(c)).filter(Boolean);
}
export const saveChannels = (channels) => writeJson("channels.json", channels.map((c) => P.exportChannel(c)));

/**
 * THE ISSUER KEYS THIS RELEASE TRUSTS. Bindings are verified against keys pinned in the build, never against a key a
 * server hands over. Pinned 2026-11-09 from https://app.worktrust.io/api/remote/keys (live since release 18; GATEWAY.md
 * §10 step 8): kid wtr-2026-11, Ed25519. A rotation pins the next key in a later release before the issuer uses it.
 * For a gateway on this computer only (scripts/dev-remote-relay.mjs, the tests): WORKTRUST_REMOTE_DEV_ISSUER="<kid>:<base64url key>" is read when
 * the gateway is this computer's own loopback address, and never otherwise (devIssuerAllowed).
 */
export const PINNED_ISSUER_KEYS = Object.freeze({ "wtr-2026-11": "Xlsn0fDsC0u3bmXj7FVg1uePKmOlV2yXV3ep9BaRmnA" });
export const isLoopbackGateway = (url) => {
  try {
    const u = new URL(url);
    return (u.protocol === "ws:" || u.protocol === "wss:") && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  } catch { return false; }
};
export function issuerKeys(gateway) {
  const keys = Object.fromEntries(Object.entries(PINNED_ISSUER_KEYS).map(([kid, key]) => [kid, P.fromBase64Url(key)]));
  const dev = /^([A-Za-z0-9._-]{1,64}):([A-Za-z0-9_-]{43})$/.exec(process.env.WORKTRUST_REMOTE_DEV_ISSUER ?? "");
  if (dev && gateway && isLoopbackGateway(gateway)) keys[dev[1]] = P.fromBase64Url(dev[2]);
  return keys;
}

/** The fresh random bytes the daemon needs (ids, nonces, ephemeral keys). */
export const random = (length) => new Uint8Array(randomBytes(length));
