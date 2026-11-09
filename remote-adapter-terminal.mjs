/**
 * THE TERMINAL ADAPTER, ON tmux (release 19, 2026-11-09; docs/remote-agents/PRIOR-ART-ANALYSIS.md 2.3). A terminal session is
 * one tmux session on WorkTrust's OWN socket, `tmux -L worktrust-remote -f <our config>`, so the person sees the same live
 * agent at the desk (`worktrust remote attach <id>`) and on the phone. The person's own tmux server, socket and
 * ~/.tmux.conf are never touched: every call names our socket and our config, and $TMUX is removed from the call's
 * environment so no call can reach the server the person is sitting in.
 *
 * What tmux itself would do with untrusted text, and what this file does instead (each one held by test-remote-terminal):
 *   - A command given as ONE argument is run through the shell (`sh -c`); given as several it is exec'd directly. So an
 *     agent's argv has at least two elements, an absolute program first, and is passed after `--`.
 *   - An argument that is `;` or ends in `;` ENDS the tmux command and starts another, even after `--` (measured on 3.6a:
 *     `send-keys -l -- 'x;' new-session -d -s injected` made a session). Text from the phone is escaped (`\;`), and any
 *     other argument ending in `;` is refused.
 *   - A target without `=` matches by prefix; every target here is `=name` (exact).
 *   - Text goes in with `send-keys -l` (literal: key names are not looked up). A key is only one of KEYS, by our own word.
 *   - Control characters from the phone (escape sequences, newlines, Ctrl codes) are refused, never typed.
 * Session names are `wt-<remote session id>`, checked against one strict pattern before any call.
 *
 * No shell anywhere: each call is execFile with an argv array, a timeout and no input.
 */
import { execFile, spawn } from "node:child_process";
import { writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REMOTE_DENY } from "./remote-adapter-claude-code.mjs";

export const SOCKET = "worktrust-remote";
/** Our socket, or a throwaway one a test names (`worktrust-remote-test-<pid>`); never "default", never a path. */
const SOCKET_NAME = /^worktrust-remote(-[a-z0-9-]{1,48})?$/;
const SESSION_NAME = /^wt-ses_[A-Za-z0-9_-]{22}$/;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{22}$/;
const REF = /^[A-Za-z0-9._:-]{1,256}$/;
/**
 * The keys a computer may press, by our own word: nothing from a phone is read as a key name. `dismiss` answers a
 * screen dialog "no" (remote-screen-approvals.mjs, only after the screen still hashes the same).
 */
export const KEYS = Object.freeze({ enter: "Enter", interrupt: "C-c", dismiss: "Escape" });
export const MIN_TMUX = [3, 0]; // multi-argument commands exec'd without a shell
export const MAX_SCREEN_LINES = 2000;
const MAX_LINE = 1000;
const MAX_SCREEN_CHARS = 256 * 1024; // well under the sealed body's 1 MiB

export const tmuxNameOf = (sessionId) => {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new TypeError("not a remote session id");
  return `wt-${sessionId}`;
};
export const sessionIdOfName = (name) => (typeof name === "string" && SESSION_NAME.test(name) ? name.slice(3) : null);
/** What `worktrust remote attach` takes: the session id or its tmux name, nothing else. */
export const attachTarget = (id) => (typeof id === "string" && SESSION_ID.test(id) ? `wt-${id}` : sessionIdOfName(id) ? id : null);

/** This socket's own configuration, written by us and read only by our server. */
export const TMUX_CONFIG = [
  "# WorkTrust remote: the configuration of WorkTrust's own tmux socket (never your ~/.tmux.conf).",
  "set -g remain-on-exit on",
  "set -g history-limit 5000",
  "set -g mouse off",
  "set -g allow-rename off",
  "set -g set-clipboard off",
  "set -g status-left \"[WorkTrust remote] \"",
  "",
].join("\n");

export function writeTmuxConfig(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "tmux.conf");
  writeFileSync(file, TMUX_CONFIG, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

/** tmux's own command separator, escaped so the text stays one argument: `x;` becomes `x\;`, which tmux reads as `x;`. */
export const escapeSeparator = (arg) => (arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
/** Text a phone may have typed: printable, tabs allowed, no escape sequence, no newline, no Ctrl code. */
export const terminalTextOk = (text) => typeof text === "string" && text.length > 0 && text.length <= 65_536 && !CONTROL.test(text);

/** The tmux version from `tmux -V` ("tmux 3.6a"), or null; a build without a number ("master") is not trusted. */
export function tmuxVersion(out) {
  const m = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(String(out ?? "").trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const tmuxUsable = (v) => v !== null && (v[0] > MIN_TMUX[0] || (v[0] === MIN_TMUX[0] && v[1] >= MIN_TMUX[1]));

/** The screen as lines a sealed agent.screen carries: no escape sequence, no control code, each line cut, the newest kept. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const RESIDUE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export function screenLines(text, want = MAX_SCREEN_LINES) {
  const all = String(text ?? "").replace(ESCAPES, "").replace(RESIDUE, "").split("\n").map((l) => l.replace(/\s+$/, "").slice(0, MAX_LINE));
  while (all.length > 0 && all.at(-1) === "") all.pop();
  let lines = all.slice(-Math.min(Math.max(1, want), MAX_SCREEN_LINES));
  let cut = lines.length < all.length;
  let size = lines.reduce((n, l) => n + l.length, 0);
  while (size > MAX_SCREEN_CHARS && lines.length > 0) { size -= lines[0].length; lines = lines.slice(1); cut = true; }
  return { lines, cut };
}

/** The one way this file runs tmux: execFile, no shell, a timeout, the result as an exit code and its output. */
export function runTmuxFile(file, args, { cwd, env, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
  });
}

const argOk = (a) => typeof a === "string" && a.length > 0 && !a.includes("\u0000") && !a.endsWith(";");

/**
 * tmux on our socket. `run(file, args, opts)` is injectable so the tests drive a fake tmux and read every argv it was handed.
 * `spawnControl` (spawn, injectable likewise) starts the control-mode client `control` uses.
 * → { version, start, capture, sendText, sendKey, state, list, kill, control, attachArgs, socket, config }
 */
export function createTmux({ file, config, socket = SOCKET, env = process.env, run = runTmuxFile, spawnControl = spawn }) {
  if (!SOCKET_NAME.test(socket)) throw new TypeError("not WorkTrust's tmux socket");
  if (typeof file !== "string" || !isAbsolute(file)) throw new TypeError("tmux is named by its absolute path");
  if (typeof config !== "string" || !isAbsolute(config)) throw new TypeError("our tmux config is named by its absolute path");
  const clean = { ...env };
  delete clean.TMUX; delete clean.TMUX_PANE; // never the server the person sits in
  const base = ["-L", socket, "-f", config];
  const call = (args, opts = {}) => run(file, [...base, ...args], { env: clean, ...opts });
  const named = (name) => { if (typeof name !== "string" || !SESSION_NAME.test(name)) throw new TypeError("not a WorkTrust terminal session name"); return name; };
  const pane = (name) => `=${named(name)}:`;

  return {
    socket, config,
    async version() { const r = await run(file, ["-V"], { env: clean }); return r.code === 0 ? tmuxVersion(r.stdout) : null; },
    /** The agent in a new detached session, in `cwd`, exec'd from `argv` (two or more, absolute program first). */
    async start({ name, cwd, argv, ref = null, width = 200, height = 50 }) {
      named(name);
      if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new TypeError("a terminal session starts in an absolute folder");
      if (!Array.isArray(argv) || argv.length < 2 || !argv.every(argOk) || !isAbsolute(argv[0])) throw new TypeError("an agent's argv: two or more arguments, an absolute program first, none ending in ;");
      if (ref !== null && !(typeof ref === "string" && REF.test(ref))) throw new TypeError("not an agent session ref");
      const r = await call(["new-session", "-d", "-s", name, "-x", String(width), "-y", String(height), "--", ...argv], { cwd });
      if (r.code !== 0) return false;
      if (ref !== null) await call(["set-option", "-t", pane(name), "--", "@worktrust_ref", ref]);
      return true;
    },
    /** The last `lines` of the pane, wrapped lines joined, as screenLines gives them; null when the session is gone. */
    async capture(name, lines = 200) {
      const want = Math.min(Math.max(1, Math.trunc(lines) || 1), MAX_SCREEN_LINES);
      const r = await call(["capture-pane", "-p", "-J", "-t", pane(name), "-S", String(-want)]);
      return r.code === 0 ? screenLines(r.stdout, want) : null;
    },
    /** Text, literally (`send-keys -l`): never read as key names, never ending a tmux command. */
    async sendText(name, text) {
      if (!terminalTextOk(text)) throw new TypeError("text with a control character is never typed into a terminal");
      return (await call(["send-keys", "-t", pane(name), "-l", "--", escapeSeparator(text)])).code === 0;
    },
    /** One key from KEYS, by its name there (`enter`, `interrupt`); anything else is refused before tmux hears of it. */
    async sendKey(name, key) {
      if (!Object.hasOwn(KEYS, key)) throw new TypeError("not a key this computer presses");
      return (await call(["send-keys", "-t", pane(name), KEYS[key]])).code === 0;
    },
    /**
     * { exists, dead, status }: dead with its exit status once the agent ended (remain-on-exit keeps the pane to read it).
     * display-message answers 0 with empty fields for a session that is gone (measured on 3.6a), so the name it printed
     * must be the one asked for.
     */
    async state(name) {
      const r = await call(["display-message", "-p", "-t", pane(name), "#{session_name}|#{pane_dead}|#{pane_dead_status}"]);
      const [seen, dead, status] = r.stdout.trim().split("|");
      if (r.code !== 0 || seen !== name) return { exists: false, dead: true, status: null };
      return { exists: true, dead: dead === "1", status: /^\d+$/.test(status ?? "") ? Number(status) : null };
    },
    /**
     * Our sessions, each { name, session_id, ref, path, created_at, dead }; foreign names are skipped; no server is none.
     * Fields are split on `|` with the folder LAST (tmux prints a tab as `_`; no name, id or number holds a `|`, a path may).
     */
    async list() {
      const r = await call(["list-sessions", "-F", "#{session_name}|#{@worktrust_ref}|#{session_created}|#{pane_dead}|#{session_path}"]);
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [name, ref, created, dead, ...rest] = line.split("|");
        const path = rest.join("|");
        return { name, session_id: sessionIdOfName(name), ref: REF.test(ref ?? "") ? ref : null, path: path || null, created_at: /^\d+$/.test(created ?? "") ? Number(created) * 1000 : null, dead: dead === "1" };
      }).filter((s) => s.session_id !== null);
    },
    async kill(name) { return (await call(["kill-session", "-t", `=${named(name)}`])).code === 0; },
    /**
     * WHEN the session changed, from tmux's control mode (`tmux -C attach-session -t =name`, measured on 3.6a: `%output`
     * per write, `%exit` at the end, the window's size untouched). Only the line's first word is read: what the agent
     * printed is dropped at once (the screen is still read with capture-pane). Nothing is ever written to the control
     * client's input, so no tmux command can reach it that way; its end is reported once. → { alive(), close() } or null.
     */
    control(name, onEvent) {
      named(name);
      let child = null, open = true, head = "", skipping = false;
      const end = () => { if (open) { open = false; onEvent("exit"); } };
      try { child = spawnControl(file, [...base, "-C", "attach-session", "-t", `=${name}`], { env: clean, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); } catch { return null; }
      const word = (line) => {
        if (/^%(output|extended-output|layout-change|window-pane-changed) /.test(line)) onEvent("output");
        else if (/^%exit\b/.test(line)) end();
      };
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        for (const part of String(chunk).split(/(\n)/)) {
          if (part === "\n") { if (!skipping) word(head); head = ""; skipping = false; continue; }
          if (skipping) continue;
          head += part;
          if (head.length > 40) { word(head.slice(0, 40)); skipping = true; head = ""; } // the first word told, the rest dropped
        }
      });
      child.on("exit", end);
      child.on("error", end);
      return { alive: () => open, close: () => { open = false; try { child.kill("SIGTERM"); } catch { /* gone */ } } };
    },
    /** The argv `worktrust remote attach` runs with the terminal's own stdio. */
    attachArgs: (name) => [...base, "attach-session", "-t", `=${named(name)}`],
    env: clean,
  };
}

/** No tmux on this computer: every call answers "nothing there", so a session it knew is closed, never run another way. */
export const NO_TMUX = Object.freeze({ socket: SOCKET, config: null, env: {}, version: async () => null, start: async () => false, capture: async () => null, sendText: async () => false, control: () => null,
  sendKey: async () => false, state: async () => ({ exists: false, dead: true, status: null }), list: async () => [], kill: async () => false, attachArgs: () => { throw new Error("tmux is not installed"); } });

/**
 * Claude Code, interactive, as a terminal session runs it: the same deny rules and setting sources as the structured
 * adapter (a phone may steer this session), the session id chosen here so the steered ledger names it before it starts.
 * No text from the phone is an argument: a model the computer listed, a mode from the closed set, a uuid.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function terminalClaudeArgs({ features, mode, model, resume, sessionRef }) {
  if (mode !== "ask" && mode !== "plan") throw new Error("the protocol offers the ask and plan modes only");
  const permission = mode === "plan" ? features?.planMode : features?.askMode;
  if (!permission) throw new Error("this Claude Code offers no such permission mode");
  if (!features.disallowed || !features.settingSources || !features.sessionId) throw new Error("this Claude Code cannot take deny rules, limit its setting sources or take a session id");
  if (resume !== null && !UUID.test(resume ?? "")) throw new Error("a resume id is Claude Code's own session uuid");
  if (resume === null && !UUID.test(sessionRef ?? "")) throw new Error("a new session needs its uuid");
  if (model !== null && (typeof model !== "string" || model.startsWith("-") || !/^[A-Za-z0-9._:@[\]-]{1,128}$/.test(model))) throw new Error("not a model name");
  return ["--permission-mode", permission, "--setting-sources", "user", "--disallowedTools", ...REMOTE_DENY, ...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : ["--session-id", sessionRef])];
}

/**
 * The terminal report for Claude Code. Honest about this slice: it starts, shows its screen, stops, and is attached at the
 * desk; it takes NO prompt from a phone yet (`prompt: false`) because its state (working, a dialog) is not read from the
 * screen yet, and the protocol types nothing while a dialog may be on screen (attention.ts, promptAllowed).
 */
export function terminalReport({ claude, tmux }) {
  const f = claude?.features ?? {};
  const usable = Boolean(claude?.installed && tmuxUsable(tmux) && f.askMode && f.sessionId && f.disallowed && f.settingSources);
  const capabilities = { start: usable, attach: usable, prompt: false, steer: false, pause: false, resume: false, stop: usable, structured_events: false, screen: usable, focus: false,
    resume_by_id: usable && Boolean(f.resume), permission_modes: f.planMode && usable ? ["ask", "plan"] : ["ask"], approvals: "none", acceptance: "state_change", steer_mode: "none", interrupt: false };
  const installed = Boolean(claude?.installed);
  return { adapter: "claude-code", mode: "terminal", installed, version: installed ? claude.version ?? null : null, signed_in: null, capabilities,
    models: installed ? claude.models : null, models_status: installed ? claude.models_status : "not_listed", models_at: installed ? claude.models_at : null, default_model: null };
}
