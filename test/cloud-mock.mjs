// A tiny stand-in for the Supabase endpoints src/cloud.js uses (auth/v1 signup + refresh, rest/v1 saves / players and
// the rpc functions), for tests and local browser checks. Imitates supabase/schema.sql's rules: RLS (your own save row
// only), the leaderboard clamps (cap, first score limit, max) and display-name checks. Never talks to the real project.
// Run on its own: node test/cloud-mock.mjs 8907   (then open the game with ?cloud=1&cloudUrl=http://127.0.0.1:8907)
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

export const MOCK_KEY = 'sb_publishable_OvSeFiGjv6xvQlPPVGv-7Q_popyx3Zm';   // the publishable key in src/config.js
const BOARDS = { rating: { max: 30000, cap: 25000, first: 3000 }, level: { max: 50, cap: 50, first: 15 }, streak: { max: 1000, cap: 500, first: 10 }, serve: { max: 300, cap: 250, first: 250 } };
const BANNED = ['fuck', 'shit', 'cunt', 'admin'];

export function startMock({ port = 0, key = MOCK_KEY, expiresIn = 3600 } = {}) {
  const S = { users: new Map(), tokens: new Map(), refresh: new Map(), saves: new Map(), scores: new Map(), names: new Map(), calls: [], fail: false, anonDisabled: false };
  const season = () => new Date().toISOString().slice(0, 7);
  const issue = (uid) => {
    const access = randomBytes(12).toString('hex'), refresh = randomBytes(12).toString('hex');
    S.tokens.set(access, { uid, exp: Date.now() / 1000 + expiresIn }); S.refresh.set(refresh, uid);
    return { access_token: access, token_type: 'bearer', expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000 + expiresIn), refresh_token: refresh, user: { id: uid, is_anonymous: true, role: 'authenticated' } };
  };
  const board = (b, period) => [...S.scores.values()].filter((r) => r.board === b && r.period === period && r.value > 0).sort((x, y) => y.value - x.value || x.at - y.at);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
    const send = (code, body) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      S.calls.push(`${req.method} ${u.pathname}`);
      if (S.fail) return send(503, { message: 'down' });
      if (req.headers.apikey !== key) return send(401, { message: 'Invalid API key' });
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(400, { message: 'bad json' }); }
      const tok = (req.headers.authorization || '').replace(/^Bearer /, ''), t = S.tokens.get(tok);
      if (tok && (!t || t.exp < Date.now() / 1000)) return send(401, { message: 'JWT expired' });
      const uid = t ? t.uid : null, p = u.pathname;
      if (p === '/auth/v1/signup' && req.method === 'POST') {
        if (S.anonDisabled) return send(422, { msg: 'Anonymous sign-ins are disabled' });
        const id = randomUUID(); S.users.set(id, { id }); return send(200, issue(id));
      }
      if (p === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
        const id = S.refresh.get(body && body.refresh_token);
        if (!id) return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        S.refresh.delete(body.refresh_token); return send(200, issue(id));
      }
      if (p === '/rest/v1/saves' && req.method === 'GET') {
        if (!uid) return send(200, []);
        const row = S.saves.get(uid); return send(200, row ? [{ save: row.save, version: row.version, updated_at: new Date(row.at).toISOString() }] : []);
      }
      if (p === '/rest/v1/saves' && req.method === 'POST') {
        if (!uid || !body || body.user_id !== uid) return send(403, { code: '42501', message: 'new row violates row-level security policy for table "saves"' });
        if (!body.save || typeof body.save !== 'object' || Array.isArray(body.save) || JSON.stringify(body.save).length > 262144 || !(body.version >= 1 && body.version <= 1000)) return send(400, { code: '23514', message: 'violates check constraint' });
        S.saves.set(uid, { save: body.save, version: body.version, at: Date.now() }); return send(201);
      }
      if (p === '/rest/v1/players' && req.method === 'GET') return send(200, uid && S.names.has(uid) ? [{ display_name: S.names.get(uid) }] : []);
      if (p === '/rest/v1/rpc/set_display_name') {
        if (!uid) return send(401, { message: 'Sign in first' });
        const n = String((body && body.p_name) || '').trim().replace(/\s+/g, ' ');
        if (n.length < 3 || n.length > 16 || !/^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u.test(n)) return send(400, { code: '22023', message: 'Names are 3 to 16 characters' });
        if (BANNED.some((w) => n.toLowerCase().replace(/[^a-z]/g, '').includes(w))) return send(400, { code: '22023', message: 'Please pick another name' });
        S.names.set(uid, n); return send(200, n);
      }
      if (p === '/rest/v1/rpc/submit_score') {
        if (!uid) return send(401, { message: 'Sign in first' });
        const B = BOARDS[body && body.p_board], v0 = Number(body && body.p_value);
        if (!B) return send(400, { code: '22023', message: 'Unknown board' });
        if (!Number.isFinite(v0) || v0 < 0 || v0 > B.max) return send(400, { code: '22003', message: 'Impossible score' });
        const k = `${uid}|${body.p_board}|all`, cur = S.scores.get(k), v = Math.floor(Math.min(v0, B.cap, cur ? Infinity : B.first));
        const best = Math.max(cur ? cur.value : 0, v);
        S.scores.set(k, { uid, board: body.p_board, period: 'all', value: best, at: cur && cur.value >= v ? cur.at : Date.now() });
        const ks = `${uid}|${body.p_board}|${season()}`, cs = S.scores.get(ks);
        if (!cs || v > cs.value) S.scores.set(ks, { uid, board: body.p_board, period: season(), value: v, at: Date.now() });
        return send(200, { ok: true, board: body.p_board, value: best, season: S.scores.get(ks).value, accepted: v, clamped: v < Math.floor(v0) });
      }
      if (p === '/rest/v1/rpc/leaderboard') {
        const rows = board(body && body.p_board, body && body.p_period === 'season' ? season() : 'all'), lim = Math.min(100, Math.max(1, +(body && body.p_limit) || 50));
        let place = 0, prev = null;
        const out = rows.map((r, i) => { if (!prev || r.value !== prev.value || r.at !== prev.at) place = i + 1; prev = r; return { place, name: S.names.get(r.uid) || `Player ${r.uid.slice(0, 4).toUpperCase()}`, value: r.value, me: r.uid === uid }; });
        return send(200, out.filter((r) => r.place <= lim || r.me));
      }
      send(404, { message: `no route ${req.method} ${p}` });
    });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, state: S, server, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: +process.argv[2] || 8907 });
  console.log(`cloud mock on ${m.url}`);
}
