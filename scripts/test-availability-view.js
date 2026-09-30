/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — AVAILABILITY VIEW suite
   scripts/test-availability-view.js      node scripts/test-availability-view.js

   THE INVARIANT UNDER TEST
   ABSENT IS UNMETERED, NEVER EXHAUSTED. A listing with no stock field is not a listing with
   none left. Rendering "Out of stock" from a missing number turns a customer away from
   something that is on the shelf — a worse failure than saying nothing, and the reason this
   module says nothing about quantity unless a quantity was actually recorded.

   The mirror of that rule matters just as much: a REAL zero is a real answer and must be
   said plainly, in the listing type's own words. Every absence assertion below is therefore
   paired with a control that must produce the thing.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'sokoni-listing-types.js'));
require(path.join(ROOT, 'sokoni-availability-model.js'));
const AV = require(path.join(ROOT, 'sokoni-availability-view.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

/* ── 1. ABSENT IS UNMETERED ─────────────────────────────────────────────────── */
section('Absent quantity');
{
  const bare = { listingType: 'product', name: 'Kettle' };
  const r = AV.read(bare);
  ok('an absent count reads as null, not 0', r.count === null);
  ok('and produces no quantity sentence', r.countLabel === null);
  ok('it is not out of stock', r.state !== 'out');
  ok('the panel says nothing about how many',
     AV.panelHtml(bare).indexOf('How many') === -1);
  ok('and never says out of stock',
     AV.panelHtml(bare).indexOf('Out of stock') === -1);

  /* THE INVERTING CONTROLS. Without these the assertions above pass for a renderer that
     returns nothing at all. */
  ok('control — a real count DOES produce a sentence',
     AV.read({ listingType: 'product', stock: 12 }).countLabel === '12 in stock');
  ok('control — a real zero IS out of stock',
     AV.read({ listingType: 'product', stock: 0 }).state === 'out');
  ok('control — and the panel says so',
     AV.panelHtml({ listingType: 'product', stock: 0 }).indexOf('Out of stock') > -1);

  ok('an empty string is absent, not zero',
     AV.read({ listingType: 'product', stock: '' }).count === null);
  ok('rubbish is absent, not zero',
     AV.read({ listingType: 'product', stock: 'plenty' }).count === null);
  ok('a negative count is floored at zero, not shown negative',
     AV.read({ listingType: 'product', stock: -5 }).count === 0);
}

/* ── 2. THE TYPE'S OWN WORDS ────────────────────────────────────────────────── */
section('Type vocabulary');
{
  ok('a room counts rooms',
     AV.read({ listingType: 'room', stock: 3 }).countLabel === '3 rooms available');
  ok('one room is singular',
     AV.read({ listingType: 'room', stock: 1 }).countLabel === '1 room available');
  ok('an event counts tickets',
     AV.read({ listingType: 'event', stock: 40 }).countLabel === '40 tickets left');
  ok('food counts portions',
     AV.read({ listingType: 'food', stock: 6 }).countLabel === '6 portions left');
  ok('a product counts stock',
     AV.read({ listingType: 'product', stock: 6 }).countLabel === '6 in stock');

  /* "Out of stock" is wrong for a hotel and for an event. */
  ok('a full hotel is fully booked, not out of stock',
     AV.read({ listingType: 'room', stock: 0 }).label === 'Fully booked');
  ok('a finished event is sold out',
     AV.read({ listingType: 'event', stock: 0 }).label === 'Sold out');
  ok('a service offers appointments',
     AV.read({ listingType: 'service' }).label === 'Appointments available');
  ok('a property offers viewings',
     AV.read({ listingType: 'property' }).label === 'Viewings available');
}

/* ── 3. OPENING HOURS COME FROM THE MODEL ───────────────────────────────────── */
section('Schedule');
{
  const hours = {
    mon: { periods: [{ open: '08:00', close: '18:00' }] },
    tue: { periods: [{ open: '08:00', close: '18:00' }] },
    wed: { periods: [{ open: '08:00', close: '18:00' }] },
    thu: { closed: true },
    fri: { periods: [{ open: '08:00', close: '18:00' }] },
    sat: { periods: [{ open: '10:00', close: '14:00' }] },
    sun: { closed: true },
  };
  const shop = { listingType: 'product', hours };
  const r = AV.read(shop);
  ok('a schedule produces per-day rows', Array.isArray(r.schedule) && r.schedule.length === 7);
  ok('an open day carries its window',
     r.schedule[0].day === 'Mon' && r.schedule[0].text === '08:00–18:00');
  ok('a closed day says Closed',
     r.schedule[3].day === 'Thu' && r.schedule[3].text === 'Closed' && r.schedule[3].closed === true);
  ok('two periods in a day are both shown',
     AV.read({ hours: { mon: { periods: [{ open:'08:00', close:'12:00' },
                                         { open:'14:00', close:'18:00' }] } } })
       .schedule[0].text === '08:00–12:00, 14:00–18:00');

  /* formatWeek() returns a display STRING, and calling .map() on it throws. The rows are
     assembled from `hours` instead — this asserts the shape the panel depends on. */
  const AM = require(path.join(ROOT, 'sokoni-availability-model.js'));
  ok('control — the model\'s formatWeek really is a string, not rows',
     typeof AM.formatWeek(hours) === 'string');

  ok('the panel renders the hours table',
     AV.panelHtml(shop).indexOf('Opening hours') > -1);

  /* A WEEK CLOSED EVERY DAY is almost always an empty object, and seven "Closed" rows
     would read as a deliberate decision rather than as missing data. */
  ok('an all-closed week is not printed as a schedule',
     AV.read({ hours: { mon:{closed:true}, tue:{closed:true}, wed:{closed:true},
                        thu:{closed:true}, fri:{closed:true}, sat:{closed:true},
                        sun:{closed:true} } }).schedule === null);
  ok('control — a week with one open day IS printed',
     Array.isArray(AV.read({ hours: { mon:{periods:[{open:'09:00',close:'17:00'}]} } }).schedule));

  ok('no schedule means no hours table',
     AV.panelHtml({ listingType: 'product' }).indexOf('Opening hours') === -1);
}

/* ── 4. OPEN AND CLOSED ARE THE MODEL'S ANSWER ──────────────────────────────── */
section('Open / closed');
{
  /* Monday 10:00 is inside 08:00–18:00; Sunday is closed. The view must report whatever the
     model says and must not decide for itself. */
  const hours = { mon: { periods: [{ open: '08:00', close: '18:00' }] }, sun: { closed: true } };
  const l = { listingType: 'product', hours };
  ok('open inside the window', AV.read(l, new Date(2026, 8, 21, 10, 0)).state === 'open');
  ok('closed outside it', AV.read(l, new Date(2026, 8, 21, 22, 0)).state === 'closed');
  ok('closed on a closed day', AV.read(l, new Date(2026, 8, 20, 10, 0)).state === 'closed');
  ok('and it is said in words',
     AV.read(l, new Date(2026, 8, 20, 10, 0)).label === 'Closed right now');
}

/* ── 5. A RENTAL BECOMES AVAILABLE ON A DATE ────────────────────────────────── */
section('Available from');
{
  ok('a rental reads its date from attributes',
     AV.read({ listingType: 'rental', attributes: { availableFrom: '24 Sep' } }).from === '24 Sep');
  ok('and says so', AV.read({ listingType: 'rental', attributes: { availableFrom: '24 Sep' } })
       .label === 'Available from 24 Sep');
  ok('the live form value is read too, before it is saved',
     AV.read({ listingType: 'rental', 'lf.availableFrom': '1 Oct' }).from === '1 Oct');
  ok('no date means no block',
     AV.panelHtml({ listingType: 'rental' }).indexOf('Available from') === -1);
}

/* ── 6. SAFETY ──────────────────────────────────────────────────────────────── */
section('Safety');
{
  ok('a hostile count cannot inject',
     AV.panelHtml({ listingType: 'product', stock: '<img src=x onerror=1>' }).indexOf('<img') === -1);
  ok('a hostile date is escaped',
     AV.panelHtml({ listingType: 'rental', attributes: { availableFrom: '<script>x</script>' } })
       .indexOf('<script>') === -1);
  ok('a null listing does not throw', (function () {
     try { AV.panelHtml(null); return true; } catch (_) { return false; } })());

  /* Degrades rather than half-renders when its models are missing. */
  const types = globalThis.SokoniListingTypes, model = globalThis.SokoniAvailabilityModel;
  delete globalThis.SokoniListingTypes; delete globalThis.SokoniAvailabilityModel;
  let threw = null, out = '';
  try { out = AV.panelHtml({ stock: 4 }); } catch (e) { threw = e; }
  globalThis.SokoniListingTypes = types; globalThis.SokoniAvailabilityModel = model;
  ok('it does not throw without its models', !threw, threw && threw.message);
  ok('and still tells the truth about the count', out.indexOf('4 in stock') > -1);
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
