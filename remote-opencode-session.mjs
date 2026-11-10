/**
 * AN OPENCODE SESSION ON THIS COMPUTER (owner, 2026-11-09), the glue between remote-sessions.mjs and the adapter
 * (remote-adapter-opencode.mjs): the same order as Claude Code's start, held by check-remote-cli rule D. OpenCode creates a
 * session under an id it is given, so the id was minted at the start and the steered ledger names it BEFORE the first run;
 * each line goes through the protocol mapping (remote-opencode-events.mjs) into the session's one turn handling, and every
 * call OpenCode refused reaches the computer's approvals (policy first, then the phone).
 *
 *   spawnOpenCode(ctx, s, { mark, onExit, afterMapped, everyMs })
 */
import * as P from "./remote-protocol.mjs";
import { startOpenCode } from "./remote-adapter-opencode.mjs";
import { mapOpenCodeLine } from "./remote-opencode-events.mjs";

export function spawnOpenCode(ctx, s, { mark, onExit, afterMapped, everyMs }) {
  s.token = ctx.approvals.register(s); // so its open approvals are denied when it ends
  mark(s); // the ledger names the session before OpenCode writes a line
  s.run = startOpenCode({ file: ctx.inventory().files.opencode, cwd: s.projectPath, env: ctx.agentEnv(), model: s.model, mode: s.mode, sessionRef: s.agent_ref,
    onMessage: (line) => { const mapped = mapOpenCodeLine(s.state, line, (prefix = "stp") => P.mintId(prefix, ctx.random), ctx.now(), s.model); s.state = mapped.state; afterMapped(s, mapped); },
    onExit: (how) => onExit(s, how),
    approve: async (tool, input) => (await ctx.approvals.request(s, tool, input))?.behavior === "allow" });
  ctx.journal.recordSession({ session_id: s.session_id, pid: null, agent_session_ref: s.agent_ref }); // one process per run: no pid for a later daemon to end
  s.ledgerTimer = setInterval(() => { if (s.turnOpen) mark(s); }, everyMs);
  s.ledgerTimer.unref?.();
}
