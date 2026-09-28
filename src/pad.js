// Palm Court: game controllers. PlayStation, Xbox, Switch Pro, Steam Deck / Steam Input: any pad the browser reports
// in the "standard" layout (a PlayStation pad that Firefox reports raw is remapped by its id, see padmap.js).
// Menus: D-pad or left stick moves the focus, ✕/A picks, ○/B goes back, L1/R1 switch Settings tabs, Options/Start pauses.
// Matches, Buttons scheme (Settings.padScheme 'buttons', the default): hold a shot button to charge and let go as the
// ball arrives: the release is the swing, timed by the pad's own timestamp. ✕ flat, ○ topspin, □ slice, △ lob, L1+□
// drop shot, R1 held too for the riskier power version. The left stick at the release aims: sideways the direction, up
// deeper, down a short angle, centred a safe middle ball. Serve: press a shot button to toss, let go near the top (✕
// flat, ○ kick, □ slice; the stick: wide / body / T). Touchpad / Share / View switches the camera.
// Stick flick scheme ('flick', as before): flick the right stick to swing (its speed is the power, up topspin, down
// slice), or pull RT (drive) / LT (slice); A swings (and tosses), X slices, Y the camera; the left stick aims.
// Settings: padScheme, padSwap (aim with the right stick, flick with the left), padMeter, padRumble. Mouse, keyboard,
// camera and phone keep working alongside.
import { Vector3 } from 'three';
import { clamp, Clock, Settings } from './core.js';
import { Input } from './input.js';
import { Sound } from './match.js';
import { Game } from './game.js';
import { UI, STEPS } from './ui.js';
import { Bus } from './events.js';
import { Nav, Options } from './options.js';
import { camera } from './render/world.js';
import { BTN, NB, GLYPHS, LAYOUT_NAME, FACE, SHOTS, SERVES, SERVE_BEST, glyph as glyphOf, padKind, padLayout, newPadState, normalize, shotFor, serveFor, chargeOf, holdPower, servePower, serveAim, serveWhere, stickAim, aimWords } from './padmap.js';

const DEFAULTS = { padScheme: 'buttons', padSwap: false, padMeter: true, padRumble: true, padHits: 0 };
for (const k in DEFAULTS) if (Settings[k] === undefined) Settings[k] = DEFAULTS[k];
const STICK_DEAD = 0.3, STICK_HIT = 0.82, TRIG_REST = 0.2, TRIG_HIT = 0.75;
// Stick flick: power from how fast the stick / trigger travelled (full travel per second): a lazy push ~4, a hard flick 20+.
const flickPower = (speed) => clamp(0.3 + speed * 0.032, 0.35, 0.96);
const HINT_HITS = 25;   // in-match hints until a player has hit this many balls with a controller
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DIRS = [['up', BTN.UP, 1, -1], ['down', BTN.DOWN, 1, 1], ['left', BTN.LEFT, 0, -1], ['right', BTN.RIGHT, 0, 1]];
const V = new Vector3();

const Pad = {
  id: '', kind: 'xbox', layout: 'standard', mapping: '', active: false, gp: null, started: false, known: false,
  S: newPadState(), P: new Uint8Array(NB), E: new Uint8Array(NB), fresh: false, rep: {}, rs: null, trig: [null, null],
  charge: null, sentAt: -9, offerNo: false, hudKey: '', tipKey: '', seen: {},
  init() {
    if (this.started || !navigator.getGamepads) return;
    this.started = true;
    // Cheap polling: every frame while a pad is there, a few times a second otherwise (browsers only show a pad
    // once one of its buttons is pressed, and say so with gamepadconnected).
    let n = 0;
    const loop = (t) => { requestAnimationFrame(loop); if (!this.id && !this.known && ++n % 20) return; try { this.poll(t); } catch (e) { console.warn('[pad]', e); } };
    requestAnimationFrame(loop);
    addEventListener('gamepadconnected', () => { this.known = true; });
    // Mouse or keyboard use hands the on-screen button names back to them.
    addEventListener('keydown', () => this.setActive(false), true);
    addEventListener('pointerdown', () => this.setActive(false), true);
    addEventListener('mousemove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) this.setActive(false); });
    addEventListener('gamepaddisconnected', () => {
      this.known = false;
      if (this.active && Game.mode === 'cpu' && UI.screen === null) UI.pause();
    });
    Bus.on('hit', (e) => this.onHit(e));
    Bus.on('screen', ({ screen }) => { if (screen === 'menu') this.offer(); else this.unoffer(); });
    const btnMenu = $('btnMenu');
    if (btnMenu) {
      for (const k of btnMenu.querySelectorAll('kbd')) k.classList.add('kb-hint');
      btnMenu.insertAdjacentHTML('beforeend', '<span class="pg pad-hint" data-g="start"></span>');
    }
    try { this.build(); } catch (e) { console.warn('[pad] build', e); }
  },
  find() {
    let best = null;
    for (const p of navigator.getGamepads() || []) {
      if (!p || !p.connected || !(p.mapping === 'standard' || (p.buttons.length >= 12 && p.axes.length >= 4))) continue;
      if (!best || (p.timestamp || 0) > (best.timestamp || 0)) best = p;   // the one used last
    }
    return best;
  },
  // One look at the pad (tMs: the frame's time). Button edges carry the pad's own timestamp: when it reported them.
  poll(tMs) {
    const gp = this.find();
    this.gp = gp;
    if (!gp) { if (this.id) { this.id = ''; this.fresh = false; this.cancel(); this.setActive(false); this.status(); this.hud(); } return; }
    if (gp.id !== this.id || gp.mapping !== this.mapping) {
      this.id = gp.id; this.mapping = gp.mapping; this.fresh = false;
      this.kind = padKind(gp.id); this.layout = padLayout(gp, navigator.userAgent || '');
      this.status();
      if (this.layout !== 'standard' && !this.seen[this.id]) { this.seen[this.id] = true; if (UI.screen === 'menu') UI.menuNote(this.layoutNote(), 'err'); }
    }
    const S = normalize(gp, this.layout, this.S), P = this.P, E = this.E;
    if (!this.fresh) { P.set(S.d); this.fresh = true; }   // held at first sight: not a press
    let any = false;
    for (let i = 0; i < NB; i++) { E[i] = S.d[i] && !P[i] ? 1 : !S.d[i] && P[i] ? 2 : 0; if (E[i] === 1) any = true; }
    P.set(S.d);
    const ax = S.ax;
    if (!this.active && (any || Math.hypot(ax[0], ax[1]) > 0.5 || Math.hypot(ax[2], ax[3]) > 0.5)) this.setActive(true);
    // The pad's time of this report when it's sane (not ahead of us, not stale), else now.
    const nowMs = Clock.perf() * 1000, ts = +gp.timestamp, tEv = ts > nowMs - 250 && ts <= nowMs + 8 ? ts : nowMs;
    this.route(S, E, tEv, tMs / 1000);
    this.hud();
  },
  route(S, E, tEv, now) {
    const inMatch = Game.mode === 'cpu' || Game.mode === 'online';
    if (E[BTN.START] === 1 && inMatch && (UI.screen === null || UI.screen === 'pause')) { this.cancel(); UI.togglePause(); return; }
    if (UI.screen === null && Game.inPlay()) {
      const flick = Settings.padScheme === 'flick';
      if (E[BTN.BACK] === 1 || E[BTN.PAD] === 1 || (flick && E[BTN.Y] === 1)) { Settings.cam = Settings.cam === 'tv' ? 'player' : 'tv'; Settings.save(); }
      if (flick) this.flick(S, E, tEv); else this.buttons(S, E, tEv);
      return;
    }
    this.cancel(); this.rs = null; this.trig[0] = this.trig[1] = null;
    if (this.testing()) this.test(S, E, tEv, now); else this.menu(S, E, now);
    if (UI.screen === 'setup' && Settings.control === 'pad') this.cardLive(S, tEv);
  },
  menu(S, E, now) {
    const lx = S.ax[0], ly = S.ax[1];
    for (const [k, b, axis, sgn] of DIRS) {
      const on = S.d[b] || (axis ? ly : lx) * sgn > 0.55;
      if (!on) { this.rep[k] = 0; continue; }
      if (!this.rep[k]) { this.rep[k] = now + 0.38; Nav.dir(k); }   // held: repeat after a pause, like a key
      else if (now >= this.rep[k]) { this.rep[k] = now + 0.11; Nav.dir(k); }
    }
    if (E[BTN.A] === 1) Nav.activate();
    if (E[BTN.B] === 1) Nav.back();
    if (UI.screen === 'options') { if (E[BTN.LB] === 1) Options.stepTab(-1); if (E[BTN.RB] === 1) Options.stepTab(1); }
  },

  // ---- Buttons scheme ----
  buttons(S, E, tEv) {
    const me = Game.me();
    if (!me || me.ctl !== 'human') return;
    if (this.charge && !this.charge.serve && Game.state === 'dead') this.charge = null;   // the point ended while charging
    for (const b of FACE) if (E[b] === 1) this.press(b, tEv);
    const c = this.charge;
    if (c && !S.d[c.btn]) this.release(c, tEv);
    else if (c && Game.state === 'rally' && me.plan && Game.ball.lastHitter !== me.idx) me.windAt = Clock.now();   // the racket goes back while charging
  },
  // A shot button went down: start charging (and toss, when it's our serve).
  press(btn, tMs) {
    const G = Game, me = G.me(), m = G.match, st = G.state;
    Sound.init();
    if (st === 'dead') { Input.emit({ type: 'toss' }); return; }   // skips a replay; nothing else between points
    if (this.charge) { this.charge.btn = btn; return; }   // another shot button while charging: that one is the shot now
    const mine = !!m && m.currentServer === me.idx;
    this.charge = { btn, t0: tMs, serve: mine && (st === 'serve' || st === 'toss') };
    if (mine && st === 'serve') Input.emit({ type: 'toss' });   // (the game holds it until the serve may start)
  },
  // The held button came up: that's the swing, at the moment it came up.
  release(c, tMs) {
    this.charge = null;
    const G = Game, me = G.me(), m = G.match, st = G.state, S = this.S;
    if (!me || !m) return;
    const t0 = Clock.fromPerf(tMs / 1000), risk = !!S.d[BTN.RB], aim = this.aim(), mine = m.currentServer === me.idx;
    if (mine && st === 'serve') return;   // let go before the toss went up: press again to hit it
    if (mine && st === 'toss') {
      const type = serveFor(c.btn), a = serveAim(aim.x);
      this.send(t0, servePower(t0 - G.tossT, type, risk), 0.4, { x: 0.2 + 0.6 * a, y: 0.3, pad: { shot: type, serve: true, risk, handed: me.handed } });
      return;
    }
    const shot = shotFor(c.btn, !!S.d[BTN.LB]), hold = Math.max(0, (tMs - c.t0) / 1000);
    this.send(t0, holdPower(hold, shot, risk), SHOTS[shot].spin, { x: 0.5, y: 0.5, drop: shot === 'drop', pad: { shot, risk, ax: aim.x, ay: aim.y, hold } });
  },
  send(t0, power, spin, more) {
    this.sentAt = Clock.now();
    Input.emit({ type: 'swing', swing: { t0, peak: 0, power, spin, vx: 0, vy: 0, src: 'pad', ...more } });
  },
  cancel() { this.charge = null; },
  // The aiming stick (left, or right with Settings.padSwap) as { x -1..1, y -1 short .. 1 deep }.
  aim() { const s = Settings.padSwap ? 2 : 0; return stickAim(this.S.ax[s], this.S.ax[s + 1]); },

  // ---- Stick flick scheme ----
  flick(S, E, tEv) {
    const me = Game.me();
    if (!me || me.ctl !== 'human') return;
    const a = this.aim(), f = Settings.padSwap ? 0 : 2, rx = S.ax[f], ry = S.ax[f + 1], now = tEv / 1000;
    if (E[BTN.A] === 1) this.flickSwing(tEv, 0.6, 0.4, a.x);
    if (E[BTN.X] === 1) this.flickSwing(tEv, 0.42, -0.85, a.x);
    // Triggers: analog travel speed from rest to past the hit point.
    for (let n = 0; n < 2; n++) {
      const v = S.v[n ? BTN.LT : BTN.RT], s = this.trig[n];
      if (v < TRIG_REST) { this.trig[n] = { v, t: now, armed: true }; continue; }
      if (!s || !s.armed || v < TRIG_HIT) continue;
      s.armed = false;
      const p = flickPower((v - s.v) / Math.max(0.012, now - s.t));
      if (n === 0) this.flickSwing(tEv, p, 0.45, a.x); else this.flickSwing(tEv, Math.min(p, 0.75), -0.85, a.x);
    }
    // The flick stick: from the middle out to the edge.
    const r = Math.hypot(rx, ry);
    if (r < STICK_DEAD) { this.rs = { x: rx, y: ry, t: now, armed: true }; return; }
    const s = this.rs;
    if (!s || !s.armed || r < STICK_HIT) return;
    s.armed = false;
    const dx = rx - s.x, dy = ry - s.y, m = Math.hypot(dx, dy) || 1;
    this.flickSwing(tEv, flickPower((r - Math.hypot(s.x, s.y)) / Math.max(0.012, now - s.t)), clamp(0.3 - (dy / m) * 1.1, -1, 1), a.x || (dx / m) * 0.9);
  },
  // The same swing a click or key press makes (game.js treats 'pad' like them), at the moment it was made.
  flickSwing(tMs, power, spin, ax) {
    Sound.init();
    this.send(Clock.fromPerf(tMs / 1000), power, spin, { x: clamp(0.5 + 0.3 * ax, 0, 1), y: 0.5, aim: clamp(ax, -1, 1) });
  },

  // ---- feel: rumble ----
  // On contact, stronger for a bigger hit; a perfectly timed release gets a small tick first.
  onHit(e) {
    if (!e.local || !e.human) return;
    const mine = Clock.now() - this.sentAt < 1.5;   // a controller swing made this hit
    if (mine && (Settings.padHits || 0) < 999) { Settings.padHits = (Settings.padHits || 0) + 1; if (Settings.padHits <= HINT_HITS + 1 || Settings.padHits % 20 === 0) Settings.save(); }
    if (!this.active) return;
    const k = clamp(((e.kmh || 80) - 40) / 150, 0.15, 1), perfect = mine && (e.serve ? (e.q ?? 0) >= 0.98 : Math.abs(e.tau ?? 9) < 0.2);
    if (perfect) { this.rumble(0, 0.8, 24); setTimeout(() => this.rumble(k, k * 0.7, 50 + 70 * k), 40); }
    else this.rumble(k, Math.min(1, k * 1.2), 50 + 70 * k);
  },
  rumble(strong, weak, ms) {
    const a = this.gp && this.gp.vibrationActuator;
    if (!a || !a.playEffect || Settings.padRumble === false) return;
    try { a.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(ms), strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }).catch(() => {}); } catch (e) { /* no rumble */ }
  },

  // ---- the charge meter by the player, and hints for new players ----
  hud() {
    const el = this.meterEl;
    if (!el) return;
    const G = Game, me = G.me(), c = this.charge, playing = UI.screen === null && G.inPlay() && !!me && me.ctl === 'human';
    const buttons = Settings.padScheme !== 'flick', on = playing && buttons && !!c && Settings.padMeter !== false;
    if (on) this.drawMeter(me, c); else if (!el.hidden) { el.hidden = true; this.hudKey = ''; }
    const tip = playing && (this.active || Settings.control === 'pad') && (Settings.padHits || 0) < HINT_HITS ? this.tipText(me, c, buttons) : '';
    if (tip !== this.tipKey) { this.tipKey = tip; this.tipEl.innerHTML = tip; this.tipEl.hidden = !tip; if (tip) this.glyphs(this.tipEl); }
  },
  drawMeter(me, c) {
    const el = this.meterEl, G = Game, now = Clock.perf() * 1000, S = this.S, aim = this.aim(), risk = !!S.d[BTN.RB];
    const serve = G.state === 'toss' && G.match.currentServer === me.idx;
    let fill, zone = '', g, name, note, dx, dy;
    if (serve) {
      const since = Clock.now() - G.tossT, type = serveFor(c.btn), a = serveAim(aim.x), court = G.match.court;
      fill = clamp(since / 1.0, 0, 1); zone = `${SERVE_BEST[0]}|${SERVE_BEST[1]}`; g = SERVES[type].g; name = SERVES[type].name;
      note = serveWhere(a, court) + (risk ? ' · power' : '');
      const lx = court === 'deuce' ? -3.55 + 3.2 * a : 0.35 + 3.2 * a;
      dx = 50 + (lx / 4.115) * 46; dy = 100 - (5.3 / 11.885) * 100;
    } else if (G.match.currentServer === me.idx && G.state === 'serve') {
      fill = 0; g = SERVES[serveFor(c.btn)].g; name = 'Toss…'; note = ''; dx = 50; dy = 55;
    } else {
      const shot = shotFor(c.btn, !!S.d[BTN.LB]), stroke = me.plan ? me.plan.stroke : 'fh';
      fill = holdPower((now - c.t0) / 1000, shot, risk); g = SHOTS[shot].g; name = SHOTS[shot].name;
      note = (risk && shot !== 'drop' ? 'Power · ' : '') + aimWords(aim.x, aim.y, stroke, me.handed);
      const up = Math.max(0, aim.y), dn = Math.max(0, -aim.y), side = Math.abs(aim.x);
      let xm = aim.x * (risk ? 3.6 : 2.8), dm = shot === 'drop' ? 3 : 9.3 + 1.1 * up;
      if (dn && shot !== 'drop') { dm = 9.3 + (6.1 - 9.3) * dn; xm = Math.sign(aim.x) * (Math.abs(xm) + (3.5 - Math.abs(xm)) * side * dn); }
      dx = 50 + (xm / 4.115) * 46; dy = 100 - (dm / 11.885) * 100;
    }
    // By the player, on their right (on their left near the right edge).
    V.set(me.x, 1.2, me.z).project(camera);
    const W = innerWidth, H = innerHeight, px = (V.x + 1) * 0.5 * W, py = (1 - V.y) * 0.5 * H, w = this.meterW || (this.meterW = el.offsetWidth) || 150;
    const x = px + 44 + w > W - 8 ? px - 44 - w : px + 44, y = clamp(py - 60, 8, H - 110);
    const key = `${g}|${name}|${note}|${zone}|${risk}`;
    if (key !== this.hudKey) {
      this.hudKey = key;
      el.querySelector('.pm-shot').innerHTML = `<span class="pg" data-g="${g}"></span>${esc(name)}`;
      el.querySelector('.pm-note').textContent = note;
      const z = el.querySelector('.pm-zone');
      z.hidden = !zone;
      if (zone) { const [a, b] = zone.split('|').map(Number); z.style.bottom = `${a * 100}%`; z.style.height = `${(b - a) * 100}%`; }
      el.classList.toggle('risk', risk);
      this.glyphs(el);
      this.meterW = 0;   // (measured again once shown)
    }
    el.style.transform = `translate(${Math.round(clamp(x, 8, W - w - 8))}px, ${Math.round(y)}px)`;
    el.style.setProperty('--f', fill.toFixed(3));
    el.style.setProperty('--dx', `${clamp(dx, 4, 96).toFixed(1)}%`); el.style.setProperty('--dy', `${clamp(dy, 4, 96).toFixed(1)}%`);
    el.classList.toggle('full', !serve && fill > 0.95);
    if (el.hidden) el.hidden = false;
  },
  tipText(me, c, buttons) {
    const G = Game, b = G.ball, st = G.state, g = (k) => `<span class="pg" data-g="${k}"></span>`;
    if (st !== 'rally' || !me.plan || b.lastHitter === me.idx || b.lastHitter < 0 || me.hitFor === b.rally) return '';
    if (!buttons) return `Flick ${g('rs')} as the ball arrives: up for topspin, down to slice · ${g('rt')} drive`;
    if (c) return `Let go as the ball arrives · ${g(Settings.padSwap ? 'rs' : 'ls')} aims`;
    return `Hold ${g('b')} topspin, ${g('a')} flat or ${g('x')} slice · let go as the ball arrives`;
  },
  // The serve prompt (ui.js prompt) when a controller is in use.
  servePrompt() {
    if (Settings.padScheme === 'flick') return `Press ${this.glyph('a')} to toss`;
    return `Hold ${this.glyph('a')} flat, ${this.glyph('b')} kick or ${this.glyph('x')} slice to toss · let go at the top`;
  },

  // ---- controller test and controls card (the camera check screen when Controls is Controller) ----
  testing() { return UI.screen === 'setup' && Settings.control === 'pad' && !!this.cardEl && document.activeElement === this.cardEl; },
  // The check opens (on) or closes: the card takes the focus, so the buttons test shots until the D-pad moves away.
  check(on) {
    const el = this.cardEl;
    if (!el) return;
    el.hidden = !on;
    if (!on) return;
    el.innerHTML = this.cardHTML(true);
    this.glyphs(el);
    this.testCharge = null;
    $('swingLog').textContent = this.id ? 'Press the shot buttons to try them. D-pad down, then ✕, for Done.'.replace('✕', this.glyph('a')) : 'No controller yet: plug one in (or turn it on) and press any button.';
    setTimeout(() => { if (!el.hidden) Nav.focus(el); }, 0);
  },
  test(S, E, tEv, now) {
    // D-pad: move out of the card (then ✕ / ○ work as in any menu); Options: Done.
    for (const [k, b] of DIRS) if (E[b] === 1) Nav.dir(k);
    if (E[BTN.START] === 1) { const d = $('btnSetupDone'); if (d) d.click(); return; }
    for (const b of FACE) if (E[b] === 1) { Sound.init(); this.testCharge = { btn: b, t0: tEv }; }
    const c = this.testCharge;
    if (c && !S.d[c.btn]) {
      this.testCharge = null;
      const shot = shotFor(c.btn, !!S.d[BTN.LB]), risk = !!S.d[BTN.RB], hold = (tEv - c.t0) / 1000, aim = this.aim(), p = holdPower(hold, shot, risk);
      $('swingLog').innerHTML = `<span class="pg" data-g="${SHOTS[shot].g}"></span> <b>${SHOTS[shot].name}</b>${risk && shot !== 'drop' ? ' · power' : ''} · ${Math.round(p * 100)}% power (held ${hold.toFixed(2)} s) · ${aimWords(aim.x, aim.y, 'fh', Settings.handed)} · serve: ${SERVES[serveFor(c.btn)].name.toLowerCase()}`;
      this.glyphs($('swingLog'));
      this.rumble(0.25 + 0.5 * chargeOf(hold), 0.4, 60);
    }
  },
  // The card follows the pad live: buttons held light up, the charge fills, the dot shows the stick's aim.
  cardLive(S, tEv) {
    const el = this.cardEl;
    if (!el || el.hidden) return;
    for (const b of el.querySelectorAll('[data-b]')) b.classList.toggle('on', !!S.d[+b.dataset.b]);
    const c = this.testCharge, aim = this.aim();
    el.style.setProperty('--f', c ? holdPower((tEv - c.t0) / 1000, shotFor(c.btn, !!S.d[BTN.LB]), !!S.d[BTN.RB]).toFixed(3) : '0');
    el.style.setProperty('--dx', `${(50 + aim.x * 42).toFixed(1)}%`); el.style.setProperty('--dy', `${(50 - aim.y * 40).toFixed(1)}%`);
  },
  cardHTML(live) {
    const g = (k) => `<span class="pg" data-g="${k}"></span>`, b = (i, k, t) => `<span class="pc-b" data-b="${i}">${g(k)}<small>${t}</small></span>`;
    const stick = Settings.padSwap ? 'rs' : 'ls';
    if (Settings.padScheme === 'flick') {
      return `<p class="pc-title">Stick flick</p><dl class="pc-list"><dt>${g(Settings.padSwap ? 'ls' : 'rs')}</dt><dd>Flick to swing: faster is harder, up for topspin, down to slice</dd><dt>${g('rt')} ${g('lt')}</dt><dd>Drive / slice, the harder you pull the faster</dd><dt>${g('a')} ${g('x')}</dt><dd>Swing (and toss) / slice</dd><dt>${g(stick)}</dt><dd>Aims</dd><dt>${g('start')} ${g('back')}</dt><dd>Pause · camera</dd></dl>`;
    }
    return `<div class="pc-top"><div class="pc-face" aria-hidden="true">${b(3, 'y', 'Lob')}${b(2, 'x', 'Slice')}${b(1, 'b', 'Topspin')}${b(0, 'a', 'Flat')}</div>${live ? '<div class="pc-live" aria-hidden="true"><div class="pm-bar"><i></i></div><div class="pm-court"><i></i></div></div>' : ''}</div>
      <dl class="pc-list">
        <dt>Hold, let go</dt><dd>Hold a shot button to charge it, let go as the ball arrives: the release is your timing. A tap is a solid medium ball.</dd>
        <dt>${g('lb')}+${g('x')}</dt><dd>Drop shot</dd>
        <dt>${g('rb')}+shot</dt><dd>Power: harder and nearer the lines (riskier)</dd>
        <dt>${g(stick)}</dt><dd>Aim: ← → direction, ↑ deeper, ↓ short angle, centred a safe middle ball</dd>
        <dt>Serve</dt><dd>Press to toss, let go at the top: ${g('a')} flat, ${g('b')} kick, ${g('x')} slice. ${g(stick)} wide / body / T</dd>
        <dt>${g('start')} ${g('back')}</dt><dd>Pause · camera view</dd>
      </dl>`;
  },

  // ---- offering the controller when one turns up ----
  offer() {
    if (this.offerNo || !this.id || Settings.control === 'pad' || UI.screen !== 'menu' || $('padOffer')) return;
    const acts = $('menu') && $('menu').querySelector('.actions');
    if (!acts) return;
    acts.insertAdjacentHTML('afterend', `<aside class="pad-offer" id="padOffer"><p><b>${LAYOUT_NAME[this.kind]} controller found.</b> Play with it? Hold ${this.glyphHTML('b')} ${this.glyphHTML('a')} ${this.glyphHTML('x')} or ${this.glyphHTML('y')} and let go as the ball arrives; the left stick aims.</p><div class="row"><button type="button" class="btn small primary" id="btnPadYes">Use the controller</button><button type="button" class="btn small ghost" id="btnPadNo">Not now</button></div></aside>`);
    this.glyphs($('padOffer'));
    $('btnPadYes').onclick = () => { UI.setControl('pad'); this.unoffer(); UI.menuNote(`Controller on. Test it (and see every button) under ${$('btnSetup').textContent}.`); $('btnPractice').focus({ preventScroll: true }); };
    $('btnPadNo').onclick = () => { this.offerNo = true; this.unoffer(); $('btnPractice').focus({ preventScroll: true }); };
    Nav.focus($('btnPadYes'));
  },
  unoffer() { const o = $('padOffer'); if (o) o.remove(); },

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    const h = document.documentElement;
    h.classList.toggle('pad', on);
    h.dataset.pad = this.kind;
    if (on) { this.glyphs(document); this.offer(); }
    UI.prompt();
  },
  glyph(k) { return glyphOf(this.kind, k); },
  glyphHTML(k) { return `<span class="pg" data-g="${k}">${esc(this.glyph(k))}</span>`; },
  glyphs(root) { for (const el of root.querySelectorAll('[data-g]')) el.textContent = this.glyph(el.dataset.g); },
  layoutNote() {
    return this.layout === 'unknown' ? 'This browser doesn’t report your controller’s standard button layout, so buttons may be mixed up. Chrome or Edge work best.'
      : `This browser reports your ${LAYOUT_NAME[this.kind]} controller in its raw layout: Palm Court remapped it. If a button does the wrong thing, play in Chrome or Edge.`;
  },
  statusHTML() {
    if (!this.id) return 'No controller found. Plug one in (or turn it on) and press any button.';
    const using = Settings.control === 'pad' ? 'Controls: <b>Controller</b>.' : 'Menus and matches both work with it; pick <b>Controller</b> under Swing with for its own shot buttons.';
    return `<b>${LAYOUT_NAME[this.kind]} controller connected.</b> ${using}${this.layout !== 'standard' ? ` <span class="pad-warn">${esc(this.layoutNote())}</span>` : ''}`;
  },
  status() {
    const el = $('padStatus');
    if (el) el.innerHTML = this.statusHTML();
    this.glyphs(document);
    if (!this.id) this.unoffer();
  },

  // ---- DOM: the meter, the hint line, the test card, the How to play line and their styles ----
  build() {
    const css = document.createElement('style');
    css.id = 'padCss';
    css.textContent = CSS;
    document.head.append(css);
    const hud = $('hud');
    if (hud) {
      hud.insertAdjacentHTML('beforeend', '<div class="pad-meter" id="padMeter" hidden aria-hidden="true"><div class="pm-bar"><i></i><b class="pm-zone" hidden></b></div><div class="pm-info"><p class="pm-shot"></p><div class="pm-court"><i></i></div><p class="pm-note"></p></div></div><p class="pad-tip" id="padTip" hidden></p>');
      this.meterEl = $('padMeter'); this.tipEl = $('padTip');
    }
    const slot = $('camSlot');
    if (slot) { slot.insertAdjacentHTML('beforeend', '<div class="pad-card" id="padCard" tabindex="0" role="group" aria-label="Controller test: press the shot buttons to try them" hidden></div>'); this.cardEl = $('padCard'); }
    const how = document.querySelector('#menu details.howto ul');
    if (how) how.insertAdjacentHTML('beforeend', `<li id="padHowto"><b>Controller:</b> hold ${this.glyphHTML('a')} flat, ${this.glyphHTML('b')} topspin, ${this.glyphHTML('x')} slice or ${this.glyphHTML('y')} lob (${this.glyphHTML('lb')}+${this.glyphHTML('x')} drop shot, ${this.glyphHTML('rb')} for power) and let go as the ball arrives; the left stick aims. To serve, press to toss and let go at the top.</li>`);
    STEPS.pad = `<li><b>Hold a shot button, let go as the ball arrives.</b> The release is your swing: early pulls the ball across, late pushes it the other way.</li><li><b>${this.glyphHTML('a')} flat, ${this.glyphHTML('b')} topspin, ${this.glyphHTML('x')} slice, ${this.glyphHTML('y')} lob.</b> ${this.glyphHTML('lb')}+${this.glyphHTML('x')} is a drop shot; hold ${this.glyphHTML('rb')} too for a harder, riskier ball.</li><li><b>The left stick aims:</b> sideways for the direction, up for deep, down for a short angle, centred for a safe ball.</li><li><b>Firefox</b> may report a controller in its raw layout: if buttons feel mixed up, use Chrome or Edge.</li>`;
  },
};

const CSS = `
.pad-meter { position: absolute; left: 0; top: 0; display: grid; grid-template-columns: 10px auto; gap: 8px; padding: 8px 10px 8px 8px; background: rgba(8,18,29,.66); border: 1px solid var(--edge); border-radius: 8px; will-change: transform; }
.pm-bar { position: relative; width: 10px; height: 76px; border-radius: 5px; background: rgba(242,245,238,.14); }
.pm-bar i { position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--f, 0) * 100%); border-radius: 5px; background: linear-gradient(to top, var(--optic) 0, var(--optic) 55px, #ffb347 68px, var(--coral) 76px) bottom / 100% 76px no-repeat; }
.pm-zone { position: absolute; left: -4px; right: -4px; border: 2px solid var(--chalk); border-radius: 4px; box-shadow: 0 0 8px rgba(242,245,238,.4); }
.pad-meter.full .pm-bar i { box-shadow: 0 0 10px var(--coral); }
.pm-info { display: grid; gap: 5px; align-content: start; min-width: 92px; }
.pm-shot { margin: 0; display: flex; align-items: center; gap: 6px; font: 700 13px/1 var(--body); white-space: nowrap; }
.pad-meter.risk .pm-shot { color: #ffb347; }
.pm-note { margin: 0; font-size: 11px; line-height: 1.2; color: var(--mist); white-space: nowrap; }
.pm-court { position: relative; width: 44px; height: 40px; border: 1.5px solid rgba(242,245,238,.55); border-bottom: 3px solid rgba(242,245,238,.8); background: linear-gradient(rgba(242,245,238,.5), rgba(242,245,238,.5)) 50% 54% / 1.5px 46% no-repeat, linear-gradient(rgba(242,245,238,.5), rgba(242,245,238,.5)) 0 54% / 100% 1.5px no-repeat, rgba(44,93,158,.55); }
.pm-court i { position: absolute; left: var(--dx, 50%); top: var(--dy, 30%); width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--optic); box-shadow: 0 0 6px var(--optic); }
.pad-tip { position: absolute; left: 50%; bottom: calc(var(--hp, 16px) + 10px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); max-width: calc(100% - 32px); margin: 0; padding: .5em 1em;
  background: var(--scrim); border: 1px solid var(--edge); font: 600 clamp(13px, calc(.25vw + 10px), 16px)/1.3 var(--body); text-align: center; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 6px; }
.pad-card { position: absolute; inset: 0; display: grid; align-content: start; gap: 12px; padding: 16px; overflow: auto; background: rgba(8,18,29,.55); border: 1px dashed var(--edge); }
.pad-card:focus-visible, html.pad .pad-card:focus { outline: 2px solid var(--optic); outline-offset: -2px; }
.pc-top { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }
.pc-face { display: grid; grid-template-columns: repeat(3, 58px); grid-template-rows: repeat(3, 34px); place-items: center; }
.pc-b { display: grid; justify-items: center; gap: 2px; font-size: 11px; color: var(--mist); }
.pc-b .pg { min-width: 28px; height: 28px; font-size: 14px; transition: transform .08s, box-shadow .08s; }
.pc-b.on .pg { transform: scale(1.18); box-shadow: 0 0 0 3px var(--optic); }
.pc-b[data-b="3"] { grid-area: 1 / 2; } .pc-b[data-b="2"] { grid-area: 2 / 1; } .pc-b[data-b="1"] { grid-area: 2 / 3; } .pc-b[data-b="0"] { grid-area: 3 / 2; }
.pc-live { display: flex; gap: 12px; align-items: end; }
.pc-live .pm-bar { height: 64px; }
.pc-live .pm-bar i { background-size: 100% 64px; }
.pc-live .pm-court { width: 56px; height: 52px; }
.pc-title { margin: 0; font-weight: 700; }
.pc-list { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 12px; font-size: 13px; align-items: center; }
.pc-list dt { color: var(--chalk); font-weight: 600; white-space: nowrap; }
.pc-list dd { margin: 0; color: var(--mist); }
#setup[data-mode="pad"] .meter { display: none; }
.pad-offer { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--optic); background: rgba(214,240,74,.08); }
.pad-offer p { margin: 0; font-size: 14px; line-height: 1.4; }
.pad-offer .row { display: flex; flex-wrap: wrap; gap: 8px; }
.pad-warn { display: block; margin-top: 4px; color: var(--coral); }
#padHowto .pg { vertical-align: baseline; }
html[data-pad="ps"] .pg[data-g="a"] { background: #6f9cf5; border-color: #6f9cf5; color: #09131d; }
html[data-pad="ps"] .pg[data-g="b"] { color: #ff8a8a; } html[data-pad="ps"] .pg[data-g="x"] { color: #f7a8e4; } html[data-pad="ps"] .pg[data-g="y"] { color: #6fe0b8; }
html[data-pad="xbox"] .pg[data-g="b"] { color: #ff8a8a; } html[data-pad="xbox"] .pg[data-g="x"] { color: #7ab7ff; } html[data-pad="xbox"] .pg[data-g="y"] { color: #ffd65a; }
@media (max-width: 640px) { .pc-list { grid-template-columns: minmax(0, 1fr); } .pc-list dt { margin-top: 4px; } }
`;

export { Pad, GLYPHS };
