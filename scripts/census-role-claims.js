#!/usr/bin/env node
/* Role-claim population census — READ ONLY.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> \
 *   GCLOUD_PROJECT=<project-id> \
 *   node scripts/census-role-claims.js [--out docs/rc-runs/role-claim-census.json] [--samples 25]
 *
 * WHAT THIS IS
 * A role is two facts that must agree: `users/{uid}.roles[]` (Firestore) and the
 * Auth custom claim (the only client-side authority since Role Authority Phases
 * 1-5). Three code paths could write one without the other; they now go through
 * functions/role-authority.js. This script measures the population those paths
 * already produced, and classifies every account:
 *
 *   CONSISTENT     roles[] and the claim agree
 *   CLAIM_MISSING  Firestore grants the role, the token does not carry it
 *                  → the account behaves as a buyer to the person who owns it
 *   ROLE_MISSING   the token carries the role, Firestore does not grant it
 *                  → rules and the client gate open doors the server disagrees with
 *   AMBIGUOUS      only a legacy signal asserts the role (a `role` string, an
 *                  isProvider/isDriver boolean, a registeredAs entry) while
 *                  roles[] does not — the account cannot be classified without
 *                  a human deciding which signal is the truth
 *
 * WHAT THIS IS NOT
 * It is not a repair. It performs ZERO writes — no Firestore write, no
 * setCustomUserClaims, no token revocation, nothing queued for another process
 * to act on. A repair over a population that has not been classified is how a
 * privilege gets granted to an account nobody decided to grant it to. Classify
 * first; decide the repair afterwards, deliberately.
 *
 * COST
 * One `users` collection scan (a projected read per document — `select()` keeps
 * it to the six fields that matter) plus paginated auth.listUsers(1000). On a
 * large project run it off-peak.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FUNCTIONS_DIR = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FUNCTIONS_DIR] }));

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = argOf('--out', null);
const SAMPLES = Number(argOf('--samples', 25));

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) {
  console.error('GCLOUD_PROJECT is required — refusing to guess which project to read.');
  process.exit(2);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('GOOGLE_APPLICATION_CREDENTIALS is required (Auth listUsers needs admin credentials).');
  process.exit(2);
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const auth = admin.auth();

/* The canonical role keys. `rider` is the key a driver application grants. */
const ROLE_KEYS = ['seller', 'rider', 'provider'];

/* Legacy assertions of the same role, by key. Any of these true while roles[]
   omits the key makes the account AMBIGUOUS rather than silently CONSISTENT. */
const LEGACY = {
  seller: (u) => u.role === 'seller' || u.sellerEnabled === true || u.isSeller === true,
  rider: (u) => u.role === 'rider' || u.role === 'driver' || u.isDriver === true || u.isRider === true,
  provider: (u) => u.role === 'provider' || u.isProvider === true,
};

const blank = () => ({ CONSISTENT: 0, CLAIM_MISSING: 0, ROLE_MISSING: 0, AMBIGUOUS: 0 });

async function main() {
  const started = new Date().toISOString();
  console.log(`\nRole-claim census — project ${PROJECT} — ${started}\n`);

  /* ── 1. Firestore side ─────────────────────────────────────────────────── */
  const users = new Map();
  let scanned = 0;
  const snap = await db.collection('users')
    .select('roles', 'role', 'registeredAs', 'isProvider', 'isDriver', 'isRider', 'sellerEnabled', 'isSeller')
    .get();
  snap.forEach((d) => { users.set(d.id, d.data() || {}); scanned++; });
  console.log(`  users scanned            ${scanned}`);

  /* ── 2. Auth side ──────────────────────────────────────────────────────── */
  const claims = new Map();
  let authed = 0, pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) { claims.set(u.uid, u.customClaims || {}); authed++; }
    pageToken = page.pageToken;
  } while (pageToken);
  console.log(`  auth accounts listed     ${authed}\n`);

  /* ── 3. Classify ───────────────────────────────────────────────────────── */
  const byRole = {};
  const samples = {};
  for (const k of ROLE_KEYS) { byRole[k] = blank(); samples[k] = { CLAIM_MISSING: [], ROLE_MISSING: [], AMBIGUOUS: [] }; }

  const orphanFirestore = [];   /* users/{uid} with a role but no Auth account   */
  const uids = new Set([...users.keys(), ...claims.keys()]);

  for (const uid of uids) {
    const u = users.get(uid) || {};
    const c = claims.get(uid);
    const roles = Array.isArray(u.roles) ? u.roles : [];

    for (const key of ROLE_KEYS) {
      const inRoles = roles.includes(key);
      const hasClaim = !!(c && c[key] === true);
      const legacy = !!(LEGACY[key] && LEGACY[key](u));
      const registered = !!(u.registeredAs && u.registeredAs[key] === true);

      if (!inRoles && !hasClaim && !legacy && !registered) continue;   /* not this role */

      if (!c && (inRoles || legacy || registered)) {
        /* Firestore grants a role to a uid Auth does not know. Not a claim
           divergence — a dangling account. Counted separately, never repaired. */
        if (orphanFirestore.length < SAMPLES) orphanFirestore.push({ uid, key });
        continue;
      }

      let verdict;
      if (inRoles && hasClaim) verdict = 'CONSISTENT';
      else if (inRoles && !hasClaim) verdict = 'CLAIM_MISSING';
      else if (!inRoles && hasClaim) verdict = 'ROLE_MISSING';
      else verdict = 'AMBIGUOUS';   /* legacy/registeredAs only, no roles[], no claim */

      byRole[key][verdict]++;
      if (verdict !== 'CONSISTENT' && samples[key][verdict].length < SAMPLES) {
        samples[key][verdict].push({
          uid,
          roles,
          claim: c ? c[key] === true : null,
          legacyRole: u.role || null,
          registeredAs: registered,
        });
      }
    }
  }

  /* ── 4. Open divergences already recorded by the primitive ─────────────── */
  let openReconcile = [];
  try {
    const rec = await db.collection('roleClaimReconcile').limit(200).get();
    openReconcile = rec.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.log(`  (roleClaimReconcile unreadable: ${e.message})`);
  }

  /* ── 5. Report ─────────────────────────────────────────────────────────── */
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ROLE       CONSISTENT  CLAIM_MISSING  ROLE_MISSING  AMBIGUOUS');
  for (const k of ROLE_KEYS) {
    const r = byRole[k];
    console.log('  ' + pad(k, 10) + pad(r.CONSISTENT, 12) + pad(r.CLAIM_MISSING, 15) + pad(r.ROLE_MISSING, 14) + r.AMBIGUOUS);
  }
  console.log(`\n  dangling (Firestore role, no Auth account)  ${orphanFirestore.length}${orphanFirestore.length >= SAMPLES ? '+ (sample cap)' : ''}`);
  console.log(`  open roleClaimReconcile records             ${openReconcile.length}`);

  for (const k of ROLE_KEYS) {
    for (const v of ['CLAIM_MISSING', 'ROLE_MISSING', 'AMBIGUOUS']) {
      if (!samples[k][v].length) continue;
      console.log(`\n  ${k} / ${v} (first ${samples[k][v].length}):`);
      for (const s of samples[k][v]) {
        console.log(`    ${s.uid}  roles=[${s.roles.join(',')}]  claim=${s.claim}  legacyRole=${s.legacyRole}  registeredAs=${s.registeredAs}`);
      }
    }
  }

  const report = {
    project: PROJECT,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    scanned: { users: scanned, authAccounts: authed },
    byRole,
    samples,
    danglingFirestoreRoles: orphanFirestore,
    openReconcile,
    note: 'READ-ONLY census. No repair was performed and none is implied by these counts.',
  };

  if (OUT) {
    const dest = path.resolve(process.cwd(), OUT);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report, null, 2));
    console.log(`\n  report written to ${dest}`);
  }

  const divergent = ROLE_KEYS.reduce((n, k) => n + byRole[k].CLAIM_MISSING + byRole[k].ROLE_MISSING + byRole[k].AMBIGUOUS, 0);
  console.log(`\n  ${divergent} account-role(s) are NOT consistent. Classification only — no repair was run.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\ncensus failed:', e.message, '\n');
  process.exit(1);
});
