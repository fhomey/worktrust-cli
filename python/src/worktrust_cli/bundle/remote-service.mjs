/**
 * THE DAEMON AS A SERVICE OF THIS USER (2026-11-07). Off until `worktrust remote enable`; removed by `disable`.
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
