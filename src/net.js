import { Clock, Settings } from './core.js';
import { Game } from './game.js';
import { UI } from './ui.js';

// =====================================================================
// NET: peer-to-peer match over WebRTC via PeerJS. No game server to run.
// Each machine judges the ball that is travelling towards its own player, so
// your own swing never waits on the network.
// =====================================================================
const Net = {
  peer: null, conn: null, role: null, code: null, samples: [], pingTimer: 0, remote: null, remoteReady: false, rtt: 0, retries: 0, lastRecv: 0,
  available() { return typeof window.Peer === 'function'; },
  makeCode() { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[(Math.random() * A.length) | 0]; return s; },
  peerId(code) { return 'palmcourt-v1-' + code.toLowerCase(); },
  host() {
    const keep = this.role === 'host' ? this.retries : 0;
    this.reset(); this.retries = keep; this.role = 'host'; this.code = this.makeCode();
    UI.lobbyStatus('Creating your match…');
    const peer = (this.peer = new Peer(this.peerId(this.code), { debug: 1 }));
    peer.on('open', () => UI.lobbyHosting(this.code));
    peer.on('connection', (c) => {
      if (this.conn && this.conn.open) { c.on('open', () => { c.send({ type: 'full' }); setTimeout(() => c.close(), 400); }); return; }
      this.bind(c);
    });
    peer.on('disconnected', () => { if (!peer.destroyed) { try { peer.reconnect(); } catch (e) { /* retry later */ } } });
    peer.on('error', (e) => this.onError(e));
  },
  join(code) {
    this.reset(); this.role = 'guest'; this.code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    UI.lobbyStatus(`Connecting to match ${this.code}…`);
    const peer = (this.peer = new Peer({ debug: 1 }));
    peer.on('open', () => this.bind(peer.connect(this.peerId(this.code), { reliable: true, serialization: 'json' })));
    peer.on('error', (e) => this.onError(e));
  },
  bind(c) {
    this.conn = c;
    c.on('open', () => {
      Clock.resume(); Clock.pausedTotal = 0; Clock.offset = 0;
      this.send({ type: 'hello', name: Settings.name, handed: Settings.handed, pro: Settings.playAs, v: 1 });
      this.startPings();
    });
    c.on('data', (m) => { if (c === this.conn) this.lastRecv = performance.now(); try { this.onData(m); } catch (e) { console.warn(e); } });
    c.on('close', () => this.onClose());
    c.on('error', (e) => console.warn('connection error', e));
  },
  send(m) { try { if (this.conn && this.conn.open) this.conn.send(m); } catch (e) { console.warn(e); } },
  startPings() {
    clearInterval(this.pingTimer);
    let n = 0;
    this.lastRecv = performance.now();
    // PeerJS often never reports a closed connection when the other browser tab is closed or loses its network,
    // so a friend who has gone silent for several seconds (they answer pings every 2 s) counts as disconnected.
    const ping = () => {
      if (this.conn && performance.now() - this.lastRecv > 8000) { this.onClose(); return; }
      this.send({ type: 'ping', t: performance.now() });
    };
    ping();
    this.pingTimer = setInterval(() => { ping(); if (++n === 10 && this.conn) { clearInterval(this.pingTimer); this.pingTimer = setInterval(ping, 2000); } }, 200);
  },
  onData(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'hello':
        this.remote = { name: String(m.name || '').trim().slice(0, 12) || 'Friend', handed: m.handed === 'L' ? 'L' : 'R', pro: typeof m.pro === 'string' ? m.pro.slice(0, 16) : '' };
        UI.lobbyConnected(this.remote);
        break;
      case 'ready': this.remoteReady = true; UI.lobbyConnected(this.remote); break;
      case 'ping': this.send({ type: 'pong', t: m.t, h: performance.now() }); break;
      case 'pong': {
        const now = performance.now(), rtt = now - m.t, first = !this.samples.length;
        this.samples.push({ rtt, off: m.h + rtt / 2 - now });
        if (this.samples.length > 15) this.samples.shift();
        const best = this.samples.reduce((a, s) => (s.rtt < a.rtt ? s : a));
        this.rtt = rtt;
        if (this.role === 'guest') {
          Clock.offset = best.off / 1000;
          if (first && Game.mode === 'attract') Game.startAttract();
        }
        UI.netInfo();
        break;
      }
      case 'start': UI.startOnlineFromHost(m); break;
      case 'st': Game.onRemoteState(m); break;
      case 'toss': Game.onRemoteToss(m); break;
      case 'retoss': Game.onRemoteRetoss(m); break;
      case 'hit': Game.onRemoteHit(m); break;
      case 'sw': Game.onRemoteSwing(m); break;
      case 'call': Game.onRemoteCall(m); break;
      case 'rematch': UI.rematchFromRemote(); break;
      case 'bye': this.onClose(); break;
      case 'full': UI.lobbyStatus('That match already has two players. Ask your friend for a new link.', 'err'); break;
    }
  },
  onClose() {
    if (!this.conn && !this.remote) return;
    const wasPlaying = Game.mode === 'online', conn = this.conn;
    this.conn = null; this.remote = null; this.remoteReady = false;
    clearInterval(this.pingTimer);
    try { if (conn && conn.open) conn.close(); } catch (e) { /* already closed */ }
    UI.connectionLost(wasPlaying);
  },
  onError(e) {
    const t = e && e.type;
    if (t === 'unavailable-id' && this.role === 'host' && this.retries++ < 3) { this.host(); return; }
    const msg = {
      'peer-unavailable': 'No match found with that code. Check it, or ask your friend for a fresh link.',
      'browser-incompatible': 'This browser can’t make peer-to-peer connections. Try Chrome, Edge or Firefox.',
      network: 'Can’t reach the match server. Check your internet connection and try again.',
      'server-error': 'The match server had a problem. Try again in a moment.',
      'socket-error': 'Lost contact with the match server. Try again.',
      'socket-closed': 'Lost contact with the match server. Try again.',
      webrtc: 'The direct connection failed. Try again, or switch networks.',
    }[t] || 'Something went wrong while connecting. Try again.';
    UI.lobbyStatus(msg, 'err');
    console.warn('PeerJS error', e);
  },
  reset() {
    clearInterval(this.pingTimer);
    const conn = this.conn, peer = this.peer;
    this.peer = this.conn = null; this.samples = []; this.remote = null; this.remoteReady = false; this.rtt = 0; this.role = null;
    try { if (conn) conn.close(); } catch (e) { /* already closed */ }
    try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
    Clock.offset = 0;
  },
};
// Closing the tab: tell the other player straight away rather than leaving them waiting for the timeout.
addEventListener('pagehide', () => Net.send({ type: 'bye' }));

export { Net };
