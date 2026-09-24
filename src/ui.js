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
  hand: '<li><b>Stand 1.5–2 m back</b> so your hand stays in the picture on both sides of your body.</li><li><b>Hold your hand up.</b> The yellow dot should follow your palm.</li><li><b>Swing across your body</b>, forehands and backhands. Each swing is listed below; do what the check asks.</li><li><b>Raise your hand above the toss line</b> to toss when you serve.</li>',
  paddle: '<li>Use a <b>brightly colored</b> paddle. Red or blue rubber works well, black does not.</li><li><b>Hold its face inside the circle</b> and press Lock paddle color. The paddle turns yellow; red patches mean something else in the room matches.</li><li><b>Swing forehands and backhands.</b> Each swing is listed below; do what the check asks.</li><li><b>Raise the paddle above the toss line</b> to toss when you serve.</li>',
  mouse: '<li><b>No camera needed.</b> Click or tap to swing. Flick the mouse just before you click for more power, flick upward for topspin.</li><li><b>Keyboard:</b> Space swings, Shift+Space hits harder, S slices.</li><li><b>Timing aims the shot:</b> early goes one way, late the other.</li>',
};

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
  // One line on the menu, with the fix folded away so it doesn't push the buttons off a laptop screen.
  gpuWarning() {
    const d = document.createElement('details');
    d.className = 'gpu-note';
    d.innerHTML = '<summary><span><b>No graphics card in use:</b> the 3D court will be slow.</span></summary><p>Your browser is drawing without your graphics card. In Chrome or Edge open Settings → System, turn on “Use graphics acceleration when available”, then press Relaunch.</p>';
    $('menu').querySelector('.actions').before(d);
  },

  go(screen) {
    const from = this.screen;
    this.screen = screen;
    Bus.emit('screen', { screen });
    for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== screen;   // modules add their own .screen elements
    const playing = Game.mode === 'cpu' || Game.mode === 'online';
    $('hud').hidden = !playing || screen === 'menu' || screen === 'lobby';
    $('hud').classList.toggle('ended', screen === 'over');
    if (screen === 'menu' && Tracker.stream && Game.mode === 'attract') Tracker.stop();
    this.placeCam();
    this.prompt();
    this.netInfo();
    // Keyboard players land on the screen's main button; back in play nothing keeps focus, so Space always swings.
    const main = { menu: 'btnPractice', pause: 'btnResume', over: 'btnRematch' }[screen];
    if (main && from !== screen && !$(main).disabled) $(main).focus({ preventScroll: true });
    else if (screen === null && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
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
  async openSetup(from) {
    this.setupReturn = from;
    this.go('setup');
    const mode = Settings.control;
    $('setupSteps').innerHTML = STEPS[mode];
    $('paddleBox').hidden = mode !== 'paddle';
    $('colorSwatch').style.background = Settings.paddle ? Settings.paddle.css : 'transparent';
    $('camSlot').hidden = mode === 'mouse';
    $('swingLog').textContent = mode === 'mouse' ? 'Click anywhere on the court to test a swing.' : 'Swing to test it.';
    this.camCheck = { list: [], want: 'fh', ok: { fh: 0, bh: 0 }, n: { fh: 0, bh: 0 }, pend: null, quiet: 0, last: '' };
    $('swingList').replaceChildren(); $('camTip').textContent = '';
    $('swingList').hidden = $('strokeCheck').hidden = mode === 'mouse';
    this.renderCheck();
    if (mode === 'mouse') { Tracker.stop(); this.placeCam(); return; }
    try { await Tracker.start(mode); } catch (e) { console.warn(e); $('swingLog').textContent = this.camMessage(e); }
    this.placeCam();
  },
  closeSetup() {
    if (this.setupReturn === 'pause') this.go('pause'); else this.go('menu');
  },
  lockColor() {
    const ok = Tracker.lockColor();
    $('colorSwatch').style.background = Settings.paddle ? Settings.paddle.css : 'transparent';
    $('swingLog').textContent = ok ? 'Paddle color locked. Swing to test it.' : 'That looks too dull to track. Try the red side of the paddle, in good light.';
    if (ok) Tracker.setStatus('Tracking paddle');
  },
  onInputEvent(ev) {
    if (this.screen !== 'setup') return;
    const log = $('swingLog'), s = ev.swing, cam = s && (s.src === 'hand' || s.src === 'paddle');
    if (ev.type === 'toss') log.textContent = 'Toss gesture detected.';
    else if (cam && this.camCheck) this.camSwing(ev);
    else if (ev.type === 'swingEnd' || ev.type === 'swing') {
      const sp = swingSpin(s);
      log.textContent = `Swing! Power ${Math.round(swingPower(s) * 100)}% · ${sp > 0.5 ? 'topspin' : sp < -0.1 ? 'slice' : 'flat'}`;
    }
  },
  // Camera check: every swing with its direction, speed and delay, plus a forehand / backhand check that forgives the
  // wind-up the same way the game does (a swing the other way first is fine if the right one follows).
  camSwing(ev) {
    const c = this.camCheck, s = ev.swing, now = performance.now(), name = (d) => (d === 'fh' ? 'Forehand' : d === 'bh' ? 'Backhand' : 'Up/down');
    if (ev.type === 'swing') {
      c.list.unshift(s);
      if (c.list.length > 6) c.list.pop();
      if (now >= c.quiet) {
        if (s.dir === c.want) {
          c.ok[c.want]++; c.n[c.want]++; c.last = `${name(c.want)} ✓`;
          c.want = c.want === 'fh' ? 'bh' : 'fh'; c.pend = null; c.quiet = now + 600;   // ignore the arm coming back
        } else if (!c.pend) c.pend = { s, at: now };
      }
    } else {
      const sp = swingSpin(s);
      if (s.role !== 'return') {
        $('swingLog').textContent = `${name(s.dir)} · ${Math.round(swingPower(s) * 100)}% power · ${sp > 0.5 ? 'topspin' : sp < -0.1 ? 'slice' : 'flat'}` +
          `${s.lag != null ? ` · seen ${Math.round(s.lag * 1000)} ms after the camera` : ''}`;
      }
    }
    this.renderCheck();
  },
  renderCheck() {
    const c = this.camCheck;
    if (!c) return;
    $('strokeCheck').innerHTML = `Now swing a <b>${c.want === 'fh' ? 'forehand' : 'backhand'}</b> · forehands ${c.ok.fh}/${c.n.fh} · backhands ${c.ok.bh}/${c.n.bh}${c.last ? ` · ${c.last}` : ''}`;
    $('swingList').replaceChildren(...c.list.map((s) => {
      const li = document.createElement('li'), role = s.role === 'windup' ? 'wind-up' : s.role === 'return' ? 'return' : '';
      li.className = `${s.dir || 'none'}${role ? ' minor' : ''}`;
      li.title = role ? `Counted as the ${role}, not a stroke` : 'Swing';
      const b = document.createElement('b'); b.textContent = s.dir === 'fh' ? 'FH' : s.dir === 'bh' ? 'BH' : '↕';
      const sm = document.createElement('small'); sm.textContent = `${s.lag != null ? `${Math.round(s.lag * 1000)} ms` : ''}${role ? ` ${role}` : ''}`;
      li.append(b, ` ${s.peak.toFixed(1)} `, sm);
      return li;
    }));
  },
  // A stroke-check swing the wrong way with no right one after it counts as a miss.
  checkTick(now) {
    const c = this.camCheck;
    if (!c || !c.pend || now - c.pend.at < 550) return;
    const d = c.pend.s.dir;
    c.n[c.want]++;
    c.last = d ? `that read as a ${d === 'fh' ? 'forehand' : 'backhand'}` : 'couldn’t tell which way: swing more across your body';
    c.pend = null; c.quiet = now + 300;
    this.renderCheck();
  },
  camTips() {
    const d = Input.det, base = 1.3 / Settings.sens, tips = [];
    if (!Tracker.stream) return '';
    if (!Input.valid) tips.push(Settings.control === 'hand' ? 'Can’t see your hand.' : Settings.paddle ? 'Can’t see the paddle: lock its color again if the light changed.' : '');
    else if (d.thr > base * 1.2) tips.push('Tracking is jittery, so swings must be faster to count. More light on you helps.');
    if (Settings.control === 'hand' && Input.valid && Tracker.offHand > 0.75) tips.push(`That looks like your ${Settings.handed === 'R' ? 'left' : 'right'} hand. If you play ${Settings.handed === 'R' ? 'left' : 'right'}-handed, set Plays to ${Settings.handed === 'R' ? 'Left' : 'Right'} so forehands and backhands read the right way round.`);
    if (Tracker.rate && Tracker.rate < 20) tips.push('The camera is running slowly; more light usually speeds it up.');
    return tips.filter(Boolean).join(' ');
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
    this.scoreTable($('pauseScore'), false);
    this.go('pause');
  },
  resume() { Clock.resume(); this.go(null); Phone.send({ type: 'resync' }); },
  quit() {
    if ((Game.mode === 'cpu' || Game.mode === 'online') && Game.state !== 'over') Bus.emit('match:quit', { mode: Game.mode, cfg: Game.cfg });
    if (Game.mode === 'online') { Net.send({ type: 'bye' }); Net.reset(); }
    Clock.resume();
    this.clearHud();
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
    const m = Game.match, w = m.winner, me = Game.localIdx;
    $('overTitle').textContent = w === me ? 'You win' : `${this.shortName(w)} wins`;
    this.scoreTable($('overScore'), true);
    this.renderStats($('overStats'));
    $('btnRematch').textContent = Game.mode === 'online' ? 'Rematch' : 'Play again';
    $('btnRematch').disabled = false;
    this.go('over');
    if (w === me) Sound.applause(1);
  },
  // The score as a small table, for the pause and match-over screens. The final score puts the loser's tiebreak
  // points in superscript (7–6⁵).
  scoreTable(el, final) {
    const m = Game.match;
    if (!m) { el.replaceChildren(); return; }
    const labels = m.pointLabels(), tbl = document.createElement('div');
    tbl.className = 'mini-sb' + (final ? ' final' : '');
    for (const i of [0, 1]) {
      const row = document.createElement('div');
      const cell = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; row.append(s); return s; };
      row.className = 'ms-row' + (final ? (m.winner === i ? ' win' : '') : m.currentServer === i ? ' serving' : '');
      cell('ms-serve', ''); cell('ms-cc', this.country(i));
      cell('ms-name', this.shortName(i)).title = Game.names[i];
      const g = cell('ms-g', m.tbOnly ? (final ? String(m.pts[i]) : '') : String(m.games[i]));
      if (final && m.tb && !m.tbOnly && m.winner !== i) { const sup = document.createElement('sup'); sup.textContent = m.pts[i]; g.append(sup); }
      if (!final) cell('ms-p', labels[i]);
      tbl.append(row);
    }
    const meta = document.createElement('p');
    meta.className = 'score-meta';
    meta.textContent = this.metaText(m, !final).join(' · ');
    el.replaceChildren(tbl, meta);
  },
  metaText(m, live) {
    const f = FORMATS[m.fmtKey], s = SURFACES[World.surface];
    return [f && f.label, s && `${s.label} court`, live && m.tb && !m.tbOnly ? 'Tiebreak' : null, live && m.serveNo === 2 ? 'Second serve' : null].filter(Boolean);
  },
  // Broadcast match stats: both players' numbers either side of the label, a bar out from the middle for each.
  renderStats(el) {
    const m = Game.match, st = m.stats, T = this.track && this.track.m === m ? this.track : null;
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : null), P = T ? T.p : null;
    const rows = [['Aces', st.aces], ['Double faults', st.df, { low: true }]];
    if (P) {
      rows.push(['1st serve in', P.map((p) => pct(p.fsIn, p.fsTot)), { pct: true, of: P.map((p) => `${p.fsIn}/${p.fsTot}`) }],
        ['Won on 1st serve', P.map((p) => pct(p.fsWon, p.fsIn)), { pct: true, of: P.map((p) => `${p.fsWon}/${p.fsIn}`) }],
        ['Won on 2nd serve', P.map((p) => pct(p.ssWon, p.ssTot)), { pct: true, of: P.map((p) => `${p.ssWon}/${p.ssTot}`) }]);
    }
    rows.push(['Winners', st.winners], ['Errors', st.errors, { low: true }]);
    if (P && !m.tbOnly) rows.push(['Break points won', P.map((p) => p.bpWon), { text: P.map((p) => `${p.bpWon}/${p.bpTot}`) }]);
    rows.push(['Fastest serve', st.fastest.map((v) => v || null), { unit: 'km/h' }], ['Total points won', st.points]);
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const head = mk('div', 'st-head');
    head.append(mk('span', '', this.shortName(0)), mk('span'), mk('span', '', this.shortName(1)));
    const out = [head];
    for (const [label, v, o = {}] of rows) {
      const [a, b] = v, lead = a == null || b == null || a === b ? -1 : (o.low ? a < b : a > b) ? 0 : 1;
      const row = mk('div', 'st-row'), bar = mk('div', 'st-bar'), top = Math.max(a || 0, b || 0);
      const val = (i) => {
        const x = v[i], e = mk('b', lead === i ? 'lead' : '', x == null ? '–' : o.text ? o.text[i] : `${x}${o.pct ? '%' : ''}`);
        if (x != null && (o.unit || o.of)) e.append(mk('small', '', o.unit || o.of[i]));
        const half = mk('i', lead === i ? 'lead' : '');
        half.style.setProperty('--w', `${x == null ? 0 : o.pct ? x : top ? (100 * x) / top : 0}%`);
        bar.append(half);
        return e;
      };
      row.append(val(0), mk('span', '', label), val(1), bar);
      out.push(row);
    }
    const foot = mk('p', 'stats-foot'), secs = T ? Math.max(0, Clock.now() - T.t0) : 0;
    const item = (label, value, unit) => { const s = mk('span', '', `${label} `); s.append(mk('b', '', value), unit ? ` ${unit}` : ''); foot.append(s); };
    item('Longest rally', String(st.longest), st.longest === 1 ? 'shot' : 'shots');
    if (T) item('Match time', `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`);
    out.push(foot);
    el.replaceChildren(...out);
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
    const T = this.trackScore(m), anim = !!T.prev, ch = T.snap.chance;
    const tagText = { break: (n) => (n > 1 ? `${n} break points` : 'Break point'), set: (n) => (n > 1 ? `${n} set points` : 'Set point'), match: (n) => (n > 1 ? `${n} match points` : 'Match point') };
    $('scoreboard').classList.toggle('tb-only', !!m.tbOnly);
    for (const i of [0, 1]) {
      const row = $('sbRow' + i), name = this.shortName(i), nm = row.querySelector('.sb-name');
      row.classList.toggle('serving', srv === i);
      if (nm.textContent !== name) { nm.textContent = name; nm.title = Game.names[i]; }
      row.querySelector('.sb-cc').textContent = this.country(i);
      this.setCells(row.querySelector('.sb-sets'), m, i);
      const gWon = this.roll(row.querySelector('.sb-games'), m.tbOnly ? '' : String(m.games[i]), anim);
      const pWon = this.roll(row.querySelector('.sb-pts'), labels[i], anim);
      if (T.w === i) {
        row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');   // restart the sweep
        if (!this.calm()) (gWon && m.games[i] > T.prev.games[i] ? row.querySelector('.sb-games') : pWon ? row.querySelector('.sb-pts') : row).animate([{ filter: 'brightness(1.8)' }, { filter: 'none' }], { duration: 700, easing: 'ease-out' });
      }
      const tag = row.querySelector('.sb-tag'), t = ch && ch.p === i ? tagText[ch.kind](ch.n) : '';
      if (t) { tag.textContent = t; tag.dataset.kind = ch.kind; }
      tag.classList.toggle('show', !!t);
    }
    const meta = $('sbMeta'), parts = this.metaText(m, false);
    if (m.tb && !m.tbOnly) parts.push('Tiebreak');
    const second = m.serveNo === 2 && !m.over ? document.createElement('b') : '';
    if (second) second.textContent = '2nd serve';
    meta.replaceChildren(parts.join(' · '), second);
    this.prompt();
  },
  // A cell's number rolls up into place when it changes. Returns whether it changed.
  roll(cell, text, anim) {
    const el = cell.firstElementChild || cell;
    if (el.textContent === text) return false;
    el.textContent = text;
    if (anim && text && !this.calm()) el.animate([{ transform: 'translateY(75%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    return true;
  },
  // Completed sets, for match formats that have more than one (Match.sets = [[a, b], ...]); empty otherwise.
  setCells(el, m, i) {
    const sets = Array.isArray(m.sets) ? m.sets : [], key = sets.map((s) => s.join('-')).join(' ');
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...sets.map((s) => { const c = document.createElement('i'); c.textContent = s[i]; if (s[i] > s[1 - i]) c.className = 'won'; return c; }));
  },
  calm() { return matchMedia('(prefers-reduced-motion: reduce)').matches; },
  // Broadcast names: a pro's short name, else the surname of a long full name; a country code if the player has one.
  shortName(i) {
    const pl = Game.players[i], full = String(Game.names[i] || '').trim(), parts = full.split(/\s+/);
    const short = pl && (pl.short || (pl.pro && pl.pro.short));
    return String(short || (parts.length > 1 && full.length > 11 ? parts[parts.length - 1] : full) || `Player ${i + 1}`);
  },
  country(i) {
    const pl = Game.players[i], cfg = Game.cfg || {};
    const c = (pl && (pl.country || (pl.pro && pl.pro.country))) || (cfg.countries && cfg.countries[i]) || '';
    return /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : '';
  },
  // Serve and break-point stats the Match doesn't keep, read off the score each time it changes (every point, fault
  // and let calls updateScore), so an online match counts them the same way on both machines.
  trackScore(m) {
    let T = this.track;
    if (!T || T.m !== m) {
      T = this.track = { m, t0: Clock.now(), prev: null, snap: null, w: -1, serves: 0, p: [0, 1].map(() => ({ fsIn: 0, fsTot: 0, fsWon: 0, ssTot: 0, ssWon: 0, bpWon: 0, bpTot: 0 })) };
      this.clearHud();
    }
    const S = T.snap, cur = { won: m.stats.points.slice(), games: m.games.slice(), server: m.currentServer, serveNo: m.serveNo, tb: m.tb, chance: this.chance(m) };
    T.w = -1;
    if (S) {
      const d0 = cur.won[0] - S.won[0], d1 = cur.won[1] - S.won[1];
      if (d0 + d1 === 1) {
        const w = T.w = d0 ? 0 : 1, P = T.p[S.server], held = w === S.server;
        if (S.serveNo === 1) { P.fsIn++; P.fsTot++; if (held) P.fsWon++; } else { P.ssTot++; if (held) P.ssWon++; }
        if (S.chance && S.chance.brk) { T.p[S.chance.p].bpTot++; if (cur.games[S.chance.p] > S.games[S.chance.p]) T.p[S.chance.p].bpWon++; }
      } else if (d0 + d1 === 0 && S.serveNo === 1 && cur.serveNo === 2) T.p[S.server].fsTot++;   // a first-serve fault
    }
    T.prev = S; T.snap = cur;
    return T;
  },
  // Who is one point from the match, the set, or a game on the other's serve, and how many chances in a row they have
  // (30–40 is one break point, 0–40 three). Played out on copies of the Match so it follows the Match's own rules.
  chance(m) {
    if (m.over) return null;
    const copy = (src) => Object.assign(Object.create(Object.getPrototypeOf(src)), structuredClone({ ...src }));
    const what = (c, p) => {
      const ev = copy(c).pointTo(p), brk = !!ev.game && !c.tb && c.currentServer !== p;
      return { kind: ev.match ? 'match' : ev.set ? 'set' : brk ? 'break' : '', brk };
    };
    try {
      for (const p of [0, 1]) {
        const { kind, brk } = what(m, p);
        if (!kind) continue;
        const c = copy(m);
        let n = 1;
        while (n < 9 && !c.pointTo(1 - p).game && what(c, p).kind === kind) n++;
        return { p, kind, n, brk };
      }
    } catch (e) { /* a Match that can't be copied: no tags */ }
    return null;
  },
  clearHud() {
    clearTimeout(this.calloutTimer); clearTimeout(this.shotTimer); clearTimeout(this.timingTimer);
    $('callout').classList.remove('show', 'swap');
    $('shotInfo').classList.remove('show');
    $('timingFb').classList.remove('show');
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
    el.classList.toggle('go', t === 'Swing!');
  },
  // The call (OUT, FAULT, ACE...), then, when the point decided a game, a GAME graphic with the games score (or the
  // match winner). Called after the Match has scored the point but before updateScore, so the track snapshot still
  // holds the score from before it.
  callout(big, small) {
    const el = $('callout'), m = Game.match, T = this.track, S = T && m && T.m === m ? T.snap : null;
    const w = S ? [0, 1].find((i) => m.games[i] > S.games[i]) : undefined;
    const tone = { ace: 'good', winner: 'good', out: 'bad', net: 'bad', fault: 'bad', 'double fault': 'bad' }[String(big).toLowerCase()] || 'neutral';
    const phases = [];
    if (w === undefined) phases.push({ word: big, sub: small, tone, ms: 1900 });
    else {
      const name = this.shortName(w), gw = m.tbOnly ? m.pts[w] : m.games[w], gl = m.tbOnly ? m.pts[1 - w] : m.games[1 - w];
      phases.push({ word: big, tone, ms: 1000 });
      if (m.over) phases.push({ eyebrow: 'Game, set and match', word: name, sub: `${gw}–${gl}${m.tb && !m.tbOnly ? ` (${m.pts[1 - w]})` : ''}`, tone: 'game', ms: 2300 });
      else phases.push({ word: 'Game', sub: `${name} · ${gw}–${gl}${m.tb && !S.tb ? ' · Tiebreak' : ''}`, tone: 'game', ms: 1500 });
    }
    const mk = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    const show = (i) => {
      const p = phases[i];
      if (!p) { el.classList.remove('show', 'swap'); return; }
      el.dataset.tone = p.tone;
      el.replaceChildren(...[p.eyebrow && mk('co-eyebrow', p.eyebrow), mk('co-word', p.word), mk('co-bar', ''), p.sub && mk('co-sub', p.sub)].filter(Boolean));
      el.classList.remove('swap'); el.classList.add('show');
      this.calloutTimer = setTimeout(() => {
        if (!phases[i + 1]) return show(i + 1);
        el.classList.add('swap');   // a quick fade between the call and the game graphic
        this.calloutTimer = setTimeout(() => show(i + 1), 150);
      }, p.ms);
    };
    clearTimeout(this.calloutTimer);
    show(0);
  },
  flashShot(nodes, ms) {
    const el = $('shotInfo'), was = el.classList.contains('show');
    el.replaceChildren(...nodes);
    el.classList.add('show');
    if (was && !this.calm()) el.animate([{ opacity: 0.3, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    clearTimeout(this.shotTimer);
    this.shotTimer = setTimeout(() => el.classList.remove('show'), ms);
  },
  // The timing read under the court: a mark on an early | on time | late scale (tau: -1.8 very early .. 1.8 very late;
  // undefined = no scale) and a short verdict.
  showTiming(tau, head, rest, tone) {
    const el = $('timingFb'), b = document.createElement('b');
    el.dataset.tone = tone || '';
    el.classList.toggle('nometer', tau === undefined);
    if (tau !== undefined) el.style.setProperty('--x', `${clamp(50 + (tau / 1.8) * 50, 3, 97)}%`);
    b.textContent = head;
    $('timingText').replaceChildren(b, rest ? ` · ${rest}` : '');
    el.classList.add('show');
    clearTimeout(this.timingTimer);
    this.timingTimer = setTimeout(() => el.classList.remove('show'), 1900);
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
    const mine = pl.idx === Game.localIdx, m = Game.match, T = this.track;
    if (s.serve && T && T.m === m) T.serves++;
    if (!mine && !s.serve) return;
    const mk = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; d.textContent = text; return d; };
    const kmh = Math.round(s.kmh || 0), stroke = !s.serve && pl.plan ? (pl.plan.stroke === 'bh' ? 'Backhand' : 'Forehand') : '';
    const label = mk('div', 'si-label', s.serve ? `${m && m.serveNo === 2 ? '2nd' : '1st'} serve${mine ? '' : ` · ${this.shortName(pl.idx)}`}` : stroke ? `${stroke} ${String(s.kind || 'shot').toLowerCase()}` : s.kind || 'Shot');
    // The fastest serve of the match so far (once there have been a few) gets a badge, like the TV graphic.
    if (s.serve && m && T && T.serves > 6 && kmh >= Math.max(...m.stats.fastest)) label.append(mk('em', '', 'Match best'));
    const speed = mk('div', 'si-speed', String(kmh));
    speed.append(mk('small', '', 'km/h'), mk('small', '', `${Math.round(kmh * 0.6214)} mph`));
    const rpm = (Math.round(Math.abs(s.rpm || 0) / 50) * 50).toLocaleString('en-US');
    const nodes = [label, speed, mk('div', 'si-detail', s.rpm ? `${s.rpm > 0 ? 'Topspin' : 'Backspin'} · ${rpm} rpm` : 'Flat')];
    if (mine && !s.serve && s.tau != null) {
      const a = Math.abs(s.tau), when = a < 0.35 ? 'On time' : a > 1 ? (s.tau < 0 ? 'Very early' : 'Very late') : s.tau < 0 ? 'Early' : 'Late';
      const where = s.aim == null ? '' : s.aim < -0.9 ? 'to your left' : s.aim > 0.9 ? 'to your right' : 'through the middle';
      this.showTiming(s.tau, when, where, a < 0.35 ? 'good' : a > 1 ? 'bad' : 'warn');
    }
    this.flashShot(nodes, s.serve ? 3200 : 2600);
  },
  // Swing feedback from the game: 'Too early', 'Too late' (the mark sits at that end of the scale), 'Missed', or a hint.
  timing(text) {
    const t = String(text || ''), early = /early/i.test(t), late = /late/i.test(t);
    this.showTiming(early ? -1.8 : late ? 1.8 : undefined, t, '', early || late || /miss/i.test(t) ? 'bad' : '');
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
