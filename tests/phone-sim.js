// TEST ONLY: synthetic phone motion for controller.html, used from the browser console / automation.
// Nothing in the game or the phone page loads this file.
//
// A swing is a turn about the vertical axis (the direction gravity pushes the phone "up" in its own coordinates),
// so it works for any way the phone is held: pass `up` as that direction in phone coordinates.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = 9.81;

export const HOLDS = {
  upright: { x: 0, y: 1, z: 0 },                 // portrait, top of the phone up
  sideways: { x: 1, y: 0, z: 0 },                // landscape, screen facing sideways
  tilted: norm({ x: 0.55, y: 0.7, z: -0.45 }),   // somewhere in between
};

function norm(v) { const m = Math.hypot(v.x, v.y, v.z); return { x: v.x / m, y: v.y / m, z: v.z / m }; }
// Any unit vector at right angles to `up` (for the off-axis part of a real swing).
function across(up) { const a = Math.abs(up.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }; const c = { x: up.y * a.z - up.z * a.y, y: up.z * a.x - up.x * a.z, z: up.x * a.y - up.y * a.x }; return norm(c); }

export function emit(win, up, w = { x: 0, y: 0, z: 0 }, lin = { x: 0, y: 0, z: 0 }) {
  win.dispatchEvent(new win.DeviceMotionEvent('devicemotion', {
    acceleration: lin,
    accelerationIncludingGravity: { x: up.x * G + lin.x, y: up.y * G + lin.y, z: up.z * G + lin.z },
    rotationRate: { alpha: w.z, beta: w.x, gamma: w.y },   // deg/s about the phone's z, x, y axes
    interval: 16,
  }));
}

export async function still(win, up, ms = 200) {
  const end = performance.now() + ms;
  while (performance.now() < end) { emit(win, up); await sleep(16); }
}

// One turn about the vertical: sign +1 or -1, peak speed in deg/s, a sin^2 profile over `ms`.
// `wobble` adds rotation about a horizontal axis (real swings aren't pure turns); `rise` adds vertical hand speed (topspin).
export async function turn(win, up, { sign = 1, peak = 900, ms = 260, wobble = 0.25, rise = 0 } = {}) {
  const side = across(up), t0 = performance.now();
  for (;;) {
    const t = performance.now() - t0;
    if (t > ms) break;
    const k = Math.sin((Math.PI * t) / ms) ** 2, s = sign * peak * k, o = peak * wobble * k;
    const w = { x: up.x * s + side.x * o, y: up.y * s + side.y * o, z: up.z * s + side.z * o };
    const a = rise * Math.cos((Math.PI * t) / ms) * 8;          // up then down: velocity peaks mid-swing
    emit(win, up, w, { x: up.x * a, y: up.y * a, z: up.z * a });
    await sleep(16);
  }
}

// A whole stroke the way people swing: take the racket back, swing through, bring it back to ready.
// By default the wind-up flows straight into the swing, the hardest case to tell apart.
export async function stroke(win, up, sign, { peak = 950, windup = 0.45, pause = 0, recover = 0.5, rise = 0 } = {}) {
  if (windup) { await turn(win, up, { sign: -sign, peak: peak * windup, ms: 320 }); if (pause) await still(win, up, pause); }
  await turn(win, up, { sign, peak, ms: 260, rise });
  if (recover) { await still(win, up, 60); await turn(win, up, { sign: -sign, peak: peak * recover, ms: 380 }); }
  await still(win, up, 120);
}

// Lift the phone briskly without turning it: the lift-to-toss gesture.
export async function lift(win, up, ms = 260) {
  const t0 = performance.now();
  for (;;) {
    const t = performance.now() - t0;
    if (t > ms) break;
    const a = 12 * Math.sin((Math.PI * t) / ms);
    emit(win, up, { x: 0, y: 0, z: 0 }, { x: up.x * a, y: up.y * a, z: up.z * a });
    await sleep(16);
  }
  await still(win, up, 30);
}
