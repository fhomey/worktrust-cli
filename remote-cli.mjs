/**
 * `npx worktrust remote ...`: STEER THIS COMPUTER'S AGENTS FROM YOUR PHONE (2026-11-07). Opt-in, at this keyboard only (an
 * AI agent's shell is refused by worktrust.mjs, `status` excepted). docs/remote-agents/PROTOCOL.md is the contract.
 *
 *   remote enable [--gateway <wss://…>] [--device]   pair this computer's REMOTE keys (not the measurement key) in the
 *                                                     Passport app, start the service, show a pairing QR; asks which road
 *   remote app | web                                  the same, approved in the WorkTrust app (a QR here, no browser) |
 *                                                     in the browser's approval page (owner, 2026-11-12)
 *   remote pair                                       a new QR for a phone (five minutes, one phone, once)
 *   remote status [--json]                            what is on, paired, running, granted and installed
 *   remote pause | resume                             refuse every command for now | take them again
 *   remote disable [--forget]                         the hard off: the service removed; --forget also deletes the keys
 *   remote phones [confirm <id> | remove <id>|--all]  phones: pending ones are confirmed here; --all cuts every one at once
 *   remote phones allow-endorse on|off                may a confirmed phone add a browser it scanned (default off)
 *   remote projects add <folder> | remove <id> | list the folders a phone may steer an agent in
 *   remote run                                        the daemon in the foreground (Windows runs only this way)
 *   remote pipeline review <folder> | status          read a granted folder's .worktrust/pipeline.json, show every stage
 *                                                     and command, and on a typed yes let a phone start it (pins a hash)
 *   remote roots add <dir> [--git-init] | remove <id|dir> | list   parent folders where a phone may create ONE new, empty
 *                                                     project folder (project.create); --git-init runs `git init` in it
 *   remote preview allow|deny <port|file> <folder> | list   what a phone may preview: a dev-server port on 127.0.0.1 or a
 *                                                     built HTML file, per granted folder (rendered with your Chrome)
 *   remote codex on | off                             offer Codex to a phone (off by default): Codex runs the reads it
 *                                                     deems safe without asking, which the person accepts here
 *   remote opencode on | off                          the same for OpenCode (off by default; remote-agent-switch.mjs)
 *   remote releases [released <number>]               the releases on this computer; mark a ready one released (the
 *                                                     phone never can: publishing stays at the desk)
 *   remote terminal on | off | list | start [<folder>] and remote attach <id>   terminal sessions (release 19): Claude Code
 *                                                     in tmux on WorkTrust's own socket, seen on the phone, attached here
 *                                                     (remote-terminal-cli.mjs; off by default)
 */
import { basename } from "node:path";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import * as P from "./remote-protocol.mjs";
import { ensureRemoteDir, isLoopbackGateway, issuerKeys, loadIdentity, loadKeys, loadPhones, loadProjects, loadSettings, newKeys, projectIdOf, random, readJson, removeFile, saveIdentity, saveKeys, savePhones, saveProjects, saveSettings, writeJson } from "./remote-store.mjs";
import { canonicalProject } from "./remote-policy.mjs";
import { IssuerMissing, PairingRefused, chooseRoad, pairComputer } from "./remote-pairing.mjs";
import { installService, removeService, serviceState, servicePlatform } from "./remote-service.mjs";
import { qrMatrix, renderQr } from "./remote-qr.mjs";
import { webSocketAvailable } from "./remote-transport.mjs";
import { inventory } from "./remote-inventory.mjs";
import { allowCommand, parsePipelineConfig, PIPELINE_FILE } from "./remote-pipeline-config.mjs";
import { pipelineState, projectReviewHash, readProjectFile } from "./remote-pipeline.mjs";
import { openJournal } from "./remote-journal.mjs";
import { loadPreviewGrants, savePreviewGrants } from "./remote-store.mjs";
import { loadDeskMarks, loadPipelineReviews, loadRoots, remotePath, saveDeskMarks, savePipelineReviews, saveRoots } from "./remote-store.mjs";
import { checkRoot, MAX_ROOTS, rootIdOf, rootLabel } from "./remote-projects.mjs";

const fingerprintOf = (keys) => P.deviceFingerprint(keys.public);
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** A question only a person at this keyboard answers: a terminal, a typed "yes"; --yes and Enter are No. */
export async function askTyped(question) {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question(`  ${question} Type yes to confirm: `)).trim().toLowerCase();
  prompt.close();
  return answer === "yes";
}

function needPaired(io) {
  const keys = loadKeys(), identity = loadIdentity();
  if (!keys || !identity) io.fail("this computer is not paired for remote yet: run `npx worktrust remote enable`");
  return { keys, identity };
}

async function enable(io, sub = "enable") {
  if (!webSocketAvailable()) io.fail(`remote needs Node 22.4 or later for its connection (this is ${process.versions.node}); the Python package bundles one`);
  const settings = loadSettings();
  const gateway = io.flag("gateway") ?? process.env.WORKTRUST_REMOTE_GATEWAY ?? settings.gateway;
  if (gateway && !P.isGatewayOrigin(gateway)) io.fail("--gateway is an origin: wss://host[:port], or ws://127.0.0.1:<port> for the dev relay");
  io.say();
  io.say("  WorkTrust remote lets your phone steer the AI agents on this computer. It will:");
  io.say("    - make a REMOTE key pair for this computer (not the measurement key), approved in WorkTrust with your second factor");
  io.say("    - run a small service while you are logged in, holding one outbound connection; it opens no port");
  io.say("    - let a phone steer agents only in folders you grant here, and approve only edits inside them, reviewed test,");
  io.say("      build and lint commands, and messages shown whole; everything else is decided at this keyboard");
  io.say("    - mark every session it steers, so remote work never counts as your AI Hours");
  if (!(await io.ask("Continue?"))) return;
  ensureRemoteDir();
  let identity = loadIdentity();
  if (!identity || io.has("repair")) {
    const keys = newKeys();
    const pub = P.publicKeysOf(P.importSecretKeys(keys));
    const road = sub !== "enable" ? sub : io.has("device") ? "web" : await chooseRoad({ yes: io.has("yes") });
    try {
      const paired = await pairComputer({ origin: io.origin, secret: P.importSecretKeys(keys), publicKeys: pub, host: hostname(), os: io.os, device: io.has("device"), road, showQr: (link) => io.say(renderQr(qrMatrix(link).modules, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR })), issuerKeys: issuerKeys(gateway), say: io.say, openBrowser: io.openBrowser });
      saveKeys(keys);
      identity = { v: 1, device_id: paired.device_id, binding: paired.binding, sub: paired.sub, origin: io.origin, paired_at: Date.now() };
      saveIdentity(identity);
      io.say(`  ✓ Paired${paired.account ? ` for ${paired.account}` : ""}. This computer's remote key: ${P.deviceFingerprint(pub)}`);
    } catch (error) {
      if (error instanceof IssuerMissing || error instanceof PairingRefused) io.fail(error.message);
      throw error;
    }
  } else io.say(`  Already paired (${identity.device_id}); --repair pairs again with new keys.`);
  saveSettings({ ...settings, enabled: true, paused: null, gateway: gateway ?? null, agent_path: process.env.PATH ?? null });
  if (loadProjects().length === 0) io.say("  No folder is granted yet: npx worktrust remote projects add <folder>");
  if (!gateway) { io.say("  No gateway is set: the production gateway is not live yet. Nothing runs until one is (--gateway)."); return; }
  if (servicePlatform() === "foreground") { io.say("  Windows: there is no service; run `npx worktrust remote run` and keep that terminal open."); return; }
  const runtime = await io.prepare();
  const service = installService({ program: [runtime.node, ...runtime.nodeArgs, runtime.entry, "remote", "run"], path: process.env.PATH ?? "" });
  io.say(service.started ? `  ✓ The service runs (${service.kind}, while you are logged in; linger stays off).` : `  ! The service file was written (${service.file}) but did not start; run \`npx worktrust remote run\` to see why.`);
  if (!io.has("no-pair")) await pair(io);
}

async function pair(io) {
  const { keys, identity } = needPaired(io);
  const settings = loadSettings();
  if (!settings.enabled || !settings.gateway) io.fail("remote is off or has no gateway: run `npx worktrust remote enable`");
  const started = Date.now();
  const invite = P.createPairingInvite({ gateway: settings.gateway, deviceId: identity.device_id, ed25519_pub: keys.public.ed25519_pub, x25519_pub: keys.public.x25519_pub, nowMs: started, random });
  const code = P.generatePairingCode(random);
  writeJson("invite.json", { ...invite, code, used: false, created_at: started });
  const link = P.encodePairingInvite(invite);
  io.say();
  io.say("  Scan this with the WorkTrust app (or the phone's camera):");
  io.say(renderQr(qrMatrix(link).modules, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }));
  io.say(`  Link: ${link}`);
  io.say(`  No camera? Type this code in the app: ${pretty(code)} (then confirm the phone here with \`npx worktrust remote phones\`)`);
  io.say("  The code and the QR work once, for five minutes. Ctrl+C cancels.");
  const cancel = () => { removeFile("invite.json"); process.exit(130); };
  process.once("SIGINT", cancel);
  const before = new Set(loadPhones().pending.map((p) => p.fingerprint));
  while (Date.now() < invite.e * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const phones = loadPhones();
    const paired = phones.confirmed.find((p) => p.how === "qr" && p.confirmed_at >= started);
    if (paired) { process.off("SIGINT", cancel); io.say(`  ✓ Paired: phone · ${paired.fingerprint}`); return; }
    const asked = phones.pending.find((p) => !before.has(p.fingerprint));
    if (asked) { process.off("SIGINT", cancel); io.say(`  A phone asked by code (${asked.fingerprint}). Confirm it at this keyboard: npx worktrust remote phones confirm ${asked.fingerprint}`); return; }
  }
  process.off("SIGINT", cancel);
  removeFile("invite.json");
  io.say("  The pairing code expired. Run `npx worktrust remote pair` for a new one.");
}

async function phones(io, rest) {
  const list = loadPhones();
  const find = (key) => [...list.pending, ...list.confirmed].find((p) => p.fingerprint === key?.toUpperCase() || p.device_id === key);
  if (rest[0] === "confirm") {
    const phone = list.pending.find((p) => p === find(rest[1]));
    if (!phone) io.fail("no pending phone by that fingerprint or id (`npx worktrust remote phones` lists them)");
    if (!process.stdin.isTTY) io.fail("a phone is confirmed at this keyboard, in a terminal");
    io.say(`  Your phone should show this computer's key and its own: ${phone.fingerprint}`);
    if (!(await askTyped(`Is ${phone.fingerprint} the fingerprint your phone shows?`))) { io.say("  Not confirmed."); return; }
    savePhones({ ...list, pending: list.pending.filter((p) => p !== phone), confirmed: [...list.confirmed.filter((p) => p.fingerprint !== phone.fingerprint), { ...phone, how: "keyboard", confirmed_at: Date.now() }] });
    io.say(`  ✓ Confirmed: phone · ${phone.fingerprint}`);
    return;
  }
  if (rest[0] === "allow-endorse") {
    // At this keyboard only (2026-11-09, remote-endorse.mjs): a phone confirmed here may then add a browser it scanned.
    if (rest[1] !== "on" && rest[1] !== "off") io.fail("npx worktrust remote phones allow-endorse on|off");
    if (rest[1] === "on" && !process.stdin.isTTY) io.fail("endorsements are allowed at this keyboard, in a terminal");
    if (rest[1] === "on" && !(await askTyped("  A phone confirmed here may then add a browser it scanned as a controller of this computer. Allow it?"))) { io.say("  Not changed."); return; }
    saveSettings({ ...loadSettings(), allow_endorse: rest[1] === "on" });
    io.say(rest[1] === "on" ? "  ✓ Your confirmed phones may add a browser. Each one is listed here with the phone that added it." : "  ✓ No phone may add a browser. Browsers already added stay until you remove them.");
    return;
  }
  if (rest[0] === "remove" && (rest[1] === "--all" || io.has("all"))) { // EVERY DEVICE OFF, FROM THE SOURCE (owner, 2026-11-09): the daemon reads this list per message
    const all = [...list.confirmed, ...list.pending], at = Date.now(); if (all.length === 0) return io.say("  No phone or browser is connected to this computer.");
    if (process.stdin.isTTY && !(await askTyped(`  Disconnect all ${all.length} phones and browsers from this computer now?`))) return io.say("  Nothing changed.");
    savePhones({ ...list, pending: [], confirmed: [], removed: [...list.removed.filter((p) => !all.some((x) => x.device_id === p.device_id)), ...all.map((p) => ({ device_id: p.device_id, fingerprint: p.fingerprint, how: "keyboard", removed_at: at }))].slice(-20) });
    return io.say(`  ✓ Disconnected ${all.length}: none of them can steer this computer any more. Live sessions they started keep running here; stop them with npx worktrust remote disable, or pause everything with npx worktrust remote pause.\n  End their keys for your whole account too: app.worktrust.io › Settings › Remote Agent, or Remote Agent settings on your phone.`);
  }
  if (rest[0] === "remove") {
    const phone = find(rest[1]);
    if (!phone) io.fail("no phone by that fingerprint or id");
    savePhones({ ...list, pending: list.pending.filter((p) => p.fingerprint !== phone.fingerprint), confirmed: list.confirmed.filter((p) => p.fingerprint !== phone.fingerprint),
      removed: [...list.removed.filter((p) => p.device_id !== phone.device_id), { device_id: phone.device_id, fingerprint: phone.fingerprint, how: "keyboard", removed_at: Date.now() }].slice(-20) });
    io.say(`  ✓ Removed ${phone.fingerprint}: it can no longer steer this computer. Revoke it in WorkTrust too.`);
    return;
  }
  io.say(`  Confirmed phones (${list.confirmed.length}):`);
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const how = (p) => p.how === "endorsed" ? `a browser, added by phone ${p.endorsed_by?.fingerprint ?? "?"}${[...list.confirmed, ...list.removed].some((x) => x.device_id === p.endorsed_by?.device_id && !list.confirmed.includes(x)) ? " (since removed)" : ""} on ${when(p.confirmed_at)}` : p.how === "qr" ? "scanned the QR" : "confirmed at the keyboard";
  for (const p of list.confirmed) io.say(`    ${p.fingerprint}  ${p.device_id}  (${how(p)})`);
  io.say(`  Phones may add a browser: ${loadSettings().allow_endorse ? "yes" : "no"} (npx worktrust remote phones allow-endorse on|off)`);
  io.say(`  Pending phones (${list.pending.length}):`);
  for (const p of list.pending) io.say(`    ${p.fingerprint}  ${p.device_id}   confirm: npx worktrust remote phones confirm ${p.fingerprint}`);
  if (list.removed.length > 0) {
    const WHY = { phone: "disconnected from the phone", revoked: "revoked in WorkTrust", keyboard: "removed here" };
    io.say(`  Removed phones (${list.removed.length}):`);
    for (const p of list.removed) io.say(`    ${p.fingerprint}  ${p.device_id}  (${WHY[p.how] ?? "removed"}, ${new Date(p.removed_at).toISOString().slice(0, 16).replace("T", " ")})`);
  }
}

function projects(io, rest) {
  const list = loadProjects();
  if (rest[0] === "add") {
    const { keys } = needPaired(io);
    const canonical = canonicalProject(rest[1]);
    if (!canonical.ok) io.fail(`not granted: ${canonical.reason}`);
    const project_id = projectIdOf(keys.projectSecret, canonical.path);
    if (!list.some((p) => p.project_id === project_id)) saveProjects([...list, { project_id, path: canonical.path, added_at: Date.now() }]);
    io.say(`  ✓ Granted: ${canonical.path}`);
    return;
  }
  if (rest[0] === "remove") {
    const canonical = canonicalProject(rest[1] ?? "");
    const kept = list.filter((p) => p.project_id !== rest[1] && p.path !== rest[1] && !(canonical.ok && p.path === canonical.path));
    if (kept.length === list.length) io.fail("no granted folder by that path or id");
    saveProjects(kept);
    io.say("  ✓ Removed.");
    return;
  }
  io.say(`  Granted folders (${list.length}):`);
  for (const p of list) io.say(`    ${p.path}  (${basename(p.path)})`);
}

/** `remote roots …`: where a phone may create a new project folder, added here at the keyboard only. */
function roots(io, rest) {
  const list = loadRoots();
  if (rest[0] === "add") {
    const { keys } = needPaired(io);
    const root = checkRoot(rest[1] ?? "");
    if (!root.ok) io.fail(`not added: ${root.reason}`);
    if (list.length >= MAX_ROOTS && !list.some((r) => r.path === root.path)) io.fail(`at most ${MAX_ROOTS} roots`);
    const root_id = rootIdOf(keys.projectSecret, root.path);
    saveRoots([...list.filter((r) => r.root_id !== root_id), { root_id, path: root.path, git_init: io.has("git-init"), added_at: Date.now() }]);
    io.say(`  ✓ Root: ${root.path} (${rootLabel(root.path)}). A phone may create one new, empty folder in it per request${io.has("git-init") ? ", with git init" : ""}.`);
    return;
  }
  if (rest[0] === "remove") {
    const kept = list.filter((r) => r.root_id !== rest[1] && r.path !== rest[1] && r.path !== checkRoot(rest[1] ?? "").path);
    if (kept.length === list.length) io.fail("no root by that path or id");
    saveRoots(kept);
    io.say("  ✓ Removed. Projects made in it stay granted: npx worktrust remote projects remove <folder>.");
    return;
  }
  io.say(`  Roots (${list.length}):`);
  for (const r of list) io.say(`    ${r.path}  (${rootLabel(r.path)}${r.git_init ? ", git init" : ""})`);
}

/** `remote pipeline review <folder>`: the person reads every stage and command, then a typed yes pins what they read. */
async function pipeline(io, rest) {
  const reviews = loadPipelineReviews();
  if (rest[0] === "status" || rest[0] === undefined) {
    for (const p of loadProjects()) io.say(`    ${p.path}  ${pipelineState(p, reviews).state}`);
    return;
  }
  if (rest[0] !== "review") io.fail("npx worktrust remote pipeline review <folder> | status");
  const canonical = canonicalProject(rest[1] ?? "");
  const project = canonical.ok ? loadProjects().find((p) => p.path === canonical.path) : null;
  if (!project) io.fail("that folder is not granted: npx worktrust remote projects add <folder>");
  const text = readProjectFile(project.path, PIPELINE_FILE, 65_536);
  if (text === null) io.fail(`no ${PIPELINE_FILE} in ${project.path}`);
  let scripts = null;
  try { scripts = JSON.parse(readProjectFile(project.path, "package.json", 1_048_576) ?? "null")?.scripts ?? null; } catch { scripts = null; }
  const parsed = parsePipelineConfig(text, scripts);
  if (!parsed.ok) io.fail(`${PIPELINE_FILE}: ${parsed.detail}`);
  io.say(`  ${project.path}: ${parsed.config.stages.length} stages, run one after another${parsed.config.run_after_tasks ? " once a release's tasks are done" : " when you start them"}`);
  for (const s of parsed.config.stages) {
    if (s.desk) { io.say(`    ${s.id}  ${s.label}  (${s.kind}): at your desk, never run from a phone`); continue; }
    const argv = allowCommand(s.run, scripts);
    io.say(`    ${s.id}  ${s.label}  (${s.kind}, ${s.parser}): ${[argv.file, ...argv.args].join(" ")}${argv.form === "script" ? `  →  ${scripts[argv.script]}` : ""}`);
    if (argv.form === "script") for (const hook of [`pre${argv.script}`, `post${argv.script}`]) if (typeof scripts[hook] === "string") io.say(`        and first/after it, ${hook}  →  ${scripts[hook]}`);
  }
  if (readProjectFile(project.path, ".npmrc", 65_536) !== null) io.say("    The project has an .npmrc: it is part of what you review (script-shell, node-options).");
  io.say("    What you review: this file, every package.json script, the .npmrc and the files the node stages run. A change to any needs a new review.");
  if (parsed.config.path_prepend.length > 0) io.say(`    PATH first: ${parsed.config.path_prepend.join(", ")}`);
  if (!(await askTyped("  A phone may start these stages on this computer, as you. Type yes to allow: "))) io.fail("not reviewed");
  savePipelineReviews({ ...reviews, [project.project_id]: { sha256: projectReviewHash(project), reviewed_at: Date.now(), stages: parsed.config.stages.length } });
  io.say("  ✓ Reviewed. A change to the file or to a script it names needs a new review.");
}

/** `remote releases [released <n>]`: read from the journal; the mark is a file the daemon reads, never a phone's. */
function releasesCommand(io, rest) {
  const list = openJournal(remotePath("journal.jsonl")).releases().sort((a, b) => b.number - a.number);
  if (rest[0] === "released") {
    const n = Number(rest[1]);
    const r = list.find((x) => x.number === n);
    if (!r) io.fail("no release by that number on this computer");
    if (r.state !== "ready") io.fail(`release ${n} is ${r.state}; only a ready release (its tasks and its pipeline passed) can be marked released`);
    saveDeskMarks([...loadDeskMarks(), n]);
    io.say(`  ✓ Release ${n} is marked released; the running daemon tells the phone.`);
    return;
  }
  io.say(`  Releases (${list.length}):`);
  for (const r of list) io.say(`    ${r.number}  ${r.state.padEnd(11)} ${r.tasks.filter((t) => t.state === "done").length}/${r.tasks.length} tasks  ${r.title}`);
}

function status(io) {
  const settings = loadSettings(), identity = loadIdentity(), keys = identity ? loadKeys() : null, phonesList = loadPhones(), service = serviceState();
  const agents = inventory({ env: { ...process.env, PATH: settings.agent_path ?? process.env.PATH } }).reports.filter((r) => r.installed);
  const summary = { enabled: settings.enabled, paused: settings.paused, paired: Boolean(identity), device_id: identity?.device_id ?? null, fingerprint: keys ? fingerprintOf(keys) : null,
    gateway: settings.gateway, service, node_websocket: webSocketAvailable(), phones: { confirmed: phonesList.confirmed.length, pending: phonesList.pending.length, browsers_added: phonesList.confirmed.filter((p) => p.how === "endorsed").length, allow_endorse: settings.allow_endorse === true }, projects: loadProjects().length,
    agents: agents.map((a) => ({ adapter: a.adapter, version: a.version, adapter_ready: a.capabilities.start, switched_off: a.capabilities.start && (a.adapter === "codex" || a.adapter === "opencode") && settings[a.adapter] !== true, models: a.models === null ? "not listed" : a.models.length })), invite_open: Boolean(readJson("invite.json")?.used === false) };
  if (io.has("json")) { io.say(JSON.stringify(summary, null, 2)); return; }
  io.say(`  Remote: ${settings.enabled ? (settings.paused ? `paused (${settings.paused === "desk" ? "here" : "from a phone"})` : "on") : "off"}`);
  io.say(`  Paired: ${identity ? `${identity.device_id} · key ${summary.fingerprint}` : "no"}`);
  io.say(`  Gateway: ${settings.gateway ?? "none set"}${settings.gateway && isLoopbackGateway(settings.gateway) ? " (this computer: dev relay)" : ""}`);
  io.say(`  Service: ${service.kind === "foreground" ? "none on this system: run `npx worktrust remote run`" : `${service.installed ? "installed" : "not installed"}, ${service.running ? "running" : "not running"}`}`);
  io.say(`  Phones: ${summary.phones.confirmed} confirmed (${summary.phones.browsers_added} browsers added by a phone), ${summary.phones.pending} pending · Folders granted: ${summary.projects}`);
  io.say(`  Phones may add a browser: ${summary.phones.allow_endorse ? "yes" : "no"}`);
  for (const a of summary.agents) io.say(`  Agent: ${a.adapter} ${a.version ?? ""} · ${a.switched_off ? `installed, switched off: npx worktrust remote ${a.adapter} on` : a.adapter_ready ? "remote adapter ready" : "installed, no adapter yet"} · models: ${a.models}`);
}

export async function remoteCommand(args, io) {
  const [sub = "help", ...rest] = args;
  if (sub === "enable" || sub === "app" || sub === "web") return enable(io, sub);
  if (sub === "pair") return pair(io);
  if (sub === "status") return status(io);
  if (sub === "pause" || sub === "resume") { const s = loadSettings(); saveSettings({ ...s, paused: sub === "pause" ? "desk" : null }); io.say(sub === "pause" ? "  Paused: every command from a phone is refused until `npx worktrust remote resume`." : "  Resumed."); return; }
  if (sub === "disable") {
    const s = loadSettings();
    saveSettings({ ...s, enabled: false, paused: null });
    io.say(`  Off. The service is removed (${removeService()}); the daemon stops by itself within seconds.`);
    if (io.has("forget")) { for (const f of ["remote-keys.json", "identity.json", "channels.json", "phones.json", "endorsements.json", "invite.json", "journal.jsonl", "projects.json", "pipelines.json", "released.json", "roots.json", "previews.json"]) removeFile(f); io.say("  The remote keys, phones, folders and journal are deleted. The steered-session ledger stays, so earlier remote work stays out of your AI Hours."); }
    return;
  }
  if (sub === "phones") return phones(io, rest);
  if (sub === "projects") return projects(io, rest);
  if (sub === "run") return (await import("./remote-run.mjs")).runDaemon({ say: io.say });
  if (sub === "pipeline") return pipeline(io, rest);
  if (sub === "roots") return roots(io, rest);
  if (sub === "preview") {
    const grants = loadPreviewGrants();
    if (rest[0] === "allow" || rest[0] === "deny") {
      const canonical = canonicalProject(rest[2] ?? process.cwd());
      const project = canonical.ok ? loadProjects().find((p) => p.path === canonical.path) : null;
      if (!project) io.fail("name a granted folder: npx worktrust remote preview allow <port|file> <folder>");
      const port = /^\d{1,5}$/.test(rest[1] ?? "") ? Number(rest[1]) : null;
      const file = port === null && /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+\.html?$/.test(rest[1] ?? "") ? rest[1] : null;
      if ((port === null || port < 1 || port > 65_535) && file === null) io.fail("a port (1-65535) or an .html file inside the folder");
      const g = grants[project.project_id] ?? { ports: [], files: [] };
      const next = rest[0] === "allow"
        ? { ports: port ? [...new Set([...g.ports, port])].slice(0, 20) : g.ports, files: file ? [...new Set([...g.files, file])].slice(0, 50) : g.files }
        : { ports: g.ports.filter((x) => x !== port), files: g.files.filter((x) => x !== file) };
      savePreviewGrants({ ...grants, [project.project_id]: next });
      io.say(`  ✓ ${rest[0] === "allow" ? "A phone may preview" : "No longer previewed:"} ${port ? `http://127.0.0.1:${port}` : file} in ${project.path}.`);
      return;
    }
    for (const p of loadProjects()) { const g = grants[p.project_id]; if (g) io.say(`    ${p.path}: ports ${g.ports.join(", ") || "none"} · files ${g.files.join(", ") || "none"}`); }
    return;
  }
  if (sub === "codex" || sub === "opencode") return (await import("./remote-agent-switch.mjs")).agentSwitch(io, sub, rest, askTyped);
  if (sub === "releases") return releasesCommand(io, rest);
  if (sub === "terminal") return (await import("./remote-terminal-cli.mjs")).terminalCommand(io, rest, askTyped);
  if (sub === "attach") return (await import("./remote-terminal-cli.mjs")).attachCommand(io, rest);
  io.say("  npx worktrust remote app | web | enable | pair | status | pause | resume | disable [--forget] | phones [confirm|remove <id>|remove --all|allow-endorse on|off] | projects add|remove|list | run | pipeline review <folder>|status | roots add|remove|list | preview allow|deny|list | codex on|off | opencode on|off | terminal on|off|list|start | attach <id> | releases [released <n>]");
}
