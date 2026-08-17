#!/usr/bin/env node
/* Canonical signup profile — the users/{uid} create must SUCCEED, and the privileged
 * fields must stay client-unwritable.
 *
 *   npm run test:rules:signup          # emulator-backed; this is the real check
 *
 * WHY THIS EXISTS
 * A throwaway email/password signup (all role boxes unticked) created a Firebase Auth
 * account and NO users/{uid} document and NO consentRecords row. The payload auth.js
 * sent carried two keys the live ruleset refuses on create:
 *
 *     role         -> noAdminFields()
 *     ageVerified  -> noPrivilegeEscalation()
 *
 * The setDoc is awaited, so the refusal threw and the profile was never written —
 * an orphaned identity on EVERY email/password signup. Google signup was unaffected,
 * because firebase.js's new-user profile never carried either key.
 *
 * The fix removed the two keys from the client write. It did NOT relax the rules, so
 * this suite asserts BOTH directions: the legitimate baseline is writable, and the
 * privileged fields are still refused. A regression in either direction fails here.
 *
 * The rules file under test is resolved from firebase.json — the mapping is the only
 * thing that decides what production actually enforces, so it is read, never assumed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, addDoc, collection } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

/* ── The rules target, read from firebase.json ─────────────────────────────── */
const fbJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const fsCfg = Array.isArray(fbJson.firestore) ? fbJson.firestore : [fbJson.firestore];
const target = (fsCfg.find((c) => c && c.database === '(default)') || fsCfg[0]).rules;
const RULES = fs.readFileSync(path.join(ROOT, target), 'utf8');

/* ── The payload signup actually sends, mirrored from auth.js ──────────────── */
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
const baselineProfile = (uid) => ({
  uid,
  name: 'Ashitsa Violet',
  email: 'ashitsaviolet@gmail.com',
  dob: '2000-01-01',
  joinedAt: '17 Aug 2026',
  joinedTimestamp: 1786961871579,
  registeredAs: { user: true },
  roles: ['buyer'],
  consent: { policyVersion: 'v1', source: 'signup', privacy: true, terms: true },
});

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'sokoni-signup-canonical',
    firestore: { rules: RULES },
  });
  console.log('\nRules under test: ' + target + '  (resolved from firebase.json)');

  const tryWrite = async (uid, data) => {
    const db = env.authenticatedContext(uid).firestore();
    try { await setDoc(doc(db, 'users', uid), data); return true; } catch (_) { return false; }
  };

  /* ══ 1 · the unticked-role signup succeeds ══ */
  head('1 · an all-boxes-unticked signup can create its canonical profile');
  ck('the baseline signup profile is ALLOWED', await tryWrite('u_signup_1', baselineProfile('u_signup_1')));
  ck('...and a consent row can follow it', await (async () => {
    const db = env.authenticatedContext('u_signup_1').firestore();
    try {
      await addDoc(collection(db, 'consentRecords'),
        { uid: 'u_signup_1', source: 'signup', policyVersion: 'v1', privacy: true, terms: true });
      return true;
    } catch (_) { return false; }
  })());

  /* ══ 2 · the rules were NOT relaxed ══ */
  head('2 · the privileged fields are still client-unwritable');
  const withRole = Object.assign(baselineProfile('u_signup_2'), { role: 'user' });
  ck('`role` is still REFUSED on create', !(await tryWrite('u_signup_2', withRole)));
  const withAge = Object.assign(baselineProfile('u_signup_3'), { ageVerified: true });
  ck('`ageVerified` is still REFUSED on create', !(await tryWrite('u_signup_3', withAge)));
  const withAdmin = Object.assign(baselineProfile('u_signup_4'), { isAdmin: true });
  ck('`isAdmin` is still REFUSED', !(await tryWrite('u_signup_4', withAdmin)));
  const escalate = Object.assign(baselineProfile('u_signup_5'), { roles: ['buyer', 'seller'] });
  ck('a self-granted seller role is still REFUSED', !(await tryWrite('u_signup_5', escalate)));

  /* ══ 3 · no other identity is manufactured ══
     NOTE on sellers/{uid}: the rules DELIBERATELY permit the owner to create it —
     `allow create: if isAuthed() && request.auth.uid == uid && noAdminFields()` — because
     that document IS the seller onboarding application. `status` is not an admin field, so
     an owner may write status:'active' on it. That is NOT an authorization bypass: client
     authority comes from signed CLAIMS (sokoni-role-authority.js), and no server path
     grants anything from sellers/{uid}.status — the reads are inventory/sales/eTIMS data,
     and platform-ops / release-readiness only COUNT status=='active'. So the property worth
     asserting here is not "cannot create" but "cannot create for someone else", plus the
     fact that the signup flow does not touch these collections at all. */
  head('3 · a baseline signup manufactures no role identity');
  const mkFor = async (col, owner, target) => {
    const db = env.authenticatedContext(owner).firestore();
    try { await setDoc(doc(db, col, target), { status: 'active' }); return true; } catch (_) { return false; }
  };
  for (const col of ['sellers', 'providers', 'drivers']) {
    ck('a client cannot create ' + col + '/{SOMEONE ELSE}', !(await mkFor(col, 'u_signup_6', 'u_victim')));
  }
  ck('providers/{uid} self-create is refused', !(await mkFor('providers', 'u_signup_7', 'u_signup_7')));
  ck('drivers/{uid} self-create is refused', !(await mkFor('drivers', 'u_signup_8', 'u_signup_8')));
  /* Characterisation, so a change in EITHER direction is visible in this suite. */
  ck('sellers/{uid} self-create is permitted (onboarding application, by design)',
     await mkFor('sellers', 'u_signup_9', 'u_signup_9'));
  ck('the signup flow itself writes ONLY users + consentRecords',
     !/collection\(window\.firebaseDB,\s*'(sellers|providers|drivers)'/.test(AUTH_SRC)
     && !/doc\(window\.firebaseDB,\s*'(sellers|providers|drivers)'/.test(AUTH_SRC));

  /* ══ 4 · the client no longer SENDS the refused keys ══ */
  head('4 · auth.js sends only client-writable fields');
  const block = (AUTH_SRC.match(/const profile = \{[\s\S]{0,700}?\};/) || [''])[0];
  ck('signup payload found in auth.js', block.length > 0);
  ck('payload does NOT set `role`', !/^\s*role:/m.test(block), block.match(/^\s*role:.*/m));
  ck('payload does NOT set `ageVerified`', !/^\s*ageVerified:/m.test(block));
  ck('payload carries the canonical baseline roles:[buyer]', /roles:\s*\['buyer'\]/.test(block));

  /* ══ 5 · ordering and failure surfacing ══ */
  head('5 · consent follows the profile, and failure is never a success');
  const iProfile = AUTH_SRC.indexOf("setDoc(doc(window.firebaseDB, 'users'");
  const iConsent = AUTH_SRC.indexOf("collection(window.firebaseDB, 'consentRecords')");
  ck('the profile write precedes the consent row', iProfile > -1 && iConsent > iProfile);
  ck('the profile write is AWAITED (so a refusal cannot be ignored)',
     /await setDoc\(doc\(window\.firebaseDB, 'users'/.test(AUTH_SRC));
  ck('a signup failure surfaces as an error, not a success screen',
     /catch\(err\)\{\s*fail\(_fbErr\(err\.code\)\);\s*throw err;/.test(AUTH_SRC.replace(/\r/g, '')));
  const successIdx = AUTH_SRC.indexOf('Replace the auth card with the success screen');
  ck('the success screen comes AFTER the profile write', successIdx > iProfile);

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + target + ')');
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
