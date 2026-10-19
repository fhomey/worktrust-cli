"""Protected release job: sign exact archive contents and the final downloadable artifacts. No network."""
import argparse
import base64
import csv
import hashlib
import io
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile
import zipfile
from Cryptodome.PublicKey import ECC
from Cryptodome.Signature import eddsa

MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def key_identity(key):
    if key.curve != "Ed25519":
        raise ValueError("RELEASE_ED25519_REQUIRED")
    return hashlib.sha256(key.public_key().export_key(format="DER")).hexdigest()


def seal(purpose, payload, key):
    signature = eddsa.new(key, "rfc8032").sign((f"worktrust:{purpose}:1\n" + canonical(payload)).encode("utf-8"))
    return {"keyId": key_identity(key), "payload": payload, "signature": base64.urlsafe_b64encode(signature).decode().rstrip("=")}


def valid_name(name):
    parts = name.split("/")
    return len(name) <= 240 and all(
        (re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]*", part) and part != "..")
        or (part == ".claude-plugin" and 0 < index < len(parts) - 1 and parts[index - 1] == "agent")
        for index, part in enumerate(parts)
    )


def put(result, name, data):
    if not valid_name(name) or name in result or len(data) > MAX_FILE or sum(len(b) for b in result.values()) + len(data) > MAX_TOTAL:
        raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
    result[name] = data


def read_archive(path):
    result = {}
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_TOTAL:
        raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
    if path.suffix in (".whl", ".zip"):
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                if item.is_dir():
                    continue
                mode = stat.S_IFMT(item.external_attr >> 16)
                if mode not in (0, stat.S_IFREG) or item.file_size > MAX_FILE:
                    raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
                put(result, item.filename, archive.read(item))
    else:
        with gzip.open(path, "rb") as compressed:
            decoded = compressed.read(MAX_TOTAL + 1)
        if len(decoded) > MAX_TOTAL:
            raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
        with tarfile.open(fileobj=io.BytesIO(decoded), mode="r:") as archive:
            for item in archive:
                if item.isdir():
                    continue
                if not item.isfile() or item.size > MAX_FILE:
                    raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
                put(result, item.name, archive.extractfile(item).read(MAX_FILE + 1))
    if not result:
        raise ValueError("RELEASE_EMPTY_ARCHIVE")
    return result


def signed_tree(files, kind, version, key, signature_name="package-release.json"):
    if signature_name in files:
        raise ValueError("RELEASE_ALREADY_SIGNED")
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    return (canonical(seal("package", {"format": "worktrust-package/1", "kind": kind, "version": version, "files": hashes}, key)) + "\n").encode()


def sign_engine(files, prefix, version, key):
    modules = {name[len(prefix):]: data for name, data in files.items() if name.startswith(prefix) and "/" not in name[len(prefix):] and name.endswith(".mjs")}
    if "worktrust.mjs" not in modules or "worktrust-launch.mjs" not in modules or "package-integrity.mjs" not in modules:
        raise ValueError("RELEASE_ENGINE_INCOMPLETE")
    files[prefix + "engine-release.json"] = signed_tree(modules, "engine", version, key, "engine-release.json")


def archive_root(files):
    roots = {name.split("/")[0] for name in files}
    if len(roots) != 1 or any("/" not in name for name in files):
        raise ValueError("RELEASE_ARCHIVE_ROOT")
    return next(iter(roots)) + "/"


def rewrite(path, files):
    if path.suffix in (".whl", ".zip"):
        if path.suffix == ".whl":
            record = next((name for name in files if name.endswith(".dist-info/RECORD")), None)
            if not record:
                raise ValueError("RELEASE_WHEEL_RECORD_REQUIRED")
            rows = [[name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("="), str(len(data))] for name, data in sorted(files.items()) if name != record]
            rows.append([record, "", ""])
            stream = io.StringIO(newline=""); csv.writer(stream, lineterminator="\n").writerows(rows)
            files[record] = stream.getvalue().encode()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                info.external_attr = (stat.S_IFREG | (0o755 if name.endswith(("/runtime/node", "/runtime/node.exe")) else 0o644)) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    else:
        import gzip
        with path.open("wb") as target, gzip.GzipFile(fileobj=target, mode="wb", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w") as archive:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(name); info.size = len(data); info.mtime = 0
                info.mode = 0o755 if name.endswith("/worktrust-launch.mjs") else 0o644
                archive.addfile(info, io.BytesIO(data))


def sign_artifact(source, target, version, key):
    files = read_archive(source)
    if source.suffix == ".whl":
        prefix = "worktrust_cli/"
        if prefix + "__init__.py" not in files or not any(name.startswith(prefix + "runtime/") for name in files):
            raise ValueError("RELEASE_WHEEL_INCOMPLETE")
        sign_engine(files, prefix + "bundle/", version, key)
        package = {name[len(prefix):]: data for name, data in files.items() if name.startswith(prefix)}
        files[prefix + "package-release.json"] = signed_tree(package, "python", version, key)
    elif source.name.endswith(".tar.gz"):
        prefix = archive_root(files)
        package = {name[len(prefix):]: data for name, data in files.items()}
        files[prefix + "source-release.json"] = signed_tree(package, "source", version, key, "source-release.json")
    else:
        prefix = archive_root(files)
        if prefix + "package.json" not in files or json.loads(files[prefix + "package.json"])["version"] != version:
            raise ValueError("RELEASE_PACKAGE_VERSION")
        sign_engine(files, prefix, version, key)
        package = {name[len(prefix):]: data for name, data in files.items()}
        files[prefix + "package-release.json"] = signed_tree(package, "npm", version, key)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise ValueError("RELEASE_OUTPUT_EXISTS")
    rewrite(target, files)
    # Signing never changes an input artifact. Final artifact hashes are over the rewritten output.
    return {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "size": target.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--roots", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--key-file", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version) or not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        raise ValueError("RELEASE_IDENTITY_REQUIRED")
    if args.output.resolve().is_relative_to(args.input.resolve()) or args.output.exists():
        raise ValueError("RELEASE_SEPARATE_NEW_OUTPUT_REQUIRED")
    if args.key_file:
        if args.key_file.is_symlink() or (os.name != "nt" and args.key_file.stat().st_mode & 0o077):
            raise ValueError("RELEASE_PRIVATE_KEY_PERMISSIONS")
        material = args.key_file.read_bytes()
    else:
        material = os.environ.get("WORKTRUST_RELEASE_SIGNING_KEY", "").encode()
    key = ECC.import_key(material)
    roots = json.loads(args.roots.read_text())["keys"]
    if key.curve != "Ed25519" or not key.has_private() or key_identity(key) not in roots:
        raise ValueError("RELEASE_UNTRUSTED_SIGNING_KEY")
    identity = key_identity(key)
    expected = ECC.import_key(roots[identity])
    if expected.has_private() or key_identity(expected) != identity:
        raise ValueError("RELEASE_UNTRUSTED_SIGNING_KEY")
    sources = sorted(args.input.rglob("*"))
    sources = [p for p in sources if p.is_file()]
    if any(p.is_symlink() or not (p.name.endswith((".whl", ".tgz", ".tar.gz", ".zip"))) for p in sources):
        raise ValueError("RELEASE_UNEXPECTED_ARTIFACT")
    if len(sources) != 9 or sum(p.suffix == ".whl" for p in sources) != 6 or sum(p.name.endswith(".tar.gz") for p in sources) != 1 or sum(p.suffix == ".tgz" for p in sources) != 1 or sum(p.suffix == ".zip" for p in sources) != 1:
        raise ValueError("RELEASE_COMPLETE_ARTIFACT_SET_REQUIRED")
    tags = ["macosx_11_0_arm64", "macosx_11_0_x86_64", "manylinux_2_28_aarch64", "manylinux_2_28_x86_64", "win_amd64", "win_arm64"]
    expected_names = {f"worktrust-{args.version}-py3-none-{tag}.whl" for tag in tags} | {f"worktrust-{args.version}.tgz", f"worktrust-{args.version}.tar.gz", "worktrust-preserve-kit.zip"}
    if {p.name for p in sources} != expected_names:
        raise ValueError("RELEASE_COMPLETE_ARTIFACT_SET_REQUIRED")
    artifacts = {}
    for source in sources:
        relative = source.relative_to(args.input).as_posix()
        if not valid_name(relative):
            raise ValueError("RELEASE_ARTIFACT_PATH")
        print(f"Signing release artifact: {source.name}", flush=True)
        artifacts[relative] = sign_artifact(source, args.output / relative, args.version, key)
    signed = seal("artifact-catalogue", {"format": "worktrust-artifacts/1", "version": args.version, "sourceCommit": args.commit, "files": artifacts}, key)
    (args.output / "release-artifacts.json").write_text(canonical(signed) + "\n", encoding="utf-8")
    print(f"Signed {len(artifacts)} final artifacts; release {args.version}; key {identity}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        category = str(error) if re.fullmatch(r"RELEASE_[A-Z_]+", str(error)) else "RELEASE_SIGNING_FAILED"
        raise SystemExit(category) from None
