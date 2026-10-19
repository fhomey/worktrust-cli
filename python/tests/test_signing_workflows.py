"""Validate release workflow dependencies and prove an omitted native gate is detected."""
import copy
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2] / "worktrust-release/workflows"
if not ROOT.is_dir():
    ROOT = Path(__file__).resolve().parents[2] / ".github/workflows"


def load(name):
    return yaml.load((ROOT / name).read_text(), Loader=yaml.BaseLoader)


def validate_publish(data):
    jobs = data["jobs"]
    assert jobs["sign"]["environment"] == "cli-signing"
    assert jobs["publish"]["environment"] == "npm"
    assert "verify" in jobs["assets"]["needs"]
    assert set(jobs["publish"]["needs"]) == {"sign", "verify", "assets"}
    assert jobs["verify"]["needs"] == "sign"
    assert len(jobs["verify"]["strategy"]["matrix"]["include"]) == 6
    signing_steps = [step for job in jobs.values() for step in job["steps"] if "WORKTRUST_RELEASE_SIGNING_KEY" in step.get("env", {})]
    assert len(signing_steps) == 1 and signing_steps[0] in jobs["sign"]["steps"]
    assert jobs["publish"]["permissions"]["id-token"] == "write"
    assert any("npm publish 'signed/npm/" in step.get("run", "") for step in jobs["publish"]["steps"])


class WorkflowTests(unittest.TestCase):
    def test_native_gates_and_signing_are_mandatory(self):
        data = load("publish.yml")
        validate_publish(data)
        for job in ("assets", "publish"):
            broken = copy.deepcopy(data)
            broken["jobs"][job]["needs"].remove("verify")
            with self.assertRaises(AssertionError):
                validate_publish(broken)

    def test_action_pins_and_source_build_separation(self):
        for name in ("publish.yml", "release-pypi.yml", "verify-python.yml"):
            data = load(name)
            for job in data["jobs"].values():
                for step in job["steps"]:
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"^[^@]+@[a-f0-9]{40}$")
        source = load("verify-python.yml")
        self.assertEqual(len(source["jobs"]["verify"]["strategy"]["matrix"]["include"]), 6)
        self.assertNotIn("WORKTRUST_RELEASE_SIGNING_KEY", (ROOT / "verify-python.yml").read_text())
        self.assertIn("r.head_sha===process.env.GITHUB_SHA", (ROOT / "publish.yml").read_text())
        self.assertIn("r.head_branch==='main'", (ROOT / "publish.yml").read_text())
        self.assertIn("r.event==='push'", (ROOT / "publish.yml").read_text())

    def test_pypi_uses_same_successful_signed_release_without_rebuilding(self):
        data = load("release-pypi.yml")
        self.assertEqual(data["on"]["workflow_run"]["workflows"], ["publish"])
        job = data["jobs"]["publish"]
        self.assertIn("conclusion == 'success'", job["if"])
        self.assertIn("event == 'release'", job["if"])
        self.assertIn("head_repository.full_name == github.repository", job["if"])
        self.assertEqual(job["environment"]["name"], "pypi")
        text = (ROOT / "release-pypi.yml").read_text()
        self.assertIn("run-id: ${{ github.event.workflow_run.id }}", text)
        self.assertIn("ref: ${{ github.event.workflow_run.head_sha }}", text)
        self.assertIn("verify_release.py", text)
        self.assertNotIn("python -m build", text)


if __name__ == "__main__":
    unittest.main()
