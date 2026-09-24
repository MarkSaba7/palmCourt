// Court effects: clay dust where the ball lands and where players run and slide, and a chalk puff when a ball
// clips a line on grass. Bounces are spotted from the ball's motion, so they appear in live play, replays and the
// pre-serve bounce alike.
import * as THREE from 'three';
import { COURT, BALL_R } from '../core.js';
import { scene, camera, renderer } from './renderer.js';
import { addSkidMark } from './court.js';

const MAX = 700;
const DUST = { clay: [0.5, 0.2, 0.095], chalk: [0.9, 0.9, 0.86] };   // linear albedo
const TOD_LIGHT = { day: [1.0, 0.98, 0.95], golden: [0.95, 0.8, 0.66], night: [0.78, 0.8, 0.86] };

const VERT = `
  attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
  uniform float uScale; varying float vAlpha; varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
    vAlpha = aAlpha; vColor = aColor;
  }`;
const FRAG = `
  uniform vec3 uLight; varying float vAlpha; varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    float a = smoothstep(1.0, 0.15, r);
    // a little lumpiness so puffs don't read as perfect discs
    a *= 0.75 + 0.25 * sin(d.x * 17.0 + d.y * 11.0 + vAlpha * 40.0);
    gl_FragColor = vec4(vColor * uLight, a * a * vAlpha);
  }`;

// Distance from (x, z) to the nearest painted line (for chalk puffs on grass).
function lineDistance(x, z) {
  const ax = Math.abs(x), az = Math.abs(z), { halfL, halfSW, halfDW, svc } = COURT;
  let d = Infinity;
  if (az <= halfL) { d = Math.min(d, Math.abs(ax - (halfSW - 0.025)), Math.abs(ax - (halfDW - 0.025))); }
  if (ax <= halfDW) d = Math.min(d, Math.abs(az - (halfL - 0.04)));
  if (ax <= halfSW) d = Math.min(d, Math.abs(az - (svc - 0.025)));
  if (az <= svc) d = Math.min(d, ax);
  return d;
}

export const Effects = {
  pts: null, geo: null, mat: null, head: 0, live: 0,
  p: new Float32Array(MAX * 3), v: new Float32Array(MAX * 3), age: new Float32Array(MAX).fill(1), life: new Float32Array(MAX).fill(1),
  s0: new Float32Array(MAX), s1: new Float32Array(MAX), a0: new Float32Array(MAX), rise: new Float32Array(MAX),
  prevY: 1, prevDy: 0, feet: [], surface: 'hard', _size: new THREE.Vector2(),

  init() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 400 }, uLight: { value: new THREE.Vector3(...TOD_LIGHT.day) } },
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 2;
    this.pts.userData.noAO = true;
    scene.add(this.pts);
  },
  setTimeOfDay(tod) { if (this.mat) this.mat.uniforms.uLight.value.set(...(TOD_LIGHT[tod] || TOD_LIGHT.day)); },
  setSurface(kind) { this.surface = kind; },

  // One particle. Sizes in metres; rise is upward drift that fades with age.
  emit(x, y, z, vx, vy, vz, { life = 1, size = [0.06, 0.3], alpha = 0.4, color = DUST.clay, rise = 0.25 } = {}) {
    const i = this.head; this.head = (this.head + 1) % MAX;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = size[0]; this.s1[i] = size[1]; this.a0[i] = alpha; this.rise[i] = rise;
    const c = this.geo.attributes.aColor.array, k = 0.9 + Math.random() * 0.2;
    c[i * 3] = color[0] * k; c[i * 3 + 1] = color[1] * k; c[i * 3 + 2] = color[2] * k;
    this.geo.attributes.aColor.needsUpdate = true;
  },
  // A ball landing: a low, spreading puff pushed along the ball's direction.
  bounce(x, z, dx, dz, speed) {
    if (this.surface === 'clay') {
      const k = Math.min(1, speed / 9), n = 10 + k * 16 | 0;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.08, s = (0.2 + Math.random() * 0.6) * (0.6 + 0.6 * k);
        this.emit(x + Math.cos(a) * r, 0.02 + Math.random() * 0.04, z + Math.sin(a) * r,
          Math.cos(a) * s * 0.55 + dx * 1.1, 0.15 + Math.random() * 0.5 * (0.5 + k), Math.sin(a) * s * 0.55 + dz * 1.1,
          { life: 0.9 + Math.random() * 1.0, size: [0.07, 0.3 + Math.random() * 0.3 * (0.5 + k)], alpha: 0.4 + Math.random() * 0.25, rise: 0.35 });
      }
    } else if (this.surface === 'grass' && lineDistance(x, z) < 0.03 + BALL_R) {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, s = 0.2 + Math.random() * 0.5;
        this.emit(x, 0.02, z, Math.cos(a) * s + dx * 0.6, 0.25 + Math.random() * 0.4, Math.sin(a) * s + dz * 0.6,
          { life: 0.6 + Math.random() * 0.5, size: [0.03, 0.15], alpha: 0.55, color: DUST.chalk, rise: 0.1 });
      }
    }
  },
  // Players kicking up clay: more when running hard or braking.
  footDust(x, z, speed, brake, vx = 0, vz = 0, f = null) {
    if (this.surface !== 'clay') return;
    // A hard stop on clay leaves a slide mark along the direction of travel.
    if (brake > 15 && speed > 2.5 && f && f.skidT <= 0) { addSkidMark(x, z, vx, vz, 0.45 + Math.min(0.5, speed * 0.1)); f.skidT = 0.6; }
    const n = brake > 9 ? 3 : speed > 3.2 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.emit(x + Math.cos(a) * 0.12, 0.03, z + Math.sin(a) * 0.12, Math.cos(a) * 0.3, 0.12 + Math.random() * 0.25, Math.sin(a) * 0.3,
        { life: 0.8 + Math.random() * 0.6, size: [0.08, 0.35 + Math.random() * 0.2], alpha: brake > 9 ? 0.28 : 0.15 });
    }
  },

  // ball: position (or null when hidden); actors: objects with a .root (players), to follow their feet.
  update(dt, ball, actors) {
    if (!this.pts || dt <= 0) return;
    // Bounce detection from the ball's path: falling, then rising, near the court.
    if (ball) {
      const dy = ball.y - this.prevY;
      // The lowest sampled point of a local minimum in height: in flight that only happens at a bounce.
      if (this.prevDy < -1e-4 && dy >= 0 && this.prevY < 0.25) {
        const sp = Math.abs(this.prevDy) / dt;
        this.bounce(this.bx, this.bz, (ball.x - this.bx) / dt * 0.04, (ball.z - this.bz) / dt * 0.04, sp);
      }
      this.prevDy = dy; this.prevY = ball.y; this.bx = ball.x; this.bz = ball.z;
    } else { this.prevDy = 0; this.prevY = 1; }
    if (ball && this.bx === undefined) { this.bx = ball.x; this.bz = ball.z; }
    // Feet
    actors.forEach((a, i) => {
      const f = this.feet[i] || (this.feet[i] = { x: a.root.position.x, z: a.root.position.z, vx: 0, vz: 0, t: 0 });
      const vx = (a.root.position.x - f.x) / dt, vz = (a.root.position.z - f.z) / dt;
      const speed = Math.hypot(vx, vz), brake = Math.hypot(vx - f.vx, vz - f.vz) / dt;
      f.t -= dt; f.skidT = (f.skidT || 0) - dt;
      if (f.t <= 0 && speed < 12) { this.footDust(a.root.position.x, a.root.position.z, speed, brake * (speed > 1 ? 1 : 0), vx, vz, f); f.t = 0.09; }
      f.x = a.root.position.x; f.z = a.root.position.z; f.vx = vx; f.vz = vz;
    });
    // Integrate
    const P = this.p, V = this.v, sz = this.geo.attributes.aSize.array, al = this.geo.attributes.aAlpha.array;
    const drag = Math.exp(-2.6 * dt);
    let live = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i] >= 1) { if (al[i] !== 0) { al[i] = 0; sz[i] = 0; } continue; }
      live++;
      const age = (this.age[i] += dt / this.life[i]);
      V[i * 3] *= drag; V[i * 3 + 2] *= drag; V[i * 3 + 1] = V[i * 3 + 1] * drag + this.rise[i] * dt * (1 - age);
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] = Math.max(0.01, P[i * 3 + 1] + V[i * 3 + 1] * dt); P[i * 3 + 2] += V[i * 3 + 2] * dt;
      const a = Math.min(1, age);
      sz[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(a);
      al[i] = this.a0[i] * Math.min(1, a * 12) * (1 - a) * (1 - a);
    }
    this.live = live;
    if (live || this.wasLive) {
      this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true; this.geo.attributes.aAlpha.needsUpdate = true;
    }
    this.wasLive = live > 0;
    renderer.getDrawingBufferSize(this._size);
    this.mat.uniforms.uScale.value = this._size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  },
};
