'use strict';
/**
 * CERT — Slice L: the Supply Catalogue.
 *
 * THE INVARIANT AT THE HEART OF THIS SLICE
 *   A catalogue row is a supplier's OWN published wholesale offer, resolved through canonical
 *   business identity. Nothing on this surface may be invented — not a minimum order, not a
 *   price, not availability, not a saving, and above all not a supplier.
 *
 * THE AUTHORITATIVE VOCABULARY (established by trace against production, not by preference)
 *   wholesale offered  <=>  products.wholesalePrice > 0   (sokoni-product-schema.js couples
 *                           the pair, so a positive price IS the enable flag)
 *   minimum order       =   products.minWholesaleQty, or NULL — never a default
 *   product owner       =   products.sellerUid            (the field firestore.rules enforces)
 *   business identity   =   businesses/{id}.ownerId === products.sellerUid
 *
 * CATALOGUE ACCESS IS NOT DISCOVERY
 *   Reading a catalogue requires supply.enabled. It must NOT require supply.discoverable —
 *   a business may supply a counterparty it already knows while staying out of the directory.
 *   §2 exists solely to hold that line.
 *
 * METHOD
 *   The REAL getSupplyCatalogue is EXECUTED against an injected fixture. The sabotages mutate
 *   the actual server in functions/procurement.js — not a replica — and §8 proves the positive
 *   results collapse when the real backend query is bypassed, so a green §1 cannot be an
 *   artefact of the harness.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
const B2B  = fs.readFileSync(path.join(ROOT, 'sokoni-b2b.js'), 'utf8');
const SUPPLY_UI = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-supply.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

/* Comments are stripped before any absence test. Four earlier slices lost time to a detector
   matching the very comment that documented the token's absence. */
function stripComments (s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

console.log('\nCERT — Slice L: Supply Catalogue\n');

const VIEWER = 'uid-viewer', VIEWER_BIZ = 'SOK-VIEWER';
const OUTSIDER = 'uid-outsider';        /* authenticated, but owns no business */
const INACTIVE_OWNER = 'uid-inactive', INACTIVE_BIZ = 'SOK-INACTIVE';

/* S1 supplies but is NOT discoverable — the case that proves catalogue != discovery.
   S2 is discoverable but does NOT supply.  S3 is retired.  S4 has no canonical owner. */
function freshData () {
  const secrets = (extra) => Object.assign({
    costPrice: 31337,                            /* the supplier's margin — never leaves */
    sellerEmail: 'private@example.com',
    totalRevenue: 987654, totalUnitsSold: 4321, sold: 4321,
    lastSaleOrderId: 'ORD-SHOULD-NEVER-APPEAR',
    digitalUrl: 'https://SHOULD_NEVER_APPEAR.example/secret.zip',
    digitalLicense: 'LIC-SHOULD-NEVER-APPEAR',
    shopId: 'SHOP-SHOULD-NEVER-APPEAR',
    _testPricedBy: 'uid-SHOULD-NEVER-APPEAR',
  }, extra);
  const live = (extra) => secrets(Object.assign({
    sellerUid: 'uid-s1', uid: 'uid-s1',
    status: 'active', isVisible: true, stock: 100,
    category: 'fashion', price: 900, name: 'Product',
  }, extra));

  return {
    businesses: {
      [VIEWER_BIZ]:   { ownerId: VIEWER, status: 'active', name: 'Viewer Co' },
      [INACTIVE_BIZ]: { ownerId: INACTIVE_OWNER, status: 'suspended', name: 'Dormant Co' },
      'SOK-S1': { ownerId: 'uid-s1', status: 'active', name: 'Supplier One',
                  apiPublicKey: 'pk_live_SHOULD_NEVER_APPEAR',
                  pairingToken: 'tok_SHOULD_NEVER_APPEAR',
                  phone: '+254700000000', email: 'private@example.com',
                  supply: { enabled: true, discoverable: false, displayName: 'S1' } },
      'SOK-S2': { ownerId: 'uid-s2', status: 'active', name: 'Not Supplying Co',
                  supply: { enabled: false, discoverable: true } },
      'SOK-S3': { ownerId: 'uid-s3', status: 'retired', name: 'Retired Co',
                  supply: { enabled: true, discoverable: true } },
      'SOK-S4': { status: 'active', name: 'Ownerless Co',
                  supply: { enabled: true } },
    },
    products: {
      /* ── owner uid-s1: the catalogue under test ── */
      'P-01': live({ name: 'Corporate Polo', wholesalePrice: 480, minWholesaleQty: 30 }),
      'P-02': live({ name: 'No wholesale',   wholesalePrice: null, minWholesaleQty: null }),
      'P-03': live({ name: 'Zero wholesale', wholesalePrice: 0 }),
      'P-04': live({ name: 'Draft',          wholesalePrice: 200, status: 'draft' }),
      'P-05': live({ name: 'Hidden',         wholesalePrice: 200, isVisible: false }),
      /* MOQ absent — must come back NULL, never a default */
      'P-06': live({ name: 'No MOQ set',     wholesalePrice: 150, minWholesaleQty: undefined }),
      /* availability signals */
      'P-07': live({ name: 'Sold out',       wholesalePrice: 150, outOfStock: true }),
      'P-08': live({ name: 'Unknown stock',  wholesalePrice: 150, stock: undefined }),
      /* non-numeric prices are NOT prices */
      'P-09': live({ name: 'Junk price',     wholesalePrice: 'abc' }),
      'P-10': live({ name: 'Empty price',    wholesalePrice: '' }),
      /* keyed on sellerUid: uid/sellerId point elsewhere and must not matter */
      'P-11': live({ name: 'Owned by sellerUid', wholesalePrice: 700,
                     minWholesaleQty: 5, uid: 'uid-OTHER', sellerId: 'uid-OTHER' }),
      /* the inverse: sellerUid points elsewhere, uid says s1 — must NOT appear */
      'X-01': live({ name: 'Not really s1',  wholesalePrice: 700, sellerUid: 'uid-OTHER' }),
      /* ── owner uid-s2: must be unreachable, that business does not supply ── */
      'Q-01': live({ name: 'S2 product', wholesalePrice: 500, sellerUid: 'uid-s2', uid: 'uid-s2' }),
      /* ── the viewer's OWN offer ── */
      'V-01': live({ name: 'Viewer offer', wholesalePrice: 999, minWholesaleQty: 2,
                     sellerUid: VIEWER, uid: VIEWER }),
    },
    workspaceMemberships: [],
  };
}

function loadProcurement (data, srcOverride) {
  const mkRef = (n, id) => ({ _c: n, _id: id,
    async get () { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update () { return true; }, async set () { return true; }, async create () { return true; } });
  function q (n, conds, after, lim) {
    return {
      where (f, _o, v) { return q(n, conds.concat([[f, v]]), after, lim); },
      orderBy () { return q(n, conds, after, lim); },
      startAfter (c) { return q(n, conds, c, lim); },
      limit (k) { return q(n, conds, after, k); },
      select () { return q(n, conds, after, lim); },
      async get () {
        const bag = data[n] || {};
        const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
        let ids = Object.keys(bag).filter((id) => conds.every(([f, v]) => {
          if (f && f.__docId) return true;
          return get(bag[id], f) === v;
        }));
        ids.sort();
        if (after) ids = ids.filter((id) => id > String(after));
        if (lim) ids = ids.slice(0, lim);
        const docs = ids.map((id) => ({ id, data: () => bag[id] }));
        return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
      },
    };
  }
  const fsFn = () => ({
    collection (n) { const b = q(n, [], null, null); return Object.assign(Object.create(b), b, { doc: (id) => mkRef(n, id) }); },
    async runTransaction (fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set () {}, update () {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp () {}, credential: { applicationDefault () {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    ['functions/procurement.js', 'functions/merchant-authority.js', 'functions/tenant-identity.js']
      .forEach((f) => { try { delete require.cache[require.resolve(path.join(ROOT, f))]; } catch (_) {} });
    if (srcOverride) {
      const m = new Module('proc-override', null);
      m.filename = path.join(ROOT, 'functions/procurement.js');
      m.paths = Module._nodeModulePaths(path.join(ROOT, 'functions'));
      m._compile(srcOverride, m.filename);
      return m.exports;
    }
    return require(path.join(ROOT, 'functions/procurement.js'));
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict (fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
function callCat (proc, a, d) {
  const fn = proc.getSupplyCatalogue;
  if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: d || {} });
  if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: d || {} });
  throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
}
const rows = (r) => (r.ok ? (r.value.products || []) : []);
const rowIds = (r) => rows(r).map((x) => x.productId).sort();
const S1 = { merchantId: VIEWER_BIZ, supplierBusinessId: 'SOK-S1' };

(async () => {
  const data = freshData();
  const proc = loadProcurement(data);
  const probe = await verdict(() => callCat(proc, auth(VIEWER), S1));
  check('the real getSupplyCatalogue is invocable', probe.code !== 'harness');
  if (probe.code === 'harness') { console.log('\n  HARNESS CANNOT INVOKE'); process.exit(1); }

  /* ══════════════════════════════════════════════════════════
     §1 eligibility — what is and is not a catalogue entry
  ══════════════════════════════════════════════════════════ */
  console.log('§1 eligibility');
  {
    const r = await verdict(() => callCat(proc, auth(VIEWER), S1));
    check('the read succeeds for an active business against a supplying business', r.ok);
    const got = rowIds(r);
    check('ELIGIBLE supply appears (wholesalePrice > 0, active, visible)', got.indexOf('P-01') !== -1);
    check('a product with NO wholesale price is absent', got.indexOf('P-02') === -1);
    check('a ZERO wholesale price is not an offer', got.indexOf('P-03') === -1);
    check('a non-active product is absent', got.indexOf('P-04') === -1);
    check('an invisible product is absent', got.indexOf('P-05') === -1);
    check('a non-numeric price is not a price', got.indexOf('P-09') === -1);
    check('an empty-string price is not a price', got.indexOf('P-10') === -1);
    check('a sold-out product is still catalogued (availability, not eligibility)',
      got.indexOf('P-07') !== -1);
    check('exactly the eligible products are returned', got.join(',') === 'P-01,P-06,P-07,P-08,P-11');
    sab('the eligibility detector would catch a leaked draft',
      ['P-01', 'P-04'].indexOf('P-04') !== -1);
  }

  /* ══════════════════════════════════════════════════════════
     §2 CATALOGUE ACCESS IS NOT DISCOVERY — the line this slice holds
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 catalogue access is not discovery');
  {
    check('the fixture supplier really is NOT discoverable',
      data.businesses['SOK-S1'].supply.discoverable === false);
    const r = await verdict(() => callCat(proc, auth(VIEWER), S1));
    check('a supplying but UNDISCOVERABLE business still has a readable catalogue', r.ok);
    check('and it returns its real offers', rows(r).length > 0);

    const r2 = await verdict(() => callCat(proc, auth(VIEWER),
      { merchantId: VIEWER_BIZ, supplierBusinessId: 'SOK-S2' }));
    check('a DISCOVERABLE business that does not supply is refused', !r2.ok);
    check('  ...with failed-precondition, not permission-denied', r2.code === 'failed-precondition');
    check('  ...and the reason names supply, not discovery',
      /does not supply/.test(r2.message || ''));

    check('the server requires supply.enabled for a catalogue',
      /supply \|\| \{\}\)\.enabled !== true/.test(PROC));
    check('the server does NOT require discoverable for a catalogue', (function () {
      const body = (/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0];
      return body.length > 500 && !/discoverable/.test(stripComments(body));
    })());
    sab('the discoverable detector would fire if the gate were added',
      /discoverable/.test(stripComments("if (s.supply.discoverable !== true) _err('x');")));
    sab('...and stays silent on a comment that merely mentions it',
      !/discoverable/.test(stripComments("/* deliberately NOT discoverable */\nconst x = 1;")));
  }

  /* ══════════════════════════════════════════════════════════
     §3 NOTHING IS MANUFACTURED — MOQ, price, availability, savings
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 no manufactured terms');
  {
    const r = await verdict(() => callCat(proc, auth(VIEWER), S1));
    check('the catalogue returned rows to inspect', rows(r).length > 0);
    /* Missing rows must FAIL BY ASSERTION, never by dereferencing undefined. A sabotage that
       empties the catalogue should name what broke, not print a stack trace. */
    const by = {}; rows(r).forEach((x) => { by[x.productId] = x; });
    ['P-01', 'P-06', 'P-07', 'P-08'].forEach((k) => { if (!by[k]) by[k] = {}; });

    check('a real MOQ is carried through unchanged', by['P-01'].minWholesaleQty === 30);
    check('an ABSENT MOQ comes back NULL — not 1, not 5, not 10',
      by['P-06'].minWholesaleQty === null);
    check('no row carries the fabricated-vocabulary MOQ field',
      rows(r).every((x) => !Object.prototype.hasOwnProperty.call(x, 'moq') &&
                           !Object.prototype.hasOwnProperty.call(x, 'minOrderQty')));
    check('the wholesale price is the authoritative number', by['P-01'].wholesalePrice === 480);
    check('no row invents a savings/discount percentage',
      rows(r).every((x) => !('savings' in x) && !('discount' in x) && !('discountPct' in x)));
    check('no row invents a rating, review count or verification badge',
      rows(r).every((x) => !('rating' in x) && !('reviews' in x) && !('verified' in x) &&
                           !('certifications' in x) && !('exportReady' in x)));
    check('availability: recorded stock yields true', by['P-01'].inStock === true);
    check('availability: outOfStock yields false', by['P-07'].inStock === false);
    check('availability: NO signal yields null — not false, not true',
      by['P-08'].inStock === null);
    check('exact inventory depth is never returned',
      rows(r).every((x) => !('stock' in x) && !('stockQty' in x)));
    check('the response makes no verification claim', r.value.verificationClaim === null);

    /* The server must not default a missing MOQ anywhere in its own source. */
    const body = stripComments((/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]);
    check('the catalogue body contains no MOQ fallback literal',
      !/minWholesaleQty\s*\|\|\s*\d/.test(body) && !/minOrderQty\s*\|\|\s*\d/.test(body));
    sab('the MOQ-fallback detector fires on a real fallback',
      /minWholesaleQty\s*\|\|\s*\d/.test(stripComments('out.minWholesaleQty = d.minWholesaleQty || 10;')));
    sab('...and stays silent on a comment describing one',
      !/minWholesaleQty\s*\|\|\s*\d/.test(stripComments('/* never minWholesaleQty || 10 */\nvar a=1;')));
  }

  /* ══════════════════════════════════════════════════════════
     §4 POSITIVE ALLOWLIST — private supplier fields never appear
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 positive allowlist');
  {
    const r = await verdict(() => callCat(proc, auth(VIEWER), S1));
    check('the catalogue returned a row to inspect', rows(r).length > 0);
    const row = rows(r)[0] || {};
    const flat = JSON.stringify(r.value);

    ['productId', 'name', 'category', 'wholesalePrice', 'minWholesaleQty', 'retailPrice',
     'inStock', 'image', 'description', 'supplierBusinessId', 'supplierName'].forEach((f) => {
      check('allowed field present: ' + f, Object.prototype.hasOwnProperty.call(row, f));
    });
    ['costPrice', 'sellerEmail', 'sellerUid', 'uid', 'sellerId', 'shopId', 'totalRevenue',
     'totalUnitsSold', 'sold', 'lastSaleOrderId', 'lastSoldAt', 'digitalUrl', 'digitalLicense',
     'verificationStatus', '_testPricedBy', 'stock', 'ownerId'].forEach((f) => {
      check('EXCLUDED field absent: ' + f, !Object.prototype.hasOwnProperty.call(row, f));
    });
    check('the row is built from an allowlist, not the source document',
      Object.keys(row).sort().join(',') ===
      'category,description,image,inStock,minWholesaleQty,name,productId,retailPrice,supplierBusinessId,supplierName,wholesalePrice');
    check('the supplier margin never appears anywhere in the response',
      flat.indexOf('31337') === -1);
    check('no credential or private value leaks anywhere in the response',
      flat.indexOf('SHOULD_NEVER_APPEAR') === -1 && flat.indexOf('private@example.com') === -1 &&
      flat.indexOf('+254700000000') === -1);
    check('the supplier business document\'s own secrets never leak',
      flat.indexOf('pk_live') === -1 && flat.indexOf('tok_') === -1);
    sab('the leak detector fires on a real leak',
      JSON.stringify({ x: 'pk_live_SHOULD_NEVER_APPEAR' }).indexOf('SHOULD_NEVER_APPEAR') !== -1);
  }

  /* ══════════════════════════════════════════════════════════
     §5 AUTHORITY — audience, cross-business, forged identity
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 authority');
  {
    const anon = await verdict(() => callCat(proc, null, S1));
    check('an unauthenticated caller is refused', !anon.ok);

    const outsider = await verdict(() => callCat(proc, auth(OUTSIDER), { supplierBusinessId: 'SOK-S1' }));
    check('a signed-in account with NO business is refused', !outsider.ok);
    check('  ...by the audience gate, not by an empty result',
      outsider.code === 'failed-precondition' && /SOKONI businesses/.test(outsider.message || ''));

    const dormant = await verdict(() => callCat(proc, auth(INACTIVE_OWNER),
      { merchantId: INACTIVE_BIZ, supplierBusinessId: 'SOK-S1' }));
    check('an INACTIVE viewer business is refused', !dormant.ok);
    check('  ...for being inactive', /active business/.test(dormant.message || ''));

    const cross = await verdict(() => callCat(proc, auth(OUTSIDER), S1));
    check('claiming another business as merchantId is denied', !cross.ok);
    check('  ...with permission-denied', cross.code === 'permission-denied');

    const forged = await verdict(() => callCat(proc, auth(VIEWER),
      { merchantId: VIEWER_BIZ, supplierBusinessId: 'SOK-DOES-NOT-EXIST' }));
    check('a forged supplierBusinessId is inert — not-found, no data', !forged.ok);
    check('  ...and returns not-found', forged.code === 'not-found');

    const retired = await verdict(() => callCat(proc, auth(VIEWER),
      { merchantId: VIEWER_BIZ, supplierBusinessId: 'SOK-S3' }));
    check('an INACTIVE supplier business is refused even though it supplies', !retired.ok);

    const ownerless = await verdict(() => callCat(proc, auth(VIEWER),
      { merchantId: VIEWER_BIZ, supplierBusinessId: 'SOK-S4' }));
    check('a business with no canonical owner yields no catalogue', !ownerless.ok);
    check('  ...refused rather than silently empty', ownerless.code === 'failed-precondition');

    check('the audience gate is ONE shared helper, not a copy per surface',
      /async function _assertActiveBusinessAudience/.test(PROC) &&
      (PROC.match(/_assertActiveBusinessAudience\(/g) || []).length >= 3);
    sab('the shared-gate detector would notice the helper being inlined again',
      !/async function _assertActiveBusinessAudience/.test('const x = 1;'));
  }

  /* ══════════════════════════════════════════════════════════
     §6 CANONICAL IDENTITY — sellerUid, and ownerId from the server
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 canonical identity');
  {
    const r = await verdict(() => callCat(proc, auth(VIEWER), S1));
    const got = rowIds(r);
    check('a product is keyed on sellerUid, even when uid/sellerId differ',
      got.indexOf('P-11') !== -1);
    check('a product whose sellerUid is somebody else is NOT in this catalogue',
      got.indexOf('X-01') === -1);
    check('another business\'s products never appear', got.indexOf('Q-01') === -1);
    check('every row carries the canonical business identity, not a seller uid',
      rows(r).every((x) => x.supplierBusinessId === 'SOK-S1'));
    check('the supplier name comes from the business document',
      rows(r).every((x) => x.supplierName === 'Supplier One'));

    const body = stripComments((/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]);
    check('the query keys on sellerUid — the field the rules enforce',
      /where\('sellerUid', '==', String\(ownerUid\)\)/.test(body));
    check('ownerId is read from the fetched business, never from the request',
      /const ownerUid = supplier\.ownerId/.test(body) && !/data\.ownerId|request\.data[\s\S]{0,40}ownerId/.test(body));
    sab('the ownerId-source detector fires on a request-supplied owner',
      /request\.data[\s\S]{0,40}ownerId/.test('const o = request.data.ownerId;'));

    /* Own catalogue: no supply participation needed to see what you offer. */
    const own = await verdict(() => callCat(proc, auth(VIEWER), { merchantId: VIEWER_BIZ }));
    check('omitting the supplier returns the viewer\'s OWN catalogue', own.ok);
    check('  ...flagged as such', own.value.isOwnCatalogue === true);
    check('  ...containing the viewer\'s own offer', rowIds(own).indexOf('V-01') !== -1);
    check('  ...and no other business\'s products', rowIds(own).join(',') === 'V-01');
    check('the viewer needs no supply.enabled to see its own offers',
      !data.businesses[VIEWER_BIZ].supply);
  }

  /* ══════════════════════════════════════════════════════════
     §7 TRUTHFUL EMPTY STATE
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 truthful empty state');
  {
    const empty = freshData();
    Object.keys(empty.products).forEach((k) => { if (k !== 'V-01') delete empty.products[k]; });
    const p2 = loadProcurement(empty);
    const r = await verdict(() => callCat(p2, auth(VIEWER), S1));
    check('a supplier with no wholesale products succeeds', r.ok);
    check('  ...returning an empty list, not an error', Array.isArray(r.value.products) && r.value.products.length === 0);
    check('  ...with an honest count of 0', r.value.count === 0);
    check('  ...and no invented rows', JSON.stringify(r.value.products) === '[]');
    check('  ...and still names the business it read', r.value.supplierBusinessId === 'SOK-S1');
    check('an empty scan reports nothing further to page', r.value.nextCursor === null);
  }

  /* ══════════════════════════════════════════════════════════
     §8 ADVERSARIAL — the positive results DEPEND on the real backend query
  ══════════════════════════════════════════════════════════ */
  console.log('\n§8 adversarial: bypassing the backend must break this suite');
  {
    const real = await verdict(() => callCat(proc, auth(VIEWER), S1));
    const realCount = rows(real).length;
    check('baseline: the real query returns entries', realCount > 0);

    /* (a) Point the scan at a collection that does not exist — the backend read is bypassed. */
    const anchor = "let q = db.collection('products').where('sellerUid', '==', String(ownerUid));";
    check('the bypass anchor exists in the real source', PROC.indexOf(anchor) !== -1);
    const bypassed = PROC.replace(anchor,
      "let q = db.collection('__bypassed__').where('sellerUid', '==', String(ownerUid));");
    check('the bypass override differs from the real source', bypassed !== PROC);
    const pB = loadProcurement(freshData(), bypassed);
    const rB = await verdict(() => callCat(pB, auth(VIEWER), S1));
    check('BYPASSED: the catalogue collapses to nothing', rB.ok && rows(rB).length === 0);
    check('BYPASSED: §1\'s positive assertion would therefore FAIL', rows(rB).length !== realCount);

    /* (b) Neuter the eligibility predicate — ineligible rows must then appear, proving §1 is
       enforced by the server and not by the fixture happening to be clean. */
    const predAnchor = 'function _isCatalogueEntry(d) {';
    check('the predicate anchor exists in the real source', PROC.indexOf(predAnchor) !== -1);
    const neutered = PROC.replace(predAnchor, predAnchor + ' return true; /* neutered */');
    const pN = loadProcurement(freshData(), neutered);
    const rN = await verdict(() => callCat(pN, auth(VIEWER), S1));
    const nIds = rowIds(rN);
    check('NEUTERED: the draft product leaks in', nIds.indexOf('P-04') !== -1);
    check('NEUTERED: the hidden product leaks in', nIds.indexOf('P-05') !== -1);
    check('NEUTERED: the non-wholesale product leaks in', nIds.indexOf('P-02') !== -1);
    check('NEUTERED: so §1 is enforced by the server, not by the fixture',
      nIds.length > realCount);

    /* (c) Remove the allowlist projection — the private fields must then appear. */
    const projAnchor = 'products.push(_projectCatalogueEntry(doc.id, d, supplierId, supplier.name || null));';
    check('the projection anchor exists in the real source', PROC.indexOf(projAnchor) !== -1);
    const raw = PROC.replace(projAnchor,
      "products.push(Object.assign({ productId: doc.id }, d));");
    const pR = loadProcurement(freshData(), raw);
    const rR = await verdict(() => callCat(pR, auth(VIEWER), S1));
    check('RAW: the supplier margin leaks without the projection',
      JSON.stringify(rR.value).indexOf('31337') !== -1);
    check('RAW: so §4 is enforced by the projection, not by the fixture',
      rows(rR).some((x) => Object.prototype.hasOwnProperty.call(x, 'costPrice')));
    sab('the adversarial differential itself is real, not vacuous',
      realCount > 0 && rows(rB).length === 0 && nIds.length > realCount);
  }

  /* ══════════════════════════════════════════════════════════
     §9 THE FABRICATED CATALOGUE IS GONE — not hidden
  ══════════════════════════════════════════════════════════ */
  console.log('\n§9 the fabricated catalogue is eliminated');
  {
    const code = stripComments(B2B);
    check('no invented supplier business names remain',
      !/Nairobi Apparel Co|TechHub Kenya|Rift Valley Mills|Beauty Depot Kenya|FurnishPro|CleanCo Kenya|ToolsKE/.test(code));
    check('no invented Kenyan supplier phone numbers remain',
      !/'07\d{8}'/.test(code));
    check('no invented certification claims remain',
      !/ISO 9001|GlobalGAP|KEPHIS|KEBS'|Samsung Partner/.test(code));
    check('no fabricated savings percentages remain', !/savings\s*:\s*\d/.test(code));
    check('no fabricated wholesale price rows remain', !/wholesalePrice\s*:\s*\d/.test(code));
    check('no fabricated MOQ rows remain', !/\bmoq\s*:\s*\d/.test(code));
    check('no fabricated star ratings remain', !/rating\s*:\s*[1-5]\.\d/.test(code));
    check('no fabricated review counts remain', !/reviews\s*:\s*[1-9]/.test(code));
    /* An unrated supplier is NULL, never 0. Zero reads as "rated badly", which is an invented
       judgement about a real business; the COUNT of reviews may honestly be 0. */
    check('a newly registered supplier is unrated (null), not rated zero',
      /rating:\s*null/.test(code) && !/rating:\s*0/.test(code));
    sab('the zero-rating detector fires on rating: 0',
      /rating:\s*0/.test(stripComments('const s = { rating: 0, reviews: 0 };')));
    check('no mock/seed generator was left behind to re-reference',
      !/function\s+(mock|seed|demoSuppliers|sampleProducts)/i.test(code));
    sab('the fabrication detector fires on a reintroduced row',
      /savings\s*:\s*\d/.test(stripComments("const P=[{id:'x',savings:47}];")));
    sab('...and stays silent on a comment that merely names the field',
      !/savings\s*:\s*\d/.test(stripComments("/* no savings: 47 here */\nvar a=1;")));

    check('the module still exposes its public surface so consumers do not crash',
      /window\.SokoniB2B\s*=/.test(B2B) && /SUPPLIERS/.test(B2B) && /PRODUCTS/.test(B2B));
    check('SUPPLIERS is an empty literal', /const SUPPLIERS\s*=\s*\[\s*\]/.test(B2B));
    check('PRODUCTS is an empty literal', /const PRODUCTS\s*=\s*\[\s*\]/.test(B2B));
  }

  /* ══════════════════════════════════════════════════════════
     §10 WIRING + SCOPE
  ══════════════════════════════════════════════════════════ */
  console.log('\n§10 wiring + scope');
  {
    check('getSupplyCatalogue is exported by the engine',
      /^\s*getSupplyCatalogue,$/m.test(PROC));
    check('and re-exported by name in functions/index.js',
      /exports\.getSupplyCatalogue\s*=\s*procurement\.getSupplyCatalogue;/.test(IDX));

    check('the Supply workspace no longer calls the catalogue unavailable',
      !/id: 'catalogue'[\s\S]{0,200}backed: false/.test(SUPPLY_UI));
    /* Comments stripped, and matched against the section's OP BINDING rather than the file.
       A bare /getSupplyCatalogue/ over the whole file matched the module header explaining
       which op the panel reads, so repointing the panel at the fabricated-era handler left
       this check green. The detector must read the wiring, not the prose about it. */
    const uiCode = stripComments(SUPPLY_UI);
    check('the workspace binds the catalogue section to the canonical op',
      /catalogue:\s*\{\s*op:\s*'getSupplyCatalogue'/.test(uiCode));
    check('the workspace never calls the b2b-wholesale handler',
      !/getWholesaleCatalog/.test(uiCode));
    sab('the op-binding detector fires when the panel is repointed',
      !/catalogue:\s*\{\s*op:\s*'getSupplyCatalogue'/.test(
        "catalogue: { op: 'getWholesaleCatalog', title: 'Supply Catalogue',"));
    check('the workspace never references the fabricated module',
      !/SokoniB2B|sokoni-b2b/.test(stripComments(SUPPLY_UI)));
    sab('the fabricated-reference detector fires on a real reference',
      /SokoniB2B/.test(stripComments('var x = window.SokoniB2B.getProducts();')));

    /* b2b-wholesale.js is deliberately untouched by this slice. */
    const WS = fs.readFileSync(path.join(ROOT, 'functions/b2b-wholesale.js'), 'utf8');
    check('SCOPE: b2b-wholesale.js still defines getWholesaleCatalog unchanged',
      /const getWholesaleCatalog = onCall/.test(WS));
    check('SCOPE: no settlement or payment was added to the catalogue',
      !/settlement|processPayment|stkPush/i.test(
        stripComments((/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0])));
    check('SCOPE: the catalogue writes nothing',
      !/\.(set|update|create|delete)\(/.test(
        stripComments((/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0])));
    sab('the write detector fires on a real write',
      /\.(set|update|create|delete)\(/.test(stripComments('await ref.update({ a: 1 });')));
    check('SCOPE: no composite index was introduced — one equality filter only', (function () {
      const body = stripComments((/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]);
      const wheres = (body.match(/\.where\(/g) || []).length;
      return wheres === 1 && !/'>'|'<'|'>='|'<='/.test(body);
    })());
    check('PRESERVED: Slice K discovery still exists', /const findSuppliers = onCall/.test(PROC));
    check('PRESERVED: the read layer primitive is untouched',
      /async function _listScoped\(request, collection, opts\)/.test(PROC));
  }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — the Supply Catalogue is canonical, allowlisted, and invents nothing.\n');
})();
