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
 *   devices-history.jsonl  every phone and browser ever linked here, append-only (CLI 0.11.22, below savePhones)
 */
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, chmodSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
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

/**
 * A file of this folder, read privately. ONE RETRY, ONLY FOR THE RENAME RACE (release 57's verify, 2026-11-24): another process
 * writes these files by an atomic rename, and a read that lands between readPrivateFile's lstat and its open sees another
 * inode and refuses. When the file's inode changed across the failed read, it was replaced: read once more. Any other
 * failure (a link, a mode, a wrong owner, bad JSON in an unchanged file) still refuses at once. `io` is the tests' seam.
 */
export function readJson(name, fallback = null, io = {}) {
  const file = remotePath(name), read = io.read ?? readPrivateFile, inode = io.inode ?? ((f) => lstatSync(f).ino);
  if (!existsSync(file)) return fallback;
  const ino = () => { try { return inode(file); } catch { return null; } };
  const before = ino();
  try { return JSON.parse(read(file)); } catch {
    const after = ino();
    if (after === null && !existsSync(file)) return fallback; // removed meanwhile: as if it never was
    if (before !== null && after !== null && after !== before) { try { return JSON.parse(read(file)); } catch { /* refused below */ } }
    throw new Error(`${file} is unreadable or not private (mode 0600)`);
  }
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
// desk_history (0.11.17; docs/remote-agents/CHAT-HISTORY.md §7.2): may a paired phone or browser READ the history of a session of
// this computer's own desk list that was never continued from it? OFF by default (review 2026-11-17, F3: the owner has not
// given their word, docs/OPEN.md), turned on at this keyboard only (`worktrust remote desk-history on`). Anything but `true`
// is off: such an ask is refused `not_allowed`.
// desk_live (0.11.19; owner, 2026-11-21; docs/remote-agents/DESK-SESSIONS.md §Read along): may a paired phone READ ALONG, live,
// with a session running at this computer? OFF until a phone is linked at this keyboard (CLI 0.11.26, remote-read-along.mjs: no question, unless the person turned it off here) or `worktrust remote read-along on` (
// which turns desk_history on with it). A settings file of 0.11.17 or 0.11.18 with desk_history and no desk_live keeps
// exactly what it had: closed turns, never the running one.
// desk_steer (0.11.20; owner, 2026-11-21; docs/remote-agents/DESK-STEERING.md): may a paired phone (or a browser after its Remote PIN)
// SEND a prompt into a Claude Code session open at this computer? OFF until `worktrust remote desk-steer on` at this keyboard, only
// on top of read along; read along off (or desk-history off) turns it off (remote-settings.mjs).
// voice (0.11.21; owner, 2026-11-19 and 2026-11-22; docs/remote-agents/VOICE-SIRI.md): may a phone's voice key (Siri, also while the
// phone is locked) send a prompt into the newest steerable session of a project? OFF until `worktrust remote voice on` here, only on
// top of desk steering; any of the three switches below it off turns it off. Its keys live in voice.json (remote-voice.mjs).
/**
 * Whether this computer knows a confirmed device as a BROWSER (CLI 0.11.19: reading along is for the phone app only). The
 * issuer binds a browser as kind `phone`, so the binding cannot tell them apart. What the computer itself wrote can: `how:
 * "endorsed"`, set by the daemon when a confirmed phone added a browser it scanned (remote-endorse.mjs), never by the device;
 * `kind: "browser"` is honoured where a record carries it (no release writes it yet). A browser confirmed some other way
 * (its pending hello confirmed at the keyboard) is recorded like a phone and is NOT known here: for that one the gate is
 * the keyboard's switch alone. A device not in the list at all counts as a browser (fails closed).
 */
export const knownBrowser = (deviceId, phones = loadPhones()) => { const p = phones.confirmed.find((x) => x.device_id === deviceId); return !p || p.how === "endorsed" || p.kind === "browser"; };
/**
 * WHAT THIS COMPUTER'S PERSON CHOSE FOR THE THREE SWITCHES A LINK TURNS ON (CLI 0.11.26; owner, 2026-11-25; remote-read-along.mjs):
 * read along, steering from the phone, voice prompts with Siri. Beside the settings, in its own file, so nothing that rewrites the
 * settings carries it: `{ read_along, desk_steering, voice, voice_read }`, each "on", "off" or null (never chosen here). Written
 * ONLY by the person's own commands at this keyboard (`remote read-along on|off`, `remote desk-history off`, `remote desk-steer
 * on|off`, `remote voice on|off`, `remote voice read on|off`; check-remote-cli rule W): a link and an update turn on what is null
 * and never what is "off". Voice on brings reading answers aloud with it unless `voice_read` is "off" (owner, 2026-11-25).
 * `always` (CLI 0.11.27, remote-always.mjs): running with nobody logged in, written by `remote service always on|off` alone;
 * nothing turns it on but that typed command.
 * A computer asked by 0.11.19 to 0.11.25 kept its answer in read-along.json (`{ answer: "yes" | "no", at }`): read here as
 * read along's choice while chosen.json has none, never written again.
 */
export const SWITCH_NAMES = Object.freeze(["read_along", "desk_steering", "voice", "voice_read", "always"]);
const chosenWord = (v) => (v === "on" || v === "off" ? v : null);
export const loadReadAlongAsk = () => { const kept = readJson("read-along.json"); return kept && (kept.answer === "yes" || kept.answer === "no") ? { answer: kept.answer, at: Number.isSafeInteger(kept.at) ? kept.at : null } : null; };
export function loadChosen() {
  const kept = readJson("chosen.json") ?? {}, legacy = loadReadAlongAsk(), at = kept.at && typeof kept.at === "object" ? kept.at : {};
  const word = { read_along: chosenWord(kept.read_along) ?? (legacy ? (legacy.answer === "yes" ? "on" : "off") : null), desk_steering: chosenWord(kept.desk_steering), voice: chosenWord(kept.voice), voice_read: chosenWord(kept.voice_read), always: chosenWord(kept.always) };
  return { ...word, at: { read_along: Number.isSafeInteger(at.read_along) ? at.read_along : chosenWord(kept.read_along) ? null : (legacy?.at ?? null), desk_steering: Number.isSafeInteger(at.desk_steering) ? at.desk_steering : null, voice: Number.isSafeInteger(at.voice) ? at.voice : null, voice_read: Number.isSafeInteger(at.voice_read) ? at.voice_read : null, always: Number.isSafeInteger(at.always) ? at.always : null } };
}
/** `name`: one of SWITCH_NAMES; `on`: what the person typed. */
export function saveChosen(name, on, now = Date.now()) {
  if (!SWITCH_NAMES.includes(name)) throw new Error(`no such switch: ${name}`);
  const { at, ...was } = loadChosen();
  writeJson("chosen.json", { v: 1, ...was, [name]: on === true ? "on" : "off", at: { ...at, [name]: now } });
}
/**
 * THE DEFAULT ROOT (CLI 0.11.21, owner 2026-11-22; remote-default-root.mjs): `~/Desktop/WorkTrust`, made and added as a root at
 * this keyboard only. Its own file, `{ root_id | null, answer: "yes" | "no" | null, at }`, written by remote-default-root.mjs
 * alone (check-remote-cli rule D): no settings change, phone, browser, MCP door or daemon module writes it.
 */
export const loadDefaultRoot = () => { const k = readJson("default-root.json"); return { root_id: typeof k?.root_id === "string" ? k.root_id : null, answer: k?.answer === "yes" || k?.answer === "no" ? k.answer : null, at: Number.isSafeInteger(k?.at) ? k.at : null }; };
/** The default root's id as a phone reads it (device.inventory `default_root`): while it is still a root and its folder is there; else null. */
export const defaultRootOf = (kept = loadDefaultRoot(), roots = loadRoots()) => { const r = kept.root_id ? roots.find((x) => x.root_id === kept.root_id) : null; return r && existsSync(r.path) ? r.root_id : null; };
/** What a phone may read of this computer's own sessions (protocol desk.ts DESK_READS). Anything but `true` is off. */
export const deskReadOf = (settings) => (settings?.desk_history !== true ? "off" : settings.desk_live === true ? "live" : "history");
/**
 * WORKTRUST'S PRODUCTION RELAY, ON BY DEFAULT FOR EVERYONE (owner, 2026-11-14: "it must be ON by default for everyone, also
 * without Premium; the subscription comes later"; CLI 0.11.10). A computer's saved `gateway: null` means THIS default, read
 * where it is used, so a later change of the default moves every computer that never chose one; `--gateway` and
 * WORKTRUST_REMOTE_GATEWAY at `remote app` still choose another (the dev relay, tests), and that choice is saved.
 * GATEWAY.md step 9 (a crypto review and a penetration test) is still open: the owner chose the default before it.
 */
export const PRODUCTION_GATEWAY = "wss://remote.worktrust.io";
/** The relay this computer uses: its own saved choice, else WorkTrust's. */
export const gatewayOf = (settings) => settings?.gateway ?? PRODUCTION_GATEWAY;
export const DEFAULT_SETTINGS = Object.freeze({ v: 1, enabled: false, paused: null, gateway: null, default_adapter: "claude-code", default_model: null, agent_path: null, codex: false, opencode: false, terminal: false, allow_endorse: false, modes_allowed: Object.freeze(["manual", "plan"]), admin: true, desk_history: false, desk_live: false, desk_steer: false, voice: false, voice_read: false, web_search: true, web_fetch: "ask" }); // web (CLI 0.11.26): a search of the public web on by default; a web page asked on the phone, per page
/** The web tools a remote session may use, as this keyboard set them (remote-web.mjs). */
export const webOf = (settings) => ({ search: settings?.web_search !== false, fetch: settings?.web_fetch === "off" ? "off" : "ask" });
export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...(readJson("settings.json") ?? {}) });
export const saveSettings = (settings) => writeJson("settings.json", { ...DEFAULT_SETTINGS, ...settings });

export const loadPhones = () => ({ pending: [], confirmed: [], removed: [], ...(readJson("phones.json") ?? {}) });
export const savePhones = (phones) => { const before = loadPhones(); writeJson("phones.json", phones); try { trackDevices(before, phones); } catch { /* the history is a record, never a reason a link fails */ } };

/**
 * THE DEVICE HISTORY (CLI 0.11.22; owner, 2026-11-23): ~/.worktrust/remote/devices-history.jsonl, 0600, APPEND-ONLY. Never
 * rewritten; a compaction may only append a summary. One record when a phone or browser is linked, one when it ends, its name
 * when it gets one, and the daemon's counts (deltas, flushed at most once a minute: createDeviceCounts). Ids, fingerprints, a
 * kind, a name, how and when, and counts only: never content, a project, a path, a title or a key. savePhones is the one writer
 * of phones.json, so every link and every end anywhere (the daemon's QR, a typed code confirmed here, a browser a phone added,
 * a removal here, a phone that disconnected itself, a revocation) is seen here by comparing the lists. The first write backfills
 * once from phones.json: confirmed and removed devices, their known times, and NO counts (unknown is absent, never 0).
 * remote-device-history.mjs reads and shows it (`remote phones --history`).
 */
export const HISTORY_FILE = "devices-history.jsonl";
const kindOf = (p) => (p.how === "endorsed" || p.kind === "browser" ? "browser" : "phone");
const linkedRecord = (p, extra = {}) => ({ t: "linked", device_id: p.device_id, fingerprint: p.fingerprint, kind: kindOf(p), ...(p.name ? { name: String(p.name).slice(0, 64) } : {}), how: p.how ?? null, ...(p.endorsed_by?.fingerprint ? { endorsed_by: p.endorsed_by.fingerprint } : {}), linked_at: p.confirmed_at ?? null, ...extra });
export function appendHistory(records) {
  if (!records.length) return;
  ensureRemoteDir();
  const fd = openSync(remotePath(HISTORY_FILE), "a", 0o600);
  try { writeSync(fd, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); } finally { closeSync(fd); }
}
/** Once per computer: the file is created exclusively, so two processes never both backfill. */
export function ensureHistory(phones = loadPhones(), now = Date.now()) {
  ensureRemoteDir();
  let fd;
  try { fd = openSync(remotePath(HISTORY_FILE), "wx", 0o600); } catch { return false; }
  const removed = (phones.removed ?? []).filter((r) => !phones.confirmed.some((p) => p.device_id === r.device_id));
  const records = [...phones.confirmed.map((p) => linkedRecord(p, { backfill: true })), ...removed.flatMap((r) => [{ t: "linked", device_id: r.device_id, fingerprint: r.fingerprint, linked_at: null, backfill: true }, { t: "ended", device_id: r.device_id, how: r.how ?? null, ended_at: r.removed_at ?? null }]), { t: "backfill", at: now }];
  try { writeSync(fd, records.map((r) => JSON.stringify(r)).join("\n") + "\n"); } finally { closeSync(fd); }
  return true;
}
export function trackDevices(before, after, now = Date.now()) {
  ensureHistory(before, now);
  const was = new Map(before.confirmed.map((p) => [p.device_id, p])), is = new Map(after.confirmed.map((p) => [p.device_id, p]));
  const out = [];
  for (const [id, p] of is) if (!was.has(id)) out.push(linkedRecord(p, { linked_at: p.confirmed_at ?? now }));
  for (const [id, p] of is) if (was.has(id) && p.name && p.name !== was.get(id).name) out.push({ t: "named", device_id: id, name: String(p.name).slice(0, 64) });
  for (const [id] of was) if (!is.has(id)) { const r = (after.removed ?? []).find((x) => x.device_id === id); out.push({ t: "ended", device_id: id, how: r?.how ?? null, ended_at: r?.removed_at ?? now }); }
  appendHistory(out);
}
export const readHistory = () => { try { return readFileSync(remotePath(HISTORY_FILE), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };
/**
 * THE DAEMON'S COUNTS (0.11.22): sessions started, commands, prompts and voice prompts per device, and when it was last heard,
 * kept in memory where the commands already pass (remote-daemon.mjs receiveCommand) and appended as deltas by `flush`, which the
 * daemon's existing three-second tick calls (at most once a minute) and its stop: no disk write per frame. A voice key's prompt
 * counts on its phone (`parentOf`). Since 0.11.23 the same deltas go to `onFlush`, the issuer's report (ISSUER.md §13).
 */
export function createDeviceCounts({ now = Date.now, parentOf = () => null, everyMs = 60_000, onFlush = null } = {}) {
  const pending = new Map();
  let flushedAt = 0;
  return {
    note(sender, type) {
      const parent = parentOf(sender), id = parent ?? sender, c = pending.get(id) ?? { sessions: 0, commands: 0, prompts: 0, voice_prompts: 0 };
      c.commands += 1; if (type === "agent.start") c.sessions += 1; if (type === "agent.prompt") { if (parent) c.voice_prompts += 1; else c.prompts += 1; } // `type` null: received, not taken (only the command counts)
      c.last_seen = now(); pending.set(id, c);
    },
    flush(force = false) {
      if (pending.size === 0 || (!force && now() - flushedAt < everyMs)) return false;
      flushedAt = now();
      appendHistory([...pending].map(([device_id, c]) => ({ t: "counts", device_id, ...c, at: now() })));
      try { onFlush?.([...pending].map(([device_id, c]) => ({ device_id, ...c }))); } catch { /* the report is the issuer's copy; the local history is written */ } // 0.11.23: the same deltas to the issuer (remote-pairing.mjs createCountsReporter)
      pending.clear();
      return true;
    },
  };
}
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
