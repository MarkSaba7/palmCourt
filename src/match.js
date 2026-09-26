import { clamp, lerp, sstep, FORMATS, Clock, Settings } from './core.js';

// =====================================================================
// MATCH: scoring, umpire calls, sound
// =====================================================================
const PT_WORDS = ['Love', 'Fifteen', 'Thirty', 'Forty'];
const PT_SHOW = ['0', '15', '30', '40'];
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];
const numWord = (n) => NUM[n] ?? String(n);

class Match {
  constructor(fmtKey, firstServer) {
    const f = FORMATS[fmtKey];
    this.fmtKey = fmtKey; this.G = f.games; this.tbOnly = !!f.tbOnly;
    this.pts = [0, 0]; this.games = [0, 0]; this.tb = this.tbOnly;
    this.server = firstServer; this.tbFirst = firstServer; this.serveNo = 1;
    this.over = false; this.winner = -1;
    this.stats = { aces: [0, 0], df: [0, 0], winners: [0, 0], errors: [0, 0], points: [0, 0], longest: 0, fastest: [0, 0] };
  }
  toJSON() {
    return { pts: this.pts, games: this.games, tb: this.tb, server: this.server, tbFirst: this.tbFirst, serveNo: this.serveNo, over: this.over, winner: this.winner, stats: this.stats };
  }
  // The other machine's score (online). Only the score fields: a message from another version can't replace methods or the format.
  load(o) { const c = JSON.parse(JSON.stringify(o)); for (const k of ['pts', 'games', 'tb', 'server', 'tbFirst', 'serveNo', 'over', 'winner', 'stats']) if (k in c) this[k] = c[k]; }
  get pointsPlayed() { return this.pts[0] + this.pts[1]; }
  get court() { return this.pointsPlayed % 2 === 0 ? 'deuce' : 'ad'; }
  get currentServer() {
    if (!this.tb) return this.server;
    const n = this.pointsPlayed;
    if (n === 0) return this.tbFirst;
    return Math.floor((n - 1) / 2) % 2 === 0 ? 1 - this.tbFirst : this.tbFirst;
  }
  pointTo(p) {
    const o = 1 - p, ev = { p, game: false, match: false, tbStart: false };
    this.pts[p]++; this.serveNo = 1; this.stats.points[p]++;
    if (this.tb) {
      if (this.pts[p] >= 7 && this.pts[p] - this.pts[o] >= 2) { this.games[p]++; ev.game = ev.match = true; this.over = true; this.winner = p; }
    } else if (this.pts[p] >= 4 && this.pts[p] - this.pts[o] >= 2) {
      ev.game = true; this.games[p]++; this.pts = [0, 0]; this.server = 1 - this.server;
      const gp = this.games[p], go = this.games[o];
      if (gp >= this.G && gp - go >= 2) { ev.match = true; this.over = true; this.winner = p; }
      else if (gp === this.G && go === this.G) { this.tb = true; this.tbFirst = this.server; ev.tbStart = true; }
    }
    return ev;
  }
  pointLabels() {
    if (this.tb) return [String(this.pts[0]), String(this.pts[1])];
    const [a, b] = this.pts;
    if (a >= 3 && b >= 3) { if (a === b) return ['40', '40']; return a > b ? ['AD', ''] : ['', 'AD']; }
    return [PT_SHOW[Math.min(a, 3)], PT_SHOW[Math.min(b, 3)]];
  }
  scoreCall(names) {
    const s = this.currentServer, r = 1 - s, a = this.pts[s], b = this.pts[r];
    if (this.tb) {
      if (a === b) return `${numWord(a)} all`;
      return `${numWord(Math.max(a, b))}, ${numWord(Math.min(a, b))}, ${names[a > b ? s : r]}`;
    }
    if (a + b === 0) return '';
    if (a >= 3 && b >= 3) return a === b ? 'Deuce' : `Advantage, ${names[a > b ? s : r]}`;
    if (a === b) return `${PT_WORDS[a]} all`;
    return `${PT_WORDS[a]} ${PT_WORDS[b]}`;
  }
  gamesCall(names) {
    const [a, b] = this.games;
    if (a === b) return `${numWord(a)} ${a === 1 ? 'game' : 'games'} all`;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return `${names[a > b ? 0 : 1]} leads, ${numWord(hi)} ${hi === 1 ? 'game' : 'games'} to ${numWord(lo)}`;
  }
}

// =====================================================================
// SOUND: a televised-match mix, synthesized with Web Audio (no audio files).
// sfx (racket, ball, net, feet) and crowd buses share a stadium reverb and feed
// master volume -> glue compressor -> limiter -> soft clip, so nothing clips.
// The crowd's murmur, applause, cheers and "ooh" are rendered once into buffers
// (claps in JS, voices in an OfflineAudioContext) and replayed with envelopes.
// =====================================================================
const rnd = (a, b) => a + Math.random() * (b - a);
const jit = (x, amt) => x * (1 + (Math.random() * 2 - 1) * amt);
const fin = (x, d) => (Number.isFinite(x) ? x : d);
// Vowel formants F1-F3 (Hz) for the crowd's voices.
const VOWELS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2200, 2900], o: [520, 860, 2410], u: [330, 870, 2240], uh: [620, 1180, 2390], ae: [660, 1720, 2410] };
const VLIST = Object.values(VOWELS);

const Sound = {
  ctx: null, dead: false, master: null, out: null, crowd: null, verb: null, bedG: null, roomG: null, bedSrc: null,
  noise: null, grit: null, buf: {}, slots: new Float64Array(40), game: null,
  cam: { x: 0, y: 4, z: 22, rx: 1, ry: 0, rz: 0 }, P: { x: 0, y: 0, z: 0 },
  mood: -1, lastNow: 0, clapUntil: 0, clapSize: 0, oohUntil: 0, feet: [],
  BED: 0.2,     // murmur level between points (the bed buffer is levelled to RMS 0.1)
  ROOM: 0.024,  // stadium air under everything while a match is on

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || this.dead) return;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.noise = this.makeNoise(2);
      this.grit = this.makeGrit(1);
      this.build();
      this.makeCrowd();
    } catch (e) { console.warn('Audio unavailable:', e); this.ctx = null; this.dead = true; }
  },
  ok() { return !!this.ctx && this.ctx.state === 'running' && !!this.master; },
  t0() { return this.ctx.currentTime + 0.004; },
  volGain() { const v = clamp(fin(Settings.volume, 0.8), 0, 1); return 1.2 * v * v; },
  setVolume() { if (this.master) this.master.gain.setTargetAtTime(this.volGain(), this.ctx.currentTime, 0.03); },
  duck(k) { if (this.crowd) this.crowd.gain.setTargetAtTime(k, this.ctx.currentTime, 0.12); },

  // The mix: sfx and crowd buses, a shared stadium reverb, then the master chain.
  build() {
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volGain();
    const glue = c.createDynamicsCompressor(), lim = c.createDynamicsCompressor(), clip = c.createWaveShaper();
    glue.threshold.value = -18; glue.knee.value = 8; glue.ratio.value = 2.5; glue.attack.value = 0.006; glue.release.value = 0.2;
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    clip.curve = this.clipCurve();
    this.master.connect(glue); glue.connect(lim); lim.connect(clip); clip.connect(c.destination);
    this.verb = c.createConvolver(); this.verb.buffer = this.makeIR(1.5);
    const wet = c.createGain(); wet.gain.value = 0.5; this.verb.connect(wet); wet.connect(this.master);
    this.out = c.createGain(); this.out.connect(this.master);
    // The crowd bus: audience microphones are a little dull up top.
    const shelf = c.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 5000; shelf.gain.value = -5; shelf.connect(this.master);
    this.crowd = c.createGain(); this.crowd.connect(shelf);
    const cs = c.createGain(); cs.gain.value = 0.22; this.crowd.connect(cs); cs.connect(this.verb);
    // Stadium air: a low rumble that never quite goes away while a match is on.
    this.roomG = c.createGain(); this.roomG.gain.value = 0; this.roomG.connect(this.crowd);
    const room = c.createBufferSource(), lp = c.createBiquadFilter();
    room.buffer = this.makeRumble(4); room.loop = true; lp.type = 'lowpass'; lp.frequency.value = 380;
    room.connect(lp); lp.connect(this.roomG); room.start();
    this.bedG = c.createGain(); this.bedG.gain.value = 0; this.bedG.connect(this.crowd);
    this.bedSrc = null; this.mood = -1; this.slots.fill(0); this.clapUntil = this.oohUntil = 0;
    if (this.buf.bed) this.startBed();
  },
  startBed() {
    if (this.bedSrc || !this.buf.bed) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buf.bed; s.loop = true; s.connect(this.bedG); s.start(0, rnd(0, 10));
    this.bedSrc = s;
  },

  // ---- buffers ----
  makeNoise(sec) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  // Sparse crackle: grains of clay, grit under a shoe.
  makeGrit(sec) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.025 ? 1 : 0.04);
    return b;
  },
  makeRumble(sec) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * (sec + 0.5)), b = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    }
    return this.loopable(b, 0.5);
  },
  // An open-air stadium: early reflections off the stands, then a short, darkening tail.
  makeIR(sec) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), b = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, k = 0.2 + 0.75 * Math.exp(-t / 0.3);
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.exp(-t / 0.2) * Math.min(1, t / 0.015);
      }
      for (let r = 0; r < 8; r++) { const i = Math.floor(sr * rnd(0.02, 0.11)); d[i] += (Math.random() < 0.5 ? -1 : 1) * rnd(0.3, 0.8) * Math.exp(-i / sr / 0.12); }
    }
    return b;
  },
  // Transparent below 0.85, then rounds off towards 0.96: the last line of defence against clipping.
  clipCurve() {
    const n = 2048, k = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); k[i] = a < 0.85 ? x : Math.sign(x) * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15)); }
    return k;
  },
  // Crossfade a buffer's tail into its head so it loops without a seam.
  loopable(b, fade) {
    const sr = b.sampleRate, F = Math.floor(sr * fade), n = b.length - F, out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const s = b.getChannelData(ch), d = out.getChannelData(ch);
      d.set(s.subarray(0, n));
      for (let i = 0; i < F; i++) { const k = i / F; d[i] = s[i] * Math.sqrt(k) + s[n + i] * Math.sqrt(1 - k); }
    }
    return out;
  },
  // Scale a buffer so its RMS (over the loudest 50 ms, if windowed) hits a target: predictable levels in the mix.
  level(b, rms, windowed) {
    const W = windowed ? Math.floor(b.sampleRate * 0.05) : b.length, chs = [];
    for (let ch = 0; ch < b.numberOfChannels; ch++) chs.push(b.getChannelData(ch));
    let best = 0;
    for (let s = 0; s + W <= b.length; s += W) {
      let e = 0;
      for (const d of chs) for (let i = s; i < s + W; i++) e += d[i] * d[i];
      best = Math.max(best, e / (W * chs.length));
    }
    const k = rms / Math.sqrt(best || 1e-12);
    for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= k;
    return b;
  },
  // Many hands: every clapper keeps their own steady rate, hand shape (resonance) and seat (pan, distance).
  // Built twenty clappers at a time, yielding in between, so no frame waits on it.
  async makeClaps(sec, people) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), b = this.ctx.createBuffer(2, n, sr);
    const L = b.getChannelData(0), R = b.getChannelData(1), nz = this.noise.getChannelData(0);
    for (let k = 0; k < people; k++) {
      if (k % 20 === 19) await new Promise((r) => setTimeout(r, 0));
      const far = Math.random(), amp = 0.25 + 0.55 * (1 - far) ** 2, pan = Math.random() * Math.PI / 2;
      const gl = Math.cos(pan) * amp, gr = Math.sin(pan) * amp, period = 1 / rnd(3.4, 5.6);
      const f = rnd(700, 2500) * (1 - 0.3 * far), Q = rnd(1.4, 3.5), w = (2 * Math.PI * f) / sr, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      const b0 = al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0, lp = 0.15 + 0.6 * (1 - far);
      const len = Math.floor(sr * rnd(0.012, 0.02)), tau = sr * rnd(0.0022, 0.0045), att = Math.floor(sr * 0.0006);
      for (let t = Math.random() * period; t < sec; t += period * rnd(0.9, 1.1)) {
        const i0 = Math.floor(t * sr), off = Math.floor(Math.random() * (nz.length - len)), a = rnd(0.6, 1.2);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0, s = 0;
        for (let i = 0; i < len; i++) {
          const x = nz[off + i] * a * (i < att ? i / att : Math.exp(-(i - att) / tau));
          const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;   // band-pass: the hollow of the hands
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          s += lp * (y + 0.15 * x - s);                     // a little broadband slap; distant hands lose their top
          const j = (i0 + i) % n;                           // wrap around so the buffer loops seamlessly
          L[j] += s * gl; R[j] += s * gr;
        }
      }
    }
    // Round off the odd clap right by the microphone so the crowd reads as a crowd, not a few loud hands.
    this.level(b, 0.1, false);
    for (const d of [L, R]) {
      for (let i = 0; i < n; i++) { const u = d[i] * 2.5; d[i] = u > 3 ? 0.4 : u < -3 ? -0.4 : (0.4 * u * (27 + u * u)) / (27 + 9 * u * u); }   // 0.4 tanh(x / 0.4)
    }
    return this.level(b, 0.1, false);
  },
  // Build the crowd a piece at a time so the first click doesn't stall a frame; voices render off the main thread.
  async makeCrowd() {
    const wait = () => new Promise((r) => setTimeout(r, 0));
    try {
      await wait(); this.buf.clapsLight = await this.makeClaps(6, 22);
      this.buf.clapsFull = await this.makeClaps(6, 150);
      const bed = await this.renderVoices(15, this.bedVoices);
      if (bed) { this.buf.bed = this.level(this.loopable(bed, 1), 0.1, false); if (this.bedG) this.startBed(); }
      const ooh = await this.renderVoices(2.4, this.oohVoices);
      if (ooh) this.buf.ooh = this.level(ooh, 0.2, true);
      const cheer = await this.renderVoices(3.6, this.cheerVoices);
      if (cheer) this.buf.cheer = this.level(cheer, 0.15, true);
    } catch (e) { console.warn('Crowd audio unavailable:', e); }
  },
  renderVoices(sec, build) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.resolve(null);
    const sr = this.ctx.sampleRate, oc = new OAC(2, Math.ceil(sr * sec), sr), out = oc.createGain();
    out.connect(oc.destination);
    build.call(this, oc, out, sec);
    return oc.startRendering();
  },
  // A synthetic voice: a sawtooth "throat" through three formant band-passes.
  throat(c, dest, f0, pan, q = [7, 10, 12]) {
    const o = c.createOscillator(), g = c.createGain(), F = [], nodes = [o, g];
    o.type = 'sawtooth'; o.frequency.value = f0; g.gain.value = 0;
    for (let i = 0; i < 3; i++) {
      const f = c.createBiquadFilter(), fg = c.createGain();
      f.type = 'bandpass'; f.Q.value = q[i]; f.frequency.value = VOWELS.uh[i]; fg.gain.value = [1, 0.6, 0.3][i];
      o.connect(f); f.connect(fg); fg.connect(g); F.push(f); nodes.push(f, fg);
    }
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(dest); nodes.push(p); } else g.connect(dest);
    return { o, g, F, nodes };
  },
  // Murmur: thirty-odd people talking in phrases, far enough away that no word is clear.
  bedVoices(oc, out, sec) {
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200; lp.connect(out);
    for (let k = 0; k < 32; k++) {
      const fem = Math.random() < 0.45, f0 = fem ? rnd(165, 235) : rnd(90, 135), sc = fem ? 1.14 : 1, lv = 0.3 + 0.7 * Math.random() ** 2;
      const { o, g, F } = this.throat(oc, lp, f0, rnd(-1, 1));
      for (let t = rnd(0, 2); t < sec; t += rnd(0.3, 2)) {
        let pf = f0 * rnd(1, 1.12);
        for (let s = 2 + ((Math.random() * 7) | 0); s > 0 && t < sec; s--) {
          const d = rnd(0.09, 0.24), v = VLIST[(Math.random() * VLIST.length) | 0];
          o.frequency.setTargetAtTime(pf * rnd(0.94, 1.06), t, 0.03); pf *= 0.97;
          for (let i = 0; i < 3; i++) F[i].frequency.setTargetAtTime(v[i] * sc, t, 0.02);
          g.gain.setTargetAtTime(lv * rnd(0.5, 1), t, 0.015);
          g.gain.setTargetAtTime(0, t + d, 0.025);
          t += d + rnd(0.02, 0.09);
        }
      }
      o.start(0);
    }
    // the rustle of thousands of people in their seats
    const n = oc.createBufferSource(), bp = oc.createBiquadFilter(), g = oc.createGain();
    n.buffer = this.noise; n.loop = true; bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6; g.gain.value = 0.12;
    n.connect(bp); bp.connect(g); g.connect(out); n.start(0);
  },
  // "Oooh": a rounded vowel swelling and falling away, forty-odd voices a little out of step.
  oohVoices(oc, out) {
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.connect(out);
    const U = VOWELS.u, O = VOWELS.o;
    for (let k = 0; k < 46; k++) {
      const fem = Math.random() < 0.5, f0 = fem ? rnd(190, 280) : rnd(100, 155), sc = fem ? 1.12 : 1;
      const { o, g, F } = this.throat(oc, lp, f0, rnd(-0.9, 0.9), [6, 9, 11]);
      const t0 = rnd(0, 0.16), tp = t0 + rnd(0.25, 0.45), te = tp + rnd(0.6, 1.2), lv = rnd(0.4, 1);
      o.frequency.setValueAtTime(f0 * 0.9, t0); o.frequency.linearRampToValueAtTime(f0 * rnd(1.04, 1.12), tp); o.frequency.exponentialRampToValueAtTime(f0 * rnd(0.72, 0.85), te);
      for (let i = 0; i < 3; i++) {
        F[i].frequency.setValueAtTime(U[i] * sc, t0); F[i].frequency.linearRampToValueAtTime(O[i] * sc, tp); F[i].frequency.linearRampToValueAtTime(lerp(U[i], O[i], 0.4) * sc, te);
      }
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(lv, tp); g.gain.setTargetAtTime(0, tp + 0.08, (te - tp) / 3);
      const lfo = oc.createOscillator(), ld = oc.createGain();   // a wobble so the voices never lock together
      lfo.frequency.value = rnd(4, 6.5); ld.gain.value = f0 * 0.018; lfo.connect(ld); ld.connect(o.frequency);
      o.start(t0); lfo.start(t0); o.stop(te + 0.8); lfo.stop(te + 0.8);
    }
    // breath under the voices
    const n = oc.createBufferSource(), bp = oc.createBiquadFilter(), g = oc.createGain();
    n.buffer = this.noise; bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 1.2;
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.25, 0.4); g.gain.setTargetAtTime(0, 0.5, 0.3);
    n.connect(bp); bp.connect(g); g.connect(out); n.start(0);
  },
  // Cheers: shouted "yeah", "woo", "hey", a few whistles, over the roar of the whole stand.
  cheerVoices(oc, out) {
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800; lp.connect(out);
    const PATHS = [['i', 'e', 'ae', 'a'], ['u', 'u', 'u'], ['e', 'e', 'i'], ['uh', 'a', 'o']];
    for (let k = 0; k < 30; k++) {
      const fem = Math.random() < 0.45, f0 = fem ? rnd(280, 430) : rnd(160, 260), sc = fem ? 1.12 : 1;
      const { o, g, F } = this.throat(oc, lp, f0, rnd(-0.95, 0.95), [4, 6, 8]);
      let t = rnd(0, 1);
      for (let s = Math.random() < 0.4 ? 2 : 1; s > 0; s--) {
        const d = rnd(0.35, 0.9), lv = rnd(0.4, 1), path = PATHS[(Math.random() * PATHS.length) | 0];
        o.frequency.setValueAtTime(f0 * 0.85, t); o.frequency.linearRampToValueAtTime(f0 * rnd(1.05, 1.2), t + d * 0.3); o.frequency.linearRampToValueAtTime(f0 * rnd(0.7, 0.85), t + d);
        path.forEach((vk, j) => { for (let i = 0; i < 3; i++) F[i].frequency.setTargetAtTime(VOWELS[vk][i] * sc, t + (j * d) / path.length, 0.03); });
        g.gain.setTargetAtTime(lv, t, 0.03); g.gain.setTargetAtTime(0, t + d * 0.8, 0.07);
        t += d + rnd(0.15, 0.6);
      }
      o.start(0);
    }
    for (let k = 0; k < 3; k++) {   // two-finger whistles
      const o = oc.createOscillator(), g = oc.createGain(), p = oc.createStereoPanner(), f = rnd(2200, 3100), t = rnd(0.2, 1.6);
      o.frequency.setValueAtTime(f * 0.8, t); o.frequency.linearRampToValueAtTime(f, t + 0.12); o.frequency.setValueAtTime(f, t + 0.5); o.frequency.linearRampToValueAtTime(f * 0.85, t + 0.75);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(rnd(0.08, 0.14), t + 0.05); g.gain.setTargetAtTime(0, t + 0.6, 0.06);
      p.pan.value = rnd(-0.8, 0.8); o.connect(g); g.connect(p); p.connect(out); o.start(t); o.stop(t + 1.2);
    }
    // the roar
    const n = oc.createBufferSource(), b1 = oc.createBiquadFilter(), b2 = oc.createBiquadFilter(), g = oc.createGain();
    n.buffer = this.noise; n.loop = true; b1.type = 'bandpass'; b1.frequency.value = 750; b1.Q.value = 0.9; b2.type = 'peaking'; b2.frequency.value = 1250; b2.gain.value = 6;
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.35, 0.4); g.gain.setTargetAtTime(0, 1.8, 0.6);
    n.connect(b1); b1.connect(b2); b2.connect(g); g.connect(out); n.start(0);
  },

  // ---- building blocks for one-shot sounds ----
  // Reserve a voice: low-priority sounds (feet, swooshes, spectators) are dropped when the mix is busy.
  slot(dur, prio) {
    const s = this.slots, now = this.ctx.currentTime;
    let free = -1, busy = 0;
    for (let i = 0; i < s.length; i++) { if (s[i] > now) busy++; else if (free < 0) free = i; }
    if (free < 0 || (!prio && busy >= 24)) return false;
    s[free] = now + dur;
    return true;
  },
  near: (dist) => 1 / (1 + dist / 9),
  dist(x, y, z) { const k = this.cam; return Math.hypot(x - k.x, y - k.y, z - k.z); },
  // Stereo position of a world point as seen from the camera.
  panOf(p) {
    if (!p) return 0;
    const k = this.cam, dx = p.x - k.x, dy = p.y - k.y, dz = p.z - k.z, d = Math.hypot(dx, dy, dz) || 1;
    return clamp(fin(((dx * k.rx + dy * k.ry + dz * k.rz) / d) * 0.9, 0), -0.85, 0.85);
  },
  ballPos() { return this.game && this.game.ball ? this.game.ball.p : null; },
  // Where a sound happens: pan from the camera, distance sets the dry level and the reverb share.
  outAt(pos, dist, wet) {
    const c = this.ctx, g = c.createGain(), dry = c.createGain(), w = c.createGain(), n = this.near(dist);
    dry.gain.value = n; w.gain.value = wet * Math.sqrt(n);
    let tail = g;
    if (c.createStereoPanner) { tail = c.createStereoPanner(); tail.pan.value = this.panOf(pos); g.connect(tail); }
    tail.connect(dry); dry.connect(this.out); tail.connect(w); w.connect(this.verb);
    g.chain = [g, tail, dry, w];
    return g;
  },
  // Free an event's nodes when its longest layer ends.
  done(src, g) { src.onended = () => { for (const n of g.chain) n.disconnect(); }; },
  // A burst from a noise buffer through one filter: attack a, then exponential decay (time constant tau).
  burst(t, dest, buffer, type, f, q, peak, a, tau, f1) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(), end = t + a + tau * 7;
    s.buffer = buffer; fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (f1) fl.frequency.exponentialRampToValueAtTime(f1, end);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setTargetAtTime(0, t + a, tau);
    s.connect(fl); fl.connect(g); g.connect(dest);
    s.start(t, Math.random() * Math.max(0, buffer.duration - (end - t) - 0.01)); s.stop(end);
    return s;
  },
  nz(t, dest, type, f, q, peak, a, tau, f1) { return this.burst(t, dest, this.noise, type, f, q, peak, a, tau, f1); },
  // A decaying tone with an optional pitch drop.
  tn(t, dest, type, f0, f1, peak, a, tau) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), end = t + a + tau * 7;
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + tau * 3);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setTargetAtTime(0, t + a, tau);
    o.connect(g); g.connect(dest); o.start(t); o.stop(end);
    return o;
  },

  // ---- the court ----
  // Racket strike: crack + ball "pock" + string ping + frame thock + follow-through. A mishit is duller and rattles the frame.
  hit(power = 0.5, dist = 3, q = 1, serve = false) {
    if (!this.ok() || !this.slot(0.4, 1)) return;
    power = clamp(fin(power, 0.5), 0, 1); q = clamp(fin(q, 1), 0, 1); dist = Math.max(0, fin(dist, 3));
    const t = this.t0(), o = this.outAt(this.ballPos(), dist, 0.2), mis = 1 - q;
    const v = (0.45 + 0.55 * power) * (serve ? 1.12 : 1) * jit(1, 0.08), top = 0.35 + 0.65 * this.near(dist);
    this.nz(t, o, 'highpass', 2800, 0.7, 0.5 * v * top * (1 - 0.5 * mis), 0.0003, 0.003);
    const pk = jit(1150 + 300 * power, 0.05), clean = 1 - 0.45 * mis;
    this.nz(t, o, 'bandpass', pk, 5, 2.6 * v * clean, 0.0005, 0.011);
    this.tn(t, o, 'sine', pk, pk * 0.92, 0.42 * v * clean, 0.0004, 0.006);
    const fs = jit(520 + 110 * power, 0.04);
    this.tn(t, o, 'sine', fs, fs * 0.98, 0.12 * v * (1 - 0.5 * mis), 0.0006, 0.02 + 0.016 * q);
    this.tn(t, o, 'sine', fs * 2.41, fs * 2.36, 0.05 * v, 0.0004, 0.01);
    this.tn(t, o, 'triangle', jit(215, 0.07), 140, (0.18 + 0.6 * mis) * v, 0.0008, 0.016 + 0.04 * mis);
    if (serve) this.tn(t, o, 'sine', 125, 72, 0.2 * v * power, 0.002, 0.03);
    this.done(this.nz(t, o, 'bandpass', 1200, 1.1, (0.04 + 0.1 * power) * v, 0.004, 0.05, 350), o);
  },
  // Ball on court: hard pops, clay thuds with a spray of grit, grass gives a soft thump.
  bounce(vin = 5, dist = 5, surf = 'hard') {
    if (!this.ok() || !this.slot(0.3, 1)) return;
    dist = Math.max(0, fin(dist, 5));
    const t = this.t0(), o = this.outAt(this.ballPos(), dist, 0.16), v = clamp(fin(vin, 5) / 12, 0.06, 0.9) * jit(1, 0.1);
    let last;
    if (surf === 'clay') {
      this.tn(t, o, 'sine', jit(165, 0.05), 95, 0.55 * v, 0.001, 0.028);
      this.nz(t, o, 'bandpass', jit(700, 0.08), 1.6, 1.2 * v, 0.001, 0.014);
      last = this.burst(t, o, this.grit, 'highpass', 1800, 0.7, 0.5 * v, 0.002, 0.03);
    } else if (surf === 'grass') {
      last = this.tn(t, o, 'sine', jit(125, 0.06), 78, 0.5 * v, 0.002, 0.032);
      this.nz(t, o, 'lowpass', 480, 0.7, 0.6 * v, 0.002, 0.018);
      this.nz(t, o, 'bandpass', 3800, 1, 0.06 * v, 0.003, 0.02);
    } else {
      const pk = jit(1080, 0.06);
      this.nz(t, o, 'highpass', 2400, 0.7, 0.45 * v, 0.0003, 0.0025);
      this.nz(t, o, 'bandpass', pk, 4, 2.4 * v, 0.0005, 0.009);
      this.tn(t, o, 'sine', pk, pk * 0.93, 0.36 * v, 0.0004, 0.005);
      last = this.tn(t, o, 'sine', jit(270, 0.05), 170, 0.22 * v, 0.001, 0.014);
    }
    this.done(last, o);
  },
  // Net: the tape clipped (sharp tick, the cable hums, the crowd gasps) or the mesh taking the ball.
  net(e, dist = 12) {
    if (!this.ok() || !this.slot(0.6, 1)) return;
    const t = this.t0(), o = this.outAt(this.ballPos(), Math.max(0, fin(dist, 12)), 0.2);
    if (e && e.cord) {
      this.nz(t, o, 'bandpass', 1900, 3, 1.4, 0.0004, 0.004);
      this.tn(t, o, 'sine', jit(2100, 0.05), 1900, 0.3, 0.0003, 0.004);
      this.nz(t, o, 'lowpass', 700, 0.7, 0.2, 0.003, 0.03);
      this.done(this.tn(t, o, 'triangle', jit(118, 0.05), 110, 0.08, 0.002, 0.07), o);
      this.ooh(e.over ? 0.75 : 0.5, 0.18);
    } else {
      this.nz(t, o, 'lowpass', 520, 0.8, 0.55, 0.004, 0.05);
      this.tn(t, o, 'sine', 88, 58, 0.35, 0.003, 0.04);
      this.done(this.rattle(t, o, 0.12), o);
    }
  },
  rattle(t, dest, peak) {   // the mesh and cable shaking
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), am = c.createGain(), g = c.createGain(), lfo = c.createOscillator(), d = c.createGain(), end = t + 0.5;
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.9;
    lfo.type = 'square'; lfo.frequency.value = jit(34, 0.1); d.gain.value = 0.5; am.gain.value = 0.5;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.01); g.gain.setTargetAtTime(0, t + 0.01, 0.07);
    lfo.connect(d); d.connect(am.gain); s.connect(f); f.connect(am); am.connect(g); g.connect(dest);
    s.start(t, Math.random()); s.stop(end); lfo.start(t); lfo.stop(end);
    return s;
  },
  // The racket cutting the air, rising to contact (scheduled ahead from the swing's contact time).
  swoosh(pl, lead, serve) {
    const P = this.P; P.x = pl.x; P.y = 1.1; P.z = pl.z;
    const dist = this.dist(P.x, P.y, P.z), n = this.near(dist), lv = (serve ? 0.28 : 0.2) * n;
    if (lv < 0.03 || !this.slot(lead + 0.2, 0)) return;
    const c = this.ctx, D = Math.min(lead, serve ? 0.26 : 0.18), tc = c.currentTime + lead, t = tc - D, o = this.outAt(P, dist, 0.1);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), f2 = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.Q.value = 1.3; f2.type = 'highshelf'; f2.frequency.value = 3000; f2.gain.value = 4;
    f.frequency.setValueAtTime(280, t); f.frequency.exponentialRampToValueAtTime(jit(1500, 0.1), tc);
    g.gain.setValueAtTime(0.0005, t); g.gain.exponentialRampToValueAtTime(lv, tc); g.gain.setTargetAtTime(0, tc, 0.03);
    s.connect(f); f.connect(f2); f2.connect(g); g.connect(o);
    s.start(t, Math.random()); s.stop(tc + 0.25);
    this.done(s, o);
  },
  // Shoes: a rubber squeak on a hard court, a sliding scrape on clay, a brush on grass.
  squeak(pl, k, surf) {
    const P = this.P; P.x = pl.x; P.y = 0.05; P.z = pl.z;
    const dist = this.dist(P.x, P.y, P.z);
    if (dist > 34 || !this.slot(0.5, 0)) return;
    const c = this.ctx, t = this.t0(), o = this.outAt(P, dist, 0.12);
    if (surf === 'clay' || surf === 'grass') {
      const d = surf === 'clay' ? rnd(0.18, 0.34) * (0.7 + 0.5 * k) : rnd(0.08, 0.14), lv = (surf === 'clay' ? 0.18 : 0.08) * (0.5 + 0.5 * k);
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noise; f.type = surf === 'clay' ? 'bandpass' : 'lowpass'; f.frequency.value = surf === 'clay' ? jit(1900, 0.15) : 1300; f.Q.value = 0.7;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lv, t + 0.03); g.gain.linearRampToValueAtTime(lv * 0.6, t + d); g.gain.setTargetAtTime(0, t + d, 0.04);
      s.connect(f); f.connect(g); g.connect(o); s.start(t, Math.random()); s.stop(t + d + 0.3);
      if (surf === 'clay') this.burst(t, o, this.grit, 'highpass', 2500, 0.7, lv * 1.5, 0.02, d * 0.25);
      this.done(s, o);
      return;
    }
    const d = rnd(0.07, 0.16) * (0.7 + 0.5 * k), f0 = rnd(1300, 2300), lv = 0.22 * (0.45 + 0.55 * k);
    const osc = c.createOscillator(), lfo = c.createOscillator(), ld = c.createGain(), bp = c.createBiquadFilter(), g = c.createGain();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(f0, t); osc.frequency.linearRampToValueAtTime(f0 * (Math.random() < 0.5 ? rnd(1.05, 1.25) : rnd(0.8, 0.95)), t + d);
    lfo.frequency.value = rnd(28, 60); ld.gain.value = f0 * rnd(0.02, 0.05);   // stick-slip flutter
    bp.type = 'bandpass'; bp.frequency.value = f0 * 1.5; bp.Q.value = 2.5;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lv, t + 0.012); g.gain.setValueAtTime(lv * 0.85, t + d * 0.7); g.gain.linearRampToValueAtTime(0, t + d);
    lfo.connect(ld); ld.connect(osc.frequency); osc.connect(bp); bp.connect(g); g.connect(o);
    osc.start(t); lfo.start(t); osc.stop(t + d + 0.02); lfo.stop(t + d + 0.02);
    this.done(osc, o);
  },
  // Footsteps while running: only the nearer player is close enough to hear.
  step(pl, sp, surf) {
    const P = this.P; P.x = pl.x; P.y = 0.05; P.z = pl.z;
    const dist = this.dist(P.x, P.y, P.z);
    if (dist > 22 || !this.slot(0.15, 0)) return;
    const t = this.t0(), o = this.outAt(P, dist, 0.08), v = 0.07 * clamp(sp / 5, 0.4, 1.2) * jit(1, 0.25);
    let last;
    if (surf === 'clay') { this.burst(t, o, this.grit, 'highpass', 1500, 0.7, 1.4 * v, 0.002, 0.012); last = this.tn(t, o, 'sine', 95, 70, 0.8 * v, 0.002, 0.012); }
    else if (surf === 'grass') { this.nz(t, o, 'lowpass', 700, 0.7, 0.5 * v, 0.002, 0.01); last = this.tn(t, o, 'sine', 85, 60, 0.7 * v, 0.003, 0.014); }
    else { this.nz(t, o, 'bandpass', jit(1800, 0.15), 1.4, 0.9 * v, 0.0005, 0.006); last = this.tn(t, o, 'sine', 90, 65, 0.9 * v, 0.002, 0.012); }
    this.done(last, o);
  },

  // ---- the crowd ----
  // Called every frame by the UI: the listener, the crowd's mood, footwork and swings.
  frame(game, cam, playing) {
    const c = this.ctx;
    if (!c || !this.bedG || !game) return;
    this.game = game;
    if (cam && cam.matrixWorld) { const e = cam.matrixWorld.elements, k = this.cam; k.x = e[12]; k.y = e[13]; k.z = e[14]; k.rx = e[0]; k.ry = e[1]; k.rz = e[2]; }
    const now = Clock.now(), dt = now - this.lastNow, s = game.state;
    this.lastNow = now;
    // Chatter between points, a hush as the server gets ready, near silence during the point.
    let lv = 0;
    if (playing) {
      if (s === 'dead' || s === 'over') lv = 1;
      else if (s === 'serve') lv = lerp(0.85, 0.12, sstep(0, 1, (now - fin(game.serveReadyAt, now) + 0.4) / 1.5));
      else lv = 0.05;
      if (Clock.paused) lv *= 0.35;
    }
    lv = Math.round(lv * 40) / 40;
    if (lv !== this.mood) {
      const t = c.currentTime;
      this.bedG.gain.setTargetAtTime(lv * this.BED, t, lv < this.mood ? 0.3 : 0.9);
      this.roomG.gain.setTargetAtTime(playing ? this.ROOM * (Clock.paused ? 0.5 : 1) : 0, t, 0.5);
      this.mood = lv;
    }
    if (!playing || Clock.paused || !this.ok() || !(dt > 0 && dt < 0.2)) return;
    if (lv >= 0.5 && Math.random() < dt * 0.25) this.chatter();
    else if (lv > 0 && lv < 0.2 && Math.random() < dt * 0.02) this.cough();
    const surf = (game.cfg && game.cfg.surface) || 'hard';
    for (const pl of game.players) this.footwork(pl, s, dt, now, surf);
  },
  footwork(pl, s, dt, now, surf) {
    const f = this.feet[pl.idx] || (this.feet[pl.idx] = { vx: 0, vz: 0, next: 0, ph: 0, swing: 0 });
    const vx = fin(pl.vx, 0), vz = fin(pl.vz, 0), av = pl.avatar;
    // A swing has been scheduled: whoosh up to its contact time.
    if (av && av.contactT && av.contactT !== f.swing) {
      f.swing = av.contactT;
      const lead = av.contactT - now;
      if ((s === 'rally' || s === 'toss') && lead > 0.06 && lead < 1) this.swoosh(pl, lead, av.mode === 'serve');
    }
    if (s !== 'rally' && s !== 'dead') { f.vx = vx; f.vz = vz; f.ph = 0.6; return; }
    // Deceleration along the old direction of travel: hard stops and cuts make the shoes squeal.
    const pv = Math.hypot(f.vx, f.vz), against = pv > 0.1 ? -((vx - f.vx) * f.vx + (vz - f.vz) * f.vz) / (pv * dt) : 0;
    f.vx = vx; f.vz = vz;
    if (against > 7 && pv > 2.6 && now > f.next) {
      f.next = now + rnd(0.4, 0.7);
      if (Math.random() < 0.8) this.squeak(pl, clamp((against - 7) / 10 + (pv - 2.6) / 6, 0.15, 1), surf);
    }
    const sp = Math.hypot(vx, vz);
    if (s === 'rally' && sp > 1.3) { f.ph += dt * (1.5 + 0.4 * sp); if (f.ph >= 1) { f.ph -= 1; this.step(pl, sp, surf); } }
  },
  // Crowd reaction as a point ends: applause sized by the moment, "ooh" for the close ones, a groan for a double fault.
  pointEnd(reason, rally = 1, ev = {}, margin = null) {
    if (!this.ok()) return;
    let size = { ace: 0.55, winner: 0.45, out: 0.2, net: 0.18, df: 0.08 }[reason] ?? 0.25;
    size += clamp((fin(rally, 1) - 4) * 0.045, 0, 0.35);   // long rallies get the crowd going
    if (ev && ev.game) size += ev.tbStart ? 0.25 : 0.15;
    if (reason === 'out') this.nearMiss(margin);
    else if ((reason === 'ace' || reason === 'winner') && Number.isFinite(margin) && margin > -0.05) { this.ooh(0.45, 0.05); size += 0.1; }   // on the line
    else if (reason === 'df') this.ooh(0.35, 0.15, true);
    this.applause(ev && ev.match ? 1 : clamp(size, 0.06, 0.92));
  },
  // A ball that only just missed (margin in metres outside the line): the crowd draws breath.
  nearMiss(margin, k = 1) {
    if (!this.ok() || !Number.isFinite(margin) || margin < 0 || margin > 0.3) return;
    this.ooh(clamp(0.9 - margin * 2, 0.3, 0.9) * k, 0.05);
  },
  // Applause, 0..1: a polite smattering, a proper hand, or a standing ovation with cheers and whistles.
  applause(size = 0.6, delay = 0.3) {
    const B = this.buf;
    if (!this.ok() || !B.clapsLight) return;
    size = clamp(fin(size, 0.6), 0, 1);
    const t = this.ctx.currentTime + delay;
    if (t < this.clapUntil - 1 && size <= this.clapSize) return;   // already applauding at least this much
    const dur = 1.3 + 6.5 * size ** 1.4, loud = 0.25 + 0.75 * size;
    this.clapUntil = t + dur; this.clapSize = size;
    // The keen few carry on after the rest have stopped, so big applause thins out rather than just fading.
    this.loop(B.clapsLight, t, 0.12, loud * (size < 0.4 ? 1 : 0.55), dur * 0.75, dur * 0.12 + 0.3);
    if (size > 0.3 && B.clapsFull) this.loop(B.clapsFull, t + 0.08, 0.3, loud * 1.1 * sstep(0.3, 0.75, size), dur * 0.5, dur * 0.12);
    if (size > 0.55 && B.cheer) this.play(B.cheer, t + 0.15, (size - 0.4) * 1.3, rnd(0.95, 1.05));
    if (size > 0.8 && B.cheer) this.play(B.cheer, t + rnd(1.2, 1.8), (size - 0.5) * 0.9, rnd(0.9, 1.1));
  },
  ooh(k = 0.6, delay = 0.1, groan = false) {
    const B = this.buf;
    if (!this.ok() || !B.ooh) return;
    const t = this.ctx.currentTime + delay;
    if (t < this.oohUntil) return;
    this.oohUntil = t + 1.2;
    this.play(B.ooh, t, 0.42 * clamp(fin(k, 0.6), 0, 1), groan ? rnd(0.8, 0.86) : rnd(0.95, 1.06));
  },
  // A looping crowd buffer: rise, hold (easing off a little), then fade with time constant tau.
  loop(buf, t, rise, peak, hold, tau) {
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain();
    s.buffer = buf; s.loop = true; s.playbackRate.value = rnd(0.97, 1.03);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + rise); g.gain.linearRampToValueAtTime(peak * 0.8, t + rise + hold);
    g.gain.setTargetAtTime(0, t + rise + hold, tau);
    s.connect(g); g.connect(this.crowd); s.start(t, rnd(0, buf.duration)); s.stop(t + rise + hold + tau * 7);
    s.onended = () => g.disconnect();
  },
  play(buf, t, peak, rate = 1) {
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain();
    s.buffer = buf; s.playbackRate.value = rate; g.gain.value = peak;
    s.connect(g); g.connect(this.crowd); s.start(t);
    s.onended = () => g.disconnect();
  },
  // One spectator near a microphone saying a few words.
  chatter() {
    if (!this.slot(2.5, 0)) return;
    const c = this.ctx, fem = Math.random() < 0.5, f0 = fem ? rnd(170, 240) : rnd(95, 140), sc = fem ? 1.14 : 1;
    const lp = c.createBiquadFilter(), lvl = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = rnd(1200, 2200); lvl.gain.value = rnd(0.25, 0.5);
    lp.connect(lvl); lvl.connect(this.crowd);
    const { o, g, F, nodes } = this.throat(c, lp, f0, rnd(-0.9, 0.9));
    const t0 = c.currentTime + 0.05;
    let t = t0, pf = f0 * rnd(1, 1.12);
    for (let s = 2 + ((Math.random() * 6) | 0); s > 0; s--) {
      const d = rnd(0.09, 0.22), v = VLIST[(Math.random() * VLIST.length) | 0];
      o.frequency.setTargetAtTime(pf * rnd(0.94, 1.06), t, 0.03); pf *= 0.97;
      for (let i = 0; i < 3; i++) F[i].frequency.setTargetAtTime(v[i] * sc, t, 0.02);
      g.gain.setTargetAtTime(rnd(0.5, 1), t, 0.015); g.gain.setTargetAtTime(0, t + d, 0.025);
      t += d + rnd(0.03, 0.1);
    }
    o.start(t0); o.stop(t + 0.3);
    o.onended = () => { for (const n of nodes) n.disconnect(); lp.disconnect(); lvl.disconnect(); };
  },
  // Someone coughs in the hush (it always happens).
  cough() {
    if (!this.slot(1, 0)) return;
    const c = this.ctx, t = c.currentTime + 0.02, lp = c.createBiquadFilter(), p = c.createStereoPanner(), lv = rnd(0.05, 0.1), f = rnd(420, 800);
    lp.type = 'lowpass'; lp.frequency.value = 2200; p.pan.value = rnd(-0.9, 0.9); lp.connect(p); p.connect(this.crowd);
    let last = null;
    for (let i = 0, n = Math.random() < 0.6 ? 2 : 1; i < n; i++) {
      const tt = t + i * rnd(0.2, 0.3), k = i ? 0.7 : 1;
      this.nz(tt, lp, 'bandpass', f, 1.3, lv * k, 0.006, 0.04);
      last = this.tn(tt, lp, 'sawtooth', f * 0.28, f * 0.22, lv * 0.15 * k, 0.005, 0.03);
    }
    last.onended = () => { lp.disconnect(); p.disconnect(); };
  },
  // Legacy hook: the crowd's level now follows the match state in frame().
  ambience() {},

  // ---- the umpire ----
  voice() {
    if (!window.speechSynthesis) return null;
    const vs = speechSynthesis.getVoices();
    if (!vs.length) return null;
    for (const re of [/Daniel/i, /George/i, /Ryan/i, /UK English Male/i, /Arthur/i, /Oliver/i]) { const v = vs.find((x) => re.test(x.name) && /^en/i.test(x.lang)); if (v) return v; }
    return vs.find((x) => /en-GB/i.test(x.lang)) || vs.find((x) => /^en/i.test(x.lang)) || null;
  },
  // Stop the umpire mid-sentence (a new match, or back to the menu).
  hush() { try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) { /* speech unavailable */ } },
  say(text, { rate = 0.98, pitch = 0.92, cancel = false } = {}) {
    if (!text || !Settings.voice || !this.ctx || !window.speechSynthesis) return;
    try {
      if (cancel) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text), v = this.voice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = rate; u.pitch = pitch; u.volume = clamp(fin(Settings.volume, 0.8) * 1.2, 0, 1);
      u.onstart = () => this.duck(0.7);   // the crowd dips under the umpire's microphone
      u.onend = u.onerror = () => this.duck(1);
      speechSynthesis.speak(u);
    } catch (e) { /* speech unavailable */ }
  },
};
// A sound problem must never break a rally: the game-facing calls swallow (and report once) any error.
for (const k of ['hit', 'bounce', 'net', 'pointEnd', 'nearMiss', 'applause', 'ooh', 'frame', 'setVolume']) {
  const f = Sound[k];
  Sound[k] = function (a, b, c, d) {
    try { return f.call(this, a, b, c, d); } catch (e) { if (!this.warned) { this.warned = true; console.warn('Sound:', e); } }
  };
}

export { PT_WORDS, PT_SHOW, NUM, numWord, Match, Sound };
