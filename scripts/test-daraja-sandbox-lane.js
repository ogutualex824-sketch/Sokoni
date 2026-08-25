#!/usr/bin/env node
/* Daraja sandbox callback lane — the production gate must not have moved.
 *
 * darajaSTKCallback rejects any caller outside Safaricom's published IP list.
 * Safaricom's SANDBOX posts from other infrastructure, so a sandbox STK result
 * could never settle its own posPayments row. This suite proves the lane that
 * fixes that is narrow, and — more importantly — that it does not exist at all
 * in the production configuration.
 *
 * THE ASSERTION THAT MATTERS
 * `posPayments.env` is copied from shopSettings/{sellerUid}.darajaEnv, and
 * firestore.rules lets a seller write their OWN shopSettings. So env==="sandbox"
 * is a SELLER-FORGEABLE claim. A test that only checked "does a sandbox callback
 * get through" would pass against a version that trusts that claim alone — which
 * would let any merchant make their live payments forge-completable. The suite
 * therefore asserts the CONVERSE: a forged sandbox row from a seller who is not
 * on the deploy-time allowlist is REJECTED.
 *
 * The gate is extracted from functions/index.js at run time rather than copied,
 * so the test and the shipped code cannot drift apart silently.
 *
 *   node scripts/test-daraja-sandbox-lane.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');

/* ── Extract the gate. Anchored on CODE, not prose: a comment can be reworded
      by any refactor that passes through the neighbourhood, and an anchor that
      moves turns into a spurious "could not locate" failure that blocks
      unrelated work. ─────────────────────────────────────────────────────── */
const START = '      const callerIp = (req.headers["x-forwarded-for"]';
const END   = '      const _isSandbox = payData.env === "sandbox" || payData.isTest === true;';
const s = SRC.indexOf(START), e = SRC.indexOf(END, s);
if (s < 0 || e < 0) {
  console.log('  FAIL  could not locate the callback gate in functions/index.js');
  process.exit(1);
}
const GATE = SRC.slice(s, e + END.length);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* The gate ends in `return` statements; wrap it so a return means "rejected"
   and falling through means "admitted". */
const runGate = new AsyncFunction(
  'req', 'db', 'admin', 'process', 'SAFARICOM_CALLBACK_IPS', '_DARAJA_SANDBOX_SELLER_UIDS', 'console',
  '"use strict";' + GATE + '; return { admitted: true, isSandbox: _isSandbox, checkoutId, payData };'
);

const PROD_IP    = '196.201.214.200';   // on Safaricom's published list
const UNKNOWN_IP = '203.0.113.77';      // sandbox / anything else

/* ── Harness ──────────────────────────────────────────────────────────────── */
function makeEnv({ rows, sandboxUids, nodeEnv }) {
  const reads = [];   // every posPayments document read
  const audits = [];  // every auditLogs write
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        get: async () => { reads.push(id); return { exists: !!rows[id], data: () => rows[id] }; },
      }),
      add: async (d) => { if (c === 'auditLogs') audits.push(d); return { id: 'a' }; },
    }),
  };
  return {
    db, reads, audits,
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
    proc:  { env: { NODE_ENV: nodeEnv || 'production' } },
    uids:  new Set(sandboxUids || []),
    quiet: { warn: () => {}, log: () => {}, error: () => {} },
  };
}

async function call({ ip, checkoutId, rows, sandboxUids, nodeEnv }) {
  const env = makeEnv({ rows: rows || {}, sandboxUids, nodeEnv });
  const req = {
    headers: { 'x-forwarded-for': ip },
    ip,
    body: { Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'ok' } } },
  };
  let out;
  try {
    out = await runGate(req, env.db, env.admin, env.proc, new Set([PROD_IP]), env.uids, env.quiet);
  } catch (err) {
    return { threw: err, env };
  }
  return { result: out || { admitted: false }, env };
}

const LIVE_ROW    = { env: 'production', sellerUid: 'SELLER_LIVE',  status: 'pending', amount: 5000 };
const SANDBOX_ROW = { env: 'sandbox',    sellerUid: 'SELLER_SBX',   status: 'pending', amount: 1, isTest: true };
/* A live seller who wrote darajaEnv:"sandbox" into their own shopSettings. */
const FORGED_ROW  = { env: 'sandbox',    sellerUid: 'SELLER_EVIL',  status: 'pending', amount: 90000 };

(async () => {

console.log('\nA. Production configuration — allowlist EMPTY (this is how it ships)\n');
{
  const { result, env } = await call({ ip: PROD_IP, checkoutId: 'CK1', rows: { CK1: LIVE_ROW } });
  ck('Safaricom IP is admitted', result.admitted === true);
  ck('  ...and the row is not flagged sandbox', result.admitted && result.isSandbox === false);
  ck('  ...and no rejection was audited', env.audits.length === 0);
}
{
  const { result, env } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK1', rows: { CK1: LIVE_ROW } });
  ck('unknown IP is REJECTED', result.admitted !== true);
  ck('  ...and audits stk_callback_ip_rejected', env.audits.length === 1 && env.audits[0].type === 'stk_callback_ip_rejected');
  ck('  ...and reads NO document (no unauthenticated read amplifier)', env.reads.length === 0,
     env.reads.length + ' reads');
}
{
  /* The whole point of the empty default: a forged sandbox row cannot be
     settled, because with no allowlist the lane is never even consulted. */
  const { result, env } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK2', rows: { CK2: FORGED_ROW } });
  ck('forged sandbox row is REJECTED when allowlist empty', result.admitted !== true);
  ck('  ...and still reads no document', env.reads.length === 0);
}

console.log('\nB. Sandbox run — exactly one seller enrolled\n');
const ENROLLED = { sandboxUids: ['SELLER_SBX'] };
{
  const { result } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK3', rows: { CK3: SANDBOX_ROW }, ...ENROLLED });
  ck('enrolled seller + env sandbox is ADMITTED', result.admitted === true);
  ck('  ...and is flagged sandbox for the ledger guards', result.admitted && result.isSandbox === true);
}
{
  const { result, env } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK4', rows: { CK4: FORGED_ROW }, ...ENROLLED });
  ck('FORGED sandbox row from a NON-enrolled seller is REJECTED', result.admitted !== true);
  ck('  ...and audits the rejection with the checkoutId', env.audits.length === 1
     && env.audits[0].type === 'stk_callback_ip_rejected' && env.audits[0].checkoutId === 'CK4');
}
{
  const { result } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK5', rows: { CK5: LIVE_ROW }, ...ENROLLED });
  ck('production row is REJECTED from an untrusted IP even during a sandbox run', result.admitted !== true);
}
{
  /* Enrolled seller, but the row is a real production payment. Both conditions
     are required — neither alone opens the lane. */
  const row = { env: 'production', sellerUid: 'SELLER_SBX', status: 'pending', amount: 40000 };
  const { result } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK6', rows: { CK6: row }, ...ENROLLED });
  ck('enrolled seller with a PRODUCTION row is REJECTED', result.admitted !== true);
}
{
  const { result, env } = await call({ ip: PROD_IP, checkoutId: 'CK7', rows: { CK7: LIVE_ROW }, ...ENROLLED });
  ck('Safaricom IP still admitted during a sandbox run', result.admitted === true);
  ck('  ...with no sandbox audit written', env.audits.filter(a => a.type === 'stk_callback_sandbox_accepted').length === 0);
}
{
  const { env } = await call({ ip: UNKNOWN_IP, checkoutId: 'CK3', rows: { CK3: SANDBOX_ROW }, ...ENROLLED });
  ck('admitted sandbox callback IS audited as stk_callback_sandbox_accepted',
     env.audits.length === 1 && env.audits[0].type === 'stk_callback_sandbox_accepted'
     && env.audits[0].sellerUid === 'SELLER_SBX');
}

console.log('\nC. Untrusted input reaching .doc() once the lane is open\n');
for (const [label, id] of [['path traversal', 'a/b/c'], ['empty id', ''], ['over-long id', 'x'.repeat(400)]]) {
  const { result, env } = await call({ ip: UNKNOWN_IP, checkoutId: id, rows: {}, ...ENROLLED });
  ck(label + ' is refused before .doc()', result.admitted !== true && env.reads.length === 0);
}
{
  const { result } = await call({ ip: UNKNOWN_IP, checkoutId: 'NOSUCH', rows: {}, ...ENROLLED });
  ck('unknown checkoutId is refused', result.admitted !== true);
}

console.log('\nD. Ledger containment — sandbox money must not become real money\n');
{
  /* Assert against the SHIPPED source, not a copy: these two lines are the
     entire containment, and a refactor that drops either silently reinstates
     fabricated commission and tax records. */
  const carriesFlag = /isTest:\s+_isSandbox,/.test(SRC);
  ck('sellerPayments record carries isTest (arms the onSellerPaymentCreated guard)', carriesFlag);

  const guardsEngine = /if \(resultCode === 0 && !_isSandbox\) \{[\s\S]{0,200}?financial-engine/.test(SRC);
  ck('financial-engine is skipped for sandbox payments', guardsEngine);

  const guardExists = /if \(!data \|\| data\.isTest\) return;/.test(SRC);
  ck('onSellerPaymentCreated still bails on isTest (the guard being armed)', guardExists);
}
{
  /* Negative control: prove the two assertions above can actually fail. If a
     detector cannot fail, it is not evidence. */
  const broken = SRC.replace('isTest:      _isSandbox,', 'createdAt2: null,')
                    .replace('if (resultCode === 0 && !_isSandbox) {', 'if (resultCode === 0) {');
  ck('negative control: detectors FAIL against un-contained source',
     !/isTest:\s+_isSandbox,/.test(broken)
     && !/if \(resultCode === 0 && !_isSandbox\) \{[\s\S]{0,200}?financial-engine/.test(broken));
}

console.log('\nE. Blast radius — what this change did NOT touch\n');
{
  ck('production Safaricom IP list unchanged (8 entries, same values)',
     /"196\.201\.214\.200","196\.201\.214\.206","196\.201\.213\.100","196\.201\.214\.207",\s*"196\.201\.214\.208","196\.201\.213\.109","196\.201\.213\.115","196\.201\.214\.202",/.test(SRC));
  ck('still exactly one STK callback endpoint',
     (SRC.match(/exports\.darajaSTKCallback\s*=/g) || []).length === 1);
  ck('PartyB still the seller shortcode (direct-to-seller untouched)',
     /PartyB:\s+darajaShortCode,/.test(SRC));
  ck('CENTRAL_MOR still refuses without central credentials',
     /Central collection \(CENTRAL_MOR\) is enabled but central Daraja credentials are not provisioned/.test(SRC));
  ck('sandbox lane defaults to empty (no UID baked into source)',
     /process\.env\.DARAJA_SANDBOX_SELLER_UIDS \|\| ""/.test(SRC));
  const envFile = fs.readFileSync(path.join(__dirname, '..', 'functions', '.env'), 'utf8');
  ck('functions/.env ships the lane EMPTY', /^DARAJA_SANDBOX_SELLER_UIDS=\s*$/m.test(envFile));
  ck('no Daraja secret committed to functions/.env',
     !/DARAJA_SANDBOX_(CONSUMER_KEY|CONSUMER_SECRET|PASSKEY)=.+/.test(envFile));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

})();
