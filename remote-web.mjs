/**
 * THE WEB TOOLS OF A REMOTE SESSION (CLI 0.11.26; owner, 2026-11-25: "you should even be able to ask the weather through the
 * agent"). Until 0.11.25 every WebSearch and WebFetch of a phone-steered session was denied on the computer: remote-policy.mjs
 * classified both as class `other`, which no phone may decide (remote-approvals.mjs phoneMayDecide).
 *
 *   search   a read of the public web: allowed in every agent mode (manual, plan, edit, auto) while this keyboard says
 *            `web-search on` (the default), and shown in the session's activity as "Searched the web: <query>" (sealed, like
 *            the rest of the session)
 *   pages    a WebFetch of a URL can leak what the agent read into the URL it opens: its own approval class `web_fetch`,
 *            asked on the phone page by page (the URL shown whole), while this keyboard says `web-pages ask` (the default);
 *            `off` denies them all. Claude Code only: another agent's fetch is denied with the reason in words
 *   never    shell network tools (curl, wget …) stay denied (remote-adapter-claude-code.mjs REMOTE_DENY), whatever this says
 * The standing default is set here at the keyboard; the phone decides only the pages it is asked about.
 */
import { applySettingsChange } from "./remote-settings.mjs";
import { loadSettings, webOf } from "./remote-store.mjs";

/**
 * `remote web-search on|off|status` and `remote web-pages ask|off|status` (CLI 0.11.26), at this keyboard: the standing default
 * of every remote session. A search is a read of the public web (on by default); a page is allowed on the phone, page by page
 * (ask, the default), or never (off). Shell network tools (curl, wget …) stay denied whatever this says.
 */
export function webCommand(io, sub, rest) {
  const word = rest[0] ?? "status", now = webOf(loadSettings());
  if (word === "status") return io.say(`  Web search in a remote session: ${now.search ? "on" : "off"} · web pages: ${now.fetch === "ask" ? "asked on your phone, page by page" : "off"} (npx worktrust remote web-search on|off · web-pages ask|off)`);
  const change = sub === "web-search" ? (word === "on" || word === "off" ? { what: "web", search: word === "on" } : null) : word === "ask" || word === "off" ? { what: "web", fetch: word } : null;
  if (!change) return io.fail(sub === "web-search" ? "npx worktrust remote web-search on|off|status" : "npx worktrust remote web-pages ask|off|status");
  const done = applySettingsChange(change, { kind: "keyboard" });
  if (!done.ok) return io.fail(done.reason);
  io.say(`  ✓ ${done.message}`);
}
