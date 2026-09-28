# Palm Court

Tennis in the browser. Swing your phone like a racket, or your hand (or a brightly colored paddle) at the webcam, and your player hits the ball. Your player runs to the ball on their own; you only swing. Play a CPU, or send a friend a link and play them online.

It's a static website: the landing and content pages at the root (`index.html`, `how-to-play.html`, `faq.html`, …), the game in `play/index.html` plus the `src/` modules, and the phone racket page `controller.html`. No build step, no game server, no accounts.

## Play

- **Easiest:** double-click `play.cmd`. It starts a tiny local server with Python and opens the game at <http://localhost:8765/play/>.
- **Or** play it online once it's on GitHub Pages (see below). Opening `play/index.html` straight from a folder doesn't work: browsers block the game's modules on `file://` pages.

Pick your controls in the menu (**Phone**, **Hand cam**, **Paddle cam** or **Mouse**; Mouse is the default), who you play as and which CPU pro you face, then **Practice vs CPU**.

The browser will ask for the camera the first time you choose **Hand cam** or **Paddle cam**. Without a camera (or if you block it) the game says why and uses the mouse. The hand tracker (about 8 MB) downloads on first use, then your browser caches it.

### Phone racket

Choose **Phone**, then **Practice vs CPU** (or **Connect phone**): the game shows a QR code and a 5-letter code. Scan it with the phone, tap **Start** there, then swing a forehand and a backhand so the phone learns which is which (or tap Skip). The phone must be able to open the page over https: with `play.cmd` it's on the same Wi-Fi as the PC (accept the certificate warning once); on GitHub Pages it works from anywhere and links through PeerJS. Lift the phone (or tap **Toss** on it) to toss when you serve.

The racket page is an installable app, **Palm Court Racket**: open it once from the site's address (GitHub Pages, https), then on Android tap **Install** on the card it shows (or ⋮ → Install app), on iPhone tap **Share → Add to Home Screen**. It opens full screen, starts instantly (its service worker, `racket-sw.js`, keeps only the racket page's shell and only looks after `controller.html`), remembers your last game for a one-tap **Reconnect**, keeps the screen awake while you play, and reconnects by itself when the phone locks or the Wi-Fi drops. On the phone you also get the score, whose serve it is, the link and its lag, **Pause**, **Rematch**, **Swap FH/BH**, the game's read of each hit, and settings for sunlight (high contrast), large text, reduced motion and vibration. Changed the racket's page, manifest or icons? Bump `VERSION` in `racket-sw.js`: an installed phone then switches to the new version as it opens (without a bump it still gets a changed page, one launch later). (Pages from `play.cmd` use a self-signed certificate, so phones won't install them as an app; they still work in the browser.)

Swing the phone like a racket. Power is relative to your own usual swing (it learns it from your first few hits): swing harder than usual for pace, softer for a rally ball. Low to high adds topspin, high to low slices, and a soft swing coming down is a drop shot. Direction is read at the moment of contact, so nothing waits for your follow-through: sweep across your body for cross-court, a shorter push toward the screen for straight. Timing nudges it too (early pulls the ball across, late pushes it the other way). With an older phone page that doesn't send the turn of the phone, timing alone aims.

### Camera controls

| You do | What happens |
| --- | --- |
| Swing your hand across your body | Forehand or backhand, whichever side the ball is on |
| Keep sweeping across your body after the hit | Cross-court: a right-hander's forehand goes left, the backhand right. Sweep on further and harder for a sharper angle, near the line (riskier) |
| Stop the sideways sweep after the hit and finish toward the screen | Straight ahead: through the middle, or down the line from a corner |
| Swing early / late | Pulls the ball a little across / pushes it a little the other way |
| Swing low to high | Topspin, more the steeper you swing. A level swing is flat |
| Swing high to low | Slice: stays low |
| Swing softly, coming down (or stop a soft swing short) | Drop shot. A soft level or rising swing is just a soft ball |
| Swing faster | Hits harder. Your usual swing is a solid rally ball; about 40% faster is flat out, which misses more often |
| Raise your hand above the dashed toss line | Tosses the ball when you serve. Swing to hit it; your hand's left/right position aims the serve |

After every shot the bar under the court says what the game read, for example **On time · ← Cross · topspin · 118 km/h**, so you can see what your swing did. On time with a normal swing lands in nearly every time; misses come from mistiming, hard pressure, flat-out swings and going for the lines.

No camera? Pick **Mouse** (the default): click (or tap) to swing. Flick the mouse just before clicking: a faster flick hits harder, up adds topspin, down slices, left or right aims that way, and a gentle downward flick plays a drop shot. Keyboard: Space swings (Shift+Space harder), hold ← or → to aim, ↑ for topspin, S slices, D plays a drop shot. Press C to switch between the player camera and the TV camera, and Esc to pause.

Use **Camera check** first. It lists every swing it sees (FH or BH, speed, and how far behind the camera it was), dims the wind-ups it ignores, and asks for a forehand, then a backhand, so you can see both register. It lets you adjust:

- **Sensitivity:** raise it if your swings don't register, lower it if random movement triggers swings. The red mark on the speed bar is the speed a swing needs; it rises by itself when tracking is jittery (usually dim light).
- **Timing offset:** webcam delay compensation. If you keep hitting late, raise it.

Taking the racket back before a swing is fine: a swing the other way before the ball arrives counts as the wind-up, not a miss. Near the ball, any swing plays the stroke the ball needs (the screen shows which, with an arrow for the way to swing, and lights up when it's time).

For **Paddle** mode, hold the paddle's face in the circle and press **Lock paddle color**. Red or blue rubber tracks well; black rubber doesn't. In the camera check the paddle turns yellow; red patches elsewhere are things in the room with the same color, so move them out of view.

### If it feels laggy

- **Check the numbers.** Press **F** during a match to see the frame rate. Press **Esc** for more detail: fps, render resolution, which graphics chip is drawing, and how fast hand tracking runs.
- **A red warning on the main menu** means your browser is drawing 3D without your graphics card. In Chrome or Edge, open Settings → System, turn on "Use graphics acceleration when available", then press Relaunch. To confirm, open `chrome://gpu` and look for "WebGL: Hardware accelerated".
- **Set Graphics to Low** in the menu. **Auto** already lowers the resolution when frames get slow.
- **Close heavy apps and tabs**, especially video calls. Only one app can use the webcam at a time.
- **Laptop with two graphics chips?** In Windows Settings → System → Display → Graphics, add your browser and set it to High performance.

- **Phone racket feels late?** The chip at the top of the screen (and the Esc panel) says how the phone is linked and its round trip, e.g. "Phone: Wi-Fi direct, 18 ms". Fastest is `play.cmd` with the phone on the same Wi-Fi as the PC ("Wi-Fi via play.cmd"). "TURN relay" means the link goes through a server on the internet: put both on the same Wi-Fi (not a guest network). The phone sends each swing a few hundredths of a second after its fastest point and keeps its Wi-Fi awake during a match; `node test/racket.test.mjs` checks that timing without a phone.

Webcam controls always trail your real hand by a few hundredths of a second. Scoring compensates, because a late-detected swing counts from when the camera saw it. The on-screen swing still starts a moment after yours. Camera swing detection lives in `src/camswing.js`; `node test/camswing.test.mjs` runs it against simulated swings (forehands, backhands, wind-ups, dropped frames, blur, glitches) with no webcam.

## Play a friend online

1. Click **Play a friend online → Create a match link**.
2. Send your friend the link (or just the 5-letter code).
3. When they join, click **Start match**. The host's surface and match length are used.

The two browsers connect directly (WebRTC via [PeerJS](https://peerjs.com)). PeerJS's free public server only introduces them. Each player's own swings are judged on their own machine, so your timing never waits on the network. Whoever the ball is travelling towards makes the line call and sends the score.

**The link only works if the game is on the web.** A link to a file on your computer won't open on your friend's machine. Options:

- **Quick:** send your friend the whole Palm Court folder. You both start it with `play.cmd`, then they type your code under **Join**.
- **Proper:** put it on GitHub Pages (free). The repository already has a workflow (`.github/workflows/pages.yml`) that publishes the game on every push to `main`:
  1. Push this folder to a public GitHub repository (all of it: the game needs `play/`, `src/` and `controller.html`, and the website adds the root pages and `site/`).
  2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
  3. Push to `main` (or open the Actions tab → Deploy to GitHub Pages → Run workflow).
  4. After a minute it's live at `https://<your-username>.github.io/<repository>/` (the landing page; the game is at `…/play/`). Links you create from there work for anyone, and the phone racket works there too (open the phone link the game shows). Old `…/?join=CODE` links forward to `…/play/?join=CODE`.

**Own domain, AdSense, search engines:** see [docs/PUBLISHING.md](docs/PUBLISHING.md). The website's settings (domain, contact email, Steam link) are in `site/config.mjs`; `tools/build-site.mjs` fills them in when the workflow publishes.

## Publishing

Every release setting is in `src/config.js`. There is one build for every edition; you change the config, not the code.

| Setting | What it does |
| --- | --- |
| `edition` | `'web'`: free, with ads and a **Wishlist on Steam** button. `'steam'`: the paid build, with no ads and no wishlist button. |
| `portal` | Which ad SDK to load: `'auto'` (the default), `'none'`, `'crazygames'`, `'poki'`, `'gd'` (GameDistribution) or `'adsense'` (Google H5 Games Ads). `'auto'` uses AdSense on the web edition once `adsense.client` is set, and otherwise shows no ads. The page only loads the SDK you pick. |
| `steamUrl` | Your Steam store page, e.g. `https://store.steampowered.com/app/1234560/Palm_Court/`. While it still holds the `YOUR_APP_ID` placeholder, the wishlist buttons (main menu and match-over screen) stay hidden. |
| `ads` | `interstitialEveryMatches` (default 2) and `minGapS` (150) pace the breaks. `rewardedDoubleFuzz` turns the optional "watch an ad to double your Fuzz" offer on or off. |
| `cloud` | Supabase cloud saves. Only the publishable key goes here, never any other Supabase key. Cloud saves stay off until `enabled: true`. |

To test without editing the file, add URL parameters: `?portal=poki`, `?edition=steam`, `?showWishlist=1` (shows the wishlist button while the URL is still the placeholder), `?adEvery=1` (a break before every match after the first), `?consent=ask` (always show the ad-consent prompt), and `?adTest=1&adClient=ca-pub-…` (AdSense test ads).

**How ads behave.** A break only comes between matches: never during a match, never before the first match of a visit, and no more often than the pacing allows. During an ad the match clock, the sound and the umpire's voice pause. If an SDK is blocked (ad-blocker), fails, or never answers, the game carries on after a few seconds without the ad. The optional rewarded ad is `Platform.ads.rewarded('doubleFuzz')`, which resolves `true` only when the ad was watched to the end. `src/platform.js` also tells the portal when play starts and stops, and marks big wins as "happy time" on SDKs that support it.

**Portal requirements.** These change, so check each portal's current developer docs before you submit.

- **Own domain (Google H5 Games Ads / AdSense):** your AdSense account must be approved for the H5 Games Ads (Ad Placement API) beta on your domain. Set `adsense.client: 'ca-pub-…'`. Publish `ads.txt` at the root of the domain (it already lists the publisher id; the site build adds the line if the id changes). In the EU and UK, Google expects a Google-certified consent platform. The simplest option is AdSense → Privacy & messaging → a GDPR message. Once that's live, set `consentPrompt: 'never'`. Until then, the game's own small prompt asks EU/UK players (detected from their time zone) whether ads may be personalised, and it requests non-personalised ads until the player says yes.
- **CrazyGames:** set `portal: 'crazygames'` and upload the folder as an HTML5 game. The SDK (v3) handles consent and ad pacing itself. Their QA checks the gameplay start/stop calls, which the game already makes.
- **Poki:** set `portal: 'poki'`. Poki reviews games before publishing. Their SDK handles consent and decides when a break actually shows, so `interstitialEveryMatches: 1` is fine there.
- **GameDistribution:** set `portal: 'gd'` and `gd.gameId` to the id from your GameDistribution dashboard. Their SDK handles consent.
- **External links:** the wishlist button, the Privacy page and the Credits page open in a new tab. Some portals restrict links to other stores, so read their link policy and set `showWishlist`/`steamUrl` to suit.
- **Steam:** set `edition: 'steam'`. It forces `portal: 'none'`, so there are no ads and no wishlist button.

**Legal pages.** `privacy.html` covers the camera (frames never leave the device), local save data, optional cloud saves, online play, Google's ads and cookies, and the contact address (`CONTACT_EMAIL` in `site/config.mjs`). `credits.html` lists the open-source licences (three.js MIT, MediaPipe Apache-2.0, PeerJS MIT, the fonts under OFL). Both are linked from the main menu, and the Pages workflow publishes them with the rest of the website (`about.html`, `how-to-play.html`, `faq.html`, `terms.html`, `contact.html`, `sitemap.xml`, `robots.txt`, `ads.txt`).

## What makes it realistic

- **Real court:** ITF dimensions (23.77 m × 8.23 m singles, net 0.914 m at the centre and 1.07 m at the posts, lines inside the court). A ball touching any part of a line is in.
- **Real ball physics:** 57.7 g, 6.7 cm ball with gravity, air drag and Magnus lift from spin, simulated 240 times a second. Bounces use the ITF rebound spec (a 2.54 m drop rebounds 1.36 m on hard court), plus friction that turns spin into kick or skid.
- **Three surfaces:** hard, clay (slower, higher bounce, leaves ball marks) and grass (fast, low skid).
- **Net cords:** a ball clipping the tape can dribble over or drop back. On a serve, a net cord that lands in is a let.
- **Full scoring:** deuce and advantage, service boxes, faults and double faults, lets, and tiebreaks (serve rotates every two points).
- **Match-day details:** the chair umpire calls the score, the line judge shouts "Out!", and the crowd reacts to the shot. You get serve speed, spin rpm and a timing read on every shot.

## How it's built

`play/index.html` holds the game page and its screens; the code is plain ES modules in `src/`:

| File | What's in it |
| --- | --- |
| `core.js` | Constants, ball physics (`stepBall`), path prediction, `solveShot` (the launch that lands a ball on a target at a given speed and spin), `LEVELS`, settings |
| `match.js` | Scoring, umpire calls, synthesized sound (no audio files) |
| `render/` | three.js scene: court, stadium, crowd, scenery, sky and lighting, characters and their animation, rackets, ball, cameras |
| `input.js`, `camswing.js` | Hand tracking (MediaPipe in a worker), paddle color tracking, swing detection, mouse and keyboard, all turned into swing events |
| `game.js` | Players, CPU AI, serve and rally flow, line calls, latency compensation (a late webcam swing rewinds the ball to when you actually swung) |
| `phone.js`, `controller.html` | The phone racket: the phone page detects swings itself and sends them over serve.py's Wi-Fi relay or PeerJS |
| `net.js` | Online play: PeerJS connection, clock sync, messages |
| `ui.js`, `pros.js` | Menus, pro picker, lobby, camera check, HUD |

Tuning knobs:

- `LEVELS`: CPU speed, reactions and accuracy.
- `SURFACES`: bounce and friction per surface.
- `groundShot()` / `serveShot()`: how swings turn into shots.

Libraries (loaded from jsDelivr): [three.js](https://threejs.org) 0.186, [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) 1.0.1, [PeerJS](https://peerjs.com) 1.5.5.
