#!/usr/bin/env node
/**
 * WorkTrust — couple every MCP client on THIS machine in one go.
 *
 *   node setup-mcp.mjs --url https://app.worktrust.io/api/mcp --token wt_...          (shows what it would write)
 *   node setup-mcp.mjs --url ... --token ... --write                                  (writes it)
 *
 *   node setup-mcp.mjs --remove --write                                             (takes it out again)
 *
 * One machine, one token, many clients: Claude Code, Cursor, Codex, Gemini CLI, VS Code's
 * Copilot agent mode, Windsurf, Mistral Vibe, Google Antigravity, Grok Build, Zed, Cline, Hermes Agent, Goose. Each keeps its own config file in its own shape; this finds
 * the ones that exist here and adds the same WorkTrust server to each, so a coupling made once
 * counts everywhere — and every client names itself when it first speaks, which is how Sources
 * shows each product as coupled. Without --write nothing is touched. The token is shown
 * masked; it lives only in the files it is written to. A config that already names the server
 * is left as it is.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { placeUnder, takeOut } from "./config-edits.mjs";

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const WRITE = args.includes("--write");
const REMOVE = args.includes("--remove");
const NAME = value("name") ?? "worktrust";
/**
 * THE BRIDGE (2026-10-03). With `--bridge <path to worktrust.mjs>` no client is given a key: each
 * gets a local command (`node worktrust.mjs mcp`) that reads the key from ~/.worktrust/key.json
 * (mode 600) and speaks to the door for it. No config file holds the key.
 */
const BRIDGE = value("bridge");
const NODE = process.env.WORKTRUST_NODE || process.execPath;

/** The coupling: given, or the one Claude Code already holds (the counter reads it the same way). */
function fromClaude() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const found = [];
    const walk = (node) => { if (!node || typeof node !== "object") return; if (typeof node.url === "string" && node.url.includes("/api/mcp")) { const auth = node.headers?.Authorization ?? node.headers?.authorization ?? ""; if (auth.startsWith("Bearer ")) found.push({ url: node.url, token: auth.slice(7) }); } for (const child of Object.values(node)) walk(child); };
    walk(config); return found[0] ?? null;
  } catch { return null; }
}
const discovered = fromClaude();
/**
 * EVERY DIRECT WORKTRUST ENTRY CLAUDE CODE HOLDS, BY NAME (2026-10-04). A coupling made by hand may
 * carry any name ("worktrust-imac-home") and a key in its header; `npx worktrust` once read it as
 * "already coupled" and left Claude Code on that unbound key. With the bridge, each such entry is
 * taken out and the bridge put in; on removal, they all go. Only entries whose address is a
 * WorkTrust door are touched, user scope here and local scope in the folder that holds it.
 */
function directClaudeEntries() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const door = (server) => typeof server?.url === "string" && /\/api\/mcp\b/.test(server.url) && /worktrust/i.test(new URL(server.url).host);
    const entries = Object.entries(config.mcpServers ?? {}).filter(([, server]) => door(server)).map(([name]) => ({ name, scope: "user", dir: null }));
    for (const [dir, project] of Object.entries(config.projects ?? {})) for (const [name, server] of Object.entries(project?.mcpServers ?? {})) if (door(server)) entries.push({ name, scope: "local", dir });
    const bridged = Object.values(config.mcpServers ?? {}).some((server) => Array.isArray(server?.args) && server.args.includes(BRIDGE));
    return { entries, bridged };
  } catch { return { entries: [], bridged: false }; }
}
const URL_ = value("url") ?? process.env.WORKTRUST_MCP_URL ?? discovered?.url;
const TOKEN = value("token") ?? process.env.WORKTRUST_MCP_TOKEN ?? discovered?.token;
if (!URL_ || (!TOKEN && !BRIDGE)) { console.error("no coupling: pass --url and --token (from Sources → Claude (MCP) → Add coupling), or couple Claude Code first"); process.exit(1); }
const masked = BRIDGE ? "kept in ~/.worktrust/key.json, not in these files" : `${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}`;
const stdio = { command: NODE, args: [BRIDGE ?? "", "mcp"] };
const home = homedir();
/** Whether Claude Code's own command is on this machine: asked of the shell, never guessed from a file. */
const onPath = (command) => spawnSync(platform() === "win32" ? "where" : "which", [command], { encoding: "utf8", shell: platform() === "win32" }).status === 0;
const claudeOnPath = () => onPath("claude");
const VIBE_DIR = process.env.VIBE_HOME?.trim() || join(home, ".vibe");
const GROK_DIR = process.env.GROK_HOME?.trim() || join(home, ".grok");
const ZED_DIR = platform() === "win32" ? join(process.env.APPDATA ?? home, "Zed") : join(home, ".config", "zed");
const vscodeUser = platform() === "darwin" ? join(home, "Library", "Application Support", "Code", "User") : platform() === "win32" ? join(process.env.APPDATA ?? home, "Code", "User") : join(home, ".config", "Code", "User");
const CLINE_DIR = join(vscodeUser, "globalStorage", "saoudrizwan.claude-dev", "settings");
/**
 * HERMES AGENT (Nous Research, 2026-10-05): `mcp_servers` in config.yaml under its home (~/.hermes, %LOCALAPPDATA%/hermes
 * on Windows, HERMES_HOME) and under every profile's own home (profiles/<name>), `command`/`args` for a local server,
 * `url`/`headers` for a remote one (hermes-agent.nousresearch.com/docs/user-guide/features/mcp). With the bridge it also
 * gets one shell hook on `on_session_end` that wakes the session hook, which reads Hermes's own session database
 * (features/hooks); Hermes asks the person once before it runs a new hook. YAML is edited line by line and only in
 * block style: a file whose sections are written inline is left alone and the entry printed to add by hand.
 */
const HERMES_BASE = platform() === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : join(home, ".hermes");
const hermesHomes = () => {
  const homes = new Set([HERMES_BASE, ...(process.env.HERMES_HOME ? [process.env.HERMES_HOME] : [])]);
  try { for (const name of readdirSync(join(HERMES_BASE, "profiles")).sort()) homes.add(join(HERMES_BASE, "profiles", name)); } catch { /* no profiles */ }
  return [...homes].filter((dir) => existsSync(dir));
};
const HERMES_HOOK = `"${NODE}" "${BRIDGE ?? ""}" hook --hermes`;
const ours = (text) => text.includes(URL_) || /worktrust\.mjs/.test(text);
/** A YAML client's file with our entry (and hook) taken out and, unless removing, put back in; null when it cannot be. */
function yamlConfig(client, text, remove) {
  const lines = text.trim() === "" ? [] : text.replace(/\n$/, "").split("\n");
  takeOut(lines, [client.root], (unit) => new RegExp(`^\\s*${NAME}:`).test(unit) || ours(unit));
  if (client.hook) takeOut(lines, client.hook.path, ours);
  if (!remove) {
    if (!placeUnder(lines, [client.root], client.server)) return null;
    if (client.hook && BRIDGE && !placeUnder(lines, client.hook.path, client.hook.unit)) return null;
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
const bridgeOrUrl = (local, remote) => (BRIDGE ? local : remote);
const HERMES_SERVER = bridgeOrUrl([`${NAME}:`, `  command: ${JSON.stringify(NODE)}`, `  args: [${JSON.stringify(BRIDGE)}, "mcp"]`], [`${NAME}:`, `  url: ${JSON.stringify(URL_)}`, "  headers:", `    Authorization: ${JSON.stringify(`Bearer ${TOKEN}`)}`]);
/**
 * GOOSE (2026-10-05, aaif-goose/goose: crates/goose/src/config/extensions.rs, agents/extension.rs; documentation
 * guides/config-files.md): `extensions` in config.yaml (~/.config/goose, %APPDATA%\\Block\\goose\\config on Windows,
 * <GOOSE_PATH_ROOT>/config), each entry `type: stdio` with `cmd` and `args`, or `type: streamable_http` with `uri` and
 * `headers`. Its hooks come from Open Plugins folders (~/.agents/plugins/<name>/plugin.json + hooks/hooks.json,
 * guides/context-engineering/hooks.md); with the bridge one plugin named worktrust runs the session hook on SessionEnd.
 */
const GOOSE_SERVER = bridgeOrUrl(
  [`${NAME}:`, "  type: stdio", `  name: ${NAME}`, "  enabled: true", `  cmd: ${JSON.stringify(NODE)}`, `  args: [${JSON.stringify(BRIDGE)}, "mcp"]`, "  envs: {}", "  timeout: 300"],
  [`${NAME}:`, "  type: streamable_http", `  name: ${NAME}`, "  enabled: true", `  uri: ${JSON.stringify(URL_)}`, "  headers:", `    Authorization: ${JSON.stringify(`Bearer ${TOKEN}`)}`, "  envs: {}", "  timeout: 300"],
);
const gooseDirs = () => [...new Set([...(process.env.GOOSE_PATH_ROOT ? [join(process.env.GOOSE_PATH_ROOT, "config")] : []), join(home, ".config", "goose"), ...(platform() === "win32" && process.env.APPDATA ? [join(process.env.APPDATA, "Block", "goose", "config")] : [])])].filter((dir) => existsSync(dir));
const GOOSE_PLUGIN = join(process.env.GOOSE_PATH_ROOT || home, ".agents", "plugins", NAME);
const GOOSE_HOOKS = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `"${NODE}" "${BRIDGE ?? ""}" hook --goose`, timeout: 30 }] }] } };
const goosePluginStands = () => { try { return JSON.stringify(JSON.parse(readFileSync(join(GOOSE_PLUGIN, "hooks", "hooks.json"), "utf8"))) === JSON.stringify(GOOSE_HOOKS); } catch { return false; } };
/** Our plugin folder in, or out; another plugin is never touched, and a folder of that name that is not ours stays. */
function goosePlugin(remove) {
  let manifest = null; try { manifest = JSON.parse(readFileSync(join(GOOSE_PLUGIN, "plugin.json"), "utf8")); } catch { /* none */ }
  if (existsSync(GOOSE_PLUGIN) && manifest?.description !== GOOSE_DESCRIPTION) return false;
  if (remove) { rmSync(GOOSE_PLUGIN, { recursive: true, force: true }); return true; }
  mkdirSync(join(GOOSE_PLUGIN, "hooks"), { recursive: true });
  writeFileSync(join(GOOSE_PLUGIN, "plugin.json"), `${JSON.stringify({ name: NAME, version: "1.0.0", description: GOOSE_DESCRIPTION }, null, 2)}\n`);
  writeFileSync(join(GOOSE_PLUGIN, "hooks", "hooks.json"), `${JSON.stringify(GOOSE_HOOKS, null, 2)}\n`);
  return true;
}
const GOOSE_DESCRIPTION = "WorkTrust: wakes the WorkTrust session hook when a goose session ends (counts only, never content).";

/**
 * OPENCODE (2026-10-05, anomalyco/opencode: packages/core/src/v1/config/mcp.ts, opencode.ai/docs/mcp-servers): `mcp` in
 * ~/.config/opencode/opencode.json(c) (XDG_CONFIG_HOME moves it), `type: "local"` with `command` as one array, or
 * `type: "remote"` with `url` and `headers`. A file with comments is left alone, as for Zed. With the bridge one plugin
 * file, plugin/worktrust.js, wakes the session hook when a session goes idle (opencode.ai/docs/plugins: `session.idle`).
 */
const OPENCODE_DIR = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
const OPENCODE_FILE = ["opencode.jsonc", "opencode.json", "config.json"].map((name) => join(OPENCODE_DIR, name)).find((file) => existsSync(file)) ?? join(OPENCODE_DIR, "opencode.json");
const OPENCODE_PLUGIN = join(OPENCODE_DIR, "plugin", `${NAME}.js`);
const OPENCODE_MARK = "// WorkTrust: wakes the WorkTrust session hook when an OpenCode session goes idle (counts only, never content).";
const OPENCODE_PLUGIN_TEXT = `${OPENCODE_MARK}
import { spawn } from "node:child_process";
let last = 0;
export const WorkTrust = async () => ({
  event: async ({ event }) => {
    if (event?.type !== "session.idle" || Date.now() - last < 30_000) return;
    last = Date.now();
    try { spawn(${JSON.stringify(NODE)}, [${JSON.stringify(BRIDGE ?? "")}, "hook"], { detached: true, stdio: "ignore" }).unref(); } catch { /* the next run sweeps it */ }
  },
});
`;
/** Our plugin file in, or out; a file of that name that is not ours stays. */
function opencodePlugin(remove) {
  let text = null; try { text = readFileSync(OPENCODE_PLUGIN, "utf8"); } catch { /* none */ }
  if (text !== null && !text.startsWith(OPENCODE_MARK)) return false;
  if (remove) { rmSync(OPENCODE_PLUGIN, { force: true }); return true; }
  mkdirSync(dirname(OPENCODE_PLUGIN), { recursive: true });
  writeFileSync(OPENCODE_PLUGIN, OPENCODE_PLUGIN_TEXT);
  return true;
}
const opencodePluginStands = () => { try { return readFileSync(OPENCODE_PLUGIN, "utf8") === OPENCODE_PLUGIN_TEXT; } catch { return false; } };
/**
 * OPENCLAW (2026-10-05, openclaw/openclaw: docs/cli/mcp/registry.md, transports.md): its servers live under `mcp.servers`
 * in ~/.openclaw/openclaw.json, a JSON5 file OpenClaw replaces atomically, so it is never edited here: `openclaw mcp set
 * <name> <json>` writes the entry and `openclaw mcp unset <name>` takes it out (config only, no connection is made).
 * Without the `openclaw` command on this machine's PATH the command is printed to run. OpenClaw runs no shell hook; its
 * sessions are read whenever another client's hook runs.
 */
const OPENCLAW_FILE = process.env.OPENCLAW_CONFIG_PATH || join(process.env.OPENCLAW_STATE_DIR || join(home, ".openclaw"), "openclaw.json");
const OPENCLAW_ENTRY = BRIDGE ? { command: NODE, args: [BRIDGE, "mcp"] } : { url: URL_, transport: "streamable-http", headers: { Authorization: `Bearer ${TOKEN}` } };

/** Each client: where it lives, how it says "an HTTP MCP server with a header". */
const CLIENTS = [
  { key: "cursor", label: "Cursor", present: () => existsSync(join(home, ".cursor")), file: join(home, ".cursor", "mcp.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "codex", label: "Codex CLI", present: () => existsSync(join(home, ".codex")), file: join(home, ".codex", "config.toml"), shape: "toml", block: BRIDGE ? `\n[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(BRIDGE)}, "mcp"]\n` : `\n[mcp_servers.${NAME}]\nurl = "${URL_}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n` },
  { key: "gemini", label: "Gemini CLI", present: () => existsSync(join(home, ".gemini")), file: join(home, ".gemini", "settings.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { httpUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "copilot", label: "VS Code (Copilot agent mode)", present: () => existsSync(vscodeUser), file: join(vscodeUser, "mcp.json"), shape: "json", root: "servers", entry: BRIDGE ? { type: "stdio", ...stdio } : { type: "http", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "windsurf", label: "Windsurf", present: () => existsSync(join(home, ".codeium", "windsurf")), file: join(home, ".codeium", "windsurf", "mcp_config.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { serverUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  // MISTRAL VIBE (2026-10-04, docs.mistral.ai/vibe/code/cli/mcp-servers): `[[mcp_servers]]` tables in
  // ~/.vibe/config.toml (or $VIBE_HOME), each with a name, a transport and a url or a command.
  { key: "vibe", label: "Mistral Vibe", present: () => existsSync(VIBE_DIR), file: join(VIBE_DIR, "config.toml"), shape: "vibe", block: BRIDGE ? `\n[[mcp_servers]]\nname = "${NAME}"\ntransport = "stdio"\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(BRIDGE)}, "mcp"]\n` : `\n[[mcp_servers]]\nname = "${NAME}"\ntransport = "streamable-http"\nurl = "${URL_}"\nheaders = { "Authorization" = "Bearer ${TOKEN}" }\n` },
  // GOOGLE ANTIGRAVITY (2026-10-04, antigravity.google/docs/mcp/): the 2.0 app, the `agy` CLI and the IDE read
  // ~/.gemini/config/mcp_config.json; a remote server is `serverUrl` with headers (`url` and `httpUrl` are not
  // read), a local one `command` and `args`. Present when its config folder or one of its data folders is here.
  { key: "antigravity", label: "Antigravity", present: () => existsSync(join(home, ".gemini", "config")) || (() => { try { return readdirSync(join(home, ".gemini")).some((name) => /^antigravity/.test(name)); } catch { return false; } })(), file: join(home, ".gemini", "config", "mcp_config.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { serverUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  // GROK BUILD (2026-10-04, docs.x.ai/build/settings/reference): `[mcp_servers.<name>]` in ~/.grok/config.toml (or
  // $GROK_HOME), `url` and `headers` for a remote server, `command` and `args` for a local one.
  { key: "grok", label: "Grok Build", present: () => existsSync(GROK_DIR), file: join(GROK_DIR, "config.toml"), shape: "toml", block: BRIDGE ? `\n[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(BRIDGE)}, "mcp"]\n` : `\n[mcp_servers.${NAME}]\nurl = "${URL_}"\nheaders = { Authorization = "Bearer ${TOKEN}" }\n` },
  // ZED (zed.dev/docs/ai/mcp): `context_servers` in its settings.json, `url` and `headers` for a remote server.
  { key: "zed", label: "Zed", present: () => existsSync(ZED_DIR), file: join(ZED_DIR, "settings.json"), shape: "json", root: "context_servers", entry: BRIDGE ? { ...stdio, env: {} } : { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  // CLINE (docs.cline.bot/mcp): `mcpServers` in the extension's cline_mcp_settings.json; `type` must be
  // "streamableHttp" exactly, or Cline falls back to SSE and the door answers 405.
  { key: "cline", label: "Cline (VS Code)", present: () => existsSync(CLINE_DIR), file: join(CLINE_DIR, "cline_mcp_settings.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? { ...stdio, disabled: false } : { type: "streamableHttp", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` }, disabled: false } },
  ...hermesHomes().map((dir) => ({ key: "hermes", label: dir === HERMES_BASE ? "Hermes Agent" : `Hermes Agent (${dir.split(/[\\/]/).pop()})`, present: () => true, file: join(dir, "config.yaml"), shape: "yaml", root: "mcp_servers", server: HERMES_SERVER, hook: { path: ["hooks", "on_session_end"], unit: [`- command: ${JSON.stringify(HERMES_HOOK)}`, "  timeout: 30"], note: "an on_session_end hook (Hermes asks once before it runs it)" } })),
  ...gooseDirs().map((dir) => ({ key: "goose", label: "Goose", present: () => true, file: join(dir, "config.yaml"), shape: "yaml", root: "extensions", server: GOOSE_SERVER, plugin: true })),
  { key: "opencode", label: "OpenCode", present: () => existsSync(OPENCODE_DIR), file: OPENCODE_FILE, shape: "json", root: "mcp", entry: BRIDGE ? { type: "local", command: [NODE, BRIDGE, "mcp"], enabled: true } : { type: "remote", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` }, enabled: true }, plugin: "opencode" },
  { key: "openclaw", label: "OpenClaw", present: () => existsSync(dirname(OPENCLAW_FILE)) || onPath("openclaw"), file: OPENCLAW_FILE, shape: "openclaw" },
  { key: "claude", label: "Claude Code", present: () => existsSync(join(home, ".claude.json")), file: join(home, ".claude.json"), shape: "claude" },
];

console.log(`WorkTrust MCP ${REMOVE ? "removal" : "setup"} · door ${new URL(URL_).host} · token ${masked} · ${WRITE ? "WRITING" : "dry run — add --write to write"}`);
let touched = 0;
let standing = 0;
for (const client of CLIENTS) {
  if (!client.present()) { console.log(`  – ${client.label}: not on this machine`); continue; }
  if (client.shape === "openclaw") {
    const text = existsSync(client.file) ? readFileSync(client.file, "utf8") : "";
    const named = new RegExp(`["']?${NAME}["']?\\s*:\\s*\\{`).test(text) && ours(text);
    const verb = REMOVE ? ["mcp", "unset", NAME] : ["mcp", "set", NAME, JSON.stringify(OPENCLAW_ENTRY)];
    const shown = `openclaw ${verb.slice(0, 3).join(" ")}${REMOVE ? "" : ` '${JSON.stringify(OPENCLAW_ENTRY).replace(/Bearer [^"]+/, "Bearer <token>")}'`}`;
    if (REMOVE ? !named : named && text.includes(JSON.stringify(BRIDGE ?? URL_).slice(1, -1)) && (BRIDGE === undefined || !text.includes(URL_))) { console.log(REMOVE ? `  – ${client.label}: does not name the door` : `  ✓ ${client.label}: already names the door (${client.file})`); if (!REMOVE) standing += 1; continue; }
    if (!WRITE) { console.log(`  ${REMOVE ? "−" : "+"} ${client.label}: would run ${shown}`); continue; }
    if (!onPath("openclaw")) { console.log(`  ! ${client.label}: the \`openclaw\` command is not on this machine's PATH; run ${shown}`); continue; }
    const run = spawnSync("openclaw", verb, { encoding: "utf8", shell: platform() === "win32" });
    if (run.status === 0) { console.log(`  ${REMOVE ? "−" : "+"} ${client.label}: ${REMOVE ? "removed" : "coupled"} through \`openclaw mcp ${REMOVE ? "unset" : "set"}\``); touched += 1; }
    else console.log(`  ! ${client.label}: \`openclaw mcp\` refused (${(run.stderr || run.stdout || "").trim().split("\n")[0] || "no output"}); run it yourself: ${shown}`);
    continue;
  }
  if (client.shape === "claude") {
    // Claude Code owns this file and has its own verb for it, so this never edits the file: it RUNS
    // the verb when the `claude` command is on this machine (2026-09-28; before, the line was only
    // printed, and a person who had just run one command was handed a second to type), and prints
    // it when the command is not. User scope, so the coupling holds in every folder on this machine.
    const claudeArgs = REMOVE ? ["mcp", "remove", "-s", "user", NAME] : BRIDGE ? ["mcp", "add", "-s", "user", NAME, "--", NODE, BRIDGE, "mcp"] : ["mcp", "add", "--transport", "http", "-s", "user", NAME, URL_, "-H", `Authorization: Bearer ${TOKEN}`];
    const shown = REMOVE ? `claude mcp remove -s user ${NAME}` : BRIDGE ? `claude mcp add -s user ${NAME} -- "${NODE}" "${BRIDGE}" mcp` : `claude mcp add --transport http -s user ${NAME} "${URL_}" -H "Authorization: Bearer <token>"`;
    const direct = directClaudeEntries();
    if (!REMOVE && (BRIDGE ? direct.bridged && direct.entries.length === 0 : discovered)) { console.log(`  ✓ ${client.label}: already coupled`); standing += 1; continue; }
    // A direct entry under any name is replaced by the bridge, and every one goes on removal.
    if (BRIDGE || REMOVE) for (const entry of direct.entries.filter((one) => !(REMOVE && one.name === NAME && one.scope === "user"))) {
      const verb = `claude mcp remove -s ${entry.scope} ${entry.name}`;
      if (!WRITE) { console.log(`  ↻ ${client.label}: the direct entry "${entry.name}" (${entry.scope}) is replaced`); continue; }
      const out = claudeOnPath() ? spawnSync("claude", ["mcp", "remove", "-s", entry.scope, entry.name], { encoding: "utf8", shell: platform() === "win32", ...(entry.dir ? { cwd: entry.dir } : {}) }) : null;
      console.log(out?.status === 0 ? `  – ${client.label}: removed the direct entry "${entry.name}" (${entry.scope})` : `  ! ${client.label}: could not remove "${entry.name}"; run it yourself${entry.dir ? ` in ${entry.dir}` : ""}: ${verb}`);
    }
    if (WRITE && claudeOnPath()) {
      const run = spawnSync("claude", claudeArgs, { encoding: "utf8", shell: platform() === "win32" });
      if (run.status === 0) { console.log(`  + ${client.label}: ${REMOVE ? "removed" : "coupled"} through \`claude mcp ${REMOVE ? "remove" : "add"}\` (user scope)`); touched += 1; continue; }
      console.log(`  ! ${client.label}: \`claude mcp\` refused (${(run.stderr || run.stdout || "").trim().split("\n")[0] || "no output"}); run it yourself: ${shown}`);
      continue;
    }
    console.log(`  ! ${client.label}: ${WRITE ? "the `claude` command is not on this machine's PATH; " : ""}${REMOVE ? "run" : "couple with"} \`${shown}\``);
    continue;
  }
  const text = existsSync(client.file) ? readFileSync(client.file, "utf8") : "";
  // With the bridge, coupled means the bridge is in AND no entry with a key in it is left beside it.
  const already = client.shape === "yaml" && !REMOVE ? (BRIDGE !== undefined ? text.includes(JSON.stringify(BRIDGE)) && (!client.plugin || goosePluginStands()) : text.includes(URL_)) && yamlConfig(client, text, false) === text : REMOVE ? text.includes(URL_) || /worktrust\.mjs/.test(text) : BRIDGE !== undefined ? text.includes(JSON.stringify(BRIDGE).slice(1, -1)) && !text.includes(URL_) : text.includes(URL_);
  // THE WAY OUT, ON THE MACHINE. Uncoupling in the app ends the TOKEN; the config that names the
  // door stays behind on every client here, so the next person to read this file believes the
  // machine is coupled. `--remove` takes the entry out; the account side is a separate act and
  // this says so rather than pretending one does both.
  if (REMOVE) {
    if (!already) { console.log(`  – ${client.label}: does not name the door`); continue; }
    if (client.shape === "json") {
      let config = {};
      // A file that does not parse (comments, a trailing comma: Zed and VS Code allow both) is never rewritten.
      try { config = JSON.parse(readFileSync(client.file, "utf8")); } catch { console.log(`  ! ${client.label}: ${client.file} is not plain JSON; take the "${NAME}" entry out by hand`); continue; }
      const root = config[client.root] ?? {};
      for (const [key, entry] of Object.entries(root)) {
        const named = JSON.stringify(entry ?? {}).includes(URL_) || /worktrust\.mjs/.test(JSON.stringify(entry ?? {}));
        if (key === NAME || named) delete root[key];
      }
      config[client.root] = root;
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}${client.plugin && existsSync(OPENCODE_PLUGIN) ? ` and ${OPENCODE_PLUGIN}` : ""}`);
      if (WRITE) { writeFileSync(client.file, JSON.stringify(config, null, 2) + "\n"); if (client.plugin) opencodePlugin(true); }
    } else if (client.shape === "yaml") {
      const next = yamlConfig(client, readFileSync(client.file, "utf8"), true);
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}${client.plugin && existsSync(GOOSE_PLUGIN) ? ` and ${GOOSE_PLUGIN}` : ""}`);
      if (WRITE) { writeFileSync(client.file, next); if (client.plugin) goosePlugin(true); }
    } else if (client.shape === "vibe") {
      // Vibe's servers are an ARRAY of tables, so a block is found by what it says, not by its header: every
      // `[[mcp_servers]]` that names ours, the door, or the bridge goes, up to the next header at a line start.
      const text = readFileSync(client.file, "utf8");
      const stripped = text.replace(/\n?\[\[mcp_servers\]\][\s\S]*?(?=\n\[|$)/g, (block) => (block.includes(`name = "${NAME}"`) || block.includes(URL_) || /worktrust\.mjs/.test(block) ? "" : block));
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}`);
      if (WRITE) writeFileSync(client.file, stripped);
    } else if (client.shape === "toml") {
      const text = readFileSync(client.file, "utf8");
      // The block and nothing after it: from its own header to the next one, or the end.
      // Every block that names the door, under any name (a hand-made one too, 2026-10-04), or ours.
      // A block runs to the next table header at the START of a line, never to the next "[" — the
      // bridge's own `args = ["…", "mcp"]` holds one, and cutting there left half a block behind.
      const stripped = text.replace(/\n?\[mcp_servers\.("?)([A-Za-z0-9_.-]+)\1\][\s\S]*?(?=\n\[|$)/g, (block, _q, name) => (name === NAME || block.includes(URL_) || /worktrust\.mjs/.test(block) ? "" : block));
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}`);
      if (WRITE) writeFileSync(client.file, stripped);
    }
    touched += 1;
    continue;
  }
  if (already && !(client.plugin === "opencode" && BRIDGE && !opencodePluginStands())) { console.log(`  ✓ ${client.label}: already names the door (${client.file})`); standing += 1; continue; }
  if (client.shape === "json") {
    let config = {};
    // NEVER OVERWRITE WHAT DOES NOT PARSE (2026-10-04): Zed's and VS Code's settings allow comments and trailing
    // commas, and reading such a file as empty would write the person's settings away. An empty or absent file is
    // a new one; anything else that fails to parse is left alone and the entry is printed to add by hand.
    const raw = existsSync(client.file) ? readFileSync(client.file, "utf8") : "";
    try { config = raw.trim() ? JSON.parse(raw) : {}; } catch {
      console.log(`  ! ${client.label}: ${client.file} is not plain JSON (comments?), so it is left as it is. Add this under "${client.root}" yourself:\n    "${NAME}": ${JSON.stringify(client.entry).replace(/Bearer [^"]+/, "Bearer <token>")}`);
      continue;
    }
    config[client.root] = { ...(config[client.root] ?? {}), [NAME]: client.entry };
    console.log(`  + ${client.label}: ${WRITE ? "wrote" : "would write"} ${client.file} → ${client.root}.${NAME}${client.plugin && BRIDGE ? ` and ${OPENCODE_PLUGIN}` : ""}`);
    if (WRITE) {
      mkdirSync(dirname(client.file), { recursive: true }); writeFileSync(client.file, JSON.stringify(config, null, 2) + "\n"); touched += 1;
      if (client.plugin && BRIDGE && !opencodePlugin(false)) console.log(`  ! ${client.label}: ${OPENCODE_PLUGIN} exists and is not WorkTrust's, so no plugin was written; OpenCode sessions are still read whenever another hook runs`);
    }
  } else if (client.shape === "yaml") {
    const next = yamlConfig(client, text, false);
    if (next === null) { console.log(`  ! ${client.label}: ${client.file} writes ${client.root}${client.hook ? " or hooks" : ""} inline, so it is left as it is. Add under ${client.root}:\n    ${client.server.join("\n    ")}`); continue; }
    const hookNote = !BRIDGE ? "" : client.hook ? ` and ${client.hook.note}` : client.plugin ? ` and a SessionEnd hook in ${GOOSE_PLUGIN}` : "";
    console.log(`  + ${client.label}: ${WRITE ? "wrote" : "would write"} ${client.file} → ${client.root}.${NAME}${hookNote}`);
    if (WRITE) {
      mkdirSync(dirname(client.file), { recursive: true }); writeFileSync(client.file, next); touched += 1;
      if (client.plugin && BRIDGE && !goosePlugin(false)) console.log(`  ! ${client.label}: ${GOOSE_PLUGIN} exists and is not WorkTrust's, so no hook was written; goose sessions are still read whenever another hook runs`);
    }
  } else if (client.shape === "toml" || client.shape === "vibe") {
    console.log(`  + ${client.label}: ${WRITE ? "appended to" : "would append to"} ${client.file} → ${client.shape === "vibe" ? `[[mcp_servers]] name = "${NAME}"` : `[mcp_servers.${NAME}]`}`);
    if (WRITE) { mkdirSync(dirname(client.file), { recursive: true }); writeFileSync(client.file, (existsSync(client.file) ? readFileSync(client.file, "utf8") : "") + client.block); touched += 1; }
  }
}
// A COUNT OF WHAT CHANGED IS NOT A COUNT OF WHAT WORKS. "0 clients coupled" after five ticks
// reads as a failed run, and somebody re-runs it, or worse, re-couples by hand and mints a second
// token for one machine. Say both numbers: what was added, and what already stood.
console.log(
  REMOVE
    ? WRITE
      ? `\n${touched} client${touched === 1 ? "" : "s"} no longer name the door on this machine. THE COUPLING ITSELF STILL EXISTS: end it in the app (Sources → the computer's row → end this coupling), or the token keeps working wherever else it is installed.`
      : "\nNothing written. Run again with --remove --write to take it out."
    : WRITE
      ? `\n${touched} added, ${standing + (discovered ? 1 : 0)} already coupled.${touched > 0 ? " Restart each client that changed; it names itself the first time it speaks, and Sources shows it as coupled." : " Nothing needed changing."}`
      : "\nNothing written. Run again with --write to couple them.",
);
