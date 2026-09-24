import { Clock, Settings } from './core.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { QR } from './qr.js';

// =====================================================================
// PHONE: your phone as the racket. controller.html runs on the phone, reads its gyroscope, spots each
// swing on the phone itself and sends it here stamped with game time. Two routes to the phone: through
// the PC's own server (serve.py relays it over the Wi-Fi, no internet needed), or a direct WebRTC link
// through the public PeerJS server (when the game isn't served by play.cmd, or the relay can't be used).
// =====================================================================
const Phone = {
  prefix: 'palmcourt-rk-',
  peer: null, peerError: false, peerTimer: 0, idRetries: 0,
  ws: null, wsRetries: 0, relayOff: false, relayConn: null,
  conn: null, code: null, device: '', via: '', armed: false, calibrated: false, rtt: 0, lastSwing: null, lastStateKey: '',
  info: undefined, urls: [], pick: 0, url: undefined,
  connected() { return !!(this.conn && this.conn.open); },
  relayUp() { return !!(this.ws && this.ws.readyState === 1); },
  status() {
    if (this.connected()) return 'connected';
    if (this.relayUp() || (this.peer && this.peer.open)) return 'waiting';
    if (!Net.available() && this.info === null) return 'unavailable';
    if (this.peerError && this.info === null) return 'error';
    return 'starting';
  },
  ensure() {
    // Keep the same code across reloads so a paired phone finds the game again by itself.
    this.code = this.code || (/^[A-Z0-9]{5}$/.test(Settings.phoneCode || '') ? Settings.phoneCode : Net.makeCode());
    if (Settings.phoneCode !== this.code) { Settings.phoneCode = this.code; Settings.save(); }
    this.ensureRelay();
    this.ensurePeer();
    UI.renderPhone();
  },
  ensurePeer() {
    if (!Net.available()) return;
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) { /* retried on the next open */ } }
      return;
    }
    const peer = (this.peer = new Peer(this.prefix + this.code.toLowerCase(), { debug: 1 }));
    peer.on('open', () => { this.idRetries = 0; this.peerError = false; UI.renderPhone(); });
    peer.on('connection', (c) => this.bind(c, 'internet'));
    peer.on('disconnected', () => { setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch (e) { /* retry later */ } }, 1500); });
    peer.on('error', (e) => this.onPeerError(e, peer));
  },
  onPeerError(e, peer) {
    const t = e && e.type;
    if (t === 'unavailable-id') {
      // The previous page's registration can take a few seconds to clear: retry the same code, then pick a new one
      // (unless a phone is already on its way through the relay with this code).
      try { peer.destroy(); } catch (x) { /* gone */ }
      if (this.peer === peer) this.peer = null;
      if (this.idRetries++ >= 4 && !this.connected() && !this.relayUp()) { this.code = Net.makeCode(); this.idRetries = 0; this.restartRelay(); }
      setTimeout(() => this.ensure(), 2500);
      return;
    }
    console.warn('phone link', e);
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || t === 'browser-incompatible') {
      // Keep trying quietly: the PeerJS server or this PC's internet may come back.
      this.peerError = true;
      clearTimeout(this.peerTimer);
      this.peerTimer = setTimeout(() => { if (this.peer && this.peer.destroyed) this.peer = null; this.ensurePeer(); }, 8000);
      UI.renderPhone();
    }
  },

  // ---- the relay through serve.py ----
  async ensureRelay() {
    if (this.ws || this.relayOff || this.relayStarting) return;
    this.relayStarting = true;
    const info = await this.lan();
    this.relayStarting = false;
    if (!info || !info.relay || this.ws || this.relayOff) return;
    const ws = (this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/link?role=game&code=${this.code}`));
    ws.onopen = () => { this.wsRetries = 0; UI.renderPhone(); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (this.ws === ws) this.onRelay(m, ws); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.relayConn) this.relayConn.drop();
      if (!this.relayOff) setTimeout(() => this.ensureRelay(), Math.min(10000, 1000 * 2 ** this.wsRetries++));
      UI.renderPhone();
    };
  },
  onRelay(m, ws) {
    if (m.relay === 'open') {
      if (this.relayConn) this.relayConn.drop();
      this.relayConn = relayConn(ws);
      this.bind(this.relayConn, 'wifi');
    } else if (m.relay === 'close') { if (this.relayConn) this.relayConn.drop(); }
    else if (m.relay === 'replaced') { this.relayOff = true; ws.close(); }   // the game is open in a newer tab
    else if (this.relayConn) this.relayConn.emit('data', m);
  },
  restartRelay() {
    const ws = this.ws;
    this.ws = null;
    if (this.relayConn) this.relayConn.drop();
    if (ws) ws.close();
    this.ensureRelay();
  },

  // ---- a phone link (relay or PeerJS) ----
  bind(c, via) {
    c.via = via;
    c.on('data', (m) => { try { this.onData(m, c); } catch (e) { console.warn(e); } });
    c.on('close', () => { if (this.conn === c) { this.conn = null; UI.renderPhone(); UI.phoneChip(); } });
    c.on('error', (e) => console.warn('phone connection', e));
  },
  // A phone becomes the racket when it says hello. The newest phone wins, and the old one is told so it stops
  // reconnecting; the same phone switching routes (same session id) is swapped over quietly.
  adopt(c, m) {
    const old = this.conn;
    this.conn = c;
    if (old && old !== c) {
      if (old.sid !== m.sid) { try { old.send({ type: 'replaced' }); } catch (e) { /* link dropped */ } }
      setTimeout(() => { try { old.close(); } catch (e) { /* closed */ } }, 300);
    }
    c.sid = m.sid;
    this.via = c.via; this.lastStateKey = '';
    this.send({ type: 'welcome', handed: Settings.handed, name: Settings.name });
    this.pushState();
  },
  onData(m, c) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') { try { c.send({ type: 'pong', t: m.t, g: Clock.now() * 1000 }); } catch (e) { /* link dropped */ } return; }
    if (m.type === 'hello') this.adopt(c, m);
    else if (c !== this.conn) return;
    switch (m.type) {
      case 'swingStart': Input.phoneSwingStart(m); return;
      case 'toss': Input.emit({ type: 'toss', src: 'phone' }); return;
      case 'hello': this.device = String(m.device || 'Phone').slice(0, 30); this.calibrated = !!m.calibrated; this.armed = m.armed !== false; break;
      case 'status': this.calibrated = !!m.calibrated; this.armed = !!m.armed; break;
      case 'rtt': this.rtt = Math.round(+m.rtt || 0); break;
      case 'calib': this.calibrated = !!m.done; break;
      case 'swing': this.lastSwing = m; Input.phoneSwing(m); UI.phoneSwing(m); break;
      default: return;
    }
    UI.renderPhone(); UI.phoneChip();
  },
  send(m) {
    // A hit also says which stroke it was, so an uncalibrated phone can learn forehand from backhand as you play.
    if (m && m.type === 'hit' && !m.stroke) { const me = Game.me(); if (me && me.plan) m = { ...m, stroke: me.plan.stroke }; }
    try { if (this.connected()) this.conn.send(m); } catch (e) { /* link dropped */ }
  },
  // What the phone should show: your serve, which stroke is coming, or nothing much.
  pushState() {
    if (!this.connected()) return;
    const me = Game.me(), m = Game.match, b = Game.ball;
    let s = { inMatch: false };
    if (me && m && (Game.mode === 'cpu' || Game.mode === 'online') && Game.state !== 'over') {
      const serving = m.currentServer === me.idx && (Game.state === 'serve' || Game.state === 'toss');
      const incoming = Game.state === 'rally' && me.plan && b.lastHitter >= 0 && b.lastHitter !== me.idx && me.hitFor !== b.rally;
      s = { inMatch: true, serving, tossed: serving && Game.state === 'toss', stroke: incoming ? me.plan.stroke : null };
    }
    const key = JSON.stringify(s);
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.send({ type: 'state', ...s });
  },

  // ---- where the phone should go ----
  // serve.py's lan.json: the phone addresses, why there are none, the firewall, and how far a phone got.
  async lan(fresh) {
    if (this.info !== undefined && !fresh) return this.info;
    let info = null;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try { const r = await fetch('lan.json', { cache: 'no-store' }); if (r.ok) info = await r.json(); } catch (e) { /* not served by play.cmd */ }
    }
    this.info = info && typeof info === 'object' ? info : null;
    return this.info;
  },
  // The phone page must be https (phones only share motion sensors with secure pages).
  async pageUrl(fresh) {
    const info = await this.lan(fresh);
    let urls = [];
    if (location.protocol === 'https:') urls = [{ url: new URL('controller.html', location.href).href, name: '' }];
    else if (info && Array.isArray(info.urls)) urls = info.urls.filter((u) => u && /^https:\/\//.test(u.url)).map((u) => ({ url: new URL('controller.html', u.url).href, name: String(u.name || ''), ip: u.ip }));
    else if (info && info.phoneUrl) urls = [{ url: new URL('controller.html', info.phoneUrl).href, name: '' }];
    this.urls = urls;
    if (this.pick >= urls.length) this.pick = 0;
    this.url = urls.length ? urls[this.pick].url : null;
    return this.url;
  },
  link() { return this.url && this.code ? `${this.url}?c=${this.code}` : null; },
};

// A phone reached through serve.py's relay, dressed up like a PeerJS DataConnection.
function relayConn(ws) {
  const on = {};
  const c = {
    open: true,
    on(ev, fn) { on[ev] = fn; },
    emit(ev, x) { if (on[ev]) on[ev](x); },
    send(m) { if (c.open && ws.readyState === 1) ws.send(JSON.stringify(m)); },
    close() { if (!c.open) return; if (ws.readyState === 1) ws.send(JSON.stringify({ relay: 'kick' })); c.drop(); },
    drop() { if (!c.open) return; c.open = false; c.emit('close'); },
  };
  return c;
}

function drawQR(canvas, text) {
  const ctx = canvas.getContext('2d'), size = canvas.width;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
  const qr = text ? QR.encode(text) : null;
  if (!qr) return false;
  const n = qr.size, cell = Math.floor(size / (n + 8)), off = Math.floor((size - cell * n) / 2);
  ctx.fillStyle = '#09131d';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules[y][x]) ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
  return true;
}

export { Phone, drawQR };
