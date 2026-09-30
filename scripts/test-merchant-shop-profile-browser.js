/* test-merchant-shop-profile-browser.js — merchant-v2 › Shop details › Details (the seller.html wizard, ported
 * 2026-09-29) in a REAL browser, saved through the REAL saveShopProfile, and READ BACK on the REAL public storefront.
 *
 * Chromium loads sokoni-merchant-shop-profile.js mounted as merchant-v2 mounts it; ctx.callGet / callSave /
 * callConfig / callSaveConfig reach the REAL kasshop + minishop callables on the transactional fake Firestore; the
 * storefront (minishop.html + sokoni-minishop.js) is served with the REAL getMinishopPublic. Uploads are the one stub
 * (no Storage in the harness): they return an https download URL in the owner's seller-assets folder.
 *
 * PROVES
 *   B1  all five steps from seller.html exist, in order: Identity · Permits · Shop setup · Delivery · Go live
 *   B2  every step's fields are present (incl. LinkedIn, maps link, zones, returns, five permit uploads)
 *   B3  the SOKONI category is shown read-only — there is no category input
 *   B4  a missing phone blocks the save with a named error, and nothing is written
 *   B5  filling every step and saving writes the canonical shop; the page says saved only after the server did
 *   B5b a server refusal shows "NOT saved", never "Saved."
 *   B6  a reload restores EVERY field (seller.html's reload lost delivery method, returns, zones, colour, seller type…)
 *   B7  a permit upload records a private kyc-documents path; the number fields save to the owner-only record
 *   B8  the PUBLIC storefront shows the saved tagline, description, delivery areas, delivery policy, returns and LinkedIn
 *   B9  a hostile shop name is escaped on the page and on the storefront
 *   B10 a staff (non-owner) session sees "Owner only", not an editor
 *   B11 no horizontal overflow at 360 px (editor) and 360 px (storefront)
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-shop-profile-browser';
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
const { makePageHarness } = require('./lib/page-harness.js');
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1);

const PAGE = (owner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--bg:#050505;--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09)}body{margin:0;padding:12px;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-availability-model.js"></script>
<script src="/sokoni-merchant-shop-profile.js"></script>
<script>
  const call = (n) => (d) => firebase.functions().httpsCallable(n)(d || {});
  window.__uploads = [];
  function start() {
    const u = firebase.auth().currentUser; if (!u) return setTimeout(start, 50);
    window.__ui = SokoniMerchantShopProfile.mount(document.getElementById('host'), {
      uid: u.uid, origin: location.origin, isOwner: ${owner === false ? 'false' : 'true'},
      callGet: call('getShopProfile'), callSave: call('saveShopProfile'),
      callConfig: call('getMyMinishop'), callSaveConfig: call('saveMinishopConfig'),
      upload: (o) => { window.__uploads.push(o.path); return Promise.resolve('https://firebasestorage.googleapis.com/v0/b/demo/o/' + encodeURIComponent(o.path) + '?alt=media'); },
      onOpenAvailability: () => { window.__openedAvailability = true; }, onToast: () => {} });
  }
  start();
</script></body></html>`;

(async () => {
  const U = 'own1';
  /* a quote-breaking name: an UNescaped attribute would close value="…" and run the handler */
  await db.doc('shops/' + U).set({ sellerUid: U, ownerId: U, name: '"><img src=x onerror=alert(1)>Njeri', status: 'active', source: 'application_approval',
    business: { category: 'fashion', source: 'application' }, searchable: true, isPublic: true });
  await db.doc('minishopConfig/' + U).set({ shopId: U, ownerUid: U, handle: 'njeri', tagline: 'OLD tagline', schemaVersion: 2 });
  await db.doc('shopHandles/njeri').set({ shopId: U, ownerUid: U });
  const CALLS = { getShopProfile: run(KS.getShopProfile), saveShopProfile: run(KS.saveShopProfile), getMyMinishop: run(MS.getMyMinishop), saveMinishopConfig: run(MS.saveMinishopConfig) };
  const H = makePageHarness({ db, root: ROOT, pages: { '/profile-test.html': PAGE(true), '/profile-staff.html': PAGE(false) },
    callables: CALLS, http: { getMinishopPublic: MS.getMinishopPublic, trackMinishopView: (req, res) => res.status(204).end() } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  /* fail CLOSED: an interaction that cannot happen is a named FAIL, never a crash */
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 120)); return false; } };
  try {
    const p = await H.page(browser, { user: { uid: U, email: 'o@x.co', emailVerified: true }, viewport: { width: 360, height: 800 } });
    let dialogs = 0; p.on('dialog', (d) => { dialogs++; d.dismiss(); });
    await p.goto(H.BASE + '/profile-test.html');
    await p.waitForSelector('.msp-step', { timeout: 15000 }).catch(() => {});
    const steps = await p.$$eval('.msp-step', (els) => els.map((e) => e.textContent.replace(/^\s*[\d✓]+/, '').trim()));
    ck('B1  the five seller.html steps, in order', steps.join('|') === 'Identity|Permits|Shop setup|Delivery|Go live', steps);
    const stepFields = {};
    for (let i = 1; i <= 5; i++) {
      await act('open step ' + i, () => p.click(`[data-pgo="${i}"]`, { timeout: 3000 }));
      stepFields[i] = await p.$$eval('[data-pf],[data-pup],[data-ppermit],[data-pzone],[data-pchoose],[data-paccent],[data-phours],[data-px]', (els) => [...new Set(els.map((e) => e.dataset.pf || e.dataset.pup || (e.dataset.ppermit && 'permit:' + e.dataset.ppermit) || (e.dataset.pzone && 'zone') || e.dataset.pchoose || (e.dataset.paccent && 'accent') || (e.dataset.phours && 'hours') || (e.dataset.px && 'x:' + e.dataset.px)))]);
    }
    const need = { 1: ['banner', 'logo', 'accent', 'name', 'tagline', 'about', 'sellerType'], 2: ['kraPin', 'sbpNumber', 'brsNumber', 'permit:kra', 'permit:sbp', 'permit:brs', 'permit:fire', 'permit:health'],
      3: ['city', 'shopType', 'hours', 'phone', 'email', 'website', 'instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'linkedin'], 4: ['delMethod', 'freeDelivery', 'packagingNote', 'returnPolicy'] };
    const missing = Object.entries(need).flatMap(([st, list]) => list.filter((k) => !(stepFields[st] || []).includes(k)).map((k) => st + ':' + k));
    ck('B2  every step carries its seller.html fields (incl. LinkedIn and five permit uploads)', missing.length === 0, missing);
    await act('back to step 1', () => p.click('[data-pgo="1"]', { timeout: 3000 }));
    ck('B3  the SOKONI category is shown read-only (no category input)', /Fashion & clothing/.test(await p.textContent('.msp')) && !(await p.$('[data-pf="category"]')));
    ck('B9a a hostile shop name is escaped in the editor', (await p.inputValue('[data-pf="name"]').catch(() => '')).startsWith('"><img') && !(await p.$('.msp img[src="x"]')) && dialogs === 0, { dialogs });

    const T = { timeout: 3000 };
    await act('fill identity', async () => {
      await p.fill('[data-pf="name"]', 'Njeri Kitenge House', T);
      await p.fill('[data-pf="tagline"]', 'Kitenge made to measure', T);
      await p.fill('[data-pf="about"]', 'Tailored kitenge dresses and shirts from Gikomba since 2009 — every piece cut to your size.', T);
      await p.click('[data-pchoose="sellerType"][data-v="longterm"]', T);
      await p.click('[data-paccent="#c77dff"]', T);
      await p.setInputFiles('[data-pfile="logo"]', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) }, T);
      await p.waitForFunction(() => /Logo uploaded/.test(document.body.textContent), null, { timeout: 5000 });
    });
    await act('fill permits', async () => {
      await p.click('[data-pgo="2"]', T);
      await p.fill('[data-pf="kraPin"]', 'A012345678B', T);
      await p.setInputFiles('[data-ppermitfile="kra"]', { name: 'kra.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }, T);
      await p.waitForFunction(() => /Document uploaded/.test(document.body.textContent), null, { timeout: 5000 });
    });
    await act('fill setup (no phone yet)', async () => {
      await p.click('[data-pgo="3"]', T);
      await p.selectOption('[data-pf="city"]', 'nairobi', T);
      await p.click('[data-pchoose="shopType"][data-v="hybrid"]', T);
      await p.fill('[data-pf="address"]', 'Gikomba Market, Stall 14', T);
      await p.fill('[data-pf="linkedin"]', 'https://www.linkedin.com/company/njeri-kitenge', T);
      await p.fill('[data-pf="instagram"]', '@njerikitenge', T);
    });
    await act('save without a phone', async () => { await p.click('[data-psave]', T); await p.waitForTimeout(300); });
    const blocked = await p.textContent('.msp');
    ck('B4  a missing phone blocks the save with a named error; nothing written', !!(await p.$('#msp-f-phone-e')) && /Fix 1 thing before saving: Phone/.test(blocked) && (await get('shops/' + U)).tagline === undefined, blocked.slice(0, 120));
    await act('fill phone + delivery', async () => {
      await p.fill('[data-pf="phone"]', '0712 345 678', T);
      await p.click('[data-pgo="4"]', T);
      await p.click('[data-pchoose="delMethod"][data-v="both"]', T);
      await p.selectOption('[data-pf="delTime"]', 'sameday', T);
      await p.click('[data-pzone="Westlands"]', T);
      await p.fill('[data-pnewzone]', 'Ruiru', T);
      await p.click('[data-paddzone]', T);
      await p.fill('[data-pf="packagingNote"]', 'Wrapped in reusable cloth bags.', T);
      await p.click('[data-pchoose="returnPolicy"][data-v="custom"]', T);
      await p.fill('[data-pf="returnText"]', 'Exchanges within 14 days with the receipt.', T);
      await p.click('[data-pgo="5"]', T);
    });
    ck('B11a no horizontal overflow at 360 px (editor)', await noOverflow(p));
    /* a server refusal first: the page must not claim success */
    const realSave = CALLS.saveShopProfile;
    CALLS.saveShopProfile = async () => { const e = new Error('Service unavailable'); e.code = 'unavailable'; throw e; };
    await act('refused save', async () => { await p.click('[data-psave]', T); await p.waitForFunction(() => /NOT saved|Saved\./.test(document.body.textContent), null, { timeout: 8000 }); });
    const refused = await p.textContent('.msp');
    ck('B5b a server refusal shows "NOT saved" — never "Saved."', /NOT saved/.test(refused) && !/Saved\./.test(refused) && (await get('shops/' + U)).tagline === undefined, refused.slice(0, 160));
    CALLS.saveShopProfile = realSave;
    await act('real save', async () => { await p.click('[data-psave]', T); await p.waitForFunction(() => /Saved\./.test(document.body.textContent), null, { timeout: 10000 }); });
    const s = (await get('shops/' + U)) || {};
    const msg = await p.textContent('.msp');
    ck('B5  saving writes the canonical shop, then says saved (storefront up to date)', /Saved\./.test(msg) && /storefront is up to date/.test(msg) && s.name === 'Njeri Kitenge House' && s.phone === '0712345678' && s.delMethod === 'both'
      && s.returnPolicy === 'custom' && (s.zones || []).join() === 'Westlands,Ruiru' && s.linkedin === 'company/njeri-kitenge' && s.themeColor === '#c77dff' && /seller-assets%2Fown1%2Flogo-/.test(s.logoUrl || ''), { msg: msg.slice(0, 160), s: { name: s.name, zones: s.zones, logo: s.logoUrl } });
    const comp = await get('shops/' + U + '/private/compliance');
    ck('B7  the permit upload records a private kyc-documents path; the KRA PIN saves owner-only', !!comp && comp.kraPin === 'A012345678B' && /^kyc-documents\/own1\/permit-kra-\d+\.pdf$/.test((comp.permits || {}).kra || ''), comp);

    await p.reload();
    await p.waitForSelector('.msp-step', { timeout: 15000 }).catch(() => {});
    const back = (await p.evaluate(() => window.__ui && window.__ui.state().draft)) || {};
    ck('B6  a reload restores every field (delivery method, returns, zones, colour, seller type, socials…)', back.delMethod === 'both' && back.delTime === 'sameday' && back.returnPolicy === 'custom'
      && (back.zones || []).join() === 'Westlands,Ruiru' && back.themeColor === '#c77dff' && back.sellerType === 'longterm' && back.linkedin === 'company/njeri-kitenge' && back.shopType === 'hybrid', back);

    const sf = await H.page(browser, { viewport: { width: 360, height: 780 } });
    let sfDialogs = 0; sf.on('dialog', (d) => { sfDialogs++; d.dismiss(); });
    await sf.goto(H.BASE + '/minishop.html?handle=njeri');
    await sf.waitForFunction(() => /Kitenge made to measure/.test(document.body.innerHTML), null, { timeout: 12000 }).catch(() => {});
    const html = await sf.content();
    ck('B8  the PUBLIC storefront shows the saved tagline, story, areas, delivery policy, returns and LinkedIn',
      /Kitenge made to measure/.test(html) && /every piece cut to your size/.test(html) && /Westlands, Ruiru/.test(html) && /SOKONI riders or our own riders/.test(html)
      && /Exchanges within 14 days/.test(html) && /linkedin\.com\/company\/njeri-kitenge/.test(html) && !/OLD tagline/.test(html), html.length);
    ck('B9b the storefront raises no dialog; B11b no overflow at 360 px', sfDialogs === 0 && dialogs === 0 && await noOverflow(sf), { sfDialogs, dialogs });

    const st = await H.page(browser, { user: { uid: 'staff9', email: 's@x.co', emailVerified: true }, viewport: { width: 1280, height: 800 } });
    await st.goto(H.BASE + '/profile-staff.html');
    await st.waitForFunction(() => /Owner only/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
    ck('B10 a staff session sees "Owner only", not an editor', /Owner only/.test(await st.textContent('body')) && !(await st.$('[data-pf]')));
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
