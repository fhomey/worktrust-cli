# worktrust

## 0.10.35: Gemini CLI read; every earlier line can name its AI app

Gemini CLI's sessions are read in place, as Copilot's are: the files Gemini CLI records itself under
`~/.gemini/tmp/<project>/chats/session-*.jsonl` (or an older `.json`), each message's role and clock, the model and
the token counts, and each tool call's name and status; the messages, the thoughts and the tool calls' arguments and
results are parsed with the file and never kept or sent. A subagent's session lies inside its parent's and is not
counted. The project folder is not read, so these lines name no repository. Their lines go as `gemini-cli`.

WorkTrust now records which AI app each line came from (Copilot in VS Code, Gemini CLI, Antigravity …), so its AI apps
table can give them their own rows. Lines measured before carry only their product ("Other apps"). The measure rules
go to 3: `update` offers the re-measure once, and it sends every day again; WorkTrust replaces only the lines of
"Other apps" and "App not recorded" that name no app, with the same counted seconds, and keeps every other line as it is.
`npx worktrust history --rebuild --force-days` does the same at any time: every day of every AI app, even the days
WorkTrust already holds unchanged (every app at once, so no day loses another app's line).

## 0.10.34: your own commits, measured on this computer (`npx worktrust git`)

GitHub shows an App that reads commits as "Read access to code", and has no narrower permission. `npx worktrust git`
reads your own commits HERE instead, with `git log`, only those whose author e-mail is yours (git's `user.email`, plus
any you add with `git emails add`), in the repositories your AI sessions ran in or that you add with `git add <folder>`.
It asks once, with the list; Enter and `--yes` are No, and a No is remembered. Each commit's file names are turned into
the same closed keys the GitHub sync makes (kinds of files, technologies, architecture and security markers, one-way
markers per folder and file) on this computer, and what is sent is counts, keys and markers: never a file name, a
message, code, the commit's id or the remote's address. A commit travels as an owner-keyed reference only WorkTrust's
side can match against what GitHub saw. `git list` shows what is offered and agreed, `git remove <folder>` reads nothing
more from it, `--dry-run` reads and sends nothing.

## 0.10.33: one line per autonomous process per day; a fair-use limit keeps the line

A finished headless or scheduled run (a run no person started) is no longer a line of its own. It waits on this
computer, in `~/.worktrust/process-days`, folded into its process's UTC day: a process is the AI app, how the session
was started, the timer's opaque reference when a timer started it, and the project folder, as a hash (`process_ref`),
never a name or a path. Once the day is over and quiet it goes as ONE line with how many runs it holds
(`process_runs`); the runs' timelines are joined at minute resolution, which keeps every counted second, with each
run's call outcomes, its turns' length buckets and its subagent runs kept in step (every turn and each minute's first
completed call stay). A run that
finishes after its day was sent becomes the day's next part, and once WorkTrust holds its parts it is merged into the
last one, which goes again whole. When WorkTrust answers a fair-use limit (429 with Retry-After) nothing is lost: the
line stays where it was and goes after the wait. What is measured is unchanged, so the measure rules stay 2 and no
re-measure is offered.

## 0.10.32: a re-measure sends only the days that changed; which subagents were active at once; each call's outcome

Before a re-measure sends anything, the CLI asks WorkTrust, once per AI app, which of this computer's days it holds as
current. The question carries nothing but the question (`import_history` with `rebuild` and `fingerprint`, no line).
The answer is the digest this computer sent with each such day, its own submission and never the record: no hours, no
lines, no figure. A day whose digest on this computer is the same is not sent, so a re-run with nothing new sends
nothing and says so; one changed day sends that day alone. If the answer is not one (an older WorkTrust, an error, no
network), every day is sent as before. The digest covers each line as it is sent, without the CLI's own version, so
an update that measures the same sends nothing. When WorkTrust names where the run waits, the command prints
`queued, position N, about M min`.

A Claude Code session's subagents (the transcripts Claude Code keeps in `<session>/subagents/`) now travel with the day's
stretch as `agents`: per run, by position only, its kind (`builtin`, `own` for an agent type of your own, `background`,
`fork`, read from the run's `.meta.json`), when it started in whole seconds from the stretch's start, the stretches of time
it was active (a gap over five minutes ends one) and how many of its tool steps failed and how many of those a later step
of the same kind recovered. Never a name, a prompt, a path, a tool or an id. At most 64 runs a stretch, 12 active stretches
a run and 256 in all; the longest are kept. WorkTrust counts a run only while the session it belongs to is steered by you
(within 8 hours of your last input), and shows how many agents were active at once beside the sessions at once; it is never
added to your hours.

Beside the timeline, each model answer's outcome travels as one character (`call_outcomes`: completed, failed or not
known), and in a run no person started (headless or scheduled) the length of each of your own turns as a bucket
(`input_lengths`: short, medium or long) and, when a timer started the run, its cadence word with an opaque reference
(`schedule_cadence`, `schedule_ref`). Never a word, a command, a path or the timer's name. WorkTrust credits Agentic Hours
only for calls recorded as completed.

The measure rules go to 2, so `update` offers a re-measure once, naming these changes.

The session hook no longer reads a Claude Code transcript from its first byte on every run. Beside each session's
watermark in `~/.worktrust/sessions.json` it keeps where its last read ended: the file's identity (device and inode), the
offset, a hash of eight 4 KB samples before it, the offset of the first message not yet sent, and what a full read would
know at that point (the session's working folder, how it was started, a subagent's first moment). That stays on this
computer and is never sent. The next run reads from the first unsent message, so a day that spans the offset is read
again from its start, and gives exactly what a full read gives. A file that was truncated, rewritten, replaced or
compacted, a new CLI version, other measure rules, or a state without positions is read whole, as before. A re-measure
(`history`, `history --rebuild`, the offer after an update) always reads everything. Measured: 1 MB appended to a 600 MB
transcript reads about 1 MB.

## 0.10.31: a re-measure is offered only when measuring changed

`update` offers to re-measure this computer's sessions only when the new version MEASURES differently from the one it
replaces: a different timeline, seconds, tokens, steering, session kinds or readers. A release that changes something
else (consent, coupling, words) offers nothing. The offer lists what changed, one line each. The CLI carries the
version of its measuring rules beside its own version and records it in `~/.worktrust/installed-release.json` and
`~/.worktrust/history.json`; an install from before 0.10.31, which did not record it, counts as measuring by 0.10.29's
rules, so 0.10.29 or 0.10.30 updated to 0.10.31 is offered nothing. A history sent completely by a version with the
same rules counts as done, so the bare `npx worktrust` does not offer it again either.

## 0.10.30: an update asks only what is new

`update` remembers what you said yes to. Each AI app's WorkTrust door, the session hook, Codex's `notify` line and
Antigravity's `Stop` hook that you agreed to are brought onto the new version without a question, each printed as
`✓ … refreshed (you agreed on <date>)`. Only the launcher's path changes; nothing else about what was agreed. A NEW AI
app, or a wake hook that is no longer there (you took it out), is shown in full and asked about; `--yes` leaves it as
it is and lists it as `skipped: new, run without --yes to decide`. A No drops the agreement, and `disconnect` deletes
the record. It is one small file, `~/.worktrust/consent.json` (see [SECURITY.md](SECURITY.md)). The first update that
keeps it counts the WorkTrust entries already on this computer as agreed, because only a yes ever wrote them.

The re-measure after a new version is one question, asked after its plan (the plan is counted on this computer and
sends nothing): `Send them (re-measured; …)? [y/N]`. Enter and `--yes` are No. `--rebuild` agrees in advance.

One line that updates a computer you coupled before, with no question at all:

```
npx -y worktrust@latest update --yes --rebuild
```

- `npx -y`: npm's own flag. It answers npm's `Ok to proceed?` before it downloads the package; WorkTrust never sees it.
- `worktrust@latest`: the newest published version, never a copy npm cached earlier.
- `update`: this computer onto that version, the same key, no new pairing.
- `--yes`: every question whose answer is Yes by default. Anything new stays as it is (skipped, and listed).
- `--rebuild`: yes in advance to re-measuring this computer's sessions with the new version's rules. WorkTrust
  replaces this computer's earlier lines for those days, each withdrawn and kept, never deleted. Leave it out to
  be asked.
- `--codex` and `--antigravity` say yes in advance to a NEW Codex or Antigravity wake hook as well.

## 0.10.29: history in calls WorkTrust takes; how each session was started

A history call carries at most 1.9 MB and 1.4 MB of timelines (WorkTrust takes 2 MB and 1.5 MB). A batch an earlier
version queued larger, or one WorkTrust answers with 413, is cut smaller in `~/.worktrust/history-outbox` and sent in
pieces, never again as it was; a re-measure's run is cut again whole, under a new run id. A run WorkTrust already holds
part of, or one line too large for any call, is let go and counted, and `npx worktrust@latest history` measures again.

Each line now says how its session was started, as the AI app recorded it: `interactive`, `headless` (`claude -p`, an
Agent SDK program, `codex exec`, a Codex subagent) or `scheduled` (a timer started it), beside its timeline. A session
the app said nothing about is left unsaid. WorkTrust counts a headless or scheduled session as Agent operations, never
as the person's hours. `--history --dry-run --summary` prints the planned batches and the session kinds, counts only.

## 0.10.28: an honest receipt for a re-measure

A re-measure that lands as new lines over lines WorkTrust had withdrawn (support's withdrawal of client-computed
figures, a rebuild) is said as new lines, never as "Nothing changed"; entries WorkTrust refused for carrying no
timeline are named. This CLI sends every session's timeline and no figure of its own since 0.10.20; WorkTrust times
every second itself under its own idle cap, so a locally changed constant changes nothing it counts.

## 0.10.27: history kept on the server

A re-measure (`worktrust history`) sends its batches as one run; WorkTrust keeps each batch it
receives and rebuilds the days itself once the run is whole, so no `--resume` is needed. A line
under no product name is replaced only where the new lines overlap it.

## 0.10.26: OS credential storage

Explicit `worktrust protect-key` migration: an OS-vault wrapping key protects the locally
encrypted coupling credentials. It does not attest that local activity is truthful. See
[credential protection](#credential-protection) before enabling it.

After an approved update, WorkTrust receives the running version without
an activity upload. Pending metadata batches can be resumed with `worktrust history --resume`,
even after an AI app removed the original session files. Review-held revisions need review;
reconnecting does not approve them. Keep archives for work that was never queued.

The server limits new personal registrations to five active device
identities. AI apps sharing one key share one slot; cloned keys share account upload capacity.
Retiring a device preserves earlier data. Existing accounts above the limit are preserved but
cannot add another identity. Version labels and device signatures are not independent evidence
of time or correctness. A CLI update does not automatically publish a passport.


Couple a computer to [WorkTrust](https://worktrust.io) in one command. WorkTrust keeps a verified
record of the work you do with AI without anyone reading that work: it receives metadata only.

```
npx worktrust@latest
```

**The official npm package** is `worktrust`, published by the npm account **worktrustio** with
provenance from this repository (github.com/fhomey/worktrust-cli). Check it on npmjs.com before you run
it; a package of another name or from another publisher is not ours. Use the complete package:
individual support scripts are no longer downloaded and executed during setup. The live 0.10.25
release includes signed startup checks; 0.10.21 does not include this guard.

**Python tool runners:** this repository also builds `worktrust` for `uvx` and `pipx` from the
same measurement modules. Native wheels (0.10.13+) include a pinned official Node runtime,
so that route needs no separate Node/npm installation. See the
[Python distribution](https://github.com/fhomey/worktrust-cli/tree/main/python) for supported
platforms and installation commands, and the official [PyPI project](https://pypi.org/project/worktrust/)
for published versions. npm and Python versions are checked together.

```sh
uvx worktrust@latest preserve
pipx run --no-cache worktrust preserve
```

Omit `preserve` to connect your computer. These runners install and invoke the same CLI;
they do not automatically instrument Python applications or measure different activity.

Connecting through the Python package installs the runtime and engine in an immutable directory
under `~/.worktrust/installations/`; client hooks use that persistent path, so clearing a tool-runner
cache does not break the coupling. Updates retain older installations for running clients.
Run `worktrust disconnect` before removing an installed Python tool if you also want to remove its
WorkTrust coupling. Disconnect removes the key and client wiring; it leaves runtime files in place.

**Agent observations (requires 0.10.14+):** the optional Python
`worktrust_cli.telemetry` SDK lets an application explicitly record parent/child runs, its own
token counters, token budgets, checks and security events in a local file. The shared engine
inspects it with `worktrust orchestration report --file agent-events.jsonl`, without uploading.
The private platform import is Sources → Agent teams when that platform change is deployed.
These are application reports, not human hours or independently verified outcomes. Installing
through npm, uvx or pipx alone does not instrument agents. See the Python README for the opt-in
SDK, fixed metadata fields, consent and local deletion. Install `worktrust>=0.10.14` in the
agent application's own Python environment to import the SDK; a uvx/pipx tool environment
is separate. Check the registry for availability: a GitHub release awaiting approval is not
a completed npm or PyPI publication.

**No account? Keep your history anyway.** Claude Code and Gemini CLI delete their sessions after 30
days by default, and a deleted session can never be measured again. `npx worktrust@latest preserve` shows what
each AI app on this computer keeps, keeps it longer on your yes, and writes a local, metadata-only
record. It needs no account and opens no network connection: it stays on this computer until you
yourself run a command that sends. See [Keep your history](#keep-your-history).


**For AI agents:** read [AGENTS.md](AGENTS.md). An agent does not run this CLI's commands for a person (they stop in an agent's shell), does not report work it did not see, and does not rebuild, fork or strip it.

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
10. **Gemini CLI, read in place (0.10.35).** Its sessions are the files Gemini CLI records under
   `~/.gemini/tmp/<project>/chats/`: each message's role and clock, the model, the token counts and each tool
   call's name and status, never a message, a thought or a tool's output. Subagent sessions are not counted.

```
npx worktrust@latest history       send this computer's earlier sessions later (asks first)
npx worktrust@latest history --rebuild   re-measure them with the current rules; WorkTrust replaces this computer's
                                   earlier lines day by day, never counting a day twice (shows the plan, asks first)
npx worktrust@latest history --from-archive [dir]   send what your local archive holds of sessions your AI apps
                                   already deleted, marked as from your archive: a day this computer's key signed as
                                   measured, every other day as reconstructed (shows the plan, asks first)
npx worktrust@latest history --export <path>   a ChatGPT or Claude data export (the zip, its folder, conversations.json, a conversations part or the manifest)
                                   as history: hours reconstructed from its clocks, never verified (shows the plan, asks first)
npx worktrust@latest history --from-folder <dir>   your own copy of an AI app's session folder (a backed-up ~/.claude/projects,
                                   ~/.codex/sessions): the days this computer's sessions lack, reconstructed (asks first)
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
| `project` | a one-way hash of the project's name, keyed with this computer's own secret (`~/.worktrust/archive-salt`, never in the archive) so a guessed name cannot be tested: which days belong together, never which project |
| `stretch_ref` | a hash of the session's id and the day, so a stretch is archived once |
| `device_id`, `profile_id` | which computer and which user profile on it, as one-way hashes (the machine's own id never appears) |
| `signals`, `analyzer_version` | the behaviour signals of that stretch as keys and counts from the local counter's rubric (framing, steering, verification, recovery), and the rubric's version; derived on this computer from your own turns, never a word of them (0.7.0) |
| `verification`, `delivery` | per kind of check run in the stretch (test, typecheck, lint, build, the project's gate, CI) how many ran and how many failed; per delivery step (commit, PR, push, deploy) how many succeeded, and whether a check had passed before the first; named from each command on this computer, never the command itself (0.7.1) |
| `recovery` | of the tool calls that failed in the stretch, how many a later call of the same kind recovered, the middle time that took, how many were retried unchanged and how many with a different approach; inputs compared on this computer by digest, never kept (0.7.2) |
| `delegation` | the longest and the middle chain of actions the agent took on its own between your turns (or your stopping it), and how often it stopped to ask you a question or to have a plan approved (0.7.3) |
| `context`, `routing` | how often the context was compacted and which context commands you used (compact, clear, resume, context, model, memory; never a command of your own), how many models answered and how often the model changed (0.7.4) |
| `steering` | the moments you stepped in while the agent worked (stopping it, or a message mid-task), how many changed what the agent did next, and how many were followed by a passing check (0.7.5) |
| `tools`, `complexity` | how many different tools the agent used, and the stretch's task complexity C1 to C5 by the rule complexity/1 (points for layers touched, tools, subagents, duration, a recovered failure, kinds of check and a delivery; the rule is in stretch-evidence.mjs), with its points and the rule's version (0.7.6) |
| `oversight`, `planning`, `changes` | how often you refused an action or a plan the agent proposed, and how often a guard (the client's safety layer) refused one; how often the agent wrote its to-do list, the most items, and of the last list how many were done (never what they say); how many files the stretch's commits changed and how many of them tests (never a path) (0.8.1) |
| `supplements` | a supplement line: when a newer CLI measures more of a stretch already archived, the new fields go into a line of their own that names that stretch; nothing earlier is rewritten, and the chain and the day's root cover it (0.8.2) |
| `evidence` (sent) | the same derived record now also travels with each stretch to WorkTrust, kinds and counts only, and `npx worktrust status` shows what this computer measured in the last thirty days (0.8.3) |
| `unconfirmed` | checks the stretch ran whose outcome no reader could see (Codex's code mode prints no exit code; a background terminal), per kind: counted, never as a pass (0.8.5) |
| `autonomy`, `authorship` | the permission mode the AI app ran in, on one scale (ask, edits, plan, auto, full), how often it changed and the turns in plan mode; of the stretch's commits, how many name an AI as co-author (the trailer is read here, its names never leave) (0.8.7) |
| `framing`, `quality`, `risk`, `tool_mix`, `reads`, `context_files` | how the work was framed (your turns before the agent's first action, a plan first or not), checked (a check passing after the last change, the failures before a check passed, the change looked at before delivery; security scans count as checks), risked (destructive commands proposed, refused, run), which kinds of tools were used, files read again unchanged, and which of the AI app's own context files (instructions, skills, agents, commands, settings, MCP) the commits changed; kinds and counts only (0.8.8) |
| `quality.change_blocks`, `checked_blocks`, `rework_cycles`, `stage` | how many change blocks (edits with no check between them) a check followed, how often a failed check was followed by another change before it ran again (rework), and the furthest step the stretch reached here: attempted, verified, committed, pushed, pr, deployed; counts and one word only (0.8.9) |
| `timing` | how fast the stretch moved: seconds from your first turn to the first action and from the first change to the first check, the actions and seconds from a failure to the change that answered it, the calls from a failed check to it passing, and the calls back to work after a compaction; medians from the order and the clocks, never what was said (0.9.0) |
| `hygiene` | risk and hygiene: rollbacks, privileged commands (sudo, a forced push), hooks skipped (--no-verify), secrets touched (a .env printed, a private key read), destructive commands and how many a look or a check came before, the answer to a guard (retried, changed, stopped), and whether a check followed delivery; counts only, never the command or the path (0.9.1) |
| `route` | the route the work took: branches made, pushes straight to the default branch, and of the stretch's own commits those over twenty files, a fix that followed another, those naming an issue, and the changed CI, script and docs files; counts only, never a subject, a branch name or a path (0.9.2) |
| `adaptation` | evidence and adaptation: what the stretch read by kind (docs, tests, logs, config, source, the web), a plan written again after a failure, a model changed right after a failure, two or more agents whose work a check met, and outages (overloaded, rate-limited, timed out) and how many the work went on past; counts only, never a path or a message (0.9.3) |
| `reach` | the work's reach and its plan: commands on infrastructure (terraform, kubectl, helm, docker), data (psql, sqlite, bq, dbt) and cloud (aws, gcloud, az, supabase, vercel); plan or roadmap documents written and whether one came before the first code change; reviews approved, sent back or commented and issues opened or closed from the terminal; counts and one flag, never a command, a file name or a path (0.9.4) |
| `hygiene.secrets` | counts a secret touched only when a file that holds one (a .env, a private key, credentials.json, .aws/credentials) is shown or copied (cat, head, tail, base64, cp); a search for a word (grep, sed, awk) is no read (0.9.5) |
| `hygiene.secrets` | counts a secret shown only when a reader (cat, head, tail, base64, cp) takes the file as its own argument; a command that uses a .env and reads its output, and a template (.env.example), are no secret shown (0.9.6) |
| `outcomes` | outcomes of the steps: per kind of check whether its first run passed, delivery attempts that failed, a model change and a new plan after a failure each followed by a passing check; and a check whose output goes through a pipe is read from its output's words (an error fails, a pass passes, a silent type check or lint passes, anything else is unconfirmed), never from the pipe's exit code (0.9.8) |
| `retrieval` | retrieval and grounding: searches (grep, rg, find, Grep, Glob, a web search, an MCP search tool), the same search again, a search followed by a read or a change (found) or by another search (again), searches before the first change and right after a failure, and deliveries with docs, tests or a search since the last change (grounded); counts only, nothing searched is kept (0.9.9) |
| `window` | the context window, from the token counts the AI app writes beside each answer (input plus cached, once per message): the peak a turn carried, the turns over 100k, 200k and 500k, the growth from the first quarter of answers to the last, and compactions near the peak; counts only, nothing of what the context held (0.10.0) |
| `review` | reviewing the agent: reviews while it worked, the middle interval, subagent runs reviewed, and what a review led to (a change of course, a change, a check); counts only (0.10.1) |
| `live` | counted inside Claude Code by the WorkTrust mod, only when you turned it on (`worktrust mod install`, 0.10.15): permission questions put to you and how many you answered yes or no (not in auto mode, where a classifier answers), model requests per effort level, how many models answered and requests sent to another model, the highest context fill and plan-limit use as percentages, compactions you asked for or that ran by themselves, subagents started (built-in, your own, in the background, forks) and teammates, and how many other mods, MCP servers and own agent types were active; counts only, never a prompt, an answer, a command, a path or a name. From 0.10.16 a Codex session carries the same keys read from its own rollout, with nothing installed: each turn's effort level, the models, and the highest context fill and plan-limit use |
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

From **0.10.21**, changed measured history waits for review before it
can replace measurements already received for that computer, client and historical day.
The earlier receipt is retained as local activity, not independent proof of human effort.
Other computers and periods remain on the record, including an unavailable old laptop.
A support withdrawal is not reversed by reconnecting or running a rebuild.

Since 0.10.5 there is one path: `npx worktrust@latest history` always re-measures and replaces this computer's earlier
lines day by day. If a send did not finish, or you merged two keys of one computer, run `npx worktrust@latest` again:
it finishes what did not arrive and never counts a day twice.

A newer version of this command measures a session differently from an older one: what the seconds were (the model
answering, tools running, your own turns, pauses), your own turns rather than every message, tokens with the cache,
and more AI apps (Cursor, Copilot, Hermes, Goose, OpenCode, OpenClaw, Codex, Antigravity). Lines an earlier version
sent stand as they were measured then, and sending the sessions again would count those days twice: an old line
does not name its stretch, so WorkTrust cannot tell it from the one that arrives.

`npx worktrust@latest history --from-archive` (0.8.0) is for the sessions an AI app has already deleted (Claude
Code's default is 30 days). It sends what your local archive (`preserve --archive`) holds of them, and only that:
days of sessions no longer on the computer, each line marked as coming from your archive. One rule (2026-10-10):
a day signed by this computer's device key goes as it was measured; every other day (unsigned, signed by the local
archive key, or by another computer's key) goes as **reconstructed**, and the plan says how many of each. It refuses,
and sends nothing, when the archive does not verify or when WorkTrust does not yet accept the mark. It shows the plan
first and asks once; Enter is No. Such lines are history, like any import: never verified hours.

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
- **Offered once by `update`.** When this computer's earlier lines were measured by other rules (the copy in
  `~/.worktrust` says which; 0.10.31: the measuring rules, not the version), `npx worktrust@latest update` says so in
  plain words, lists what changed, shows the plan and asks once (0.10.30); Enter and `--yes` are No, `--rebuild`
  agrees in advance, and a version that measures as the one before offers nothing. The command cannot read your
  record, so it is an offer, not a finding.

## A web chat's data export

`npx worktrust@latest history --export <path>` (0.10.10) brings a ChatGPT data export (Settings → Data controls →
Export data) or a Claude data export (Settings → Privacy → Export data) onto your record as history, so years of
browser chats appear with their months, days and rhythm. The path is the zip the vendor sent you, the folder it was
unpacked into, or `conversations.json` itself; the vendor is told by the file's shape. Of the zip only
`conversations.json` is opened: the profile, memories and files beside it are never inflated. Claude on the web now
sends a manifest and one zip per category (0.10.17): give a `conversations-000.zip` part, the folder holding the
`conversations-*.zip` parts (read in part order), or the manifest json, which is read only for the file names of its
conversations parts lying beside it; its download links are never followed. The other parts (memories, projects,
artifacts, frames, design chats, the light metadata) are refused by name and never opened.

Any size (0.10.18): the file is read as a stream, a conversation at a time, so a gigabyte export reads in a bounded
memory; it keeps of each conversation only the clocks, roles, ids and a model name it needs (the counter, the text it
reads here). Bounds: a file to 64 GB, two million conversations, nesting to 64; a single conversation whose kept
fields pass 8 MB is left out and counted, never the export. A zip over 4 GB (zip64) is refused by name: unpack it and
give `conversations.json`. Every 64 MB a line on stderr says how many megabytes and conversations were read, nothing else.

- **What goes.** Per run of activity in a conversation (0.10.17; before, one line per conversation and day): a run
  ends where two messages lie more than thirty minutes apart, the gap after which the hook calls a stretch finished, so a
  conversation left open for hours is two windows, not one. Cutting changes the windows and never the total: the five
  minutes the clock counts after a message stay with the run before the gap. A day of one run keeps the name it had; a
  cut day replaces the one line an earlier send made of it. Each run: a neutral line (`A conversation in ChatGPT`, `A conversation in Claude on
  the web`), the seconds between the messages' clocks counted the way a measured day is (a pause over five minutes is
  not work; a day is cut at eight hours), your own turns as a count, the model's name where the export carries one, when
  it began and ended, and a stable name made of the conversation's id and the day, so the same export sent twice, or
  from two computers, is each line once. Never a title, never a message, never tokens (the export carries none and none
  are estimated).
- **What it counts as.** Hours **reconstructed**, shown on your record with their origin and never in your verified
  hours: an export file can be edited before it is read, and no device key witnessed those hours. WorkTrust holds this
  at the door and in the database, whatever the sender claims.
- **How it asks.** The plan first (the product, conversations, days, reconstructed hours, first and last month), then
  one question; Enter is No; `--dry-run` shows the plan and stops. On a coupled computer the bare `npx worktrust` looks
  in your Downloads folder (its top level only) for such an export it has not sent, offers it the same way, once, and
  remembers your answer by the file's digest, never by a conversation.
- **The export replaces.** On the days the export covers, its lines count and the earlier lines of that product your
  connector of the same vendor reported (an AI signed in on the web, which selects what it reports) are withdrawn and
  kept, each with a correction row, so a day counts once; the command says how many. A connector line that arrives later
  for a day the export covers is held. Lines that connector reported earlier under no product may describe the same
  conversations: the command says how many lie on those days and asks once, `Also withdraw N earlier lines your Claude
  connector reported for these days?`; Enter is No, `--yes` keeps No, `--dry-run` sends nothing, and only a typed yes or
  `--withdraw-unknown` said in advance withdraws exactly those lines on exactly those days, the same way, never deleting.
  The count in the question is the door's own, and it is the count the yes withdraws. Never touched, whatever you answer
  (0.10.19, held on the server): any line a computer of yours wrote (measured sessions, a rebuilt or archived history, an
  earlier export send), a measured line, a connector of another vendor, another product, a private line, a day the export
  does not cover.

## A copied session folder, and the local archive key

**One rule (2026-10-10).** Verified hours are what this computer's coupled key witnessed: the live session hook, the
AI apps' own folders read at history time, and an archive day signed by this computer's device key. Everything else
that carries clocks is **reconstructed**: shown on your record with its origin, never in your verified hours.

`npx worktrust@latest history --from-folder <dir>` brings in your own copy of an AI app's session folder: a backed-up
`~/.claude/projects`, `~/.codex/sessions`, or an Antigravity brain folder. It is read with the same readers and the
same clock as the live folders, never the live folders themselves (a path that is, or holds, one of them is refused).
Each day is named exactly as the live folder would name it, so a stretch this computer's own sessions already hold is
skipped (they win), and the same copy sent twice is each line once. What travels: the copy's own counts (tokens, your
turns, the model, the evidence kinds), as reconstructed hours, titled as from a copied session folder; not the hours in
layers, which say what a measured day's seconds were. The plan first, one question, Enter is No; `--dry-run` sends
nothing.

`preserve --archive` on a computer that is not coupled now signs each day's root with a **local archive key**
(`~/.worktrust/archive-key.json`, only you can read it), made once and said in one line. It needs no account and no
network and never leaves this computer. It is continuity, not proof of time: a day it signed can be told from an edit,
and the chain stays one computer's when you couple later (the device key then signs new days, and either key may seal
a day it sealed before), but such a day reaches WorkTrust as reconstructed. It is never offered as the device key at
pairing: `connect` always mints a fresh pair, because a private key that lived on disk before the pairing would weaken
the proof of possession the pairing binds, for nothing your record would gain.

## Credential protection

Existing installations keep private file storage until the person opts in. From 0.10.26,
run `worktrust update`, quit the AI apps, then run `worktrust protect-key` and restart
those apps. A new computer can run `worktrust protect-key` before connecting. `worktrust status`
shows the storage mode. This command is local and does not publish or change a Passport.

Protected mode encrypts the token, pending renewal token, device private key and coupling metadata
with AES-256-GCM in `~/.worktrust/key.json`. Its random encryption key lives in macOS Keychain,
Windows Credential Manager, or Linux Secret Service (`/usr/bin/secret-tool` from libsecret-tools,
with a running, unlocked desktop secret service). No keychain reset is performed. First-time
protection may require OS approval; background reads never request an unlock prompt. An unavailable
vault stops uploads without advancing their checkpoints. There is no plaintext fallback.

Migration verifies the vault write before atomically replacing the old file. No plaintext backup
is created. Existing backups and already running processes can still hold the old secrets; this
is not secure erasure of an SSD or revocation of previously copied credentials. The local archive's
separate continuity key (`archive-key.json`) is not migrated by this command. `preserve` remains
offline and refuses to silently change signing identity when protected credentials are unavailable.

- **AI apps use the bridge.** The bridge and hooks read the protected credentials as the OS user;
  their settings contain a launcher command, not the credentials. Update every installed bridge
  first: older releases cannot read the encrypted format. Protected mode refuses `--direct`.
- **A device signature proves possession.** The server stores the public key and checks fresh
  signed requests and single-use nonces. Neither file encryption nor an OS vault proves genuine
  local activity. Software authorized as the same OS user may still obtain or use these secrets.
  This is not a hardware-bound, non-exportable key. Revoke the connection if it may be compromised.
- **The key renews itself every week.** A new secret is made here, only its hash is sent, signed,
  and last week's key stops working.
- `npx worktrust --direct` writes a plain key into the apps' settings instead, for an app
  that cannot run a local command. Such a key is not bound to the computer and does not renew.

## What it reads, writes and sends

From **0.10.21**, before each submission the hook keeps a local
metadata file in `~/.worktrust/measurements/`. The `worktrust-measurement/1` format retains
the available timeline, opaque stretch reference, dates, counts and collector identifiers.
It omits prompts, answers, titles, repository names, file paths, endpoint URLs and credentials.
Files request mode 0600 in a mode-0700 directory; Windows ACLs need their own validation.
Retries retain the same metadata once; changed measurements get a separate file. Disconnecting
does not erase this journal. You control its retention and backups; it is not a remote backup.
Keep the regular `preserve --archive` archive too if your AI app removes its session files.
Metadata cannot reconstruct deleted conversation text or observations it never recorded.

A successful HTTP response alone does not advance progress. The hook requires an explicit
receipt; JSON-RPC errors, tool errors, incomplete receipts and partially refused batches are
retried safely. A row kept pending on WorkTrust remains excluded from counted activity.

| | |
|---|---|
| **Reads** | Which AI apps are installed (the settings folders of Claude Code, Codex, Cursor, Gemini CLI, Antigravity, VS Code, Windsurf, Hermes Agent, Goose, OpenCode, OpenClaw), and the chats Cursor and Copilot keep (clocks, models and token counts only). Afterwards, the session hook reads Claude Code's, Codex's and Antigravity's session files, the session databases of Hermes, Goose, OpenCode and OpenClaw, and the chats Cursor and Copilot keep, on this computer to measure durations and token counts. |
| **Writes** | The key file (above). In each AI app's MCP settings (`~/.claude.json` through `claude mcp`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.gemini/config/mcp_config.json` (Antigravity), VS Code's `mcp.json`, Windsurf's `mcp_config.json`, Hermes's and Goose's `config.yaml`, OpenCode's `opencode.json`, OpenClaw through `openclaw mcp set`) a WorkTrust entry that runs the local bridge, with no key in it; four hooks in `~/.claude/settings.json` (SessionStart, SessionEnd, PreCompact and, since 0.10.32, Stop, which sweeps at most once an hour); the bridge, the hook and the counter in `~/.worktrust/`; and `~/.worktrust/consent.json`, what you agreed to (names and days only, 0.10.30). |
| **Sends, to pair** | This computer's system (macOS, Windows, Linux) and host name. WorkTrust also records the network address the request arrives from, as a security record kept 90 days and seen only by WorkTrust staff (to answer a theft or fraud report). |
| **Sends, afterwards** | Per measured stretch of work, and nothing else: its timeline and basis (`timeline`, `duration_basis`: since 0.10.20 the CLI sends no duration and no hours in layers of its own; WorkTrust computes them from the timeline), token counts (`tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`, `token_basis`), the model's name (`model`), the kind of work and one layer keyword such as frontend or backend (`title`, `kind`, `layer`, `layers`), closed technology keys (`stack`) and separate display-only tool keys (`tools_seen`), how the turns are counted (`turn_basis`; the counts themselves WorkTrust reads from the timeline), the subagent runs that started in the stretch, by position only (`agents`, since 0.10.32: per run its kind, builtin, own, background or fork, its start and active intervals in whole seconds from the stretch's start, and its tool failures and recoveries as counts; never a name, a prompt, a path or an id; at most 64 runs, 12 intervals a run, 256 in all), when it began and ended and your computer's offset from UTC (`started_at`, `at`, `utc_offset`), what the CLI derived from the stretch as kinds and counts (`evidence`: checks run and failed, delivery steps and whether a check passed first, recoveries, delegation, context, routing, steering, refusals, planning, files and test files changed, the complexity class; with the WorkTrust mod on, its `live` counts from inside Claude Code: permission answers, effort levels, context and plan-limit peaks, subagents and setup; never a word, a command or a path; since 0.8.3, `live` since 0.10.15), a hash of the session and the day (`stretch_ref`), `steered_from` when it ran over SSH, the stretch's clock as step kinds and whole seconds so WorkTrust computes the figures itself (`timeline`, since 0.10.20: never a word, a tool name or a path), how the session was started as the AI app recorded it, beside the timeline (`session_kind`: interactive, headless or scheduled, since 0.10.29; left out when the app did not say), each model answer's outcome as one character, completed, failed or not known (`call_outcomes`, since 0.10.32), and in a run no person started the length of each of your turns as a bucket (`input_lengths`) and a timer's cadence word with an opaque reference (`schedule_cadence`, `schedule_ref`), the CLI's version and a digest of its own files as signals (`cli_version`, `cli_digest`), and, so the work can be matched to GitHub, the repository as its remote's owner/name (`repo`, only for a repository on GitHub, GitLab or Bitbucket, the hosts WorkTrust can couple; never one on your own or a client's server), for any other git repository a code in its place (`repo_code`: 16 hex of an HMAC of its remote, or its root, keyed with this computer's own secret in `~/.worktrust/archive-salt`, which is never sent, so WorkTrust can group its lines but cannot tell which repository it is) and the hashes of the commits made in the stretch (`commits`, never their messages). With a re-measure (0.10.32), each batch also carries a digest of each day it holds as this computer computed it (`days`: a date and 64 hex, never a line), the question before it asks only for the digests this computer sent before, and a count of transcripts this computer could not read rides beside that question (`unreadable`: a number, never which file). |
| **Never sends** | Prompts, answers, code, file names or paths, commit messages, branch names, or the name of your local folder (a repository is named only as its remote's owner/name, above). The door has no field for them and refuses a submission that carries them. |

**The clock is WorkTrust's, not this computer's (0.10.20).** A measured stretch travels as its timeline: one step per
transcript line, as a kind (your turn, the model's answer, a tool call, a tool's result, a question that waited for you, an
interruption) and the whole seconds since the previous step. Nothing of a message is in it: no word, no tool name, no path.
This CLI computes no duration and no hours of its own and carries no rule for doing so; WorkTrust computes the seconds, the
hours in layers and the turns from the timeline when it arrives, and the figures the terminal shows after a send are
WorkTrust's receipt. The line also names the CLI's version and a digest of its own files, as signals of which code ran,
never as proof.

## Why you can check it

- **No npm dependencies and no install scripts.** Plain files, readable
  in an afternoon: `worktrust.mjs` (this command), `setup-mcp.mjs` (writes the MCP entries),
  `log-session.mjs` (the session hook), `count-behaviour.mjs` (the local counter) and `preserve.mjs`
  (keep your history), with the readers they import.
- **Bundled measurement modules.** The npm package includes its counter and readers. Interactive
  commands can check the registry for a version notice; they no longer execute another npm
  version automatically. Installation stays with the selected package manager. See SECURITY.md.
- **Provenance.** The release workflow requests npm provenance from the public source repository.
  Verify the actual version's attestation and contents before relying on that origin; the manifest
  setting alone does not establish it. `npm audit signatures` checks an installed dependency tree.
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
Antigravity's `worktrust` hook when WorkTrust set them), the credentials, installed bridge scripts and the record of
what you agreed to (`~/.worktrust/consent.json`, 0.10.30).
Protected mode retains an encrypted empty slot and its OS wrapping key so reconnecting stays protected.
A small note of the previous account (masked) remains so that a later coupling by another account
does not offer its earlier work. Other retained files and your local evidence archive are not an
automatic server or archive erasure.
Then revoke the key in WorkTrust: Sources → Devices → this computer → Revoke.

## Requirements

Node 18 or later for the base CLI. SQLite session readers require Node 22.5 or later with `node:sqlite`;
without it, those clients are not read. macOS, Linux or Windows; available readers depend on the local client format.

See [SECURITY.md](SECURITY.md) for the credential-file threat model, network/update behaviour and known
trust limits. A local signature proves possession of a key, not independent observation of the work.

Security reports: see [SECURITY.md](SECURITY.md).

## Licence

Use is allowed under the WorkTrust CLI Licence; copying, modifying or redistributing the code is not. See LICENSE.
The licence is free of charge. `preserve` (with `--apply`, `--archive`, `--verify` and `--summary`) is for everyone,
with or without an account; every other feature is for WorkTrust account holders, and without an account the rest may
only be installed and evaluated. The archives and files the CLI makes from your own data are yours.
From 0.10.18 on; versions up to and including 0.10.17 were published under the MIT licence and stay under it.

## Release signatures and the limits of verification

From 0.10.22, the official launcher verifies fixed release files through `worktrust-launch.mjs` before
starting the shared engine. Python uses the `pycryptodomex` library to verify its package and
bundled runtime before Node executes. Final npm/Python/source/preservation downloads are
covered by an Ed25519-signed `release-artifacts.json`, containing their SHA-256 values and the
source commit. Verify against the separately pinned publisher key, not a key supplied by the manifest.

The initial package-manager installation and host interpreter are trusted bootstrap boundaries.
A computer owner can alter or bypass a launcher; software signatures do not attest execution.

Local Claude records and other client activity are outside this release manifest. An official
CLI can read edited input. `cli_digest` remains client-reported diagnostic metadata and cannot
prove which program ran. SHA-256/SHA-512 are not encryption; HTTPS protects transport. Public
claim eligibility remains the server publication gate's responsibility.

Revoking a computer key stops new submissions, not the validity of every historical publication.
Passport withdrawal is a separate audited operation. Neither operation automatically erases the
person's prior data. Release signing keys, computer keys and passport signing keys are separate.

In 0.10.25, hooks and helper processes from the official launcher stay inside the checked
release. The old loose `~/.worktrust/count-behaviour.mjs` and individual-script download
fallbacks are no longer executed. Persistent Python hooks use the host Python to check the
copied Node runtime before starting it, even after the temporary uvx/pipx cache is removed.
Keep that host Python installed. Updating preserves credentials, pending uploads and archives;
it does not approve held history or publish a passport automatically.
