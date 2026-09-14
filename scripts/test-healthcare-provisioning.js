#!/usr/bin/env node
/* HC-23 — an approved healthcare application must land in the canonical registry.
 *
 *   node scripts/test-healthcare-provisioning.js
 *   COUNTERPROOF=1 node scripts/test-healthcare-provisioning.js    # run against the PRE-FIX source
 *
 * Drives the REAL applicationLifecycle trigger against stubbed SDKs, so every assertion is
 * on documents actually written and claims actually minted — the same harness shape as
 * test-approval-activates-shop.js, which exists because `seller` had this identical defect.
 *
 * THE STATE THIS REMOVES
 * `application-lifecycle.js` declared
 *
 *     const DELEGATED_ROLES = { health: 'healthProviders', legal: 'legalProviders' };
 *
 * and the branch that matched it pushed a receipt object and performed NO WRITE — and
 * because it matched, it also skipped projectProvider(). So an approved healthcare
 * applicant received `claims.provider` and landed in NO registry at all: approved,
 * claimed, invisible. The delegation target made it worse rather than better — the only
 * writer of `healthProviders/{uid}` is registerHealthProvider, which has no client invoker
 * anywhere in the repo, and the 2026-09-12 production census found zero real providers and
 * zero applications carrying role 'health'.
 *
 * ADR-014 makes `providers/{uid}` the canonical healthcare provider identity and retires
 * healthProviders. `health` therefore leaves DELEGATED_ROLES and falls through to
 * projectProvider() like every other provider. roleKeyFor already maps health → 'provider',
 * so the role field and the claim were always right; only the registry write was missing.
 *
 * WHY providers/{uid} IS NOT A NEW ELEVATION ROUTE
 * HC-01 closed self-minting on healthProviders. `providers` does not reopen it: its create
 * rule pins a client-written record to status 'pending', and its update rule forbids the
 * owner from touching status / verified / suspended / approved. Only an admin — or the
 * Admin SDK path exercised here — can set status:'active'. That is asserted as a fixture
 * expectation below (E), against the rules text, so a future widening of those rules trips
 * this suite as well as the HC-01 one.
 *
 * `legal` deliberately STAYS delegated and is the control in part G: legalProviders has a
 * live writer (functions/legal-hub.js), live readers, and a real onboarded firm.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const COUNTERPROOF = !!process.env.COUNTERPROOF;

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const DOC_A  = 'HEALTH_A_uid_4c1';          /* a clinician */
const FAC_B  = 'FACILITY_B_uid_9e2';        /* a facility  */
const LEGAL  = 'LEGAL_C_uid_3a7';           /* the control */
const ADMIN  = 'ADMIN_1';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'arrayUnion', values: v }),
  arrayRemove: (...v) => ({ __s: 'arrayRemove', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};

let ENV;
function makeEnv({ docs = {}, accounts = {} } = {}) {
  const data = { ...docs };
  const log = [];
  const apply = (p, doc, merge) => { data[p] = merge ? { ...(data[p] || {}), ...doc } : { ...doc }; };
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); apply(`${coll}/${id}`, doc, opts && opts.merge); },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); apply(`${coll}/${id}`, doc, true); },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
  });
  return {
    data, log,
    db: {
      collection: (coll) => ({
        doc: (id) => mkDoc(coll, id),
        async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
        where() { return this; }, limit() { return this; }, orderBy() { return this; },
        async get() { return { docs: [], empty: true, forEach() {} }; },
      }),
      batch() {
        const ops = [];
        return {
          set(ref, doc, opts) { ops.push([ref, doc, opts]); },
          update(ref, doc) { ops.push([ref, doc, { merge: true }]); },
          async commit() { ops.forEach(([ref, doc, opts]) => { log.push({ op: 'batch.set', path: ref.__path, doc }); apply(ref.__path, doc, opts && opts.merge); }); },
        };
      },
    },
    auth: {
      async getUser(uid) { if (!accounts[uid]) throw new Error('no user record'); return { uid, customClaims: accounts[uid] }; },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); accounts[uid] = claims; },
    },
  };
}

function loadTrigger(sourceOverride) {
  let captured = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { captured = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    /* Real module, loaded from functions/ so the counter-proof's temp-dir copy — which sits
       outside the repo's node_modules tree — still resolves it. Same for every sibling the
       trigger pulls in; a missing one aborts the run before a single assertion executes,
       which reads as "the counter-proof passed" if only the exit code is checked. */
    for (const sib of ['role-authority', 'seller-trial', 'sokoni-till', 'business-wallet']) {
      if (id === './' + sib) return orig.call(this, path.join(FUNCTIONS_DIR, sib + '.js'));
    }
    return orig.apply(this, arguments);
  };
  let file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  if (sourceOverride) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc23-'));
    file = path.join(dir, 'application-lifecycle.js');
    fs.writeFileSync(file, sourceOverride);
    fs.writeFileSync(path.join(dir, 'role-authority.js'),
      `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, 'role-authority.js'))});`);
    fs.writeFileSync(path.join(dir, 'search-terms.js'), 'module.exports={buildSearchTerms:()=>[],searchTerms:()=>[]};');
  }
  delete require.cache[require.resolve(file)];
  try { require(file); } finally { Module.prototype.require = orig; }
  if (!captured) throw new Error('trigger not registered');
  return captured;
}

/** The PRE-FIX source: health back in DELEGATED_ROLES, nothing else changed. */
function prefixSource() {
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');
  const now = "const DELEGATED_ROLES = { legal: 'legalProviders' };";
  const was = "const DELEGATED_ROLES = { health: 'healthProviders', legal: 'legalProviders' };";
  if (!src.includes(now)) throw new Error('current DELEGATED_ROLES not found — refusing to guess');
  return src.replace(now, was);
}

const CLINICIAN = (over = {}) => ({
  applicationId: `${DOC_A}--health`,
  uid: DOC_A, type: 'healthcare', role: 'health',
  name: 'Westlands Family Clinic', category: 'clinic', categoryLabel: 'Clinic',
  description: 'General outpatient, paediatrics, minor procedures.',
  phone: '0726043059', phoneNumber: '+254726043059',
  location: 'Westlands, Nairobi', city: 'Nairobi', area: 'Westlands',
  email: 'clinic@example.com',
  intakeVersion: 1, roleResolvedBy: 'keyword', status: 'pending_review',
  ...over,
});

async function fire(trigger, app, appId) {
  const id = appId || app.applicationId;
  const ref = { async set(patch, opts) { ENV.log.push({ op: 'set', coll: 'applications', id, doc: patch, opts }); ENV.data[`applications/${id}`] = { ...(ENV.data[`applications/${id}`] || {}), ...patch }; } };
  await trigger({ params: { appId: id }, data: { after: { exists: true, ref, data: () => app } } });
}

const minted     = () => ENV.log.filter(e => e.op === 'MINT_CLAIM');
const wroteColl  = (c) => ENV.log.filter(e => (e.coll === c) || (e.path || '').startsWith(c + '/'));

(async () => {
  console.log('\nSOURCE UNDER TEST: ' + (COUNTERPROOF ? 'PRE-FIX (health delegated)' : 'current functions/application-lifecycle.js'));
  console.log('='.repeat(72));
  const trigger = loadTrigger(COUNTERPROOF ? prefixSource() : null);

  /* ═══ A — a pending application provisions nothing ═══ */
  console.log('\nA. pending is not approved');
  ENV = makeEnv({ accounts: { [DOC_A]: {} } });
  await fire(trigger, CLINICIAN());
  ck('A1  pending mints no claim', minted().length === 0);
  ck('A2  ...and writes no providers record', !ENV.data[`providers/${DOC_A}`]);

  /* ═══ B — the applicant cannot approve themselves ═══ */
  console.log('\nB. the applicant cannot self-provision through the application path');
  ENV = makeEnv({ accounts: { [DOC_A]: {} } });
  await fire(trigger, CLINICIAN({ status: 'approved' }));               /* no decidedBy */
  ck('B1  self-approval provisions nothing', !ENV.data[`providers/${DOC_A}`]);
  ck('B2  ...and mints no claim', minted().length === 0);
  ENV = makeEnv({ accounts: { [DOC_A]: {}, [DOC_A]: {} } });
  await fire(trigger, CLINICIAN({ status: 'approved', decidedBy: DOC_A }));  /* decided by self */
  ck('B3  approving yourself by name provisions nothing', !ENV.data[`providers/${DOC_A}`]);

  /* ═══ C — admin approval reaches the canonical registry ═══ */
  console.log('\nC. an admin-approved healthcare application lands in providers/{uid}');
  ENV = makeEnv({ accounts: { [DOC_A]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, CLINICIAN({ status: 'approved', decidedBy: ADMIN }));
  const p = ENV.data[`providers/${DOC_A}`];
  const u = ENV.data[`users/${DOC_A}`];
  ck('C1  providers/{uid} EXISTS  <- the whole defect', !!p);
  ck('C2  ...status active', !!p && p.status === 'active', p && p.status);
  ck('C3  ...discoverable (searchable + isPublic + updatedAt the directory orders by)',
    !!p && p.searchable === true && p.isPublic === true && !!p.updatedAt);
  ck('C4  ...carries a providerId', !!p && !!p.providerId, p && p.providerId);
  ck('C5  ...keyed to the applicant uid', !!p && p.uid === DOC_A);
  ck('C6  ...carries the application identity, not an invented one',
    !!p && p.name === 'Westlands Family Clinic' && p.city === 'Nairobi');
  ck('C7  users.roles gains provider (the canonical role field)',
    !!u && !!u.roles && JSON.stringify(u.roles).includes('provider'), JSON.stringify(u && u.roles));
  ck('C8  the provider claim is minted', minted().some(m => m.uid === DOC_A && m.claims.provider === true),
    JSON.stringify(minted().map(m => m.claims)));

  /* ═══ D — healthProviders must receive ZERO writes ═══ */
  console.log('\nD. healthProviders is retired — it must never be written (ADR-014)');
  ck('D1  zero writes to healthProviders across the whole approval',
    wroteColl('healthProviders').length === 0, wroteColl('healthProviders').length + ' write(s)');
  ck('D2  zero writes to any clinical or payment collection', [
    'healthAppointments', 'healthRecords', 'healthPrescriptions', 'healthSlotLocks',
    'healthApptIdempotency', 'healthProviderAvailability', 'payments', 'paymentIntents',
    'providerBookings',
  ].every(c => wroteColl(c).length === 0));

  /* ═══ E — providers/{uid} is not a client elevation route ═══ */
  console.log('\nE. providers/{uid} does not reopen what HC-01 closed');
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const provBlock = rules.slice(rules.indexOf('match /providers/{providerId}'));
  const provRule = provBlock.slice(0, provBlock.indexOf('match /bookings/'));
  ck('E1  client create is pinned to status pending',
    /request\.resource\.data\.status == 'pending'/.test(provRule));
  ck('E2  owner update cannot touch status/verified/suspended/approved',
    /affectedKeys\(\)[\s\S]{0,40}hasAny\(\['status', 'verified', 'suspended', 'approved'\]\)/.test(provRule));
  ck('E3  only an admin may delete', /allow delete: if isAdmin\(\);/.test(provRule));

  /* ═══ F — idempotency and non-clobbering ═══ */
  console.log('\nF. re-approval is idempotent and never resets earned history');
  const firstProviderId = p && p.providerId;
  ENV.data[`providers/${DOC_A}`] = {
    ...ENV.data[`providers/${DOC_A}`],
    rating: 4.7, reviewCount: 31, jobsCompleted: 12, featured: true,
  };
  const logLenBefore = ENV.log.length;
  await fire(trigger, CLINICIAN({ status: 'approved', decidedBy: ADMIN }));
  const p2 = ENV.data[`providers/${DOC_A}`];
  ck('F1  still exactly one providers record, same providerId',
    !!p2 && p2.providerId === firstProviderId, p2 && p2.providerId);
  ck('F2  rating NOT reset', p2.rating === 4.7, p2.rating);
  ck('F3  reviewCount NOT reset', p2.reviewCount === 31, p2.reviewCount);
  ck('F4  jobsCompleted NOT reset', p2.jobsCompleted === 12, p2.jobsCompleted);
  ck('F5  featured flag (registry-owned) NOT reset', p2.featured === true, p2.featured);
  ck('F6  still status active after re-approval', p2.status === 'active');
  ck('F7  healthProviders still untouched on the second pass',
    ENV.log.slice(logLenBefore).filter(e => e.coll === 'healthProviders').length === 0);

  /* ═══ G — rejection, and the legal control ═══ */
  console.log('\nG. rejection retracts; legal stays delegated (control)');
  ENV = makeEnv({ accounts: { [FAC_B]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, CLINICIAN({ applicationId: `${FAC_B}--health`, uid: FAC_B, status: 'rejected', decidedBy: ADMIN }));
  ck('G1  a rejected healthcare application creates no provider',
    !ENV.data[`providers/${FAC_B}`] || ENV.data[`providers/${FAC_B}`].status !== 'active',
    ENV.data[`providers/${FAC_B}`] && ENV.data[`providers/${FAC_B}`].status);
  ck('G2  ...and writes nothing to healthProviders', wroteColl('healthProviders').length === 0);

  /* The control must genuinely REACH the decision. `intakeVersion` + `roleResolvedBy` are
     what tell the trigger this document is already normalised; without them it performs the
     intake pass and returns, and "no providers record" would be true because NOTHING ran —
     a pass for the wrong reason. G5 pins that down. `type:'legal'` (not 'professional') is
     what resolveRole's declared-type shortcut reads. */
  ENV = makeEnv({ accounts: { [LEGAL]: {}, [ADMIN]: { admin: true } } });
  await fire(trigger, {
    applicationId: `${LEGAL}--legal`, uid: LEGAL, type: 'legal',
    professionalType: 'Lawyer', role: 'legal', name: 'Counsel & Co',
    phone: '0722543212', phoneNumber: '+254722543212', location: 'Nairobi',
    intakeVersion: 1, roleResolvedBy: 'declared',
    status: 'approved', decidedBy: ADMIN,
  });
  ck('G3  legal is STILL delegated — no providers record (its registry is live elsewhere)',
    !ENV.data[`providers/${LEGAL}`]);
  ck('G4  ...and legal still gets its role claim', minted().some(m => m.uid === LEGAL),
    JSON.stringify(minted().map(m => m.uid)));
  ck('G5  ...and the decision actually RAN (guards G3 against passing vacuously)',
    !!(ENV.data[`applications/${LEGAL}--legal`] || {}).decisionAppliedFor,
    (ENV.data[`applications/${LEGAL}--legal`] || {}).decisionAppliedFor);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) {
    console.log('(counter-proof run: failures here are the POINT — they are the defect this fix removes)');
  }
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
