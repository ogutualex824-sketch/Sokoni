#!/usr/bin/env node
/* test-kass-stay-quote.js — KASS stay prices come from the canonical listing; the AI / user is never the monetary authority.
 *
 *   node scripts/test-kass-stay-quote.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-stay-quote.js  # functions/index.js @ 4e9607b — failures ARE the defect
 *
 * LIVE defect (production sokonichat-00058-hal, docs/C4_C8_PRODUCTION_PRIVACY_AUTH_CENSUS.md #2): book_stay wrote
 * totalPrice = the MODEL's pricePerNight × nights into `bookings` — a store no host reads — and search_stays read the
 * legacy `listings` / `hotels` stores raw, showed "KES 0/night" for directory hotels, and linked to pages that do not
 * exist (short-stays.html, hotels.html).
 *
 * The REAL _execChatTool (with the KASS access gate) is sliced from functions/index.js and run on a transactional
 * fake Firestore seeded with canonical `bnbListings` (active / pending / unpriced) and host `bnbBookings`.
 *
 * PROVES
 *   Q1  the book_stay tool offers the model NO price input
 *   Q2  a price the model/user supplies is ignored: the quote is the listing's pricePerNight × nights
 *   Q3  a listing not approved by AdminOS (pending) is refused, never quoted
 *   Q4  an id that is not a canonical listing (e.g. from a legacy store) is refused
 *   Q5  a listing with no price is refused — never quoted as KES 0
 *   Q6  past dates, reversed dates and over-long stays are refused
 *   Q7  more guests than the listing takes is refused
 *   Q8  dates overlapping a live host booking are refused; a CANCELLED booking does not block (control)
 *   Q9  quoting writes NOTHING (no ghost `bookings` record, no bnbBookings record)
 *   Q10 a hotel is handed to its own page — KASS does not price hotel rooms
 *   S1  search_stays returns ACTIVE canonical listings with the listing's own price and id; pending ones never
 *   S2  a directory hotel with no price says so — never "KES 0/night"
 *   S3  the legacy `listings` / `hotels` stores are not read
 *   L1  KASS never links to the non-existent short-stays.html / hotels.html
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const IDX = CPM ? cp.execFileSync('git', ['show', '4e9607b:functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 }) : fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };

function slice(sig) {
  const s = IDX.indexOf(sig); if (s < 0) return '';
  let d = 0, i = IDX.indexOf('{', s);
  for (; i < IDX.length; i++) { if (IDX[i] === '{') d++; else if (IDX[i] === '}' && --d === 0) break; }
  return IDX.slice(s, i + 1);
}
const GATE = [(IDX.match(/const KASS_GUEST_CHAT = [^;]+;/) || [''])[0], (IDX.match(/const _KASS_TOOL_ACCESS = Object\.freeze\(\{[\s\S]*?\}\);/) || [''])[0],
  slice('function _kassToolAllowed(name, ctx)'), slice('function _authRequired()')].join('\n');
const EXEC = slice('async function _execChatTool(name, input, ctx)');

const TODAY = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function world() {
  const F = makeFakeFirestore({});
  const seed = {
    'bnbListings/L_ACTIVE':  { status: 'active', name: 'Sunset Loft', pricePerNight: 4500, city: 'Nairobi', maxGuests: 3, hostUid: 'host1', phone: '0700000000' },
    'bnbListings/L_PENDING': { status: 'pending', name: 'Pending Villa', pricePerNight: 9000, city: 'Nairobi', hostUid: 'host2' },
    'bnbListings/L_NOPRICE': { status: 'active', name: 'Mystery Cabin', city: 'Nairobi', hostUid: 'host3' },
    'bnbBookings/B1': { listingId: 'L_ACTIVE', checkIn: day(10), checkOut: day(13), status: 'confirmed', uid: 'g1', hostUid: 'host1' },
    'bnbBookings/B2': { listingId: 'L_ACTIVE', checkIn: day(20), checkOut: day(23), status: 'cancelled', uid: 'g2', hostUid: 'host1' },
    'listings/LEG1': { name: 'Legacy Listing', pricePerNight: 1, city: 'Nairobi' },
    'hotels/H1': { name: 'Legacy Hotel', price: 1, city: 'Nairobi' },
  };
  const reads = [];
  const origColl = F.db.collection;
  F.db.collection = (c) => { reads.push(c); return origColl(c); };
  return { F, seed, reads };
}
async function run(tool, input, uid = 'user_1') {
  const W = world();
  for (const [p, d] of Object.entries(W.seed)) { const [c, id] = p.split('/'); await W.F.db.collection(c).doc(id).set(d); }
  W.reads.length = 0;
  const before = JSON.stringify(W.F.db._dump(''));
  const results = [], actions = [];
  const req = (m) => {
    if (m === './kass-directory') return { findBusinesses: async () => ({ businesses: [{ uid: 'hotelUid', providerId: 'P1', name: 'Grand Hotel', city: 'Nairobi', photo: null, rating: 4.5 }] }) };
    if (m.startsWith('./')) return require(path.join(FN, m));
    return require(require.resolve(m, { paths: [FN] }));
  };
  const sb = vm.createContext({ db: W.F.db, admin: { firestore: { FieldValue: W.F.FieldValue } }, require: req, console: { log() {}, warn() {}, error() {} },
    encodeURIComponent, Promise, Object, Array, JSON, Number, String, Date, Math, Set, Map, RegExp, Error });
  vm.runInContext(GATE + '\n' + EXEC + '\nthis.__exec = _execChatTool;', sb);
  let r;
  try { r = await sb.__exec(tool, input, { uid, addResult: (x) => results.push(x), addAction: (a) => actions.push(a) }); } catch (e) { r = { crash: e.message }; }
  return { r, results, actions, wrote: JSON.stringify(W.F.db._dump('')) !== before, dump: W.F.db._dump(''), reads: W.reads.slice() };
}

(async () => {
  console.log('\nSOURCE: functions/index.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defect' : 'working tree (fix)'));
  /* Q1 */
  const toolsBlock = IDX.slice(IDX.indexOf('name: "book_stay"'), IDX.indexOf('name: "compare_products"'));
  ck('Q1  book_stay offers the model NO price input', toolsBlock.length > 0 && !/pricePerNight/.test(toolsBlock.slice(toolsBlock.indexOf('properties'))), toolsBlock.slice(0, 80));

  const q2 = await run('book_stay', { listingId: 'L_ACTIVE', listingName: 'x', checkIn: day(3), checkOut: day(5), guests: 2, pricePerNight: 1 });
  ck('Q2  a supplied price is ignored: total = listing KES 4,500 × 2 nights = KES 9,000', !!q2.r && q2.r.quoted === true && q2.r.totalPrice === 'KES 9,000', q2.r);
  const q3 = await run('book_stay', { listingId: 'L_PENDING', checkIn: day(3), checkOut: day(5) });
  ck('Q3  a pending (not AdminOS-approved) listing is refused', !!q3.r && q3.r.quoted === false && q3.r.reason === 'not_bookable', q3.r);
  const q4 = await run('book_stay', { listingId: 'LEG1', checkIn: day(3), checkOut: day(5), pricePerNight: 1 });
  ck('Q4  a non-canonical (legacy) id is refused', !!q4.r && q4.r.quoted === false && q4.r.reason === 'not_bookable', q4.r);
  const q5 = await run('book_stay', { listingId: 'L_NOPRICE', checkIn: day(3), checkOut: day(5), pricePerNight: 5000 });
  ck('Q5  a listing with no price is refused, never quoted', !!q5.r && q5.r.quoted === false && q5.r.reason === 'no_price', q5.r);
  const q6a = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(-2), checkOut: day(1) });
  const q6b = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(5), checkOut: day(3) });
  const q6c = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(1), checkOut: day(80) });
  ck('Q6  past / reversed / over-long stays are refused', [q6a, q6b, q6c].every((x) => x.r && x.r.quoted === false) && q6a.r.reason === 'past_date' && q6b.r.reason === 'bad_dates' && q6c.r.reason === 'too_long', [q6a.r, q6b.r, q6c.r].map((x) => x && (x.reason || x.error)));
  const q7 = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(3), checkOut: day(5), guests: 5 });
  ck('Q7  more guests than the listing takes (3) is refused', !!q7.r && q7.r.quoted === false && q7.r.reason === 'too_many_guests', q7.r);
  const q8a = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(11), checkOut: day(12) });
  const q8b = await run('book_stay', { listingId: 'L_ACTIVE', checkIn: day(20), checkOut: day(22) });
  ck('Q8  overlapping a live host booking is refused; a cancelled booking does not block (control)', !!q8a.r && q8a.r.reason === 'unavailable' && !!q8b.r && q8b.r.quoted === true, [q8a.r, q8b.r]);
  ck('Q9  quoting writes nothing (no ghost bookings record, no bnbBookings record)', !q2.wrote && !q8b.wrote, { q2: q2.wrote, bookings: q2.dump.filter((d) => /^bookings\//.test(d.path)).length });
  const q10 = await run('book_stay', { listingId: 'hotelUid', listingType: 'hotel', checkIn: day(3), checkOut: day(5), pricePerNight: 2000 });
  ck('Q10 a hotel is handed to its own page; KASS does not price it', !!q10.r && q10.r.quoted === false && !q10.wrote, q10.r);

  const s = await run('search_stays', { location: 'Nairobi' });
  const ids = (s.r && s.r.stays || []).map((x) => x.id);
  const loft = (s.r && s.r.stays || []).find((x) => x.id === 'L_ACTIVE');
  ck('S1  search_stays returns ACTIVE canonical listings with their own price and id; never pending', !!loft && /4,500/.test(loft.pricePerNight) && !ids.includes('L_PENDING'), s.r);
  const hotel = (s.r && s.r.stays || []).find((x) => x.type === 'hotel');
  ck('S2  a directory hotel with no price says so — never "KES 0/night"', !!hotel && !/KES 0\b/.test(hotel.pricePerNight) , hotel);
  ck('S3  the legacy listings / hotels stores are not read', !s.reads.includes('listings') && !s.reads.includes('hotels'), s.reads);
  ck('L1  KASS never links to the non-existent short-stays.html / hotels.html', !/short-stays\.html|hotels\.html/.test(IDX));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
