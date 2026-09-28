/* test-product-shop-status-browser.js — product.html shows the SHOP's availability from the ONE evaluator
 * (availability A2, 2026-09-29), in a REAL browser on the REAL getShopAvailability.
 *
 * PROVES
 *   PS1 the product page's shop status is the evaluator's headline for that shop, right now
 *   PS2 a temporarily closed shop says so, and says ordering reopens when it opens (never implies "fulfil now")
 *   PS3 a shop that takes orders while closed says the order is prepared when it opens
 *   PS4 no invented seller response time is shown when the seller has none
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-product-shop-status';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const KS = require(Path.join(FN, 'kasshop.js'));
const H = require(Path.join(FN, 'shared', 'shop-hours.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  const S = 'sellps1';
  const HOURS = {}; ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((d) => { HOURS[d] = { closed: false, periods: [{ open: '00:00', close: '24:00' }] }; });
  HOURS.mon = { closed: false, periods: [{ open: '08:00', close: '13:00' }, { open: '14:00', close: '18:00' }] };
  await db.doc('shops/' + S).set({ sellerUid: S, name: 'Duka la Mama', status: 'active', location: 'Nairobi' });
  await db.doc('providerAvailability/' + S).set({ uid: S, hours: HOURS });
  await db.doc('products/p1').set({ name: 'Kitenge Dress', price: 2500, sellerUid: S, sellerName: 'Duka la Mama', status: 'active', stock: 5, isVisible: true, images: [] });
  const Hh = makePageHarness({ db, root: ROOT, callables: { getShopAvailability: run(KS.getShopAvailability) } });
  await Hh.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const statusText = async (p) => {
    await p.waitForFunction(() => { const e = document.getElementById('prdShopStatus'); return e && !e.hidden && e.textContent.trim(); }, null, { timeout: 15000 }).catch(() => {});
    return p.evaluate(() => { const e = document.getElementById('prdShopStatus'); return e && !e.hidden ? e.textContent.replace(/\s+/g, ' ').trim() : ''; });
  };
  try {
    const p = await Hh.page(browser, { viewport: { width: 390, height: 860 } });
    await p.goto(Hh.BASE + '/product.html?id=p1');
    let t = await statusText(p);
    const v1 = KS.verdictFor((await db.doc('shops/' + S).get()).data(), { hours: HOURS }, Date.now());
    const h1 = H.headline(v1);
    ck('PS1 the shop status is the evaluator\'s headline for this shop, right now', !!t && t.includes(h1.title), { t, want: h1.title });
    const rt = await p.evaluate(() => { const e = document.getElementById('prdSellerResponseTime'); return e ? e.style.display !== 'none' && e.textContent : null; });
    ck('PS4 no invented seller response time', !rt, rt);

    await db.doc('shops/' + S).set({ temporaryClosure: { active: true, until: Date.now() + 3600000, note: 'Stocktaking' }, ordersWhenClosed: true }, { merge: true });
    await p.reload(); t = await statusText(p);
    ck('PS2 temporarily closed: says so, and that ordering reopens when it opens', /Temporarily closed/.test(t) && /Ordering reopens when the shop opens/.test(t), t);

    await db.doc('shops/' + S).set({ temporaryClosure: F.FieldValue.delete(), availabilityMode: 'hours', acceptingOrders: true }, { merge: true });
    await db.doc('providerAvailability/' + S).set({ uid: S, hours: { mon: { closed: true, periods: [] }, tue: { closed: true, periods: [] }, wed: { closed: true, periods: [] }, thu: { closed: true, periods: [] }, fri: { closed: true, periods: [] }, sat: { closed: true, periods: [] }, sun: { closed: false, periods: [{ open: '09:00', close: '10:00' }] } } });
    await p.reload(); t = await statusText(p);
    const v3 = KS.verdictFor((await db.doc('shops/' + S).get()).data(), (await db.doc('providerAvailability/' + S).get()).data(), Date.now());
    ck('PS3 a closed shop that takes orders while closed: "prepared when the shop opens"', v3.open ? /Open|Closing/.test(t) : /prepared when the shop opens/.test(t) && t.includes(H.headline(v3).title), { t, v3: v3.status });
  } finally { await browser.close().catch(() => {}); Hh.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
