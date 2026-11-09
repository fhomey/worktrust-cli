/**
 * WHAT A STAGE'S TOOL REPORTED, COUNTED (owner, 2026-11-07: "400 / 500 tests" only when a tool said so). Pure functions
 * over a tool's own report text. Each returns `{ measured?, findings? }` with only what it could read: a report that does
 * not parse gives `{}`, never a guess and never a zero. `measured` is { done, total, failed, unit }: tests that ran over
 * the tests there are (done = passed + failed + skipped), failed among them. `findings` is { high, medium, low } from a
 * scanner. Tested against recorded fixtures in scripts/fixtures/remote/pipeline/.
 *
 *   tap           TAP 13/14 (node --test --test-reporter=tap, tape, …): the `# tests/pass/fail` summary when present,
 *                 else the top-level `ok`/`not ok` lines over the plan `1..N`; `createTapCounter` counts while it streams
 *   node_test     the node test runner's spec summary (ℹ tests / pass / fail / skipped / todo / cancelled)
 *   junit_xml     <testsuites tests failures errors skipped>, else the sum of its <testsuite> elements
 *   vitest_json   Vitest's json reporter (Jest's shape): numTotalTests, numFailedTests …
 *   jest_json     the same fields from Jest
 *   semgrep_json  results[].extra.severity ERROR / WARNING / INFO → high / medium / low; paths.scanned as files
 *   zap_json      site[].alerts[].riskcode 3 / 2 / 1 → high / medium / low (0, informational, is not a finding)
 */
const int = (v) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const measured = (total, failed, unit = "tests") => (Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(failed) && failed >= 0 && failed <= total ? { measured: { done: total, total, failed, unit } } : {});

function jsonOf(text) {
  try { return JSON.parse(text); } catch { /* a reporter may print around its JSON */ }
  const from = text.indexOf("{"), to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  try { return JSON.parse(text.slice(from, to + 1)); } catch { return null; }
}

export function parseTap(text) {
  const summary = {};
  for (const m of text.matchAll(/^#\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/gm)) summary[m[1]] = Number(m[2]);
  if (summary.tests !== undefined) return measured(summary.tests, (summary.fail ?? 0) + (summary.cancelled ?? 0));
  let ok = 0, notOk = 0, plan = null;
  for (const line of text.split("\n")) {
    if (/^ok\s+\d+/.test(line)) ok += 1;
    else if (/^not ok\s+\d+/.test(line)) notOk += 1;
    else if (/^1\.\.(\d+)\s*$/.test(line)) plan = Number(/^1\.\.(\d+)/.exec(line)[1]);
  }
  if (plan === null || ok + notOk !== plan) return {}; // a cut stream: the denominator is not known
  return measured(plan, notOk);
}

/** While TAP streams: tests seen so far, and the plan once a producer printed it first. */
export function createTapCounter() {
  let carry = "", ok = 0, notOk = 0, plan = null;
  return {
    feed(chunk) {
      const lines = (carry + chunk).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (/^ok\s+\d+/.test(line)) ok += 1;
        else if (/^not ok\s+\d+/.test(line)) notOk += 1;
        else if (/^1\.\.(\d+)\s*$/.test(line)) plan = Number(/^1\.\.(\d+)/.exec(line)[1]);
      }
    },
    /** A measured count only with a plan that covers what was seen; else nothing (no bar from a guess). */
    now: () => (plan !== null && plan > 0 && ok + notOk <= plan ? { done: ok + notOk, total: plan, failed: notOk, unit: "tests" } : null),
  };
}

export function parseNodeTest(text) {
  const s = {};
  for (const m of text.matchAll(/^\s*(?:ℹ|#)\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/gm)) s[m[1]] = Number(m[2]);
  return s.tests === undefined ? {} : measured(s.tests, (s.fail ?? 0) + (s.cancelled ?? 0));
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/\s([a-z]+)="([^"]*)"/gi)].map((m) => [m[1].toLowerCase(), m[2]]));
export function parseJunitXml(text) {
  const root = /<testsuites\b[^>]*>/i.exec(text)?.[0];
  const a = root ? attrs(root) : null;
  if (a && int(a.tests) !== null) return measured(int(a.tests), (int(a.failures) ?? 0) + (int(a.errors) ?? 0));
  let tests = 0, failed = 0, seen = 0;
  for (const m of text.matchAll(/<testsuite\b[^>]*>/gi)) {
    const s = attrs(m[0]);
    if (int(s.tests) === null) return {};
    seen += 1; tests += int(s.tests); failed += (int(s.failures) ?? 0) + (int(s.errors) ?? 0);
  }
  return seen === 0 ? {} : measured(tests, failed);
}

export function parseJestJson(text) {
  const j = jsonOf(text);
  if (!j || int(j.numTotalTests) === null || int(j.numFailedTests) === null) return {};
  return measured(int(j.numTotalTests), int(j.numFailedTests));
}

export function parseSemgrepJson(text) {
  const j = jsonOf(text);
  if (!j || !Array.isArray(j.results)) return {};
  const findings = { high: 0, medium: 0, low: 0 };
  for (const r of j.results) {
    const sev = String(r?.extra?.severity ?? "").toUpperCase();
    if (sev === "ERROR" || sev === "CRITICAL" || sev === "HIGH") findings.high += 1;
    else if (sev === "WARNING" || sev === "MEDIUM") findings.medium += 1;
    else findings.low += 1;
  }
  const scanned = Array.isArray(j.paths?.scanned) ? j.paths.scanned.length : 0;
  return { findings, ...(scanned > 0 ? { measured: { done: scanned, total: scanned, failed: 0, unit: "files" } } : {}) };
}

export function parseZapJson(text) {
  const j = jsonOf(text);
  if (!j || !Array.isArray(j.site)) return {};
  const findings = { high: 0, medium: 0, low: 0 };
  for (const site of j.site) for (const alert of Array.isArray(site?.alerts) ? site.alerts : []) {
    const risk = int(alert?.riskcode);
    if (risk === 3) findings.high += 1; else if (risk === 2) findings.medium += 1; else if (risk === 1) findings.low += 1;
  }
  return { findings };
}

export const PARSERS = { tap: parseTap, node_test: parseNodeTest, junit_xml: parseJunitXml, vitest_json: parseJestJson, jest_json: parseJestJson, semgrep_json: parseSemgrepJson, zap_json: parseZapJson };

/** The parser's reading of a report, `{}` for `none` or an unknown parser. */
export const readReport = (parser, text) => (typeof text === "string" && Object.hasOwn(PARSERS, parser) ? PARSERS[parser](text) : {});

/** A scanner stage fails on a finding at or above its threshold; `none` never fails on findings. */
export function findingsFail(findings, failOn) {
  if (!findings || failOn === "none") return false;
  if (failOn === "high") return findings.high > 0;
  if (failOn === "medium") return findings.high + findings.medium > 0;
  return findings.high + findings.medium + findings.low > 0;
}
