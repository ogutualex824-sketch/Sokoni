'use strict';
/**
 * Grant (or revoke) platform admin claims on a Firebase Auth user.
 *
 *   node functions/scripts/set-admin-claim.js --email you@example.com
 *   node functions/scripts/set-admin-claim.js --phone +254705726803
 *   node functions/scripts/set-admin-claim.js --uid  aBcD1234...
 *   node functions/scripts/set-admin-claim.js --phone +254705726803 --super
 *   node functions/scripts/set-admin-claim.js --uid  aBcD1234... --revoke
 *
 * Add --dry-run to print the change without writing it.
 *
 * ── WHY THIS SCRIPT IS THE BOOTSTRAP PATH ────────────────────────────────────
 * Every in-app route to an admin claim is closed to a FIRST administrator:
 *
 *   bootstrapAdminClaim  functions/index.js:115  requires the caller's token
 *                        email to equal admin@mysokoni.co.ke, and grants only
 *                        `admin` — never `superAdmin`.
 *   grantAdminClaim      functions/index.js:171  caller must already be superAdmin
 *   grantPlatformRole    functions/index.js:4071 caller must already be superAdmin
 *   setUserRole          functions/super-admin.js:104  same
 *
 * Nothing in the codebase can produce the FIRST superAdmin claim, so
 * `_requireSuperAdmin` could never pass for anybody. A phone-only account is
 * doubly excluded: under phone sign-in `request.auth.token.email` is undefined,
 * so the bootstrap comparison fails regardless of which email is configured.
 *
 * This script runs on the Admin SDK with Application Default Credentials. That
 * is not a bypass — it is the intended out-of-band path, and its security
 * boundary is real: it requires `firebase login` (or a service-account key) on
 * a machine authorised for this project. No in-app guard is weakened and
 * nothing here is reachable from a browser.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION
 *   - looked users up by EMAIL only, so it could not target a phone-only
 *     account — which is exactly the account that needs it
 *   - granted `admin` only, leaving `superAdmin` permanently unobtainable
 *   - did not revoke refresh tokens, so a grant appeared to do nothing for up
 *     to an hour while the old token stayed valid
 *   - had no dry-run and no revoke
 */

const admin = require('firebase-admin');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.indexOf('--' + name) !== -1;

const email  = arg('email') || process.env.TARGET_EMAIL;
const phone  = arg('phone');
const uid    = arg('uid');
const SUPER  = has('super');
const REVOKE = has('revoke');
const DRY    = has('dry-run');

if (!email && !phone && !uid) {
  console.error('\nUsage: set-admin-claim.js (--email <e> | --phone <+2547…> | --uid <uid>) [--super] [--revoke] [--dry-run]\n');
  process.exit(1);
}

/* E.164 or nothing. Firebase stores phone numbers in E.164, so 0705726803 will
   simply not be found — better to say so than to report "no such user". */
function normalisePhone(p) {
  const t = String(p).replace(/[\s-]/g, '');
  if (/^\+\d{10,15}$/.test(t)) return t;
  if (/^0\d{9}$/.test(t)) return '+254' + t.slice(1);       /* Kenyan local form */
  return null;
}

admin.initializeApp({ projectId: PROJECT });

(async () => {
  try {
    let user;
    if (uid) {
      user = await admin.auth().getUser(uid);
    } else if (phone) {
      const e164 = normalisePhone(phone);
      if (!e164) {
        console.error('\n  "' + phone + '" is not a valid phone number.');
        console.error('  Firebase stores phone numbers in E.164 — try +254705726803.\n');
        process.exit(1);
      }
      user = await admin.auth().getUserByPhoneNumber(e164);
    } else {
      user = await admin.auth().getUserByEmail(email);
    }

    const existing = user.customClaims || {};
    /* Merge, never replace. functions/super-admin.js:134 replaces the whole
       claim object, which silently strips `admin` from an account being given
       another role — not a mistake worth repeating here. */
    const next = Object.assign({}, existing);

    if (REVOKE) {
      delete next.admin;
      delete next.superAdmin;
    } else {
      next.admin = true;                 /* superAdmin implies admin everywhere */
      if (SUPER) next.superAdmin = true;
    }

    console.log('\n  uid      : ' + user.uid);
    console.log('  email    : ' + (user.email || '(none)'));
    console.log('  phone    : ' + (user.phoneNumber || '(none)'));
    console.log('  providers: ' + ((user.providerData || []).map((p) => p.providerId).join(', ') || '(none)'));
    console.log('  before   : ' + JSON.stringify(existing));
    console.log('  after    : ' + JSON.stringify(next));

    if (DRY) {
      console.log('\n  DRY RUN — nothing written. Re-run without --dry-run to apply.\n');
      process.exit(0);
    }

    await admin.auth().setCustomUserClaims(user.uid, next);

    /* Force the next request to fetch fresh claims. Without this the user keeps
       the old token for up to an hour and the grant looks like it failed. */
    await admin.auth().revokeRefreshTokens(user.uid);

    console.log('\n  Claims updated; refresh tokens revoked.');
    console.log('  SIGN OUT AND BACK IN on the device — the token currently on');
    console.log('  that handset still carries the old claims until it is reissued.\n');
    process.exit(0);
  } catch (e) {
    console.error('\n  Failed: ' + e.message);
    if (/no user record/i.test(e.message)) {
      console.error('  No Firebase Auth user matches that identifier. An email-linked');
      console.error('  and a phone-linked account are two DIFFERENT users with');
      console.error('  different uids — see docs/IDENTITY_LINK_MIGRATION.md.');
    }
    if (/credential|default/i.test(e.message)) {
      console.error('  Credentials: run `firebase login`, or set');
      console.error('  GOOGLE_APPLICATION_CREDENTIALS to a service-account key.');
    }
    console.error('');
    process.exit(1);
  }
})();
