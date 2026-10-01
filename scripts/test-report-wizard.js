#!/usr/bin/env node
/* test-report-wizard.js — community C2 (2026-10-01): the product-page report WIZARD, the shared report QUEUE and the
 * seller / super-admin wiring, driven against the REAL server authority.
 *
 *   SOKONI_FUNCTIONS_DIR=C:/temp/sok-reports-fn/functions node scripts/test-report-wizard.js
 *
 * The server half (functions/trust-safety.js) lives on the FUNCTIONS lineage, a different branch from this hosting
 * tree. Point SOKONI_FUNCTIONS_DIR at it. If the directory holds a trust-safety.js without the report authority
 * (no tsGetReportReasons) the suite says BLOCKED and exits 2 — it never passes against the wrong server.
 *
 * WHAT IS REAL: sokoni-trust.js (SokoniReport), sokoni-report-wizard.js, sokoni-trust-queues.js, the server handlers
 * tsGetReportReasons / tsReportContent / tsGetReports / tsReviewReport on the transactional fake Firestore.
 * WHAT IS FAKE: the DOM (scripts/lib/mini-dom.js — no layout, no CSS) and the Firebase SDK (a callable shim that
 * invokes the real handler with the signed-in uid). Rendering at 390/1280 is the browser cert's job (queued).
 *
 * PROVES
 *   PG1 product.html: no client reason list, no `flags` write, no fake "Report submitted"; it opens the wizard
 *   PG2 no client report path writes flags / communityReports / contentFlags (product, seller, trust, wizard)
 *   WZ1 signed out → "Sign in to report"; nothing is sent
 *   WZ2 step 1 renders EXACTLY the server's reasons (a radio group in a labelled fieldset) — nothing else
 *   WZ3 Next without a reason → an alert, still step 1
 *   WZ4 'other' needs a description: refused below the server minimum; the textarea is capped at the server max
 *   WZ5 review shows what will be sent; while sending NOTHING says "received"; success only after the server answered,
 *       and the report is on the server with the chosen code
 *   WZ6 dedupe: a second report by the same user → "already reported" (no success), still ONE report on the server
 *   WZ7 honest refusal: the seller's own product → "your own listing"; a server failure → "NOT sent", details kept
 *   WZ8 the reason list failing to load → an error + retry, ZERO reasons offered (no fallback list)
 *   WZ9 accessibility: role=dialog, aria-modal, labelled, step announced; Escape closes and focus returns; 44px targets
 *   SP1 seller-public's free-text report goes through the same authority; a refusal returns null (form stays open)
 *   QU1 the shared queue lists through tsGetReports {state} and shows entityId-backed rows (never targetId)
 *   QU2 NEGATIVE CONTROL: every action the queue can send is one the server accepts; 'action' is not one
 *   QU3 a decision is reported only after the server returns; "take down" hides the product
 *   QU4 a failed read is an error, never "No reports"; a note-required action without a note sends nothing
 *   MV1 merchant-v2 wires callReports → tsGetReports, the seller tab asks scope:'mine' and renders no reporter
 *   SA1 super admin: Trust reports nav (inline onclick + nav-label), router branch, panel, shared queue, script tag
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.SOKONI_FUNCTIONS_DIR ? path.resolve(process.env.SOKONI_FUNCTIONS_DIR) : path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const { makeDocument } = require('./lib/mini-dom');

let pass = 0, fail = 0;
const say = console.log;
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 300) : '')); } };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* ── the REAL server on the fake Firestore ── */
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
let TS;
try { TS = require(path.join(FN_DIR, 'trust-safety.js')); } catch (e) { say('BLOCKED — cannot load trust-safety.js: ' + e.message); process.exit(2); }
if (typeof TS.tsGetReportReasons !== 'function' || !TS._reportModel) {
  say('BLOCKED — this trust-safety.js has no report authority (tsGetReportReasons). Set SOKONI_FUNCTIONS_DIR to the functions lineage.');
  process.exit(2);
}
console.log = console.info = console.warn = console.debug = () => {};

/* ── a page: mini DOM + the Firebase callable shim over the real handlers ── */
let callLog = [];
function makePage(opts) {
  const document = makeDocument();
  const user = { current: opts.uid ? { uid: opts.uid } : null };
  const fail = opts.fail || {};   /* { fnName: { code, message } } — a transport/server failure to simulate */
  const window = {
    document, location: { pathname: '/product.html', search: '?id=pA', href: '' },
    firebaseApp: {}, firebaseFunctions: {}, firebaseAuth: { get currentUser() { return user.current; } },
    waitForSokoniAuthReady: () => Promise.resolve(), __sokoniAppCheckReady: Promise.resolve('exchanged'),
  };
  const fnShim = {
    getFunctions: () => ({}),
    httpsCallable: (_f, name) => async (data) => {
      callLog.push({ name, data, uid: user.current && user.current.uid });
      if (fail[name]) { const e = new Error(fail[name].message); e.code = 'functions/' + fail[name].code; throw e; }
      const h = TS[name]; if (typeof h !== 'function') { const e = new Error('not found'); e.code = 'functions/not-found'; throw e; }
      try { return { data: await h({ auth: user.current ? { uid: user.current.uid, token: opts.token || {} } : null, data }) }; }
      catch (e) { const x = new Error(e.message); x.code = 'functions/' + (e.code || 'internal'); throw x; }
    },
  };
  const imp = async (url) => { if (/firebase-functions\.js$/.test(url)) return fnShim; throw new Error('unexpected import ' + url); };
  const run = (file) => {
    const code = src(file).replace(/\bimport\(/g, '__imp(');
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', '__imp', 'globalThis', code)(window, document, window.location, imp, window);
  };
  run('sokoni-trust.js');
  run('sokoni-report-wizard.js');
  return { window, document, user };
}
const tick = async (n) => { for (let i = 0; i < (n || 25); i++) await new Promise((r) => setImmediate(r)); };
const dlg = (P) => P.document.querySelector('[role="dialog"]');
const text = (P) => { const d = dlg(P); return d ? d.textContent : ''; };
const btnByText = (P, t) => { const d = dlg(P); return d ? d.querySelectorAll('button').find((b) => b.textContent === t) : null; };
const radios = (P) => { const d = dlg(P); return d ? d.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'radio') : []; };
const choose = (P, code) => { const r = radios(P).find((i) => i.getAttribute('value') === code); if (r) { r.checked = true; r.dispatchEvent({ type: 'change' }); } return !!r; };
const reportsOn = async (pid) => (await db.collection('reports').where('entityId', '==', pid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

(async () => {
  await db.doc('products/pA').set({ name: 'Kitenge Dress', sellerUid: 'sellerA', shopId: 'shopA', price: 2500, status: 'active', isVisible: true });
  await db.doc('products/pB').set({ name: 'Sufuria', sellerUid: 'sellerB', price: 900, status: 'active' });

  say('\n── the product page ──');
  const ph = src('product.html'), st = src('sokoni-trust.js'), wz = src('sokoni-report-wizard.js'), sp = src('seller-public.html');
  ck('PG1 product.html: no client reason list, no fake success; loads the wizard and opens it for a product',
    !/id="reportListingReason"/.test(ph) && !/<option>Counterfeit/.test(ph) && !/Report submitted\. Thank you\./.test(ph)
      && /<script src="sokoni-report-wizard\.js" defer><\/script>/.test(ph) && /SokoniReportWizard\.open\(\{ entityType:'product'/.test(ph)
      && /aria-haspopup="dialog"/.test(ph) && /min-height:44px/.test(ph));
  const writers = ['product.html', 'sokoni-trust.js', 'sokoni-report-wizard.js', 'seller-public.html'].filter((f) => {
    let s = src(f); if (f === 'sokoni-trust.js') s = s.slice(s.indexOf('window.SokoniReport = {'), s.indexOf('window.SokoniOnboarding'));   /* its dispute/onboarding blocks are other surfaces */
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    return /collection\([^)]*['"](flags|communityReports|contentFlags)['"]/.test(s) || /addDoc\(/.test(s);
  });
  ck('PG2 no client listing-report path writes flags / communityReports / contentFlags (or any addDoc)', writers.length === 0 && !/types:\s*\{/.test(st), writers);

  say('\n── the wizard ──');
  callLog = [];
  let P = makePage({ uid: null });
  P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pA', entityName: 'Kitenge Dress' });
  await tick();
  ck('WZ1 signed out → "Sign in to report", a sign-in link, nothing sent',
    /Sign in to report/.test(text(P)) && !!dlg(P).querySelector('a[href]') && callLog.every((c) => c.name !== 'tsReportContent'), text(P));
  P.document.key('Escape'); await tick();

  P = makePage({ uid: 'buyer1' });
  const opener = P.document.body.appendChild(P.document.createElement('button')); opener.focus();
  const done1 = P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pA', entityName: 'Kitenge Dress', opener });
  await tick();
  const server = TS._reportModel.REPORT_REASONS.product;
  const shown = radios(P).map((r) => r.getAttribute('value'));
  const fsEl = dlg(P) && dlg(P).querySelector('fieldset');
  ck('WZ2 step 1 offers EXACTLY the server\'s reasons, as a radio group in a fieldset with a legend',
    shown.length === server.length && server.every((r, i) => shown[i] === r.code && text(P).includes(r.label)) && !!fsEl && !!fsEl.querySelector('legend')
      && /Step 1 of 3/.test(text(P)), { shown });
  btnByText(P, 'Next').click(); await tick();
  ck('WZ3 Next without a reason → an alert, still on step 1', /Choose a reason to continue/.test(text(P)) && !!dlg(P).querySelector('[role="alert"]') && /Step 1 of 3/.test(text(P)));

  choose(P, 'other'); await tick();
  btnByText(P, 'Next').click(); await tick();
  const ta = dlg(P).querySelector('#srwDetail');
  ck('WZ4a step 2: the description is REQUIRED for "other" and capped at the server max',
    /Step 2 of 3/.test(text(P)) && !!ta && ta.getAttribute('maxlength') === String(TS._reportModel.REPORT_DETAIL_MAX) && ta.getAttribute('aria-required') === 'true' && /\(required\)/.test(text(P)));
  ta.value = 'short'; ta.dispatchEvent({ type: 'input' });
  btnByText(P, 'Next').click(); await tick();
  ck('WZ4b below the server minimum → refused with an alert, still step 2', /at least 10 characters/.test(text(P)) && /Step 2 of 3/.test(text(P)));
  const t2 = dlg(P).querySelector('#srwDetail'); t2.value = 'Seller asked me to pay outside SOKONI'; t2.dispatchEvent({ type: 'input' });
  btnByText(P, 'Next').click(); await tick();
  ck('WZ5a step 3 reviews what will be sent', /Step 3 of 3/.test(text(P)) && text(P).includes('Something else') && text(P).includes('Seller asked me to pay outside SOKONI') && /never told who reported/.test(text(P)));
  callLog = [];
  btnByText(P, 'Submit report').click();
  const midway = text(P);
  await tick();
  const after = text(P);
  const onServer = await reportsOn('pA');
  ck('WZ5b nothing says "received" while sending; success only after the server answered; the report is on the server',
    /Sending…/.test(midway) && !/SOKONI has your report/.test(midway) && /SOKONI has your report/.test(after)
      && onServer.length === 1 && onServer[0].id === 'buyer1_product_pA' && onServer[0].reasonCode === 'other'
      && callLog.some((c) => c.name === 'tsReportContent' && c.data.reasonCode === 'other' && c.data.entityType === 'product'), { midway: midway.slice(0, 80), n: onServer.length });
  btnByText(P, 'Done').click(); await tick();
  ck('WZ9a closing returns focus to the opener and removes the dialog', P.document.activeElement === opener && !dlg(P));

  P = makePage({ uid: 'buyer1' });
  P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pA' }); await tick();
  choose(P, 'scam'); await tick(); btnByText(P, 'Next').click(); await tick(); btnByText(P, 'Next').click(); await tick();
  btnByText(P, 'Submit report').click(); await tick();
  ck('WZ6 dedupe: the same user again → "already reported", no success, still ONE report on the server',
    /You have already reported this/.test(text(P)) && !/SOKONI has your report/.test(text(P)) && (await reportsOn('pA')).filter((r) => r.reportedBy === 'buyer1').length === 1, text(P));
  P.document.key('Escape'); await tick();

  P = makePage({ uid: 'sellerA' });
  P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pA' }); await tick();
  choose(P, 'counterfeit'); await tick(); btnByText(P, 'Next').click(); await tick(); btnByText(P, 'Next').click(); await tick();
  btnByText(P, 'Submit report').click(); await tick();
  ck('WZ7a the seller\'s own product → "This is your own listing" (the server\'s refusal, shown as such)', /This is your own listing/.test(text(P)) && !/SOKONI has your report/.test(text(P)));
  P.document.key('Escape'); await tick();

  P = makePage({ uid: 'buyer2', fail: { tsReportContent: { code: 'unavailable', message: 'Service unavailable' } } });
  P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pA' }); await tick();
  choose(P, 'misleading'); await tick(); btnByText(P, 'Next').click(); await tick();
  const t3 = dlg(P).querySelector('#srwDetail'); t3.value = 'Price says 500, checkout says 2500'; t3.dispatchEvent({ type: 'input' });
  btnByText(P, 'Next').click(); await tick(); btnByText(P, 'Submit report').click(); await tick();
  ck('WZ7b a server failure → "Your report was NOT sent", still on review with the details kept; nothing on the server',
    /Your report was NOT sent: Service unavailable/.test(text(P)) && /Step 3 of 3/.test(text(P)) && text(P).includes('Price says 500, checkout says 2500')
      && !(await reportsOn('pA')).some((r) => r.reportedBy === 'buyer2'), text(P).slice(0, 200));
  P.document.key('Escape'); await tick();

  P = makePage({ uid: 'buyer3', fail: { tsGetReportReasons: { code: 'unavailable', message: 'offline' } } });
  P.window.SokoniReportWizard.open({ entityType: 'product', entityId: 'pB' }); await tick();
  ck('WZ8 the reason list failing → an error + Try again, ZERO reasons offered (no client fallback)',
    radios(P).length === 0 && /could not be loaded: offline/.test(text(P)) && !!btnByText(P, 'Try again'));
  const d = dlg(P);
  const lab = d && P.document.getElementById(d.getAttribute('aria-labelledby'));
  P.document.key('Escape'); await tick();
  ck('WZ9b role=dialog, aria-modal, labelled by its heading, the step announced (aria-live), Escape closes; buttons ≥44px',
    !!d && d.getAttribute('aria-modal') === 'true' && !!lab && /Report this listing/.test(lab.textContent) && !dlg(P)
      && /\.srw-btn\{[^}]*min-height:44px/.test(wz) && /\.srw-x\{[^}]*44px/.test(wz) && /\.srw-opt\{[^}]*min-height:44px/.test(wz) && /aria-live/.test(wz));

  say('\n── seller-public (free-text report on the same authority) ──');
  P = makePage({ uid: 'buyer1' });
  const sp1 = await P.window.SokoniReport.submit('user', 'sellerB', 'Scam / fraud', 'Took a deposit');
  const sp2 = await P.window.SokoniReport.submit('user', 'sellerB', 'Scam / fraud', 'again');
  ck('SP1 seller-public goes to tsReportContent (one report); a refusal returns null so its form stays open',
    !!sp1 && sp1.reportId === 'buyer1_user_sellerB' && sp2 === null && /if\(!r\) return;/.test(sp) && !/Report submitted\. Thank you\./.test(sp));

  say('\n── the shared report queue (AdminOS + super admin) ──');
  const TQ = require(path.join(ROOT, 'sokoni-trust-queues.js'));
  const qdoc = makeDocument();
  const qcalls = [];
  const qCallable = (failRead) => (name) => async (payload) => {
    qcalls.push({ name, payload });
    if (failRead && name === 'tsGetReports') { const e = new Error('permission-denied: admin required'); throw e; }
    return TS[name]({ auth: { uid: 'adm1', token: { admin: true } }, data: payload });
  };
  const toasts = [];
  const host = qdoc.body.appendChild(qdoc.createElement('div'));
  const Q = TQ.mount(host, { callable: qCallable(false), onToast: (m) => toasts.push(m) });
  await tick();
  const qhtml = () => host.children[0].innerHTML;
  ck('QU1 the queue lists through tsGetReports {state:"pending"} and shows the product (entityId-backed), never "targetId"',
    qcalls[0] && qcalls[0].name === 'tsGetReports' && qcalls[0].payload.state === 'pending' && /Kitenge Dress/.test(qhtml()) && /Pending review/.test(qhtml())
      && !/targetId/.test(src('sokoni-trust-queues.js')), qcalls[0]);
  const serverActions = Object.keys(TS._reportModel.REPORT_ACTIONS);
  const sent = Object.keys(TQ.ACTION).map((a) => (a === 'takedown' ? 'approve' : a));
  ck('QU2 NEGATIVE CONTROL: every action the queue can send is accepted by the server; "action" is not one, and the server refuses it',
    sent.every((a) => serverActions.includes(a)) && !sent.includes('action') && !serverActions.includes('action'), { sent, serverActions });

  /* drive the drawer through the module's own delegated click handler */
  const qel = host.children[0];
  const clickData = (attrs) => {
    const fake = { getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false };
    const target = { closest: () => fake };
    const orig = qel.contains.bind(qel); qel.contains = (n) => n === fake || orig(n);
    qel.dispatchEvent({ type: 'click', target });
    qel.contains = orig;
  };
  const S = Q.state();
  const idx = S.rows.findIndex((r) => r.entityId === 'pA');
  clickData({ 'data-act': 'open', 'data-i': String(idx) }); await tick();
  qcalls.length = 0;
  clickData({ 'data-act': 'decide', 'data-v': 'request_changes' }); await tick();
  ck('QU4a "Request changes" without a note sends nothing and says why', qcalls.length === 0 && /needs a reason on record/.test(qhtml()));
  const before = toasts.length;
  clickData({ 'data-act': 'decide', 'data-v': 'takedown' });
  const toastWhileBusy = toasts.length;
  await tick();
  const prod = (await db.doc('products/pA').get()).data();
  ck('QU3 "Uphold + take product down": no toast until the server returned; then the product is hidden and the report upheld',
    toastWhileBusy === before && toasts.length === before + 1 && /product taken down/.test(toasts[toasts.length - 1]) && prod.isVisible === false
      && (await db.doc('reports/buyer1_product_pA').get()).data().status === 'actioned', { toasts, vis: prod.isVisible });

  const host2 = qdoc.body.appendChild(qdoc.createElement('div'));
  TQ.mount(host2, { callable: qCallable(true) }); await tick();
  const h2 = host2.children[0].innerHTML;
  ck('QU4b a failed read is an ERROR ("Could not load the report queue"), never "No reports here"', /Could not load the report queue/.test(h2) && !/No reports here/.test(h2) && /role="alert"/.test(h2));

  say('\n── merchant-v2 (the seller) and super admin ──');
  const mv = src('merchant-v2.html'), mui = src('sokoni-merchant-disputes-ui.js');
  ck('MV1 merchant-v2 wires callReports → tsGetReports; the seller tab asks scope:"mine", labels moderationState and shows no reporter',
    /callReports: _callable\('tsGetReports'\)/.test(mv) && /ctx\.callReports\(\{ scope: 'mine' \}\)/.test(mui) && /REPORT_STATE\[r\.moderationState\]/.test(mui)
      && !/reportedBy/.test(mui) && /who reported it is never shown/.test(mui) && !/target="_blank"/.test(mui.slice(mui.indexOf('function reportsHTML'), mui.indexOf('function visible'))));
  const sa = src('super-admin.html');
  ck('SA1 super admin: Trust reports nav (inline onclick + nav-label), router branch, panel, shared queue, script tag',
    /<button class="nav-item" data-section="trust" data-label="Trust reports" type="button" onclick="SA\.nav\('trust'\);_closeSidebar\(\)">\s*<span class="nav-icon">[^<]*<\/span><span class="nav-label">Trust reports<\/span>/.test(sa)
      && /else if\(section==='trust'\)this\.loadTrustQueue\(\);/.test(sa) && /<section class="sa-panel" id="panel-trust" hidden>/.test(sa)
      && /window\.SokoniTrustQueues\.mount\(root,/.test(sa) && /<script src="sokoni-trust-queues\.js"><\/script>/.test(sa));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
