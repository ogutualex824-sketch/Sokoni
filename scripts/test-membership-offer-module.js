#!/usr/bin/env node
/* Standalone test for functions/shared/membership-offer.js — needs ONLY the module, so it runs on any
   tree that carries the byte-identical copy (e.g. sokoni-5b's providerDispatch release).
   M0 pins the module bytes; M1–M5 cover the writer hook and the booking refusal predicate.
   Usage: node scripts/test-membership-offer-module.js [FN_DIR=functions] */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const FN = process.env.FN_DIR || path.join(__dirname, '..', 'functions');
const FILE = path.join(FN, 'shared', 'membership-offer.js');
const PIN = 'f6fabf6969d99888d4bcc7df10cc0b9211a5d91dc9f763041a74a0dfedf21d83';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
