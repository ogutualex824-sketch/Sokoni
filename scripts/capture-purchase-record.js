/* ══════════════════════════════════════════════════════════════════════════════
   REAL PURCHASE — capture the production record
   ══════════════════════════════════════════════════════════════════════════════
   Run immediately after a real Seller Basic purchase. The success screen is one
   layer of evidence and the weakest one: it can say "activated" because a poll
   returned, not because the money travelled the intended authority chain. This
   reads the records instead.

     node scripts/capture-purchase-record.js <merchantUid>
     node scripts/capture-purchase-record.js <merchantUid> --before   (baseline)

   READ ONLY. No writes, no retries, no payment. Take a --before snapshot first
   so "one subscription" means one MORE than there was, not one in total.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const UID = process.argv[2];
const BEFORE = process.argv.indexOf('--before') > -1;

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);
const line = (k, v) => console.log('  ' + (k + ' ').padEnd(26, '.') + ' ' + (v === undefined ? '(absent)' : v));

if (!UID) { console.log('\n  Usage: node scripts/capture-purchase-record.js <merchantUid> [--before]\n'); process.exit(2); }

const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
const iso = (t) => (ms(t) ? new Date(ms(t)).toISOString() : '(absent)');
const days = (t) => (ms(t) ? Math.round((ms(t) - Date.now()) / 86400000) + ' days' : '—');

console.log('\nPURCHASE RECORD ' + (BEFORE ? '— BASELINE (before payment)' : '— AFTER PAYMENT'));
console.log('='.repeat(74));

(async () => {
  let admin, db;
  try {
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
    db = admin.firestore();
    await db.collection('shops').limit(1).get();
  } catch (e) {
    un('everything', 'no production access: ' + String((e && e.message) || e).slice(0, 70));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
    process.exit(0);
  }

  head('MERCHANT');
  const [shop, user] = await Promise.all([db.doc('shops/' + UID).get(), db.doc('users/' + UID).get()]);
  line('uid', UID);
  line('shop', shop.exists ? (shop.data().name || '(unnamed)') : 'MISSING');
  line('user', user.exists ? (user.data().name || user.data().displayName || '(unnamed)') : 'MISSING');

  head('PAYMENT INTENTS');
  const intents = await db.collection('paymentIntents').where('uid', '==', UID)
    .where('purpose', '==', 'subscription').get().catch(() => null);
  line('subscription intents', intents ? String(intents.size) : 'unreadable');
  let paid = null;
  if (intents) intents.forEach((d) => {
    const x = d.data();
    console.log('    ' + d.id);
    console.log('      status ' + x.status + '  amount ' + x.amount + ' ' + (x.currency || '') +
                '  plan ' + (x.planId || '?') + '/' + (x.billingCycle || '?'));
    if (x.status === 'paid') {
      paid = { id: d.id, ...x };
      console.log('      paidVia ' + (x.paidVia || '—') + '  providerRef ' + (x.providerRef || '—') +
                  '  amountPaidKES ' + (x.amountPaidKES === undefined ? '—' : x.amountPaidKES));
      console.log('      reconciledAt ' + iso(x.reconciledAt) +
                  '  activationPending ' + x.activationPending +
                  '  subscriptionId ' + (x.subscriptionId || '—'));
    }
  });

  head('PAYMENT RECORD (the money)');
  if (paid && paid.providerRef) {
    const p = await db.doc('payments/' + paid.providerRef).get().catch(() => null);
    if (p && p.exists) {
      const x = p.data();
      line('ref', paid.providerRef);
      line('amount', x.amount + ' ' + (x.currency || 'KES'));
      line('confirmedAmount', x.confirmedAmount);
      line('status', x.status);
      line('intasendState', x.intasendState);
      line('webhookReceivedAt', iso(x.webhookReceivedAt) === '(absent)' ? (x.webhookReceivedAt || '(absent)') : iso(x.webhookReceivedAt));
      ck('a genuine IntaSend webhook was received', !!x.webhookReceivedAt,
         x.webhookReceivedAt ? 'recorded' : 'NO webhook timestamp');
      ck('the payment is COMPLETE', x.status === 'COMPLETE', x.status);
    } else line('payments/{ref}', 'NOT FOUND');
  } else un('the payment record', 'no PAID intent with a providerRef yet');

  head('SUBSCRIPTION');
  const subs = await db.collection('subscriptions').where('uid', '==', UID).get().catch(() => null);
  line('subscription documents', subs ? String(subs.size) : 'unreadable');
  let sub = null;
  if (subs) subs.forEach((d) => { if (!sub) sub = { id: d.id, ...d.data() }; });
  if (sub) {
    line('subscription id', sub.id);
    line('status', sub.status);
    line('plan / planId', (sub.plan || '—') + ' / ' + (sub.planId || '—'));
    line('billingCycle', sub.billingCycle);
    line('lastPaymentRef', sub.lastPaymentRef);
    line('lastPaymentMethod', sub.lastPaymentMethod);
    line('currentPeriodStart', iso(sub.currentPeriodStart));
    line('currentPeriodEnd', iso(sub.currentPeriodEnd) + '  (' + days(sub.currentPeriodEnd) + ')');
    line('expiresAt', iso(sub.expiresAt) + '  (' + days(sub.expiresAt) + ')');
    line('activatedBy', sub.activatedBy);

    if (!BEFORE) {
      ck('exactly ONE subscription document', subs.size === 1, String(subs.size));
      ck('status is active', sub.status === 'active', sub.status);
      ck('currentPeriodEnd === expiresAt EXACTLY',
         ms(sub.currentPeriodEnd) !== null && ms(sub.currentPeriodEnd) === ms(sub.expiresAt),
         (ms(sub.currentPeriodEnd) - ms(sub.expiresAt)) + 'ms apart');
      const want = sub.billingCycle === 'annual' ? 365 : 30;
      const got = Math.round((ms(sub.currentPeriodEnd) - ms(sub.currentPeriodStart)) / 86400000);
      ck('period is the catalogue ' + (sub.billingCycle || 'monthly') + ' duration',
         Math.abs(got - want) <= 1, got + ' days, expected ' + want);
      ck('NO rival writer claimed the activation',
         sub.activatedBy !== 'automation', sub.activatedBy || '(none)');
      ck('traceable to the payment that bought it',
         !!sub.lastPaymentRef, sub.lastPaymentRef || 'no ref');
    }
  } else line('subscription', 'NONE');

  head('ENTITLEMENT + CEILING');
  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const ent = await EA.getMerchantEntitlement(UID).catch(() => null);
  if (ent) {
    line('resolved plan', ent.plan + ' (' + ent.label + ')');
    line('status', ent.status);
    line('resolved from', (ent.resolvedFrom || '—') + ' / ' + (ent.resolvedPlanId || '—'));
    line('product limit', ent.limits.products === -1 ? 'unlimited' : String(ent.limits.products));
    line('products used', ent.limits.productsUsed === null ? '— (unreadable)' : String(ent.limits.productsUsed));
    if (ent.purchase) {
      line('purchased plan', ent.purchase.planId);
      line('price paid / tier price', (ent.purchase.pricePaidKES == null ? '—' : 'KES ' + ent.purchase.pricePaidKES) +
           ' / ' + (ent.purchase.tierPriceKES == null ? '—' : 'KES ' + ent.purchase.tierPriceKES));
    }
  }
  const ctr = await db.doc('productCounters/' + UID).get().catch(() => null);
  line('productCounters.count', ctr && ctr.exists ? String(ctr.data().count) : 'MISSING');
  line('productCounters.maxProducts', ctr && ctr.exists ? String(ctr.data().maxProducts) : 'MISSING');
  if (!BEFORE && ent && ctr && ctr.exists) {
    ck('maxProducts matches the entitled limit',
       ctr.data().maxProducts === ent.limits.products,
       ctr.data().maxProducts + ' vs entitled ' + ent.limits.products);
  }

  head('NEGATIVE PROPERTIES — nothing happened twice');
  const wallet = await db.collection('walletTransactions').where('uid', '==', UID).get().catch(() => null);
  const debits = wallet ? wallet.docs.filter((d) => d.data().type === 'debit') : [];
  line('wallet debits', wallet ? String(debits.length) : 'unreadable');
  if (!BEFORE) {
    ck('no wallet debit for an M-PESA purchase', debits.length === 0,
       debits.length ? debits.map((d) => d.id).join(', ') : 'none');
    const paidIntents = intents ? intents.docs.filter((d) => d.data().status === 'paid') : [];
    ck('exactly ONE paid intent', paidIntents.length === 1, String(paidIntents.length));
    ck('the intent is reconciled once', !!(paid && paid.reconciledAt && paid.activationPending === false));
  }

  head('KASS — must be untouched');
  const kass = await db.doc('subscriptions/D5Ql2EYr95bt79IpcGTmOMTK0P83').get().catch(() => null);
  ck('KASS shop subscription unchanged',
     !!(kass && kass.exists && (kass.data().planId === 'seller_free' || kass.data().plan === 'trial')),
     kass && kass.exists ? ((kass.data().plan || kass.data().planId) + ' / ' + kass.data().status) : 'MISSING');
  const link = await db.doc('merchantAccountLinks/xrH21J5GFbW8PluCZ2ny5nIuf602').get().catch(() => null);
  ck('KASS account link still absent', !!(link && !link.exists));

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  Nothing was written by this script.');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Capture aborted: ' + (e && e.message) + '\n'); process.exit(1); });
