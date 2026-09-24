// End-to-end test of the PADDLE webcam controls: the real game in headless Chromium, a synthetic webcam video (from
// gen-video.mjs) as the camera, the real color tracker + swing detector, and ground truth for every frame.
//   node tests/e2e/gen-video.mjs --out tests/e2e/out            (once; ~50 s, ~670 MB)
//   node tests/e2e/webcam-paddle.mjs [--video tests/e2e/out] [--root <repo>] [--port 8806] [--harness <pc.mjs>]
//        [--cdn <node_modules dir>] [--points 2] [--no-suite] [--no-practice] [--render] [--sens 1] [--json out.json] [--aux]
// Part 1 (suite): Paddle controls → Camera check → the color is locked while the video holds the paddle in the circle,
// then every clip plays once while Input events are recorded. Part 2 (practice): a live synthetic camera whose paddle
// a coach swings at the ball, in a practice match, counting hits. See README.md for what the numbers mean.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, launch, freeze, analyse, report, practiceReport, count, HERE, REPO, q, msr, f1 } from './lib.mjs';
import { LOCK_WINDOW } from './clips.mjs';

const A = parseArgs({ root: REPO, port: 8806, video: path.join(HERE, 'out'), harness: process.env.PC_HARNESS || '', cdn: '', model: '', points: 2, suite: true, practice: true, render: false, sens: 1, json: '', aux: false, limit: 150 });
const suitePath = path.join(A.video, 'suite.json');
if (!fs.existsSync(suitePath)) { console.error(`No ${suitePath}: run  node tests/e2e/gen-video.mjs --out ${A.video}  first.`); process.exit(2); }
const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t00 = Date.now(), results = { args: A };

const { page, logs, close } = await launch({ root: A.root, port: A.port, harness: A.harness, cdn: A.cdn, model: A.model, fakeVideo: path.join(A.video, 'suite.y4m') });
try {
  console.log(`booted in ${((Date.now() - t00) / 1000).toFixed(0)} s`);
  if (!A.render) await freeze(page);
  if (A.suite) results.suite = await runSuite();
  if (A.practice) results.practice = await runPractice();
} finally {
  const errs = logs.filter((l) => /error|pageerror/i.test(l));
  results.consoleErrors = errs;
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n` + errs.slice(0, 12).join('\n'));
  await close();
  if (A.json) fs.writeFileSync(A.json, JSON.stringify(results, null, 1));
  console.log(`\ndone in ${((Date.now() - t00) / 1000).toFixed(0)} s`);
}

async function runSuite() {
  const info = await page.evaluate(async ({ sens }) => {
    const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs'), { UI } = await import('/src/ui.js');
    window.__rig = window.__rig || L.recorder(P);
    Object.assign(P.Settings, { handed: 'R', sens, paddle: null, replays: false, voice: false });
    UI.setControl('paddle');
    const t0 = performance.now();
    await UI.openSetup('menu');
    return { startMs: performance.now() - t0, latency: P.Settings.latency, w: P.Tracker.video.videoWidth, h: P.Tracker.video.videoHeight };
  }, { sens: A.sens });
  console.log(`camera ${info.w}×${info.h}, started in ${Math.round(info.startMs)} ms, Settings.latency ${info.latency}`);
  const byId = new Map(suite.segments.map((s) => [s.id, s])), last = suite.segments[suite.segments.length - 1];
  const locks = [], limit = Date.now() + (suite.total / suite.fps + 60) * 1000;
  let locked = 0, seenLast = false, lastPeek = null;
  while (Date.now() < limit) {
    const c = await page.evaluate(() => window.__rig.peek());
    const s = c && byId.get(c.clip);
    if (s) {
      lastPeek = `${s.name}:${c.frame}`;
      const t = c.frame / suite.fps;
      if (/lock$/.test(s.name) && t >= LOCK_WINDOW[0] && t <= LOCK_WINDOW[1] && !locks.some((l) => l.clip === s.name)) {
        const col = await page.evaluate(() => { document.getElementById('btnLockColor').click(); const p = window.PalmCourt.Settings.paddle; return { msg: document.getElementById('swingLog').textContent, col: p && { h: +p.h.toFixed(1), s: +p.s.toFixed(2), v: +p.v.toFixed(2), tol: +p.tol.toFixed(1), css: p.css } }; });
        locks.push({ clip: s.name, at: +t.toFixed(2), ...col });
        console.log(`locked on ${s.name} @${t.toFixed(2)} s: ${JSON.stringify(col.col)} — "${col.msg}"`);
        if (col.col) locked++;
      }
      if (locked && s === last && c.frame > s.frames - 8) seenLast = true;
      if (seenLast && s !== last) break;
    }
    await sleep(100);
  }
  if (!locked) { console.log(`never locked the color (last frame seen ${lastPeek})`); return { locks }; }
  const raw = await page.evaluate(() => { const r = window.__rig.take(); window.PalmCourt.Tracker.stop(); return r; });
  const { frames, events } = toSuiteFrames(raw);
  const res = analyse(suite, frames, events);
  const stamps = count(raw.frames.map((f) => (f.meta && f.meta.stamp) || '?'));
  const pipe = raw.frames.filter((f) => f.meta && f.meta.cap && f.meta.pres).map((f) => f.meta.pres - f.meta.cap);
  console.log(report(res, 'paddle: scripted clips (fake webcam video)', { aux: A.aux }));
  console.log(`frame stamps ${JSON.stringify(stamps)}, capture → presentation ${msr(q(pipe, 0.5))} ms, Tracker.process ${f1(q(raw.procMs, 0.5))}/${f1(q(raw.procMs, 0.9))} ms (median/p90), ${raw.frames.length} frames tracked, ${raw.frames.filter((f) => !f.code).length} without a readable barcode`);
  for (const c of Object.values(res.clips)) { delete c.err; delete c.errFast; delete c.ms; }
  return { locks, stamps, res };
}

// Page records → suite frame numbers. The barcode gives clip + frame; passes of the looping suite are unwrapped in order.
function toSuiteFrames(raw) {
  const byId = new Map(suite.segments.map((s) => [s.id, s])), N = suite.total, idx = new Map();
  let pass = 0, prev = null;
  const frames = [];
  raw.frames.forEach((f, i) => {
    const s = f.code && byId.get(f.code.clip);
    if (!s || f.code.frame >= s.frames) return;
    let g = s.start + f.code.frame;
    if (prev != null && g < prev - N / 2) pass++;
    prev = g; g += pass * N;
    const m = f.meta || {}, T = Number.isFinite(m.cap) ? m.cap : Number.isFinite(m.recv) ? m.recv : Number.isFinite(m.pres) ? m.pres : f.tCap;
    idx.set(i, frames.length);
    frames.push({ g, T, pt: f.pt, ms: f.ms });
  });
  const events = raw.events.map((e) => ({ ...e, g: idx.has(e.fi) ? frames[idx.get(e.fi)].g : null }));
  return { frames, events };
}

async function runPractice() {
  const r = await page.evaluate(async ({ points, limit }) => {
    const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs'), { UI } = await import('/src/ui.js'), { Bus } = await import('/src/events.js');
    const R = window.__rig || (window.__rig = L.recorder(P)), wait = (ms) => new Promise((r) => setTimeout(r, ms));
    P.Tracker.stop(); R.take();
    Object.assign(P.Settings, { handed: 'R', replays: false, voice: false });
    const script = new L.Script(Infinity, L.REST), cam = L.liveCamera({ script, color: 'red' });
    navigator.mediaDevices.getUserMedia = async () => cam.stream.clone();
    // Lock the color on the live camera: bring the paddle to the circle, hold, lock.
    UI.setControl('paddle');
    await UI.openSetup('menu');
    let p = performance.now() / 1000;
    script.to('shift', p, p + 0.5, { x: 0.5, y: 0.5 });
    await wait(1500);
    document.getElementById('btnLockColor').click();
    const lock = P.Settings.paddle && { h: +P.Settings.paddle.h.toFixed(1), s: +P.Settings.paddle.s.toFixed(2), tol: P.Settings.paddle.tol };
    p = performance.now() / 1000;
    script.to('shift', p, p + 0.5, L.REST);
    await wait(700);
    UI.closeSetup();
    R.take();
    const hits = [], pts = [], faults = [], timing = [];
    const offs = [Bus.on('hit', (h) => hits.push(h)), Bus.on('point', (d) => pts.push({ w: d.w, reason: d.reason, rally: d.rally })), Bus.on('fault', (d) => faults.push(d.reason))];
    const tm = UI.timing; UI.timing = function (t) { timing.push(t); return tm.apply(this, arguments); };
    await UI.startCpu({});
    const C = L.coach(P, script), t0 = performance.now();
    while (pts.length < points && performance.now() - t0 < limit * 1000 && P.Game.state !== 'over') await wait(200);
    C.stop(); cam.stop(); offs.forEach((f) => f()); UI.timing = tm;
    const rec = R.take();
    // Tracking error on the live camera: barcode frame → the moment it was drawn → where the paddle was.
    const errs = [];
    let found = 0, seen = 0;
    for (const f of rec.frames) {
      if (!f.code || f.code.clip !== 15) continue;
      seen++;
      let k = -1;
      for (let j = cam.log.length - 1; j >= 0; j--) if ((j & 1023) === f.code.frame && cam.log[j] <= f.wall) { k = j; break; }
      if (k < 0 || !f.pt) continue;
      found++;
      const tp = script.pos(cam.log[k] / 1000);
      errs.push(Math.hypot(f.pt.x - tp.x, (f.pt.y - tp.y) * 0.75));
    }
    const swings = rec.events.filter((e) => e.type === 'swing').map((e) => e.sw), me = P.Game.me();
    return {
      lock, hits, pts, faults, timing, coach: C.log, swings, tosses: rec.events.filter((e) => e.type === 'toss').length, seen, found, errs,
      camFrames: cam.log.length, camSecs: (cam.log[cam.log.length - 1] - cam.log[0]) / 1000, drawMs: cam.ms, score: P.Game.match && P.Game.match.pts, server: me && P.Game.match && P.Game.match.currentServer === me.idx,
    };
  }, { points: A.points, limit: A.limit });
  console.log(practiceReport(r, 'paddle: practice match (live synthetic camera)'));
  return r;
}
