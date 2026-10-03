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
 * Copilot agent mode, Windsurf. Each keeps its own config file in its own shape; this finds
 * the ones that exist here and adds the same WorkTrust server to each, so a coupling made once
 * counts everywhere — and every client names itself when it first speaks, which is how Sources
 * shows each product as coupled. Without --write nothing is touched. The token is shown
 * masked; it lives only in the files it is written to. A config that already names the server
 * is left as it is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

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
const URL_ = value("url") ?? process.env.WORKTRUST_MCP_URL ?? discovered?.url;
const TOKEN = value("token") ?? process.env.WORKTRUST_MCP_TOKEN ?? discovered?.token;
if (!URL_ || (!TOKEN && !BRIDGE)) { console.error("no coupling: pass --url and --token (from Sources → Claude (MCP) → Add coupling), or couple Claude Code first"); process.exit(1); }
const masked = BRIDGE ? "kept in ~/.worktrust/key.json, not in these files" : `${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}`;
const stdio = { command: NODE, args: [BRIDGE ?? "", "mcp"] };
const home = homedir();
/** Whether Claude Code's own command is on this machine: asked of the shell, never guessed from a file. */
const claudeOnPath = () => spawnSync(platform() === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", shell: platform() === "win32" }).status === 0;
const vscodeUser = platform() === "darwin" ? join(home, "Library", "Application Support", "Code", "User") : platform() === "win32" ? join(process.env.APPDATA ?? home, "Code", "User") : join(home, ".config", "Code", "User");

/** Each client: where it lives, how it says "an HTTP MCP server with a header". */
const CLIENTS = [
  { key: "cursor", label: "Cursor", present: () => existsSync(join(home, ".cursor")), file: join(home, ".cursor", "mcp.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "codex", label: "Codex CLI", present: () => existsSync(join(home, ".codex")), file: join(home, ".codex", "config.toml"), shape: "toml", block: BRIDGE ? `\n[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(BRIDGE)}, "mcp"]\n` : `\n[mcp_servers.${NAME}]\nurl = "${URL_}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n` },
  { key: "gemini", label: "Gemini CLI", present: () => existsSync(join(home, ".gemini")), file: join(home, ".gemini", "settings.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { httpUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "copilot", label: "VS Code (Copilot agent mode)", present: () => existsSync(vscodeUser), file: join(vscodeUser, "mcp.json"), shape: "json", root: "servers", entry: BRIDGE ? { type: "stdio", ...stdio } : { type: "http", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "windsurf", label: "Windsurf", present: () => existsSync(join(home, ".codeium", "windsurf")), file: join(home, ".codeium", "windsurf", "mcp_config.json"), shape: "json", root: "mcpServers", entry: BRIDGE ? stdio : { serverUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
  { key: "claude", label: "Claude Code", present: () => existsSync(join(home, ".claude.json")), file: join(home, ".claude.json"), shape: "claude" },
];

console.log(`WorkTrust MCP ${REMOVE ? "removal" : "setup"} · door ${new URL(URL_).host} · token ${masked} · ${WRITE ? "WRITING" : "dry run — add --write to write"}`);
let touched = 0;
let standing = 0;
for (const client of CLIENTS) {
  if (!client.present()) { console.log(`  – ${client.label}: not on this machine`); continue; }
  if (client.shape === "claude") {
    // Claude Code owns this file and has its own verb for it, so this never edits the file: it RUNS
    // the verb when the `claude` command is on this machine (2026-09-28; before, the line was only
    // printed, and a person who had just run one command was handed a second to type), and prints
    // it when the command is not. User scope, so the coupling holds in every folder on this machine.
    const claudeArgs = REMOVE ? ["mcp", "remove", "-s", "user", NAME] : BRIDGE ? ["mcp", "add", "-s", "user", NAME, "--", NODE, BRIDGE, "mcp"] : ["mcp", "add", "--transport", "http", "-s", "user", NAME, URL_, "-H", `Authorization: Bearer ${TOKEN}`];
    const shown = REMOVE ? `claude mcp remove -s user ${NAME}` : BRIDGE ? `claude mcp add -s user ${NAME} -- "${NODE}" "${BRIDGE}" mcp` : `claude mcp add --transport http -s user ${NAME} "${URL_}" -H "Authorization: Bearer <token>"`;
    if (!REMOVE && discovered) { console.log(`  ✓ ${client.label}: already coupled`); standing += 1; continue; }
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
  const already = text.includes(URL_) || (BRIDGE !== undefined && text.includes(JSON.stringify(BRIDGE).slice(1, -1))) || (REMOVE && /worktrust\.mjs/.test(text));
  // THE WAY OUT, ON THE MACHINE. Uncoupling in the app ends the TOKEN; the config that names the
  // door stays behind on every client here, so the next person to read this file believes the
  // machine is coupled. `--remove` takes the entry out; the account side is a separate act and
  // this says so rather than pretending one does both.
  if (REMOVE) {
    if (!already) { console.log(`  – ${client.label}: does not name the door`); continue; }
    if (client.shape === "json") {
      let config = {};
      try { config = JSON.parse(readFileSync(client.file, "utf8")); } catch { config = {}; }
      const root = config[client.root] ?? {};
      for (const [key, entry] of Object.entries(root)) {
        const named = JSON.stringify(entry ?? {}).includes(URL_) || /worktrust\.mjs/.test(JSON.stringify(entry ?? {}));
        if (key === NAME || named) delete root[key];
      }
      config[client.root] = root;
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}`);
      if (WRITE) writeFileSync(client.file, JSON.stringify(config, null, 2) + "\n");
    } else if (client.shape === "toml") {
      const text = readFileSync(client.file, "utf8");
      // The block and nothing after it: from its own header to the next one, or the end.
      const stripped = text.replace(new RegExp(`\\n?\\[mcp_servers\\.${NAME}\\][^\\[]*`, "g"), "\n");
      console.log(`  − ${client.label}: ${WRITE ? "removed from" : "would remove from"} ${client.file}`);
      if (WRITE) writeFileSync(client.file, stripped);
    }
    touched += 1;
    continue;
  }
  if (already) { console.log(`  ✓ ${client.label}: already names the door (${client.file})`); standing += 1; continue; }
  if (client.shape === "json") {
    let config = {};
    try { config = JSON.parse(readFileSync(client.file, "utf8")); } catch { config = {}; }
    config[client.root] = { ...(config[client.root] ?? {}), [NAME]: client.entry };
    console.log(`  + ${client.label}: ${WRITE ? "wrote" : "would write"} ${client.file} → ${client.root}.${NAME}`);
    if (WRITE) { mkdirSync(dirname(client.file), { recursive: true }); writeFileSync(client.file, JSON.stringify(config, null, 2) + "\n"); touched += 1; }
  } else if (client.shape === "toml") {
    console.log(`  + ${client.label}: ${WRITE ? "appended to" : "would append to"} ${client.file} → [mcp_servers.${NAME}]`);
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
