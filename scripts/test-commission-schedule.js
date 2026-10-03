#!/usr/bin/env node
/* test-commission-schedule.js — the OWNER-CONFIRMED commercial schedule (2026-09-28) is what the platform charges.
 *
 *   node scripts/test-commission-schedule.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-commission-schedule.js  # the charging modules @ 4e9607b — failures ARE the stale rates
 *
 * This file is the SPEC: the owner's table written out literally (allow-listed in verify-commission-single-source
 * with that reason). Everything else is read from the REAL charging paths:
 *   commission-config.resolveRate / resolveMarketplaceRate / resolvePosRate · shared/commercial-policy ·
 *   delivery-quote-authority SHARE_MIN/MAX · index.js _is48hCommission · finos-utils.calculateCommission ·
 *   the generated client snapshot · the seller-facing pages.
 * Stale rates it must catch (owner's list): online 5%, food 5%, booking 5% (BnB), healthcare 5%, home-service 15%,
 * delivery 16% floor — plus event 3% and POS following the online rate through an alias.
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), Module = require('module'), os = require('os');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

/* ── load the charging modules: working tree, or 4e9607b copies in a temp dir that mirrors functions/ ── */
function loadAt() {
  if (!CPM) return { dir: FN, rm: () => {} };
  const dir = fs.mkdtempSync(path.join(FN, '.cp-schedule-'));
  const put = (rel) => { const out = path.join(dir, rel); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, cp.execFileSync('git', ['show', '4e9607b:functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })); };
  ['commission-config.js', 'delivery-quote-authority.js', 'money-authority.js', 'vehicle-classes.js', 'shared/commercial-policy.js', 'shared/creator-commercial.js'].forEach((f) => { try { put(f); } catch (e) {} });
  return { dir, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const L = loadAt();
/* In counterproof mode only the RATE authorities are the baseline copies; any other module they require (dispatch,
   money helpers …) that is not copied resolves from the working tree — it holds no rate. */
const _origResolve = Module._resolveFilename;
if (CPM) {
  Module._resolveFilename = function (request, parent, ...rest) {
    try { return _origResolve.call(this, request, parent, ...rest); }
    catch (e) {
      if (parent && parent.filename && parent.filename.startsWith(L.dir) && request.startsWith('.')) {
        const rel = path.relative(L.dir, path.resolve(path.dirname(parent.filename), request));
        return _origResolve.call(this, path.join(FN, rel), parent, ...rest);
      }
      throw e;
    }
  };
}
const req = (rel) => require(path.join(L.dir, rel));
const IDX = CPM ? cp.execFileSync('git', ['show', '4e9607b:functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 }) : fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const page = (f) => (CPM ? cp.execFileSync('git', ['show', '4e9607b:' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));

/* ── THE SPEC: owner-confirmed 2026-09-28 ── */
const SPEC = [
  ['Online product sales',        ['marketplace', 'product', 'products'],        15, 0],
  ['B2B wholesale orders',        ['b2b', 'wholesale', 'b2b_order'],              0, 0],   /* owner 2026-10-03: lead fee, 0% on orders */
  ['Food ordered online',         ['food_delivery', 'food', 'restaurant'],       15, 0],
  ['Digital products',            ['digital_products', 'digital'],               10, 0],
  ['POS / Till / Quick Charge',   ['pos', 'till', 'quick_charge'],                5, 0],
  ['Event tickets',               ['event_tickets'],                              5, 0],
  ['BnB / hotel bookings',        ['hotel', 'bnb'],                              15, 0],
  ['Healthcare bookings',         ['healthcare'],                                 5, 0],   /* owner 2026-10-03: 5% (was 12%) */
  ['Healthcare product sales',    ['pharmacy', 'healthcare_products'],           15, 0],
  ['Home services',               ['home_services'],                              5, 0],   /* owner 2026-10-03: every service booking 5% (was 14%) */
  ['Car rental',                  ['car-rental', 'car_rental'],                   5, 0],   /* owner 2026-10-03: 5% like every service booking (was 16%) */
  ['Entertainment bookings',      ['entertainment_bookings'],                     5, 0],
  ['Legal bookings',              ['legal'],                                      5, 0],
  ['Other service bookings',      ['services', 'fitness', 'insurance'],           5, 0],
  ['Education',                   ['education'],                                 15, 0],
  ['Car Hub vehicle sales (2%)',  ['vehicles', 'car_hub', 'car_dealer'],         2, 0],   /* owner 2026-10-03: 2% of the sale price (was KES 2,000 flat) */
  ["SOKONI's own plans",          ['subscriptions', 'subscription'],            100, 0],
];

(async () => {
  console.log('\nSOURCE: ' + (CPM ? '4e9607b (before) — failures below ARE the stale schedule' : 'working tree (owner schedule 2026-09-28)'));
  try {
    const CC = req('commission-config.js');

    /* S1 — every row, through the authority's only reader */
    for (const [label, keys, pct, fixed] of SPEC) {
      const got = keys.map((k) => { const r = CC.resolveRate(k); return { k, pct: r.pct, fixedKES: r.fixedKES || 0, matched: r.matched }; });
      ck(`S1  ${label}: ${fixed ? 'KES ' + fixed + ' flat' : pct + '%'}`, got.every((g) => g.matched !== false && g.pct === pct && g.fixedKES === fixed), got);
    }

    /* S2 — the online lane and the POS lane, and that they are DECOUPLED */
    ck('S2  online-sale lane (resolveMarketplaceRate) is 15% for every plan', ['free', 'professional', 'business', 'enterprise', null].every((p) => CC.resolveMarketplaceRate(p).pct === 15));
    ck('S2b POS lane (resolvePosRate) is 5% for every plan', ['seller_free', 'seller_pro', null].every((p) => CC.resolvePosRate(p).pct === 5));
    ck('S2c POS does NOT resolve through the online-sale category (raising online can never raise the till)', CC.resolveRate('pos').category !== CC.resolveRate('marketplace').category, { pos: CC.resolveRate('pos').category });

    /* S3 — the event-ticket policy used by event sales / settlement reads the schedule */
    const POLICY = req('shared/commercial-policy.js');
    ck('S3  event sales / settlement policy (commercial-policy event_ticket) charges 5%', POLICY.policyFor({ policyKey: 'event_ticket' }).pct === 5, POLICY.policyFor({ policyKey: 'event_ticket' }).pct);

    /* S4 — delivery: the dynamic share is kept, inside 17–25% */
    const DQ = req('delivery-quote-authority.js');
    ck('S4  delivery: SOKONI share band is 17–25% (floor corrected from 16%), dynamic model kept', DQ.SHARE_MIN_PCT === 17 && DQ.SHARE_MAX_PCT === 25 && typeof DQ._internal.deriveSharePct === 'function', { min: DQ.SHARE_MIN_PCT, max: DQ.SHARE_MAX_PCT });

    /* S5 — POS keeps its 48-hour settlement term after leaving the marketplace alias */
    const start = IDX.indexOf('function _is48hCommission(hub) {');
    let is48 = null;
    if (start >= 0) {
      let d = 0, i = IDX.indexOf('{', start);
      for (; i < IDX.length; i++) { if (IDX[i] === '{') d++; else if (IDX[i] === '}' && --d === 0) break; }
      const src = IDX.slice(start, i + 1).replace(/require\("\.\/commission-config"\)/g, '__CC');
      is48 = new Function('__CC', src + '\nreturn _is48hCommission;')(CC);
    }
    ck('S5  settlement term: POS / Till / Quick Charge and online sales stay 48-hour; bookings stay monthly',
      !!is48 && ['pos', 'till', 'quick_charge', 'marketplace', 'product'].every((h) => is48(h) === true) && ['services', 'hotel', 'healthcare', 'event_tickets'].every((h) => is48(h) === false));

    /* S6 — the real engine: calculateCommission on an empty ledger config */
    {
      const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
      const { db } = makeFakeFirestore({});
      const orig = Module._load;
      Module._load = function (r, p) { if (/commission-config$/.test(r)) return CC; return orig.apply(this, arguments); };
      let FU = null, err = null;
      try { delete require.cache[require.resolve(path.join(FN, 'finos-utils.js'))]; FU = require(path.join(FN, 'finos-utils.js')); } catch (e) { err = e.message; }
      const out = {};
      if (FU) {
        for (const [cat, amt] of [['pos', 100000], ['product', 100000], ['car-rental', 100000], ['hotel', 100000], ['healthcare', 100000], ['vehicles', 180000000]]) {
          try { const c = await FU.calculateCommission(db, { orderAmountCents: amt, category: cat, sellerId: null }); out[cat] = c.commissionCents != null ? c.commissionCents : Math.round((c.commission || 0) * 100); } catch (e) { out[cat] = 'ERR ' + e.message; }
        }
      }
      Module._load = orig;
      ck('S6  calculateCommission charges the schedule end-to-end (KES 1,000: POS 50, online 150, car rental 50, BnB 150, healthcare 50; a KES 1.8M vehicle KES 36,000 at 2%)',
        out.pos === 5000 && out.product === 15000 && out['car-rental'] === 5000 && out.hotel === 15000 && out.healthcare === 5000 && out.vehicles === 3600000, err || out);
    }
  } finally { L.rm(); }

  /* S7 — the client snapshot the seller-facing pages read is regenerated from the authority */
  if (!CPM) {
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-commission-snapshot.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    ck('S7  sokoni-commission-rates.js (SokoniCommission.pct on 47 pages) matches the authority', r.status === 0, (r.stdout + r.stderr).slice(-200));
  } else {
    const snap = page('sokoni-commission-rates.js');
    ck('S7  sokoni-commission-rates.js carries the schedule', /"marketplace":\s*\{\s*"pct":\s*15/.test(snap) && /"hotel":\s*\{\s*"pct":\s*15/.test(snap));
  }

  /* S8 — seller-facing text states the schedule, not the old rates */
  const stale = [];
  if (/12% platform fee/.test(page('legal.html'))) stale.push('legal.html: 12% platform fee');
  if (/after 12% platform fee/.test(page('invoice.html'))) stale.push('invoice.html: after 12% platform fee');
  if (/charges 3% per ticket/.test(page('entertainment-terms.html'))) stale.push('entertainment-terms.html: 3% per ticket');
  if (/SOKONI_COMMISSION_RATE\s*=\s*0\.02/.test(page('landlord.html'))) stale.push('landlord.html: 2% commission on rent');
  if (/Keep up to 95%/.test(page('digital-esoko.html'))) stale.push('digital-esoko.html: keep up to 95%');
  const terms = page('seller-terms.html');
  const want = [['Online product sales', '15%'], ['POS / Till / Quick Charge', '5%'], ['Food ordered online', '15%'], ['Event tickets', '5%'], ['BnB / hotel bookings', '15%'], ['Healthcare bookings', '5%'], ['Healthcare product sales', '15%'], ['Car Hub vehicle sales', '2%']];
  for (const [row, rate] of want) { const re = new RegExp('<strong>' + row.replace(/[/()]/g, '\\$&') + '[^<]*</strong>[^\\n]*?<td>' + rate.replace(/[,.%]/g, '\\$&')); if (!re.test(terms)) stale.push('seller-terms.html: ' + row + ' ≠ ' + rate); }
  if (/<td>Pro<\/td><td><strong>5%<\/strong>/.test(terms)) stale.push('seller-terms.html: retired plan ladder');
  ck('S8  seller-facing pages state the schedule (legal, invoice, terms, entertainment terms, digital, landlord)', stale.length === 0, stale);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { try { L.rm(); } catch (_) {} console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
