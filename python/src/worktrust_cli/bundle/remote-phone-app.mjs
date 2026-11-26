/**
 * UPDATE THE PHONE APP (QR) (CLI 0.11.27; owner, 2026-11-26; docs/remote-agents/PHONE-APP-UPDATE.md).
 *
 *   the phone's build  a linked phone names its build and platform in the sealed inventory.get it sends after every link and
 *                      reconnect (protocol phone-app.ts, `app_build`, asked by a probe of its own); the daemon keeps it on the
 *                      phone's record in phones.json as `app: { build, platform, at }` (notePhoneApp). A phone that never sent
 *                      one has no `app`: "not known", never "outdated".
 *   the newest build   WorkTrust's own answer in `POST api/cli/door` (`phone_app: { ios, android }`, each `{ build, link }`),
 *                      kept in ~/.worktrust/remote/phone-app.json (0600) whenever the menu or the session hook asks the door,
 *                      only on a computer where Remote Agent is set up (keepNewest). A link is kept only when it is the App
 *                      Store's, TestFlight's public link or Google Play's own address.
 *   what is said       behindPhones: the confirmed phones whose known build is below the known newest of their platform.
 *                      None: no row and no line. Else the Remote Agent menu's row "Update the phone app (QR)" (no "(QR)"
 *                      without a link), which shows each phone behind, its build and the newest, then the QR of the link
 *                      drawn by terminalQr, or one sentence naming where to update; `remote status` says it in one line.
 * Pure but for the two files it reads and writes through remote-store.mjs; nothing here is sent anywhere.
 */
import { appBuildOf } from "./remote-protocol.mjs";
import { loadIdentity, loadPhones, readJson, savePhones, writeJson } from "./remote-store.mjs";
import { terminalQr } from "./remote-qr.mjs";

const FILE = "phone-app.json";
export const PLATFORMS = ["ios", "android"];
const LINK = /^(?:https:\/\/apps\.apple\.com\/[A-Za-z0-9/_.-]{1,200}|https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{6,16}|https:\/\/play\.google\.com\/store\/apps\/details\?id=[A-Za-z0-9._]{1,150})$/;
/** The phone's own name when it sent one, else its kind (as remote-connections.mjs phoneType). */
const nameOf = (p) => (typeof p?.name === "string" && p.name.trim() ? p.name.trim().slice(0, 64) : "phone");
const buildOf = (v) => (Number.isInteger(v) && v >= 1 && v <= 999_999_999 ? v : null);

/** The door's `phone_app` as this CLI reads it, or null when it is not an object of both platforms' shape. */
export function newestOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const one = (p) => (p && typeof p === "object" && !Array.isArray(p) ? { build: buildOf(p.build), link: typeof p.link === "string" && LINK.test(p.link) ? p.link : null } : { build: null, link: null });
  return { ios: one(raw.ios), android: one(raw.android) };
}

/** Keep WorkTrust's answer here when Remote Agent is set up and it changed. → whether it wrote. Never throws. */
export function keepNewest(raw, { now = Date.now } = {}) {
  const newest = newestOf(raw);
  try {
    if (!newest || !loadIdentity()) return false;
    const kept = newestOf(readJson(FILE));
    if (kept && JSON.stringify(kept) === JSON.stringify(newest)) return false;
    writeJson(FILE, { ...newest, at: new Date(now()).toISOString() });
    return true;
  } catch { return false; }
}

/** The newest builds as last kept here, or null (never asked, unreadable). */
export function loadNewest() { try { return newestOf(readJson(FILE)); } catch { return null; } }

/** The daemon: a confirmed phone's own build, from its inventory.get; written only when it changed. → whether it wrote. */
export function notePhoneApp(deviceId, raw, now = Date.now()) {
  const app = appBuildOf(raw);
  if (!app || !deviceId) return false;
  const phones = loadPhones();
  if (!phones.confirmed.some((p) => p.device_id === deviceId && (p.app?.build !== app.build || p.app?.platform !== app.platform))) return false;
  savePhones({ ...phones, confirmed: phones.confirmed.map((p) => (p.device_id === deviceId ? { ...p, app: { build: app.build, platform: app.platform, at: now } } : p)) });
  return true;
}

/** The confirmed phones whose known build is below the known newest of their platform; unknown on either side is not behind. */
export function behindPhones(phones = loadPhones(), newest = loadNewest()) {
  if (!newest) return [];
  return (phones?.confirmed ?? []).flatMap((p) => {
    const app = appBuildOf(p?.app ? { build: p.app.build, platform: p.app.platform } : null), top = app ? newest[app.platform] : null;
    return app && top?.build !== null && top?.build !== undefined && app.build < top.build ? [{ name: nameOf(p), fingerprint: String(p.fingerprint ?? ""), platform: app.platform, build: app.build, newest: top.build, link: top.link }] : [];
  });
}

/** Where to update in words, when there is no link to draw. */
const WHERE = { ios: "Open TestFlight on the phone and tap Update beside WorkTrust.", android: "Update WorkTrust on the phone where you installed it." };
const one = (b) => `${b.name}${b.fingerprint ? ` (${b.fingerprint})` : ""} runs build ${b.build}; the newest is ${b.newest}.`;

/** The Remote Agent menu's row, or null when no phone is behind. `run` shows updateLines. */
export function updateRow(behind, run) {
  if (!behind?.length) return null;
  const qr = behind.some((b) => b.link);
  return { label: qr ? "Update the phone app (QR)" : "Update the phone app", note: { text: `${behind.length} behind`, tone: "yellow" }, hint: "npx worktrust remote status", info: qr ? "A linked phone runs an older build. Enter shows the QR." : "A linked phone runs an older build. Enter says where.", run };
}

/** What the row shows: each phone behind, then per platform the QR of its link, or one sentence. `color` as terminalQr. */
export function updateLines(behind, { color = false } = {}) {
  const lines = ["", "  Update the phone app"];
  for (const platform of PLATFORMS) {
    const group = behind.filter((b) => b.platform === platform);
    if (group.length === 0) continue;
    for (const b of group) lines.push(`  ${one(b)}`);
    const link = group.find((b) => b.link)?.link ?? null;
    if (link) lines.push("  Scan this with the phone's camera to open the update:", ...terminalQr(link, { color }).split("\n"), `  ${link}`);
    else lines.push(`  ${WHERE[platform]}`);
  }
  return lines;
}

/** `remote status`: one line when a phone is behind, else nothing. */
export function statusLine(behind) {
  if (!behind?.length) return null;
  return `  Phone app: ${behind.map((b) => `${b.name} build ${b.build} of ${b.newest}`).join(", ")}: update it (menu: Remote Agent › ${behind.some((b) => b.link) ? "Update the phone app (QR)" : "Update the phone app"})`;
}
