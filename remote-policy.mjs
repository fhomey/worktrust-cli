/**
 * WHAT A PHONE MAY REACH ON THIS COMPUTER (2026-11-07; owner decisions, binding). The computer's own policy, never the
 * phone's: the phone shows what this file decided and the computer refuses anything else however well it is signed.
 *
 * PROJECTS. A phone may steer an agent only inside a folder the person granted at this keyboard
 * (`worktrust remote projects add`). A grant is the folder's canonical path (realpath: every symlink resolved), a
 * directory, and never the home folder itself, a parent of it, the root, or a place that holds secrets (~/.ssh, ~/.gnupg,
 * keychains, browser profiles, wallets, cloud credentials).
 *
 * APPROVALS. Every permission request an agent makes is put in ONE of the protocol's APPROVAL_CLASSES here. Only two
 * may reach the phone (owner decision 6): `project_edit`, a file edit inside the granted project that touches no secret
 * and no rule file, and `reviewed_command`, a command from the short reviewed list below (tests, builds, linters), run
 * exactly as listed, with no shell syntax. Everything else is decided at the keyboard or not at all: an install from the
 * network, git push, a deploy, deleting outside the project, reading a secret path, any "always allow" rule, and
 * whatever this file cannot name (`other`). Unknown fails closed.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as P from "./remote-protocol.mjs";

const HOME = () => realpathOr(homedir());
function realpathOr(path) { try { return realpathSync(path); } catch { return resolve(path); } }

/** Inside `root` (both canonical): equal to it or below it, never through `..`. */
export const isInside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

/** Folders that hold secrets or another program's private state, relative to the home folder. */
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".password-store", ".worktrust",
  "Library/Keychains", "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge", "Library/Safari", "Library/Cookies", ".mozilla", ".config/google-chrome", ".config/chromium",
  ".config/BraveSoftware", ".local/share/keyrings", ".electrum", ".bitcoin", ".ethereum", "Library/Ethereum", "Library/Application Support/Exodus", ".config/solana"];
/** File names that are secrets wherever they lie. `.env` and its variants, keys, credentials, token stores. */
const SECRET_FILE = /^(\.env(\..*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|ecdsa|ed25519|dsa)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account.*\.json|wallet\.dat|keystore)$/i;
/** Files that change what an agent may do by itself: permission rules, hooks, MCP servers. Editing one is an "always allow". */
/** Files that change what an agent or a tool may do by itself: permission rules, hooks, MCP servers, the repository's own
 * configuration (core.fsmonitor and sshCommand run code), editor tasks. Editing one is an "always allow". Case-insensitive:
 * macOS and Windows disks are, and a path typed as .CLAUDE/SETTINGS.JSON is the same file (review 2026-11-07, P1-a). */
const RULE_FILE = /(^|[\\/])(\.claude[\\/].*|\.mcp\.json|\.claude\.json|\.codex[\\/].*|\.cursor[\\/].*|\.git([\\/].*)?|\.husky[\\/].*|\.vscode[\\/].*|\.idea[\\/].*|\.envrc|\.npmrc|\.yarnrc(\.yml)?|\.gitattributes|\.gitmodules)$/i;
/** Files that say what a reviewed command runs (scripts, targets, test setup): an edit to one from a phone would turn the next
 * "npm test" into anything, so it is decided at the keyboard (P2-a). */
const SCRIPT_FILE = /(^|[\\/])(package\.json|makefile|gnumakefile|justfile|taskfile\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|noxfile\.py|conftest\.py|pytest\.ini|cargo\.toml|build\.rs|go\.mod|deno\.jsonc?|bunfig\.toml|turbo\.json|nx\.json|(jest|vitest|vite|webpack|rollup|babel|eslint|prettier)\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/i;

export function isSecretPath(path) {
  const canonical = realpathOr(path), home = HOME();
  if (SECRET_FILE.test(basename(canonical))) return true;
  return SECRET_DIRS.some((dir) => isInside(join(home, dir), canonical));
}

/** A folder a person asks to grant: its canonical form, or the reason it cannot be granted. */
export function canonicalProject(path) {
  if (typeof path !== "string" || path.trim() === "") return { ok: false, reason: "name a folder" };
  const given = resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
  if (!existsSync(given)) return { ok: false, reason: "that folder does not exist" };
  const canonical = realpathSync(given);
  if (!statSync(canonical).isDirectory()) return { ok: false, reason: "that is a file, not a folder" };
  const home = HOME();
  if (dirname(canonical) === canonical) return { ok: false, reason: "the root of the disk cannot be granted" };
  if (isInside(canonical, home)) return { ok: false, reason: "your home folder, or a folder above it, cannot be granted: grant one project folder" };
  if (isSecretPath(canonical) || SECRET_DIRS.some((dir) => isInside(canonical, join(home, dir)))) return { ok: false, reason: "that folder holds secrets (keys, keychains, browser profiles, wallets, credentials)" };
  return { ok: true, path: canonical };
}

/** The project a path is in, by the canonical path of the path itself or, for a file not yet written, of its folder. */
export function canonicalTarget(path, cwd) {
  if (typeof path !== "string" || path === "") return null;
  // The nearest folder that exists, every symlink in it resolved, then the rest added back: a new file under a link that
  // points outside the project is outside it (review 2026-11-07, P1-b).
  let existing = resolve(cwd, path);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  let base;
  try { base = realpathSync.native(existing); } catch { base = realpathOr(existing); }
  return rest.length ? join(base, ...rest) : base;
}

/**
 * THE REVIEWED COMMANDS: tests, builds and linters, exactly. A command is approvable from a phone only when its words,
 * split on spaces, match one line here with nothing after it but plain arguments ([A-Za-z0-9_./:=@,+-], no `..`).
 * No package runner that may download (`npx`, `pnpm dlx`, `bunx`), no install, no script that names a deploy.
 */
export const REVIEWED_COMMANDS = Object.freeze([
  "npm test", "npm run test", "npm run build", "npm run lint", "npm run typecheck",
  "pnpm test", "pnpm run test", "pnpm build", "pnpm run build", "pnpm lint", "pnpm run lint", "pnpm typecheck", "pnpm run typecheck",
  "yarn test", "yarn build", "yarn lint", "bun test", "bun run test", "bun run build", "bun run lint",
  "node --test", "pytest", "python -m pytest", "python3 -m pytest", "cargo test --offline", "cargo build --offline", "cargo check --offline", "cargo clippy --offline",
  "make test", "make build", "make lint", "make check", "tsc --noEmit", "eslint", "ruff check", "mypy", "prettier --check",
]);
/** An argument after a reviewed line is a relative path or a test name inside the project: no flag, no assignment, no absolute
 * path, no way up (review 2026-11-07, P2-a: `make test -C /x`, `npm test --prefix=/x`, `node --test --require=/x`). */
const PLAIN_ARG = /^[A-Za-z0-9_][A-Za-z0-9_./:@,+-]*$/;
const SHELL_SYNTAX = /[;&|`$<>(){}\\\n\r'"*?!~#]/;
const NETWORK = /^(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|dlx|x|create|init)\b|^(npx|bunx|pip3?|pipx|uv|poetry|gem|brew|apt(-get)?|dnf|yum|cargo\s+install|go\s+(get|install)|curl|wget|git\s+(clone|fetch|pull)|docker\s+(pull|run))\b/;
const PUSH = /^git\s+push\b/;
const DEPLOY = /^(vercel|netlify|fly|flyctl|firebase|heroku|wrangler|serverless|sls|kubectl|helm|terraform|pulumi|eas|gcloud|aws|az|railway|render)\b|^(npm|pnpm|yarn)\s+(publish|run\s+deploy|deploy)\b|\bdeploy\b/;

export function reviewedCommand(command) {
  if (typeof command !== "string" || SHELL_SYNTAX.test(command)) return false;
  const words = command.trim().split(/\s+/);
  return REVIEWED_COMMANDS.some((line) => {
    const head = line.split(" ");
    if (head.some((word, i) => words[i] !== word)) return false;
    return words.slice(head.length).every((arg) => PLAIN_ARG.test(arg) && !arg.split("/").includes(".."));
  });
}

function classifyCommand(command, project) {
  const text = String(command ?? "").trim();
  if (PUSH.test(text)) return "git_push";
  if (DEPLOY.test(text)) return "deploy";
  if (NETWORK.test(text)) return "network_install";
  if (/^(rm|rmdir|unlink|trash|shred)\b/.test(text)) {
    const targets = text.split(/\s+/).slice(1).filter((w) => !w.startsWith("-"));
    return targets.some((t) => !isInside(project, canonicalTarget(t, project) ?? "/")) ? "delete_outside_project" : "other";
  }
  if (/(^|\s)(cat|less|more|head|tail|grep|rg|cp|scp|base64)\s/.test(` ${text} `) && text.split(/\s+/).some((w) => SECRET_FILE.test(basename(w)) || w.includes(".ssh"))) return "secret_read";
  return reviewedCommand(text) ? "reviewed_command" : "other";
}

/**
 * AN OUTWARD MESSAGE (owner, 2026-11-07): a connector tool (mcp__<server>__<tool>) whose tool name says it sends (send,
 * reply, post, publish) is `outward_message` ONLY when every field of the message can be read from its input and nothing
 * else is in it: recipients (to, or a channel), cc, bcc, subject, the text, attachment names, and a thread to answer in.
 * An input with any other field, no recipient, no text, or attachments it cannot name is `other`, denied locally: the
 * phone must see the whole message it approves. Claude Code's permission request names the tool, not its description,
 * so the name decides.
 */
const SENDS = /(^|_)(send|reply|post|publish)(_|$)/;
const MESSAGE_KEYS = new Set(["to", "recipients", "recipient", "channel", "cc", "bcc", "subject", "body", "text", "message", "content", "attachments", "thread_id", "threadId", "in_reply_to", "inReplyTo"]);
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const addresses = (value) => (value === undefined ? [] : typeof value === "string" ? value.split(",").map((a) => a.trim()).filter(Boolean) : Array.isArray(value) && value.every((a) => typeof a === "string") ? value : null);
export function outwardMessageOf(tool, args, project) {
  const m = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/.exec(String(tool));
  if (!m || !SENDS.test(snake(m[2]))) return null;
  if (Object.keys(args).some((k) => !MESSAGE_KEYS.has(k))) return { refused: "the message has fields the phone could not be shown" };
  const to = addresses(args.to ?? args.recipients ?? args.recipient ?? args.channel), cc = addresses(args.cc), bcc = addresses(args.bcc);
  const text = [args.body, args.text, args.message, args.content].filter((v) => v !== undefined);
  const attachments = args.attachments === undefined ? [] : Array.isArray(args.attachments) ? args.attachments.map((a) => (typeof a === "string" ? a : a?.filename ?? a?.name ?? a?.path)) : null;
  if (!to || to.length === 0 || to.length > 100 || !cc || !bcc || cc.length > 100 || bcc.length > 100) return { refused: "the message's recipients cannot all be shown" };
  if (text.length !== 1 || typeof text[0] !== "string" || text[0].length > 65_536) return { refused: "the message's text cannot be shown whole" };
  if (!attachments || attachments.length > 50 || attachments.some((a) => typeof a !== "string" || !a)) return { refused: "the message's attachments cannot all be named" };
  if (attachments.some((a) => isSecretPath(canonicalTarget(a, project) ?? a) || !isInside(project, canonicalTarget(a, project) ?? "/"))) return { refused: "an attachment is a secret file or lies outside the project" };
  if (args.subject !== undefined && (typeof args.subject !== "string" || args.subject.length > 998)) return { refused: "the message's subject cannot be shown" };
  if ([...to, ...cc, ...bcc].some((a) => a.length > 320)) return { refused: "a recipient is too long to show" };
  return { message: { channel: m[1].slice(0, 128), to, cc, bcc, subject: args.subject ?? null, text: text[0], attachments } };
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
export const MAX_SHOWN_INPUT = 16_384;

/**
 * One permission request → the action the phone would see, with its class. `tool` is the agent's own tool name, `input`
 * its exact arguments, `project` the canonical project folder. Pure apart from reading which paths exist.
 */
export function classifyAction(adapter, tool, input, project, rationale = null) {
  const args = input && typeof input === "object" ? input : {};
  const shown = JSON.stringify(args);
  let kind = "tool", cls = "other", files = [];
  if (tool === "Bash") {
    kind = "command";
    cls = classifyCommand(args.command, project);
  } else if (EDIT_TOOLS.has(tool)) {
    const target = canonicalTarget(args.file_path ?? args.notebook_path, project);
    files = target ? [target] : [];
    kind = tool === "Write" && target && !existsSync(target) ? "write" : "edit";
    cls = !target ? "other" : RULE_FILE.test(target) ? "persistent_rule" : isSecretPath(target) ? "secret_read" : !isInside(project, target) ? "other" : SCRIPT_FILE.test(target) ? "other" : "project_edit";
  } else if (READ_TOOLS.has(tool)) {
    const target = canonicalTarget(args.file_path ?? args.path ?? args.notebook_path, project);
    files = target ? [target] : [];
    kind = "tool";
    cls = target && isSecretPath(target) ? "secret_read" : "other";
  } else if (tool === "WebFetch" || tool === "WebSearch") kind = "network";
  const outward = outwardMessageOf(tool, args, project);
  if (outward) {
    const base = { kind: "message", adapter, tool: String(tool).slice(0, 128), files: [], rationale };
    if (outward.refused || shown.length > MAX_SHOWN_INPUT) return { action: { ...base, class: "other", input: shown.slice(0, MAX_SHOWN_INPUT) }, reason: outward.refused ?? "the message is too long to show exactly" };
    return { action: { ...base, class: "outward_message", input: shown, message: outward.message }, reason: null };
  }
  // What the phone shows is the exact input. When it cannot be shown whole, it cannot be approved from a phone.
  if (shown.length > MAX_SHOWN_INPUT) return { action: { kind, class: "other", adapter, tool: String(tool).slice(0, 128) || "unknown", input: `${shown.slice(0, MAX_SHOWN_INPUT - 40)} [cut: too long to show exactly]`, files: files.slice(0, 100), rationale }, reason: "the request is too long to show exactly" };
  const action = { kind, class: P.APPROVAL_CLASSES.includes(cls) ? cls : "other", adapter, tool: String(tool).slice(0, 128) || "unknown", input: shown.length > 0 ? shown : "{}", files: files.slice(0, 100), rationale };
  return { action, reason: P.isRemoteApprovable(action.class) ? null : REASONS[action.class] };
}

export const REASONS = Object.freeze({
  network_install: "installs from the network are approved at the computer, never from a phone",
  git_push: "git push is approved at the computer, never from a phone",
  deploy: "deploys are approved at the computer, never from a phone",
  delete_outside_project: "deleting outside the project is never approved from a phone",
  secret_read: "secret files (keys, .env, credentials) are never opened from a phone",
  persistent_rule: "rules that let an agent act alone later are set at the computer, never from a phone",
  other: "only edits inside the project, reviewed test, build and lint commands, and messages shown whole are approved from a phone",
});

/**
 * THE PROJECT AN ACTION IS JUDGED AGAINST (CLI 0.11.7, several projects in one session): the session's main project,
 * unless the file the agent names lies inside one of the session's extra projects (`extraPaths`, resolved at the start
 * from the computer's own inventory, never a phone's path); then that one. The action's files are absolute paths, so the
 * phone shows which project an edit is in.
 */
export function projectForAction(session, input) {
  const extras = Array.isArray(session?.extraPaths) ? session.extraPaths : [];
  const named = input && typeof input === "object" ? input.file_path ?? input.notebook_path ?? input.path : null;
  if (extras.length === 0 || typeof named !== "string") return session.projectPath;
  const target = canonicalTarget(named, session.projectPath);
  if (!target || isInside(session.projectPath, target)) return session.projectPath;
  return extras.find((p) => isInside(p, target)) ?? session.projectPath;
}

/** The one gate between a classified action and the phone. Nothing else in the daemon may decide this. */
export const phoneMayDecide = (action) => P.APPROVAL_CLASSES.includes(action?.class) && P.isRemoteApprovable(action.class);

export const SEP = sep;
