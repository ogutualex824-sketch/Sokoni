/* Unit tests for the pure slot-bookability decision (Slice 2, functions/availability.js
 * _computeSlotReason). This is the SINGLE place getAvailabilitySlots decides whether a
 * generated slot is offerable, so displayed availability matches the booking gate. Covers:
 *   - unconditional now-floor (past never bookable, even when allowSameDay=true),
 *   - break pre-filter, min-notice / same-day, max-advance horizon,
 *   - booked via legacy startTime set AND via canonical providerBookings interval overlap
 *     (incl. a pending HOLD), with correct precedence (most-definitive-first).
 *
 *   node scripts/test-availability-slots.js
 */
'use strict';
const path = require('path');
/* availability.js calls admin.firestore() at load; initialise the SAME firebase-admin
   instance it will resolve (from functions/) so the handle exists. No network occurs —
   _computeSlotReason is pure (only rc.pairOverlaps + time math). */
const admin = require(path.resolve('functions/node_modules/firebase-admin'));
try { admin.initializeApp({ projectId: 'sokoni-test' }); } catch (_) { /* already initialised */ }
const { _computeSlotReason } = require(path.resolve('functions/availability.js'));

const NOW = 1_700_000_000_000;      /* fixed clock — the helper is pure, never calls Date.now() */
const H = 3_600_000, MIN = 60_000, DAY = 86_400_000;
const earliest = NOW + 1 * H;       /* 1h min-notice */
const horizon = NOW + 30 * DAY;

/* Build a slot input at `hoursFromNow`, 60-min duration, overriding any field. */
function slot(hoursFromNow, over) {
  const s = NOW + hoursFromNow * H;
  return Object.assign({
    startT: '12:00', startMins: 720, endMins: 780,
    slotStartMs: s, slotEndMs: s + H,
    nowMs: NOW, earliestBookableMs: earliest, horizonMs: horizon,
    allowSameDay: false, breaks: [], activeBookings: [], bufMs: 0,
    bookedStartTimes: new Set(),
  }, over || {});
}
const reason = (o) => _computeSlotReason(o);

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== bookable ===');
t('clean future slot -> null (bookable)', reason(slot(3)) === null);

console.log('\n=== now-floor (past) is unconditional ===');
t('past slot -> "past"', reason(slot(-2)) === 'past');
t('past slot with allowSameDay=true STILL "past" (the bug we fixed)',
  reason(slot(-2, { allowSameDay: true })) === 'past');

console.log('\n=== min-notice / same-day ===');
t('within notice window, same-day OFF -> "too_soon"',
  reason(slot(0.5)) === 'too_soon');
t('within notice window, same-day ON -> bookable',
  reason(slot(0.5, { allowSameDay: true })) === null);

console.log('\n=== max-advance horizon ===');
t('beyond maxDaysAhead -> "beyond_horizon"',
  reason(slot(31 * 24)) === 'beyond_horizon');
t('just inside horizon -> bookable',
  reason(slot(29 * 24)) === null);

console.log('\n=== breaks ===');
t('slot overlapping a 12:00-13:00 break -> "break"',
  reason(slot(3, { breaks: [{ start: '12:00', end: '13:00' }] })) === 'break');
t('slot outside the break -> bookable',
  reason(slot(3, { startT: '14:00', startMins: 840, endMins: 900, breaks: [{ start: '12:00', end: '13:00' }] })) === null);

console.log('\n=== booked: legacy startTime set ===');
t('legacy bookedStartTimes has this startT -> "booked"',
  reason(slot(3, { startT: '12:00', bookedStartTimes: new Set(['12:00']) })) === 'booked');

console.log('\n=== booked: canonical providerBookings interval overlap (incl. HOLD) ===');
const s3 = NOW + 3 * H;
t('active booking exactly overlapping -> "booked"',
  reason(slot(3, { activeBookings: [{ startTs: s3, endTs: s3 + H }] })) === 'booked');
t('active PENDING hold overlapping -> "booked" (holds hide slots)',
  reason(slot(3, { activeBookings: [{ startTs: s3 + 30 * MIN, endTs: s3 + 90 * MIN }] })) === 'booked');
t('non-overlapping active booking -> bookable',
  reason(slot(3, { activeBookings: [{ startTs: s3 + 5 * H, endTs: s3 + 6 * H }] })) === null);
t('buffer makes an adjacent booking overlap -> "booked"',
  reason(slot(3, { bufMs: 30 * MIN, activeBookings: [{ startTs: s3 + 60 * MIN, endTs: s3 + 120 * MIN }] })) === 'booked');

console.log('\n=== precedence: most-definitive-first ===');
t('booked AND past -> "booked" (booked wins)',
  reason(slot(-2, { bookedStartTimes: new Set(['12:00']) })) === 'booked');
t('past AND on-break -> "past" (past wins over break)',
  reason(slot(-2, { breaks: [{ start: '11:00', end: '13:00' }] })) === 'past');

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
