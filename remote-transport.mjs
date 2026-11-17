/**
 * THE ONE OUTBOUND CONNECTION (2026-11-07). The daemon holds a single WebSocket to the gateway (wss://, or ws:// on this
 * computer's loopback for the dev relay): no inbound port, nothing listening beyond this user's approval socket. It works
 * from anywhere the computer has a network. A same-Wi-Fi direct path is a later optimisation behind this same interface
 * (connect, send, close, onFrame); it is not built.
 *
 * Frames are JSON text, at most 2 MiB. The gateway opens with { frame: "challenge", nonce }; the daemon answers with its
 * binding and an Ed25519 signature by its REMOTE key over the nonce, its device id and the gateway's origin, under the
 * domain "worktrust-remote/v1/relay-auth" (so a signature made for one gateway opens no other). Heartbeat: a ping every
 * 20 seconds; nothing heard for 45 seconds closes and reconnects. Reconnects back off from 1 to 30 seconds with full
 * jitter, or the gateway's own hint when it said `closing` (a restart, a drain). Close code 4001 (revoked) stops the
 * reconnects: the person acts at the keyboard. The production gateway also wants a five-minute assertion from the issuer
 * with every answer to a challenge, and challenges again before it ends (`authorize`); the answer goes on the live socket.
 * Node 22.4 or later has the WebSocket this uses; older Node refuses plainly (`webSocketAvailable`).
 *
 * 4003 (PROTOCOL) HOLDS, IT NEVER STOPS (0.11.17). Until 0.11.16 it stopped the reconnects for good, and on 2026-11-16 the
 * owner's service was closed with it one hour and four seconds after connecting (its fifteenth re-authentication): the
 * process lived on without a connection and said so nowhere. A gateway before release 41 closes with 4003 for a frame it
 * cannot read AND for any failure of its own while it handles one, so the code does not prove this computer wrong. Now: a retry after five
 * minutes, then hourly (a tenth of jitter either way; a connection that stayed ready five minutes starts at five again),
 * logged as `gateway_held`, kept in gateway.json for `remote status` (`keepGatewayState`, `gatewayLine`).
 *
 * EVERY FRAME GOES THROUGH THE PACER (2026-11-16, remote-pace.mjs): `send` queues it in order under the gateway limits
 * (40 frames and 1 MiB a second), the answer to a challenge and the heartbeat go at once and are counted, the gateway
 * `rate_limited` slows it, a closed socket empties it. The one write to the socket is the pacer callback below
 * (check-remote-cli rule N; `pacer` is the test seam for another pacer over that same write). `room()` is what a
 * catch-up awaits between its batches.
 */
import * as P from "./remote-protocol.mjs";
import { createPacer } from "./remote-pace.mjs";
import { readJson, removeFile, writeJson } from "./remote-store.mjs";

export const MAX_FRAME = 2 * 1024 * 1024;
const PING_MS = 20_000, SILENCE_MS = 45_000, BASE_MS = 1000, CAP_MS = 30_000;
const HOLD_FIRST_MS = 5 * 60_000, HOLD_NEXT_MS = 60 * 60_000;
export const STOP_CODES = P.GATEWAY_STOP_CODES, HOLD_CODES = P.GATEWAY_HOLD_CODES;
/** How long a held transport waits: five minutes the first time, an hour after that, a tenth of jitter either way. */
export const holdMs = (holds, random = Math.random) => Math.floor((holds === 0 ? HOLD_FIRST_MS : HOLD_NEXT_MS) * (0.9 + 0.2 * random()));
export const webSocketAvailable = () => typeof globalThis.WebSocket === "function";
export const backoffMs = (attempt, random = Math.random) => Math.floor(random() * Math.min(CAP_MS, BASE_MS * 2 ** Math.min(attempt, 10)));

export const relayAuthBytes = (deviceId, nonce, origin) => P.relayAuthBytes({ device_id: deviceId, nonce, origin });
export function authFrame({ deviceId, binding, signingSecret, nonce, origin, assertion = null }) {
  return { frame: "auth", device_id: deviceId, binding, nonce, signature: P.toBase64Url(P.ed25519Sign(relayAuthBytes(deviceId, nonce, origin), signingSecret)), ...(assertion ? { assertion } : {}) };
}

export function connectGateway({ url, identity, signingSecret, onFrame, onState = () => {}, log = () => {}, authorize = async () => null, WebSocketImpl = globalThis.WebSocket, pacer = null, holdWait = holdMs, now = Date.now }) {
  const origin = new URL(url).origin.replace(/^http/, "ws");
  let socket = null, attempt = 0, stopped = false, ready = false, lastHeard = 0, ping = null, retry = null, hint = null, holds = 0, heldSince = null, readyAt = null;
  const pace = (pacer ?? createPacer)({ write: (text) => { if (socket?.readyState === 1) socket.send(text); }, log });
  /** `replayed`: a journal event sealed again for one phone (the depth rule may drop it; never a live event). */
  const send = (frame, { replayed = false } = {}) => {
    if (!ready || socket?.readyState !== 1) return false;
    const text = JSON.stringify(frame);
    if (text.length > MAX_FRAME) { log("frame_too_large", { frame: frame.frame }); return false; }
    return pace.push(text, frame.frame !== "event" ? "control" : frame.envelope?.lane === "transient" && !replayed ? "transient" : replayed ? "replay" : "live"); // a page of history is transient to the relay and a replay to the pacer: never dropped for being two seconds old
  };
  const schedule = () => {
    if (stopped) return;
    const wait = hint !== null ? hint + backoffMs(0) : backoffMs(attempt++);
    hint = null;
    onState("waiting", { wait });
    retry = setTimeout(open, wait);
  };
  /** Closed with a code that holds (4003): the long wait, said and logged; never a stop. */
  const hold = (code) => {
    if (stopped) return;
    if (readyAt !== null && now() - readyAt >= HOLD_FIRST_MS) holds = 0; // it worked for a while: the short wait again
    readyAt = null;
    heldSince ??= now();
    const wait = holdWait(holds++);
    log("gateway_held", { code, wait_ms: wait, since: heldSince });
    onState("held", { code, wait, since: heldSince, retry_at: now() + wait });
    retry = setTimeout(open, wait);
  };
  function open() {
    if (stopped) return;
    ready = false;
    try { socket = new WebSocketImpl(url); } catch { schedule(); return; }
    socket.onopen = () => { lastHeard = Date.now(); onState("open"); };
    socket.onmessage = (event) => {
      lastHeard = Date.now();
      const text = typeof event.data === "string" ? event.data : "";
      if (text.length > MAX_FRAME) { socket.close(4003, "too large"); return; }
      let frame = null;
      try { frame = JSON.parse(text); } catch { frame = null; }
      if (!frame || typeof frame.frame !== "string") return;
      if (frame.frame === "challenge" && typeof frame.nonce === "string") {
        const asked = socket;
        authorize().catch(() => null).then((assertion) => {
          if (asked !== socket || asked.readyState !== 1) return;
          pace.urgent(JSON.stringify(authFrame({ deviceId: identity.device_id, binding: identity.binding, signingSecret, nonce: frame.nonce, origin, assertion })));
        });
        return;
      }
      if (frame.frame === "closing" && Number.isSafeInteger(frame.retry_after_ms)) { hint = Math.min(frame.retry_after_ms, 3_600_000); return; }
      if (frame.frame === "ready") { ready = true; attempt = 0; heldSince = null; readyAt = now(); onState("ready"); }
      if (frame.frame === "pong") return;
      if (frame.frame === "error" && frame.reason === "rate_limited") pace.slow();
      onFrame(frame);
    };
    socket.onclose = (event) => {
      ready = false;
      pace.clear();
      clearInterval(ping);
      onState("closed", { code: event?.code ?? null });
      if (STOP_CODES.has(event?.code)) { stopped = true; onState("stopped", { code: event.code, since: now() }); return; }
      if (HOLD_CODES.has(event?.code)) { hold(event.code); return; }
      schedule();
    };
    socket.onerror = () => {};
    clearInterval(ping);
    ping = setInterval(() => {
      if (Date.now() - lastHeard > SILENCE_MS) { try { socket.close(); } catch { /* closed */ } return; }
      if (socket.readyState === 1) pace.urgent(JSON.stringify({ frame: "ping" }));
    }, PING_MS);
    ping.unref?.();
  }
  open();
  return { send, room: () => pace.room(), ready: () => ready, close() { stopped = true; pace.clear(); clearTimeout(retry); clearInterval(ping); try { socket?.close(1000, "bye"); } catch { /* closed */ } } };
}

/**
 * WHAT `remote status` SAYS ABOUT THE CONNECTION (0.11.17): the daemon keeps a hold or a stop in gateway.json (0600, with
 * its pid) and removes it when the gateway says ready; the word of a daemon that no longer lives is not repeated.
 */
export const GATEWAY_FILE = "gateway.json";
export function keepGatewayState(state, info = {}) {
  try {
    if (state === "ready") removeFile(GATEWAY_FILE);
    else if (state === "held" || state === "stopped") writeJson(GATEWAY_FILE, { v: 1, state, code: info.code ?? null, since: info.since ?? Date.now(), retry_at: info.retry_at ?? null, pid: process.pid });
  } catch { /* unsaid in the status; the log has it */ }
}
const lives = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function keptGatewayState({ alive = lives } = {}) {
  try {
    const k = readJson(GATEWAY_FILE);
    if (!k || (k.state !== "held" && k.state !== "stopped") || !Number.isSafeInteger(k.since) || !Number.isSafeInteger(k.pid) || k.pid <= 1 || !alive(k.pid)) return null;
    return { state: k.state, code: Number.isSafeInteger(k.code) ? k.code : null, since: k.since, retry_at: Number.isSafeInteger(k.retry_at) ? k.retry_at : null };
  } catch { return null; }
}
const two = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(ms)}`; };
/** The one line, or null when the connection is not stopped by the gateway. */
export function gatewayLine(kept) {
  if (!kept) return null;
  const said = `  Connection: stopped by the gateway since ${day(kept.since)} (close code ${kept.code ?? "unknown"}, ${kept.code === P.GATEWAY_CLOSE.REVOKED ? "revoked" : "protocol"}).`;
  if (kept.state === "stopped") return `${said} It does not try again: link this computer again with \`npx worktrust remote app\`.`;
  return `${said} The service tries again by itself${kept.retry_at ? ` around ${clock(kept.retry_at)}` : ""}.`;
}
