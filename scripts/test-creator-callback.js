/* test-creator-callback.js — the payment CALLBACK audit, by execution.
 *
 * Runs the REAL webhookIntasend (scripts/lib/webhook-harness.js, one fresh
 * process per scenario, transactional fake, no network) on:
 *   BRANCH  this tree
 *   BASE    the pre-Creator tree (a38b31a), CREATOR_BASE_TREE or C:/temp/sok-creator-base2
 * and proves:
 *   film         → payment COMPLETE, NO wallet / walletTransactions / commissionLedger /
 *                  ledger write, Creator royalty accrual ONLY, SOKONI = 30 % of NET,
 *                  replay = one allocation
 *   film, early intent read FAILS → the second exit still routes it (no credit)
 *   marketplace · POS till · subscription · wallet top-up → store BYTE-IDENTICAL
 *                  to BASE except the additive payments.providerReport
 *   POSITIVE CONTROL: BASE credits the BUYER on a film payment — the harness can
 *                  see a wrong credit, so "no credit" on the branch is evidence
 *
 *   node scripts/test-creator-callback.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.CREATOR_BASE_TREE || 'C:/temp/sok-creator-base2';
const HARNESS = path.join(__dirname, 'lib', 'webhook-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 120) + ']' : '')); ok ? pass++ : fail++; };

function run(tree, scenario, env = {}) {
  const r = spawnSync(process.execPath, [HARNESS, tree, scenario], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch (_) { return { crashed: 'no JSON: ' + (r.stderr || r.stdout || '').slice(-300) }; }
}
/* BASE never changes for a given base sha — cache it. */
function runBase(scenario, n = 0) {
  const sha = spawnSync('git', ['-C', BASE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const cache = path.join(os.tmpdir(), `creator-callback-base-${sha}-${scenario}-${n}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const r = run(BASE, scenario);
  if (!r.crashed) fs.writeFileSync(cache, JSON.stringify(r));
  return r;
}
const paths = (st, re) => Object.keys(st || {}).filter((k) => re.test(k));
/* NOISE = fields that differ between two runs of the SAME base code (wall-clock
   date strings, random delivery PINs, timing ms). Only those are masked; every
   other field must match exactly. */
/* Timing / wall-clock fields in NON-money documents are noise by nature; money
   documents are never masked. */
const TIMING = /(Ms|DurationMs|At|date|timeline|proofPin)$/;
const MONEY = /^(wallets|walletTransactions|commissionLedger|ledger|orders|products|payments|royalty)/;
function noiseOf(a, b) {
  const n = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (MONEY.test(k)) continue;
    for (const fld of Object.keys(Object.assign({}, (a || {})[k], (b || {})[k]))) if (TIMING.test(fld)) (n[k] = n[k] || new Set()).add(fld);
  }
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = (a || {})[k] || {}, y = (b || {})[k] || {};
    for (const fld of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[fld]) !== JSON.stringify(y[fld])) (n[k] = n[k] || new Set()).add(fld);
  }
  return n;
}
function normalized(st, noise = {}) {
  const o = JSON.parse(JSON.stringify(st || {}));
  for (const k of Object.keys(o)) {
    if (k.startsWith('payments/')) delete o[k].providerReport;
    for (const fld of (noise[k] || [])) delete o[k][fld];
  }
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

console.log('\n── trees ──');
const baseOk = fs.existsSync(path.join(BASE, 'functions', 'index.js')) && fs.existsSync(path.join(BASE, 'functions', 'node_modules'));
ck(`BASE tree present (${BASE})`, baseOk, baseOk ? '' : 'create: git worktree add --detach <path> a38b31a + functions/node_modules junction');
if (!baseOk) { console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n'); process.exit(2); }
ck('BASE has no Creator module (it is the pre-change webhook)', !fs.existsSync(path.join(BASE, 'functions', 'creator-hub.js')));

console.log('\n── POSITIVE CONTROL: base misroutes a film payment ──');
const bFilm = runBase('film');
ck('base film run completed', !bFilm.crashed, bFilm.crashed);
const bw = bFilm.store && bFilm.store['wallets/buyer1'];
ck('BASE credits the BUYER\'s wallet on a film payment (the defect)', !!bw && bw.availableBalance > 0, bw && JSON.stringify(bw));
ck('BASE writes a marketplace commissionLedger row for the film', paths(bFilm.store, /^commissionLedger\//).length === 1);

for (const sc of ['film', 'filmIntentReadFails', 'filmHosted']) {
  console.log(`\n── branch: ${sc} ──`);
  const r = run(ROOT, sc, sc === 'filmIntentReadFails' ? { FAIL_INTENT_READ_AT: '2' } : {});
  ck(`${sc}: handler ran (200, replay 200)`, !r.crashed && JSON.stringify(r.calls) === '[200,200]', r.crashed || JSON.stringify(r.calls));
  if (r.crashed) continue;
  const st = r.store;
  ck(`${sc}: NO wallet written (buyer, creator or anyone)`, paths(st, /^wallets\//).length === 0, paths(st, /^wallets\//).join(','));
  ck(`${sc}: NO walletTransactions`, paths(st, /^walletTransactions\//).length === 0);
  ck(`${sc}: NO marketplace commissionLedger`, paths(st, /^commissionLedger\//).length === 0);
  ck(`${sc}: NO FinOS ledger rows`, paths(st, /^ledger\//).length === 0);
  const pay = st[`payments/${r.ref}`];
  ck(`${sc}: payment COMPLETE with providerReport (fee evidence)`, pay.status === 'COMPLETE' && pay.providerReport && pay.providerReport.charges === 15);
  ck(`${sc}: entitlement granted`, (r.royalty.activation || {}).activated === true);
  const acc = st[`royaltyAccruals/acc_${r.ref}`];
  ck(`${sc}: royalty accrued under the Creator policy`, acc && acc.policyId === 'creator_ppv_v1' && acc.commissionBps === 3000 && acc.poolBps === 7000);
  const com = st[`royaltyLedger/platform_commission_${r.ref}`];
  ck(`${sc}: SOKONI = 30% of NET (500 − 15 = 485 → 145.50)`, com && com.amountCents === 14550, com && com.amountCents);
  ck(`${sc}: creator pool = 70% of NET (339.50)`, acc && acc.poolCents === 33950);
  const earn = paths(st, /^royaltyLedger\/earn_/).map((k) => st[k].amountCents);
  ck(`${sc}: participants split the pool exactly (7000/3000 → 237.65 / 101.85)`, earn.reduce((a, b) => a + b, 0) === 33950 && earn.includes(23765) && earn.includes(10185), earn.join(','));
  ck(`${sc}: replay → alreadyAccrued, still ONE allocation`, r.royalty.replay.royalty.alreadyAccrued === true && paths(st, /^royaltyLedger\//).length === 4);
  ck(`${sc}: no outbound network`, r.outbound.length === 0);
  const early = r.logs.some((l) => /royalty path, no seller credit/.test(l));
  const second = r.logs.some((l) => /reached the seller path/.test(l));
  if (sc === 'film' || sc === 'filmHosted') ck(sc + ': routed by the EARLY branch', early && !second, r.logs.join(' || ').slice(0, 200));
  else ck('filmIntentReadFails: early branch LOST its read and the SECOND exit fired', !early && second && r.logs.some((l) => /purpose check failed/.test(l)), r.logs.join(' || ').slice(0, 200));
}

console.log('\n── other domains: byte-identical to BASE (except providerReport) ──');
for (const sc of ['marketplace', 'pos', 'subscription', 'topup']) {
  const b = runBase(sc, 0), b2 = runBase(sc, 1), r = run(ROOT, sc);
  ck(`${sc}: both trees ran`, !b.crashed && !b2.crashed && !r.crashed, b.crashed || b2.crashed || r.crashed);
  if (b.crashed || b2.crashed || r.crashed) continue;
  const noise = noiseOf(b.store, b2.store);
  const noiseList = Object.entries(noise).map(([k, v]) => k.split('/')[0] + '.' + [...v].join('+'));
  ck(`${sc}: base self-noise measured (${noiseList.length ? noiseList.join(', ') : 'none'})`, noiseList.every((x) => !/^(wallets|walletTransactions|commissionLedger|ledger|orders|products)\./.test(x)), 'money docs must never be noisy');
  const same = normalized(b.store, noise) === normalized(r.store, noise);
  let diff = '';
  if (!same) { const bs = b.store, rs = r.store; diff = [...new Set([...Object.keys(bs), ...Object.keys(rs)])].filter((k) => JSON.stringify(bs[k]) !== JSON.stringify(rs[k]) && !k.startsWith('payments/')).slice(0, 4).join(','); }
  ck(`${sc}: store identical to BASE`, same, diff);
  ck(`${sc}: no Creator royalty rows`, paths(r.store, /^royalty|^contentEntitlements\//).length === 0);
  if (sc === 'marketplace') {
    ck('marketplace: SELLER credited (unchanged behaviour)', (r.store['wallets/seller1'] || {}).availableBalance > 0);
    ck('marketplace: buyer NOT credited', !r.store['wallets/buyer1']);
  }
  if (sc === 'pos') ck('pos: till merchant credited (unchanged behaviour)', (r.store['wallets/merchant1'] || {}).availableBalance > 0);
  if (sc === 'topup') ck('topup: wallet 50 → 250 exactly once (replay safe)', (r.store['wallets/user1'] || {}).balance === 250);
  if (sc !== 'topup') ck(`${sc}: providerReport is the ONLY payment-doc difference`, (() => { const k = `payments/${r.ref}`; const x = { ...r.store[k] }, y = { ...b.store[k] }; delete x.providerReport; return JSON.stringify(x) === JSON.stringify(y) && !!r.store[k].providerReport; })());
}

console.log('\n── commission authority ──');
{
  const cc = require(path.join(ROOT, 'functions', 'commission-config.js'));
  ck('ordinary marketplace commission is still 5%', cc.RATES.marketplace.pct === 5);
  ck('legacy ppv rate untouched (15%) — Creator does not use it', cc.RATES.ppv.pct === 15);
  const diffCC = spawnSync('git', ['-C', ROOT, 'diff', '--quiet', 'a38b31a', '--', 'functions/commission-config.js']).status;
  ck('commission-config.js byte-identical to base a38b31a', diffCC === 0);
  const C = require(path.join(ROOT, 'functions', 'shared', 'creator-commercial.js'));
  const R = require(path.join(ROOT, 'functions', 'shared', 'creator-royalty.js'));
  const saved = cc.RATES.ppv.pct; cc.RATES.ppv.pct = 99;
  const a = R.computePool({ grossCents: 50000, providerFeeCents: 2000, policy: C.policyFor({}) });
  cc.RATES.ppv.pct = saved;
  ck('changing commission-config ppv cannot move the Creator split', a.commissionCents === 14400 && a.poolCents === 33600);
  let threw = false; try { 'use strict'; C.CREATOR_PPV.sokoniCommissionBps = 1; } catch (_) { threw = true; }
  ck('Creator policy is immutable at runtime', C.CREATOR_PPV.sokoniCommissionBps === 3000);
  void threw;
  ck('marketplace rate unaffected by the Creator policy', cc.RATES.marketplace.pct === 5);
  const creatorFiles = ['functions/creator-hub.js', 'functions/shared/creator-royalty.js', 'functions/shared/creator-commercial.js', 'creator.html', 'creator-studio.html', 'sokoni-aos-creator.js'];
  const hits = creatorFiles.filter((f) => { const s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); return /0\.15\b|RATES\.ppv|require\(['"][./]*commission-config|category:\s*['"]ppv['"]/.test(s); });
  ck('no hard-coded 0.15 / RATES.ppv / ppv category in any Creator payment path', hits.length === 0, hits.join(','));
  const pp = fs.readFileSync(path.join(ROOT, 'functions', 'payment-purposes.js'), 'utf8');
  const film = pp.slice(pp.indexOf('film_access: {'), pp.indexOf('film_access: {') + 400);
  ck('film_access pricer carries no rate', !/0\.15|pct|RATES|commission/.test(film));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
