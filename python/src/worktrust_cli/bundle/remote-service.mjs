/**
 * THE DAEMON AS A SERVICE OF THIS USER (2026-11-07). Off until `worktrust remote app` (or `remote web`); removed by `disable`.
 *
 *   macOS   a launchd agent, ~/Library/LaunchAgents/io.worktrust.remote.plist: RunAtLoad, restarted after a crash
 *           (KeepAlive SuccessfulExit false), so `disable` (exit 0) stays off; logs in ~/.worktrust/remote/daemon.log
 *   Linux   a systemd user unit, ~/.config/systemd/user/worktrust-remote.service, Restart=on-failure, the agents in its
 *           control group (they stop with it). Linger stays OFF: it runs while this user is logged in, never as standing
 *           remote execution on a machine nobody is logged into. Nothing here calls loginctl.
 *   Windows no service: `worktrust remote run` in a terminal, in the foreground, for as long as it should run.
 *
 * The unit runs the verified release launcher the CLI installed, with the PATH the person had when they enabled remote
 * (so the agents are found) and nothing else from their environment. Every command is execFile with fixed arguments.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LABEL = "io.worktrust.remote";
export const UNIT = "worktrust-remote.service";
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unitQuote = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export const servicePlatform = (platform = process.platform) => (platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "foreground");
export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
export const unitPath = (home = homedir()) => join(home, ".config", "systemd", "user", UNIT);

export function launchdPlist({ program, path, home = homedir() }) {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const log = xml(join(home, ".worktrust", "remote", "daemon.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(home)}</string></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ program, path }) {
  return `[Unit]
Description=WorkTrust remote agents (steer this computer's agents from your phone)

[Service]
ExecStart=${program.map(unitQuote).join(" ")}
Environment=${unitQuote(`PATH=${path}`)}
Restart=on-failure
RestartSec=10
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

const run = (file, args) => { try { execFileSync(file, args, { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; } };

/** Install and start. `program` is [node, ...nodeArgs, launcher, "remote", "run"]. Returns what was done, in words. */
export function installService({ program, path, platform = process.platform, home = homedir() }) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") {
    const file = plistPath(home);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(file, launchdPlist({ program, path, home }), { mode: 0o644 });
    const domain = `gui/${userInfo().uid}`;
    run("launchctl", ["bootout", `${domain}/${LABEL}`]);
    return { kind, file, started: run("launchctl", ["bootstrap", domain, file]) };
  }
  if (kind === "systemd") {
    const file = unitPath(home);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(file, systemdUnit({ program, path }), { mode: 0o644 });
    return { kind, file, started: run("systemctl", ["--user", "daemon-reload"]) && run("systemctl", ["--user", "enable", "--now", UNIT]) };
  }
  return { kind, file: null, started: false };
}

export function removeService({ platform = process.platform, home = homedir() } = {}) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") { run("launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`]); rmSync(plistPath(home), { force: true }); return kind; }
  if (kind === "systemd") { run("systemctl", ["--user", "disable", "--now", UNIT]); rmSync(unitPath(home), { force: true }); run("systemctl", ["--user", "daemon-reload"]); return kind; }
  return kind;
}

export function serviceState({ platform = process.platform, home = homedir() } = {}) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") return { kind, installed: existsSync(plistPath(home)), running: run("launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`]) };
  if (kind === "systemd") return { kind, installed: existsSync(unitPath(home)), running: run("systemctl", ["--user", "is-active", "--quiet", UNIT]) };
  return { kind, installed: false, running: false };
}

/**
 * MACOS ASKS ONCE, NOW, NOT MID-SESSION (CLI 0.11.7, owner 2026-11-12). macOS guards Desktop, Documents, Downloads and
 * iCloud Drive per program: a program launchd starts is asked on its first read there, so an agent the service starts in
 * such a folder would stop mid-session at a prompt nobody sees, or fail with "Operation not permitted". When the person
 * adds such a folder at the keyboard, the CLI runs the SAME program the service runs (its node or Python launcher, the
 * release entry, `remote folder-check`) once, as a one-shot launchd job with the service's PATH and HOME, so the prompt
 * comes up at once for the program that later starts the agents. `remote folder-check` only reads whether each guarded
 * root or project can be listed and writes yes or no per folder to ~/.worktrust/remote/folder-check.json; nothing leaves
 * the computer. → that file's contents, or null (not macOS, or no answer in time).
 */
export const CHECK_LABEL = "io.worktrust.remote.folder-check";
export const folderCheckPlist = ({ program, path, home = homedir() }) => launchdPlist({ program, path, home })
  .replace(`<string>${LABEL}</string>`, `<string>${CHECK_LABEL}</string>`)
  .replace("  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>10</integer>\n", "  <key>LaunchOnlyOnce</key><true/>\n");
export async function probeFolders({ program, path, home = homedir(), platform = process.platform, waitMs = 120_000 }) {
  if (servicePlatform(platform) !== "launchd") return null;
  const out = join(home, ".worktrust", "remote", "folder-check.json"), file = join(home, "Library", "LaunchAgents", `${CHECK_LABEL}.plist`);
  const domain = `gui/${userInfo().uid}`;
  rmSync(out, { force: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(file, folderCheckPlist({ program, path, home }), { mode: 0o644 });
  run("launchctl", ["bootout", `${domain}/${CHECK_LABEL}`]);
  let result = null;
  if (run("launchctl", ["bootstrap", domain, file])) {
    for (const end = Date.now() + waitMs; Date.now() < end && result === null;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { result = JSON.parse(readFileSync(out, "utf8")); } catch { result = null; }
    }
  }
  run("launchctl", ["bootout", `${domain}/${CHECK_LABEL}`]);
  rmSync(file, { force: true });
  return result;
}
