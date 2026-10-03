#!/usr/bin/env node
/* OWNER DECISION 2026-10-03 — enrollCourse refuses PAID enrolment until it runs through IntaSend (Education E4).
 *   node scripts/test-education-paid-enrol-off.js        BASE=de6888b node scripts/test-education-paid-enrol-off.js (must FAIL)
 * LIVE: a paid enrol debited wallets/{uid}.balance with FieldValue.increment and wrote no ledger, no instructor credit,
 * no commission. Runs the REAL enrollCourse handler on an in-memory Firestore (firebase-admin replaced in the require
 * cache). Every refusal asserts the wallet and enrolment docs are untouched. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nenrollCourse paid enrolment OFF   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let file = path.join(FN, 'education.js');
if (process.env.BASE) {
  file = path.join(FN, '.edubase-' + process.pid + '.js');
  fs.writeFileSync(file, execSync('git show ' + process.env.BASE + ':functions/education.js', { cwd: ROOT }));
  process.on('exit', () => { try { fs.unlinkSync(file); } catch (_) {} });
}
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const proxy = new Proxy({}, { get: (_, k) => (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k]) });
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const fsFn = () => proxy; fsFn.FieldValue = realFS.FieldValue; fsFn.Timestamp = { now: () => '<now>' };
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {} } };
const H = require(file).enrollCourse;
const run = async (uid, data) => { try { return await H.run({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const world = () => ({
  courses: {
    paid: { title: 'Paid', price: 1500, status: 'published', instructorUid: 'teach1', enrollmentCount: 0 },
    free: { title: 'Free', price: 0, status: 'published', instructorUid: 'teach1', enrollmentCount: 0 },
    draftFree: { title: 'Draft', price: 0, status: 'draft', instructorUid: 'teach1' },
    junk: { title: 'Junk', price: 'abc', status: 'published', instructorUid: 'teach1' },
    neg: { title: 'Neg', price: -50, status: 'published', instructorUid: 'teach1' },
  },
  wallets: { rich: { balance: 10000 }, poor: { balance: 10 } },
  courseEnrollments: { already_paid: { uid: 'already', courseId: 'paid' } },
});
const S = () => DB._store;
const noEnrol = (uid, cid) => !((S().courseEnrollments || {})[uid + '_' + cid]) && !((S().courseProgress || {})[uid + '_' + cid]);

(async () => {
  DB = fakeDb(world());
  let r = await run('rich', { courseId: 'paid' });
  ck('P-1', r.err === 'failed-precondition' && r.reason === 'PAID_ENROLMENT_UNAVAILABLE' && S().wallets.rich.balance === 10000 && noEnrol('rich', 'paid'),
    'a learner WITH enough balance cannot buy a paid course: wallet untouched, no enrolment (was: balance - 1500, nothing recorded)', { r, bal: S().wallets.rich.balance });
  DB = fakeDb(world());
  r = await run('poor', { courseId: 'paid' });
  ck('P-2', r.err === 'failed-precondition' && r.paymentRequired === undefined && S().wallets.poor.balance === 10, 'a learner WITHOUT balance is refused the same way (no "top up your wallet" path)', r);
  DB = fakeDb(world());
  r = await run('nowallet', { courseId: 'paid' });
  ck('P-3', r.err === 'failed-precondition' && !(S().wallets || {}).nowallet, 'no wallet doc is created or read into a debit', r);
  DB = fakeDb(world());
  r = await run('rich', { courseId: 'junk' });
  ck('P-4', !!r.err && S().wallets.rich.balance === 10000 && noEnrol('rich', 'junk'), 'a non-numeric price never enrols for free', r);
  DB = fakeDb(world());
  r = await run('rich', { courseId: 'neg' });
  ck('P-5', !!r.err && noEnrol('rich', 'neg'), 'a negative price never enrols', r);
  DB = fakeDb(world());
  r = await run('rich', { courseId: 'free' });
  ck('C-1', r.enrolled === true && !noEnrol('rich', 'free') && S().wallets.rich.balance === 10000, 'CONTROL: a FREE course still enrols, wallet untouched', r);
  DB = fakeDb(world());
  r = await run('already', { courseId: 'paid' });
  ck('C-2', r.enrolled === true && r.alreadyEnrolled === true, 'CONTROL: an EXISTING paid enrolment still opens (idempotent return)', r);
  DB = fakeDb(world());
  r = await run('rich', { courseId: 'draftFree' });
  ck('C-3', r.err === 'failed-precondition' && noEnrol('rich', 'draftFree'), 'CONTROL: unpublished courses are still refused', r);
  DB = fakeDb(world());
  r = await run(null, { courseId: 'free' });
  ck('C-4', r.err === 'unauthenticated', 'CONTROL: signed-out callers are refused', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
