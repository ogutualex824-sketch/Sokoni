#!/usr/bin/env node
/* OB-1 — self-service publishing must not create an active, bookable provider.
 *
 *   node scripts/test-provider-publish-authority.js
 *   COUNTERPROOF=1 node scripts/test-provider-publish-authority.js   # against the PRE-FIX source
 *
 * SDKs are stubbed and the REAL providerPublish handler is invoked, so every assertion is on
 * documents actually written and claims actually minted.
 *
 * THE STATE THIS REMOVES
 * `providerPublish` wrote `providers/{uid}` with
 *
 *     status:'active', searchable:true, isPublic:true, acceptsBookings:true, available:true
 *
 * and minted `claims.provider = true`, on these preconditions only: a self-entered
 * `draft.profile`, a self-entered `draft.coverage`, a `plan` (a free trial qualifies), and
 * `assertLegalCompliance(uid,'provider')` — which is dark-launched per role and therefore
 * returns compliant for everybody today.
 *
 * No application. No administrator. No audit record. So the secured route
 *
 *     applications → AdminOS → applicationDecide → projectProvider → providers/{uid}
 *
 * governed one path into the canonical registry while this one reached the same document
 * unguarded — and `booking-service.js` asks only whether a provider is `active`
 * (ACTIVE_PROVIDER_STATES = ['active','approved']) before allowing a booking.
 *
 * THE INVARIANT UNDER TEST
 *   publishing writes CONTENT        — name, bio, categories, coverage, pricing, availability
 *   the lifecycle owns PUBLIC STATE  — status, searchable, isPublic, acceptsBookings, available
 *
 * This is deliberately NOT solved with a `verified` flag. Verification is a separate gate and
 * currently has no authoritative decision step at all (a submit step writes `pending_review`
 * and nothing ever moves it), so gating on it would gate on something no one can grant.
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
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELF = 'SELF_SERVICE_uid_51c';   /* never applied, never approved */
const OK_P = 'APPROVED_uid_7b2';       /* approved through the lifecycle */
const SUSP = 'SUSPENDED_uid_9d4';      /* approved, then suspended */

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'arrayUnion', values: v }),
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
  /* `where` FILTERS for real. As a no-op it made _genProviderId — which probes
     `providerProfiles.where('providerId','==',id)` for uniqueness — see every draft in
     the fixture as a collision, so publishing threw "Could not generate unique provider
     ID" and every downstream assertion reported on a document that was never written. A
     stub that ignores the predicate does not model the database; it models a different
     one. Only the operators these handlers actually use are implemented. */
  const mkColl = (coll, preds = []) => ({
    doc: (id) => mkDoc(coll, id),
    async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen-' + coll }; },
    where(field, op, value) { return mkColl(coll, preds.concat([[field, op, value]])); },
    limit() { return this; }, orderBy() { return this; },
    async get() {
      const match = (d) => preds.every(([f, op, v]) => {
        const a = d ? d[f] : undefined;
        if (op === '==') return a === v;
        if (op === '!=') return a !== v;
        if (op === 'in') return Array.isArray(v) && v.includes(a);
        throw new Error('stub: unsupported operator ' + op);
      });
      const docs = Object.keys(data)
        .filter((p) => p.startsWith(coll + '/') && p.slice(coll.length + 1).indexOf('/') === -1)
        .filter((p) => match(data[p]))
        .map((p) => ({ id: p.slice(coll.length + 1), data: () => data[p], ref: mkDoc(coll, p.slice(coll.length + 1)) }));
      return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
    },
  });
  return {
    data, log,
    db: {
      collection: mkColl,
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
      async getUser(uid) { return { uid, customClaims: accounts[uid] || {} }; },
      async setCustomUserClaims(uid, claims) { log.push({ op: 'MINT_CLAIM', uid, claims }); accounts[uid] = claims; },
    },
    accounts,
  };
}

/** The PRE-FIX source: unconditional activation and claim mint restored. */
function prefixSource() {
  let s = fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8');
  const stateNow = `    ...(_regSnap.exists ? {} : {
      status:          'pending_approval',
      searchable:      false,
      isPublic:        false,
      acceptsBookings: false,
      available:       false,
    }),`;
  const stateWas = `    status:      'active',
    searchable:  true,
    isPublic:    true,
    acceptsBookings: true,
    available:   true,`;
  if (!s.includes(stateNow)) throw new Error('state-field anchor not found — refusing to guess');
  s = s.replace(stateNow, stateWas);
  s = s.replace('    searchable: approved,', '    searchable: true,');
  const claimNow = `  if (approved) {
    await _auth().setCustomUserClaims(uid, { ...(await _auth().getUser(uid)).customClaims, provider: true, providerId });
  }`;
  if (!s.includes(claimNow)) throw new Error('claim anchor not found — refusing to guess');
  s = s.replace(claimNow, `  await _auth().setCustomUserClaims(uid, { ...(await _auth().getUser(uid)).customClaims, provider: true, providerId });`);
  return s;
}

let OPS = null;
function load(sourceOverride) {
  const orig = Module.prototype.require;
  /* The hook is installed and DELIBERATELY NOT RESTORED. providerPublish requires
     './availability' lazily, at call time — by which point a hook that was torn down
     after module load is gone, the real module loads against an uninitialised
     firebase-admin, and the publish throws `app/no-app` before writing a single field.
     Every assertion then reports on an empty document: A2–A5 "pass" because nothing was
     written, which is a pass for entirely the wrong reason. This suite performs all of its
     own requires above, so leaving the hook in place costs nothing. */
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }) };
    if (id === './notify') return { notify: async () => {} };
    /* search-terms pulls in the legacy firebase-admin namespace, which throws app/no-app
       under stubs. Without this the publish call fails before a single field is written and
       every assertion below reports on an empty document. */
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    if (id === './legal-agreements') return { assertLegalCompliance: async () => ({ enforced: false, compliant: true }) };
    if (id === './availability') return { normalizeAvailabilityConfig: (_c, uid) => ({ uid, normalised: true }) };
    return orig.apply(this, arguments);
  };
  let file = path.join(FUNCTIONS_DIR, 'provider-onboarding.js');
  if (sourceOverride) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
    file = path.join(dir, 'provider-onboarding.js');
    fs.writeFileSync(file, sourceOverride);
    for (const sib of ['legal-agreements', 'availability', 'notify']) {
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
  }
  delete require.cache[require.resolve(file)];
  let mod;
  mod = require(file);   /* hook stays installed — see the note above */
  OPS = mod._h;
  if (!OPS || !OPS.providerPublish) throw new Error('providerPublish not registered');
  return OPS;
}

const DRAFT = {
  profile: { name: 'Self Made Clinic', bio: 'We do everything.', type: 'business',
             category: 'healthcare', subcategory: 'clinic',
             qualifications: ['MBChB (self-entered)', 'Board Certified (self-entered)'] },
  coverage: { city: 'Nairobi', area: 'Westlands' },
  pricing: { fixed: { enabled: true, amount: 2500 } },
  availability: { mon: ['09:00-17:00'] },
};

const seedFor = (uid, registryDoc) => makeEnv({
  docs: Object.assign(
    { [`providerProfiles/${uid}`]: { uid, plan: 'free_trial', draft: DRAFT } },
    registryDoc ? { [`providers/${uid}`]: registryDoc } : {}
  ),
  accounts: { [uid]: {} },
});

const publish = async (uid) => {
  try { return { ok: true, res: await OPS.providerPublish({ auth: { uid, token: {} }, data: {} }) }; }
  catch (e) { if(process.env.DBG) console.log('   >>',e.code,'|',e.message); return { ok:false, code:e.code||'threw', message:e.message }; }
};
const minted = () => ENV.log.filter((e) => e.op === 'MINT_CLAIM');

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? 'PRE-FIX (unconditional activation)' : 'current functions/provider-onboarding.js'));
  console.log('='.repeat(72));
  load(COUNTERPROOF ? prefixSource() : null);

  /* ═══ A — a never-approved self-service provider ═══ */
  console.log('\nA. self-service, never applied, never approved');
  ENV = seedFor(SELF, null);
  let r = await publish(SELF);
  ck('A1  publishing still SUCCEEDS (drafting is legitimate and must keep working)', r.ok, r.ok ? 'ok' : r.code);
  const reg = ENV.data[`providers/${SELF}`] || {};
  ck('A2  ...but the registry row is NOT active  <- the bypass', reg.status !== 'active', reg.status);
  ck('A3  ...not searchable', reg.searchable !== true, String(reg.searchable));
  ck('A4  ...not public', reg.isPublic !== true, String(reg.isPublic));
  ck('A5  ...NOT BOOKABLE (booking-service reads exactly this)',
    reg.acceptsBookings !== true && !['active', 'approved'].includes(reg.status),
    reg.status + '/' + reg.acceptsBookings);
  ck('A6  ...and no provider claim is minted', minted().length === 0,
    JSON.stringify(minted().map((m) => m.claims)));
  const prof = ENV.data[`providerProfiles/${SELF}`] || {};
  ck('A7  the onboarding profile is not listed by providerSearchProviders either',
    prof.searchable !== true, String(prof.searchable));
  ck('A8  content IS written — the draft is preserved, not discarded',
    reg.name === 'Self Made Clinic' && !!reg.categories && !!ENV.data[`providerAvailability/${SELF}`]);

  /* ═══ B — credentials must not reach the public registry as authority ═══ */
  console.log('\nB. self-entered credentials');
  ck('B1  qualifications are NOT published into a publicly visible providers.skills',
    reg.isPublic !== true && reg.searchable !== true,
    'skills=' + JSON.stringify(reg.skills || null));
  ck('B2  ...and nothing was marked verified by the act of publishing',
    reg.verified !== true && (ENV.data[`providerProfiles/${SELF}`] || {}).verified !== true);

  /* ═══ C — an approved provider still operates ═══ */
  console.log('\nC. the canonical lifecycle still works end to end');
  ENV = seedFor(OK_P, { uid: OK_P, providerId: 'PRV-EXIST01', status: 'active',
                        searchable: true, isPublic: true, acceptsBookings: true,
                        rating: 4.6, reviewCount: 12 });
  r = await publish(OK_P);
  const reg2 = ENV.data[`providers/${OK_P}`] || {};
  ck('C1  an approved provider may publish', r.ok, r.ok ? 'ok' : r.code);
  ck('C2  ...stays active', reg2.status === 'active', reg2.status);
  ck('C3  ...stays searchable and bookable',
    reg2.searchable === true && reg2.acceptsBookings === true);
  ck('C4  ...content is refreshed', reg2.name === 'Self Made Clinic');
  ck('C5  ...earned history is not reset', reg2.rating === 4.6 && reg2.reviewCount === 12,
    reg2.rating + '/' + reg2.reviewCount);
  ck('C6  ...their existing providerId is reused, not replaced',
    reg2.providerId === 'PRV-EXIST01', reg2.providerId);
  ck('C7  ...and the claim is (idempotently) present', minted().some((m) => m.claims.provider === true));

  /* ═══ D — suspension cannot be undone by republishing ═══ */
  console.log('\nD. suspension survives a republish');
  ENV = seedFor(SUSP, { uid: SUSP, providerId: 'PRV-SUSP01', status: 'suspended',
                        searchable: false, isPublic: false, acceptsBookings: false,
                        suspendedAt: 1 });
  r = await publish(SUSP);
  const reg3 = ENV.data[`providers/${SUSP}`] || {};
  ck('D1  republishing does not throw (the provider may still edit their draft)', r.ok, r.code);
  ck('D2  ...but they stay SUSPENDED  <- HC-02 shape, via a callable', reg3.status === 'suspended', reg3.status);
  ck('D3  ...not searchable', reg3.searchable !== true, String(reg3.searchable));
  ck('D4  ...NOT bookable', reg3.acceptsBookings !== true, String(reg3.acceptsBookings));
  ck('D5  ...and no claim is minted for a suspended account', minted().length === 0);

  /* ═══ E — the public profile endpoint answers to the canonical registry ═══ */
  console.log('\nE. providerGetPublicProfile');
  ENV = seedFor(SELF, null);
  await publish(SELF);
  ENV.data[`providerProfiles/${SELF}`].providerId = 'PRV-SELF01';
  ENV.data[`providerProfiles/${SELF}`].status = 'active';   /* onboarding state, not approval */
  let pub = null;
  try { await OPS.providerGetPublicProfile({ data: { providerId: 'PRV-SELF01' } }); pub = 'RETURNED'; }
  catch (e) { pub = e.code || 'threw'; }
  ck('E1  an unapproved provider is NOT publicly fetchable by providerId', pub !== 'RETURNED', pub);

  ENV = seedFor(OK_P, { uid: OK_P, providerId: 'PRV-OK01', status: 'active' });
  await publish(OK_P);
  ENV.data[`providerProfiles/${OK_P}`].providerId = 'PRV-OK01';
  ENV.data[`providerProfiles/${OK_P}`].status = 'active';
  try { await OPS.providerGetPublicProfile({ data: { providerId: 'PRV-OK01' } }); pub = 'RETURNED'; }
  catch (e) { pub = e.code || 'threw'; }
  /* CHANGELOG 244 (C3a-2, owner decision 2026-09-28): approval alone is not public — an UNCLASSIFIED provider (e.g.
     approved before C1) is hidden until AdminOS classifies it. The server stamps providers/{uid}.business at approval. */
  ck('E2a ...an approved but UNCLASSIFIED provider is not fetchable until classified', pub !== 'RETURNED', pub);
  { /* the stamp application-lifecycle.projectProvider writes at approval, derived from its producers — never hand-written */
    const app = { role: 'provider', category: 'plumbing' };
    const FNP = require('path').join(__dirname, '..', 'functions');
    ENV.data[`providers/${OK_P}`].business = { category: require(require('path').join(FNP, 'business-category.js')).categoryFromApplication(app, app.role).category,
      source: 'application', lane: require(require('path').join(FNP, 'provider-hub.js')).classifyDecidedApplication(app) };
    if (ENV.data[`providers/${OK_P}`].business.category !== 'trades') throw new Error('fixture: the producers no longer classify plumbing as trades');
  }
  try { const r = await OPS.providerGetPublicProfile({ data: { providerId: 'PRV-OK01' } }); pub = r && r.category === 'trades' ? 'RETURNED' : 'WRONG_CATEGORY'; }
  catch (e) { pub = e.code || 'threw'; }
  ck('E2  ...and an approved, classified one still is — under the SERVER category', pub === 'RETURNED', pub);

  /* ═══ F — scope ═══ */
  console.log('\nF. scope');
  ENV = seedFor(SELF, null);
  await publish(SELF);
  const touched = new Set(ENV.log.map((e) => e.coll || String(e.path || '').split('/')[0]).filter(Boolean));
  ck('F1  no healthProviders write', !touched.has('healthProviders'), [...touched].join(','));
  ck('F2  no applications / payments / bookings written',
    !['applications', 'payments', 'paymentIntents', 'providerBookings', 'healthAppointments',
      'healthRecords', 'legalAcceptances'].some((c) => touched.has(c)),
    [...touched].join(','));
  ck('F3  no `verified` flag was introduced as the fix',
    (ENV.data[`providers/${SELF}`] || {}).verified !== true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the defect this gate removes)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
