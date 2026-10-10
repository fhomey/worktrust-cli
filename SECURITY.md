# Security

## Reporting a problem

Write to **hello@worktrust.io** with "security" in the subject. Please do not include credentials,
private transcripts or account data in a public issue.

## What this package can and cannot do

- Setup changes client configuration and local coupling files; preservation can change retention
  settings and create or append archives. See the README for the paths and individual options.
  A setup dry run is not a sandbox for the whole invocation: the standalone bootstrap can download
  scripts first, and the interactive entry can check for a newer release.
- Submissions go to the configured WorkTrust MCP endpoint. Interactive commands can also contact
  the npm registry and relay through `npx` to a newer version. The npm package bundles its runtime
  modules, but installation and automatic relay still use the network. `preserve` itself is local.
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

- In `~/.worktrust/key.json`, alongside the software private key. The client requests mode 600 in
  a 700 folder; Windows permissions need their own access-control check. Base64 is not encryption.
  No keychain or hardware-backed key is used. Another process running as you may read both secrets.
- In the default mode, requests carry an Ed25519 proof. WorkTrust refuses a bound token without a
  fresh signature (two minutes, a nonce spent once). A bearer token alone is insufficient; theft of
  the whole credential file defeats that protection. Profile/device hashes are not hardware
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

Request proofs authenticate possession of the device key. Archive seals make later changes
detectable relative to their trusted key/root. Neither proves that the client is unmodified, that
local input files are authentic, or that work really happened. Local-only archive keys do not grant
measured provenance. Server provenance and corroboration rules remain necessary.

The client derives metadata by reading supported local session data. It does not submit raw prompts,
answers, code or file paths, but can submit repository owner/name and commit hashes. These remain
potentially identifying metadata; see the README's complete payload list.

Agent-shell detection is a workflow safeguard, not protection from malicious same-user software.
Agents must follow AGENTS.md. From 0.10.12 the bare invocation is covered by the same guard as explicit
person-only commands; help and version are safe informational paths. Export parsing limits ZIP size
to 2 GiB, directory size to 8 MiB, compressed/decoded JSON to 64 MiB, nesting to 64, structural tokens
to 1,000,000 and conversations to 50,000. Larger inputs are refused. These are resource bounds,
not a sandbox or independent validation of the export's truth.

## Verifying a version

The release configuration names https://github.com/fhomey/worktrust-cli and requests npm provenance.
Check the particular published version's attestation and compare its contents to that commit before
relying on those properties. A manifest flag or matching version string alone is not proof that an
artifact was built from reviewed source. `npm audit signatures` can inspect an installed dependency
tree; verification coverage and failures must be reported for that actual installation.
