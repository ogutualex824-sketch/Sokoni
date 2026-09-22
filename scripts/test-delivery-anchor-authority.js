#!/usr/bin/env node
/* ============================================================================
   SOKONI — the delivery anchor is packageRequests, and nothing else
   ============================================================================
   §2 of the closure mandate. Two collections in this repository are called
   something like "deliveries". They are DIFFERENT PRODUCTS, and the danger is
   not that a wrong choice fails loudly — it is that it succeeds quietly against
   an unrelated document and authorizes a conversation between strangers.

   This gate proves the choice was made on evidence, and that the evidence still
   holds. It reads source, not fixtures: if someone repoints the resolver, these
   assertions go red.
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

/* Comments in these files DISCUSS both collections at length, so asserting on
   raw text would assert against the prose explaining the decision. */
function stripComments(src) {
  let out = '', i = 0, mode = 'code', quote = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i++; continue; }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'str') {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === quote) mode = 'code';
      out += c; i++; continue;
    }
  }
  return out;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => stripComments(read(rel));

/* ========================================================================== */
/* 1. THE RESOLVER READS THE AUTHORITATIVE COLLECTION                         */
/* ========================================================================== */
{
  const cc = code('functions/connect-calls.js');
  ok('CONTROL: the stripped resolver is readable', cc.indexOf('_anchorDelivery') !== -1);

  ok('the delivery anchor resolves packageRequests',
    cc.indexOf("collection('packageRequests').doc(anchorId)") !== -1);
  ok('the delivery anchor no longer resolves the hub collection by document id',
    cc.indexOf("collection('deliveries').doc(anchorId)") === -1);
  ok('the reported anchorType names the authoritative collection',
    cc.indexOf("anchorType: 'packageRequests'") !== -1);
  ok('…and no longer claims the hub collection',
    cc.indexOf("anchorType: 'deliveries'") === -1);

  /* The bug that made every delivery anchor refuse every caller. */
  ok('resolveActor is called with NAMED arguments',
    cc.indexOf('resolveActor({ uid: callerUid') !== -1);
  ok('…and never positionally (uid would arrive undefined and refuse everyone)',
    cc.indexOf('resolveActor(callerUid,') === -1);
}

/* ========================================================================== */
/* 2. THE TWO KEY SPACES ARE DISJOINT — AND THAT IS WHY IT MATTERS            */
/* ========================================================================== */
{
  /* Marketplace ids are "DEL" + apiRef, minted server-side and deterministic so
     the write is idempotent. Hub refs are 'DEL-' + base36 time, minted in the
     browser. The hyphen separates them, but the POINT is not the hyphen — it is
     that neither generator has any knowledge of the other, so nothing prevents
     a future collision. The resolver must therefore not depend on the shape of
     the id at all; it depends on the COLLECTION. */
  const hub = code('delivery-hub.js');
  const idx = code('functions/index.js');

  ok('the hub mints its own ref in the browser', /'DEL-'\s*\+/.test(hub));
  ok('the marketplace mints a DIFFERENT, deterministic id server-side',
    idx.indexOf('"DEL" + apiRef') !== -1);
  ok('the hub writes the top-level deliveries collection from the client',
    /addDoc\(collection\(db,\s*'deliveries'\)/.test(hub));
  ok('the hub document is addressed by a deliveryRef FIELD, not by its id',
    /where\('deliveryRef',\s*'==',\s*deliveryRef\)/.test(hub));

  /* THE HAZARD, stated as an assertion: the resolver must not try to recover
     from a wrong-collection id by guessing at its shape. A `DEL-` prefix check
     would look like a safety net and would become a silent aliasing rule. */
  const cc = code('functions/connect-calls.js');
  ok('the resolver does NOT sniff the id shape to pick a collection',
    cc.indexOf("startsWith('DEL-')") === -1 && cc.indexOf('/^DEL-/') === -1);
  ok('the resolver does not fall back to a second collection on a miss',
    cc.indexOf('Delivery not found') !== -1 &&
    cc.split('Delivery not found')[0].indexOf("collection('deliveries')") === -1);
}

/* ========================================================================== */
/* 3. A HUB ID CANNOT AUTHORIZE AGAINST AN UNRELATED DOCUMENT                 */
/* ========================================================================== */
{
  /* The mandate's required regression, executed rather than asserted on text.
     A fake Firestore holds ONE document in each collection under the SAME id —
     the worst case, where a wrong-collection lookup would succeed. */
  const HUB_PARTIES = { senderUid: 'sender_A', assignedRiderId: 'rider_H' };
  const PKG_PARTIES = { buyerUid: 'buyer_B', sellerUid: 'seller_S', assignedDriverId: 'rider_P' };
  const SHARED_ID = 'DEL-COLLIDE1';

  const store = {
    deliveries: { [SHARED_ID]: Object.assign({ status: 'in_transit' }, HUB_PARTIES) },
    packageRequests: { [SHARED_ID]: Object.assign({ status: 'in_transit' }, PKG_PARTIES) },
  };

  const DA = require(path.join(ROOT, 'functions', 'delivery-authority.js'));

  /* The resolver's own rule, applied to whichever document a collection choice
     produces. This is the question the mandate asks: does an id from the
     non-authoritative collection authorize someone it should not? */
  const actorIn = (collection, uid) =>
    DA.resolveActor({ uid, delivery: store[collection][SHARED_ID], order: null });

  ok('the hub SENDER is a party to the hub document only in name',
    actorIn('deliveries', 'sender_A') === null,
    'senderUid is in no field list — the hub sender has no marketplace role');
  ok('CONTROL: the hub RIDER does resolve, so the resolver is not simply refusing everything',
    actorIn('deliveries', 'rider_H') === 'rider');

  /* THE ACTUAL HAZARD. */
  ok('a marketplace buyer is NOT a party to the hub document under the same id',
    actorIn('deliveries', 'buyer_B') === null);
  ok('a hub rider is NOT a party to the marketplace document under the same id',
    actorIn('packageRequests', 'rider_H') === null);
  ok('CONTROL: the marketplace parties DO resolve against their own document',
    actorIn('packageRequests', 'buyer_B') === 'buyer' &&
    actorIn('packageRequests', 'seller_S') === 'seller' &&
    actorIn('packageRequests', 'rider_P') === 'rider');

  /* If the resolver read the wrong collection, rider_H would have been
     authorized to call buyer_B — two strangers, bound by nothing but a
     coincidence of identifier. That is the failure this gate exists to catch. */
  ok('SAFETY: hub rider and marketplace buyer are never party to one document',
    actorIn('deliveries', 'buyer_B') === null && actorIn('packageRequests', 'rider_H') === null);
}

/* ========================================================================== */
/* 4. THE FROZEN AUTHORITY AGREES, AND IS NOT AMENDED                         */
/* ========================================================================== */
{
  const CA = require(path.join(ROOT, 'functions', 'shared', 'connect-authority.js'));
  const pairs = CA.RELATIONSHIPS.delivery.pairs.slice().sort().join(',');
  ok('the delivery relationship binds the rider to BOTH ends of the job',
    pairs === 'rider:buyer,rider:seller', pairs);
  ok('…which is the marketplace shape (buyer, seller, rider), not the hub shape',
    CA.RELATIONSHIPS.delivery.describe.indexOf('both ends') !== -1,
    CA.RELATIONSHIPS.delivery.describe);

  /* The hub would need a role that does not exist. Adding one would amend a
     FROZEN contract, so courier communication stays a documented gap. */
  ok('there is no sender role, so hub courier cannot be aliased into delivery',
    CA.ROLES.indexOf('sender') === -1, CA.ROLES.join(','));
  ok('CONTROL: the roles that DO exist are readable', CA.ROLES.indexOf('rider') !== -1);
  ok('no rider:sender pair was quietly added to the frozen relationship',
    CA.RELATIONSHIPS.delivery.pairs.every((p) => p.indexOf('sender') === -1));
}

/* ========================================================================== */
/* 5. THE DECISION IS WRITTEN DOWN                                            */
/* ========================================================================== */
{
  const doc = read('docs/DELIVERY_ANCHOR_AUTHORITY.md');
  ['packageRequests', 'deliveries', 'delivery-hub.js', 'senderUid', 'deliveryRef'].forEach((n) => {
    ok('the finding documents ' + n, doc.indexOf(n) !== -1);
  });
  ok('…and records that courier communication is a GAP, not a feature',
    /not mounted|gap/i.test(doc));
}

console.log('');
console.log('  SOKONI delivery anchor authority — closure mandate §2');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
