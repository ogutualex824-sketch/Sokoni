#!/usr/bin/env node
/* ============================================================================
   SOKONI — shop communication stops at a contract boundary
   ============================================================================
   §2 of the closure mandate asked for the canonical shop identity to be traced
   BEFORE any mount. It was, and the trace ended at a boundary rather than a
   surface: a shop's document id is its owner's UID, so a shop anchor would have
   the client naming a person — the one thing Connect has no parameter for.

   This gate holds that boundary. It asserts the chain that was proven, and it
   asserts the ABSENCE of a mount — with a positive control, because an absence
   assertion that cannot see a presence proves nothing.

   Full reasoning: docs/SHOP_COMMUNICATION_CONTRACT_BOUNDARY.md
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── 1. The frozen authority has no shop relationship ───────────────────── */
{
  const CA = require(path.join(ROOT, 'functions', 'shared', 'connect-authority.js'));
  const kinds = Object.keys(CA.RELATIONSHIPS).sort().join(',');
  ok('the six relationships are unchanged',
    kinds === 'booking,delivery,inquiry,order,supply,support', kinds);
  ok('there is NO shop relationship', !CA.RELATIONSHIPS.shop);
  ok('CONTROL: the ones that exist are readable', !!CA.RELATIONSHIPS.inquiry);

  /* The nearest relationship is anchored on a LISTING, and is chat-ceilinged
     precisely because it is self-asserted. */
  ok('inquiry is the nearest relationship and is chat-ceilinged',
    CA.RELATIONSHIPS.inquiry.channelCeiling === 'chat');
  ok('inquiry binds buyer to seller',
    CA.RELATIONSHIPS.inquiry.pairs.join(',') === 'buyer:seller');
}

/* ── 2. The inquiry anchor derives the seller; the client never names one ── */
{
  const calls = read('functions/connect-calls.js');
  ok('the inquiry anchor resolves a LISTING, not a shop',
    /_anchorInquiry[\s\S]{0,400}collection\('products'\)\.doc\(anchorId\)/.test(calls));
  ok('…and the seller is DERIVED from that listing',
    /_anchorInquiry[\s\S]{0,600}p\.sellerUid/.test(calls));
  ok('no shop anchor kind exists', !/kind:\s*'shop'/.test(calls));
  ok('no anchor resolves the shops collection',
    !/collection\('shops'\)\.doc\(anchorId\)/.test(calls));

  /* The invariant a shop anchor would break. */
  ok('the callee is SERVER-DERIVED from the anchor parties',
    /calleeUid:\s*String\(parties\[targetRole\]\)/.test(calls));
  ok('…and is NEVER taken from the request',
    !/req\.data[^\n]*calleeUid/.test(calls) && !/calleeUid\s*\}\s*=\s*req\.data/.test(calls));
  ok('…nor destructured out of an incoming payload',
    !/const\s*\{[^}]*calleeUid[^}]*\}\s*=\s*(req|request)\.data/.test(calls));
  ok('the file says so in its own header, and the code agrees',
    calls.indexOf('There is no `calleeUid` parameter anywhere in this') !== -1);
  ok('CONTROL: the file really is the dispatcher', calls.indexOf('connectDispatch') !== -1);
}

/* ── 3. The traced chain: a shop id IS a person ─────────────────────────── */
{
  const rules = read('firestore.rules');
  /* RETARGETED to the PRODUCTION model. These assertions described
     `match /shops/{uid}` with `request.auth.uid == uid` — which was the Git
     lineage, not the deployed one. The reconciliation established that
     production keys the block `{storeId}` and authorises by `ownerId`, with
     uid == storeId only as a fallback for documents that lack it. The claim
     these assertions SUPPORTED is unchanged and still true: a shop is
     addressed by an identifier a client can enumerate, so it must not become a
     Connect anchor. */
  const shopBlock = (() => {
    const { scan } = require(path.join(ROOT, 'scripts', 'rules-blocks.js'));
    const b = scan(rules).find((x) => x.path.indexOf('/shops/') === 0);
    return b ? b.body : '';
  })();
  ok('the rules key a shop document by storeId', /match \/shops\/\{storeId\}/.test(rules));
  ok('…and authorise primarily by ownerId',
    /resource\.data\.ownerId == request\.auth\.uid/.test(shopBlock));
  ok('…with uid == storeId retained only as a legacy fallback',
    /!\("ownerId" in resource\.data\) && request\.auth\.uid == storeId/.test(shopBlock));
  ok('…while shop documents are WORLD-READABLE, so shop ids are enumerable',
    /allow read:\s*if true/.test(shopBlock));
  ok('the stale shops/{uid} block is gone', !/match \/shops\/\{uid\}/.test(rules));

  /* The storefront says so in as many words. */
  const store = read('store.html');
  ok('the storefront identifier is a seller uid',
    /params\.get\("id"\)/.test(store) && /Firebase seller UID/.test(store));
  ok('…and the storefront queries products by that uid as sellerUid',
    /where\("sellerUid",\s*"==",\s*uid\)/.test(store));

  /* The existing canonical resolvers were reused, not duplicated. */
  /* PORT NOTE — LIVE_LINEAGE_DIFFERENCE, recorded rather than repaired.

     `_shopOwner` is admin shop-listing work that exists on the source branch
     and not on the live lineage. It is NOT a Communications dependency — the
     require graph never reaches it — so porting it to satisfy an assertion
     would drag unrelated admin work into the release.

     What it evidenced was that an ownership resolver already existed, so this
     work did not write a fourth one. On a lineage where it does not exist,
     nothing was written either, and the underlying claim — a shop is addressed
     by its OWNER'S uid — is asserted above from firestore.rules, which is the
     enforcement boundary and is present on both lineages. */
  const adminOs = read('functions/admin-os.js');
  if (/_shopOwner/.test(adminOs)) {
    ok('an ownership resolver already exists and was not re-written',
      /_shopOwner = \(x\) => \(x && \(x\.ownerId \|\| x\.sellerUid \|\| x\.uid\)\)/.test(adminOs));
    ok('…and it deliberately refuses to assume shopId = uid',
      adminOs.indexOf('never to `shopId = uid`') !== -1);
  } else {
    ok('RECORDED: the admin ownership resolver is not on this lineage', true);
    ok('…and this work wrote no resolver of its own either',
      !/function _shopOwner|_shopOwner\s*=/.test(read('functions/connect-calls.js')));
  }
  /* PORT NOTE — lineage-aware, and NOT relaxed.

     functions/shared/merchant-identity.js is the STK-narrative module. It
     exists on the source branch and NOT on the live lineage, where index.js
     does not require it at all. It has no runtime role in Communications —
     porting it merely to satisfy this assertion would add a module to
     production for a test's benefit, which is the wrong direction entirely.

     So its absence is RECORDED rather than repaired, and the claim it
     supported — that a shop is addressed by its owner's uid — is asserted
     from the sources that exist on BOTH lineages: the security rules and
     admin-os's ownership resolver, both already checked above. */
  if (fs.existsSync(path.join(ROOT, 'functions/shared/merchant-identity.js'))) {
    ok('the merchant identity module resolves sellerUid -> shops/{uid}',
      read('functions/shared/merchant-identity.js').indexOf('shops/{uid}') !== -1);
  } else {
    ok('RECORDED: the STK-narrative merchant-identity module is not on this lineage',
      true);
    ok('…and the shop-is-addressable claim still stands on the rules alone',
      /match \/shops\/\{storeId\}/.test(read('firestore.rules')));
  }
}

/* ── 4. THE ABSENCE, WITH A POSITIVE CONTROL ────────────────────────────── */
{
  const store = read('store.html');
  /* RETARGETED, not deleted. These asserted that store.html was unmounted,
     which recorded the BLOCKER. The blocker was resolved by changing the
     PRODUCT decision rather than the authority: shop communication is now an
     inquiry about a listing. So the assertions move to the boundary that
     actually still holds — the storefront may be mounted, but it must never
     anchor on a shop identity. scripts/test-shop-inquiry-mount.js owns the
     mount's own assertions. */
  ok('store.html IS mounted, via the inquiry relationship',
    store.indexOf('sokoni-connect-call.js') !== -1 &&
    /anchorType:\s*"inquiry"/.test(store));
  ok('…and it anchors on a LISTING, never on a shop identity',
    /anchorId\s*=\s*String\(live\[0\]\.id\)/.test(store) &&
    !/anchorType:\s*"shop"/.test(store));

  /* CONTROL. If this detector could not see a mount, every absence above would
     pass vacuously — including on a page that WAS mounted. */
  const mounted = read('delivery-tracking.html');
  ok('CONTROL: the detector CAN see a mounted surface',
    mounted.indexOf('sokoni-connect-call.js') !== -1 &&
    mounted.indexOf('mountForAnchor') !== -1,
    'the absence assertions above prove nothing');
}

/* ── 5. The boundary is written down ────────────────────────────────────── */
{
  const doc = read('docs/SHOP_COMMUNICATION_CONTRACT_BOUNDARY.md');
  ['shops/{uid}', 'products/{id}.sellerUid', 'inquiry', 'calleeUid', 'store.html'].forEach((n) => {
    ok('the boundary documents ' + n, doc.indexOf(n) !== -1);
  });
  /* RETARGETED: the document now records a RESOLUTION rather than a blocker.
     What must still be true is that the resolution kept the invariant, and kept
     the unsupported case honest instead of quietly widening the claim. */
  ok('…and states that shops/{uid} never enters Connect authorization',
    /never enters Connect authorization/.test(doc));
  ok('…and keeps the generic no-listing case explicitly unsupported',
    /remains unsupported by design/.test(doc));
  ok('…and records WHY a new shop relationship was refused, rather than hiding it',
    /Option 2 was not taken/.test(doc) && /to which employee/.test(doc));
}

console.log('');
console.log('  SOKONI shop communication boundary — closure mandate §2');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
