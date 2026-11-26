/**
 * REMOTE AGENT WITH NOBODY LOGGED IN, A CHOICE PER COMPUTER AT ITS KEYBOARD (CLI 0.11.27; owner, 2026-11-25: "yes, but only as a
 * deliberate choice per computer at the keyboard, off by default"; docs/remote-agents/HEADLESS.md §Always on).
 *
 *   the switch   `npx worktrust remote service always on|off|status`. ON asks the person at this terminal (remote-keyboard.mjs
 *                keyboardYes: both ends a TTY, never an agent's shell, y or yes) after saying plainly what it means. OFF works
 *                anywhere. Either is remembered as the person's choice (remote-store.mjs chosen.json `always`); an update, a
 *                link or the app never turns it on (check-remote-cli rules W and U).
 *   macOS        a LaunchDaemon in the system domain that runs AS THIS USER (`UserName`, never root), restarted after a crash, the same
 *                program and PATH as the LaunchAgent. Installing one needs root once: this CLI writes the plist into
 *                ~/.worktrust/remote (0644) and PRINTS the exact commands, `sudo install` and `sudo launchctl bootstrap
 *                system`, then the LaunchAgent's removal (two services would run one key twice). It never runs sudo and never
 *                sees a password. While the daemon's plist stands, the update and `remote app` leave the LaunchAgent alone and
 *                say how to move the daemon onto a new release (`sudo launchctl kickstart -k system/<label>`).
 *   Linux        lingering for this user (`loginctl enable-linger <user>`, asked through the guarded runner; when the system
 *                wants root, the exact sudo command is printed): the user's systemd manager, and with it the existing user
 *                unit, then starts at boot. Off: `disable-linger`.
 *   status       read from the files (the daemon's plist, /var/lib/systemd/linger/<user>), never by asking a service manager.
 *   key store    honest: the remote keys are a 0600 file in ~/.worktrust/remote, readable with nobody logged in. The macOS
 *                LOGIN keychain stays locked until someone logs in: the mail accounts (remote-mail-vault.mjs) answer
 *                `unsupported`, and an agent that keeps its own sign-in there (Claude Code on macOS) cannot start until then.
 *
 * `root` (WORKTRUST_SYSTEM_ROOT, absolute) moves the system paths for the tests; every OS effect goes through `runner`
 * (remote-service-home.mjs systemRunner: nothing is asked for a home that is not this user's).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { keyboardYes } from "./remote-keyboard.mjs";
import { ALWAYS_LABEL, daemonPlistPath, systemRoot, systemRunner } from "./remote-service-home.mjs";
import { LABEL, installedProgram, launchdPlist, plistPath, servicePlatform } from "./remote-service.mjs";
import { loadChosen, saveChosen } from "./remote-store.mjs";

export const ALWAYS_COMMAND = "npx worktrust remote service always on|off";
export { ALWAYS_LABEL, daemonPlistPath, systemRoot };
export const lingerPath = (user, root = systemRoot()) => join(root, "var", "lib", "systemd", "linger", user);
const userName = () => { try { return userInfo().username; } catch { return null; } };
const quoted = (path) => `'${String(path).replace(/'/g, "'\\''")}'`;

/** The LaunchDaemon: the LaunchAgent's own program and PATH, as this user, restarted whenever it ends. */
export function alwaysPlist({ program, path, home, user }) {
  return launchdPlist({ program, path, home })
    .replace(`<key>Label</key><string>${LABEL}</string>`, `<key>Label</key><string>${ALWAYS_LABEL}</string>\n  <key>UserName</key><string>${user.replace(/[<>&"']/g, "")}</string>`); // KeepAlive as the agent's: a crash restarts it, `remote disable` (exit 0) stays off
}

/** Whether this computer runs Remote Agent with nobody logged in, from the files alone. */
export function alwaysState({ platform = process.platform, root = systemRoot(), user = userName() } = {}) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") return { kind, on: existsSync(daemonPlistPath(root)) };
  if (kind === "systemd") return { kind, on: Boolean(user) && existsSync(lingerPath(user, root)) };
  return { kind, on: false };
}

/** `remote status`: one line. */
export function alwaysLine(o = {}) {
  const s = alwaysState(o);
  if (s.kind === "foreground") return null;
  const chosen = loadChosen().always;
  return `  Runs with nobody logged in: ${s.on ? `on (${s.kind === "launchd" ? `a LaunchDaemon as ${userName() ?? "you"}, never root` : `lingering for ${userName() ?? "you"}`})` : "off"}${chosen === "on" && !s.on ? " (you turned it on: run the printed sudo commands to finish)" : ""} (${ALWAYS_COMMAND})`;
}

const QUESTION = (user) => `Remote Agent will then run on this computer after every restart with NOBODY logged in, as ${user} (never root): a phone you linked can start agents in the folders you granted, and they read and write what ${user} can, while nobody sits at or watches this computer. Standing remote execution on an unattended machine. On macOS it needs sudo once (the commands are printed, no password is kept here), and the login keychain stays locked until someone logs in: mail and an agent that keeps its sign-in there (Claude Code on macOS) wait for that. Turn it on?`;

function macOn(io, { home, root, user }) {
  const unit = installedProgram({ platform: "darwin", home });
  if (!unit) return { ok: false, reason: "Remote Agent is not set up on this computer yet: npx worktrust remote app" };
  const dir = join(home, ".worktrust", "remote"), file = join(dir, `${ALWAYS_LABEL}.plist`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, alwaysPlist({ program: unit.program, path: unit.path ?? "", home, user }), { mode: 0o644 });
  return { ok: true, lines: [
    "  Run these in this terminal (sudo asks for your password; nothing here keeps it):",
    `    sudo install -m 644 -o root -g wheel ${quoted(file)} ${quoted(daemonPlistPath(root))}`,
    `    sudo launchctl bootstrap system ${quoted(daemonPlistPath(root))}`,
    `    launchctl bootout gui/$(id -u)/${LABEL}; rm -f ${quoted(plistPath(home))}`,
    "  The last line removes the service that runs only while you are logged in, so one service runs, not two.",
    "  Then: npx worktrust remote service always status",
  ] };
}
const macOff = ({ home, root }) => ({ ok: true, lines: [
  "  Run these in this terminal:",
  `    sudo launchctl bootout system/${ALWAYS_LABEL}; sudo rm -f ${quoted(daemonPlistPath(root))}`,
  "    npx worktrust remote app --no-pair",
  `  The second line brings back the service that runs while you are logged in (${quoted(plistPath(home))}).`,
] });
function linux(on, { runner, user }) {
  if (runner("loginctl", [on ? "enable-linger" : "disable-linger", user])) return { ok: true, lines: [on ? `  ✓ Lingering on for ${user}: the Remote Agent service starts at boot, with nobody logged in.` : `  ✓ Lingering off for ${user}: the service runs only while you are logged in again.`] };
  return { ok: true, lines: [`  This system wants root for it. Run: sudo loginctl ${on ? "enable-linger" : "disable-linger"} ${user}`] };
}

/** `remote service always on|off|status`, at this keyboard (ON needs the person's typed yes; OFF works anywhere). */
export async function alwaysCommand(io, rest, { platform = process.platform, home = homedir(), root = systemRoot(), runner = systemRunner(home), user = userName() } = {}) {
  const kind = servicePlatform(platform);
  if (rest[0] === "on" || rest[0] === "off") {
    if (kind === "foreground") return io.fail("this system has no service manager the CLI uses: Remote Agent runs in the foreground here");
    if (!user) return io.fail("this user's name could not be read");
    if (rest[0] === "on" && !(await keyboardYes(io, QUESTION(user)))) return;
    const done = rest[0] === "on" ? (kind === "launchd" ? macOn(io, { home, root, user }) : linux(true, { runner, user })) : (kind === "launchd" ? macOff({ home, root }) : linux(false, { runner, user }));
    if (!done.ok) return io.fail(`  ${done.reason}`);
    saveChosen("always", rest[0] === "on"); // the person's own choice: no update, link or app turns it on (check-remote-cli rule W)
    for (const line of done.lines) io.say(line);
    return;
  }
  if (rest[0] !== undefined && rest[0] !== "status") return io.fail("npx worktrust remote service always on|off | status");
  io.say(alwaysLine({ platform, root, user }) ?? "  This system has no service manager the CLI uses.");
}
