#!/usr/bin/env node
/* OB-6 — providerPublish must ask about the agreements that actually apply to the account.
 *
 *   node scripts/test-provider-agreement-role.js
 *   COUNTERPROOF=1 node scripts/test-provider-agreement-role.js   # PRE-FIX: hardcoded 'provider'
 *
 * THE STATE THIS REMOVES
 *     await require('./legal-agreements').assertLegalCompliance(uid, 'provider');
 *
 * `assertLegalCompliance` selects an agreement SET by role. Hardcoding 'provider' meant a
 * healthcare provider would be evaluated against the Service Provider set and never against
 * the Healthcare Provider Agreement or the Medical Compliance Declaration.
 *
 * WHY A NAIVE TEST WOULD PROVE NOTHING
 * Enforcement is dark per role (`legalConfig/enforcement`), so assertLegalCompliance returns
 * compliant for everybody today — fixed and pre-fix produce the identical outcome. A suite
 * that only called providerPublish and checked it succeeded would pass in BOTH runs and
 * establish nothing. So this suite does two things instead:
 *
 *   1. captures the role STRING actually passed to assertLegalCompliance; and
 *   2. runs the REAL legal-agreements module with enforcement forced ON **in the fixture**,
 *      so the compliance outcome genuinely differs by role.
 *
 * (2) is what makes the counter-proof real. The enforcement flag lives in a stub document —
 * production `legalConfig` is neither read nor written, and this gate does not enable
 * enforcement anywhere.
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

const DOC_U  = 'HEALTH_PROVIDER_uid_3c9';   /* a clinic */
const GEN_U  = 'GENERIC_PROVIDER_uid_7a2';  /* a plumber */
const NOAPP  = 'NO_APPLICATION_uid_5b1';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'au', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'DELETE' }),
};

let ENV;
const DB_PROXY = { collection: (c) => ENV.db.collection(c), batch: () => ENV.db.batch() };
function makeEnv({ docs = {} } = {}) {
  const data = { ...docs };
  const log = [];
  const apply = (p, doc, merge) => {
    const base = merge ? { ...(data[p] || {}) } : {};
    for (const [k, v] of Object.entries(doc)) { if (v && v.__s === 'DELETE') delete base[k]; else base[k] = v; }
    data[p] = base;
  };
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); apply(`${coll}/${id}`, doc, opts && opts.merge); return this; },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); apply(`${coll}/${id}`, doc, true); return this; },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
  });
  const mkColl = (coll, preds = []) => {
    const self = {
      doc: (id) => mkDoc(coll, id),
      async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
      where(f, o, v) { return mkColl(coll, preds.concat([[f, o, v]])); },
      limit() { return self; }, orderBy() { return self; },
      count() { return { get: async () => { const s = await self.get(); return { data: () => ({ count: s.size }) }; } }; },
      async get() {
        const match = (d) => preds.every(([f, o, v]) => {
          const a = d ? d[f] : undefined;
          if (o === '==') return a === v;
          if (o === 'in') return Array.isArray(v) && v.includes(a);
          return true;
        });
        const docs = Object.keys(data)
          .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') === -1)
          .filter((p) => match(data[p]))
          .map((p) => ({ id: p.slice(coll.length + 1), data: () => data[p], ref: mkDoc(coll, p.slice(coll.length + 1)) }));
        return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
      },
    };
    return self;
  };
  return { data, log,
    db: { collection: mkColl, batch() { const o = []; return { set(r, d, p) { o.push([r, d, p]); }, update(r, d) { o.push([r, d, { merge: true }]); }, async commit() { for (const [r, d, p] of o) await r.set(d, p); } }; } },
    auth: { async getUser(u) { return { uid: u, customClaims: {} }; }, async setCustomUserClaims() {} } };
}

/** PRE-FIX: the hardcoded role restored. Everything else identical. */
function prefixSource() {
  const s = fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8');
  const now = "  await require('./legal-agreements').assertLegalCompliance(uid, await _agreementRoleFor(uid));";
  const was = "  await require('./legal-agreements').assertLegalCompliance(uid, 'provider');";
  if (!s.includes(now)) throw new Error('call-site anchor not found — refusing to guess');
  const out = s.replace(now, was);
  if (out.includes('await _agreementRoleFor(uid))')) throw new Error('reconstruction did not take effect');
  return out;
}

/* Every role string handed to assertLegalCompliance, in order. */
let ROLES_ASKED = [];
let LEGAL = null, PO = null;

/* legal-agreements caches `legalConfig/enforcement` for 60 SECONDS in a module-level
   variable. The first publish in this run reads the fixture that existed then, and every
   later scenario silently reuses it — so section C's enforcement flag was never seen and
   six fail-closed assertions passed as "allowed" for a reason unrelated to the role.
   Reloading the module resets that cache. The require hook stays installed, so the fresh
   instance binds to the current fixture, and the wrapper reads LEGAL at call time. */
function freshLegal() {
  const f = path.join(FUNCTIONS_DIR, 'legal-agreements.js');
  delete require.cache[require.resolve(f)];
  LEGAL = require(f);
}
function load() {
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => DB_PROXY, FieldValue, Timestamp: { fromDate: (d) => +d } };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 's' }) };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    if (id === './availability') return { normalizeAvailabilityConfig: (_c, uid) => ({ uid }) };
    /* The REAL legal module, wrapped only to record which role it was asked about.
       Stubbing it out would make this suite assert on its own fixture instead of on
       ROLE_ALIASES and _catalogueFor actually resolving the healthcare set. */
    if (id === './legal-agreements') {
      const real = LEGAL;
      return Object.assign(Object.create(Object.getPrototypeOf(real) || Object.prototype), real, {
        assertLegalCompliance: async (uid, role) => { ROLES_ASKED.push(role); return real.assertLegalCompliance(uid, role); },
      });
    }
    return orig.apply(this, arguments);
  };
  const legalFile = path.join(FUNCTIONS_DIR, 'legal-agreements.js');
  delete require.cache[require.resolve(legalFile)];
  LEGAL = require(legalFile);

  let poFile = path.join(FUNCTIONS_DIR, 'provider-onboarding.js');
  if (COUNTERPROOF) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob6-'));
    poFile = path.join(dir, 'provider-onboarding.js');
    fs.writeFileSync(poFile, prefixSource());
    const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8');
    const sibs = new Set();
    for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9_-]+)'\)/g)) sibs.add(m[1]);
    for (const sib of sibs) {
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
  }
  delete require.cache[require.resolve(poFile)];
  PO = require(poFile)._h;
}

/* Acceptances for a role's catalogue, taken from the module's OWN definition. */
function acceptancesFor(uid, roleKey, opts = {}) {
  const set = [...LEGAL.CORE, ...(LEGAL.ROLE_AGREEMENTS[roleKey] || [])];
  const out = {};
  for (const a of set) {
    if (opts.omit && opts.omit.includes(a.id)) continue;
    const version = opts.staleFor === a.id ? '0.9' : LEGAL.DEFAULT_VERSION;
    out[`legalAcceptances/${uid}_${a.id}_${version}`] = {
      userId: uid, agreementId: a.id, agreementName: a.name, version, accepted: true, role: roleKey,
    };
  }
  return out;
}

const DRAFT = { profile: { name: 'Test Provider', category: 'clinic' }, coverage: { city: 'Nairobi' },
                pricing: {}, availability: {} };
/* `enforce` writes ONLY to the stub fixture. Production legalConfig is never touched. */
const seed = (uid, appDoc, acceptances, enforce) => makeEnv({ docs: Object.assign(
  { [`providerProfiles/${uid}`]: { uid, plan: 'free_trial', draft: DRAFT } },
  appDoc ? { [`applications/${uid}--a`]: appDoc } : {},
  acceptances || {},
  enforce ? { 'legalConfig/enforcement': enforce } : {},
) });

const HEALTH_APP = { uid: DOC_U, applicationId: DOC_U + '--a', role: 'health', type: 'healthcare',
                     status: 'approved', name: 'Westlands Clinic' };
const GEN_APP    = { uid: GEN_U, applicationId: GEN_U + '--a', role: 'provider', type: 'provider',
                     status: 'approved', name: 'Reliable Plumbing' };

const publish = async (uid) => {
  ROLES_ASKED = [];
  try { await PO.providerPublish({ auth: { uid, token: {} }, data: {} }); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? "PRE-FIX (hardcoded 'provider')" : 'current'));
  console.log('='.repeat(72));
  load();

  /* ═══ A — which role is asked about ═══ */
  console.log('\nA. the role handed to assertLegalCompliance');
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'));
  await publish(DOC_U);
  ck("A1  a healthcare provider is evaluated as 'health'  <- the defect",
    ROLES_ASKED[0] === 'health', JSON.stringify(ROLES_ASKED));
  ENV = seed(GEN_U, GEN_APP, acceptancesFor(GEN_U, 'provider'));
  await publish(GEN_U);
  ck("A2  a generic provider is still evaluated as 'provider'", ROLES_ASKED[0] === 'provider', JSON.stringify(ROLES_ASKED));
  ENV = seed(NOAPP, null, {});
  await publish(NOAPP);
  ck("A3  no application ⇒ 'provider' (an absence, not a guess)", ROLES_ASKED[0] === 'provider', JSON.stringify(ROLES_ASKED));

  /* ═══ B — the alias actually resolves the healthcare catalogue ═══ */
  console.log('\nB. health → healthcare resolves the right instruments');
  ck('B1  catalogueKeyFor maps health → healthcare', LEGAL.catalogueKeyFor('health') === 'healthcare');
  ENV = seed(DOC_U, HEALTH_APP, {});
  const c = await LEGAL.complianceFor(DOC_U, 'health');
  const ids = (c.required || []).map((x) => x.agreementId);
  ck('B2  the required set includes the Healthcare Provider Agreement', ids.includes('healthcare-provider-agreement'));
  ck('B3  ...and the Medical Compliance Declaration', ids.includes('medical-compliance-declaration'));
  ck('B4  ...and NOT the Service Provider Agreement', !ids.includes('service-provider-agreement'), ids.join(','));

  /* ═══ C — WITH ENFORCEMENT ON, the role changes the outcome ═══
     This is the section that makes the counter-proof meaningful: while enforcement is dark
     every publish succeeds regardless of role, so only here do fixed and pre-fix diverge. */
  console.log('\nC. with enforcement forced ON in the fixture');
  const ENF = { healthcare: true, provider: true };

  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'), ENF);
  freshLegal();
  let r = await publish(DOC_U);
  ck('C1  healthcare + full healthcare acceptance → ALLOWED', r.ok, r.ok ? 'ok' : r.message);

  ENV = seed(DOC_U, HEALTH_APP, {}, ENF);
  freshLegal();
  r = await publish(DOC_U);
  ck('C2  healthcare + NO acceptance → REFUSED (fail-closed)', !r.ok, r.code);

  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare', { omit: ['healthcare-provider-agreement'] }), ENF);
  freshLegal();
  r = await publish(DOC_U);
  ck('C3  healthcare missing ONE instrument → REFUSED', !r.ok, r.code);

  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare', { staleFor: 'medical-compliance-declaration' }), ENF);
  freshLegal();
  r = await publish(DOC_U);
  ck('C4  healthcare with an OUTDATED version → REFUSED', !r.ok, r.code);

  /* THE COUNTER-PROOF CASE. A healthcare account that accepted the PROVIDER set and nothing
     healthcare-specific. Correctly evaluated it is refused; under the hardcoded role it passes. */
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'provider'), ENF);
  freshLegal();
  r = await publish(DOC_U);
  ck('C5  healthcare holding only the PROVIDER set → REFUSED  <- the whole gate', !r.ok, r.code);

  ENV = seed(GEN_U, GEN_APP, acceptancesFor(GEN_U, 'provider'), ENF);
  freshLegal();
  r = await publish(GEN_U);
  ck('C6  a generic provider with the provider set → ALLOWED (unchanged)', r.ok, r.ok ? 'ok' : r.message);

  ENV = seed(GEN_U, GEN_APP, {}, ENF);
  freshLegal();
  r = await publish(GEN_U);
  ck('C7  ...and without it → REFUSED (generic fail-closed unchanged)', !r.ok, r.code);

  /* ═══ D — a client-written flag cannot substitute for the canonical record ═══ */
  console.log('\nD. the canonical acceptance record is the only evidence');
  ENV = seed(DOC_U, Object.assign({}, HEALTH_APP, {
    agreementAccepted: true, agreementVersion: '2026-09-07-lanes-mkt-ladder-pos-5pct',
  }), {}, ENF);
  freshLegal();
  r = await publish(DOC_U);
  ck('D1  agreementAccepted:true on the application does NOT satisfy compliance', !r.ok, r.code);
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'), ENF);
  ENV.data[`providerProfiles/${DOC_U}`].verified = true;   /* a forged profile flag */
  freshLegal();
  r = await publish(DOC_U);
  ck('D2  ...and a forged profile flag changes nothing either way', r.ok, r.ok ? 'ok' : r.message);

  /* ═══ E — the earlier gates are intact ═══ */
  console.log('\nE. OB-1 / OB-3 / OB-5 remain intact');
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'));
  await publish(DOC_U);
  const reg = ENV.data[`providers/${DOC_U}`] || {};
  ck('E1  OB-1: publishing an unapproved provider does not activate them',
    reg.status !== 'active' && reg.acceptsBookings !== true, reg.status);
  ck('E2  OB-1: ...and mints no provider claim', !ENV.log.some((e) => e.op === 'MINT_CLAIM'));
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'));
  ENV.data[`providers/${DOC_U}`] = { uid: DOC_U, providerId: 'PRV-S1', status: 'suspended', searchable: false };
  await publish(DOC_U);
  ck('E3  OB-5: a suspended provider stays suspended through publish',
    (ENV.data[`providers/${DOC_U}`] || {}).status === 'suspended', (ENV.data[`providers/${DOC_U}`] || {}).status);
  ck('E4  OB-3: no verification record is written by publishing',
    !ENV.log.some((e) => e.coll === 'providerVerification'));

  /* ═══ F — enforcement is NOT enabled by this gate ═══ */
  console.log('\nF. enforcement remains dark outside the fixture');
  ENV = seed(DOC_U, HEALTH_APP, {});            /* NO legalConfig doc at all */
  freshLegal();
  r = await publish(DOC_U);
  ck('F1  with no enforcement flag, a missing acceptance still publishes (dark-launched)', r.ok, r.ok ? 'ok' : r.message);
  ck('F2  ...and the role asked about is still the correct one', ROLES_ASKED[0] === 'health', JSON.stringify(ROLES_ASKED));
  const poSrc = fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8');
  ck('F3  this gate writes nothing to legalConfig', !/collection\('legalConfig'\)/.test(poSrc));
  ck('F4  ...and does not call legalSetEnforcement', !/legalSetEnforcement/.test(poSrc));
  ck('F5  no agreement text or version was introduced here',
    !/DEFAULT_VERSION\s*=/.test(poSrc) && !/healthcare-provider-agreement'\s*:/.test(poSrc));

  /* ═══ G — scope ═══ */
  console.log('\nG. scope');
  ENV = seed(DOC_U, HEALTH_APP, acceptancesFor(DOC_U, 'healthcare'));
  await publish(DOC_U);
  const touched = new Set(ENV.log.map((e) => e.coll).filter(Boolean));
  ck('G1  no healthProviders write', !touched.has('healthProviders'), [...touched].join(','));
  ck('G2  no legalAcceptances / legalConfig / payment / booking write',
    !['legalAcceptances', 'legalConfig', 'payments', 'paymentIntents', 'providerBookings',
      'healthAppointments', 'healthRecords'].some((x) => touched.has(x)), [...touched].join(','));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the defect this gate removes)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
