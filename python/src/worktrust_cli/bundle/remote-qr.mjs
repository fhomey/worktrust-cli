/**
 * A QR CODE FOR THE TERMINAL, WITHOUT A DEPENDENCY (2026-11-07; owner: pairing by scanning the computer's screen with the
 * WorkTrust app). ISO/IEC 18004: byte mode, error correction level M (or L), the smallest version 1 to 40 that holds the data,
 * the mask with the lowest penalty, format and version information. `qrMatrix(text)` gives the modules (true = dark);
 * `renderQr(matrix)` draws them with half-block characters, two module rows per line, black on an explicitly white
 * background with a white quiet zone (two modules since 0.11.12), so it scans in a light or a dark terminal.
 *
 * Held by scripts/test-remote-qr.mjs against reference matrices from an independent encoder (recorded fixtures) and an
 * independent structural decoder in the test itself.
 */

// Level M, per version: [error correction codewords per block, blocks in group 1, data codewords each, group 2, each].
const EC_M = [null,
  [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42], [28, 17, 46], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48], [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46], [28, 21, 45, 7, 46], [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47], [28, 10, 46, 23, 47], [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48], [28, 6, 47, 34, 48], [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48]];

// Level L, the same shape (ISO/IEC 18004 table 9). A code on a screen is not scuffed like a print: L (7% recovery, M is 15%)
// holds the same link in fewer modules (owner, 2026-11-14: "make the QR more compact"). Every version's total of codewords
// is the same as M's; scripts/test-remote-claude-events.mjs holds that for all forty.
const EC_L = [null,
  [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
  [20, 4, 81], [24, 2, 92, 2, 93], [26, 4, 107], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88], [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108],
  [28, 4, 116, 4, 117], [28, 2, 111, 7, 112], [30, 4, 121, 5, 122], [30, 6, 117, 4, 118], [26, 8, 106, 4, 107], [28, 10, 114, 2, 115], [30, 8, 122, 4, 123], [30, 3, 117, 10, 118], [30, 7, 116, 7, 117], [30, 5, 115, 10, 116],
  [30, 13, 115, 3, 116], [30, 17, 115], [30, 17, 115, 1, 116], [30, 13, 115, 6, 116], [30, 12, 121, 7, 122], [30, 6, 121, 14, 122], [30, 17, 122, 4, 123], [30, 4, 122, 18, 123], [30, 20, 117, 4, 118], [30, 19, 118, 6, 119]];
const TABLES = { L: EC_L, M: EC_M };
/** The format information's two level bits (L 01, M 00). */
const LEVEL_BITS = { L: 0b01, M: 0b00 };

export const blocksOf = (v, level = "M") => { const [ec, n1, d1, n2 = 0, d2 = 0] = TABLES[level][v]; return { ec, groups: [[n1, d1], [n2, d2]].filter(([n]) => n > 0) }; };
const dataCodewords = (v, level = "M") => blocksOf(v, level).groups.reduce((s, [n, d]) => s + n * d, 0);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
export function reedSolomon(data, degree) {
  const g = generator(degree), rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i += 1) rem[i] ^= mul(g[i + 1], factor);
  }
  return rem;
}

/**
 * SEGMENTS (CLI 0.11.12): a code is one BYTE segment, as before, or a byte segment followed by an ALPHANUMERIC one (ISO/IEC
 * 18004 7.4.4: 0-9, A-Z, space and $%*+-./:, two characters in 11 bits). `segmentsOf` splits only a link whose fragment is
 * all alphanumeric (the compact pairing code, remote-protocol pairing.ts); every other text stays one byte segment, so
 * every code drawn before is drawn the same.
 */
export const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
export function segmentsOf(text) {
  const hash = text.lastIndexOf("#"), tail = hash >= 0 ? text.slice(hash + 1) : "";
  if (tail.length < 16 || [...tail].some((ch) => !ALPHANUMERIC.includes(ch))) return [{ mode: "byte", data: text }];
  return [{ mode: "byte", data: text.slice(0, hash + 1) }, { mode: "alphanumeric", data: tail }];
}
const countBits = (mode, v) => (mode === "byte" ? (v < 10 ? 8 : 16) : v < 10 ? 9 : v < 27 ? 11 : 13);
const segmentBits = (seg, v) => 4 + countBits(seg.mode, v) + (seg.mode === "byte" ? new TextEncoder().encode(seg.data).length * 8 : Math.floor(seg.data.length / 2) * 11 + (seg.data.length % 2) * 6);

function codewords(segments, level = "M") {
  let version = 1;
  const need = (v) => segments.reduce((sum, seg) => sum + segmentBits(seg, v), 0);
  while (version <= 40 && need(version) > dataCodewords(version, level) * 8) version += 1;
  if (version > 40) throw new RangeError("too much data for one QR code");
  const capacity = dataCodewords(version, level) * 8, bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  for (const seg of segments) {
    if (seg.mode === "byte") {
      const bytes = new TextEncoder().encode(seg.data);
      put(0b0100, 4); put(bytes.length, countBits("byte", version));
      for (const b of bytes) put(b, 8);
    } else {
      put(0b0010, 4); put(seg.data.length, countBits("alphanumeric", version));
      const at = (i) => ALPHANUMERIC.indexOf(seg.data[i]);
      for (let i = 0; i + 1 < seg.data.length; i += 2) put(at(i) * 45 + at(i + 1), 11);
      if (seg.data.length % 2) put(at(seg.data.length - 1), 6);
    }
  }
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0; bits.length < capacity; pad += 1) put(pad % 2 ? 0x11 : 0xec, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const { ec, groups } = blocksOf(version, level), blocks = [];
  let at = 0;
  for (const [n, d] of groups) for (let i = 0; i < n; i += 1) { const block = data.slice(at, at + d); at += d; blocks.push({ data: block, ec: reedSolomon(block, ec) }); }
  const out = [], longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return { version, out };
}

export function alignmentCenters(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2, size = version * 4 + 17;
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const centers = [size - 7];
  for (let i = 1; i < count - 1; i += 1) centers[i] = centers[i - 1] - step;
  centers.push(6);
  return centers.reverse();
}

const bch = (value, poly, bitsOfPoly) => { let v = value << (bitsOfPoly - 1); while (31 - Math.clz32(v) >= bitsOfPoly - 1) v ^= poly << (31 - Math.clz32(v) - (bitsOfPoly - 1)); return v; };
export const formatBits = (mask, level = "M") => { const data = (LEVEL_BITS[level] << 3) | mask; return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412; };
export const versionBits = (version) => (version << 12) | bch(version, 0x1f25, 13);

export const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0];

function base(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => { m[r][c] = dark; fixed[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [size - 7, 0], [0, size - 7]])
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      set(rr, cc, (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
    }
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const centers = alignmentCenters(version), last = centers.length - 1;
  for (const [i, r] of centers.entries()) for (const [j, c] of centers.entries()) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // under a finder
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  for (let i = 0; i < 9; i += 1) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i += 1) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (version >= 7) for (let i = 0; i < 18; i += 1) { const r = Math.floor(i / 3), c = (i % 3) + size - 11; set(r, c, false); set(c, r, false); }
  return { size, m, fixed };
}

function place(version, words, mask, level = "M") {
  const { size, m, fixed } = base(version);
  let bit = 0;
  const total = words.length * 8, take = () => (bit < total ? (words[bit >> 3] >>> (7 - (bit++ & 7))) & 1 : 0);
  for (let col = size - 1, up = true; col > 0; col -= 2, up = !up) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i += 1) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) if (!fixed[r][c]) m[r][c] = (take() === 1) !== MASKS[mask](r, c);
    }
  }
  const f = formatBits(mask, level);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((f >> i) & 1) === 1;
    if (i < 6) m[i][8] = dark; else if (i < 8) m[i + 1][8] = dark; else m[size - 15 + i][8] = dark;
    if (i < 8) m[8][size - i - 1] = dark; else if (i < 9) m[8][15 - i] = dark; else m[8][14 - i] = dark;
  }
  m[size - 8][8] = true;
  if (version >= 7) { const v = versionBits(version); for (let i = 0; i < 18; i += 1) { const dark = ((v >> i) & 1) === 1, r = Math.floor(i / 3), c = (i % 3) + size - 11; m[r][c] = dark; m[c][r] = dark; } }
  return m;
}

/** The penalty of ISO/IEC 18004 section 7.8.3 (N1 runs, N2 blocks, N3 finder-like patterns, N4 balance). */
export function penalty(m) {
  const size = m.length;
  let points = 0, dark = 0;
  for (let line = 0; line < size; line += 1) for (const get of [(i) => m[line][i], (i) => m[i][line]]) {
    let run = 1, bits = 0;
    for (let i = 0; i < size; i += 1) {
      if (i > 0) { if (get(i) === get(i - 1)) run += 1; else { if (run >= 5) points += run - 2; run = 1; } }
      bits = ((bits << 1) & 0x7ff) | (get(i) ? 1 : 0);
      if (i >= 10 && (bits === 0x5d0 || bits === 0x05d)) points += 40;
    }
    if (run >= 5) points += run - 2;
  }
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) {
    if (m[r][c]) dark += 1;
    if (r < size - 1 && c < size - 1) { const s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1]; if (s === 0 || s === 4) points += 3; }
  }
  return points + Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10) * 10;
}

/** The modules of the QR code for `text` (UTF-8 bytes, one byte segment unless `segments` says otherwise), `mask` chosen by penalty unless given. */
export function qrMatrix(text, forcedMask = null, level = "M", segments = [{ mode: "byte", data: text }]) {
  const { version, out } = codewords(segments, level);
  if (forcedMask !== null) return { version, mask: forcedMask, modules: place(version, out, forcedMask, level) };
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) { const modules = place(version, out, mask, level), score = penalty(modules); if (!best || score < best.score) best = { version, mask, modules, score }; }
  return { version: best.version, mask: best.mask, modules: best.modules };
}

/**
 * THE QUIET ZONE, in modules, around every code the CLI draws: two (CLI 0.11.12, owner 2026-11-15: "about 4 x 4 cm"), half
 * the standard's four. A terminal code is drawn on its own explicitly white ground, so the margin a printed code needs
 * against the paper's surroundings is the ground itself; the phone's scanner and the iOS camera read a 2-module margin.
 */
export const QUIET = 2;
/** Half blocks, black on white, the quiet zone above. `color` false gives the plain characters (dark = block). */
export function renderQr(modules, { color = true } = {}) {
  const quiet = QUIET, size = modules.length + quiet * 2;
  const dark = (r, c) => { const rr = r - quiet, cc = c - quiet; return rr >= 0 && cc >= 0 && rr < modules.length && cc < modules.length && modules[rr][cc]; };
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c += 1) { const top = dark(r, c), bottom = r + 1 < size && dark(r + 1, c); line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "; }
    lines.push(color ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}

/**
 * EVERY QR THE CLI DRAWS GOES THROUGH HERE (owner, 2026-11-14: "make the QR more compact"): the approval, the pairing and the
 * one-scan code alike, level L, half blocks (one character per module across, two module rows per terminal line), the
 * white quiet zone, and since 0.11.12 an alphanumeric segment for a compact pairing fragment (segmentsOf). Sizes, level L:
 * the compact pairing code is version 4 (33 modules): 37 characters by 19 lines; the approval link alone version 4; the
 * one-scan approval with its compact fragment version 5 (37 modules): 41 by 21. At a 13 px monospace font (a cell about
 * 7.8 px wide, so one module about 7.8 px square) 37 characters are about 289 px: 7.6 cm at 96 px an inch, 5.8 cm on a
 * 127 px-an-inch laptop screen. `color` as renderQr: the ground drawn white on a terminal with colours, the plain characters
 * otherwise (a pipe, NO_COLOR). check-remote-cli and cli-01110-cases hold that no other path draws one.
 */
export function terminalQr(text, { color = true } = {}) {
  return renderQr(qrMatrix(text, null, "L", segmentsOf(text)).modules, { color });
}
