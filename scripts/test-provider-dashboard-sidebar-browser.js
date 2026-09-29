/* test-provider-dashboard-sidebar-browser.js — the provider dashboard's sidebar in a REAL browser (CHANGELOG 235).
 *
 * Chromium loads the REAL provider-dashboard.html (+ sokoni-health-workspace.js) through scripts/lib/page-harness.js.
 * The REAL functions/healthcare-workspace.js answers `healthcareWorkspace` on the transactional fake Firestore; the
 * dashboard's own data call (providerDashboard) returns a minimal profile so the page can render — this suite
 * measures NAVIGATION and LAYOUT, not dashboard data. No network, no production.
 *
 * PROVES, at 360 · 390 · 414 · 768 · 1024 · 1280 · 1440 px, for a Healthcare facility AND a photographer:
 *   brand       the SOKONI mark (assets/logosokoni.png) actually LOADS, beside the provider's / facility's own name
 *   groups      Overview · Bookings · Business · Communication · Growth · Finance · Plan; Plan & Subscription reachable
 *   healthcare  Entertainment-only items hidden, the roster reads "Patients", the server's category label under the
 *               name; a photographer keeps every item
 *   desktop     the sidebar is on screen, nothing overflows horizontally
 *   phone       the sidebar is OFF screen until Menu opens it; the drawer holds EVERY item; choosing one navigates
 *               and closes the drawer; Escape closes it; nothing overflows horizontally
 *
 *   node scripts/test-provider-dashboard-sidebar-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-dashboard-sidebar';
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
stub('./subscription-core', { resolveSubscription: async () => ({ found: false }) });
const HW = require(Path.join(FN, 'healthcare-workspace.js'));
const BWS = require(Path.join(FN, 'business-workspace.js'));   /* CHANGELOG 241: the dashboard projects this */
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };

let _base = '';
const H_BASE = () => _base;
const NAMES = { hc1: 'Karen Health Centre', ph1: 'Lens & Light Studio' };
const providerDispatch = {
  healthcareWorkspace: HW._h.healthcareWorkspace,
  businessWorkspace: BWS._h.businessWorkspace,
  providerDashboard: async (req) => ({ profile: { name: NAMES[req.auth.uid], category: req.auth.uid === 'ph1' ? 'photographer' : 'Healthcare' }, subscription: { plan: 'free' }, bookings: [] }),
};

(async () => {
  await db.doc('providers/hc1').set({ name: NAMES.hc1, status: 'active', approvedAt: 1, healthcare: { category: 'facility', source: 'admin' } });
  await db.doc('providers/ph1').set({ name: NAMES.ph1, status: 'active', approvedAt: 1, category: 'photographer' });
  const H = makePageHarness({ db, root: ROOT, callables: { providerDispatch } });
  await H.start();
  _base = H.BASE;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];
  try {
    for (const uid of ['hc1', 'ph1']) {
      const hc = uid === 'hc1';
      say(`\n── ${hc ? 'Healthcare facility' : 'photographer'} ──`);
      for (const w of WIDTHS) {
        const page = await H.page(browser, { user: { uid, email: uid + '@x.test', displayName: NAMES[uid] }, viewport: { width: w, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
        await page.goto(H.BASE + '/provider-dashboard.html');
        await page.waitForFunction((n) => (document.getElementById('sbName') || {}).textContent === n, NAMES[uid], { timeout: 15000 }).catch(() => {});
        if (hc) await page.waitForFunction(() => document.documentElement.hasAttribute('data-hc-workspace'), null, { timeout: 15000 }).catch(() => {});
        const phone = w <= 768;
        if (w === 390 || w === 1280) {   /* after the splash has finished */
          await page.waitForTimeout(3000);
          await page.screenshot({ path: Path.join(process.env.SHOT_DIR || require('os').tmpdir(), `sidebar-${uid}-${w}.png`) }).catch(() => {});
        }
        const tag = `${w}px`;
        const S = await page.evaluate(() => {
          const sb = document.getElementById('sidebar'); const r = sb.getBoundingClientRect();
          const img = document.querySelector('.sb-mark');
          const vis = (el) => !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
          const items = [...document.querySelectorAll('#sidebar .sb-item')];
          return {
            name: document.getElementById('sbName').textContent, kind: document.getElementById('sbKind').textContent,
            logo: !!(img && img.complete && img.naturalWidth > 0 && img.getAttribute('src') === 'assets/logosokoni.png'),
            left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
            groups: [...document.querySelectorAll('.sb-group')].filter(vis).map((g) => g.getAttribute('aria-label')),
            visibleKeys: items.filter(vis).map((i) => i.getAttribute('data-hc-section')),
            total: items.length,
            patients: [...document.querySelectorAll('[data-hc-label="customers"]')].map((e) => e.textContent),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        const base = S.logo && S.name === NAMES[uid] && S.overflow <= 1;
        ck(`${tag}: the SOKONI mark loads beside "${NAMES[uid]}", no horizontal overflow`, base, { logo: S.logo, name: S.name, overflow: S.overflow });
        if (hc) {
          ck(`${tag}: Healthcare — Entertainment items hidden, "Patients", the server's category label, Plan reachable`,
            !['quotes', 'bookingPin', 'calls', 'bookedHours'].some((k) => S.visibleKeys.includes(k)) && S.patients.every((t) => t === 'Patients') && /Clinic \/ Hospital \/ Facility/.test(S.kind) && S.visibleKeys.includes('subscription') && S.groups.includes('Plan'), { kind: S.kind, keys: S.visibleKeys.length, groups: S.groups });
        } else {
          /* ph1 has no business stamp → LEGACY (grandfathered): every implemented module, except Content (not a creator) */
          ck(`${tag}: photographer (legacy) — every item except Content, every group present`, S.visibleKeys.length === S.total - 1 && !S.visibleKeys.includes('content') && S.groups.join() === 'Overview,Storefront,Bookings,Business,Communication,Growth,Finance,Plan', { keys: S.visibleKeys.length, total: S.total, groups: S.groups });
        }
        if (!phone) {
          ck(`${tag}: desktop — the sidebar is on screen`, S.left >= 0 && S.width >= 200);
          ck(`${tag}: desktop — the phone bottom bar stays hidden`, !(await page.isVisible('.bn')));
          if (w === 1280) {
            const href = await page.getAttribute('#sbStoreView', 'href');
            ck(`${tag}: View storefront opens the provider's OWN public page`, href === 'provider-profile.html?uid=' + uid, href);
            await page.evaluate(() => { try { delete navigator.share; } catch (_) {} Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
            const shareSel = '#sidebar .sb-item[onclick="Store.share()"]';
            const shareVisible = await page.isVisible(shareSel);
            ck(`${tag}: the Share storefront control is visible`, shareVisible);
            if (shareVisible) await page.click(shareSel);   /* a FAIL, never a crash */
            await page.waitForTimeout(300);
            const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
            const toastTxt = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
            ck(`${tag}: Share copies the storefront link, then says so`, clip === H_BASE() + '/provider-profile.html?uid=' + uid && /copied/i.test(toastTxt), { clip, toastTxt });
            await page.click('#sbCollapse');
            await page.waitForTimeout(300);
            const R = await page.evaluate(() => ({ w: Math.round(document.getElementById('sidebar').getBoundingClientRect().width), pressed: document.getElementById('sbCollapse').getAttribute('aria-pressed'),
              titled: [...document.querySelectorAll('#sidebar .sb-item')].every((i) => i.title && i.title.length > 1), patientsTip: (document.querySelector('[data-hc-label="customers"]').closest('.sb-item') || {}).title }));
            ck(`${tag}: the sidebar collapses to an icon rail (merchant-v2 pattern), every icon keeps a tooltip`, R.w <= 80 && R.pressed === 'true' && R.titled && (!hc || R.patientsTip === 'Patients'), R);
            await page.reload();
            await page.waitForFunction((n) => (document.getElementById('sbName') || {}).textContent === n, NAMES[uid], { timeout: 15000 }).catch(() => {});
            const kept = await page.evaluate(() => document.body.classList.contains('sb-collapsed'));
            await page.click('#sbCollapse'); await page.waitForTimeout(300);
            const back = await page.evaluate(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width));
            ck(`${tag}: the rail is remembered across a reload, and expands again`, kept && back >= 200, { kept, back });
          }
        } else {
          ck(`${tag}: phone — the sidebar is OFF screen until Menu is pressed`, S.right <= 0, S);
          const menuVisible = await page.isVisible('#bnMenu');
          ck(`${tag}: phone — the bottom bar and its Menu button are visible`, menuVisible);
          if (!menuVisible) { await page.context().close(); continue; }   /* a FAIL, never a crash */
          await page.click('#bnMenu');
          /* wait for the slide to SETTLE (a fixed sleep read it mid-transition at 768px) */
          await page.waitForFunction(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().left) === 0, null, { timeout: 3000 }).catch(() => {});
          if (w === 390) await page.screenshot({ path: Path.join(process.env.SHOT_DIR || require('os').tmpdir(), `sidebar-${uid}-${w}-open.png`) }).catch(() => {});
          const O = await page.evaluate(() => {
            const r = document.getElementById('sidebar').getBoundingClientRect();
            const vis = (el) => !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
            return { left: Math.round(r.left), width: Math.round(r.width), expanded: document.getElementById('bnMenu').getAttribute('aria-expanded'),
              reachable: [...document.querySelectorAll('#sidebar .sb-item')].filter(vis).length, overflow: document.documentElement.scrollWidth - window.innerWidth };
          });
          ck(`${tag}: Menu opens the drawer on screen, within the viewport, aria-expanded=true, holding every visible item`,
            O.left === 0 && O.width <= w && O.expanded === 'true' && O.reachable === S.visibleKeys.length && O.overflow <= 1, O);
          await page.click('#sidebar .sb-item[onclick="P.show(\'bookings\',this)"]');
          await page.waitForTimeout(350);
          const N = await page.evaluate(() => ({ open: document.body.classList.contains('nav-open'), bookings: document.getElementById('panel-bookings').classList.contains('active') }));
          ck(`${tag}: choosing Bookings navigates AND closes the drawer`, N.bookings && !N.open, N);
          await page.click('#bnMenu'); await page.waitForTimeout(250);
          await page.keyboard.press('Escape'); await page.waitForTimeout(300);
          ck(`${tag}: Escape closes the drawer`, !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
        }
        await page.context().close();
      }
    }
  } finally { await browser.close(); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
