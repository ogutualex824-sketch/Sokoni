#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC DIRECTORY PROJECTION — shops/, not businesses/
   scripts/test-directory-shops-projection.js
   ══════════════════════════════════════════════════════════════════════════════
   `businesses/{businessId}` is the TENANT record — its document id keys businessWallets.
   `shops/{storeId}` is the STOREFRONT. A public business directory lists storefronts, so it
   reads shops.

   THE ACCEPTANCE CRITERION IS A NEGATIVE: the directory must no longer depend on a
   newly-created `businesses/{uid}` record. C3 denies that write, so a directory still reading
   `businesses` would quietly stop gaining entries — the exact silent regression this repoint
   exists to prevent.

   THE OTHER PROPERTY IS ALSO A NEGATIVE: the projection must INVENT NOTHING. `verified` is
   admin-set and its authoritative home is an OPEN sub-gate, so a shop that does not carry it
   must project to `undefined` — never to `false`, which would assert a verification status no
   one recorded.

   Runs the REAL `bdProjectShop`, extracted from the shipped page — not a re-implementation,
   which would pass while the page shipped something else.

   Run through:  npm run test:directory:projection
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, failed = 0;
const ck = (n, ok, d) => { (ok ? pass++ : failed++); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

const HTML = read('businesses.html');
const MODULE = (HTML.match(/<script type="module">([\s\S]*?)<\/script>/) || ['', ''])[1];

/* Extract the real projection function and run it. */
const fnSrc = (MODULE.match(/function bdProjectShop\(id, s\) \{[\s\S]*?\n\}/) || [''])[0];
const sandbox = { console };
vm.createContext(sandbox);
if (fnSrc) vm.runInContext(fnSrc + '\nglobalThis.__p = bdProjectShop;', sandbox);
const project = sandbox.__p;

/* The three real production shop shapes, transcribed 2026-09-20. */
const KASS = { name: 'KASS SHOP', shopName: 'KASS SHOP', city: 'nairobi',
  tagline: 'A WHOLESELLER SHOP', status: 'active', active: true, handle: 'kassshop',
  sellerUid: 'D5Ql2EYr95bt79IpcGTmOMTK0P83', createdAt: {} };
const PROBE = { name: 'ZZ Probe Shop 117114', category: 'electronics', city: 'nairobi',
  tagline: 'tagline-1171', status: 'active', sellerUid: 'EmV3RXLmPmVE8TWRBlg3u7WKopp1', createdAt: {} };
const STORE = { name: 'SOKONI Store', firstParty: true, ownerId: 'vbaSOKL4h8WWGqa6Xfi1eLaEPnS2', createdAt: {} };

(async () => {
  console.log('\n══ PUBLIC DIRECTORY — projected from shops/ ══');

  head('0 - the real function was extracted, not re-implemented');
  {
    ck('bdProjectShop found in the shipped page', !!fnSrc && fnSrc.length > 200, fnSrc.length + ' chars');
    ck('...and it is callable', typeof project === 'function');
    ck('CONTROL: the extractor would notice it vanishing',
      (MODULE.match(/bdProjectShop/g) || []).length >= 2, 'definition + call site');
  }

  head('A - the directory reads shops, and no longer reads businesses');
  {
    ck('the query names the shops collection', /collection\(_db, 'shops'\)/.test(MODULE));
    ck('*** it no longer reads businesses ***',
      !/collection\(_db, 'businesses'\)/.test(MODULE),
      'the acceptance criterion: no dependency on a newly-created businesses/{uid}');
    ck('the load maps through the projection',
      /snap\.docs\.map\(d => bdProjectShop\(d\.id, d\.data\(\) \|\| \{\}\)\)/.test(MODULE));
    /* CONTROL — the detector must be able to SEE a businesses read if one returns. */
    ck('CONTROL: the businesses detector fires on a fabricated line',
      /collection\(_db, 'businesses'\)/.test("collection(_db, 'businesses')"),
      'the absence above is measured, not assumed');
  }

  head('B - fields the shop carries are mapped');
  {
    const k = project('D5Ql2EYr95bt79IpcGTmOMTK0P83', KASS);
    ck('id is the shop document id', k.id === 'D5Ql2EYr95bt79IpcGTmOMTK0P83');
    ck('name prefers shopName', k.name === 'KASS SHOP');
    ck('tagline maps', k.tagline === 'A WHOLESELLER SHOP');
    ck('location falls back to city', k.location === 'nairobi', k.location);
    ck('county falls back to city too', k.county === 'nairobi',
      'shops carry a city, this page filters on either — a name mapping, not a new contract');
    ck('handle carried', k.handle === 'kassshop');

    const p = project('EmV3RXLmPmVE8TWRBlg3u7WKopp1', PROBE);
    ck('category maps when present', p.category === 'electronics');
    ck('name falls back to name when shopName is absent', p.name === 'ZZ Probe Shop 117114');
  }

  head('C - THE PROJECTION INVENTS NOTHING');
  {
    for (const [label, shop] of [['KASS', KASS], ['ZZ Probe', PROBE], ['SOKONI Store', STORE]]) {
      const r = project('x', shop);
      ck(label + ': verified is UNDEFINED, not false',
        r.verified === undefined,
        'false would assert a verification status nobody recorded');
      ck(label + ': avgRating is undefined, not 0', r.avgRating === undefined);
      ck(label + ': followerCount is undefined, not 0', r.followerCount === undefined);
    }
    /* INVERTING CONTROL — if the field IS present it must pass straight through, or the
       three assertions above would pass against a function that drops it entirely. */
    const v = project('x', Object.assign({}, KASS, { verified: true, avgRating: 4.5, followerCount: 12 }));
    ck('CONTROL: a shop that DOES carry verified passes it through', v.verified === true);
    ck('CONTROL: ...and avgRating', v.avgRating === 4.5);
    ck('CONTROL: ...and followerCount', v.followerCount === 12);
  }

  head('D - absent text fields become empty strings, not undefined');
  {
    /* The page calls .toLowerCase() on these while filtering; undefined would throw. */
    const s = project('STR_147f5ce11b424ec4bb892519', STORE);
    for (const f of ['name', 'category', 'location', 'county', 'tagline']) {
      ck('a shop missing ' + f + ' projects to a string', typeof s[f] === 'string', JSON.stringify(s[f]));
    }
    ck('...so the search filter cannot throw on it',
      (() => { try { return [s].filter(b => (b.category || '').toLowerCase().includes('x')).length === 0; }
               catch (_) { return false; } })());
  }

  console.log('\n  ' + pass + ' passed, ' + failed + ' failed\n');
  if (!failed) {
    console.log('  The directory projects from shops/ and no longer depends on a\n' +
      '  newly-created businesses/{uid} record. Fields the shop carries are mapped;\n' +
      '  fields it does not carry stay UNDEFINED rather than being defaulted — so no\n' +
      '  verification status is asserted that nobody recorded.\n');
  }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('\n  HARNESS FAILURE (not a pass): ' + (e && e.stack || e) + '\n');
  process.exitCode = 1;
});
