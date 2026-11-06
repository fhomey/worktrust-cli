/**
 * WHAT AN EXPORT SAYS ABOUT ITS OWN CLOCK (CLI 0.10.38; owner 2026-11-06, export plausibility). chat-exports.mjs reads a ChatGPT
 * or Claude-on-the-web export; these pure helpers turn what it passes on the way into counts, booleans and instants that
 * WorkTrust checks on arrival (packages/core/src/export-plausibility.ts). Never a conversation's id, title or text, never the
 * archive's file name or the name's other parts: only the facts below leave this computer.
 *
 *   newShape() / noteShape(…)  the archive's shape as its entries are walked: an extra field other than zip64's, a data
 *                              descriptor, Finder's litter (__MACOSX, .DS_Store), conversations parts out of order, and the
 *                              conversations entries' first and last DOS write time (a DOS time has no zone: read as UTC)
 *   mergeShapes(shapes)        one shape for an export split over several zips
 *   inversionsOf(lines)        kept steps dated more than ten minutes before the step they follow (none in 5,003 real ones)
 *   idSkewOf(id, created)      ChatGPT: a v8 conversation id's first 32 bits are the second it was minted (since 2024-09); the
 *                              conversation's create_time minus that second, whole seconds; a v4 id has no clock (null)
 *   envelopeOf(envelope, vendor) the batch's envelope: the archive's kind, the moment a vendor's file name gives, the write
 *                              times and the shape's booleans; a folder or a bare JSON says its kind alone
 */
const dosTime = (date, time) => {
  const month = (date >> 5) & 15, day = date & 31, hour = time >> 11, minute = (time >> 5) & 63, second = (time & 31) * 2;
  return month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 ? null : Date.UTC(1980 + (date >> 9), month - 1, day, hour, minute, second);
};
const SIGNS = ["extraFields", "dataDescriptor", "macLitter", "outOfOrder"];
export const newShape = () => ({ extraFields: false, dataDescriptor: false, macLitter: false, outOfOrder: false, writtenFrom: null, writtenTo: null, lastPart: -1 });
/** One entry of the walk: its name, general-purpose flags, extra field, DOS date and time, and its part number when it is a conversations entry (else null). */
export function noteShape(shape, name, flags, extra, date, time, part) {
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) if (extra.readUInt16LE(at) !== 1) shape.extraFields = true;
  if (flags & 8) shape.dataDescriptor = true;
  if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name)) shape.macLitter = true;
  if (part === null) return;
  const written = dosTime(date, time);
  if (written !== null) { shape.writtenFrom = Math.min(shape.writtenFrom ?? written, written); shape.writtenTo = Math.max(shape.writtenTo ?? written, written); }
  if (part < shape.lastPart) shape.outOfOrder = true;
  shape.lastPart = Math.max(shape.lastPart, part);
}
export function mergeShapes(shapes) {
  const times = (key) => shapes.map((one) => one[key]).filter((at) => at !== null);
  return { ...newShape(), ...Object.fromEntries(SIGNS.map((key) => [key, shapes.some((one) => one[key])])),
    writtenFrom: times("writtenFrom").length ? Math.min(...times("writtenFrom")) : null, writtenTo: times("writtenTo").length ? Math.max(...times("writtenTo")) : null };
}

const INVERSION_MS = 600_000;
export function inversionsOf(lines) {
  let n = 0, before = null;
  for (const line of lines) {
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    if (before !== null && at < before - INVERSION_MS) n += 1;
    before = at;
  }
  return n;
}
const V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function idSkewOf(id, created) {
  if (typeof id !== "string" || !V8.test(id)) return null;
  const minted = parseInt(id.slice(0, 8), 16), at = Number(created);
  return Number.isFinite(at) && at > 0 && minted > 1_600_000_000 && Math.abs(at - minted) <= 1e9 ? Math.round(at - minted) : null;
}

/** A vendor names its export zip after the moment it was made; Claude's pattern is not verified on a real export (no match: no moment). */
const NAMED = {
  chatgpt: /^[0-9a-f]{64}-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-[0-9a-f]{32}(?: ?\(\d{1,3}\))?\.zip$/i,
  "claude-web": /^data-(?:[0-9a-f-]{36}-)?(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-batch-\d{4})?(?: ?\(\d{1,3}\))?\.zip$/i,
};
const iso = (at) => (at === null || at === undefined ? null : new Date(at).toISOString());
export function envelopeOf(envelope, vendor) {
  if (!envelope) return null;
  if (envelope.kind !== "zip" && envelope.kind !== "zips") return { kind: envelope.kind };
  const named = envelope.kind === "zip" && typeof envelope.name === "string" ? NAMED[vendor]?.exec(envelope.name) : null;
  const at = named ? Date.UTC(+named[1], +named[2] - 1, +named[3], +named[4], +named[5], +named[6]) : NaN, { shape } = envelope;
  return { kind: envelope.kind, named_at: Number.isFinite(at) ? iso(at) : null, written_from: iso(shape.writtenFrom), written_to: iso(shape.writtenTo),
    shape: { vendor_name: Boolean(named), extra_fields: shape.extraFields, data_descriptor: shape.dataDescriptor, mac_litter: shape.macLitter, out_of_order: shape.outOfOrder } };
}
