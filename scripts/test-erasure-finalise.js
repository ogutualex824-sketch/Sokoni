#!/usr/bin/env node
'use strict';
/* ============================================================================
   Right to erasure — finaliseExpiredDeletions actually runs and purges what it should
   ----------------------------------------------------------------------------
   PROVEN live (census 2026-10-01): every nightly run failed with FAILED_PRECONDITION (missing
   composite index on users(status, deletionScheduledAt)) — 59 errors 08-31 → 09-29.
   Real module (functions/account-manager.js + account-purge-spec.js), firebase-admin replaced at
   the SDK boundary (in-memory Firestore that REFUSES a status==/date<= query without the index,
   like production; recording Auth + Storage stubs). The scheduled handler is executed via .run.
     A  the query no longer needs the missing composite index
     B  only DUE accounts are erased; a not-yet-due one is untouched
     C  purge: drafts (national ID), preferences, reset tokens deleted; reviews / orders de-identified;
        consent records, wallets retained with a legal basis; Storage prefixes incl. documents/,
        profile-avatars/, chatAttachments/ purged; Auth user deleted last
     D  erasureLog outcome is honest: completed_with_retention (records kept), never plain "success"
   node scripts/test-erasure-finalise.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const F = makeFakeFirestore();
/* Production refuses this composite query without its index — model that, so the test fails on
   the old code exactly as production did. */
const origColl = F.db.collection.bind(F.db);
F.db.collection = (name) => {
  const c = origColl(name);
  if (name !== 'users') return c;
  const wrapWhere = (q, filters) => new Proxy(q, { get(t, k) {
    if (k === 'where') return (f, op, v) => wrapWhere(t.where(f, op, v), [...filters, [f, op]]);
    if (k === 'limit') return (n) => wrapWhere(t.limit(n), filters);
    if (k === 'get') return async () => {
      const eq = filters.some(([f, op]) => f === 'status' && op === '=='), rng = filters.some(([f, op]) => f === 'deletionScheduledAt' && /[<>]/.test(op));
      if (eq && rng) { const e = new Error('9 FAILED_PRECONDITION: The query requires an index.'); e.code = 9; throw e; }
      return t.get();
    };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  return new Proxy(c, { get(t, k) { if (k === 'where') return (f, op, v) => wrapWhere(t.where(f, op, v), [[f, op]]); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
};
const deletedUsers = [], purgedPrefixes = [];
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const adminStub = {
  apps: [1], initializeApp() {}, firestore: ff,
  auth: () => ({ deleteUser: async (uid) => { deletedUsers.push(uid); }, getUser: async (uid) => ({ uid }), updateUser: async () => ({}), revokeRefreshTokens: async () => {} }),
  storage: () => ({ bucket: () => ({ deleteFiles: async ({ prefix }) => { purgedPrefixes.push(prefix); } }) }),
};
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: adminStub };
const AM = require(path.join(FN, 'account-manager.js'));
const SPEC = require(path.join(FN, 'account-purge-spec.js'));

(async () => {
  console.log('Right to erasure — finaliseExpiredDeletions\n');
  const now = Date.now(), day = 86400000;
  const T = (ms) => F.Timestamp.fromMillis(ms);
  await F.db.collection('users').doc('uDue').set({ status: 'pending_deletion', deletionScheduledAt: T(now - day), email: 'due@example.com', name: 'Due User' });
  await F.db.collection('users').doc('uLater').set({ status: 'pending_deletion', deletionScheduledAt: T(now + 10 * day), email: 'later@example.com', name: 'Later User' });
  await F.db.collection('accountDrafts').doc('uDue_rider').set({ accountId: 'uDue', role: 'rider', stepData: { step1: { nationalId: '12345678', dob: '1990-01-01' } } });
  await F.db.collection('emailPreferences').doc('uDue').set({ marketing: true, unsubToken: 'x'.repeat(32) });
  await F.db.collection('passwordResetState').doc('uDue').set({ latestHash: 'h' });
  await F.db.collection('passwordResetTokens').doc('h').set({ uid: 'uDue' });
  await F.db.collection('reviews').doc('r1').set({ uid: 'uDue', authorName: 'Due User', rating: 5, text: 'good' });
  await F.db.collection('orders').doc('o1').set({ buyerUid: 'uDue', buyerName: 'Due User', buyerPhone: '0700', total: 100 });
  await F.db.collection('consentRecords').doc('c1').set({ uid: 'uDue', policyVersion: '2026-06' });
  await F.db.collection('wallets').doc('uDue').set({ balance: 0 });
  await F.db.collection('accountDrafts').doc('uLater_rider').set({ accountId: 'uLater', stepData: { step1: { nationalId: '87654321' } } });

  let err = null;
  try { await AM.finaliseExpiredDeletions.run({}); } catch (e) { err = e.message; }
  ck('A1 the nightly run completes (no composite-index FAILED_PRECONDITION)', err === null, err);

  const uDue = (await F.db.collection('users').doc('uDue').get()).data();
  const uLater = (await F.db.collection('users').doc('uLater').get()).data();
  ck('B1 the DUE account is erased: users shell redacted, Auth user deleted', uDue.status === 'deleted' && uDue.email === '[redacted]' && deletedUsers.includes('uDue'), { uDue, deletedUsers });
  ck('B2 the not-yet-due account is untouched', uLater.status === 'pending_deletion' && uLater.email === 'later@example.com' && !deletedUsers.includes('uLater') && (await F.db.collection('accountDrafts').doc('uLater_rider').get()).exists);

  const gone = async (c, id) => !(await F.db.collection(c).doc(id).get()).exists;
  ck('C1 onboarding draft with national ID / DOB deleted', await gone('accountDrafts', 'uDue_rider'));
  ck('C2 email preferences and reset tokens deleted', await gone('emailPreferences', 'uDue') && await gone('passwordResetState', 'uDue') && await gone('passwordResetTokens', 'h'));
  const r1 = (await F.db.collection('reviews').doc('r1').get()).data();
  const o1 = (await F.db.collection('orders').doc('o1').get()).data();
  ck('C3 reviews and orders kept but de-identified (author / buyer name & phone stripped)', r1.authorName === 'Former customer' && o1.buyerName === 'Deleted User' && o1.buyerPhone === null && o1.total === 100, { r1, o1 });
  ck('C4 consent records and the wallet retained (legal basis in the spec)', !(await gone('consentRecords', 'c1')) && !(await gone('wallets', 'uDue'))
    && SPEC.PURGE_SPEC.find((r) => r.collection === 'consentRecords').legalBasis && SPEC.PURGE_SPEC.find((r) => r.collection === 'wallets').legalBasis);
  ck('C5 Storage purged incl. documents/, profile-avatars/, chatAttachments/, kyc-documents/', ['documents/uDue/', 'profile-avatars/uDue/', 'chatAttachments/uDue/', 'kyc-documents/uDue/'].every((p) => purgedPrefixes.includes(p)), purgedPrefixes);
  const logs = [...F.db._store.entries()].filter(([p]) => p.startsWith('erasureLog/')).map(([, v]) => v.data);
  ck('D1 erasureLog written with an honest outcome (completed_with_retention), not "success"', logs.length === 1 && logs[0].outcome === 'completed_with_retention' && logs[0].workerVersion === '1.1.0', logs);
  ck('D2 the log names what was deleted / anonymized / retained (counts, no PII)', logs[0].collectionsDeleted.some((x) => /^accountDrafts:1$/.test(x)) && logs[0].collectionsRetained.includes('consentRecords') && !JSON.stringify(logs[0]).includes('12345678'), logs[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
