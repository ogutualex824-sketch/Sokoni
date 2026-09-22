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
  /* The rules are the enforcement boundary, and they name the wildcard `uid`. */
  ok('the rules key a shop document by uid', /match \/shops\/\{uid\}/.test(rules));
  const shopBlock = rules.slice(rules.indexOf('match /shops/{uid}'),
    rules.indexOf('match /shops/{uid}') + 700);
  ok('…and enforce ownership as request.auth.uid == uid',
    /request\.auth\.uid == uid/.test(shopBlock));
  ok('…while shop documents are WORLD-READABLE, so shop ids are enumerable',
    /allow read:\s*if true/.test(shopBlock));

  /* The storefront says so in as many words. */
  const store = read('store.html');
  ok('the storefront identifier is a seller uid',
    /params\.get\("id"\)/.test(store) && /Firebase seller UID/.test(store));
  ok('…and the storefront queries products by that uid as sellerUid',
    /where\("sellerUid",\s*"==",\s*uid\)/.test(store));

  /* The existing canonical resolvers were reused, not duplicated. */
  const adminOs = read('functions/admin-os.js');
  ok('an ownership resolver already exists and was not re-written',
    /_shopOwner = \(x\) => \(x && \(x\.ownerId \|\| x\.sellerUid \|\| x\.uid\)\)/.test(adminOs));
  ok('…and it deliberately refuses to assume shopId = uid',
    adminOs.indexOf('never to `shopId = uid`') !== -1);
  ok('the merchant identity module resolves sellerUid -> shops/{uid}',
    read('functions/shared/merchant-identity.js').indexOf('shops/{uid}') !== -1);
}

/* ── 4. THE ABSENCE, WITH A POSITIVE CONTROL ────────────────────────────── */
{
  const store = read('store.html');
  ok('store.html is NOT mounted for Connect actions',
    store.indexOf('sokoni-connect-call.js') === -1);
  ok('…and asks the server for no available actions',
    store.indexOf('connectAvailableActions') === -1 &&
    store.indexOf('mountForAnchor') === -1);

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
  ok('…and states that shop communication is NOT claimed',
    /not claimed|NOT MOUNTED/.test(doc));
  ok('…and names the decision required rather than making it',
    /authority-contract change|is not taken here/.test(doc));
}

console.log('');
console.log('  SOKONI shop communication boundary — closure mandate §2');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
