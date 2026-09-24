// Player figures: the procedural character, a racket, and a pose-based animation system on its skeleton.
import * as THREE from 'three';
import { clamp, lerp, damp } from '../core.js';
import { scene } from './renderer.js';
import { createCharacter, recolorCharacter } from './character.js';
import { makeRacket } from './racket.js';

// Outfits the CPU opponent rotates through, so matches don't all look alike.
export const OUTFITS = [
  { shirt: 0xc9443a, pants: 0x1c1f24, band: 0xf2f5ee, design: 2, shoe: 0x22262b },
  { shirt: 0x1d2b44, pants: 0xf2f5ee, band: 0xd6f04a, design: 1, shoe: 0xf4f4f0 },
  { shirt: 0xf2f5ee, pants: 0x2b2f36, band: 0xc9443a, design: 3, shoe: 0xf4f4f0 },
  { shirt: 0x2f6fb3, pants: 0x1d2b44, band: 0xf2f5ee, design: 1, shoe: 0x1d2b44 },
  { shirt: 0x3f7a55, pants: 0xf2f5ee, band: 0xf2c14e, design: 2, shoe: 0xf4f4f0 },
  { shirt: 0x222428, pants: 0x222428, band: 0xd6f04a, design: 3, shoe: 0x222428 },
  { shirt: 0xe7839b, pants: 0x1c1f24, band: 0xf2f5ee, design: 0, shoe: 0xf4f4f0 },
  { shirt: 0xf2c14e, pants: 0x1d2b44, band: 0x1d2b44, design: 2, shoe: 0xf4f4f0 },
];
export const KITS = [
  { shirt: 0xf2f5ee, pants: 0x1f3b5c, band: 0xd6f04a, design: 1, shoe: 0xf4f4f0, skin: 0xd9a27e, hair: 'short', hairColor: 0x2b1d14, height: 1.0, racket: { frame: 0x1b2026, accent: 0xd6f04a } },
  { shirt: 0xc9443a, pants: 0x1c1f24, band: 0xf2f5ee, design: 2, shoe: 0x22262b, skin: 0xa46a45, hair: 'buzz', hairColor: 0x15100c, height: 1.02, racket: { frame: 0xf2f5ee, accent: 0xc9443a } },
];

// Right-handed poses. Figure faces local -z, right is +x.
// Limb pitch (x) > 0 swings forward, right-arm roll (z) > 0 lifts it sideways, spine yaw (y) > 0 turns the chest left.
// Spine and head pitch > 0 lean back: a positive head pitch tips the face up.
const P = (o) => Object.assign({ py: 0, sp: [0, 0, 0], hd: [0, 0, 0], shR: [0, 0, 0], elR: 0, wrR: [0, 0, 0], shL: [0, 0, 0], elL: 0, wrL: [0, 0, 0], hipR: [0, 0, 0], knR: 0, hipL: [0, 0, 0], knL: 0 }, o);
export const POSE = {
  ready: P({ py: -0.07, sp: [-0.22, 0, 0], hd: [0.18, 0, 0], shR: [0.5, 0, 0.3], elR: 1.1, wrR: [0.25, 0, 0], shL: [0.55, 0, -0.35], elL: 1.25, hipR: [0.38, 0, 0.1], knR: -0.6, hipL: [0.38, 0, -0.1], knL: -0.6 }),
  stand: P({ sp: [-0.05, 0, 0], shR: [0.25, 0, 0.12], elR: 0.5, wrR: [0.4, 0, 0], shL: [0.1, 0, -0.12], elL: 0.2, hipR: [0.05, 0, 0.04], knR: -0.08, hipL: [0.05, 0, -0.04], knL: -0.08 }),
  fh0: P({ py: -0.1, sp: [-0.18, -1.15, 0], hd: [0.1, 0.9, 0], shR: [0.1, 0, 1.25], elR: 0.55, wrR: [0.2, 0, 0.5], shL: [1.35, 0, 0.25], elL: 0.25, hipR: [0.45, 0, 0.15], knR: -0.75, hipL: [0.2, 0, -0.1], knL: -0.4 }),
  fh1: P({ py: -0.06, sp: [-0.15, 0.15, 0], hd: [0.1, -0.1, 0], shR: [0.95, 0, 1.15], elR: 0.25, shL: [0.7, 0, -0.5], elL: 0.6, hipR: [0.3, 0, 0.1], knR: -0.45, hipL: [0.4, 0, -0.1], knL: -0.5 }),
  fh2: P({ py: -0.03, sp: [-0.1, 1.05, 0], hd: [0.1, -0.9, 0], shR: [2.0, 0, -0.55], elR: 1.65, wrR: [0.2, 0, 0], shL: [0.35, 0, -0.7], elL: 0.9, hipR: [0.15, 0, 0.1], knR: -0.25, hipL: [0.35, 0, -0.1], knL: -0.35 }),
  bh0: P({ py: -0.1, sp: [-0.18, 1.25, 0], hd: [0.1, -0.95, 0], shR: [0.65, 0, -0.75], elR: 0.55, wrR: [0.2, 0, 0], shL: [0.35, 0, -1.1], elL: 1.0, hipR: [0.25, 0, 0.1], knR: -0.45, hipL: [0.45, 0, -0.15], knL: -0.75 }),
  bh1: P({ py: -0.06, sp: [-0.15, -0.1, 0], hd: [0.1, 0.1, 0], shR: [1.05, 0, -0.55], elR: 0.2, shL: [1.05, 0, -0.1], elL: 0.75, hipR: [0.4, 0, 0.1], knR: -0.5, hipL: [0.3, 0, -0.1], knL: -0.45 }),
  bh2: P({ py: -0.03, sp: [-0.1, -1.05, 0], hd: [0.1, 0.9, 0], shR: [1.85, 0, 0.45], elR: 1.1, wrR: [0.3, 0, 0], shL: [1.95, 0, 0.7], elL: 1.5, hipR: [0.35, 0, 0.1], knR: -0.35, hipL: [0.15, 0, -0.1], knL: -0.25 }),
  sv0: P({ sp: [0, -1.0, 0], hd: [0, 0.9, 0], shR: [0.35, 0, 0.35], elR: 0.5, wrR: [0.3, 0, 0], shL: [0.7, 0, -0.15], elL: 0.4, hipR: [0.05, 0, 0.1], knR: -0.1, hipL: [0.1, 0, -0.1], knL: -0.1 }),
  sv1: P({ py: -0.12, sp: [0.28, -1.1, 0.12], hd: [0.3, 0.8, 0], shR: [0.25, 0, 1.65], elR: 2.1, wrR: [0.4, 0, 0], shL: [2.95, 0, -0.1], elL: 0.05, hipR: [0.4, 0, 0.1], knR: -0.85, hipL: [0.35, 0, -0.1], knL: -0.8 }),
  sv2: P({ py: 0.1, sp: [-0.1, -0.25, 0], hd: [0.4, 0.2, 0], shR: [2.95, 0, 0.3], elR: 0.05, wrR: [0.1, 0, 0], shL: [1.2, 0, -0.5], elL: 0.3, hipR: [0, 0, 0.05], knR: -0.05, hipL: [0.1, 0, -0.05], knL: -0.1 }),
  sv3: P({ py: -0.05, sp: [-0.5, 0.65, 0], hd: [0.35, -0.5, 0], shR: [0.75, 0, -0.75], elR: 0.4, wrR: [0.1, 0, 0], shL: [0.25, 0, -0.35], elL: 0.3, hipR: [0.6, 0, 0.1], knR: -0.5, hipL: [-0.2, 0, -0.1], knL: -0.2 }),
  win: P({ py: -0.04, sp: [0.05, -0.2, 0], hd: [0.2, 0.1, 0], shR: [1.2, 0, 0.7], elR: 2.2, wrR: [0.3, 0, 0], shL: [0.9, 0, -0.9], elL: 2.3, hipR: [0.15, 0, 0.1], knR: -0.3, hipL: [0.1, 0, -0.1], knL: -0.25 }),
  lose: P({ sp: [-0.28, 0.1, 0], hd: [-0.35, 0, 0], shR: [0.12, 0, 0.1], elR: 0.25, wrR: [0.4, 0, 0], shL: [0.08, 0, -0.08], elL: 0.15, hipR: [0.05, 0, 0.05], knR: -0.1, hipL: [0.05, 0, -0.05], knL: -0.1 }),
};
const POSE_KEYS = Object.keys(POSE.ready);
export function lerpPose(a, b, t, out) {
  for (const k of POSE_KEYS) {
    if (Array.isArray(a[k])) { for (let i = 0; i < 3; i++) out[k][i] = lerp(a[k][i], b[k][i], t); }
    else out[k] = lerp(a[k], b[k], t);
  }
  return out;
}
export const clonePose = (p) => JSON.parse(JSON.stringify(p));
const ease = (t) => t * t * (3 - 2 * t);
export function strokePose(kind, u, out) {
  if (kind === 'sv') {
    if (u < 0.45) return lerpPose(POSE.sv0, POSE.sv1, ease(u / 0.45), out);
    if (u < 0.62) return lerpPose(POSE.sv1, POSE.sv2, ease((u - 0.45) / 0.17), out);
    return lerpPose(POSE.sv2, POSE.sv3, ease((u - 0.62) / 0.38), out);
  }
  const k0 = POSE[kind + '0'], k1 = POSE[kind + '1'], k2 = POSE[kind + '2'];
  return u < 0.5 ? lerpPose(k0, k1, ease(u / 0.5), out) : lerpPose(k1, k2, ease((u - 0.5) / 0.5), out);
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

// Seated, crouching and standing poses for officials and ball kids (py lifts the hips to the seat).
export const STILL = {
  sit: (seatY) => P({ py: seatY + 0.13 - 0.97, sp: [0.06, 0, 0], hd: [0.08, 0, 0], shR: [0.42, 0, 0.1], elR: 1.0, wrR: [0.2, 0, 0], shL: [0.42, 0, -0.1], elL: 1.0, wrL: [0.2, 0, 0], hipR: [1.52, 0, 0.14], knR: -1.5, hipL: [1.52, 0, -0.14], knL: -1.5 }),
  crouch: () => P({ py: -0.42, sp: [-0.55, 0, 0], hd: [0.45, 0, 0], shR: [0.7, 0, 0.18], elR: 0.9, shL: [0.7, 0, -0.18], elL: 0.9, hipR: [1.45, 0, 0.32], knR: -2.25, hipL: [1.45, 0, -0.32], knL: -2.25 }),
  wait: () => P({ py: -0.01, sp: [-0.03, 0, 0], shR: [-0.35, 0, 0.18], elR: 0.55, shL: [-0.35, 0, -0.18], elL: 0.55, hipR: [0.02, 0, 0.07], knR: -0.05, hipL: [0.02, 0, -0.07], knL: -0.05 }),
};

// A still figure (umpire, line judge, ball kid) whose head follows the ball.
export class Figure {
  constructor(look, pose, x, z, ry) {
    const ch = createCharacter(look);
    this.B = ch.bones; this.rest = ch.rest;
    this.root = new THREE.Group();
    this.root.add(ch.mesh);
    this.root.position.set(x, 0, z);
    this.root.rotation.y = ry;
    this.pose = pose; this.lookTarget = null; this.headYaw = 0; this.headPitch = 0;
    Avatar.prototype.applyPose.call(this, pose, 0.016, null);
    scene.add(this.root);
  }
  get mode() { return 'still'; }
  update(dt) { Avatar.prototype.applyPose.call(this, this.pose, dt, null); }
}

// Motion blur on fast swings: a ribbon swept by the racket head over the last few frames, like a camera shutter
// smearing it. Frame-to-frame travel sets how strong it is, so slow-motion replays come out crisp.
const BLUR_N = 4;
const BLUR_MAT = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: { uColor: { value: new THREE.Color(0.62, 0.64, 0.62) } },
  vertexShader: 'attribute float aAlpha; varying float vAlpha; void main() { vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 uColor; varying float vAlpha; void main() { gl_FragColor = vec4(uColor, vAlpha); }',
});
class SwingBlur {
  constructor() {
    this.pos = new Float32Array(BLUR_N * 2 * 3); this.alpha = new Float32Array(BLUR_N * 2);
    const idx = [];
    for (let i = 0; i < BLUR_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, BLUR_MAT);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; this.mesh.userData.noAO = true; this.mesh.visible = false;
    // Ring of recent head positions, newest at index h.
    this.tips = Array.from({ length: BLUR_N }, () => new THREE.Vector3()); this.bases = Array.from({ length: BLUR_N }, () => new THREE.Vector3());
    this.h = 0; this.n = 0;
    scene.add(this.mesh);
  }
  update(racket) {
    racket.updateWorldMatrix(true, false);
    const prev = this.h;
    this.h = (this.h + BLUR_N - 1) % BLUR_N;
    const tip = racket.localToWorld(this.tips[this.h].set(0, -0.6, 0)), base = racket.localToWorld(this.bases[this.h].set(0, -0.34, 0));
    this.n = this.n && tip.distanceTo(this.tips[prev]) > 1.4 ? 1 : Math.min(BLUR_N, this.n + 1);   // restart if teleported
    const n = this.n, step = n > 1 ? tip.distanceTo(this.tips[prev]) : 0;
    const k = Math.min(1, Math.max(0, (step - 0.12) / 0.3));
    this.mesh.visible = k > 0 && n > 1;
    if (!this.mesh.visible) return;
    for (let i = 0; i < BLUR_N; i++) {
      const j = (this.h + Math.min(i, n - 1)) % BLUR_N, t = this.tips[j], b = this.bases[j], f = 1 - i / (BLUR_N - 1);
      this.pos.set([t.x, t.y, t.z, b.x, b.y, b.z], i * 6);
      const a = 0.26 * k * f * f;
      this.alpha[i * 2] = a; this.alpha[i * 2 + 1] = a * 0.7;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true; this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

export class Avatar {
  constructor(kit) {
    this.kit = kit;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const ch = createCharacter({ ...kit });
    this.char = ch; this.B = ch.bones; this.rest = ch.rest;
    this.body.add(ch.mesh);
    this.racket = makeRacket(kit.racket || {});
    this.racket.position.set(0, -0.07, -0.004);
    this.racket.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.B.handR.add(this.racket);
    this.pose = clonePose(POSE.stand);
    this.target = clonePose(POSE.stand);
    this.tmpPose = clonePose(POSE.ready);
    this.mode = 'ready';
    this.stroke = 'fh'; this.contactT = 0; this.tossT = 0; this.prep = 0; this.prepStroke = 'fh';
    this.runPhase = 0; this.yaw = 0; this.armLift = 0;
    this.hop = -9; this.reactKind = null; this.reactUntil = 0;
    this.lookTarget = null; this.headYaw = 0; this.headPitch = 0;
    this.blur = new SwingBlur();
    scene.add(this.root);
  }
  // Runs every frame after the pose is final (live play or a replay).
  updateBlur() { this.blur.update(this.racket); }
  setHanded(h) { this.body.scale.x = h === 'L' ? -1 : 1; this.handed = h; }
  // Swap outfits between matches (shirt, shorts, shoes, headband, accent, design); body and hair stay.
  setKit(kit) { recolorCharacter(this.char, kit); this.kit = { ...this.kit, ...kit }; }
  swing(stroke, contactT) { this.mode = 'swing'; this.stroke = stroke; this.contactT = contactT; }
  serveToss(t) { this.mode = 'serve'; this.tossT = t; this.contactT = 0; }
  serveHit(t) { this.mode = 'serve'; this.contactT = t; }
  idle(standing) { this.mode = standing ? 'stand' : 'ready'; }
  splitStep(now) { this.hop = now; }
  react(kind, now) { this.reactKind = kind; this.reactUntil = now + 1.6; this.mode = 'react'; }
  update(dt, now, pl) {
    const speed = Math.hypot(pl.vx, pl.vz), T = this.target;
    let k = 14;
    if (this.mode === 'swing') {
      const u = now < this.contactT ? 0.5 * clamp(1 - (this.contactT - now) / 0.17, 0, 1) : 0.5 + 0.5 * clamp((now - this.contactT) / 0.32, 0, 1);
      strokePose(this.stroke, u, T); k = 40;
      if (now > this.contactT + 0.5) this.mode = 'ready';
    } else if (this.mode === 'serve') {
      let u;
      if (!this.contactT) u = 0.45 * clamp((now - this.tossT) / 0.55, 0, 1);
      else u = now < this.contactT ? 0.45 + 0.17 * clamp(1 - (this.contactT - now) / 0.14, 0, 1) : 0.62 + 0.38 * clamp((now - this.contactT) / 0.45, 0, 1);
      strokePose('sv', u, T); k = 30;
      if (this.contactT && now > this.contactT + 0.7) this.mode = 'ready';
    } else if (this.mode === 'react') {
      lerpPose(POSE.stand, POSE[this.reactKind] || POSE.stand, 1, T);
      if (this.reactKind === 'win') { const pump = Math.sin(now * 14) * 0.18 * clamp((this.reactUntil - now) / 1.6, 0, 1); T.shR[0] += pump; T.elR += pump * 0.6; }
      k = 9;
      if (now > this.reactUntil) this.mode = 'stand';
    } else {
      lerpPose(POSE.ready, POSE.stand, this.mode === 'stand' ? 1 : 0, T);
      if (this.prep > 0) lerpPose(T, strokePose(this.prepStroke, 0, this.tmpPose), this.prep * 0.85, T);
      const r = clamp(speed / 5, 0, 1);
      if (r > 0.02) {
        this.runPhase += dt * (5 + speed * 1.7);
        const s = Math.sin(this.runPhase), c = Math.cos(this.runPhase);
        T.hipR[0] = lerp(T.hipR[0], 0.25 + s * 0.8, r); T.hipL[0] = lerp(T.hipL[0], 0.25 - s * 0.8, r);
        T.knR = lerp(T.knR, -0.35 - Math.max(0, -c) * 1.1, r); T.knL = lerp(T.knL, -0.35 - Math.max(0, c) * 1.1, r);
        T.shL[0] = lerp(T.shL[0], 0.3 - s * 0.6, r); T.py -= 0.03 * Math.abs(c) * r; T.sp[0] -= 0.12 * r;
      } else if (this.mode === 'ready') {
        const b = Math.sin(now * 5.2) * 0.012;   // weight shifting on the toes
        T.py += b; T.knR -= b * 2; T.knL -= b * 2;
      }
      // Split step: a small hop as the opponent strikes, landing low and wide.
      const h = now - this.hop;
      if (h >= 0 && h < 0.38) { const u = h / 0.38; T.py += Math.sin(u * Math.PI) * 0.07 - Math.sin(u * Math.PI * 2) * 0.03 * (u > 0.5 ? 1 : 0); T.hipR[2] += 0.12 * Math.sin(u * Math.PI); T.hipL[2] -= 0.12 * Math.sin(u * Math.PI); }
      T.shR[0] += this.armLift;
    }
    lerpPose(this.pose, T, 1 - Math.exp(-k * dt), this.pose);
    this.applyPose(this.pose, dt, pl);
    const lat = pl.vx * pl.side, fwd = -pl.vz * pl.side;
    let yawT = 0;
    if ((this.mode === 'ready' || this.mode === 'stand') && speed > 1.4) yawT = clamp(Math.atan2(-lat, Math.abs(fwd) + 0.01), -1.1, 1.1) * clamp((speed - 1.4) / 2, 0, 1);
    this.yaw = damp(this.yaw, yawT, 8, dt);
    this.root.position.set(pl.x, 0, pl.z);
    this.root.rotation.y = (pl.side > 0 ? 0 : Math.PI) + this.yaw;
  }
  applyPose(p, dt, pl) {
    const B = this.B;
    B.hips.position.y = this.rest.hips.y + p.py;
    B.spine.rotation.set(p.sp[0] * 0.45, p.sp[1] * 0.45, p.sp[2] * 0.5);
    B.chest.rotation.set(p.sp[0] * 0.55, p.sp[1] * 0.55, p.sp[2] * 0.5);
    // Head: pose plus a glance toward the ball.
    let hy = 0, hp = 0;
    if (this.lookTarget && this.mode !== 'react') {
      B.head.updateWorldMatrix(true, false);
      _v.copy(this.lookTarget).sub(B.head.getWorldPosition(new THREE.Vector3()));
      const inv = this.root.getWorldQuaternion(_q).invert();
      _v.applyQuaternion(inv);
      if (this.body && this.body.scale.x < 0) _v.x = -_v.x;
      hy = clamp(Math.atan2(-_v.x, -_v.z) - p.sp[1] - p.hd[1], -0.9, 0.9);
      hp = clamp(Math.atan2(_v.y, Math.hypot(_v.x, _v.z)) * 0.6, -0.5, 0.5);   // + tips the face up, so a low ball is negative
    }
    this.headYaw = damp(this.headYaw, hy, 10, dt || 0.016); this.headPitch = damp(this.headPitch, hp, 10, dt || 0.016);
    B.neck.rotation.set(p.hd[0] * 0.35 + this.headPitch * 0.3, p.hd[1] * 0.35 + this.headYaw * 0.35, p.hd[2] * 0.35);
    B.head.rotation.set(p.hd[0] * 0.65 + this.headPitch * 0.7, p.hd[1] * 0.65 + this.headYaw * 0.65, p.hd[2] * 0.65);
    B.armR.rotation.set(p.shR[0], p.shR[1], p.shR[2]); B.foreR.rotation.set(p.elR, 0, 0); B.handR.rotation.set(p.wrR[0], p.wrR[1], p.wrR[2]);
    B.armL.rotation.set(p.shL[0], p.shL[1], p.shL[2]); B.foreL.rotation.set(p.elL, 0, 0); B.handL.rotation.set(p.wrL[0], p.wrL[1], p.wrL[2]);
    // Shoulders shrug a little when the arms go overhead.
    B.clavR.rotation.set(0, 0, 0.22 * Math.max(0, p.shR[2] - 1.0) + 0.1 * Math.max(0, p.shR[0] - 2.0));
    B.clavL.rotation.set(0, 0, -0.22 * Math.max(0, -p.shL[2] - 1.0) - 0.1 * Math.max(0, p.shL[0] - 2.0));
    B.thighR.rotation.set(p.hipR[0], p.hipR[1], p.hipR[2]); B.shinR.rotation.set(p.knR, 0, 0); B.footR.rotation.set(-(p.hipR[0] + p.knR), 0, -p.hipR[2]);
    B.thighL.rotation.set(p.hipL[0], p.hipL[1], p.hipL[2]); B.shinL.rotation.set(p.knL, 0, 0); B.footL.rotation.set(-(p.hipL[0] + p.knL), 0, -p.hipL[2]);
  }
}
