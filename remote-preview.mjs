/**
 * A LOCAL PREVIEW FOR THE PHONE (owner, 2026-11-07: the phone's "Deploy" segment is a LOCAL preview, never a production
 * deploy). docs/remote-agents/PROTOCOL.md "Local preview".
 *
 * The person grants, per project and at the keyboard, the dev-server PORTS and the built HTML FILES a phone may preview
 * (`worktrust remote preview allow <port|file> <folder>`; ~/.worktrust/remote/previews.json). `preview.render` renders one
 * of them with the person's installed Chrome or Chromium, headless (`--headless=new --screenshot --window-size`), in a
 * throw-away profile, and answers with the PNG in sealed chunks and the page's title and HTTP status as the computer saw
 * them. The URL is always built here: `http://127.0.0.1:<granted port><path>`, never a host or URL from the phone. A file
 * is served to Chrome by a one-shot server on 127.0.0.1 that answers only files inside the project (no dotfile, no secret
 * path, no link out), so Chrome never opens file:// and a page cannot pull another file of the computer into the picture.
 * No browser installed: refused (`unsupported`); nothing is installed. One render at a time.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, get } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, extname, join, relative, sep } from "node:path";
import * as P from "./remote-protocol.mjs";
import { isSecretPath } from "./remote-policy.mjs";

const MAC_BROWSERS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"];
const PATH_BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
const TYPES = { ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon" };
const RENDER_MS = 30_000;

/** The person's own Chrome-family browser, or null. WORKTRUST_PREVIEW_BROWSER (the daemon's own environment) is for tests. */
export function findBrowser(env = process.env) {
  const forced = process.env.WORKTRUST_PREVIEW_BROWSER;
  if (forced) return existsSync(forced) ? forced : null;
  // The repo's named Chromium (CI installs Playwright's and names it here, as every browser check does), then the computer's own.
  const named = process.env.WORKTRUST_CHROME_BIN;
  if (named && existsSync(named)) return named;
  if (process.platform === "darwin") for (const f of MAC_BROWSERS) if (existsSync(f)) return f;
  for (const dir of (env.PATH ?? "").split(delimiter)) for (const b of PATH_BROWSERS) if (dir && existsSync(join(dir, b))) return join(dir, b);
  return null;
}

/** Something listens on 127.0.0.1:port. */
export const listening = (port, ms = 500) => new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.once("connect", () => done(true)); s.once("error", () => done(false)); s.setTimeout(ms, () => done(false));
});

const inside = (root, p) => { const rel = relative(root, p); return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)); };

/** A one-shot server for a project's files: inside the project only, no dotfile, no secret, no link out. */
export function serveProject(root) {
  const base = realpathSync(root);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const file = join(base, path);
    let ok = false;
    try { ok = !path.split("/").some((seg) => seg.startsWith(".")) && existsSync(file) && lstatSync(file).isFile() && inside(base, realpathSync(file)) && !isSecretPath(realpathSync(file)); } catch { ok = false; }
    if (!ok) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })));
}

/** The status and <title> of the page as the computer reads it (256 KiB at most). */
export const pageFacts = (url) => new Promise((resolve) => {
  const req = get(url, { timeout: 5000 }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { if (body.length < 262_144) body += c; });
    res.on("end", () => resolve({ status: res.statusCode ?? null, title: /<title[^>]*>([^<]{1,300})<\/title>/i.exec(body)?.[1]?.trim() || null }));
  });
  req.on("timeout", () => req.destroy());
  req.on("error", () => resolve({ status: null, title: null }));
});

/** A PNG's own width and height (its IHDR), or null. */
export function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** The fixed command line: headless, a throw-away profile, no first run, the window, the screenshot file, the URL. */
export function browserArgs({ profile, out, width, height, url }) {
  return ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--disable-sync",
    `--user-data-dir=${profile}`, `--screenshot=${out}`, `--window-size=${width},${height}`, "--virtual-time-budget=5000", url];
}

export function createPreview(ctx) {
  // ctx: { emit, projects(), grants() → { [project_id]: { ports: [], files: [] } }, env(), log }
  let busy = false;
  const grantOf = (projectId) => ctx.grants()[projectId] ?? { ports: [], files: [] };

  async function targets(env, p) {
    const project = ctx.projects().find((x) => x.project_id === p.project_id);
    if (!project) return "not_found";
    const g = grantOf(p.project_id);
    const ports = await Promise.all((g.ports ?? []).slice(0, 20).map(async (port) => ({ port, listening: await listening(port) })));
    ctx.emit(null, "preview.targets", { project_id: p.project_id, ports, files: (g.files ?? []).slice(0, 50), browser: findBrowser(ctx.env()) !== null }, env.command_id);
    return "taken";
  }

  async function render(env, p) {
    const project = ctx.projects().find((x) => x.project_id === p.project_id);
    if (!project) return "not_found";
    const g = grantOf(p.project_id);
    if (p.target === "port" ? !(g.ports ?? []).includes(p.port) : !(g.files ?? []).includes(p.path)) return "unsupported"; // granted at the keyboard only
    const browser = findBrowser(ctx.env());
    if (!browser) return "unsupported";
    if (busy) return "busy";
    if (p.target === "port" && !(await listening(p.port))) return "not_found";
    busy = true;
    const profile = mkdtempSync(join(tmpdir(), "wt-preview-"));
    let server = null;
    try {
      let url;
      if (p.target === "port") url = `http://127.0.0.1:${p.port}${p.path}`;
      else { server = await serveProject(project.path); url = `http://127.0.0.1:${server.port}/${p.path}`; }
      const facts = await pageFacts(url);
      const vp = P.PREVIEW_VIEWPORTS[p.viewport];
      const height = p.full_page ? Math.min(vp.height * 4, 6000) : vp.height; // a tall window, not a measured page: see PROTOCOL.md
      const out = join(profile, "shot.png");
      const code = await new Promise((resolve) => {
        const child = spawn(browser, browserArgs({ profile: join(profile, "p"), out, width: vp.width, height, url }), { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true, env: ctx.env() });
        const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, RENDER_MS);
        child.on("error", () => { clearTimeout(timer); resolve(-1); });
        child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
      });
      const png = existsSync(out) ? readFileSync(out) : null;
      const size = png && pngSize(png);
      if (code !== 0 || !png || !size || png.length > P.MAX_PREVIEW_BYTES) { ctx.log("preview_failed", { code }); return "unsupported"; }
      const chunks = Math.ceil(png.length / P.PREVIEW_CHUNK_BYTES);
      for (let n = 0; n < chunks; n += 1)
        ctx.emit(null, "preview.image", { preview_id: p.preview_id, chunk: n, chunks, data: P.toBase64Url(png.subarray(n * P.PREVIEW_CHUNK_BYTES, (n + 1) * P.PREVIEW_CHUNK_BYTES)) }, env.command_id);
      ctx.emit(null, "preview.rendered", { preview_id: p.preview_id, project_id: p.project_id, viewport: p.viewport, width: Math.min(size.width, 4096), height: Math.min(size.height, 16_384),
        title: facts.title ? facts.title.slice(0, 300) : null, http_status: p.target === "port" && facts.status >= 100 && facts.status <= 599 ? facts.status : null, bytes: png.length,
        sha256: P.toBase64Url(createHash("sha256").update(png).digest()), chunks }, env.command_id);
      return "taken";
    } finally {
      server?.close();
      rmSync(profile, { recursive: true, force: true });
      busy = false;
    }
  }

  return { handle: (env, payload) => (env.type === "preview.targets" ? targets(env, payload) : render(env, payload)) };
}
