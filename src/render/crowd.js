// Spectators: thousands of seated people in one instanced mesh. The vertex shader turns their heads toward the
// ball, makes them clap and cheer, stands some of them up for big points and adds a little idle sway.
import * as THREE from 'three';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';
import { Clock } from '../core.js';
import { scene, camera, renderer } from './renderer.js';

// Parts: 0 body, 1 head, 2 left arm, 3 right arm, 4 hat. Colour selectors: 0 shirt, 1 skin, 2 hair, 3 pants, 4 hat.
function part(geo, pt, sel) {
  geo.deleteAttribute('uv');
  if (!geo.index) geo = BGU.mergeVertices(geo, 1e-4);   // shared vertices: a third of the vertex work
  const n = geo.attributes.position.count;
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(pt), 1));
  geo.setAttribute('aSel', new THREE.Float32BufferAttribute(new Float32Array(n).fill(sel), 1));
  return geo;
}
const _up = new THREE.Vector3(0, 1, 0);
// A tapered limb from a to b (radius r0 at a, r1 at b).
function limb(a, b, r0, r1, radial, pt, sel, open = true) {
  const A = new THREE.Vector3(...a), d = new THREE.Vector3(...b).sub(A), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, open);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()));
  g.translate(A.x, A.y, A.z);
  return part(g, pt, sel);
}
function blob(c, r, s, pt, sel, w = 6, h = 4) { const g = new THREE.SphereGeometry(r, w, h); g.scale(...s); g.translate(...c); return part(g, pt, sel); }
// A seated spectator from rounded, low-poly parts (~550 vertices): hands rest on the thighs, and the arms pivot at
// the shoulders for clapping and cheering.
function personGeometry() {
  const torso = new THREE.CylinderGeometry(0.17, 0.145, 0.5, 10, 1, true); torso.scale(1, 1, 0.62); torso.rotateX(-0.08); torso.translate(0, 0.37, 0.01);
  const parts = [
    blob([0, 0.1, -0.02], 0.17, [1, 0.55, 0.85], 0, 3, 7, 4),                        // seat of the trousers
    part(torso, 0, 0),
    blob([0, 0.605, 0.01], 0.172, [1, 0.34, 0.64], 0, 0, 8, 4),                       // rounded shoulders
    limb([0, 0.6, 0.0], [0, 0.71, -0.005], 0.046, 0.042, 6, 1, 1),                    // neck
  ];
  for (const s of [-1, 1]) {
    parts.push(limb([s * 0.09, 0.08, 0.02], [s * 0.095, 0.08, -0.38], 0.085, 0.066, 7, 0, 3, false));   // thigh
    parts.push(limb([s * 0.095, 0.08, -0.38], [s * 0.095, -0.37, -0.42], 0.058, 0.045, 6, 0, 3));       // shin
    parts.push(blob([s * 0.095, -0.4, -0.47], 0.05, [1, 0.6, 1.7], 0, 3, 5, 3));                         // foot
  }
  const head = new THREE.SphereGeometry(0.1, 10, 7); head.scale(0.9, 1.1, 0.98); head.translate(0, 0.785, -0.01);
  parts.push(part(head, 1, 1));
  const hair = new THREE.SphereGeometry(0.104, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.5); hair.scale(0.92, 1.05, 1.02); hair.rotateX(-0.25); hair.translate(0, 0.8, 0.006);
  parts.push(part(hair, 1, 2));
  const cap = new THREE.CylinderGeometry(0.1, 0.106, 0.07, 8, 1, true); cap.translate(0, 0.87, 0.0);
  const brim = new THREE.BoxGeometry(0.16, 0.012, 0.1); brim.translate(0, 0.84, -0.11);
  parts.push(part(cap, 4, 4), part(brim, 4, 4));
  for (const [s, pt] of [[-1, 2], [1, 3]]) {
    const sh = [s * 0.19, 0.58, 0.01], el = [s * 0.215, 0.36, -0.05], hd = [s * 0.14, 0.19, -0.27];
    parts.push(limb(sh, el, 0.06, 0.05, 6, pt, 0));                                   // upper arm (sleeve)
    parts.push(limb(el, hd, 0.047, 0.039, 6, pt, 1));                                   // forearm down to the lap
    parts.push(blob([hd[0], hd[1] - 0.01, hd[2] - 0.03], 0.047, [0.85, 0.6, 1.25], pt, 1, 5, 3));   // hand
  }
  for (const p of parts) for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'aPart', 'aSel'].includes(k)) p.deleteAttribute(k);
  const g = BGU.mergeGeometries(parts);
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  return g;
}

// Weighted palettes, [colour, weight]. A real tennis crowd is mostly whites, navy, black, greys and muted tones,
// with the odd strong colour; equal odds for every colour reads as confetti.
const SHIRTS = [
  ['#f4f4f0', 14], ['#ffffff', 6], ['#e9e5da', 8], ['#d9d0c1', 5], ['#c8c3b8', 5],
  ['#1d2b44', 9], ['#222428', 8], ['#3a3f47', 5], ['#8c9aa8', 5], ['#5d6b7a', 4],
  ['#9fb8cf', 5], ['#b8c9a6', 3], ['#e8d7a8', 3], ['#e4b9c0', 3], ['#a7c7c4', 2],
  ['#b8423a', 3], ['#2f6fb3', 4], ['#e0b84a', 3], ['#3f7a55', 2], ['#d9794a', 2], ['#5b4a7a', 1], ['#d86b86', 2],
];
const PANTS = [['#1e2633', 5], ['#2b2f36', 5], ['#5a6d86', 4], ['#c8bda6', 4], ['#e8e4da', 3], ['#394b3c', 1], ['#7a6a55', 2]];
const SKINS = [['#f2c9a8', 3], ['#e3b08a', 3], ['#d9a27e', 3], ['#c4855c', 2], ['#a46a45', 2], ['#8a573a', 2], ['#6b4128', 1]];
const HAIRS = [['#15100c', 4], ['#2b1d14', 4], ['#4a3020', 3], ['#7a5230', 2], ['#b08850', 1], ['#d8c08a', 1], ['#9a9a96', 2]];
const HATS = [['#f4f4f0', 8], ['#e6dcc0', 5], ['#1d2b44', 3], ['#222428', 2], ['#c93f36', 1], ['#2f6fb3', 1], ['#d6f04a', 1]];
const pickW = (list) => {
  let t = 0; for (const [, w] of list) t += w;
  let r = Math.random() * t;
  for (const [c, w] of list) if ((r -= w) < 0) return c;
  return list[0][0];
};

// Camera flashes in the stands at night: short, very bright points that the bloom turns into pops of light.
const FLASH_N = 48;
function makeFlashes() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLASH_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aBright', new THREE.BufferAttribute(new Float32Array(FLASH_N), 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 600 } },
    vertexShader: `attribute float aBright; uniform float uScale; varying float vB;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vB = aBright;
        gl_PointSize = aBright > 0.0 ? max(2.5, 0.5 * uScale / -mv.z) : 0.0; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vB;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; float a = exp(-r * r * 5.0);
        gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * 60.0 * vB * a, 1.0); }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false; pts.userData.noAO = true; pts.visible = false;
  scene.add(pts);
  return pts;
}
const _sz = new THREE.Vector2(), _fp = new THREE.Vector3();

export const Crowd = {
  mesh: null, uniforms: null, cheer: null, target: 0, level: 0, standLevel: 0, count: 0,
  heads: null, flash: null, night: false, queue: [], life: new Float32Array(FLASH_N), fHead: 0, nextAmbient: 0,
  setTimeOfDay(tod) { this.night = tod === 'night'; if (this.flash) this.flash.visible = this.night; },
  // n flashes spread over the next `over` seconds (serves, big points).
  flashBurst(n, over = 0.8) {
    if (!this.night || !this.heads) return;
    const t = Clock.perf();
    for (let i = 0; i < n; i++) this.queue.push(t + Math.random() * over);
  },
  spawnFlash() {
    const i = this.fHead; this.fHead = (this.fHead + 1) % FLASH_N;
    // Prefer someone the camera can see: a flash off-screen is wasted.
    let k = 0;
    for (let tries = 0; tries < 6; tries++) {
      k = ((Math.random() * this.count) | 0) * 3;
      _fp.set(this.heads[k], this.heads[k + 1], this.heads[k + 2]).project(camera);
      if (Math.abs(_fp.x) < 0.95 && Math.abs(_fp.y) < 0.95 && _fp.z < 1) break;
    }
    const P = this.flash.geometry.attributes.position.array;
    P[i * 3] = this.heads[k]; P[i * 3 + 1] = this.heads[k + 1]; P[i * 3 + 2] = this.heads[k + 2];
    this.life[i] = 1;
    this.flash.geometry.attributes.position.needsUpdate = true;
  },
  updateFlashes(dt) {
    if (!this.flash || !this.night || Clock.paused) return;
    const t = Clock.perf();
    if (t > this.nextAmbient) { this.spawnFlash(); this.nextAmbient = t + 0.6 + Math.random() * 2.2; }
    for (let q = this.queue.length - 1; q >= 0; q--) if (this.queue[q] <= t) { this.spawnFlash(); this.queue.splice(q, 1); }
    const B = this.flash.geometry.attributes.aBright.array;
    for (let i = 0; i < FLASH_N; i++) {
      if (this.life[i] > 0) this.life[i] = Math.max(0, this.life[i] - dt / 0.09);
      B[i] = this.life[i] * this.life[i];
    }
    this.flash.geometry.attributes.aBright.needsUpdate = true;
    renderer.getDrawingBufferSize(_sz);
    this.flash.material.uniforms.uScale.value = _sz.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  },
  build(seats, density = 1) {
    if (this.mesh) { scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    const chosen = seats.filter((s) => Math.random() < s.fill * density);
    const n = chosen.length;
    const geo = personGeometry();
    const iShirt = new Float32Array(n * 3), iSkin = new Float32Array(n * 3), iHair = new Float32Array(n * 3), iPants = new Float32Array(n * 3), iHat = new Float32Array(n * 3), iSeed = new Float32Array(n * 2);
    const c = new THREE.Color();
    const put = (arr, i, hex, jitter = 0.06) => { c.set(hex); c.offsetHSL(0, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * jitter); arr.set([c.r, c.g, c.b], i * 3); };
    for (let i = 0; i < n; i++) {
      put(iShirt, i, pickW(SHIRTS)); put(iSkin, i, pickW(SKINS), 0.04); put(iHair, i, pickW(HAIRS)); put(iPants, i, pickW(PANTS)); put(iHat, i, pickW(HATS));
      iSeed[i * 2] = Math.random(); iSeed[i * 2 + 1] = Math.random() < 0.28 ? 1 : 0;   // seed, wears a cap or sun hat
    }
    geo.setAttribute('iShirt', new THREE.InstancedBufferAttribute(iShirt, 3));
    geo.setAttribute('iSkin', new THREE.InstancedBufferAttribute(iSkin, 3));
    geo.setAttribute('iHair', new THREE.InstancedBufferAttribute(iHair, 3));
    geo.setAttribute('iPants', new THREE.InstancedBufferAttribute(iPants, 3));
    geo.setAttribute('iHat', new THREE.InstancedBufferAttribute(iHat, 3));
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 2));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    const uniforms = (this.uniforms = { uTime: { value: 0 }, uCheer: { value: 0 }, uStand: { value: 0 }, uBall: { value: new THREE.Vector3(0, 1, 0) } });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aPart; attribute float aSel;
          attribute vec3 iShirt; attribute vec3 iSkin; attribute vec3 iHair; attribute vec3 iPants; attribute vec3 iHat; attribute vec2 iSeed;
          uniform float uTime, uCheer, uStand; uniform vec3 uBall;
          mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
          mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
          mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float seed = iSeed.x;
          // Head yaw toward the ball, in this spectator's own frame.
          mat3 IR = mat3(instanceMatrix);
          vec3 lb = transpose(IR) * (uBall - instanceMatrix[3].xyz) / dot(IR[0], IR[0]);
          float yaw = clamp(atan(-lb.x, -lb.z), -1.25, 1.25) * (0.75 + 0.25 * seed);
          float pitch = clamp(atan(lb.y - 0.8, length(lb.xz)) * 0.5, -0.35, 0.3);
          // Cheering: some lift their arms and clap; a share stand up for big moments.
          float keen = step(0.25, seed);
          float lift = uCheer * keen * (0.55 + 0.45 * fract(seed * 7.13));
          float clap = sin(uTime * (10.0 + seed * 4.0) + seed * 40.0) * 0.28 * lift;
          float standUp = uStand * step(1.0 - uStand * 0.9, fract(seed * 3.7));
          float sway = sin(uTime * (0.6 + seed) + seed * 20.0) * 0.03;
          mat3 M = mat3(1.0);
          vec3 pivot = vec3(0.0);
          if (aPart > 0.5 && aPart < 1.5 || aPart > 3.5) { pivot = vec3(0.0, 0.68, 0.0); M = rotY(yaw) * rotX(pitch); }
          else if (aPart > 1.5 && aPart < 3.5) {
            float s = aPart < 2.5 ? -1.0 : 1.0;
            pivot = vec3(0.2 * s, 0.6, 0.0);
            M = rotZ(s * (0.15 * lift + clap * 0.5)) * rotX(lift * 1.9) * rotY(-s * clap);
          }
          objectNormal = M * objectNormal;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          if (aPart > 3.5 && iSeed.y < 0.5) transformed = vec3(0.0, 0.7, 0.0);
          transformed = M * (transformed - pivot) + pivot;
          transformed = rotZ(sway) * transformed;
          transformed.y += standUp * 0.34;`)
        .replace('#include <color_vertex>', `#include <color_vertex>
          vColor.rgb = aSel < 0.5 ? iShirt : aSel < 1.5 ? iSkin : aSel < 2.5 ? iHair : aSel < 3.5 ? iPants : iHat;`);
    };
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    chosen.forEach((st, i) => {
      const k = 0.92 + Math.random() * 0.16;
      m4.compose(p.set(st.x, st.y + 0.02, st.z), q.setFromAxisAngle(up, st.ry + (Math.random() - 0.5) * 0.3), s.set(k, k, k));
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.userData.noAO = true;
    scene.add(mesh);
    this.mesh = mesh; this.count = n;
    // Where a phone or camera would be held: in front of each spectator's face.
    this.heads = new Float32Array(n * 3);
    chosen.forEach((st, i) => { this.heads.set([st.x - Math.sin(st.ry) * 0.18, st.y + 0.82, st.z - Math.cos(st.ry) * 0.18], i * 3); });
    if (!this.flash) this.flash = makeFlashes();
    this.flash.visible = this.night;
  },
  cheer(amp) { this.target = Math.max(this.target, amp); this.cheerT = Clock.perf(); this.standTarget = amp > 0.8 ? amp : this.standTarget || 0; },
  update(ball) {
    if (!this.uniforms) return;
    const t = Clock.perf(), since = t - (this.cheerT || -99);
    this.updateFlashes(Math.min(0.05, t - (this.lastT || t))); this.lastT = t;
    const want = since < 1.6 + this.target * 1.6 ? this.target : 0;
    if (want === 0) this.target = 0;
    this.level += (want - this.level) * (want > this.level ? 0.18 : 0.04);
    const standWant = since < 2.4 ? this.standTarget || 0 : 0;
    if (standWant === 0) this.standTarget = 0;
    this.standLevel += (standWant - this.standLevel) * (standWant > this.standLevel ? 0.1 : 0.03);
    const u = this.uniforms;
    u.uTime.value = t; u.uCheer.value = this.level; u.uStand.value = this.standLevel;
    if (ball) u.uBall.value.lerp(ball, 0.2);
  },
};
