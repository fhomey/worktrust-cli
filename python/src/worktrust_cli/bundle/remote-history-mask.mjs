/**
 * A KEY'S SHAPE, AND THE MASK THAT STANDS IN ITS PLACE (CLI 0.11.19; docs/remote-agents/CHAT-HISTORY.md §6). Pure: no I/O.
 *
 *   keyShaped   whether a text holds a key's shape. The step filter's own rule since 0.11.17 (remote-history-claude.mjs
 *               historyWithholds): a step whose input or output holds one sends nothing of either.
 *   maskKeys    the same shapes in PROSE (the words a person typed, a paste on every page since 0.11.20, an agent's text, a
 *               label, a desk session's title): a
 *               text is never withheld whole for one key in it, the key is replaced IN PLACE by KEY_MASK and the words
 *               around it stay. A text that is still key-shaped after that is replaced whole by the mask (this fails
 *               closed), and a text that never was key-shaped comes back unchanged, byte for byte.
 *
 * THE SHAPES (the second half since the security review of 2026-11-21, P3-3):
 *   a block     a PEM block, to its end line (or to the end of the text when it has none);
 *   a token     by its own prefix: GitHub, GitLab, npm, Slack, Google, Supabase, an API key (sk-), a payment key, a JWT, an
 *               AWS key id; Hugging Face, SendGrid, a webhook secret, DigitalOcean, a Google access token, a Twilio key;
 *   a header    `Authorization` with its value, and `Bearer` followed by twenty opaque characters;
 *   an address  scheme://user:password@, also with no user, and with a password that holds `/` or `@` (to the last @ of
 *               the address); never a port and a path (`host:3011/@scope`);
 *   a name      NAME=value on a line of its own (two such lines in a row are each masked whole); and ANYWHERE in a text a
 *               name that ENDS on a secret's word (password, passwd, passphrase, pwd, secret, credential, token, api key,
 *               …key, auth, authorization), with `=` or `:` and its value: unspaced `name=value`, `name: value` when the
 *               value has a digit or twelve characters, and any spacing when the value is a quoted string. Never a name
 *               that only begins with such a word (`passwordLabel`, `tokenCount`), never a value that is a reference
 *               (`process.env.API_KEY`), never `PWD`. Since the review of 2026-11-21 (P2-1) also a config file's shapes:
 *               `name = value` with spaces round `=` and no quotes (INI, ~/.aws/credentials, my.cnf) when the value has a
 *               digit or twelve characters, names ending `_PW` / `_PASS`, and .netrc's `password <value>`;
 *   a flag      `mysql -p<password>`; since the second pass of 2026-11-21 (P3-3) also `curl -u user:<password>`,
 *               `sshpass -p`, `docker login -p`, `--password <value>` and XML's `<password>`; and more token prefixes and
 *               the Slack and Discord webhook addresses.
 *
 * SHAPES ONLY. What this cannot see: a password said in a sentence, a secret under a name that says nothing, a customer's
 * name, an address, anything whose form is ordinary words. Every expression is bounded, so a long line costs one pass.
 * The mask is plain words in the text (no protocol key and no marker: an older phone reads it as the text it is).
 */
export const KEY_MASK = "[key hidden]";
/** The shapes that ARE the key: each match is the key itself. */
const TOKEN_SHAPES = [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|sbp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_-]{16,})/, /\bsk-[A-Za-z0-9_-]{16,}|\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(hf_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9+\/=_-]{16,}|dop_v1_[a-f0-9]{32,}|ya29\.[A-Za-z0-9_-]{20,}|SK[0-9a-fA-F]{32})\b/, /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/,
  // review 2026-11-21 (second pass, P3-3): Slack app, Google OAuth, Docker, Shopify, Linear, Atlassian, PyPI, GitLab runner, Groq, Replicate, Mailgun, a Telegram bot, and the two webhook addresses whose path IS the secret
  /\b(xapp-[0-9]-[A-Za-z0-9-]{20,}|GOCSPX-[A-Za-z0-9_-]{16,}|dckr_pat_[A-Za-z0-9_-]{16,}|shp(at|ss|ca|pa)_[a-fA-F0-9]{32}|lin_api_[A-Za-z0-9]{30,}|ATATT[A-Za-z0-9_=-]{30,}|pypi-AgEI[A-Za-z0-9_-]{30,}|glrt-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{40,}|r8_[A-Za-z0-9]{30,}|key-[0-9a-f]{32})\b/, /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/_-]{20,}|https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/];
const KEY_SHAPES = [/-----BEGIN/, ...TOKEN_SHAPES,
  /(^|\n)[ \t]*(export[ \t]+)?[A-Z][A-Z0-9_]+=[^\n]*\n[ \t]*(export[ \t]+)?[A-Z][A-Z0-9_]+=/, /(^|\n)[ \t]*(export[ \t]+)?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|_DSN|_KEY|_PW|_PASS)[A-Z0-9_]*=["']?[^\s"']{8,}/];

const PEM = /-----BEGIN[\s\S]*?(-----END[^\n]*|$)/g;
const TOKENS = TOKEN_SHAPES.map((shape) => new RegExp(shape.source, "g"));
const ASSIGNS = /^[ \t]*(export[ \t]+)?[A-Z][A-Z0-9_]+=/;
const NAMED = /^([ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|_DSN|_KEY|_PW|_PASS)[A-Z0-9_]*=)["']?[^\s"']{8,}.*$/;
const HEADER = /(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[A-Za-z0-9._~+\/=-]{6,512}/gi;
/** .netrc's `password <value>` (review 2026-11-21, P2-1): after `login <name>` on one line, or at a line's start with a value that is no word. */
const NETRC = /((?:^|\n)[ \t]*password[ \t]+)(?=[^\s]*[^A-Za-z\s])([^\s]{4,512})|(\blogin[ \t]+[^\s]{1,256}[ \t]+password[ \t]+)([^\s]{4,512})/g;
/** Flags that carry a password (P3-3): `curl -u user:pass`, `sshpass -p pass`, `docker login … -p pass`, `--password pass` (the space form), and XML's `<password>`. */
const FLAGS = /(\bcurl\b[^\n|;&]{0,200}?\s(?:-u|--user)\s+[^\s:]{1,128}:)[^\s'"]{3,256}|(\bsshpass\s+-p\s*)[^\s'"]{3,256}|(\bdocker\s+login\b[^\n|;&]{0,200}?\s(?:-p|--password)\s+)[^\s'"]{3,256}|(\s--password\s+)(?!-)[^\s'"]{3,256}|(<password>)[^<\s{}]{3,256}(?=<\/password>)/g;
const MYSQL = /(\bmysql(?:dump|admin|import)?\b[^\n|;&]{0,200}?\s-p)[^\s'"]{4,256}/g;
/** A name, `=` or `:`, a value: every such place in a text, wherever it stands. The name decides (secretName); bounded, so one pass. */
const PAIR = /(["']?)([A-Za-z][A-Za-z0-9_.-]{1,63})\1(?:(\s{0,8}[:=]\s{0,8})(["'])([^"'\n]{4,256})\4|(\s{0,8}=\s{0,8})([^\s"'&;,(){}<>[\]]{6,512})|(:[ \t]{1,8})([^\s"',;(){}<>[\]]{6,512}))/g;
const SECRET_NAME = /(passw(or)?d|passwd|passphrase|pwd|secret|credentials?|token|api[_-]?key|[a-z0-9][_-]?key|(^|[_.-])auth(orization)?|(^|[_.-])(pw|pass))([_-]?(base|value|b64|\d{1,3}))?$/;
const REFERENCE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const secretName = (name) => name !== "PWD" && name !== "OLDPWD" && SECRET_NAME.test(name.toLowerCase());

/** `text` with the value of every secret-named pair replaced (or `text` itself when there is none). */
function maskPairs(text) {
  let out = "", at = 0;
  PAIR.lastIndex = 0;
  for (let m = PAIR.exec(text); m !== null; m = PAIR.exec(text)) {
    const [whole, quote, name, sep, q, quoted, eq, bare, colon, said] = m, nameEnd = m.index + quote.length + name.length + quote.length;
    const value = quoted ?? bare ?? said;
    // A reference is no secret (`apiKey=process.env.API_KEY`); `name: value` needs a value that looks like one (a digit, or twelve characters).
    const hit = secretName(name) && value !== KEY_MASK && !value.startsWith("[key") && (quoted !== undefined || (!REFERENCE.test(value) && ((bare !== undefined && eq === "=") || /\d/.test(value) || value.length >= 12)));
    if (!hit) { PAIR.lastIndex = nameEnd; continue; } // looked at again from after the name: a pair may stand inside this one's value
    out += `${text.slice(at, nameEnd)}${sep ?? eq ?? colon}${q ?? ""}${KEY_MASK}${q ?? ""}`;
    at = m.index + whole.length;
  }
  return at === 0 ? text : out + text.slice(at);
}

/** `text` with the user and password of every address replaced: after each "://", to the LAST @ of that address; never a port and a path. */
function maskAddresses(text) {
  let out = "", at = 0;
  for (let i = text.indexOf("://"); i >= 0; i = text.indexOf("://", i + 3)) {
    if (i + 3 < at) continue;
    const m = /^([^\s/:@]{0,128}):([^\s]{1,512})@/.exec(text.slice(i + 3, i + 3 + 660));
    if (!m || /^\d{1,5}(\/|$)/.test(m[2]) || m[0] === `:${KEY_MASK.split(" ")[0]}@`) continue;
    out += `${text.slice(at, i + 3)}${KEY_MASK}@`;
    at = i + 3 + m[0].length;
  }
  return at === 0 ? text : out + text.slice(at);
}

/** Whether a text holds a key's shape. Every look is bounded, so a long text costs one pass. */
export function keyShaped(text) {
  const t = String(text ?? "");
  if (KEY_SHAPES.some((shape) => shape.test(t))) return true;
  HEADER.lastIndex = 0; MYSQL.lastIndex = 0; NETRC.lastIndex = 0; FLAGS.lastIndex = 0;
  return HEADER.test(t) || MYSQL.test(t) || NETRC.test(t) || FLAGS.test(t) || maskAddresses(t) !== t || maskPairs(t) !== t;
}

/** A text with every key's shape replaced in place by KEY_MASK. A text without one comes back as it is. */
export function maskKeys(text) {
  const t = String(text ?? "");
  if (!keyShaped(t)) return t;
  let out = t.replace(PEM, KEY_MASK);
  for (const shape of TOKENS) out = out.replace(shape, KEY_MASK);
  out = maskAddresses(out.replace(HEADER, `$1${KEY_MASK}`).replace(MYSQL, `$1${KEY_MASK}`).replace(NETRC, (_m, a, _v, b) => `${a ?? b}${KEY_MASK}`).replace(FLAGS, (_m, ...g) => `${g.slice(0, 5).find((x) => x !== undefined) ?? ""}${KEY_MASK}`));
  const lines = out.split("\n"), assigns = lines.map((line) => ASSIGNS.test(line));
  out = maskPairs(lines.map((line, n) => (assigns[n] && (assigns[n - 1] || assigns[n + 1]) ? KEY_MASK : line.replace(NAMED, `$1${KEY_MASK}`))).join("\n"));
  return keyShaped(out) ? KEY_MASK : out; // what this could not take out in place: nothing of the text is sent
}
