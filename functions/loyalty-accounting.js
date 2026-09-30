'use strict';
/* ══════════════════════════════════════════════════════════════════════════════════════
   SOKONI — LOYALTY ACCOUNTING AGGREGATION
   ══════════════════════════════════════════════════════════════════════════════════════
   The one place loyalty totals are computed. AdminOS will OBSERVE this; it will never
   recompute, cache or write its own version of it.

        loyalty authority  →  immutable events  →  THIS  →  AdminOS observation

   WHAT THE EXISTING AGGREGATE DID, AND WHY IT COULD NOT BE REPAIRED IN PLACE
   -------------------------------------------------------------------------
   L4 measured `getMerchantLoyaltyDashboard` and found four patterns that each produce a
   number that renders like a measurement and is not one:

     · `.limit(500)` on a query whose rows are then summed — a total that is wrong rather
       than approximate, and says so nowhere
     · `.catch(() => ({ docs: [] }))` — A FAILED QUERY BECOMES AN ACCOUNTING ZERO
     · `where('type','==','earn')` / `'redeem'` only — reversals, expiries and corrections
       silently excluded, so the result is not a balance of the ledger
     · `d.amountKES || 0` — an ABSENT valuation summed as a real zero, on a field absent
       from 7 of 13 writers

   THE RULES THIS MODULE HOLDS TO
   ------------------------------
   1. ZERO MEANS MEASURED ZERO. A failure returns `state: 'UNAVAILABLE'` and NO totals at
      all. There is no field to mistake for a number, because the numbers are absent.
   2. NO SILENT TRUNCATION. Every page is read. A run that exceeds its safety bound returns
      `state: 'INCOMPLETE'` and says how far it got — it never returns a partial sum as if
      it were whole.
   3. THE FULL VOCABULARY. Semantics come from loyalty-event.js, not from a list of two
      names here. A type this platform does not recognise is counted as UNCLASSIFIED and
      kept OUT of the totals: "I do not know" and "zero" are different answers.
   4. ABSENCE SURVIVES. A KES valuation is summed only where the event carries one together
      with its rate and version. Events without a valuation are COUNTED, never coerced, so a
      reader can tell an unvalued ledger from a worthless one.
   ══════════════════════════════════════════════════════════════════════════════════════ */

const EV = require('./loyalty-event');

const PAGE = 500;
/* A bound, not a truncation: crossing it changes the STATE rather than the total. */
const MAX_PAGES = 200;                       /* 100,000 events */

/** Milliseconds from a Timestamp, Date or epoch number; null when it cannot be placed. */
function _ms(v) {
  if (v === undefined || v === null) return null;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
  if (v instanceof Date) { const n = v.getTime(); return Number.isFinite(n) ? n : null; }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  return null;
}

function _emptyTotals() {
  return {
    ISSUE: { events: 0, points: 0 },
    REDEEM: { events: 0, points: 0 },
    EXPIRE: { events: 0, points: 0 },
    REVERSE: { events: 0, points: 0 },
    ADJUST: { events: 0, points: 0 },
  };
}

/**
 * Aggregate the canonical loyalty ledger.
 *
 * @param db            a Firestore handle (injected, so a test never reaches production)
 * @param o.uid         optional scope — ONE customer's events, for per-account reconciliation
 * @param o.merchantId  optional scope
 * @param o.rail        optional scope, one of EV.RAILS
 * @param o.since       optional Date/Timestamp lower bound (inclusive), applied IN MEMORY
 * @param o.until       optional upper bound (exclusive), applied IN MEMORY
 *
 * A window is NOT a query filter here — see the note at the query. A windowed call still
 * scans the whole scope, reports eventsScanned alongside eventsRead, and reports how many
 * rows the window excluded and how many it could not place in time.
 *
 * @returns {{
 *   state: 'OK'|'UNAVAILABLE'|'INCOMPLETE',
 *   reason: string|null,
 *   eventsRead: number,
 *   byClass, byRail, byType,
 *   points: { issued, redeemed, expired, reversed, adjusted, outstanding },
 *   valuation: { valuedKES, eventsValued, eventsUnvalued, rateVersions },
 *   unclassified: Array<{type, events}>
 * }}
 *
 * On UNAVAILABLE the numeric sections are ABSENT, not zeroed. A caller that renders a total
 * must check `state` first; there is deliberately nothing to render otherwise.
 */
/**
 * Page the canonical ledger once, in one place, and hand every IN-SCOPE event to a visitor.
 *
 * This is the ONLY place the ledger is paged. aggregate() is its first consumer; the fraud
 * dashboard is its second, for behavioural signals that are NOT accounting figures. A second
 * paging loop elsewhere would duplicate the scope, window, failure and truncation rules and
 * drift from them.
 *
 * @param db        an injected Firestore handle
 * @param o.uid         optional scope — one customer
 * @param o.merchantId  optional scope
 * @param o.rail        optional scope, one of EV.RAILS
 * @param o.since       optional lower bound (inclusive), applied IN MEMORY
 * @param o.until       optional upper bound (exclusive), applied IN MEMORY
 * @param visit     called as visit(eventData, docId) for each in-scope, in-window event
 *
 * @returns {{state:'OK'|'UNAVAILABLE'|'INCOMPLETE', reason, eventsRead, eventsScanned,
 *            window:{applied, eventsOutsideWindow, eventsUndated}}}
 *
 * On UNAVAILABLE or INCOMPLETE the caller must report no totals at all — the visitor will
 * have seen a partial stream, and a partial stream summed is a wrong number, not a rough one.
 */
async function scanLedger(db, o, visit) {
  const opt = o || {};
  let q = db.collection('loyaltyLedger');

  /* A per-account scope. reconcileLoyaltyLedger needs one customer's total, and the only
     alternative is a second balance computation living inside a scheduled writer — which is
     exactly the defect this module exists to remove. Scoping the ONE authority is not the
     same as adding another. */
  if (opt.uid) q = q.where('uid', '==', String(opt.uid));
  if (opt.merchantId) q = q.where('merchantId', '==', String(opt.merchantId));
  if (opt.rail) {
    if (EV.RAILS.indexOf(opt.rail) === -1) {
      return { state: 'UNAVAILABLE', reason: 'unknown rail "' + opt.rail + '"', eventsRead: 0, eventsScanned: 0 };
    }
    q = q.where('rail', '==', opt.rail);
  }

  /* THE WINDOW IS NOT A QUERY FILTER. A range on createdAt requires createdAt to be the
     FIRST sort order, which contradicts the __name__ ordering below — Firestore rejects the
     combination outright, so every windowed call used to return UNAVAILABLE, adminLoyaltyOverview
     included. Ordering by createdAt instead would need loyaltyLedger(merchantId, createdAt,
     __name__), an index the manifest does not carry. The window is therefore applied per event
     while paging: exact, index-free, and honest about what it could not place in time. */
  const since = _ms(opt.since);
  const until = _ms(opt.until);
  if (opt.since && since === null) {
    return { state: 'UNAVAILABLE', reason: 'since is not a usable date', eventsRead: 0, eventsScanned: 0 };
  }
  if (opt.until && until === null) {
    return { state: 'UNAVAILABLE', reason: 'until is not a usable date', eventsRead: 0, eventsScanned: 0 };
  }
  const windowed = since !== null || until !== null;

  /* Order by document id: stable, and needs no composite index that the manifest may not
     carry. An ordering that depends on an unbuilt index is a query that fails in production
     and succeeds in a test. */
  q = q.orderBy('__name__').limit(PAGE);

  let eventsRead = 0, eventsScanned = 0, eventsUndated = 0, eventsOutsideWindow = 0;
  let cursor = null, pages = 0, truncated = false;

  for (;;) {
    let snap;
    try {
      snap = await (cursor ? q.startAfter(cursor).get() : q.get());
    } catch (err) {
      /* THE WHOLE POINT. A failed read is not a zero — it is the absence of an answer, and
         the caller is told so with no numbers attached to misread. */
      return {
        state: 'UNAVAILABLE',
        reason: 'ledger query failed: ' + ((err && err.message) || String(err)),
        eventsRead,
        eventsScanned,
      };
    }

    if (snap.empty) break;
    for (const d of snap.docs) {
      const e = d.data() || {};
      eventsScanned++;

      if (windowed) {
        const at = _ms(e.createdAt);
        if (at === null) {
          /* Cannot be placed in time. NOT counted into the window's totals, and NOT discarded
             in silence either — a reader can see how much of the scope was unplaceable. */
          eventsUndated++;
          continue;
        }
        if (since !== null && at < since) { eventsOutsideWindow++; continue; }
        if (until !== null && at >= until) { eventsOutsideWindow++; continue; }
      }
      eventsRead++;
      visit(e, d.id);
    }

    cursor = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.size < PAGE) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
  }

  const window = windowed
    ? { applied: true, eventsOutsideWindow, eventsUndated }
    : { applied: false, eventsOutsideWindow: 0, eventsUndated: 0 };

  if (truncated) {
    return {
      state: 'INCOMPLETE',
      reason: 'exceeded ' + MAX_PAGES + ' pages (' + eventsScanned + ' rows scanned); ' +
              'totals are deliberately withheld rather than reported partial',
      eventsRead,
      eventsScanned,
      window,
    };
  }
  return { state: 'OK', reason: null, eventsRead, eventsScanned, window };
}

/* ── THE ONE CLASSIFICATION ──────────────────────────────────────────────────────────
   Every consumer of the ledger classifies events HERE. A handler that reimplements this —
   even correctly, even once — creates a second set of semantics free to drift from the
   canonical ones the moment either changes. */

function _newAcc() {
  return {
    eventsRead: 0,
    byClass: _emptyTotals(),
    byRail: {},
    byType: {},
    unclassified: {},
    rateVersions: {},
    eventsValued: 0,
    eventsUnvalued: 0,
    valuedKES: 0,
  };
}

function _accumulate(acc, e) {
  acc.eventsRead++;

  const type = String(e.type || '');
  acc.byType[type] = (acc.byType[type] || 0) + 1;

  const rail = e.rail ? String(e.rail) : '(unrecorded)';
  acc.byRail[rail] = (acc.byRail[rail] || 0) + 1;

  const signed = EV.signedPoints(e);
  const klass = EV.classOf(type);
  if (signed === null || !klass) {
    /* Kept OUT of every total. An unrecognised type folded in as zero would understate
       the books while looking complete. */
    acc.unclassified[type || '(no type)'] = (acc.unclassified[type || '(no type)'] || 0) + 1;
  } else {
    acc.byClass[klass].events++;
    acc.byClass[klass].points += signed;
  }

  /* A valuation counts only when the event carries the rate AND the version that
     produced it — the three travel together or the figure cannot be explained. */
  const hasValue = e.valueKES !== undefined && e.valueKES !== null &&
                   Number.isFinite(Number(e.valueKES)) &&
                   Number.isFinite(Number(e.rate)) && e.rateVersion;
  if (hasValue) {
    acc.eventsValued++;
    acc.valuedKES += Number(e.valueKES);
    const rv = String(e.rateVersion);
    acc.rateVersions[rv] = (acc.rateVersions[rv] || 0) + 1;
  } else {
    /* NOT zero. Counted, so a reader can tell an unvalued ledger from a worthless one. */
    acc.eventsUnvalued++;
  }
}

function _finalise(acc) {
  const issued = acc.byClass.ISSUE.points;
  const redeemed = acc.byClass.REDEEM.points;
  const expired = acc.byClass.EXPIRE.points;
  const reversed = acc.byClass.REVERSE.points;
  const adjusted = acc.byClass.ADJUST.points;
  const unclassified = Object.keys(acc.unclassified).map((t) => ({ type: t, events: acc.unclassified[t] }));

  return {
    eventsRead: acc.eventsRead,
    byClass: acc.byClass,
    byRail: acc.byRail,
    byType: acc.byType,
    points: {
      issued,
      redeemed,
      expired,
      reversed,
      adjusted,
      /* Every class, signed by its own semantics — not issued-minus-redeemed. */
      outstanding: issued + redeemed + expired + reversed + adjusted,
    },
    valuation: {
      valuedKES: acc.valuedKES,
      eventsValued: acc.eventsValued,
      /* The honest headline: how much of the ledger cannot be valued at all. */
      eventsUnvalued: acc.eventsUnvalued,
      rateVersions: acc.rateVersions,
    },
    unclassified,
    /* How much of this group could be placed in the books at all. A group whose events are
       ALL unclassified has no financial figures — and must not be rendered as zeros beside a
       healthy-looking event count. */
    classifiedEvents: acc.byClass.ISSUE.events + acc.byClass.REDEEM.events +
                      acc.byClass.EXPIRE.events + acc.byClass.REVERSE.events +
                      acc.byClass.ADJUST.events,
  };
}

async function aggregate(db, o) {
  const acc = _newAcc();
  const scan = await scanLedger(db, o, (e) => _accumulate(acc, e));

  /* A partial or failed stream carries NO totals. The accumulator above has already run over
     whatever it saw, and that accumulation is deliberately discarded here rather than
     returned as a number that looks whole. */
  if (scan.state !== 'OK') {
    return {
      state: scan.state,
      reason: scan.reason,
      eventsRead: scan.eventsRead,
      eventsScanned: scan.eventsScanned,
    };
  }

  const f = _finalise(acc);
  return {
    state: 'OK',
    reason: null,
    eventsRead: scan.eventsRead,
    /* Scope accounting: what was examined, what the window excluded, and what it could not
       place. A windowed figure is only interpretable alongside these. */
    eventsScanned: scan.eventsScanned,
    window: scan.window,
    byClass: f.byClass,
    byRail: f.byRail,
    byType: f.byType,
    points: f.points,
    valuation: f.valuation,
    unclassified: f.unclassified,
    classifiedEvents: f.classifiedEvents,
  };
}

/**
 * The same aggregation, split by one server-written field.
 *
 * @param groupField  the event field to group on — 'merchantId' or 'rail'. It is the field
 *                    the SERVER wrote on the event; a caller cannot nominate a grouping that
 *                    re-attributes someone else's events, because the value comes off the
 *                    event and not off the request.
 *
 * Events missing the field are counted as "ungrouped" rather than assigned to a bucket, so a
 * breakdown never quietly inherits rows it could not attribute.
 *
 * @returns {{state, reason, eventsRead, eventsScanned, window,
 *            groups: {[key]: finalised}, ungrouped: number}}
 */
const GROUPABLE = Object.freeze(['merchantId', 'rail']);

async function aggregateGrouped(db, o, groupField) {
  if (GROUPABLE.indexOf(groupField) === -1) {
    return { state: 'UNAVAILABLE', reason: 'ungroupable field "' + groupField + '"', eventsRead: 0, eventsScanned: 0 };
  }

  const accs = new Map();
  let ungrouped = 0;

  const scan = await scanLedger(db, o, (e) => {
    const raw = e[groupField];
    if (raw === undefined || raw === null || String(raw) === '') { ungrouped++; return; }
    const key = String(raw);
    if (!accs.has(key)) accs.set(key, _newAcc());
    _accumulate(accs.get(key), e);
  });

  if (scan.state !== 'OK') {
    return {
      state: scan.state,
      reason: scan.reason,
      eventsRead: scan.eventsRead,
      eventsScanned: scan.eventsScanned,
    };
  }

  const groups = {};
  for (const [key, acc] of accs) groups[key] = _finalise(acc);

  return {
    state: 'OK',
    reason: null,
    eventsRead: scan.eventsRead,
    eventsScanned: scan.eventsScanned,
    window: scan.window,
    groups,
    /* Events carrying no value for the grouping field. NOT folded into any bucket. */
    ungrouped,
  };
}

module.exports = { aggregate, aggregateGrouped, scanLedger, GROUPABLE, PAGE, MAX_PAGES };
