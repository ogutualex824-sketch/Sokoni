'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   P2 — THE TILL PROMPT IS ACTUALLY SENT.

   THE DEFECT
   `initiatePOSQRPayment`'s M-PESA branch wrote `pendingMpesaPhone`, answered the customer
   "M-Pesa prompt sent… Check your phone", and CALLED NO GATEWAY — under a comment reading
   "Delegate to existing initiateSTKPush CF pattern". There was no delegation. The customer stood
   at the till waiting for a prompt that was never going to arrive; five of the rail's stuck
   `pending` rows are exactly that.

   THE INVARIANT THIS SUITE EXISTS TO HOLD
       CREATED  ≠  PROMPTED  ≠  ACCEPTED  ≠  PAID
   P2 may establish that the gateway ACCEPTED the request. Only `completePOSQRPayment` (P1) may
   establish PAID, and only by independently verifying with IntaSend. Section 6 proves P2 creates
   no paid state and no order.

   WHAT IS EXECUTED
   The real handler, with Firestore replaced in memory and `https` replaced by a stub that counts
   requests and dictates responses. Every assertion reads what the handler actually did: how many
   gateway requests it issued, what it put on the wire, and what it wrote.

   Run:  node scripts/certify-p2-pos-stk-sender.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-p2-cert';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'cert-qr-secret';
process.env.INTASEND_PRIVATE_KEY = process.env.INTASEND_PRIVATE_KEY || 'cert-not-a-real-key';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(11) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(11) + m + (x ? '\n               ' + String(x).slice(0, 260) : '')); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* ── Store ─────────────────────────────────────────────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => { const v = data.get(key(c, d)); return { id: d, exists: v !== undefined, data: () => (v === undefined ? undefined : Object.assign({}, v)) }; };
  const docRef = (c, d) => ({
    id: String(d),
    get: async () => snapOf(c, d),
    set: async (o) => { data.set(key(c, d), Object.assign({}, o)); },
    create: async (o) => {
      if (data.has(key(c, d))) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
      data.set(key(c, d), Object.assign({}, o));
    },
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

/* ── The gateway stub — counts requests, records the wire, dictates the answer ──────────────── */
const GW = { requests: [], status: 200, body: { invoice: { invoice_id: 'INV-STK-1' } }, throwOn: null };
function stubHttps() {
  const realHttps = require('https');
  const orig = realHttps.request;
  realHttps.request = function (opts, cb) {
    const chunks = [];
    const rec = { opts, body: null };
    const res = {
      statusCode: GW.status,
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(GW.body)));
        if (ev === 'end') setImmediate(fn);
        return res;
      },
    };
    const req = {
      on(ev, fn) { if (ev === 'error' && GW.throwOn) setImmediate(() => fn(new Error(GW.throwOn))); return req; },
      write(b) { chunks.push(String(b)); return true; },
      end() {
        rec.body = chunks.join('');
        GW.requests.push(rec);
        if (!GW.throwOn && cb) setImmediate(() => cb(res));
        return req;
      },
    };
    return req;
  };
  return () => { realHttps.request = orig; };
}

/* ── Load ──────────────────────────────────────────────────────────────────────────────────── */
let admin, posQr, GWMOD, IDENT, restoreHttps;
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const real = admin.firestore;
  const stub = function () { return STORE; };
  Object.getOwnPropertyNames(real).forEach((k) => { if (!['length', 'name', 'prototype'].includes(k)) { try { stub[k] = real[k]; } catch (_) {} } });
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect');
  restoreHttps = stubHttps();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  GWMOD = require(path.join(FN, 'shared', 'stk-gateway.js'));
  IDENT = require(path.join(FN, 'shared', 'merchant-identity.js'));
  posQr = require(path.join(FN, 'pos-qr.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — ' + (e && e.message));
  console.log((e && e.stack || '').split('\n').slice(0, 6).join('\n'));
  clearTimeout(WATCHDOG); process.exit(2);
}

const SELLER = 'seller-p2', TXN = 'c'.repeat(32), TOTAL = 1500, PHONE = '254712345678';
const REQ = (uid, data) => ({ data, auth: { uid, token: { isSeller: true } }, rawRequest: { headers: {} }, acceptsStreaming: false });

function seed(opts) {
  const o = opts || {};
  STORE._del('paymentAttempts', TXN);
  STORE._put('posPayments', TXN, {
    transactionId: TXN, sellerId: SELLER, sellerName: o.sellerName || 'SOKONI Merchant',
    items: [{ name: 'Item', price: TOTAL, qty: 1 }], subtotal: TOTAL, tax: 0, discount: 0,
    total: TOTAL, currency: 'KES', status: 'pending', attempts: 0,
    signature: require('crypto').createHmac('sha256', process.env.QR_SIGNING_SECRET).update(TXN).digest('hex').slice(0, 16),
    expiresAt: { toMillis: () => Date.now() + 600000 },
  });
  STORE._put('shops', SELLER, { name: o.shopName === null ? undefined : (o.shopName || 'KASS SHOP') });
  GW.requests = []; GW.status = 200; GW.body = { invoice: { invoice_id: 'INV-STK-1' } }; GW.throwOn = null;
}

async function initiate(data, uid) {
  let ret = null, err = null;
  try { ret = await quiet(() => posQr.initiatePOSQRPayment.run(REQ(uid || SELLER, Object.assign({ transactionId: TXN, method: 'mpesa', phone: PHONE }, data || {})))); }
  catch (e) { err = e; }
  return { ret, err, requests: GW.requests.slice() };
}
const wire = (r) => { try { return JSON.parse((r.requests[0] || {}).body || '{}'); } catch (_) { return {}; } };

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  P2 — THE TILL PROMPT IS ACTUALLY SENT');
  console.log('  CREATED ≠ PROMPTED ≠ ACCEPTED ≠ PAID');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('0  HARNESS');
  check('H0-1', typeof posQr.initiatePOSQRPayment.run === 'function', 'the REAL initiatePOSQRPayment is invocable');
  check('H0-2', typeof GWMOD.pushSTK === 'function' && typeof GWMOD.classifyOutcome === 'function',
    'the recovered stk-gateway module is loadable');
  { seed(); const r = await initiate();
    check('H0-3', !r.err && r.requests.length === 1, 'the harness drives a full accepted send', r.err && r.err.message); }

  section('1  THE GATEWAY IS ACTUALLY CALLED — with server-authoritative values');
  { seed(); const r = await initiate(); const w = wire(r);
    check('G1-1', r.requests.length === 1, 'exactly one gateway request');
    check('G1-2', (r.requests[0].opts.path || '') === '/api/v1/payment/mpesa-stk-push/',
      'to the STK push endpoint — ' + r.requests[0].opts.path);
    check('G1-3', w.phone_number === PHONE, 'carrying the normalised phone');
    check('G1-4', w.amount === TOTAL, 'carrying the SERVER-stored total (' + w.amount + '), not a client figure');
    check('G1-5', w.api_ref === TXN, 'anchored on our transactionId as api_ref — this is what P1 later verifies against');
    check('G1-6', w.method === 'M-PESA' && w.currency === 'KES', 'with the fields IntaSend requires');
    const auth = (r.requests[0].opts.headers || {}).Authorization || '';
    check('G1-7', /^Bearer /.test(auth), 'authenticated server-side with the held key');
    check('G1-8', JSON.stringify(r.ret || {}).indexOf(process.env.INTASEND_PRIVATE_KEY) === -1,
      'the key never appears in the response');
  }

  section('2  THE CERTIFIED TILL NARRATIVE');
  { seed(); const r = await initiate(); const w = wire(r);
    ok('N2-0', 'on the wire: "' + w.narrative + '"');
    check('N2-1', /KASS SHOP Till/.test(w.narrative), 'till wording, resolved from shops/{sellerId}.name');
    check('N2-2', /Please approve a payment of KES 1,500/.test(w.narrative), 'the courteous ask names the amount');
    check('N2-3', /Powered by SOKONI/.test(w.narrative) && /Bravilex/.test(w.narrative), 'platform and Bravilex identity');
    check('N2-4', w.narrative === IDENT.narrativeFor(
      { v: 1, resolved: true, name: 'KASS SHOP', sellerUid: SELLER, authority: 'x', reason: null },
      { channel: 'till', amountKES: TOTAL }),
      'byte-identical to the certified generator — no second wording');
    check('N2-5', !/[\uD800-\uDBFF]/.test(w.narrative), 'handset-safe: no astral code points reach the wire');
  }
  { seed({ sellerName: 'SOKONI Merchant', shopName: null }); const r = await initiate(); const w = wire(r);
    check('N2-6', !/SOKONI Merchant/.test(w.narrative),
      'an unnamed shop does NOT fall back to "SOKONI Merchant" — "' + w.narrative + '"'); }

  section('3  SINGLE-FLIGHT — one sale, one gateway request');
  { seed();
    const [a, b] = await Promise.all([initiate(), initiate()]);
    const total = GW.requests.length;
    check('S3-1', total === 1, 'two concurrent taps issue ONE gateway request (issued: ' + total + ')');
    const okCount = [a, b].filter((x) => !x.err).length;
    check('S3-2', okCount >= 1, 'at least one caller gets a result');
    const loser = [a, b].find((x) => x.err);
    check('S3-3', !loser || /already in progress|aborted/i.test(loser.err.message),
      'the loser is told it is already in progress, not given a false "sent"');
  }
  { seed(); await initiate();
    const before = GW.requests.length;
    const again = await initiate();
    check('S3-4', GW.requests.length === before, 'a RETRY after acceptance issues no second request');
    check('S3-5', !again.err && again.ret && again.ret.deduplicated === true && again.ret.status === 'stk_initiated',
      'and converges on the existing transaction');
    check('S3-6', again.ret.checkoutId === 'INV-STK-1', '…reporting the original checkoutId');
  }
  {
    const SRC = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
    const body = SRC.slice(SRC.indexOf('exports.initiatePOSQRPayment'), SRC.indexOf('exports.completePOSQRPayment'));
    check('S3-7', body.indexOf('attemptRef.create') > -1 && body.indexOf('attemptRef.create') < body.indexOf('pushSTK'),
      'the reservation is taken BEFORE the gateway call — a reservation after it cannot cover the window it exists for');
  }

  section('4  FAIL CLOSED — no false "prompt sent"');
  { seed(); GW.status = 400; GW.body = { detail: 'bad request' };
    const r = await initiate();
    check('F4-1', !!r.err && /refused/i.test(r.err.message), 'a 4xx rejection refuses — "' + (r.err && r.err.message || '').slice(0, 60) + '"');
    check('F4-2', !/stk_initiated/.test(JSON.stringify(r.ret || {})), '…and never claims stk_initiated');
    check('F4-3', STORE._get('paymentAttempts', TXN) === null,
      'the reservation is RELEASED — the gateway answered, so nothing is in flight and a retry is safe');
    check('F4-4', (STORE._get('posPayments', TXN) || {}).stkState === undefined, 'no stkState is recorded');
  }
  { seed(); GW.status = 500; GW.body = {};
    const r = await initiate();
    check('F4-5', !!r.err && /could not confirm/i.test(r.err.message), 'a 5xx refuses without claiming sent');
    const att = STORE._get('paymentAttempts', TXN);
    check('F4-6', !!att && att.state === 'OUTCOME_UNKNOWN',
      'the reservation is HELD, not released — no response is not no charge');
  }
  { seed(); GW.throwOn = 'socket hang up';
    const r = await initiate();
    check('F4-7', !!r.err && /could not confirm/i.test(r.err.message), 'a socket error refuses without claiming sent');
    check('F4-8', (STORE._get('paymentAttempts', TXN) || {}).state === 'OUTCOME_UNKNOWN', '…and also HOLDS the reservation');
  }
  { seed(); const r = await initiate();
    check('F4-CTL', !r.err && r.ret.status === 'stk_initiated' && STORE._get('posPayments', TXN).stkState === 'GATEWAY_ACCEPTED',
      'CONTROL — on GATEWAY_ACCEPTED the prompt-sent state IS recorded'); }

  section('5  THE CALLER NAMES A SALE AND A PHONE — never a price');
  for (const f of ['amount', 'total', 'subtotal', 'tax', 'discount', 'currency', 'items']) {
    seed();
    const r = await initiate({ [f]: 1 });
    const okRefuse = !!r.err && new RegExp(f).test(r.err.message) && GW.requests.length === 0;
    check('P5-' + f, okRefuse, 'a payload carrying ' + f + ' is refused before the gateway', r.err && r.err.message);
  }
  { seed(); const r = await initiate();
    check('P5-CTL', !r.err && wire(r).amount === TOTAL, 'CONTROL — without them the server total is sent'); }

  section('6  P2 DOES NOT MAKE ANYTHING PAID');
  { seed(); await initiate();
    const rec = STORE._get('posPayments', TXN);
    check('B6-1', rec.status === 'pending', 'the payment is still pending after a successful send');
    check('B6-2', rec.paidAt === null || rec.paidAt === undefined, 'nothing is marked paid');
    check('B6-3', STORE._count('orders') === 0, 'NO order is created');
    const SRC = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
    const body = SRC.slice(SRC.indexOf('exports.initiatePOSQRPayment'), SRC.indexOf('exports.completePOSQRPayment'));
    check('B6-4', !/status:\s*'paid'/.test(body) && !/collection\('orders'\)/.test(body),
      'the sender contains no paid-status write and no order creation');
    check('B6-5', !/settleOrder|settlementStatus/.test(body), 'and does not touch settlement');
  }

  section('7  AUTHORIZATION AND EXPIRY PRECEDE THE GATEWAY');
  { seed();
    STORE._put('posPayments', TXN, Object.assign(STORE._get('posPayments', TXN), { expiresAt: { toMillis: () => Date.now() - 1000 } }));
    const r = await initiate();
    check('A7-1', !!r.err && /expired/i.test(r.err.message) && GW.requests.length === 0,
      'an expired QR refuses before any gateway call');
  }
  { seed(); const r = await initiate({ phone: '0712' });
    check('A7-2', !!r.err && GW.requests.length === 0, 'an invalid phone refuses before any gateway call'); }
  { seed(); const r = await initiate({ transactionId: 'z'.repeat(32) });
    check('A7-3', !!r.err && /not found|Invalid/i.test(r.err.message) && GW.requests.length === 0,
      'an unknown transaction refuses before any gateway call'); }

  section('8  SECRETS ARE DECLARED ON THE CALLABLE');
  {
    const SRC = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
    check('K8-1', /OPT_GATEWAY\s*=\s*\{[^}]*secrets:\s*\[QR_SIGNING_SECRET,\s*INTASEND_PRIVATE_KEY\]/s.test(SRC),
      'OPT_GATEWAY names both secrets');
    check('K8-2', /exports\.initiatePOSQRPayment = onCall\(\s*OPT_GATEWAY/.test(SRC),
      'the SENDER uses it — a v2 function reaches a secret only if it names it (B9.4.3 lost a rail to this)');
    check('K8-3', /exports\.completePOSQRPayment = onCall\(\s*OPT_GATEWAY/.test(SRC), 'the VERIFIER uses it too');
    check('K8-4', /exports\.generatePOSPaymentQR = onCall\(\s*OPT,/.test(SRC),
      'and callables that do NOT talk to IntaSend keep the narrower secret set');
  }

  section('9  SABOTAGE');
  {
    const SRC = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
    const body = SRC.slice(SRC.indexOf('exports.initiatePOSQRPayment'), SRC.indexOf('exports.completePOSQRPayment'));
    const reservesFirst = (s) => s.indexOf('attemptRef.create') > -1 && s.indexOf('attemptRef.create') < s.indexOf('pushSTK');
    sab('X9-1', 'moving the reservation AFTER the gateway call',
      body.replace(/await attemptRef\.create\(\{[\s\S]*?\}\);/, 'AFTERWARDS();'), (s) => !reservesFirst(s));
    sab('X9-2', 'claiming sent regardless of outcome',
      body.replace(/if \(outcome === 'GATEWAY_ACCEPTED'\)/, 'if (true)'),
      (s) => !/if \(outcome === 'GATEWAY_ACCEPTED'\)/.test(s));
    sab('X9-3', 'releasing the reservation on OUTCOME_UNKNOWN',
      body.replace(/state: 'OUTCOME_UNKNOWN'/, "state: 'RELEASED'"), (s) => !/state: 'OUTCOME_UNKNOWN'/.test(s));
    /* `amountKES: data.total` occurs TWICE — once in the gateway payload and once in the
       narrative call — so a non-global replace mutated the payload and left the narrative,
       the pattern survived, and the sabotage read as undetected. Both the mutation and the
       detector are now anchored to the PAYLOAD construction, which is the one that decides
       what is charged. */
    /* Anchored on the trailing COMMA, which only the payload line has: the narrative's copy ends
       ` })`. An earlier attempt used a lazy window from `buildPayload({`, which simply scanned
       past the mutated payload line and matched the narrative's `amountKES` instead — so the
       sabotage looked undetected while having been applied correctly. */
    const payloadAmount = /amountKES:\s*data\.total,/;
    check('X9-4a', payloadAmount.test(body), 'the gateway payload takes its amount from the server-stored total');
    sab('X9-4', 'sending a client-supplied amount to the gateway',
      body.replace(payloadAmount, (m) => m.replace('data.total', 'request.data.amount')),
      (s) => !payloadAmount.test(s));
    sab('X9-5', 'using the forbidden sellerName fallback for the narrative',
      body.replace(/resolveMerchantIdentity\(\s*\[String\(data\.sellerId\)\]/, 'useSellerName(data.sellerName'),
      (s) => !/resolveMerchantIdentity\(\s*\[String\(data\.sellerId\)\]/.test(s));
  }
  await behaviouralSab('X9-6', 'the gateway outcome classifier',
    () => { const o = GWMOD.classifyOutcome; GWMOD.classifyOutcome = () => 'GATEWAY_ACCEPTED'; return () => { GWMOD.classifyOutcome = o; }; },
    async () => { seed(); GW.status = 400; const r = await initiate(); return !r.err && r.ret && r.ret.status === 'stk_initiated'; },
    'a REJECTED request would be reported to the customer as sent');
  { seed(); const r = await initiate();
    check('X9-R', !r.err && r.ret.status === 'stk_initiated' && GW.requests.length === 1,
      'POST-SABOTAGE — restored, and a genuine send still works'); }

  return finish();
}

async function behaviouralSab(id, what, patch, probe, consequence) {
  const restore = patch();
  let got = false, err = null;
  try { got = await probe(); } catch (e) { err = e; } finally { restore(); }
  if (err) return bad(id, 'removing ' + what + ' — the probe CRASHED', err.message);
  return got ? ok(id, 'removing ' + what + ' → ' + consequence + ' — the guard is load-bearing')
             : bad(id, 'removing ' + what + ' changed NOTHING — decorative, or another layer is hiding it');
}

function sab(id, what, mutated, detector) {
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

function finish() {
  if (restoreHttps) restoreHttps();
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ P2: GREEN' : '❌ P2: NOT GREEN'));
  console.log('  Certification only. No gateway was contacted, no prompt sent, nothing deployed.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  if (restoreHttps) restoreHttps();
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
