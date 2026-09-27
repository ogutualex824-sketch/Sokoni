/* test-healthcare-directory.js — the Healthcare directory lists ONLY real, approved, server-classified providers
 * (CHANGELOG 229). Fake Firestore + the REAL functions/healthcare-directory.js and healthcare-hub records callables;
 * the REAL healthcare.html + sokoni-health-directory.js in Chromium (page harness). No network.
 *
 * PROVES
 *   eligibility   all six categories (incl. admin-only telemedicine + home_care) are listed when approved; NOT
 *                 listed: unclassified health providers, pending / suspended / non-public / non-searchable, and a
 *                 plumber who calls itself a "clinic" (free-text category) — nothing manufactured
 *   projection    whitelist only — no phone, email, location, licence, internal fields; no fee is exposed; a rating
 *                 appears only when the reputation authority derived it (repV + reviews)
 *   empty         an empty registry returns [] and the page shows the honest empty state, never sample content
 *   page          the real page at 360 / 390 / 768 / 1280: cards come from the server only; every link is built from
 *                 the server providerId (provider-profile / messages); no wa.me, no tel: except 999 / 112, no KES fee;
 *                 category chips filter (all six); ?tab=teleconsult deep-links to telemedicine; a forged / unsafe id
 *                 from the server is not rendered and cannot inject markup; a server error shows retry, not success;
 *                 no horizontal scroll
 *   my health     signed out → sign-in prompt; signed in → the patient's OWN records only
 *
 *   node scripts/test-healthcare-directory.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-healthcare-directory';
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
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
const HD = require(Path.join(FN, 'healthcare-directory.js'));
const HC = require(Path.join(FN, 'healthcare-hub.js'));
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const run = (cf) => (req) => (cf.run || cf)(req);
const req = (uid, data) => ({ auth: uid ? { uid, token: {} } : null, data: data || {}, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const PRIVATE = { phone: '0722000111', phoneNumber: '+254722000111', email: 'private@x.co', location: '14 Private Lane', licenseNumber: 'KMPDC-9', ownerName: 'Owner Person', sourceApplicationId: 'app1' };
const P = (uid, category, over) => db.doc('providers/' + uid).set(Object.assign({ uid, providerId: 'PRV-' + uid, name: 'Name ' + uid, status: 'active', isPublic: true, searchable: true, acceptsBookings: true,
  city: 'Nairobi', area: 'Kilimani', description: 'Care for ' + uid, healthcare: { category, source: category === 'telemedicine' || category === 'home_care' ? 'admin' : 'application' } }, PRIVATE, over || {}));
const WHITELIST = ['providerId', 'name', 'category', 'categoryLabel', 'description', 'city', 'area', 'rating', 'reviewCount', 'acceptsBookings'];

(async () => {
  say('\n── server: eligibility ──');
  ck('an empty registry returns an empty directory — nothing manufactured', (await run(HD.healthcareDirectory)(req(null, {}))).providers.length === 0);
  await P('doc1', 'clinician', { repV: 1, rating: 4.6, reviewCount: 3 });
  await P('fac1', 'facility'); await P('ph1', 'pharmacy'); await P('lab1', 'laboratory');
  await P('tele1', 'telemedicine'); await P('home1', 'home_care');
  await db.doc('providers/unc1').set(Object.assign({ uid: 'unc1', name: 'Unclassified', status: 'active', isPublic: true, healthcare: { category: null, source: 'application' } }, PRIVATE));
  await P('pend1', 'clinician', { status: 'pending_approval' });
  await P('sus1', 'facility', { suspended: true, status: 'suspended' });
  await P('priv1', 'pharmacy', { isPublic: false });
  await P('hid1', 'laboratory', { searchable: false });
  await db.doc('providers/plumb1').set({ uid: 'plumb1', name: 'Clinic Plumbing', category: 'Clinic', categories: ['Clinic', 'hospital'], status: 'active', isPublic: true, searchable: true });
  await P('rate0', 'clinician', { rating: 5, reviewCount: 0 });

  const all = (await run(HD.healthcareDirectory)(req(null, {}))).providers;
  const ids = all.map((p) => p.providerId).sort();
  ck('all six categories are listed when approved (incl. admin-only telemedicine + home care)', ['doc1', 'fac1', 'home1', 'lab1', 'ph1', 'tele1'].every((i) => ids.includes(i)), ids);
  for (const [k, id] of [['UNCLASSIFIED health provider', 'unc1'], ['pending provider', 'pend1'], ['suspended provider', 'sus1'], ['non-public provider', 'priv1'], ['non-searchable provider', 'hid1'], ['plumber calling itself a "clinic"', 'plumb1']]) {
    ck(`not listed: ${k}`, !ids.includes(id));
  }
  for (const c of ['clinician', 'facility', 'pharmacy', 'laboratory', 'telemedicine', 'home_care']) {
    const r = (await run(HD.healthcareDirectory)(req(null, { category: c }))).providers;
    ck(`category ${c}: only that category`, r.length >= 1 && r.every((p) => p.category === c), r.map((p) => p.providerId));
  }
  ck('an unknown category is refused', await code(run(HD.healthcareDirectory)(req(null, { category: 'spa' }))) === 'invalid-argument');
  /* The query filters by category AND the predicate re-checks it (two layers); the predicate is exported for any
     other reader of this registry, so it is proven on its own — a query change must never be the only guard. */
  const live = { status: 'active', isPublic: true, searchable: true };
  ck('the discoverability predicate itself refuses an unclassified / free-text provider (second layer)',
    !HD.isDiscoverable(Object.assign({ healthcare: { category: null } }, live)) && !HD.isDiscoverable(Object.assign({ category: 'Clinic' }, live))
      && !HD.isDiscoverable(Object.assign({ healthcare: { category: 'spa' } }, live)) && HD.isDiscoverable(Object.assign({ healthcare: { category: 'pharmacy' } }, live)));

  say('\n── server: public projection ──');
  const leak = all.flatMap((p) => Object.keys(p).filter((k) => !WHITELIST.includes(k)));
  ck('only whitelisted fields', leak.length === 0 && JSON.stringify(HD.PUBLIC_FIELDS) === JSON.stringify(WHITELIST), leak);
  ck('no phone / email / street location / licence / owner / application id anywhere', !/0722000111|254722000111|private@x\.co|Private Lane|KMPDC-9|Owner Person|app1/.test(JSON.stringify(all)));
  ck('no fee is exposed (the price comes from the provider\'s services at booking)', !all.some((p) => 'consultationFee' in p || 'price' in p || 'fee' in p));
  const d1 = all.find((p) => p.providerId === 'doc1'); const r0 = (await run(HD.healthcareDirectory)(req(null, { category: 'clinician' }))).providers.find((p) => p.providerId === 'rate0');
  ck('a rating appears only when the reputation authority derived it (repV + reviews)', d1.rating === 4.6 && d1.reviewCount === 3 && r0 && r0.rating === null && r0.reviewCount === 0, { d1: d1.rating, r0: r0 && r0.rating });

  say('\n── the real page ──');
  await db.doc('healthRecords/rA').set({ patientUid: 'patA', providerName: 'Name doc1', diagnosis: 'Otitis media', createdAt: 1 });
  await db.doc('healthRecords/rB').set({ patientUid: 'patB', providerName: 'Name doc1', diagnosis: 'SECRET-OTHER-PATIENT', createdAt: 1 });
  let FORGE = false; let FAILNEXT = false;
  const directory = async (r) => {
    if (FAILNEXT) { FAILNEXT = false; throw Object.assign(new Error('Service unavailable'), { code: 'unavailable' }); }
    const out = await run(HD.healthcareDirectory)(r);
    if (FORGE) out.providers = [{ providerId: '"><img src=x onerror=window.__pwned=1>', name: 'Forged', category: 'clinician', categoryLabel: 'x', acceptsBookings: true },
      { providerId: '../admin', name: 'Traversal', category: 'clinician', categoryLabel: 'x', acceptsBookings: true }].concat(out.providers.slice(0, 1));
    return out;
  };
  const HAR = makePageHarness({ db, root: ROOT, callables: { healthcareDirectory: directory, getHealthRecords: run(HC.getHealthRecords), getPrescriptions: run(HC.getPrescriptions) } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const cardsOf = (pg) => pg.evaluate(() => [...document.querySelectorAll('#hcGrid .hc-card')].map((c) => ({ id: c.dataset.providerId, links: [...c.querySelectorAll('a')].map((a) => a.getAttribute('href')) })));
  try {
    for (const w of [360, 390, 768, 1280]) {
      const pg = await HAR.page(browser, { user: null, viewport: { width: w, height: 800 } });
      await pg.goto(HAR.BASE + '/healthcare.html');
      await pg.waitForFunction(() => document.querySelectorAll('#hcGrid .hc-card').length > 0, null, { timeout: 12000 }).catch(() => {});
      const cards = await cardsOf(pg);
      ck(`${w}px: the server's approved providers render (six categories)`, cards.length === 7, cards.map((c) => c.id));
      ck(`${w}px: every link is built from the server providerId (profile + messages only)`, cards.every((c) => c.links.length === 2 && c.links[0] === 'provider-profile.html?uid=' + c.id && c.links[1] === 'messages.html?with=' + c.id));
      const page = await pg.evaluate(() => ({ html: document.body.innerHTML, tels: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href')), wa: !!document.querySelector('a[href*="wa.me"]'), grid: document.getElementById('hcGrid').innerText }));
      ck(`${w}px: no WhatsApp link; tel: only 999 / 112`, !page.wa && page.tels.every((t) => t === 'tel:999' || t === 'tel:112'), page.tels);
      ck(`${w}px: no fee on any card, no invented institution`, !/KES\s*\d/.test(page.grid) && !/Aga Khan|Gertrude|Coast General|Lancet|Goodlife/.test(page.html));
      ck(`${w}px: no horizontal scroll`, await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      if (w === 360) {
        await pg.click('[data-hc-cat="telemedicine"]');
        await pg.waitForFunction(() => [...document.querySelectorAll('#hcGrid .hc-card')].length === 1, null, { timeout: 8000 }).catch(() => {});
        const t = await cardsOf(pg);
        ck('the Telemedicine chip lists only the (admin-classified) telemedicine provider', t.length === 1 && t[0].id === 'tele1', t.map((c) => c.id));
        await pg.click('[data-hc-cat="home_care"]');
        await pg.waitForFunction(() => { const c = document.querySelector('#hcGrid .hc-card'); return c && c.dataset.providerId === 'home1'; }, null, { timeout: 8000 }).catch(() => {});
        ck('the Home care chip lists only the home-care provider', (await cardsOf(pg)).map((c) => c.id).join() === 'home1');
        await pg.fill('#hcSearch', 'zzz-no-such-provider');
        const empty = await pg.evaluate(() => ({ state: document.getElementById('hcDirState').innerText, cards: document.querySelectorAll('#hcGrid .hc-card').length }));
        ck('a search with no match shows the honest empty state, no cards', empty.cards === 0 && /No verified provider matches/.test(empty.state), empty.state);
      }
      await pg.__ctx.close();
    }

    const dl = await HAR.page(browser, { user: null });
    await dl.goto(HAR.BASE + '/healthcare.html?tab=teleconsult');
    await dl.waitForFunction(() => { const c = document.querySelector('#hcGrid .hc-card'); return c && c.dataset.providerId === 'tele1'; }, null, { timeout: 12000 }).catch(() => {});
    ck('?tab=teleconsult deep-links to the Telemedicine category', (await cardsOf(dl)).map((c) => c.id).join() === 'tele1');
    await dl.__ctx.close();

    FORGE = true;
    const fg = await HAR.page(browser, { user: null });
    await fg.goto(HAR.BASE + '/healthcare.html');
    await fg.waitForFunction(() => document.querySelectorAll('#hcGrid .hc-card').length > 0, null, { timeout: 12000 }).catch(() => {});
    const fc = await cardsOf(fg);
    ck('a forged / unsafe providerId from the server is NOT rendered (no injection, no traversal link)', fc.length === 1 && !fc.some((c) => /img|\.\./.test(c.id)) && (await fg.evaluate(() => !window.__pwned)), fc.map((c) => c.id));
    await fg.__ctx.close(); FORGE = false;

    FAILNEXT = true;
    const er = await HAR.page(browser, { user: null });
    await er.goto(HAR.BASE + '/healthcare.html');
    await er.waitForFunction(() => (document.getElementById('hcDirState') || {}).dataset && document.getElementById('hcDirState').dataset.state === 'error', null, { timeout: 12000 }).catch(() => {});
    const es = await er.evaluate(() => ({ state: document.getElementById('hcDirState').dataset.state, text: document.getElementById('hcDirState').innerText, retry: !!document.querySelector('[data-hc-retry]'), cards: document.querySelectorAll('#hcGrid .hc-card').length }));
    ck('a server error shows an error with retry — never success, never cards', es.state === 'error' && es.retry && es.cards === 0 && /couldn't load/i.test(es.text), es);
    await er.click('[data-hc-retry]');
    await er.waitForFunction(() => document.querySelectorAll('#hcGrid .hc-card').length > 0, null, { timeout: 12000 }).catch(() => {});
    ck('…and retry loads the directory', (await cardsOf(er)).length === 7);
    await er.__ctx.close();

    const out = await HAR.page(browser, { user: null });
    await out.goto(HAR.BASE + '/healthcare.html?tab=myhealth');
    await out.waitForFunction(() => /Sign in to see your health records/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
    ck('My health, signed out: a sign-in prompt, no records', await out.evaluate(() => /Sign in to see your health records/.test(document.body.innerText) && !/Otitis/.test(document.body.innerText)));
    await out.__ctx.close();
    const me = await HAR.page(browser, { user: { uid: 'patA', email: 'a@x.co', emailVerified: true } });
    await me.goto(HAR.BASE + '/healthcare.html?tab=myhealth');
    await me.waitForFunction(() => /Otitis media/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
    const mh = await me.evaluate(() => document.body.innerText);
    ck('My health, signed in: the patient\'s OWN record only', /Otitis media/.test(mh) && !/SECRET-OTHER-PATIENT/.test(mh));
    ck('…and "My appointments" points at the canonical bookings page', await me.evaluate(() => !!document.querySelector('a[href="profile.html#bookings"]')));
    await me.__ctx.close();

    const emptyDb = makeFakeFirestore({ clock: () => Date.now() }).db;
    const HE = makePageHarness({ db: emptyDb, root: ROOT, callables: { healthcareDirectory: async () => ({ providers: [], categories: [] }) } });
    await HE.start();
    const ep = await HE.page(browser, { user: null, viewport: { width: 390, height: 800 } });
    await ep.goto(HE.BASE + '/healthcare.html');
    await ep.waitForFunction(() => (document.getElementById('hcDirState') || {}).dataset && document.getElementById('hcDirState').dataset.state === 'empty', null, { timeout: 12000 }).catch(() => {});
    const ee = await ep.evaluate(() => ({ text: document.getElementById('hcDirState').innerText, cards: document.querySelectorAll('#hcGrid .hc-card').length }));
    ck('an EMPTY registry: the honest empty state, no sample institutions', ee.cards === 0 && /No verified healthcare providers are listed on SOKONI yet/.test(ee.text), ee.text.slice(0, 120));
    await ep.__ctx.close(); HE.stop();
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
