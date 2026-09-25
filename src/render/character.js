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
  // A ring shaped by prof(c, s) → [dx, dz, dy] around (cx, y, cz). w: a weight list or (c, s, x, y, z) → list;
  // edge(x, y, z) → aEdge. aPar = (c, s, y, kind).
  ringP(cx, y, cz, prof, segs, w, kind = 0, edge = null) {
    const out = [];
    for (let k = 0; k < segs; k++) {
      const th = (k / segs) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th), d = prof(c, s);
      const x = cx + d[0], yy = y + (d[2] || 0), z = cz + d[1];
      out.push(this.vert(x, yy, z, typeof w === 'function' ? w(c, s, x, yy, z) : w, [c, s, y, kind], edge ? edge(x, yy, z) : 1));
    }
    out.center = [cx, y, cz];
    return out;
  }
  // Join rings in order with ONE winding for the whole run, taken from the plain segment rings[ref] → rings[ref + 1]:
  // hems that fold back inside and steps between rings at the same height then face the right way. Each ring's
  // .region colours the band below it.
  chain(rings, ref = 0) {
    const P = this.pos, p = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const A0 = rings[ref], B0 = rings[ref + 1], a0 = p(A0[0]);
    const nrm = new THREE.Vector3().subVectors(p(B0[0]), a0).cross(new THREE.Vector3().subVectors(p(A0[1]), a0));
    const flip = nrm.dot(a0.clone().sub(new THREE.Vector3(...this.fit(...A0.center)))) < 0;
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], Bq = rings[i + 1], n = A.length;
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n, a = A[k], b = Bq[k], c = A[k1], d = Bq[k1];
        if (flip) { this.tri(a, c, b, A.region); this.tri(c, d, b, A.region); }
        else { this.tri(a, b, c, A.region); this.tri(c, b, d, A.region); }
      }
    }
  }
  // A round tube through pts [[x, y, z, r], ...] with domed ends (fingers, thumb). Frames are parallel-transported.
  tube(pts, segs, w, region) {
    const P = pts.map((q) => new THREE.Vector3(q[0], q[1], q[2])), n = P.length;
    const T = P.map((q, i) => new THREE.Vector3().subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize());
    const N = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const ringAt = (c, t, r) => {
      N.addScaledVector(t, -N.dot(t)).normalize();
      const b = new THREE.Vector3().crossVectors(t, N), out = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        out.push(this.vert(c.x + (N.x * ca + b.x * sa) * r, c.y + (N.y * ca + b.y * sa) * r, c.z + (N.z * ca + b.z * sa) * r, w, [ca, sa, 0, 4]));
      }
      out.center = [c.x, c.y, c.z];
      return out;
    };
    const r0 = pts[0][3], r1 = pts[n - 1][3];
    const rings = [ringAt(P[0].clone().addScaledVector(T[0], -0.6 * r0), T[0], 0.8 * r0)];
    for (let i = 0; i < n; i++) rings.push(ringAt(P[i], T[i], pts[i][3]));
    rings.push(ringAt(P[n - 1].clone().addScaledVector(T[n - 1], 0.6 * r1), T[n - 1], 0.8 * r1));
    for (let i = 0; i < rings.length - 1; i++) this.strip(rings[i], rings[i + 1], region);
    this.cap(rings[0], P[0].clone().addScaledVector(T[0], -r0).toArray(), w, region);
    this.cap(rings[rings.length - 1], P[n - 1].clone().addScaledVector(T[n - 1], r1).toArray(), w, region);
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
  // ---- torso, shorts and collar ----
  buildTorso(bld, look);
  // ---- neck & head ----
  buildHead(bld, look);
  // ---- arms (downward from the shoulder) ----
  for (const s of [-1, 1]) { buildArm(bld, look, s); buildHand(bld, s); }
  // ---- legs (downward from the hip) ----
  for (const s of [-1, 1]) { buildLeg(bld, look, s); buildShoe(bld, s, s > 0 ? 'R' : 'L'); }
}

// ---- Body, clothes and shoes ----
// Everything below is in rest-pose metres for the 1.83 m build (Builder.fit scales it). Limbs are lofts of rings
// whose radius comes from a base curve plus soft bumps for bones and muscles; clothes are separate, slightly
// looser shells (shirt, sleeves, shorts, socks) with hems that fold back inside.
const bG = (a, w) => Math.exp(-((a / w) ** 2));
const bGA = (a, a0, w) => bG(Math.atan2(Math.sin(a - a0), Math.cos(a - a0)), w);   // the same round an angle
const bStep = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const bClamp = (x) => Math.min(1, Math.max(0, x));
const bSmax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
// Catmull-Rom through keys [[t, v0, v1, ...], ...] (sorted by t): t → [v0, v1, ...].
function bKeys(keys) {
  return (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
    const u = bClamp((t - k1[0]) / (k2[0] - k1[0])), out = [];
    for (let c = 1; c < k1.length; c++) {
      const p0 = k0[c], p1 = k1[c], p2 = k2[c], p3 = k3[c];
      out.push(0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u));
    }
    return out;
  };
}
// Superellipse cross-section point: half width a, front depth zf (-z), back depth zb, squareness n (2 = ellipse).
function bSuper(c, s, a, zf, zb, n) {
  const ex = Math.sign(c) * Math.abs(c) ** (2 / n), ez = Math.sign(s) * Math.abs(s) ** (2 / n);
  return [a * ex, (s > 0 ? zb : zf) * ez];
}

// Shirt over the torso: [y, half width, front depth, back depth, squareness]. It hangs straight from the chest and
// shoulder blades, so the waist is only a little narrower; the hem sits over the shorts' waistband.
const SHIRT = bKeys([
  [0.958, 0.182, 0.106, 0.132, 2.3], [0.985, 0.177, 0.105, 0.126, 2.3], [1.02, 0.169, 0.103, 0.116, 2.3],
  [1.08, 0.16, 0.102, 0.104, 2.35], [1.14, 0.157, 0.103, 0.099, 2.4], [1.2, 0.163, 0.106, 0.1, 2.45],
  [1.25, 0.172, 0.11, 0.103, 2.5], [1.3, 0.182, 0.113, 0.107, 2.6], [1.34, 0.186, 0.115, 0.111, 2.7],
  [1.37, 0.189, 0.115, 0.113, 2.75], [1.4, 0.191, 0.113, 0.113, 2.8], [1.425, 0.191, 0.109, 0.111, 2.8],
  [1.447, 0.185, 0.103, 0.107, 2.7], [1.466, 0.171, 0.096, 0.103, 2.5], [1.483, 0.151, 0.088, 0.097, 2.35],
  [1.497, 0.127, 0.08, 0.09, 2.2], [1.508, 0.101, 0.073, 0.083, 2.05], [1.515, 0.083, 0.068, 0.079, 2.0],
]);
// Shorts round the hips, from under the shirt down to where the legs split.
const PELVIS = bKeys([
  [0.92, 0.176, 0.093, 0.121, 2.4], [0.945, 0.176, 0.095, 0.125, 2.4], [0.975, 0.173, 0.096, 0.121, 2.4],
  [1.005, 0.167, 0.096, 0.112, 2.4], [1.035, 0.161, 0.096, 0.104, 2.4],
]);
const SHIRT_HEM = 0.958, NECKLINE = 1.515, NECK_Z = 0.006, NECK_TILT = 0.012;   // the neckline dips 12 mm at the front
// Bare arm (radius, metres, for arm = 1.14) and leg (for leg = 1.1) before muscles and landmarks.
const ARM_R = bKeys([[0.9, 0.026], [0.915, 0.027], [0.94, 0.028], [0.965, 0.031], [1.0, 0.035], [1.04, 0.041], [1.08, 0.046], [1.11, 0.047], [1.14, 0.045], [1.165, 0.042], [1.19, 0.044], [1.22, 0.048], [1.26, 0.052], [1.3, 0.054], [1.34, 0.057], [1.38, 0.06], [1.42, 0.062], [1.448, 0.061], [1.466, 0.055], [1.479, 0.045], [1.488, 0.03]]);
const LEG_R = bKeys([[0.085, 0.033], [0.1, 0.033], [0.13, 0.031], [0.17, 0.03], [0.21, 0.031], [0.26, 0.035], [0.31, 0.04], [0.36, 0.045], [0.4, 0.048], [0.44, 0.05], [0.47, 0.05], [0.5, 0.051], [0.525, 0.052], [0.55, 0.054], [0.58, 0.058], [0.62, 0.064], [0.68, 0.07], [0.74, 0.075], [0.8, 0.079], [0.86, 0.082]]);

function buildTorso(bld, look) {
  const m = look.muscle, ch = look.chest, SEG = 36, collar = look.collar;
  // Bare skin cut out of the shirt, as signed distances in metres (positive = cloth): armholes, a V-neck, an open
  // polo placket. They reach the shader through aEdge, so the edge is crisp at any mesh density.
  const holes = [];
  if (look.sleeve <= 0.001) holes.push((x, y) => bSmax(0.138 + 0.054 * bClamp((1.44 - y) / 0.19) ** 2 - Math.abs(x), 1.255 - y, 0.02));   // tank-top armholes
  if (collar === 'v') holes.push((x, y, z) => Math.max((1.415 + 1.25 * Math.abs(x) - y) / 1.6, z + 0.03));
  if (collar === 'polo') holes.push((x, y, z) => Math.max((1.468 + 2.2 * Math.abs(x) - y) / 2.4, z + 0.03));
  const cloth = (x, y, z) => holes.reduce((d, f) => Math.min(d, f(x, y, z)), 1);
  const edge = (x, y, z) => 0.5 + Math.max(-0.45, Math.min(0.45, cloth(x, y, z), y - SHIRT_HEM, NECKLINE + NECK_TILT * Math.max(-1, Math.min(1, z / 0.07)) - y));
  const shirtAt = (y) => (c, s) => {
    let [a, zf, zb, n] = SHIRT(y);
    const wc = bG(y - 1.34, 0.09);
    a *= 1 + (ch - 1) * wc; zf *= 1 + (ch - 1) * 0.8 * wc;
    let [x, z] = bSuper(c, s, a, zf, zb, n);
    const ax = Math.abs(x), fw = Math.max(0, -s), bw = Math.max(0, s);
    z -= (0.005 + 0.01 * m) * bG(y - 1.35, 0.05) * bG(ax - 0.075, 0.055) * fw;              // pecs
    z += (0.004 + 0.004 * m) * bG(y - 1.37, 0.06) * bG(ax - 0.085, 0.05) * bw;              // shoulder blades
    z -= 0.0025 * bG(ax, 0.02) * bw * bG(y - 1.25, 0.14);                                   // spine
    x += Math.sign(c) * Math.abs(c) * ((0.003 + 0.008 * m) * bG(y - 1.3, 0.07) * bStep(s, -0.5, 0.6)   // lats: the V to the waist
      + 0.01 * m * bG(y - 1.48, 0.02));                                                     // traps fill the neck-to-shoulder slope
    z += NECK_Z * bStep(y, 1.46, 1.515);
    const dy = NECK_TILT * s * bStep(y, 1.49, 1.515);
    // skin under an armhole or V sits a few mm below the cloth, so the shirt has an edge
    const d = cloth(x, y + dy, z);
    if (d < 0) { const k = 1 - 0.004 * bStep(-d, 0, 0.015) / Math.max(0.05, Math.hypot(x, z)); x *= k; z *= k; }
    return [x, z, dy];
  };
  const tw = (c, s, x, y) => {
    const w = torsoWeights(y), t = 0.5 * bStep(Math.abs(x), 0.13, 0.19) * bStep(y, 1.36, 1.45);   // shoulders ride the collarbones
    return t > 0 ? [...w.map(([b, v]) => [b, v * (1 - t)]), [x > 0 ? 'clavR' : 'clavL', t]] : w;
  };
  // hem turned in under the shirt's edge (over the shorts), then the shirt up to the neckline
  const [la, lzf, lzb, ln] = PELVIS(SHIRT_HEM + 0.012);
  const rings = [bld.ringP(0, SHIRT_HEM + 0.012, 0, (c, s) => bSuper(c, s, la - 0.004, lzf - 0.004, lzb - 0.004, ln), SEG, (c, s, x, y) => torsoWeights(y), 3, () => 0.5)];
  const kind = collar === 'polo' ? 3.25 : 3;   // the fraction tells the shader to draw a placket
  for (const y of [SHIRT_HEM, 0.985, 1.02, 1.06, 1.1, 1.14, 1.18, 1.22, 1.26, 1.3, 1.335, 1.37, 1.4, 1.425, 1.447, 1.466, 1.483, 1.497, 1.508, NECKLINE]) rings.push(bld.ringP(0, y, 0, shirtAt(y), SEG, tw, kind, edge));
  for (const r of rings) r.region = 'shirt';
  bld.chain(rings, 5);
  buildCollar(bld, collar, SEG);
  buildShorts(bld, look);
}

// Collar on the neckline: a ribbed crew band, the same band opening into a V, or a polo's stand and fold-down collar.
// Rings are [lift, half width, front depth, back depth]; h(c, s) scales a ring's rise off the neckline (0 = flat).
function buildCollar(bld, collar, SEG) {
  const base = [0, 0.083, 0.068, 0.079], w0 = [['chest', 1]], w1 = [['chest', 0.6], ['neck', 0.4]];
  const front = (c, s) => Math.atan2(Math.abs(c), -s);   // angle from the front centre, 0..PI
  let rs, h = () => 1;
  if (collar === 'polo') {
    const flapLift = (c, s) => { const f = front(c, s); return -0.002 - 0.012 * bG(f - 0.42, 0.3) + 0.008 * bStep(f, 1.2, 2.6); };
    const notch = (c, s) => bStep(front(c, s), 0.05, 0.24);   // the two collar points part at the front
    rs = [base, [0.026, 0.074, 0.062, 0.074], [0.03, 0.078, 0.066, 0.078],
      [(c, s) => 0.03 + (flapLift(c, s) - 0.03) * notch(c, s), (c, s) => 0.078 + 0.024 * notch(c, s), (c, s) => 0.066 + 0.026 * notch(c, s), (c, s) => 0.078 + 0.019 * notch(c, s)]];
  } else {
    rs = [base, [0.011, 0.076, 0.063, 0.076], [0.017, 0.073, 0.061, 0.074], [0.012, 0.06, 0.052, 0.062]];
    if (collar === 'v') h = (c, s) => bStep(s, -0.8, 0.05);
  }
  const val = (v, c, s) => (typeof v === 'function' ? v(c, s) : v);
  const rings = rs.map((r, i) => {
    const out = bld.ringP(0, NECKLINE, 0, (c, s) => {
      const k = h(c, s), [x, z] = bSuper(c, s, THREE.MathUtils.lerp(base[1], val(r[1], c, s), k), THREE.MathUtils.lerp(base[2], val(r[2], c, s), k), THREE.MathUtils.lerp(base[3], val(r[3], c, s), k), 2);
      return [x, z + NECK_Z, NECK_TILT * s + val(r[0], c, s) * k];
    }, SEG, i ? w1 : w0, 5, () => 0.5 + (i === 2 ? 0 : 0.012));
    out.region = 'shirt';
    return out;
  });
  bld.chain(rings, 0);
}

// Shorts: hips down to a crotch seam shared by both legs ("trousers" topology, so there's no seam bulge), then two
// loose legs flaring a little to a hem that turns in.
function buildShorts(bld, look) {
  const N = 32, Y0 = 0.92, CROTCH = 0.855, K = look.leg / 1.1, hem = Math.min(look.shorts, 0.83), sc = bld.s, lerp = THREE.MathUtils.lerp;
  const rings = [1.035, 1.005, 0.975, 0.945, Y0].map((y) => {
    const [a, zf, zb, n] = PELVIS(y), r = bld.ringP(0, y, 0, (c, s) => bSuper(c, s, a, zf, zb, n), N, torsoWeights(y), 0);
    r.region = 'shorts';
    return r;
  });
  bld.chain(rings, 0);
  const split = rings[rings.length - 1];   // k = 0 is the right side (+x), 8 the back, 16 the left, 24 the front
  const [, zfS, zbS] = PELVIS(Y0), seam = [];
  for (let j = 1; j < 8; j++) {
    const t = j / 8, y = Y0 - (Y0 - CROTCH) * Math.sin(Math.PI * t) ** 0.6, z = lerp(zbS, -zfS, t) * (1 - 0.25 * Math.sin(Math.PI * t));
    seam.push(bld.vert(0, y, z, [['hips', 0.7], ['thighR', 0.15], ['thighL', 0.15]], [0, 0, y, 0]));
  }
  const U = (i) => [bld.pos[i * 3] / (sc.height * sc.width), bld.pos[i * 3 + 2] / (sc.height * sc.width)];
  for (const s of [-1, 1]) {
    const th = s > 0 ? 'thighR' : 'thighL';
    const r0 = s > 0 ? [...split.slice(24), ...split.slice(0, 9), ...seam] : [...split.slice(8, 25), ...seam.slice().reverse()];
    r0.region = 'shorts';
    const al = r0.map((i) => { const [x, z] = U(i); return Math.atan2(z, x - s * 0.088); });   // angles round the leg's top
    const ring = (t, dr = 0, e = null) => {
      const y = t > 1 ? hem + 0.012 : lerp(0.845, hem, t), u = Math.min(1, t), cx = s * lerp(0.093, 0.101, u), cz = lerp(0, -0.004, u), out = [];
      for (const a of al) {
        const ca = Math.cos(a), sa = Math.sin(a), o = s * ca;
        const rx = o > 0 ? lerp(0.09, 0.093, u) : lerp(0.09, 0.093, u), rz = sa < 0 ? lerp(0.091, 0.092, u) : lerp(0.104, 0.096, u);
        const r = (1 / Math.hypot(ca / rx, sa / rz) - dr) * K, tw = lerp(0.62, 1, u) - 0.12 * Math.max(0, sa) * (1 - u);
        out.push(bld.vert(cx + r * ca, y, cz + r * sa, [[th, tw], ['hips', 1 - tw]], [ca, sa, y, 0], e ?? 0.5 + (y - hem)));
      }
      out.center = [cx, y, cz]; out.region = 'shorts';
      return out;
    };
    bld.chain([r0, ring(0), ring(0.35), ring(0.7), ring(1), ring(2, 0.0045, 0.5)], 1);
  }
}

function buildArm(bld, look, s) {
  const S = s > 0 ? 'R' : 'L', arm = 'arm' + S, fore = 'fore' + S, hand = 'hand' + S, clav = 'clav' + S, lerp = THREE.MathUtils.lerp;
  const m = look.muscle, K = look.arm / 1.14, sleeved = look.sleeve > 0.001, hem = 1.455 - look.sleeve;
  const px = (y) => s * (y > 1.165 ? lerp(0.212, 0.19, (y - 1.165) / 0.29) : lerp(0.226, 0.212, (y - 0.915) / 0.25));
  const pz = (y) => (y > 1.165 ? 0.005 * (1.455 - y) / 0.29 : 0.005 * (y - 0.915) / 0.25);
  // radius toward (c, sn): bones and muscles; cloth drapes over half of that relief
  const rad = (y, c, sn, cl) => {
    const ph = Math.atan2(-sn, c * s);   // 0 = outward, PI/2 = forward
    const b = (0.003 + 0.007 * m) * bG(y - 1.4, 0.06) * bGA(ph, 0, 1.3)       // deltoid
      + (0.002 + 0.004 * m) * bG(y - 1.33, 0.03) * bGA(ph, 0, 0.5)            // its insertion, halfway down the outside
      + (0.005 + 0.009 * m) * bG(y - 1.265, 0.05) * bGA(ph, 1.57, 0.8)        // biceps
      + (0.004 + 0.007 * m) * bG(y - 1.33, 0.06) * bGA(ph, -1.3, 0.85)        // triceps
      + 0.004 * bG(y - 1.16, 0.016) * bGA(ph, -1.57, 0.5)                     // point of the elbow
      + 0.003 * bG(y - 1.17, 0.016) * bGA(ph, 3.14, 0.45)                     // inner elbow bone
      + (0.004 + 0.007 * m) * bG(y - 1.11, 0.045) * bGA(ph, 0.6, 0.7)         // brachioradialis
      + (0.003 + 0.005 * m) * bG(y - 1.09, 0.05) * bGA(ph, 2.4, 0.8);         // forearm flexors
    const wf = 1 - bStep(y, 0.97, 1.06);   // the wrist is narrow across and deep front to back (back of the hand faces out)
    return (ARM_R(y)[0] + (cl ? 0.5 * b : b)) * (1 - 0.18 * wf * Math.cos(2 * ph)) * K;
  };
  const wts = (c, sn, x, y) => {
    const kc = 0.4 * bStep(y, 1.395, 1.477), kch = 0.22 * Math.max(0, -c * s) * bG(y - 1.4, 0.04);   // collarbone, armpit
    const tf = bClamp((1.23 - y) / 0.13), th = bClamp((0.9675 - y) / 0.075), up = 1 - kc - kch;
    return [[arm, up * (1 - tf)], [fore, up * tf * (1 - th)], [hand, up * tf * th], [clav, kc], ['chest', kch]];
  };
  const ring = (y, reg, extra, cl, e) => {
    const r = bld.ringP(px(y), y, pz(y), (c, sn) => {
      const rr = rad(y, c, sn, cl) + extra(c, sn);
      return [c * rr, sn * rr, -0.016 * Math.max(0, -c * s) * bStep(y, 1.44, 1.49)];   // the top of the shoulder slopes in to the neck
    }, 20, wts, 0, e);
    r.region = reg;
    return r;
  };
  const top = 1.494;
  const YS = [1.488, 1.479, 1.47, 1.46, 1.448, 1.43, 1.405, 1.38, 1.355, 1.33, 1.305, 1.28, 1.255, 1.23, 1.205, 1.185, 1.165, 1.145, 1.125, 1.1, 1.075, 1.05, 1.02, 0.99, 0.97, 0.95, 0.93, 0.915, 0.9];
  // bare arm (under a sleeve it starts just above the hem)
  const secs = [];
  for (const y of YS) {
    if (sleeved && y > hem + 0.03) continue;
    if (look.wristband && y > 0.945 && y < 0.995) continue;
    secs.push([y, 'skin', 0]);
    if (look.wristband && y === 1.02) secs.push([0.99, 'band', 0], [0.99, 'band', 0.0065], [0.97, 'band', 0.007], [0.95, 'band', 0.0065], [0.95, 'skin', 0]);
  }
  const rings = secs.map(([y, reg, ex]) => ring(y, reg, () => ex, false, null));
  bld.chain(rings, 2);
  if (!sleeved) bld.cap(rings[0], [px(top), top, pz(top)], [[arm, 0.5], [clav, 0.5]], 'skin');
  else {
    // sleeve: a little looser than the arm, bunched at the armpit, hem turned in
    const ease = (y) => (c, sn) => 0.006 + 0.007 * bClamp((1.45 - y) / 0.15) + 0.005 * Math.max(0, -c * s) * bG(y - 1.39, 0.045);
    const sl = YS.filter((y) => y > hem + 0.012).map((y) => ring(y, 'shirt', ease(y), true, () => 0.5 + (y - hem)));
    sl.push(ring(hem, 'shirt', ease(hem), true, () => 0.5), ring(hem + 0.012, 'shirt', () => 0.0015, false, () => 0.5));
    bld.chain(sl, 2);
    bld.cap(sl[0], [px(top), top + 0.006, pz(top)], [[arm, 0.5], [clav, 0.5]], 'shirt');
  }
}

// Fist closed round the racket handle (which runs down through it): back of the hand facing out, four curled
// fingers wrapping the front, the thumb across them. Coordinates: out from the handle, down from the wrist, forward.
function buildHand(bld, s) {
  const w = [['hand' + (s > 0 ? 'R' : 'L'), 1]];
  const H = (o, y, f) => [s * (0.226 + o), 0.915 + y, -0.004 - f];
  bld.ellipsoid(H(0.005, -0.05, 0.001), [0.021, 0.047, 0.035], 8, 14, w, 'skin', {
    deform(ux, uy, uz, d) { const t = 1 - 0.16 * Math.max(0, uy); return [d[0] * t * (s * ux > 0 ? 0.88 : 1), d[1], d[2] * t]; },
  });
  bld.ellipsoid(H(-0.013, -0.028, 0.006), [0.011, 0.021, 0.015], 6, 10, w, 'skin');   // ball of the thumb
  const RF = 0.028;
  [[-0.036, 0.0098, 162], [-0.056, 0.01, 162], [-0.075, 0.0095, 158], [-0.092, 0.0085, 150]].forEach(([y, r, end]) => {
    const pts = [15, 55, 95, 130, end].map((deg, j) => {
      const a = (deg * Math.PI) / 180;
      return [...H(RF * Math.cos(a), y - 0.0015 * j, RF * Math.sin(a)), r * [1.12, 1.0, 1.06, 0.98, 0.9][j]];   // knuckles are the fat bits
    });
    bld.tube(pts, 8, w, 'skin');
  });
  bld.tube([[...H(-0.013, -0.02, 0.006), 0.0115], [...H(-0.024, -0.033, 0.017), 0.0105], [...H(-0.022, -0.045, 0.031), 0.0095], [...H(-0.009, -0.05, 0.039), 0.0088], [...H(0.003, -0.051, 0.041), 0.008]], 8, w, 'skin');
}

function buildLeg(bld, look, s) {
  const S = s > 0 ? 'R' : 'L', th = 'thigh' + S, shn = 'shin' + S, ft = 'foot' + S, lerp = THREE.MathUtils.lerp;
  const m = look.muscle, K = look.leg / 1.1, sock = look.sock;
  const px = (y) => s * (y > 0.525 ? lerp(0.1, 0.095, (y - 0.525) / 0.43) : 0.1);
  const pz = (y) => (y > 0.525 ? -0.005 * (0.99 - y) / 0.47 : -0.005 + 0.015 * (0.525 - y) / 0.44);
  const rad = (y, c, sn) => {
    const ph = Math.atan2(-sn, c * s);   // 0 = outward, PI/2 = forward
    const b = (0.004 + 0.006 * m) * bG(y - 0.73, 0.1) * bGA(ph, 0.8, 0.9)        // quads: rectus and vastus lateralis
      + (0.003 + 0.007 * m) * bG(y - 0.6, 0.04) * bGA(ph, 2.2, 0.6)              // vastus medialis teardrop over the knee
      + (0.003 + 0.003 * m) * bG(y - 0.72, 0.1) * bGA(ph, -1.57, 0.9)            // hamstrings
      + 0.004 * bG(y - 0.83, 0.06) * bGA(ph, 3.14, 0.7)                          // adductors
      + 0.006 * bG(y - 0.54, 0.022) * bGA(ph, 1.57, 0.5)                         // kneecap
      + 0.002 * bG(y - 0.505, 0.015) * bGA(ph, 1.57, 0.35)                       // its tendon
      - 0.003 * bG(y - 0.525, 0.025) * bGA(ph, -1.57, 0.6)                       // back of the knee
      + (0.011 + 0.009 * m) * bG(y - 0.405, 0.055) * bGA(ph, -2.05, 0.75)        // calf, inner head (lower)
      + (0.008 + 0.006 * m) * bG(y - 0.43, 0.05) * bGA(ph, -1.05, 0.7)           // calf, outer head
      - 0.003 * bG(y - 0.2, 0.05) * (bGA(ph, -0.8, 0.35) + bGA(ph, -2.35, 0.35))   // hollows beside the Achilles
      + 0.004 * bG(y - 0.115, 0.012) * bGA(ph, 3.14, 0.5)                       // ankle bones: inner higher
      + 0.004 * bG(y - 0.1, 0.012) * bGA(ph, 0, 0.5);
    return (LEG_R(y)[0] + b) * K;
  };
  const wts = (c, sn, x, y) => {
    const kh = 0.35 * bStep(y, 0.8, 0.86), t = bClamp((0.575 - y) / 0.1), tf = y < 0.17 ? Math.min(0.7, bClamp(0.3 + (0.13 - y) * 7.5)) : 0, up = 1 - kh;
    return [[th, up * (1 - t)], ['hips', kh], [shn, up * t * (1 - tf)], [ft, up * t * tf]];
  };
  const YS = [0.86, 0.83, 0.8, 0.77, 0.74, 0.71, 0.68, 0.65, 0.62, 0.595, 0.57, 0.55, 0.535, 0.52, 0.505, 0.49, 0.47, 0.45, 0.43, 0.41, 0.39, 0.37, 0.345, 0.32, 0.295, 0.27, 0.245, 0.22, 0.195, 0.17, 0.15, 0.13, 0.115, 0.1, 0.085];
  // skin down to the sock, a ribbed cuff that stands proud, then sock into the shoe
  const secs = YS.filter((y) => y > sock + 0.006).map((y) => [y, 'skin', 0]);
  secs.push([sock, 'socks', 0], [sock, 'socks', 0.0048], [sock - 0.016, 'socks', 0.0045], [sock - 0.021, 'socks', 0.003]);
  for (const y of YS) if (y < sock - 0.03) secs.push([y, 'socks', 0.003]);
  const rings = secs.map(([y, reg, ex]) => {
    const r = bld.ringP(px(y), y, pz(y), (c, sn) => { const rr = rad(y, c, sn) + ex; return [c * rr, sn * rr]; }, 22, wts, 0, reg === 'socks' ? () => 0.5 + (sock - y) : null);
    r.region = reg;
    return r;
  });
  bld.chain(rings, 0);
}

// Tennis shoe, lofted heel to toe. Each cross-section runs bottom centre → outer side → top → inner side: a flat
// outsole with a rounded tread edge, a midsole wall that flares a touch, then the upper. aPar = (metres outward,
// height, z along the foot, 2); aEdge = 0.5 + height above the ground contact.
const SHOE = bKeys([
  [-0.205, 0.016, 0.012, 0.027, 0.029], [-0.198, 0.031, 0.027, 0.025, 0.035], [-0.185, 0.042, 0.038, 0.023, 0.042],
  [-0.165, 0.049, 0.045, 0.022, 0.049], [-0.135, 0.053, 0.049, 0.022, 0.057], [-0.1, 0.052, 0.048, 0.023, 0.065],
  [-0.06, 0.049, 0.045, 0.025, 0.077], [-0.02, 0.046, 0.042, 0.027, 0.085], [0.01, 0.044, 0.04, 0.029, 0.088],
  [0.035, 0.043, 0.039, 0.03, 0.09], [0.055, 0.039, 0.035, 0.031, 0.093], [0.068, 0.031, 0.027, 0.031, 0.088],
  [0.075, 0.017, 0.013, 0.03, 0.072],
]);
const SHOE_COLS = [
  (sw, uw, yb) => [0, yb], (sw, uw, yb) => [0.5 * sw, yb], (sw, uw, yb) => [0.87 * sw, yb],
  (sw, uw, yb) => [0.985 * sw, yb + 0.0035], (sw, uw, yb) => [sw, yb + 0.0085],              // tread edge
  (sw, uw, yb, st) => [1.012 * sw, THREE.MathUtils.lerp(yb, st, 0.6)], (sw, uw, yb, st) => [0.99 * sw, st],   // midsole, sole line
  (sw, uw, yb, st) => [uw, st + 0.004], (sw, uw, yb, st, tp) => [0.985 * uw, THREE.MathUtils.lerp(st, tp, 0.4)],
  (sw, uw, yb, st, tp) => [0.83 * uw, THREE.MathUtils.lerp(st, tp, 0.78)], (sw, uw, yb, st, tp) => [0.45 * uw, tp - 0.0035],
  (sw, uw, yb, st, tp) => [0, tp],
];
function buildShoe(bld, s, S) {
  const ft = 'foot' + S, toe = 'toe' + S, x0 = s * 0.1, nc = SHOE_COLS.length - 1;
  const ZS = [-0.205, -0.2, -0.193, -0.185, -0.175, -0.165, -0.15, -0.135, -0.118, -0.1, -0.08, -0.06, -0.04, -0.02, 0, 0.02, 0.035, 0.048, 0.058, 0.066, 0.071, 0.075];
  const colOf = (k) => (k <= nc ? k : 2 * nc - k);   // ring slot → profile column (outer side first, then back down the inner side)
  const rings = ZS.map((z) => {
    const [sw, uw, st, tp] = SHOE(z), yb = 0.013 * bStep(-z, 0.165, 0.207) + 0.005 * bStep(z, 0.055, 0.076);   // toe spring, heel bevel
    const xo = -0.006 * bStep(-z, 0.1, 0.2), tt = bStep(-z, 0.08, 0.16), w = [[ft, 1 - tt], [toe, tt]], r = [];   // toe box toward the big toe
    for (let k = 0; k < 2 * nc; k++) {
      const [ox, y] = SHOE_COLS[colOf(k)](sw, uw, yb, Math.max(st, yb + 0.012), tp), o = (k <= nc ? 1 : -1) * ox + xo;
      r.push(bld.vert(x0 + s * o, y, z, w, [o, y, z, 2], 0.5 + (y - yb)));
    }
    r.center = [x0 + s * xo, (yb + tp) / 2, z];
    return r;
  });
  // one winding for the whole shoe (from a mid-foot section); bands below the sole line are the sole
  const P = bld.pos, p = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), A0 = rings[10], B0 = rings[11];
  const nrm = new THREE.Vector3().subVectors(p(B0[nc]), p(A0[nc])).cross(new THREE.Vector3().subVectors(p(A0[nc + 1]), p(A0[nc])));
  const flip = nrm.dot(p(A0[nc]).sub(new THREE.Vector3(...bld.fit(...A0.center)))) < 0;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], Bq = rings[i + 1], n = A.length;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n, a = A[k], b = Bq[k], c = A[k1], d = Bq[k1], reg = colOf(k) <= 6 && colOf(k1) <= 6 ? 'sole' : 'shoe';
      if (flip) { bld.tri(a, c, b, reg); bld.tri(c, d, b, reg); } else { bld.tri(a, b, c, reg); bld.tri(c, b, d, reg); }
    }
  }
  bld.cap(rings[0], [x0 - s * 0.006, 0.027, -0.208], [[toe, 1]], 'sole');   // rubber toe bumper
  bld.cap(rings[rings.length - 1], [x0, 0.04, 0.077], [[ft, 1]], 'shoe');
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
  attribute float aRough, aReg, aEdge; attribute vec4 aPar; attribute vec4 aAccent; attribute vec4 aSkin;
  varying float vRough, vReg, vEdge; varying vec4 vPar, vAccent, vSkin; varying vec3 vRest, vHairT;`;
// Strands run down and back over the head: their direction (view space) for the hair's anisotropic highlight.
const HAIR_VERT = `
  vec3 hairT = vec3(0.0, -0.91, 0.41); hairT -= normal * dot(normal, hairT);
  #ifdef USE_SKINNING
    hairT = (skinMatrix * vec4(hairT, 0.0)).xyz;
  #endif
  vHairT = mat3(modelViewMatrix) * hairT;`;
const DETAIL_FRAG = `
  varying float vRough, vReg, vEdge; varying vec4 vPar, vAccent, vSkin; varying vec3 vRest, vHairT;
  // What the pixel being shaded is, for the lighting below: skin, cloth or hair (0..1), its roughness, and the hair's
  // strand direction, highlight shift and tint. aSkin = skin colour (linear) + sweat, so shirts can show bare skin.
  float gSkin = 0.0, gFabric = 0.0, gHair = 0.0, gRough = 0.5, gShift = 0.0;
  vec3 gHairT = vec3(0.0, 1.0, 0.0), gHairTint = vec3(1.0);
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
  // Direct light: skin lets it bleed past the terminator, warmest in the red (a cheap subsurface look); cloth wraps a little.
  vec3 bodyDiffuse(float nl) {
    vec3 w = gSkin * vec3(0.42, 0.2, 0.13) + gFabric * 0.2;
    return clamp((vec3(nl) + w) / (1.0 + w), 0.0, 1.0);
  }
  // Hair: two Kajiya-Kay lobes along the strands, a sharp white one and a broader tinted one shifted toward the tips.
  vec3 hairSpec(vec3 L, vec3 col, vec3 N, vec3 V) {
    if (gHair < 0.5) return vec3(0.0);
    vec3 T = gHairT - N * dot(N, gHairT);
    if (dot(T, T) < 1e-8) return vec3(0.0);
    T = normalize(T);
    vec3 H = normalize(L + V);
    float t1 = dot(normalize(T + N * (gShift - 0.1)), H), t2 = dot(normalize(T + N * (gShift + 0.15)), H);
    float s1 = pow(max(0.0, 1.0 - t1 * t1), 70.0), s2 = pow(max(0.0, 1.0 - t2 * t2), 14.0);
    return col * smoothstep(-0.1, 0.35, dot(N, L)) * (0.07 * s1 + 0.05 * s2 * gHairTint);
  }
  float detailHeight(float near) {
    float h = 0.0, e = vEdge - 0.5;
    float fine = near * (1.0 - smoothstep(0.0012, 0.003, length(fwidth(vRest))));   // millimetre detail only up close
    if (gFabric > 0.5) {                                         // fabric: soft folds, rolled hems, a fine knit
      float fold = cNoise(vec3(vRest.x * 11.0, vRest.y * 38.0, vRest.z * 11.0)) - 0.5;
      float amp = 0.0022;
      if (isReg(1.0) && vPar.w > 2.5 && vPar.w < 3.5) {
        amp *= 0.6 + 0.9 * exp(-pow((vPar.z - 1.03) / 0.07, 2.0));   // gathered above the hem
        vec2 ap = vec2(abs(vRest.x) * vPar.z / vRest.y - 0.2, vPar.z - 1.34);    // drag folds fanning out from the armpits
        h += sin(atan(ap.y, -ap.x) * 9.0 + fold * 3.0) * 0.001 * exp(-dot(ap, ap) / 0.008) * smoothstep(0.035, 0.07, length(ap)) * smoothstep(0.2, 0.6, abs(vPar.y));
      } else if (isReg(2.0) && vPar.w < 0.5) {                   // shorts: creases pulled from the crotch
        float cr = exp(-pow((vPar.z - 0.86) / 0.05, 2.0)) * (1.0 - smoothstep(0.02, 0.08, abs(vRest.x) * vPar.z / vRest.y));
        h += sin((vPar.z + abs(vRest.x) * 1.2) * 150.0 + fold * 4.0) * 0.001 * cr;
      }
      h += fold * amp;
      if (e < 0.03 && vPar.w < 3.5) h += 0.0008 * (1.0 - smoothstep(0.0, 0.012, e)) - 0.00025 * exp(-pow((e - 0.012) / 0.0012, 2.0)) * fine;   // hem: rolled, then stitched
      if (isReg(3.0)) h += 0.00035 * sin(atan(vPar.y, vPar.x) * 56.0) * fine * (e < 0.017 ? 1.8 : 1.0);   // sock ribs, deeper in the cuff
      else if (vPar.w > 4.5 && vPar.w < 5.5) h += 0.0003 * sin(atan(vPar.y, vPar.x) * 90.0) * fine;         // collar ribbing
      else if (isReg(8.0)) h += (cNoise(vRest * 900.0) - 0.5) * 0.0004 * fine;                              // terry towelling
      else h += ((cNoise(vRest * 420.0) - 0.5) * 0.00012 + 0.00006 * sin(vRest.y * 2400.0) * sin((vRest.x + vRest.z) * 2400.0)) * fine;   // knit
    } else if (gSkin > 0.5) {
      h += (cNoise(vRest * 1400.0) - 0.5) * 0.00003 * fine;      // pores
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
  } else if (isReg(4.0) && vPar.w > 1.5) {                       // shoe upper: toe cap, heel counter, laces, collar, side flash
    float sx = vPar.x, sy = vPar.y, sz = vPar.z;                 // metres outward, up and along the foot (toe is -z)
    vec3 c = diffuseColor.rgb;
    if (sz < -0.152) c *= 0.88;                                  // toe cap overlay, stitched on
    c *= 1.0 - 0.35 * exp(-pow((sz + 0.152) / 0.0012, 2.0)) * near;
    if (sz > 0.045 && sy < 0.075) c *= 0.9;                      // heel counter
    float band = abs((sy - 0.028) - (sz + 0.07) * 0.32);
    if (sx > 0.02 && band < 0.0065 && sz > -0.16 && sz < 0.03) c = vAccent.rgb;
    if (abs(sx) < 0.017 && sz > -0.105 && sz < -0.01 && sy > 0.055) {   // tongue with laces across it
      c *= 0.82;
      if (fract(sz / 0.0125) > 0.5 && abs(sx) < 0.0135) c = vec3(0.85, 0.85, 0.83);
    }
    float ank = length(vec2(sx, sz - 0.012));                    // round the ankle: the dark opening, a padded collar
    if (sy > 0.06) c *= mix(0.3, 1.0, smoothstep(0.036, 0.042, ank)) * mix(0.85, 1.0, smoothstep(0.042, 0.05, ank));
    diffuseColor.rgb = c;
  } else if (isReg(1.0)) {                                       // shirt: designs, collar, bare skin in armholes and V-necks
    float d = vAccent.a, y = vPar.z, e = vEdge - 0.5;            // vPar.z is the unscaled height
    bool on = false, body = vPar.w > 2.5 && vPar.w < 3.5;
    if (body || vPar.w < 0.5) {
      if (d > 0.5 && d < 1.5) on = y > 1.405;                                          // shoulder yoke
      else if (d > 1.5 && d < 2.5) on = body && y > 1.245 && y < 1.315;               // chest band
      else if (d > 2.5 && d < 3.5) on = body && abs(vPar.x) > 0.9 && y < 1.33;        // side panels
      if (!body && d > 0.5 && d < 2.5 && e > 0.004 && e < 0.008) on = true;           // tipped cuffs
      // small chest logo, front left: a slanted flash
      float lx = vRest.x + 0.075, ly = y - 1.37;   // the player's left is -x
      if (body && vPar.y < -0.6 && abs(lx) < 0.028 && abs(ly - lx * 0.35) < 0.0065) on = !on;
    } else if (vPar.w > 4.5 && vPar.w < 5.5) {                   // collar: ribbed, tipped in the accent on some designs
      diffuseColor.rgb *= 0.92;
      on = (d > 0.5 && d < 1.5 || d > 2.5) && e < 0.004;
    }
    if (on) diffuseColor.rgb = vAccent.rgb;
    if (body) {
      if (vPar.w > 3.2 && vPar.y < -0.75) {                      // polo placket: stitched strip, two buttons
        float ux = vRest.x * y / vRest.y;
        if (y > 1.37) diffuseColor.rgb *= 1.0 - 0.3 * exp(-pow((abs(ux) - 0.014) / 0.0011, 2.0)) * near;
        float b = min(length(vec2(ux, y - 1.445)), length(vec2(ux, y - 1.412)));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7 + 0.25, (1.0 - smoothstep(0.0038, 0.0048, b)) * near);
      }
      float bare = 1.0 - smoothstep(-fwidth(e), fwidth(e), e);   // past the cloth's edge: skin
      diffuseColor.rgb = mix(diffuseColor.rgb, vSkin.rgb * (0.95 + 0.1 * cNoise(vRest * 38.0)), bare);
      gSkin = bare; gFabric = 1.0 - bare; gRough = mix(gRough, 0.5, bare);
    }
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
// Before DETAIL_ALBEDO: classify the pixel for the lighting.
const DETAIL_INIT = `
  gSkin = isReg(0.0) ? 1.0 : 0.0; gHair = isReg(6.0) ? 1.0 : 0.0; gFabric = (vReg > 0.5 && vReg < 3.5) || isReg(8.0) ? 1.0 : 0.0; gRough = vRough;`;
// After DETAIL_ALBEDO: soles, sock cuffs, hems, sweat and the hair's strand highlight.
const DETAIL_BODY = `
  if (isReg(5.0) && vPar.w > 1.5) {                              // sole: dark tread edge below, a groove along the midsole
    float e = vEdge - 0.5;
    if (e < 0.0088) diffuseColor.rgb = vec3(0.24, 0.24, 0.25) * (0.85 + 0.3 * step(0.5, fract(vPar.z * 140.0 + abs(vPar.x) * 50.0)));
    diffuseColor.rgb *= 1.0 - 0.3 * exp(-pow((e - 0.019) / 0.0012, 2.0)) * near;
    gRough = e < 0.0088 ? 0.85 : 0.6;
  } else if (isReg(3.0) && vEdge - 0.5 < 0.017) {                // sock cuff
    diffuseColor.rgb *= 0.94;
  }
  if (gFabric > 0.5 && (isReg(1.0) || isReg(2.0)) && vPar.w < 3.5) {   // hems: a double layer, then a stitch line
    float e = vEdge - 0.5;
    diffuseColor.rgb *= (1.0 - 0.05 * (1.0 - smoothstep(0.008, 0.012, e))) * (1.0 - 0.28 * exp(-pow((e - 0.012) / 0.0011, 2.0)) * near);
  }
  if (gSkin > 0.5) gRough = mix(gRough, 0.3, vSkin.a * (0.35 + 0.65 * smoothstep(0.35, 0.7, cNoise(vRest * 9.0))));   // sweat: glossy patches
  if (gHair > 0.5) {
    gHairT = vHairT;
    gShift = (cNoise(vec3(vRest.x * 900.0, vRest.y * 60.0, vRest.z * 900.0)) - 0.5) * 0.3;
    gHairTint = diffuseColor.rgb / max(0.02, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));
  }`;
// three's physical direct lighting with the body's diffuse (soft terminator) and the hair highlight added.
const BODY_LIGHT = THREE.ShaderChunk.lights_physical_pars_fragment
  .replace('vec3 irradiance = dotNL * directLight.color;', `vec3 irradiance = dotNL * directLight.color;
	vec3 irradianceD = bodyDiffuse( dot( geometryNormal, directLight.direction ) ) * directLight.color;
	reflectedLight.directSpecular += hairSpec( directLight.direction, directLight.color, geometryNormal, geometryViewDir );`)
  .replace('irradiance *= sheenEnergyComp;', 'irradiance *= sheenEnergyComp; irradianceD *= sheenEnergyComp;')
  .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert', 'reflectedLight.directDiffuse += irradianceD * BRDF_Lambert');

let bodyMat = null;
function bodyMaterial() {
  if (bodyMat) return bodyMat;
  // Physical for the sheen: fabric and skin get a soft rim of light instead of a plastic highlight.
  bodyMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 1, sheen: 1, sheenRoughness: 0.75, sheenColor: 0xffffff });
  bodyMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + DETAIL_VERT)
      .replace('#include <skinnormal_vertex>', '#include <skinnormal_vertex>\n' + HAIR_VERT)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough; vReg = aReg; vEdge = aEdge; vPar = aPar; vRest = position; vAccent = aAccent; vSkin = aSkin;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + DETAIL_FRAG)
      .replace('#include <lights_physical_pars_fragment>', BODY_LIGHT)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + DETAIL_INIT + DETAIL_ALBEDO + DETAIL_BODY)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = bumpNormal(normal, detailHeight(near), faceDirection);')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        float sheenAmt = gFabric * 0.55 + gSkin * 0.12 + gHair * 0.3;
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
  setSkin(g, look);
}
// aSkin: the skin colour everywhere (bare shoulders and V-necks are painted on the shirt) plus the sweat level.
function setSkin(g, look) {
  const a = g.attributes.aSkin, c = new THREE.Color(look.skin);
  if (!a) return;
  for (let i = 0; i < a.count; i++) a.array.set([c.r, c.g, c.b, THREE.MathUtils.clamp(look.sweat ?? 0.3, 0, 1)], i * 4);
  a.needsUpdate = true;
}

// look: { height, width, chest, arm, leg, muscle (0..1), skin, sweat (0..1), hair, hairColor, shirt, pants, shoe, band, accent, design,
//   headband, wristband, sleeve (metres below the shoulder, 0 = sleeveless), collar ('crew' | 'polo' | 'v'), shorts (hem height), sock }
export function createCharacter(opts = {}) {
  const look = {
    height: 1, width: 1, chest: 1, skin: 0xd9a27e, hair: 'short', hairColor: 0x2b1d14, shirt: 0xf2f5ee, pants: 0x1f3b5c, shoe: 0xf4f4f0,
    band: 0xd6f04a, headband: true, wristband: true, sleeve: 0.12, shorts: 0.8, sock: 0.2, arm: 1.14, leg: 1.1, detail: 1,
    collar: 'crew', muscle: 0.5, sweat: 0.3, ...opts,
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
  const n = geo.attributes.position.count;
  geo.setAttribute('aSkin', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  setSkin(geo, look);
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
