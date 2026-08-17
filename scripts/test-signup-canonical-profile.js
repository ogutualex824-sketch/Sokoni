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
/* Bound to the signup function. Several markers ('Sync to localStorage for
   backward-compat', 'catch(err){') also occur in the LOGIN path earlier in the file,
   and a whole-file indexOf silently compares against the wrong occurrence. */
const SIGNUP_SRC = AUTH_SRC.slice(AUTH_SRC.indexOf('async function _doSignup'));
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
  /* Was pinned to the exact adjacency `catch(err){ fail(...); throw err;`, which broke
     the moment anything was logged in between. The PROPERTY that matters is that the
     aborting catch fails the signup and rethrows, and renders no success — assert that
     instead, so diagnostics can sit in the handler without weakening the guarantee. */
  const iFail  = SIGNUP_SRC.indexOf('fail(_fbErr(err.code))');
  const iCatch = SIGNUP_SRC.lastIndexOf('catch(err){', iFail);
  const iThrow = SIGNUP_SRC.indexOf('throw err;', iFail);
  ck('a signup failure surfaces as an error, not a success screen',
     iCatch > -1 && iFail > iCatch && iThrow > iFail);
  const successIdx = AUTH_SRC.indexOf('Replace the auth card with the success screen');
  ck('the success screen comes AFTER the profile write', successIdx > iProfile);

  /* ══ 6 · a consentRecords failure can NEVER be silently swallowed ══
     §1 above proves the RULES permit the row. It passed all along — and production
     still held ZERO consentRecords across the whole account population, because the
     client wrapped the write in `catch (_) {}`. A rules-level "allowed" is not
     evidence that a row is produced, and a write that can fail with no console
     error, no audit entry and no metric will fail unnoticed for as long as it likes.

     So this asserts the property the emulator cannot: the failure PATH reports.
     It deliberately does not assert the diagnostic breadcrumb, which is temporary —
     only that the error is bound and surfaced, which must outlive the diagnosis. */
  head('6 · the consent-row failure path is observable');

  const consentFailureIsReported = (src) => {
    const i = src.indexOf("collection(window.firebaseDB, 'consentRecords')");
    if (i < 0) return false;
    const slice = src.slice(i, i + 2000);
    /* The handler must BIND the error (not `catch (_)`) and SURFACE it. */
    return /catch\s*\(\s*(err|error|e)\s*\)/.test(slice)
        && slice.includes('console.error')
        && slice.includes('CONSENT AUDIT');
  };

  /* Negative control — the exact silent form this suite exists to prevent. A
     detector that cannot fail is not a test; prove it discriminates. */
  const SILENT_FIXTURE = [
    "try {",
    "    await addDoc(collection(window.firebaseDB, 'consentRecords'), {",
    "        uid: cred.user.uid, source: 'signup', policyVersion: POLICY_VERSION,",
    "        privacy: true, terms: true, consentedAt: serverTimestamp(),",
    "    });",
    "} catch (_) { /* consent snapshot already on the profile; audit row is best-effort */ }",
  ].join('\n');

  ck('detector REJECTS the old silent catch (negative control)',
     consentFailureIsReported(SILENT_FIXTURE) === false);
  ck('detector ACCEPTS the current auth.js', consentFailureIsReported(AUTH_SRC) === true);
  ck('the consent write is still AWAITED (an unawaited row cannot be observed at all)',
     /await addDoc\(collection\(window\.firebaseDB, 'consentRecords'\)/.test(AUTH_SRC));
  ck('the consent payload is unchanged by the diagnostic',
     /uid: cred\.user\.uid, source: 'signup', policyVersion: POLICY_VERSION/.test(AUTH_SRC));
  ck('a consent-row failure does NOT block the signup (profile snapshot still stands)',
     SIGNUP_SRC.indexOf('CONSENT_AUDIT_WRITE_FAILED') > -1
     && SIGNUP_SRC.indexOf('Sync to localStorage for backward-compat') > SIGNUP_SRC.indexOf('CONSENT_AUDIT_WRITE_FAILED'));

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed   (rules: ' + target + ')');
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack); process.exit(1); });
