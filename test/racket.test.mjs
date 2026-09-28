// The phone racket page (controller.html) with a fake clock, fake motion sensors and a fake relay socket: when each
// swing is sent to the game, what it says, keep-alives, the clock offset and the grip setup.
//   node test/racket.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../controller.html', import.meta.url), 'utf8');
const SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
const HZ = 60, G = 9.81, OFFSET = 5000;   // the game clock runs 5 s ahead of the phone's

// One phone page, linked to the game through the (fake) serve.py relay, Start tapped, grip already set up.
async function phone({ fhSign = 1 } = {}) {
  let now = 1000, tid = 0;
  const timers = [];
  const setTimeout = (fn, ms) => { timers.push({ id: ++tid, at: now + (ms || 0), fn }); return tid; };
  const setInterval = (fn, ms) => { timers.push({ id: ++tid, at: now + ms, fn, every: ms }); return tid; };
  const clear = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      now = t.at;
      if (t.every) t.at += t.every; else timers.shift();
      t.fn();
    }
    now = end;
  };
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, hidden: false, textContent: '', className: '', value: '', style: {}, offsetWidth: 0, disabled: false, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener(ev, fn) { this.listeners[ev] = fn; }, append() {}, setAttribute() {}, click() {},
  });
  const sockets = [], listeners = {}, hooks = {};
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
    send(d) { const m = { at: now, ...JSON.parse(d) }; out.push(m); if (hooks.onSend) hooks.onSend(m); }
    close() { this.readyState = 3; }
  }
  const out = [];
  const ctx = {
    console, Math, JSON, Promise, URLSearchParams, Object, Number, String, Array,
    setTimeout, setInterval, clearTimeout: clear, clearInterval: clear,
    performance: { now: () => now },
    document: { getElementById: el, createElement: () => el('x' + ++tid), body: { append() {} }, visibilityState: 'visible', addEventListener() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome', platform: 'Linux', maxTouchPoints: 5, vibrate: () => true },
    location: { protocol: 'https:', host: 'pc:8766', search: '?c=ABCDE', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => JSON.stringify({ fhSign }), setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ relay: true }) }),
    requestAnimationFrame: () => 0,
    DeviceMotionEvent: class {},
    WebSocket,
    isSecureContext: true,
    addEventListener(ev, fn) { listeners[ev] = fn; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  assert.equal(sockets.length, 1, 'the page links up through the relay');
  const game = (m) => sockets[0].onmessage({ data: JSON.stringify(m) });
  game({ relay: 'open' });
  el('btnConnect').listeners.click();
  await settle();
  assert.equal(ctx.PalmRacket.screen, fhSign ? 'play' : 'calib');
  // Answer pings like the game: symmetric 4 ms each way, game clock OFFSET ahead.
  const pong = (up = 4, down = 4) => { for (const m of out.filter((x) => x.type === 'ping' && !x.answered)) { m.answered = true; const at = m.at; setTimeout(() => game({ type: 'pong', t: m.t, g: at + up + OFFSET }), up + down - (now - at)); } };
  pong(); advance(20); pong(); advance(20);
  // Motion at 60 Hz: w(t) in deg/s about the vertical (+ = forehand for fhSign 1).
  const sample = (w, lift = 0) => listeners.devicemotion({ rotationRate: { alpha: 0.2 * w, beta: 0, gamma: w }, accelerationIncludingGravity: { x: 0, y: G + lift, z: 0 }, acceleration: { x: 0, y: lift, z: 0 } });
  const still = (ms) => { for (let t = 0; t < ms; t += 1000 / HZ) { advance(1000 / HZ); sample(0); } };
  // A swing: rise over R ms, fall over F ms (raised cosines). Returns the peak sample's time.
  const swing = ({ peak = 950, R = 150, F = 220, sign = 1, noise = 0, seed = 1, tail = 60 } = {}) => {
    let best = -1, tBest = 0, s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0, t = 0; t <= R + F + tail; i++, t = (i * 1000) / HZ) {
      advance(1000 / HZ);
      const w = (t < R ? Math.sin((Math.PI * t) / (2 * R)) ** 2 : t < R + F ? Math.cos((Math.PI * (t - R)) / (2 * F)) ** 2 : 0) * peak * (1 + noise * rnd());
      sample(sign * w);
      if (w > best) { best = w; tBest = now; }
    }
    return tBest;
  };
  // Any hold: w = rotation (deg/s, phone axes), up = which way is up in phone axes.
  const raw = (w, up) => listeners.devicemotion({ rotationRate: { alpha: w.z, beta: w.x, gamma: w.y }, accelerationIncludingGravity: { x: up.x * G, y: up.y * G, z: up.z * G }, acceleration: { x: 0, y: 0, z: 0 } });
  return { ctx, out, game, advance, still, swing, sample, raw, pong, hooks, later: setTimeout, get now() { return now; }, els };
}
const sent = (p, type) => p.out.filter((m) => m.type === type);

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('ok -', name); }

await test('a rally swing is sent just past its peak, not when it ends', async () => {
  for (const [R, F, most] of [[150, 220, 34], [130, 130, 34], [120, 300, 51]]) {   // most: ms after the peak (2-3 samples)
    const p = await phone();
    p.game({ type: 'state', inMatch: true, serving: false, tossed: false, stroke: 'fh' });
    p.still(200);
    const n0 = p.out.length, tPeak = p.swing({ R, F });
    const sw = sent(p, 'swing');
    assert.equal(sw.length, 1, 'one swing message');
    assert.ok(sw[0].at - tPeak <= most && sw[0].at > tPeak, `sent ${Math.round(sw[0].at - tPeak)} ms after the peak (${R}/${F})`);
    assert.ok(Math.abs(sw[0].tg - (tPeak + OFFSET)) < 1, 'stamped with the peak, in game time');
    assert.equal(sw[0].dir, 'fh');
    assert.ok(sw[0].power > 0.4 && sw[0].peak > 900 && sw[0].peak < 1000, `power ${sw[0].power}, peak ${sw[0].peak}`);
    const st = p.out.slice(n0).find((m) => m.type === 'swingStart');
    assert.ok(st && st.at < tPeak - 60 && st.id === sw[0].id, 'swingStart well before the peak, same id');
  }
});

await test('a jittery swing is still sent once, near its real peak', async () => {
  const lag = [];
  for (let seed = 1; seed <= 40; seed++) {
    const p = await phone();
    p.still(100);
    const tPeak = p.swing({ noise: 0.04, seed });
    const sw = sent(p, 'swing');
    assert.equal(sw.length, 1, `seed ${seed}: one swing`);
    assert.ok(Math.abs(sw[0].tg - OFFSET - tPeak) < 1, `seed ${seed}: peak off by ${sw[0].tg - OFFSET - tPeak}`);
    assert.ok(sw[0].at > tPeak && sw[0].at - tPeak <= 84, `seed ${seed}: sent ${Math.round(sw[0].at - tPeak)} ms after the peak`);
    lag.push(sw[0].at - tPeak);
  }
  lag.sort((a, b) => a - b);
  assert.ok(lag[20] <= 51, `median ${lag[20]} ms after the peak`);
});

await test('wind-up, stroke and recovery: the wind-up and stroke are sent, the recovery is not', async () => {
  const p = await phone();
  p.game({ type: 'state', inMatch: true, serving: false, tossed: false, stroke: 'fh' });
  p.still(100);
  const t1 = p.swing({ sign: -1, peak: 430, R: 160, F: 160 });
  const t2 = p.swing({ sign: 1, peak: 950, R: 130, F: 130 });
  p.still(60);
  p.swing({ sign: -1, peak: 470, R: 190, F: 190 });   // bringing the racket back
  p.still(300);
  const sw = sent(p, 'swing');
  assert.deepEqual(sw.map((m) => m.dir), ['bh', 'fh']);
  assert.ok(sw[0].at - t1 <= 34 && sw[1].at - t2 <= 34);
});

await test('serve: a hard swing well after the toss goes at once; a wind-up waits for it', async () => {
  const p = await phone();
  p.still(100);
  p.game({ type: 'state', inMatch: true, serving: true, tossed: true, stroke: null, tossT: p.now + OFFSET });
  p.still(300);
  const t1 = p.swing({ sign: -1, peak: 450, R: 120, F: 160, tail: 0 });   // wind-up, 0.3 s after the toss, flowing into the swing: held
  const t2 = p.swing({ sign: 1, peak: 950, R: 110, F: 150 });    // the serve itself
  p.still(400);
  const sw = sent(p, 'swing');
  assert.equal(sw.length, 1, 'only the serve is sent');
  assert.ok(Math.abs(sw[0].tg - OFFSET - t2) < 1 && sw[0].at - t2 <= 34, `sent ${Math.round(sw[0].at - t2)} ms after its peak`);
  assert.ok(t2 > t1);
});

await test('serve: without the toss time (an older game page) the strongest swing is held as before', async () => {
  const p = await phone();
  p.still(100);
  p.game({ type: 'state', inMatch: true, serving: true, tossed: true, stroke: null });
  p.still(400);
  const tPeak = p.swing({ peak: 950 });
  p.still(400);
  const sw = sent(p, 'swing');
  assert.equal(sw.length, 1);
  assert.ok(sw[0].at - tPeak > 150, 'held until the swing ended and the hold ran out');
});

await test('keep-alives: every 80 ms while a match is on, none otherwise', async () => {
  const p = await phone();
  p.still(1000);
  assert.equal(sent(p, 'k').length, 0, 'no match yet');
  p.game({ type: 'state', inMatch: true, serving: false, tossed: false, stroke: null });
  const n0 = sent(p, 'k').length;
  p.still(1000);
  const k = sent(p, 'k').length - n0;
  assert.ok(k >= 11 && k <= 13, `${k} keep-alives in a second`);
  p.game({ type: 'state', inMatch: false });
  const n1 = sent(p, 'k').length;
  p.still(1000);
  assert.ok(sent(p, 'k').length - n1 <= 1, 'stopped after the match');
});

await test('clock offset: the fastest round trip wins, however slow the others were one way', async () => {
  const p = await phone();
  p.game({ type: 'resync' });   // start the samples over
  for (const [up, down] of [[4, 160], [80, 6], [5, 5], [30, 90], [3, 220]]) { p.advance(1); p.pong(up, down); p.advance(400); }
  assert.ok(Math.abs(p.ctx.PalmRacket.offset - OFFSET) < 0.6, `offset ${p.ctx.PalmRacket.offset}`);
});

await test('an unset phone learns forehand from backhand from the hits, which now come back before the swing ends', async () => {
  const p = await phone({ fhSign: 0 });
  p.els.btnCalibSkip.listeners.click();
  p.game({ type: 'state', inMatch: true, serving: false, tossed: false, stroke: 'fh' });
  let hits = 0;
  p.hooks.onSend = (m) => { if (m.type === 'swing') p.later(() => { hits++; p.game({ type: 'hit', power: 0.6, stroke: 'fh' }); }, 20); };
  for (let i = 0; i < 3; i++) {
    p.still(300);
    const tPeak = p.swing({ sign: -1 });
    assert.equal(hits, i + 1);
    assert.ok(sent(p, 'swing')[i].at - tPeak < 40 && sent(p, 'swing')[i].dir === null);
    p.still(700);
  }
  assert.equal(p.ctx.PalmRacket.cal.fhSign, -1);
});

await test('aim fields: yawPre and yawShare at the peak, yawPost in a swingEnd after it', async () => {
  const one = async ({ lead = 0, roll = 0 } = {}) => {
    const p = await phone();
    p.game({ type: 'state', inMatch: true, serving: false, tossed: false, stroke: 'fh' });
    p.still(300);
    // A slow turn before the swing (below the 240 deg/s start), then the swing itself; roll turns it about another axis.
    for (let t = 0; t < 200; t += 1000 / HZ) { p.advance(1000 / HZ); p.raw({ x: 0, y: lead, z: 0 }, { x: 0, y: 1, z: 0 }); }
    for (let i = 0, t = 0; t <= 430; i++, t = (i * 1000) / HZ) {
      p.advance(1000 / HZ);
      const w = 950 * (t < 150 ? Math.sin((Math.PI * t) / 300) ** 2 : t < 370 ? Math.cos((Math.PI * (t - 150)) / 440) ** 2 : 0);
      p.raw({ x: roll * w, y: w, z: 0 }, { x: 0, y: 1, z: 0 });
    }
    p.still(200);
    const sw = sent(p, 'swing'), end = sent(p, 'swingEnd');
    assert.equal(sw.length, 1); assert.equal(end.length, 1);
    assert.equal(end[0].id, sw[0].id);
    assert.ok(end[0].at > sw[0].at + 50, 'swingEnd comes once the swing has slowed');
    assert.ok(!('yawPost' in sw[0]), 'the swing itself goes before its follow-through');
    return { ...sw[0], yawPost: end[0].yawPost };
  };
  const plain = await one();
  assert.ok(plain.yawPre > 65 && plain.yawPre < 95, `yawPre ${plain.yawPre}`);   // about 950 deg/s x 75 ms, plus the 60 Hz steps
  assert.ok(plain.yawShare >= 0.99, `yawShare ${plain.yawShare}`);
  assert.ok(plain.yawPost > 70 && plain.yawPost < 100, `yawPost ${plain.yawPost}`);
  const led = await one({ lead: 150 }), against = await one({ lead: -150 });
  assert.ok(led.yawPre > plain.yawPre + 8, `a slow start the same way counts: ${led.yawPre} vs ${plain.yawPre}`);
  assert.ok(against.yawPre <= plain.yawPre && against.yawPre > plain.yawPre - 15, `one the other way isn't taken off: ${against.yawPre} vs ${plain.yawPre}`);
  const rolled = await one({ roll: 0.75 });
  assert.ok(Math.abs(rolled.yawShare - 0.8) < 0.02, `rolling: yawShare ${rolled.yawShare}`);
});

await test('lifting the phone still tosses on your serve', async () => {
  const p = await phone();
  p.game({ type: 'state', inMatch: true, serving: true, tossed: false, stroke: null });
  p.still(300);
  for (let t = 0; t < 260; t += 1000 / HZ) { p.advance(1000 / HZ); p.sample(0, 12 * Math.sin((Math.PI * t) / 260)); }
  p.still(100);
  assert.equal(sent(p, 'toss').length, 1);
});

await test('grip setup still learns forehand and backhand, and sends nothing to the game', async () => {
  const p = await phone({ fhSign: 0 });
  p.still(100);
  p.swing({ sign: -1 });
  p.still(800);
  p.swing({ sign: 1 });
  p.still(800);
  assert.equal(p.ctx.PalmRacket.cal.fhSign, -1);
  assert.equal(p.ctx.PalmRacket.screen, 'play');
  assert.equal(sent(p, 'swing').length, 0);
});

console.log(`${pass} tests passed`);
