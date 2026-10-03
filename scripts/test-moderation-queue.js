#!/usr/bin/env node
/* test-moderation-queue.js — community C3 (2026-10-01): THE MODERATION QUEUE on the ONE report authority.
 *
 *   node scripts/test-moderation-queue.js                     # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-moderation-queue.js     # one fault injected into a TEMP COPY (never the tree)
 *   node scripts/test-moderation-queue.js --failure-injection # every fault, one at a time: each must fail its NAMED
 *                                                             # test; the tree's files are hashed before and after
 *   SERVING_ALGOLIA_SYNC=<path> SERVING_TYPESENSE_SYNC=<path>  # run the E-rows against the SERVING copies with the
 *                                                             # C3 hunk applied (lineage gate — see CHANGELOG C3)
 *
 * REAL functions/trust-safety.js, algolia-sync.js and typesense-sync.js on the transactional fake Firestore
 * (scripts/lib/fake-firestore-txn.js, strict read order). No emulator, no network, no project. TRIPWIRE: requiring the
 * real `firebase-admin` (which notify.js initialises) throws — a harness must never reach a live project (2026-10-01:
 * the C2 suite did, through notify.js and application-default credentials, before trust-safety.js was made to fail
 * closed outside a Functions runtime). Notifications go to a recording notifier via exports._setNotifier.
 *
 * NAMED TESTS (spec §26–§30):
 *   Q1–Q6   queue: appears, status vocabulary, pagination, server filters, 1 listing + N reports, priority facts
 *   R1–R3   review: claim/unclaim/takeover, the case view (report/product/history/siblings), actions valid per state
 *   D1–D9   decision: uphold+take-down, dismiss, invalid, replay/duplicate, concurrent, listing group, escalate,
 *           reopen, stale revision
 *   E1–E3   enforcement: hidden listing leaves search (Algolia + Typesense), re-shown listing returns, dismiss hides nothing
 *   P1–P5   privacy: seller status vocabulary, reporter-blind seller payload, unrelated seller, unauthorised user,
 *           notifications (no reporter identity to the seller, no admin detail to the reporter, failure never "sent")
 *   A1–A2   audit: every field on every transition, deterministic ids, no reporter PII
 *   SB1–SB10 the ten sabotage scenarios of §27
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');

/* ── failure injection: each fault, the exact text it replaces, and the NAMED test that must catch it ── */
const SABOTAGES = {
  'remove-adminos-auth':        { file: 'trust-safety.js', catch: 'SB1',
    from: /function _requireAdmin\(req\) \{\n  if \(!req\.auth\?\.token\?\.admin && !req\.auth\?\.token\?\.superAdmin\) throw new HttpsError\('permission-denied', 'admin required'\);\n\}/,
    to: 'function _requireAdmin(req) {}' },
  'trust-client-status':        { file: 'trust-safety.js', catch: 'SB6',
    from: /const newStatus = \(isAssign \|\| isRestore\) \? null : REPORT_ACTIONS\[action\];/,
    to: "const newStatus = (isAssign || isRestore) ? null : ({ upheld: 'actioned' }[data.status] || data.status || REPORT_ACTIONS[action]);" },
  'remove-reporter-privacy':    { file: 'trust-safety.js', catch: 'SB3',
    from: /      ref: r\.publicRef \|\| null,\n      entityType: r\.entityType \|\| null, entityId: r\.entityId \|\| null,\n      productName: c\.productName/,
    to: '      ref: r.publicRef || null, reportedBy: r.reportedBy, detail: r.detail,\n      entityType: r.entityType || null, entityId: r.entityId || null,\n      productName: c.productName' },
  'bypass-product-ownership':   { file: 'trust-safety.js', catch: 'SB9',
    from: /sellerUid: p\.sellerUid \|\| p\.sellerId \|\| null,\n      shopId: p\.shopId \|\| null,\n      price:/,
    to: 'sellerUid: d.sellerUid || p.sellerUid || p.sellerId || null,\n      shopId: p.shopId || null,\n      price:' },
  'bypass-duplicate-protection': { file: 'trust-safety.js', catch: 'SB7',
    from: /      if \(!\(REPORT_TRANSITIONS\[newStatus\] \|\| \[\]\)\.includes\(from\)\) \{\n        throw new HttpsError\('failed-precondition', `This report is already \$\{REPORT_STATE\[from\] \|\| from\}; it cannot be moved to \$\{REPORT_STATE\[newStatus\]\}\.`\);\n      \}\n      if \(lockedOut/,
    to: '      if (lockedOut' },
  'bypass-canonical-hide':      { file: 'trust-safety.js', catch: 'D1',
    from: /          tx\.set\(pref, \{ isVisible: false, moderationHold:/,
    to: "          tx.set(db.collection('hiddenProducts').doc(String(report.entityId)), { moderated: true, moderationHold:" },
  'remove-audit-write':         { file: 'trust-safety.js', catch: 'A1',
    from: /      tx\.create\(db\.collection\('trustSafetyAudit'\)\.doc\(_auditId\(id, rv\)\), \{/,
    to: "      (() => {})(db.collection('trustSafetyAudit').doc(_auditId(id, rv)), {" },
  'allow-seller-self-moderation': { file: 'trust-safety.js', catch: 'SB4',
    from: /exports\.tsReviewReport = onCall\(OPT, async \(req\) => \{\n  _requireAdmin\(req\);/,
    to: "exports.tsReviewReport = onCall(OPT, async (req) => {\n  if (!req.auth) throw new HttpsError('unauthenticated', 'sign in');" },
};

if (process.argv.includes('--failure-injection')) {
  const files = ['trust-safety.js', 'algolia-sync.js', 'typesense-sync.js', 'index.js'];
  const hash = () => files.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, f))).digest('hex')).join(',');
  const before = hash(); let ok = true;
  const say0 = console.log;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8', maxBuffer: 64e6 });
    const out = (r.stdout || '') + (r.stderr || '');
    const applied = !/SABOTAGE NOT APPLIED/.test(out);
    const caught = new RegExp('^  FAIL  ' + s.catch + ' ', 'm').test(out);
    const pass = applied && caught && r.status === 1;
    if (!pass) ok = false;
    say0(`  ${pass ? 'CAUGHT ' : 'MISSED '} ${name.padEnd(30)} → ${s.catch}${applied ? '' : '  (sabotage did not apply — harness fails closed)'}${caught ? '' : '  (named test did not fail)'}  exit=${r.status}`);
  }
  const after = hash();
  say0(`  tree unchanged after injection: ${before === after ? 'YES' : 'NO'}`);
  say0(ok && before === after ? '\nFAILURE INJECTION: all caught, all restored' : '\nFAILURE INJECTION: FAILED');
  process.exit(ok && before === after ? 0 : 1);
}

const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 400) : '')); } };

const SAB = process.env.SABOTAGE || null;
let tmp = null;
function loadFrom(file, srcPath) {
  let text = fs.readFileSync(srcPath, 'utf8');
  if (SAB) {
    const s = SABOTAGES[SAB];
    if (!s) { say('UNKNOWN SABOTAGE ' + SAB); process.exit(2); }
    if (s.file === file) {
      const t2 = text.replace(/\r\n/g, '\n');
      if (!s.from.test(t2)) { say('SABOTAGE NOT APPLIED: ' + SAB); process.exit(3); }
      text = t2.replace(s.from, s.to);
      say(`\nSABOTAGE ${SAB} applied to a temp copy of ${file}`);
    }
  }
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'modq-'));
  const out = path.join(tmp, file);
  fs.writeFileSync(out, text);
  return require(out);
}

const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const enq = { algolia: [], typesense: [] };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin' || id === 'firebase-admin/app' || id === 'firebase-admin/auth') throw new Error('TRIPWIRE: real firebase-admin required — a test must never reach a live project');
  if (id === './notify') throw new Error('TRIPWIRE: real notify.js required from a test');
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') {
    const t = (_o, h) => h; return { onDocumentCreated: t, onDocumentUpdated: t, onDocumentDeleted: t, onDocumentWritten: t };
  }
  if (id === './algolia-queue') return { enqueue: async (j) => { enq.algolia.push(j); } };
  if (id === './typesense-queue') return { enqueue: async (j) => { enq.typesense.push(j); }, PRIORITY: {} };
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });
const ADMIN = { admin: true }, SUPER = { superAdmin: true };
const audits = async (pred) => (await db.collection('trustSafetyAudit').get()).docs.map((d) => Object.assign({ _id: d.id }, d.data())).filter(pred || (() => true));

(async () => {
  say('\nSOURCE: working tree' + (SAB ? ' + SABOTAGE ' + SAB : '') + ' — ' + FN);
  const TS = loadFrom('trust-safety.js', path.join(FN, 'trust-safety.js'));
  const sent = []; let notifyMode = 'ok';
  if (typeof TS._setNotifier !== 'function') { say('BLOCKED — no moderation queue in this trust-safety.js'); process.exit(2); }
  TS._setNotifier(async (o) => {
    sent.push(o);
    if (notifyMode === 'throw') throw Object.assign(new Error('provider down'), { code: 'unavailable' });
    return { ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } };
  });

  /* ── fixtures ── */
  const SA = 'sellerA', SB = 'sellerB';
  const T0 = Date.parse('2026-09-01T00:00:00Z');
  await db.doc('products/pA').set({ name: 'Kitenge <b>Dress</b>', sellerUid: SA, shopId: 'shopA', price: 2500, status: 'active', isVisible: true, category: 'fashion', images: ['https://img.example/a.jpg', 'http://insecure/x.jpg'] });
  await db.doc('products/pA2').set({ name: 'Leso', sellerUid: SA, shopId: 'shopA', price: 400, status: 'active', isVisible: true });
  await db.doc('products/pB').set({ name: 'Sufuria', sellerUid: SB, shopId: 'shopB', price: 900, status: 'active', isVisible: true });
  await db.doc('shops/shopA').set({ name: 'Mama Kitenge', ownerPhone: '+254700000000', ownerEmail: 'a@x.ke' });
  const file = async (uid, entityId, reasonCode, detail, atMs) => {
    db._setClock(() => atMs);
    const r = await tryv(TS.tsReportContent(as(uid, { entityType: 'product', entityId, reasonCode, detail: detail || '' })));
    db._setClock(() => Date.now());
    return r;
  };
  const rA1 = await file('rep1', 'pA', 'counterfeit', 'Logo is wrong — secret reporter words', T0 + 1 * 864e5);
  const rA2 = await file('rep2', 'pA', 'scam', 'asked for M-Pesa outside', T0 + 2 * 864e5);
  const rA3 = await file('rep3', 'pA', 'misleading', '', T0 + 3 * 864e5);
  const rA4 = await file('rep4', 'pA2', 'wrong_category', '', T0 + 4 * 864e5);
  const rB1 = await file('rep1', 'pB', 'prohibited', 'weapon', T0 + 5 * 864e5);
  const ids = [rA1, rA2, rA3, rA4, rB1].map((r) => r && r.reportId);
  ck('Q0 control — five reports filed on the authority (deterministic ids)', ids.every(Boolean) && ids[0] === 'rep1_product_pA', ids);

  say('\n── Q: the queue ──');
  const q0 = await tryv(TS.tsGetReports(as('adm1', { state: 'pending', facts: true }, ADMIN)));
  const row = (q0.reports || []).find((r) => r.id === ids[0]) || {};
  ck('Q1 a filed report appears in the queue: ref, listing id, title, seller/shop, reason, status, created, queueStatus "open"',
    Array.isArray(q0.reports) && q0.reports.length === 5 && row.ref && row.ref.length === 16 && row.entityId === 'pA' && row.context && row.context.productName === 'Kitenge <b>Dress</b>'
      && row.context.sellerUid === SA && row.context.shopId === 'shopA' && row.reasonCode === 'counterfeit' && row.queueStatus === 'open' && row.moderationState === 'pending'
      && /^2026-09-02T/.test(row.createdAtIso) && row.revision === 0 && row.target && row.target.supported === true, row);

  /* move reports into distinct states for the vocabulary check */
  await TS.tsReviewReport(as('adm1', { reportId: ids[1], action: 'claim' }, ADMIN));
  await TS.tsReviewReport(as('adm1', { reportId: ids[3], action: 'request_changes', resolution: 'Move it to Home & Living' }, ADMIN));
  await TS.tsReviewReport(as('adm2', { reportId: ids[4], action: 'escalate', internalNote: 'weapon — senior review' }, ADMIN));
  const byQ = async (queueStatus) => ((await tryv(TS.tsGetReports(as('adm1', { queueStatus }, ADMIN)))).reports || []).map((r) => r.id).sort();
  const vocab = { open: await byQ('open'), under_review: await byQ('under_review'), needs_information: await byQ('needs_information'), escalated: await byQ('escalated'), active: await byQ('active') };
  const badQ = await codeOf(TS.tsGetReports(as('adm1', { queueStatus: 'danger' }, ADMIN)));
  ck('Q2 status vocabulary is server-derived: open / under_review (claimed) / needs_information / escalated / active; unknown refused',
    JSON.stringify(vocab.open) === JSON.stringify([ids[0], ids[2]].sort()) && JSON.stringify(vocab.under_review) === JSON.stringify([ids[1]])
      && JSON.stringify(vocab.needs_information) === JSON.stringify([ids[3]]) && JSON.stringify(vocab.escalated) === JSON.stringify([ids[4]])
      && vocab.active.length === 5 && badQ === 'invalid-argument', { vocab, badQ });

  const p1 = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'active', limit: 2 }, ADMIN)));
  const p2 = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'active', limit: 2, after: p1.page && p1.page.nextCursor }, ADMIN)));
  const p3 = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'active', limit: 2, after: p2.page && p2.page.nextCursor }, ADMIN)));
  const seen = [].concat(p1.reports || [], p2.reports || [], p3.reports || []).map((r) => r.id);
  const badCur = [await codeOf(TS.tsGetReports(as('adm1', { limit: 2, after: 'no/such' }, ADMIN))), await codeOf(TS.tsGetReports(as('adm1', { limit: 2, after: 'nosuch' }, ADMIN)))];
  ck('Q3 pagination: bounded pages with a server cursor, no duplicates, nothing lost, last page says no more; bad cursors refused',
    p1.page && p1.page.hasMore === true && p1.reports.length === 2 && p2.page.hasMore === true && p3.page.hasMore === false && p3.page.nextCursor === null
      && new Set(seen).size === 5 && seen.length === 5 && badCur.every((c) => c === 'invalid-argument'), { seen, p1: p1.page, p3: p3.page, badCur });

  const f = async (o) => ((await tryv(TS.tsGetReports(as('adm1', o, ADMIN)))).reports || []).map((r) => r.id).sort();
  const fr = {
    reason: await f({ reason: 'scam' }), seller: await f({ seller: SB }), shop: await f({ shop: 'shopA' }), product: await f({ product: 'pA' }),
    mine: await f({ assignee: 'me' }), dateOnly: await f({ from: '2026-09-02T12:00:00Z', to: '2026-09-04T12:00:00Z' }),
    dateAndProduct: await f({ product: 'pA', from: '2026-09-02T12:00:00Z' }), upheld: await f({ queueStatus: 'upheld' }), escalatedFlag: await f({ escalated: true }),
  };
  const badF = [await codeOf(TS.tsGetReports(as('adm1', { seller: 'a/b' }, ADMIN))), await codeOf(TS.tsGetReports(as('adm1', { from: 'yesterday-ish' }, ADMIN)))];
  ck('Q4 server filters: reason, seller, shop, product, assigned reviewer, date alone, date + product, upheld, escalated; bad values refused',
    JSON.stringify(fr.reason) === JSON.stringify([ids[1]]) && JSON.stringify(fr.seller) === JSON.stringify([ids[4]]) && fr.shop.length === 4 && fr.product.length === 3
      && JSON.stringify(fr.mine) === JSON.stringify([ids[1]]) && JSON.stringify(fr.dateOnly) === JSON.stringify([ids[1], ids[2]].sort())
      && JSON.stringify(fr.dateAndProduct) === JSON.stringify([ids[1], ids[2]].sort()) && fr.upheld.length === 0 && JSON.stringify(fr.escalatedFlag) === JSON.stringify([ids[4]])
      && badF.every((c) => c === 'invalid-argument'), { fr, badF });

  const grp = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'active', facts: true, groupBy: 'listing' }, ADMIN)));
  const gA = (grp.groups || []).find((g) => g.entityId === 'pA') || {};
  const rowA = (grp.reports || []).find((r) => r.entityId === 'pA') || {};
  ck('Q5 1 listing + N reports: one group for pA with 3 reports (each its own record), facts: 3 on listing, 3 open, listing visible',
    gA.reportIds && gA.reportIds.length === 3 && gA.openInPage === 3 && gA.title === 'Kitenge <b>Dress</b>' && rowA.facts && rowA.facts.reportsOnListing === 3
      && rowA.facts.openOnListing === 3 && rowA.facts.upheldOnListing === 0 && rowA.facts.listingVisible === true && (grp.reports || []).length === 5, { gA, facts: rowA.facts });

  const bySev = await tryv(TS.tsGetReports(as('adm1', { queueStatus: 'active', facts: true, sort: 'severity' }, ADMIN)));
  const sev = (bySev.reports || []).map((r) => r.severity);
  const keys = new Set([].concat(...(bySev.reports || []).map((r) => Object.keys(r).concat(Object.keys(r.facts || {})))));
  ck('Q6 priority = raw facts + deterministic sort (critical first, then most-reported listing, then oldest); no invented score field',
    sev[0] === 'critical' && sev[1] === 'critical' && sev[sev.length - 1] === 'low' && ![...keys].some((k) => /score|danger|risk|priority/i.test(k)), { sev, keys: [...keys] });

  say('\n── R: review ──');
  const c1 = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'claim' }, ADMIN)));
  const nAud1 = (await audits((a) => a.reportId === ids[0])).length;
  const c1again = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'claim' }, ADMIN)));
  const nAud2 = (await audits((a) => a.reportId === ids[0])).length;
  const c2 = await codeOf(TS.tsReviewReport(as('adm2', { reportId: ids[0], action: 'claim' }, ADMIN)));
  const u2 = await codeOf(TS.tsReviewReport(as('adm2', { reportId: ids[0], action: 'unclaim' }, ADMIN)));
  const decideOther = await codeOf(TS.tsReviewReport(as('adm2', { reportId: ids[0], action: 'dismiss' }, ADMIN)));
  const take = await tryv(TS.tsReviewReport(as('sup1', { reportId: ids[0], action: 'claim', takeover: true }, SUPER)));
  const afterTake = await get('reports/' + ids[0]);
  const rel = await tryv(TS.tsReviewReport(as('sup1', { reportId: ids[0], action: 'unclaim' }, SUPER)));
  const reclaim = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'claim' }, ADMIN)));
  ck('R1 claim: server lock — under_review; re-claim is a no-op (no 2nd audit); a 2nd moderator cannot claim, release or decide; super admin takeover/unclaim audited',
    c1.queueStatus === 'under_review' && nAud1 === 1 && c1again.noop === true && nAud2 === 1 && c2 === 'failed-precondition' && u2 === 'permission-denied'
      && decideOther === 'failed-precondition' && take.queueStatus === 'under_review' && afterTake.assignedTo === 'sup1' && afterTake.assignedRole === 'superAdmin'
      && rel.queueStatus === 'open' && reclaim.queueStatus === 'under_review' && (await audits((a) => a.reportId === ids[0])).length === 4,
    { c1, nAud1, c1again, nAud2, c2, u2, decideOther, take, rel });

  const cs = await tryv(TS.tsGetReportCase(as('adm1', { reportId: ids[0] }, ADMIN)));
  ck('R2 case view: report (reporter shown to the admin), product (title, https images, category, visibility, seller, shop NAME only), the 3 reports on the listing, history',
    cs.report && cs.report.reportedBy === 'rep1' && cs.report.detail === 'Logo is wrong — secret reporter words' && cs.product && cs.product.name === 'Kitenge <b>Dress</b>'
      && JSON.stringify(cs.product.images) === JSON.stringify(['https://img.example/a.jpg']) && cs.product.category === 'fashion' && cs.product.isVisible === true
      && cs.product.sellerUid === SA && cs.shop && cs.shop.name === 'Mama Kitenge' && !JSON.stringify(cs.shop).includes('254700') && !JSON.stringify(cs).includes('a@x.ke')
      && cs.reports.length === 3 && cs.reports.every((r) => r.reportedBy && r.reasonCode) && cs.openOnListing === 3
      && cs.history[0].action === 'report_filed' && cs.history.filter((h) => h.action === 'report_claimed').length === 3 && cs.history.some((h) => h.action === 'report_unclaimed'),
    { rep: cs.report && cs.report.reportedBy, prod: cs.product, shop: cs.shop, n: cs.reports && cs.reports.length, hist: cs.history && cs.history.map((h) => h.action) });
  const actsHolder = cs.actions || [];
  const cs2 = await tryv(TS.tsGetReportCase(as('adm2', { reportId: ids[0] }, ADMIN)));
  ck('R3 actions are the server\'s, for THIS state and THIS moderator: holder may decide + take down; another admin may only look; unauthorised → refused',
    ['unclaim', 'approve', 'takedown', 'dismiss', 'request_changes', 'escalate', 'archive', 'remove'].every((a) => actsHolder.includes(a)) && !actsHolder.includes('reopen') && !actsHolder.includes('claim')
      && Array.isArray(cs2.actions) && cs2.actions.length === 0 && (await codeOf(TS.tsGetReportCase(as('rep1', { reportId: ids[0] })))) === 'permission-denied',
    { actsHolder, other: cs2.actions });

  say('\n── D: decisions ──');
  sent.length = 0;
  const up = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed', internalNote: 'compared with brand photos', requestId: 'req-uphold-0001' }, ADMIN)));
  const pA = await get('products/pA');
  const r0 = await get('reports/' + ids[0]);
  ck('D1 UPHOLD + take-down goes through the canonical listing authority: products/pA isVisible:false + moderationHold, report upheld, enforcement listing_hidden',
    up.moderationState === 'approved' && up.queueStatus === 'upheld' && up.enforcement === 'listing_hidden' && pA.isVisible === false && pA.moderationHold
      && pA.moderationHold.ref === r0.holdRef && /^[A-Za-z0-9_-]{16}$/.test(String(pA.moderationHold.ref))
      && pA.moderationHold.ref !== crypto.createHash('sha256').update(String(ids[0])).digest('hex').slice(0, 16)
      && pA.moderationHold.reportId === undefined && pA.moderationHold.by === undefined && pA.moderationHold.reason === undefined && r0.status === 'actioned' && r0.productHidden === true
      && !(await get('hiddenProducts/pA')) && pA.moderated === undefined, { up, hold: pA.moderationHold, vis: pA.isVisible });

  const dis = await tryv(TS.tsReviewReport(as('adm2', { reportId: ids[2], action: 'dismiss', resolution: 'Photos match the item' }, ADMIN)));
  const r2 = await get('reports/' + ids[2]);
  const pA2 = await get('products/pA');
  ck('D2 DISMISS keeps the record (actor, time, note), never deletes, never alters the reporter\'s submission, never touches the listing',
    dis.moderationState === 'rejected' && r2 && r2.status === 'dismissed' && r2.reviewedBy === 'adm2' && r2.reviewedAt && r2.resolution === 'Photos match the item'
      && r2.reportedBy === 'rep3' && r2.reasonCode === 'misleading' && r2.detail === '' && JSON.stringify(pA2.moderationHold) === JSON.stringify(pA.moderationHold), { dis, r2 });

  const d3 = [await codeOf(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'dismiss' }, ADMIN))),
    await codeOf(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'action' }, ADMIN))),
    await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'reopen', internalNote: 'oops' }, ADMIN))).then((r) => r.error === 'invalid-argument' && TS._reportModel.REPORT_ACTIONS.reopen === 'pending' ? 'invalid-argument' : r),
    await codeOf(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'claim' }, ADMIN))),
    await codeOf(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'approve', requestId: 'x' }, ADMIN)))];
  ck('D3 invalid: a decided report cannot be re-decided or claimed; unknown action; reopen without a real note; malformed requestId — all refused',
    d3[0] === 'failed-precondition' && d3[1] === 'invalid-argument' && d3[2] === 'invalid-argument' && d3[3] === 'failed-precondition' && d3[4] === 'invalid-argument', d3);

  const audBefore = (await audits()).length;
  const replay = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'approve', hideProduct: true, resolution: 'Counterfeit confirmed', requestId: 'req-uphold-0001' }, ADMIN)));
  const audAfter = (await audits()).length;
  const pA3 = await get('products/pA');
  ck('D4 retry/replay: the same requestId returns the recorded outcome (replayed), writes nothing — no 2nd audit, no 2nd hide',
    replay.replayed === true && replay.moderationState === 'approved' && replay.productHidden === true && audAfter === audBefore
      && JSON.stringify(pA3) === JSON.stringify(pA), { replay, audBefore, audAfter });

  /* concurrent: two moderators decide the same report at the same moment */
  const rC = await file('rep5', 'pA2', 'counterfeit', 'concurrent', T0 + 6 * 864e5);
  const [ca, cb] = await Promise.all([
    tryv(TS.tsReviewReport(as('adm1', { reportId: rC.reportId, action: 'approve', hideProduct: true, resolution: 'fake' }, ADMIN))),
    tryv(TS.tsReviewReport(as('adm2', { reportId: rC.reportId, action: 'dismiss', resolution: 'fine' }, ADMIN))),
  ]);
  const rCdoc = await get('reports/' + rC.reportId);
  const rCaud = await audits((a) => a.reportId === rC.reportId);
  const winners = [ca, cb].filter((x) => x && x.success);
  const losers = [ca, cb].filter((x) => x && x.error === 'failed-precondition');
  ck('D5 concurrent decisions: exactly one wins, the other is refused (failed-precondition); one audit row; stored state = the winner\'s',
    winners.length === 1 && losers.length === 1 && rCaud.length === 1 && rCdoc.status === winners[0].status && rCaud[0].result === winners[0].status, { ca, cb, st: rCdoc.status });

  /* group: 3 more reports on pB, decide the LISTING once */
  const g1 = await file('rep6', 'pB', 'scam', 'g1', T0 + 7 * 864e5);
  const g2 = await file('rep7', 'pB', 'counterfeit', 'g2', T0 + 8 * 864e5);
  await TS.tsReviewReport(as('adm2', { reportId: ids[4], action: 'claim' }, ADMIN));
  const grpLocked = await codeOf(TS.tsReviewReport(as('adm1', { reportId: g1.reportId, action: 'approve', applyToListing: true }, ADMIN)));
  await TS.tsReviewReport(as('adm2', { reportId: ids[4], action: 'unclaim' }, ADMIN));
  const gd = await tryv(TS.tsReviewReport(as('adm1', { reportId: g1.reportId, action: 'approve', hideProduct: true, applyToListing: true, resolution: 'Prohibited item', requestId: 'req-group-0001' }, ADMIN)));
  const gDocs = await Promise.all([g1.reportId, g2.reportId, ids[4]].map((id) => get('reports/' + id)));
  const gAud = await audits((a) => a.correlationId === 'req-group-0001');
  ck('D6 a decision on the LISTING resolves its open reports in ONE transaction: 3 reports upheld, each its own audit row (own reportId, same correlationId), records kept; refused while one is held by another moderator',
    grpLocked === 'failed-precondition' && gd.resolvedReports === 3 && gDocs.every((d) => d.status === 'actioned' && d.productHidden === true) && gDocs[1].decidedWith === g1.reportId
      && gDocs[2].reportedBy === 'rep1' && gDocs[2].detail === 'weapon' && gAud.length === 3 && new Set(gAud.map((a) => a.reportId)).size === 3
      && gAud.every((a) => a.groupSize === 3) && gAud.filter((a) => a.primary).length === 1 && (await get('products/pB')).isVisible === false, { grpLocked, gd, n: gAud.length });

  const esc = await get('reports/' + ids[4]);
  const escAud = await audits((a) => a.reportId === ids[4] && a.decision === 'escalate');
  ck('D7 ESCALATE keeps the report, reason and reviewer; records who escalated, when, the note and the next action; frees the lock',
    esc.escalation && esc.escalation.by === 'adm2' && esc.escalation.note === 'weapon — senior review' && esc.escalation.nextAction === 'senior_review' && esc.escalation.at
      && esc.reasonCode === 'prohibited' && escAud.length === 1 && escAud[0].fromQueue === 'open' && escAud[0].result === 'escalated', { escalation: esc.escalation });

  const reo = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'reopen', internalNote: 'brand owner says the item is genuine' }, ADMIN)));
  const r0b = await get('reports/' + ids[0]);
  const pA4 = await get('products/pA');
  const fresh = await file('rep8', 'pA', 'offensive', 'new', T0 + 9 * 864e5);
  const freshDoc = await get('reports/' + (fresh && fresh.reportId));
  ck('D8 REOPEN is explicit and audited (note required), never automatic: report back to open, reopenCount 1, listing NOT silently un-hidden; a NEW report stays new and separate',
    reo.queueStatus === 'open' && r0b.status === 'pending' && r0b.reopenCount === 1 && r0b.reopenedBy === 'adm1' && pA4.isVisible === false
      && (await audits((a) => a.reportId === ids[0] && a.action === 'report_reopened')).length === 1
      && freshDoc && freshDoc.status === 'pending' && !freshDoc.assignedTo && fresh.reportId !== ids[0], { reo, freshDoc: freshDoc && freshDoc.status });

  const stale = await codeOf(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'dismiss', expectedRevision: 1 }, ADMIN)));
  const caseHeld = await tryv(TS.tsGetReportCase(as('adm1', { reportId: ids[0] }, ADMIN)));
  const notOwner = await codeOf(TS.tsReviewReport(as('adm1', { reportId: fresh.reportId, action: 'dismiss', restoreListing: true }, ADMIN)));
  const okRev = await tryv(TS.tsReviewReport(as('adm1', { reportId: ids[0], action: 'dismiss', expectedRevision: r0b.revision, resolution: 'Genuine after all', restoreListing: true }, ADMIN)));
  ck('D9 a moderator acting on a stale view (expectedRevision) is refused; the current revision is accepted',
    stale === 'failed-precondition' && okRev.moderationState === 'rejected', { stale, okRev });
  const pA5 = await get('products/pA');
  const relAud = await audits((a) => a.reportId === ids[0] && a.enforcement === 'listing_restored');
  ck('D10 RESTORE is explicit and canonical: only the report that owns the hold may release it (another report refused); dismissing it with restoreListing puts back the recorded visibility, removes the hold, audits it',
    caseHeld.listingHeldByThisReport === true && notOwner === 'failed-precondition' && (await get('reports/' + fresh.reportId)).status === 'pending'
      && okRev.enforcement === 'listing_restored' && pA5.isVisible === true && pA5.moderationHold === undefined && pA5.moderationReleased && pA5.moderationReleased.ref === pA.moderationHold.ref && pA5.moderationReleased.ref !== crypto.createHash('sha256').update(String(ids[0])).digest('hex').slice(0, 16) && pA5.moderationReleased.by === undefined
      && (await get('reports/' + ids[0])).productHidden === false && relAud.length === 1, { notOwner, okRev, pA5 });

  say('\n── E: enforcement on discovery ──');
  const AS = loadFrom('algolia-sync.js', process.env.SERVING_ALGOLIA_SYNC || path.join(FN, 'algolia-sync.js'));
  const TSY = loadFrom('typesense-sync.js', process.env.SERVING_TYPESENSE_SYNC || path.join(FN, 'typesense-sync.js'));
  const ev = (before, after) => ({ params: { docId: 'pX' }, data: { before: { data: () => before }, after: { data: () => after }, data: () => after } });
  const live = { name: 'X', status: 'active', isVisible: true, price: 1 };
  const held = Object.assign({}, live, { isVisible: false, moderationHold: { reportId: 'r' } });
  const runPair = async (b, a) => { enq.algolia.length = 0; enq.typesense.length = 0;
    await AS.algoliaSync_products_update(ev(b, a)); await TSY.ts_products_onUpdate(ev(b, a));
    return [enq.algolia.map((j) => j.operation).join(','), enq.typesense.map((j) => j.operation).join(',')]; };
  const hideOps = await runPair(live, held);
  const showOps = await runPair(held, live);
  const editOps = await runPair(live, Object.assign({}, live, { price: 2 }));
  const heldEdit = await runPair(held, Object.assign({}, held, { price: 3 }));
  enq.algolia.length = 0; enq.typesense.length = 0;
  await AS.algoliaSync_products_create({ params: { docId: 'pY' }, data: { data: () => held } });
  await TSY.ts_products_onCreate({ params: { docId: 'pY' }, data: { data: () => held } });
  const createHeld = enq.algolia.length + enq.typesense.length;
  const draftOps = await runPair({ name: 'd', status: 'draft' }, { name: 'd', status: 'active' });
  ck('E1 a taken-down listing LEAVES search (Algolia + Typesense delete); shown again it RETURNS as a whole record (upsert); hidden edits stay out; a hidden new listing is never indexed',
    hideOps.join('|') === 'delete|delete' && showOps.join('|') === 'upsert|upsert' && editOps[0] === 'partial' && editOps[1] === 'upsert'
      && heldEdit.join('|') === '|' && createHeld === 0, { hideOps, showOps, editOps, heldEdit, createHeld });
  enq.algolia.length = 0;
  await AS.algoliaSync_services_update(ev({ name: 's', isVisible: false }, { name: 's', isVisible: false, x: 1 }));
  ck('E2 the visibility rule is scoped to products: another collection with isVisible:false is indexed exactly as before; a draft published is a full upsert',
    enq.algolia.length === 1 && enq.algolia[0].operation === 'partial' && draftOps[0] === 'upsert' && draftOps[1] === 'upsert', { other: enq.algolia.map((j) => j.operation), draftOps });
  const pBefore = await get('products/pA2');
  ck('E3 a DISMISSED report hides nothing (products/pA2 never received a moderationHold)', pBefore.isVisible === true && !pBefore.moderationHold && (rCdoc.status === 'dismissed' || rCdoc.status === 'actioned'), pBefore);

  say('\n── P: privacy and the seller\'s status ──');
  await db.doc('products/pA3').set({ name: 'Shuka', sellerUid: SA, shopId: 'shopA', price: 700, status: 'active', isVisible: true });
  const rT = await file('rep13', 'pA3', 'prohibited', 'p1', T0 + 9.5 * 864e5);
  await TS.tsReviewReport(as('adm1', { reportId: rT.reportId, action: 'approve', hideProduct: true, resolution: 'Not allowed on SOKONI' }, ADMIN));
  const mineA = await tryv(TS.tsGetReports(as(SA, { scope: 'mine' })));
  const st =(mineA.reports || []).map((r) => r.sellerStatus).sort();
  ck('P1 the seller sees each report on their listings in the SELLER vocabulary (received / under review / changes requested / action taken / dismissed), plus the appeal route',
    Array.isArray(mineA.reports) && ['report_received', 'under_review', 'listing_action_taken', 'changes_requested', 'report_dismissed'].every((s) => st.includes(s))
      && mineA.sellerResponse && mineA.sellerResponse.supported === false && mineA.sellerResponse.route === 'support', st);
  const blobA = JSON.stringify(mineA);
  ck('P2 the seller payload is reporter-blind and internal-blind: no reporter uid, doc id, reporter text, internal note, reviewer, escalation, severity or raw status',
    !/rep[1-8]\b/.test(blobA) && !ids.some((i) => blobA.includes(i)) && !blobA.includes('secret reporter words') && !blobA.includes('brand photos')
      && !/reportedBy|"detail"|internalNote|assignedTo|reviewedBy|escalation|"severity"|"status"|adm1|adm2|sup1/.test(blobA), blobA.slice(0, 300));
  const mineB = await tryv(TS.tsGetReports(as(SB, { scope: 'mine' })));
  const mineX = await tryv(TS.tsGetReports(as('stranger', { scope: 'mine' })));
  ck('P3 an unrelated seller sees none of seller A\'s reports (and A none of B\'s)',
    (mineB.reports || []).every((r) => r.entityId === 'pB') && (mineB.reports || []).length === 3 && (mineX.reports || []).length === 0
      && (mineA.reports || []).every((r) => r.entityId !== 'pB'), { b: (mineB.reports || []).length, x: (mineX.reports || []).length });
  const p4 = [await codeOf(TS.tsGetReports(as('rep1', {}))), await codeOf(TS.tsGetReports(as(null, {}))), await codeOf(TS.tsGetReportCase(as(SA, { reportId: ids[1] }))),
    await codeOf(TS.tsReviewReport(as('rep1', { reportId: ids[1], action: 'claim' }))), await codeOf(TS.tsGetReports(as(null, { scope: 'mine' })))];
  ck('P4 an unauthorised user cannot list the queue, open a case or claim; signed-out refused', p4.slice(0, 4).every((c) => c === 'permission-denied') && p4[4] === 'unauthenticated', p4);

  const sellerMsgs = sent.filter((m) => m.uid === SA || m.uid === SB);
  const repMsgs = sent.filter((m) => /^rep/.test(m.uid));
  const allText = JSON.stringify(sent);
  sent.length = 0; notifyMode = 'throw';
  const rF = await file('rep9', 'pA2', 'scam', 'notify failure', T0 + 10 * 864e5);
  const nf = await tryv(TS.tsReviewReport(as('adm1', { reportId: rF.reportId, action: 'dismiss', resolution: 'ok' }, ADMIN)));
  notifyMode = 'ok';
  const rFdoc = await get('reports/' + rF.reportId);
  ck('P5 notifications go through the notify authority: seller told the outcome without any reporter identity, reporter told "resolved" without admin detail; a failed send is recorded as FAILED, never sent',
    sellerMsgs.length >= 2 && sellerMsgs.every((m) => m.type === 'system_update' && !/rep[1-9]\b|secret reporter|adm\d/.test(JSON.stringify(m)) && !/[<>]/.test(m.body))
      && repMsgs.length >= 3 && repMsgs.every((m) => /now resolved/.test(m.body) && !/Counterfeit confirmed|brand photos|Prohibited item|adm\d|taken it down/.test(JSON.stringify(m)))
      && !allText.includes('brand photos') && nf.success === true && rFdoc.notifications && rFdoc.notifications.seller && rFdoc.notifications.seller.status === 'failed'
      && rFdoc.notifications.reporter.status === 'failed' && (nf.notifications || []).every((n) => n.status === 'failed'),
    { sellerMsgs: sellerMsgs.map((m) => m.title), repMsgs: repMsgs.length, nf: nf.notifications, rec: rFdoc.notifications });

  say('\n── A: audit ──');
  const all = await audits();
  const decisions = all.filter((a) => a.action === 'report_reviewed');
  const need = ['performedBy', 'actorRole', 'reportId', 'targetType', 'targetId', 'from', 'result', 'decision', 'resolution', 'createdAt', 'enforcement', 'correlationId', 'revision'];
  const missing = decisions.filter((a) => need.some((k) => a[k] === undefined || (k !== 'resolution' && a[k] === null && k !== 'targetId')));
  ck('A1 every decision has ONE audit row with actor, role, report, target type/id, previous + new status, decision, note, time, enforcement, correlation id, revision (deterministic id)',
    decisions.length >= 9 && missing.length === 0 && decisions.every((a) => a._id === 'rpt_' + crypto.createHash('sha256').update(a.reportId).digest('hex').slice(0, 16) + '_r' + a.revision)
      && decisions.find((a) => a.reportId === ids[0] && a.result === 'actioned').enforcement === 'listing_hidden'
      && decisions.find((a) => a.reportId === ids[2]).enforcement === 'none', { n: decisions.length, missing: missing.map((a) => a._id) });
  ck('A2 audit rows carry no reporter PII beyond the report id (no reportedBy, no reporter text)',
    all.length > 0 && all.every((a) => !('reportedBy' in a) && !JSON.stringify(a).includes('secret reporter words')), all.length);

  say('\n── SB: the sabotage scenarios (§27) ──');
  const sbR = await file('rep10', 'pA2', 'misleading', 'sb', T0 + 11 * 864e5);
  const sbId = sbR.reportId;
  const sb1 = [await codeOf(TS.tsReviewReport(as('rep1', { reportId: sbId, action: 'approve', hideProduct: true }))), await codeOf(TS.tsGetReports(as('rep1', { queueStatus: 'active' })))];
  ck('SB1 a buyer cannot moderate or read the queue (permission-denied); the report and listing are untouched',
    sb1.every((c) => c === 'permission-denied') && (await get('reports/' + sbId)).status === 'pending' && (await get('products/pA2')).isVisible === true, sb1);
  const sb2 = [await codeOf(TS.tsReviewReport(as(SA, { reportId: sbId, action: 'dismiss', resolution: 'not true' }))),
    await codeOf(TS.tsReviewReport(as(SA, { reportId: sbId, action: 'remove', resolution: 'delete it' })))];
  ck('SB2 the seller cannot modify a report on their listing (dismiss / remove refused; record unchanged)',
    sb2.every((c) => c === 'permission-denied') && (await get('reports/' + sbId)).status === 'pending' && (await get('reports/' + sbId)).resolution === null, sb2);
  const mine3 = await tryv(TS.tsGetReports(as(SA, { scope: 'mine' })));
  const b3 = JSON.stringify(mine3);
  ck('SB3 the seller cannot see who reported (no reporter uid / text in scope:mine, even for the newest report)',
    Array.isArray(mine3.reports) && mine3.reports.length > 0 && !/rep10|rep9|rep5|rep4|"sb"/.test(b3) && !/reportedBy|"detail"/.test(b3), b3.slice(0, 200));
  const sb4 = await codeOf(TS.tsReviewReport(as(SA, { reportId: sbId, action: 'approve', hideProduct: true, resolution: 'self' })));
  ck('SB4 the seller cannot uphold (or otherwise decide) a report — permission-denied, listing untouched',
    sb4 === 'permission-denied' && (await get('reports/' + sbId)).status === 'pending' && (await get('products/pA2')).isVisible === true, sb4);
  await db.doc('reports/forged_story_1').set({ entityType: 'story', entityId: 's1', status: 'pending', reportedBy: 'x', reason: 'r' });
  const sb5 = [await codeOf(TS.tsReviewReport(as('adm1', { reportId: 'forged_story_1', action: 'approve' }, ADMIN))),
    await codeOf(TS.tsReviewReport(as('adm1', { reportId: 'forged_story_1', action: 'claim' }, ADMIN)))];
  const sb5case = await tryv(TS.tsGetReportCase(as('adm1', { reportId: 'forged_story_1' }, ADMIN)));
  ck('SB5 an admin cannot moderate an unsupported target type (story): decide and claim refused, no action offered',
    sb5.every((c) => c === 'failed-precondition') && (await get('reports/forged_story_1')).status === 'pending' && sb5case.target && sb5case.target.supported === false
      && Array.isArray(sb5case.actions) && sb5case.actions.length === 0, { sb5, t: sb5case.target });
  const sb6 = await tryv(TS.tsReviewReport(as('adm1', { reportId: sbId, action: 'dismiss', status: 'upheld', decision: 'approve', hidden: true, hideProduct: false,
    sellerId: 'evil', reporterId: 'evil', targetId: 'pB', resolved: true, priority: 99, actor: 'sup1', performedBy: 'sup1', resolution: 'fine' }, ADMIN)));
  const sb6doc = await get('reports/' + sbId);
  const sb6aud = await audits((a) => a.reportId === sbId);
  ck('SB6 the browser sending status=upheld (+ hidden, seller, reporter, target, actor) is NOT trusted: stored dismissed, listing visible, actor = the caller',
    sb6.moderationState === 'rejected' && sb6doc.status === 'dismissed' && (await get('products/pA2')).isVisible === true && sb6aud.length === 1
      && sb6aud[0].performedBy === 'adm1' && sb6aud[0].targetId === 'pA2' && sb6doc.reportedBy === 'rep10' && sb6doc.context.sellerUid === SA, { sb6, aud: sb6aud[0] && sb6aud[0].performedBy });
  const sbU = await file('rep11', 'pA2', 'counterfeit', 'dup', T0 + 12 * 864e5);
  const u1 = await tryv(TS.tsReviewReport(as('adm1', { reportId: sbU.reportId, action: 'approve', hideProduct: true, resolution: 'fake' }, ADMIN)));
  const hold1 = (await get('products/pA2')).moderationHold;
  const u2b = await codeOf(TS.tsReviewReport(as('adm1', { reportId: sbU.reportId, action: 'approve', hideProduct: true, resolution: 'fake' }, ADMIN)));
  const uAud = await audits((a) => a.reportId === sbU.reportId);
  ck('SB7 a duplicate uphold (double click / second invocation) produces ONE decision: second refused, one audit row, the hold is not rewritten',
    u1.success === true && u2b === 'failed-precondition' && uAud.length === 1 && JSON.stringify((await get('products/pA2')).moderationHold) === JSON.stringify(hold1), { u1, u2b, n: uAud.length });
  const sbC = await file('rep12', 'pA2', 'scam', 'conc', T0 + 13 * 864e5);
  const conc = await Promise.all([
    tryv(TS.tsReviewReport(as('adm1', { reportId: sbC.reportId, action: 'dismiss', resolution: 'a' }, ADMIN))),
    tryv(TS.tsReviewReport(as('adm2', { reportId: sbC.reportId, action: 'escalate' }, ADMIN))),
    tryv(TS.tsReviewReport(as('sup1', { reportId: sbC.reportId, action: 'approve' }, SUPER))),
  ]);
  const cAud = await audits((a) => a.reportId === sbC.reportId);
  const cDoc = await get('reports/' + sbC.reportId);
  const okN = conc.filter((x) => x.success).length;
  /* determinism: every stored transition is a legal step from the audit row before it */
  const chain = cAud.sort((a, b) => a.revision - b.revision);
  const legal = chain.every((a, i) => (i === 0 ? a.from === 'pending' : a.from === chain[i - 1].result) && (REPORT_LEGAL(a.result, a.from)));
  function REPORT_LEGAL(to, from) { return (TS._reportModel.REPORT_TRANSITIONS[to] || []).includes(from); }
  ck('SB8 concurrent decisions resolve deterministically: every committed step is legal from the one before it, one audit row per committed step, final state = last step',
    okN >= 1 && cAud.length === okN && legal && cDoc.status === chain[chain.length - 1].result && cDoc.revision === chain.length, { conc, chain: chain.map((a) => a.from + '>' + a.result) });
  const sb9 = [await codeOf(TS.tsReportContent(as(SA, { entityType: 'product', entityId: 'pA2', reasonCode: 'scam', sellerUid: 'someoneElse' }))),
    await codeOf(TS.tsReportContent(as(SA, { entityType: 'listing', entityId: 'pA', reasonCode: 'counterfeit', sellerUid: 'someoneElse', context: { sellerUid: 'x' } })))];
  ck('SB9 the seller cannot report their own listing, even claiming another seller identity (failed-precondition; nothing written)',
    sb9.every((c) => c === 'failed-precondition') && !(await get('reports/' + SA + '_product_pA2')) && !(await get('reports/' + SA + '_product_pA')), sb9);
  const sb10 = [await codeOf(TS.tsReportContent(as('rep1', { entityType: 'product', entityId: 'pA', reasonCode: 'scam' }))),
    await codeOf(TS.tsReportContent(as('rep1', { entityType: 'listing', entityId: 'pA', reasonCode: 'other', detail: 'trying again after reopen' })))];
  ck('SB10 a second report by the same person on the same listing is refused (already-exists), even after the first was decided and reopened',
    sb10.every((c) => c === 'already-exists'), sb10);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
