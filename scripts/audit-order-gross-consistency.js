/* AUDIT — gateway amount vs the gross that settlement consumes.  READ-ONLY.
   ==========================================================================
   Run:  cd functions && node ../scripts/audit-order-gross-consistency.js

   Answers ONE question with production data, because source reading cannot:

       Does the figure settlement pays on (orderTotal ?? total) ever differ from
       the figure the gateway confirmed (paidAmount)?

   NO WRITES. It opens the Admin SDK read-only: get() only, no set/update/delete
   anywhere in this file. Nothing is repaired, normalised or removed.

   ── CLASSIFICATION ────────────────────────────────────────────────────────
     A  CONSISTENT                orderTotal == total == paidAmount
     B  UNVERIFIED GROSS          orderTotal == total  !=  paidAmount
                                   CAVEAT: on the IntaSend rail paidAmount appears to
                                   be NET OF GATEWAY CHARGES (observed 100 vs 97), so
                                   this comparison can be gross-vs-net rather than a
                                   discrepancy. B is a QUESTION, not a verdict.
     C  INTERNAL GROSS DIVERGENCE orderTotal != total
     D  SETTLEMENT INPUT MISSING  paidAmount present, orderTotal/total absent
     E  UNADJUDICATED             no paidAmount — the rail cannot be established

   settlementStatus is reported but is NEVER used as evidence that an amount was
   correct. It proves the settlement path ran, nothing more.
==========================================================================*/
'use strict';
/* firebase-admin resolves from functions/, not the repo root — running this from
   scripts/ finds no module even with cwd set to functions/, because require() walks
   up from the FILE's directory. Resolve explicitly. */
const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
try { admin.initializeApp({ projectId: 'sokoni-aeb26' }); } catch (_) {}
const db = admin.firestore();

const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const eq = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;

(async () => {
  const snap = await db.collection('orders').get();
  const rows = [];

  snap.forEach((d) => {
    const o = d.data();
    const orderTotal = n(o.orderTotal);
    const total      = n(o.total);
    const paid       = n(o.paidAmount);
    /* CASE-INSENSITIVE. The first version compared against 'SETTLED' while the stored
       value is 'settled', so the escalation counter reported 0 for a record that was
       printed two lines below it as settled on an unverified amount. A control that
       cannot see the case it exists to catch is worse than no control. */
    const settled    = String(o.settlementStatus || '').toLowerCase() === 'settled';

    let cls;
    if (paid === null)                          cls = 'E_UNADJUDICATED';
    else if (orderTotal === null && total === null) cls = 'D_SETTLEMENT_INPUT_MISSING';
    else if (orderTotal !== null && total !== null && !eq(orderTotal, total))
                                                cls = 'C_INTERNAL_GROSS_DIVERGENCE';
    else if (!eq(orderTotal !== null ? orderTotal : total, paid))
                                                cls = 'B_UNVERIFIED_GROSS';
    else                                        cls = 'A_CONSISTENT';

    rows.push({
      orderId: d.id,
      paymentMethod: o.paymentMethod || null,
      status: o.status || null,
      orderTotal, total, paid,
      deliveryFee: n(o.deliveryFee),
      settlementStatus: o.settlementStatus || null,
      settled,
      cls,
    });
  });

  const tally = rows.reduce((a, r) => { a[r.cls] = (a[r.cls] || 0) + 1; return a; }, {});
  const rails = rows.reduce((a, r) => {
    const k = r.paymentMethod || '(absent)'; a[k] = (a[k] || 0) + 1; return a;
  }, {});

  /* The escalation trigger: a SETTLED order whose settlement gross is not the
     gateway figure. Reported separately from the tally because it is the only
     result that changes what happens next. */
  const settledMismatchOrderTotal = rows.filter(r =>
    r.settled && r.paid !== null && r.orderTotal !== null && !eq(r.orderTotal, r.paid));
  const settledMismatchTotal = rows.filter(r =>
    r.settled && r.paid !== null && r.total !== null && !eq(r.total, r.paid));

  console.log('\n  ORDER GROSS CONSISTENCY — production, read-only\n');
  console.log('  orders examined:            ' + rows.length);
  console.log('  payment methods present:    ' + JSON.stringify(rails));
  console.log('');
  for (const k of ['A_CONSISTENT', 'B_UNVERIFIED_GROSS', 'C_INTERNAL_GROSS_DIVERGENCE',
                   'D_SETTLEMENT_INPUT_MISSING', 'E_UNADJUDICATED']) {
    console.log('  ' + k.padEnd(30) + (tally[k] || 0));
  }
  console.log('');
  console.log('  SETTLED while orderTotal != paidAmount:  ' + settledMismatchOrderTotal.length);
  console.log('  SETTLED while total      != paidAmount:  ' + settledMismatchTotal.length);

  if (settledMismatchOrderTotal.length || settledMismatchTotal.length) {
    console.log('\n  ── ESCALATE — settled on a figure the gateway did not confirm');
    for (const r of [...new Set([...settledMismatchOrderTotal, ...settledMismatchTotal])]) {
      console.log('     ' + r.orderId + '  orderTotal=' + r.orderTotal
        + ' total=' + r.total + ' paidAmount=' + r.paid
        + ' settlementStatus=' + r.settlementStatus);
    }
  }

  const notA = rows.filter(r => r.cls !== 'A_CONSISTENT');
  if (notA.length) {
    console.log('\n  ── every non-CONSISTENT record');
    for (const r of notA.slice(0, 40)) {
      console.log('     ' + r.cls.padEnd(28) + r.orderId
        + '  orderTotal=' + r.orderTotal + ' total=' + r.total + ' paid=' + r.paid
        + ' method=' + r.paymentMethod + ' settlement=' + r.settlementStatus);
    }
  }

  console.log('\n  READ-ONLY. settlementStatus is reported, never treated as evidence that');
  console.log('  an amount was correct — it only proves the settlement path ran.\n');
  process.exit(0);
})().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
