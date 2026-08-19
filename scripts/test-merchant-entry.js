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
    location: (() => {
      /* Every assignment is recorded. This is what makes "ONE direct navigation"
         assertable at all: the final value alone cannot distinguish a direct hop from
         a redirect chain that happened to end in the right place. */
      const nav = [];
      const o = { _navs: nav };
      Object.defineProperty(o, 'href', {
        get() { return nav.length ? nav[nav.length - 1] : ''; },
        set(v) { nav.push(String(v)); },
      });
      return o;
    })(),
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
  ck('signed out -> /login', (await load({ signedOut: true }).api.resolve()).destination === '/login');

  head('2 - a buyer gets the legitimate application flow');
  {
    const r = await load({ approved: ['buyer'] }).api.resolve();
    ck('buyer -> intake (/offer)', r.destination === '/offer', r.destination);
    ck('state is not-approved', r.state === 'not-approved', r.state);
  }

  head('3 - approved seller: shop decides only WHERE');
  {
    const withShop = load({ approved: ['buyer', 'seller'],
      docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { status: 'active' } } });
    const r = await withShop.api.resolve();
    ck('approved + canonical shop -> /merchant-v2', r.destination === '/merchant-v2', r.destination);
    ck('resolved via the canonical chain', r.via === 'activeShopId', r.via);
    ck('read users/{uid} then shops/{activeShopId}', withShop.reads.join(' ') === 'users/u1 shops/shopA', withShop.reads.join(' '));

    const fallback = load({ approved: ['seller'], docs: { 'users/u1': {}, 'shops/u1': { status: 'active' } } });
    const rf = await fallback.api.resolve();
    ck('no activeShopId -> shops/{uid} fallback -> /merchant-v2', rf.destination === '/merchant-v2', rf.destination);
    ck('fallback source recorded', rf.via === 'shops/{uid}', rf.via);

    const noShop = load({ approved: ['seller'], docs: { 'users/u1': {} } });
    const rn = await noShop.api.resolve();
    ck('approved + NO shop -> /merchant-v2#shop (setup)', rn.destination === '/merchant-v2#shop', rn.destination);
    ck('approved + NO shop is NOT sent to intake', rn.destination !== '/offer');
    ck('state names it', rn.state === 'approved-no-shop', rn.state);

    const unreadable = load({ approved: ['seller'], throwOnRead: true });
    const ru = await unreadable.api.resolve();
    ck('shop unreadable -> setup, never re-apply', ru.destination === '/merchant-v2#shop', ru.destination);
    ck('unreadable state is distinguished', ru.state === 'approved-shop-unknown', ru.state);
  }

  head('4 - NEGATIVE CONTROL: activeRole alone is not entitlement');
  {
    const forged = load({ approved: ['buyer'], activeRole: 'seller',
      docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { status: 'active' } } });
    const r = await forged.api.resolve();
    ck('activeRole=seller without the claim -> intake', r.destination === '/offer', r.destination);
    ck('...even with a real shop present', r.state === 'not-approved', r.state);
    ck('the shop was never even read', forged.reads.length === 0, forged.reads.join(','));
  }

  head('5 - NEGATIVE CONTROL: sellers/{uid} cannot manufacture entry');
  {
    const selfWritten = load({ approved: ['buyer'],
      docs: { 'sellers/u1': { status: 'active' }, 'users/u1': {}, 'shops/u1': { status: 'active' } } });
    const r = await selfWritten.api.resolve();
    ck('applicant-written sellers/{uid} -> still intake', r.destination === '/offer', r.destination);
    ck('sellers/{uid} was never read', selfWritten.reads.indexOf('sellers/u1') < 0, selfWritten.reads.join(','));
  }

  head('6 - no authority is present when RA is missing');
  {
    const r = await load({ noRA: true, docs: { 'shops/u1': {} } }).api.resolve();
    ck('no Role Authority -> intake, never merchant', r.destination === '/offer', r.destination);
    /* The half that actually matters: absent authority must fail CLOSED. */
    ck('...and specifically not the merchant shell', r.destination.indexOf('merchant') === -1, r.destination);
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
  head('9 - Start Selling cutover: the destination a real tap reaches');

  /* Expected destinations are DECLARED here, not read back from the module. Deriving them
     from DESTINATIONS would compare the module to itself and pass for any routing at all. */
  const WANT = { approved: '/merchant-v2', unapproved: '/offer', signedOut: '/login' };

  {
    const env = load({ approved: ['seller'], docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { name: 'KASS' } } });
    const r = await env.api.go();
    ck('approved seller -> ' + WANT.approved, r.destination === WANT.approved, r.destination);
    /* THE assertion this section exists for. */
    ck('...in exactly ONE navigation', env.g.location._navs.length === 1, JSON.stringify(env.g.location._navs));
    ck('...with no intermediate /offer hop', !env.g.location._navs.some((u) => u.indexOf('/offer') > -1), JSON.stringify(env.g.location._navs));
    ck('...and no intermediate onboarding-seller hop', !env.g.location._navs.some((u) => /onboarding-seller/.test(u)), JSON.stringify(env.g.location._navs));
    ck('...and it is a clean route, so no 301 on the way in', !/\.html/.test(env.g.location._navs[0] || ''), env.g.location._navs[0]);
  }

  {
    const env = load({ approved: [], docs: { 'shops/u1': { name: 'KASS' } } });
    const r = await env.api.go();
    ck('authenticated but UNAPPROVED -> ' + WANT.unapproved, r.destination === WANT.unapproved, r.destination);
    ck('...in exactly one navigation', env.g.location._navs.length === 1, JSON.stringify(env.g.location._navs));
    ck('...and never reaches the merchant shell', !env.g.location._navs.some((u) => u.indexOf('merchant') > -1), JSON.stringify(env.g.location._navs));
  }

  {
    const env = load({ signedOut: true });
    const r = await env.api.go();
    ck('signed out -> ' + WANT.signedOut, r.destination === WANT.signedOut, r.destination);
    ck('...and never reaches the merchant shell', !env.g.location._navs.some((u) => u.indexOf('merchant') > -1), JSON.stringify(env.g.location._navs));
  }

  /* FORGED client-controlled signals must not buy entry. Each of these is settable by the
     client, so each must be ignored in favour of the role-authority claim. */
  for (const forged of [
    { name: 'activeRole=seller', env: { approved: [], activeRole: 'seller' } },
    { name: 'applicant-written sellers/{uid}', env: { approved: [], docs: { 'sellers/u1': { status: 'approved' } } } },
    { name: 'registeredAs.seller on users/{uid}', env: { approved: [], docs: { 'users/u1': { registeredAs: { seller: true }, activeShopId: 'shopA' }, 'shops/shopA': { name: 'KASS' } } } },
    { name: 'isSeller flag on users/{uid}', env: { approved: [], docs: { 'users/u1': { isSeller: true, approved: true } } } },
  ]) {
    const env = load(forged.env);
    const r = await env.api.go();
    ck('forged ' + forged.name + ' -> ' + WANT.unapproved, r.destination === WANT.unapproved, r.destination);
    ck('...never reaches the merchant shell', !env.g.location._navs.some((u) => u.indexOf('merchant') > -1), JSON.stringify(env.g.location._navs));
  }

  /* Negative control: the matrix above must be capable of failing. If the module ever
     stopped navigating at all, every "never reaches the merchant shell" row would pass
     vacuously — so prove a navigation is actually recorded. */
  {
    const env = load({ approved: ['seller'], docs: { 'users/u1': { activeShopId: 'shopA' }, 'shops/shopA': { name: 'KASS' } } });
    await env.api.go();
    ck('NC the harness really records navigations', env.g.location._navs.length > 0, JSON.stringify(env.g.location._navs));
    ck('NC ...and the recorded value is the destination', env.g.location.href === WANT.approved, env.g.location.href);
  }

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
