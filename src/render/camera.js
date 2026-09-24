// Camera director: a broadcast-style montage behind the menu, a behind-the-player view, and a broadcast (TV) angle.
import * as THREE from 'three';
import { Settings } from '../core.js';
import { camera, Look } from './renderer.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MONTAGE = ['high', 'rail', 'tv', 'spider', 'corner', 'high', 'rail'];

export const Cam = {
  mode: 'orbit', pos: new THREE.Vector3(0, 14, 40), look: new THREE.Vector3(), angle: 0.4, fov: 48,
  tp: new THREE.Vector3(), tl: new THREE.Vector3(), shakeAmt: 0, shakeT: 0,
  hold: null,   // { pos:[x,y,z], look:[x,y,z], fov, dof:[focus, blur] } pins the camera (inspection and photo shots)
  shot: 'high', shotAt: -99, shotLen: 7, side: 1, side2: 1, lastState: '', snapNext: true,

  update(dt, me, game) {
    let fov = 48;
    if (this.hold) {
      camera.position.set(...this.hold.pos); camera.lookAt(...this.hold.look);
      if (camera.fov !== (this.hold.fov || 40)) { camera.fov = this.hold.fov || 40; camera.updateProjectionMatrix(); }
      Look.dof(...(this.hold.dof || [0, 0]));
      return;
    }
    let kp = 3.2;
    const montage = this.mode === 'orbit' || !me;
    if (montage !== this.wasMontage) { this.wasMontage = montage; if (montage) this.cut('high', 7); }
    if (montage) {
      fov = this.director(dt, game);
      kp = this.shot === 'high' ? 1.2 : 2.6;
    } else if (Settings.cam === 'tv') {
      this.tp.set(me.x * 0.12, 11.5, me.side * 32.5);
      this.tl.set(me.x * 0.08, 0.2, -me.side * 1.5);
      fov = 36;
    } else {
      this.tp.set(me.x * 0.55, 3.3, me.side * (Math.max(Math.abs(me.z), 11.4) + 5.5));
      this.tl.set(me.x * 0.3, 0.55, -me.side * 5.5);
      fov = 50;
    }
    if (this.snapNext) { this.pos.copy(this.tp); this.look.copy(this.tl); this.fov = fov; this.snapNext = false; }
    this.pos.lerp(this.tp, 1 - Math.exp(-dt * kp));
    this.look.lerp(this.tl, 1 - Math.exp(-dt * (kp + 1)));
    this.fov += (fov - this.fov) * (1 - Math.exp(-dt * 3));
    camera.position.copy(this.pos);
    if (this.shakeAmt > 0.0005) {
      this.shakeT += dt * 38;
      camera.position.x += Math.sin(this.shakeT * 1.3) * this.shakeAmt;
      camera.position.y += Math.sin(this.shakeT * 1.7 + 1) * this.shakeAmt * 0.6;
      this.shakeAmt *= Math.exp(-dt * 9);
    }
    camera.lookAt(this.look);
    if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }
    // A long lens on the server close-up: the player sharp, the crowd behind soft.
    if (montage && this.shot === 'server') Look.dof(camera.position.distanceTo(this.look), 15);
    else Look.dof(0);
  },

  // The menu montage: hard cuts between broadcast angles every few seconds, a close-up of the server as each point
  // starts and a cut back to a wide angle once the serve is struck. Sets the target position and look, returns fov.
  director(dt, game) {
    const now = performance.now() / 1000, G = game, st = G && G.state;
    const b = G && G.ball ? G.ball.p : { x: 0, y: 1, z: 0 };
    const S = G && G.match && G.players ? G.players[G.match.currentServer] : null;
    this.angle += dt * 0.05;
    if (st !== this.lastState) {
      if (st === 'serve' && S && now - this.shotAt > 2 && Math.random() < 0.65) this.cut('server', 6);
      else if (st === 'rally' && this.shot === 'server') this.cut(Math.random() < 0.6 ? 'tv' : 'high', 7);
      this.lastState = st;
    }
    if (now - this.shotAt > this.shotLen && this.shot !== 'server') this.cut(this.nextShot(), 6 + Math.random() * 3);
    if (this.shot === 'server' && (!S || now - this.shotAt > this.shotLen)) this.cut('high', 7);
    const P = this.tp, L = this.tl, s = this.side;
    switch (this.shot) {
      case 'server': {   // telephoto from in front of the server, a little to one side
        P.set(S.x + 1.7 * s, 1.62, S.z - S.side * 5.4); L.set(S.x, 1.32, S.z);
        return 21;
      }
      case 'rail':       // low on the sideline opposite the umpire's chair, sliding with the ball
        P.set(11.2, 2.5, clamp(b.z * 0.75, -12, 12)); L.set(b.x * 0.4, 0.9, b.z * 0.9);
        return 30;
      case 'tv':
        P.set(0, 11.5, 32.5 * s); L.set(0, 0.2, -1.5 * s);
        return 36;
      case 'spider':     // cable camera over the court, drifting with the play
        P.set(b.x * 0.35, 12.5, clamp(b.z * 0.55, -9, 9) + 5 * s); L.set(b.x * 0.6, 0, b.z * 0.75);
        return 46;
      case 'corner':     // low behind a baseline corner, looking up the court
        P.set(7.4 * s, 0.95, 15.8 * this.side2); L.set(0, 1.4, 0);
        return 30;
      default: {         // high establishing orbit, kept inside the ring of palms
        const a = this.angle;
        P.set(Math.sin(a) * 12.5, 16.5 + Math.sin(now * 0.21) * 1.2, Math.cos(a) * 18.5); L.set(0, 0, 0);
        return 44;
      }
    }
  },
  cut(shot, len) {
    this.shot = shot; this.shotAt = performance.now() / 1000; this.shotLen = len; this.snapNext = true;
    this.side = Math.random() < 0.5 ? -1 : 1; this.side2 = Math.random() < 0.5 ? -1 : 1;
  },
  nextShot() {
    let s;
    do s = MONTAGE[(Math.random() * MONTAGE.length) | 0]; while (s === this.shot);
    return s;
  },
  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); },
  snap(me) { this.update(10, me); this.fov = camera.fov; },
};
