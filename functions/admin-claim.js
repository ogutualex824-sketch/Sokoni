/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — canonical admin claim check

   THE DEFECT THIS EXISTS TO FIX
   Twelve modules guarded themselves on `token.isAdmin` / `token.isSuperAdmin`.
   Nothing in this codebase has ever set a claim by either of those names — the
   only admin claims written are `admin` (functions/index.js:153, :188, :4080)
   and role-keyed entries. Every one of those guards therefore evaluated false
   for EVERY caller, including real platform administrators.

   The failure mode is the quiet kind: the functions did not error at deploy, did
   not warn, and returned a correct-looking `permission-denied` to a legitimate
   admin. It reads exactly like "you are not authorised" rather than "this check
   can never pass".

   WHY A SHARED HELPER RATHER THAN 26 EDITS
   The guards are written six different ways — `!t.isAdmin && !t.isSuperAdmin`,
   `!(token?.isAdmin || token?.isSuperAdmin)`, `req.auth.token?.isAdmin === true`
   — so a regex sweep across authorisation code would be the wrong tool, and a
   mistake in one negation grants access rather than denying it. One function,
   one behaviour, one place to audit.

   THIS DOES NOT WIDEN ACCESS. The legacy spellings are still honoured, so any
   deployment that somehow does set them keeps working. What changes is that the
   canonical `admin` / `superAdmin` claims — the ones firestore.rules:9-12 and
   every other guard already trust — are now accepted here too.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

/** Normalise any of the shapes callers pass: a request, a request.auth, or a token. */
function _token(x) {
  if (!x) return null;
  if (x.auth && x.auth.token) return x.auth.token;   /* onCall request */
  if (x.token) return x.token;                       /* request.auth     */
  return x;                                          /* already a token  */
}

/** True for a platform administrator. superAdmin implies admin. */
function isAdmin(x) {
  const t = _token(x);
  if (!t) return false;
  return t.admin === true || t.superAdmin === true ||
         /* legacy spellings — never written by this codebase, kept so a
            deployment that sets them externally is not suddenly locked out */
         t.isAdmin === true || t.isSuperAdmin === true ||
         t.role === 'admin' || t.role === 'superAdmin';
}

/** True only for a super administrator. Deliberately does NOT accept `admin`. */
function isSuperAdmin(x) {
  const t = _token(x);
  if (!t) return false;
  return t.superAdmin === true || t.isSuperAdmin === true || t.role === 'superAdmin';
}

/** Support/finance desks, used by ade.js and disputes.js. */
function isSupport(x) {
  const t = _token(x);
  if (!t) return false;
  return isAdmin(t) || t.support === true || t.isSupport === true || t.role === 'support';
}

function isFinance(x) {
  const t = _token(x);
  if (!t) return false;
  return isAdmin(t) || t.finance === true || t.isFinance === true || t.role === 'finance';
}

module.exports = { isAdmin, isSuperAdmin, isSupport, isFinance };
