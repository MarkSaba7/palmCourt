// Instant replay. Every point is recorded frame by frame (the ball plus both players' skeletons), and the big ones
// (aces, winners, long rallies, the match point) are replayed in slow motion from a broadcast angle. Close line
// calls get a line-review view: the ball's last flight seen low along the line, then its footprint from above.
import * as THREE from 'three';
import { clamp, lerp, damp, sstep, pick, Clock, COURT, LINE_TOL, Settings } from './core.js';
import { scene, camera, Look } from './render/world.js';
import { BallView } from './render/actors.js';

const MAXF = 1200;   // 20 s at 60 fps
const BALL = 11;     // per frame: t, p(3), v(3), w(3), visible
const LONG_RALLY = 12;   // a rally this long earns a replay even when it ends in an error
const $ = (id) => document.getElementById(id);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _P = new THREE.Vector3(), _T = new THREE.Vector3();

// How far outside (+) or inside (-) the deciding line a bounce landed. box: null for the singles court, or
// { rSide, court } for a service box. axis 'x' is a sideline (runs along z), 'z' a baseline or service line.
export function lineMargin(x, z, box) {
  const c = [];
  if (!box) {
    c.push({ d: Math.abs(x) - (COURT.halfSW + LINE_TOL), axis: 'x', at: Math.sign(x || 1) * COURT.halfSW });
    c.push({ d: Math.abs(z) - (COURT.halfL + LINE_TOL), axis: 'z', at: Math.sign(z || 1) * COURT.halfL });
  } else {
    const k = box.court === 'deuce' ? box.rSide : -box.rSide, lx = x * k;
    c.push({ d: Math.abs(z) - (COURT.svc + LINE_TOL), axis: 'z', at: box.rSide * COURT.svc });
    c.push({ d: lx - (COURT.halfSW + LINE_TOL), axis: 'x', at: k * COURT.halfSW });
    c.push({ d: (-0.025 - LINE_TOL) - lx, axis: 'x', at: 0 });
  }
  return c.reduce((a, b) => (b.d > a.d ? b : a));
}

// Footprint of the ball on the court for the line-review view: a skid-shaped oval with a bright rim.
function makeFootprint() {
  const g = new THREE.Group();
  const fill = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.54, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }));
  for (const m of [fill, rim]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 3; m.userData.noAO = true; g.add(m); }
  rim.position.y = 0.0005;
  g.visible = false;
  g.userData.fill = fill;
  scene.add(g);
  return g;
}

export const Replay = {
  active: false, phase: 'idle', avatars: null, bones: null, stride: 0, buf: null, n: 0, lastAt: -99,
  spec: null, t: 0, timeScale: 1, holdUntil: 0, phaseAt: 0, onEnd: null, onBoard: null, foot: null,
  cp: new THREE.Vector3(), cl: new THREE.Vector3(), fov: 30, snap: true,
  fake: { p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } },

  init(avatars, { onEnd, onBoard } = {}) {
    this.avatars = avatars;
    this.bones = avatars.map((a) => Object.values(a.B));
    this.stride = BALL + this.bones.reduce((s, b) => s + 4 + b.length * 4, 0);
    this.buf = new Float32Array(MAXF * this.stride);
    this.onEnd = onEnd; this.onBoard = onBoard;
    this.foot = makeFootprint();
  },
  reset() { if (!this.busy()) this.n = 0; },
  busy() { return this.phase !== 'idle'; },

  // ---- recording: once per rendered frame, after the game has moved everything ----
  record(ball, visible) {
    if (!this.buf || this.phase === 'play' || this.phase === 'hold') return;
    const B = this.buf, o = (this.n % MAXF) * this.stride;
    B[o] = Clock.now();
    B[o + 1] = ball.p.x; B[o + 2] = ball.p.y; B[o + 3] = ball.p.z;
    B[o + 4] = ball.v.x; B[o + 5] = ball.v.y; B[o + 6] = ball.v.z;
    B[o + 7] = ball.w.x; B[o + 8] = ball.w.y; B[o + 9] = ball.w.z;
    B[o + 10] = visible ? 1 : 0;
    let k = o + BALL;
    this.avatars.forEach((a, i) => {
      B[k++] = a.root.position.x; B[k++] = a.root.position.z; B[k++] = a.root.rotation.y; B[k++] = a.B.hips.position.y;
      for (const bone of this.bones[i]) { const q = bone.quaternion; B[k++] = q.x; B[k++] = q.y; B[k++] = q.z; B[k++] = q.w; }
    });
    this.n++;
  },
  first() { return Math.max(0, this.n - MAXF); },
  timeAt(i) { return this.buf[(i % MAXF) * this.stride]; },
  // Last recorded frame at or before t.
  find(t) {
    let lo = this.first(), hi = this.n - 1;
    if (hi < lo) return -1;
    if (t <= this.timeAt(lo)) return lo;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.timeAt(mid) <= t) lo = mid; else hi = mid - 1; }
    return lo;
  },
  // Put the ball and both players exactly where they were at time t (blending between recorded frames).
  apply(t, dt) {
    const i = this.find(t);
    if (i < 0) return;
    const j = Math.min(i + 1, this.n - 1), B = this.buf, a = (i % MAXF) * this.stride, b = (j % MAXF) * this.stride;
    const u = B[b] > B[a] ? clamp((t - B[a]) / (B[b] - B[a]), 0, 1) : 0;
    const L = (k) => B[a + k] + (B[b + k] - B[a + k]) * u, f = this.fake;
    f.p.x = L(1); f.p.y = L(2); f.p.z = L(3); f.v.x = L(4); f.v.y = L(5); f.v.z = L(6); f.w.x = L(7); f.w.y = L(8); f.w.z = L(9);
    BallView.update(f, B[a + 10] > 0.5, dt);
    let k = BALL;
    this.avatars.forEach((av, n) => {
      av.root.position.set(L(k), 0, L(k + 1));
      const ya = B[a + k + 2], d = Math.atan2(Math.sin(B[b + k + 2] - ya), Math.cos(B[b + k + 2] - ya));
      av.root.rotation.y = ya + d * u;
      av.B.hips.position.y = L(k + 3);
      k += 4;
      for (const bone of this.bones[n]) {
        _qa.set(B[a + k], B[a + k + 1], B[a + k + 2], B[a + k + 3]);
        _qb.set(B[b + k], B[b + k + 1], B[b + k + 2], B[b + k + 3]);
        bone.quaternion.slerpQuaternions(_qa, _qb, u);
        k += 4;
      }
    });
  },

  // ---- deciding what to show ----
  // A point (or a serve) just ended. spec: { reason, rally, matchPoint, hitT, tossT, endT, bounces, line, hitter, receiver }
  consider(spec) {
    if (!Settings.replays || !this.buf || this.busy() || this.n < 30) return;
    const b1 = spec.bounces[0], close = spec.line && Math.abs(spec.line.d) < 0.06 && b1;
    let style = null;
    if (close && ['out', 'winner', 'ace', 'fault', 'df'].includes(spec.reason)) style = 'hawk';
    else if (spec.reason === 'fault') return;
    else if (spec.reason === 'ace' && b1) style = 'receiver';
    else if (spec.matchPoint || (spec.reason === 'winner' && spec.rally >= 3) || spec.rally >= LONG_RALLY) style = pick(['rail', 'behind', 'rail']);
    if (!style) return;
    if (style !== 'hawk' && Clock.now() - this.lastAt < 25 && !spec.matchPoint) return;   // don't overdo it
    const hitT = spec.hitT, key = b1 ? b1.t : hitT;
    let t0, t1;
    if (style === 'hawk') { t0 = key - 0.75; t1 = key + 0.3; }
    else if (style === 'receiver') { t0 = spec.tossT + 0.25; t1 = Math.min(spec.endT, key + 0.7); }
    else { t0 = Math.max(hitT - 1.1, spec.tossT || -Infinity); t1 = Math.min(spec.endT + 0.25, key + 1.0); }
    t0 = Math.max(t0, this.timeAt(this.first()));
    if (!(t1 > t0 + 0.3)) return;
    this.spec = { ...spec, style, t0, t1, keys: [hitT, key] };
    this.phase = 'wait';
    this.phaseAt = Clock.perf() + (style === 'hawk' ? 0.5 : 1.15);   // let the call and the reaction land first
  },

  // ---- playback ----
  // Runs every frame. Returns true while the replay owns the camera and the actors.
  update(dt) {
    const now = Clock.perf(), S = this.spec;
    if (this.phase === 'idle') return false;
    if (Clock.paused) { this.phaseAt += dt; return this.active; }   // the pause menu freezes the replay too
    if (this.phase === 'wait') {
      if (now >= this.phaseAt) { this.wipe(); this.phase = 'in'; this.phaseAt = now + 0.24; }
      return false;
    }
    if (this.phase === 'in') {
      if (now < this.phaseAt) return false;
      this.phase = 'play'; this.active = true; this.t = S.t0; this.snap = true; this.lastAt = Clock.now();
      this.overlay(true);
      if (this.onBoard) this.onBoard(S.style === 'hawk' ? 'LINE REVIEW' : 'REPLAY', 9000);
    }
    if (this.phase === 'out') {
      if (now < this.phaseAt) return true;
      return this.finish();
    }
    if (this.phase === 'play') {
      // Slow motion that eases down around the key moments (the strike, the bounce).
      const near = Math.min(...S.keys.map((k) => Math.abs(this.t - k)));
      const slow = S.style === 'hawk' ? 0.2 : 0.3;
      const speed = slow + (0.95 - slow) * sstep(0.12, 0.7, near);
      this.t = Math.min(S.t1, this.t + dt * speed); this.timeScale = speed;
      this.apply(this.t, dt * speed);
      if (this.t >= S.t1) {
        if (S.style === 'hawk') { this.phase = 'hold'; this.phaseAt = now + 2.4; this.timeScale = 0; this.showCall(); }
        else this.end();
      }
    }
    if (this.phase === 'hold' && now >= this.phaseAt) this.end();
    this.camera(dt);
    return true;
  },
  camera(dt) {
    const S = this.spec, f = this.fake, P = _P, T = _T, b1 = S.bounces[0];
    let fov = 30;
    const ball = f.p;
    if (S.style === 'hawk' && this.phase === 'hold') {
      // Looking down on the footprint, steep and tight.
      const s = Math.sign(b1.z || 1);
      P.set(b1.x + (S.line.axis === 'z' ? 0.15 : 0), 1.25, b1.z + s * 0.55); T.set(b1.x, 0, b1.z); fov = 26;
    } else if (S.style === 'hawk') {
      // Low along the deciding line, so in or out is plain to see.
      if (S.line.axis === 'x') { P.set(S.line.at + Math.sign(S.line.at || 1) * 0.2, 0.32, b1.z + Math.sign(b1.z || 1) * 2.6); T.set(S.line.at, 0.05, b1.z); }
      else { const s = Math.sign(b1.x || 1); P.set(b1.x + s * 2.6, 0.32, S.line.at + Math.sign(S.line.at) * 0.2); T.set(b1.x, 0.05, S.line.at); }
      T.lerp(ball, 0.35 * clamp(1 - Math.abs(this.t - b1.t) * 2.5, 0, 1));
      fov = 28;
    } else if (S.style === 'receiver') {
      // Behind the receiver's baseline, the serve coming straight at the lens.
      const rs = S.receiver.side;
      P.set(b1.x * 0.45, 1.05, rs * 18.8); T.set(lerp(b1.x, ball.x, 0.6), lerp(0.6, ball.y, 0.5), ball.z * 0.7);
      fov = 24;
    } else if (S.style === 'behind') {
      // Low behind the hitter, then following the ball down the court.
      const h = S.hitter.avatar.root.position, hs = S.hitter.side;   // where the replayed hitter is, not the live one
      P.set(h.x * 0.6 + 0.8 * hs, 1.55, hs * (Math.abs(h.z) + 5.2)); T.set(ball.x, Math.max(0.5, ball.y * 0.8), ball.z);
      fov = 32;
    } else {
      // A rail camera low on the sideline, sliding with the ball.
      P.set(9.4, 1.3, clamp(ball.z * 0.85, -13, 13)); T.set(ball.x * 0.6, 0.35 + ball.y * 0.55, ball.z);
      fov = 25;
    }
    if (this.snap) { this.cp.copy(P); this.cl.copy(T); this.fov = fov; this.snap = false; }
    const k = this.phase === 'hold' ? 5 : 7;
    this.cp.x = damp(this.cp.x, P.x, k, dt); this.cp.y = damp(this.cp.y, P.y, k, dt); this.cp.z = damp(this.cp.z, P.z, k, dt);
    this.cl.x = damp(this.cl.x, T.x, k + 3, dt); this.cl.y = damp(this.cl.y, T.y, k + 3, dt); this.cl.z = damp(this.cl.z, T.z, k + 3, dt);
    this.fov = damp(this.fov, fov, 4, dt);
    camera.position.copy(this.cp); camera.lookAt(this.cl);
    if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    // Depth of field on the subject: the footprint in the line-review freeze, the hitter from behind, otherwise the ball.
    if (S.style === 'hawk' && this.phase === 'hold') Look.dof(camera.position.distanceTo(this.cl), 11);
    else if (S.style === 'behind') { const h = S.hitter.avatar.root.position; Look.dof(Math.max(2, camera.position.distanceTo(_T.set(h.x, 1.2, h.z))), 7); }
    else Look.dof(Math.max(1.5, camera.position.distanceTo(_T.set(ball.x, ball.y, ball.z))), S.style === 'hawk' ? 5 : 6);
  },
  showCall() {
    const S = this.spec, b1 = S.bounces[0], out = S.line.d > 0;
    const F = this.foot, v = Math.hypot(b1.vx, b1.vz) || 1;
    F.position.set(b1.x, 0.009, b1.z);
    F.rotation.set(0, Math.atan2(b1.vx / v, b1.vz / v), 0);
    F.scale.set(0.065, 1, 0.11);
    F.userData.fill.material.color.set(Settings.cbSafe ? (out ? 0xff9f40 : 0x4ea3ff) : out ? 0xff5a44 : 0x5fe08f);   // blue / orange for colour-blind players
    F.visible = true;
    const cm = Math.abs(S.line.d) * 100;
    $('hawkCall').textContent = out ? 'Out' : 'In';
    $('hawkCall').className = out ? 'out' : 'in';
    $('hawkDist').textContent = cm < 1 ? `${Math.max(1, Math.round(cm * 10))} mm ${out ? 'out' : 'inside the line'}` : `${cm.toFixed(1)} cm ${out ? 'out' : 'inside the line'}`;
    $('hawkeye').hidden = false;
  },
  end() { this.wipe(); this.phase = 'out'; this.phaseAt = Clock.perf() + 0.24; },
  skip() { if (this.phase === 'play' || this.phase === 'hold') this.end(); else if (this.phase === 'wait') this.phase = 'idle'; },
  // Drop a replay on the spot (quitting to the menu, or a new match starting): no wipe, and the match it belonged to is gone.
  cancel() {
    if (this.phase !== 'idle') {
      this.phase = 'idle'; this.active = false; this.timeScale = 1;
      if (this.foot) this.foot.visible = false;
      Look.dof(0);
      if (this.buf) this.overlay(false);
      if (this.onBoard) this.onBoard(null, 0);
    }
    this.n = 0;
  },
  finish() {
    this.phase = 'idle'; this.active = false; this.foot.visible = false;
    Look.dof(0);
    this.overlay(false);
    if (this.onBoard) this.onBoard(null, 0);
    if (this.onEnd) this.onEnd();
    return false;
  },
  overlay(on) {
    $('replay').hidden = !on;
    $('hud').classList.toggle('replaying', on);
    if (!on) $('hawkeye').hidden = true;
    else $('replayKind').textContent = this.spec.style === 'hawk' ? 'Line review' : this.spec.style === 'receiver' ? 'Ace' : this.spec.matchPoint ? 'Match point' : this.spec.rally >= LONG_RALLY ? `${this.spec.rally}-shot rally` : 'Winner';
  },
  wipe() {
    const w = $('replayWipe');
    w.classList.remove('go'); void w.offsetWidth; w.classList.add('go');
  },
};
