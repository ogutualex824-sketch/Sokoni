#!/usr/bin/env node
/* Order → receipt → printer bridge.
 *
 * THE INVARIANT THIS SUITE EXISTS TO PROTECT
 * Printing is DOWNSTREAM of money and can never flow back into it. A paid order
 * stays paid whether the printer is on, off, offline, missing, or throwing. So
 * the assertions do not merely check "did it print" — they check that NOTHING
 * was written to the order in any path, including the failure paths.
 *
 * These are BEHAVIOURAL tests: they drive the real module with fakes for
 * localStorage / PosDB / PosPrintService, rather than pattern-matching source.
 * A regex suite would pass against a bridge that mutates orders.
 *
 *   node scripts/test-order-print-bridge.js
 */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');

/* ── Environment ─────────────────────────────────────────────────────────── */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const resetStore = () => Object.keys(store).forEach((k) => delete store[k]);

require(path.join(ROOT, 'sokoni-cash.js'));
require(path.join(ROOT, 'sokoni-fulfilment.js'));
require(path.join(ROOT, 'sokoni-receipt-doc.js'));
const Bridge = require(path.join(ROOT, 'sokoni-order-print-bridge.js'));

/* Print-service fake: records jobs, can be made to fail or be absent. */
function installPrintService(mode) {
  const jobs = [];
  global.PosPrintService = {
    jobs,
    printReceipt(doc, ctx) {
      jobs.push({ doc, ctx });
      if (mode === 'throw')   throw new Error('printer offline');
      if (mode === 'reject')  return Promise.reject(new Error('printer offline'));
      if (mode === 'queued')  return Promise.resolve({ status: 'queued', jobId: 'q1' });
      return Promise.resolve({ status: 'printed', jobId: 'p1' });
    },
  };
  return jobs;
}
const setAutoPrint = (on) => {
  global.PosDB = { settings: { getAll: () => Promise.resolve({ autoPrint: on }) } };
};

const paidOnline = (over) => Object.assign({
  id: 'ORD_1', channel: 'online', paymentVerified: true,
  sellerName: 'KASS SHOP', buyerName: 'Ann', buyerPhone: '2547…',
  items: [{ name: 'Item', qty: 1, unitMinor: 10000, totalMinor: 10000 }],
  total: 100, paymentMethod: 'MPESA', mpesaCode: 'ABC123', paidAt: '2026-08-26T10:00:00Z',
}, over || {});

/* ══ A. Eligibility ══════════════════════════════════════════════════════ */
console.log('\nA. Only paid ONLINE orders are printable\n');
{
  ck('online + paid  → printable',  Bridge.isPrintable(paidOnline()) === true);
  ck('online + UNPAID → not printable',
     Bridge.isPrintable(paidOnline({ paymentVerified: false })) === false);
  ck('  ...and a missing paymentVerified is not "truthy enough"',
     Bridge.isPrintable(paidOnline({ paymentVerified: undefined })) === false);
  ck('non-online channel → not printable',
     Bridge.isPrintable(paidOnline({ channel: 'pos' })) === false);
  /* The regression the explicit discriminator exists to prevent. */
  ck('order with NO channel → not printable (no "must be online" inference)',
     Bridge.isPrintable(paidOnline({ channel: undefined })) === false);
  ck('order with no id → not printable', Bridge.isPrintable(paidOnline({ id: undefined })) === false);
}

/* ══ B. Duplicate suppression ════════════════════════════════════════════ */
console.log('\nB. A re-delivered snapshot prints once\n');
(async () => {
  resetStore();
  const jobs = installPrintService('ok');
  const o = paidOnline();

  const r1 = await Bridge.printOrder(o);
  const r2 = await Bridge.printOrder(o);   /* onSnapshot re-delivery */
  const r3 = await Bridge.printOrder(o);

  ck('first delivery prints', r1.printed === true);
  ck('second delivery does NOT print', r2.printed === false && r2.reason === 'already_printed');
  ck('third delivery does NOT print', r3.printed === false);
  ck('exactly ONE job reached the print service', jobs.length === 1, jobs.length + ' jobs');

  /* ══ C. Stable identity ════════════════════════════════════════════════ */
  console.log('\nC. Receipt identity is the stable order id\n');
  ck('job receiptId === order.id', jobs[0].ctx.receiptId === 'ORD_1');
  ck('doc.id === order.id',        jobs[0].doc.id === 'ORD_1');
  ck('doc.receiptId === order.id', jobs[0].doc.receiptId === 'ORD_1');
  ck('  ...no timestamp/random identity anywhere in the doc id',
     !/\d{13}/.test(String(jobs[0].doc.id)));
  ck('source is tagged for telemetry', jobs[0].ctx.source === 'online_order');

  /* ══ D. autoPrint gate ═════════════════════════════════════════════════ */
  console.log('\nD. autoPrint preference gates the listener\n');
  setAutoPrint(false);
  ck('autoPrint disabled → resolves false', (await Bridge.autoPrintEnabled()) === false);
  setAutoPrint(true);
  ck('autoPrint enabled  → resolves true',  (await Bridge.autoPrintEnabled()) === true);
  delete global.PosDB;
  ck('setting unreadable → FAILS CLOSED (no printing)', (await Bridge.autoPrintEnabled()) === false);

  /* ══ E. Offline printer ════════════════════════════════════════════════ */
  console.log('\nE. Offline / failing printer never touches the order\n');
  for (const mode of ['reject', 'throw']) {
    resetStore();
    installPrintService(mode);
    const order = paidOnline({ id: 'ORD_OFF_' + mode });
    const snapshot = JSON.stringify(order);
    const res = await Bridge.printOrder(order);
    ck(`printer ${mode}s → bridge resolves, never rejects`, res && res.printed === false);
    ck(`  ...order object is byte-identical afterwards`, JSON.stringify(order) === snapshot);
    ck(`  ...and it is NOT retried into a duplicate`, Bridge._alreadyPrinted(order.id) === true);
  }
  {
    resetStore();
    const jobs2 = installPrintService('queued');
    const res = await Bridge.printOrder(paidOnline({ id: 'ORD_Q' }));
    ck('a QUEUED job counts as dispatched, not as printed-to-paper',
       res.printed === true && jobs2[0] && res.result.status === 'queued');
  }
  {
    resetStore();
    delete global.PosPrintService;
    const order = paidOnline({ id: 'ORD_NOSVC' });
    const res = await Bridge.printOrder(order);
    ck('no print service at all → no throw, no mark',
       res.printed === false && res.reason === 'no_print_service');
    ck('  ...so it can still print once the service loads',
       Bridge._alreadyPrinted('ORD_NOSVC') === false);
  }

  /* ══ F. No payment/order mutation, ever ════════════════════════════════ */
  console.log('\nF. The bridge never writes order or payment state\n');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-order-print-bridge.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');   /* comments explain what it must not do */
    ck('no Firestore write API referenced',
       !/\.(set|update|add|delete)\s*\(/.test(code.replace(/localStorage\.\w+\s*\(/g, '')));
    ck('no orders collection reference', !/collection\s*\(\s*['"]orders/.test(code));
    ck('no payment collection reference',
       !/posPayments|sellerPayments|commissionLedger|paymentIntents/.test(code));
    ck('no payment endpoint called',
       !/darajaSTKPush|initiateSTKPush|savePaymentDestination|productionAuthorized/.test(code));
    ck('reads order state only through the existing listener',
       /listenSellerOrders/.test(code));
    /* Negative control — the detector must see a planted write. */
    ck('  negative control: detector DOES flag a planted order write',
       /collection\s*\(\s*['"]orders/.test("db.collection('orders').doc(id).update({})"));
  }

  /* ══ G. Delivery block ═════════════════════════════════════════════════ */
  console.log('\nG. Conditional fulfilment block\n');
  {
    const withAddr = Bridge.toReceiptDoc(paidOnline({ deliveryAddress: 'Westlands, Nairobi' }));
    ck('delivery order carries a fulfilment block', !!withAddr.fulfilment);
    ck('  ...built through SokoniFulfilment (type delivery)',
       withAddr.fulfilment && withAddr.fulfilment.type === 'delivery');
    const pickup = Bridge.toReceiptDoc(paidOnline({ fulfillmentType: 'pickup' }));
    ck('pickup order carries a pickup block', pickup.fulfilment && pickup.fulfilment.type === 'pickup');
    const plain = Bridge.toReceiptDoc(paidOnline());
    ck('order with neither → NO empty delivery block', !plain.fulfilment);
  }

  /* ══ H. The document renders through the contract ══════════════════════ */
  console.log('\nH. Renders through SokoniReceiptDoc\n');
  {
    const R = global.SokoniReceiptDoc;
    const doc = Bridge.toReceiptDoc(paidOnline({ deliveryAddress: 'Westlands' }), { name: 'KASS SHOP' });
    const out = R.render(doc);
    ck('SokoniReceiptDoc.render() accepts the bridge document', !!out && Array.isArray(out.blocks));
    /* toText() reads `receipt.blocks` — it takes the RENDERED receipt, not the
       raw document. Passing the document yields an empty string rather than an
       error, so a caller that gets this wrong prints a BLANK receipt and only
       finds out on paper. Pinned here so the order cannot be reversed. */
    ck('toText() takes the RENDERED receipt, not the document',
       R.toText(doc) === '' && R.toText(out).length > 0);
    const text = R.toText(out);
    ck('  ...and produces printable text', typeof text === 'string' && text.length > 0);
    ck('  ...naming the shop', /KASS SHOP/.test(text));
    ck('  ...and rendering the DELIVERY block for a delivery order', /DELIVER/i.test(text));
    ck('values are COPIED from the order, not recomputed',
       doc.paymentRef === 'ABC123' && doc.customer.name === 'Ann');
  }

  /* ══ I. The pos.html mount ═════════════════════════════════════════════
     The bridge is only as safe as the code that starts it. These assertions
     read the SHIPPED mount rather than a copy, because the two failure modes
     — a forged identity and a stacked listener — both live in the wiring, not
     in the module. */
  console.log('\nI. pos.html mount — identity and listener discipline\n');
  {
    const fs = require('fs');
    const H = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
    /* Slice the EXECUTABLE mount, starting at the IIFE rather than inside the
       header comment — otherwise the opening `/*` sits outside the slice, the
       comment stripper cannot match it, and the mount's own explanation of
       which identity sources it REFUSES reads as use of them. */
    const _s = H.indexOf('(function () {', H.indexOf('Start the bridge — canonical identity'));
    const _e = H.indexOf('})();', H.indexOf('waitForFirebaseReady().then(startBridge)')) + 5;
    const mountRaw = H.slice(_s, _e);
    const mount = mountRaw.replace(/\/\*[\s\S]*?\*\//g, '');   /* code only */

    ck('all five modules are loaded on pos.html',
       ['sokoni-orders.js', 'sokoni-cash.js', 'sokoni-fulfilment.js',
        'sokoni-receipt-doc.js', 'sokoni-order-print-bridge.js']
         .every((f) => new RegExp('src="' + f.replace('.', '\\.') + '"').test(H)));
    ck('  ...each exactly once (no duplicate script tags)',
       ['sokoni-orders.js', 'sokoni-cash.js', 'sokoni-fulfilment.js',
        'sokoni-receipt-doc.js', 'sokoni-order-print-bridge.js']
         .every((f) => (H.match(new RegExp('src="' + f.replace('.', '\\.') + '"', 'g')) || []).length === 1));
    ck('  ...and the existing sokoni-receipt.js is still loaded, untouched',
       /src="sokoni-receipt\.js"/.test(H));

    /* IDENTITY — the whole point of the mount. */
    ck('sellerUid comes from the authenticated user object only',
       /sellerUid: uid/.test(mount) && /user && user\.uid \? user\.uid : null/.test(mount));
    ck('NO localStorage identity is consulted by the mount',
       !/sokoniUser|sokoni_merchant_id|localStorage/.test(mount));
    ck('  ...nor a URL parameter or DOM value',
       !/URLSearchParams|location\.search|getElementById/.test(mount));
    ck('unauthenticated ⇒ the listener never starts',
       /if \(!uid\) return;/.test(mount));

    /* ONE LISTENER. onAuthStateChanged re-fires on token refresh. */
    ck('start() is guarded against a duplicate listener',
       /if \(_startedFor === uid\) return;/.test(mount));
    ck('an account switch releases the previous listener first',
       /_startedFor && _startedFor !== uid[\s\S]{0,160}?_stop\(\)/.test(mount));
    ck('the unsubscribe is retained', /_stop = B\.start\(/.test(mount));
    ck('  ...and called on beforeunload',
       /beforeunload[\s\S]{0,160}?_stop\(\)/.test(H));
    ck('a failing bridge cannot take the POS down with it',
       /catch \(e\)[\s\S]{0,140}?console\.warn\('\[order-print-bridge\]/.test(mount));
    ck('start waits for the established Firebase readiness contract',
       /waitForFirebaseReady\(\)\.then\(startBridge\)/.test(mount));

    /* ── The off-switch ──────────────────────────────────────────────────
       The bridge is deliberately PAUSED while the payment architecture is
       settled. These assertions exist so the pause cannot be lost silently —
       if someone flips it on, this suite is where that shows up. */
    ck('an explicit off-switch exists', /var BRIDGE_ENABLED = (true|false);/.test(mount));
    ck('  ...and is currently OFF (paused)', /var BRIDGE_ENABLED = false;/.test(mount),
       (mount.match(/var BRIDGE_ENABLED = (\w+);/) || [])[1]);
    ck('  ...checked BEFORE the auth listener is attached',
       /if \(!BRIDGE_ENABLED\) return;[\s\S]{0,140}?onAuthStateChanged/.test(mount));
    ck('  ...so a paused worker never observes order traffic',
       mount.indexOf('if (!BRIDGE_ENABLED) return;') < mount.indexOf('onAuthStateChanged'));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
