#!/usr/bin/env node
/* test-disputes-reports-convergence.js — the REPORT half of ec40b9b's suite, ported for community C2 (2026-10-01).
 *
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-disputes-reports-convergence.js
 *
 * Ported: RM1–RM3 (seller scope) and UI1 (every side mounts the ONE queue). NOT ported (listed in CHANGELOG): DT1–DT3,
 * DA1–DA4 (the dispute trigger and adminOsDispatch dispute ops — ec40b9b's server changes are not on the live functions
 * lineage), RC1 (conversation reports — messagesDispatch / moderationQueue, a separate store), UI2–UI3 (dispute.html,
 * unboxing.html — out of scope). A trust-safety.js without the report authority → BLOCKED (exit 2).
 *
 * PROVES
 *   RM1 a seller reads reports about THEIR listings (tsGetReports scope:'mine') — without the reporter, their text or
 *       the document id (which embeds the reporter uid)
 *   RM2 another seller's reports are never included; signed-out is refused; the admin path still needs admin
 *   RM3 an admin take-down is visible to the seller: productHidden + the outcome note + moderationState
 *   UI1 AdminOS + super admin mount the ONE shared queue; merchant-v2 wires callReports with scope:'mine'
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
say('\nfunctions source: ' + FN_DIR);
let TS; try { TS = require(path.join(FN_DIR, 'trust-safety.js')); } catch (e) { say('BLOCKED — ' + e.message); process.exit(2); }
if (typeof TS.tsGetReportReasons !== 'function') { say('BLOCKED — no report authority in this trust-safety.js; set SOKONI_FUNCTIONS_DIR to the functions lineage.'); process.exit(2); }
console.log = console.info = console.warn = console.debug = () => {};
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message }; } };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });

(async () => {
  await db.doc('products/m1').set({ name: 'Mine One', sellerUid: 'sellerM', price: 100, status: 'active' });
  await db.doc('products/o1').set({ name: 'Other One', sellerUid: 'sellerO', price: 100, status: 'active' });
  const a = await tryv(TS.tsReportContent(as('rep1', { entityType: 'product', entityId: 'm1', reasonCode: 'other', detail: 'Secret reporter text here' })));
  await tryv(TS.tsReportContent(as('rep2', { entityType: 'product', entityId: 'o1', reasonCode: 'scam' })));
  const mine = await tryv(TS.tsGetReports(as('sellerM', { scope: 'mine' })));
  const blob = JSON.stringify(mine);
  ck('RM1 the seller reads the report on THEIR listing — no reporter, no reporter text, no document id',
    Array.isArray(mine.reports) && mine.reports.length === 1 && mine.reports[0].productName === 'Mine One' && mine.reports[0].moderationState === 'pending'
      && !blob.includes('rep1') && !blob.includes('Secret reporter text') && !blob.includes(a && a.reportId) && !/reportedBy/.test(blob), blob.slice(0, 200));
  const rm2 = [await codeOf(TS.tsGetReports(as(null, { scope: 'mine' }))), await codeOf(TS.tsGetReports(as('sellerM', {})))];
  ck("RM2 another seller's report is never included; signed-out refused; the admin list needs admin",
    !blob.includes('Other One') && rm2[0] === 'unauthenticated' && rm2[1] === 'permission-denied', rm2);
  await tryv(TS.tsReviewReport(as('adm', { reportId: a && a.reportId, action: 'approve', hideProduct: true, resolution: 'Listing removed: off-platform payment' }, { admin: true })));
  const after = await tryv(TS.tsGetReports(as('sellerM', { scope: 'mine' })));
  const r = (after.reports || [])[0] || {};
  ck('RM3 the take-down reaches the seller: productHidden, the outcome note, moderationState approved',
    r.productHidden === true && r.outcome === 'Listing removed: off-platform payment' && r.moderationState === 'approved', r);

  const aos = src('sokoni-aos.js'), sa = src('super-admin.html'), aosHtml = src('admin-os.html'), mv = src('merchant-v2.html'), mui = src('sokoni-merchant-disputes-ui.js');
  ck('UI1 AdminOS + super admin mount the ONE queue; merchant-v2 wires callReports with scope:"mine"',
    /window\.SokoniTrustQueues\.mount\(host,/.test(aos) && /window\.SokoniTrustQueues\.mount\(root,/.test(sa)
      && /<script src="sokoni-trust-queues\.js"><\/script>/.test(aosHtml) && /<script src="sokoni-trust-queues\.js"><\/script>/.test(sa)
      && /callReports: _callable\('tsGetReports'\)/.test(mv) && /callReports\(\{ scope: 'mine' \}\)/.test(mui));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
