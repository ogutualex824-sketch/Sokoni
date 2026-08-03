#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   onboard-merchant.js — lookup-first merchant onboarding.

   THE RULE THIS SCRIPT EXISTS TO ENFORCE
   Firebase Auth is queried BEFORE anything is written. A duplicate Auth user is
   not a cosmetic problem: it splits a real person's orders, wallet, chat and
   reviews across two identities, and it is not repairable after the fact.

   So the order is absolute — lookup, decide, then write. `scripts/onboard-barber.js`
   performs no lookup at all (getUserByPhoneNumber/getUserByEmail appear zero
   times in it), which is why this exists rather than reusing it.

   SAFE BY DEFAULT
   Dry-run unless --commit is passed. Without credentials it stops and names the
   missing credential rather than creating partial data.

   USAGE
     node scripts/onboard-merchant.js --config merchants/julian.json
     node scripts/onboard-merchant.js --config merchants/julian.json --commit

   PHONE FORMAT
   Auth wants E.164 (+254710162218). Firestore stores `phoneNumber` in the same
   form — NOT `phone` as "254…". A mismatch returns not-found silently, which
   reads as "no existing account" and produces the exact duplicate this prevents.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const cfgIdx = argv.indexOf('--config');
if (cfgIdx === -1 || !argv[cfgIdx + 1]) {
  console.error('usage: onboard-merchant.js --config <file.json> [--commit]');
  process.exit(2);
}
const CFG = JSON.parse(fs.readFileSync(path.resolve(argv[cfgIdx + 1]), 'utf8'));

for (const k of ['businessName', 'ownerName', 'email', 'phoneNumber']) {
  if (!CFG[k]) { console.error('config missing required field: ' + k); process.exit(2); }
}
if (!/^\+\d{10,15}$/.test(CFG.phoneNumber)) {
  console.error('phoneNumber must be E.164, e.g. +254710162218 — got: ' + CFG.phoneNumber);
  process.exit(2);
}

/* ── Credentials, checked before anything else ───────────────────────────── */
let admin;
try {
  admin = require('firebase-admin');
} catch (e) {
  console.error('MISSING DEPENDENCY: firebase-admin\n  npm install --no-save firebase-admin');
  process.exit(1);
}

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: CFG.projectId || 'sokoni-aeb26',
    });
  }
} catch (e) {
  console.error('MISSING CREDENTIAL: Firebase Admin could not initialise.\n');
  console.error('  Provide ONE of:');
  console.error('    gcloud auth application-default login   (then set the quota project)');
  console.error('    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n');
  console.error('  Underlying error: ' + e.message);
  process.exit(1);
}

const auth = admin.auth();
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

const created = [];
const updated = [];
const skipped = [];

function label() { return COMMIT ? '' : '  [dry-run]'; }

/** Write only when --commit; always record what would happen. */
async function put(ref, data, what) {
  const snap = await ref.get();
  (snap.exists ? updated : created).push(what + '  (' + ref.path + ')');
  if (COMMIT) await ref.set(data, { merge: true });
}

(async () => {
  console.log('\nSOKONI merchant onboarding' + (COMMIT ? '  — COMMIT' : '  — DRY RUN (no writes)'));
  console.log('  ' + CFG.businessName + ' · ' + CFG.ownerName);
  console.log('  ' + CFG.email + ' · ' + CFG.phoneNumber + '\n');

  /* ── STEP 1: LOOKUP. Nothing is written before this completes. ─────────── */
  let user = null;
  let foundBy = null;

  try {
    user = await auth.getUserByEmail(CFG.email);
    foundBy = 'email';
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  if (!user) {
    try {
      user = await auth.getUserByPhoneNumber(CFG.phoneNumber);
      foundBy = 'phone';
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
  }

  if (user) {
    console.log('FOUND existing account by ' + foundBy + ' — reusing, NOT creating.');
    console.log('  uid: ' + user.uid);
    /* Link whichever identifier is missing, so one account answers to both. */
    const patch = {};
    if (!user.email) patch.email = CFG.email;
    if (!user.phoneNumber) patch.phoneNumber = CFG.phoneNumber;
    if (user.email && user.email.toLowerCase() !== CFG.email.toLowerCase()) {
      console.log('  NOTE: account email is ' + user.email + ', config says ' + CFG.email +
                  ' — left unchanged, this needs a human decision.');
    }
    if (Object.keys(patch).length) {
      console.log('  linking: ' + Object.keys(patch).join(', ') + label());
      if (COMMIT) await auth.updateUser(user.uid, patch);
      updated.push('auth user (linked ' + Object.keys(patch).join('+') + ')');
    } else {
      skipped.push('auth user — already has both email and phone');
    }
  } else {
    console.log('NO existing account for either identifier — will create ONE.' + label());
    if (COMMIT) {
      user = await auth.createUser({
        email: CFG.email,
        phoneNumber: CFG.phoneNumber,
        displayName: CFG.ownerName,
        emailVerified: false,
      });
      console.log('  uid: ' + user.uid);
    } else {
      user = { uid: '<would-be-created>' };
    }
    created.push('auth user');
  }

  const uid = user.uid;

  /* ── STEP 2: Firestore records, all under the SAME uid ─────────────────── */

  /* User-owned fields are DELIBERATELY absent, not blank-filled: photo, logo,
     banner, KYC, exact location, description, delivery areas, socials, pricing.
     Writing empty strings would make them look answered and hide them from any
     "incomplete profile" prompt. */
  const PENDING = ['photoURL', 'logo', 'banner', 'kyc', 'location', 'description',
                   'deliveryAreas', 'socials', 'pricing'];

  await put(db.collection('users').doc(uid), {
    uid, name: CFG.ownerName, email: CFG.email, phoneNumber: CFG.phoneNumber,
    roles: admin.firestore.FieldValue.arrayUnion('seller'),
    isSeller: true, updatedAt: now,
  }, 'users');

  await put(db.collection('sellers').doc(uid), {
    uid, sellerUid: uid,
    shopName: CFG.businessName, ownerName: CFG.ownerName,
    phoneNumber: CFG.phoneNumber, email: CFG.email,
    categories: CFG.categories || [],
    status: 'active', isVisible: true, published: true,
    acceptsOrders: true, chatEnabled: true, reviewsEnabled: true,
    searchableTerms: CFG.keywords || [],
    profileComplete: false, pendingFields: PENDING,
    createdAt: now, updatedAt: now,
  }, 'sellers');

  await put(db.collection('sellerSettings').doc(uid), {
    uid, notifications: true, orderAlerts: true, chatAlerts: true, updatedAt: now,
  }, 'sellerSettings');

  await put(db.collection('wallets').doc(uid), {
    uid, balance: 0, currency: 'KES', createdAt: now, updatedAt: now,
  }, 'wallets');

  console.log('\n── Summary ──');
  console.log('uid              : ' + uid);
  console.log('account          : ' + (foundBy ? 'FOUND by ' + foundBy : 'CREATED'));
  console.log('created          : ' + (created.length ? '\n  ' + created.join('\n  ') : 'none'));
  console.log('updated          : ' + (updated.length ? '\n  ' + updated.join('\n  ') : 'none'));
  if (skipped.length) console.log('skipped          : \n  ' + skipped.join('\n  '));
  console.log('pending (Julian) : ' + PENDING.join(', '));

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing was written. Re-run with --commit to apply.');
  } else {
    console.log('\nWritten. NOW VERIFY DISCOVERABILITY with real consumer queries —');
    console.log('search "Julian", "Crochet", "Handmade" — a successful write is NOT');
    console.log('proof the shop is findable. Then confirm OTP login and the dashboard.');
  }
})().catch((e) => {
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  console.error('Nothing further was written.');
  process.exit(1);
});
