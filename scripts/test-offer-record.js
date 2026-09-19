/* ══════════════════════════════════════════════════════════════════════════════
   GATE P — OFFER PERSISTENCE SCHEMA, certified before any write exists
   scripts/test-offer-record.js           node scripts/test-offer-record.js

   Gate P's instruction was to establish the persistence authority and schema against the
   existing backend BEFORE implementing a write. This suite is the schema half.

   THE PROPERTY UNDER TEST IS NOT "the fields match".
   Comparing fields only proves the fields I remembered to compare. So every round-trip case
   below RESOLVES A BASKET twice — once against the original offer, once against the offer
   after toRecord -> fromRecord — and compares the resolver's whole output. An offer that
   takes KES 651 off must still take KES 651 off after being written and read back, and if a
   field is silently dropped the totals diverge whether or not I thought to assert on it.

   IT ALSO PINS THE TWO EXISTING AUTHORITIES. `offers` is the platform-admin price-drop
   mechanism and `promotions` is the admin marketing-placement engine. Gate P must not
   change either, so their semantics are asserted here: if a later change makes `offers`
   merchant-writable or gives `promotions` a price, this suite fails.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PM = require(path.join(ROOT, 'sokoni-promotion-model.js'));
const REC = require(path.join(ROOT, 'sokoni-offer-record.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
function head (t) { console.log('\n' + t); }

const SCOPE = { ok: true, shopId: 'shop_P', sellerUid: 'seller_P' };
const FRI_18 = new Date('2026-10-02T18:00:00');

/* One basket, rich enough that every offer type has something to bite on. */
const BASKET = {
  subtotal: 3650, deliveryFee: 150, fulfilment: 'delivery',
  lines: [
    { listingId: 'pizza_a', price: 1200, qty: 2 },
    { listingId: 'bread',   price: 250,  qty: 1 },
    { listingId: 'soda',    price: 250,  qty: 4 },
  ],
};

/* Round-trip an offer and prove the RESOLVER cannot tell the difference. */
function roundTrips (label, offer, opts) {
  const rec = REC.toRecord(offer, SCOPE);
  const back = REC.fromRecord(rec);
  const ctx = { at: FRI_18, usage: (opts && opts.usage) || {} };
  const before = PM.resolve(BASKET, [offer], ctx);
  const after = PM.resolve(BASKET, [back], ctx);
  const same = JSON.stringify(before) === JSON.stringify(after);
  ok(label, same, same
    ? 'total ' + before.total + ', ' + before.applied.length + ' applied'
    : 'before ' + before.total + ' / after ' + after.total);
  return { rec, back, before };
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  GATE P — offer persistence schema');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. EVERY OFFER TYPE SURVIVES, PROVEN BY RESOLUTION ─────────────────────── */
head('1 - every offer type round-trips with no semantic loss');
{
  roundTrips('bundle / meal deal / package', {
    id: 'o1', type: 'bundle', name: 'Family Pizza Night', template: 'mealDeal',
    bundlePrice: 2999, status: 'live',
    items: [{ listingId: 'pizza_a', name: 'Large BBQ', qty: 2, price: 1200 },
            { listingId: 'bread', name: 'Garlic Bread', qty: 1, price: 250 }],
    schedule: { days: ['fri'], from: '17:00', to: '22:00' }, stacking: 'exclusive',
  });
  roundTrips('percentage / flash sale / happy hour', {
    id: 'o2', type: 'percentage', percent: 20, status: 'live',
    schedule: { days: ['fri'], from: '17:00', to: '19:00' },
    qualifyingListingIds: ['soda'],
  });
  roundTrips('fixed amount / coupon', {
    id: 'o3', type: 'fixed', amount: 500, minSpend: 3000, maxDiscount: 500, status: 'live',
  });
  roundTrips('buy X get Y', {
    id: 'o4', type: 'buyXgetY', buyQty: 2, getQty: 1, maxFreeItems: 3,
    qualifyingListingIds: ['soda'], status: 'live',
  });
  roundTrips('spend and save', {
    id: 'o5', type: 'spendAndSave', minSpend: 3000, amount: 300, status: 'live',
  });
  roundTrips('free delivery', {
    id: 'o6', type: 'freeDelivery', status: 'live', fulfilment: 'delivery',
  });
  roundTrips('free item', {
    id: 'o7', type: 'freeItem', freeItemId: 'bread', status: 'live',
  });
  roundTrips('inventory-limited offer', {
    id: 'o8', type: 'fixed', amount: 200, inventoryLimit: 100, status: 'live',
  }, { usage: { o8: { inventorySold: 77 } } });
  roundTrips('redemption-limited offer', {
    id: 'o9', type: 'fixed', amount: 200, perCustomerLimit: 1,
    totalRedemptionLimit: 500, status: 'live',
  }, { usage: { o9: { customerRedemptions: 0, totalRedemptions: 3 } } });

  /* Several at once — stacking, priority and the explanation must all survive together. */
  const many = [
    { id: 'm1', type: 'bundle', bundlePrice: 2999, status: 'live',
      items: [{ listingId: 'pizza_a', qty: 2, price: 1200 }], stacking: 'stackable' },
    { id: 'm2', type: 'percentage', percent: 5, status: 'live', stacking: 'stackable' },
    { id: 'm3', type: 'freeDelivery', status: 'live', stacking: 'stackable' },
  ];
  const b4 = PM.resolve(BASKET, many, { at: FRI_18 });
  const af = PM.resolve(BASKET, many.map(o => REC.fromRecord(REC.toRecord(o, SCOPE))), { at: FRI_18 });
  ok('several stacked offers resolve identically after a round trip',
     JSON.stringify(b4) === JSON.stringify(af),
     'total ' + b4.total + ', ' + b4.applied.length + ' applied');
}

/* ── 2. THE RESOLVER'S FIELD LIST IS COMPLETE ───────────────────────────────── */
head('2 - storage cannot silently drop a field the resolver reads');
{
  /* Derived from the engine's SOURCE, not from memory. If the resolver learns a new field
     and the record schema does not, this fails — which is the alarm that matters, because a
     dropped field is a silent pricing change. */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-promotion-model.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readByResolver = [...new Set((code.match(/\bo\.[a-zA-Z_]+/g) || [])
    .map(s => s.slice(2)))].sort();
  const known = new Set(REC.RESOLVER_FIELDS);
  const missing = readByResolver.filter(f => !known.has(f));
  ok('every field the resolver reads is in the record schema',
     missing.length === 0, missing.length ? 'MISSING: ' + missing.join(', ')
                                          : readByResolver.length + ' fields checked');
  /* The inverting control: the detector really can see fields. */
  ok('control — the detector found the engine\'s fields at all',
     readByResolver.length >= 20, readByResolver.length + ' found');

  /* THE SAME CHECK FOR THE CUSTOMER SURFACE, and it is not redundant. A field the VIEW
     reads but the resolver does not is invisible to resolver-equivalence: every total
     matches while the customer loses information. `regularValue` was dropped exactly this
     way, costing the card and panel their "SAVE KES 651" with no total changing. */
  const viewSrc = fs.readFileSync(path.join(ROOT, 'sokoni-offer-view.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readByView = [...new Set((viewSrc.match(/\bo\.[a-zA-Z_]+/g) || []).map(s => s.slice(2)))].sort();
  const allKnown = new Set(REC.RESOLVER_FIELDS.concat(REC.PRESENTATION_FIELDS));
  const viewMissing = readByView.filter(f => !allKnown.has(f));
  ok('every field the customer surface reads is in the record schema',
     viewMissing.length === 0, viewMissing.length ? 'MISSING: ' + viewMissing.join(', ')
                                                  : readByView.length + ' fields checked');
  ok('control — the detector found the view\'s fields at all',
     readByView.length >= 15, readByView.length + ' found');
}

/* ── 3. OWNERSHIP IS NEVER TAKEN FROM THE FORM ──────────────────────────────── */
head('3 - ownership comes from the resolved scope');
{
  const hostile = REC.toRecord({
    id: 'x', type: 'fixed', amount: 100,
    shopId: 'someone_elses_shop', sellerUid: 'someone_else',
  }, SCOPE);
  ok('the form\'s shopId is discarded', hostile.shopId === 'shop_P', hostile.shopId);
  ok('the form\'s sellerUid is discarded', hostile.sellerUid === 'seller_P', hostile.sellerUid);
  ok('no scope is refused outright', (() => {
    try { REC.toRecord({ type: 'fixed', amount: 1 }, null); return false; } catch (_) { return true; }
  })());
  ok('an unresolved scope is refused', (() => {
    try { REC.toRecord({ type: 'fixed', amount: 1 }, { ok: false, shopId: 's' }); return false; }
    catch (_) { return true; }
  })());
  /* Control — a valid scope really does produce a record. */
  ok('control — a resolved scope produces a record',
     !!REC.toRecord({ type: 'fixed', amount: 1 }, SCOPE).shopId);
}

/* ── 4. ABSENT STAYS ABSENT ─────────────────────────────────────────────────── */
head('4 - absent is not zero, and blank is not a rule');
{
  const thin = REC.toRecord({ id: 't', type: 'fixed', amount: 100 }, SCOPE);
  /* minSpend:0 always qualifies; absent minSpend is no rule at all. Writing one as the
     other changes what customers are charged. */
  ok('an unset minSpend is omitted, not written as 0', !('minSpend' in thin),
     JSON.stringify(thin.minSpend));
  ok('an unset inventoryLimit is omitted', !('inventoryLimit' in thin));
  ok('an unset schedule is omitted', !('schedule' in thin));
  ok('control — a real 0 IS stored',
     REC.toRecord({ type: 'fixed', amount: 100, minSpend: 0 }, SCOPE).minSpend === 0);

  /* An empty schedule object and "no schedule" must not become two different things: the
     first would make isLive() evaluate an empty window. */
  const blankSched = REC.toRecord({ type: 'fixed', amount: 1,
    schedule: { days: [], from: '', to: '' } }, SCOPE);
  ok('a blank schedule collapses to absent', !('schedule' in blankSched));
  ok('control — a real schedule survives',
     !!REC.toRecord({ type: 'fixed', amount: 1,
       schedule: { days: ['fri'], from: '17:00', to: '22:00' } }, SCOPE).schedule);
}

/* ── 5. MALFORMED DATA STILL FAILS CLOSED AFTER A ROUND TRIP ────────────────── */
head('5 - malformed offers fail closed on the way back out');
{
  const broken = REC.fromRecord(REC.toRecord({
    id: 'b1', type: 'fixed', amount: 100, status: 'live',
    schedule: { from: 'nonsense', to: '9' },
  }, SCOPE));
  ok('a broken time window is not live', PM.isLive(broken, FRI_18) === false);

  const unknown = REC.fromRecord(REC.toRecord({ id: 'b2', type: 'nonsense', amount: 1 }, SCOPE));
  const r = PM.resolve(BASKET, [unknown], { at: FRI_18 });
  ok('an unknown type applies nothing', r.applied.length === 0);
  ok('and is rejected with a reason',
     r.rejected.some(x => /unknown offer type/.test(x.why)), JSON.stringify(r.rejected));

  ok('a draft does not price a basket',
     PM.resolve(BASKET, [REC.fromRecord(REC.toRecord(
       { id: 'b3', type: 'fixed', amount: 500, status: 'draft' }, SCOPE))],
       { at: FRI_18 }).applied.length === 0);
  ok('control — the same offer LIVE does apply',
     PM.resolve(BASKET, [REC.fromRecord(REC.toRecord(
       { id: 'b4', type: 'fixed', amount: 500, status: 'live' }, SCOPE))],
       { at: FRI_18 }).applied.length === 1);
}

/* ── 6. STATE IS DERIVED CONSISTENTLY WITH THE RESOLVER ─────────────────────── */
head('6 - draft / scheduled / live agree with the resolver');
{
  ok('status defaults to draft, never live',
     REC.toRecord({ type: 'fixed', amount: 1 }, SCOPE).status === 'draft');
  ok('an unrecognised status becomes draft, not live',
     REC.toRecord({ type: 'fixed', amount: 1, status: 'wibble' }, SCOPE).status === 'draft');
  ok('"active" is normalised to live',
     REC.toRecord({ type: 'fixed', amount: 1, status: 'active' }, SCOPE).status === 'live');
  ok('scheduled survives', REC.toRecord({ type: 'fixed', amount: 1, status: 'scheduled' }, SCOPE).status === 'scheduled');
  ok('archived survives', REC.toRecord({ type: 'fixed', amount: 1, status: 'archived' }, SCOPE).status === 'archived');
  /* And the resolver must agree that a non-live status prices nothing. */
  ['draft', 'scheduled', 'archived'].forEach(st => {
    ok('a ' + st + ' offer prices nothing', PM.resolve(BASKET,
      [REC.fromRecord(REC.toRecord({ id: st, type: 'fixed', amount: 500, status: st }, SCOPE))],
      { at: FRI_18 }).applied.length === 0);
  });
}

/* ── 7. IDEMPOTENCY ─────────────────────────────────────────────────────────── */
head('7 - create is idempotent by construction');
{
  const a = REC.offerDraftId({ scope: SCOPE, draftToken: 'tok-1' });
  const b = REC.offerDraftId({ scope: SCOPE, draftToken: 'tok-1' });
  ok('the same draft token yields the same id', a === b, a);
  ok('a different token yields a different id',
     a !== REC.offerDraftId({ scope: SCOPE, draftToken: 'tok-2' }));
  ok('a different shop yields a different id',
     a !== REC.offerDraftId({ scope: { ok: true, shopId: 'shop_Q' }, draftToken: 'tok-1' }));
  ok('the id carries the shop, so cross-shop collision is impossible',
     a.indexOf('shop_P') > -1, a);
  ok('a missing draft token is refused', (() => {
    try { REC.offerDraftId({ scope: SCOPE }); return false; } catch (_) { return true; }
  })());
  /* Derived from shop + token only — never a clock, or a retry would make a second offer. */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-offer-record.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fn = src.slice(src.indexOf('function offerDraftId'), src.indexOf('var api ='));
  ok('the id is not derived from a clock',
     !/Date\.now|new Date|Math\.random/.test(fn));
}

/* ── 8. THE TWO EXISTING AUTHORITIES ARE UNCHANGED ──────────────────────────── */
head('8 - Gate P changes neither existing offer authority');
{
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const offersBlock = rules.slice(rules.indexOf('match /offers/{offerId}'),
                                 rules.indexOf('match /offers/{offerId}') + 700);
  ok('`offers` create is still admin-only', /allow create: if isAdmin\(\)/.test(offersBlock));
  ok('`offers` update is still admin-only', /allow update: if isAdmin\(\)/.test(offersBlock));
  ok('`offers` still requires offerPrice < originalPrice',
     /offerPrice < request\.resource\.data\.originalPrice/.test(offersBlock));

  const promoBlock = rules.slice(rules.indexOf('match /promotions/{promoId}'),
                                 rules.indexOf('match /promotions/{promoId}') + 300);
  ok('`promotions` create is still admin-only', /allow create: if isAdmin\(\)/.test(promoBlock));

  const fns = fs.readFileSync(path.join(ROOT, 'functions', 'promotions.js'), 'utf8');
  /* Asserted PER CALLABLE, not by counting. A count of `_assertAdmin(request)` also matches
     the function's own DEFINITION — 4 callables against 5 matches — so the tally reported a
     defect that was not there. Slicing each callable's body and requiring the call inside it
     is what the assertion actually meant, and it survives someone adding a fifth callable. */
  const callables = [...fns.matchAll(/exports\.(promotion\w+) = onCall/g)].map(m => ({
    name: m[1], at: m.index,
  }));
  ok('there are promotion write callables to check', callables.length >= 4,
     callables.map(c => c.name).join(', '));
  callables.forEach((c, i) => {
    const end = i + 1 < callables.length ? callables[i + 1].at : fns.length;
    const body = fns.slice(c.at, end);
    ok(c.name + ' asserts admin before writing', /await _assertAdmin\(request\)/.test(body));
  });
  /* `promotions` is a PLACEMENT engine — it carries no price and must never gain one. */
  ok('`promotions` still carries no price field',
     !/\bprice\b|\bdiscount\b|offerPrice/.test(fns.slice(fns.indexOf('await ref.set({'),
                                                         fns.indexOf('_cache = { at: 0'))));
  ok('and still refuses checkout placements',
     /FORBIDDEN_PLACEMENTS/.test(fns) && /'checkout'/.test(fns));

  /* NO DUPLICATE WRITER. The record module must perform no I/O of its own. */
  const rec = fs.readFileSync(path.join(ROOT, 'sokoni-offer-record.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the record module names no collection',
     !/collection\(|firestore|firebaseDB|setDoc|addDoc/.test(rec));
  ok('and performs no network or write call',
     !/fetch\(|httpsCallable|onCall|import\(/.test(rec));
}

/* ── 9. THE CUSTOMER SURFACE READS THE PERSISTED SHAPE ──────────────────────── */
head('9 - the marketplace reads the same representation that was stored');
{
  require(path.join(ROOT, 'sokoni-listing-types.js'));
  const OV = require(path.join(ROOT, 'sokoni-offer-view.js'));

  const authored = {
    id: 'v1', type: 'bundle', name: 'Family Pizza Night', template: 'mealDeal',
    summary: '2 Pizzas + 2 Drinks + Side', bundlePrice: 2999, regularValue: 3650,
    items: [{ name: 'Large BBQ', qty: 1, price: 1200 }, { name: 'Garlic Bread', qty: 1, price: 250 }],
    schedule: { days: ['fri'], from: '17:00', to: '22:00' },
    status: 'live', stacking: 'exclusive', minSpend: 1000,
    locations: ['Westlands', 'Kilimani'], fulfilments: ['Delivery', 'Pickup'],
  };
  const stored = REC.fromRecord(REC.toRecord(authored, SCOPE));
  const listing = o => ({ id: 'L1', name: 'Pizza', price: 3650, listingType: 'food', offers: [o] });

  ok('the offer is still found on the listing after storage',
     !!OV.offerOf(listing(stored), FRI_18));
  ok('the card ribbon is identical',
     OV.cardBadgeHtml(listing(stored), FRI_18) === OV.cardBadgeHtml(listing(authored), FRI_18));
  ok('the card body is identical',
     OV.cardOfferHtml(listing(stored), FRI_18) === OV.cardOfferHtml(listing(authored), FRI_18));
  ok('the offer panel is identical',
     OV.detailHtml(listing(stored), { at: FRI_18 }) === OV.detailHtml(listing(authored), { at: FRI_18 }));
  ok('the contextual action is identical',
     OV.actionLabel(listing(stored), FRI_18) === OV.actionLabel(listing(authored), FRI_18),
     String(OV.actionLabel(listing(stored), FRI_18)));

  /* `regularValue` is presentation, and the panel quotes a saving from it — so if storage
     dropped it the customer would lose "Save KES 651" without any total changing. This is
     exactly the loss the resolver-equivalence test cannot see. */
  ok('the stated saving survives storage',
     OV.detailHtml(listing(stored), { at: FRI_18 }).indexOf('Save KES 651') > -1);
  ok('control — the authored offer shows the same saving',
     OV.detailHtml(listing(authored), { at: FRI_18 }).indexOf('Save KES 651') > -1);
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  server-side authorisation   [no write exists yet; the authority is ' +
            'designed in docs/OFFER_PERSISTENCE_ARCHITECTURE.md and is a callable, not rules]');
console.log('  UNPROVEN  cross-shop isolation at rest   [needs the persistence authority to exist]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
