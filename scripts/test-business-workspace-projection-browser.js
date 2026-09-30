/* test-business-workspace-projection-browser.js — the dashboard is a PROJECTION of the server (CHANGELOG 241, C2d).
 *
 * Chromium loads the REAL provider-dashboard.html (+ sokoni-business-workspace.js, sokoni-health-workspace.js) through
 * scripts/lib/page-harness.js; the REAL functions/business-workspace.js and healthcare-workspace.js answer on the
 * transactional fake Firestore. For each kind of business, the modules the sidebar SHOWS must be EXACTLY the modules
 * the server says are AVAILABLE — nothing more, nothing less. No network.
 *
 * Covers: plumber · doctor · salon · artist · artist who is an ACTIVE creator · lawyer · UNCLASSIFIED · LEGACY (pre-C1)
 * · SUSPENDED · hotel (accommodation profile: stays not built yet, a notice), at 1280 px, plus the plumber and the doctor at 390 px (the phone drawer shows the
 * same set). Empty sidebar groups disappear; pending / unclassified / suspended / unrouted businesses get their banner.
 *
 *   node scripts/test-business-workspace-projection-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-ws-projection';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp }), auth: () => ({}) });
const AF = require('./lib/approval-fixture'); AF.stubAdminAuth(stub); AF.autoApproveOnWrite(db); /* shell gate: approvedAt fixtures carry their admin decision */
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const BW = require(Path.join(FN, 'business-workspace.js'));
const HW = require(Path.join(FN, 'healthcare-workspace.js'));
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const biz = (category, extra) => Object.assign({ status: 'active', approvedAt: 1, business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } }, extra || {});
const CASES = [
  ['plumber', biz('trades'), 'Plumb Co'],
  ['doc1', { status: 'active', approvedAt: 1, healthcare: { category: 'clinician', source: 'admin' }, business: { category: 'clinician', source: 'admin', lane: { hub: 'healthcare', entClass: null } } }, 'Dr One'],
  ['salon1', biz('salon'), 'Cuts'],
  ['dj1', biz('artist_creator'), 'DJ One'],
  ['dj2', biz('artist_creator'), 'DJ Two'],
  ['lawyer1', biz('lawyer'), 'Advocate'],
  ['unc1', biz(null), 'Mixed Co'],
  ['legacy1', { status: 'active' }, 'Old Timer'],
  ['susp1', biz('trades', { status: 'suspended' }), 'Paused Co'],
  ['hotel1', biz('hotel'), 'Lake Hotel'],
];

(async () => {
  for (const [uid, doc, name] of CASES) await db.doc('providers/' + uid).set(Object.assign({ name }, doc));
  await db.doc('creators/dj2').set({ state: 'ACTIVE' });
  const H = makePageHarness({ db, root: ROOT, callables: { providerDispatch: {
    businessWorkspace: async (req) => { if (req.auth && req.auth.uid === 'broken') throw Object.assign(new Error('boom'), { code: 'unavailable' }); return BW._h.businessWorkspace(req); },
    healthcareWorkspace: HW._h.healthcareWorkspace,
    providerDashboard: async (req) => ({ profile: { name: (CASES.find((c) => c[0] === req.auth.uid) || [])[2] || 'P' }, subscription: { plan: 'free' }, bookings: [] }),
  } } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const [uid, , name] of CASES) {
      const widths = (uid === 'plumber' || uid === 'doc1') ? [1280, 390] : [1280];
      const server = await BW.workspaceFor(db, uid);
      const expected = Object.keys(server.modules).filter((k) => server.modules[k].state === 'AVAILABLE');
      for (const w of widths) {
        const page = await H.page(browser, { user: { uid, email: uid + '@x.test', displayName: name }, viewport: { width: w, height: 900 } });
        await page.goto(H.BASE + '/provider-dashboard.html');
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-ws-state'), null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
        if (w <= 768) { await page.click('#bnMenu').catch(() => {}); await page.waitForTimeout(350); }
        const R = await page.evaluate(() => {
          const vis = (el) => !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
          const keys = [...new Set([...document.querySelectorAll('#sidebar [data-hc-section]')].filter(vis).map((e) => e.getAttribute('data-hc-section')))];
          const emptyVisibleGroups = [...document.querySelectorAll('#sidebar .sb-group')].filter((g) => vis(g) && ![...g.querySelectorAll('[data-hc-section]')].some(vis)).length;
          const box = document.getElementById('hcWorkspace');
          return { keys, emptyVisibleGroups, state: document.documentElement.getAttribute('data-ws-state'), banner: box && !box.hidden ? box.textContent : '' };
        });
        /* Sidebar keys the dashboard HAS (a module with no sidebar entry, e.g. staff/pos, is simply never shown) */
        const onPage = new Set(await page.evaluate(() => [...document.querySelectorAll('#sidebar [data-hc-section]')].map((e) => e.getAttribute('data-hc-section'))));
        const want = expected.filter((k) => onPage.has(k)).sort();
        const got = R.keys.slice().sort();
        ck(`${uid} @${w}: the sidebar shows EXACTLY the server's AVAILABLE modules`, JSON.stringify(got) === JSON.stringify(want), { extra: got.filter((k) => !want.includes(k)), missing: want.filter((k) => !got.includes(k)) });
        ck(`${uid} @${w}: no empty sidebar group is shown`, R.emptyVisibleGroups === 0);
        if (w === 1280 && ['unc1', 'susp1', 'hotel1'].includes(uid)) {
          const re = { unc1: /confirming what kind of business/, susp1: /suspended/, hotel1: /being built/ }[uid];
          ck(`${uid}: the banner explains the state (never an internal commercial term)`, re.test(R.banner) && !/COMMERCIAL|DECISION_REQUIRED/.test(R.banner), R.banner.slice(0, 120));
        }
        await page.context().close();
      }
    }
    /* a FAILED workspace call hides nothing that was visible and invents nothing: Content (hidden by default) stays
       hidden, the rest of the menu stays (the server gates still hold) */
    {
      await db.doc('providers/broken').set({ name: 'Broken', status: 'active', approvedAt: 1 });
      const page = await H.page(browser, { user: { uid: 'broken', email: 'b@x.test', displayName: 'Broken' }, viewport: { width: 1280, height: 900 } });
      await page.goto(H.BASE + '/provider-dashboard.html');
      await page.waitForTimeout(2500);
      const R = await page.evaluate(() => {
        const vis = (el) => !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
        const all = [...document.querySelectorAll('#sidebar [data-hc-section]')];
        return { total: all.length, visible: all.filter(vis).length, content: vis(document.querySelector('[data-hc-section="content"]')), state: document.documentElement.getAttribute('data-ws-state') };
      });
      ck('a FAILED workspace call: nothing invented (Content stays hidden), nothing else hidden (fallback), no state stamped', R.content === false && R.visible === R.total - 1 && R.state === null, R);
      await page.context().close();
    }
    /* spot-checks that the projection is meaningful, not just self-consistent */
    const w = async (u) => { const s = await BW.workspaceFor(db, u); return (k) => s.modules[k].state; };
    const plumber = await w('plumber'); const doc = await w('doc1'); const dj1 = await w('dj1'); const dj2 = await w('dj2');
    ck('meaningful: a plumber is offered quotes + calls; a doctor neither; only the ACTIVE creator gets Content',
      plumber('quotes') === 'AVAILABLE' && plumber('calls') === 'AVAILABLE' && doc('quotes') !== 'AVAILABLE' && doc('calls') !== 'AVAILABLE'
      && dj1('content') !== 'AVAILABLE' && dj2('content') === 'AVAILABLE');
  } finally { await browser.close(); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
