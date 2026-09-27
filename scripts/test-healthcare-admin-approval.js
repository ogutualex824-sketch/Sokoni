#!/usr/bin/env node
/* Healthcare approval authority — AdminOS reviews healthcare through the CANONICAL primitive.
 *
 *   node scripts/test-healthcare-admin-approval.js
 *
 * No emulator, no credentials: firebase-admin/firebase-functions are stubbed, the REAL
 * `applicationDecide` callable and the REAL applicationLifecycle trigger are captured as the
 * module registers them, and every assertion is on what was actually written or minted.
 *
 * WHAT THIS GATE FOUND
 * There was never a missing healthcare approval *system*. AdminOS already has an
 * "Applications & Approvals" panel that calls `applicationList` / `applicationDecide` /
 * `applicationReconcile`, and every layer below it is role-agnostic:
 *
 *   • applicationList reads `applications` UNFILTERED and filters in memory, computing
 *     role as `a.role || resolveRole(a).role` — healthcare included.
 *   • _appCard renders whatever role comes back; the Approve / Reject / Suspend / Request-info
 *     buttons are not role-conditional.
 *   • applicationDecide gates on `_requireAdmin` and acts on an application by id.
 *
 * The ONLY gap was that the panel's role filter offered seller / provider / driver and not
 * `health`, so healthcare applications were reviewable only under "All roles" and the queue
 * looked empty when filtered. That is a one-option change in admin-os.html; this suite exists
 * to prove the rest of the chain genuinely works for healthcare rather than to assume it.
 *
 * The unauthorized path is counter-proved, not just the authorized one (Part A).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const APPLICANT = 'HC_APPLICANT_uid_88a';
const ADMIN     = 'ADMIN_1';
const SUPER     = 'SUPER_1';
const OUTSIDER  = 'RANDO_1';
const APP_ID    = `${APPLICANT}--health`;

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
        async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen-' + coll }; },
        where() { return this; }, limit() { return this; }, orderBy() { return this; },
        async get() {
          /* Serve documents ONLY for the collections a query legitimately reads here.
             Serving the fixture for EVERY collection made genProviderId's
             providers.where(providerId==…) look permanently collided, so projectProvider
             threw "Could not generate a unique provider ID" and the authority assertions
             failed for a reason that had nothing to do with authority. `where()` is a no-op
             in this stub, so any other collection correctly reads as empty. */
          if (coll !== 'applications' && coll !== 'legalAcceptances') {
            return { docs: [], size: 0, empty: true, forEach() {} };
          }
          const docs = Object.keys(data)
            .filter((p) => p.startsWith(coll + '/'))
            .map((p) => ({ id: p.slice(coll.length + 1), data: () => data[p], ref: mkDoc(coll, p.slice(coll.length + 1)) }));
          return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
        },
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

let TRIGGER = null, EXPORTS = null, LEGAL = null;

/* The canonical acceptance set for a healthcare applicant, derived from the module's OWN
   catalogue rather than hardcoded — if legal adds a Data Processing Agreement to the
   healthcare set, this fixture follows it instead of silently testing a stale list.
   `legalAgreements` is empty in production and in this fixture, so every version is the
   catalogue DEFAULT_VERSION. */
function acceptanceDocsFor(uid, opts = {}) {
  const req = [...LEGAL.CORE, ...LEGAL.ROLE_AGREEMENTS[LEGAL.catalogueKeyFor('health')]];
  const out = {};
  req.forEach((a) => {
    if (opts.omit && opts.omit.includes(a.id)) return;
    const version = (opts.staleFor === a.id) ? '0.9' : LEGAL.DEFAULT_VERSION;
    out[`legalAcceptances/${uid}_${a.id}_${version}`] = {
      userId: uid, agreementId: a.id, agreementName: a.name, version,
      accepted: true, acceptedAt: 1757700000000, role: 'health',
      agreementHash: 'hash-' + a.id, signatureType: 'typed',
    };
  });
  return out;
}
function loadLifecycle() {
  TRIGGER = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => { TRIGGER = h; return h; } };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }) };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    return orig.apply(this, arguments);
  };
  const file = path.join(FUNCTIONS_DIR, 'application-lifecycle.js');
  delete require.cache[require.resolve(file)];
  try {
    /* Pre-load legal-agreements WHILE THE STUBS ARE INSTALLED. application-lifecycle
       requires it lazily, at call time, by which point the hook is gone — so without
       this the real module loads against an uninitialised firebase-admin, throws, and
       the healthcare gate reports "could not be verified". That is the fail-closed
       branch doing its job, but it would mean the suite never exercises the SUCCESS
       path. `_db()` is `() => getFirestore()`, so the cached module resolves ENV.db
       freshly on every call and follows each fixture. */
    LEGAL = require(path.join(FUNCTIONS_DIR, 'legal-agreements.js'));
    EXPORTS = require(file);
  } finally { Module.prototype.require = orig; }
  if (!TRIGGER) throw new Error('trigger handler was never registered');
  if (!EXPORTS.applicationDecide) throw new Error('applicationDecide was never exported');
  return EXPORTS;
}

/** Call the REAL callable the AdminOS button calls. */
async function decide(actor, claims, decision, appId = APP_ID) {
  const req = { auth: actor ? { uid: actor, token: claims || {} } : null, data: { applicationId: appId, decision } };
  try { return { ok: true, res: await EXPORTS.applicationDecide(req) }; }
  catch (e) { return { ok: false, code: e.code || 'unknown', message: e.message }; }
}

/** The Firestore trigger that fires on the write applicationDecide just made. */
async function fireTrigger(appId = APP_ID) {
  const cur = ENV.data[`applications/${appId}`];
  const ref = { async set(patch, opts) { ENV.log.push({ op: 'set', coll: 'applications', id: appId, doc: patch, opts }); ENV.data[`applications/${appId}`] = { ...(ENV.data[`applications/${appId}`] || {}), ...patch }; } };
  await TRIGGER({ params: { appId }, data: { after: { exists: true, ref, data: () => cur } } });
}

const HEALTH_APP = (over = {}) => ({
  applicationId: APP_ID, uid: APPLICANT,
  type: 'healthcare', role: 'health',
  name: 'Westlands Family Clinic', category: 'clinic', categoryLabel: 'Clinic',
  description: 'General outpatient and paediatrics.',
  phone: '0726043059', phoneNumber: '+254726043059',
  location: 'Westlands, Nairobi', city: 'Nairobi', area: 'Westlands',
  intakeVersion: 1, roleResolvedBy: 'declared',
  agreementAccepted: true, agreementVersion: 'v1',
  status: 'pending', ...over,
});

/** seed(applicationOverrides, extraDocs) — extraDocs carries the legalAcceptances fixture. */
const seed = (over, extraDocs) => makeEnv({
  docs: Object.assign({ [`applications/${APP_ID}`]: HEALTH_APP(over) }, extraDocs || {}),
  accounts: { [APPLICANT]: {}, [ADMIN]: { admin: true }, [SUPER]: { superAdmin: true }, [OUTSIDER]: {} },
});
/** A healthcare applicant who HAS accepted the canonical healthcare agreements. */
const seedCompliant = (over) => seed(over, acceptanceDocsFor(APPLICANT));

const minted  = () => ENV.log.filter(e => e.op === 'MINT_CLAIM');
const audits  = () => ENV.log.filter(e => e.op === 'add' && e.coll === 'adminAudit');
const wrote   = (c) => ENV.log.filter(e => e.coll === c || (e.path || '').startsWith(c + '/'));

(async () => {
  loadLifecycle();
  console.log('\nHEALTHCARE APPROVAL AUTHORITY — canonical applicationDecide\n' + '='.repeat(68));

  /* ═══ A — only an AdminOS administrator may decide (counter-proof) ═══ */
  console.log('\nA. the unauthorized path — who may NOT decide a healthcare application');
  ENV = seed(); let r = await decide(null, null, 'approve');
  ck('A1  unauthenticated caller REFUSED', !r.ok, r.code);
  ENV = seed(); r = await decide(OUTSIDER, {}, 'approve');
  ck('A2  ordinary signed-in user REFUSED', !r.ok, r.code);
  ENV = seed(); r = await decide(APPLICANT, {}, 'approve');
  ck('A3  the APPLICANT approving themselves REFUSED', !r.ok, r.code);
  ENV = seed(); r = await decide(OUTSIDER, { provider: true }, 'approve');
  ck('A4  an approved PROVIDER is not an administrator — REFUSED', !r.ok, r.code);
  ENV = seed(); r = await decide(OUTSIDER, { moderator: true }, 'approve');
  ck('A5  a moderator is not an administrator here — REFUSED', !r.ok, r.code);
  ENV = seed(); r = await decide(OUTSIDER, { seller: true, rider: true }, 'reject');
  ck('A6  ...and the same holds for REJECT, not just approve', !r.ok, r.code);
  ck('A7  a refused decision writes nothing at all',
    ENV.log.filter(e => e.op !== 'MINT_CLAIM').length === 0, ENV.log.length + ' write(s)');

  /* ═══ B — admin and superAdmin are both authoritative ═══ */
  console.log('\nB. the authorized path');
  ENV = seedCompliant(); r = await decide(ADMIN, { admin: true }, 'approve');
  ck('B1  an AdminOS administrator MAY approve', r.ok, r.ok ? 'ok' : r.code + ': ' + r.message);
  ck('B2  ...the application is stamped approved, decidedBy the actor',
    (ENV.data[`applications/${APP_ID}`] || {}).status === 'approved' &&
    (ENV.data[`applications/${APP_ID}`] || {}).decidedBy === ADMIN);
  ck('B3  ...and an immutable adminAudit record is written',
    audits().length === 1 && audits()[0].doc.action === 'application_approve',
    audits()[0] && audits()[0].doc.action);
  ck('B4  ...naming the actor and the subject',
    !!audits()[0] && audits()[0].doc.applicationId === APP_ID && audits()[0].doc.targetUid === APPLICANT);

  ENV = seedCompliant(); r = await decide(SUPER, { superAdmin: true }, 'approve');
  ck('B5  a SuperAdmin is equally authoritative (existing AdminOS authority model)', r.ok, r.code);

  /* ═══ C — approval reaches providers/{uid} through HC-23 ═══ */
  console.log('\nC. approval provisions the canonical registry (HC-23 path)');
  ENV = seedCompliant();
  await decide(ADMIN, { admin: true }, 'approve');
  await fireTrigger();
  const prov = ENV.data[`providers/${APPLICANT}`];
  ck('C1  providers/{uid} is provisioned', !!prov);
  ck('C2  ...active and discoverable', !!prov && prov.status === 'active' && prov.searchable === true);
  ck('C3  ...carrying the applicant identity', !!prov && prov.name === 'Westlands Family Clinic');
  ck('C4  the provider claim is minted', minted().some(m => m.uid === APPLICANT && m.claims.provider === true));
  ck('C5  users.roles gains provider',
    JSON.stringify((ENV.data[`users/${APPLICANT}`] || {}).roles || '').includes('provider'));
  ck('C6  ZERO writes to healthProviders', wrote('healthProviders').length === 0, wrote('healthProviders').length);

  /* ═══ D — idempotency ═══ */
  console.log('\nD. a repeated approval is idempotent');
  const pid = prov.providerId;
  ENV.data[`providers/${APPLICANT}`] = { ...prov, rating: 4.8, reviewCount: 17 };
  await decide(ADMIN, { admin: true }, 'approve');
  await fireTrigger();
  const prov2 = ENV.data[`providers/${APPLICANT}`];
  ck('D1  same providerId', prov2.providerId === pid, prov2.providerId);
  ck('D2  rating and history not reset', prov2.rating === 4.8 && prov2.reviewCount === 17);
  ck('D3  still active', prov2.status === 'active');
  ck('D4  still zero healthProviders writes', wrote('healthProviders').length === 0);

  /* ═══ E — rejection ═══ */
  console.log('\nE. rejection');
  ENV = seedCompliant();
  r = await decide(ADMIN, { admin: true }, 'reject');
  await fireTrigger();
  ck('E1  an administrator may reject', r.ok, r.code);
  ck('E2  ...the application is stamped rejected',
    (ENV.data[`applications/${APP_ID}`] || {}).status === 'rejected');
  ck('E3  ...no active provider is created',
    !ENV.data[`providers/${APPLICANT}`] || ENV.data[`providers/${APPLICANT}`].status !== 'active');
  ck('E4  ...and it is audited', audits().some(a => a.doc.action === 'application_reject'));

  /* ═══ F — the agreement gate applies to healthcare like every other role ═══ */
  console.log('\nF. healthcare is gated on the CANONICAL acceptance, not the Seller boolean');
  /* F1 is the one that matters: the application carries agreementAccepted:true AND the
     Seller Agreement version — exactly what hub-register.js used to write for a hospital —
     and it must still be refused, because that instrument is not the healthcare one. */
  ENV = seed({ agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct' });
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F1  Seller Agreement acceptance is NOT substituted for healthcare  <- the whole point',
    !r.ok && r.code === 'failed-precondition', r.code);
  ck('F2  ...and the refusal says so, so a reviewer is not left guessing',
    !r.ok && /Seller Agreement does not satisfy/i.test(r.message || ''), (r.message || '').slice(0, 80));

  ENV = seed();                                   /* no acceptances at all */
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F3  no canonical acceptance → REFUSED', !r.ok && r.code === 'failed-precondition', r.code);

  /* Partial acceptance must not pass: dropping ONE required instrument is enough. */
  ENV = seed({}, acceptanceDocsFor(APPLICANT, { omit: ['healthcare-provider-agreement'] }));
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F4  missing the Healthcare Provider Agreement → REFUSED', !r.ok, r.code);
  ENV = seed({}, acceptanceDocsFor(APPLICANT, { omit: ['medical-compliance-declaration'] }));
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F5  missing the Medical Compliance Declaration → REFUSED', !r.ok, r.code);

  /* An acceptance of a SUPERSEDED version is not an acceptance of the current one. */
  ENV = seed({}, acceptanceDocsFor(APPLICANT, { staleFor: 'healthcare-provider-agreement' }));
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F6  an OUTDATED version → REFUSED (version semantics preserved)', !r.ok, r.code);

  ENV = seedCompliant();
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F7  full canonical acceptance → APPROVED', r.ok, r.ok ? 'ok' : r.message);

  /* THE ROLE-ALIAS GUARD. ROLE_AGREEMENTS is keyed 'healthcare'; applications carry role
     'health'. Without the alias, _catalogueFor('health') finds no role set and returns the
     5 CORE documents only — so an applicant who accepted nothing but the core policies
     would be reported COMPLIANT and approved as a clinician, with both healthcare
     instruments silently omitted. Accepting CORE alone must therefore still be refused.
     This fails the moment the alias is removed, without needing to mutate the source. */
  const coreOnly = {};
  LEGAL.CORE.forEach((a) => {
    coreOnly[`legalAcceptances/${APPLICANT}_${a.id}_${LEGAL.DEFAULT_VERSION}`] = {
      userId: APPLICANT, agreementId: a.id, agreementName: a.name,
      version: LEGAL.DEFAULT_VERSION, accepted: true, role: 'health',
    };
  });
  ENV = seed({}, coreOnly);
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F7b CORE policies alone → REFUSED  <- the health→healthcare alias is load-bearing',
    !r.ok && /healthcare/i.test(r.message || ''), r.code);

  /* The remedies must keep working, or a reviewer cannot clear a stuck queue. */
  ENV = seed(); r = await decide(ADMIN, { admin: true }, 'reject');
  ck('F8  reject still works without acceptance', r.ok, r.code);
  ENV = seed(); r = await decide(ADMIN, { admin: true }, 'request_info');
  ck('F9  request_info still works without acceptance', r.ok, r.code);

  /* A rejected application must not become approvable by editing acceptance fields on the
     application document — the fields the CLIENT can write are not the authority. */
  ENV = seed({ status: 'rejected', agreementAccepted: true,
               agreementVerifiedAt: 1, agreementVerifiedVersion: '1.0' });
  r = await decide(ADMIN, { admin: true }, 'approve');
  ck('F10 client-written acceptance fields cannot rescue an approval', !r.ok, r.code);

  /* The bridge must READ legalAcceptances, never write one. */
  ENV = seedCompliant();
  await decide(ADMIN, { admin: true }, 'approve');
  ck('F11 approving writes NO legalAcceptances record (one acceptance database, not two)',
    ENV.log.filter(e => e.coll === 'legalAcceptances' || (e.path || '').startsWith('legalAcceptances/')).length === 0);

  /* Non-health roles keep the previous contract exactly. */
  const SELLER = 'SELLER_X';
  ENV = makeEnv({
    docs: { [`applications/${SELLER}--s`]: {
      applicationId: `${SELLER}--s`, uid: SELLER, type: 'seller', role: 'seller', name: 'Shop X',
      phone: '0722543212', phoneNumber: '+254722543212', location: 'Nairobi',
      intakeVersion: 1, roleResolvedBy: 'declared', agreementAccepted: true, status: 'pending' } },
    accounts: { [SELLER]: {}, [ADMIN]: { admin: true } },
  });
  r = await decide(ADMIN, { admin: true }, 'approve', `${SELLER}--s`);
  ck('F12 a SELLER still approves on the boolean — non-health behaviour unchanged', r.ok, r.code);
  ENV = makeEnv({
    docs: { [`applications/${SELLER}--s`]: {
      applicationId: `${SELLER}--s`, uid: SELLER, type: 'seller', role: 'seller', name: 'Shop X',
      phone: '0722543212', intakeVersion: 1, roleResolvedBy: 'declared', status: 'pending' } },
    accounts: { [SELLER]: {}, [ADMIN]: { admin: true } },
  });
  r = await decide(ADMIN, { admin: true }, 'approve', `${SELLER}--s`);
  ck('F13 ...and is still refused without it', !r.ok && r.code === 'failed-precondition', r.code);

  /* ═══ G — nothing outside this workflow is touched ═══ */
  console.log('\nG. scope');
  ENV = seedCompliant();
  await decide(ADMIN, { admin: true }, 'approve');
  await fireTrigger();
  ck('G1  no clinical, payment, booking or directory collection written', [
    'healthProviders', 'healthAppointments', 'healthRecords', 'healthPrescriptions',
    'healthProviderAvailability', 'payments', 'paymentIntents', 'providerBookings',
    'providerServices',
  ].every(c => wrote(c).length === 0));

  /* ═══ H — AdminOS can actually SEE healthcare ═══ */
  console.log('\nH. the AdminOS queue surfaces healthcare');
  ENV = seedCompliant();
  const listed = await EXPORTS.applicationList({ auth: { uid: ADMIN, token: { admin: true } }, data: { role: 'health' } });
  ck('H1  applicationList(role:health) returns the healthcare application',
    listed.ok && listed.items.length === 1 && listed.items[0].role === 'health',
    listed.items && listed.items.map(i => i.role).join(','));
  const listedSeller = await EXPORTS.applicationList({ auth: { uid: ADMIN, token: { admin: true } }, data: { role: 'seller' } });
  ck('H2  ...and is NOT returned under role:seller (the filter discriminates)',
    listedSeller.ok && listedSeller.items.length === 0);
  let denied = null;
  try { await EXPORTS.applicationList({ auth: { uid: OUTSIDER, token: {} }, data: {} }); }
  catch (e) { denied = e.code; }
  ck('H3  a non-administrator cannot LIST applications either', !!denied, denied);
  const adminOsHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  ck('H4  the AdminOS role filter offers Healthcare (the one UI gap this gate closed)',
    /<option value="health">/.test(adminOsHtml));

  /* ═══ J — both healthcare intakes carry the SAME agreement semantics ═══ */
  console.log('\nJ. intake convergence — neither path may use a different agreement policy');
  const hubSrc = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
  const hcSrc  = fs.readFileSync(path.join(ROOT, 'healthcare.html'), 'utf8');

  ck('J1  hub-register omits the Seller acknowledgement for healthcare categories',
    /catObj\.hub === 'healthcare' \? \{\} : \{[\s\S]{0,220}agreementAccepted:\s*true/.test(hubSrc));
  ck('J2  ...and still writes it for every other category (no collateral change)',
    /agreementVersion:\s*AGREEMENT_VERSION/.test(hubSrc));
  ck('J3  ...and tells a healthcare registrant the terms shown do not apply to them',
    /sreg_health_notice/.test(hubSrc) && /_syncHealthNotice/.test(hubSrc));
  ck('J4  healthcare.html still asserts NO agreement acceptance',
    !/agreementAccepted/.test(hcSrc));

  /* The behavioural half — a source regex alone would not prove the two shapes are
     treated alike. Build the application each intake now produces and decide on both. */
  const asHubRegister = { applicationId: APP_ID, uid: APPLICANT, type: 'business',
    category: 'hospital', categoryLabel: 'Hospital / Clinic', hub: 'healthcare',
    name: 'St Mary Clinic', phone: '0726043059', phoneNumber: '+254726043059',
    location: 'Nairobi', intakeVersion: 1, roleResolvedBy: 'keyword', status: 'pending' };
  const asHealthcareHtml = { applicationId: APP_ID, uid: APPLICANT, type: 'healthcare',
    role: 'health', category: 'clinic', name: 'St Mary Clinic', phone: '0726043059',
    phoneNumber: '+254726043059', location: 'Nairobi', intakeVersion: 1,
    roleResolvedBy: 'declared', status: 'pending' };

  for (const [label, appDoc] of [['hub-register', asHubRegister], ['healthcare.html', asHealthcareHtml]]) {
    ENV = makeEnv({ docs: { [`applications/${APP_ID}`]: appDoc },
                    accounts: { [APPLICANT]: {}, [ADMIN]: { admin: true } } });
    const rr = await decide(ADMIN, { admin: true }, 'approve');
    ck(`J5  ${label} shape → REFUSED without canonical acceptance`, !rr.ok, rr.code);
    ENV = makeEnv({ docs: Object.assign({ [`applications/${APP_ID}`]: appDoc }, acceptanceDocsFor(APPLICANT)),
                    accounts: { [APPLICANT]: {}, [ADMIN]: { admin: true } } });
    const rr2 = await decide(ADMIN, { admin: true }, 'approve');
    ck(`J6  ${label} shape → APPROVED with canonical acceptance`, rr2.ok, rr2.ok ? 'ok' : rr2.message);
  }

  /* ═══ K — the reviewer can SEE the evidence ═══ */
  console.log('\nK. AdminOS agreement evidence');
  ENV = seedCompliant();
  const lc = await EXPORTS.applicationList({ auth: { uid: ADMIN, token: { admin: true } }, data: { role: 'health' } });
  const item = lc.items[0] || {};
  ck('K1  the health row carries a legalCompliance block', !!item.legalCompliance);
  ck('K2  ...reporting compliant', item.legalCompliance && item.legalCompliance.compliant === true);
  ck('K3  ...listing the required instruments with versions',
    !!(item.legalCompliance && item.legalCompliance.required || []).length,
    (item.legalCompliance.required || []).length + ' required');
  ck('K4  ...and naming the healthcare instruments specifically',
    (item.legalCompliance.required || []).some((x) => x.agreementId === 'healthcare-provider-agreement') &&
    (item.legalCompliance.required || []).some((x) => x.agreementId === 'medical-compliance-declaration'));
  ck('K5  ...with the accepted records carrying version + hash',
    (item.legalCompliance.accepted || []).some((x) => x.version && x.hash));

  ENV = seed();  /* nothing accepted */
  const lc2 = await EXPORTS.applicationList({ auth: { uid: ADMIN, token: { admin: true } }, data: { role: 'health' } });
  ck('K6  a non-compliant applicant is shown as OUTSTANDING, not silently blank',
    lc2.items[0] && lc2.items[0].legalCompliance && lc2.items[0].legalCompliance.compliant === false &&
    lc2.items[0].legalCompliance.missing.length > 0,
    lc2.items[0] && lc2.items[0].legalCompliance && lc2.items[0].legalCompliance.missing.length);

  const aosSrc = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('K7  the AdminOS card renders an agreement line', /_agreementLine\(a\)/.test(aosSrc));
  ck('K8  ...distinguishing the server-verified stamp from the self-reported one',
    /verified at approval/.test(aosSrc) && /self-reported at submission/.test(aosSrc));

  /* ═══ I — mutation control: the refusals above must come from the GUARD ═══
     Part A passing proves the calls were refused. It does NOT prove `_requireAdmin` is what
     refused them — a typo in the fixture, a thrown HttpsError from somewhere else, or a
     callable that rejects everything would look identical. So neuter the guard in a copy of
     the source and re-run the same calls: they must now SUCCEED. If they still fail, Part A
     was measuring something other than authority. */
  console.log('\nI. mutation control — neuter _requireAdmin and Part A must collapse');
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'application-lifecycle.js'), 'utf8');
  const GUARD = `function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
}`;
  if (!src.includes(GUARD)) {
    ck('I0  the _requireAdmin anchor still matches the source', false,
       'ANCHOR ROTTED — this control is inert; re-derive it before trusting Part A');
  } else {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcadm-'));
    const file = path.join(dir, 'application-lifecycle.js');
    fs.writeFileSync(file, src.replace(GUARD, 'function _requireAdmin(req) { /* NEUTERED */ }'));
    /* Every sibling the module pulls in needs a shim, or the mutant fails to LOAD and the
       control reports "not detected" for the wrong reason. */
    /* `legal-agreements` MUST be in this list: application-lifecycle requires it lazily for
       the healthcare gate, and from the temp directory that resolves to nothing — the gate
       then takes its fail-closed branch and I2 reports `failed-precondition` from the
       AGREEMENT check rather than proving anything about the AUTHORITY guard. The shim
       re-exports the already-cached, stub-bound instance. */
    for (const sib of ['role-authority', 'seller-trial', 'sokoni-till', 'business-wallet',
                       'search-terms', 'notify', 'legal-agreements',
                       /* CHANGELOG 227: projectProvider stamps the healthcare category for role 'health' */
                       'healthcare-category']) {
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
    const origReq = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
      if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
      if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
      if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
      if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
      if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }) };
      if (id === './notify') return { notify: async () => {} };
      if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
      return origReq.apply(this, arguments);
    };
    let mutant = null, loadErr = null;
    try { delete require.cache[require.resolve(file)]; mutant = require(file); }
    catch (e) { loadErr = e.message; }
    finally { Module.prototype.require = origReq; }

    if (!mutant) {
      ck('I1  the mutant LOADS (a control that cannot load proves nothing)', false, loadErr);
    } else {
      ck('I1  the mutant loads', true);
      /* COMPLIANT fixture deliberately. With the authority guard removed, the ONLY thing
         that may still refuse this call is the guard under test — so the healthcare
         agreement gate must be satisfied, or I2 fails with `failed-precondition` from the
         agreement check and the control proves nothing about authority. A control that
         fails for a second reason is not a control. */
      ENV = seedCompliant();
      let mr = null;
      try { await mutant.applicationDecide({ auth: { uid: OUTSIDER, token: {} }, data: { applicationId: APP_ID, decision: 'approve' } }); mr = 'succeeded'; }
      catch (e) { mr = e.code || 'threw'; }
      ck('I2  with the guard removed, an ordinary user CAN approve  <- Part A was real',
        mr === 'succeeded', mr);
      ck('I3  ...and that write reaches the application document',
        (ENV.data[`applications/${APP_ID}`] || {}).status === 'approved');
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
