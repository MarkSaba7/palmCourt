// Browser simulations of whole matches and of the flows a player goes through (headless Chromium, no rendering).
//   PC_HARNESS=/path/to/harness/pc.mjs node tests/sim/run.mjs [matches|flows|all] [--quick] [--port 8819]
// pc.mjs is the shared Palm Court test harness (serves this checkout, mirrors the CDN libraries, launches Chromium).
// The page-side driver and rule checker live in tests/sim/sim-page.js; each scenario below runs inside the page.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const port = +(args[args.indexOf('--port') + 1] || 0) || 8819;
const which = args.find((a) => ['matches', 'flows', 'all'].includes(a)) || 'all';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const HARNESS = process.env.PC_HARNESS || '/tmp/claude-0/-home-user-palmCourt/fee01e52-c723-5dfc-bbaa-f9ed9d90dad0/scratchpad/harness/pc.mjs';
if (!fs.existsSync(HARNESS)) { console.log(`Set PC_HARNESS to the test harness's pc.mjs (not found: ${HARNESS})`); process.exit(2); }
const { launch } = await import(HARNESS);

let failures = 0;
const results = [];
function report(name, r, extra = '') {
  const errs = r.errors || [];
  const ok = errs.length === 0 && r.ok !== false;
  if (!ok) failures++;
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`);
  for (const e of errs.slice(0, 8)) console.log('     ' + JSON.stringify(e));
  if (r.why && !ok) console.log('     ' + r.why);
}

const { page, logs, close } = await launch({ root: ROOT, port });
try {
  await page.evaluate(async () => { const S = await import('/tests/sim/sim-page.js'); S.install(); S.checker(); });

  // ---------------------------------------------------------------- whole matches, CPU vs CPU
  if (which === 'matches' || which === 'all') {
    const formats = ['tiebreak', 'short', 'full'], surfaces = ['hard', 'clay', 'grass'], levels = ['rookie', 'club', 'pro'];
    const combos = [];
    for (const format of formats) for (const surface of surfaces) for (const level of levels) combos.push({ format, surface, level });
    const list = QUICK ? combos.filter((c, i) => i % 4 === 0) : combos;
    for (const [i, c] of list.entries()) {
      const name = `match ${c.format}/${c.surface}/${c.level}`;
      if (only && !name.includes(only)) continue;
      const dt = i % 3 === 0 ? 1 / 30 : 1 / 60;   // some matches at 30 fps, like a slow machine
      const t0 = Date.now();
      const r = await page.evaluate(async ({ c, dt }) => {
        const S = await import('/tests/sim/sim-page.js'), C = S.getChecker(), G = window.PalmCourt.Game;
        C.reset();
        await S.startPractice({ ...c, first: Math.random() < 0.5 ? 0 : 1 });
        const done = S.runUntil(() => G.state === 'over', c.format === 'full' ? 4000 : 2500, dt);
        const m = G.match;
        return { ...C.report(), ok: done, why: done ? '' : `not finished: ${G.state} ${JSON.stringify(m.toJSON())}`, score: m.tbOnly ? m.pts.join('-') : m.games.join('-') + (m.tb ? ` (${m.pts.join('-')})` : ''), gameT: S.V.t };
      }, { c, dt });
      const k = r.counts;
      report(name, r, `${r.score} in ${r.points} pts, ${Math.round((Date.now() - t0) / 1000)} s · aces ${k['reason:ace'] || 0} df ${k['reason:df'] || 0} faults ${(k['fault:out'] || 0) + (k['fault:net'] || 0)} lets ${k.let || 0} winners ${k['reason:winner'] || 0} out ${k['reason:out'] || 0} net ${k['reason:net'] || 0} · longest rally ${r.maxRally} · replays ${Object.entries(k).filter(([a]) => a.startsWith('replay:')).map(([a, n]) => a.slice(7) + ' ' + n).join(', ') || 'none'}${k.eightSecondRule ? ` · 8s-rule ${k.eightSecondRule}` : ''}${k.retoss ? ` · retoss ${k.retoss}` : ''}`);
      if (r.log.length && k.eightSecondRule) for (const l of r.log.slice(-3)) console.log('     ' + l);
    }
  }

  // ---------------------------------------------------------------- flows a human goes through
  if (which === 'flows' || which === 'all') {
    const flows = (await import(path.join(ROOT, 'tests/sim/flows.mjs'))).FLOWS;
    for (const [name, fn] of Object.entries(flows)) {
      if (only && !name.includes(only)) continue;
      const t0 = Date.now();
      let r;
      try { r = await fn(page); } catch (e) { r = { errors: [{ msg: 'threw: ' + (e && e.message) }] }; }
      report('flow ' + name, r, `${Math.round((Date.now() - t0) / 1000)} s${r.note ? ' · ' + r.note : ''}`);
    }
  }
  const pageErrors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  if (pageErrors.length) { failures++; console.log('FAIL page errors:'); for (const l of pageErrors.slice(0, 10)) console.log('  ' + l.slice(0, 400)); }
} finally {
  await close();
}
console.log(failures ? `\n${failures} FAILED` : `\nall ${results.length} passed`);
process.exit(failures ? 1 : 0);
