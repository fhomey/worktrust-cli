/**
 * --summary: what a person or a team reads from the archive, counted locally after the chain checks out. Per month the
 * hours, the tokens per model and the share of input served from the cache (where the tokens go, and so where they
 * can be saved); and the PARALLEL WORK: per project and day the sessions' open spans added up against the wall-clock
 * time they covered together (spans on both sides, so the sum is never below the clock), and the most open at once. A stretch without a project or a measured token stays out of that
 * figure; nothing is estimated.
 *
 * Pure: the archive's verified lines in, the lines to print out. No file, no clock, no network.
 */
export function summaryLines(lines) {
  const out = [];
  const months = new Map();
  const month = (key) => months.get(key) ?? months.set(key, { seconds: 0, models: new Map(), input: 0, cached: 0, days: new Map(), delivered: 0, verifiedFirst: 0 }).get(key);
  for (const line of lines) {
    const m = month(line.day.slice(0, 7));
    m.seconds += line.seconds ?? 0;
    // 0.7.1: stretches that delivered (a commit, a PR, a push, a deploy), and of them, those where a check passed first.
    if (line.delivery) { m.delivered += 1; if (line.delivery.verified_first === true) m.verifiedFirst += 1; }
    if (typeof line.tokens_in === "number" || typeof line.tokens_out === "number") {
      const name = line.model ?? "model not recorded";
      m.models.set(name, (m.models.get(name) ?? 0) + (line.tokens_in ?? 0) + (line.tokens_out ?? 0));
    }
    if (typeof line.tokens_in === "number" && typeof line.tokens_cache_read === "number") { m.input += line.tokens_in + line.tokens_cache_read; m.cached += line.tokens_cache_read; }
    if (line.project) { const key = `${line.day}|${line.project}`; (m.days.get(key) ?? m.days.set(key, []).get(key)).push([Date.parse(line.started_at), Date.parse(line.ended_at), line.seconds ?? 0]); }
  }
  const hours = (seconds) => (seconds / 3600).toFixed(1);
  for (const [key, m] of [...months].sort()) {
    out.push(`  ${key}  ${hours(m.seconds)} h measured`);
    for (const [model, tokens] of [...m.models].sort((a, b) => b[1] - a[1])) out.push(`    ${model.padEnd(28)} ${tokens.toLocaleString("en")} tokens`);
    if (m.input > 0) out.push(`    cache share of input        ${Math.round((m.cached / m.input) * 100)}%`);
    if (m.delivered > 0) out.push(`    verified before delivery    ${m.verifiedFirst} of ${m.delivered} stretch${m.delivered === 1 ? "" : "es"} that delivered`);
    let parallelDays = 0, peak = 1, summed = 0, wall = 0;
    for (const spans of m.days.values()) {
      const edges = spans.flatMap(([from, to]) => [[from, 1], [to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let open = 0, top = 0, covered = 0, since = 0;
      for (const [at, step] of edges) { if (open > 0) covered += at - since; open += step; since = at; top = Math.max(top, open); }
      if (top > 1) { parallelDays += 1; peak = Math.max(peak, top); summed += spans.reduce((sum, [from, to]) => sum + (to - from), 0) / 1000; wall += covered / 1000; }
    }
    if (parallelDays > 0) out.push(`    parallel sessions in one project on ${parallelDays} day${parallelDays === 1 ? "" : "s"}: up to ${peak} at once, ${hours(summed)} h of session time in ${hours(wall)} h of wall-clock time`);
  }
  return out;
}
