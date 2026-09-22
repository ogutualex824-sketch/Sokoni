#!/usr/bin/env node
/* ============================================================================
   SOKONI — "Message Shop" is an inquiry about a listing
   ============================================================================
   The storefront offers shop-level communication WITHOUT shops/{uid} ever
   entering Connect authorization. The buyer reads "Message shop"; the
   relationship recorded is buyer <-> seller about a listing.

   The property that makes this safe, and that this gate holds:

       the client supplies a PRODUCT, and the SERVER derives the person.

   A client that lies about the product simply reaches that product's seller
   about that product — which `inquiry` already permits. It cannot reach a
   person of its choosing, because it never names one.
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

function stripAll(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const rawStore = read('store.html');
const store = stripAll(rawStore);
ok('CONTROL: the stripped storefront is readable', store.indexOf('_mountShopInquiry') !== -1);
ok('CONTROL: stripping removed prose', store.length < rawStore.length * 0.97);

/* ── 1. It is mounted, and it is an inquiry ─────────────────────────────── */
ok('the storefront loads the Connect action module',
  rawStore.indexOf('sokoni-connect-call.js') !== -1);
ok('a slot exists', store.indexOf('id="stConnectActions"') !== -1);
ok('it mounts through the server-driven path',
  store.indexOf('SokoniConnectCall.mountForAnchor') !== -1);
ok('the anchor type is inquiry, the EXISTING relationship',
  /anchorType:\s*"inquiry"/.test(store));
ok('it reaches the server through connectDispatch',
  store.indexOf('sokoniCallable("connectDispatch")') !== -1);

/* ── 2. shops/{uid} NEVER enters Connect ────────────────────────────────── */
ok('the anchor is a PRODUCT id, never the shop id',
  /anchorId\s*=\s*String\(live\[0\]\.id\)/.test(store));
ok('the storefront uid is never used as an anchor',
  !/anchorId[^;\n]*\b(uid|storeId|storeParm)\b/.test(store));
{
  /* The mount block must not reference the shop identity at all. */
  const fn = store.slice(store.indexOf('function _mountShopInquiry'),
    store.indexOf('function _mountShopInquiry') + 1600);
  ok('the mount function names no uid', !/\buid\b|storeId/.test(fn), 'leaked an identity');
  ok('the mount function names no shops collection', fn.indexOf('shops') === -1);
}
{
  const calls = read('functions/connect-calls.js');
  ok('no Connect anchor resolves shops/{uid}',
    !/collection\('shops'\)\.doc\(anchorId\)/.test(calls));
  ok('the inquiry anchor derives the seller from the LISTING',
    /_anchorInquiry[\s\S]{0,600}p\.sellerUid/.test(calls));
}

/* ── 3. The choice of listing cannot change the recipient ───────────────── */
/* fsProds comes from where("sellerUid","==",uid), so every listing on the page
   derives the SAME seller. That is why picking the first is not arbitrary in
   any way that matters. */
ok('the page loads listings filtered BY sellerUid',
  /where\("sellerUid",\s*"==",\s*uid\)/.test(store));
ok('the mount is fed exactly those listings', /_mountShopInquiry\(fsProds\)/.test(store));

/* ── 4. A shop with nothing live gets no button ─────────────────────────── */
ok('closed/draft listings are excluded', /CLOSED\s*=\s*\[/.test(store));
ok('no live listing clears the slot rather than drawing a dead control',
  /if \(!live\.length\) \{ slot\.innerHTML = ""/.test(store));
ok('a listing with no id cannot become an anchor', /p && p\.id/.test(store));
ok('re-render does not re-mount the same anchor', /_shopInquiryMountedFor/.test(store));

/* ── 5. roleLabel is PRESENTATION ONLY ──────────────────────────────────── */
{
  const mod = stripAll(read('sokoni-connect-call.js'));
  ok('CONTROL: the module is readable', mod.indexOf('mountForAnchor') !== -1);
  ok('roleLabel replaces only the displayed noun',
    /var noun = o\.roleLabel \? String\(o\.roleLabel\) : String\(a\.label \|\| a\.targetRole\)/.test(mod));
  ok('the VERB still comes from the server-allowed channel',
    /var verb = ch === 'voice' \? 'Call' : 'Message'/.test(mod));
  ok('the CHANNELS still come from the server response',
    /\(a\.channels \|\| \[\]\)\.map/.test(mod));

  /* The property that matters: a label cannot change who is contacted. The
     request payload is built from targetRole + channel, both server-supplied. */
  ok('roleLabel never reaches the request payload',
    mod.indexOf('roleLabel') !== -1 &&
    !/roleLabel[^\n]*(anchorId|targetRole|channel)\s*:/.test(mod));
  ok('the storefront passes a NOUN, not a recipient', /roleLabel:\s*"Shop"/.test(store));
}

/* ── 6. The documented limit still holds ────────────────────────────────── */
{
  const doc = read('docs/SHOP_COMMUNICATION_CONTRACT_BOUNDARY.md');
  ok('the boundary document records the resolution',
    /inquiry/.test(doc) && /shops\/\{uid\}/.test(doc));
  ok('a generic shop message with NO listing is still unsupported, and said so',
    /no listings|without a listing|has no listings/i.test(doc));
}

console.log('');
console.log('  SOKONI "Message Shop" via inquiry — closure mandate §3');
console.log('  ' + '-'.repeat(60));
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
console.log('');
process.exit(failures.length ? 1 : 0);
