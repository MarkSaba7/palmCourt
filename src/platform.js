// Palm Court: web-portal platform layer. Ads (interstitial between matches, opt-in rewarded), gameplay start/stop
// signals, "happy time", the Steam wishlist button, legal links and a minimal EU ad-consent prompt.
//
// Every call is safe with no SDK, a blocked SDK (ad-blocker), or an SDK that never answers: ads resolve on a timer,
// so the game can never hang on one. The portal SDK is only loaded when CONFIG.portal names it (src/config.js).
//
//   Platform.init()                      once at boot (never awaited by the game)
//   Platform.ads.interstitial(where)     → Promise<bool shown>; paced here (not the first match, every N matches, gap)
//   Platform.ads.rewarded(where)         → Promise<bool rewarded>; the player asked for it, so no pacing
//   Platform.ads.available(kind?)        → bool; kind: 'interstitial' | 'rewarded' | 'doubleFuzz' (rewarded + config)
//   Platform.gameplayStart() / gameplayStop() / happyTime()   (also driven automatically from Bus events)
//   Platform.openWishlist()              opens CONFIG.steamUrl in a new tab
//   Platform.consent                     { needed, status(), personalised, ask(), set(bool) }
// Bus events: 'ad' { kind, where, state: 'start' | 'end', shown } around every ad attempt.
import { CONFIG, wishlistVisible } from './config.js';
import { Clock } from './core.js';
import { Sound } from './match.js';
import { Bus } from './events.js';

const T = { load: 8000, init: 6000, start: 6000, interstitialMax: 45000, rewardedMax: 90000 };   // ms; tests shrink these
const settle = (p, ms, fallback) => new Promise((res) => {
  const t = setTimeout(() => res(fallback), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(fallback); });
});
const call = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { console.warn('[platform]', e); } };

// One script tag per SDK; resolves false when it's blocked, fails or takes too long.
function loadScript(src, attrs = {}) {
  return new Promise((res) => {
    const s = document.createElement('script'), t = setTimeout(() => res(false), T.load);
    s.async = true;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = () => { clearTimeout(t); res(true); };
    s.onerror = () => { clearTimeout(t); res(false); };
    s.src = src;
    document.head.appendChild(s);
  });
}

// ---- adapters: init() → bool (ads usable); ad(kind, where, started) → Promise<bool> (shown / rewarded) ----
const ADAPTERS = {
  none: { cmp: false, rewarded: false, async init() { return false; } },

  // CrazyGames SDK v3: https://docs.crazygames.com/sdk/html5-v3/
  crazygames: {
    cmp: true, rewarded: true,
    async init() {
      if (!await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js')) return false;
      const sdk = window.CrazyGames && window.CrazyGames.SDK;
      if (!sdk) return false;
      await settle(sdk.init(), T.init, null);
      this.sdk = sdk;
      return sdk.environment !== 'disabled';
    },
    loading(on) { const g = this.sdk && this.sdk.game; if (!g || (!on && !this.loadingOn)) return; this.loadingOn = on; call(on ? g.loadingStart : g.loadingStop); },   // only a started load is stopped
    start() { call(this.sdk?.game?.gameplayStart); },
    stop() { call(this.sdk?.game?.gameplayStop); },
    happy() { call(this.sdk?.game?.happytime); },
    ad(kind, where, started) {
      return new Promise((res) => this.sdk.ad.requestAd(kind === 'rewarded' ? 'rewarded' : 'midgame',
        { adStarted: started, adFinished: () => res(true), adError: () => res(false) }));
    },
  },

  // Poki SDK v2: https://sdk.poki.com/html5 (Poki paces its breaks itself; it handles consent too)
  poki: {
    cmp: true, rewarded: true,
    async init() {
      if (!await loadScript('https://game-cdn.poki.com/scripts/v2/poki-sdk.js') || !window.PokiSDK) return false;
      this.sdk = window.PokiSDK;
      return await settle(this.sdk.init().then(() => true), T.init, false);   // rejects under an ad-blocker: play on without ads
    },
    loading(on) { if (!on) call(this.sdk?.gameLoadingFinished); },
    start() { call(this.sdk?.gameplayStart); },
    stop() { call(this.sdk?.gameplayStop); },
    happy() { call(this.sdk?.happyTime, 1); },
    ad(kind, where, started) {
      return kind === 'rewarded' ? Promise.resolve(this.sdk.rewardedBreak(started)).then((ok) => ok === true)
        : Promise.resolve(this.sdk.commercialBreak(started)).then(() => true);
    },
  },

  // GameDistribution HTML5 SDK: https://github.com/GameDistribution/GD-HTML5 (needs CONFIG.gd.gameId)
  gd: {
    cmp: true, rewarded: true,
    async init() {
      if (!CONFIG.gd.gameId) { console.warn('[platform] GameDistribution needs CONFIG.gd.gameId'); return false; }
      let ready;
      const isReady = new Promise((r) => (ready = r));
      window.GD_OPTIONS = { gameId: CONFIG.gd.gameId, onEvent: (e) => {
        const n = e && e.name;
        if (n === 'SDK_READY') ready(true);
        else if (n === 'SDK_ERROR') ready(false);
        else if (n === 'SDK_GAME_PAUSE') call(this.started);
        else if (n === 'SDK_REWARDED_WATCH_COMPLETE') this.earned = true;
      } };
      if (!await loadScript('https://html5.api.gamedistribution.com/main.min.js', { id: 'gamedistribution-jssdk' })) return false;
      return (await settle(isReady, T.init, false)) && !!window.gdsdk;
    },
    ad(kind, where, started) {
      this.started = started; this.earned = false;
      const p = kind === 'rewarded' ? window.gdsdk.showAd('rewarded') : window.gdsdk.showAd();
      // The reward event can land just after the promise settles: give it a moment.
      return Promise.resolve(p).then(() => new Promise((r) => setTimeout(() => r(kind === 'rewarded' ? this.earned : true), 250)), () => false);
    },
  },

  // Google H5 Games Ads (AdSense Ad Placement API): https://developers.google.com/ad-placement
  adsense: {
    cmp: false, rewarded: true,
    async init() {
      const client = CONFIG.adsense.client;
      if (!/^ca-pub-\d+$/.test(client)) { console.warn('[platform] H5 Games Ads needs CONFIG.adsense.client (ca-pub-…)'); return false; }
      const q = (window.adsbygoogle = window.adsbygoogle || []);
      q.requestNonPersonalizedAds = Consent.personalised === true ? 0 : 1;
      const attrs = { 'data-ad-client': client, 'data-ad-frequency-hint': CONFIG.adsense.frequencyHint, crossorigin: 'anonymous' };
      if (CONFIG.adsense.test) attrs['data-adbreak-test'] = 'on';
      if (!await loadScript(`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`, attrs)) return false;
      this.push = (o) => window.adsbygoogle.push(o);
      this.push({ preloadAdBreaks: 'on', sound: 'on' });   // adConfig
      return true;
    },
    ad(kind, where, started) {
      const name = String(where || kind).replace(/[^\w-]/g, '-');
      return new Promise((res) => {
        if (kind !== 'rewarded') return this.push({ type: 'next', name, beforeAd: started, afterAd() {}, adBreakDone: (i) => res(!!i && i.breakStatus === 'viewed') });
        let viewed = false;
        this.push({ type: 'reward', name, beforeAd: started, afterAd() {}, beforeReward: (show) => show(), adViewed: () => (viewed = true), adDismissed: () => (viewed = false), adBreakDone: () => res(viewed) });
      });
    },
  },
};

// ---- holding the game while an ad plays: match clock, audio, voice, input ----
const Hold = {
  on: false, clock: false, audio: false, shield: null,
  grab() {
    if (this.on) return;
    this.on = true;
    this.clock = !Clock.paused;
    if (this.clock) Clock.pause();
    const c = Sound.ctx;
    this.audio = !!c && c.state !== 'closed';   // also when a resume is still pending from the last ad
    if (this.audio) c.suspend().catch(() => {});
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* no voice */ }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();   // Enter can't restart anything
    if (this.shield) this.shield.hidden = false;
  },
  release() {
    if (!this.on) return;
    this.on = false;
    if (this.clock) Clock.resume();
    if (this.audio && Sound.ctx) Sound.ctx.resume().catch(() => {});
    if (this.shield) this.shield.hidden = true;
  },
};

// ---- EU consent for personalised ads, only when the SDK doesn't bring its own CMP (H5 Games Ads) ----
const EU_TZ = /^(Europe\/|Atlantic\/(Azores|Madeira|Canary|Faroe|Reykjavik)|Arctic\/Longyearbyen)/;
const CONSENT_KEY = 'palmcourt.consent';
const Consent = {
  needed: false, personalised: null, el: null,
  load() {
    try { const v = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); if (v && typeof v.personalised === 'boolean') this.personalised = v.personalised; } catch (e) { /* storage blocked */ }
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
    const own = CONFIG.portal !== 'none' && !(ADAPTERS[CONFIG.portal] || {}).cmp;
    this.needed = own && (CONFIG.consentPrompt === 'ask' || (CONFIG.consentPrompt === 'auto' && EU_TZ.test(tz)));
    if (own && !this.needed && this.personalised == null) this.personalised = true;   // outside the EU/UK: no prompt
  },
  status() { return !CONFIG.portal || CONFIG.portal === 'none' ? 'none' : (ADAPTERS[CONFIG.portal] || {}).cmp ? 'portal' : this.personalised == null ? 'unknown' : this.personalised ? 'granted' : 'denied'; },
  set(yes) {
    this.personalised = !!yes;
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ personalised: this.personalised, at: new Date().toISOString() })); } catch (e) { /* storage blocked */ }
    if (window.adsbygoogle) window.adsbygoogle.requestNonPersonalizedAds = this.personalised ? 0 : 1;
    if (this.el) this.el.hidden = true;
  },
  // Shows the prompt; resolves with the choice (dismissing = non-personalised).
  ask() {
    if (!this.el) return Promise.resolve(!!this.personalised);
    this.el.hidden = false;
    this.el.querySelector('.pf-yes').focus({ preventScroll: true });
    return new Promise((r) => (this.done = r));
  },
  answer(yes) { this.set(yes); const d = this.done; this.done = null; if (d) d(this.personalised); },
};

// ---- pacing: interstitials only between matches, never before the first one of a visit ----
const Pace = { played: 0, since: 0, lastAd: -1e9, matchT: 0 };

const Platform = {
  CONFIG, T, adapter: ADAPTERS.none, name: 'none', ready: null, ok: false, rewardedOk: false, playing: false, inMatch: false, loaded: false, busy: null,
  consent: Consent,

  init() {
    if (this.ready) return this.ready;
    Consent.load();
    this.buildUI();
    this.listen();
    this.name = ADAPTERS[CONFIG.portal] ? CONFIG.portal : 'none';
    this.adapter = ADAPTERS[this.name];
    this.ready = settle(this.adapter.init(), T.load + T.init + 1000, false).then((ok) => {
      this.ok = !!ok; this.rewardedOk = this.ok && !!this.adapter.rewarded;
      if (this.name !== 'none') console.info(`[platform] ${this.name} ${this.ok ? 'ready' : 'unavailable: playing without ads'}`);
      if (this.ok) call(this.adapter.loading?.bind(this.adapter), !this.loaded);   // SDK ready after the game: just "loaded"
      this.renderLinks();
      return this.ok;
    });
    return this.ready;
  },

  // The game is on screen: portals track load time with this (first UI.go).
  gameLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.ok) call(this.adapter.loading?.bind(this.adapter), false);
    if (Consent.needed && Consent.personalised == null) setTimeout(() => Consent.ask(), 1200);
  },
  gameplayStart() { if (this.playing) return; this.playing = true; if (this.ok) call(this.adapter.start?.bind(this.adapter)); },
  gameplayStop() { if (!this.playing) return; this.playing = false; if (this.ok) call(this.adapter.stop?.bind(this.adapter)); },
  happyTime() { if (this.ok) call(this.adapter.happy?.bind(this.adapter)); },

  ads: {
    available(kind) {
      const P = Platform;
      if (!P.ok || CONFIG.edition !== 'web') return false;
      if (kind === 'doubleFuzz') return P.rewardedOk && !!CONFIG.ads.rewardedDoubleFuzz;
      if (kind === 'rewarded') return P.rewardedOk;
      return true;
    },
    // A break between matches. Call it at every natural break; the pacing below decides whether one runs.
    interstitial(where = 'break') {
      const P = Platform, a = CONFIG.ads;
      if (P.busy) return P.busy.then(() => false);
      if (!Platform.ads.available('interstitial')) return Promise.resolve(false);
      if (Pace.played < 1 || Pace.since < Math.max(1, a.interstitialEveryMatches | 0) || performance.now() - Pace.lastAd < a.minGapS * 1000) return Promise.resolve(false);
      return P.run('interstitial', where);
    },
    rewarded(where = 'reward') {
      const P = Platform;
      if (P.busy) return P.busy.then(() => false);
      if (!Platform.ads.available(where === 'doubleFuzz' ? 'doubleFuzz' : 'rewarded')) return Promise.resolve(false);
      return P.run('rewarded', where);
    },
  },

  // One ad attempt. Holds the game only once the ad really starts, gives up if it doesn't start in time or never
  // ends, and holds again if a late ad shows up after all, until the SDK lets go.
  run(kind, where) {
    const max = kind === 'rewarded' ? T.rewardedMax : T.interstitialMax;
    let started = false, done = false, sdkDone = false, lateHeld = false, timers = [];
    this.gameplayStop();
    Bus.emit('ad', { kind, where, state: 'start' });
    const onStart = () => {
      if (started) return;
      started = true;
      if (!sdkDone) { Hold.grab(); if (done) lateHeld = true; }
    };
    this.busy = new Promise((resolve) => {
      const finish = (v) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        if (!lateHeld) Hold.release();
        if (started) { Pace.since = 0; Pace.lastAd = performance.now(); }
        this.busy = null;
        Bus.emit('ad', { kind, where, state: 'end', shown: started });
        resolve(v === true && (started || kind === 'rewarded'));   // an interstitial counts only if one really played
      };
      timers = [setTimeout(() => { if (!started) finish(false); }, T.start), setTimeout(() => finish(false), max)];
      let p;
      try { p = this.adapter.ad(kind, where, onStart); } catch (e) { console.warn('[platform] ad failed', e); p = Promise.resolve(false); }
      Promise.resolve(p).catch(() => false).then((v) => {
        sdkDone = true;
        if (lateHeld) { lateHeld = false; Hold.release(); }
        finish(v);
      });
    });
    return this.busy;
  },

  openWishlist() {
    Bus.emit('wishlist', {});
    try { window.open(CONFIG.steamUrl, '_blank', 'noopener'); } catch (e) { console.warn('[platform]', e); }
  },

  // Gameplay signals and pacing follow the match through the Bus, so game.js and ui.js need no platform calls.
  listen() {
    Bus.on('match:start', ({ cfg }) => {
      this.inMatch = !!cfg && cfg.mode !== 'attract';
      if (this.inMatch) Pace.matchT = performance.now();
    });
    const ended = (counts) => {
      if (!this.inMatch) return;
      this.inMatch = false;
      if (counts) { Pace.played++; Pace.since++; }
      this.gameplayStop();
    };
    Bus.on('match:end', (e) => {
      ended(true);
      const me = e.localIdx, m = e.match, cfg = e.cfg || {};
      if (me < 0 || e.winner !== me || !m) return;
      const bagel = m.games && m.games[1 - me] === 0, big = bagel || cfg.level === 'pro' || e.mode === 'online' || (cfg.tour && cfg.tour.final) || (cfg.career && cfg.career.final);
      if (big) this.happyTime();
    });
    Bus.on('match:quit', () => ended(performance.now() - Pace.matchT > 60000));   // a real attempt counts; a quick back-out doesn't
    Bus.on('screen', ({ screen }) => {
      this.gameLoaded();
      if (screen === null && this.inMatch) this.gameplayStart(); else if (screen !== null) this.gameplayStop();
      if (screen === 'menu' || screen === 'over') this.renderLinks();
    });
  },

  // ---- UI: wishlist buttons, legal links, consent card, ad shield (built here so index.html stays untouched) ----
  buildUI() {
    if (typeof document === 'undefined' || document.getElementById('pfCss')) return;
    const css = document.createElement('style');
    css.id = 'pfCss';
    css.textContent = `
.pf-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; border-top: 1px solid var(--edge, #333); padding-top: 12px; font-size: 13px; color: var(--mist, #9ab); }
.pf-links a, .pf-links .pf-link { color: var(--mist, #9ab); text-decoration: none; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
.pf-links a:hover, .pf-links .pf-link:hover { color: var(--chalk, #fff); text-decoration: underline; }
.pf-links .pf-wish { margin-right: auto; }
.pf-wish { display: inline-flex; align-items: center; gap: 8px; appearance: none; cursor: pointer; font: 700 13px/1 var(--body, sans-serif); letter-spacing: .02em;
  color: var(--chalk, #fff); background: rgba(242,245,238,.06); border: 1px solid var(--edge, #444); border-radius: 999px; padding: 8px 13px; }
.pf-wish:hover { background: rgba(242,245,238,.13); border-color: rgba(242,245,238,.3); }
.pf-wish:focus-visible, .pf-links a:focus-visible, .pf-link:focus-visible, .pf-consent .btn:focus-visible { outline: 2px solid var(--optic, #d6f04a); outline-offset: 2px; }
.pf-wish svg { width: 14px; height: 14px; fill: var(--optic, #d6f04a); flex: none; }
.pf-over-wish { display: flex; justify-content: center; margin-top: 12px; }
.pf-consent { position: fixed; z-index: 60; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(520px, calc(100% - 32px)); box-sizing: border-box;
  background: var(--panel, rgba(8,18,29,.95)); border: 1px solid var(--edge, #444); border-radius: 12px; padding: 16px; color: var(--chalk, #fff);
  box-shadow: 0 12px 40px rgba(0,0,0,.45); backdrop-filter: blur(10px); font-size: 14px; }
.pf-consent p { margin: 0 0 12px; }
.pf-consent p a { color: var(--optic, #d6f04a); }
.pf-consent .pf-row { display: flex; flex-wrap: wrap; gap: 8px; }
.pf-consent .btn { flex: 1 1 180px; }
.pf-shield { position: fixed; inset: 0; z-index: 70; background: rgba(4,9,15,.72); display: grid; place-items: center; color: var(--mist, #9ab); font: 600 13px var(--body, sans-serif); letter-spacing: .08em; text-transform: uppercase; }
.pf-shield[hidden], .pf-consent[hidden], .pf-wish[hidden], .pf-over-wish[hidden], .pf-link[hidden] { display: none; }`;
    document.head.appendChild(css);

    const star = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
    const wish = (id) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.className = 'pf-wish'; b.innerHTML = `${star}<span>Wishlist on Steam</span>`; b.onclick = () => this.openWishlist(); return b; };

    const menuSlab = document.querySelector('#menu > .slab') || document.getElementById('menu');
    if (menuSlab) {
      const nav = document.createElement('nav');
      nav.className = 'pf-links'; nav.id = 'pfLinks'; nav.setAttribute('aria-label', 'About');
      nav.append(wish('btnWishlist'));
      nav.insertAdjacentHTML('beforeend', '<a href="privacy.html" target="_blank" rel="noopener">Privacy</a><a href="credits.html" target="_blank" rel="noopener">Credits</a><button type="button" class="pf-link" id="btnAdChoices">Ad choices</button>');
      nav.querySelector('#btnAdChoices').onclick = () => Consent.ask();
      menuSlab.append(nav);
    }
    const overActions = document.querySelector('#over .actions');
    if (overActions) {
      const p = document.createElement('div');
      p.className = 'pf-over-wish'; p.id = 'pfOverWish';
      p.append(wish('btnWishlistOver'));
      overActions.after(p);
    }

    const card = document.createElement('section');
    card.className = 'pf-consent'; card.id = 'pfConsent'; card.hidden = true;
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Ad choices');
    card.innerHTML = `<p><b>Ads keep Palm Court free.</b> May our ad partner (Google) use cookies and similar data to show ads based on your interests? Either way you get the same game, and you can change this later under Ad choices. <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p>
<div class="pf-row"><button type="button" class="btn primary pf-yes">Allow personalised ads</button><button type="button" class="btn pf-no">Non-personalised only</button></div>`;
    card.querySelector('.pf-yes').onclick = () => Consent.answer(true);
    card.querySelector('.pf-no').onclick = () => Consent.answer(false);
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); Consent.answer(false); } });
    document.body.append(card);
    Consent.el = card;

    const shield = document.createElement('div');
    shield.className = 'pf-shield'; shield.id = 'pfShield'; shield.hidden = true; shield.textContent = 'Ad break';
    for (const ev of ['pointerdown', 'click', 'keydown']) shield.addEventListener(ev, (e) => e.stopPropagation());
    document.body.append(shield);
    Hold.shield = shield;
    this.renderLinks();
  },
  renderLinks() {
    if (typeof document === 'undefined') return;
    const show = wishlistVisible();
    for (const id of ['btnWishlist', 'pfOverWish']) { const el = document.getElementById(id); if (el) el.hidden = !show; }
    const ac = document.getElementById('btnAdChoices');
    if (ac) ac.hidden = !Consent.needed;
  },
};

export { Platform, ADAPTERS };
