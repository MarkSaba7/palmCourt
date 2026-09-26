// Palm Court: game controllers (any "standard" mapping pad: Xbox, PlayStation, Switch Pro, Steam Deck / Steam Input).
// Menus: D-pad or left stick moves the focus, A picks, B goes back, LB / RB switch Settings tabs, Start pauses.
// Matches: flick the right stick to swing (the flick's speed sets the power, up adds topspin, down slices, sideways
// aims a serve), or pull RT (drive) / LT (slice), the harder the faster; A swings (and tosses), X slices, Y switches
// the camera. Mouse, keyboard, camera and phone keep working alongside.
import { clamp, Clock, Settings } from './core.js';
import { Input } from './input.js';
import { Sound } from './match.js';
import { Game } from './game.js';
import { UI } from './ui.js';
import { Bus } from './events.js';
import { Nav, Options } from './options.js';

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
// Button names by layout (the standard mapping is by position: 0 is the bottom face button on every pad).
const GLYPHS = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', start: '☰', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', rs: 'R stick' },
  ps: { a: '✕', b: '○', x: '□', y: '△', start: 'Options', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', rs: 'R stick' },
  nintendo: { a: 'B', b: 'A', x: 'Y', y: 'X', start: '+', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', rs: 'R stick' },
};
const LAYOUT_NAME = { xbox: 'Xbox-style', ps: 'PlayStation', nintendo: 'Nintendo-style' };
const STICK_DEAD = 0.3, STICK_HIT = 0.82, TRIG_REST = 0.2, TRIG_HIT = 0.75;
// Power from how fast the stick / trigger travelled (full travel per second): a lazy push ~4, a hard flick 20+.
const flickPower = (speed) => clamp(0.3 + speed * 0.032, 0.35, 0.96);

const Pad = {
  id: '', kind: 'xbox', active: false, gp: null, prev: null, rep: {}, rs: null, trig: [null, null], started: false,
  init() {
    if (this.started || !navigator.getGamepads) return;
    this.started = true;
    const loop = (t) => { requestAnimationFrame(loop); try { this.poll(t); } catch (e) { console.warn('[pad]', e); } };
    requestAnimationFrame(loop);
    // Mouse or keyboard use hands the on-screen button names back to them.
    addEventListener('keydown', () => this.setActive(false), true);
    addEventListener('pointerdown', () => this.setActive(false), true);
    addEventListener('mousemove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) this.setActive(false); });
    addEventListener('gamepaddisconnected', () => { if (this.active && Game.mode === 'cpu' && UI.screen === null) UI.pause(); });
    Bus.on('hit', (e) => { if (e.local && e.human && this.active) this.rumble(clamp((e.kmh || 80) / 200, 0.2, 0.8), 70); });
    const btnMenu = document.getElementById('btnMenu');
    if (btnMenu) {
      for (const k of btnMenu.querySelectorAll('kbd')) k.classList.add('kb-hint');
      btnMenu.insertAdjacentHTML('beforeend', '<span class="pg pad-hint" data-g="start"></span>');
    }
  },
  find() {
    let best = null;
    for (const p of navigator.getGamepads() || []) {
      if (!p || !p.connected || !(p.mapping === 'standard' || (p.buttons.length >= 12 && p.axes.length >= 4))) continue;
      if (!best || (p.timestamp || 0) > (best.timestamp || 0)) best = p;   // the one used last
    }
    return best;
  },
  poll(tMs) {
    const gp = this.find();
    this.gp = gp;
    if (!gp) { if (this.id) { this.id = ''; this.prev = null; this.setActive(false); this.status(); } return; }
    if (gp.id !== this.id) {
      this.id = gp.id; this.prev = null;
      this.kind = /054c|playstation|dualshock|dualsense|wireless controller/i.test(gp.id) ? 'ps' : /057e|nintendo|pro controller|joy-con/i.test(gp.id) ? 'nintendo' : 'xbox';
      this.status();
    }
    const down = gp.buttons.map((b) => !!(b && (b.pressed || b.value > 0.5))), was = this.prev || down;   // held at first sight: not a press
    this.prev = down;
    const hit = (i) => down[i] && !was[i], ax = gp.axes, lx = ax[0] || 0, ly = ax[1] || 0, rx = ax[2] || 0, ry = ax[3] || 0;
    if (!this.active && (down.some((d, i) => d && !was[i]) || Math.hypot(lx, ly) > 0.5 || Math.hypot(rx, ry) > 0.5)) this.setActive(true);
    const now = tMs / 1000, inMatch = Game.mode === 'cpu' || Game.mode === 'online';
    if (hit(BTN.START) && inMatch && (UI.screen === null || UI.screen === 'pause')) { UI.togglePause(); return; }
    if (UI.screen === null && Game.inPlay()) this.play(gp, down, hit, lx, rx, ry, now);
    else { this.rs = null; this.trig = [null, null]; this.menu(down, hit, lx, ly, now); }
  },
  menu(down, hit, lx, ly, now) {
    const d = { up: down[BTN.UP] || ly < -0.55, down: down[BTN.DOWN] || ly > 0.55, left: down[BTN.LEFT] || lx < -0.55, right: down[BTN.RIGHT] || lx > 0.55 };
    for (const k in d) {
      if (!d[k]) { this.rep[k] = 0; continue; }
      if (!this.rep[k]) { this.rep[k] = now + 0.38; Nav.dir(k); }   // held: repeat after a pause, like a key
      else if (now >= this.rep[k]) { this.rep[k] = now + 0.11; Nav.dir(k); }
    }
    if (hit(BTN.A)) Nav.activate();
    if (hit(BTN.B)) Nav.back();
    if (UI.screen === 'options') { if (hit(BTN.LB)) Options.stepTab(-1); if (hit(BTN.RB)) Options.stepTab(1); }
  },
  play(gp, down, hit, lx, rx, ry, now) {
    const aim = (dx) => 0.5 + 0.3 * clamp(dx, -1, 1);
    if (hit(BTN.A)) this.swing(0.6, 0.4, aim(lx) + (Math.random() - 0.5) * 0.12);
    if (hit(BTN.X)) this.swing(0.42, -0.85, aim(lx));
    if (hit(BTN.Y)) { Settings.cam = Settings.cam === 'tv' ? 'player' : 'tv'; Settings.save(); }
    // Triggers: analog travel speed from rest to past the hit point.
    [BTN.RT, BTN.LT].forEach((i, n) => {
      const b = gp.buttons[i], v = b ? (b.value || (b.pressed ? 1 : 0)) : 0, s = this.trig[n];
      if (v < TRIG_REST) { this.trig[n] = { v, t: now, armed: true }; return; }
      if (!s || !s.armed || v < TRIG_HIT) return;
      s.armed = false;
      const p = flickPower((v - s.v) / Math.max(0.012, now - s.t));
      if (n === 0) this.swing(p, 0.45, aim(lx)); else this.swing(Math.min(p, 0.75), -0.85, aim(lx));
    });
    // Right stick: a flick from the middle out to the edge.
    const r = Math.hypot(rx, ry);
    if (r < STICK_DEAD) { this.rs = { x: rx, y: ry, t: now, armed: true }; return; }
    const s = this.rs;
    if (!s || !s.armed || r < STICK_HIT) return;
    s.armed = false;
    const dx = rx - s.x, dy = ry - s.y, m = Math.hypot(dx, dy) || 1;
    this.swing(flickPower((r - Math.hypot(s.x, s.y)) / Math.max(0.012, now - s.t)), clamp(0.3 - (dy / m) * 1.1, -1, 1), aim(dx / m));
  },
  // The same swing a click or key press makes (game.js treats 'pad' like them), at the moment it was made.
  swing(power, spin, x) {
    Sound.init();
    Input.emit({ type: 'swing', swing: { t0: Clock.now(), peak: 0, power, spin, vx: 0, vy: 0, src: 'pad', x: clamp(x, 0, 1), y: 0.5 } });
  },
  rumble(k, ms) {
    const a = this.gp && this.gp.vibrationActuator;
    if (!a || !a.playEffect) return;
    try { a.playEffect('dual-rumble', { duration: ms, strongMagnitude: k, weakMagnitude: Math.min(1, k * 1.3) }).catch(() => {}); } catch (e) { /* no rumble */ }
  },
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    const h = document.documentElement;
    h.classList.toggle('pad', on);
    h.dataset.pad = this.kind;
    if (on) this.glyphs(document);
    UI.prompt();
  },
  glyph(k) { return (GLYPHS[this.kind] || GLYPHS.xbox)[k] || k.toUpperCase(); },
  glyphs(root) { for (const el of root.querySelectorAll('[data-g]')) el.textContent = this.glyph(el.dataset.g); },
  statusHTML() {
    return this.id ? `<b>${LAYOUT_NAME[this.kind]} controller connected.</b> Menus and matches both work with it.` : 'No controller found. Plug one in (or turn it on) and press any button.';
  },
  status() {
    const el = document.getElementById('padStatus');
    if (el) el.innerHTML = this.statusHTML();
    this.glyphs(document);
  },
};

export { Pad, GLYPHS };
