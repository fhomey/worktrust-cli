/** Immutable, owned runtime + engine installation for Python tool-runner caches.
 * Called only after the person's connect/update confirmation. No network, credentials or measurement logic.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { verifyPackage } from "./package-integrity.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const regular = (path) => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("bundled installation requires regular files"); };
const directory = (path) => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("bundled installation requires owned directories, not symlinks"); };
const checkedBytes = (path) => { regular(path); return readFileSync(path); };

export function installRuntime(runtime, engine, home, moduleNames) {
  directory(runtime); directory(engine); directory(home);
  const python = process.env.WORKTRUST_BUNDLED_PYTHON;
  if (!python || !isAbsolute(python) || !existsSync(python)) throw Error("trusted Python interpreter required");
  // The Python entry authenticates this package before Node starts; check again before persisting it.
  const packageRoot = dirname(realpathSync(engine));
  if (realpathSync(runtime) !== join(resolve(packageRoot), "runtime") || realpathSync(engine) !== join(resolve(packageRoot), "bundle")) throw Error("bundled distribution layout mismatch");
  verifyPackage(packageRoot, "python");
  verifyPackage(engine, "engine");
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
  const identity = Buffer.from(JSON.stringify({ format: "worktrust-installation/2", files: identities }));
  // The external, package-manager Python starts BEFORE the copied Node executable. This bootstrap
  // pins the hashes authenticated above; it never trusts a locally rewritten descriptor to bless code.
  const bootstrap = Buffer.from(`import hashlib, json, os, pathlib, subprocess, sys
EXPECTED = json.loads(${JSON.stringify(JSON.stringify(identities))})
IDENTITY = ${JSON.stringify(identity.toString())}
root = pathlib.Path(__file__).absolute().parent.resolve()
try:
    if not sys.flags.isolated or root.is_symlink(): raise ValueError("PACKAGE_BOOTSTRAP_REQUIRED")
    if set(p.name for p in root.iterdir()) != {"engine", "runtime", "installation.json", "worktrust-launch.py"}: raise ValueError("PACKAGE_FILE_LIST_CHANGED")
    for group in ("engine", "runtime"):
        folder = root / group
        if folder.is_symlink() or not folder.is_dir(): raise ValueError("PACKAGE_NON_REGULAR_DIRECTORY")
        if set(p.name for p in folder.iterdir()) != {name.split("/", 1)[1] for name in EXPECTED if name.startswith(group + "/")}: raise ValueError("PACKAGE_FILE_LIST_CHANGED")
    marker = root / "installation.json"
    if marker.is_symlink() or marker.read_text() != IDENTITY: raise ValueError("PACKAGE_INSTALLATION_IDENTITY_MISMATCH")
    for name, digest in EXPECTED.items():
        file = root / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size > 128 * 1024 * 1024 or hashlib.sha256(file.read_bytes()).hexdigest() != digest: raise ValueError("PACKAGE_FILE_CHANGED")
except (OSError, ValueError):
    print("worktrust: PACKAGE_VERIFICATION_FAILED. Execution stopped; reinstall an official WorkTrust release.", file=sys.stderr)
    sys.exit(1)
node = root / "runtime" / ${JSON.stringify(executable)}
entry = root / "engine" / "worktrust-launch.mjs"
env = dict(os.environ)
env["WORKTRUST_BUNDLED_PYTHON"] = sys.executable
env["WORKTRUST_INSTALLED_LAUNCHER"] = str(root / "worktrust-launch.py")
for key in ("NODE_OPTIONS", "NODE_PATH", "WORKTRUST_BUNDLED_RUNTIME_DIR"):
    env.pop(key, None)
argv = [str(node), str(entry), *sys.argv[1:]]
if os.name != "nt": os.execve(node, argv, env)
sys.exit(subprocess.call(argv, env=env))
`);
  contents.set("worktrust-launch.py", bootstrap);
  const installations = join(home, "installations"), installed = join(installations, hash(Buffer.concat([identity, bootstrap])));
  if (!existsSync(installations)) mkdirSync(installations, { mode: 0o700 });
  directory(installations);
  const verify = (place) => {
    directory(place);
    if (JSON.stringify(readdirSync(place).sort()) !== JSON.stringify(["engine", "installation.json", "runtime", "worktrust-launch.py"])) throw Error("installed bundle file list mismatch");
    if (!checkedBytes(join(place, "installation.json")).equals(identity)) throw Error("installed bundle identity mismatch");
    for (const group of ["engine", "runtime"]) {
      directory(join(place, group));
      const expected = [...contents.keys()].filter(name => name.startsWith(`${group}/`)).map(name => name.slice(group.length + 1)).sort();
      if (JSON.stringify(readdirSync(join(place, group)).sort()) !== JSON.stringify(expected)) throw Error("installed bundle file list mismatch");
    }
    if (!checkedBytes(join(place, "worktrust-launch.py")).equals(bootstrap)) throw Error("installed bootstrap integrity check failed");
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
  return { executable: python, args: ["-I"], bridge: join(installed, "worktrust-launch.py") };
}
