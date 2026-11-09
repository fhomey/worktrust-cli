/**
 * THE DEVTOOLS PROTOCOL OVER A PIPE (release 19, 2026-11-09; the live preview, remote-live-preview.mjs). Chrome is started
 * with `--remote-debugging-pipe`: it reads commands from its file descriptor 3 and writes answers and events to 4, each
 * message JSON ending in a NUL byte. NO DEBUGGING PORT IS EVER OPENED: no `--remote-debugging-port`, no TCP listener a
 * page, another process or another computer could reach (held by test-remote-live-preview and check-remote-cli rule F).
 *
 * `createCdp({ write, onEvent })` is the client over any pair of pipes (a fake one in the tests): `send(method, params,
 * sessionId)` resolves with the result or rejects with the error; `feed(chunk)` takes what the browser wrote.
 */
import { spawn } from "node:child_process";

export const MAX_MESSAGE = 32 * 1024 * 1024;
const CALL_MS = 15_000;

/** The browser on pipes: stdio 0-2 closed to us, 3 for commands, 4 for answers. Never a shell, never a port. */
export function spawnBrowserOnPipe(file, args, env) {
  if (args.some((a) => /^--remote-debugging-(port|address)/.test(a))) throw new Error("a debugging port is never opened");
  if (!args.includes("--remote-debugging-pipe")) throw new Error("the browser is driven over its pipe only");
  const child = spawn(file, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, env });
  const exited = new Promise((resolve) => { child.on("exit", (code) => resolve(code)); child.on("error", () => resolve(-1)); });
  return {
    pid: child.pid,
    write: (data) => { try { child.stdio[3].write(data); } catch { /* gone */ } },
    onData: (fn) => { child.stdio[4].setEncoding("utf8"); child.stdio[4].on("data", fn); }, // utf8: a title split across chunks stays whole
    exited,
    kill: (signal = "SIGTERM") => { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* gone */ } },
  };
}

export function createCdp({ write, onEvent }) {
  let next = 0, buffer = "", closed = false;
  const waiting = new Map();
  return {
    send(method, params = {}, sessionId = undefined) {
      if (closed) return Promise.reject(new Error("closed"));
      const id = ++next;
      write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer`)); }, CALL_MS);
        timer.unref?.();
        waiting.set(id, { resolve, reject, timer });
      });
    },
    feed(chunk) {
      buffer += String(chunk);
      if (buffer.length > MAX_MESSAGE) { buffer = ""; return; }
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg = null;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (typeof msg?.id === "number" && waiting.has(msg.id)) {
          const w = waiting.get(msg.id); waiting.delete(msg.id); clearTimeout(w.timer);
          if (msg.error) w.reject(new Error(String(msg.error.message ?? "error"))); else w.resolve(msg.result ?? {});
        } else if (typeof msg?.method === "string") onEvent(msg.method, msg.params ?? {}, msg.sessionId ?? null);
      }
    },
    close() { closed = true; for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error("closed")); } waiting.clear(); },
  };
}
