// Palm Court website: small touches on the content pages. Every page works without this script.
(() => {
  // Ad boxes: filled only when the AdSense tag is on the page (the deploy step adds it once site/config.mjs has a real
  // publisher id) and the box has a real ad unit id. Otherwise the empty box goes, so nothing shows a blank space.
  const tag = document.querySelector('script[src*="adsbygoogle.js"]');
  for (const ins of document.querySelectorAll('ins.adsbygoogle')) {
    const ok = tag && /^ca-pub-\d{16}$/.test(ins.dataset.adClient || '') && !/^0+$/.test(ins.dataset.adClient.slice(7)) && /^\d{6,}$/.test(ins.dataset.adSlot || '') && !/^0+$/.test(ins.dataset.adSlot);
    const box = ins.closest('.ad') || ins;
    if (!ok) { box.remove(); continue; }
    box.hidden = false;   // boxes start hidden so a page without ads (or without scripts) never shows an empty one
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* blocked by the browser: leave the box empty */ }
  }
  // Steam: until the store page exists (STEAM_URL in site/config.mjs), the wishlist buttons say so instead of linking.
  for (const a of document.querySelectorAll('a[data-steam]')) {
    if (!/YOUR_APP_ID/.test(a.getAttribute('href') || '')) continue;
    a.removeAttribute('href');
    a.setAttribute('aria-disabled', 'true');
    const label = a.querySelector('span') || a;
    label.textContent = 'Steam page coming soon';
  }
  // Old share links (…/?join=CODE) are handled in the landing page's head; this keeps the year in the footer current.
  for (const y of document.querySelectorAll('[data-year]')) y.textContent = new Date().getFullYear();
})();
