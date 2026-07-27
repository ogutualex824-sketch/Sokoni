/* Unit tests for functions/reservation-core.js — the shared reservation
   primitives (Phase A). Verifies buffered-overlap, capacity, per-customer, and
   slot-key against the exact behaviour booking.js relied on inline. Pure. */
'use strict';
const rc = require('../functions/reservation-core');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const at = (h, m) => new Date('2026-08-03T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00').getTime();
const M = 60000;

/* existing booking 10:00–11:00 */
const eS = at(10, 0), eE = at(11, 0);
const existing = [{ startTs: eS, endTs: eE }];

/* 1. buffer 0 — back-to-back allowed, real overlap blocked (matches booking.js) */
ok(rc.bufferedOverlaps(at(11, 0), at(12, 0), existing, 0, 0) === false, 'buffer0: 11:00 after 10–11 allowed');
ok(rc.bufferedOverlaps(at(9, 0), at(10, 0), existing, 0, 0) === false, 'buffer0: 09–10 before allowed');
ok(rc.bufferedOverlaps(at(10, 30), at(11, 30), existing, 0, 0) === true, 'buffer0: 10:30 real overlap blocked');

/* 2. 15-min after-buffer blocks 10:30 and 11:00, allows 11:15 (haircut example) */
ok(rc.bufferedOverlaps(at(10, 30), at(11, 30), existing, 0, 15 * M) === true, 'buf15after: 10:30 blocked');
ok(rc.bufferedOverlaps(at(11, 0), at(12, 0), existing, 0, 15 * M) === true, 'buf15after: 11:00 within cleanup blocked');
ok(rc.bufferedOverlaps(at(11, 15), at(12, 15), existing, 0, 15 * M) === false, 'buf15after: 11:15 bookable');

/* 3. before-buffer blocks a booking ending too close before */
ok(rc.bufferedOverlaps(at(9, 0), at(10, 0), existing, 15 * M, 0) === true, 'buf15before: 09–10 blocked (setup)');
ok(rc.bufferedOverlaps(at(8, 45), at(9, 45), existing, 15 * M, 0) === false, 'buf15before: ends 09:45 fine');

/* 4. pairOverlaps mirrors bufferedOverlaps for a single pair */
ok(rc.pairOverlaps(at(10, 30), at(11, 30), eS, eE, 0, 0) === true, 'pairOverlaps true on overlap');
ok(rc.pairOverlaps(at(11, 0), at(12, 0), eS, eE, 0, 0) === false, 'pairOverlaps false back-to-back');

/* 5. capacity cap (0 = unlimited) */
ok(rc.capacityExceeded(0, 1) === false, 'cap1: 0 active allowed');
ok(rc.capacityExceeded(1, 1) === true, 'cap1: 1 active exceeds');
ok(rc.capacityExceeded(9, 0) === false, 'cap0: unlimited never exceeds');

/* 6. per-customer cap (0 = unlimited) */
ok(rc.customerCapExceeded(2, 3) === false, 'custcap3: 2 allowed');
ok(rc.customerCapExceeded(3, 3) === true, 'custcap3: 3 exceeds');
ok(rc.customerCapExceeded(5, 0) === false, 'custcap0: unlimited never exceeds');

/* 7. slot key + minsToMs */
ok(rc.slotKey('2026-08-03', 100, 200) === '2026-08-03_100_200', 'slotKey format');
ok(rc.minsToMs(15) === 900000, 'minsToMs(15)=900000');
ok(rc.minsToMs(0) === 0 && rc.minsToMs(-5) === 0, 'minsToMs clamps ≥0');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
