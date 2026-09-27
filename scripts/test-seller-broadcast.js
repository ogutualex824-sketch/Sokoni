/* test-seller-broadcast.js — a shop's announcement to its followers is sent AS the shop the caller OWNS, never as
 * whoever the caller claims to be (CHANGELOG 212). Real modules on the transactional fake Firestore; notify.js and
 * FCM are captured, never called. No network, no production.
 *
 * PROVES
 *   identity     the sender is the caller's own shop (shops.sellerUid == auth uid): its NAME and PAGE come from the
 *                shop record — a forged sellerUid / shopId / businessId / sender name / logo / link in the payload
 *                changes nothing; another seller's shopId is refused; unauthenticated refused; no shop → refused;
 *                two shops and no choice → refused (never a guess); a suspended shop cannot broadcast
 *   audience     only the shop's canonical followers (follows type 'shop'); never the owner; never a follower of a
 *                DISPLAY NAME; delivered through notify.js on the opt-in promotions type, with a stable dedupe key
 *   abuse        3 a day, enforced in the same transaction as the post — 5 concurrent sends → exactly 3
 *   retired path the legacy onSellerBroadcast trigger sends NOTHING (no FCM) and records a security event; the
 *                client writer throws; the name-keyed listener is inert
 *   browser      the REAL seller.html (360 · 1280): Send reaches the owner-verified callable; a forged local
 *                display name never reaches a follower; a user with no shop is told so and nothing is sent; the
 *                4th send of the day is refused with a clear message; no caller-chosen link field
 *
 *   node scripts/test-seller-broadcast.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-seller-broadcast';
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
const fcm = [];
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), storage: () => ({ bucket: () => ({}) }),
  messaging: () => ({ sendEachForMulticast: async (m) => { fcm.push(m); return { successCount: m.tokens.length }; }, send: async (m) => { fcm.push(m); } }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', ADMIN);
const sent = [];
stub('./notify', { notify: async (n) => { sent.push(n); return { ok: true }; }, TYPES: require(Path.join(FN, 'notify.js')).TYPES });

const V3 = require(Path.join(FN, 'minishop-v3.js'));
const { makePageHarness } = require('./lib/page-harness.js');
const send = (uid, data) => V3._sendAnnouncement({ auth: uid ? { uid, token: {} } : null, data: data || {}, rawRequest: { headers: {} } });
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  await db.doc('shops/sellerA').set({ sellerUid: 'sellerA', name: 'Mama Mboga Fresh', logo: 'https://cdn.mysokoni.co.ke/a.png', status: 'active' });
  await db.doc('minishopConfig/sellerA').set({ handle: 'mamamboga', shopId: 'sellerA' });
  await db.doc('shops/sellerB').set({ sellerUid: 'sellerB', name: 'Kiondo Crafts', status: 'active' });
  await db.doc('shops/legacyC').set({ sellerUid: 'sellerC', name: 'Legacy Shop', status: 'active' });
  await db.doc('shops/multi1').set({ sellerUid: 'multi', name: 'Multi One', status: 'active' });
  await db.doc('shops/multi2').set({ sellerUid: 'multi', name: 'Multi Two', status: 'active' });
  await db.doc('shops/susp').set({ sellerUid: 'suspU', name: 'Gone', status: 'suspended' });
  for (const u of ['f1', 'f2', 'f3']) await db.doc(`follows/${u}--shop--sellerA`).set({ uid: u, type: 'shop', entityId: 'sellerA', via: 'server' });
  await db.doc('follows/sellerA--shop--sellerA').set({ uid: 'sellerA', type: 'shop', entityId: 'sellerA', via: 'server' });      /* a stray self-follow */
  await db.doc('follows/g1--shop--sellerB').set({ uid: 'g1', type: 'shop', entityId: 'sellerB', via: 'server' });
  await db.doc('follows/n1--seller--Mama_Mboga_Fresh').set({ uid: 'n1', type: 'seller', entityId: 'Mama Mboga Fresh' });        /* a name follow */

  say('\n── identity: the caller\'s OWN shop, from its record ──');
  const r1 = await send('sellerA', { title: 'Weekend sale', message: '30% off sukuma', sellerName: 'Safaricom PLC', sellerUid: 'sellerB', businessId: 'safaricom', logo: 'https://evil.example/logo.png', url: 'javascript:alert(1)', senderName: 'M-PESA' });
  ck('the owner sends: the announcement is posted to THEIR shop', r1.success && r1.shopId === 'sellerA' && !!(await db.doc(`minishopAnnouncements/sellerA/posts/${r1.announcementId}`).get()).exists);
  ck('every follower is notified AS the shop record says ("Mama Mboga Fresh: …"), not as the forged "Safaricom" / "M-PESA"', sent.length === 3 && sent.every((n) => n.title === 'Mama Mboga Fresh: Weekend sale' && !/Safaricom|M-PESA/.test(JSON.stringify(n))), sent.map((n) => n.title));
  ck('…the destination is the shop\'s own page — the caller\'s javascript: link / logo never travel', sent.every((n) => n.deepLink === '/shop/mamamboga' && !/javascript|evil\.example/.test(JSON.stringify(n))));
  ck('…through notify.js on the opt-in promotions type, with a stable per-follower dedupe key', sent.every((n) => n.type === 'shop_announcement' && n.dedupeKey === `shop_ann_${r1.announcementId}_${n.uid}`) && require(Path.join(FN, 'notify.js')).TYPES.shop_announcement.priority === 'marketing');
  ck('audience = canonical shop followers only: not the owner, not a DISPLAY-NAME follower, not another shop\'s', sent.map((n) => n.uid).sort().join() === 'f1,f2,f3' && r1.recipients === 3);
  ck('the stored post carries the server\'s identity only (createdBy = auth uid; no forged fields)', (() => { const p = db._dump('minishopAnnouncements/sellerA/posts/')[0]; return p.createdBy === 'sellerA' && !('sellerName' in p) && !('url' in p) && !('logo' in p); })());
  sent.length = 0;
  ck('a forged shopId (another seller\'s shop) is refused, nothing sent', (await code(send('sellerA', { shopId: 'sellerB', title: 'Hi there', message: 'fake from B' }))) === 'permission-denied' && sent.length === 0);
  ck('a seller with a legacy shop id sends as that shop (resolved by sellerUid)', (await send('sellerC', { title: 'Open today', message: 'Come by' })).shopId === 'legacyC');
  ck('unauthenticated is refused', (await code(send(null, { title: 'Hi there', message: 'x x' }))) === 'unauthenticated');
  ck('a user with no shop is refused (never a guess)', (await code(send('nobody', { title: 'Hi there', message: 'x x' }))) === 'not-found');
  ck('two shops and no choice → refused (ambiguous, never a guess)', (await code(send('multi', { title: 'Hi there', message: 'x x' }))) === 'failed-precondition');
  ck('…choosing one of their OWN shops works', (await send('multi', { shopId: 'multi2', title: 'Hi there', message: 'x x' })).shopId === 'multi2');
  ck('a suspended shop cannot broadcast', (await code(send('suspU', { title: 'Hi there', message: 'x x' }))) === 'failed-precondition');
  ck('a malformed shopId is refused', (await code(send('sellerA', { shopId: '../sellerB', title: 'Hi there', message: 'x x' }))) === 'invalid-argument');

  say('\n── abuse: 3 a day, one transaction ──');
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => send('sellerB', { title: 'Offer ' + i, message: 'Crafts ' + i }).then(() => 'ok').catch((e) => e.code)));
  ck('5 CONCURRENT sends → exactly 3 posted, 2 refused (resource-exhausted)', rs.filter((x) => x === 'ok').length === 3 && rs.filter((x) => x === 'resource-exhausted').length === 2, rs);
  ck('…and exactly 3 posts exist', db._dump('minishopAnnouncements/sellerB/posts/').length === 3);

  say('\n── the retired path ──');
  const IX = fs.readFileSync(Path.join(FN, 'index.js'), 'utf8');
  const trig = IX.slice(IX.indexOf('exports.onSellerBroadcast'), IX.indexOf('exports.onSellerBroadcast') + 2200);
  ck('the legacy trigger never reads followers or sends FCM', !/collection\("follows"\)/.test(trig) && !/sendEachForMulticast/.test(trig) && /securityEvents/.test(trig));
  /* executed, not only read: the trigger body run against a forged legacy document */
  const bStart = trig.indexOf('async (event) => {'); const bEnd = trig.indexOf('\n  }\n);', bStart);
  const body = trig.slice(bStart, bEnd + 4);
  const run = new Function('db', 'admin', 'console', 'return ' + body)(db, ADMIN, { warn() {}, log() {} });
  await run({ params: { sellerName: 'Mama Mboga Fresh' }, data: { ref: { path: 'sellerBroadcasts/Mama Mboga Fresh/broadcasts/x' }, data: () => ({ title: 'FREE MONEY', url: 'javascript:alert(1)', sellerUid: 'attacker' }) } });
  ck('…run against a forged legacy document: NO FCM sent, a security event recorded', fcm.length === 0 && db._dump('securityEvents/').some((e) => e.type === 'seller_broadcast_retired_path' && e.sellerUid === 'attacker'));
  const SDB = fs.readFileSync(Path.join(ROOT, 'sokoni-db.js'), 'utf8');
  ck('the client writer is retired (throws, never writes)', /async saveSellerBroadcast\(\) \{ throw /.test(SDB));
  const SCR = fs.readFileSync(Path.join(ROOT, 'script.js'), 'utf8');
  ck('the name-keyed listener (HTML + caller link in every follower\'s browser) is inert', /\(function initBroadcastListener\(\)\{\s*\/\*[\s\S]*?\*\/\s*return;/.test(SCR));
  const SJ = fs.readFileSync(Path.join(ROOT, 'seller.js'), 'utf8');
  const fnSrc = SJ.slice(SJ.indexOf('async function sendSellerBroadcast'), SJ.indexOf('window.sendSellerBroadcast'));
  ck('the seller dashboard sends only title + message to the owner-verified callable (no name, uid, link from the page)', /miniShopSendAnnouncement/.test(fnSrc) && !/sellerName|sellerUid|pushUrl|localStorage/.test(fnSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
  const SH = fs.readFileSync(Path.join(ROOT, 'seller.html'), 'utf8');
  ck('…and its form has no caller-chosen link field any more', !/id="pushUrl"/.test(SH));

  say('\n── browser: the REAL seller.html ──');
  await db.doc('shops/sellerD').set({ sellerUid: 'sellerD', name: 'Duka la Dada', status: 'active' });
  await db.doc('follows/h1--shop--sellerD').set({ uid: 'h1', type: 'shop', entityId: 'sellerD', via: 'server' });
  const HAR = makePageHarness({ db, root: ROOT, callables: { miniShopSendAnnouncement: V3._sendAnnouncement } });
  await HAR.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const signedIn = (uid, name, vp) => HAR.page(browser, { user: { uid, email: uid + '@x.co', emailVerified: true }, viewport: vp,
    storage: { loggedIn: 'true', sokoniUser: JSON.stringify({ uid, email: uid + '@x.co', role: 'seller', name }) } });
  const sendFromPage = async (pg, t, m) => { await pg.evaluate(([a, b]) => { document.getElementById('pushTitle').value = a; document.getElementById('pushBody').value = b; }, [t, m]); await pg.evaluate(() => sendSellerBroadcast()); await pg.waitForTimeout(300); return pg.evaluate(() => document.getElementById('pushBroadcastStatus').textContent); };   /* the push panel lives in a hidden dashboard tab */
  try {
    for (const vp of [{ width: 360, height: 780 }, { width: 1280, height: 900 }]) {
      sent.length = 0;
      const P = await signedIn('sellerD', 'Safaricom PLC', vp);   /* the local display name is FORGED */
      await P.goto(HAR.BASE + '/seller.html');
      await P.waitForFunction(() => typeof sendSellerBroadcast === 'function' && document.getElementById('pushTitle'), null, { timeout: 12000 }).catch(() => {});
      const st = await sendFromPage(P, 'Fresh stock', 'Mangoes are in');
      ck(`${vp.width}: Send → the follower hears from the SHOP RECORD ("Duka la Dada"), never the forged local name`, sent.length === 1 && sent[0].uid === 'h1' && sent[0].title === 'Duka la Dada: Fresh stock' && !/Safaricom/.test(JSON.stringify(sent)), sent.map((n) => n.title));
      ck(`${vp.width}: success is shown only after the server confirmed, with the real reach`, /Sent at .* · 1 follower/.test(st), st);
      ck(`${vp.width}: the form has no caller-chosen link field`, !(await P.$('#pushUrl')));
      ck(`${vp.width}: with the Marketing page open, the push panel fits (no horizontal scroll inside it)`, await P.evaluate(() => { showDashPage('marketing'); const s = document.getElementById('pushSendBtn').closest('div[style*="border-top"]'); return !!s && s.clientWidth > 100 && s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; }));
      ck(`${vp.width}: no page errors from the send path`, !P.__errors.some((e) => /sendSellerBroadcast|miniShopSendAnnouncement/.test(e)), P.__errors.slice(0, 2));
      await P.__ctx.close();
    }
    const P2 = await signedIn('sellerD', 'Dada', { width: 390, height: 844 });
    await P2.goto(HAR.BASE + '/seller.html');
    await P2.waitForFunction(() => typeof sendSellerBroadcast === 'function', null, { timeout: 12000 }).catch(() => {});
    const third = await sendFromPage(P2, 'Third', 'Third one today');
    sent.length = 0;
    const fourth = await sendFromPage(P2, 'Fourth', 'Fourth one today');
    ck('the 4th send of the day is refused with a clear message and reaches nobody', /Sent at/.test(third) && /3 announcements a day/.test(fourth) && sent.length === 0, [third, fourth]);
    const X = await signedIn('attacker', 'Mama Mboga Fresh', { width: 390, height: 844 });   /* claims a real shop's name */
    await X.goto(HAR.BASE + '/seller.html');
    await X.waitForFunction(() => typeof sendSellerBroadcast === 'function', null, { timeout: 12000 }).catch(() => {});
    sent.length = 0;
    const xs = await sendFromPage(X, 'FREE MONEY', 'Send your PIN to claim');
    ck('a signed-in user with NO shop, claiming a real shop\'s name, is told to set up a shop — NOBODY is notified', /Set up your shop first/.test(xs) && sent.length === 0, xs);
  } finally { await browser.close(); HAR.stop(); }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
