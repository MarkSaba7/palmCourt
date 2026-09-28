// Tennis racket: a 27 inch frame swept from one bevelled beam profile (egg-shaped hoop, bridge and an open throat
// whose arms leave the hoop at the shoulders and meet in the shaft), a see-through string bed with a stencil, an
// octagonal overgrip and a flared butt cap. Three draw calls (frame, grip, strings); the paint is baked into the
// frame's vertex colours, so a new paint is a new racket (progress-ui setRacket).
// Built along local -y from the butt cap (y = +0.095) so it can hang off a hand bone; the head centre is at y = -0.46.
import * as THREE from 'three';
import { canvasTex } from './textures.js';

const HEAD_Y = -0.46, RX = 0.124, RY = 0.162;   // centre line of the head's beam
const BEAM = { w: 0.0135, d: 0.024 };           // head beam: across the ring, and deep (along the string-bed normal)
const BRIDGE = { w: 0.0115, d: 0.0185 };        // the bridge (yoke) closing the string bed at the throat end
const ARM_END = { w: 0.0122, d: 0.02, x: 0.0062, y: -0.2 };   // where the two throat arms meet in the shaft
const SHOULDER = 0.98;                          // where the arms leave the hoop (rad from the throat end)
const GRIP = { r: 0.0169, top: -0.136, end: 0.076 };
const Z = new THREE.Vector3(0, 0, 1);

// Head centre line: a slightly squared egg, wider toward the tip. t = 0 at the throat end, t = PI at the tip.
function headPt(t) {
  const s = Math.sin(t), c = Math.cos(t), e = 2 / 2.25;
  return new THREE.Vector2(RX * Math.sign(s) * Math.abs(s) ** e * (1 - 0.045 * c), HEAD_Y + RY * Math.sign(c) * Math.abs(c) ** e);
}

// Beam cross-section: a rounded box (superellipse), unit size, with its normals. u across (N), v along the face normal.
function section(n, p) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const u = 0.5 * Math.sign(c) * Math.abs(c) ** (2 / p), v = 0.5 * Math.sign(s) * Math.abs(s) ** (2 / p);
    const nu = Math.sign(u) * Math.abs(2 * u) ** (p - 1), nv = Math.sign(v) * Math.abs(2 * v) ** (p - 1);
    out.push({ u, v, nu, nv });
  }
  return out;
}
const BEVEL = section(16, 3.2), ROUND = section(16, 2);

// One mesh's worth of positions/normals/colours/uvs, filled by sweeps and plain geometries, then built once.
class Parts {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; }
  get n() { return this.pos.length / 3; }
  vert(p, nr, c, u = 0, v = 0) { this.pos.push(p.x, p.y, p.z); this.nor.push(nr.x, nr.y, nr.z); this.col.push(c.r, c.g, c.b); this.uv.push(u, v); }
  // rings: [{ p: Vector3, t: unit tangent, n: unit normal across (in the ring's plane), w, d, ...}]. colour(ring, s) per
  // vertex. A ring repeated with another colour makes a sharp paint edge.
  sweep(rings, sec, colour, { closed = false, caps = [] } = {}) {
    const base = this.n, m = sec.length, p = new THREE.Vector3(), nr = new THREE.Vector3();
    // Faces wind outward when n is on the t x z side; flip them when a sweep's n points the other way.
    const flip = nr.copy(rings[0].t).cross(Z).dot(rings[0].n) < 0;
    for (const r of rings) {
      for (const s of sec) {
        p.copy(r.p).addScaledVector(r.n, s.u * r.w).addScaledVector(Z, s.v * r.d);
        nr.copy(r.n).multiplyScalar(s.nu / r.w).addScaledVector(Z, s.nv / r.d).normalize();
        this.vert(p, nr, colour(r, s));
      }
    }
    const R = rings.length;
    for (let i = 0; i < (closed ? R : R - 1); i++) {
      const i2 = (i + 1) % R;
      for (let j = 0; j < m; j++) {
        const j2 = (j + 1) % m, a = base + i * m + j, b = base + i2 * m + j, c = base + i * m + j2, d = base + i2 * m + j2;
        if (flip) this.idx.push(a, c, b, b, c, d); else this.idx.push(a, b, c, b, d, c);
      }
    }
    // Flat end caps: a fan facing out along -t (first ring) or +t (last ring).
    for (const k of caps) {
      const r = rings[k === 'start' ? 0 : R - 1], dir = k === 'start' ? -1 : 1, ctr = this.n;
      nr.copy(r.t).multiplyScalar(dir);
      this.vert(r.p, nr, colour(r, { u: 0, v: 0, nu: 0, nv: 0 }));
      const first = this.n;
      for (const s of sec) { p.copy(r.p).addScaledVector(r.n, s.u * r.w).addScaledVector(Z, s.v * r.d); this.vert(p, nr, colour(r, s)); }
      for (let j = 0; j < m; j++) { const a = first + j, b = first + ((j + 1) % m); if ((dir > 0) !== flip) this.idx.push(ctr, b, a); else this.idx.push(ctr, a, b); }
    }
  }
  // A plain THREE geometry in one colour, placed by matrix.
  add(g, c, mat) {
    if (mat) g.applyMatrix4(mat);
    const base = this.n, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, p = new THREE.Vector3(), nr = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) this.vert(p.fromBufferAttribute(P, i), nr.fromBufferAttribute(N, i), c, U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    g.dispose();
  }
  build(uv) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    else g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// Rings along a straight run up the racket's axis (shaft cone, tape, butt cap): w/d from a list of [y, w, d].
function axisRings(list) {
  return list.map(([y, w, d, tag]) => ({ p: new THREE.Vector3(0, y, 0), t: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(1, 0, 0), w, d, tag }));
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The head loop, resampled evenly by length, plus repeated rings at the paint edges.
const STRIPE = [1.3, 1.92];   // accent band on the frame's faces, both sides (rad from the throat end)
function headRings(segs) {
  const fine = [], K = 2048;
  let len = 0, prev = headPt(0);
  for (let i = 0; i <= K; i++) { const t = (i / K) * Math.PI * 2, q = headPt(t); len += q.distanceTo(prev); fine.push({ t, len }); prev = q; }
  const ts = [];
  for (let i = 0, k = 0; i < segs; i++) { const L = (i / segs) * len; while (fine[k + 1].len < L) k++; const f = (L - fine[k].len) / (fine[k + 1].len - fine[k].len || 1); ts.push(fine[k].t + f * (fine[k + 1].t - fine[k].t)); }
  const edges = [STRIPE[0], STRIPE[1], Math.PI * 2 - STRIPE[1], Math.PI * 2 - STRIPE[0]];
  for (const e of edges) ts.push(e - 1e-4, e + 1e-4);
  ts.sort((a, b) => a - b);
  const ctr = new THREE.Vector2(0, HEAD_Y);
  return ts.map((t) => {
    const q = headPt(t), q2 = headPt(t + 1e-3), tan = q2.clone().sub(headPt(t - 1e-3)).normalize();
    let n = new THREE.Vector2(tan.y, -tan.x);
    if (n.dot(q.clone().sub(ctr)) < 0) n.negate();   // n points out of the head
    const fromThroat = Math.min(t, Math.PI * 2 - t), b = smooth(SHOULDER + 0.05, SHOULDER - 0.2, fromThroat);   // 1 on the bridge
    const d = BEAM.d * (1 - 0.14 * smooth(1.7, Math.PI, fromThroat));   // the beam thins toward the tip
    return { p: new THREE.Vector3(q.x, q.y, 0), t: new THREE.Vector3(tan.x, tan.y, 0), n: new THREE.Vector3(n.x, n.y, 0), w: BEAM.w + (BRIDGE.w - BEAM.w) * b, d: d + (BRIDGE.d - d) * b, th: fromThroat, bridge: b > 0.5, stripe: fromThroat > STRIPE[0] && fromThroat < STRIPE[1] };
  });
}

// A throat arm: leaves the hoop at the shoulder along the hoop's own direction, curves in and runs into the shaft.
function armRings(side, segs) {
  const t0 = side > 0 ? SHOULDER : Math.PI * 2 - SHOULDER, s = headPt(t0);
  const d0 = headPt(t0 - side * 1e-3).sub(headPt(t0 + side * 1e-3)).normalize();   // toward the throat end
  const e = new THREE.Vector2(side * ARM_END.x, ARM_END.y);
  const c1 = s.clone().addScaledVector(d0, 0.075), c2 = e.clone().add(new THREE.Vector2(0, -0.07));
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs, a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, d = u ** 3;
    pts.push({ q: new THREE.Vector2(a * s.x + b * c1.x + c * c2.x + d * e.x, a * s.y + b * c1.y + c * c2.y + d * e.y), u });
  }
  pts.push({ q: new THREE.Vector2(side * ARM_END.x, -0.17), u: 1 }, { q: new THREE.Vector2(side * ARM_END.x, -0.15), u: 1 });
  return pts.map((o, i) => {
    const a = pts[Math.max(0, i - 1)].q, b = pts[Math.min(pts.length - 1, i + 1)].q, tan = b.clone().sub(a).normalize();
    const k = smooth(0, 1, o.u);
    return { p: new THREE.Vector3(o.q.x, o.q.y, 0), t: new THREE.Vector3(tan.x, tan.y, 0), n: new THREE.Vector3(tan.y, -tan.x, 0), w: BEAM.w + (ARM_END.w - BEAM.w) * k, d: BEAM.d + (ARM_END.d - BEAM.d) * k };
  });
}

const lin = (hex) => new THREE.Color(hex);
const rgbDist = (a, b) => { const p = new THREE.Color(a), q = new THREE.Color(b); return Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b); };

// ---- textures (cached: the grip's is shared; strings per string + stencil colour) ----
let gripTex = null;
const stringTexs = new Map();
function gripTexture() {
  if (gripTex) return gripTex;
  // Overgrip wound up the handle: each turn overlaps the last (a shadow line at the edge, a soft ridge), with pin-hole
  // perforations. Stripes follow fract(v * turns + u), so they meet up round the octagon's seam.
  gripTex = canvasTex(64, 512, (x, W, H) => {
    const img = x.createImageData(W, H), d = img.data, TURNS = 8;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const f = (((1 - j / H) * TURNS + i / W) % 1 + 1) % 1;
      let l = 0.93 + 0.05 * Math.sin(f * Math.PI) - 0.22 * Math.exp(-((f - 0.02) ** 2) / 0.0006) - 0.08 * Math.exp(-((f - 0.97) ** 2) / 0.0008);
      if (f > 0.25 && f < 0.8 && Math.abs(((i / W) * 32) % 1 - 0.5) < 0.16 && Math.abs(((f * 6) % 1) - 0.5) < 0.12) l -= 0.1;   // perforations
      const k = (j * W + i) * 4, v = Math.round(255 * Math.min(1, Math.max(0, l)));
      d[k] = v; d[k + 1] = v; d[k + 2] = Math.round(v * 0.985); d[k + 3] = 255;
    }
    x.putImageData(img, 0, 0);
  });
  return gripTex;
}
// The string bed: 16 mains x 19 crosses, woven (every other crossing the main passes over), rounded strings, and a
// stencil painted on the strings only: a fictional maker's mark (two chevrons pointing at the tip) that reads the same
// mirrored, for left-handers and from behind.
function stringTexture(col, stencil) {
  const key = col + ':' + stencil;
  if (stringTexs.has(key)) return stringTexs.get(key);
  const css = (h) => '#' + new THREE.Color(h).getHexString();
  const t = canvasTex(256, 336, (x, W, H) => {
    x.clearRect(0, 0, W, H);
    const MAINS = 16, CROSS = 19, lw = 2.6;
    const mx = (i) => ((i + 0.5) / MAINS) * W, cy = (j) => ((j + 0.5) / CROSS) * H;
    const main = (i, y0, y1) => { x.fillRect(mx(i) - lw / 2, y0, lw, y1 - y0); };
    x.fillStyle = css(col);
    for (let j = 0; j < CROSS; j++) x.fillRect(0, cy(j) - lw / 2, W, lw);
    for (let i = 0; i < MAINS; i++) main(i, 0, H);
    // The weave: where a cross passes over a main, the cross goes on top, shading the main either side of it.
    for (let i = 0; i < MAINS; i++) for (let j = 0; j < CROSS; j++) {
      if ((i + j) % 2) continue;
      x.globalCompositeOperation = 'source-atop';
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(mx(i) - lw, cy(j) - lw / 2 - 1, lw * 2, 1); x.fillRect(mx(i) - lw, cy(j) + lw / 2, lw * 2, 1);
      x.globalCompositeOperation = 'source-over';
      x.fillStyle = css(col); x.fillRect(mx(i) - lw, cy(j) - lw / 2, lw * 2, lw);
    }
    // Stencil: only where there's string.
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = css(stencil); x.globalAlpha = 0.6;
    const chev = (yTip, h, th) => {
      const w = W * 0.24;
      x.beginPath(); x.moveTo(W / 2, yTip); x.lineTo(W / 2 - w, yTip - h); x.lineTo(W / 2 - w, yTip - h - th); x.lineTo(W / 2, yTip - th); x.lineTo(W / 2 + w, yTip - h - th); x.lineTo(W / 2 + w, yTip - h); x.closePath(); x.fill();
    };
    chev(H * 0.68, H * 0.15, H * 0.07);
    chev(H * 0.55, H * 0.15, H * 0.07);
    x.globalAlpha = 1;
    // Round strings: lighter down the middle of each (the canvas's alpha stays as drawn).
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < MAINS; i++) x.fillRect(mx(i) - 0.5, 0, 1, H);
    x.globalCompositeOperation = 'source-over';
  });
  t.generateMipmaps = true;
  stringTexs.set(key, t);
  return t;
}

export function makeRacket({ frame = 0x1b2026, accent = 0xd6f04a, strings = 0xf4f2e6, grip = null } = {}) {
  const F = lin(frame), A = lin(accent), G = lin(0x25272b), T = lin(0x17191c);
  // ---- frame: hoop + bridge, two throat arms, the shaft flaring into the handle, finishing tape, butt cap, dampener
  const fp = new Parts();
  fp.sweep(headRings(132), BEVEL, (r, s) => {
    if (r.stripe && Math.abs(s.nv) > 0.5) return A;                   // paint band on both faces
    if (!r.bridge && s.nu > 0.55 && Math.abs(s.v) < 0.38) return G;    // grommet strip round the outside
    if (r.th > Math.PI - 0.75 && s.nu > 0.2) return G;                 // bumper guard over the tip
    return F;
  }, { closed: true });
  for (const side of [-1, 1]) fp.sweep(armRings(side, 26), BEVEL, () => F);
  // Shaft: the two arms (a flat 25 x 20 mm beam here) flare into the handle's width, then a band of finishing tape.
  const cone = axisRings([[-0.205, 0.023, 0.018], [-0.19, 0.0245, 0.0195], [-0.175, 0.0265, 0.022], [-0.162, 0.03, 0.027], [-0.152, 0.0338, 0.0328], [-0.146, 0.0346, 0.0346]]);
  fp.sweep(cone, BEVEL, () => F, { caps: ['start'] });
  fp.sweep(axisRings([[-0.146, 0.0352, 0.0352], [-0.131, 0.0352, 0.0352]]), ROUND, () => T);
  // Butt cap: flares past the grip, rounded over at the end, in the accent colour.
  const cap = axisRings([[0.072, 0.0342, 0.0342], [0.08, 0.0356, 0.0356], [0.0875, 0.0366, 0.0366], [0.0925, 0.036, 0.036], [0.0955, 0.0328, 0.0328], [0.0968, 0.028, 0.028]]);
  fp.sweep(cap, ROUND, () => A, { caps: ['end'] });
  // Dampener: a little button on the strings just inside the bridge.
  fp.add(new THREE.CapsuleGeometry(0.0045, 0.012, 3, 8).rotateZ(Math.PI / 2).scale(1, 1, 0.9), A, new THREE.Matrix4().makeTranslation(0, headPt(0).y - 0.028, 0));
  const frameMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.08, clearcoat: 1, clearcoatRoughness: 0.16 });
  const frameMesh = new THREE.Mesh(fp.build(false), frameMat);
  frameMesh.castShadow = true;

  // ---- grip: an octagonal handle (flat bevels) under the wound overgrip ----
  const gp = new Parts(), white = new THREE.Color(1, 1, 1), p = new THREE.Vector3(), nr = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    const a0 = ((k - 0.5) / 8) * Math.PI * 2, a1 = ((k + 0.5) / 8) * Math.PI * 2, am = (k / 8) * Math.PI * 2;
    nr.set(Math.cos(am), 0, Math.sin(am));
    const base = gp.n;
    for (const [a, u] of [[a0, k / 8], [a1, (k + 1) / 8]]) for (const [y, v] of [[GRIP.top, 1], [GRIP.end, 0]]) gp.vert(p.set(Math.cos(a) * GRIP.r, y, Math.sin(a) * GRIP.r), nr, white, u, v);
    gp.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const gt = gripTexture();
  const gripMat = new THREE.MeshStandardMaterial({ map: gt, bumpMap: gt, bumpScale: 0.6, color: grip ?? 0xffffff, roughness: 0.85 });
  const gripMesh = new THREE.Mesh(gp.build(true), gripMat);
  gripMesh.castShadow = true;

  // ---- strings: the head's inside, see-through (a faint film far away, single strings up close) ----
  const loop = headRings(96).filter((r, i, a) => i === 0 || r.p.distanceToSquared(a[i - 1].p) > 1e-10);
  const shape = new THREE.Shape(loop.map((r) => new THREE.Vector2(r.p.x, r.p.y)));
  const sg = new THREE.ShapeGeometry(shape, 1);
  sg.computeBoundingBox();
  const bb = sg.boundingBox, P = sg.attributes.position, uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) { uv[i * 2] = (P.getX(i) - bb.min.x) / (bb.max.x - bb.min.x); uv[i * 2 + 1] = (P.getY(i) - bb.min.y) / (bb.max.y - bb.min.y); }
  sg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const stencil = rgbDist(accent, strings) > 0.35 ? accent : rgbDist(frame, strings) > 0.35 ? frame : 0x2a2c30;
  const st = stringTexture(strings, stencil);
  const strMat = new THREE.MeshStandardMaterial({ map: st, roughness: 0.55, transparent: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide });
  const strMesh = new THREE.Mesh(sg, strMat);
  // Its shadow only where the strings are solid (mostly none: at shadow-map resolution a string bed is a faint film).
  strMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: st, alphaTest: 0.5, side: THREE.DoubleSide });

  const g = new THREE.Group();
  g.add(frameMesh, gripMesh, strMesh);
  g.userData.headCenter = new THREE.Vector3(0, HEAD_Y, 0);
  return g;
}
