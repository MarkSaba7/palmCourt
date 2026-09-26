// Palm Court: release configuration. One build serves every edition: edit the defaults below for a portal upload or
// the Steam build, or override them with URL parameters for testing (?portal=poki&edition=web&adEvery=1).
// See README → Publishing.
const STEAM_PLACEHOLDER = 'https://store.steampowered.com/app/YOUR_APP_ID/Palm_Court/';

const CONFIG = {
  edition: 'web',            // 'web' (free, ads, "Wishlist on Steam") | 'steam' (paid build: no ads, no wishlist button)
  // Ad SDK: 'auto' | 'none' | 'crazygames' | 'poki' | 'gd' (GameDistribution) | 'adsense' (Google H5 Games Ads, own domain).
  // 'auto' = 'adsense' on the web edition once adsense.client is set, else 'none' (no ads). A portal upload names its SDK.
  portal: 'auto',
  steamUrl: STEAM_PLACEHOLDER,   // the Steam store page; the wishlist button stays hidden until this is a real URL
  // Cloud saves (Supabase). The publishable key is made for client code; never put any other Supabase key here.
  // Dormant until the cloud feature is wired and `enabled` is set to true.
  cloud: { url: 'https://dpzdvbhwrumoftjagukh.supabase.co', anonKey: 'sb_publishable_OvSeFiGjv6xvQlPPVGv-7Q_popyx3Zm', enabled: false },
  ads: {
    interstitialEveryMatches: 2,   // at most one break per this many matches (never before the first match of a visit)
    minGapS: 150,                  // and never twice within this many seconds (portals cap on their side too)
    rewardedDoubleFuzz: true,      // offer "Watch an ad to double your Fuzz" on the post-match screen
  },
  gd: { gameId: '' },        // GameDistribution: the game id from their developer dashboard (required)
  adsense: { client: 'ca-pub-6534034175572614', test: false, frequencyHint: '120s' },   // H5 Games Ads: publisher id 'ca-pub-…' (null = no ads); test = adbreak test mode
  consentPrompt: 'auto',     // own EU consent prompt for personalised ads: 'auto' (only when the SDK has no CMP) | 'never' | 'ask'
  showWishlist: false,       // show the wishlist button even while steamUrl is the placeholder (testing)
};

// URL overrides, for testing a portal or edition without editing this file.
try {
  const q = new URLSearchParams(location.search), pick = (k, ok) => { const v = q.get(k); return v != null && ok.includes(v) ? v : null; };
  CONFIG.edition = pick('edition', ['web', 'steam']) || CONFIG.edition;
  CONFIG.portal = pick('portal', ['auto', 'none', 'crazygames', 'poki', 'gd', 'adsense']) || CONFIG.portal;
  if (q.get('showWishlist') === '1') CONFIG.showWishlist = true;
  if (q.get('adEvery') && +q.get('adEvery') >= 1) { CONFIG.ads.interstitialEveryMatches = Math.round(+q.get('adEvery')); CONFIG.ads.minGapS = 0; }
  if (q.get('adTest') === '1') CONFIG.adsense.test = true;
  if (q.get('consent') === 'ask') CONFIG.consentPrompt = 'ask';
  if (q.get('gdId')) CONFIG.gd.gameId = q.get('gdId').replace(/[^\w-]/g, '');
  if (q.get('adClient') && CONFIG.adsense.test) CONFIG.adsense.client = q.get('adClient').replace(/[^\w-]/g, '');
} catch (e) { /* no location (tests) */ }
if (CONFIG.portal === 'auto') CONFIG.portal = /^ca-pub-\d+$/.test(CONFIG.adsense.client || '') ? 'adsense' : 'none';
if (CONFIG.edition === 'steam') CONFIG.portal = 'none';   // the paid build never shows ads

// The wishlist button needs a real store URL (or the explicit test switch) and the web edition.
const steamUrlReady = () => /^https:\/\/store\.steampowered\.com\/app\/\d+/.test(CONFIG.steamUrl || '');
const wishlistVisible = () => CONFIG.edition === 'web' && (steamUrlReady() || CONFIG.showWishlist);

export { CONFIG, STEAM_PLACEHOLDER, steamUrlReady, wishlistVisible };
