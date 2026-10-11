# WorkTrust for Python tool runners

This package launches the same JavaScript measurement engine shipped in the WorkTrust npm
package. It does not implement another measurement engine or a Python instrumentation SDK.
Python 3.10+ is required. Supported platform wheels include **Node.js 22.23.3**; no separate
Node or npm installation is needed. The launcher uses that bundled runtime, never downloads a
runtime when invoked, and does not silently switch to another CLI version.

Wheels target macOS 11+ (Intel and Apple Silicon), Linux with glibc 2.28+ (x64 and arm64), and
Windows 10+ (x64 and arm64). Linux also requires the Node-supported system C++ runtime
(GLIBCXX_3.4.25 or newer). Alpine/musl, 32-bit systems and other platforms are not supported.
A source distribution cannot fetch Node automatically: a source build requires the explicit
maintainer preparation step below. Supported users should install the matching wheel.

After publication under a verified WorkTrust-owned PyPI project, the intended commands are:

```sh
uvx worktrust preserve
pipx run worktrust preserve
```

These public commands are not a claim that this package has already been published. Test a
reviewed local wheel first:

```sh
uvx --from /absolute/path/worktrust-VERSION-py3-none-PLATFORM.whl worktrust --help
pipx run --spec /absolute/path/worktrust-VERSION-py3-none-PLATFORM.whl worktrust --help
```

Use your package manager to choose and update the installed version. The package contains
the CLI modules and Node runtime, so `preserve` itself needs no network after installation. It reads supported
local session files and can change retention settings or create local metadata archives;
only the person runs it. Existing WorkTrust agent safeguards and consent prompts remain.
Other commands can contact WorkTrust. Package installation itself can contact registries.

After PyPI publication, explicitly request the latest published package when needed:

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

The inactive `release-pypi.yml.example` targets this public layout. Its intended active filename
is `.github/workflows/release-pypi.yml`, using the protected `pypi` environment and PyPI Trusted
Publishing. Once activated, the same GitHub release triggers both registries; manual execution
supports the initial Python publication and retries. npm also requires the supported-platform Python
artifact/parity tests before publishing. Both channels use the same version and module bytes.
Approvals and registry failures remain separate; confirm both publications before announcing a
release as available on both channels. Neither workflow invokes a Vercel deployment.

Do not edit generated `bundle/`, `VERSION` or `LICENSE`. Publication requires confirmed
PyPI ownership and a configured Trusted Publisher; source readiness does not grant that.

Official runtime platform requirements: https://github.com/nodejs/node/blob/v22.23.3/BUILDING.md
Pinned upstream archive checksums: https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
