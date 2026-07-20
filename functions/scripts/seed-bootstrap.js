'use strict';
/**
 * Seed the bootstrap allowlist so a named account may establish itself as the
 * first platform administrator.
 *
 *   node functions/scripts/seed-bootstrap.js --phone +254705726803 --dry-run
 *   node functions/scripts/seed-bootstrap.js --phone +254705726803
 *   node functions/scripts/seed-bootstrap.js --email you@example.com
 *   node functions/scripts/seed-bootstrap.js --uid   aBcD1234...
 *   node functions/scripts/seed-bootstrap.js --status
 *
 * ── WHAT THIS SOLVES ────────────────────────────────────────────────────────
 * bootstrapAdminClaim used to compare request.auth.token.email against an
 * address hardcoded in functions/index.js. That made authorisation depend on
 * the AUTHENTICATION METHOD: a phone-authenticated user has no `email` claim at
 * all, so a super administrator signing in by phone could never satisfy it.
 *
 * It now checks the caller's UID against _systemConfig/bootstrap.allowedUids.
 * A UID is the same identity under phone, email or a linked provider, so
 * authorisation no longer depends on how someone signed in.
 *
 * ── WHY THIS IS NOT A BACK DOOR ─────────────────────────────────────────────
 * firestore.rules denies all client writes to _systemConfig, so this list can
 * only be written by a principal holding Google credentials for this project.
 * That is a stronger boundary than an email string in source, which anybody
 * able to create that mailbox could have claimed.
 *
 * Seeding grants nothing by itself. It only permits ONE call to
 * bootstrapAdminClaim, which then locks itself permanently. Every later role
 * change still requires an existing superAdmin.
 *
 * ── PREFER set-admin-claim.js FOR A DIRECT GRANT ────────────────────────────
 * If you simply want admin rights now, set-admin-claim.js --super writes the
 * claims directly and is one step. Use THIS script when you want the grant to
 * happen through the audited in-app path, leaving the lock and audit record.
 */

const admin = require('firebase-admin');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (n) => process.argv.indexOf('--' + n) !== -1;

const email = arg('email');
const phone = arg('phone');
const uid   = arg('uid');
const DRY   = has('dry-run');
const STATUS = has('status');

if (!STATUS && !email && !phone && !uid) {
  console.error('\nUsage: seed-bootstrap.js (--uid <uid> | --phone <+2547…> | --email <e>) [--dry-run]');
  console.error('       seed-bootstrap.js --status\n');
  process.exit(1);
}

function normalisePhone(p) {
  const t = String(p).replace(/[\s-]/g, '');
  if (/^\+\d{10,15}$/.test(t)) return t;
  if (/^0\d{9}$/.test(t)) return '+254' + t.slice(1);
  return null;
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const ref = db.collection('_systemConfig').doc('bootstrap');

(async () => {
  try {
    const snap = await ref.get();
    const cur = snap.exists ? (snap.data() || {}) : {};

    if (STATUS) {
      console.log('\n  _systemConfig/bootstrap');
      console.log('  exists      : ' + snap.exists);
      console.log('  locked      : ' + (cur.locked === true));
      console.log('  adminUid    : ' + (cur.adminUid || '(none)'));
      console.log('  allowedUids : ' + JSON.stringify(cur.allowedUids || []));
      if (cur.locked === true) {
        console.log('\n  Bootstrap is COMPLETE and permanently locked. Further admins are');
        console.log('  granted with grantAdminClaim by an existing superAdmin, or directly');
        console.log('  with set-admin-claim.js.\n');
      }
      process.exit(0);
    }

    if (cur.locked === true) {
      console.error('\n  Bootstrap is already locked (adminUid: ' + (cur.adminUid || '?') + ').');
      console.error('  Seeding now would have no effect — bootstrapAdminClaim refuses to run');
      console.error('  a second time by design. Use set-admin-claim.js to grant further admins.\n');
      process.exit(1);
    }

    let user;
    if (uid) user = await admin.auth().getUser(uid);
    else if (phone) {
      const e164 = normalisePhone(phone);
      if (!e164) {
        console.error('\n  "' + phone + '" is not valid. Firebase stores E.164 — try +254705726803.\n');
        process.exit(1);
      }
      user = await admin.auth().getUserByPhoneNumber(e164);
    } else user = await admin.auth().getUserByEmail(email);

    /* Identity-split detection. If the same person holds a phone account and an
       email account, they are two Firebase users with two UIDs, and seeding one
       does nothing for the other. Reported rather than merged — merging is
       irreversible and needs its own plan. */
    const others = [];
    if (user.phoneNumber && email) {
      const alt = await admin.auth().getUserByEmail(email).catch(() => null);
      if (alt && alt.uid !== user.uid) others.push('email ' + email + ' -> ' + alt.uid);
    }
    if (user.email && phone) {
      const e164 = normalisePhone(phone);
      const alt = e164 ? await admin.auth().getUserByPhoneNumber(e164).catch(() => null) : null;
      if (alt && alt.uid !== user.uid) others.push('phone ' + e164 + ' -> ' + alt.uid);
    }

    const allowed = Array.isArray(cur.allowedUids) ? cur.allowedUids.slice() : [];
    const already = allowed.includes(user.uid);
    if (!already) allowed.push(user.uid);

    console.log('\n  uid       : ' + user.uid);
    console.log('  email     : ' + (user.email || '(none)'));
    console.log('  phone     : ' + (user.phoneNumber || '(none)'));
    console.log('  providers : ' + ((user.providerData || []).map((p) => p.providerId).join(', ') || '(none)'));
    console.log('  allowedUids before : ' + JSON.stringify(cur.allowedUids || []));
    console.log('  allowedUids after  : ' + JSON.stringify(allowed));
    if (already) console.log('  (already present — no change)');

    if (others.length) {
      console.log('\n  IDENTITY SPLIT DETECTED — these are DIFFERENT Firebase users:');
      others.forEach((o) => console.log('    ' + o));
      console.log('  Seeding one UID does nothing for the other. Signing in with the');
      console.log('  other identity will still be denied. See docs/IDENTITY_LINK_MIGRATION.md.');
    }

    if (DRY) {
      console.log('\n  DRY RUN — nothing written.\n');
      process.exit(0);
    }

    await ref.set({
      allowedUids: allowed,
      seededAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('\n  Allowlist updated.');
    console.log('  Next: sign in as that account and call bootstrapAdminClaim once.');
    console.log('  It grants admin + superAdmin, then locks itself permanently.\n');
    process.exit(0);
  } catch (e) {
    console.error('\n  Failed: ' + e.message);
    if (/no user record/i.test(e.message)) {
      console.error('  No Firebase Auth user matches that identifier. The account must');
      console.error('  have signed in at least once before it can be seeded.');
    }
    if (/credential|default/i.test(e.message)) {
      console.error('  Run `firebase login`, or set GOOGLE_APPLICATION_CREDENTIALS.');
    }
    console.error('');
    process.exit(1);
  }
})();
