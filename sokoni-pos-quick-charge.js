/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI POS — QUICK CHARGE
   sokoni-pos-quick-charge.js

   A described, cashier-attributed custom service charge, added to the CURRENT
   SALE alongside catalogue products and catalogue services.

   ── WHAT IT DOES, AND WHERE IT STOPS ───────────────────────────────────────

   It adds ONE LINE to the basket. It does not create a payment intent, take a
   tender, contact IntaSend or mark anything paid. The line is priced with
   every other line by the server, through pos_service_sale, when the sale is
   eventually charged — and that slice is separately gated.

   ── THE CEILING IS NOT HERE ────────────────────────────────────────────────

   The merchant's quick-charge limit lives in posSettings and is enforced by
   shared/pos-service-pricing.js. This file names no number. Where the till
   already holds the merchant's own figure it is passed through purely to warn
   the cashier EARLY — and its absence asserts nothing, because silence from a
   UI is not approval from a server.

   ── ATTRIBUTION IS NOT OPTIONAL ────────────────────────────────────────────

   An unattributed custom charge is a figure nobody can be asked about later.
   The server attributes it regardless; recording it at the till keeps the
   local record honest, and the add is REFUSED if no cashier can be resolved.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function _basket() { return window.SPosBasket || null; }

  /* Who is on the till. Resolved from what the POS already knows — this file
     introduces no new notion of a cashier, and refuses rather than guessing. */
  function _cashierUid() {
    try {
      const S = window.SPos;
      return (S && S.state && (
        (S.state.currentCashier && (S.state.currentCashier.uid || S.state.currentCashier.id)) ||
        S.state.cashierId || S.state.cashierUid
      )) || (window.firebase && window.firebase.auth &&
             window.firebase.auth().currentUser && window.firebase.auth().currentUser.uid) || null;
    } catch (_) { return null; }
  }

  /* The merchant's own ceiling, if the till happens to have loaded settings.
     Never defaulted — an absent figure means "we do not know", and we then
     warn about nothing and let the server decide. */
  function _advisoryCeilingCents() {
    try {
      const s = window.SPos && window.SPos.state && window.SPos.state.settings;
      const v = s && (s.quickChargeMaxCents !== undefined ? s.quickChargeMaxCents : undefined);
      return Number.isFinite(Number(v)) ? Number(v) : null;
    } catch (_) { return null; }
  }

  function _warn(msg) {
    const el = $('qc-warn');
    if (!el) return;
    if (msg) { el.textContent = msg; el.classList.add('on'); }
    else { el.textContent = ''; el.classList.remove('on'); }
  }

  function open() {
    const B = _basket();
    if (!B) { _toast('Basket engine not loaded — refresh the till.', 'error'); return; }
    if (!_cashierUid()) {
      _toast('Sign in to the till before adding a custom charge.', 'error');
      return;
    }
    $('qc-desc').value = '';
    $('qc-amount').value = '';
    $('qc-qty').value = '1';
    /* Pre-fill from the selected customer when there is one — the cashier
       should not retype a number the till already holds. */
    try {
      const c = window.SPos && window.SPos.state && window.SPos.state.currentCustomer;
      $('qc-phone').value = (c && c.phone) || '';
    } catch (_) { $('qc-phone').value = ''; }
    _warn(null);
    window.SPos.modal.open('qc-modal');
    setTimeout(() => { try { $('qc-desc').focus(); } catch (_) {} }, 80);
  }

  function add() {
    const B = _basket();
    if (!B) return;

    const draft = {
      description:   $('qc-desc').value,
      amountKES:     $('qc-amount').value,
      qty:           $('qc-qty').value,
      customerPhone: $('qc-phone').value,
    };

    /* The server's quick-charge limit is PER SALE (the sum of every quick charge in the basket),
       so the advisory warns against what REMAINS after the quick charges already in this cart —
       otherwise the till would happily build a basket the server then refuses. Still advisory:
       the server decides. */
    let ceiling = _advisoryCeilingCents();
    if (ceiling) {
      try {
        const cart = (window.SPos && window.SPos.state && window.SPos.state.cartItems) || [];
        const usedCents = cart
          .filter((l) => l && l.source === B.SOURCE.QUICK)
          .reduce((s, l) => s + Math.round(Number(l.price) * 100) * (Number(l.qty) || 1), 0);
        ceiling = Math.max(0, ceiling - usedCents);
      } catch (_) { /* advisory only — fall back to the whole ceiling */ }
    }
    const v = B.validateQuickCharge(draft, ceiling ? { advisoryCeilingCents: ceiling } : undefined);
    if (!v.ok) { _warn(v.problems.join(' ')); return; }

    const uid = _cashierUid();
    if (!uid) { _warn('No cashier is signed in — a custom charge must be attributable.'); return; }

    let line;
    try { line = B.quickChargeLine(draft, uid); }
    catch (e) { _warn((e && e.message) || 'Could not add that charge.'); return; }

    /* Into the SAME basket as everything else. One sale, one total, one
       eventual server pricing call — the whole point of the mixed basket. */
    try {
      window.SPos.cart.addCustomLine(line);
    } catch (e) {
      _warn('Could not add to the sale: ' + ((e && e.message) || 'unknown error'));
      return;
    }

    window.SPos.modal.close('qc-modal');
    _toast('Added: ' + line.name, 'success');
  }

  function _toast(m, k) {
    if (window.SPos && typeof window.SPos.toast === 'function') return window.SPos.toast(m, k || 'info');
    console.warn('[quick-charge]', m);
  }

  window.SPosQuickCharge = { open, add };
}());
