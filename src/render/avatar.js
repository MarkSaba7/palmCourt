// Player figures: the procedural character, a racket, and a pose-based animation system on its skeleton.
import * as THREE from 'three';
import { clamp, lerp, damp, sstep, DT, flight } from '../core.js';
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
// Spine and head pitch > 0 lean back: a positive head pitch tips the face up. px / pz shift the hips (and so the whole
// figure) sideways / back, in metres: a lunge reaching for a wide ball.
const P = (o) => Object.assign({ py: 0, px: 0, pz: 0, sp: [0, 0, 0], hd: [0, 0, 0], shR: [0, 0, 0], elR: 0, wrR: [0, 0, 0], shL: [0, 0, 0], elL: 0, wrL: [0, 0, 0], hipR: [0, 0, 0], knR: 0, hipL: [0, 0, 0], knL: 0 }, o);
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

// ============================================================================================================
// Strokes. A groundstroke is five keys in time around the contact: take-back, slot (where the racket drops to before
// it swings forward: under the ball for topspin, level with it for a drive, above it for a slice), contact, extension
// (the racket goes on toward the target) and finish. Each key is a body pose plus a racket target in the body's frame
// (right-handed; a lefty is the mirror image): the wrist W, the racket's axis a (grip to head) and its string face n.
// The racket arm is solved every frame (IK) so the racket follows that path and its head meets the ball at contact.
// ============================================================================================================
const RH = 0.53;                                    // wrist to racket-head centre along the racket (racket.js HEAD_Y)
const HEADC = new THREE.Vector3(0, -0.46, 0);       // racket head centre, racket frame
const GRIP2 = new THREE.Vector3(0, -0.1, 0);        // a two-hander's top hand on the grip (racket frame)
const THROAT = new THREE.Vector3(0, -0.27, 0);      // the throat, where the free hand steadies the racket
const PALM = new THREE.Vector3(0, -0.075, 0);       // palm centre, hand frame
const LEAD = 1 / 40;                                // strokes are sampled this far ahead: the pose smoothing lags as much

// Pose <-> flat arrays (splines run on flat keys).
const PLEN = POSE_KEYS.reduce((n, k) => n + (Array.isArray(POSE.ready[k]) ? 3 : 1), 0);
const KL = PLEN + 11;                               // + racket head h, axis a, face n, face weight, free-hand weight
function poseToArr(p, a) { let i = 0; for (const k of POSE_KEYS) { const v = p[k]; if (Array.isArray(v)) { a[i++] = v[0]; a[i++] = v[1]; a[i++] = v[2]; } else a[i++] = v; } return a; }
function arrToPose(a, p) { let i = 0; for (const k of POSE_KEYS) { const v = p[k]; if (Array.isArray(v)) { v[0] = a[i++]; v[1] = a[i++]; v[2] = a[i++]; } else p[k] = a[i++]; } return p; }
// Catmull-Rom through keys K at times kt (the first and last keys are rests); ks scales the speed through a key.
function spline(K, kt, ks, tau, out) {
  const n = kt.length;
  if (tau <= kt[0]) { out.set(K[0]); return out; }
  if (tau >= kt[n - 1]) { out.set(K[n - 1]); return out; }
  let i = 0;
  while (tau > kt[i + 1]) i++;
  const h = kt[i + 1] - kt[i], s = (tau - kt[i]) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const A = K[i], B = K[i + 1], Ap = K[Math.max(0, i - 1)], Bn = K[Math.min(n - 1, i + 2)];
  const ta = i > 0 ? (h / (kt[i + 1] - kt[i - 1])) * ks[i] : 0, tb = i + 2 < n ? (h / (kt[i + 2] - kt[i])) * ks[i + 1] : 0;
  for (let j = 0; j < out.length; j++) out[j] = h00 * A[j] + h10 * ta * (B[j] - Ap[j]) + h01 * B[j] + h11 * tb * (Bn[j] - A[j]);
  return out;
}
// Hip height (py) that keeps the lower foot on the court for these leg angles, for the 1.83 m build.
const legLen = (hip, kn) => (0.43 * Math.cos(hip[0]) + 0.44 * Math.cos(hip[0] + kn)) * Math.cos(hip[2]);
const footPy = (p) => Math.max(legLen(p.hipR, p.knR), legLen(p.hipL, p.knL)) - 0.87;

// Racket rows per key (take, slot, contact, ext, finish): [Wx Wy Wz, ax ay az, nx ny nz, face weight]. The contact's W
// is the ball. Variants: F flat drive, T topspin, S slice, D drop shot, V volley. Forehand, right-handed.
const R_ = (W, a, n = [0, 0, -1], wn = 0) => [...W, ...a, ...n, wn];
const FH = {
  F: [R_([0.42, 1.2, 0.38], [0.1, 0.55, 0.83]), R_([0.45, 0.98, 0.3], [0.35, 0.05, 0.93]), R_([0, 0, 0], [0.95, -0.05, 0.25], [0, 0, -1], 1), R_([0.1, 1.15, -0.62], [0.25, 0.3, -0.92]), R_([-0.35, 1.3, -0.15], [-0.35, 0.25, 0.9])],
  T: [R_([0.45, 1.25, 0.35], [0.05, 0.75, 0.66]), R_([0.42, 0.82, 0.25], [0.3, -0.45, 0.84]), R_([0, 0, 0], [0.93, -0.2, 0.25], [0, -0.25, -0.97], 1), R_([0.12, 1.2, -0.55], [0.35, 0.85, -0.4]), R_([-0.25, 1.45, -0.05], [0.1, 0.45, 0.89])],
  S: [R_([0.45, 1.4, 0.2], [0.25, 0.8, 0.55]), R_([0.48, 1.3, 0.1], [0.45, 0.65, 0.6], [0, 0.6, -0.8], 0.5), R_([0, 0, 0], [0.88, 0.4, 0.2], [0, 0.55, -0.83], 1), R_([0.15, 0.95, -0.6], [0.55, 0.3, -0.78], [0, 0.8, -0.6], 0.7), R_([-0.05, 1.12, -0.55], [0.35, 0.65, -0.68], [0, 0.85, -0.5], 0.7)],
  D: [R_([0.42, 1.3, 0.1], [0.3, 0.8, 0.5]), R_([0.45, 1.15, 0], [0.5, 0.6, 0.6], [0, 0.6, -0.8], 0.5), R_([0, 0, 0], [0.85, 0.45, 0.1], [0, 0.7, -0.7], 1), R_([0.22, 0.98, -0.52], [0.6, 0.55, -0.58], [0, 0.85, -0.5], 0.8), R_([0.15, 1.05, -0.5], [0.5, 0.7, -0.5], [0, 0.9, -0.4], 0.8)],
  V: [R_([0.45, 1.25, -0.1], [0.35, 0.85, 0.35]), R_([0.45, 1.15, -0.25], [0.5, 0.7, 0.3]), R_([0, 0, 0], [0.75, 0.6, 0.1], [0, 0.3, -0.95], 1), R_([0.25, 1.0, -0.6], [0.55, 0.55, -0.6], [0, 0.4, -0.9], 0.5), R_([0.2, 1.05, -0.62], [0.5, 0.6, -0.62], [0, 0.4, -0.9], 0.3)],
};
const mirrorRows = (rows) => rows.map((r) => [-r[0], r[1], r[2], -r[3], r[4], r[5], -r[6], r[7], r[8], r[9]]);
const BH2 = Object.fromEntries(Object.entries(FH).map(([k, v]) => [k, mirrorRows(v)]));
// One-handed backhand: the contact further in front and a high finish with the arm straight.
const BH1 = {
  ...BH2,
  F: [R_([-0.35, 1.25, 0.35], [-0.1, 0.6, 0.8]), R_([-0.38, 1.0, 0.28], [-0.3, 0, 0.95]), R_([0, 0, 0], [-0.92, 0, 0.1], [0, 0, -1], 1), R_([0.05, 1.25, -0.62], [0.1, 0.55, -0.83]), R_([0.45, 1.6, -0.3], [0.3, 0.85, 0.3])],
  T: [R_([-0.35, 1.25, 0.35], [-0.1, 0.6, 0.8]), R_([-0.35, 0.9, 0.25], [-0.25, -0.4, 0.88]), R_([0, 0, 0], [-0.9, -0.15, 0.1], [0, -0.2, -0.98], 1), R_([0.1, 1.3, -0.55], [0.2, 0.85, -0.45]), R_([0.45, 1.75, -0.15], [0.35, 0.9, 0.25])],
};
// Body keys for the same moments; the racket arm's angles here only seed the IK.
const BK = {
  fh: [
    P({ sp: [-0.12, -1.15, 0.05], hd: [0.12, 1.0, 0], shR: [0.1, 0, 1.25], elR: 0.55, wrR: [0.2, 0, 0.5], shL: [1.3, 0, 0.35], elL: 0.35, hipR: [0.42, 0, 0.18], knR: -0.8, hipL: [0.25, 0, -0.12], knL: -0.45 }),
    P({ sp: [-0.12, -0.85, 0.05], hd: [0.12, 0.75, 0], shR: [0.5, 0, 1.2], elR: 0.4, wrR: [0.1, 0, 0.3], shL: [1.15, 0, 0.1], elL: 0.5, hipR: [0.45, 0, 0.15], knR: -0.85, hipL: [0.3, 0, -0.12], knL: -0.55 }),
    P({ sp: [-0.1, 0.1, -0.06], hd: [0.2, -0.1, 0], shR: [0.95, 0, 1.15], elR: 0.25, shL: [0.65, 0, -0.5], elL: 1.0, hipR: [0.3, 0, 0.12], knR: -0.5, hipL: [0.35, 0, -0.1], knL: -0.45 }),
    P({ sp: [-0.06, 0.65, -0.03], hd: [0.15, -0.5, 0], shR: [1.5, 0, 0.3], elR: 0.9, shL: [0.45, 0, -0.85], elL: 1.5, hipR: [0.18, 0, 0.1], knR: -0.35, hipL: [0.3, 0, -0.1], knL: -0.35 }),
    P({ sp: [-0.05, 1.15, 0], hd: [0.1, -0.95, 0], shR: [2.0, 0, -0.55], elR: 1.65, wrR: [0.2, 0, 0], shL: [0.7, 0, -1.0], elL: 1.9, hipR: [0.05, 0, 0.12], knR: -0.4, hipL: [0.3, 0, -0.1], knL: -0.3 }),
  ],
  bh: [
    P({ sp: [-0.12, 1.3, -0.05], hd: [0.12, -1.0, 0], shR: [0.65, 0, -0.75], elR: 0.55, wrR: [0.2, 0, 0], shL: [0.35, 0, -1.1], elL: 1.0, hipR: [0.25, 0, 0.1], knR: -0.45, hipL: [0.45, 0, -0.18], knL: -0.8 }),
    P({ sp: [-0.12, 1.0, -0.05], hd: [0.12, -0.8, 0], shR: [0.85, 0, -0.65], elR: 0.35, shL: [0.7, 0, -0.6], elL: 0.9, hipR: [0.3, 0, 0.1], knR: -0.55, hipL: [0.45, 0, -0.15], knL: -0.85 }),
    P({ sp: [-0.1, 0.4, 0.06], hd: [0.2, -0.3, 0], shR: [1.05, 0, -0.55], elR: 0.2, shL: [1.05, 0, -0.1], elL: 0.75, hipR: [0.4, 0, 0.1], knR: -0.5, hipL: [0.3, 0, -0.1], knL: -0.45 }),
    P({ sp: [-0.06, -0.35, 0.03], hd: [0.15, 0.2, 0], shR: [1.5, 0, 0], elR: 0.6, shL: [1.5, 0, 0.3], elL: 1.1, hipR: [0.35, 0, 0.1], knR: -0.4, hipL: [0.2, 0, -0.1], knL: -0.35 }),
    P({ sp: [-0.05, -1.05, 0], hd: [0.1, 0.9, 0], shR: [1.85, 0, 0.45], elR: 1.1, wrR: [0.3, 0, 0], shL: [1.95, 0, 0.7], elL: 1.5, hipR: [0.35, 0, 0.1], knR: -0.35, hipL: [0.1, 0, -0.12], knL: -0.3 }),
  ],
};

// ---- IK: damped least squares on a few joint angles, pulled gently toward the keyed pose ----
const _J = new Float64Array(9 * 7), _f0 = new Float64Array(9), _f1 = new Float64Array(9), _A = new Float64Array(7 * 8);
function solveIK(q, seed, lo, hi, n, fk, t, w, m, iters) {
  const mu = 0.012, lam = 0.006;
  for (let it = 0; it < iters; it++) {
    fk(q, _f0);
    for (let j = 0; j < n; j++) {
      const s = q[j];
      q[j] = s + 1e-3; fk(q, _f1); q[j] = s;
      for (let i = 0; i < m; i++) _J[i * n + j] = (_f1[i] - _f0[i]) * 1e3 * w[i];
    }
    // (JᵀJ + λ + μ) Δ = Jᵀ e + μ (seed − q)
    const n1 = n + 1;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) { let s = r === c ? lam + mu : 0; for (let i = 0; i < m; i++) s += _J[i * n + r] * _J[i * n + c]; _A[r * n1 + c] = s; }
      let b = mu * (seed[r] - q[r]);
      for (let i = 0; i < m; i++) b += _J[i * n + r] * (t[i] - _f0[i]) * w[i];
      _A[r * n1 + n] = b;
    }
    for (let c = 0; c < n; c++) {   // symmetric positive definite: plain elimination
      const d = _A[c * n1 + c];
      for (let r = c + 1; r < n; r++) { const f = _A[r * n1 + c] / d; for (let k = c; k <= n; k++) _A[r * n1 + k] -= f * _A[c * n1 + k]; }
    }
    for (let r = n - 1; r >= 0; r--) { let s = _A[r * n1 + n]; for (let k = r + 1; k < n; k++) s -= _A[r * n1 + k] * _A[k * n1 + n]; _A[r * n1 + n] = s / _A[r * n1 + r]; }
    for (let j = 0; j < n; j++) q[j] = clamp(q[j] + clamp(_A[j * n1 + n], -0.6, 0.6), lo[j], hi[j]);
  }
  return q;
}
const LO_R = [-1.4, -1.6, -1.5, 0.03, -1.3, -1.8, -1.4], HI_R = [3.2, 1.6, 2.6, 2.6, 1.3, 1.8, 1.4];
const LO_L = [-1.4, -1.6, -2.6, 0.03], HI_L = [3.2, 1.6, 1.6, 2.6];
const W_R = new Float64Array([1, 1, 1, 0.3, 0.3, 0.3, 0, 0, 0]), W_L = new Float64Array([1, 1, 1]);
const _M = new THREE.Matrix4(), _L = new THREE.Matrix4(), _E = new THREE.Euler(), _t = new Float64Array(9), _sd = new Float64Array(7);
const _tH = new THREE.Vector3(), _tA = new THREE.Vector3(), _tN = new THREE.Vector3(), _c = new THREE.Vector3(), _w = new THREE.Vector3(), _inv = new THREE.Matrix4();

// Every player's figure: one's stroke is the other's cue to split-step.
const ALL = new Set();

// The serve: stance, toss (the racket arm swings down and back as the other goes up), trophy (toss arm up, racket up
// behind, knees loaded, back arched), racket drop (legs drive up, the racket falls behind the back), contact (fully
// stretched, off the ground on a big one), pronation (the forearm turns the face out and down) and finish (racket
// past the left hip, the back leg kicking up and then stepping through). Body keys + racket rows as for strokes.
const SV = [
  P({ sp: [0.02, -1.0, 0], hd: [0.05, 0.9, 0], shR: [0.45, 0, 0.3], elR: 0.8, shL: [0.75, 0, 0.1], elL: 0.9, hipR: [0.05, 0, 0.12], knR: -0.12, hipL: [0.15, 0, -0.08], knL: -0.12 }),
  P({ py: -0.04, sp: [0.12, -1.05, 0.06], hd: [0.2, 0.85, 0], shR: [0.1, 0, 0.6], elR: 0.3, shL: [1.9, 0, -0.1], elL: 0.1, hipR: [0.2, 0, 0.12], knR: -0.4, hipL: [0.2, 0, -0.1], knL: -0.35 }),
  P({ py: -0.12, sp: [0.3, -1.1, 0.14], hd: [0.35, 0.8, 0], shR: [0.25, 0, 1.65], elR: 2.1, wrR: [0.4, 0, 0], shL: [2.95, 0, -0.1], elL: 0.05, hipR: [0.42, 0, 0.12], knR: -0.9, hipL: [0.38, 0, -0.1], knL: -0.85 }),
  P({ py: -0.02, sp: [0.38, -0.75, 0.1], hd: [0.45, 0.6, 0], shR: [1.2, 0, 1.6], elR: 2.4, shL: [2.2, 0, -0.25], elL: 0.4, hipR: [0.15, 0, 0.1], knR: -0.35, hipL: [0.12, 0, -0.08], knL: -0.25 }),
  P({ py: 0.1, sp: [-0.2, -0.2, 0.25], hd: [0.5, 0.2, 0], shR: [2.95, 0, 0.3], elR: 0.05, shL: [1.0, 0, -0.3], elL: 1.7, hipR: [-0.1, 0, 0.05], knR: -0.08, hipL: [0.05, 0, -0.05], knL: -0.03 }),
  P({ py: 0.02, sp: [-0.35, 0.3, 0], hd: [0.4, -0.2, 0], shR: [1.8, 0, 0.2], elR: 0.3, shL: [0.6, 0, -0.5], elL: 1.4, hipR: [-0.45, 0, 0.1], knR: -1.1, hipL: [0.35, 0, -0.08], knL: -0.4 }),
  P({ py: -0.05, sp: [-0.45, 0.7, 0], hd: [0.35, -0.55, 0], shR: [0.75, 0, -0.75], elR: 0.4, shL: [0.3, 0, -0.45], elL: 0.5, hipR: [0.35, 0, 0.12], knR: -0.45, hipL: [0.2, 0, -0.1], knL: -0.35 }),
];
const SVR = [
  R_([0.12, 0.98, -0.3], [-0.05, 0.25, -0.97]),
  R_([0.38, 0.72, 0.12], [0.1, -0.55, 0.83]),
  R_([0.45, 1.55, 0.18], [0.05, 0.92, 0.38]),
  R_([0.32, 1.78, 0.08], [0.05, -0.93, 0.36]),
  R_([0, 0, 0], [0.03, 0.98, -0.2], [0, -0.15, -0.99], 1),
  R_([0.3, 1.5, -0.55], [0.55, -0.15, -0.82], [0.9, 0, 0.4], 0.6),
  R_([-0.28, 0.88, -0.22], [-0.45, -0.45, 0.77]),
];
const _p0 = new THREE.Vector3(), _v0 = new THREE.Vector3();
// The serve's reach. The toss is met on the strings a little above the head's centre (higher on a big serve), with
// the arm and racket straight up at it and a small jump: SV_JUMP is the jump game.js tosses for (serveHeight). SV_SLACK:
// the arm solve stops a few cm short of dead straight and the body lags its keys a little, so it jumps that much more.
const SV_JUMP = 0.08, SV_SLACK = 0.03, svOn = (pow) => lerp(0.04, 0, pow);
const _sM = new THREE.Matrix4(), _sL = new THREE.Matrix4(), _sE = new THREE.Euler(), _sS = new THREE.Vector3(), _svP = clonePose(POSE.ready);

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
    this.racket.updateMatrix();
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
    this.style = {};
    // The stroke being played: spin (-1 slice .. 1 heavy topspin), pow 0..1, drop shot, dir (where the ball goes,
    // radians in the body frame, + = right), elev (its climb), volley. known: read from the swing or the shot itself.
    this.sh = { spin: 0.4, pow: 0.6, drop: false, dir: 0, elev: 0.12, volley: false, known: false };
    this.K = Array.from({ length: 5 }, () => new Float32Array(KL)); this.kt = [0, 0, 0, 0, 0]; this.ks = [1, 1, 1, 1, 1];
    this.kv = new Float32Array(KL); this.kp = clonePose(POSE.ready);
    this.SK = Array.from({ length: 7 }, () => new Float32Array(KL)); this.SK3 = this.SK.slice(0, 3);
    this.skt = new Float64Array(7); this.skt3 = new Float64Array(3); this.sks = [1, 1, 1, 1, 1, 1, 1]; this.svPow = 0.7; this.toss = null;
    this.c = new THREE.Vector3(0.8, 0.95, -0.3); this.cFor = -1;
    this.ikQ = null; this.ikL = null; this.lGrip = GRIP2;
    this.fkR = (q, f) => this.armFK(q, f);
    this.fkL = (q, f) => this.leftFK(q, f);
    this.blur = new SwingBlur();
    scene.add(this.root);
    ALL.add(this);
  }
  // Runs every frame after the pose is final (live play or a replay).
  updateBlur() { this.blur.update(this.racket); }
  setHanded(h) { this.body.scale.x = h === 'L' ? -1 : 1; this.handed = h; }
  // Swap outfits between matches (shirt, shorts, shoes, headband, accent, design); body and hair stay.
  setKit(kit) { recolorCharacter(this.char, kit); this.kit = { ...this.kit, ...kit }; }
  // A new body (build, face, hair, headwear, clothing cut) over the current kit. The racket, handedness, pose and
  // place carry over. The look isn't merged into this.kit, so nothing from the last look leaks into the next one.
  // When only colours differ it recolours in place instead of rebuilding.
  setLook(look = {}) {
    const all = { ...this.kit, ...look }, shaping = Object.keys(all).sort().filter((k) => !/^(skin|hairColor|shirt|pants|shoe|band|accent|design|racket)$/.test(k));
    const key = JSON.stringify(shaping.map((k) => [k, all[k]]));
    this.look = look;
    if (key === this.lookKey) { recolorCharacter(this.char, all); return; }
    const old = this.char, ch = createCharacter(all), d = new THREE.Vector3();
    for (const [n, b] of Object.entries(ch.bones)) {
      const ob = old.bones[n];
      if (!ob) continue;
      b.quaternion.copy(ob.quaternion);
      if (this.rest[n]) b.position.add(d.copy(ob.position).sub(this.rest[n]));   // keep offsets from rest (hips height)
    }
    ch.bones.handR.add(this.racket);
    this.body.remove(old.mesh);
    this.body.add(ch.mesh);
    old.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    old.mesh.skeleton.dispose();
    this.char = ch; this.B = ch.bones; this.rest = ch.rest; this.lookKey = key;
  }
  // How this player moves (see pros.js): backhand 'one' | 'two', serve, ritual, celebrate, gait. Missing = defaults.
  setStyle(style) { this.style = { ...(style || {}) }; }
  // A stroke whose racket meets the ball at contactT. read: what the swing asked for ({ pow, spin, drop, dirX }, from
  // Input.read) when a person swung; without it the stroke is guessed from how this player plays until hit() says.
  swing(stroke, contactT, read) {
    this.mode = 'swing'; this.stroke = stroke; this.contactT = contactT;
    const s = this.sh;
    s.known = !!read;
    if (read) {
      s.pow = clamp(read.pow ?? 0.6, 0, 1); s.spin = clamp(read.spin ?? 0.4, -1, 1); s.drop = !!read.drop; s.elev = 0.12;
      s.dir = clamp(read.dirX ?? 0, -1.3, 1.3) * 0.26 * (this.handed === 'L' ? -1 : 1);
    }
    for (const o of ALL) if (o !== this) o.splitStep(contactT - 0.2);
  }
  // The ball has been struck (game.js applyHit): the rest of the stroke follows the shot that was actually played.
  hit(shot, v, volley) {
    if (this.mode === 'serve') { this.svPow = shot.power ?? this.svPow; return; }
    const s = this.sh, rpm = shot.rpm || 0;
    s.known = true; s.pow = clamp(shot.power ?? 0.6, 0, 1); s.volley = !!volley;
    s.drop = /drop/i.test(shot.kind || '');
    s.spin = rpm >= 0 ? clamp((rpm - 900) / 2400, 0, 1) : -clamp(0.25 + (-rpm - 600) / 2400, 0.25, 1);
    if (v) {
      this.body.updateWorldMatrix(true, false);
      _w.set(v.x, v.y, v.z).transformDirection(_inv.copy(this.body.matrixWorld).invert());
      s.dir = Math.atan2(_w.x, -_w.z); s.elev = Math.atan2(_w.y, Math.hypot(_w.x, _w.z));
    }
  }
  // The toss (p, v: where the ball leaves the hand, world) lets the racket meet the ball at the top.
  serveToss(t, p, v) { this.mode = 'serve'; this.tossT = t; this.contactT = 0; this.toss = p && v ? { p: { ...p }, v: { ...v } } : null; this.svPow = 0.7; }
  // The serve's keys: timed from the toss, and around the contact once it's known (the trophy is held until then).
  buildServe(pl) {
    const pow = clamp(this.svPow ?? 0.7, 0, 1), st = this.style.serve || 'classic', known = this.contactT > 0;
    const cT = known ? Math.max(0.25, this.contactT - this.tossT) : 9, Td = lerp(0.3, 0.17, pow), kt = this.skt;
    kt[4] = cT; kt[3] = cT - 0.45 * Td; kt[5] = cT + 0.1; kt[6] = cT + lerp(0.52, 0.4, pow);
    kt[2] = Math.min(st === 'high-toss' ? 0.58 : st === 'compact' ? 0.4 : 0.5, kt[3] - 0.08);
    kt[1] = Math.min(st === 'compact' ? 0.16 : 0.24, kt[2] - 0.08); kt[0] = Math.min(0, kt[1] - 0.08);
    // Where the ball will be at the contact: the toss flown on to then (with drag: it rises ~6 cm less by the contact).
    const c = this.c;
    if (known && this.toss) {
      if (this.cAt !== this.contactT + this.tossT) {
        const s = { p: { ...this.toss.p }, v: { ...this.toss.v }, w: { x: 0, y: 0, z: 0 } };
        for (let t = 0; t < cT - 1e-9; t += DT) flight(s, Math.min(DT, cT - t));
        this.cW = s.p; this.cAt = this.contactT + this.tossT;
      }
      this.toBody(this.cW.x, this.cW.y, this.cW.z, pl, c);
    } else c.set(0.14, 2.8, -0.42);
    c.y -= svOn(pow);   // (the racket-head centre's target: the ball sits on the strings above it)
    const kp = this.kp;
    for (let i = 0; i < 7; i++) {
      lerpPose(SV[i], SV[i], 0, kp);
      if (i === 2) { kp.sp[0] += 0.12 * pow; kp.knR -= 0.2 * pow; kp.knL -= 0.2 * pow; kp.py -= 0.05 * pow; if (st === 'high-toss') { kp.shL[0] = 3.05; kp.hd[0] += 0.12; } }
      if (i === 3) kp.sp[0] += 0.1 * pow;
      if (i === 4) kp.py = clamp(c.y - this.reachY(kp, c) + SV_SLACK, 0, 0.3);   // off the ground just enough to meet it at full stretch
      if (i === 5) { kp.hipR[0] -= 0.2 * pow; kp.sp[0] -= 0.1 * pow; }
      if (i === 0 && st === 'rocker') { kp.sp[0] += 0.1; kp.hipL[0] += 0.15; kp.knL -= 0.2; }
      const K = poseToArr(kp, this.SK[i]);
      let F = SVR[i];
      if (i === 1 && st === 'compact') F = F.map((x, j) => lerp(x, SVR[2][j], 0.55));
      const al = Math.hypot(F[3], F[4], F[5]) || 1, ax = F[3] / al, ay = F[4] / al, az = F[5] / al;
      if (i === 4) { K[PLEN] = c.x; K[PLEN + 1] = c.y; K[PLEN + 2] = c.z; } else { K[PLEN] = F[0] + RH * ax; K[PLEN + 1] = F[1] + RH * ay; K[PLEN + 2] = F[2] + RH * az; }
      K[PLEN + 3] = ax; K[PLEN + 4] = ay; K[PLEN + 5] = az; K[PLEN + 6] = F[6]; K[PLEN + 7] = F[7]; K[PLEN + 8] = F[8]; K[PLEN + 9] = F[9]; K[PLEN + 10] = 0;
      if (i === 4) {   // at the contact the racket is in line with the arm, from the shoulder (reachY) to the ball
        const dx = c.x - _sS.x, dy = c.y - _sS.y - kp.py, dz = c.z - _sS.z, d = Math.hypot(dx, dy, dz) || 1;
        K[PLEN + 3] = dx / d; K[PLEN + 4] = dy / d; K[PLEN + 5] = dz / d;
        const e = (F[6] * dx + F[7] * dy + F[8] * dz) / d, nx = F[6] - e * dx / d, ny = F[7] - e * dy / d, nz = F[8] - e * dz / d, nl = Math.hypot(nx, ny, nz) || 1;
        K[PLEN + 6] = nx / nl; K[PLEN + 7] = ny / nl; K[PLEN + 8] = nz / nl;   // (the face square to it, toward the court)
      }
    }
    return known ? this.SK : this.SK3;
  }
  // How high the racket-head centre reaches (body frame, feet on the court) at a ball at c, with the body in pose p:
  // the hitting shoulder from the rest bone offsets, then the arm and racket in a straight line to the ball. Moves no bones.
  reachY(p, c) {
    const B = this.B, sp = p.sp, h = this.rest.hips;
    _sM.makeTranslation(h.x, h.y, h.z);
    _sM.multiply(_sL.makeRotationFromEuler(_sE.set(sp[0] * 0.45, sp[1] * 0.45, sp[2] * 0.5)).setPosition(B.spine.position));
    _sM.multiply(_sL.makeRotationFromEuler(_sE.set(sp[0] * 0.55, sp[1] * 0.55, sp[2] * 0.5)).setPosition(B.chest.position));
    _sM.multiply(_sL.makeRotationFromEuler(_sE.set(0, 0, 0.22 * Math.max(0, p.shR[2] - 1.0) + 0.1 * Math.max(0, p.shR[0] - 2.0))).setPosition(B.clavR.position));
    const s = _sS.copy(B.armR.position).applyMatrix4(_sM), L = B.foreR.position.length() + B.handR.position.length() + RH;
    return s.y + Math.sqrt(Math.max(0, L * L - (c.x - s.x) ** 2 - (c.z - s.z) ** 2));
  }
  // The ball height this figure serves from: full stretch at a toss 14 cm to the side and 42 cm in front (game.js toss)
  // with a small jump. The toss is thrown so the ball is there at the usual contact, so every build hits at its own reach.
  serveHeight() {
    lerpPose(SV[4], SV[4], 0, _svP);
    return this.reachY(_svP, { x: 0.14, z: -0.42 }) + SV_JUMP + svOn(0.7);
  }
  serveHit(t, pow) { this.mode = 'serve'; this.contactT = t; if (pow != null) this.svPow = pow; for (const o of ALL) if (o !== this) o.splitStep(t - 0.2); }
  idle(standing) { this.mode = standing ? 'stand' : 'ready'; this.sh.known = false; this.cFor = -1; }
  // A split step: a small hop timed to land as the opponent strikes. A second call for the same stroke is ignored.
  splitStep(t) { if (Math.abs(t - this.hop) > 0.6) this.hop = t; }
  // amp: how big the point was (game.js announcePoint: 0.3 an ordinary point, 0.5+ an ace or a winner, 1 the match).
  react(kind, now, amp = 0.5) { this.reactKind = kind; this.reactUntil = now + 1.6; this.mode = 'react'; this.reactAmp = amp; }
  // Winning a point: a small fist on an ordinary one; on a big one this player's own celebration (style.celebrate).
  // All generic gestures (these pros are fictional): a fist, a two-fisted pump, a hand on the chest then pointing up,
  // both arms up to the crowd, or a calm raise of the racket. t = seconds since the point ended.
  celebrate(T, t, now) {
    const st = this.reactAmp >= 0.45 ? this.style.celebrate || 'default' : 'small';
    const h = sstep(0, 0.18, t) * (1 - sstep(1.25, 1.6, t)), pump = (t0, d) => { const u = (t - t0) / d; return u > 0 && u < 1 ? Math.sin(u * Math.PI) : 0; };
    const to = (a, i, v) => { a[i] = lerp(a[i], v, h); };
    if (st === 'default') { const p = Math.sin(now * 14) * 0.18 * clamp(1 - t / 1.9, 0, 1); T.shR[0] += p; T.elR += p * 0.6; return; }
    lerpPose(POSE.stand, POSE.stand, 0, T);
    if (st === 'small') {
      if (this.style.celebrate === 'calm') return;
      const p = pump(0.2, 0.3);
      to(T.shL, 0, 0.35 - 0.3 * p); T.elL = lerp(T.elL, 1.7 + 0.3 * p, h); to(T.hd, 0, -0.15);
    } else if (st === 'fist') {
      const p = pump(0.2, 0.24) + pump(0.5, 0.24);
      to(T.shL, 0, 0.6 - 0.45 * p); to(T.shL, 2, -0.25); T.elL = lerp(T.elL, 2.2 + 0.25 * p, h);
      to(T.sp, 0, -0.15); T.knR -= 0.2 * h; T.knL -= 0.2 * h; T.py -= 0.03 * h; to(T.hd, 0, -0.2);
    } else if (st === 'vamos') {
      const p = pump(0.15, 0.26) + pump(0.45, 0.26);
      to(T.shR, 0, 0.65 - 0.5 * p); to(T.shR, 2, 0.35); T.elR = lerp(T.elR, 1.9, h);
      to(T.shL, 0, 0.65 - 0.5 * p); to(T.shL, 2, -0.35); T.elL = lerp(T.elL, 2.1, h);
      to(T.sp, 0, -0.25); T.py -= (0.04 + 0.06 * p) * h; T.knR -= (0.25 + 0.3 * p) * h; T.knL -= (0.25 + 0.3 * p) * h; T.hipR[0] += 0.2 * h; T.hipL[0] += 0.2 * h;
    } else if (st === 'heart') {
      const up = sstep(0.7, 0.95, t), p = pump(0.2, 0.18) + pump(0.42, 0.18);
      to(T.shL, 0, lerp(0.35 + 0.15 * p, 2.75, up)); to(T.shL, 2, lerp(0.5, -0.25, up)); T.elL = lerp(T.elL, lerp(2.35, 0.15, up), h);
      to(T.hd, 0, lerp(-0.1, 0.25, up));
    } else if (st === 'arms') {
      to(T.shR, 0, 2.5); to(T.shR, 2, 0.9); T.elR = lerp(T.elR, 0.5, h); to(T.shL, 0, 2.5); to(T.shL, 2, -0.9); T.elL = lerp(T.elL, 0.5, h);
      T.py += 0.09 * pump(0.05, 0.3); to(T.hd, 0, 0.3); to(T.sp, 0, 0.12);
    } else if (st === 'calm') {
      to(T.shR, 0, 1.25); to(T.shR, 2, 0.35); T.elR = lerp(T.elR, 1.0, h); to(T.wrR, 0, 0.3); T.hd[0] -= 0.2 * pump(0.35, 0.4);
    }
  }
  // Between points (after the reaction): a short ritual of this player's own (style.ritual): a few quick bounces on the
  // toes, a wipe of the brow with the wristband then fixing the strings, or a twirl of the racket in the hand.
  ritual(T, t) {
    const r = this.style.ritual, h = sstep(0, 0.15, t) * (1 - sstep(0.95, 1.1, t));
    if (r === 'bounces') {
      for (const t0 of [0.05, 0.35, 0.65]) { const u = (t - t0) / 0.24; if (u > 0 && u < 1) { const p = Math.sin(u * Math.PI); T.py += 0.045 * p; T.knR += 0.2 * p; T.knL += 0.2 * p; } }
    } else if (r === 'tugs') {
      const w = sstep(0.1, 0.5, t), s = sstep(0.5, 0.65, t);
      T.shL[0] = lerp(T.shL[0], lerp(1.95, 0.8, s), h); T.shL[2] = lerp(T.shL[2], lerp(0.25 - 0.55 * w, 0.4, s), h); T.elL = lerp(T.elL, lerp(2.3, 1.25, s), h);
      T.hd[0] = lerp(T.hd[0], lerp(-0.1, -0.25, s), h);
      T.shR[0] = lerp(T.shR[0], 0.75, h * s); T.elR = lerp(T.elR, 1.3, h * s);
    } else if (r === 'quick') {
      T.shR[0] = lerp(T.shR[0], 0.6, h); T.elR = lerp(T.elR, 1.2, h); this.twirl = Math.PI * 2 * sstep(0.15, 0.7, t);   // (added after the smoothing: a full turn, not unwound)
    }
  }

  // Guess the stroke before the shot is known (the CPU decides at the contact): its usual spin, a volley at the net.
  guess(pl) {
    const s = this.sh, per = pl && pl.persona, plan = pl && pl.plan;
    if (s.known) return;
    s.pow = 0.6; s.drop = false; s.dir = 0; s.elev = 0.12; s.volley = !!(plan && plan.volley);
    s.spin = per && Number.isFinite(per.topspin) ? lerp(0.1, 0.8, per.topspin) : 0.4;
    if (plan && plan.y < 0.55 && per && per.slice > 0.62) s.spin = -0.5;
  }
  // A world point in the body frame of the player's own spot (without a lunge's step, which is chosen from it).
  toBody(x, y, z, pl, out) {
    const th = this.root.rotation.y, dx = x - pl.x, dz = z - pl.z;
    return out.set((Math.cos(th) * dx - Math.sin(th) * dz) * this.body.scale.x, y, Math.sin(th) * dx + Math.cos(th) * dz);
  }
  // Where the ball will be met, in the body frame (from the plan while there is one).
  contactPoint(pl) {
    const plan = pl && pl.plan;
    if (plan && Number.isFinite(plan.y) && Number.isFinite(plan.x)) {
      this.toBody(plan.x, plan.y, plan.z, pl, this.c);
      this.cFor = plan.t;
    } else if (this.cFor < 0) this.c.set(this.stroke === 'bh' ? -0.8 : 0.8, 0.95, -0.3);
    return this.c;
  }
  // The five keys of this swing from its shape and where the ball is met.
  buildKeys(c) {
    const sh = this.sh, bh = this.stroke === 'bh', s = bh ? -1 : 1;
    const vo = sh.volley ? 1 : 0, dr = !vo && sh.drop ? 1 : 0, pow = sh.pow;
    const top = vo || dr ? 0 : sstep(0.1, 0.7, sh.spin), sl = vo || dr ? 0 : sstep(0.05, 0.45, -sh.spin);
    const one = bh && (this.style.backhand === 'one' || sl > 0.5 || dr || vo);   // slices and volleys are one-handed
    const rows = bh ? (this.style.backhand === 'one' ? BH1 : BH2) : FH;
    const Tpre = vo ? 0.13 : dr ? 0.26 : lerp(0.25, 0.15, pow) * (1 + 0.1 * sl);
    const Tpost = vo ? 0.22 : dr ? 0.24 : lerp(0.42, 0.34, pow) * (1 - 0.2 * sl);
    const kt = this.kt;
    kt[0] = -Tpre; kt[1] = -0.45 * Tpre; kt[2] = 0; kt[3] = (dr ? 0.5 : 0.3) * Tpost; kt[4] = Tpost;
    this.ks[2] = dr ? 0.45 : 1 - 0.2 * sl;
    // Follow-through toward the ball: wrap further across for a crosscourt ball, out toward it for down the line.
    const al = clamp(-sh.dir * 2, -0.8, 0.8), ca = Math.cos(al), sa = Math.sin(al);
    // Reaching: a wide ball (lunge), a low one (bend), one well in front (lean).
    const ex = Math.abs(c.x) - 0.8, L = sstep(0.12, 0.65, ex), low = sstep(0.8, 0.35, c.y), high = sstep(1.3, 1.9, c.y), fw = sstep(0.15, 0.7, -c.z - 0.3);
    const yawK = vo ? [0.45, 0.4, 0.5, 0.3, 0.25] : dr ? [0.7, 0.7, 1, 0.3, 0.2] : null;
    const kp = this.kp;
    for (let i = 0; i < 5; i++) {
      lerpPose(BK[bh ? 'bh' : 'fh'][i], BK.fh[0], 0, kp);
      let yk = [0.8 + 0.35 * pow, 0.85 + 0.2 * pow, 1, 0.8 + 0.4 * pow, 0.75 + 0.45 * pow][i];
      if (yawK) yk *= yawK[i]; else yk *= 1 - sl * [0, 0, 0, 0.55, 0.65][i];
      kp.sp[1] *= yk;
      if (one && this.style.backhand === 'one' && !dr && !vo && sl < 0.5) kp.sp[1] = [1.5, 1.15, 0.7, 0.4, 0.15][i];
      if (i >= 3) { kp.sp[1] += al * (i === 3 ? 0.8 : 1); kp.hd[1] -= al * 0.5; }
      // Topspin loads the legs at the slot and drives up through the finish; a volley stays low.
      if (i <= 1) { kp.knR -= 0.25 * top; kp.knL -= 0.2 * top; kp.hipR[0] += 0.1 * top; kp.hipL[0] += 0.08 * top; }
      else if (i >= 3) { kp.knR = Math.min(-0.05, kp.knR + 0.15 * top); kp.knL = Math.min(-0.05, kp.knL + 0.15 * top); }
      if (vo) { kp.knR = kp.knL = -0.75; kp.hipR[0] = kp.hipL[0] = 0.45; kp.sp[0] = -0.2; }
      // One-handed: the free hand lets go at the contact and goes back for balance.
      if (one && i >= 2) { kp.shL[0] = i === 2 ? -0.3 : -0.55; kp.shL[1] = 0; kp.shL[2] = i === 2 ? -0.8 : -1.05; kp.elL = i === 2 ? 0.3 : 0.2; }
      // Reaching for the ball (fully at the contact, half at the take-back and finish).
      const e = i === 0 || i === 4 ? 0.5 : 1, oR = bh ? kp.hipL : kp.hipR, iR = bh ? kp.hipR : kp.hipL;
      const oLe = e * L, lw = e * low;
      if (!vo) { kp.hipR[2] += 0.08; kp.hipL[2] -= 0.08; if (i < 3) { kp.knR -= 0.15; kp.knL -= 0.15; } }   // an athletic, wide base
      oR[0] += 0.25 * oLe; oR[2] += s * 0.45 * oLe; iR[2] -= s * 0.3 * oLe;
      if (bh) { kp.knL -= 0.75 * oLe; kp.knR = lerp(kp.knR, -0.1, oLe); } else { kp.knR -= 0.75 * oLe; kp.knL = lerp(kp.knL, -0.1, oLe); }
      // The body goes to the ball: a step out to a wide one, in toward a jamming one, forward to a short one.
      kp.px += s * (clamp(ex - 0.1, -0.35, 0.7) * 0.75 + (bh ? 0.25 * L : 0)) * e; kp.pz -= clamp(-c.z - 0.4, -0.5, 0.6) * 0.6 * e; kp.sp[2] -= s * 0.2 * oLe;
      kp.knR -= 0.65 * lw; kp.knL -= 0.65 * lw; kp.hipR[0] += 0.4 * lw; kp.hipL[0] += 0.4 * lw; kp.sp[0] -= 0.18 * lw;
      kp.sp[0] -= 0.2 * fw * e;
      kp.knR = Math.min(-0.05, kp.knR + 0.2 * high * e); kp.knL = Math.min(-0.05, kp.knL + 0.2 * high * e);
      kp.py = footPy(kp) * (this.rest.hips.y / 0.97) + 0.05 * high * e + (i >= 3 ? 0.02 * top : 0);
      const K = poseToArr(kp, this.K[i]);
      // Racket target.
      const F = rows.F[i], r = (j) => F[j] + top * (rows.T[i][j] - F[j]) + sl * (rows.S[i][j] - F[j]) + dr * (rows.D[i][j] - F[j]) + vo * (rows.V[i][j] - F[j]);
      let Wx = r(0), Wy = r(1), Wz = r(2), ax = r(3), ay = r(4), az = r(5), nx = r(6), ny = r(7), nz = r(8);
      if (i < 2) { Wy += (c.y - 0.95) * (i ? 0.7 : 0.45); Wx += s * ex * 0.5; }
      if (i >= 3) {
        [Wx, Wz] = [ca * Wx + sa * Wz, -sa * Wx + ca * Wz]; [ax, az] = [ca * ax + sa * az, -sa * ax + ca * az]; [nx, nz] = [ca * nx + sa * nz, -sa * nx + ca * nz];
        Wy += clamp(sh.elev - 0.12, -0.1, 0.5) * 0.8;   // a lob finishes up
      }
      if (i === 2) { [nx, nz] = [ca * nx + sa * nz, -sa * nx + ca * nz]; }
      const al2 = Math.hypot(ax, ay, az) || 1, nl = Math.hypot(nx, ny, nz) || 1;
      ax /= al2; ay /= al2; az /= al2;
      if (i === 2) { K[PLEN] = c.x - kp.px; K[PLEN + 1] = c.y; K[PLEN + 2] = c.z - kp.pz; }   // (the ball, from where the step takes the body) else { K[PLEN] = Wx + RH * ax; K[PLEN + 1] = Wy + RH * ay; K[PLEN + 2] = Wz + RH * az; }
      K[PLEN + 3] = ax; K[PLEN + 4] = ay; K[PLEN + 5] = az; K[PLEN + 6] = nx / nl; K[PLEN + 7] = ny / nl; K[PLEN + 8] = nz / nl; K[PLEN + 9] = r(9);
      // The free hand: a two-hander's on the grip through the stroke, a one-hander's on the throat at the take-back.
      K[PLEN + 10] = bh ? (one ? [0.9, 0.5, 0, 0, 0][i] : [1, 1, 1, 1, 0.85][i]) : 0;
    }
    this.lGrip = one ? THROAT : GRIP2;
  }

  update(dt, now, pl) {
    const speed = Math.hypot(pl.vx, pl.vz), T = this.target;
    // Place the figure first: the racket is aimed at the ball in world space.
    const lat = pl.vx * pl.side, fwd = -pl.vz * pl.side;
    let yawT = 0;
    // Short sideways moves (recovering to the middle, adjusting) are side shuffles facing the net, not a run.
    this.shuf = damp(this.shuf || 0, this.mode === 'ready' && speed > 0.3 && speed < 3.6 && Math.abs(lat) > 0.75 * speed ? 1 : 0, 10, dt);
    if ((this.mode === 'ready' || this.mode === 'stand') && speed > 1.4) yawT = clamp(Math.atan2(-lat, Math.abs(fwd) + 0.01), -1.1, 1.1) * clamp((speed - 1.4) / 2, 0, 1) * (1 - this.shuf);
    this.yaw = damp(this.yaw, yawT, 8, dt);
    this.root.position.set(pl.x, 0, pl.z);
    this.root.rotation.y = (pl.side > 0 ? 0 : Math.PI) + this.yaw;
    let k = 14, ik = 0;
    if (this.mode === 'swing') {
      const tau = now - this.contactT;
      if (tau < 0) this.guess(pl);
      this.buildKeys(tau < 0 ? this.contactPoint(pl) : this.c);
      arrToPose(spline(this.K, this.kt, this.ks, tau + LEAD, this.kv), T);   // the body (smoothed below, so a little ahead)
      spline(this.K, this.kt, this.ks, tau, this.kv);                         // the racket, exactly now
      ik = 1; k = 40;
      if (tau > this.kt[4] + 0.12) { this.mode = 'ready'; this.cFor = -1; this.sh.known = false; }
    } else if (this.mode === 'serve') {
      const ts = now - this.tossT, K = this.buildServe(pl), kt = K === this.SK ? this.skt : this.skt3;
      if (K === this.SK3) this.skt3.set(this.skt.subarray(0, 3));
      arrToPose(spline(K, kt, this.sks, ts + LEAD, this.kv), T);
      spline(K, kt, this.sks, ts, this.kv);
      ik = 1; k = 30;
      if (this.contactT && now > this.contactT + 0.7) this.mode = 'ready';
    } else if (this.mode === 'react') {
      lerpPose(POSE.stand, POSE[this.reactKind] || POSE.stand, 1, T);
      if (this.reactKind === 'win') this.celebrate(T, now - (this.reactUntil - 1.95), now);
      k = this.reactKind === 'win' ? 16 : 9;
      if (now > this.reactUntil) { this.mode = 'stand'; this.ritualT = now; }
    } else {
      lerpPose(POSE.ready, POSE.stand, this.mode === 'stand' ? 1 : 0, T);
      if (this.prep > 0) {
        // Taking the racket back as the ball comes: the take-back of the stroke it will be.
        this.stroke = this.prepStroke; this.guess(pl);
        this.buildKeys(this.contactPoint(pl));
        this.kv.set(this.K[0]); arrToPose(this.kv, this.tmpPose);
        lerpPose(T, this.tmpPose, this.prep * 0.85, T);
        ik = this.prep * 0.85;
      } else this.cFor = -1;
      const r = clamp(speed / 5, 0, 1) * (1 - this.shuf), gait = this.style.gait, g = gait === 'bouncy' ? 1.8 : gait === 'glide' ? 0.5 : 1;
      if (r > 0.02) {
        this.runPhase += dt * (5 + speed * 1.7);
        const s = Math.sin(this.runPhase), c = Math.cos(this.runPhase);
        T.hipR[0] = lerp(T.hipR[0], 0.25 + s * 0.8, r); T.hipL[0] = lerp(T.hipL[0], 0.25 - s * 0.8, r);
        T.knR = lerp(T.knR, -0.35 - Math.max(0, -c) * 1.1, r); T.knL = lerp(T.knL, -0.35 - Math.max(0, c) * 1.1, r);
        T.shL[0] = lerp(T.shL[0], 0.3 - s * 0.6, r); T.py -= 0.03 * g * Math.abs(c) * r; T.sp[0] -= 0.12 * r;
      } else if (this.mode === 'ready') {
        const b = Math.sin(now * (gait === 'bouncy' ? 7 : 5.2)) * 0.012 * g;   // weight shifting on the toes
        T.py += b; T.knR -= b * 2; T.knL -= b * 2;
      }
      if (this.shuf > 0.02) {
        this.shufPhase = (this.shufPhase || 0) + dt * (8 + speed * 2.5);
        const w = this.shuf, open = 0.5 + 0.5 * Math.sin(this.shufPhase);
        T.hipR[2] += w * (0.05 + 0.17 * open); T.hipL[2] -= w * (0.05 + 0.17 * open);
        T.hipR[0] += 0.1 * w; T.hipL[0] += 0.1 * w; T.knR -= 0.2 * w; T.knL -= 0.2 * w;
        T.py += w * (0.03 * g * Math.abs(Math.cos(this.shufPhase)) - 0.05);
      }
      // Split step: a small hop as the opponent strikes, landing low and wide.
      const h = now - this.hop;
      if (h >= 0 && h < 0.44) {
        const u = h / 0.44, up = Math.sin(clamp(u / 0.45, 0, 1) * Math.PI), land = u > 0.45 ? Math.sin(((u - 0.45) / 0.55) * Math.PI) : 0, wd = 0.1 * up + 0.17 * land;
        T.py += 0.07 * up - 0.07 * land; T.knR += 0.2 * up - 0.4 * land; T.knL += 0.2 * up - 0.4 * land;
        T.hipR[0] += 0.18 * land; T.hipL[0] += 0.18 * land; T.hipR[2] += wd; T.hipL[2] -= wd;
      }
      if (now - (this.ritualT ?? -9) < 1.1 && r < 0.3) this.ritual(T, now - this.ritualT);
      T.shR[0] += this.armLift;
    }
    lerpPose(this.pose, T, 1 - Math.exp(-k * dt), this.pose);
    // A lunge's step moves the whole figure (body frame px / pz; the root, so replays keep it too).
    const th = this.root.rotation.y, ox = this.pose.px * this.body.scale.x, oz = this.pose.pz;
    this.root.position.set(pl.x + Math.cos(th) * ox + Math.sin(th) * oz, 0, pl.z - Math.sin(th) * ox + Math.cos(th) * oz);
    // The racket arm is solved on the smoothed body, so the head is where the path says (and on the ball at contact).
    if (ik > 0.01) this.aim(this.pose, ik, dt); else this.ikQ = this.ikL = null;
    this.applyPose(this.pose, dt, pl);
    if (this.twirl) { this.B.handR.rotation.y += this.twirl; this.twirl = 0; }
  }
  // Racket arm FK for angles q = [shoulder xyz, elbow, wrist xyz]: world racket-head centre, axis and (for the string
  // face) the face normal crossed with the wanted one, so either side of the strings will do.
  armFK(q, f) {
    const B = this.B;
    _M.copy(B.clavR.matrixWorld);
    _M.multiply(_L.makeRotationFromEuler(_E.set(q[0], q[1], q[2])).setPosition(B.armR.position));
    _M.multiply(_L.makeRotationFromEuler(_E.set(q[3], 0, 0)).setPosition(B.foreR.position));
    _M.multiply(_L.makeRotationFromEuler(_E.set(q[4], q[5], q[6])).setPosition(B.handR.position));
    _M.multiply(this.racket.matrix);
    _w.copy(HEADC).applyMatrix4(_M); f[0] = _w.x; f[1] = _w.y; f[2] = _w.z;
    _w.set(0, -1, 0).transformDirection(_M); f[3] = _w.x; f[4] = _w.y; f[5] = _w.z;
    _w.set(0, 0, 1).transformDirection(_M).cross(_tN); f[6] = _w.x; f[7] = _w.y; f[8] = _w.z;
  }
  leftFK(q, f) {
    const B = this.B, p = this.pose;
    _M.copy(B.clavL.matrixWorld);
    _M.multiply(_L.makeRotationFromEuler(_E.set(q[0], q[1], q[2])).setPosition(B.armL.position));
    _M.multiply(_L.makeRotationFromEuler(_E.set(q[3], 0, 0)).setPosition(B.foreL.position));
    _M.multiply(_L.makeRotationFromEuler(_E.set(p.wrL[0], p.wrL[1], p.wrL[2])).setPosition(B.handL.position));
    _w.copy(PALM).applyMatrix4(_M); f[0] = _w.x; f[1] = _w.y; f[2] = _w.z;
  }
  // Solve the racket arm (and a two-hander's other hand) for this frame's racket target; blend it in by w. T is the
  // smoothed pose about to be shown: its arm angles seed the solve and are replaced.
  aim(T, w, dt) {
    const B = this.B, kv = this.kv, P0 = PLEN;
    // The body the arms hang from.
    B.hips.position.set(this.rest.hips.x, this.rest.hips.y + T.py, this.rest.hips.z);
    B.spine.rotation.set(T.sp[0] * 0.45, T.sp[1] * 0.45, T.sp[2] * 0.5);
    B.chest.rotation.set(T.sp[0] * 0.55, T.sp[1] * 0.55, T.sp[2] * 0.5);
    B.clavR.rotation.set(0, 0, 0.22 * Math.max(0, T.shR[2] - 1.0) + 0.1 * Math.max(0, T.shR[0] - 2.0));
    B.clavL.rotation.set(0, 0, -0.22 * Math.max(0, -T.shL[2] - 1.0) - 0.1 * Math.max(0, T.shL[0] - 2.0));
    B.clavR.updateWorldMatrix(true, false); B.clavL.updateWorldMatrix(false, false);
    const bw = this.body.matrixWorld;
    _tH.set(kv[P0], kv[P0 + 1], kv[P0 + 2]).applyMatrix4(bw);
    _tA.set(kv[P0 + 3], kv[P0 + 4], kv[P0 + 5]).transformDirection(bw);
    _tN.set(kv[P0 + 6], kv[P0 + 7], kv[P0 + 8]).transformDirection(bw);
    _t[0] = _tH.x; _t[1] = _tH.y; _t[2] = _tH.z; _t[3] = _tA.x; _t[4] = _tA.y; _t[5] = _tA.z; _t[6] = _t[7] = _t[8] = 0;
    W_R[6] = W_R[7] = W_R[8] = 0.25 * kv[P0 + 9]; W_R[3] = W_R[4] = W_R[5] = 0.3 - 0.18 * kv[P0 + 9];   // at the contact, the head on the ball first
    _sd[0] = T.shR[0]; _sd[1] = T.shR[1]; _sd[2] = T.shR[2]; _sd[3] = T.elR; _sd[4] = T.wrR[0]; _sd[5] = T.wrR[1]; _sd[6] = T.wrR[2];
    const fresh = !this.ikQ, q = this.ikQ || (this.ikQ = Float64Array.from(_sd)), A = this.armPrev || (this.armPrev = new Float64Array(11));
    if (fresh) A.set(_sd);
    solveIK(q, _sd, LO_R, HI_R, 7, this.fkR, _t, W_R, 9, fresh ? 10 : 3);
    // No jumps when a stroke starts late: a joint turns at most ~45 rad/s.
    const cap = 45 * Math.max(dt || 0.016, 0.004), put = (j, v) => (A[j] = clamp(v, A[j] - cap, A[j] + cap));
    T.shR[0] = put(0, lerp(T.shR[0], q[0], w)); T.shR[1] = put(1, lerp(T.shR[1], q[1], w)); T.shR[2] = put(2, lerp(T.shR[2], q[2], w)); T.elR = put(3, lerp(T.elR, q[3], w));
    T.wrR[0] = put(4, lerp(T.wrR[0], q[4], w)); T.wrR[1] = put(5, lerp(T.wrR[1], q[5], w)); T.wrR[2] = put(6, lerp(T.wrR[2], q[6], w));
    // The other hand on the racket: where the grip is with the arm as shown.
    const wl = w * kv[P0 + 10];
    if (wl < 0.01) { this.ikL = null; return; }
    _sd[0] = T.shR[0]; _sd[1] = T.shR[1]; _sd[2] = T.shR[2]; _sd[3] = T.elR; _sd[4] = T.wrR[0]; _sd[5] = T.wrR[1]; _sd[6] = T.wrR[2];
    this.armFK(_sd, _f1);
    _w.copy(this.lGrip).applyMatrix4(_M);
    _t[0] = _w.x; _t[1] = _w.y; _t[2] = _w.z;
    _sd[0] = T.shL[0]; _sd[1] = T.shL[1]; _sd[2] = T.shL[2]; _sd[3] = T.elL;
    const freshL = !this.ikL, qL = this.ikL || (this.ikL = Float64Array.from(_sd.subarray(0, 4)));
    if (freshL) A.set(_sd.subarray(0, 4), 7);
    solveIK(qL, _sd, LO_L, HI_L, 4, this.fkL, _t, W_L, 3, freshL ? 10 : 3);
    const putL = (j, v) => (A[7 + j] = clamp(v, A[7 + j] - cap, A[7 + j] + cap));
    T.shL[0] = putL(0, lerp(T.shL[0], qL[0], wl)); T.shL[1] = putL(1, lerp(T.shL[1], qL[1], wl)); T.shL[2] = putL(2, lerp(T.shL[2], qL[2], wl)); T.elL = putL(3, lerp(T.elL, qL[3], wl));
  }
  applyPose(p, dt, pl) {
    const B = this.B;
    B.hips.position.set(this.rest.hips.x, this.rest.hips.y + p.py, this.rest.hips.z);
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
