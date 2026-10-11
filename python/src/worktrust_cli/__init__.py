"""Distribution launcher only. All evidence calculation remains in the Node CLI."""
import hashlib
import json
import os
import platform
from pathlib import Path
import re
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


def verified_runtime():
    root = Path(__file__).resolve().parent / "runtime"
    descriptor = root / "runtime.json"
    if root.is_symlink() or descriptor.is_symlink():
        raise ValueError("bundled runtime must not use symlinks")
    metadata = json.loads(descriptor.read_text(encoding="utf-8"))
    if set(metadata) != {"version","platform","executable","archive_sha256","files"}:
        raise ValueError("invalid bundled runtime descriptor")
    system = {"Darwin":"darwin","Linux":"linux","Windows":"win"}.get(platform.system())
    arch = {"x86_64":"x64","amd64":"x64","aarch64":"arm64","arm64":"arm64"}.get(platform.machine().lower())
    if metadata["platform"] != f"{system}-{arch}":
        raise ValueError("bundled runtime does not support this OS/architecture")
    executable = "node.exe" if os.name == "nt" else "node"
    if metadata["executable"] != executable or set(metadata["files"]) != {executable,"LICENSE"}:
        raise ValueError("invalid bundled runtime file list")
    if not re.fullmatch(r"\d+\.\d+\.\d+", metadata["version"]) or not re.fullmatch(r"[a-f0-9]{64}", metadata["archive_sha256"]):
        raise ValueError("invalid bundled runtime identity")
    if {path.name for path in root.iterdir()} != {executable,"LICENSE","runtime.json"}:
        raise ValueError("bundled runtime file list mismatch")
    for name,digest in metadata["files"].items():
        path = root/name
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r"[a-f0-9]{64}",digest) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("bundled runtime integrity check failed")
    return root/executable


def main():
    try:
        entry = verified_entry()
        node = verified_runtime()
        env = dict(os.environ)
        # Package-manager selection is authoritative. This does not disable agent detection.
        env["WORKTRUST_RELAYED"] = "1"
        env["WORKTRUST_BUNDLED_RUNTIME_DIR"] = str(node.parent)
        argv = [str(node), str(entry), *sys.argv[1:]]
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
