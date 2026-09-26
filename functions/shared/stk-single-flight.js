'use strict';
/**
 * STK SINGLE-FLIGHT — the decision behind `paymentAttempts/{ref}` for the online
 * M-PESA rail (initiateSTKPush).
 *
 * THE DEFECT THIS CLOSES (executed 2026-09-26): two concurrent initiateSTKPush
 * calls for one reference both passed the `payments/{ref}` pre-check (it is
 * written only AFTER the gateway answers) and both reached IntaSend — two STK
 * prompts, same api_ref, two potential charges. Present on base SOKONI too.
 *
 * THE MODEL IS NOT NEW. It is the reservation pos-qr.js (P2) and
 * hosted-checkout.js already use: `paymentAttempts/{ref}` is claimed in a
 * transaction BEFORE the gateway call; the payment reference stays the one
 * identity (no new id is minted); a non-answer is OUTCOME_UNKNOWN and is never
 * retried blind. One document per reference also enforces "one rail per
 * intent" across STK and hosted checkout — whichever reserved first owns it.
 *
 * `decide` is PURE: the caller reads the attempt and the payment inside a
 * transaction, asks what to do, and writes only on 'new'. Keeping the rule
 * table here lets a suite prove every row without a gateway.
 *
 * Attempt states (paymentAttempts/{ref}.state):
 *   RESERVED           claimed, no request sent yet
 *   GATEWAY_REQUESTED  the request is being sent — it may have reached IntaSend
 *   GATEWAY_ACCEPTED   IntaSend answered 2xx with a checkout id
 *   GATEWAY_REJECTED   IntaSend answered 4xx — nothing is in flight
 *   OUTCOME_UNKNOWN    5xx / timeout / unreadable / 2xx without an id — HELD
 */

const REUSE_WINDOW_MS = 10 * 60 * 1000;   /* the rail's historic PENDING window */
const IN_FLIGHT = new Set(['RESERVED', 'GATEWAY_REQUESTED']);

const _ms = (ts) => {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  if (ts.seconds != null) return ts.seconds * 1000;
  return null;
};

const refuse = (code, message) => ({ action: 'refuse', code, message });

/**
 * @param {{att:object|null, pay:object|null, nowMs:number}} s
 * @returns {{action:'paid'|'reuse'|'new'|'wait'|'refuse', checkoutId?:string, code?:string, message?:string}}
 */
function decide({ att, pay, nowMs }) {
  const payStatus = pay ? String(pay.status || '') : null;

  /* 1. Paid is final — no gateway call, ever. */
  if (payStatus === 'COMPLETE') return { action: 'paid', checkoutId: (pay && pay.checkoutId) || null };

  /* 2. One rail per reference: a hosted checkout owns it unless it FAILED. */
  const hosted = (att && att.rail === 'hosted_checkout') || (pay && pay.rail === 'hosted_checkout');
  if (hosted && payStatus !== 'FAILED') {
    return refuse('failed-precondition', 'A card/other-method checkout is already open for this payment.');
  }

  /* 3. No attempt record. A PENDING payment without one pre-dates reservations
        (written by the previous code) — honour the old 10-minute reuse. */
  if (!att || hosted) {
    if (!hosted && payStatus === 'PENDING') {
      const age = nowMs - (_ms(pay.createdAt) ?? 0);
      if (age < REUSE_WINDOW_MS) {
        return pay.checkoutId ? { action: 'reuse', checkoutId: pay.checkoutId }
          : refuse('aborted', 'A payment request for this order is already in progress. Please wait.');
      }
    }
    return { action: 'new' };
  }

  const st = String(att.state || '');

  /* 4. Someone is sending right now — converge on their result, never send. */
  if (IN_FLIGHT.has(st)) return { action: 'wait' };

  if (st === 'GATEWAY_ACCEPTED') {
    if (payStatus === 'FAILED' || payStatus === 'CANCELLED') return { action: 'new' };
    if (payStatus === null || payStatus === 'PENDING') {
      const since = _ms(pay && pay.createdAt) ?? _ms(att.acceptedAtMs) ?? 0;
      if (nowMs - since < REUSE_WINDOW_MS) {
        return { action: 'reuse', checkoutId: att.checkoutId || (pay && pay.checkoutId) || null };
      }
      return { action: 'new' };                       /* PENDING > 10 min: safe reacquisition */
    }
    return refuse('failed-precondition', 'This payment is in an unexpected state. Please contact support.');
  }

  if (st === 'GATEWAY_REJECTED') return { action: 'new' };

  if (st === 'OUTCOME_UNKNOWN') {
    /* Held until the PROVIDER says what happened (the webhook writes the
       payment). A buyer-side cancel is not provider evidence. */
    if (payStatus === 'FAILED') return { action: 'new' };
    return refuse('unavailable', 'We could not confirm your earlier M-PESA request. Check your phone for a prompt before trying again.');
  }

  /* 5. Anything else is a state this code does not understand — fail closed. */
  return refuse('failed-precondition', 'This payment is in an unexpected state. Please contact support.');
}

/**
 * A caller that lost the reservation race waits for the WINNER's answer and
 * returns that — it never sends. Polls `read()` (→ {att, pay}) until the
 * attempt it saw (`attemptNo`) resolves, or gives up with "in progress".
 * A newer attempt number means someone reacquired meanwhile: not ours to
 * report, and still not a reason to send.
 */
async function awaitWinner(read, attemptNo, { timeoutMs = 12000, stepMs = 250, now = Date.now, sleep } = {}) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = now() + timeoutMs;
  while (now() < until) {
    await nap(stepMs);
    const { att, pay } = await read();
    if (pay && pay.status === 'COMPLETE') return { action: 'paid', checkoutId: pay.checkoutId || null };
    if (!att || (att.attemptNo || 0) !== attemptNo) break;
    if (att.state === 'GATEWAY_ACCEPTED') return { action: 'reuse', checkoutId: att.checkoutId || null };
    if (att.state === 'GATEWAY_REJECTED') return refuse('failed-precondition', 'The payment provider refused the request. Please try again.');
    if (att.state === 'OUTCOME_UNKNOWN') return refuse('unavailable', 'We could not confirm the M-PESA request. Check your phone for a prompt before trying again.');
  }
  return refuse('aborted', 'A payment request for this order is already in progress. Please wait.');
}

module.exports = { decide, awaitWinner, REUSE_WINDOW_MS, IN_FLIGHT, _ms };
