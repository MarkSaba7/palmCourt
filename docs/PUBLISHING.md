# Publishing Palm Court on your own domain

This is the owner's checklist for taking the free browser version live on its own domain with Google AdSense. All
the code is ready: going live needs only the **domain name** (plus a **contact email**). The AdSense publisher id
(`ca-pub-6534034175572614`) is already set.

## What's where

| URL | File | Notes |
| --- | --- | --- |
| `/` | `index.html` | Landing page: hero, controls, features, the pros, FAQ, Steam call to action. Old `/?join=CODE` links forward to `/play/?join=CODE`. |
| `/play/` | `play/index.html` + `src/` | The game. Never carries display ads; in-game ads go through `src/platform.js` (H5 Games Ads). |
| `/how-to-play.html`, `/faq.html`, `/about.html` | | The content AdSense reviewers look for. One ad box each once ads are on. |
| `/privacy.html`, `/terms.html`, `/contact.html`, `/credits.html` | | Legal pages, linked from every footer and from the game menu. |
| `/404.html` | | Served by the host for any missing page. |
| `/sitemap.xml`, `/robots.txt`, `/ads.txt`, `/manifest.webmanifest` | | `ads.txt` already lists `pub-6534034175572614`. |
| `/controller.html` | | The phone racket page (unchanged). |

**Settings, in one place:** `site/config.mjs`.

- `SITE_URL`: your domain, e.g. `https://palmcourt.me`. It's a placeholder (`https://palmcourt.example`) until you
  have one.
- `CONTACT_EMAIL`: shown on the privacy, terms and contact pages.
- `ADSENSE_CLIENT`: empty means "use the game's id" from `src/config.js`.
- `AD_SLOT`: optional, see step 5.
- `STEAM_URL`: the store page, once it exists. Until then the wishlist buttons say "Steam page coming soon".

The pages keep the placeholders in the repository. When the site is published, `tools/build-site.mjs` copies it to
`_site/` and fills the settings in: canonical and social-card URLs, the sitemap, the AdSense tag, `ads.txt` and a
`CNAME` file. A hosting variable with the same name (for example `SITE_URL`) overrides the file. Try it locally with
`node tools/build-site.mjs` and look in `_site/`.

**Ads switch on only on a real domain.** On the github.io preview, and while `SITE_URL` is the placeholder, the
pages carry no AdSense tag and no ad boxes.

## 1. Get the domain

- **GitHub Student Developer Pack (free first year).** The pack offers, for example, a free `.me` from Namecheap
  and a free `.tech` from get.tech (check education.github.com/pack for the current offers). Look up the
  **renewal price** before you choose: some endings cost much more from year two (`.tech` especially).
- **Moving domains later is costly.** AdSense approval, Search Console history and every shared link are tied to
  the domain. Pick one you'll keep. A `.com` costs about $10 a year at cost price from Cloudflare Registrar,
  Porkbun or Namecheap.
- **Name ideas:** `palmcourt.me`, `playpalmcourt.com`, `palmcourtgame.com`, `palmcourt.tech`.
- **Contact email:** at the domain, e.g. `hello@yourdomain`. Cloudflare Email Routing (free) or Namecheap's email
  forwarding can forward it to your Gmail. Then set `CONTACT_EMAIL`.

## 2. Hosting: Cloudflare Pages (recommended once the site earns money)

GitHub Pages is fine for now. However, GitHub's terms say Pages isn't meant for running an online business, so move
to **Cloudflare Pages** once ads bring in money (or right away). It's free, has no bandwidth limit for static files,
and serves from a global CDN. The site builds there with the same command.

1. Create a free account at dash.cloudflare.com.
2. **Add the domain to Cloudflare:** *Add a domain* → enter it → Free plan. Cloudflare shows two nameservers. At
   your registrar (Namecheap / get.tech), replace the domain's nameservers with those two. It becomes *Active*
   within minutes to a few hours. If you buy the domain from Cloudflare Registrar, it's already there.
3. **Create the Pages project:** *Workers & Pages* → *Create* → the **Pages** tab → *Import an existing Git
   repository* (called *Connect to Git* in some versions of the dashboard) → authorise GitHub → pick
   `MarkSaba7/palmCourt`.
4. **Build settings:**
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: `node tools/build-site.mjs _site`
   - Build output directory: `_site`
   - Root directory: leave empty
   - Environment variables (Production): `SITE_URL` = `https://yourdomain` and `NODE_VERSION` = `22`. Optionally
     add `CONTACT_EMAIL` too, or set it in `site/config.mjs`.
5. *Save and Deploy*. The first build takes about a minute, and the site appears at
   `https://<project>.pages.dev`. Check `/`, `/play/` and `/ads.txt` there.
6. **Custom domain:** the project → *Custom domains* → *Set up a custom domain* → enter the apex (`yourdomain`) →
   *Activate domain*. Cloudflare adds the DNS record and the HTTPS certificate itself. Repeat for `www.yourdomain`.
   Then send `www` to the apex: the domain → *Rules* → *Redirect Rules* → the template *Redirect from WWW to root*.
7. The domain → *SSL/TLS* → *Edge Certificates* → turn on *Always Use HTTPS*. Leave *Bot Fight Mode* off, because
   it can get in the way of Google's crawlers.
8. From then on, every push to `main` redeploys automatically. Stop the GitHub Pages copy: repository *Settings* →
   *Pages* → *Unpublish site*, and disable the *Deploy to GitHub Pages* workflow (*Actions* → the workflow → ⋯ →
   *Disable workflow*).

**Netlify** (alternative): *Add new site* → *Import from Git* → the repository. Use the same build command and
`_site` as the publish directory, and add the `SITE_URL` environment variable. For DNS, point the apex at Netlify's
load balancer (A record `75.2.60.5`) and `www` at a CNAME `<site>.netlify.app`, or use Netlify DNS.

## 2b. Or stay on GitHub Pages for now

1. Repository *Settings* → *Pages* → *Custom domain*: enter `yourdomain` → *Save*. (Deploys from Actions ignore a
   `CNAME` file, so this setting is what counts. The build still writes one.)
2. At your DNS provider:

   | Type | Name | Value |
   | --- | --- | --- |
   | A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (four records) |
   | AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
   | CNAME | `www` | `marksaba7.github.io` |

3. Protect the domain from takeover: your GitHub account *Settings* → *Pages* → *Add a domain*, then add the TXT
   record it shows (`_github-pages-challenge-MarkSaba7`).
4. When the certificate is ready (minutes, up to a day), tick *Enforce HTTPS*.
5. Set `SITE_URL` in `site/config.mjs`, or as a repository variable: *Settings* → *Secrets and variables* →
   *Actions* → *Variables* → `SITE_URL`. Then re-run the *Deploy to GitHub Pages* workflow. If you leave `SITE_URL`
   unset, the workflow uses the domain from step 1 anyway.

## 3. Check the live site

- `https://yourdomain/` shows the landing page and `https://yourdomain/play/` shows the game.
- *Create a match link* in the game gives `https://yourdomain/play/?join=XXXXX`. The phone QR opens
  `https://yourdomain/controller.html`.
- `https://yourdomain/ads.txt` shows the `google.com, pub-6534034175572614, …` line.
- View the source of `/`: the `canonical` link uses your domain, and the `adsbygoogle.js?client=ca-pub-…` tag is
  in the `<head>`.
- Paste the URL into a link preview (Slack, WhatsApp, X): the card shows the court image.

## 4. Google Search Console

1. search.google.com/search-console → *Add property* → **Domain** → enter `yourdomain` → add the TXT record it
   gives you at your DNS provider → *Verify*.
2. *Sitemaps* → submit `sitemap.xml`.
3. *URL inspection* → `https://yourdomain/` → *Request indexing*. Do the same for `/play/` and
   `/how-to-play.html`.
4. Optional: Bing Webmaster Tools → *Import from Google Search Console*.

## 5. AdSense (website ads)

**What reviewers want:** you're 18 or older and own the site, the content is original and useful (the landing
page, How to play, FAQ and About), the site is easy to navigate, and it has a privacy policy (the site has all of
these). There's no official traffic minimum, but the site must be finished and reachable. In some regions AdSense
has required a site to be live for a few months. If a review says the site isn't ready, add content, wait a few
weeks and apply again. A github.io address can't be approved; the domain can.

1. Before applying, fill in `CONTACT_EMAIL` and add your name (or studio name) as the operator in `privacy.html`.
   Check the "Last updated" dates in `privacy.html` and `terms.html`.
2. adsense.google.com → *Sites* → *Add site* → `yourdomain` (the domain, no `www` or path).
3. Verify with **AdSense code snippet**: it's already in the `<head>` of every content page once the site runs on
   the domain. The ads.txt method also works. Then click *Request review*. Reviews take from a few days to a few
   weeks.
4. After approval: *Ads* → *By site* → `yourdomain` → edit:
   - Turn on **Auto ads** if you want Google to place ads on the content pages (optional; the fixed ad boxes need
     step 5).
   - Under **Page exclusions**, add `yourdomain/play/`. The game page must never get display ads over gameplay.
     In-game breaks come from H5 Games Ads (section 7).
5. Optional fixed ad boxes: *Ads* → *By ad unit* → *Display ads* → name it `Content` → *Responsive* → *Create*.
   Copy the `data-ad-slot` number into `AD_SLOT` (or a variable of that name), then redeploy. Without it the build
   removes the boxes from the published pages, and Auto ads (above) are the only website ads. One box then shows
   on the landing page, How to play, FAQ and About, labelled "Advertisement".
6. *Sites* should show **ads.txt: Authorized** within a few days.

## 6. Consent (Google's Privacy & messaging)

In the EEA, the UK and Switzerland, Google requires a Google-certified consent platform. Google's own is built into
AdSense and needs no code: the AdSense tag shows the message.

1. AdSense → *Privacy & messaging* → **European regulations** → *Create message*. Choose your site and languages,
   and keep the *Consent* and *Manage options* buttons. Adding *Do not consent* is recommended. Add the privacy
   policy URL `https://yourdomain/privacy.html` → *Publish*.
2. *Privacy & messaging* → **US state regulations** → *Create message* → *Publish* (adds the "Do not sell or share"
   link where those laws apply).
3. The game's own consent prompt (`consentPrompt` in `src/config.js`) is already `'never'`, so players are only
   asked by Google's message. Until that message is published, Google serves EEA/UK visitors limited ads only. The privacy page's *Change my cookie choices* button
   works automatically with Google's message.

## 7. H5 Games Ads (in-game ads)

In-game breaks between matches and the optional "watch an ad to double your Fuzz" use Google's H5 Games Ads (the
Ad Placement API: developers.google.com/ad-placement). They're already wired in `src/platform.js` and switch on
with the publisher id in `src/config.js`.

1. H5 Games Ads is a beta that needs approval. In AdSense Help, search for "H5 Games Ads" and fill in the interest
   form there, naming `https://yourdomain/play/` as the game. The site should be approved for AdSense first.
2. Test on the live site: `https://yourdomain/play/?adTest=1&adEvery=1` shows Google's test ads between matches.
3. The same `ads.txt` and consent message cover the game.

## 8. What to send Claude

- The **domain** (e.g. `palmcourt.me`), and whether it's hosted on Cloudflare Pages or GitHub Pages.
- The **contact email**, and the name (yours or your studio's) to show in the privacy policy.
- Optional: the **display ad slot id** (step 5.5).
- Once they exist: the **Steam store URL**, the **H5 Games Ads approval**, and whether the **Privacy & messaging**
  messages are live.

Claude then sets `SITE_URL`, `CONTACT_EMAIL`, `AD_SLOT` and `STEAM_URL` in `site/config.mjs` (and `consentPrompt` in
`src/config.js`), redeploys, and runs the site checks.
