# Security

## Reporting a problem

Write to **hello@worktrust.io** with "security" in the subject. Please do not include credentials,
private transcripts or account data in a public issue.

## What this package can and cannot do

- Setup changes client configuration and local coupling files; preservation can change retention
  settings and create or append archives. See the README for the paths and individual options.
  The complete official release is required. Individual script download fallbacks are removed;
  interactive commands may check for a newer release.
- Submissions go to the configured WorkTrust MCP endpoint. Interactive commands can also contact
  the npm registry for a version notice. Release notices never execute a different version. The npm package bundles its runtime
  modules, but package-manager installation and explicit upgrades still use the network. `preserve` itself is local.
  A custom `--origin`, URL or registry override changes whom you trust.
- The key it receives is a WorkTrust coupling for this computer: it can submit work metadata to your
  record and cannot read your record back. Revoke it in WorkTrust at any time.
- Approving requires your WorkTrust session and second factor. A pairing expires after ten minutes
  and gives out its key once.
- By default the key can only reach the terminal on the computer whose browser approved it: the
  browser returns a one-time code to 127.0.0.1, and the key is issued only to the terminal holding
  the matching PKCE verifier (S256). The terminal listens on 127.0.0.1 only, for one answer that
  carries the state it chose.
- The typed-code way (no browser, `--device`) is the one a stranger could try to abuse by asking you
  to type their code. The code is never put in a link; type only a code your own terminal shows.

## Where the key is, and how long it lives

- Existing installations use a private local file until explicit `worktrust protect-key` migration
  (0.10.26 and later). Base64 in that legacy file is not encryption.
- Protected mode uses AES-256-GCM for all coupling secrets and OS storage for a separate random
  wrapping key: macOS Keychain, Windows Credential Manager with local-machine persistence, or
  Linux Secret Service. Only a random identifier, provider, nonce, ciphertext and authentication
  tag remain in `key.json`. Private file checks and atomic replacement still apply. Locked,
  missing or unavailable OS storage fails closed, without a new key or plaintext fallback.
- This is exportable software credential protection, not hardware attestation. Other software
  authorized as the OS user can request decryption; an attacker controlling the launcher or OS
  can bypass local checks. Local activity remains untrusted for independent public claims.
- The command does not reset a vault, change its ACLs, erase backups, revoke stolen credentials,
  or move the independent offline archive continuity key. New setup is opt-in; it is not an
  automatic migration of existing users. Hooks never write vault items or trigger unlock UI.
- In the default mode, requests carry an Ed25519 proof. WorkTrust refuses a bound token without a
  fresh signature (two minutes, a nonce spent once). A bearer token alone is insufficient; theft of
  the legacy plaintext credentials, or the protected file together with access to its OS wrapping key, defeats that protection. Profile/device hashes are not hardware
  attestation. Revoke the computer in WorkTrust if its credential file may have been copied.
- `--direct` instead places an unbound bearer token in AI client settings and does not provide the
  same proof requirement. Do not apply the default mode's guarantees to that mode.
- The client attempts weekly renewal using a signed request containing the new token's hash.
  Interrupted renewal retains recovery state. From 0.10.12, promotion requires the expected successful
  response; errors, redirects and malformed replies preserve recovery state. Requests have deadlines.
  A server error is not evidence that a credential works.
- The key can submit metadata to your record and cannot read it back. It ends when you revoke it,
  and by itself 90 days after its last use.
- Local `disconnect` is distinct from server revocation and archive deletion. Revoke through
  WorkTrust's device settings when the server credential must stop working.

## What measurement signatures establish

The metadata journal introduced in the 0.10.21 candidate preserves observations, not their
truth. A user who controls the computer can fabricate session files, timestamps, counters,
model labels and software-key signatures, or name an official code digest. Server-side
recalculation detects a conflicting arithmetic claim; it cannot authenticate a fabricated
timeline. Prior receipts provide a comparison baseline, not independent confirmation.
Changed historical replacements are held for review without overwriting that baseline.
The journal is not encrypted storage, hardware attestation or a server-signed archive.

Request proofs authenticate possession of the device key. Archive seals make later changes
detectable relative to their trusted key/root. Neither proves that the client is unmodified, that
local input files are authentic, or that work really happened. Local-only archive keys do not grant
measured provenance. Server provenance and corroboration rules remain necessary.

The client derives metadata by reading supported local session data. It does not submit raw prompts,
answers, code or file paths, but can submit repository owner/name and commit hashes. These remain
potentially identifying metadata; see the README's complete payload list.

Agent-shell detection is a workflow safeguard, not protection from malicious same-user software.
Agents must follow AGENTS.md. From 0.10.12 the bare invocation is covered by the same guard as explicit
person-only commands; help and version are safe informational paths. An export is read as a stream
(0.10.18) through a JSON walk of our own that keeps a fixed set of fields per conversation and skips the
rest unbuilt; a zip entry is inflated as a stream. Bounds: a file (bare or zip) to 64 GiB, a zip directory
to 8 MiB, nesting to 64, conversations to 2,000,000, a conversation's kept fields to 8 MiB (the counter's
text, read locally, to 64 MiB; a conversation past its budget is left out and counted), an export held whole
to 512 MiB of kept fields; zip64 is refused. Peak memory is bounded by the chunk in flight and one
conversation's kept fields (`scripts/test-export-memory.mjs` holds it under 200 MiB for a gigabyte). These
are resource bounds, not a sandbox or independent validation of the export's truth.

## Verifying a version

The unpublished maintenance patch based on 0.10.21 removes automatic execution based only on a newer registry
version string. The separate signed release/receipt components in the monorepo's
`tools/worktrust-release` are engineering candidates: production signing keys, final artifact
signing and npm/Python launcher integration are not yet provisioned. The current Python bundle
manifest detects file corruption but is not itself an authenticated WorkTrust release signature.
Do not treat its matching SHA-256 values as proof that modified input describes genuine work.

The release configuration names https://github.com/fhomey/worktrust-cli and requests npm provenance.
Check the particular published version's attestation and compare its contents to that commit before
relying on those properties. A manifest flag or matching version string alone is not proof that an
artifact was built from reviewed source. `npm audit signatures` can inspect an installed dependency
tree; verification coverage and failures must be reported for that actual installation.


## The WorkTrust mod for Claude Code (0.10.15, opt-in)

`worktrust mod install` asks, then writes a Claude Code plugin to `~/.worktrust/claude-mod` and names
that directory in `~/.claude/settings.json` (`env.CLAUDE_CODE_PLUGIN_DIRS`, the file backed up beside
itself first). Claude Code 2.1.287 or later loads it in every session. It runs inside Claude Code
with your permissions, as every mod does, and Claude Code's own validator lists what it may do:
twelve events it observes, and three calls: `fs.write` (its one counts file per session under
`~/.worktrust/claude-mod-counts`), `session.id` and `tool.list`. It makes no network request, starts
no process, calls no model, rewrites no prompt or tool call (each hook hands back exactly what Claude
Code gave it) and keeps no text: only integer counts in a closed list (`claude-mod.mjs`,
`MOD_FIELDS`). The session hook sends those counts with the session's stretch as `evidence.live`;
the platform keeps only the listed keys, from a CLI key alone, and shows them to you alone.
`worktrust mod remove` and `worktrust disconnect` take it out of the settings and delete the plugin
and its counts.

## Python distribution and explicit agent observations

The official [PyPI package](https://pypi.org/project/worktrust/) runs the same measurement
modules as npm. Supported wheels include the pinned Node runtime; invocation does not download
Node, fall back to PATH or relay to a newer npm version. Package-manager installation and
upgrades can contact registries. Use the README for platform requirements and update commands.

From 0.10.14, the optional Python recorder writes explicitly supplied UUIDs, dates, fixed event
categories and counts to a newly chosen local file, with `consent=True`. It makes no network
requests and does not discover agents or inspect their prompts, outputs, model names or code.
The local `orchestration report --file` command also sends nothing. Recordings are bounded;
existing files and symlink paths are refused. The requested file mode is 0600; Windows folder
ACLs and other processes running as the same user remain outside that protection.

These observations are application reports, including reported checks and security events.
They do not independently establish successful outcomes, prompt-injection resistance, human
hours or capability. Parent/child elapsed time includes waiting and must not be summed as
human work. Missing token coverage remains unknown; providers must supply exclusive deltas.

The separate private platform import requires a deployed platform feature and explicit browser
selection and consent. It is not an automatic SDK upload or an MCP submission. Deleting a local
recording does not erase a separately imported copy; delete that copy through the private app.
See the service [privacy policy](https://worktrust.io/privacy) and
[support](https://worktrust.io/support) for account data requests.

## Execution boundary in 0.10.25

The official launcher starts helpers from its checked release, never a loose counter, hook or
reader in `~/.worktrust`. Its helper processes re-enter the launcher and its manifest check.
A missing or changed release is refused with an instruction to reinstall; it is not repaired
by downloading individual scripts. Earlier loose files may remain for recovery but are not
used as executable fallbacks.

Python's persistent installation now starts with the package manager's host Python in isolated
mode. A standard-library bootstrap checks the copied Node binary and engine before Node
executes, against hashes authenticated during installation. It does not trust a rewritten local
`runtime.json` or `installation.json` to authorize changes. The initial Python package still
verifies its publisher signature before installation. The host Python must remain available.

Bootstrap files, host interpreters, client configuration and processes running as the owner
remain trust boundaries. Replacing the bootstrap or racing file changes after a check cannot
be prevented by self-verification on an owner-controlled computer. Generated Claude/OpenCode
client plugins and user transcript/SDK inputs are not remote attestation. Server claim and
publication gates remain necessary; a matching client hash never proves truthful activity.
