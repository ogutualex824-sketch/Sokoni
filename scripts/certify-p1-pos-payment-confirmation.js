'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   P1 — POS PAYMENT CONFIRMATION INTEGRITY.

   THE DEFECT
   `completePOSQRPayment` marked a POS sale paid because the CALLER said so. It took `mpesaRef` /
   `intasendRef` from `request.data`, ran them through a length sanitiser, wrote `status: 'paid'`
   and created a completed order. A string is not a payment: the seller was authorising their own
   sale, and a fabricated reference was indistinguishable from a real one.

   WHAT IS PROVEN HERE
   The real `completePOSQRPayment` handler is executed, with Firestore replaced in memory and
   `fetch` replaced by a stub that impersonates IntaSend. Every assertion reads what the handler
   actually did: the URL it called, the bytes it wrote, and the figures it wrote them from.

   THE ANCHOR IS THE POINT
   Verification is keyed on the transactionId WE own — the `api_ref` P2's sender will put on the
   gateway record — never on a reference the caller supplied. A caller who could choose the
   reference could point us at somebody else's completed payment and collect a receipt for it.
   `A2-anchor` is the assertion that would catch that regression.

   STK INITIATION IS NOT PAYMENT CONFIRMATION. P2 may create the gateway transaction and put a
   prompt on the customer's phone; nothing becomes paid until the gateway's own record says
   COMPLETE.

   Run:  node scripts/certify-p1-pos-payment-confirmation.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-p1-cert';
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
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(11) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* ── In-memory Firestore, with transaction support ─────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  let writes = [];
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => { const v = data.get(key(c, d)); return { id: d, exists: v !== undefined, data: () => (v === undefined ? undefined : Object.assign({}, v)) }; };
  const docRef = (c, d) => ({
    id: String(d), _c: c, _d: d,
    get: async () => snapOf(c, d),
    set: async (o) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, o)); },
    update: async (o) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)); },
    delete: async () => { writes.push(key(c, d)); data.delete(key(c, d)); },
  });
  const collection = (c) => ({ doc: (d) => docRef(c, d), add: async (o) => { const id = 'auto' + data.size; writes.push(key(c, id)); data.set(key(c, id), o); return docRef(c, id); } });
  return {
    collection,
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (r) => r.get(),
        set: (r, o) => pending.push(['set', r, o]),
        update: (r, o) => pending.push(['update', r, o]),
      };
      const out = await fn(tx);                       /* a throw here commits nothing */
      for (const [op, r, o] of pending) await r[op](o);
      return out;
    },
    _put: (c, d, o) => data.set(key(c, d), Object.assign({}, o)),
    _get: (c, d) => (data.has(key(c, d)) ? Object.assign({}, data.get(key(c, d))) : null),
    _writes: () => writes.slice(),
    _clearWrites: () => { writes = []; },
    _count: (c) => [...data.keys()].filter((k) => k.startsWith(c + '/')).length,
  };
}
const STORE = makeStore();

/* ── The gateway stub — records what was asked, answers what the test dictates ──────────────── */
const GW = { calls: [], reply: null };
function installFetch() {
  global.fetch = async (url, opts) => {
    GW.calls.push({ url: String(url), headers: (opts && opts.headers) || {} });
    if (GW.reply instanceof Error) throw GW.reply;
    const r = GW.reply || { ok: true, status: 200, json: async () => ({ results: [] }) };
    return r;
  };
}
const gatewayRow = (over) => Object.assign({
  invoice_id: 'INV-1', tracking_id: 'TRK-1', api_ref: null, state: 'COMPLETE', value: 500,
}, over || {});
const replyWith = (rows) => { GW.reply = { ok: true, status: 200, json: async () => ({ results: rows }) }; };

/* ── Load the production graph ─────────────────────────────────────────────────────────────── */
let admin, posQr, VERIFY;
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const real = admin.firestore;
  const stub = function () { return STORE; };
  Object.getOwnPropertyNames(real).forEach((k) => { if (!['length', 'name', 'prototype'].includes(k)) { try { stub[k] = real[k]; } catch (_) {} } });
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect');
  installFetch();
  VERIFY = require(path.join(FN, 'shared', 'intasend-verify.js'));
  posQr = require(path.join(FN, 'pos-qr.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — ' + (e && e.message));
  console.log((e && e.stack || '').split('\n').slice(0, 6).join('\n'));
  clearTimeout(WATCHDOG); process.exit(2);
}

const SELLER = 'seller-p1', OTHER = 'other-p1';
const TXN = 'a'.repeat(32);
const TOTAL = 500;
const REQ = (uid, data) => ({ data, auth: { uid, token: { isSeller: true } }, rawRequest: { headers: {} }, acceptsStreaming: false });

function seedPending(txn) {
  STORE._put('posPayments', txn || TXN, {
    transactionId: txn || TXN, sellerId: SELLER, sellerName: 'KASS SHOP',
    items: [{ name: 'Item', price: TOTAL, qty: 1 }], subtotal: TOTAL, tax: 0, discount: 0,
    total: TOTAL, currency: 'KES', status: 'pending', attempts: 0,
  });
}

async function complete(data, uid) {
  GW.calls = [];
  STORE._clearWrites();
  let ret = null, err = null;
  try { ret = await quiet(() => posQr.completePOSQRPayment.run(REQ(uid || SELLER, data))); }
  catch (e) { err = e; }
  return { ret, err, writes: STORE._writes(), calls: GW.calls.slice() };
}

/* A refusal must refuse AND write nothing. */
function refuses(id, r, matcher, what) {
  if (!r.err) return bad(id, what + ' — NOT refused', JSON.stringify(r.ret).slice(0, 160));
  if (r.err instanceof TypeError || r.err instanceof ReferenceError) return bad(id, what + ' — CRASHED rather than refused', r.err.message);
  const text = (r.err.message || '') + ' ' + (r.err.reason || '');
  if (!matcher.test(text)) return bad(id, what + ' — refused for the WRONG reason', text.slice(0, 200));
  if (r.writes.length) return bad(id, what + ' — refused but WROTE', JSON.stringify(r.writes).slice(0, 200));
  return ok(id, what + ' → refused, nothing written');
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  P1 — POS PAYMENT CONFIRMATION INTEGRITY');
  console.log('  A string is not a payment. The gateway decides, server-side.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('0  HARNESS');
  check('H0-1', typeof posQr.completePOSQRPayment.run === 'function', 'the REAL completePOSQRPayment handler is invocable');
  check('H0-2', typeof VERIFY.verifyPayment === 'function', 'the shared verifier is loadable');
  {
    seedPending();
    replyWith([gatewayRow({ api_ref: TXN })]);
    const r = await complete({ transactionId: TXN });
    check('H0-3', !r.err && r.calls.length === 1, 'the harness can drive a full success', r.err && r.err.message);
    check('H0-4', STORE._get('posPayments', TXN).status === 'paid', 'and the store records it');
  }

  section('1  THE GATEWAY IS ASKED — server-side, about OUR reference');
  {
    seedPending();
    replyWith([gatewayRow({ api_ref: TXN })]);
    const r = await complete({ transactionId: TXN, intasendRef: 'SOMEONE-ELSES-INVOICE', mpesaRef: 'FORGED123' });
    check('A2-called', r.calls.length === 1, 'exactly one gateway call is made');
    const url = (r.calls[0] || {}).url || '';
    check('A2-endpoint', /\/api\/v1\/payment\/collection\/\?invoice_id=/.test(url),
      'it queries the collection endpoint — ' + url.replace(/^https?:\/\//, '').slice(0, 70));
    check('A2-anchor', url.indexOf(encodeURIComponent(TXN)) > -1 && url.indexOf('SOMEONE-ELSES-INVOICE') === -1,
      'keyed on OUR transactionId, NOT the caller\'s intasendRef — a chosen reference could point at another payment');
    const auth = ((r.calls[0] || {}).headers || {}).Authorization || '';
    check('A2-auth', /^Token /.test(auth), 'authenticated with the server-held key');
    check('A2-secret', JSON.stringify(r.ret || {}).indexOf(process.env.INTASEND_PRIVATE_KEY) === -1,
      'the key never appears in the response');
  }

  section('2  FAIL CLOSED — every refusal writes nothing');
  { seedPending(); replyWith([]);
    refuses('F-missing', await complete({ transactionId: TXN }), /payment_not_found/, 'no gateway record for the transaction'); }
  { seedPending(); replyWith([gatewayRow({ api_ref: TXN, state: 'PENDING' })]);
    refuses('F-pending', await complete({ transactionId: TXN }), /not_complete/, 'gateway state PENDING'); }
  { seedPending(); replyWith([gatewayRow({ api_ref: TXN, state: 'FAILED' })]);
    refuses('F-failed', await complete({ transactionId: TXN }), /not_complete/, 'gateway state FAILED'); }
  { seedPending(); replyWith([gatewayRow({ api_ref: TXN, value: TOTAL - 100 })]);
    refuses('F-short', await complete({ transactionId: TXN }), /amount_mismatch/, 'gateway paid less than the sale total'); }
  { seedPending(); replyWith([gatewayRow({ api_ref: 'A-DIFFERENT-TXN' })]);
    refuses('F-otherTxn', await complete({ transactionId: TXN }), /payment_not_found/, 'a COMPLETE payment belonging to a different transaction'); }
  { seedPending(); GW.reply = { ok: false, status: 500, json: async () => ({}) };
    refuses('F-5xx', await complete({ transactionId: TXN }), /gateway_error/, 'the gateway returning 500'); }
  { seedPending(); GW.reply = new Error('socket hang up');
    refuses('F-net', await complete({ transactionId: TXN }), /unreachable/, 'the gateway unreachable — no answer is not yes'); }
  { seedPending(); replyWith([gatewayRow({ api_ref: TXN, value: 0 })]);
    refuses('F-noAmt', await complete({ transactionId: TXN }), /amount_missing/, 'a gateway record carrying no amount'); }
  {
    seedPending();
    replyWith([gatewayRow({ api_ref: TXN })]);
    const r = await complete({ transactionId: TXN, mpesaRef: 'UIE6Q64WQP', intasendRef: 'INV-FORGED' });
    check('F-CTL', !r.err && STORE._get('posPayments', TXN).status === 'paid',
      'CONTROL — with a genuine COMPLETE record the same forged refs are harmless and the sale completes');
  }

  section('3  THE CALLER\'S REFERENCES ARE A CLAIM, NEVER PROOF');
  {
    const rec = STORE._get('posPayments', TXN);
    check('C3-1', rec.claimedMpesaRef === 'UIE6Q64WQP' && rec.claimedIntasendRef === 'INV-FORGED',
      'they are stored, under names that say what they are');
    check('C3-2', rec.mpesaRef === undefined || rec.mpesaRef === null,
      'they are NOT written to the fields a reader would take as verified');
    check('C3-3', rec.gatewayState === 'COMPLETE' && rec.gatewayAmount === TOTAL && !!rec.verifiedAt,
      'what the GATEWAY said is recorded separately, with the figure it reported');
    const ord = STORE._get('orders', rec.orderId);
    check('C3-4', !!ord && ord.gatewayAmount === TOTAL && ord.mpesaRef === undefined,
      'the ORDER carries the gateway figure, not the caller\'s string — orders are what everything downstream reconciles against');
  }

  section('4  DETERMINISTIC IDS AND IDEMPOTENT RETRY');
  {
    const first = STORE._get('posPayments', TXN);
    const firstOrder = first.orderId;
    const ordersBefore = STORE._count('orders');
    const again = await complete({ transactionId: TXN });
    check('D4-1', !again.err && again.ret && again.ret.status === 'already_paid',
      'a repeat confirmation returns already_paid');
    check('D4-2', STORE._count('orders') === ordersBefore, 'and creates NO second order');
    check('D4-3', again.calls.length === 0, '…without even calling the gateway again');
    /* Force the pre-paid state away and re-run: the ids must be identical, not merely unique. */
    STORE._put('posPayments', TXN, Object.assign(STORE._get('posPayments', TXN), { status: 'pending' }));
    replyWith([gatewayRow({ api_ref: TXN })]);
    const redo = await complete({ transactionId: TXN });
    check('D4-4', !redo.err && STORE._get('posPayments', TXN).orderId === firstOrder,
      'the same transaction always yields the SAME orderId (' + firstOrder + ') — a retry overwrites rather than multiplies');
    check('D4-5', /^ORD-POS-[0-9A-F]{10}$/.test(firstOrder) && /^RCP-[0-9A-F]{10}$/.test(first.receiptId),
      'ids are derived from the transaction, not from Date.now()');
    const other = 'b'.repeat(32);
    seedPending(other);
    replyWith([gatewayRow({ api_ref: other })]);
    await complete({ transactionId: other });
    check('D4-6', STORE._get('posPayments', other).orderId !== firstOrder,
      'CONTROL — a different transaction yields a different orderId');
  }

  section('5  THE AUTHORIZATION BOUNDARY IS UNCHANGED');
  {
    seedPending();
    replyWith([gatewayRow({ api_ref: TXN })]);
    const r = await complete({ transactionId: TXN }, OTHER);
    refuses('S5-1', r, /Only the seller/, 'a different signed-in user completing the seller\'s sale');
    check('S5-2', r.calls.length === 0, '…and the gateway is never called for them — authorization precedes verification');
  }
  {
    STORE._put('posPayments', 'ghost', undefined);
    const r = await complete({ transactionId: 'no-such-txn' });
    refuses('S5-3', r, /not found/i, 'an unknown transactionId');
  }

  section('6  THE SHARED VERIFIER IS PINNED TO THE CERTIFIED ONLINE CONTRACT');
  {
    const IDX = strip(fs.readFileSync(path.join(FN, 'index.js'), 'utf8'));
    const SHARED = strip(fs.readFileSync(path.join(FN, 'shared', 'intasend-verify.js'), 'utf8'));
    check('P6-1', /api\/v1\/payment\/collection\/\?invoice_id=/.test(IDX)
      && /api\/v1\/payment\/collection\/\?invoice_id=/.test(SHARED),
      'both rails query the SAME endpoint');
    check('P6-2', /state\s*!==\s*["']COMPLETE["']/.test(IDX) && /state !== COMPLETE/.test(SHARED.replace(/['"]/g, '')),
      'both require state COMPLETE');
    check('P6-3', /invoice_id === ref \|\| p\.tracking_id === ref \|\| p\.api_ref === ref/.test(IDX.replace(/\s+/g, ' '))
      && /invoice_id === reference \|\| p\.tracking_id === reference \|\| p\.api_ref === reference/.test(SHARED.replace(/\s+/g, ' ')),
      'both match on invoice_id | tracking_id | api_ref rather than assuming the first row');
    check('P6-4', /results \|\|/.test(IDX) && /results\)? \|\|/.test(SHARED),
      'both handle IntaSend\'s paginated list shape');
    check('P6-5', !/require\(['"]\.\/shared\/intasend-verify['"]\)/.test(IDX),
      'the certified online rail is NOT refactored in this gate — it still carries its own copy, pinned by the checks above');
  }

  section('7  SABOTAGE — per guard, on the live call path');
  {
    /* THE COMPLETE-STATE CHECK CANNOT BE SABOTAGED BY REBINDING, and an earlier draft of this
       suite tried: `intasend-verify` compares against a module-local `const COMPLETE`, a LEXICAL
       reference, so rebinding the export never reached the running code and the "sabotage" passed
       while proving nothing. That is the same trap this session already recorded once — writing
       the rule down is not the same as applying it.

       Asserted on source instead, with a mutation control that must flag its removal. The
       behavioural half is already covered: F-pending and F-failed drive real PENDING/FAILED
       gateway records through the live handler and require a refusal with no writes. */
    const SHARED = strip(fs.readFileSync(path.join(FN, 'shared', 'intasend-verify.js'), 'utf8'));
    const hasStateGuard = (s) => /row\.state\s*!==\s*COMPLETE/.test(s);
    check('X7-1', hasStateGuard(SHARED), 'the verifier refuses any state that is not COMPLETE');
    sab('X7-1b', 'removing the COMPLETE-state requirement',
      SHARED.replace(/row\.state\s*!==\s*COMPLETE/, 'false'), (s) => !hasStateGuard(s));
  }
  await sabotage('X7-2', 'the whole verifier',
    () => { const o = VERIFY.verifyPayment; VERIFY.verifyPayment = async () => ({ verified: true, state: 'COMPLETE', amount: 1 }); return () => { VERIFY.verifyPayment = o; }; },
    async () => { seedPending(); replyWith([]); const r = await complete({ transactionId: TXN }); return !r.err; },
    'a sale with NO gateway record at all would complete');
  {
    /* Source-level: the anchor. Rebinding cannot express "keyed on the caller's ref", so this is
       asserted on the handler text, with a mutation control. */
    const SRC = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
    const anchored = (s) => /reference:\s*transactionId/.test(s);
    check('X7-3', anchored(SRC), 'the verifier is called with reference: transactionId');
    sab('X7-4', 'anchoring verification on the caller\'s intasendRef',
      SRC.replace(/reference:\s*transactionId/, 'reference: intasendRef'), (s) => !anchored(s));
    sab('X7-5', 'writing the caller\'s ref into the verified field',
      SRC.replace(/claimedMpesaRef:/, 'mpesaRef:'), (s) => !/claimedMpesaRef:/.test(s));
    sab('X7-6', 'returning ids to Date.now()',
      SRC.replace(/const _idHash = [\s\S]{0,200}?toUpperCase\(\);/, 'const _idHash = Date.now().toString(36);'),
      (s) => !/createHash\('sha256'\)\.update\(String\(transactionId\)\)/.test(s));
  }
  {
    seedPending(); replyWith([gatewayRow({ api_ref: TXN })]);
    const r = await complete({ transactionId: TXN });
    check('X7-R', !r.err && STORE._get('posPayments', TXN).gatewayState === 'COMPLETE',
      'POST-SABOTAGE — every guard restored and a genuine payment still completes');
  }

  section('8  settleOrder IS UNTOUCHED');
  {
    /* `order-settlement.js` IS dirty — another agent is working the refund rail in it, and has been
       since before this gate opened. "No uncommitted change" was therefore the wrong assertion: it
       failed on someone else's work and would have kept failing no matter what P1 did.

       The claim that actually matters is that NOTHING IN THIS GATE touched it. Checked by its
       content: none of P1's markers appear in that file's uncommitted diff. */
    const d = require('child_process').execSync('git diff HEAD -- functions/order-settlement.js', { cwd: ROOT, encoding: 'utf8' });
    const p1Markers = /intasend-verify|verifyPayment|completePOSQRPayment|posPayments|gatewayState|claimedMpesaRef/;
    check('T8-1', !p1Markers.test(d),
      'no P1 change appears in functions/order-settlement.js (it is dirty from the refund agent, not from this gate)');
  }
  check('T8-2', !/settleOrder|settlementStatus/.test(strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'))),
    'pos-qr.js still does not enter the settlement state machine — the census finding is preserved, not broadened');

  return finish();
}

async function sabotage(id, what, patch, probe, consequence) {
  const restore = patch();
  let got = false, err = null;
  try { got = await probe(); } catch (e) { err = e; }
  finally { restore(); }
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
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ P1: GREEN' : '❌ P1: NOT GREEN'));
  console.log('  Certification only. No gateway was contacted and nothing was deployed.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
