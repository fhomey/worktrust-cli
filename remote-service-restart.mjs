/**
 * THE SERVICE COMES BACK ON THE NEW RELEASE, AND SAYS SO (CLI 0.11.26; the owner's iMac, twice in November 2026: after
 * `npx worktrust@latest update` io.worktrust.remote was NOT loaded, its plist already naming the new launcher, and the phone
 * had no link until `npx worktrust remote app --no-pair`, which then sat four minutes once). Split from remote-service.mjs.
 *
 * WHAT WENT WRONG (0.11.15 to 0.11.25, remote-service.mjs before this file):
 *   1. installService ran `bootout` and at once `bootstrap`, and nothing looked again. launchd may still be removing the old
 *      job when bootout returns (or the 15 s the runner gives a call ran out while the daemon was stopping), and then it
 *      refuses the bootstrap: the plist is rewritten, nothing is loaded. Nobody retried.
 *   2. serviceOnRelease asked an idle daemon to hand over and waited 15 s for daemon.json to name the new release. The old
 *      daemon keeps its daemon.json until the very end of its stop, so while the handover job was booting it out the update
 *      saw "idle and unchanged" and re-installed AT THE SAME TIME: two movers, each `bootout` + `bootstrap` of one label.
 *      Or it saw no daemon and a rewritten plist and said "Remote Agent is starting" without asking launchd anything.
 *   3. The next update found the plist already on its release and said "Already up to date. Nothing changed.": a service
 *      left unloaded stayed unloaded through every later update.
 *   4. `remote app` said "✓ This computer is connected" right after the bootstrap, without waiting for anything.
 *
 * NOW (every wait has a deadline and a line before it; every launchctl and systemctl goes through systemRunner(home)):
 *   - update, the unit on an older release: a daemon that hands over is asked and the update waits for the move to END (a
 *     handover job in flight is never raced); a busy one is left to move when its task ends; otherwise the update itself
 *     re-installs. A refused bootstrap waits until launchd has let go of the old job and tries again, three times at most.
 *   - update, the unit already on this release but no daemon of it running: brought back without cutting anything
 *     (launchd: `kickstart` when loaded, `bootstrap` when not; systemd: `daemon-reload` + `start`).
 *   - never for a computer whose Remote Agent is switched off or has no service; never a pairing, never a question.
 *   - then it waits (20 s) for the daemon of this release to say it runs (daemon.json) and is connected (link.json), and
 *     returns ONE honest line: { ok, line }, ok false only when the service does not run the new release.
 *   - Windows has no service (remote-service.mjs): nothing here runs there.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./package-integrity.mjs";
import { ALWAYS_UPDATE_LINE, alwaysDaemon, refusedFor, systemRunner } from "./remote-service-home.mjs";
import { DAEMON_FILE, LABEL, RESTART_FILE, UNIT, entryOf, handoverPlistPath, daemonState, installService, installedProgram, installedRelease, isHandoverLauncher, launcherVersion, newerRelease, serviceState, servicePlatform } from "./remote-service.mjs";

export const ASK_MS = 30_000, RESTART_MS = 20_000, SETTLE_MS = 20_000, TAKE_MS = 6_000, BUSY_MS = 15_000, STALE_JOB_MS = 120_000;
export const FIX = "npx worktrust remote app --no-pair";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remoteFile = (home, name) => join(home, ".worktrust", "remote", name);
const domain = () => `gui/${userInfo().uid}`;
const lives = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** daemon.json of a LIVING process, whatever its `handover` says (daemonState asks that too): { pid, version, busy, handover }. */
export function anyDaemon(home = homedir()) {
  try {
    const s = JSON.parse(readFileSync(remoteFile(home, DAEMON_FILE), "utf8"));
    return Number.isSafeInteger(s?.pid) && s.pid > 1 && lives(s.pid) ? { pid: s.pid, version: String(s.version ?? ""), busy: s.busy === true, handover: s.handover === true } : null;
  } catch { return null; }
}
/** Remote Agent switched on here (settings.json `enabled`, written by `remote app`, cleared by `remote disable`). */
export function switchedOn(home = homedir()) { try { return JSON.parse(readFileSync(remoteFile(home, "settings.json"), "utf8"))?.enabled === true; } catch { return false; } }

/**
 * THE LINK, KEPT BY THE DAEMON (remote-run.mjs, on every gateway state): link.json { state: connected|offline, since, pid,
 * version }, written only when it changes, so `since` is when it last connected or went offline. Read only while that
 * process lives. 0600, in ~/.worktrust/remote; it holds no key and no content.
 */
export const LINK_FILE = "link.json";
export function keepLink(state, { home = homedir(), version = null, pid = process.pid, now = Date.now } = {}) {
  if (!["ready", "closed", "held", "stopped", "waiting"].includes(state)) return false; // "open": not yet either
  const next = state === "ready" ? "connected" : "offline";
  try { const kept = JSON.parse(readFileSync(remoteFile(home, LINK_FILE), "utf8")); if (kept?.pid === pid && kept.state === next) return false; } catch { /* none yet */ }
  try { writePrivateFile(remoteFile(home, LINK_FILE), `${JSON.stringify({ v: 1, state: next, since: now(), pid, version })}\n`); return true; } catch { return false; }
}
export function keptLink({ home = homedir(), alive = lives } = {}) {
  try {
    const k = JSON.parse(readFileSync(remoteFile(home, LINK_FILE), "utf8"));
    if (!["connected", "offline"].includes(k?.state) || !Number.isSafeInteger(k.since) || !Number.isSafeInteger(k.pid) || k.pid <= 1 || !alive(k.pid)) return null;
    return { state: k.state, since: k.since, pid: k.pid };
  } catch { return null; }
}
const keptGateway = (home) => { try { const k = JSON.parse(readFileSync(remoteFile(home, "gateway.json"), "utf8")); return ["held", "stopped"].includes(k?.state) && lives(k.pid) ? k : null; } catch { return null; } };
const keptStop = (home) => (keptGateway(home)?.state === "stopped" ? keptGateway(home) : null);

/** A handover job under way: its plist exists and is fresh (the job removes it when it ends; the daemon when launchd refused it). */
const jobInFlight = (home) => { try { return Date.now() - statSync(handoverPlistPath(home)).mtimeMs < STALE_JOB_MS; } catch { return false; } };

/**
 * RE-INSTALL AND MAKE SURE LAUNCHD TOOK IT (installService first: a leftover handover job out, the plist written, bootout,
 * bootstrap). launchd refuses a bootstrap while it still holds the old job; then: wait (bounded) until `print` no longer
 * finds it, and bootstrap again, three times at most. → { kind, file, started, why, failed: null|"bootout"|"bootstrap"|"restart" }
 */
export async function reloadService({ program, path, platform = process.platform, home = homedir(), runner = systemRunner(home), fromHandover = false, clock = Date.now, sleep = pause, budgetMs = RESTART_MS }) {
  const done = installService({ program, path, platform, home, runner, fromHandover });
  if (done.started || done.why || done.kind === "foreground") return { ...done, failed: null };
  if (done.kind === "systemd") return { ...done, failed: "restart" };
  const target = `${domain()}/${LABEL}`, end = clock() + budgetMs;
  for (let tries = 1; tries <= 3; tries += 1) {
    while (runner("launchctl", ["print", target]) && clock() < end) await sleep(500); // still held: the old job is leaving
    if (clock() >= end) break;
    if (runner("launchctl", ["bootstrap", domain(), done.file])) return { ...done, started: true, failed: null };
    await sleep(1000);
  }
  return { ...done, failed: runner("launchctl", ["print", target]) ? "bootout" : "bootstrap" };
}

/** The unit already names this release but no daemon of it runs: started without cutting anything that does run. */
async function bringBack({ installed, platform, home, runner, clock, sleep }) {
  const kind = servicePlatform(platform), why = refusedFor(runner, home);
  if (kind === "systemd") { const started = runner("systemctl", ["--user", "daemon-reload"]) && runner("systemctl", ["--user", "start", UNIT]); return { kind, started, why, failed: started || why ? null : "start" }; }
  // kickstart without -k starts a job launchd holds but does not run, and leaves a running one alone
  if (runner("launchctl", ["print", `${domain()}/${LABEL}`])) { const started = runner("launchctl", ["kickstart", `${domain()}/${LABEL}`]); return { kind, started, why, failed: started || why ? null : "kickstart" }; }
  return reloadService({ program: installed.program, path: installed.path ?? "", platform, home, runner, clock, sleep });
}

/** Wait (bounded) for the daemon of `version` to run and, when `connect`, to be connected. → { running, connected, stopped } */
export async function settle({ version, home = homedir(), connect = true, clock = Date.now, sleep = pause, waitMs = SETTLE_MS }) {
  for (const end = clock() + waitMs; ;) {
    const d = anyDaemon(home), running = d?.version === version, link = running ? keptLink({ home }) : null;
    const connected = running && link?.state === "connected" && link.pid === d.pid, stopped = running ? keptStop(home) : null;
    if ((running && (!connect || connected)) || stopped || clock() >= end) return { running, connected, stopped: stopped ? stopped.code ?? "unknown" : null };
    await sleep(250);
  }
}

const FAILED = { bootout: "launchd still held the old job", bootstrap: "launchd refused to load the rewritten service", kickstart: "launchd did not start it", start: "systemd did not start it", restart: "systemd did not restart it" };
/** The one line, and whether the service runs the new release. */
export function verdict(done, seen, version, { connect = true } = {}) {
  if (done.why) return { ok: false, line: `! Remote Agent was not restarted (${done.why}): the service file is written (${done.file ?? "none"}); no service manager was asked.` };
  if (seen.running && seen.connected) return { ok: true, line: `✓ The service runs the new version (${version}) and is connected.` };
  if (seen.running && seen.stopped !== null) return { ok: true, line: `! The service runs the new version (${version}), but the gateway stopped its connection (close code ${seen.stopped}): npx worktrust remote app links this computer again.` };
  if (seen.running) return { ok: true, line: connect ? `! The service runs the new version (${version}) but is not connected yet; npx worktrust remote status shows why.` : `✓ The service runs the new version (${version}).` };
  if (done.failed) return { ok: false, line: `! The Remote Agent service did not come back on ${version}: ${FAILED[done.failed] ?? done.failed}. Fix: ${FIX}` };
  return { ok: false, line: `! The Remote Agent service was started on ${version} but did not report within ${SETTLE_MS / 1000} s. npx worktrust remote run shows why it stops.` };
}

/**
 * THE UPDATE'S STEP (worktrust.mjs `update`, and `remote handover` with `direct`): the service, when installed and switched
 * on, onto `program` (this release's runtime, the PATH the unit already had) and running. → { ok, line } or null (no service,
 * switched off, or already running this release: nothing to say). `say` gets one line before any wait.
 */
export async function serviceOnRelease({ program, version, platform = process.platform, home = homedir(), runner = systemRunner(home), direct = false, waitMs = ASK_MS, settleMs = SETTLE_MS, clock = Date.now, sleep = pause, say = () => {} }) {
  if (servicePlatform(platform) === "foreground") return null;
  if (alwaysDaemon(platform)) return { ok: true, line: ALWAYS_UPDATE_LINE }; // CLI 0.11.27: a system daemon moves only with root (remote-always.mjs); never a LaunchAgent beside it
  let installed = installedProgram({ platform, home });
  if (!installed || !switchedOn(home)) return null; // never created here, and never started when switched off
  const on = (unit) => entryOf(unit.program) === entryOf(program);
  if (on(installed) && (direct || anyDaemon(home)?.version === version)) return null;
  const finish = async (done) => verdict(done, done.why ? {} : await settle({ version, home, clock, sleep, waitMs: done.failed ? 0 : settleMs }), version); // nothing to wait for after a refused load
  const deferred = (d) => ({ ok: true, line: `Remote Agent still runs ${d.version}: a task is running. It moves to ${version} when the task finishes, or at the next npx worktrust update.` });
  say(`  Remote Agent: bringing the service onto ${version} (at most a minute)…`);
  // A HANDOVER JOB UNDER WAY FINISHES FIRST (two movers of one label leave it unloaded): bounded, then read again.
  for (const end = clock() + waitMs; !direct && jobInFlight(home) && clock() < end;) await sleep(500);
  installed = installedProgram({ platform, home }) ?? installed;
  const daemon = direct ? null : anyDaemon(home), current = on(installed);
  if (current && daemon?.version === version) return finish({ kind: servicePlatform(platform), started: true, failed: null });
  if (current && !daemon) return finish(await bringBack({ installed, platform, home, runner, clock, sleep })); // no daemon runs: nothing to cut
  if (daemon?.handover && !current && isHandoverLauncher(entryOf(program), home)) {
    // ASKED: the daemon moves itself when nothing is at work (createHandover). Wait for that move to END, never beside it.
    writePrivateFile(remoteFile(home, RESTART_FILE), `${JSON.stringify({ v: 1, version, at: Date.now() })}\n`);
    for (const asked = clock(), end = asked + waitMs; ;) {
      const d = anyDaemon(home), flying = jobInFlight(home);
      if (d?.version === version) return finish({ kind: servicePlatform(platform), started: true, failed: null });
      if (!flying && !d) break; // the old daemon is gone and no job is at work: brought back below
      if (!flying && d && !d.busy && clock() - asked >= TAKE_MS) break; // idle and not taking the ask (a key it does not know)
      if (!flying && d?.busy && (clock() - asked >= BUSY_MS || clock() >= end)) return deferred(d);
      if (clock() >= end) break; // a job that has not finished by now is stuck: the re-install below boots it out first
      await sleep(500);
    }
    const now = installedProgram({ platform, home });
    if (now && entryOf(now.program) === entryOf(program) && !anyDaemon(home)) { rmSync(remoteFile(home, RESTART_FILE), { force: true }); return finish(await bringBack({ installed: now, platform, home, runner, clock, sleep })); } // the job wrote it, then did not load it
  } else if (daemon?.busy && current) return deferred(daemon); // an older daemon under a unit rewritten beneath it, at work: not cut
  // A daemon that can hear it (daemon.json) is told why the service manager ends it: it says "restarting" to its phones.
  if (anyDaemon(home)) { try { writePrivateFile(remoteFile(home, RESTART_FILE), `${JSON.stringify({ v: 1, version, at: Date.now(), now: true })}\n`); } catch { /* unsaid */ } }
  let done;
  try { done = await reloadService({ program, path: installed.path ?? process.env.PATH ?? "", platform, home, runner, fromHandover: direct, clock, sleep }); } finally { rmSync(remoteFile(home, RESTART_FILE), { force: true }); }
  return finish(done);
}

/**
 * `remote handover` (internal): the one-shot job's program, run by the NEW launcher. It moves the service only when this is
 * the installed release, newer than the one the unit runs, and the daemon says no task runs (review P3-1); its job file
 * goes whatever happens (P3-2). The job does not boot itself out (that would end it mid-way): the next handover and
 * `remote app` boot it out first.
 */
export async function handoverCommand(io, { home = homedir(), platform = process.platform, runner = systemRunner(home), ...waits } = {}) { // waits: the tests' stopped clock
  try {
    const installed = installedProgram({ platform, home }), unit = installed ? launcherVersion(entryOf(installed.program)) : null;
    const why = installedRelease(home) !== io.version ? "not the installed release" : !installed ? "no service" : !unit || !newerRelease(io.version, unit) ? "not newer than the service" : daemonState(home)?.busy ? "a task is running" : null;
    if (why) return io.say(`  Remote Agent stays as it is (${why}).`);
    const r = await io.prepare();
    const said = await serviceOnRelease({ program: [r.node, ...r.nodeArgs, r.entry, "remote", "run"], version: io.version, platform, home, runner, direct: true, ...waits });
    if (said) io.say(`  ${said.line}`);
  } finally { rmSync(handoverPlistPath(home), { force: true }); }
}

/** `remote app` | `remote web`: the service (re)started on this release, then the bounded wait. → the lines to say, and ok. */
export async function startService(io, runtime, { connect = true, platform = process.platform, home = homedir(), runner = systemRunner(home), clock = Date.now, sleep = pause } = {}) {
  io.say(`  Starting the service${connect ? " and waiting for its connection" : ""} (at most a minute)…`); // said before the first wait
  const done = await reloadService({ program: [runtime.node, ...runtime.nodeArgs, runtime.entry, "remote", "run"], path: process.env.PATH ?? "", platform, home, runner, clock, sleep });
  if (done.why) return { ok: false, lines: [`  ! Not started (${done.why}): the service file is written (${done.file}); no service manager was asked.`] };
  const said = verdict(done, await settle({ version: io.version, home, connect, clock, sleep }), io.version, { connect });
  return { ok: said.ok, lines: [`  ${said.line}`] };
}

const two = (n) => String(n).padStart(2, "0");
const when = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
/** `remote status`: what the service manager, the unit, the daemon and its link each say. */
export function serviceFacts({ platform = process.platform, home = homedir(), runner = systemRunner(home) } = {}) {
  const state = serviceState({ platform, home, runner }), installed = state.installed ? installedProgram({ platform, home }) : null, daemon = anyDaemon(home);
  return { ...state, unit: installed ? launcherVersion(entryOf(installed.program)) : null, runs: daemon?.version ?? null, release: installedRelease(home), link: daemon ? keptLink({ home }) : null, held: Boolean(keptGateway(home)), handover: jobInFlight(home) };
}
export function serviceLines(f, { cli = null } = {}) {
  if (f.kind === "foreground") return ["  Service: none on this system: run `npx worktrust remote run`"];
  if (!f.installed) return ["  Service: not installed (npx worktrust remote app installs it)"];
  const release = f.release ?? cli, loaded = f.kind === "launchd" ? (f.running ? "loaded" : "not loaded") : f.running ? "active" : "not active";
  const runs = f.runs ? `runs ${f.runs}` : "not running", behind = f.runs && release && newerRelease(release, f.runs);
  const hint = f.handover ? ": moving to the new release now" : !f.runs ? `: ${FIX} starts it` : behind ? ": npx worktrust update moves it" : "";
  const lines = [`  Service: installed (${f.kind}), ${loaded} · ${runs} · installed ${release ?? "unknown"}${f.unit && f.unit !== f.runs ? ` · the service file names ${f.unit}` : ""}${hint}`];
  if (f.runs && !f.held) lines.push(f.link ? `  Connection: ${f.link.state === "connected" ? "connected" : "not connected"} since ${when(f.link.since)}` : "  Connection: not reported yet");
  return lines;
}
