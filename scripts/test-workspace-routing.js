/* test-workspace-routing.js — ONE route to every workspace (CHANGELOG 240, convergence C2c).
 * Transactional fake Firestore + the REAL functions/business-workspace.js (homeFor, workspaceHome op); the REAL
 * route sources read as text; the REAL workspace.html in Chromium (scripts/lib/page-harness.js). No network.
 *
 * PROVES
 *   homes       an approved provider → its workspace route; a shop owner → merchant-v2 (several → choose-shop); an
 *               approved driver → driver.html; an organiser → event-manager; an ACTIVE creator → creator-studio; an
 *               ACTIVE venue → venue-manager; several at once → all of them; nothing → "apply"
 *   never       a self-selected onboarding role (accounts.currentRole) and a pending venue give NO home; a hotel (owner
 *               2026-09-28) goes to the provider dashboard with its accommodation profile
 *   one map     every route source — profile switcher, onboarding.html, profile.js, shared-header, the server's
 *               DASHBOARD_MAP, the approval notification — sends business roles to workspace.html; none of them names
 *               a page that does not exist; the dead my-bookings.html links are gone
 *   browser     workspace.html follows ONE home straight there, offers a chooser for several, "Register my business"
 *               for none, the message for an unrouted category, sign-in when signed out — and never follows a route
 *               that is not a same-site page the server named
 *
 *   node scripts/test-workspace-routing.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-workspace-routing';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs');
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
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const R = (f) => fs.readFileSync(Path.join(ROOT, f), 'utf8');
const biz = (category) => ({ status: 'active', approvedAt: 1, business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } });
const routes = (h) => h.homes.map((x) => x.route).join(',');

(async () => {
  say('\n── homes, from server facts only ──');
  await db.doc('providers/plumber').set(Object.assign({ name: 'Plumb Co' }, biz('trades')));
  await db.doc('providers/hotel1').set(Object.assign({ name: 'Lake Hotel' }, biz('hotel')));
  await db.doc('providers/unc1').set(Object.assign({ name: 'Mixed' }, biz(null)));
  /* shell gate: a shop home routes only for a validly approved account — seed the seller decisions the producer would have made */
  for (const u of ['shop1', 'shop2', 'multi']) await AF.seedApproved(db, u, 'seller');
  await db.doc('shops/S1').set({ ownerId: 'shop1', name: 'Mama Mboga', status: 'active' });
  await db.doc('shops/S2').set({ ownerId: 'shop2', name: 'A', status: 'active' });
  await db.doc('shops/S3').set({ ownerId: 'shop2', name: 'B', status: 'active' });
  await db.doc('creators/cr1').set({ state: 'ACTIVE' });
  await db.doc('creators/cr2').set({ state: 'PENDING' });
  await db.doc('venues/V1').set({ ownerId: 'ven1', status: 'active' });
  await db.doc('venues/V2').set({ ownerId: 'ven2', status: 'pending' });
  await db.doc('providers/multi').set(Object.assign({ name: 'Both' }, biz('it_services')));
  await db.doc('shops/S4').set({ ownerId: 'multi', name: 'Multi Shop', status: 'active' });
  await db.doc('accounts/selfpick').set({ currentRole: 'hotel', roles: ['hotel', 'healthcare'] });
  const H = async (uid, tok) => BW.homeFor(db, uid, tok);
  ck('plumber → provider-dashboard.html', routes(await H('plumber')) === 'provider-dashboard.html');
  ck('one shop → merchant-v2.html; two shops → choose-shop.html', routes(await H('shop1')) === 'merchant-v2.html' && routes(await H('shop2')) === 'choose-shop.html');
  ck('an approved driver (rider claim) → driver.html; an organiser → event-manager.html', routes(await H('drv1', { rider: true })) === 'driver.html' && routes(await H('org1', { event_organizer: true })) === 'event-manager.html');
  ck('an ACTIVE creator → creator-studio.html; a PENDING one → nothing', routes(await H('cr1')) === 'creator-studio.html' && (await H('cr2')).apply === true);
  ck('an ACTIVE venue → venue-manager.html; a PENDING venue → nothing', routes(await H('ven1')) === 'venue-manager.html' && (await H('ven2')).apply === true);
  const m = await H('multi', { rider: true });
  ck('several workspaces → all of them (business, shop, driver)', routes(m) === 'provider-dashboard.html,merchant-v2.html,driver.html', routes(m));
  const hot = await H('hotel1');
  ck('a hotel → the provider dashboard (accommodation profile, owner 2026-09-28)', hot.homes.length === 1 && hot.homes[0].route === 'provider-dashboard.html', hot.homes);
  const u = await H('unc1');
  ck('UNCLASSIFIED → the workspace shell with the "confirming your business" message', u.homes[0] && /confirming/.test(u.homes[0].message || ''));
  ck('a SELF-SELECTED onboarding role gives NO home ("apply")', (await H('selfpick')).apply === true && (await H('selfpick')).homes.length === 0);
  ck('nobody → apply', (await H('nobody')).apply === true);
  ck('the op refuses the signed-out and answers for the caller only',
    await BW._h.workspaceHome({ auth: null, data: {} }).then(() => 'ok', (e) => e.code) === 'unauthenticated'
    && routes(await BW._h.workspaceHome({ auth: { uid: 'plumber', token: {} }, data: { uid: 'shop1' } })) === 'provider-dashboard.html');

  say('\n── ONE map: every route source → workspace.html ──');
  const sw = R('sokoni-profile-switcher.js');
  ck('profile switcher: business roles → workspace.html', /const DASH = new Proxy\(\{ buyer: 'index\.html' \}, \{ get: \(t, k\) => \(k === 'buyer' \? 'index\.html' : 'workspace\.html'\) \}\);/.test(sw));
  ck('onboarding.html ready screen: business roles → workspace.html', /const dash=new Proxy\(\{buyer:'index\.html'\},\{get:\(t,k\)=>k==='buyer'\?'index\.html':'workspace\.html'\}\);/.test(R('onboarding.html')));
  const pj = R('profile.js'); const roleBlock = (pj.match(/roleDefinitions = \{[\s\S]*?\n    \};/) || [''])[0];
  const dashes = [...roleBlock.matchAll(/dash: "([^"]+)"/g)].map((x) => x[1]);
  ck('profile.js role cards: every business role → workspace.html', dashes.length >= 6 && dashes.every((d) => d === 'workspace.html' || d === 'index.html'), dashes);
  ck('shared-header role menu: seller / provider / driver → workspace.html', /seller:\s+'workspace\.html',\n\s+provider: 'workspace\.html',\n\s+driver:\s+'workspace\.html'/.test(R('shared-header.js')));
  ck('the server DASHBOARD_MAP (onboarding ops) → workspace.html for every business role', /const DASHBOARD_MAP = new Proxy\(\{ buyer: 'index\.html' \}/.test(R('functions/universal-onboarding.js')));
  ck('the approval notification links to workspace.html', /const _dash = 'workspace\.html';/.test(R('functions/application-lifecycle.js')));
  ck('the dead my-bookings.html links are gone', !/my-bookings\.html/.test(R('functions/provider-ops.js')) && fs.existsSync(Path.join(ROOT, 'profile.html')));
  const srcs = ['sokoni-profile-switcher.js', 'onboarding.html', 'profile.js', 'shared-header.js', 'functions/universal-onboarding.js', 'functions/business-workspace.js'];
  const missing = [];
  for (const f of srcs) {
    const txt = R(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const mm of txt.matchAll(/['"]([a-z0-9-]+-dashboard\.html|workspace\.html|merchant-v2\.html|choose-shop\.html|driver\.html|event-manager\.html|creator-studio\.html|venue-manager\.html|provider-dashboard\.html)['"]/g)) {
      if (!fs.existsSync(Path.join(ROOT, mm[1]))) missing.push(f + ' → ' + mm[1]);
    }
  }
  ck('no route source names a page that does not exist', missing.length === 0, missing);
  ck('workspace.html self-updates, shows the SOKONI mark, and only follows same-site pages', /<script src="\/sw-register\.js" defer><\/script>/.test(R('workspace.html')) && /assets\/logosokoni\.png/.test(R('workspace.html')) && /\^\[a-z0-9-\]\+\\\.html\$/.test(R('workspace.html')));

  say('\n── workspace.html in a real browser ──');
  let EVIL = false;
  const H2 = makePageHarness({ db, root: ROOT, callables: { providerDispatch: { workspaceHome: async (req) => (EVIL ? { homes: [{ label: 'Evil', route: 'https://evil.example/x.html' }, { label: 'Also evil', route: 'javascript:alert(1)' }] } : BW._h.workspaceHome(req)) } } });
  await H2.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    for (const w of [390, 1280]) {
      const open = async (uid, claims) => { const p = await H2.page(browser, { user: uid ? { uid, claims: claims || {} } : null, viewport: { width: w, height: 860 } }); await p.goto(H2.BASE + '/workspace.html'); return p; };
      /* record the navigation workspace.html makes (provider-dashboard.html itself may move on — e.g. to onboarding
         when this harness supplies no profile — which is that page's business, not the resolver's) */
      let p = await H2.page(browser, { user: { uid: 'plumber', claims: {} }, viewport: { width: w, height: 860 } });
      const navs = []; p.on('framenavigated', (fr) => { if (fr === p.mainFrame()) navs.push(new URL(fr.url()).pathname); });
      await p.goto(H2.BASE + '/workspace.html');
      await p.waitForFunction(() => !/workspace\.html/.test(location.pathname), null, { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      ck(`${w}: ONE home → straight there (the resolver navigates to /provider-dashboard.html)`, navs[0] === '/workspace.html' && navs.includes('/provider-dashboard.html'), navs);
      await p.context().close();
      p = await open('multi', { rider: true });
      await p.waitForSelector('#stChoose.active', { timeout: 8000 }).catch(() => {});
      const links = await p.$$eval('#wsList a', (a) => a.map((x) => x.getAttribute('href')));
      ck(`${w}: several → a chooser with each workspace`, links.join(',') === '/provider-dashboard.html,/merchant-v2.html,/driver.html', links);
      ck(`${w}: no horizontal overflow`, await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1));
      await p.context().close();
      p = await open('nobody');
      await p.waitForSelector('#stApply.active', { timeout: 8000 }).catch(() => {});
      ck(`${w}: nothing approved → "Register my business"`, await p.isVisible('#stApply a[href="onboarding.html"]'));
      await p.context().close();
      /* a hotel has ONE home now (owner 2026-09-28: accommodation profile) → the resolver goes straight there */
      p = await H2.page(browser, { user: { uid: 'hotel1', claims: {} }, viewport: { width: w, height: 860 } });
      const hnavs = []; p.on('framenavigated', (fr) => { if (fr === p.mainFrame()) hnavs.push(new URL(fr.url()).pathname); });
      await p.goto(H2.BASE + '/workspace.html');
      await p.waitForFunction(() => !/workspace\.html/.test(location.pathname), null, { timeout: 8000 }).catch(() => {});
      await p.waitForTimeout(300);
      ck(`${w}: a hotel → straight to the provider dashboard`, hnavs[0] === '/workspace.html' && hnavs.includes('/provider-dashboard.html'), hnavs);
      await p.context().close();
      p = await open(null);
      await p.waitForSelector('#stSignin.active', { timeout: 8000 }).catch(() => {});
      ck(`${w}: signed out → sign in`, await p.isVisible('#stSignin'));
      await p.context().close();
    }
    EVIL = true;
    const p = await H2.page(browser, { user: { uid: 'plumber' }, viewport: { width: 1280, height: 860 } });
    await p.goto(H2.BASE + '/workspace.html');
    await p.waitForSelector('#stChoose.active', { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(500);
    ck('a route that is not a same-site page is NEVER followed or linked', /workspace\.html/.test(p.url()) && (await p.$$('#wsList a')).length === 0, p.url());
    await p.context().close();
  } finally { await browser.close(); H2.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
