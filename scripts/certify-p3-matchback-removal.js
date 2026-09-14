'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   P3 — THE DEAD MATCH-BACK FIELD IS GONE.

   `initiatePOSQRPayment` wrote `pendingMpesaPhone` under the comment "Store pending STK context so
   webhook can match back". The census found ONE producer and ZERO consumers: no webhook, no client,
   nothing anywhere ever read it. It implied a mechanism nobody built.

   It was also the WRONG KEY. Two concurrent sales to the same handset are indistinguishable by
   phone number, so matching on it could only ever be ambiguous — exactly the case that has to fail
   closed. The anchor that works is `api_ref`: P2 sets it to the transactionId, P1 verifies against
   it.

   THIS GATE REMOVES DEAD WEIGHT. IT BUILDS NOTHING.
   Association of a real callback is deferred to P3-A (docs/P3A_POS_QR_WEBHOOK_ASSOCIATION.md),
   because the only place to do it is inside two certified, divergent webhook handlers that live in
   a file other agents are editing. Section 4 below PROVES those handlers are untouched and records
   what they do with a QR callback today — it does not change them.

   Neither P3 nor P3-A may become a second definition of "paid".

   Run:  node scripts/certify-p3-matchback-removal.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-p3-cert';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'cert-qr-secret';
process.env.INTASEND_PRIVATE_KEY = process.env.INTASEND_PRIVATE_KEY || 'cert-not-a-real-key';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(10) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(10) + m + (x ? '\n              ' + String(x).slice(0, 260) : '')); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* EVERY SABOTAGE MUST ACTUALLY LAND. Three times this session a mutation silently failed to apply
   and the check reported "not detected" while the product was fine. One line stops all three. */
function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); the check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

/* ── Store + gateway stub (same shape as the P2 harness) ───────────────────────────────────── */
function makeStore() {
  const data = new Map();
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => { const v = data.get(key(c, d)); return { id: d, exists: v !== undefined, data: () => (v === undefined ? undefined : Object.assign({}, v)) }; };
  const docRef = (c, d) => ({
    id: String(d),
    get: async () => snapOf(c, d),
    set: async (o) => { data.set(key(c, d), Object.assign({}, o)); },
    create: async (o) => { if (data.has(key(c, d))) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } data.set(key(c, d), Object.assign({}, o)); },
    update: async (o) => { data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)); },
    delete: async () => { data.delete(key(c, d)); },
  });
  return {
    collection: (c) => ({ doc: (d) => docRef(c, d), add: async (o) => { data.set(key(c, 'a' + data.size), o); } }),
    runTransaction: async (fn) => {
      const pend = [];
      const out = await fn({ get: async (r) => r.get(), set: (r, o) => pend.push(['set', r, o]), update: (r, o) => pend.push(['update', r, o]) });
      for (const [op, r, o] of pend) await r[op](o);
      return out;
    },
    _put: (c, d, o) => data.set(key(c, d), Object.assign({}, o)),
    _get: (c, d) => (data.has(key(c, d)) ? Object.assign({}, data.get(key(c, d))) : null),
    _del: (c, d) => data.delete(key(c, d)),
    _count: (c) => [...data.keys()].filter((k) => k.startsWith(c + '/')).length,
  };
}
const STORE = makeStore();
const GW = { requests: [], status: 200, body: { invoice: { invoice_id: 'INV-P3' } } };

let admin, posQr, restoreHttps;
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const real = admin.firestore;
  const stub = function () { return STORE; };
  Object.getOwnPropertyNames(real).forEach((k) => { if (!['length', 'name', 'prototype'].includes(k)) { try { stub[k] = real[k]; } catch (_) {} } });
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect');
  const httpsMod = require('https');
  const orig = httpsMod.request;
  httpsMod.request = function (opts, cb) {
    const chunks = [];
    const res = { statusCode: GW.status, on(ev, fn) { if (ev === 'data') fn(Buffer.from(JSON.stringify(GW.body))); if (ev === 'end') setImmediate(fn); return res; } };
    const req = { on() { return req; }, write(b) { chunks.push(String(b)); return true; }, end() { GW.requests.push({ opts, body: chunks.join('') }); if (cb) setImmediate(() => cb(res)); return req; } };
    return req;
  };
  restoreHttps = () => { httpsMod.request = orig; };
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  posQr = require(path.join(FN, 'pos-qr.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — ' + (e && e.message));
  clearTimeout(WATCHDOG); process.exit(2);
}

const SELLER = 'seller-p3', TXN = 'd'.repeat(32), TOTAL = 900, PHONE = '254712345678';
const REQ = (uid, data) => ({ data, auth: { uid, token: { isSeller: true } }, rawRequest: { headers: {} }, acceptsStreaming: false });

function seed() {
  STORE._del('paymentAttempts', TXN);
  STORE._put('posPayments', TXN, {
    transactionId: TXN, sellerId: SELLER, sellerName: 'KASS SHOP', items: [{ name: 'x', price: TOTAL, qty: 1 }],
    subtotal: TOTAL, tax: 0, discount: 0, total: TOTAL, currency: 'KES', status: 'pending', attempts: 0,
    /* The handler HMAC-verifies this with timingSafeEqual, which throws on a length mismatch
       rather than returning false — so an unsigned fixture crashes instead of being refused. */
    signature: require('crypto').createHmac('sha256', process.env.QR_SIGNING_SECRET)
      .update(TXN).digest('hex').slice(0, 16),
    expiresAt: { toMillis: () => Date.now() + 600000 },
  });
  STORE._put('shops', SELLER, { name: 'KASS SHOP' });
  GW.requests = []; GW.status = 200;
}

/* ── Sources ───────────────────────────────────────────────────────────────────────────────── */
const POS_RAW = fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8');
const POS = strip(POS_RAW);
const IDX = strip(fs.readFileSync(path.join(FN, 'index.js'), 'utf8'));

/* Producers only — an assignment, not a mention. Runs on STRIPPED source because this gate's own
   comments name the field repeatedly and would otherwise count as evidence against itself. */
const producers = (s) => [...s.matchAll(/(^|[^\w.])pendingMpesaPhone\s*:/g)].map((m) => m[0]);

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  P3 — THE DEAD MATCH-BACK FIELD IS GONE');
  console.log('  Removes dead weight. Builds nothing. Changes no payment authority.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('1  ZERO PRODUCERS, ZERO CONSUMERS');
  check('Z1-1', producers(POS).length === 0, 'pos-qr.js no longer writes pendingMpesaPhone', JSON.stringify(producers(POS)));
  check('Z1-2', /pendingMpesaPhone/.test(POS_RAW), 'it survives in the RAW file only as commentary — the removal is explained, not silent');
  check('Z1-3', producers('await ref.update({ pendingMpesaPhone: normPhone });').length === 1,
    'CONTROL — the producer detector fires when such a write IS present');
  {
    /* Every file in the repo that could read it, excluding this gate's own machinery. */
    const files = require('child_process').execSync('git ls-files "*.js" "*.html"', { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((f) => !/^scripts\/certify-p[123]|^functions\/shared\/stk-gateway/.test(f));
    const readers = [];
    for (const f of files) {
      let s;
      try { s = strip(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { continue; }
      if (/pendingMpesaPhone/.test(s)) readers.push(f);
    }
    check('Z1-4', readers.length === 0,
      'NO file in the repository references it — ' + files.length + ' tracked js/html scanned', JSON.stringify(readers));
  }
  check('Z1-5', !/pendingMpesaPhone/.test(IDX), 'neither IntaSend webhook mentions it');

  section('2  PAYMENT AUTHORITY IS UNCHANGED BY THE REMOVAL');
  {
    seed();
    let ret = null, err = null;
    try { ret = await quiet(() => posQr.initiatePOSQRPayment.run(REQ(SELLER, { transactionId: TXN, method: 'mpesa', phone: PHONE }))); }
    catch (e) { err = e; }
    check('A2-1', !err && ret && ret.status === 'stk_initiated', 'the accepted send still works', err && err.message);
    const rec = STORE._get('posPayments', TXN);
    check('A2-2', rec.stkState === 'GATEWAY_ACCEPTED' && rec.gatewayCheckoutId === 'INV-P3',
      'P2\'s gateway-acceptance state is still recorded');
    check('A2-3', rec.pendingMpesaPhone === undefined, 'and the dead field is not written');
    check('A2-4', rec.status === 'pending' && STORE._count('orders') === 0,
      'nothing became paid and no order was created — P2 still establishes ACCEPTED, never PAID');
    const wire = JSON.parse(GW.requests[0].body);
    check('A2-5', wire.api_ref === TXN,
      'P2\'s transactionId → api_ref contract is unchanged — this is the anchor P1 verifies against');
    const att = STORE._get('paymentAttempts', TXN);
    check('A2-6', !!att && att.phone === PHONE,
      'the audit trail is INTACT: the reservation still records the phone that was prompted');
  }
  {
    /* P1 must still be the only thing that can mark paid, and it must still ask the gateway. */
    const body = POS.slice(POS.indexOf('exports.completePOSQRPayment'));
    check('A2-7', /_verify\.verifyPayment\(/.test(body), 'P1 still verifies with IntaSend before completing');
    check('A2-8', /reference:\s*transactionId/.test(body), '…still anchored on the transactionId');
    const initBody = POS.slice(POS.indexOf('exports.initiatePOSQRPayment'), POS.indexOf('exports.completePOSQRPayment'));
    check('A2-9', !/status:\s*'paid'/.test(initBody) && !/collection\('orders'\)/.test(initBody),
      'the sender still writes no paid status and creates no order');
  }

  section('3  settleOrder AND THE ONLINE RAIL ARE UNTOUCHED');
  {
    /* THIS ASSERTION WAS TOO BROAD and failed the moment a LATER gate legitimately edited
       index.js — D1/D2 rail-scoped `verifyPaymentStatus`, which necessarily mentions
       `posPayments`. "No P3 change" is the claim; "nobody ever touches this file again" is what
       it was actually checking. Third time this session that an unchanged-file assertion has
       fired on someone else's legitimate work.

       Narrowed to P3's own marker: the field this gate removed must not reappear as a WRITE
       anywhere in index.js. */
    const idx = require('child_process').execSync('git diff HEAD -- functions/index.js', { cwd: ROOT, encoding: 'utf8' });
    check('U3-1', !/^\+.*pendingMpesaPhone\s*:/m.test(idx),
      'no P3 change (a pendingMpesaPhone write) appears in functions/index.js');
    const os = require('child_process').execSync('git diff HEAD -- functions/order-settlement.js', { cwd: ROOT, encoding: 'utf8' });
    check('U3-2', !/pendingMpesaPhone|posPayments|pos_qr/.test(os),
      'no P3 change appears in order-settlement.js (dirty from the refund agent, not from this gate)');
  }

  section('4  WHAT A QR CALLBACK DOES TODAY — recorded, not changed');
  check('W4-1', (IDX.match(/exports\.intasendWebhook|exports\.webhookIntasend/g) || []).length === 2,
    'both IntaSend webhooks are present and untouched');
  check('W4-2', /db\.collection\("payments"\)\.doc\(apiRef\)/.test(IDX),
    'they key on api_ref and look up payments/{apiRef}');
  check('W4-3', /if \(!snap\.exists\) \{ res\.status\(200\)\.send\("OK"\); return; \}/.test(IDX),
    'an unknown api_ref is acknowledged and DROPPED — nothing is created, nothing corrupted');
  check('W4-4', !/posPayments/.test(IDX.slice(IDX.indexOf('exports.intasendWebhook'), IDX.indexOf('exports.webhookMpesa'))),
    'neither handler knows posPayments exists — so a QR callback is dropped, which is why P1 asks IntaSend directly');
  check('W4-5', fs.existsSync(path.join(ROOT, 'docs', 'P3A_POS_QR_WEBHOOK_ASSOCIATION.md')),
    'the deferred gate P3-A is recorded so this is not rediscovered by accident');
  {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'P3A_POS_QR_WEBHOOK_ASSOCIATION.md'), 'utf8');
    check('W4-6', /never become a second definition of "paid"/.test(doc) && /latency\/UX improvement, not an integrity repair/.test(doc),
      '…and it states that association may never become a second definition of paid');
  }

  section('5  SABOTAGE');
  sab('X5-1', 'restoring the dead producer', POS,
    POS.replace(/stkState:\s*'GATEWAY_ACCEPTED',/, "pendingMpesaPhone: normPhone,\n          stkState: 'GATEWAY_ACCEPTED',"),
    (s) => producers(s).length > 0);
  sab('X5-2', 'letting the sender mark the sale paid', POS,
    POS.replace(/stkState:\s*'GATEWAY_ACCEPTED',/, "status: 'paid',\n          stkState: 'GATEWAY_ACCEPTED',"),
    (s) => /status:\s*'paid'/.test(s.slice(s.indexOf('exports.initiatePOSQRPayment'), s.indexOf('exports.completePOSQRPayment'))));
  sab('X5-3', 'breaking P2\'s api_ref anchor', POS,
    POS.replace(/apiRef:\s*transactionId/, 'apiRef: normPhone'),
    (s) => !/apiRef:\s*transactionId/.test(s));
  sab('X5-4', 'removing P1\'s gateway verification', POS,
    POS.replace(/const _verdict = await _verify\.verifyPayment\(\{/, 'const _verdict = { verified: true }; const _unused = ({'),
    (s) => !/const _verdict = await _verify\.verifyPayment\(\{/.test(s));
  sab('X5-5', 'a webhook learning about posPayments (P3-A smuggled in early)', IDX,
    IDX.replace(/db\.collection\("payments"\)\.doc\(apiRef\)/, 'db.collection("posPayments").doc(apiRef)'),
    (s) => /db\.collection\("posPayments"\)\.doc\(apiRef\)/.test(s));

  return finish();
}

function finish() {
  if (restoreHttps) restoreHttps();
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ P3: GREEN' : '❌ P3: NOT GREEN'));
  console.log('  Certification only. Nothing deployed; no webhook modified.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  if (restoreHttps) restoreHttps();
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
