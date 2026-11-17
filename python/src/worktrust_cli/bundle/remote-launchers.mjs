/**
 * WHICH LAUNCHER A REMOTE AGENT UNIT MAY BE HANDED TO (CLI 0.11.15 and 0.11.16; split from remote-service.mjs, which
 * re-exports all of it). The service's unit names ONE launcher; a newer release reaches it only through a launcher that
 * was checked here, under this release's pinned key, and of the same kind as the one the unit runs:
 *
 *   npm      ~/.worktrust/verified/<identity>/worktrust-launch.mjs (package-integrity.mjs installSignedPackage): the
 *            signature, every file's hash and the identity its folder is named by (verifiedLauncher)
 *   Python   ~/.worktrust/installations/<identity>/worktrust-launch.py (runtime-install.mjs), run as `python -I`:
 *
 * A PYTHON INSTALLATION HANDS OVER TOO (CLI 0.11.16). Its unit runs `python -I ~/.worktrust/installations/<identity>/
 * worktrust-launch.py remote run` (runtime-install.mjs), which no rule here recognised: the daemon never saw itself as the
 * unit's own (so it never handed over, and said so in daemon.json), and `update` therefore re-installed the service at
 * once, under a running turn. Now the daemon names that launcher as its own (ownLauncher), `update` asks it like any other,
 * and it hands over to a newer installation only after checking it HERE (verifiedInstallation): the engine's signature
 * under this release's pinned key, every installed file against the installation's own list, the folder's name, and the
 * bootstrap byte for byte as this release writes it for those files. The Node inside is not signed by the engine's
 * signature; as with npm, where the service runs the person's own node, the runtime is the installation's.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { verifyPackage } from "./package-integrity.mjs";
import { bootstrapSource } from "./runtime-install.mjs";

const VERIFIED = /^[a-f0-9]{64}$/;
/** True for ~/.worktrust/installations/<identity>/worktrust-launch.py, a Python installation's launcher (runtime-install.mjs). */
export const isInstalledLauncher = (entry, home = homedir()) => typeof entry === "string" && dirname(dirname(entry)) === join(home, ".worktrust", "installations") && VERIFIED.test(basename(dirname(entry))) && basename(entry) === "worktrust-launch.py";
/**
 * The launcher a unit names for the daemon whose modules are in `here`: a Python installation's engine folder is started
 * by the bootstrap one folder up; everything else by the launcher beside its modules (process.argv[1] is worktrust.mjs).
 */
export const ownLauncher = (here, exists = existsSync) => (basename(here) === "engine" && VERIFIED.test(basename(dirname(here))) && basename(dirname(dirname(here))) === "installations" && exists(join(dirname(here), "worktrust-launch.py"))
  ? join(dirname(here), "worktrust-launch.py") : join(here, "worktrust-launch.mjs"));

export const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const newerRelease = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
/** The release `update` installed last (~/.worktrust/installed-release.json), or null. */
export function installedRelease(home = homedir()) {
  try { const version = JSON.parse(readFileSync(join(home, ".worktrust", "installed-release.json"), "utf8"))?.version; return RELEASE.test(version ?? "") ? version : null; } catch { return null; }
}
/** True for ~/.worktrust/verified/<identity>/worktrust-launch.mjs, the npm kind of launcher a daemon hands over to. */
export const isVerifiedLauncher = (entry, home = homedir()) => typeof entry === "string" && entry.startsWith(join(home, ".worktrust", "verified") + "/") && VERIFIED.test(entry.split("/").at(-2) ?? "") && entry.endsWith("/worktrust-launch.mjs") && entry.split("/").length === join(home, ".worktrust", "verified").split("/").length + 2;
/**
 * The verified copy of `version` in ~/.worktrust/verified, checked HERE under this release's pinned release key (the
 * signature, every file's hash, the identity its folder is named by), its launcher's path; null when none holds.
 */
export function verifiedLauncher({ home = homedir(), version, verify = verifyPackage }) {
  const store = join(home, ".worktrust", "verified");
  let names = [];
  try { names = readdirSync(store).filter((name) => VERIFIED.test(name)); } catch { return null; }
  for (const name of names) {
    const dir = join(store, name);
    let own = null;
    try { own = /const CLI_VERSION = "([^"]+)";/.exec(readFileSync(join(dir, "worktrust.mjs"), "utf8"))?.[1] ?? null; } catch { continue; }
    if (own !== version) continue;
    try { if (verify(dir)?.identity === name) return join(dir, "worktrust-launch.mjs"); } catch { /* not this one */ }
  }
  return null;
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plainFile = (file) => { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink()) throw new Error("not a regular file"); return readFileSync(file); };
const plainNames = (dir) => { const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("not a directory"); return readdirSync(dir).sort(); };
/**
 * A PYTHON INSTALLATION OF `version` in ~/.worktrust/installations, checked HERE before the service is handed to it; its
 * launcher's path, or null when none holds. Each of: the engine's signature under this release's pinned key and its version;
 * exactly the four entries; every file of the installation's own list, and no other, with its hash; the bootstrap exactly
 * as this release writes it for that list; the folder named by the hash of both. A release that writes another bootstrap
 * is refused here and installed by its own `update` (which then re-installs the service once nothing is at work).
 */
export function verifiedInstallation({ home = homedir(), version, verify = verifyPackage, platform = process.platform }) {
  const store = join(home, ".worktrust", "installations");
  let names = [];
  try { names = readdirSync(store).filter((name) => VERIFIED.test(name)); } catch { return null; }
  for (const name of names) {
    const dir = join(store, name);
    try {
      if (/const CLI_VERSION = "([^"]+)";/.exec(readFileSync(join(dir, "engine", "worktrust.mjs"), "utf8"))?.[1] !== version) continue;
      if (verify(join(dir, "engine"), "engine")?.manifest?.version !== version) continue;
      if (plainNames(dir).join() !== "engine,installation.json,runtime,worktrust-launch.py") continue;
      const identity = plainFile(join(dir, "installation.json")), bootstrap = plainFile(join(dir, "worktrust-launch.py"));
      const listed = JSON.parse(identity.toString());
      if (listed?.format !== "worktrust-installation/2" || !listed.files || typeof listed.files !== "object") continue;
      const files = Object.keys(listed.files).sort();
      if (files.some((file) => !/^(engine|runtime)\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(file))) continue;
      if ([...plainNames(join(dir, "engine")).map((n) => `engine/${n}`), ...plainNames(join(dir, "runtime")).map((n) => `runtime/${n}`)].sort().join() !== files.join()) continue;
      if (files.some((file) => sha(plainFile(join(dir, file))) !== listed.files[file])) continue;
      if (!bootstrap.equals(Buffer.from(bootstrapSource(listed.files, identity.toString(), platform === "win32" ? "node.exe" : "node")))) continue;
      if (sha(Buffer.concat([identity, bootstrap])) !== name) continue;
      return join(dir, "worktrust-launch.py");
    } catch { /* not this one */ }
  }
  return null;
}
/** Whether a daemon can be asked to move to `entry` itself: a verified npm copy or a Python installation, never a cache path. */
export const isHandoverLauncher = (entry, home = homedir()) => isVerifiedLauncher(entry, home) || isInstalledLauncher(entry, home);
/** The newer release's launcher of the SAME kind as the one the unit runs now, checked here; null when none holds. */
export const launcherFor = (current, { home = homedir(), version, verify = verifyPackage, platform = process.platform }) =>
  (isInstalledLauncher(current, home) ? verifiedInstallation({ home, version, verify, platform }) : verifiedLauncher({ home, version, verify }));
/** The version a unit's launcher belongs to (its worktrust.mjs beside it), or null. */
export function launcherVersion(entry) {
  try { const own = /const CLI_VERSION = "([^"]+)";/.exec(readFileSync(join(dirname(entry), ...(basename(entry) === "worktrust-launch.py" ? ["engine"] : []), "worktrust.mjs"), "utf8"))?.[1]; return RELEASE.test(own ?? "") ? own : null; } catch { return null; }
}
