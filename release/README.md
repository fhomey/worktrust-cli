# CLI release and observation security candidate

**Status, 20 October 2026:** signed 0.10.25 is published on npm/PyPI. The release-history
paragraphs below describe the earlier rollout, not the current registry version.
OS credential storage shipped in 0.10.26 (npm/PyPI); 0.10.29 (history re-split, session kind) and 0.10.30 (remembered consent on update) are published on npm; 0.10.31 (re-measure offered only when the measure rules change) is published; 0.10.32 (a re-measure sends only the days that changed, the subagent runs, each call's outcome; measure rules 2) is published on npm and PyPI; 0.10.33 (one line per autonomous process per day, a fair-use 429 kept and retried; measure rules stay 2) is a local candidate. See
[its implementation and limits](../../docs/security/CLI-OS-KEYSTORE-2026-10-20.md).
The observation collector below is still not wired into the existing hooks.

**0.10.23 source candidate; registry 0.10.21 remains live.** A separate Ed25519 release key has
been provisioned in GitHub's protected `cli-signing` environment, restricted to `v*` tags and
owner approval. Only its public half is embedded in Node and Python. Native package launchers,
archive signing and the publishing workflows are implemented locally; no 0.10.23 package has
been published. Neither SQL file here is a production migration. The shared evidence engine
is unchanged; release integrity does not create another evidence calculation.

The new `worktrust-launch.mjs` and Python bootstrap authenticate fixed files before importing
local engine/verifier modules or starting the bundled runtime. Generated inline verification
avoids executing an edited helper before checking its hash. The npm connection installs an
immutable signed copy, and Python's persistent runtime retains the signed engine launcher.
The initial bootstrap and host interpreter remain trusted installation boundaries.

The protected release flow signs six wheels, the sdist, npm tarball and preservation kit,
including their internal file manifests and bundled runtimes. `release-artifacts.json` binds
all nine final archive hashes to the source commit. Source CI builds once; a protected job
signs; six native jobs test those final bytes; the same archives then reach GitHub release
storage and the existing npm/PyPI approval gates. PyPI consumes the successful npm release
workflow's artifacts instead of rebuilding. Git deployments stay disabled in the CLI mirror.
Templates live in `workflows/`; mirror commit `9af7aca` activates them.
The previous 0.10.22 candidate passed 263 local checks and six-platform source CI, but signing
run `39329168390` correctly refused the real preservation kit: its legitimate
`agent/.claude-plugin/` directory was outside the archive path policy. That prerelease was
not published to npm/PyPI. The 0.10.23 correction narrowly permits that named directory in
both the signer and startup verifier. The actual generated kit is now a mandatory regression,
including plugin-metadata tampering; traversal and other hidden directories still refuse.
The 0.10.23 full verification passed all 263 steps; native Mac wheel/sdist and offline
uvx/pipx passed 114 checks. Mirror commit `273c467` passed all six native source targets
in run `39336019271`. Release run `39336259700` has now signed all nine artifacts, passed
all six final native checks and stored the artifacts plus signed catalogue on GitHub.
The npm job succeeded and npm reports processing; public availability is not yet confirmed
(`latest` still reports 0.10.21). PyPI run `39341894248` waits for the existing `pypi` owner approval. The failed 0.10.22 tag is not rewritten.

The generated ZIP under the marketing site is still an **unsigned build input** for protected
signing. Publishing a signed GitHub kit does not update the website download. Do not deploy
that candidate website ZIP: a separate reviewed synchronization must install the signed asset
and reconcile its public checksum/build checks first. This CLI release does not deploy Vercel.

The private release key is outside the repository, under the owner's private
`~/.config/worktrust-release-signing/` directory, with mode 0600. Keep an encrypted operator
backup and plan key rotation. It is not an app, device, OAuth, observation-receipt or Passport
key. GitHub stores it encrypted; no private value is printed or included in artifacts.

`integrity.mjs` uses SHA-256 and domain-separated Ed25519 signatures. Trust roots must be
provisioned through a reviewed bootstrap, separately from downloaded manifests. It checks
signed file identities, platform/protocol, catalogue expiration, sequence, revocation and
version order. This is **not a full TUF implementation**: threshold signing, root rotation,
delegation and a separately signed timestamp/snapshot hierarchy are not implemented.
Adopt a maintained TUF client or complete an external security review before production use.

`install.mjs` stages bounded HTTPS downloads with redirects refused, verifies them before a
version health check, and activates immutable version directories through an atomic state
replacement. A failed update retains the previous installation only while it remains
authorized. Learned revocations persist even when a later download fails. Startup verifies
all installed files and never downloads. Offline startup cannot discover new revocations.
The launcher itself and its host Node runtime require a trusted installation; modifying or
bypassing either is outside software-only self-verification.

`server-store.mjs` verifies signed controlled-build references before registering them in
the candidate PostgreSQL store. PostgreSQL computes the stored reference SHA-256 itself.
Manifests cannot be replaced under an existing version/platform, including by a later valid
catalogue. Measurement intake must never register release reference hashes.

`anchors.mjs` authenticates no caller itself: a future server route MUST first bind the
owner and device to a fresh authenticated, device-proven request with rate/size limits.
Its PostgreSQL transaction locks that owner/device even before the first row, checks the
predecessor, rejects rewritten batches and reused event ids, and stores a signed receipt.
Receipts include server receive time, local time range, exact-byte digest, count and
parser/schema versions. They explicitly say `client-reported`. No score or hours writer
reads these tables. The schema stores digests, identifiers and receipts, not prompt content.

`outbox.mjs` requires explicit consent. It accepts only closed metadata events, keeps them
locally with restrictive permissions, persists pending batches before upload and advances
only after the correct signed receipt. Lost responses are retried with identical bytes.
The optional collector flushes queued metadata once a minute; a host must explicitly start
it and provide observations. **No existing Claude/Codex hook is connected to it yet.**
There is no automatic telemetry registration or general OTLP/content endpoint.

The server clock proves when a digest arrived, not when claimed work happened. A software
key proves possession, not genuine activity. An editable computer can fabricate input,
keys, claimed release hashes and local times. Public claim eligibility must remain separate.

## Explicit candidate commands

Controlled build, with an external private key file and a reviewed descriptor listing the
exact staged files (never include the private key in the staged directory):

```sh
node scripts/build-cli-release.mjs STAGED_DIRECTORY DESCRIPTOR.json PRIVATE_KEY.pem
```

The descriptor fields are `format: "worktrust-release/1"`, `version`, positive `sequence`,
`channel: "stable"`, `platform` (`darwin|linux|win32` plus `arm64|x64`), `protocol: 1`,
`entry` and a `files` array. The builder emits `release.json`; its output reports the
SHA-256 to use in the separately signed release catalogue. All root keys used in tests
are disposable. There is no default production root or test-key fallback.

A reviewed local bootstrap JSON supplies `method: "standalone"`, `root`, `roots`
(public-key fingerprint to Ed25519 SPKI PEM), `allowedOrigins` and `catalogueUrl`.
Do not download this bootstrap from the same unauthenticated release channel.

```sh
node tools/worktrust-release/launcher.mjs BOOTSTRAP.json release-update
node tools/worktrust-release/launcher.mjs BOOTSTRAP.json updates check
node tools/worktrust-release/launcher.mjs BOOTSTRAP.json updates enable
node tools/worktrust-release/launcher.mjs BOOTSTRAP.json updates disable
node tools/worktrust-release/launcher.mjs BOOTSTRAP.json preserve
```

Normal interactive checks are bounded to once per day with a 1.5-second catalogue deadline.
Automatic standalone installation starts disabled. Hooks/MCP and preserve never start
updates; preserve has no version check. Update commands are person-only, retaining the
CLI's agent-shell boundary. npm/npx and Python installations stay with their package
managers; `update-policy.mjs` provides native commands, never an implicit Python-to-npm relay.

Install/outbox locks are not stolen. Interrupted network requests release their lock; a
process killed while holding a lock requires explicit recovery after confirming it stopped.
Windows ACLs and real Windows executable-lock behavior still need native CI validation.
No recovery command or root-key rotation ceremony is shipped by this candidate.

## Before enabling this in a production release

1. Review the provisioned release root and its encrypted backup, rotation/recovery and
   revocation ownership. A separate observation signing key is still unprovisioned; prefer
   managed signing for that future deployed service.
2. Activate the implemented protected mirror signing workflow **after every platform artifact
   is built**. It covers all six final wheels, source archive, npm tarball, launcher, bundled
   runtimes and preservation kit. Independently verify provenance and contents.
3. Activate the staged signing workflows and verify signed artifacts on all native runners.
   Preserve signed manifests server-side with the release assets. This still does not retrofit
   verification into npx/pip internals before their initial trusted installation.
4. Promote reviewed SQL into migrations with grants/digest ledgers/erasure coverage; rehearse.
   Add the authenticated, device-bound observation intake with bounded requests and safe
   error categories; use a receipt signing key distinct from the release signing key.
5. Wire opt-in live metadata capture to supported client hooks and the minute collector.
   Retain historical imports separately. Do not enable raw OTLP payload forwarding.
6. Run full `pnpm verify`, actual npm/uvx/pipx wheel installs on all six platforms, native
   Windows lock/interruption recovery, offline preserve with outbound calls blocked,
   root rotation and staged rollout/revocation drills. No production-ready claim before this.

## Trust boundaries and separate revocation operations

Local Claude records are not fixed release files. The official client can read changed input.
`cli_digest` is diagnostic client metadata, not evidence of which instructions executed.
SHA-256/SHA-512 are not encryption: HTTPS protects transport; the publication gate decides
which concrete claims have sufficient independent support.

Revoking a computer/coupling key stops new authenticated submissions. Withdrawing a Passport
invalidates that publication and online verification. These are separate audited operations;
revocation is not automatic erasure of earlier account data. Release-key retirement is a third
operation and must not reuse either mechanism. No token/Passport/erasure mutation is part of
the release signer or launcher. The observation collector remains a separate, unactivated phase.
