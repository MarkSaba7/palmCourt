// Roster checks for src/pros.js (no browser): the contract the renderer, animation and CPU code rely on.
// Run: node test/pros.test.mjs
import assert from 'node:assert/strict';
import { PROS, REAL_PROS, proById, randomPro, proName, proPortrait, randomPortrait } from '../src/pros.js';

const STYLE = { backhand: ['one', 'two'], serve: ['classic', 'compact', 'rocker', 'high-toss'], ritual: ['none', 'bounces', 'tugs', 'quick'], celebrate: ['fist', 'vamos', 'heart', 'arms', 'calm'], gait: ['normal', 'bouncy', 'glide'] };
const HAIR = ['short', 'buzz', 'bald', 'ponytail', 'crop', 'wavy', 'long', 'curly', 'textured'], HEADWEAR = ['none', 'headband', 'bandana', 'cap'];
const PERSONA = ['aggression', 'topspin', 'slice', 'drop', 'net', 'serve', 'consistency', 'defense', 'speed'];
const KIT = ['shirt', 'pants', 'shoe', 'band', 'accent', 'design'];
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok', name); };

test('roster: the custom player, then the five pros', () => {
  assert.equal(PROS[0].id, 'custom');
  assert.deepEqual(REAL_PROS.map((p) => p.id), ['varga', 'rivas', 'adler', 'ferro', 'aranda']);
  assert.equal(new Set(PROS.map((p) => p.id)).size, PROS.length);
});
test('every pro is complete and uses the shared vocabularies', () => {
  for (const p of REAL_PROS) {
    for (const k of ['name', 'short', 'country', 'blurb']) assert.ok(typeof p[k] === 'string' && p[k], `${p.id}.${k}`);
    assert.ok(p.short.length <= 12, `${p.id} fits the scoreboard`);
    assert.ok(['R', 'L'].includes(p.handed));
    for (const [k, vs] of Object.entries(STYLE)) assert.ok(vs.includes(p.style[k]), `${p.id} style.${k}`);
    assert.ok(HAIR.includes(p.look.hair), `${p.id} hair`);
    assert.ok(HEADWEAR.includes(p.look.headwear), `${p.id} headwear`);
    assert.equal(p.look.headband, p.look.headwear !== 'none', `${p.id}: old headband flag matches headwear`);
    assert.ok(p.look.beard >= 0 && p.look.beard <= 1);
    assert.ok(p.look.height > 0.95 && p.look.height < 1.1, `${p.id} height scale`);
    for (const k of ['jaw', 'cheek', 'nose', 'brow', 'chin', 'eyes']) assert.ok(Math.abs(p.look.face[k] - 1) < 0.2, `${p.id} face.${k}`);
    assert.deepEqual(Object.keys(p.persona).sort(), [...PERSONA].sort());
    for (const k of PERSONA) assert.ok(p.persona[k] >= 0 && p.persona[k] <= 1, `${p.id} persona.${k}`);
    for (const kit of [p.kit, p.alt]) for (const k of KIT) assert.ok(kit[k] != null, `${p.id} kit.${k}`);
    for (const k of KIT) assert.ok(!(k in p.look), `${p.id}: ${k} belongs in the kit`);
  }
  assert.equal(proById('rivas').handed, 'L');
});
test('lookups', () => {
  for (const id of ['custom', 'random', undefined, null, '', '__proto__', 'toString']) assert.equal(proById(id), null);
  assert.equal(proName('adler', 'Me'), 'Adler');
  assert.equal(proName('custom', 'Me'), 'Me');
  for (let i = 0; i < 300; i++) { const a = randomPro(), b = randomPro([a.id]); assert.ok(a && b && a.id !== b.id); }
  assert.ok(randomPro(REAL_PROS.map((p) => p.id)));   // nothing left to avoid: still a pro
});
test('portraits are well-formed SVG', () => {
  for (const look of [...REAL_PROS.map((p) => ({ ...p.kit, ...p.look })), {}, { hair: 'bald', headwear: 'cap' }, { hair: 'ponytail', sleeve: 0, collar: 'v', design: 2 }]) {
    const s = proPortrait(look);
    assert.match(s, /^<svg [^>]*viewBox="0 0 64 64"[^>]*>.*<\/svg>$/s);
    assert.doesNotMatch(s, /NaN|undefined|null/);
  }
  assert.match(randomPortrait(), /^<svg .*<\/svg>$/s);
});
console.log(`${n} pro roster tests passed`);
