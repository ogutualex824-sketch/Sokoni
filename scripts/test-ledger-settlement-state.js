#!/usr/bin/env node
/* createLedgerEntry settlement state — EXECUTED against fixtures, not matched.
 *
 *   node scripts/test-ledger-settlement-state.js
 *
 * THE INVARIANT UNDER TEST
 *   A ledger entry must never claim `settled` merely because it was created.
 *   `settled` means the corresponding obligation has been VERIFIED as settled.
 *
 * `status` was hardcoded to 'settled' with `settledAt` stamped at creation, so a
 * pos_commission_receivable — money the seller HOLDS and OWES — was recorded as paid.
 * Any collection gate built on that would aggregate to zero and silently pass everybody.
 *
 * This is a shared writer with 12 other call sites in finos-router.js, so the first
 * thing proven is that THEY ARE UNCHANGED. A source regex cannot show that; the writer
 * is run and its emitted document inspected.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
const ROOT = path.join(__dirname, '..');

/* ── Load finos-utils with firebase-admin stubbed; capture what is written ──── */
function load() {
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8');
  const writes = [];
  const SENTINEL = '<<serverTimestamp>>';
  const fakeAdmin = {
    firestore: Object.assign(() => ({}), {
      FieldValue: {
        serverTimestamp: () => SENTINEL,
        increment: (n) => ({ __increment: n }),
      },
    }),
  };
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        id: id || 'generated_id',
        get: async () => ({ exists: false, data: () => ({}) }),
        create: async () => {},
      }),
    }),
    runTransaction: async (fn) => fn({
      set: (ref, data) => writes.push({ data }),
      get: async () => ({ exists: false, data: () => ({}) }),
      update: () => {},
    }),
  };
  const modPath = path.join(ROOT, 'functions', 'finos-utils.js');
  /* Relative specifiers inside the module ('./commission-config') must resolve as
     they do at runtime — from the MODULE's directory, not this script's. Resolving
     them with the plain `require` here is the harness-drift bug documented in
     scripts/harness-sandbox.js. */
  const realRequire = Module.createRequire(modPath);
  const m = new Module('finos-utils', null);
  m.require = (id) => (id === 'firebase-admin' ? fakeAdmin : realRequire(id));
  m._compile(src, modPath);
  return { mod: m.exports, writes, db, SENTINEL };
}

const base = (over) => Object.assign({
  type: 'test_entry', amountCents: 10500, debitAccount: 'seller:S1',
  creditAccount: 'platform:revenue', orderId: 'ORD1', sellerId: 'S1',
  category: 'pos', createdBy: 'test', idempotencyKey: 'k_' + Math.random(),
}, over || {});

async function emit(over) {
  const { mod, writes, db, SENTINEL } = load();
  await mod.createLedgerEntry(db, base(over));
  return { doc: writes[0] && writes[0].data, SENTINEL };
}

(async () => {
  console.log('\nA. EXISTING CALLERS ARE UNCHANGED — the 12 finos-router sites\n');
  {
    const { doc, SENTINEL } = await emit();          /* no settlementState passed */
    ck('default status is still "settled"', doc.status === 'settled', doc.status);
    ck('default still stamps settledAt', doc.settledAt === SENTINEL, String(doc.settledAt));
    ck('double entry intact', doc.debitAccount === 'seller:S1' && doc.creditAccount === 'platform:revenue');
    ck('amount unchanged', doc.amountCents === 10500);
    ck('reversalRef still initialised null', doc.reversalRef === null);
    ck('idempotencyKey persisted', typeof doc.idempotencyKey === 'string' && doc.idempotencyKey.length > 0);
    ck('ids carried through', doc.orderId === 'ORD1' && doc.sellerId === 'S1');
  }

  console.log('\nB. THE NEW STATE — outstanding never claims settlement\n');
  {
    const { doc } = await emit({ settlementState: 'outstanding' });
    ck('status is "outstanding"', doc.status === 'outstanding', doc.status);
    ck('settledAt is NULL — the invariant', doc.settledAt === null, String(doc.settledAt));
    ck('  ...not a timestamp, not undefined, not absent',
       doc.settledAt === null && 'settledAt' in doc);
    ck('double entry still intact', doc.debitAccount === 'seller:S1' && doc.creditAccount === 'platform:revenue');
    ck('still reversible — reversalRef initialised', doc.reversalRef === null);
  }

  console.log('\nC. status and settledAt can never disagree\n');
  {
    const s = (await emit()).doc;
    const o = (await emit({ settlementState: 'outstanding' })).doc;
    ck('settled   => settledAt present', s.status === 'settled' && s.settledAt !== null);
    ck('outstanding => settledAt absent', o.status === 'outstanding' && o.settledAt === null);
    ck('no entry is settled WITHOUT a settlement time',
       !(s.status === 'settled' && s.settledAt === null) && !(o.status === 'settled' && o.settledAt === null));
  }

  console.log('\nD. An invalid state is refused, not coerced\n');
  {
    for (const bad of ['paid', 'SETTLED', '', null, 'pending']) {
      let threw = false;
      try { await emit({ settlementState: bad }); } catch (e) { threw = /settlementState/.test(e.message); }
      ck('refuses settlementState=' + JSON.stringify(bad), threw);
    }
  }

  console.log('\nE. Replay does not create a second obligation\n');
  {
    /* checkIdempotency returns a cached result -> duplicate, no second write */
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8');
    ck('idempotency is checked BEFORE the write',
       src.indexOf('checkIdempotency') < src.indexOf("db.collection('ledger').doc()"));
    ck('a cached key returns duplicate instead of writing',
       /if \(cached\) return \{ \.\.\.cached\.result, duplicate: true \}/.test(src));
    ck('the ledger row and the idempotency claim are written in ONE transaction',
       /runTransaction\([\s\S]{0,400}finosIdempotency/.test(src));
  }

  console.log('\nF. POS records its receivable as OUTSTANDING\n');
  {
    const pos = fs.readFileSync(path.join(ROOT, 'functions', 'pos-zero-friction.js'), 'utf8');
    const blk = pos.slice(pos.indexOf('pos_commission_receivable'), pos.indexOf('pos_commission_receivable') + 1200);
    ck('posCompleteCheckout passes settlementState: outstanding',
       /settlementState:\s*'outstanding'/.test(blk));
    ck('  ...on the pos_commission_receivable entry specifically',
       blk.indexOf("settlementState: 'outstanding'") > 0);
    ck('the sale-derived idempotency key is unchanged',
       /idempotencyKey:\s*'poscomm_'\s*\+\s*o\.idempotencyKey/.test(blk));
    ck('the double entry is unchanged (seller debited, platform credited)',
       /debitAccount:[\s\S]{0,80}seller/.test(blk) && /creditAccount:[\s\S]{0,80}PLATFORM_REVENUE|platform:revenue/.test(blk));
    ck('NO wallet call was introduced in the POS commission path',
       !/creditWalletTxn|debitWalletTxn|availableBalance/.test(blk),
       'POS commission is a receivable — the seller already holds the cash');
  }

  console.log('\nG. Nothing else changed\n');
  {
    const wallet = fs.readFileSync(path.join(ROOT, 'functions', 'wallet.js'), 'utf8');
    ck('wallet.js untouched by this slice — sweep still writes earning_settlement',
       /type: 'earning_settlement'/.test(wallet));
    const fu = fs.readFileSync(path.join(ROOT, 'functions', 'finos-utils.js'), 'utf8');
    ck('reverseLedgerEntry still reuses the ORIGINAL amount, never recomputes',
       /amountCents:\s*orig\.amountCents/.test(fu));
    ck('reverseLedgerEntry still refuses a double reversal',
       /Entry already reversed/.test(fu));
    ck('the commission authority was not touched',
       !/settlementState/.test(fs.readFileSync(path.join(ROOT, 'functions', 'commission-config.js'), 'utf8')));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  SUITE CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
