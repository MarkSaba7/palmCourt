// Ball kids at work: after each point the nearest one sprints out, crouches to scoop up the ball and jogs back to
// their spot. Purely visual: it reads the game's state and never changes the rules. If the next point starts
// before the ball is collected, a stand-in ball stays where the old one stopped until the kid picks it up.
import * as THREE from 'three';
import { clamp, damp } from '../core.js';
import { scene } from './renderer.js';
import { STILL, lerpPose, clonePose } from './avatar.js';
import { BallView } from './ball.js';

const RUN = 5.2, JOG = 3.2, WAIT = STILL.wait(), CROUCH = STILL.crouch();

// A running pose built on the standing one: legs and arms swing with the stride, body leans into it.
function runPose(base, phase, amount, out) {
  lerpPose(base, base, 0, out);
  const s = Math.sin(phase), c = Math.cos(phase), r = amount;
  out.hipR[0] = 0.25 + s * 0.85 * r; out.hipL[0] = 0.25 - s * 0.85 * r;
  out.knR = -0.3 - Math.max(0, -c) * 1.2 * r; out.knL = -0.3 - Math.max(0, c) * 1.2 * r;
  out.shR[0] = 0.2 - s * 0.7 * r; out.shR[1] = 0; out.shR[2] = 0.12; out.shL[0] = 0.2 + s * 0.7 * r; out.shL[1] = 0; out.shL[2] = -0.12;
  out.elR = 1.2; out.elL = 1.2;
  out.sp[0] = -0.18 * r; out.py = -0.035 * Math.abs(c) * r;
  return out;
}

export const BallKids = {
  kids: [], job: null, stand: null, lastState: '', deadAt: 0, lastBall: new THREE.Vector3(),
  init(kids) {
    this.kids = kids.map((k) => ({ ...k, pos: new THREE.Vector3(k.x, 0, k.z), home: new THREE.Vector3(k.x, 0, k.z), phase: 0, pose: clonePose(k.rest), heading: k.ry }));
    this.stand = BallView.mesh.clone();
    this.stand.visible = false;
    scene.add(this.stand);
  },
  update(dt, game) {
    if (!this.kids.length || !game || dt <= 0) return;
    const st = game.state, ball = game.ball, now = performance.now() / 1000;
    if (st === 'dead' && this.lastState !== 'dead') this.deadAt = now;
    if (st === 'dead' && ball.visible) this.lastBall.set(ball.p.x, Math.max(0.034, ball.p.y), ball.p.z);
    // Point over and the ball is slowing (or has had time to): send the nearest kid.
    if (!this.job && st === 'dead' && game.deadKind === 'point' && ball.visible) {
      const sp = Math.hypot(ball.v.x, ball.v.y, ball.v.z);
      if (now - this.deadAt > 0.7 && (sp < 4 || now - this.deadAt > 1.5)) {
        let best = null, bd = Infinity;
        for (const k of this.kids) { const d = Math.hypot(k.pos.x - ball.p.x, k.pos.z - ball.p.z); if (d < bd) { bd = d; best = k; } }
        if (best && bd < 16) this.job = { kid: best, phase: 'out', t: 0 };
      }
    }
    // The next point has started with the ball still out there: leave a stand-in where it stopped.
    if (this.job && this.job.phase === 'out' && st !== 'dead' && !this.stand.visible) {
      this.stand.position.copy(this.lastBall); this.stand.position.y = 0.034; this.stand.visible = true;
    }
    this.lastState = st;
    for (const k of this.kids) this.move(k, dt, game);
  },
  move(k, dt, game) {
    const job = this.job && this.job.kid === k ? this.job : null;
    let target = null, speed = 0;
    if (job && job.phase === 'out') { target = this.stand.visible ? this.stand.position : this.lastBall; speed = RUN; }
    else if (job && job.phase === 'back') { target = k.home; speed = game.state === 'rally' ? RUN : JOG; }   // hurry if play has restarted
    if (job && job.phase === 'pick') {
      job.t += dt;
      lerpPose(k.pose, CROUCH, 1 - Math.exp(-dt * 14), k.pose);
      if (job.t > 0.22 && !job.got) {   // scoop: the ball disappears into the kid's hand
        job.got = true;
        if (this.stand.visible) this.stand.visible = false;
        else if (game.state === 'dead') game.ball.visible = false;
      }
      if (job.t > 0.45) job.phase = 'back';
    } else if (target) {
      const dx = target.x - k.pos.x, dz = target.z - k.pos.z, d = Math.hypot(dx, dz);
      if (d < (job.phase === 'out' ? 0.45 : 0.08)) {
        if (job.phase === 'out') { job.phase = 'pick'; job.t = 0; }
        else { this.job = null; k.pos.set(k.x, 0, k.z); }
      } else {
        const step = Math.min(d, speed * dt);
        k.pos.x += (dx / d) * step; k.pos.z += (dz / d) * step;
        k.heading = damp(k.heading, k.heading + Math.atan2(Math.sin(Math.atan2(-dx, -dz) - k.heading), Math.cos(Math.atan2(-dx, -dz) - k.heading)), 12, dt);
        k.phase += dt * (speed * 2.3);
        runPose(WAIT, k.phase, clamp(speed / RUN, 0.5, 1), k.pose);
      }
    } else {
      // at home: settle back into the resting pose and facing
      lerpPose(k.pose, k.rest, 1 - Math.exp(-dt * 6), k.pose);
      k.heading = damp(k.heading, k.heading + Math.atan2(Math.sin(k.ry - k.heading), Math.cos(k.ry - k.heading)), 6, dt);
    }
    k.fig.pose = k.pose;
    k.fig.root.position.set(k.pos.x, 0, k.pos.z);
    k.fig.root.rotation.y = k.heading;
  },
};
