"""Synthetic archive safety tests; no runtime downloads and no real user files."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

PACKAGE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("runtime_builder", PACKAGE/"build_runtime.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def archive(kind, *, link=False, duplicate=False, extra=True, missing=False):
    data = io.BytesIO()
    executable = "node.exe" if kind == "zip" else "bin/node"
    names = [("node-test/"+executable,b"SYNTHETIC_RUNTIME"),("node-test/LICENSE",b"SYNTHETIC_LICENSE")]
    if missing:
        names.pop()
    if duplicate:
        names.append(names[0])
    if extra:
        names.append(("../../do-not-extract",b"PRIVATE"))
    if kind == "zip":
        with zipfile.ZipFile(data,"w") as output:
            for name,payload in names:
                item = zipfile.ZipInfo(name)
                item.external_attr = ((stat.S_IFLNK if link and name.endswith("node.exe") else stat.S_IFREG)|0o755)<<16
                output.writestr(item,payload)
    else:
        with tarfile.open(fileobj=data,mode="w:gz") as output:
            for name,payload in names:
                item = tarfile.TarInfo(name)
                item.size = len(payload)
                if link and name.endswith("/node"):
                    item.type = tarfile.SYMTYPE
                    item.linkname = "../../private"
                output.addfile(item,io.BytesIO(payload))
    return data.getvalue()


class RuntimeBuildTests(unittest.TestCase):
    def test_only_allowlisted_members_are_returned(self):
        for kind,exe in (("zip","node.exe"),("tar.gz","node")):
            result = builder.selected_members(archive(kind),"node-test."+kind,exe)
            self.assertEqual(set(result),{exe,"LICENSE"})

    def test_links_missing_duplicates_and_size_refused(self):
        for kind,exe in (("zip","node.exe"),("tar.gz","node")):
            for options in ({"link":True},{"missing":True},{"duplicate":True}):
                with self.assertRaises(ValueError):
                    builder.selected_members(archive(kind,**options),"node-test."+kind,exe)
            with patch.object(builder,"MAX_BINARY",2), self.assertRaises(ValueError):
                builder.selected_members(archive(kind),"node-test."+kind,exe)

    def test_pinned_cache_integrity_before_extraction(self):
        with tempfile.TemporaryDirectory(prefix="worktrust-runtime-build-") as directory:
            root = Path(directory)
            cache = root/"cache"
            cache.mkdir()
            payload = archive("zip")
            name = "node-test.zip"
            (cache/name).write_bytes(payload)
            lock = {"version":"22.23.3","base_url":"https://nodejs.org/dist/v22.23.3/",
                    "targets":{"win-x64":{"archive":name,"sha256":hashlib.sha256(payload).hexdigest(),"wheel_tag":"win_amd64"}}}
            (root/"runtime-lock.json").write_text(json.dumps(lock))
            with patch.object(builder,"ROOT",root), patch.object(builder.urllib.request,"urlopen",side_effect=AssertionError("network must not run")):
                builder.prepare("win-x64",cache)
                self.assertFalse((root/"do-not-extract").exists())
                manifest = json.loads((root/"src/worktrust_cli/runtime/runtime.json").read_text())
                self.assertEqual(manifest["files"]["node.exe"],hashlib.sha256(b"SYNTHETIC_RUNTIME").hexdigest())
                (cache/name).write_bytes(payload+b"CORRUPT")
                with self.assertRaisesRegex(ValueError,"checksum"):
                    builder.prepare("win-x64",cache)
                with self.assertRaisesRegex(ValueError,"unsupported"):
                    builder.prepare("unknown",cache)


if __name__ == "__main__":
    unittest.main()
