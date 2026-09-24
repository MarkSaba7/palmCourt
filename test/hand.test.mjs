// Hand-tracking tests without a browser or a webcam:
//   node test/hand.test.mjs
// 1. The pure helpers in src/camswing.js: which hand is the racket hand (pickHand, HandPicker), palm size and its
//    steadied scale (palmSize, PalmScale), the tracked point and the hand's box.
// 2. The tracker's Web Worker (handWorkerMain in src/input.js), run against a fake MediaPipe: start-up with a GPU that
//    hangs or fails, per-step time limits, the direct camera feed (newest frame only), page-sent frames and errors.
import fs from 'node:fs';
import { pickHand, palmSize, PALM_REF, palmCentre, handBox, labelVote, racketLabel, PalmScale, HandPicker } from '../src/camswing.js';

let failures = 0, checks = 0;
const check = (ok, msg) => { checks++; if (!ok) { failures++; console.log('  FAIL ' + msg); } return ok; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a synthetic hand: 21 landmarks, palm length L (frame widths), wrist at (x, y) raw image fractions ----
function hand(x, y, L = 0.042, o = {}) {
  const asp = o.aspect || 4 / 3, tilt = o.tilt ?? 1, lm = Array.from({ length: 21 }, () => ({ x, y }));
  const at = (dx, dy) => ({ x: x + dx * L * tilt, y: y - dy * L * asp });   // dy up, in frame widths
  lm[0] = at(0, 0);
  const mcp = { 5: [-0.4, 0.95], 9: [-0.13, 1], 13: [0.13, 0.96], 17: [0.37, 0.85] };
  for (const [k, [dx, dy]] of Object.entries(mcp)) {
    lm[k] = at(dx, dy);
    for (let j = 1; j <= 3; j++) lm[+k + j] = at(dx * 1.1, dy + 0.3 * j);
  }
  for (let j = 1; j <= 4; j++) lm[j] = at(-0.4 - 0.2 * j, 0.2 + 0.15 * j);
  return lm;
}

console.log('Hand picking');
{
  const R = 'Left', Lb = 'Right';   // what MediaPipe calls a right-hander's racket hand and off hand (unmirrored frames)
  check(racketLabel('R') === 'Left' && racketLabel('L') === 'Right', 'racketLabel');
  check(labelVote({ label: R, score: 1 }, 'R') === 1 && labelVote({ label: Lb, score: 1 }, 'R') === -1 && labelVote({ label: R, score: 0.5 }, 'R') === 0, 'labelVote with scores');
  check(labelVote({ label: '' }, 'R') === 0 && near(labelVote({ label: R }, 'R'), 0.8) && near(labelVote({ label: R, score: 0.9 }, 'L'), -0.8), 'labelVote without a score / left-handed');
  // The original behaviour (also checked in camswing.test.mjs).
  check(pickHand([{ x: 0.3, y: 0.5, label: Lb }, { x: 0.7, y: 0.5, label: R }], 'R', null) === 1, 'pickHand: racket-hand label');
  check(pickHand([{ x: 0.3, y: 0.5, label: R }, { x: 0.7, y: 0.5, label: R }], 'R', { x: 0.32, y: 0.5, age: 0.03 }) === 0, 'pickHand: continuity');
  check(pickHand([{ x: 0.25, y: 0.55, label: Lb }], 'R', { x: 0.7, y: 0.5, age: 0.05 }) === -1, 'pickHand: skip lone off hand far away');
  check(pickHand([{ x: 0.66, y: 0.5, label: Lb }], 'R', { x: 0.7, y: 0.5, age: 0.05 }) === 0, 'pickHand: keep a mislabelled hand at the right spot');
  check(pickHand([], 'R', null) === -1, 'pickHand: no hands');
  // Both labelled as the racket hand, no prediction: the more confident label wins.
  check(pickHand([{ x: 0.3, y: 0.5, label: R, score: 0.6 }, { x: 0.7, y: 0.5, label: R, score: 0.97 }], 'R', null) === 1, 'pickHand: more confident label');
  // Neither labelled as the racket hand: the one on the racket side of the (mirrored) picture.
  check(pickHand([{ x: 0.3, y: 0.5, label: Lb }, { x: 0.7, y: 0.5, label: Lb }], 'R', null) === 1 && pickHand([{ x: 0.3, y: 0.5, label: R }, { x: 0.7, y: 0.5, label: R }], 'L', null) === 0, 'pickHand: racket side');
  check(pickHand([{ x: 0.3, y: 0.5, label: Lb }], 'R', { x: 0.7, y: 0.5, age: 0.5 }) === 0, 'pickHand: a stale prediction does not skip the only hand');
}

console.log('HandPicker');
{
  const R = 'Left', Lb = 'Right';
  // Following the off hand (the player raised it first), then the racket hand comes into view: switch once the labels
  // have said so for a few frames, but never mid-swing.
  const p = new HandPicker();
  let pred = null, got = [];
  for (let k = 0; k < 3; k++) { const r = p.pick([{ x: 0.3, y: 0.5, label: Lb, score: 0.95 }], 'R', pred); got.push(r.i); pred = { x: 0.3, y: 0.5, age: 0.03 }; }
  check(got.every((i) => i === 0), 'HandPicker: a lone hand is followed whatever its label');
  let switchedAt = -1;
  for (let k = 0; k < 40; k++) {
    const r = p.pick([{ x: 0.3, y: 0.5, label: Lb, score: 0.95 }, { x: 0.72, y: 0.52, label: R, score: 0.95 }], 'R', pred, false);
    if (r.switched) { switchedAt = k; pred = { x: 0.72, y: 0.52, age: 0.03 }; check(r.i === 1, 'HandPicker: switched to the racket hand'); break; }
  }
  check(switchedAt >= 0 && switchedAt < 15, `HandPicker: switches to the racket hand within 15 frames (${switchedAt})`);
  // After the switch it stays on the racket hand.
  const r2 = p.pick([{ x: 0.3, y: 0.5, label: Lb, score: 0.95 }, { x: 0.73, y: 0.52, label: R, score: 0.95 }], 'R', pred, false);
  check(r2.i === 1 && !r2.switched, 'HandPicker: stays on the racket hand');
  // A racket hand whose label flips for a few frames (blur, a fist seen from the side) keeps being followed.
  const q = new HandPicker();
  pred = null;
  let flips = 0;
  for (let k = 0; k < 60; k++) {
    const lab = k % 10 < 3 ? Lb : R;
    const r = q.pick([{ x: 0.3, y: 0.5, label: Lb, score: 0.9 }, { x: 0.7 + 0.001 * k, y: 0.5, label: lab, score: 0.8 }], 'R', pred, false);
    if (r.i !== 1) flips++;
    pred = { x: 0.7 + 0.001 * k, y: 0.5, age: 0.03 };
  }
  check(flips === 0, `HandPicker: label flips don't lose the racket hand (${flips} frames on the wrong hand)`);
  // Mid-swing it never switches, however sure the labels are.
  const s = new HandPicker();
  pred = null;
  let sw = 0;
  for (let k = 0; k < 40; k++) {
    const r = s.pick([{ x: 0.3 + 0.01 * k, y: 0.5, label: Lb, score: 0.99 }, { x: 0.8, y: 0.3, label: R, score: 0.99 }], 'R', pred || { x: 0.3, y: 0.5, age: 0.03 }, true);
    if (r.switched) sw++;
    pred = { x: 0.3 + 0.01 * k, y: 0.5, age: 0.03 };
  }
  check(sw === 0, 'HandPicker: no switch mid-swing');
}

console.log('Palm size and scale');
{
  const lm = hand(0.5, 0.6);
  check(Math.abs(palmSize(lm) / PALM_REF - 1) < 0.08, `palmSize of a palm ${PALM_REF} frame widths long: ${palmSize(lm).toFixed(4)}`);
  check(Math.abs(palmSize(hand(0.5, 0.6, 0.042, { tilt: 0.3 })) / PALM_REF - 1) < 0.08, 'palmSize: a hand turned sideways still reads its length');
  check(Math.abs(palmSize(hand(0.5, 0.6, 0.084)) / palmSize(lm) - 2) < 0.01, 'palmSize scales with distance');
  const c = palmCentre(lm);
  check(c.x > 0.5 - 0.05 && c.x < 0.5 + 0.05 && c.y < 0.6 && c.y > 0.5, `palmCentre mirrored, above the wrist (${c.x.toFixed(3)}, ${c.y.toFixed(3)})`);
  const b = handBox(lm, 0), bg = handBox(lm, 0.5);
  check(b.x0 <= Math.min(...lm.map((p) => p.x)) && b.x1 >= Math.max(...lm.map((p) => p.x)) && bg.x0 < b.x0 && bg.y1 > b.y1, 'handBox covers the hand, grows');
  check(handBox(hand(0.01, 0.99)).x0 === 0 && handBox(hand(0.01, 0.99)).y1 === 1, 'handBox stays inside the frame');

  // PalmScale: a player at the reference distance whose hand tilts (reads 40-100% of its size) and blurs in swings.
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ps = new PalmScale();
  let worst = 0;
  for (let k = 0; k < 300; k++) {
    const t = k / 30, swing = k % 45 < 8;
    const size = swing ? PALM_REF * (0.6 + rnd() * 0.9) : PALM_REF * (0.4 + 0.6 * Math.max(rnd(), rnd()));
    ps.push(t, size, swing ? 4 : 0.3);
    if (k > 60) worst = Math.max(worst, Math.abs(ps.scale - 1));
  }
  check(worst < 0.12, `PalmScale steady through tilts and blurred swings (worst scale error ${(worst * 100).toFixed(1)}%)`);
  // The player steps back to twice the distance: the scale follows within about 2.5 s (the old filter took ~10 s).
  let tSettle = null;
  for (let k = 300; k < 600; k++) {
    const t = k / 30;
    ps.push(t, (PALM_REF / 1.45) * (0.5 + 0.5 * Math.max(rnd(), rnd())), 0.3);
    if (tSettle === null && Math.abs(ps.scale - 1.45) < 0.08) tSettle = t - 10;
  }
  check(tSettle !== null && tSettle < 2.5, `PalmScale follows the player stepping back (${tSettle && tSettle.toFixed(2)} s)`);
  // And back in close.
  tSettle = null;
  for (let k = 600; k < 900; k++) { const t = k / 30; ps.push(t, PALM_REF * 1.2 * (0.6 + 0.4 * rnd()), 0.3); if (tSettle === null && Math.abs(ps.scale - 0.85) < 0.05) tSettle = t - 20; }
  check(tSettle !== null && tSettle < 2.5, `PalmScale follows the player stepping closer (${tSettle && tSettle.toFixed(2)} s)`);
  const fresh = new PalmScale();
  check(fresh.scale === 1 && near(fresh.push(0, PALM_REF / 1.2, 0), PALM_REF / 1.2) && near(fresh.scale, 1.2, 1e-9), 'PalmScale: first sight is used at once');
  check(fresh.push(0.1, 0, 0) === PALM_REF / 1.2 && fresh.push(0.2, NaN, 0) === PALM_REF / 1.2, 'PalmScale ignores junk sizes');
  const fast = new PalmScale();
  fast.push(0, PALM_REF, 0);
  for (let k = 1; k < 30; k++) fast.push(k / 30, PALM_REF * 0.5, 5);
  check(near(fast.size, PALM_REF), 'PalmScale ignores sizes seen mid-swing');
}

// ---- the worker, against a fake MediaPipe ----
// Pull handWorkerMain's source out of src/input.js (the module itself needs a browser) and run it with a fake `self`.
function workerSource() {
  const src = fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8');
  const a = src.indexOf('function handWorkerMain()');
  let depth = 0, i = src.indexOf('{', a);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(a, i + 1);
}
const WORKER = workerSource();

// A fake MediaPipe. o.gpu / o.cpu: 'ok' | 'hang' | 'fail' | 'late' (resolves after 200 ms); o.detect(img, ts) → result.
function fakeVision(o) {
  const made = [];
  class HandLandmarker {
    constructor(opts) { this.opts = opts; this.closed = false; this.calls = []; made.push(this); }
    static createFromOptions(fs, opts) {
      const how = opts.baseOptions.delegate === 'GPU' ? o.gpu : o.cpu;
      if (!fs.wasmBinaryPath.startsWith('blob:')) return Promise.reject(new Error('wasm not preloaded'));
      if (!(opts.baseOptions.modelAssetBuffer instanceof Uint8Array)) return Promise.reject(new Error('model not preloaded'));
      if (how === 'hang') return new Promise(() => {});
      if (how === 'fail') return Promise.reject(new Error(opts.baseOptions.delegate + ' broken'));
      if (how === 'late') return new Promise((r) => setTimeout(() => r(new HandLandmarker(opts)), 200));
      return Promise.resolve(new HandLandmarker(opts));
    }
    detectForVideo(img, ts) { this.calls.push({ img, ts }); return o.detect ? o.detect(img, ts) : { landmarks: [], handedness: [] }; }
    setOptions(x) { this.opts = { ...this.opts, ...x }; return Promise.resolve(); }
    close() { this.closed = true; }
  }
  return { made, V: { FilesetResolver: { forVisionTasks: async (base) => ({ wasmLoaderPath: base + '/l.js', wasmBinaryPath: base + '/w.wasm' }) }, HandLandmarker } };
}
// Run the worker in this process. Returns { send, out (messages posted), made (landmarkers) }.
function runWorker(o = {}) {
  const out = [], fv = fakeVision(o);
  const self = { postMessage: (m) => out.push(m), onmessage: null };
  const env = {
    self, importScripts: () => { self.Vision = fv.V; },
    fetch: async (url) => o.fetch ? o.fetch(url) : { ok: true, headers: { get: () => '1000' }, body: { getReader: () => { let n = 0; return { read: async () => (n++ < 4 ? { done: false, value: new Uint8Array(250) } : { done: true }) }; } } },
    createImageBitmap: async () => ({ close() {} }), ImageData: class { constructor(w, h) { this.width = w; this.height = h; } },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} }, Blob: class {}, performance: { now: () => performance.now(), timeOrigin: performance.timeOrigin + 5 },
  };
  new Function(...Object.keys(env), `(${WORKER})();`)(...Object.values(env));
  return { send: (m) => self.onmessage({ data: m }), out, made: fv.made };
}
const INIT = { type: 'init', base: 'https://cdn/x', model: 'https://m/model.task', origin: performance.timeOrigin, opts: { runningMode: 'VIDEO', numHands: 2 }, delegates: ['GPU', 'CPU'], wait: { GPU: 150, CPU: 300 } };
const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(5); } return true; };

console.log('Tracker worker (fake MediaPipe)');
{
  // Healthy GPU: ready on the GPU, with download progress on the way, warm-up frame run.
  let w = runWorker({ gpu: 'ok', cpu: 'ok' });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  const ready = w.out.find((m) => m.type === 'ready');
  check(ready && ready.delegate === 'GPU', 'worker: starts on the GPU');
  check(w.out.filter((m) => m.type === 'progress' && m.stage === 'download').length >= 2 && w.out.some((m) => m.type === 'progress' && m.stage === 'start' && m.delegate === 'GPU'), 'worker: reports download and start-up progress');
  check(w.made[0].calls.length === 1 && w.made[0].opts.numHands === 2 && w.made[0].opts.runningMode === 'VIDEO', 'worker: warm-up frame, options passed through');

  // GPU start-up that never finishes: gives up after its time limit and runs on the CPU; the late GPU one is closed.
  w = runWorker({ gpu: 'hang', cpu: 'ok' });
  const t0 = Date.now();
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready' || m.type === 'error'));
  const r1 = w.out.find((m) => m.type === 'ready');
  check(r1 && r1.delegate === 'CPU' && /GPU.*took too long/.test(r1.errors.join()), `worker: hung GPU → CPU after the time limit (${Date.now() - t0} ms)`);
  w = runWorker({ gpu: 'late', cpu: 'ok' });
  w.send({ ...INIT, wait: { GPU: 50, CPU: 300 } });
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  await sleep(300);
  check(w.out.find((m) => m.type === 'ready').delegate === 'CPU' && w.made.length === 2 && w.made.find((l) => l.opts.baseOptions.delegate === 'GPU').closed, 'worker: a GPU tracker that finishes too late is closed');
  // GPU fails outright: CPU.
  w = runWorker({ gpu: 'fail', cpu: 'ok' });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  check(w.out.find((m) => m.type === 'ready').delegate === 'CPU', 'worker: failing GPU → CPU');
  // Nothing works: a clear error, never silence.
  w = runWorker({ gpu: 'hang', cpu: 'hang' });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'error'), 3000);
  const err = w.out.find((m) => m.type === 'error');
  check(err && /GPU/.test(err.message) && /CPU/.test(err.message), `worker: both hang → error "${err && err.message}"`);
  // A download that fails: error.
  w = runWorker({ gpu: 'ok', cpu: 'ok', fetch: async () => ({ ok: false, status: 404 }) });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'error'));
  check(/404/.test((w.out.find((m) => m.type === 'error') || {}).message), 'worker: download error reported');
}
{
  // Page-sent frames: each answered once, with increasing timestamps even if frame times repeat, bitmaps closed.
  const lm21 = hand(0.3, 0.6);
  const w = runWorker({ gpu: 'ok', detect: () => ({ landmarks: [lm21], handedness: [[{ categoryName: 'Left', score: 0.93 }]] }) });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  let closed = 0;
  for (const t of [1000, 1033, 1033, 1066]) w.send({ type: 'frame', t, bitmap: { close: () => closed++ } });
  const res = w.out.filter((m) => m.type === 'result');
  const ts = w.made[0].calls.slice(1).map((c) => c.ts);
  check(res.length === 4 && res.every((m) => m.src === 'frame' && m.landmarks.length === 1 && m.handedness[0].label === 'Left' && near(m.handedness[0].score, 0.93)), 'worker: page frames answered with landmarks, label and score');
  check(ts.every((v, i) => i === 0 || v > ts[i - 1]) && closed === 4, 'worker: strictly increasing timestamps, bitmaps closed');
  check(res[1].t === 1033 && res[2].t === 1033, 'worker: results keep the frame time they were sent with');
}
{
  // The direct camera feed: frames are read one at a time, each tracked and closed; the result carries the frame's
  // own timestamp and when it was read on the page's clock. Paused: frames are closed untracked.
  const w = runWorker({ gpu: 'ok' });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  const frames = [];
  let push = null, ended = false, cancelled = false;
  const queue = [];
  const readable = { getReader: () => ({ read: () => new Promise((r) => { if (queue.length) r(queue.shift()); else if (ended) r({ done: true }); else push = r; }), cancel: async () => { cancelled = true; } }) };
  const feed = (f) => { if (push) { const p = push; push = null; p({ value: f, done: false }); } else queue.push({ value: f, done: false }); };
  const frame = (ts) => { const f = { timestamp: ts * 1000, closed: false, close() { this.closed = true; } }; frames.push(f); return f; };
  w.send({ type: 'stream', readable });
  for (const ts of [5000, 5033, 5066]) { feed(frame(ts)); await sleep(5); }
  let res = w.out.filter((m) => m.type === 'result' && m.src === 'stream');
  check(res.length === 3 && res.every((m, i) => m.ts === [5000, 5033, 5066][i] * 1000 && Number.isFinite(m.at) && m.seen === i + 1), 'worker: direct feed tracks each frame, reports its timestamp');
  check(Math.abs(res[0].at - performance.now()) < 200 && frames.every((f) => f.closed), 'worker: feed times on the page clock, frames closed');
  w.send({ type: 'pause', on: true });
  feed(frame(5100)); await sleep(5);
  check(w.out.filter((m) => m.type === 'result' && m.src === 'stream').length === 3 && frames[3].closed, 'worker: paused feed drops frames');
  w.send({ type: 'pause', on: false });
  // A new feed replaces the old one: the old reader stops at its next frame.
  w.send({ type: 'endStream' });
  feed(frame(5200)); await sleep(5);
  check(cancelled && frames[4].closed && w.out.filter((m) => m.type === 'result' && m.src === 'stream').length === 3, 'worker: ended feed stops reading and releases the camera');
  ended = true;
}
{
  // The tracker can't read the camera's frames directly (it throws on every one): the worker says so, so the page can
  // send frames itself instead.
  const w = runWorker({ gpu: 'ok', detect: (img) => { if (img.timestamp !== undefined) throw new Error('unsupported image'); return { landmarks: [], handedness: [] }; } });
  w.send(INIT);
  await waitFor(() => w.out.some((m) => m.type === 'ready'));
  let n = 0;
  const readable = { getReader: () => ({ read: async () => { await sleep(1); return { value: { timestamp: 1000 * n++, close() {} }, done: false }; }, cancel: async () => {} }) };
  w.send({ type: 'stream', readable });
  await waitFor(() => w.out.some((m) => m.type === 'feedError'));
  check(w.out.some((m) => m.type === 'feedError') && w.out.filter((m) => m.type === 'result' && m.error).length === 9, 'worker: feed that keeps failing reports feedError after 9 tries');
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nAll ${checks} checks passed`);
process.exit(failures ? 1 : 0);
