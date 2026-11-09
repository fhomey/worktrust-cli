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
import { loadPreviewGrants } from "./remote-store.mjs";
import { ensureRemoteDir, issuerKeys, loadDeskMarks, loadIdentity, loadKeys, loadPipelineReviews, loadProjects, loadSettings, readJson, remotePath, random, saveIdentity } from "./remote-store.mjs";
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
import { appendPipelineMark } from "./remote-steered.mjs";
import { createDaemonCore } from "./remote-daemon.mjs";
import { connectGateway, webSocketAvailable } from "./remote-transport.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (kind, fields = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`);

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

export async function runDaemon({ say = (l) => process.stdout.write(`${l}\n`) } = {}) {
  ensureRemoteDir();
  const settings = loadSettings(), identity = loadIdentity(), keys = loadKeys();
  if (!settings.enabled) throw new Error("remote is off on this computer: run `worktrust remote enable`");
  if (!identity || !keys) throw new Error("this computer is not paired for remote: run `worktrust remote enable`");
  if (!settings.gateway) throw new Error("no gateway is set: the production gateway is not live yet; for local tests pass --gateway ws://127.0.0.1:<port> to `worktrust remote enable`");
  if (!webSocketAvailable()) throw new Error(`remote needs Node 22.4 or later (this is ${process.versions.node})`);
  const keysOf = issuerKeys(settings.gateway);
  const claims = P.verifyBinding(identity.binding, { issuerKeys: keysOf, now: Date.now(), kind: "computer", deviceId: identity.device_id });
  if (!claims.ok) throw new Error(`this computer's binding does not verify (${claims.code}): run \`worktrust remote enable\` again`);
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
  // Files from the phone (into the session's project inbox) and the local preview (2026-11-07).
  const attachments = createAttachments({ journal, now: Date.now, emit: (...a) => core.emit(...a), log,
    sessionProject: (id) => { const s = journal.session(id); return s ? loadProjects().find((p) => p.project_id === s.project_id) ?? null : null; } });
  const preview = createPreview({ emit: (...a) => core.emit(...a), projects: loadProjects, grants: loadPreviewGrants, env: () => agentEnv(loadSettings()), log });
  // The live preview (release 19): the session's granted page, live, over the browser's pipe; one per computer.
  const live = createLivePreview({ emit: (...a) => core.emit(...a), grants: loadPreviewGrants, env: () => agentEnv(loadSettings()), log, now: Date.now,
    sessionProject: (id) => { const s = journal.session(id); return s ? loadProjects().find((p) => p.project_id === s.project_id) ?? null : null; } });
  const core = createDaemonCore({ local, issuerKeys: keysOf, journal, projectSecret: keys.projectSecret, attachments, preview, live, now: Date.now, random, log, send: (f) => transport?.send(f) ?? false, inventory: (refresh) => inventory({ env: agentEnv(loadSettings()), refresh }), online: () => transport?.ready() ?? false, approvals: null });
  const ctx = { journal, now: Date.now, random, deviceId: identity.device_id, emit: core.emit, paused: () => loadSettings().paused !== null || !loadSettings().enabled, phoneOnline: core.phoneOnline, controllers: core.controllers };
  const approvals = createApprovals(ctx);
  const socket = await approvals.listen(runDir);
  let releases = null; // set below; the hooks run only once events flow
  const sessions = createSessions({ ...ctx, approvals, runDir, node: process.execPath, bridgePath: join(HERE, "remote-approval-bridge.mjs"), socket: () => socket,
    settings: loadSettings, projects: loadProjects, inventory: () => inventory({ env: agentEnv(loadSettings()) }), agentEnv: () => agentEnv(loadSettings()), replay: core.replay,
    onTaskEnded: (id, outcome) => releases.taskEnded(id, outcome), onActivity: () => releases?.activity(),
    onSessionsChanged: () => core.emit(null, "device.inventory", core.inventoryBody(false)), attachments });
  ctx.onApprovalOpened = sessions.onApprovalOpened; ctx.onApprovalSettled = sessions.onApprovalSettled;
  // Terminal sessions (release 19, off until `worktrust remote terminal on`): Claude Code in tmux on WorkTrust's own socket.
  const tmuxFile = listAgents({ env: agentEnv(loadSettings()) }).files.tmux;
  const tmux = tmuxFile ? createTmux({ file: tmuxFile, config: writeTmuxConfig(runDir), env: agentEnv(loadSettings()) }) : NO_TMUX;
  const terminal = createTerminalSessions({ journal, now: Date.now, emit: core.emit, settings: loadSettings, projects: loadProjects, inventory: () => inventory({ env: agentEnv(loadSettings()) }),
    tmux, claudeFile: () => listAgents({ env: agentEnv(loadSettings()) }).files["claude-code"], replay: core.replay, running: () => sessions.runningCount(), detect: (lines) => detectScreen("claude-code", lines), approvals,
    onSessionsChanged: () => core.emit(null, "device.inventory", core.inventoryBody(false)) });
  const registry = withTerminal(sessions, terminal);
  // Releases and pipelines (2026-11-07): one queue for every release's tasks, the reviewed pipeline of each project.
  const pipelines = createPipelines({ journal, now: Date.now, random, emit: core.emit, projects: loadProjects, reviews: loadPipelineReviews, log, logDir: remotePath("pipelines"),
    markLedger: appendPipelineMark, env: (prepend) => stageEnv(loadSettings(), prepend), onEnded: (p) => releases?.pipelineEnded(p), commandOf });
  releases = createReleases({ journal, now: Date.now, random, emit: core.emit, projects: loadProjects, settings: loadSettings, paused: ctx.paused, inventory: () => inventory({ env: agentEnv(loadSettings()) }),
    sessions, pipelines, deskMarks: loadDeskMarks, log });
  // The agent plans its own work (plan_* over the approval socket, 2026-11-08): the same queue, the session's own project.
  ctx.plan = (session, op, args) => releases.plan(session, op, args);
  releases.recover(); // tasks an earlier daemon left running: interrupted, never run again
  pipelines.recover(); // and its pipeline runs
  core.attach(registry, approvals, releases);

  const dispatchFrame = async (frame) => {
    if (frame.frame === "hello") core.receiveHello(frame.hello);
    else if (frame.frame === "command") await core.receiveCommand(frame.envelope);
    else if (frame.frame === "relay") { log("relay", { type: frame.event?.type ?? null }); if (frame.event?.type === "device.revoked") core.peerRevoked(frame.event); }
    else if (frame.frame === "error") log("gateway_error", { reason: typeof frame.reason === "string" ? frame.reason.slice(0, 40) : null });
  };
  let sentCode = null;
  const registerCode = (again = false) => {
    const invite = readJson("invite.json");
    if (invite?.code && !invite.used && invite.e * 1000 > Date.now() && (again || sentCode !== invite.code) && transport?.send({ frame: "pair_ticket", ticket: invite.code, expires_at: invite.e * 1000 })) sentCode = invite.code;
  };
  // The production gateway admits a computer on a five-minute assertion from the issuer, asked fresh for every challenge.
  const { requestAssertion } = await import("./remote-pairing.mjs");
  const authorize = () => (identity.origin ? requestAssertion({ origin: identity.origin, deviceId: identity.device_id, secret: keys.secret }) : Promise.resolve(null));
  transport = connectGateway({ url: settings.gateway, identity, signingSecret: keys.secret.ed25519, log, authorize, onFrame: (f) => { dispatchFrame(f).catch((e) => log("frame_failed", { name: e?.name ?? "Error" })); },
    onState: (state, info) => { log("gateway", { state, ...info }); if (state === "ready") registerCode(true); } });
  say(`  WorkTrust remote is running for ${identity.device_id} (gateway ${new URL(settings.gateway).host}). Ctrl+C stops it.`);
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    approvals.close();
    await pipelines.stopAll();
    await live.stopAll(); // the browser ended, its profile removed
    await registry.stopAll(); // the structured agents; a terminal session lives on in tmux
    transport.close();
    release();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  setInterval(() => { const s = loadSettings(); if (!s.enabled) stop(0); registerCode(); releases.poll(); }, 3000).unref();
  releases.schedule(); // queued tasks a restart kept
  return new Promise(() => {});
}
