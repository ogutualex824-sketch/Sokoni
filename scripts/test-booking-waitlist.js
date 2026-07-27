/* Phase-2 booking: verify the PURE waitlist helpers exported by
   functions/booking-waitlist.js — computePosition, nextEligible, canAccept, and
   the (priority ASC, createdAt ASC) ordering. Loads the REAL module with
   firebase-admin / functions stubbed (the helpers do no I/O). Transactional
   behaviour (offer minting, atomic claim, reap/re-offer) needs the emulator. */
'use strict';

/* ── Stub the two modules booking-waitlist.js requires at load, so we exercise
      the real helper source without a live Firebase. ───────────────────────── */
const Module = require('module');
const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return { firestore: () => ({ collection: () => ({}) }) };
  }
  if (request === 'firebase-functions/v2/https') {
    return { HttpsError: class HttpsError extends Error {
      constructor(code, msg) { super(msg); this.code = code; this.httpErrorCode = { canonicalName: code }; }
    } };
  }
  return _load.call(this, request, parent, isMain);
};

const { computePosition, nextEligible, canAccept } = require('../functions/booking-waitlist');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* Queue: three waiting (out of order), one already offered, one cancelled.
   Expected waiting order by (priority ASC, createdAt ASC): B(prio0,t100) →
   A(prio0,t200) → C(prio1,t50). */
const entries = [
  { id: 'A', status: 'waiting',  priority: 0, createdAt: 200 },
  { id: 'B', status: 'waiting',  priority: 0, createdAt: 100 },
  { id: 'C', status: 'waiting',  priority: 1, createdAt: 50  },
  { id: 'D', status: 'offered',  priority: 0, createdAt: 10  },
  { id: 'E', status: 'cancelled',priority: 0, createdAt: 5   },
];

/* 1. computePosition — 1-based, waiting-only, priority then createdAt */
ok(computePosition(entries, 'B') === 1, 'B is position 1 (earliest createdAt at priority 0)');
ok(computePosition(entries, 'A') === 2, 'A is position 2');
ok(computePosition(entries, 'C') === 3, 'C is position 3 (higher priority number = later)');
ok(computePosition(entries, 'D') === null, 'offered entry has no waiting position');
ok(computePosition(entries, 'Z') === null, 'unknown id → null');

/* 2. nextEligible — the first WAITING entry only */
ok(nextEligible(entries).id === 'B', 'next eligible is B');
ok(nextEligible([{ id: 'X', status: 'offered' }]) === null, 'no waiting → null');
ok(nextEligible([]) === null, 'empty queue → null');

/* 3. canAccept — the accept validation gate (offer freshness + hold liveness) */
const now = 1000;
const goodEntry = { status: 'offered', customerId: 'u1', offerId: 'of_1' };
const goodHold  = { userId: 'u1', expiresAt: now + 5000 };
ok(canAccept(goodEntry, goodHold, 'u1', 'of_1', now).ok === true, 'valid offer accepted');
ok(canAccept(null, goodHold, 'u1', 'of_1', now).reason === 'not-found', 'missing entry → not-found');
ok(canAccept({ ...goodEntry, status: 'waiting' }, goodHold, 'u1', 'of_1', now).reason === 'not-offered', 'not yet offered → not-offered');
ok(canAccept({ ...goodEntry, status: 'claimed' }, goodHold, 'u1', 'of_1', now).reason === 'not-offered', 'already claimed → not-offered (double-accept blocked)');
ok(canAccept(goodEntry, goodHold, 'u2', 'of_1', now).reason === 'not-owner', 'wrong customer → not-owner');
ok(canAccept(goodEntry, goodHold, 'u1', 'of_STALE', now).reason === 'stale-offer', 'stale/superseded offerId → stale-offer');
ok(canAccept(goodEntry, goodHold, 'u1', null, now).reason === 'stale-offer', 'missing offerId → stale-offer');
ok(canAccept(goodEntry, null, 'u1', 'of_1', now).reason === 'hold-missing', 'no hold → hold-missing');
ok(canAccept(goodEntry, { userId: 'u2', expiresAt: now + 5000 }, 'u1', 'of_1', now).reason === 'hold-owner', 'hold owned by another → hold-owner');
ok(canAccept(goodEntry, { userId: 'u1', expiresAt: now - 1 }, 'u1', 'of_1', now).reason === 'hold-expired', 'expired hold → hold-expired');
ok(canAccept(goodEntry, { userId: 'u1', expiresAt: now }, 'u1', 'of_1', now).reason === 'hold-expired', 'hold expiring exactly now → hold-expired (strict >)');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
