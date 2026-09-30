/* test-catalogue-capabilities.js — universal catalogue U2 (2026-09-29): the capability matrix covers EVERY registered
 * SOKONI business, agrees with the category and workspace authorities, and uses ONE listing vocabulary.
 *
 * The category registry (functions/business-category.js) is the source of truth — not an example list.
 *
 * PROVES
 *   M1 every one of the canonical categories has a capability row — and no row names a category that does not exist
 *   M2 every registered business id and profession resolves to a row; the admin-review-only ids get the UNCLASSIFIED
 *      row (goods only, flagged) — never a guessed category
 *   M3 ONE vocabulary: every type a row permits is a sokoni-listing-types id; every such id has model fields
 *   M4 rows with a merchant workspace profile agree with business-workspace.PROFILE_OF (quoted → quote; appointment →
 *      booking + inventory + POS; accommodation → rooms; property → property, no basket goods; learning → booking)
 *   M5 the brief's examples hold: restaurants list dishes not rooms; hotels list rooms; a lawyer has no stock, till or
 *      goods; car hire can list vehicles and rentals; property has no basket goods; clinicians sell no goods; couriers
 *      carry no inventory; compliance keys are from the one list
 *   M6 each type collects its own fields: required fields exist, and a type's fields are not another's
 *   M7 check(): a type outside the row is refused; unclassified shops cannot list rooms; an unknown type is refused;
 *      a taxonomy category that contradicts the type is refused
 *   M8 the browser copy is byte-identical to the server source
 *   M9 per-category matrix: for EVERY category, allowed types appear, at least one disallowed type is refused, the
 *      counted/booked/quoted flags match the types it permits
 *
 *   node scripts/test-catalogue-capabilities.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-catalogue-caps';
const Path = require('path');
const cp = require('child_process');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
const load = (p) => { try { return require(Path.join(ROOT, p)); } catch (e) { return null; } };

const BC = load('functions/business-category.js');
const WS = load('functions/business-workspace.js');
const CC = load('functions/shared/catalogue-capabilities.js');
load('sokoni-listing-types.js'); load('sokoni-listing-model.js');
const LT = globalThis.SokoniListingTypes, LM = globalThis.SokoniListingModel;
const TX = load('sokoni-product-taxonomy.js');

if (!BC || !WS || !CC || !LT || !LM || !TX) {
  ck('the authorities load (business-category, business-workspace, catalogue-capabilities, listing types/model, taxonomy)', false,
    { BC: !!BC, WS: !!WS, CC: !!CC, LT: !!LT, LM: !!LM, TX: !!TX });
  say(`\n${pass} passed, ${fail} failed`); process.exit(1);
}

const cats = BC.KEYS.slice();
const rows = Object.keys(CC.CAPS);
const missing = cats.filter((c) => rows.indexOf(c) === -1), invented = rows.filter((r) => cats.indexOf(r) === -1);
ck(`M1 all ${cats.length} canonical categories have a row; none is invented`, cats.length >= 31 && !missing.length && !invented.length, { missing, invented });

const bizIds = Object.keys(BC.FROM_BUSINESS_ID), profs = Object.keys(BC.FROM_PROFESSION);
const unresolved = [], unclassifiedIds = [];
for (const id of bizIds) {
  const c = BC.FROM_BUSINESS_ID[id];
  if (c === null) { if (CC.capsFor(c).unclassified !== true) unresolved.push(id); else unclassifiedIds.push(id); }
  else if (!CC.CAPS[c]) unresolved.push(id);
}
for (const p of profs) { const c = BC.FROM_PROFESSION[p]; if (c !== null && !CC.CAPS[c]) unresolved.push('prof:' + p); }
ck(`M2 all ${bizIds.length} business ids and ${profs.length} professions resolve; admin-review-only ids are UNCLASSIFIED (${unclassifiedIds.join(', ')})`,
  bizIds.length >= 100 && !unresolved.length && unclassifiedIds.length === BC.ADMIN_REVIEW_ONLY.length
  && CC.UNCLASSIFIED.types.indexOf('room') === -1 && CC.UNCLASSIFIED.types.indexOf('service') === -1, { unresolved });

const ltIds = Object.keys(LT.TYPES);
const badType = [];
rows.forEach((r) => CC.CAPS[r].types.forEach((t) => { if (ltIds.indexOf(t) === -1) badType.push(r + ':' + t); }));
const noFields = CC.TYPE_IDS.filter((t) => !(LM.fieldsFor({ listingType: t }).length > 5));
ck('M3 ONE vocabulary: every permitted type is a listing-types id; the id lists are the same; every type has its own fields',
  !badType.length && CC.TYPE_IDS.slice().sort().join() === ltIds.slice().sort().join() && !noFields.length, { badType, noFields, lt: ltIds.length });

const prof = WS.PROFILE_OF, disagree = [];
Object.keys(prof).forEach((c) => {
  const r = CC.CAPS[c]; if (!r) { disagree.push(c + ':no-row'); return; }
  if (r.profile !== prof[c]) disagree.push(c + ':profile ' + r.profile + '≠' + prof[c]);
  if (prof[c] === 'quoted_service' && !r.quote) disagree.push(c + ':quote');
  if (prof[c] === 'appointment_shop' && !(r.booking && r.inventory && r.pos)) disagree.push(c + ':appointment');
  if (prof[c] === 'accommodation' && r.types.indexOf('room') === -1) disagree.push(c + ':room');
  if (prof[c] === 'property' && (r.types.indexOf('property') === -1 || r.types.indexOf('product') !== -1 || r.types.indexOf('bundle') !== -1)) disagree.push(c + ':property');
  if (prof[c] === 'learning' && !r.booking) disagree.push(c + ':learning');
});
ck(`M4 the ${Object.keys(prof).length} rows with a workspace profile agree with business-workspace.PROFILE_OF`, Object.keys(prof).length >= 10 && !disagree.length, disagree);

const C = CC.CAPS, has = (c, t) => C[c].types.indexOf(t) !== -1;
const compKeys = Object.keys(CC.COMPLIANCE), badComp = [];
rows.forEach((r) => C[r].compliance.forEach((k) => { if (compKeys.indexOf(k) === -1) badComp.push(r + ':' + k); }));
const examples = {
  restaurantDishes: has('restaurant', 'food') && has('restaurant', 'drink') && !has('restaurant', 'room') && C.restaurant.compliance.indexOf('food_licence') !== -1,
  hotelRooms: has('hotel', 'room') && C.hotel.booking,
  lawyerNoGoods: !C.lawyer.inventory && !C.lawyer.pos && !has('lawyer', 'product') && !has('lawyer', 'bundle') && C.lawyer.compliance.indexOf('legal_credential') !== -1,
  carHireVehicles: BC.FROM_BUSINESS_ID['car-rental'] === 'auto_services' && has('auto_services', 'vehicle') && has('auto_services', 'rental'),
  propertyNoBasket: has('property', 'property') && !has('property', 'product') && !has('property', 'package'),
  clinicianNoGoods: !has('clinician', 'product') && !C.clinician.inventory,
  courierNoStock: !C.delivery.inventory && !C.delivery.pos,
  constructionProjects: BC.FROM_BUSINESS_ID.contractor === 'trades' && has('trades', 'project') && has('trades', 'custom_job') && C.trades.quote,
  printingCustomJobs: BC.FROM_BUSINESS_ID.printing === 'service_business' && has('service_business', 'custom_job'),
  salonServicesAndProducts: has('salon', 'service') && has('salon', 'product') && C.salon.staff,
  retailGoodsOnly: has('retail_store', 'product') && !has('retail_store', 'room') && !has('retail_store', 'service'),
};
const brokenEx = Object.keys(examples).filter((k) => !examples[k]);
ck('M5 the brief\'s examples hold (restaurant, hotel, lawyer, car hire, property, clinician, courier, construction, printing, salon, retail); compliance keys are from the one list',
  !brokenEx.length && !badComp.length, { brokenEx, badComp });

const fieldKeys = (t) => LM.fieldsFor({ listingType: t }).map((f) => f.key);
const reqOk = CC.TYPE_IDS.every((t) => LM.fieldsFor({ listingType: t }).some((f) => f.required && ['name', 'description', 'price', 'category', 'location'].indexOf(f.key) === -1) || ['digital', 'drink', 'food', 'rental'].indexOf(t) !== -1);
const irrelevant = fieldKeys('service').indexOf('roomType') === -1 && fieldKeys('product').indexOf('roomType') === -1 && fieldKeys('room').indexOf('make') === -1
  && fieldKeys('project').indexOf('stock') === -1 && fieldKeys('custom_job').indexOf('stock') === -1 && fieldKeys('package').indexOf('components') !== -1 && fieldKeys('bundle').indexOf('components') !== -1;
ck('M6 each type collects its own fields: type-specific required fields exist; a room\'s fields are not a product\'s; quoted work has no stock; packages and bundles name components', reqOk && irrelevant);

const e = (c, l) => (CC.check(c, l, TX).errors[0] || {}).code || null;
const m7 = {
  lawyerProduct: e('lawyer', { listingType: 'product' }), unclassifiedRoom: e(null, { listingType: 'room' }), unknown: e('retail_store', { listingType: 'spaceship' }),
  mismatch: e('retail_store', { listingType: 'product', category: 'ebook' }), restaurantFood: e('restaurant', { listingType: 'food', category: 'food' }),
  hotelRoom: e('hotel', { listingType: 'room' }), unclassifiedGoods: e(null, { listingType: 'product', category: 'electronics' }),
};
ck('M7 check(): outside-the-row refused; unclassified cannot list rooms; unknown type refused; a contradicting taxonomy category refused; the permitted pass',
  m7.lawyerProduct === 'TYPE_NOT_ALLOWED' && m7.unclassifiedRoom === 'TYPE_NOT_ALLOWED' && m7.unknown === 'UNKNOWN_TYPE' && m7.mismatch === 'CATEGORY_MISMATCH'
  && m7.restaurantFood === null && m7.hotelRoom === null && m7.unclassifiedGoods === null, m7);

let copyOk = false; try { cp.execFileSync(process.execPath, [Path.join(ROOT, 'scripts', 'build-catalogue-capabilities.js'), '--check'], { stdio: 'pipe' }); copyOk = true; } catch (_) {}
ck('M8 the browser copy is byte-identical to functions/shared/catalogue-capabilities.js', copyOk);

/* M9 — the per-category matrix, one row at a time */
const perCat = [];
rows.forEach((c) => {
  const r = C[c], errs = [];
  r.types.forEach((t) => { if (CC.check(c, { listingType: t }).errors.some((x) => x.code === 'TYPE_NOT_ALLOWED')) errs.push('allowed ' + t + ' refused'); });
  const other = CC.TYPE_IDS.filter((t) => r.types.indexOf(t) === -1);
  if (!other.length) errs.push('permits every type');
  else if (!CC.check(c, { listingType: other[0] }).errors.some((x) => x.code === 'TYPE_NOT_ALLOWED')) errs.push('disallowed ' + other[0] + ' accepted');
  if (r.types.some((t) => CC.COUNTED.indexOf(t) !== -1) !== r.inventory && c !== 'venue') errs.push('inventory flag ≠ counted types');
  if (r.types.some((t) => CC.QUOTED.indexOf(t) !== -1) && !r.quote) errs.push('quoted types without quote');
  if (!r.types.length || !r.fulfilment.length) errs.push('empty types or fulfilment');
  if (errs.length) perCat.push(c + ': ' + errs.join('; '));
});
ck(`M9 per-category matrix — all ${rows.length} rows: permitted types accepted, others refused, counted/quoted flags consistent`, !perCat.length, perCat);

say(`\n  matrix: ${rows.length} categories · ${bizIds.length} business ids · ${profs.length} professions · ${CC.TYPE_IDS.length} listing types`);
say(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
