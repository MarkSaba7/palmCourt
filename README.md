# Palm Court

Webcam tennis in the browser. Swing your hand (or a brightly colored paddle) at the camera and your player hits the ball. Your player runs to the ball on their own; you only swing. Play a CPU, or send a friend a link and play them online.

It's a static web page (`index.html` plus the `src/` modules): no build step, no game server, no accounts.

## Play

- **Easiest:** double-click `play.cmd`. It starts a tiny local server with Python and opens the game at <http://localhost:8765>.
- **Or** play it online once it's on GitHub Pages (see below). Opening `index.html` straight from a folder doesn't work: browsers block the game's modules on `file://` pages.

The browser will ask for the camera the first time you choose **Hand** or **Paddle** controls. The hand tracker (about 8 MB) downloads on first use, then your browser caches it.

### Controls

| You do | What happens |
| --- | --- |
| Swing your hand across your body | Forehand or backhand, whichever side the ball is on |
| Swing early / on time / late | Pulls the ball / hits it through the middle / pushes it the other way |
| Swing low to high | Topspin: dips, kicks up, safer |
| Swing high to low | Slice: stays low. A slow slice is a drop shot |
| Swing faster | Hits harder, and misses more often |
| Raise your hand above the dashed toss line | Tosses the ball when you serve. Swing to hit it; your hand's left/right position aims the serve |

No camera? Pick **Mouse**: click (or tap) to swing and flick before clicking for power. Keyboard: Space swings, Shift+Space hits harder, S slices. Press C to switch between the player camera and the TV camera, and Esc to pause.

Use **Camera check** first. It lists every swing it sees (FH or BH, speed, and how far behind the camera it was), dims the wind-ups it ignores, and asks for a forehand, then a backhand, so you can see both register. It lets you adjust:

- **Sensitivity:** raise it if your swings don't register, lower it if random movement triggers swings. The red mark on the speed bar is the speed a swing needs; it rises by itself when tracking is jittery (usually dim light).
- **Timing offset:** webcam delay compensation. If you keep hitting late, raise it.

Taking the racket back before a swing is fine: a swing the other way before the ball arrives counts as the wind-up, not a miss. Near the ball, any swing plays the stroke the ball needs (the screen shows which, with an arrow for the way to swing, and lights up when it's time).

For **Paddle** mode, hold the paddle's face in the circle and press **Lock paddle color**. Red or blue rubber tracks well; black rubber doesn't. In the camera check the paddle turns yellow; red patches elsewhere are things in the room with the same color, so move them out of view.

### If it feels laggy

- **Check the numbers.** Press **F** during a match to see the frame rate. Press **Esc** for more detail: fps, render resolution, which graphics chip is drawing, and how fast hand tracking runs.
- **A red warning on the main menu** means your browser is drawing 3D without your graphics card. In Chrome or Edge, open Settings → System, turn on "Use graphics acceleration when available", then press Relaunch. To confirm, open `chrome://gpu` and look for "WebGL: Hardware accelerated".
- **Set Graphics to Fast** in the menu. **Auto** already lowers the resolution when frames get slow.
- **Close heavy apps and tabs**, especially video calls. Only one app can use the webcam at a time.
- **Laptop with two graphics chips?** In Windows Settings → System → Display → Graphics, add your browser and set it to High performance.

Webcam controls always trail your real hand by a few hundredths of a second. Scoring compensates, because a late-detected swing counts from when the camera saw it. The on-screen swing still starts a moment after yours. Camera swing detection lives in `src/camswing.js`; `node test/camswing.test.mjs` runs it against simulated swings (forehands, backhands, wind-ups, dropped frames, blur, glitches) with no webcam.

## Play a friend online

1. Click **Play a friend online → Create a match link**.
2. Send your friend the link (or just the 5-letter code).
3. When they join, click **Start match**. The host's surface and match length are used.

The two browsers connect directly (WebRTC via [PeerJS](https://peerjs.com)). PeerJS's free public server only introduces them. Each player's own swings are judged on their own machine, so your timing never waits on the network. Whoever the ball is travelling towards makes the line call and sends the score.

**The link only works if the game is on the web.** A link to a file on your computer won't open on your friend's machine. Options:

- **Quick:** send your friend the whole Palm Court folder. You both start it with `play.cmd`, then they type your code under **Join**.
- **Proper:** put it on GitHub Pages (free). The repository already has a workflow (`.github/workflows/pages.yml`) that publishes the game on every push to `main`:
  1. Push this folder to a public GitHub repository (all of it: the game is `index.html`, `controller.html` and the `src/` folder, not `index.html` alone).
  2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
  3. Push to `main` (or open the Actions tab → Deploy to GitHub Pages → Run workflow).
  4. After a minute it's live at `https://<your-username>.github.io/<repository>/`. Links you create from there work for anyone, and the phone racket works there too (open the phone link the game shows).

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

- **Own domain (Google H5 Games Ads / AdSense):** your AdSense account must be approved for the H5 Games Ads (Ad Placement API) beta on your domain. Set `adsense.client: 'ca-pub-…'`. Publish `ads.txt` at the root of the domain: fill in the template in this repository and uncomment its line. In the EU and UK, Google expects a Google-certified consent platform. The simplest option is AdSense → Privacy & messaging → a GDPR message. Once that's live, set `consentPrompt: 'never'`. Until then, the game's own small prompt asks EU/UK players (detected from their time zone) whether ads may be personalised, and it requests non-personalised ads until the player says yes.
- **CrazyGames:** set `portal: 'crazygames'` and upload the folder as an HTML5 game. The SDK (v3) handles consent and ad pacing itself. Their QA checks the gameplay start/stop calls, which the game already makes.
- **Poki:** set `portal: 'poki'`. Poki reviews games before publishing. Their SDK handles consent and decides when a break actually shows, so `interstitialEveryMatches: 1` is fine there.
- **GameDistribution:** set `portal: 'gd'` and `gd.gameId` to the id from your GameDistribution dashboard. Their SDK handles consent.
- **External links:** the wishlist button, the Privacy page and the Credits page open in a new tab. Some portals restrict links to other stores, so read their link policy and set `showWishlist`/`steamUrl` to suit.
- **Steam:** set `edition: 'steam'`. It forces `portal: 'none'`, so there are no ads and no wishlist button.

**Legal pages.** `privacy.html` covers the camera (frames never leave the device), local save data, online play, what the ad partners may collect, and a contact placeholder (fill in `[contact email]` before you publish). `credits.html` lists the open-source licences (three.js MIT, MediaPipe Apache-2.0, PeerJS MIT, the fonts under OFL). Both are linked from the main menu, and the Pages workflow publishes them with `ads.txt`.

## What makes it realistic

- **Real court:** ITF dimensions (23.77 m × 8.23 m singles, net 0.914 m at the centre and 1.07 m at the posts, lines inside the court). A ball touching any part of a line is in.
- **Real ball physics:** 57.7 g, 6.7 cm ball with gravity, air drag and Magnus lift from spin, simulated 240 times a second. Bounces use the ITF rebound spec (a 2.54 m drop rebounds 1.36 m on hard court), plus friction that turns spin into kick or skid.
- **Three surfaces:** hard, clay (slower, higher bounce, leaves ball marks) and grass (fast, low skid).
- **Net cords:** a ball clipping the tape can dribble over or drop back. On a serve, a net cord that lands in is a let.
- **Full scoring:** deuce and advantage, service boxes, faults and double faults, lets, and tiebreaks (serve rotates every two points).
- **Match-day details:** the chair umpire calls the score, the line judge shouts "Out!", and the crowd reacts to the shot. You get serve speed, spin rpm and a timing read on every shot.

## How it's built

`index.html` is organised in sections:

| Section | What's in it |
| --- | --- |
| CORE | Constants, ball physics (`stepBall`), path prediction, and `solveShot`, which finds the launch angle that lands a ball on a target at a given speed and spin |
| MATCH | Scoring, umpire calls, synthesized sound (no audio files) |
| WORLD | three.js scene: court textures, lines, net, stadium, crowd, palms |
| ACTORS | Jointed player figures with forehand, backhand, serve and running animations; ball, shadow, trail; cameras |
| INPUT | MediaPipe hand tracking (in a background worker thread), paddle color tracking, mouse and keyboard, all turned into swing events |
| GAME | Players, CPU AI, serve and rally flow, line calls, and latency compensation (a late webcam swing rewinds the ball to when you actually swung) |
| NET | PeerJS connection, clock sync, messages |
| UI | Menus, lobby, camera check, HUD, main loop |

Tuning knobs:

- `LEVELS`: CPU speed, reactions and accuracy.
- `SURFACES`: bounce and friction per surface.
- `groundShot()` / `serveShot()`: how swings turn into shots.

Libraries (loaded from jsDelivr): [three.js](https://threejs.org) 0.186, [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) 1.0.1, [PeerJS](https://peerjs.com) 1.5.5.
