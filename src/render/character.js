// Procedural people: one smooth skinned body built from lofted cross-sections, with clothes as material
// regions (shirt, shorts, socks, shoes, hair). Faces local -z, right is +x, feet on y = 0, about 1.83 m tall.
import * as THREE from 'three';

const REG = ['skin', 'shirt', 'shorts', 'socks', 'shoe', 'sole', 'hair', 'eye', 'band'];
const R = Object.fromEntries(REG.map((r, i) => [r, i]));

// Rest-pose joint positions (metres) for the default 1.83 m build. L joints mirror R across x.
const JOINTS = {
  root: [null, 0, 0, 0],
  hips: ['root', 0, 0.97, 0],
  spine: ['hips', 0, 1.08, 0],
  chest: ['spine', 0, 1.26, 0],
  neck: ['chest', 0, 1.5, 0.005],
  head: ['neck', 0, 1.6, 0],
  clavR: ['chest', 0.03, 1.44, 0], armR: ['clavR', 0.19, 1.455, 0], foreR: ['armR', 0.212, 1.165, 0.005], handR: ['foreR', 0.226, 0.915, 0],
  clavL: ['chest', -0.03, 1.44, 0], armL: ['clavL', -0.19, 1.455, 0], foreL: ['armL', -0.212, 1.165, 0.005], handL: ['foreL', -0.226, 0.915, 0],
  thighR: ['hips', 0.095, 0.955, 0], shinR: ['thighR', 0.1, 0.525, -0.005], footR: ['shinR', 0.1, 0.085, 0.01], toeR: ['footR', 0.1, 0.02, -0.12],
  thighL: ['hips', -0.095, 0.955, 0], shinL: ['thighL', -0.1, 0.525, -0.005], footL: ['shinL', -0.1, 0.085, 0.01], toeL: ['footL', -0.1, 0.02, -0.12],
};
const BONES = Object.keys(JOINTS);
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));

// Per-vertex surface parameters for the detail shader: aPar = (a, b, c, kind). Kind 0 is a loft ring and kind 2
// the shoe (a, b = cos and sin of the angle round the ring, which interpolate without a seam), kind 1 an
// ellipsoid (a, b, c = unit-sphere coordinates). aEdge falls from 1 to 0 toward a shell's open edge (the hairline).
const PAR0 = [0, 0, 0, 0];

class Builder {
  constructor(shape) {
    this.s = shape; this.pos = []; this.idx = []; this.wts = []; this.par = []; this.edge = []; this.tris = REG.map(() => []);
  }
  // Apply body proportions to a rest-pose point (bones use the same scaling).
  fit(x, y, z) {
    const h = this.s.height, w = this.s.width;
    return [x * h * w, y * h, z * h * w];
  }
  vert(x, y, z, w, par = PAR0, edge = 1) {
    const i = this.pos.length / 3;
    const [fx, fy, fz] = this.fit(x, y, z);
    this.pos.push(fx, fy, fz);
    this.par.push(par[0], par[1], par[2], par[3]);
    this.edge.push(edge);
    const ws = w.slice(0, 4).sort((a, b) => b[1] - a[1]);
    const tot = ws.reduce((a, b) => a + b[1], 0) || 1;
    for (let k = 0; k < 4; k++) { this.idx.push(ws[k] ? B[ws[k][0]] : 0); this.wts.push(ws[k] ? ws[k][1] / tot : 0); }
    return i;
  }
  tri(a, b, c, region) { this.tris[R[region]].push(a, b, c); }
  // A horizontal ring (for vertical limbs). rzF: depth toward the front (-z), rzB: toward the back (+z).
  ring(cx, y, cz, rx, rzF, rzB, n, segs, w) {
    const out = [];
    for (let k = 0; k < segs; k++) {
      const th = (k / segs) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / n), ez = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      out.push(this.vert(cx + rx * ex, y, cz + (s > 0 ? rzB : rzF) * ez, w, [c, s, y, 0]));
    }
    out.center = [cx, y, cz];
    return out;
  }
  // Quads between two rings, flipped if needed so faces point outward.
  strip(A, Bq, region) {
    const n = A.length, P = this.pos;
    const p = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const a0 = p(A[0]), b0 = p(Bq[0]), a1 = p(A[1]);
    const nrm = new THREE.Vector3().subVectors(b0, a0).cross(new THREE.Vector3().subVectors(a1, a0));
    const ca = new THREE.Vector3(...this.fit(...A.center));
    const flip = nrm.dot(a0.clone().sub(ca)) < 0;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n, a = A[k], b = Bq[k], c = A[k1], d = Bq[k1];
      if (flip) { this.tri(a, c, b, region); this.tri(c, d, b, region); }
      else { this.tri(a, b, c, region); this.tri(c, b, d, region); }
    }
  }
  cap(A, tip, w, region) {
    const t = this.vert(tip[0], tip[1], tip[2], w), n = A.length, P = this.pos;
    const pv = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const ca = new THREE.Vector3(...this.fit(...A.center)), tp = pv(t);
    const nrm = new THREE.Vector3().subVectors(pv(A[1]), pv(A[0])).cross(new THREE.Vector3().subVectors(tp, pv(A[0])));
    const flip = nrm.dot(tp.clone().sub(ca)) < 0;
    for (let k = 0; k < n; k++) { const k1 = (k + 1) % n; if (flip) this.tri(A[k1], A[k], t, region); else this.tri(A[k], A[k1], t, region); }
  }
  // A loft through a list of sections: [y, rx, rzF, rzB, n, region-of-next-strip, weights, (cx, cz)].
  loft(sections, segs, { cx = 0, cz = 0, path = null, capTop = null, capBottom = null } = {}) {
    const rings = sections.map((s) => {
      let x = cx, z = cz;
      if (path) [x, z] = path(s[0]);
      if (s[7] !== undefined) x = s[7];
      if (s[8] !== undefined) z = s[8];
      const r = this.ring(x, s[0], z, s[1], s[2], s[3], s[4], segs, s[6]);
      r.region = s[5];
      return r;
    });
    for (let i = 0; i < rings.length - 1; i++) this.strip(rings[i], rings[i + 1], rings[i].region);
    // Caps go on the highest / lowest ring, whichever end of the loft that is.
    const first = rings[0], last = rings[rings.length - 1], topRing = first.center[1] >= last.center[1] ? first : last, botRing = topRing === first ? last : first;
    if (capBottom) this.cap(botRing, capBottom.tip, capBottom.w, capBottom.region);
    if (capTop) this.cap(topRing, capTop.tip, capTop.w, capTop.region);
    return rings;
  }
  // Ellipsoid with an optional deformation of local unit coordinates, an optional keep() filter for partial shells
  // and an optional edge() giving the 0..1 distance from the shell's open edge.
  ellipsoid(c, r, lat, lon, w, region, { deform = null, keep = null, edge = null } = {}) {
    const grid = [];
    for (let i = 0; i <= lat; i++) {
      const row = [], v = i / lat, ph = v * Math.PI;
      for (let j = 0; j < lon; j++) {
        const th = (j / lon) * Math.PI * 2;
        let ux = Math.sin(ph) * Math.cos(th), uy = Math.cos(ph), uz = Math.sin(ph) * Math.sin(th);
        let d = [ux * r[0], uy * r[1], uz * r[2]];
        if (deform) d = deform(ux, uy, uz, d);
        const e = edge ? edge([ux, uy, uz]) : 1;
        row.push({ i: this.vert(c[0] + d[0], c[1] + d[1], c[2] + d[2], w, [ux, uy, uz, 1], e), u: [ux, uy, uz] });
      }
      grid.push(row);
    }
    for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
      const j1 = (j + 1) % lon, a = grid[i][j], b = grid[i + 1][j], cc = grid[i][j1], d = grid[i + 1][j1];
      if (keep && !(keep(a.u) && keep(b.u) && keep(cc.u) && keep(d.u))) continue;
      this.tri(a.i, cc.i, b.i, region); this.tri(cc.i, d.i, b.i, region);
    }
  }
  // One geometry, one material: each vertex carries its region's colour and roughness. Vertices on a boundary
  // between regions (hems, cuffs) are split so each side keeps its own colour and the edge stays crisp.
  geometry(colors, roughs, accent, design = 0) {
    const pos = this.pos.slice(), idx = this.idx.slice(), wts = this.wts.slice(), par = this.par.slice(), edge = this.edge.slice();
    const vReg = new Array(pos.length / 3).fill(-1), dup = new Map(), out = [];
    const take = (v, r) => {
      if (vReg[v] === -1 || vReg[v] === r) { vReg[v] = r; return v; }
      const key = v * 16 + r;
      if (dup.has(key)) return dup.get(key);
      const n = pos.length / 3;
      pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      for (let k = 0; k < 4; k++) { idx.push(idx[v * 4 + k]); wts.push(wts[v * 4 + k]); par.push(par[v * 4 + k]); }
      edge.push(edge[v]);
      vReg.push(r); dup.set(key, n);
      return n;
    };
    this.tris.forEach((t, r) => { for (let i = 0; i < t.length; i++) out.push(take(t[i], r)); });
    const nv = vReg.length, col = new Float32Array(nv * 3), rough = new Float32Array(nv), reg = new Float32Array(nv), acc = new Float32Array(nv * 4);
    const c = new THREE.Color(), a = new THREE.Color(accent);
    vReg.forEach((r, i) => {
      c.set(colors[Math.max(0, r)]); col.set([c.r, c.g, c.b], i * 3); rough[i] = roughs[Math.max(0, r)];
      reg[i] = Math.max(0, r); acc.set([a.r, a.g, a.b, design], i * 4);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(rough, 1));
    g.setAttribute('aReg', new THREE.Float32BufferAttribute(reg, 1));
    g.setAttribute('aPar', new THREE.Float32BufferAttribute(par, 4));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    g.setAttribute('aAccent', new THREE.Float32BufferAttribute(acc, 4));   // rgb + shirt design
    g.setIndex(out);
    g.computeVertexNormals();
    return g;
  }
}

const mix2 = (a, b, t) => [[a, 1 - t], [b, t]];
function torsoWeights(y) {
  if (y <= 0.97) return [['hips', 1]];
  if (y < 1.12) return mix2('hips', 'spine', (y - 0.97) / 0.15);
  if (y < 1.28) return mix2('spine', 'chest', (y - 1.12) / 0.16);
  return [['chest', 1]];
}

// ---- head: face, ears, eyes, brows, hair, facial hair, headwear ----
// look.hair: 'short' | 'buzz' | 'bald' | 'ponytail' | 'crop' | 'wavy' | 'long' | 'curly' | 'textured'
// look.headwear: 'none' | 'headband' | 'bandana' | 'cap' (absent: the old look.headband boolean)
// look.beard: 0 clean-shaven .. 0.3 stubble .. 1 short full beard; look.face: { jaw, cheek, nose, brow, chin, eyes }
// multipliers around 1; look.eyeColor (optional).
const HC = [0, 1.708, -0.006], HR = [0.08, 0.112, 0.099];   // head centre (note the 6 mm z offset) and radii
const FACE0 = { jaw: 1, cheek: 1, nose: 1, brow: 1, chin: 1, eyes: 1 };
const gs = (a, w) => Math.exp(-((a / w) ** 2));
const sst = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);   // 0 below a, 1 above b (a < b)

// The head's surface from unit-sphere coordinates (front is -z): skull, jaw and the face's features. Hair, beard,
// brows and headwear are all laid on this same surface, so nothing pokes through.
function headShape(ux, uy, uz, d, F = FACE0) {
  let [x, y, z] = d;
  const f = Math.max(0, -uz), ax = Math.abs(ux);
  const fa = Math.max(0, -uz / Math.max(1e-4, Math.hypot(ux, uz)));   // faces forward, however high or low
  if (uy > 0.1 && uz > 0) z += 0.008 * uy;                                                    // back of the skull
  if (uy < 0) {                                                                                // jaw and lower face
    const t = -uy, j = 2 - F.jaw;
    x *= 1 - 0.1 * j * t - 0.45 * j * Math.max(0, t - 0.55) ** 1.5 - 0.06 * fa * fa * t * t;  // square angle, in to the chin
    z -= (0.003 + 0.008 * sst(t, 0.25, 0.6) + 0.009 * F.chin * sst(t, 0.6, 0.9)) * fa * fa;  // mouth and chin under the nose
    x *= 1 + 0.12 * sst(t, 0.6, 0.95) * (1 - fa);                                             // jaw's lower border, not a point
    y += 0.008 * sst(t, 0.85, 1) - 0.005 * (F.chin - 1) * sst(t, 0.7, 0.95) * fa;           // flatter underneath
  }
  const N = F.nose * f;                                                                        // nose: bridge, tip, wings
  z -= N * (0.0035 + 0.016 * sst(-uy, -0.1, 0.25)) * (1 - sst(-uy, 0.3, 0.41)) * gs(ux, 0.055 + 0.06 * sst(-uy, 0, 0.3));
  z -= N * 0.005 * gs(ux, 0.1) * gs(uy + 0.27, 0.06);
  z -= N * 0.006 * gs(ax - 0.16, 0.07) * gs(uy + 0.32, 0.055);
  x *= 1 + 0.12 * (F.nose - 1) * gs(ax - 0.16, 0.1) * gs(uy + 0.3, 0.08) * f;
  z -= 0.0075 * F.brow * gs(uy - 0.22, 0.075) * gs(ux, 0.5) * f;                             // brow ridge
  z += 0.009 * gs(ax - 0.38, 0.14) * gs(uy - 0.07, 0.1) * f;                                 // eye sockets
  x *= 1 + 0.02 * F.cheek * gs(uy + 0.08, 0.16) * f;                                         // cheekbones
  z -= 0.004 * F.cheek * gs(ax - 0.5, 0.16) * gs(uy + 0.12, 0.12) * f;
  z += 0.0025 * gs(ax - 0.56, 0.12) * gs(uy + 0.42, 0.12) * f;                               // under the cheekbone
  z -= 0.0035 * gs(ux, 0.24) * gs(uy + 0.5, 0.045) * fa;                                     // upper lip
  z -= 0.004 * gs(ux, 0.22) * gs(uy + 0.6, 0.045) * fa;                                      // lower lip
  z += 0.002 * gs(ax - 0.3, 0.05) * gs(uy + 0.55, 0.05) * fa;                                // mouth corners
  z += 0.002 * gs(ux, 0.25) * gs(uy + 0.7, 0.04) * fa;                                       // fold under the lip
  z -= 0.006 * F.chin * gs(ux, 0.26) * gs(uy + 0.82, 0.09) * fa;                             // chin
  return [x, y, z];
}

// A point on the head (rest pose) at unit-sphere coordinates u, pushed out by `off` metres.
function headAt(u, F, off = 0) {
  const [x, y, z] = headShape(u[0], u[1], u[2], [u[0] * HR[0], u[1] * HR[1], u[2] * HR[2]], F);
  const k = 1 + off / Math.hypot(x, y, z);
  return [HC[0] + x * k, HC[1] + y * k, HC[2] + z * k];
}
// Unit-sphere coordinates at polar angle ph (0 = crown) and azimuth a (0 = front, +π/2 = the figure's right, +x).
const unitAt = (ph, a) => [Math.sin(ph) * Math.sin(a), Math.cos(ph), -Math.sin(ph) * Math.cos(a)];
// ... and at a height on the head (rest-pose y) instead of a polar angle.
const unitAtY = (y, a) => { const uy = THREE.MathUtils.clamp((y - HC[1]) / HR[1], -1, 1), r = Math.sqrt(1 - uy * uy); return [r * Math.sin(a), uy, -r * Math.cos(a)]; };

// A rows × cols grid of optional vertices (columns wrap round unless open) turned into quads wherever all four
// corners exist; only vertices a quad uses are created. at(i, j) gives [x, y, z, weights, par, edge] or null.
// Rows running down an outward surface with columns running toward +x at the front face outward; `inside(i)` (a
// point inside the shape at row i) makes it check and flip instead.
function grid(bld, rows, cols, at, region, { wrap = true, inside = null } = {}) {
  const V = [], jn = wrap ? cols : cols - 1;
  for (let i = 0; i < rows; i++) { const r = []; for (let j = 0; j < cols; j++) r.push(at(i, j)); V.push(r); }
  const quads = [];
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < jn; j++) {
    const j1 = (j + 1) % cols;
    if (V[i][j] && V[i + 1][j] && V[i][j1] && V[i + 1][j1]) quads.push([i, j, j1]);
  }
  let flip = false;
  if (inside && quads.length) {
    const [i, j, j1] = quads[Math.floor(quads.length / 2)], a = V[i][j], b = V[i + 1][j], c = V[i][j1], o = inside(i);
    const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], e2 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    flip = n[0] * (a[0] - o[0]) + n[1] * (a[1] - o[1]) + n[2] * (a[2] - o[2]) < 0;
  }
  const I = V.map((r) => r.map(() => -1));
  const vi = (i, j) => { if (I[i][j] < 0) { const v = V[i][j]; I[i][j] = bld.vert(v[0], v[1], v[2], v[3], v[4], v[5]); } return I[i][j]; };
  for (const [i, j, j1] of quads) {
    const a = vi(i, j), b = vi(i + 1, j), c = vi(i, j1), d = vi(i + 1, j1);
    if (flip) { bld.tri(a, b, c, region); bld.tri(c, b, d, region); } else { bld.tri(a, c, b, region); bld.tri(c, d, b, region); }
  }
}

// Piecewise curve through [x, y] points (x ascending), eased between them.
function curve(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], t = (x - x0) / (x1 - x0);
    return y0 + (y1 - y0) * t * t * (3 - 2 * t);
  }
  return pts[pts.length - 1][1];
}
function hash3(x, y, z) {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Nearest point of a jittered 3D lattice (cellular noise): its distance and the cell's random id. Makes curl clumps.
function cells(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let d1 = 9, id = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const cx = ix + a, cy = iy + b, cz = iz + c;
    const d = Math.hypot(cx + hash3(cx, cy, cz) - x, cy + hash3(cx + 31, cy, cz) - y, cz + hash3(cx, cy + 57, cz) - z);
    if (d < d1) { d1 = d; id = hash3(cx, cy, cz + 91); }
  }
  return [d1, id];
}

// Hair styles. hl: the hairline, as the lowest head-unit height with hair by angle from the front (0..π); soft: its
// fade width; top/side/back: thickness in metres; lift: extra at the front of the top.
const HL = [[0, 0.7], [0.35, 0.72], [0.7, 0.6], [0.95, 0.4], [1.12, 0.18], [1.27, -0.1], [1.42, -0.12], [1.52, 0.18], [1.92, 0.22], [2.15, -0.08], [2.55, -0.36], [Math.PI, -0.46]];
const HAIR = {
  short: { hl: HL, soft: 0.12, top: 0.013, side: 0.006, back: 0.008, lift: 0.005 },
  buzz: { hl: HL, soft: 0.07, top: 0.003, side: 0.0025, back: 0.0025, lift: 0 },
  ponytail: { hl: [[0, 0.66], [0.6, 0.62], [1.0, 0.36], [1.3, 0.06], [1.45, 0.1], [1.52, 0.2], [1.92, 0.2], [2.2, -0.12], [2.6, -0.42], [Math.PI, -0.5]], soft: 0.14, top: 0.007, side: 0.0045, back: 0.006, lift: 0 },
  crop: { hl: [[0, 0.72], [0.35, 0.74], [0.7, 0.68], [0.95, 0.5], [1.12, 0.2], [1.27, -0.04], [1.42, -0.06], [1.52, 0.18], [1.92, 0.22], [2.15, -0.1], [2.55, -0.38], [Math.PI, -0.48]], soft: 0.1, top: 0.022, side: 0.004, back: 0.0045, lift: 0.01 },
  textured: { hl: [[0, 0.64], [0.35, 0.67], [0.7, 0.6], [0.95, 0.42], [1.12, 0.18], [1.27, -0.08], [1.42, -0.1], [1.52, 0.18], [1.92, 0.22], [2.15, -0.1], [2.55, -0.38], [Math.PI, -0.48]], soft: 0.08, top: 0.026, side: 0.005, back: 0.007, lift: 0.012 },
  curly: { hl: [[0, 0.6], [0.35, 0.62], [0.7, 0.55], [0.95, 0.38], [1.12, 0.18], [1.27, -0.06], [1.42, -0.08], [1.52, 0.2], [1.92, 0.24], [2.15, -0.1], [2.55, -0.4], [Math.PI, -0.5]], soft: 0.08, top: 0.033, side: 0.013, back: 0.018, lift: 0.003 },
  wavy: { hl: [[0, 0.7], [0.35, 0.72], [0.7, 0.6], [0.95, 0.4], [1.12, 0.16], [1.27, -0.12], [1.42, -0.14], [1.52, -0.04], [1.92, -0.02], [2.15, -0.2], [2.55, -0.48], [Math.PI, -0.6]], soft: 0.11, top: 0.026, side: 0.016, back: 0.02, lift: 0.008 },
  long: { hl: [[0, 0.7], [0.35, 0.72], [0.7, 0.6], [0.95, 0.4], [1.08, 0.12], [1.2, -0.3], [Math.PI, -0.3]], soft: 0.11, top: 0.017, side: 0.018, back: 0.018, lift: 0.002 },
};

// Headband / bandana: bottom and top edge heights at the front and at the back (they sit tilted, low on the
// occiput); the cap's lower edge likewise.
const BAND = { headband: [[1.761, 1.793], [1.737, 1.769]], bandana: [[1.748, 1.801], [1.722, 1.768]] };
const CAP = [1.767, 1.735];
const bandAt = (kind, a) => { const B = BAND[kind], k = (1 - Math.cos(a)) / 2; return [B[0][0] + (B[1][0] - B[0][0]) * k, B[0][1] + (B[1][1] - B[0][1]) * k]; };
const capAt = (a) => CAP[0] + (CAP[1] - CAP[0]) * (1 - Math.cos(a)) / 2;

// How dark a hair colour is (0 fair .. 1 black): stubble on fair hair barely shows.
function hairDark(hex) {
  const c = new THREE.Color(hex ?? 0x2b1d14), l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return 1 - Math.min(0.85, Math.sqrt(l) * 1.6);
}
// Where a beard grows (0..1) by head-unit coordinates: jaw and cheeks below a line from the sideburn to the mouth
// corner, the upper lip, the chin and under the jaw; never the lips.
function beardZone(u) {
  const [ux, uy, uz] = u, ax = Math.abs(ux), a = Math.atan2(ax, -uz);
  if (uy > 0.05) return 0;
  const band = (x, lo, hi, w) => sst(x, lo - w, lo) * (1 - sst(x, hi, hi + w)), front = sst(-uz, 0.6, 0.8);
  const back = 1.48 + 0.25 * sst(-uy, 0.35, 0.6);
  let d = sst(curve([[0.35, -0.46], [1.3, -0.1]], a) - uy, -0.01, 0.08) * (1 - sst(a, back, back + 0.14));
  d = Math.max(d, band(uy, -0.49, -0.39, 0.03) * (1 - sst(ax, 0.26, 0.36)) * front);   // moustache
  return d * (1 - band(uy, -0.61, -0.5, 0.015) * (1 - sst(ax, 0.25, 0.33)) * front);   // lips stay clear
}
// How much hair thickness the headwear leaves at a point on the head (rest-pose height y, angle a): pressed flat
// under a band or cap, bulging back out above and below it.
function hairPress(wear, y, a) {
  if (wear === 'headband' || wear === 'bandana') {
    const [b, t] = bandAt(wear, a);
    return 0.0024 + (y > t ? 1.3 * (y - t) : 1.2 * Math.max(0, b - y));
  }
  if (wear === 'cap') { const c = capAt(a) - 0.004; return 0.0045 + 1.2 * Math.max(0, c - y); }
  return Infinity;
}

function buildHead(bld, look) {
  const F = { ...FACE0, ...(look.face || {}) }, H = [['head', 1]];
  const style = look.hair === 'bald' ? 'bald' : HAIR[look.hair] ? look.hair : 'short';
  const wear = ['none', 'headband', 'bandana', 'cap'].includes(look.headwear) ? look.headwear : look.headband ? 'headband' : 'none';
  const beard = THREE.MathUtils.clamp(+look.beard || 0, 0, 1);
  bld.loft([
    [1.47, 0.064, 0.063, 0.063, 2, 'skin', [['chest', 0.6], ['neck', 0.4]], 0, 0.01],
    [1.53, 0.062, 0.06, 0.06, 2, 'skin', [['neck', 1]], 0, 0.01],
    [1.585, 0.062, 0.06, 0.059, 2, 'skin', [['neck', 0.5], ['head', 0.5]], 0, 0.008],
    [1.64, 0.054, 0.05, 0.05, 2, 'skin', [['head', 1]], 0, 0.004],
  ], 16);
  // Skull and face: rows and columns bunch up on the face. aEdge carries the stubble shadow (1 = none) for the shader.
  const LAT = 44, LON = 60, stub = beard * hairDark(look.hairColor);
  const phW = (v) => Math.PI * v + 0.2 * (Math.sin(2 * Math.PI * (v - 0.05)) + Math.sin(2 * Math.PI * 0.05));
  const aW = (j) => { const s = 2 * j / LON - 1; return Math.PI * s - 0.4 * Math.sin(Math.PI * s); };
  grid(bld, LAT + 1, LON, (i, j) => {
    const u = unitAt(phW(i / LAT), aW(j));
    return [...headAt(u, F), H, [u[0], u[1], u[2], 1], 1 - stub * beardZone(u)];
  }, 'skin');
  for (const s of [-1, 1]) {
    // ear: a thin shell tilted back, hollowed on the outside, its back edge standing off the head
    grid(bld, 8, 12, (i, j) => {
      const ph = Math.PI * i / 7, th = 2 * Math.PI * j / 12, ux = Math.sin(ph) * Math.cos(th), uy = Math.cos(ph), uz = Math.sin(ph) * Math.sin(th);
      let x = ux * 0.0105, y = uy * 0.03, z = uz * 0.018;
      if (ux * s > 0) x -= s * 0.007 * Math.max(0, 1 - (uy / 0.75) ** 2 - (uz / 0.75) ** 2);
      x += s * 0.005 * (uz + 1) / 2;
      const c = Math.cos(0.22), sn = Math.sin(0.22);
      [y, z] = [y * c - z * sn, y * sn + z * c];
      return [s * 0.077 + x, 1.699 + y, 0.01 + z, H, PAR0, 1];
    }, 'skin');
    // eye: set into the socket; its detail coordinates are stretched so the shader's iris comes out a real size
    const ex = s * 0.032, ey = 1.7136, ue = [ex / HR[0], (ey - HC[1]) / HR[1], 0];
    ue[2] = -Math.sqrt(1 - ue[0] ** 2 - ue[1] ** 2);
    const ez = headAt(ue, F)[2] + 0.002, er = [0.0122 * F.eyes, 0.0068 * F.eyes, 0.0066];
    const eyeU = (i, j, n, m) => { const ph = Math.PI * i / n, th = 2 * Math.PI * j / m; return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)]; };
    grid(bld, 9, 14, (i, j) => { const [ux, uy, uz] = eyeU(i, j, 8, 14); return [ex + ux * er[0], ey + uy * er[1], ez + uz * er[2], H, [ux * 1.3, uy * 1.08, uz, 1], 1]; }, 'eye');
    // upper lid: a skin hood over the top of the eye, its rim resting on the eyeball
    grid(bld, 5, 8, (i, j) => {
      const ph = 1.42 * i / 4, th = Math.PI + Math.PI * j / 7, ux = Math.sin(ph) * Math.cos(th), uy = Math.cos(ph), uz = Math.sin(ph) * Math.sin(th);
      const k = 1.08 + 0.18 * (1 - i / 4);
      return [ex + ux * er[0] * (k + 0.05), ey + 0.0006 + uy * er[1] * (k + 0.12), ez + uz * er[2] * k, H, PAR0, 1];
    }, 'skin', { wrap: false });
    // brow: a curved strip on the brow ridge, thick at the inner end and tapering out, soft at both ends
    grid(bld, 5, 9, (i, j) => {
      const k = j / 8, v = i / 2 - 1, ux = s * (0.1 + 0.5 * k);
      const uy = 0.205 + 0.04 * Math.sin(Math.PI * Math.pow(k, 0.75)) - 0.03 * k + v * (0.035 - 0.02 * k) * (0.8 + 0.2 * F.brow);
      const u = [ux, uy, -Math.sqrt(Math.max(0, 1 - ux * ux - uy * uy))];
      const edge = sst(k, 0, 0.12) * (1 - sst(k, 0.8, 1)) * (1 - 0.7 * Math.abs(v) ** 2);
      return [...headAt(u, F, 0.0011 + (1 - v * v) * (0.0009 + 0.001 * (1 - k)) * F.brow), H, [u[0], u[1], u[2], 1], edge];
    }, 'hair', { wrap: false, inside: () => HC });
  }
  // Full beard: a hair shell over the stubble shadow, on the same grid as the face so it sits parallel to it.
  if (beard > 0.4) {
    const bk = (beard - 0.4) / 0.6;
    grid(bld, LAT + 1, LON, (i, j) => {
      if (i < LAT * 0.4) return null;
      const u = unitAt(phW(i / LAT), aW(j)), d = beardZone(u);
      if (d < 0.02) return null;
      const chin = gs(u[0], 0.35) * sst(-u[1], 0.6, 0.85);
      return [...headAt(u, F, 0.0016 + bk * (0.0045 + 0.003 * chin) * Math.pow(d, 0.7)), H, [u[0], u[1], u[2], 1], d];
    }, 'hair');
  }
  if (style !== 'bald') buildHair(bld, look, F, style, wear, H);
  if (wear !== 'none') buildHeadwear(bld, F, wear, H);
}

// Hair: one shell over the skull that thickens from nothing at a soft hairline (its edge tucks under the skin, so
// the boundary is a smooth curve, and the shader dithers it out), shaped per style; long hair carries on below the
// skull as a curtain that folds back up inside itself, so it is a closed volume from every side.
function buildHair(bld, look, F, style, wear, H) {
  const S = HAIR[style], long = style === 'long', curly = style === 'curly', tex = style === 'textured', wavy = style === 'wavy';
  const rows = curly ? 42 : long || wavy || tex ? 38 : 34, cols = curly ? 84 : long || wavy || tex ? 72 : 64;
  const low = Math.min(...S.hl.map((p) => p[1])) - 0.08;
  const phMax = long ? Math.PI / 2 + 0.12 : Math.acos(Math.max(-0.97, low));
  const nC = long ? 12 : 0, nI = long ? 6 : 0;
  const aOf = (j) => { const s = 2 * j / cols - 1; return Math.PI * s - 0.2 * Math.sin(Math.PI * s); };
  const skull = (ph, a) => {
    const u = unitAt(ph, a), [ux, uy, uz] = u, aa = Math.abs(a);
    const m = uy - curve(S.hl, aa), e = sst(m, 0, S.soft);
    if (m < -0.25) return null;
    const topW = sst(uy, 0.15, 0.8), backW = sst(uz, 0.15, 0.7) * (1 - topW), sideW = 1 - topW - backW;
    let side = S.side;
    if (style === 'crop') side *= 0.35 + 0.65 * sst(uy, -0.3, 0.35);   // tapered short back and sides
    let t = S.top * topW + side * sideW + S.back * backW + S.lift * sst(-uz, 0.2, 0.75) * sst(uy, 0.35, 0.75);
    if (!long && !wavy) t *= 1 - 0.4 * gs(aa - 1.72, 0.25) * (1 - sst(uy, 0.25, 0.5));   // flat over the ears
    let par = [ux, uy, uz, 1];
    if (style === 'crop') t += 0.005 * topW * Math.max(0, 1 - cells(ux / 0.3, uy / 0.3, uz / 0.3)[0] / 0.7);
    if (tex) {   // messy tufts on top
      const [cd, id] = cells(ux / 0.26 + 3, uy / 0.26, uz / 0.26);
      t += topW * 0.016 * (0.5 + id) * Math.max(0, 1 - cd / 0.75) ** 1.5;
      par = [ux * Math.cos(id * 3) - uz * Math.sin(id * 3), uy, ux * Math.sin(id * 3) + uz * Math.cos(id * 3), 1];
    }
    if (curly) {   // clumps of curls, with a finer set on top of them
      const [c1, id] = cells(ux / 0.2, uy / 0.2, uz / 0.2), [c2] = cells(ux / 0.11 + 7, uy / 0.11, uz / 0.11);
      t += (0.008 * topW + 0.0055 * (1 - topW)) * Math.sqrt(Math.max(0, 1 - (c1 / 0.8) ** 2)) + 0.0025 * Math.max(0, 1 - (c2 / 0.8) ** 2);
      par = [ux * Math.cos(id * 6) - uz * Math.sin(id * 6), uy + 0.3 * (id - 0.5), ux * Math.sin(id * 6) + uz * Math.cos(id * 6), 1];
    }
    if (wavy) {   // side part, swept over to the other side and back, in loose waves
      t *= 1 - 0.4 * gs(ux + 0.32, 0.09) * sst(uy, 0.5, 0.8);
      t += 0.004 * topW * sst(ux, -0.3, 0.5) + 0.0035 * Math.sin((uz * HR[2]) / 0.034 * 2 * Math.PI + ux * 3) * (0.4 + 0.6 * topW);
      const c = Math.cos(0.35), sn = Math.sin(0.35);   // strands run from the front hairline back, tilted off the part
      par = [ux * c + uy * sn, -uz, -ux * sn + uy * c, 1];
    }
    t = m < 0 ? Math.max(-0.0025, 0.0016 + m * 0.07) : Math.min(0.0016 + e * t, hairPress(wear, HC[1] + uy * HR[1], a));
    return { p: headAt(u, F, t), t, e: THREE.MathUtils.clamp(m / S.soft, -1, 1), par };   // signed, so the shader finds the true edge
  };
  const last = new Map();   // long hair: the skull rim each curtain column hangs from
  const rim = (j) => { if (!last.has(j)) last.set(j, skull(phMax, aOf(j))); return last.get(j); };
  const curtain = (j, s, inset) => {
    const a = aOf(j), aa = Math.abs(a), r = rim(j);
    if (!r || aa < 1.2) return null;
    const open = sst(aa, 1.2, 1.6), h = [Math.sin(a), 0, -Math.cos(a)];
    const tip = 1.612 - 0.064 * sst(aa, 1.25, 2.9) + 0.008 * Math.sin(7 * a) + 0.005 * Math.sin(13 * a + 1);
    const y = r.p[1] - (r.p[1] - tip) * s;
    let out = -0.006 * Math.sin(Math.PI * s) + 0.008 * s * s - 0.018 * s * sst(aa, 2.0, 2.8) + 0.003 * Math.sin(3 * Math.PI * s + 5 * a);
    out -= inset * open;
    const nk = Math.min(0.5, Math.max(0, (1.66 - y) / 0.12) * 0.5);
    const w = nk > 0 ? [['head', 1 - nk], ['neck', nk]] : H;
    return [r.p[0] + h[0] * out, y, r.p[2] + h[2] * out, w, [Math.sin(a) * 0.99, Math.cos(phMax) - 0.8 * s, -Math.cos(a) * 0.99, 1], 0.3 + 0.7 * sst(aa, 1.2, 1.4)];
  };
  grid(bld, rows + nC + nI, cols, (i, j) => {
    if (i < rows) { const v = skull(phMax * i / (rows - 1), aOf(j)); return v && [...v.p, H, v.par, v.e]; }
    if (i < rows + nC) return curtain(j, (i - rows + 1) / nC, 0);
    const q = (i - rows - nC + 1) / nI;   // back up the inside, from the tips to inside the skull
    return curtain(j, 1 - q, 0.03 * sst(q, 0, 0.35));
  }, 'hair');
  if (style === 'ponytail') {
    bld.loft([
      [1.73, 0.03, 0.025, 0.025, 2, 'hair', [['head', 1]], 0, 0.1],
      [1.66, 0.034, 0.028, 0.028, 2, 'hair', [['head', 1]], 0, 0.125],
      [1.57, 0.026, 0.022, 0.022, 2, 'hair', [['head', 0.6], ['neck', 0.4]], 0, 0.135],
      [1.5, 0.012, 0.01, 0.01, 2, 'hair', [['neck', 1]], 0, 0.13],
    ], 10);
  }
}

// Headwear in the band colour: a headband, a folded bandana knotted at the back with two tails, or a cap.
function buildHeadwear(bld, F, wear, H) {
  if (wear === 'headband' || wear === 'bandana') {
    const n = 64, bandana = wear === 'bandana', off = 0.0027, th = bandana ? 0.0045 : 0.0035;
    // cross-section loop: inner top, top, outer top, outer bottom, bottom, inner bottom (and back to the start)
    const prof = [[1, 0, -0.0006], [1, 0.5, 0.0007], [1, 1, -0.0008], [0, 1, 0.0008], [0, 0.5, -0.0007], [0, 0, 0.0006]];
    grid(bld, prof.length + 1, n, (i, j) => {
      const [top, o, dy] = prof[i % prof.length], a = -Math.PI + 2 * Math.PI * j / n, [b, t] = bandAt(wear, a), y = (top ? t : b) + dy;
      const lump = bandana ? 0.001 * Math.sin(9 * a + 4 * top) * o : 0;   // a folded cloth is never quite even
      return [...headAt(unitAtY(y, a), F, off + o * th + lump), H, [Math.cos(a), Math.sin(a), y, 0], 1];
    }, 'band');
    if (bandana) {
      const [b, t] = bandAt(wear, Math.PI), kn = headAt(unitAtY((b + t) / 2, Math.PI), F, off + th + 0.007);
      bld.ellipsoid(kn, [0.016, 0.013, 0.011], 6, 10, H, 'band', { deform: (ux, uy, uz, d) => [d[0] * (1 + 0.15 * Math.sin(5 * uy)), d[1], d[2] * (1 + 0.2 * ux * ux)] });
      for (const sd of [-1, 1]) {   // two tails hanging from the knot, twisting and flaring a little
        const L = 0.13, w = 0.034;
        const at = (s, c) => {
          const tw = sd * (0.25 + 0.45 * s), cx = kn[0] + sd * (0.006 + 0.02 * s), cy = kn[1] - 0.006 - L * s * (c === 1 || c === 2 ? 1 : 0.86);
          const cz = kn[2] + 0.004 + 0.022 * s + 0.006 * Math.sin(Math.PI * s);
          const across = (c === 0 || c === 3 ? -0.5 : 0.5) * sd * (w - 0.006 * s), depth = c < 2 ? -0.001 : 0.001;
          return [cx + across * Math.cos(tw) - depth * Math.sin(tw), cy, cz + across * Math.sin(tw) + depth * Math.cos(tw)];
        };
        grid(bld, 9, 4, (i, j) => {
          const s = i / 8, p = at(s, j), nk = 0.35 * s;
          return [...p, [['head', 1 - nk], ['neck', nk]], [0, 0, p[1], 0], 1];
        }, 'band', { inside: (i) => at(i / 8, 0).map((v, k) => (v + at(i / 8, 2)[k]) / 2) });
      }
    }
  } else if (wear === 'cap') {
    const n = 64, off = 0.0085, R = 14;
    // crown: from the button down to the band, the front panels standing up a little; the edge rolls in onto the hair
    grid(bld, R + 2, n, (i, j) => {
      const a = -Math.PI + 2 * Math.PI * j / n, phc = Math.acos((capAt(a) - HC[1]) / HR[1]), s = Math.min(i, R) / R;
      const u = unitAt(phc * s + (i > R ? 0.03 : 0), a);
      const o = i > R ? 0.004 : off + 0.006 * (1 - s) ** 2 + 0.008 * Math.max(0, -u[2]) * (1 - s) * s;
      return [...headAt(u, F, o), H, [Math.cos(a), Math.sin(a), 0, 0], 1];
    }, 'band');
    const top = headAt([0, 1, 0], F, off + 0.006);
    bld.ellipsoid([top[0], top[1] + 0.001, top[2]], [0.006, 0.003, 0.006], 4, 8, H, 'band');
    // brim: forward over the brow, curving down at the sides; top surface out to the edge, underside back
    const BR = 8, BC = 25, aMax = 1.12;
    grid(bld, 2 * BR + 2, BC, (i, j) => {
      const q = (j / (BC - 1)) * 2 - 1, a = q * aMax, base = headAt(unitAtY(capAt(a), a), F, off + 0.001);
      const s = i <= BR ? i / BR : (2 * BR + 1 - i) / BR, L = 0.072 * Math.sqrt(Math.max(0, 1 - q * q)), d = L * s;
      const dir = [Math.sin(a) * 0.55, -Math.cos(a)], dl = Math.hypot(dir[0], dir[1]);
      const under = i > BR ? 0.0035 * Math.sqrt(Math.max(0, 1 - q ** 4)) : 0;
      return [base[0] + dir[0] / dl * d, base[1] - 0.2 * d - 0.16 * q * q * d - under, base[2] + dir[1] / dl * d, H, [q, s, 0, 0], 1];
    }, 'band', { wrap: false });
  }
}

function buildBody(bld, look) {
  const sh = look.sleeve;   // sleeve length in metres below the shoulder
  // ---- torso (upward) ----
  const tors = [
    [0.865, 0.105, 0.085, 0.085, 2.0, 'shorts'],
    [0.9, 0.15, 0.1, 0.105, 2.2, 'shorts'],
    [0.955, 0.172, 0.105, 0.125, 2.4, 'shorts'],
    [1.02, 0.168, 0.1, 0.115, 2.4, 'shorts'],
    [1.06, 0.161, 0.098, 0.106, 2.4, 'shirt'],
    [1.06, 0.166, 0.103, 0.111, 2.4, 'shirt'],
    [1.12, 0.155, 0.102, 0.102, 2.4, 'shirt'],
    [1.2, 0.162, 0.112, 0.102, 2.4, 'shirt'],
    [1.29, 0.178 * look.chest, 0.127, 0.107, 2.5, 'shirt'],
    [1.37, 0.19 * look.chest, 0.13, 0.11, 2.7, 'shirt'],
    [1.43, 0.194, 0.117, 0.107, 2.9, 'shirt'],
    [1.475, 0.157, 0.092, 0.092, 2.6, 'shirt'],
    [1.505, 0.084, 0.072, 0.072, 2.0, 'shirt'],
  ].map((s) => [...s, torsoWeights(s[0])]);
  bld.loft(tors, 28, { capBottom: { tip: [0, 0.85, 0], w: [['hips', 1]], region: 'shorts' } });
  // collar
  bld.loft([[1.495, 0.086, 0.074, 0.074, 2.0, 'shirt', [['chest', 1]]], [1.525, 0.074, 0.064, 0.064, 2.0, 'shirt', [['chest', 0.6], ['neck', 0.4]]]], 24);
  // ---- neck & head ----
  buildHead(bld, look);
  // ---- arms (downward from the shoulder) ----
  for (const s of [-1, 1]) {
    const S = s > 0 ? 'R' : 'L', arm = 'arm' + S, fore = 'fore' + S, hand = 'hand' + S, clav = 'clav' + S;
    const px = (y) => s * (y > 1.165 ? THREE.MathUtils.lerp(0.212, 0.19, (y - 1.165) / 0.29) : THREE.MathUtils.lerp(0.226, 0.212, (y - 0.915) / 0.25));
    const hem = 1.455 - sh;
    const arms = [
      [1.477, 0.047, 0.05, 0.05, 2, 'shirt', [[arm, 0.6], [clav, 0.4]]],
      [1.445, 0.057, 0.057, 0.057, 2, 'shirt', [[arm, 0.8], [clav, 0.2]]],
      [1.395, 0.056, 0.055, 0.055, 2, 'shirt', [[arm, 1]]],
      [hem, 0.054, 0.054, 0.054, 2, 'shirt', [[arm, 1]]],
      [hem, 0.047, 0.047, 0.047, 2, 'skin', [[arm, 1]]],
      [1.27, 0.046, 0.049, 0.046, 2, 'skin', [[arm, 1]]],
      [1.21, 0.041, 0.041, 0.041, 2, 'skin', [[arm, 0.85], [fore, 0.15]]],
      [1.165, 0.037, 0.037, 0.038, 2, 'skin', [[arm, 0.5], [fore, 0.5]]],
      [1.12, 0.04, 0.038, 0.039, 2, 'skin', [[arm, 0.15], [fore, 0.85]]],
      [1.07, 0.041, 0.037, 0.038, 2, 'skin', [[fore, 1]]],
      [1.0, 0.035, 0.03, 0.031, 2.2, 'skin', [[fore, 1]]],
    ];
    if (look.wristband) arms.push([0.985, 0.036, 0.032, 0.033, 2.2, 'band', [[fore, 1]]], [0.95, 0.034, 0.029, 0.03, 2.2, 'skin', [[fore, 0.8], [hand, 0.2]]]);
    arms.push([0.945, 0.029, 0.023, 0.024, 2.4, 'skin', [[fore, 0.7], [hand, 0.3]]], [0.915, 0.027, 0.021, 0.022, 2.4, 'skin', [[fore, 0.3], [hand, 0.7]]]);
    arms.sort((a, b) => b[0] - a[0]);
    for (const a of arms) { a[1] *= look.arm; a[2] *= look.arm; a[3] *= look.arm; }
    bld.loft(arms, 16, { path: (y) => [px(y), y > 1.165 ? 0.005 * (1.455 - y) / 0.29 : 0.005 * (y - 0.915) / 0.25], capTop: { tip: [s * 0.19, 1.492, 0], w: [[arm, 0.5], [clav, 0.5]], region: 'shirt' } });
    // fist + thumb, closed around a grip
    bld.ellipsoid([s * 0.229, 0.846, -0.004], [0.038, 0.054, 0.045], 8, 14, [[hand, 1]], 'skin', {
      deform(ux, uy, uz, d) { return [d[0] * (uy < -0.3 ? 0.9 : 1), d[1], d[2] * (Math.abs(ux) > 0.6 ? 0.92 : 1)]; },
    });
    bld.ellipsoid([s * 0.212, 0.868, -0.04], [0.015, 0.03, 0.016], 5, 8, [[hand, 1]], 'skin');
    // curled fingers: four knuckle ridges stacked down the front of the fist
    for (let f = 0; f < 4; f++) {
      bld.ellipsoid([s * 0.228, 0.878 - f * 0.02, -0.039], [0.032 - f * 0.002, 0.0105, 0.019], 6, 12, [[hand, 1]], 'skin');
    }
  }
  // ---- legs (downward from the hip) ----
  for (const s of [-1, 1]) {
    const S = s > 0 ? 'R' : 'L', th = 'thigh' + S, shn = 'shin' + S, ft = 'foot' + S;
    const hem = look.shorts, sock = look.sock;
    const legs = [
      [0.99, 0.086, 0.085, 0.095, 2, 'shorts', [[th, 0.8], ['hips', 0.2]]],
      [0.93, 0.089, 0.088, 0.096, 2, 'shorts', [[th, 1]]],
      [0.86, 0.084, 0.084, 0.089, 2, 'shorts', [[th, 1]]],
      [hem, 0.081, 0.081, 0.084, 2, 'shorts', [[th, 1]]],
      [hem, 0.074, 0.074, 0.077, 2, 'skin', [[th, 1]]],
      [0.72, 0.071, 0.073, 0.073, 2, 'skin', [[th, 1]]],
      [0.63, 0.062, 0.064, 0.062, 2, 'skin', [[th, 1]]],
      [0.565, 0.055, 0.056, 0.054, 2, 'skin', [[th, 0.8], [shn, 0.2]]],
      [0.525, 0.052, 0.054, 0.052, 2, 'skin', [[th, 0.5], [shn, 0.5]]],
      [0.49, 0.05, 0.05, 0.055, 2, 'skin', [[th, 0.2], [shn, 0.8]]],
      [0.43, 0.052, 0.047, 0.066, 2, 'skin', [[shn, 1]]],
      [0.36, 0.049, 0.044, 0.06, 2, 'skin', [[shn, 1]]],
      [0.28, 0.041, 0.04, 0.046, 2, 'skin', [[shn, 1]]],
      [sock, 0.036, 0.036, 0.038, 2, 'socks', [[shn, 1]]],
      [sock, 0.039, 0.039, 0.041, 2, 'socks', [[shn, 1]]],
      [0.13, 0.034, 0.034, 0.036, 2, 'socks', [[shn, 0.7], [ft, 0.3]]],
      [0.09, 0.033, 0.033, 0.035, 2, 'socks', [[shn, 0.4], [ft, 0.6]]],
    ];
    for (const l of legs) { l[1] *= look.leg; l[2] *= look.leg; l[3] *= look.leg; }
    bld.loft(legs, 16, { path: (y) => [s * (y > 0.525 ? THREE.MathUtils.lerp(0.1, 0.095, (y - 0.525) / 0.43) : 0.1), y > 0.525 ? -0.005 * (0.99 - y) / 0.47 : -0.005 + 0.015 * (0.525 - y) / 0.44] });
    buildShoe(bld, s, S);
  }
}

// Shoe: a loft along the foot with a flat sole; the lowest band of triangles is the white sole.
function buildShoe(bld, s, S) {
  const ft = 'foot' + S, toe = 'toe' + S, x = s * 0.1, segs = 18;
  const secs = [[0.06, 0.028, 0.07], [0.047, 0.04, 0.095], [0.02, 0.045, 0.1], [-0.03, 0.047, 0.084], [-0.08, 0.05, 0.064], [-0.125, 0.052, 0.05], [-0.165, 0.048, 0.042], [-0.192, 0.036, 0.032], [-0.203, 0.018, 0.02]];
  const rings = secs.map(([z, hw, top]) => {
    const w = z > -0.09 ? [[ft, 1]] : z > -0.15 ? [[ft, 0.5], [toe, 0.5]] : [[toe, 1]];
    const r = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const ey = sn < 0 ? -Math.pow(-sn, 0.35) : Math.pow(sn, 0.9);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), sn < 0 ? 0.55 : 0.85);
      r.push(bld.vert(x + hw * ex, top / 2 + (top / 2) * ey, z, w, [c * s, sn, z, 2]));
    }
    r.center = [x, top / 2, z];
    return r;
  });
  const P = bld.pos;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], Bq = rings[i + 1];
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs, a = A[k], b = Bq[k], c = A[k1], d = Bq[k1];
      const low = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]) < 0.024 * bld.s.height;
      const reg = low ? 'sole' : 'shoe';
      bld.tri(a, b, c, reg); bld.tri(c, b, d, reg);
    }
  }
  bld.cap(rings[0], [x, 0.035, 0.066], [[ft, 1]], 'shoe');
  bld.cap(rings[rings.length - 1], [x, 0.012, -0.207], [[toe, 1]], 'shoe');
}

function makeSkeleton(shape) {
  const bones = {}, list = [];
  for (const name of BONES) {
    const [parent, x, y, z] = JOINTS[name];
    const b = new THREE.Bone(); b.name = name;
    b.userData.world = new THREE.Vector3(x * shape.height * shape.width, y * shape.height, z * shape.height * shape.width);
    bones[name] = b; list.push(b);
    if (parent) {
      bones[parent].add(b);
      b.position.copy(b.userData.world).sub(bones[parent].userData.world);
    } else b.position.copy(b.userData.world);
  }
  return { bones, list };
}

// Surface detail for every character, drawn procedurally per region in bind-pose space so it sticks to the body:
// eyes with iris and pupil, hair strands and a soft hairline, fabric folds and weave, kit stripes on shorts and
// shoes, and slight skin variation. Fine detail fades out with distance so it never shimmers.
const DETAIL_VERT = `
  attribute float aRough, aReg, aEdge; attribute vec4 aPar; attribute vec4 aAccent;
  varying float vRough, vReg, vEdge; varying vec4 vPar, vAccent; varying vec3 vRest;`;
const DETAIL_FRAG = `
  varying float vRough, vReg, vEdge; varying vec4 vPar, vAccent; varying vec3 vRest;
  float cHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float cNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(cHash(i), cHash(i + vec3(1, 0, 0)), f.x), mix(cHash(i + vec3(0, 1, 0)), cHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(cHash(i + vec3(0, 0, 1)), cHash(i + vec3(1, 0, 1)), f.x), mix(cHash(i + vec3(0, 1, 1)), cHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  bool isReg(float r) { return abs(vReg - r) < 0.5; }
  // Bump from a procedural height via screen-space derivatives (as three's bump map does).
  vec3 bumpNormal(vec3 n, float h, float faceDir) {
    vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
    vec3 r1 = cross(sy, n), r2 = cross(n, sx);
    float det = dot(sx, r1) * faceDir;
    vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    return normalize(abs(det) * n - g);
  }
  float detailHeight(float near) {
    float h = 0.0;
    if (vReg > 0.5 && vReg < 3.5 || isReg(8.0)) {             // fabric: soft folds plus a fine weave
      float fold = cNoise(vec3(vRest.x * 11.0, vRest.y * 38.0, vRest.z * 11.0)) - 0.5;
      float waist = isReg(1.0) ? 0.6 + 0.8 * exp(-pow((vRest.y - 1.06) / 0.07, 2.0)) : 1.0;
      h += fold * 0.0022 * waist;
      h += (cNoise(vRest * 420.0) - 0.5) * 0.00012 * near;
    } else if (isReg(6.0) && vPar.w > 0.5) {                     // hair strands running down from the crown
      float th = atan(vPar.z, vPar.x);
      h += (cNoise(vec3(th * 42.0, vPar.y * 2.5, 0.0)) * 0.65 + cNoise(vec3(th * 110.0, vPar.y * 5.0, 3.1)) * 0.35 - 0.5) * 0.0012 * vEdge;
    }
    return h * near;
  }`;
const DETAIL_ALBEDO = `
  // Soft hairline: the hair shell thins out in a dither near its edge so the scalp shows through gradually.
  if (isReg(6.0) && vPar.w > 0.5 && vEdge < 0.999) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (smoothstep(0.0, 0.55, vEdge) < n) discard;
  }
  float camDist = length(vViewPosition);
  float near = clamp(1.5 - camDist / 9.0, 0.0, 1.0);
  if (isReg(7.0) && vPar.w > 0.5) {                              // eye: sclera, iris, pupil (front is -z)
    float r = length(vPar.xy);
    vec3 eye = vPar.z < 0.0 ? (r < 0.24 ? vec3(0.012) : r < 0.6 ? vec3(0.1, 0.06, 0.035) * (0.8 + 0.4 * r) : vec3(0.56, 0.53, 0.49)) : vec3(0.4, 0.35, 0.32);
    eye *= 1.0 - 0.75 * smoothstep(0.62, 0.92, vPar.y);           // upper lid and lashes
    eye *= 1.0 - 0.35 * smoothstep(0.55, 0.9, -vPar.y);           // lower lid shadow
    diffuseColor.rgb = eye;
  } else if (isReg(6.0)) {                                       // hair: strand tone, roots, soft hairline
    float th = atan(vPar.z, vPar.x);
    float s = cNoise(vec3(th * 42.0, vPar.y * 2.5, 0.0));
    diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * s, near);
    if (vPar.w > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb * 0.75 + vec3(0.03, 0.02, 0.015), diffuseColor.rgb, smoothstep(0.0, 0.6, vEdge));
  } else if (isReg(0.0)) {                                       // skin: gentle blotching, lips and brow shading on the face
    diffuseColor.rgb *= 0.95 + 0.1 * cNoise(vRest * 38.0);
    if (vPar.w > 0.5 && vRest.y > 1.5 && vPar.z < -0.55 && abs(vPar.x) < 0.45) {
      float lips = exp(-pow((vPar.y + 0.55) / 0.07, 2.0)) * smoothstep(0.34, 0.12, abs(vPar.x));
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.52, 0.5), lips * 0.8);
      diffuseColor.rgb *= 1.0 - 0.55 * exp(-pow((vPar.y + 0.55) / 0.012, 2.0)) * smoothstep(0.3, 0.1, abs(vPar.x));
      diffuseColor.rgb *= 1.0 - 0.18 * exp(-pow((vPar.y - 0.02) / 0.1, 2.0)) * exp(-pow((abs(vPar.x) - 0.38) / 0.14, 2.0));
    }
  } else if (isReg(2.0) && vPar.w < 0.5) {                       // shorts: accent stripe down the outer side
    if (abs(vPar.x) > 0.975 && vPar.x * vRest.x > 0.0) diffuseColor.rgb = vAccent.rgb;
  } else if (isReg(4.0) && vPar.w > 1.5) {                       // shoe: a side flash in the accent colour
    float band = abs((vRest.y - 0.028) - (vPar.z + 0.07) * 0.32);
    if (vPar.x > 0.35 && band < 0.0065 && vPar.z > -0.16 && vPar.z < 0.03) diffuseColor.rgb = vAccent.rgb;
  } else if (isReg(1.0) && vPar.w < 0.5) {                       // shirt designs (vPar.z is the unscaled height)
    float d = vAccent.a, y = vPar.z;
    bool on = false;
    if (d > 0.5 && d < 1.5) on = y > 1.405;                                          // shoulder yoke
    else if (d > 1.5 && d < 2.5) on = y > 1.245 && y < 1.315;                        // chest band
    else if (d > 2.5 && d < 3.5) on = abs(vPar.x) > 0.9 && y < 1.33;                 // side panels
    // small chest logo, front left: a slanted flash
    float lx = vRest.x + 0.075, ly = y - 1.37;   // the player's left is -x
    if (vPar.y < -0.6 && abs(lx) < 0.028 && abs(ly - lx * 0.35) < 0.0065) on = !on;
    if (on) diffuseColor.rgb = vAccent.rgb;
  }
  if (vReg > 0.5 && vReg < 2.5) diffuseColor.rgb *= 0.97 + 0.06 * cNoise(vec3(vRest.x * 11.0, vRest.y * 38.0, vRest.z * 11.0));
  // --- facial hair (A07) ---
  // Stubble: head skin carries its beard shadow strength in aEdge (1 = clean-shaven). Darken and cool the skin
  // there, speckled up close; full beards add a hair-coloured shell on top. Also tints the iris when the look sets
  // eyeColor (the eye's vertex colour; the default 0x121212 leaves the shader's own iris alone).
  if (isReg(0.0) && vPar.w > 0.5 && vEdge < 0.999) {
    float bd = 1.0 - vEdge, fine = clamp(2.0 - length(vViewPosition) / 1.1, 0.0, 1.0);
    float sp = mix(0.5, cNoise(vRest * 1500.0) * 0.6 + cNoise(vRest * 520.0) * 0.4, fine);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.33, 0.32, 0.33), clamp(bd * (0.7 + 1.0 * sp), 0.0, 1.0));
  }
  if (isReg(7.0) && vPar.w > 0.5 && vPar.z < 0.0 && vColor.r + vColor.g + vColor.b > 0.03) {
    float ir = length(vPar.xy);
    diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb / vec3(0.1, 0.06, 0.035), smoothstep(0.22, 0.26, ir) * (1.0 - smoothstep(0.55, 0.6, ir)));
  }
  // --- end facial hair (A07) ---`;

let bodyMat = null;
function bodyMaterial() {
  if (bodyMat) return bodyMat;
  // Physical for the sheen: fabric and skin get a soft rim of light instead of a plastic highlight.
  bodyMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 1, sheen: 1, sheenRoughness: 0.75, sheenColor: 0xffffff });
  bodyMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + DETAIL_VERT)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough; vReg = aReg; vEdge = aEdge; vPar = aPar; vRest = position; vAccent = aAccent;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + DETAIL_FRAG)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + DETAIL_ALBEDO)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = bumpNormal(normal, detailHeight(near), faceDirection);')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        float sheenAmt = (vReg > 0.5 && vReg < 3.5 || isReg(8.0)) ? 0.55 : isReg(0.0) ? 0.12 : isReg(6.0) ? 0.3 : 0.0;
        material.sheenColor = mix(vec3(1.0), diffuseColor.rgb, 0.45) * sheenAmt;`);
  };
  return bodyMat;
}

const regionColors = (look) => [look.skin, look.shirt, look.pants, 0xf3f3ee, look.shoe, 0xf0efe8, look.hairColor, look.eyeColor ?? 0x121212, look.band];

// Change an existing character's outfit in place (colours, accent, shirt design): no rebuild, just vertex data.
export function recolorCharacter(ch, kit) {
  const look = Object.assign(ch.look, kit), g = ch.mesh.geometry, cols = regionColors(look).map((h) => new THREE.Color(h));
  const reg = g.attributes.aReg.array, col = g.attributes.color.array, acc = g.attributes.aAccent.array, a = new THREE.Color(look.accent ?? look.band);
  for (let i = 0; i < reg.length; i++) {
    const c = cols[reg[i]]; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    acc[i * 4] = a.r; acc[i * 4 + 1] = a.g; acc[i * 4 + 2] = a.b; acc[i * 4 + 3] = look.design || 0;
  }
  g.attributes.color.needsUpdate = true; g.attributes.aAccent.needsUpdate = true;
}

// look: { height, shoulder, hip, chest, skin, hair, hairColor, shirt, shorts, shoe, band, headband, wristband, sleeve, shorts, sock }
export function createCharacter(opts = {}) {
  const look = {
    height: 1, width: 1, chest: 1, skin: 0xd9a27e, hair: 'short', hairColor: 0x2b1d14, shirt: 0xf2f5ee, pants: 0x1f3b5c, shoe: 0xf4f4f0,
    band: 0xd6f04a, headband: true, wristband: true, sleeve: 0.12, shorts: 0.8, sock: 0.2, arm: 1.14, leg: 1.1, detail: 1, ...opts,
  };
  const shape = { height: look.height, width: look.width };
  const bld = new Builder(shape);
  buildBody(bld, look);
  // Region order: skin, shirt, shorts, socks, shoe, sole, hair, eye, band.
  const geo = bld.geometry(
    regionColors(look),
    [0.5, 0.82, 0.78, 0.95, 0.5, 0.7, 0.6, 0.15, 0.8],
    look.accent ?? look.band,
    look.design || 0,
  );
  const { bones, list } = makeSkeleton(shape);
  const mesh = new THREE.SkinnedMesh(geo, bodyMaterial());
  mesh.add(bones.root);
  mesh.bind(new THREE.Skeleton(list));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, bones, look, rest: Object.fromEntries(list.map((b) => [b.name, b.position.clone()])) };
}

export const SKIN_TONES = [0xf2c9a8, 0xe3b08a, 0xd9a27e, 0xc4855c, 0xa46a45, 0x8a573a, 0x6b4128, 0x4e2f1f];
export const HAIR_COLORS = [0x15100c, 0x2b1d14, 0x4a3020, 0x7a5230, 0xb08850, 0xd8c08a, 0x8c8c88];
