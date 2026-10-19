"""Disposable test bootstrap only. Never uses a production signing key or changes retained artifacts."""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
from Cryptodome.PublicKey import ECC


def fixture_wheel(source, target):
    spec = importlib.util.spec_from_file_location("fixture_signer", Path(__file__).resolve().parents[1] / "sign_release.py")
    signer = importlib.util.module_from_spec(spec); spec.loader.exec_module(signer)
    key = ECC.generate(curve="Ed25519")
    roots = {signer.key_identity(key): key.public_key().export_key(format="PEM")}
    files = signer.read_archive(source)
    prefix = "worktrust_cli/"
    for module in ("package-integrity.mjs", "worktrust-launch.mjs"):
        js = prefix + "bundle/" + module
        files[js] = re.sub(r"^(export )?const RELEASE_KEYS = .*; // GENERATED_RELEASE_KEYS$", lambda m: (m[1] or "") + "const RELEASE_KEYS = " + json.dumps(roots) + "; // GENERATED_RELEASE_KEYS", files[js].decode(), flags=re.M).encode()
    for module in ("_release.py", "__init__.py"):
        py = prefix + module
        files[py] = re.sub(r"^RELEASE_KEYS = .*  # GENERATED_RELEASE_KEYS$", lambda _: "RELEASE_KEYS = " + json.dumps(roots) + "  # GENERATED_RELEASE_KEYS", files[py].decode(), flags=re.M).encode()
    legacy = json.loads(files[prefix + "bundle/manifest.json"])
    for module in ("package-integrity.mjs", "worktrust-launch.mjs"):
        legacy["files"][module] = hashlib.sha256(files[prefix + "bundle/" + module]).hexdigest()
    files[prefix + "bundle/manifest.json"] = (json.dumps(legacy, indent=2) + "\n").encode()
    version = legacy["version"]
    signer.sign_engine(files, prefix + "bundle/", version, key)
    package = {name[len(prefix):]: data for name, data in files.items() if name.startswith(prefix)}
    files[prefix + "package-release.json"] = signer.signed_tree(package, "python", version, key)
    target.parent.mkdir(parents=True, exist_ok=True)
    signer.rewrite(target, files)
