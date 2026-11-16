/**
 * THE COMPUTER'S HEALTH, MEASURED HERE (owner, 2026-11-15: "the computer sometimes crashes from RAM/GPU load").
 * The Remote daemon reads a few numbers of this machine every 15 seconds, without a model (no tokens) and without sudo,
 * keeps the newest in ~/.worktrust/remote/health.json (0600, this computer only) for `remote status` and the menu, and
 * seals it for the paired phones and browsers on the transient lane (remote-protocol health.ts): the server never sees
 * or stores a sample. While red, the daemon starts no new session (remote-daemon.mjs); running sessions continue.
 *
 * What is run, each through execFile with FIXED arguments, a fixed PATH, a timeout and an output cap; nothing from a
 * phone, a file or the environment reaches an argument:
 *   macOS   /usr/sbin/sysctl kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage hw.memsize
 *             (the kernel's own pressure level 1/2/4 and the share of memory available, which `memory_pressure` prints
 *             too; sysctl reads them in one call without sudo, where `memory_pressure` runs a slower test of its own)
 *           /usr/sbin/ioreg -r -d 1 -cIOAccelerator    ("Device Utilization %" of the Apple GPU; null when absent)
 *           /bin/ps -axo rss=,comm=                    (resident memory and the program, never `args` or `command`)
 *   Linux   /proc/meminfo, /proc/pressure/memory (when the kernel has PSI), /proc/loadavg, and ps -eo rss=,comm=
 *   Windows free memory (os.freemem) and the load from the CPU times between two samples; nothing is run
 * A program is named by its BASENAME only (a path is cut to its last part), summed over its processes; a name the
 * protocol would refuse (an argument, a setting, a URL) is left out. A read that failed is null, never 0.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import * as P from "./remote-protocol.mjs";
import { readJson, writeJson } from "./remote-store.mjs";

const TIMEOUT_MS = 4000, MAX_BUFFER = 4 * 1024 * 1024;
const SAFE_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
/** Every command this module may run, whole. check-remote-cli rule H reads this list: no `args`, no `command`. */
export const HEALTH_COMMANDS = Object.freeze({
  sysctl: Object.freeze(["/usr/sbin/sysctl", Object.freeze(["kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "vm.swapusage", "hw.memsize"])]),
  ioreg: Object.freeze(["/usr/sbin/ioreg", Object.freeze(["-r", "-d", "1", "-cIOAccelerator"])]),
  psMac: Object.freeze(["/bin/ps", Object.freeze(["-axo", "rss=,comm="])]),
  psLinux: Object.freeze(["ps", Object.freeze(["-eo", "rss=,comm="])]),
});
export const HEALTH_REFUSAL = "This computer is under heavy memory load";
const MB = 1024 * 1024;

/** One fixed command; its output, or null (failed, timed out, too long). A command that printed and exited non-zero still counts. */
export function runFixed(key) {
  const [file, args] = HEALTH_COMMANDS[key];
  return new Promise((done) => {
    execFile(file, [...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, env: SAFE_ENV, encoding: "utf8" }, (error, stdout) => {
      done(error && (error.killed || typeof error.code !== "number" || !stdout) ? null : String(stdout ?? ""));
    });
  });
}

const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/** `sysctl` (names shown) on macOS: by name, so one missing key leaves the others readable. */
export function parseMacSysctl(text) {
  const out = { pressure: null, memory_total_mb: null, memory_free_mb: null, swap_used_mb: null };
  if (typeof text !== "string") return out;
  const value = (name) => text.match(new RegExp(`^${name.replace(/\./g, "\\.")}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
  out.pressure = { 1: "normal", 2: "warn", 4: "critical" }[Number(value("kern.memorystatus_vm_pressure_level"))] ?? null;
  const bytes = Number(value("hw.memsize"));
  if (Number.isSafeInteger(bytes) && bytes > 0) out.memory_total_mb = int(bytes / MB);
  const level = Number(value("kern.memorystatus_level"));
  if (out.memory_total_mb !== null && value("kern.memorystatus_level") !== null && level >= 0 && level <= 100) out.memory_free_mb = int((out.memory_total_mb * level) / 100);
  out.swap_used_mb = parseSwapUsage(value("vm.swapusage"));
  return out;
}

/** "total = 10240.00M  used = 8911.38M  free = 1328.62M  (encrypted)" → 8911. */
export function parseSwapUsage(text) {
  const m = typeof text === "string" ? text.match(/used\s*=\s*([\d.]+)([KMG])/) : null;
  if (!m) return null;
  return int(Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]]);
}

/** The highest "Device Utilization %" of any accelerator, 0 to 100; null when none reports one. */
export function parseIoreg(text) {
  if (typeof text !== "string") return null;
  const all = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
  return all.length ? Math.max(...all) : null;
}

/** A program's name for the sample: the basename, without control characters, at most 64; null when the protocol refuses it. */
export function programName(comm) {
  const base = String(comm).trim().split(/[/\\]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, P.MAX_PROCESS_NAME);
  return base && P.processNameRefusal(base) === null ? base : null;
}

/** `ps -o rss=,comm=`: the three programs holding the most memory, summed over their processes, largest first. */
export function parsePs(text) {
  if (typeof text !== "string") return [];
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const name = programName(m[2]);
    if (name) sums.set(name, (sums.get(name) ?? 0) + Number(m[1]));
  }
  return [...sums].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([name, kb]) => ({ name, memory_mb: Math.round(kb / 1024) }))
    .filter((p, n, all) => n === 0 || p.memory_mb <= all[n - 1].memory_mb);
}

/** /proc/meminfo: total, available, swap used (MB). */
export function parseMeminfo(text) {
  const kb = (key) => { const m = typeof text === "string" ? text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m")) : null; return m ? Number(m[1]) : null; };
  const total = kb("MemTotal"), available = kb("MemAvailable"), swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
  return { memory_total_mb: total === null ? null : int(total / 1024), memory_free_mb: available === null ? null : int(available / 1024), swap_used_mb: swapTotal === null || swapFree === null ? null : int((swapTotal - swapFree) / 1024) };
}

/** /proc/pressure/memory (PSI): critical when tasks were fully stalled 10 % of the last 10 s, warn when some were; else normal. */
export function parsePsi(text) {
  const avg = (kind) => { const m = typeof text === "string" ? text.match(new RegExp(`^${kind} avg10=([\\d.]+)`, "m")) : null; return m ? Number(m[1]) : null; };
  const some = avg("some"), full = avg("full");
  if (some === null && full === null) return null;
  if ((full ?? 0) >= 10) return "critical";
  return (some ?? 0) >= 10 ? "warn" : "normal";
}

export const parseLoadavg = (text) => { const n = typeof text === "string" ? Number(text.trim().split(/\s+/)[0]) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };

const cpuTimes = (cpus) => cpus.reduce((t, c) => { const v = c.times; const all = v.user + v.nice + v.sys + v.idle + v.irq; return { busy: t.busy + all - v.idle, all: t.all + all }; }, { busy: 0, all: 0 });

/** Swap used now minus the newest reading at least SWAP_GROWTH_WINDOW_MS old; null until there is one. */
export function swapGrowth(history, now, used) {
  if (used === null) return null;
  const old = history.filter((h) => h.at <= now - P.SWAP_GROWTH_WINDOW_MS && h.used !== null).at(-1);
  return old ? used - old.used : null;
}

/**
 * ONE SAMPLE. `o`: { platform, run(key) → text | null, read(path) → text | null, os: { totalmem, freemem, loadavg, cpus },
 * now, swapHistory[] (kept by the caller), lastCpu (kept by the caller) }. Returns the protocol's body and the CPU times for the next.
 */
export async function sampleHealth(o) {
  const now = o.now();
  let reading = { pressure: null, memory_total_mb: null, memory_free_mb: null, swap_used_mb: null }, load = null, gpu = null, top = [];
  const cores = o.os.cpus()?.length || null;
  if (o.platform === "darwin") {
    const [sys, io, ps] = await Promise.all([o.run("sysctl"), o.run("ioreg"), o.run("psMac")]);
    reading = parseMacSysctl(sys);
    gpu = parseIoreg(io);
    top = parsePs(ps);
    const avg = o.os.loadavg()[0];
    load = Number.isFinite(avg) ? avg : null;
  } else if (o.platform === "linux") {
    const mem = parseMeminfo(o.read("/proc/meminfo"));
    reading = { pressure: parsePsi(o.read("/proc/pressure/memory")), ...mem };
    load = parseLoadavg(o.read("/proc/loadavg"));
    top = parsePs(await o.run("psLinux"));
  } else {
    const total = o.os.totalmem(), free = o.os.freemem();
    reading = { ...reading, memory_total_mb: total > 0 ? int(total / MB) : null, memory_free_mb: total > 0 && free >= 0 ? int(free / MB) : null };
  }
  // The load where no load average exists (Windows): the share of CPU time busy since the last sample, times the cores.
  const cpu = cpuTimes(o.os.cpus() ?? []);
  if (o.platform === "win32" && o.lastCpu && cpu.all > o.lastCpu.all && cores) load = ((cpu.busy - o.lastCpu.busy) / (cpu.all - o.lastCpu.all)) * cores;
  if (reading.memory_free_mb !== null && reading.memory_total_mb !== null) reading.memory_free_mb = Math.min(reading.memory_free_mb, reading.memory_total_mb);
  const swap_growth_mb = swapGrowth(o.swapHistory ?? [], now, reading.swap_used_mb);
  const judged = P.healthLevel({ ...reading, swap_growth_mb });
  const body = { sampled_at: now, level: judged.level, reasons: [...judged.reasons], ...reading, swap_growth_mb,
    load_centi: load === null ? null : Math.min(100_000_000, int(load * 100)), cores, gpu_busy: gpu, top, refusing: judged.level === "red" };
  return { body, cpu };
}

/**
 * The daemon's sampler: every HEALTH_SAMPLE_MS, one sample, never two at once. `onSample(body)` sends and keeps it.
 * Readers are parameters so tests stub them with recorded output.
 */
export function createHealthMonitor({ onSample, platform = process.platform, run = runFixed, read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }, osInfo = os, now = Date.now, log = () => {}, intervalMs = P.HEALTH_SAMPLE_MS } = {}) {
  let swapHistory = [], lastCpu = null, latest = null, busy = false, timer = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { body, cpu } = await sampleHealth({ platform, run, read, os: osInfo, now, swapHistory, lastCpu });
      lastCpu = cpu;
      swapHistory = [...swapHistory.filter((h) => h.at > body.sampled_at - P.SWAP_GROWTH_WINDOW_MS * 2), { at: body.sampled_at, used: body.swap_used_mb }];
      const checked = P.validateEventBody("device.health", body);
      if (!checked.ok) { log("health_refused", { code: checked.code }); return; }
      latest = body;
      onSample(body);
    } catch (e) { log("health_failed", { name: e?.name ?? "Error" }); } finally { busy = false; }
  };
  return {
    start() { void tick(); timer = setInterval(tick, intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    tick,
    latest: () => latest,
  };
}

/** The newest sample, kept on this computer only (0600) for `remote status` and the menu; a minute old at most counts. */
export const HEALTH_FILE = "health.json";
export const HEALTH_FRESH_MS = 60_000;
export function keepHealth(body) { try { writeJson(HEALTH_FILE, body); } catch { /* the next sample tries again */ } }
export function keptHealth(now = Date.now()) {
  try { const b = readJson(HEALTH_FILE); return b && P.validateEventBody("device.health", b).ok && now - b.sampled_at <= HEALTH_FRESH_MS ? b : null; } catch { return null; }
}

/**
 * RECORDED OUTPUT FOR TESTS AGAINST THE DEV RELAY (remote-run.mjs honours WORKTRUST_REMOTE_HEALTH_FIXTURE only for a
 * loopback gateway): { platform, outputs: { sysctl, ioreg, psMac, psLinux }, files: { "/proc/meminfo": … } }, read again
 * at every sample, so an end-to-end test never depends on (or is refused by) the memory of the computer it runs on.
 */
export function fixtureReaders(path) {
  const load = () => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
  return { platform: load().platform ?? "darwin", run: async (key) => load().outputs?.[key] ?? null, read: (p) => load().files?.[p] ?? null };
}

const gb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
/** The one line the menu and `remote status` show; red starts with ✗ (the painter makes it red), yellow with !. */
export function healthLine(body) {
  if (!body) return "  Health: not known (the remote service has not measured yet)";
  const parts = [];
  if (body.memory_total_mb && body.memory_free_mb !== null) parts.push(`memory ${Math.round((1 - body.memory_free_mb / body.memory_total_mb) * 100)} % in use`);
  if (body.pressure) parts.push(`pressure ${body.pressure}`);
  if (body.swap_used_mb !== null) parts.push(`swap ${gb(body.swap_used_mb)}${body.swap_growth_mb !== null && body.swap_growth_mb > 0 ? ` (+${gb(body.swap_growth_mb)} in 2 min)` : ""}`);
  if (body.load_centi !== null && body.cores) parts.push(`CPU load ${(body.load_centi / 100 / body.cores).toFixed(2)} per core`);
  if (body.gpu_busy !== null) parts.push(`GPU ${body.gpu_busy} %`);
  if (body.top[0]) parts.push(`largest ${body.top[0].name} ${gb(body.top[0].memory_mb)}`);
  const facts = parts.length ? parts.join(", ") : "nothing could be read";
  if (body.level === "red") return `  ✗ Health: red. ${HEALTH_REFUSAL}: ${facts}. New sessions wait; running ones continue.`;
  if (body.level === "yellow") return `  ! Health: yellow: ${facts}`;
  return `  Health: ${body.level === "green" ? "green" : "not known"}: ${facts}`;
}
