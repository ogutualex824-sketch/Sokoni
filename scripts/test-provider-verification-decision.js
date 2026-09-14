#!/usr/bin/env node
/* OB-3 — provider verification must be a process, not a collection.
 *
 *   node scripts/test-provider-verification-decision.js
 *   COUNTERPROOF=1 node scripts/test-provider-verification-decision.js   # PRE-FIX source
 *
 * SDKs are stubbed and the REAL handlers are invoked — adminDecideProviderVerification from
 * functions/admin-os.js and providerSubmitVerification from functions/provider-onboarding.js —
 * so every assertion is on documents actually written.
 *
 * THE STATE THIS REMOVES
 * `providerSubmitVerification` wrote providerVerification/{uid} with status:'pending_review'
 * and NOTHING anywhere moved it. Documents could be submitted and never decided. And because
 * that write is merge:true, a REJECTED provider could upload again and silently return
 * themselves to the queue with the rejection and its reason erased.
 *
 * WHAT THE DECISION MEANS — the thing this suite exists to pin down
 * SOKONI has no integration with any professional registry. An administrator working this
 * queue is looking at an uploaded image. That establishes that the documents are on file and
 * a human looked at them; it does NOT establish that a registration is real, current, or
 * belongs to this person. So `verified_on_file` is the ONLY verified state reachable here,
 * and E1/E2 assert that `verified_with_authority` cannot be written — because turning
 * "an admin saw a PDF" into "this clinician is registered" is the most consequential lie
 * this system could tell a patient.
 *
 * SEPARATION OF POWERS
 * Verification does not activate, publish or make anyone bookable. Part D asserts that a
 * fully verified provider is still not active, not searchable and still refused by
 * booking-service's ACTIVE_PROVIDER_STATES.
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

const PROV  = 'PROVIDER_uid_2a8';
const ADMIN = 'ADMIN_uid_1';
const SUPER = 'SUPER_uid_1';
const RANDO = 'RANDO_uid_9';

const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  arrayUnion: (...v) => ({ __s: 'au', values: v }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};

let ENV;
function makeEnv({ docs = {} } = {}) {
  const data = { ...docs };
  const log = [];
  const apply = (p, doc, merge) => { data[p] = merge ? { ...(data[p] || {}), ...doc } : { ...doc }; };
  const mkDoc = (coll, id) => ({
    __path: `${coll}/${id}`,
    async get() { const p = `${coll}/${id}`; return { exists: !!data[p], id, data: () => data[p] }; },
    async set(doc, opts) { log.push({ op: 'set', coll, id, doc }); apply(`${coll}/${id}`, doc, opts && opts.merge); return this; },
    async update(doc) { log.push({ op: 'update', coll, id, doc }); apply(`${coll}/${id}`, doc, true); return this; },
    async delete() { log.push({ op: 'delete', coll, id }); delete data[`${coll}/${id}`]; },
  });
  const mkColl = (coll, preds = []) => ({
    doc: (id) => mkDoc(coll, id),
    async add(doc) { log.push({ op: 'add', coll, doc }); return { id: 'gen' }; },
    where(f, o, v) { return mkColl(coll, preds.concat([[f, o, v]])); },
    limit() { return this; }, orderBy() { return this; },
    async count() { const s = await this.get(); return { get: async () => ({ data: () => ({ count: s.size }) }) }; },
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
  });
  return { data, log, db: { collection: mkColl }, auth: { async getUser(uid) { return { uid, customClaims: {} }; }, async setCustomUserClaims() {} } };
}

/** PRE-FIX: the decision handler removed entirely, and submit back to a blind merge. */
function prefixSources() {
  const admin = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
  const cut = admin.indexOf('/* ═════════════════════════════════════════════════════════════════════════════\n   OB-3 — PROVIDER VERIFICATION: THE DECISION STEP');
  if (cut < 0) throw new Error('OB-3 block anchor not found in admin-os.js — refusing to guess');
  let onb = fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8');
  const histStart = onb.indexOf('  /* A RE-SUBMISSION MUST NOT ERASE A DECISION.');
  const histEnd   = onb.indexOf('    status:          \'pending_review\',');
  if (histStart < 0 || histEnd < 0) throw new Error('submit anchors not found — refusing to guess');
  onb = onb.slice(0, histStart) +
        "  await _db().collection('providerVerification').doc(uid).set({\n    uid,\n" +
        onb.slice(histEnd);
  return { admin: admin.slice(0, cut), onb };
}

let ADMIN_OPS = null, PROV_OPS = null;
function load() {
  const orig = Module.prototype.require;
  /* Hook stays installed: provider-onboarding requires './availability' lazily, at call
     time. A hook torn down after load lets the real module resolve against an
     uninitialised firebase-admin, the call throws before writing anything, and every
     assertion below reports on a document that was never touched. */
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue, Timestamp: { fromDate: (d) => ({ __d: +d }) } };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
    if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 's' }) };
    if (id === './notify') return { notify: async () => {} };
    if (id === './search-terms') return { buildSearchTerms: () => [], searchTerms: () => [] };
    if (id === './legal-agreements') return { assertLegalCompliance: async () => ({ compliant: true }) };
    if (id === './availability') return { normalizeAvailabilityConfig: (_c, uid) => ({ uid }) };
    return orig.apply(this, arguments);
  };
  let adminFile = path.join(FUNCTIONS_DIR, 'admin-os.js');
  let onbFile   = path.join(FUNCTIONS_DIR, 'provider-onboarding.js');
  if (COUNTERPROOF) {
    const src = prefixSources();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob3-'));
    adminFile = path.join(dir, 'admin-os.js');  fs.writeFileSync(adminFile, src.admin);
    onbFile   = path.join(dir, 'provider-onboarding.js'); fs.writeFileSync(onbFile, src.onb);
    /* Shim EVERY relative require the two sources make, derived from the sources
       themselves rather than hand-listed. A hand-kept list rots the moment either
       module gains a dependency: the mutant then fails to LOAD and the counter-proof
       reports "no failures detected" for a reason that has nothing to do with the
       defect. This is the third time that trap has appeared in this programme. */
    const sibs = new Set();
    for (const s of [src.admin, src.onb]) {
      for (const m of s.matchAll(/require\('\.\/([A-Za-z0-9_-]+)'\)/g)) sibs.add(m[1]);
    }
    for (const sib of sibs) {
      if (sib === 'admin-os' || sib === 'provider-onboarding') continue;
      fs.writeFileSync(path.join(dir, sib + '.js'),
        `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
    }
  }
  delete require.cache[require.resolve(adminFile)];
  delete require.cache[require.resolve(onbFile)];
  ADMIN_OPS = require(adminFile)._h;
  PROV_OPS  = require(onbFile)._h;
}

const SUBMITTED = (over = {}) => ({
  uid: PROV, nationalIdUrl: 'https://x/id.jpg', licenceUrl: 'https://x/lic.jpg',
  status: 'pending_review', submittedAt: 1, ...over,
});
const seed = (verDoc, extra) => makeEnv({
  docs: Object.assign(
    verDoc ? { [`providerVerification/${PROV}`]: verDoc } : {},
    { [`providerProfiles/${PROV}`]: { uid: PROV, status: 'active' } },
    extra || {}
  ),
});

const decide = async (actor, claims, decision, reason, uid = PROV) => {
  const fn = ADMIN_OPS && ADMIN_OPS.adminDecideProviderVerification;
  if (!fn) return { ok: false, code: 'NO_HANDLER', message: 'adminDecideProviderVerification does not exist' };
  try { return { ok: true, res: await fn({ auth: actor ? { uid: actor, token: claims || {} } : null, data: { uid, decision, reason } }) }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};
const submit = async (uid = PROV) => {
  try { return { ok: true, res: await PROV_OPS.providerSubmitVerification({ auth: { uid, token: {} }, data: { nationalIdUrl: 'https://x/id2.jpg' } }) }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};
const audits = () => ENV.log.filter((e) => e.op === 'add' && e.coll === 'adminAudit');
const ver = () => ENV.data[`providerVerification/${PROV}`] || {};

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? 'PRE-FIX (no decision step)' : 'current'));
  console.log('='.repeat(70));
  load();

  /* ═══ A — the decision exists and works ═══ */
  console.log('\nA. an administrator can decide a submitted verification');
  ENV = seed(SUBMITTED());
  let r = await decide(ADMIN, { admin: true }, 'verify_documents');
  ck('A1  an admin may decide  <- the missing step', r.ok, r.ok ? 'ok' : r.code + ': ' + r.message);
  ck('A2  ...the state becomes verified_on_file', ver().status === 'verified_on_file', ver().status);
  ck('A3  ...recording who decided and when', ver().reviewedBy === ADMIN && !!ver().reviewedAt);
  ck('A4  ...and what the state actually MEANS, in the record itself',
    typeof ver().basis === 'string' && /NOT confirmed with any issuing authority/i.test(ver().basis),
    ver().basis);
  ck('A5  ...naming the documents that were reviewed',
    Array.isArray(ver().documentsReviewed) && ver().documentsReviewed.includes('licenceUrl'),
    JSON.stringify(ver().documentsReviewed));
  ck('A6  ...the submitted evidence is preserved, not consumed',
    ver().nationalIdUrl === 'https://x/id.jpg' && ver().licenceUrl === 'https://x/lic.jpg');
  ck('A7  ...and it is audited', audits().length === 1 && /verified_on_file/.test(audits()[0].doc.action),
    audits()[0] && audits()[0].doc.action);
  ck('A8  ...with the transition recorded, not just the endpoint',
    !!audits()[0] && audits()[0].doc.fromStatus === 'pending_review' && audits()[0].doc.toStatus === 'verified_on_file');

  ENV = seed(SUBMITTED());
  r = await decide(SUPER, { superAdmin: true }, 'reject', 'Licence image is unreadable.');
  ck('A9  a superAdmin may decide too', r.ok, r.code);
  ck('A10 ...rejection records the reason', ver().status === 'rejected' && /unreadable/.test(ver().reviewNotes || ''), ver().reviewNotes);
  ENV = seed(SUBMITTED());
  r = await decide(ADMIN, { admin: true }, 'reject');
  ck('A11 ...and a rejection without a reason is refused', !r.ok, r.message);

  /* ═══ B — negative controls ═══ */
  console.log('\nB. who may NOT decide');
  ENV = seed(SUBMITTED()); r = await decide(null, null, 'verify_documents');
  ck('B1  unauthenticated REFUSED', !r.ok, r.message);
  ENV = seed(SUBMITTED()); r = await decide(RANDO, {}, 'verify_documents');
  ck('B2  ordinary signed-in user REFUSED', !r.ok, r.message);
  ENV = seed(SUBMITTED()); r = await decide(RANDO, { provider: true }, 'verify_documents');
  ck('B3  another PROVIDER REFUSED', !r.ok, r.message);
  ENV = seed(SUBMITTED()); r = await decide(PROV, {}, 'verify_documents');
  ck('B4  the APPLICANT deciding themselves REFUSED', !r.ok, r.message);
  ENV = seed(SUBMITTED()); r = await decide(PROV, { admin: true }, 'verify_documents', undefined, PROV);
  ck('B5  ...even holding the admin claim  <- self-review is still self-review', !r.ok, r.message);
  ENV = seed(SUBMITTED()); r = await decide(RANDO, { moderator: true }, 'verify_documents');
  ck('B6  a moderator is not an administrator here', !r.ok, r.message);
  ENV = seed(SUBMITTED()); await decide(RANDO, {}, 'verify_documents');
  ck('B7  a refused decision writes nothing', ver().status === 'pending_review' && audits().length === 0, ver().status);

  /* ═══ C — nothing to decide, and idempotency ═══ */
  console.log('\nC. determinism');
  ENV = seed(null);
  r = await decide(ADMIN, { admin: true }, 'verify_documents');
  ck('C1  with no submission there is nothing to decide — REFUSED', !r.ok, r.message);
  ck('C2  ...and no record is manufactured', !ENV.data[`providerVerification/${PROV}`]);

  ENV = seed(SUBMITTED());
  await decide(ADMIN, { admin: true }, 'verify_documents');
  const firstAudits = audits().length;
  r = await decide(ADMIN, { admin: true }, 'verify_documents');
  ck('C3  re-issuing the same decision is idempotent', r.ok && r.res.idempotent === true, JSON.stringify(r.res));
  ck('C4  ...and writes no second audit event', audits().length === firstAudits, audits().length);
  r = await decide(SUPER, { superAdmin: true }, 'reject', 'On review the licence had expired.');
  ck('C5  a DIFFERENT decision is a legitimate correction and applies', r.ok && ver().status === 'rejected', ver().status);
  ck('C6  ...audited as the transition it is',
    audits().some((a) => a.doc.fromStatus === 'verified_on_file' && a.doc.toStatus === 'rejected'));

  /* ═══ D — verification does NOT activate ═══ */
  console.log('\nD. verification is separate from activation and bookability');
  ENV = seed(SUBMITTED(), { [`providers/${PROV}`]: { uid: PROV, status: 'pending_approval', searchable: false, acceptsBookings: false } });
  await decide(ADMIN, { admin: true }, 'verify_documents');
  const reg = ENV.data[`providers/${PROV}`] || {};
  ck('D1  the provider is still NOT active', reg.status !== 'active', reg.status);
  ck('D2  ...still not searchable', reg.searchable !== true, String(reg.searchable));
  ck('D3  ...still NOT bookable (ACTIVE_PROVIDER_STATES)',
    reg.acceptsBookings !== true && !['active', 'approved'].includes(reg.status));
  ck('D4  ...the registry row was not written at all by this decision',
    !ENV.log.some((e) => e.coll === 'providers'), ENV.log.filter((e) => e.coll === 'providers').length);
  ck('D5  ...and no bare `verified:true` was set, which would collapse on-file into authority-confirmed',
    ver().verified !== true && (ENV.data[`providerProfiles/${PROV}`] || {}).verified !== true);
  ck('D6  the provider record is mirrored for display only', (ENV.data[`providerProfiles/${PROV}`] || {}).verificationStatus === 'verified_on_file');

  /* ═══ E — the vocabulary boundary ═══ */
  console.log('\nE. verified_with_authority is NOT reachable');
  ENV = seed(SUBMITTED());
  r = await decide(ADMIN, { admin: true }, 'verified_with_authority', 'confirmed with the board');
  ck('E1  it cannot be requested as a decision', !r.ok, r.message);
  ENV = seed(SUBMITTED());
  await decide(ADMIN, { admin: true }, 'verify_documents');
  ck('E2  ...and the achievable state says on-file, never with-authority',
    ver().status === 'verified_on_file' && ver().status !== 'verified_with_authority');
  const adminSrc = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
  ck('E3  no writer anywhere produces verified_with_authority',
    !/status:\s*['"]verified_with_authority['"]/.test(adminSrc) &&
    !/status:\s*['"]verified_with_authority['"]/.test(fs.readFileSync(path.join(FUNCTIONS_DIR, 'provider-onboarding.js'), 'utf8')));

  /* ═══ F — a rejection cannot be silently erased by the applicant ═══ */
  console.log('\nF. a rejected verification cannot be silently restored');
  ENV = seed(SUBMITTED());
  await decide(ADMIN, { admin: true }, 'reject', 'Document does not match the applicant.');
  const rejectedAt = ver().reviewedAt;
  r = await submit();
  ck('F1  the provider may re-submit (the remedy stays available)', r.ok, r.code);
  ck('F2  ...returning to pending_review', ver().status === 'pending_review', ver().status);
  ck('F3  ...but the rejection SURVIVES in the record  <- the silent-restore hole',
    Array.isArray(ver().priorDecisions) && ver().priorDecisions.length === 1 &&
    ver().priorDecisions[0].status === 'rejected',
    JSON.stringify(ver().priorDecisions || null));
  ck('F4  ...with its reason intact', /does not match/.test((ver().priorDecisions || [{}])[0].reason || ''));
  ck('F5  ...and the live row no longer looks decided',
    ver().reviewedBy === null && ver().reviewNotes === null,
    ver().reviewedBy + '/' + ver().reviewNotes);
  ck('F6  ...the re-submission is marked as one', !!ver().resubmittedAt && rejectedAt !== undefined);
  ck('F7  the applicant still cannot reach a verified state by submitting',
    ver().status !== 'verified_on_file');

  /* ═══ G — mutation control for Part B ═══
     Part B passing proves the calls were refused; it does NOT prove `_requireAdmin` refused
     them. In the PRE-FIX run every B case "passes" for a degenerate reason — the handler does
     not exist, so `NO_HANDLER` reads as a refusal. The counter-proof therefore validates
     Part A, not Part B. So neuter the guard in a copy of the source and re-run the same
     calls: an ordinary user must then succeed. */
  if (!COUNTERPROOF) {
    console.log('\nG. mutation control — neuter _requireAdmin and Part B must collapse');
    const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'admin-os.js'), 'utf8');
    /* Matched by REGEX, not by an exact string: admin-os.js is CRLF (and BOM-prefixed), so a
       template-literal anchor written with LF silently never matches and the control reports
       "anchor rotted" on a file that has not changed at all. Line endings are not part of
       what this control is testing. */
    const GUARD = /function _requireAdmin\(req\)\s*\{[\s\S]*?\r?\n\}/;
    if (!GUARD.test(src)) {
      ck('G0  the _requireAdmin anchor still matches', false, 'ANCHOR ROTTED — Part B is unproven');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob3m-'));
      const f = path.join(dir, 'admin-os.js');
      fs.writeFileSync(f, src.replace(GUARD, 'function _requireAdmin(req) { /* NEUTERED */ }'));
      const sibs = new Set();
      for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9_-]+)'\)/g)) sibs.add(m[1]);
      for (const sib of sibs) {
        fs.writeFileSync(path.join(dir, sib + '.js'),
          `module.exports = require(${JSON.stringify(path.join(FUNCTIONS_DIR, sib + '.js'))});`);
      }
      let mutant = null, loadErr = null;
      try { delete require.cache[require.resolve(f)]; mutant = require(f)._h; }
      catch (e) { loadErr = e.message; }
      if (!mutant) {
        ck('G1  the mutant LOADS (a control that cannot load proves nothing)', false, loadErr);
      } else {
        ck('G1  the mutant loads', true);
        ENV = seed(SUBMITTED());
        let mr;
        try { await mutant.adminDecideProviderVerification({ auth: { uid: RANDO, token: {} }, data: { uid: PROV, decision: 'verify_documents' } }); mr = 'succeeded'; }
        catch (e) { mr = e.message; }
        ck('G2  with the guard removed an ordinary user CAN decide  <- Part B was real',
          mr === 'succeeded', mr);
        ck('G3  ...and the state actually moved', ver().status === 'verified_on_file', ver().status);
        /* The self-review refusal is a SEPARATE check and must survive the mutation. */
        ENV = seed(SUBMITTED());
        try { await mutant.adminDecideProviderVerification({ auth: { uid: PROV, token: {} }, data: { uid: PROV, decision: 'verify_documents' } }); mr = 'succeeded'; }
        catch (e) { mr = e.message; }
        ck('G4  self-review is refused by its OWN check, not by _requireAdmin',
          /own verification/i.test(mr), mr);
      }
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the defect this gate removes)');
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
