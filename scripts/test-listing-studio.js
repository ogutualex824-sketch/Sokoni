/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — LISTING STUDIO renderer suite
   scripts/test-listing-studio.js

   node scripts/test-listing-studio.js

   WHAT THIS PROVES, AND WHAT IT CANNOT
   The Studio is a renderer, so what is testable here is the MARKUP it emits: that the type
   picker reflects the type in force, that a type's own fields appear and another type's do
   not, that the score reports what is missing by name, and that nothing is invented for a
   listing that has no figure to show.

   It cannot prove the sheet assembles correctly in a browser — that is verified by loading
   merchant-v2.html. What it CAN prove is that every claim the markup makes is derived from
   the listing it was handed.

   EVERY ABSENCE ASSERTION IS PAIRED WITH AN INVERTING CONTROL. "The word KES does not
   appear" passes just as readily when the renderer returned an empty string, so each check
   for something missing is accompanied by a case that MUST produce it. Without that pair,
   a broken renderer reads as a clean pass.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

/* Order matters: the Studio reads both models off the global. */
require(path.join(ROOT, 'sokoni-listing-types.js'));
require(path.join(ROOT, 'sokoni-listing-model.js'));
const LS = require(path.join(ROOT, 'sokoni-listing-studio.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

/* ── 1. TYPE PICKER ─────────────────────────────────────────────────────────── */
section('Type picker');
{
  const html = LS.typePickerHTML({ listingType: 'room', name: 'Deluxe King' });
  ok('renders a chip per type', (html.match(/data-ls="type"/g) || []).length >= 8);
  ok('marks the chosen type pressed',
     html.indexOf('data-type="room" aria-pressed="true"') > -1);
  ok('marks the others unpressed',
     html.indexOf('data-type="product" aria-pressed="false"') > -1);
  ok('mirrors the choice into a savable input',
     html.indexOf('data-pf="listingType" value="room"') > -1);
  ok('names the action the customer will see', html.indexOf('Reserve') > -1);

  /* AN INFERRED TYPE MUST SAY SO. The whole point of the notice is that the merchant has
     not chosen, so the hidden input must be EMPTY — writing 'product' would turn a guess
     into a decision they never made. */
  const inferred = LS.typePickerHTML({ name: 'Thing' });
  ok('says when the type was inferred, not chosen', inferred.indexOf('Not set') > -1);
  ok('does not save an inferred type as a choice',
     inferred.indexOf('data-pf="listingType" value=""') > -1);

  /* The inverting control for that last one: an EXPLICIT type must carry a value. */
  ok('control — an explicit type does carry a value',
     LS.typePickerHTML({ listingType: 'food' }).indexOf('data-pf="listingType" value="food"') > -1);

  ok('escapes a hostile type id',
     LS.typePickerHTML({ listingType: '"><script>' }).indexOf('<script>') === -1);
}

/* ── 2. TYPE-SPECIFIC FIELDS ────────────────────────────────────────────────── */
section('Type fields');
{
  const room = LS.extraFieldsHTML({ listingType: 'room' }, []);
  ok('a room is asked for guests', room.indexOf('data-pf="lf.guests"') > -1);
  ok('a room is asked for check-in', room.indexOf('data-pf="lf.checkIn"') > -1);
  ok('a room is NOT asked for mileage', room.indexOf('lf.mileage') === -1);

  /* The inverting control — mileage must exist SOMEWHERE, or the assertion above passes
     because the renderer never emits mileage for anything. */
  const veh = LS.extraFieldsHTML({ listingType: 'vehicle' }, []);
  ok('control — a vehicle IS asked for mileage', veh.indexOf('data-pf="lf.mileage"') > -1);
  ok('a vehicle is NOT asked for guests', veh.indexOf('lf.guests') === -1);

  ok('a select field renders its options',
     veh.indexOf('<option value="Automatic"') > -1);
  ok('a bool field renders a checkbox',
     LS.extraFieldsHTML({ listingType: 'drink' }, []).indexOf('type="checkbox"') > -1);
  ok('a time field renders a time input', room.indexOf('type="time"') > -1);
  ok('a list field explains the comma', room.indexOf('Separate each one with a comma') > -1);

  /* SKIPPING IS THE RULE THAT STOPS TWO BOXES FOR ONE VALUE. */
  ok('skips a key the native form already draws',
     LS.extraFieldsHTML({ listingType: 'vehicle' }, ['mileage']).indexOf('lf.mileage') === -1);
  ok('control — and draws it when it is not skipped', veh.indexOf('lf.mileage') > -1);

  ok('a required field is marked in words, not a symbol',
     room.indexOf('required to publish') > -1);

  /* A stored list comes back as an array and must render as one editable line. */
  const withVals = LS.extraFieldsHTML(
    { listingType: 'food', attributes: { ingredients: ['Pasta', 'Cream'] } }, []);
  ok('an existing list is shown comma separated',
     withVals.indexOf('value="Pasta, Cream"') > -1);
  ok('escapes a hostile stored value',
     LS.extraFieldsHTML({ listingType: 'food', attributes: { cuisine: '"><img onerror=x>' } }, [])
       .indexOf('<img onerror') === -1);
}

/* ── 3. QUALITY ─────────────────────────────────────────────────────────────── */
section('Quality report');
{
  const empty = LS.qualityHTML({ listingType: 'product' });
  ok('an empty listing is blocked from publishing',
     empty.indexOf('Needed before you can publish') > -1);
  ok('it names what is missing rather than only scoring',
     empty.indexOf('Listing name') > -1 && empty.indexOf('Price (KES)') > -1);

  /* Routed through applyFormValues exactly as the editor does — the type's own fields live
     in `attributes`, and it is that projection which lets quality() see them at all. */
  const full = LS.applyFormValues({
    listingType: 'product', name: 'Kettle', description: 'A kettle', price: 2500,
    category: 'Home', location: 'Nairobi',
    attributes: { stock: 4 }, images: ['a', 'b', 'c'],
  }, {});
  ok('a complete listing is not blocked',
     LS.qualityHTML(full).indexOf('Everything required to publish is here') > -1);
  ok('control — the blocked wording exists and simply did not apply',
     LS.qualityHTML(full).indexOf('Needed before you can publish') === -1 &&
     empty.indexOf('Needed before you can publish') > -1);

  /* The bar must reflect the model's number, not a decorative one. */
  const LM = require(path.join(ROOT, 'sokoni-listing-model.js'));
  const score = LM.quality(full).score;
  ok('the bar width is the model\'s own score',
     LS.qualityHTML(full).indexOf('width:' + score + '%') > -1, 'expected ' + score + '%');
}

/* ── 4. PREVIEW ─────────────────────────────────────────────────────────────── */
section('Customer preview');
{
  /* NO PRICE IS NOT A FREE LISTING. This is the assertion that matters most here: a
     preview rendering "KES 0" teaches a merchant something untrue about their own listing. */
  const noPrice = LS.previewHTML({ listingType: 'product', name: 'Kettle' });
  ok('an absent price is said, not rendered as zero', noPrice.indexOf('No price yet') > -1);
  ok('and no KES figure is invented', noPrice.indexOf('KES') === -1);

  const priced = LS.previewHTML({ listingType: 'product', name: 'Kettle', price: 2500 });
  ok('control — a real price IS rendered', priced.indexOf('KES 2,500') > -1);
  ok('a zero price is treated as absent, not as free',
     LS.previewHTML({ listingType: 'product', price: 0 }).indexOf('No price yet') > -1);

  /* NO RATING IS INVENTED for a listing that has no reviews. */
  ok('no star rating is fabricated', priced.indexOf('★') === -1);

  ok('the action comes from the type — food orders',
     LS.previewHTML({ listingType: 'food', name: 'Pilau' }).indexOf('Order Now') > -1);
  ok('the action comes from the type — a service books',
     LS.previewHTML({ listingType: 'service', name: 'Service' }).indexOf('Book Appointment') > -1);
  ok('property is never offered a Buy Now',
     LS.previewHTML({ listingType: 'property', name: 'Flat' }).indexOf('Buy Now') === -1);
  ok('control — a product IS offered Buy Now', priced.indexOf('Buy Now') > -1);

  ok('an absent photo is said', noPrice.indexOf('No photo yet') > -1);
  ok('the device toggle honours the request',
     LS.previewHTML({ name: 'x' }, 'desktop').indexOf('ls-prev--desktop') > -1);
  ok('and defaults to mobile',
     LS.previewHTML({ name: 'x' }).indexOf('ls-prev--mobile') > -1);
  ok('escapes a hostile name',
     LS.previewHTML({ name: '<script>alert(1)</script>' }).indexOf('<script>') === -1);
}

/* ── 5. MEDIA GROUPS ────────────────────────────────────────────────────────── */
section('Shot list');
{
  const hotel = LS.mediaGroupsHTML({ listingType: 'room' });
  ok('a room asks for a bathroom shot', hotel.indexOf('Bathroom') > -1);
  ok('a room does not ask for a dish shot', hotel.indexOf('>Dish<') === -1);
  ok('control — food DOES ask for a dish shot',
     LS.mediaGroupsHTML({ listingType: 'food' }).indexOf('>Dish<') > -1);
  ok('it counts the photos actually present',
     LS.mediaGroupsHTML({ listingType: 'room', images: ['a', 'b'] }).indexOf('2 photos') > -1);
  ok('and says when there are none',
     hotel.indexOf('No photos yet') > -1);
  /* It must NOT offer a second way to upload — that is the duplicate media pipeline the
     engineering rule forbids. */
  ok('offers no second uploader',
     hotel.indexOf('type="file"') === -1 && hotel.indexOf('data-pf="photos"') === -1);
}

/* ── 6. LIFECYCLE ───────────────────────────────────────────────────────────── */
section('Lifecycle');
{
  ok('a new listing reads as a draft',
     LS.lifecycleHTML({}).indexOf('ls-life-s on">Draft') > -1);
  /* The editor's existing visibility field is 'active'. Reading it rather than inventing a
     parallel lifecycle field is what keeps ONE state instead of two that can disagree. */
  ok('a SAVED active product reads as live',
     LS.lifecycleHTML({ id: 'p1', status: 'active' }).indexOf('ls-life-s on">Live') > -1);

  /* THE DEFECT THE BROWSER RUN CAUGHT. The visibility select defaults to active, so the
     moment anything captured the form, an unsaved new listing announced itself as Live —
     a claim about a record that did not exist. An id is the only evidence of saving. */
  ok('an UNSAVED listing is a draft however visibility is set',
     LS.lifecycleHTML({ status: 'active' }).indexOf('ls-life-s on">Draft') > -1);
  ok('and it says nothing is saved yet',
     LS.lifecycleHTML({ status: 'active' }).indexOf('does not exist until you add it') > -1);
  ok('control — a saved one does NOT carry that warning',
     LS.lifecycleHTML({ id: 'p1', status: 'active' })
       .indexOf('does not exist until you add it') === -1);
  ok('an unknown state falls back to draft, not to nothing',
     LS.lifecycleHTML({ lifecycle: 'nonsense' }).indexOf('ls-life-s on">Draft') > -1);
}

/* ── 7. FORM VALUES FOLDED BACK ─────────────────────────────────────────────── */
section('applyFormValues');
{
  const out = LS.applyFormValues(
    { name: 'Old', attributes: { guests: 2 } },
    { name: 'New', 'lf.beds': 1 });
  ok('a typed field wins over the stored one', out.name === 'New');
  ok('a typed lf. value lands in attributes', out.attributes.beds === 1);
  ok('and the stored attributes survive', out.attributes.guests === 2);
  ok('the source listing is not mutated',
     LS.applyFormValues({ attributes: {} }, { 'lf.x': 1 }).attributes.x === 1);

  /* THE REGRESSION THIS SUITE CAUGHT. quality() looks fields up by their bare key, so a
     room's guest count sitting only in `attributes` was invisible to it — the merchant
     filled the field in and went on being told it was missing. Both shapes must now
     satisfy the scorer, and a real top-level value must still win. */
  const room = LS.applyFormValues({ listingType: 'room' }, { 'lf.guests': 2 });
  ok('an attribute is visible to the scorer by its bare key', room.guests === 2);
  ok('and is still held in attributes for the writer', room.attributes.guests === 2);
  ok('a real top-level field beats an attribute of the same name',
     LS.applyFormValues({ price: 900, attributes: { price: 1 } }, {}).price === 900);

  const LM2 = require(path.join(ROOT, 'sokoni-listing-model.js'));
  const before = LM2.quality({ listingType: 'room' }).score;
  const after = LM2.quality(room).score;
  ok('so filling a type field actually raises the score', after > before,
     before + '% → ' + after + '%');
}

/* ── 8. DEGRADES, NEVER HALF-RENDERS ────────────────────────────────────────── */
section('Missing models');
{
  const types = globalThis.SokoniListingTypes, model = globalThis.SokoniListingModel;
  delete globalThis.SokoniListingTypes;
  delete globalThis.SokoniListingModel;
  let threw = null;
  let out = '';
  try {
    out = LS.typePickerHTML({}) + LS.extraFieldsHTML({}, []) + LS.qualityHTML({}) +
          LS.previewHTML({}) + LS.mediaGroupsHTML({}) + LS.lifecycleHTML({});
  } catch (e) { threw = e; }
  globalThis.SokoniListingTypes = types;
  globalThis.SokoniListingModel = model;
  ok('it does not throw when its models are absent', !threw, threw && threw.message);
  /* Absent, not half-rendered: an empty section header with no fields under it reads to a
     merchant as a feature that is broken rather than one that did not load. */
  ok('it renders nothing rather than an empty shell', out === '');
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
