#!/usr/bin/env node
/* test-complete-application-browser.js — the REAL complete-application.html in Chromium over the page harness, with the
 * REAL businessWorkspace handler (business-workspace.js + the derived approval state) on the fake store. Plus the surface's
 * pure decide() table in node.
 *
 * PROVES  the page renders exactly what the server's derived state says for six accounts (fresh / acknowledge / select /
 *         refused / approved / buyer); the intake CTA opens the EXISTING HubRegister modal (no parallel form); the select
 *         view lists every candidate and withdraws ONE through the seam (status 'withdrawn' on that id only), then reloads
 *         the server answer; nothing else is written; signed-out shows the sign-in note; 390 px without overflow.
 *
 *   node scripts/test-complete-application-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1'; process.env.GCLOUD_PROJECT = 'demo-ca-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'); const ROOT = Path.resolve(__dirname, '..');
/* FUNCTIONS_DIR lets a HOSTING candidate tree run this suite against the DEPLOYED function code (the pinned providerDispatch candidate) */
const FN = process.env.FUNCTIONS_DIR || Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub);
const BW = require(Path.join(FN, 'business-workspace.js'));
const CA = require(Path.join(ROOT, 'sokoni-complete-application.js'));
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const J = (x) => JSON.stringify(x);
(async () => {
  say('\n── decide(): the pure table ──');
  const D = CA.decide;
  ck('REAPPLICATION_REQUIRED + fresh → fresh / intake', J(D({ state: 'REAPPLICATION_REQUIRED', remediation: { applicationPath: { mode: 'fresh' } } })) === J({ view: 'fresh', cta: 'intake' }));
  ck('REAPPLICATION_REQUIRED + redecide_existing, agreement unsatisfied → acknowledge', D({ state: 'REAPPLICATION_REQUIRED', remediation: { applicationPath: { mode: 'redecide_existing', applicationId: 'P' }, agreement: { required: true, satisfied: false } } }).view === 'acknowledge');
  ck('REAPPLICATION_REQUIRED + continue_existing, agreement satisfied → awaiting_decision, no CTA', D({ state: 'REAPPLICATION_REQUIRED', remediation: { applicationPath: { mode: 'continue_existing', applicationId: 'P' }, agreement: { required: true, satisfied: true } } }).cta === null);
  ck('select_among_pending → select with the candidates, CTA withdraw', J(D({ state: 'REAPPLICATION_REQUIRED', remediation: { applicationPath: { mode: 'select_among_pending', candidates: ['A', 'B'] } } }).candidates) === J(['A', 'B']));
  ck('PENDING_APPROVAL → pending; REFUSED → refused/intake; REMEDIATION_WITHHELD → withheld/no CTA; found:false → buyer/optional intake; AVAILABLE with route → approved/route; unreadable', D({ state: 'PENDING_APPROVAL', reason: 'NOT_APPROVED', remediation: { applicationPath: { mode: 'continue_existing' }, agreement: { required: true, satisfied: true } } }).view === 'pending' && D({ state: 'REFUSED' }).cta === 'intake' && D({ state: 'REMEDIATION_WITHHELD' }).cta === null && D({ found: false }).optional === true && D({ state: 'AVAILABLE', route: 'provider-dashboard.html' }).route === 'provider-dashboard.html' && D(null).view === 'unreadable');

  /* fixtures: six accounts */
  await db.doc('providers/dj').set({ name: 'DJ Bvmbxno', status: 'active', searchable: true }); await db.doc('users/dj').set({ roles: ['provider', 'buyer'] });
  await db.doc('providers/kas').set({ name: 'Kasindi', status: 'active', approvedAt: '2026-07-30T15:13:13Z' });
  await db.doc('applications/PRVMS7IACKG').set({ uid: 'kas', role: 'provider', status: 'approved', decidedBy: 'reindex', decidedAt: '2026-07-30T15:11:12Z' });
  await db.doc('providers/hc').set({ name: 'Heights', status: 'pending' }); for (const id of ['A1', 'B2', 'C3']) await db.doc('applications/' + id).set({ uid: 'hc', role: 'provider', status: 'pending' });
  await db.doc('providers/kb').set({ name: 'King Bruce', status: 'suspended', approvalDecision: { decision: 'refuse', decidedBy: 'admin_D5', source: 'admin_decision' } });
  await db.doc('providers/ok').set({ name: 'Plumb Co', status: 'active', approvedAt: '2026-09-01T09:00:00Z', business: { category: 'trades', source: 'application', lane: { hub: 'provider', entClass: null } } }); await AF.seedApproved(db, 'ok', 'provider');
  await db.doc('users/buyer').set({ roles: ['buyer'] });
  /* the live dashboard boots through providerGetProfile (REAL handler from the same functions dir) and needs providerProfiles docs */
  const PO = require(Path.join(FN, 'provider-onboarding.js'))._h;
  for (const u of ['dj', 'ok', 'kb']) await db.doc('providerProfiles/' + u).set({ uid: u, providerId: 'PRV' + u.toUpperCase(), name: u, status: 'active', category: 'x' });
  /* the whole REAL dispatcher surface from the same functions dir (onboarding + ops handlers), so the live dashboard's boot calls
     are answered by the code production runs rather than by harness 'unknown op' errors; businessWorkspace last so it wins */
  const OPS = (() => { try { return require(Path.join(FN, 'provider-ops.js'))._h || {}; } catch (e) { return {}; } })();
  const H = makePageHarness({ db, root: ROOT, callables: { providerDispatch: Object.assign({}, PO, OPS, { businessWorkspace: BW._h.businessWorkspace }) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  /* the harness performs no client writes; the seam RECORDS the withdrawal the page asks for (the rules suite proves the applicant may write status 'withdrawn'), the test applies it to the store and asks the page to reload */
  const seam = "window.__withdrawn = []; window.SokoniCompleteApplicationDeps = { withdraw: (id) => { window.__withdrawn.push(id); return Promise.resolve(); } };";
  const open = async (uid, w, claims) => { const page = await H.page(browser, { user: uid ? { uid, claims: claims || {} } : null, viewport: { width: w || 390, height: 800 } }); await page.addInitScript(seam); await page.goto(H.BASE + '/complete-application.html'); return page; };
  const view = (page) => page.waitForFunction(() => { const s = document.getElementById('caHost').getAttribute('data-ca-state'); return s && !['boot', 'loading'].includes(s); }, null, { timeout: 15000 }).then(() => page.getAttribute('#caHost', 'data-ca-state'));
  try {
    say('\n── six accounts through the REAL handler ──');
    let page = await open('dj'); ck('DJ (status only) → fresh view, "Start your application" CTA, ws-state REAPPLICATION_REQUIRED', (await view(page)) === 'fresh' && (await page.$('[data-ca-intake]')) !== null && (await page.getAttribute('#caHost', 'data-ws-state')) === 'REAPPLICATION_REQUIRED');
    ck('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.click('[data-ca-intake]'); await page.waitForSelector('#sokoniRegOverlay.open', { timeout: 10000 }).catch(() => {});
    ck('the CTA opens the EXISTING intake modal (HubRegister #sokoniRegOverlay.open) — no parallel form', (await page.$('#sokoniRegOverlay.open')) !== null);
    await page.close();
    page = await open('kas'); ck('Kasindi shape → acknowledge view with a link to /agreement-acknowledge', (await view(page)) === 'acknowledge' && (await page.getAttribute('[data-ca-acknowledge]', 'href')) === '/agreement-acknowledge'); await page.close();
    page = await open('hc'); ck('Heights shape → select view listing all three candidates, none pre-chosen', (await view(page)) === 'select' && (await page.$$('[data-ca-candidate]')).length === 3 && (await page.$$('[data-ca-withdraw]')).length === 3);
    await page.click('[data-ca-withdraw="B2"]');
    await page.waitForFunction(() => (window.__withdrawn || []).length === 1, null, { timeout: 10000 });
    ck('Withdraw asks to write ONE id (B2) — never A1 or C3', J(await page.evaluate(() => window.__withdrawn)) === J(['B2']));
    await db.doc('applications/B2').set({ status: 'withdrawn', withdrawnAt: new Date().toISOString(), withdrawnBy: 'applicant' }, { merge: true });
    await page.evaluate(() => window.__caMounted.reload());
    await page.waitForFunction(() => document.querySelectorAll('[data-ca-candidate]').length === 2, null, { timeout: 10000 }).catch(() => {});
    ck('the server now reads the withdrawal from the raw status: A1 and C3 remain pending and undecided', (await db.doc('applications/A1').get()).data().status === 'pending' && (await db.doc('applications/C3').get()).data().status === 'pending');
    ck('after the reload the select view shows the two remaining candidates', (await page.$$('[data-ca-candidate]')).length === 2);
    await page.close();
    page = await open('kb', 1280); ck('King Bruce shape → refused view with "Submit a new application"', (await view(page)) === 'refused' && /Submit a new application/.test(await page.textContent('[data-ca-intake]'))); await page.close();
    page = await open('ok', 1280); ck('valid provider → approved view, link to provider-dashboard.html', (await view(page)) === 'approved' && (await page.getAttribute('[data-ca-route]', 'href')) === '/provider-dashboard.html'); await page.close();
    page = await open('buyer', 1280); ck('buyer → buyer view, intake optional ("Register a business"), nothing to complete', (await view(page)) === 'buyer' && /Register a business/.test(await page.textContent('[data-ca-intake]'))); await page.close();
    say('\n── the provider dashboard itself (consumer) ──');
    const fsx = require('fs'); const dashPath = Path.join(ROOT, 'provider-dashboard.html');
    if (fsx.existsSync(dashPath) && /sokoni-business-workspace\.js/.test(fsx.readFileSync(dashPath, 'utf8'))) {
      page = await open('dj', 1280, { provider: true }); await page.goto(H.BASE + '/provider-dashboard.html');
      await page.waitForFunction(() => /complete-application/.test(location.pathname) || document.documentElement.getAttribute('data-ws-state'), null, { timeout: 15000 }).catch(() => {});
      ck('provider-dashboard.html for a REAPPLICATION_REQUIRED account → redirected to /complete-application by the consumer', /complete-application/.test(await page.evaluate(() => location.pathname)), await page.evaluate(() => location.pathname)); await page.close();
      page = await open('ok', 1280, { provider: true }); await page.goto(H.BASE + '/provider-dashboard.html');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-ws-state'), null, { timeout: 15000 }).catch(() => {});
      ck('provider-dashboard.html for a VALID account stays on the dashboard, data-ws-state AVAILABLE', !/complete-application/.test(await page.evaluate(() => location.pathname)) && (await page.getAttribute('html', 'data-ws-state')) === 'AVAILABLE', await page.getAttribute('html', 'data-ws-state')); await page.close();
      page = await open('kb', 1280, { provider: true }); await page.goto(H.BASE + '/provider-dashboard.html');
      await page.waitForFunction(() => document.getElementById('hcWorkspace'), null, { timeout: 15000 }).catch(() => {});
      ck('provider-dashboard.html for a REFUSED account stays and shows the server explanation in a notice box', /did not approve/.test((await page.textContent('#hcWorkspace').catch(() => '')) || '')); await page.close();
    } else say('  n/a   provider-dashboard.html does not load the consumer in this tree');
    say('\n── signed out ──');
    page = await open(null, 1280); await page.waitForSelector('#caHost[data-ca-state="signed_out"]', { timeout: 15000 }); ck('signed out → sign-in note', (await page.$('[data-ca-signed-out]')) !== null); await page.close();
    ck('no adminAudit, no provider change, no wallet created by any of the above', db._dump('adminAudit/').length === 0 && db._dump('wallets/').length === 0 && (await db.doc('providers/dj').get()).data().status === 'active');
  } finally { await browser.close(); await H.stop(); }
  say('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('SUITE CRASH ' + (e.stack || e)); process.exit(2); });
