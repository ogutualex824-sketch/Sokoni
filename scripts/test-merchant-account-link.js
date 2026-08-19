/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ACCOUNT LINK — certification
   ══════════════════════════════════════════════════════════════════════════════
   KASS pays for `starter` on one uid and trades from a shop on another. The
   repair is an EXPLICIT, ADMIN-CREATED, AUDITABLE link — never a heuristic and
   never self-declared.

   What must be true:
     · same name is NOT same merchant — no matching on name/phone/email anywhere
     · a link cannot be self-declared: server-owned collection + admin callable
     · a uid belongs to AT MOST ONE identity; ambiguity is refused, not guessed
     · with no link, resolution is EXACTLY the single-uid behaviour of today
     · with a link, the shop resolves the paid plan — and says which uid it came from
     · the KES 499 subscription record is never moved, copied or rewritten

     firebase emulators:exec --only firestore "node scripts/test-merchant-account-link.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nMERCHANT ACCOUNT LINK — the KASS repair');
console.log('='.repeat(74));

const SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-identity.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules.live'), 'utf8');

head('1 - same name is NOT same merchant');
ck('nothing matches accounts on name', !/linkedUids[\s\S]{0,900}\.name/.test(CODE));
ck('nothing matches on phone or email', !/(where\(['"]phone|where\(['"]email)/.test(CODE));
ck('a link is only ever read by uid', /collection\(LINKS\)\.doc\(self\)/.test(CODE));

head('2 - a link cannot be self-declared');
ck('the callable requires an admin claim',
   /if \(!t\.admin && !t\.superAdmin\) throw new HttpsError\('permission-denied'/.test(CODE));
ck('...and a reason, so a link is explainable', /reason required/.test(CODE));
ck('the collection is unlisted in the live ruleset, so writes DENY by default',
   RULES.indexOf('merchantAccountLinks') === -1);
ck('...and the ruleset has no catch-all allow to undo that',
   !/match \/\{document=\*\*\}[\s\S]{0,200}allow (read|write): if true/.test(RULES));

(async () => {
  let admin;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-links' });
    await admin.firestore().collection('_ping').doc('x').set({ ok: true });
  } catch (e) {
    head('3-9 - resolution across a link');
    un('the entire resolution half', 'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const MI = require(path.join(ROOT, 'functions/merchant-identity.js'))._internal;
  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const db = admin.firestore();

  /* The real KASS shape. */
  const PAID = 'xrH21J5GFbW8PluCZ2ny5nIuf602';
  const SHOP = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
  const future = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 86400000);
  await db.doc('subscriptions/' + PAID).set({ uid: PAID, plan: 'starter', status: 'active', currentPeriodEnd: future });
  await db.doc('subscriptions/' + SHOP).set({ uid: SHOP, planId: 'seller_free', plan: 'trial', status: 'trialing', trial: true, trialEndsAt: future, currentPeriodEnd: future });
  await db.doc('shops/' + SHOP).set({ name: 'KASS SHOP' });
  await db.doc('productCounters/' + SHOP).set({ uid: SHOP, count: 103 });

  head('3 - BEFORE the link, the shop resolves FREE — exactly as production does');
  ck('no link exists yet', (await MI.linkedUids(SHOP)).length === 1);
  const before = await EA.resolveEffective(SHOP);
  ck('the shop resolves FREE / 10', before.plan === 'FREE' && before.listingLimit === 10, before.plan);
  ck('...and the paid account resolves STARTER / 100 on its own',
     (await EA.resolveEffective(PAID)).listingLimit === 100);
  ck('an unlinked account reports no linkedUids', before.linkedUids === null);

  head('4 - the link is created, and the subscription is NOT touched');
  const beforeSub = JSON.stringify((await db.doc('subscriptions/' + PAID).get()).data());
  await db.doc('merchantAccountLinks/' + PAID).set({
    canonicalUid: PAID, linkedAccountUids: [SHOP], shopId: SHOP,
    reason: 'KASS account merge — paid starter on PAID, shop on SHOP',
    evidence: { paymentRef: 'SKN51E7BD480', amountKES: 499 },
    status: 'active', createdBy: 'admin-test',
  });
  ck('both uids now resolve to one identity', (await MI.linkedUids(SHOP)).length === 2);
  ck('...from either direction', (await MI.linkedUids(PAID)).length === 2);
  ck('the KES 499 subscription record is byte-identical afterwards',
     JSON.stringify((await db.doc('subscriptions/' + PAID).get()).data()) === beforeSub);
  const link = await MI.merchantLink(SHOP);
  ck('the link records WHO and WHY',
     link.reason.indexOf('KASS account merge') === 0 && link.createdBy === 'admin-test');
  ck('...and the payment evidence', link.evidence.paymentRef === 'SKN51E7BD480');

  head('5 - AFTER the link, the shop is entitled through the paid account');
  const after = await EA.resolveEffective(SHOP);
  ck('the shop resolves STARTER / 100', after.plan === 'STARTER' && after.listingLimit === 100, after.plan);
  ck('...and says WHICH uid paid for it', after.resolvedUid === PAID, String(after.resolvedUid));
  ck('...and which identity it looked through', Array.isArray(after.linkedUids) && after.linkedUids.length === 2);
  ck('the purchased plan is still `starter`, not rewritten', after.resolvedPlanId === 'starter');
  ck('NC the free trial document did NOT win', after.plan !== 'FREE');

  head('6 - grandfathering: 103 products against 100 allowed');
  const ent = await EA.getMerchantEntitlement(SHOP);
  ck('all 103 remain counted and visible', ent.limits.productsUsed === 103);
  ck('the limit is the paid 100', ent.limits.products === 100);
  ck('remaining is floored at 0, never negative', ent.limits.productsRemaining === 0, String(ent.limits.productsRemaining));
  const cc = await EA.canCreateProduct(SHOP);
  ck('creation is BLOCKED while over the limit', cc.allowed === false && cc.reason === 'product-limit-reached');
  ck('...with the way out stated', !!cc.remedy, cc.remedy);
  await db.doc('productCounters/' + SHOP).set({ uid: SHOP, count: 99 });
  ck('after deleting down to 99, creation is allowed again', (await EA.canCreateProduct(SHOP)).allowed === true);
  ck('nothing in the link path deletes a product', !/\.delete\(/.test(CODE));

  head('7 - ambiguity is refused, not guessed');
  await db.doc('merchantAccountLinks/otherCanonical').set({
    canonicalUid: 'otherCanonical', linkedAccountUids: [SHOP], status: 'active', reason: 'rival claim',
  });
  ck('a uid claimed by TWO identities falls back to itself',
     (await MI.linkedUids(SHOP)).length === 1, 'refused to pick one');
  ck('...so entitlement returns to the shop-only answer',
     (await EA.resolveEffective(SHOP)).plan === 'FREE');
  await db.doc('merchantAccountLinks/otherCanonical').delete();
  ck('NC once the rival claim is gone, the link works again',
     (await MI.linkedUids(SHOP)).length === 2);

  head('8 - REVOKE changes entitlement resolution, NOT customer data');
  /* The safety property the whole design rests on: revoking a link must be a
     resolution change and nothing else. If revocation could touch a subscription,
     a counter or a product, then linking would be a destructive operation and no
     admin could safely undo a mistake. */
  const paidSubBefore = JSON.stringify((await db.doc('subscriptions/' + PAID).get()).data());
  const shopSubBefore = JSON.stringify((await db.doc('subscriptions/' + SHOP).get()).data());
  const counterBefore = JSON.stringify((await db.doc('productCounters/' + SHOP).get()).data());
  const productsBefore = (await db.collection('products').where('sellerUid', '==', SHOP).count().get()).data().count;

  await db.doc('merchantAccountLinks/' + PAID).set({ status: 'revoked' }, { merge: true });

  ck('a revoked link no longer contributes', (await MI.linkedUids(SHOP)).length === 1);
  ck('...so the shop drops back to FREE', (await EA.resolveEffective(SHOP)).plan === 'FREE');
  /* The paid side must be entirely unharmed — revocation is not a punishment. */
  ck('the PAID subscription document is byte-identical',
     JSON.stringify((await db.doc('subscriptions/' + PAID).get()).data()) === paidSubBefore);
  ck('...and the paid account STILL resolves STARTER / 100 on its own',
     (await EA.resolveEffective(PAID)).listingLimit === 100);
  ck('the shop subscription document is byte-identical too',
     JSON.stringify((await db.doc('subscriptions/' + SHOP).get()).data()) === shopSubBefore);
  ck('the product counter is untouched',
     JSON.stringify((await db.doc('productCounters/' + SHOP).get()).data()) === counterBefore);
  ck('no product was deleted',
     (await db.collection('products').where('sellerUid', '==', SHOP).count().get()).data().count === productsBefore);
  /* And it is reversible: re-activating restores entitlement with no data change. */
  await db.doc('merchantAccountLinks/' + PAID).set({ status: 'active' }, { merge: true });
  ck('re-activating the link restores STARTER / 100',
     (await EA.resolveEffective(SHOP)).listingLimit === 100);
  ck('...with the subscription still byte-identical after the round trip',
     JSON.stringify((await db.doc('subscriptions/' + PAID).get()).data()) === paidSubBefore);
  ck('NC the round trip really did change resolution both ways',
     before.plan === 'FREE' && (await EA.resolveEffective(SHOP)).plan === 'STARTER');
  await db.doc('merchantAccountLinks/' + PAID).set({ status: 'revoked' }, { merge: true });

  head('9 - what is NOT proven');
  un('that the link has been created in production', 'no production write was made — decision pending');
  un('the full KASS journey after repair', 'needs the link, the recount, then a real add/delete test');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
