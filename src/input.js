import { clamp, Clock, Settings } from './core.js';
import { Sound } from './match.js';
import { canvas } from './render/world.js';
import { Game } from './game.js';
import { UI } from './ui.js';
import { SwingDetector, pickHand, palmSize, PALM_REF, segmentColor, lockColorFromPatch, adaptColor } from './camswing.js';

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
  x: 0.5, y: 0.5, valid: false, vx: 0, vy: 0, speed: 0, hist: [], handlers: [], lastFeed: 0,
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
    for (const ev of evs) { if (ev.type === 'swing') ev.swing.lag = lag; this.emit(ev); }
  },
  // A camera frame at game time t without the hand / paddle in it. Short gaps (motion blur) are bridged.
  miss(t) {
    const evs = this.det.miss(t);
    if (!this.det.valid) { this.valid = false; this.vx = this.vy = this.speed = 0; }
    for (const ev of evs) this.emit(ev);
  },
  lost() { this.valid = false; this.hist.length = 0; this.vx = this.vy = this.speed = 0; this.det.reset(); },
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
function swingPower(s) { return s.power != null ? s.power : clamp((s.peak * Settings.sens - 1.1) / 2.9, 0.06, 1); }
function swingSpin(s) {
  if (s.spin != null) return s.spin;
  const m = Math.hypot(s.vx, s.vy) || 1;
  return clamp(0.3 + (-s.vy / m) * 1.2, -1, 1);
}

// Runs inside a Web Worker (serialised with toString), so hand tracking never blocks the frame that draws the court.
function handWorkerMain() {
  let lm = null, lastTs = -1;
  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'init') {
      try {
        importScripts(m.base + '/vision_bundle.js');
        const V = self.Vision;
        const fileset = await V.FilesetResolver.forVisionTasks(m.base + '/wasm');
        const opts = (delegate) => ({ baseOptions: { modelAssetPath: m.model, delegate: delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.4 });
        let delegate = 'GPU';
        try { lm = await V.HandLandmarker.createFromOptions(fileset, opts('GPU')); }
        catch (err) { delegate = 'CPU'; lm = await V.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
        // One throwaway frame now: the first one is slow (the GPU compiles its shaders), better here than mid-swing.
        try { const bmp = await createImageBitmap(new ImageData(320, 240)); lm.detectForVideo(bmp, 1); bmp.close(); lastTs = 1; } catch (err) { /* only a warm-up */ }
        self.postMessage({ type: 'ready', delegate: delegate });
      } catch (err) { self.postMessage({ type: 'error', message: String((err && err.message) || err) }); }
    } else if (m.type === 'frame') {
      const out = { type: 'result', t: m.t, landmarks: [], handedness: [], ms: 0 };
      const t0 = performance.now();
      try {
        const ts = Math.max(Math.round(m.t), lastTs + 1);   // video mode needs strictly increasing timestamps
        lastTs = ts;
        const res = lm.detectForVideo(m.bitmap, ts);
        out.landmarks = res.landmarks || [];
        out.handedness = (res.handedness || res.handednesses || []).map((h) => (h && h[0] ? h[0].categoryName : ''));
      } catch (err) { out.error = String((err && err.message) || err); }
      out.ms = performance.now() - t0;
      try { m.bitmap.close(); } catch (err) { /* already closed */ }
      self.postMessage(out);
    }
  };
}

const Tracker = {
  video: document.getElementById('video'),
  overlay: document.getElementById('camOverlay'),
  status: document.getElementById('camStatus'),
  wrap: document.getElementById('camWrap'),
  stream: null, kind: null, running: false,
  worker: null, workerState: 'none', workerLoading: null, inFlight: false, sentAt: 0, stalls: 0,
  landmarker: null, loading: null, lastMain: 0, lastTs: 0, lastVT: -1, delegate: '', where: '',
  procMs: 0, lagMs: 0, rate: 0, rateN: 0, rateT: 0, stamp: '', aspect: 4 / 3,
  palm: 0, scale: 1, offHand: 0, trail: [],
  work: null, workCtx: null, ctxO: null, blobN: 0, seg: {}, segW: 160, segH: 120, paddleTg: null, paddleFor: null, maskCanvas: null, maskImg: null,
  handsReady() { return this.workerState === 'ready' || !!this.landmarker; },
  async start(kind) {
    this.kind = kind;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This page can’t use the camera. Open it from https:// or http://localhost.');
    if (!this.stream) {
      this.setStatus('Starting camera…');
      // 60 fps where the camera can: fresher frames and less motion blur. Most webcams give 30, which is fine.
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, max: 60 }, facingMode: 'user' }, audio: false });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
      this.wrap.style.aspectRatio = String(this.aspect);
    }
    this.wrap.hidden = false;
    if (kind === 'hand') await this.ensureHands();
    this.inFlight = false; this.palm = 0; this.trail.length = 0;
    Input.lost();
    if (!this.running) { this.running = true; this.loop(); }
    this.setStatus(kind === 'hand' ? 'Show your hand' : Settings.paddle ? 'Tracking paddle' : 'Lock your paddle color');
  },
  async ensureHands() {
    if (this.handsReady()) return;
    this.setStatus('Loading hand tracker…');
    if (this.workerState !== 'failed') {
      try { await (this.workerLoading || (this.workerLoading = this.startWorker())); return; }
      catch (e) { console.warn('Background hand tracking unavailable, running it on the main thread instead.', e); this.workerState = 'failed'; }
    }
    this.landmarker = await (this.loading || (this.loading = this.loadHands()));
    this.where = 'main thread';
  },
  startWorker() {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(URL.createObjectURL(new Blob([`(${handWorkerMain.toString()})();`], { type: 'text/javascript' }))); }
      catch (e) { reject(e); return; }
      this.workerState = 'loading';
      let timer = 0;
      const fail = (err) => { clearTimeout(timer); try { w.terminate(); } catch (e) { /* gone */ } this.workerLoading = null; reject(err); };
      timer = setTimeout(() => fail(new Error('The hand tracker took too long to start.')), 60000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.worker = w; this.workerState = 'ready'; this.delegate = m.delegate; this.where = 'background thread';
          w.onmessage = (ev) => this.onWorker(ev.data);
          resolve();
        } else if (m.type === 'error') fail(new Error(m.message));
      };
      w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); fail(new Error(e.message || 'The hand tracker worker failed.')); };
      w.postMessage({ type: 'init', base: MP_BASE, model: MP_MODEL });
    });
  },
  onWorker(m) {
    if (!m || m.type !== 'result') return;
    this.inFlight = false;
    this.procMs = this.procMs ? this.procMs * 0.9 + m.ms * 0.1 : m.ms;
    this.noteLag(m.t);
    if (m.error) console.warn('hand tracker:', m.error);
    if (!this.running || this.kind !== 'hand') return;
    this.handleHands(m.landmarks || [], m.handedness || [], m.t);
  },
  async loadHands() {
    const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MP_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.4 });
    try { const lm = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); this.delegate = 'GPU'; return lm; }
    catch (e) { console.warn('GPU hand tracking failed, using CPU', e); this.delegate = 'CPU'; return await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
  },
  stop() {
    this.running = false; this.inFlight = false;
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    this.video.srcObject = null;
    this.wrap.hidden = true;
    this.trail.length = 0;
    Input.lost();
  },
  setStatus(s) { this.status.textContent = s; },
  loop() {
    const v = this.video;
    const step = (now, meta) => {
      if (!this.running) return;
      try { this.process(this.frameTime(meta)); } catch (e) { console.warn(e); }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  },
  // When the frame was captured, on the performance.now() clock: the camera's own timestamp when the browser gives
  // one, otherwise when the frame reached the page less the usual delay before that.
  frameTime(meta) {
    const p = performance.now(), ok = (t) => Number.isFinite(t) && t <= p + 1 && p - t < 400;
    if (meta && ok(meta.captureTime)) { this.stamp = 'camera'; return meta.captureTime; }
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
      if (this.workerState === 'ready') {
        // Never queue frames: while the tracker is busy, skip. If it hasn't answered in a second, it lost the frame.
        if (this.inFlight && performance.now() - this.sentAt < 1000) return;
        if (this.inFlight) this.stalls++;
        this.inFlight = true; this.sentAt = performance.now();
        createImageBitmap(v).then((bmp) => {
          if (!this.running || !this.worker) { bmp.close(); this.inFlight = false; return; }
          this.worker.postMessage({ type: 'frame', bitmap: bmp, t: tCap }, [bmp]);
        }, () => { this.inFlight = false; });
      } else if (this.landmarker && tCap - this.lastMain > 30) {
        this.lastMain = tCap;
        const ts = Math.max(Math.round(tCap), this.lastTs + 1), t0 = performance.now();
        this.lastTs = ts;
        const res = this.landmarker.detectForVideo(v, ts);
        this.procMs = performance.now() - t0;
        this.noteLag(tCap);
        this.handleHands(res.landmarks || [], (res.handedness || res.handednesses || []).map((h) => (h && h[0] ? h[0].categoryName : '')), tCap);
      }
    } else if (this.kind === 'paddle') {
      const pt = this.trackColor(tCap);
      this.noteLag(tCap);
      this.handlePoint(pt, null, tCap);
    }
  },
  handleHands(hands, labels, tCap) {
    const cands = hands.map((lm, i) => {
      let sx = 0, sy = 0;
      for (const k of [0, 5, 9, 13, 17]) { sx += lm[k].x; sy += lm[k].y; }
      return { x: 1 - sx / 5, y: sy / 5, label: labels[i] || '' };
    });
    const i = pickHand(cands, Settings.handed, Input.det.predict(Clock.fromPerf(tCap / 1000)));
    let pt = null, lms = null;
    if (i >= 0) {
      pt = cands[i]; lms = hands[i];
      // The palm's size in the picture sets the speed scale, so a swing counts the same near or far from the camera.
      // Tilted hands look smaller, so it grows quickly and shrinks slowly; blur distorts it, so not mid-swing.
      const ps = palmSize(lms, this.aspect);
      if (!this.palm) this.palm = ps;
      else if (!Input.swing) this.palm += (ps - this.palm) * (ps > this.palm ? 0.1 : 0.01);
      this.scale = clamp(PALM_REF / this.palm, 0.8, 1.5);
      if (pt.label) this.offHand += ((pt.label === (Settings.handed === 'L' ? 'Right' : 'Left') ? 0 : 1) - this.offHand) * 0.02;
    }
    this.handlePoint(pt, lms, tCap);
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
    const where = this.kind === 'hand' ? `${this.delegate || '…'} · ${this.where || 'loading'}` : 'color tracking';
    return `${where} · ${Math.round(this.rate)} fps${this.procMs ? ` · ${Math.round(this.procMs)} ms per frame` : ''}` +
      `${this.lagMs ? ` · ${Math.round(this.lagMs)} ms behind${this.stamp === 'camera' ? '' : ' (est.)'}` : ''}`;
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
    // Camera check: tint what matches the paddle color (yellow: the paddle, red: anything else that matches).
    if (big && this.kind === 'paddle' && Settings.paddle && this.seg.mask) this.drawMask(c, W, H);
    c.strokeStyle = 'rgba(214,240,74,0.5)'; c.lineWidth = 1; c.setLineDash([5, 5]);
    c.beginPath(); c.moveTo(0, H * TOSS_LINE); c.lineTo(W, H * TOSS_LINE); c.stroke(); c.setLineDash([]);
    c.fillStyle = 'rgba(214,240,74,0.8)'; c.font = '600 10px Barlow, sans-serif'; c.fillText('TOSS LINE', 6, H * TOSS_LINE - 5);
    if (lms) {
      c.strokeStyle = 'rgba(242,245,238,0.75)'; c.lineWidth = 2;
      for (const [a, b] of HAND_BONES) { c.beginPath(); c.moveTo((1 - lms[a].x) * W, lms[a].y * H); c.lineTo((1 - lms[b].x) * W, lms[b].y * H); c.stroke(); }
    }
    if (this.kind === 'paddle') {
      c.strokeStyle = Settings.paddle ? 'rgba(242,245,238,0.35)' : '#d6f04a'; c.lineWidth = 2;
      c.beginPath(); c.arc(W / 2, H / 2, (W * 12) / 160, 0, Math.PI * 2); c.stroke();
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
  drawMask(c, W, H) {
    const w = this.segW, h = this.segH, m = this.seg.mask, lab = this.seg.lab, best = this.seg.best;
    if (!m || m.length !== w * h) return;
    const mc = this.maskCanvas || (this.maskCanvas = document.createElement('canvas'));
    if (mc.width !== w || mc.height !== h) { mc.width = w; mc.height = h; this.maskImg = null; }
    const mx = mc.getContext('2d'), img = this.maskImg || (this.maskImg = mx.createImageData(w, h)), d = img.data;
    for (let p = 0, i = 0; p < m.length; p++, i += 4) {
      if (!m[p]) { d[i + 3] = 0; continue; }
      const mine = best && lab[p] === best;
      d[i] = mine ? 214 : 255; d[i + 1] = mine ? 240 : 122; d[i + 2] = mine ? 74 : 98; d[i + 3] = mine ? 150 : 120;
    }
    mx.putImageData(img, 0, 0);
    c.save(); c.translate(W, 0); c.scale(-1, 1); c.imageSmoothingEnabled = false; c.drawImage(mc, 0, 0, W, H); c.restore();
  },
};

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
