/* Phase-1 booking: verify the buffered-overlap formula and per-customer cap logic
   (the exact math wired into functions/booking.js bookingCreate + bookingHoldSlot).
   Pure — no Firestore. Full transactional behaviour needs the emulator. */
'use strict';
const M = 60000; // ms/min
/* conflict iff the buffered windows overlap: new occupies [s-bufB, e+bufA] */
function conflicts(ns, ne, bs, be, bufBmin, bufAmin) {
  const bufB = bufBmin * M, bufA = bufAmin * M;
  return (ns - bufB) < (be + bufA) && (ne + bufA) > (bs - bufB);
}
const at = (h, m) => new Date('2026-07-27T' + String(h).padStart(2,'0') + ':' + String(m||0).padStart(2,'0') + ':00').getTime();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* existing booking 10:00–11:00 */
const eS = at(10,0), eE = at(11,0);

/* 1. DEFAULT (buffer 0) — back-to-back is allowed, exactly as today */
ok(conflicts(at(11,0), at(12,0), eS, eE, 0, 0) === false, 'buffer 0: 11:00 booking after 10–11 is allowed (no change)');
ok(conflicts(at(9,0),  at(10,0), eS, eE, 0, 0) === false, 'buffer 0: 09–10 before is allowed');
ok(conflicts(at(10,30),at(11,30),eS, eE, 0, 0) === true,  'buffer 0: real 10:30 overlap still blocked');

/* 2. Your example — 60-min haircut + 15-min after-buffer blocks 10:30 and 11:00 */
ok(conflicts(at(10,30),at(11,30),eS, eE, 0, 15) === true,  'buf 15after: 10:30 blocked');
ok(conflicts(at(11,0), at(12,0), eS, eE, 0, 15) === true,  'buf 15after: 11:00 blocked (within cleanup)');
ok(conflicts(at(11,15),at(12,15),eS, eE, 0, 15) === false, 'buf 15after: 11:15 bookable (buffer cleared)');

/* 3. before-buffer blocks a booking ending too close before */
ok(conflicts(at(9,0),  at(10,0), eS, eE, 15, 0) === true,  'buf 15before: 09–10 blocked (needs setup before 10:00)');
ok(conflicts(at(8,45), at(9,45), eS, eE, 15, 0) === false, 'buf 15before: ends 09:45 is fine');

/* 4. per-customer cap: reject once active count reaches max (0 = unlimited) */
const capHit = (active, max) => max > 0 && active >= max;
ok(capHit(2, 3) === false, 'cap 3, active 2 → allowed');
ok(capHit(3, 3) === true,  'cap 3, active 3 → rejected');
ok(capHit(9, 0) === false, 'cap 0 (unlimited) → never rejected');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
