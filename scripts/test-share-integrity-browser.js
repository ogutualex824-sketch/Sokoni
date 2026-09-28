/* test-share-integrity-browser.js — share sheet, share-card rating and the provider share link, on the
 * REAL pages/scripts (Chromium via Playwright) over the REAL server modules on the fake Firestore
 * (scripts/lib/page-harness.js). No network, no production.
 *
 * PROVES
 *   sokoni-share.js   seller-controlled names / images / URLs never become markup: <script>, <img onerror>,
 *                     quotes, apostrophes, angle brackets and entity-encoded payloads render as TEXT; a
 *                     javascript:/data: image falls back to the SOKONI logo
 *   share cards       a caller-supplied rating (product.js's old `rating||5`, seller-public's `rating:5`,
 *                     static demo 4.9s) draws NO stars; only a canonical aggregate does, with its count;
 *                     the card's link honours the caller's SOKONI shareURL and never an off-site URL;
 *                     the REAL seller-public.html share button draws no stars
 *   provider link     the REAL provider dashboard's Share makes a HANDLE link (/p.html?h=…&s=…, no uid)
 *                     that resolves; its QR encodes the same handle; p.html lands on the REAL
 *                     provider-profile.html by handle, showing identity · canonical rating · followers ·
 *                     Follow · Share · offering · availability · Book · Message — logged-out and signed-in,
 *                     at 360 · 390 · 768 · 1280 with no horizontal scroll
 *
 *   node scripts/test-share-integrity-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-share-integrity';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }), setCustomUserClaims: async () => {} };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const REP = require(Path.join(FN, 'reputation.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));
const PON = require(Path.join(FN, 'provider-onboarding.js'));
const AV = require(Path.join(FN, 'ent-availability.js'));
const EQ = require(Path.join(FN, 'ent-enquiries.js'));
const RC = require(Path.join(FN, 'ent-rate-cards.js'));
const PD = require(Path.join(FN, 'provider-directory.js'));   /* CHANGELOG 244 — the public provider directory */
const { makePageHarness } = require('./lib/page-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const H = 3600e3, DAY = 86400e3;
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const WEEK = {}; ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach((d) => { WEEK[d] = { closed: false, periods: [{ open: '08:00', close: '20:00' }], breaks: [] }; });

const SHARE_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title></head><body><script src="/sokoni-share.js"></script></body></html>';
/* canvas text is recorded so the test can see what a share card DRAWS */
const CARD_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>' +
  '<script>window.__drawn=[];const f=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(t){window.__drawn.push(String(t));return f.apply(this,arguments)};</script>' +
  '</head><body><script src="/sokoni-social.js"></script></body></html>';

(async () => {
  for (const u of ['b1', 'b2', 'ph1']) await db.doc('users/' + u).set({ displayName: u === 'b1' ? 'Achieng Otieno' : u });
  /* CHANGELOG 244 (C3a-2): an approved provider carries the SERVER's business stamp, and an unclassified one is not
     publicly listed or fetchable. The stamp is DERIVED FROM ITS PRODUCERS — the same two calls
     application-lifecycle.projectProvider makes at approval — never hand-written: a hand-written lane
     ({hub:'provider'}) moved this photographer out of the Entertainment lane it is decided into. */
  const APP_PH1 = { uid: 'ph1', status: 'approved', role: 'provider', category: 'photographer' };
  const STAMP_PH1 = { category: require(Path.join(FN, 'business-category.js')).categoryFromApplication(APP_PH1, APP_PH1.role).category, source: 'application', applicationId: 'app_ph1',
    lane: require(Path.join(FN, 'provider-hub.js')).classifyDecidedApplication(Object.assign({}, APP_PH1, { role: APP_PH1.role })) };
  if (STAMP_PH1.category !== 'artist_creator' || STAMP_PH1.lane.hub !== 'entertainment') throw new Error('fixture: the producers no longer stamp a photographer as artist_creator / entertainment — ' + JSON.stringify(STAMP_PH1));
  await db.doc('providers/ph1').set({ uid: 'ph1', name: 'Jane Photography', status: 'active', verified: true, category: 'photographer', acceptsBookings: true, rating: 5, reviewCount: 99,
    business: STAMP_PH1 });
  await db.doc('providerProfiles/ph1').set({ uid: 'ph1', providerId: 'PRV-AB12CD34', status: 'active', name: 'Jane Photography' });
  await db.doc('applications/app_ph1').set(APP_PH1);
  await db.doc('providerAvailability/ph1').set({ uid: 'ph1', modes: ['fixed_hours'], schedule: WEEK, appt: { enabled: true, durationMins: 60, maxDaysAhead: 90, minNoticeHours: 1, allowSameDay: true }, cap: {} });
  await db.doc('providerServices/s1').set({ providerId: 'ph1', name: 'Portrait session', price: 500000, fee: 0, deposit: 0, durationMins: 60, active: true });
  await EQ._h.entMessagingSetSettings({ auth: { uid: 'ph1', token: {} }, rawRequest: { headers: {} }, data: { settings: { responseTime: 'WITHIN_1_HOUR' } } });
  await db.doc('providerBookings/pb1').set({ providerId: 'ph1', customerUid: 'b1', customerName: 'Achieng Otieno', service: 'Portrait session', serviceId: 's1', status: 'completed', paymentStatus: 'settled', startTs: Date.now() - 3 * DAY, endTs: Date.now() - 3 * DAY + 2 * H, price: 500000 });
  await BS._h.bookingSubmitReview({ auth: { uid: 'b1', token: {} }, rawRequest: { headers: {} }, data: { bookingId: 'pb1', rating: 4, text: 'Lovely light' } });

  const HAR = makePageHarness({ db, root: ROOT, pages: { '/t-share.html': SHARE_PAGE, '/t-card.html': CARD_PAGE },
    callables: { bookingDispatch: Object.assign({}, AV._h, EQ._h, RC._h, BS._h, REP._h), providerDispatch: Object.assign({}, PON._h, PO._h, PD._h) } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    /* ═══ sokoni-share.js — no markup from data ═══ */
    say('\n── share sheet (sokoni-share.js) ──');
    const S = await HAR.page(browser, { viewport: { width: 360, height: 780 } });
    const offsite = [];
    S.on('request', (rq) => { if (/evil\.example/.test(rq.url())) offsite.push(rq.url()); });
    await S.goto(HAR.BASE + '/t-share.html');
    const PAYLOADS = [
      '<script>window.__pwned=1</script>Kiondo',
      '<img src=x onerror="window.__pwned=2">Basket',
      '"><img src=x onerror=window.__pwned=3>',
      "Mama's \"best\" <b>soap</b>",
      '&lt;img src=x onerror=window.__pwned=4&gt;',
      '<svg/onload=window.__pwned=5>',
    ];
    for (const name of PAYLOADS) {
      const r = await S.evaluate((n) => {
        SokoniShare.open({ name: n, price: 1500, image: 'javascript:window.__pwned=6', url: 'https://mysokoni.co.ke/product.html?id="><script>window.__pwned=7</script>', description: n });
        const ov = document.getElementById('sokoni-share-overlay');
        const out = { text: ov.querySelector('.ss-name').textContent, scripts: ov.querySelectorAll('script,svg,b').length, handlers: [...ov.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))),
          imgs: ov.querySelectorAll('img').length, src: ov.querySelector('img').getAttribute('src'), alt: ov.querySelector('img').getAttribute('alt'), link: ov.querySelector('.ss-link-txt').textContent };
        return out;
      }, name);
      await S.waitForTimeout(80);
      ck(`payload ${JSON.stringify(name).slice(0, 38)} renders as TEXT (no element, no handler)`, r.text === name && r.scripts === 0 && !r.handlers && r.imgs === 1 && r.alt === name, r);
    }
    const pw = await S.evaluate(() => window.__pwned);
    ck('nothing executed across all payloads', pw === undefined, pw);
    const src = await S.evaluate(() => document.querySelector('#sokoni-share-overlay img').getAttribute('src'));
    ck('a javascript: image falls back to the SOKONI logo', src === 'assets/sokoni logoo.jpeg', src);
    ck('the link row shows the URL as text', await S.evaluate(() => document.querySelector('.ss-link-txt').textContent.includes('"><script>')));
    await S.evaluate(() => SokoniShare.open({ name: 'Pixel', image: 'http://evil.example/track.png?who=me' }));
    await S.waitForTimeout(400);
    ck('an off-site / non-https image is never fetched (no tracking pixel through the share sheet)', offsite.length === 0 && await S.evaluate(() => document.querySelector('#sokoni-share-overlay img').getAttribute('src') === 'assets/sokoni logoo.jpeg'), offsite);

    /* ═══ share cards — no invented rating ═══ */
    say('\n── share cards (sokoni-social.js) ──');
    const C = await HAR.page(browser, { viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    await C.goto(HAR.BASE + '/t-card.html');
    const cardDraws = async (opts) => {
      await C.evaluate((o) => { window.__drawn = []; SokoniSocial.openShareModal(o); }, opts);
      await C.waitForFunction(() => window.SokoniSocial._cardDataUrl && window.__drawn.length > 3, null, { timeout: 6000 }).catch(() => {});
      await C.waitForTimeout(150);
      const d = await C.evaluate(() => window.__drawn.slice());
      await C.evaluate(() => { const m = document.getElementById('_skSocModal'); if (m) m.remove(); window.SokoniSocial._cardDataUrl = null; });
      return d;
    };
    const legacy = await cardDraws({ id: 'p1', name: 'Kiondo Basket', category: 'Crafts', rating: 5, type: 'product', shareURL: 'https://mysokoni.co.ke/product.html?id=p1' });
    ck('product.js\'s old `rating:5` draws NO stars (a caller literal is not a rating)', legacy.length > 3 && !legacy.some((t) => /★|☆|rating/.test(t)), legacy);
    const demo = await cardDraws({ id: 'kaspa_prints', name: 'Kaspa Prints', rating: 4.9, type: 'store' });
    ck('a static demo 4.9 draws NO stars either', !demo.some((t) => /★|rating/.test(t)));
    const staticCount = await cardDraws({ id: 'hc1', name: 'Nairobi Clinic', rating: 4.7, reviews: 312, type: 'service' });
    ck('a hard-coded rating WITH a hard-coded count (healthcare demo 4.7 · 312) draws NO stars', !staticCount.some((t) => /★|rating|312/.test(t)), staticCount);
    const canon = await cardDraws({ id: 'ph1', name: 'Jane', rating: 4.2, reviews: 3, ratingVerified: true, type: 'service' });
    ck('a CANONICAL aggregate draws its stars AND its count', canon.includes('★★★★☆') && canon.includes('4.2 rating · 3 reviews'), canon);
    const zero = await cardDraws({ id: 'ph1', name: 'Jane', rating: 5, reviews: 0, ratingVerified: true, type: 'service' });
    ck('…but a "verified" rating with no reviews still draws nothing', !zero.some((t) => /★/.test(t)));
    await C.evaluate(() => SokoniSocial.openShareModal({ id: 'p1', name: 'X', type: 'product', shareURL: 'https://mysokoni.co.ke/product.html?id=p1&ref=abc' }));
    ck('the card\'s link is the caller\'s SOKONI shareURL (was: store.html?id=<productId>)', (await C.evaluate(() => SokoniSocial._sd && window.SokoniSocial._sd)) && await C.evaluate(() => { let u = null; const o = window.open; window.open = (x) => { u = x; }; SokoniSocial._share('fb'); window.open = o; return decodeURIComponent(u || ''); }).then((u) => u.includes('https://mysokoni.co.ke/product.html?id=p1&ref=abc')));
    await C.evaluate(() => { const m = document.getElementById('_skSocModal'); if (m) m.remove(); SokoniSocial.openShareModal({ id: 'p1', name: 'X', type: 'product', shareURL: 'https://evil.example/phish' }); });
    ck('an off-site shareURL is refused (falls back to the SOKONI page)', await C.evaluate(() => { let u = null; const o = window.open; window.open = (x) => { u = x; }; SokoniSocial._share('fb'); window.open = o; return decodeURIComponent(u || ''); }).then((u) => !u.includes('evil.example') && u.includes('https://mysokoni.co.ke/')));
    /* the REAL seller-public.html share button */
    const SP = await HAR.page(browser, { viewport: { width: 390, height: 844 } });
    await SP.addInitScript(() => { window.__drawn = []; const f = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t) { window.__drawn.push(String(t)); return f.apply(this, arguments); }; });
    await SP.goto(HAR.BASE + '/seller-public.html?id=seller1');
    await SP.waitForTimeout(1500);
    const clicked = await SP.evaluate(() => { const b = [...document.querySelectorAll('button[onclick*="openShareModal"]')][0]; if (!b) return false; b.click(); return true; });
    await SP.waitForFunction(() => window.SokoniSocial && window.SokoniSocial._cardDataUrl, null, { timeout: 6000 }).catch(() => {});
    const spDrawn = await SP.evaluate(() => window.__drawn.slice());
    ck('the REAL seller-public.html share card draws no invented stars', clicked && spDrawn.length > 3 && !spDrawn.some((t) => /★|rating/.test(t)), { clicked, spDrawn });

    /* ═══ provider dashboard share link → public destination ═══ */
    say('\n── provider share link (dashboard → p.html → public profile) ──');
    const P = await HAR.page(browser, { user: { uid: 'ph1', email: 'j@x.co', emailVerified: true, claims: { provider: true } }, viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    await P.goto(HAR.BASE + '/provider-dashboard.html');
    await P.waitForFunction(() => typeof Sv !== 'undefined' && window.SokoniRep, null, { timeout: 10000 }).catch(() => {});
    await P.evaluate(() => { Sv._svc = [{ id: 's1', name: 'Portrait session' }]; return Sv.share('s1'); });
    await P.waitForTimeout(400);
    const copied = await P.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    ck('the dashboard Share makes a HANDLE link for the service — no uid, no PRV id, no /providers?p=', /^https:\/\/mysokoni\.co\.ke\/p\.html\?h=[a-z0-9-]+&s=s1$/.test(copied) && !/ph1|PRV-|providers\?p=/.test(copied), copied);
    ck('…and the share was counted as one share event (never a follower or rating)', (await db.doc('providers/ph1').get()).data().shareCount === 1 && (await db.doc('providers/ph1').get()).data().reviewCount === 1);
    await P.evaluate(() => Sv.qr('s1'));
    await P.waitForSelector('.pd-qr-ov', { timeout: 6000 }).catch(() => {});
    const qrCap = await P.evaluate(() => { const o = document.querySelector('.pd-qr-ov'); return o ? o.textContent : ''; });
    ck('the service QR encodes the SAME handle link (never the uid)', qrCap.includes(copied) && !/uid=|ph1/.test(qrCap), qrCap.slice(0, 120));
    const qrProfile = await PON._h.providerGenerateQR({ auth: { uid: 'ph1', token: {} }, rawRequest: { headers: {} }, data: {} });
    ck('the profile QR stored on the provider record is the handle link too', /^https:\/\/mysokoni\.co\.ke\/p\.html\?h=[a-z0-9-]+$/.test(qrProfile.qrCode) && (await db.doc('providerProfiles/ph1').get()).data().qrCode === qrProfile.qrCode);

    for (const [w, h] of [[360, 780], [390, 844], [768, 1000], [1280, 900]]) {
      for (const who of [null, 'b2']) {
        const pg = await HAR.page(browser, { user: who ? { uid: who, email: who + '@x.co', emailVerified: true } : null, viewport: { width: w, height: h } });
        await pg.goto(HAR.BASE + '/p.html?' + copied.split('?')[1]);
        await pg.waitForURL(/provider-profile\.html/, { timeout: 8000 }).catch(() => {});
        await pg.waitForFunction(() => /Follow/.test(document.body.innerText) && /Lovely light/.test(document.body.innerText) && document.querySelector('[data-act="book"]'), null, { timeout: 10000 }).catch(() => {});
        const t = await pg.evaluate(() => document.body.innerText);
        const url = pg.url();
        const tag = `${w} ${who ? 'signed-in' : 'logged-out'}`;
        ck(`${tag}: lands by handle (no uid in the address bar)`, /provider-profile\.html\?h=[a-z0-9-]+&service=s1$/.test(url) && !/uid=|ph1/.test(url), url);
        ck(`${tag}: identity · verified · CANONICAL rating (4.0 · 1 review, not the owner's 5 / 99) · followers · Follow · Share`, /Jane Photography/.test(t) && /Verified/.test(t) && /4\.0/.test(t) && /1 review\b/.test(t) && !/99 review/.test(t) && /follower/.test(t) && /Follow/.test(t) && /Share/.test(t), t.slice(0, 200));
        ck(`${tag}: offering · availability · Book · Message · the review`, /Portrait session/.test(t) && !!(await pg.$('[data-act="book"]')) && /Message/.test(t) && /Lovely light/.test(t));
        ck(`${tag}: no uid, email or phone in the page`, !/\bb1\b|@x\.co|0712/.test(await pg.evaluate(() => document.body.innerHTML.replace(/uid:\s*'ph1'/g, ''))) && pg.__errors.length === 0, pg.__errors.slice(0, 2));
        ck(`${tag}: no horizontal scroll`, await noOverflow(pg));
        if (w === 390 && !who) {
          await pg.click('[data-follow]');
          await pg.waitForURL(/login\.html/, { timeout: 5000 }).catch(() => {});
          ck('logged-out Follow goes to sign-in, returning to the HANDLE url (nothing written)', /\/login(\.html)?\?next=/.test(pg.url()) && !/uid%3D|ph1/.test(pg.url()) && !(await db.doc('follows/null--provider--ph1').get()).exists, pg.url());
        }
        if (w === 390 && who) {
          await pg.click('[data-follow]');
          await pg.waitForSelector('[data-follow][aria-pressed="true"]', { timeout: 6000 }).catch(() => {});
          ck('signed-in Follow → Following through the SERVER authority', (await db.doc('follows/b2--provider--ph1').get()).exists && (await db.doc('providers/ph1').get()).data().followerCount === 1);
        }
        await pg.__ctx.close();
      }
    }
  } finally { await browser.close(); HAR.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
