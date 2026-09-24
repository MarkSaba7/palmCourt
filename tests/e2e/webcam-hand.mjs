// End-to-end test of the HAND webcam controls. A synthetic video can't show a real hand, so this runs in two parts:
//  (a) model: MediaPipe on the fake camera — startup time, per-frame cost, frame rate, lag (and that it finds no hand
//      in a room with a person holding a paddle); --main forces the main-thread fallback instead of the worker.
//  (b) after the model: synthetic 21-point hands (the scripted clips of clips.mjs, the other hand in view, blur
//      dropouts, jitter, the odd wrong handedness label) fed into Tracker.handleHands at camera timing, with the same
//      metrics as the paddle test, then a practice match played by a coach, counting hits.
//   node tests/e2e/webcam-hand.mjs [--video tests/e2e/out] [--root <repo>] [--port 8806] [--harness <pc.mjs>] [--cdn dir]
//        [--model hand_landmarker.task] [--secs 10] [--main] [--no-model] [--no-inject] [--no-practice] [--points 2]
//        [--clips idle,fh,bh,windup,toss,fast] [--proc 28 --procsd 6 --arrive 30] [--no-offhand] [--flip 0.02] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, launch, freeze, analyse, report, practiceReport, HERE, REPO, q, f1, msr } from './lib.mjs';
import { CLIPS, truthOf } from './clips.mjs';
import { FPS } from './scene.mjs';

const A = parseArgs({ root: REPO, port: 8806, video: path.join(HERE, 'out'), harness: process.env.PC_HARNESS || '', cdn: '', model: '', secs: 10, main: false, modelTest: true, inject: true, practice: true, points: 2, clips: 'idle,fh,bh,windup,toss,fast', proc: 28, procsd: 6, arrive: 30, offhand: true, flip: 0.02, sens: 1, render: false, json: '', aux: false, limit: 150 });
if (process.argv.includes('--no-model')) A.modelTest = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const video = fs.existsSync(path.join(A.video, 'suite.y4m')) ? path.join(A.video, 'suite.y4m') : null;
const t00 = Date.now(), results = { args: A };

const { page, logs, close } = await launch({ root: A.root, port: A.port, harness: A.harness, cdn: A.cdn, model: A.model, fakeVideo: video });
try {
  console.log(`booted in ${((Date.now() - t00) / 1000).toFixed(0)} s; camera: ${video || 'Chromium test pattern'}`);
  if (!A.render) await freeze(page);
  await page.evaluate(async () => { const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs'); window.__rig = window.__rig || L.recorder(P); Object.assign(P.Settings, { handed: 'R', replays: false, voice: false }); });
  if (A.modelTest) results.model = await runModel();
  if (A.inject) results.inject = await runInject();
  if (A.practice) results.practice = await runPractice();
} finally {
  const errs = logs.filter((l) => /error|pageerror/i.test(l));
  results.consoleErrors = errs;
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n` + errs.slice(0, 12).join('\n'));
  await close();
  if (A.json) fs.writeFileSync(A.json, JSON.stringify(results, null, 1));
  console.log(`\ndone in ${((Date.now() - t00) / 1000).toFixed(0)} s`);
}

async function runModel() {
  const r = await page.evaluate(async ({ secs, main, sens }) => {
    const P = window.PalmCourt, T = P.Tracker, { UI } = await import('/src/ui.js'), wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const res = [], long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch (e) { /* no longtask API */ }
    const ow = T.onWorker;
    T.onWorker = function (m) { if (m && m.type === 'result') res.push({ ms: m.ms, n: (m.landmarks || []).length, t: m.t, at: performance.now(), err: m.error || null }); return ow.call(this, m); };
    const hh = T.handleHands, mainRes = [];
    T.handleHands = function (h, l, t) { if (this.landmarker) mainRes.push({ n: h.length, at: performance.now() }); return hh.call(this, h, l, t); };
    const eh = T.ensureHands, times = {};
    T.ensureHands = async function () { const a = performance.now(); try { return await eh.call(this); } finally { times.ensureHands = performance.now() - a; } };
    if (main) T.workerState = 'failed';
    P.Settings.sens = sens;
    UI.setControl('hand');
    const t0 = performance.now();
    await UI.openSetup('menu');
    times.start = performance.now() - t0;
    window.__rig.take();
    long.length = 0;
    const r0 = res.length, m0 = mainRes.length, w0 = performance.now();
    await wait(secs * 1000);
    const span = (performance.now() - w0) / 1000, got = res.slice(r0), gotMain = mainRes.slice(m0), rec = window.__rig.take();
    const out = {
      times, delegate: T.delegate, where: T.where, workerState: T.workerState, info: T.info(), stalls: T.stalls, lagMs: T.lagMs, procMs: T.procMs,
      results: main ? gotMain.length : got.length, perSec: (main ? gotMain.length : got.length) / span, ms: got.map((x) => x.ms), withHands: (main ? gotMain : got).filter((x) => x.n).length,
      firstResult: res.length ? res[0].at - t0 : null, errors: got.filter((x) => x.err).map((x) => x.err).slice(0, 3), swingLog: document.getElementById('swingLog').textContent,
      processMs: rec.procMs, longTasks: long.length, longMs: long.reduce((a, b) => a + b, 0) / span, events: rec.events.length,
    };
    T.stop();
    return out;
  }, { secs: A.secs, main: A.main, sens: A.sens });
  console.log('\n== hand: MediaPipe on the fake camera ==');
  console.log(`start ${Math.round(r.times.start)} ms (ensureHands ${Math.round(r.times.ensureHands)} ms), first result ${msr(r.firstResult)} ms after start; ${r.delegate || '?'} on ${r.where || '?'} (worker ${r.workerState})`);
  console.log(`${r.results} results in ${A.secs} s = ${f1(r.perSec)} per s; model ${f1(q(r.ms, 0.5))}/${f1(q(r.ms, 0.9))} ms per frame (median/p90); Tracker.info "${r.info}"; stalls ${r.stalls}`);
  console.log(`main thread: Tracker.process ${f1(q(r.processMs, 0.5))}/${f1(q(r.processMs, 0.9))} ms per camera frame, long tasks ${r.longTasks} (${f1(r.longMs)} ms/s); frames with a hand found ${r.withHands} (the video has no hand: should be 0); swing events ${r.events}`);
  if (r.errors.length) console.log('model errors: ' + r.errors.join(' | '));
  if (/fail|error|too long/i.test(r.swingLog)) console.log('camera check says: ' + r.swingLog);
  delete r.ms; delete r.processMs;
  return r;
}

// The chosen clips back to back (like the paddle video), 1 s of the last clip's tail first so the detector warms up.
function handSuite(names) {
  let start = 0;
  const segments = names.map((n) => { const c = CLIPS.find((x) => x.name === n), truth = truthOf(c), s = { name: n, start, frames: truth.frames, truth }; start += truth.frames; return s; });
  return { fps: FPS, total: start, segments };
}

async function runInject() {
  const names = A.clips.split(','), suite = handSuite(names), pre = FPS;
  const raw = await page.evaluate(async ({ names, total, pre, o }) => {
    const P = window.PalmCourt, T = P.Tracker, L = await import('/tests/e2e/live.mjs'), { CLIPS } = await import('/tests/e2e/clips.mjs'), R = window.__rig;
    T.stop(); T.kind = 'hand'; P.Settings.control = 'hand'; P.Input.lost(); R.take();
    let t = 0;
    const segs = names.map((n) => { const c = CLIPS.find((x) => x.name === n), s = { s: c.build(), t0: t, dur: c.dur }; t += c.dur; return s; });
    const at = (tt) => { tt = ((tt % t) + t) % t; const s = segs.find((x) => tt >= x.t0 && tt < x.t0 + x.dur) || segs[segs.length - 1]; return [s, tt - s.t0]; };
    const script = { pos: (tt) => { const [s, u] = at(tt); return s.s.pos(u); }, vel: (tt) => { const [s, u] = at(tt); return s.s.vel(u); } };
    const t0 = performance.now() + 100;
    const feed = L.handFeed(P, { script, t0, frames: total + pre + 6, content: (k) => (k - pre) / 30, rec: R, onFrame: (k) => ({ g: k - pre, T: null }), arrive: o.arrive, proc: o.proc, procSd: o.procsd, offHand: o.offhand, flip: o.flip, seed: 11 });
    while (!feed.st.done) await new Promise((r) => setTimeout(r, 100));
    const rec = R.take();
    for (const f of rec.frames) f.T = f.tCap;   // synthetic frames: the capture time is known exactly
    return { rec, st: feed.st };
  }, { names, total: suite.total, pre, o: { arrive: A.arrive, proc: A.proc, procsd: A.procsd, offhand: A.offhand, flip: A.flip } });
  const idx = new Map(), frames = [];
  raw.rec.frames.forEach((f, i) => { if (f.g == null) return; idx.set(i, frames.length); frames.push({ g: f.g, T: f.T, pt: f.pt, ms: f.ms }); });
  const events = raw.rec.events.map((e) => ({ ...e, g: idx.has(e.fi) ? frames[idx.get(e.fi)].g : null }));
  const res = analyse(suite, frames, events, { warm: 0 });
  console.log(report(res, `hand: synthetic landmarks → Tracker.handleHands (camera ${FPS} fps, model ${A.proc}±${A.procsd} ms, ${A.offhand ? 'other hand in view' : 'one hand'})`, { aux: A.aux }));
  console.log(`feed: ${raw.st.sent} frames to the tracker, ${raw.st.dropped} skipped while it was busy, ${raw.st.lost} with the hand lost to blur`);
  for (const c of Object.values(res.clips)) { delete c.err; delete c.errFast; delete c.ms; }
  return { res, feed: raw.st };
}

async function runPractice() {
  const r = await page.evaluate(async ({ points, limit, o }) => {
    const P = window.PalmCourt, T = P.Tracker, L = await import('/tests/e2e/live.mjs'), { UI } = await import('/src/ui.js'), { Bus } = await import('/src/events.js');
    const R = window.__rig, wait = (ms) => new Promise((res) => setTimeout(res, ms));
    T.stop(); R.take();
    // Start with mouse controls (no camera, no model), then hand the local player to the synthetic hand tracker.
    UI.setControl('mouse');
    const hits = [], pts = [], faults = [], timing = [];
    const offs = [Bus.on('hit', (h) => hits.push(h)), Bus.on('point', (d) => pts.push({ w: d.w, reason: d.reason, rally: d.rally })), Bus.on('fault', (d) => faults.push(d.reason))];
    const tm = UI.timing; UI.timing = function (t) { timing.push(t); return tm.apply(this, arguments); };
    await UI.startCpu({});
    P.Settings.control = 'hand'; T.kind = 'hand'; P.Input.lost();
    const script = new L.Script(Infinity, L.REST), feed = L.handFeed(P, { script, rec: R, arrive: o.arrive, proc: o.proc, procSd: o.procsd, offHand: o.offhand, flip: o.flip, seed: 21 });
    const C = L.coach(P, script), t0 = performance.now();
    while (pts.length < points && performance.now() - t0 < limit * 1000 && P.Game.state !== 'over') await wait(200);
    C.stop(); feed.stop(); offs.forEach((f) => f()); UI.timing = tm;
    const rec = R.take(), errs = [];
    for (const f of rec.frames) if (f.pt) { const tp = script.pos(f.tCap / 1000); errs.push(Math.hypot(f.pt.x - tp.x, (f.pt.y - tp.y) * 0.75)); }
    return { hits, pts, faults, timing, coach: C.log, swings: rec.events.filter((e) => e.type === 'swing').map((e) => e.sw), tosses: rec.events.filter((e) => e.type === 'toss').length, seen: rec.frames.length, found: errs.length, errs, feed: feed.st };
  }, { points: A.points, limit: A.limit, o: { arrive: A.arrive, proc: A.proc, procsd: A.procsd, offhand: A.offhand, flip: A.flip } });
  console.log(practiceReport(r, 'hand: practice match (synthetic landmarks)'));
  console.log(`tracker: ${r.seen} hand frames, found ${r.found}, error median ${f1(q(r.errs, 0.5), 3)} p90 ${f1(q(r.errs, 0.9), 3)} frame widths`);
  delete r.errs;
  return r;
}
