"""Distribution launcher only. All evidence calculation remains in the Node CLI."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def verified_entry():
    root = Path(__file__).resolve().parent / "bundle"
    manifest_path = root / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("bundle manifest must not be a symlink")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if set(manifest) != {"version", "files"} or not re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]):
        raise ValueError("invalid bundle manifest")
    files = manifest["files"]
    if not isinstance(files, dict) or "worktrust.mjs" not in files:
        raise ValueError("invalid bundle file list")
    if set(p.name for p in root.iterdir()) != set(files) | {"manifest.json"}:
        raise ValueError("bundle file list mismatch")
    for name, digest in files.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*\.mjs", name) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("invalid bundle file identity")
        path = root / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("bundle integrity check failed")
    return root / "worktrust.mjs"


def main():
    try:
        entry = verified_entry()
        node = shutil.which("node")
        if not node:
            raise ValueError("Node.js 22.5 or newer is required; install Node.js separately")
        probe = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5, check=True)
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\s*", probe.stdout)
        if not match or tuple(map(int, match.groups())) < (22, 5, 0):
            raise ValueError("Node.js 22.5 or newer is required")
        env = dict(os.environ)
        # Package-manager selection is authoritative. This does not disable agent detection.
        env["WORKTRUST_RELAYED"] = "1"
        argv = [node, str(entry), *sys.argv[1:]]
        if os.name != "nt":
            os.execve(node, argv, env)
        child = subprocess.Popen(argv, env=env)
        try:
            return child.wait()
        except KeyboardInterrupt:
            # Windows delivers console Ctrl-C to both processes; allow the child to finish.
            try:
                return child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait()
                return 130
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(f"worktrust: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
