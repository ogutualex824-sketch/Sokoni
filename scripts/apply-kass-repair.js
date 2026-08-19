/* ══════════════════════════════════════════════════════════════════════════════
   KASS REPAIR — the two authorised production writes, as ONE reviewable command
   ══════════════════════════════════════════════════════════════════════════════
   This exists so the repair is executed exactly as agreed rather than improvised
   at a console at the moment it is needed. It performs precisely two operations
   and refuses everything else:

     1. create merchantAccountLinks/{canonicalUid} linking the paid account to
        the KASS shop
     2. recount productCounters for both uids from the actual product documents

   ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
   Writes NOTHING without `--apply`. This touches a real customer's paid record.

     node scripts/apply-kass-repair.js            (dry run — prints the plan)
     node scripts/apply-kass-repair.js --apply    (performs the two writes)

   ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
   It never modifies a subscription, never changes a price, never touches
   `maxProducts`, and never deletes or archives a product. The KES 499 record is
   read for evidence and otherwise left exactly as billing wrote it. If any
   precondition fails it stops before writing anything, because a half-applied
   identity repair is worse than none.

   ── THE CANONICAL DIRECTION IS DELIBERATE ───────────────────────────────────
   canonicalUid is the PAID account, because that is where the subscription and
   the payment evidence live. The shop is the linked account. Swapping them would
   put the canonical identity on the side with no proof of purchase.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const APPLY = process.argv.indexOf('--apply') > -1;

/* Fixed, reviewed parameters. Not accepted from the command line: this script
   repairs ONE known incident, and a uid typed at a prompt is how the wrong
   merchant gets linked. */
const PAID = 'xrH21J5GFbW8PluCZ2ny5nIuf602';
const SHOP = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const REASON = 'account consolidation / subscription-to-shop linkage';
const EVIDENCE = { paymentRef: 'SKN51E7BD480', amountKES: 499, plan: 'starter' };

const line = (k, v) => console.log('  ' + (k + ' ').padEnd(32, '.') + ' ' + v);
const head = (t) => console.log('\n' + t);
const stop = (why) => { console.log('\n  REFUSED: ' + why + '\n  Nothing was written.\n'); process.exit(1); };

console.log('\nKASS REPAIR ' + (APPLY ? '— APPLY (writes)' : '— DRY RUN (writes nothing)'));
console.log('='.repeat(74));

(async () => {
  let admin;
  try {
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
    await admin.firestore().collection('shops').limit(1).get();
  } catch (e) {
    console.log('\n  UNPROVEN — no production access: ' + String((e && e.message) || e).slice(0, 90));
    console.log('  Nothing was read and nothing was written.\n');
    process.exit(0);
  }
  const db = admin.firestore();
  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));

  head('PRECONDITIONS');
  const [paidSub, shopDoc, existingLink] = await Promise.all([
    db.doc('subscriptions/' + PAID).get(),
    db.doc('shops/' + SHOP).get(),
    db.doc('merchantAccountLinks/' + PAID).get(),
  ]);

  if (!paidSub.exists) stop('the paid subscription no longer exists on ' + PAID);
  const ps = paidSub.data();
  line('paid subscription', (ps.plan || ps.planId) + ' / ' + ps.status);
  if (String(ps.status).toLowerCase() !== 'active') stop('the paid subscription is not active — status ' + ps.status);
  if (String(ps.plan || ps.planId) !== 'starter') stop('unexpected plan on the paid account: ' + (ps.plan || ps.planId));

  if (!shopDoc.exists) stop('the KASS shop document is missing at ' + SHOP);
  line('shop', shopDoc.data().name || '(no name)');

  /* The payment is read purely as evidence; it is never modified. */
  const pay = await db.doc('payments/' + EVIDENCE.paymentRef).get().catch(() => null);
  line('payment evidence', pay && pay.exists
    ? (pay.data().amount + ' ' + (pay.data().currency || 'KES') + ' / ' + pay.data().status)
    : 'NOT FOUND');
  if (!pay || !pay.exists || pay.data().status !== 'COMPLETE') stop('the evidence payment is not a COMPLETE record');

  if (existingLink.exists) stop('a link already exists for ' + PAID + ' — review it before re-running');

  /* Neither uid may already belong to some other identity. */
  const MI = require(path.join(ROOT, 'functions/merchant-identity.js'))._internal;
  for (const u of [PAID, SHOP]) {
    const already = await MI.linkedUids(u);
    if (already.length > 1) stop('uid already belongs to a merchant identity: ' + u);
  }
  line('existing identities', 'none — both uids are free');

  head('OPERATION 1 — the account link');
  line('canonicalUid', PAID + '  (holds the subscription + payment)');
  line('linkedAccountUids', '[' + SHOP + ']');
  line('shopId', SHOP);
  line('reason', REASON);
  line('evidence', JSON.stringify(EVIDENCE));

  head('OPERATION 2 — recount both counters from reality');
  const plan = [];
  for (const uid of [SHOP, PAID]) {
    const real = await db.collection('products').where('sellerUid', '==', uid).count().get()
      .then((s) => s.data().count).catch(() => null);
    if (real === null) stop('could not count products for ' + uid);
    const snap = await db.doc('productCounters/' + uid).get();
    const prev = snap.exists && typeof snap.data().count === 'number' ? snap.data().count : null;
    plan.push({ uid, real, prev });
    line(uid.slice(0, 14) + '…', 'counter ' + String(prev) + ' -> ' + real + ' (real products)');
  }

  head('RESULTING STATE (predicted)');
  const predicted = await EA.resolveEffective(PAID);
  line('shop entitlement after link', predicted.plan + ' / ' +
    (predicted.listingLimit === -1 ? 'unlimited' : predicted.listingLimit));
  const shopReal = plan.find((p) => p.uid === SHOP).real;
  line('shop products', String(shopReal));
  const over = predicted.listingLimit !== -1 && shopReal > predicted.listingLimit;
  line('over limit?', over
    ? 'YES — ' + shopReal + ' > ' + predicted.listingLimit + '. Existing products STAY; new creation is blocked until ' + predicted.listingLimit + ' or below.'
    : 'no');
  console.log('\n  NOTE: the limit is NOT being raised to ' + shopReal + ' to make the UI green.');
  console.log('  A migration allowance would be a separate, explicitly recorded commercial decision.');

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply to perform both operations.\n');
    process.exit(0);
  }

  head('APPLYING');
  await db.doc('merchantAccountLinks/' + PAID).create({
    canonicalUid: PAID,
    linkedAccountUids: [SHOP],
    shopId: SHOP,
    reason: REASON,
    evidence: EVIDENCE,
    status: 'active',
    createdBy: 'scripts/apply-kass-repair.js',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  line('link', 'CREATED');

  for (const p of plan) {
    if (p.prev === p.real) { line('counter ' + p.uid.slice(0, 14) + '…', 'already correct'); continue; }
    await db.doc('productCounters/' + p.uid).set({
      uid: p.uid, count: p.real,
      recountedAt: admin.firestore.FieldValue.serverTimestamp(),
      recountedFrom: p.prev,
      recountSource: 'scripts/apply-kass-repair.js',
    }, { merge: true });
    line('counter ' + p.uid.slice(0, 14) + '…', p.prev + ' -> ' + p.real);
  }

  console.log('\n  Applied. maxProducts was NOT touched — syncLimit owns it.');
  console.log('  Verify with: node scripts/verify-kass-subscription.js ' + SHOP + '\n');
  process.exit(0);
})().catch((e) => { console.error('\n  Repair aborted: ' + (e && e.message) + '\n'); process.exit(1); });
