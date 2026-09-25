import { clamp, Clock, Settings } from './core.js';
import { Sound } from './match.js';
import { canvas } from './render/world.js';
import { Game } from './game.js';
import { UI } from './ui.js';
import { SwingDetector, pickHand, palmSize, PALM_REF, segmentColor, lockColorFromPatch, adaptColor } from './camswing.js';
import { racketLabel, palmCentre, PalmScale, HandPicker } from './camswing.js';

// =====================================================================
// INPUT: swings from hand tracking, paddle color tracking, mouse or keyboard
// =====================================================================
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const TOSS_LINE = 0.24;          // hand above this fraction of the frame height tosses the ball
const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

// Swing times now come from when the camera captured the frame (they used to be when the page got it, about 30-50 ms
// later) and mark the peak of the swing rather than its start, so saved timing offsets move over once.
if (Settings.camTiming !== 2) {
  Settings.latency = clamp(Math.round(((Number.isFinite(+Settings.latency) ? +Settings.latency : 0.09) - 0.05) * 100) / 100, -0.1, 0.25);
  Settings.camTiming = 2;
  Settings.save();
}

// Positions are normalised to the mirrored camera image: x 0..1 left to right as the player sees it, y 0..1 top to bottom.
const Input = {
  x: 0.5, y: 0.5, valid: false, vx: 0, vy: 0, speed: 0, hist: [], handlers: [], lastFeed: 0, tossHeld: false,
  det: new SwingDetector({ tossLine: TOSS_LINE }),   // camera swings (see camswing.js)
  // The camera swing in progress. The game clears it, and the pause after the last one, when the ball is tossed.
  get swing() { return this.det.active; },
  set swing(v) { if (!v) this.det.cancel(); },
  get lastEnd() { return this.det.ended ? this.det.ended.t : -9; },
  set lastEnd(v) { if (v < 0) this.det.ended = null; },
  on(fn) { this.handlers.push(fn); },
  emit(ev) { for (const h of this.handlers) h(ev); },
  // A position at game time t: the mouse pointer, or a camera frame's hand / paddle (o: {aspect, scale}).
  feed(t, x, y, src, o) {
    this.lastFeed = t;
    if (src === 'mouse') {
      this.x = x; this.y = y; this.valid = true;
      const h = this.hist;
      h.push({ t, x, y });
      while (h.length > 2 && t - h[0].t > 0.1) h.shift();
      if (h.length >= 2) { const a = h[0], dt = t - a.t; if (dt > 0.012) { this.vx = (x - a.x) / dt; this.vy = (y - a.y) / dt; } }
      this.speed = Math.hypot(this.vx, this.vy);
      return;
    }
    const d = this.det, evs = d.push(t, x, y, { sens: Settings.sens, handed: Settings.handed, src, aspect: o && o.aspect, scale: o && o.scale });
    this.x = d.x; this.y = d.y; this.valid = d.valid; this.vx = d.vx; this.vy = d.vy; this.speed = d.speed;
    const lag = Math.max(0, Clock.now() - t);   // camera frame to here
    if (this.tossHeld && this.y > TOSS_LINE + 0.1) this.tossHeld = false;   // the hand came down: that raise is over
    for (const ev of evs) {
      if (ev.type === 'swing') ev.swing.lag = lag;
      else if (ev.type === 'toss') this.tossHeld = true;   // the game uses it now, or as soon as the serve may start
      this.emit(ev);
    }
  },
  // Each camera tracker's usual stroke speed, learned from the swings that hit the ball (and kept between sessions),
  // so power means the same for a small hand swing far from the camera and a big paddle swing close to it.
  typ: { hand: [], paddle: [], handServe: [], paddleServe: [] },
  learn(sw) {
    const k = sw.src + (sw.serve ? 'Serve' : ''), a = this.typ[k];
    if (!a || sw.learned || !(sw.peak > 0)) return;
    sw.learned = true;
    a.push(sw.peak);
    if (a.length > 12) a.shift();
    Settings.swingTyp = { ...(Settings.swingTyp || {}), [k]: +this.typical(k).toFixed(3) };
    Settings.save();
  },
  // Median of the recent strokes (a remembered value counts as three of them); 0 until there's enough to go on.
  typical(k) {
    const a = this.typ[k], saved = Settings.swingTyp && +Settings.swingTyp[k];
    if (!a) return 0;
    const all = saved > 0 && a.length < 12 ? a.concat([saved, saved, saved]) : a.slice();
    if (all.length < 3) return 0;
    all.sort((p, q) => p - q);
    return all[all.length >> 1];
  },
  // A camera frame at game time t without the hand / paddle in it. Short gaps (motion blur) are bridged.
  miss(t) {
    const evs = this.det.miss(t);
    if (!this.det.valid) { this.valid = false; this.vx = this.vy = this.speed = 0; }
    for (const ev of evs) this.emit(ev);
  },
  lost() { this.valid = false; this.tossHeld = false; this.hist.length = 0; this.vx = this.vy = this.speed = 0; this.det.reset(); },
  press(power, spin, src = 'button') {
    const s = { t0: Clock.now(), peak: 0, power, spin, vx: 0, vy: 0, src, x: this.x, y: this.y };
    this.emit({ type: 'swing', swing: s });
  },
  // Phone racket: the phone detected the swing itself and sends the moment of peak racket speed in game time.
  phoneTime(tg, fallback) {
    const now = Clock.now(), t = Number.isFinite(+tg) ? +tg / 1000 : NaN;
    return Number.isFinite(t) && Math.abs(t - now) < 0.6 ? t : now - fallback;   // clock not synced yet: estimate
  },
  phoneSwing(m) {
    const s = {
      t0: this.phoneTime(m.tg, 0.04), peak: +m.peak || 0, power: clamp(+m.power || 0.5, 0.05, 1),
      spin: clamp(Number.isFinite(+m.spin) ? +m.spin : 0.3, -1, 1), dir: m.dir === 'fh' || m.dir === 'bh' ? m.dir : null,
      vx: 0, vy: 0, src: 'phone', x: 0.5, y: 0.5,
    };
    this.emit({ type: 'swing', swing: s });
  },
  phoneSwingStart(m) { this.emit({ type: 'swingStart', t0: this.phoneTime(m.tg, 0), dir: m.dir === 'fh' || m.dir === 'bh' ? m.dir : null, src: 'phone' }); },
};

// Motion swings: speed sets power, the vertical part of the swing sets spin.
// Camera power is mostly relative to this player's usual swing on this tracker (a normal swing is a solid drive, a
// third faster nearly flat out), so it doesn't depend on how far from the camera they stand or how big their swing is.
function swingPower(s) {
  if (s.power != null) return s.power;
  const abs = clamp((s.peak * Settings.sens - 1.1) / 2.9, 0.06, 1), typ = Input.typical(s.src + (s.serve ? 'Serve' : ''));
  return typ ? 0.3 * abs + 0.7 * clamp(0.6 + 0.8 * (s.peak / typ - 1), 0.08, 1) : abs;
}
// By the swing's angle: a flat swing hits a drive, about 10° low-to-high is topspin, high-to-low is slice.
function swingSpin(s) {
  if (s.spin != null) return s.spin;
  return clamp(0.3 + Math.atan2(-s.vy, Math.abs(s.vx) + 1e-6) * 1.9, -1, 1);
}

// Runs inside a Web Worker (serialised with toString), so hand tracking never blocks the frame that draws the court.
// Where the browser allows it the camera's frames come straight here (a MediaStreamTrackProcessor stream), so a frame
// never waits for the page to draw one; otherwise the page posts ImageBitmaps. Only the newest frame is ever tracked.
function handWorkerMain() {
  let lm = null, lastTs = -1, feedId = 0, paused = false, clockOff = 0, seen = 0;
  const post = (m, tr) => self.postMessage(m, tr || []);
  const msg = (err) => String((err && err.message) || err);
  // Every step of starting up has a time limit: a GPU that never finishes setting up must not hang the tracker.
  const within = (p, ms, what) => new Promise((ok, no) => {
    const id = setTimeout(() => no(new Error(`${what} took too long`)), ms);
    p.then((v) => { clearTimeout(id); ok(v); }, (err) => { clearTimeout(id); no(err); });
  });
  // Downloads report progress, which also tells the page nothing is stuck on a slow connection.
  async function download(url, f0, share) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Couldn’t download the hand tracker (HTTP ${r.status})`);
    const len = +r.headers.get('content-length') || 0;
    if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
    const rd = r.body.getReader(), parts = [];
    let n = 0, tp = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      parts.push(value); n += value.length;
      if (performance.now() - tp > 250) { tp = performance.now(); post({ type: 'progress', stage: 'download', frac: f0 + share * (len ? Math.min(0.99, n / len) : 0.5) }); }
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function init(m) {
    clockOff = performance.timeOrigin - m.origin;   // worker clock → page clock
    post({ type: 'progress', stage: 'download', frac: 0 });
    importScripts(m.base + '/vision_bundle.js');
    const V = self.Vision, files = await V.FilesetResolver.forVisionTasks(m.base + '/wasm');
    const wasm = await download(files.wasmBinaryPath, 0, 0.6), model = await download(m.model, 0.6, 0.4);
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    const fileset = { ...files, wasmBinaryPath: wasmUrl }, errs = [];
    for (const d of m.delegates) {
      post({ type: 'progress', stage: 'start', delegate: d });
      const t0 = performance.now();
      const made = V.HandLandmarker.createFromOptions(fileset, { ...m.opts, baseOptions: { modelAssetBuffer: model, delegate: d } });
      try {
        lm = await within(made, m.wait[d] || 20000, `Starting the hand tracker on the ${d}`);
        // One throwaway frame now: the first one is slow (the GPU compiles its shaders), better here than mid-swing.
        const bmp = await createImageBitmap(new ImageData(320, 240));
        lm.detectForVideo(bmp, 1); bmp.close(); lastTs = 1;
        URL.revokeObjectURL(wasmUrl);
        post({ type: 'ready', delegate: d, ms: performance.now() - t0, errors: errs });
        return;
      } catch (err) {
        errs.push(`${d}: ${msg(err)}`);
        made.then((x) => { if (x !== lm) try { x.close(); } catch (e2) { /* gone */ } }, () => {});   // finished too late
        if (lm) { try { lm.close(); } catch (e2) { /* gone */ } lm = null; }
      }
    }
    throw new Error(errs.join(' · '));
  }
  // Track one image. t: the page-clock time the result is reported under; ts: the frame's own timestamp (ms).
  function track(img, t, ts, extra) {
    const out = { type: 'result', t, landmarks: [], handedness: [], ms: 0, seen, ...extra }, t0 = performance.now();
    try {
      lastTs = Math.max(Math.round(ts), lastTs + 1);   // video mode needs strictly increasing timestamps
      const res = lm.detectForVideo(img, lastTs);
      out.landmarks = res.landmarks || [];
      out.handedness = (res.handedness || res.handednesses || []).map((h) => (h && h[0] ? { label: h[0].categoryName, score: h[0].score } : { label: '', score: 0 }));
    } catch (err) { out.error = msg(err); }
    out.ms = performance.now() - t0;
    post(out);
    return !out.error;
  }
  // Frames straight from the camera. The stream holds only the newest frame, so after each result the next read is the
  // latest picture (the tracker never works through a backlog).
  async function pump(readable, id) {
    const rd = readable.getReader();
    let fails = 0;
    try {
      for (;;) {
        const { value: f, done } = await rd.read();
        if (done) break;
        if (id !== feedId) { f.close(); break; }
        seen++;
        if (paused || !lm) { f.close(); continue; }
        const at = performance.now() + clockOff;
        const ok = track(f, at, f.timestamp / 1000, { src: 'stream', ts: f.timestamp, at });
        f.close();
        fails = ok ? 0 : fails + 1;
        if (fails > 8) throw new Error('The tracker can’t read camera frames directly');
      }
    } catch (err) { if (id === feedId) post({ type: 'feedError', message: msg(err) }); }
    try { await rd.cancel(); } catch (err) { /* closed */ }
  }
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') init(m).catch((err) => post({ type: 'error', message: msg(err) }));
    else if (m.type === 'stream') { seen = 0; pump(m.readable, ++feedId); }
    else if (m.type === 'endStream') feedId++;
    else if (m.type === 'pause') paused = !!m.on;
    else if (m.type === 'frame') {
      seen++;
      if (lm) track(m.bitmap, m.t, m.t, { src: 'frame' });
      else post({ type: 'result', t: m.t, landmarks: [], handedness: [], ms: 0, src: 'frame', error: 'not ready' });
      try { m.bitmap.close(); } catch (err) { /* already closed */ }
    } else if (m.type === 'options' && lm) {
      lm.setOptions(m.opts).then(() => post({ type: 'options', ok: true }), (err) => post({ type: 'options', ok: false, message: msg(err) }));
    }
  };
}

// Hand tracker settings, and how long each way of running it may take to start (ms) before the next is tried.
const HAND_OPTS = { runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.4 };
const HAND_WAIT = { GPU: 15000, CPU: 25000, download: 30000 };
const handLabels = (res) => (res.handedness || res.handednesses || []).map((h) => (h && h[0] ? { label: h[0].categoryName, score: h[0].score } : { label: '', score: 0 }));
const timeLimit = (p, ms, what) => new Promise((ok, no) => {
  const id = setTimeout(() => no(new Error(`${what} took too long.`)), ms);
  p.then((v) => { clearTimeout(id); ok(v); }, (e) => { clearTimeout(id); no(e); });
});

const Tracker = {
  video: document.getElementById('video'),
  overlay: document.getElementById('camOverlay'),
  status: document.getElementById('camStatus'),
  wrap: document.getElementById('camWrap'),
  stream: null, kind: null, running: false, gen: 0, camGen: 0, loopGen: 0, opening: null,
  worker: null, workerState: 'none', workerLoading: null, inFlight: false, sentAt: 0, stalls: 0, next: null, feed: null, noFeed: false,
  landmarker: null, loading: null, lastMain: 0, lastTs: 0, lastVT: -1, delegate: '', where: '', loadError: '', startMs: 0, readyAt: 0,
  procMs: 0, lagMs: 0, rate: 0, rateN: 0, rateT: 0, stamp: '', aspect: 4 / 3, tsOffs: [], tsOff: NaN, arrOff: Infinity,
  palm: 0, scale: 1, offHand: 0, trail: [], picker: new HandPicker(), palmScale: new PalmScale(),
  st: { t: 0, res: 0, found: 0, cam: 0, seen: 0, errors: 0, errRun: 0, lastRes: 0 }, per: { rate: 0, cam: 0, found: 0, dropped: 0 },
  work: null, workCtx: null, ctxO: null, blobN: 0, seg: {}, segW: 160, segH: 120, paddleTg: null, paddleFor: null, maskCanvas: null, maskImg: null,
  handsReady() { return this.workerState === 'ready' || !!this.landmarker; },
  // Starting again (or stop()) while an earlier start is still waiting for the camera or the tracker supersedes it:
  // the earlier call then returns quietly instead of switching things back on.
  async start(kind) {
    const gen = ++this.gen;
    this.kind = kind;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This page can’t use the camera. Open it from https:// or http://localhost.');
    await this.openCamera(gen);
    if (gen !== this.gen) return;
    this.wrap.hidden = false;
    if (kind === 'hand') { await this.ensureHands(); if (gen !== this.gen) return; }
    else this.endFeed();
    this.inFlight = false; this.dropNext(); this.trail.length = 0; this.resetHand();
    Input.lost();
    if (kind === 'hand') this.startFeed();
    if (!this.running) { this.running = true; this.loop(); }
    this.setStatus(kind === 'hand' ? 'Show your hand' : Settings.paddle ? 'Tracking paddle' : 'Lock your paddle color');
  },
  // One camera at a time, even when start() runs again while the browser is still asking for permission.
  async openCamera(gen) {
    for (let k = 0; k < 3 && !this.stream && gen === this.gen; k++) {
      if (!this.opening) { const p = this.getCamera(); this.opening = p; p.catch(() => {}).then(() => { if (this.opening === p) this.opening = null; }); }
      await this.opening;
    }
  },
  async getCamera() {
    const cg = this.camGen;
    this.setStatus('Starting camera…');
    // 60 fps where the camera can: fresher frames and less motion blur. Most webcams give 30, which is fine.
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, max: 60 }, facingMode: 'user' }, audio: false });
    if (cg !== this.camGen) { for (const t of s.getTracks()) t.stop(); return; }   // stopped while the browser was asking
    this.stream = s;
    const track = s.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { if (this.stream === s) this.setStatus('The camera stopped. Check its cable, or whether another app took it.'); });
    this.video.srcObject = s;
    try { await this.video.play(); }
    catch (e) {
      if (this.stream !== s) return;   // stopped meanwhile
      for (const t of s.getTracks()) t.stop();
      this.stream = null; this.video.srcObject = null;
      throw e;
    }
    this.aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    this.wrap.style.aspectRatio = String(this.aspect);
  },
  async ensureHands() {
    if (this.handsReady()) return;
    this.setStatus('Loading hand tracker…');
    if (this.workerState !== 'failed') {
      try { await (this.workerLoading || (this.workerLoading = this.startWorker())); return; }
      catch (e) { console.warn('Background hand tracking unavailable, running it on the main thread instead.', e); this.workerState = 'failed'; this.loadError = e.message; }
      finally { this.workerLoading = null; }
    }
    if (!this.landmarker) {
      this.setStatus('Loading hand tracker…');
      try { this.landmarker = await (this.loading || (this.loading = this.loadHands())); }
      catch (e) { this.loadError = e.message; this.setStatus('Hand tracking couldn’t start.'); throw new Error(`Hand tracking couldn’t start (${e.message})`); }
      finally { this.loading = null; }
    }
    this.where = 'main thread';
  },
  // The worker reports each start-up step; if it goes quiet for too long, a step hung (a GPU driver can block the
  // worker outright, so its own time limits never fire): give up on it and let ensureHands() run the tracker here.
  startWorker() {
    return new Promise((resolve, reject) => {
      let w, url, timer = 0, done = false;
      const t0 = performance.now();
      try { url = URL.createObjectURL(new Blob([`(${handWorkerMain.toString()})();`], { type: 'text/javascript' })); w = new Worker(url); }
      catch (e) { reject(e); return; }
      this.workerState = 'loading';
      const fail = (err) => {
        if (done) return;
        done = true; clearTimeout(timer); URL.revokeObjectURL(url);
        try { w.terminate(); } catch (e) { /* gone */ }
        if (this.workerState === 'loading') this.workerState = 'none';
        reject(err);
      };
      const arm = (ms, what) => { clearTimeout(timer); timer = setTimeout(() => fail(new Error(`The hand tracker stopped responding while ${what}.`)), ms); };
      arm(HAND_WAIT.download, 'loading');
      w.onmessage = (e) => {
        const m = e.data;
        if (done) return;
        if (m.type === 'progress') {
          if (m.stage === 'download') { this.setStatus(`Loading hand tracker… ${Math.round(m.frac * 100)}%`); arm(HAND_WAIT.download, 'downloading'); }
          else { this.setStatus(m.delegate === 'GPU' ? 'Starting hand tracker…' : 'Starting hand tracker (without the graphics chip)…'); arm((HAND_WAIT[m.delegate] || 20000) + 8000, 'starting'); }
        } else if (m.type === 'ready') {
          done = true; clearTimeout(timer); URL.revokeObjectURL(url);
          this.worker = w; this.workerState = 'ready'; this.delegate = m.delegate; this.where = 'background thread';
          this.startMs = performance.now() - t0; this.readyAt = performance.now(); this.loadError = '';
          if (m.errors && m.errors.length) console.warn('Hand tracker:', m.errors.join(' · '));
          w.onmessage = (ev) => this.onWorker(ev.data);
          w.onerror = (ev) => { if (ev.preventDefault) ev.preventDefault(); this.recover(ev.message || 'worker error'); };
          resolve();
        } else if (m.type === 'error') fail(new Error(m.message));
      };
      w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); fail(new Error(e.message || 'The hand tracker worker failed.')); };
      w.postMessage({ type: 'init', base: MP_BASE, model: MP_MODEL, origin: performance.timeOrigin, opts: HAND_OPTS, delegates: ['GPU', 'CPU'], wait: HAND_WAIT });
    });
  },
  // The worker crashed, hung or keeps failing: start a fresh one (the model is cached by then), once per minute at most.
  recover(why) {
    if (this.workerState !== 'ready') return;
    console.warn('Hand tracker restarting:', why);
    const again = performance.now() - (this.recoveredAt || -1e9) > 60000;
    this.recoveredAt = performance.now();
    try { this.worker.terminate(); } catch (e) { /* gone */ }
    this.worker = null; this.workerState = again ? 'none' : 'failed'; this.feed = null; this.inFlight = false; this.dropNext();
    this.st.errRun = 0;
    if (!this.running || this.kind !== 'hand') return;
    this.setStatus('Restarting hand tracker…');
    const gen = this.gen;
    this.ensureHands().then(() => { if (gen === this.gen && this.running && this.kind === 'hand') { this.startFeed(); this.setStatus('Show your hand'); } },
      (e) => { console.warn(e); this.setStatus('Hand tracking stopped. Switch Controls to Mouse, or reload the page.'); });
  },
  // Camera frames straight to the worker (Chrome, Edge): a frame is tracked as soon as it arrives, even while this
  // thread is busy drawing the court.
  startFeed() {
    if (this.feed || this.noFeed || this.workerState !== 'ready' || !this.stream || typeof MediaStreamTrackProcessor !== 'function') return false;
    let track = null;
    try {
      track = this.stream.getVideoTracks()[0].clone();
      const p = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      this.worker.postMessage({ type: 'stream', readable: p.readable }, [p.readable]);
      this.feed = { track, t: performance.now() };
      this.st.seen = 0;
      return true;
    } catch (e) {
      console.warn('Camera frames can’t go straight to the hand tracker; sending them from the page.', e);
      if (track) track.stop();
      this.noFeed = true;
      return false;
    }
  },
  endFeed() {
    if (!this.feed) return;
    if (this.worker) this.worker.postMessage({ type: 'endStream' });
    this.feed.track.stop();
    this.feed = null;
  },
  dropNext() { if (this.next) { try { this.next.bmp.close(); } catch (e) { /* closed */ } this.next = null; } },
  resetHand() { this.picker.reset(); this.palmScale.reset(); this.palm = 0; this.scale = 1; },
  onWorker(m) {
    if (!m) return;
    if (m.type === 'feedError') {
      console.warn('hand tracker:', m.message, '- sending it frames from the page instead.');
      this.noFeed = true; this.endFeed();
      return;
    }
    if (m.type !== 'result') return;
    if (m.src === 'frame') {
      this.inFlight = false;
      const n = this.next;
      this.next = null;
      if (n) { if (this.running && this.kind === 'hand' && !this.feed && this.worker) this.postFrame(n.bmp, n.t); else n.bmp.close(); }
    } else if (!this.feed) return;   // from a camera feed that was just closed
    const st = this.st;
    st.lastRes = performance.now();
    this.procMs = this.procMs ? this.procMs * 0.9 + m.ms * 0.1 : m.ms;
    if (m.error) {
      st.errors++;
      if (++st.errRun === 1 || st.errRun % 100 === 0) console.warn('hand tracker:', m.error);
      if (st.errRun > 30) this.recover(m.error);
      return;
    }
    st.errRun = 0;
    if (m.src === 'stream') st.cam += Math.max(0, m.seen - st.seen), st.seen = m.seen;
    const tCap = m.src === 'stream' ? this.streamTime(m.ts / 1000, m.at) : m.t;
    this.noteLag(tCap);
    if (!this.running || this.kind !== 'hand') return;
    this.handleHands(m.landmarks || [], m.handedness || [], tCap);
  },
  // Capture time (page clock) of a frame the worker read from the camera itself. Its timestamp runs on the camera
  // stream's clock; the video element's frame callbacks report both clocks for the same frame, which gives the offset.
  // Until they have, or if that looks wrong: the earliest the frame could have arrived, less the usual delay.
  streamTime(ts, at) {
    this.arrOff = Math.min(this.arrOff + 0.02, at - ts);
    const est = ts + this.arrOff - 30;
    if (Number.isFinite(this.tsOff)) {
      const t = ts + this.tsOff;
      if (t <= at + 2 && at - t < 400) { this.stamp = 'camera'; return t; }
    }
    this.stamp = 'arrival';
    return est;
  },
  async loadHands() {
    const vision = await timeLimit(import(`${MP_BASE}/vision_bundle.mjs`), HAND_WAIT.download * 2, 'Loading the hand tracker');
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const make = (delegate) => timeLimit(vision.HandLandmarker.createFromOptions(fileset, { ...HAND_OPTS, baseOptions: { modelAssetPath: MP_MODEL, delegate } }), HAND_WAIT[delegate] + HAND_WAIT.download, `Starting the hand tracker on the ${delegate}`);
    try { const lm = await make('GPU'); this.delegate = 'GPU'; return lm; }
    catch (e) { console.warn('GPU hand tracking failed, using CPU', e); this.delegate = 'CPU'; return await make('CPU'); }
  },
  stop() {
    this.gen++; this.camGen++;
    this.running = false; this.inFlight = false; this.opening = null;
    this.endFeed(); this.dropNext();
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    this.video.srcObject = null;
    this.wrap.hidden = true;
    this.trail.length = 0;
    Input.lost();
  },
  setStatus(s) { this.status.textContent = s; },
  // One frame loop at a time: a stop() and start() in quick succession must not leave two running.
  loop() {
    const v = this.video, id = ++this.loopGen, rvfc = !!v.requestVideoFrameCallback;
    const step = (now, meta) => {
      if (!this.running || id !== this.loopGen) return;
      try { this.process(this.frameTime(meta)); } catch (e) { console.warn(e); }
      if (rvfc) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    if (rvfc) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  },
  // When the frame was captured, on the performance.now() clock: the camera's own timestamp when the browser gives
  // one, otherwise when the frame reached the page less the usual delay before that.
  frameTime(meta) {
    const p = performance.now(), ok = (t) => Number.isFinite(t) && t <= p + 1 && p - t < 400;
    if (meta && ok(meta.captureTime)) {
      // The same frame on the stream's own clock: calibrates frames the hand tracker reads straight from the camera.
      if (Number.isFinite(meta.mediaTime) && meta.mediaTime > 0) {
        const o = this.tsOffs;
        o.push(meta.captureTime - meta.mediaTime * 1000);
        if (o.length > 31) o.shift();
        if (o.length >= 5) this.tsOff = o.slice().sort((a, b) => a - b)[o.length >> 1];
      }
      this.stamp = 'camera'; return meta.captureTime;
    }
    this.stamp = 'arrival';
    return (meta && ok(meta.presentationTime) ? meta.presentationTime : p) - 30;
  },
  noteLag(tCap) { const l = performance.now() - tCap; this.lagMs = this.lagMs ? this.lagMs * 0.9 + l * 0.1 : l; },
  process(tCap) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    if (!v.requestVideoFrameCallback) { if (v.currentTime === this.lastVT) return; this.lastVT = v.currentTime; }   // same frame again
    this.aspect = v.videoWidth / v.videoHeight;
    if (this.kind === 'hand') {
      if (this.feed) { this.watchFeed(); return; }   // the worker reads the camera itself
      this.st.cam++;
      if (this.workerState === 'ready') this.sendFrame(v, tCap);
      else if (this.landmarker && tCap - this.lastMain > 30) {
        this.lastMain = tCap;
        const ts = Math.max(Math.round(tCap), this.lastTs + 1), t0 = performance.now();
        this.lastTs = ts;
        let res;
        try { res = this.landmarker.detectForVideo(v, ts); } catch (e) { this.st.errors++; if (this.st.errors % 100 === 1) console.warn('hand tracker:', e); return; }
        this.procMs = performance.now() - t0;
        this.noteLag(tCap);
        this.handleHands(res.landmarks || [], handLabels(res), tCap);
      }
    } else if (this.kind === 'paddle') {
      const pt = this.trackColor(tCap);
      this.noteLag(tCap);
      this.handlePoint(pt, null, tCap);
    }
  },
  // Page-grabbed frames (no direct camera feed): never queue them. While the tracker is busy, the newest frame waits
  // and goes the moment the tracker is free, rather than the next camera frame after that.
  sendFrame(v, tCap) {
    const now = performance.now();
    if (this.inFlight && now - this.sentAt > Math.max(1000, 4 * this.procMs)) {   // it lost that frame
      this.stalls++; this.inFlight = false;
      if (now - Math.max(this.st.lastRes, this.readyAt) > 8000) { this.recover('no answer'); return; }   // or it hung
    }
    // Big camera pictures are shrunk first: the tracker works at 192-224 px anyway, and copying them costs.
    const o = v.videoWidth > 800 ? { resizeWidth: 640, resizeHeight: Math.round(640 / this.aspect), resizeQuality: 'medium' } : undefined;
    createImageBitmap(v, o).then((bmp) => {
      if (!this.running || !this.worker || this.kind !== 'hand' || this.feed) { bmp.close(); return; }
      if (!this.inFlight) { this.postFrame(bmp, tCap); return; }
      if (this.next && this.next.t > tCap) { bmp.close(); return; }
      if (this.next) this.next.bmp.close();
      this.next = { bmp, t: tCap };
    }, () => {});
  },
  postFrame(bmp, t) {
    this.inFlight = true; this.sentAt = performance.now();
    this.worker.postMessage({ type: 'frame', bitmap: bmp, t }, [bmp]);
  },
  // The direct feed went quiet (no result for 2.5 s while the camera runs): fall back to page-grabbed frames.
  watchFeed() {
    const now = performance.now(), last = Math.max(this.st.lastRes, this.feed.t);
    if (now - last < Math.max(2500, 5 * this.procMs)) return;
    console.warn('The hand tracker’s camera feed stalled; sending it frames from the page instead.');
    this.stalls++; this.noFeed = true; this.endFeed();
  },
  handleHands(hands, labels, tCap) {
    const cands = hands.map((lm, i) => { const l = labels[i]; return { ...palmCentre(lm), label: (l && l.label) || (typeof l === 'string' ? l : ''), score: l && l.score }; });
    const t = Clock.fromPerf(tCap / 1000);
    const { i, switched } = this.picker.pick(cands, Settings.handed, Input.det.predict(t), !!Input.swing || Input.speed > 1.2);
    if (switched) Input.lost();   // now following the other hand: start its track afresh rather than read the jump as a swing
    let pt = null, lms = null;
    if (i >= 0) {
      pt = cands[i]; lms = hands[i];
      // The palm's size in the picture sets the speed scale, so a swing counts the same near or far from the camera.
      this.palm = this.palmScale.push(t, palmSize(lms, this.aspect), Input.swing ? 99 : Input.speed);
      this.scale = this.palmScale.scale;
      if (pt.label) this.offHand += ((pt.label === racketLabel(Settings.handed) ? 0 : 1) - this.offHand) * 0.02;
    }
    this.tally(i >= 0);
    this.handlePoint(pt, lms, tCap);
  },
  // Tracking health over the last second, for stats().
  tally(found) {
    const s = this.st, now = performance.now();
    s.res++; if (found) s.found++;
    if (!s.t) { s.t = now; s.res = s.found = s.cam = 0; return; }
    const dt = (now - s.t) / 1000;
    if (dt < 1) return;
    const p = this.per;
    p.rate = s.res / dt; p.cam = s.cam / dt; p.found = s.res ? s.found / s.res : 0; p.dropped = Math.max(0, s.cam - s.res) / dt;
    s.t = now; s.res = s.found = s.cam = 0;
  },
  handlePoint(pt, lms, tCap) {
    const now = performance.now(), t = Clock.fromPerf(tCap / 1000);
    this.rateN++;
    if (now - this.rateT > 1000) { this.rate = (this.rateN * 1000) / (now - this.rateT); this.rateN = 0; this.rateT = now; }
    if (pt) Input.feed(t, pt.x, pt.y, this.kind, { aspect: this.aspect, scale: this.kind === 'hand' ? this.scale : 1 });
    else Input.miss(t);
    const tr = this.trail;
    if (pt) tr.push({ x: pt.x, y: pt.y, t: now, sw: !!Input.swing });
    while (tr.length && now - tr[0].t > 450) tr.shift();
    this.draw(pt, lms);
  },
  info() {
    if (!this.stream) return 'Camera off';
    const hand = this.kind === 'hand';
    const where = hand ? `${this.delegate || '…'} · ${this.where || 'loading'}${this.feed ? ' (direct)' : ''}` : 'color tracking';
    return `${where} · ${Math.round(this.rate)} fps${this.procMs ? ` · ${Math.round(this.procMs)} ms per frame` : ''}` +
      `${this.lagMs ? ` · ${Math.round(this.lagMs)} ms behind${this.stamp === 'camera' ? '' : ' (est.)'}` : ''}` +
      `${hand && this.per.cam ? ` · hand found ${Math.round(this.per.found * 100)}%` : ''}`;
  },
  // The same as numbers, for the camera check. rate: frames tracked per second; camFps: camera frames per second;
  // dropped: camera frames per second the tracker had no time for; found: share of tracked frames with the racket
  // hand in them; procMs: tracker time per frame; lagMs: capture to result; stalls: frames the tracker never answered.
  stats() {
    const hand = this.kind === 'hand', p = this.per;
    const state = !this.stream ? 'off' : !hand ? 'color' : this.handsReady() ? 'ready' : this.loadError && this.workerState === 'failed' && !this.loading ? 'failed' : 'loading';
    return {
      state, kind: this.kind, delegate: hand ? this.delegate : '', where: hand ? this.where : '', direct: !!this.feed,
      rate: this.rate, camFps: hand ? p.cam : this.rate, dropped: hand ? p.dropped : 0, found: hand ? p.found : NaN,
      procMs: this.procMs, lagMs: this.lagMs, stamp: this.stamp, stalls: this.stalls, errors: this.st.errors,
      startMs: this.startMs, numHands: HAND_OPTS.numHands, palm: this.palm, scale: this.scale, status: this.status.textContent, error: this.loadError,
    };
  },
  ensureWork(W, H) {
    if (!this.work) { this.work = document.createElement('canvas'); this.workCtx = null; }
    if (this.work.width !== W || this.work.height !== H || !this.workCtx) {
      this.work.width = W; this.work.height = H;
      this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    }
    return this.workCtx;
  },
  workSize() { return [160, Math.max(60, Math.min(160, Math.round(160 / this.aspect)))]; },
  trackColor(tCap) {
    const lock = Settings.paddle;
    if (!lock) return null;
    const tol = lock.tol || 16;
    if (this.paddleFor !== lock) { this.paddleFor = lock; this.paddleTg = { h: lock.h, s: lock.s, v: lock.v, tol }; }
    const [W, H] = this.workSize(), c = this.ensureWork(W, H);
    c.drawImage(this.video, 0, 0, W, H);
    const px = c.getImageData(0, 0, W, H).data;
    // Where the paddle should be: paler, darker pixels of its color count there too (a motion-blurred paddle).
    const pr = Input.det.predict(Clock.fromPerf(tCap / 1000));
    const pred = pr && pr.age < 0.25 ? { x: pr.x, y: pr.y, r: 0.08 + Math.min(0.2, Input.speed * 0.03) } : null;
    const b = segmentColor(px, W, H, this.paddleTg, { pred, scratch: this.seg });
    this.segW = W; this.segH = H; this.blobN = b ? b.n : 0;
    // Follow the room's lighting while the paddle is held fairly still.
    if (b && b.strict >= 20 && !Input.swing) this.paddleTg = adaptColor(this.paddleTg, { ...lock, tol }, b);
    return b ? { x: b.x, y: b.y } : null;
  },
  lockColor() {
    if (!this.stream) return false;
    const [W, H] = this.workSize(), c = this.ensureWork(W, H);
    c.drawImage(this.video, 0, 0, W, H);
    const col = lockColorFromPatch(c.getImageData(Math.round(W / 2 - 10), Math.round(H / 2 - 10), 20, 20).data);
    if (!col) return false;
    Settings.paddle = col;
    Settings.save();
    Input.lost();
    return true;
  },
  draw(pt, lms) {
    const o = this.overlay, W = o.clientWidth, H = o.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), big = this.wrap.classList.contains('big');
    if (o.width !== Math.round(W * dpr) || o.height !== Math.round(H * dpr)) { o.width = Math.round(W * dpr); o.height = Math.round(H * dpr); }
    const c = this.ctxO || (this.ctxO = o.getContext('2d'));
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (big && this.guide === 'frame') this.drawGuide(c, W, H);
    // Camera check: tint what matches the paddle color (yellow: the paddle, red: anything else that matches). While
    // locking (the camera check sets preview) it shows what the color in the circle would match instead.
    if (big && this.kind === 'paddle') {
      if (this.preview) {
        const now = performance.now();
        if (!this.lockPrev || now - this.lockPrev.at > 120) this.previewLock(now);
        const p = this.lockPrev;
        if (p.col) this.drawMask(c, W, H, p.seg, p.w, p.h);
      } else if (Settings.paddle && this.seg.mask) this.drawMask(c, W, H);
    }
    c.strokeStyle = 'rgba(214,240,74,0.5)'; c.lineWidth = 1; c.setLineDash([5, 5]);
    c.beginPath(); c.moveTo(0, H * TOSS_LINE); c.lineTo(W, H * TOSS_LINE); c.stroke(); c.setLineDash([]);
    c.fillStyle = 'rgba(214,240,74,0.8)'; c.font = '600 10px Barlow, sans-serif'; c.fillText('TOSS LINE', 6, H * TOSS_LINE - 5);
    if (lms) {
      c.strokeStyle = 'rgba(242,245,238,0.75)'; c.lineWidth = 2;
      for (const [a, b] of HAND_BONES) { c.beginPath(); c.moveTo((1 - lms[a].x) * W, lms[a].y * H); c.lineTo((1 - lms[b].x) * W, lms[b].y * H); c.stroke(); }
    }
    if (this.kind === 'paddle') {
      const r = (W * 12) / 160, hot = big && (this.guide === 'lock' || this.preview);
      c.strokeStyle = hot || !Settings.paddle ? '#d6f04a' : 'rgba(242,245,238,0.35)'; c.lineWidth = hot ? 3 : 2;
      c.beginPath(); c.arc(W / 2, H / 2, r, 0, Math.PI * 2); c.stroke();
      if (hot) { c.fillStyle = 'rgba(214,240,74,0.95)'; c.font = '700 11px Barlow, sans-serif'; c.textAlign = 'center'; c.fillText('PADDLE FACE HERE', W / 2, H / 2 + r + 16); c.textAlign = 'start'; }
    }
    // The last half second of movement: red where it counted as a swing.
    const tr = this.trail;
    c.lineWidth = 3; c.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      c.strokeStyle = tr[i].sw ? 'rgba(255,122,98,0.85)' : 'rgba(214,240,74,0.35)';
      c.beginPath(); c.moveTo(tr[i - 1].x * W, tr[i - 1].y * H); c.lineTo(tr[i].x * W, tr[i].y * H); c.stroke();
    }
    const sw = Input.swing;
    if (pt) {
      c.fillStyle = sw ? '#ff7a62' : '#d6f04a';
      c.beginPath(); c.arc(pt.x * W, pt.y * H, sw ? 10 : 7, 0, Math.PI * 2); c.fill();
      if (sw && sw.dir && big) { c.fillStyle = '#f2f5ee'; c.font = '700 13px Barlow, sans-serif'; c.fillText(sw.dir === 'fh' ? 'FH' : 'BH', pt.x * W + 13, pt.y * H + 4); }
    }
  },
  // A segmentation mask (S: segmentColor's scratch, w × h, unmirrored) tinted over the picture. Also counts its pixels
  // into S.count ({ mine, other, k }: the tracked blob, everything else that matched, k = pixel scale vs 160×120).
  drawMask(c, W, H, S = this.seg, w = this.segW, h = this.segH) {
    const m = S.mask, lab = S.lab, best = S.best;
    if (!m || m.length !== w * h) return;
    const mc = this.maskCanvas || (this.maskCanvas = document.createElement('canvas'));
    if (mc.width !== w || mc.height !== h) { mc.width = w; mc.height = h; this.maskImg = null; }
    const mx = mc.getContext('2d'), img = this.maskImg || (this.maskImg = mx.createImageData(w, h)), d = img.data;
    let nMine = 0, nOther = 0;
    for (let p = 0, i = 0; p < m.length; p++, i += 4) {
      if (!m[p]) { d[i + 3] = 0; continue; }
      const mine = best && lab[p] === best;
      if (mine) nMine++; else nOther++;
      d[i] = mine ? 214 : 255; d[i + 1] = mine ? 240 : 122; d[i + 2] = mine ? 74 : 98; d[i + 3] = mine ? 150 : 120;
    }
    S.count = { mine: nMine, other: nOther, k: (w * h) / 19200 };
    mx.putImageData(img, 0, 0);
    c.save(); c.translate(W, 0); c.scale(-1, 1); c.imageSmoothingEnabled = false; c.drawImage(mc, 0, 0, W, H); c.restore();
  },
  // Camera check, before a lock: the color in the circle now (read the way lockColor reads it) and what it would match.
  previewLock(now) {
    const [W, H] = this.workSize(), c = this.ensureWork(W, H), p = this.lockPrev || (this.lockPrev = { seg: {} });
    c.drawImage(this.video, 0, 0, W, H);
    p.col = lockColorFromPatch(c.getImageData(Math.round(W / 2 - 10), Math.round(H / 2 - 10), 20, 20).data);
    p.w = W; p.h = H; p.at = now;
    if (p.col) segmentColor(c.getImageData(0, 0, W, H).data, W, H, { h: p.col.h, s: p.col.s, v: p.col.v, tol: p.col.tol || 16 }, { scratch: p.seg });
    else p.seg.count = null;
    return p;
  },
  // Camera check, framing step: a head-and-shoulders outline the size a player about 2 m from a typical webcam appears.
  drawGuide(c, W, H) {
    const u = Math.min(W, (H * 4) / 3), cx = W / 2, hr = u * 0.032, hy = H * 0.24, ny = hy + hr * 1.3, sy = ny + u * 0.028, sw = u * 0.082;
    c.save();
    c.strokeStyle = 'rgba(242,245,238,0.55)'; c.lineWidth = 2; c.setLineDash([6, 5]);
    c.beginPath(); c.ellipse(cx, hy, hr, hr * 1.3, 0, 0, Math.PI * 2); c.stroke();
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(cx + s * hr * 0.5, ny); c.lineTo(cx + s * hr * 0.55, sy);
      c.lineTo(cx + s * sw * 0.6, sy); c.quadraticCurveTo(cx + s * sw, sy, cx + s * sw, sy + hr * 0.9);
      c.lineTo(cx + s * sw * 0.97, H);
      c.stroke();
    }
    c.restore();
  },
};

// A hidden tab doesn't need its hand tracked (the direct camera feed would otherwise keep the tracker busy).
document.addEventListener('visibilitychange', () => { if (Tracker.worker) Tracker.worker.postMessage({ type: 'pause', on: document.hidden }); });

// Mouse: click (or tap) to swing. A flick just before the click adds power, an upward flick adds topspin.
addEventListener('pointermove', (e) => {
  if (Settings.control !== 'mouse') return;
  Input.feed(Clock.now(), e.clientX / innerWidth, e.clientY / innerHeight, 'mouse');
});
canvas.addEventListener('pointerdown', (e) => {
  Sound.init();
  if (Settings.control !== 'mouse' || !Game.inPlay()) return;
  Input.x = e.clientX / innerWidth;
  const m = Math.hypot(Input.vx, Input.vy) || 1;
  const power = clamp(0.38 + Input.speed * 0.14, 0.38, 1);
  const spin = Input.speed > 0.6 ? clamp(0.3 + (-Input.vy / m) * 1.1, -1, 1) : 0.35;
  Input.press(power, spin, 'mouse');
});
addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (e.code === 'Escape') { UI.togglePause(); return; }
  if (e.code === 'KeyC' && !e.repeat) { Settings.cam = Settings.cam === 'tv' ? 'player' : 'tv'; Settings.save(); return; }
  if (e.code === 'KeyF' && !e.repeat) { Settings.showFps = !Settings.showFps; Settings.save(); return; }
  if (!Game.inPlay() || e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); Sound.init(); Input.press(e.shiftKey ? 0.92 : 0.58, 0.4, 'key'); }
  else if (e.code === 'KeyS') { Sound.init(); Input.press(0.42, -0.85, 'key'); }
});

export { MP_BASE, MP_MODEL, TOSS_LINE, HAND_BONES, Input, swingPower, swingSpin, handWorkerMain, Tracker };
