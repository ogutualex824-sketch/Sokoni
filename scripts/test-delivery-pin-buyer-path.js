#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   getMyDeliveryPin — BEHAVIOURAL suite (no deployment required)
   ══════════════════════════════════════════════════════════════════════════════
   Run: node scripts/test-delivery-pin-buyer-path.js

   The unreachability suite proves the PIN is not obtainable by a rider. This one
   proves the other half: that moving the secret did not break the person who
   legitimately needs it.

   It loads functions/delivery-pin.js with `firebase-admin` and
   `firebase-functions` intercepted, captures the REAL handler, and runs it
   against a Firestore stub. It exercises the shipped function, not a
   reimplementation of it.

   FIXTURE
       BUYER    owns order ORD_B
       RIDER    is assigned to ORD_B
       STRANGER has no relationship to it
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const BUYER = 'BUYER_uid_11a';
const RIDER = 'RIDER_uid_22b';
const STRANGER = 'STRANGER_uid_33c';
const PIN = '481902';

/* ── Firestore stub ─────────────────────────────────────────────────────── */
const DATA = {
  orders: {
    ORD_B: { buyerUid: BUYER, assignedDriverUid: RIDER, status: 'in_transit' },
    ORD_NO_PIN: { buyerUid: BUYER, status: 'confirmed' },
    /* The self-deal case: the buyer of this order is also its rider. */
    ORD_SELF: { buyerUid: RIDER, assignedDriverUid: RIDER, status: 'in_transit' },
  },
  deliveryPins: {
    ORD_B: { orderId: 'ORD_B', pin: PIN },
    ORD_SELF: { orderId: 'ORD_SELF', pin: '999999' },
  },
  deliveryAuditLog: {},
};
const AUDIT = [];

function snap(col, id) {
  const v = DATA[col] && DATA[col][id];
  return { exists: !!v, data: () => v, id };
}
const db = {
  collection: (col) => ({
    doc: (id) => ({
      get: async () => snap(col, id),
      set: async () => {}, update: async () => {},
    }),
    add: async (entry) => { if (col === 'deliveryAuditLog') AUDIT.push(entry); },
  }),
};

/* ── Intercept the two modules delivery-pin.js requires ─────────────────── */
const captured = {};
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      firestore: Object.assign(() => db, {
        FieldValue: { serverTimestamp: () => 'TS', increment: () => 1, delete: () => 'DEL' },
      }),
      apps: [{}],
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (opts, handler) => { const h = handler || opts; captured.last = h; return h; },
      HttpsError: class extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
      },
    };
  }
  if (request === 'firebase-functions/v2/firestore') {
    return { onDocumentUpdated: (opts, handler) => handler };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: () => ({ value: () => 'test-key' }) };
  }
  return realLoad.apply(this, arguments);
};

let mod;
try {
  mod = require(path.join(__dirname, '..', 'functions', 'delivery-pin.js'));
} finally {
  Module._load = realLoad;
  Module._resolveFilename = realResolve;
}

const HttpsErrorCode = (e) => (e && e.code) || null;

(async function () {

/* ══ 0. Controls ══════════════════════════════════════════════════════════ */
console.log('\n0. Controls — the real handler was captured');
{
  ck('C1 the module loaded under interception', !!mod);
  ck('C2 getMyDeliveryPin was exported', typeof mod.getMyDeliveryPin === 'function');
  ck('C3 the stub really returns the fixture', snap('orders', 'ORD_B').exists === true);
  ck('C4 ...and really reports a missing doc as missing', snap('orders', 'NOPE').exists === false);
  /* If the stub handed back a PIN for everything, every assertion below would be
     meaningless. Prove the pin store discriminates. */
  ck('C5 the pin store has ORD_B but not ORD_NO_PIN',
    snap('deliveryPins', 'ORD_B').exists && !snap('deliveryPins', 'ORD_NO_PIN').exists);
}

const call = (auth, data) => mod.getMyDeliveryPin({ auth: auth ? { uid: auth } : null, data });

/* ══ 1. The buyer gets their PIN ══════════════════════════════════════════ */
console.log('\n1. The buyer still gets their PIN');
{
  const r = await call(BUYER, { orderId: 'ORD_B' });
  ck('1.1 the buyer receives the PIN', r && r.pin === PIN, r && r.pin);
  ck('1.2 ...flagged as issued', r && r.issued === true);
  ck('1.3 ...and the read is audited',
    AUDIT.some((a) => a.event === 'pin_read' && a.orderId === 'ORD_B'));
}

/* ══ 2. The rider cannot ══════════════════════════════════════════════════ */
console.log('\n2. The assigned rider is refused');
{
  let code = null;
  try { await call(RIDER, { orderId: 'ORD_B' }); } catch (e) { code = HttpsErrorCode(e); }
  ck('2.1 the assigned rider is refused', code === 'permission-denied', code);
  ck('2.2 ...and the refusal is audited',
    AUDIT.some((a) => a.event === 'pin_read_denied' && a.actorUid === RIDER));

  /* The self-deal case: buyer and rider are the same uid. The buyer check alone
     would PASS here, which is exactly why the rider check is separate. */
  let code2 = null;
  try { await call(RIDER, { orderId: 'ORD_SELF' }); } catch (e) { code2 = HttpsErrorCode(e); }
  ck('2.3 a rider who is also the buyer of that order is still refused',
    code2 === 'permission-denied', code2);
  ck('2.4 ...via the rider branch specifically, not the buyer branch',
    AUDIT.some((a) => a.event === 'pin_read_denied_rider'));
}

/* ══ 3. A stranger cannot ═════════════════════════════════════════════════ */
console.log('\n3. Everyone else is refused');
{
  let code = null;
  try { await call(STRANGER, { orderId: 'ORD_B' }); } catch (e) { code = HttpsErrorCode(e); }
  ck('3.1 an unrelated account is refused', code === 'permission-denied', code);

  let code2 = null;
  try { await call(null, { orderId: 'ORD_B' }); } catch (e) { code2 = HttpsErrorCode(e); }
  ck('3.2 an anonymous caller is refused', code2 === 'unauthenticated', code2);

  let code3 = null;
  try { await call(BUYER, {}); } catch (e) { code3 = HttpsErrorCode(e); }
  ck('3.3 a missing orderId is refused', code3 === 'invalid-argument', code3);

  let code4 = null;
  try { await call(BUYER, { orderId: 'NOPE' }); } catch (e) { code4 = HttpsErrorCode(e); }
  ck('3.4 an unknown order is not-found', code4 === 'not-found', code4);
}

/* ══ 4. Not-yet-issued is a real answer ═══════════════════════════════════ */
console.log('\n4. "No PIN yet" is an answer, not a failure');
{
  const r = await call(BUYER, { orderId: 'ORD_NO_PIN' });
  ck('4.1 an order with no PIN returns ok', r && r.ok === true);
  ck('4.2 ...with issued:false', r && r.issued === false);
  ck('4.3 ...and a null pin rather than a fabricated one', r && r.pin === null);
}

/* ══ 5. The value never appears where it should not ═══════════════════════ */
console.log('\n5. The PIN does not leak into telemetry');
{
  ck('5.1 no audit entry carries the PIN value',
    !AUDIT.some((a) => JSON.stringify(a).includes(PIN)),
    'audit records the event and the actor, never the secret');
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error(e); process.exit(1); });
