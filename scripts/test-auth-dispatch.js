#!/usr/bin/env node
/* Auth Slice 2 — the issue / verify handlers.
 *
 *   firebase emulators:exec --only firestore,auth --project sokoni-auth-dispatch \
 *     "node scripts/test-auth-dispatch.js"
 *
 * Runs the SHIPPED handlers against a real Firestore emulator and a real Auth emulator,
 * so `admin.auth().getUser()` and `updateUser()` are the genuine calls rather than stubs.
 * The email transport is the one place substituted — a test that posts to SendGrid is a
 * test that fails on someone else's outage — and the substitution is asserted to be at
 * the transport only, not at the preference or address logic.
 *
 * The assertions that matter are the ones a handler makes possible and a model cannot:
 *
 *   uid comes from the token          a caller cannot name someone else's account
 *   the address comes from Auth       a caller cannot redirect their own second factor
 *   verify marks the Auth record      the flag is server-set, never client-asserted
 *   a preference cannot suppress it   a marketing toggle must not lock you out
 *   rate limits hold under a race     concurrent issues do not multiply the send budget
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-auth-dispatch';

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

/* ── substitute the TRANSPORT only ───────────────────────────────────────────
   email-service.send() is replaced after the module loads, so every decision the real
   send() would make about preferences and recipients is still made by our caller, not
   bypassed here. What is stubbed is the network. */
const emailSvc = require('../functions/email-service.js');
const SENT = [];
const realSend = emailSvc.send;
emailSvc.send = async (payload) => { SENT.push(payload); return { ok: true, messageId: 'test' }; };

const challenge = require('../functions/auth-email-challenge.js');
const rateLimiter = require('../functions/redis-rate-limiter.js');
/* The limiter reaches Redis, which is not present here. Force its durable Firestore
   fallback path — the one that actually runs in production when Redis is down, and the
   one that must fail CLOSED for security actions. */
const dispatch = require('../functions/auth-dispatch.js');
const H = dispatch._h;

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}

const EMAIL_A = 'alpha@example.com', EMAIL_B = 'bravo@example.com';
let UID_A, UID_B;

/* A request object shaped like the v2 onCall one. `rawRequest` carries the IP the limiter
   reads. */
/* redis-rate-limiter._extractIp reads x-forwarded-for / x-real-ip / connection
   .remoteAddress — NOT .ip. Setting .ip gave it nothing, so every request in the run
   resolved to the identifier 'unknown' and shared one bucket. */
const reqFor = (uid, data, ip) => ({
  auth: uid ? { uid, token: { uid } } : null,
  data: data || {},
  rawRequest: {
    headers: { 'x-forwarded-for': ip || '203.0.113.7' },
    connection: { remoteAddress: ip || '203.0.113.7' },
  },
});

/* Rate limits are now per-account AND per-IP, so a block that is not testing them must
   not trip them. Swallow only resource-exhausted; anything else is a real failure. */
const noLimit = (p) => p.catch(e => {
  if (/resource-exhausted/i.test(e.code || e.message || '')) return { rateLimited: true };
  throw e;
});

async function resetUsers() {
  for (const e of [EMAIL_A, EMAIL_B]) {
    try { const u = await admin.auth().getUserByEmail(e); await admin.auth().deleteUser(u.uid); } catch (_) {}
  }
  UID_A = (await admin.auth().createUser({ email: EMAIL_A, password: 'pw-alpha-123', emailVerified: false })).uid;
  UID_B = (await admin.auth().createUser({ email: EMAIL_B, password: 'pw-bravo-123', emailVerified: false })).uid;
}
async function wipe() {
  /* rateLimitsFallback is cleared with everything else: the durable counters are what the
     limiter uses here (no Redis), so leaving them would carry one block's budget into the
     next and produce failures that look like logic bugs. */
  for (const c of [challenge.COLLECTION, 'rateLimitsFallback', 'emailPreferences']) {
    const s = await db.collection(c).get();
    const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); if (s.size) await b.commit();
  }
  SENT.length = 0;
}
/* Rate limits are keyed by IP for the 'otp' profile (byUid:false). A fresh IP per block
   keeps one block's limit from failing the next — the limit itself is tested in F. */
let ipSeq = 0;
const freshIp = () => '198.51.100.' + (++ipSeq % 250 + 1);

(async () => {
console.log('\nAUTH SLICE 2 — ISSUE / VERIFY HANDLERS\n' + '='.repeat(70));
await resetUsers(); await wipe();

/* ══ A. issue ══ */
console.log('\nA. Issuing sends a code to the account\'s own address');
{
  const r = await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  ck('A', 'ok', r.ok === true, JSON.stringify(r.reason));
  ck('A', 'one email was sent', SENT.length === 1, SENT.length);
  ck('A', 'to the address on the Auth record', SENT[0].to === EMAIL_A, SENT[0].to);
  ck('A', 'the six-digit code is in the body', /\b\d{6}\b/.test(SENT[0].text), SENT[0].text.slice(0, 40));
  ck('A', 'the response NEVER contains the code',
     !/\b\d{6}\b/.test(JSON.stringify(r)), JSON.stringify(r));
  ck('A', 'the address is masked in the response', /•/.test(r.emailHint) && r.emailHint !== EMAIL_A,
     r.emailHint);
  ck('A', 'a challenge document now exists',
     (await db.collection(challenge.COLLECTION).doc(UID_A).get()).exists);
}

/* ══ B. THE ADDRESS CANNOT BE REDIRECTED ══
   The whole attack: sign in with a stolen password, ask for the code to go somewhere you
   control. Neither the uid nor the email may come from the caller. */
console.log('\nB. A caller cannot choose the uid or the address');
{
  await wipe();
  const r = await H.emailChallengeIssue(reqFor(UID_A, {
    uid: UID_B, email: 'attacker@evil.test', to: 'attacker@evil.test',
  }, freshIp()));
  ck('B', 'still ok', r.ok === true);
  ck('B', 'the mail went to the TOKEN\'s account, not the supplied one',
     SENT[0].to === EMAIL_A, SENT[0].to);
  ck('B', 'no attacker address appears anywhere in the payload',
     JSON.stringify(SENT[0]).indexOf('evil.test') === -1);
  ck('B', 'the challenge was written for the token uid, not the supplied uid',
     (await db.collection(challenge.COLLECTION).doc(UID_A).get()).exists &&
     !(await db.collection(challenge.COLLECTION).doc(UID_B).get()).exists);
  ck('B', 'the handler reads the uid from req.auth only',
     !/data\s*\.\s*uid|data\.email/.test(fs.readFileSync(path.join(FN, 'auth-dispatch.js'), 'utf8')
       .replace(/\/\*[\s\S]*?\*\//g, '')));
}

/* ══ C. unauthenticated ══ */
console.log('\nC. Unauthenticated callers are refused');
{
  for (const [name, fn] of Object.entries(H)) {
    let threw = null;
    try { await fn(reqFor(null, { code: '123456' }, freshIp())); } catch (e) { threw = e; }
    ck('C', name + ' rejects a call with no auth',
       !!threw && /unauthenticated/i.test(threw.code || threw.message), threw && (threw.code || threw.message));
  }
}

/* ══ D. verify marks the AUTH RECORD ══ */
console.log('\nD. A correct code verifies the Auth record itself');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  const code = SENT[0].text.match(/\b(\d{6})\b/)[1];

  const before = await admin.auth().getUser(UID_A);
  ck('D', 'CONTROL: the account starts unverified', before.emailVerified === false);

  const v = await H.emailChallengeVerify(reqFor(UID_A, { code }, freshIp()));
  ck('D', 'verify succeeds', v.ok === true && v.verified === true, JSON.stringify(v));

  const after = await admin.auth().getUser(UID_A);
  ck('D', 'the Firebase Auth record is now verified — server-set, not client-asserted',
     after.emailVerified === true);
  ck('D', 'and the challenge document was cleared',
     !(await db.collection(challenge.COLLECTION).doc(UID_A).get()).exists);
  const again = await H.emailChallengeVerify(reqFor(UID_A, { code }, freshIp()));
  ck('D', 're-verifying an already-verified account is a no-op, not an error',
     again.ok === true && again.alreadyVerified === true, JSON.stringify(again));
}

/* ══ E. wrong / expired / cross-account, through the handler ══ */
console.log('\nE. The model\'s refusals survive the handler');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  await admin.auth().updateUser(UID_B, { emailVerified: false });
  await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  const codeA = SENT[0].text.match(/\b(\d{6})\b/)[1];
  SENT.length = 0;
  await H.emailChallengeIssue(reqFor(UID_B, {}, freshIp()));
  const codeB = SENT[0].text.match(/\b(\d{6})\b/)[1];

  await db.collection('rateLimitsFallback').get().then(q => {
    const b = db.batch(); q.docs.forEach(d => b.delete(d.ref)); return q.size ? b.commit() : null;
  });
  const wrong = await H.emailChallengeVerify(reqFor(UID_A, { code: codeA === '000000' ? '111111' : '000000' }, freshIp()));
  ck('E', 'a wrong code is refused with a machine code',
     wrong.ok === false && wrong.reason === challenge.REASON.WRONG_CODE, wrong.reason);
  ck('E', 'and reports attempts remaining', typeof wrong.attemptsRemaining === 'number',
     wrong.attemptsRemaining);

  const cross = await H.emailChallengeVerify(reqFor(UID_A, { code: codeB }, freshIp()));
  ck('E', "B's code does not verify A", cross.ok === false, JSON.stringify(cross));
  ck('E', 'and A stays unverified in Auth',
     (await admin.auth().getUser(UID_A)).emailVerified === false);

  await db.collection('rateLimitsFallback').get().then(q => {
    const b = db.batch(); q.docs.forEach(d => b.delete(d.ref)); return q.size ? b.commit() : null;
  });
  ck('E', 'a malformed code is rejected before any lookup',
     (await H.emailChallengeVerify(reqFor(UID_A, { code: 'abcdef' }, freshIp()))).reason ===
       challenge.REASON.BAD_INPUT);
  ck('E', 'so is an empty one',
     (await H.emailChallengeVerify(reqFor(UID_A, { code: '' }, freshIp()))).reason ===
       challenge.REASON.BAD_INPUT);
  ck('E', "B's own code still works — A's attempts did not consume it",
     (await H.emailChallengeVerify(reqFor(UID_B, { code: codeB }, freshIp()))).ok === true);
}

/* ══ F. RATE LIMITING, including under a race ══ */
console.log('\nF. Abuse protection holds, and holds concurrently');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  const ip = freshIp();
  const profile = rateLimiter.LIMITS.otp;
  ck('F', 'the otp profile is a security action — fails closed when Redis is down',
     /_SECURITY_ACTIONS[\s\S]{0,200}'otp'/.test(fs.readFileSync(path.join(FN, 'redis-rate-limiter.js'), 'utf8')));

  /* Fire more requests from one IP than the profile allows, concurrently. */
  const n = profile.maxRequests + 4;
  const results = await Promise.all(Array.from({ length: n }, () =>
    H.emailChallengeIssue(reqFor(UID_A, {}, ip)).then(r => ({ ok: true, r }))
      .catch(e => ({ ok: false, code: e.code || e.message }))));
  const limited = results.filter(x => !x.ok && /resource-exhausted/i.test(x.code));
  ck('F', 'some concurrent requests are rate limited', limited.length > 0,
     limited.length + ' of ' + n + ' limited');
  ck('F', 'the number allowed never exceeds the profile',
     results.filter(x => x.ok).length <= profile.maxRequests,
     results.filter(x => x.ok).length + ' allowed, max ' + profile.maxRequests);
  ck('F', 'and no more emails were sent than requests allowed',
     SENT.length <= profile.maxRequests, SENT.length);

  /* Verify is rate limited too — otherwise re-issuing resets the attempt ceiling and an
     attacker with the password gets fresh guesses on a timer. */
  const ip2 = freshIp();
  const vres = await Promise.all(Array.from({ length: profile.maxRequests + 3 }, () =>
    H.emailChallengeVerify(reqFor(UID_A, { code: '000000' }, ip2)).then(() => ({ ok: true }))
      .catch(e => ({ ok: false, code: e.code || e.message }))));
  ck('F', 'verify is rate limited as well',
     vres.some(x => !x.ok && /resource-exhausted/i.test(x.code)),
     JSON.stringify(vres.map(x => x.ok ? 'ok' : x.code)).slice(0, 80));
}

/* ══ G. cooldown and send ceiling reach the caller ══ */
console.log('\nG. Cooldown and send ceiling are reported, not hidden');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  const second = await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  ck('G', 'an immediate resend is refused as cooldown',
     second.ok === false && second.reason === challenge.REASON.COOLDOWN, second.reason);
  ck('G', 'with a retry hint', typeof second.retryAfterMs === 'number' && second.retryAfterMs > 0,
     second.retryAfterMs);
  ck('G', 'and NO second email was sent', SENT.length === 1, SENT.length);
  ck('G', 'the reason is a machine code, not prose',
     /^[a-z-]+$/.test(second.reason), second.reason);
}

/* ══ H. A PREFERENCE MUST NOT SUPPRESS A LOGIN CODE ══
   email-service._checkPreferences maps an unknown category to "account" and returns false
   when that preference is off. Had the verification mail carried a category, a user who
   turned account email off would never receive their own code and would be locked out by
   a marketing toggle. */
console.log('\nH. No preference can suppress the code');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  await db.collection('emailPreferences').doc(UID_A).set({
    account: false, marketing: false, transactional: false, otp: false,
  });
  const r = await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  ck('H', 'the code was still issued', r.ok === true, JSON.stringify(r.reason));
  ck('H', 'and the mail was still sent', SENT.length === 1, SENT.length);
  ck('H', 'the payload carries NO category, so the preference gate never runs',
     SENT[0].category === undefined, String(SENT[0].category));
  ck('H', 'but keeps uid for traceability', SENT[0].uid === UID_A);
  /* The real send() would have skipped it — prove the hazard was real, not theoretical. */
  const wouldSkip = await (async () => {
    const orig = emailSvc.send; emailSvc.send = realSend;
    let out = null;
    try {
      out = await realSend({ to: EMAIL_A, uid: UID_A, category: 'account',
                             subject: 'x', html: '<p>x</p>' });
    } catch (e) { out = { error: e.message }; }
    emailSvc.send = orig;
    return out;
  })();
  ck('H', 'CONTROL: the same mail WITH a category would have been skipped',
     wouldSkip && wouldSkip.skipped === true && wouldSkip.reason === 'opted_out',
     JSON.stringify(wouldSkip));
}

/* ══ I. the challenge stays server-only ══ */
console.log('\nI. Nothing leaks the challenge to the caller');
{
  await wipe();
  await admin.auth().updateUser(UID_A, { emailVerified: false });
  const iss = await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  const st = await H.emailChallengeStatus(reqFor(UID_A, {}, freshIp()));
  const blob = JSON.stringify(iss) + JSON.stringify(st);
  ck('I', 'no codeHash in any response', blob.indexOf('codeHash') === -1);
  ck('I', 'no salt', blob.indexOf('salt') === -1);
  ck('I', 'no plaintext code', !/\b\d{6}\b/.test(blob), blob.slice(0, 80));
  ck('I', 'status reports what the UI needs', st.ok === true && st.challenge &&
     typeof st.challenge.attemptsRemaining === 'number' && typeof st.challenge.canResendAt === 'number',
     JSON.stringify(st.challenge));
  ck('I', 'and the authoritative verified flag', st.emailVerified === false);
  ck('I', 'the address is masked here too', /•/.test(st.emailHint), st.emailHint);

  /* ── AUTH SLICE 6B — the enforcement verdict, end to end ──────────────────
     The pure-function contract is proven in test-auth-policy-server.js. What can only be
     proven HERE, against a real emulator, is that the dispatcher feeds the policy a real
     UserRecord: metadata.creationTime arrives from Firebase as an RFC-1123 string, and a
     handler that forgot to pass metadata would report "not enforced" for everybody and
     look perfectly healthy doing it. */
  const policy = require(path.join(FN, 'auth-policy.js'));
  ck('I', 'status carries a server-computed enforcement verdict',
     st.enforcement && typeof st.enforcement.applies === 'boolean', JSON.stringify(st.enforcement));
  /* STATE-AWARE. This asserted "the shipped cutoff is the sentinel, so enforcement is OFF"
     — the same conflation that turned 31 client-side assertions red when the release armed.
     This one lives in an emulator-only suite, so it was missed by that sweep and surfaced
     here instead. What must hold in EITHER state: the dispatcher reports the cutoff the
     server actually carries, and its `enabled` flag agrees with that value rather than
     being independently decided. */
  ck('I', 'status reports the cutoff the server actually carries',
     st.enforcement.cutoff === policy.CUTOFF_ISO, JSON.stringify(st.enforcement));
  ck('I', 'the enabled flag agrees with that cutoff',
     st.enforcement.enabled === (policy.CUTOFF_ISO !== policy.SENTINEL_ISO),
     JSON.stringify(st.enforcement));
  /* THIS WAS A TIME BOMB, and it detonated on 2026-08-20.

     It asserted the harness account is grandfathered "whether enforcement is on
     or off", reasoning that the account was created "before any sane activation
     instant". That held only while the shipped cutoff lay in the FUTURE: the
     account is created moments before the check, so once the cutoff passed, a
     brand-new account is AFTER it and enforcement correctly applies. The gate
     armed on schedule and the assertion, not the product, was wrong.

     A test that turns red on a date nobody changed anything on is worse than one
     that always fails: it passes review and detonates later. So the direction is
     now DERIVED from policy.CUTOFF_ISO — the same source the two assertions above
     already use — instead of assuming which side of it today falls on.

     The deterministic BOUNDARY proof is immediately below: cutoff moved to a past
     instant must enforce this same account, and moved to a future instant must
     grandfather it. That pair never depends on the calendar. */
  const _cutoffMs = Date.parse(policy.CUTOFF_ISO);
  const _cutoffIsFuture = !isFinite(_cutoffMs) || _cutoffMs > Date.now();
  ck('I', 'enforcement follows the SHIPPED cutoff, whichever side of it today falls',
     st.enforcement.applies === !_cutoffIsFuture,
     'cutoff ' + policy.CUTOFF_ISO + ' is ' + (_cutoffIsFuture ? 'AHEAD' : 'PAST') +
     ' so a just-created account must be ' + (_cutoffIsFuture ? 'grandfathered' : 'enforced') +
     '  ->  ' + JSON.stringify(st.enforcement));

  /* Now the part that catches a handler which never reads the record: flip the server
     cutoff to a long-past date and the SAME account must become enforced. If metadata is
     not reaching the policy, this stays false. */
  const realUser = await admin.auth().getUser(UID_A);
  ck('I', 'the Auth record really carries a creationTime',
     !!(realUser.metadata && realUser.metadata.creationTime), String(realUser.metadata));
  const shipped = policy.CUTOFF_ISO;
  policy.CUTOFF_ISO = '2000-01-01T00:00:00.000Z';
  try {
    const st2 = await H.emailChallengeStatus(reqFor(UID_A, {}, freshIp()));
    ck('I', 'with an active cutoff the SAME account is enforced — metadata does reach the policy',
       st2.enforcement.applies === true, JSON.stringify(st2.enforcement));
    ck('I', 'and the reported cutoff follows the server, not a client claim',
       st2.enforcement.cutoff === '2000-01-01T00:00:00.000Z', st2.enforcement.cutoff);
    ck('I', 'a future cutoff grandfathers the same account again',
       await (async () => {
         policy.CUTOFF_ISO = '2090-01-01T00:00:00.000Z';
         const st3 = await H.emailChallengeStatus(reqFor(UID_A, {}, freshIp()));
         return st3.enforcement.applies === false;
       })());
  } finally {
    policy.CUTOFF_ISO = shipped;         /* never leave the cutoff moved */
  }
  ck('I', 'the shipped cutoff is restored after the probe', policy.CUTOFF_ISO === shipped);

  /* Enforcement must not have leaked into the parts that must stay unconditional. */
  const issAgain = await H.emailChallengeIssue(reqFor(UID_A, {}, freshIp()));
  ck('I', 'issue() still works regardless of policy (re-verification campaigns need this)',
     issAgain && (issAgain.ok === true || issAgain.reason === 'cooldown'),
     JSON.stringify(issAgain));
}

/* ══ J. wiring and slice boundary ══ */
console.log('\nJ. Wiring, and the slice boundary');
{
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('J', 'authDispatch is re-exported by name', /exports\.authDispatch\s*=/.test(idx));
  ck('J', 'the test-only _h map is NOT exported as a function',
     !/exports\.\w*\s*=\s*authDispatcher\._h/.test(idx));
  const src = fs.readFileSync(path.join(FN, 'auth-dispatch.js'), 'utf8');
  ck('J', 'App Check is enforced', /enforceAppCheck:\s*true/.test(src));
  ck('J', 'it reuses email-service, not a second mail pipeline',
     /require\(['"]\.\/email-service['"]\)/.test(src) &&
     !/sendgrid|nodemailer|mailgun/i.test(src.replace(/SENDGRID_API_KEY/g, '')));
  ck('J', 'it reuses the shared rate limiter',
     /require\(['"]\.\/redis-rate-limiter['"]\)/.test(src));
  /* Comment-stripped: the source mentions sendOrQueue only in the note explaining why it
     is NOT used, and matching raw text flagged the explanation as the thing it warns
     against. */
  const execSrc = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ck('J', 'it uses send(), not the 2-minute queue',
     /emailSvc\.send\(/.test(execSrc) && !/sendOrQueue/.test(execSrc),
     (execSrc.match(/sendOrQueue/g) || []).join(','));

  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* RETIRED at Slice 3 — 'auth.js' and 'firebase.js' were in this list.
     They asserted that Slice 2 had not begun the login-path work, which was the right
     boundary for Slice 2 and is now false by authorisation: Slice 3 is that work. The
     two names are removed rather than allowlisted, because an allowlist here would
     silently stop noticing any future change to the login path.

     login.html and firestore.rules stay: Slice 4 owns the verification screen and the
     rules remain frozen at ca9e8924, so both are still live constraints. What Slice 2
     itself must not do is reach into the client, which is asserted directly below. */
  /* RETIRED at Slice 4 — 'login.html' was in this list. It meant "the verification screen
     does not exist yet", which is now false by authorisation. firestore.rules stays: the
     ruleset is still frozen at ca9e8924, so that one is a live constraint.

     The durable replacement is below: nothing this dispatcher owns may surface on the
     page. */
  ['firestore.rules'].forEach(f =>
    ck('J', f + ' untouched', !changed.includes(f), changed.join(', ')));
  {
    const page = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
    ck('J', 'no dispatcher internals reach the login page',
       !/authEmailChallenges|SENDGRID|emailChallengeIssue\s*\(/.test(page));
  }
  /* execSrc, not src: the header comment explains that verification must not depend on
     "a localStorage value", and matching raw text flagged that explanation as the thing
     it warns against — the same comment-vs-code trap that first bit the sendOrQueue
     assertion a few lines up. */
  ck('J', 'the dispatcher is server-only — it reaches into no client surface',
     !/\bdocument\.|\bwindow\.|localStorage|sessionStorage/.test(execSrc));
  ck('J', 'no cart or wishlist product file touched',
     !changed.some(f => /cart|wishlist/i.test(f) && !/^scripts\//.test(f)),
     changed.filter(f => /cart|wishlist/i.test(f)).join(', '));
  ck('J', 'no Stories work', !changed.some(f => /stor(y|ies)/i.test(f)));
}

console.log('\n' + '='.repeat(70));
console.log('Auth Slice 2 acceptance\n');
['A','B','C','D','E','F','G','H','I','J'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
