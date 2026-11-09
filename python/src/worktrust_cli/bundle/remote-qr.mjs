/**
 * A QR CODE FOR THE TERMINAL, WITHOUT A DEPENDENCY (2026-11-07; owner: pairing by scanning the computer's screen with the
 * WorkTrust app). ISO/IEC 18004: byte mode, error correction level M, the smallest version 1 to 40 that holds the data,
 * the mask with the lowest penalty, format and version information. `qrMatrix(text)` gives the modules (true = dark);
 * `renderQr(matrix)` draws them with half-block characters, two module rows per line, black on an explicitly white
 * background with a four-module white quiet zone, so it scans in a light or a dark terminal.
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

const blocksOf = (v) => { const [ec, n1, d1, n2 = 0, d2 = 0] = EC_M[v]; return { ec, groups: [[n1, d1], [n2, d2]].filter(([n]) => n > 0) }; };
const dataCodewords = (v) => blocksOf(v).groups.reduce((s, [n, d]) => s + n * d, 0);

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

function codewords(bytes) {
  let version = 1;
  const need = (v) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
  while (version <= 40 && need(version) > dataCodewords(version) * 8) version += 1;
  if (version > 40) throw new RangeError("too much data for one QR code");
  const capacity = dataCodewords(version) * 8, bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0; bits.length < capacity; pad += 1) put(pad % 2 ? 0x11 : 0xec, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const { ec, groups } = blocksOf(version), blocks = [];
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
export const formatBits = (mask) => { const data = (0b00 << 3) | mask; return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412; };
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

function place(version, words, mask) {
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
  const f = formatBits(mask);
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

/** The modules of the QR code for `text` (UTF-8 bytes), `mask` chosen by penalty unless given. */
export function qrMatrix(text, forcedMask = null) {
  const { version, out } = codewords(new TextEncoder().encode(text));
  if (forcedMask !== null) return { version, mask: forcedMask, modules: place(version, out, forcedMask) };
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) { const modules = place(version, out, mask), score = penalty(modules); if (!best || score < best.score) best = { version, mask, modules, score }; }
  return { version: best.version, mask: best.mask, modules: best.modules };
}

/** Half blocks, black on white, a four-module quiet zone. `color` false gives the plain characters (dark = block). */
export function renderQr(modules, { color = true } = {}) {
  const quiet = 4, size = modules.length + quiet * 2;
  const dark = (r, c) => { const rr = r - quiet, cc = c - quiet; return rr >= 0 && cc >= 0 && rr < modules.length && cc < modules.length && modules[rr][cc]; };
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c += 1) { const top = dark(r, c), bottom = r + 1 < size && dark(r + 1, c); line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "; }
    lines.push(color ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}
