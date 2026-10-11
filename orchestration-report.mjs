/** Explicit local metadata file only. No home discovery, credentials, uploads or clocks invented here. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { parseOrchestrationJsonl, summarizeOrchestration } from "./orchestration-evidence.mjs";

export function reportFile(args) {
  if (args.length !== 3 || args[0] !== "report" || args[1] !== "--file" || !args[2]) {
    process.stderr.write("Usage: worktrust orchestration report --file recording.jsonl\n");
    process.exitCode = 1;
    return;
  }
  let fd;
  try {
    const before = lstatSync(args[2]);
    if (!before.isFile() || before.isSymbolicLink()) throw Error("invalid");
    fd = openSync(args[2], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 262144 || info.dev !== before.dev || info.ino !== before.ino) throw Error("invalid");
    const bytes = Buffer.alloc(262145);
    let length = 0, received;
    do { received = readSync(fd, bytes, length, bytes.length - length, null); length += received; } while (received && length < bytes.length);
    if (length > 262144) throw Error("invalid");
    const recording = parseOrchestrationJsonl(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    process.stdout.write(JSON.stringify(summarizeOrchestration(recording), null, 2) + "\n");
  } catch {
    process.stderr.write("Orchestration recording refused: use a regular, bounded file with valid metadata.\n");
    process.exitCode = 1;
  } finally { if (fd !== undefined) closeSync(fd); }
}
