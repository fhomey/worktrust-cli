/**
 * TERMINAL SESSIONS AT THE DESK (release 19, 2026-11-09). Called from remote-cli.mjs:
 *
 *   remote terminal on | off              offer terminal sessions to a phone (off by default), the gaps said first
 *   remote terminal list                  the sessions on WorkTrust's own tmux socket, each with its attach line
 *   remote terminal start [<folder>]      Claude Code in a new terminal session in a granted folder, attached here
 *                                         (--detached leaves it running without attaching)
 *   remote attach <id>                    this terminal joins a session (started here or from a phone); tmux's own
 *                                         detach (Ctrl-b d) leaves it running
 *
 * Every tmux call names WorkTrust's socket and config (remote-adapter-terminal.mjs); the person's own tmux is never
 * touched. A session started here is the person's own work: it writes nothing to the steered ledger. A phone that later
 * types into it names it there first (remote-terminal-sessions.mjs).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as P from "./remote-protocol.mjs";
import { loadProjects, loadSettings, random, remotePath, saveSettings } from "./remote-store.mjs";
import { canonicalProject } from "./remote-policy.mjs";
import { inventory } from "./remote-inventory.mjs";
import { attachTarget, createTmux, terminalClaudeArgs, tmuxNameOf, writeTmuxConfig } from "./remote-adapter-terminal.mjs";

function tmuxFor(io) {
  const settings = loadSettings();
  const env = { ...process.env, PATH: settings.agent_path ?? process.env.PATH };
  const inv = inventory({ env, refresh: true });
  if (!inv.files.tmux) io.fail("tmux is not installed: `brew install tmux` on macOS, your package manager on Linux (Windows: WSL only)");
  return { inv, tmux: createTmux({ file: inv.files.tmux, config: writeTmuxConfig(remotePath("run")), env }) };
}

function attachHere(io, inv, tmux, name) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) io.fail("attach needs a terminal");
  const r = spawnSync(inv.files.tmux, tmux.attachArgs(name), { stdio: "inherit", env: tmux.env });
  process.exitCode = r.status ?? 1;
}

export async function attachCommand(io, rest) {
  const name = attachTarget(rest[0]);
  if (!name) io.fail("name a terminal session: npx worktrust remote attach <ses_...> (npx worktrust remote terminal list shows them)");
  const { inv, tmux } = tmuxFor(io);
  if (!(await tmux.state(name)).exists) io.fail(`no terminal session ${name.slice(3)} on this computer`);
  attachHere(io, inv, tmux, name);
}

export async function terminalCommand(io, rest, askTyped) {
  const s = loadSettings();
  if (rest[0] === "off") { saveSettings({ ...s, terminal: false }); io.say("  Terminal sessions are no longer offered to a phone. Sessions still running stay; `npx worktrust remote attach <id>` reaches them."); return; }
  if (rest[0] === "list") {
    const { tmux } = tmuxFor(io);
    const projects = loadProjects(), sessions = await tmux.list();
    if (sessions.length === 0) io.say("  No terminal sessions on this computer.");
    for (const t of sessions) {
      const project = projects.find((p) => p.path === t.path);
      io.say(`  ${t.session_id}  ${project ? project.path : "(not a granted folder: a phone does not see it)"}${t.dead ? "  (ended)" : ""}${t.ref ? "" : "  (no agent session id: a phone cannot steer it)"}`);
      io.say(`      npx worktrust remote attach ${t.session_id}`);
    }
    return;
  }
  if (rest[0] === "start") {
    const { inv, tmux } = tmuxFor(io);
    const canonical = canonicalProject(rest[1] && !rest[1].startsWith("--") ? rest[1] : process.cwd());
    const project = canonical.ok ? loadProjects().find((p) => p.path === canonical.path) : null;
    if (!project) io.fail("start in a granted folder: npx worktrust remote projects add <folder> first");
    const report = inv.terminal;
    if (!report?.capabilities.start) io.fail("this computer cannot run Claude Code in a terminal session (tmux 3.0 or later and a Claude Code with --session-id, --disallowedTools and --setting-sources)");
    const sessionId = P.mintId("ses", random), ref = randomUUID();
    const argv = [inv.files["claude-code"], ...terminalClaudeArgs({ features: inv.features["claude-code"], mode: "ask", model: null, resume: null, sessionRef: ref })];
    if (!(await tmux.start({ name: tmuxNameOf(sessionId), cwd: project.path, argv, ref }))) io.fail("tmux did not start the session");
    io.say(`  ✓ Terminal session ${sessionId} in ${project.path}.${s.terminal ? " Your phone sees it." : " Your phone sees it once `npx worktrust remote terminal on`."}`);
    io.say(`    Detach with Ctrl-b d; come back with npx worktrust remote attach ${sessionId}`);
    if (!io.has("detached")) attachHere(io, inv, tmux, tmuxNameOf(sessionId));
    return;
  }
  if (rest[0] !== "on") { io.say(`  Terminal sessions are ${s.terminal ? "on" : "off"} for remote. npx worktrust remote terminal on | off | list | start [<folder>]`); return; }
  io.say("  Terminal sessions: Claude Code runs in tmux on WorkTrust's own socket, never your own tmux server or ~/.tmux.conf.");
  io.say("  You attach at this desk with npx worktrust remote attach <id>; your phone sees the same screen and can stop it.");
  io.say("  Not yet: typing from the phone. The screen's state (working, a dialog) is not read yet, so a phone sends no words.");
  io.say("  Hours: a session started from your phone is marked remote-steered before it starts, and that includes what you");
  io.say("  then do in it at this desk: none of it counts as your AI Hours. A session you start here stays yours.");
  io.say("  Every terminal session carries the remote deny rules (no git push, installs or deploys by the agent), also here.");
  io.say("  A phone with an app older than this release refuses the computer's agent list while this is on: update it first.");
  if (!(await askTyped("Offer terminal sessions to your phones?"))) io.fail("terminal sessions stay off");
  saveSettings({ ...s, terminal: true });
  io.say("  ✓ Terminal sessions are offered to your phones. npx worktrust remote terminal off takes them back.");
}
