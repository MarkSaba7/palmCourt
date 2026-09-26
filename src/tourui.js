// Palm Court: World Tour screens. The hub (ranking, this week's events, what's next, trophy cabinet, rankings), the
// tournament view (bracket, next opponent, results) and the hooks into a tour match (CPU strength and persona at
// match:start, a Continue button on the match-over screen). Markup and styles are created here, so the module is
// self-contained; the career logic is tour.js.
import { Settings, Clock } from './core.js';
import { Game } from './game.js';
import { UI, $ } from './ui.js';
import { Bus } from './events.js';
import { Profile } from './profile.js';
import { Replay } from './replay.js';
import { proById, proName, proPortrait } from './pros.js';
import { fmtFuzz, fmtXP } from './economy.js';
import { Tour, TIERS, CALENDAR, WEEKS, eventById, roundName, pairOf, myMatch, fullTour, steamUrl, reqOf, levelLabel, STYLES, fieldPlayer, FIELD, defending } from './tour.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (n) => Math.round(n || 0).toLocaleString('en-US');
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const TOD = { day: 'Day', golden: 'Golden hour', night: 'Night' };
const FMT = { short: 'Short sets', full: 'Full sets', tiebreak: 'Tiebreaks' };
const cup = (c) => `<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="${c}" d="M9 3h14v7.5a7 7 0 0 1-14 0zM4.5 5H9v2.2H6.6c.2 2.2 1.3 3.6 2.9 4.3l-.6 2C6 12.4 4.5 9.8 4.5 6.2zM27.5 5H23v2.2h2.4c-.2 2.2-1.3 3.6-2.9 4.3l.6 2c2.9-1.1 4.4-3.7 4.4-7.3zM14.2 17.6h3.6V22h-3.6zM10 23h12v2.6H10zM8.5 26.4h15V29h-15z"/><path fill="#fff" opacity=".28" d="M11.2 4.6h2.2v6.6c0 1.6.5 3 1.4 4-2.3-.5-3.6-2.3-3.6-4.8z"/></svg>`;

// Who you are for this run: your pro (if you play as one) or your own name.
function me() {
  const pro = proById(Settings.playAs);
  return { name: pro ? pro.name : Settings.name || 'You', short: proName(Settings.playAs, Settings.name || 'You'), country: pro ? pro.country : '', pro: pro ? pro.id : null };
}
const shirtsClash = (a, b) => { const p = [(a >> 16) & 255, (a >> 8) & 255, a & 255], q = [(b >> 16) & 255, (b >> 8) & 255, b & 255]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 80; };

const CSS = `
.tour-slab { width: min(920px, 100%); gap: 16px; }
.tour-head { display: flex; flex-wrap: wrap; gap: 14px 24px; align-items: flex-end; justify-content: space-between; }
.tour-rank { display: grid; justify-items: end; gap: 2px; }
.tour-rank .tr-label { font: 700 11px/1 var(--body); letter-spacing: .14em; text-transform: uppercase; color: var(--mist); }
.tour-rank b { font: 900 52px/.9 var(--display); color: var(--optic); }
.tour-rank .tr-sub { font-size: 13px; color: var(--mist); }
.tour-h { margin: 0 0 8px; font: 700 12px/1 var(--body); letter-spacing: .14em; text-transform: uppercase; color: var(--mist); }
.tour-note { margin: 0; font-size: 13px; color: var(--mist); }
.tour-note a { color: var(--optic); }
.tour-events { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; }
.tev { border: 1px solid var(--edge); border-top: 3px solid var(--tier, var(--edge)); background: rgba(242,245,238,.04); padding: 12px 14px 14px; display: grid; gap: 6px; align-content: start; }
.tev h4 { margin: 0; font: 900 26px/.95 var(--display); text-transform: uppercase; }
.tev .tev-meta { margin: 0; font-size: 13px; color: var(--mist); }
.tev .tev-prize { margin: 0; font-size: 13px; }
.tev .tev-prize b { color: var(--optic); }
.tev .btn { margin-top: 4px; }
.tev .tev-lock { margin: 4px 0 0; font-size: 13px; color: var(--coral); }
.tev.steam .tev-lock { color: var(--mist); }
.tev.steam { opacity: .72; }
.tier-badge { justify-self: start; font: 700 11px/1 var(--body); letter-spacing: .12em; text-transform: uppercase; padding: 4px 7px; color: var(--ink); background: var(--tier, var(--chalk)); }
.tour-run { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; border: 1px solid var(--optic); background: rgba(214,240,74,.08); padding: 12px 14px; }
.tour-run p { margin: 0; }
.tour-upcoming { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: 13px; }
.tour-upcoming li { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line); color: var(--mist); }
.tour-upcoming b { color: var(--chalk); font-weight: 600; }
.tour-upcoming .lk { color: var(--mist); opacity: .7; }
.tour-cols { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 18px; }
.tour-cabinet { display: flex; flex-wrap: wrap; gap: 8px; }
.tour-cabinet .tc { display: grid; justify-items: center; gap: 3px; width: 86px; padding: 8px 4px; border: 1px solid var(--edge); background: rgba(242,245,238,.04); text-align: center; font-size: 11px; line-height: 1.15; color: var(--mist); }
.tour-cabinet .tc svg { width: 34px; height: 34px; }
.tour-cabinet .tc b { color: var(--chalk); font-weight: 600; }
.tour-table { margin: 0; padding: 0; list-style: none; font-size: 13px; display: grid; }
.tour-table li { display: grid; grid-template-columns: 44px 1fr auto; gap: 8px; padding: 5px 6px; border-top: 1px solid var(--line); }
.tour-table li.you { background: rgba(214,240,74,.12); color: var(--optic); font-weight: 700; }
.tour-table li.gap { border: 0; padding: 0 6px; color: var(--mist); }
.tour-table .rk { font-variant-numeric: tabular-nums; color: var(--mist); }
.tour-table li.you .rk { color: inherit; }
.tour-table .pt { font-variant-numeric: tabular-nums; color: var(--mist); }
.te-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; border: 1px solid var(--edge); background: rgba(242,245,238,.04); padding: 14px; }
.te-opp { display: grid; grid-template-columns: 76px 1fr; gap: 14px; align-items: center; }
.te-opp svg { width: 76px; height: 76px; display: block; background: rgba(242,245,238,.05); }
.te-opp .eyebrow { margin-bottom: 6px; }
.te-opp h3 { margin: 0; font: 900 30px/.95 var(--display); text-transform: uppercase; }
.te-opp p { margin: 4px 0 0; font-size: 13px; color: var(--mist); }
.te-opp p b { color: var(--chalk); font-weight: 600; }
.te-go { display: grid; gap: 8px; min-width: 190px; }
.te-result { border: 1px solid var(--edge); border-top: 3px solid var(--tier, var(--optic)); padding: 14px; display: grid; gap: 8px; background: rgba(242,245,238,.04); }
.te-result h3 { margin: 0; font: 900 40px/.95 var(--display); text-transform: uppercase; color: var(--optic); }
.te-result.out h3 { color: var(--chalk); }
.te-result ul { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; }
.te-result li b { color: var(--optic); }
.te-result p { margin: 0; color: var(--mist); font-size: 13px; }
.bracket { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(150px, 1fr); gap: 10px; overflow-x: auto; padding-bottom: 4px; }
.br-col { display: grid; grid-template-rows: auto 1fr; gap: 6px; min-width: 0; }
.br-col > h4 { margin: 0; font: 700 11px/1 var(--body); letter-spacing: .12em; text-transform: uppercase; color: var(--mist); }
.br-ms { display: flex; flex-direction: column; justify-content: space-around; gap: 6px; }
.bm { border: 1px solid var(--edge); background: rgba(8,18,29,.6); font-size: 12px; }
.bm.mine { border-color: var(--optic); }
.bp { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; padding: 4px 6px; align-items: center; color: var(--mist); min-width: 0; }
.bp + .bp { border-top: 1px solid var(--line); }
.bp .sd { font-size: 10px; opacity: .8; }
.bp .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bp.win { color: var(--chalk); font-weight: 700; }
.bp.you { color: var(--optic); }
.bp.lost { text-decoration: line-through; text-decoration-color: rgba(242,245,238,.35); }
.bp .sc { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 11px; color: var(--chalk); }
.bp.tbd { font-style: italic; opacity: .6; }
#btnTour .tour-menu-rank { margin-left: auto; font-weight: 600; opacity: .7; }
#tourOverNote { margin: 0; font-weight: 600; color: var(--optic); }
#tourOverNote.out { color: var(--chalk); }
@media (max-width: 720px) {
  .tour-cols, .te-top { grid-template-columns: 1fr; }
  .tour-rank { justify-items: start; }
  .tour-rank b { font-size: 42px; }
  .te-go { min-width: 0; }
}`;

const HTML = `
<main id="tour" class="screen center" hidden aria-labelledby="tourTitle">
  <section class="slab tour-slab">
    <header class="tour-head">
      <div><p class="eyebrow" id="tourWeek"></p><h2 id="tourTitle">World Tour</h2></div>
      <div class="tour-rank"><span class="tr-label">World ranking</span><b id="tourRank"></b><span class="tr-sub" id="tourPts"></span></div>
    </header>
    <div id="tourRun" hidden></div>
    <section aria-labelledby="tourWeekH"><h3 class="tour-h" id="tourWeekH">This week</h3><div id="tourThisWeek" class="tour-events"></div></section>
    <p class="tour-note" id="tourEdition" hidden></p>
    <section aria-labelledby="tourNextH"><h3 class="tour-h" id="tourNextH">Coming up</h3><ol id="tourNext" class="tour-upcoming"></ol></section>
    <div class="tour-cols">
      <section aria-labelledby="tourCabH"><h3 class="tour-h" id="tourCabH">Trophy cabinet</h3><div id="tourCabinet" class="tour-cabinet"></div></section>
      <section aria-labelledby="tourTabH"><h3 class="tour-h" id="tourTabH">Rankings</h3><ol id="tourTable" class="tour-table"></ol></section>
    </div>
    <div class="actions row"><button id="btnTourBack" class="btn">Main menu</button><button id="btnTourSkip" class="btn ghost">Skip this week</button></div>
  </section>
</main>
<main id="tourEvent" class="screen center" hidden aria-labelledby="teName">
  <section class="slab tour-slab">
    <header class="tour-head">
      <div><p class="eyebrow" id="teMeta"></p><h2 id="teName"></h2></div>
      <div class="tour-rank"><span class="tr-label" id="teRoundL">Round</span><b id="teRound"></b><span class="tr-sub" id="teSub"></span></div>
    </header>
    <div id="teMain"></div>
    <section aria-labelledby="teDrawH"><h3 class="tour-h" id="teDrawH">Draw</h3><div id="teBracket" class="bracket"></div></section>
    <div class="actions row"><button id="btnTeBack" class="btn">World Tour</button></div>
  </section>
</main>`;

export const TourUI = {
  pendingEvent: false, lastMatch: null,
  init() {
    if ($('tour')) return;
    const css = document.createElement('style');
    css.id = 'tourCss'; css.textContent = CSS;
    document.head.append(css);
    const box = document.createElement('div');
    box.innerHTML = HTML;
    const at = $('over') || $('hud');
    for (const el of [...box.children]) at ? at.before(el) : document.body.append(el);
    // Menu button, after Practice.
    const b = document.createElement('button');
    b.id = 'btnTour'; b.className = 'btn'; b.innerHTML = 'World Tour <span class="tour-menu-rank"></span>';
    b.onclick = () => this.open();
    const practice = $('btnPractice');
    if (practice) practice.after(b);
    // Match-over: Continue (back to the draw) replaces Play again for tour matches.
    const next = document.createElement('button');
    next.id = 'btnTourNext'; next.className = 'btn primary'; next.hidden = true; next.textContent = 'Continue';
    next.onclick = () => this.leaveMatch();
    const note = document.createElement('p');
    note.id = 'tourOverNote'; note.hidden = true; note.setAttribute('role', 'status');
    if ($('btnRematch')) { $('btnRematch').before(next); $('btnRematch').closest('.actions').before(note); }
    $('btnTourBack').onclick = () => UI.go('menu');
    $('btnTourSkip').onclick = () => { if (Tour.skipWeek()) this.renderHub(); };
    $('btnTeBack').onclick = () => this.open();
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (UI.screen === 'tourEvent') this.open(); else if (UI.screen === 'tour') UI.go('menu');
    });
    Bus.on('screen', ({ screen }) => this.onScreen(screen));
    Bus.on('match:start', ({ cfg }) => this.onMatchStart(cfg));
    Bus.on('tour:match', (m) => { this.lastMatch = m; if (m.retired) this.pendingEvent = true; });
    Profile.on('change', () => this.menuRank());
    Profile.ready.then(() => this.menuRank());
  },
  menuRank() { const el = document.querySelector('#btnTour .tour-menu-rank'); if (el && Profile.loaded) el.textContent = `#${Tour.rank}`; },

  // ---- hub ----
  open() { this.renderHub(); UI.go('tour'); const b = document.querySelector('#tour .tev .btn.primary, #tourRun .btn'); if (b) b.focus({ preventScroll: true }); },
  renderHub() {
    const t = Tour.t, rank = Tour.rank, run = Tour.run, def = defending(t);
    $('tourWeek').textContent = `Season ${t.season} · Week ${t.week + 1} of ${WEEKS}`;
    $('tourRank').textContent = `#${rank}`;
    $('tourPts').textContent = `${nf(Tour.points)} pts · best #${Math.min(t.best, rank)}${def ? ` · defending ${nf(def)}` : ''}`;
    // A run in progress
    const box = $('tourRun');
    box.hidden = !run;
    if (run) {
      const ev = eventById(run.ev), nx = Tour.next();
      box.className = 'tour-run';
      box.innerHTML = `<p><b>${esc(ev.name)}</b> · ${nx ? `${esc(nx.name)} vs ${esc(nx.opp.name)}` : ''}</p><button class="btn primary small" id="btnTourCont">Continue</button>`;
      $('btnTourCont').onclick = () => this.openEvent();
    }
    // This week's events
    $('tourThisWeek').innerHTML = Tour.week().map((ev) => this.eventCard(ev, !!run)).join('');
    for (const btn of document.querySelectorAll('#tourThisWeek [data-enter]')) btn.onclick = () => this.enter(btn.dataset.enter);
    const web = !fullTour(), url = steamUrl();
    $('tourEdition').hidden = !web;
    if (web) $('tourEdition').innerHTML = `Web edition: every Challenger event, all season long. The 500s, Masters, Majors and the Finals are in the <b>full World Tour on Steam</b>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">Wishlist on Steam</a>` : ''}.`;
    $('btnTourSkip').hidden = !!run;
    // Coming up
    $('tourNext').innerHTML = Tour.upcoming(4).map((w) => `<li><span>Week ${w.week}${w.season !== t.season ? `<br>S${w.season}` : ''}</span><span>${w.events.map((ev) => {
      const T = TIERS[ev.tier], lk = !T.web && web;
      return `<span class="${lk ? 'lk' : ''}"><b>${esc(ev.name)}</b> · ${T.name}, ${SURF(ev)}${lk ? ' · Steam' : ''}</span>`;
    }).join('<br>')}</span></li>`).join('');
    // Trophy cabinet: one cup per event won, with a count
    const by = new Map();
    for (const tr of t.trophies) { const k = tr.ev; by.set(k, { ...tr, n: (by.get(k)?.n || 0) + 1 }); }
    $('tourCabinet').innerHTML = by.size ? [...by.values()].map((tr) => `<div class="tc" title="${esc(tr.name)}">${cup(TIERS[tr.tier]?.color || '#d6f04a')}<b>${esc(tr.name)}</b><span>${TIERS[tr.tier]?.name || ''}${tr.n > 1 ? ` ×${tr.n}` : ''}</span></div>`).join('') : '<p class="tour-note">Win a title to put your first trophy here.</p>';
    // Rankings: the top 3 and the players around you
    const rows = [], seen = new Set(), row = (r) => {
      if (r < 1 || r > 500 || seen.has(r)) return;
      seen.add(r);
      if (r === rank) rows.push({ r, you: true, name: me().name, pts: Tour.points });
      else { const k = r < rank ? r : r - 1; if (k < 1 || k > FIELD.length - 1) return; const f = fieldPlayer(k); rows.push({ r, name: f.name, pts: FIELD[k] }); }
    };
    [1, 2, 3].forEach(row);
    for (let r = rank - 2; r <= rank + 2; r++) row(r);
    rows.sort((a, b) => a.r - b.r);
    $('tourTable').innerHTML = rows.map((x, i) => `${i && x.r - rows[i - 1].r > 1 ? '<li class="gap">⋯</li>' : ''}<li class="${x.you ? 'you' : ''}"><span class="rk">#${x.r}</span><span>${esc(x.name)}${x.you ? ' (you)' : ''}</span><span class="pt">${nf(x.pts)}</span></li>`).join('');
  },
  eventCard(ev, busy) {
    const T = TIERS[ev.tier], el = Tour.eligibility(ev), req = reqOf(ev), R = Math.round(Math.log2(T.draw)), best = Tour.t.played[ev.id];
    const reqTxt = req.rank == null && req.level == null ? 'Open entry' : `Entry: rank #${req.rank}${req.level != null ? ` or Level ${req.level}` : ''}`;
    let act;
    if (el.steam) act = `<p class="tev-lock">Full World Tour on Steam</p>`;
    else if (!el.ok) act = `<p class="tev-lock">${esc(el.why)}</p>`;
    else act = `<button class="btn ${busy ? '' : 'primary'}" data-enter="${ev.id}" ${busy ? 'disabled' : ''}>Enter · ${T.draw}-player draw</button>`;
    return `<article class="tev${el.steam ? ' steam' : ''}" style="--tier:${T.color}">
      <span class="tier-badge">${T.name}</span>
      <h4>${esc(ev.name)}</h4>
      <p class="tev-meta">${esc(ev.city)} · ${SURF(ev)} · ${FMT[T.format]} · ${R} rounds</p>
      <p class="tev-prize">Champion: <b>${nf(T.pts[R])} pts</b> · ${fmtFuzz(T.fuzz[R])} · ${fmtXP(T.xp[R])}</p>
      <p class="tev-meta">${reqTxt}${best && best.titles ? ` · Titles here: ${best.titles}` : ''}</p>
      ${act}
    </article>`;
  },
  enter(id) {
    const run = Tour.enter(id, me());
    if (run) this.openEvent();
    else this.renderHub();
  },

  // ---- tournament view ----
  openEvent() { this.renderEvent(); UI.go('tourEvent'); const b = $('btnTePlay') || $('btnTeDone'); if (b) b.focus({ preventScroll: true }); },
  renderEvent() {
    const t = Tour.t, run = t.run, view = run || t.last;
    if (!view) { this.open(); return; }
    const ev = eventById(view.ev), T = TIERS[ev.tier], R = run ? run.R : view.R;
    $('teMeta').textContent = `${T.name} · ${SURF(ev)} · ${FMT[T.format]} · Season ${view.season}`;
    $('teName').textContent = ev.name;
    const main = $('teMain');
    if (run) {
      const nx = Tour.next(), o = nx.opp;
      $('teRoundL').textContent = 'Next'; $('teRound').textContent = nx.name; $('teSub').textContent = `You: #${run.rank}${run.draw[run.me].seed ? ` · seed ${run.draw[run.me].seed}` : ''}`;
      const style = o.pro ? proById(o.pro)?.blurb : STYLES[o.style]?.label;
      main.innerHTML = `<div class="te-top">
        <div class="te-opp">${proPortrait(o.look || {})}<div><p class="eyebrow">${esc(nx.name)} opponent</p><h3>${esc(o.name)}</h3>
          <p><b>#${o.rank}</b>${o.seed ? ` · seed ${o.seed}` : ''}${o.country ? ` · ${esc(o.country)}` : ''} · ${o.handed === 'L' ? 'Left-handed' : 'Right-handed'}</p>
          <p>${esc(style || '')} · Level: <b>${levelLabel(o.skill)}</b></p></div></div>
        <div class="te-go"><button class="btn primary" id="btnTePlay">Play the ${esc(nx.name.toLowerCase())}</button><button class="btn ghost small" id="btnTeWithdraw">Withdraw</button></div>
      </div>`;
      $('btnTePlay').onclick = () => this.play();
      $('btnTeWithdraw').onclick = () => { if (confirm('Withdraw from this tournament? It counts as a loss in this round.')) { Tour.withdraw(); this.renderEvent(); } };
    } else {
      const v = view, champ = v.title;
      $('teRoundL').textContent = 'Result'; $('teRound').textContent = v.label; $('teSub').textContent = `#${v.rankFrom} → #${v.rankTo}`;
      main.innerHTML = `<div class="te-result${champ ? '' : ' out'}" style="--tier:${T.color}">
        <p class="eyebrow">${v.retired ? 'Retired' : champ ? 'Title won' : `Out in the ${esc(roundName(v.R, v.reached).toLowerCase())}`}</p>
        <h3>${champ ? `Champion!` : esc(v.label)}</h3>
        <ul><li><b>+${nf(v.pts)}</b> ranking points</li><li><b>+${fmtFuzz(v.fuzz)}</b></li><li><b>+${fmtXP(v.xp)}</b></li>${champ ? '<li>Trophy added to your cabinet</li>' : ''}</ul>
        <p>World ranking #${v.rankFrom} → <b>#${v.rankTo}</b>${!champ && v.champion ? ` · ${esc(v.champion.name)} won the title` : ''}</p>
        <div class="actions row"><button class="btn primary" id="btnTeDone">Back to World Tour</button></div>
      </div>`;
      $('btnTeDone').onclick = () => this.open();
    }
    this.renderBracket(view, R, T);
  },
  renderBracket(v, R) {
    const cols = [];
    for (let r = 0; r < R; r++) {
      const ms = [], count = v.n / 2 ** (r + 1), mine = v.me != null ? Math.floor(v.me / 2 ** (r + 1)) : -1;
      for (let m = 0; m < count; m++) {
        const [a, b] = pairOf(v, r, m), w = v.wins[r] ? v.wins[r][m] : null, sc = v.scores[r] ? v.scores[r][m] : '';
        const p = (s) => {
          if (s == null) return '<div class="bp tbd"><span class="sd"></span><span class="nm">TBD</span><span class="sc"></span></div>';
          const e = v.draw[s], won = w != null && w === s, lost = w != null && w !== s;
          return `<div class="bp${won ? ' win' : ''}${lost ? ' lost' : ''}${e.you ? ' you' : ''}"><span class="sd">${e.seed || ''}</span><span class="nm" title="${esc(e.name)} #${e.rank}">${esc(e.you ? `${e.short || e.name} (you)` : e.short)}</span><span class="sc">${won ? esc(sc) : ''}</span></div>`;
        };
        ms.push(`<div class="bm${m === mine && (r === 0 || (v.wins[r - 1] && v.wins[r - 1][Math.floor(v.me / 2 ** r)] === v.me)) ? ' mine' : ''}">${p(a)}${p(b)}</div>`);
      }
      cols.push(`<div class="br-col"><h4>${roundName(R, r)}</h4><div class="br-ms">${ms.join('')}</div></div>`);
    }
    const w = v.wins[R - 1] && v.wins[R - 1][0];
    if (w != null) cols.push(`<div class="br-col"><h4>Champion</h4><div class="br-ms"><div class="bm"><div class="bp win${v.draw[w].you ? ' you' : ''}"><span class="sd">${cup(v.draw[w].you ? '#d6f04a' : '#93a7bb')}</span><span class="nm">${esc(v.draw[w].name)}</span><span class="sc"></span></div></div></div></div>`);
    $('teBracket').innerHTML = cols.join('');
    for (const s of document.querySelectorAll('#teBracket .sd svg')) s.setAttribute('style', 'width:14px;height:14px');
  },
  play() {
    const opts = Tour.matchOpts(me());
    if (!opts) { this.renderEvent(); return; }
    UI.startCpu(opts);
  },

  // ---- the match ----
  // The CPU plays at the entrant's strength (interpolated LEVELS) with their persona; a generated player also gets their look.
  onMatchStart(cfg) {
    if (!cfg || !cfg.tour || cfg.mode !== 'cpu' || cfg.localIdx < 0) return;
    const c = Tour.cpuFor(cfg.tour), pl = Game.players[1 - cfg.localIdx], mine = Game.players[cfg.localIdx];
    if (!pl || pl.ctl !== 'cpu') return;
    pl.level = c.level;
    if (c.persona) pl.persona = c.persona;
    const e = c.entrant;
    if (e && !e.pro && e.look && pl.avatar) {
      try {
        const L = e.look, av = pl.avatar;
        if (!shirtsClash(L.shirt, mine.avatar.kit.shirt)) av.kit = { ...av.kit, shirt: L.shirt, accent: L.accent, band: L.band, design: L.design, pants: L.pants };
        av.setLook({ skin: L.skin, hair: L.hair, hairColor: L.hairColor, headwear: L.headwear, headband: L.headband, beard: L.beard, height: L.height });
        Replay.bones = Game.players.map((p) => Object.values(p.avatar.B));   // replays drive the rebuilt skeleton
      } catch (err) { console.warn('[tour] opponent look', err); }
    }
  },
  onScreen(screen) {
    const tourOver = screen === 'over' && Game.mode === 'cpu' && Game.cfg && Game.cfg.tour && this.lastMatch && this.lastMatch.tour === Game.cfg.tour;
    const next = $('btnTourNext'), rem = $('btnRematch'), note = $('tourOverNote');
    if (next) { next.hidden = !tourOver; rem.hidden = !!tourOver; note.hidden = !tourOver; }
    if (tourOver) {
      const m = this.lastMatch, r = m.ended, tc = m.tour;
      note.className = r && !r.title ? 'out' : '';
      note.textContent = r ? (r.title ? `Champion of the ${tc.name}! +${nf(r.pts)} ranking points · ${fmtFuzz(r.fuzz)}` : `Out in the ${tc.roundName.toLowerCase()} · +${nf(r.pts)} ranking points · ${fmtFuzz(r.fuzz)}`)
        : `Through to the ${roundName(tc.rounds, tc.round + 1).toLowerCase()} of the ${tc.name}`;
      next.textContent = r ? 'See the results' : 'Continue';
      setTimeout(() => { if (!next.hidden) next.focus({ preventScroll: true }); }, 0);
    }
    // A retirement goes back to the menu: show the draw instead.
    if (screen === 'menu' && this.pendingEvent) { this.pendingEvent = false; setTimeout(() => this.openEvent(), 0); }
  },
  // From the match-over screen back to the draw (the court goes back to the menu exhibition).
  leaveMatch() {
    this.lastMatch = null; UI.lastCpuOpts = null;
    Clock.resume();
    UI.clearHud();
    Game.startAttract();
    this.openEvent();
  },
};
const SURF = (ev) => `${cap(ev.surface)}, ${TOD[ev.tod] || cap(ev.tod)}`;
