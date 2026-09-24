# Palm Court — work log for continuation sessions

(This folder starts with a dot, so serve.py never serves it.)

## What the game is
Browser tennis (three.js r186 import map from jsdelivr, ES modules, no build step). Play with your phone as the
racket (controller.html over LAN https from serve.py, PeerJS link), a webcam (hand or ping-pong paddle), or mouse.
Practice vs CPU, online vs a friend by link. Goal of the owner: publish on Steam, so graphics, polish and
reliability matter. Run with `play.cmd` (serve.py: http://localhost:8765 for the PC, https://<LAN IP>:8766 for phones).

## Code map
- src/core.js physics, Clock, Settings · src/match.js scoring + Sound · src/game.js flow/CPU/line calls/online
- src/input.js input + webcam Tracker · src/phone.js phone link + QR · src/net.js online · src/ui.js screens/HUD
- src/replay.js instant replays + Hawk-Eye · src/main.js boot/loop
- src/render/: renderer (composer: RenderPass → GTAO → DOF → bloom → output → grade; Neutral tone mapping; Perf
  presets), sky (time of day, physical sky probe), court, stadium, crowd (instanced, night camera flashes), character
  (procedural skinned people + detail shader), avatar (poses, swing blur), ball, camera (menu montage director +
  player/TV cams), effects (clay dust, chalk), textures.
- `window.PalmCourt` exposes the main modules for testing in the browser.

## Testing notes
- Syntax check: `node --input-type=module --check < file.js`.
- Dev server: `python serve.py --no-browser --no-phone --port <free port>`; use the built-in browser; if the pane is
  hidden (innerWidth 0) use resize_window 1280x720 on your tab.
- Practice with AI on both sides: start practice, then Game.players[0].ctl='cpu' (copy level/maxSpeed/acc/react).
- Prefer the Edit tool: bash heredocs mangle backslashes here.

## Done recently (2026-09-23/24)
- Lighting fixed (court normal map was a broken render-target clone; sky probe scaled to physical units; Neutral
  tone mapping), shadows, crowd palette, clay/grass/hard colours, golden hour, night floodlights.
- Replays + Hawk-Eye, menu broadcast montage, depth of field, clay dust, chalk puffs, camera flashes, swing blur,
  pre-serve ball bounce, head-pitch sign bug, face/hair/headband detail.

## Open list (priority order)
1. Phone QR pairing reliability (agent working on it 2026-09-24 00:40).
2. Webcam hand/paddle consistency + backhands (agent working on it).
3. QA of game flow, online, replays (agent working on it).
4. Graphics: verify new face/headband/eyes up close; stadium detail; character polish.
5. README update (phone racket, serve.py/play.cmd, graphics settings, troubleshooting).
6. Steam packaging notes (Electron + steamworks.js; vendor CDN libs) — needs the owner's go-ahead for downloads.

## 2026-09-24 01:10 — lead session
- Faces: shared headShape() (nose, bridge, brow, sockets, cheekbones, mouth, chin); hair shell follows it; dithered
  soft hairline; headband built on the head surface (BAND heights), hair pressed under it; eyes/brows at correct
  depth (head centre has a 6 mm z offset!); eyelid shading. Fingers on the fist.
- Head pitch bug fixed (positive head pitch = face up); serve/win/lose poses corrected.
- Skyline: facade/roughness/glow textures at world scale, tints. Palms: leaflet alpha fronds (+ shadow depth
  material), tapered ringed trunk, boot. Ball trail shorter. Cam.hold now controls DOF (hold.dof).
- Agents running: phone QR pairing (ports 8781/8782), webcam controls (8783), QA (8785). Lead uses 8775.

## 2026-09-24 ~01:50 — lead session
- Net shader cord mask was inverted (panel with holes) — fixed to open mesh.
- Ball streak length now ~1/18 s of travel (was a fixed frame count → metres-long lines on serves).
- Ball kids fetch balls between points (src/render/ballkids.js; visual only, stand-in ball if play restarts).
- Clay slide marks (court.js addSkidMark; effects footDust on hard stops).
- Crowd: rounded low-poly people (559 verts), hands on laps, thicker arms.
- Kits: shirt designs (yoke/band/side panels + chest logo) via aAccent.a; Avatar.setKit recolours in place;
  OUTFITS list; CPU opponent gets a random non-clashing outfit per non-online match (game.js startMatch).
- Branded loading screen with progress bar; roof flags (shared program, per-flag phase uniform).
