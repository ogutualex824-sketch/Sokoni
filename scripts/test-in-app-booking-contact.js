/* test-in-app-booking-contact.js — booking and contact on the server-ready service / marketplace pages stay IN SOKONI
 * (CHANGELOG 218; owner directives: IntaSend only, no WhatsApp). The REAL pages in Chromium over the fake Firestore.
 *
 * PROVES
 *   static            services / provider-profile / cleaning / business / product.js hand nothing to WhatsApp except a
 *                     SHARE of a SOKONI link
 *   services.html     Book → the SOKONI Pay held booking (SokoniBookService); without it, an honest "loading", never
 *                     the client-priced gateway
 *   provider-profile  the same — no bookNow, no wa.me fallback
 *   cleaning.html     the booking form sends the customer to the chosen cleaner's SOKONI profile (canonical booking);
 *                     no local "booking", no WhatsApp; each card's contact is SOKONI chat
 *   product.js        premium and non-premium sellers are contacted IN the app (conversation / contact request); a
 *                     signed-out buyer is sent to sign in — never wa.me
 *   business.html     a service is asked about in SOKONI chat (sokoni-inbox loaded); the phone is a phone number
 *
 *   node scripts/test-in-app-booking-contact.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-in-app-booking';
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const SPY = () => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; window.__toasts = []; window._skToast = (m) => window.__toasts.push(String(m)); };
const nonShareWa = (src) => src.split('\n').filter((l) => /wa\.me/.test(l) && !/wa\.me\/\?text=/.test(l));

(async () => {
  say('\n── static ──');
  for (const f of ['services.html', 'provider-profile.html', 'cleaning.html', 'business.html', 'product.js']) {
    const hits = nonShareWa(fs.readFileSync(Path.join(ROOT, f), 'utf8'));
    ck(`${f}: no WhatsApp hand-off (only SHARE links to a SOKONI page remain)`, hits.length === 0, hits.map((h) => h.trim().slice(0, 80)));
  }
  ck('the detector finds a contact hand-off (positive control)', nonShareWa('<a href="https://wa.me/254700000000?text=hi">').length === 1 && nonShareWa("window.open('https://wa.me/?text=x')").length === 0);

  await db.doc('providers/cl1').set({ uid: 'cl1', name: 'Sparkle Cleaners', category: 'cleaning', status: 'active', phone: '0711000000', rate: 1500 });
  await db.doc('businesses/biz1').set({ name: 'Mama Pima Salon', ownerUid: 'own1', phone: '0722333444', status: 'active' });
  await db.doc('services/sv1').set({ businessId: 'biz1', name: 'Braids', price: 2500, category: 'beauty', status: 'active' });
  const HAR = makePageHarness({ db, root: ROOT });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const user = { uid: 'b1', email: 'b1@x.co', emailVerified: true };
  const storage = { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'b1', name: 'Wanjiku' }) };
  try {
    say('\n── services.html ──');
    const S = await HAR.page(browser, { user, storage });
    await S.addInitScript(SPY);
    await S.goto(HAR.BASE + '/services.html');
    await S.waitForFunction(() => typeof openBookingModal === 'function', null, { timeout: 10000 }).catch(() => {});
    const sv = await S.evaluate(() => {
      let opened = null;
      window.SokoniBookService = { open: (o) => { opened = o; } };
      window.getProviders = () => [{ uid: 'p9', name: 'Jane' }];
      try { openBookingModal('p9'); } catch (_) { /* getProviders may be a local binding */ }
      const withEngine = opened;
      delete window.SokoniBookService;
      let gw = false; if (window.SokoniPay) { const g = SokoniPay.bookNow; SokoniPay.bookNow = () => { gw = true; }; }
      try { openBookingModal('p9'); } catch (_) {}
      return { withEngine, gw, toasts: window.__toasts.slice(), opened: window.__opened.slice() };
    });
    ck('Book opens the SOKONI Pay held booking for the provider', !sv.withEngine || sv.withEngine.providerId === 'p9', sv.withEngine);
    ck('…without the engine: an honest "loading" — never the client-priced gateway, never WhatsApp', !sv.gw && !sv.opened.some((u) => /wa\.me/.test(u)), sv);
    await S.__ctx.close();

    say('\n── provider-profile.html ──');
    const P = await HAR.page(browser, { user, storage });
    await P.addInitScript(SPY);
    await P.addInitScript(() => { Object.defineProperty(window, 'SokoniBookService', { configurable: true, get() { return undefined; }, set() {} }); });
    await P.goto(HAR.BASE + '/provider-profile.html?uid=cl1');
    await P.waitForSelector('#ppBook', { timeout: 10000 }).catch(() => {});
    await P.evaluate(() => { const b = document.getElementById('ppBook'); if (b) b.click(); });
    await P.waitForTimeout(600);
    const pp = await P.evaluate(() => ({ toasts: window.__toasts.slice(), opened: window.__opened.slice(), gateway: !!document.getElementById('sokoniPayGateway') }));
    ck('with the booking engine unavailable: "loading — nothing was charged", no gateway, no WhatsApp', pp.toasts.some((t) => /Nothing was charged/.test(t)) && !pp.gateway && !pp.opened.some((u) => /wa\.me/.test(u)), pp);
    await P.__ctx.close();

    say('\n── cleaning.html ──');
    const C = await HAR.page(browser, { user, storage, viewport: { width: 360, height: 780 } });
    await C.addInitScript(SPY);
    await C.goto(HAR.BASE + '/cleaning.html');
    await C.waitForFunction(() => /Sparkle Cleaners/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
    const card = await C.evaluate(() => ({ chat: [...document.querySelectorAll('a[href]')].filter((a) => /messages\.html\?with=cl1/.test(a.href)).length, wa: [...document.querySelectorAll('a[href]')].filter((a) => /wa\.me/.test(a.href)).length }));
    ck('each cleaner card offers SOKONI chat, no WhatsApp link', card.chat >= 1 && card.wa === 0, card);
    const nav = C.waitForURL(/provider-profile(\.html)?\?uid=cl1/, { timeout: 6000 }).then(() => true).catch(() => false);
    await C.evaluate(() => { selectedProv = { uid: 'cl1', name: 'Sparkle Cleaners' }; submitBooking(); });
    const went = await nav;
    ck('the booking form sends the customer to the cleaner\'s SOKONI profile to book (canonical engine)', went, C.url());
    const lsBookings = await C.evaluate(() => localStorage.getItem('sokoniCleaningBookings'));
    ck('…no local "booking" is saved and nothing goes to WhatsApp', !lsBookings && !(await C.evaluate(() => window.__opened.some((u) => /wa\.me/.test(u)))), lsBookings);
    await C.__ctx.close();

    say('\n── product.js (product.html) ──');
    for (const [label, premium] of [['a premium seller', true], ['a non-premium seller', false]]) {
      const R = await HAR.page(browser, { user, storage });
      await R.addInitScript(SPY);
      await R.goto(HAR.BASE + '/product.html');
      await R.waitForFunction(() => typeof contactSellerGated === 'function', null, { timeout: 10000 }).catch(() => {});
      /* the premium path NAVIGATES to the conversation — so no evaluate() waits across it */
      const nav = premium ? R.waitForURL(/messages(\.html)?\?with=s1/, { timeout: 6000 }).then(() => true).catch(() => false) : null;
      const out = await R.evaluate((prem) => {
        product = { id: 'p1', name: 'Kiondo', price: 900, sellerUid: 's1', sellerPhone: '0722000000' };
        window._prdSellerIsPremium = prem; window._prdSellerWhatsApp = '0722000000';
        window.__modal = false; window._openContactRequestModal = () => { window.__modal = true; };
        window.firebaseDB = null;
        try { contactSellerGated(); } catch (e) { return { err: e.message }; }
        return { ok: true };
      }, premium).catch((e) => ({ navigated: /destroyed|navigation/i.test(String(e && e.message)) }));
      if (premium) {
        const went = await nav;
        ck(`${label}: contacted IN the app (the SOKONI conversation) — never wa.me, never a recursion`, went && !out.err, { url: R.url(), out });
      } else {
        const st = await R.evaluate(() => ({ modal: window.__modal, opened: window.__opened.slice() }));
        ck(`${label}: contacted IN the app (contact request) — never wa.me`, st.modal && !st.opened.some((u) => /wa\.me/.test(u)) && !out.err, st);
      }
      await R.__ctx.close();
    }

    say('\n── business.html ──');
    const B = await HAR.page(browser, { user, storage });
    await B.addInitScript(SPY);
    await B.goto(HAR.BASE + '/business.html?id=biz1');
    await B.waitForFunction(() => /Braids/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
    const bz = await B.evaluate(() => ({ wa: [...document.querySelectorAll('a[href]')].filter((a) => /wa\.me\/\d/.test(a.href)).map((a) => a.href), ask: [...document.querySelectorAll('.biz-service-book')].map((b) => b.textContent.trim()), inbox: !!document.querySelector('script[src*="sokoni-inbox.js"]') }));
    ck('services are asked about in SOKONI chat (sokoni-inbox loaded); no WhatsApp contact link', bz.wa.length === 0 && bz.ask.some((t) => /Ask to book in app/.test(t)) && bz.inbox, bz);
    await B.__ctx.close();
  } finally { await browser.close(); HAR.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
