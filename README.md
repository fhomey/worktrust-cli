# worktrust

Couple a computer to [WorkTrust](https://worktrust.io) in one command. WorkTrust keeps a verified
record of the work you do with AI without anyone reading that work: it receives metadata only.

```
npx worktrust@latest
```

**The only official package** is `worktrust`, published by the npm account **worktrustio** with
provenance from this repository (github.com/fhomey/worktrust-cli). Check it on npmjs.com before you run
it; a package of another name or from another publisher is not ours. Without npm, the same script runs
from WorkTrust's own site:

```
curl -fsSO https://app.worktrust.io/counter/worktrust.mjs && node worktrust.mjs
```

**No account? Keep your history anyway.** Claude Code and Gemini CLI delete their sessions after 30
days by default, and a deleted session can never be measured again. `npx worktrust@latest preserve` shows what
each AI app on this computer keeps, keeps it longer on your yes, and writes a local, metadata-only
record. It needs no account and opens no network connection: it stays on this computer until you
yourself run a command that sends. See [Keep your history](#keep-your-history).

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
4. **Earlier work only if you say yes.** It counts your AI apps' sessions already on
   this computer and asks `Send these as history? [y/N]`. Enter sends nothing. What goes is hours
   and tokens per day, never text, and WorkTrust shows it as earlier work, never as verified hours.
   Nothing from before the coupling is ever sent without that yes: the session hook starts at the
   moment of coupling. Beside the seconds, each day says what they were (the model answering, tools
   running, your own turns, pauses) and what the session's subagents did on their own clocks, as
   counts; a subagent's hour is shown as an agent-hour and never as one of yours.
5. **Codex only if you say yes.** With Codex on this computer it asks `Let Codex wake the session
   hook? [y/N]` and, on a yes, sets the one `notify` line in `~/.codex/config.toml` (the file is
   kept as `config.toml.worktrust-backup` first). Another program's `notify` is never replaced.
6. **Antigravity only if you say yes.** With Google Antigravity on this computer it asks `Let
   Antigravity wake the session hook? [y/N]` and, on a yes, adds one hook named `worktrust` with a
   single `Stop` command to `~/.gemini/config/hooks.json` (kept as `hooks.json.worktrust-backup`
   first). Other hooks in that file stay as they are. Antigravity records no token counts, so its
   sessions arrive with durations and turn counts only.
7. **Hermes Agent with the other apps.** With Hermes on this computer (`~/.hermes`, and every profile
   under `~/.hermes/profiles`) its `config.yaml` gets the WorkTrust entry under `mcp_servers` and one
   `on_session_end` hook that wakes the session hook; Hermes itself asks once before it runs a new
   hook. A file that writes those sections inline is left as it is. The session hook reads Hermes's
   own `state.db`: clocks, roles, the model and the session's token totals, never a message. A chat
   app (Telegram, WhatsApp, Slack …) is sent as work steered from elsewhere; a subagent's, a
   scheduled job's or a board task's session is not counted. Needs Node 22.5 or newer.
8. **Goose, OpenCode and OpenClaw the same way.** Goose gets the entry under `extensions` in
   `~/.config/goose/config.yaml` and one plugin folder, `~/.agents/plugins/worktrust`, whose
   SessionEnd hook wakes the session hook. OpenCode gets it under `mcp` in
   `~/.config/opencode/opencode.json` (a file with comments is left as it is) and one plugin file,
   `plugin/worktrust.js`, that wakes the session hook when a session goes idle. OpenClaw is coupled
   through its own `openclaw mcp set` (and `openclaw mcp unset` on disconnect); without that command
   on this computer it is printed for you to run. Each is read from its own session database, the
   same way as Hermes: clocks, roles, models and token counts, never a message. OpenClaw's Talk
   sessions are sent as voice, its chat-app sessions as remote; subagents and scheduled runs are
   not counted.
9. **Cursor and GitHub Copilot in VS Code, read in place.** Cursor's chats are read from its own database
   (`User/globalStorage/state.vscdb`), each message's type, clock, model and token counts through SQLite's own
   `json_extract`, never the text. Copilot's are read from VS Code's `chatSessions` files: each request's two clocks
   (asked, answered), its model and its token counts; the messages and responses are parsed with the file and never
   kept or sent. Neither app runs a hook WorkTrust can give it, so the WorkTrust door, which both start when they
   open, starts the session hook in the background, at most once an hour.

```
npx worktrust@latest history       send this computer's earlier sessions later (asks first)
npx worktrust@latest history --rebuild   re-measure them with the current rules; WorkTrust replaces this computer's
                                   earlier lines day by day, never counting a day twice (shows the plan, asks first)
npx worktrust codex         let Codex wake the session hook (asks first)
npx worktrust antigravity   let Antigravity wake the session hook (asks first)
npx worktrust@latest status        what is coupled here
npx worktrust@latest disconnect    take it out again (shows the plan, asks first)
```

## Keep your history

**Why.** Your AI apps decide how long your history lives, and several delete it on their own schedule:

| App | Kept by default | `preserve --apply` |
|---|---|---|
| Claude Code | 30 days, then deleted without notice | sets `cleanupPeriodDays` to 3650 |
| Gemini CLI | 30 days | turns `general.sessionRetention` off |
| Hermes Agent | 90 days after a session ended | prints the line to add (`sessions.auto_prune: false`) |
| Codex CLI | no deletion documented | nothing to change |
| Cursor, Copilot Chat, OpenCode, Goose, LM Studio | not documented | left alone |

(From each vendor's own documentation, checked 6 October 2026. Copilot Chat also syncs its sessions
to GitHub by default: `chat.sessionSync.enabled`.) A deleted session is a day of work that can never
be shown again, by WorkTrust or by anyone.

**Local, and yours.** `preserve` works on this computer only. It needs no WorkTrust account and no
key, and it opens no network connection; `check-cli-package` refuses the package if `preserve.mjs` so
much as imports a network module. What it keeps stays here **until you yourself run a command that
sends**: `npx worktrust` to couple this computer, then `npx worktrust@latest history`, which shows what it
would send and asks `[y/N]` first. Without those two, nothing ever leaves.

```
npx worktrust@latest preserve                  every step: the report, then asks to keep the settings and a local archive
npx worktrust@latest preserve --apply          the settings step only: asks [y/N] per change, backs the file up first
npx worktrust@latest preserve --archive [dir]  a local record of the measured days (default ~/AI-Evidence)
npx worktrust@latest preserve --verify [dir]   check that record: was anything changed afterwards?
npx worktrust@latest preserve --summary [dir]  hours, tokens per model, cache share and parallel sessions, from that record
```

**Always the newest, from any terminal or agent.** Run it as `npx worktrust@latest …`: npx then asks npm for the
newest version every time, where a bare `npx worktrust` may reuse a copy npm cached earlier. Which terminal or AI
agent runs it makes no difference: `preserve` writes to your own user's places (the apps' settings files and
`~/AI-Evidence`), so every terminal and agent on this computer under your user reaches the same archive, and lines
from different versions sit side by side, each naming the version that measured it. Another user on the same computer
gets an archive of their own. A coupled computer's session hook runs from its own copy in `~/.worktrust` and changes
only with `npx worktrust@latest update`; the WorkTrust app says when a newer version is out.

**One command walks it all.** `npx worktrust@latest preserve` shows the report, asks `Keep these settings? [y/N]`
(then does what `--apply` does), asks `Keep a local archive in ~/AI-Evidence? [y/N]` (then does what `--archive`
does; an archive already there is simply added to), and with an archive prints its check and its summary. Enter is
No. Without a terminal, and without `--yes`, it changes nothing. The flags each do one step, for scripts.

**Later, into WorkTrust, if you want.** Because `--apply` keeps the apps' own session files, coupling
this computer months from now still finds them: `npx worktrust@latest history` measures them the same way the
live hook does, and they arrive as history, labelled as such, never as work WorkTrust watched happen.
The archive is a plain, documented format made for the same purpose; importing it directly is planned,
not built.

**What `--archive` keeps, per AI app per day.** The same measurement the session hook makes, and
nothing it does not:

| Field | What it is |
|---|---|
| `client` | the AI app (`claude`, `codex`, `cursor`, `copilot`, `hermes` …) |
| `day`, `started_at`, `ended_at` | the day, and when the measured stretch began and ended |
| `seconds` | measured time: every gap between stamped events up to five minutes |
| `model_seconds`, `tool_seconds`, `human_seconds`, `idle_seconds` | what those seconds were: the model answering, tools or an agent run, your own turns, and what a cap cut off |
| `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write` | token counts, when the app records them (one answer counted once, however many lines the app wrote it in) |
| `agent_runs`, `agent_seconds`, `agent_peak` | subagents: how many ran, their own time, the most open at once (never added to `seconds`) |
| `interrupts`, `steers` | how often you stopped the agent mid-answer, and how often your message arrived while it was still mid-task (counts, never the words) |
| `utc_offset` | your computer's offset from UTC when the stretch began, such as +02:00, so a working day reads in your own local time |
| `model` | the model's name as the app reported it |
| `kind`, `layer`, `layers` | the kind of work (built, changed, researched) and the area it touched (front end, back end, data …), as the session hook names them |
| `exchanges` | how many times you and the model took turns |
| `commits` | the hashes of commits made in the stretch, never a message: what ties AI time to work in the repository |
| `steered_from` | `remote` when the session ran over SSH |
| `duration_basis`, `token_basis`, `turn_basis` | how the seconds, tokens and turns were measured |
| `project` | a one-way hash of the project's name: which days belong together, never which project |
| `stretch_ref` | a hash of the session's id and the day, so a stretch is archived once |
| `device_id`, `profile_id` | which computer and which user profile on it, as one-way hashes (the machine's own id never appears) |
| `signals`, `analyzer_version` | the behaviour signals of that stretch as keys and counts from the local counter's rubric (framing, steering, verification, recovery), and the rubric's version; derived on this computer from your own turns, never a word of them (0.7.0) |
| `verification`, `delivery` | per kind of check run in the stretch (test, typecheck, lint, build, the project's gate, CI) how many ran and how many failed; per delivery step (commit, PR, push, deploy) how many succeeded, and whether a check had passed before the first; named from each command on this computer, never the command itself (0.7.1) |
| `recovery` | of the tool calls that failed in the stretch, how many a later call of the same kind recovered, the middle time that took, how many were retried unchanged and how many with a different approach; inputs compared on this computer by digest, never kept (0.7.2) |
| `delegation` | the longest and the middle chain of actions the agent took on its own between your turns (or your stopping it), and how often it stopped to ask you a question or to have a plan approved (0.7.3) |
| `context`, `routing` | how often the context was compacted and which context commands you used (compact, clear, resume, context, model, memory; never a command of your own), how many models answered and how often the model changed (0.7.4) |
| `steering` | the moments you stepped in while the agent worked (stopping it, or a message mid-task), how many changed what the agent did next, and how many were followed by a passing check (0.7.5) |
| `collector_version` | the CLI version that measured it |
| `seq`, `prev`, `hash` | the line's place, the hash of the line before it, and its own hash |

A value the app did not record is left out, never written as 0. Each day also gets a proof in
`proofs/<day>.json` (the day's line count, a root hash over its lines, and a signature with this
computer's device key when it is coupled), and `manifest.json` holds the count and the last hash, so a
removed line is caught. The manifest names the computer and profile too.

**Never kept:** a prompt, an answer, code, a file or its path, a branch, a commit message, a title,
terminal output, or anything typed. The text in your sessions is read only to find clocks, model names
and counts, exactly as the session hook reads it.

- **What `--apply` writes.** Only the settings in the table above, each on a typed `y`. The file is
  copied to `settings.json.worktrust-backup-<date>` first, every other setting stays as it was, and a
  value you set higher is never lowered. Hermes's YAML is never edited.
- **Today is archived tomorrow.** A day goes into the archive once it is over; a later run only adds
  lines and never rewrites one.
- **What `--summary` counts.** From the archive, after its chain checks out: per month the measured
  hours, the tokens per model and the share of input served from the cache (where tokens go, and so
  where they can be saved), and the days on which two or more sessions ran in one project at the same
  time, with the most open at once and their session time against the wall-clock time they covered.
- **The archive is yours** to keep, copy, back up or delete. The free kit on
  [worktrust.io/preserve](https://worktrust.io/preserve) is this package plus a guideline, for teams
  that want the same record without WorkTrust.

## Rebuild the history

A newer version of this command measures a session differently from an older one: what the seconds were (the model
answering, tools running, your own turns, pauses), your own turns rather than every message, tokens with the cache,
and more AI apps (Cursor, Copilot, Hermes, Goose, OpenCode, OpenClaw, Codex, Antigravity). Lines an earlier version
sent stand as they were measured then, and sending the sessions again would count those days twice: an old line
does not name its stretch, so WorkTrust cannot tell it from the one that arrives.

`npx worktrust@latest history --rebuild` re-measures every session still on this computer with the current rules and
sends them with one difference: WorkTrust **replaces** this computer's earlier lines, day by day.

- **What it does.** It shows the plan first: per AI app, the days and the measured hours it would send, and the first
  and last day. It asks once; Enter is No. `--dry-run` shows the plan and stops. Nothing is sent before a typed `y`.
  For every day and AI app it carries, WorkTrust withdraws this computer's earlier lines (sent by this key or by an
  earlier key of the same computer, live or as history), each with a correction row that says why, and then stores the
  re-measured lines. A line that arrives unchanged is kept as it is. A day is counted once, and the same rebuild sent
  twice changes nothing.
- **What it never does.** A replaced line is withdrawn and kept, never deleted: it stays in your record and the record shows
  each replacement; deleting your account still removes all of it. Never touched: another computer's lines, what a web
  connector (Claude or ChatGPT on the web) brought in, an AI app the batch does not carry, a day it does not carry, a line
  you made private, a line less than 48 hours old (the session hook's own window), and a line received in the last 12
  hours (the batches of one run never replace each other). It sends what `history` sends and nothing more: durations,
  token counts, model names, a layer keyword, counts; never text.
- **Only from this computer's own key.** A connector (an AI signed in on the web) cannot ask for a rebuild; WorkTrust
  refuses it at the door.
- **Offered once by `update`.** When this computer's earlier lines were made by an earlier version (the copy in
  `~/.worktrust` says which), `npx worktrust@latest update` says so in plain words and offers the rebuild; Enter is No,
  and the same version updated again offers nothing. The command cannot read your record, so it is an offer, not a
  finding.

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
| **Reads** | Which AI apps are installed (the settings folders of Claude Code, Codex, Cursor, Gemini CLI, Antigravity, VS Code, Windsurf, Hermes Agent, Goose, OpenCode, OpenClaw), and the chats Cursor and Copilot keep (clocks, models and token counts only). Afterwards, the session hook reads Claude Code's, Codex's and Antigravity's session files, the session databases of Hermes, Goose, OpenCode and OpenClaw, and the chats Cursor and Copilot keep, on this computer to measure durations and token counts. |
| **Writes** | The key file (above). In each AI app's MCP settings (`~/.claude.json` through `claude mcp`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.gemini/config/mcp_config.json` (Antigravity), VS Code's `mcp.json`, Windsurf's `mcp_config.json`, Hermes's and Goose's `config.yaml`, OpenCode's `opencode.json`, OpenClaw through `openclaw mcp set`) a WorkTrust entry that runs the local bridge, with no key in it; three hooks in `~/.claude/settings.json`; the bridge, the hook and the counter in `~/.worktrust/`. |
| **Sends, to pair** | This computer's system (macOS, Windows, Linux) and host name. WorkTrust also records the network address the request arrives from, as a security record kept 90 days and seen only by WorkTrust staff (to answer a theft or fraud report). |
| **Sends, afterwards** | Per measured stretch of work, and nothing else: its durations (`seconds`, `duration_basis`, `model_seconds`, `tool_seconds`, `human_seconds`, `idle_seconds`), token counts (`tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`, `token_basis`), the model's name (`model`), the kind of work and one layer keyword such as frontend or backend (`title`, `kind`, `layer`, `layers`), counts of how you work (`exchanges`, `turn_basis`, `agent_runs`, `agent_seconds`, `agent_peak`, `interrupts`, `steers`), when it began and ended and your computer's offset from UTC (`started_at`, `at`, `utc_offset`), a hash of the session and the day (`stretch_ref`), `steered_from` when it ran over SSH, and, so the work can be matched to GitHub, the repository as its remote's owner/name (`repo`) and the hashes of the commits made in the stretch (`commits`, never their messages). |
| **Never sends** | Prompts, answers, code, file names or paths, commit messages, branch names, or the name of your local folder (a repository is named only as its remote's owner/name, above). The door has no field for them and refuses a submission that carries them. |

## Why you can check it

- **No dependencies and no install scripts.** Plain files, readable
  in an afternoon: `worktrust.mjs` (this command), `setup-mcp.mjs` (writes the MCP entries),
  `log-session.mjs` (the session hook), `count-behaviour.mjs` (the local counter) and `preserve.mjs`
  (keep your history), with the readers they import.
- **Nothing is downloaded at run time.** Everything that runs is in the package. The counter is
  pinned: it is not replaced from the network; a new one comes with a new version of this package.
- **Provenance.** Every version is built and published from a public repository by GitHub Actions
  with npm provenance: the npm page links each version to the exact commit it was built from,
  signed through Sigstore. `npm audit signatures` checks it on your machine.
- **Read it before you run it:** `npm pack worktrust` downloads the package as a file without
  running anything.
- **The key** never appears on a command line a process list could show: it is written to its file
  and reaches the bridge and the hook only in their environment.

## A computer that is already coupled, or shared

- `npx worktrust@latest connect` on a computer that is already coupled says to which account (masked) and
  asks `Couple it again? [y/N]`. Enter and `--yes` mean No; `--replace` says yes in advance.
- The browser page that approves it shows, large, which WorkTrust account is signed in, with
  **Use another account**: the computer goes to whoever approves it there.
- Once the new key is in place, the old key is ended at WorkTrust (the request is signed by this
  computer's own device key). An AI app still open on the old key is refused and moves to the new one.
- When the new account is a different one, the old account sees a notice that its computer moved,
  with the computer's name and the moment, never the other account; no earlier work on this
  computer is offered to the new account, only work from the moment of coupling.
- `npx worktrust@latest status` shows the account this computer sends to.
- Different people on one computer with their own OS user each couple their own: everything lives
  in that user's home folder, and the accounts never meet.

## Undo

`npx worktrust@latest disconnect` removes the WorkTrust entries (Hermes's hook with them), the hook (and Codex's `notify` line and
Antigravity's `worktrust` hook when WorkTrust set them) and the key file, and empties
`~/.worktrust` but for one small note of which account it fed (masked), so that a later coupling by
another account offers none of this computer's earlier work.
Then revoke the key in WorkTrust: Sources → Devices → this computer → Revoke.

## Requirements

Node 18 or later. macOS, Linux or Windows.

Security reports: see [SECURITY.md](SECURITY.md).

## Licence

MIT, for this command-line tool only (see LICENSE). The WorkTrust service it couples to is not
open source.
