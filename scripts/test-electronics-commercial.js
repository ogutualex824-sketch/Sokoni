#!/usr/bin/env node
'use strict';
/* ============================================================================
   Electronics commercial policy (owner 2026-10-03)
     E1  electronics / phones / laptops / tablets / device accessories → an EXPLICIT 'electronics' row at 15% — never the 5% default
     E2  the REAL calculateCommission prices a KES 100,000 phone at 15% (KES 15,000) and records policyVersion + resolvedCategory
     E3  electronics keeps the 48h per-sale commission term of marketplace product sales
     E4  plans: Free 50 listings, then the retail ladder (Basic 100 / Pro 500 / Enterprise unlimited, retail prices)
     E5  entitlements: 51st listing on Free → Basic; 101st on Basic → Pro; Enterprise unlimited
     E6  the ledger writer copies policyVersion + resolvedCategory onto every commissionLedger row
   NODE_PATH=<functions/node_modules> node scripts/test-electronics-commercial.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 220) : '')); } };

const CC = require(path.join(FN, 'commission-config.js'));
const db = { collection: () => ({ doc: () => ({ async get () { return { exists: false, data: () => undefined }; } }), where () { return this; },
  async get () { return { empty: true, docs: [], forEach () {} }; } }) };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) };
  return orig.apply(this, arguments);
};
const FU = require(path.join(FN, 'finos-utils.js'));
Module.prototype.require = orig;
const SC = require(path.join(FN, 'subscription-catalog.js'));
const PLANS = require(path.join(FN, 'sub-billing.js')).PLANS;

(async () => {
  const labels = ['electronics', 'phones', 'phone', 'smartphones', 'laptops', 'laptop', 'tablets', 'computers', 'device_accessories'];
  ck('E1 every electronics label resolves to the explicit electronics row at 15% (matched, never default)',
    labels.every((k) => { const r = CC.resolveRate(k); return r.matched && r.category === 'electronics' && r.pct === 15; }), labels.map((k) => CC.resolveRate(k)));
  const c = await FU.calculateCommission(db, { orderAmountCents: 10000000, category: 'phones', sellerId: 'S1' });
  ck('E2 real engine: KES 100,000 phone → 15% = KES 15,000; policyVersion + resolvedCategory recorded',
    c.commissionCents === 1500000 && c.effectiveRate === 15 && c.policyVersion === CC.COMMISSION_POLICY_VERSION && c.resolvedCategory === 'electronics',
    { cents: c.commissionCents, rate: c.effectiveRate, pv: c.policyVersion, cat: c.resolvedCategory });
  const IX = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('E3 electronics keeps the 48h per-sale term', /_cat === "marketplace" \|\| _cat === "pos" \|\| _cat === "electronics"/.test(IX));
  const e = ['electronics_free', 'electronics_basic', 'electronics_pro', 'electronics_enterprise'].map((id) => PLANS[id]);
  const s = ['seller_basic', 'seller_pro', 'seller_enterprise'].map((id) => PLANS[id]);
  ck('E4 plans: Free 50, then the retail ladder at retail prices (Basic 100 / Pro 500 / Enterprise unlimited)',
    e.every(Boolean) && e.map((p) => p.features.listings_limit).join() === '50,100,500,-1' && e[0].price.monthly === 0
    && e.slice(1).every((p, i) => p.price.monthly === s[i].price.monthly && p.price.annual === s[i].price.annual) && e.every((p) => p.hubType === 'electronics'));
  const q = (plan, needed) => SC.requireFeature({ plan, status: 'active' }, { hubType: 'electronics', feature: 'listings_limit', needed });
  ck('E5 entitlements: 51st on Free → Basic; 101st on Basic → Pro; 1,000 on Enterprise allowed; 50 on Free allowed',
    q('electronics_free', 51).upgradeRequired.minPlanId === 'electronics_basic' && q('electronics_basic', 101).upgradeRequired.minPlanId === 'electronics_pro'
    && q('electronics_enterprise', 1000).allowed === true && q('electronics_free', 50).allowed === true);
  ck('E6 the ledger writer copies policyVersion + resolvedCategory onto commissionLedger rows',
    /policyVersion:\s+audit\.policyVersion \|\| null,/.test(IX) && /resolvedCategory: audit\.resolvedCategory \|\| null,/.test(IX));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
