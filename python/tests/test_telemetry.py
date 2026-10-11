"""Synthetic SDK checks; no owner data, network or installed application required."""
import concurrent.futures
import importlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

if "--installed" not in sys.argv:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
else:
    sys.argv.remove("--installed")
sdk = importlib.import_module("worktrust_cli.telemetry")


def identifier():
    return str(uuid.uuid4())


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="worktrust-sdk-synthetic-")
        self.directory = Path(self.temporary.name).resolve()
        self.path = self.directory / "events.jsonl"
        self.agent, self.version = identifier(), identifier()

    def tearDown(self):
        self.temporary.cleanup()

    def run_for(self, recorder, **extra):
        return recorder.run(agent_id=self.agent, agent_version=self.version, **extra)

    def read(self):
        return [json.loads(line) for line in self.path.read_text().splitlines()]

    def test_complete_observations_and_unknown_counters(self):
        with sdk.Recorder(self.path, consent=True) as recorder:
            root = self.run_for(recorder, role="orchestrator", task_kind="build")
            worker = self.run_for(recorder, parent=root)
            worker.budget(1000)
            worker.usage(input_uncached_tokens=30, cache_read_tokens=20, cache_write_tokens=0, output_tokens=10)
            worker.intervention("verification_request")
            worker.verification("failed")
            worker.security("injection_ignored", source="boundary_report")
            worker.usage(output_tokens=2)
            worker.verification("passed")
            worker.finish("succeeded")
            root.finish("succeeded")
        events = self.read()
        self.assertEqual(set(events[0]), {"schema", "session_id", "started_at"})
        self.assertRegex(events[0]["started_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(events[2]["parent_run_id"], events[1]["run_id"])
        self.assertEqual(events[8]["output_tokens"], 2)
        self.assertNotIn("input_uncached_tokens", events[8])
        self.assertEqual([event["sequence"] for event in events[1:]], list(range(1, len(events))))
        self.assertEqual(len({event["event_id"] for event in events[1:]}), len(events) - 1)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_consent_and_exclusive_creation(self):
        for consent in (False, None, 1, "yes"):
            with self.assertRaises(ValueError):
                sdk.Recorder(self.path, consent=consent)
        self.assertFalse(self.path.exists())
        self.path.write_text("keep synthetic bytes")
        with self.assertRaises(FileExistsError):
            sdk.Recorder(self.path, consent=True)
        self.assertEqual(self.path.read_text(), "keep synthetic bytes")

    @unittest.skipIf(os.name == "nt", "symlink permissions vary on Windows")
    def test_symlink_refusal_and_no_parent_chmod(self):
        self.directory.chmod(0o750)
        target = self.directory / "target"
        target.write_text("keep")
        self.path.symlink_to(target)
        with self.assertRaises(ValueError):
            sdk.Recorder(self.path, consent=True)
        self.path.unlink()
        self.path.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            sdk.Recorder(self.path / "child.jsonl", consent=True)
        self.assertEqual(target.read_text(), "keep")
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o750)

    def test_no_inferred_completion_or_exception_content(self):
        with self.assertRaises(RuntimeError):
            with sdk.Recorder(self.path, consent=True) as recorder:
                with self.run_for(recorder):
                    raise RuntimeError("PRIVATE SENTINEL must never be recorded")
        events = self.read()
        self.assertEqual(len(events), 2)
        self.assertNotIn("PRIVATE SENTINEL", self.path.read_text())
        with self.assertRaises(ValueError):
            self.run_for(recorder)

    def test_exact_types_no_free_text_and_budget_order(self):
        with sdk.Recorder(self.path, consent=True) as recorder:
            for extra in ({"role": "private name"}, {"task_kind": "private task"}):
                with self.assertRaises(ValueError):
                    self.run_for(recorder, **extra)
            with self.assertRaises(ValueError):
                recorder.run(agent_id="private@example.org", agent_version=self.version)
            with self.assertRaises(ValueError):
                recorder.run(agent_id=str(uuid.uuid1()), agent_version=self.version)
            run = self.run_for(recorder)
            for value in (True, -1, 1.5, float("nan"), "secret", 1_000_000_001):
                with self.assertRaises(ValueError):
                    run.usage(output_tokens=value)
            with self.assertRaises(ValueError):
                run.usage()
            with self.assertRaises(TypeError):
                run.usage(prompt="private content")
            for call in (lambda: run.security("private content", source="client_report"),
                         lambda: run.security("injection_ignored", source="regex"),
                         lambda: run.verification("independently_verified"),
                         lambda: run.intervention("private text"), lambda: run.budget(0)):
                with self.assertRaises(ValueError):
                    call()
            run.budget(10)
            with self.assertRaises(ValueError):
                run.budget(20)
            run.usage(output_tokens=0)
            run.finish("failed")
            with self.assertRaises(ValueError):
                run.finish("succeeded")
            other = self.run_for(recorder)
            other.usage(output_tokens=1)
            with self.assertRaises(ValueError):
                other.budget(5)
        self.assertNotIn("private", self.path.read_text())

    def test_parallel_recording_parent_and_process_boundaries(self):
        second_path = self.directory / "second.jsonl"
        with sdk.Recorder(self.path, consent=True) as first, sdk.Recorder(second_path, consent=True) as second:
            parent = self.run_for(first)
            open_child = self.run_for(first, parent=parent)
            with self.assertRaises(ValueError):
                parent.finish("succeeded")
            open_child.finish("cancelled")
            with self.assertRaises(ValueError):
                self.run_for(second, parent=parent)
            def observe(_):
                child = self.run_for(first, parent=parent)
                child.usage(output_tokens=1)
                child.finish("succeeded")
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(observe, range(20)))
            with patch.object(sdk.os, "getpid", return_value=-1):
                with self.assertRaises(ValueError):
                    parent.verification("passed")
            parent.finish("succeeded")
            with self.assertRaises(ValueError):
                self.run_for(first, parent=parent)
        events = self.read()[1:]
        self.assertEqual([item["sequence"] for item in events], list(range(1, 65)))
        self.assertEqual([item["elapsed_ms"] for item in events], sorted(item["elapsed_ms"] for item in events))

    def test_bounds_fail_before_additional_bytes(self):
        with sdk.Recorder(self.path, consent=True) as recorder:
            run = self.run_for(recorder)
            for key, value, call in (
                ("MAX_RUNS", 1, lambda: self.run_for(recorder)),
                ("MAX_EVENTS", 1, lambda: run.verification("passed")),
                ("MAX_BYTES", self.path.stat().st_size, lambda: run.verification("passed")),
            ):
                before = self.path.read_bytes()
                with patch.object(sdk, key, value), self.assertRaises(ValueError):
                    call()
                self.assertEqual(self.path.read_bytes(), before)
            with patch.object(sdk.time, "monotonic_ns", return_value=recorder._origin - 1_000_000):
                with self.assertRaises(ValueError):
                    run.verification("passed")
            with patch.object(sdk.time, "monotonic_ns", return_value=recorder._origin + (sdk.MAX_ELAPSED_MS + 1) * 1_000_000):
                with self.assertRaises(ValueError):
                    run.verification("passed")

    def test_partial_write_closes_recorder(self):
        with sdk.Recorder(self.path, consent=True) as recorder:
            run = self.run_for(recorder)
            with patch.object(sdk.os, "write", side_effect=OSError("secret filesystem detail")):
                with self.assertRaisesRegex(OSError, "^recording write failed$"):
                    run.verification("passed")
            with self.assertRaises(ValueError):
                run.verification("passed")
        with patch.object(sdk.os, "write", side_effect=OSError("private storage failure")):
            with self.assertRaisesRegex(OSError, "^recording write failed$"):
                sdk.Recorder(self.directory / "header-failure.jsonl", consent=True)

    def test_shared_javascript_contract_and_duplicate_replay(self):
        package = Path(__file__).resolve().parents[1]
        core = Path(os.environ.get("WORKTRUST_TEST_CLI_SOURCE", str(package.parent.parent / "scripts"))) / "orchestration-evidence.mjs"
        node = os.environ.get("WORKTRUST_TEST_NODE", "node")
        with sdk.Recorder(self.path, consent=True) as recorder:
            parent = self.run_for(recorder, role="orchestrator", task_kind="build")
            child = self.run_for(recorder, parent=parent)
            child.budget(50)
            child.usage(input_uncached_tokens=10, cache_read_tokens=20, cache_write_tokens=5, output_tokens=25)
            child.security("injection_ignored", source="boundary_report")
            child.intervention("verification_request")
            child.verification("passed")
            child.finish("succeeded")
            # Parent intentionally incomplete and usage absent; never substitute zero.
        runner = self.directory / "compare.mjs"
        runner.write_text("""import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const core = await import(pathToFileURL(process.argv[2]));
const record = core.parseOrchestrationJsonl(readFileSync(process.argv[3], 'utf8'));
const summary = core.summarizeOrchestration(record);
const replay = core.summarizeOrchestration({...record, events:[...record.events, record.events[2]]});
if (JSON.stringify(replay) !== JSON.stringify(summary)) throw Error('duplicate replay diverged');
let refused = false;
try { core.validateOrchestrationRecording({...record,events:[...record.events,{...record.events[2],token_limit:1}]}); }
catch { refused = true; }
if (!refused) throw Error('conflicting duplicate accepted');
console.log(JSON.stringify({summary,roles:core.AGENT_ROLES,tasks:core.AGENT_TASK_KINDS,security:core.SECURITY_EVENT_CODES,usage:core.USAGE_KEYS}));
""")
        result = subprocess.run([node, str(runner), str(core), str(self.path)], cwd=self.directory,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["roles"], list(sdk.ROLES))
        self.assertEqual(report["tasks"], list(sdk.TASK_KINDS))
        self.assertEqual(report["security"], list(sdk.SECURITY_CODES))
        self.assertEqual(report["usage"], list(sdk.TOKEN_FIELDS))
        self.assertIsNone(report["summary"]["tokens_total"])
        self.assertIsNone(report["summary"]["elapsed_ms"])
        measured = report["summary"]["runs"][1]
        self.assertEqual(measured["tokens_total"], 60)
        self.assertTrue(measured["budget_exceeded"])
        self.assertEqual(measured["security"], {"injection_ignored": 1})
        self.assertEqual(report["summary"]["provenance"], "application_reported")


if __name__ == "__main__":
    unittest.main()
