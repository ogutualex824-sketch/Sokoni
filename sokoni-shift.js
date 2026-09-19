/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE SHIFT / TILL AUTHORITY
   ══════════════════════════════════════════════════════════════════════════════
   A supermarket till does not begin the day with "where is the POS setup?". It
   begins with OPENING CASH. This module is the arithmetic for that day:

       OPEN SHIFT → opening cash → sell → cash / M-PESA / mixed → change
                  → drawer balance → CLOSE SHIFT → expected vs counted

   ── IT EXTENDS THE EXISTING CASH MANAGER; IT DOES NOT FORK IT ───────────────
   The event vocabulary is exactly the one `functions/pos-cash-manager.js` and
   `pos-cash-manager.js` already use — register_open, cash_sale, cash_refund,
   cash_in, cash_out, safe_drop, cash_pickup, float_adjustment — and the expected
   formula is theirs, character for character:

       expected = openingFloat + cashSales - cashRefunds
                + cashIn - cashOut - safeDrops - cashPickups + adjustments

   A second till arithmetic is the last thing this platform needs, so there is not
   one here. This module makes that formula usable from the phone and enforces two
   invariants the shell must never be trusted to remember.

   ── INVARIANT 1: OPENING CASH IS NOT REVENUE ────────────────────────────────
   The float is the merchant's own money, put in the drawer to make change. It must
   never inflate sales, turnover, commission or earnings. It moves the DRAWER
   balance and nothing else. `salesTotal()` cannot see it — not because callers are
   careful, but because the float is not in the set of events it sums.

   ── INVARIANT 2: M-PESA IS NOT CASH IN THE DRAWER ───────────────────────────
   A phone payment is revenue but it is not physical money, and it cannot fund
   change. Counting it toward the drawer is how a till reconciles as "over" every
   evening and a cashier gets accused of nothing. Only `cash` tenders move the
   drawer.

   ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
   It computes and it refuses. It does not write to Firestore, does not decide who
   may open a shift, and does not replace the server: `cdRecordCashEvent` and the
   cash-manager callables remain the authority on the stored record. When the
   phone's figure and the server's disagree, the SERVER wins.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* The vocabulary of functions/pos-cash-manager.js:66. Not a new one. */
  var EV = {
    OPEN: 'register_open',
    CLOSE: 'register_close',
    SALE: 'cash_sale',
    REFUND: 'cash_refund',
    IN: 'cash_in',
    OUT: 'cash_out',
    DROP: 'safe_drop',
    PICKUP: 'cash_pickup',
    ADJUST: 'float_adjustment',
    FLOAT: 'opening_float',   /* posTillEvents spelling — see NOTE below */
  };

  /* NOTE ON TWO SPELLINGS OF THE FLOAT
     `functions/pos-cash-drawer.js` records the float as `opening_float` in
     posTillEvents, while the cash manager carries it as the `openingFloatCents`
     field of a `register_open`. Both are accepted here so a shift opened through
     either path reconciles — but NOTHING NEW is invented, and the float is still
     counted exactly once (see `_floatOf`). */

  var CASH = 'cash';
  var MINOR = 100;

  function _cashLib () { return global.SokoniCash || null; }

  function _int (v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    return Math.round(v);
  }

  /* Unreadable is NOT zero. Zero is a real amount a merchant might mean; an
     unreadable one is a refusal, exactly as in SokoniCash.toMinor. */
  function amountOf (ev) {
    if (!ev) return null;
    var raw = (ev.amountCents !== undefined) ? ev.amountCents
            : (ev.amountMinor !== undefined) ? ev.amountMinor
            : (ev.adjustmentCents !== undefined) ? ev.adjustmentCents
            : null;
    var n = _int(raw);
    if (n === null) return null;
    /* Only a float adjustment may be negative — it is the one signed event. */
    if (n < 0 && ev.type !== EV.ADJUST) return null;
    return n;
  }

  function _floatOf (events) {
    /* Counted ONCE even when a shift carries both spellings. A float counted twice
       makes every drawer look short by exactly the float. */
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e && e.type === EV.FLOAT) { var a = amountOf(e); if (a !== null) return a; }
    }
    for (var j = 0; j < events.length; j++) {
      var o = events[j];
      if (o && o.type === EV.OPEN) {
        var f = _int(o.openingFloatCents !== undefined ? o.openingFloatCents : o.amountCents);
        if (f !== null) return f;
      }
    }
    return 0;
  }

  /* ── THE DRAWER ────────────────────────────────────────────────────────────
     The canonical formula, unchanged from pos-cash-manager.js:90. */
  function summarise (events) {
    var list = Array.isArray(events) ? events.filter(Boolean) : [];
    var t = { openingFloat: _floatOf(list), cashSales: 0, cashRefunds: 0,
              cashIn: 0, cashOut: 0, safeDrops: 0, cashPickups: 0, adjustments: 0 };
    var unreadable = 0;

    list.forEach(function (e) {
      if (e.type === EV.FLOAT || e.type === EV.OPEN || e.type === EV.CLOSE) return;
      var a = amountOf(e);
      if (a === null) { unreadable++; return; }
      switch (e.type) {
        case EV.SALE:   t.cashSales   += a; break;
        case EV.REFUND: t.cashRefunds += a; break;
        case EV.IN:     t.cashIn      += a; break;
        case EV.OUT:    t.cashOut     += a; break;
        case EV.DROP:   t.safeDrops   += a; break;
        case EV.PICKUP: t.cashPickups += a; break;
        case EV.ADJUST: t.adjustments += a; break;
        default: unreadable++; break;      /* an unknown type is NOT silently zero */
      }
    });

    t.expected = t.openingFloat + t.cashSales - t.cashRefunds
               + t.cashIn - t.cashOut - t.safeDrops - t.cashPickups + t.adjustments;
    t.unreadable = unreadable;
    /* A shift containing an event this module could not read is NOT reconcilable.
       Reporting a confident expected figure over unreadable data is how a cashier
       ends up accused of a shortfall that was a parsing bug. */
    t.reconcilable = unreadable === 0;
    return t;
  }

  /* ── SALES ≠ DRAWER ────────────────────────────────────────────────────────
     Revenue for the shift. The float is structurally absent: it is not one of the
     event types this sums, so no caller can make it revenue by mistake. */
  function salesTotal (events) {
    var list = Array.isArray(events) ? events.filter(Boolean) : [];
    var total = 0, unreadable = 0;
    list.forEach(function (e) {
      if (e.type !== EV.SALE && e.type !== EV.REFUND) return;
      var a = amountOf(e);
      if (a === null) { unreadable++; return; }
      total += (e.type === EV.SALE ? a : -a);
    });
    return { netMinor: total, unreadable: unreadable, reconcilable: unreadable === 0 };
  }

  /* ── A SETTLED SALE BECOMES TILL EVENTS ────────────────────────────────────
     Takes a SokoniCash settlement and emits only what actually moved physical
     money. An M-PESA or card tender produces NO drawer event, because no note
     entered the drawer and none can be given as change from it. */
  function eventsForSale (settlement, meta) {
    if (!settlement || !Array.isArray(settlement.tenders)) return [];
    var m = meta || {};
    var out = [];
    var cashIn = 0;
    settlement.tenders.forEach(function (t) {
      if (t && t.method === CASH) cashIn += (_int(t.amountMinor) || 0);
    });
    if (!cashIn) return out;          /* nothing physical changed hands */
    /* NET of the change handed back: the drawer keeps the tender minus the change.
       Recording the gross tender and forgetting the change overstates the drawer by
       exactly the change given, on every single cash sale. */
    var change = _int(settlement.changeMinor) || 0;
    var net = cashIn - change;
    if (net <= 0) return out;
    out.push({ type: EV.SALE, amountCents: net,
               saleId: m.saleId || null, shiftId: m.shiftId || null,
               registerId: m.registerId || null, source: 'sokoni-shift' });
    return out;
  }

  /* ── THE CLOSE ─────────────────────────────────────────────────────────────
     Expected vs counted. `counted` is what a human actually counted, in minor
     units; anything unreadable is a refusal, never zero. */
  function close (events, counted) {
    var s = summarise(events);
    var actual = _int(counted);
    if (counted !== null && counted !== undefined && actual === null) {
      return { ok: false, error: 'The counted amount could not be read.', summary: s };
    }
    if (!s.reconcilable) {
      return { ok: false, error: 'This shift contains movements that could not be read, ' +
                                 'so it cannot be reconciled here.', summary: s };
    }
    if (actual === null) return { ok: true, status: 'pending_close', summary: s, varianceMinor: null };
    var variance = actual - s.expected;
    return {
      ok: true,
      summary: s,
      countedMinor: actual,
      varianceMinor: variance,
      /* One shilling of tolerance, matching cdGetShiftSummary's 100-cent band. */
      status: Math.abs(variance) < MINOR ? 'balanced' : (variance > 0 ? 'over' : 'short'),
    };
  }

  /* ── THE TILL PANEL ────────────────────────────────────────────────────────
     Exactly the lines a merchant expects to see, and no line for a movement that
     did not happen — a till showing "Cash refunds 0" every day trains people to
     stop reading it. */
  function tillLines (events) {
    var s = summarise(events);
    var C = _cashLib();
    var f = function (v) { return C ? C.fromMinor(v) : String(v); };
    var lines = [{ label: 'Opening cash', amount: f(s.openingFloat) }];
    if (s.cashSales) lines.push({ label: 'Cash sales', amount: f(s.cashSales) });
    if (s.cashRefunds) lines.push({ label: 'Cash refunds', amount: '-' + f(s.cashRefunds) });
    if (s.cashIn) lines.push({ label: 'Cash in', amount: f(s.cashIn) });
    if (s.cashOut) lines.push({ label: 'Cash paid out', amount: '-' + f(s.cashOut) });
    if (s.safeDrops) lines.push({ label: 'Safe drops', amount: '-' + f(s.safeDrops) });
    if (s.cashPickups) lines.push({ label: 'Cash pickups', amount: '-' + f(s.cashPickups) });
    if (s.adjustments) lines.push({ label: 'Adjustments', amount: f(s.adjustments) });
    return {
      heading: 'Till',
      lines: lines,
      total: { label: 'Expected cash', amount: s.reconcilable ? f(s.expected) : null },
      /* Never a number this module does not stand behind. */
      note: s.reconcilable ? null : 'Some movements could not be read — count the drawer and reconcile in Cash Manager.',
    };
  }

  global.SokoniShift = {
    EV: EV, MINOR: MINOR,
    amountOf: amountOf, summarise: summarise, salesTotal: salesTotal,
    eventsForSale: eventsForSale, close: close, tillLines: tillLines,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniShift;
}
