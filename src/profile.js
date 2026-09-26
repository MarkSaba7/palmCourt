// Palm Court: the player's progress (XP, Fuzz, unlocks, equipped cosmetics, career stats, match history, daily
// challenges, achievements). Local-first: IndexedDB, mirrored to localStorage (synchronous, so a closing tab still
// saves), in memory when the browser blocks both. Versioned schema with migrations; a backup copy of the last good
// save survives a corrupt one. Optional cloud sync (Profile.useCloud) stays off unless src/config.js has a Supabase
// url + anonKey. Settings (core.js) stay separate: Profile is progress only.
import { MAX_LEVEL, xpForLevel, xpToReach, levelFor, CATALOG, SLOTS, newStats, useProfile, itemById } from './economy.js';

export const SCHEMA = 2;
const KEY = 'palmcourt.profile', BAK = 'palmcourt.profile.bak', BAD = 'palmcourt.profile.corrupt';
const HISTORY = 50, LEDGER = 60, SAVE_MS = 400;

const uid = () => { try { return crypto.randomUUID(); } catch (e) { return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; } };
export function freshData() {
  const now = Date.now();
  return {
    v: SCHEMA, id: uid(), created: now, updated: now, xp: 0, fuzz: 0,
    owned: {},                                              // catalog id -> time granted (free items are never listed)
    equipped: Object.fromEntries(SLOTS.map((s) => [s, null])),
    stats: newStats(), history: [], ledger: [],
    daily: { date: '', ids: [], progress: {}, done: {}, rerolled: false, lastWin: '' },
    achievements: {},                                        // id -> time earned
    seen: { level: 1 },                                      // what the UI has already announced
  };
}

// Migrations: MIGRATIONS[n] turns a version-n save into version n+1. Version 0 = an early unversioned save.
export const MIGRATIONS = {
  0: (d) => ({ ...d, v: 1, owned: Array.isArray(d.owned) ? Object.fromEntries(d.owned.map((id) => [id, 0])) : d.owned || {} }),
  1: (d) => ({ ...d, v: 2, seen: d.seen || { level: levelFor(+d.xp || 0) }, ledger: d.ledger || [] }),   // v2: seen + ledger
};
// A plain object -> a valid current-schema profile, or null if it isn't a profile at all. Unknown fields are kept.
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let d = { ...raw }, v = Number.isInteger(d.v) ? d.v : 0;
  if (v < 0) return null;
  while (v < SCHEMA) { d = MIGRATIONS[v](d); v = d.v; }
  if (!Number.isFinite(+d.xp) || !Number.isFinite(+d.fuzz)) return null;
  const f = freshData(), obj = (x, def) => (x && typeof x === 'object' && !Array.isArray(x) ? x : def);
  return {
    ...f, ...d, v: Math.max(SCHEMA, d.v), xp: Math.max(0, Math.floor(+d.xp)), fuzz: Math.max(0, Math.floor(+d.fuzz)),
    id: typeof d.id === 'string' && d.id ? d.id : f.id,
    owned: obj(d.owned, {}), equipped: { ...f.equipped, ...obj(d.equipped, {}) }, stats: { ...f.stats, ...obj(d.stats, {}) },
    history: Array.isArray(d.history) ? d.history.slice(-HISTORY) : [], ledger: Array.isArray(d.ledger) ? d.ledger.slice(-LEDGER) : [],
    daily: { ...f.daily, ...obj(d.daily, {}) }, achievements: obj(d.achievements, {}), seen: { ...f.seen, ...obj(d.seen, {}) },
  };
}
function parse(s) { if (typeof s !== 'string' || !s) return null; try { return normalize(JSON.parse(s)); } catch (e) { return null; } }

// ---- storage backends: get(key) -> Promise<string|null>, set(key, string) -> Promise ----
function lsBackend() {
  try {
    const ls = globalThis.localStorage, k = '__pc_probe';
    ls.setItem(k, '1'); ls.removeItem(k);
    return { name: 'localstorage', get: async (key) => ls.getItem(key), set: async (key, v) => ls.setItem(key, v), setSync: (key, v) => ls.setItem(key, v) };
  } catch (e) { return null; }
}
function idbBackend() {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve(null);
  return new Promise((res) => {
    let req;
    try { req = idb.open('palmcourt', 1); } catch (e) { res(null); return; }
    const t = setTimeout(() => res(null), 2500);   // some private modes never answer
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = req.onblocked = () => { clearTimeout(t); res(null); };
    req.onsuccess = () => {
      clearTimeout(t);
      const db = req.result, run = (mode, fn) => new Promise((ok, fail) => {
        try { const tx = db.transaction('kv', mode), r = fn(tx.objectStore('kv')); tx.oncomplete = () => ok(r.result); tx.onerror = tx.onabort = () => fail(tx.error); } catch (e) { fail(e); }
      });
      res({ name: 'indexeddb', get: (key) => run('readonly', (s) => s.get(key)).then((v) => (typeof v === 'string' ? v : null)), set: (key, v) => run('readwrite', (s) => s.put(v, key)) });
    };
  });
}
const memory = () => { const m = new Map(); return { name: 'memory', get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };

const listeners = new Map();
const emit = (evt, data) => { for (const fn of [...(listeners.get(evt) || [])]) { try { fn(data); } catch (e) { console.error(`[profile] ${evt} handler failed`, e); } } };

export const Profile = {
  data: freshData(),
  storage: 'memory',     // 'indexeddb' | 'localstorage' | 'memory' (memory: progress is lost on reload)
  loaded: false,
  recovered: null,       // 'backup' | 'reset' when the main save was unreadable at load
  ready: null,           // Promise, resolves once the saved profile is loaded
  backends: [], cloud: null, timer: 0, lastGood: null,

  get level() { return levelFor(this.data.xp); },
  get xp() { return this.data.xp; },
  get xpInLevel() { return this.data.xp - xpToReach(this.level); },
  xpForLevel(l = this.level) { return xpForLevel(l); },
  get maxLevel() { return MAX_LEVEL; },
  get fuzz() { return this.data.fuzz; },
  get equipped() { return this.data.equipped; },
  get stats() { return this.data.stats; },
  get history() { return this.data.history; },

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit,
  log(kind, n, why) { this.data.ledger.push({ t: Date.now(), kind, n, why: String(why || '') }); if (this.data.ledger.length > LEDGER) this.data.ledger.splice(0, this.data.ledger.length - LEDGER); },

  addXP(n, why = '') {
    n = Math.max(0, Math.round(+n || 0));
    if (!n) return 0;
    const from = this.level;
    this.data.xp += n; this.data.stats.xpEarned = (this.data.stats.xpEarned || 0) + n; this.log('xp', n, why);
    const to = this.level;
    if (to > from) {
      emit('levelup', { from, to });
      for (const item of CATALOG) if ((item.how === 'level' || item.how === 'level-or-buy') && item.level > from && item.level <= to && !this.owns(item.id)) emit('unlock', { id: item.id, item, why: 'level' });
    }
    this.changed();
    return n;
  },
  addFuzz(n, why = '') {
    n = Math.max(0, Math.round(+n || 0));
    if (!n) return 0;
    this.data.fuzz += n; this.data.stats.fuzzEarned = (this.data.stats.fuzzEarned || 0) + n; this.log('fuzz', n, why);
    this.changed();
    return n;
  },
  spend(n, why = '') {
    n = Math.round(+n || 0);
    if (!(n > 0) || this.data.fuzz < n) return false;
    this.data.fuzz -= n; this.log('fuzz', -n, why);
    this.changed();
    return true;
  },
  // Owned = granted or bought (free and level unlocks are economy.isUnlocked's business).
  owns(id) { const i = itemById(id); return !!this.data.owned[i ? i.id : id]; },
  grant(id) {
    const i = itemById(id), key = i ? i.id : id;
    if (this.data.owned[key]) return false;
    this.data.owned[key] = Date.now();
    emit('unlock', { id: key, item: i, why: 'grant' });
    this.changed();
    return true;
  },
  // equip(slot, id) with an id you own or that is free; null puts the default back.
  equip(slot, id) {
    if (!SLOTS.includes(slot)) return false;
    if (id != null) {
      const i = itemById(id);
      if (!i || i.kind !== slot) return false;
      const lvl = (i.how === 'level' || i.how === 'level-or-buy') && this.level >= i.level;
      if (i.how !== 'free' && !lvl && !this.owns(i.id) && !Profile.unlockAll()) return false;
      id = i.id;
    }
    this.data.equipped[slot] = id ?? null;
    this.changed();
    return true;
  },
  unlockAll() { try { return new URLSearchParams(globalThis.location?.search || '').get('unlockAll') === '1'; } catch (e) { return false; } },

  changed() { this.data.updated = Date.now(); emit('change', this); this.save(); },
  // Debounced: many changes at the end of a match become one write. save(true) writes now.
  save(now = false) {
    clearTimeout(this.timer); this.timer = 0;
    if (!now) { this.timer = setTimeout(() => this.save(true), SAVE_MS); return this.pending || Promise.resolve(); }
    const json = JSON.stringify(this.data), prev = this.lastGood;
    this.lastGood = json;
    // Mirror to localStorage synchronously first (a tab being closed won't wait for IndexedDB).
    for (const b of this.backends) if (b.setSync) { try { if (prev) b.setSync(BAK, prev); b.setSync(KEY, json); } catch (e) { /* quota */ } }
    this.pending = Promise.all(this.backends.filter((b) => !b.setSync).map(async (b) => { try { if (prev) await b.set(BAK, prev); await b.set(KEY, json); } catch (e) { console.warn('[profile] save failed', b.name, e); } }))
      .then(() => { if (this.cloud) this.cloudPush(); });
    return this.pending;
  },
  flush() { if (this.timer) this.save(true); },

  async load() {
    const [idb, ls] = [await idbBackend(), lsBackend()];
    this.backends = [idb, ls].filter(Boolean);
    if (!this.backends.length) this.backends = [memory()];
    this.storage = this.backends[0].name;
    // The newest readable save across backends; a corrupt main save falls back to the backup copy.
    let best = null, bad = null, fromBak = false;
    for (const b of this.backends) {
      let main = null, bak = null;
      try { main = await b.get(KEY); bak = await b.get(BAK); } catch (e) { /* unreadable backend */ }
      let d = parse(main);
      if (main && !d) { bad = bad || main; d = parse(bak); if (d) fromBak = true; }
      if (d && (!best || d.updated > best.updated || (d.updated === best.updated && d.xp > best.xp))) best = d;
    }
    if (bad) { for (const b of this.backends) { try { await b.set(BAD, bad); } catch (e) { /* keep going */ } } this.recovered = best ? 'backup' : 'reset'; }
    const fresh = !best;
    this.data = best || freshData();
    this.loaded = true;
    if (fresh || bad || fromBak) await this.save(true); else this.lastGood = JSON.stringify(this.data);
    emit('change', this);
    return this;
  },

  // ---- export / import / reset ----
  exportJSON() { return JSON.stringify({ format: 'palmcourt-profile', exported: new Date().toISOString(), profile: this.data }, null, 1); },
  // Replaces the profile with an exported one (or a bare profile object). Throws an Error with a readable message.
  importJSON(s) {
    let o;
    try { o = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { throw new Error('That file is not a Palm Court save (not JSON).'); }
    const d = normalize(o && o.format === 'palmcourt-profile' ? o.profile : o);
    if (!d) throw new Error('That file is not a Palm Court save.');
    const from = this.level;
    this.data = d; this.data.updated = Date.now();
    emit('change', this);
    if (this.level !== from) emit('levelup', { from, to: this.level, imported: true });
    return this.save(true).then(() => true);
  },
  // A clean slate; the old profile is kept as the backup copy (one more import away).
  reset() {
    this.lastGood = JSON.stringify(this.data);
    this.data = freshData();
    emit('change', this);
    return this.save(true);
  },

  // ---- optional cloud sync ----
  // adapter: { name, pull(id) -> Promise<profile object | null>, push(id, data) -> Promise }. The newer save wins.
  async useCloud(adapter) {
    this.cloud = adapter || null;
    if (!adapter) return false;
    await this.ready;
    try {
      const remote = normalize(await adapter.pull(this.data.id));
      if (remote && remote.updated > this.data.updated) { this.data = remote; emit('change', this); await this.save(true); }
      else await this.cloudPush(true);
      return true;
    } catch (e) { console.warn('[profile] cloud sync failed', e); return false; }
  },
  cloudPush(force) {
    const c = this.cloud, t = Date.now();
    if (!c || (!force && t - (this.pushedAt || 0) < 30000)) return Promise.resolve();   // at most every 30 s
    this.pushedAt = t;
    return Promise.resolve(c.push(this.data.id, this.data)).catch((e) => console.warn('[profile] cloud push failed', e));
  },
};

// Supabase (REST) adapter stub: a `profiles` table { id text primary key, data jsonb, updated_at timestamptz } with an
// anon row-level policy. Only used when src/config.js provides cloud: { url, anonKey }.
export function supabaseAdapter({ url, anonKey, table = 'profiles' }) {
  const base = `${String(url).replace(/\/+$/, '')}/rest/v1/${table}`, headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' };
  return {
    name: 'supabase',
    async pull(id) {
      const r = await fetch(`${base}?id=eq.${encodeURIComponent(id)}&select=data`, { headers });
      if (!r.ok) throw new Error(`supabase pull ${r.status}`);
      const rows = await r.json();
      return rows && rows[0] ? rows[0].data : null;
    },
    async push(id, data) {
      const r = await fetch(base, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id, data, updated_at: new Date(data.updated).toISOString() }) });
      if (!r.ok) throw new Error(`supabase push ${r.status}`);
    },
  };
}
// src/config.js is optional (read defensively): cloud sync only with a url and an anon key.
async function cloudFromConfig() {
  try {
    const { CONFIG } = await import('./config.js');
    const c = CONFIG && CONFIG.cloud;
    if (c && c.url && c.anonKey) await Profile.useCloud(supabaseAdapter(c));
  } catch (e) { /* no config.js: local only */ }
}

useProfile(Profile);
Profile.ready = Profile.load().catch((e) => { console.error('[profile] load failed', e); Profile.loaded = true; return Profile; });
if (globalThis.addEventListener && globalThis.document) {
  addEventListener('pagehide', () => Profile.flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) Profile.flush(); });
  Profile.ready.then(cloudFromConfig);
}
