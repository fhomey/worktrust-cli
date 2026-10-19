"""Authenticate installed files before starting the bundled Node runtime. No network access."""
import base64
import hashlib
import json
from pathlib import Path
import re

RELEASE_KEYS = {"608168ccdef72562fc91f9c0f9f2c2d6876bece7f7362cb545b818f7947da6b5":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxe/h8yLe+e4iKYSx/2lzS7MgHIgzM+mi1XjofW1VKo4=\n-----END PUBLIC KEY-----\n"}  # GENERATED_RELEASE_KEYS


def _canonical(value):
    # Signed payload paths, kinds, versions and SHA-256 values are restricted to ASCII.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def verify_distribution(root):
    from Cryptodome.PublicKey import ECC
    from Cryptodome.Signature import eddsa

    root = Path(root)
    path = root / "package-release.json"
    if root.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("PACKAGE_MANIFEST_REQUIRED")
    signed = json.loads(path.read_text(encoding="utf-8"))
    if set(signed) != {"keyId", "payload", "signature"} or signed["keyId"] not in RELEASE_KEYS or not re.fullmatch(r"[A-Za-z0-9_-]{86}", signed["signature"]):
        raise ValueError("PACKAGE_UNTRUSTED_SIGNATURE")
    key = ECC.import_key(RELEASE_KEYS[signed["keyId"]])
    identity = hashlib.sha256(key.public_key().export_key(format="DER")).hexdigest()
    if key.curve != "Ed25519" or key.has_private() or identity != signed["keyId"]:
        raise ValueError("PACKAGE_UNTRUSTED_SIGNATURE")
    payload = signed["payload"]
    try:
        eddsa.new(key, "rfc8032").verify(("worktrust:package:1\n" + _canonical(payload)).encode("utf-8"), base64.urlsafe_b64decode(signed["signature"] + "=="))
    except ValueError as error:
        raise ValueError("PACKAGE_UNTRUSTED_SIGNATURE") from error
    if set(payload) != {"format", "kind", "version", "files"} or payload["format"] != "worktrust-package/1" or payload["kind"] != "python" or not re.fullmatch(r"\d+\.\d+\.\d+", payload["version"]):
        raise ValueError("PACKAGE_INVALID_MANIFEST")
    files = payload["files"]
    if not isinstance(files, dict) or not files or len(files) > 2000:
        raise ValueError("PACKAGE_INVALID_MANIFEST")
    found = set()
    for item in root.rglob("*"):
        if item.is_symlink():
            raise ValueError("PACKAGE_NON_REGULAR_FILE")
        relative = item.relative_to(root)
        if "__pycache__" in relative.parts:
            continue  # Interpreter cache is not release evidence; Python/bootstrap trust remains required.
        if item.is_file() and relative.as_posix() != "package-release.json":
            found.add(relative.as_posix())
    if found != set(files):
        raise ValueError("PACKAGE_FILE_LIST_CHANGED")
    for name, digest in files.items():
        if not all(re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]*", part) and part != ".." for part in name.split("/")) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("PACKAGE_INVALID_MANIFEST")
        item = root / name
        if not item.is_file() or item.stat().st_size > 128 * 1024 * 1024 or hashlib.sha256(item.read_bytes()).hexdigest() != digest:
            raise ValueError("PACKAGE_FILE_CHANGED")
    return payload
