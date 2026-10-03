#!/usr/bin/env node
'use strict';
/* Construction commercial rows (owner 2026-10-03, via sokoni-f3)
     K1  every construction MATERIAL label → marketplace 15% (never the 5% default)
     K2  contractor work (contractor / welding / fabrication / *-contractor) → construction_service 0%, FIXED + floor-exempt
     K3  the real engine: a KES 100,000 contract → commission 0 even with seller + global revenueConfig overrides
     K4  equipment rental / featured / delivery margin are UNPRICED: the engine REFUSES them (code category_unpriced) —
         never 0%, never the default
     K5  no bare 'service' / 'job' alias was introduced; existing hubs keep their rates; bare 'services' still 5%
     K6  a KES 10,000 cement order through the real engine → 15% (KES 1,500)
   NODE_PATH=<functions/node_modules> node scripts/test-construction-commercial.js */
const path = require('path'), Module = require('module');
const FN = path.join(path.resolve(__dirname, '..'), 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
const CC = require(path.join(FN, 'commission-config.js'));
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) };
  return orig.apply(this, arguments);
};
const FU = require(path.join(FN, 'finos-utils.js'));
Module.prototype.require = orig;
const ovDocs = { 'revenueConfig/seller_S1': { commissionPct: 12 }, 'revenueConfig/global': { commissionPct: 9 } };
const db = { collection: (n) => ({ doc: (id) => ({ async get () { const d = ovDocs[n + '/' + id]; return d ? { exists: true, data: () => d } : { exists: false, data: () => undefined }; } }), where () { return this; },
  async get () { return { empty: true, docs: [], forEach () {} }; } }) };

(async () => {
  const mats = ['cement', 'steel', 'timber', 'roofing', 'bricks', 'tiles', 'paint', 'plumbing-materials', 'electrical-materials', 'windows-doors', 'construction-tools', 'sand-gravel', 'safety-ppe', 'building-materials', 'hardware', 'construction'];
  ck('K1 every material label → marketplace 15% (matched)', mats.every((k) => { const r = CC.resolveRate(k); return r.matched && r.category === 'marketplace' && r.pct === 15; }), mats.filter((k) => CC.resolveRate(k).category !== 'marketplace'));
  const svc = ['contractor', 'welding', 'fabrication', 'electrical-contractor', 'plumbing-contractor', 'construction-contractor', 'construction_service'];
  ck('K2 contractor work → construction_service 0%, fixed + floor-exempt', svc.every((k) => { const r = CC.resolveRate(k); return r.category === 'construction_service' && r.pct === 0 && CC.isFixedRateCategory(k) && CC.isFloorExemptFixedCategory(k); }));
  const c = await FU.calculateCommission(db, { orderAmountCents: 10000000, category: 'welding', sellerId: 'S1' });
  ck('K3 real engine: KES 100,000 welding contract → 0 commission despite 12% / 9% overrides (no % of contract value)', c.commissionCents === 0, { cents: c.commissionCents, rate: c.effectiveRate });
  const refusedCodes = [];
  for (const k of ['equipment-rental', 'plant-hire', 'construction_featured', 'construction_delivery_margin']) {
    try { await FU.calculateCommission(db, { orderAmountCents: 500000, category: k, sellerId: 'S1' }); refusedCodes.push('PRICED:' + k); } catch (e) { refusedCodes.push(e.code); }
  }
  ck('K4 equipment rental / featured / delivery margin are REFUSED (category_unpriced), never 0% or default', refusedCodes.every((x) => x === 'category_unpriced'), refusedCodes);
  ck('K5 no bare service / job alias; services 5%, jobs 0% unchanged', !CC.resolveRate('service').matched && !CC.resolveRate('job').matched && CC.resolveRate('services').pct === 5 && CC.resolveRate('jobs').pct === 0);
  const m = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'cement', sellerId: 'S2' });
  ck('K6 real engine: KES 10,000 cement → KES 1,500 (15%)', m.commissionCents === 150000 && m.effectiveRate === 15, { cents: m.commissionCents, rate: m.effectiveRate });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
