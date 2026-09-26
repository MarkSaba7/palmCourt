// Palm Court website settings: the ONE place to fill in when the domain and the AdSense account exist.
// The pages keep the placeholder values below in their source; tools/build-site.mjs (run by the GitHub Pages
// workflow) swaps them for these settings when it publishes. A GitHub repository variable with the same name
// (Settings → Secrets and variables → Actions → Variables) overrides the value here. See docs/PUBLISHING.md.

// Your domain, https, no trailing slash, e.g. 'https://palmcourt.com'. While it's the placeholder, the site is
// published under its GitHub Pages address instead (and no CNAME file is written).
export const SITE_URL = 'https://palmcourt.example';

// AdSense publisher id, 'ca-pub-' + 16 digits. While it's the placeholder there are no ads, no AdSense tag and
// ads.txt stays a commented template. In-game ads (Google H5 Games Ads) are configured in src/config.js.
export const ADSENSE_CLIENT = 'ca-pub-0000000000000000';

// Optional: a display ad unit id (AdSense → Ads → By ad unit → Display ads → the data-ad-slot number). Empty = no
// fixed ad boxes on the content pages; Auto ads (switched on in the AdSense console) still work with just the tag.
export const AD_SLOT = '';

// Where players and Google can reach you (privacy policy, contact and terms pages).
export const CONTACT_EMAIL = 'hello@palmcourt.example';

// The Steam store page, once it exists ('https://store.steampowered.com/app/<id>/Palm_Court/'). Empty = the
// "Wishlist on Steam" buttons say "coming soon" instead.
export const STEAM_URL = '';
