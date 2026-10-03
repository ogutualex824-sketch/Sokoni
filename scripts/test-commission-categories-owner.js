#!/usr/bin/env node
'use strict';
/* OWNER CATEGORY RULES + RESTRICTED + NO GENERIC DEFAULT (owner 2026-10-03, via sokoni-b2)
     C1  the 14 production categories that fell to the 5% default now resolve EXPLICITLY: fashion/furniture/books/appliances/
         beauty/shoes → marketplace 15%; cars → vehicles; laundry / hair-beauty → services 5%; dj → entertainment bookings
     C2  Car Hub: vehicles 2% (sales only), cars → vehicles, car_rental stays 5%
     C3  vape / alcohol / tobacco / adult (and re-spellings / combinations) are RESTRICTED: resolveRate refuses, the real
         engine throws category_restricted — never priced
     C4  no RATES key and no alias is a restricted term (a restricted category is never mapped to a commission row)
     C5  NO generic default: RATES.default is gone; an unknown category resolves to {matched:false, pct:null} and the real
         engine throws category_unpriced — never 5%
     C6  every KASS / commercial-policy key still resolves explicitly (nothing silently relied on the default)
     C7  the client rate file renders an unknown category as null ("—"), never 5%
     C8  onSellerPaymentCreated (post-payment) FLAGS an unresolved category for review instead of inventing a rate
   NODE_PATH=<functions/node_modules> node scripts/test-commission-categories-owner.js */
const path = require('path'), fs = require('fs'), Module = require('module'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 260))); ok ? pass++ : fail++; };
const CC = require(path.join(FN, 'commission-config.js'));
const RC = require(path.join(FN, 'shared/restricted-categories.js'));
const orig = Module.prototype.require;
Module.prototype.require = function (id) { if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) }; return orig.apply(this, arguments); };
const FU = require(path.join(FN, 'finos-utils.js'));
Module.prototype.require = orig;
const emptyQ = () => ({ where: () => emptyQ(), orderBy: () => emptyQ(), limit: () => emptyQ(), get: async () => ({ empty: true, docs: [], forEach () {} }) });
const db = { collection: () => Object.assign(emptyQ(), { doc: () => ({ async get () { return { exists: false, data: () => undefined }; } }) }) };
const engine = (category) => FU.calculateCommission(db, { orderAmountCents: 1000000, category, sellerId: 'S1' }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code }));

(async () => {
  const expect = { fashion: ['marketplace', 15], furniture: ['marketplace', 15], books: ['marketplace', 15], appliances: ['marketplace', 15], beauty: ['marketplace', 15],
    shoes: ['marketplace', 15], cars: ['vehicles', 2], laundry: ['services', 5], 'hair-beauty': ['services', 5], dj: ['entertainment_bookings', 5] };
  const bad = Object.entries(expect).filter(([k, [c, p]]) => { const r = CC.resolveRate(k); return !(r.matched && r.category === c && r.pct === p); });
  ck('C1 the 10 priced production categories resolve explicitly per the owner (retail 15%, cars→vehicles 2%, services 5%, dj→entertainment)', bad.length === 0, bad);
  ck('C2 Car Hub: vehicles 2% · cars → vehicles · car_rental 5%', CC.resolveRate('vehicles').pct === 2 && CC.resolveRate('cars').category === 'vehicles' && CC.resolveRate('car_rental').pct === 5);
  const restricted = ['vape', 'alcohol', 'tobacco', 'adult', 'Vape Pods', 'Beer & Wine', 'cigarettes', 'nicotine pouches', 'adult/sexual-wellness', 'Sex Toys', 'e-liquid'];
  const rres = []; for (const c of restricted) { const r = CC.resolveRate(c); const e = await engine(c); rres.push([c, r.restricted === true && r.pct === null, e.code]); }
  ck('C3 restricted (incl. re-spellings / combinations) → resolveRate restricted, engine throws category_restricted', rres.every(([, a, code]) => a && code === 'category_restricted'), rres);
  const mapped = [...Object.keys(CC.RATES), ...Object.keys(CC.ALIASES || {})].filter((k) => RC.isRestricted(k));
  ck('C4 no commission row and no alias is a restricted term', mapped.length === 0, mapped);
  const u = CC.resolveRate('zzz-not-a-category'), ue = await engine('zzz-not-a-category'), pe = CC.resolveRate('product');
  ck('C5 NO generic default: RATES.default absent; unknown → {matched:false, pct:null}; engine refuses category_unpriced; the checkout label "product" is an EXPLICIT marketplace alias (5b: product orders = marketplace by purpose)',
    !('default' in CC.RATES) && u.matched === false && u.pct === null && ue.code === 'category_unpriced' && pe.matched && pe.category === 'marketplace', { u, ue, pe });
  const kassSrc = fs.readFileSync(path.join(FN, 'kass-commission.js'), 'utf8');
  const kassKeys = [...kassSrc.matchAll(/key:\s*'([a-z0-9_-]+)'/g)].map((m) => m[1]);
  const polKeys = ['event_tickets', 'ppv', 'entertainment_bookings', 'digital_products', 'marketplace', 'services', 'pos'];
  const unresolved = [...kassKeys, ...polKeys].filter((k) => !CC.resolveRate(k).matched);
  ck('C6 every KASS / commercial-policy key resolves explicitly (' + kassKeys.length + ' KASS keys)', kassKeys.length > 5 && unresolved.length === 0, unresolved);
  const snap = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
  const sb = { window: {}, document: { querySelectorAll: () => [], addEventListener () {} }, console };
  try { vm.runInNewContext(snap, sb); } catch (_) {}
  const SC = sb.window.SokoniCommission;
  ck('C7 client rate file: unknown → null ("—"), never 5%; marketplace 15%', SC && SC.pct('zzz-unknown') === null && SC.pct('marketplace') === 15 && SC.pct('fashion') === 15, SC && [SC.pct('zzz-unknown'), SC.pct('marketplace')]);
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8'); const k = idx.indexOf('exports.onSellerPaymentCreated'); const body = idx.slice(k, k + 3000);
  ck('C8 onSellerPaymentCreated flags category_unpriced / category_restricted to commissionReviewQueue and returns (post-payment: never invents, never rejects)',
    /catch \(e\)[\s\S]{0,200}category_unpriced[\s\S]{0,120}category_restricted[\s\S]{0,300}commissionReviewQueue/.test(body));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
