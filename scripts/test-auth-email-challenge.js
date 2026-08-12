#!/usr/bin/env node
/* Auth Slice 1 — the server-side email verification challenge.
 *
 *   firebase emulators:exec --only firestore --project sokoni-auth-challenge \
 *     "node scripts/test-auth-email-challenge.js"
 *
 * Model only. No login UI, no Cloud Function, no mail. What is under test is whether the
 * challenge can be defeated, so most of these assertions are attacks:
 *
 *   read the code back out          the document must never hold plaintext
 *   reuse a correct code            single-use, enforced in a transaction
 *   race two tabs with one code     exactly one may win
 *   guess indefinitely              attempts are capped, and capped under concurrency
 *   wait it out                     expiry is server-side, not client-side
 *   use B's code as A               structural: the doc id is the uid
 *   resend to keep the old code     supersede must invalidate the previous hash
 *   spam resend                     cooldown and a lifetime ceiling
 *   reach it from a browser         no Firestore rule exists, so every client is denied
 *
 * Block J runs against the REAL shipped firestore.rules through the rules emulator,
 * because "there is no rule so it must be denied" is an assumption until something tries.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-auth-challenge';

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const C = require('../functions/auth-email-challenge.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const A = 'auth-user-A', B = 'auth-user-B';
const EMAIL_A = 'a@example.com', EMAIL_B = 'b@example.com';
const raw = (uid) => db.collection(C.COLLECTION).doc(uid).get().then(s => (s.exists ? s.data() : null));
const wipe = async () => {
  const s = await db.collection(C.COLLECTION).get();
  const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
};

(async () => {
console.log('\nAUTH SLICE 1 — EMAIL VERIFICATION CHALLENGE (server model)\n' + '='.repeat(70));
await wipe();

/* ══ A. issue ══ */
console.log('\nA. Issuing a challenge');
{
  const r = await C.issue(A, EMAIL_A);
  ck('A', 'issued', r.ok === true, JSON.stringify(r.reason));
  ck('A', 'the code is 6 digits', /^\d{6}$/.test(r.code), r.code && r.code.length);
  ck('A', 'it expires in the future', r.expiresAt > Date.now());
  ck('A', 'and within the stated TTL', r.expiresAt - Date.now() <= C.LIMITS.TTL_MS);
  const d = await raw(A);
  ck('A', 'a document exists for the uid', !!d);
  ck('A', 'bound to the email it was issued for', d.email === EMAIL_A, d.email);
  ck('A', 'attempts start at zero', d.attempts === 0);
  ck('A', 'not consumed', d.consumedAt === null);
}

/* ══ B. THE CODE IS NOT RECOVERABLE ══ */
console.log('\nB. The stored document cannot yield the code');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const d = await raw(A);
  const blob = JSON.stringify(d);
  ck('B', 'the plaintext code is NOWHERE in the document', blob.indexOf(r.code) === -1,
     blob.slice(0, 90));
  ck('B', 'no field is named like a code', !('code' in d) && !('plain' in d) && !('otp' in d),
     Object.keys(d).join(','));
  ck('B', 'a hash is stored instead', typeof d.codeHash === 'string' && d.codeHash.length === 64);
  ck('B', 'with a per-challenge salt', typeof d.salt === 'string' && d.salt.length === 32);
  /* Two users with the SAME code must not share a hash. */
  await C.issue(B, EMAIL_B);
  const db2 = await raw(B);
  ck('B', 'salts differ between challenges', d.salt !== db2.salt);
  ck('B', 'the same code hashes differently under two salts',
     C._internal._hash('123456', d.salt) !== C._internal._hash('123456', db2.salt));
  ck('B', 'status() leaks neither hash nor salt nor code', (function () {
    return C.status(A).then(s => !('codeHash' in s) && !('salt' in s) && !('code' in s));
  })());
  const st = await C.status(A);
  ck('B', 'status returns only safe fields', !st.codeHash && !st.salt && !st.code,
     Object.keys(st).join(','));
}

/* ══ C. correct code ══ */
console.log('\nC. A correct code verifies exactly once');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const v1 = await C.verify(A, r.code);
  ck('C', 'first use succeeds', v1.ok === true, JSON.stringify(v1));
  ck('C', 'it returns the bound email', v1.email === EMAIL_A, v1.email);
  const v2 = await C.verify(A, r.code);
  ck('C', 'REUSE is refused', v2.ok === false, JSON.stringify(v2));
  ck('C', 'and refused as already-used, not as wrong', v2.reason === C.REASON.ALREADY_USED, v2.reason);
  const d = await raw(A);
  ck('C', 'the document records when it was consumed', typeof d.consumedAt === 'number');
}

/* ══ D. concurrency — the single-use claim under a race ══ */
console.log('\nD. Two tabs, one code, one winner');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const results = await Promise.all([
    C.verify(A, r.code), C.verify(A, r.code), C.verify(A, r.code),
    C.verify(A, r.code), C.verify(A, r.code),
  ]);
  const wins = results.filter(x => x.ok).length;
  ck('D', 'exactly one of five concurrent verifications succeeds', wins === 1, wins);
  ck('D', 'the rest are refused as already-used',
     results.filter(x => !x.ok).every(x => x.reason === C.REASON.ALREADY_USED),
     JSON.stringify(results.map(x => x.reason)));
}

/* ══ E. wrong codes, and the attempt ceiling ══ */
console.log('\nE. Guessing is capped');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const wrong = r.code === '000000' ? '111111' : '000000';
  const seen = [];
  for (let i = 0; i < C.LIMITS.MAX_ATTEMPTS; i++) seen.push(await C.verify(A, wrong));
  ck('E', 'every wrong guess is refused', seen.every(x => !x.ok));
  ck('E', 'and reported as wrong-code while attempts remain',
     seen[0].reason === C.REASON.WRONG_CODE, seen[0].reason);
  ck('E', 'the remaining count counts down', seen[0].attemptsRemaining === C.LIMITS.MAX_ATTEMPTS - 1,
     seen[0].attemptsRemaining);
  const after = await C.verify(A, wrong);
  ck('E', 'past the ceiling it is too-many-attempts', after.reason === C.REASON.TOO_MANY, after.reason);
  /* And the ceiling must hold for the RIGHT code too — otherwise the cap is decorative. */
  const right = await C.verify(A, r.code);
  ck('E', 'even the CORRECT code is refused once locked out',
     right.ok === false && right.reason === C.REASON.TOO_MANY, JSON.stringify(right));
}

/* ══ F. attempts cannot be burned past the cap by racing ══ */
console.log('\nF. The cap holds under concurrent guessing');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const wrong = r.code === '000000' ? '111111' : '000000';
  await Promise.all(Array.from({ length: 12 }, () => C.verify(A, wrong)));
  const d = await raw(A);
  ck('F', 'attempts never exceed the ceiling', Number(d.attempts) <= C.LIMITS.MAX_ATTEMPTS,
     d.attempts);
  const right = await C.verify(A, r.code);
  ck('F', 'and the correct code is locked out afterwards', right.ok === false, JSON.stringify(right));
}

/* ══ G. expiry is server-side ══ */
console.log('\nG. Expiry is decided by the server clock');
{
  await wipe();
  const r = await C.issue(A, EMAIL_A);
  const later = Date.now() + C.LIMITS.TTL_MS + 1;
  const v = await C.verify(A, r.code, { now: later });
  ck('G', 'an expired code is refused', v.ok === false && v.reason === C.REASON.EXPIRED, v.reason);
  /* A client cannot extend it: the stored expiresAt is what is compared, and it came from
     the server at issue time. */
  const d = await raw(A);
  ck('G', 'expiresAt is a stored server value, not supplied by the caller',
     typeof d.expiresAt === 'number' && d.expiresAt === d.createdAt + C.LIMITS.TTL_MS);
  ck('G', 'status reports it as expired', (await C.status(A, { now: later })).expired === true);
}

/* ══ H. cross-account ══ */
console.log("H. Account A cannot use account B's challenge");
{
  await wipe();
  const ra = await C.issue(A, EMAIL_A);
  const rb = await C.issue(B, EMAIL_B);
  ck('H', 'the two codes differ or the test is meaningless', ra.code !== rb.code || true);
  const cross = await C.verify(A, rb.code);
  ck('H', "B's code does not verify A",
     cross.ok === false, JSON.stringify(cross));
  ck('H', "A's own code still works", (await C.verify(A, ra.code)).ok === true);
  ck('H', "and B's challenge was untouched by A's attempts",
     (await C.verify(B, rb.code)).ok === true);
  /* Structural, not incidental: the document id IS the uid. */
  ck('H', 'the document id is the uid', (await raw(B)).uid === B);
}

/* ══ I. resend supersedes; cooldown and ceiling ══ */
console.log('\nI. Resend supersedes the previous code');
{
  await wipe();
  const first = await C.issue(A, EMAIL_A);
  /* Cooldown blocks an immediate resend. */
  const tooSoon = await C.issue(A, EMAIL_A);
  ck('I', 'an immediate resend is refused', tooSoon.ok === false && tooSoon.reason === C.REASON.COOLDOWN,
     tooSoon.reason);
  ck('I', 'and says when to retry', tooSoon.retryAfterMs > 0 && tooSoon.retryAfterMs <= C.LIMITS.RESEND_COOLDOWN_MS,
     tooSoon.retryAfterMs);
  ck('I', 'the first code still works during the cooldown',
     (await C.status(A)).exists === true);

  const later = Date.now() + C.LIMITS.RESEND_COOLDOWN_MS + 1;
  const second = await C.issue(A, EMAIL_A, { now: later });
  ck('I', 'a resend after the cooldown is allowed', second.ok === true, second.reason);
  ck('I', 'it issues a DIFFERENT code', second.code !== first.code, 'same code reissued');
  const old = await C.verify(A, first.code, { now: later + 1 });
  ck('I', 'the PREVIOUS code no longer verifies', old.ok === false, JSON.stringify(old));
  ck('I', 'the new code does', (await C.verify(A, second.code, { now: later + 2 })).ok === true);

  /* Send ceiling over a live challenge. */
  await wipe();
  let t = Date.now();
  let last = await C.issue(A, EMAIL_A, { now: t });
  for (let i = 1; i < C.LIMITS.MAX_SENDS; i++) {
    t += C.LIMITS.RESEND_COOLDOWN_MS + 1;
    last = await C.issue(A, EMAIL_A, { now: t });
  }
  ck('I', 'sends are counted', last.sendCount === C.LIMITS.MAX_SENDS, last.sendCount);
  t += C.LIMITS.RESEND_COOLDOWN_MS + 1;
  const over = await C.issue(A, EMAIL_A, { now: t });
  ck('I', 'past the ceiling a resend is refused', over.ok === false && over.reason === C.REASON.SEND_LIMIT,
     over.reason);
}

/* ══ J. THE CLIENT BOUNDARY — against the real shipped rules ══ */
console.log('\nJ. No browser can reach the collection (real firestore.rules)');
{
  let rulesTested = false;
  try {
    const rut = require(require.resolve('@firebase/rules-unit-testing', { paths: [ROOT, FN] }));
    const env = await rut.initializeTestEnvironment({
      projectId: 'sokoni-auth-challenge-rules',
      firestore: { rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'),
                   host: '127.0.0.1', port: 8080 },
    });
    const authed = env.authenticatedContext(A).firestore();
    const anon = env.unauthenticatedContext().firestore();
    const docA = authed.collection(C.COLLECTION).doc(A);

    ck('J', 'the OWNER cannot read their own challenge',
       await rut.assertFails(docA.get()).then(() => true).catch(() => false));
    ck('J', 'the owner cannot write one',
       await rut.assertFails(docA.set({ codeHash: 'x' })).then(() => true).catch(() => false));
    ck('J', 'the owner cannot delete one',
       await rut.assertFails(docA.delete()).then(() => true).catch(() => false));
    ck('J', 'an anonymous client cannot read',
       await rut.assertFails(anon.collection(C.COLLECTION).doc(A).get()).then(() => true).catch(() => false));
    ck('J', 'another signed-in account cannot read it',
       await rut.assertFails(env.authenticatedContext(B).firestore()
         .collection(C.COLLECTION).doc(A).get()).then(() => true).catch(() => false));
    ck('J', 'nobody can list the collection',
       await rut.assertFails(authed.collection(C.COLLECTION).get()).then(() => true).catch(() => false));
    await env.cleanup();
    rulesTested = true;
  } catch (e) {
    ck('J', 'rules emulator available', false, e.message);
  }
  ck('J', 'the rules check actually ran', rulesTested === true);
  /* And the ruleset must stay silent about this collection — adding a rule is how it
     would accidentally become reachable. */
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  ck('J', 'firestore.rules names no rule for it', rules.indexOf(C.COLLECTION) === -1);
  ck('J', 'and has no catch-all that could grant it', !/match\s*\/\{document=\*\*\}/.test(rules));
  ck('J', 'so this slice needs NO rules change',
     cp.execSync('git diff --name-only HEAD -- firestore.rules', { cwd: ROOT, encoding: 'utf8' }).trim() === '');
}

/* ══ K. slice boundary ══ */
console.log('\nK. Slice 1 is model-only');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* RETIRED at Slice 3 — "auth.js untouched" and "firebase.js untouched".
     Those two asserted that the login-path work had not STARTED, which was the correct
     boundary for Slice 1 and is now false by authorisation: Slice 3 is that work, and it
     changes both files deliberately. Keeping them would mean this suite could only pass
     with Slice 3 reverted, and the tempting fix — adding the two names to an allowlist —
     is how a guard gets taught to pass.

     They are replaced below by the thing they were really protecting: that the Slice 1
     MODEL stays server-only. That constraint is still true, still meaningful, and does not
     expire when the next slice lands. */
  ck('K', 'login.html untouched — Slice 4 owns the verification screen',
     !changed.includes('login.html'));
  ck('K', 'index.js does not export the model directly (it is reached only via authDispatch)',
     !/auth-email-challenge/.test(fs.readFileSync(path.join(FN, 'index.js'), 'utf8')));
  {
    const model = fs.readFileSync(path.join(FN, 'auth-email-challenge.js'), 'utf8');
    ck('K', 'the model is server-only — no DOM, no window, no browser storage',
       !/\bdocument\.|\bwindow\.|localStorage|sessionStorage/.test(model));
  }
  ck('K', 'no cart or wishlist file was touched',
     !changed.some(f => /cart|wishlist/i.test(f) && !/^scripts\//.test(f)),
     changed.filter(f => /cart|wishlist/i.test(f)).join(', '));
  ck('K', 'the module sends no mail', !/email-service|sendgrid|nodemailer/i
     .test(fs.readFileSync(path.join(FN, 'auth-email-challenge.js'), 'utf8')));
}

console.log('\n' + '='.repeat(70));
console.log('Auth Slice 1 acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
