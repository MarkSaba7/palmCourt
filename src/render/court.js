// The court: surfaces (hard, clay, grass), line paint, net with ripples, posts, ball marks.
import * as THREE from 'three';
import { COURT, netHeight, lerp } from '../core.js';
import { scene } from './renderer.js';
import { gpuTexture, normalFromHeight } from './textures.js';
import { Perf } from './renderer.js';

// Ground covers the playing area plus run-off, x -12..12 and z -22..22 metres.
export const GROUND = { w: 24, l: 44 };

const LOOK = {
  hard:  { inner: '#23578f', outer: '#3a6c4e', line: '#f3f5f0', rough: 0.84, lineRough: 0.52, detailM: 2.0, normal: 0.5 },
  clay:  { inner: '#b65a36', outer: '#b25735', line: '#efe9dd', rough: 0.95, lineRough: 0.85, detailM: 1.4, normal: 1.3 },
  grass: { inner: '#467f33', outer: '#437b31', line: '#fbfbf5', rough: 0.9,  lineRough: 0.8,  detailM: 0.9, normal: 1.1 },
};
const hexVec = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };   // THREE.Color is already linear

// Macro albedo for the whole ground: court colours, variation, wear where players stand and run.
const ALBEDO = `
uniform vec3 uInner, uOuter; uniform float uKind;
vec2 W() { return vec2(vUv.x * 24.0 - 12.0, 22.0 - vUv.y * 44.0); }
float ellipseMask(vec2 p, vec2 c, vec2 r) { vec2 d = (p - c) / r; return exp(-dot(d, d)); }
float baseWear(vec2 w) {
  float m = 0.0;
  for (int s = -1; s <= 1; s += 2) {
    float fs = float(s);
    m += ellipseMask(w, vec2(0.0, fs * 12.3), vec2(3.6, 1.35));            // behind the baseline, centre
    m += 0.55 * ellipseMask(w, vec2(2.2, fs * 12.0), vec2(1.8, 1.1));      // deuce and ad positions
    m += 0.55 * ellipseMask(w, vec2(-2.2, fs * 12.0), vec2(1.8, 1.1));
    m += 0.25 * ellipseMask(w, vec2(0.0, fs * 6.9), vec2(1.2, 0.8));       // service T approach
  }
  return clamp(m, 0.0, 1.0);
}
void main() {
  vec2 w = W();
  bool inside = abs(w.x) <= 5.485 && abs(w.y) <= 11.885;
  vec3 c = inside ? uInner : uOuter;
  float wear = baseWear(w) * (0.55 + 0.9 * fbm(w * 1.3));
  if (uKind < 0.5) {                       // hard court: acrylic with sand, scuffed baselines
    c *= 1.0 + (fbm(w * 0.28) - 0.5) * 0.08;
    c *= 1.0 + (hash12(floor(w * 300.0)) - 0.5) * 0.05;
    c = mix(c, c * 1.18 + 0.006, wear * 0.45);
    float streak = pow(vnoise(vec2(w.x * 2.2, w.y * 0.35) + 3.0), 5.0) * wear;
    c *= 1.0 - streak * 0.45;
  } else if (uKind < 1.5) {                // clay: damp patches, brushing arcs, scuffed baselines
    c *= 1.0 + (fbm(w * 0.22) - 0.5) * 0.18;
    float damp = smoothstep(0.55, 0.8, fbm(w * 0.16 + 7.0));
    c *= 1.0 - damp * 0.14;
    float arc = sin(length(w - vec2(0.0, 30.0)) * 7.5 + fbm(w * 0.8) * 3.0);
    c *= 1.0 + arc * 0.025;
    c = mix(c, c * vec3(1.14, 1.1, 1.08) + 0.01, wear * 0.55);
    c *= 1.0 + (hash12(floor(w * 220.0)) - 0.5) * 0.12;
  } else {                                 // grass: mowing stripes, bare earth behind the baselines
    float stripe = step(0.5, fract(w.y / 2.3));
    c *= mix(0.9, 1.1, stripe);
    c *= 1.0 + (fbm(w * 0.5) - 0.5) * 0.16;
    vec3 earth = srgb2lin(vec3(0.52, 0.42, 0.28));
    float bare = smoothstep(0.35, 0.85, wear * (0.7 + 0.6 * fbm(w * 3.0)));
    c = mix(c, earth, bare * 0.85);
    c = mix(c, c * vec3(1.08, 1.05, 0.8), wear * 0.35);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

// Tiling micro detail (height in 0..1) for each surface.
const HEIGHTS = {
  hard: `float height(vec2 uv) { vec2 p = uv * 64.0; return 0.55 * tnoise(p, vec2(64.0)) + 0.45 * tnoise(p * 3.0, vec2(192.0)); }`,
  clay: `float height(vec2 uv) { vec2 p = uv * 40.0; float g = 1.0 - tcell(p, vec2(40.0)); return 0.6 * g * g + 0.4 * tfbm(uv * 16.0, vec2(16.0)); }`,
  grass: `float height(vec2 uv) { vec2 p = uv * vec2(90.0, 22.0); float b = tnoise(p, vec2(90.0, 22.0)); float t = 1.0 - tcell(uv * 24.0, vec2(24.0)); return 0.65 * b + 0.35 * t; }`,
};

const group = new THREE.Group();
let groundMat = null, lineMat = null, detailTex = {}, albedoTex = {};

function albedoFor(kind) {
  if (albedoTex[kind]) return albedoTex[kind];
  const L = LOOK[kind], big = Perf.cfg().detail >= 2;
  albedoTex[kind] = gpuTexture({
    width: big ? 2048 : 1024, height: big ? 4096 : 2048, fragment: ALBEDO,
    uniforms: { uInner: { value: hexVec(L.inner) }, uOuter: { value: hexVec(L.outer) }, uKind: { value: kind === 'hard' ? 0 : kind === 'clay' ? 1 : 2 } },
  });
  return albedoTex[kind];
}
function detailFor(kind) {
  if (!detailTex[kind]) detailTex[kind] = normalFromHeight({ size: 1024, heightGlsl: HEIGHTS[kind], strength: LOOK[kind].normal });
  return detailTex[kind];
}

function buildSurface(kind) {
  for (const o of [...group.children]) { group.remove(o); o.geometry.dispose(); }
  const L = LOOK[kind];
  // Use the render-target texture itself: a clone of one has no GPU data and samples as black, which decodes to
  // normals pointing into the ground (no sunlight at all). Each surface has its own texture, so repeat is safe here.
  const detail = detailFor(kind);
  detail.repeat.set(GROUND.w / L.detailM, GROUND.l / L.detailM);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  groundMat = new THREE.MeshStandardMaterial({ map: albedoFor(kind), roughness: L.rough, normalMap: detail, normalScale: new THREE.Vector2(1, 1), envMapIntensity: kind === 'hard' ? 0.45 : 0.35 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND.w, GROUND.l), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);
  lineMat = new THREE.MeshStandardMaterial({ color: L.line, roughness: L.lineRough, normalMap: detail, normalScale: new THREE.Vector2(0.5, 0.5), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const rect = (x0, x1, z0, z1) => {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    // Detail UVs follow world position so the line paint shares the ground's grain.
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, ((x0 + (x1 - x0) * uv.getX(i)) + 12) / GROUND.w, (22 - (z1 - (z1 - z0) * uv.getY(i))) / GROUND.l);
    const m = new THREE.Mesh(g, lineMat);
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, 0.004, (z0 + z1) / 2); m.receiveShadow = true;
    group.add(m);
  };
  const { halfL: hl, halfSW: hs, halfDW: hd, svc } = COURT, lw = 0.05, bw = 0.08;
  for (const s of [-1, 1]) {
    const inner = (edge, w) => (s > 0 ? [edge - w, edge] : [-edge, -edge + w]);
    const [b0, b1] = inner(hl, bw); rect(-hd, hd, b0, b1);
    const [d0, d1] = inner(hd, lw); rect(d0, d1, -hl, hl);
    const [s0, s1] = inner(hs, lw); rect(s0, s1, -hl, hl);
    const [v0, v1] = inner(svc, lw); rect(-hs, hs, v0, v1);
    const [c0, c1] = inner(hl - bw, 0.1); rect(-lw / 2, lw / 2, c0, c1);
  }
  rect(-lw / 2, lw / 2, -svc, svc);
}

// ---------- net ----------
export const Net3D = { mesh: null, mat: null, hit: new THREE.Vector4(0, 0, -99, 0), dir: { value: 1 } };
function buildNet() {
  const g = new THREE.Group(), X0 = -COURT.postX, X1 = COURT.postX, segX = 96, segY = 10;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= segY; j++) for (let i = 0; i <= segX; i++) {
    const x = lerp(X0, X1, i / segX), top = netHeight(x) - 0.06, y = lerp(0.03, top, j / segY);
    pos.push(x, y, 0); uv.push(x, y);
  }
  for (let j = 0; j < segY; j++) for (let i = 0; i < segX; i++) {
    const a = j * (segX + 1) + i, b = a + 1, c = a + segX + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.85, side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const hit = Net3D.hit;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHit = { value: hit };
    sh.uniforms.uDir = Net3D.dir;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uHit;\nuniform float uDir;\nvarying vec2 vNetUv;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vNetUv = uv;
        float age = uHit.w - uHit.z;
        if (age >= 0.0 && age < 2.5) {
          float d = distance(position.xy, uHit.xy);
          transformed.z += uDir * 0.1 * exp(-age * 3.2) * exp(-d * 1.4) * cos(age * 22.0 - d * 9.0);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vNetUv;')
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        vec2 cell = vNetUv / 0.045;
        vec2 f = abs(fract(cell) - 0.5), fw = fwidth(cell);
        // Cords sit on the cell edges (f near 0.5): open 4.5 cm squares with thin cord. Far away, where the cells
        // are smaller than a pixel, fade to the mesh's average coverage instead of shimmering.
        vec2 lines = smoothstep(0.5 - 0.055 - fw, 0.5 - 0.055 + fw, f);
        float cover = clamp(max(lines.x, lines.y), 0.0, 1.0);
        diffuseColor.a *= mix(cover, 0.3, clamp(max(fw.x, fw.y) * 1.6 - 0.25, 0.0, 1.0));`);
  };
  const net = new THREE.Mesh(geo, mat);
  net.renderOrder = 2;
  g.add(net);
  Net3D.mesh = net; Net3D.mat = mat;
  const white = new THREE.MeshStandardMaterial({ color: 0xf6f6f1, roughness: 0.75, side: THREE.DoubleSide });
  // Tape: a thin box following the sag of the cable.
  const tape = [];
  for (let i = 0; i <= 64; i++) {
    const x = lerp(X0, X1, i / 64), h = netHeight(x);
    tape.push(new THREE.Vector3(x, h - 0.03, 0));
  }
  const tapeGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tape), 96, 0.032, 8, false);
  tapeGeo.scale(1, 1, 0.3);
  const tapeMesh = new THREE.Mesh(tapeGeo, white);
  tapeMesh.castShadow = true;
  g.add(tapeMesh);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, COURT.netC - 0.05, 0.012), white);
  strap.position.set(0, (COURT.netC - 0.05) / 2, 0); strap.castShadow = true;
  g.add(strap);
  const anchor = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.5, metalness: 0.6 }));
  anchor.position.set(0, 0.015, 0);
  g.add(anchor);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x163a31, roughness: 0.35, metalness: 0.55 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xd9dcd6, roughness: 0.3, metalness: 0.8 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 1.12, 20), postMat);
    post.position.set(s * COURT.postX, 0.56, 0); post.castShadow = true; post.receiveShadow = true;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.046, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
    cap.position.set(s * COURT.postX, 1.12, 0);
    const winder = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 10), capMat);
    winder.rotation.x = Math.PI / 2; winder.position.set(s * COURT.postX, 0.9, 0.07);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.09, 0.015), capMat);
    handle.position.set(s * COURT.postX, 0.86, 0.135);
    g.add(post, cap, winder, handle);
  }
  scene.add(g);
}

// Ball marks: small scuffs where the ball lands (lasting on clay, faint elsewhere).
const Marks = { list: [], i: 0, mat: null, surface: 'hard' };
function buildMarks() {
  Marks.mat = new THREE.MeshStandardMaterial({ color: 0x7a391c, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const geo = new THREE.CircleGeometry(0.5, 20);
  for (let k = 0; k < 24; k++) {
    const m = new THREE.Mesh(geo, Marks.mat.clone());
    m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.visible = false; m.receiveShadow = true;
    scene.add(m); Marks.list.push(m);
  }
}
export function addBallMark(x, z, vx, vz, surface) {
  const m = Marks.list[Marks.i++ % Marks.list.length];
  const sp = Math.hypot(vx, vz);
  m.visible = true; m.position.x = x; m.position.z = z;
  m.rotation.z = Math.atan2(vx, vz);
  m.scale.set(0.066, 0.1 + Math.min(0.1, sp * 0.004), 1);
  if (surface === 'clay') { m.material.color.set(0x7a391c); m.material.opacity = 0.55; }
  else if (surface === 'grass') { m.material.color.set(0x2f5a22); m.material.opacity = 0.25; }
  else { m.material.color.set(0x0f2a45); m.material.opacity = 0.12; }
  m.userData.born = performance.now();
}
// Slide marks on clay: long scuffs where a player brakes hard, pooled like the ball marks.
const Skids = { list: [], i: 0 };
export function addSkidMark(x, z, dx, dz, len) {
  if (!Skids.list.length) {
    const geo = new THREE.CircleGeometry(0.5, 20), mat = new THREE.MeshStandardMaterial({ color: 0x6e3318, roughness: 1, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    for (let k = 0; k < 30; k++) { const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.visible = false; m.receiveShadow = true; scene.add(m); Skids.list.push(m); }
  }
  const m = Skids.list[Skids.i++ % Skids.list.length];
  m.visible = true; m.position.x = x; m.position.z = z;
  m.rotation.z = Math.atan2(dx, dz);
  m.scale.set(0.13, len, 1);
}
export function clearBallMarks() { for (const m of Marks.list) m.visible = false; for (const m of Skids.list) m.visible = false; }

export const World = {
  surface: null,
  init() { scene.add(group); buildNet(); buildMarks(); },
  setSurface(kind) {
    if (kind === this.surface) return;
    this.surface = kind;
    buildSurface(kind);
    clearBallMarks();
    for (const fn of this.listeners) fn(kind);
  },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  netHit(x, y, t, dir) { Net3D.hit.set(x, y, t, t); Net3D.dir.value = dir < 0 ? -1 : 1; },
  update(t) {
    const h = Net3D.hit;
    if (h.z > -50) { h.w = t; if (t - h.z > 2.5) h.z = -99; }
  },
};
