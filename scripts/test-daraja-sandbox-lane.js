#!/usr/bin/env node
/* The sandbox callback lane — narrow, inert by default, and not seller-forgeable.
 *
 * WHY THIS LANE IS DANGEROUS IF DONE NAIVELY
 * `posPayments.env` is copied from shopSettings/{sellerUid}.darajaEnv, and
 * firestore.rules lets a seller write their OWN shopSettings. So `env ===
 * "sandbox"` is a SELLER-FORGEABLE claim. A lane that trusted it alone would let
 * any merchant mark their live payments sandbox and make them completable by
 * anyone who learns the CheckoutRequestID. The lane therefore requires TWO
 * conditions: the row says sandbox AND the seller is on a deploy-time allowlist
 * that no seller can write.
 *
 * A suite that only asked "does a sandbox callback get through?" would pass
 * against the naive version. Section C asserts the CONVERSE — a forged sandbox
 * row from a seller who is NOT enrolled is rejected.
 *
 * The handler is extracted from functions/index.js and EXECUTED in this realm,
 * so the test and the shipped code cannot drift apart.
 *
 *   firebase emulators:exec --only firestore --project sokoni-sbx-lane \
 *     "node scripts/test-daraja-sandbox-lane.js"
 */
'use strict';
const fs = require('fs');
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('\n  REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is unset.\n');
  process.exit(1);
}

const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-sbx-lane' });
const db = admin.firestore();

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const L = SRC.split('\n');
const sIdx = L.findIndex((l) => l.startsWith('exports.darajaSTKCallback = onRequest('));
const hStart = L.findIndex((l, i) => i > sIdx && l.trim() === 'async (req, res) => {');
const hEnd = L.findIndex((l, i) => i > hStart && l === ');');
if (sIdx < 0 || hStart < 0 || hEnd < 0) { console.error('  handler bounds not found'); process.exit(1); }
const handlerSrc = L.slice(hStart, hEnd).join('\n');

const ipsSrc = SRC.slice(SRC.indexOf('const SAFARICOM_CALLBACK_IPS'));
const IPS = new Function('return ' + ipsSrc.slice(ipsSrc.indexOf('=') + 1, ipsSrc.indexOf(']);') + 2))();

const finCalls = [];
const stubRequire = (id) => {
  if (id === './payment-timeline') return { mark: () => {} };
  if (id === './financial-engine') return { recordConfirmedPayment: async (a) => { finCalls.push(a); } };
  throw new Error('unexpected require: ' + id);
};

/* Same realm — vm.createContext would give async transaction callbacks a
   different intrinsic %Promise% and firebase-admin would reject them. */
/* Instrumentation. Two properties of this handler are invisible in its output:
   whether it READ Firestore before rejecting, and whether it swallowed a throw.
   Both were missed by the first version of this gate, and a sabotage run caught
   the miss. Counting reads and capturing console.error makes them observable. */
const io = { docReads: 0, errors: [] };
const countingDb = {
  collection: (name) => {
    const c = db.collection(name);
    return {
      doc: (id) => {
        const d = c.doc(id);
        return {
          get: (...a) => { io.docReads++; return d.get(...a); },
          set: (...a) => d.set(...a),
          update: (...a) => d.update(...a),
          delete: (...a) => d.delete(...a),
          get id() { return d.id; },
          get path() { return d.path; },
          __raw: d,
        };
      },
      add: (...a) => c.add(...a),
      where: (...a) => c.where(...a),
      get: (...a) => c.get(...a),
    };
  },
  runTransaction: (fn, opts) => db.runTransaction((txn) => fn({
    get: (r) => { io.docReads++; return txn.get(r && r.__raw ? r.__raw : r); },
    set: (r, v, o) => txn.set(r && r.__raw ? r.__raw : r, v, o),
    update: (r, v) => txn.update(r && r.__raw ? r.__raw : r, v),
  }), opts),
};
const capturingConsole = {
  log: (...a) => console.log.apply(console, a),
  warn: (...a) => console.warn.apply(console, a),
  error: (...a) => { io.errors.push(a.join(" ")); console.error.apply(console, a); },
};

const build = (allowUids) => new Function(
  'db', 'admin', 'console', 'require', 'process', 'SAFARICOM_CALLBACK_IPS', '_DARAJA_SANDBOX_SELLER_UIDS',
  'return ' + handlerSrc + ';'
)(countingDb, admin, capturingConsole, stubRequire, { env: { NODE_ENV: 'production' } }, IPS, new Set(allowUids));

const SAF_IP = '196.201.214.200';
const ANY_IP = '203.0.113.7';
const SELLER_OK = 'sandbox-seller-1';
const SELLER_NO = 'sandbox-seller-2';

const fire = async (h, ip, body) => {
  const res = { status: () => ({ json: () => {} }) };
  await h({ headers: { 'x-forwarded-for': ip }, ip, body }, res);
};
const cb = (id, code, amount, receipt) => ({
  Body: { stkCallback: {
    CheckoutRequestID: id, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'cancelled',
    CallbackMetadata: code === 0 ? { Item: [
      { Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt },
      { Name: 'PhoneNumber', Value: 254712345678 },
    ] } : undefined,
  } },
});
const seed = async (id, over) => {
  await db.collection('posPayments').doc(id).set(Object.assign({
    status: 'pending', sellerUid: SELLER_OK, callerUid: 'buyer-1', amount: 1,
    phone: '254712345678', orderId: null, hub: 'marketplace', env: 'sandbox',
  }, over || {}));
};
const get = async (c, d) => { const s = await db.collection(c).doc(d).get(); return s.exists ? s.data() : null; };
const auditCount = async (type) => (await db.collection('auditLogs').where('type', '==', type).get()).size;

(async () => {

  /* ══ A. Inert by default ══════════════════════════════════════════════ */
  console.log('\nA. With no allowlist the lane does not exist\n');
  {
    const H = build([]);                     /* production configuration */
    await seed('SB_A');
    await fire(H, ANY_IP, cb('SB_A', 0, 1, 'R_A'));
    await new Promise((r) => setTimeout(r, 400));
    const p = await get('posPayments', 'SB_A');
    ck('an untrusted IP settles nothing', p.status === 'pending', p.status);
    ck('  ...even though the row IS sandbox', p.env === 'sandbox');
    ck('  ...and the rejection is audited', (await auditCount('stk_callback_ip_rejected')) >= 1);
    ck('  ...no sandbox acceptance was logged', (await auditCount('stk_callback_sandbox_accepted')) === 0);
    /* The whole point of the early branch: with no lane configured, a public
       endpoint must not be usable to force a Firestore read per request. */
    ck('  ...and Firestore was NOT read at all (no read amplifier)',
       io.docReads === 0, io.docReads + " document reads");

    /* Control: the counter can see a read, so 0 above is a measurement not a bug. */
    const readsBefore = io.docReads;
    await fire(build([SELLER_OK]), ANY_IP, cb('SB_A', 0, 1, 'R_A'));
    ck('  ↳ control: the read counter does register reads', io.docReads > readsBefore,
       (io.docReads - readsBefore) + " reads");
  }

  /* ══ B. Enrolled sandbox seller ═══════════════════════════════════════ */
  console.log('\nB. An enrolled sandbox seller can be settled from any IP\n');
  {
    const H = build([SELLER_OK]);
    await seed('SB_B');
    await fire(H, ANY_IP, cb('SB_B', 0, 1, 'R_B'));
    const p = await get('posPayments', 'SB_B');
    ck('the sandbox callback settles the row', p.status === 'completed', p.status);
    ck('  ...and the acceptance is audited', (await auditCount('stk_callback_sandbox_accepted')) >= 1);
  }

  /* ══ C. THE CONVERSE — a forged sandbox claim ═════════════════════════ */
  console.log('\nC. env alone is not enough — it is seller-forgeable\n');
  {
    const H = build([SELLER_OK]);
    await seed('SB_C', { sellerUid: SELLER_NO });   /* says sandbox, NOT enrolled */
    const before = await auditCount('stk_callback_ip_rejected');
    await fire(H, ANY_IP, cb('SB_C', 0, 1, 'R_C'));
    await new Promise((r) => setTimeout(r, 400));
    const p = await get('posPayments', 'SB_C');
    ck('a NON-enrolled seller cannot be settled, even claiming sandbox',
       p.status === 'pending', p.status);
    ck('  ...and it is rejected on the original terms', (await auditCount('stk_callback_ip_rejected')) > before);

    /* And the mirror: enrolled seller, but the row is NOT sandbox. */
    await seed('SB_C2', { env: 'production' });
    await fire(H, ANY_IP, cb('SB_C2', 0, 1, 'R_C2'));
    await new Promise((r) => setTimeout(r, 400));
    ck('an enrolled seller cannot settle a PRODUCTION row from an untrusted IP',
       (await get('posPayments', 'SB_C2')).status === 'pending');
  }

  /* ══ D. Document-id safety ════════════════════════════════════════════ */
  console.log('\nD. A caller-supplied id cannot address another path\n');
  {
    const H = build([SELLER_OK]);
    /* A row the traversal would reach if "/" were honoured. */
    await db.collection('posPayments').doc('SB_D').set({ status: 'pending', env: 'sandbox', sellerUid: SELLER_OK, amount: 1 });

    const auditBefore = (await db.collection('auditLogs').get()).size;
    for (const badId of ['SB_D/child', '', 'x'.repeat(250), 'a/b/c']) {
      let threw = null;
      try { await fire(H, SAF_IP, cb(badId, 0, 1, 'R_D')); } catch (e) { threw = e.message; }
      ck('id ' + JSON.stringify(badId.slice(0, 14)) + ' is refused without throwing', threw === null, threw || 'clean');
    }

    /* The real assertion: nothing happened. A processed id would have settled a
       row, written an audit entry, or thrown — none of which occurred. */
    ck('  ...and the row a traversal would reach is untouched',
       (await get('posPayments', 'SB_D')).status === 'pending');
    ck('  ...and no audit entry was produced by the malformed ids',
       (await db.collection('auditLogs').get()).size === auditBefore,
       ((await db.collection('auditLogs').get()).size - auditBefore) + ' new');

    /* Negative control: the SAME call shape with a VALID id does settle, so the
       'nothing happened' assertions above are not vacuously true. */
    await seed('SB_D_OK');
    await fire(H, SAF_IP, cb('SB_D_OK', 0, 1, 'R_DOK'));
    ck('  ↳ control: a VALID id through the same path DOES settle',
       (await get('posPayments', 'SB_D_OK')).status === 'completed');

    /* The handler wraps everything in try/catch, so an invalid document path
       throws and is SWALLOWED — absence-of-effect looks identical with or
       without the guard. Watching console.error is what tells them apart. */
    ck('  ...and no error was thrown-and-swallowed for the malformed ids',
       io.errors.filter((e) => /darajaSTKCallback\] Error/.test(e)).length === 0,
       io.errors.filter((e) => /darajaSTKCallback\] Error/.test(e)).join(" | ") || "none");
  }
  /* ══ E. Sandbox money is not money ════════════════════════════════════ */
  console.log('\nE. A sandbox payment must not reach the ledger\n');
  {
    const H = build([SELLER_OK]);
    const before = finCalls.length;
    await seed('SB_E');
    await fire(H, ANY_IP, cb('SB_E', 0, 1, 'R_E'));
    ck('posPayments is settled', (await get('posPayments', 'SB_E')).status === 'completed');
    ck('the financial engine is NOT called', finCalls.length === before,
       (finCalls.length - before) + ' calls');
    const sp = await get('sellerPayments', 'SB_E');
    ck('the seller credit is stamped isTest', !!sp && sp.isTest === true, sp && String(sp.isTest));
    ck('  ...which is what arms the onSellerPaymentCreated guard',
       /if \(!data \|\| data\.isTest\) return;/.test(SRC));
  }

  /* ══ F. Production behaviour is unchanged ═════════════════════════════ */
  console.log('\nF. The Safaricom path still works, and still books money\n');
  {
    const H = build([SELLER_OK]);
    const before = finCalls.length;
    await seed('SB_F', { env: 'production', sellerUid: 'real-seller' });
    await fire(H, SAF_IP, cb('SB_F', 0, 1, 'R_F'));
    ck('a trusted Safaricom IP settles a production row',
       (await get('posPayments', 'SB_F')).status === 'completed');
    ck('  ...and the ledger IS written for real money', finCalls.length > before,
       (finCalls.length - before) + ' calls');
    const sp = await get('sellerPayments', 'SB_F');
    ck('  ...and the credit is NOT marked isTest', !!sp && sp.isTest !== true, sp && String(sp.isTest));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  HARNESS CRASHED: ' + ((e && e.stack) || e) + '\n'); process.exit(1); });
