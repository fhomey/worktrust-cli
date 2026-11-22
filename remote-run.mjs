/**
 * `worktrust remote run`: THE DAEMON, WIRED (2026-11-07). The service manager starts it (remote-service.mjs), or the
 * person runs it in the foreground (Windows: foreground only). It refuses to start unless remote is enabled, this computer
 * is paired, a gateway is set and this Node has a WebSocket; it holds a lock so one runs per user; it closes as FAILED any
 * command an earlier run left mid-way (never runs it again); it stops every agent it started when it stops, and it exits
 * by itself when `worktrust remote disable` turns remote off.
 *
 * The agents it starts get this user's environment with every WORKTRUST_ variable removed (no measurement credential, no
 * remote secret) and the PATH the person had when they enabled remote.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, writeSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "./remote-protocol.mjs";
import { deskReadOf, loadPreviewGrants, loadRoots } from "./remote-store.mjs";
import { keepReaders, readAlongLine } from "./remote-settings.mjs";
import { sessionProjects } from "./remote-projects.mjs";
import { ensureRemoteDir, gatewayOf, isLoopbackGateway, issuerKeys, loadDeskMarks, loadIdentity, loadKeys, loadPipelineReviews, loadProjects, loadSettings, readJson, remotePath, random, saveIdentity } from "./remote-store.mjs";
import { openJournal } from "./remote-journal.mjs";
import { inventory as listAgents, offered } from "./remote-inventory.mjs";

/** The agents as a phone may use them: what is installed, less what the person has not turned on (Codex). */
const inventory = (o) => offered(listAgents(o), loadSettings());
import { createApprovals } from "./remote-approvals.mjs";
import { createSessions } from "./remote-sessions.mjs";
import { createTerminalSessions, withTerminal } from "./remote-terminal-sessions.mjs";
import { createTmux, NO_TMUX, writeTmuxConfig } from "./remote-adapter-terminal.mjs";
import { detectScreen } from "./remote-screen-states.mjs";
import { createReleases } from "./remote-releases.mjs";
import { createPipelines } from "./remote-pipeline.mjs";
import { createAttachments } from "./remote-attachments.mjs";
import { createPreview } from "./remote-preview.mjs";
import { createLivePreview } from "./remote-live-preview.mjs";
import { SETTING_WORDS } from "./remote-admin.mjs";
import { appendPipelineMark } from "./remote-steered.mjs";
import { createDaemonCore } from "./remote-daemon.mjs";
import { createDesk } from "./remote-desk-sessions.mjs";
import { connectGateway, gatewayLine, keepGatewayState, keptGatewayState, webSocketAvailable } from "./remote-transport.mjs";
import { createHealthMonitor, fixtureReaders, HEALTH_REFUSAL, healthLine, keepHealth } from "./remote-health.mjs";
import { createHandover, daemonBusy, holdDuring, ownLauncher, restartAsked } from "./remote-service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (kind, fields = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`);
// A browser a phone added (2026-11-09, remote-endorse.mjs) is said in words too, so it is never news only in a JSON line.
// WHO READS ALONG NOW, for `remote status` (0.11.19, review P3-6): kept from the follow's own start and end lines, by ids, never a word of a session.
const readers = new Map();
const notice = (kind, fields) => {
  if (kind === "read_along") { if (fields.on) readers.set(fields.phone, { phone: fields.phone, project_id: fields.project_id, since: Date.now() }); else readers.delete(fields.phone); keepReaders([...readers.values()]); }
  if (kind === "browser_endorsed") process.stderr.write(`  ! A browser was added by your phone ${fields.by}: ${fields.fingerprint}. See or remove it: npx worktrust remote phones\n`);
  // Part B: a change approved in the app or on the web with the authenticator, signed by WorkTrust and verified here.
  if (kind === "session_refused") process.stderr.write(`  ! A new session from a phone or browser was refused: ${HEALTH_REFUSAL}. Running sessions continue.\n`);
  if (kind === "read_along" && fields.why !== "refused") process.stderr.write(`${readAlongLine(fields)}\n`); // CLI 0.11.19: who reads along with a desk session, in which folder (never a word of it)
  if (kind === "settings_changed") process.stderr.write(`  ! ${SETTING_WORDS[fields.setting] ?? "a remote setting"} changed from ${fields.by}, approved there with your authenticator. To keep every change at this keyboard: npx worktrust remote admin off\n`);
};
const logged = (kind, fields = {}) => { log(kind, fields); notice(kind, fields); };

/**
 * THE GATEWAY'S ERRORS, WRITTEN ONCE AN HOUR PER REASON (CLI 0.11.20; the owner's log held `gateway_error not_paired` every 15
 * seconds for days). The gateway keeps its channels in memory: after it restarts, a channel of a phone or browser that has not
 * said hello since is unknown to it, and every event sealed for that channel (the health sample, every 15 seconds) is answered
 * `not_paired`, without saying which channel. The first of a reason is written at once; the repeats within the hour are counted
 * and said with the next one (`repeated`). Nothing else changes: what is sent and what is kept are as before.
 */
export function createErrorLog({ log, now = Date.now, quietMs = 60 * 60_000 }) {
  const seen = new Map();
  return {
    note(reason) {
      const at = now(), last = seen.get(reason);
      if (last && at - last.since < quietMs) { last.count += 1; return false; }
      log("gateway_error", { reason, ...(last?.count ? { repeated: last.count } : {}) });
      seen.set(reason, { since: at, count: 0 });
      return true;
    },
  };
}

export function agentEnv(settings, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!/^WORKTRUST_/.test(key) && !/^CLAUDE_?CODE/.test(key) && key !== "CLAUDECODE") env[key] = value;
  if (settings.agent_path) env.PATH = settings.agent_path;
  return env;
}

/** A pipeline stage's environment: the agents' (no WORKTRUST_ variable), the reviewed folders first on PATH, CI set. */
export function stageEnv(settings, prepend = [], base = process.env) {
  const env = agentEnv(settings, base);
  env.PATH = [...prepend, env.PATH ?? ""].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
  env.CI = "1";
  return env;
}

/**
 * Agents run in process groups of their own, so a daemon that crashed leaves them running. A new daemon ends every group
 * an earlier one recorded whose process is still that session's agent (its command line names the session's own id),
 * before it takes any command (review 2026-11-07, P2-b).
 */
/** A process's command line, or "" (the reapers check it is still the process they recorded before they end it). */
export function commandOf(pid) {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }); } catch { return ""; }
}

export function reapOrphans(journal, kill = process.kill.bind(process)) {
  let reaped = 0;
  for (const s of journal.sessions()) {
    if (!Number.isSafeInteger(s.pid) || s.pid <= 1 || !s.agent_session_ref) continue;
    let command = "";
    try { command = execFileSync("ps", ["-o", "command=", "-p", String(s.pid)], { encoding: "utf8", timeout: 5000 }); } catch { command = ""; }
    if (!command.includes(s.agent_session_ref)) { journal.recordSession({ session_id: s.session_id, pid: null }); continue; }
    try { kill(-s.pid, "SIGTERM"); reaped += 1; } catch { /* gone */ }
    journal.recordSession({ session_id: s.session_id, pid: null });
  }
  return reaped;
}

function lock() {
  const file = remotePath("daemon.lock");
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, String(process.pid)); closeSync(fd);
  } catch {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
    if (alive) throw new Error(`another remote daemon runs (pid ${pid})`);
    rmSync(file, { force: true });
    return lock();
  }
  return () => rmSync(file, { force: true });
}

export async function runDaemon({ say = (l) => process.stdout.write(`${l}\n`), version = null } = {}) {
  ensureRemoteDir();
  const settings = loadSettings(), identity = loadIdentity(), keys = loadKeys();
  if (!settings.enabled) throw new Error("remote is off on this computer: run `worktrust remote app` (or `remote web`)");
  if (!identity || !keys) throw new Error("this computer is not paired for remote: run `worktrust remote app` (or `remote web`)");
  // A computer saved with `gateway: null` (0.11.8 and 0.11.9 saved that when none was given) uses WorkTrust's relay: no new
  // approval is needed (owner, 2026-11-14: on by default).
  const gateway = gatewayOf(settings);
  if (!webSocketAvailable()) throw new Error(`remote needs Node 22.4 or later (this is ${process.versions.node})`);
  const keysOf = issuerKeys(gateway);
  const claims = P.verifyBinding(identity.binding, { issuerKeys: keysOf, now: Date.now(), kind: "computer", deviceId: identity.device_id });
  if (!claims.ok) throw new Error(`this computer's binding does not verify (${claims.code}): run \`worktrust remote app\` (or \`remote web\`) again`);
  if (claims.value.exp * 1000 - Date.now() < 7 * 86400_000 && identity.origin) {
    // A binding lives thirty days: renewed in its last week while the device is still approved (docs/remote-agents/ISSUER.md §4).
    const { renewBinding } = await import("./remote-pairing.mjs");
    const fresh = await renewBinding({ origin: identity.origin, identity, secret: keys.secret }).catch(() => null);
    const checked = fresh && P.verifyBinding(fresh, { issuerKeys: keysOf, now: Date.now(), kind: "computer", deviceId: identity.device_id });
    if (checked?.ok && checked.value.ed25519_pub === claims.value.ed25519_pub) { saveIdentity({ ...identity, binding: fresh }); identity.binding = fresh; }
    else log("binding_not_renewed", {});
  }
  const release = lock();
  const journal = openJournal(remotePath("journal.jsonl"));
  for (const id of journal.interrupted()) journal.advance(id, { kind: "failed" }, Date.now(), "interrupted"); // never run again
  if (process.platform !== "win32") reapOrphans(journal);
  journal.compact(Date.now());
  const runDir = remotePath("run");
  let transport = null;
  const local = { secret: keys.secret, binding: identity.binding, claims: claims.value };
  // A session's project, as sessions themselves resolve it (0.11.18): a granted project or an existing git project inside a
  // root, by the inventory's id. The files looked among the granted ones only, so a session in a root project (0.11.7) was
  // refused every file from the phone, and the prompt that named it.
  const reachable = () => sessionProjects({ projects: loadProjects, roots: loadRoots, projectSecret: keys.projectSecret });
  const sessionProject = (id) => { const s = journal.session(id); return s ? reachable().find((p) => p.project_id === s.project_id) ?? null : null; };
  // A preview needs its OWN grant at the keyboard, on a project granted by itself: one reachable only through a root has none
  // to give (a grant left behind by a project since un-granted must not come back to life through its root).
  const grantedProject = (id) => { const s = journal.session(id); return s ? loadProjects().find((p) => p.project_id === s.project_id) ?? null : null; };
  // Files from the phone (into the session's project inbox) and the local preview (2026-11-07).
  const attachments = createAttachments({ journal, now: Date.now, emit: (...a) => core.emit(...a), log, sessionProject });
  const preview = createPreview({ emit: (...a) => core.emit(...a), projects: loadProjects, grants: loadPreviewGrants, env: () => agentEnv(loadSettings()), log });
  // The live preview (release 19): the session's granted page, live, over the browser's pipe; one per computer.
  const live = createLivePreview({ emit: (...a) => core.emit(...a), grants: loadPreviewGrants, env: () => agentEnv(loadSettings()), log, now: Date.now, sessionProject: grantedProject });
  // Continue a session on this computer (release 36): its own Claude Code sessions in the projects a phone may reach.
  const desk = createDesk({ projects: reachable, journal });
  let health = null; // the sampler below (remote-health.mjs): every 15 s, local numbers, no model
  const core = createDaemonCore({ local, issuerKeys: keysOf, journal, projectSecret: keys.projectSecret, attachments, preview, live, desk, agentEnv: () => agentEnv(loadSettings()), now: Date.now, random, log: logged, health: () => health?.latest() ?? null, version, send: (f, how) => transport?.send(f, how) ?? false, room: () => transport?.room(), inventory: (refresh) => inventory({ env: agentEnv(loadSettings()), refresh }), online: () => transport?.ready() ?? false, approvals: null });
  const ctx = { journal, now: Date.now, random, deviceId: identity.device_id, emit: core.emit, paused: () => loadSettings().paused !== null || !loadSettings().enabled, phoneOnline: core.phoneOnline, controllers: core.controllers };
  const approvals = createApprovals(ctx);
  const socket = await approvals.listen(runDir);
  let releases = null; // set below; the hooks run only once events flow
  let handover = null; const hold = holdDuring(() => Boolean(handover?.handing)); // 0.11.15: nothing new starts while it hands over
  const sessions = createSessions({ ...ctx, approvals, runDir, node: process.execPath, bridgePath: join(HERE, "remote-approval-bridge.mjs"), socket: () => socket,
    // A session runs in a granted project or in an existing project inside a root (0.11.7), each by the inventory's id.
    settings: loadSettings, projects: reachable, inventory: () => inventory({ env: agentEnv(loadSettings()) }), agentEnv: () => agentEnv(loadSettings()), replay: core.replay,
    onTaskEnded: (id, outcome) => releases.taskEnded(id, outcome), onActivity: () => releases?.activity(),
    onSessionsChanged: () => core.emit(null, "device.inventory", core.inventoryBody(false)), attachments, desk });
  ctx.onApprovalOpened = sessions.onApprovalOpened; ctx.onApprovalSettled = sessions.onApprovalSettled;
  // Terminal sessions (release 19, off until `worktrust remote terminal on`): Claude Code in tmux on WorkTrust's own socket.
  const tmuxFile = listAgents({ env: agentEnv(loadSettings()) }).files.tmux;
  const tmux = tmuxFile ? createTmux({ file: tmuxFile, config: writeTmuxConfig(runDir), env: agentEnv(loadSettings()) }) : NO_TMUX;
  const terminal = createTerminalSessions({ journal, now: Date.now, emit: core.emit, settings: loadSettings, projects: loadProjects, inventory: () => inventory({ env: agentEnv(loadSettings()) }),
    tmux, claudeFile: () => listAgents({ env: agentEnv(loadSettings()) }).files["claude-code"], replay: core.replay, running: () => sessions.runningCount(), detect: (lines) => detectScreen("claude-code", lines), approvals, desk,
    onSessionsChanged: () => core.emit(null, "device.inventory", core.inventoryBody(false)) });
  const registry = withTerminal(sessions, terminal);
  // Releases and pipelines (2026-11-07): one queue for every release's tasks, the reviewed pipeline of each project.
  const pipelines = createPipelines({ journal, now: Date.now, random, emit: core.emit, projects: loadProjects, reviews: loadPipelineReviews, log, logDir: remotePath("pipelines"),
    markLedger: appendPipelineMark, env: (prepend) => stageEnv(loadSettings(), prepend), onEnded: (p) => releases?.pipelineEnded(p), commandOf });
  releases = createReleases({ journal, now: Date.now, random, emit: core.emit, projects: loadProjects, settings: loadSettings, paused: hold.paused(ctx.paused), inventory: () => inventory({ env: agentEnv(loadSettings()) }),
    sessions, pipelines: hold.pipelines(pipelines), deskMarks: loadDeskMarks, log });
  // The agent plans its own work (plan_* over the approval socket, 2026-11-08): the same queue, the session's own project.
  ctx.plan = hold.plan((session, op, args) => releases.plan(session, op, args));
  releases.recover(); // tasks an earlier daemon left running: interrupted, never run again
  pipelines.recover(); // and its pipeline runs
  core.attach(registry, approvals, releases);
  // A NEWER RELEASE, TAKEN OVER WHEN NOTHING IS AT WORK (0.11.15, remote-service.mjs createHandover and daemonBusy); while it
  // hands over no command is taken (the phone resends it, unanswered, to the next daemon) and nothing new starts (hold).
  handover = version ? createHandover({ version, log, own: ownLauncher(HERE), announce: (to) => core.announceRestart(to), busy: () => daemonBusy({ sessions, journal, pipelines, terminal, approvals, live, attachments }) }) : null;

  const gatewayErrors = createErrorLog({ log });
  const dispatchFrame = async (frame) => {
    if (frame.frame === "hello") core.receiveHello(frame.hello);
    else if (frame.frame === "command") { if (handover?.handing) return log("command_held", {}); await core.receiveCommand(frame.envelope); }
    else if (frame.frame === "relay") { log("relay", { type: frame.event?.type ?? null }); if (frame.event?.type === "device.revoked") core.peerRevoked(frame.event); }
    else if (frame.frame === "error") {
      gatewayErrors.note(typeof frame.reason === "string" ? frame.reason.slice(0, 40) : null);
      // A gateway older than device.health answers it `error: shape` (and closes nothing): rest the samples half an hour.
      if (frame.reason === "shape" && Date.now() - healthSentAt < 5000) { healthRestUntil = Date.now() + 30 * 60_000; log("health_rested", { minutes: 30 }); }
    }
  };
  // THE COMPUTER'S HEALTH (2026-11-15): kept here for `remote status` and the menu, said in the run terminal when it turns
  // red or back, and sealed for the paired phones and browsers on the transient lane (the gateway keeps none of it).
  let healthSentAt = 0, healthRestUntil = 0, healthSaid = null;
  const healthFixture = isLoopbackGateway(gateway) ? process.env.WORKTRUST_REMOTE_HEALTH_FIXTURE ?? null : null; // tests on the dev relay only
  health = createHealthMonitor({ log, ...(healthFixture ? fixtureReaders(healthFixture) : {}), onSample: (body) => {
    keepHealth(body);
    if (body.level !== healthSaid && (body.level === "red" || healthSaid === "red")) process.stderr.write(`${healthLine(body)}\n`);
    healthSaid = body.level;
    if (Date.now() >= healthRestUntil && transport?.ready()) { healthSentAt = Date.now(); core.emitHealth(body); }
  } });
  let sentCode = null;
  const registerCode = (again = false) => {
    const invite = readJson("invite.json");
    if (invite?.code && !invite.used && invite.e * 1000 > Date.now() && (again || sentCode !== invite.code) && transport?.send({ frame: "pair_ticket", ticket: invite.code, expires_at: invite.e * 1000 })) sentCode = invite.code;
  };
  // The production gateway admits a computer on a five-minute assertion from the issuer, asked fresh for every challenge.
  const { requestAssertion } = await import("./remote-pairing.mjs");
  const authorize = () => (identity.origin ? requestAssertion({ origin: identity.origin, deviceId: identity.device_id, secret: keys.secret }) : Promise.resolve(null));
  transport = connectGateway({ url: gateway, identity, signingSecret: keys.secret.ed25519, log, authorize, onFrame: (f) => { dispatchFrame(f).catch((e) => log("frame_failed", { name: e?.name ?? "Error" })); },
    onState: (state, info) => { log("gateway", { state, ...info }); keepGatewayState(state, info); if (state === "held" || state === "stopped") process.stderr.write(`${gatewayLine(keptGatewayState())}\n`); if (state === "ready") registerCode(true); } });
  say(`  WorkTrust remote is running for ${identity.device_id} (gateway ${new URL(gateway).host}). Ctrl+C stops it.`);
  let stopping = false;
  // `signal`: the service manager ends it. When an update asked for that (restartAsked: restart.json, or a newer installed
  // release), the phones that read `cli` are told "restarting" first; a plain stop, a disable or a shutdown says nothing.
  const stop = async (code = 0, signal = false) => {
    if (stopping) return;
    stopping = true;
    if (signal && version) { try { const to = restartAsked(); if (to !== null) core.announceRestart(to); } catch { /* unsaid: the phone sees it offline */ } }
    approvals.close();
    health.stop();
    await pipelines.stopAll();
    await live.stopAll(); // the browser ended, its profile removed
    await registry.stopAll(); // the structured agents; a terminal session lives on in tmux
    transport.close();
    handover?.stop();
    release();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0, true));
  // WHAT A PHONE MAY REACH, TOLD AT ONCE (0.11.12, owner 2026-11-15): a grant made at this keyboard (the access step after
  // "Phone linked", Remote Agent › Roots or › Projects) changes the lists another process wrote; the next tick sends the
  // inventory again, sealed, so a phone waiting on "Choose access at your computer" learns it from this computer, not a server.
  // The baseline is what stood when the daemon started (0.11.19: until then it was taken at the first tick, so a change in the first three seconds was never told).
  const reach = () => [...loadRoots().map((r) => r.root_id), "|", ...loadProjects().map((p) => p.project_id), "|", deskReadOf(loadSettings()) /* 0.11.19: also what the keyboard lets a phone read of the desk */].join(","); let grants = null; try { grants = reach(); } catch { /* unreadable now: the first tick that reads it is the baseline */ } const grantsChanged = () => { const now = reach(); const changed = grants !== null && now !== grants; grants = now; return changed; };
  keepReaders([]); // nobody reads along yet: an older daemon's list is not this one's
  setInterval(() => { const s = loadSettings(); if (!s.enabled) stop(0); if (readers.size > 0) keepReaders([...readers.values()]); registerCode(); releases.poll(); try { handover?.tick(); } catch { log("handover_error", {}); } try { if (grantsChanged()) core.emit(null, "device.inventory", core.inventoryBody(false)); } catch { /* an unreadable list: told at the next ask */ } }, 3000).unref();
  releases.schedule(); // queued tasks a restart kept
  handover?.start();
  health.start();
  return new Promise(() => {});
}
