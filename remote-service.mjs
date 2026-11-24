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
 *
 * A NEW RELEASE MOVES THE SERVICE, NEVER CUTTING A TURN (CLI 0.11.15; the owner's iMac, 2026-11-16: three updates while the
 * service kept running 0.11.9, whose payload rules dropped the newer phone's inventory ask: 0 projects). The unit names one
 * verified launcher and launchd and systemd keep the job they loaded, so a release reaches the service only by re-installing:
 *   - `update` calls serviceOnRelease: no service, nothing; a daemon that hands over (daemon.json, 0.11.15 on) is asked
 *     (restart.json) and moves itself when nothing is at work (daemonBusy); an older daemon is re-installed at once.
 *   - the daemon (createHandover, every 3 s): at start, every ten minutes and when asked, a newer installed release verified
 *     under this release's pinned key is handed over only when idle: launchd through a one-shot job running the NEW
 *     launcher's `remote handover` (a job's own bootout would end the process that must bootstrap it again), systemd by a
 *     non-blocking restart. Identity, keys, phones, channels, grants and settings are files this never writes.
 *
 * THE RESTART IS SAID FIRST (CLI 0.11.16): `announce(to)` before a handover, `announce(false)` when it did not happen; the
 * update's own re-install of a daemon that can hear it leaves restart.json for the seconds it takes (restartAsked), which
 * the daemon reads when the service manager ends it. A stop, a disable or a shutdown says nothing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { verifyPackage, writePrivateFile } from "./package-integrity.mjs";
import { refusedFor, systemRunner } from "./remote-service-home.mjs";
import { RELEASE, installedRelease, isHandoverLauncher, launcherFor, launcherVersion, newerRelease } from "./remote-launchers.mjs";
export * from "./remote-launchers.mjs"; // which launcher a unit may be handed to (the npm copies, a Python installation)

export const LABEL = "io.worktrust.remote";
export const UNIT = "worktrust-remote.service";
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// systemd expands % specifiers and $VARIABLES inside ExecStart (review P3-4): % is written %%, $ is written $$, and a value
// with a control character (a newline would start a directive of its own) is refused outright.
const unitQuote = (text) => {
  if (/[\u0000-\u001f\u007f]/.test(String(text))) throw new Error("a service value holds a control character");
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
};

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

// THE SERVICE MANAGER IS ASKED ONLY FOR THIS USER'S OWN HOME (2026-11-24): the guard and the one runner live in
// remote-service-home.mjs; every runner default below is its systemRunner(home). Held by scripts/check-cli-service-home.mjs.
export { NOT_THIS_HOME, ownHome } from "./remote-service-home.mjs";

/**
 * Install and (re)start. `program` is [node, ...nodeArgs, launcher, "remote", "run"]; `runner` is how launchctl and
 * systemctl are run (tests pass a recorder). systemd: `enable --now` leaves a running daemon on its old program, so the
 * unit is restarted (which starts a stopped one); `self` (the daemon moving itself) does not wait for its own end.
 */
export function installService({ program, path, platform = process.platform, home = homedir(), runner = systemRunner(home), self = false, fromHandover = false }) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") {
    const file = plistPath(home);
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(file, launchdPlist({ program, path, home }), { mode: 0o644 });
    const domain = `gui/${userInfo().uid}`;
    // A one-shot handover job left behind (review P3-2) goes too; the job itself never boots itself out mid-way.
    if (!fromHandover) runner("launchctl", ["bootout", `${domain}/${HANDOVER_LABEL}`]);
    rmSync(handoverPlistPath(home), { force: true });
    runner("launchctl", ["bootout", `${domain}/${LABEL}`]);
    return { kind, file, started: runner("launchctl", ["bootstrap", domain, file]), why: refusedFor(runner, home) };
  }
  if (kind === "systemd") {
    const file = unitPath(home);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(file, systemdUnit({ program, path }), { mode: 0o644 });
    return { kind, file, started: runner("systemctl", ["--user", "daemon-reload"]) && runner("systemctl", ["--user", "enable", UNIT]) && runner("systemctl", ["--user", "restart", ...(self ? ["--no-block"] : []), UNIT]), why: refusedFor(runner, home) };
  }
  return { kind, file: null, started: false };
}

export function removeService({ platform = process.platform, home = homedir(), runner = systemRunner(home) } = {}) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") {
    for (const label of [HANDOVER_LABEL, LABEL]) runner("launchctl", ["bootout", `gui/${userInfo().uid}/${label}`]);
    for (const file of [handoverPlistPath(home), plistPath(home)]) rmSync(file, { force: true });
    return kind;
  }
  if (kind === "systemd") { runner("systemctl", ["--user", "disable", "--now", UNIT]); rmSync(unitPath(home), { force: true }); runner("systemctl", ["--user", "daemon-reload"]); return kind; }
  return kind;
}

export function serviceState({ platform = process.platform, home = homedir(), runner = systemRunner(home) } = {}) {
  const kind = servicePlatform(platform);
  if (kind === "launchd") return { kind, installed: existsSync(plistPath(home)), running: runner("launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`]) };
  if (kind === "systemd") return { kind, installed: existsSync(unitPath(home)), running: runner("systemctl", ["--user", "is-active", "--quiet", UNIT]) };
  return { kind, installed: false, running: false };
}

const unxml = (text) => text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const unquote = (text) => text.replace(/%%/g, "%").replace(/\$\$/g, "$").replace(/\\(["\\])/g, "$1");
/** What the installed unit runs, read back from its own file: { program, path }, or null (none, or not ours to read). */
export function installedProgram({ platform = process.platform, home = homedir() } = {}) {
  const kind = servicePlatform(platform);
  let text;
  try { text = readFileSync(kind === "launchd" ? plistPath(home) : kind === "systemd" ? unitPath(home) : "", "utf8"); } catch { return null; }
  let program, path;
  if (kind === "launchd") {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    program = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
    path = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
    path = path === undefined ? null : unxml(path);
  } else {
    program = [...(/^ExecStart=(.*)$/m.exec(text)?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]));
    const env = /^Environment="((?:[^"\\]|\\.)*)"$/m.exec(text)?.[1];
    path = env === undefined ? null : unquote(env).replace(/^PATH=/, "");
  }
  return program.length >= 4 && program.at(-2) === "remote" && program.at(-1) === "run" ? { program, path } : null;
}
/** The release launcher a program runs (the argument before `remote run`), and the same program on another launcher. */
export const entryOf = (program) => program[program.length - 3];
export const withLauncher = (program, launcher, tail = ["remote", "run"]) => [...program.slice(0, -3), launcher, ...tail];

/** The one-shot job the daemon hands over through (launchd): the NEW launcher's `remote handover`, outside the main job. */
export const HANDOVER_LABEL = "io.worktrust.remote.handover";
export const handoverPlistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${HANDOVER_LABEL}.plist`);
const oneShotPlist = (label, unit) => launchdPlist(unit).replace(`<string>${LABEL}</string>`, `<string>${label}</string>`)
  .replace("  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>10</integer>\n", "  <key>LaunchOnlyOnce</key><true/>\n");
export const handoverPlist = (unit) => oneShotPlist(HANDOVER_LABEL, unit);

/** The daemon's own word (0.11.15 on): { pid, version, busy }, only while that process lives. An older daemon writes none. */
const remoteFile = (home, name) => join(home, ".worktrust", "remote", name);
export const DAEMON_FILE = "daemon.json", RESTART_FILE = "restart.json";
export function daemonState(home = homedir()) {
  try {
    const state = JSON.parse(readFileSync(remoteFile(home, DAEMON_FILE), "utf8"));
    if (state?.handover !== true || !Number.isSafeInteger(state.pid) || state.pid <= 1) return null;
    process.kill(state.pid, 0);
    return { pid: state.pid, version: String(state.version ?? ""), busy: state.busy === true };
  } catch { return null; }
}
export const writeDaemonState = (home, state) => writePrivateFile(remoteFile(home, DAEMON_FILE), `${JSON.stringify({ v: 1, ...state })}\n`);
const reinstalling = (home) => { try { return JSON.parse(readFileSync(remoteFile(home, RESTART_FILE), "utf8"))?.now === true; } catch { return false; } };
/**
 * THE RESTART AN UPDATE IS MAKING NOW (CLI 0.11.16), read by the daemon as the service manager ends it: restart.json naming
 * a release, written in the last half minute (serviceOnRelease leaves it only while it re-installs). → that release, or null.
 */
export function restartAsked({ home = homedir(), now = Date.now() } = {}) {
  try {
    const asked = JSON.parse(readFileSync(remoteFile(home, RESTART_FILE), "utf8"));
    return asked?.now === true && RELEASE.test(asked.version ?? "") && Number.isSafeInteger(asked.at) && Math.abs(now - asked.at) < 30_000 ? asked.version : null;
  } catch { return null; }
}

/**
 * THE UPDATE'S STEP (worktrust.mjs `update`, and `remote handover` with `direct`): the service, when installed, onto
 * `program` (this release's runtime, the PATH the unit already had). → the one line to say, or null (no service, or
 * already on this release). A daemon that hands over is ASKED (restart.json) and moves when no task runs. An older daemon
 * cannot be asked, and one that stayed idle and unchanged for waitMs did not move (a release key it does not know): the
 * update, verified itself, re-installs it. Only what is true is said (review P3-3).
 */
export async function serviceOnRelease({ program, version, platform = process.platform, home = homedir(), runner = systemRunner(home), direct = false, waitMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (servicePlatform(platform) === "foreground") return null;
  const installed = installedProgram({ platform, home });
  if (!installed) return null;
  const daemon = direct ? null : daemonState(home);
  if (entryOf(installed.program) === entryOf(program) && (!daemon || daemon.version === version)) return null;
  const reinstall = () => {
    // A daemon that can hear it (daemon.json) is told why the service manager ends it: it says "restarting" to its phones.
    if (daemon) { try { writePrivateFile(remoteFile(home, RESTART_FILE), `${JSON.stringify({ v: 1, version, at: Date.now(), now: true })}\n`); } catch { /* unsaid */ } }
    let done;
    try { done = installService({ program, path: installed.path ?? process.env.PATH ?? "", platform, home, runner, fromHandover: direct }); } finally { if (daemon) rmSync(remoteFile(home, RESTART_FILE), { force: true }); }
    return done.started ? `✓ Remote Agent restarted on ${version}.` : `! Remote Agent could not move to ${version}: its service was written (${done.file}) but did not start; npx worktrust remote run shows why.`;
  };
  if (!daemon || !isHandoverLauncher(entryOf(program), home)) return reinstall();
  writePrivateFile(remoteFile(home, RESTART_FILE), `${JSON.stringify({ v: 1, version, at: Date.now() })}\n`);
  for (const end = Date.now() + waitMs; Date.now() < end;) { await sleep(500); if (daemonState(home)?.version === version) return `✓ Remote Agent restarted on ${version}.`; }
  const now = daemonState(home);
  if (now?.version === version) return `✓ Remote Agent restarted on ${version}.`;
  if (now?.busy) return `Remote Agent still runs ${now.version}: a task is running. It moves to ${version} when the task finishes, or at the next npx worktrust update.`;
  if (!now && entryOf(installedProgram({ platform, home })?.program ?? []) === entryOf(program)) return `Remote Agent is starting on ${version}.`; // the handover job loaded it
  return reinstall();
}

/**
 * `remote handover` (internal): the one-shot job's program, run by the NEW launcher. It moves the service only when this is
 * the installed release, newer than the one the unit runs, and the daemon says no task runs (review P3-1); its job file
 * goes whatever happens (P3-2). The job does not boot itself out (that would end it mid-way): the next handover and
 * `remote app` boot it out first.
 */
export async function handoverCommand(io, { home = homedir(), platform = process.platform, runner = systemRunner(home) } = {}) {
  try {
    const installed = installedProgram({ platform, home }), unit = installed ? launcherVersion(entryOf(installed.program)) : null;
    const why = installedRelease(home) !== io.version ? "not the installed release" : !installed ? "no service" : !unit || !newerRelease(io.version, unit) ? "not newer than the service" : daemonState(home)?.busy ? "a task is running" : null;
    if (why) return io.say(`  Remote Agent stays as it is (${why}).`);
    const r = await io.prepare();
    const said = await serviceOnRelease({ program: [r.node, ...r.nodeArgs, r.entry, "remote", "run"], version: io.version, platform, home, runner, direct: true });
    if (said) io.say(`  ${said}`);
  } finally { rmSync(handoverPlistPath(home), { force: true }); }
}

/**
 * IS ANYTHING AT WORK (review P2-2)? → why, or null: a turn under way, a turn command taken and not yet started (a cold
 * start) or still running, a pipeline, a terminal session at work (systemd: any, since its restart ends the control group
 * and tmux with it), an approval open, the live preview, a phone's upload in the last two minutes.
 */
const TURN_COMMANDS = new Set(["agent.start", "agent.prompt", "agent.steer"]), IN_FLIGHT = new Set(["DEVICE_RECEIVED", "RUNNING", "WAITING_APPROVAL", "PAUSED"]);
export function daemonBusy({ sessions, journal, pipelines, terminal, approvals, live, attachments, platform = process.platform, now = Date.now() }) {
  if (sessions.activeList().some((r) => r.started_at !== null)) return "turn";
  if (journal.interrupted().some((id) => { const m = journal.meta(id); return TURN_COMMANDS.has(m?.type) && IN_FLIGHT.has(journal.entry(id)?.state) && now - (m.at ?? 0) < 30 * 60_000; })) return "command";
  if (pipelines.running().length > 0) return "pipeline";
  if (servicePlatform(platform) === "systemd" ? terminal.runningCount() > 0 : terminal.rows().some((r) => r.state === "running")) return "terminal";
  if (approvals.openCount() > 0) return "approval";
  if (live.current()) return "preview";
  return attachments.uploading() ? "upload" : null;
}
/** While it hands over nothing new starts (review P2-1): the release queue is held, a plan that changes work refused, no pipeline. */
export const holdDuring = (holding) => ({
  paused: (paused) => () => paused() || holding(),
  plan: (plan) => (session, op, args) => (holding() && op !== "list" ? { ok: false, reason: "busy" } : plan(session, op, args)),
  pipelines: (pipelines) => ({ ...pipelines, start: (a) => (holding() ? { ok: false, reason: "busy" } : pipelines.start(a)) }),
});

/**
 * THE DAEMON SEES A STALE SELF (remote-run.mjs calls tick every 3 s). `busy()`: a turn, a task or a pipeline runs. While
 * `handing` is true the daemon takes no command (the phone resends it to the next daemon, unanswered, so never twice).
 * `own`: the launcher beside this release's modules (the launcher sets process.argv[1] to worktrust.mjs, so it is named, not
 * read); only the daemon the installed unit started (its entry) hands over, never one run by hand in a terminal. → { start, tick, stop, handing }.
 */
export function createHandover({ version, busy, own = null, log = () => {}, announce = () => {}, home = homedir(), platform = process.platform, runner = systemRunner(home), verify = verifyPackage, now = Date.now, everyMs = 10 * 60_000, giveUpMs = 60_000 }) {
  const said = (to) => { try { announce(to); } catch { /* unsaid: the phones see it offline, then its new version */ } };
  let checked = -Infinity, handing = 0, saidBusy = null, lastBusy = null, waiting = null;
  const ours = () => { const current = installedProgram({ platform, home }); return current && entryOf(current.program) === own ? current : null; };
  const say = (b) => { try { writeDaemonState(home, { pid: process.pid, version, busy: b, handover: Boolean(ours()), at: now() }); } catch { /* the update then asks nothing: it re-installs */ } };
  const unmark = () => rmSync(remoteFile(home, RESTART_FILE), { force: true });
  function handOver(current, launcher) {
    if (servicePlatform(platform) === "systemd") return installService({ program: withLauncher(current.program, launcher), path: current.path ?? "", platform, home, runner, self: true }).started;
    const file = handoverPlistPath(home), domain = `gui/${userInfo().uid}`;
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(file, handoverPlist({ program: withLauncher(current.program, launcher, ["remote", "handover"]), path: current.path ?? "", home }), { mode: 0o644 });
    runner("launchctl", ["bootout", `${domain}/${HANDOVER_LABEL}`]);
    return runner("launchctl", ["bootstrap", domain, file]);
  }
  return {
    start() { lastBusy = false; say(false); },
    stop() { try { if (daemonState(home)?.pid === process.pid) rmSync(remoteFile(home, DAEMON_FILE), { force: true }); } catch { /* gone */ } },
    get handing() { return handing > 0; },
    tick() {
      const why = busy(), b = Boolean(why);
      if (b !== lastBusy) { lastBusy = b; say(b); }
      if (handing > 0 && now() - handing < giveUpMs) return null;
      if (handing > 0) { handing = 0; log("handover_failed", { to: waiting }); said(false); } // still here: the new launcher did not take over; tried again later
      // An update that is re-installing the service itself right now (`now`, serviceOnRelease) asks nothing of this daemon.
      const asked = existsSync(remoteFile(home, RESTART_FILE)) && !reinstalling(home);
      if (!asked && now() - checked < everyMs) return null;
      checked = now();
      const target = installedRelease(home);
      if (!target || !newerRelease(target, version)) { if (asked) unmark(); return null; }
      if (b) { if (saidBusy !== target) { saidBusy = target; log("handover_waiting", { to: target, why: typeof why === "string" ? why : null }); } return null; }
      const current = ours();
      unmark();
      if (!current) return null; // a daemon run by hand, or no service: the next `remote app` or update moves the service
      const launcher = launcherFor(own, { home, version: target, verify, platform });
      if (!launcher) { log("handover_refused", { to: target }); return null; }
      waiting = target; handing = Math.max(1, now());
      said(target); // before the service manager is asked: the phones show "restarting", then the new version
      const started = handOver(current, launcher);
      log("handover", { from: version, to: target, started });
      if (!started) { handing = 0; said(false); }
      return started;
    },
  };
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
export const folderCheckPlist = ({ program, path, home = homedir() }) => oneShotPlist(CHECK_LABEL, { program, path, home });
export async function probeFolders({ program, path, home = homedir(), platform = process.platform, waitMs = 120_000, runner = systemRunner(home) }) {
  if (servicePlatform(platform) !== "launchd") return null;
  const out = join(home, ".worktrust", "remote", "folder-check.json"), file = join(home, "Library", "LaunchAgents", `${CHECK_LABEL}.plist`);
  const domain = `gui/${userInfo().uid}`;
  rmSync(out, { force: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(file, folderCheckPlist({ program, path, home }), { mode: 0o644 });
  runner("launchctl", ["bootout", `${domain}/${CHECK_LABEL}`]);
  let result = null;
  if (runner("launchctl", ["bootstrap", domain, file])) {
    for (const end = Date.now() + waitMs; Date.now() < end && result === null;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { result = JSON.parse(readFileSync(out, "utf8")); } catch { result = null; }
    }
  }
  runner("launchctl", ["bootout", `${domain}/${CHECK_LABEL}`]);
  rmSync(file, { force: true });
  return result;
}
