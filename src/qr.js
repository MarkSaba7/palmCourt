// =====================================================================
// QR: a small QR code encoder (byte mode, error correction level M, versions 1-20), so the phone link
// never depends on a script from the internet. Follows ISO/IEC 18004.
// =====================================================================

// Level M: error correction codewords per block, and number of blocks, for versions 1..20.
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
const MAX_VERSION = 20;

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(a, b) {
  let r = 0;
  for (let i = 7; i >= 0; i--) {
    r = (r << 1) ^ ((r >>> 7) * 0x11d);
    r ^= ((b >>> i) & 1) * a;
  }
  return r;
}

// Reed-Solomon generator (x - a^0)(x - a^1)...(x - a^(n-1)), highest power first, leading 1 left out.
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0, root = 1; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gfMul(poly[j], root); }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly.slice(1);
}

function rsRemainder(data, gen) {
  const rem = new Array(gen.length).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < gen.length; i++) rem[i] ^= gfMul(gen[i], f);
  }
  return rem;
}

// Modules left for data and error correction once the fixed patterns are drawn.
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver) => (rawModules(ver) >> 3) - ECC_PER_BLOCK[ver - 1] * NUM_BLOCKS[ver - 1];

function alignPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
  return pos;
}

// Data bits in byte mode, split into blocks with their error correction, then interleaved.
function codewords(bytes, ver) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  const cap = dataCodewords(ver) * 8;
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const raw = rawModules(ver) >> 3, nb = NUM_BLOCKS[ver - 1], ecc = ECC_PER_BLOCK[ver - 1];
  const shortBlocks = nb - (raw % nb), shortLen = Math.floor(raw / nb) - ecc;
  const gen = rsGenerator(ecc), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, (k += shortLen + (i < shortBlocks ? 0 : 1)));
    blocks.push({ d, e: rsRemainder(d, gen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function penalty(m) {
  const n = m.length;
  let score = 0, dark = 0;
  const line = (get) => {
    // Runs of five or more, and patterns that look like a finder (1:1:3:1:1 with four light modules beside;
    // outside the symbol counts as light).
    const light = (i, a, b) => { for (let j = Math.max(a, 0); j < Math.min(b, n); j++) if (get(i, j)) return false; return true; };
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      for (let j = 0; j + 7 <= n; j++) {
        if (get(i, j) && !get(i, j + 1) && get(i, j + 2) && get(i, j + 3) && get(i, j + 4) && !get(i, j + 5) && get(i, j + 6)
          && (light(i, j - 4, j) || light(i, j + 7, j + 11))) score += 40;
      }
    }
  };
  line((i, j) => m[i][j]);
  line((i, j) => m[j][i]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

const QR = {
  // Returns { version, mask, size, modules } with modules[y][x] true for dark, or null if the text is too long.
  // Pass a mask (0-7) to force one; otherwise the one with the lowest penalty is used.
  encode(text, forceMask) {
    const bytes = new TextEncoder().encode(String(text));
    let ver = 1;
    while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > MAX_VERSION) return null;
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = alignPositions(ver), last = al.length - 1;
    for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
      const data = mask;                    // level M is 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);                          // reserves the format areas
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const b = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, b); set(c, a, b);
      }
    }

    // Zigzag up and down the two-module columns from the right, skipping the vertical timing line.
    const cw = codewords(bytes, ver);
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y][x] && k < cw.length * 8) { mod[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }

    const apply = (mask) => {
      const f = MASKS[mask];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) mod[y][x] = !mod[y][x];
    };
    let mask = forceMask;
    if (!(mask >= 0 && mask <= 7)) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        apply(m); drawFormat(m);
        const p = penalty(mod);
        if (p < best) { best = p; mask = m; }
        apply(m);                           // XOR again to undo
      }
    }
    apply(mask); drawFormat(mask);
    return { version: ver, mask, size, modules: mod };
  },
};

export { QR };
