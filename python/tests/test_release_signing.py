"""Cross-language signature and archive tests; temporary keys, packages and homes only."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from Cryptodome.PublicKey import ECC

PACKAGE = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("WORKTRUST_TEST_CLI_SOURCE", PACKAGE.parent / "worktrust-cli")).resolve()
spec = importlib.util.spec_from_file_location("sign_release", PACKAGE / "sign_release.py")
signer = importlib.util.module_from_spec(spec); spec.loader.exec_module(signer)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wt-release-signing-")
        self.root = Path(self.temp.name)
        self.key = ECC.generate(curve="Ed25519")
        pem = self.key.public_key().export_key(format="PEM")
        self.roots = {signer.key_identity(self.key): pem}
        self.version = json.loads((CLI / "package.json").read_text())["version"]

    def tearDown(self):
        self.temp.cleanup()

    def modules(self):
        names = [n for n in json.loads((CLI / "package.json").read_text())["files"] if n.endswith(".mjs")]
        result = {name: (CLI / name).read_bytes() for name in names}
        for module in ("package-integrity.mjs", "worktrust-launch.mjs"):
            source = result[module].decode()
            source = re.sub(r"^(export )?const RELEASE_KEYS = .*; // GENERATED_RELEASE_KEYS$", lambda m: (m[1] or "") + "const RELEASE_KEYS = " + json.dumps(self.roots) + "; // GENERATED_RELEASE_KEYS", source, flags=re.M)
            result[module] = source.encode()
        return result

    def node_package(self):
        files = self.modules()
        files["package.json"] = json.dumps({"name": "worktrust", "version": self.version, "type": "module"}).encode()
        signer.sign_engine(files, "", self.version, self.key)
        files["package-release.json"] = signer.signed_tree(files, "npm", self.version, self.key)
        root = self.root / "npm"; root.mkdir()
        for name, data in files.items():
            (root / name).write_bytes(data)
        return root

    def test_node_executes_only_the_signed_files_and_installs_a_verified_copy(self):
        root = self.node_package()
        node = os.environ.get("WORKTRUST_TEST_NODE", shutil.which("node"))
        env = {"HOME": str(self.root / "home"), "USERPROFILE": str(self.root / "home"), "PATH": "", "WORKTRUST_RELAYED": "1"}
        if os.name == "nt":
            env.update({name: os.environ[name] for name in ("SYSTEMROOT", "WINDIR", "COMSPEC") if name in os.environ})
        run = lambda: subprocess.run([node, str(root / "worktrust-launch.mjs"), "--version"], env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(run().stdout.strip(), self.version)
        install = f"import {{installSignedPackage}} from {json.dumps((root/'package-integrity.mjs').as_uri())}; console.log(installSignedPackage({json.dumps(str(root))},{json.dumps(str(self.root/'stable'))}));"
        copied = subprocess.run([node, "--input-type=module", "-e", install], env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(copied.returncode, 0, copied.stderr)
        installed = Path(copied.stdout.strip())
        self.assertTrue(installed.exists())
        original = (root / "worktrust.mjs").read_bytes()
        changed = bytearray(original); changed[-1] ^= 1; (root / "worktrust.mjs").write_bytes(changed)
        result = run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("PACKAGE_FILE_CHANGED", result.stderr)
        self.assertEqual(subprocess.run([node, str(installed), "--version"], env=env, capture_output=True, text=True).stdout.strip(), self.version)
        signature = root / "package-release.json"
        envelope = json.loads(signature.read_text()); envelope["payload"]["files"]["worktrust.mjs"] = hashlib.sha256(changed).hexdigest()
        signature.write_text(json.dumps(envelope))
        self.assertIn("PACKAGE_UNTRUSTED_SIGNATURE", run().stderr)
        signature.unlink()
        self.assertNotEqual(run().returncode, 0)

    def test_install_refuses_symlinks_and_wrong_existing_signed_identity(self):
        root = self.node_package()
        node = os.environ.get("WORKTRUST_TEST_NODE", shutil.which("node"))
        outside = self.root / "outside"; outside.mkdir(); (outside / "keep").write_text("keep")
        home = self.root / "linked-home"
        prefix = f"import {{installSignedPackage}} from {json.dumps((root/'package-integrity.mjs').as_uri())};"
        setup = f"import {{symlinkSync}} from 'node:fs'; symlinkSync({json.dumps(str(outside))},{json.dumps(str(home))},process.platform==='win32'?'junction':'dir');"
        call = f"try {{console.log(installSignedPackage({json.dumps(str(root))},{json.dumps(str(home))}));}} catch(e){{console.error(e.message);process.exitCode=1;}}"
        result = subprocess.run([node, "--input-type=module", "-e", prefix + setup + call], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual({p.name for p in outside.iterdir()}, {"keep"}, "refusal must not create directories through a symlink")
        home.unlink() if os.name != "nt" else home.rmdir()
        result = subprocess.run([node, "--input-type=module", "-e", prefix + call], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = Path(result.stdout.strip()).parent
        (installed / "NOTICE.txt").write_text("A different valid signed tree")
        files = {p.relative_to(installed).as_posix():p.read_bytes() for p in installed.rglob("*") if p.is_file() and p.name != "package-release.json"}
        (installed / "package-release.json").write_bytes(signer.signed_tree(files, "npm", self.version, self.key))
        result = subprocess.run([node, "--input-type=module", "-e", prefix + call], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, "an existing signed tree must still match the selected immutable identity")
        self.assertIn("PACKAGE_INSTALLATION_IDENTITY_MISMATCH", result.stderr)

    def python_module(self):
        root = self.root / "worktrust_cli"; root.mkdir()
        for name in ("__init__.py", "__main__.py", "_release.py"):
            source = (PACKAGE / "src/worktrust_cli" / name).read_text()
            if name in ("_release.py", "__init__.py"):
                source = re.sub(r"^RELEASE_KEYS = .*  # GENERATED_RELEASE_KEYS$", lambda _: "RELEASE_KEYS = " + json.dumps(self.roots) + "  # GENERATED_RELEASE_KEYS", source, flags=re.M)
            (root / name).write_text(source)
        bundle = root / "bundle"; bundle.mkdir()
        modules = self.modules()
        for name, data in modules.items():
            (bundle / name).write_bytes(data)
        (bundle / "manifest.json").write_text(json.dumps({"version": self.version, "files": {n: hashlib.sha256(b).hexdigest() for n,b in modules.items()}}))
        engine = {}; signer.sign_engine({**modules}, "", self.version, self.key)
        engine["engine-release.json"] = signer.signed_tree(modules, "engine", self.version, self.key, "engine-release.json")
        (bundle / "engine-release.json").write_bytes(engine["engine-release.json"])
        runtime = root / "runtime"; runtime.mkdir()
        (runtime / "node").write_bytes(b"SYNTHETIC_NOT_EXECUTABLE")
        (runtime / "runtime.json").write_text("{}")
        self.sign_python(root)
        return root

    def sign_python(self, root):
        files = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file() and p.name != "package-release.json" and "__pycache__" not in p.parts}
        (root / "package-release.json").write_bytes(signer.signed_tree(files, "python", self.version, self.key))

    def test_python_signature_precedes_runtime_and_detects_changed_local_hash_descriptors(self):
        root = self.python_module()
        spec = importlib.util.spec_from_file_location("fixture_release", root / "_release.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(module.verify_distribution(root)["version"], self.version)
        (root / "runtime/node").write_bytes(b"FORGED_RUNTIME")
        (root / "runtime/runtime.json").write_text(json.dumps({"files": {"node": hashlib.sha256(b"FORGED_RUNTIME").hexdigest()}}))
        with self.assertRaisesRegex(ValueError, "PACKAGE_FILE_CHANGED"):
            module.verify_distribution(root)
        result = subprocess.run([sys.executable, "-m", "worktrust_cli", "--version"], cwd=self.root,
            env={"PATH": "", "PYTHONPATH": str(self.root), "HOME": str(self.root / "home")}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("PACKAGE_FILE_CHANGED", result.stderr)

    def test_no_local_verifier_module_executes_before_its_hash_is_checked(self):
        root = self.node_package()
        node = os.environ.get("WORKTRUST_TEST_NODE", shutil.which("node"))
        marker = self.root / "local-module-ran"
        helper = root / "package-integrity.mjs"
        helper.write_bytes(helper.read_bytes() + ("\n(await import('node:fs')).writeFileSync(" + json.dumps(str(marker)) + ",'bad');\n").encode())
        run = lambda: subprocess.run([node, str(root / "worktrust-launch.mjs"), "--version"], capture_output=True, text=True, timeout=10)
        self.assertEqual(run().returncode, 1)
        self.assertFalse(marker.exists(), "the official bootstrap must not import changed local verifier code")
        official = (root / "worktrust-launch.mjs").read_bytes()
        # Counterfactual: the earlier shape imported local verification code before checking it.
        (root / "worktrust-launch.mjs").write_text("import './package-integrity.mjs';\n")
        run()
        self.assertTrue(marker.exists(), "counterfactual actually executes the untrusted import")
        (root / "worktrust-launch.mjs").write_bytes(official)
        marker.unlink()
        self.assertEqual(run().returncode, 1)
        self.assertFalse(marker.exists())

    def test_archive_boundaries_and_record_regeneration(self):
        for name in ("../escape", "/absolute", "a/../../escape", "agent/.claude-plugin/../escape", "agent/./escape", "agent/.unreviewed/secret", "agent/.claude-plugin"):
            path = self.root / "bad.whl"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(name, b"synthetic")
            with self.assertRaisesRegex(ValueError, "BOUNDARY"):
                signer.read_archive(path)
        path = self.root / "record.whl"
        files = {"worktrust_cli/a.py": b"x", "worktrust-1.dist-info/RECORD": b""}
        signer.rewrite(path, files)
        actual = signer.read_archive(path)
        self.assertIn(b"worktrust_cli/a.py,sha256=", actual["worktrust-1.dist-info/RECORD"])

    def test_actual_preservation_kit_is_authenticated_with_plugin_metadata(self):
        candidates = [CLI / "release/worktrust-preserve-kit.zip", CLI.parents[1] / "apps/worktrust/web/public/downloads/worktrust-preserve-kit.zip"]
        archive = next((p for p in candidates if p.is_file()), None)
        self.assertIsNotNone(archive, "the actual preservation artifact is mandatory")
        files = signer.read_archive(archive)
        prefix = signer.archive_root(files)
        # Re-sign a disposable test copy; deployed production archives may already carry
        # these envelopes. The website's separate source/signature verifier checks originals.
        for signature in ("engine-release.json", "package-release.json"):
            files.pop(prefix + signature, None)
        plugin = "agent/.claude-plugin/plugin.json"
        self.assertIn(prefix + plugin, files)
        for name, data in self.modules().items():
            self.assertIn(prefix + name, files)
            files[prefix + name] = data
        signer.sign_engine(files, prefix, self.version, self.key)
        package = {name[len(prefix):]: data for name, data in files.items()}
        files[prefix + "package-release.json"] = signer.signed_tree(package, "npm", self.version, self.key)
        root = self.root / "preserve"; root.mkdir()
        for name, data in files.items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        entry = root / prefix / "worktrust-launch.mjs"
        node = os.environ.get("WORKTRUST_TEST_NODE", shutil.which("node"))
        env = {"HOME":str(self.root / "home"), "USERPROFILE":str(self.root / "home"), "PATH":"", "WORKTRUST_RELAYED":"1"}
        if os.name == "nt":
            env.update({k:os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "COMSPEC") if k in os.environ})
        run = lambda: subprocess.run([node,str(entry),"--version"],env=env,capture_output=True,text=True,timeout=15)
        result = run(); self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),self.version)
        (root / prefix / plugin).write_bytes(files[prefix + plugin] + b" ")
        result = run(); self.assertEqual(result.returncode,1)
        self.assertIn("PACKAGE_FILE_CHANGED",result.stderr)

    def test_complete_release_signs_nine_artifacts_and_detects_final_byte_changes(self):
        root = self.python_module()
        source = self.root / "inputs"; source.mkdir()
        package = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file() and p.name != "package-release.json"}
        package.pop("bundle/engine-release.json")
        for tag in ("macosx_11_0_arm64", "macosx_11_0_x86_64", "manylinux_2_28_aarch64", "manylinux_2_28_x86_64", "win_amd64", "win_arm64"):
            files = {"worktrust_cli/" + n: b for n,b in package.items()}
            files[f"worktrust-{self.version}.dist-info/RECORD"] = b""
            signer.rewrite(source / f"worktrust-{self.version}-py3-none-{tag}.whl", files)
        npm = self.modules(); npm["package.json"] = json.dumps({"name": "worktrust", "version": self.version}).encode()
        signer.rewrite(source / f"worktrust-{self.version}.tgz", {"package/" + n: b for n,b in npm.items()})
        signer.rewrite(source / "worktrust-preserve-kit.zip", {"worktrust-preserve-kit/" + n: b for n,b in npm.items()})
        signer.rewrite(source / f"worktrust-{self.version}.tar.gz", {f"worktrust-{self.version}/README.md": b"synthetic source"})
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}
        pem = self.root / "fixture.pem"
        pem.write_bytes(self.key.export_key(format="PEM", use_pkcs8=True).encode()); pem.chmod(0o600)
        roots = self.root / "roots.json"; roots.write_text(json.dumps({"format": "worktrust-release-keys/1", "keys": self.roots}))
        output = self.root / "signed"
        result = subprocess.run([sys.executable, str(PACKAGE / "sign_release.py"), "--input", str(source), "--output", str(output), "--roots", str(roots), "--version", self.version, "--commit", "a" * 40, "--key-file", str(pem)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()})
        verifier = [sys.executable, str(PACKAGE / "verify_release.py"), "--directory", str(output), "--roots", str(roots), "--version", self.version, "--commit", "a" * 40]
        verified = subprocess.run(verifier, capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        wheel = next(output.glob("*.whl")); data = wheel.read_bytes(); wheel.write_bytes(data + b"changed")
        refused = subprocess.run(verifier, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("RELEASE_FILE_CHANGED", refused.stderr)


if __name__ == "__main__":
    unittest.main()
