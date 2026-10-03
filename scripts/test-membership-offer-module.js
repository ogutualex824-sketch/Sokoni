#!/usr/bin/env node
/* Standalone test for functions/shared/membership-offer.js — needs ONLY the module, so it runs on any
   tree that carries the byte-identical copy (e.g. sokoni-5b's providerDispatch release).
   M0 pins the module bytes; M1–M5 cover the writer hook and the booking refusal predicate; M6 the day / week units
   (owner 2026-10-03 via sokoni-2f fe33bcc); M7 that every SOKONI default (2f's functions/shared/fitness-offer-defaults.js)
   validates when published as a service.
   M7 needs the defaults file. On a tree that does not carry it, M7 FAILS (fail closed) unless SKIP_DEFAULTS=1 is set,
   which prints it as NOT ATTEMPTED — never as a pass.
   Usage: node scripts/test-membership-offer-module.js [FN_DIR=functions] [SKIP_DEFAULTS=1] */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const FN = process.env.FN_DIR || path.join(__dirname, '..', 'functions');
const FILE = path.join(FN, 'shared', 'membership-offer.js');
const PIN = 'a15598d13284b6e8d384fc78659da240273c434bac82057600a17184bde4583f';
const OFFER = require(FILE);

let pass = 0, fail = 0;
const ck = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  -> ${JSON.stringify(detail).slice(0, 400)}`); }
};

const sha = crypto.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex');
ck('M0 module bytes equal the pinned sha256', sha === PIN, { sha });

const mk = (d) => {
  const out = { providerId: 'gym_A', name: d.name || 'Gold', priceType: d.priceType || 'quotation',
    price: Math.max(0, Math.round(Number(d.price) || 0)), active: true };
  return { out, v: OFFER.applyToServiceWrite('create', d, null, out) };
};

const c1 = mk({ name: 'Gold', price: 600000, serviceKind: 'membership', periodCount: 3 });
ck('M1 membership create: kind kept, priceType forced fixed, periodUnit month, result validates',
  c1.v.ok && c1.out.serviceKind === 'membership' && c1.out.priceType === 'fixed' && c1.out.periodUnit === 'month'
  && c1.out.periodCount === 3 && OFFER.validateMembershipOffer(c1.out).ok, c1);

const bad = {
  p61: mk({ price: 600000, serviceKind: 'membership', periodCount: 61 }).v.reason,
  p0: mk({ price: 600000, serviceKind: 'membership', periodCount: 0 }).v.reason,
  pFrac: mk({ price: 600000, serviceKind: 'membership', periodCount: 2.5 }).v.reason,
  price0: mk({ price: 0, serviceKind: 'membership', periodCount: 3 }).v.reason,
  cents: mk({ price: 600050, serviceKind: 'membership', periodCount: 3 }).v.reason,
  noKind: mk({ price: 600000, periodCount: 3 }).v.reason,
  badKind: mk({ price: 600000, serviceKind: 'subscription' }).v.reason,
};
ck('M2 invalid membership writes refused with named reasons',
  bad.p61 === 'bad_period' && bad.p0 === 'bad_period' && bad.pFrac === 'bad_period' && bad.price0 === 'bad_price'
  && bad.cents === 'bad_price' && bad.noKind === 'not_membership' && bad.badKind === 'bad_kind', bad);

const plain = mk({ price: 150000 });
ck('M3 plain (non-membership) service untouched', plain.v.ok && plain.out.serviceKind === undefined
  && plain.out.priceType === 'quotation' && plain.out.periodCount === undefined, plain);

const cur = Object.assign({}, c1.out);
const u1 = OFFER.applyToServiceWrite('update', { price: 0 }, cur, { price: 0 });
const u3p = { priceType: 'quotation' }; const u3 = OFFER.applyToServiceWrite('update', { priceType: 'quotation' }, cur, u3p);
const dupOut = { providerId: 'gym_A', name: 'Gold (copy)', priceType: cur.priceType, price: cur.price, active: true };
const dup = OFFER.applyToServiceWrite('duplicate', null, cur, dupOut);
ck('M4 edits re-validated (price 0 refused, priceType pinned fixed); duplicate keeps kind + months',
  u1.reason === 'bad_price' && u3.ok && u3p.priceType === 'fixed'
  && dup.ok && dupOut.serviceKind === 'membership' && dupOut.periodCount === 3, { u1, u3p, dupOut });

ck('M5 isMembershipOffer drives the booking refusal: true for a membership, false for a plain service',
  OFFER.isMembershipOffer(c1.out) === true && OFFER.isMembershipOffer(plain.out) === false
  && OFFER.isMembershipOffer(null) === false, null);

/* M6 — short units */
const day = mk({ name: 'Daily Pass', price: 50000, serviceKind: 'membership', periodUnit: 'day', periodCount: 1 });
const week = mk({ name: 'Weekly Pass', price: 150000, serviceKind: 'membership', periodUnit: 'week', periodCount: 1 });
const shortBad = {
  day32: mk({ price: 50000, serviceKind: 'membership', periodUnit: 'day', periodCount: 32 }).v.reason,
  week9: mk({ price: 150000, serviceKind: 'membership', periodUnit: 'week', periodCount: 9 }).v.reason,
  year: mk({ price: 150000, serviceKind: 'membership', periodUnit: 'year', periodCount: 1 }).v.reason,
  upper: mk({ price: 150000, serviceKind: 'membership', periodUnit: 'Week', periodCount: 1 }).v.reason,
  proto: OFFER.validateMembershipOffer(Object.assign({}, day.out, { periodUnit: 'toString' })).reason,
  noKindUnit: mk({ price: 150000, periodUnit: 'week' }).v.reason,
};
const dv = OFFER.validateMembershipOffer(day.out); const wv = OFFER.validateMembershipOffer(week.out);
const legacy = OFFER.validateMembershipOffer(Object.assign({}, c1.out, { periodUnit: undefined }));
ck('M6 day×1 / week×1 accepted and returned with their unit; bounds day 31 / week 8 / month 60; day×32, week×9, unit year / Week / toString refused; unit without kind refused; absent unit = month',
  day.v.ok && week.v.ok && dv.ok && dv.periodUnit === 'day' && wv.ok && wv.periodUnit === 'week'
  && OFFER.PERIOD_LIMITS.day === 31 && OFFER.PERIOD_LIMITS.week === 8 && OFFER.PERIOD_LIMITS.month === 60
  && shortBad.day32 === 'bad_period' && shortBad.week9 === 'bad_period' && shortBad.year === 'bad_unit' && shortBad.upper === 'bad_unit'
  && shortBad.proto === 'bad_unit' && shortBad.noKindUnit === 'not_membership' && legacy.ok && legacy.periodUnit === 'month', { dv, wv, shortBad, legacy });

/* M7 — SOKONI defaults (2f) are publishable as-is */
const DEF_FILE = path.join(FN, 'shared', 'fitness-offer-defaults.js');
if (!fs.existsSync(DEF_FILE) && process.env.SKIP_DEFAULTS === '1') {
  console.log('  NOT ATTEMPTED  M7 (functions/shared/fitness-offer-defaults.js absent on this tree; SKIP_DEFAULTS=1) — not a pass');
} else {
  let res = null; let err = null;
  try {
    res = require(DEF_FILE).OFFER_DEFAULTS.map((d) => {
      const o = mk({ name: d.label, price: d.priceCents, serviceKind: 'membership', periodUnit: d.periodUnit, periodCount: d.periodCount });
      const v = OFFER.validateMembershipOffer(o.out);
      return { key: d.key, ok: o.v.ok && v.ok && v.priceCents === d.priceCents && v.periodUnit === d.periodUnit && v.periodCount === d.periodCount, reason: o.v.reason || v.reason };
    });
  } catch (e) { err = String(e && e.message || e); }
  ck('M7 every OFFER_DEFAULTS entry (2f) passes the writer hook AND validateMembershipOffer when shaped as a service (6 entries)',
    !err && res.length === 6 && res.every((x) => x.ok), { err, res });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
