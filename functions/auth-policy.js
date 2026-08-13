/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Verification enforcement policy, SERVER SIDE   (Auth Slice 6B)
   ------------------------------------------------------------------------------
   The same question the client's sokoni-verify-policy.js answers — "is THIS account
   subject to email-verification enforcement?" — answered where no client can reach.

   WHY THIS FILE EXISTS AT ALL, RATHER THAN A require() OF THE CLIENT ONE
   ----------------------------------------------------------------------
   `firebase deploy --only functions` uploads the functions/ directory and nothing else. A
   require('../sokoni-verify-policy.js') resolves perfectly on a developer's machine and
   then throws MODULE_NOT_FOUND in production, which is the worst possible place to learn
   about it. So the semantics are implemented twice, deliberately, and the duplication is
   held together by a contract rather than by hope:

     scripts/auth-policy-vectors.json   dated inputs → expected verdicts
     scripts/test-auth-policy-server.js  replays them here AND in both client runtimes,
                                         then sweeps thousands of generated timestamps
                                         around each cutoff comparing the two
                                         implementations pairwise

   A byte-identical constant would only prove the two sides agree about a STRING. The
   contract proves they agree about DATES — including at the boundary, which is the one
   place a disagreement locks somebody out.

   WHAT THIS FILE MAY NOT DO
   -------------------------
   It decides who is ASKED. It has no opinion about who IS verified, cannot write to a user
   record, and is not consulted by issue() or verify(). A grandfathered account may still
   request and complete verification voluntarily — that is what makes a future
   re-verification campaign possible without a new endpoint.

   SEMANTICS — identical to the client, and asserted to be
   ------------------------------------------------------
     created  <  cutoff    grandfathered
     created === cutoff    ENFORCED   half-open [cutoff, ∞); the cutoff is the instant
                                      enforcement begins, so an account created at exactly
                                      that instant was created under the new policy
     created  >  cutoff    enforced
     unknown/unparseable   GRANDFATHERED — relaxes, never locks out
     cutoff === sentinel   nobody is enforced, at any date

   Comparison is on epoch milliseconds. UserRecord.metadata.creationTime is an RFC-1123 UTC
   string, not ISO-8601; string ordering across the two formats is meaningless.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Enforcement is OFF while CUTOFF_ISO equals this. Turning it on means replacing the
   cutoff on BOTH sides in one commit — the suite fails loudly if only one moves. */
const SENTINEL_ISO = '2099-01-01T00:00:00.000Z';

const policy = {
  SENTINEL_ISO,
  CUTOFF_ISO: '2026-08-20T12:00:00.000Z',
};

policy.isEnforcementEnabled = function () {
  return policy.CUTOFF_ISO !== SENTINEL_ISO;
};

policy.parseCreated = function (value) {
  if (value == null || value === '') return null;
  const t = (value instanceof Date) ? value.getTime() : Date.parse(String(value));
  return (typeof t === 'number' && isFinite(t)) ? t : null;
};

/* `user` is shaped like a Firebase user record — client User or Admin UserRecord, both of
   which expose metadata.creationTime. */
policy.enforcementApplies = function (user, opts) {
  const cutoffIso = (opts && opts.cutoff) || policy.CUTOFF_ISO;

  /* Off means off, for everyone, at every date. */
  if (cutoffIso === SENTINEL_ISO) return false;

  const cutoff = policy.parseCreated(cutoffIso);
  if (cutoff === null) return false;             /* an unreadable cutoff enforces nothing */

  const created = policy.parseCreated(
    user && user.metadata && (user.metadata.creationTime || user.metadata.createdAt));
  if (created === null) return false;            /* undateable account is grandfathered */

  return created >= cutoff;                      /* half-open [cutoff, ∞) */
};

policy.describe = function () {
  return policy.isEnforcementEnabled()
    ? 'enforcement ON from ' + policy.CUTOFF_ISO + ' (accounts created before it are grandfathered)'
    : 'enforcement OFF (sentinel ' + SENTINEL_ISO + ') — no account is asked to verify';
};

module.exports = policy;
