#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   ACCOUNT DIAGNOSTIC — is this a password account, a Google-only account, or both?
   ------------------------------------------------------------------------------
   The reset UI cannot answer this, and must not: telling a caller "this address is
   Google-only" confirms the address exists, which is the enumeration leak the reset
   flow deliberately avoids (see auth.js and scripts/test-auth-password-reset.js).

   The answer is legitimately available to an OPERATOR holding admin credentials —
   which is a different trust level from an anonymous browser. That is what this is.

   Read-only by default. It prints no password and cannot set one.

     node scripts/diag-auth-account.js <email>
     node scripts/diag-auth-account.js <email> --link     # also mint a reset link

   --link mints a one-time password-reset URL directly, bypassing email delivery
   entirely. Useful precisely because delivery is currently unproven. THE LINK IS A
   CREDENTIAL: anyone holding it can set that account's password. Do not paste it
   into chat, a ticket, or a commit.

   Requires application-default credentials:
     gcloud auth application-default login
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');

/* firebase-admin lives in functions/, not at the repo root. */
let admin;
try {
  admin = require(path.resolve(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
} catch (e) {
  console.error('Cannot load firebase-admin from functions/node_modules.');
  console.error('Run `npm install` inside functions/ first.');
  process.exit(2);
}

const args  = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
const wantLink = args.includes('--link');

if (!email) {
  console.error('Usage: node scripts/diag-auth-account.js <email> [--link]');
  process.exit(2);
}

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });

(async () => {
  console.log('\n' + '='.repeat(66));
  console.log('  ACCOUNT DIAGNOSTIC — ' + PROJECT);
  console.log('='.repeat(66));

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      console.log('\n  ' + email);
      console.log('  NO ACCOUNT with this address.\n');
      console.log('  This is why no reset email arrived: Firebase sends nothing for an');
      console.log('  unregistered address, and the reset UI cannot say so without');
      console.log('  revealing which addresses are registered.\n');
      console.log('  Check for a typo, or find the account in the Firebase Console:');
      console.log('    Authentication -> Users -> search\n');
      process.exit(1);
    }
    console.error('\n  Lookup failed: ' + (e.code || e.message));
    console.error('  If this is a credentials error: gcloud auth application-default login\n');
    process.exit(2);
  }

  const providers = user.providerData.map((p) => p.providerId);
  const hasPassword = providers.includes('password');
  const hasGoogle   = providers.includes('google.com');

  console.log('\n  email          : ' + user.email);
  console.log('  uid            : ' + user.uid);
  console.log('  disabled       : ' + user.disabled);
  console.log('  emailVerified  : ' + user.emailVerified);
  console.log('  created        : ' + (user.metadata && user.metadata.creationTime));
  console.log('  last sign-in   : ' + (user.metadata && user.metadata.lastSignInTime));
  console.log('  providers      : ' + (providers.join(', ') || '(none)'));

  /* Role authority, so the same run also answers "is this an APPROVED merchant" —
     the other precondition the containment gate needs. Claims are the client
     authority of record; this reads them, it never sets them. */
  const claims = user.customClaims || {};
  const roleish = claims.role || claims.roles || null;
  console.log('  custom claims  : ' + (Object.keys(claims).length ? JSON.stringify(claims) : '(none)'));
  console.log('  seller/merchant: ' + (/seller|merchant|admin/i.test(JSON.stringify(roleish || '')) ? 'YES' : 'NOT IN CLAIMS'));

  console.log('\n' + '-'.repeat(66));
  if (hasPassword && hasGoogle) {
    console.log('  VERDICT: PASSWORD + GOOGLE — either method works.');
    console.log('  A reset link is valid for the password credential.');
  } else if (hasPassword) {
    console.log('  VERDICT: PASSWORD account.');
    console.log('  A reset email SHOULD arrive. If it does not, delivery is the defect,');
    console.log('  not the account. Check spam for noreply@' + PROJECT + '.firebaseapp.com,');
    console.log('  then use --link to bypass delivery entirely.');
  } else if (hasGoogle) {
    console.log('  VERDICT: GOOGLE-ONLY — there is NO password credential.');
    console.log('  No reset email can ever arrive for this account, no matter how many');
    console.log('  times it is requested. Sign in with "Continue with Google" instead.');
    console.log('  For the containment gate, which signs in with email+password, this');
    console.log('  account is UNUSABLE — use a password account, or add a password to');
    console.log('  this one from the Firebase Console.');
  } else {
    console.log('  VERDICT: no password and no Google provider — providers are: ' +
                (providers.join(', ') || '(none)'));
  }
  console.log('-'.repeat(66));

  if (wantLink) {
    if (!hasPassword) {
      console.log('\n  --link skipped: this account has no password credential, so a reset');
      console.log('  link would not give it one.\n');
      process.exit(0);
    }
    try {
      const link = await admin.auth().generatePasswordResetLink(email);
      console.log('\n  RESET LINK (a credential — do not share, do not paste into chat):\n');
      console.log('  ' + link + '\n');
      console.log('  Opening it lets you set a new password without any email.\n');
    } catch (e) {
      console.log('\n  Could not mint a reset link: ' + (e.code || e.message));
      console.log('  "Unable to create the email action link" usually means the project has');
      console.log('  no authorized continue-URL domain configured for auth actions.\n');
    }
  }
  process.exit(0);
})();
