'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   D1 + D2 — DARAJA OUTBOUND RETIRED; posPayments IS EXPLICITLY THE INTASEND QR RAIL.

   D1 removes the outbound Daraja surface, which `548e15d` had already made inert at the
   `_darajaToken` chokepoint: `darajaSTKPush`, `sendTestSTKPush`, `validateDarajaCredentials`,
   the helper they shared, their merchant-facing callers, the callback-registration instructions
   that caused sellers to register a URL in their own Safaricom portals, and their deployment
   entries.

   D2 states the QR rail's status contract instead of leaving it implied, and closes the three
   latent cross-shape edges the convergence census found.

   WHAT IS DELIBERATELY NOT DONE, and is asserted here rather than assumed:
     · `darajaSTKCallback` and `webhookMpesa` are UNTOUCHED. They are inbound. Sellers registered
       those URLs manually in Safaricom portals, outside version control, so deleting them while
       registrations stand means money settles at Safaricom and reconciles nowhere, silently.
       That is D3 and it is blocked on an external de-registration step.
     · `mpesa-c2b.js` is UNTOUCHED — it is NOT the Daraja STK rail. Zero outbound credentials; it
       only receives C2B for money already settled.
     · `initiateSTKPush` and the certified IntaSend online rail are UNTOUCHED.
     · The 13 historical Daraja documents are UNTOUCHED.

   A REMOVAL FROM THIS REPOSITORY IS NOT A REMOVAL FROM PRODUCTION. The deployed functions remain
   until someone explicitly deletes them, which is a deployment action and is not authorised here.

   Run:  node scripts/certify-d1d2-daraja-retirement.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-d1d2-cert';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'cert-qr-secret';
process.env.INTASEND_PRIVATE_KEY = process.env.INTASEND_PRIVATE_KEY || 'cert-not-a-real-key';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 180s. Failing closed.\n');
  process.exit(2);
}, 180000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(11) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(11) + m + (x ? '\n               ' + String(x).slice(0, 240) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(11) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* EVERY SABOTAGE MUST LAND. Three mutations silently failed to apply earlier in this work and
   reported "not detected" while the product was fine. One line stops all of them. */
function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); the check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

/* Extract one top-level function/exports block by name, for byte-comparison across revisions. */
function blockOf(src, name) {
  const i = src.indexOf(name);
  if (i < 0) return null;
  const next = src.slice(i + name.length).search(/\n(exports\.|async function |function )/);
  return next < 0 ? src.slice(i) : src.slice(i, i + name.length + next);
}
const headFile = (p) => { try { return execSync('git show HEAD:' + p, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { return null; } };

/* ── Store + gateway stubs ─────────────────────────────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => { const v = data.get(key(c, d)); return { id: d, exists: v !== undefined, data: () => (v === undefined ? undefined : Object.assign({}, v)), ref: { update: async (o) => data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)) } }; };
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
const GW = { requests: [], status: 200, body: { invoice: { invoice_id: 'INV-D' } } };
const VERIFY_REPLY = { rows: [] };

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
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: VERIFY_REPLY.rows }) });
  posQr = require(path.join(FN, 'pos-qr.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — ' + (e && e.message));
  clearTimeout(WATCHDOG); process.exit(2);
}

const SELLER = 'seller-d', TXN = 'e'.repeat(32), TOTAL = 700, PHONE = '254712345678';
const REQ = (uid, data) => ({ data, auth: { uid, token: { isSeller: true } }, rawRequest: { headers: {} }, acceptsStreaming: false });
function seed() {
  STORE._del('paymentAttempts', TXN);
  STORE._put('posPayments', TXN, {
    transactionId: TXN, sellerId: SELLER, sellerName: 'KASS SHOP', items: [{ name: 'x', price: TOTAL, qty: 1 }],
    subtotal: TOTAL, tax: 0, discount: 0, total: TOTAL, currency: 'KES', status: 'pending', attempts: 0,
    signature: require('crypto').createHmac('sha256', process.env.QR_SIGNING_SECRET).update(TXN).digest('hex').slice(0, 16),
    expiresAt: { toMillis: () => Date.now() + 600000 },
  });
  STORE._put('shops', SELLER, { name: 'KASS SHOP' });
  GW.requests = []; GW.status = 200;
}

/* ── Sources ───────────────────────────────────────────────────────────────────────────────── */
const IDX_RAW = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const IDX = strip(IDX_RAW);
const POS_QR = strip(fs.readFileSync(path.join(FN, 'pos-qr.js'), 'utf8'));
const ZF = strip(fs.readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8'));

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  D1 + D2 — DARAJA OUTBOUND RETIRED; posPayments IS THE INTASEND QR RAIL');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('1  INTASEND QR WORKS END TO END');
  {
    seed();
    let r = null, err = null;
    try { r = await quiet(() => posQr.initiatePOSQRPayment.run(REQ(SELLER, { transactionId: TXN, method: 'mpesa', phone: PHONE }))); } catch (e) { err = e; }
    check('E1-1', !err && r && r.status === 'stk_initiated', 'P2 sends the prompt through IntaSend', err && err.message);
    const wire = JSON.parse((GW.requests[0] || {}).body || '{}');
    check('E1-2', wire.api_ref === TXN && wire.amount === TOTAL, 'with our transactionId as api_ref and the server total');
    VERIFY_REPLY.rows = [{ invoice_id: 'INV-D', tracking_id: 'T', api_ref: TXN, state: 'COMPLETE', value: TOTAL }];
    let c = null, cerr = null;
    try { c = await quiet(() => posQr.completePOSQRPayment.run(REQ(SELLER, { transactionId: TXN }))); } catch (e) { cerr = e; }
    check('E1-3', !cerr && c && c.status === 'paid', 'P1 verifies with IntaSend and completes the sale', cerr && cerr.message);
    check('E1-4', STORE._get('posPayments', TXN).status === 'paid' && STORE._count('orders') === 1,
      'the sale is paid and exactly one order exists — IntaSend is the sole authority end to end');
  }

  section('2  THE OUTBOUND DARAJA SURFACE IS GONE');
  for (const name of ['_darajaToken', 'darajaSTKPush', 'sendTestSTKPush', 'validateDarajaCredentials', '_darajaTimestamp']) {
    check('R2-' + name, IDX.indexOf(name) === -1, name + ' is absent from functions/index.js');
  }
  check('R2-exp', !/exports\.(darajaSTKPush|sendTestSTKPush|validateDarajaCredentials)\s*=/.test(IDX),
    'none of them is exported');
  check('R2-ctl', /exports\.darajaSTKPush\s*=/.test('exports.darajaSTKPush = onCall('),
    'CONTROL — the export detector fires when such an export IS present');

  section('3  ZERO MERCHANT CLIENT INVOCATIONS; REGISTRATION INSTRUCTIONS GONE');
  {
    const files = execSync('git ls-files "*.js" "*.html"', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
      .filter((f) => !/^scripts\/certify-d1d2/.test(f));
    const invokers = [], publishers = [];
    for (const f of files) {
      let s; try { s = strip(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (_) { continue; }
      if (/['"](darajaSTKPush|sendTestSTKPush|validateDarajaCredentials)['"]/.test(s)) invokers.push(f);
      if (/cloudfunctions\.net\/darajaSTKCallback/.test(s)) publishers.push(f);
    }
    check('C3-1', invokers.length === 0, 'no tracked js/html invokes a retired Daraja callable (' + files.length + ' scanned)', JSON.stringify(invokers));
    check('C3-2', publishers.length === 0, 'no page publishes the callback URL for sellers to register', JSON.stringify(publishers));
  }
  {
    const dep = ['deploy-batches.ps1', 'scripts/batch_deploy.sh', 'scripts/deploy/functions-allowlist.js']
      .filter((f) => /darajaSTKPush|sendTestSTKPush|validateDarajaCredentials/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('C3-3', dep.length === 0, 'no deployment driver still deploys a retired Daraja callable', JSON.stringify(dep));
    const keeps = ['deploy-batches.ps1', 'scripts/batch_deploy.sh']
      .every((f) => /darajaSTKCallback/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check('C3-4', keeps, 'and darajaSTKCallback is still deployable — it is inbound, and D3 is blocked');
  }

  section('4  THE INBOUND HANDLERS AND THE CERTIFIED RAIL ARE BYTE-UNCHANGED');
  {
    const head = headFile('functions/index.js');
    if (!head) blocked('U4', 'could not read functions/index.js from HEAD');
    else {
      /* `initiateSTKPush` is NOT byte-compared: another agent has uncommitted work inside it
         (the stk-intent-enforcement extraction). Asserting "unchanged vs HEAD" there would fail
         on THEIR work and keep failing whatever this gate did — the same mis-assertion P1's T8-1
         made. What matters is that no D1/D2 change touched it, which is checked by content
         below. */
      for (const name of ['exports.darajaSTKCallback', 'exports.webhookMpesa', 'exports.webhookIntasend', 'exports.verifyIntasendPayment']) {
        const a = blockOf(head, name), b = blockOf(IDX_RAW, name);
        check('U4-' + name.replace('exports.', ''), a !== null && b !== null && a === b,
          name + ' is byte-identical to HEAD');
      }
      {
        const mine = /D1 —|D2 —|_isDarajaShape|_darajaToken|darajaSTKPush|sendTestSTKPush|validateDarajaCredentials/;
        const blk = blockOf(IDX_RAW, 'exports.initiateSTKPush');
        check('U4-initiateSTKPush', blk !== null && !mine.test(blk),
          'initiateSTKPush carries no D1/D2 change (it differs from HEAD only through another agent\'s in-flight work)');
      }
    }
    for (const f of ['functions/mpesa-c2b.js']) {
      const a = headFile(f), b = fs.readFileSync(path.join(ROOT, f), 'utf8');
      check('U4-c2b', a !== null && a === b, f + ' is byte-identical to HEAD — it is NOT the Daraja STK rail');
    }
  }

  section('5  THE QR STATUS CONTRACT');
  check('S5-1', Array.isArray(posQr.QR_STATUSES) && posQr.QR_STATUSES.join(',') === 'pending,paid,expired,cancelled,refunded',
    'the contract is declared: ' + (posQr.QR_STATUSES || []).join(' | '));
  check('S5-2', posQr.QR_STATUSES.indexOf('completed') === -1, "'completed' is NOT a QR status");
  check('S5-3', Object.isFrozen(posQr.QR_STATUSES), 'and it is frozen');
  {
    const writes = [];
    const re = /(ref|_ref)\.(set|update)\(\{[\s\S]{0,700}?\}\)|tx\.update\(ref,\s*\{[\s\S]{0,700}?\}\)/g;
    let m; while ((m = re.exec(POS_QR))) [...m[0].matchAll(/status:\s*'([a-z_]+)'/g)].forEach((x) => writes.push(x[1]));
    const unknown = [...new Set(writes)].filter((s) => posQr.QR_STATUSES.indexOf(s) === -1);
    check('S5-4', unknown.length === 0, 'every status written to the QR document is in the contract — ' + JSON.stringify([...new Set(writes)]), JSON.stringify(unknown));
  }

  section('6  THE THREE LATENT CROSS-SHAPE EDGES');
  /* ── pos-zero-friction: HANDED OVER, NOT FIXED HERE ──────────────────────────────────────
     The edge is real and I had already written the fix — then found the block containing it does
     not exist in HEAD. It is another agent's uncommitted work in progress, and my change sat
     INSIDE their 893-line addition, so there was no hunk that could carry mine without carrying
     288 lines of their unfinished code. The edit was withdrawn and their block restored verbatim.

     Asserted here as a HANDOVER so the finding is not lost: the defect is recorded, its absence
     from this commit is deliberate, and the suite proves I left their file alone. */
  check('L6-1', !/D2 —|payOwner|PAID_STATES/.test(ZF),
    'pos-zero-friction carries NO D2 edit — the fix was withdrawn because it lived inside another agent\'s uncommitted block');
  check('L6-2', /if \(pay\.sellerUid && pay\.sellerUid !== merchantId/.test(ZF),
    '…their original ownership guard is restored byte-for-byte');
  check('L6-3', /if \(pay\.status !== 'completed'\)/.test(ZF),
    '…and so is their status check. BOTH are defects once Daraja is retired: `pay.sellerUid &&` '
    + 'skips the ownership check entirely for a QR document, and `completed` can no longer be '
    + 'written by anything. Handed to the refund/POS agent; see the changelog.');
  check('L6-4', /function _sigMatches/.test(POS_QR) && !/crypto\.timingSafeEqual\(Buffer\.from\(data\.signature/.test(POS_QR),
    'getPOSPaymentDetails compares signatures through a comparator that cannot throw');
  {
    /* Drive the previously-crashing input through the REAL handler. */
    const legacyId = 'f'.repeat(32);
    STORE._put('posPayments', legacyId, { checkoutId: 'ws_CO_123', status: 'completed', sellerUid: 'someone' });
    let err = null;
    try { await quiet(() => posQr.getPOSPaymentDetails.run(REQ(SELLER, { transactionId: legacyId }))); } catch (e) { err = e; }
    check('L6-5', !!err && !(err instanceof TypeError) && /Invalid payment reference/.test(err.message || ''),
      'a Daraja-shaped document at a 32-char id is REFUSED, not an INTERNAL crash — "' + (err && err.message) + '"');
    STORE._del('posPayments', legacyId);
  }
  check('L6-6', /_isDarajaShape\s*=\s*\(d\)\s*=>\s*!!\(d && d\.checkoutId && d\.transactionId === undefined\)/.test(IDX),
    'verifyPaymentStatus has an explicit rail discriminator');
  check('L6-7', /if \(!_isDarajaShape\(d\)\) return \{ status: "not_found" \};/.test(IDX),
    '…and its orderId query refuses a QR document rather than reporting its status to a Daraja caller');

  section('7  THE 13 HISTORICAL DARAJA DOCUMENTS');
  check('H7-1', IDX.indexOf('collection("posPayments").doc(checkoutId).set(') === -1
    && IDX.indexOf('collection("posPayments").doc(safCheckoutId).set(') === -1,
    'no code path can create a Daraja-shaped posPayments document any more');
  check('H7-2', /db\.collection\("posPayments"\)\.doc\(checkoutId\)/.test(IDX),
    'darajaSTKCallback can still read/settle the existing ones — they are not orphaned');
  {
    const d = execSync('git diff HEAD -- functions/index.js', { cwd: ROOT, encoding: 'utf8' });
    check('H7-3', !/^\+.*posPayments.*delete\(\)/m.test(d) && !/deleteDoc|batch\.delete/.test(d),
      'this gate adds no deletion of any posPayments document');
  }

  section('8  SABOTAGE');
  sab('X8-1', 'restoring an outbound Daraja export', IDX,
    IDX.replace('exports.darajaSTKCallback', 'exports.darajaSTKPush = onCall({},async()=>{});\nexports.darajaSTKCallback'),
    (s) => /exports\.darajaSTKPush\s*=/.test(s));
  sab('X8-2', 'letting the QR rail write a Daraja status', POS_QR,
    POS_QR.replace("status:         'paid',", "status:         'completed',"),
    (s) => { const w = []; const re = /(ref|_ref)\.(set|update)\(\{[\s\S]{0,700}?\}\)|tx\.update\(ref,\s*\{[\s\S]{0,700}?\}\)/g; let m; while ((m = re.exec(s))) [...m[0].matchAll(/status:\s*'([a-z_]+)'/g)].forEach((x) => w.push(x[1])); return w.indexOf('completed') > -1; });
  /* X8-3 would have sabotaged the pos-zero-friction ownership fix. That fix is not in this
     commit (see §6), so there is nothing here to sabotage — asserting otherwise would be a
     check that proves nothing. What IS sabotaged instead is my leaving their file alone. */
  sab('X8-3', 'slipping a D2 edit into another agent\'s uncommitted file', ZF,
    ZF.replace(/if \(pay\.status !== 'completed'\) \{/, "const PAID_STATES = { completed: 1, paid: 1 };\n      if (!PAID_STATES[pay.status]) {"),
    (s) => /PAID_STATES/.test(s));
  sab('X8-4', 'returning the raw timingSafeEqual call', POS_QR,
    POS_QR.replace('_sigMatches(data.signature, expectedSig)', 'crypto.timingSafeEqual(Buffer.from(data.signature || \'\'), Buffer.from(expectedSig))'),
    (s) => /crypto\.timingSafeEqual\(Buffer\.from\(data\.signature/.test(s));
  sab('X8-5', 'removing the rail discriminator', IDX,
    IDX.replace(/if \(!_isDarajaShape\(d\)\) return \{ status: "not_found" \};/, ''),
    (s) => !/if \(!_isDarajaShape\(d\)\) return \{ status: "not_found" \};/.test(s));
  sab('X8-6', 'republishing the callback URL to sellers', 'clean',
    'copy this: https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback',
    (s) => /cloudfunctions\.net\/darajaSTKCallback/.test(s));

  return finish();
}

function finish() {
  if (restoreHttps) restoreHttps();
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ D1+D2: GREEN' : '❌ D1+D2: NOT GREEN'));
  console.log('  Certification only. Nothing deployed; the inbound handlers were not modified.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  if (restoreHttps) restoreHttps();
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e));
  clearTimeout(WATCHDOG); process.exit(2);
});
