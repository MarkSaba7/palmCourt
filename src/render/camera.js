// Camera director: the player's view behind their baseline, a broadcast (TV) angle, and a cinematic montage behind
// the menu (broadcast and cinematic angles, close-ups between points, depth of field).
import * as THREE from 'three';
import { Settings, COURT } from '../core.js';
import { camera, Look } from './renderer.js';
import { World } from './court.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);
const sign = () => (Math.random() < 0.5 ? -1 : 1);
const DEG = Math.PI / 180;
// Weighted choice from [[item, weight], ...], skipping `not`.
function choose(list, not) {
  const ok = list.filter(([s]) => s !== not), sum = ok.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * sum;
  for (const [s, w] of ok) if ((r -= w) <= 0) return s;
  return ok[0][0];
}
// Live angles for the montage while the ball is in play, and how often each comes up.
const LIVE = [['tv', 4], ['baseline', 2], ['spider', 2], ['rail', 2], ['side', 1.5], ['high', 1]];
const _v = new THREE.Vector3();

// Critically damped spring: follows a moving target with continuous velocity, so a target that jumps (a new
// plan, a player turning round) eases the camera over instead of jerking it. w is the stiffness (1/s).
class Spring {
  constructor() { this.p = new THREE.Vector3(); this.v = new THREE.Vector3(); }
  snap(t) { this.p.copy(t); this.v.set(0, 0, 0); }
  step(t, w, dt, wy = w) {
    for (const k of ['x', 'y', 'z']) {
      const s = k === 'y' ? wy : w, e = Math.exp(-s * dt), d = this.p[k] - t[k], c = (this.v[k] + s * d) * dt;
      this.p[k] = t[k] + (d + c) * e;
      this.v[k] = (this.v[k] - s * c) * e;
    }
    return this.p;
  }
}

export const Cam = {
  mode: 'orbit', pos: new THREE.Vector3(0, 14, 40), look: new THREE.Vector3(), angle: 0.4, fov: 48,
  tp: new THREE.Vector3(), tl: new THREE.Vector3(), shakeAmt: 0, shakeT: 0,
  hold: null,   // { pos:[x,y,z], look:[x,y,z], fov, dof:[focus, blur] } pins the camera (inspection and photo shots)
  shot: 'high', shotAt: -99, shotLen: 7, side: 1, side2: 1, lastState: '', snapNext: true,
  clock: 0, view: '', game: null, ps: new Spring(), ls: new Spring(), out: new THREE.Vector3(1e9, 0, 0),
  meX: 0, meZ: 0, tilt: 0, hitAt: 0, lastRally: -1, afterPoint: 0, markAt: { x: 0, z: 0 }, orbit0: 0,

  update(dt, me, game) {
    if (game) this.game = game;
    if (this.hold) {
      camera.position.set(...this.hold.pos); camera.lookAt(...this.hold.look);
      if (camera.fov !== (this.hold.fov || 40)) { camera.fov = this.hold.fov || 40; camera.updateProjectionMatrix(); }
      Look.dof(...(this.hold.dof || [0, 0]));
      this.snapNext = true;
      return;
    }
    this.clock += dt;
    const montage = this.mode === 'orbit' || !me;
    if (montage !== this.wasMontage) { this.wasMontage = montage; if (montage) this.cut('high', 8); }
    const view = montage ? 'montage' : Settings.cam === 'tv' ? 'tv' : 'player';
    if (view !== this.view) { this.view = view; this.snapNext = true; }
    // Something else moved the camera (an instant replay, a photo still): cut back rather than fly across the court.
    if (camera.position.distanceToSquared(this.out) > 0.04) this.snapNext = true;
    const o = view === 'montage' ? this.director(dt, this.game) : view === 'tv' ? this.tvCam(me, this.game) : this.playerCam(me, this.game);
    if (this.snapNext) { this.ps.snap(this.tp); this.ls.snap(this.tl); this.fov = o.fov; this.snapNext = false; }
    this.pos.copy(this.ps.step(this.tp, o.w, dt, o.wy));
    this.look.copy(this.ls.step(this.tl, o.wl, dt));
    this.fov += (o.fov - this.fov) * (1 - Math.exp(-dt * 2.5));
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    this.out.copy(camera.position);
    // Shake: a small, quickly fading wobble of the view (a big serve), never a jolt of the whole camera.
    if (this.shakeAmt > 0.0005) {
      this.shakeT += dt;
      const t = this.shakeT, a = this.shakeAmt;
      camera.rotateX((Math.sin(t * 47) * 0.6 + Math.sin(t * 73 + 1.3) * 0.4) * a * 0.12);
      camera.rotateY((Math.sin(t * 59 + 0.7) * 0.6 + Math.sin(t * 31 + 2.1) * 0.4) * a * 0.1);
      this.shakeAmt *= Math.exp(-dt * 7);
    }
    if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    if (o.dof) Look.dof(o.dof[0], o.dof[1]); else Look.dof(0);
  },

  // Vertical field of view that still shows `half` degrees either side horizontally on narrow (4:3, 16:10) screens.
  fitFov(v, half, max) { return clamp(2 * Math.atan(Math.tan(half * DEG) / Math.max(0.5, camera.aspect)) / DEG, v, max); },

  // Behind the local player's baseline: high enough to read the ball's depth, the whole court in view with the
  // opponent in the top third. The pitch never changes as the player runs up and back (the camera dollies with
  // them instead), sideways it follows only part of their movement, and leans early toward where they're
  // running, so a wide ball starts the pan before the sprint.
  playerCam(me, G) {
    const s = me.side, H = COURT.halfL, st = G ? G.state : '';
    // Everyone back on their marks for a new point: cut, don't glide.
    if (Math.hypot(me.x - this.meX, me.z - this.meZ) > 1.2) this.snapNext = true;
    this.meX = me.x; this.meZ = me.z;
    const serving = st === 'serve' || st === 'toss';
    const fx = serving ? me.x : lerp(me.x, clamp(me.tx, -7, 7), 0.45);
    const dz = Math.abs(me.z), back = dz >= H ? dz + 6.4 : H + 6.4 - 0.3 * (H - dz);
    const cz = Math.min(back, 21.2), cy = 4.05 + (cz - 18.3) * 0.12;
    this.tp.set(clamp(fx * (serving ? 0.5 : 0.36), -3, 3), cy, s * cz);
    const fov = this.fitFov(42, 34.5, 52);
    // A lob or a high toss rising out of the top of the frame tilts the view up a little (and back down after).
    let lift = 0;
    const b = G && G.ball;
    if (b && b.visible && (st === 'rally' || st === 'toss')) {
      const elev = Math.atan2(b.p.y - cy, Math.max(1, Math.abs(s * cz - b.p.z))) / DEG, top = fov / 2 - 14 - 3;
      lift = clamp((elev - top) * 0.75, 0, 9);
    }
    this.tilt += (lift - this.tilt) * 0.08;
    const pitch = (14 - this.tilt) * DEG, ahead = 16;
    this.tl.set(clamp(fx * 0.2, -2, 2), cy - ahead * Math.tan(pitch), s * (cz - ahead));
    return { fov, w: 2.6, wy: 2.2, wl: 3.2 };
  },

  // Broadcast main camera: high in the stands behind the player's baseline on a long lens, panning gently with
  // the play. Both players and the whole court stay in frame.
  tvCam(me, G) {
    const s = me.side, op = G && G.players ? G.players[1 - me.idx] : me, b = G && G.ball ? G.ball.p : { x: 0 };
    if (Math.hypot(me.x - this.meX, me.z - this.meZ) > 1.2) this.snapNext = true;
    this.meX = me.x; this.meZ = me.z;
    const cx = clamp((me.x + op.x) * 0.12 + b.x * 0.12, -1.6, 1.6);
    this.tp.set(cx * 0.4, 12.5, s * 33);
    this.tl.set(cx, 0, s * 2.1);
    return { fov: this.fitFov(28, 21, 36), w: 1.6, wl: 2.2 };
  },

  // The menu montage. A broadcast-style edit: a close-up of the server as each point starts, a cut to a live
  // angle as the serve is struck (and now and then on a stroke in a long rally), and after the point a close-up
  // of the winner, the ball's mark or the crowd. Every angle moves a little. Sets the targets, returns the lens.
  director(dt, G) {
    const st = G && G.state, now = this.clock, u = now - this.shotAt;
    const b = G && G.ball ? G.ball.p : { x: 0, y: 1, z: 0 };
    const pl = G && G.players && G.players.length === 2 ? G.players : null;
    const S = pl && G.match ? pl[G.match.currentServer] : null, R = S && pl[1 - S.idx];
    this.angle += dt * 0.035;
    if (G && G.ball && G.ball.rally !== this.lastRally) { this.lastRally = G.ball.rally; this.hitAt = now; }
    if (st !== this.lastState) {
      if (st === 'serve' && S) {
        const r = Math.random();
        this.cut(r < 0.6 ? 'server' : r < 0.8 ? 'receiver' : r < 0.9 ? 'tv' : 'high', 10);
      } else if (st === 'rally' && (this.shot === 'server' || this.shot === 'receiver')) this.cut(choose(LIVE), rnd(6, 10));
      else if (st === 'dead') this.afterPoint = now + 0.55;
      this.lastState = st;
    }
    // A beat after the point ends: the ball's mark, the winner, or the crowd.
    if (this.afterPoint && now >= this.afterPoint) {
      this.afterPoint = 0;
      const m = G && G.bounceLog && G.bounceLog[0], clay = World.surface === 'clay';
      const near = m && Math.min(Math.abs(Math.abs(m.x) - COURT.halfSW), Math.abs(Math.abs(m.z) - COURT.halfL)) < 0.4;
      const win = pl && pl.find((p) => p.avatar.mode === 'react' && p.avatar.reactKind === 'win');
      const r = Math.random();
      if (m && (near || clay) && r < 0.45) { this.markAt.x = m.x; this.markAt.z = m.z; this.cut('mark', 5); }
      else if (win && G.deadKind === 'point' && r < 0.8) { this.winner = win; this.cut('reaction', 5); }
      else if (G.deadKind === 'point' && r < 0.9) this.cut('crowd', 5);
    }
    if (this.shot === 'server' && (!S || st === 'rally')) this.cut(choose(LIVE), rnd(6, 10));
    if (u > this.shotLen) {
      // Live angles change on a stroke (never mid-flight); the others hand back to a live angle when they're done.
      if (st === 'rally') { if (now - this.hitAt < 0.12) this.cut(choose(LIVE, this.shot), rnd(6, 10)); }
      else this.cut(choose([['high', 2], ['tv', 2], ['spider', 1]], this.shot), rnd(6, 9));
    }
    const P = this.tp, L = this.tl, s = this.side, e = this.side2, len = this.shotLen;
    switch (this.shot) {
      case 'server': {   // long lens from in front of the server, pushing in slowly and tilting up with the toss
        if (!S) break;
        const d = 5.8 - 0.9 * sstep(0, 6, u);
        P.set(S.x + 1.7 * s, 1.6, S.z - S.side * d);
        L.set(S.x, st === 'toss' ? Math.max(1.3, lerp(1.3, b.y, 0.7)) : 1.3, S.z);
        return { fov: 20, w: 3, wl: 4.5, dof: [P.distanceTo(L), 15] };
      }
      case 'receiver': { // very long lens over the server's shoulder, on the receiver waiting for the serve
        if (!S) break;
        P.set(S.x * 0.5 + 1.3 * s, 2.3, S.side * (Math.abs(S.z) + 3.5));
        L.set(R.x, 1.05, R.z);
        return { fov: 10, w: 3, wl: 4, dof: [P.distanceTo(L), 11] };
      }
      case 'reaction': { // the point's winner, from in front
        const W = this.winner;
        if (!W) break;
        P.set(W.x + 1.4 * s, 1.5, W.z - W.side * (6.8 - 0.8 * sstep(0, 5, u)));
        L.set(W.x, 1.25, W.z);
        return { fov: 16, w: 3, wl: 4, dof: [P.distanceTo(L), 12] };
      }
      case 'mark': {     // Hawk-Eye style close-up of the ball's mark, low and circling it
        const m = this.markAt, a = this.orbit0 + u * 0.12, r = 1.55 - 0.25 * sstep(0, len, u);
        P.set(m.x + Math.cos(a) * r, 0.34 + 0.08 * sstep(0, len, u), m.z + Math.sin(a) * r);
        L.set(m.x, 0.02, m.z);
        return { fov: 26, w: 2.5, wl: 3, dof: [P.distanceTo(L), 14] };
      }
      case 'crowd': {    // courtside, looking up into the stands as they applaud, drifting along them
        P.set(s * 9.6, 1.1, e * 2.5);
        L.set(s * 32, 8.5, e * (-9 + u * 1.4));
        return { fov: 30, w: 2, wl: 2, dof: [24, 6] };
      }
      case 'rail': {     // low on the sideline opposite the umpire's chair, sliding with the ball
        P.set(10.4, 1.35, clamp(b.z * 0.8, -12, 12));
        L.set(b.x * 0.5, 0.5 + b.y * 0.4, b.z * 0.95);
        return { fov: 30, w: 2.2, wl: 3.5, dof: [Math.max(3, P.distanceTo(_v.set(b.x, b.y, b.z))), 5] };
      }
      case 'side': {     // above the side of the court, panning from end to end with the ball
        P.set(11.6, 2.9, Math.sin(u * 0.2) * 1.2);
        L.set(b.x * 0.4, 0.6 + b.y * 0.3, b.z);
        return { fov: 36, w: 1.5, wl: 2.8, dof: [Math.max(3, P.distanceTo(_v.set(b.x, b.y, b.z))), 4] };
      }
      case 'spider': {   // cable camera over the court, drifting with the play
        P.set(b.x * 0.35 + s * 1.5, 11 + Math.sin(u * 0.3) * 0.6, clamp(b.z * 0.5, -8, 8) + 6 * e);
        L.set(b.x * 0.6, 0, b.z * 0.8);
        return { fov: 44, w: 1.4, wl: 2.4, dof: [P.distanceTo(L), 2.5] };
      }
      case 'baseline': { // at ground level behind a baseline, on the far player; the near one passes by soft
        const F = pl ? (pl[0].side === -e ? pl[0] : pl[1]) : { x: 0, z: -12 * e };
        P.set(s * 1.3 + Math.sin(u * 0.25) * 0.7, 0.55, e * 20.4);
        L.set(F.x * 0.75 + b.x * 0.25, 0.95, F.z * 0.85 + b.z * 0.15);
        return { fov: 21, w: 1.5, wl: 2.6, dof: [Math.max(5, P.distanceTo(_v.set(F.x, 1, F.z))), 9] };
      }
      case 'tv': {
        const cx = pl ? clamp((pl[0].x + pl[1].x) * 0.12 + b.x * 0.12, -1.6, 1.6) : 0;
        P.set(cx * 0.4, 12.5, 33 * e);
        L.set(cx, 0, 2.1 * e);
        return { fov: 28, w: 1.6, wl: 2.2 };
      }
      default: break;
    }
    // 'high': an establishing orbit, inside the ring of palms, craning down slowly.
    const a = this.angle;
    P.set(Math.sin(a) * 14, 18.5 - 3 * sstep(0, len, u) + Math.sin(now * 0.21) * 0.6, Math.cos(a) * 20);
    L.set(0, 0, 0);
    return { fov: 44, w: 1.2, wl: 1.6 };
  },
  cut(shot, len) {
    this.shot = shot; this.shotAt = this.clock; this.shotLen = len; this.snapNext = true;
    this.side = Math.random() < 0.5 ? -1 : 1; this.side2 = sign(); this.orbit0 = Math.random() * Math.PI * 2;
  },
  nextShot() { return choose(LIVE, this.shot); },
  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); this.shakeT = 0; },
  snap(me) { this.snapNext = true; this.update(1 / 60, me, this.game); this.fov = camera.fov; },
};
