// Palm Court: the progression screens. Match-over rewards (itemised lines, the XP bar filling and rolling over on a
// level-up, a Fuzz count-up, unlocks, challenge and achievement toasts, the optional "watch an ad to double your
// Fuzz"), the main-menu profile card, and one screen with the Pro Shop, Locker, Daily Challenges and Achievements.
// Also dresses the local player in the equipped cosmetics at the start of each match. Markup and CSS live here
// (classes pg-*), so nothing in index.html changes; the screen is a .screen like the others, so UI.go handles it.
import { Settings } from './core.js';
import { Sound } from './match.js';
import { KITS, OUTFITS } from './render/actors.js';
import { makeRacket } from './render/racket.js';
import { Game } from './game.js';
import { Replay } from './replay.js';
import { Bus } from './events.js';
import { UI, $ } from './ui.js';
import { proById, proPortrait } from './pros.js';
import { Profile } from './profile.js';
import { Progress } from './progress.js';
import { CATALOG, SLOTS, itemById, isUnlocked, canBuy, buy, unlockHint, lookFor, ACHIEVEMENTS, achievementProgress, xpToReach, xpForLevel, levelFor, MAX_LEVEL, REWARD, utcDay } from './economy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => `#${((n ?? 0) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
const nf = (n) => Math.round(n || 0).toLocaleString('en-US');
const SLOT_NAMES = { outfit: 'Outfit', racket: 'Racket paint', headwear: 'Headwear', band: 'Wristbands', celebration: 'Celebration', title: 'Title' };
const SHOP_CATS = [['outfit', 'Outfits'], ['racket', 'Rackets'], ['headwear', 'Headwear'], ['band', 'Wristbands'], ['celebration', 'Celebrations'], ['pro', 'Pros']];
const TABS = [['shop', 'Pro Shop'], ['locker', 'Locker'], ['challenges', 'Challenges'], ['achievements', 'Achievements']];
const DEFAULTS = Object.fromEntries(SLOTS.map((s) => [s, (CATALOG.find((i) => i.kind === s && i.how === 'free') || {}).id]));
const equippedId = (slot) => Profile.equipped[slot] || DEFAULTS[slot];
const titleFor = (id) => (ACHIEVEMENTS.find((a) => a.title === id) || {}).name;

// ---- little pictures ----
const FUZZ = (cls = 'pg-fz') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10.3" fill="none" stroke="#c4de3c" stroke-width="2" stroke-dasharray=".55 1.05"/><circle cx="12" cy="12" r="9.4" fill="url(#pgFzG)"/><path fill="none" stroke="#fbffe9" stroke-opacity=".9" stroke-width="1.45" stroke-linecap="round" d="M4.6 7C8.7 9.6 8.7 14.4 4.6 17M19.4 7C15.3 9.6 15.3 14.4 19.4 17"/></svg>`;
const MEDAL = (on) => `<svg class="pg-medal" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><path d="M11 2h5l3 9h-5zM25 2h-5l-3 9h5z" fill="${on ? '#ff7a62' : '#93a7bb'}"/><circle cx="18" cy="22" r="11.5" fill="${on ? '#d6f04a' : '#93a7bb'}"/><circle cx="18" cy="22" r="8.3" fill="none" stroke="#1b2300" stroke-opacity=".35" stroke-width="1.2"/><path d="m18 15.6 1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#1b2300" fill-opacity=".72"/></svg>`;
const LOCK = '<svg class="pg-lock" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="7" width="10" height="8" rx="1.2" fill="currentColor"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
// A racket at an angle: frame, accent stripe and dampener, strings.
function racketSvg({ frame = 0x1b2026, accent = 0xd6f04a, strings = 0xf4f2e6 } = {}) {
  const f = hex(frame), a = hex(accent), s = hex(strings), cx = 32, cy = 21, rx = 11.5, ry = 15, o = [];
  for (let x = cx - rx + 2.5; x < cx + rx - 1; x += 2.6) { const h = ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2)); o.push(`M${x.toFixed(1)} ${(cy - h).toFixed(1)}V${(cy + h).toFixed(1)}`); }
  for (let y = cy - ry + 2.5; y < cy + ry - 1; y += 2.6) { const w = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2)); o.push(`M${(cx - w).toFixed(1)} ${y.toFixed(1)}H${(cx + w).toFixed(1)}`); }
  return `<svg class="pg-rk" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g transform="rotate(-32 32 34)"><path d="${o.join('')}" stroke="${s}" stroke-opacity=".75" stroke-width=".55" fill="none"/>`
    + `<path d="M26 34.6 30.2 45M38 34.6 33.8 45" stroke="${f}" stroke-width="2.6" fill="none"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${f}" stroke-width="3.3"/>`
    + `<path d="M${cx - rx * 0.97} ${cy - 3}A${rx} ${ry} 0 0 1 ${cx - 3} ${cy - ry * 0.99}" fill="none" stroke="${a}" stroke-width="1.6"/><rect x="30.3" y="44" width="3.4" height="17" rx="1.2" fill="${f}"/>`
    + `<rect x="29.8" y="50" width="4.4" height="11.5" rx="1.4" fill="#26282b"/><rect x="29.6" y="60" width="4.8" height="2.2" rx=".8" fill="${a}"/><rect x="30.6" y="33.2" width="2.8" height="2.2" fill="${a}"/></g></svg>`;
}
// A forearm and fist with (or without) a wristband.
function bandSvg(skin, band) {
  const k = hex(skin);
  return `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M14 60 28 30h13l-6 30z" fill="${k}"/><path d="M26 32c-1-9 3-16 11-16s12 5 11 12-4 9-8 9H30z" fill="${k}"/><path d="M31 21h12M31 25.5h13M31 30h11" stroke="#000" stroke-opacity=".16" stroke-width="1.1"/>`
    + (band != null ? `<path d="M24.3 36.5h17.6l-2.3 9.2H20.1z" fill="${hex(band)}"/><path d="M24.3 36.5h17.6l-.5 2H23.4z" fill="#fff" fill-opacity=".25"/><path d="M22.2 41.1h18.6" stroke="#000" stroke-opacity=".12" stroke-width=".8"/>` : '') + '</svg>';
}
// A pictogram of each celebration.
const ARMS = {
  fist: 'M32 24 25 33 23 41M32 24l8-5 2-9', arms: 'M32 24 22 16 17 8M32 24l10-8 5-8', heart: 'M32 24l-7 6 5 1M32 24l7 6-5 1',
  vamos: 'M32 24l-9 5-1-8M32 24l9 5 1-8', calm: 'M32 24l-4 13M32 24l4 13',
};
function celebSvg(kind, look) {
  const legs = kind === 'vamos' ? 'M32 38 24 45 23 55M32 38l8 7 1 10' : 'M32 38l-5 17M32 38l5 17';
  const fists = { fist: [[42, 10]], arms: [[17, 8], [47, 8]], vamos: [[22, 21], [42, 21]] }[kind] || [];
  return `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="${ARMS[kind] || ARMS.calm}" fill="none" stroke="${hex(look.skin)}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="${legs}" fill="none" stroke="${hex(look.pants)}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 22h10l-1 17h-8z" fill="${hex(look.shirt)}"/>`
    + `<circle cx="32" cy="14.5" r="5.2" fill="${hex(look.skin)}"/>${fists.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${hex(look.skin)}"/>`).join('')}`
    + (kind === 'heart' ? '<path d="M32 33.5c-3-2.4-4.6-3.8-4.6-5.4a2.3 2.3 0 0 1 4.6-.6 2.3 2.3 0 0 1 4.6.6c0 1.6-1.6 3-4.6 5.4z" fill="#ff7a62"/>' : '')
    + (kind === 'arms' || kind === 'vamos' ? '<path d="M14 26l-4-2M50 26l4-2M16 32h-5M48 32h5" stroke="#d6f04a" stroke-width="1.6" stroke-linecap="round"/>' : '') + '</svg>';
}
// The custom player's look with everything equipped (over: slot -> item id, to try something on).
export function myLook(over = {}) {
  const lk = lookFor({ ...Profile.equipped, ...over });
  return { ...KITS[0], ...lk.kit, ...lk.look, racket: lk.racket || KITS[0].racket };
}
function preview(item) {
  const k = item.kind, p = item.preview || {};
  if (k === 'pro') { const pro = proById(p.pro); return proPortrait(pro ? { ...pro.kit, ...pro.look } : myLook()); }
  if (k === 'outfit' || k === 'headwear') return proPortrait(myLook({ [k]: item.id }));
  if (k === 'racket') return racketSvg(p.racket || KITS[0].racket);
  if (k === 'band') return bandSvg(KITS[0].skin, p.look && p.look.wristband ? p.kit.band : null);
  if (k === 'celebration') return celebSvg(p.style && p.style.celebrate, myLook());
  if (k === 'title') return `<span class="pg-tb">${esc(item.name)}</span>`;
  return '';
}

// ---- a short chime (Web Audio, through the game's master volume) ----
function chime(notes = [988, 1319], gain = 0.07, step = 0.085) {
  try {
    if (!Sound.ok() || !Sound.master) return;
    const c = Sound.ctx, t0 = c.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), t = t0 + i * step;
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g); g.connect(Sound.master); o.start(t); o.stop(t + 0.45);
    });
  } catch (e) { /* audio is a nicety */ }
}
// src/platform.js (the ads/portal layer) is optional: loaded once, null if it isn't there.
let platformP = null;
const platform = () => (platformP ||= (globalThis.PalmCourt && globalThis.PalmCourt.Platform ? Promise.resolve(globalThis.PalmCourt.Platform) : import('./platform.js').then((m) => m.Platform || null)).catch(() => null));

const STYLE = `
.pg-fz{width:1.05em;height:1.05em;flex:none;display:inline-block;vertical-align:-.16em}
.pg-lv{--s:46px;position:relative;flex:none;width:var(--s);height:calc(var(--s)*1.1);display:grid;place-items:center;padding-top:calc(var(--s)*.14);background:var(--optic);color:var(--optic-ink);clip-path:polygon(50% 0,100% 23%,100% 77%,50% 100%,0 77%,0 23%);font:900 calc(var(--s)*.5)/1 var(--display);font-variant-numeric:tabular-nums}
.pg-lv::before{content:'LV';position:absolute;top:19%;font:800 calc(var(--s)*.16)/1 var(--body);letter-spacing:.12em;opacity:.65}
.pg-lv.pop{animation:pgPop .55s var(--ease-back)}
.pg-xp{position:relative;flex:1 1 auto;height:6px;background:rgba(242,245,238,.1);overflow:hidden}
.pg-xp>i{position:absolute;inset:0 auto 0 0;width:var(--p,0%);background:var(--optic);transition:width .7s var(--ease-out)}
.pg-fuzz{display:inline-flex;align-items:center;gap:6px;font:800 20px/1 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-card{display:grid;gap:6px}
.pg-card-main{appearance:none;display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:12px;row-gap:7px;align-items:center;width:100%;padding:9px 12px;text-align:left;cursor:pointer;border:1px solid var(--edge);background:linear-gradient(100deg,rgba(214,240,74,.13),rgba(242,245,238,.03) 62%);transition:border-color .15s,background .15s}
.pg-card-main:hover{border-color:rgba(214,240,74,.55)}
.pg-card-main:focus-visible,.pg-nav .btn:focus-visible{outline:2px solid var(--optic);outline-offset:2px}
.pg-card-main .pg-lv{grid-row:span 2}
.pg-who{display:grid;min-width:0}
.pg-who b{font:900 22px/.95 var(--display);text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg-who small,.pg-eyebrow{font:700 11px/1.25 var(--body);letter-spacing:.13em;text-transform:uppercase;color:var(--optic)}
.pg-xpline{grid-column:2/-1;display:flex;align-items:center;gap:10px}
.pg-xpline small{font:700 11px/1 var(--body);color:var(--mist);letter-spacing:.05em;white-space:nowrap;font-variant-numeric:tabular-nums}
.pg-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.pg-nav .btn{padding:8px 4px;font-size:12.5px;display:flex;justify-content:center;align-items:center;gap:5px;text-align:center;white-space:nowrap}
.pg-pip{font:700 10px/1 var(--body);padding:3px 4px;background:rgba(242,245,238,.13);color:var(--chalk)}
.pg-pip.hot{background:var(--optic);color:var(--optic-ink)}
@media (max-width:420px){.pg-nav{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pg-slab{width:min(980px,100%);gap:14px}
.pg-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 20px;flex-wrap:wrap}
.pg-wallet{display:flex;align-items:center;gap:12px}
.pg-wallet .pg-lv{--s:38px}
.pg-wxp{display:grid;gap:6px;width:170px}
.pg-wxp small{font:700 11px/1 var(--body);color:var(--mist);letter-spacing:.05em;font-variant-numeric:tabular-nums}
.pg-wallet .pg-fuzz{font-size:24px;padding-left:12px;border-left:1px solid var(--edge)}
.pg-tabs{display:flex;gap:2px;border-bottom:1px solid var(--edge);overflow-x:auto;scrollbar-width:none}
.pg-tab{appearance:none;background:none;border:0;border-bottom:3px solid transparent;margin-bottom:-1px;padding:9px 14px 8px;font:800 18px/1 var(--display);letter-spacing:.05em;text-transform:uppercase;color:var(--mist);cursor:pointer;white-space:nowrap;display:flex;gap:7px;align-items:center}
.pg-tab:hover{color:var(--chalk)}
.pg-tab[aria-selected=true]{color:var(--chalk);border-bottom-color:var(--optic)}
.pg-tab:focus-visible,.pg-chip:focus-visible,.pg-slot:focus-visible{outline:2px solid var(--optic);outline-offset:-2px}
.pg-body{height:min(56vh,540px);min-height:220px;overflow-y:auto;overscroll-behavior:contain;padding:2px 4px 2px 0}
.pg-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.pg-foot .btn{display:flex;align-items:center;gap:10px}
.pg-foot .status{flex:1;min-width:12ch}
.pg-cats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.pg-chip{appearance:none;border:1px solid var(--edge);background:transparent;padding:7px 11px;font:700 12px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--mist);cursor:pointer}
.pg-chip:hover{color:var(--chalk)}
.pg-chip[aria-pressed=true]{background:var(--chalk);color:var(--ink);border-color:var(--chalk)}
.pg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:8px}
.pg-item{position:relative;display:grid;grid-template-rows:auto auto auto 1fr;gap:5px;padding:8px;border:1px solid var(--edge);background:rgba(242,245,238,.035);min-width:0}
.pg-item.equipped{border-color:var(--optic);box-shadow:inset 0 0 0 1px var(--optic)}
.pg-item.locked .pg-prev>:not(.pg-lock){filter:grayscale(.8) brightness(.62)}
.pg-prev{position:relative;aspect-ratio:1.3;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 50% 38%,rgba(242,245,238,.12),rgba(0,0,0,.28) 75%)}
.pg-prev>svg{width:100%;height:100%}
.pg-prev>svg.pg-lock{position:absolute;top:6px;right:6px;width:16px;height:16px;color:var(--chalk);opacity:.85}
.pg-tag{position:absolute;top:6px;left:6px;font:700 9.5px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;padding:3px 5px;background:var(--optic);color:var(--optic-ink)}
.pg-tb{font:900 20px/1 var(--display);text-transform:uppercase;letter-spacing:.04em;padding:7px 10px;border:1px solid var(--optic);color:var(--optic);text-align:center;max-width:90%}
.pg-iname{font:800 16px/1.05 var(--display);text-transform:uppercase;letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-imeta{font-size:11.5px;line-height:1.3;color:var(--mist);min-height:1.3em;display:flex;align-items:center;gap:4px}
.pg-item .btn{align-self:end;display:flex;justify-content:center;align-items:center;gap:6px;text-align:center;padding:7px 8px}
.pg-item .btn.confirm{background:var(--coral);border-color:var(--coral);color:var(--ink)}
.pg-locker{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;align-items:start}
.pg-man{display:grid;gap:8px}
.pg-big{position:relative;aspect-ratio:1.3;background:radial-gradient(circle at 50% 36%,rgba(242,245,238,.14),rgba(0,0,0,.3) 72%);border:1px solid var(--edge);overflow:hidden}
.pg-big>svg{position:absolute;inset:0;width:100%;height:100%}
.pg-big>svg.pg-rk{inset:auto -6% -4% auto;width:52%;height:52%}
.pg-big .pg-tb{position:absolute;left:8px;bottom:8px;font-size:14px;padding:4px 7px;background:rgba(8,18,29,.8)}
.pg-slots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
.pg-slot{appearance:none;display:grid;grid-template-columns:minmax(0,1fr);padding:6px 8px;border:1px solid var(--edge);background:transparent;text-align:left;cursor:pointer;color:inherit}
.pg-slot small{font:700 10px/1.2 var(--body);letter-spacing:.13em;text-transform:uppercase;color:var(--mist)}
.pg-slot b{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-slot:hover{background:rgba(242,245,238,.06)}
.pg-slot[aria-pressed=true]{border-color:var(--optic);background:rgba(214,240,74,.09)}
.pg-note{margin:0 0 10px;font-size:12.5px;color:var(--mist)}
@media (max-width:640px){.pg-locker{grid-template-columns:1fr}.pg-man{grid-template-columns:130px 1fr}.pg-big{aspect-ratio:1}}
.pg-chs{display:grid;gap:10px}
.pg-ch{display:grid;grid-template-columns:44px minmax(0,1fr) auto;column-gap:14px;row-gap:9px;align-items:center;padding:14px 16px;border:1px solid var(--edge);background:rgba(242,245,238,.035)}
.pg-ch-n{grid-row:span 2;font:900 38px/1 var(--display);color:rgba(242,245,238,.3);text-align:center}
.pg-ch b{font:800 21px/1.05 var(--display);text-transform:uppercase;letter-spacing:.03em}
.pg-ch.done{border-color:rgba(127,224,168,.55);background:linear-gradient(100deg,rgba(127,224,168,.1),transparent 60%)}
.pg-ch.done .pg-ch-n{color:var(--good)}
.pg-ch-row{grid-column:2/-1;display:flex;align-items:center;gap:12px}
.pg-ch-row small{font:700 12px/1 var(--body);color:var(--mist);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:5.5em;text-align:right}
.pg-bar{position:relative;flex:1;height:8px;background:rgba(242,245,238,.1);overflow:hidden}
.pg-bar>i{position:absolute;inset:0 auto 0 0;width:var(--p,0%);background:var(--optic);transition:width .8s var(--ease-out)}
.done .pg-bar>i{background:var(--good)}
.pg-rwd{display:inline-flex;align-items:center;gap:10px;font:800 16px/1 var(--display);white-space:nowrap}
.pg-rwd .x{color:var(--chalk)}.pg-rwd .f{color:var(--optic);display:inline-flex;align-items:center;gap:4px}
.pg-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-top:14px}
.pg-info p{margin:0;padding:10px 12px;border:1px solid var(--line);background:rgba(242,245,238,.03);font-size:13px;color:var(--mist)}
.pg-info b{display:block;color:var(--chalk);font:800 17px/1.1 var(--display);text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px}
.pg-achsum{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.pg-achsum .pg-bar{max-width:320px}
.pg-achsum b{font:900 26px/1 var(--display)}
.pg-achs{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px}
.pg-ach{display:grid;grid-template-columns:34px minmax(0,1fr) auto;column-gap:10px;row-gap:3px;align-items:center;padding:8px 10px;border:1px solid var(--edge);background:rgba(242,245,238,.03)}
.pg-ach .pg-medal{grid-row:span 3;width:34px;height:34px}
.pg-ach:not(.got) .pg-medal{opacity:.4}
.pg-ach.got{background:linear-gradient(100deg,rgba(214,240,74,.12),transparent 70%);border-color:rgba(214,240,74,.35)}
.pg-ach>b{font:800 16px/1 var(--display);text-transform:uppercase;letter-spacing:.03em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-ach>span{font:700 11.5px/1 var(--body);color:var(--optic);white-space:nowrap;display:inline-flex;align-items:center;gap:3px}
.pg-ach>p{grid-column:2/-1;margin:0;font-size:12px;line-height:1.3;color:var(--mist)}
.pg-ach>.pg-ch-row{gap:8px}.pg-ach .pg-bar{height:4px}
.pg-ach>.pg-ch-row small{min-width:0;font-size:11px}
.pg-rw{position:relative;overflow:hidden;display:grid;gap:9px;padding:12px 14px;border:1px solid var(--edge);background:linear-gradient(160deg,rgba(214,240,74,.09),rgba(242,245,238,.02) 55%)}
.pg-rw-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center}
.pg-rw-xp{display:grid;gap:7px;min-width:0}
.pg-rw-xpl{display:flex;justify-content:space-between;gap:8px;overflow:hidden;font:700 11px/1 var(--body);letter-spacing:.1em;text-transform:uppercase;color:var(--mist);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-rw-xpl b{color:var(--chalk)}
.pg-rw .pg-xp{height:10px}
.pg-rw .pg-xp>i{transition:none}
.pg-rw .pg-xp>i.now{box-shadow:0 0 12px rgba(214,240,74,.7)}
.pg-rw .pg-xp>i.base{background:#8fa33a}
.pg-rw .pg-xp.flash{animation:pgFlash .5s ease-out}
.pg-rw-fz{display:grid;justify-items:end;gap:4px}
.pg-rw-fz .pg-fuzz{font-size:28px;color:var(--optic)}
.pg-rw-fz small{font:600 11.5px/1 var(--body);color:var(--mist);font-variant-numeric:tabular-nums;white-space:nowrap}
.pg-rw-lines{list-style:none;margin:0;padding:0;display:grid;gap:2px;max-height:176px;overflow-y:auto;scrollbar-width:thin}
.pg-rw-lines li{display:grid;grid-template-columns:minmax(0,1fr) 62px 58px;gap:8px;align-items:center;padding:4px 7px;font-size:13px;background:rgba(242,245,238,.04);animation:pgIn .38s var(--ease-out) both}
.pg-rw-lines li>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-rw-lines li>b{text-align:right;font:800 15px/1 var(--display);font-variant-numeric:tabular-nums}
.pg-rw-lines li>b.f{color:var(--optic)}
.pg-rw-lines li>b:empty::after{content:'–';color:var(--mist);opacity:.5}
.pg-rw-lines em{font:700 9.5px/1 var(--body);font-style:normal;letter-spacing:.12em;text-transform:uppercase;color:var(--ink);background:var(--optic);padding:2px 4px;margin-right:7px;vertical-align:1px}
.pg-rw-lines li.ach em{background:var(--good)}.pg-rw-lines li.ad em{background:var(--chalk)}
.pg-rw-unl{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pg-rw-unl:empty{display:none}
.pg-rw-unl>small{font:700 10.5px/1 var(--body);letter-spacing:.13em;text-transform:uppercase;color:var(--mist)}
.pg-unl{font:700 11px/1 var(--body);letter-spacing:.07em;text-transform:uppercase;padding:5px 7px;border:1px solid var(--optic);color:var(--optic);animation:pgPop .5s var(--ease-back) both}
.pg-ad{display:flex;align-items:center;justify-content:center;gap:8px;border-color:rgba(214,240,74,.6);animation:pgIn .4s var(--ease-out) both}
.pg-ad b{color:var(--optic)}
.pg-lvup{position:absolute;inset:0;z-index:2;display:grid;place-content:center;justify-items:center;gap:6px;text-align:center;padding:12px;background:radial-gradient(circle at 50% 45%,rgba(214,240,74,.28),rgba(8,18,29,.94) 68%);pointer-events:none;animation:pgLvUp 2.4s ease-out both}
.pg-lvup::before{content:'';position:absolute;inset:-40%;z-index:-1;background:repeating-conic-gradient(rgba(214,240,74,.16) 0 7deg,transparent 7deg 20deg);-webkit-mask:radial-gradient(circle,#000 12%,transparent 55%);mask:radial-gradient(circle,#000 12%,transparent 55%);animation:pgSpin 9s linear infinite}
.pg-lvup small{font:700 12px/1 var(--body);letter-spacing:.32em;text-transform:uppercase;color:var(--optic)}
.pg-lvup b{font:900 86px/.85 var(--display);color:var(--chalk);text-shadow:0 0 28px rgba(214,240,74,.65);animation:pgPop .7s var(--ease-back) both}
.pg-lvup span{font-size:12.5px;color:var(--chalk);max-width:34ch}
.pg-toasts{position:fixed;z-index:40;bottom:max(var(--hp,16px),env(safe-area-inset-bottom));right:var(--hp,16px);display:grid;align-content:end;gap:8px;width:min(330px,calc(100vw - 32px));pointer-events:none}
.pg-toast{display:grid;grid-template-columns:34px minmax(0,1fr);column-gap:11px;align-items:center;padding:10px 12px;background:var(--panel);border:1px solid var(--edge);border-left:3px solid var(--optic);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.35);animation:pgToast .5s var(--ease-back) both}
.pg-toast.good{border-left-color:var(--good)}
.pg-toast.out{animation:pgToastOut .35s ease-in both}
.pg-toast>svg{grid-row:span 3;width:34px;height:34px}
.pg-toast small{font:700 10.5px/1.2 var(--body);letter-spacing:.14em;text-transform:uppercase;color:var(--optic)}
.pg-toast.good small{color:var(--good)}
.pg-toast b{font:800 18px/1.05 var(--display);text-transform:uppercase;letter-spacing:.02em}
.pg-toast span{font-size:12px;color:var(--mist)}
@media (max-height:860px) and (min-width:700px){.over-slab>.pg-rw{grid-column:1;grid-row:3}}
@keyframes pgPop{from{transform:scale(.35);opacity:0}to{transform:none;opacity:1}}
@keyframes pgIn{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
@keyframes pgFlash{0%{box-shadow:0 0 0 0 rgba(214,240,74,.9)}100%{box-shadow:0 0 0 8px rgba(214,240,74,0)}}
@keyframes pgLvUp{0%{opacity:0}8%{opacity:1}82%{opacity:1}100%{opacity:0}}
@keyframes pgSpin{to{transform:rotate(1turn)}}
@keyframes pgToast{from{opacity:0;transform:translateX(34px)}}
@keyframes pgToastOut{to{opacity:0;transform:translateX(34px)}}
@media (prefers-reduced-motion:reduce){.pg-rw *,.pg-rw,.pg-toast,.pg-lvup,.pg-lvup::before,.pg-lv.pop{animation-duration:.01s!important;transition:none!important}}
`;

export const ProgressUI = {
  tab: 'shop', cat: 'outfit', slot: 'outfit', from: null, timers: [], pending: null, matchAt: 0, anim: null,

  init() {
    const css = document.createElement('style');
    css.id = 'pgCss'; css.textContent = STYLE;
    document.head.append(css);
    // The Fuzz icon's gradient, once for the page.
    document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><radialGradient id="pgFzG" cx=".38" cy=".34" r=".75"><stop offset="0" stop-color="#eefc8a"/><stop offset=".6" stop-color="#d6f04a"/><stop offset="1" stop-color="#a9c22a"/></radialGradient></defs></svg><div class="pg-toasts" id="pgToasts" aria-live="polite"></div>');
    this.buildCard(); this.buildHub(); this.buildRewards();
    UI.customLook = () => myLook();   // the pro picker's "Your player" portrait wears your kit
    Profile.on('change', () => this.changed());
    Profile.on('reward', (res) => { this.pending = { res, xp0: Profile.xp - res.totalXP, fz0: Profile.fuzz - res.totalFuzz, at: Date.now() }; });
    Bus.on('match:start', (e) => { this.matchAt = Date.now(); this.dress(e.cfg); });
    Bus.on('screen', ({ screen }) => this.onScreen(screen));
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    Profile.ready.then(() => { this.renderCard(); if (UI.renderPros && $('proPicker')) UI.renderPros(); });
    this.renderCard();
  },

  // ---- main-menu profile card ----
  buildCard() {
    const head = $('menu') && $('menu').querySelector('.slab > header');
    if (!head) return;
    head.insertAdjacentHTML('afterend', `<section class="pg-card" id="pgCard" aria-label="Your profile">
      <button class="pg-card-main" id="pgCardBtn" type="button"><span class="pg-lv" id="pgCardLv">1</span><span class="pg-who"><b id="pgCardName"></b><small id="pgCardTitle"></small></span><span class="pg-fuzz" title="Fuzz: earned by playing">${FUZZ()}<b id="pgCardFuzz">0</b></span><span class="pg-xpline"><span class="pg-xp"><i id="pgCardBar"></i></span><small id="pgCardXp"></small></span></button>
      <nav class="pg-nav" aria-label="Progress">${TABS.map(([id, name]) => `<button class="btn small" type="button" data-hub="${id}">${name === 'Achievements' ? 'Awards' : name}<span class="pg-pip" id="pgPip-${id}" hidden></span></button>`).join('')}</nav>
    </section>`);
    $('pgCardBtn').onclick = () => this.open('locker');
    for (const b of $('pgCard').querySelectorAll('[data-hub]')) b.onclick = () => this.open(b.dataset.hub);
    const name = $('optName');
    if (name) name.addEventListener('input', () => this.renderCard());
  },
  renderCard() {
    if (!$('pgCard')) return;
    const P = Profile, lv = P.level, need = P.xpForLevel(lv), inL = P.xpInLevel;
    $('pgCardLv').textContent = lv;
    $('pgCardName').textContent = Settings.name || 'Player';
    $('pgCardTitle').textContent = (itemById(equippedId('title')) || {}).name || 'Rookie';
    $('pgCardFuzz').textContent = nf(P.fuzz);
    $('pgCardBar').style.setProperty('--p', `${need ? Math.min(100, (100 * inL) / need) : 100}%`);
    $('pgCardXp').textContent = need ? `${nf(inL)} / ${nf(need)} XP` : 'Max level';
    $('pgCardBtn').setAttribute('aria-label', `Level ${lv}, ${nf(P.fuzz)} Fuzz. Open your locker`);
    if (!P.loaded) return;
    const daily = Progress.daily(), done = daily.filter((c) => c.done).length, got = ACHIEVEMENTS.filter((a) => Progress.earned(a.id)).length;
    const pip = (id, text, hot) => { const el = $(`pgPip-${id}`); el.hidden = !text; el.textContent = text; el.classList.toggle('hot', !!hot); };
    pip('challenges', `${done}/${daily.length}`, done < daily.length);
    pip('achievements', `${got}`, false);
    const buyable = CATALOG.filter((i) => canBuy(i.id).ok).length;
    pip('shop', buyable ? `${buyable}` : '', true);
  },

  // ---- the hub screen: Pro Shop, Locker, Challenges, Achievements ----
  buildHub() {
    document.body.insertAdjacentHTML('beforeend', `<main id="hub" class="screen center" hidden>
      <section class="slab wide pg-slab" aria-labelledby="pgHubTitle">
        <header class="pg-head"><div><p class="eyebrow">Your career</p><h2 id="pgHubTitle">Pro Shop</h2></div>
          <div class="pg-wallet"><span class="pg-lv" id="pgHubLv">1</span><span class="pg-wxp"><span class="pg-xp"><i id="pgHubBar"></i></span><small id="pgHubXp"></small></span><span class="pg-fuzz" title="Fuzz: earned by playing, never sold">${FUZZ()}<b id="pgHubFuzz">0</b></span></div></header>
        <div class="pg-tabs" role="tablist" aria-label="Sections">${TABS.map(([id, name]) => `<button class="pg-tab" role="tab" type="button" id="pgTab-${id}" data-tab="${id}" aria-controls="pgBody">${name}</button>`).join('')}</div>
        <div class="pg-body" id="pgBody" role="tabpanel" tabindex="-1"></div>
        <footer class="pg-foot"><button class="btn ghost" id="pgBack" type="button">Back <kbd>Esc</kbd></button><p class="status" id="pgMsg" role="status"></p><p class="fine">Fuzz is earned by playing. <kbd>Q</kbd> <kbd>E</kbd> switch tabs</p></footer>
      </section></main>`);
    $('pgBack').onclick = () => this.close();
    for (const b of document.querySelectorAll('.pg-tab')) b.onclick = () => this.show(b.dataset.tab, true);
    $('pgBody').addEventListener('click', (e) => this.act(e));
  },
  open(tab) {
    this.from = document.activeElement;
    UI.go('hub');
    this.show(tab || this.tab, true);
  },
  close() {
    const back = this.from && this.from.isConnected ? this.from : null;
    UI.go('menu');
    if (back) back.focus({ preventScroll: true });
  },
  show(tab, focusTab) {
    this.tab = tab;
    for (const b of document.querySelectorAll('.pg-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    $('pgHubTitle').textContent = (TABS.find((t) => t[0] === tab) || TABS[0])[1];
    $('pgMsg').textContent = '';
    this.render();
    $('pgBody').scrollTop = 0;
    if (focusTab) $(`pgTab-${tab}`).focus({ preventScroll: true });
  },
  changed() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.renderCard(); if (UI.screen === 'hub') this.render(); });
  },
  // Re-render the open tab, keeping keyboard focus on the same control.
  render() {
    const body = $('pgBody'), f = document.activeElement, key = f && body.contains(f) ? f.dataset.key : null, top = body.scrollTop, P = Profile;
    const lv = P.level, need = P.xpForLevel(lv);
    $('pgHubLv').textContent = lv; $('pgHubFuzz').textContent = nf(P.fuzz);
    $('pgHubBar').style.setProperty('--p', `${need ? Math.min(100, (100 * P.xpInLevel) / need) : 100}%`);
    $('pgHubXp').textContent = need ? `${nf(P.xpInLevel)} / ${nf(need)} XP to level ${lv + 1}` : 'Max level';
    body.innerHTML = this[this.tab]();
    body.scrollTop = top;
    if (key) { const el = body.querySelector(`[data-key="${CSS_ESC(key)}"]`); if (el && !el.disabled) el.focus({ preventScroll: true }); else body.focus({ preventScroll: true }); }
  },
  card(item, mode) {
    const P = Profile, cosmetic = SLOTS.includes(item.kind), open = isUnlocked(item.id), on = cosmetic && equippedId(item.kind) === item.id;
    const c = open ? null : canBuy(item.id), dim = !open && !(mode === 'shop' && c && (c.ok || c.reason === 'fuzz'));   // for sale now: full colour
    let meta = '', btn = '';
    const k = (a) => `data-key="${a}:${item.id}" data-id="${item.id}"`;
    if (open) {
      meta = item.how === 'free' ? 'Free' : P.owns(item.id) ? 'Owned' : item.how === 'earn' ? 'Earned' : `Unlocked at level ${item.level}`;
      if (cosmetic) btn = on ? `<button class="btn small" disabled ${k('eq')}>Equipped</button>` : `<button class="btn small" data-act="equip" ${k('eq')}>Equip</button>`;
      else if (item.kind === 'pro') btn = Settings.playAs === item.key ? `<button class="btn small" disabled ${k('eq')}>Playing as</button>` : `<button class="btn small" data-act="playas" ${k('eq')}>Play as</button>`;
    } else {
      meta = item.how === 'earn' ? `Achievement: ${esc(titleFor(item.id) || '')}` : esc(unlockHint(item.id));
      if (mode === 'shop' && c.ok) btn = `<button class="btn small primary" data-act="buy" ${k('buy')}>Buy · ${FUZZ()} ${nf(item.price)}</button>`;
      else if (mode === 'shop' && c.reason === 'fuzz') btn = `<button class="btn small" disabled ${k('buy')}>Need ${nf(item.price - P.fuzz)} more</button>`;
      else if (mode === 'shop' && c.reason === 'level') btn = `<button class="btn small" disabled ${k('buy')}>Reach level ${item.level}</button>`;
      else if (mode === 'locker' && (item.how === 'buy' || item.how === 'level-or-buy')) btn = `<button class="btn small" data-act="toshop" ${k('shop')}>In the Pro Shop</button>`;
    }
    return `<article class="pg-item${dim ? ' locked' : ''}${on ? ' equipped' : ''}"><div class="pg-prev">${preview(item)}${dim ? LOCK : ''}${on ? '<span class="pg-tag">On</span>' : ''}</div><b class="pg-iname" title="${esc(item.name)}">${esc(item.name)}</b><small class="pg-imeta">${meta}</small>${btn}</article>`;
  },
  shop() {
    const items = CATALOG.filter((i) => i.kind === this.cat && (i.how === 'buy' || i.how === 'level-or-buy'));
    items.sort((a, b) => a.level - b.level || a.price - b.price);
    const cats = SHOP_CATS.map(([id, n]) => `<button class="pg-chip" type="button" data-act="cat" data-cat="${id}" data-key="cat:${id}" aria-pressed="${id === this.cat}">${n}</button>`).join('');
    const note = this.cat === 'pro' ? '<p class="pg-note">Pros unlock by level, or buy one early with Fuzz.</p>' : '<p class="pg-note">Cosmetics for your own player. New stock unlocks as you level up.</p>';
    return `<div class="pg-cats" role="group" aria-label="Categories">${cats}</div>${note}<div class="pg-grid">${items.map((i) => this.card(i, 'shop')).join('')}</div>`;
  },
  locker() {
    const L = myLook(), slots = SLOTS.map((s) => `<button class="pg-slot" type="button" data-act="slot" data-slot="${s}" data-key="slot:${s}" aria-pressed="${s === this.slot}"><small>${SLOT_NAMES[s]}</small><b>${esc((itemById(equippedId(s)) || {}).name || '')}</b></button>`).join('');
    const items = CATALOG.filter((i) => i.kind === this.slot).map((i) => [i, isUnlocked(i.id)]);
    items.sort((a, b) => b[1] - a[1] || a[0].level - b[0].level || a[0].price - b[0].price);
    const band = this.slot === 'band' && (itemById(equippedId('headwear')) || {}).preview?.kit ? '<p class="pg-note">Your headwear sets the colour of your wristbands too.</p>' : '';
    const cel = this.slot === 'celebration' ? '<p class="pg-note">Your player celebrates like this after winning a big point.</p>' : '';
    const pro = proById(Settings.playAs) ? `<p class="pg-note">You're playing as ${esc(proById(Settings.playAs).short)}: pros wear their own kit, but your racket paint and celebration go with you.</p>` : '';
    return `<div class="pg-locker"><div class="pg-man"><div class="pg-big">${proPortrait(L)}${racketSvg(L.racket)}<span class="pg-tb">${esc((itemById(equippedId('title')) || {}).name || '')}</span></div><div class="pg-slots" role="group" aria-label="Slots">${slots}</div></div>`
      + `<div>${pro}${band}${cel}<div class="pg-grid">${items.map(([i]) => this.card(i, 'locker')).join('')}</div></div></div>`;
  },
  challenges() {
    if (!Profile.loaded) return '<p class="pg-note">Loading…</p>';
    const list = Progress.daily(), reroll = Progress.canReroll(), d = Profile.data.daily, won = d.lastWin === utcDay();
    const now = new Date(), left = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime(), h = Math.floor(left / 3.6e6), m = Math.floor((left % 3.6e6) / 6e4);
    const rows = list.map((c, i) => {
      const p = Math.min(c.goal, c.progress), pct = (100 * p) / c.goal, unit = c.unit ? ` ${c.unit}` : '';
      const btn = c.done ? '' : `<button class="btn small ghost" type="button" data-act="reroll" data-slot="${i}" data-key="reroll:${i}" ${reroll ? '' : 'disabled'} title="${reroll ? 'Swap this challenge for another (once a day)' : 'You have used today\'s reroll'}">Reroll</button>`;
      return `<article class="pg-ch${c.done ? ' done' : ''}"><span class="pg-ch-n">${c.done ? '✓' : i + 1}</span><b>${esc(c.text)}</b><span class="pg-rwd"><span class="x">+${nf(c.xp)} XP</span><span class="f">${FUZZ()}${nf(c.fuzz)}</span></span>`
        + `<div class="pg-ch-row"><div class="pg-bar"><i style="--p:${pct}%"></i></div><small>${c.done ? 'Complete' : `${nf(p)} / ${nf(c.goal)}${unit}`}</small>${btn}</div></article>`;
    }).join('');
    return `<div class="pg-chs">${rows}</div><div class="pg-info"><p><b>New challenges in ${h} h ${m} min</b>Three a day, the same for everyone (UTC).</p><p><b>${reroll ? 'Reroll ready' : 'Reroll used'}</b>Swap one unfinished challenge a day.</p>`
      + `<p><b>First win bonus ${won ? 'claimed' : 'ready'}</b>${won ? 'Back tomorrow' : `Your first win today adds +${REWARD.firstWin[0]} XP and ${REWARD.firstWin[1]} Fuzz`}.</p></div>`;
  },
  achievements() {
    const st = Profile.stats, got = ACHIEVEMENTS.filter((a) => Progress.earned(a.id)).length;
    const rows = ACHIEVEMENTS.map((a) => {
      const t = Profile.data.achievements[a.id], pr = achievementProgress(a, st);
      const foot = t ? `<div class="pg-ch-row"><small style="text-align:left">Earned ${new Date(t).toLocaleDateString()}</small></div>` : pr ? `<div class="pg-ch-row"><div class="pg-bar"><i style="--p:${(100 * pr.value) / pr.goal}%"></i></div><small>${nf(pr.value)} / ${nf(pr.goal)}</small></div>` : '<div class="pg-ch-row"><small style="text-align:left">In one match</small></div>';
      const title = a.title ? ` Title: ${esc((itemById(a.title) || {}).name || '')}.` : '';
      return `<article class="pg-ach${t ? ' got' : ''}">${MEDAL(!!t)}<b>${esc(a.name)}</b><span>${FUZZ()}${nf(a.fuzz)}</span><p>${esc(a.desc)}.${title}</p>${foot}</article>`;
    }).join('');
    return `<div class="pg-achsum"><b>${got} / ${ACHIEVEMENTS.length}</b><div class="pg-bar"><i style="--p:${(100 * got) / ACHIEVEMENTS.length}%"></i></div><span class="fine">achievements earned</span></div><div class="pg-achs">${rows}</div>`;
  },
  act(e) {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const a = b.dataset.act, id = b.dataset.id, item = id && itemById(id), msg = (t, cls = '') => { $('pgMsg').textContent = t; $('pgMsg').className = `status ${cls}`; };
    if (a === 'cat') { this.cat = b.dataset.cat; this.render(); }
    else if (a === 'slot') { this.slot = b.dataset.slot; this.render(); }
    else if (a === 'toshop') { this.cat = item.kind; this.show('shop'); const el = $('pgBody').querySelector(`[data-key="buy:${CSS_ESC(id)}"]`); (el && !el.disabled ? el : $('pgTab-shop')).focus(); }
    else if (a === 'equip') {
      if (Profile.equip(item.kind, item.id === DEFAULTS[item.kind] ? null : item.id)) { chime([784, 1175], 0.05); msg(`${item.name} equipped.`, 'ok'); if (UI.renderPros && $('proPicker')) UI.renderPros(); }
    } else if (a === 'playas') {
      Settings.playAs = item.key; if (Settings.opponent === item.key) Settings.opponent = 'random';
      Settings.save(); if (UI.renderPros) UI.renderPros(); this.render(); msg(`You'll play as ${item.name}.`, 'ok');
    } else if (a === 'buy') {
      // Two presses: the first asks, so a stray click (or gamepad button) never spends Fuzz.
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1'; b.classList.add('confirm'); b.innerHTML = `Confirm · ${FUZZ()} ${nf(item.price)}`;
        clearTimeout(this.confirmT); this.confirmT = setTimeout(() => { if (b.isConnected) this.render(); }, 3500);
        return;
      }
      clearTimeout(this.confirmT);
      if (buy(item.id)) {
        chime([659, 988, 1319]); msg(`Bought ${item.name}.`, 'ok');
        this.toast('Pro Shop', item.name, item.kind === 'pro' ? 'Unlocked: pick them in the menu' : 'Now in your locker', FUZZ(), 'good');
        this.render();
        const eq = $('pgBody').querySelector(`[data-key="eq:${CSS_ESC(item.id)}"]`);
        if (eq) eq.focus();
      } else { msg('Not enough Fuzz yet.', 'err'); this.render(); }
    } else if (a === 'reroll') {
      if (Progress.reroll(+b.dataset.slot)) { chime([660, 880], 0.05); msg('Challenge swapped. New one below.', 'ok'); this.render(); const n = $('pgBody').querySelectorAll('.pg-ch')[+b.dataset.slot]; if (n) { n.style.animation = 'pgPop .5s var(--ease-back)'; $('pgTab-challenges').focus({ preventScroll: true }); } }
    }
  },

  // ---- keys: Esc = back, Q/E = tabs, arrows move between controls (a gamepad's d-pad lands here too) ----
  onKey(e) {
    if (UI.screen !== 'hub' || (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
    if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    const t = TABS.findIndex((x) => x[0] === this.tab);
    if (/^[qe[\]]$/i.test(e.key) || e.key === 'PageUp' || e.key === 'PageDown') {
      const d = /^[q[]$/i.test(e.key) || e.key === 'PageUp' ? -1 : 1;
      e.preventDefault(); this.show(TABS[(t + d + TABS.length) % TABS.length][0], true); return;
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return;
    const root = $('hub'), cur = document.activeElement;
    e.preventDefault();
    if (cur && cur.classList.contains('pg-tab') && dir[1] === 0) { this.show(TABS[(t + dir[0] + TABS.length) % TABS.length][0], true); return; }
    const els = [...root.querySelectorAll('button:not([disabled])')].filter((el) => el !== cur && el.offsetParent);
    if (!cur || !root.contains(cur) || cur === $('pgBody')) { (els[0] || $('pgBack')).focus(); return; }
    const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bs = Infinity;
    for (const el of els) {
      const q = el.getBoundingClientRect(), dx = q.left + q.width / 2 - cx, dy = q.top + q.height / 2 - cy, along = dx * dir[0] + dy * dir[1];
      if (along <= 2) continue;
      const s = along + 2.5 * Math.abs(dx * dir[1] + dy * dir[0]);
      if (s < bs) { bs = s; best = el; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); }
  },

  // ---- toasts ----
  toast(kicker, title, sub, icon = MEDAL(true), tone = '') {
    const box = $('pgToasts'), el = document.createElement('div');
    el.className = `pg-toast ${tone}`;
    el.innerHTML = `${icon}<small>${esc(kicker)}</small><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    box.append(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4600);
  },

  // ---- match-over rewards ----
  buildRewards() {
    const slab = $('over') && $('over').querySelector('.over-slab'), acts = slab && slab.querySelector('.actions');
    if (!acts) return;
    acts.insertAdjacentHTML('beforebegin', `<section class="pg-rw" id="pgRw" aria-label="Rewards" hidden>
      <div class="pg-rw-top"><span class="pg-lv" id="pgRwLv">1</span><div class="pg-rw-xp"><div class="pg-rw-xpl"><b id="pgRwGain">+0 XP</b><span id="pgRwXp"></span></div><div class="pg-xp" id="pgRwBar"><i class="now"></i><i class="base"></i></div></div>
      <div class="pg-rw-fz"><span class="pg-fuzz">${FUZZ()}<b id="pgRwFz">+0</b></span><small id="pgRwBal"></small></div></div>
      <ol class="pg-rw-lines" id="pgRwLines" aria-label="Rewards"></ol><div class="pg-rw-unl" id="pgRwUnl"></div>
      <button class="btn pg-ad" id="pgAd" type="button" hidden></button></section>`);
    $('pgRw').addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) this.finish(); });
    $('pgAd').onclick = () => this.watchAd();
  },
  onScreen(screen) {
    if (screen === 'over') this.showRewards();
    else if (this.anim) this.finish(true);
    if (screen === 'menu') this.renderCard();
  },
  showRewards() {
    const box = $('pgRw'), p = this.pending;
    if (!box) return;
    this.clearTimers();
    if (!p || p.at < this.matchAt) { box.hidden = true; this.anim = null; return; }
    this.pending = null;
    const res = p.res, steps = [
      ...res.lines.map((l) => ({ label: l.label, xp: l.xp, fuzz: l.fuzz })),
      ...res.challenges.map((c) => ({ tag: 'Challenge', label: c.text, xp: c.xp, fuzz: c.fuzz, toast: ['Daily challenge complete', c.text, `+${nf(c.xp)} XP · +${nf(c.fuzz)} Fuzz`, 'good'] })),
      ...res.achievements.map((a) => ({ tag: 'Achievement', cls: 'ach', label: a.name, xp: a.xp, fuzz: a.fuzz, toast: ['Achievement unlocked', a.name, a.desc, ''] })),
    ];
    const A = this.anim = { res, steps, i: 0, xp0: p.xp0, fz0: p.fz0, xp: p.xp0, fz: p.fz0, showXP: p.xp0, showFz: p.fz0, level: levelFor(p.xp0), base: p.xp0, done: false, doubled: false };
    box.hidden = false;
    $('pgRwLines').innerHTML = ''; $('pgRwUnl').innerHTML = ''; $('pgAd').hidden = true;
    const old = box.querySelector('.pg-lvup'); if (old) old.remove();
    this.draw();
    steps.forEach((s, i) => this.later(450 + i * 300, () => this.step()));
    this.later(450 + steps.length * 300 + 500, () => this.finish());
    this.ticker = setInterval(() => this.tick(), 33);
  },
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); },
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers = []; clearInterval(this.ticker); this.ticker = 0; },
  step(quiet) {
    const A = this.anim;
    if (!A || A.i >= A.steps.length) return;
    const s = A.steps[A.i++], li = document.createElement('li');
    if (s.cls) li.className = s.cls;
    li.innerHTML = `<span>${s.tag ? `<em>${esc(s.tag)}</em>` : ''}${esc(s.label)}</span><b>${s.xp ? `+${nf(s.xp)}` : ''}</b><b class="f">${s.fuzz ? `+${nf(s.fuzz)}` : ''}</b>`;
    $('pgRwLines').append(li);
    li.scrollIntoView({ block: 'nearest' });
    A.xp += s.xp; A.fz += s.fuzz;
    if (s.toast) { this.toast(s.toast[0], s.toast[1], s.toast[2], s.cls === 'ach' ? MEDAL(true) : FUZZ(), s.toast[3]); if (!quiet) chime(s.cls === 'ach' ? [784, 988, 1319, 1568] : [880, 1175, 1568], 0.06); }
    else if (!quiet) chime([1568], 0.025);
  },
  // Counters and the XP bar ease towards the running totals; crossing a level boundary is a level-up.
  tick() {
    const A = this.anim;
    if (!A) return;
    A.showXP += Math.max(1, (A.xp - A.showXP) * 0.16) * Math.sign(A.xp - A.showXP);
    if (Math.abs(A.xp - A.showXP) < 1) A.showXP = A.xp;
    A.showFz += Math.max(1, (A.fz - A.showFz) * 0.16) * Math.sign(A.fz - A.showFz);
    if (Math.abs(A.fz - A.showFz) < 1) A.showFz = A.fz;
    const lv = levelFor(A.showXP);
    if (lv > A.level) { A.level = lv; A.base = xpToReach(lv); this.levelUp(lv); }
    this.draw();
    if (A.done && A.showXP === A.xp && A.showFz === A.fz) { clearInterval(this.ticker); this.ticker = 0; }
  },
  draw() {
    const A = this.anim, lv = A.level, need = xpForLevel(lv), from = xpToReach(lv), pct = (x) => `${need ? Math.max(0, Math.min(100, (100 * (x - from)) / need)) : 100}%`;
    const bar = $('pgRwBar');
    bar.children[0].style.width = pct(A.showXP); bar.children[1].style.width = pct(Math.max(A.base, A.xp0));
    $('pgRwLv').textContent = lv;
    $('pgRwGain').textContent = `+${nf(A.showXP - A.xp0)} XP`;
    $('pgRwXp').textContent = need ? `${nf(Math.max(0, A.showXP - from))} / ${nf(need)}` : 'Max level';
    $('pgRwFz').textContent = `+${nf(A.showFz - A.fz0)}`;
    $('pgRwBal').textContent = `Balance ${nf(A.showFz)} Fuzz`;
  },
  levelUp(lv) {
    const A = this.anim, box = $('pgRw'), names = A.res.unlocked.map(itemById).filter((i) => i && i.level === lv).map((i) => i.name);
    const old = box.querySelector('.pg-lvup'); if (old) old.remove();
    box.insertAdjacentHTML('beforeend', `<div class="pg-lvup" aria-hidden="true"><small>Level up</small><b>${lv}</b>${names.length ? `<span>Unlocked: ${esc(names.join(' · '))}</span>` : ''}</div>`);
    const badge = $('pgRwLv'); badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
    const bar = $('pgRwBar'); bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash');
    this.later(2500, () => { const el = box.querySelector('.pg-lvup'); if (el) el.remove(); });
    chime([523, 659, 784, 1047, 1319], 0.07, 0.07);
    this.toast('Level up', `Level ${lv}`, names.length ? `Unlocked: ${names.join(', ')}` : 'Keep going: more unlocks ahead', FUZZ(), '');
  },
  // Skip ahead (a click on the panel, or leaving the screen): all lines, final numbers, the unlocks and the ad offer.
  finish(leaving) {
    const A = this.anim;
    if (!A) return;
    if (A.done && !leaving) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    while (A.i < A.steps.length) this.step(true);
    if (leaving) { this.clearTimers(); A.showXP = A.xp; A.showFz = A.fz; A.level = levelFor(A.xp); A.done = true; return; }
    A.done = true;
    const names = A.res.unlocked.map(itemById).filter(Boolean);
    $('pgRwUnl').innerHTML = names.length ? `<small>Unlocked</small>${names.map((i, k) => `<span class="pg-unl" style="animation-delay:${k * 80}ms">${esc(i.name)}${i.kind === 'title' ? ' (title)' : ''}</span>`).join('')}` : '';
    if (!this.ticker) this.ticker = setInterval(() => this.tick(), 33);
    this.offerAd();
  },
  async offerAd() {
    const A = this.anim, btn = $('pgAd');
    if (!A || A.doubled || !(A.res.fuzz > 0)) return;
    const P = await platform();
    const ads = P && P.ads;
    let ok = false;
    try { ok = !!ads && typeof ads.rewarded === 'function' && typeof ads.available === 'function' && !!ads.available('rewarded'); } catch (e) { ok = false; }
    if (!ok || this.anim !== A || UI.screen !== 'over') return;
    btn.innerHTML = `${FUZZ()} Watch an ad: double your Fuzz <b>+${nf(A.res.fuzz)}</b>`;
    btn.disabled = false; btn.hidden = false;
  },
  async watchAd() {
    const A = this.anim, btn = $('pgAd');
    if (!A || A.doubled || btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Loading the ad…';
    let ok = false;
    try { const P = await platform(); ok = !!(await P.ads.rewarded('double-fuzz')); } catch (e) { ok = false; }
    if (!ok) { btn.textContent = 'No ad right now. Maybe next time.'; setTimeout(() => { if (this.anim === A) btn.hidden = true; }, 2500); return; }
    A.doubled = true;
    Profile.addFuzz(A.res.fuzz, 'ad: double match Fuzz');
    btn.hidden = true;
    if (this.anim === A && UI.screen === 'over') {
      A.steps.push({ tag: 'Bonus', cls: 'ad', label: 'Fuzz doubled', xp: 0, fuzz: A.res.fuzz });
      this.step();
      if (!this.ticker) this.ticker = setInterval(() => this.tick(), 33);
    }
    chime([659, 988, 1319]);
  },

  // ---- equipped cosmetics on the local player (after game.js has dressed both players for the match) ----
  dress(cfg) {
    const players = Game.players, me = cfg.localIdx, playing = cfg.mode === 'cpu' || cfg.mode === 'online', lk = lookFor(Profile.equipped);
    players.forEach((pl, i) => {
      const av = pl.avatar, mine = playing && i === me;
      this.setRacket(av, mine && lk.racket ? lk.racket : (KITS[i] || KITS[0]).racket, i);
      if (!mine) return;
      if (!pl.pro) {
        av.setKit(lk.kit);
        if (Object.keys(lk.look).length) av.setLook({ ...(av.look || {}), ...lk.look });
      }
      if (lk.style.celebrate && av.setStyle) av.setStyle({ ...((proById(pl.pro) || {}).style || {}), ...lk.style });
    });
    // Against the CPU, the opponent changes if your new shirt matches theirs.
    const mine = players[me], opp = players[1 - me];
    if (playing && cfg.mode === 'cpu' && mine && opp && !mine.pro && lk.kit.shirt != null && clash(opp.avatar.kit.shirt, lk.kit.shirt)) {
      const fits = (o) => o && !clash(o.shirt, lk.kit.shirt), pro = proById(opp.pro), kit = pro && fits(pro.alt) ? pro.alt : OUTFITS.find(fits);
      if (kit) opp.avatar.setKit(kit);
    }
    Replay.bones = players.map((p) => Object.values(p.avatar.B));   // setLook may have rebuilt a skeleton
  },
  // Swap the racket in the hand for one in these colours (same place in the hand); nothing to do if it already is.
  setRacket(av, opts = {}, i = 0) {
    const key = JSON.stringify(opts);
    if (av.pgRacket === undefined) av.pgRacket = JSON.stringify((KITS[i] || KITS[0]).racket || {});
    if (av.pgRacket === key) return;
    const old = av.racket, r = makeRacket(opts);
    r.position.copy(old.position); r.quaternion.copy(old.quaternion); r.scale.copy(old.scale);
    r.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    if (old.parent) { old.parent.add(r); old.parent.remove(old); }
    old.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    av.racket = r; av.pgRacket = key;
  },
};
const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const clash = (a, b) => { const p = rgb(a), q = rgb(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 80; };
const CSS_ESC = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
