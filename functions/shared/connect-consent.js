'use strict';
/**
 * SOKONI Connect — the video consent contract (Gate C3-A).
 * ============================================================================================
 * Six fields, all mandatory, none of them decorative:
 *
 *     purpose        why this session is happening
 *     camera         whether the camera will be used
 *     microphone     whether the microphone will be used
 *     recording      ON or OFF
 *     retention      how long a recording is kept
 *     access         who may see a recording
 *
 * ── WHY RETENTION AND ACCESS ARE HERE WHILE RECORDING IS OFF ───────────────────────────────
 * They are the two fields a no-recording design is tempted to leave blank, and blank is
 * exactly what rots. "Retention: N/A" written today reads, the day recording is switched on,
 * as a field somebody already thought about — and nobody re-opens it.
 *
 * So with recording OFF the values are SPECIFIC STATEMENTS about why they do not apply:
 * `not_applicable_no_recording`, `no_recording_exists`. They are true, they are checkable, and
 * they become obviously wrong the moment recording is enabled.
 *
 * And that moment is guarded: `buildConsentDisclosure` REFUSES to produce a contract with
 * recording ON unless retention and access are supplied explicitly, and refuses the
 * no-recording sentinels in that case. A generic placeholder cannot survive the transition,
 * because the function will not build it.
 *
 * ── CONSENT IS NOT VERIFICATION ────────────────────────────────────────────────────────────
 * Accepting this disclosure means a person agreed to appear on camera. It establishes nothing
 * about who they are. It never sets `verified`, `official`, `faceVerified`,
 * `documentsVerified`, never touches `providerVerification`, and never mints a claim — a
 * camera that switched on is not proof of identity, and the platform rule is that an official
 * identity needs a passed identity check, a passed face check AND a completed human review.
 *
 * This module produces a DISCLOSURE and nothing else. It has no writer and no side effect.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require.
 */

/** The canonical acknowledgement. Nothing else is consent — not `'yes'`, not `1`, not `{}`. */
const CONSENT_ACK = true;

/** The six fields a disclosure must carry. A contract missing one is not a contract. */
const CONSENT_FIELDS = Object.freeze([
  'purpose', 'camera', 'microphone', 'recording', 'retention', 'access',
]);

const RECORDING_STATES = Object.freeze(['ON', 'OFF']);

/* The specific no-recording statements. Named constants rather than inline strings so the
   guard below can recognise them and refuse them when recording is ON. */
const NO_RECORDING_RETENTION = 'not_applicable_no_recording';
const NO_RECORDING_ACCESS = 'no_recording_exists';

/* Human-readable purposes. Mirrors the authority's verification procedures rather than
   restating them as policy: this module labels, it does not authorize. */
const PURPOSE_LABELS = Object.freeze({
  identity_verification: 'Identity verification',
  business_verification: 'Business verification',
  merchant_verification: 'Merchant verification',
  rider_verification: 'Rider verification',
  supplier_verification: 'Supplier verification',
  support_escalation: 'Support escalation',
  business_meeting: 'Business meeting',
  supplier_meeting: 'Supplier meeting',
  enterprise_support: 'Enterprise support',
  operational_coordination: 'Operational coordination',
  remote_assistance: 'Remote assistance',
});

/**
 * buildConsentDisclosure({ purpose, recording, retention, access }) -> the six fields
 *
 * THROWS rather than guessing. A disclosure is shown to a person before their camera is
 * switched on; a field this function had to invent is a statement nobody can stand behind.
 */
function buildConsentDisclosure(input) {
  const i = input || {};
  const purpose = String(i.purpose || '');
  const recording = String(i.recording || 'OFF').toUpperCase();

  if (!purpose) {
    throw new Error('connect-consent: a disclosure must state its purpose');
  }
  if (!RECORDING_STATES.includes(recording)) {
    throw new Error('connect-consent: recording must be ON or OFF');
  }

  let retention;
  let access;

  if (recording === 'OFF') {
    /* Specific statements, not blanks. Supplying a retention for a recording that does not
       exist would be a claim about nothing. */
    if (i.retention || i.access) {
      throw new Error('connect-consent: retention and access are not supplied while recording is OFF');
    }
    retention = NO_RECORDING_RETENTION;
    access = NO_RECORDING_ACCESS;
  } else {
    /* THE GUARD THIS MODULE EXISTS FOR. Recording ON requires both to be stated explicitly,
       and the no-recording sentinels are refused — they would be false. */
    retention = String(i.retention || '');
    access = String(i.access || '');
    if (!retention) {
      throw new Error('connect-consent: recording is ON — retention must be stated explicitly');
    }
    if (!access) {
      throw new Error('connect-consent: recording is ON — access must be stated explicitly');
    }
    if (retention === NO_RECORDING_RETENTION || access === NO_RECORDING_ACCESS) {
      throw new Error('connect-consent: the no-recording statements are false while recording is ON');
    }
  }

  return Object.freeze({
    purpose: PURPOSE_LABELS[purpose] || purpose.replace(/_/g, ' '),
    purposeKey: purpose,
    camera: 'required',
    microphone: 'required',
    recording,
    retention,
    access,
    /* Stated on the disclosure itself, because the person reading it is entitled to know what
       agreeing does and does not do. */
    establishesIdentity: false,
  });
}

/**
 * isConsentComplete(disclosure) -> boolean
 *
 * A disclosure missing any of the six fields must never be shown. Checked rather than trusted
 * so a hand-built object cannot reach a person.
 */
function isConsentComplete(disclosure) {
  const d = disclosure || {};
  return CONSENT_FIELDS.every((f) => {
    const v = d[f];
    return typeof v === 'string' && v.length > 0;
  });
}

/**
 * acceptsConsent(value) -> boolean
 *
 * `=== true` and nothing else, for the same reason the capability test is `=== true`: a
 * string, a number, an array or an object arriving from a client is not an informed
 * acceptance, and a truthy check would treat every one of them as one.
 */
function acceptsConsent(value) {
  return value === CONSENT_ACK;
}

/** Plain text for a client that has no designed screen yet. The wording is not the contract —
 *  the six fields are — but this keeps the two from drifting. */
function disclosureText(disclosure) {
  const d = disclosure || {};
  if (!isConsentComplete(d)) {
    throw new Error('connect-consent: refusing to render an incomplete disclosure');
  }
  return [
    'SOKONI video session',
    '',
    'Purpose: ' + d.purpose,
    'Camera: ' + d.camera,
    'Microphone: ' + d.microphone,
    'Recording: ' + d.recording,
    'Retention: ' + d.retention,
    'Access: ' + d.access,
    '',
    'Agreeing lets this session take place. It does not verify your identity.',
  ].join('\n');
}

module.exports = {
  CONSENT_ACK,
  CONSENT_FIELDS,
  RECORDING_STATES,
  NO_RECORDING_RETENTION,
  NO_RECORDING_ACCESS,
  PURPOSE_LABELS,
  buildConsentDisclosure,
  isConsentComplete,
  acceptsConsent,
  disclosureText,
};
