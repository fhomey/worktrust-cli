"""Explicit build-time fetch of pinned official Node binaries. Never imported by the CLI."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import platform
import shutil
import stat
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
MAX_ARCHIVE = 150 * 1024 * 1024
MAX_BINARY = 200 * 1024 * 1024


def host_target():
    system = {"Darwin":"darwin", "Linux":"linux", "Windows":"win"}.get(platform.system())
    architecture = {"x86_64":"x64", "amd64":"x64", "arm64":"arm64", "aarch64":"arm64"}.get(platform.machine().lower())
    target = f"{system}-{architecture}"
    if system is None or architecture is None:
        raise ValueError(f"unsupported runtime platform: {target}")
    return target


def selected_members(data, archive_name, executable):
    """Copy only two exact regular members; never extract archive paths or links."""
    suffix = ".zip" if archive_name.endswith(".zip") else ".tar.gz" if archive_name.endswith(".tar.gz") else ".tar.xz"
    prefix = archive_name[:-len(suffix)]
    expected = {f"{prefix}/{'node.exe' if executable == 'node.exe' else 'bin/node'}":executable,
                f"{prefix}/LICENSE":"LICENSE"}
    result = {}
    if suffix == ".zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.infolist():
                if member.filename not in expected:
                    continue
                mode = member.external_attr >> 16
                if member.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                    raise ValueError("runtime archive member must be a regular file")
                if member.file_size > MAX_BINARY or member.filename in result:
                    raise ValueError("invalid runtime archive member")
                result[member.filename] = archive.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
            for member in archive:
                if member.name not in expected:
                    continue
                if not member.isfile() or member.size > MAX_BINARY or member.name in result:
                    raise ValueError("invalid runtime archive member")
                stream = archive.extractfile(member)
                result[member.name] = stream.read(MAX_BINARY + 1)
    if set(result) != set(expected):
        raise ValueError("runtime archive is missing an expected file")
    if any(not value or len(value) > MAX_BINARY for value in result.values()):
        raise ValueError("runtime archive member size invalid")
    return {expected[name]: value for name, value in result.items()}


def prepare(target, cache):
    lock = json.loads((ROOT / "runtime-lock.json").read_text())
    item = lock["targets"].get(target)
    if item is None:
        raise ValueError(f"unsupported runtime target: {target}")
    cache.mkdir(parents=True, exist_ok=True)
    cached = cache / item["archive"]
    if cached.is_symlink():
        raise ValueError("runtime archive cache must not be a symlink")
    if cached.exists():
        if cached.stat().st_size > MAX_ARCHIVE:
            raise ValueError("runtime archive too large")
        data = cached.read_bytes()
    else:
        request = urllib.request.Request(lock["base_url"] + item["archive"], headers={"User-Agent":"WorkTrust-runtime-build"})
        with urllib.request.urlopen(request, timeout=60) as response:
            if not response.url.startswith("https://nodejs.org/dist/"):
                raise ValueError("runtime download redirected away from official origin")
            data = response.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError("official runtime archive checksum mismatch")
    if not cached.exists():
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as handle:
            handle.write(data)
            pending = Path(handle.name)
        pending.replace(cached)
    executable = "node.exe" if target.startswith("win-") else "node"
    members = selected_members(data, item["archive"], executable)
    destination = ROOT / "src/worktrust_cli/runtime"
    if destination.is_symlink():
        raise ValueError("runtime staging directory must not be a symlink")
    destination.mkdir(parents=True, exist_ok=True)
    for entry in destination.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            raise ValueError("unexpected directory in runtime stage")
        entry.unlink()
    for name, payload in members.items():
        path = destination/name
        path.write_bytes(payload)
        path.chmod(0o755 if name == executable else 0o644)
    descriptor = {"version":lock["version"], "platform":target, "executable":executable,
                  "archive_sha256":item["sha256"],
                  "files":{name:hashlib.sha256(payload).hexdigest() for name,payload in sorted(members.items())}}
    (destination/"runtime.json").write_text(json.dumps(descriptor,indent=2)+"\n")
    print(f"Staged Node {lock['version']} for {target}; official archive SHA256 verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=host_target())
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir())/"worktrust-node-build-cache")
    args = parser.parse_args()
    prepare(args.target, args.cache)
