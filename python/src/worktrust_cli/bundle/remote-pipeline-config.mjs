/**
 * THE PERSON'S PIPELINE FILE, READ AND HELD TO AN ALLOWLIST (owner, 2026-11-07; docs/remote-agents/PROTOCOL.md "Pipelines").
 *
 * A project's stages live in `.worktrust/pipeline.json`, which the PERSON writes and reviews at the keyboard
 * (`worktrust remote pipeline review <folder>` prints every stage and command and pins a hash of the file and of the
 * package.json scripts it names). The daemon runs a pipeline only while that hash still holds: an agent (or anyone) that
 * edits the file or a named script after the review makes the pipeline `unreviewed` until the person looks again.
 *
 * A stage's `run` is one of five forms, split on single spaces, no quoting, no shell, every token from a safe character
 * set and no `..` segment:
 *   pnpm <script> | pnpm run <script> | npm run <script>   a script the project's package.json names, always run as
 *                                                          `<pnpm|npm> run <script>` (never a package manager built-in such
 *                                                          as install, add or publish)
 *   node scripts/<file>.(mjs|js|cjs) [args]                 a file inside the project's scripts folder
 *   semgrep [scan] <flags> [target]                        a local scan; `semgrep ci` (which uploads) is refused
 *   zap-baseline.py <flags>                                 against a loopback target only (http://localhost, 127.0.0.1)
 * A stage of kind deploy or publish has no `run`: it is a step at the desk, never run by the daemon. A stage whose script
 * or file is named like a deploy (deploy, publish, ship, push, promote, rollout, upload) is refused as well, whatever its
 * kind: those stay in the ship scripts at the computer (owner rule). Pure: the caller passes the file's text and the
 * package.json scripts.
 */
import { createHash } from "node:crypto";
import * as P from "./remote-protocol.mjs";

export const PIPELINE_FILE = ".worktrust/pipeline.json";
export const MAX_CONFIG_BYTES = 65_536;
const TOP_KEYS = new Set(["version", "run_after_tasks", "path_prepend", "stages"]);
const STAGE_KEYS = new Set(["id", "label", "kind", "run", "parser", "report", "timeout_min", "fail_on"]);
const STAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9@%+=:,./_-]+$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const NODE_FILE = /^scripts\/[A-Za-z0-9._/-]+\.(mjs|js|cjs)$/;
const REPORT = /^[A-Za-z0-9._/-]+\.(json|xml)$/;
const DEPLOY_WORDS = /(^|[:._/-])(deploy|deployment|publish|ship|push|promote|rollout|upload)([:._/-]|$)/i;
/**
 * A deploy or a publish in a script's TEXT (review 2026-11-07, P2-3): a deploy tool in command position, a package
 * manager's publish or deploy, a git push, a GitHub release. Applied to the named script and its pre/post hooks.
 */
const DEPLOY_TEXT = /(^|&&|\|\||[;|(]|\bnpx\s+|\bdlx\s+)\s*(vercel|netlify|fly|flyctl|firebase|heroku|wrangler|serverless|sls|kubectl|helm|terraform|pulumi|eas|railway|render)(\s|$)|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(publish|deploy)\b|\bgit\s+push\b|\bgh\s+release\b/;
const SEVERITIES = ["high", "medium", "low", "none"];
const SEMGREP_FLAGS = new Set(["--json", "--metrics=off", "--error", "--quiet", "-q", "--no-git-ignore", "--disable-version-check", "--oss-only"]);
/** A rules source semgrep reads: a registry pack by name, or a file inside the project; never a URL or `auto` (P3-10). */
const SEMGREP_CONFIG = /^(p\/[a-z0-9][a-z0-9_-]{0,63}|[A-Za-z0-9._/-]+\.(ya?ml))$/;
const SEMGREP_VALUED = new Set(["--config", "--exclude", "--include", "--severity", "--timeout", "--jobs", "--max-target-bytes"]);
const ZAP_FLAGS = new Set(["-I", "-j", "-a", "-s", "-d"]);
const ZAP_VALUED = new Set(["-t", "-J", "-x", "-m", "-T"]); // no -c (a rules file) or -z (raw ZAP options): the list stays this short
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[A-Za-z0-9._~/%-]*)?$/;

const refuse = (detail) => ({ ok: false, detail });
const relativeOk = (p) => typeof p === "string" && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && SAFE_TOKEN.test(p);

/**
 * One stage's command as argv, or why not. `scripts` is package.json's scripts object (or null). Run time calls this
 * again on every stage, so a config read earlier cannot smuggle a command past a later check.
 */
export function allowCommand(run, scripts) {
  if (typeof run !== "string" || run.length === 0 || run.length > 500) return refuse("run: not a command line");
  const tokens = run.split(" ");
  if (tokens.some((t) => t === "" || !SAFE_TOKEN.test(t) || t.split("/").includes(".."))) return refuse("run: only plain words, single spaces, no shell characters, no ..");
  const [head, ...rest] = tokens;
  const scriptOf = (name) => {
    if (!SCRIPT_NAME.test(name ?? "")) return refuse("run: not a script name");
    if (!scripts || typeof scripts[name] !== "string") return refuse(`run: package.json names no script ${name}`);
    if (DEPLOY_WORDS.test(name)) return refuse(`run: ${name} is a deploy or publish; it stays at your desk`);
    for (const hook of [name, `pre${name}`, `post${name}`]) if (typeof scripts[hook] === "string" && DEPLOY_TEXT.test(scripts[hook])) return refuse(`run: the script ${hook} deploys or publishes; it stays at your desk`);
    return null;
  };
  if (head === "pnpm" || head === "npm") {
    const name = rest[0] === "run" ? rest[1] : head === "pnpm" ? rest[0] : undefined;
    const used = rest[0] === "run" ? 2 : 1;
    if (name === undefined || rest.length !== used) return refuse(`run: ${head} takes exactly one script${head === "npm" ? " (npm run <script>)" : ""}`);
    const bad = scriptOf(name);
    return bad ?? { ok: true, file: head, args: ["run", name], form: "script", script: name };
  }
  if (head === "node") {
    const [file, ...args] = rest;
    if (!NODE_FILE.test(file ?? "")) return refuse("run: node runs a file under scripts/ only");
    if (DEPLOY_WORDS.test(file)) return refuse(`run: ${file} is a deploy or publish; it stays at your desk`);
    if (args.some((a) => a.startsWith("--") && /^--(eval|require|import|loader|inspect)/.test(a))) return refuse("run: no node flags");
    return { ok: true, file: "node", args: [file, ...args], form: "node", script: file };
  }
  if (head === "semgrep") {
    const args = rest[0] === "scan" ? rest.slice(1) : rest;
    if (rest[0] === "ci" || rest[0] === "login" || rest[0] === "publish") return refuse("run: semgrep scans locally only");
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      const [flag, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
      if (SEMGREP_FLAGS.has(a)) continue;
      if (SEMGREP_VALUED.has(flag)) {
        const v = value ?? args[++i];
        if (!v || v.startsWith("-")) return refuse(`run: ${flag} needs a value`);
        if (flag === "--config" && !(SEMGREP_CONFIG.test(v) && (v.startsWith("p/") || relativeOk(v)))) return refuse("run: --config is a registry pack (p/<name>) or a rules file in the project");
        continue;
      }
      if (i === args.length - 1 && !a.startsWith("-") && relativeOk(a)) continue; // the target folder
      return refuse(`run: semgrep ${a} is not on the list`);
    }
    if (!args.includes("--metrics=off")) return refuse("run: semgrep runs with --metrics=off");
    return { ok: true, file: "semgrep", args: rest[0] === "scan" ? rest : ["scan", ...rest], form: "semgrep", script: null };
  }
  if (head === "zap-baseline.py") {
    let target = null;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (ZAP_FLAGS.has(a)) continue;
      if (!ZAP_VALUED.has(a)) return refuse(`run: zap-baseline.py ${a} is not on the list`);
      const v = rest[++i];
      if (!v) return refuse(`run: ${a} needs a value`);
      if (a === "-t") target = v;
      if ((a === "-J" || a === "-x") && !relativeOk(v)) return refuse(`run: ${a} writes or reads inside the project only`);
    }
    if (!target || !LOOPBACK.test(target)) return refuse("run: ZAP scans a loopback target only (http://localhost or 127.0.0.1)");
    return { ok: true, file: "zap-baseline.py", args: rest, form: "zap", script: null };
  }
  return refuse(`run: ${head} is not on the allowlist (pnpm, npm run, node scripts/…, semgrep, zap-baseline.py)`);
}

/** The file's text and package.json's scripts → { ok, config } with every stage checked, or the first refusal. */
export function parsePipelineConfig(text, scripts) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_CONFIG_BYTES) return refuse("the file is missing or larger than 64 KB");
  let raw;
  try { raw = JSON.parse(text); } catch { return refuse("the file is not JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("the file is not an object");
  const extra = Object.keys(raw).find((k) => !TOP_KEYS.has(k));
  if (extra) return refuse(`unknown key ${extra}`);
  if (raw.version !== 1) return refuse("version must be 1");
  if (raw.run_after_tasks !== undefined && typeof raw.run_after_tasks !== "boolean") return refuse("run_after_tasks is true or false");
  const prepend = raw.path_prepend ?? [];
  if (!Array.isArray(prepend) || prepend.length > 8 || prepend.some((d) => typeof d !== "string" || !d.startsWith("/") || !SAFE_TOKEN.test(d) || d.split("/").includes(".."))) return refuse("path_prepend is a list of absolute folders");
  if (!Array.isArray(raw.stages) || raw.stages.length === 0 || raw.stages.length > P.MAX_PIPELINE_STAGES) return refuse(`stages: 1 to ${P.MAX_PIPELINE_STAGES}`);
  const ids = new Set();
  const stages = [];
  for (const [n, s] of raw.stages.entries()) {
    const at = `stages[${n}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) return refuse(`${at}: not an object`);
    const unknown = Object.keys(s).find((k) => !STAGE_KEYS.has(k));
    if (unknown) return refuse(`${at}: unknown key ${unknown}`);
    if (!STAGE_ID.test(s.id ?? "") || ids.has(s.id)) return refuse(`${at}.id: [a-z0-9_-], once`);
    ids.add(s.id);
    if (typeof s.label !== "string" || s.label.trim() === "" || s.label.length > 200) return refuse(`${at}.label: 1 to 200 characters`);
    if (!P.STAGE_KINDS.includes(s.kind)) return refuse(`${at}.kind: one of ${P.STAGE_KINDS.join(", ")}`);
    const desk = P.DESK_STAGE_KINDS.has(s.kind);
    if (desk) {
      if (Object.keys(s).some((k) => !["id", "label", "kind"].includes(k))) return refuse(`${at}: a ${s.kind} stage is a step at your desk; it has no run`);
      stages.push({ id: s.id, label: s.label, kind: s.kind, desk: true });
      continue;
    }
    const parser = s.parser ?? "none";
    if (!P.PIPELINE_PARSERS.includes(parser)) return refuse(`${at}.parser: one of ${P.PIPELINE_PARSERS.join(", ")}`);
    const cmd = allowCommand(s.run, scripts);
    if (!cmd.ok) return refuse(`${at}.${cmd.detail}`);
    if (s.report !== undefined && !(typeof s.report === "string" && REPORT.test(s.report) && relativeOk(s.report))) return refuse(`${at}.report: a .json or .xml file inside the project`);
    const timeout = s.timeout_min ?? 30;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) return refuse(`${at}.timeout_min: 1 to 120`);
    const failOn = s.fail_on ?? (parser === "semgrep_json" || parser === "zap_json" ? "high" : "none");
    if (!SEVERITIES.includes(failOn)) return refuse(`${at}.fail_on: high, medium, low or none`);
    stages.push({ id: s.id, label: s.label, kind: s.kind, desk: false, run: s.run, parser, report: s.report ?? null, timeout_ms: timeout * 60_000, fail_on: failOn });
  }
  return { ok: true, config: { run_after_tasks: raw.run_after_tasks ?? true, path_prepend: prepend, stages } };
}

/** The project files a `node scripts/<file>` stage runs, so their bytes are part of what the person reviewed. */
export function namedFiles(text, scripts) {
  const parsed = parsePipelineConfig(text, scripts);
  return parsed.ok ? [...new Set(parsed.config.stages.flatMap((s) => { const c = s.desk ? null : allowCommand(s.run, scripts); return c?.form === "node" ? [c.script] : []; }))] : [];
}

/**
 * What the person reviewed (review 2026-11-07, P2-1/P2-2): the file's bytes, package.json's WHOLE scripts object (so a new
 * pre or post hook is a change), the project's .npmrc (script-shell, node-options), and the bytes of every file a
 * `node scripts/<file>` stage runs. `extras` is { npmrc: text | null, files: { path: text | null } } from the project.
 * A changed byte in any of them is a new pipeline that needs a new review.
 */
export function reviewHash(text, scripts, extras = { npmrc: null, files: {} }) {
  const files = Object.fromEntries(namedFiles(text, scripts).map((f) => [f, createHash("sha256").update(extras.files?.[f] ?? "\u0000absent").digest("hex")]));
  return createHash("sha256").update(P.canonicalJson({ file: text, scripts: scripts ?? null, npmrc: extras.npmrc ?? null, files })).digest("hex");
}
