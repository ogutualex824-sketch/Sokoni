#!/usr/bin/env node
/* Business wallet — separate from personal, structurally.
 *
 *   node scripts/test-business-wallet.js
 *
 * `commission-settlement-authority.assertBusinessWallet()` refuses to settle a merchant
 * liability from anything but a BUSINESS wallet, because "a buyer's personal wallet paying
 * a shop's commission would be taking a stranger's money for someone else's debt". It was
 * guarding a concept that did not exist: nothing in production carried kind:'BUSINESS'.
 *
 * This suite proves the concept now exists AND that the two wallets cannot be confused:
 * different collection, different key space, different unit named in the field. It also
 * proves the guarantees that make a float safe to hold — every movement ledgered, idempotent
 * on its reference, and never negative.
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const MA = require(path.join(FN, 'money-authority.js'));
const S  = require(path.join(FN, 'commission-settlement-authority.js'));
const BW = require(path.join(FN, 'business-wallet.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* In-memory Firestore with a real transaction that serialises reads before writes. */
function makeDb(opts = {}) {
  const docs = new Map();
  const coll = (name) => ({
    doc(id) {
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() {
          if (opts.failReads) throw new Error('simulated outage');
          const d = docs.get(key);
          return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async set(v) { docs.set(key, Object.assign({}, v)); },
      };
    },
  });
  return {
    _docs: docs,
    collection: coll,
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, v) { writes.push([ref._key, v, false]); },
        update(ref, v) { writes.push([ref._key, v, true]); },
      };
      const out = await fn(tx);
      for (const [key, v, merge] of writes) {
        docs.set(key, merge ? Object.assign({}, docs.get(key) || {}, v) : Object.assign({}, v));
      }
      return out;
    },
  };
}

const SHOP = 'SHOP_B_shop_91c';      /* deliberately NOT equal to the owner uid */
const OWNER = 'OWNER_A_uid_7f3';
const OTHER = 'OTHER_uid_222';

(async () => {

console.log('\nPART A — provisioning\n');
{
  const db = makeDb();
  const a = await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  ck('A1  a business wallet is created', a.action === 'created', a.action);
  const w = db._docs.get('businessWallets/' + SHOP);
  ck('A2  it lives in its OWN collection, not on wallets/{uid}', !!w && !db._docs.has('wallets/' + OWNER));
  ck('A3  it carries kind:BUSINESS — the field the settlement authority insists on', w.kind === 'BUSINESS');
  ck('A4  it is keyed by SHOP and owned by an ACCOUNT (they are different ids)',
    w.shopId === SHOP && w.ownerUid === OWNER && SHOP !== OWNER);
  ck('A5  the balance field names its unit (cents), and opens at zero',
    w.balanceMinor === 0 && !('balance' in w));

  const again = await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  ck('A6  provisioning is idempotent', again.action === 'exists', again.action);
}
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  const hijack = await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OTHER });
  ck('A7  provisioning NEVER silently re-owns an existing wallet',
    hijack.action === 'exists_other_owner' && hijack.ownerUid === OWNER, hijack.action);
  ck('A8  ...and the stored owner is unchanged',
    db._docs.get('businessWallets/' + SHOP).ownerUid === OWNER);
}
{
  const db = makeDb();
  let threw = null;
  try { await BW.ensureBusinessWallet(db, { shopId: SHOP }); } catch (e) { threw = e; }
  ck('A9  a wallet cannot be created without an owner', !!threw && threw.code === 'BW_NO_OWNER',
    threw && threw.code);
  ck('A10 ...and no opening balance can be injected at creation',
    !/openingBalance|balanceMinor:\s*[1-9]/.test(require('fs').readFileSync(path.join(FN, 'business-wallet.js'), 'utf8')));
}

console.log('\nPART B — the settlement authority accepts it, and rejects a personal wallet\n');
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  const w = await BW.getBusinessWallet(db, SHOP);

  let ok = false;
  try { ok = S.assertBusinessWallet({ wallet: w, merchantUid: OWNER }); } catch (_) { ok = false; }
  ck('B1  assertBusinessWallet ACCEPTS the wallet we built', ok === true);

  /* The shape a personal wallet would present. It must be refused. */
  let threw = null;
  try {
    S.assertBusinessWallet({ wallet: { uid: OWNER, ownerUid: OWNER, kind: 'PERSONAL' }, merchantUid: OWNER });
  } catch (e) { threw = e; }
  ck('B2  ...and REFUSES a personal wallet, even one the merchant owns',
    !!threw && threw.code === 'SETTLE_NOT_BUSINESS_WALLET', threw && threw.code);

  let threw2 = null;
  try { S.assertBusinessWallet({ wallet: w, merchantUid: OTHER }); } catch (e) { threw2 = e; }
  ck('B3  ...and REFUSES a business wallet belonging to someone else',
    !!threw2 && threw2.code === 'SETTLE_WALLET_NOT_OWNED', threw2 && threw2.code);

  /* An untyped document — what a plain wallets/{uid} record looks like — must not pass. */
  let threw3 = null;
  try { S.assertBusinessWallet({ wallet: { uid: OWNER, ownerUid: OWNER }, merchantUid: OWNER }); }
  catch (e) { threw3 = e; }
  ck('B4  ...and REFUSES an untyped wallet document', !!threw3);
}
{
  /* A document in the BUSINESS collection that is not one must not be transacted against. */
  const db = makeDb();
  db._docs.set('businessWallets/' + SHOP,
    { uid: SHOP, shopId: SHOP, ownerUid: OWNER, kind: 'PERSONAL', balanceMinor: 100000 });
  let threw = null;
  try { await BW.getBusinessWallet(db, SHOP); } catch (e) { threw = e; }
  ck('B5  a mistyped document in the business collection is refused, not read',
    !!threw && threw.code === 'BW_WRONG_KIND', threw && threw.code);
}

console.log('\nPART C — every movement is ledgered and idempotent\n');
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });

  const c = await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'TOPUP_1', reason: 'top-up' });
  ck('C1  a credit moves the balance', c.action === 'credited' && c.balanceMinor === 100000, String(c.balanceMinor));
  const e = db._docs.get('businessWalletEntries/TOPUP_1');
  ck('C2  ...and writes a ledger entry keyed by the reference', !!e && e.direction === 'CREDIT');
  ck('C3  ...recording the balance before AND after',
    e.balanceBeforeMinor === 0 && e.balanceAfterMinor === 100000);

  const replay = await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'TOPUP_1' });
  ck('C4  a replayed credit is a NO-OP, not a second credit', replay.action === 'already_applied', replay.action);
  ck('C5  ...so the balance is unchanged',
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 100000);

  const d = await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 30000, ref: 'COMM_1', reason: 'commission' });
  ck('C6  a debit moves it back', d.action === 'debited' && d.balanceMinor === 70000, String(d.balanceMinor));
  const dReplay = await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 30000, ref: 'COMM_1' });
  ck('C7  a replayed debit is a NO-OP', dReplay.action === 'already_applied');
  ck('C8  ...so the merchant is not charged twice',
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 70000);
}
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  for (const bad of [{ ref: null }, { ref: '' }]) {
    let threw = null;
    try { await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100, ref: bad.ref }); }
    catch (e) { threw = e; }
    ck('C9  a movement without a reference is refused (' + JSON.stringify(bad.ref) + ')',
      !!threw && threw.code === 'BW_NO_REF', threw && threw.code);
  }
  for (const amt of [0, -100, 1.5, NaN, '100']) {
    let threw = null;
    try { await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: amt, ref: 'R' + String(amt) }); }
    catch (e) { threw = e; }
    ck('C10 a non-positive or fractional amount is refused (' + JSON.stringify(amt) + ')',
      !!threw && threw.code === 'BW_BAD_AMOUNT', threw && threw.code);
  }
}

console.log('\nPART D — never negative, and never clamped\n');
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 5000, ref: 'T1' });

  let threw = null;
  try { await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 7000, ref: 'OVER' }); }
  catch (e) { threw = e; }
  ck('D1  an overdrawing debit is REFUSED', !!threw && threw.code === 'BW_INSUFFICIENT_FUNDS',
    threw && threw.code);
  ck('D2  ...with the exact shortfall, not a clamp',
    threw && threw.details && threw.details.shortfallMinor === 2000 &&
    threw.details.partialDebitRefused === true, threw && threw.details && String(threw.details.shortfallMinor));
  ck('D3  ...and the balance is untouched',
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 5000);
  ck('D4  ...and NO ledger entry was written for the refused debit',
    !db._docs.has('businessWalletEntries/OVER'));

  const exact = await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 5000, ref: 'EXACT' });
  ck('D5  a debit to exactly zero is allowed', exact.balanceMinor === 0, String(exact.balanceMinor));
}
{
  const db = makeDb();
  let threw = null;
  try { await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 100, ref: 'X' }); }
  catch (e) { threw = e; }
  ck('D6  transacting against a shop with NO wallet is refused, not auto-created',
    !!threw && threw.code === 'BW_NO_WALLET', threw && threw.code);
}

console.log('\nPART E — unreadable is not zero\n');
{
  const db = makeDb({ failReads: true });
  let threw = null;
  try { await BW.getBusinessWallet(db, SHOP); } catch (e) { threw = e; }
  ck('E1  a failed wallet read THROWS', !!threw && threw.code === 'BW_UNREADABLE', threw && threw.code);
  ck('E2  ...and never reports a zero balance',
    !!threw && !/balance is 0|KES 0/i.test(String(threw.message)));
}
{
  const db = makeDb();
  const missing = await BW.getBusinessWallet(db, 'NO_SUCH_SHOP');
  ck('E3  a genuinely missing wallet returns null — distinct from unreadable', missing === null);
}
{
  const db = makeDb();
  db._docs.set('businessWallets/' + SHOP,
    { uid: SHOP, shopId: SHOP, ownerUid: OWNER, kind: 'BUSINESS', balanceMinor: 12.5 });
  let threw = null;
  try { await BW.getBusinessWallet(db, SHOP); } catch (e) { threw = e; }
  ck('E4  a fractional-cent balance is refused rather than rounded',
    !!threw && threw.code === 'BW_UNREADABLE', threw && threw.code);
}

console.log('\nPART F — adversarial controls\n');
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: OWNER });
  const before = db._docs.get('businessWallets/' + SHOP).balanceMinor;
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 1, ref: 'PROBE' });
  const after = db._docs.get('businessWallets/' + SHOP).balanceMinor;
  ck('F1  the harness genuinely mutates the balance', after === before + 1, before + ' -> ' + after);

  ck('F2  the two wallet collections are different strings',
    BW.WALLETS === 'businessWallets' && BW.WALLETS !== 'wallets');

  /* The unit trap: KES 100 must be 10000 cents here, never 100. */
  ck('F3  the wallet speaks the same minor units money-authority does',
    MA.fromMinor(10000).minorUnits === 10000 &&
    MA.toMajorString(MA.fromMinor(10000)).indexOf('100') !== -1,
    MA.toMajorString(MA.fromMinor(10000)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
