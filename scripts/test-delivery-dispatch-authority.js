#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   DELIVERY DISPATCH AUTHORITY — findings 5–7
   ══════════════════════════════════════════════════════════════════════════════
   Run: node scripts/test-delivery-dispatch-authority.js

   dispatchDelivery, handleFailedDelivery and optimizeBatchRoute each accepted a
   client-supplied deliveryRef behind `_assertAuth` and nothing else. This suite
   holds the boundary that replaced it, and holds the shape of the fix as much as
   its behaviour: ONE actor primitive, consumed by both dispatch.js and
   fulfilment-scan.js, because a second copy is how `assigned` and
   `driver_assigned` drifted apart.

   FIXTURE
       SELLER_A ── SHOP_B ── DELIVERY_B   (RIDER_B assigned, BUYER_B ordered)
       SHOP_C   ───────────── DELIVERY_C  (RIDER_C assigned) — someone else's

   The property under test: SELLER_A cannot act on DELIVERY_C, RIDER_B cannot act
   on DELIVERY_C, and neither can do a thing their role does not own even on
   their OWN delivery.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const DA = require(path.join(ROOT, 'functions', 'delivery-authority.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};
const SRC = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
function code(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const SELLER_A = 'SELLER_A_uid_7f3';
const RIDER_B = 'RIDER_B_uid_44d';
const BUYER_B = 'BUYER_B_uid_55e';
const SHOP_C_SELLER = 'SELLER_C_uid_88z';
const RIDER_C = 'RIDER_C_uid_99y';
const STRANGER = 'STRANGER_uid_00x';

const DELIVERY_B = { sellerUid: SELLER_A, assignedDriverUid: RIDER_B, buyerUid: BUYER_B, status: 'ready_for_pickup' };
const DELIVERY_C = { sellerUid: SHOP_C_SELLER, assignedDriverUid: RIDER_C, buyerUid: 'BUYER_C', status: 'ready_for_pickup' };

const actor = (uid, delivery, token) => DA.resolveActor({ uid, token, delivery });

/* ══ 0. Controls ══════════════════════════════════════════════════════════ */
console.log('\n0. Controls — the resolver discriminates');
{
  ck('C1 the module loaded', typeof DA.resolveActor === 'function');
  ck('C2 a seller on their own delivery resolves as seller', actor(SELLER_A, DELIVERY_B) === 'seller');
  ck('C3 a rider on their own delivery resolves as rider', actor(RIDER_B, DELIVERY_B) === 'rider');
  ck('C4 a buyer resolves as buyer', actor(BUYER_B, DELIVERY_B) === 'buyer');
  /* The decisive control: a resolver that returned a role for everyone would
     pass C2–C4 and be worthless. */
  ck('C5 a stranger resolves as NULL, not a default role', actor(STRANGER, DELIVERY_B) === null);
  ck('C6 no uid resolves as null', actor(null, DELIVERY_B) === null);
  ck('C7 an unknown operation fails CLOSED', DA.mayPerform('not_an_operation', 'admin') === false);
}

/* ══ 1. Cross-tenant: the whole point of the fixture ══════════════════════ */
console.log('\n1. SELLER_A and RIDER_B cannot touch DELIVERY_C');
{
  ck('1.1 SELLER_A has no role on DELIVERY_C', actor(SELLER_A, DELIVERY_C) === null);
  ck('1.2 RIDER_B has no role on DELIVERY_C', actor(RIDER_B, DELIVERY_C) === null);
  ck('1.3 SELLER_A may not dispatch DELIVERY_C',
    !DA.mayPerform('dispatch', actor(SELLER_A, DELIVERY_C)));
  ck('1.4 SELLER_A may not fail DELIVERY_C',
    !DA.mayPerform('fail', actor(SELLER_A, DELIVERY_C)));
  ck('1.5 RIDER_B may not route DELIVERY_C',
    !DA.mayPerform('route', actor(RIDER_B, DELIVERY_C)));
  ck('1.6 ...but RIDER_C may route their own', DA.mayPerform('route', actor(RIDER_C, DELIVERY_C)));
}

/* ══ 2. Role separation on your OWN delivery ═════════════════════════════ */
console.log('\n2. Being a party is not being every party');
{
  ck('2.1 the seller may dispatch — handing over custody is their decision',
    DA.mayPerform('dispatch', actor(SELLER_A, DELIVERY_B)));
  ck('2.2 a RIDER may NOT dispatch — a rider cannot put a parcel into the cascade',
    !DA.mayPerform('dispatch', actor(RIDER_B, DELIVERY_B)));
  ck('2.3 a BUYER may not dispatch', !DA.mayPerform('dispatch', actor(BUYER_B, DELIVERY_B)));

  ck('2.4 the rider may report a failure', DA.mayPerform('fail', actor(RIDER_B, DELIVERY_B)));
  ck('2.5 the seller may report a failure', DA.mayPerform('fail', actor(SELLER_A, DELIVERY_B)));
  ck('2.6 the BUYER may NOT — a buyer disputing delivery is a dispute, not a transition',
    !DA.mayPerform('fail', actor(BUYER_B, DELIVERY_B)));

  ck('2.7 the rider may route their own delivery', DA.mayPerform('route', actor(RIDER_B, DELIVERY_B)));
  ck('2.8 the seller may NOT route — route returns customer addresses to whoever asks',
    !DA.mayPerform('route', actor(SELLER_A, DELIVERY_B)));
  ck('2.9 the buyer may not route', !DA.mayPerform('route', actor(BUYER_B, DELIVERY_B)));
}

/* ══ 3. Admin ═════════════════════════════════════════════════════════════ */
console.log('\n3. Admin, and only real admin');
{
  ck('3.1 an admin claim resolves as admin', actor(STRANGER, DELIVERY_C, { admin: true }) === 'admin');
  ck('3.2 admin may perform every operation',
    ['dispatch', 'fail', 'route'].every((op) => DA.mayPerform(op, 'admin')));
  ck('3.3 a role STRING of admin also counts', actor(STRANGER, DELIVERY_C, { role: 'admin' }) === 'admin');
  /* The numeric-role inversion recorded elsewhere in this track: a truthy-but-
     wrong claim must not become admin. */
  ck('3.4 admin:false is not admin', actor(STRANGER, DELIVERY_C, { admin: false }) === null);
  ck('3.5 a non-admin role string is not admin', actor(STRANGER, DELIVERY_C, { role: 'seller' }) === null);
  ck('3.6 an arbitrary truthy claim is not admin', actor(STRANGER, DELIVERY_C, { admin: 'yes-please' }) === null);
}

/* ══ 4. assertMayPerform throws, and throws the right code ═══════════════ */
console.log('\n4. The guard refuses rather than returning falsy');
{
  class E extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const call = (op, uid, delivery) => {
    try {
      return { ok: true, actor: DA.assertMayPerform(op, { uid, delivery, HttpsError: E }) };
    } catch (e) { return { ok: false, code: e.code }; }
  };
  ck('4.1 an authorised caller passes and returns their role',
    call('fail', RIDER_B, DELIVERY_B).actor === 'rider');
  ck('4.2 an unauthorised caller throws permission-denied',
    call('fail', STRANGER, DELIVERY_B).code === 'permission-denied');
  ck('4.3 a cross-tenant caller throws permission-denied',
    call('dispatch', SELLER_A, DELIVERY_C).code === 'permission-denied');
  ck('4.4 a wrong-role caller on their OWN delivery still throws',
    call('dispatch', RIDER_B, DELIVERY_B).code === 'permission-denied');
}

/* ══ 5. The fix is wired in, and authorises BEFORE it writes ═════════════ */
console.log('\n5. Wiring — order of operations matters');
{
  const D = code(SRC('functions/dispatch.js'));
  ck('5.1 dispatch.js requires the shared primitive', /require\('\.\/delivery-authority'\)/.test(D));
  ck('5.2 handleFailedDelivery authorises', /assertMayPerform\('fail'/.test(D));
  ck('5.3 dispatchDelivery authorises', /assertMayPerform\('dispatch'/.test(D));
  ck('5.4 optimizeBatchRoute authorises', /mayPerform\('route'/.test(D));

  /* A guard placed after the write is not a guard. */
  const failIdx = D.indexOf("assertMayPerform('fail'");
  const attemptWrite = D.indexOf("collection('deliveryAttempts').add(");
  ck('5.5 the fail guard precedes the deliveryAttempts write',
    failIdx > 0 && attemptWrite > failIdx, 'guard@' + failIdx + ' write@' + attemptWrite);
  const pkgUpdate = D.indexOf("collection('packageRequests').doc(deliveryRef).update(updates)");
  ck('5.6 ...and precedes the packageRequests status write',
    failIdx > 0 && pkgUpdate > failIdx);

  const dispIdx = D.indexOf("assertMayPerform('dispatch'");
  const cascade = D.indexOf('SokoniDispatch.', dispIdx);
  ck('5.7 the dispatch guard precedes the cascade', dispIdx > 0 && cascade > dispIdx);

  ck('5.8 optimizeBatchRoute filters PER delivery, not once for the batch',
    /deliveries\.filter\(Boolean\)\.filter\(/.test(D),
    'checking one ref, or checking "is a rider", would not be enough');
  ck('5.9 ...and refuses outright when nothing in the batch is theirs',
    /None of those deliveries are assigned to you/.test(SRC('functions/dispatch.js')));
}

/* ══ 6. ONE primitive, not two ═══════════════════════════════════════════ */
console.log('\n6. The authority is shared, not duplicated');
{
  const F = code(SRC('functions/fulfilment-scan.js'));
  ck('6.1 fulfilment-scan.js consumes the shared field lists',
    /_deliveryAuth\.BUYER_FIELDS/.test(F) && /_deliveryAuth\.RIDER_FIELDS/.test(F));
  ck('6.2 ...and no longer declares its own literal arrays',
    !/const BUYER_FIELDS\s*=\s*\[/.test(F) && !/const RIDER_FIELDS\s*=\s*\[/.test(F));
  ck('6.3 the field lists are declared exactly once across the codebase',
    (code(SRC('functions/delivery-authority.js')).match(/const RIDER_FIELDS\s*=\s*\[/g) || []).length === 1);
  /* The drift this prevents is not hypothetical: fulfilment-scan tested for
     `assigned` while dispatch wrote `driver_assigned`, and a real rider on a real
     delivery was refused the customer's address as a result. */
  ck('6.4 the shared list covers every spelling both consumers used',
    ['assignedDriverUid', 'assignedDriverId', 'riderId', 'driverId', 'assignedRiderId']
      .every((f) => DA.RIDER_FIELDS.indexOf(f) !== -1), DA.RIDER_FIELDS.join(','));
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
