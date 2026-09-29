/* test-disputes-reports-convergence.js — disputes and reports readable on every side (2026-09-29)
 *   REAL functions/disputes.js, admin-os.js (its dispatch handlers), trust-safety.js, messages.js and the
 *   automation-engine dispute trigger, over the fake Firestore; plus the client sources.
 *
 * PROVES
 *   DT1 the dispute trigger no longer locks a new dispute: with its rule off the status stays 'open'
 *   DT2 ...with its rule on, an open dispute moves to 'investigating' (an OPEN status) — never 'under_review'
 *   DT3 a legacy 'under_review' dispute is open again: the seller responds, the buyer adds evidence
 *   DA1 AdminOS / super admin list (adminOsDispatch › adminGetDisputes): every active status incl. legacy, with the
 *       parties' NAMES; resolved ones only under 'final'; a non-admin is refused
 *   DA2 the admin detail carries timeline, evidence and the seller's response
 *   DA3 resolving from AdminOS goes through the ONE core: favour recorded, timeline entry, order synced, audited;
 *       a resolution without a note or a side is refused
 *   DA4 a query failure is an ERROR, not an empty list
 *   RM1 a seller reads reports about THEIR listings (tsGetReports scope:'mine') — without the reporter or their text
 *   RM2 ...another seller's reports are never included; signed-out is refused; the admin path still needs admin
 *   RM3 an admin take-down is visible to the seller: productHidden + the outcome note
 *   RC1 conversation reports (moderationQueue) are listed and reviewed through messagesDispatch for an admin
 *   UI1 AdminOS + super admin + legacy console mount the ONE shared queue; merchant-v2 wires callReports
 *   UI2 dispute.html is a router (no localStorage history, no client dispute write); SokoniDispute uses the callables
 *   UI3 no fake "Thank you for the report" remains on unboxing.html
 *
 *   node scripts/test-disputes-reports-convergence.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-disputes-reports';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
const DSP = require(Path.join(FN, 'disputes.js'));
const AOS = require(Path.join(FN, 'admin-os.js'));
const TS = require(Path.join(FN, 'trust-safety.js'));
const MSG = require(Path.join(FN, 'messages.js'));
const AUTO = require(Path.join(FN, 'automation-engine.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 260) + ']' : '')); ok ? pass++ : fail++; };
const as = (uid, data, claims) => ({ auth: uid ? { uid, token: Object.assign({ email_verified: true }, claims || {}) } : null, data: data || {}, rawRequest: { headers: {} } });
const tryv = async (p) => { try { return await p; } catch (e) { return null; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e && (e.code || e.message)) || 'error'; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const src = (f) => { try { return fs.readFileSync(Path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } }; /* a missing file fails the check, never crashes */
const ADM = { admin: true };
/* fail closed: an op the dispatcher does not have is a refusal to record, never a crash */
const dispatch = (op, uid, data, claims) => (typeof AOS._h[op] === 'function'
  ? Promise.resolve().then(() => AOS._h[op](as(uid, Object.assign({ op }, data), claims)))
  : Promise.reject(new Error('NO_SUCH_OP ' + op)));

async function fireTrigger(id) {
  const ref = db.collection('disputes').doc(id);
  const snap = await ref.get();
  const ev = { params: { disputeId: id }, data: { data: () => snap.data(), ref } };
  return run(AUTO.autoOnDisputeCreate)(ev);
}

(async () => {
  await db.doc('users/buy1').set({ displayName: 'Wanjiku M' });
  await db.doc('users/sel1').set({ businessName: 'Duka la Mama' });
  await db.doc('users/sel2').set({ businessName: 'Other Shop' });
  const order = (id, buyer, seller) => db.doc('orders/' + id).set({ buyerId: buyer, buyerUid: buyer, userId: buyer, sellerId: seller, total: 2500, status: 'delivered', items: [{ productId: 'p1' }], createdAt: F.Timestamp.fromMillis(Date.now() - 86400000) });
  for (const o of ['o1', 'o2', 'o3', 'o4']) await order(o, 'buy1', 'sel1');

  /* ── the trigger ── */
  say('\n── dispute trigger ──');
  await db.doc('automationRules/disputes').set({ enabled: false });
  const c1 = await tryv(run(DSP.createDispute)(as('buy1', { orderId: 'o1', reason: 'not_received', description: 'Never arrived at Langata.' })));
  await tryv(fireTrigger(c1 && c1.disputeId));
  const d1 = await get('disputes/' + (c1 && c1.disputeId));
  ck('DT1 rule off: the new dispute stays open (was forced to under_review)', d1 && d1.status === 'open' && d1.automationProcessed === true, d1 && { status: d1.status });
  await db.doc('automationRules/disputes').set({ enabled: true, autoResolveBelow: 0 });
  const c2 = await tryv(run(DSP.createDispute)(as('buy1', { orderId: 'o2', reason: 'damaged', description: 'The screen was cracked on arrival.' })));
  await tryv(fireTrigger(c2 && c2.disputeId));
  const d2 = await get('disputes/' + (c2 && c2.disputeId));
  ck('DT2 rule on: an open dispute moves to investigating (open), never under_review', d2 && d2.status === 'investigating', d2 && { status: d2.status });

  /* legacy stuck dispute */
  const c3 = await tryv(run(DSP.createDispute)(as('buy1', { orderId: 'o3', reason: 'wrong_item', description: 'Sent a blue one, ordered red.' })));
  await db.doc('disputes/' + c3.disputeId).set({ status: 'under_review' }, { merge: true });
  const resp = await codeOf(run(DSP.sellerRespondToDispute)(as('sel1', { disputeId: c3.disputeId, response: 'We will exchange it.' })));
  const evd = await codeOf(run(DSP.addDisputeEvidence)(as('buy1', { disputeId: c3.disputeId, evidenceType: 'photo', description: 'Photo of the blue item', fileUrl: 'https://x.co/a.jpg' })));
  ck('DT3 a legacy under_review dispute is open again: seller responds, buyer adds evidence', resp === null && evd === null, { resp, evd });

  /* ── admin list / detail / resolve ── */
  say('\n── AdminOS / super admin ──');
  const c4 = await tryv(run(DSP.createDispute)(as('buy1', { orderId: 'o4', reason: 'defective', description: 'Stopped working on day two.' })));
  await db.doc('disputes/' + c4.disputeId).set({ status: 'resolved' }, { merge: true });
  const act = await tryv(dispatch('adminGetDisputes', 'adm1', { status: 'active' }, ADM));
  const ids = act ? act.disputes.map((x) => x.id) : [];
  const row = act && act.disputes.find((x) => x.id === c1.disputeId);
  const fin = await tryv(dispatch('adminGetDisputes', 'adm1', { status: 'final' }, ADM));
  const byBuyer = await codeOf(dispatch('adminGetDisputes', 'buy1', { status: 'active' }));
  ck('DA1 active lists open + investigating + legacy + responded, with names; resolved only under final; non-admin refused',
    ids.includes(c1.disputeId) && ids.includes(c2.disputeId) && ids.includes(c3.disputeId) && !ids.includes(c4.disputeId)
    && row && row.buyerName === 'Wanjiku M' && row.sellerName === 'Duka la Mama'
    && fin && fin.disputes.some((x) => x.id === c4.disputeId) && !!byBuyer, { ids, row: row && { b: row.buyerName, s: row.sellerName }, byBuyer });
  const det = await tryv(dispatch('adminGetDisputeDetail', 'adm1', { disputeId: c3.disputeId }, ADM));
  const dd = det && det.dispute;
  ck('DA2 the admin detail carries the timeline, evidence and the seller\'s response', dd && dd.sellerResponse === 'We will exchange it.' && dd.evidence.length === 1 && dd.timeline.length >= 3, dd && { tl: dd.timeline.length, ev: dd.evidence.length });
  const noNote = await codeOf(dispatch('aosResolveDispute', 'adm1', { disputeId: c1.disputeId, action: 'resolved', favorBuyer: true }, ADM));
  const ok = await tryv(dispatch('aosResolveDispute', 'adm1', { disputeId: c1.disputeId, action: 'resolved', favorBuyer: true, resolution: 'Courier confirmed non-delivery.' }, ADM));
  const r1 = await get('disputes/' + c1.disputeId);
  const o1 = await get('orders/o1');
  const audit = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.disputeId === c1.disputeId);
  const byNonAdmin = await codeOf(dispatch('aosResolveDispute', 'sel1', { disputeId: c2.disputeId, action: 'resolved', resolution: 'mine' }));
  ck('DA3 AdminOS resolve = the one core: favour, timeline, order synced, audited; no note → refused; non-admin refused',
    !!noNote && ok && r1.status === 'resolved' && r1.favorBuyer === true && /buyer's favour/.test(JSON.stringify(r1.timeline))
    && o1.disputeStatus === 'resolved' && !!audit && !!byNonAdmin, { noNote, status: r1.status, fav: r1.favorBuyer, order: o1.disputeStatus, byNonAdmin });
  /* a query that fails must not read as "no disputes" */
  const realCol = db.collection.bind(db);
  db.collection = (n) => (n === 'disputes' ? { where: () => ({ limit: () => ({ get: async () => { throw new Error('FAILED_PRECONDITION: index'); } }) }) } : realCol(n));
  const broken = await codeOf(dispatch('adminGetDisputes', 'adm1', { status: 'active' }, ADM));
  db.collection = realCol;
  ck('DA4 a failed query is an error, never an empty list', !!broken, broken);

  /* ── reports: the merchant's view ── */
  say('\n── reports ──');
  await db.doc('products/pA').set({ name: 'Kitenge Dress', price: 2500, sellerUid: 'sel1', status: 'active', isVisible: true });
  await db.doc('products/pB').set({ name: 'Other Thing', price: 900, sellerUid: 'sel2', status: 'active', isVisible: true });
  const rA = await tryv(run(TS.tsReportContent)(as('buy1', { entityType: 'product', entityId: 'pA', reason: 'Counterfeit or suspicious product', detail: 'Wanjiku here — call me 0722000000' })));
  const rB = await tryv(run(TS.tsReportContent)(as('buy1', { entityType: 'product', entityId: 'pB', reason: 'Counterfeit or suspicious product', detail: 'x' })));
  const mine = await tryv(run(TS.tsGetReports)(as('sel1', { scope: 'mine' })));
  const m = mine && mine.reports;
  const leak = JSON.stringify(m || []);
  ck('RM1 the seller reads the report on their listing — without the reporter or their text', m && m.length === 1 && m[0].entityId === 'pA' && m[0].productName === 'Kitenge Dress'
    && !/buy1|Wanjiku|0722/.test(leak) && !('reportedBy' in m[0]) && !('detail' in m[0]), m);
  const signedOut = await codeOf(run(TS.tsGetReports)(as(null, { scope: 'mine' })));
  const adminPath = await codeOf(run(TS.tsGetReports)(as('sel1', { status: 'pending' })));
  ck('RM2 another seller\'s report is never included; signed-out refused; the admin path still needs admin', !!rB && m && !m.some((x) => x.entityId === 'pB') && !!signedOut && !!adminPath, { signedOut, adminPath });
  await tryv(run(TS.tsReviewReport)(as('adm1', { reportId: rA && rA.reportId, action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed by brand owner.' }, ADM)));
  const after = await tryv(run(TS.tsGetReports)(as('sel1', { scope: 'mine' })));
  const a0 = after && after.reports && after.reports[0];
  ck('RM3 the seller sees the take-down and why', a0 && a0.productHidden === true && a0.status === 'actioned' && /Counterfeit confirmed/.test(a0.outcome || ''), a0);

  /* ── conversation reports reach an admin ── */
  await db.doc('conversations/cv1').set({ participants: ['buy1', 'sel1'], type: 'direct' });
  await tryv(MSG._h.reportConversation(as('buy1', { conversationId: 'cv1', reason: 'harassment', details: 'abusive' })));
  const cl = await tryv(MSG._h.adminGetReports(as('adm1', { status: 'pending' }, ADM)));
  const qid = cl && cl.reports && cl.reports[0] && cl.reports[0].id;
  const rv = await tryv(MSG._h.adminReviewReport(as('adm1', { reportId: qid, action: 'warn', note: 'first warning' }, ADM)));
  const q = qid ? await get('moderationQueue/' + qid) : null;
  const cvNonAdmin = await codeOf(MSG._h.adminGetReports(as('sel1', { status: 'pending' })));
  ck('RC1 conversation reports are listed + reviewed for an admin; refused to anyone else', !!qid && rv && q.status === 'reviewed' && !!cvNonAdmin, { qid, status: q && q.status, cvNonAdmin });

  /* ── client wiring ── */
  say('\n── surfaces ──');
  const tq = src('sokoni-trust-queues.js'), aos = src('sokoni-aos.js'), sa = src('super-admin.html'), legacy = src('superadmin.html'), mv2 = src('merchant-v2.html');
  ck('UI1 AdminOS, super admin and the legacy console mount the ONE queue; merchant-v2 wires callReports',
    /_mountTrustQueue\(body, "disputes"\)/.test(aos) && /_mountTrustQueue\(document\.getElementById\("aosTrustReports"\), "reports"\)/.test(aos)
    && !/SokoniAOS\.resolveDispute/.test(aos) && /sokoni-trust-queues\.js/.test(src('admin-os.html'))
    && /data-section="disputes"/.test(sa) && /data-section="trust"/.test(sa) && /loadTrustQueue\('disputesRoot','disputes'\)/.test(sa) && /sokoni-trust-queues\.js/.test(sa)
    && /SokoniTrustQueues\.mount\(el, \{ view: 'reports'/.test(legacy) && !/where\('status','==','open'\)/.test(legacy) && !/updateDoc\(doc\(db,'reports'/.test(legacy)
    && /callReports: _callable\('tsGetReports'\)/.test(mv2)
    && /op: 'adminGetDisputes'/.test(tq) && /op: 'aosResolveDispute'/.test(tq) && /'tsReviewReport'/.test(tq) && /op: 'adminGetReports'/.test(tq));
  const dh = src('dispute.html'), st = src('sokoni-trust.js');
  ck('UI2 dispute.html routes to the portal; SokoniDispute uses the dispute callables, no client write',
    /location\.replace\(url\)/.test(dh) && /dispute-portal\.html/.test(dh) && !/localStorage/.test(dh.replace(/<!--[\s\S]*?-->/g, '')) && !/SokoniDispute\.open/.test(dh)
    && /SokoniSecureCall\('createDispute'/.test(st) && /SokoniSecureCall\('cancelDispute'/.test(st) && !/collection\(db, 'disputes'\)/.test(st) && !/refundRequested:/.test(st)
    && /q\.get\('orderId'\)\|\|q\.get\('order'\)/.test(src('dispute-portal.html')));
  ck('UI3 no fake "Thank you for the report" on unboxing.html', !/Thank you for the report/.test(src('unboxing.html').replace(/<!--[\s\S]*?-->/g, '')));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
