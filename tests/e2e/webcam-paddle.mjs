// End-to-end test of the PADDLE webcam controls: the real game in headless Chromium, synthetic webcam frames of a
// person swinging a red / blue paddle in a room, the real color tracker + swing detector, ground truth for every frame.
//   node tests/e2e/webcam-paddle.mjs [--mode lockstep|video] [--cam direct|stream] [--root <repo>] [--port 8806]
//        [--harness <pc.mjs>] [--cdn <node_modules dir>] [--video tests/e2e/out] [--points 2] [--no-suite] [--no-practice]
//        [--render] [--sens 1] [--json out.json] [--aux]
// Part 1 (suite): Paddle controls → Camera check → the color is locked with the button while the paddle is held in the
// circle, then every clip plays once while Input events are recorded.
//   --mode lockstep (default): each frame is drawn in the page and handed to Tracker.process with an exact 30 fps
//     capture time, so every frame is tracked however slow the machine is (numbers are about the code).
//   --mode video: the .y4m from gen-video.mjs is Chromium's fake webcam, in real time: getUserMedia, the <video>,
//     requestVideoFrameCallback timestamps and frame drops included (numbers are about the code AND this machine).
// Part 2 (practice): a coach swings the paddle at the ball in a practice match, counting hits.
//   --cam direct (default): frames drawn at 30 fps and processed at once; --cam stream: through a canvas MediaStream.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, launch, freeze, analyse, report, practiceReport, count, HERE, REPO, q, msr, f1 } from './lib.mjs';
import { LOCK_WINDOW, buildSuite } from './clips.mjs';

const A = parseArgs({ root: REPO, port: 8806, mode: 'lockstep', cam: 'direct', video: path.join(HERE, 'out'), harness: process.env.PC_HARNESS || '', cdn: '', model: '', points: 2, suite: true, practice: true, render: false, sens: 1, json: '', aux: false, limit: 150 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let suite = buildSuite();
if (A.mode === 'video') {
  const sp = path.join(A.video, 'suite.json');
  if (!fs.existsSync(sp)) { console.error(`No ${sp}: run  node tests/e2e/gen-video.mjs --out ${A.video}  first.`); process.exit(2); }
  suite = JSON.parse(fs.readFileSync(sp, 'utf8'));
}
const t00 = Date.now(), results = { args: A };

const { page, logs, close } = await launch({ root: A.root, port: A.port, harness: A.harness, cdn: A.cdn, model: A.model, fakeVideo: A.mode === 'video' ? path.join(A.video, 'suite.y4m') : null });
try {
  console.log(`booted in ${((Date.now() - t00) / 1000).toFixed(0)} s`);
  if (!A.render) await freeze(page);
  await page.evaluate(async ({ sens }) => {
    const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs');
    window.__rig = window.__rig || L.recorder(P);
    Object.assign(P.Settings, { handed: 'R', sens, paddle: null, replays: false, voice: false });
  }, { sens: A.sens });
  if (A.suite) results.suite = A.mode === 'video' ? await runVideo() : await runLockstep();
  if (A.practice) results.practice = await runPractice();
} finally {
  const errs = logs.filter((l) => /error|pageerror/i.test(l));
  results.consoleErrors = errs;
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n` + errs.slice(0, 12).join('\n'));
  await close();
  if (A.json) fs.writeFileSync(A.json, JSON.stringify(results, null, 1));
  console.log(`\ndone in ${((Date.now() - t00) / 1000).toFixed(0)} s`);
}

async function runLockstep() {
  const t0 = Date.now();
  const r = await page.evaluate(async ({ suite }) => {
    const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs'), { UI } = await import('/src/ui.js'), R = window.__rig;
    const cam = L.directCamera(P);
    UI.setControl('paddle');
    await UI.openSetup('menu');
    R.take();
    const locks = await L.playSuite(P, suite, cam, R), rec = R.take();
    P.Tracker.stop(); cam.restore();
    return { locks, rec };
  }, { suite: { ...suite, segments: suite.segments.map((s) => ({ name: s.name, id: s.id, start: s.start, frames: s.frames })) } });
  for (const l of r.locks) console.log(`locked on ${l.clip} @${l.at} s: ${JSON.stringify(l.col)} — "${l.msg}"`);
  console.log(`lockstep: ${suite.total} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return finish(r.rec, r.locks, true);
}

async function runVideo() {
  const info = await page.evaluate(async () => {
    const P = window.PalmCourt, { UI } = await import('/src/ui.js');
    UI.setControl('paddle');
    const t0 = performance.now();
    await UI.openSetup('menu');
    return { startMs: performance.now() - t0, w: P.Tracker.video.videoWidth, h: P.Tracker.video.videoHeight };
  });
  console.log(`camera ${info.w}×${info.h}, started in ${Math.round(info.startMs)} ms`);
  const byId = new Map(suite.segments.map((s) => [s.id, s])), first = suite.segments[0], last = suite.segments[suite.segments.length - 1];
  const locks = [], limit = Date.now() + (2 * suite.total / suite.fps + 60) * 1000;
  let red = false, seenLast = false, lastPeek = null;
  // The fake camera starts the file when it opens; if the page missed the first lock clip, wait for the next pass.
  while (Date.now() < limit) {
    const c = await page.evaluate(() => window.__rig.peek()), s = c && byId.get(c.clip);
    if (s) {
      lastPeek = `${s.name}:${c.frame}`;
      const t = c.frame / suite.fps;
      if (/lock$/.test(s.name) && t >= LOCK_WINDOW[0] && t <= LOCK_WINDOW[1] && (s === first ? !red : red && !locks.some((l) => l.clip === s.name))) {
        const r = await page.evaluate(async () => { (await import('/src/ui.js')).UI.lockColor(true); const p = window.PalmCourt.Settings.paddle; return { msg: document.getElementById('swingLog').textContent, col: p && { h: +p.h.toFixed(1), s: +p.s.toFixed(2), v: +p.v.toFixed(2), tol: +p.tol.toFixed(1), css: p.css } }; });
        locks.push({ clip: s.name, at: +t.toFixed(2), ...r });
        console.log(`locked on ${s.name} @${t.toFixed(2)} s: ${JSON.stringify(r.col)} — "${r.msg}"`);
        if (s === first && r.col) { red = true; await page.evaluate(() => window.__rig.take()); }
      }
      if (red && s === last && c.frame > s.frames - 8) seenLast = true;
      if (seenLast && s !== last) break;
    }
    await sleep(100);
  }
  if (!red) { console.log(`never locked the color on the first clip (last frame seen ${lastPeek})`); return { locks }; }
  const rec = await page.evaluate(() => { const r = window.__rig.take(); window.PalmCourt.Tracker.stop(); return r; });
  return finish(rec, locks, false);
}

function finish(raw, locks, lockstep) {
  const { frames, events } = toSuiteFrames(raw, lockstep);
  const res = analyse(suite, frames, events, { lockedAt: Object.fromEntries(locks.map((l) => [l.clip, l.at])) });
  const stamps = count(raw.frames.map((f) => (f.meta && f.meta.stamp) || '?'));
  const pipe = raw.frames.filter((f) => f.meta && f.meta.cap && f.meta.pres).map((f) => f.meta.pres - f.meta.cap);
  console.log(report(res, `paddle: scripted clips (${lockstep ? 'lockstep, every frame' : 'fake webcam video, real time'})`, { aux: A.aux }));
  console.log(`frame stamps ${JSON.stringify(stamps)}${pipe.length ? `, capture → presentation ${msr(q(pipe, 0.5))} ms` : ''}, Tracker.process ${f1(q(raw.procMs, 0.5))}/${f1(q(raw.procMs, 0.9))} ms (median/p90), ${raw.frames.length} frames tracked, ${raw.frames.filter((f) => !f.code).length} without a readable barcode`);
  for (const c of Object.values(res.clips)) { delete c.err; delete c.errFast; delete c.ms; }
  return { locks, stamps, res };
}

// Page records → suite frame numbers. The barcode gives clip + frame; passes of the looping suite are unwrapped in order.
// Lockstep: an event's time is its frame's capture time plus the real time the tracker spent on that frame.
function toSuiteFrames(raw, lockstep) {
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
    frames.push({ g, T, pt: f.pt, ms: f.ms, wall: f.wall });
  });
  const events = raw.events.map((e) => {
    const fr = idx.has(e.fi) ? frames[idx.get(e.fi)] : null;
    return { ...e, g: fr ? fr.g : null, wall: lockstep && fr ? fr.T + (fr.ms || 0) + (e.wall - fr.wall) : e.wall };
  });
  return { frames, events };
}

async function runPractice() {
  const r = await page.evaluate(async ({ points, limit, cam: camKind }) => {
    const P = window.PalmCourt, L = await import('/tests/e2e/live.mjs'), { UI } = await import('/src/ui.js'), { Bus } = await import('/src/events.js');
    const R = window.__rig, wait = (ms) => new Promise((res) => setTimeout(res, ms));
    P.Tracker.stop(); R.take();
    const script = new L.Script(Infinity, L.REST);
    let cam, direct = null;
    if (camKind === 'stream') { cam = L.liveCamera({ script, color: 'red' }); navigator.mediaDevices.getUserMedia = async () => cam.stream.clone(); }
    else { direct = L.directCamera(P); cam = L.liveDirect(direct, script, { rec: R }); }
    // Lock the color on the live camera: bring the paddle to the circle, hold, press the button.
    UI.setControl('paddle');
    await UI.openSetup('menu');
    let p = performance.now() / 1000;
    script.to('shift', p, p + 0.5, { x: 0.5, y: 0.5 });
    await wait(1500);
    UI.lockColor(true);   // the button counts down 3 s for a real player
    const pl = P.Settings.paddle, lock = pl && { h: +pl.h.toFixed(1), s: +pl.s.toFixed(2), tol: +pl.tol.toFixed(1) };
    p = performance.now() / 1000;
    script.to('shift', p, p + 0.5, L.REST);
    await wait(700);
    UI.closeSetup();
    const hits = [], pts = [], faults = [], timing = [];
    const offs = [Bus.on('hit', (h) => hits.push(h)), Bus.on('point', (d) => pts.push({ w: d.w, reason: d.reason, rally: d.rally })), Bus.on('fault', (d) => faults.push(d.reason))];
    const tm = UI.timing; UI.timing = function (t) { timing.push(t); return tm.apply(this, arguments); };
    await UI.startCpu({});
    R.take();
    const C = L.coach(P, script), t0 = performance.now();
    while (pts.length < points && performance.now() - t0 < limit * 1000 && P.Game.state !== 'over') await wait(200);
    C.stop(); cam.stop(); offs.forEach((f) => f()); UI.timing = tm;
    const rec = R.take();
    P.Tracker.stop(); if (direct) direct.restore();
    // Tracking error: barcode frame → the moment it was drawn → where the paddle was.
    const errs = [];
    let found = 0, seen = 0;
    for (const f of rec.frames) {
      if (!f.code || f.code.clip !== 15) continue;
      seen++;
      let k = -1;
      for (let j = cam.log.length - 1; j >= 0; j--) if ((j & 1023) === f.code.frame && cam.log[j] <= f.wall + 1) { k = j; break; }
      if (k < 0 || !f.pt) continue;
      found++;
      const tp = script.pos(cam.log[k] / 1000);
      errs.push(Math.hypot(f.pt.x - tp.x, (f.pt.y - tp.y) * 0.75));
    }
    return {
      lock, hits, pts, faults, timing, coach: C.log, swings: rec.events.filter((e) => e.type === 'swing').map((e) => e.sw), tosses: rec.events.filter((e) => e.type === 'toss').length,
      seen, found, errs, camFrames: cam.log.length, camSecs: (cam.log[cam.log.length - 1] - cam.log[0]) / 1000, drawMs: cam.ms, procMs: rec.procMs,
    };
  }, { points: A.points, limit: A.limit, cam: A.cam });
  console.log(practiceReport(r, `paddle: practice match (${A.cam === 'stream' ? 'canvas MediaStream camera' : 'direct camera'}, real time)`));
  delete r.errs; delete r.drawMs; delete r.procMs;
  return r;
}
