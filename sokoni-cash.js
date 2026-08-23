/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — CASH, TENDER AND CHANGE
   ══════════════════════════════════════════════════════════════════════════════
   The arithmetic a merchant does on every single sale, and the most immediately
   visible thing in a shop when it is wrong.

   ── NO FLOATING POINT, ANYWHERE ─────────────────────────────────────────────
   Every amount is an INTEGER in minor units (cents). 0.1 + 0.2 !== 0.3 in binary
   floating point, and a till that is one cent out on some sales and not others is
   a till nobody can reconcile. Input is parsed to an integer once, at the edge;
   everything downstream is integer addition and subtraction.

   ── THE TOTAL IS NOT OURS TO COMPUTE ────────────────────────────────────────
   `totalMinor` comes from the order's authoritative totals. This module never
   re-derives it from line items — two places computing the same total is two
   totals, and the one the customer paid must be the one the receipt prints.

   ── CHANGE COMES OUT OF THE CASH DRAWER ─────────────────────────────────────
   The subtle one. If a customer overpays by M-PESA you cannot hand them the
   difference from the till — the money is in a mobile account, not a drawer. So
   change is capped at the CASH tendered, and any excess beyond that is reported
   separately as `unrefundableMinor` rather than displayed as change the merchant
   is expected to produce.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var METHODS = ['cash', 'mpesa', 'card', 'wallet'];
  var MINOR = 100;                    /* KES cents */

  /* ── parsing ───────────────────────────────────────────────────────────────
     Accepts what a merchant actually types: "1,000", "1000.50", " 1 000 ", "KES 250".
     Returns null — NOT zero — for anything it cannot read. Zero is a real amount a
     merchant might mean; unreadable input must never silently become it. */
  function toMinor (input) {
    if (typeof input === 'number') {
      if (!isFinite(input) || input < 0) return null;
      return Math.round(input * MINOR);
    }
    var s = String(input == null ? '' : input).trim();
    if (!s) return null;
    s = s.replace(/^kes\s*/i, '').replace(/[\s,]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;   /* no negatives, max 2 decimals */
    var parts = s.split('.');
    var whole = parseInt(parts[0], 10);
    var frac = parts[1] ? parseInt((parts[1] + '0').slice(0, 2), 10) : 0;
    if (!isFinite(whole)) return null;
    return whole * MINOR + frac;
  }

  function fromMinor (n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var neg = n < 0;
    var v = Math.abs(Math.round(n));
    var whole = Math.floor(v / MINOR);
    var frac = v % MINOR;
    var s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (frac) s += '.' + String(frac).padStart(2, '0');
    return (neg ? '-' : '') + s;
  }

  /* ── settlement ──────────────────────────────────────────────────────────── */
  function settle (spec) {
    var totalMinor = spec && spec.totalMinor;
    if (typeof totalMinor !== 'number' || !isFinite(totalMinor) || totalMinor < 0) {
      throw new Error('settle() needs an authoritative totalMinor');
    }
    var tenders = (spec && spec.tenders) || [];

    var paid = 0, cash = 0;
    var clean = [];
    tenders.forEach(function (t) {
      if (!t || METHODS.indexOf(t.method) === -1) throw new Error('unknown payment method: ' + (t && t.method));
      var amt = typeof t.amountMinor === 'number' ? t.amountMinor : toMinor(t.amount);
      /* An unreadable or missing tender amount is NOT zero — it is a refusal. */
      if (typeof amt !== 'number' || !isFinite(amt) || amt < 0) throw new Error('unreadable amount for ' + t.method);
      amt = Math.round(amt);
      paid += amt;
      if (t.method === 'cash') cash += amt;
      clean.push({ method: t.method, amountMinor: amt });
    });

    var diff = paid - totalMinor;
    var balanceMinor = diff < 0 ? -diff : 0;
    var overMinor = diff > 0 ? diff : 0;

    /* Change can only come out of the drawer. */
    var changeMinor = Math.min(overMinor, cash);
    var unrefundableMinor = overMinor - changeMinor;

    var state = balanceMinor > 0 ? 'due' : (overMinor > 0 ? 'change' : 'exact');

    return {
      totalMinor: totalMinor,
      tenders: clean,
      paidMinor: paid,
      cashMinor: cash,
      balanceMinor: balanceMinor,
      changeMinor: changeMinor,
      unrefundableMinor: unrefundableMinor,
      state: state,
      /* A sale completes only when the money is all there. Nothing else in this
         module decides that, and nothing downstream should second-guess it. */
      canComplete: balanceMinor === 0 && clean.length > 0,
    };
  }

  /* ── what the merchant reads on screen ─────────────────────────────────── */
  function statusLine (s) {
    if (s.balanceMinor > 0) return { label: 'BALANCE', amount: fromMinor(s.balanceMinor), tone: 'due' };
    if (s.changeMinor > 0) return { label: 'CHANGE', amount: fromMinor(s.changeMinor), tone: 'change' };
    return { label: 'PAID', amount: fromMinor(s.totalMinor), tone: 'paid' };
  }

  /* ── the receipt payment block ─────────────────────────────────────────── */
  /* Records what ACTUALLY happened: every tender by method, then change where cash
     produced it. It never prints a change line for an M-PESA overpayment, because
     no change was given. */
  function receiptPayment (s) {
    var lines = s.tenders.map(function (t) {
      return { label: t.method.toUpperCase(), amount: fromMinor(t.amountMinor) };
    });
    /* TOTAL PAID only where it says something the lines above do not. On a single
       tender it merely repeats that line; on a SPLIT it is the figure a customer
       checks the sale against, and its absence is what makes a mixed-tender
       receipt hard to read. */
    if (s.tenders.length > 1) {
      lines.push({ label: 'TOTAL PAID', amount: fromMinor(s.paidMinor), strong: true });
    }
    if (s.changeMinor > 0) lines.push({ label: 'CHANGE', amount: fromMinor(s.changeMinor) });
    if (s.unrefundableMinor > 0) lines.push({ label: 'OVERPAID', amount: fromMinor(s.unrefundableMinor) });
    if (s.balanceMinor > 0) lines.push({ label: 'BALANCE DUE', amount: fromMinor(s.balanceMinor) });
    return { heading: 'PAYMENT', lines: lines };
  }

  global.SokoniCash = {
    METHODS: METHODS, MINOR: MINOR,
    toMinor: toMinor, fromMinor: fromMinor,
    settle: settle, statusLine: statusLine, receiptPayment: receiptPayment,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniCash;
}
