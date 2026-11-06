/**
 * UPDATING ITSELF WHEN THE PERSON TURNS IT ON (owner, 2026-11-05; CLI 0.10.37). The ONE place this CLI installs code
 * without a person typing a command, and only on that person's own act: turning CLI active back on for this computer in
 * Sources (set_my_computer_measure, a resume from a pause this computer had confirmed). WorkTrust's door answer
 * (api/cli/door) then carries a one-shot instruction `{ version, at }`: the version WorkTrust names from the published
 * npm release, `at` the moment of that resume, which is the instruction's id. A version string alone never starts it:
 * no instruction, no install, and the same id is never handled twice.
 *
 * WHAT RUNS, AND ONLY WHEN EVERYTHING HOLDS (SECURITY.md "Updating itself when you turn it on"):
 *   1. the method: this CLI runs from the verified npm copy in ~/.worktrust/verified (the launcher checked it); Python
 *      installations and anything else update by the person's own command and report `python` / `unsupported`;
 *   2. the version is NEWER than this CLI (never equal, never a downgrade: `current`);
 *   3. npm beside the running Node (else the first on PATH) is 11.12.0 or later, the first that lists the attestations it
 *      verified (`audit signatures --include-attestations`); an older one is `unsupported` before anything is fetched;
 *   4. THE COMPUTER'S OWN POLICY, not the server's (review M1): npm's registry record names <version> as `latest` and does
 *      not deprecate it (a version the console classes critical is deprecated on npm too: tools/worktrust-release/README);
 *   5. `npm install --ignore-scripts` of exactly worktrust@<version> from registry.npmjs.org into a fresh staging folder
 *      (nothing of the package runs during install);
 *   6. `npm audit signatures` there: the registry signature and the Sigstore attestations, verified BY NPM against its own
 *      trust roots and relayed here; the SLSA provenance's certificate must name
 *      github.com/fhomey/worktrust-cli/.github/workflows/publish.yml at tag v<version> and carry GitHub Actions' OIDC
 *      issuer in Fulcio's extension 1.3.6.1.4.1.57264.1.8, its DSSE signature verify under it, its subject be this exact
 *      tarball (sha512 of the lockfile);
 *   7. WorkTrust's own release signature (package-release.json) under the key pinned in THIS CLI, naming <version>: the
 *      binding root, which needs neither npm's word nor WorkTrust's server;
 *   8. only then: the verified copy is installed beside the current one, and the NEW launcher (which verifies itself
 *      again) runs `update --yes`: what was agreed before is refreshed, nothing new is coupled, no history is sent.
 * A failed check leaves the running CLI as it is and reports a code (`unverified` or `failed`), never content, on the
 * next door call. It runs detached from the hook, under a lock, and logs to ~/.worktrust/update.log on this computer only.
 */
import { spawn } from "node:child_process";
import { X509Certificate, verify as verifySignature } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** The closed list of outcomes reported back as `worktrust-update/<code>.<id>` (mcp_identify knows the same list). */
export const UPDATE_RESULTS = ["installed", "current", "python", "unsupported", "unverified", "failed"];
export const REGISTRY = "https://registry.npmjs.org/";
export const REPOSITORY = "https://github.com/fhomey/worktrust-cli";
export const WORKFLOW = ".github/workflows/publish.yml";
export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA = "https://slsa.dev/provenance/v1";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** An attempt that has not finished in half an hour died (a closed lid, a killed process): it counts as failed, once. */
const STALE_MS = 30 * 60_000;
/** The first npm whose `audit signatures --include-attestations` lists the bundles it verified (review M2). */
export const NPM_SINCE = "11.12.0";

/** Fulcio's OIDC issuer extension, 1.3.6.1.4.1.57264.1.8, as its DER OID bytes. */
const FULCIO_ISSUER_OID = Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x08]);
/** One DER element at `at`: its tag, where its content starts and ends. Null when it does not fit. */
function der(bytes, at) {
  if (at + 2 > bytes.length) return null;
  const tag = bytes[at]; let length = bytes[at + 1], start = at + 2;
  if (length & 0x80) { const count = length & 0x7f; if (count === 0 || count > 4 || start + count > bytes.length) return null; length = 0; for (let i = 0; i < count; i += 1) length = length * 256 + bytes[start + i]; start += count; }
  return start + length > bytes.length ? null : { tag, start, end: start + length };
}
function children(bytes, item) { const out = []; for (let at = item.start; at < item.end;) { const child = der(bytes, at); if (!child) return null; out.push(child); at = child.end; } return out; }
/** The issuer Fulcio wrote into the certificate's own extension (a DER UTF8String), or null: never a byte string elsewhere. */
export function fulcioIssuer(raw) {
  const certificate = der(raw, 0), tbs = certificate && children(raw, certificate)?.[0];
  const holder = tbs && children(raw, tbs)?.find((item) => item.tag === 0xa3);
  const list = holder && children(raw, holder)?.[0];
  const found = [];
  for (const extension of (list && children(raw, list)) ?? []) {
    const parts = children(raw, extension);
    if (!parts || parts[0]?.tag !== 0x06 || !raw.subarray(parts[0].start, parts[0].end).equals(FULCIO_ISSUER_OID)) continue;
    const octets = parts.at(-1), value = octets?.tag === 0x04 ? der(raw, octets.start) : null;
    found.push(value?.tag === 0x0c && value.end === octets.end ? raw.subarray(value.start, value.end).toString("utf8") : null);
  }
  return found.length === 1 ? found[0] : null;
}

export function newerThan(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The instruction in a door answer, `{ id, version }`, or null: an id is the resume moment in whole seconds. */
export function updateOffer(update) {
  if (!update || typeof update !== "object" || typeof update.version !== "string" || !VERSION.test(update.version) || typeof update.at !== "string") return null;
  const id = Math.floor(Date.parse(update.at) / 1000);
  return Number.isSafeInteger(id) && id > 0 ? { id, version: update.version } : null;
}

/**
 * THE ONE DECISION, given an instruction (tools/worktrust-release/update-policy.mjs `resumePolicy` says the same;
 * scripts/test-cli-self-update.mjs holds them equal). Only the verified npm copy installs, and only a newer version.
 */
export function resumeDecision({ method, current, version }) {
  if (!VERSION.test(version ?? "") || !VERSION.test(current ?? "")) return { install: false, outcome: "failed" };
  if (!newerThan(version, current)) return { install: false, outcome: "current" };
  if (method === "npm") return { install: true, outcome: null };
  if (method === "python") return { install: false, outcome: "python" };
  return { install: false, outcome: "unsupported" };
}

/** The outcome to report for the state kept in update.json; null while an attempt waits or runs. */
export function updateResult(state, now = Date.now()) {
  if (!state || !Number.isSafeInteger(state.id)) return null;
  if (UPDATE_RESULTS.includes(state.state)) return state.state;
  if (["pending", "running"].includes(state.state) && !(now - Date.parse(state.at ?? "") <= STALE_MS)) return "failed";
  return null;
}

/**
 * WHAT NPM VERIFIED, BOUND TO OUR PUBLISHER. npm has already checked the registry signature and the attestation bundles
 * (certificate chain to Sigstore's root, transparency log, signatures); this names whose they are. Null when everything
 * holds, else a short reason for the local log (never sent).
 */
export function provenanceProblem({ audit, auditCode, lock, version }) {
  if (auditCode !== 0) return "audit-exit";
  if (!audit || !Array.isArray(audit.invalid) || !Array.isArray(audit.missing) || audit.invalid.length > 0 || audit.missing.length > 0) return "audit-invalid";
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || Object.keys(packages).sort().join(",") !== ",node_modules/worktrust") return "lock-shape";
  const entry = packages["node_modules/worktrust"];
  if (entry?.version !== version || entry.resolved !== `${REGISTRY}worktrust/-/worktrust-${version}.tgz` || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")) return "lock-entry";
  const digest = Buffer.from(entry.integrity.slice(7), "base64").toString("hex");
  const verified = (Array.isArray(audit.verified) ? audit.verified : []).filter((one) => one?.name === "worktrust" && one.version === version && one.location === "node_modules/worktrust");
  if (verified.length !== 1) return "not-verified";
  const bundles = (Array.isArray(verified[0].attestationBundles) ? verified[0].attestationBundles : []).filter((one) => one?.predicateType === SLSA);
  if (bundles.length !== 1) return "no-provenance";
  const bundle = bundles[0].bundle;
  const raw = bundle?.verificationMaterial?.certificate?.rawBytes ?? bundle?.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  let certificate;
  try { certificate = new X509Certificate(Buffer.from(String(raw), "base64")); } catch { return "certificate"; }
  if (certificate.subjectAltName !== `URI:${REPOSITORY}/${WORKFLOW}@refs/tags/v${version}`) return "identity";
  if (fulcioIssuer(certificate.raw) !== OIDC_ISSUER) return "issuer";
  const envelope = bundle.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) return "envelope";
  const body = Buffer.from(envelope.payload, "base64");
  const signedBytes = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(envelope.payloadType)} ${envelope.payloadType} ${body.length} `), body]);
  let signed = false;
  try { signed = verifySignature("sha256", signedBytes, certificate.publicKey, Buffer.from(String(envelope.signatures[0].sig), "base64")); } catch { signed = false; }
  if (!signed) return "signature";
  let statement;
  try { statement = JSON.parse(body.toString("utf8")); } catch { return "statement"; }
  if (statement?.predicateType !== SLSA || !Array.isArray(statement.subject) || statement.subject.length !== 1) return "statement";
  const [subject] = statement.subject;
  if (subject?.name !== `pkg:npm/worktrust@${version}` || subject.digest?.sha512 !== digest) return "subject";
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== REPOSITORY || workflow.path !== WORKFLOW || workflow.ref !== `refs/tags/v${version}`) return "workflow";
  return null;
}

/**
 * npm: the one beside the running Node first (its own installation: <prefix>/lib/node_modules/npm, or on Windows
 * <dir>/node_modules/npm), run under this Node; else the first on PATH (absolute directories only). On Windows the
 * npm-cli.js runs under this Node: a .cmd needs a shell.
 */
export function findNpm(env = process.env, platform = process.platform, node = process.execPath) {
  const beside = platform === "win32" ? join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js") : join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(beside)) return { command: node, prefix: [beside] };
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter).filter((one) => one && isAbsolute(one))) {
    if (platform === "win32") {
      const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      if (existsSync(join(dir, "npm.cmd")) && existsSync(cli)) return { command: process.execPath, prefix: [cli] };
    } else if (existsSync(join(dir, "npm"))) return { command: join(dir, "npm"), prefix: [] };
  }
  return null;
}

function runProcess(command, args, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    let out = "", err = "", settled = false;
    const finish = (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, out, err }); } };
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch { resolve({ code: -1, out, err }); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeout);
    child.stdout.on("data", (chunk) => { if (out.length < 8 << 20) out += chunk; });
    child.stderr.on("data", (chunk) => { if (err.length < 65536) err += chunk; });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** One line per event, on this computer only: versions, codes and a short reason; never a key or a path of the person's. */
function logger(home) {
  const file = join(home, "update.log");
  return (...words) => {
    try {
      if (existsSync(file) && statSync(file).size > 256 * 1024) writeFileSync(file, readFileSync(file, "utf8").slice(-64 * 1024), { mode: 0o600 });
      appendFileSync(file, `${new Date().toISOString()} ${words.join(" ").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600)}\n`, { mode: 0o600 });
    } catch { /* a log that cannot be written changes nothing */ }
  };
}

function takeLock(path) {
  for (let tries = 0; tries < 2; tries += 1) {
    try { closeSync(openSync(path, "wx", 0o600)); return () => rmSync(path, { force: true }); }
    catch (error) {
      if (error?.code !== "EEXIST") return null;
      try { if (Date.now() - statSync(path).mtimeMs > STALE_MS) { rmSync(path, { force: true }); continue; } } catch { continue; }
      return null;
    }
  }
  return null;
}

/**
 * The detached run the hook starts (`worktrust self-update`). `options`: home (~/.worktrust), method ("npm" | "python" |
 * "unknown"), current (this CLI's version), readState / saveState (update.json), verifyPackage / installSignedPackage
 * (this CLI's package-integrity, its pinned release key), nodeArgs (Node flags for the new launcher), agentEnv (the agent
 * markers left out of the update's environment), env.
 */
export async function runSelfUpdate(options) {
  const { home } = options;
  const release = takeLock(join(home, "update.lock"));
  if (!release) return null;
  const log = logger(home);
  try {
    const state = options.readState();
    if (state?.state !== "pending" || !Number.isSafeInteger(state.id)) return null;
    // COMPARE AND SET (review L4): an outcome is written only while the stored instruction is still the one that started.
    const save = (next) => { if (options.readState()?.id === state.id) options.saveState(next); };
    // CONSUMED BEFORE ANYTHING RUNS: whatever happens next, this instruction is never taken again.
    save({ state: "running", at: new Date().toISOString() });
    log("start", `id=${state.id}`, `from=${options.current}`, `to=${state.version}`, `method=${options.method}`);
    let outcome;
    try { outcome = await attempt(options, state.version, log); } catch (error) { log("error", String(error?.message ?? error).slice(0, 200)); outcome = "failed"; }
    save({ state: outcome, at: new Date().toISOString() });
    log("result", outcome);
    return outcome;
  } finally { release(); }
}

async function attempt(options, version, log) {
  const decision = resumeDecision({ method: options.method, current: options.current, version });
  if (!decision.install) return decision.outcome;
  const env = options.env ?? process.env;
  const npm = findNpm(env);
  if (!npm) { log("no-npm"); return "unsupported"; }
  const quiet = Object.fromEntries(Object.entries(env).filter(([name]) => !(options.agentEnv ?? []).includes(name)));
  const said = await runProcess(npm.command, [...npm.prefix, "--version"], { env: quiet, cwd: options.home, timeout: 30_000 });
  const npmVersion = /^(\d{1,4}\.\d{1,4}\.\d{1,4})/.exec(said.out.trim())?.[1] ?? null;
  if (said.code !== 0 || !npmVersion || newerThan(NPM_SINCE, npmVersion)) { log("unsupported", "npm-old", `npm=${npmVersion ?? "unknown"}`, `needs=${NPM_SINCE}`); return "unsupported"; }
  // THE COMPUTER'S OWN POLICY (review M1): whatever the door names, only npm's `latest`, and never a deprecated version.
  const viewed = await runProcess(npm.command, [...npm.prefix, "view", `worktrust@${version}`, "--json", `--registry=${REGISTRY}`], { env: quiet, cwd: options.home, timeout: 60_000 });
  if (viewed.code !== 0) { log("view", `exit=${viewed.code}`, viewed.err.slice(-200)); return "failed"; }
  let record = null;
  try { record = JSON.parse(viewed.out); } catch { record = null; }
  if (record?.version !== version || record?.["dist-tags"]?.latest !== version) { log("unverified", "not-latest", `latest=${String(record?.["dist-tags"]?.latest ?? "unknown").slice(0, 20)}`); return "unverified"; }
  if (record.deprecated) { log("unverified", "deprecated"); return "unverified"; }
  const stages = join(options.home, "update-stage");
  mkdirSync(stages, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(stages, "run-"));
  try {
    writeFileSync(join(stage, "package.json"), `${JSON.stringify({ name: "worktrust-update-stage", version: "0.0.0", private: true })}\n`, { mode: 0o600 });
    const common = ["--prefix", stage, `--registry=${REGISTRY}`];
    const installed = await runProcess(npm.command, [...npm.prefix, "install", ...common, "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `worktrust@${version}`], { env: quiet, cwd: stage, timeout: 180_000 });
    if (installed.code !== 0) { log("install", `exit=${installed.code}`, installed.err.slice(-300)); return "failed"; }
    const audited = await runProcess(npm.command, [...npm.prefix, "audit", "signatures", ...common, "--json", "--include-attestations"], { env: quiet, cwd: stage, timeout: 120_000 });
    let audit = null, lock = null;
    try { audit = JSON.parse(audited.out); } catch { audit = null; }
    try { lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8")); } catch { lock = null; }
    const problem = provenanceProblem({ audit, auditCode: audited.code, lock, version });
    if (problem) { log("unverified", problem); return "unverified"; }
    const unpacked = join(stage, "node_modules", "worktrust");
    let launcher;
    try {
      const checked = options.verifyPackage(unpacked);
      if (checked?.manifest?.version !== version) { log("unverified", "release-version"); return "unverified"; }
      launcher = options.installSignedPackage(unpacked, options.home);
    } catch (error) { log("unverified", String(error?.message ?? "release-signature").slice(0, 80)); return "unverified"; }
    // THE NEW CLI DOES THE SWITCH, as `npx worktrust update --yes` would: agreed entries refreshed, nothing new coupled.
    const switched = await runProcess(process.execPath, [...(options.nodeArgs ?? []), launcher, "update", "--yes"], { env: { ...quiet, WORKTRUST_RELAYED: "1" }, cwd: options.home, timeout: 600_000 });
    if (switched.code !== 0) { log("switch", `exit=${switched.code}`, switched.err.slice(-300)); return "failed"; }
    return "installed";
  } finally {
    // A folder that cannot be removed now (Windows: a file still open, EBUSY) changes no outcome (review L5).
    try { rmSync(stage, { recursive: true, force: true }); } catch (error) { log("cleanup", String(error?.code ?? "error")); }
  }
}
