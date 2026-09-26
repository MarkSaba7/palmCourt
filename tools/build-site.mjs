// Publishes the website: copies what the browser needs into one folder (default _site) and fills in the site
// settings from site/config.mjs. Environment variables with the same names override that file (the Pages workflow
// passes GitHub repository variables through). No dependencies: plain Node 18+.
//   node tools/build-site.mjs [outDir]
// Used by .github/workflows/pages.yml; Cloudflare Pages or Netlify can run the same command (docs/PUBLISHING.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from '../site/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || '_site');
// The placeholders the pages carry in the repository.
const PH = { url: 'https://palmcourt.example', email: 'hello@palmcourt.example', client: 'ca-pub-0000000000000000', slot: '0000000000', steam: 'https://store.steampowered.com/app/YOUR_APP_ID/Palm_Court/' };
const setting = (k) => (process.env[k] || '').trim() || String(cfg[k] || '').trim();
const fail = (m) => { console.error('build-site: ' + m); process.exit(1); };

// Site address: SITE_URL, else a CNAME file in the repo root, else the GitHub Pages address (PAGES_URL, from the workflow).
let url = setting('SITE_URL').replace(/\/+$/, '');
const cnameFile = path.join(ROOT, 'CNAME');
if ((!url || url === PH.url) && fs.existsSync(cnameFile)) url = 'https://' + fs.readFileSync(cnameFile, 'utf8').trim();
if (!url || url === PH.url) url = (process.env.PAGES_URL || PH.url).trim().replace(/\/+$/, '');
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(url)) fail(`SITE_URL "${url}" is not an address like https://palmcourt.com`);
const host = new URL(url).hostname, custom = url !== PH.url && !/\.github\.io$/i.test(host);   // PAGES_URL is the custom domain once one is set in Settings → Pages

const client = setting('ADSENSE_CLIENT'), ads = /^ca-pub-\d{16}$/.test(client) && client !== PH.client;
if (client && client !== PH.client && !ads) fail(`ADSENSE_CLIENT "${client}" should look like ca-pub-1234567890123456`);
const slot = setting('AD_SLOT'), slotOk = ads && /^\d{6,}$/.test(slot);
const email = setting('CONTACT_EMAIL') || PH.email;
const steam = setting('STEAM_URL');
if (steam && !/^https:\/\/store\.steampowered\.com\/app\/\d+/.test(steam)) fail(`STEAM_URL "${steam}" should be a store.steampowered.com/app/… address`);

// What the browser needs: the pages, the game (play/ + src/), the phone racket page and the site assets.
// Never serve.py, tests, docs, tools, notes or the legacy single-file build.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const rootFiles = fs.readdirSync(ROOT).filter((f) => /\.(html|xml|txt|webmanifest|ico)$/.test(f) && !/^(README|LICENSE)/i.test(f));
for (const f of rootFiles) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
for (const d of ['play', 'src', 'site']) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true, filter: (s) => !/(^|[\\/])\.|config\.mjs$/.test(path.relative(ROOT, s)) });
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Fill in the settings in every page and text file (not in src/: the game's own settings live in src/config.js).
const adTag = `<meta name="google-adsense-account" content="${client}">\n<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}" crossorigin="anonymous"></script>`;
const texts = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (p !== path.join(OUT, 'src')) walk(p); } else if (/\.(html|xml|txt|webmanifest|svg)$/.test(e.name)) texts.push(p); } };
walk(OUT);
let adPages = 0;
for (const f of texts) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s;
  s = s.split(PH.email).join(email).split(PH.url).join(url);
  if (steam) s = s.split(PH.steam).join(steam);
  if (ads) {
    if (s.includes('<!-- adsense -->')) { s = s.replace('<!-- adsense -->', adTag); adPages++; }
    s = s.split(`data-ad-client="${PH.client}"`).join(`data-ad-client="${client}"`);
    if (slotOk) s = s.split(`data-ad-slot="${PH.slot}"`).join(`data-ad-slot="${slot}"`);
  }
  if (s !== before) fs.writeFileSync(f, s);
}

// ads.txt: the template stays commented until there's a publisher id; then Google is authorised as a direct seller.
const adsTxt = path.join(OUT, 'ads.txt');
if (ads) fs.appendFileSync(adsTxt, `google.com, ${client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);

// Custom domain: GitHub reads it from Settings → Pages (a CNAME file is ignored by Actions deployments, but it
// documents the domain in the published site and other hosts or a branch deployment can use it).
if (custom) fs.writeFileSync(path.join(OUT, 'CNAME'), host + '\n');

const left = texts.filter((f) => /https:\/\/palmcourt\.example|@palmcourt\.example/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(OUT, f));
console.log(`build-site: ${OUT}\n  site ${url}${custom ? ' (custom domain)' : ' (no domain yet)'}\n  ads ${ads ? `on, ${client}, ${adPages} pages, ${slotOk ? 'slot ' + slot : 'no fixed slot'}` : 'off'}\n  contact ${email}${email === PH.email ? ' (placeholder)' : ''}\n  steam ${steam || 'coming soon'}\n  CNAME ${fs.existsSync(path.join(OUT, 'CNAME')) ? host : 'none'}`);
if (left.length && url !== PH.url) console.log('  note: still mentions palmcourt.example: ' + left.join(', '));
