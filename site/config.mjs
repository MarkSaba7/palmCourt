// Palm Court website settings: the ONE place to fill in when the domain and the AdSense account exist.
// The pages keep the placeholder values below in their source; tools/build-site.mjs (run by the GitHub Pages
// workflow) swaps them for these settings when it publishes. A GitHub repository variable with the same name
// (Settings → Secrets and variables → Actions → Variables) overrides the value here. See docs/PUBLISHING.md.

// Your domain, https, no trailing slash, e.g. 'https://palmcourt.com'. While it's the placeholder, the site is
// published under its GitHub Pages address instead (and no CNAME file is written).
export const SITE_URL = 'https://palmcourt.example';

// AdSense publisher id, 'ca-pub-' + 16 digits. Empty = the game's id (CONFIG.adsense.client in src/config.js), so
// the website and the in-game ads share one id. The AdSense tag is only written on a real domain: the github.io
// preview and the placeholder address never carry ads.
export const ADSENSE_CLIENT = '';

// Optional: a display ad unit id (AdSense → Ads → By ad unit → Display ads → the data-ad-slot number). Empty = no
// fixed ad boxes on the content pages; Auto ads (switched on in the AdSense console) still work with just the tag.
export const AD_SLOT = '';

// Where players and Google can reach you (privacy policy, contact and terms pages).
export const CONTACT_EMAIL = 'palmcourt.game@gmail.com';

// The Steam store page, once it exists ('https://store.steampowered.com/app/<id>/Palm_Court/'). Empty = the
// "Wishlist on Steam" buttons say "coming soon" instead.
export const STEAM_URL = '';
