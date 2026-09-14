'use strict';
/**
 * VERIFICATION ADAPTER — the single vendor boundary for identity verification.
 *
 * NO VENDOR IS SELECTED. D-02 (vendor), D-03 (processing topology), the retention value and the
 * confidence threshold are all still open decisions, so none of them appears here as a literal.
 * What ships is the BOUNDARY: one shape the rest of SOKONI consumes, so that when a vendor is
 * chosen it is integrated in one file rather than threaded through merchant, provider and driver
 * flows — which is how five incompatible verification systems get built.
 *
 * THE NULL ADAPTER IS NOT A STUB TO BE REPLACED LATER. It is the correct behaviour for "no
 * automated verification is configured": every applicant routes to assisted human review. That is
 * a working system, just a slower one — and it is what must happen if a vendor is ever removed,
 * suspended for a demographic-performance breach, or simply down.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────────────────────────
 * An ABSENT automated result is NEVER a pass. Not `undefined !== false`, not a truthy check, not
 * a default. The platform has been bitten by exactly this shape before: `Number(undefined)` → NaN
 * made a commission cap stop existing rather than error, and a denylist that did not name a field
 * made it writable. Here the failure would be worse — an applicant becomes officially verified
 * because a score was missing. Every path below is written so that absence produces ASSISTED,
 * never APPROVED.
 */

/** The states an automated result may carry. `indeterminate` is a real answer, not an error. */
const LIVENESS = Object.freeze({ PASS: 'pass', FAIL: 'fail', INDETERMINATE: 'indeterminate' });

/** Why a verification did not complete automatically. Four different operator problems — see
 *  D-15: only one of them is a fraud signal, and collapsing them turns accessibility into
 *  rejection. */
const FAILURE_CLASS = Object.freeze({
  CAPTURE_UNSUPPORTED: 'capture_unsupported',
  LIVENESS_INDETERMINATE: 'liveness_indeterminate',
  MATCH_LOW_CONFIDENCE: 'match_low_confidence',
  APPLICANT_UNABLE: 'applicant_unable',
  NO_ADAPTER: 'no_adapter_configured',
});

const ROUTE = Object.freeze({ AUTOMATED: 'automated', ASSISTED: 'assisted' });

/**
 * The shape every adapter must return. Vendor SDK types never reach SOKONI's records.
 * Fields are deliberately nullable: a null is an honest "not established", and the consumer
 * below treats null as assisted rather than as a value.
 */
function emptyResult(failureClass) {
  return {
    provider: null,            // set by a real adapter
    verificationId: null,
    vendorModelVersion: null,  // a score is meaningless later without knowing which model produced it
    processingRegion: null,    // evidence per verification, NOT a global setting
    vendorReceivedAt: null,    // the vendor's retention clock starts here, not at our decision
    deletionHandle: null,      // without this we can request deletion but never prove it
    livenessResult: null,
    faceMatchScore: null,
    automatedOutcome: null,    // never 'approved' — see decideRoute
    failureClass: failureClass || FAILURE_CLASS.NO_ADAPTER,
    correlationId: null,
  };
}

/**
 * THE NULL ADAPTER. No vendor configured: nothing is claimed about the applicant.
 * It does not throw — an unconfigured verification engine must degrade to human review, not
 * take the application down.
 */
const nullAdapter = {
  id: 'null',
  async verify() { return emptyResult(FAILURE_CLASS.NO_ADAPTER); },
};

let _adapter = nullAdapter;

/** Register a real adapter. Unused until a vendor is selected (D-02). */
function useAdapter(adapter) {
  if (!adapter || typeof adapter.verify !== 'function') {
    throw new Error('verification-adapter: an adapter must expose verify()');
  }
  _adapter = adapter;
}
function activeAdapter() { return _adapter; }
function isConfigured() { return _adapter !== nullAdapter; }

/**
 * Decide which route an automated result implies.
 *
 * `threshold` is REQUIRED when a score is present and is supplied by the caller from
 * configuration — there is no default, because a default threshold is a commercial decision
 * smuggled into code. If a score exists and no threshold was configured, that is assisted too:
 * we cannot evaluate a number against a rule nobody has set.
 *
 * @returns { route, failureClass, reason }
 */
function decideRoute(result, threshold) {
  const r = result || emptyResult();

  /* Explicit presence tests. Not truthiness: a score of 0 is a REAL measurement meaning
     "no match", and a truthy check would treat it as missing and fall through to the same
     branch as absent — which is the opposite of what 0 means. */
  const hasLiveness = r.livenessResult === LIVENESS.PASS
                   || r.livenessResult === LIVENESS.FAIL
                   || r.livenessResult === LIVENESS.INDETERMINATE;
  const hasScore = typeof r.faceMatchScore === 'number' && Number.isFinite(r.faceMatchScore);

  if (!hasLiveness || !hasScore) {
    return { route: ROUTE.ASSISTED,
             failureClass: r.failureClass || FAILURE_CLASS.NO_ADAPTER,
             reason: 'automated evidence incomplete — liveness=' + String(r.livenessResult) +
                     ' score=' + String(r.faceMatchScore) };
  }
  if (r.livenessResult === LIVENESS.FAIL) {
    return { route: ROUTE.ASSISTED, failureClass: FAILURE_CLASS.LIVENESS_INDETERMINATE,
             reason: 'liveness did not pass' };
  }
  if (r.livenessResult === LIVENESS.INDETERMINATE) {
    return { route: ROUTE.ASSISTED, failureClass: FAILURE_CLASS.LIVENESS_INDETERMINATE,
             reason: 'liveness indeterminate' };
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    /* D-04 leaves the threshold to configuration. No configured rule means no automated pass. */
    return { route: ROUTE.ASSISTED, failureClass: FAILURE_CLASS.MATCH_LOW_CONFIDENCE,
             reason: 'no configured match threshold — cannot evaluate the score' };
  }
  if (r.faceMatchScore < threshold) {
    return { route: ROUTE.ASSISTED, failureClass: FAILURE_CLASS.MATCH_LOW_CONFIDENCE,
             reason: 'match score below the configured threshold' };
  }
  /* AUTOMATED here means only "the machine evidence is sufficient to put this in front of a
     reviewer as a clean case". It is NOT an approval — see verification-authority: humanDecision
     is a separate field written by a person. */
  return { route: ROUTE.AUTOMATED, failureClass: null, reason: 'automated evidence complete' };
}

/**
 * Run verification through whatever adapter is active. Never throws on adapter failure: a vendor
 * outage must produce assisted review, not a failed application.
 */
async function runVerification(input, opts) {
  let result;
  try {
    result = await _adapter.verify(input);
  } catch (e) {
    result = emptyResult(FAILURE_CLASS.NO_ADAPTER);
    result.reason = 'adapter threw: ' + (e && e.message);
  }
  const decision = decideRoute(result, opts && opts.threshold);
  return { result, ...decision };
}

module.exports = {
  LIVENESS, FAILURE_CLASS, ROUTE,
  emptyResult, nullAdapter, useAdapter, activeAdapter, isConfigured,
  decideRoute, runVerification,
};
