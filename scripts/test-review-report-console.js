#!/usr/bin/env node
/* test-review-report-console.js — REVIEW / UNBOXING reports in the ONE moderation console (sokoni-trust-queues.js) and the
 * seller's status-only card (sokoni-merchant-disputes-ui.js), driven against the REAL report authority (2026-10-03).
 *
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-review-report-console.js
 *
 * The server is functions/trust-safety.js + functions/shared/review-moderation.js (sokoni-5b's module, byte-identical)
 * on the transactional fake Firestore. TRIPWIRE: firebase-admin (+ app/auth/messaging) and notify.js THROW on require;
 * row RZ asserts neither was loaded. A trust-safety.js without review targets → BLOCKED, exit 2.
 *
 * PROVES
 *   RC1  the queue renders a review row: kind, excerpt (escaped), the reviewed listing — no listing-seller column
 *   RC2  the drawer shows the review (excerpt, status, rating, writer — admins only), a safe "View listing" link, and
 *        offers EXACTLY the server's actions, worded for a review ("Uphold + remove review"; no listing take-down)
 *   RC3  uphold → tsReviewReport carries only decision fields; the toast follows the server; the review is removed
 *   RC4  restore is offered only when the server lists it, needs an internal note (≥10), and the review goes to PENDING
 *   RC5  a hostile excerpt is escaped; a target link that is not one of the two server shapes is not rendered
 *   RC6  the seller card for a review report uses status fields only (no reason, excerpt, writer, reporter, outcome)
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { makeDocument } = require('./lib/mini-dom');
let pass = 0, fail = 0;
const say = console.log;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 400) : '')); } };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET; delete process.env.FUNCTIONS_EMULATOR;
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin' || /^firebase-admin\/(app|auth|messaging|storage)$/.test(id) || id === './notify' || /[\\/]notify(\.js)?$/.test(id)) {
    throw new Error('TRIPWIRE: ' + id + ' required from a test');
  }
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
say('\nfunctions source: ' + FN_DIR);
let TS;
try { TS = require(path.join(FN_DIR, 'trust-safety.js')); } catch (e) { say('BLOCKED — cannot load trust-safety.js: ' + e.message); process.exit(2); }
if (!TS._reportModel || !TS._reportModel.REVIEW_REPORT_REASONS || typeof TS._setNotifier !== 'function') {
  say('BLOCKED — this trust-safety.js has no review report targets. Set SOKONI_FUNCTIONS_DIR to the review-reports functions lineage.');
  process.exit(2);
}
TS._setNotifier(async (o) => ({ ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } }));
console.log = console.info = console.warn = console.debug = () => {};
const TQ = require(path.join(ROOT, 'sokoni-trust-queues.js'));
const tick = async (n) => { for (let i = 0; i < (n || 30); i++) await new Promise((r) => setImmediate(r)); };
const ADMIN = { admin: true };

function consoleFor(uid, token, opts) {
  const doc = makeDocument(); const calls = []; const toasts = [];
  const o = opts || {};
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = async (name, payload) => {
    calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
    if (o.override && o.override[name]) return o.override[name](payload);
    try { return await TS[name]({ auth: { uid, token }, data: payload }); }
    catch (e) { const x = new Error(e.message); x.code = e.code; throw x; }
  };
  const Q = TQ.mount(host, { console: 'adminos', call, onToast: (m) => toasts.push(m) });
  const el = host.children[0];
  const click = (attrs) => {
    const fake = { getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false };
    const orig = el.contains.bind(el); el.contains = (n) => n === fake || orig(n);
    el.dispatchEvent({ type: 'click', target: { closest: () => fake } });
    el.contains = orig;
  };
  const field = (f, value, checked) => el.dispatchEvent({ type: 'input', target: { getAttribute: (k) => (k === 'data-f' ? f : null), value, checked } });
  return { Q, el, calls, toasts, click, field, html: () => el.innerHTML };
}

(async () => {
  await db.doc('products/p1').set({ name: 'Kitenge Dress', sellerUid: 'sellerA', shopId: 'shopA', price: 1500, isVisible: true, status: 'active' });
  await db.doc('reviews/rv1').set({ authorUid: 'authorB', targetType: 'product', targetId: 'p1', status: 'approved', rating: 5,
    body: 'Great <img src=x onerror=alert(1)> dress, buy it' });
  await db.doc('unboxingReviews/ub1').set({ uid: 'authorD', productId: 'p1', sellerUid: 'sellerA', status: 'approved', caption: 'Unboxing day' });
  const r1 = (await TS.tsReportContent({ auth: { uid: 'rep1', token: {} }, data: { entityType: 'review', entityId: 'rv1', reasonCode: 'fake_review', detail: 'reporter words' } })).reportId;
  const u1 = (await TS.tsReportContent({ auth: { uid: 'rep1', token: {} }, data: { entityType: 'unboxing', entityId: 'ub1', reasonCode: 'spam' } })).reportId;

  const C = consoleFor('adm1', ADMIN); await tick();
  const h1 = C.html();
  ck('RC1 the queue renders review rows: kind + excerpt (tags stripped by the server), "review of product p1", the rating — not a listing-seller column',
    /Review · “Great dress, buy it”/.test(h1) && /Unboxing review · “Unboxing day”/.test(h1)
      && /review of product p1/.test(h1) && /5★/.test(h1) && !/<img src=x/.test(h1) && !/seller sellerA/.test(h1), h1.slice(0, 600));

  const iR = C.Q.state().rows.findIndex((r) => r.id === r1);
  C.click({ 'data-act': 'open', 'data-i': String(iR) }); await tick();
  const dh = C.html();
  const serverCase = await TS.tsGetReportCase({ auth: { uid: 'adm1', token: ADMIN }, data: { reportId: r1 } });
  const offered = [...dh.matchAll(/data-act="(?:decide|assign)" data-v="([a-z_]+)"/g)].map((m) => m[1]).sort();
  ck('RC2 the drawer shows the review (excerpt, status, rating, writer — admins only) and a "View listing" link; offers EXACTLY the server\'s actions, uphold worded "Uphold + remove review", no take-down',
    />Great dress, buy it</.test(dh) && /approved<\/span>/.test(dh) && /5 ★/.test(dh) && /authorB <span class="stq-pill">admins only/.test(dh)
      && /href="product\.html\?id=p1"[^>]*>View listing</.test(dh)
      && JSON.stringify(offered) === JSON.stringify(serverCase.actions.slice().sort()) && /Uphold \+ remove review/.test(dh)
      && !/take listing down/.test(dh) && !offered.includes('takedown') && /NOT shown to the seller or to the writer/.test(dh), { offered, a: serverCase.actions });

  C.field('note', 'Paid review'); C.calls.length = 0;
  C.click({ 'data-act': 'decide', 'data-v': 'approve' }); await tick();
  const dec = C.calls.find((c) => c.name === 'tsReviewReport') || {};
  const allowed = ['reportId', 'action', 'resolution', 'internalNote', 'hideProduct', 'requestId', 'expectedRevision', 'applyToListing', 'restoreListing', 'takeover'];
  const extra = Object.keys(dec.payload || {}).filter((k) => !allowed.includes(k));
  ck('RC3 uphold → tsReviewReport {action:"approve"} with decision fields only (hideProduct false); toast after the server: "review removed"; the review IS removed',
    dec.payload && dec.payload.action === 'approve' && dec.payload.hideProduct === false && extra.length === 0
      && /Report upheld — review removed/.test(C.toasts.join('|')) && (await db.doc('reviews/rv1').get()).data().status === 'removed', { extra, p: dec.payload, t: C.toasts });

  const R = consoleFor('adm1', ADMIN, {}); await tick();
  R.click({ 'data-act': 'filter', 'data-v': 'upheld' }); await tick();
  R.click({ 'data-act': 'open', 'data-i': String(R.Q.state().rows.findIndex((r) => r.id === r1)) }); await tick();
  const rh = R.html();
  R.calls.length = 0;
  R.click({ 'data-act': 'decide', 'data-v': 'restore' }); await tick();
  const noNoteSent = R.calls.filter((c) => c.name === 'tsReviewReport').length;
  R.field('inote', 'Reporter was a competitor');
  R.click({ 'data-act': 'decide', 'data-v': 'restore' }); await tick();
  const rs = R.calls.find((c) => c.name === 'tsReviewReport') || {};
  ck('RC4 restore offered (server lists it) as "Restore review (back to pending)"; refused client-side without an internal note; then the review is PENDING, never approved',
    /Restore review \(back to pending\)/.test(rh) && /removed by this report/.test(rh) && noNoteSent === 0 && rs.payload && rs.payload.action === 'restore'
      && (await db.doc('reviews/rv1').get()).data().status === 'pending' && /Review sent back to pending re-review/.test(R.toasts.join('|')), { noNoteSent, p: rs.payload, t: R.toasts });

  const H = consoleFor('adm1', ADMIN, { override: { tsGetReportCase: async () => {
    const k = await TS.tsGetReportCase({ auth: { uid: 'adm1', token: ADMIN }, data: { reportId: u1 } });
    k.review = Object.assign({}, k.review, { excerpt: '<script>alert(1)</script>', listingHref: 'javascript:alert(1)' });
    return k; } } });
  await tick();
  H.click({ 'data-act': 'open', 'data-i': String(H.Q.state().rows.findIndex((r) => r.id === u1)) }); await tick();
  const hh = H.html();
  ck('RC5 a hostile excerpt is escaped, and a target link that is not product.html?id= / seller-public.html?id= is NOT rendered',
    !/<script>alert/.test(hh) && /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(hh) && !/javascript:alert/.test(hh) && !/>View listing</.test(hh), hh.slice(0, 300));

  const mui = src('sokoni-merchant-disputes-ui.js');
  const s0 = mui.indexOf("if (r.subject === 'review_on_your_listing') {");
  const blk = s0 >= 0 ? mui.slice(s0, mui.indexOf('var st = SELLER_STATUS[r.sellerStatus]', s0)) : '';
  const used = [...new Set([...blk.matchAll(/\br\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
  const okFields = ['createdAt', 'entityType', 'listingId', 'listingType', 'sellerStatus', 'subject'];
  const mine = await TS.tsGetReports({ auth: { uid: 'sellerA', token: {} }, data: { scope: 'mine' } });
  const revRows = mine.reports.filter((x) => x.subject === 'review_on_your_listing');
  ck('RC6 seller card for a review report reads STATUS fields only (no reason / excerpt / writer / reporter / outcome); the server sends exactly that',
    blk.length > 0 && used.every((f) => okFields.includes(f)) && revRows.length === 2
      && !/rep1|authorB|authorD|Great|Unboxing day|Paid review|competitor/.test(JSON.stringify(revRows)), { used, revRows });

  const cached = Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/]firebase-admin[\\/]|[\\/]notify\.js$/.test(k));
  let fired = false; try { require('firebase-admin'); } catch (e) { fired = /TRIPWIRE/.test(e.message); }
  ck('RZ tripwires held: firebase-admin and notify.js never loaded; positive control — requiring firebase-admin THROWS', cached.length === 0 && fired, cached);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
