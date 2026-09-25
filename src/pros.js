// Pro roster: the players you can play as and against, and the CPU's playing personalities.
// LICENSING: Djokovic, Nadal, Federer, Sinner and Alcaraz are real people. Their names and likenesses need a licence
// (from the players or their agents) before any commercial release, Steam included. Every display name, country and
// description lives in this one file, so renaming the roster (or turning it into fictional players) is a single edit.
// No brand logos or trademarks anywhere: each pro is recognisable by build, hair, headwear, colours and style only.

const M = (m) => m / 1.83;   // character height is a scale on the 1.83 m base body

// look: createCharacter fields (build, face, hair, headwear, clothing cut); kit: outfit colours; alt: second kit when
// the two players' shirts would be hard to tell apart; style: Avatar.setStyle; persona: CPU tendencies, 0..1, 0.5 neutral.
export const PROS = [
  {
    id: 'custom', custom: true, name: 'Your player', short: '', country: '', handed: null, blurb: 'Your name and your hand',
    look: {}, kit: null, alt: null, style: {}, persona: null,
  },
  {
    id: 'djokovic', name: 'Novak Djokovic', short: 'Djokovic', country: 'SRB', handed: 'R', blurb: 'Elastic defence, the best return in the game',
    look: {
      height: M(1.88), width: 0.97, chest: 0.97, muscle: 0.45, arm: 1.1, leg: 1.07, skin: 0xe1ae88,
      hair: 'crop', hairColor: 0x1d1510, headwear: 'none', headband: false, beard: 0.3,
      face: { jaw: 0.97, cheek: 1.06, nose: 1.04, brow: 1.02, chin: 1.04, eyes: 0.96 },
      sleeve: 0.14, collar: 'crew', shorts: 0.78, sock: 0.2, wristband: true,
    },
    kit: { shirt: 0x22345c, pants: 0x22345c, shoe: 0xf4f4f0, band: 0xf2f5ee, accent: 0xd6343a, design: 1 },
    alt: { shirt: 0xf2f5ee, pants: 0x22345c, shoe: 0xf4f4f0, band: 0x22345c, accent: 0xd6343a, design: 1 },
    style: { backhand: 'two', serve: 'classic', ritual: 'bounces', celebrate: 'heart', gait: 'glide' },
    persona: { aggression: 0.6, topspin: 0.55, slice: 0.4, drop: 0.45, net: 0.35, serve: 0.7, consistency: 0.95, defense: 0.98, speed: 0.9 },
  },
  {
    id: 'nadal', name: 'Rafael Nadal', short: 'Nadal', country: 'ESP', handed: 'L', blurb: 'Lefty with heavy topspin and relentless legs',
    look: {
      height: M(1.85), width: 1.04, chest: 1.07, muscle: 0.95, arm: 1.24, leg: 1.17, skin: 0xcf9670,
      hair: 'long', hairColor: 0x2c1d13, headwear: 'bandana', headband: true, beard: 0.2,
      face: { jaw: 1.06, cheek: 1, nose: 1.08, brow: 1.06, chin: 0.98, eyes: 1 },
      sleeve: 0, collar: 'crew', shorts: 0.6, sock: 0.22, wristband: true,
    },
    kit: { shirt: 0x3ba55c, pants: 0xf2f5ee, shoe: 0xf4f4f0, band: 0xf2f5ee, accent: 0xf2f5ee, design: 3 },
    alt: { shirt: 0xef7d2d, pants: 0x1c1f24, shoe: 0x22262b, band: 0xf2f5ee, accent: 0x1c1f24, design: 3 },
    style: { backhand: 'two', serve: 'compact', ritual: 'tugs', celebrate: 'vamos', gait: 'normal' },
    persona: { aggression: 0.6, topspin: 0.98, slice: 0.35, drop: 0.4, net: 0.35, serve: 0.55, consistency: 0.9, defense: 0.9, speed: 0.88 },
  },
  {
    id: 'federer', name: 'Roger Federer', short: 'Federer', country: 'SUI', handed: 'R', blurb: 'One-handed backhand, all-court attack',
    look: {
      height: M(1.85), width: 1, chest: 1, muscle: 0.5, arm: 1.14, leg: 1.1, skin: 0xe0ab85,
      hair: 'wavy', hairColor: 0x4a3222, headwear: 'headband', headband: true, beard: 0.12,
      face: { jaw: 1.02, cheek: 1, nose: 1.1, brow: 1, chin: 1.05, eyes: 1 },
      sleeve: 0.13, collar: 'polo', shorts: 0.8, sock: 0.18, wristband: true,
    },
    kit: { shirt: 0xf4f5f0, pants: 0xf4f5f0, shoe: 0xf4f4f0, band: 0xf4f5f0, accent: 0xc8102e, design: 0 },
    alt: { shirt: 0x1c1f24, pants: 0x1c1f24, shoe: 0x22262b, band: 0xf2f5ee, accent: 0xc8102e, design: 0 },
    style: { backhand: 'one', serve: 'rocker', ritual: 'quick', celebrate: 'calm', gait: 'glide' },
    persona: { aggression: 0.85, topspin: 0.55, slice: 0.8, drop: 0.55, net: 0.85, serve: 0.9, consistency: 0.75, defense: 0.65, speed: 0.8 },
  },
  {
    id: 'sinner', name: 'Jannik Sinner', short: 'Sinner', country: 'ITA', handed: 'R', blurb: 'Flat, early ball-striking and raw pace',
    look: {
      height: M(1.91), width: 0.95, chest: 0.94, muscle: 0.3, arm: 1.06, leg: 1.03, skin: 0xf1c8a8,
      hair: 'curly', hairColor: 0xa4522a, headwear: 'none', headband: false, beard: 0,
      face: { jaw: 0.96, cheek: 0.98, nose: 1.02, brow: 0.97, chin: 1, eyes: 1.05 },
      sleeve: 0.15, collar: 'crew', shorts: 0.77, sock: 0.2, wristband: false,
    },
    kit: { shirt: 0x1c1f24, pants: 0x1c1f24, shoe: 0xf4f4f0, band: 0x2ec4b6, accent: 0x2ec4b6, design: 2 },
    alt: { shirt: 0xf2f5ee, pants: 0x1c1f24, shoe: 0xf4f4f0, band: 0x2ec4b6, accent: 0x2ec4b6, design: 2 },
    style: { backhand: 'two', serve: 'compact', ritual: 'bounces', celebrate: 'fist', gait: 'normal' },
    persona: { aggression: 0.9, topspin: 0.4, slice: 0.3, drop: 0.35, net: 0.4, serve: 0.8, consistency: 0.85, defense: 0.75, speed: 0.85 },
  },
  {
    id: 'alcaraz', name: 'Carlos Alcaraz', short: 'Alcaraz', country: 'ESP', handed: 'R', blurb: 'Explosive speed, drop shots and variety',
    look: {
      height: M(1.83), width: 1.02, chest: 1.03, muscle: 0.8, arm: 1.2, leg: 1.16, skin: 0xd49d74,
      hair: 'textured', hairColor: 0x1e1510, headwear: 'none', headband: false, beard: 0.1,
      face: { jaw: 1.02, cheek: 1.03, nose: 1.02, brow: 1.05, chin: 0.98, eyes: 1.04 },
      sleeve: 0.12, collar: 'crew', shorts: 0.8, sock: 0.2, wristband: true,
    },
    kit: { shirt: 0xe8505b, pants: 0x1c1f24, shoe: 0xf4f4f0, band: 0xf2f5ee, accent: 0xf2f5ee, design: 3 },
    alt: { shirt: 0x2f6fb3, pants: 0xf2f5ee, shoe: 0xf4f4f0, band: 0xd6f04a, accent: 0xd6f04a, design: 3 },
    style: { backhand: 'two', serve: 'high-toss', ritual: 'quick', celebrate: 'arms', gait: 'bouncy' },
    persona: { aggression: 0.8, topspin: 0.7, slice: 0.55, drop: 0.95, net: 0.7, serve: 0.75, consistency: 0.7, defense: 0.85, speed: 0.95 },
  },
];

export const REAL_PROS = PROS.filter((p) => !p.custom);
// A real pro by id; null for 'custom', 'random' or anything unknown (an old save, a message from another version).
export const proById = (id) => REAL_PROS.find((p) => p.id === id) || null;
// A random real pro, avoiding the given ids when possible.
export function randomPro(avoid = []) {
  const pool = REAL_PROS.filter((p) => !avoid.includes(p.id));
  const from = pool.length ? pool : REAL_PROS;
  return from[(Math.random() * from.length) | 0];
}
// What the scoreboard and the umpire call a player.
export const proName = (id, fallback) => { const p = proById(id); return p ? p.short : fallback; };

// ---- card portraits: a small flat SVG head and shoulders drawn from a look (skin, hair, headwear, kit) ----
const hex = (c) => '#' + ((c ?? 0x888888) >>> 0).toString(16).padStart(6, '0').slice(-6);
const HAIR = {
  short: 'M21.6 29C20.5 19 25 15 32 15S43.5 19 42.4 29C41.6 25 41 23 39.5 21.8 36 20.2 28 20.2 24.5 21.8 23 23 22.4 25 21.6 29Z',
  crop: 'M22 27.5C21.2 19 25.5 15.6 32 15.6S42.8 19 42 27.5C41.4 24 40.4 22 38.6 21.2 35 20.4 29 20.4 25.4 21.2 23.6 22 22.6 24 22 27.5Z',
  wavy: 'M20.8 31C19 20 24 13.4 32.5 13.4S45.5 19.5 43.4 31C42.6 27 42 24.2 40.2 22.6 37.4 21.4 33.6 22.8 29.4 21.2 26.6 20.4 24.6 21.2 23.3 23.4 22 25.6 21.5 28 20.8 31Z',
  long: 'M21.2 29C20.4 19 25 14.6 32 14.6S43.6 19 42.8 29C42 25 41.2 23 39.4 21.6 36 20 28 20 24.6 21.6 22.8 23 22 25 21.2 29Z',
  textured: 'M22 28C21.2 21 23.4 17.4 25.8 16.2L26.6 13.6 29 15.3 30.8 12.6 33.2 14.9 35.6 13 37 15.5 39.6 14.6 39.8 17.2C42 19 42.9 23 42 28 41.2 24.6 40.4 22.6 38.6 21.4 35 20.6 29 20.6 25.4 21.4 23.6 22.4 22.6 24.4 22 28Z',
};
const n2 = (v) => +v.toFixed(2);
export function proPortrait(L, cls = '') {
  const skin = hex(L.skin), hair = hex(L.hairColor), shirt = hex(L.shirt), acc = hex(L.accent ?? L.band), band = hex(L.band), f = L.face || {};
  const style = L.hair || 'short', hw = L.headwear || (L.headband === false ? 'none' : 'headband'), jaw = 7.5 * (f.jaw || 1), eye = f.eyes || 1, bare = L.sleeve === 0;
  const o = [`<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">`, `<rect width="64" height="64" fill="${shirt}" opacity=".3"/>`];
  // hair that falls behind the head and neck
  if (style === 'long') o.push(`<path fill="${hair}" d="M19.6 24C18 34 19 43 21 48.5 23.2 48 24.8 47 25.8 45.4 24 40 23.2 35 23.2 30ZM44.4 24C46 34 45 43 43 48.5 40.8 48 39.2 47 38.2 45.4 40 40 40.8 35 40.8 30Z"/>`);
  if (style === 'ponytail') o.push(`<path fill="${hair}" d="M39 22C45 24 46 32 44 40 42.6 36 41.6 30 38 26Z"/>`);
  // shoulders: a shirt, or a sleeveless top over bare shoulders
  const torso = 'M6 64C7 55 14 50.5 24 49H40C50 50.5 57 55 58 64Z';
  o.push(bare ? `<path fill="${skin}" d="${torso}"/><path fill="${shirt}" d="M17 64C18 56 21 51 25 49.4H39C43 51 46 56 47 64Z"/>` : `<path fill="${shirt}" d="${torso}"/>`);
  if (L.design === 1 && !bare) o.push(`<path fill="none" stroke="${acc}" stroke-width="3" d="M8.6 59C11 54 16 51.2 24 50M55.4 59C53 54 48 51.2 40 50"/>`);
  if (L.design === 2) o.push(`<path stroke="${acc}" stroke-width="3" d="M${bare ? 18.6 : 8.4} 59.5H${bare ? 45.4 : 55.6}"/>`);
  if (L.design === 3) o.push(`<path stroke="${acc}" stroke-width="2.4" d="M${bare ? 19.6 : 11.6} 58V64M${bare ? 44.4 : 52.4} 58V64"/>`);
  // neck, collar, ears, head
  o.push(`<path fill="${skin}" d="M27.5 37V49.6Q32 52 36.5 49.6V37Z"/><path d="M27.5 40.5Q32 45 36.5 40.5V44Q32 47.5 27.5 44Z" opacity=".13"/>`);
  if (L.collar === 'polo') o.push(`<path fill="${shirt}" stroke="#000" stroke-opacity=".25" stroke-width=".6" d="M25 48.4 31.6 54.2 29.2 48.2ZM39 48.4 32.4 54.2 34.8 48.2Z"/>`);
  else if (L.collar === 'v') o.push(`<path fill="none" stroke="${acc}" stroke-width="1.4" d="M26.4 49.2 32 55.4 37.6 49.2"/>`);
  else o.push(`<path fill="none" stroke="${acc}" stroke-width="1.5" d="M26.2 49.4Q32 53.4 37.8 49.4"/>`);
  o.push(`<ellipse cx="21.9" cy="30.4" rx="1.9" ry="3.1" fill="${skin}"/><ellipse cx="42.1" cy="30.4" rx="1.9" ry="3.1" fill="${skin}"/>`);
  o.push(`<path fill="${skin}" d="M22 28C22 19.5 26.4 16.6 32 16.6S42 19.5 42 28C42 35 ${n2(34 + jaw)} 40.6 32 43 ${n2(30 - jaw)} 40.6 22 35 22 28Z"/>`);
  // face: stubble, eyes, brows, nose, mouth
  if (L.beard > 0) o.push(`<path fill="${hair}" opacity="${n2(0.2 + 0.5 * L.beard)}" d="M22.6 31.5C23.2 38 ${n2(32 - jaw)} 42.6 32 43 ${n2(32 + jaw)} 42.6 40.8 38 41.4 31.5 39.6 35.6 36.4 37.6 32 37.8 27.6 37.6 24.4 35.6 22.6 31.5Z"/>`);
  for (const x of [28, 36]) o.push(`<ellipse cx="${x}" cy="29.6" rx="${n2(1.3 * eye)}" ry="${n2(0.95 * eye)}" fill="#1b1512"/>`);
  o.push(`<path fill="none" stroke="${hair}" stroke-width="${n2(1.15 * (f.brow || 1))}" stroke-linecap="round" d="M25.4 26.6Q28 25.2 30.4 26.3M38.6 26.6Q36 25.2 33.6 26.3"/>`);
  o.push(`<path fill="none" stroke="#000" stroke-opacity=".2" stroke-width=".9" d="M32 29.8 ${n2(32 - 0.6 * (f.nose || 1))} ${n2(33.4 + 1.2 * (f.nose || 1))}Q32 35.4 33.2 34.8"/><path fill="none" stroke="#5a2e26" stroke-opacity=".6" stroke-linecap="round" d="M29.4 38.2Q32 39.1 34.6 38.2"/>`);
  // hair on top, then whatever is worn over it
  if (style === 'buzz') o.push(`<path fill="${hair}" opacity=".6" d="${HAIR.short}"/>`);
  else if (style === 'curly') {
    o.push(`<path fill="${hair}" d="M21.4 30C20 21 24.5 16 32 16S44 21 42.6 30C41.8 26 40.8 23.6 38.6 22.4 35 21.4 29 21.4 25.4 22.4 23.2 23.6 22.2 26 21.4 30Z"/>`);
    for (const [x, y, r] of [[22.6, 23.4, 3.6], [24.6, 18.6, 4.2], [29, 15.6, 4.6], [34.4, 15.2, 4.7], [39.2, 18, 4.3], [41.6, 23, 3.7], [21.4, 27.6, 2.6], [42.6, 27.6, 2.6]]) {
      o.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${hair}"/><path fill="none" stroke="#000" stroke-opacity=".18" stroke-width=".8" d="M${n2(x - r * 0.5)} ${n2(y + r * 0.1)}Q${x} ${n2(y - r * 0.6)} ${n2(x + r * 0.5)} ${n2(y + r * 0.1)}"/>`);
    }
  } else if (style !== 'bald') o.push(`<path fill="${hair}" d="${HAIR[style] || HAIR.short}"/>`);
  if (style === 'wavy') o.push(`<path fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1" d="M24.6 18.6Q28.6 15.6 35 16.4M27 20.6Q32 18.6 38.6 20"/>`);
  if (hw === 'headband') o.push(`<path fill="${band}" d="M21.8 22.6C25 20.4 39 20.4 42.2 22.6L42.4 26.2C39 24.2 25 24.2 21.6 26.2Z"/>`);
  else if (hw === 'bandana') o.push(`<path fill="${band}" d="M21 26.8C20.2 18 25.4 13.8 32 13.8S43.8 18 43 26.8C39 24.2 25 24.2 21 26.8ZM42.2 22.4 47.4 24.6 49.6 33.4 46.6 32.2 45.8 27.4 42.4 26.4Z"/><path fill="none" stroke="#000" stroke-opacity=".16" stroke-width=".8" d="M22.4 21.6Q32 17.6 41.6 21.6"/>`);
  else if (hw === 'cap') o.push(`<path fill="${band}" d="M21.4 25C21 17.4 25.6 13.6 32 13.6S43 17.4 42.6 25ZM19.4 25.2Q32 22.4 44.6 25.2 43.6 27.6 32 26.6 21.4 27.6 19.4 25.2Z"/>`);
  o.push('</svg>');
  return o.join('');
}
// The "random pro" card: a blank silhouette and a question mark.
export const randomPortrait = (cls = '') => `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" fill="#d6f04a" opacity=".1"/><path fill="#f2f5ee" opacity=".16" d="M6 64C7 55 14 50.5 24 49H40C50 50.5 57 55 58 64ZM27.5 37V50H36.5V37ZM22 28C22 19.5 26.4 16.6 32 16.6S42 19.5 42 28C42 35 41.5 40.6 32 43 22.5 40.6 22 35 22 28Z"/><text x="32" y="38" text-anchor="middle" font-family="Big Shoulders Display, Impact, sans-serif" font-weight="900" font-size="24" fill="#d6f04a">?</text></svg>`;
