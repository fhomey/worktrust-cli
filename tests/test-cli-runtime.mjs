#!/usr/bin/env node
/** Real coupling lifecycle in a synthetic home/mock server. Cache removal must not remove the installed runtime.
 * Public mirror: WORKTRUST_TEST_CLI_SOURCE=<flat CLI source>. Optional WORKTRUST_TEST_CLI_ENTRY proves regressions.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = ["worktrust.mjs", "setup-mcp.mjs", "log-session.mjs", "count-behaviour.mjs", "transcript-readers.mjs", "session-databases.mjs", "config-edits.mjs", "stretch-evidence.mjs", "chat-exports.mjs", "stack-rules.mjs", "preserve.mjs", "preserve-lines.mjs", "preserve-summary.mjs", "runtime-install.mjs", "orchestration-contract.mjs", "orchestration-evidence.mjs", "orchestration-report.mjs", "claude-mod.mjs"];
const source = (name) => name === "worktrust.mjs" && process.env.WORKTRUST_TEST_CLI_ENTRY ? process.env.WORKTRUST_TEST_CLI_ENTRY : process.env.WORKTRUST_TEST_CLI_SOURCE ? join(process.env.WORKTRUST_TEST_CLI_SOURCE, name) : join(repo, name === "worktrust.mjs" ? "apps/worktrust/app/public/counter" : "scripts", name);
const scratch = mkdtempSync(join(tmpdir(), "worktrust runtime "));
const home = join(scratch, "person home"), cache = join(scratch, "disposable cache"), pathDir = join(scratch, "empty PATH");
const executable = process.platform === "win32" ? "node.exe" : "node";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let count = 0, requests = 0;
const check = (condition, message) => { assert.ok(condition, message); count += 1; };
const env = { HOME: home, USERPROFILE: home, PATH: pathDir, WORKTRUST_RELAYED: "1", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC } : {}) };
const run = (node, entry, args, additions = {}, input = "") => new Promise((done, reject) => {
  const child = spawn(node, [entry, ...args], { env: { ...env, ...additions }, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(Error("synthetic CLI runtime test timed out")); }, 45_000);
  child.stdout.on("data", bytes => stdout += bytes); child.stderr.on("data", bytes => stderr += bytes);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", status => { clearTimeout(timer); done({ status, stdout, stderr }); });
  child.stdin.on("error", () => {}); child.stdin.end(input);
});
const runHookCommand = (command) => new Promise((done, reject) => {
  const child = spawn(`${command} --dry-run --summary`, { env, cwd: scratch, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const timer = setTimeout(() => { child.kill(); reject(Error("configured hook timed out")); }, 45_000);
  child.stdout.on("data", bytes => output += bytes); child.stderr.on("data", bytes => output += bytes);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", status => { clearTimeout(timer); done({ status, output }); });
});
const server = createServer((request, response) => {
  requests += 1;
  let text = ""; request.on("data", bytes => text += bytes); request.on("end", () => {
    response.setHeader("content-type", "application/json");
    const body = JSON.parse(text || "{}");
    const result = request.url === "/api/cli/pair" ? { user_code: "SYNTHETIC", device_code: "synthetic-device", verification_uri: "http://127.0.0.1/synthetic", interval: 0, expires_in: 10 }
      : request.url === "/api/cli/token" ? { token: "wt_synthetic_runtime_token", label: "Synthetic", account_ref: "synthetic-account" }
      : { jsonrpc: "2.0", id: body.id, result: { tools: [] } };
    response.end(JSON.stringify(result));
  });
});
function makeCache(dir, extra = "") {
  const runtime = join(dir, "runtime"), engine = join(dir, "engine");
  mkdirSync(runtime, { recursive: true }); mkdirSync(engine);
  copyFileSync(process.execPath, join(runtime, executable)); chmodSync(join(runtime, executable), 0o755);
  writeFileSync(join(runtime, "LICENSE"), `Synthetic fixture license${extra}`);
  const files = Object.fromEntries([executable, "LICENSE"].map(name => [name, sha(readFileSync(join(runtime, name)))]));
  writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ version: process.versions.node, platform: `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`, executable, archive_sha256: "0".repeat(64), files }));
  for (const name of modules) copyFileSync(source(name), join(engine, name));
  return { runtime, engine, node: join(runtime, executable), entry: join(engine, "worktrust.mjs"), additions: { WORKTRUST_BUNDLED_RUNTIME_DIR: runtime } };
}
const cursorConfig = () => JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.worktrust;
try {
  mkdirSync(home); mkdirSync(pathDir); mkdirSync(join(home, ".cursor")); mkdirSync(join(home, ".codex")); mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "synthetic"\n');
  const first = makeCache(cache);
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const args of [["--help"], ["connect", "--dry-run"], ["update", "--yes"]]) {
    const result = await run(first.node, first.entry, args, { ...first.additions, ...(args[0] === "update" ? { CLAUDECODE: "1" } : {}) });
    check(!existsSync(join(home, ".worktrust", "installations")), "help, dry run and agent refusal do not install runtime");
    if (args[0] === "update") check(result.status !== 0, "agent guard remains");
    else check(result.status === 0, result.stdout + result.stderr);
  }
  check(requests === 0, "non-mutating paths make no pairing requests");
  const unrelated = join(scratch, "unrelated directory"); mkdirSync(unrelated, { mode: 0o755 }); writeFileSync(join(unrelated, "keep"), "unrelated");
  const mode = statSync(unrelated).mode;
  symlinkSync(unrelated, join(home, ".worktrust"), process.platform === "win32" ? "junction" : "dir");
  const linked = await run(first.node, first.entry, ["connect", "--yes", "--device", "--origin", origin], first.additions);
  check(linked.status !== 0 && requests === 0, "symlinked owned directory refused before pairing");
  check(statSync(unrelated).mode === mode && readdirSync(unrelated).join() === "keep", "refusal does not chmod or write through the symlink");
  unlinkSync(join(home, ".worktrust"));
  const connected = await run(first.node, first.entry, ["connect", "--yes", "--device", "--origin", origin, "--codex", "--antigravity"], first.additions);
  check(connected.status === 0, connected.stdout + connected.stderr);
  const firstConfig = cursorConfig();
  check(firstConfig.command.startsWith(join(home, ".worktrust", "installations")), "configured executable is owned and persistent, never a disposable cache");
  check(firstConfig.args[0].startsWith(join(home, ".worktrust", "installations")), "complete engine also has a persistent immutable path");
  for (const name of modules) check(existsSync(join(dirname(firstConfig.args[0]), name)), `installed engine includes ${name}`);
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  check(settings.hooks.SessionEnd[0].hooks[0].command.includes(firstConfig.command), "Claude hook uses owned runtime");
  check(readFileSync(join(home, ".codex", "config.toml"), "utf8").includes(JSON.stringify(firstConfig.command)), "Codex uses owned runtime");
  check(readFileSync(join(home, ".gemini", "config", "hooks.json"), "utf8").includes(JSON.stringify(firstConfig.command).slice(1,-1)), "Antigravity uses owned runtime");
  const keyBefore = readFileSync(join(home, ".worktrust", "key.json"));
  for (const command of ["codex", "antigravity"]) {
    const result = await run(first.node, first.entry, [command, `--${command}`, "--yes"], first.additions);
    check(result.status === 0, result.stdout + result.stderr);
  }
  check(!readFileSync(join(home, ".codex", "config.toml"), "utf8").includes(cache), "standalone hook commands do not revert to cache runtime");
  // Every fixture child has closed. Windows can briefly retain the exited executable's
  // file handle; bound the same retries used in cleanup, then prove the cache is gone.
  rmSync(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  check(!existsSync(cache), "tool-runner cache is completely removed before installed hooks run");
  const hook = await run(firstConfig.command, firstConfig.args[0], ["hook", "--dry-run", "--summary"]);
  check(hook.status === 0, `installed hook survives cache removal: ${hook.stdout}${hook.stderr}`);
  const configuredHook = await runHookCommand(settings.hooks.SessionEnd[0].hooks[0].command);
  check(configuredHook.status === 0, `actual configured shell hook works with spaces: ${configuredHook.output}`);
  const bridge = await run(firstConfig.command, firstConfig.args[0], ["mcp"], {}, '{"jsonrpc":"2.0","id":71,"method":"tools/list"}\n');
  check(bridge.status === 0 && bridge.stdout.includes('"id":71'), `installed bridge survives cache removal: ${bridge.stdout}${bridge.stderr}`);
  const second = makeCache(join(scratch, "next cache"), "next runtime");
  const updated = await run(second.node, second.entry, ["update", "--yes", "--codex", "--antigravity"], second.additions);
  check(updated.status === 0, updated.stdout + updated.stderr);
  const nextConfig = cursorConfig();
  check(nextConfig.command !== firstConfig.command && existsSync(firstConfig.command), "new immutable install retains earlier executable for running clients");
  check(readFileSync(join(home, ".worktrust", "key.json")).equals(keyBefore), "updating runtime does not replace the coupling key");
  const beforeFailure = readFileSync(join(home, ".cursor", "mcp.json"));
  writeFileSync(join(second.runtime, "LICENSE"), "tampered");
  const failed = await run(second.node, second.entry, ["update", "--yes"], second.additions);
  check(failed.status !== 0 && readFileSync(join(home, ".cursor", "mcp.json")).equals(beforeFailure), "bad runtime leaves previous wiring intact");
  check(readFileSync(join(home, ".worktrust", "key.json")).equals(keyBefore), "bad runtime leaves credential intact");
  check(!readdirSync(join(home, ".worktrust", "installations")).some(name => name.startsWith(".install-")), "no staging directories left behind");
  const disconnected = await run(nextConfig.command, nextConfig.args[0], ["disconnect", "--yes"]);
  check(disconnected.status === 0, disconnected.stdout + disconnected.stderr);
  check(!existsSync(join(home, ".worktrust", "key.json")), "disconnect removes coupling key");
  check(existsSync(firstConfig.command) && existsSync(nextConfig.command), "disconnect does not delete active immutable executables");
  check(!JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"))).mcpServers?.worktrust, "disconnect removes client wiring");
  console.log(`cli-runtime: ${count} checks passed; synthetic coupling, cache eviction, update and disconnect`);
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
