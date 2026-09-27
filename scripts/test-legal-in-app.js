/* test-legal-in-app.js — the Legal Hub books, registers and talks INSIDE SOKONI (CHANGELOG 219; owner directives:
 * IntaSend only, no WhatsApp). The REAL legal-hub.html in Chromium over the fake Firestore and the REAL
 * functions/legal-hub.js callables. No network, no production.
 *
 * PROVES
 *   static        no WhatsApp hand-off (only a SHARE of a document), no retired phone-number M-PESA rail, no
 *                 client-priced gateway, no client-written lead fee (positive control for the detector)
 *   auth          the page sees the signed-in user (window._sokoniUser was read 12× and set by NOTHING)
 *   directory     a verified advocate (getLegalProviders) renders, and Book opens the modal for them (the
 *                 modal used to search localStorage only) · Message is SOKONI chat with the advocate's uid
 *   booking       the request IS the server record (legalConsultations, status pending, the server's price
 *                 snapshot) · success only after the server has it, says no payment was taken, links SOKONI
 *                 chat · a retry is idempotent (one consultation) · an inactive advocate → "not booked" ·
 *                 signed out → sign in, nothing written · no WhatsApp, no invoice, no lead fee
 *   appointments  the server's consultations load; a confirmed one is messaged in SOKONI, never WhatsApp
 *   register      advocate: signed-in → legalProviders pending, success says pending (never "now live"); a
 *                 failed / signed-out submission shows no success · firm: success only once the queue save
 *                 resolved; a rejected save shows no success · no admin WhatsApp either way
 *   layout        no horizontal scroll at 360
 *
 *   node scripts/test-legal-in-app.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-legal-in-app';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);

const LG = require(Path.join(FN, 'legal-hub.js'));
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ _id: d.id }, d.data()));
const nonShareWa = (src) => src.split('\n').filter((l) => /wa\.me/.test(l) && !/wa\.me\/\?text=/.test(l) && !/a\[href\^="https:\/\/wa\.me"\]/.test(l));
const SPY = () => {
  window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
  window.__invoices = 0; Object.defineProperty(window, 'SokoniInvoice', { configurable: true, get() { return { generate() { window.__invoices++; } }; }, set() {} });
  window.__gateway = 0;
};
const run = (cf) => (req) => (cf.run || cf)(req);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

(async () => {
  say('\n── static ──');
  const SRC = fs.readFileSync(Path.join(ROOT, 'legal-hub.html'), 'utf8');
  const hits = nonShareWa(SRC);
  ck('legal-hub.html: no WhatsApp hand-off (only the document SHARE remains)', hits.length === 0, hits.map((h) => h.trim().slice(0, 90)));
  ck('the detector finds a hand-off (positive control)', nonShareWa('<a href="https://wa.me/254703480154?text=hi">').length === 1);
  ck('no retired phone-number M-PESA rail, no client-priced gateway, no client lead fee', !/SokoniMpesa\.pay|sokoni-mpesa\.js|SokoniPay\.bookNow\(|leadFees/.test(SRC));

  /* An ELIGIBLE advocate (CHANGELOG 220): SOKONI-approved + LSK-verified (current) + linked — the directory lists nothing less. */
  const LV = require(Path.join(FN, 'legal-verification.js'));
  await db.doc('legalProviders/law1').set({ providerId: 'law1', name: 'Wanjiru Kamau', firmName: 'Kamau & Co', specializations: ['family_law'], county: 'Nairobi', consultationFee: 3000, currency: 'KES', rating: 4.5, status: 'active', isOnline: true,
    verification: { admin: { status: 'approved' }, lsk: { status: 'verified', practiceStatus: 'Active', source: LV.SOURCES.OFFICIAL_SOURCE_MANUAL, checkedAtMs: Date.now() - 86400000, validUntilMs: LV.practisingYearEndMs(Date.now()) }, providerLink: { status: 'linked' } } });
  await db.doc('legalProviders/law2').set({ providerId: 'law2', name: 'Otieno Pending', specializations: ['other'], consultationFee: 2000, currency: 'KES', rating: 0, status: 'pending' });
  await db.doc('legalConsultations/lc_seed').set({ consultationId: 'lc_seed', clientUid: 'b1', providerId: 'law1', providerName: 'Wanjiru Kamau', specializations: ['family_law'], dateTime: new Date(Date.now() + 3 * 86400000).toISOString(), matter: 'Custody', status: 'confirmed' });

  const HAR = makePageHarness({ db, root: ROOT, callables: {
    getLegalProviders: run(LG.getLegalProviders), bookLegalConsultation: run(LG.bookLegalConsultation),
    getMyLegalConsultations: run(LG.getMyLegalConsultations), registerLegalProvider: run(LG.registerLegalProvider),
    getLegalProvider: run(LG.getLegalProvider),
  } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const user = { uid: 'b1', email: 'b1@x.co', emailVerified: true };
  const storage = { loggedIn: 'true', sokoniUser: JSON.stringify({ uid: 'b1', name: 'Achieng' }) };
  const open = async (u, extra) => {
    const p = await HAR.page(browser, Object.assign({ user: u, storage: u ? storage : {} }, extra || {}));
    await p.addInitScript(SPY);
    await p.goto(HAR.BASE + '/legal-hub.html');
    await p.waitForFunction(() => typeof confirmConsultation === 'function' && typeof _lhAuthReady === 'function', null, { timeout: 15000 }).catch(() => {});
    await p.evaluate(() => _lhAuthReady());
    return p;
  };
  const fillAndBook = (P, id) => P.evaluate(([lid, day]) => {
    const set = (i, v) => { const e = document.getElementById(i); if (e) e.value = v; };
    set('cbName', 'Achieng'); set('cbPhone', '0712345678'); set('cbDate', day); set('cbTime', '10:00'); set('cbDetails', 'Custody question');
    const m = document.getElementById('cbMatter'); if (m) { if (!m.options || !m.options.length) m.value = 'Family'; else m.value = m.options[m.options.length - 1].value; }
    confirmConsultation(lid);
  }, [id, TOMORROW]);
  const msgText = (P) => P.evaluate(() => { const m = document.getElementById('cbMsg'); return m ? { text: m.innerText, html: m.innerHTML } : null; });
  try {
    say('\n── auth + directory ──');
    const P = await open(user, { viewport: { width: 360, height: 780 } });
    ck('the page sees the signed-in user (window._sokoniUser is the auth authority\'s user)', await P.evaluate(() => window._sokoniUser && window._sokoniUser.uid) === 'b1');
    await P.evaluate(() => { try { showLawTab('lawyers'); } catch (_) {} });
    await P.waitForFunction(() => /Wanjiru Kamau/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
    ck('a verified advocate from the server directory renders', await P.evaluate(() => /Wanjiru Kamau/.test(document.body.innerText)));
    ck('an unapproved advocate is not listed', await P.evaluate(() => !/Otieno Pending/.test(document.body.innerText)));
    const chat = await P.evaluate(() => {
      let got = null; window.SokoniInbox = { openChat: (o) => { got = o; } };
      const btn = [...document.querySelectorAll('[data-lid="law1"] button')].find((b) => /Message/.test(b.textContent));
      if (btn) btn.click();
      return got;
    });
    ck('Message opens SOKONI chat with the advocate\'s own uid (no legal_ prefix)', chat && chat.otherUid === 'law1', chat);
    ck('no horizontal scroll at 360', await P.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));

    say('\n── booking ──');
    await P.evaluate(() => { window.SokoniPay = window.SokoniPay || {}; window.SokoniPay.bookNow = () => { window.__gateway++; }; bookLawyer('law1'); });
    const modal = await P.evaluate(() => { const m = document.getElementById('consultModal'); return m && getComputedStyle(m).display; });
    ck('Book opens the request modal for a server-verified advocate (it searched localStorage only)', modal === 'flex', modal);
    ck('…no client-priced gateway', await P.evaluate(() => window.__gateway) === 0);
    await fillAndBook(P, 'law1');
    await P.waitForFunction(() => /Request sent|not booked/.test((document.getElementById('cbMsg') || {}).innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const m1 = await msgText(P);
    const cons = (await all('legalConsultations')).filter((c) => c._id !== 'lc_seed');
    ck('the request IS the server record: one consultation, pending, for the signed-in client and the advocate', cons.length === 1 && cons[0].clientUid === 'b1' && cons[0].providerId === 'law1' && cons[0].status === 'pending', cons.map((c) => [c._id, c.clientUid, c.status]));
    ck('…priced by the server snapshot, not the page', cons[0] && cons[0].consultationFee === 3000, cons[0] && cons[0].consultationFee);
    ck('success is shown only once the server has it — and says no payment was taken', m1 && /Request sent/.test(m1.text) && /no payment has been taken/i.test(m1.text), m1 && m1.text);
    ck('…and continues in SOKONI chat with the advocate', m1 && /messages\.html\?with=law1/.test(m1.html));
    ck('no WhatsApp, no invoice for an unpaid booking, no client lead fee', await P.evaluate(() => !window.__opened.some((u) => /wa\.me/.test(u)) && window.__invoices === 0) && (await all('leadFees')).length === 0);
    const local = await P.evaluate(() => JSON.parse(localStorage.getItem('sokoniLegalBookings') || '[]')[0]);
    ck('the local retry cache carries the SERVER status (pending), never a client "confirmed"', local && local.status === 'pending' && local.consultationId === cons[0]._id, local);
    await P.evaluate((r) => retryLegalBooking(r.ref, 'law1'), local);
    await P.waitForTimeout(500);
    ck('a retry is idempotent — still one consultation', (await all('legalConsultations')).filter((c) => c._id !== 'lc_seed').length === 1);

    await P.evaluate(() => { window.__lawTmp = { id: 'law2', name: 'Otieno Pending', verified: true }; _fsLawyersCache = (_fsLawyersCache || []).concat([window.__lawTmp]); bookLawyer('law2'); });
    await fillAndBook(P, 'law2');
    await P.waitForFunction(() => /Request sent|not booked/.test((document.getElementById('cbMsg') || {}).innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const m2 = await msgText(P);
    ck('an advocate the server will not book → "not booked", with a retry, never a success', m2 && /not booked/.test(m2.text) && !/Request sent/.test(m2.text), m2 && m2.text);
    ck('…and nothing was written for them', (await all('legalConsultations')).every((c) => c.providerId !== 'law2'));

    say('\n── appointments ──');
    await P.evaluate(() => renderAppointments());
    const ap = await P.evaluate(() => { const el = document.getElementById('appointmentsList'); return el ? { text: el.innerText, html: el.innerHTML } : null; });
    ck('the server\'s consultations load (the confirmed one and the new pending one)', ap && /CONFIRMED/.test(ap.text) && /PENDING/.test(ap.text), ap && ap.text.slice(0, 160));
    ck('a confirmed consultation is messaged in SOKONI — never WhatsApp', ap && /messages\.html\?with=law1/.test(ap.html) && !/wa\.me/.test(ap.html));

    say('\n── advocate registration ──');
    const reg = async (P2) => {
      await P2.evaluate(() => {
        const set = (i, v) => { const e = document.getElementById(i); if (e) e.value = v; };
        set('lawName', 'Njeri Mwangi'); set('lawRoll', 'P.105/1234/2019'); set('lawPhone', '0722111222'); set('lawEmail', 'njeri@x.co'); set('lawRate', '4000'); set('lawBio', 'Family and land matters.');
        const d = document.getElementById('lawDeclaration'); if (d) d.checked = true;
        window.SokoniSecurity = undefined;
      });
      await P2.evaluate(() => registerLawyer());
      return P2.evaluate(() => ({ success: getComputedStyle(document.getElementById('lawRegSuccess')).display !== 'none', text: document.getElementById('lawRegSuccess').innerText, msg: (document.getElementById('lawRegMsg') || {}).innerText || '', opened: window.__opened.slice() }));
    };
    const r1 = await reg(P);
    const lp = await get('legalProviders/b1');
    ck('signed in: the application IS the server record (legalProviders pending review; SOKONI + LSK both pending — CHANGELOG 220)', lp && lp.status === 'pending_review' && lp.verification.admin.status === 'pending' && lp.verification.lsk.status === 'pending', lp && lp.status);
    ck('…the success says pending verification — never "your listing is now live"', r1.success && /Pending Verification/.test(r1.text) && !/now live/i.test(r1.text), r1.text.slice(0, 140));
    ck('…no WhatsApp to the admin', !r1.opened.some((u) => /wa\.me/.test(u)), r1.opened);
    await P.__ctx.close();

    const O = await open(null);
    ck('signed out: the page sees no user', await O.evaluate(() => window._sokoniUser) === null);
    const r2 = await reg(O);
    ck('signed out: registration asks to sign in, shows NO success, writes nothing', !r2.success && /sign in/i.test(r2.msg) && (await all('legalProviders')).length === 3, r2.msg);
    await O.evaluate(() => { _fsLawyersCache = [{ id: 'law1', name: 'Wanjiru Kamau', verified: true }]; bookLawyer('law1'); });
    const before = (await all('legalConsultations')).length;
    await fillAndBook(O, 'law1');
    await O.waitForTimeout(400);
    const m3 = await msgText(O);
    ck('signed out: booking asks to sign in and writes nothing', m3 && /sign in/i.test(m3.text) && (await all('legalConsultations')).length === before, m3 && m3.text);
    await O.__ctx.close();

    say('\n── firm registration ──');
    for (const [label, ok] of [['a queue save that fails', false], ['a queue save that succeeds', true]]) {
      const Q = await open(user);
      const fr = await Q.evaluate(async (good) => {
        window.__saved = 0;
        window.SokoniDB = { saveApplication: async () => { if (!good) throw new Error('permission-denied'); window.__saved++; return 'x'; } };
        const set = (i, v) => { const e = document.getElementById(i); if (e) e.value = v; };
        set('firmName', 'Kamau & Co Advocates'); set('firmCity', 'Nairobi'); set('firmPhone', '0722000111'); set('firmEmail', 'firm@x.co');
        window.SokoniSecurity = undefined;
        await submitFirmRegistration();
        return { success: getComputedStyle(document.getElementById('firmRegSuccess')).display !== 'none', msg: (document.getElementById('firmRegMsg') || {}).innerText || '', opened: window.__opened.slice(), saved: window.__saved };
      }, ok);
      ck(`${label}: ${ok ? 'success shown after the save' : 'NO success, an honest error'}; no admin WhatsApp`, (ok ? fr.success && fr.saved === 1 : !fr.success && /could not submit/.test(fr.msg)) && !fr.opened.some((u) => /wa\.me/.test(u)), fr);
      await Q.__ctx.close();
    }
  } finally { await browser.close(); HAR.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
