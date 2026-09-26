/* test-hosted-checkout.js — initiateHostedCheckout, executed (fake Firestore with
 * transaction semantics, fake HTTPS gateway, no network).
 *
 * WHAT THESE PROVE
 *   - OFF by default; purpose must be allowed; at least one method must be
 *     LIVE_AND_PROVEN with evidence in config/intasendCapability; a named method
 *     must be a proven one; caller must own the intent;
 *     expired / terminal intents refused; return path cannot be an open redirect
 *   - the gateway request carries the INTENT's amount + currency (a client amount
 *     is ignored), api_ref = intent ref, NO method (the account decides), the
 *     public-key header and NO Authorization header
 *   - single-flight: paymentAttempts/{ref}.create() before the call; a retry
 *     reuses the SAME session; two concurrent calls → ONE gateway call; an STK
 *     payment in progress blocks this rail
 *   - 400 → reservation + PENDING doc released (retry allowed); 503 / socket
 *     error → OUTCOME_UNKNOWN kept, retry REFUSED (never a second session)
 *   - an "accepted" answer with a non-IntaSend URL is never handed to the browser
 *   - the PENDING payments doc has the shape webhookIntasend settles
 *
 *   node scripts/test-hosted-checkout.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-hosted';
const Path = require('path');
const FN = Path.resolve(__dirname, '..', 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let NOW = Date.UTC(2026, 8, 26, 9);
const F = makeFakeFirestore({ clock: () => NOW });
const db = F.db;
const stub = (m, exp) => { require.cache[require.resolve(m, { paths: [FN] })] = { id: m, filename: m, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });

/* fake gateway */
let MODE = 'ok'; let calls = []; let gate = null;
const https = { request: (opts, cb) => {
  let body = '';
  const req = { on: () => req, write: (b) => { body += b; }, end: async () => {
    calls.push({ opts, body: JSON.parse(body) });
    if (gate) await gate;
    if (MODE === 'throw') { req._err && req._err(new Error('socket hang up')); return; }
    const status = { ok: 201, http400: 400, http503: 503, evil: 201 }[MODE];
    const data = MODE === 'evil' ? { url: 'https://evil.example/pay', id: 'INV1' } : MODE === 'ok' ? { url: 'https://payment.intasend.com/checkout/abc/', id: 'INV' + calls.length, available_methods: ['M-PESA', 'CARD-PAYMENT'] } : { detail: 'x' };
    const res = { statusCode: status, on: (ev, fn) => { if (ev === 'data') fn(JSON.stringify(data)); if (ev === 'end') fn(); return res; } };
    cb(res);
  } };
  req.on = (ev, fn) => { if (ev === 'error') req._err = fn; return req; };
  return req;
} };
const HC = require(Path.join(FN, 'hosted-checkout.js'));
HC._internal._setHttps(https);
HC._internal._setClock(() => NOW);
const run = (uid, data) => HC._internal.hostedCheckout({ auth: uid ? { uid } : null, data }, 'ISPubKey_live_test');
async function code(p) { try { await p; return null; } catch (e) { return e.code || e.message; } }
const read = async (p) => (await db.doc(p).get()).data() || {};

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : '')); ok ? pass++ : fail++; };
async function intent(ref, over = {}) {
  await db.doc('paymentIntents/' + ref).set({ ref, uid: 'b1', ownerUid: 'b1', purpose: 'film_access', amount: 500, amountCents: 50000, currency: 'KES', status: 'created',
    expiresAt: F.Timestamp.fromMillis(NOW + 15 * 60000), metadata: { title: 'Nairobi Nights' }, ...over });
}

(async () => {
  console.log('\n── gates ──');
  await intent('HCREF1');
  ck('unauthenticated refused', (await code(run(null, { ref: 'HCREF1' }))) === 'unauthenticated');
  ck('OFF by default (no config) → refused', (await code(run('b1', { ref: 'HCREF1' }))) === 'failed-precondition');
  ck('…and no gateway call, no reservation, no payment doc', calls.length === 0 && !(await read('paymentAttempts/HCREF1')).state && !(await read('payments/HCREF1')).status);
  await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['subscription'] });
  ck('purpose not allowed → refused', (await code(run('b1', { ref: 'HCREF1' }))) === 'failed-precondition');
  await db.doc('config/hostedCheckout').set({ enabled: true, purposes: ['film_access'] });
  ck('switch ON but NO proven method → refused (a switch alone opens nothing)', (await code(run('b1', { ref: 'HCREF1' }))) === 'failed-precondition' && calls.length === 0);
  await db.doc('config/intasendCapability').set({ methods: { 'CARD-PAYMENT': { status: 'COMMITTED_BUT_UNPROVEN', note: 'code exists, account never asked' } } });
  ck('a method recorded COMMITTED_BUT_UNPROVEN does not open it', (await code(run('b1', { ref: 'HCREF1' }))) === 'failed-precondition' && calls.length === 0);
  await db.doc('config/intasendCapability').set({ methods: { 'CARD-PAYMENT': { status: 'LIVE_AND_PROVEN', note: 'x' } } });
  ck('LIVE_AND_PROVEN without evidence does not open it', (await code(run('b1', { ref: 'HCREF1' }))) === 'failed-precondition' && calls.length === 0);
  await db.doc('config/intasendCapability').set({ methods: {
    'CARD-PAYMENT': { status: 'LIVE_AND_PROVEN', evidence: { type: 'completed_invoice', reference: 'INV-CARD-1' }, note: 'COMPLETE card invoice on the live account' },
    'M-PESA':       { status: 'LIVE_AND_PROVEN', evidence: { type: 'completed_invoice', reference: 'INV-MPESA-1' }, note: 'COMPLETE M-PESA invoice on the live account' },
    BITCOIN:        { status: 'UNSUPPORTED', evidence: { type: 'provider_refusal', reference: 'PROBE_X_BITCOIN' }, note: 'live account answered 400 for bitcoin' } } });
  ck("someone else's intent → permission-denied", (await code(run('b2', { ref: 'HCREF1' }))) === 'permission-denied');
  ck('open redirect "//evil" refused', (await code(run('b1', { ref: 'HCREF1', returnPath: '//evil.example' }))) === 'invalid-argument');
  ck('absolute URL return path refused', (await code(run('b1', { ref: 'HCREF1', returnPath: 'https://evil.example' }))) === 'invalid-argument');
  await intent('HCREFX', { expiresAt: F.Timestamp.fromMillis(NOW - 1) });
  ck('expired intent refused', (await code(run('b1', { ref: 'HCREFX' }))) === 'failed-precondition');
  await intent('HCREFP', { status: 'paid' });
  ck('terminal intent refused', (await code(run('b1', { ref: 'HCREFP' }))) === 'failed-precondition');
  ck('no gateway call for any refusal', calls.length === 0);

  console.log('\n── accepted ──');
  ck('an UNSUPPORTED method is refused before any request', (await code(run('b1', { ref: 'HCREF1', method: 'BITCOIN' }))) === 'failed-precondition' && calls.length === 0 && !(await read('paymentAttempts/HCREF1')).state);
  ck('an unknown method name is refused before any request', (await code(run('b1', { ref: 'HCREF1', method: 'PAYPAL' }))) === 'failed-precondition' && calls.length === 0);
  const r = await run('b1', { ref: 'HCREF1', amount: 1, currency: 'USD', returnPath: '/creator.html?film=f1&checkout=returned' });
  const c = calls[0];
  ck('returns the IntaSend URL', r.url === 'https://payment.intasend.com/checkout/abc/');
  ck('amount = INTENT amount (client 1 ignored)', c.body.amount === 500);
  ck('currency = INTENT currency (client USD ignored)', c.body.currency === 'KES');
  ck('api_ref = intent ref (webhook key)', c.body.api_ref === 'HCREF1');
  ck('NO method sent when none is named (the account decides)', !('method' in c.body));
  ck('public-key header (SDK + documented spelling), NO Authorization header', c.opts.headers.INTASEND_PUBLIC_API_KEY === 'ISPubKey_live_test' && c.opts.headers['X-IntaSend-Public-API-Key'] === 'ISPubKey_live_test' && !('Authorization' in c.opts.headers));
  ck('redirect stays on mysokoni.co.ke', c.body.redirect_url === 'https://mysokoni.co.ke/creator.html?film=f1&checkout=returned');
  ck('methods returned = the PROVEN list (never the gateway\'s claim, never a code list)', JSON.stringify(r.methods) === '["M-PESA","CARD-PAYMENT"]');
  const att = await read('paymentAttempts/HCREF1'); const pay = await read('payments/HCREF1');
  ck('reservation → GATEWAY_ACCEPTED', att.state === 'GATEWAY_ACCEPTED' && att.rail === 'hosted_checkout');
  ck('payments doc PENDING in the webhook shape', pay.status === 'PENDING' && pay.uid === 'b1' && pay.amount === 500 && pay.currency === 'KES' && pay.intentRef === 'HCREF1' && pay.checkoutId === 'INV1');
  const again = await run('b1', { ref: 'HCREF1' });
  ck('retry → SAME session, no second gateway call', again.reused === true && again.url === r.url && calls.length === 1);

  await intent('HCREFM');
  const rm = await run('b1', { ref: 'HCREFM', method: 'card-payment' }).catch((e) => ({ err: e.code || e.message }));
  ck('a PROVEN method may be pre-selected and is forwarded', !!rm.url && calls[calls.length - 1].body.method === 'CARD-PAYMENT', rm.err);

  console.log('\n── single-flight ──');
  await intent('HCREF2'); gate = new Promise((res) => setTimeout(res, 40));
  const both = await Promise.allSettled([run('b1', { ref: 'HCREF2' }), run('b1', { ref: 'HCREF2' })]);
  gate = null;
  ck('two concurrent calls → ONE gateway call', calls.filter((x) => x.body.api_ref === 'HCREF2').length === 1, both.map((b) => b.status).join('/'));
  await intent('HCREF3');
  await db.doc('payments/HCREF3').set({ ref: 'HCREF3', status: 'PENDING', uid: 'b1', amount: 500, rail: 'stk' });
  ck('STK already in progress → hosted refused (one rail per intent)', (await code(run('b1', { ref: 'HCREF3' }))) === 'failed-precondition' && !calls.some((x) => x.body.api_ref === 'HCREF3'));

  console.log('\n── outcomes ──');
  await intent('HCREF4'); MODE = 'http400';
  ck('400 → refused', (await code(run('b1', { ref: 'HCREF4' }))) === 'failed-precondition');
  ck('400 → reservation AND pending doc released', !(await read('paymentAttempts/HCREF4')).state && !(await read('payments/HCREF4')).status);
  MODE = 'ok';
  ck('after a 400 a retry may open a checkout', !!(await run('b1', { ref: 'HCREF4' })).url);
  await intent('HCREF5'); MODE = 'http503';
  ck('503 → unavailable', (await code(run('b1', { ref: 'HCREF5' }))) === 'unavailable');
  ck('503 → OUTCOME_UNKNOWN kept, pending doc kept (webhook may still complete)', (await read('paymentAttempts/HCREF5')).state === 'OUTCOME_UNKNOWN' && (await read('payments/HCREF5')).status === 'PENDING');
  MODE = 'ok'; const n5 = calls.length;
  ck('retry after an UNKNOWN outcome refused — no second session', (await code(run('b1', { ref: 'HCREF5' }))) === 'failed-precondition' && calls.length === n5);
  await intent('HCREF6'); MODE = 'throw';
  ck('socket error → unavailable', (await code(run('b1', { ref: 'HCREF6' }))) === 'unavailable');
  ck('socket error → OUTCOME_UNKNOWN kept', (await read('paymentAttempts/HCREF6')).state === 'OUTCOME_UNKNOWN');
  await intent('HCREF7'); MODE = 'evil';
  ck('"accepted" with a non-IntaSend URL is NOT returned', (await code(run('b1', { ref: 'HCREF7' }))) === 'unavailable' && (await read('paymentAttempts/HCREF7')).state === 'OUTCOME_UNKNOWN');

  console.log('\n── static ──');
  const fs = require('fs');
  const src = fs.readFileSync(Path.join(FN, 'hosted-checkout.js'), 'utf8');
  ck('never grants access (no entitlement / contentAccess write)', !/contentEntitlements|contentAccess|entitlement-engine/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  ck('exported by index.js', /exports\.initiateHostedCheckout\s*=/.test(fs.readFileSync(Path.join(FN, 'index.js'), 'utf8')));
  ck('reuses the committed shared/intasend-checkout client (no second client)', /require\('\.\/shared\/intasend-checkout'\)/.test(src) && !/\/api\/v1\/checkout/.test(src));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASHED', e); process.exit(2); });
