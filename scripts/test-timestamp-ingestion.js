/* Timestamp-shape ingestion regression — proves the 9→0 marketplace-sync bug is fixed.
   A Firestore Timestamp read in the Seller iframe is postMessage'd to the shell, where
   structured-clone strips its prototype: it arrives as a PLAIN {seconds, nanoseconds}
   object with no .toMillis(). The old mappers left that as an object, so `ts >= from` was
   NaN and EVERY such order was dropped by the range filter. This locks the coercion +
   the forensic diagnose() reasons so a regression is caught, not shipped. */
'use strict';
const path = require('path');
global.window = {};
require(path.join(__dirname, '..', 'sokoni-order-service.js'));
const OS = global.window.SokoniOrderService;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* The exact shape a Firestore Timestamp becomes after postMessage structured-clone. */
const tsPlain = (ms) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
const tsUnderscore = (ms) => ({ _seconds: Math.floor(ms / 1000), _nanoseconds: 0 });   /* alt serialization */
const now = Date.now();
const dayMs = 86400000;

(async () => {
  /* 9 marketplace orders, all with plain-cloned Timestamp createdAt (the real failure). */
  const nine = [];
  for (let i = 0; i < 9; i++) nine.push({ id: 'ORD-' + i, sellerUid: 'S1', orderTotal: 100 + i, status: 'delivered', createdAt: tsPlain(now - i * dayMs), items: [{ name: 'X', qty: 1, price: 100 }] });
  OS.setOnlineProvider(function () { return nine; });

  let rows = await OS.query({ range: 'all', tab: 'all' });
  let mk = rows.filter(r => r.source === 'marketplace');
  ok(mk.length === 9, 'all 9 plain-Timestamp marketplace orders now ingest (was 0 — the bug)');
  ok(mk.every(r => typeof r.ts === 'number' && r.ts > 0), 'every ts coerced to epoch millis (not left an object)');
  ok(mk.some(r => Math.abs(r.ts - now) < 5000), 'newest order keeps its real timestamp (not fallback Date.now for all)');

  /* Underscore-serialization + ISO string + numeric-string all coerce too. */
  OS.setOnlineProvider(function () {
    return [
      { id: 'U1', orderTotal: 50, status: 'completed', createdAt: tsUnderscore(now - dayMs) },
      { id: 'S2', orderTotal: 60, status: 'completed', createdAt: new Date(now - 2 * dayMs).toISOString() },
      { id: 'N3', orderTotal: 70, status: 'completed', createdAt: String(now - 3 * dayMs) },
    ];
  });
  rows = await OS.query({ range: 'all', tab: 'all' });
  ok(rows.filter(r => r.source === 'marketplace').length === 3, 'underscore-Timestamp + ISO + numeric-string all ingest');

  /* Range filtering still works AFTER coercion (a today-scope drops last-week orders,
     but for the RIGHT reason — outside-range — not a timestamp bug). */
  OS.setOnlineProvider(function () {
    return [
      { id: 'TODAY', orderTotal: 10, status: 'completed', createdAt: tsPlain(now) },
      { id: 'OLD', orderTotal: 20, status: 'completed', createdAt: tsPlain(now - 40 * dayMs) },
    ];
  });
  const todayRows = await OS.query({ range: 'today', tab: 'all' });
  ok(todayRows.filter(r => r.source === 'marketplace').some(r => r.id === 'TODAY'), 'today-scope keeps a today order (coercion works with range)');
  ok(!todayRows.filter(r => r.source === 'marketplace').some(r => r.id === 'OLD'), 'today-scope excludes a 40-day-old order (legit range filter, not the bug)');

  /* ── Forensic diagnose(): 9 → 9, no rejections, reasons exposed when there ARE drops. */
  OS.setOnlineProvider(function () { return nine; });
  let rep = await OS.diagnose({ range: 'all', tab: 'all' });
  ok(rep.marketplace.fetched === 9 && rep.marketplace.accepted === 9, 'diagnose: marketplace 9 → 9 (found = accepted)');
  ok(rep.marketplace.rejected.length === 0, 'diagnose: no rejections when all ingest');
  ok(rep.boundaries.unified === 9, 'diagnose: 9 reach the unified stream');
  ok(rep.summary && rep.summary.count === 9, 'diagnose: summary computes over the 9');

  /* A branch mismatch is surfaced as a REASON (needsReview), never a silent drop. */
  OS.setOnlineProvider(function () {
    return [
      { id: 'A', orderTotal: 100, status: 'completed', createdAt: tsPlain(now), branchId: 'shopA' },
      { id: 'B', orderTotal: 200, status: 'completed', createdAt: tsPlain(now), branchId: 'shopB' },
      { id: 'L', orderTotal: 300, status: 'completed', createdAt: tsPlain(now), branchId: null },   /* legacy */
    ];
  });
  rep = await OS.diagnose({ range: 'all', tab: 'all', branchId: 'shopA' });
  ok(rep.marketplace.accepted === 2, 'diagnose: active branch keeps its own + legacy (2), drops the other');
  const bReject = rep.marketplace.rejected.find(x => x.id && String(x.id).indexOf('B') > -1);
  ok(bReject && /branch-mismatch/.test(bReject.reason) && /needsReview/.test(bReject.reason), 'diagnose: other-branch order exposed as branch-mismatch/needsReview, not deleted');

  /* A genuinely unparseable timestamp is reported with that exact reason (never hidden). */
  OS.setOnlineProvider(function () { return [{ id: 'BADTS', orderTotal: 5, status: 'completed', createdAt: { foo: 'bar' } }]; });
  rep = await OS.diagnose({ range: 'today', tab: 'all' });
  /* {foo} → _toMs null → _fromOnline falls back to Date.now() so it still ingests today. */
  ok(rep.marketplace.accepted === 1, 'unparseable ts falls back to now (ingests) rather than vanishing');

  console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
