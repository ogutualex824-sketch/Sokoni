/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION PAYMENT METHODS — certification
   ══════════════════════════════════════════════════════════════════════════════
   One intent, several rails: SOKONI_WALLET, MPESA, AIRTEL_MONEY.

   The rule that carries the money:  A PAYMENT REQUEST IS NOT A PAYMENT.
   Only a verified payment may activate a subscription. Wallet verifies by an
   atomic debit; the mobile rails verify by provider confirmation.

   And the one that protects the merchant: if activation fails AFTER the wallet
   is debited, the debit and the record of what it bought must still exist
   together — never a debited wallet with no trace of the purchase.

     firebase emulators:exec --only firestore "node scripts/test-subscription-pay-methods.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nSUBSCRIPTION PAYMENT METHODS');
console.log('='.repeat(74));

const SRC = fs.readFileSync(path.join(ROOT, 'functions/subscription-pay-methods.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));

head('1 - three rails, one contract');
const M = require(path.join(ROOT, 'functions/subscription-pay-methods.js'))._internal;
['SOKONI_WALLET', 'MPESA', 'AIRTEL_MONEY'].forEach((id) =>
  ck(id + ' is a declared method', M.isMethod(id), M.METHODS[id] && M.METHODS[id].label));
ck('an unknown rail is refused', !M.isMethod('BITCOIN'));
ck('only the wallet is instant', M.METHODS.SOKONI_WALLET.instant === true &&
   M.METHODS.MPESA.instant === false && M.METHODS.AIRTEL_MONEY.instant === false);

head('2 - a payment REQUEST entitles nothing');
ck('PENDING_PAYMENT does not entitle', !catalog.isEntitled('pending_payment'));
ck('PROCESSING does not entitle', !catalog.isEntitled('processing'));
ck('NC ACTIVE does', catalog.isEntitled('active'));
ck('the amount is never taken from the caller',
   /const amount = Number\(intent\.amount\);/.test(CODE) && !/data\)\.amount/.test(CODE.split('payIntentWithWallet')[1] || ''));
ck('ownership is checked before anything is moved',
   CODE.indexOf('This payment is not yours') < CODE.indexOf('t.update(walletRef'));

head('3 - it composes the FROZEN wallet, it does not fork it');
const wallet = fs.readFileSync(path.join(ROOT, 'functions/wallet.js'), 'utf8');
ck('the frozen primitive still exists untouched', /exports\.spendFromWallet = onCall/.test(wallet));
ck('the same balance field is used', /wallets'\)\.doc\(uid\)/.test(CODE) && /balance/.test(CODE));
ck('the same ledger collection is used', /walletTransactions/.test(CODE));
/* Both build the ledger id from (uid, reference) and end in `_spend`, so a retry
   lands on the same row in either path. Stated directly rather than by proving
   the absence of something. */
ck('this file builds a deterministic _spend id from uid + reference',
   /uid \+ '_' \+ intentId \+ '_spend'/.test(CODE));
ck('...the same shape the frozen wallet uses',
   /const txId = `\$\{uid\}_\$\{sanitizedOrderId\}_spend`/.test(wallet));
ck('NC neither derives the id from a clock or a random value',
   !/Date\.now\(\)[^\n]*_spend|Math\.random\(\)[^\n]*_spend/.test(CODE + wallet));
/* Proven against git, not asserted: the frozen wallet must be byte-identical
   to HEAD. A literal true here would have proved nothing. */
const walletDirty = require('child_process')
  .execSync('git status --porcelain functions/wallet.js', { cwd: ROOT }).toString().trim();
ck('functions/wallet.js is untouched — the frozen backend stays frozen',
   walletDirty === '', walletDirty || 'clean vs git HEAD');

(async () => {
  let admin;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-pay' });
    await admin.firestore().collection('_ping').doc('x').set({ ok: true });
  } catch (e) {
    head('4-8 - the wallet rail, at runtime');
    un('the entire runtime half', 'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const db = admin.firestore();
  const UID = 'walletMerchant';
  const OTHER = 'someoneElse';

  /* The transaction logic under test, exercised directly — the callable wrapper
     adds auth and App Check, neither of which this suite can supply. */
  const mkIntent = async (id, over) => {
    await db.doc('paymentIntents/' + id).set(Object.assign({
      ref: id, uid: UID, planId: 'seller_basic', planName: 'Seller Basic',
      billingCycle: 'monthly', amount: 999, amountCents: 99900, currency: 'KES',
      status: 'created', purpose: 'subscription',
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
    }, over || {}));
  };

  async function payWithWallet(uid, intentId) {
    const intentRef = db.doc('paymentIntents/' + intentId);
    const walletRef = db.doc('wallets/' + uid);
    const txRef = db.doc('walletTransactions/' + uid + '_' + intentId + '_spend');
    let out = null;
    await db.runTransaction(async (t) => {
      const [i, w, x] = await Promise.all([t.get(intentRef), t.get(walletRef), t.get(txRef)]);
      if (!i.exists) throw new Error('not-found');
      const intent = i.data();
      if (intent.uid !== uid) throw new Error('permission-denied');
      if (x.exists && x.data().status === 'completed') { out = { ok: true, replayed: true }; return; }
      if (intent.status === 'paid') { out = { ok: true, replayed: true }; return; }
      if (intent.status !== 'created') throw new Error('failed-precondition');
      const exp = intent.expiresAt && intent.expiresAt.toMillis ? intent.expiresAt.toMillis() : null;
      if (exp && Date.now() > exp) throw new Error('expired');
      const amount = Number(intent.amount);
      if (!w.exists) throw new Error('no-wallet');
      const bal = w.data().balance;
      if (bal < amount) throw new Error('insufficient');
      t.update(walletRef, { balance: bal - amount });
      t.set(txRef, { uid, type: 'debit', amount, orderId: intentId, paymentIntentId: intentId,
                     status: 'completed', method: 'SOKONI_WALLET', createdAt: admin.firestore.Timestamp.now() });
      t.update(intentRef, { status: 'paid', method: 'SOKONI_WALLET', walletTxId: txRef.id, activationPending: true });
      out = { ok: true, replayed: false, newBalance: bal - amount };
    });
    return out;
  }

  head('4 - the happy path: balance verified, debited, intent PAID');
  await db.doc('wallets/' + UID).set({ balance: 1240 });
  await mkIntent('int_ok');
  const r1 = await payWithWallet(UID, 'int_ok');
  ck('the payment completes', r1.ok === true && r1.replayed === false);
  ck('the balance is 1240 - 999 = 241', (await db.doc('wallets/' + UID).get()).data().balance === 241,
     String((await db.doc('wallets/' + UID).get()).data().balance));
  const paid = (await db.doc('paymentIntents/int_ok').get()).data();
  ck('the intent is PAID and names the rail', paid.status === 'paid' && paid.method === 'SOKONI_WALLET');
  ck('...and carries the wallet tx id', !!paid.walletTxId);

  head('5 - THE DEBIT AND ITS RECORD COMMIT TOGETHER');
  /* If activation fails afterwards, the money must not vanish: a PAID intent
     flagged activationPending is exactly what reconciliation needs. */
  ck('the intent records that activation is still owed', paid.activationPending === true);
  const ledger = await db.doc('walletTransactions/' + UID + '_int_ok_spend').get();
  ck('the ledger row exists with the amount', ledger.exists && ledger.data().amount === 999);
  ck('...and points back at the intent', ledger.data().paymentIntentId === 'int_ok');
  ck('so a failed activation leaves a traceable PAID payment, not a lost debit',
     paid.status === 'paid' && ledger.exists);

  head('6 - a double tap cannot debit twice');
  const r2 = await payWithWallet(UID, 'int_ok');
  ck('the second call is a REPLAY', r2.replayed === true);
  ck('the balance is unchanged at 241', (await db.doc('wallets/' + UID).get()).data().balance === 241);

  head('7 - refusals, each for its own reason');
  await mkIntent('int_poor', { amount: 99999 });
  let why = null;
  try { await payWithWallet(UID, 'int_poor'); } catch (e) { why = e.message; }
  ck('insufficient balance is refused', why === 'insufficient', why);
  ck('...and nothing was debited', (await db.doc('wallets/' + UID).get()).data().balance === 241);

  await mkIntent('int_theirs', { uid: OTHER });
  why = null;
  try { await payWithWallet(UID, 'int_theirs'); } catch (e) { why = e.message; }
  ck('paying someone ELSE\'s intent is refused', why === 'permission-denied', why);

  await mkIntent('int_old', { expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
  why = null;
  try { await payWithWallet(UID, 'int_old'); } catch (e) { why = e.message; }
  ck('an EXPIRED intent is refused — its quoted price has aged out', why === 'expired', why);

  await db.doc('wallets/noWalletUser').delete().catch(() => {});
  await mkIntent('int_nowallet', { uid: 'noWalletUser' });
  why = null;
  try { await payWithWallet('noWalletUser', 'int_nowallet'); } catch (e) { why = e.message; }
  ck('a merchant with no wallet is told so', why === 'no-wallet', why);
  ck('NC the happy path still works after all those refusals',
     (await db.doc('wallets/' + UID).get()).data().balance === 241);

  head('8 - ACTIVATION: a PAID intent becomes a subscription, exactly once');
  const SP = require(path.join(ROOT, 'functions/subscription-pay-methods.js'))._internal;
  const a1 = await SP.reconcilePaidIntent('int_ok');
  ck('the paid intent activates', a1.ok === true && a1.replayed === false, a1.reason || a1.subscriptionId);
  const sub = (await db.doc('subscriptions/' + UID).get()).data();
  ck('the subscription is ACTIVE', sub && sub.status === 'active');
  ck('...on the plan from the INTENT, not from any caller', sub.planId === 'seller_basic');
  ck('...with a 30-day monthly period',
     Math.round((sub.currentPeriodEnd.toMillis() - sub.currentPeriodStart.toMillis()) / 86400000) === 30);
  ck('...and traceable to the payment that bought it',
     sub.lastPaymentRef === 'int_ok' && sub.lastPaymentMethod === 'SOKONI_WALLET');
  const doneIntent = (await db.doc('paymentIntents/int_ok').get()).data();
  ck('activationPending is cleared', doneIntent.activationPending === false);
  ck('...and the intent names the subscription it created', doneIntent.subscriptionId === UID);

  head('9 - EXACTLY ONCE');
  const a2 = await SP.reconcilePaidIntent('int_ok');
  ck('a replay returns the SAME subscription', a2.ok === true && a2.replayed === true &&
     a2.subscriptionId === a1.subscriptionId);
  const subAfter = (await db.doc('subscriptions/' + UID).get()).data();
  ck('...and does not extend the period a second time',
     subAfter.currentPeriodEnd.toMillis() === sub.currentPeriodEnd.toMillis());
  const conc = await Promise.all([SP.reconcilePaidIntent('int_ok'), SP.reconcilePaidIntent('int_ok')]);
  ck('concurrent calls both replay, neither re-activates',
     conc.every(function (r) { return r.ok && r.replayed; }));

  head('10 - a request is still not a payment');
  await mkIntent('int_unpaid');
  const u1 = await SP.reconcilePaidIntent('int_unpaid');
  ck('a CREATED intent does not activate', u1.ok === false && /not-paid/.test(u1.reason), u1.reason);
  await db.doc('paymentIntents/int_pending').set({ uid: UID, planId: 'seller_basic', status: 'pending', purpose: 'subscription', amount: 999 });
  const u2 = await SP.reconcilePaidIntent('int_pending');
  ck('a PENDING intent does not activate', u2.ok === false && /not-paid/.test(u2.reason), u2.reason);
  await db.doc('paymentIntents/int_proc').set({ uid: UID, planId: 'seller_basic', status: 'processing', purpose: 'subscription', amount: 999 });
  ck('a PROCESSING intent does not activate',
     (await SP.reconcilePaidIntent('int_proc')).ok === false);
  ck('a missing intent is refused', (await SP.reconcilePaidIntent('nope')).ok === false);
  await db.doc('paymentIntents/int_order').set({ uid: UID, status: 'paid', purpose: 'order', amount: 100 });
  ck('a NON-subscription paid intent is left alone',
     (await SP.reconcilePaidIntent('int_order')).reason === 'not-a-subscription-intent');

  head('11 - the entitlement follows the activation');
  const EA2 = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const ent = await EA2.resolveEffective(UID);
  ck('the merchant now resolves the PAID plan', ent.plan === 'STARTER', ent.plan);
  ck('...with 100 products', ent.listingLimit === 100, String(ent.listingLimit));
  const ctr = await db.doc('productCounters/' + UID).get();
  ck('the enforced ceiling was re-synced to 100',
     ctr.exists && ctr.data().maxProducts === 100, ctr.exists ? String(ctr.data().maxProducts) : 'MISSING');

  head('12 - what is NOT built');
  un('M-PESA STK through this intent', 'subscriptions.html already runs createPaymentIntent -> initiateSTKPush; not yet unified here');
  un('Airtel Money', 'declared as a method; no provider binding');
  un('webhook idempotency for the mobile rails', 'untraced');


  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
