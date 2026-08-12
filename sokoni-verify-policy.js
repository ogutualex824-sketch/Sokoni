/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Verification enforcement policy   (Auth Slice 6A)
   ------------------------------------------------------------------------------
   WHO is asked to verify. Not WHAT counts as a verification — that stays entirely in
   authDispatch and the Admin SDK, and this file cannot influence it.

   That separation is the whole design. Grandfathering is an ACCESS POLICY layered on top
   of an unchanged verification model:

     needsVerification(user)   is this account's address unproven?      (Slice 3, unchanged)
     enforcementApplies(user)  do we ask THIS account to prove it?      (here)
     gated = both

   WHY NOT JUST MARK THE 66 ACCOUNTS VERIFIED
   ------------------------------------------
   The Admin SDK would let us set emailVerified = true on every existing account and the
   lockout would vanish. It would also make the Auth record assert something nobody
   checked. emailVerified would stop meaning "this person proved they own this address"
   and start meaning "this account is old", and every future decision that reads the flag —
   ours or Firebase's — would inherit that lie. Nothing here writes to any user record.

   THE MEASUREMENT THAT PRODUCED THIS POLICY
   -----------------------------------------
   87 accounts; 74 password; 4 verified; 66 would be gated (89.2%). Not an old-account
   problem — July 40/57, August 23/26. Deploying the gate unchanged would have locked out
   nearly nine in ten password users, so existing accounts are grandfathered and only
   accounts created from the enforcement launch onward are asked.

   DEFAULT: ENFORCEMENT OFF
   ------------------------
   CUTOFF_ISO ships as the sentinel, which disables enforcement for everyone — including
   accounts created after it. So the gate and screen can be deployed and observed while
   they are provably a no-op, and turning enforcement on is a one-line change with a
   one-line revert. The dangerous step and the deployment step are deliberately separated.

   BOUNDARY, DEFINED
   -----------------
     created  <  cutoff   grandfathered    enforcement does NOT apply
     created ===  cutoff   enforced         the cutoff is the instant enforcement BEGINS,
                                            so an account created at exactly that instant
                                            was created under the new policy. Half-open
                                            [cutoff, ∞). Stated because "on the boundary"
                                            is where an off-by-one silently locks somebody
                                            out or silently lets somebody through.
     created  >  cutoff   enforced

   Comparison is on epoch milliseconds, never on strings — Firebase reports creationTime as
   an RFC-1123 UTC string ("Tue, 12 Aug 2026 10:00:00 GMT"), not ISO-8601, and string
   ordering of those two formats is meaningless.

   UNKNOWN CREATION TIME RELAXES, IT DOES NOT LOCK OUT
   ---------------------------------------------------
   A missing or unparseable creationTime yields NOT ENFORCED. This is the opposite of the
   gate's own failure direction — Slice 3 fails closed when it cannot refresh emailVerified
   — and the asymmetry is deliberate:

     failing closed on VERIFICATION   worst case: someone types a code they already have
     failing closed on POLICY         worst case: an account nobody can date is locked out
                                      of a platform it has always been able to use

   The production measurement found exactly one account with no provider record. This slice
   exists to prevent lockouts, so the unknown case relaxes, and says so out loud.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Enforcement is OFF while this equals SENTINEL_ISO. Turning it on means replacing it
     with the actual launch instant, in its own commit, reviewed on its own. */
  var SENTINEL_ISO = '2099-01-01T00:00:00.000Z';

  var API = {
    SENTINEL_ISO: SENTINEL_ISO,

    /* ── THE CUTOFF ──────────────────────────────────────────────────────────
       Read at call time, not captured, so the suites can exercise real boundary dates
       without a test-only mutator in shipped code. A page script could overwrite it, and
       that is the same exposure the gate already documents: this is an ACCESS gate, not
       data protection. Firestore rules, App Check and the server-side checks in
       authDispatch are unaffected by anything written here, and 6B will hold the server's
       own copy which no client can reach. */
    CUTOFF_ISO: '2026-08-12T18:30:00.000Z',
  };

  API.isEnforcementEnabled = function () {
    return API.CUTOFF_ISO !== SENTINEL_ISO;
  };

  /* Firebase gives an RFC-1123 UTC string; ISO-8601 also parses. Anything else is
     "unknown", which relaxes. */
  API.parseCreated = function (value) {
    if (value == null || value === '') return null;
    var t = (value instanceof Date) ? value.getTime() : Date.parse(String(value));
    return (typeof t === 'number' && isFinite(t)) ? t : null;
  };

  /* The verdict. `opts.cutoff` lets a caller — the suites, and later the server —
     evaluate an explicit cutoff without mutating the shipped one. */
  API.enforcementApplies = function (user, opts) {
    var cutoffIso = (opts && opts.cutoff) || API.CUTOFF_ISO;

    /* Off means off, for everyone, at every date. Without this an account created after
       01-01-2099 would be enforced by a value whose whole purpose is to enforce nothing. */
    if (cutoffIso === SENTINEL_ISO) return false;

    var cutoff = API.parseCreated(cutoffIso);
    if (cutoff === null) return false;          /* an unreadable cutoff enforces nothing */

    var created = API.parseCreated(
      user && user.metadata && (user.metadata.creationTime || user.metadata.createdAt));
    if (created === null) return false;         /* undateable account is grandfathered */

    return created >= cutoff;                   /* half-open [cutoff, ∞) */
  };

  /* A one-line description of the live policy, for logs and for the measurement tool —
     so "which policy produced this number" is never a guess. */
  API.describe = function () {
    return API.isEnforcementEnabled()
      ? 'enforcement ON from ' + API.CUTOFF_ISO + ' (accounts created before it are grandfathered)'
      : 'enforcement OFF (sentinel ' + SENTINEL_ISO + ') — no account is asked to verify';
  };

  global.SokoniVerifyPolicy = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
