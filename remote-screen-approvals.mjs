/**
 * A TERMINAL DIALOG, ANSWERED FROM A PHONE BY ITS SCREEN'S HASH (release 19, 2026-11-09; PRIOR-ART-ANALYSIS.md 2.3).
 *
 * When a terminal session's screen shows a permission dialog (remote-screen-states.mjs, claudeCodeDialog), the computer:
 *   1. classifies what the dialog names (a command, a file) with its own policy (remote-policy.mjs). A dialog it cannot
 *      read, or of a class a phone may not decide, is never asked: it waits for the person at the computer;
 *   2. asks through remote-approvals.mjs (the only sender of agent.approval_required), the action's input being the
 *      dialog's region exactly as drawn, so the hash the phone signs covers the very screen text it showed;
 *   3. when a PHONE decided (never on a timeout, a lost phone or a session that ended), reads the screen again and presses
 *      the answer key only if the dialog's region still hashes the same, the key coming from the agent's allow-list
 *      (SCREEN_ANSWERS) and only where the dialog offers it (approve: the cursor on "1. Yes"; deny: an option with Esc).
 *      A changed dialog presses nothing and is asked again.
 * One question per dialog: the same region is not asked twice; a dialog answered at the desk withdraws its question.
 * Offered only where the adapter reports `approvals: "screen"`, which needs fixtures recorded from the real agent.
 */
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { classifyAction, phoneMayDecide } from "./remote-policy.mjs";
import { SCREEN_ANSWERS, screenDialog } from "./remote-screen-states.mjs";

const MAX_SHOWN = 16_000;
/** The dialog's region, hashed as drawn (lines joined with \n). */
export const regionHash = (region) => createHash("sha256").update(region.join("\n")).digest("base64url");

/** The dialog as an approval action: classified from what it names, shown (and hashed) as the screen draws it. */
export function screenAction(agent, dialog, projectPath) {
  const args = dialog.tool === "Bash" ? { command: dialog.target ?? "" }
    : dialog.tool && dialog.target ? { file_path: isAbsolute(dialog.target) ? dialog.target : join(projectPath, dialog.target) } : {};
  const { action, reason } = classifyAction(agent, dialog.tool ?? "ScreenDialog", args, projectPath);
  const shown = dialog.region.join("\n");
  if (shown.length > MAX_SHOWN) return { action: { ...action, class: "other", input: `${shown.slice(0, MAX_SHOWN - 40)} [cut: too long to show exactly]` }, reason: "the dialog is too long to show exactly" };
  return { action: { ...action, input: shown }, reason };
}

// ctx: { approvals, emit, tmux, report() (the terminal report), agent }
export function createScreenApprovals(ctx) {
  const note = (s, text) => ctx.emit(s.session_id, "agent.output_delta", { stream: "tool", offset: 0, text }, s.command_id);

  /** After a phone's decision: the screen again, the same hash, then the agent's own answer key, or nothing. */
  async function answer(s, ask) {
    if (ask.decision === null || s.closed) return; // no phone decided: nothing is pressed
    ask.answering = true;
    const cap = await ctx.tmux.capture(s.tmux, 100);
    const now = cap ? screenDialog(ctx.agent, cap.lines) : null;
    if (!now || regionHash(now.region) !== ask.hash) {
      s.screenAsked = null; // the dialog now on the screen is asked again
      note(s, "The dialog on the screen changed before your answer reached it: nothing was pressed.");
      return;
    }
    const keys = ask.decision === "approve" ? (now.approve ? SCREEN_ANSWERS[ctx.agent].approve : null) : now.dismiss ? SCREEN_ANSWERS[ctx.agent].deny : null;
    if (!keys) { note(s, "This dialog does not offer that answer here: nothing was pressed. Answer it at the computer."); return; }
    for (const key of keys) await ctx.tmux.sendKey(s.tmux, key);
  }

  return {
    answer,
    /** One look at the screen (remote-terminal-sessions.mjs): a new dialog is asked once; a dialog gone withdraws its question. */
    consider(s, lines) {
      const dialog = ctx.report()?.capabilities.approvals === "screen" && Object.hasOwn(SCREEN_ANSWERS, ctx.agent) ? screenDialog(ctx.agent, lines) : null;
      if (!dialog) {
        if (s.screenAsk && !s.screenAsk.answering) ctx.approvals.withdraw(s.session_id, "the dialog was answered at the computer");
        s.screenAsked = null;
        return;
      }
      const hash = regionHash(dialog.region);
      if (s.screenAsk?.hash === hash || s.screenAsked === hash) return;
      if (s.screenAsk && !s.screenAsk.answering) ctx.approvals.withdraw(s.session_id, "the dialog changed on the screen");
      s.screenAsked = hash;
      const preset = screenAction(ctx.agent, dialog, s.projectPath);
      if (!phoneMayDecide(preset.action)) { note(s, `This dialog is answered at the computer: ${preset.reason ?? "a phone may not decide it"}.`); return; }
      const ask = { hash, decision: null, answering: false };
      s.screenAsk = ask;
      ctx.approvals.request(s, preset.action.tool, { screen: preset.action.input }, { ...preset, onPhone: (decision) => { ask.decision = decision; } })
        .then(() => answer(s, ask))
        .catch(() => {})
        .finally(() => { if (s.screenAsk === ask) s.screenAsk = null; });
    },
  };
}
