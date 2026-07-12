#!/usr/bin/env node
/* ================================================================
   SOKONI — Legal Compliance Engine integration tests
   scripts/test-legal-compliance.js

   Verifies the engine's contract with an in-memory Firestore stub, so it runs
   in CI with no emulator: catalogue correctness, version-awareness, idempotency,
   duplicate-safety, audit logging, dark-launch enforcement, and the guard.

   Run:  node scripts/test-legal-compliance.js      (exit 0 = pass)
================================================================ */
'use strict';

/* ── Minimal in-memory Firestore stub ───────────────────────────── */
const store = new Map();                       // "col/doc" -> data
const key = (c, d) => `${c}/${d}`;
let committed = 0;

function docRef(col, id) {
  return {
    id,
    async get() {
      const data = store.get(key(col, id));
      return { exists: data !== undefined, id, data: () => data };
    },
    async set(data, opts) {
      const prev = (opts && opts.merge) ? (store.get(key(col, id)) || {}) : {};
      store.set(key(col, id), Object.assign({}, prev, data));
    },
    async update(data) { store.set(key(col, id), Object.assign({}, store.get(key(col, id)) || {}, data)); },
    collection(sub) { return colRef(`${col}/${id}/${sub}`); },
  };
}
function colRef(col) {
  const filters = [];
  const api = {
    doc: (id) => docRef(col, id),
    where(f, _op, v) { filters.push([f, v]); return api; },
    limit() { return api; },
    async get() {
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(col + '/')) continue;
        if (k.slice(col.length + 1).includes('/')) continue;      // direct children only
        if (filters.every(([f, val]) => v[f] === val)) {
          docs.push({ id: k.slice(col.length + 1), data: () => v, ref: docRef(col, k.slice(col.length + 1)) });
        }
      }
      return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  };
  return api;
}
const fakeDb = {
  collection: colRef,
  batch() {
    const ops = [];
    return {
      set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
      update: (ref, data) => ops.push(() => ref.update(data)),
      delete: () => {},
      async commit() { for (const op of ops) await op(); committed++; },
    };
  },
};

/* Stub firebase-admin BEFORE requiring the module under test. */
const Module = require('module');
const origResolve = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin/firestore') {
    return {
      getFirestore: () => fakeDb,
      FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => ({ __inc: n }) },
    };
  }
  if (request === 'firebase-functions/v2/https') {
    class HttpsError extends Error {
      constructor(code, msg) { super(msg); this.code = code; }
    }
    return { HttpsError, onCall: (o, h) => h };
  }
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  return origResolve.apply(this, arguments);
};

const legal = require('../functions/legal-agreements');
Module._load = origResolve;

/* ── Test harness ───────────────────────────────────────────────── */
let pass = 0, fail = 0;
const ok  = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } };
async function throws(name, fn, codeMatch) {
  try { await fn(); fail++; console.error('  ✗ ' + name + ' (expected throw)'); }
  catch (e) {
    const good = !codeMatch || (e.code === codeMatch) || String(e.message).includes(codeMatch);
    if (good) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.error('  ✗ ' + name + ' (wrong error: ' + e.code + ' ' + e.message + ')'); }
  }
}
const req = (uid, data, admin) => ({ auth: uid ? { uid, token: admin ? { admin: true } : {} } : null, data, rawRequest: { ip: '1.2.3.4', headers: {} } });

/* ══════════════════════════════════════════════════════════════════════════════
   DIGITAL SIGNATURE FIXTURES

   legalAccept now REQUIRES an electronic signature. This suite was written against
   the previous contract and supplied none, so every acceptance call threw. That is
   test drift, not an application defect — the implementation is right and the tests
   were stale. They are brought up to the real contract here; the requirement is not
   relaxed anywhere.

   Three lawful forms under Kenya's Business Laws (Amendment) Act / ETA:
     typed  — full legal name, typed. No image; the server derives the hash from
              (uid, name), so the signature is bound to the signer.
     drawn  — a drawn signature image. Server stores only a SHA-256 of it.
     stamp  — a company stamp image. Same handling as drawn.

   The server NEVER stores the raw image (biometric-adjacent personal data); the hash
   is enough to prove the artefact presented at signing has not since been altered.

   ── VALIDATION ORDER (verified against functions/legal-agreements.js) ──────────
     1. auth                      → unauthenticated
     2. acceptances non-empty     → invalid-argument
     3. signature type valid      → invalid-argument      ← signature is checked
     4. signed name (≥2 chars)    → invalid-argument         BEFORE the catalogue
     5. confirmed === true        → failed-precondition      is even loaded
     6. drawn/stamp data ≥64B     → invalid-argument
     7. professional declaration  → failed-precondition
     8. agreement version matches → failed-precondition   ← version checked LAST
     9. idempotent write (deterministic doc id)

   This ordering is INTENTIONAL and must not be "fixed". A signature is a
   precondition for recording anything at all: it makes no sense to validate which
   version of a document someone is signing before establishing that they signed.
   Consequently a wrong-version test can only observe a version error once it
   supplies an otherwise-valid signature — which is exactly why the old test failed
   with a signature error instead.
═════════════════════════════════════════════════════════════════════════════════ */
const IMG = 'data:image/png;base64,' + 'A'.repeat(120);   /* > 64 bytes, < 400 KB */

/* Fixtures use a FICTIONAL business. A test must never carry the real legal entity's
   name: it is not a brand surface, the drift guard rightly flags any non-canonical
   spelling of it, and a fixture is the last place that name should need maintaining. */
const SIG = {
  typed: { type: 'typed', name: 'Alex Ochieng',      confirmed: true },
  drawn: { type: 'drawn', name: 'Alex Ochieng',      confirmed: true, data: IMG },
  stamp: { type: 'stamp', name: 'Acme Traders Ltd',  confirmed: true, data: IMG },
};
const DECL = { accepted: true, version: '1.0' };

/* A complete, valid acceptance payload. Every legalAccept call in this suite builds
   from this, so if the contract changes again there is ONE place to fix. */
const accept = (acceptances, sigType, extra) => Object.assign({
  role: 'merchant',
  acceptances,
  signature: SIG[sigType || 'typed'],
  declaration: DECL,
  meta: { language: 'en' },
}, extra || {});

(async () => {
  console.log('\nSOKONI Legal Compliance Engine — integration tests\n');

  /* 1. Catalogue */
  console.log('Catalogue');
  const ag = await legal._h.legalGetAgreements(req('u1', { role: 'merchant' }));
  ok('core has 5 agreements', ag.core.length === 5);
  ok('merchant adds 8 role agreements', ag.roleSpecific.length === 8);
  ok('every agreement has a version + hash', [...ag.core, ...ag.roleSpecific].every((a) => a.version && a.hash));
  const pAg = await legal._h.legalGetAgreements(req('u1', { role: 'provider' }));
  ok('provider adds 8 role agreements', pAg.roleSpecific.length === 8);
  const rAg = await legal._h.legalGetAgreements(req('u1', { role: 'rider' }));
  ok('rider shares the driver set (5)', rAg.roleSpecific.length === 5);

  /* 2. Auth */
  console.log('\nSecurity');
  await throws('unauthenticated is rejected', () => legal._h.legalCheckCompliance(req(null, {})), 'unauthenticated');
  await throws('non-admin cannot publish', () => legal._h.legalPublishAgreement(req('u1', { agreementId: 'x', version: '2.0' })), 'permission-denied');
  await throws('non-admin cannot read compliance report', () => legal._h.legalComplianceReport(req('u1', {})), 'permission-denied');

  /* 3. Compliance before acceptance */
  console.log('\nCompliance');
  const before = await legal._h.legalCheckCompliance(req('u1', { role: 'merchant' }));
  ok('new user is non-compliant', before.compliant === false);
  ok('all 13 merchant agreements are missing', before.missing.length === 13);
  ok('missing reason = never', before.missing.every((m) => m.reason === 'never'));

  /* 4. DIGITAL SIGNATURE — the mandatory contract.
        Every one of these must be REJECTED. The requirement is never relaxed. */
  console.log('\nDigital signature — rejections');
  const one = [{ agreementId: 'terms-of-service', version: '1.0' }];

  await throws('missing signature entirely', () =>
    legal._h.legalAccept(req('u1', { role: 'merchant', acceptances: one, declaration: DECL })),
    'invalid-argument');

  await throws('invalid signature type', () =>
    legal._h.legalAccept(req('u1', accept(one, null, { signature: { type: 'wet-ink', name: 'Alex Ochieng', confirmed: true } }))),
    'invalid-argument');

  await throws('empty drawn signature (image below minimum size)', () =>
    legal._h.legalAccept(req('u1', accept(one, null, { signature: { type: 'drawn', name: 'Alex Ochieng', confirmed: true, data: 'x' } }))),
    'invalid-argument');

  await throws('empty company stamp', () =>
    legal._h.legalAccept(req('u1', accept(one, null, { signature: { type: 'stamp', name: 'Acme Traders Ltd', confirmed: true, data: '' } }))),
    'invalid-argument');

  await throws('signed name missing / too short', () =>
    legal._h.legalAccept(req('u1', accept(one, null, { signature: { type: 'typed', name: 'A', confirmed: true } }))),
    'invalid-argument');

  await throws('not confirmed — signer did not attest they read the agreements', () =>
    legal._h.legalAccept(req('u1', accept(one, null, { signature: { type: 'typed', name: 'Alex Ochieng', confirmed: false } }))),
    'failed-precondition');

  await throws('professional role without the Professional Declaration', () =>
    legal._h.legalAccept(req('u1', { role: 'merchant', acceptances: one, signature: SIG.typed })),
    'failed-precondition');

  await throws('unauthenticated cannot sign', () =>
    legal._h.legalAccept(req(null, accept(one))), 'unauthenticated');

  await throws('no acceptances supplied', () =>
    legal._h.legalAccept(req('u1', accept([]))), 'invalid-argument');

  /* 5. Version-awareness — now with a VALID signature, so a VERSION error is what
        surfaces. Previously this call carried no signature at all, so it failed on
        the signature check and never reached the version check: the test was
        asserting the right code for the wrong reason. */
  console.log('\nVersion awareness (signature valid — version is the last gate)');
  await throws('rejects wrong version', () =>
    legal._h.legalAccept(req('u1', accept([{ agreementId: 'terms-of-service', version: '9.9' }]))),
    'failed-precondition');
  await throws('rejects unknown agreement only (no valid ones)', () =>
    legal._h.legalAccept(req('u1', accept([{ agreementId: 'not-a-real-agreement', version: '1.0' }]))),
    'invalid-argument');

  /* 6. TAMPERED PAYLOAD — the client must not be able to author the evidence.
        The signature hash and the acceptance context are SERVER-derived. A client
        that supplies its own must be ignored, not trusted. */
  console.log('\nTampered payload — client cannot author its own evidence');
  const allT = [...ag.core, ...ag.roleSpecific].map((a) => ({ agreementId: a.id, version: a.version }));
  await legal._h.legalAccept(req('u9', accept(allT, 'typed', {
    signature: Object.assign({}, SIG.typed, { hash: 'deadbeef'.repeat(8) }),   /* forged hash */
    acceptedFrom: '9.9.9.9',                                                    /* forged IP   */
  })));
  const tRec = store.get('legalAcceptances/u9_terms-of-service_1.0');
  const expected = require('crypto').createHash('sha256').update('typed:u9:Alex Ochieng').digest('hex');
  ok('client-supplied signature hash is IGNORED — server recomputes it',
     tRec.signatureHash === expected && tRec.signatureHash !== 'deadbeef'.repeat(8));
  ok('client-supplied IP is IGNORED — server captures it from the request',
     tRec.acceptedFrom === '1.2.3.4');

  /* 7. Accept — records, audit, idempotency, duplicate-safety */
  console.log('\nAcceptance');
  const all = [...ag.core, ...ag.roleSpecific].map((a) => ({ agreementId: a.id, version: a.version }));
  const r1 = await legal._h.legalAccept(req('u1', accept(all, 'typed')));
  ok('records all 13 agreements', r1.count === 13);
  const after = await legal._h.legalCheckCompliance(req('u1', { role: 'merchant' }));
  ok('user is now compliant', after.compliant === true);

  const rec = store.get('legalAcceptances/u1_terms-of-service_1.0');
  ok('acceptance record exists (deterministic id)', !!rec);
  ok('server-captured IP recorded', rec.acceptedFrom === '1.2.3.4');
  ok('server timestamp used', rec.acceptedAt && rec.acceptedAt.__ts === true);
  ok('agreement hash stored', typeof rec.agreementHash === 'string' && rec.agreementHash.length > 0);
  ok('acceptanceMethod records the signature TYPE (not "checkbox")', rec.acceptanceMethod === 'typed-signature');
  ok('signature hash stored, raw image never persisted', typeof rec.signatureHash === 'string' && rec.signatureHash.length === 64 && !rec.signatureData);
  ok('signed name attributed to the signer', rec.signedName === 'Alex Ochieng');
  ok('audit log entry written', [...store.keys()].some((k) => k.startsWith('legalAuditLog/')));

  /* All three lawful signature forms must be accepted. */
  const dr = await legal._h.legalAccept(req('u7', accept(all, 'drawn')));
  ok('DRAWN signature accepted', dr.count === 13 &&
     store.get('legalAcceptances/u7_terms-of-service_1.0').acceptanceMethod === 'drawn-signature');
  const st = await legal._h.legalAccept(req('u8', accept(all, 'stamp')));
  ok('COMPANY STAMP accepted', st.count === 13 &&
     store.get('legalAcceptances/u8_terms-of-service_1.0').acceptanceMethod === 'stamp-signature');
  ok('drawn/stamp store only a hash, never the image',
     !store.get('legalAcceptances/u7_terms-of-service_1.0').signatureData &&
     !store.get('legalAcceptances/u8_terms-of-service_1.0').signatureData);

  const countBefore = [...store.keys()].filter((k) => k.startsWith('legalAcceptances/')).length;
  await legal._h.legalAccept(req('u1', accept(all, 'typed')));
  const countAfter = [...store.keys()].filter((k) => k.startsWith('legalAcceptances/')).length;
  ok('duplicate acceptance is idempotent (no duplicate records)', countBefore === countAfter);

  /* 6. Pending updates after a version bump */
  console.log('\nVersion upgrade workflow');
  store.set('legalAgreements/terms-of-service', { agreementId: 'terms-of-service', name: 'Terms of Service', version: '2.0', status: 'active' });
  legal._h.legalPublishAgreement && (await legal._h.legalPublishAgreement(req('admin', { agreementId: 'terms-of-service', name: 'Terms of Service', version: '2.0' }, true)));
  const pend = await legal._h.legalGetPendingUpdates(req('u1', { role: 'merchant' }));
  ok('detects outdated acceptance after version bump', pend.hasPending === true);
  const tos = pend.pending.find((p) => p.agreementId === 'terms-of-service');
  ok('reason = version_updated (not never_accepted)', tos && tos.reason === 'version_updated');
  ok('previous acceptance history preserved (v1.0 record intact)', !!store.get('legalAcceptances/u1_terms-of-service_1.0'));

  /* 7. Enforcement — dark-launched by default */
  console.log('\nServer-side enforcement (dark-launch)');
  const g1 = await legal.assertLegalCompliance('u2', 'provider');
  ok('enforcement OFF by default → allows (non-breaking)', g1.enforced === false);

  // Flip via the admin op (this is the real path — it busts the flag cache).
  await legal._h.legalSetEnforcement(req('admin', { role: 'provider', enabled: true }, true));
  await throws('enforcement ON → blocks non-compliant user', () => legal.assertLegalCompliance('u2', 'provider'), 'failed-precondition');

  // A compliant user still passes while enforcement is ON.
  const pAll = (await legal._h.legalGetAgreements(req('u3', { role: 'provider' })));
  await legal._h.legalAccept(req('u3', accept(
    [...pAll.core, ...pAll.roleSpecific].map((a) => ({ agreementId: a.id, version: a.version })),
    'drawn',
    { role: 'provider' },       /* provider is a PROFESSIONAL role — declaration required */
  )));
  const g2 = await legal.assertLegalCompliance('u3', 'provider');
  ok('enforcement ON → compliant user passes', g2.enforced === true && g2.compliant === true);

  await legal._h.legalSetEnforcement(req('admin', { role: 'provider', enabled: false }, true));
  const g3 = await legal.assertLegalCompliance('u2', 'provider');
  ok('enforcement can be turned back OFF (instant rollback)', g3.enforced === false);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
