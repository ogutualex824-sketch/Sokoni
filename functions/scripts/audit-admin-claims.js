'use strict';
/**
 * Admin authorization audit — what is ACTUALLY stored, across every source.
 *
 *   node functions/scripts/audit-admin-claims.js [--email a@b.com ...]
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * "Admin claims are inconsistent" is not one question, it is four, and they are
 * routinely conflated:
 *
 *   1. What custom claims does Firebase Auth hold for this UID?
 *   2. What claims does the ID TOKEN on the device carry? (Not the same thing —
 *      a token minted before a claim change keeps the old claims until it is
 *      reissued, up to an hour, or forever if the user never returns.)
 *   3. What does Firestore say — users/{uid}.roles, platformEmployees, workspace
 *      membership?
 *   4. What does the admin UI gate on?
 *
 * A mismatch between 1 and 2 is normal and self-healing. A mismatch between 1
 * and 3 is drift, and drift is what makes access unpredictable. This prints all
 * of them side by side so the answer is read, not inferred.
 *
 * Read-only. Grants nothing, revokes nothing, writes nothing.
 */

const admin = require('firebase-admin');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });
const auth = admin.auth();
const db   = admin.firestore();

const DEFAULT_ACCOUNTS = [
  'superadmin@mysokoni.co.ke',
  'ceo@mysokoni.co.ke',
  'ochisaac@gmail.com',
  'alexochieng3030@gmail.com',
  'ogutualex824@gmail.com',
];

function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const ADMIN_CLAIMS = ['admin', 'superAdmin', 'moderator', 'support', 'finance'];

async function firestoreRoles(uid, email) {
  const out = {};
  try {
    const u = await db.collection('users').doc(uid).get();
    if (u.exists) {
      const d = u.data();
      out.users = {
        roles: d.roles || null,
        role: d.role || null,
        isAdmin: d.isAdmin === undefined ? null : d.isAdmin,
      };
    } else out.users = '(no users doc)';
  } catch (e) { out.users = 'ERR ' + e.message; }

  for (const [label, coll, field] of [
    ['platformEmployees', 'platformEmployees', 'email'],
    ['adminUsers',        'adminUsers',        'email'],
    ['invitations',       'invitations',       'email'],
  ]) {
    try {
      const s = await db.collection(coll).where(field, '==', email).get();
      out[label] = s.empty ? '(none)' : s.docs.map(d => {
        const x = d.data();
        return { id: d.id.slice(0, 16), role: x.role || x.platformRole || null, status: x.status || null };
      });
    } catch (e) { out[label] = 'ERR ' + (e.code || e.message); }
  }
  return out;
}

(async () => {
  const emails = argAll('email').length ? argAll('email') : DEFAULT_ACCOUNTS;
  console.log('\nADMIN AUTHORIZATION AUDIT — project ' + PROJECT);
  console.log('='.repeat(78));

  const summary = [];

  for (const email of emails) {
    console.log('\n' + email);
    console.log('-'.repeat(email.length));

    let user = null;
    try { user = await auth.getUserByEmail(email); }
    catch (e) {
      console.log('  Firebase Auth   : NO ACCOUNT (' + (e.code || e.message) + ')');
      summary.push({ email, uid: '-', claims: '-', adminUI: 'NO ACCOUNT' });
      continue;
    }

    const claims = user.customClaims || {};
    const held = ADMIN_CLAIMS.filter(c => claims[c] === true);

    console.log('  UID             : ' + user.uid);
    console.log('  Providers       : ' + (user.providerData || []).map(p => p.providerId).join(', ') || '(none)');
    console.log('  Created         : ' + user.metadata.creationTime);
    console.log('  Last sign-in    : ' + (user.metadata.lastSignInTime || 'NEVER'));
    console.log('  Raw customClaims: ' + JSON.stringify(claims));
    console.log('  Admin claims    : ' + (held.length ? held.join(', ') : '(none)'));

    /* validAfterTime is the only server-side lever on token freshness: any token
       minted before it is rejected, which is what revokeRefreshTokens sets. If a
       claim changed after the last sign-in and tokens were NOT revoked, the
       device is still carrying the old claims. */
    const validAfter = user.tokensValidAfterTime ? new Date(user.tokensValidAfterTime) : null;
    const lastSignIn = user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime) : null;
    console.log('  tokensValidAfter: ' + (user.tokensValidAfterTime || '(never revoked)'));
    if (lastSignIn && validAfter && lastSignIn < validAfter) {
      console.log('  TOKEN STATE     : device token INVALIDATED — next getIdToken() reissues with current claims');
    } else if (held.length && lastSignIn && validAfter && lastSignIn >= validAfter) {
      console.log('  TOKEN STATE     : device token predates no revocation — carries whatever claims it was minted with');
    }

    const fs = await firestoreRoles(user.uid, email);
    console.log('  Firestore       : ' + JSON.stringify(fs, null, 2).split('\n').join('\n                    '));

    /* What admin.html actually gates on — token.claims.admin || token.claims.superAdmin. */
    const uiAccess = (claims.admin === true || claims.superAdmin === true);
    console.log('  admin.html gate : ' + (uiAccess ? 'ALLOWED' : 'DENIED') + '  (claims.admin || claims.superAdmin)');

    /* Drift, carefully defined. users/{uid}.roles is the MARKETPLACE axis
       (buyer/seller/provider/driver) and an administrator is normally a buyer
       too — reporting that as drift produces a false alarm on every account.
       Only sources that claim to describe ADMIN authority count here:
         users.role   (string)  — a second, legacy role field
         users.isAdmin(bool)
         platformEmployees      — the platform staff registry
       Custom claims remain authoritative either way: firestore.rules isAdmin()
       and admin.html both read the token, nothing else. */
    const fsSaysAdmin =
      (fs.users && ['admin', 'superAdmin', 'superadmin'].includes(fs.users.role)) ||
      (fs.users && fs.users.isAdmin === true) ||
      (Array.isArray(fs.platformEmployees) && fs.platformEmployees.length > 0);
    if (fsSaysAdmin !== uiAccess) {
      console.log('  ** DRIFT **     : Firestore says ' + (fsSaysAdmin ? 'admin' : 'not admin')
        + ' but custom claims say ' + (uiAccess ? 'admin' : 'not admin'));
      console.log('                    Custom claims are AUTHORITATIVE (firestore.rules and admin.html both read them).');
    }

    summary.push({
      email,
      uid: user.uid.slice(0, 12) + '…',
      claims: held.join('+') || '(none)',
      lastSignIn: user.metadata.lastSignInTime ? 'yes' : 'NEVER',
      adminUI: uiAccess ? 'ALLOWED' : 'DENIED',
      drift: fsSaysAdmin !== uiAccess ? 'YES' : '-',
    });
  }

  console.log('\n\nSUMMARY');
  console.log('='.repeat(78));
  console.log(['email'.padEnd(30), 'uid'.padEnd(14), 'claims'.padEnd(18), 'signedIn'.padEnd(9), 'adminUI'.padEnd(9), 'drift'].join(''));
  summary.forEach(r => console.log([
    r.email.padEnd(30), String(r.uid).padEnd(14), String(r.claims).padEnd(18),
    String(r.lastSignIn || '-').padEnd(9), String(r.adminUI).padEnd(9), String(r.drift || '-'),
  ].join('')));
  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
