import { clamp, SURFACES, FORMATS, Clock, Settings } from './core.js';
import { Sound } from './match.js';
import { renderer, scene, camera, Crowd, World, Perf, Env, Stadium } from './render/world.js';
import { Cam } from './render/actors.js';
import { Input, swingPower, swingSpin, Tracker } from './input.js';
import { Game } from './game.js';
import { Net } from './net.js';
import { Phone, drawQR } from './phone.js';
import { Bus } from './events.js';

// =====================================================================
// UI: menus, lobby, camera check, HUD, main loop
// =====================================================================
const $ = (id) => document.getElementById(id);
const SEGS = [
  ['control', 'Controls', [['phone', 'Phone'], ['hand', 'Hand cam'], ['paddle', 'Paddle cam'], ['mouse', 'Mouse']]],
  ['handed', 'Plays', [['R', 'Right'], ['L', 'Left']]],
  ['surface', 'Surface', [['hard', 'Hard'], ['clay', 'Clay'], ['grass', 'Grass']]],
  ['format', 'Match', [['tiebreak', 'Tiebreak'], ['short', 'Short set'], ['full', 'Full set']]],
  ['level', 'CPU', [['rookie', 'Rookie'], ['club', 'Club'], ['pro', 'Pro']]],
  ['tod', 'Time', [['day', 'Day'], ['golden', 'Golden hour'], ['night', 'Night']]],
  ['gfx', 'Graphics', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']]],
];
const STEPS = {
  hand: '<li><b>Light in front of you,</b> not behind: a lamp or window facing you makes tracking faster and steadier.</li><li><b>Stand about 2 m back</b> so your hand stays in the picture on both sides of your body.</li><li><b>Swing across your body.</b> Taking the racket back first is fine: it counts as the wind-up.</li><li><b>Raise your hand above the toss line</b> to toss when you serve.</li>',
  paddle: '<li>Use a <b>brightly colored</b> paddle. Red or blue rubber works well, black does not.</li><li><b>Red patches in the picture</b> are other things with the paddle’s color: move them out of view.</li><li><b>Swing across your body.</b> Taking the racket back first is fine: it counts as the wind-up.</li><li><b>Raise the paddle above the toss line</b> to toss when you serve.</li>',
  mouse: '<li><b>No camera needed.</b> Click or tap to swing. Flick the mouse just before you click for more power, flick upward for topspin.</li><li><b>Keyboard:</b> Space swings, Shift+Space hits harder, S slices.</li><li><b>Timing aims the shot:</b> early goes one way, late the other.</li>',
};
// Camera check timing test: seconds from a ball appearing to reaching the circle, and from its bounce to the circle.
const CUE = { flight: 1.05, bt: 0.4 };

const UI = {
  screen: 'menu', calloutTimer: 0, shotTimer: 0, ambLevel: -1, setupReturn: 'menu', hostPrepped: false,
  init() {
    this.buildSettings();
    const note = document.createElement('p');
    note.id = 'menuNote'; note.className = 'status'; note.setAttribute('role', 'status');
    $('menu').querySelector('.actions').after(note);
    $('btnPractice').onclick = () => this.startCpu({});
    $('btnOnline').onclick = () => { Sound.init(); this.openLobby(); };
    $('btnSetup').onclick = () => { Sound.init(); this.openControls('menu'); };
    $('btnPhoneDone').onclick = () => this.closePhone();
    $('btnPhoneCam').onclick = () => { this.setControl('hand'); this.openSetup(this.phoneReturn || 'menu'); };
    $('btnHost').onclick = () => { Sound.init(); this.hostPrepped = false; Net.host(); };
    $('btnJoin').onclick = () => this.joinClicked();
    $('joinCode').onkeydown = (e) => { if (e.key === 'Enter') this.joinClicked(); };
    $('btnCopy').onclick = () => this.copyLink();
    $('btnStartOnline').onclick = () => this.startOnlineAsHost();
    $('btnLobbyBack').onclick = () => { Net.reset(); this.go('menu'); };
    $('btnSetupDone').onclick = () => this.closeSetup();
    $('btnLockColor').onclick = () => this.lockColor();
    $('optSens').value = Settings.sens; $('optLatency').value = Settings.latency;
    $('optSens').oninput = (e) => { Settings.sens = +e.target.value; Settings.save(); this.syncSliders(); };
    $('optLatency').oninput = (e) => { Settings.latency = +e.target.value; Settings.save(); this.syncSliders(); };
    $('swingBarWrap').style.setProperty('--thresh', `${(1.3 / 4) * 100}%`);
    this.syncSliders();
    $('btnMenu').onclick = () => this.pause();
    $('btnResume').onclick = () => this.resume();
    $('btnSetup2').onclick = () => this.openControls('pause');
    this.syncControlButtons();
    $('btnQuit').onclick = () => this.quit();
    $('btnRematch').onclick = () => this.rematch();
    $('btnOverMenu').onclick = () => this.quit();
    Input.on((ev) => this.onInputEvent(ev));
    document.addEventListener('visibilitychange', () => { if (document.hidden && Game.mode === 'cpu' && this.screen === null) this.pause(); });
    if (Settings.control === 'phone') Phone.ensure();   // so a phone paired before a reload finds the game again by itself
  },
  buildSettings() {
    const host = $('settings');
    for (const [key, label, opts] of SEGS) {
      const row = document.createElement('div');
      row.className = 'seg'; row.setAttribute('role', 'radiogroup'); row.setAttribute('aria-label', label);
      row.innerHTML = `<span>${label}</span><div class="opts">${opts.map(([v, t]) => `<label><input type="radio" name="opt-${key}" id="opt-${key}-${v}" value="${v}"${Settings[key] === v ? ' checked' : ''}>${t}</label>`).join('')}</div>`;
      row.addEventListener('change', (e) => { Settings[key] = e.target.value; Settings.save(); this.onSetting(key); });
      host.appendChild(row);
    }
    const tg = document.createElement('div');
    tg.className = 'toggles';
    tg.innerHTML = `<label><input type="checkbox" id="optVoice"${Settings.voice ? ' checked' : ''}> Umpire voice</label><label><input type="checkbox" id="optAssist"${Settings.assist ? ' checked' : ''}> Bounce spot</label><label><input type="checkbox" id="optReplays"${Settings.replays ? ' checked' : ''}> Replays</label>`;
    host.appendChild(tg);
    $('optVoice').onchange = (e) => { Settings.voice = e.target.checked; Settings.save(); };
    $('optAssist').onchange = (e) => { Settings.assist = e.target.checked; Settings.save(); };
    $('optReplays').onchange = (e) => { Settings.replays = e.target.checked; Settings.save(); };
    const vol = document.createElement('label'), v0 = Math.round((Settings.volume ?? 0.8) * 100);
    vol.className = 'range'; vol.htmlFor = 'optVolume'; vol.style.gridTemplateColumns = '84px 1fr 48px';
    vol.innerHTML = `<span>Volume</span><input type="range" id="optVolume" min="0" max="100" step="5" value="${v0}"><output id="volVal">${v0}%</output>`;
    host.appendChild(vol);
    $('optVolume').oninput = (e) => { Settings.volume = e.target.value / 100; $('volVal').textContent = `${e.target.value}%`; Sound.setVolume(); };
    $('optVolume').onchange = () => { Settings.save(); Sound.init(); Sound.hit(0.6, 4); };   // a sample strike at the new level
    const nm = $('optName');
    nm.value = Settings.name;
    nm.oninput = () => { Settings.name = nm.value.trim().slice(0, 12) || 'Player'; Settings.save(); };
  },
  onSetting(key) {
    if (key === 'surface' && Game.mode === 'attract') World.setSurface(Settings.surface);
    if (key === 'control') { this.menuNote(''); this.syncControlButtons(); if (Settings.control === 'phone') Phone.ensure(); }
    if (key === 'gfx') Perf.apply();
    if (key === 'tod' && (Game.mode === 'attract' || Game.mode === 'cpu')) Env.setTimeOfDay(Settings.tod);
  },
  setControl(v) { Settings.control = v; Settings.save(); const r = $('opt-control-' + v); if (r) r.checked = true; this.syncControlButtons(); },
  syncControlButtons() {
    const label = Settings.control === 'phone' ? 'Connect phone' : Settings.control === 'mouse' ? 'Controls' : 'Camera check';
    $('btnSetup').textContent = label; $('btnSetup2').textContent = label;
  },
  openControls(from) { if (Settings.control === 'phone') this.openPhone(from); else this.openSetup(from); },
  syncSliders() {
    $('sensVal').textContent = `${Settings.sens.toFixed(2)}×`;
    $('latVal').textContent = `${Settings.latency > 0 ? '+' : Settings.latency < 0 ? '−' : ''}${Math.abs(Math.round(Settings.latency * 1000))} ms`;
  },
  menuNote(msg, kind) { const el = $('menuNote'); if (!el) return; el.textContent = msg; el.className = 'status' + (kind ? ' ' + kind : ''); },
  gpuWarning() {
    const p = document.createElement('p');
    p.className = 'gpu-note';
    p.innerHTML = '<b>Your browser is drawing the 3D court without your graphics card</b>, so it will be slow. In Chrome or Edge open Settings → System, turn on “Use graphics acceleration when available”, then press Relaunch.';
    $('menu').querySelector('.actions').before(p);
  },

  go(screen) {
    this.screen = screen;
    Bus.emit('screen', { screen });
    for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== screen;   // modules add their own .screen elements
    const playing = Game.mode === 'cpu' || Game.mode === 'online';
    $('hud').hidden = !playing || screen === 'menu' || screen === 'lobby';
    if (screen === 'menu' && Tracker.stream && Game.mode === 'attract') Tracker.stop();
    this.placeCam();
    this.prompt();
    this.netInfo();
  },
  placeCam() {
    const w = Tracker.wrap, on = !!Tracker.stream;
    if (this.screen === 'setup') { $('camSlot').appendChild(w); w.classList.add('big'); w.hidden = !on; }
    else {
      document.body.appendChild(w); w.classList.remove('big');
      const playing = (Game.mode === 'cpu' || Game.mode === 'online') && (this.screen === null || this.screen === 'pause');
      w.hidden = !(on && playing);
    }
    if (on) Tracker.video.play().catch(() => {});
  },
  camMessage(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera access is blocked. Allow the camera for this page in your browser’s address bar, then try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Plug one in, or switch Controls to Mouse.';
    if (n === 'NotReadableError') return 'The camera is in use by another app. Close that app and try again.';
    return (e && e.message) || 'The camera didn’t start.';
  },
  async ensureControls(then) {
    if (Settings.control === 'mouse') { Tracker.stop(); return true; }
    if (Settings.control === 'phone') {
      Tracker.stop();
      Phone.ensure();
      if (Phone.connected() || !then) return true;
      this.openPhone('menu', then);    // pair the phone first, then carry on with what the player picked
      return false;
    }
    if (Settings.control === 'paddle' && !Settings.paddle) { this.menuNote('Lock your paddle color in Camera check first.', 'err'); this.openSetup('menu'); return false; }
    try {
      if (Settings.control === 'hand' && !Tracker.handsReady()) this.menuNote('Loading hand tracking. The first time takes a few seconds…');
      await Tracker.start(Settings.control);
      this.menuNote('');
      return true;
    } catch (e) {
      console.warn(e);
      this.setControl('mouse'); Tracker.stop();
      this.menuNote(`${this.camMessage(e)} Using mouse controls for now.`, 'err');
      return true;
    }
  },

  // ---- practice ----
  // opts overrides the match settings, for modes that set up their own matches (career, tutorial):
  // { opponent, oppHanded, surface, format, level, tod, ...anything else is kept on Game.cfg, e.g. career: {...} }
  async startCpu(opts = this.lastCpuOpts || {}) {
    this.lastCpuOpts = opts;
    Sound.init();
    $('btnPractice').disabled = true;
    const ok = await this.ensureControls(() => this.startCpu(opts));
    $('btnPractice').disabled = false;
    if (!ok) return;
    const { opponent, oppHanded, tod, ...rest } = opts;
    Env.setTimeOfDay(tod || Settings.tod);
    Game.startMatch({
      mode: 'cpu', localIdx: 0, names: [Settings.name, opponent || 'CPU'], handed: [Settings.handed, oppHanded || (Math.random() < 0.8 ? 'R' : 'L')], ctl: ['human', 'cpu'],
      surface: Settings.surface, format: Settings.format, first: Math.random() < 0.5 ? 0 : 1, level: Settings.level, ...rest,
    });
    this.go(null);
  },

  // ---- online lobby ----
  openLobby(code) {
    this.go('lobby');
    this.hostPrepped = false;
    $('lobbyStart').hidden = false; $('lobbyHost').hidden = true; $('btnStartOnline').hidden = true;
    if (!Net.available()) { this.lobbyStatus('Online play couldn’t load. Check your internet connection and reload the page.', 'err'); return; }
    if (code) { $('joinCode').value = code; this.lobbyStatus(`Press Join to enter match ${code}.`); $('btnJoin').focus(); }
    else this.lobbyStatus('');
  },
  joinClicked() {
    Sound.init();
    const c = $('joinCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(c)) { this.lobbyStatus('Match codes are 5 letters or numbers.', 'err'); return; }
    Net.join(c);
  },
  lobbyStatus(msg, kind) { const el = $('lobbyStatus'); el.textContent = msg; el.className = 'status' + (kind ? ' ' + kind : ''); },
  lobbyHosting(code) {
    $('lobbyStart').hidden = true; $('lobbyHost').hidden = false;
    const url = new URL(location.href);
    url.search = ''; url.hash = ''; url.searchParams.set('join', code);
    $('shareLink').value = url.toString();
    $('roomCode').textContent = code;
    this.lobbyStatus(location.protocol === 'file:'
      ? 'Waiting for your friend. This copy is a file on your computer, so send them the code and have them open the game’s web address.'
      : 'Waiting for your friend to open the link…');
  },
  lobbyConnected(r) {
    if (!r) return;
    $('lobbyStart').hidden = true;
    if (Net.role === 'host') {
      const ready = Net.remoteReady;
      this.lobbyStatus(ready ? `${r.name} is ready. You’re hosting: ${SURFACES[Settings.surface].label}, ${FORMATS[Settings.format].label.toLowerCase()}.` : `${r.name} joined. Waiting for their controls…`, 'ok');
      $('btnStartOnline').hidden = false; $('btnStartOnline').disabled = !ready;
      if (!this.hostPrepped) { this.hostPrepped = true; this.ensureControls(); }
    } else {
      this.lobbyStatus(`Connected to ${r.name}. Getting your controls ready…`, 'ok');
      this.ensureControls().then(() => {
        Net.send({ type: 'ready' });
        this.lobbyStatus(`Connected to ${r.name}. Waiting for them to start the match…`, 'ok');
      });
    }
  },
  copyLink() {
    const inp = $('shareLink'), btn = $('btnCopy');
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1600); };
    const fallback = () => { inp.focus(); inp.select(); };
    try { navigator.clipboard.writeText(inp.value).then(done, fallback); } catch (e) { fallback(); }
  },
  async startOnlineAsHost() {
    if (!Net.remote) return;
    Sound.init();
    const ok = await this.ensureControls();
    if (!ok || !Net.remote) return;
    const first = Math.random() < 0.5 ? 0 : 1, names = [Settings.name, Net.remote.name], handed = [Settings.handed, Net.remote.handed];
    Net.send({ type: 'start', surface: Settings.surface, format: Settings.format, tod: Settings.tod, first, names, handed });
    Env.setTimeOfDay(Settings.tod);
    Game.startMatch({ mode: 'online', localIdx: 0, names, handed, ctl: ['human', 'remote'], surface: Settings.surface, format: Settings.format, first });
    this.go(null);
  },
  startOnlineFromHost(m) {
    const surface = SURFACES[m.surface] ? m.surface : 'hard', format = FORMATS[m.format] ? m.format : 'short';
    Env.setTimeOfDay(['day', 'golden', 'night'].includes(m.tod) ? m.tod : 'day');
    const hostName = String((Array.isArray(m.names) && m.names[0]) || (Net.remote && Net.remote.name) || 'Friend').slice(0, 12);
    const hostHand = Array.isArray(m.handed) && m.handed[0] === 'L' ? 'L' : 'R';
    Game.startMatch({ mode: 'online', localIdx: 1, names: [hostName, Settings.name], handed: [hostHand, Settings.handed], ctl: ['remote', 'human'], surface, format, first: m.first === 1 ? 1 : 0 });
    this.go(null);
  },
  rematchFromRemote() { if (Net.role === 'host' && Game.mode === 'online' && Game.state === 'over') this.startOnlineAsHost(); },
  connectionLost(wasPlaying) {
    if (this.screen === 'lobby') { this.lobbyStatus('Your friend disconnected.', 'err'); $('btnStartOnline').hidden = true; $('lobbyStart').hidden = false; $('lobbyHost').hidden = true; return; }
    if (wasPlaying) { Game.startAttract(); this.go('menu'); this.menuNote('The connection to your friend was lost.', 'err'); }
  },
  netInfo() {
    const el = $('netInfo');
    el.textContent = Game.mode === 'online' && this.screen !== 'menu' ? (Net.rtt ? `Ping ${Math.round(Net.rtt)} ms` : 'Online') : '';
  },

  // ---- phone racket ----
  async openPhone(from, then) {
    this.phoneReturn = from || 'menu';
    this.phoneThen = then || null;
    this.go('phone');
    Phone.ensure();
    this.renderPhone();
    await Phone.pageUrl(true);
    this.renderPhone();
  },
  closePhone() {
    const then = this.phoneThen;
    this.phoneThen = null;
    if (then && Phone.connected()) { then(); return; }
    this.go(this.phoneReturn === 'pause' ? 'pause' : 'menu');
  },
  // The QR code, the typed address, how far the phone got and what to fix: all from Phone and serve.py's lan.json.
  renderPhone() {
    if (this.screen !== 'phone') return;
    const link = Phone.link(), info = Phone.info;
    $('phoneCode').textContent = Phone.code || '-----';
    $('phoneUrl').textContent = link || (Phone.url === undefined ? 'finding the link…' : 'none: see the box on the left');
    // Never leave a blank or stale QR code: without a link, say why in its place.
    const drawn = !!link && (link === this.qrFor || drawQR($('qr'), link));
    this.qrFor = drawn ? link : null;
    $('qr').hidden = !drawn;
    $('qrNone').hidden = drawn;
    if (!drawn) $('qrNone').textContent = Phone.url === undefined ? 'Finding the link for your phone…' : link ? 'The QR code didn’t draw. Type the address on the right into your phone instead.' : this.phoneNoLink(info);
    this.phoneAlternatives();
    const [text, kind] = this.phoneStatusText(info);
    const el = $('phoneStatus');
    el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : '');
    const help = this.phoneHelp(info);
    if (help !== this.helpHtml) { this.helpHtml = help; $('phoneHelpList').innerHTML = help; }
    const blocked = !!(info && info.firewall && info.firewall.state === 'blocked');
    if (blocked && !this.helpOpened) { this.helpOpened = true; $('phoneHelp').open = true; }
    $('btnPhoneDone').textContent = this.phoneThen ? (Phone.connected() ? 'Start match' : 'Waiting for phone…') : 'Done';
    $('btnPhoneDone').disabled = !!this.phoneThen && !Phone.connected();
  },
  phoneNoLink(info) {
    if (location.protocol === 'file:') return 'This copy of the game was opened as a file, so your phone has nothing to connect to. Close it and double-click play.cmd in the palm-court folder instead.';
    if (!info) return 'Phones need a secure link to this game, and play.cmd makes it. Close this page, double-click play.cmd in the palm-court folder, and use the browser window it opens. (Or host the game on GitHub Pages.)';
    return {
      off: 'The phone link is switched off (the server was started with --no-phone). Start the game with play.cmd instead.',
      'no-network': 'This PC isn’t on a network. Connect it to the same Wi-Fi as your phone, then restart play.cmd.',
      'no-openssl': 'play.cmd couldn’t make the certificate phones need, because openssl wasn’t found. Install Git for Windows (it includes openssl), then restart play.cmd.',
      cert: 'play.cmd couldn’t make the certificate phones need. Check the play.cmd window for the error, then restart it.',
      port: 'The phone port is in use by another program. Close it, or start play.cmd with --phone-port 8767.',
    }[info.problem] || 'The phone link is still starting. If this doesn’t change, restart play.cmd.';
  },
  // This PC has more than one network: let the player point the QR code at another address.
  phoneAlternatives() {
    const alt = $('phoneAlt'), urls = Phone.urls, key = urls.map((u) => u.url).join(' ') + Phone.pick;
    alt.hidden = urls.length < 2;
    if (key === this.altKey) return;
    this.altKey = key;
    alt.replaceChildren();
    if (urls.length < 2) return;
    alt.append('Phone can’t open it? Try:');
    urls.forEach((u, i) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = `${u.ip || new URL(u.url).hostname}${u.name ? ` (${u.name})` : ''}`;
      b.setAttribute('aria-pressed', String(i === Phone.pick));
      b.onclick = () => { Phone.pick = i; Phone.url = urls[i].url; this.renderPhone(); };
      alt.append(b);
    });
  },
  phoneStatusText(info) {
    const st = Phone.status();
    if (st === 'connected') {
      const how = Phone.via === 'wifi' ? 'over Wi-Fi' : 'over the internet';
      const next = !Phone.armed ? 'Tap Start on your phone.' : Phone.calibrated ? 'Ready to play.' : 'Swing a forehand, then a backhand on your phone to finish setup (or tap Skip there).';
      return [`Connected: ${Phone.device || 'phone'} ${how}${Phone.rtt ? ` · ${Phone.rtt} ms` : ''}. ${next}`, 'ok'];
    }
    if (!Phone.link()) return Phone.url === undefined ? ['Finding the link for your phone…', ''] : ['No phone link yet: see the box on the left.', 'err'];
    const seen = info && info.seen && info.seen.ago < 300 ? info.seen : null;
    if (seen && seen.stage === 'tls') return [`Your phone reached this PC (${seen.ip}). Now get past the warning on the phone. Android: Advanced, then Proceed. iPhone: Show Details, then visit this website.`, 'ok'];
    if (seen) return [`Your phone opened the racket page (${seen.ip}). Linking up…`, 'ok'];
    if (st === 'unavailable') return ['The connection library didn’t load and play.cmd isn’t running. Check your internet and reload the page.', 'err'];
    if (st === 'error') return ['Can’t reach the PeerJS connection server. Check this PC’s internet, or start the game with play.cmd.', 'err'];
    if (info && info.firewall && info.firewall.state === 'blocked') return ['Waiting for your phone… Windows Firewall is probably blocking it: see “Phone can’t open the page?” below.', 'err'];
    return [st === 'waiting' ? 'Waiting for your phone…' : 'Starting the phone link…', ''];
  },
  phoneHelp(info) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const fw = info && info.firewall, nets = (fw && fw.networks) || [];
    const pub = nets.find((n) => n.category === 'Public');
    const port = Phone.url ? new URL(Phone.url).port : '8766';
    const items = [
      '<b>Same network:</b> the phone must be on the same Wi-Fi as this PC (not mobile data, not a guest network). Some routers keep devices apart (“AP isolation”): use your main Wi-Fi.',
      `<b>Typing it in?</b> Include the <b>:${esc(port)}</b> part. A warning that the connection isn’t private is expected: continue past it.`,
    ];
    if (Phone.urls.length > 1) items.push('<b>Try the other addresses</b> above: this PC is on more than one network, and the phone can only reach one of them.');
    if (fw && fw.state === 'ok') items.push('<b>Windows Firewall</b> lets Python in on this network, so it isn’t the problem.');
    else if (info) {
      const exe = fw && fw.exe ? ` (${esc(fw.exe)})` : '';
      items.push(`<b>Windows Firewall ${fw && fw.state === 'blocked' ? 'is probably blocking your phone' : 'may block your phone'}.</b> `
        + (pub ? `Your network “${esc(pub.name)}” is set to Public. Easiest fix: Windows Settings → Network &amp; internet → ${esc(pub.name)} → Network profile type → <b>Private</b>, then restart play.cmd and allow Python if Windows asks. Or: ` : 'Fix: ')
        + `Windows Security → Firewall &amp; network protection → Allow an app through firewall → Change settings → tick <b>${pub ? 'Private and Public' : 'Private'}</b> for Python${exe}.`);
    }
    items.push('<b>Still stuck?</b> The play.cmd window lists this PC’s addresses and says when a phone reaches it. If the address is wrong, start it with <span class="url">play.cmd --ip 192.168.x.y</span> (the address from Wi-Fi settings on this PC).');
    return items.map((t) => `<li>${t}</li>`).join('');
  },
  phoneSwing(m) {
    const p = clamp(+m.power || 0, 0, 1);
    $('phoneBar').style.width = `${p * 100}%`;
    $('phoneVal').textContent = `${Math.round(p * 100)}%`;
    const kind = m.dir === 'fh' ? 'Forehand' : m.dir === 'bh' ? 'Backhand' : 'Swing';
    const spin = m.spin > 0.5 ? 'topspin' : m.spin < 0 ? 'slice' : 'flat';
    $('phoneLog').textContent = `${kind} · ${spin} · ${m.peak || '?'}°/s${m.dir ? '' : ' (forehand/backhand not set up on the phone yet)'}`;
  },
  phoneChip() {
    const el = $('phoneInfo');
    if (Settings.control !== 'phone' || !(Game.mode === 'cpu' || Game.mode === 'online')) { el.textContent = ''; return; }
    el.textContent = Phone.connected() ? `Phone${Phone.rtt ? ` ${Phone.rtt} ms` : ''}` : 'Phone disconnected';
    el.classList.toggle('warn', !Phone.connected());
  },

  // ---- camera check ----
  // A guided calibration that stays quick: framing (or locking the paddle color), sensitivity from a few practice
  // swings, a forehand / backhand / toss test, and a timing test against balls flying at you on the preview. A step
  // that has what it needs moves on by itself; the stepper jumps to any step, and the sliders stay for fine-tuning.
  async openSetup(from) {
    this.setupReturn = from;
    this.wireSetup();
    if (this.camCheck) this.leaveStep();
    this.go('setup');
    const mode = Settings.control, cam = mode !== 'mouse';
    const c = (this.camCheck = { mode, cam, plan: cam ? this.calPlan(mode) : [], step: null, done: {}, list: [], camErr: '', light: null, on: null, t: 0, lightT: 0, good: 0, next: 0 });
    $('setupEyebrow').textContent = cam ? `Camera check · ${mode === 'hand' ? 'hand' : 'paddle'}` : 'Controls · mouse and keyboard';
    $('setupTitle').textContent = cam ? 'Set up your swing' : 'Test your swing';
    $('setupSteps').innerHTML = STEPS[mode];
    $('setupTipsBox').open = !cam;
    for (const id of ['calSteps', 'stepCard', 'tuning', 'camHealth', 'cueCanvas']) $(id).hidden = !cam;
    $('mousePad').hidden = cam;
    $('camOff').hidden = $('camCount').hidden = true;
    $('swingList').replaceChildren(); $('camTip').textContent = '';
    $('swingLog').textContent = cam ? 'Swing to test it.' : 'Your swings show up here.';
    $('optSens').value = Settings.sens; $('optLatency').value = Settings.latency; this.syncSliders();
    this.renderSwatches();
    if (!cam) { Tracker.stop(); this.placeCam(); $('mousePad').focus({ preventScroll: true }); return; }
    $('calSteps').replaceChildren(...c.plan.map(([k, label], j) => {
      const li = document.createElement('li'), b = document.createElement('button'), n = document.createElement('i');
      b.type = 'button'; b.dataset.step = k; n.textContent = String(j + 1);
      b.append(n, label); b.onclick = () => this.goStep(k);
      li.append(b);
      return li;
    }));
    this.goStep(c.plan[0][0]);
    this.placeCam();
    $('camTip').textContent = this.camTips();
    $('btnStepGo').focus({ preventScroll: true });
    try { await Tracker.start(mode); } catch (e) { console.warn(e); c.camErr = this.camMessage(e); }
    // The player may have left (or reopened the check) while the camera or the hand tracker was starting.
    if (this.screen !== 'setup') { if (this.screen === 'menu' && Game.mode === 'attract') Tracker.stop(); return; }
    if (this.camCheck !== c) return;
    this.placeCam();
    this.updateStep();
  },
  calPlan(mode) { return [mode === 'paddle' ? ['paddle', 'Paddle'] : ['frame', 'Framing'], ['sens', 'Sensitivity'], ['swing', 'Swing test'], ['timing', 'Timing']]; },
  // Buttons and keys of the camera check (wired once, on first use).
  wireSetup() {
    if (this.setupWired) return;
    this.setupWired = true;
    $('btnStepGo').onclick = () => this.stepAction('go');
    $('btnStepAlt').onclick = () => this.stepAction('alt');
    $('btnCamRetry').onclick = () => this.openSetup(this.setupReturn);
    $('btnCamMouse').onclick = () => { this.setControl('mouse'); this.openSetup(this.setupReturn); };
    const pad = $('mousePad'), flash = () => { pad.classList.add('hit'); clearTimeout(this.padT); this.padT = setTimeout(() => pad.classList.remove('hit'), 160); };
    pad.onpointerdown = () => {
      Sound.init();
      // The same swing a click on the court makes: a flick just before adds power, an upward flick topspin.
      const m = Math.hypot(Input.vx, Input.vy) || 1, power = clamp(0.38 + Input.speed * 0.14, 0.38, 1);
      Input.press(power, Input.speed > 0.6 ? clamp(0.3 + (-Input.vy / m) * 1.1, -1, 1) : 0.35, 'mouse');
      flash();
    };
    pad.onkeydown = (e) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); Sound.init(); Input.press(e.shiftKey ? 0.92 : 0.58, 0.4, 'key'); flash(); }
      else if (e.code === 'KeyS') { Sound.init(); Input.press(0.42, -0.85, 'key'); flash(); }
    };
    // Moving the slider during the practice swings replaces the setting they would otherwise go back to.
    $('optSens').addEventListener('input', () => { const s = this.camCheck && this.camCheck.sens; if (s && !s.res) s.prev = Settings.sens; });
    document.addEventListener('keydown', (e) => {
      if (this.screen !== 'setup' || e.key !== 'Escape') return;
      const c = this.camCheck;
      if (c && c.count) this.lockColor();
      else if (c && c.tm && c.tm.run) this.timingStop();
      else this.closeSetup();
    });
    // However the screen is left, undo what only lasts for the check (the temporary sensitivity, the timing test).
    Bus.on('screen', ({ screen }) => { if (screen !== 'setup' && this.camCheck) { this.leaveStep(); this.camCheck = null; } });
    addEventListener('pagehide', () => this.leaveStep());
  },
  placeCam() {
    const w = Tracker.wrap, on = !!Tracker.stream;
    if (this.screen === 'setup') {
      const slot = $('camSlot'), c = this.camCheck;
      if (w.parentNode !== slot) slot.appendChild(w);
      w.classList.add('big'); w.hidden = !on;
      slot.style.setProperty('--ar', String(Tracker.aspect || 4 / 3));
      $('camOff').hidden = !(c && c.cam && !on && c.camErr);
      if (c && c.camErr) $('camOffMsg').textContent = c.camErr;
    } else {
      document.body.appendChild(w); w.classList.remove('big');
      const playing = (Game.mode === 'cpu' || Game.mode === 'online') && (this.screen === null || this.screen === 'pause');
      w.hidden = !(on && playing);
    }
    if (on) Tracker.video.play().catch(() => {});
  },
  camMessage(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera access is blocked. Allow the camera for this page in your browser’s address bar, then try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. Plug one in, or switch Controls to Mouse.';
    if (n === 'NotReadableError') return 'The camera is in use by another app. Close that app and try again.';
    return (e && e.message) || 'The camera didn’t start.';
  },
  closeSetup() {
    const back = this.setupReturn === 'pause' ? 'pause' : 'menu';
    this.leaveStep();
    this.camCheck = null;
    this.go(back);
    const b = $(back === 'pause' ? 'btnSetup2' : 'btnSetup');
    if (b) b.focus({ preventScroll: true });
  },
  goStep(id) {
    const c = this.camCheck;
    if (!c || !c.cam) return;
    this.leaveStep();
    c.step = id; c.good = 0; c.next = 0;
    Tracker.guide = id === 'frame' ? 'frame' : id === 'paddle' ? 'lock' : null;
    Tracker.preview = id === 'paddle' && !Settings.paddle;
    // Practice swings are measured at the most sensitive setting, so even gentle ones register.
    if (id === 'sens') { c.sens = { prev: Settings.sens, swings: [], res: null, lastEnd: 0 }; Settings.sens = +$('optSens').max; }
    if (id === 'swing') c.sw = { want: 'fh', got: {}, pend: null, quiet: 0, last: '', kind: '', miss: '', missAt: 0 };
    this.renderStep();
  },
  // Leaving a step: stop its test, and put back the sensitivity if the practice swings didn't finish.
  leaveStep() {
    const c = this.camCheck;
    if (!c) return;
    if (c.count) { c.count = null; $('camCount').hidden = true; }
    if (c.tm && c.tm.run) this.timingStop(true);
    if (c.sens && !c.sens.res) { Settings.sens = c.sens.prev; Settings.save(); }
    c.sens = null;
    Tracker.guide = null; Tracker.preview = false;
  },
  stepAction(which) {
    const c = this.camCheck;
    if (!c || !c.step) return;
    const id = c.step, i = c.plan.findIndex((p) => p[0] === id), next = () => (i < c.plan.length - 1 ? this.goStep(c.plan[i + 1][0]) : this.closeSetup());
    if (id === 'timing') {
      const tm = c.tm;
      if (which === 'alt') this.timingStart();
      else if (tm && tm.run) this.timingStop();
      else if (tm && tm.res && tm.res.to != null) this.closeSetup();
      else this.timingStart();
    } else if (which === 'alt') this.goStep(id);   // redo / restart
    else next();
  },
  renderStep() {
    const c = this.camCheck;
    if (!c || !c.cam || !c.step) return;
    const id = c.step, i = c.plan.findIndex((p) => p[0] === id), what = c.mode === 'hand' ? 'hand' : 'paddle';
    const [title, text] = {
      frame: ['Stand in the frame', 'Stand <b>about 2 m back</b>, facing the camera. Step back until your head and shoulders fit the outline, then hold up your racket hand.'],
      paddle: ['Lock the paddle color', 'Hold the paddle’s <b>face in the circle</b>, about 1.5 m back, and press Lock. You get 3 seconds to get it there. Yellow shows what it will follow.'],
      sens: ['Swing at rally pace', 'Swing <b>4 times</b>, forehands and backhands, the way you’d hit a rally ball. This sets how fast a swing must be to count, and how hard it hits.'],
      swing: ['Forehand, backhand, toss', `Swing a <b>forehand</b> across your body, then a <b>backhand</b>, then raise your ${what} <b>above the toss line</b> and hold it there, as if tossing to serve.`],
      timing: ['Hit on the beat', 'Balls fly at you on the picture. <b>Swing a forehand to meet each one in the circle</b>, as if hitting it. One practice ball, then 6 more: about 12 seconds.'],
    }[id];
    $('stepKicker').textContent = `Step ${i + 1} of ${c.plan.length}`;
    $('stepTitle').textContent = title;
    $('stepText').innerHTML = text;
    $('paddleBox').hidden = id !== 'paddle';
    $('stepBody').innerHTML = {
      frame: '<ul class="checks" id="calChecks" aria-label="Framing checks"></ul>',
      paddle: '<ul class="checks" id="calChecks" aria-label="Paddle checks"></ul>',
      sens: '<div class="pips" id="calPips" aria-hidden="true"><div class="pip"><i></i><small></small></div><div class="pip"><i></i><small></small></div><div class="pip"><i></i><small></small></div><div class="pip"><i></i><small></small></div></div>',
      swing: '<div class="tiles" id="calTiles"><p class="tile" data-k="fh"><b>FH</b><small>Forehand</small></p><p class="tile" data-k="bh"><b>BH</b><small>Backhand</small></p><p class="tile" data-k="toss"><b>↑</b><small>Toss</small></p></div>',
      timing: '<div class="tstrip-wrap" aria-hidden="true"><div class="tstrip" id="calStrip"><span>Early</span><span>On the ball</span><span>Late</span></div></div>',
    }[id];
    this.updateStep();
  },
  // The step card's live parts: checks, swing tiles, practice swings, timing results, and the buttons.
  updateStep() {
    const c = this.camCheck;
    if (!c || !c.cam || !c.step) return;
    const id = c.step, hand = c.mode === 'hand', now = performance.now(), noCam = !Tracker.stream;
    let msg = '', kind = '', go = 'Next', alt = '', goOff = false;
    for (const b of $('calSteps').querySelectorAll('button')) {
      const k = b.dataset.step, j = c.plan.findIndex((p) => p[0] === k);
      b.classList.toggle('done', !!c.done[k]);
      b.firstChild.textContent = c.done[k] ? '✓' : String(j + 1);
      if (k === id) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', `Step ${j + 1}: ${c.plan[j][1]}${c.done[k] ? ', done' : ''}`);
    }
    if (id === 'frame' || id === 'paddle') {
      const ul = $('calChecks');
      if (ul) ul.replaceChildren(...this.camChecks().map((k) => {
        const li = document.createElement('li'), s = document.createElement('span'), b = document.createElement('b');
        li.className = k.st; s.textContent = k.label; b.textContent = k.text;
        li.append(s, b);
        return li;
      }));
      if (id === 'paddle') {
        const lb = $('btnLockColor');
        lb.textContent = c.count ? 'Cancel' : Settings.paddle ? 'Lock again' : 'Lock paddle color';
        lb.disabled = noCam;
        this.renderSwatches();
        if (c.count) { msg = 'Hold the paddle’s face in the circle…'; kind = ''; }
        else if (c.lockMsg) [msg, kind] = c.lockMsg;
      }
      if (c.done[id]) { msg = hand ? 'Framing looks good. Next: sensitivity.' : `${c.lockMsg && c.lockMsg[1] === 'good' ? 'Locked, and ' : ''}the paddle tracks well. Next: sensitivity.`; kind = 'good'; }
    } else if (id === 'sens') {
      const S = c.sens, R = S && S.res, sw = S ? S.swings : [], top = Math.max(4, ...sw.map((s) => s.peak * 1.1));
      const pips = $('calPips') ? $('calPips').children : [];
      for (let k = 0; k < pips.length; k++) {
        const s = sw[k], p = pips[k];
        p.style.setProperty('--h', s ? `${Math.min(100, (s.peak / top) * 100)}%` : '0%');
        p.classList.toggle('low', !!(R && s && R.low.includes(s)));
        p.lastChild.textContent = s ? s.peak.toFixed(1) : '';
      }
      if (R) { msg = `Sensitivity set to ${R.to.toFixed(2)}× (was ${R.from.toFixed(2)}×). A swing like these hits at about 70% power.`; kind = 'good'; alt = 'Redo'; }
      else if (S) { const n = 4 - sw.length; msg = n > 0 ? `${n} more swing${n > 1 ? 's' : ''}. Every swing counts for now, even gentle ones.` : 'Working it out…'; go = 'Skip'; }
    } else if (id === 'swing') {
      const w = c.sw;
      for (const t of $('calTiles') ? $('calTiles').children : []) {
        const k = t.dataset.k;
        t.className = 'tile' + (w.got[k] ? ' done' : w.want === k ? ' now' : '') + (w.miss === k && now - w.missAt < 700 ? ' miss' : '');
      }
      if (c.done.swing) { msg = 'All three work. Next: timing.'; kind = 'good'; }
      else { msg = w.last || `Swing a ${w.want === 'bh' ? 'backhand' : 'forehand'}.`; kind = w.kind; go = 'Skip'; }
      if (w.got.fh || w.got.bh) alt = 'Restart';
    } else if (id === 'timing') {
      const tm = c.tm, R = tm && tm.res;
      const strip = $('calStrip');
      if (strip) {
        const dots = tm ? tm.beats.filter((b) => b.done && !b.practice && b.off != null) : [], x = (o) => `${clamp(50 + (o / 0.3) * 50, 2, 98)}%`;
        const els = dots.map((b) => { const d = document.createElement('i'); d.style.setProperty('--x', x(b.off)); return d; });
        if (R && R.to != null) { const m = document.createElement('i'); m.className = 'med'; m.style.setProperty('--x', x(R.med)); els.push(m); }
        strip.replaceChildren(...[...strip.querySelectorAll('span')], ...els);
      }
      if (tm && tm.run) {
        const k = tm.beats.findIndex((b) => !b.done), b = tm.beats[k];
        msg = !b ? 'Working it out…' : b.practice ? 'Practice ball: get the rhythm.' : `Ball ${k} of ${tm.beats.length - 1}. Swing a forehand as it reaches the circle.`;
        go = 'Stop';
      } else if (R && R.to != null) {
        const ms = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 1000))} ms`;
        msg = `Timing offset set to ${ms(R.to)} (was ${ms(R.from)}). Your swings peaked ${Math.abs(Math.round(R.med * 1000))} ms ${R.med >= 0 ? 'after' : 'before'} the ball, give or take ${Math.round(R.spread * 1000)} ms.`;
        kind = 'good';
        if (R.spread > 0.08) { msg += ' That varied a lot: try again for a steadier reading.'; kind = 'warn'; }
        go = 'Done'; alt = 'Try again';
      } else if (R && R.fail) {
        msg = `Only ${R.n} of 6 balls got a forehand in time. Try again: swing a forehand as each ball reaches the circle.`; kind = 'bad'; go = 'Start again';
      } else { msg = R && R.stopped ? 'Stopped. The offset didn’t change.' : 'Stand where you swing and press Start.'; go = 'Start test'; }
      goOff = noCam && !(tm && tm.run);
    }
    const res = $('strokeCheck');
    if (res.textContent !== msg) res.textContent = msg;
    res.className = 'result' + (kind ? ' ' + kind : '');
    const g = $('btnStepGo'), a = $('btnStepAlt');
    if (g.textContent !== go) g.textContent = go;
    g.disabled = goOff;
    a.hidden = !alt; if (alt && a.textContent !== alt) a.textContent = alt;
  },
  renderSwatches() {
    const set = (el, col) => { el.style.background = col ? col.css : ''; el.classList.toggle('none', !col); el.title = col ? `${this.hueName(col.h)} (hue ${Math.round(col.h)}°)` : 'None yet'; };
    set($('colorSwatch'), Settings.paddle);
    const p = Tracker.preview && Tracker.lockPrev;
    set($('colorPreview'), p ? p.col : null);
  },
  hueName(h) { return h < 15 || h >= 345 ? 'red' : h < 40 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 200 ? 'cyan' : h < 260 ? 'blue' : h < 290 ? 'purple' : 'pink'; },
  // Paddle lock: a 3-second countdown to get the paddle into the circle (the button again, or Esc, cancels it).
  // lockColor(true) locks straight away.
  lockColor(now) {
    const c = this.camCheck;
    if (now !== true && c && c.cam) {
      if (c.count) { c.count = null; $('camCount').hidden = true; Tracker.preview = !Settings.paddle; }
      else if (Tracker.stream) { c.count = { end: performance.now() + 3000 }; c.lockMsg = null; Tracker.preview = true; }
      this.updateStep();
      return false;
    }
    if (c) { c.count = null; $('camCount').hidden = true; }
    const prev = Tracker.lockPrev, r = Tracker.lockColor();
    const ok = r === true || (!!r && typeof r === 'object' && r.ok !== false), why = r && typeof r === 'object' ? r.message || r.reason : '';
    let msg;
    if (!ok) msg = [typeof why === 'string' && why ? why : prev && prev.col ? 'That color won’t track well. Use the red side of the paddle, turn it to the light, and lock again.' : 'That color is too dull or dark to track. Use the red side of the paddle, turn it to the light, and lock again.', 'bad'];
    else {
      const n = prev && prev.col && prev.seg.count, busy = n && n.other > Math.max(40 * n.k, 0.5 * n.mine);
      msg = busy ? ['Locked, but that color is also elsewhere in the picture (red). Move those things out of view, or lock the other side.', 'warn'] : ['Locked. The paddle shows yellow; anything red also matches its color.', 'good'];
      Tracker.setStatus('Tracking paddle');
      try { Sound.hit(0.5, 4); } catch (e) { /* sound is optional */ }
    }
    $('swingLog').textContent = msg[0];
    if (c) { c.lockMsg = msg; Tracker.preview = c.step === 'paddle' && !ok; c.good = 0; }
    this.renderSwatches();
    this.updateStep();
    return ok;
  },
  onInputEvent(ev) {
    if (this.screen !== 'setup') return;
    const log = $('swingLog'), s = ev.swing, cam = s && (s.src === 'hand' || s.src === 'paddle'), c = this.camCheck;
    if (ev.type === 'toss') { log.textContent = 'Toss gesture detected.'; if (c) this.camToss(); }
    else if (cam && c) this.camSwing(ev);
    else if (ev.type === 'swingEnd' || ev.type === 'swing') {
      const sp = swingSpin(s);
      log.textContent = `Swing! Power ${Math.round(swingPower(s) * 100)}% · ${sp > 0.5 ? 'topspin' : sp < -0.1 ? 'slice' : 'flat'}`;
    }
  },
  // A camera swing: listed, then used by the step that's running. 'swing' comes as soon as a swing is seen (with the
  // time the game will use), 'swingEnd' when its peak speed and its role (stroke, wind-up, arm coming back) are known.
  camSwing(ev) {
    const c = this.camCheck, s = ev.swing, now = performance.now(), name = (d) => (d === 'fh' ? 'Forehand' : d === 'bh' ? 'Backhand' : 'Up/down');
    if (ev.type === 'swing') {
      c.list.unshift(s);
      if (c.list.length > 6) c.list.pop();
      if (c.step === 'swing') this.swingTest(s, now);
      if (c.step === 'timing' && c.tm && c.tm.run) this.timingSwing(s);
    } else {
      const S = c.step === 'sens' && c.sens;
      if (S && !S.res) {
        // A later swing can turn an earlier one into its wind-up: keep only strokes across the body.
        if (s.dir && s.role === 'stroke' && !S.swings.includes(s)) S.swings.push(s);
        S.swings = S.swings.filter((x) => x.role === 'stroke');
        S.lastEnd = now;
      }
      const sp = swingSpin(s);
      if (s.role !== 'return') $('swingLog').textContent = `${name(s.dir)} · ${Math.round(swingPower(s) * 100)}% power · ${sp > 0.5 ? 'topspin' : sp < -0.1 ? 'slice' : 'flat'}`;
    }
    this.renderCheck();
  },
  // Swing test: a swing the other way first is the wind-up, as in the game, if the right one follows.
  swingTest(s, now) {
    const w = this.camCheck.sw;
    if (!w || (w.want !== 'fh' && w.want !== 'bh') || now < w.quiet) return;
    if (s.dir === w.want) {
      w.got[w.want] = true; w.last = `${w.want === 'fh' ? 'Forehand' : 'Backhand'} ✓ ${w.want === 'fh' ? 'Now a backhand.' : `Now raise your ${this.camCheck.mode === 'hand' ? 'hand' : 'paddle'} above the toss line.`}`; w.kind = 'good';
      w.want = w.want === 'fh' ? 'bh' : 'toss'; w.pend = null; w.quiet = now + 600;   // ignore the arm coming back
      try { Sound.hit(0.55, 4); } catch (e) { /* sound is optional */ }
    } else if (!w.pend) w.pend = { s, at: now };
  },
  camToss() {
    const c = this.camCheck, w = c.step === 'swing' && c.sw;
    if (!w || w.want !== 'toss') return;
    w.got.toss = true; w.want = null; w.last = 'Toss ✓'; w.kind = 'good';
    c.done.swing = true; c.next = performance.now() + 1600;
    try { Sound.hit(0.55, 4); } catch (e) { /* sound is optional */ }
    this.updateStep();
  },
  renderCheck() {
    const c = this.camCheck;
    if (!c) return;
    $('swingList').replaceChildren(...c.list.map((s) => {
      const li = document.createElement('li'), role = s.role === 'windup' ? 'wind-up' : s.role === 'return' ? 'return' : '';
      li.className = `${s.dir || 'none'}${role ? ' minor' : ''}`;
      li.title = role ? `Counted as the ${role}, not a stroke` : `Swing, ${Math.round(swingPower(s) * 100)}% power`;
      const b = document.createElement('b'); b.textContent = s.dir === 'fh' ? 'FH' : s.dir === 'bh' ? 'BH' : '↕';
      const sm = document.createElement('small'); sm.textContent = role;
      li.append(b, ` ${s.peak.toFixed(1)} `, sm);
      return li;
    }));
    this.updateStep();
  },
  // Every frame on the camera check (from frame()): countdowns, the timing test, finished steps; the rest 4 times a second.
  checkTick(now) {
    const c = this.camCheck;
    if (!c || !c.cam) return;
    const on = !!Tracker.stream;
    if (on !== c.on) { c.on = on; this.placeCam(); this.updateStep(); }
    if (c.count) {
      const left = c.count.end - now, el = $('camCount');
      if (left <= 0) this.lockColor(true);
      else { el.hidden = false; const n = String(Math.ceil(left / 1000)); if (el.textContent !== n) el.textContent = n; }
    }
    // Swing test: a swing the wrong way with no right one after it counts as a miss.
    const w = c.step === 'swing' && c.sw;
    if (w && w.pend && now - w.pend.at >= 550) {
      const d = w.pend.s.dir;
      w.last = d ? `That read as a ${d === 'fh' ? 'forehand' : 'backhand'}. Swing a ${w.want === 'fh' ? 'forehand' : 'backhand'} across your body.` : 'Couldn’t tell which way: swing more across your body.';
      w.kind = 'bad'; w.miss = w.want; w.missAt = now; w.pend = null; w.quiet = now + 300;
      this.updateStep();
    }
    const S = c.step === 'sens' && c.sens;
    if (S && !S.res && S.swings.length >= 4 && now - S.lastEnd > 450 && !Input.swing) this.sensDone();
    if (c.tm && c.tm.run) this.timingTick();
    if (c.next && now >= c.next) {
      c.next = 0;
      const i = c.plan.findIndex((p) => p[0] === c.step);
      if (i >= 0 && i < c.plan.length - 1) this.goStep(c.plan[i + 1][0]);
    }
    if (now - c.t < 250) return;
    c.t = now;
    if (now - c.lightT > 500) { c.lightT = now; c.light = this.camLight(); }
    this.renderHealth();
    // Framing / paddle: done once everything that matters has looked right for a moment.
    if ((c.step === 'frame' || c.step === 'paddle') && !c.done[c.step] && !c.count) {
      const bad = !Input.valid || (!Settings.paddle && c.mode === 'paddle') || this.camChecks().some((k) => k.st === 'bad' || k.st === 'wait');
      if (bad) c.good = 0;
      else if (!c.good) c.good = now;
      else if (now - c.good > 1500) { c.done[c.step] = true; c.next = now + 1400; }
    }
    this.updateStep();
  },
  // Sensitivity from the practice swings: the setting at which a typical one (their median, leaving out any much
  // slower than the fastest) hits at about 70% power, and a swing half as fast still counts.
  sensDone() {
    const c = this.camCheck, S = c.sens, el = $('optSens'), top = Math.max(...S.swings.map((s) => s.peak));
    const use = S.swings.filter((s) => s.peak >= 0.45 * top).map((s) => s.peak).sort((a, b) => a - b), m = use.length >> 1;
    const peak = use.length % 2 ? use[m] : (use[m - 1] + use[m]) / 2;
    const lo = +el.min, hi = +el.max, step = +el.step, s0 = Settings.sens, start = (Input.det.o && Input.det.o.start) || 1.3;
    const pw = (k) => { Settings.sens = k; return swingPower({ peak, vx: 0, vy: 0, src: c.mode }); };   // ask swingPower rather than copy its formula
    let best = lo, bd = Infinity;
    for (let k = lo; k <= hi + 1e-9; k += step) { const d = Math.abs(pw(k) - 0.7); if (d < bd - 1e-6) { bd = d; best = k; } }
    if (pw(hi) < 0.7) best = hi;
    Settings.sens = s0;
    const v = Math.round(clamp(Math.max(best, start / (0.5 * peak)), lo, hi) / step) * step;
    S.res = { from: S.prev, to: +v.toFixed(2), peak, low: S.swings.filter((s) => s.peak < 0.45 * top) };
    Settings.sens = S.res.to; Settings.save();
    el.value = S.res.to; this.syncSliders();
    c.done.sens = true; c.next = performance.now() + 2600;
    try { Sound.hit(0.6, 4); } catch (e) { /* sound is optional */ }
    this.updateStep();
  },
  // ---- timing test ----
  // A ball flies at you on the preview every 1.5 s and you swing a forehand to meet it in the circle. The typical gap
  // between the ball reaching the circle and the swing's peak (the moment the game uses) is the timing offset. Times
  // are game time from the performance clock, like the swings', so the test works from the pause screen too.
  gameNow() { return Clock.fromPerf(performance.now() / 1000); },
  timingStart() {
    const c = this.camCheck, P = 1.5, first = this.gameNow() + 1.8;
    c.tm = { run: true, beats: Array.from({ length: 7 }, (_, k) => ({ T: first + k * P, practice: k === 0, hit: 0, off: null, done: false, snd: false })), swings: [], res: null };
    this.updateStep();
  },
  timingStop(quiet) {
    const tm = this.camCheck && this.camCheck.tm;
    if (tm) { tm.run = false; if (!tm.res) tm.res = { stopped: true }; }
    this.drawCue(null);
    if (!quiet) this.updateStep();
  },
  timingSwing(s) {
    if (s.dir !== 'fh') return;   // the wind-up and the arm coming back go the other way
    const tm = this.camCheck.tm, b = tm.beats.find((x) => !x.done && Math.abs(s.t0 - x.T) < 0.45);
    tm.swings.push(s);
    if (b && !b.hit) { b.hit = this.gameNow(); try { Sound.hit(0.6, 3); } catch (e) { /* sound is optional */ } }
  },
  timingTick() {
    const c = this.camCheck, tm = c.tm, t = this.gameNow();
    for (const b of tm.beats) {
      if (!b.snd && t >= b.T - CUE.bt) { b.snd = true; try { Sound.bounce(6, 3, 'hard'); } catch (e) { /* sound is optional */ } }
      if (!b.done && t > b.T + 0.55) {
        const best = tm.swings.filter((s) => Math.abs(s.t0 - b.T) < 0.45).sort((p, q) => q.peak - p.peak)[0];
        b.done = true; b.off = best ? best.t0 - b.T : null;
        this.updateStep();
      }
    }
    if (tm.beats.every((b) => b.done)) this.timingDone(); else this.drawCue(t);
  },
  timingDone() {
    const c = this.camCheck, tm = c.tm, offs = tm.beats.filter((b) => !b.practice && b.off != null).map((b) => b.off);
    const med = (a) => { const s = a.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    tm.run = false;
    this.drawCue(null);
    if (offs.length < 4) tm.res = { fail: true, n: offs.length };
    else {
      const el = $('optLatency'), m = med(offs), v = clamp(Math.round(m * 100) / 100, +el.min, +el.max);
      tm.res = { from: Settings.latency, to: v, med: m, spread: med(offs.map((o) => Math.abs(o - m))) * 1.4826, n: offs.length };
      Settings.latency = v; Settings.save();
      el.value = v; this.syncSliders();
      c.done.timing = true;
    }
    this.updateStep();
  },
  // The timing test's balls over the camera picture (x, y in the mirrored picture, 0..1): far away at the top, a bounce,
  // then up into the circle on the forehand side at the beat. t null clears it.
  drawCue(t) {
    const cv = $('cueCanvas'), W = cv.clientWidth, H = cv.clientHeight, tm = this.camCheck && this.camCheck.tm;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (t == null || !tm || !W || !H) return;
    const side = Settings.handed === 'L' ? -1 : 1, U = Math.min(W, (H * 4) / 3), R = 0.075 * U;
    const S = [0.5 - side * 0.04, 0.1], B = [0.5 + side * 0.1, 0.86], C = [0.5 + side * 0.2, 0.5];
    const at = (b, tt) => {   // where beat b's incoming ball is at time tt, and its radius
      const t0 = b.T - CUE.flight, tb = b.T - CUE.bt;
      if (tt < tb) { const u = (tt - t0) / (tb - t0); return [S[0] + (B[0] - S[0]) * u, S[1] + (B[1] - S[1]) * u * u, 0.011 + 0.02 * u]; }
      const v = (tt - tb) / CUE.bt;
      return [B[0] + (C[0] - B[0]) * v, B[1] + (C[1] - B[1]) * (1 - (1 - v) * (1 - v)), 0.031 + 0.009 * v];
    };
    const next = tm.beats.find((b) => !b.done), near = next ? Math.abs(t - next.T) < 0.07 : false;
    g.lineWidth = 3; g.setLineDash([7, 6]);
    g.strokeStyle = near ? '#f2f5ee' : 'rgba(214,240,74,0.9)';
    g.beginPath(); g.arc(C[0] * W, C[1] * H, R, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    if (near) { g.fillStyle = 'rgba(214,240,74,0.28)'; g.fill(); }
    g.font = '700 12px Barlow, sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(214,240,74,0.95)';
    g.fillText('SWING HERE', C[0] * W, C[1] * H - R - 8);
    const k = next ? tm.beats.indexOf(next) : -1;
    g.textAlign = 'right'; g.font = '900 20px "Big Shoulders Display", "Arial Narrow", sans-serif'; g.fillStyle = '#f2f5ee';
    g.fillText(k < 0 ? '' : k === 0 ? 'PRACTICE BALL' : `BALL ${k} OF ${tm.beats.length - 1}`, W - 12, H - 12);
    if (t < tm.beats[0].T - CUE.flight) { g.textAlign = 'center'; g.font = '900 34px "Big Shoulders Display", "Arial Narrow", sans-serif'; g.fillText('GET READY', W / 2, H * 0.3); }
    for (const b of tm.beats) {
      if (t < b.T - CUE.flight || t > b.T + 0.6) continue;
      let p, a = 1;
      if (b.hit && t >= b.hit) {   // hit: it flies back where it came from
        const h = Math.min(1, (t - b.hit) / 0.5), q = at(b, Math.min(b.hit, b.T));
        p = [q[0] + (0.5 - side * 0.12 - q[0]) * h, q[1] + (0.05 - q[1]) * h - 0.08 * Math.sin(Math.PI * h), q[2] * (1 - 0.7 * h)];
        a = 1 - h;
        if (t - b.hit < 0.35) { g.textAlign = 'center'; g.font = '900 30px "Big Shoulders Display", "Arial Narrow", sans-serif'; g.fillStyle = `rgba(127,224,168,${1 - (t - b.hit) / 0.35})`; g.fillText('✓', C[0] * W, C[1] * H + R + 30); }
      } else if (t > b.T) { const q = at(b, b.T), w = t - b.T; p = [q[0] + side * 0.5 * w, q[1] - 0.12 * w, q[2] * (1 + 0.5 * w)]; a = Math.max(0, 1 - w / 0.6); }
      else p = at(b, t);
      if (a <= 0) continue;
      const x = p[0] * W, y = p[1] * H, r = p[2] * U;
      g.globalAlpha = a;
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(x + r * 0.25, y + r * 0.3, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d6f04a'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = Math.max(1, r * 0.14);
      g.beginPath(); g.arc(x - r * 0.9, y, r * 0.75, -0.9, 0.9); g.stroke();
      g.globalAlpha = 1;
    }
    g.textAlign = 'start';
  },
  // ---- camera check: what the preview shows ----
  // Brightness of the picture (0..1), and whether the middle (you) is much darker than the edges (a window behind you).
  camLight() {
    const v = Tracker.video;
    if (!Tracker.stream || v.readyState < 2 || !v.videoWidth) return null;
    const cv = this.lightCv || (this.lightCv = document.createElement('canvas')), w = (cv.width = 32), h = (cv.height = 24);
    const x = this.lightCtx || (this.lightCtx = cv.getContext('2d', { willReadFrequently: true }));
    x.drawImage(v, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let sum = 0, mid = 0, nm = 0, clip = 0;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255, px = p % w, py = (p / w) | 0;
      sum += y; if (y > 0.97) clip++;
      if (px >= 10 && px < 22 && py >= 6 && py < 22) { mid += y; nm++; }
    }
    const mean = sum / (w * h), edge = (sum - mid) / (w * h - nm);
    mid /= nm;
    return { mean, mid, edge, clip: clip / (w * h), back: edge > 0.55 && mid < edge * 0.5 };
  },
  // Tracking health: Tracker.stats() when the tracker offers it, else its fields, else what info() prints.
  trackStats() {
    const T = Tracker, s = (typeof T.stats === 'function' && T.stats()) || {}, txt = T.stream ? String(T.info()) : '';
    const pick = (...v) => { for (const x of v) if (x != null && x !== '' && Number.isFinite(+x)) return +x; return 0; };
    const inInfo = (re) => { const m = re.exec(txt); return m ? m[1] : null; };
    return {
      fps: pick(s.fps, s.rate, T.rate, inInfo(/([\d.]+) fps/)),
      ms: pick(s.procMs, s.ms, s.proc, T.procMs, inInfo(/([\d.]+) ms per frame/)),
      lag: pick(s.lagMs, s.lag, T.lagMs, inInfo(/([\d.]+) ms behind/)),
      est: (s.stamp || T.stamp) !== 'camera',
    };
  },
  renderHealth() {
    const s = this.trackStats(), on = !!Tracker.stream, paddle = this.camCheck.mode === 'paddle';
    const chip = (id, v, good, warn, low, tip) => {
      const el = $(id), ok = on && v > 0, q = low ? (v <= good ? 'good' : v <= warn ? 'warn' : 'bad') : v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
      el.querySelector('b').textContent = ok ? String(Math.round(v)) : '–';
      el.className = 'hchip' + (ok ? ' ' + q : '');
      el.title = tip;
    };
    chip('hFps', s.fps, 24, 15, false, 'Camera frames tracked each second. 24 or more is smooth; low light slows most webcams down.');
    chip('hProc', s.ms, 25, 45, true, paddle ? 'Time to find the paddle in each frame.' : 'Time the hand tracker takes for each frame.');
    chip('hLag', s.lag, 80, 130, true, `Time from the camera taking a frame to the game using it${s.est ? ' (estimated: this browser gives no camera timestamps)' : ''}. The timing offset makes up for it.`);
    $('hProc').hidden = paddle && !s.ms;
  },
  // Everything the preview can tell: [{ k, label, st: 'good' | 'warn' | 'bad' | 'wait', text, tip }].
  camChecks() {
    const c = this.camCheck, out = [], L = c.light, st = this.trackStats(), R = Settings.handed !== 'L';
    const add = (k, label, s, text, tip) => out.push({ k, label, st: s, text, tip: tip || '' });
    if (!Tracker.stream) { add('cam', 'Camera', c.camErr ? 'bad' : 'wait', c.camErr ? 'Not available' : 'Starting…', c.camErr || 'Starting the camera…'); return out; }
    if (L) {
      if (L.mean < 0.14) add('light', 'Light', 'bad', 'Too dark', 'Too dark: turn on a light in front of you.');
      else if (L.back) add('light', 'Light', 'warn', 'Bright light behind you', 'Bright light behind you: face the window, or close the curtain behind you.');
      else if (L.mean < 0.24) add('light', 'Light', 'warn', 'A bit dark', 'A bit dark: more light on you makes tracking faster and steadier.');
      else if (L.clip > 0.3) add('light', 'Light', 'warn', 'Washed out', 'The picture is washed out: turn away from direct sunlight.');
      else add('light', 'Light', 'good', 'Good');
    }
    if (c.mode === 'hand') {
      if (!Tracker.handsReady()) add('hand', 'Hand', c.camErr ? 'bad' : 'wait', c.camErr ? 'Tracker didn’t start' : 'Loading the tracker…', c.camErr || 'Loading hand tracking. The first time takes a few seconds…');
      else if (!Input.valid) add('hand', 'Hand', 'bad', 'Not found', 'Can’t see your hand: hold your racket hand up, palm to the camera.');
      else {
        add('hand', 'Hand', 'good', 'Found');
        const p = Tracker.palm || 0;   // palm width in frame widths: about 0.042 at 1.7 m
        if (p > 0.062) add('dist', 'Distance', 'bad', 'Too close', 'Too close: step back until your head and shoulders fit the outline.');
        else if (p && p < 0.026) add('dist', 'Distance', 'warn', 'Far: your hand looks small', 'Your hand looks small: come a little closer, to about 2 m.');
        else if (p) add('dist', 'Distance', 'good', 'Good');
        if (Input.x < 0.05 || Input.x > 0.95 || Input.y > 0.95) add('edge', 'Edge', 'warn', 'Near the edge', 'Your hand is at the edge of the picture: stand so your swing stays in view on both sides.');
        if (Tracker.offHand > 0.75) add('off', 'Which hand', 'warn', `Your ${R ? 'left' : 'right'}?`, `That looks like your ${R ? 'left' : 'right'} hand. If you play ${R ? 'left' : 'right'}-handed, set Plays to ${R ? 'Left' : 'Right'} so forehands and backhands read the right way round.`);
      }
    } else {
      const P = Tracker.preview && Tracker.lockPrev, n = Tracker.seg && Tracker.seg.count, busy = (q) => q && q.other > Math.max(40 * q.k, 0.5 * q.mine);
      if (Tracker.preview) {
        if (!P) add('circle', 'In circle', 'wait', 'Looking…');
        else if (!P.col) add('circle', 'In circle', 'bad', 'Nothing bright enough', 'Nothing colorful in the circle: hold the paddle’s face there. Black or dull rubber can’t be tracked.');
        else {
          const nm = this.hueName(P.col.h);
          if (busy(P.seg.count)) add('circle', 'In circle', 'warn', `${nm}, but also elsewhere`, `The ${nm} in the circle is also elsewhere in the picture (red): move those things out of view, or use the paddle’s other side.`);
          else add('circle', 'In circle', 'good', `${nm[0].toUpperCase() + nm.slice(1)}: good to lock`, `${nm[0].toUpperCase() + nm.slice(1)} in the circle. Press Lock paddle color.`);
        }
      }
      if (!Settings.paddle) { if (!Tracker.preview) add('paddle', 'Paddle', 'wait', 'Not locked yet', 'Hold the paddle’s face in the circle, then press Lock paddle color.'); }
      else if (!Input.valid) add('paddle', 'Paddle', Tracker.preview ? 'warn' : 'bad', 'Not found', 'Can’t see the paddle: hold it up in view, or lock its color again if the light changed.');
      else if (!Tracker.preview) {
        add('paddle', 'Paddle', 'good', 'Found');
        if (busy(n)) add('else', 'Elsewhere', 'bad', 'Its color is elsewhere too', 'The paddle’s color is also found elsewhere (red): move those things out of view, or lock the other side.');
        if (n && n.mine < 40 * n.k) add('size', 'Size', 'warn', 'Small: come closer', 'The paddle looks small: come closer, or turn its face to the camera.');
        else if (n && n.mine > 3000 * n.k) add('size', 'Size', 'warn', 'Very close', 'The paddle is very close: step back so your whole swing stays in view.');
        else if (n) add('size', 'Size', 'good', 'Good');
      }
    }
    const f = Math.round(st.fps);
    if (f) add('fps', 'Speed', f < 15 ? 'bad' : f < 24 ? 'warn' : 'good', `${f} fps${f < 15 ? ': slow' : ''}`, f < 24 ? `Tracking runs at ${f} fps. More light usually speeds the camera up; closing other apps helps too.` : '');
    if (Input.valid && Input.det.thr > (((Input.det.o && Input.det.o.start) || 1.3) / Settings.sens) * 1.2) add('jit', 'Steadiness', 'warn', 'Jittery', 'Tracking is jittery, so swings must be faster to count. More light on you helps.');
    return out;
  },
  // The framing guide over the preview (frame() shows it twice a second): the most important thing to fix, or that
  // all is well. Colour-coded by how much it matters.
  camTips() {
    const c = this.camCheck, el = $('camTip');
    if (!c || !c.cam) return '';
    const rank = { bad: 3, warn: 2, wait: 1, good: 0 }, top = this.camChecks().reduce((a, b) => (rank[b.st] > rank[a.st] && b.tip ? b : a), { st: 'good', tip: '' });
    let text = top.tip;
    if (!text && (c.step === 'frame' || c.step === 'paddle') && Input.valid) text = c.mode === 'hand' ? 'Tracking your hand. Framing looks good.' : 'Tracking the paddle. Looks good.';
    if (c.tm && c.tm.run && top.st !== 'bad') text = '';   // keep the picture clear for the balls
    el.className = 'cam-guide ' + (text ? top.st : '');
    return text;
  },

  // ---- pause / end ----
  togglePause() {
    if (!(Game.mode === 'cpu' || Game.mode === 'online')) return;
    if (this.screen === 'pause') this.resume(); else if (this.screen === null) this.pause();
  },
  pause() {
    if (Game.mode === 'cpu') Clock.pause();
    $('pauseEyebrow').textContent = Game.mode === 'online' ? 'Match still running' : 'Paused';
    $('perfInfo').textContent = `Running at ${Math.round(Perf.fps)} fps · ${Math.round(Perf.scale * 100)}% resolution · ${Perf.gpuName()}${Tracker.stream ? ` · tracking ${Tracker.info()}` : ''}`;
    this.go('pause');
  },
  resume() { Clock.resume(); this.go(null); Phone.send({ type: 'resync' }); },
  quit() {
    if ((Game.mode === 'cpu' || Game.mode === 'online') && Game.state !== 'over') Bus.emit('match:quit', { mode: Game.mode, cfg: Game.cfg });
    if (Game.mode === 'online') { Net.send({ type: 'bye' }); Net.reset(); }
    Clock.resume();
    Game.startAttract();
    this.go('menu');
  },
  rematch() {
    if (Game.mode === 'online') {
      if (Net.role === 'host') this.startOnlineAsHost();
      else { Net.send({ type: 'rematch' }); $('btnRematch').disabled = true; setTimeout(() => ($('btnRematch').disabled = false), 3000); }
    } else this.startCpu();
  },
  showOver() {
    const m = Game.match, w = m.winner, me = Game.localIdx, n = Game.names, st = m.stats;
    $('overTitle').textContent = w === me ? 'You win' : `${n[w]} wins`;
    const score = m.tbOnly ? `${m.pts[0]}–${m.pts[1]}` : `${m.games[0]}–${m.games[1]}${m.tb ? ` (${Math.min(m.pts[0], m.pts[1])})` : ''}`;
    $('overScore').textContent = `${n[0]} ${score} ${n[1]}`;
    const pair = (a) => `${a[0]}–${a[1]}`;
    $('overStats').textContent = `Aces ${pair(st.aces)} · Double faults ${pair(st.df)} · Winners ${pair(st.winners)} · Errors ${pair(st.errors)} · Fastest serves ${st.fastest[0]} / ${st.fastest[1]} km/h · Longest rally ${st.longest} shots`;
    $('btnRematch').textContent = Game.mode === 'online' ? 'Rematch' : 'Play again';
    $('btnRematch').disabled = false;
    this.go('over');
    if (w === me) Sound.applause(1);
  },

  // ---- HUD ----
  updateScore() {
    const m = Game.match;
    if (!m) return;
    const labels = m.pointLabels(), srv = m.currentServer;
    // The stadium screens follow whatever match is on court, the exhibition behind the menu included.
    this.board = { names: Game.names.slice(), games: m.games.slice(), points: labels, server: srv, note: m.tb && !m.tbOnly ? 'TIEBREAK' : 'PALM COURT' };
    Stadium.updateBoard(this.board);
    if (Game.mode === 'attract') return;
    for (const i of [0, 1]) {
      const row = $('sbRow' + i);
      row.classList.toggle('serving', srv === i);
      row.querySelector('.sb-name').textContent = Game.names[i];
      row.querySelector('.sb-games').textContent = m.games[i];
      row.querySelector('.sb-pts').textContent = labels[i];
    }
    $('sbMeta').textContent = [FORMATS[m.fmtKey].label, SURFACES[World.surface].label, m.tb && !m.tbOnly ? 'Tiebreak' : null, m.serveNo === 2 ? 'Second serve' : null].filter(Boolean).join(' · ');
    this.prompt();
  },
  prompt() {
    const el = $('prompt'), me = Game.me(), m = Game.match;
    let t = '';
    if (me && m && (Game.mode === 'cpu' || Game.mode === 'online') && this.screen === null) {
      const serving = m.currentServer === me.idx;
      if (Game.state === 'serve' && serving) t = Settings.control === 'mouse' ? (matchMedia('(pointer: coarse)').matches ? 'Tap to toss' : 'Click (or press Space) to toss') : Settings.control === 'phone' ? 'Tap or lift your phone to toss' : 'Raise your hand above the toss line to toss';
      else if (Game.state === 'toss' && serving) t = 'Swing!';
      else if (Game.state === 'serve' && Game.mode === 'online') t = `${Game.names[m.currentServer]} to serve`;
    }
    el.textContent = t;
  },
  callout(big, small) {
    const el = $('callout');
    el.textContent = big;
    if (small) { const s = document.createElement('small'); s.textContent = small; el.append(s); }
    el.classList.add('show');
    clearTimeout(this.calloutTimer);
    this.calloutTimer = setTimeout(() => el.classList.remove('show'), 1900);
  },
  flashShot(nodes, ms) {
    const el = $('shotInfo');
    el.replaceChildren(...nodes);
    el.style.opacity = 1;
    clearTimeout(this.shotTimer);
    this.shotTimer = setTimeout(() => (el.style.opacity = 0), ms);
  },
  // Show a short message on the stadium's big screens, then go back to the score.
  boardNote(note, ms) {
    if (!this.board) return;
    clearTimeout(this.boardTimer);
    if (!note) { Stadium.updateBoard(this.board); return; }
    Stadium.updateBoard({ ...this.board, note });
    this.boardTimer = setTimeout(() => this.board && Stadium.updateBoard(this.board), ms);
  },
  shot(pl, s) {
    if (Game.mode === 'attract') return;
    if (s.serve) this.boardNote(`SERVE ${s.kmh} KM/H`, 3500);   // the stadium screens flash every serve's speed, like on TV
    const mine = pl.idx === Game.localIdx;
    if (!mine && !s.serve) return;
    const mk = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    const k = mk('kmh', String(s.kmh || 0));
    const u = document.createElement('small'); u.textContent = 'km/h'; k.append(u);
    const spin = s.rpm ? `${s.rpm > 0 ? 'topspin' : 'backspin'} ${(Math.round(Math.abs(s.rpm) / 50) * 50).toLocaleString()} rpm` : '';
    const who = mine ? '' : `${Game.names[pl.idx]} · `;
    const nodes = [k, mk('detail', `${who}${s.kind || 'Shot'}${spin ? ' · ' + spin : ''}`)];
    if (mine && !s.serve && s.tau != null) {
      const when = Math.abs(s.tau) < 0.35 ? 'On time' : Math.abs(s.tau) > 1 ? (s.tau < 0 ? 'Very early' : 'Very late') : s.tau < 0 ? 'Early' : 'Late';
      const where = s.aim == null ? '' : s.aim < -0.9 ? ' · to your left' : s.aim > 0.9 ? ' · to your right' : ' · through the middle';
      nodes.push(mk('timing', when + where));
    }
    this.flashShot(nodes, 2600);
  },
  timing(text) {
    const d = document.createElement('div'); d.className = 'kmh'; d.style.fontSize = '30px'; d.textContent = text;
    this.flashShot([d], 1500);
  },
  frame() {
    const now = performance.now();
    if (this.screen === 'setup') {
      const full = 4 / Settings.sens, cam = Settings.control !== 'mouse';
      $('swingBar').style.width = `${clamp(Input.speed / full, 0, 1) * 100}%`;
      $('swingVal').textContent = Input.valid ? Input.speed.toFixed(1) : '–';
      this.checkTick(now);
      if (now - (this.infoT || 0) > 500) {
        this.infoT = now;
        // The red mark is the speed a swing needs right now (it rises when tracking is jittery).
        $('swingBarWrap').style.setProperty('--thresh', `${clamp((cam ? Input.det.thr : 1.3 / Settings.sens) / full, 0, 1) * 100}%`);
        $('trackInfo').textContent = cam ? `Tracking: ${Tracker.info()}` : '';
        $('camTip').textContent = cam ? this.camTips() : '';
      }
    }
    if (now - (this.fpsT || 0) > 500) {
      this.fpsT = now;
      $('fps').textContent = Settings.showFps ? `${Math.round(Perf.fps)} fps · ${Math.round(Perf.scale * 100)}%${Tracker.stream ? ` · cam ${Math.round(Tracker.rate)}` : ''}` : '';
    }
    const s = Game.state, playing = Game.mode === 'cpu' || Game.mode === 'online';
    Sound.frame(Game, camera, playing);   // crowd mood, footwork, swings, listener position
    // Which stroke is coming, on the side of the screen the ball will pass you, with the way to swing across your
    // body; it lights up when it's time to swing.
    const me = Game.me(), b = Game.ball;
    let hint = '';
    if (playing && me && me.ctl === 'human' && s === 'rally' && me.plan && b.lastHitter >= 0 && b.lastHitter !== me.idx && me.hitFor !== b.rally && Settings.control !== 'mouse') {
      hint = me.plan.stroke + (me.plan.t - Clock.now() < 0.22 ? ' now' : '');
    }
    if (hint !== this.hintNow) {
      this.hintNow = hint;
      const el = $('strokeHint'), stroke = hint.slice(0, 2), right = (stroke === 'fh') === (me && me.handed === 'R');
      if (hint) el.textContent = `${right ? '← ' : ''}${stroke === 'fh' ? 'Forehand' : 'Backhand'}${right ? '' : ' →'}`;
      el.className = 'stroke-hint' + (hint ? ` show ${right ? 'right' : 'left'}${hint.endsWith('now') ? ' now' : ''}` : '');
    }
    if (now - (this.phoneT || 0) > 100) { this.phoneT = now; Phone.pushState(); if (playing) this.phoneChip(); }
    // While pairing, ask serve.py every couple of seconds how far the phone got.
    if (this.screen === 'phone' && !Phone.connected() && now - (this.lanT || 0) > 2000) {
      this.lanT = now;
      Phone.pageUrl(true).then(() => { Phone.ensureRelay(); this.renderPhone(); });
    }
  },
};

export { $, SEGS, STEPS, UI };
