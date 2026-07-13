#!/usr/bin/env node
/**
 * test-procurement.js — the Purchase Order chain. Static + executed. Sends nothing.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * "Send PO" saved data and delivered nothing. Not because the feature was unbuilt — a
 * complete procurement backend already existed (11 Cloud Functions: create, approve,
 * send, goods-received, invoicing, a double-entry ledger, vendor performance).
 *
 * There were simply TWO purchase-order systems in one product, and they had never met:
 *
 *   CLIENT  inventory.html → SokoniInventory.createPO()  → `inventory_purchaseOrders`
 *           supplier picker                              → `inventory_suppliers`
 *   SERVER  createPurchaseOrder / sendPurchaseOrder      → `procPurchaseOrders`
 *           supplier validation                          → `procSuppliers`
 *
 * The client never called a single procurement Cloud Function. "Send PO" wrote a document
 * and set status:'sent' on a collection no function reads. The backend was orphaned.
 *
 * And even if it HAD been called, the email could not have gone out: sendPurchaseOrder
 * hand-wrote an emailQueue document with no `status` and no `nextAttempt`, while
 * processEmailQueue selects on exactly those two fields. Two independent reasons no
 * supplier has ever received a purchase order.
 *
 * Same shape as fcmToken/fcmTokens and deepLink/url elsewhere in this codebase: a
 * producer and a consumer that were never introduced.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const proc  = fs.readFileSync(path.resolve('functions/procurement.js'), 'utf8');
const procC = strip(proc);
const inv   = strip(fs.readFileSync(path.resolve('inventory.html'), 'utf8'));
const email = fs.readFileSync(path.resolve('functions/email-service.js'), 'utf8');
const notif = fs.readFileSync(path.resolve('functions/notify.js'), 'utf8');

console.log('\nProcurement — the Purchase Order chain\n');

/* ── 1. The client must call the SERVER, not write its own document ─────────── */
{
  /createPurchaseOrder/.test(inv) && /sendPurchaseOrder/.test(inv)
    ? ok('the client calls createPurchaseOrder AND sendPurchaseOrder (the PO is really sent)')
    : bad('the client does not call the procurement Cloud Functions — Send PO would only save data');

  /approvePurchaseOrder/.test(inv)
    ? ok('the PO is approved before sending (sendPurchaseOrder refuses anything not approved)')
    : bad('the PO is never approved — sendPurchaseOrder will reject it');

  !/SokoniInventory\.createPO\(/.test(inv)
    ? ok('the orphaned client-only createPO() path is gone')
    : bad('the client still writes its own PO document — the server never sees it');
}

/* ── 2. ONE supplier list, ONE PO collection ────────────────────────────────── */
{
  /collection\('procSuppliers'\)/.test(inv)
    ? ok('the supplier picker reads procSuppliers — the collection the server validates against')
    : bad('the supplier picker reads a different collection — every PO would be rejected as "Supplier not found"');

  /collection\('procPurchaseOrders'\)/.test(inv)
    ? ok('the PO list reads procPurchaseOrders — the collection the server writes')
    : bad('the PO list reads a collection the server never writes — a sent PO would never appear');

  /httpsCallable\('addSupplier'\)/.test(inv)
    ? ok('suppliers are created through addSupplier (so the server can find them)')
    : bad('suppliers are created client-side and are invisible to procurement');

  !/inventory_suppliers|inventory_purchaseOrders/.test(inv)
    ? ok('no reference remains to the orphaned inventory_* procurement collections')
    : bad('the orphaned inventory_suppliers / inventory_purchaseOrders collections are still referenced');
}

/* ── 3. The email must be able to actually send ─────────────────────────────── */
{
  /* processEmailQueue selects on status=='pending' AND nextAttempt<=now. A hand-written
     queue document without those fields is invisible to it — forever. */
  !/collection\('emailQueue'\)\.doc\(\)/.test(procC)
    ? ok('procurement no longer hand-writes emailQueue documents')
    : bad('procurement hand-writes an emailQueue doc — it will lack status/nextAttempt and never send');

  /emailSvc\.queue\(/.test(procC)
    ? ok('the PO email goes through EmailService.queue() — it gets status, nextAttempt, retries and DLQ')
    : bad('the PO email does not use the canonical enqueue — it will never be picked up');

  /attachments:/.test(procC) && /toString\('base64'\)/.test(procC)
    ? ok('the PDF is attached to the email (a supplier receives a document, not a formatted message)')
    : bad('no PDF is attached — the PO is not a document the supplier can file or sign');

  /* And the transport must be able to carry it. */
  /msg\.attachments = payload\.attachments/.test(email)
    ? ok('SendGrid transport forwards attachments')
    : bad('SendGrid transport drops attachments — the PDF would silently not arrive');

  /attachments:\s*\(Array\.isArray\(payload\.attachments\)/.test(email)
    ? ok('the SMTP fallback carries attachments too (a SendGrid outage cannot silently drop the PDF)')
    : bad('the SMTP fallback drops attachments — a failover would send a PO with no PO in it');
}

/* ── 4. The supplier is told by SMS + in-app, through the ONE engine ────────── */
{
  /notify\.notify\(/.test(procC)
    ? ok('the supplier is notified through the notification engine (SMS + in-app + push)')
    : bad('the supplier gets no SMS or in-app notification');

  /po_sent:\s*\{/.test(notif)
    ? ok('po_sent is a registered notification type (the engine rejects unknown types)')
    : bad('po_sent is not registered — notify() would throw and the supplier would be told nothing');

  const sms = fs.readFileSync(path.resolve('functions/sms-service.js'), 'utf8');
  /po_sent:\s*\{/.test(sms)
    ? ok('a po_sent SMS template exists')
    : bad('no po_sent SMS template — the SMS would fail to render');
}

/* ── 5. "Sent" must be a checkable claim ───────────────────────────────────── */
{
  /delivery\.email = 'queued'/.test(procC) && /delivery\.email = 'failed'/.test(procC)
    ? ok('the PO records a real delivery outcome (queued / failed / no_email_on_supplier)')
    : bad('delivery outcome is not recorded — "sent" would be an unverifiable claim');

  !/emailQueued: !!supplier\?\.email/.test(procC)
    ? ok('the old `emailQueued: !!supplier.email` lie is gone (it reported success whenever an address merely existed)')
    : bad('sendPurchaseOrder still reports success based on the supplier HAVING an email, not on sending one');
}

/* ── 6. Server owns the money. Client figures are never trusted. ────────────── */
{
  /const subtotal\s*=\s*\+cleanItems\.reduce/.test(procC) && /vatAmount\s*=\s*\+\(subtotal \* VAT_RATE\)/.test(procC)
    ? ok('subtotal and VAT are computed SERVER-side (client totals are not trusted)')
    : bad('totals are not computed server-side — a client could dictate the value of a purchase order');

  /poNumber\s*=\s*`PO-\$\{year\}-/.test(proc)
    ? ok('a human PO number is generated transactionally (PO-2026-00042), collision-safe')
    : bad('no human-readable PO number — a supplier cannot quote "po_a3f9c1" on an invoice');
}

/* ── 7. The PDF is real ─────────────────────────────────────────────────────── */
{
  const { buildPoPdf } = require(path.resolve('functions/po-pdf.js'));
  const buf = buildPoPdf(
    { poNumber: 'PO-2026-00042', createdAt: Date.now(), items: [{ name: 'Test Item', sku: 'X1', qty: 2, unitCost: 100 }],
      subtotal: 200, vatAmount: 32, total: 232 },
    { name: 'Test Supplier Ltd', email: 's@example.com' },
    { name: 'Test Merchant' },
  );
  const s = buf.toString('latin1');

  buf.slice(0, 8).toString() === '%PDF-1.4' && s.trim().endsWith('%%EOF')
    ? ok('buildPoPdf() emits a structurally valid PDF')
    : bad('buildPoPdf() output is not a valid PDF');

  /* xref offsets must land exactly on their objects, or every reader rejects the file. */
  const sx = /startxref\s+(\d+)/.exec(s);
  const lines = s.slice(Number(sx[1])).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  let broken = 0;
  for (let i = 1; i < count; i++) {
    const off = Number(lines[2 + i].slice(0, 10));
    if (!s.slice(off, off + 12).startsWith(i + ' 0 obj')) broken++;
  }
  broken === 0
    ? ok(`all ${count - 1} PDF xref offsets land on their objects (the file opens)`)
    : bad(`${broken} xref offsets are wrong — the PDF is corrupt and will not open`);

  /* PDF escapes ( and ) — testing for the RAW text would be testing for a bug. */
  const esc = t => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const need = ['SOKONI', 'PURCHASE ORDER', 'PO-2026-00042', 'Test Supplier Ltd',
                'GRAND TOTAL', 'Accepted by (Supplier)', 'Bravilex International Co. Limited'];
  const missing = need.filter(n => !s.includes(esc(n)));
  missing.length === 0
    ? ok('the PDF carries branding, PO number, both parties, totals, signature blocks and the legal entity')
    : bad('PDF is missing: ' + missing.join(', '));
}

console.log('');
if (fail) { console.error(`Procurement FAILED (${fail}) — the PO may not reach the supplier\n`); process.exit(1); }
console.log(`Procurement PASSED (${pass} checks) — nothing sent\n`);
