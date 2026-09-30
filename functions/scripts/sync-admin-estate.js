'use strict';
/**
 * Admin estate sweep — inventory, drift repair, and migration readiness.
 *
 *   node functions/scripts/sync-admin-estate.js            # dry run (default)
 *   node functions/scripts/sync-admin-estate.js --apply    # writes the registry backfill ONLY
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * One pass over every Auth account, producing four reports that were previously
 * guesswork:
 *
 *   C  ADMIN SYNC       every account holding a privileged custom claim, and
 *                       whether platformEmployees/{uid} agrees.
 *   D  NAMED IDENTITIES whether the intended platform addresses exist.
 *   E  AUTH METHODS     sign-in providers per account — the inventory a
 *                       passwordless migration has to start from.
 *   F  TOKEN IMPACT     who would be signed out if refresh tokens were revoked.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * With --apply, exactly one thing: it backfills platformEmployees/{uid} for
 * accounts that hold a privileged claim but have no registry row.
 *
 * That is safe, and the reason is worth stating because it is the whole argument
 * for doing it here rather than by hand:
 *
 *   - platformEmployees GRANTS NOTHING. firestore.rules exposes it read-only
 *     (`allow read: if isAdmin() || self`), no rule consults it, and no Cloud
 *     Function authorizes against it. admin.html reads it to LIST platform staff.
 *   - It is written today only by invitations-core.acceptInvitation(), so a claim
 *     granted by any other path never produces a row — which is why it is empty
 *     for every current administrator.
 *   - index.js removePlatformEmployee calls .update() on that document. update()
 *     REJECTS when the document is absent, so removing an administrator whose row
 *     was never created throws today. The backfill fixes that too.
 *
 * It does NOT set, change or remove a custom claim. It does NOT revoke a refresh
 * token. It does NOT create or delete an Auth account. Those are privilege
 * changes and belong to an explicit decision, not to a sync script.
 */

const admin = require('firebase-admin');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });
const auth = admin.auth();
const db   = admin.firestore();

const APPLY = process.argv.includes('--apply');

/* Mirrors CLAIM_ROLES in invitations-core.js and PLATFORM_ROLES in index.js.
   Kept as a literal rather than imported so this script stays runnable against
   a checkout whose functions/ does not load. */
const PRIVILEGED = ['superAdmin', 'admin', 'moderator', 'support', 'finance',
                    'driverCoordinator', 'financeReviewer', 'contentManager'];
const RANK = ['support', 'finance', 'contentManager', 'driverCoordinator',
              'financeReviewer', 'moderator', 'admin', 'superAdmin'];

/* Section D — the addresses the platform is meant to use. */
const NAMED = ['superadmin@mysokoni.co.ke', 'ceo@mysokoni.co.ke', 'company@mysokoni.co.ke'];

function highestRole(claims) {
  let best = null, bestRank = -1;
  for (const r of PRIVILEGED) {
    if (claims[r] !== true) continue;
    const i = RANK.indexOf(r);
    if (i > bestRank) { bestRank = i; best = r; }
  }
  return best;
}

(async () => {
  console.log('\nADMIN ESTATE SWEEP — ' + PROJECT + (APPLY ? '   [APPLY]' : '   [DRY RUN]'));
  console.log('='.repeat(80));

  /* ── one pass over every account ──────────────────────────────────────── */
  const all = [];
  let page;
  do {
    page = await auth.listUsers(1000, page && page.pageToken);
    page.users.forEach(u => all.push(u));
  } while (page.pageToken);

  console.log('\nAccounts in Firebase Auth: ' + all.length);

  const privileged = all.filter(u => highestRole(u.customClaims || {}));

  /* ══ C — ADMIN SYNC ════════════════════════════════════════════════════ */
  console.log('\n\nC. ADMIN SYNC — claims are the source of truth');
  console.log('='.repeat(80));
  console.log('Accounts holding a privileged claim: ' + privileged.length + '\n');

  const backfill = [];
  for (const u of privileged) {
    const claims = u.customClaims || {};
    const role = highestRole(claims);
    const held = PRIVILEGED.filter(r => claims[r] === true);
    const reg = await db.collection('platformEmployees').doc(u.uid).get();

    const state = !reg.exists ? 'MISSING'
      : (reg.data().active === false ? 'INACTIVE'
      : (reg.data().role !== role ? 'ROLE MISMATCH (' + reg.data().role + ')' : 'ok'));

    console.log('  ' + (u.email || '(no email)').padEnd(32)
      + (u.uid.slice(0, 14) + '…').padEnd(17)
      + held.join('+').padEnd(20)
      + 'registry: ' + state);

    if (state === 'MISSING') backfill.push({ u, role, held });
  }

  /* Registry rows whose account no longer holds a claim — reported, never
     auto-deactivated: that is a privilege change. */
  const regSnap = await db.collection('platformEmployees').get();
  const stale = [];
  for (const d of regSnap.docs) {
    if (d.data().active === false) continue;
    const u = privileged.find(x => x.uid === d.id);
    if (!u) stale.push({ id: d.id, email: d.data().email, role: d.data().role });
  }
  if (stale.length) {
    console.log('\n  STALE registry rows (active, but the account holds no claim):');
    stale.forEach(s => console.log('    ' + (s.email || s.id) + '  role=' + s.role));
    console.log('    Reported only. Deactivating a staff record is a privilege change.');
  } else {
    console.log('\n  No stale registry rows.');
  }

  if (backfill.length) {
    console.log('\n  Backfill needed for ' + backfill.length + ' account(s):');
    backfill.forEach(b => console.log('    ' + (b.u.email || b.u.uid) + '  ->  role=' + b.role));
    if (APPLY) {
      for (const b of backfill) {
        await db.collection('platformEmployees').doc(b.u.uid).set({
          uid: b.u.uid,
          email: b.u.email || null,
          displayName: b.u.displayName || '',
          role: b.role,
          active: true,
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
          /* Provenance matters: this row was derived from the claim, not from
             someone accepting an invitation. Anyone auditing later must be able
             to tell the difference. */
          source: 'claims-backfill',
          backfilledAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log('    written: ' + (b.u.email || b.u.uid));
      }
    } else {
      console.log('    (dry run — re-run with --apply to write)');
    }
  } else {
    console.log('\n  Registry already matches claims. Nothing to backfill.');
  }

  /* ══ D — NAMED IDENTITIES ══════════════════════════════════════════════ */
  console.log('\n\nD. NAMED PLATFORM IDENTITIES');
  console.log('='.repeat(80));
  for (const email of NAMED) {
    try {
      const u = await auth.getUserByEmail(email);
      const held = PRIVILEGED.filter(r => (u.customClaims || {})[r] === true);
      console.log('  ' + email.padEnd(32) + 'EXISTS   uid=' + u.uid.slice(0, 14) + '…  claims=' + (held.join('+') || '(none)'));
    } catch (e) {
      console.log('  ' + email.padEnd(32) + 'ABSENT   (' + (e.code || e.message) + ')');
    }
  }
  console.log('\n  Google Workspace mailbox state cannot be read from here — it needs');
  console.log('  Workspace Admin SDK access, which this credential does not carry.');

  /* ══ E — AUTH METHODS ══════════════════════════════════════════════════ */
  console.log('\n\nE. SIGN-IN METHODS — passwordless migration baseline');
  console.log('='.repeat(80));
  const byProvider = {};
  let passwordOnly = 0, noProvider = 0, multi = 0;
  const passwordOnlyAdmins = [];
  for (const u of all) {
    const ids = (u.providerData || []).map(p => p.providerId);
    const key = ids.length ? ids.slice().sort().join('+') : '(none)';
    byProvider[key] = (byProvider[key] || 0) + 1;
    if (!ids.length) noProvider++;
    if (ids.length > 1) multi++;
    if (ids.length === 1 && ids[0] === 'password') {
      passwordOnly++;
      if (highestRole(u.customClaims || {})) passwordOnlyAdmins.push(u.email || u.uid);
    }
  }
  console.log('  Accounts by provider set:');
  Object.entries(byProvider).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('    ' + String(k).padEnd(34) + v));
  console.log('');
  console.log('  Total accounts                     : ' + all.length);
  console.log('  PASSWORD-ONLY (must migrate first) : ' + passwordOnly);
  console.log('  More than one method (safe)        : ' + multi);
  console.log('  No provider at all (phone/custom)  : ' + noProvider);
  if (passwordOnlyAdmins.length) {
    console.log('\n  Password-only accounts that hold a privileged claim:');
    passwordOnlyAdmins.forEach(e => console.log('    ' + e));
    console.log('    These lock out an ADMIN if password sign-in is disabled first.');
  }
  console.log('\n  Disabling password sign-in before these ' + passwordOnly + ' accounts hold a second');
  console.log('  working method would lock every one of them out. Migrate first, verify, then disable.');

  /* ══ F — TOKEN REVOCATION IMPACT ═══════════════════════════════════════ */
  console.log('\n\nF. TOKEN REVOCATION IMPACT — who gets signed out');
  console.log('='.repeat(80));
  const now = Date.now();
  let recent = 0;
  console.log('  Privileged accounts and their session state:\n');
  for (const u of privileged) {
    const last = u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime) : null;
    const days = last ? Math.floor((now - last.getTime()) / 86400000) : null;
    if (days !== null && days <= 7) recent++;
    const validAfter = u.tokensValidAfterTime ? new Date(u.tokensValidAfterTime) : null;
    const staleToken = last && validAfter && last >= validAfter;
    console.log('    ' + (u.email || u.uid).padEnd(32)
      + (last ? ('last sign-in ' + days + 'd ago').padEnd(24) : 'NEVER SIGNED IN'.padEnd(24))
      + (staleToken ? 'token may carry stale claims' : 'token reissued since last revoke'));
  }
  console.log('\n  Privileged accounts total            : ' + privileged.length);
  console.log('  Active within 7 days (would notice)  : ' + recent);
  console.log('  Non-privileged accounts affected     : 0  (revocation would be per-uid, admins only)');
  console.log('\n  A revoke signs that user out on EVERY device. For ' + privileged.length + ' accounts of which');
  console.log('  ' + recent + ' are currently active, the blast radius is small and bounded — but it is');
  console.log('  still a forced sign-out and needs to be scheduled, not surprised on someone.');

  console.log('\n' + '='.repeat(80));
  console.log(APPLY ? 'APPLIED: registry backfill only. No claim, token or account was changed.'
                    : 'DRY RUN: nothing was written.');
  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
