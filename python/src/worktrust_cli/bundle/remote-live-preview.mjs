/**
 * THE LIVE PREVIEW (release 19, 2026-11-09; owner's preview option A; PROTOCOL.md "The live preview"). The session's
 * granted dev page, live and touchable on the phone: the person's own Chrome, headless, in a throw-away profile, driven over
 * its PIPE (remote-cdp.mjs: never a debugging port), its screencast sent as JPEG frames on the session's transient lane, the
 * phone's taps, scrolls and literal text applied as input events.
 *
 * THE PAGE STAYS ON THE GRANTED ORIGIN, held three ways (each one tested):
 *   1. the network: every request goes to a dead proxy except the granted origin (`--proxy-server` with
 *      `--proxy-bypass-list=<-loopback>;127.0.0.1:<port>`), so nothing else is reachable, not even another local port;
 *   2. the DevTools protocol: every request of every frame and worker is paused (Fetch) and continued only for the granted
 *      origin; anything else is failed and counted (a document as a navigation, the rest as requests); a page that still
 *      lands elsewhere (file://, a scheme) is sent back and counted; a new page (a popup) is closed; a download is denied;
 *      a dialog is dismissed; permission prompts are denied by the browser's own switch;
 *   3. the phone: it names a PATH on the granted target, never a URL; input coordinates must lie inside the viewport;
 *      text is inserted literally; keys come from a list of three.
 * One live preview per computer. It stops when nobody follows it (LIVE_FOLLOW_MS), when its session closes, when the
 * browser exits, or on follow:false; the browser is ended and its profile and the file server removed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "./remote-protocol.mjs";
import { createCdp, spawnBrowserOnPipe } from "./remote-cdp.mjs";
import { findBrowser, listening, serveProject } from "./remote-preview.mjs";

export const FRAME_MS = 200;
export const LIVE_FOLLOW_MS = 90_000;
const KEYCODE = { Enter: 13, Backspace: 8, Tab: 9 };

/** The command line: headless, its own profile, on its pipe, and a network that reaches the granted origin only. */
export function liveArgs({ profile, port }) {
  return ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--mute-audio", "--hide-scrollbars", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--deny-permission-prompts", "--block-new-web-contents",
    "--proxy-server=127.0.0.1:9", `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`, "about:blank"];
}

/** The one origin a page may load from: http, 127.0.0.1, the granted (or file server's) port. */
export const originOk = (url, port) => { try { const u = new URL(url); return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port === String(port); } catch { return false; } };
const toB64Url = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ctx: { emit, projects(), grants(), sessionProject(id), env(), log, now, spawnBrowser?, browser?(), listening?(port), serve?(root), followMs?, frameMs? }
export function createLivePreview(ctx) {
  let live = null; // one per computer
  const followMs = ctx.followMs ?? LIVE_FOLLOW_MS, frameMs = ctx.frameMs ?? FRAME_MS;
  const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
  const state = (l, s, reason = null) => {
    l.state = s;
    ctx.emit(l.session_id, "preview.live", { state: s, viewport: l.viewport, width: l.vp.width, height: l.vp.height, title: l.title, path: l.path, blocked: { ...l.blocked }, reason }, null);
  };
  const block = (l, kind) => { l.blocked[kind] += 1; if (!l.stopped) l.dirty(); };

  async function stop(l, reason) {
    if (!l || l.stopped) return;
    l.stopped = true;
    clearTimeout(l.expiry); clearTimeout(l.frameTimer);
    if (live === l) live = null;
    // The browser first, then its files: it asked to close, then its process group ended, each with a grace, and only
    // once it is gone the profile is removed (a browser still writing into it would leave it behind).
    const gone = (ms) => { let t; return Promise.race([l.proc.exited.then(() => true), new Promise((r) => { t = setTimeout(() => r(false), ms); })]).finally(() => clearTimeout(t)); }; // held: a stop finishes
    await Promise.race([l.cdp.send("Browser.close").catch(() => {}), gone(2000)]);
    l.cdp.close();
    if (!(await gone(2000))) { l.proc.kill("SIGTERM"); if (!(await gone(2000))) { l.proc.kill("SIGKILL"); await gone(2000); } }
    l.proc.kill("SIGKILL"); // what is left of its group (a renderer, a helper)
    l.server?.close();
    try { rmSync(l.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { ctx.log("live_profile_left", {}); }
    state(l, reason === "browser_exited" || reason === "failed" ? "failed" : "stopped", reason);
  }

  /** Newest frame wins; at most one per frameMs; none unless someone follows (an expired follow stops the preview). */
  function offerFrame(l, frame) {
    l.frame = frame;
    if (l.frameTimer) return;
    const wait = l.sentAt + frameMs - ctx.now();
    const go = () => { l.frameTimer = null; const f = l.frame; l.frame = null; if (!f || l.stopped) return; l.sentAt = ctx.now(); ctx.emit(l.session_id, "preview.frame", f, null, "none", { transient: true }); };
    if (wait <= 0) go(); else l.frameTimer = later(go, wait);
  }

  async function onEvent(l, method, p, sessionId) {
    const cdp = l.cdp;
    if (method === "Target.attachedToTarget") {
      const sid = p.sessionId, info = p.targetInfo ?? {};
      // The browser's own first page (no opener) is the preview's page; any other page is a popup, closed.
      if (info.type === "page" && !l.targetId && !info.openerId) l.targetId = info.targetId;
      else if (info.type === "page" && info.targetId !== l.targetId) { block(l, "popup"); await cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {}); return; }
      // Every frame and worker of the page passes the same interception, and so do the ones they start.
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sid).catch(() => {});
      await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
      if (info.targetId === l.targetId && !l.pageSession) await page(l, sid);
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
      return;
    }
    if (method === "Fetch.requestPaused") {
      if (originOk(p.request?.url, l.port)) return void cdp.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId).catch(() => {});
      block(l, p.resourceType === "Document" ? "navigation" : "request");
      return void cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
    }
    if (method === "Page.frameNavigated" && sessionId === l.pageSession && !p.frame?.parentId) {
      const url = String(p.frame?.url ?? "");
      if (url === "about:blank") return;
      if (originOk(url, l.port)) { l.path = new URL(url).pathname.slice(0, 300) || "/"; l.good = url; return; }
      // A navigation the interception failed lands on the browser's error page: back, counted once (by the interception).
      if (!url.startsWith("chrome-error:")) block(l, url.startsWith("file:") ? "file" : "navigation");
      return void cdp.send("Page.navigate", { url: l.good }, l.pageSession).catch(() => {});
    }
    if (method === "Page.screencastFrame" && sessionId === l.pageSession) {
      cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, l.pageSession).catch(() => {});
      const data = toB64Url(String(p.data ?? ""));
      if (Math.floor(data.length * 3 / 4) > P.MAX_FRAME_BYTES) return ctx.log("live_frame_dropped", {});
      const m = p.metadata ?? {};
      offerFrame(l, { width: Math.max(1, Math.min(4096, Math.round(m.deviceWidth ?? l.vp.width))), height: Math.max(1, Math.min(16_384, Math.round(m.deviceHeight ?? l.vp.height))), data });
      if (l.state !== "live") { l.state = "live"; l.dirty(); }
      return;
    }
    if (method === "Page.loadEventFired" && sessionId === l.pageSession) {
      const r = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, l.pageSession).catch(() => null);
      const t = typeof r?.result?.value === "string" ? r.result.value.trim().slice(0, 300) : "";
      l.title = t || null; l.dirty();
      return;
    }
    if (method === "Page.javascriptDialogOpening" && sessionId === l.pageSession) { block(l, "popup"); return void cdp.send("Page.handleJavaScriptDialog", { accept: false }, l.pageSession).catch(() => {}); }
    if (method === "Browser.downloadWillBegin") block(l, "download");
  }

  async function viewportOf(l) {
    const mobile = l.viewport !== "desktop";
    await l.cdp.send("Page.stopScreencast", {}, l.pageSession).catch(() => {}); // a second start alone keeps the old size
    await l.cdp.send("Emulation.setDeviceMetricsOverride", { width: l.vp.width, height: l.vp.height, deviceScaleFactor: 1, mobile }, l.pageSession).catch(() => {});
    await l.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: l.vp.width, maxHeight: l.vp.height, everyNthFrame: 1 }, l.pageSession).catch(() => {});
  }

  async function page(l, sid) {
    l.pageSession = sid;
    await l.cdp.send("Page.enable", {}, sid).catch(() => {});
    await viewportOf(l);
    l.cdp.send("Page.navigate", { url: l.url }, sid).catch(() => {});
  }

  async function start(env, p) {
    const project = ctx.sessionProject(env.session_id);
    if (!project) return "not_found";
    const g = ctx.grants()[project.project_id] ?? { ports: [], files: [] };
    if (p.target === "port" ? !(g.ports ?? []).includes(p.port) : !(g.files ?? []).includes(p.path)) return "unsupported"; // granted at the keyboard only
    const browser = (ctx.browser ?? (() => findBrowser(ctx.env())))();
    if (!browser) return "unsupported";
    if (live && live.session_id !== env.session_id) return "busy"; // one live preview per computer
    if (live) await stop(live, "stopped");
    if (p.target === "port" && !(await (ctx.listening ?? listening)(p.port))) return "not_found";
    const server = p.target === "file" ? await (ctx.serve ?? serveProject)(project.path) : null;
    const port = p.target === "port" ? p.port : server.port;
    const profile = mkdtempSync(join(tmpdir(), "wt-live-"));
    const l = { session_id: env.session_id, viewport: p.viewport, vp: P.PREVIEW_VIEWPORTS[p.viewport], port, server, profile, title: null, path: p.target === "port" ? p.path : `/${p.path}`, url: `http://127.0.0.1:${port}${p.target === "port" ? p.path : `/${p.path}`}`,
      good: "about:blank", blocked: { ...P.NO_BLOCKS }, state: "starting", stopped: false, sentAt: -Infinity, frame: null, frameTimer: null, expiry: null, pageSession: null, targetId: null };
    let dirtyTimer = null;
    l.dirty = () => { if (!dirtyTimer) dirtyTimer = later(() => { dirtyTimer = null; if (!l.stopped) state(l, l.state); }, 250); };
    l.proc = (ctx.spawnBrowser ?? spawnBrowserOnPipe)(browser, liveArgs({ profile: join(profile, "p"), port }), ctx.env());
    l.cdp = createCdp({ write: l.proc.write, onEvent: (m, params, sid) => { onEvent(l, m, params, sid).catch(() => {}); } });
    l.proc.onData((chunk) => l.cdp.feed(chunk));
    l.proc.exited.then(() => { if (!l.stopped) stop(l, "browser_exited"); });
    live = l;
    l.expiry = later(() => stop(l, "unfollowed"), followMs);
    state(l, "starting");
    try {
      await l.cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
      await l.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      // A browser that attached no first page of its own is given one (its attach event makes it the preview's page).
      later(() => { if (!l.targetId && !l.stopped) l.cdp.send("Target.createTarget", { url: "about:blank" }).catch(() => {}); }, 1500);
    } catch { await stop(l, "failed"); return "unsupported"; }
    return "taken";
  }

  async function input(l, i) {
    if (i.kind === "tap" || i.kind === "scroll") {
      if (i.x >= l.vp.width || i.y >= l.vp.height) return "unsupported"; // inside the viewport only
      if (i.kind === "scroll") return (await l.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: i.x, y: i.y, deltaX: 0, deltaY: i.dy }, l.pageSession).then(() => "taken", () => "not_found"));
      for (const type of ["mousePressed", "mouseReleased"]) await l.cdp.send("Input.dispatchMouseEvent", { type, x: i.x, y: i.y, button: "left", clickCount: 1 }, l.pageSession).catch(() => {});
      return "taken";
    }
    if (i.kind === "text") { if (!P.liveTextOk(i.text)) return "unsupported"; return l.cdp.send("Input.insertText", { text: i.text }, l.pageSession).then(() => "taken", () => "not_found"); }
    if (!Object.hasOwn(KEYCODE, i.key)) return "unsupported";
    const code = KEYCODE[i.key];
    await l.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: i.key, code: i.key, windowsVirtualKeyCode: code, ...(i.key === "Enter" ? { text: "\r" } : {}) }, l.pageSession).catch(() => {});
    await l.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: i.key, code: i.key, windowsVirtualKeyCode: code }, l.pageSession).catch(() => {});
    return "taken";
  }

  return {
    current: () => live,
    async handle(env, payload) {
      if (env.type === "preview.live_start") return start(env, payload);
      const l = live && live.session_id === env.session_id ? live : null;
      if (!l || l.stopped) return "not_found";
      if (env.type === "preview.live_follow") {
        if (!payload.follow) { await stop(l, "stopped"); return "taken"; }
        clearTimeout(l.expiry); l.expiry = later(() => stop(l, "unfollowed"), followMs);
        return "taken";
      }
      if (env.type === "preview.live_viewport") { l.viewport = payload.viewport; l.vp = P.PREVIEW_VIEWPORTS[payload.viewport]; await viewportOf(l); l.dirty(); return "taken"; }
      if (env.type === "preview.live_input") return input(l, payload);
      return "unsupported";
    },
    /** The session closed: its live preview ends. */
    sessionClosed: (sessionId) => (live && live.session_id === sessionId ? stop(live, "closed") : undefined),
    stopAll: () => (live ? stop(live, "stopped") : undefined),
  };
}
