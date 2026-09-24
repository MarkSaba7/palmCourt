# Palm Court

Webcam tennis in the browser. Swing your hand (or a brightly colored paddle) at the camera and your player hits the ball. Your player runs to the ball on their own; you only swing. Play a CPU, or send a friend a link and play them online.

Everything is in `index.html`: no build step, no game server, no accounts.

## Play

- **Easiest:** double-click `play.cmd`. It starts a tiny local server with Python and opens the game at <http://localhost:8765>.
- **Or** open `index.html` directly in Chrome or Edge.

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

- **Quick:** send your friend `index.html` too. You both open it, then they type your code under **Join**.
- **Proper:** put it on GitHub Pages (free):
  1. Create a GitHub account, then a new public repository (for example `palm-court`).
  2. Upload `index.html` (Add file → Upload files → Commit).
  3. Settings → Pages → Build from branch → `main` / root → Save.
  4. After a minute it's live at `https://<your-username>.github.io/palm-court/`. Links you create from there work for anyone.

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
