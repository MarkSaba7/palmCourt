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

// The head's surface from unit-sphere coordinates (front is -z): skull, jaw and the face's features. The hair
// shell uses it too, pushed outward, so it always sits on the same shape.
function headShape(ux, uy, uz, d) {
  let [x, y, z] = d;
  const f = Math.max(0, -uz), g = (a, w) => Math.exp(-((a / w) ** 2));   // f: how much this point faces forward
  if (uy < 0) { const t = Math.min(1, -uy * 1.2); x *= 1 - 0.3 * t * t; if (uz < 0) z -= 0.01 * t; }   // jaw narrows
  if (uy > 0.1 && uz > 0) z += 0.008 * uy;                                                          // back of the skull
  z -= 0.027 * g(ux, 0.12) * g(uy + 0.28, 0.2) * f;                          // nose, tip below the eyes
  z -= 0.009 * g(ux, 0.08) * g(uy - 0.02, 0.2) * f;                          // bridge
  z -= 0.007 * g(uy - 0.27, 0.07) * g(ux, 0.55) * f;                         // brow ridge
  z += 0.009 * g(Math.abs(ux) - 0.37, 0.13) * g(uy - 0.13, 0.1) * f;         // eye sockets
  x *= 1 + 0.045 * g(uy + 0.05, 0.18) * f;                                   // cheekbones
  z -= 0.006 * g(ux, 0.3) * g(uy + 0.55, 0.14) * f;                          // mouth
  z -= 0.008 * g(ux, 0.22) * g(uy + 0.86, 0.1) * f;                          // chin
  return [x, y, z];
}

const BAND = [1.764, 1.795];   // headband, bottom and top edge heights

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
  bld.loft([
    [1.47, 0.064, 0.063, 0.063, 2, 'skin', [['chest', 0.6], ['neck', 0.4]], 0, 0.01],
    [1.53, 0.062, 0.06, 0.06, 2, 'skin', [['neck', 1]], 0, 0.01],
    [1.585, 0.06, 0.058, 0.058, 2, 'skin', [['neck', 0.5], ['head', 0.5]], 0, 0.008],
    [1.64, 0.05, 0.048, 0.048, 2, 'skin', [['head', 1]], 0, 0.004],
  ], 16);
  const HC = [0, 1.708, -0.006], HR = [0.083, 0.112, 0.099];
  bld.ellipsoid(HC, HR, 40, 56, [['head', 1]], 'skin', { deform: headShape });
  for (const s of [-1, 1]) {
    bld.ellipsoid([s * 0.082, 1.7, 0.006], [0.013, 0.029, 0.02], 6, 10, [['head', 1]], 'skin');
    bld.ellipsoid([s * 0.033, 1.72, -0.0866], [0.0115, 0.0078, 0.006], 8, 12, [['head', 1]], 'eye');
    bld.ellipsoid([s * 0.035, 1.744, -0.093], [0.019, 0.0036, 0.004], 4, 10, [['head', 1]], 'hair');
  }
  // hair: a shell that hugs the skull, thickest on the crown and thinning to nothing at the hairline, so the edge
  // is soft instead of a stepped rim (the shader also fades the colour and strands out toward it)
  const style = look.hair;
  if (style !== 'bald') {
    const buzz = style === 'buzz', line = buzz ? 0.2 : 0.08, bulk = buzz ? 0.004 : 0.013;
    const margin = (u) => u[1] - (line - 0.55 * Math.max(0, u[2]) + (u[2] < 0 ? 0.5 * -u[2] : 0));   // forehead hairline ~7 cm above the eyes
    const edgeOf = (u) => THREE.MathUtils.smoothstep(margin(u), 0, buzz ? 0.08 : 0.2);
    bld.ellipsoid(HC, HR, 30, 44, [['head', 1]], 'hair', {
      keep: (u) => margin(u) > -0.035,
      edge: edgeOf,
      deform(ux, uy, uz, d) {
        const [x, y, z] = headShape(ux, uy, uz, d);   // follows the skull and brow, so no skin shows through
        const e = edgeOf([ux, uy, uz]);
        // volume: fuller on top, a little lift at the front for a short cut, flat over the ears
        let t = 0.0016 + bulk * e * (0.7 + 0.45 * Math.max(0, uy));
        if (!buzz && uz < -0.25 && uy > 0.35) t += 0.006 * e * Math.min(1, (-uz - 0.25) * 2);
        if (Math.abs(ux) > 0.8 && uy < 0.35) t *= 0.55;
        const hy = HC[1] + uy * HR[1];
        if (look.headband && hy > BAND[0] - 0.008 && hy < BAND[1] + 0.008) t = Math.min(t, 0.0028);   // pressed under the band
        const k = 1 + t / 0.095;
        return [x * k, y * k, z * k];
      },
    });
    if (style === 'ponytail') {
      bld.loft([
        [1.73, 0.03, 0.025, 0.025, 2, 'hair', [['head', 1]], 0, 0.1],
        [1.66, 0.034, 0.028, 0.028, 2, 'hair', [['head', 1]], 0, 0.125],
        [1.57, 0.026, 0.022, 0.022, 2, 'hair', [['head', 0.6], ['neck', 0.4]], 0, 0.135],
        [1.5, 0.012, 0.01, 0.01, 2, 'hair', [['neck', 1]], 0, 0.13],
      ], 10);
    }
  }
  if (look.headband) {
    // Two rings laid on the actual head surface (brow ridge included), just outside the pressed-down hair.
    const rings = [BAND[0], BAND[1]].map((y) => {
      const uy = (y - HC[1]) / HR[1], rr = Math.sqrt(1 - uy * uy), out = [];
      for (let k = 0; k < 40; k++) {
        const th = (k / 40) * Math.PI * 2, ux = rr * Math.cos(th), uz = rr * Math.sin(th);
        const [x, yy, z] = headShape(ux, uy, uz, [ux * HR[0], uy * HR[1], uz * HR[2]]), kk = 1 + 0.0055 / 0.095;
        out.push(bld.vert(HC[0] + x * kk, HC[1] + yy * kk, HC[2] + z * kk, [['head', 1]], [Math.cos(th), Math.sin(th), y, 0]));
      }
      out.center = [HC[0], y, HC[2]];
      return out;
    });
    bld.strip(rings[0], rings[1], 'band');
  }
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
  if (vReg > 0.5 && vReg < 2.5) diffuseColor.rgb *= 0.97 + 0.06 * cNoise(vec3(vRest.x * 11.0, vRest.y * 38.0, vRest.z * 11.0));`;

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

const regionColors = (look) => [look.skin, look.shirt, look.pants, 0xf3f3ee, look.shoe, 0xf0efe8, look.hairColor, 0x121212, look.band];

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
