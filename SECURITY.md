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
