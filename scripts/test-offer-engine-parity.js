/* ══════════════════════════════════════════════════════════════════════════════
   THE CONTRACT BETWEEN THE TWO OFFER RESOLVERS
   scripts/test-offer-engine-parity.js       node scripts/test-offer-engine-parity.js

   sokoni-promotion-model.js resolves offers in the browser, for display.
   functions/shop-offers.js resolves them on the server, for money.

   They are implemented twice because `firebase deploy --only functions` uploads functions/
   and nothing else, so a require('../sokoni-promotion-model.js') resolves on a developer's
   machine and throws MODULE_NOT_FOUND in production. functions/auth-policy.js already faced
   this and settled the pattern: duplicate deliberately, then hold the two together with a
   contract instead of with hope.

   THIS IS THAT CONTRACT. Every vector is resolved by both and compared on the numbers that
   reach a customer — subtotal, discount, deliveryFee, total — and on which offers applied
   and for how much. A disagreement here is a customer being quoted one figure and charged
   another, which is the exact bug the promo-code path was built to end.

   The comparison deliberately ignores the `rejected` array: both engines must AGREE ON THE
   MONEY, but the wording of a rejection reason is diagnostic text, not a commitment.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CLIENT = require(path.join(ROOT, 'sokoni-promotion-model.js'));
const SERVER = require(path.join(ROOT, 'functions', 'shop-offers.js'));
const { vectors } = JSON.parse(fs.readFileSync(path.join(__dirname, 'offer-resolution-vectors.json'), 'utf8'));

let pass = 0, fail = 0;
function ok (n, c, d) {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
}

/* What a customer is actually promised. */
function money (r) {
  return {
    subtotal: r.subtotal, discount: r.discount,
    deliveryFee: r.deliveryFee, total: r.total,
    applied: (r.applied || []).map(a => ({ id: a.id, type: a.type, amount: a.amount, kind: a.kind })),
  };
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  OFFER ENGINE PARITY — client display vs server money');
console.log('══════════════════════════════════════════════════════════════════\n');

vectors.forEach(v => {
  const ctx = { at: new Date(v.at), usage: v.usage || {} };
  let c, s, err = null;
  try {
    c = money(CLIENT.resolve(v.basket, v.offers, ctx));
    s = money(SERVER.resolve(v.basket, v.offers, ctx));
  } catch (e) { err = e; }
  if (err) { ok(v.name, false, 'threw: ' + err.message); return; }
  const same = JSON.stringify(c) === JSON.stringify(s);
  ok(v.name, same, same
    ? 'total ' + c.total + ' · discount ' + c.discount + ' · ' + c.applied.length + ' applied'
    : 'client ' + JSON.stringify(c) + '  server ' + JSON.stringify(s));
});

/* ── The controls. Without these, a parity suite passes when BOTH engines are broken in
   the same way, or when neither engine ran at all. ─────────────────────────────────── */
console.log('\ncontrols');
{
  const rich = vectors.find(v => v.name.indexOf('three stackable') === 0);
  const r = CLIENT.resolve(rich.basket, rich.offers, { at: new Date(rich.at) });
  ok('the vectors exercise real arithmetic, not a no-op',
     r.discount > 0 && r.applied.length >= 2,
     'discount ' + r.discount + ', ' + r.applied.length + ' applied');

  const refusals = vectors.filter(v => {
    const x = CLIENT.resolve(v.basket, v.offers, { at: new Date(v.at), usage: v.usage || {} });
    return x.discount === 0 && x.deliveryFee === (v.basket.deliveryFee || 0);
  });
  ok('and they include cases where NOTHING applies', refusals.length >= 5,
     refusals.length + ' of ' + vectors.length + ' vectors apply nothing');

  /* AN INERT VECTOR AGREES PERFECTLY AND PROVES NOTHING. The pizza bundle originally priced
     the package ABOVE its own contents (2,999 for 2,650 of items), so it produced no
     discount — and parity passed on both engines calculating zero. Every offer TYPE must
     therefore be shown actually applying somewhere in the set, or the suite is agreeing
     about arithmetic it never performed. */
  const typesThatApplied = new Set();
  vectors.forEach(v => {
    const r = CLIENT.resolve(v.basket, v.offers, { at: new Date(v.at), usage: v.usage || {} });
    (r.applied || []).forEach(a => typesThatApplied.add(a.type));
  });
  ['bundle', 'percentage', 'fixed', 'buyXgetY', 'spendAndSave', 'freeDelivery', 'freeItem']
    .forEach(t => ok('vectors show ' + t + ' actually applying', typesThatApplied.has(t)));

  const pizza = vectors[0];
  const pr = CLIENT.resolve(pizza.basket, pizza.offers, { at: new Date(pizza.at) });
  ok('the pizza package saves the spec\'s KES 651', pr.discount === 651,
     'discount ' + pr.discount);

  /* A deliberately divergent input must be CAUGHT — proving the comparison can fail. */
  const b = { subtotal: 1000, deliveryFee: 0, lines: [{ listingId: 'a', price: 1000, qty: 1 }] };
  const a1 = money(CLIENT.resolve(b, [{ id: 'z', type: 'fixed', amount: 100, status: 'live' }], {}));
  const a2 = money(CLIENT.resolve(b, [{ id: 'z', type: 'fixed', amount: 250, status: 'live' }], {}));
  ok('control — the comparator really can detect a difference',
     JSON.stringify(a1) !== JSON.stringify(a2));

  /* Both modules must actually be the two different files. */
  ok('two distinct implementations were loaded',
     CLIENT.resolve !== SERVER.resolve && typeof SERVER.resolve === 'function');
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed   (' + vectors.length + ' vectors)');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
