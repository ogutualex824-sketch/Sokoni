'use strict';
/**
 * One-time script: grants admin: true custom claim to a Firebase Auth user.
 * Uses Application Default Credentials (Firebase CLI auth is sufficient).
 *
 * Run:
 *   node functions/scripts/set-admin-claim.js --email ogutualex824@gmail.com
 */

const admin = require('firebase-admin');

const PROJECT = 'sokoni-aeb26';

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const email = arg('email') || process.env.TARGET_EMAIL;
if (!email) {
  console.error('Usage: node set-admin-claim.js --email user@example.com');
  process.exit(1);
}

admin.initializeApp({ projectId: PROJECT });

(async () => {
  try {
    const user = await admin.auth().getUserByEmail(email);
    const existing = user.customClaims || {};
    await admin.auth().setCustomUserClaims(user.uid, { ...existing, admin: true });
    console.log(`\n admin:true claim set on ${email} (uid: ${user.uid})`);
    console.log(' Sign out and sign back in to refresh your JWT, then re-run typesense-setup.js\n');
    process.exit(0);
  } catch (e) {
    console.error('\n Failed:', e.message);
    console.error(' If you see credential errors, run:');
    console.error('   firebase login');
    console.error(' or set GOOGLE_APPLICATION_CREDENTIALS to a service account key.\n');
    process.exit(1);
  }
})();
