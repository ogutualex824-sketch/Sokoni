#!/usr/bin/env node
'use strict';
/**
 * CERTIFICATION — the browser quotes exactly what the server resolves (commission rates).
 *
 *   node scripts/test-commission-browser-parity.js
 *
 * The defect: the generated `sokoni-commission-rates.js` returned `undefined` from
 * marketplacePct() for 11 of 15 plan spellings. The table had been regenerated with the renamed
 * plans (free / professional / business / enterprise) while the generator's hand-written lookup
 * still mapped to the retired `seller_*` keys. `build-commission-snapshot.js --check` said "in
 * sync" throughout, because it compared text produced by the same stale template.
 *
 * This loads the COMMITTED browser file the way a page does and compares its ANSWERS with the
 * server's resolver (functions/commission-config.js). Every expectation comes from the server —
 * there is no rate literal in this file. Fallbacks are kept as three SEPARATE classes, because
 * collapsing them is what confused the old H5 check:
 *   1. a known plan under another name (`business` is canonical; `seller_pro` aliases to it)
 *   2. a GENUINELY unknown plan  -> the server's default plan, which must be the highest rate
 *   3. empty / absent / non-string -> whatever the server explicitly resolves it to
 *
 * Source/build certification only: nothing here deploys, and the committed file is never written.
 * No emulator, no network.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CC = require(path.join(ROOT, 'functions', 'commission-config.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 170) + ']' : ''));
  ok ? pass++ : fail++;
};

const src = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox, { timeout: 2000 });
const S = sandbox.window.SokoniCommission;
const srv = (p) => CC.resolveMarketplaceRate(p);
/* Read the browser defensively: an OLD snapshot has no marketplacePlan(), and a crash is not a
   verdict. A missing function answers {plan: undefined, matched: undefined}, which every
   assertion below then reports as the disagreement it is. */
const bPlan = (p) => (S && typeof S.marketplacePlan === 'function') ? S.marketplacePlan(p) : { plan: undefined, matched: undefined };
const bPct = (p) => (S && typeof S.marketplacePct === 'function') ? S.marketplacePct(p) : undefined;
const q = (p) => JSON.stringify(p);

console.log('\nPART P0 — the browser file is the one a page loads\n');
ck('P0  the committed snapshot evaluates and exposes the marketplace lane API',
  !!S && typeof S.marketplacePct === 'function' && typeof S.marketplacePlan === 'function' && typeof S.posPct === 'function');

console.log('\nPART P1 — every CANONICAL plan: same rate, same plan, recognised\n');
const canonical = Object.keys(CC.MARKETPLACE_PLAN_RATES);
for (const p of canonical) {
  const s = srv(p), b = bPlan(p);
  ck(`P1  ${p.padEnd(14)} browser ${bPct(p)}% = server ${s.pct}%, plan ${b.plan}, recognised`,
    bPct(p) === s.pct && b.plan === s.plan && b.matched === true && s.matched === true);
}

console.log('\nPART P2 — every other spelling the SERVER knows (its alias table)\n');
{
  /* The server's alias table is read from the real config source (it is not exported), exactly
     as the generator does — so this checks the browser against the server, not against itself. */
  const Module = require('module');
  const file = path.join(ROOT, 'functions', 'commission-config.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file, 'utf8') + '\n;module.exports.__T__ = MARKETPLACE_TIER_ALIASES;\n', file);
  const serverAliases = Object.keys(m.exports.__T__);
  const bad = serverAliases.filter((p) => {
    const s = srv(p), b = bPlan(p);
    return bPct(p) !== s.pct || b.plan !== s.plan || b.matched !== s.matched || s.matched !== true;
  });
  ck(`P2  all ${serverAliases.length} server alias spellings resolve identically in the browser`, bad.length === 0,
    bad.map((p) => p + ': browser ' + bPct(p) + '/' + bPlan(p).plan + ' vs server ' + srv(p).pct + '/' + srv(p).plan).join('; ')
    || serverAliases.join(' '));
  const extra = Object.keys(S.MARKETPLACE_TIER_ALIASES || {}).filter((k) => !serverAliases.includes(k));
  ck('P2b the browser knows NO spelling the server does not (it cannot quote a plan the server would not)',
    extra.length === 0, extra.join(', '));
  const retired = ['seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise'];
  ck('P2c the retired seller_* ids are recognised plans on BOTH sides (the 11-of-15 undefined bug)',
    retired.every((p) => srv(p).matched && bPlan(p).matched && bPct(p) === srv(p).pct),
    retired.map((p) => p + '=' + bPct(p)).join(' '));
}

console.log('\nPART P3 — the three fallback classes, kept separate\n');
{
  /* 1. `business` is a KNOWN canonical plan — not an unknown one (the old H5 premise). */
  const sb = srv('business'), bb = bPlan('business');
  ck('P3a business is a KNOWN canonical plan on both sides, priced at its own rate',
    sb.matched === true && bb.matched === true && sb.plan === 'business' && bb.plan === 'business'
      && bPct('business') === CC.MARKETPLACE_PLAN_RATES.business.rateFraction * 100,
    `server ${sb.plan}/${sb.matched}, browser ${bb.plan}/${bb.matched}, ${bPct('business')}%`);

  /* 2. A GENUINELY unknown plan -> the server's default plan, which must be the HIGHEST rate. */
  const highest = Math.max(...canonical.map((p) => CC.MARKETPLACE_PLAN_RATES[p].rateFraction * 100));
  const unknowns = ['platinum', 'zz-unknown-plan', 'seller_gold'];
  const unkBad = unknowns.filter((p) => {
    const s = srv(p), b = bPlan(p);
    return s.matched !== false || b.matched !== false || s.plan !== CC.MARKETPLACE_DEFAULT_PLAN
      || b.plan !== s.plan || bPct(p) !== s.pct || s.pct !== highest;
  });
  ck(`P3b a genuinely unknown plan is UNRECOGNISED on both sides and quotes the default = highest rate (${highest}%)`,
    unkBad.length === 0, unkBad.join(', ') || unknowns.map((p) => p + '->' + bPlan(p).plan).join(' '));

  /* 3. Empty / absent / non-string -> whatever the SERVER explicitly resolves it to. */
  const empties = ['', '   ', null, undefined, 0, 123];
  const empBad = empties.filter((p) => {
    const s = srv(p), b = bPlan(p);
    return b.plan !== s.plan || b.matched !== s.matched || bPct(p) !== s.pct;
  });
  ck('P3c empty / absent / non-string input resolves exactly as the server defines it',
    empBad.length === 0,
    empBad.map(q).join(', ') || empties.map((p) => q(p) + '->' + srv(p).plan + '/' + srv(p).matched).join(' '));

  const all = [...canonical, 'business', ...unknowns, ...empties, 'seller_free', 'basic', 'pro', 'starter', 'growth'];
  ck('P3d the browser NEVER returns undefined for any plan input', all.every((p) => typeof bPct(p) === 'number'));
}

console.log('\nPART P4 — the rest of the lane\n');
ck('P4a POS / till rate: browser = server', S.posPct() === CC.resolvePosRate(CC.POS_DEFAULT_PLAN).pct,
  S.posPct() + ' vs ' + CC.resolvePosRate(CC.POS_DEFAULT_PLAN).pct);
ck('P4b minimum commission: browser = server', S.MIN_COMMISSION_KES === CC.MIN_COMMISSION_KES,
  S.MIN_COMMISSION_KES + ' vs ' + CC.MIN_COMMISSION_KES);
{
  const cats = ['marketplace', 'product', 'products', 'shopping', 'b2b', 'pos', 'food', 'zzz'];
  const bad = cats.filter((c) => S.isMarketplaceSellerSale(c) !== CC.isMarketplaceSellerSale(c));
  ck('P4c which categories are marketplace seller sales: browser = server (pos excluded on both)', bad.length === 0, bad.join(', '));
}

console.log('\nPART P5 — the build guard now checks ANSWERS, not only text\n');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-commission-snapshot.js'), '--check'], { encoding: 'utf8' });
  ck('P5  build-commission-snapshot --check passes on the committed file (text and answers)',
    r.status === 0 && /text and answers/.test(r.stdout), (r.stdout + r.stderr).trim());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
