# WorkTrust for Python tool runners

## History kept on the server (0.10.27)

`uvx worktrust history` sends a re-measure as one run; WorkTrust keeps each batch and rebuilds
the days itself once the run is whole. No `--resume` is needed.

## OS credential storage (0.10.26)

The same `protect-key` command is available through `uvx worktrust protect-key` and
`pipx run worktrust protect-key`. Update the installed bridge first and quit AI apps before
migration. macOS Keychain, Windows Credential Manager, or Linux Secret Service protects the
wrapping key for an encrypted local credential file. Linux needs libsecret-tools and an unlocked
Secret Service. No separate Node installation is needed by the supported Python wheels.

Existing users are not automatically migrated. A locked or unavailable vault stops credential
loading without plaintext fallback. Same-user software may still use the vault; this does not
verify the truth of activity or publish a Passport. Native Windows/Linux checks and publication
are still pending for this candidate.

## Delivery and account limits

After an approved update, WorkTrust receives the running version without
an activity upload. Pending metadata batches can be resumed with `worktrust history --resume`,
even after an AI app removed the original session files. Review-held revisions need review;
reconnecting does not approve them. Keep archives for work that was never queued.

The server limits new personal registrations to five active device
identities. AI apps sharing one key share one slot; cloned keys share account upload capacity.
Retiring a device preserves earlier data. Existing accounts above the limit are preserved but
cannot add another identity. Version labels and device signatures are not independent evidence
of time or correctness. A CLI update does not automatically publish a passport.


This package launches the same JavaScript measurement engine shipped in the WorkTrust npm
package. It does not implement another measurement engine. Version 0.10.14+ also includes
the explicit observation SDK documented below; 0.10.13 does not include it. See the official
[PyPI project](https://pypi.org/project/worktrust/) for published versions.
Python 3.10+ is required. Supported platform wheels include **Node.js 22.23.3**; no separate
Node or npm installation is needed. The launcher uses that bundled runtime, never downloads a
runtime when invoked, and does not silently switch to another CLI version.

Wheels target macOS 11+ (Intel and Apple Silicon), Linux with glibc 2.28+ (x64 and arm64), and
Windows 10+ (x64 and arm64). Linux also requires the Node-supported system C++ runtime
(GLIBCXX_3.4.25 or newer). Alpine/musl, 32-bit systems and other platforms are not supported.
A source distribution cannot fetch Node automatically: a source build requires the explicit
maintainer preparation step below. Supported users should install the matching wheel.

Run the CLI through either Python tool runner:

```sh
uvx worktrust preserve
pipx run worktrust preserve
```

Omit `preserve` to connect your computer. Installing through uvx or pipx does not instrument
Python applications automatically. To test a reviewed local candidate before publication:

```sh
uvx --from /absolute/path/worktrust-VERSION-py3-none-PLATFORM.whl worktrust --help
pipx run --spec /absolute/path/worktrust-VERSION-py3-none-PLATFORM.whl worktrust --help
```

Use your package manager to choose and update the installed version. The package contains
the CLI modules and Node runtime, so `preserve` itself needs no network after installation. It reads supported
local session files and can change retention settings or create local metadata archives;
only the person runs it. Existing WorkTrust agent safeguards and consent prompts remain.
Other commands can contact WorkTrust. Package installation itself can contact registries.

Explicitly request the latest published package when needed:

```sh
uvx worktrust@latest preserve
pipx run --no-cache worktrust preserve
```

For persistent installations, use `uv tool upgrade worktrust` or `pipx upgrade worktrust`.
An existing cache or version constraint can otherwise keep an older release. `worktrust update`
refreshes the computer coupling using the selected package; it does not upgrade the Python package.

Runtime bundle hashes detect missing or changed files; they are not hardware attestation or
independent proof of authenticity. Request and archive signatures retain the existing CLI's
software-key threat model. See the npm package SECURITY.md and README.md for the data contract.

The **0.10.21 release** also retains metadata before submission in
`~/.worktrust/measurements/` and advances progress only on explicit receipts. This is the same
implementation used by npm, uvx and pipx. The journal contains available timelines, opaque
references and counts, not conversation text, paths or credentials. It remains on the computer
after disconnecting; keep your own backup. Its contents remain user-controlled observations,
not independent proof of human effort. Changed historical replacements wait for server review
without overwriting earlier measurements. Updating does not restore support-withdrawn lines.

## Maintainers

Running `node tools/worktrust-cli/sync.mjs` from the monorepo also regenerates the Python JavaScript
bundle and version. `node scripts/build-python-cli.mjs --check` refuses drift. The native runtime
is a separate build artifact, excluded from Git and sdists. Explicitly prepare it before building:

```sh
python tools/worktrust-python/build_runtime.py
python -m build --wheel tools/worktrust-python
python -m build --sdist tools/worktrust-python
```

`build_runtime.py` downloads one official Node archive from nodejs.org at build time, verifies its
committed SHA256 from `runtime-lock.json`, and extracts only the executable and complete LICENSE.
It accepts `--target` for a reviewed target and `--cache` for a build cache. Platform wheel tags
follow the selected runtime. Never label these wheels `any`. Building a wheel from the sdist
fails closed until this explicit preparation step has been performed; no install hook downloads code.

Run `python tools/worktrust-python/tests/test_runtime_build.py`, then
`node scripts/test-python-cli.mjs` with a Python containing the build requirements (select it with
`WORKTRUST_TEST_PYTHON`). Tests build and exercise a real wheel using its own runtime with no Node
on PATH; they use synthetic homes and metadata only. Native execution must pass independently on
all six claimed OS/architecture combinations before release. Cross-building alone is not that proof.
Set `WORKTRUST_REQUIRE_TOOL_RUNNERS=1` to require actual uv and pipx wheel smoke tests, and
`WORKTRUST_TEST_ARTIFACT_DIR` to a fresh directory to retain the exact tested wheel and sdist.
Existing artifacts are never overwritten. Canonical module bytes match across channels;
bit-for-bit reproducibility of whole wheel or sdist archives is not asserted.

The public `fhomey/worktrust-cli` repository carries this package under `python/`, alongside the
npm package at its root. There, install `python/requirements-release.txt`, run
`python python/build_runtime.py`, then `python python/tests/test_distribution.py` with
`WORKTRUST_TEST_CLI_SOURCE` set to the repository's absolute path and
`WORKTRUST_REQUIRE_TOOL_RUNNERS=1`. The test derives Node from the built wheel; it does not require
a system Node installation. Keep build-only workflow results distinct from successful publication.

The active `.github/workflows/release-pypi.yml` uses the protected `pypi` environment and
PyPI Trusted Publishing. In the 0.10.22 candidate, the successful signed npm release workflow
triggers PyPI, which consumes its exact artifacts without rebuilding. Failed jobs can be rerun
through GitHub. The retained `release-pypi.yml.example` is historical, not the active workflow.
All six native artifact checks must pass before either registry publishes. Both channels use
the same version and module bytes.
Approvals and registry failures remain separate; confirm both publications before announcing a
release as available on both channels. Neither workflow invokes a Vercel deployment.

Do not edit generated `bundle/`, `VERSION` or `LICENSE`. Publication requires confirmed
PyPI ownership and a configured Trusted Publisher; source readiness does not grant that.

Official runtime platform requirements: https://github.com/nodejs/node/blob/v22.23.3/BUILDING.md
Pinned upstream archive checksums: https://nodejs.org/dist/v22.23.3/SHASUMS256.txt

## Explicit agent observations (requires 0.10.14+)

The optional `worktrust_cli.telemetry` SDK records events supplied by your own Python
orchestrator. It does not discover agents or inspect prompts, outputs, files, credentials or
provider SDKs. Recording is local, requires `consent=True`, and makes no network requests.
The shared JavaScript engine calculates the diagnostics for both the CLI and WorkTrust app;
Python contains no separate efficiency or scoring calculations.

Install the SDK in your agent application's own virtual environment:

```sh
python -m pip install "worktrust>=0.10.14"
```

This requires a published 0.10.14 or newer wheel for your platform. A GitHub release waiting
for approval is not a completed PyPI publication. A separate uvx/pipx tool environment does
not make `worktrust_cli.telemetry` importable in your application.

```python
from pathlib import Path
from worktrust_cli.telemetry import Recorder

# Keep opaque, randomly generated UUID4 identities stable across comparable runs.
# Generate a new version UUID when changing the agent configuration.
agent_id = "416973a6-fad6-4f20-a59c-f66b01946dc0"
agent_version = "1809b614-3212-44b6-b668-c46cfca07cb8"

with Recorder(Path.cwd().resolve() / "agent-events.jsonl", consent=True) as recording:
    agent = recording.run(agent_id=agent_id, agent_version=agent_version,
                          role="worker", task_kind="build")
    agent.budget(1000)  # Optional; before usage, once per run.
    # One call's mutually exclusive counters, taken from your provider's actual usage.
    agent.usage(input_uncached_tokens=100, cache_read_tokens=40,
                cache_write_tokens=0, output_tokens=80)
    agent.verification("passed")  # A reported check, not independent corroboration.
    agent.finish("succeeded")    # Only after your application knows its outcome.
```

Use a fresh file for each recording: existing files, symlink paths and overwrite attempts
are refused. Parents must already exist; create a child with `recording.run(..., parent=agent)`
and finish children before their parent. The recorder serializes threads in one process;
multiple processes need separate recordings. All elapsed timestamps share the recorder's
monotonic clock. Exiting a context or encountering an exception never invents completion.
An unclosed run remains incomplete. Header-only and partially written files cannot be imported.

Usage fields are optional: omit unavailable counts instead of substituting zero. Never pass
inclusive provider input totals into `input_uncached_tokens`, cumulative usage snapshots, or
child usage again on its parent. This SDK supplies no automatic provider normalization.
`security(code, source=...)` accepts only the fixed event categories documented by the API;
use it for explicit `client_report` or `boundary_report` events, never classifications inferred
from arbitrary prompt text. `intervention(code)` records an explicit challenge, reframe,
alternative or verification request. These observations do not establish causation, human
presence, capability or independently verified outcomes.

Limits are 64 runs, 2,048 events, 256 KiB per recording, 4 KiB per line and seven days on
the monotonic timeline. UUIDs, times, enums and counts only: no names, model names, task
descriptions or exception text. Files request mode 0600; Windows ACLs remain the responsibility
of the containing folder. The SDK does not change existing directory permissions. Stop writing
with `close()` and delete the explicitly chosen local file to erase it; no remote copy is sent
by this SDK. File metadata remains visible to other software running as the same user.

Run `python tools/worktrust-python/tests/test_telemetry.py` for synthetic writer and shared-engine
checks. Distribution tests also run this suite against the actual wheel and bundled runtime.

Inspect a recording locally with `worktrust orchestration report --file agent-events.jsonl`.
This command uses the shared engine, reads only the selected file and sends nothing.
The separate private Sources → Agent teams browser import requires its platform deployment
and your explicit file selection and consent; CLI publication does not deploy that page.
Application reports never become measured human hours, capability scores or employer evidence.
For the wider service, see [privacy](https://worktrust.io/privacy),
[terms](https://worktrust.io/eula) and [support](https://worktrust.io/support).

## Signed startup (0.10.22+)

The Python launcher uses `pycryptodomex>=3.24.1,<3.25` to verify the signed file manifest before
starting the bundled Node runtime. The runtime, descriptors, shared engine and Python modules
are covered. Missing or changed files and invalid signatures stop execution. Package managers
install this verification dependency; npm is never invoked or installed by the Python launcher.
The initial package-manager installation, Python environment and bootstrap remain trusted;
a computer owner can change or bypass them. This is not execution attestation.

This is release integrity, not proof that a local transcript is authentic. Local Claude records
are not release files, and `cli_digest` is diagnostic client metadata. Hashes are not encryption.
Computer-key revocation stops submissions; passport withdrawal invalidates a publication;
neither silently erases historical account data. See the shared CLI SECURITY.md for the limits.

### Persistent hooks in 0.10.25

After pairing or update, client configuration starts the package manager's host Python with
`-I` and a retained bootstrap. It checks the copied Node runtime and engine against the
release-authenticated hashes before executing Node. No package-manager cache or crypto
dependency is needed by this retained standard-library bootstrap; the host Python interpreter
must remain installed. Node itself is still bundled, so no separate Node installation is needed.
Changed files stop execution and request an official reinstall. This is integrity checking,
not hardware attestation or validation of the person's local transcript.
