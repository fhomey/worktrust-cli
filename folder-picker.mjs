/**
 * FOLDERS WITHOUT TYPING (CLI 0.11.7, owner 2026-11-12), for the menu at this keyboard only: the folders a person's
 * projects usually live in, with how many git projects each holds; the system's own folder picker; a new folder for
 * projects; and which chosen folders macOS guards with its privacy prompt. Nothing here grants anything: every folder
 * chosen still goes through the root and project rules (remote-settings.mjs applySettingsChange, remote-policy.mjs).
 *
 * The picker runs a FIXED program with fixed arguments, never a shell line and never a word from a phone: macOS
 * `osascript -e 'POSIX path of (choose folder …)'`, Windows PowerShell's FolderBrowserDialog, Linux `zenity` when it is
 * there. Without one (a Linux with no zenity, an SSH session) the person types the path, the only typed fallback.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, sep } from "node:path";

export const SUGGESTED = Object.freeze(["Desktop", "Documents", "Developer", "Projects", "code", "src"]);
const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** How many git projects lie directly inside `dir` (a folder holding .git); hidden folders are not counted. */
export function gitProjectsIn(dir) {
  let n = 0;
  try {
    for (const d of readdirSync(dir, { withFileTypes: true }).slice(0, 2000)) {
      if (d.name.startsWith(".") || !(d.isDirectory() || d.isSymbolicLink())) continue;
      try { lstatSync(join(dir, d.name, ".git")); n += 1; } catch { /* not a git project */ }
    }
  } catch { return 0; }
  return n;
}

/** The suggested folders that exist here, each with its git projects counted: [{ name, path, projects }]. */
export function suggestedFolders(home = homedir()) {
  return SUGGESTED.map((name) => ({ name, path: join(home, name) })).filter((f) => isDir(f.path)).map((f) => ({ ...f, projects: gitProjectsIn(f.path) }));
}

const onPath = (bin, path = process.env.PATH ?? "") => path.split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

const PS_PICKER = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a folder for WorkTrust Remote Agent'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }";

/** The system's folder picker as { file, args }, or null when this system has none (then the path is typed). */
export function pickerCommand(platform = process.platform, has = onPath, env = process.env) {
  if (platform === "darwin") return { file: "/usr/bin/osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Choose a folder for WorkTrust Remote Agent")'] };
  if (platform === "win32") return { file: join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-STA", "-Command", PS_PICKER] };
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY) && has("zenity")) return { file: "zenity", args: ["--file-selection", "--directory", "--title=Choose a folder for WorkTrust Remote Agent"] };
  return null;
}

/** Open the picker and wait: the chosen folder, or null (cancelled, or no picker). */
export function pickFolder(command = pickerCommand()) {
  if (!command) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command.file, command.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: false });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => { const path = out.trim().replace(/[\\/]$/, ""); resolve(code === 0 && path ? path : null); });
  });
}

/** A new folder's name: one segment, no leading dot. */
export const FOLDER_NAME = /^[A-Za-z0-9_-][A-Za-z0-9 ._-]{0,99}$/;

/** Make ~/<name> for new projects (nothing above or beside it); → { ok, path } or { ok: false, reason }. Existing is fine. */
export function makeProjectsFolder(name, home = homedir()) {
  if (!FOLDER_NAME.test(name ?? "")) return { ok: false, reason: "a folder name: letters, digits, space, . _ -, not starting with a dot" };
  const path = join(home, name);
  if (isDir(path)) return { ok: true, path, made: false };
  try { mkdirSync(path, { mode: 0o755 }); } catch { return { ok: false, reason: "that folder could not be made" }; }
  return { ok: true, path, made: true };
}

const realOr = (path) => { try { return realpathSync(path); } catch { return path; } };
const under = (base, path) => { const rel = relative(base, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)); };

/**
 * The folder macOS guards with its privacy prompt that `path` lies in (Desktop, Documents, Downloads, iCloud Drive), or
 * null: elsewhere, or not macOS. A program launchd starts asks for it on its first read, mid-session, unless it was asked once.
 */
export function protectedFolder(path, home = homedir(), platform = process.platform) {
  if (platform !== "darwin") return null;
  const real = realOr(path), h = realOr(home);
  for (const [name, dir] of [["Desktop", "Desktop"], ["Documents", "Documents"], ["Downloads", "Downloads"], ["iCloud Drive", join("Library", "Mobile Documents")]]) if (under(join(h, dir), real)) return name;
  return null;
}
