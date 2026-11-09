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
  the npm registry for a version notice. Release notices never execute a different version; the one exception is the verified update when
  you turn the CLI back on in Sources (below). The npm package bundles its runtime
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

## What you agreed to: `~/.worktrust/consent.json` (0.10.30)

- One private file (mode 0600, written through the same exclusive-temp, atomic-replace path as the credential file,
  refused when it is a link or not owned by you). Per coupling you said yes to it holds a NAME only
  (`door:<app>` such as `door:Cursor`, `session-hook`, `codex-notify`, `antigravity-stop`), the day, the CLI version
  and how the yes was given (`typed`, `flag` for `--yes`, `--codex` or `--antigravity` said in advance, `found` for a
  WorkTrust entry already on the computer when the file was first made). No key, no token, no path, no command and
  nothing of any config file. It is never sent.
- What it changes: `update` refreshes an agreed entry without asking when only the launcher's path moves. It never
  turns a new AI app or a wake hook that is no longer there into a yes: those are asked about, and `--yes` skips them.
  It is never read as agreement to send anything: the re-measure of earlier history still needs a typed `y` or
  `--rebuild`, every time a new version offers it.
- Who can change it: anyone who can write your home folder, which can already edit the AI apps' settings directly.
  A forged entry can at most spare the question for a write WorkTrust would offer anyway (the door in an AI app found
  here, a wake hook); it cannot widen what is written, sent or read. An unreadable or unsafe file counts as no agreement.
- A No drops the entry it answered; `disconnect` deletes the file; a coupling to another account starts it empty.

## The question before a re-measure (0.10.32)

Before a re-measure, the hook asks the door, per AI app, which days of this computer WorkTrust holds as current. The
request is `import_history` with `rebuild: true, fingerprint: true` and nothing else: no line, no hours, no path. It
goes under the computer's own key and, on a bound computer, with its device proof, like every history batch. The
answer is a list of UTC days and, for each, the 64-hex digest this computer sent with that day: digests of its own
submissions, never a line, a figure or anything of the record. A digest is computed here from what this computer would
send; a day that matches is not sent again. An answer that cannot be read means not known, and every day is sent.

When a transcript on this computer exists but cannot be read (permissions, a disk error), the hook counts it, keeps the
count in `~/.worktrust/sessions.json`, shows it in `npx worktrust status`, and at most once a day asks the same question
with the count beside it (`unreadable: N`): a number, never which file, its path or anything in it.

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


## Updating itself when you turn it on (0.10.37)

This is the one place the CLI installs and runs a newer version without you typing a command. It exists because you
asked for it in the app: when you switch **CLI active** back on for a computer in WorkTrust › Sources, that computer
brings itself to the newest published CLI. A registry version string alone never starts it (the interactive notice
above still only tells you), and `npx worktrust update` is unchanged.

- **When.** WorkTrust asks for it only after your own act: turning CLI active on, under your signed-in session (with
  your second factor when your account has one), for a computer whose CLI had confirmed it was paused. WorkTrust then
  records one instruction for that computer; a pause clears it, a computer that never paused gets none. The hook reads it
  with the computer's own signed key (`api/cli/door`) as `update: { version, at }`; `at`, the moment you turned it on,
  is its id. The CLI takes an id once (`~/.worktrust/update.json`, 0600), never while paused, never one dated more than
  five minutes past the door's own clock (its `Date` header), and, after an attempt that did not install, none for 24
  hours. The "only after your turn-on" rule is WorkTrust's server's: the computer cannot see your act, so it does not
  rely on it (next point).
- **Which version, decided on the computer.** It installs only a version that is newer than itself (`current`
  otherwise: no downgrade) AND that npm's own registry record lists as `dist-tags.latest` and does not deprecate,
  whatever version the door names. A version the console classes critical is deprecated on npm as well
  (tools/worktrust-release/README.md), so a computer refuses it even if a server named it.
- **npm 11.12.0 or later.** `npm audit signatures --include-attestations` first appears there. The CLI uses the npm beside
  the running Node (its own installation), else the first one on PATH, asks `npm --version` first, and with an older
  npm, or none, reports `unsupported` before anything is fetched: update npm, or run the command.
- **What runs, implicitly.** Detached from the hook (which returns at once and prints nothing), under a lock:
  1. `npm --version` and `npm view worktrust@<version> --json --registry=https://registry.npmjs.org/` (the policy above);
  2. `npm install --ignore-scripts --registry=https://registry.npmjs.org/ worktrust@<version>` into a new staging folder
     under `~/.worktrust/update-stage` (no lifecycle script of the package runs);
  3. `npm audit signatures --json --include-attestations` in that folder;
  4. after all checks below hold: the package is copied into `~/.worktrust/verified/<identity>` (as every update does)
     and that new launcher, which verifies itself before importing anything, runs `update --yes`. That command may renew
     this computer's key (the weekly signed renewal), takes WorkTrust's door out of and back into each app you agreed to
     (Claude Code through `claude mcp remove` and `claude mcp add`; the other apps' config files rewritten; if the add
     does not finish, the files it took out are written back as they were and Claude Code's entry is put back), refreshes
     the session hook and the Codex and Antigravity wake lines you agreed to, reports its version to WorkTrust, and, when
     the measure rules changed, counts this computer's sessions for the re-measure offer and sends none of them (the
     offer's default is No). Nothing new is coupled and no history is sent.
  The staging folder is removed afterwards (a folder that cannot be removed is logged, never a failure). Agent-shell
  markers are left out of these processes' environment because the act is yours from Sources; `self-update` typed in
  an agent's shell is refused like every person-only command.
- **The trust root, none of it WorkTrust's server.** (a) npm's registry signature for that exact version and integrity,
  and (b) the npm provenance attestation: both VERIFIED BY NPM (registry keys; Sigstore's root, certificate chain and
  transparency log) and relayed to the CLI by `npm audit signatures`; the CLI then binds what npm verified: the
  certificate must name `https://github.com/fhomey/worktrust-cli/.github/workflows/publish.yml@refs/tags/v<version>`, its
  Fulcio extension 1.3.6.1.4.1.57264.1.8 must hold GitHub Actions' OIDC issuer exactly, its DSSE signature must verify
  under that certificate, its subject must be this tarball's sha512, and its workflow, repository and tag must match.
  (c) WorkTrust's own release signature (`package-release.json`) under the key pinned in the CLI already installed is
  the binding root: it does not depend on npm's word or on WorkTrust's server. The registry is forced to
  registry.npmjs.org for every npm call, so a configured mirror cannot supply its own keys or record. A compromised
  WorkTrust server can still send an instruction at a moment of its choosing; what a computer then installs is only the
  release npm currently lists as latest and does not deprecate, newer than its own, with that provenance and that
  release signature.
- **What falls back to the command.** A Python installation (pip, pipx, uv, uvx) does not update itself (`python`), and
  neither does a computer without npm 11.12 or later, or a CLI not started from its verified npm copy (`unsupported`).
  Sources then says what to do, with the command. A computer on 0.10.36 or older has no updater: update it once by hand.
- **When something fails.** Nothing new runs and the running CLI stays as it was. The next door call reports a code
  beside the version, `worktrust-update/<installed|current|python|unsupported|unverified|failed>.<id>`, never content;
  the reason stays in `~/.worktrust/update.log` on this computer (versions, codes, a short npm message; no key). An
  outcome is written only for the instruction that started it. An attempt that has not finished in half an hour is
  reported `failed`, once. `worktrust status` names the outcome.
- **What it does not establish.** As above: signatures and provenance tie the bytes to the reviewed publish workflow;
  they do not prove truthful activity, and a process running as you can still change files after a check.

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

## Remote agents (`npx worktrust remote`, not yet released)

What it is: standing remote execution of AI agents on this computer, steered from a confirmed phone. Its limits:

- Separate key, separate audience. The remote keys (`~/.worktrust/remote/remote-keys.json`, 0600) are not the measurement
  key and no remote module reads the measurement credentials (`scripts/check-remote-cli.mjs` refuses one that names them).
  Bindings are verified against issuer keys pinned in the release; a test-only issuer key is honoured only for a gateway on
  this computer's loopback.
- Controllers are confirmed here. A phone becomes a controller by scanning the QR this terminal draws (its secret proves
  it saw this screen and is mixed into the first handshake) or by a typed code confirmed at this keyboard. The issuer alone
  cannot add a controller. `remote phones remove` drops one at once.
- The gateway reads no content: commands and events are sealed between the phone and this computer (XChaCha20-Poly1305
  under keys from an authenticated X25519 handshake). The gateway sees ids, message types, times and size classes.
- At most once. Every command is written to `~/.worktrust/remote/journal.jsonl` and flushed to disk before an agent runs; a
  repeat is answered from the journal, and a command an interrupted daemon left mid-way is closed as failed, never run again.
- Approvals are classified on this computer. Only project edits, the reviewed test, build and lint commands, and outward
  messages shown whole can be approved from a phone, each by a signed decision bound to the exact action, single use,
  five minutes at most; offline or no answer is a denial. Claude Code also gets deny rules for pushes, installs, deploys
  and secret reads, and loads only your user settings, so a repository's own rules or hooks do not apply remotely.
- What it does not stop: an approved test command runs the project's own test code, which can do what that code does;
  grant only folders whose code you trust. The phone's keys are on the phone: until you revoke it, whoever unlocks it can
  steer agents within these rules. macOS asks for folder access per program, so the access you grant the service's `node`
  covers every script that `node` runs.
- Hours. A remote-steered session is never your AI Hours (see README).

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
