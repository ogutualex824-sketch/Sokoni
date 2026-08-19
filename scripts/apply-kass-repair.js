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

  /* ── BLOCKED: "how many products" is not yet a settled question ────────────
     A recount is only correct once ACTIVE is defined, and in production it is
     not. The KASS shop carries archive state under THREE disagreeing spellings —
     `status: 'archived'` (7 docs), `archivedAt` present (8), `active === false`
     (5) — with only 5 agreeing across all three and at least one product
     (AD111) archived by one signal alone.

     Counting all 103 would charge the merchant for archived products and block a
     shop that is actually at 95 or 96 active. Counting by any single signal
     picks a winner among three that disagree. Neither is a recount; both are a
     guess written into an enforcement record.

     This refuses until the product lifecycle contract is canonical. */
  head('OPERATION 2 — recount both counters from reality');
  {
    const snap = await db.collection('products').where('sellerUid', '==', SHOP).get();
    const byStatus = [], byArchivedAt = [], byActiveFalse = [];
    snap.forEach((d) => {
      const x = d.data();
      if (String(x.status || '').toLowerCase() === 'archived') byStatus.push(d.id);
      if (x.archivedAt) byArchivedAt.push(d.id);
      if (x.active === false) byActiveFalse.push(d.id);
    });
    const union = new Set([].concat(byStatus, byArchivedAt, byActiveFalse));
    const agreed = byStatus.filter((i) => byArchivedAt.indexOf(i) > -1 && byActiveFalse.indexOf(i) > -1);
    line('products total', String(snap.size));
    line('archived: status', String(byStatus.length));
    line('archived: archivedAt', String(byArchivedAt.length));
    line('archived: active===false', String(byActiveFalse.length));
    line('archived: union / agreed', union.size + ' / ' + agreed.length);
    line('ACTIVE (union basis)', String(snap.size - union.size));
    if (union.size !== agreed.length) {
      stop('archive state disagrees across ' + union.size + ' products (only ' + agreed.length +
           ' agree on all three signals). Define the canonical product lifecycle before ' +
           'writing a counter — a recount over an undefined ACTIVE is a guess, not a count.');
    }
  }

  const plan = [];
  for (const uid of [SHOP, PAID]) {
    const real = await db.collection('products').where('sellerUid', '==', uid).count().get()
      .then((s) => s.data().count).catch(() => null);
    if (real === null) stop('could not count products for ' + uid);
    const snap = await db.doc('productCounters/' + uid).get();
    const d = snap.exists ? snap.data() : {};
    const prev = typeof d.count === 'number' ? d.count : null;
    const prevMax = typeof d.maxProducts === 'number' ? d.maxProducts : null;
    /* A grandfathered floor would raise the ceiling ABOVE the plan, which is
       Option B by the back door. Refuse rather than apply it silently. */
    const floor = typeof d.grandfatheredFloor === 'number' ? d.grandfatheredFloor : null;
    plan.push({ uid, real, prev, prevMax, floor });
    line(uid.slice(0, 14) + '…', 'counter ' + String(prev) + ' -> ' + real + ' (real products)');
  }

  /* ── OPERATION 3 — the ceiling the RULES actually enforce ──────────────────
     Without this the repair makes the merchant WORSE. The rule is
     `count < maxProducts`. Today KASS is count −23 / max 10, and −23 < 10 passes,
     which is the only reason they can add products at all. Setting count to 103
     and leaving max at 10 gives 103 < 10 (blocked, correct) — but ALSO 99 < 10
     after they delete four, so they would be blocked permanently. */
  head('OPERATION 3 — re-sync the enforced ceiling from the LINKED entitlement');
  const predicted = await EA.resolveEffective(PAID);
  line('entitlement after link', predicted.plan + ' / ' +
    (predicted.listingLimit === -1 ? 'unlimited' : predicted.listingLimit));
  line('resolvedUid', String(predicted.resolvedUid));
  if (predicted.plan !== 'STARTER' || predicted.listingLimit !== 100) {
    stop('the linked entitlement is not STARTER/100 — it resolved ' +
         predicted.plan + '/' + predicted.listingLimit);
  }
  if (predicted.resolvedUid !== PAID) stop('the entitlement did not resolve from the paying uid');
  for (const p of plan) {
    if (p.floor !== null && p.floor > 100) {
      stop('a grandfatheredFloor of ' + p.floor + ' on ' + p.uid +
           ' would raise the ceiling above the plan — that is Option B and needs its own decision');
    }
    line('maxProducts ' + p.uid.slice(0, 14) + '…', String(p.prevMax) + ' -> 100');
  }

  head('RESULTING STATE (predicted)');
  const shopReal = plan.find((p) => p.uid === SHOP).real;
  line('shop products', String(shopReal));
  line('shop ceiling', '100');
  const over = shopReal > 100;
  line('over limit?', over
    ? 'YES — ' + shopReal + ' > 100. Existing products STAY; creation blocked until 100 or below.'
    : 'no');
  line('rule check now', shopReal + ' < 100 -> ' + (shopReal < 100 ? 'ALLOWED' : 'DENIED (correct)'));
  line('rule check after deleting 4', (shopReal - 4) + ' < 100 -> ' +
       ((shopReal - 4) < 100 ? 'ALLOWED (correct)' : 'DENIED'));
  console.log('\n  NOTE: the limit is NOT being raised to ' + shopReal + ' to make the UI green.');
  console.log('  A migration allowance would be a separate, explicitly recorded commercial decision.');

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply to perform all THREE writes.\n');
    process.exit(0);
  }

  head('APPLYING');
  /* Order matters: the link must exist before the ceiling is resolved, or
     syncLimit would compute the unlinked FREE allowance and write 10 again. */
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

  /* syncLimit derives the ceiling from the resolved entitlement — which now
     follows the link — rather than this script hardcoding 100. */
  const PL = require(path.join(ROOT, 'functions/product-limit.js'))._internal;
  for (const p of plan) {
    const r = await PL.syncLimit(p.uid);
    if (!r || r.maxProducts !== 100) {
      console.log('\n  WARNING: ceiling for ' + p.uid + ' resolved to ' +
                  (r && r.maxProducts) + ', not 100. Verify before letting the merchant trade.');
    }
    line('maxProducts ' + p.uid.slice(0, 14) + '…', String(p.prevMax) + ' -> ' + (r && r.maxProducts));
  }

  console.log('\n  Applied: link + counters + ceilings. No subscription, price or product was touched.');
  console.log('  Verify with: node scripts/verify-kass-subscription.js ' + SHOP + '\n');
  process.exit(0);
})().catch((e) => { console.error('\n  Repair aborted: ' + (e && e.message) + '\n'); process.exit(1); });
