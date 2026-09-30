/* test-withdrawal-browser.js — withdrawal forms certified in a REAL browser.
 *
 * Chromium loads the REAL wallet.html (+ sokoni-wallet-v2.js), the REAL
 * provider-dashboard.html, and the REAL sokoni-merchant-wallet.js, each with the
 * REAL sokoni-payout-intent.js. Only infrastructure is stubbed (auth guard,
 * header, Firebase SDK). Every callable the page makes is routed to Node, where
 * the REAL functions/wallet.js requestSellerPayout runs on the transactional fake
 * Firestore with a COUNTING B2C adapter — so "one payout, one provider call" is
 * counted, not assumed. No network, no provider, no production.
 *
 *   W1 double click · W2 two tabs · W3 reload after a lost response ·
 *   W4 retry after a definitive refusal · W5 outcome unknown
 *
 * SOKONI Secure Release (2026-09-30, owner decision): the premium wallet is the ONE withdrawal surface. It always asks
 * for the wallet PIN (answered here by the harness); the server runs in ONE-KEY mode (config secureRelease:false) so
 * "one provider execution per request" stays measurable — Secure Release's own two-key flow is certified by
 * test-secure-release*.js. The provider dashboard and the merchant wallet no longer submit withdrawals: their Withdraw
 * opens the one wallet (profile.html#wallet:withdraw), proven below.
 *
 *   node scripts/test-withdrawal-browser.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-withdrawal-browser';
process.env.INTASEND_PRIVATE_KEY = 'harness';
const Path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub('./redis-rate-limiter', { checkRateLimit: async () => true });
stub('./finos-utils', { intasendB2C: async () => { throw new Error('legacy'); } });
let MODE = 'ok'; const sends = [];
stub('./payment-adapters', { getAdapter: () => ({ sendMoneyB2C: async (a) => {
  sends.push({ ref: a.ref, mode: MODE });
  await new Promise((r) => setTimeout(r, 40));
  if (MODE === 'timeout') throw new Error('socket hang up ETIMEDOUT');
  return { tracking_id: 'TRK' + sends.length, status: 'Confirming balance' };
} }) });
const W = require(Path.join(FN, 'wallet.js'));

/* ── the "server": the page's callables → real wallet.js ── */
const keysSeen = [];
let LOSE_NEXT_RESPONSE = false;
async function server(name, data, uid) {
  try {
    if (name === 'requestSellerPayout') {
      keysSeen.push({ uid, key: data.idempotencyKey || null });
      const r = await W.requestSellerPayout.run({ auth: { uid, token: {} }, data });
      if (LOSE_NEXT_RESPONSE) { LOSE_NEXT_RESPONSE = false; return { err: { code: 'unavailable', message: 'network lost (harness)' } }; }
      return { ok: r };
    }
    if (name === 'walletV2Dashboard' || name === 'getWalletBalance') {
      const w = (await db.doc('wallets/' + uid).get()).data() || {};
      return { ok: { balance: w.balance || 0, pendingPayout: w.pendingPayout || 0, hasPin: true, currency: 'KES' } };   /* the wallet has a PIN (Secure Release UI always asks) */
    }
    return { ok: {} };
  } catch (e) { return { err: { code: e.code || 'internal', message: e.message } }; }
}

/* ── static server: real pages + scripts under test; everything else stubbed ── */
const REAL = new Set(['/wallet.html', '/provider-dashboard.html', '/sokoni-wallet-v2.js', '/sokoni-payout-intent.js', '/sokoni-merchant-wallet.js']);
const FIREBASE_COMPAT = `
(function(){
  const chain = () => new Proxy(function(){}, { get: (t, k) => k === 'then' ? undefined : (k === 'get' ? async () => ({ docs: [], empty: true, size: 0, exists: false, data: () => ({}), forEach(){} }) : (k === 'onSnapshot' ? () => () => {} : chain())), apply: () => chain() });
  const call = (name) => async (data) => { const r = await window.__srv(name, data || {}, window.__user.uid); if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; };
  window.firebaseApp = {};
  window.firebase = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
    auth: () => ({ currentUser: window.__user, onAuthStateChanged(cb) { setTimeout(() => cb(window.__user), 0); return () => {}; }, signOut: async () => {} }),
    functions: () => ({ httpsCallable: (n) => call(n) }),
    firestore: Object.assign(() => chain(), { FieldValue: { serverTimestamp: () => null, increment: () => null }, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }),
    storage: () => chain(), messaging: () => chain(), appCheck: () => chain() };
})();`;
const MODS = {
  'firebase-auth.js': `export const getAuth = () => ({ currentUser: window.__user });
    export function onAuthStateChanged(a, cb) { setTimeout(() => cb(window.__user), 0); return () => {}; }
    export function RecaptchaVerifier() {} export async function linkWithPhoneNumber() {}`,
  'firebase-functions.js': `export const getFunctions = () => ({});
    export function httpsCallable(f, name) { return async (data) => { const r = await window.__srv(name, data || {}, window.__user.uid);
      if (r.err) { const e = new Error(r.err.message); e.code = 'functions/' + r.err.code; throw e; } return { data: r.ok }; }; }`,
  'firebase-firestore.js': `export const getFirestore = () => ({}); export const doc = () => ({}); export const collection = () => ({});
    export const query = () => ({}); export const where = () => ({}); export const limit = () => ({}); export const orderBy = () => ({});
    export function onSnapshot() { return () => {}; } export async function getDocs() { return { docs: [], empty: true, size: 0, forEach() {} }; }
    export async function getDoc() { return { exists: () => false, data: () => ({}) }; }`,
};
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/firebase.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(FIREBASE_COMPAT); }
  if (p === '/merchant-harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body><div id="host"></div><script src="/sokoni-payout-intent.js"></script><script src="/sokoni-merchant-wallet.js"></script></body></html>');
  }
  if (REAL.has(p)) {
    res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/javascript' });
    return res.end(fs.readFileSync(Path.join(ROOT, p.slice(1))));
  }
  if (/\.m?js$/.test(p)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('/* stubbed infrastructure */'); }
  if (/\.css$/.test(p)) { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(''); }
  res.writeHead(404); res.end();
});

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
const payoutsOf = async (uid) => (await db.collection('payoutRequests').where('sellerUid', '==', uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
/* The real risk engine routes a seller with an ACTIVE payout to admin review (no
   provider call). Phases that need the instant path first settle the earlier
   payouts, exactly as the provider webhook would. */
const settleAll = async (uid) => {
  for (const p of await payoutsOf(uid)) if (!['paid', 'failed', 'rejected'].includes(p.status)) {
    await db.doc('payoutRequests/' + p.id).update({ status: 'paid' });
    await db.doc('wallets/' + uid).update({ pendingPayout: F.FieldValue.increment(-p.amount) });
  }
};

(async () => {
  await db.doc('config/payouts').set({ secureRelease: false, enabled: true, autoB2C: true, requirePin: false, instantLimit: 100000, dailyLimit: 1000000, holdNewSellersDays: 0, maxPayoutsPerDay: 50, scheduledAbove: 0 });
  const mkUser = async (u, bal) => { await db.doc('wallets/' + u).set({ balance: bal }); await db.doc('users/' + u).set({ accountStatus: 'active', payoutVerified: true, createdAt: F.Timestamp.fromMillis(Date.now() - 90 * 86400000) }); };
  for (const u of ['wu1', 'wu2', 'pu1', 'mu1']) await mkUser(u, 5000);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const ctxFor = async (user) => {
    const c = await browser.newContext();
    await c.exposeBinding('__srv', async (_src, name, data, uid) => server(name, data, uid));
    await c.addInitScript((u) => { window.__user = u; }, user);
    /* Playwright: a LATER route wins — the catch-all first, the SDK stubs after it. */
    await c.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await c.route(/gstatic\.com\/firebasejs\/.*\/([a-z-]+\.js)$/, (route) => {
      const f = route.request().url().split('/').pop();
      route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: MODS[f] || 'export {};' });
    });
    return c;
  };
  try {
    /* ═══ wallet.html (Creator royalty withdrawals) ═══ */
    say('\n── wallet.html (Creator royalties are withdrawn here) ──');
    const wc = await ctxFor({ uid: 'wu1', phoneNumber: '+254712345678', displayName: 'Wanjiku' });
    const openWallet = async (page) => {
      await page.goto(BASE + '/wallet.html');
      await page.waitForFunction(() => window.W2 && typeof window.W2.requestPayout === 'function', null, { timeout: 15000 });
      await page.waitForTimeout(400);                                            /* dashboard loaded (walletV2Dashboard) */
      await page.evaluate(() => {
        if (!window.__pinAnswerer) window.__pinAnswerer = setInterval(() => {
          const o = document.querySelector('#ovlPinVerify.open'), i = document.getElementById('pinVerifyInput');
          if (o && i && !i.value) { i.value = '4829'; i.dispatchEvent(new Event('input')); }
        }, 40);
      });
      await page.evaluate(() => { window.W2.openWithdraw(); });
      await page.evaluate(() => {
        document.getElementById('wdrAmount').value = '500';
        const m = document.getElementById('wdrMethod'); if (m) m.value = 'mpesa';
        document.getElementById('wdrPhone').value = '0712345678';
      });
    };
    const pa = await wc.newPage();
    await openWallet(pa);
    let n0 = sends.length;
    const k0 = keysSeen.length;
    await pa.evaluate(() => { window.W2.requestPayout(); window.W2.requestPayout(); });   /* not awaited: two taps */
    for (let i = 0; i < 60 && !(await payoutsOf('wu1')).length; i++) await pa.waitForTimeout(100);
    await pa.waitForTimeout(600);
    let pw = await payoutsOf('wu1');
    ck('W1 double click → ONE payout', pw.length === 1, pw.map((p) => p.id));
    ck('W1 → ONE provider execution', sends.length - n0 === 1, sends.length - n0);
    ck('W1 the second tap is ignored while the PIN prompt is open → ONE request reached the server', keysSeen.length - k0 === 1, keysSeen.slice(k0));
    ck('W1 the key is released after the success (localStorage slot cleared)', await pa.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('sk_payout_intent_wu1_500_'))));

    /* W2 — two tabs, same user / amount / destination */
    const pb = await wc.newPage(); await settleAll('wu1'); await openWallet(pb); await openWallet(pa);
    n0 = sends.length;
    await Promise.all([pa.evaluate(() => window.W2.requestPayout()), pb.evaluate(() => window.W2.requestPayout())]);
    pw = await payoutsOf('wu1');
    ck('W2 two tabs submitting together → ONE new payout (2 total)', pw.length === 2, pw.map((p) => p.id));
    ck('W2 → ONE provider execution', sends.length - n0 === 1, sends.length - n0);

    /* W3 — reload after the server created the payout but the answer was lost */
    await settleAll('wu1'); await openWallet(pa);
    LOSE_NEXT_RESPONSE = true; n0 = sends.length;
    await pa.evaluate(() => window.W2.requestPayout());
    const keyKept = await pa.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sk_payout_intent_wu1_500_')).length === 1);
    ck('W3 lost answer (unavailable) → the key is KEPT', keyKept);
    await pa.reload(); await openWallet(pa);
    await pa.evaluate(() => window.W2.requestPayout());
    pw = await payoutsOf('wu1');
    const last2 = keysSeen.slice(-2).map((k) => k.key);
    ck('W3 after reload the retry carries the SAME key', last2[0] === last2[1] && !!last2[0], last2);
    ck('W3 → still ONE payout for that intent (3 total), ONE provider execution', pw.length === 3 && sends.length - n0 === 1, { payouts: pw.length, sends: sends.length - n0 });

    /* W4 — a definitive refusal releases the key; the retry is a NEW intent */
    await db.doc('payoutVelocity/wu1').set({ date: new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10), count: 50 });
    await openWallet(pa);
    await pa.evaluate(() => window.W2.requestPayout());
    const refusedKey = keysSeen[keysSeen.length - 1].key;
    ck('W4 definitive refusal (resource-exhausted) → key released', await pa.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('sk_payout_intent_wu1_500_'))));
    await db.doc('payoutVelocity/wu1').set({ date: '2000-01-01', count: 0 });
    await openWallet(pa);
    await pa.evaluate(() => window.W2.requestPayout());
    pw = await payoutsOf('wu1');
    ck('W4 the retry is a NEW intent (new key) and creates the payout', keysSeen[keysSeen.length - 1].key !== refusedKey && pw.length === 4, { payouts: pw.length });

    /* W5 — outcome unknown */
    await settleAll('wu1'); MODE = 'timeout'; n0 = sends.length;
    await openWallet(pa);
    await pa.evaluate(() => window.W2.requestPayout());
    pw = await payoutsOf('wu1');
    const unk = pw.filter((p) => p.status === 'outcome_unknown');
    const ui = await pa.evaluate(() => ({ title: (document.querySelector('#wdrSuccess h3') || {}).textContent || '', msg: (document.getElementById('wdrSuccessMsg') || {}).textContent || '' }));
    ck('W5 payout parked at outcome_unknown after ONE provider call', unk.length === 1 && sends.length - n0 === 1, { unk: unk.length, sends: sends.length - n0 });
    ck('W5 UI says the funds are being confirmed (never "sent")', /Confirming your payout/.test(ui.title) && /being confirmed/.test(ui.msg) && !/sent successfully/.test(ui.title), ui);
    ck('W5 the key is RETAINED (intent not concluded)', await pa.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sk_payout_intent_wu1_500_'))));
    MODE = 'ok'; n0 = sends.length;
    await openWallet(pa);
    await pa.evaluate(() => window.W2.requestPayout());
    ck('W5 retry → the SAME payout identity (deduplicated), NO new provider request', (await payoutsOf('wu1')).length === 5 && sends.length - n0 === 0 && keysSeen[keysSeen.length - 1].key === keysSeen[keysSeen.length - 2].key);
    ck('W5 only the Super Admin evidence path can end it (the page calls nothing else)', !/adminResolvePayoutOutcome|adminProcessPayout/.test(fs.readFileSync(Path.join(ROOT, 'sokoni-wallet-v2.js'), 'utf8')));
    await wc.close();

    /* ═══ provider-dashboard.html — Withdraw opens the ONE wallet (Secure Release, owner decision 2026-09-30) ═══ */
    say('\n── provider-dashboard.html ──');
    const pc = await ctxFor({ uid: 'pu1', phoneNumber: '+254722222222', displayName: 'Pro' });
    const q1 = await pc.newPage();
    await q1.goto(BASE + '/provider-dashboard.html');
    await q1.waitForFunction(() => typeof W !== 'undefined' && typeof W.withdraw === 'function', null, { timeout: 15000 });
    const pk0 = keysSeen.length;
    await Promise.all([q1.waitForURL(/\/profile\.html#wallet:withdraw$/, { timeout: 8000 }).catch(() => null), q1.evaluate(() => W.withdraw())]);
    const provUrl = q1.url();
    const q2 = await pc.newPage();
    await q2.goto(BASE + '/provider-dashboard.html');
    await q2.waitForFunction(() => typeof W !== 'undefined' && typeof W.wdSubmit === 'function', null, { timeout: 15000 });
    await Promise.all([q2.waitForURL(/\/profile\.html#wallet:withdraw$/, { timeout: 8000 }).catch(() => null), q2.evaluate(() => W.wdSubmit())]);
    ck('provider: Withdraw (and the old sheet submit) open the ONE wallet — nothing is submitted from this page',
      /\/profile\.html#wallet:withdraw$/.test(provUrl) && /\/profile\.html#wallet:withdraw$/.test(q2.url()) && keysSeen.length === pk0 && (await payoutsOf('pu1')).length === 0, { provUrl, q2: q2.url() });
    await pc.close();

    /* ═══ merchant wallet (sokoni-merchant-wallet.js) — Withdraw opens the ONE wallet ═══ */
    say('\n── merchant wallet ──');
    const mc = await ctxFor({ uid: 'mu1' });
    const m1 = await mc.newPage();
    await m1.goto(BASE + '/merchant-harness.html');
    await m1.evaluate(() => {
      window.SokoniMerchantWallet.mount(document.getElementById('host'), {
        scope: { ok: true, sellerUid: 'mu1', shopId: 's1' }, shopName: 'Shop',
        entitlement: () => Promise.resolve({ premium: true }), readWallet: () => Promise.resolve({ balance: 5000 }),
        readTransactions: () => Promise.resolve([]),
        readPayouts: () => Promise.resolve([{ id: 'pout_x', status: 'approved', secureRelease: true, amount: 900, accountNumber: '254733333333', method: 'mpesa' }]),
        callWithdraw: () => { window.__merchantSubmitted = true; return Promise.resolve({ data: {} }); }, onToast: () => {} });
    });
    await m1.waitForTimeout(300);
    const mk0 = keysSeen.length;
    await Promise.all([m1.waitForURL(/\/profile\.html#wallet:withdraw$/, { timeout: 8000 }).catch(() => null), m1.click('[data-wa="withdraw"]')]);
    const mUrl = m1.url();
    ck('merchant: Withdraw opens the ONE wallet — this module submits nothing', /\/profile\.html#wallet:withdraw$/.test(mUrl) && keysSeen.length === mk0 && (await payoutsOf('mu1')).length === 0, mUrl);
    await mc.close();

    /* ═══ server: a key is never shared across accounts ═══ */
    say('\n── server identity ──');
    const theirs = (await payoutsOf('wu1'))[0].id.replace(/^pout_/, '');
    const x = await server('requestSellerPayout', { amount: 500, method: 'mpesa', accountNumber: '0712345678', idempotencyKey: theirs }, 'wu2');
    ck("another account presenting a user's key is refused — not told 'already submitted'", x.err && x.err.code === 'failed-precondition' && (await payoutsOf('wu2')).length === 0, x.err);
  } catch (e) { ck('browser run completed', false, e && e.message); }
  finally { await browser.close(); srv.close(); }

  say('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS CRASHED', e && e.stack); process.exit(2); });
