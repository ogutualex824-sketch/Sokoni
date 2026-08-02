/* Unit tests for the booking lifecycle event builder (Slice 4 observability,
 * functions/booking-events.js). The builder must:
 *   - stamp a DETERMINISTIC event id (`${bookingId}_${key}`) when a key is given, so a
 *     retried/duplicate delivery overwrites the same doc → no duplicate audit entries
 *     (Scenario 7 idempotency), and a random id when no key is given (repeatable events),
 *   - carry the canonical schema: type, actor, participants, previousStatus→newStatus,
 *     paymentRef, data.
 *
 *   node scripts/test-booking-events.js
 */
'use strict';
const path = require('path');
/* booking-events.js calls admin.firestore() at load; init the SAME instance it resolves. */
const admin = require(path.resolve('functions/node_modules/firebase-admin'));
try { admin.initializeApp({ projectId: 'sokoni-test' }); } catch (_) { /* already */ }
const { bookingEvent, TYPES } = require(path.resolve('functions/booking-events.js'));

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

console.log('\n=== deterministic id (idempotent) vs random ===');
const rel1 = bookingEvent({ bookingId: 'bkA', type: TYPES.RELEASED, key: 'released' });
const rel2 = bookingEvent({ bookingId: 'bkA', type: TYPES.RELEASED, key: 'released' });
t('keyed event id is `${bookingId}_${key}`', rel1.ref.id === 'bkA_released');
t('two keyed events for same booking share the SAME id (overwrite, no dup)', rel1.ref.id === rel2.ref.id);
t('different booking → different id', bookingEvent({ bookingId: 'bkB', type: TYPES.RELEASED, key: 'released' }).ref.id === 'bkB_released');
const r1 = bookingEvent({ bookingId: 'bkA', type: TYPES.RESUMED });
const r2 = bookingEvent({ bookingId: 'bkA', type: TYPES.RESUMED });
t('no key → random ids (repeatable events differ)', r1.ref.id !== r2.ref.id);

console.log('\n=== writes to the canonical bookingEvents collection ===');
t('collection is bookingEvents', rel1.ref.parent.id === 'bookingEvents');

console.log('\n=== payload schema ===');
const e = bookingEvent({
  bookingId: 'bk1', type: TYPES.HELD, actor: 'customer',
  providerId: 'prov1', customerUid: 'cust1',
  previousStatus: null, newStatus: 'pending', paymentRef: null,
  data: { expiresAt: 123, priceCents: 5000 }, key: 'held',
}).payload;
t('bookingId', e.bookingId === 'bk1');
t('type is BOOKING_HELD', e.type === 'BOOKING_HELD');
t('actor', e.actor === 'customer');
t('providerId + customerUid denormalised', e.providerId === 'prov1' && e.customerUid === 'cust1');
t('previousStatus null, newStatus pending', e.previousStatus === null && e.newStatus === 'pending');
t('data carried through', e.data.priceCents === 5000 && e.data.expiresAt === 123);
t('has a timestamp (ts number)', typeof e.ts === 'number');

console.log('\n=== defaults ===');
const d = bookingEvent({ bookingId: 'bk2', type: TYPES.EXPIRED }).payload;
t('actor defaults to system', d.actor === 'system');
t('missing participants default to null', d.providerId === null && d.customerUid === null && d.paymentRef === null);
t('data defaults to {}', d.data && typeof d.data === 'object' && Object.keys(d.data).length === 0);

console.log('\n=== all six canonical types present ===');
t('TYPES complete', ['HELD', 'RESUMED', 'RELEASED', 'EXPIRED', 'PAYMENT_CONFIRMED', 'CONFIRMED'].every(k => typeof TYPES[k] === 'string'));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
