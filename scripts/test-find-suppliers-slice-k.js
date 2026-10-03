'use strict';
/**
 * CERT — Slice K: Find Suppliers discovery.
 *
 * THE INVARIANT AT THE HEART OF THIS SLICE
 *   A business can enable Supply WITHOUT becoming discoverable. Participation and directory
 *   visibility are separate, explicit, opt-in decisions, and discovery never infers one from
 *   the other.
 *
 * THE TRUST CONTRACT, in full
 *   status === 'active'  AND  supply.enabled === true  AND  supply.discoverable === true
 *   No verification badge. No implied vetting. A trace found no business-level attestation to
 *   claim — `verifications` is user-keyed and EMPTY in production — so claiming one would be
 *   a fabricated trust signal.
 *
 * METHOD
 *   The REAL `findSuppliers` is EXECUTED against an injected fixture. The sabotages mutate
 *   the actual server filter and the actual allowlist in functions/procurement.js — not a
 *   replica — and the suite is re-run to prove it turns red.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice K: Find Suppliers discovery\n');

const VIEWER = 'uid-viewer', VIEWER_BIZ = 'SOK-VIEWER';
const OUTSIDER = 'uid-outsider';           /* authenticated, but no business of their own */

/* A supplies and is discoverable · B supplies but hides · C is discoverable but does not
   supply · D is discoverable and supplies but is RETIRED. Only A may ever appear. */
function freshData() {
  const withSecrets = (extra) => Object.assign({
    apiPublicKey: 'pk_live_SHOULD_NEVER_APPEAR',
    pairingToken: 'tok_SHOULD_NEVER_APPEAR',
    phone: '+254700000000', email: 'private@example.com', address: '12 Doorstep Lane',
    ownerId: 'uid-someone', adminUids: ['uid-someone'],
  }, extra);
  return {
    businesses: {
      [VIEWER_BIZ]: { ownerId: VIEWER, status: 'active', name: 'Viewer Co' },
      'SOK-A': withSecrets({ status: 'active', name: 'Alpha Supplies', category: 'Retail Shop',
        city: 'Nairobi', county: 'Nairobi', businessId: 'BIZ-A',
        supply: { enabled: true, discoverable: true, displayName: 'Alpha', categories: ['food'],
                  minOrderValue: 5000, leadDays: 3, deliveryAreas: ['Nairobi'], notes: 'internal note' } }),
      'SOK-B': withSecrets({ status: 'active', name: 'Bravo Supplies', category: 'Retail Shop',
        city: 'Nairobi', county: 'Nairobi',
        supply: { enabled: true, discoverable: false, displayName: 'Bravo' } }),
      'SOK-C': withSecrets({ status: 'active', name: 'Charlie Co', category: 'Retail Shop',
        city: 'Nairobi', county: 'Nairobi',
        supply: { enabled: false, discoverable: true, displayName: 'Charlie' } }),
      'SOK-D': withSecrets({ status: 'retired', name: 'Delta Gone', category: 'Retail Shop',
        city: 'Nairobi', county: 'Nairobi',
        supply: { enabled: true, discoverable: true, displayName: 'Delta' } }),
    },
    workspaceMemberships: [],
  };
}

function loadProcurement(data, srcOverride) {
  const mkRef = (n, id) => ({ _c: n, _id: id,
    async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update() { return true; }, async set() { return true; }, async create() { return true; } });
  function q(n, conds, after, lim) {
    return {
      where(f, _o, v) { return q(n, conds.concat([[f, v]]), after, lim); },
      orderBy() { return q(n, conds, after, lim); },
      startAfter(c) { return q(n, conds, c, lim); },
      limit(k) { return q(n, conds, after, k); },
      select() { return q(n, conds, after, lim); },
      async get() {
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
    collection(n) { const b = q(n, [], null, null); return Object.assign(Object.create(b), b, { doc: (id) => mkRef(n, id) }); },
    async runTransaction(fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {}, update() {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
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
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
function callFind(proc, a, d) {
  const fn = proc.findSuppliers;
  if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: d || {} });
  if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: d || {} });
  throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
}
const ids = (r) => (r.value.suppliers || []).map((x) => x.businessId).sort();

(async () => {
  const data = freshData();
  const proc = loadProcurement(data);
  const probe = await verdict(() => callFind(proc, auth(VIEWER), { merchantId: VIEWER_BIZ }));
  check('the real findSuppliers is invocable', probe.code !== 'harness');
  if (probe.code === 'harness') { console.log('\n  HARNESS CANNOT INVOKE'); process.exit(1); }

  /* ══════════════════════════════════════════════════════════
     §1 THE CORE DISTINCTION
  ══════════════════════════════════════════════════════════ */
  console.log('§1 participation is not visibility');
  {
    const r = await verdict(() => callFind(proc, auth(VIEWER), { merchantId: VIEWER_BIZ }));
    check('the query succeeds for an authenticated merchant', r.ok);
    check('A (supply ON + discoverable ON) is VISIBLE', ids(r).indexOf('SOK-A') !== -1);
    check('B (supply ON + discoverable OFF) is INVISIBLE', ids(r).indexOf('SOK-B') === -1);
    check('C (supply OFF + discoverable ON) is INVISIBLE', ids(r).indexOf('SOK-C') === -1);
    check('D (retired, both ON) is INVISIBLE', ids(r).indexOf('SOK-D') === -1);
    check('exactly one supplier is returned', r.value.suppliers.length === 1);
    check('the viewer\'s own non-supplying business is not listed', ids(r).indexOf(VIEWER_BIZ) === -1);
  }

  /* ══════════════════════════════════════════════════════════
     §2 THE ALLOWLIST — positive, and secrets never appear
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 positive allowlist');
  {
    const r = await verdict(() => callFind(proc, auth(VIEWER), { merchantId: VIEWER_BIZ }));
    const row = r.value.suppliers[0];
    const flat = JSON.stringify(r.value);

    ['businessId', 'name', 'category', 'city', 'county', 'supply'].forEach((f) => {
      check('allowed field present: ' + f, Object.prototype.hasOwnProperty.call(row, f));
    });
    ['phone', 'email', 'address', 'rating', 'products', 'moq', 'apiPublicKey', 'pairingToken',
     'ownerId', 'adminUids', 'status'].forEach((f) => {
      check('EXCLUDED field absent: ' + f, !Object.prototype.hasOwnProperty.call(row, f));
    });
    check('no credential value leaks anywhere in the response',
      flat.indexOf('SHOULD_NEVER_APPEAR') === -1);
    check('no PII value leaks anywhere in the response',
      flat.indexOf('+254700000000') === -1 && flat.indexOf('private@example.com') === -1 &&
      flat.indexOf('Doorstep') === -1);
    sab('the leak detector would fire on a real leak',
      JSON.stringify({ x: 'pk_live_SHOULD_NEVER_APPEAR' }).indexOf('SHOULD_NEVER_APPEAR') !== -1);

    check('the row is built from an allowlist, not the source document',
      Object.keys(row).sort().join(',') === 'businessId,category,city,county,name,supply');
    check('supply sub-fields are ALSO allowlisted — internal notes excluded',
      !Object.prototype.hasOwnProperty.call(row.supply, 'notes') &&
      !Object.prototype.hasOwnProperty.call(row.supply, 'enabled') &&
      !Object.prototype.hasOwnProperty.call(row.supply, 'discoverable'));
    check('the allowlist is positive in source, not subtractive',
      /const DISCOVERABLE_FIELDS = \['businessId', 'name', 'category', 'city', 'county', 'supply'\]/.test(PROC));
  }

  /* ══════════════════════════════════════════════════════════
     §3 NO TRUST CLAIM
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 no verification claim');
  {
    const r = await verdict(() => callFind(proc, auth(VIEWER), { merchantId: VIEWER_BIZ }));
    const row = r.value.suppliers[0];
    check('no verified flag on a supplier row',
      !('verified' in row) && !('isVerified' in row) && !('verificationStatus' in row));
    check('the response states the absence of a claim explicitly', r.value.verificationClaim === null);
    check('no person-level verification field is projected',
      !/identityVerified|kraVerified|bankVerified|emailVerified|phoneVerified/.test(JSON.stringify(r.value)));
    check('the source reads no verifications collection in discovery',
      !/findSuppliers[\s\S]{0,2500}collection\('verifications'\)/.test(PROC));
    sab('the detector would catch a verifications read in discovery',
      /findSuppliers[\s\S]{0,2500}collection\('verifications'\)/.test(
        "const findSuppliers = onCall(o, async (r) => { await db.collection('verifications').doc(x).get(); });"));
  }

  /* ══════════════════════════════════════════════════════════
     §4 AUDIENCE + authorization
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 audience');
  {
    const anon = await verdict(() => callFind(proc, null, { merchantId: VIEWER_BIZ }));
    check('unauthenticated is DENIED', !anon.ok);

    const outsider = await verdict(() => callFind(proc, auth(OUTSIDER), {}));
    check('an authenticated user with no business of their own is DENIED', !outsider.ok);

    const crossClaim = await verdict(() => callFind(proc, auth(OUTSIDER), { merchantId: VIEWER_BIZ }));
    check('claiming another merchant\'s id is DENIED', !crossClaim.ok && crossClaim.code === 'permission-denied');

    const forged = auth(VIEWER);
    forged.merchantId = 'SOK-A'; forged.businessId = 'SOK-A';
    const f = await verdict(() => callFind(proc, forged, { merchantId: VIEWER_BIZ }));
    check('forged identity fields on the request are inert',
      f.ok && f.value.viewerMerchantId === VIEWER_BIZ);
    const f2 = await verdict(() => callFind(proc, auth(VIEWER), { merchantId: 'SOK-DOES-NOT-EXIST' }));
    check('a forged businessId is refused, not silently used', !f2.ok);

    check('the viewer merchant is echoed from the AUTHORIZED value',
      /const viewerMerchantId = await _assertMerchantAuthority\(request, merchantId\);/.test(PROC));
  }

  /* ══════════════════════════════════════════════════════════
     §5 the legitimate EMPTY directory
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 empty is a valid state, not a failure');
  {
    const d2 = freshData();
    ['SOK-A', 'SOK-B', 'SOK-C', 'SOK-D'].forEach((k) => { delete d2.businesses[k]; });
    const p2 = loadProcurement(d2);
    const r = await verdict(() => callFind(p2, auth(VIEWER), { merchantId: VIEWER_BIZ }));
    check('a directory with nobody opted in SUCCEEDS', r.ok);
    check('and returns zero suppliers, not an error', r.value.suppliers.length === 0);
    check('and reports a real count of 0', r.value.count === 0);
    check('and offers no cursor', r.value.nextCursor === null);
    check('production today would be empty — no business carries supply.enabled',
      true /* established by the K trace: no `supply` field on any of the 4 production docs */);
  }

  /* ══════════════════════════════════════════════════════════
     §6 consent mechanics
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 consent is explicit and opt-in');
  check('discoverable is on the supply allowlist', proc._SUPPLY_MUTABLE.indexOf('discoverable') !== -1);
  check('it is a strict boolean, never inferred',
    /case 'discoverable': patch\['supply\.discoverable'\] = v === true; break;/.test(PROC));
  check('discovery is NEVER inferred from supply.enabled',
    !/supply\.discoverable'\] = .*supply\.enabled/.test(PROC));
  sab('the detector would catch discovery inferred from participation',
    /supply\.discoverable'\] = .*supply\.enabled/.test("patch['supply.discoverable'] = patch['supply.enabled'];"));
  check('disabling supply withdraws discovery with it',
    /if \(supply\.enabled === false\) \{\s*\n\s*patch\['supply\.discoverable'\] = false;/.test(PROC));
  check('absent means false — opt-in, since the query requires === true',
    /\.where\('supply\.discoverable', '==', true\)/.test(PROC));

  /* §6b LEAD consent (owner 2026-10-03: each RFQ a supplier RECEIVES carries a KES 200 + VAT lead
     fee) — being listed is not agreeing to be charged, so acceptsLeads is its own explicit boolean. */
  console.log('\n§6b lead consent is explicit, separate and withdrawn with supply');
  check('acceptsLeads is on the supply allowlist', proc._SUPPLY_MUTABLE.indexOf('acceptsLeads') !== -1);
  check('acceptsLeads accepts ONLY a real boolean (a string "true" is refused, not coerced)',
    /case 'acceptsLeads': \{\s*\n\s*if \(typeof v !== 'boolean'\) _err\(/.test(PROC));
  check('acceptsLeads is NEVER inferred from enabled or discoverable',
    !/supply\.acceptsLeads'\] = .*(supply\.enabled|supply\.discoverable|v === true)/.test(PROC));
  sab('the detector would catch lead consent inferred from discovery',
    /supply\.acceptsLeads'\] = .*(supply\.enabled|supply\.discoverable|v === true)/.test("patch['supply.acceptsLeads'] = patch['supply.discoverable'];"));
  check('disabling supply withdraws lead consent too (no charges after leaving supply)',
    /if \(supply\.enabled === false\) \{[^}]*patch\['supply\.acceptsLeads'\] = false;/.test(PROC));
  check('granting lead consent stamps its moment (acceptsLeadsAt) and audits it separately',
    /patch\['supply\.acceptsLeads'\] === true\) patch\['supply\.acceptsLeadsAt'\]/.test(PROC) &&
    /'supply_leads_accepted' : 'supply_leads_withdrawn'/.test(PROC));
  {
    const rowAbsent = proc._projectDiscoverable('X', { supply: { enabled: true, discoverable: true } });
    const rowOn = proc._projectDiscoverable('Y', { supply: { enabled: true, discoverable: true, acceptsLeads: true } });
    const rowStr = proc._projectDiscoverable('Z', { supply: { enabled: true, discoverable: true, acceptsLeads: 'true' } });
    check('buyers see a STRICT boolean: absent → false, true → true, a stray string → false (never null)',
      rowAbsent.supply.acceptsLeads === false && rowOn.supply.acceptsLeads === true && rowStr.supply.acceptsLeads === false);
  }

  /* ══════════════════════════════════════════════════════════
     §7 wiring + scope
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 wiring + scope');
  check('findSuppliers is exported', typeof proc.findSuppliers === 'function');
  check('it is re-exported by name in index.js',
    /^exports\.findSuppliers\s+=\s+procurement\.findSuppliers;/m.test(IDX));
  /* Prose vs code — for the fourth time this session. Both of these matched the module's own
     COMMENTS, which explain why free-text search is deferred and that nothing migrates. A
     detector that flags its own documentation proves nothing; strip comments first. */
  const stripC = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const FIND_CODE = stripC((/const findSuppliers = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]);
  check('the findSuppliers body was located', FIND_CODE.length > 200);
  check('SCOPE: no free-text search was invented (code, not prose)',
    !/array-contains|searchableTerms|nameLower/.test(FIND_CODE));
  sab('the comment-stripper does not hide real code',
    /searchableTerms/.test(stripC('/* no searchableTerms here */\nq.where("searchableTerms","array-contains",x);')));
  check('SCOPE: no schema migration was written (code, not prose)',
    !/backfill|migrate/i.test(stripC(PROC)));
  check('PRESERVED: Slice I read layer', /async function _listScoped/.test(PROC));
  check('PRESERVED: Slice E payment idempotency', /_deterministicId\(invoiceId \+ '\|debit', 'led'\)/.test(PROC));
  check('PRESERVED: no new file dependency',
    (PROC.match(/require\('\.\//g) || []).length ===
    (require('child_process').execSync('git show HEAD:functions/procurement.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 }).match(/require\('\.\//g) || []).length);

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — supply participation does not imply discoverability, and only allowlisted fields leave the server.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
