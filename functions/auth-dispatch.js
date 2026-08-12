/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Auth dispatch  (Auth Slice 2: issue + verify handlers)
   ------------------------------------------------------------------------------
   onCall  authDispatch({ op, ... })   App Check enforced, authenticated only.

   Ops:  emailChallengeIssue   send a fresh code to the account's own address
         emailChallengeVerify  check a code, and on success mark the Auth record verified
         emailChallengeStatus  what the UI needs to render, and nothing more

   THE UID IS NEVER A PARAMETER. Every op derives it from request.auth.uid, so a caller
   cannot ask for a code to be sent for somebody else's account, and cannot verify against
   another account's challenge. The model already binds a challenge to a uid by document
   id; this is the other half of that boundary.

   THE EMAIL ADDRESS IS NEVER A PARAMETER EITHER. It is read from the Firebase Auth record
   with the Admin SDK. A client-supplied address is the whole attack: sign in, ask for the
   code to go to an address you control, and the second factor is yours. The only address
   this will ever send to is the one already on the account.

   WHY THIS IS NOT PART OF commerceDispatch. That dispatcher carries commerce ops and the
   IntaSend secret. Authentication is a different blast radius and gets its own function so
   its rate limits, secrets and failure modes stay separable.

   SLICE BOUNDARY. Nothing here changes the login path. auth.js still completes a session
   on password alone; wiring the gate is Slice 3. What exists after this slice is a server
   that can issue and verify a code, and record the result authoritatively.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const challenge = require('./auth-email-challenge');
const emailSvc = require('./email-service');
const rateLimiter = require('./redis-rate-limiter');

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

const _OPTS = {
  region: 'us-central1',
  enforceAppCheck: true,
  secrets: [SENDGRID_API_KEY],
  timeoutSeconds: 30,
  memory: '256MiB',
  maxInstances: 20,
};

/* ── rate limiting ────────────────────────────────────────────────────────────
   TWO buckets, per call: one keyed by account, one by IP.

   The shared 'otp' profile is byUid:false, i.e. IP only, and its identifier helper falls
   back to the literal string 'unknown' when no x-forwarded-for reaches it. For an
   authentication factor neither is enough on its own:

     IP only     an attacker holding a stolen password gets a fresh budget from every new
                 address, while a whole office behind one NAT shares a single budget and
                 locks each other out.
     uid only    an attacker can spray many accounts from one machine.
     'unknown'   if the header is ever absent, every caller on the planet shares one
                 bucket — which is either no protection or a global outage, depending on
                 traffic.

   Calling the shared limiter twice — once forced byUid, once as configured — costs one
   extra counter and removes all three. The limiter is reused, not replaced; both buckets
   use its 'otp' profile, which is in its _SECURITY_ACTIONS set and therefore falls back
   to a durable Firestore counter rather than failing open when Redis is down. */
async function _limit(req) {
  await rateLimiter.checkRateLimit(req, 'otp', { byUid: true });   /* per account */
  await rateLimiter.checkRateLimit(req, 'otp');                    /* per IP      */
}

/* ── the email ────────────────────────────────────────────────────────────────
   Deliberately plain. A verification mail that looks like marketing gets filtered, and
   the only thing that matters is the six digits. */
function _codeEmail(code, minutes) {
  return {
    subject: `${code} is your SOKONI verification code`,
    html:
      '<div style="font-family:Segoe UI,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
      '<h2 style="margin:0 0 8px;font-size:18px;color:#111">Confirm it\'s you</h2>' +
      '<p style="margin:0 0 20px;font-size:14px;color:#555">Enter this code to finish signing in to SOKONI.</p>' +
      '<div style="font-size:34px;font-weight:800;letter-spacing:10px;text-align:center;' +
      'padding:18px;background:#f5f5f5;border-radius:12px;color:#111">' + code + '</div>' +
      '<p style="margin:20px 0 0;font-size:12px;color:#777">This code expires in ' + minutes +
      ' minutes and can be used once. If you did not try to sign in, someone may have your ' +
      'password — change it.</p></div>',
    text: 'Your SOKONI verification code is ' + code + '. It expires in ' + minutes +
          ' minutes and can be used once. If you did not try to sign in, change your password.',
  };
}

/* ── issue ────────────────────────────────────────────────────────────────────
   Rate limited under the 'otp' profile, which is in the limiter's _SECURITY_ACTIONS set —
   so if Redis is down it falls back to a durable Firestore counter rather than failing
   open. An auth factor that stops being rate limited when a cache dies is not rate
   limited. */
async function emailChallengeIssue(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  await _limit(req);

  /* The address comes from the Auth record, never from req.data. */
  let user;
  try { user = await admin.auth().getUser(uid); }
  catch (e) { throw new HttpsError('not-found', 'Account not found.'); }

  const email = user.email;
  if (!email) return { ok: false, reason: 'no-email' };

  /* Already verified: nothing to issue. Telling the CALLER about their own account is not
     a leak — they are authenticated as it. */
  if (user.emailVerified) return { ok: true, alreadyVerified: true };

  const issued = await challenge.issue(uid, email);
  if (!issued.ok) {
    /* Cooldown and send-ceiling come back as machine codes; the UI decides the wording. */
    return { ok: false, reason: issued.reason, retryAfterMs: issued.retryAfterMs || null };
  }

  const minutes = Math.round(challenge.LIMITS.TTL_MS / 60000);
  const mail = _codeEmail(issued.code, minutes);

  /* send(), not sendOrQueue(): the queue drains on a 2-minute schedule and a login code
     that arrives after the challenge expires is worse than useless.

     `category` is deliberately OMITTED. email-service._checkPreferences maps an unknown
     category to "account" and returns false when that preference is off — so a user who
     had turned account email off would never receive their own login code and would be
     locked out of their account by a marketing preference. The guard is
     `payload.uid && payload.category`, so leaving category out skips the check entirely
     while keeping uid for traceability. A verification code is not a preference. */
  let delivered = false, deliveryError = null;
  try {
    const res = await emailSvc.send({
      to: email,
      uid,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      emailId: 'auth-code:' + uid + ':' + issued.expiresAt,
    });
    delivered = !(res && res.skipped);
    if (res && res.skipped) deliveryError = res.reason;
  } catch (e) {
    deliveryError = (e && e.message) || 'send-failed';
  }

  /* The code was issued whether or not the mail left the building — saying otherwise
     would let a caller re-issue past the cooldown by provoking send failures. The
     delivery outcome is reported separately so the UI can offer a resend honestly. */
  return {
    ok: true,
    delivered,
    deliveryError,
    expiresAt: issued.expiresAt,
    cooldownMs: issued.cooldownMs,
    sendCount: issued.sendCount,
    /* Never the code, and never the full address — enough to say "we sent it to j••@x.com". */
    emailHint: _maskEmail(email),
  };
}

function _maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return '';
  const name = s.slice(0, at), domain = s.slice(at);
  const keep = name.slice(0, Math.min(2, name.length));
  return keep + '•'.repeat(Math.max(1, name.length - keep.length)) + domain;
}

/* ── verify ───────────────────────────────────────────────────────────────────
   On success the Firebase Auth record is marked emailVerified. That is the point of the
   whole exercise: the authoritative flag lives on the Auth record, set by the Admin SDK,
   and no client assertion can produce it. Slice 3 reads it; nothing reads a cached profile
   blob or a localStorage value.

   Rate limited too. Without it the attempt ceiling could be reset by re-issuing, and an
   attacker with the password would get five fresh guesses per minute. */
async function emailChallengeVerify(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  await _limit(req);

  const code = String((req.data && req.data.code) || '').trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, reason: challenge.REASON.BAD_INPUT };

  let user;
  try { user = await admin.auth().getUser(uid); }
  catch (e) { throw new HttpsError('not-found', 'Account not found.'); }

  if (user.emailVerified) return { ok: true, alreadyVerified: true };

  /* The email is passed so the model can refuse a challenge issued for a DIFFERENT
     address — an account that changed email mid-flow does not complete on the old one. */
  const res = await challenge.verify(uid, code, { email: user.email });
  if (!res.ok) return { ok: false, reason: res.reason, attemptsRemaining: res.attemptsRemaining };

  /* Authoritative, server-side, and the only thing that makes verification real. */
  await admin.auth().updateUser(uid, { emailVerified: true });
  await challenge.clear(uid);

  return { ok: true, verified: true };
}

/* ── status ───────────────────────────────────────────────────────────────────
   Everything the UI needs to decide what to render, and nothing it could use to bypass
   anything: no hash, no salt, no code. */
async function emailChallengeStatus(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');

  let user;
  try { user = await admin.auth().getUser(uid); }
  catch (e) { throw new HttpsError('not-found', 'Account not found.'); }

  const st = await challenge.status(uid);
  return {
    ok: true,
    emailVerified: !!user.emailVerified,
    emailHint: _maskEmail(user.email),
    challenge: st.exists
      ? { expiresAt: st.expiresAt, expired: st.expired, consumed: st.consumed,
          attemptsRemaining: st.attemptsRemaining, canResendAt: st.canResendAt }
      : null,
  };
}

const _H = {
  emailChallengeIssue,
  emailChallengeVerify,
  emailChallengeStatus,
};

exports.authDispatch = onCall(_OPTS, async (req) => {
  const op = req.data && req.data.op;
  if (!op || typeof op !== 'string') {
    throw new HttpsError('invalid-argument',
      '"op" is required. Valid ops: ' + Object.keys(_H).sort().join(', '));
  }
  const handler = _H[op];
  if (!handler) {
    throw new HttpsError('not-found', 'Unknown auth operation: "' + op + '".');
  }
  return handler(req);
});

/* Exported for tests. NOT a Cloud Function — index.js re-exports authDispatch by name
   only, so nothing here becomes a deployable endpoint by accident. */
exports._h = _H;
exports._maskEmail = _maskEmail;
