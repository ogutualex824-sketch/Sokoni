#!/usr/bin/env node
/* Merchant entry: entitlement decides ACCESS, shop existence decides only DESTINATION.
 *
 *   npm run test:merchant:entry
 *
 * THE LOOP THIS CLOSES
 * Every Start Selling CTA was an unconditional anchor to seller.html, so an already-approved
 * merchant landed on "Ready to Start Selling? Become a seller on SOKONI" — approved, then told
 * to apply again. Nine CTAs now converge on ONE resolver.
 *
 * THE INVARIANT
 *   entitlement = RA.isApproved('seller')          <- the ONLY access test
 *   destination = canonical shop resolution         <- routing, never authority
 * An approved seller with no shop is still approved: they get shop SETUP, never the
 * application. Sections 4-5 are the negative controls — neither a forged activeRole nor a
 * self-written sellers/{uid} can manufacture entry, because neither is ever read.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n-- ' + t + ' --');

const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-entry.js'), 'utf8');
const IMPORT_RE = /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-firestore\.js'\)/g;
const STUB = 'await global.__FS()';

/* Load the REAL module against stubbed Firestore + authority. */
function load(o) {
  o = o || {};
  const reads = [];
  const fsMod = {
    doc: (db, col, id) => ({ col, id }),
    getDoc: async (ref) => {
      reads.push(ref.col + '/' + ref.id);
      if (o.throwOnRead) throw new Error('permission-denied');
      const store = o.docs || {};
      const key = ref.col + '/' + ref.id;
      const data = store[key];
      return { exists: () => data !== undefined, id: ref.id, data: () => data };
    },
  };
  const g = {
    firebaseDB: {},
    firebaseAuth: o.signedOut ? { currentUser: null } : { currentUser: { uid: o.uid || 'u1' } },
    SokoniRoleAuthority: o.noRA ? undefined : {
      ready: async () => true,
      isApproved: (r) => (o.approved || []).indexOf(r) > -1,
      getActiveRole: () => o.activeRole || 'buyer',
    },
    __FS: async () => fsMod,
    location: { href: '' },
    document: { readyState: 'complete', addEventListener() {} },
  };
  const patched = SRC.replace(IMPORT_RE, STUB);
  if (patched === SRC) throw new Error('harness rewrite did not apply — module shape changed');
  new Function('window', 'global', 'document', patched)(g, g, g.document);
  return { api: g.SokoniMerchantEntry, reads, g };
}

(async () => {
  head('0 - harness integrity');
  const base = load({ approved: [] });
  ck('module exposes the resolver', !!(base.api && base.api.resolve && base.api.go));
  ck('the SDK import was really stubbed', SRC.replace(IMPORT_RE, STUB).includes(STUB));
  ck('sellers/{uid} appears nowhere in the module logic',
     !/getDoc\([\s\S]{0,80}'sellers'/.test(SRC) && !/doc\(db, 'sellers'/.test(SRC));

  head('1 - signed out');
  ck('signed out -> login.html', (await load({ signedOut: true }).api.resolve()).destination === 'login.html');

  head('2 - a buyer gets the legitimate application flow');
  {
    const r = await load({ approved: ['buyer'] }).api.resolve();
    ck('buyer -> intake (profile.html)', r.destination === 'profile.html', r.destination);
    ck('state is not-approved', r.state === 'not-approved', r.state);
  }

  head('3 - approved seller: shop decides only WHERE');
  {
    const withShop = load({ approved: ['buyer', 'seller'],
      docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { status: 'active' } } });
    const r = await withShop.api.resolve();
    ck('approved + canonical shop -> merchant.html', r.destination === 'merchant.html', r.destination);
    ck('resolved via the canonical chain', r.via === 'activeShopId', r.via);
    ck('read users/{uid} then shops/{activeShopId}', withShop.reads.join(' ') === 'users/u1 shops/shopA', withShop.reads.join(' '));

    const fallback = load({ approved: ['seller'], docs: { 'users/u1': {}, 'shops/u1': { status: 'active' } } });
    const rf = await fallback.api.resolve();
    ck('no activeShopId -> shops/{uid} fallback -> merchant.html', rf.destination === 'merchant.html', rf.destination);
    ck('fallback source recorded', rf.via === 'shops/{uid}', rf.via);

    const noShop = load({ approved: ['seller'], docs: { 'users/u1': {} } });
    const rn = await noShop.api.resolve();
    ck('approved + NO shop -> merchant.html#shop (setup)', rn.destination === 'merchant.html#shop', rn.destination);
    ck('approved + NO shop is NOT sent to intake', rn.destination !== 'profile.html');
    ck('state names it', rn.state === 'approved-no-shop', rn.state);

    const unreadable = load({ approved: ['seller'], throwOnRead: true });
    const ru = await unreadable.api.resolve();
    ck('shop unreadable -> setup, never re-apply', ru.destination === 'merchant.html#shop', ru.destination);
    ck('unreadable state is distinguished', ru.state === 'approved-shop-unknown', ru.state);
  }

  head('4 - NEGATIVE CONTROL: activeRole alone is not entitlement');
  {
    const forged = load({ approved: ['buyer'], activeRole: 'seller',
      docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { status: 'active' } } });
    const r = await forged.api.resolve();
    ck('activeRole=seller without the claim -> intake', r.destination === 'profile.html', r.destination);
    ck('...even with a real shop present', r.state === 'not-approved', r.state);
    ck('the shop was never even read', forged.reads.length === 0, forged.reads.join(','));
  }

  head('5 - NEGATIVE CONTROL: sellers/{uid} cannot manufacture entry');
  {
    const selfWritten = load({ approved: ['buyer'],
      docs: { 'sellers/u1': { status: 'active' }, 'users/u1': {}, 'shops/u1': { status: 'active' } } });
    const r = await selfWritten.api.resolve();
    ck('applicant-written sellers/{uid} -> still intake', r.destination === 'profile.html', r.destination);
    ck('sellers/{uid} was never read', selfWritten.reads.indexOf('sellers/u1') < 0, selfWritten.reads.join(','));
  }

  head('6 - no authority is present when RA is missing');
  {
    const r = await load({ noRA: true, docs: { 'shops/u1': {} } }).api.resolve();
    ck('no Role Authority -> intake, never merchant', r.destination === 'profile.html', r.destination);
  }

  head('7 - all nine CTAs converge on the one resolver');
  {
    const files = ['index.html', 'community.html', 'marketing.html', 'category.js', 'script.js', 'sokoni-spotlight.js'];
    let wired = 0;
    files.forEach((f) => {
      wired += (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/data-sk-merchant-entry/g) || []).length;
    });
    ck('exactly 9 CTAs wired', wired === 9, wired);
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ck('excluded: Start Selling / Offering (offer.html) untouched',
       /<a href="offer\.html" class="glass-btn-green"/.test(idx));
    ck('excluded: Apply for Verification untouched', /<a href="seller\.html" class="gv-cta">/.test(idx));
    const sc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
    ck('excluded: the anchor with its own onclick untouched',
       /<a href="seller\.html" onclick="this\.closest/.test(sc));
    ck('no page renders a wired CTA without the resolver loaded',
       ['index.html', 'community.html', 'marketing.html', 'category.html']
         .every((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('sokoni-merchant-entry.js')));
    ck('the dynamic spotlight CTA uses the delegated path (no inline handler)',
       /data-sk-merchant-entry href="seller\.html" class="seller-visit-btn green-btn"/
         .test(fs.readFileSync(path.join(ROOT, 'sokoni-spotlight.js'), 'utf8')));
    ck('the module delegates on document', /addEventListener\('click'/.test(SRC));
    ck('one resolver, not nine snippets', (SRC.match(/function resolve\(\)/g) || []).length === 1);
  }

  head('8 - entry never mutates authority');
  ck('no claim writes', !/setCustomUserClaims|getIdTokenResult/.test(SRC));
  ck('no application creation', !/addDoc|applications/.test(SRC));
  ck('no shop creation', !/setDoc|updateDoc|deleteDoc/.test(SRC));
  ck('reads only', !/\.set\(|\.update\(|\.delete\(/.test(SRC));

  head('9 - admin boundary is documented, not implemented');
  ck('module states admin stays with sokoni-permissions.js', /sokoni-permissions\.js/.test(SRC));
  /* Comment-stripped: the header documents the boundary by naming GUARDED_ROUTES -> admin.html,
     so the raw-source form of this check fired on the documentation it was verifying. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('module CODE adds no admin destination', !/admin\.html/.test(CODE));
  ck('control: the stripped detector still catches a real one',
     /admin\.html/.test(CODE + "\nvar x = 'admin.html';"));
  ck('control: stripping left the resolver intact', /function resolve\(\)/.test(CODE));

  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
