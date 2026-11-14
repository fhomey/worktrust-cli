# What changed in each version

The WorkTrust CLI, newest first. What the tool is and how to use it: [README.md](README.md).

## 0.11.8: the menu says more, stays in one place, and uses colour with meaning

**Update comes first, and says whether there is something to update.** The menu now opens on Update WorkTrust, then Check
this computer, then the rest as before. Beside its name the Update item says `0.11.7 → 0.11.8 available` when this
computer's hook and AI-app doors are behind the CLI you started, or `up to date (0.11.8)`. It is read again after every
command: the moment an update finishes, the version line and the item say the new state, without leaving the menu. When
a newer CLI is published than the one running, the header names the command that gets it: `npx -y worktrust@latest`.

**One sentence per item.** Every item, in every list, has one plain sentence under it saying what it does and what Enter
does, with the command it runs dimmed beside its name.

**The menu is drawn in one place.** Before, each arrow key and each return from a command left one more copy of the menu
in the terminal's scrollback. Now the menu is redrawn over itself, and its lines are taken away before a command speaks:
what stays above is the command, its output and how it ended, then `Press any key for the menu`, and the menu once below.
A resize redraws it once. A terminal without cursor addressing (`TERM=dumb`) gets no menu: the bare command runs as it
always did, as it does without a terminal.

**Colour with meaning, never colour alone.** A success line (✓, Done) is green, a warning (!) yellow, an error red (the
exit code is what it was), a title bold, a command or hint dim, and a spinner turns while something is read or sent.
Every line keeps its symbol and its words. Colours are off when the output is not a terminal (a pipe, a script, CI), when
`NO_COLOR` is set, with `--no-color`, and under `TERM=dumb`; `FORCE_COLOR=1` turns them on. The session hook and the MCP
door are read by programs and are never coloured, `FORCE_COLOR` included. With colours off, every byte is what it was.

**`npx -y worktrust`.** Before WorkTrust starts, npm itself may ask `Need to install the following packages … Ok to
proceed?`. That question is npm's; `-y` answers it in advance.

## 0.11.7: a menu, folders without typing, and agent modes you allow here

**A menu.** `npx worktrust` in your own terminal now opens a menu: move with the arrow keys, Enter opens, Esc or the left
arrow goes back, q quits, 1 to 9 jump. The first item, Check this computer, does what the bare command did before
(connect, or show what is connected). Every item shows the short command it runs, so you can type it next time. Without a
terminal (a script, a hook, the MCP door) nothing changes and nothing waits for a key; every command works as before.

**Remote Agent: approve with `remote app` or `remote web`.** `npx worktrust remote app` approves this computer with the
WorkTrust app (a QR code here), `npx worktrust remote web` in the browser. Each makes the computer's remote keys, asks you
first, sets up the service and shows the phone's QR code, with `--gateway` and `--device` as before. `remote enable` is
gone: it now says which two commands to use. While you approve, a bar under the QR code or link counts the request's
time down; when it runs out, Enter draws a new one. `npx worktrust remote connections` lists every phone and browser
linked to this computer, and `remote disconnect` closes one (or `--all`), each after a typed confirmation.

**Folders without typing.** In the menu, Remote Agent, Roots: tick the folders your projects live in (Desktop, Documents,
Developer, Projects, code, src, each with the number of projects found), make a new folder for projects, or choose any
folder with your system's folder picker. A phone can now open the projects that are already inside a root, not only make
new ones. The rules stay: never your home folder or above it, never a folder of secrets. On a Mac, a folder in Desktop,
Documents, Downloads or iCloud Drive makes macOS ask once, right away, whether the Remote Agent service may read it.

**Agent modes, with a ceiling you set here.** A phone may start Manual (asks for every change) and Plan, as before.
`npx worktrust remote modes allow edit` lets it start Edit automatically (Claude Code's acceptEdits), and
`remote modes allow auto` Claude Code's auto mode (which includes edit); `remote modes deny edit` takes both back. The
computer refuses any mode above what you allowed, whatever a phone sends. No push, no install, no deploy and no secret, in
every mode; in Edit and Auto the agent also cannot edit its own rules or the files that say what a test runs. Claude Code's
effort level and extra projects in one session (`--add-dir`) come along where your Claude Code offers them.

No measure change: the measure rules stay 4.

## 0.11.6: approve a computer with your phone

**Two roads to approve this computer for Remote Agent.** `npx worktrust remote app` shows the approval as a QR code in
the terminal, without opening a browser: scan it with the WorkTrust app, check the code and key, accept Remote Agent's
terms and approve with your authenticator code. `npx worktrust remote web` opens the approval page in your browser, as
before. (Until 0.11.7, `npx worktrust remote enable` asked which one you want.) A request lives ten minutes; the page and the app count
it down and tell you when to run the command again.

**A command the CLI does not know** now says so ("Unknown command: …") before the help, and ends with a failure code.

No measure change: the measure rules stay 4.

## 0.11.5: Remote Agent (the new name), and a link needs your authenticator

**Remote Agent.** What was called MOCHI is now called Remote Agent everywhere you read it: in this CLI's messages, in
Settings › Remote Agent on app.worktrust.io and on your phone, where its tab is Devs. Its terms moved to
worktrust.io/remote-agent-terms; the old address forwards there. Nothing it does changed.

**A link needs your authenticator.** Approving this computer on app.worktrust.io, and adding a new phone or browser, now
asks for a code from your authenticator app; an e-mailed code no longer does. A link stays with the account and the phone
that made it, and it ends when you remove that authenticator. A phone asked by code is still confirmed at this keyboard:
`npx worktrust remote phones confirm <fingerprint>`. What is measured for the passport is unchanged: the measure rules
stay 4.

## 0.11.4: local models measured, confidential client work, OpenCode in Remote Agent

**Local models, used directly.** The Ollama app's chats and Open WebUI's are now read like every other database client:
the model, the time of each turn and, for Open WebUI, the token counts it kept (the Ollama app keeps none, so none are
sent or estimated). Never a title, a message, a file or a prompt. A model used through OpenCode, Goose, Hermes or OpenClaw
was already measured with that client. Because these are days no earlier version measured, the measure rules become 4:
`npx worktrust update` on a computer measured by rules 3 offers the re-measure once and says why.

**Confidential client work.** `npx worktrust project confidential [folder]` marks a client's repository: its hours and
token counts still count, under one fixed marker, and no repository name, branch, remote, path, commit or app title
leaves the computer. Your passport names that share inside your verified hours as "Confidential client work".
`npx worktrust project exclude [folder]` leaves a folder out entirely, `project normal` undoes either, and `project list`
shows what you set. Only you change these at your keyboard; an agent's shell may only list them.

**OpenCode in Remote Agent.** Your phone can steer OpenCode on this computer, and through it a local model such as Qwen on
Ollama. Like Codex it is off by default: `npx worktrust remote opencode on` says what OpenCode can do without asking and
asks for a typed yes; `off` switches it off again. Its runs ask your phone before every command, edit and fetch, and a
remote-steered session never counts as your hours.

**The import window.** An AI app on this computer is shown the `import_history` tool only in the hour after you copy the
import prompt in Sources on app.worktrust.io, so it no longer costs every session the tool's description.
`npx worktrust history` is unchanged.

## 0.11.3: every device off this computer at once

`npx worktrust remote phones remove --all` disconnects every phone and browser from this computer in one act, after one
confirmation at the keyboard. The computer refuses them from their next message. Sessions they started keep running here:
stop them with `npx worktrust remote disable`, or pause everything with `npx worktrust remote pause`. To end their keys for
your whole account too, use Settings › Remote Agent on app.worktrust.io or Remote Agent settings on your phone. What is measured for the
passport is unchanged: remote-steered sessions never count as your hours, and the measure rules stay 3.

## 0.11.2: your phone adds a browser

A browser where you use app.worktrust.io can steer this computer's agents without a walk to its keyboard: the browser
shows a code, your phone scans it and asks Face ID, and this computer adds the browser only if you allowed it here once
(`npx worktrust remote phones allow-endorse on`, off by default), only for a browser of your own account, and only within
five minutes. The terminal says when a browser was added and `npx worktrust remote phones` lists which phone added it;
each one stays revocable. The Passport's issuer key stays pinned. What is measured for the passport is unchanged:
remote-steered sessions never count as your hours, and the measure rules stay 3.

## 0.11.1: terminal sessions, and the live preview you can touch

`npx worktrust remote terminal on` lets the phone start Claude Code in a terminal session on WorkTrust's own tmux socket
(off until you turn it on), which you can also join at the desk with `npx worktrust remote attach <id>`. The phone reads
the session's screen, is sent it when it changes while someone follows it, and answers a dialog the agent shows only
when the screen still looks the way it did when you read it. The local preview can now be live: the page itself, on the
phone, touchable, through this computer's own browser. Codex gets the same three planning tools as Claude Code. What is
measured for the passport is unchanged: remote-steered sessions never count as your hours, and the measure rules stay 3.

## 0.11.0: steer your own agents from your phone

`npx worktrust remote` pairs this computer with the WorkTrust app and lets the phone steer the coding agents that run
here (Claude Code and Codex): start a chat in a project, choose the agent and its model from the ones this computer
reports, send photos and files into the project's inbox (at most 25 MB a file), approve what the agent asks, and follow
its work. Everything between the phone and this computer is sealed end to end; the relay passes it without reading it.
The local agent plans its own work with three tools on its session (a release, its tasks, their state and estimate), so
the phone's Status shows one table of what runs, what waits ("after release 22") and what ended. A session reports its
active time, the background jobs an agent left running, and, inside a git worktree, the repository it belongs to. A
local preview renders a dev server you allowed, as desktop, tablet or phone, with this computer's own browser. A phone
app from before this version cannot read what 0.11.0 sends: update both. What is measured for the passport is unchanged:
remote-steered sessions never count as your hours, and the measure rules stay 3.

## 0.10.38: an export says what it can about its own clock

`npx worktrust history --export` now sends, beside each run's timeline, the facts WorkTrust checks to tell an edited
ChatGPT or Claude-on-the-web export from one as the vendor made it: every model slug of the run (`models`), how many kept
steps are dated more than ten minutes before the step they follow (`tree_inversions`), and, for a ChatGPT conversation
whose id carries a clock, how far its creation time sits from that clock (`id_skew`). Once per export batch it sends the
export's envelope: its kind (a zip, several zips, a folder or a bare file), the moment the vendor's zip name gives, the
first and last write time of its conversations entries, its last message, and whether its shape is the vendor's (no extra
field but zip64's, no data descriptor, no Finder litter, parts in order). Never a conversation's id, title or text, never
the archive's file name. A line whose clock does not hold up goes to Review with its reason named, never refused or
deleted; a re-zipped export alone is only a label. Lines that arrived from 0.10.37 or older are not judged again. One new
module, `export-facts.mjs`. What is measured is unchanged: the measure rules stay 3.

## 0.10.37: an export arrives whole; progress, Ctrl+C and the reason in WorkTrust's words; CLI active and updating itself

An export send no longer stops at WorkTrust's upload budget per minute: the person's own send waits it out (at most 90
seconds a wait) and goes on, and a batch WorkTrust stored in part is sent again at once until it holds every line; a line
already received is kept once. Every long step shows how far it is, and Ctrl+C stops cleanly, keeping what has not arrived
for the next run. A batch that did not arrive is said in WorkTrust's own words instead of "Not all of it arrived". The
receipt after an export names its hours as reconstructed by WorkTrust, beside the measured ones, never as measured.
CLI active per computer: a pause set in Sources › Devices is kept by the computer at its next session, and turning it back
on lets the computer update itself, verified (SECURITY.md, "Updating itself when you turn it on"). A computer on 0.10.36
or older updates once by hand: `npx worktrust@latest update`. What is measured is unchanged: the measure rules stay 3.

## 0.10.36: large and cut-off ChatGPT exports; hours only with `mcp off`; a re-measure reported whole or not at all

`npx worktrust history --export` now reads a ChatGPT export of any size: a zip64 archive (an export over 4 GB), and a
download that stopped part way, which is read up to the last whole `conversations-NNN.json` part and said as such ("The
archive was cut off after conversations-NNN.json; this is not the whole export"), so you decide whether to send what was
read before the cut. ChatGPT's loose `conversations-NNN.json` parts, a folder of them or one part beside its siblings, are
read as one export in part order; a missing part is refused by its name. An empty element in an export is counted and
left out instead of refusing the whole export. What is sent from an export is unchanged: hours and tokens per day, never
text. (The reader can also count an export's file kinds, searches and model switches between model families, but nothing
asks for them and nothing of them is sent.)

`npx worktrust mcp off` keeps the hours and takes the WorkTrust door out of every AI app here; `mcp on` puts it back (see
"Hours only, or also work lines" below). A choice made for this computer in Sources › Devices is done by the computer
at its next session. `update` no longer takes Codex's door out on every second run at the same version.

A re-measure says "Re-measured" only when WorkTrust holds every batch of the run; otherwise it says how many it holds and
gives WorkTrust's own reason for a refused batch, and the session hook exits with an error. What is measured is
unchanged, so the measure rules stay 3 and no re-measure is offered.

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
