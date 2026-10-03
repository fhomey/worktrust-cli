# worktrust

Couple a computer to [WorkTrust](https://worktrust.io) in one command. WorkTrust keeps a verified
record of the work you do with AI without anyone reading that work: it receives metadata only.

```
npx worktrust
```

**The only official package** is `worktrust`, published by the npm account **worktrustio** with
provenance from this repository (github.com/fhomey/worktrust-cli). Check it on npmjs.com before you run
it; a package of another name or from another publisher is not ours. Without npm, the same script runs
from WorkTrust's own site:

```
curl -fsSO https://app.worktrust.io/counter/worktrust.mjs && node worktrust.mjs
```

## What happens

1. **A plan, then a question.** The command lists every AI app it found on this computer and the
   file each one gets changed, then asks `Continue? [Y/n]`. Nothing is written or sent before you
   answer. `--dry-run` shows the plan and stops.
2. **Approve this computer in your browser.** WorkTrust opens; you see this computer's name, its
   system and the AI apps that will get the WorkTrust door, and approve it, signed in with your own account and second factor. That decides which
   WorkTrust account the computer belongs to: the terminal never sees a password and cannot choose
   an account. Nothing is typed: the browser is sent back to this computer (127.0.0.1), where the
   terminal waits for one answer and exchanges it with a secret only it holds (PKCE). A link
   forwarded to someone else approves nothing they can collect.
   Without a browser (over SSH, or `--device`), the terminal shows a code that you type yourself at
   app.worktrust.io/connect/computer on another device.
3. **The terminal finishes by itself.** It keeps the key in its private file and gives every
   AI app here the WorkTrust door, then installs the session hook. Quit your AI apps and open them
   again.
4. **Earlier work only if you say yes.** It counts the Claude Code and Codex sessions already on
   this computer and asks `Send these as history? [y/N]`. Enter sends nothing. What goes is hours
   and tokens per day, never text, and WorkTrust shows it as earlier work, never as verified hours.

```
npx worktrust history       send this computer's earlier sessions later (asks first)
npx worktrust status        what is coupled here
npx worktrust disconnect    take it out again (shows the plan, asks first)
```

## Where the key lives, and why it only works here

The key is kept in **one file only you can read**: `~/.worktrust/key.json` (mode 600, in a folder of
mode 700). No keychain is touched: a keychain tool can offer to "reset" a keychain it cannot find,
which would delete every password on the computer, and many people rightly keep tools out of it.

- **No AI app holds the key.** Each runs a small local bridge, `node ~/.worktrust/worktrust.mjs mcp`,
  which reads the file and speaks to WorkTrust for it; the session hook runs through
  `worktrust.mjs hook` the same way. A config file you share, a dotfiles repository or a screenshot
  of an app's settings carries no key.
- **The key only works on this computer.** `connect` makes an Ed25519 key pair; WorkTrust keeps the
  public half, the private half stays in the key file. Every call is signed (method, path, time, a
  one-time nonce, the body's hash) and WorkTrust refuses a call through this key without a fresh
  signature. A key that leaks without the file, from a log, a proxy or a config, is worth nothing.
- **The key renews itself every week.** A new secret is made here, only its hash is sent, signed,
  and last week's key stops working.
- `npx worktrust --direct` writes a plain key into the apps' settings instead, for an app
  that cannot run a local command. Such a key is not bound to the computer and does not renew.

## What it reads, writes and sends

| | |
|---|---|
| **Reads** | Which AI apps are installed (the settings folders of Claude Code, Codex, Cursor, Gemini CLI, VS Code, Windsurf). Afterwards, the session hook reads Claude Code's and Codex's own session files on this computer to measure durations and token counts. |
| **Writes** | The key file (above). In each AI app's MCP settings (`~/.claude.json` through `claude mcp`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, VS Code's `mcp.json`, Windsurf's `mcp_config.json`) a WorkTrust entry that runs the local bridge, with no key in it; three hooks in `~/.claude/settings.json`; the bridge, the hook and the counter in `~/.worktrust/`. |
| **Sends, to pair** | This computer's system (macOS, Windows, Linux) and host name. Not its network address. |
| **Sends, afterwards** | Durations, token counts, model names, one layer keyword (frontend, backend …), counts of how you work. |
| **Never sends** | Prompts, answers, code, file names or paths, commit messages, branch or project names. The door has no field for them and refuses a submission that carries them. |

## Why you can check it

- **No dependencies and no install scripts.** Four plain files, about 2,600 lines in total, readable
  in an afternoon: `worktrust.mjs` (this command), `setup-mcp.mjs` (writes the MCP entries),
  `log-session.mjs` (the session hook) and `count-behaviour.mjs` (the local counter).
- **Nothing is downloaded at run time.** Everything that runs is in the package. The counter is
  pinned: it is not replaced from the network; a new one comes with a new version of this package.
- **Provenance.** Every version is built and published from a public repository by GitHub Actions
  with npm provenance: the npm page links each version to the exact commit it was built from,
  signed through Sigstore. `npm audit signatures` checks it on your machine.
- **Read it before you run it:** `npm pack worktrust` downloads the package as a file without
  running anything.
- **The key** never appears on a command line a process list could show: it is written to its file
  and reaches the bridge and the hook only in their environment.

## Undo

`npx worktrust disconnect` removes the WorkTrust entries, the hook and the key file, and empties
`~/.worktrust`.
Then revoke the key in WorkTrust: Sources → Devices → this computer → Revoke.

## Requirements

Node 18 or later. macOS, Linux or Windows.

Security reports: see [SECURITY.md](SECURITY.md).

## Licence

MIT, for this command-line tool only (see LICENSE). The WorkTrust service it couples to is not
open source.
