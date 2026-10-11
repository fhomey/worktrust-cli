"""Platform wheels carrying Node; Python code itself has no interpreter-specific ABI."""
import hashlib
import json
from pathlib import Path
from setuptools import setup
from setuptools.dist import Distribution
from setuptools.command.build_py import build_py
from setuptools.command.bdist_wheel import bdist_wheel

ROOT = Path(__file__).resolve().parent


def runtime():
    directory = ROOT/"src/worktrust_cli/runtime"
    descriptor = directory/"runtime.json"
    if not descriptor.is_file() or descriptor.is_symlink():
        raise RuntimeError("Bundled runtime is absent. Run python build_runtime.py explicitly before building a wheel; runtime downloads never occur during installation or CLI execution.")
    data = json.loads(descriptor.read_text())
    lock = json.loads((ROOT/"runtime-lock.json").read_text())
    expected = lock["targets"].get(data["platform"])
    if expected is None or data["version"] != lock["version"] or data["archive_sha256"] != expected["sha256"]:
        raise RuntimeError("Staged runtime does not match the reviewed runtime lock")
    executable = "node.exe" if data["platform"].startswith("win-") else "node"
    if data["executable"] != executable or set(data["files"]) != {executable,"LICENSE"}:
        raise RuntimeError("Staged runtime has an invalid file list")
    if {path.name for path in directory.iterdir()} != {executable,"LICENSE","runtime.json"}:
        raise RuntimeError("Unexpected runtime file")
    for name,digest in data["files"].items():
        path = directory/name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Staged runtime integrity mismatch")
    return expected["wheel_tag"]


class BuildPython(build_py):
    def run(self):
        runtime()
        super().run()


class PlatformWheel(bdist_wheel):
    def finalize_options(self):
        super().finalize_options()
        self.root_is_pure = False

    def get_tag(self):
        return "py3", "none", runtime()


class BinaryDistribution(Distribution):
    def has_ext_modules(self):
        return True


setup(distclass=BinaryDistribution, cmdclass={"build_py":BuildPython,"bdist_wheel":PlatformWheel})
