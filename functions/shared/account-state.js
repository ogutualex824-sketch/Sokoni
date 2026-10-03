'use strict';
/**
 * ACCOUNT STATE GUARD — the server half of "a suspended account cannot keep acting on an already-issued credential"
 * (owner 2026-10-04). Auth disable stops new sign-in and session revocation stops token refresh, but an ID token issued
 * before the suspension stays cryptographically valid for ≤1 h. Firestore rules deny that token's sensitive WRITES
 * (f3's accountNotSuspended predicate); sensitive CALLABLES re-check the canonical account record here.
 *
 *   await assertAccountActive(db, uid)   → throws { code: 'permission-denied' } when users/{uid} is suspended
 *
 * Reads the ONE canonical record (users/{uid}: status 'suspended' / 'banned' or suspended:true — the state
 * shared/account-suspension.js writes). An unreadable record FAILS CLOSED for these sensitive operations.
 */
class AccountStateError extends Error { constructor (code, message) { super(message); this.code = code; } }

async function assertAccountActive(db, uid) {
  if (!uid) throw new AccountStateError('unauthenticated', 'Sign in required.');
  let d;
  try { const s = await db.collection('users').doc(String(uid)).get(); d = s.exists ? (s.data() || {}) : {}; }
  catch (_) { throw new AccountStateError('unavailable', 'Your account status could not be verified. Try again shortly.'); }
  if (d.suspended === true || d.status === 'suspended' || d.status === 'banned') {
    throw new AccountStateError('permission-denied', 'This account is suspended.');
  }
  return true;
}

module.exports = { assertAccountActive, AccountStateError };
