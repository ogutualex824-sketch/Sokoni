/* test-reputation-browser.js — followers, ratings, reviews, sharing and moderation in a REAL browser
 * (Chromium via Playwright) against the REAL server modules on the transactional fake Firestore.
 * No network, no production.
 *
 * PROVES
 *   logged-out  the storefront identity strip + reviews render; Follow sends to login (no write)
 *   buyer       Follow → Following (server count) → "let them see my first name" · Share copies a
 *               HANDLE link (no uid / phone / email) and counts one share event · rates a completed
 *               booking from "My reviews" · reports another person's review (rating unchanged)
 *   public      the review shows first name + initial and "Verified booking"; the page never holds a
 *               uid, booking id or contact
 *   provider    dashboard Audience (named only if the follower opted in) · Reputation · replies
 *               publicly (the rating is untouched) · Sharing
 *   AdminOS     Reviews & Reputation: reported queue → Hide with a reason → out of the public rating;
 *               the booking is untouched
 *   p.html      a share handle resolves to the public profile
 *   layout      no horizontal scroll at 360 and 1280
 *
 *   node scripts/test-reputation-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-rep-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;

const Path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const authApi = { getUser: async (u) => ({ uid: u, customClaims: {} }) };
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, storage: () => ({ bucket: () => ({}) }) };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => authApi });
stub('firebase-admin', ADMIN);
stub('./notify', { notify: async () => ({ ok: true }), TYPES: {} });

const REP = require(Path.join(FN, 'reputation.js'));
const BS = require(Path.join(FN, 'booking-service.js'));
const PO = require(Path.join(FN, 'provider-ops.js'));

const USERS = { b1: { uid: 'b1' }, b2: { uid: 'b2' }, ph1: { uid: 'ph1' }, adm: { uid: 'adm', claims: { admin: true } } };
const reqFor = (uid, data) => ({ auth: uid ? { uid, token: Object.assign({ email_verified: true }, (USERS[uid] && USERS[uid].claims) || {}) } : null, rawRequest: { headers: {} }, data });
const wire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x)));
const BOOKING_H = Object.assign({}, BS._h, REP._h);
const calls = [];
async function server(name, data, uid) {
  try {
    const op = data && data.op; calls.push(name + ':' + op);
    let h = null;
    if (name === 'bookingDispatch') h = BOOKING_H[op];
    else if (name === 'providerDispatch') h = PO._h[op];
    else if (name === 'adminOsDispatch') h = REP._adminH[op];
    if (!h) return { err: { code: 'not-found', message: 'unknown op ' + op } };
    return { ok: wire(await h(reqFor(uid, data))) };
  } catch (e) { return { err: { code: e.code || 'internal', message: e.message } }; }
}

const COMPAT = `
(function(){
  const call = (name) => async (data) => { const r = await window.__srv(name, data || {}, window.__user && window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; };
  const user = () => window.__user ? Object.assign({}, window.__user, { getIdTokenResult: async () => ({ claims: window.__user.claims || {} }) }) : null;
  window.firebase = { apps: [{}], initializeApp: () => ({}), auth: () => ({ get currentUser() { return user(); }, onAuthStateChanged(cb) { setTimeout(() => cb(user()), 0); return () => {}; } }),
    functions: () => ({ httpsCallable: (n) => call(n) }) };
})();`;
const PAGE = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>
  <style>body{background:#060a06;color:#eee;margin:0;padding:12px;font-family:system-ui}</style>
  <script>${COMPAT}</script><script src="/sokoni-reputation.js"></script></head><body>${body}</body></html>`;
const PAGES = {
  '/pp.html': PAGE('<h1>Jane Photography</h1><div id="rep"></div><section><h2>Reviews</h2><div id="revs"></div></section><script>window.ID = SokoniRep.identity(document.getElementById("rep"), { type: "provider", id: "ph1", name: "Jane Photography" }); window.RV = SokoniRep.reviews(document.getElementById("revs"), { type: "provider", id: "ph1" });</script>'),
  '/mine.html': PAGE('<div id="mine"></div><script>window.MINE = SokoniRep.myReviews(document.getElementById("mine"));</script>'),
  '/dash.html': PAGE('<div id="dash"></div><script>window.DASH = SokoniRep.dashboard(document.getElementById("dash"), { type: "provider", id: "ph1" });</script>'),
  '/provider-profile.html': '<!doctype html><title>profile</title><p id="arrived">profile</p>',
  '/login.html': '<!doctype html><title>login</title><p>login</p>',
};
const AOS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  (fs.readFileSync(Path.join(ROOT, 'admin-os.html'), 'utf8').match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('') +
  '</head><body style="background:#060a06;color:#eee;margin:0"><div id="host"></div><script src="/sokoni-aos-reputation.js"></script>' +
  '<script>window.SokoniAOSReputation.mount({ host: document.getElementById("host"), call: async (op, d) => { const r = await window.__srv("adminOsDispatch", Object.assign({ op: op }, d || {}), window.__user.uid); if (r.err) throw new Error(r.err.message); return r.ok; } });</script></body></html>';
const REAL = new Set(['/sokoni-reputation.js', '/sokoni-aos-reputation.js', '/p.html']);
const srv = http.createServer((rq, res) => {
  const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
  if (PAGES[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGES[p]); }
  if (p === '/aos.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(AOS_PAGE); }
  if (REAL.has(p)) { res.writeHead(200, { 'Content-Type': (p.endsWith('.html') ? 'text/html' : 'application/javascript') + '; charset=utf-8' }); return res.end(fs.readFileSync(Path.join(ROOT, p.slice(1)))); }
  if (['/sokoni-config.js', '/sokoni-appcheck.js', '/sw-register.js'].includes(p)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(''); }
  res.writeHead(404); res.end('');
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const H = 3600e3, DAY = 86400e3;
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const PRIVATE = /\bb1\b|\bb2\b|pbDone|pbNew|@x\.co|0712/;

async function seed() {
  await db.doc('users/b1').set({ displayName: 'Achieng Otieno', email: 'b1@x.co', phone: '0712000001' });
  await db.doc('users/b2').set({ displayName: 'Brian Kamau', email: 'b2@x.co', phone: '0712000002' });
  await db.doc('users/ph1').set({ displayName: 'Jane' });
  await db.doc('providers/ph1').set({ uid: 'ph1', name: 'Jane Photography', status: 'active', verified: true });
  const now = Date.now();
  const b = (id, cust, name) => db.doc('providerBookings/' + id).set({ providerId: 'ph1', customerUid: cust, customerName: name, service: 'Portrait session', serviceId: 's1', status: 'completed', paymentStatus: 'settled', startTs: now - 3 * DAY, endTs: now - 3 * DAY + 2 * H, price: 500000 });
  await b('pbDone', 'b2', 'Brian Kamau');
  await b('pbNew', 'b1', 'Achieng Otieno');
  await BS._h.bookingSubmitReview(reqFor('b2', { bookingId: 'pbDone', rating: 5, text: 'Lovely portraits, very professional' }));
}
async function wirePage(page, uid) {
  await page.exposeFunction('__srv', (name, data, u) => server(name, data, u));
  await page.addInitScript((u) => { window.__user = u; }, uid ? Object.assign({}, USERS[uid]) : null);
}

(async () => {
  await seed();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    /* ── logged-out, 360 ── */
    say('\n── logged-out storefront (360) ──');
    const cL = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const L = await cL.newPage(); await wirePage(L, null);
    await L.goto(BASE + '/pp.html');
    await L.waitForSelector('[data-follow]'); await L.waitForSelector('.skrep-card');
    const lt = await L.evaluate(() => document.body.innerText);
    ck('identity strip: 5.0 · 1 review · followers · Verified · Follow · Share', /5\.0/.test(lt) && /1 review\b/.test(lt) && /follower/.test(lt) && /Verified/.test(lt) && /Share/.test(lt), lt.slice(0, 160));
    ck('an unknown follower count renders "—", never an invented 0', /— followers/.test(lt) && !/\b0 followers/.test(lt));
    ck('the review shows "Brian K." and "Verified booking", with no report control while signed-out', /Brian K\./.test(lt) && /Verified booking/.test(lt) && !(await L.$('[data-report]')));
    ck('…the page never holds a uid, booking id, email or phone', !PRIVATE.test(await L.content()));
    ck('no horizontal scroll at 360 (storefront)', await noOverflow(L));
    await L.click('[data-follow]');
    await L.waitForURL(/login\.html\?next=/, { timeout: 5000 }).catch(() => {});
    ck('Follow while signed-out → login (nothing written)', /login\.html\?next=%2Fpp\.html/.test(L.url()) && !db._dump('follows/').length, L.url());

    /* ── buyer b1 (390): follow, show me, share, rate, report ── */
    say('\n── buyer ──');
    const cB = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const B = await cB.newPage(); await wirePage(B, 'b1');
    await B.goto(BASE + '/pp.html');
    await B.waitForSelector('[data-follow]');
    await B.click('[data-follow]');
    await B.waitForSelector('[data-follow][aria-pressed="true"]', { timeout: 6000 }).catch(() => {});
    ck('Follow → "Following", 1 follower from the SERVER count', (await B.textContent('[data-follow]')).trim() === 'Following' && /1 follower\b/.test(await B.textContent('[data-followers]')) && (await get('providers/ph1')).followerCount === 1);
    await B.check('[data-showme]');
    await B.waitForFunction(() => /first name/.test(document.querySelector('[data-msg]').textContent), null, { timeout: 5000 }).catch(() => {});
    ck('"Let them see my first name" is the follower\'s choice, stored by the server', (await get('follows/b1--provider--ph1')).showMe === true);
    await B.click('[data-share]');
    await B.waitForFunction(() => /mysokoni\.co\.ke/.test(document.querySelector('[data-msg]').textContent), null, { timeout: 5000 }).catch(() => {});
    const smsg = await B.textContent('[data-msg]');
    const clip = await B.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    ck('Share copies a HANDLE link — no uid, phone or email', /Link copied: https:\/\/mysokoni\.co\.ke\/p\.html\?h=[a-z0-9-]+$/.test(smsg.trim()) && clip === smsg.trim().replace('Link copied: ', '') && !/ph1|0712|@/.test(clip), smsg);
    await B.waitForTimeout(300);
    ck('…one share event; followers and rating unchanged', (await get('providers/ph1')).shareCount === 1 && (await get('providers/ph1')).followerCount === 1 && (await get('providers/ph1')).reviewCount === 1);
    await B.waitForSelector('[data-report]', { state: 'attached' });
    await B.click('.skrep-card details summary');
    await B.selectOption('[data-reason]', 'SPAM');
    await B.click('[data-report]');
    await B.waitForFunction(() => /does not change the rating/.test(document.body.textContent), null, { timeout: 5000 }).catch(() => {});
    ck('the buyer reports a review with a controlled reason → a moderation case; the rating is unchanged', db._dump('reports/').some((r) => r.entityId === 'pbDone' && r.reason === 'SPAM' && r.reportedBy === 'b1') && (await get('providers/ph1')).rating === 5);

    const M = await cB.newPage(); await wirePage(M, 'b1');
    await M.goto(BASE + '/mine.html');
    await M.waitForSelector('form[data-rate]');
    ck('"My reviews" offers the completed booking to rate', /Portrait session/.test(await M.textContent('form[data-rate]')));
    await M.click('form[data-rate] [data-star="4"]');
    await M.fill('form[data-rate] textarea', 'Great session, lovely light');
    await M.click('form[data-rate] button[type=submit]');
    await M.waitForFunction(() => /Your reviews/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => {});
    ck('posting the review → published, the aggregate moves on the server (5 + 4 → 4.5, 2 reviews)', (await get('providerReviews/pbNew') || {}).rating === 4 && (await get('providers/ph1')).reviewCount === 2 && (await get('providers/ph1')).rating === 4.5);
    ck('…and it now shows under "Your reviews" with an Edit option', /Your reviews/.test(await M.textContent('body')) && /Edit/.test(await M.textContent('body')));

    /* ── provider dashboard (768) ── */
    say('\n── provider dashboard ──');
    const cP = await browser.newContext({ viewport: { width: 768, height: 1000 } });
    const P = await cP.newPage(); await wirePage(P, 'ph1');
    await P.goto(BASE + '/dash.html');
    await P.waitForSelector('.skrep-kpi');
    const pt = await P.evaluate(() => document.body.innerText);
    ck('Audience: 1 follower, shown by name as "Achieng O." (she opted in) — no contact', /Followers\s*1/.test(pt) && /Achieng O\./.test(pt) && !/@x\.co|0712|\bb1\b/.test(await P.content()));
    ck('Reputation: 4.5 ★ · 2 reviews · 1 needs attention (reported)', /4\.5 ★/.test(pt) && /Reviews\s*2/.test(pt) && /Needs attention\s*1/.test(pt), pt.slice(0, 300));
    ck('Sharing: 1 share event, explained as not a follower or rating', /Share events\s*1/.test(pt) && /not a follower and not a rating/.test(pt));
    await P.fill('form[data-reply] textarea', 'Thank you Achieng!');
    await P.click('form[data-reply] button[type=submit]');
    await P.waitForFunction(() => /Your reply: Thank you Achieng!/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => {});
    const replied = db._dump('providerReviews/').find((r) => r.reply);
    ck('the provider replies publicly; the customer\'s rating and text are untouched', !!replied && replied.reply === 'Thank you Achieng!' && ((replied.rating === 4 && /lovely light/.test(replied.text)) || (replied.rating === 5 && /Lovely portraits/.test(replied.text))));
    await B.reload(); await B.waitForSelector('.skrep-card');
    ck('the public page shows "Response from the provider"', /Response from the provider/.test(await B.textContent('body')));

    /* ── AdminOS (1280) ── */
    say('\n── AdminOS › Reviews & Reputation ──');
    const cA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const A = await cA.newPage(); await wirePage(A, 'adm');
    await A.goto(BASE + '/aos.html');
    await A.waitForSelector('button[data-mod="hide"]', { timeout: 8000 }).catch(() => {});
    const at = await A.evaluate(() => document.body.innerText);
    ck('the reported queue lists the review with its report reason and its experience source', /Lovely portraits/.test(at) && /SPAM/.test(at) && /providerBookings\/pbDone/.test(at), at.slice(0, 200));
    await A.click('button[data-mod="hide"]');
    await A.fill('.aoscr-ask textarea', 'Reviewed: keeping the page clean for the test');
    await A.click('.aoscr-ask button:not(.aos-btn-ghost)');
    await A.waitForFunction(() => /Done \(audited\)/.test(document.body.textContent), null, { timeout: 6000 }).catch(() => {});
    ck('Hide with a reason → hidden, out of the public rating (only 4★ remains), audited', (await get('providerReviews/pbDone')).status === 'hidden' && (await get('providers/ph1')).reviewCount === 1 && (await get('providers/ph1')).rating === 4 && db._dump('reputationAudit/').some((x) => x.action === 'review_hide' && x.actor === 'adm'));
    ck('…the booking behind it is untouched', (await get('providerBookings/pbDone')).status === 'completed' && (await get('providerBookings/pbDone')).paymentStatus === 'settled');
    ck('no horizontal scroll at 1280 (AdminOS)', await noOverflow(A));
    await L.goto(BASE + '/pp.html'); await L.waitForSelector('.skrep-card');
    ck('the logged-out storefront no longer shows the hidden review', !/Lovely portraits/.test(await L.textContent('body')) && /lovely light/.test(await L.textContent('body')));

    /* ── p.html resolves a handle ── */
    say('\n── share link resolver ──');
    const handle = (await REP._h.repShareLink(reqFor(null, { type: 'provider', id: 'ph1' }))).url.split('h=')[1];
    const R = await cL.newPage(); await wirePage(R, null);
    await R.route(/gstatic\.com/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: route.request().url().includes('app-compat') ? COMPAT : '' }));
    await R.goto(BASE + '/p.html?h=' + handle);
    await R.waitForURL(/provider-profile\.html/, { timeout: 6000 }).catch(() => {});
    ck('p.html?h=<handle> lands on the public profile by HANDLE (no uid in the address bar)', R.url().endsWith('/provider-profile.html?h=' + handle), R.url());
    await R.goto(BASE + '/p.html?h=<script>');
    ck('an invalid handle shows "not valid", never a raw echo', /not valid/.test(await R.textContent('body')));

    /* ── 360 / 1280 layout for the buyer + provider surfaces ── */
    for (const [w, h] of [[360, 780], [1280, 900]]) {
      for (const path of ['/pp.html', '/mine.html', '/dash.html']) {
        const c = await browser.newContext({ viewport: { width: w, height: h } });
        const pg = await c.newPage(); await wirePage(pg, path === '/dash.html' ? 'ph1' : 'b1');
        await pg.goto(BASE + path); await pg.waitForSelector('.skrep', { timeout: 6000 }); await pg.waitForTimeout(250);
        ck(`no horizontal scroll at ${w} (${path})`, await noOverflow(pg));
        await c.close();
      }
    }
  } finally { await browser.close(); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
