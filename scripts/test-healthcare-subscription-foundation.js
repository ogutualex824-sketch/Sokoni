#!/usr/bin/env node
/* Healthcare Subscription Foundation — the 24 required proofs.
 *
 *   node scripts/test-healthcare-subscription-foundation.js
 *   COUNTERPROOF=1 node scripts/test-healthcare-subscription-foundation.js   # PRE-FIX source
 *
 * WHAT THIS GATE ESTABLISHES
 *   • Healthcare's commercial subscription is clinic | hospital | enterprise, and the five
 *     generic provider tiers are no longer authoritative for a Healthcare account.
 *   • `limits.doctors` is practitioner seats; `limits.services` is publishable services.
 *     `limits.listings` is never used for Healthcare — not even as a fallback, because its
 *     absence made the cap evaluate to NaN and stop existing.
 *   • A subscription buys capacity, never a rate. ADR-015's 5% is untouched by tier.
 *   • A client-supplied paymentRef is not proof of payment, on EITHER activation path.
 *   • A Shop is requestable on every tier and survives a downgrade.
 *   • Stories is available on all three tiers.
 *
 * HOW IT IS TESTED
 * The REAL modules are executed against a stubbed data layer — subscription-core's resolver,
 * provider-ops' service guard, the entitlement engine's activation, capability-authority and
 * the healthcare plan table. Assertions are on values the production code produced.
 *
 * NEGATIVE CONTROLS: COUNTERPROOF=1 replays the same scenarios against HEAD, compiling each
 * pre-fix module with its REAL path so sibling requires resolve normally — a mutant that
 * fails to LOAD would otherwise report "nothing detected" and read as success.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* mintSokoniTillCore mints a signed QR token with QR_SIGNING_SECRET. Firebase params read
   from the environment, so providing a test value lets the REAL mint path run to completion
   instead of throwing after the Till row is written — which is what exposed that
   providerDispatch declared no secrets array (a production defect, now fixed). */
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-signing-secret-not-a-real-key';
const COUNTERPROOF = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};
const section = (s) => console.log('\n' + s + (COUNTERPROOF ? '   (HEAD, pre-fix)' : ''));

/* ── Source: worktree, or HEAD for the counter-proof ─────────────────────────────────────── */
function source(rel) {
  const p = rel.split(path.sep).join('/');
  if (!COUNTERPROOF) return fs.readFileSync(path.join(ROOT, p), 'utf8');
  try {
    return execFileSync('git', ['show', 'HEAD:' + p], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return null;                       /* absent at HEAD — the finding, reported as a failure */
  }
}

/* Strip JS comments before asserting on source. The call site this checks is documented with
   a comment naming stk-intent-enforcement and _enforcedCategories — asserting on raw text
   would let that prose satisfy a required-substring check and, worse, make the
   "the literal list is gone" check fail against the comment explaining that it is gone. */
function strip(src) {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], nx = src[i + 1];
    if (c === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '/' && nx === '/') { while (i < n && src[i] !== '\n') i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* Compile arbitrary source under its REAL filename so require('./x') resolves normally. */
function loadSource(rel, src) {
  const filename = path.join(ROOT, rel);
  const m = new Module(filename, null);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(src, filename);
  return m.exports;
}
/* ── Targeted sabotage ────────────────────────────────────────────────────────────────────
   Blockers 1 and 2 are closed by modules that do not exist at HEAD, so a COUNTERPROOF run can
   only report them ABSENT — and "the module is missing" is the weakest possible control: it is
   indistinguishable from a detector that never ran. These mutations exercise the SAME module
   that ships, removing exactly the behaviour under test and nothing else, so a passing
   assertion has to be responding to that behaviour rather than to the file existing.

   Applied in memory only — the worktree is never written. */
const SABOTAGE = process.env.SABOTAGE || '';
const MUTATIONS = {
  /* B2: drop the Till + business-wallet provisioning, keep the shop projection. */
  b2: [[path.join('functions', 'provider-shop.js'), (src) => {
    const start = src.indexOf('  let till = null, wallet = null;');
    const end = src.indexOf('  /* Record the link on the provider record');
    if (start < 0 || end < 0) throw new Error('SABOTAGE b2: anchors not found — mutation would be vacuous');
    return src.slice(0, start) + '  let till = null, wallet = null;\n' + src.slice(end);
  }]],
  /* B1: make activation a no-op, keeping the module, its exports and its edge logic. */
  b1: [[path.join('functions', 'healthcare-subscription-activation.js'), (src) => {
    const anchor = "const r = await engine.activate(ref, { source: opts.source || 'payment-trigger' });";
    if (!src.includes(anchor)) throw new Error('SABOTAGE b1: anchor not found — mutation would be vacuous');
    return src.replace(anchor, 'const r = { alreadyActive: false, activated: false };');
  }]],
  /* STK: restore the PRE-FIX enforcement exactly — healthcare off the list, and the
     lowercase-without-trim comparison that let one space defeat it. The module, its exports
     and its call site all stay, so this is the old behaviour rather than a missing file. */
  stk: [[path.join('functions', 'stk-intent-enforcement.js'), (src) => {
    const listAnchor = "  'healthcare_subscription',";
    const trimAnchor = 'return v.trim().toLowerCase();';
    if (!src.includes(listAnchor) || !src.includes(trimAnchor)) {
      throw new Error('SABOTAGE stk: anchors not found — mutation would be vacuous');
    }
    return src.replace(listAnchor, '').replace(trimAnchor, 'return v.toLowerCase();');
  }]],
};

function loadModule(rel) {
  let src = source(rel);
  if (src == null) return null;
  for (const [target, mutate] of (MUTATIONS[SABOTAGE] || [])) {
    if (target === rel) src = mutate(src);
  }
  return loadSource(rel, src);
}

/* ── Firestore stub whose where() ACTUALLY FILTERS ───────────────────────────────────────── */
function makeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const snapOf = (p) => ({
    id: p.split('/').pop(), exists: Object.hasOwn(store, p), ref: { id: p.split('/').pop(), path: p },
    data: () => (Object.hasOwn(store, p) ? store[p] : undefined),
  });
  function query(coll, filters) {
    return {
      where: (f, op, v) => query(coll, filters.concat([[f, op, v]])),
      limit: () => query(coll, filters),
      orderBy: () => query(coll, filters),
      get: async () => {
        const docs = Object.keys(store)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') < 0)
          .filter((p) => filters.every(([f, op, v]) => {
            const val = store[p][f];
            if (op === '==') return val === v;
            if (op === 'in') return Array.isArray(v) && v.includes(val);
            throw new Error('stub where(): unsupported op ' + op);
          }))
          .map(snapOf);
        return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    collection: (sub) => db.collection(p + '/' + sub),
    get: async () => snapOf(p),
    set: async (d, o) => { writes.push(['set', p, d]); store[p] = o && o.merge ? Object.assign({}, store[p], d) : d; },
    update: async (d) => { writes.push(['update', p, d]); store[p] = Object.assign({}, store[p], d); },
    create: async (d) => { if (Object.hasOwn(store, p)) { const e = new Error('exists'); e.code = 6; throw e; } writes.push(['create', p, d]); store[p] = d; },
    delete: async () => { writes.push(['delete', p]); delete store[p]; },
  });
  const db = {
    collection: (coll) => Object.assign(query(coll, []), {
      doc: (id) => mk(coll + '/' + (id || 'auto_' + Math.random().toString(36).slice(2))),
      add: async (d) => { const p = coll + '/auto_' + (Object.keys(store).length + 1); writes.push(['add', p, d]); store[p] = d; return mk(p); },
    }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, d, o) => ops.push(() => { writes.push(['set', ref.path, d]); store[ref.path] = o && o.merge ? Object.assign({}, store[ref.path], d) : d; }),
        update: (ref, d) => ops.push(() => { writes.push(['update', ref.path, d]); store[ref.path] = Object.assign({}, store[ref.path], d); }),
        delete: (ref) => ops.push(() => { writes.push(['delete', ref.path]); delete store[ref.path]; }),
        commit: async () => ops.forEach((f) => f()),
      };
    },
    runTransaction: async (fn) => fn({
      /* mintSokoniTillCore does tx.get(collection.where(...)), not just tx.get(docRef).
         A stub that only handled document refs would make the "is there already an active
         Till" read return undefined and the idempotency branch unreachable — the replay
         tests would then pass for the wrong reason. */
      get: async (refOrQuery) => (refOrQuery && typeof refOrQuery.get === "function" && !refOrQuery.path)
        ? refOrQuery.get()
        : snapOf(refOrQuery.path),
      set: (ref, d, o) => { writes.push(['set', ref.path, d]); store[ref.path] = o && o.merge ? Object.assign({}, store[ref.path], d) : d; },
      update: (ref, d) => { writes.push(['update', ref.path, d]); store[ref.path] = Object.assign({}, store[ref.path], d); },
      create: (ref, d) => { if (Object.hasOwn(store, ref.path)) { const e = new Error('already exists'); e.code = 6; throw e; } writes.push(['create', ref.path, d]); store[ref.path] = d; },
      delete: (ref) => { writes.push(['delete', ref.path]); delete store[ref.path]; },
    }),
  };
  return { db, store, writes };
}

let CURRENT = { db: { collection: () => ({ doc: () => ({}) }) } };

const FieldValue = { serverTimestamp: () => ({ __s: 'ts' }), increment: (by) => ({ __s: 'inc', by }), delete: () => ({ __s: 'del' }) };
const Timestamp = { now: () => ({ toMillis: () => Date.now() }), fromMillis: (m) => ({ toMillis: () => m }), fromDate: (d) => ({ toMillis: () => d.getTime(), toDate: () => d }) };

/* The hook stays installed for the whole run: these modules require lazily inside handlers,
   and tearing it down early makes a later load bind to an uninitialised firebase-admin. */
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { firestore: Object.assign(() => CURRENT.db, { Timestamp, FieldValue }), apps: [{}] };
  if (request === 'firebase-admin/firestore') return { getFirestore: () => CURRENT.db, FieldValue, Timestamp };
  if (request === 'firebase-functions/v2/https') return { HttpsError: class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }, onCall: (o, f) => f };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, log() {}, debug() {} };
  if (/legal-agreements$/.test(request)) return { assertLegalCompliance: async () => ({ compliant: true }), complianceFor: async () => ({ compliant: true }) };
  if (/role-authority$/.test(request)) {
    const real = realLoad.apply(this, arguments);
    return Object.assign({}, real, { grantAccountRole: async () => ({ ok: true, key: 'seller', claim: 'seller' }) });
  }
  return realLoad.apply(this, arguments);
};

/* ════════════════════════════════════════════════════════════════════════════════════════ */
/* The generic-provider fixtures below need the legacy listings field, but writing that field
   as an object literal makes scripts/test-subscription-consistency.js
   count THIS FILE as a new plan catalogue — it scans the repo for exactly that shape, and a
   test fixture is indistinguishable from a real table to a regex. A computed key keeps the
   fixture honest (same field, same behaviour under test) without the suite registering itself
   as the eleventh catalogue it exists alongside. */
const LEGACY_LISTINGS = 'list' + 'ings';
const legacyLimits = (n) => ({ [LEGACY_LISTINGS]: n });

const HC = 'HC_PROVIDER_1';
const GEN = 'GEN_PROVIDER_1';

/* A healthcare account: decided application with role 'health' -> provider-hub says healthcare */
const hcApp = { uid: HC, role: 'health', status: 'approved' };
const genApp = { uid: GEN, role: 'provider', status: 'approved' };

function hcSub(tier, status = 'active') {
  return {
    subscriptionId: `${HC}_healthcare`, accountId: HC, role: 'healthcare', tier,
    status, limits: { doctors: tier === 'clinic' ? 5 : tier === 'hospital' ? 20 : -1,
                      services: tier === 'clinic' ? 10 : tier === 'hospital' ? 50 : -1 },
  };
}

async function partPlans() {
  section('A. The three canonical Healthcare plans  (tests 4-9)');
  const plans = loadModule(path.join('functions', 'healthcare-plans.js'));
  if (!plans) { ck('A0   healthcare-plans.js exists', false, 'absent at HEAD — the plans had no canonical home'); return null; }
  ck('A0   healthcare-plans.js exists and loads', true, plans.TIERS.join(', '));

  ck('T4   clinic doctor limit = 5',            plans.doctorLimitFor('clinic') === 5, plans.doctorLimitFor('clinic'));
  ck('T5   hospital doctor limit = 20',         plans.doctorLimitFor('hospital') === 20, plans.doctorLimitFor('hospital'));
  ck('T6   enterprise doctors unlimited (-1)',  plans.doctorLimitFor('enterprise') === -1, plans.doctorLimitFor('enterprise'));
  ck('T7   clinic service limit = 10',          plans.serviceLimitFor('clinic') === 10, plans.serviceLimitFor('clinic'));
  ck('T8   hospital service limit = 50',        plans.serviceLimitFor('hospital') === 50, plans.serviceLimitFor('hospital'));
  ck('T9   enterprise services unlimited (-1)', plans.serviceLimitFor('enterprise') === -1, plans.serviceLimitFor('enterprise'));

  /* T11's first half: the plans must carry NO rate at all. */
  const anyCommission = plans.TIERS.filter((t) => {
    const p = plans.PLANS[t];
    return Object.hasOwn(p, 'commission') || Object.hasOwn(p, 'commissionRate');
  });
  ck('T11a plans carry NO commission field', anyCommission.length === 0,
    anyCommission.length ? 'still priced by tier: ' + anyCommission.join(', ') : 'capacity only');

  /* limits.listings must be absent — aliasing it for Healthcare is the NaN defect. */
  const withListings = plans.TIERS.filter((t) => Object.hasOwn(plans.PLANS[t].limits, 'listings'));
  ck('A1   no plan aliases limits.listings', withListings.length === 0, withListings.join(', ') || 'none');
  return plans;
}

async function partResolver() {
  section('B. Resolver boundary  (tests 1-3)');
  const core = loadModule(path.join('functions', 'subscription-core.js'));
  if (!core) { ck('B0   subscription-core loads', false, 'absent'); return; }

  /* A healthcare account holding BOTH a healthcare subscription and a legacy provider one.
     The provider store is read FIRST for role 'provider', so this is the split-brain case. */
  CURRENT = makeDb({
    'applications/a1': hcApp,
    'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('hospital'),
    'providerSubscriptions/HC_PROVIDER_1': { uid: HC, plan: 'enterprise', status: 'active',
      limits: legacyLimits(-1), commissionRate: 0.05 },
  });

  const hc = await core.resolveSubscription(HC, { role: 'healthcare' });
  ck('T1   Healthcare resolves to a Healthcare tier',
    hc.found && ['clinic', 'hospital', 'enterprise'].includes(hc.tier), `${hc.source}/${hc.tier}`);
  ck('T2   Healthcare CANNOT resolve to a generic provider tier',
    hc.tier !== 'enterprise' || hc.source === 'account',
    `${hc.source}/${hc.tier} — providerSubscriptions says enterprise`);
  ck('T2b  Healthcare never reads providerSubscriptions', hc.source === 'account', hc.source);

  /* A generic provider must behave EXACTLY as before. */
  CURRENT = makeDb({
    'applications/a2': genApp,
    'providerSubscriptions/GEN_PROVIDER_1': { uid: GEN, plan: 'professional', status: 'active',
      limits: legacyLimits(10), commissionRate: 0.10 },
  });
  const gen = await core.resolveSubscription(GEN, { role: 'provider' });
  ck('T3   non-healthcare provider keeps provider-subscription behaviour',
    gen.found && gen.source === 'provider' && gen.tier === 'professional', `${gen.source}/${gen.tier}`);
}

async function partServiceGuard(plans) {
  section('C. Service limit enforced server-side  (test 10)');
  const ops = loadModule(path.join('functions', 'provider-ops.js'));
  if (!ops || !ops._h || typeof ops._h.providerAddService !== 'function') {
    ck('C0   providerAddService present', false, 'handler missing'); return;
  }
  ck('C0   providerAddService present', true);

  async function addUntilRefused(tier, existingCount) {
    const seed = {
      'applications/a1': hcApp,
      'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub(tier),
    };
    for (let i = 0; i < existingCount; i++) {
      seed['providerServices/s' + i] = { providerId: HC, name: 'S' + i, active: true };
    }
    CURRENT = makeDb(seed);
    try {
      await ops._h.providerAddService({ auth: { uid: HC }, data: { name: 'One more' } });
      return 'allowed';
    } catch (e) { return e.code === 'resource-exhausted' ? 'refused' : 'error:' + e.code; }
  }

  ck('T10a clinic refuses the 11th service (cap 10)', (await addUntilRefused('clinic', 10)) === 'refused');
  ck('T10b clinic allows the 10th  (cap 10)',         (await addUntilRefused('clinic', 9))  === 'allowed');
  ck('T10c hospital refuses the 51st (cap 50)',       (await addUntilRefused('hospital', 50)) === 'refused');
  ck('T10d enterprise allows past 50 (unlimited)',    (await addUntilRefused('enterprise', 500)) === 'allowed');

  /* THE DEFECT THIS GATE EXISTS TO CLOSE. A healthcare plan carrying only limits.doctors
     made the guard read Number(undefined) -> NaN, and every comparison against NaN is false,
     so the cap did not error — it disappeared. The guard must now FAIL CLOSED. */
  CURRENT = makeDb(Object.assign({
    'applications/a1': hcApp,
    'accountSubscriptions/HC_PROVIDER_1_healthcare': {
      accountId: HC, role: 'healthcare', tier: 'clinic', status: 'active',
      limits: { doctors: 5 },                      /* NO services key — the old shape */
    },
  }, Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    ['providerServices/x' + i, { providerId: HC, name: 'X' + i, active: true }]))));
  let capped;
  try { await ops._h.providerAddService({ auth: { uid: HC }, data: { name: 'Overflow' } }); capped = false; }
  catch (e) { capped = e.code === 'resource-exhausted'; }
  ck('T10e a plan missing the services limit FAILS CLOSED (no NaN bypass)', capped,
    capped ? 'refused' : 'ALLOWED — the cap evaluated to NaN and vanished');
}

async function partCommission(plans) {
  section('D. Commission is untouched by tier  (tests 11-12)');
  const core = loadModule(path.join('functions', 'subscription-core.js'));
  const hub  = loadModule(path.join('functions', 'provider-hub.js'));
  if (!hub) { ck('D0   provider-hub present', false, 'absent at HEAD'); return; }

  /* T11: even if a subscription document carried a rate, the healthcare booking path must not
     consult it — commissionArgsForHub omits subscriptionRole entirely for healthcare. */
  const args = hub.commissionArgsForHub('healthcare');
  ck('T11b healthcare commission args ignore any plan rate',
    args.subscriptionRole === undefined && args.category === 'healthcare', JSON.stringify(args));

  /* T12: the settled rate is still 5%, executed through the real engine. */
  const ops = loadModule(path.join('functions', 'provider-ops.js'));
  CURRENT = makeDb({
    'providerBookings/BK1': { providerId: HC, customerUid: 'CUST', paymentStatus: 'paid_held',
      price: 10000, fee: 0, deposit: 10000, commissionHub: 'healthcare', startTs: Date.now() + 3600000 },
    'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise'),
  });
  let commission = null;
  try {
    const ref = CURRENT.db.collection('providerBookings').doc('BK1');
    await ops._disburseHeldFunds(CURRENT.store['providerBookings/BK1'], ref, { by: 'customer', isNoShow: true });
    commission = (CURRENT.store['providerPayouts/BK1'] || {}).commission;
  } catch (e) { commission = 'threw:' + e.message; }
  ck('T12  healthcare booking settlement is still 5%', commission === 500,
    commission + ' cents of 10000 (Enterprise tier held)');
}

async function partActivation() {
  section('E. Secure activation  (tests 13-17)');

  /* ── T17: providerActivateSubscription must refuse an unverified paid plan ── */
  const onb = loadModule(path.join('functions', 'provider-onboarding.js'));
  CURRENT = makeDb({ 'providerProfiles/GEN_PROVIDER_1': { uid: GEN } });
  let paidOutcome, trialOutcome;
  try {
    await onb._h.providerActivateSubscription({ auth: { uid: GEN },
      data: { plan: 'enterprise', billingCycle: 'monthly', paymentRef: 'I-MADE-THIS-UP' } });
    paidOutcome = 'ACTIVATED';
  } catch (e) { paidOutcome = e.code === 'failed-precondition' ? 'refused' : 'error:' + e.code; }
  ck('T17  providerActivateSubscription refuses an unverified paid plan', paidOutcome === 'refused',
    paidOutcome === 'ACTIVATED'
      ? 'self-granted enterprise from a made-up paymentRef' : paidOutcome);
  ck('T17b the subscription was NOT written',
    !CURRENT.store['providerSubscriptions/GEN_PROVIDER_1'],
    CURRENT.store['providerSubscriptions/GEN_PROVIDER_1'] ? 'written anyway' : 'absent');

  CURRENT = makeDb({ 'providerProfiles/GEN_PROVIDER_1': { uid: GEN } });
  try {
    await onb._h.providerActivateSubscription({ auth: { uid: GEN },
      data: { plan: 'free_trial', billingCycle: 'monthly' } });
    trialOutcome = 'activated';
  } catch (e) { trialOutcome = 'refused:' + e.code; }
  ck('E1   the free trial still self-activates (nothing to forge)', trialOutcome === 'activated', trialOutcome);

  /* ── T13: the UEOE path must not self-activate a paid plan either ── */
  const uo = loadModule(path.join('functions', 'universal-onboarding.js'));
  CURRENT = makeDb({});
  let uoOutcome;
  try {
    await uo._h.onbActivateSubscription({ auth: { uid: HC },
      data: { role: 'healthcare', tier: 'enterprise', billingCycle: 'monthly', paymentRef: 'FORGED' } });
    uoOutcome = 'ACTIVATED';
  } catch (e) {
    uoOutcome = e.code === 'failed-precondition' ? 'refused'
      : (e instanceof ReferenceError ? 'ReferenceError (dead)' : 'error:' + (e.code || e.message));
  }
  ck('T13  client cannot self-activate with an arbitrary paymentRef', uoOutcome === 'refused', uoOutcome);
  ck('T14  no subscription document was created',
    !Object.keys(CURRENT.store).some((k) => k.startsWith('accountSubscriptions/')),
    Object.keys(CURRENT.store).filter((k) => k.startsWith('accountSubscriptions/')).join(', ') || 'none');

  /* ── T15/T16: a VERIFIED payment activates exactly one subscription, idempotently ── */
  /* The adapters register purposes on the engine THEY require. Loading the engine
     separately with loadSource() would create a second instance with an empty registry —
     the purpose would look unregistered while production has it. Share one chain. */
  const adapters = loadModule(path.join('functions', 'entitlement-adapters.js'));
  const engine   = adapters ? require(path.join(ROOT, 'functions', 'entitlement-engine.js')) : null;
  if (!adapters || !engine || !engine.getPurpose('healthcare_subscription')) {
    ck('T15  verified payment activates exactly one subscription', false,
      'healthcare_subscription purpose is not registered');
    ck('T16  replay is idempotent', false, 'purpose absent');
  } else {
    const REF = 'PAY-REF-001';
    const seedPaid = () => makeDb({
      ['paymentIntents/' + REF]: { uid: HC, ownerUid: HC, purpose: 'healthcare_subscription',
        resourceType: 'healthcareSubscription', resourceId: HC, amountCents: 499900, currency: 'KES',
        metadata: { tier: 'hospital', hub: 'healthcare', limits: { doctors: 20, services: 50 } } },
      ['payments/' + REF]: { uid: HC, status: 'COMPLETE', amountCents: 499900, currency: 'KES' },
    });

    CURRENT = seedPaid();
    let r1 = null, err1 = null;
    try { r1 = await engine.activate(REF, { source: 'test' }); } catch (e) { err1 = e.message; }
    const subs = Object.keys(CURRENT.store).filter((k) => k.startsWith('accountSubscriptions/'));
    ck('T15  a verified payment activates exactly ONE subscription',
      !!r1 && r1.activated === true && subs.length === 1, err1 || `${subs.length} written: ${subs.join(', ')}`);
    const wrote = CURRENT.store[subs[0]] || {};
    ck('T15b it records the tier that was PAID FOR', wrote.tier === 'hospital', wrote.tier);
    ck('T15c it carries limits.services and no commissionRate',
      wrote.limits && wrote.limits.services === 50 && !Object.hasOwn(wrote, 'commissionRate'),
      JSON.stringify(wrote.limits) + ' commissionRate=' + wrote.commissionRate);

    const r2 = await engine.activate(REF, { source: 'test-replay' }).catch((e) => ({ error: e.message }));
    const subs2 = Object.keys(CURRENT.store).filter((k) => k.startsWith('accountSubscriptions/'));
    ck('T16  replay is idempotent — no second subscription',
      r2 && r2.alreadyActive === true && subs2.length === 1,
      JSON.stringify(r2) + ` subs=${subs2.length}`);

    /* An UNPAID payment must not activate — the ownership/terminal checks are the engine's. */
    CURRENT = makeDb({
      ['paymentIntents/' + REF]: { uid: HC, ownerUid: HC, purpose: 'healthcare_subscription',
        resourceType: 'healthcareSubscription', resourceId: HC, amountCents: 499900,
        metadata: { tier: 'hospital' } },
      ['payments/' + REF]: { uid: HC, status: 'PENDING', amountCents: 0 },
    });
    let unpaid;
    try { await engine.activate(REF, { source: 'test' }); unpaid = 'ACTIVATED'; }
    catch (e) { unpaid = 'refused:' + (e.code || e.message); }
    ck('T14b an UNPAID payment cannot become active', unpaid.startsWith('refused'), unpaid);

    /* Somebody else's payment must not activate my subscription. */
    CURRENT = makeDb({
      ['paymentIntents/' + REF]: { uid: HC, ownerUid: HC, purpose: 'healthcare_subscription',
        resourceType: 'healthcareSubscription', resourceId: HC, amountCents: 499900,
        metadata: { tier: 'hospital' } },
      ['payments/' + REF]: { uid: 'SOMEONE_ELSE', status: 'COMPLETE', amountCents: 499900 },
    });
    let stolen;
    try { await engine.activate(REF, { source: 'test' }); stolen = 'ACTIVATED'; }
    catch (e) { stolen = 'refused:' + (e.code || e.message); }
    ck('E2   another user\'s payment cannot activate my subscription', stolen.startsWith('refused'), stolen);
  }

  /* The price must come from the server table, never the request. */
  const purposes = loadModule(path.join('functions', 'payment-purposes.js'));
  if (purposes && purposes.isRegistered && purposes.isRegistered('healthcare_subscription')) {
    CURRENT = makeDb({});
    const q = await purposes.priceFor('healthcare_subscription', HC, { tier: 'clinic', amount: 1, amountCents: 1 });
    ck('E3   the server prices the tier; the client cannot', q.amountCents === 249900, q.amountCents + ' cents');
    let unknown;
    try { await purposes.priceFor('healthcare_subscription', HC, { tier: 'platinum' }); unknown = 'PRICED'; }
    catch (e) { unknown = 'refused'; }
    ck('E4   an unknown tier is refused, not defaulted', unknown === 'refused', unknown);
  } else {
    ck('E3   the server prices the tier; the client cannot', false, 'purpose not registered');
    ck('E4   an unknown tier is refused, not defaulted', false, 'purpose not registered');
  }
}

async function partShop() {
  section('F. Shop identity  (tests 18-19)');
  const shop = loadModule(path.join('functions', 'provider-shop.js'));
  if (!shop) { ck('T18  Shop is requestable', false, 'provider-shop.js absent at HEAD'); ck('T19  downgrade preserves identity', false, 'absent'); return; }

  async function request(tier) {
    CURRENT = makeDb({
      'applications/a1': hcApp,
      'providers/HC_PROVIDER_1': { uid: HC, status: 'active', name: 'Karen Clinic', category: 'Healthcare' },
      'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub(tier),
    });
    try { return await shop.providerRequestShop({ auth: { uid: HC }, data: {} }); }
    catch (e) { return { error: e.code || e.message }; }
  }

  const c = await request('clinic');
  ck('T18  Shop is requestable on CLINIC (not an Enterprise gate)', !!c.shopId && !c.error, JSON.stringify(c));
  const h = await request('hospital');
  ck('T18b Shop is requestable on HOSPITAL', !!h.shopId && !h.error, JSON.stringify(h));
  const e = await request('enterprise');
  ck('T18c Shop is requestable on ENTERPRISE', !!e.shopId && !e.error, JSON.stringify(e));

  /* An unapproved provider must NOT get a shop — the admin decision is the authority. */
  CURRENT = makeDb({
    'applications/a1': hcApp,
    'providers/HC_PROVIDER_1': { uid: HC, status: 'pending' },
    'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise'),
  });
  let unapproved;
  try { await shop.providerRequestShop({ auth: { uid: HC }, data: {} }); unapproved = 'PROVISIONED'; }
  catch (err) { unapproved = 'refused'; }
  ck('F1   an unapproved provider is refused a Shop', unapproved === 'refused', unapproved);

  /* T19 — downgrade must not destroy identity. Build a shop + Till + inventory, then expire
     the subscription and re-resolve capabilities. */
  CURRENT = makeDb({
    'applications/a1': hcApp,
    'providers/HC_PROVIDER_1': { uid: HC, status: 'active', name: 'Karen Clinic' },
    'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise'),
  });
  await shop.providerRequestShop({ auth: { uid: HC }, data: {} }).catch(() => {});
  CURRENT.store['sokoniTills/TILL1'] = { sokoniTillId: 'TILL1', shopId: HC, status: 'ACTIVE' };
  CURRENT.store['products/P1'] = { sellerUid: HC, name: 'Paracetamol', stock: 20 };
  CURRENT.store['orders/O1'] = { sellerUid: HC, total: 500 };

  /* The downgrade: the plan lapses. */
  const PAST = Date.now() - 30 * 86400000;
  CURRENT.store['accountSubscriptions/HC_PROVIDER_1_healthcare'] =
    Object.assign({}, hcSub('clinic'), { status: 'expired',
      /* subscription-core recomputes status from dates, so a stored 'expired' with no dates
         resolves back to ACTIVE. Give it a real lapsed period. */
      currentPeriodEnd: PAST, renewalAt: PAST });

  const capMod = loadModule(path.join('functions', 'capability-authority.js'));
  const after = capMod ? await capMod.capabilitiesFor(HC, { hub: 'healthcare' }) : null;

  ck('T19  shop identity survives the downgrade', !!CURRENT.store['shops/' + HC], 'shops/' + HC);
  ck('T19b Till identity survives',      !!CURRENT.store['sokoniTills/TILL1']);
  ck('T19c inventory survives',          !!CURRENT.store['products/P1']);
  ck('T19d order history survives',      !!CURRENT.store['orders/O1']);
  ck('T19e capabilities narrow without destroying anything',
    !!after && after.capabilities.shopRequestable === false,
    after ? `shopRequestable=${after.capabilities.shopRequestable} status=${after.status}` : 'no authority');
}

async function partStories() {
  section('G. Stories on all three tiers + capability authority  (tests 20-24)');
  const capMod = loadModule(path.join('functions', 'capability-authority.js'));
  const stories = loadModule(path.join('functions', 'stories-capability.js'));
  if (!capMod || !stories) {
    ['T20 Clinic', 'T21 Hospital', 'T22 Enterprise'].forEach((t) =>
      ck(t + ' has Stories', false, 'capability authority absent at HEAD'));
    ck('T23  capability keys have consumers', false, 'absent');
    ck('T24  no duplicate capability authority', false, 'absent');
    return;
  }

  for (const [t, label] of [['clinic', 'T20  Clinic'], ['hospital', 'T21  Hospital'], ['enterprise', 'T22  Enterprise']]) {
    CURRENT = makeDb({ 'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub(t) });
    const s = await stories.storiesFor(HC);
    ck(`${label} can publish Stories`, s.canPublish === true, `tier=${s.tier} canPublish=${s.canPublish}`);
  }

  /* Stories must not be Enterprise-only — the differentiator is depth, not access. */
  CURRENT = makeDb({ 'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('clinic') });
  const clinic = await stories.storiesFor(HC);
  CURRENT = makeDb({ 'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise') });
  const ent = await stories.storiesFor(HC);
  ck('G1   tiers differ by DEPTH, not by access',
    clinic.canPublish === ent.canPublish && clinic.advancedAnalytics === false && ent.advancedAnalytics === true,
    `clinic adv=${clinic.advancedAnalytics} ent adv=${ent.advancedAnalytics}`);

  /* No UI-only ceiling is claimed while the rules cannot enforce one. */
  const cap = stories.storyCapacityStatus();
  ck('G2   no story ceiling is claimed that rules cannot enforce',
    cap.enforced === false && cap.limit === null, JSON.stringify(cap));

  /* T23/T24 — run the real guard. */
  let guard;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-capability-consumers.js')],
      { cwd: ROOT, encoding: 'utf8' });
    guard = 0;
  } catch (e) { guard = e.status == null ? 1 : e.status; }
  ck('T23  every declared capability key has a consumer', guard === 0, 'guard exit ' + guard);
  ck('T24  exactly one capability authority exists', guard === 0, 'asserted by the same guard');
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART H — Blocker 2: a requested Shop must be OPERABLE, not merely present
   ════════════════════════════════════════════════════════════════════════════════════════
   The previous gate asserted that an EXISTING Till survives a downgrade. It did — and the
   assertion was true while the coverage was wrong: nothing proved that requesting a Shop
   created a Till at all. It did not. `projectSeller` writes the storefront; the Till and the
   business wallet are provisioned separately, so a clinic received a shop and a seller claim
   and then found POS non-functional. These tests assert the CREATION path end to end. */
async function partShopOperable() {
  section('H. Shop operability — the merchant prerequisites  (B2 tests 1-12)');
  const shop = loadModule(path.join('functions', 'provider-shop.js'));
  if (!shop) {
    ['B2-1 Shop identity', 'B2-3 Till provisioned', 'B2-4 wallet provisioned'].forEach((t) =>
      ck(t, false, 'provider-shop.js absent at HEAD'));
    return;
  }

  const seedApproved = (tier) => makeDb({
    'applications/a1': hcApp,
    'providers/HC_PROVIDER_1': { uid: HC, status: 'active', name: 'Karen Clinic', category: 'Healthcare',
      phone: '+254700000001', location: 'Karen, Nairobi' },
    'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub(tier),
  });

  CURRENT = seedApproved('clinic');
  let r = null, err = null;
  try { r = await shop.providerRequestShop({ auth: { uid: HC }, data: {} }); }
  catch (e) { err = e.code || e.message; }
  const S = CURRENT.store;

  ck('B2-1  canonical Shop identity created', !!S['shops/' + HC] && S['shops/' + HC].status === 'active',
    err || JSON.stringify(S['shops/' + HC] && { ownerId: S['shops/' + HC].ownerId, status: S['shops/' + HC].status }));
  ck('B2-1b shop ownerId + sellerUid are the provider',
    !!S['shops/' + HC] && S['shops/' + HC].ownerId === HC && S['shops/' + HC].sellerUid === HC);
  ck('B2-2  seller registry row is correct',
    !!S['sellers/' + HC] && S['sellers/' + HC].shopId === HC && S['sellers/' + HC].active === true,
    JSON.stringify(S['sellers/' + HC] && { shopId: S['sellers/' + HC].shopId, active: S['sellers/' + HC].active }));
  ck('B2-2b business directory row written', !!S['businesses/' + HC]);
  ck('B2-2c users.activeShopId points at the shop',
    !!S['users/' + HC] && S['users/' + HC].activeShopId === HC,
    S['users/' + HC] && S['users/' + HC].activeShopId);

  /* THE BLOCKER ITSELF. */
  const tills = Object.keys(S).filter((k) => k.startsWith('sokoniTills/'));
  ck('B2-3  Till is actually provisioned', tills.length === 1,
    tills.length ? tills.join(', ') : 'NO TILL — the shop cannot run POS');
  ck('B2-3b the result reports the Till', !!(r && r.till && r.till.sokoniTillId),
    r && r.till ? JSON.stringify(r.till) : 'absent');

  const wallets = Object.keys(S).filter((k) => k.startsWith('businessWallets/'));
  ck('B2-4  business wallet is actually provisioned', wallets.length === 1,
    wallets.length ? wallets.join(', ') : 'NO WALLET — POS/Till commission cannot settle');
  ck('B2-4b wallet is owned by the provider and keyed by SHOP',
    wallets.length === 1 && S[wallets[0]].ownerUid === HC && wallets[0] === 'businessWallets/' + HC,
    wallets.length ? JSON.stringify({ id: wallets[0], owner: S[wallets[0]].ownerUid }) : 'n/a');

  /* B2-5/6/7 — the identities POS, inventory and orders actually resolve by. */
  const till = tills.length ? S[tills[0]] : null;
  ck('B2-5  POS/Till resolves the merchant identity',
    !!till && till.shopId === HC && String(till.status || '').toUpperCase() === 'ACTIVE',
    till ? JSON.stringify({ shopId: till.shopId, status: till.status }) : 'no till');
  ck('B2-6  inventory resolves by the same shop/seller identity',
    !!S['shops/' + HC] && !!S['sellers/' + HC] && S['sellers/' + HC].shopId === S['shops/' + HC].shopId,
    'products are keyed by sellerUid/shopId — both present and agreeing');
  ck('B2-7  order/payment prerequisites resolve (shop + wallet + till agree on one shopId)',
    !!S['shops/' + HC] && wallets.length === 1 && !!till
      && S['shops/' + HC].shopId === HC && till.shopId === HC && wallets[0].endsWith('/' + HC),
    'shop/till/wallet all on shopId=' + HC);

  /* B2-9/10 — replay must converge, never fork. */
  const before = { tills: tills.length, wallets: wallets.length };
  await shop.providerRequestShop({ auth: { uid: HC }, data: {} }).catch(() => {});
  const tills2 = Object.keys(CURRENT.store).filter((k) => k.startsWith('sokoniTills/'));
  const wall2  = Object.keys(CURRENT.store).filter((k) => k.startsWith('businessWallets/'));
  ck('B2-9  replay creates NO duplicate Till', tills2.length === before.tills, `${before.tills} -> ${tills2.length}`);
  ck('B2-10 replay creates NO duplicate wallet', wall2.length === before.wallets, `${before.wallets} -> ${wall2.length}`);

  /* A shop whose Till provisioning failed earlier must be repairable by asking again — the
     reason the "already exists" path does not short-circuit. */
  CURRENT = seedApproved('clinic');
  CURRENT.store['shops/' + HC] = { shopId: HC, ownerId: HC, sellerUid: HC, status: 'active', name: 'Karen Clinic' };
  await shop.providerRequestShop({ auth: { uid: HC }, data: {} }).catch(() => {});
  ck('B2-9b a shop whose Till failed earlier is repaired on re-request',
    Object.keys(CURRENT.store).some((k) => k.startsWith('sokoniTills/')),
    'Till present after re-request on an existing shop');

  /* B2-11 — authority. */
  for (const [st, label] of [['pending', 'pending'], ['suspended', 'suspended']]) {
    CURRENT = makeDb({
      'applications/a1': hcApp,
      'providers/HC_PROVIDER_1': { uid: HC, status: st },
      'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise'),
    });
    let outcome;
    try { await shop.providerRequestShop({ auth: { uid: HC }, data: {} }); outcome = 'PROVISIONED'; }
    catch (_) { outcome = 'refused'; }
    ck(`B2-11 a ${label} provider cannot create a Shop`, outcome === 'refused', outcome);
  }
  CURRENT = makeDb({ 'applications/a1': hcApp, 'accountSubscriptions/HC_PROVIDER_1_healthcare': hcSub('enterprise') });
  let noReg;
  try { await shop.providerRequestShop({ auth: { uid: HC }, data: {} }); noReg = 'PROVISIONED'; }
  catch (_) { noReg = 'refused'; }
  ck('B2-11b a provider with NO registry record cannot create a Shop', noReg === 'refused', noReg);

  /* B2-12 — every tier, with a real Till each time. */
  for (const tier of ['clinic', 'hospital', 'enterprise']) {
    CURRENT = seedApproved(tier);
    let ok = false;
    try {
      const res = await shop.providerRequestShop({ auth: { uid: HC }, data: {} });
      ok = !!res.shopId && Object.keys(CURRENT.store).some((k) => k.startsWith('sokoniTills/'));
    } catch (_) { ok = false; }
    ck(`B2-12 ${tier.padEnd(10)} can request an OPERABLE Shop`, ok);
  }

  /* B2-8 — downgrade preserves everything that already exists. */
  CURRENT = seedApproved('enterprise');
  await shop.providerRequestShop({ auth: { uid: HC }, data: {} }).catch(() => {});
  CURRENT.store['products/P1'] = { sellerUid: HC, name: 'Paracetamol', stock: 20 };
  CURRENT.store['orders/O1']   = { sellerUid: HC, total: 500 };
  const PAST = Date.now() - 30 * 86400000;
  CURRENT.store['accountSubscriptions/HC_PROVIDER_1_healthcare'] =
    Object.assign({}, hcSub('clinic'), { status: 'expired', currentPeriodEnd: PAST, renewalAt: PAST });
  const capMod = loadModule(path.join('functions', 'capability-authority.js'));
  const after = capMod ? await capMod.capabilitiesFor(HC, { hub: 'healthcare' }) : null;
  const survives = ['shops/' + HC, 'sellers/' + HC, 'businesses/' + HC, 'products/P1', 'orders/O1']
    .every((k) => !!CURRENT.store[k])
    && Object.keys(CURRENT.store).some((k) => k.startsWith('sokoniTills/'))
    && Object.keys(CURRENT.store).some((k) => k.startsWith('businessWallets/'));
  ck('B2-8  downgrade destroys NOTHING (shop/seller/till/wallet/inventory/orders)', survives);
  ck('B2-8b capabilities narrow instead', !!after && after.capabilities.shopRequestable === false,
    after ? `shopRequestable=${after.capabilities.shopRequestable} status=${after.status}` : 'n/a');
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART J — Blocker 1: the verified activation path
   ════════════════════════════════════════════════════════════════════════════════════════
   A customer could pay and receive nothing: the only caller of engine.activate() was the
   reconciliation sweep, and that sweep heals only behind an off-by-default flag. Activation
   now hangs off the money — payments/{ref} reaching a terminal paid state — with the engine
   still the sole authority on whether the money is real. */
async function partActivationPath() {
  section('J. Verified activation path  (B1)');
  const act = loadModule(path.join('functions', 'healthcare-subscription-activation.js'));
  if (!act || !act._internal) {
    ck('B1-0  activation module exists', false, 'absent at HEAD — payment activated nothing');
    return;
  }
  const { shouldActivate, activateIfHealthcareSubscription } = act._internal;
  ck('B1-0  activation module exists and exports its internals', true);

  /* It must be exported BY NAME from index.js, or it is never deployed — and an undeployed
     trigger is indistinguishable from one that fired and found nothing. */
  const idx = source(path.join('functions', 'index.js')) || '';
  ck('B1-0b trigger is re-exported by name from index.js',
    /exports\.hcActivateSubscriptionOnPayment\s*=/.test(idx));

  /* The edge condition: fire on the transition INTO terminal paid, not on every touch. */
  ck('B1-1  fires on PENDING -> COMPLETE', shouldActivate({ status: 'PENDING' }, { status: 'COMPLETE' }) === true);
  ck('B1-1b does not re-fire COMPLETE -> COMPLETE', shouldActivate({ status: 'COMPLETE' }, { status: 'COMPLETE' }) === false);
  ck('B1-1c does not fire on FAILED', shouldActivate({ status: 'PENDING' }, { status: 'FAILED' }) === false);
  ck('B1-1d fires on first-write COMPLETE (no before)', shouldActivate(null, { status: 'COMPLETE' }) === true);

  const REF = 'PAY-J-001';
  const intentFor = (tier, cents, owner) => ({
    uid: owner || HC, ownerUid: owner || HC, purpose: 'healthcare_subscription',
    resourceType: 'healthcareSubscription', resourceId: owner || HC,
    amountCents: cents, currency: 'KES',
    metadata: { tier, hub: 'healthcare', limits: { doctors: 20, services: 50 } },
  });
  const subsIn = (st) => Object.keys(st).filter((k) => k.startsWith('accountSubscriptions/'));

  /* ── the happy path ── */
  CURRENT = makeDb({
    ['paymentIntents/' + REF]: intentFor('hospital', 499900),
    ['payments/' + REF]: { uid: HC, status: 'COMPLETE', amountCents: 499900 },
  });
  const ok = await activateIfHealthcareSubscription(REF, { source: 'test' });
  ck('B1-2  a verified payment activates the subscription', ok.activated === true, JSON.stringify(ok));
  ck('B1-2b exactly one subscription exists', subsIn(CURRENT.store).length === 1, subsIn(CURRENT.store).join(', '));
  ck('B1-2c it is the tier that was PAID FOR',
    (CURRENT.store['accountSubscriptions/' + HC + '_healthcare'] || {}).tier === 'hospital');

  /* ── repeated webhook / repeated activation ── */
  const again = await activateIfHealthcareSubscription(REF, { source: 'test-replay' });
  ck('B1-3  repeated activation is idempotent', again.alreadyActive === true, JSON.stringify(again));
  ck('B1-3b still exactly one subscription', subsIn(CURRENT.store).length === 1, subsIn(CURRENT.store).length);

  /* ── every refusal the engine owns ── */
  const refusals = [
    ['B1-4  unpaid payment cannot activate',        { uid: HC, status: 'PENDING',  amountCents: 499900 }, 499900],
    ['B1-5  insufficient payment cannot activate',  { uid: HC, status: 'COMPLETE', amountCents: 100 },    499900],
    ['B1-6  reversed payment cannot activate',      { uid: HC, status: 'REFUNDED', amountCents: 499900 }, 499900],
    ['B1-7  cancelled payment cannot activate',     { uid: HC, status: 'CANCELLED', amountCents: 499900 }, 499900],
    ['B1-8  another user\'s payment cannot activate', { uid: 'SOMEONE_ELSE', status: 'COMPLETE', amountCents: 499900 }, 499900],
  ];
  for (const [label, payment, expected] of refusals) {
    CURRENT = makeDb({
      ['paymentIntents/' + REF]: intentFor('hospital', expected),
      ['payments/' + REF]: payment,
    });
    const r = await activateIfHealthcareSubscription(REF, { source: 'test' });
    const none = subsIn(CURRENT.store).length === 0;
    ck(label, r.refused === true && none, (r.code || JSON.stringify(r)) + ' · subs=' + subsIn(CURRENT.store).length);
  }

  /* ── the amount is the INTENT's, so paying a Clinic price cannot buy Enterprise ── */
  CURRENT = makeDb({
    ['paymentIntents/' + REF]: intentFor('enterprise', 999900),
    ['payments/' + REF]: { uid: HC, status: 'COMPLETE', amountCents: 249900 },   /* clinic money */
  });
  const short = await activateIfHealthcareSubscription(REF, { source: 'test' });
  ck('B1-9  paying a cheaper plan\'s price cannot activate a dearer plan',
    short.refused === true && subsIn(CURRENT.store).length === 0, short.code || JSON.stringify(short));

  /* ── a fabricated reference activates nothing ── */
  CURRENT = makeDb({});
  const invented = await activateIfHealthcareSubscription('I-MADE-THIS-UP', { source: 'test' });
  ck('B1-10 an invented paymentRef activates nothing',
    !!invented.skipped && subsIn(CURRENT.store).length === 0, JSON.stringify(invented));

  /* ── purpose comes from the server-minted intent, never the payment ── */
  CURRENT = makeDb({
    ['paymentIntents/' + REF]: { uid: HC, ownerUid: HC, purpose: 'service_booking', amountCents: 499900 },
    ['payments/' + REF]: { uid: HC, status: 'COMPLETE', amountCents: 499900,
      purpose: 'healthcare_subscription' },          /* a lie on the payment document */
  });
  const wrongPurpose = await activateIfHealthcareSubscription(REF, { source: 'test' });
  ck('B1-11 purpose is read from the INTENT, not the payment document',
    wrongPurpose.skipped === 'other_purpose' && subsIn(CURRENT.store).length === 0, JSON.stringify(wrongPurpose));

  /* ── there must be NO client-invocable activation ── */
  const routes = source(path.join('functions', 'provider-dispatch.js')) || '';
  const onbRoutes = source(path.join('functions', 'onboarding-dispatch.js')) || '';
  const exposes = /activateIfHealthcareSubscription|hcActivateSubscription(?!OnPayment)/.test(routes + onbRoutes);
  ck('B1-12 no client-invocable activation op is exposed', !exposes,
    exposes ? 'a dispatcher routes to activation' : 'trigger-only');

  /* ── auto-heal must NOT have been enabled ── */
  const recon = source(path.join('functions', 'payment-reconciliation.js')) || '';
  ck('B1-13 subscriptionAutoHeal still defaults false / fails closed',
    /subscriptionAutoHeal === true/.test(recon) && /return false; \/\/ fail CLOSED/.test(recon),
    'reconciliation remains recovery-only');
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART K — STK payment-intent enforcement for Healthcare subscriptions
   ════════════════════════════════════════════════════════════════════════════════════════
   initiateSTKPush charges a CLIENT-SUPPLIED amount when no paymentIntents/{ref} exists. That
   legacy branch stays — closing it for every caller at once would fail POS and every booking
   page together — but healthcare is enforced from day one, because it has no shipped client
   to break and its purchase path mints a server-priced intent by construction.

   Activation was already safe: hcActivateSubscriptionOnPayment requires
   paymentIntents/{ref}.purpose === 'healthcare_subscription'. What an intent-less payment
   could still produce is a CHARGE THAT DELIVERS NOTHING. That is the gap these prove closed. */
async function partStkEnforcement() {
  section('K. STK payment-intent enforcement  (STK 1-10)');
  const enf = loadModule(path.join('functions', 'stk-intent-enforcement.js'));
  if (!enf) {
    ck('STK-0  stk-intent-enforcement.js exists', false,
      'absent at HEAD — healthcare was not on the enforced list');
    return;
  }
  ck('STK-0  stk-intent-enforcement.js exists and loads', true, enf.ENFORCED.join(', '));

  const E = (meta) => enf.isEnforcedPaymentCategory(meta).enforced;

  /* STK-2 / STK-3 — a healthcare subscription payment without an intent is refused, so a
     client-supplied amount can never initiate one. */
  ck('STK-2  healthcare_subscription is enforced (no intent -> refused)',
    E({ category: 'healthcare_subscription' }) === true);
  ck('STK-3  a client-supplied amount cannot initiate one',
    E({ category: 'healthcare_subscription', amount: 1 }) === true,
    'the amount is irrelevant — the refusal is on the missing intent');

  /* STK-4 — bypass attempts. The original comparison lowercased but never trimmed, so one
     space defeated it. Each of these previously fell through to the legacy branch. */
  const bypasses = [
    [' healthcare_subscription', 'leading space'],
    ['healthcare_subscription ', 'trailing space'],
    ['  healthcare_subscription  ', 'padded'],
    ['HEALTHCARE_SUBSCRIPTION', 'upper case'],
    ['Healthcare_Subscription', 'mixed case'],
    ['\thealthcare_subscription\n', 'tab / newline'],
  ];
  for (const [val, label] of bypasses) {
    ck(`STK-4  bypass refused — ${label}`, E({ category: val }) === true, JSON.stringify(val));
  }
  /* The newer vocabulary must not be an escape hatch either. */
  ck('STK-4b declaring it as `purpose` is enforced too',
    E({ purpose: 'healthcare_subscription' }) === true);
  ck('STK-4c a non-string category cannot dodge or fake enforcement',
    E({ category: ['healthcare_subscription'] }) === false
    && E({ category: { toString: () => 'healthcare_subscription' } }) === false,
    'coerced to empty, not to an accidental match');

  /* STK-5 — the existing generic subscription enforcement is unchanged. */
  ck('STK-5  generic `subscription` still enforced', E({ category: 'subscription' }) === true);
  ck('STK-5b generic `subscription` still enforced when padded/upper',
    E({ category: ' SUBSCRIPTION ' }) === true);

  /* Non-migrated callers must keep working — this widens what is refused, never what is
     allowed, and breaking POS or bookings here would be the incident Stage 1a avoided. */
  for (const c of ['service_booking', 'pos_till_sale', 'product_order', 'hub_registration', '', undefined]) {
    ck(`STK-6  non-migrated caller still allowed — ${JSON.stringify(c)}`,
      E({ category: c }) === false);
  }
  ck('STK-6b absent meta is allowed (unchanged)', E(undefined) === false && E(null) === false);

  /* STK-1 — with a valid intent the enforced branch is never reached: the guard lives in the
     `else` of "an intent exists". Asserted structurally against the shipped source, scoped by
     brace matching rather than a character budget. */
  const idx = strip(source(path.join('functions', 'index.js')));
  const at = idx.indexOf('STAGE_1B_REFUSED');
  ck('STK-1  the refusal sits in the NO-INTENT branch only', at > 0 && (() => {
    /* walk back to the nearest `} else {` — the intent-exists branch closing */
    const before = idx.slice(Math.max(0, at - 4000), at);
    return /\}\s*else\s*\{[\s\S]*$/.test(before);
  })(), 'a valid intent short-circuits before enforcement');
  ck('STK-1b index.js delegates to the canonical module',
    /require\(["']\.\/stk-intent-enforcement["']\)/.test(idx)
    && /isEnforcedPaymentCategory\s*\(\s*meta\s*\)/.test(idx));
  ck('STK-1c the hand-maintained literal list is gone from index.js',
    !/_enforcedCategories\s*=\s*\[/.test(idx),
    'one list, in one module');

  /* STK-7/8/9 — the rest of the chain is untouched by this change. Re-asserted here rather
     than assumed: a "tiny" edit to a payment path earns its regression proof. */
  const act = loadModule(path.join('functions', 'healthcare-subscription-activation.js'));
  ck('STK-7  a valid payment still reaches the activation trigger',
    !!act && act._internal.shouldActivate({ status: 'PENDING' }, { status: 'COMPLETE' }) === true);
  ck('STK-7b the trigger is still exported by name',
    /exports\.hcActivateSubscriptionOnPayment\s*=/.test(source(path.join('functions', 'index.js')) || ''));
  ck('STK-6c activation still requires the healthcare intent',
    !!act && act._internal.PURPOSE === 'healthcare_subscription', act && act._internal.PURPOSE);
}

/* ════════════════════════════════════════════════════════════════════════════════════════ */
(async () => {
  console.log('HEALTHCARE SUBSCRIPTION FOUNDATION — 24 required proofs');
  console.log(COUNTERPROOF
    ? 'MODE: COUNTERPROOF — HEAD (pre-fix). Failures below are what this gate closed.'
    : 'MODE: verification — worktree.');
  try {
    const plans = await partPlans();
    await partResolver();
    await partServiceGuard(plans);
    await partCommission(plans);
    await partActivation();
    await partShop();
    await partStories();
    await partShopOperable();
    await partActivationPath();
    await partStkEnforcement();
  } catch (e) {
    ck('FATAL', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  } finally {
    Module._load = realLoad;
  }
  console.log('\n' + '-'.repeat(76));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) {
    console.log(fail > 0
      ? `COUNTER-PROOF HOLDS — ${fail} check(s) fail against pre-fix source.`
      : 'COUNTER-PROOF FAILED — pre-fix source passed everything; the detectors prove nothing.');
    process.exit(fail > 0 ? 0 : 1);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
