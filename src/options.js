// Palm Court: the Settings screen (Gameplay, Controls, Audio, Graphics, Accessibility, About), "back" on every screen
// (Esc / controller B), menu focus moves for controllers, and publishing polish: pause when the window loses focus,
// first-launch defaults, the version in the menu footer.
import { Settings } from './core.js';
import { Sound } from './match.js';
import { Game } from './game.js';
import { UI, $ } from './ui.js';
import { Bus } from './events.js';
import { Pad } from './pad.js';

const VERSION = '0.9.0';   // menu footer + About (move to CONFIG.version once src/config.js carries one)

const seg = (key, label, opts, hint) => ({ t: 'seg', key, label, opts, hint });
const tog = (key, label, hint) => ({ t: 'tog', key, label, hint });
const rng = (key, label, min, max, step, fmt, hint) => ({ t: 'rng', key, label, min, max, step, fmt, hint });
const pct = (v) => `${Math.round(v * 100)}%`;
const msFmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 1000))} ms`;
const reduceRow = tog('reduceMotion', 'Reduce motion', 'No camera shake and fewer screen animations.');
const TABS = [
  ['gameplay', 'Gameplay', [
    seg('level', 'CPU level', [['rookie', 'Rookie'], ['club', 'Club'], ['pro', 'Pro']], 'Your default opponent strength for Practice.'),
    seg('format', 'Match length', [['tiebreak', 'Tiebreak'], ['short', 'Short set'], ['full', 'Full set']]),
    seg('surface', 'Surface', [['hard', 'Hard'], ['clay', 'Clay'], ['grass', 'Grass']]),
    seg('handed', 'Plays', [['R', 'Right-handed'], ['L', 'Left-handed']]),
    tog('assist', 'Bounce spot', 'Marks where the ball will land, to help your timing.'),
    tog('timingMeter', 'Timing meter', 'The early / late bar after each shot.'),
    tog('replays', 'Instant replays', 'Replays of aces, winners and close line calls.'),
  ]],
  ['controls', 'Controls', [
    seg('control', 'Swing with', [['mouse', 'Mouse / keys'], ['phone', 'Phone'], ['hand', 'Hand cam'], ['paddle', 'Paddle cam']], 'A controller works with any of these.'),
    { t: 'check' },
    rng('sens', 'Sensitivity', 0.6, 1.6, 0.05, (v) => `${v.toFixed(2)}×`, 'How hard a camera swing has to be to count.'),
    rng('latency', 'Timing offset', -0.1, 0.25, 0.01, msFmt, 'Raise it if your camera swings land late, lower it if early.'),
    { t: 'pad' },
    { t: 'keys' },
  ]],
  ['audio', 'Audio', [
    rng('volume', 'Master', 0, 1, 0.05, pct),
    rng('sfxVol', 'Effects', 0, 1, 0.05, pct, 'Racket, ball, net and footsteps.'),
    rng('crowdVol', 'Crowd', 0, 1, 0.05, pct),
    rng('voiceVol', 'Umpire voice', 0, 1, 0.05, pct),
    tog('voice', 'Umpire calls', 'Spoken score calls, in your system’s voice.'),
  ]],
  ['graphics', 'Graphics', [
    seg('gfx', 'Quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], 'Auto picks a preset for your computer and adjusts it as you play.'),
    seg('cam', 'Camera', [['player', 'Behind you'], ['tv', 'TV']], 'C (or controller Y) switches during a match.'),
    tog('showFps', 'Show frame rate'),
    reduceRow,
  ]],
  ['access', 'Accessibility', [
    reduceRow,
    tog('bigHud', 'Larger HUD text', 'Bigger score, calls and prompts during a match.'),
    tog('cbSafe', 'Colour-blind-safe colours', 'Blue / orange line calls and timing, and a white ball trail.'),
  ]],
  ['about', 'About', [{ t: 'about' }]],
];
const DEFAULTS = {
  level: 'club', format: 'short', surface: 'hard', handed: 'R', assist: true, timingMeter: true, replays: true, control: 'mouse', sens: 1, latency: 0.09,
  volume: 0.8, sfxVol: 1, crowdVol: 1, voiceVol: 1, voice: true, gfx: 'auto', cam: 'player', showFps: false, reduceMotion: false, bigHud: false, cbSafe: false,
};
// Screens' own way back, for Esc and controller B.
const BACK = { lobby: 'btnLobbyBack', phone: 'btnPhoneDone', setup: 'btnSetupDone', over: 'btnOverMenu' };
const FOCUSABLE = 'button, input:not([type=hidden]), select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])';
const inMatch = () => Game.mode === 'cpu' || Game.mode === 'online';

const Options = {
  tab: 'gameplay', from: 'menu', reopen: false, lastScreen: 'menu',
  init() {
    this.firstLaunch();
    this.build();
    this.applyLook();
    this.menuLinks();
    // The menu's own copies of these now live here (UI.buildSettings still builds them first).
    for (const el of [$('opt-gfx-auto') && $('opt-gfx-auto').closest('.seg'), $('optVoice') && $('optVoice').closest('.toggles'), $('optVolume') && $('optVolume').closest('.range')]) if (el) el.remove();
    Bus.on('screen', ({ screen }) => this.onScreen(screen));
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.repeat) { e.preventDefault(); Nav.back(); } });
    // A match stops while the window isn't in front (alt-tab, another app, the Steam overlay).
    addEventListener('blur', () => { if (Game.mode === 'cpu' && UI.screen === null && Game.state !== 'over') UI.pause(); });
    Pad.init();
  },
  // First launch: the OS reduced-motion preference, and a pointer to the camera controls when there is a webcam.
  // (Mouse stays the default: it needs no permission prompt and works everywhere.)
  firstLaunch() {
    if (Settings.optsV === 1) return;
    Settings.optsV = 1;
    Settings.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    Settings.save();
    if (Settings.control !== 'mouse' || matchMedia('(pointer: coarse)').matches || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then((ds) => {
      if (ds.some((d) => d.kind === 'videoinput') && Settings.control === 'mouse' && UI.screen === 'menu') UI.menuNote('Webcam found: pick Hand cam under Controls to swing with your hand.');
    }).catch(() => {});
  },
  menuLinks() {
    const btn = (id, text, cls, fn) => { const b = document.createElement('button'); b.id = id; b.className = cls; b.textContent = text; b.onclick = fn; return b; };
    $('btnSetup').after(btn('btnOpts', 'Settings', 'btn ghost', () => this.open('menu')));
    $('btnSetup2').after(btn('btnOpts2', 'Settings', 'btn', () => this.open('pause')));
    const foot = document.createElement('footer');
    foot.className = 'menu-foot'; foot.id = 'menuFoot';
    foot.innerHTML = `<span>Palm Court <b id="verText">v${VERSION}</b></span><button type="button" class="linkish" id="btnAbout">About &amp; credits</button>`;
    $('menu').querySelector('.slab').append(foot);
    $('btnAbout').onclick = () => this.open('menu', 'about');
    const keys = document.querySelector('#pause .keys');
    if (keys) {
      for (const s of keys.children) s.classList.add('kb-hint');
      keys.insertAdjacentHTML('beforeend', '<span class="pad-hint"><span class="pg" data-g="start"></span> resume</span><span class="pad-hint"><span class="pg" data-g="b"></span> resume</span><span class="pad-hint"><span class="pg" data-g="y"></span> TV / player camera</span>');
    }
  },

  // ---- the screen ----
  build() {
    const main = document.createElement('main');
    main.id = 'options'; main.className = 'screen center'; main.hidden = true;
    const tabs = TABS.map(([id, name]) => `<button type="button" class="opt-tab" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="pane-${id}" aria-selected="false" tabindex="-1">${name}</button>`).join('');
    const panes = TABS.map(([id, name, rows]) => `<section class="opt-pane" role="tabpanel" id="pane-${id}" aria-labelledby="tab-${id}" hidden><h3>${name}</h3>${rows.map((r) => this.row(r, id)).join('')}</section>`).join('');
    main.innerHTML = `<section class="slab wide opt-slab" aria-labelledby="optTitle">
      <header class="opt-head"><div><p class="eyebrow">Palm Court</p><h2 id="optTitle">Settings</h2></div>
        <p class="keys"><span class="kb-hint"><kbd>Esc</kbd> back</span><span class="pad-hint"><span class="pg" data-g="b"></span> back</span><span class="pad-hint"><span class="pg" data-g="lb"></span><span class="pg" data-g="rb"></span> tabs</span></p></header>
      <div class="opt-body"><div class="opt-tabs" role="tablist" aria-label="Settings" aria-orientation="vertical">${tabs}</div><div class="opt-panes">${panes}</div></div>
      <footer class="opt-foot"><button type="button" id="btnOptBack" class="btn primary">Back</button><button type="button" id="btnOptReset" class="btn ghost small">Reset to defaults</button></footer>
    </section>`;
    document.body.insertBefore(main, $('hud'));
    main.addEventListener('input', (e) => this.onInput(e, false));
    main.addEventListener('change', (e) => this.onInput(e, true));
    const list = main.querySelector('.opt-tabs');
    list.addEventListener('click', (e) => { const b = e.target.closest('.opt-tab'); if (b) this.show(b.dataset.tab, true); });
    list.addEventListener('keydown', (e) => {
      const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (k) { e.preventDefault(); this.stepTab(k); } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); this.show(TABS[e.key === 'Home' ? 0 : TABS.length - 1][0], true); }
    });
    $('btnOptBack').onclick = () => this.close();
    $('btnOptReset').onclick = () => this.reset();
    $('optCheck').onclick = () => { this.reopen = true; UI.openControls(this.from); };
    $('btnResetAll').onclick = () => this.reset($('btnResetAll'));
    this.show(this.tab);
  },
  row(r, tab) {
    const id = `set-${tab}-${r.key}`, hint = r.hint ? `<span class="hint">${r.hint}</span>` : '';
    if (r.t === 'seg') return `<div class="opt-row" role="radiogroup" aria-labelledby="${id}"><span class="lbl" id="${id}">${r.label}</span><div class="opts">${r.opts.map(([v, t]) => `<label><input type="radio" name="${id}" value="${v}" data-key="${r.key}">${t}</label>`).join('')}</div>${hint}</div>`;
    if (r.t === 'tog') return `<label class="opt-row"><span class="lbl">${r.label}</span><span class="switch"><input type="checkbox" role="switch" id="${id}" data-key="${r.key}"></span>${hint}</label>`;
    if (r.t === 'rng') return `<label class="opt-row" for="${id}"><span class="lbl">${r.label}</span><span class="ctl"><input type="range" id="${id}" min="${r.min}" max="${r.max}" step="${r.step}" data-key="${r.key}"><output data-out="${r.key}"></output></span>${hint}</label>`;
    if (r.t === 'check') return `<div class="opt-row"><span class="lbl">Setup</span><div><button type="button" class="btn small" id="optCheck">Camera check</button></div><span class="hint" id="optCheckHint"></span></div>`;
    if (r.t === 'pad') return '<div class="opt-row"><span class="lbl">Controller</span><p class="pad-status" id="padStatus" role="status"></p></div>';
    if (r.t === 'keys') return '<div class="keymap" id="keyMap"></div>';
    return `<div class="about"><p class="about-title">Palm Court <b>v${VERSION}</b></p><p class="fine">Motion tennis in your browser: swing a phone, your hand or a paddle at a webcam, a mouse or a controller. All players and events are fictional.</p>
      <p class="about-links"><a class="btn small" href="credits.html" target="_blank" rel="noopener">Credits</a><a class="btn small ghost" href="privacy.html" target="_blank" rel="noopener">Privacy</a><button type="button" class="btn small ghost" id="btnResetAll">Reset all settings</button></p></div>`;
  },
  open(from, tab) {
    this.from = from === 'pause' ? 'pause' : 'menu';
    this.ctl0 = Settings.control;
    this.refresh();
    UI.go('options');
    this.show(tab || this.tab);
    const t = $(`tab-${this.tab}`);
    if (t) t.focus({ preventScroll: true });
  },
  close() {
    // Swing input changed mid-match: a camera or phone needs its setup now (it returns to the pause menu), and the mouse
    // lets the webcam go.
    if (this.from === 'pause' && inMatch() && Settings.control !== this.ctl0) {
      this.ctl0 = Settings.control; this.reopen = false;
      if (Settings.control !== 'mouse') { UI.openControls('pause'); return; }
      UI.ensureControls();
    }
    UI.go(this.from);
    const b = $(this.from === 'pause' ? 'btnOpts2' : 'btnOpts');
    if (b) b.focus({ preventScroll: true });
  },
  show(tab, focus) {
    if (!TABS.some(([id]) => id === tab)) tab = 'gameplay';
    this.tab = tab;
    for (const [id] of TABS) {
      const on = id === tab, b = $(`tab-${id}`);
      b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
      $(`pane-${id}`).hidden = !on;
    }
    if (focus) $(`tab-${tab}`).focus({ preventScroll: true });
    this.refresh();
  },
  stepTab(k) {
    const i = TABS.findIndex(([id]) => id === this.tab);
    this.show(TABS[(i + k + TABS.length) % TABS.length][0], true);
  },
  onScreen(screen) {
    // Back from the camera check / phone pairing that Settings opened: come back here.
    if (this.reopen && (screen === 'menu' || screen === 'pause') && (this.lastScreen === 'setup' || this.lastScreen === 'phone')) {
      this.reopen = false;
      queueMicrotask(() => this.open(screen, 'controls'));
    } else if (screen !== 'setup' && screen !== 'phone') this.reopen = false;
    this.lastScreen = screen;
  },
  onInput(e, commit) {
    const el = e.target, key = el.dataset && el.dataset.key;
    if (!key || (el.type === 'radio' && !el.checked)) return;
    this.set(key, el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value, commit);
  },
  // Every setting applies at once and is kept (Settings.save) when the change is committed.
  set(key, v, commit = true) {
    Settings[key] = v;
    if (commit) Settings.save();
    const menu = $(`opt-${key}-${v}`);   // the menu's own row for it
    if (menu && menu.type === 'radio') menu.checked = true;
    if (key === 'control' || key === 'surface' || key === 'gfx' || key === 'tod') UI.onSetting(key);
    if (key === 'volume' || key === 'sfxVol' || key === 'crowdVol' || key === 'voiceVol') {
      Sound.setMix();
      if (commit) this.sample(key);
    }
    if (key === 'sens' || key === 'latency') { $('optSens').value = Settings.sens; $('optLatency').value = Settings.latency; UI.syncSliders(); }
    this.applyLook();
    this.refresh();
  },
  sample(key) {
    Sound.init();
    if (!Sound.ok()) return;
    if (key === 'crowdVol') Sound.applause(0.35, 0);
    else if (key === 'voiceVol') Sound.say('Fifteen love', { cancel: true });
    else Sound.hit(0.6, 4);
  },
  reset(btn) {
    if (btn && btn.dataset.armed !== '1') {   // the one in About asks first: it resets every tab
      btn.dataset.armed = '1'; btn.textContent = 'Press again to reset';
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Reset all settings'; }, 3000);
      return;
    }
    const keys = btn ? Object.keys(DEFAULTS) : TABS.find(([id]) => id === this.tab)[2].map((r) => r.key).filter((k) => k in DEFAULTS);
    for (const k of keys) if (Settings[k] !== DEFAULTS[k]) this.set(k, DEFAULTS[k], false);
    Settings.save();
    if (btn) { btn.dataset.armed = ''; btn.textContent = 'Settings reset'; }
  },
  applyLook() {
    const h = document.documentElement.classList;
    h.toggle('calm', !!Settings.reduceMotion);
    h.toggle('big-hud', !!Settings.bigHud);
    h.toggle('cb', !!Settings.cbSafe);
    h.toggle('no-timing', Settings.timingMeter === false);
  },
  refresh() {
    const root = $('options');
    if (!root) return;
    for (const el of root.querySelectorAll('[data-key]')) {
      const k = el.dataset.key, v = Settings[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'range') { if (+el.value !== +(v ?? DEFAULTS[k])) el.value = v ?? DEFAULTS[k]; }
      else if (el.type === 'radio') {
        el.checked = el.value === String(v);
        const m = $(`opt-${k}-${el.value}`);   // locked on the menu (progression) → locked here too
        el.disabled = !!(m && m.disabled);
        el.parentElement.title = m && m.parentElement.title ? m.parentElement.title : '';
      }
    }
    const fmt = Object.fromEntries(TABS.flatMap(([, , rows]) => rows.filter((r) => r.t === 'rng').map((r) => [r.key, r.fmt])));
    for (const o of root.querySelectorAll('[data-out]')) o.textContent = fmt[o.dataset.out](+(Settings[o.dataset.out] ?? DEFAULTS[o.dataset.out]));
    const c = Settings.control;
    $('optCheck').textContent = c === 'phone' ? 'Connect phone' : c === 'mouse' ? 'Try the controls' : 'Camera check';
    $('optCheckHint').textContent = c === 'phone' ? 'Pair your phone and test a swing.' : c === 'mouse' ? 'A practice pad to test clicks and keys.' : 'Light, framing, swing speed and timing, step by step.';
    $('padStatus').innerHTML = Pad.statusHTML();
    $('keyMap').innerHTML = this.keyMap();
    Pad.glyphs(root);
  },
  keyMap() {
    const kb = [['Swing', '<kbd>Space</kbd> or click'], ['Harder', '<kbd>Shift</kbd>+<kbd>Space</kbd>, or flick the mouse first'], ['Slice', '<kbd>S</kbd>'], ['Serve', 'toss, then swing'], ['Camera view', '<kbd>C</kbd>'], ['Frame rate', '<kbd>F</kbd>'], ['Pause / back', '<kbd>Esc</kbd>']];
    const g = (k) => `<span class="pg" data-g="${k}"></span>`;
    const pad = [['Swing', `flick ${g('rs')}: faster is harder, up for topspin, down for slice`], ['Swing / toss', g('a')], ['Drive / slice', `${g('rt')} / ${g('lt')}`], ['Slice', g('x')], ['Camera view', g('y')], ['Pause', g('start')], ['Menus', `D-pad, ${g('a')} select, ${g('b')} back`]];
    const dl = (title, rows) => `<div><p class="km-title">${title}</p><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl></div>`;
    return dl('Keyboard and mouse', kb) + dl('Controller', pad);
  },
};

// ---- navigation shared by the keyboard and controllers ----
const Nav = {
  // Esc / B: the screen's own way back. Every screen has one.
  back() {
    const s = UI.screen;
    if (s === null) { if (inMatch()) UI.pause(); return; }
    if (s === 'pause') { UI.resume(); return; }
    if (s === 'options') { Options.close(); return; }
    if (s === 'menu') { const d = document.querySelector('#menu details[open]'); if (d) d.open = false; return; }
    const own = BACK[s] && $(BACK[s]);
    if (own && own.getClientRects().length && !own.disabled) { own.click(); return; }
    // Screens other modules add: their Back / Done / Close button, else the menu (the pause menu mid-match).
    const scr = $(s), b = scr && [...scr.querySelectorAll('button')].find((x) => x.getClientRects().length && !x.disabled && ('back' in x.dataset || /^(back|done|close|cancel)\b/i.test(x.textContent.trim())));
    if (b) b.click();
    else if (inMatch() && Game.state !== 'over') UI.pause();
    else UI.go('menu');
  },
  root() { return UI.screen ? $(UI.screen) : null; },
  // What a controller can land on: visible, enabled controls, one per radio group (the checked one).
  focusables(root) {
    const seen = new Set(), out = [];
    for (const el of root.querySelectorAll(FOCUSABLE)) {
      if (el.disabled || !el.getClientRects().length || el.closest('[hidden], [inert]')) continue;
      if (el.type === 'radio') {
        if (seen.has(el.name)) continue;
        const group = [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)].filter((r) => !r.disabled);
        seen.add(el.name);
        out.push(group.find((r) => r.checked) || group[0] || el);
      } else out.push(el);
    }
    return out;
  },
  focus(el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); },
  start(root) {
    const els = this.focusables(root), main = els.find((e) => e.classList.contains('primary')) || els[0];
    if (main) this.focus(main);
  },
  // D-pad / stick: radios and sliders change with left / right (like arrow keys), tabs step along their list, and
  // anything else moves the focus to the nearest control that way.
  dir(d) {
    const root = this.root();
    if (!root) return;
    const cur = document.activeElement;
    if (!cur || cur === document.body || !root.contains(cur)) { this.start(root); return; }
    const side = d === 'left' || d === 'right', k = d === 'right' || d === 'down' ? 1 : -1;
    if (cur.getAttribute('role') === 'tab') {
      const list = cur.parentElement, tabs = [...list.children], vertical = tabs.length > 1 && tabs[1].getBoundingClientRect().top > tabs[0].getBoundingClientRect().top + 4;
      if (vertical !== side) { Options.stepTab(k); return; }
    }
    if (side && cur.type === 'radio') {
      const group = [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(cur.name)}"]`)].filter((r) => !r.disabled), i = group.indexOf(cur), next = group[i + k];
      if (next) { next.checked = true; next.dispatchEvent(new Event('input', { bubbles: true })); next.dispatchEvent(new Event('change', { bubbles: true })); this.focus(next); }
      return;
    }
    if (side && cur.type === 'range') {
      const step = +cur.step || 1, v = Math.min(+cur.max, Math.max(+cur.min, +cur.value + k * step));
      if (v !== +cur.value) { cur.value = v; cur.dispatchEvent(new Event('input', { bubbles: true })); cur.dispatchEvent(new Event('change', { bubbles: true })); }
      return;
    }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bs = Infinity;
    for (const el of this.focusables(root)) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      const along = side ? dx * k : dy * k, across = side ? Math.abs(dy) : Math.abs(dx);
      // Must lie that way (past the current control's edge for up / down, so a row's neighbours don't count).
      if (along <= 2 || (!side && (k > 0 ? r.top < a.bottom - 2 : r.bottom > a.top + 2))) continue;
      const s = along + across * 2.5;
      if (s < bs) { bs = s; best = el; }
    }
    if (best) this.focus(best);
  },
  // A: press the focused control.
  activate() {
    const root = this.root(), cur = document.activeElement;
    if (!root) return;
    if (!cur || cur === document.body || !root.contains(cur)) { this.start(root); return; }
    if (cur.type === 'range' || cur.type === 'text') return;
    cur.click();
  },
};

export { VERSION, Options, Nav };
