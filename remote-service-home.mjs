/**
 * THE ONE DOOR TO THE SERVICE MANAGER (CLI remote-service.mjs's runner, split into its own module 2026-11-24 so each file stays
 * under 350 lines). remote-service.mjs never runs a process itself: every launchctl and systemctl it asks goes through
 * systemRunner(home) from here, the only execFileSync of the service code.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * THE SERVICE MANAGER IS ASKED ONLY FOR THIS USER'S OWN HOME (2026-11-24, P1: the owner's iMac lost its service five times).
 * launchctl and systemctl reach the LOGGED-IN user's domain (gui/<uid>, the user manager) whatever HOME says, so a test or an
 * agent that ran the CLI with a synthetic HOME booted out the person's running service while it wrote and removed files only
 * in its temp home (scripts/lib/remote-cli-steer-cases.mjs and -voice-cases.mjs ran `remote disable` in-process). The
 * real runner asks only when `home` is os.userInfo().homedir and WORKTRUST_NO_SERVICE_MANAGER is unset; otherwise it asks
 * nothing and answers false, and only the files under `home` change. A test's own recorder (runner) is never gated, and a
 * test that runs the CLI as a subprocess names its stand-ins' folder (WORKTRUST_SERVICE_STUBS, absolute): then launchctl and
 * systemctl are run from that folder by their full path, never found on PATH, whatever the home.
 * Held by scripts/check-cli-service-home.mjs.
 */
export const NOT_THIS_HOME = "not this user's home";
const canonical = (path) => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };
export function ownHome(home, env = process.env) {
  if (env.WORKTRUST_NO_SERVICE_MANAGER && env.WORKTRUST_NO_SERVICE_MANAGER !== "0") return false;
  try { return typeof home === "string" && home !== "" && canonical(home) === canonical(userInfo().homedir); } catch { return false; }
}
const execute = (file, args) => { try { execFileSync(file, args, { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } };
const stubsDir = (env = process.env) => (env.WORKTRUST_SERVICE_STUBS && isAbsolute(env.WORKTRUST_SERVICE_STUBS) ? env.WORKTRUST_SERVICE_STUBS : null);
export const systemRunner = (home) => Object.assign((file, args) => (stubsDir() ? execute(join(stubsDir(), file), args) : ownHome(home) ? execute(file, args) : false), { gated: true });
export const refusedFor = (runner, home) => (runner.gated === true && !stubsDir() && !ownHome(home) ? NOT_THIS_HOME : null);

/**
 * THE SYSTEM DOMAIN'S ONE FILE OF OURS (CLI 0.11.27, remote-always.mjs): the LaunchDaemon that runs Remote Agent as this user
 * with nobody logged in. Its path here so remote-service.mjs and remote-service-restart.mjs can see it without importing
 * remote-always.mjs (a cycle). `WORKTRUST_SYSTEM_ROOT` (absolute) moves it for the tests; it is only ever READ by the CLI.
 */
export const ALWAYS_LABEL = "io.worktrust.remote.always";
export const systemRoot = (env = process.env) => (env.WORKTRUST_SYSTEM_ROOT && isAbsolute(env.WORKTRUST_SYSTEM_ROOT) ? env.WORKTRUST_SYSTEM_ROOT : "/");
export const daemonPlistPath = (root = systemRoot()) => join(root, "Library", "LaunchDaemons", `${ALWAYS_LABEL}.plist`);
export const alwaysDaemon = (platform = process.platform, root = systemRoot()) => platform === "darwin" && existsSync(daemonPlistPath(root));
export const ALWAYS_UPDATE_LINE = `Remote Agent runs as a system service here (always on): it moves to this release with: sudo launchctl kickstart -k system/${ALWAYS_LABEL}`;
