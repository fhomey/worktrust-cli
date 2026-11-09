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
 * jitter, or the gateway's own hint when it said `closing` (a restart, a drain). Close codes 4001 (revoked) and 4003
 * (protocol) stop the reconnects: the person acts at the keyboard. The production gateway also wants a five-minute
 * assertion from the issuer with every answer to a challenge, and challenges again before it ends (`authorize`).
 * Node 22.4 or later has the WebSocket this uses; older Node refuses plainly (`webSocketAvailable`).
 */
import * as P from "./remote-protocol.mjs";

export const MAX_FRAME = 2 * 1024 * 1024;
const PING_MS = 20_000, SILENCE_MS = 45_000, BASE_MS = 1000, CAP_MS = 30_000;
export const STOP_CODES = P.GATEWAY_STOP_CODES;
export const webSocketAvailable = () => typeof globalThis.WebSocket === "function";
export const backoffMs = (attempt, random = Math.random) => Math.floor(random() * Math.min(CAP_MS, BASE_MS * 2 ** Math.min(attempt, 10)));

export const relayAuthBytes = (deviceId, nonce, origin) => P.relayAuthBytes({ device_id: deviceId, nonce, origin });
export function authFrame({ deviceId, binding, signingSecret, nonce, origin, assertion = null }) {
  return { frame: "auth", device_id: deviceId, binding, nonce, signature: P.toBase64Url(P.ed25519Sign(relayAuthBytes(deviceId, nonce, origin), signingSecret)), ...(assertion ? { assertion } : {}) };
}

export function connectGateway({ url, identity, signingSecret, onFrame, onState = () => {}, log = () => {}, authorize = async () => null, WebSocketImpl = globalThis.WebSocket }) {
  const origin = new URL(url).origin.replace(/^http/, "ws");
  let socket = null, attempt = 0, stopped = false, ready = false, lastHeard = 0, ping = null, retry = null, hint = null;
  const send = (frame) => {
    if (!ready || socket?.readyState !== 1) return false;
    const text = JSON.stringify(frame);
    if (text.length > MAX_FRAME) { log("frame_too_large", { frame: frame.frame }); return false; }
    socket.send(text);
    return true;
  };
  const schedule = () => {
    if (stopped) return;
    const wait = hint !== null ? hint + backoffMs(0) : backoffMs(attempt++);
    hint = null;
    onState("waiting", { wait });
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
          asked.send(JSON.stringify(authFrame({ deviceId: identity.device_id, binding: identity.binding, signingSecret, nonce: frame.nonce, origin, assertion })));
        });
        return;
      }
      if (frame.frame === "closing" && Number.isSafeInteger(frame.retry_after_ms)) { hint = Math.min(frame.retry_after_ms, 3_600_000); return; }
      if (frame.frame === "ready") { ready = true; attempt = 0; onState("ready"); }
      if (frame.frame === "pong") return;
      onFrame(frame);
    };
    socket.onclose = (event) => {
      ready = false;
      clearInterval(ping);
      onState("closed", { code: event?.code ?? null });
      if (STOP_CODES.has(event?.code)) { stopped = true; onState("stopped", { code: event.code }); return; }
      schedule();
    };
    socket.onerror = () => {};
    clearInterval(ping);
    ping = setInterval(() => {
      if (Date.now() - lastHeard > SILENCE_MS) { try { socket.close(); } catch { /* closed */ } return; }
      if (socket.readyState === 1) socket.send(JSON.stringify({ frame: "ping" }));
    }, PING_MS);
    ping.unref?.();
  }
  open();
  return { send, ready: () => ready, close() { stopped = true; clearTimeout(retry); clearInterval(ping); try { socket?.close(1000, "bye"); } catch { /* closed */ } } };
}
