# Webcam end-to-end rig

Repeatable tests of the webcam controls (paddle color tracking and hand tracking) against the real game in headless
Chromium, with ground truth for every frame. Nothing in `src/` is changed: the rig wraps a few `Tracker` methods from
the page to see what they saw, and drives the camera from outside.

| File | What it does |
| --- | --- |
| `scene.mjs` | Synthetic webcam: a room (window, bookshelf, optional red book), a person, an arm holding a red or blue ping-pong paddle, motion blur over the shutter time, the paddle turning edge-on in fast swings, sensor noise, a frame-counter barcode. Also scripted paths (`Script`) and synthetic MediaPipe hand landmarks. Plain JS: runs in Node and in the page. |
| `clips.mjs` | The scripted clips and their ground truth (every move with its kind, stroke, peak time and speed; toss spells). |
| `gen-video.mjs` | Writes the clips as a `.y4m` fake webcam (`suite.y4m`, all clips back to back; `--each` for one file per clip) plus `suite.json` truth. |
| `webcam-paddle.mjs` | Paddle test: camera check → lock color → every clip → metrics; then a practice match played by a coach. |
| `webcam-hand.mjs` | Hand test: (a) MediaPipe startup and per-frame cost on the fake camera; (b) synthetic hands through `Tracker.handleHands` → metrics; then a practice match. |
| `live.mjs` | Browser side: recorder, direct camera, lockstep player, live camera, MediaPipe stand-in, practice coach. |
| `lib.mjs` | Launcher, Playwright lookup, analysis and report. |

## Run

    # in the sandbox (shared harness: CDN mirror + browser slots)
    H=/tmp/claude-0/-home-user-palmCourt/<session>/scratchpad/harness/pc.mjs
    node tests/e2e/webcam-paddle.mjs --harness $H --port 8806            # ~2-4 min
    node tests/e2e/webcam-hand.mjs   --harness $H --port 8806            # ~2-3 min
    # on a normal machine with Playwright installed (npm i -g playwright; npx playwright install chromium)
    node tests/e2e/webcam-paddle.mjs
    # real-time fake webcam from a video file (needs the video first: ~50 s, ~690 MB, kept out of git in out/)
    node tests/e2e/gen-video.mjs --out tests/e2e/out
    node tests/e2e/webcam-paddle.mjs --mode video --video tests/e2e/out

Useful options: `--root <checkout>` (test another worktree), `--port`, `--json results.json`, `--aux` (also list
wind-up / recovery detections), `--no-suite`, `--no-practice`, `--points N`, `--sens 1.3`, `--render` (keep the game
drawing; by default drawing is stopped so the camera callbacks get the CPU, the match logic keeps running).
Hand: `--no-model`, `--no-inject`, `--main` (force the main-thread MediaPipe fallback), `--secs 10`, `--clips a,b`,
`--proc 28 --procsd 6 --arrive 30` (model time and camera-to-page delay, ms), `--no-offhand`, `--flip 0.02`.
Playwright is found in this repo, the current directory, `$PLAYWRIGHT_MODULE` or the global npm root. Offline machines:
`--cdn <node_modules with three, @mediapipe/tasks-vision, peerjs>` and `--model hand_landmarker.task`.

### Modes

- **Paddle `--mode lockstep`** (default): each frame is drawn in the page and handed to the real `Tracker.process`
  (color tracker → `SwingDetector` → `Input` events) with an exact 30 fps capture time. Every frame is processed however
  slow the machine is, so the numbers are about the code and are repeatable. Latency = frames the detector needed +
  the real time this machine spent tracking that frame; a real webcam adds its own 40-100 ms before the page sees a
  frame (what `Settings.latency` is for).
- **Paddle `--mode video`**: `suite.y4m` is Chromium's fake webcam (`--use-file-for-fake-video-capture`), in real
  time: getUserMedia, the `<video>`, `requestVideoFrameCallback` capture times and dropped frames included. The page
  finds which frame it is looking at from the barcode. On a loaded or GPU-less machine this mostly measures the machine.
- **Practice `--cam direct`** (default): the coach's paddle is drawn 30 times a second and processed at once;
  `--cam stream` goes through a canvas `MediaStream` and the `<video>` element instead.
- **Hand (b)**: frames every 33 ms; like the worker, the stand-in takes a frame only when it is free, answers after
  `--proc` ms, loses the hand in fast motion (blur), sometimes mislabels it, and shows the other hand.

## The clips (right-handed player; x mirrored like the game)

| Clip | Content | Expect |
| --- | --- | --- |
| lock / blue-lock | paddle brought to the circle and held (color locked at 1.0 s) | no swings |
| idle | ready position, sway, a slow shift and back, a small fidget; red book on the shelf | no swings, no tosses |
| fh / bh | three forehands / backhands, relaxed take-back, 3.2-3.6 frame widths/s | 3 swings, right stroke |
| windup | fh, bh, fh, bh, each after a brisk take-back the other way (~2 w/s) and a quick recovery | 4 strokes; the take-backs may be reported but as the other direction and `role: 'windup'` |
| toss | twice: paddle raised above the toss line, held ~0.6 s, serve swing down and across | 2 tosses, 2 serve swings |
| fast | four ~5.5 w/s strokes, long blur, paddle turning towards edge-on; red book on the shelf | 4 strokes, no jumps to the book |
| blue | blue paddle (locked on blue-lock): fh, bh, fh | 3 strokes |

## What the numbers mean

Per clip:
- **found**: frames where the tracker returned a position; **fast-found**: the same in frames where the paddle moves
  faster than 2 frame widths/s (blur). **err med/p90**: distance from the true blade centre, in frame widths.
  **jumps**: frames more than 0.1 frame widths off (usually the tracker on something else).
- **strokes / det / recall**: true strokes (and serves) vs. swings reported during them (first one each).
  **false**: swings reported when nothing was swinging, during slow moves (shift, fidget) or a second time on one
  stroke. **prec** = det / (det + false). **fh/bh ok**: detected strokes with the right direction.
- **lat med/p90**: true peak of the swing → the `swing` event reaching the game. Negative is possible: the detector
  reports a swing before its peak and predicts the peak time.
- **t0 err**: the swing's `t0` (the moment the game treats as the hit) minus the true peak: mean ± sd. The game
  subtracts `Settings.latency` (default 0.04 s) from `t0`, so a mean near 0 is right for a zero-delay camera.
- **peak×**: reported peak speed / true peak speed (sets shot power).
- **aux**: swings reported during take-backs, recoveries and the toss raise (harmless if they carry the other
  direction / role; listed with `--aux`).
- **toss / fired / lat / false**: spells above the toss line, toss events during them, time from crossing the line to
  the event (the detector waits 0.12 s on purpose), toss events at other times.
- **track ms**: real time `Tracker.trackColor` took per frame on this machine.

Practice: points, serves (tosses the game took, serves hit), rally balls that came to the player and how many were hit,
the game's timing messages (Too early / Too late / Missed), hit timing `tau` (0 = perfect, ±1 = one timing window),
`tEff − planned contact` (how the game judged the swing timing), and tracking error on the live camera.

## What good looks like

- idle / lock: 0 false triggers, 0 tosses, found 100%, err < 0.01.
- fh / bh / windup / blue: recall 100%, precision 100%, fh/bh 100%, no stroke labelled `windup`/`return`.
- fast: recall ≥ 75%, no jumps to the red book, fast-found ≥ 60%.
- toss: 2/2, latency < 250 ms, 0 false tosses anywhere.
- latency true peak → event: median ≤ 40 ms in lockstep (plus the webcam's own delay in real life); t0 err within ±30 ms, sd < 25 ms.
- practice: most rally balls hit (≥ 70%), serves hit, `tEff − planned contact` within ±50 ms, no console errors.
- hand (a): model < 30 ms per frame on a real GPU, ≥ 25 results/s, 0 hands found in the synthetic room.

These are synthetic scenes: a pass here doesn't prove a real webcam in a real room works, but a failure here is a
real bug or a real weakness, reproducible frame by frame.

## Adding a clip

Add an entry to `CLIPS` in `clips.mjs` (unique `id` < 15, a `build()` returning a `Script` that starts and ends at
`REST`), then rerun. Use `Script.stroke(kind, peakTime, { amp, dur, back, pause, rec, lift })`, `Script.serve(tUp, peakTime)`
and `Script.to(kind, t0, t1, point)`; move kinds `stroke`/`serve` must be detected, `windup`/`return`/`raise` may be,
anything else (`shift`, `fidget`) must not.
