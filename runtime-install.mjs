/** Immutable, owned runtime + engine installation for Python tool-runner caches.
 * Called only after the person's connect/update confirmation. No network, credentials or measurement logic.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const regular = (path) => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("bundled installation requires regular files"); };
const directory = (path) => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("bundled installation requires owned directories, not symlinks"); };
const checkedBytes = (path) => { regular(path); return readFileSync(path); };

export function installRuntime(runtime, engine, home, moduleNames) {
  directory(runtime); directory(engine); directory(home);
  const descriptor = checkedBytes(join(runtime, "runtime.json"));
  const manifest = JSON.parse(descriptor);
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const target = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  if (manifest.platform !== target || manifest.executable !== executable || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.archive_sha256)) throw Error("bundled runtime identity mismatch");
  const names = [executable, "LICENSE"].sort();
  if (!manifest.files || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(names) || JSON.stringify(readdirSync(runtime).sort()) !== JSON.stringify([...names, "runtime.json"].sort())) throw Error("bundled runtime file list mismatch");
  const contents = new Map([["runtime/runtime.json", descriptor]]);
  for (const name of names) {
    const bytes = checkedBytes(join(runtime, name));
    if (hash(bytes) !== manifest.files[name]) throw Error("bundled runtime integrity check failed");
    contents.set(`runtime/${name}`, bytes);
  }
  if (!Array.isArray(moduleNames) || !moduleNames.includes("worktrust.mjs") || new Set(moduleNames).size !== moduleNames.length) throw Error("invalid engine module list");
  for (const name of [...moduleNames].sort()) {
    if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name)) throw Error("invalid engine module name");
    contents.set(`engine/${name}`, checkedBytes(join(engine, name)));
  }
  if (existsSync(join(engine, "engine-release.json"))) contents.set("engine/engine-release.json", checkedBytes(join(engine, "engine-release.json")));
  const identities = Object.fromEntries([...contents].map(([name, bytes]) => [name, hash(bytes)]));
  const identity = Buffer.from(JSON.stringify(identities));
  const installations = join(home, "installations"), installed = join(installations, hash(identity));
  if (!existsSync(installations)) mkdirSync(installations, { mode: 0o700 });
  directory(installations);
  const verify = (place) => {
    directory(place);
    if (JSON.stringify(readdirSync(place).sort()) !== JSON.stringify(["engine", "installation.json", "runtime"])) throw Error("installed bundle file list mismatch");
    if (!checkedBytes(join(place, "installation.json")).equals(identity)) throw Error("installed bundle identity mismatch");
    for (const group of ["engine", "runtime"]) {
      directory(join(place, group));
      const expected = [...contents.keys()].filter(name => name.startsWith(`${group}/`)).map(name => name.slice(group.length + 1)).sort();
      if (JSON.stringify(readdirSync(join(place, group)).sort()) !== JSON.stringify(expected)) throw Error("installed bundle file list mismatch");
    }
    for (const [name, digest] of Object.entries(identities)) if (hash(checkedBytes(join(place, name))) !== digest) throw Error("installed bundle integrity check failed");
  };
  if (existsSync(installed)) verify(installed);
  else {
    const temporary = join(installations, `.install-${process.pid}-${randomBytes(8).toString("hex")}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      mkdirSync(join(temporary, "engine"), { mode: 0o700 }); mkdirSync(join(temporary, "runtime"), { mode: 0o700 });
      for (const [name, bytes] of contents) writeFileSync(join(temporary, name), bytes, { flag: "wx", mode: name === `runtime/${executable}` ? 0o755 : 0o600 });
      writeFileSync(join(temporary, "installation.json"), identity, { flag: "wx", mode: 0o600 });
      verify(temporary);
      try { renameSync(temporary, installed); }
      catch (error) { if (!existsSync(installed)) throw error; verify(installed); }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  // Existing immutable directories are never replaced, including executables used by Windows processes.
  return { executable: join(installed, "runtime", executable), bridge: join(installed, "engine", contents.has("engine/engine-release.json") ? "worktrust-launch.mjs" : "worktrust.mjs") };
}
