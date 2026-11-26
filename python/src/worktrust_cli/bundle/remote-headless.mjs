/**
 * LINK A SERVER: A COMPUTER WITHOUT A SCREEN (CLI 0.11.27; owner, 2026-11-25: "make it possible", and the three decisions of
 * ~18:20; docs/remote-agents/HEADLESS.md).
 *
 *   the codes    beside the QR, when wanted (`--code`, or by default over SSH or on Linux without a display, for a person at a
 *                terminal only): the invite's 8 characters to TYPE (the gateway's ticket, which names this computer to a phone of
 *                the same account, once) and the QR's own compact code to PASTE (58 base32 characters, the same seed and
 *                commitment as the QR, linking at once), with this computer's key.
 *   the confirm  a phone that came by the typed code says hello without the QR's secret and waits as pending; confirmAsked
 *                shows its key here and links it only on the person's y (n removes it; no terminal: nothing).
 *   guesses      a hello whose pairing proof fails for the live invite is counted; at PAIR_TRIES the invite is spent.
 *   reboot       `remote status` over SSH says what a restart with nobody logged in does, unless `remote service always on`
 *                (remote-always.mjs) runs it anyway.
 */
import * as P from "./remote-protocol.mjs";
import { CONFIRM, askLine, confirmYes, personAtKeyboard } from "./remote-keyboard.mjs";
import { loadPhones, readJson, savePhones, writeJson } from "./remote-store.mjs";

export const PAIR_TRIES = 5;
export const CODE_COMMAND = "npx worktrust remote pair --code";
export const BURNED_LINE = `  The pairing code was tried ${PAIR_TRIES} times with a wrong secret, so it no longer works. A new one: ${CODE_COMMAND}`;
const overSsh = (env) => Boolean(env.SSH_CONNECTION || env.SSH_TTY);

/** `--code` is for a person at a terminal only; otherwise it refuses before anything is made. */
export function codeGuard(io, env = process.env) {
  if (!personAtKeyboard(io, env) || io.has?.("yes") || io.has?.("json")) io.fail("the pairing code is shown to a person in a terminal (an SSH session with a terminal counts), never in a pipe, with --yes or --json, or in an AI agent's shell");
}

/** The QR's compact fragment in groups of four, or null when the invite is not in the compact form (another relay). */
export function groupedCode(qrText) {
  const fragment = String(qrText ?? "").split("#")[1] ?? "";
  return P.isCompactPairing(fragment) ? fragment.match(/.{1,4}/g).join("-") : null;
}

/**
 * WHETHER THE CODES ARE SHOWN: with `--code`, and (owner, 2026-11-25) by default in a session without a screen of its own: SSH,
 * or Linux with no display. The default, too, only for a person at a terminal (never a pipe, --yes, --json, an agent's shell).
 */
export const headlessSession = (env = process.env, platform = process.platform) => overSsh(env) || (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
export const codeWanted = (io, env = process.env, platform = process.platform) => io.has?.("code") === true || (headlessSession(env, platform) && personAtKeyboard(io, env) && !io.has?.("yes") && !io.has?.("json"));

/**
 * The lines under the QR when the codes are wanted: the 8-character code to TYPE (the gateway's ticket: it names this computer
 * to a phone of the same account, once; this terminal then asks to confirm that phone's key), the QR's own 58-character code
 * to PASTE (it links at once, by its secret), and this computer's key. Otherwise the one line the QR always had. `keys`: this
 * computer's public keys (remote-store.mjs loadKeys().public); `ticket`: the invite's 8 characters.
 */
export function codeLines(io, qrText, publicKeys, ticket, env = process.env, platform = process.platform) {
  const short = `${ticket.slice(0, 4)}-${ticket.slice(4)}`;
  if (!codeWanted(io, env, platform)) return [`  No camera? Type this code in the app: ${short} (this terminal then asks you to confirm your phone's key). Or: ${CODE_COMMAND}`];
  const code = groupedCode(qrText), fingerprint = P.deviceFingerprint(publicKeys);
  return [
    "",
    "  No camera? On your phone: Remote › Connect a computer › Trouble scanning?, then",
    `    type   ${short}   (this terminal then shows your phone's key and asks you to confirm it)`,
    code ? `    or paste  ${code}   (links at once)` : `    or paste this link  ${qrText}`,
    `  This computer's key: ${fingerprint}. Your phone shows the same key before it links; link only if they match.`,
    "  Only you should type it: never type a code someone else sends you. Both work once, for ten minutes.",
  ];
}

/**
 * A PHONE THAT ASKED BY THE TYPED CODE (owner, 2026-11-25): it resolved the ticket at the gateway and said hello without the
 * QR's secret, so the daemon holds it as pending. The 40-bit ticket proved only that a phone of this account typed it within
 * its minutes; WHICH phone is decided here: its key is shown and the person answers y or yes. Yes confirms it exactly as
 * `remote phones confirm` (how: keyboard) and spends the invite; anything else removes it from the pending list. Without a
 * person at a terminal, nothing is confirmed and the command is named. `io.prompt` is the tests' seam. → the phone, or null.
 */
export async function confirmAsked(io, asked, env = process.env) {
  if (!personAtKeyboard(io, env) || io.has?.("yes") || io.has?.("json")) { io.say(`  A phone asked by code (${asked.fingerprint}). Confirm it at this keyboard: npx worktrust remote phones confirm ${asked.fingerprint}`); return null; }
  io.say("");
  io.say(`  A phone asked to link with the typed code. Its key: ${asked.fingerprint}`);
  io.say("  Your phone shows its own key under Trouble scanning? (This phone's fingerprint). Link only if they are the same.");
  const said = await (io.prompt ?? askLine)(`  Is ${asked.fingerprint} the key your phone shows? ${CONFIRM} `);
  const phones = loadPhones(), still = phones.pending.find((p) => p.fingerprint === asked.fingerprint);
  if (!confirmYes(said) || !still) { savePhones({ ...phones, pending: phones.pending.filter((p) => p.fingerprint !== asked.fingerprint) }); io.say("  Not linked. That phone was removed from the waiting list."); return null; }
  const phone = { ...still, how: "keyboard", confirmed_at: Date.now() };
  savePhones({ ...phones, pending: phones.pending.filter((p) => p !== still), confirmed: [...phones.confirmed.filter((p) => p.fingerprint !== still.fingerprint), phone] });
  const invite = readJson("invite.json"); if (invite && !invite.used) writeJson("invite.json", { ...invite, used: true, used_at: Date.now(), used_by: phone.fingerprint });
  io.say(`  ✓ Confirmed: phone · ${phone.fingerprint}. It links at its next try (a few seconds).`);
  return phone;
}

/** The daemon (receiveHello): a pairing proof that failed for the live invite is counted; at PAIR_TRIES the invite is spent. */
export function countPairTry(live, hello, code, now, write = (body) => writeJson("invite.json", body)) {
  if (!live || hello?.pair_proof === undefined || code !== "not_confirmed") return null;
  const failed = (Number.isSafeInteger(live.failed) ? live.failed : 0) + 1;
  write({ ...live, failed, ...(failed >= PAIR_TRIES ? { used: true, used_at: now, used_by: null, burned: "tries" } : {}) });
  return failed;
}
/** linkPhone's loop: whether the invite it shows was spent by guesses. */
export const inviteBurned = () => { try { return readJson("invite.json")?.burned === "tries"; } catch { return false; } };

/** `remote status`, over SSH, while the service does NOT run with nobody logged in: what a restart then does, and the switch. */
export function headlessLines(platform = process.platform, env = process.env, always = false) {
  if (!overSsh(env) || always) return [];
  if (platform === "darwin") return ["  Over SSH: macOS runs the Remote Agent service only while you are logged in on this Mac's own screen (Screen Sharing counts, or automatic login on); with nobody logged in it cannot start. To run it anyway: npx worktrust remote service always on"];
  if (platform === "linux") return ["  Over SSH: Linux runs the Remote Agent service only while you are logged in; after a restart it waits for your next login. To run it anyway: npx worktrust remote service always on"];
  return [];
}
