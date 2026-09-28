/* test-shop-availability-browser.js — merchant-v2 › Availability (the control centre) and the storefront's Hours &
 * Availability, in a REAL browser, on the REAL kasshop callables and the REAL getMinishopPublic (2026-09-29).
 *
 * Both pages must say what the ONE evaluator says. Expected words are computed HERE with the same evaluator at the
 * same moment, so the suite is correct at any time of day.
 *
 * PROVES
 *   V1  the control centre loads the saved state; its "how customers see you" hero is the evaluator's headline
 *   V2  a live switch (Taking orders) saves on the SERVER and the hero follows ("Not taking orders right now")
 *   V3  weekly hours with a break + a labelled holiday save through the server; a RELOAD shows them again
 *   V4  "Close for 1 hour" closes the shop on the server with the public note; "Reopen now" lifts it
 *   V5  a server refusal says NOT saved — never "updated"
 *   V6  the public storefront's badge AND its Hours & Availability section say the evaluator's words for the saved
 *       state (incl. the temporary closure note), with the week, and a special date
 *   V7  a cashier sees the control centre read-only (every control disabled)
 *   V8  no horizontal overflow at 360 px (control centre and storefront)
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-shop-availability-browser';
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
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });
const KS = require(Path.join(FN, 'kasshop.js'));
const MS = require(Path.join(FN, 'minishop.js'));
const H = require(Path.join(FN, 'shared', 'shop-hours.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1);
const expectHeadline = async (shopId) => { const st = await KS.publicShopState(shopId, shopId); return { hl: H.headline(st.availability), st }; };

const PAGE = (shopId) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--acc:#71ff00;--line:rgba(255,255,255,.09)}body{margin:0;padding:12px;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-shop-hours.js"></script>
<script src="/sokoni-merchant-availability.js"></script>
<script>
  const call = (n) => (d) => firebase.functions().httpsCallable(n)(d || {});
  function start() {
    if (!firebase.auth().currentUser) return setTimeout(start, 50);
    window.__ui = SokoniMerchantAvailability.mount(document.getElementById('host'), { shopId: ${shopId ? JSON.stringify(shopId) : 'null'},
      callGet: call('getShopAvailability'), callSave: call('setShopAvailability'), onToast: () => {} });
  }
  start();
</script></body></html>`;

(async () => {
  const U = 'own7';
  await db.doc('users/' + U).set({ name: 'Wanjiru' });
  await db.doc('shops/' + U).set({ sellerUid: U, ownerId: U, name: 'Wanjiru Salon', status: 'active', openingHours: 'Mon 08:00–18:00' });
  await db.doc('minishopConfig/' + U).set({ shopId: U, ownerUid: U, handle: 'wanjiru', schemaVersion: 2 });
  await db.doc('shopHandles/wanjiru').set({ shopId: U, ownerUid: U });
  await db.doc(`shopEmployees/${U}_cash7`).set({ shopId: U, uid: 'cash7', role: 'cashier', shopOwnerId: U, name: 'Cashier Seven', active: true });
  const CALLS = { getShopAvailability: run(KS.getShopAvailability), setShopAvailability: run(KS.setShopAvailability) };
  const Hh = makePageHarness({ db, root: ROOT, pages: { '/av-owner.html': PAGE(null), '/av-staff.html': PAGE(U) }, callables: CALLS,
    http: { getMinishopPublic: MS.getMinishopPublic, trackMinishopView: (req, res) => res.status(204).end() } });
  await Hh.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 140)); return false; } };
  const T = { timeout: 4000 };
  try {
    const p = await Hh.page(browser, { user: { uid: U, email: 'o@x.co', emailVerified: true }, viewport: { width: 360, height: 820 } });
    await p.goto(Hh.BASE + '/av-owner.html');
    await p.waitForSelector('.mav-hero', { timeout: 15000 }).catch(() => {});
    let e = await expectHeadline(U);
    ck('V1  the control centre loads; its hero is the evaluator\'s headline', (await p.textContent('.mav-hero').catch(() => '')).includes(e.hl.title), e.hl.title);

    await act('toggle taking orders off', async () => { await p.click('[data-av="live"][data-k="acceptingOrders"]', T); await p.waitForFunction(() => /updated/i.test(document.body.textContent), null, T); });
    const s1 = await get('shops/' + U);
    ck('V2  "Taking orders" saves on the server and the hero follows', s1.acceptingOrders === false && /Not taking orders right now/.test(await p.textContent('.mav-hero', { timeout: 4000 }).catch(() => '')), s1.acceptingOrders);
    await act('toggle taking orders on', async () => { await p.click('[data-av="live"][data-k="acceptingOrders"]', T); await p.waitForFunction(() => !document.querySelector('.mav-tog[data-k="acceptingOrders"][disabled]') && document.querySelector('.mav-tog[data-k="acceptingOrders"]').getAttribute('aria-checked') === 'true', null, T); });

    await act('weekly hours with a break + holiday', async () => {
      await p.click('[data-av="preset"][data-m="std"]', T);
      await p.fill('[data-avt="close"][data-d="mon"][data-i="0"]', '13:00', T);
      await p.click('[data-av="addp"][data-d="mon"]', T);
      await p.fill('[data-avt="open"][data-d="mon"][data-i="1"]', '14:00', T);
      await p.dispatchEvent('[data-avt="open"][data-d="mon"][data-i="1"]', 'change');
      const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      await p.fill('[data-avin="ovDate"]', d, T);
      await p.fill('[data-avin="ovLabel"]', 'Mashujaa Day', T);
      await p.click('[data-av="addov"]', T);
      await p.click('[data-av="save"]', T);
      await p.waitForFunction(() => /Availability updated/.test(document.body.textContent), null, { timeout: 8000 });
    });
    const pa = await get('providerAvailability/' + U), sh = await get('shops/' + U);
    await p.reload(); await p.waitForSelector('.mav-hero', { timeout: 15000 }).catch(() => {});
    const back = (await p.evaluate(() => window.__ui && window.__ui.state().saved)) || {};
    const ovKeys = Object.keys((pa && pa.overrides) || {});
    ck('V3  hours with a break + a labelled holiday save through the server; a reload shows them again',
      pa && pa.hours && pa.hours.mon.periods.length === 2 && pa.hours.mon.periods[0].close === '13:00' && pa.hours.mon.periods[1].open === '14:00'
      && typeof sh.openingHours === 'object' && ovKeys.length === 1 && pa.overrides[ovKeys[0]].label === 'Mashujaa Day'
      && back.hours && back.hours.mon.periods.length === 2 && Object.keys(back.overrides || {}).length === 1 && /Break 1:00 PM – 2:00 PM/.test(await p.textContent('.mav', { timeout: 4000 }).catch(() => '')),
      { mon: pa && pa.hours && pa.hours.mon, ov: pa && pa.overrides });

    await act('close for 1 hour with a note', async () => {
      await p.fill('[data-avin="tcNote"]', 'Back after a staff meeting', T);
      await p.click('[data-av="tc"][data-m="60"]', T);
      await p.waitForFunction(() => /closed temporarily/i.test(document.body.textContent), null, { timeout: 8000 });
    });
    const s4 = await get('shops/' + U);
    e = await expectHeadline(U);
    ck('V4a "Close for 1 hour" closes the shop on the server with the public note', s4.temporaryClosure && s4.temporaryClosure.note === 'Back after a staff meeting'
      && s4.temporaryClosure.until > Date.now() && e.st.availability.status === 'temporarily_closed' && /Temporarily closed/.test(await p.textContent('.mav-hero', { timeout: 4000 }).catch(() => '')), s4.temporaryClosure);

    /* the PUBLIC storefront, while temporarily closed */
    const sf = await Hh.page(browser, { viewport: { width: 360, height: 800 } });
    await sf.goto(Hh.BASE + '/minishop.html?handle=wanjiru');
    await sf.waitForFunction(() => { const b = document.getElementById('msOpenStatus'); return b && !b.hidden && b.textContent.trim(); }, null, { timeout: 12000 }).catch(() => {});
    const badge = await sf.textContent('#msOpenStatus').catch(() => '');
    const hoursTxt = await sf.textContent('#msHours').catch(() => '');
    const sfHidden = await sf.$eval('#msHours', (el) => el.hidden).catch(() => true);
    ck('V6  the storefront badge and Hours & Availability say the evaluator\'s words (temporary closure + note), with the week and the special date',
      badge.includes(e.hl.title) && (e.hl.detail ? badge.includes(e.hl.detail) : true) && !sfHidden && hoursTxt.includes('Hours & availability') && hoursTxt.includes(e.hl.title)
      && /Back after a staff meeting/.test(hoursTxt) && /Mon/.test(hoursTxt) && /Mashujaa Day/.test(hoursTxt), { badge, want: e.hl, hours: hoursTxt.slice(0, 200) });
    ck('V8a no horizontal overflow at 360 px (storefront)', await noOverflow(sf));

    await act('reopen now', async () => { await p.click('[data-av="reopen"]', T); await p.waitForFunction(() => /Shop reopened/.test(document.body.textContent), null, { timeout: 8000 }); });
    ck('V4b "Reopen now" lifts the closure on the server', !(await get('shops/' + U)).temporaryClosure && (await expectHeadline(U)).st.availability.status !== 'temporarily_closed');

    /* a refusal is never "updated" */
    const realSave = CALLS.setShopAvailability;
    CALLS.setShopAvailability = async () => { const er = new Error('Service unavailable'); er.code = 'unavailable'; throw er; };
    await act('refused toggle', async () => { await p.click('[data-av="live"][data-k="delivery"]', T); await p.waitForFunction(() => /NOT saved/.test(document.body.textContent), null, { timeout: 8000 }); });
    ck('V5  a server refusal says NOT saved — never "updated"', /NOT saved/.test(await p.textContent('.mav', { timeout: 4000 }).catch(() => '')) && (await get('shops/' + U)).delivery !== false);
    CALLS.setShopAvailability = realSave;
    ck('V8b no horizontal overflow at 360 px (control centre)', await noOverflow(p));

    const st = await Hh.page(browser, { user: { uid: 'cash7', email: 'c@x.co', emailVerified: true }, viewport: { width: 1280, height: 800 } });
    await st.goto(Hh.BASE + '/av-staff.html');
    await st.waitForSelector('.mav-hero', { timeout: 15000 }).catch(() => {});
    const enabled = await st.$$eval('.mav [data-av]:not([disabled]), .mav [data-avin]:not([disabled]), .mav [data-avt]:not([disabled])', (els) => els.map((x) => x.getAttribute('data-av') || x.getAttribute('data-avin') || x.getAttribute('data-avt')));
    ck('V7  a cashier sees it read-only (every control disabled)', /Only the owner or a manager/.test(await st.textContent('.mav').catch(() => '')) && enabled.filter((x) => x !== 'storefront').length === 0, enabled);
  } finally { await browser.close().catch(() => {}); Hh.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
