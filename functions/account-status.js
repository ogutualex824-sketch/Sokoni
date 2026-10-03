'use strict';

/**
 * Account Status — server-enforced deactivation / reactivation.
 *
 * Deactivation is a REVERSIBLE, server-authoritative account freeze (distinct from
 * deleteMyAccount, which disables Auth and queues a purge). The authority lives in
 * two places the client cannot forge:
 *   1. A custom claim `deactivated: true` on the Firebase Auth token — checked by
 *      Firestore rules (isActive()) to block authenticated writes.
 *   2. `users/{uid}.deactivated` + hidden merchant surfaces (providers/{uid} status,
 *      shops/{uid} visibility) so the account disappears from discovery/search.
 *
 * Auth is deliberately NOT disabled, so the user can sign back in to REACTIVATE
 * (explicit action only — never automatic). Refresh tokens are revoked on
 * deactivation so the new claim is picked up on the forced re-auth and any other
 * device sessions end immediately.
 *
 * Exposed onCall functions (re-exported by name in functions/index.js):
 *   • accountDeactivate  { confirm: true }        → freezes the caller's account
 *   • accountReactivate  {}                        → restores the caller's account
 *   • adminSetAccountActive { uid, active }        → admin override
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const db     = admin.firestore();
const REGION = 'us-central1';

/* ── Claim helpers — setCustomUserClaims REPLACES all claims, so always merge ── */
async function _setDeactivatedClaim(uid, on) {
  const user   = await admin.auth().getUser(uid);
  const claims = Object.assign({}, user.customClaims || {});
  if (on) claims.deactivated = true;
  else    delete claims.deactivated;
  await admin.auth().setCustomUserClaims(uid, claims);
}

/* ── Merchant surface hide / restore (bounded: two uid-keyed docs) ───────────────
   P0 2026-10-03 (5b + e3). The LIVE version stashed `cur.status || 'active'` only when no stash existed and restored
   `preDeactivationStatus ?? 'active'` — and preDeactivationStatus was client-writable on providers — so a self-created
   providers doc + deactivate + reactivate SELF-ACTIVATED an unapproved provider (bookable, chargeable). Now:
     • the stash is taken from the CURRENT server status every time the surface is hidden (a pre-written stash is
       ignored); a missing status stashes 'pending';
     • restore only happens while the record is 'deactivated', returns exactly the server-taken stash, and never invents
       'active' (unknown → 'pending');
     • shops: the stash is the CURRENT visibility; unknown restores HIDDEN (a moderation-hidden shop stays hidden). */
async function _hideMerchantSurfaces(uid) {
  const now = admin.firestore.FieldValue.serverTimestamp();

  const provRef  = db.collection('providers').doc(uid);
  const provSnap = await provRef.get();
  if (provSnap.exists) {
    const cur = provSnap.data() || {};
    if (cur.status !== 'deactivated') {
      const st = typeof cur.status === 'string' && cur.status.trim() ? cur.status : 'pending';
      await provRef.set({ status: 'deactivated', deactivated: true, updatedAt: now, preDeactivationStatus: st }, { merge: true });
    }
  }

  const shopRef  = db.collection('shops').doc(uid);
  const shopSnap = await shopRef.get();
  if (shopSnap.exists) {
    const cur = shopSnap.data() || {};
    if (cur.deactivated !== true) {
      await shopRef.set({ isVisible: false, deactivated: true, updatedAt: now, preDeactivationVisible: cur.isVisible !== false }, { merge: true });
    }
  }
}

async function _restoreMerchantSurfaces(uid) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const del = admin.firestore.FieldValue.delete();

  const provRef  = db.collection('providers').doc(uid);
  const provSnap = await provRef.get();
  if (provSnap.exists) {
    const cur = provSnap.data() || {};
    if (cur.status === 'deactivated') {
      const st = typeof cur.preDeactivationStatus === 'string' && cur.preDeactivationStatus.trim() && cur.preDeactivationStatus !== 'deactivated' ? cur.preDeactivationStatus : 'pending';
      await provRef.set({ status: st, deactivated: false, updatedAt: now, preDeactivationStatus: del }, { merge: true });
    }
  }

  const shopRef  = db.collection('shops').doc(uid);
  const shopSnap = await shopRef.get();
  if (shopSnap.exists) {
    const cur = shopSnap.data() || {};
    if (cur.deactivated === true) {
      await shopRef.set({ isVisible: cur.preDeactivationVisible === true, deactivated: false, updatedAt: now, preDeactivationVisible: del }, { merge: true });
    }
  }
}

/* WHO froze the account — server-only accountFreezes/{uid} (no client rule = default deny). users/{uid} is owner-
   writable, so it cannot carry this. An ADMIN freeze can only be lifted by adminSetAccountActive (e3, 2026-10-03). */
async function _freezeOf(uid) {
  const s = await db.collection('accountFreezes').doc(String(uid)).get();
  return s.exists ? (s.data() || {}) : null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   accountDeactivate — freeze the caller's own account.
───────────────────────────────────────────────────────────────────────────── */
exports.accountDeactivate = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to deactivate your account.');
  if (request.data && request.data.confirm !== true) {
    throw new HttpsError('invalid-argument', 'confirm must be true.');
  }
  const reason = request.data && request.data.reason ? String(request.data.reason).slice(0, 200) : null;

  /* Never let a deletion-in-progress account be "deactivated" back into a usable state. */
  const uSnap = await db.collection('users').doc(uid).get();
  if (uSnap.exists && uSnap.data().accountStatus === 'deleted') {
    throw new HttpsError('failed-precondition', 'This account is being deleted and cannot be deactivated.');
  }

  const freeze0 = await _freezeOf(uid);
  if (freeze0 && freeze0.active === true && freeze0.by === 'admin') {
    throw new HttpsError('failed-precondition', 'This account is frozen by SOKONI. Contact support.', { reason: 'ADMIN_FROZEN' });
  }
  await _setDeactivatedClaim(uid, true);
  await db.collection('accountFreezes').doc(uid).set({ active: true, by: 'self', at: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection('users').doc(uid).set({
    deactivated:   true,
    accountStatus: 'deactivated',
    deactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    deactivationReason: reason,
  }, { merge: true });

  await _hideMerchantSurfaces(uid);

  /* Force re-auth so the new claim takes effect and other sessions end. */
  try { await admin.auth().revokeRefreshTokens(uid); } catch (_) {}

  console.info('[accountDeactivate] uid:', uid.slice(0, 8) + '…');
  return { success: true, deactivated: true };
});

/* ─────────────────────────────────────────────────────────────────────────────
   accountReactivate — explicit restore of the caller's own account.
───────────────────────────────────────────────────────────────────────────── */
exports.accountReactivate = onCall({ region: REGION }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to reactivate your account.');

  const uSnap = await db.collection('users').doc(uid).get();
  if (uSnap.exists && uSnap.data().accountStatus === 'deleted') {
    throw new HttpsError('failed-precondition', 'This account is being deleted and cannot be reactivated.');
  }
  /* P0 2026-10-03: only the account holder's OWN deactivation is self-reversible. An admin freeze (or a ban /
     suspension) is lifted only by an administrator — the live version let a frozen account unfreeze itself. */
  const freeze = await _freezeOf(uid);
  const u0 = uSnap.exists ? (uSnap.data() || {}) : {};
  if (u0.banned === true || u0.suspended === true || ['banned', 'suspended'].includes(String(u0.accountStatus || ''))) {
    throw new HttpsError('permission-denied', 'This account is suspended. Contact support.', { reason: 'ACCOUNT_SUSPENDED' });
  }
  if (!freeze || freeze.active !== true || freeze.by !== 'self') {
    /* Owner 2026-10-03: legacy deactivations (no freeze record) and admin freezes are restored by support via
       adminSetAccountActive(true). Point the user to the IN-APP support ticket — never WhatsApp. */
    throw new HttpsError('failed-precondition', 'This account can only be reactivated by SOKONI Support. Open Support in the app (/support) and choose Submit Ticket.', { reason: freeze && freeze.by === 'admin' ? 'ADMIN_FROZEN' : 'NOT_SELF_DEACTIVATED', supportUrl: '/support' });
  }
  await _setDeactivatedClaim(uid, false);
  await db.collection('accountFreezes').doc(uid).set({ active: false, by: 'self', liftedAt: admin.firestore.FieldValue.serverTimestamp() });

  await db.collection('users').doc(uid).set({
    deactivated:   false,
    accountStatus: 'active',
    reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    deactivationReason: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  await _restoreMerchantSurfaces(uid);

  console.info('[accountReactivate] uid:', uid.slice(0, 8) + '…');
  /* Client must call getIdToken(true) after this so rules see the cleared claim. */
  return { success: true, deactivated: false };
});

/* ─────────────────────────────────────────────────────────────────────────────
   adminSetAccountActive — admin override to freeze/restore any account.
───────────────────────────────────────────────────────────────────────────── */
exports.adminSetAccountActive = onCall({ region: REGION }, async (request) => {
  const caller = request.auth && request.auth.token;
  if (!caller || !(caller.admin === true || caller.superAdmin === true)) {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
  const targetUid = request.data && request.data.uid ? String(request.data.uid) : '';
  const active    = request.data && request.data.active === true;
  if (!targetUid) throw new HttpsError('invalid-argument', 'uid is required.');

  await _setDeactivatedClaim(targetUid, !active);
  await db.collection('accountFreezes').doc(targetUid).set({ active: !active, by: 'admin', adminUid: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection('users').doc(targetUid).set({
    deactivated:   !active,
    accountStatus: active ? 'active' : 'deactivated',
    [active ? 'reactivatedAt' : 'deactivatedAt']: admin.firestore.FieldValue.serverTimestamp(),
    lastAdminActionBy: request.auth.uid,
  }, { merge: true });

  if (active) await _restoreMerchantSurfaces(targetUid);
  else        await _hideMerchantSurfaces(targetUid);

  if (!active) { try { await admin.auth().revokeRefreshTokens(targetUid); } catch (_) {} }

  console.info('[adminSetAccountActive]', targetUid.slice(0, 8) + '…', 'active=', active);
  return { success: true, uid: targetUid, active };
});
