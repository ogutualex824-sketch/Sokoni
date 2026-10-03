#!/usr/bin/env node
'use strict';
/* Marketing commercial catalogue (owner 2026-10-03, via sokoni-b2)
     MK1  all 71 taxonomy ids (shared/marketing-taxonomy.js) → marketing_services 10%, matched; none collides with another row
     MK2  marketing_services is a FLAT booking lane (no plan moves it); the real engine charges KES 1,000 on a KES 10,000 sale
     MK3  plans: marketing_free 0 / professional 1,499 / agency 4,999, monthly; entitlement keys agreed with b2
     MK4  requireFeature: Free has no campaign tools → Professional; 11th campaign on Professional → Agency
     MK6-9 settlement lane from the BOOKING snapshot: serviceHub marketing + taxonomy id → 10%; unknown → refused; else unchanged
     MK5  shared/marketing-taxonomy.js is byte-identical to sokoni-b2's d5d81d6 copy (one taxonomy, two lines)
   NODE_PATH=<functions/node_modules> node scripts/test-marketing-commercial.js */
const path = require('path'), Module = require('module'), cp = require('child_process'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
const CC = require(path.join(FN, 'commission-config.js'));
const T = require(path.join(FN, 'shared/marketing-taxonomy.js'));
const orig = Module.prototype.require;
Module.prototype.require = function (id) { if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) }; return orig.apply(this, arguments); };
const FU = require(path.join(FN, 'finos-utils.js'));
Module.prototype.require = orig;
const PLANS = require(path.join(FN, 'sub-billing.js')).PLANS;
const SC = require(path.join(FN, 'subscription-catalog.js'));
const db = { collection: () => ({ doc: () => ({ async get () { return { exists: false, data: () => undefined }; } }), where () { return this; }, async get () { return { empty: true, docs: [], forEach () {} }; } }) };

(async () => {
  const bad = T.AREA_IDS.filter((id) => { const r = CC.resolveRate(id); return !(r.matched && r.category === 'marketing_services' && r.pct === 10); });
  ck('MK1 all 71 marketing ids → marketing_services 10% (none collides with another row)', T.AREA_IDS.length === 71 && bad.length === 0, bad);
  const c = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'brand-strategy', sellerId: 'M1' });
  ck('MK2 flat booking lane; real engine: KES 10,000 brand strategy → KES 1,000', CC.isFlatBookingCategory('brand-strategy') && c.commissionCents === 100000 && c.effectiveRate === 10, { cents: c.commissionCents });
  const pl = ['marketing_free', 'marketing_professional', 'marketing_agency'].map((id) => PLANS[id]);
  ck('MK3 plans 0 / 1,499 / 4,999 monthly, hubType marketing, agreed keys', pl.every(Boolean) && pl.map((x) => x.price.monthly / 100).join() === '0,1499,4999' && pl.every((x) => x.hubType === 'marketing'
    && ['services_limit', 'portfolio_limit', 'team_seats', 'campaigns_limit', 'advanced_leads', 'quotations', 'invoicing', 'campaign_tools', 'client_management', 'reporting'].every((k) => k in x.features)));
  const a = SC.requireFeature({ plan: 'marketing_free', status: 'active' }, { hubType: 'marketing', feature: 'campaign_tools' });
  const b = SC.requireFeature({ plan: 'marketing_professional', status: 'active' }, { hubType: 'marketing', feature: 'campaigns_limit', needed: 11 });
  ck('MK4 Free → Professional for campaign tools; 11th campaign on Professional → Agency', a.upgradeRequired.minPlanId === 'marketing_professional' && b.upgradeRequired.minPlanId === 'marketing_agency');
  let theirs = null; try { theirs = cp.execSync('git show d5d81d6:functions/shared/marketing-taxonomy.js', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (_) {}
  ck('MK5 shared/marketing-taxonomy.js byte-identical to b2\'s d5d81d6', theirs !== null && theirs === fs.readFileSync(path.join(FN, 'shared/marketing-taxonomy.js'), 'utf8'));
  /* per-booking lane at settlement (b2 9319925 field contract) */
  const PH = require(path.join(FN, 'provider-hub.js'));
  const args = (b) => { try { return PH.commissionArgsForBooking(b); } catch (e) { return { refused: e.code }; } };
  const mk = args({ serviceHub: 'marketing', serviceCategory: 'brand-strategy', commissionHub: 'provider', hubType: 'cleaning' });
  const mc = await FU.calculateCommission(db, { orderAmountCents: 1000000, sellerId: 'P1', ...mk });
  ck('MK6 booking.serviceHub marketing + taxonomy category → marketing_services: KES 10,000 → KES 1,000 (client hubType ignored)', mk.category === 'marketing_services' && mc.commissionCents === 100000, mk);
  ck('MK7 serviceHub marketing with a missing / unknown category → REFUSED category_unpriced (never the 5 % default)',
    args({ serviceHub: 'marketing' }).refused === 'category_unpriced' && args({ serviceHub: 'marketing', serviceCategory: 'house-cleaning' }).refused === 'category_unpriced');
  const nonMk = args({ serviceHub: null, serviceCategory: 'brand-strategy', commissionHub: 'provider' });
  ck('MK8 a taxonomy-looking category WITHOUT serviceHub marketing keeps the existing lane (services 5 %); other hubs unchanged',
    nonMk.category === 'services' && args({ commissionHub: 'healthcare' }).category === 'healthcare' && args({ commissionHub: 'sports_coaching' }).category === 'sports_coaching');
  const src = fs.readFileSync(path.join(FN, 'provider-ops.js'), 'utf8');
  ck('MK9 BOTH provider-ops commission call sites (completion + forfeited deposit) use the per-booking selector; none left on commissionArgsForHub',
    (src.match(/commissionArgsForBooking\(data\)/g) || []).length === 2 && !/commissionArgsForHub\(/.test(src));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
