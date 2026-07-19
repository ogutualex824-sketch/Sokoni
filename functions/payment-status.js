/* ═══════════════════════════════════════════════════════════════════════════
   PAYMENT STATUS — canonical vocabulary
   ═══════════════════════════════════════════════════════════════════════════

   Why this module exists (P0, 2026-07-19).

   The payments collection carries TWO status vocabularies that never agreed:

     WRITERS emit uppercase
       financial-os.js:151   set    status: 'PENDING'
       index.js:5032         set    status: 'PENDING'
       index.js (webhook)    update status: 'COMPLETE' | 'FAILED' | 'PENDING'
       financial-os.js:258   update status: 'COMPLETE'
       financial-os.js:173   update status: 'FAILED'

     CONSUMERS tested lowercase
       email-triggers.js     p.status !== 'completed' && p.status !== 'success'  -> return
       redis-integrations.js STATE_MAP = { completed: …, paid: …, success: … }

   Neither consumer ever matched. The email trigger returned early on every real
   payment, and STATE_MAP['COMPLETE'] fell through to the raw value, so the Redis
   'completed' branch never ran and the event bus published `payment_COMPLETE`
   instead of `payment_completed`.

   Rather than rewrite what the writers store — that would touch live payment
   records and the settlement/commission paths, which are out of scope — every
   consumer now normalises through here. One vocabulary, one place to change it.

   This module is deliberately pure: no firebase-admin, no I/O, no side effects,
   so it is safe to require from any trigger without pulling in dependencies.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/* Canonical internal states. */
const SUCCESS  = 'completed';
const FAILED   = 'failed';
const PENDING  = 'pending';
const REFUNDED = 'refunded';
const EXPIRED  = 'expired';

/* Every spelling observed in the codebase, mapped to canonical form.
   Keys are compared lowercased, so 'COMPLETE', 'Complete' and 'complete' all land here. */
const ALIASES = {
  /* success */
  complete:   SUCCESS,
  completed:  SUCCESS,
  success:    SUCCESS,
  successful: SUCCESS,
  paid:       SUCCESS,
  /* failure */
  failed:     FAILED,
  failure:    FAILED,
  cancelled:  FAILED,
  canceled:   FAILED,
  /* in flight */
  pending:    PENDING,
  processing: PENDING,
  /* terminal, non-success */
  refunded:   REFUNDED,
  expired:    EXPIRED,
};

/* Normalise any stored status to canonical form. Unknown values are returned
   lowercased rather than coerced, so a new provider state shows up as itself in
   logs instead of being silently mistaken for success. */
function normalize(status) {
  const key = String(status == null ? '' : status).trim().toLowerCase();
  if (!key) return '';
  return ALIASES[key] || key;
}

/* True only for a final, money-received state. */
function isSuccess(status) {
  return normalize(status) === SUCCESS;
}

function isFailure(status) {
  return normalize(status) === FAILED;
}

/* True when a document transitioned INTO success on this write.
   Guards the trigger against firing on every subsequent unrelated update to an
   already-complete payment (a settlement stamp, a reconciliation touch). */
function becameSuccessful(beforeStatus, afterStatus) {
  return !isSuccess(beforeStatus) && isSuccess(afterStatus);
}

module.exports = {
  SUCCESS, FAILED, PENDING, REFUNDED, EXPIRED,
  normalize, isSuccess, isFailure, becameSuccessful,
};
