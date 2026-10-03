#!/usr/bin/env node
'use strict';
/* applicationReview — claim / release / note / archive / history; never a second decision writer.
     A non-admin refused everywhere (notes never applicant-readable through this door)
     B claim is exclusive (second reviewer refused unless explicit take-over, which is audited); release only by holder
     C notes stored in applicationReviews/{id}/notes, audit row per action WITHOUT the note text
     D archive is a queue view state: applications/* and applicationDecisions/* are byte-for-byte unchanged
     E history returns notes + audit events, newest first, including lifecycle decision rows
   node scripts/test-application-review.js */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
const M = require(path.join(FN, 'application-review.js'));
const run = async (uid, data, token = { admin: true }) => { try { return { ok: true, v: await M.applicationReview.run({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const snapshot = (pre) => JSON.stringify([...F.db._store.entries()].filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k, v.data]));
const keys = (pre) => [...F.db._store.keys()].filter((k) => k.startsWith(pre));

(async () => {
  console.log('applicationReview — review tools without a second decision writer\n');
  await F.db.collection('applications').doc('u1--financial_partner').set({ uid: 'u1', requestedRole: 'financial_partner', status: 'under_review' });
  await F.db.collection('applicationDecisions').doc('u1--financial_partner').set({ decision: null });
  await F.db.collection('adminAudit').doc('old1').set({ action: 'application_request_info', applicationId: 'u1--financial_partner', performedBy: 'adm0', reason: 'Need CBK letter', createdAt: F.Timestamp.fromMillis(1000) });
  const appsBefore = snapshot('applications/') + snapshot('applicationDecisions/');
  const A = 'u1--financial_partner';

  const a1 = await run('u1', { applicationId: A, action: 'history' }, {});
  const a2 = await run('u1', { applicationId: A, action: 'note', text: 'hi' }, { role: 'admin' });
  ck('A1 applicant / role-string-only token refused (admin claim required)', a1.code === 'permission-denied' && a2.code === 'permission-denied');

  const b1 = await run('adm1', { applicationId: A, action: 'claim' });
  const b2 = await run('adm2', { applicationId: A, action: 'claim' });
  const b3 = await run('adm2', { applicationId: A, action: 'release' });
  const b4 = await run('adm1', { applicationId: A, action: 'claim' });
  ck('B1 claim is exclusive: second reviewer refused; release only by the holder; re-claim by holder is fine', b1.ok && !b2.ok && b2.code === 'failed-precondition' && !b3.ok && b4.ok, { b2, b3 });
  const b5 = await run('adm2', { applicationId: A, action: 'claim', takeOver: true });
  ck('B2 explicit take-over works and is audited with the previous reviewer', b5.ok && keys('adminAudit/').some((k) => F.db._store.get(k).data.action === 'application_review_takeover' && F.db._store.get(k).data.previousReviewer === 'adm1'));
  const b6 = await run('adm2', { applicationId: 'nope', action: 'claim' });
  ck('B3 unknown application → not-found', b6.code === 'not-found');

  const c1 = await run('adm2', { applicationId: A, action: 'note', text: 'Called the SACCO — <b>registration</b> confirmed by phone' });
  const noteKeys = keys('applicationReviews/' + A + '/notes/');
  const noteAudit = keys('adminAudit/').map((k) => F.db._store.get(k).data).find((e) => e.action === 'application_review_note');
  ck('C1 note stored (markup stripped) in the review notes; audit row carries the note id, NOT the text', c1.ok && noteKeys.length === 1 && !/[<>]/.test(F.db._store.get(noteKeys[0]).data.text) && noteAudit && !('text' in noteAudit) && noteAudit.noteId === c1.v.noteId, noteAudit);

  const d1 = await run('adm2', { applicationId: A, action: 'archive' });
  const d2 = await run('adm2', { applicationId: A, action: 'unarchive' });
  ck('D1 archive/unarchive is a queue view state; applications/* and applicationDecisions/* unchanged by EVERY action', d1.ok && d1.v.archived === true && d2.ok && snapshot('applications/') + snapshot('applicationDecisions/') === appsBefore);

  const e1 = await run('adm3', { applicationId: A, action: 'history' });
  ck('E1 history: reviewer, notes, and audit events newest-first including the lifecycle request_info row', e1.ok && e1.v.review.reviewerUid === 'adm2' && e1.v.notes.length === 1 && e1.v.events.some((x) => x.action === 'application_request_info') && e1.v.events[e1.v.events.length - 1].action === 'application_request_info', e1.v);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
