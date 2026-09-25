// The scripted clips of the webcam rig. Each clip loops cleanly (starts and ends at rest, sway in whole cycles).
// id is written into every frame's barcode. Used by gen-video.mjs (paddle videos) and webcam-hand.mjs (landmarks).
import { Script, REST, FPS } from './scene.mjs';

const at = (x, y) => ({ x, y });
// Rest → the centre circle (slowly) → hold → back to rest, so the clip loops and joins its neighbours without a jump.
const lockScript = () => new Script(3.5, REST, { sway: 0.5 }).to('shift', 0, 0.6, at(0.5, 0.5)).to('shift', 2.9, 3.5, REST);
export const LOCK_WINDOW = [0.8, 2.6];   // seconds into a lock clip when the paddle is centred and still
export const CLIPS = [
  { id: 1, name: 'lock', dur: 3.5, color: 'red', note: 'paddle brought to the centre circle and held still (0.6–2.9 s) for locking its color', build: () => lockScript() },
  { id: 2, name: 'idle', dur: 6, color: 'red', distractor: true, note: 'ready position: sway, a slow shift and back, a small fidget (no swings)',
    build: () => new Script(6).to('shift', 1.4, 2.6, at(0.5, 0.55)).to('shift', 3.4, 4.6, REST).to('fidget', 5.0, 5.15, at(0.62, 0.57)).to('fidget', 5.15, 5.35, REST) },
  { id: 3, name: 'fh', dur: 6, color: 'red', note: 'three forehands with a relaxed take-back',
    build: () => new Script(6).stroke('fh', 1.0, { amp: 0.42 }).stroke('fh', 2.9, { amp: 0.48, dur: 0.3 }).stroke('fh', 4.8, { amp: 0.4, dur: 0.24 }) },
  { id: 4, name: 'bh', dur: 6, color: 'red', note: 'three backhands with a relaxed take-back',
    build: () => new Script(6).stroke('bh', 1.0, { amp: 0.42 }).stroke('bh', 2.9, { amp: 0.48, dur: 0.3 }).stroke('bh', 4.8, { amp: 0.4, dur: 0.24 }) },
  { id: 5, name: 'windup', dur: 6.6, color: 'red', note: 'fh / bh / fh / bh, each after a brisk wind-up (a fast take-back the other way) and a quick recovery',
    build: () => { const s = new Script(6.6); for (const [k, T] of [['fh', 1.0], ['bh', 2.5], ['fh', 4.0], ['bh', 5.5]]) s.stroke(k, T, { back: 0.2, pause: 0, rec: 0.3 }); return s; } },
  { id: 6, name: 'toss', dur: 6, color: 'red', note: 'twice: raise the paddle above the toss line, hold, serve swing down and across, recover',
    build: () => new Script(6).serve(0.6, 1.9).serve(3.4, 4.7) },
  { id: 7, name: 'fast', dur: 6, color: 'red', distractor: true, exposure: 0.6, turn: 0.4, note: 'four fast strokes (about 5.5 frame widths/s) with long motion blur and the paddle turning towards edge-on; a red book on the shelf',
    build: () => { const s = new Script(6, REST, { turn: 0.4 }); for (const [k, T] of [['fh', 0.9], ['bh', 2.3], ['fh', 3.7], ['bh', 5.1]]) s.stroke(k, T, { amp: 0.5, dur: 0.17, lift: 0.1, back: 0.3, pause: 0.03, rec: 0.5 }); return s; } },
  { id: 8, name: 'blue-lock', dur: 3.5, color: 'blue', note: 'blue paddle brought to the centre circle and held still', build: () => lockScript() },
  { id: 9, name: 'blue', dur: 6, color: 'blue', note: 'blue paddle: forehand, backhand, forehand',
    build: () => new Script(6).stroke('fh', 1.0, { amp: 0.44 }).stroke('bh', 2.9, { amp: 0.46 }).stroke('fh', 4.8, { amp: 0.42, dur: 0.24 }) },
];
export const clipByName = (n) => CLIPS.find((c) => c.name === n);

// Clips back to back (the layout of gen-video.mjs's suite.json): { fps, total, segments: [{ name, id, start, frames, truth }] }
export function buildSuite(names = CLIPS.map((c) => c.name)) {
  let start = 0;
  const segments = names.map((n) => { const c = clipByName(n), truth = truthOf(c), s = { name: n, id: c.id, start, frames: truth.frames, truth }; start += truth.frames; return s; });
  return { fps: FPS, total: start, segments };
}

// Ground truth for a clip: per-frame paddle position (content time k / FPS), every move, the toss spells.
export function truthOf(clip) {
  const s = clip.build(), n = Math.round(clip.dur * FPS), { moves, tosses } = s.truth();
  const frames = [];
  for (let k = 0; k < n; k++) { const t = k / FPS, p = s.pos(t); frames.push([+p.x.toFixed(5), +p.y.toFixed(5), +s.faceAt(t).toFixed(3)]); }
  return {
    name: clip.name, id: clip.id, note: clip.note, dur: clip.dur, fps: FPS, frames: n, color: clip.color, distractor: !!clip.distractor,
    exposure: clip.exposure ?? 0.5, turn: clip.turn ?? 0.35, handed: 'R',
    moves: moves.map((m) => ({ ...m, peakFrame: +(m.tPeak * FPS).toFixed(2), peak: +m.peak.toFixed(3) })), tosses,
    paddle: frames,
  };
}
