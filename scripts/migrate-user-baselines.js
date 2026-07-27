/* ============================================================================
   SOKONI — Existing-user baseline migration  (Admin SDK, idempotent)

   Scans EVERY Firebase Auth account and creates ONLY the missing baseline
   Firestore docs/fields — never overwriting valid data — so historical accounts
   behave like newly-created ones. Reuses the EXACT gap logic the client bootstrap
   uses (sokoni-user-bootstrap.js planners), so client and migration stay in lock-
   step. Being Admin SDK it bypasses rules, so it can additionally backfill
   createdAt from the REAL Auth creation time (never fabricated).

   USAGE
     node scripts/migrate-user-baselines.js              # DRY RUN (default) — no writes
     node scripts/migrate-user-baselines.js --live       # perform writes
     node scripts/migrate-user-baselines.js --limit 50   # cap accounts (testing)
     node scripts/migrate-user-baselines.js --live --limit 50

   Idempotent + safe to rerun: a complete account produces zero writes.
   ============================================================================ */
'use strict';
const path = require('path');
const admin = require(path.join(process.cwd(), 'functions', 'node_modules', 'firebase-admin'));
const PLAN  = require(path.join(process.cwd(), 'sokoni-user-bootstrap.js'));

const LIVE   = process.argv.includes('--live');
const li     = process.argv.indexOf('--limit');
const LIMIT  = li >= 0 ? parseInt(process.argv[li + 1], 10) : Infinity;
const PROJECT = 'sokoni-aeb26';

/* ── PURE: compute the write plan for one account. Testable — inject tsFromDate. ──
   userRecord: { uid, displayName, email, phoneNumber, photoURL, creationTime }
   docs: { user|null, wallet|null, notif|null }
   Returns { userDoc:{op,data}, wallet:{op,data}, notif:{op,data} } */
function computeUserPlan(userRecord, docs, tsFromDate) {
  const authUser = {
    uid: userRecord.uid, displayName: userRecord.displayName,
    email: userRecord.email, phoneNumber: userRecord.phoneNumber, photoURL: userRecord.photoURL,
  };
  const userDoc = PLAN.planUserDoc(docs.user || null, authUser);

  /* Server-only backfill: createdAt from the REAL Auth creation time when absent.
     Admin bypasses rules; this is authentic history, not a fabricated timestamp. */
  const needsCreatedAt = !docs.user || docs.user.createdAt == null;
  if (needsCreatedAt && userRecord.creationTime) {
    const ts = tsFromDate(new Date(userRecord.creationTime));
    if (userDoc.op === 'create') { userDoc.data.createdAt = ts; }
    else if (userDoc.op === 'update') { userDoc.data.createdAt = ts; }
    else { /* doc complete but missing createdAt only */ return {
      userDoc: { op: 'update', data: { createdAt: ts } },
      wallet: PLAN.planWallet(docs.wallet || null),
      notif:  PLAN.planNotifPrefs(docs.notif || null),
    }; }
  }

  return {
    userDoc,
    wallet: PLAN.planWallet(docs.wallet || null),
    notif:  PLAN.planNotifPrefs(docs.notif || null),
  };
}

/* ── I/O runner ─────────────────────────────────────────────────────────────── */
async function run() {
  admin.initializeApp({ projectId: PROJECT });
  const db = admin.firestore();
  const auth = admin.auth();
  const FieldValue = admin.firestore.FieldValue;
  const tsFromDate = (d) => admin.firestore.Timestamp.fromDate(d);

  const sum = {
    scanned: 0, hadUserDoc: 0, repaired: 0,
    userDocsCreated: 0, userFieldsFilled: 0, walletsCreated: 0, notifPrefsCreated: 0,
    fieldTally: {}, errors: 0,
  };
  const bumpFields = (data) => Object.keys(data || {}).forEach(k => {
    sum.fieldTally[k] = (sum.fieldTally[k] || 0) + 1; sum.userFieldsFilled++;
  });

  console.log(`\n[migrate-user-baselines] project=${PROJECT}  mode=${LIVE ? 'LIVE (writing)' : 'DRY RUN (no writes)'}  limit=${LIMIT === Infinity ? 'all' : LIMIT}\n`);

  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    pageToken = page.pageToken;

    for (const ur of page.users) {
      if (sum.scanned >= LIMIT) { pageToken = undefined; break; }
      sum.scanned++;
      const uid = ur.uid;
      try {
        const [uSnap, wSnap, nSnap] = await Promise.all([
          db.collection('users').doc(uid).get(),
          db.collection('wallets').doc(uid).get(),
          db.collection('notificationPrefs').doc(uid).get(),
        ]);
        if (uSnap.exists) sum.hadUserDoc++;

        const rec = {
          uid, displayName: ur.displayName, email: ur.email,
          phoneNumber: ur.phoneNumber, photoURL: ur.photoURL,
          creationTime: ur.metadata && ur.metadata.creationTime,
        };
        const plan = computeUserPlan(rec,
          { user: uSnap.exists ? uSnap.data() : null, wallet: wSnap.exists ? wSnap.data() : null, notif: nSnap.exists ? nSnap.data() : null },
          tsFromDate);

        let touched = false;
        const batch = db.batch();

        if (plan.userDoc.op === 'create') {
          touched = true; sum.userDocsCreated++; bumpFields(plan.userDoc.data);
          if (LIVE) batch.set(db.collection('users').doc(uid), plan.userDoc.data, { merge: true });
        } else if (plan.userDoc.op === 'update') {
          touched = true; bumpFields(plan.userDoc.data);
          if (LIVE) batch.set(db.collection('users').doc(uid), plan.userDoc.data, { merge: true });
        }
        if (plan.wallet.op === 'create') {
          touched = true; sum.walletsCreated++;
          if (LIVE) batch.set(db.collection('wallets').doc(uid), { uid, balance: 0, currency: 'KES', createdAt: FieldValue.serverTimestamp() });
        }
        if (plan.notif.op === 'create') {
          touched = true; sum.notifPrefsCreated++;
          const np = plan.notif.data; np.uid = uid; np.createdAt = FieldValue.serverTimestamp();
          if (LIVE) batch.set(db.collection('notificationPrefs').doc(uid), np);
        }

        if (touched) {
          sum.repaired++;
          if (LIVE) await batch.commit();
        }
        if (sum.scanned % 250 === 0) console.log(`  …scanned ${sum.scanned}, repaired ${sum.repaired}`);
      } catch (e) {
        sum.errors++;
        console.warn(`  ! ${uid}: ${e.code || e.message}`);
      }
    }
  } while (pageToken && sum.scanned < LIMIT);

  console.log('\n──────────── SUMMARY ────────────');
  console.log(`mode                : ${LIVE ? 'LIVE' : 'DRY RUN'}`);
  console.log(`accounts scanned    : ${sum.scanned}`);
  console.log(`had a users doc     : ${sum.hadUserDoc}`);
  console.log(`accounts ${LIVE ? 'repaired' : 'to repair'}   : ${sum.repaired}`);
  console.log(`user docs created   : ${sum.userDocsCreated}`);
  console.log(`user fields ${LIVE ? 'filled ' : 'to fill'} : ${sum.userFieldsFilled}`);
  console.log(`wallets created     : ${sum.walletsCreated}`);
  console.log(`notifPrefs created  : ${sum.notifPrefsCreated}`);
  console.log(`errors              : ${sum.errors}`);
  console.log('field fill tally    :', JSON.stringify(sum.fieldTally));
  if (!LIVE) console.log('\n(DRY RUN — nothing was written. Re-run with --live to apply.)');
  console.log('─────────────────────────────────\n');
  process.exit(0);
}

if (require.main === module) run().catch(e => { console.error('FATAL', e); process.exit(1); });
module.exports = { computeUserPlan };
