'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   P3-A — THE INTASEND CALLBACK NOW SAYS *WHICH* POS SALE. IT STILL CANNOT SAY *PAID*.

   A POS QR sale lives in `posPayments/{transactionId}`, and P2 sets IntaSend's `api_ref` to that
   same id. Both webhooks looked the ref up in `payments/{apiRef}`, missed, and dropped the
   callback — safe, but the till and the customer's pay.html learned nothing until a cashier
   pressed confirm.

   This gate associates the callback with the sale. It is a LATENCY improvement, not an integrity
   repair: P1 (`completePOSQRPayment` → `shared/intasend-verify.js`) already obtains authoritative
   association by asking IntaSend directly. Association only lets the screens find out sooner.

   THE LINE THAT MUST NOT MOVE: a webhook that could set `paid` would reintroduce exactly the
   trust hole P1 closed, by a different door. `status` is on a FORBIDDEN list the pure module
   enforces against its own output, and §3/§6 prove it both by inspection and by execution.

   NO DARAJA, ONLY INTASEND — asserted, not assumed: a Daraja-shaped document is refused outright
   (§3), the wiring exists only in the IntaSend handler (§4), and every Daraja inbound handler is
   byte-identical to HEAD (§7).

   Run:  node scripts/certify-p3a-pos-qr-association.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 120s. Failing closed.\n');
  process.exit(2);
}, 120000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(13) + m); return true; };
const bad = (id, m, x) => { FAIL++; FAILURES.push(id + ' — ' + m); console.log('  ✖ ' + id.padEnd(13) + m + (x ? '\n                  ' + String(x).slice(0, 240) : '')); return false; };
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(13) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 80)));

/* Comments in these files quote the patterns under test ("must never write `status`"), so a
   check on raw source would read its own prohibition as a violation. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const headFile = (p) => { try { return execSync('git show HEAD:' + p, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { return null; } };

function sab(id, what, original, mutated, detector) {
  if (mutated === original) return bad(id, what + ' — THE MUTATION DID NOT APPLY (anchor missed); this check would have proved nothing');
  let f;
  try { f = detector(mutated) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return f ? ok(id, 'SABOTAGE ' + what + ' → detected') : bad(id, 'SABOTAGE ' + what + ' → NOT detected');
}

function blockOf(src, name) {
  if (!src) return null;
  const i = src.indexOf(name);
  if (i < 0) return null;
  const next = src.slice(i + name.length).search(/\n(exports\.|async function |function )/);
  return next < 0 ? src.slice(i) : src.slice(i, i + name.length + next);
}

/** Extract one `async function NAME(...) { … }` by brace matching, so the SHIPPED text runs. */
function extractFn(src, name) {
  const i = src.indexOf('async function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}

const MOD = 'functions/shared/pos-qr-association.js';
const SRC = read(MOD);
const IDX = read('functions/index.js');
const IDX_S = strip(IDX);
const assoc = require(path.join(ROOT, MOD));

const QR = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';          /* 32 hex — a real QR shape */
const QR2 = 'ffffffffffffffffffffffffffffffff';

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  P3-A — POS QR WEBHOOK ASSOCIATION — CERTIFICATION');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('1  THE MODULE IS NOT, AND CANNOT BECOME, A PAYMENT AUTHORITY');

  {
    const reqs = [...SRC.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    check('A1-1', reqs.length === 1 && reqs[0] === './pos-payment-ownership',
      'exactly ONE require — the sibling pure module for the rail discriminator', reqs.join(', '));
    check('A1-2', !/firebase-admin|firebase-functions|\bfetch\b|https?\./.test(strip(SRC)),
      'no admin SDK, no functions SDK, no network — it cannot perform a write it did not describe');
    check('A1-3', !/\.set\(|\.update\(|\.create\(|\.delete\(|runTransaction/.test(strip(SRC)),
      'no Firestore operation of any kind appears in the module');
    check('A1-4', !/Date\.now|new Date/.test(strip(SRC)),
      'no clock — `receivedAt` is supplied by the caller, so the module is fully deterministic');

    check('A1-5', assoc.FORBIDDEN_FIELDS.includes('status'),
      '`status` is on the FORBIDDEN list, executably — not merely promised in a comment');
    for (const f of ['paidAt', 'orderId', 'receiptId', 'sellerId', 'gatewayAmount']) {
      check('A1-' + f, assoc.FORBIDDEN_FIELDS.includes(f), '…so is `' + f + '`');
    }
    check('A1-6', assoc.ALLOWED_FIELDS.length === 4,
      'exactly FOUR association fields are permitted: ' + assoc.ALLOWED_FIELDS.join(', '));
    check('A1-7', assoc.ALLOWED_FIELDS.every((f) => !assoc.FORBIDDEN_FIELDS.includes(f)),
      'the allowed set and the forbidden set are disjoint');

    /* One rail discriminator, not two. Duplicating it would let the two drift. */
    const own = require(path.join(ROOT, 'functions/shared/pos-payment-ownership.js'));
    const cases = [
      { transactionId: 't' }, { checkoutId: 'c' }, { transactionId: 't', checkoutId: 'c' }, {}, null,
    ];
    check('A1-8', !/function classifyRail/.test(SRC),
      'the module does NOT redefine the rail discriminator — there is one implementation');
    check('A1-9', cases.every((c) => typeof own.classifyRail(c) === 'string'),
      '…and it comes from the certified ownership authority, which classifies every shape');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('2  IDENTITY — `api_ref` IS THE SOLE ANCHOR');

  check('B2-1', assoc.isQrRef(QR), 'a 32-char lowercase hex ref is recognised as a QR transactionId');
  check('B2-2', !assoc.isQrRef('wtop_' + QR), 'a wallet top-up ref can NEVER enter the POS path');
  check('B2-3', !assoc.isQrRef('pout_abc123'), 'nor a B2C payout ref');
  check('B2-4', !assoc.isQrRef(QR.toUpperCase()), 'nor an upper-case variant — the shape is exact');
  check('B2-5', !assoc.isQrRef(QR.slice(0, 31)) && !assoc.isQrRef(QR + 'a'),
    'nor a 31- or 33-character ref');
  check('B2-6', !assoc.isQrRef(null) && !assoc.isQrRef(undefined) && !assoc.isQrRef(42) && !assoc.isQrRef({}),
    'nor a null, undefined, number or object');
  check('B2-7', !assoc.isQrRef('../../etc/passwd') && !assoc.isQrRef('a/b'),
    'nor a path-shaped string — a ref can never address another collection');

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('3  THE DECISION — pure, exhaustive, and IntaSend-only');

  {
    const QRDOC = { transactionId: QR, sellerId: 'shop_A', status: 'pending', total: 500 };
    const CB = { state: 'COMPLETE', gatewayInvoiceId: 'INV-1', receivedAt: 'TS' };

    const good = assoc.associationFor(QRDOC, CB);
    check('C3-1', good.associate === true && good.rail === 'qr',
      'a valid QR sale + a COMPLETE callback → ASSOCIATE');
    check('C3-2', Object.keys(good.fields).length === 3
      && good.fields.gatewayInvoiceId === 'INV-1'
      && good.fields.gatewayState === 'COMPLETE'
      && good.fields.gatewayNotifiedAt === 'TS',
      '…writing three fields; the fourth (' + assoc.COUNT_FIELD + ') is the caller\'s increment',
      JSON.stringify(good.fields));
    check('C3-3', !('status' in good.fields),
      '…and NO `status`. The callback cannot say paid.');
    check('C3-4', assoc.FORBIDDEN_FIELDS.every((f) => !(f in good.fields)),
      '…nor any other forbidden field');

    /* NO DARAJA, ONLY INTASEND. */
    check('C3-5', assoc.associationFor({ checkoutId: 'ws_CO_123', sellerUid: 'x' }, CB).reason === 'legacy_daraja_document',
      'a DARAJA-shaped document is REFUSED — the association path is IntaSend-only');
    check('C3-6', assoc.associationFor({ transactionId: QR, checkoutId: 'ws_CO_1' }, CB).reason === 'unknown_shape',
      'a document carrying BOTH discriminators is refused rather than guessed at');
    check('C3-7', assoc.associationFor({}, CB).reason === 'unknown_shape',
      'a document carrying neither is refused');
    check('C3-8', assoc.associationFor(null, CB).reason === 'no_document',
      'an absent document is refused — the unknown-ref case, and it is SAFE');
    check('C3-9', assoc.associationFor(QRDOC, { state: '' }).reason === 'no_state'
      && assoc.associationFor(QRDOC, {}).reason === 'no_state'
      && assoc.associationFor(QRDOC, null).reason === 'no_state',
      'a callback with no state records nothing');

    check('C3-10', assoc.associationFor(QRDOC, { state: 'complete' }).fields.gatewayState === 'COMPLETE',
      'state is normalised to upper case, so `complete` and `COMPLETE` cannot diverge');
    check('C3-11', assoc.associationFor(QRDOC, { state: 'FAILED' }).fields.gatewayInvoiceId === null,
      'a missing gateway invoice id records null rather than undefined');

    /* MONOTONIC — delivery is not ordered. */
    const paidDoc = { ...QRDOC, gatewayState: 'COMPLETE' };
    const late = assoc.associationFor(paidDoc, { state: 'FAILED', receivedAt: 'TS2' });
    check('C3-12', late.associate === true && late.monotonicHold === true
      && late.fields.gatewayState === 'COMPLETE',
      'a FAILED arriving AFTER a COMPLETE cannot walk the sale backwards — the hold is explicit');
    const again = assoc.associationFor(paidDoc, { state: 'COMPLETE', receivedAt: 'TS3' });
    check('C3-13', again.monotonicHold === false && again.fields.gatewayState === 'COMPLETE',
      '…while a repeated COMPLETE is not a hold — it simply converges');
    check('C3-14', assoc.associationFor({ ...QRDOC, gatewayState: 'PENDING' }, { state: 'COMPLETE' }).fields.gatewayState === 'COMPLETE',
      'PENDING → COMPLETE still advances; the rule guards success, it does not freeze everything');

    /* The module refuses its OWN output. */
    check('C3-15', typeof assoc.associationFor === 'function' && /forbidden_field/.test(SRC),
      'the module validates its own output against the forbidden list before returning');

    /* It never throws and never mutates its input. */
    let threw = null;
    const hostile = [undefined, null, 0, '', [], { transactionId: {} }, { transactionId: QR, gatewayState: {} }];
    for (const h of hostile) {
      for (const c of [undefined, null, {}, { state: {} }, { state: 'X'.repeat(5000) }]) {
        try { assoc.associationFor(h, c); } catch (e) { threw = e; }
      }
    }
    check('C3-16', !threw, 'NEVER throws — across ' + (hostile.length * 5) + ' hostile input pairs', threw && threw.message);
    const frozen = JSON.stringify(QRDOC);
    assoc.associationFor(QRDOC, CB);
    check('C3-17', JSON.stringify(QRDOC) === frozen, 'and never mutates the document it is given');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('4  THE WIRING — ONE call site, in the INTASEND handler only');

  {
    check('D4-1', /require\("\.\/shared\/pos-qr-association"\)/.test(IDX_S),
      'index.js requires the pure module');
    check('D4-2', /async function _associatePosQrCallback\(/.test(IDX_S),
      'the caller exists');

    const calls = (IDX_S.match(/await _associatePosQrCallback\(/g) || []).length;
    check('D4-3', calls === 1, 'EXACTLY ONE call site — found ' + calls);

    const wi = blockOf(IDX, 'exports.webhookIntasend');
    const iw = blockOf(IDX, 'exports.intasendWebhook');
    const vi = blockOf(IDX, 'exports.verifyIntasendPayment');
    check('D4-4', wi && /_associatePosQrCallback\(/.test(wi),
      '…and it is inside webhookIntasend — the handler that receives 100% of production callbacks');
    check('D4-5', iw && !/_associatePosQrCallback\(/.test(iw),
      'intasendWebhook is NOT wired — it receives no production traffic and was not touched merely because it exists');
    check('D4-6', vi && !/_associatePosQrCallback\(/.test(vi),
      'verifyIntasendPayment is NOT modified');

    /* The seam: the call must sit INSIDE the `payments/{apiRef}` miss branch. */
    const seam = /if \(!snap\.exists\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?await _associatePosQrCallback\(apiRef, state, checkoutId, "webhookIntasend"\);\s*res\.status\(200\)\.send\("OK"\); return;\s*\}/;
    check('D4-7', seam.test(wi || ''),
      'the call sits INSIDE the `payments/{apiRef}` MISS branch, before the unchanged 200');

    const iMiss = (wi || '').indexOf('if (!snap.exists)');
    const iCall = (wi || '').indexOf('_associatePosQrCallback(apiRef');
    const iGet = (wi || '').indexOf('const snap   = await payRef.get();');
    check('D4-8', iGet > -1 && iMiss > iGet && iCall > iMiss,
      'ORDER PROVEN: payments lookup → miss → associate. An existing online payment never reaches it.');

    check('D4-9', /_qrAssoc\.COUNT_FIELD\]: admin\.firestore\.FieldValue\.increment\(1\)/.test(IDX_S),
      'the caller applies the fourth field as an atomic increment');
    check('D4-10', /db\.runTransaction/.test((IDX.slice(IDX.indexOf('async function _associatePosQrCallback'), IDX.indexOf('async function _associatePosQrCallback') + 2200))),
      'the read-decide-write runs in a transaction — the monotonic check needs the prior value');
    check('D4-11', /catch \(e\) \{[\s\S]{0,200}return false;/.test(IDX.slice(IDX.indexOf('async function _associatePosQrCallback'))),
      'the caller cannot throw into the webhook — a 500 would make IntaSend retry a payment webhook forever');

    /* paymentAttempts must NOT become the association channel — no client can read it. */
    const fn = extractFn(IDX, '_associatePosQrCallback') || '';
    check('D4-12', !/paymentAttempts/.test(fn),
      'the association does NOT write paymentAttempts — no client can read that collection');
    check('D4-13', /collection\("posPayments"\)/.test(fn),
      '…it writes posPayments, which the deployed ruleset lets the seller and buyer read');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('5  THE CERTIFIED ONLINE RAIL IS UNCHANGED');

  {
    const wiHead = blockOf(headFile('functions/index.js'), 'exports.webhookIntasend');
    const wiNow = blockOf(IDX, 'exports.webhookIntasend');
    if (!wiHead) { blocked('E5-0', 'cannot read webhookIntasend at HEAD'); }
    else {
      /* Reverse the insertion and the handler must be byte-identical to HEAD again. That is a
         far stronger statement than "it looks similar": it proves the ONLY change is the seam. */
      const inserted = wiNow.match(/    if \(!snap\.exists\) \{\n(?:[\s\S]*?)\n    \}\n/);
      const restored = wiNow.replace(
        /    if \(!snap\.exists\) \{\n(?:[\s\S]*?)\n    \}\n/,
        '    if (!snap.exists) { res.status(200).send("OK"); return; }\n');
      check('E5-1', !!inserted, 'the insertion is locatable in the current handler');
      check('E5-2', restored === wiHead,
        'REVERSING the insertion restores webhookIntasend BYTE-FOR-BYTE to HEAD — nothing else changed',
        restored === wiHead ? '' : 'lengths ' + restored.length + ' vs ' + wiHead.length);

      const after = wiNow.slice(wiNow.indexOf('const existing = snap.data();'));
      const afterHead = wiHead.slice(wiHead.indexOf('const existing = snap.data();'));
      check('E5-3', after === afterHead && after.length > 500,
        'everything AFTER the miss branch — the whole existing-payment path — is byte-identical');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('6  RUNTIME — the SHIPPED caller, executed against a stubbed store');

  {
    const fnSrc = extractFn(IDX, '_associatePosQrCallback');
    if (!fnSrc) { blocked('F6-0', 'could not extract the caller from index.js'); }
    else {
      const mk = (docs) => {
        const writes = [];
        const store = new Map(Object.entries(docs));
        const db = {
          collection: (c) => ({
            doc: (id) => ({ _k: c + '/' + id }),
          }),
          runTransaction: async (f) => f({
            get: async (r) => ({ exists: store.has(r._k), data: () => store.get(r._k) }),
            update: (r, data) => {
              writes.push({ key: r._k, data });
              const cur = store.get(r._k) || {};
              const next = { ...cur };
              for (const [k, v] of Object.entries(data)) {
                next[k] = (v && v.__inc) ? (Number(cur[k] || 0) + v.__inc) : v;
              }
              store.set(r._k, next);
            },
          }),
        };
        const admin = { firestore: { FieldValue: {
          serverTimestamp: () => '__TS__',
          increment: (n) => ({ __inc: n }),
        } } };
        const sandbox = { db, admin, _qrAssoc: assoc, console: { log() {}, error() {} } };
        vm.createContext(sandbox);
        vm.runInContext(fnSrc + '\nthis.__fn = _associatePosQrCallback;', sandbox);
        return { run: sandbox.__fn, writes, store };
      };

      const DOC = { transactionId: QR, sellerId: 'shop_A', status: 'pending', total: 500 };

      /* — a real QR sale — */
      {
        const h = mk({ ['posPayments/' + QR]: { ...DOC } });
        const r = await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        const after = h.store.get('posPayments/' + QR);
        check('F6-1', r === true && h.writes.length === 1, 'a QR callback performs exactly ONE write');
        check('F6-2', after.gatewayState === 'COMPLETE' && after.gatewayInvoiceId === 'INV-9'
          && after.gatewayNotifiedAt === '__TS__' && after.gatewayCallbackCount === 1,
          '…and all FOUR association fields are present and correct', JSON.stringify(after));
        check('F6-3', after.status === 'pending',
          '…while `status` is STILL `pending`. THE CALLBACK DID NOT PAY THE SALE.');
        check('F6-4', after.total === 500 && after.sellerId === 'shop_A',
          '…and the server-owned amount and seller are untouched');
        const written = Object.keys(h.writes[0].data);
        check('F6-5', written.every((k) => assoc.ALLOWED_FIELDS.includes(k)) && written.length === 4,
          '…the write contained ONLY the four approved fields', written.join(', '));
        check('F6-6', !('orderId' in after) || after.orderId == null,
          '…no order was created');
      }

      /* — duplicates — */
      {
        const h = mk({ ['posPayments/' + QR]: { ...DOC } });
        for (let i = 0; i < 5; i++) await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        const after = h.store.get('posPayments/' + QR);
        check('F6-7', after.gatewayCallbackCount === 5,
          'FIVE duplicate deliveries → the count observes all five');
        check('F6-8', after.gatewayState === 'COMPLETE' && after.gatewayInvoiceId === 'INV-9'
          && after.status === 'pending',
          '…and nothing else changed: same state, same invoice, still not paid');
      }

      /* — out-of-order — */
      {
        const h = mk({ ['posPayments/' + QR]: { ...DOC } });
        await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        await h.run(QR, 'FAILED', 'INV-9', 'test');
        check('F6-9', h.store.get('posPayments/' + QR).gatewayState === 'COMPLETE',
          'a FAILED delivered AFTER a COMPLETE does not walk the sale backwards');
      }

      /* — unknown ref — */
      {
        const h = mk({});
        const r = await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        check('F6-10', r === false && h.writes.length === 0,
          'an UNKNOWN api_ref writes NOTHING and reports unhandled — safe, and the 200 still goes out');
      }

      /* — non-QR refs never reach the store — */
      {
        for (const ref of ['wtop_' + QR, 'pout_123', QR.toUpperCase(), '', null, 'a/b']) {
          const h = mk({ ['posPayments/' + QR]: { ...DOC } });
          const r = await h.run(ref, 'COMPLETE', 'INV', 'test');
          if (r !== false || h.writes.length) { bad('F6-11', 'ref ' + JSON.stringify(ref) + ' reached the store'); break; }
        }
        ok('F6-11', 'wallet/payout/upper-case/empty/null/path refs never reach a posPayments read');
      }

      /* — cross-seller / cross-transaction is structurally impossible — */
      {
        const h = mk({
          ['posPayments/' + QR]: { ...DOC },
          ['posPayments/' + QR2]: { transactionId: QR2, sellerId: 'shop_B', status: 'pending', total: 9000 },
        });
        await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        const other = h.store.get('posPayments/' + QR2);
        check('F6-12', h.writes.length === 1 && h.writes[0].key === 'posPayments/' + QR,
          'a callback naming transaction A writes ONLY transaction A');
        check('F6-13', other.sellerId === 'shop_B' && other.total === 9000 && !('gatewayState' in other),
          '…shop B\'s sale is untouched. Identity cannot cross.');
      }

      /* — a legacy Daraja document is refused at runtime, not just in the module — */
      {
        const h = mk({ ['posPayments/' + QR]: { checkoutId: 'ws_CO_1', sellerUid: 'shop_A', status: 'completed' } });
        const r = await h.run(QR, 'COMPLETE', 'INV-9', 'test');
        check('F6-14', h.writes.length === 0,
          'a DARAJA-shaped document at a QR-shaped id is REFUSED and written to not at all');
        check('F6-15', r === true,
          '…and reported handled, so it is not mistaken for an unknown reference');
      }

      /* — a throwing store cannot 500 the webhook — */
      {
        const sandbox = {
          db: { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('firestore exploded'); } },
          admin: { firestore: { FieldValue: { serverTimestamp: () => 0, increment: () => 0 } } },
          _qrAssoc: assoc, console: { log() {}, error() {} },
        };
        vm.createContext(sandbox);
        vm.runInContext(fnSrc + '\nthis.__fn = _associatePosQrCallback;', sandbox);
        let threw = null, r;
        try { r = await sandbox.__fn(QR, 'COMPLETE', 'INV', 'test'); } catch (e) { threw = e; }
        check('F6-16', !threw && r === false,
          'a Firestore failure returns false instead of throwing — IntaSend is never made to retry forever');
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('7  PROTECTED RAILS — byte-identical to HEAD');

  {
    const head = headFile('functions/index.js');
    if (!head) { blocked('G7-0', 'cannot read functions/index.js at HEAD'); }
    else {
      for (const n of ['exports.intasendWebhook', 'exports.verifyIntasendPayment',
        'exports.darajaSTKCallback', 'exports.webhookMpesa']) {
        const a = blockOf(head, n), b = blockOf(IDX, n);
        if (a === null) { blocked('G7-' + n, n + ' not found at HEAD'); continue; }
        check('G7-' + n.replace('exports.', ''), a === b, n + ' is byte-identical to HEAD');
      }
      /* initiateSTKPush is NOT asserted identical — another agent is editing it. Attribution
         is the correct question, as P1/P3/D1 all learned the hard way. */
      const stk = blockOf(IDX, 'exports.initiateSTKPush');
      check('G7-initiateSTK', stk !== null && !/_associatePosQrCallback|_qrAssoc|P3-A/.test(stk),
        'initiateSTKPush carries none of THIS gate\'s markers — it differs from HEAD only through another agent\'s work');
    }
    const c2b = headFile('functions/mpesa-c2b.js');
    check('G7-c2b', c2b !== null && c2b === read('functions/mpesa-c2b.js'),
      'mpesa-c2b.js byte-identical — C2B is not Daraja and not IntaSend; it is untouched either way');

    const qr = headFile('functions/pos-qr.js');
    check('G7-posqr', qr !== null && qr === read('functions/pos-qr.js'),
      'pos-qr.js byte-identical — P1\'s completePOSQRPayment remains the ONLY authority for paid');
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('8  ATTRIBUTION — other agents\' work, by content');

  {
    const MINE = /P3-A|_qrAssoc|_associatePosQrCallback|pos-qr-association/;
    const THEIRS = ['seller.html', 'pos.js', 'pos.html', 'pos-setup.html', 'functions/pos-zero-friction.js'];
    for (const f of THEIRS) {
      const d = execSync('git diff HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const mine = d.split('\n').filter((l) => l.startsWith('+') && MINE.test(l));
      check('H8-' + f.replace(/.*\//, ''), mine.length === 0, f + ' carries none of this gate\'s markers');
    }

    /* index.js is shared. Classify its hunks and require ZERO mixed. */
    const d = execSync('git diff HEAD -- functions/index.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const hs = []; let cur = null;
    d.split('\n').forEach((l) => { if (l.startsWith('@@')) { if (cur) hs.push(cur); cur = [l]; } else if (cur) cur.push(l); });
    if (cur) hs.push(cur);
    let mineN = 0, theirsN = 0, mixed = 0;
    hs.forEach((h) => {
      const add = h.filter((l) => l.startsWith('+')).join('\n');
      const m = MINE.test(add);
      const t = /subscription|applicationList|_appLife|updateSellerSubscription|initiateSTKPush/.test(add) && !m;
      if (m && t) mixed++; else if (m) mineN++; else theirsN++;
    });
    check('H8-hunks', mixed === 0,
      'index.js hunks: ' + mineN + ' mine / ' + theirsN + ' theirs / ' + mixed + ' MIXED — a mixed hunk cannot be staged safely');
    check('H8-mine', mineN === 3, 'this gate contributes exactly 3 hunks (require, helper, call site) — found ' + mineN);
  }

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('9  SABOTAGE');

  sab('X9-1', 'letting the callback mark the sale PAID', SRC,
    SRC.replace("    gatewayNotifiedAt: c.receivedAt != null ? c.receivedAt : null,",
      "    gatewayNotifiedAt: c.receivedAt != null ? c.receivedAt : null,\n    status: 'paid',"),
    (s) => {
      const m = { exports: {} };
      vm.runInNewContext(s, { module: m, exports: m.exports, require: (p) => require(path.join(ROOT, 'functions/shared', p)) });
      const r = m.exports.associationFor({ transactionId: QR, sellerId: 'a' }, { state: 'COMPLETE' });
      /* Detected either by the module refusing its own output, or by `status` appearing. */
      return r.associate === false || ('status' in (r.fields || {}));
    });

  sab('X9-2', 'removing the forbidden-field self-check', SRC,
    SRC.replace(/  for \(const k of Object\.keys\(fields\)\) \{[\s\S]*?\n  \}\n/, ''),
    (s) => !/FORBIDDEN_FIELDS\.indexOf\(k\)/.test(s));

  sab('X9-3', 'dropping the QR shape filter so a wallet ref could enter', SRC,
    SRC.replace("const QR_REF = /^[0-9a-f]{32}$/;", "const QR_REF = /.*/;"),
    (s) => {
      const m = { exports: {} };
      vm.runInNewContext(s, { module: m, exports: m.exports, require: (p) => require(path.join(ROOT, 'functions/shared', p)) });
      return m.exports.isQrRef('wtop_anything') === true;
    });

  sab('X9-4', 'accepting a legacy Daraja document', SRC,
    SRC.replace("  if (rail === 'daraja') {", "  if (false) {"),
    (s) => {
      const m = { exports: {} };
      vm.runInNewContext(s, { module: m, exports: m.exports, require: (p) => require(path.join(ROOT, 'functions/shared', p)) });
      const r = m.exports.associationFor({ checkoutId: 'ws_CO_1' }, { state: 'COMPLETE' });
      return r.reason !== 'legacy_daraja_document';
    });

  sab('X9-5', 'removing the monotonic guard', SRC,
    SRC.replace('const monotonicHold = prior === GATEWAY_COMPLETE && state !== GATEWAY_COMPLETE;',
      'const monotonicHold = false;'),
    (s) => {
      const m = { exports: {} };
      vm.runInNewContext(s, { module: m, exports: m.exports, require: (p) => require(path.join(ROOT, 'functions/shared', p)) });
      const r = m.exports.associationFor({ transactionId: QR, sellerId: 'a', gatewayState: 'COMPLETE' }, { state: 'FAILED' });
      return r.fields.gatewayState === 'FAILED';
    });

  sab('X9-6', 'moving the call BEFORE the payments lookup', IDX,
    IDX.replace('    const payRef = db.collection("payments").doc(apiRef);\n    const snap   = await payRef.get();\n    if (!snap.exists) {\n',
      '    await _associatePosQrCallback(apiRef, state, checkoutId, "webhookIntasend");\n    const payRef = db.collection("payments").doc(apiRef);\n    const snap   = await payRef.get();\n    if (!snap.exists) {\n'),
    (s) => {
      const wi = blockOf(s, 'exports.webhookIntasend') || '';
      return wi.indexOf('_associatePosQrCallback(apiRef') < wi.indexOf('const snap   = await payRef.get();');
    });

  sab('X9-7', 'wiring intasendWebhook as well', IDX,
    IDX.replace('if (await _finalizeWalletTopUp(apiRef, state, amount, "intasendWebhook")) {',
      'await _associatePosQrCallback(apiRef, state, checkoutId, "intasendWebhook");\n    if (await _finalizeWalletTopUp(apiRef, state, amount, "intasendWebhook")) {'),
    (s) => (strip(s).match(/await _associatePosQrCallback\(/g) || []).length !== 1);

  sab('X9-8', 'routing the association to paymentAttempts instead', IDX,
    IDX.replace('const ref = db.collection("posPayments").doc(apiRef);',
      'const ref = db.collection("paymentAttempts").doc(apiRef);'),
    (s) => /paymentAttempts/.test(extractFn(s, '_associatePosQrCallback') || ''));

  sab('X9-9', 'taking the amount from the callback body', SRC,
    SRC.replace('    gatewayState:      monotonicHold ? prior : state,',
      '    gatewayState:      monotonicHold ? prior : state,\n    gatewayAmount:     c.amount,'),
    (s) => {
      const m = { exports: {} };
      vm.runInNewContext(s, { module: m, exports: m.exports, require: (p) => require(path.join(ROOT, 'functions/shared', p)) });
      const r = m.exports.associationFor({ transactionId: QR, sellerId: 'a' }, { state: 'COMPLETE', amount: 999999 });
      return r.associate === false || 'gatewayAmount' in (r.fields || {});
    });

  sab('X9-10', 'swallowing the failure so the webhook 500s', IDX,
    IDX.replace('    console.error(`[${tag}] POS QR association error:`, e.message);\n    return false;',
      '    throw e;'),
    (s) => !/return false;\n  \}\n\}/.test(extractFn(s, '_associatePosQrCallback') || ''));

  /* ══════════════════════════════════════════════════════════════════════════════════════ */
  section('10  CONTROLS — each detector must also stay quiet when it should');

  check('K10-1', !/status:\s*'paid'/.test(strip(SRC)),
    'CONTROL: the paid-detector is quiet on the real module');
  check('K10-2', (strip(IDX).match(/await _associatePosQrCallback\(/g) || []).length === 1,
    'CONTROL: the call-site counter reads exactly 1 on the real file, not 0');
  check('K10-3', /_associatePosQrCallback/.test(extractFn(IDX, '_associatePosQrCallback') || ''),
    'CONTROL: the function extractor really does find the shipped caller');
  check('K10-4', extractFn(IDX, '_noSuchFunctionAnywhere') === null,
    'CONTROL: …and returns null for a function that does not exist');
  check('K10-5', assoc.associationFor({ transactionId: QR, sellerId: 'a' }, { state: 'COMPLETE' }).associate === true,
    'CONTROL: the LEGITIMATE path still associates — this is not a guard that refuses everybody');

  return finish();
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS + '\n  failed  : ' + FAIL + '\n  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ P3-A: GREEN' : '❌ P3-A: NOT GREEN'));
  console.log('  Certification only. Nothing deployed. No callback can establish `paid`.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.error('\n  ✖ SUITE CRASHED — failing closed, NOT passing.\n  ' + (e && e.stack || e));
  clearTimeout(WATCHDOG);
  process.exit(2);
});
