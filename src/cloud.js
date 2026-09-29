// Palm Court: optional cloud save and leaderboards on Supabase, with plain fetch (no SDK). Dormant unless
// CONFIG.cloud.enabled is true and the player has not turned it off in Settings (or ?cloud=1 for testing). Local-first: the Profile in the browser is the real save;
// the cloud is a copy that follows it. The game never waits on the network: every call resolves (null / { ok: false })
// instead of throwing when the cloud is off, offline or failing. Server rules: supabase/schema.sql.
import { CONFIG } from './config.js';
import { Profile, normalize } from './profile.js';
import { levelFor } from './economy.js';
import { totalPoints, migrateTour } from './tour.js';

export const BOARDS = [
  { id: 'rating', name: 'Ranking points', unit: 'pts', hint: 'World Tour ranking points' },
  { id: 'level', name: 'Level', unit: '', hint: 'Player level' },
  { id: 'streak', name: 'Win streak', unit: 'wins', hint: 'Longest run of wins' },
  { id: 'serve', name: 'Fastest serve', unit: 'km/h', hint: 'Fastest serve' },
];
const HISTORY = 50, LEDGER = 60;                    // profile.js keeps this many
const MIN_GAP = 10000, CHANGE_WAIT = 15000, REWARD_WAIT = 2500, TIMEOUT = 8000, RETRY_CLAMPED = 10 * 60000;

// ---- config: CONFIG.cloud plus test overrides (?cloud=1 / ?cloud=0, ?cloudUrl= for a local mock server only) ----
const jwtRole = (k) => { try { return JSON.parse(atob(String(k).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch (e) { return ''; } };
// The player can turn online backup off in Settings (cloudSync: false, saved with the other settings).
const optedOut = () => { try { return JSON.parse(globalThis.localStorage?.getItem('palmcourt.v1') || '{}').cloudSync === false; } catch (e) { return false; } };
export function cloudConfig(base = CONFIG.cloud, search = globalThis.location?.search || '') {
  const c = { url: '', anonKey: '', enabled: false, ...(base || {}) };
  if (optedOut()) c.enabled = false;
  try {
    const q = new URLSearchParams(search), u = q.get('cloudUrl');
    if (q.get('cloud') === '1') c.enabled = true;
    if (q.get('cloud') === '0') c.enabled = false;
    // A session token must never go to a host named in a link: only localhost mocks may replace the project URL.
    if (u && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?\/?$/.test(u)) c.url = u;
  } catch (e) { /* no location (tests) */ }
  c.url = String(c.url || '').replace(/\/+$/, '');
  // Only a publishable (anon) key belongs in client code; refuse to run with a secret one.
  if (/^sb_secret_/.test(c.anonKey || '') || jwtRole(c.anonKey) === 'service_role') { console.warn('[cloud] config.js holds a secret key: cloud disabled. Use the publishable key.'); c.enabled = false; }
  c.enabled = !!(c.enabled && /^https?:\/\/[^/]+$/.test(c.url) && c.anonKey);
  return c;
}

// ---- display names: the same rules as the server's clean_display_name (the server has the last word) ----
export function checkName(s) {
  const n = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 3 || n.length > 16) return { ok: false, error: 'Names are 3 to 16 characters' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u.test(n)) return { ok: false, error: "Use letters, numbers, spaces, - _ or ' only" };
  if (n.replace(/\D/g, '').length > 6) return { ok: false, error: 'Too many digits for a name' };
  return { ok: true, name: n };
}

// ---- merge: last write wins for choices, progress only ever goes up ----
const num = (x) => (Number.isFinite(+x) ? +x : 0);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const fresh = (d) => !(num(d.xp) > 0) && !(d.history && d.history.length) && !(num(d.stats && d.stats.matches) > 0) && !Object.keys(d.owned || {}).length;
const earliest = (a = {}, b = {}) => { const o = { ...b, ...a }; for (const k of Object.keys(b)) if (k in a) o[k] = Math.min(num(a[k]) || num(b[k]), num(b[k]) || num(a[k])); return o; };
function maxStats(a = {}, b = {}, base = {}) {
  const o = { ...b, ...a, ...base };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (k === 'streak') o[k] = num(base[k]);                                            // the current run: the newer save's
    else if (typeof x === 'number' || typeof y === 'number') o[k] = Math.max(num(x), num(y));
    else if (isObj(x) || isObj(y)) o[k] = maxStats(isObj(x) ? x : {}, isObj(y) ? y : {}, {});
  }
  return o;
}
function mergeList(a, b, key, keep) {
  const seen = new Map();
  for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) { if (e && typeof e === 'object') { const k = key(e); if (!seen.has(k)) seen.set(k, e); } }
  return [...seen.values()].sort((x, y) => num(x.t) - num(y.t)).slice(-keep);
}
function mergeDaily(a = {}, b = {}, base) {
  if ((a.date || '') !== (b.date || '')) return { ...((a.date || '') > (b.date || '') ? a : b) };
  const o = { ...(base === a ? b : a), ...base }, per = (k, f) => { const x = a[k] || {}, y = b[k] || {}, r = { ...y, ...x }; for (const i of Object.keys(y)) if (i in x) r[i] = f(x[i], y[i]); return r; };
  o.done = per('done', (x, y) => Math.min(num(x) || num(y), num(y) || num(x)));
  o.progress = per('progress', (x, y) => Math.max(num(x), num(y)));
  o.rerolled = !!(a.rerolled || b.rerolled);
  o.lastWin = [a.lastWin || '', b.lastWin || ''].sort().pop();
  return o;
}
const tourKey = (t) => [num(t.season), num(t.week), num(t.stats && t.stats.runs), (t.history || []).length];
function mergeTour(a, b, base) {
  if (!isObj(a) || !isObj(b)) return isObj(a) ? a : b;
  const ka = tourKey(a), kb = tourKey(b), i = ka.findIndex((x, j) => x !== kb[j]);
  const win = i < 0 ? (isObj(base) ? base : a) : ka[i] > kb[i] ? a : b;   // the career that is further along, whole (a run can't be mixed)
  const out = { ...win, trophies: mergeList(a.trophies, b.trophies, (x) => `${x.ev}|${x.season}|${x.t}`, 500) };
  if (a.best != null || b.best != null) out.best = Math.min(num(a.best) || Infinity, num(b.best) || Infinity);
  if (!Number.isFinite(out.best)) delete out.best;
  return out;
}
// Merge two saves (plain profile objects) so nothing earned is lost: XP, stats, owned items, achievements and trophies
// only go up (max / union); Fuzz = the most ever earned minus the most ever spent; choices (equipped, daily picks)
// come from the newer save, but a fresh never-played profile never overrides a played one.
export function mergeSaves(local, remote) {
  if (!isObj(remote)) return local;
  if (!isObj(local)) return remote;
  const A = local, B = remote;
  let base = num(B.updated) > num(A.updated) ? B : A;
  if (fresh(base) && !fresh(base === A ? B : A)) base = base === A ? B : A;
  const other = base === A ? B : A, out = { ...other, ...base };
  const older = num(A.created) && (!num(B.created) || num(A.created) <= num(B.created)) ? A : B;
  out.id = older.id || base.id;
  out.created = Math.min(num(A.created) || Infinity, num(B.created) || Infinity);
  if (!Number.isFinite(out.created)) out.created = Date.now();
  out.updated = Math.max(num(A.updated), num(B.updated));
  out.v = Math.max(num(A.v), num(B.v));
  out.xp = Math.max(num(A.xp), num(B.xp));
  const earned = (d) => Math.max(num(d.stats && d.stats.fuzzEarned), num(d.fuzz)), spent = (d) => earned(d) - num(d.fuzz);
  const E = Math.max(earned(A), earned(B)), S = Math.max(spent(A), spent(B));
  out.fuzz = Math.max(0, E - S);
  out.stats = maxStats(A.stats || {}, B.stats || {}, base.stats || {});
  out.stats.fuzzEarned = E;
  out.owned = earliest(A.owned, B.owned);
  out.achievements = earliest(A.achievements, B.achievements);
  out.equipped = { ...(other.equipped || {}), ...(base.equipped || {}) };
  out.upgrades = { ...(isObj(A.upgrades) ? A.upgrades : {}) };   // G1: gear upgrades were paid for, so they only go up
  if (isObj(B.upgrades)) for (const [k, n] of Object.entries(B.upgrades)) out.upgrades[k] = Math.max(num(out.upgrades[k]), num(n));
  out.history = mergeList(A.history, B.history, (h) => `${h.t}|${h.score}|${h.opponent}`, HISTORY);
  out.ledger = mergeList(A.ledger, B.ledger, (l) => `${l.t}|${l.kind}|${l.n}|${l.why}`, LEDGER);
  out.daily = mergeDaily(A.daily || {}, B.daily || {}, base.daily || {});
  out.seen = { ...(other.seen || {}), ...(base.seen || {}), level: Math.max(num(A.seen && A.seen.level), num(B.seen && B.seen.level), 1) };
  if (A.tour || B.tour) out.tour = mergeTour(A.tour, B.tour, base.tour);
  return out;
}
// Key-order-independent JSON, to tell whether two saves differ.
export function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
// What each leaderboard gets from a save.
export function scoresFrom(d) {
  const st = (d && d.stats) || {};
  let rating = 0;
  try { rating = d && d.tour ? totalPoints(migrateTour(d.tour)) : 0; } catch (e) { /* odd tour state */ }
  return { rating: Math.max(0, Math.floor(rating)), level: levelFor(num(d && d.xp)), streak: Math.floor(num(st.bestStreak)), serve: Math.floor(num(st.fastestServe)) };
}
const seasonKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

// ---- the client ----
function localStore() { try { const ls = globalThis.localStorage; ls.getItem('x'); return ls; } catch (e) { return null; } }
export function createCloud({ config = cloudConfig(), profile = Profile, fetch: fetchFn = globalThis.fetch?.bind(globalThis), storage = localStore(), now = () => Date.now() } = {}) {
  const cfg = config, host = (() => { try { return new URL(cfg.url).host; } catch (e) { return 'none'; } })();
  const SKEY = `palmcourt.cloud.session:${host}`, NKEY = `palmcourt.cloud.sent:${host}`;
  const read = (k) => { try { const s = storage && storage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const write = (k, v) => { try { if (storage) v == null ? storage.removeItem(k) : storage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota / blocked */ } };
  const listeners = new Map();
  const emit = (evt, data) => { for (const fn of [...(listeners.get(evt) || [])]) { try { fn(data); } catch (e) { console.warn('[cloud] handler failed', e); } } };

  const C = {
    get enabled() { return cfg.enabled; },
    config: cfg,
    ready: Promise.resolve(false),
    status: cfg.enabled ? 'idle' : 'off',   // off | idle | syncing | ok | offline | error
    error: '', lastSync: 0, session: read(SKEY), name: null, sent: read(NKEY) || {}, dirty: false, applying: false, started: false,
    busy: () => false,                      // the UI sets this: true while a match is being played
    signing: null, syncing: null, timer: 0,

    on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
    get userId() { return (this.session && this.session.user_id) || null; },
    get displayName() { return this.name; },
    setStatus(s, err = '') { this.status = s; this.error = err; emit('status', { status: s, error: err, lastSync: this.lastSync }); },
    offline() { return globalThis.navigator && globalThis.navigator.onLine === false; },

    // One HTTP call. auth: send the player's access token (refreshing it first if needed).
    async req(path, { method = 'GET', body, auth = true, headers = {}, keepalive = false, retry = true } = {}) {
      if (!fetchFn) throw new Error('no fetch');
      const h = { apikey: cfg.anonKey, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (auth) { const s = await this.signIn(); if (!s) throw new Error('not signed in'); h.Authorization = `Bearer ${s.access_token}`; }
      const ctl = typeof AbortController === 'function' ? new AbortController() : null, t = ctl && setTimeout(() => ctl.abort(), TIMEOUT);
      let r, text;
      try {
        r = await fetchFn(cfg.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined, keepalive, cache: 'no-store' });
        text = await r.text();
      } finally { clearTimeout(t); }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (r.status === 401 && auth && retry && this.session) { this.session.expires_at = 0; return this.req(path, { method, body, auth, headers, keepalive, retry: false }); }
      if (!r.ok) { const e = new Error((data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${r.status}`); e.status = r.status; throw e; }
      return data;
    },
    keep(res) {
      if (!res || !res.access_token || !(res.user && res.user.id)) throw new Error('bad auth response');
      const exp = num(res.expires_at) || Math.floor(now() / 1000) + (num(res.expires_in) || 3600);
      this.session = { access_token: res.access_token, refresh_token: res.refresh_token || '', expires_at: exp, user_id: res.user.id };
      write(SKEY, this.session);
      return this.session;
    },
    // Anonymous sign-in, kept in localStorage and refreshed before it expires. Resolves to the session or null.
    signIn() {
      if (!this.enabled) return Promise.resolve(null);
      const s = this.session;
      if (s && s.access_token && num(s.expires_at) - 60 > now() / 1000) return Promise.resolve(s);
      if (this.signing) return this.signing;
      this.signing = (async () => {
        if (s && s.refresh_token) {
          try { return this.keep(await this.req('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token }, auth: false })); }
          catch (e) { if (!(e.status >= 400 && e.status < 500)) return null; this.forget(); }   // refresh token gone: start a new anonymous player
        }
        try { return this.keep(await this.req('/auth/v1/signup', { method: 'POST', body: { data: {} }, auth: false })); }
        catch (e) { this.setStatus('error', `Sign-in failed: ${e.message}`); return null; }
      })().catch(() => null).finally(() => { this.signing = null; });
      return this.signing;
    },
    forget() { this.session = null; this.name = null; this.sent = {}; write(SKEY, null); write(NKEY, null); },

    // Pull the cloud save, merge it with the local one, push the result, then submit leaderboard scores.
    sync() {
      if (!this.enabled) return Promise.resolve({ ok: false, reason: 'disabled' });
      if (this.syncing) return this.syncing;
      this.syncing = (async () => {
        await profile.ready;
        if (this.offline()) { this.setStatus('offline'); return { ok: false, reason: 'offline' }; }
        if (this.busy()) return { ok: false, reason: 'busy' };
        this.setStatus('syncing');
        const s = await this.signIn();
        if (!s) { if (this.status === 'syncing') this.setStatus('error', 'Could not sign in'); return { ok: false, reason: 'auth' }; }
        const rows = await this.req(`/rest/v1/saves?select=save,version,updated_at&user_id=eq.${encodeURIComponent(s.user_id)}`);
        const remote = Array.isArray(rows) && rows[0] ? normalize(rows[0].save) : null;
        if (this.busy()) { this.setStatus('idle'); return { ok: false, reason: 'busy' }; }
        // Merge against the save as it is now (not as it was before the request), so nothing done meanwhile is lost.
        const local = profile.data, merged = remote ? mergeSaves(local, remote) : local, key = stable(merged);
        let pulled = false, pushed = false;
        if (remote && key !== stable(local)) { this.apply(merged); pulled = true; }
        this.dirty = false;   // changes made from here on mark it again
        if (!remote || key !== stable(remote)) {
          try { await this.req('/rest/v1/saves?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { user_id: s.user_id, save: profile.data, version: Math.max(1, Math.floor(num(profile.data.v)) || 1) } }); }
          catch (e) { this.dirty = true; throw e; }
          pushed = true;
        }
        const submitted = await this.submitAll(profile.data);
        if (this.name == null) this.fetchName();
        this.lastSync = now();
        this.setStatus('ok');
        const res = { ok: true, pulled, pushed, submitted };
        emit('sync', res);
        return res;
      })().catch((e) => { this.setStatus(this.offline() ? 'offline' : 'error', e.message || String(e)); return { ok: false, reason: 'error', error: e.message || String(e) }; })
        .finally(() => { this.syncing = null; });
      return this.syncing;
    },
    // Adopt a merged save locally (saved at once; listeners hear a 'change', like an import).
    apply(merged) {
      const d = normalize(merged);
      if (!d) return false;
      const from = profile.level;
      this.applying = true;
      try {
        profile.data = d;
        profile.emit('change', profile);
        if (profile.level > from) profile.emit('levelup', { from, to: profile.level, imported: true, cloud: true });
      } finally { this.applying = false; }
      profile.save(true);
      return true;
    },
    // Leaderboard values that went up since they were last sent (or a new season started, or the server clamped them).
    async submitAll(d) {
      const vals = scoresFrom(d), season = seasonKey(now()), out = {};
      if (this.sent.uid !== this.userId) this.sent = { uid: this.userId, boards: {} };
      for (const b of BOARDS) {
        const v = vals[b.id], last = this.sent.boards[b.id];
        if (!(v > 0) || (b.id === 'level' && v < 2)) continue;
        if (last && last.season === season && v <= last.v && (last.full || now() - last.at < RETRY_CLAMPED)) continue;
        const r = await this.submit(b.id, v);
        if (r && r.ok) { this.sent.boards[b.id] = { v, at: now(), season, full: !r.clamped }; out[b.id] = r; }
      }
      write(NKEY, this.sent);
      return out;
    },
    async submit(board, value) {
      if (!this.enabled || !BOARDS.some((b) => b.id === board) || !(Number.isFinite(+value) && +value >= 0)) return null;
      try { return await this.req('/rest/v1/rpc/submit_score', { method: 'POST', body: { p_board: board, p_value: Math.floor(+value) } }); }
      catch (e) { console.warn('[cloud] submit failed', board, e.message); return null; }
    },
    // A board's top rows plus your own: { board, period, rows: [{ place, name, value, me }], me } or null.
    async leaderboard(board, { period = 'all', limit = 50 } = {}) {
      if (!this.enabled) return null;
      try {
        const s = await this.signIn();
        const rows = await this.req('/rest/v1/rpc/leaderboard', { method: 'POST', body: { p_board: board, p_period: period === 'season' ? 'season' : 'all', p_limit: limit }, auth: !!s });
        const list = (Array.isArray(rows) ? rows : []).map((r) => ({ place: num(r.place), name: String(r.name ?? ''), value: num(r.value), me: !!r.me }));
        return { board, period, rows: list, me: list.find((r) => r.me) || null };
      } catch (e) { console.warn('[cloud] leaderboard failed', e.message); return null; }
    },
    async fetchName() {
      try {
        const rows = await this.req('/rest/v1/players?select=display_name');
        this.name = Array.isArray(rows) && rows[0] ? String(rows[0].display_name) : '';
        emit('name', this.name);
      } catch (e) { /* try again next sync */ }
      return this.name;
    },
    // { ok, name } or { ok: false, error } (a readable reason from the local check or the server).
    async setDisplayName(name) {
      if (!this.enabled) return { ok: false, error: 'Online features are off' };
      const c = checkName(name);
      if (!c.ok) return c;
      try {
        const n = await this.req('/rest/v1/rpc/set_display_name', { method: 'POST', body: { p_name: c.name } });
        this.name = typeof n === 'string' ? n : c.name;
        emit('name', this.name);
        return { ok: true, name: this.name };
      } catch (e) { return { ok: false, error: e.status ? e.message : (e.message === 'not signed in' && this.error) || 'No connection: try again later' }; }   // a failed sign-in says why (e.g. anonymous sign-ins are off in Supabase)
    },

    // ---- automatic sync: after matches (Profile 'reward'), after other changes (debounced), when back online ----
    schedule(ms) {
      if (!this.enabled) return;
      clearTimeout(this.timer);
      const wait = Math.max(ms, this.lastSync + MIN_GAP - now(), 0);
      this.timer = setTimeout(() => { this.timer = 0; this.sync().then((r) => { if (r.reason === 'busy') this.schedule(CHANGE_WAIT); }); }, wait);
    },
    // On leaving the page: push unsynced changes (no merge; the next sync merges) with a request that outlives the tab.
    flushOnHide() {
      const s = this.session;
      if (!this.enabled || !this.dirty || !s || num(s.expires_at) - 30 < now() / 1000 || !fetchFn) return false;
      const body = JSON.stringify({ user_id: s.user_id, save: profile.data, version: Math.max(1, Math.floor(num(profile.data.v)) || 1) });
      if (body.length > 60000) return false;   // keepalive requests are capped at 64 KB
      try { fetchFn(`${cfg.url}/rest/v1/saves?on_conflict=user_id`, { method: 'POST', keepalive: true, headers: { apikey: cfg.anonKey, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body }).catch(() => {}); } catch (e) { return false; }
      this.dirty = false;
      return true;
    },
    start({ delay = 1500 } = {}) {
      if (!this.enabled) return this.ready;
      if (this.started) return this.ready;
      this.started = true;
      profile.on('change', () => { if (!this.applying) { this.dirty = true; this.schedule(CHANGE_WAIT); } });
      profile.on('reward', () => this.schedule(REWARD_WAIT));
      if (globalThis.addEventListener) {
        addEventListener('online', () => this.schedule(1000));
        addEventListener('pagehide', () => this.flushOnHide());
      }
      if (globalThis.document) document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushOnHide(); });
      this.ready = Promise.resolve(profile.ready).then(() => new Promise((r) => setTimeout(r, delay))).then(() => this.sync()).then((r) => !!(r && r.ok), () => false);
      return this.ready;
    },
  };
  return C;
}

export const Cloud = createCloud();
