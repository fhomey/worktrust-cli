"""Verify signed downloadable artifacts against separately pinned release roots. No execution or network."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
from Cryptodome.PublicKey import ECC
from Cryptodome.Signature import eddsa
from sign_release import canonical, key_identity, valid_name


def verify_artifacts(directory, roots_file, version=None, commit=None):
    directory = Path(directory)
    path = directory / "release-artifacts.json"
    if directory.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("RELEASE_MANIFEST_REQUIRED")
    envelope = json.loads(path.read_text(encoding="utf-8"))
    roots = json.loads(Path(roots_file).read_text(encoding="utf-8"))
    if roots.get("format") != "worktrust-release-keys/1" or set(envelope) != {"keyId", "payload", "signature"} or envelope["keyId"] not in roots["keys"] or not re.fullmatch(r"[A-Za-z0-9_-]{86}", envelope["signature"]):
        raise ValueError("RELEASE_UNTRUSTED_SIGNATURE")
    key = ECC.import_key(roots["keys"][envelope["keyId"]])
    if key.curve != "Ed25519" or key.has_private() or key_identity(key) != envelope["keyId"]:
        raise ValueError("RELEASE_UNTRUSTED_SIGNATURE")
    eddsa.new(key, "rfc8032").verify(("worktrust:artifact-catalogue:1\n" + canonical(envelope["payload"])).encode(), base64.urlsafe_b64decode(envelope["signature"] + "=="))
    payload = envelope["payload"]
    if set(payload) != {"format", "version", "sourceCommit", "files"} or payload["format"] != "worktrust-artifacts/1" or not re.fullmatch(r"\d+\.\d+\.\d+", payload["version"]) or not re.fullmatch(r"[a-f0-9]{40}", payload["sourceCommit"]) or len(payload["files"]) != 9:
        raise ValueError("RELEASE_INVALID_MANIFEST")
    if (version and payload["version"] != version) or (commit and payload["sourceCommit"] != commit):
        raise ValueError("RELEASE_IDENTITY_MISMATCH")
    actual = set()
    for item in directory.rglob("*"):
        if item.is_symlink():
            raise ValueError("RELEASE_ARCHIVE_BOUNDARY")
        if item.is_file() and item != path:
            actual.add(item.relative_to(directory).as_posix())
    if actual != set(payload["files"]):
        raise ValueError("RELEASE_FILE_LIST_CHANGED")
    for name, reference in payload["files"].items():
        if not valid_name(name) or set(reference) != {"sha256", "size"} or not re.fullmatch(r"[a-f0-9]{64}", reference["sha256"]) or not isinstance(reference["size"], int) or not 0 <= reference["size"] <= 256 * 1024 * 1024:
            raise ValueError("RELEASE_INVALID_MANIFEST")
        file = directory / name
        if file.stat().st_size != reference["size"] or hashlib.sha256(file.read_bytes()).hexdigest() != reference["sha256"]:
            raise ValueError("RELEASE_FILE_CHANGED")
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--roots", type=Path, required=True)
    parser.add_argument("--version")
    parser.add_argument("--commit")
    args = parser.parse_args()
    try:
        payload = verify_artifacts(args.directory, args.roots, args.version, args.commit)
        print(f"Verified all {len(payload['files'])} signed artifacts for WorkTrust {payload['version']}")
    except Exception as error:
        category = str(error) if re.fullmatch(r"RELEASE_[A-Z_]+", str(error)) else "RELEASE_VERIFICATION_FAILED"
        raise SystemExit(category) from None
