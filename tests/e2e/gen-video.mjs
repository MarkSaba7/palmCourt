// Writes the synthetic webcam video for the paddle test (YUV 4:2:0 .y4m, 640×480, 30 fps, loops cleanly):
//   <out>/suite.y4m   every clip back to back (what webcam-paddle.mjs plays as the fake camera; Chromium loops it)
//   <out>/suite.json  ground truth: per clip its first frame in the suite, per-frame paddle position, every move with
//                     its peak frame, stroke and speed, and the spells above the toss line
//   <out>/<clip>.y4m  one file per clip, with --each (handy for trying a clip by hand in Chrome)
//   <out>/<clip>-<frame>.png  a preview of the first frame and of the first stroke's peak, with --png
//   node tests/e2e/gen-video.mjs [--out tests/e2e/out] [--clips lock,idle,fh,...] [--each] [--png]
// Every frame carries a barcode (bottom-left of the raw image) with its clip id and frame number; see scene.mjs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { W, H, FPS, PADDLE, makeStatic, renderFrame, toI420 } from './scene.mjs';
import { CLIPS, truthOf } from './clips.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEADER = `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`;

// Render one clip, handing each frame's I420 bytes to sink(bytes, k).
function renderClip(clip, sink, { png = null } = {}) {
  const truth = truthOf(clip), s = clip.build(), stat = makeStatic({ distractor: clip.distractor, seed: 7 });
  const rgb = new Float32Array(W * H * 3), yuv = new Uint8Array((W * H * 3) / 2), peak = Math.round((truth.moves.find((m) => m.stroke) || { peakFrame: 0 }).peakFrame);
  for (let k = 0; k < truth.frames; k++) {
    renderFrame(k / FPS, { script: s, stat, color: PADDLE[clip.color], exposure: clip.exposure, frame: k, clip: clip.id, out: rgb });
    sink(toI420(rgb, yuv), k);
    if (png && (k === 0 || k === peak)) writePng(path.join(png, `${clip.name}-${k}.png`), rgb);
  }
  return truth;
}

export function writeSuite(clips, dir, { each = false, png = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, 'suite.y4m'), 'w'), segments = [];
  fs.writeSync(fd, HEADER);
  let start = 0;
  for (const c of clips) {
    const t0 = Date.now(), one = each ? fs.openSync(path.join(dir, c.name + '.y4m'), 'w') : null;
    if (one) fs.writeSync(one, HEADER);
    const truth = renderClip(c, (bytes) => { fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, bytes); if (one) { fs.writeSync(one, 'FRAME\n'); fs.writeSync(one, bytes); } }, { png: png ? dir : null });
    if (one) fs.closeSync(one);
    segments.push({ name: c.name, id: c.id, start, frames: truth.frames, truth });
    console.log(`${c.name.padEnd(10)} frames ${String(start).padStart(4)}–${start + truth.frames - 1}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    start += truth.frames;
  }
  fs.closeSync(fd);
  const suite = { fps: FPS, width: W, height: H, total: start, segments };
  fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify(suite));
  return suite;
}

function writePng(file, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(rgb[y * W * 3 + x])));
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
  const out = path.resolve(arg('out', path.join(HERE, 'out'))), only = arg('clips', '');
  let list = only ? CLIPS.filter((c) => only.split(',').includes(c.name)) : CLIPS;
  if (list[0] && list[0].name !== 'lock') list = [CLIPS[0], ...list.filter((c) => c.name !== 'lock')];   // the runner locks the color on the first clip
  if (list.some((c) => c.color === 'blue') && !list.some((c) => c.name === 'blue-lock')) { const i = list.findIndex((c) => c.color === 'blue'); list.splice(i, 0, CLIPS.find((c) => c.name === 'blue-lock')); }
  const t0 = Date.now(), s = writeSuite(list, out, { each: !!arg('each', false), png: !!arg('png', false) });
  console.log(`suite: ${s.total} frames (${(s.total / FPS).toFixed(1)} s), ${(fs.statSync(path.join(out, 'suite.y4m')).size / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s → ${out}`);
}
