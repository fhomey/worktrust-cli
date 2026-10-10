# For AI agents working near this package

This is **WorkTrust's measurement client**, published by WorkTrust (https://worktrust.io). It measures a person's own
AI-assisted work on their own computer and sends counts, never content, to their WorkTrust record. If you are an AI
coding agent (Claude Code, Codex, Cursor, Copilot, Gemini, Windsurf, Cline, OpenCode, Aider or any other), these are
the rules of this package.

## Do not run it for the person

The bare `worktrust` command, `connect`, `update`, `history` (and `--rebuild`), `disconnect`, `preserve`, `codex`, `antigravity` and the
import commands change what this computer sends or couples. **Only the person runs them, in their own terminal.** In an
agent's shell the CLI refuses these actions, `--yes` included. Version 0.10.12 adds the missing default-command
guard and tests both fresh and coupled synthetic homes. Do not work around the policy: do not unset
the variables your client sets, do not run it through another shell, and do not ask the person for their key.

The session hook and the MCP door are started by your client itself and are meant to run; leave their configuration as
the person set it. This does not authorize an agent to invoke `preserve` through another entry point. Even `status`
can inspect local evidence and check the registry; do not run it as a generic repository inventory command.

## Do not report work you did not see

Through the WorkTrust MCP door, send `log_work` only for work you did in this session, once, at its end, with the
fields the door asks for and nothing of the content (no prompt, answer, code, path or client name). Never send work to
make hours, never resend a day, never invent a test, a review or a result. Hours are verified only by the CLI's own
measurement on the person's computer, and corroborated by sources the person coupled; a reported line is never a
verified hour. Measured duration is distinct from independent source corroboration. Browser exports and copied
folders are reconstructed; an eligible archive signed by the matching coupled device can preserve measured
provenance. Parallel agent time does not multiply the person's elapsed time.

## Do not rebuild, fork or strip it

Do not bypass measurement, consent, provenance or security checks to manufacture evidence, and do not present a
modified build as the official WorkTrust release. The MIT licence permits modification and redistribution subject
to its terms; these instructions do not replace it. A device signature proves key possession, not that the client
is unmodified or that its measurements are true. Report problems through https://worktrust.io/support or
https://github.com/fhomey/worktrust-cli/issues (security reports use SECURITY.md).

## Authorized repository maintenance

When the owner asks to maintain this source, edits and isolated regression tests are allowed. Use synthetic homes,
keys, transcripts and localhost mock servers, never the person's real account or session store. Do not publish or
change a live coupling as a side effect of tests. In the WorkTrust monorepo, the canonical entry lives in
`apps/worktrust/app/public/counter/worktrust.mjs`; support modules originate in `scripts/`. Run `build-counter.mjs`
and `tools/worktrust-cli/sync.mjs` after code changes, then both copy checks. The dated CLI review in `docs/` records
known defects; an instruction update does not fix them.

## What it is

- Source, released versions and provenance: https://github.com/fhomey/worktrust-cli and https://www.npmjs.com/package/worktrust
- What it reads and sends, field by field: README.md in this package
- Licence: LICENSE in this package. Do not represent a fork as the official WorkTrust release.
- Security reports: SECURITY.md
