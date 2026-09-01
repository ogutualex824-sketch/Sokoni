/* ══════════════════════════════════════════════════════════════════════════════
   SELLER CERTIFICATION — one rule for what "certified" means.
   ══════════════════════════════════════════════════════════════════════════════
   THE RECORD, at sellerCertifications/{sellerUid}:

     status         'certified' | 'pending' | 'suspended' | 'revoked'
     level          e.g. 'standard' | 'premium'          (free-form, displayed as-is)
     scope          ['business_identity', 'ownership', 'compliance', …]
     issuedAt       when the attestation was made
     expiresAt      when it must be reviewed again (may be absent = no expiry)
     authority      who attested — the platform body, shown to the shopper
     verificationId the reference a dispute can quote
     reviewedBy     the admin uid, for provenance

   WHO MAY WRITE IT: only a caller whose ID TOKEN carries admin/superAdmin, which is
   set server-side and signed. `allow write: if isAdmin()` in firestore.rules. A shop
   cannot write this document at all — which is the entire point. A badge the badged
   party can mint is not an attestation.

   WHAT IT IS NOT:
     · NOT shops/{uid}.verified — business verification is a different claim with
       different evidence. Kept in a separate document so neither can imply the other.
     · NOT derivable from ratings, reviews, availability, response rate or completion
       rate. Those are performance signals. A shop with five stars and no attestation
       is UNCERTIFIED, and must display as such.

   EXPIRY IS ENFORCED HERE, not left to whoever renders the badge. A certification
   that has lapsed is not "certified with an old date" — it is not certified. The one
   function every surface calls returns the decision AND the reason, so no caller has
   to reimplement the rule and get it subtly wrong.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniCertificationModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUS = { CERTIFIED: 'certified', PENDING: 'pending',
                 SUSPENDED: 'suspended', REVOKED: 'revoked' };

  /* Firestore Timestamp | Date | number | ISO string -> ms, or null. */
  function ms (v) {
    if (v === null || v === undefined) return null;
    try {
      if (typeof v === 'number') return v;
      if (typeof v.toMillis === 'function') return v.toMillis();
      if (typeof v.seconds === 'number') return v.seconds * 1000;
      if (v instanceof Date) return v.getTime();
      var t = Date.parse(String(v));
      return isFinite(t) ? t : null;
    } catch (_) { return null; }
  }

  /* THE ONE DECISION. Returns { valid, status, reason } — never a bare boolean, so a
     caller can say WHY rather than showing an unexplained absence. */
  function evaluate (rec, nowMs) {
    var now = nowMs || Date.now();
    if (!rec || typeof rec !== 'object') {
      return { valid: false, status: null, reason: 'none',
               label: 'Not certified' };
    }
    var status = String(rec.status || '').toLowerCase();

    if (status === STATUS.REVOKED) {
      return { valid: false, status: status, reason: 'revoked', label: 'Certification revoked' };
    }
    if (status === STATUS.SUSPENDED) {
      return { valid: false, status: status, reason: 'suspended', label: 'Certification suspended' };
    }
    if (status === STATUS.PENDING) {
      return { valid: false, status: status, reason: 'pending', label: 'Certification in review' };
    }
    if (status !== STATUS.CERTIFIED) {
      /* An unknown status is NOT certified. Treating an unrecognised value as valid
         is how a typo becomes a badge. */
      return { valid: false, status: status || null, reason: 'unknown_status',
               label: 'Not certified' };
    }

    var exp = ms(rec.expiresAt);
    if (exp !== null && exp <= now) {
      return { valid: false, status: status, reason: 'expired', label: 'Certification expired',
               expiredAt: exp };
    }

    /* An attestation with no issuer and no reference is not evidence of anything. */
    if (!rec.authority || !rec.verificationId) {
      return { valid: false, status: status, reason: 'incomplete',
               label: 'Not certified' };
    }

    return {
      valid: true, status: status, reason: 'valid',
      label: 'Certified business',
      level: rec.level || null,
      authority: rec.authority,
      verificationId: rec.verificationId,
      issuedAt: ms(rec.issuedAt),
      expiresAt: exp,
      scope: Array.isArray(rec.scope) ? rec.scope.slice() : [],
    };
  }

  /* Days until review — for the merchant's own view, so a lapse is not a surprise.
     null when there is no expiry or no valid certification. */
  function daysUntilExpiry (rec, nowMs) {
    var e = evaluate(rec, nowMs);
    if (!e.valid || !e.expiresAt) return null;
    return Math.ceil((e.expiresAt - (nowMs || Date.now())) / 86400000);
  }

  /* What the merchant still has to do. Empty when nothing is outstanding. */
  function outstanding (rec, nowMs) {
    var e = evaluate(rec, nowMs);
    if (e.valid) {
      var d = daysUntilExpiry(rec, nowMs);
      return (d !== null && d <= 30)
        ? ['Certification is due for review in ' + d + ' day' + (d === 1 ? '' : 's') + '.']
        : [];
    }
    if (e.reason === 'none')          return ['No certification has been issued for this business yet.'];
    if (e.reason === 'pending')       return ['Your certification is with the review team.'];
    if (e.reason === 'expired')       return ['Your certification has expired and needs review.'];
    if (e.reason === 'suspended')     return ['Your certification is suspended. Contact support.'];
    if (e.reason === 'revoked')       return ['Your certification has been revoked. Contact support.'];
    if (e.reason === 'incomplete')    return ['The certification record is incomplete and is not being shown.'];
    return ['Certification status could not be read.'];
  }

  var SCOPE_LABEL = {
    business_identity: 'Business identity',
    ownership:         'Ownership verified',
    compliance:        'Regulatory compliance',
    tax:               'Tax registration',
    address:           'Registered address',
  };
  function scopeLabel (k) { return SCOPE_LABEL[k] || String(k || '').replace(/_/g, ' '); }

/* ══ ISSUANCE ═════════════════════════════════════════════════════════════════
     Building the document is separated from writing it, deliberately. The write
     needs an authenticated admin and a deployed rule; the DECISION about what a
     valid attestation looks like needs neither, so it lives here where it can be
     tested exhaustively without credentials and without relaxing anything.

     THE INVARIANTS THIS ENFORCES, each of which is a way a badge could otherwise
     be granted on evidence that does not exist:

       · `status` is never taken from input — buildIssue only ever emits
         'certified'. An unknown status must be impossible to write, not merely
         refused when read.
       · `reviewedBy` is never taken from input either. It is the verified admin
         uid the caller passes, so the record cannot name someone who did not
         make the decision.
       · `authority` and `verificationId` are REQUIRED and are never generated.
         A reference this code invented would look exactly like evidence and be
         none — the admin must quote the real review record.
       · `level` and `scope` come from closed sets. scopeLabel() falls back to the
         raw slug when it does not recognise a key, so a typo would otherwise be
         rendered to shoppers as though it were a real, granted scope.
       · an expiry, when given, must be in the FUTURE. Issuing something already
         expired writes a badge nobody will ever see and records a review that did
         not really happen.
       · omitting the review date is allowed but must be EXPLICIT (noExpiry), so
         "for ever" is always a decision and never a forgotten field.

     Nothing here writes. Callers get { ok, errors, payload } and do the write. */

  var LEVELS = ['standard', 'premium'];
  var ISSUE_KEYS = ['status', 'level', 'scope', 'issuedAt', 'expiresAt',
                    'authority', 'verificationId', 'reviewedBy', 'updatedAt'];

  function issuableScopes () { var o = []; for (var k in SCOPE_LABEL) o.push(k); return o.sort(); }

  /* Reference format, checked without a regex so this survives being edited by a
     script: letters, digits, dash, underscore, slash — the shapes a real case
     number takes. Nothing that could carry markup into the storefront. */
  function refOk (s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (t.length < 3 || t.length > 40) return false;
    var ok = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/';
    for (var i = 0; i < t.length; i++) if (ok.indexOf(t.charAt(i)) === -1) return false;
    return true;
  }

  function buildIssue (input, adminUid, nowMs) {
    var now = nowMs || Date.now();
    var i = input || {};
    var errs = [];

    if (!adminUid || typeof adminUid !== 'string') {
      errs.push('The signed-in admin could not be identified.');
    }
    var authority = String(i.authority == null ? '' : i.authority).trim();
    if (!authority) errs.push('An attesting authority is required.');
    else if (authority.length > 80) errs.push('The attesting authority is too long.');

    var ref = String(i.verificationId == null ? '' : i.verificationId).trim();
    if (!ref) errs.push('A verification reference is required.');
    else if (!refOk(ref)) errs.push('The verification reference must be 3–40 letters, digits, - _ or /.');

    var level = String(i.level == null ? '' : i.level).trim();
    if (LEVELS.indexOf(level) === -1) errs.push('Choose a certification level.');

    var known = issuableScopes();
    var scope = Array.isArray(i.scope) ? i.scope.slice() : [];
    if (!scope.length) errs.push('At least one scope must be attested.');
    for (var s = 0; s < scope.length; s++) {
      if (known.indexOf(scope[s]) === -1) {
        errs.push('Unknown scope: ' + String(scope[s]) + '.');
      }
    }

    var exp = null;
    if (i.noExpiry === true) {
      exp = null;
    } else if (i.expiresAt === undefined || i.expiresAt === null || i.expiresAt === '') {
      errs.push('Set a review date, or choose no review date explicitly.');
    } else {
      exp = ms(i.expiresAt);
      if (exp === null) errs.push('The review date could not be read.');
      else if (exp <= now) errs.push('The review date must be in the future.');
    }

    if (errs.length) return { ok: false, errors: errs, payload: null };

    return {
      ok: true, errors: [],
      payload: {
        status: STATUS.CERTIFIED,       /* never from input */
        level: level,
        scope: scope,
        authority: authority,
        verificationId: ref,
        issuedAt: now,
        expiresAt: exp,
        reviewedBy: adminUid,           /* never from input */
        updatedAt: now,
      },
    };
  }

  /* Suspend / revoke / reinstate. The record is never deleted: a revoked
     certification is part of the history of the business, and deleting it would
     erase the fact that one was ever granted. */
  var ACTIONS = { suspend: STATUS.SUSPENDED, revoke: STATUS.REVOKED,
                  reinstate: STATUS.CERTIFIED };

  function buildStatusChange (action, current, adminUid, nowMs) {
    var now = nowMs || Date.now();
    var next = ACTIONS[String(action || '')];
    if (!next) return { ok: false, errors: ['Unknown action.'], payload: null };
    if (!adminUid) return { ok: false, errors: ['The signed-in admin could not be identified.'], payload: null };
    if (!current || typeof current !== 'object') {
      return { ok: false, errors: ['There is no certification to change.'], payload: null };
    }
    /* Reinstating must not resurrect something that has since lapsed — that would
       put a live badge on an expired review. Re-issue it instead. */
    if (next === STATUS.CERTIFIED) {
      var e = ms(current.expiresAt);
      if (e !== null && e <= now) {
        return { ok: false, payload: null,
                 errors: ['This certification has expired. Issue it again with a new review date.'] };
      }
    }
    return { ok: true, errors: [],
             payload: { status: next, reviewedBy: adminUid, updatedAt: now } };
  }

  /* Every key any issuance path may write — the surface asserts against this, so a
     field added to a form without being considered here cannot reach Firestore. */
  function issueKeys () { return ISSUE_KEYS.slice(); }

  return {
    STATUS: STATUS,
    evaluate: evaluate,
    daysUntilExpiry: daysUntilExpiry,
    outstanding: outstanding,
    scopeLabel: scopeLabel,
    LEVELS: LEVELS,
    issuableScopes: issuableScopes,
    buildIssue: buildIssue,
    buildStatusChange: buildStatusChange,
    issueKeys: issueKeys,
    ms: ms,
  };
}));
