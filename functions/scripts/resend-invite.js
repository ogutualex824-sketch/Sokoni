'use strict';
/**
 * Re-issue a platform invitation (fresh token, fresh 7-day expiry, fresh
 * password-setup link) for an invitee whose previous invitation has lapsed.
 *
 *   node functions/scripts/resend-invite.js --email a@b.com --role admin            (dry run)
 *   node functions/scripts/resend-invite.js --email a@b.com --role admin --send
 *
 * ── WHY A SCRIPT AND NOT THE CALLABLE ────────────────────────────────────────
 * `resendPasswordSetup` / `invitePlatformEmployee` both set `enforceAppCheck: true`,
 * so they are reachable only from an attested browser session. There is no admin
 * UI wired to either one yet (grep: they appear in functions/index.js and the
 * CHANGELOG, nowhere else). Until one exists, re-issuing an invitation out of band
 * is the only path — the same out-of-band posture as set-admin-claim.js: Admin SDK
 * on Application Default Credentials, requiring `firebase login` (or a service
 * account) on a machine authorised for this project. No in-app guard is weakened.
 *
 * ── WHY createInvitation() AND NOT A BARE RESET LINK ─────────────────────────
 * `invitations-core.createInvitation()` is the ONE invitation path (see the header
 * of that file). Going through it means the re-issue gets the same guarantees as
 * an original invite rather than a lookalike:
 *   • role consistency is re-checked BEFORE anyone is emailed, so a re-issue can
 *     never silently downgrade a claim the account already holds;
 *   • the setup mail is mandatory — if it cannot be delivered the call FAILS and
 *     the record is marked `blocked_no_setup_mail`, instead of leaving a stranded
 *     invitee that looks healthy in the Firebase console;
 *   • the `invitations` doc gets a new token, a new expiresAt and an incremented
 *     resendCount, and the action is written to `adminAudit`.
 * Minting a reset link by hand would deliver mail while recording none of that.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────
 * Inline delivery needs SENDGRID_API_KEY in the environment (defineSecret().value()
 * falls back to process.env outside the Functions runtime):
 *
 *   $env:SENDGRID_API_KEY = gcloud secrets versions access latest `
 *       --secret=SENDGRID_API_KEY --project=sokoni-aeb26
 *
 * Without it the send fails over to the durable `emailQueue`, which the deployed
 * `processEmailQueue` drains every 2 minutes — still delivered, just not confirmed
 * by this process. The script reports which of the two happened; it never claims
 * "sent" for a message that was merely queued.
 */

const admin = require('firebase-admin');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.indexOf('--' + name) !== -1;

const email     = String(arg('email') || '').toLowerCase().trim();
const roleArg   = arg('role');
const invitedBy = arg('invited-by') || 'ops-script:resend-invite';
const name      = arg('name');
const SEND      = has('send');

if (!email) {
  console.error('\nUsage: resend-invite.js --email <e> [--role admin] [--name "Full Name"] [--invited-by <who>] [--send]');
  console.error('Without --send this is a dry run: it reports state and sends nothing.\n');
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT });

/* Required AFTER initializeApp so the module binds to this app, not a default
   one with no project. */
const core = require('../invitations-core');

const fmt = (v) => (v == null || v === '' ? '(none)' : String(v));

(async () => {
  let user = null;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  const claims  = (user && user.customClaims) || {};
  const held    = core.CLAIM_RANK.filter((r) => claims[r] === true);
  /* Explicit --role wins; otherwise re-issue at the privilege already held so a
     re-send cannot quietly change what the person was granted. */
  const role    = roleArg || held[held.length - 1] || 'admin';
  const usable  = user ? core.hasUsablePassword(user) : false;

  console.log('\n  ── account ───────────────────────────────────────────────');
  console.log('  email        : ' + email);
  console.log('  uid          : ' + fmt(user && user.uid));
  console.log('  created      : ' + fmt(user && user.metadata.creationTime));
  console.log('  lastSignIn   : ' + fmt(user && user.metadata.lastSignInTime) +
              (user && !user.metadata.lastSignInTime ? '   ← never signed in' : ''));
  console.log('  providers    : ' + fmt(user && (user.providerData || []).map((p) => p.providerId).join(', ')));
  console.log('  claims held  : ' + (held.length ? held.join(', ') : '(none)'));
  console.log('  signable now : ' + (usable ? 'YES' : 'NO — needs a password-setup link'));

  /* Prior invitation record, so the re-issue is reported against what it replaces. */
  const inviteRef = admin.firestore().collection(core.COL).doc(core.inviteIdFor(email));
  const prior = await inviteRef.get();
  if (prior.exists) {
    const p = prior.data();
    const exp = p.expiresAt && p.expiresAt.toDate ? p.expiresAt.toDate() : null;
    console.log('\n  ── existing invitation ───────────────────────────────────');
    console.log('  status       : ' + fmt(p.status));
    console.log('  role         : ' + fmt(p.role));
    console.log('  expiresAt    : ' + fmt(exp && exp.toISOString()) +
                (exp && exp < new Date() ? '   ← EXPIRED' : ''));
    console.log('  resendCount  : ' + fmt(p.resendCount));
    console.log('  lastSentAt   : ' + fmt(p.lastSentAt && p.lastSentAt.toDate && p.lastSentAt.toDate().toISOString()));
  } else {
    console.log('\n  ── existing invitation ───────────────────────────────────');
    console.log('  (no record in `' + core.COL + '`)');
  }

  const verdict = core.checkRoleConsistency(role, claims);
  console.log('\n  ── re-issue plan ─────────────────────────────────────────');
  console.log('  role         : ' + role);
  console.log('  consistency  : ' + (verdict.ok ? 'OK (' + verdict.action + ')' : 'BLOCKED — ' + verdict.note));
  console.log('  sendgrid key : ' + (process.env.SENDGRID_API_KEY ? 'present (inline send)' : 'ABSENT (will fall back to emailQueue)'));

  if (usable) {
    console.log('\n  NOTE: this account can already sign in, so createInvitation() will');
    console.log('  record the invitation WITHOUT sending a setup link. If they have');
    console.log('  forgotten the password, send a normal password reset instead.\n');
  }

  if (!SEND) {
    console.log('\n  DRY RUN — nothing written, nothing emailed. Re-run with --send to apply.\n');
    process.exit(0);
  }
  if (!verdict.ok) {
    console.error('\n  Refusing to send: ' + verdict.note + '\n');
    process.exit(1);
  }

  const res = await core.createInvitation({
    email, role, invitedBy,
    name: name || (user && user.displayName) || '',
  });

  console.log('\n  ── result ────────────────────────────────────────────────');
  console.log('  ok           : ' + res.ok);
  console.log('  uid          : ' + res.uid);
  console.log('  role         : ' + res.role + ' (' + res.roleLabel + ')');
  console.log('  accountMade  : ' + res.authAccountCreated);
  console.log('  setupMailId  : ' + fmt(res.setupMailQueueId) +
              (res.setupMailQueueId ? '' : '   ← no setup mail (account already signable)'));
  console.log('  inviteId     : ' + res.inviteId);
  console.log('  acceptUrl    : ' + res.acceptUrl);
  console.log('\n  Invitation valid for 7 days. The password-setup link inside the');
  console.log('  email is a Firebase oobCode and expires SOONER (~1 hour) — if it');
  console.log('  lapses again, re-run this script.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n  Failed: ' + e.message);
  if (/credential|default/i.test(e.message)) {
    console.error('  Credentials: run `firebase login`, or set GOOGLE_APPLICATION_CREDENTIALS.');
  }
  console.error('');
  process.exit(1);
});
