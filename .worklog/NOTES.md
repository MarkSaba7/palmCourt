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

## 2026-09-24/25 — multi-agent session (lead + up to 20 agents, each in its own git worktree)
- Brief with file ownership + cross-agent contracts: see the session scratchpad TEAM.md (not in repo). Key contracts now
  in code: character look fields (hair crop/wavy/long/curly/textured, headwear none/headband/bandana/cap, beard 0..1,
  face{jaw,cheek,nose,brow,chin,eyes}, sleeve 0 = sleeveless, collar crew/polo/v, muscle 0..1), Avatar.setLook(look),
  Avatar.setStyle(style) (A10, not merged yet), player.persona {aggression,topspin,slice,drop,net,serve,consistency,
  defense,speed} for the CPU, src/pros.js roster of fictional pros (Varga, Rivas L, Adler, Ferro, Aranda + custom; display names only
  there). The replay line call is labelled "Line review" (Hawk-Eye is a trademark).
- GitHub Pages: .github/workflows/pages.yml deploys index.html + controller.html + src/ on every push to main
  (Settings → Pages → Source: GitHub Actions). Live at https://marksaba7.github.io/palmCourt/. Opening index.html
  from a folder doesn't work (ES modules blocked on file://).
- Merged so far: hand tracking (worker start-up with per-delegate timeouts, numHands 1↔2, off-hand masking, Tracker.stats),
  paddle tracking (skin guard, lock reasons, 99.9% found vs 73%), swing detection (blur bridging), swing→shot feel
  (smooth rewinds, racket follows hand, per-player power), guided camera check, pro roster + picker, heads WIP,
  bodies WIP, CPU AI WIP, court lines-in-shader + wear + net, custom post chain (SMAA/FXAA, fallback ladder, context
  loss), custom sky + shadows, spring cameras, broadcast HUD + match stats, tests/sim (4,500 random matches vs an
  independent scorer), tests/e2e webcam rig (lockstep mode).
- Tests: node test/{camswing,hand,paddle,pros}.test.mjs; node tests/sim/{match,physics}.test.mjs; tests/e2e/README.md.
- Headless testing needs the CDN mirrored locally (cdn.jsdelivr.net is blocked in the cloud sandbox); SwiftShader is too
  slow to judge frame rate. In fast-forward sims, 'dead' waits on Replay.busy() (Replay runs on real time) → turn
  Settings.replays off or drive Replay.update.
- Open: CPU-vs-CPU rallies far too long (A11 tuning), faces crude up close + long neck when heads/bodies combine
  (A07/A08), animation/signature moves (A10), racket+ball rewrite (A12; found throat arms built toward the tip),
  stadium rebuild draft (A14), scenery (A15), crowd (A16), effects/ball kids/replay cam (A18), perf pass (A21),
  green run-off shows rubber-scuff squiggles (A13 WIP).
- Usage limits: 20 concurrent agents exhausted the account's session limit in ~1 h; run ≤7 at once and have agents
  commit WIP at every milestone.
