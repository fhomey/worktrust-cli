/**
 * A RELEASE'S PIPELINE, RUN ON THE COMPUTER (owner, 2026-11-07; docs/remote-agents/PROTOCOL.md "Pipelines").
 *
 * The phone starts or cancels a pipeline the computer already has: the stages of the project's reviewed
 * `.worktrust/pipeline.json` (remote-pipeline-config.mjs). Stages run one after another, each command checked against the
 * allowlist again right before it runs and spawned without a shell, in its own process group (so a cancel or a timeout
 * ends everything it started), with the person's environment minus every WORKTRUST_ variable and stdin closed. Output goes
 * to a local log (~/.worktrust/remote/pipelines/<run>/<stage>.log, mode 0600) for the person to read at the desk, and
 * never to the phone: the phone gets the stage's state and what its parser read. A deploy or publish stage is never run:
 * it is `at_desk`.
 *
 * At most once, as with commands: a run is journaled before its first stage starts, and a run a stopped daemon left
 * running is closed `failed` / `interrupted` by the next daemon and never run again. Each run is marked in the steered
 * ledger as non-agent work (`steered: "pipeline"`), which the hour readers skip: a pipeline is never Passport hours.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync, constants } from "node:fs";
import { join, sep } from "node:path";
import * as P from "./remote-protocol.mjs";
import { allowCommand, namedFiles, parsePipelineConfig, PIPELINE_FILE, reviewHash } from "./remote-pipeline-config.mjs";
import { createTapCounter, findingsFail, readReport } from "./remote-pipeline-parsers.mjs";
import { createCoalescer } from "./remote-sessions.mjs";

const MAX_KEEP = 256 * 1024; // the tail of stdout a parser reads when the stage names no report file
const MAX_REPORT = 16 * 1024 * 1024;
export const MAX_PIPELINES = 2;
const HISTORY = 40;

const inside = (root, path) => path === root || path.startsWith(root + sep);

/** A project file read safely: inside the project after every symlink, not a symlink itself, bounded. */
export function readProjectFile(projectPath, relative, max) {
  try {
    const root = realpathSync(projectPath);
    const file = join(root, relative);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !inside(root, realpathSync(file))) return null;
    const text = readFileSync(file);
    return text.length > max ? null : text.toString("utf8");
  } catch { return null; }
}

const scriptsOf = (projectPath) => { try { return JSON.parse(readProjectFile(projectPath, "package.json", 1_048_576) ?? "null")?.scripts ?? null; } catch { return null; } };

/** The project-side inputs of reviewHash: its .npmrc and the files its node stages run. */
export function reviewExtras(projectPath, text, scripts) {
  return { npmrc: readProjectFile(projectPath, ".npmrc", 65_536), files: Object.fromEntries(namedFiles(text, scripts).map((f) => [f, readProjectFile(projectPath, f, 4 * 1024 * 1024)])) };
}

/** The hash `worktrust remote pipeline review` pins, read from the project as it stands now. */
export function projectReviewHash(project) {
  const text = readProjectFile(project.path, PIPELINE_FILE, 65_536);
  if (text === null) return null;
  const scripts = scriptsOf(project.path);
  return reviewHash(text, scripts, reviewExtras(project.path, text, scripts));
}

/** absent | unreviewed | reviewed, and the parsed config when it may run. */
export function pipelineState(project, reviews) {
  const text = readProjectFile(project.path, PIPELINE_FILE, 65_536);
  if (text === null) return { state: "absent", config: null };
  const scripts = scriptsOf(project.path);
  const parsed = parsePipelineConfig(text, scripts);
  if (!parsed.ok) return { state: "unreviewed", config: null, detail: parsed.detail };
  const hash = reviewHash(text, scripts, reviewExtras(project.path, text, scripts));
  return reviews[project.project_id]?.sha256 === hash ? { state: "reviewed", config: parsed.config, scripts, hash } : { state: "unreviewed", config: null };
}

export function createPipelines(ctx) {
  // ctx: { journal, now, random, emit, projects(), reviews(), log, logDir, markLedger(record), env(prepend), onEnded(run), spawnImpl? }
  const runs = new Map(); // live runs: id -> { body, child, cancelled }
  const go = ctx.spawnImpl ?? spawn;
  const coalesce = createCoalescer({ now: ctx.now });

  const history = (projectId, stageId) => ctx.journal.pipelines().filter((p) => p.project_id === projectId && p.state === "passed").slice(-HISTORY)
    .flatMap((p) => (stageId === null ? [(p.ended_at - p.started_at) / 1000] : p.stages.filter((s) => s.stage_id === stageId && s.state === "passed" && s.duration_ms !== undefined).map((s) => s.duration_ms / 1000)));
  const etaFor = (durations, startedAt) => { const e = P.etaForDisplay(P.etaFromHistory(durations, Math.max(0, (ctx.now() - startedAt) / 1000))); return e.kind === "estimate" ? e : undefined; };

  /** History's estimate where etaForDisplay keeps one, on live stages and a live run only; every other ETA dropped. */
  function withEtas(body) {
    const final = P.isFinalPipelineState(body.state);
    const stages = body.stages.map((s) => {
      const { eta: _drop, ...rest } = s;
      if (final || (s.state !== "running" && s.state !== "queued")) return rest;
      const eta = etaFor(history(body.project_id, s.stage_id), s.started_at ?? ctx.now());
      return eta ? { ...rest, eta } : rest;
    });
    const { eta: _old, ...top } = body;
    const eta = final ? undefined : etaFor(history(body.project_id, null), body.started_at);
    return { ...top, stages, ...(eta ? { eta } : {}) };
  }

  /** Journal first, then the phone; a live count is coalesced to one per two seconds per run. */
  function publish(run, { live = false } = {}) {
    run.body = withEtas(run.body);
    const shaped = P.validateEventBody("pipeline.updated", run.body);
    if (!shaped.ok) { ctx.log("pipeline_refused", { detail: shaped.code }); return false; }
    ctx.journal.recordPipeline(run.body);
    const send = () => ctx.emit(null, "pipeline.updated", run.body);
    if (live) coalesce.offer(run.body.pipeline_run_id, send); else coalesce.now(run.body.pipeline_run_id, send);
    return true;
  }

  /** A stage an earlier daemon left running: its process group is ended when its command line is still that stage's. */
  function reap(runId) {
    const held = ctx.journal.pipelinePid?.(runId);
    if (!held || process.platform === "win32" || !Number.isSafeInteger(held.pid) || held.pid <= 1) return false;
    const command = ctx.commandOf?.(held.pid) ?? ""; // `ps` lives in remote-run.mjs: this file spawns stages only
    if (!command.includes(held.file)) return false;
    try { (ctx.kill ?? process.kill.bind(process))(-held.pid, "SIGTERM"); return true; } catch { return false; }
  }

  const setStage = (run, id, patch) => { run.body = { ...run.body, stages: run.body.stages.map((s) => (s.stage_id === id ? { ...s, ...patch } : s)) }; };

  function finish(run, state, reason) {
    run.body = { ...run.body, state, reason, ended_at: Math.max(ctx.now(), run.body.started_at),
      stages: run.body.stages.map((s) => (s.state === "queued" || s.state === "running" ? { ...s, state: "skipped" } : s)) };
    publish(run);
    ctx.markLedger({ v: 1, steered: "pipeline", agent: false, pipeline_run_id: run.body.pipeline_run_id, release_id: run.body.release_id, project_id: run.body.project_id, started_at: run.body.started_at, ended_at: run.body.ended_at });
    runs.delete(run.body.pipeline_run_id);
    ctx.onEnded?.(run.body);
  }

  function runStage(run, stage, project, config) {
    return new Promise((resolve) => {
      const argv = allowCommand(stage.run, scriptsOf(project.path)); // again, at run time
      if (!argv.ok) { resolve({ state: "failed" }); return; }
      const started = ctx.now();
      setStage(run, stage.id, { state: "running", started_at: started });
      publish(run);
      const dir = join(ctx.logDir, run.body.pipeline_run_id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const log = openSync(join(dir, `${stage.id}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
      let tail = "";
      const tap = stage.parser === "tap" ? createTapCounter() : null;
      const child = go(argv.file, argv.args, { cwd: project.path, env: ctx.env(config.path_prepend), shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      run.child = child;
      if (Number.isSafeInteger(child.pid)) ctx.journal.recordPipelinePid(run.body.pipeline_run_id, { pid: child.pid, file: argv.file }); // a later daemon ends it (P2-4)
      const take = (chunk, out) => {
        const text = chunk.toString("utf8");
        try { writeSync(log, text); } catch { /* the log is the person's convenience */ }
        if (!out) return;
        tail = (tail + text).slice(-MAX_KEEP);
        if (tap) { tap.feed(text); const m = tap.now(); if (m) { setStage(run, stage.id, { measured: m }); publish(run, { live: true }); } }
      };
      child.stdout?.on("data", (c) => take(c, true));
      child.stderr?.on("data", (c) => take(c, false));
      const timer = setTimeout(() => { run.timedOut = true; kill(child); }, stage.timeout_ms);
      timer.unref?.();
      const done = (code) => {
        clearTimeout(timer);
        try { closeSync(log); } catch { /* closed */ }
        run.child = null;
        const report = stage.report ? readProjectFile(project.path, stage.report, MAX_REPORT) : tail;
        const read = readReport(stage.parser, report ?? "");
        const exitOk = stage.parser === "zap_json" ? code === 0 || code === 1 || code === 2 : code === 0;
        const failed = !exitOk || run.cancelled || run.timedOut || (read.measured?.unit === "tests" && read.measured.failed > 0) || findingsFail(read.findings, stage.fail_on);
        const { measured: _live, ...rest } = run.body.stages.find((s) => s.stage_id === stage.id);
        const result = { ...rest, ...(read.measured ? { measured: read.measured } : {}), ...(read.findings ? { findings: read.findings } : {}) };
        const state = run.cancelled ? "skipped" : failed ? "failed" : "passed";
        run.body = { ...run.body, stages: run.body.stages.map((s) => (s.stage_id === stage.id ? { ...result, state, duration_ms: Math.max(0, ctx.now() - started) } : s)) };
        resolve({ state });
      };
      child.on("error", () => done(-1));
      child.on("close", (code) => done(code ?? -1));
    });
  }

  const kill = (child) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } } };

  async function drive(run, project, config, hash) {
    for (const stage of config.stages) {
      if (stage.desk) continue;
      if (run.cancelled) break;
      // Reviewed still? An earlier stage, a task or the desk may have changed the file, a script or a stage's code (P3-5).
      if (pipelineState(project, ctx.reviews()).hash !== hash) return finish(run, "failed", "unreviewed");
      const { state } = await runStage(run, stage, project, config);
      if (state === "failed") return finish(run, "failed", run.timedOut ? "timeout" : "stage_failed");
      publish(run);
    }
    if (run.cancelled) return finish(run, "cancelled", "cancelled");
    finish(run, "passed", null);
  }

  return {
    state: (project) => pipelineState(project, ctx.reviews()).state,
    runsAfterTasks: (project) => pipelineState(project, ctx.reviews()).config?.run_after_tasks === true,
    /** → { ok: true, run } or { ok: false, reason } with a protocol reject reason. Never a desk stage. */
    start({ release_id, project_id }) {
      const project = ctx.projects().find((p) => p.project_id === project_id);
      if (!project) return { ok: false, reason: "not_found" };
      const found = pipelineState(project, ctx.reviews());
      if (found.state === "absent") return { ok: false, reason: "not_found" };
      if (found.state !== "reviewed") return { ok: false, reason: "unreviewed" };
      if ([...runs.values()].some((r) => r.body.project_id === project_id) || runs.size >= MAX_PIPELINES) return { ok: false, reason: "busy" };
      const body = { pipeline_run_id: P.mintId("plr", ctx.random), release_id, project_id, state: "running", reason: null, started_at: ctx.now(), ended_at: null,
        stages: found.config.stages.map((s) => ({ stage_id: s.id, label: s.label, kind: s.kind, state: s.desk ? "at_desk" : "queued" })) };
      const run = { body, child: null, cancelled: false, timedOut: false };
      if (!publish(run)) return { ok: false, reason: "unsupported" }; // journaled before the first stage runs, or nothing runs
      runs.set(body.pipeline_run_id, run);
      ctx.markLedger({ v: 1, steered: "pipeline", agent: false, pipeline_run_id: body.pipeline_run_id, release_id, project_id, started_at: body.started_at, ended_at: null });
      // The first stage starts on the next turn of the loop, after the caller saved the release as verifying (P3-6).
      run.done = new Promise((resolve) => setImmediate(resolve)).then(() => drive(run, project, found.config, found.hash))
        .catch((e) => { ctx.log("pipeline_failed", { name: e?.name ?? "Error" }); if (runs.has(body.pipeline_run_id)) finish(run, "failed", "stage_failed"); });
      return { ok: true, run: body };
    },
    cancel(runId) {
      const run = runs.get(runId);
      if (!run) return false;
      run.cancelled = true;
      if (run.child) kill(run.child);
      return true;
    },
    /** Runs an earlier daemon left open: failed, interrupted, never run again. */
    recover() {
      let closed = 0;
      for (const p of ctx.journal.pipelines()) {
        if (P.isFinalPipelineState(p.state) || runs.has(p.pipeline_run_id)) continue;
        reap(p.pipeline_run_id);
        const ended = Math.max(ctx.now(), p.started_at);
        const body = { ...p, state: "failed", reason: "interrupted", ended_at: ended, stages: p.stages.map((s) => { const { eta: _e, ...r } = s; return s.state === "running" ? { ...r, state: "failed", duration_ms: Math.max(0, ended - (s.started_at ?? ended)) } : s.state === "queued" ? { ...r, state: "skipped" } : r; }) };
        const { eta: _top, ...clean } = body;
        ctx.journal.recordPipeline(clean);
        ctx.markLedger({ v: 1, steered: "pipeline", agent: false, pipeline_run_id: p.pipeline_run_id, release_id: p.release_id, project_id: p.project_id, started_at: p.started_at, ended_at: ended });
        ctx.emit(null, "pipeline.updated", clean);
        ctx.onEnded?.(clean);
        closed += 1;
      }
      return closed;
    },
    running: () => [...runs.keys()],
    get: (runId) => runs.get(runId)?.body ?? ctx.journal.pipelines().find((p) => p.pipeline_run_id === runId) ?? null,
    async stopAll() { for (const run of runs.values()) { run.cancelled = true; if (run.child) kill(run.child); } await Promise.all([...runs.values()].map((r) => r.done)); },
  };
}
