'use strict';

/**
 * SOKONI DATA AVAILABILITY AUTHORITY
 *
 * Analytics was the first caller; the FinOS admin console is the second. There is ONE
 * state vocabulary on this platform and it lives here — a second module with its own
 * spelling of "unavailable" would be a second authority, and two authorities that
 * disagree about whether a figure may be shown is the defect, not the fix.
 * ────────────────────────────────────────────────────────────────────────────
 * Three facts that a number cannot tell apart, and which analytics was reporting
 * identically as `0`:
 *
 *   REAL_ZERO      the source was read, and the merchant genuinely had no activity
 *   NO_DATA        the source holds nothing — not because the merchant was idle, but
 *                  because nothing has ever written it
 *   QUERY_FAILURE  the read did not complete: a missing index, a permission error, a
 *                  timeout. Nothing is known either way.
 *
 * `{ revenue: 0, units: 0 }` is a claim about a merchant's trading. Returning it for the
 * second or third case tells them they sold nothing when the truth is that nobody looked.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Production evidence, read-only, 2026-09-12:
 *
 *   orders          HAS data
 *   orderItems      EMPTY — no producer anywhere, no backfill, no index
 *   returnItems     EMPTY — same
 *
 * Seven analytics callables read `orderItems`/`returnItems`, aggregate an empty snapshot,
 * and return zeros as fact. A merchant with real orders is told they sold nothing.
 *
 * A second instance of the same defect sits in `analyticsSnapshotDaily`: it queries
 * `orders.where('shopId','==',shopId)`, and live orders carry NO top-level `shopId` — they
 * carry `sellerUid`. That query matches nothing, so the daily snapshot records
 * `{ orders: 0, revenue: 0 }` for every shop, every day, and those snapshots are written
 * as fact.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 * It does not compute money, sum a ledger, or invent a figure. It decides only whether a
 * figure MAY be reported, and says why when it may not. The aggregation stays where it
 * was; what changes is that an empty or failed read can no longer masquerade as a zero.
 */

const STATE = Object.freeze({
  REAL_ZERO:     'REAL_ZERO',
  NO_DATA:       'NO_DATA',
  QUERY_FAILURE: 'QUERY_FAILURE',
  OK:            'OK',
});

/**
 * Paths known to have no producer. A read of one of these returning empty is NO_DATA, not
 * a statement about the merchant — and saying so is the whole point.
 *
 * Kept as data so the certification suite asserts against this list rather than a second
 * copy of it, and so removing a name is a deliberate act once its producer exists.
 */
const UNPRODUCED = Object.freeze(['orderItems', 'returnItems']);

/**
 * Run a Firestore query and report WHAT HAPPENED, not merely what came back.
 *
 * The caller hands the query and the collection it is about. A throw becomes
 * QUERY_FAILURE rather than an empty array, which is the substitution this module exists
 * to prevent: `.catch(() => ({ docs: [] }))` is how a missing index becomes a zero.
 */
async function read(collection, queryPromise) {
  const name = String(collection || '');
  try {
    const snap = await queryPromise;
    const docs = (snap && snap.docs) || [];
    if (docs.length) return { state: STATE.OK, docs, collection: name };

    /* Empty. Whether that is a real zero depends on whether anything can write here. */
    if (UNPRODUCED.indexOf(name) !== -1) {
      return {
        state: STATE.NO_DATA, docs: [], collection: name,
        reason: name + ' has no producer — an empty result says nothing about this merchant',
      };
    }
    return { state: STATE.REAL_ZERO, docs: [], collection: name };
  } catch (e) {
    return {
      state: STATE.QUERY_FAILURE, docs: [], collection: name,
      reason: (e && e.message) || String(e),
    };
  }
}

/** May a figure derived from these reads be reported as fact? */
function reportable(...results) {
  return results.every((r) => r && (r.state === STATE.OK || r.state === STATE.REAL_ZERO));
}

/**
 * The envelope every analytics response carries.
 *
 * `available:false` is not an error — the caller still gets a well-formed response and the
 * surface can say "we cannot show this yet" instead of drawing a zero. What it must never
 * do is hand back figures as though they were measured.
 */
function envelope(results, payload) {
  const rs = results.filter(Boolean);
  if (reportable(...rs)) {
    return Object.assign({ available: true, dataState: STATE.OK }, payload);
  }
  const blocking = rs.find((r) => r.state === STATE.QUERY_FAILURE) ||
                   rs.find((r) => r.state === STATE.NO_DATA);
  return {
    available: false,
    dataState: blocking.state,
    source: blocking.collection,
    reason: blocking.reason || null,
    /* Deliberately NOT the aggregated payload. Returning rows beside available:false
       invites a caller to render them anyway, which is the failure with extra steps. */
  };
}

/**
 * A single document read, reported the same way.
 *
 * A missing document is NOT a zero. `wallets/__platform__` does not exist on a platform
 * that has never credited it, and `{...}.availableCents || 0` turns that absence into a
 * balance of KES 0 on an admin financial console. NO_DATA says "nobody has written this",
 * which is the truth and is not a claim about money.
 */
async function readDoc(collection, docPromise) {
  const name = String(collection || '');
  try {
    const doc = await docPromise;
    if (doc && doc.exists) return { state: STATE.OK, doc, collection: name };
    return {
      state: STATE.NO_DATA, doc: null, collection: name,
      reason: name + ' document does not exist — absence is not a zero balance',
    };
  } catch (e) {
    return {
      state: STATE.QUERY_FAILURE, doc: null, collection: name,
      reason: (e && e.message) || String(e),
    };
  }
}

/**
 * A read that has a legitimate alternate source.
 *
 * Some fallbacks are real: a collection was renamed and the old name still holds rows.
 * The fallback is not the problem — `.catch(() => [])` is, because it erases the fact
 * that the canonical source did not answer. This keeps the fallback AND the fact.
 *
 * Each source is given as { collection, run } where `run` is a thunk, so the fallback is
 * not executed unless the primary actually fails. A primary that throws while its query
 * is being BUILT (an invalid filter, a bad field path) is a failure too, so the thunk is
 * called inside the guard rather than outside it.
 *
 * Note what is NOT a trigger: an empty primary. REAL_ZERO means the canonical source
 * answered and holds nothing, and reaching past it to a legacy alias would invent rows.
 * Only QUERY_FAILURE falls through.
 */
function _guardedRead(spec) {
  try { return read(spec.collection, spec.run()); }
  catch (e) { return read(spec.collection, Promise.reject(e)); }
}

async function readWithFallback(primary, fallback) {
  const p = await _guardedRead(primary);
  if (p.state !== STATE.QUERY_FAILURE || !fallback) {
    return Object.assign({}, p, { via: 'primary' });
  }
  const f = await _guardedRead(fallback);
  return Object.assign({}, f, {
    via: 'fallback',
    primaryFailure: { collection: primary.collection, reason: p.reason || null },
  });
}

/**
 * The envelope for a surface where "it succeeded" is not the whole truth.
 *
 * `envelope()` reports OK for every success. Here the distinction between SUCCESS+DATA
 * (OK) and SUCCESS+ZERO (REAL_ZERO) is preserved, and `via`/`degraded` say whether the
 * canonical source or its fallback answered. An admin looking at a queue of zero is
 * entitled to know which of those they are looking at.
 *
 * As in `envelope()`, an unavailable block carries NO payload. Handing back figures
 * beside `available:false` invites a caller to render them anyway.
 */
function envelopeWithProvenance(result, payload) {
  const r = result || {};
  const ok = r.state === STATE.OK || r.state === STATE.REAL_ZERO;
  const base = {
    available:      ok,
    dataState:      r.state || STATE.QUERY_FAILURE,
    source:         r.collection || null,
    via:            r.via || 'primary',
    degraded:       r.via === 'fallback',
    primaryFailure: r.primaryFailure || null,
    reason:         ok ? null : (r.reason || null),
  };
  return ok ? Object.assign(base, payload) : base;
}

module.exports = {
  STATE, UNPRODUCED, read, reportable, envelope,
  readDoc, readWithFallback, envelopeWithProvenance,
};
