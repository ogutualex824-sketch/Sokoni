#!/usr/bin/env node
/* test-moderation-console.js — community C3 (2026-10-01): the moderation CONSOLE (sokoni-trust-queues.js) in AdminOS
 * and Super Admin, and the seller's status view, driven against the REAL report authority.
 *
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-moderation-console.js
 *
 * The module is driven through its own delegated handlers on the mini DOM (scripts/lib/mini-dom.js — no HTML parser:
 * the rendered markup is inspected as a string). The server is functions/trust-safety.js on the transactional fake
 * Firestore. TRIPWIRE: the real firebase-admin / notify.js can never load (no live project is reachable).
 * Without the C3 server (no tsGetReportCase) → BLOCKED, exit 2.
 *
 * PROVES
 *   MC1  AdminOS: a dedicated Moderation section — nav item (inline onclick + nav-label), panel, loader, deep link
 *        #moderation is routable, the module mounted with { console:'adminos', call }
 *   MC2  ONE console: the Fraud & Trust "Reports Queue" modal is gone; its button opens the Moderation section
 *   MC3  the queue renders the SERVER's queue status, ref, listing, seller, reviewer; an unknown count renders "—", not 0
 *   MC4  the case drawer offers EXACTLY the server's actions for this report and moderator; an unsupported target
 *        offers nothing
 *   MC5  "Take under review" claims through tsReviewReport (action claim, a requestId) and re-reads the case
 *   MC6  retry semantics: a network failure keeps the SAME requestId for the retry (server replays); a refusal ends it
 *   MC7  a decision payload carries only the decision fields — never a status, seller, reporter, target, hidden flag
 *        or actor; the decision is shown only after the server returns
 *   MC8  1 listing + N reports: "Group by listing" asks the server and renders one group per listing
 *   MC9  the seller's tab: the server's seller vocabulary, the support route on decided reports, no reporter
 *   MC10 Fraud & Trust tiles: an unknown dashboard figure is "—", never 0
 *   MC11 output is escaped (a listing title with markup) and only https images / evidence are rendered
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { makeDocument } = require('./lib/mini-dom');
let pass = 0, fail = 0;
const say = console.log;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 360) : '')); } };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin' || id === 'firebase-admin/app' || id === 'firebase-admin/auth' || id === './notify') throw new Error('TRIPWIRE: ' + id + ' required from a test');
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  return origReq.apply(this, arguments);
};
say('\nfunctions source: ' + FN_DIR);
let TS;
try { TS = require(path.join(FN_DIR, 'trust-safety.js')); } catch (e) { say('BLOCKED — cannot load trust-safety.js: ' + e.message); process.exit(2); }
if (typeof TS.tsGetReportCase !== 'function' || typeof TS._setNotifier !== 'function') {
  say('BLOCKED — this trust-safety.js has no moderation queue (tsGetReportCase). Set SOKONI_FUNCTIONS_DIR to the C3 functions lineage.');
  process.exit(2);
}
TS._setNotifier(async (o) => ({ ok: true, key: o.dedupeKey, channels: { inapp: 'sent' } }));
console.log = console.info = console.warn = console.debug = () => {};
const TQ = require(path.join(ROOT, 'sokoni-trust-queues.js'));
const tick = async (n) => { for (let i = 0; i < (n || 30); i++) await new Promise((r) => setImmediate(r)); };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: e.code || e.message }; } };
const as = (uid, data, token) => ({ auth: uid ? { uid, token: token || {} } : null, data });
const ADMIN = { admin: true };

/* a console host: the module mounted with the shared contract; every call goes to the real handler as `uid` */
function consoleFor(uid, token, opts) {
  const doc = makeDocument(); const calls = []; const toasts = [];
  const o = opts || {};
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = async (name, payload) => {
    calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
    if (o.failNext && o.failNext[name]) { const f = o.failNext[name]; delete o.failNext[name]; const e = new Error(f.message); e.code = f.code; throw e; }
    if (o.override && o.override[name]) return o.override[name](payload);
    try { return await TS[name]({ auth: { uid, token }, data: payload }); }
    catch (e) { const x = new Error(e.message); x.code = e.code; throw x; }
  };
  const Q = TQ.mount(host, { console: o.console || 'adminos', call, onToast: (m) => toasts.push(m) });
  const el = host.children[0];
  const click = (attrs) => {
    const fake = { getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false };
    const orig = el.contains.bind(el); el.contains = (n) => n === fake || orig(n);
    el.dispatchEvent({ type: 'click', target: { closest: () => fake } });
    el.contains = orig;
  };
  const field = (f, value, checked) => el.dispatchEvent({ type: 'input', target: { getAttribute: (k) => (k === 'data-f' ? f : null), value, checked } });
  return { Q, el, calls, toasts, click, field, html: () => el.innerHTML, o };
}

(async () => {
  await db.doc('products/pA').set({ name: 'Kitenge <img src=x onerror=alert(1)>', sellerUid: 'sellerA', shopId: 'shopA', price: 2500, status: 'active', isVisible: true,
    images: ['https://img.example/a.jpg', 'javascript:alert(1)', 'http://plain/x.jpg'] });
  await db.doc('products/pB').set({ name: 'Sufuria', sellerUid: 'sellerB', shopId: 'shopB', price: 900, status: 'active', isVisible: true });
  await db.doc('shops/shopA').set({ name: 'Mama Kitenge' });
  const rep = async (uid, entityId, reasonCode, detail) => (await tryv(TS.tsReportContent(as(uid, { entityType: 'product', entityId, reasonCode, detail: detail || '' })))).reportId;
  const a1 = await rep('rep1', 'pA', 'counterfeit', 'reporter words one');
  const a2 = await rep('rep2', 'pA', 'scam', 'reporter words two');
  const b1 = await rep('rep3', 'pB', 'misleading', '');
  await db.doc('reports/rep9_story_s1').set({ entityType: 'story', entityId: 's1', status: 'pending', reportedBy: 'rep9', reason: 'x' });

  say('\n── AdminOS / Super Admin wiring ──');
  const html = src('admin-os.html'), aos = src('sokoni-aos.js'), sa = src('super-admin.html');
  const loaders = aos.slice(aos.indexOf('function _loadPanel(s)'), aos.indexOf('// Admin-OS ops whitelist'));
  ck('MC1 AdminOS: a dedicated Moderation section — inline-onclick nav item with nav-label, panel + host, loader, deep link routable, mounted { console:"adminos", call }',
    /<button class="nav-item" data-section="moderation" data-label="Moderation" onclick="SokoniAOS\.navigate\('moderation'\);_closeSidebar\(\)"><span class="nav-icon">[^<]*<\/span><span class="nav-label">Moderation<\/span><\/button>/.test(html)
      && /<div class="aos-panel" id="panel-moderation" hidden>[\s\S]{0,700}<div id="moderationBody">/.test(html)
      && /moderation:\s*\(\) => _loadModeration\(\)/.test(loaders) && /function _loadModeration\(\) \{\s*_mountTrustQueue\(document\.getElementById\("moderationBody"\)\);/.test(aos)
      && /console: "adminos",\s*call: \(name, payload\) => _fn\.httpsCallable\(name\)\(payload\)\.then\(\(r\) => r\.data\)/.test(aos)
      && html.indexOf('sokoni-trust-queues.js') > 0 && html.indexOf('sokoni-trust-queues.js') < html.indexOf('<script src="sokoni-aos.js"'));
  const vr = aos.slice(aos.indexOf('async function viewReports()'), aos.indexOf('function _loadModeration()'));
  ck('MC2 ONE console: the "Reports Queue" modal is gone; the Fraud & Trust button opens the Moderation section; super admin mounts the same module as "superadmin"',
    /_navigate\("moderation"\)/.test(vr) && !/_modal\(/.test(vr) && !/_modal\("Reports Queue"/.test(aos) && /onclick="SokoniAOS\.viewReports\(\)"/.test(aos)
      && /console:'superadmin'/.test(sa) && (sa.match(/SokoniTrustQueues\.mount\(/g) || []).length === 1 && (aos.match(/SokoniTrustQueues\.mount\(/g) || []).length === 1);

  say('\n── the queue ──');
  const C = consoleFor('adm1', ADMIN, { override: {} });
  await tick();
  const first = C.calls[0] || {};
  const h1 = C.html();
  ck('MC3 the queue renders the server\'s queue status, ref, listing, seller, reviewer; first read is tsGetReports {state:"pending", facts:true}',
    first.name === 'tsGetReports' && first.payload.state === 'pending' && first.payload.facts === true && /Open<\/span>/.test(h1) && /ref [0-9a-f]{16}/.test(h1)
      && /listing pA/.test(h1) && /seller sellerA/.test(h1) && /unassigned/.test(h1) && /2 on listing/.test(h1), first);
  /* unknown facts → "—" (an override returns a row whose counts the server could not read) */
  const U = consoleFor('adm1', ADMIN, { override: { tsGetReports: async () => ({ reports: [{ id: 'x', ref: 'abcd', entityType: 'product', entityId: 'p9', queueStatus: 'open',
    context: { productName: 'Unknown counts' }, facts: { reportsOnListing: null, listingVisible: null } }], page: { limit: 50, scanned: 1, hasMore: false, nextCursor: null } }) } });
  await tick();
  const hu = U.html();
  ck('MC3b an unknown count renders "—", never 0; an unknown visibility is "listing —"', /— on listing/.test(hu) && !/0 on listing/.test(hu) && /listing —/.test(hu), hu.slice(0, 200));

  const S = C.Q.state();
  const iA = S.rows.findIndex((r) => r.id === a1);
  C.click({ 'data-act': 'open', 'data-i': String(iA) }); await tick();
  const caseCall = C.calls.find((c) => c.name === 'tsGetReportCase');
  const serverCase = await TS.tsGetReportCase({ auth: { uid: 'adm1', token: ADMIN }, data: { reportId: a1 } });
  const offered = [...C.html().matchAll(/data-act="(?:decide|assign)" data-v="([a-z_]+)"/g)].map((m) => m[1]).sort();
  const want = serverCase.actions.slice().sort();
  const iS = C.Q.state().rows.findIndex((r) => r.id === 'rep9_story_s1');
  const C2 = consoleFor('adm1', ADMIN); await tick();
  C2.click({ 'data-act': 'open', 'data-i': String(C2.Q.state().rows.findIndex((r) => r.id === 'rep9_story_s1')) }); await tick();
  ck('MC4 the drawer offers EXACTLY the server\'s actions for this report and moderator; an unsupported target (story) offers none and says why',
    caseCall && caseCall.payload.reportId === a1 && JSON.stringify(offered) === JSON.stringify(want) && want.includes('claim') && iS >= 0
      && !/data-act="decide"/.test(C2.html()) && /unsupported type/.test(C2.html()), { offered, want });

  C.calls.length = 0;
  C.click({ 'data-act': 'assign', 'data-v': 'claim' }); await tick();
  const claimCall = C.calls.find((c) => c.name === 'tsReviewReport');
  ck('MC5 "Take under review" claims through tsReviewReport (action claim + requestId) and re-reads the case; the server now shows the reviewer',
    claimCall && claimCall.payload.action === 'claim' && /^mq_[0-9a-f]{24}$/.test(claimCall.payload.requestId) && C.calls.some((c) => c.name === 'tsGetReportCase')
      && (await db.doc('reports/' + a1).get()).data().assignedTo === 'adm1' && /You have this report under review/.test(C.toasts.join('|')), claimCall);

  /* MC6: retry semantics */
  C.o.failNext = { tsReviewReport: { code: 'functions/unavailable', message: 'unavailable' } };
  C.field('note', 'Counterfeit confirmed');
  C.calls.length = 0;
  C.click({ 'data-act': 'decide', 'data-v': 'approve' }); await tick();
  const try1 = C.calls.filter((c) => c.name === 'tsReviewReport').map((c) => c.payload.requestId);
  C.click({ 'data-act': 'decide', 'data-v': 'approve' }); await tick();
  const try2 = C.calls.filter((c) => c.name === 'tsReviewReport').map((c) => c.payload.requestId);
  const dec = C.calls.filter((c) => c.name === 'tsReviewReport').pop() || {};
  ck('MC6 a network failure keeps the SAME requestId for the retry (the server would replay, not decide twice); the decision then lands once',
    try1.length === 1 && try2.length === 2 && try2[0] === try2[1] && (await db.doc('reports/' + a1).get()).data().status === 'actioned'
      && (await TS.tsGetReportCase({ auth: { uid: 'adm1', token: ADMIN }, data: { reportId: a1 } })).history.filter((h) => h.action === 'report_reviewed').length === 1, { try1, try2 });

  const allowed = ['reportId', 'action', 'resolution', 'internalNote', 'hideProduct', 'requestId', 'expectedRevision', 'applyToListing', 'restoreListing', 'takeover'];
  const extra = Object.keys(dec.payload || {}).filter((k) => !allowed.includes(k));
  ck('MC7 the decision payload carries only decision fields (no status / seller / reporter / target / hidden / actor) and expectedRevision from the case; success shown only after the server returned',
    dec.payload && extra.length === 0 && typeof dec.payload.expectedRevision === 'number' && dec.payload.action === 'approve' && /Report upheld/.test(C.toasts.join('|')), { extra, p: dec.payload });

  /* a refusal ends the intent: a stale second moderator gets a NEW id next time */
  const D = consoleFor('adm2', ADMIN); await tick();
  D.click({ 'data-act': 'open', 'data-i': String(D.Q.state().rows.findIndex((r) => r.id === a2)) }); await tick();
  await TS.tsReviewReport({ auth: { uid: 'adm1', token: ADMIN }, data: { reportId: a2, action: 'escalate' } });   /* someone else acts first */
  D.calls.length = 0;
  D.click({ 'data-act': 'decide', 'data-v': 'dismiss' }); await tick();
  D.click({ 'data-act': 'decide', 'data-v': 'dismiss' }); await tick();
  const dIds = D.calls.filter((c) => c.name === 'tsReviewReport').map((c) => c.payload.requestId);
  ck('MC6b a refusal (stale view → failed-precondition) is shown as the server said it and ends the intent: the next attempt is a NEW request',
    dIds.length === 2 && dIds[0] !== dIds[1] && /changed since you opened it/.test(D.html()), dIds);

  say('\n── grouping, seller, tiles, escaping ──');
  const G = consoleFor('adm1', ADMIN); await tick();
  G.field('group', '', true); G.calls.length = 0;
  G.click({ 'data-act': 'apply' }); await tick();
  const gCall = G.calls.find((c) => c.name === 'tsGetReports');
  const gh = G.html();
  ck('MC8 "Group by listing" asks the server (groupBy:"listing") and renders one group per listing with its report count',
    gCall && gCall.payload.groupBy === 'listing' && (gh.match(/class="stq-group"/g) || []).length >= 2 && /stq-gh">Sufuria/.test(gh), gCall && gCall.payload);

  const mui = src('sokoni-merchant-disputes-ui.js');
  const blk = mui.slice(mui.indexOf('var SELLER_STATUS'), mui.indexOf('function visible'));
  const mine = await TS.tsGetReports({ auth: { uid: 'sellerA', token: {} }, data: { scope: 'mine' } });
  ck('MC9 seller tab: renders the server\'s sellerStatus vocabulary, the support route on decided reports, never a reporter',
    /SELLER_STATUS\[r\.sellerStatus\]/.test(blk) && ['report_received', 'under_review', 'changes_requested', 'listing_action_taken', 'report_upheld', 'report_dismissed', 'closed'].every((k) => blk.includes(k + ':'))
      && /href="support\.html">Contact SOKONI Support/.test(blk) && !/reportedBy|assignedTo|internalNote/.test(blk)
      && mine.reports.every((r) => typeof r.sellerStatus === 'string') && !JSON.stringify(mine).includes('rep1'), mine.reports.map((r) => r.sellerStatus));

  const fr = aos.slice(aos.indexOf('async function _loadFraud()'), aos.indexOf('async function _loadPaymentAnomalies()'));
  ck('MC10 Fraud & Trust tiles: unknown dashboard figures render "—", never 0', /const _n = \(v\) => \(typeof v === "number" && isFinite\(v\) \? _fmt\(v\) : "—"\)/.test(fr)
    && !/_fmt\(d\.\w+\|\|0\)/.test(fr) && /\$\{_n\(d\.pendingReports\)\}/.test(fr));

  const E = consoleFor('adm1', ADMIN); await tick();
  E.click({ 'data-act': 'open', 'data-i': String(E.Q.state().rows.findIndex((r) => r.id === a2)) }); await tick();
  const eh = E.html();
  ck('MC11 output is escaped (a listing title with markup never becomes markup) and only https images are rendered',
    !/<img src=x/.test(eh) && /Kitenge &lt;img src=x onerror=alert\(1\)&gt;/.test(eh) && /<img src="https:\/\/img\.example\/a\.jpg"/.test(eh)
      && !/javascript:alert/.test(eh) && !/http:\/\/plain/.test(eh), eh.slice(0, 200));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
