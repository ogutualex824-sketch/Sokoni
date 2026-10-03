#!/usr/bin/env node
/* EDUCATION — learner profile + guardian links (owner decisions 2026-10-03).
 *   node scripts/test-education-learner.js
 * Runs the REAL educationLearner handler on an in-memory Firestore (firebase-admin/firestore replaced in the require
 * cache). Age is only ever a SERVER fact (users.ageVerified); guardian links need a verified adult confirming a
 * single-use code. Every refusal asserts nothing was linked. */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\neducation learner profile + guardian links\n');
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const proxy = new Proxy({}, { get: (_, k) => (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k]) });
const fsPath = require.resolve('firebase-admin/firestore', { paths: [FN] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: Object.assign({}, realFS, { getFirestore: () => proxy }) };
let M = null; try { M = require(path.join(FN, 'education-learner.js')); } catch (e) { console.log('LOAD ERROR ' + e.message + '\nRESULT: 0 passed, 1 failed'); process.exit(1); }
const run = async (uid, data, token) => { try { return await M.educationLearner.run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const world = () => ({ users: { adult: { ageVerified: true }, adult2: { ageVerified: true }, kid: {}, kid2: {}, notVerified: {} } });
const S = () => DB._store;
const links = () => Object.values(S().guardianLinks || {}).filter((l) => l.status === 'active');
const OWN = (uid) => 'https://firebasestorage.googleapis.com/v0/b/x.appspot.com/o/learner-photos%2F' + uid + '%2Fa.jpg?alt=media';

(async () => {
  DB = fakeDb(world());
  /* P: profile */
  let r = await run('kid', { op: 'save', profile: { displayName: 'Wanjiru <b>', interests: ['coding', 'coding', 'music'], level: 'beginner', formats: ['self_paced', 'live_online'], language: 'sw', subjects: ['Maths'], goals: 'KCSE', location: 'Nyeri',
    ageVerified: true, guardianUid: 'x', status: 'approved', role: 'teacher', photoUrl: OWN('kid') } });
  const p = (S().learnerProfiles || {}).kid || {};
  ck('P-1', r.ok === true && p.displayName === 'Wanjiru b' && p.interests.join() === 'coding,music' && p.level === 'beginner' && p.language === 'sw' && p.photoUrl === OWN('kid'),
    'a learner saves their profile at once (no application); text sanitised, lists de-duplicated', p);
  ck('P-2', !('ageVerified' in p) && !('guardianUid' in p) && !('status' in p) && !('role' in p) && !((S().users.kid || {}).ageVerified),
    'a profile save can NEVER set age, guardian, status or role (browser age claims are ignored; users untouched)', p);
  ck('P-3', p._noIndex === true && p.ownerUid === 'kid', 'the profile is never indexed for search and is owned by the learner');
  r = await run('kid', { op: 'save', profile: { photoUrl: OWN('other') } });
  ck('P-4', r.err === 'invalid-argument' && r.reason === 'PHOTO_NOT_OWN' && (S().learnerProfiles.kid || {}).photoUrl === OWN('kid'), 'a photo from ANOTHER account\'s folder (or any external URL) is refused', r);
  r = await run('kid', { op: 'save', profile: { level: 'genius' } });
  ck('P-5', r.reason === 'LEVEL_INVALID', 'an unknown level is refused', r);
  r = await run('kid', { op: 'save', profile: { formats: ['self_paced', 'teleport'] } });
  ck('P-6', r.reason === 'FORMAT_INVALID', 'an unknown learning format is refused', r);
  r = await run(null, { op: 'save', profile: {} });
  ck('P-7', r.err === 'unauthenticated', 'signed-out callers are refused');
  r = await run('stranger', { op: 'load' });
  ck('P-8', r.ok === true && r.profile === null, 'load returns ONLY the caller\'s own profile (another learner\'s is unreachable: no uid parameter exists)', r);

  /* A: access from SERVER facts */
  r = await run('kid', { op: 'load' });
  ck('A-1', r.access && r.access.ageStatus === 'unverified' && r.access.interactive === false && r.access.selfPacedFree === true, 'an unverified learner: free self-paced only (no live / tutoring / messaging / paid)', r.access);
  r = await run('adult', { op: 'load' });
  ck('A-2', r.access && r.access.ageStatus === 'verified_adult' && r.access.interactive === true, 'CONTROL: a server-verified adult gets interactive access', r.access);

  /* G: guardian links */
  r = await run('kid', { op: 'guardianCode' });
  const code = r.code;
  ck('G-1', r.ok === true && /^[A-Z2-9]{8}$/.test(code || '') && (S().guardianCodes || {})[code].learnerUid === 'kid', 'the learner gets a single-use 8-character code', r);
  r = await run('notVerified', { op: 'guardianConfirm', code });
  ck('G-2', r.reason === 'GUARDIAN_NOT_VERIFIED' && !links().length && S().guardianCodes[code].status === 'open', 'an account WITHOUT the adult age check cannot be a guardian (code stays unused)', r);
  r = await run('kid', { op: 'guardianConfirm', code });
  ck('G-3', !!r.err && !links().length, 'a learner cannot confirm their own code (self-link refused: not verified, and never self)', r);
  r = await run('adult', { op: 'guardianConfirm', code: code.toLowerCase() });
  ck('G-4', r.ok === true && links().length === 1 && links()[0].learnerUid === 'kid' && links()[0].guardianUid === 'adult' && S().guardianCodes[code].status === 'used',
    'a VERIFIED ADULT confirms the code → an active guardian link (code consumed)', r);
  r = await run('adult2', { op: 'guardianConfirm', code });
  ck('G-5', r.reason === 'CODE_USED' && links().length === 1, 'a used code cannot be replayed by another adult', r);
  r = await run('kid', { op: 'load' });
  ck('G-6', r.access.ageStatus === 'guardian_linked' && r.access.interactive === true, 'the linked learner now has interactive access', r.access);
  ck('G-7', !JSON.stringify(r).includes('adult'), 'the learner\'s own view never exposes the guardian\'s identity', r);
  r = await run('kid', { op: 'guardianCode' });
  ck('G-8', r.reason === 'ALREADY_LINKED', 'a linked learner cannot mint another code', r);
  r = await run('adult', { op: 'guardianCode' });
  ck('G-9', r.reason === 'ALREADY_ADULT', 'a verified adult does not need (and cannot mint) a guardian code', r);

  /* G-10 isolates the self-link rule: a learner mints a code, LATER passes the adult check, then confirms their own code */
  DB = fakeDb(world());
  const c2 = (await run('kid2', { op: 'guardianCode' })).code;
  S().users.kid2.ageVerified = true;
  r = await run('kid2', { op: 'guardianConfirm', code: c2 });
  ck('G-10', r.reason === 'SELF_LINK' && !links().length, 'an account can never be its own guardian (even once age-verified)', r);

  /* expiry + unknown */
  DB = fakeDb(Object.assign(world(), { guardianCodes: { OLDCODE2: { learnerUid: 'kid2', status: 'open', expiresAtMs: Date.now() - 1000 } } }));
  r = await run('adult', { op: 'guardianConfirm', code: 'OLDCODE2' });
  ck('E-1', r.reason === 'CODE_EXPIRED' && !links().length, 'an expired code links nothing', r);
  r = await run('adult', { op: 'guardianConfirm', code: 'NOPE2345' });
  ck('E-2', r.reason === 'CODE_UNKNOWN' && !links().length, 'an unknown code links nothing', r);
  r = await run('adult', { op: 'guardianConfirm', code: 'x' });
  ck('E-3', r.reason === 'CODE_FORMAT', 'a malformed code is refused before any read');

  /* revoke */
  DB = fakeDb(Object.assign(world(), { guardianLinks: { kid__adult: { learnerUid: 'kid', guardianUid: 'adult', status: 'active' } } }));
  r = await run('adult2', { op: 'guardianRevoke', learnerUid: 'kid' });
  ck('R-1', r.reason === 'NO_LINK' && links().length === 1, 'a stranger cannot end someone else\'s guardian link', r);
  r = await run('adult', { op: 'guardianRevoke', learnerUid: 'kid' });
  ck('R-2', r.ok === true && !links().length && Object.values(S().educationAudit || {}).some((a) => a.action === 'guardian_link_revoked'), 'the guardian can end the link (audited)', r);
  r = await run('kid', { op: 'load' });
  ck('R-3', r.access.interactive === false, 'after revocation the learner is back to free self-paced only', r.access);

  /* the exported predicate */
  ck('X-1', typeof M._internal.learnerAccess === 'function' && M._internal.accessFor(false, false).interactive === false && M._internal.accessFor(true, false).interactive === true && M._internal.accessFor(false, true).interactive === true,
    'learnerAccess / accessFor: the ONE predicate the later Education gates call');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
