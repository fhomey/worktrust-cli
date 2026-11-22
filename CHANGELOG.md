# What changed in each version

The WorkTrust CLI, newest first. What the tool is and how to use it: [README.md](README.md).

## 0.11.21: a spoken prompt from your phone with Siri, only if you say yes here

**Voice prompts, off until you turn them on at this keyboard.** `npx worktrust remote voice on` lets a phone you confirmed
here enrol a voice key and send a prompt you speak to Siri into the newest open session of a project you granted, also
while that phone is locked. It needs desk steering on first (`npx worktrust remote desk-steer on`, which needs read along),
and turning steering or read along off turns voice off too. `remote voice off` stops it; `remote voice remove [<fingerprint>]`
forgets the voice keys (of one phone when named); `remote voice status` lists them; `remote status` says it.

**A voice key can do almost nothing.** It is its own key, bound by WorkTrust to the phone it belongs to for seven days,
and this computer takes it only from that phone, only while voice is on here. It sends a prompt and nothing else: it
reads no session, no history and no answer, approves nothing, starts and stops nothing, and hears only whether its own
prompt arrived. Removing or revoking the phone takes its voice key with it.

**Every desk-steering rule, and more.** A spoken prompt goes through the same door as a typed one from the phone: your
keyboard's switch, the folder grant, the session's own permission mode (never a session that skips permission questions),
words only, one waiting per session. On top: it lives two minutes, one per 20 seconds and 30 a day per voice key, and a
prompt sent while the phone was locked only reaches a session in default or plan mode. The run terminal says each one:
"A spoken prompt from phone <fingerprint> went into <project>".

**Answers read aloud, behind two more switches.** `npx worktrust remote voice read on` (off until you say so here, and
again after voice was off) lets Siri read a reply to a phone whose own "Read answers aloud" is on, also while that phone
is locked: the reply that ends the turn its own spoken prompt started, and on asking, the last finished reply of a
project's newest session. Nothing else is read: no history, no session titles, no approvals. This computer turns the
reply into spoken text itself (a code block becomes "a code block of N lines", a link is read by its words, a key is
hidden), at most 4,000 characters in parts of 600, sent once to that voice key alone and kept nowhere. Asking for the last
reply is limited to once every 10 seconds and 60 times a day per voice key.

**Where a steered prompt came from.** A prompt sent into a session open here, by voice, from your phone or from a browser,
is recorded (a hash of its words, never the words) when its turn starts, so the phone and the web can mark that message
in read along as sent by voice, from your phone or from a browser. An older phone sees the message as before.

**A default folder for new projects, made only here.** Asked once, Enter is yes: after a phone is linked, at the end of
`npx worktrust remote status` and at the end of `npx worktrust update` on a computer paired for Remote Agent. Yes makes
`~/Desktop/WorkTrust` and adds it as a root (with git init), so "New session" on your phone, without choosing a project, asks
a project name and makes that one new, empty folder there. Nothing is asked without a person at a terminal (`--yes`,
`--json`, a pipe or an AI agent's shell), and no phone, browser or MCP door can turn it on. `npx worktrust remote roots
default on|off|status`; off keeps the folder and its projects.

**Continue a phone's session at your desk.** A Claude Code session started from the phone names its own session id to that
phone, so it can show `claude --resume <id>` once its turn has ended.

**After the voice security review.** A prompt sent while the phone was locked is checked again by the steer mod (1.1.0) when
it is delivered and when its turn starts: outside default and plan nothing runs. Voice keeps working past the first binding's
seven days (the phone renews it); a hello with an older binding than the newest seen is refused; every attempt counts toward a
voice key's limits; the steered words' hash is keyed with this computer's secret, kept 30 days, and `remote disable --forget`
deletes it.

**Every switch in the menu.** `npx worktrust` › Remote Agent now lists Read along, Steer from the phone, Voice prompts with
Siri and Read answers aloud with their state, and Roots lists Desktop/WorkTrust; each runs the same command you would type,
and says in one sentence what has to be on first. Type `/` or a letter to search every menu; Esc clears the search.

**Answer ready.** When a spoken prompt's turn ends after Siri stopped waiting, your phone gets "Answer ready" on its lock
screen (only a phone that asks for it; two names and nothing the agent wrote).

**Voice keys hold less.** A prompt counts as sent while the phone was unlocked only when its unlock key, which a locked phone
cannot read, signed it; anything else reaches only a session in default or plan mode.

## 0.11.20: a session's own name, a paste you can read, and the right answer for a session open at your desk

**The name Claude Code gives a session.** The list of this computer's sessions (Continue a session, Read along) now
shows the name VS Code shows: your own rename first, then Claude Code's own name for the conversation (current Claude
Code writes it as `ai-title`, not as the summary this CLI read before), then an older summary, then your first words. It
is cut at 80 characters with anything shaped like a key masked, as before. A paste is never a title.

**A paste is readable.** A prompt you pasted (the VS Code extension wraps it as pasted content) was counted as a file
and never sent, so a prompt of a paste alone showed on the phone as an empty message. Its text now comes along in your
message, after anything you typed: the tags, colours and control characters taken out, cut at 16,384 characters like
any message, and anything shaped like a key replaced by `[key hidden]` on every page, also in a session the phone
started. That mask knows shapes only: a customer's name in a pasted log, or a password under a name that says nothing,
is sent as written. No new field: an older phone reads it as the text it is.

**A session open at your desk is "open on the computer".** Continue on this phone, on a session open in VS Code, was
answered "This computer cannot continue that session": the start judged what Claude Code here could do before it
asked whether the session was free, and a computer whose Claude Code report could not start or resume at that moment
refused for that. The desk is now asked first: a session open here is refused as open on the computer (the phone says
you can read along, or close it there), whatever else is true. A free session still passes every check before anything
starts.

**Quieter service log.** The gateway's errors are written once per reason per hour, with the number of repeats; a
channel the gateway forgot after it restarted answered every health sample with `not_paired`, every 15 seconds.

**Small.** `remote status` says "1 browser added by a phone", not "1 browsers".

**Send a prompt from your phone into a session open at your desk, when you turn it on.** `npx worktrust remote
desk-steer on` (off by default, and only once read along is on: `npx worktrust remote read-along on`) installs a second
Claude Code mod, `worktrust-steer`, beside the measuring one. From then on your paired phone, or a browser after its
Remote PIN, can type into a Claude Code session that is open here, in VS Code or a terminal, without closing it: the words
arrive as yours, with that session's own permission mode. Before it writes anything this computer checks that steering
and read along are on, that the session is in its own list under a folder you granted, that the mod is alive in that
session (Claude Code 2.1.304 or later; restart a session that was open before you turned it on), that the session does
not bypass permission questions, that no other prompt waits for it, and that fewer than ten were sent this minute. A
prompt the session does not take within 60 seconds is withdrawn. Nothing listens on a port and the mod makes no network
call: the two meet in files under `~/.worktrust/remote/desk-steer/`. `npx worktrust remote desk-steer off`, `read-along
off` and `remote disable` remove the mod again. The measuring mod is unchanged: it still reads no text. A prompt that
starts with `!` or `/` is not sent (it might run as a shell line or a command), a prompt still waiting when you pause,
turn steering off or remove the phone is withdrawn, and one left waiting by a service that stopped is never delivered
later. Your AI Hours: only the turn a prompt started is marked as steered from the phone, never the days around it.

**A browser reads along too.** A browser reaches your computer only while its Remote PIN is unlocked, so a browser that
asks now reads along with (and, with steering on, sends into) a session at your desk, as a phone does.

## 0.11.19: read along from your phone with a session at your desk, when you turn it on

**Read along, live and read-only.** A phone you paired may read along with a Claude Code session you run at this
computer, in the VS Code extension or in a terminal, in a folder you granted: what you type, what the agent answers and
its steps, as they are written. It only reads. Nothing can be typed or sent into that session from the phone, and
nothing is started, resumed or stopped by it.

**You are asked once, at this keyboard, and Enter is yes.** After you link a phone (`remote app`, `remote web`, `remote
pair`) or confirm one (`remote phones confirm`), the CLI explains reading along in three lines and asks `Turn read along
on? [Y/n]`. Enter turns it on, exactly as `read-along on` does; `n` leaves it off; the answer is remembered and you are
not asked again (`read-along status` says whether you were). If this computer was paired before this release, the
update switches nothing: you are asked once, at the end of your next `npx worktrust remote` command in a terminal.
Nobody but you at a terminal is asked: in a pipe, with `--yes` or `--json`, in an AI agent's shell or in the
background service nothing is asked and nothing is turned on, and the pairing prints the one command instead. No
answer (the input ends, or two minutes pass) is a no for now, and you are asked again another time. Know what a yes
does: the content of your sessions then leaves this computer live, sealed for the phones you paired, for every folder
this computer shares; the key mask knows shapes only.

**Off until you say so, at this keyboard.** `npx worktrust remote read-along on` turns it on, `off` turns it off within
a second for every phone that reads along, `status` says where it stands, and `remote status` carries the same line
(`desk_read` in `--json`: off, history or live). The switch never changes from the app or the web. It covers every
folder you granted and every project inside a root you added, also one added later (approved in the app too, while
`remote admin` is on); `read-along on` says so and names how to see the list. `read-along on` also
turns on reading the closed turns of those sessions (`desk-history`); `desk-history on` alone stays what it was in
0.11.17 and 0.11.18, closed turns and never the running one, and `desk-history off` turns reading along off with it. If
you had `desk-history` on before this release, nothing more is readable after the update than before. A connected phone
hears the change of the switch within three seconds; a folder granted or a switch changed in the first seconds after
the service started is now told too (until now a change before the service's first look went unsaid).

**Your terminal says who reads.** While `remote run` is in a terminal it prints one line when a phone starts reading
along and one when it stops: the phone's name and the folder's, never a word of the session.

**What leaves, and what does not.** The same as for earlier messages: your words and the agent's text (cut at 16,384
characters), each step with a short preview of what went in and came out, thinking as a marker only, images and pasted
content counted and never sent, and a step named but not shown when it uses a connector's or an unknown tool, names a
secret file or a path outside the project, prints credentials or carries something shaped like a key. New in this
release, for every page of a session of your own desk, live or earlier: something shaped like a key in what you typed or
in what the agent wrote (a token, a private key block, a password in an address, lines of NAME=value) is replaced in
place by `[key hidden]`, and the words around it stay. The shapes it knows (and with them what makes a step withheld,
also in earlier messages) now include an `Authorization` header and a bare `Bearer` token, a name that ends on a
secret's word with its value anywhere in a line (`password=…`, `password: …`, `"apiKey": "…"`, `api_key: …`,
`?token=…`), a password in an address without a user or with `/` or `@` in it, `mysql -p…`, and the tokens of Hugging
Face, SendGrid, DigitalOcean, Twilio, Google and webhook secrets. It knows shapes only: a password said in a sentence,
or a customer's data, is sent as written. The same holds for a session's title in the list of this
computer's sessions (its first words, or Claude Code's own summary), for every phone and browser that gets that list. Everything is sealed for the one phone that asked; WorkTrust's
relay cannot open it and keeps none of it, and this computer writes none of it anywhere.

**A withheld step no longer names its secret in its label (also in earlier messages, since 0.11.17).** A step whose
content is not shown still carried a label made from its command, path or tool name, so `NAME=secret command` or a
secret file's name was readable there. A withheld step now says only "Run a command" or "Use a tool", and every other
label, a sub-agent's too, has anything shaped like a key replaced by `[key hidden]`.

**A step that still runs shows its label only.** What a step will print cannot be judged before it has printed it, so
its input is not sent either until then (what a Write writes, what an Edit changes); a command's own line is its label
and is shown, with anything shaped like a key masked.

**Bounded.** One session per phone at a time, four phones at most, at most one update a second per phone, and an hour
at most for one follow: after that the phone has to open the session again. `remote status` and `remote read-along
status` say who reads along now, by the phone's name and the folder's, also when the service runs in the background. A phone that
goes away is forgotten after two minutes. Nothing is read while nothing is written, and nothing at all while nobody
reads along. A sub-agent's own steps are shown when you open it, once it has ended.

**Limits you should know.** Reading along is in the phone app (once it is on the release that asks for it), not in the
browser: WorkTrust in the browser never asks for it, and this computer refuses it for a browser one of your phones
added. A browser you confirmed at this keyboard is recorded like a phone and cannot be told apart: for it the switch
decides. A session in a git worktree is listed only when that worktree's folder is itself granted. Sessions are read
from `~/.claude/projects`: a `CLAUDE_CONFIG_DIR` of your own is not followed. An older phone app or browser tab works
as before and is sent nothing new. Nothing changes in what is measured: the measure rules stay 4.

## 0.11.18: files from your phone reach projects inside a granted root, stay out of git, and can be cleared one by one

**Files from the phone arrive in every project a session can run in.** A session in a project this computer reaches
inside a granted root (since 0.11.7) was refused every file you sent from your phone, and the prompt that named it. The
files now follow the session's project the way the session itself does: a granted project, or a git project inside a
granted root.

**A received file is never an untracked file of your project's git.** Files from the phone land in
`<project>/.worktrust/inbox/<session>/`. That inbox now carries its own `.gitignore`, so an agent's `git add -A` never
stages a photo or document you sent. It is written once and only where nothing stands: a `.gitignore` of your own there
is left as it is. `.worktrust/pipeline.json` stays committable.

**A HEIC photo never replaces a file.** A photo from an iPhone becomes a JPEG under a name nothing in the inbox holds,
neither the `.heic` nor the `.jpg` one, and is placed without replacing or following anything. If the conversion fails,
the photo is kept as it arrived.

**One file can be cleared.** When a file did not go (your phone or browser gave up on it, or its message was not sent),
it asks this computer to clear that one file: what arrived of it, and the file itself when it was stored whole. The
other files of the session stay, after a restart too: the computer reads back from its own journal which file was
which, and the clear of one file is never taken for the clear of the inbox.

**Your phone always gets an answer.** A read-only project or a full disk refuses a file, or a clear, instead of leaving
the phone waiting. A clear of a session that received nothing removes nothing and creates no folder, and nothing is
ever removed through a link planted in the inbox. A preview grant on a project you un-granted does not come back through
a root that still reaches it.

A single file is cleared once your phone app and WorkTrust are on the release that asks for it; until then a file that
did not go stays in the inbox, as before. The other way round, a phone or browser on the new release talking to this
computer before you update to 0.11.18 has its clear of one file dropped without an answer (0.11.17 knows only the clear
of the whole inbox, and never takes this for it): the file stays in the inbox and counts against the session's 100 MB.
What this computer answers to a clear is unchanged, so an older phone or browser keeps working. The inbox is kept until you remove it; how long it should be kept is an open
decision. Nothing changes in what is measured: the measure rules stay 4.

## 0.11.17: earlier messages of a session, read on this computer for your own devices; a connection the relay closed comes back

**A phone or browser can ask for what happened before.** Scroll up in a chat and this computer sends the session's
earlier turns, a page at a time: your words, the agent's answers, and its steps with a short preview of what went in
and what came out (the whole of one step only when you ask for it). For a Claude Code session it reads that session's
own transcript; for Codex, OpenCode, or a transcript that is gone, it answers from the Remote Agent journal. **This is the
first Remote Agent command that reads a file on this computer.** It only reads: it starts, resumes and writes nothing,
and a page goes sealed to the one device that asked. The relay carries a box it cannot open. It needs WorkTrust's relay
and your phone app to be on the release that carries it; until then nothing changes.

**What is never shown.** A step keeps its name and its outcome, and its input and output are withheld, when it uses a
connector's tool or a tool this CLI does not know, when it names a secret file or folder (keys, `.env`, credentials,
the folders where command line tools keep their tokens) or a path outside the project, when its command prints
credentials or reads the environment, or when what went in or came out is shaped like a key. Anything the CLI cannot
judge is withheld. The agent's thinking and images are never sent. Your phone then says "Not shown: this step may hold
private data."

**Sessions you started at this keyboard stay unread by default.** A session you never continued from a phone is not read
for one unless you say so here: `npx worktrust remote desk-history on`. It is off by default, `off` turns it back, and
without a word it says which it is.

**A paused computer answers no history.** While Remote Agent is paused (here or from a phone) or off, every ask for
earlier messages is refused, like every command.

**A connection the relay closed is no longer lost in silence.** When the relay closed the connection with its code for
a protocol fault (4003), the service stopped reconnecting for good, stayed running and said so only in its log; your
phone showed the computer as not connected until someone restarted it. It now tries again after five minutes and then
every hour, logs each try, and `npx worktrust remote status` says so plainly: "Connection: stopped by the gateway since
…" with the time of the next try. A computer whose link was revoked (4001) still stops, and the status now says that
and what to do.

## 0.11.16: the Remote Agent service names its version and says its restart, and a phone back in the app is caught up calmly

**The Remote Agent service says which version it runs.** A phone or browser you linked can ask this computer which CLI its
Remote Agent service runs, and shows it; when that version is behind the one on npm, it shows the command to run here
(`npx -y worktrust@latest update`). Nothing is updated from a phone or a browser. The version is sealed for your own
devices only; an older phone or browser is never sent it.

**A restart is announced.** Before the service moves to a newer version, and when `update` restarts it, it tells your
linked phone and browser that it is restarting and on which version, so they show that instead of a dropped connection.
Stopping the service, `remote disable` and shutting the computer down say nothing, as before.

**Python installations move without cutting a task.** A service installed with the Python package is now asked by `update`
to move when nothing is at work, like the npm one, instead of being restarted at once. It moves only to an installation
it has checked: the signed engine, every installed file, the launcher's own text and the folder's name.

**A phone back in the app no longer loses its connection.** Everything this computer sends to the relay now goes through
one queue that stays under the relay's limits (and slows down for ten seconds when the relay says so), so a phone that
comes back and asks for what it missed is answered in small batches, one catch-up per phone at a time, the session it has
open first. Under pressure a stale progress frame is left out; an event of a running session never is. Before, a long
session could answer so fast that the relay closed the connection.

**A session remembers what was said.** The Remote Agent journal on this computer now keeps, per session, the turns and what
the agent said in them (thirty days, at most 500 per session), sealed for your own devices when they ask. Nothing new
leaves this computer for WorkTrust: the relay still carries boxes it cannot open.

**A prompt after an early stop starts the session instead of failing.** When you stopped a Claude Code session before its
first turn and then sent a prompt, the CLI tried to resume a transcript that was never written and the session showed
Failed. It now resumes only a session Claude Code wrote, and otherwise starts it under the same id.

## 0.11.15: the Remote Agent service follows CLI updates, and sealed notices for your phone's lock screen

**Follow a session with the app closed.** When your phone turns on notifications for Remote Agent, it hands this computer
a key of its own (inside the paired, end-to-end channel). For a session you follow, the Remote Agent service then seals
each milestone (started, the next step of the agent's plan, needs your approval, done, failed, stopped) under that key: this
computer's name, the project folder's name, step n of m when the agent keeps a plan, and the time. Nothing an agent wrote
can enter one: there is no field for it. Only your phone's notification extensions open it; the relay and Apple carry a
box of one size. A phone without a key, an older phone, a replay after reconnecting and the live screen get none. Turning
notifications off on the phone, or removing the phone, removes its key here (`~/.worktrust/remote/notice-keys.json`); so do
`remote disconnect`, `remote phones remove` and `remote disable --forget` at this keyboard.

**An update now moves the Remote Agent service too.** Until now `npx worktrust update` left the service on the version that
`remote app` installed, so a newer phone could meet an old service that refused its requests (it showed no projects).
Now, when the service is installed, the update moves it onto the new version and says so in one line ("Remote Agent
restarted on 0.11.x"). It never cuts an agent at work: a service of this version or later waits until nothing is at work
(a turn, a prompt still starting, a task, a pipeline, an open approval, the live preview, an upload from the phone, and on
Linux any terminal session, which a restart would end), starts nothing new while it moves, and the update says what is
true ("Remote Agent still runs 0.11.x: a task is running ..."). The service also notices by itself, at start and every ten
minutes, that a newer verified release is installed, and moves when idle; an older release never takes it over. A
pause stays a pause; the remote key, phones, channels, folders and settings are not touched; no service is installed
where there was none. On Linux a re-install now restarts the running service instead of leaving it on its old program, and
a `$` in a path is written so systemd does not expand it.
A request from a phone that this computer refuses for its contents is now logged with its kind (never its contents) in
`~/.worktrust/remote/daemon.log`, so a version mismatch is visible there.

## 0.11.14: the phone keeps its link, the link flow asks about browsers and modes, and dictation that hears you

**Back in the app, the session carries on.** When the WorkTrust app comes back to the front after you sent a prompt and
opened another app, Remote Agent now sends it what happened in between: the phone asks for the session's events after the
last one it holds, and the CLI answers from its own journal on this computer, page by page (at most 200 events and 1 MB
per page), sealed for that phone alone. Nothing is run for it and nothing new is written; it is answered while remote
control is paused too, as a status read is. A session this computer never ran is refused, so the phone drops it.

**A message you sent just before leaving is no longer stuck at "Delivery unconfirmed".** The app keeps an unconfirmed
message sealed on the phone and sends it again on its new connection, under its own id. The CLI used to see the new seal
as a conflict and drop it silently, while the agent was already working on it. It now answers that resend as the
duplicate it is, with the receipts it already gave, after checking it opens under your phone's signature on this
channel: nothing runs twice, and another message under the same id is still refused.

**Older apps and older CLIs are unaffected.** The phone asks this by a probe of its own first; a CLI before 0.11.14 drops
the probe and the phone asks it nothing new.

**After "✓ Phone linked" and what it may reach, the CLI asks two more things.** "May your confirmed phones add a browser?"
(what `npx worktrust remote phones allow-endorse on|off` sets) and "Which agent modes may a phone start here?": Manual and
Plan, + Edit automatically, or + Auto (what `npx worktrust remote modes allow|deny` sets). Each question marks the setting
as it is now. Both answers are taken first and only then written, through the same door as the typed commands, so Ctrl+C
or Esc at either question leaves both as they were. Without a terminal, or with `--yes`, nothing is asked and the commands
are named. `remote access` ends with the same two questions.

**Remote Agent › Modes.** The menu's modes row is now called Modes and names the ceiling beside it (Manual, Plan; + Edit;
+ Auto). `remote phones allow-endorse` writes through the one settings door too; a change from the app or the web can never
turn it on.

## 0.11.13: computer health in Remote Agent, and continue a session on this computer

**This computer's health, live on your phone and in the browser.** The Remote Agent service reads memory pressure, free
memory, swap and its growth over two minutes, the load per core, the GPU's utilisation (Apple silicon) and the three
programs using the most memory (by name only) every 15 seconds, with no model and no sudo, and sends them sealed to your
linked phones and browsers; the relay passes them on and keeps none. Red (critical pressure, or under 5 % free while swap
grows for two minutes) shows in `remote status` and the Remote Agent menu, and a new session is refused with "This
computer is under heavy memory load" until it eases; running sessions continue.

**Continue a session on this computer.**
**Carry on in the chat from your phone or a browser.** Remote Agent now lists this computer's recent Claude Code sessions
(the last 20 by activity) to the WorkTrust app and the web Remote Console, and continues the one you pick through the same
start as a session begun from the phone: Claude Code's own `--resume`, the approval tool, the deny rules (no release,
pipeline or deploy from a remote session) and the agent modes you allowed here. From then on it is a remote session like
any other, in the normal sessions list, and its turns from the phone are not your AI Hours.

**Only what it needs, only from folders you granted.** The CLI opens Claude Code's own transcript folders for your granted
projects and roots' projects only, never the store as a whole, and drops a transcript whose recorded folder is another. Per
session it sends, sealed end to end, only its id, the project's id, the last activity time, a title (Claude Code's own
summary when there is one, else the first line you typed, cut to 80 characters) and the model when recorded. Nothing
else of a transcript leaves this computer, and WorkTrust's servers see none of it. The list goes only to a phone or
browser that asks for it; an older app never receives it.

**One owner per conversation.** A session is refused while it is open here: its transcript was written in the last 30
seconds, a Claude Code process names it (`--resume`), or a Claude Code window open in that project folder started before
its last line. The phone and the browser say "This session is open on the computer. Close it there first." Agents running
in that window do not come along. On Windows, where the CLI cannot read the process list without a shell, the list stays
empty for now.

## 0.11.12: a smaller code to link a phone, access chosen at once, Esc stops a command, and decoy keys

**Decoy keys beside the real one.** `connect` and `update` write a few decoy credential files next to the computer's key,
in the same format, and register only their fingerprints with WorkTrust. Someone who copies the folder and tries one of
them is caught at once: every Remote Agent link of the account is cut, the computer's key is revoked, and the owner gets an
alert and an e-mail. If you restored a file from `~/.worktrust` yourself, run `npx worktrust connect` again.

**A smaller code to link a phone, and ten minutes to scan it.** The QR that links a phone carries a short code instead of
the computer's two keys: a one-time secret and a 128-bit commitment to those keys, which the phone checks against the
computer's signed key when it first connects. With a narrower margin it is drawn 37 characters wide and 19 lines high,
where it was 61 by 31. It needs the WorkTrust app build 17 or later. The code and the QR work for ten minutes, with the
time left counting down under the QR, and an empty line above and below the code gives it room. The pairing link is no
longer printed with its secret (`--show-link` prints it).

**The phone is named the moment it links, then you choose what it may reach.** `✓ Phone linked` shows the phone's device
id and its type, and the next step asks right away: allow all your usual project folders (Desktop, Projects, code and the
like, as roots) or tick the projects to grant. Both go through the same grants as Remote Agent › Roots and › Projects.
Nothing is shared until you choose: close the CLI before that and the phone reaches no folder, and the next
`npx worktrust` asks again (`npx worktrust remote access` does it directly).

**Esc stops a running command in the menu.** While a command the menu started is busy, Esc stops it and the menu says
`Stopped. Enter: back to the menu · Esc: close`. A read or a wait stops at once; a write is finished first (`Finishing a
write, then stopping…`), so no file is left half-written. Typed directly, nothing changes: Ctrl+C stops a command as before.

**The spinner stays on one line.** A key typed while "Counting what this computer measured" turned was echoed by the
terminal and pushed the spinner onto a second line. In the menu the keys are no longer echoed while a command is busy, and
the spinner is cut to the terminal's width.

**The key goes into the OS vault by itself.** `connect` protects a new coupling's key with the macOS Keychain, Windows
Credential Manager or the Secret Service, and `update` moves a key still in its plain file once, after saying so
(`--keep-key-file` keeps the file). Where there is no vault, or over SSH, the private file stays and one line says how to
retry (`npx -y worktrust protect-key`). Reading the key never raises a system prompt.

## 0.11.11: faster file sending, another model in the same chat, and no release from a phone for Codex and OpenCode

**Files travel faster.** Remote Agent checks and encodes a file's pieces without decoding them first and gives the
computer room to breathe between them, so a large picture or document from your phone arrives sooner and the CLI stays
responsive while it does. What travels over the wire is the same as before.

**Another model of the same agent, in the same chat.** From a phone that offers it, a running Claude Code, Codex or
OpenCode session can continue on another of that agent's own models: Claude Code resumes its own session with the new
model, Codex takes it from the next turn, OpenCode from its next run. The computer checks the model against the list its
agent reported; a model it did not list is refused, and another agent is always a new chat. A terminal session never
switches. A phone that does not ask for it sees exactly what it saw before.

**No release from a phone, for Codex and OpenCode too.** A Codex or OpenCode session steered from your phone can no
longer run a ship script, a deploy script, `psql` or a release, whatever your own desk settings allow. Codex: while your
own Codex rules allow a command that is not one WorkTrust reviewed, a remote Codex session does not start (Codex offers no
way to set them aside for one session), and its approvals always come to your phone. OpenCode: your own and the project's
shell allows are denied for the remote run, beside a fixed list; a settings file that cannot be read gives that run no
shell at all. This computer's keyboard keeps every one of them. Nothing it measures changes: the measure rules stay 4.

## 0.11.10: one scan to connect, a look before you sign in, and no release from a phone

**One QR connects a computer.** `npx -y worktrust remote app` draws one code. Scanned in the WorkTrust app (Scan ›
Connect agent, or Add connection), it approves this computer with your authenticator code and links that phone in the
same pass. The button says so ("Approve and link this phone"), and a computer you link while another is already linked is
not chosen for you. A code opened with the phone's camera or in a browser only approves; the phone is linked by a second
code a moment later. The printed link no longer carries the pairing secret (`--show-link` prints it whole), and
`--no-pair` links nothing. Remote Agent uses WorkTrust's gateway by default, so `remote pair` and the service work on a
computer approved without `--gateway`, where they said "no gateway" before. Every QR is drawn more compactly: about a
sixth fewer lines for the pairing code.

**Look at this computer.** `npx worktrust look`, the first row before you sign in, counts what your AI apps recorded
here: sessions per app, the first and last day, or that a store could not be read. It sends nothing, writes nothing and
makes no network call. Then you connect and send them, or preserve them here.

**No release from a phone.** A session steered from your phone can no longer run a ship script, a deploy script, `psql`
or a release through `gh`, whatever your own desk settings allow; this computer's keyboard keeps every one of them.

**Clearer lines and a steady screen.** Check this computer says which files its test count reads (a file once per
stretch) and how many stretches are not classed. A window resized while the menu is open no longer clears a command's
output above it, such as a QR you still need. When Remote Agent is part of Premium for an account, the menu says so and
offers the upgrade page; the summary names the account type. The licence names whom to contact for any use it does not
allow. Nothing it measures changes: the measure rules stay 4.

## 0.11.9: a first menu, one row per item, and nothing you can do twice

**A short menu until this computer is connected.** `npx -y worktrust` on a computer that is not connected yet opens
Connect this computer, Preserve evidence, Help and Quit, and nothing that needs a connected computer. Connect is the
same sign-in as `worktrust connect`: it shows the plan, asks before it writes, and your browser signs in. The moment it
succeeds the full menu is there, without running anything again; if it stops, the short menu stays and says why in one
line. Preserve needs no account and is whole in both menus.

**An update that is not needed cannot be run again.** When this computer runs this version and npm has none newer, the
Update row is still drawn, dimmed, reading `up to date (0.11.9)`, and cannot be chosen: the arrows pass it and its digit
answers `Already up to date.` When npm could not be asked, the row says `newest not checked` and claims nothing.
`npx worktrust update` on a computer that is already on this version, with nothing waiting (every AI app's door
standing, nothing new to agree to), answers `Already up to date (0.11.9). Nothing changed.`; before, it took every door
out and put it back and said `7 added`. `update --force` sets everything up again all the same.

**One row per item.** Number, action, command and explanation stand on one line where the terminal is wide enough; on a
narrower one (80 columns) the chosen row's explanation has one fixed line under the list. No row moves when you move,
no sentence is cut, and every sentence was rewritten to 60 characters or fewer. Under 60 columns the command column goes.

**Remote Agent asks for the approval first.** Until this computer is approved, Approve this computer is first, and what
cannot work before it (Link a phone, Projects, Roots, Connections, Pause) is dimmed, marked `not yet`, and cannot be
chosen. Approved from inside the menu, the list opens at once with the cursor on Link a phone.

**A summary above the menu, Sharing, and the linked devices.** A connected computer's head says the account, this
computer and since when, Remote Agent with its connections, and what this computer shares; all from its own files, never
the key. Sharing › holds the switches that exist (`mcp off | on`, Remote Agent's pause) and says that the session hook has
none in the CLI. Remote Agent › Connections is a table (name, kind, since, last activity); Disconnect runs
`remote disconnect` with the confirmation you type, as before.

**Esc quits at the top**, like q, and goes back one level below it.

**`-y` where a first command is shown.** The README, the app and the site show `npx -y worktrust` and
`npx -y worktrust@latest …`, so npm's own `Ok to proceed?` is answered in advance.

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
