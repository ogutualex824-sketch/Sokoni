'use strict';
/**
 * MFA ENROLMENT — the ONE predicate for "this user has MFA" (security-identity.getMFAStatus semantics).
 *
 *   securityMFA/{uid} exists AND pending !== true   → enrolled
 *
 * confirmTOTPEnrollment writes { pending:false, method, enrolledAt, … }; it never writes an `enrolled` field, so any
 * query on `enrolled == true` counts nothing. Every reader (getMFAStatus, the security scorecard, the pen-test MFA row)
 * uses this predicate or its query form `where('pending', '==', false)`.
 */
function isEnrolled(data) {
  return !!data && typeof data === 'object' && data.pending !== true;
}

module.exports = { isEnrolled, ENROLLED_FIELD: 'pending', ENROLLED_VALUE: false };
