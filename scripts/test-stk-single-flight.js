/* test-stk-single-flight.js — initiateSTKPush single-flight, EXECUTED.
 *
 * Runs the REAL functions/index.js (initiateSTKPush, cancelPayment) against the
 * transactional fake Firestore. https.request is replaced IN-PROCESS by a
 * counting fake gateway — nothing leaves the machine. A fake answer proves the
 * CODE's control flow for that answer, never how IntaSend behaves.
 *
 *   concurrency  2/3/4/6/10 callers, one reference → exactly 1 gateway request
 *   retry matrix none·RESERVED·GATEWAY_REQUESTED·PENDING<10m·PENDING>10m·COMPLETE·
 *                FAILED·CANCELLED·REJECTED·OUTCOME_UNKNOWN·unknown state·hosted rail
 *   outcomes     2xx · 4xx · 5xx · timeout · unreadable · 2xx without an id
 *   cross-rail   STK and hosted checkout share ONE reservation per reference
 *
 *   node scripts/test-stk-single-flight.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-stk-single-flight';
process.env.INTASEND_PRIVATE_KEY = 'ISSecretKey_test_harness';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'x';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = console.error = console.debug = () => {};

/* ── counting fake gateway ── */
const https = require('https');
const calls = [];
const hostedCalls = [];
let MODE = 'ok'; const LATENCY = 80;
https.request = (opts, cb) => {
  const isStk = String(opts.path || '').includes('mpesa-stk-push');
  let body = ''; const handlers = {};
  const req = { on(ev, fn) { handlers[ev] = fn; return req; }, setTimeout() { return req; }, write(b) { body += b; }, end() {
    if (String(opts.path || '').includes('/api/v1/checkout/')) {
      const n = hostedCalls.push({ body: JSON.parse(body) });
      setTimeout(() => { const data = JSON.stringify({ url: 'https://payment.intasend.com/checkout/h' + n + '/', id: 'HINV' + n });
        const res = { statusCode: 201, headers: {}, on(ev, fn) { if (ev === 'data') fn(data); if (ev === 'end') fn(); return res; }, setEncoding() {} }; cb && cb(res); }, LATENCY);
      return;
    }
    if (!isStk) { setTimeout(() => { const res = { statusCode: 200, headers: {}, on(ev, fn) { if (ev === 'data') fn('{}'); if (ev === 'end') fn(); return res; }, setEncoding() {} }; cb && cb(res); }, 5); return; }
    const n = calls.push({ body: JSON.parse(body), mode: MODE });
    const mode = MODE;
    setTimeout(() => {
      if (mode === 'timeout') { handlers.error && handlers.error(new Error('socket hang up ETIMEDOUT')); return; }
      const table = {
        ok:       [201, JSON.stringify({ invoice: { invoice_id: 'INV' + n, state: 'PENDING' }, id: 'CHK' + n })],
        reject:   [400, JSON.stringify({ phone_number: ['Invalid phone number.'] })],
        http503:  [503, JSON.stringify({ detail: 'upstream' })],
        badjson:  [201, '<html>gateway</html>'],
        noid:     [201, JSON.stringify({ invoice: { state: 'PENDING' } })],
      };
      const [status, data] = table[mode];
      const res = { statusCode: status, headers: {}, on(ev, fn) { if (ev === 'data') fn(data); if (ev === 'end') fn(); return res; }, setEncoding() {} };
      cb && cb(res);
    }, LATENCY);
  } };
  return req;
};
global.fetch = async () => ({ ok: false, status: 599, json: async () => ({}), text: async () => '' });

const noop = () => ({});
const adminNs = { apps: [{}], initializeApp: noop, app: noop, credential: { applicationDefault: noop },
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {}, providerData: [{}] }) }),
  messaging: () => ({ send: async () => 'm' }), storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
  database: () => ({ ref: () => ({ set: async () => {} }) }) };
const stub = (m, exp) => { try { require.cache[require.resolve(m, { paths: [FN] })] = { id: m, filename: m, loaded: true, exports: exp }; } catch (_) { /* absent */ } };
stub('firebase-admin', adminNs);
stub('firebase-admin/app', { initializeApp: noop, getApps: () => [{}], getApp: noop });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => adminNs.auth() });
stub('firebase-admin/messaging', { getMessaging: () => adminNs.messaging() });

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '') + '\n'); ok ? pass++ : fail++; };
const TS = F.Timestamp;
const doc = async (p) => (await db.doc(p).get()).data() || null;

(async () => {
  const idx = require(Path.join(FN, 'index.js'));
  const push = (uid, ref, amount = 500, meta = {}) => idx.initiateSTKPush.run({ auth: { uid, token: {} }, data: { phone: '254712345678', amount, ref, meta } })
    .then((r) => ({ ok: r })).catch((e) => ({ err: e.code, msg: String(e.message).slice(0, 100) }));
  const filmIntent = async (ref, uid) => db.doc('paymentIntents/' + ref).set({ ref, uid, ownerUid: uid, purpose: 'film_access', amount: 500, amountCents: 50000, currency: 'KES',
    status: 'created', resourceType: 'film', resourceId: 'film1', brand: 'sokoni', expiresAt: TS.fromMillis(Date.now() + 900000), metadata: { type: 'film_access' } });
  const summary = (rs) => rs.map((r) => r.ok ? (r.ok.reused ? 'reuse:' : r.ok.alreadyPaid ? 'paid:' : 'sent:') + r.ok.checkoutId : r.err);

  say('\n── concurrency: N callers, one payment reference ──\n');
  for (const N of [2, 3, 4, 6, 10]) {
    /* (a) N devices, N different accounts, one legacy reference — every caller reaches the reservation */
    MODE = 'ok'; let c0 = calls.length;
    const ref = 'SKNCONC' + N + 'X';
    const rs = await Promise.all(Array.from({ length: N }, (_, i) => push('dev' + N + '_' + i, ref)));
    const ids = new Set(rs.filter((r) => r.ok).map((r) => r.ok.checkoutId));
    ck(`N=${N} distinct devices → exactly 1 gateway request`, calls.length - c0 === 1, calls.length - c0);
    ck(`N=${N} every caller converged on the same checkout id`, rs.every((r) => r.ok) && ids.size === 1, summary(rs));
    ck(`N=${N} one attempt record, attemptNo 1, GATEWAY_ACCEPTED`, (await doc('paymentAttempts/' + ref)).attemptNo === 1 && (await doc('paymentAttempts/' + ref)).state === 'GATEWAY_ACCEPTED');
    /* (b) the same account on N devices, a server-priced film intent (the Creator path) */
    c0 = calls.length;
    const fref = 'SKNFILM' + N + 'X';
    await filmIntent(fref, 'buyer' + N);
    const fs2 = await Promise.all(Array.from({ length: N }, () => push('buyer' + N, fref)));
    const okIds = new Set(fs2.filter((r) => r.ok).map((r) => r.ok.checkoutId));
    ck(`N=${N} same buyer, film intent → exactly 1 gateway request`, calls.length - c0 === 1, calls.length - c0);
    ck(`N=${N} same buyer: all converge or are rate-limited — nothing else`, okIds.size === 1 && fs2.every((r) => r.ok || r.err === 'resource-exhausted'), summary(fs2));
  }

  say('\n── retry matrix (seeded state → gateway requests) ──\n');
  const seed = async (ref, att, pay) => { if (att) await db.doc('paymentAttempts/' + ref).set(att); if (pay) await db.doc('payments/' + ref).set(pay); };
  const now = Date.now();
  const cases = [
    ['no attempt',                 null, null, 1],
    ['RESERVED (in flight)',       { state: 'RESERVED', attemptNo: 1, rail: 'stk' }, null, 0],
    ['GATEWAY_REQUESTED',          { state: 'GATEWAY_REQUESTED', attemptNo: 1, rail: 'stk' }, null, 0],
    ['PENDING < 10 min',           { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-OLD', acceptedAtMs: now }, { status: 'PENDING', checkoutId: 'CHK-OLD', uid: 'm', createdAt: TS.fromMillis(now) }, 0],
    ['PENDING > 10 min',           { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-OLD', acceptedAtMs: now - 11 * 60000 }, { status: 'PENDING', checkoutId: 'CHK-OLD', uid: 'm', createdAt: TS.fromMillis(now - 11 * 60000) }, 1],
    ['COMPLETE',                   { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-P' }, { status: 'COMPLETE', checkoutId: 'CHK-P', uid: 'm', createdAt: TS.fromMillis(now) }, 0],
    ['FAILED',                     { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-F' }, { status: 'FAILED', checkoutId: 'CHK-F', uid: 'm', createdAt: TS.fromMillis(now) }, 1],
    ['CANCELLED',                  { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-C' }, { status: 'CANCELLED', checkoutId: 'CHK-C', uid: 'm', createdAt: TS.fromMillis(now) }, 1],
    ['GATEWAY_REJECTED',           { state: 'GATEWAY_REJECTED', attemptNo: 1, rail: 'stk' }, null, 1],
    ['OUTCOME_UNKNOWN (unreconciled)', { state: 'OUTCOME_UNKNOWN', attemptNo: 1, rail: 'stk' }, { status: 'PENDING', checkoutId: null, uid: 'm', createdAt: TS.fromMillis(now - 3600000), outcomeUnknown: true }, 0],
    ['OUTCOME_UNKNOWN, provider said FAILED', { state: 'OUTCOME_UNKNOWN', attemptNo: 1, rail: 'stk' }, { status: 'FAILED', uid: 'm', createdAt: TS.fromMillis(now) }, 1],
    ['OUTCOME_UNKNOWN, buyer cancelled (not provider evidence)', { state: 'OUTCOME_UNKNOWN', attemptNo: 1, rail: 'stk' }, { status: 'CANCELLED', uid: 'm', createdAt: TS.fromMillis(now) }, 0],
    ['unrecognised state',         { state: 'SOMETHING_ELSE', attemptNo: 1, rail: 'stk' }, null, 0],
    ['hosted checkout owns the ref', { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'hosted_checkout', checkoutUrl: 'https://payment.intasend.com/x' }, { status: 'PENDING', rail: 'hosted_checkout', uid: 'm', createdAt: TS.fromMillis(now) }, 0],
    ['legacy PENDING (no attempt record) < 10 min', null, { status: 'PENDING', checkoutId: 'CHK-LEG', uid: 'm', createdAt: TS.fromMillis(now) }, 0],
  ];
  let k = 0;
  const EXPECT = {"no attempt":"sent","RESERVED (in flight)":"aborted","GATEWAY_REQUESTED":"aborted","PENDING < 10 min":"reuse","PENDING > 10 min":"sent","COMPLETE":"paid","FAILED":"sent","CANCELLED":"sent","GATEWAY_REJECTED":"sent","OUTCOME_UNKNOWN (unreconciled)":"unavailable","OUTCOME_UNKNOWN, provider said FAILED":"sent","OUTCOME_UNKNOWN, buyer cancelled (not provider evidence)":"unavailable","unrecognised state":"failed-precondition","hosted checkout owns the ref":"failed-precondition","legacy PENDING (no attempt record) < 10 min":"reuse"};
  const kind = (r) => r.ok ? (r.ok.reused ? 'reuse' : r.ok.alreadyPaid ? 'paid' : 'sent') : r.err;
  for (const [label, att, pay, expected] of cases) {
    const ref = 'SKNMATRIX' + (k++) + 'X';
    MODE = 'ok';
    await seed(ref, att, pay);
    const c0 = calls.length;
    const t0 = Date.now();
    const r = await push('mx' + k, ref);
    ck(`${label} → ${expected} request(s), outcome ${EXPECT[label]}`, calls.length - c0 === expected && kind(r) === EXPECT[label], { calls: calls.length - c0, r: r.ok ? summary([r])[0] : r.err, ms: Date.now() - t0 });
  }
  /* PENDING > 10 min, reacquired by three devices at once → still one request */
  {
    const ref = 'SKNSTALE3X';
    await seed(ref, { state: 'GATEWAY_ACCEPTED', attemptNo: 1, rail: 'stk', checkoutId: 'CHK-OLD', acceptedAtMs: now - 11 * 60000 }, { status: 'PENDING', checkoutId: 'CHK-OLD', uid: 'm', createdAt: TS.fromMillis(now - 11 * 60000) });
    const c0 = calls.length;
    const rs = await Promise.all([push('s1', ref), push('s2', ref), push('s3', ref)]);
    ck('PENDING > 10 min reacquired by 3 devices at once → exactly 1 request (safe reacquisition)', calls.length - c0 === 1 && (await doc('paymentAttempts/' + ref)).attemptNo === 2, summary(rs));
  }
  /* CANCELLED through the real cancelPayment, then retry */
  {
    const ref = 'SKNCANCELX'; MODE = 'ok';
    await push('cx', ref);
    await idx.cancelPayment.run({ auth: { uid: 'cx', token: {} }, data: { ref } });
    const c0 = calls.length;
    const r = await push('cx', ref);
    ck('cancelPayment then retry → 1 new request, new checkout id', calls.length - c0 === 1 && r.ok && r.ok.checkoutId && !r.ok.reused, summary([r]));
  }

  say('\n── gateway outcomes ──\n');
  for (const [mode, label, expectState, expectErr] of [
    ['reject',  '4xx rejection',        'GATEWAY_REJECTED', 'internal'],
    ['http503', '5xx',                  'OUTCOME_UNKNOWN',  'unavailable'],
    ['timeout', 'timeout / no answer',  'OUTCOME_UNKNOWN',  'unavailable'],
    ['badjson', 'unreadable 2xx body',  'OUTCOME_UNKNOWN',  'unavailable'],
    ['noid',    '2xx without an id',    'OUTCOME_UNKNOWN',  'unavailable'],
  ]) {
    const ref = 'SKNOUT' + mode.toUpperCase() + 'X';
    MODE = mode; const c0 = calls.length;
    const r = await push('o_' + mode, ref);
    const att = await doc('paymentAttempts/' + ref);
    ck(`${label} → ${expectState}, caller told "${expectErr}"`, att && att.state === expectState && r.err === expectErr && calls.length - c0 === 1, { st: att && att.state, err: r.err });
    MODE = 'ok'; const c1 = calls.length;
    const again = await push('o_' + mode, ref);
    if (expectState === 'GATEWAY_REJECTED') ck(`${label} → a retry may send again (1 request)`, calls.length - c1 === 1 && again.ok, summary([again]));
    else {
      ck(`${label} → a retry sends NOTHING (held)`, calls.length - c1 === 0 && again.err === 'unavailable', again.err);
      const pay = await doc('payments/' + ref);
      ck(`${label} → payments/{ref} PENDING so the callback can still settle it`, pay && pay.status === 'PENDING' && pay.outcomeUnknown === true && pay.amount === 500);
    }
  }
  /* reconciliation by the provider's callback (the webhook's write, simulated) */
  {
    const ref = 'SKNOUTHTTP503X';
    await db.doc('payments/' + ref).update({ status: 'COMPLETE', intasendState: 'COMPLETE' });
    const c0 = calls.length; const r = await push('o_http503', ref);
    ck('held + callback COMPLETE → alreadyPaid, 0 requests (COMPLETE replay)', calls.length - c0 === 0 && r.ok && r.ok.alreadyPaid === true, summary([r]));
    const ref2 = 'SKNOUTTIMEOUTX';
    await db.doc('payments/' + ref2).update({ status: 'FAILED', intasendState: 'FAILED' });
    const c1 = calls.length; const r2 = await push('o_timeout', ref2);
    ck('held + callback FAILED → released: exactly 1 new request', calls.length - c1 === 1 && r2.ok && !r2.ok.reused, summary([r2]));
  }
  /* concurrency on a bad answer: losers converge on the winner's result */
  {
    MODE = 'http503'; const c0 = calls.length;
    const rs = await Promise.all([push('u1', 'SKNCONC503X'), push('u2', 'SKNCONC503X'), push('u3', 'SKNCONC503X')]);
    ck('3 concurrent on a 5xx → 1 request, every caller told unavailable', calls.length - c0 === 1 && rs.every((r) => r.err === 'unavailable'), rs.map((r) => r.err));
    MODE = 'reject'; const c1 = calls.length;
    const rj = await Promise.all([push('v1', 'SKNCONC400X'), push('v2', 'SKNCONC400X'), push('v3', 'SKNCONC400X')]);
    ck('3 concurrent on a 4xx → 1 request, no caller sends again', calls.length - c1 === 1 && rj.every((r) => r.err), rj.map((r) => r.err));
  }

  say('\n── cross-rail: one reservation per reference ──\n');
  {
    MODE = 'ok';
    const HC = require(Path.join(FN, 'hosted-checkout.js'))._internal;
    const hosted = (uid, ref) => HC.hostedCheckout({ auth: { uid }, data: { ref } }, 'ISPubKey_live_harness').then((r) => ({ ok: r })).catch((e) => ({ err: e.code }));
    await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['film_access'] });
    await db.doc('config/intasendCapability').set({ methods: { 'CARD-PAYMENT': { status: 'LIVE_AND_PROVEN', evidence: { type: 'completed_invoice', reference: 'INV-X' }, note: 'harness: proven for the cross-rail test' } } });
    await filmIntent('SKNXSTK1X', 'xr1');
    const s1 = await push('xr1', 'SKNXSTK1X'); const h0 = hostedCalls.length;
    const h1 = await hosted('xr1', 'SKNXSTK1X');
    ck('STK first → hosted checkout on the same reference refused, 0 hosted requests', s1.ok && h1.err === 'failed-precondition' && hostedCalls.length === h0, { s1: summary([s1]), h1: h1.err });
    await filmIntent('SKNXHOS1X', 'xr2');
    const h2 = await hosted('xr2', 'SKNXHOS1X'); const c0 = calls.length;
    const s2 = await push('xr2', 'SKNXHOS1X');
    ck('hosted first → STK on the same reference refused, 0 STK requests', h2.ok && h2.ok.url && s2.err === 'failed-precondition' && calls.length === c0, { h2: !!(h2.ok && h2.ok.url), s2: s2.err });
    await filmIntent('SKNXRACEX', 'xr3');
    const c1 = calls.length, hh = hostedCalls.length;
    const race = await Promise.all([push('xr3', 'SKNXRACEX'), hosted('xr3', 'SKNXRACEX'), push('xr3', 'SKNXRACEX'), hosted('xr3', 'SKNXRACEX')]);
    const total = (calls.length - c1) + (hostedCalls.length - hh);
    const att = await doc('paymentAttempts/SKNXRACEX');
    ck('STK and hosted racing on one reference → exactly ONE gateway request in total', total === 1 && att && ['stk', 'hosted_checkout'].includes(att.rail), { stk: calls.length - c1, hosted: hostedCalls.length - hh, rail: att && att.rail, r: race.map((x) => x.err || 'ok') });
  }

  say('\n── identity ──\n');
  {
    MODE = 'ok';
    const ref = 'SKNOWNERX'; await filmIntent(ref, 'owner1');
    const c0 = calls.length;
    const other = await push('intruder', ref);
    ck('another account cannot push a film intent it does not own (0 requests)', other.err === 'permission-denied' && calls.length - c0 === 0, other.err);
    const wrongAmt = await push('owner1', ref, 1);
    ck('client amount ≠ intent amount refused before any request', wrongAmt.err === 'invalid-argument' && calls.length - c0 === 0, wrongAmt.err);
    const good = await push('owner1', ref);
    ck('the owner pushes once; api_ref is the payment reference (no new identity)', good.ok && calls[calls.length - 1].body.api_ref === ref && (await doc('payments/' + ref)).intentRef === ref);
  }

  say('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS CRASHED ' + (e && e.stack) + '\n'); process.exit(2); });
