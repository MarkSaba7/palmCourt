// Palm Court: the Leaderboards screen (src/cloud.js). Only exists when the cloud is on (CONFIG.cloud.enabled or
// ?cloud=1): otherwise init() adds nothing, not even the menu button. Markup and CSS are built here (classes lb-*), so
// nothing in index.html changes; the screen is a .screen like the others, so UI.go handles it. Also starts the cloud's
// automatic sync (after matches, on Profile 'reward' / 'change').
import { Settings } from './core.js';
import { Game } from './game.js';
import { Bus } from './events.js';
import { UI, $ } from './ui.js';
import { Cloud, BOARDS, checkName } from './cloud.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n) => Math.round(n || 0).toLocaleString('en-US');
const PERIODS = [['season', 'This season'], ['all', 'All time']];
const CACHE_MS = 30000, LIMIT = 50;
const seasonName = () => new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 50 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

const CSS = `
.lb-slab{width:min(760px,100%);gap:14px}
.lb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 20px;flex-wrap:wrap}
.lb-period{display:flex;gap:6px}
.lb-chip{appearance:none;border:1px solid var(--edge);background:transparent;padding:7px 11px;font:700 12px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--mist);cursor:pointer}
.lb-chip:hover{color:var(--chalk)}
.lb-chip[aria-pressed=true]{background:var(--chalk);color:var(--ink);border-color:var(--chalk)}
.lb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--edge);overflow-x:auto;scrollbar-width:none}
.lb-tab{appearance:none;background:none;border:0;border-bottom:3px solid transparent;margin-bottom:-1px;padding:9px 14px 8px;font:800 18px/1 var(--display);letter-spacing:.05em;text-transform:uppercase;color:var(--mist);cursor:pointer;white-space:nowrap}
.lb-tab:hover{color:var(--chalk)}
.lb-tab[aria-selected=true]{color:var(--chalk);border-bottom-color:var(--optic)}
.lb-tab:focus-visible,.lb-chip:focus-visible{outline:2px solid var(--optic);outline-offset:-2px}
.lb-body{height:min(46vh,440px);min-height:200px;overflow-y:auto;overscroll-behavior:contain;padding-right:4px}
.lb-sub{margin:0 0 8px;font-size:13px;color:var(--mist)}
.lb-list{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.lb-row{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 12px;background:rgba(242,245,238,.035);border:1px solid transparent;font-variant-numeric:tabular-nums}
.lb-row .lb-pl{font:900 20px/1 var(--display);color:var(--mist)}
.lb-row .lb-nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-row .lb-v{font:800 20px/1 var(--display);letter-spacing:.02em}
.lb-row .lb-v small{font:700 11px/1 var(--body);color:var(--mist);margin-left:5px;letter-spacing:.06em;text-transform:uppercase}
.lb-row.top .lb-pl{color:var(--optic)}
.lb-row.me{background:linear-gradient(100deg,rgba(214,240,74,.2),rgba(214,240,74,.05) 70%);border-color:rgba(214,240,74,.55)}
.lb-row.me .lb-pl,.lb-row.me .lb-nm{color:var(--optic)}
.lb-row.me .lb-nm::after{content:'You';margin-left:8px;font:700 9.5px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;padding:2px 4px;background:var(--optic);color:var(--optic-ink);vertical-align:2px}
.lb-gap{text-align:center;color:var(--mist);letter-spacing:.3em;line-height:1}
.lb-empty{display:grid;place-items:center;height:100%;min-height:180px;text-align:center;color:var(--mist);gap:10px;align-content:center}
.lb-name{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--line)}
.lb-name label{font-size:13px;color:var(--mist)}
.lb-name input{background:rgba(242,245,238,.06);border:1px solid var(--edge);padding:7px 9px;color:var(--chalk);width:15ch;min-width:0}
.lb-name .status{flex:1 1 14ch;font-size:13px}
.lb-foot{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap}
.lb-foot .fine{flex:1;min-width:12ch}
@media (max-width:520px){.lb-row{grid-template-columns:40px minmax(0,1fr) auto;gap:8px}.lb-tab{font-size:16px;padding:8px 10px}}
`;

const HTML = `<main id="leaders" class="screen center" hidden aria-labelledby="lbTitle">
  <section class="slab wide lb-slab">
    <header class="lb-head"><div><p class="eyebrow">Online</p><h2 id="lbTitle">Leaderboards</h2></div>
      <div class="lb-period" role="group" aria-label="Period">${PERIODS.map(([id, name]) => `<button class="lb-chip" type="button" data-period="${id}">${name}</button>`).join('')}</div></header>
    <div class="lb-tabs" role="tablist" aria-label="Boards">${BOARDS.map((b) => `<button class="lb-tab" role="tab" type="button" id="lbTab-${b.id}" data-board="${b.id}" aria-controls="lbBody">${esc(b.name)}</button>`).join('')}</div>
    <div class="lb-body" id="lbBody" role="tabpanel" tabindex="-1" aria-live="polite"></div>
    <form class="lb-name" id="lbNameForm" autocomplete="off"><label for="lbName">Your leaderboard name</label><input type="text" id="lbName" maxlength="16" spellcheck="false" placeholder="3-16 characters"><button class="btn small" type="submit" id="lbNameSave">Save name</button><p class="status" id="lbNameMsg" role="status"></p></form>
    <footer class="lb-foot"><button class="btn ghost" id="lbBack" type="button" data-back>Back <kbd>Esc</kbd></button><p class="fine" id="lbSync"></p><button class="btn ghost small" id="lbSyncNow" type="button">Sync now</button></footer>
  </section></main>`;

export const CloudUI = {
  board: 'rating', period: 'season', cache: new Map(), from: null, seq: 0,

  init() {
    if (!Cloud.enabled || $('leaders')) return false;   // cloud off: no screen, no menu entry
    const css = document.createElement('style');
    css.id = 'lbCss'; css.textContent = CSS;
    document.head.append(css);
    const box = document.createElement('div');
    box.innerHTML = HTML;
    const at = $('over') || $('hud');
    for (const el of [...box.children]) at ? at.before(el) : document.body.append(el);
    // Menu button, before Camera check.
    const b = document.createElement('button');
    b.id = 'btnLeaders'; b.className = 'btn'; b.type = 'button'; b.textContent = 'Leaderboards';
    b.onclick = () => this.open();
    const setup = $('btnSetup'), actions = $('menu') && $('menu').querySelector('.actions');
    if (setup && setup.parentElement) setup.before(b); else if (actions) actions.append(b);
    for (const t of document.querySelectorAll('.lb-tab')) t.onclick = () => this.show(t.dataset.board, null, true);
    for (const c of document.querySelectorAll('.lb-chip')) c.onclick = () => this.show(null, c.dataset.period);
    $('lbBack').onclick = () => this.close();
    $('lbSyncNow').onclick = () => this.syncNow();
    $('lbNameForm').onsubmit = (e) => { e.preventDefault(); this.saveName(); };
    $('lbName').addEventListener('input', () => { $('lbNameMsg').textContent = ''; $('lbNameMsg').className = 'status'; });
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    // The cloud never syncs mid-point: a match being played (or paused) waits for the menu or the result screen.
    Cloud.busy = () => (Game.mode === 'cpu' || Game.mode === 'online') && (UI.screen === null || UI.screen === 'pause');
    Cloud.on('status', () => this.footer());
    Cloud.on('sync', () => { this.cache.clear(); if (UI.screen === 'leaders') this.render(); });
    Cloud.on('name', (n) => { if (document.activeElement !== $('lbName')) $('lbName').value = n || ''; });
    Bus.on('screen', ({ screen }) => {
      setTimeout(() => { if (globalThis.PalmCourt && !globalThis.PalmCourt.Cloud) globalThis.PalmCourt.Cloud = Cloud; });   // for the console
      if (screen === 'leaders') this.footer();
    });
    Cloud.start();
    return true;
  },

  open() {
    this.from = document.activeElement;
    UI.go('leaders');
    $('lbName').value = Cloud.displayName || '';
    $('lbName').placeholder = Cloud.displayName ? '3-16 characters' : (checkName(Settings.name).ok && Settings.name !== 'Player' ? Settings.name : '3-16 characters');
    $('lbNameMsg').textContent = Cloud.displayName ? '' : 'Pick a name to show on the boards.';
    $('lbNameMsg').className = 'status';
    this.show(this.board, this.period, true);
    if (Cloud.displayName == null) Cloud.fetchName();
  },
  close() {
    const back = this.from && this.from.isConnected ? this.from : $('btnLeaders');
    UI.go('menu');
    if (back) back.focus({ preventScroll: true });
  },
  show(board, period, focusTab) {
    if (board) this.board = board;
    if (period) this.period = period;
    for (const t of document.querySelectorAll('.lb-tab')) t.setAttribute('aria-selected', String(t.dataset.board === this.board));
    for (const c of document.querySelectorAll('.lb-chip')) c.setAttribute('aria-pressed', String(c.dataset.period === this.period));
    if (focusTab) $(`lbTab-${this.board}`).focus({ preventScroll: true });
    this.render();
  },
  async render(force = false) {
    const board = this.board, period = this.period, key = `${board}|${period}`, seq = ++this.seq, B = BOARDS.find((b) => b.id === board);
    const hit = this.cache.get(key), body = $('lbBody');
    let data = hit && !force && Date.now() - hit.at < CACHE_MS ? hit.data : null;
    if (!data) {
      if (!hit) body.innerHTML = '<div class="lb-empty"><p>Loading…</p></div>';
      data = await Cloud.leaderboard(board, { period, limit: LIMIT });
      if (seq !== this.seq || UI.screen !== 'leaders') return;   // the player moved on
      if (data) this.cache.set(key, { at: Date.now(), data });
      else if (hit) data = hit.data;
    }
    if (!data) {
      body.innerHTML = '<div class="lb-empty"><p>Can’t reach the leaderboards right now. Your progress is saved on this device.</p><button class="btn small" type="button" id="lbRetry">Try again</button></div>';
      $('lbRetry').onclick = () => this.render(true);
      return;
    }
    const sub = `${esc(B.hint)} · ${period === 'season' ? `Season ${esc(seasonName())} (UTC)` : 'All time'}`;
    if (!data.rows.length) { body.innerHTML = `<p class="lb-sub">${sub}</p><div class="lb-empty"><p>No scores yet. Play a match to be the first on this board.</p></div>`; return; }
    const unit = B.unit ? `<small>${esc(B.unit)}</small>` : '';
    const row = (r) => `<li class="lb-row${r.me ? ' me' : ''}${r.place <= 3 ? ' top' : ''}"${r.me ? ' aria-current="true"' : ''}><span class="lb-pl">${r.place}</span><span class="lb-nm">${esc(r.name)}</span><span class="lb-v">${nf(r.value)}${unit}</span></li>`;
    const top = data.rows.filter((r) => r.place <= LIMIT), me = data.me && data.me.place > LIMIT ? data.me : null;
    body.innerHTML = `<p class="lb-sub">${sub}</p><ol class="lb-list">${top.map(row).join('')}${me ? `<li class="lb-gap" aria-hidden="true">···</li>${row(me)}` : ''}</ol>`
      + (data.me ? '' : '<p class="lb-sub" style="margin-top:10px">You aren’t on this board yet: it updates after your next match.</p>');
    const mine = body.querySelector('.lb-row.me');
    if (mine && mine.offsetTop > body.clientHeight) mine.scrollIntoView({ block: 'center' });
  },
  async saveName() {
    const input = $('lbName'), msg = $('lbNameMsg'), btn = $('lbNameSave');
    const v = input.value.trim() || input.placeholder;
    btn.disabled = true; msg.className = 'status'; msg.textContent = 'Saving…';
    const r = await Cloud.setDisplayName(v);
    btn.disabled = false;
    msg.className = `status ${r.ok ? 'ok' : 'err'}`;
    msg.textContent = r.ok ? 'Saved.' : r.error;
    if (r.ok) { input.value = r.name; this.cache.clear(); if (UI.screen === 'leaders') this.render(); }
  },
  async syncNow() {
    const b = $('lbSyncNow');
    b.disabled = true;
    await Cloud.sync();
    b.disabled = false;
    this.cache.clear();
    if (UI.screen === 'leaders') this.render(true);
  },
  footer() {
    const el = $('lbSync');
    if (!el) return;
    const s = Cloud.status;
    el.textContent = s === 'syncing' ? 'Syncing…' : s === 'offline' ? 'Offline: progress is saved on this device.' : s === 'error' ? 'Cloud save unavailable right now. Progress is saved on this device.' : Cloud.lastSync ? `Cloud save synced ${ago(Cloud.lastSync)}.` : 'Your progress is saved on this device and backed up online.';
  },
  onKey(e) {
    if (UI.screen !== 'leaders' || (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key !== 'Escape')) return;
    if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (/^[qe[\]]$/i.test(e.key)) {
      const i = BOARDS.findIndex((b) => b.id === this.board), d = /^[q[]$/i.test(e.key) ? -1 : 1;
      e.preventDefault();
      this.show(BOARDS[(i + d + BOARDS.length) % BOARDS.length].id, null, true);
    }
  },
};
