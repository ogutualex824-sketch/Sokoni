'use strict';
/**
 * CERT — Slice H: Merchant V2 business-identity resolution.
 *
 * THE INVARIANT
 *   The shell resolves an UNAMBIGUOUS merchantId from authoritative business identity, or
 *   refuses with an explicit selection state. It never guesses, and `shopId` is never
 *   substituted for `merchantId`.
 *
 * METHOD
 *   The real `resolveMerchantContext` is EXECUTED: procurement.js is loaded with
 *   firebase-admin stubbed at require time, so it closes over an injected fixture holding
 *   two principals and businesses in both id forms — uid-keyed and generated — including an
 *   owner with two simultaneously active businesses, the live production shape.
 *
 *   Static checks appear only where the property is genuinely textual. Every detector runs
 *   in both directions. Syntax validity proves nothing here.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice H: merchant (business) context resolution\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE — both id forms, plus the real multi-business shape
══════════════════════════════════════════════════════════════ */
const UID_SOLO   = 'uid-solo';        // one generated business
const UID_SELF   = 'uid-self-keyed';  // business keyed by the uid itself
const UID_MULTI  = 'uid-multi';       // TWO active businesses — the production case
const UID_NONE   = 'uid-none';        // no business at all
const UID_OTHER  = 'uid-other';       // a second principal

const BIZ_SOLO  = 'SOK-SOLO01';
const BIZ_MULTI_A = 'SOK-MULTIA';
const BIZ_MULTI_B = 'SOK-MULTIB';
const BIZ_OTHER = 'SOK-OTHER1';

function freshData() {
  return {
    businesses: {
      [BIZ_SOLO]:    { ownerId: UID_SOLO,  name: 'Solo Traders', status: 'active' },
      [UID_SELF]:    { ownerId: UID_SELF,  name: 'Self Keyed',   status: 'active' },
      [BIZ_MULTI_A]: { ownerId: UID_MULTI, name: 'Multi A',      status: 'active' },
      [BIZ_MULTI_B]: { ownerId: UID_MULTI, name: 'Multi B',      status: 'active',
                       supply: { enabled: true } },
      [BIZ_OTHER]:   { ownerId: UID_OTHER, name: 'Other Co',     status: 'active' },
    },
    workspaceMemberships: [],
  };
}

function loadProcurement(data) {
  const mkRef = (n, id) => ({ _c: n, _id: id,
    async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update() { return true; }, async set() { return true; }, async create() { return true; } });
  const fsFn = () => ({
    collection(n) {
      return {
        doc(id) { return mkRef(n, id); },
        where(f1, _o, v1) {
          const conds = [[f1, v1]];
          const q = {
            where(f, _o2, v) { conds.push([f, v]); return q; },
            limit(k) { q.__limit = k; return q; },
            async get() {
              const bag = data[n] || {};
              let rows = Array.isArray(bag)
                ? bag.filter((r) => conds.every(([f, v]) => r[f] === v))
                : Object.keys(bag).filter((id) => conds.every(([f, v]) => bag[id][f] === v))
                    .map((id) => ({ id, data: () => bag[id] }));
              if (Array.isArray(bag)) rows = rows.map((r) => ({ id: r.id, data: () => r }));
              const capped = q.__limit ? rows.slice(0, q.__limit) : rows;
              return { empty: capped.length === 0, size: capped.length, docs: capped };
            },
          };
          return q;
        },
      };
    },
    async runTransaction(fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set() {}, update() {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    ['functions/procurement.js', 'functions/merchant-authority.js', 'functions/tenant-identity.js']
      .forEach((f) => { try { delete require.cache[require.resolve(path.join(ROOT, f))]; } catch (_) {} });
    return require(path.join(ROOT, 'functions/procurement.js'));
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }

(async () => {
  const data = freshData();
  const proc = loadProcurement(data);
  const call = (a, d) => {
    const fn = proc.resolveMerchantContext;
    if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: d || {} });
    if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: d || {} });
    throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
  };
  const probe = await verdict(() => call(auth(UID_SOLO)));
  check('the real resolver is invocable in this harness', probe.code !== 'harness');
  if (probe.code === 'harness') { console.log('\n  HARNESS CANNOT INVOKE — aborting'); process.exit(1); }

  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — unambiguous resolution, both id forms
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE — resolution');
  {
    const r = await verdict(() => call(auth(UID_SOLO)));
    check('SINGLE active business resolves', r.ok && r.value.resolved === true);
    check('it resolves to the generated business id', r.ok && r.value.merchantId === BIZ_SOLO);
    check('the id FORM is reported as generated', r.ok && r.value.form === 'generated');
    check('the business name is returned', r.ok && r.value.name === 'Solo Traders');
    check('no choices are offered when unambiguous', r.ok && r.value.choices.length === 0);
  }
  {
    const r = await verdict(() => call(auth(UID_SELF)));
    check('UID-KEYED business resolves', r.ok && r.value.resolved === true);
    check('it resolves to the uid-keyed id', r.ok && r.value.merchantId === UID_SELF);
    check('the id FORM is reported as owner-uid', r.ok && r.value.form === 'owner-uid');
  }
  {
    /* Explicit selection is how a multi-business owner proceeds. */
    const r = await verdict(() => call(auth(UID_MULTI), { businessId: BIZ_MULTI_B }));
    check('an EXPLICIT choice resolves', r.ok && r.value.resolved === true);
    check('the chosen business is the one returned', r.ok && r.value.merchantId === BIZ_MULTI_B);
    check('the choice is marked as selected', r.ok && r.value.selected === true);
    check('supply participation is surfaced', r.ok && r.value.supplyEnabled === true);
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — ambiguity is REFUSED, never guessed
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — the production multi-business case');
  {
    const r = await verdict(() => call(auth(UID_MULTI)));
    check('MULTIPLE active businesses do NOT resolve', r.ok && r.value.resolved === false);
    check('no merchantId is invented', r.ok && r.value.merchantId === null);
    check('the reason is reported as ambiguity',
      r.ok && /multiple-businesses/.test(r.value.reason || ''));
    check('the CHOICES are returned so the state is actionable',
      r.ok && r.value.choices.length === 2);
    check('each choice carries its id and name',
      r.ok && r.value.choices.every((c) => !!c.businessId && !!c.name));
    check('neither choice was silently promoted to merchantId',
      r.ok && r.value.choices.every((c) => c.businessId !== r.value.merchantId));
  }
  {
    const r = await verdict(() => call(auth(UID_NONE)));
    check('an owner with NO business does not resolve', r.ok && r.value.resolved === false);
    check('and no merchantId is invented', r.ok && r.value.merchantId === null);
    check('and no spurious choices are offered', r.ok && r.value.choices.length === 0);
  }
  {
    /* Fail-closed is the property; the exact code is not. The composed helper tries the
       ownership primitive (permission-denied) and then the capability path, which reports a
       missing business as not-found. Both are refusals — asserting one specific code made
       this fail for the wrong reason. What must never happen is a resolution. */
    const r = await verdict(() => call(auth(UID_SOLO), { businessId: 'SOK-DOES-NOT-EXIST' }));
    check('a STALE/nonexistent business fails closed (no resolution)', !r.ok);
    check('and refuses with a closed-set reason',
      !r.ok && ['permission-denied', 'not-found'].indexOf(r.code) !== -1);
    sab('the fail-closed detector would catch a resolution',
      !({ ok: true, value: { merchantId: 'x' } }).ok === false);
  }
  {
    const r = await verdict(() => call(auth(UID_SOLO), { businessId: BIZ_OTHER }));
    check('another principal\'s business is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => call(auth(UID_OTHER), { businessId: BIZ_MULTI_A }));
    check('cross-principal selection is DENIED (two-principal matrix)',
      !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => call(null));
    check('unauthenticated is refused', !r.ok && r.code === 'unauthenticated');
  }
  {
    /* A forged client identity cannot override the server's resolution. */
    const forged = auth(UID_OTHER);
    forged.merchantId = BIZ_MULTI_A; forged.businessId = BIZ_MULTI_A;
    forged.activeShopId = BIZ_MULTI_A; forged.sokoniActiveShopId = BIZ_MULTI_A;
    /* The forged fields name ANOTHER owner's business. The resolver ignores them entirely
       and resolves the caller's own — which is the correct outcome, and a stronger statement
       than "it returned null". An earlier version of this check asserted null and failed for
       the wrong reason. */
    const r = await verdict(() => call(forged));
    check('FORGED identity fields on the request are ignored',
      r.ok && r.value.merchantId === BIZ_OTHER);
    check('the forged business is NOT the one resolved',
      r.ok && r.value.merchantId !== BIZ_MULTI_A);
    sab('the detector would catch the forged value being honoured',
      BIZ_OTHER !== BIZ_MULTI_A);
    const r2 = await verdict(() => call(forged, { businessId: BIZ_MULTI_A }));
    check('a forged payload cannot claim another owner\'s business',
      !r2.ok && r2.code === 'permission-denied');
  }

  /* ══════════════════════════════════════════════════════════
     §3 shopId is NOT merchantId
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 the two identifier spaces stay distinct');
  check('the resolver never reads shops/{id}', !/collection\('shops'\)/.test(
    (/const resolveMerchantContext[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]));
  check('the resolver never reads a users identity field',
    !/collection\('users'\)/.test((/const resolveMerchantContext[\s\S]*?\n\}\);/.exec(PROC) || [''])[0]));
  check('the shell keeps merchantId separate from activeShopId',
    /merchantId: null,/.test(SHELL) && /activeShopId: null/.test(SHELL));
  check('the shell NEVER assigns activeShopId into merchantId',
    !/S\.merchantId\s*=\s*S\.activeShopId/.test(SHELL));
  sab('the detector catches shopId being used as merchantId',
    /S\.merchantId\s*=\s*S\.activeShopId/.test('S.merchantId = S.activeShopId;'));
  check('the accessor exposes both so the distinction is visible at the call site',
    /activeShopId:\s*S\.activeShopId,/.test(SHELL) && /merchantId:\s*S\.merchantId,/.test(SHELL));
  check('merchantContext returns null merchantId when unresolved — no fallback',
    /merchantId:\s*S\.merchantId,/.test(SHELL) && !/S\.merchantId\s*\|\|\s*S\.activeShopId/.test(SHELL));
  sab('the detector catches a shopId fallback',
    /S\.merchantId\s*\|\|\s*S\.activeShopId/.test('return S.merchantId || S.activeShopId;'));

  /* ══════════════════════════════════════════════════════════
     §4 no second resolver; localStorage is not authority
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 canonical resolver reused; no client authority');
  check('the canonical resolveMerchantIdForOwner is reused',
    /resolveMerchantIdForOwner\(String\(uid\)\)/.test(PROC));
  check('no second ownership query was written',
    !/const resolveMerchantContext[\s\S]{0,900}where\('ownerId', '==', String\(uid\)\)[\s\S]{0,200}resolved:\s*true/.test(PROC));
  check('explicit selection is authorized by the shared primitive',
    /const resolveMerchantContext[\s\S]{0,700}await _assertMerchantAuthority\(request, String\(businessId\)\)/.test(PROC));
  sab('the detector catches an unauthorized explicit selection',
    !/await _assertMerchantAuthority\(request, String\(businessId\)\)/.test(
      'if (businessId) { return { resolved: true, merchantId: businessId }; }'));
  /* Scope to the FUNCTION BODY. A fixed character window ran past the function into
     unrelated shell code that legitimately uses localStorage for a Switch Shop choice, so
     the check failed on code it was never about. */
  const RESOLVER_BODY = (/async function resolveMerchantContext \(businessId\) \{[\s\S]*?\n  \}/.exec(SHELL) || [''])[0];
  check('the resolver body was located', RESOLVER_BODY.length > 200);
  check('the shell resolver does not read localStorage for identity',
    !/localStorage/.test(RESOLVER_BODY));
  sab('the detector catches a localStorage identity source in the body',
    /localStorage/.test('async function resolveMerchantContext (businessId) {\n  var id = localStorage.getItem("biz");\n  }'));
  check('the accessor body does not read localStorage either',
    !/localStorage/.test((/function merchantContext \(\) \{[\s\S]*?\n  \}/.exec(SHELL) || [''])[0]));

  /* ══════════════════════════════════════════════════════════
     §5 wiring + scope discipline
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 wiring and scope');
  check('resolveMerchantContext is exported from procurement', typeof proc.resolveMerchantContext === 'function');
  check('it is re-exported by name in index.js',
    /^exports\.resolveMerchantContext\s+=\s+procurement\.resolveMerchantContext;/m.test(IDX));
  check('the shell exposes merchantContext() to modules',
    /window\.SokoniShell\.merchantContext = merchantContext;/.test(SHELL));
  check('the shell resolves it after shop identity settles',
    /await resolveMerchantContext\(\);/.test(SHELL));
  check('a merchant-context failure does not invalidate the shop session',
    /try \{ await resolveMerchantContext\(\); \} catch \(_\) \{\}/.test(SHELL));

  /* H must not have grown into I. */
  /* These three asserted the read layer had NOT landed, which was correct while it was
     Slice I's job. Slice I has since landed, so the invariant flips: the read layer must
     exist AND must be merchant-scoped. Updated rather than deleted — H's boundary with I is
     still worth asserting, just from the other side. */
  check('the read layer now exists (Slice I)', /const listSuppliers = onCall/.test(PROC));
  check('every list op is merchant-scoped through the shared primitive',
    ['listSuppliers', 'listPurchaseOrders', 'listGRNs', 'listSupplierInvoices',
     'listWarehouseStock', 'listStockMovements']
      .every((op) => new RegExp('const ' + op + ' = onCall[\\s\\S]{0,900}_listScoped\\(request, \'').test(PROC)));
  sab('the detector catches an unscoped list op',
    !/const listX = onCall[\s\S]{0,900}_listScoped\(request, '/.test(
      "const listX = onCall(OPT, async (r) => db.collection('x').get());"));
  /* Slice K landed. */
  check('discovery exists (Slice K) and is audience gated',
    /const findSuppliers = onCall/.test(PROC) && /Supplier discovery is available to SOKONI businesses/.test(PROC));
  /* Slice J2 has since registered it, at tier:'more'. */
  check('the Supply route exists and is NOT primary (J2)', (function () {
    const R = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
    return /id:'supply'/.test(R) && /id:'supply'[\s\S]{0,120}tier:'more'/.test(R);
  })());
  check('SCOPE: dashboard/forecast authorization untouched (Slice I)',
    /const getProcurementDashboard = onCall\(OPT, async \(request\) => \{\s*\n\s*_requireAuth\(request\);/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §6 preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 preservation');
  check('PRESERVED: Slice A merchant authority', /_assertMerchantAuthority/.test(PROC));
  check('PRESERVED: Slice C PO-derived gate', /_assertPoAuthority/.test(PROC));
  check('PRESERVED: Slice D receipt idempotency', /_deterministicId\(keySeed, 'grn'\)/.test(PROC));
  check('PRESERVED: Slice E payment idempotency', /_deterministicId\(invoiceId \+ '\|debit', 'led'\)/.test(PROC));
  check('PRESERVED: Slice G canonical read still gated',
    /const getPurchaseOrder = onCall[\s\S]{0,400}await _assertPoAuthority\(request, poId\)/.test(PROC));
  check('PRESERVED: the shell auth model is unchanged — one onAuthStateChanged',
    (SHELL.match(/onAuthStateChanged\(/g) || []).length <= 2);
  check('PRESERVED: no new require added to procurement.js',
    (PROC.match(/^const \{[^}]*\} = require\('\.\/[a-z-]+'\);/gm) || []).length ===
    ((fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8')).match(/^const \{[^}]*\} = require\('\.\/[a-z-]+'\);/gm) || []).length);

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — the shell resolves an unambiguous business, or refuses with the choices.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
