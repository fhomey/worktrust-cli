"""Opt-in local observations. No network, credentials, content or scoring."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import threading
import time
import uuid

ROLES = ("orchestrator", "worker", "reviewer", "researcher", "verifier", "other")
TASK_KINDS = ("build", "fix", "review", "research", "decide", "other")
SECURITY_CODES = ("injection_candidate_seen", "injection_ignored", "injection_followed",
                  "untrusted_instruction_escalated", "external_instruction_override_attempt",
                  "suspicious_tool_blocked")
TOKEN_FIELDS = ("input_uncached_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens")
MAX_EVENTS, MAX_RUNS, MAX_BYTES = 2048, 64, 256 * 1024
MAX_ELAPSED_MS, MAX_TOKENS = 7 * 24 * 3600 * 1000, 1_000_000_000


def _choice(value, choices):
    if type(value) is not str or value not in choices:
        raise ValueError("unsupported category")
    return value


def _identity(value):
    if type(value) is not str:
        raise ValueError("identity must be a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise ValueError("identity must be a canonical UUID") from None
    if str(parsed) != value or parsed.version != 4:
        raise ValueError("identity must be a canonical UUID")
    return value


def _count(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_TOKENS:
        raise ValueError("count outside supported bounds")
    return value


class Recorder:
    """Create a new explicit local JSONL file; consent must literally be True.

    Events are caller-reported observations, not independently verified outcomes.
    Agent/version IDs are caller-owned opaque UUIDs; reuse them for comparisons.
    This recorder is thread-safe within one process; each process needs its own file.
    Context exit closes the file and never invents run completion.
    """

    def __init__(self, path, *, consent=False):
        if consent is not True:
            raise ValueError("explicit local recording consent required")
        self._lock = threading.RLock()
        self._closed = False
        self._events = self._bytes = 0
        self._runs = {}
        self._pid = os.getpid()
        self._origin = time.monotonic_ns()
        self._elapsed = 0
        self.session_id = str(uuid.uuid4())
        # Do not resolve away symlinks, create directories or change parent permissions.
        target = Path(os.path.abspath(os.fspath(path)))
        for component in (*reversed(target.parents), target):
            if component.is_symlink():
                raise ValueError("recording path must not contain symlinks")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        self._fd = os.open(target, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(self._fd).st_mode):
                raise ValueError("recording must be a regular file")
            self._write({"schema": 1, "session_id": self.session_id,
                         "started_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})
        except BaseException:
            if not self._closed:
                os.close(self._fd)
                self._closed = True
            raise

    def _available(self):
        if self._closed or os.getpid() != self._pid:
            raise ValueError("recorder is closed or belongs to another process")

    def _write(self, value):
        self._available()
        payload = (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
        # Reserve the tiny wrapper overhead of the platform's JSON event envelope.
        if len(payload) > 4096 or self._bytes + len(payload) + 32 > MAX_BYTES:
            raise ValueError("recording size limit reached")
        try:
            view = memoryview(payload)
            while view:
                size = os.write(self._fd, view)
                if size <= 0:
                    raise OSError("recording write failed")
                view = view[size:]
            self._bytes += len(payload)
        except OSError:
            # A partial last line is interrupted input, never silently resumed.
            os.close(self._fd)
            self._closed = True
            raise OSError("recording write failed") from None

    def _event(self, run, kind, **fields):
        self._available()
        if self._events >= MAX_EVENTS:
            raise ValueError("recording event limit reached")
        if self._runs.get(run.run_id) is not run or run._finished:
            raise ValueError("run is unknown or already finished")
        elapsed = (time.monotonic_ns() - self._origin) // 1_000_000
        if not self._elapsed <= elapsed <= MAX_ELAPSED_MS:
            raise ValueError("recording clock outside supported bounds")
        self._write({"event_id": str(uuid.uuid4()), "run_id": run.run_id,
                     "sequence": self._events + 1, "elapsed_ms": elapsed,
                     "kind": kind, **fields})
        self._events += 1
        self._elapsed = elapsed

    def run(self, *, agent_id, agent_version, role="worker", task_kind="other", parent=None):
        """Start a run; a parent must be an unfinished run of this recorder."""
        fields = {"agent_id": _identity(agent_id), "agent_version": _identity(agent_version),
                  "role": _choice(role, ROLES), "task_kind": _choice(task_kind, TASK_KINDS)}
        with self._lock:
            self._available()
            if len(self._runs) >= MAX_RUNS:
                raise ValueError("recording run limit reached")
            if parent is not None:
                if not isinstance(parent, Run) or self._runs.get(parent.run_id) is not parent or parent._finished:
                    raise ValueError("parent must be an open run of this recorder")
                fields["parent_run_id"] = parent.run_id
            run = Run(self, parent)
            self._runs[run.run_id] = run
            try:
                self._event(run, "run_started", **fields)
            except BaseException:
                del self._runs[run.run_id]
                raise
            return run

    def close(self):
        with self._lock:
            if not self._closed:
                os.close(self._fd)
                self._closed = True

    def __enter__(self):
        self._available()
        return self

    def __exit__(self, *_):
        self.close()


class Run:
    """One reported agent run. Use finish explicitly, including on cancellation."""

    def __init__(self, recorder, parent=None):
        self._recorder = recorder
        self._parent = parent
        self.run_id = str(uuid.uuid4())
        self._finished = self._usage = self._budget = False

    def _record(self, kind, **fields):
        with self._recorder._lock:
            self._recorder._event(self, kind, **fields)

    def usage(self, *, input_uncached_tokens=None, cache_read_tokens=None,
              cache_write_tokens=None, output_tokens=None):
        """Record one call's own exclusive counters, never inclusive/cumulative totals.

        Omit unavailable fields; None is unknown, not zero. Explicit zero means observed
        zero. Do not report child usage again on the parent. Provider input totals must
        be normalized by the caller if they already include cache reads/writes.
        """
        supplied = dict(zip(TOKEN_FIELDS, (input_uncached_tokens, cache_read_tokens,
                                         cache_write_tokens, output_tokens)))
        fields = {name: _count(value) for name, value in supplied.items() if value is not None}
        if not fields:
            raise ValueError("usage requires at least one observed counter")
        with self._recorder._lock:
            self._record("usage", scope="own", **fields)
            self._usage = True

    def budget(self, token_limit):
        """Declare one token budget before the first usage event; it cannot reset."""
        limit = _count(token_limit, 1)
        with self._recorder._lock:
            if self._budget or self._usage:
                raise ValueError("budget must be declared once before usage")
            self._record("budget", token_limit=limit)
            self._budget = True

    def security(self, code, *, source):
        """Record only an explicit client/boundary event; no content classification."""
        self._record("security", code=_choice(code, SECURITY_CODES),
                     source=_choice(source, ("client_report", "boundary_report")))

    def verification(self, result):
        self._record("verification", result=_choice(result, ("passed", "failed")))

    def intervention(self, code):
        self._record("intervention", code=_choice(code, ("challenge", "reframe", "alternative", "verification_request")))

    def finish(self, status):
        with self._recorder._lock:
            if any(run._parent is self and not run._finished for run in self._recorder._runs.values()):
                raise ValueError("finish child runs before their parent")
            self._record("run_finished", status=_choice(status, ("succeeded", "failed", "cancelled")))
            self._finished = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        # Normal exit and exception exit alike leave unknown outcomes unknown.
        return False
