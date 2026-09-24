// Shared parts of the webcam rig: arguments, finding Playwright, launching Chromium with a fake camera, and turning
// what the page recorded into metrics against the ground truth.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASPECT } from './scene.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

// --key value / --flag (true) / --no-flag (false)
export function parseArgs(defs, argv = process.argv.slice(2)) {
  const o = { ...defs };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a.startsWith('--no-')) { o[a.slice(5)] = false; continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true;
    else { o[k] = typeof defs[k] === 'number' ? +v : v; i++; }
  }
  return o;
}

// Playwright from this repo, the current directory, $PLAYWRIGHT_MODULE, or the global npm root.
export async function loadPlaywright() {
  const bases = [import.meta.url, pathToFileURL(path.join(process.cwd(), 'x.js')).href];
  if (process.env.PLAYWRIGHT_MODULE) bases.unshift(pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE, '..', 'x.js')).href);
  try { bases.push(pathToFileURL(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'x.js')).href); } catch (e) { /* no npm */ }
  for (const b of bases) {
    try { const f = createRequire(b).resolve('playwright'); const m = await import(pathToFileURL(f).href); return m.chromium ? m : m.default; } catch (e) { /* next */ }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright && npx playwright install chromium) or set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright.');
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.svg': 'image/svg+xml' };
function serve(root, port) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r, j) => { srv.on('error', j); srv.listen(port, '127.0.0.1', () => r(srv)); });
}

// Launch Chromium on the game with a fake camera. With o.harness (a pc.mjs launcher, e.g. the sandbox's shared
// harness that mirrors the CDN and limits concurrent browsers) that launcher is used; otherwise a local static server
// and Playwright's Chromium (o.cdn: a node_modules folder to serve cdn.jsdelivr.net from, o.model: a local
// hand_landmarker.task, for offline machines).
export async function launch(o) {
  const root = path.resolve(o.root || REPO), width = o.width || 960, height = o.height || 540;
  if (o.harness) {
    const Hm = await import(pathToFileURL(path.resolve(o.harness)).href);
    return Hm.launch({ root, port: o.port, fakeVideo: o.fakeVideo, width, height, args: o.args || [] });
  }
  const pw = await loadPlaywright(), srv = await serve(root, o.port);
  const browser = await pw.chromium.launch({ headless: o.headless !== false, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(o.fakeVideo ? ['--use-file-for-fake-video-capture=' + path.resolve(o.fakeVideo)] : []), '--ignore-gpu-blocklist', ...(o.args || [])] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, permissions: ['camera'] });
  const logs = [];
  if (o.cdn) await ctx.route('https://cdn.jsdelivr.net/**', (route) => {
    const m = route.request().url().match(/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)(?:@[^/]+)?\/(.*)$/), f = m && path.join(o.cdn, m[1], m[2].split('?')[0]);
    if (f && fs.existsSync(f)) route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f), headers: { 'access-control-allow-origin': '*' } });
    else { logs.push('[rig] missing CDN file ' + route.request().url()); route.fulfill({ status: 404, body: '' }); }
  });
  if (o.model) await ctx.route('https://storage.googleapis.com/mediapipe-models/**', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(o.model), headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://0.peerjs.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  await page.goto(`http://127.0.0.1:${o.port}/index.html`);
  await page.waitForFunction(() => window.PalmCourt && window.PalmCourt.Game, null, { timeout: 180000 });
  const close = async () => { try { await browser.close(); } finally { srv.close(); } };
  return { browser, page, logs, close };
}

// Stop the game drawing (SwiftShader here takes most of a CPU per frame, which would starve the camera callbacks).
// main.js keeps the match logic running from its hidden-tab timer, so a practice match still plays.
export async function freeze(page) {
  await page.evaluate(() => { if (window.__rigRaf) return; window.__rigRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
}

// ---- statistics ----
export const sorted = (a) => a.slice().sort((p, q) => p - q);
export const q = (a, k) => { if (!a.length) return NaN; const s = sorted(a); return s[Math.min(s.length - 1, Math.floor(k * s.length))]; };
export const mean = (a) => (a.length ? a.reduce((p, v) => p + v, 0) / a.length : NaN);
export const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((p, v) => p + (v - m) ** 2, 0) / (a.length - 1)); };
export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
export const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export const msr = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '–');

// A monotonic map between suite frame numbers g (content time = g / fps) and page time (performance.now() ms), from
// the frames that were seen: linear interpolation between them, a least-squares line outside.
export function timeMap(pairs, fps) {
  const P = pairs.filter((p) => Number.isFinite(p.T)).sort((a, b) => a.g - b.g).filter((p, i, a) => !i || p.g > a[i - 1].g);
  const n = P.length, mg = mean(P.map((p) => p.g)), mT = mean(P.map((p) => p.T));
  let sxy = 0, sxx = 0;
  for (const p of P) { sxy += (p.g - mg) * (p.T - mT); sxx += (p.g - mg) ** 2; }
  const slope = n > 2 && sxx ? sxy / sxx : 1000 / fps, icpt = mT - slope * mg;
  const lin = (g) => icpt + slope * g, resid = P.map((p) => p.T - lin(p.g));
  const Tof = (g) => {
    if (n < 2) return lin(g);
    let lo = 0, hi = n - 1;
    if (g <= P[0].g || g >= P[n - 1].g) return lin(g) + (g <= P[0].g ? resid[0] : resid[n - 1]);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].g <= g) lo = m; else hi = m; }
    const a = P[lo], b = P[hi]; return a.T + ((b.T - a.T) * (g - a.g)) / (b.g - a.g);
  };
  const gOf = (T) => {
    if (n < 2) return (T - icpt) / slope;
    if (T <= P[0].T || T >= P[n - 1].T) return (T - (T <= P[0].T ? resid[0] : resid[n - 1]) - icpt) / slope;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].T <= T) lo = m; else hi = m; }
    const a = P[lo], b = P[hi]; return b.T === a.T ? a.g : a.g + ((b.g - a.g) * (T - a.T)) / (b.T - a.T);
  };
  return { Tof, gOf, slope, jitter: q(resid.map(Math.abs), 0.9), n };
}

// Moves a detection of which may be counted as a stroke / is harmless / is a false trigger.
const STROKE = new Set(['stroke', 'serve']), AUX = new Set(['windup', 'return', 'raise']);

// suite: { fps, total (frames per loop of the whole suite), segments: [{ name, start, frames, truth }] }
// frames: [{ g (unwrapped suite frame), T (page ms that frame shows), pt ({x, y} mirrored | null), ms }]
// events: [{ type, wall (page ms), g (frame being processed), sw: { t0, tOn (page ms), dir, peak, role, tEff… } }]
export function analyse(suite, frames, events, o = {}) {
  const fps = suite.fps, N = suite.total, tm = timeMap(frames, fps), warm = o.warm ?? 20;
  const gs = frames.map((f) => f.g), gMin = Math.min(...gs), gMax = Math.max(...gs);
  const segOf = (g) => { const k = ((Math.floor(g) % N) + N) % N; return suite.segments.find((s) => k >= s.start && k < s.start + s.frames); };
  const out = { timeMap: { msPerFrame: tm.slope, jitterMs: tm.jitter, frames: tm.n }, clips: {} };
  const byClip = (name) => out.clips[name] || (out.clips[name] = { name, frames: 0, found: 0, err: [], errFast: [], foundFast: 0, fast: 0, jumps: 0, ms: [], truthStrokes: [], det: [], fp: [], aux: [], tosses: [], tossDet: [], falseToss: [] });
  // Tracking: every processed frame against the truth position.
  const seen = new Set();
  for (const f of frames) {
    const s = segOf(f.g);
    if (!s || !s.truth.paddle) continue;
    const c = byClip(s.name), k = (((Math.floor(f.g) % N) + N) % N) - s.start, tp = s.truth.paddle[k];
    if (o.lockedAt && o.lockedAt[s.name] != null && k / fps <= o.lockedAt[s.name]) continue;   // before its color was locked
    c.frames++; if (Number.isFinite(f.ms)) c.ms.push(f.ms);
    seen.add(Math.floor(f.g));
    const pr = s.truth.paddle[(k + s.frames - 1) % s.frames], nx = s.truth.paddle[(k + 1) % s.frames];
    const spd = (Math.hypot(nx[0] - pr[0], (nx[1] - pr[1]) / ASPECT) * fps) / 2, fast = spd > 2;
    if (fast) c.fast++;
    if (f.pt) {
      c.found++; if (fast) c.foundFast++;
      const e = Math.hypot(f.pt.x - tp[0], (f.pt.y - tp[1]) / ASPECT);
      c.err.push(e); if (fast) c.errFast.push(e);
      if (e > 0.1) c.jumps++;
    }
  }
  // Truth moves in every pass of the suite that was watched (after a warm-up), in unwrapped frame numbers.
  const moves = [], tosses = [];
  for (let pass = Math.floor(gMin / N) - 1; pass <= Math.floor(gMax / N) + 1; pass++) {
    for (const s of suite.segments) {
      const g0 = pass * N + s.start;
      for (const m of s.truth.moves || []) {
        const a = g0 + m.t0 * fps, b = g0 + m.t1 * fps;
        if (a < gMin + warm || b > gMax - 3) continue;
        moves.push({ ...m, clip: s.name, ga: a, gb: b, gp: g0 + m.tPeak * fps, hits: [] });
      }
      for (const t of s.truth.tosses || []) {
        const a = g0 + t.tIn * fps, b = g0 + t.tOut * fps;
        if (a < gMin + warm || b > gMax - 12) continue;
        tosses.push({ ...t, clip: s.name, ga: a, gb: b, hits: [] });
      }
    }
  }
  for (const m of moves) if (STROKE.has(m.kind)) byClip(m.clip).truthStrokes.push(m);
  for (const t of tosses) byClip(t.clip).tosses.push(t);
  for (const e of events) {
    if (e.g == null || e.g < gMin + warm) continue;
    if (e.type === 'toss') {
      const t = tosses.find((x) => e.g >= x.ga - 1 && e.g <= x.gb + 12), s = segOf(e.g);
      if (t) { t.hits.push(e); if (t.hits.length === 1) byClip(t.clip).tossDet.push({ latency: e.wall - tm.Tof(t.ga), frames: e.g - t.ga }); }
      else if (s) byClip(s.name).falseToss.push({ g: e.g, t: +(((e.g % N) - s.start) / fps).toFixed(2) });
      continue;
    }
    if (e.type !== 'swing') continue;
    const gOn = tm.gOf(e.sw.tOn), cand = moves.filter((m) => gOn >= m.ga - 1.5 && gOn <= m.gb + 1.5).sort((a, b) => b.ga - a.ga)[0];
    const s = segOf(e.g), c = byClip(cand ? cand.clip : s ? s.name : '?'), info = { t: +(((gOn % N) - (s ? s.start : 0)) / fps).toFixed(2), dir: e.sw.dir, peak: e.sw.peak, role: e.sw.role };
    if (!cand) { c.fp.push({ ...info, why: 'nothing moving' }); continue; }
    if (STROKE.has(cand.kind)) {
      cand.hits.push(e);
      if (cand.hits.length > 1) { c.fp.push({ ...info, why: `second swing on one ${cand.kind}` }); continue; }
      const tPeak = tm.Tof(cand.gp);
      c.det.push({ kind: cand.kind, stroke: cand.stroke, dir: e.sw.dir, role: e.sw.role, latency: e.wall - tPeak, t0err: e.sw.t0 - tPeak, peak: e.sw.peak, peakTruth: cand.peak, tEffErr: e.sw.tEff != null ? e.sw.tEff - tPeak : null, t: info.t });
    } else if (AUX.has(cand.kind)) c.aux.push({ ...info, kind: cand.kind });
    else c.fp.push({ ...info, why: `${cand.kind} at ${f1(cand.peak)} w/s` });
  }
  for (const c of Object.values(out.clips)) {
    const tp = c.det.length, strokes = c.truthStrokes.length, fb = c.det.filter((d) => d.stroke === 'fh' || d.stroke === 'bh');
    c.summary = {
      frames: c.frames, found: c.frames ? c.found / c.frames : NaN, foundFast: c.fast ? c.foundFast / c.fast : NaN, fastFrames: c.fast,
      errMed: q(c.err, 0.5), errP90: q(c.err, 0.9), errFastMed: q(c.errFast, 0.5), jumps: c.jumps, msMed: q(c.ms, 0.5), msP90: q(c.ms, 0.9),
      strokes, detected: tp, recall: strokes ? tp / strokes : NaN, falseTriggers: c.fp.length, precision: tp + c.fp.length ? tp / (tp + c.fp.length) : NaN,
      dirOk: fb.filter((d) => d.dir === d.stroke).length, dirN: fb.length, rolesWrong: c.det.filter((d) => d.role && d.role !== 'stroke').length,
      latMed: q(c.det.map((d) => d.latency), 0.5), latP90: q(c.det.map((d) => d.latency), 0.9), t0Mean: mean(c.det.map((d) => d.t0err)), t0Sd: sd(c.det.map((d) => d.t0err)),
      peakRatio: q(c.det.map((d) => d.peak / d.peakTruth), 0.5), aux: c.aux.length,
      tosses: c.tosses.length, tossHit: c.tossDet.length, tossLat: q(c.tossDet.map((d) => d.latency), 0.5), falseToss: c.falseToss.length,
    };
  }
  out.seenFrames = seen.size; out.span = gMax - gMin + 1;
  return out;
}

export function report(res, title, o = {}) {
  const L = [];
  L.push(`\n== ${title} ==`);
  L.push(`frames seen ${res.seenFrames} of ${res.span} (${pct(res.seenFrames, res.span)}), ${f1(res.timeMap.msPerFrame, 2)} ms/frame, time-map jitter p90 ${f1(res.timeMap.jitterMs)} ms`);
  L.push('clip        frames found  fast-found  err med/p90   jumps | strokes det  recall prec  fh/bh ok  false  lat med/p90 ms  t0 err ms  peak×  aux | toss  fired lat  false | track ms');
  for (const c of Object.values(res.clips)) {
    const s = c.summary;
    L.push(`${c.name.padEnd(11)} ${String(s.frames).padStart(6)} ${pct(s.found * 1e3, 1e3).padStart(5)}  ${pct(s.foundFast * 1e3, 1e3).padStart(5)} (${String(s.fastFrames).padStart(3)})  ${f1(s.errMed, 3)}/${f1(s.errP90, 3)}  ${String(s.jumps).padStart(5)} | ${String(s.strokes).padStart(7)} ${String(s.detected).padStart(3)}  ${pct(s.recall * 1e3, 1e3).padStart(6)} ${pct(s.precision * 1e3, 1e3).padStart(4)}  ${`${s.dirOk}/${s.dirN}`.padStart(8)}  ${String(s.falseTriggers).padStart(5)}  ${`${msr(s.latMed)}/${msr(s.latP90)}`.padStart(13)}  ${`${msr(s.t0Mean)}±${msr(s.t0Sd)}`.padStart(9)}  ${f1(s.peakRatio, 2).padStart(5)}  ${String(s.aux).padStart(3)} | ${String(s.tosses).padStart(4)}  ${String(s.tossHit).padStart(5)} ${msr(s.tossLat).padStart(4)}  ${String(s.falseToss).padStart(5)} | ${f1(s.msMed)}/${f1(s.msP90)}`);
  }
  const all = Object.values(res.clips);
  const tot = (k) => all.reduce((p, c) => p + (c.summary[k] || 0), 0);
  const dets = all.flatMap((c) => c.det);
  L.push(`TOTAL strokes ${tot('strokes')}, detected ${tot('detected')} (recall ${pct(tot('detected'), tot('strokes'))}), false triggers ${tot('falseTriggers')} (precision ${pct(tot('detected'), tot('detected') + tot('falseTriggers'))}), fh/bh right ${tot('dirOk')}/${tot('dirN')}, ` +
    `latency true peak → event median ${msr(q(dets.map((d) => d.latency), 0.5))} ms (p90 ${msr(q(dets.map((d) => d.latency), 0.9))}), t0 − true peak ${msr(mean(dets.map((d) => d.t0err)))} ± ${msr(sd(dets.map((d) => d.t0err)))} ms, tosses ${tot('tossHit')}/${tot('tosses')}, false tosses ${tot('falseToss')}`);
  for (const c of all) {
    for (const f of c.fp) L.push(`  false trigger  ${c.name} @${f.t}s  ${f.dir || 'up/down'} peak ${f1(f.peak)}  role ${f.role || '?'}  (${f.why})`);
    for (const m of c.truthStrokes.filter((m) => !m.hits.length)) L.push(`  missed         ${c.name} ${m.kind} ${m.stroke} peak @${f1(m.tPeak, 2)}s (${f1(m.peak)} w/s)`);
    for (const d of c.det.filter((d) => (d.stroke === 'fh' || d.stroke === 'bh') && d.dir !== d.stroke)) L.push(`  wrong stroke   ${c.name} @${d.t}s  truth ${d.stroke}, detector said ${d.dir || 'up/down'}`);
    for (const d of c.det.filter((d) => d.role && d.role !== 'stroke')) L.push(`  role           ${c.name} @${d.t}s  ${d.stroke} stroke labelled '${d.role}'`);
    for (const t of c.falseToss) L.push(`  false toss     ${c.name} @${t.t}s`);
    for (const t of c.tosses.filter((t) => !t.hits.length)) L.push(`  missed toss    ${c.name} above the line ${f1(t.tIn, 2)}–${f1(t.tOut, 2)}s`);
  }
  if (o.aux) for (const c of all) for (const a of c.aux) L.push(`  (aux)          ${c.name} @${a.t}s ${a.kind} → ${a.dir || 'up/down'} peak ${f1(a.peak)} role ${a.role || '?'}`);
  return L.join('\n');
}

export const count = (a) => a.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});

// Practice-match summary (webcam-paddle.mjs and webcam-hand.mjs).
export function practiceReport(r, title) {
  const L = [`\n== ${title} ==`];
  if (r.lock) L.push(`color lock on the live camera: ${JSON.stringify(r.lock)}`);
  const mine = r.hits.filter((h) => h.human), ground = mine.filter((h) => !h.serve), serves = mine.filter((h) => h.serve);
  L.push(`points played ${r.pts.length} (${r.pts.map((p) => `${p.w === 0 ? 'won' : 'lost'}:${p.reason}/${p.rally}`).join(', ')}), faults ${r.faults.length}`);
  L.push(`serves: raised ${r.coach.raises}×, tosses the game took ${r.coach.serves}, toss events ${r.tosses}, serves hit ${serves.length}`);
  L.push(`rally balls coming to me ${r.coach.strokes}, hit ${ground.length} (${pct(ground.length, r.coach.strokes)}), timing messages ${JSON.stringify(count(r.timing))}`);
  if (ground.length) L.push(`hit timing tau ${ground.map((h) => f1(h.tau, 2)).join(' ')} (0 = perfect, ±1 = one timing window), quality q ${ground.map((h) => f1(h.q, 2)).join(' ')}`);
  // Swing timing as the game judged it: tEff − planned contact, for the swing nearest each planned stroke.
  const dts = r.coach.plans.map((p) => { const s = r.swings.filter((w) => w.tEff != null).sort((a, b) => Math.abs(a.tEff - p.planT) - Math.abs(b.tEff - p.planT))[0]; return s ? s.tEff - p.planT : NaN; }).filter(Number.isFinite);
  const lat = r.coach.plans.map((p) => { const s = r.swings.filter((w) => w.dir === p.stroke).sort((a, b) => Math.abs(a.t0 - p.aimT) - Math.abs(b.t0 - p.aimT))[0]; return s ? s.t0 - p.aimT : NaN; }).filter(Number.isFinite);
  L.push(`swings reported ${r.swings.length} (${JSON.stringify(count(r.swings.map((s) => s.dir || 'up/down')))}); tEff − planned contact ${msr(mean(dts))} ± ${msr(sd(dts))} ms (n ${dts.length}); t0 − true peak ${msr(mean(lat))} ± ${msr(sd(lat))} ms`);
  if (r.errs) L.push(`live camera: ${r.camFrames} frames in ${f1(r.camSecs)} s (${f1(r.camFrames / r.camSecs)} fps, draw ${f1(q(r.drawMs, 0.5))} ms), tracker saw ${r.seen}, found the paddle in ${pct(r.found, r.seen)}, error median ${f1(q(r.errs, 0.5), 3)} p90 ${f1(q(r.errs, 0.9), 3)} frame widths`);
  return L.join('\n');
}
