# WorkTrust for Python tool runners

This package launches the same JavaScript measurement engine shipped in the WorkTrust npm
package. It does not implement another measurement engine or a Python instrumentation SDK.
Python 3.10+ and an existing **Node.js 22.5+** installation are required. The launcher never
installs Node or npm, and does not silently switch to another CLI version.

After publication under a verified WorkTrust-owned PyPI project, the intended commands are:

```sh
uvx worktrust preserve
pipx run worktrust preserve
```

These public commands are not a claim that this package has already been published. Test a
reviewed local wheel first:

```sh
uvx --from /absolute/path/worktrust-VERSION-py3-none-any.whl worktrust --help
pipx run --spec /absolute/path/worktrust-VERSION-py3-none-any.whl worktrust --help
```

Use your package manager to choose and update the installed version. The package contains
the CLI modules, so `preserve` itself needs no network after installation. It reads supported
local session files and can change retention settings or create local metadata archives;
only the person runs it. Existing WorkTrust agent safeguards and consent prompts remain.
Other commands can contact WorkTrust. Package installation itself can contact registries.

Runtime bundle hashes detect missing or changed files; they are not hardware attestation or
independent proof of authenticity. Request and archive signatures retain the existing CLI's
software-key threat model. See the npm package SECURITY.md and README.md for the data contract.

## Maintainers

Run `node scripts/build-python-cli.mjs` from the monorepo after the canonical counter and npm
package have been synchronized. `--check` refuses drift. Then run
`python -m build tools/worktrust-python` and `node scripts/test-python-cli.mjs` with a Python
interpreter containing `build` (select it with `WORKTRUST_TEST_PYTHON`). Tests use synthetic
homes and locally installed wheels, never an owner's credentials or session data.
Set `WORKTRUST_REQUIRE_TOOL_RUNNERS=1` in release checks to require both `uv` and `pipx`
beside the test interpreter. Set `WORKTRUST_TEST_ARTIFACT_DIR` to a fresh output directory
to retain the exact tested wheel and sdist; existing artifact files are never overwritten.
Canonical module bytes are identical across channels; bit-for-bit reproducibility of whole
wheel or sdist archives is not asserted.

The public `fhomey/worktrust-cli` repository carries this package under `python/`, alongside
the npm package at its root. There, use `python -m pip install -r python/requirements-release.txt`
and run `python python/tests/test_distribution.py` with `WORKTRUST_TEST_CLI_SOURCE` set to
the repository's absolute path, `WORKTRUST_TEST_NODE` set to the Node executable's absolute path,
and `WORKTRUST_REQUIRE_TOOL_RUNNERS=1`. This checks the built wheel against the root npm modules.
The build-only GitHub workflow runs on Linux and macOS. Native Windows validation remains open.

The inactive `release-pypi.yml.example` targets this public layout. Its intended active filename
is `.github/workflows/release-pypi.yml`, using the protected `pypi` environment and PyPI Trusted
Publishing. npm and PyPI have separate workflows; neither invokes a Vercel deployment.

Do not edit generated `bundle/`, `VERSION` or `LICENSE`. Publication requires confirmed
PyPI ownership and a configured Trusted Publisher; source readiness does not grant that.
