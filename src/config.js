// Palm Court: release configuration. One build serves every edition: edit the defaults below for a portal upload or
// the Steam build, or override them with URL parameters for testing (?portal=poki&edition=web&adEvery=1).
// See README → Publishing.
const STEAM_PLACEHOLDER = 'https://store.steampowered.com/app/YOUR_APP_ID/Palm_Court/';

const CONFIG = {
  edition: 'web',            // 'web' (free, ads, "Wishlist on Steam") | 'steam' (paid build: no ads, no wishlist button)
  portal: 'none',            // ad SDK: 'none' | 'crazygames' | 'poki' | 'gd' (GameDistribution) | 'adsense' (Google H5 Games Ads)
  steamUrl: STEAM_PLACEHOLDER,   // the Steam store page; the wishlist button stays hidden until this is a real URL
  cloud: null,               // optional cloud saves (Supabase): { url: 'https://xxxx.supabase.co', anonKey: '…' }
  ads: {
    interstitialEveryMatches: 2,   // at most one break per this many matches (never before the first match of a visit)
    minGapS: 150,                  // and never twice within this many seconds (portals cap on their side too)
    rewardedDoubleFuzz: true,      // offer "Watch an ad to double your Fuzz" on the post-match screen
  },
  gd: { gameId: '' },        // GameDistribution: the game id from their developer dashboard (required)
  adsense: { client: '', test: false, frequencyHint: '120s' },   // H5 Games Ads: 'ca-pub-…' publisher id; test = adbreak test mode
  consentPrompt: 'auto',     // own EU consent prompt for personalised ads: 'auto' (only when the SDK has no CMP) | 'never' | 'ask'
  showWishlist: false,       // show the wishlist button even while steamUrl is the placeholder (testing)
};

// URL overrides, for testing a portal or edition without editing this file.
try {
  const q = new URLSearchParams(location.search), pick = (k, ok) => { const v = q.get(k); return v != null && ok.includes(v) ? v : null; };
  CONFIG.edition = pick('edition', ['web', 'steam']) || CONFIG.edition;
  CONFIG.portal = pick('portal', ['none', 'crazygames', 'poki', 'gd', 'adsense']) || CONFIG.portal;
  if (q.get('showWishlist') === '1') CONFIG.showWishlist = true;
  if (q.get('adEvery') && +q.get('adEvery') >= 1) { CONFIG.ads.interstitialEveryMatches = Math.round(+q.get('adEvery')); CONFIG.ads.minGapS = 0; }
  if (q.get('adTest') === '1') CONFIG.adsense.test = true;
  if (q.get('consent') === 'ask') CONFIG.consentPrompt = 'ask';
  if (q.get('gdId')) CONFIG.gd.gameId = q.get('gdId').replace(/[^\w-]/g, '');
  if (q.get('adClient')) CONFIG.adsense.client = q.get('adClient').replace(/[^\w-]/g, '');
} catch (e) { /* no location (tests) */ }
if (CONFIG.edition === 'steam') CONFIG.portal = 'none';   // the paid build never shows ads

// The wishlist button needs a real store URL (or the explicit test switch) and the web edition.
const steamUrlReady = () => /^https:\/\/store\.steampowered\.com\/app\/\d+/.test(CONFIG.steamUrl || '');
const wishlistVisible = () => CONFIG.edition === 'web' && (steamUrlReady() || CONFIG.showWishlist);

export { CONFIG, STEAM_PLACEHOLDER, steamUrlReady, wishlistVisible };
