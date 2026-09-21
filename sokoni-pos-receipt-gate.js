/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI POS — RECEIPT ELIGIBILITY (pure)
   sokoni-pos-receipt-gate.js

   Decides whether a completed till transaction may print a FINAL SALE RECEIPT.

       A final receipt represents a completed financial sale,
       not merely an attempted payment.

   ── WHAT IT REPLACES ───────────────────────────────────────────────────────

       if (state.settings.autoPrint || payInfo.method === 'card')   // pos.js:1637

   Two problems, and the second is the larger one:

     · `|| method === 'card'` forces a print for card regardless of the
       merchant's own autoPrint setting. It is not unsafe — pos.js:1386 only
       reaches `payment.complete` when the terminal returned
       `status === 'approved'` — but it is an undocumented override of a
       merchant setting, and the owner has asked for it removed.

     · `autoPrint` alone prints for ANY method that reaches `payment.complete`,
       INCLUDING ones nothing has confirmed. `qr` has no branch in
       `payment.process()` (pos.js:1359-1411), so a cashier who selects Charge
       by QR, closes the modal and presses Charge falls through to the cash
       tail and completes a sale the QR rail never confirmed. A receipt then
       prints for money that has not arrived.

   ── WHAT AUTHORITY MEANS PER TENDER ────────────────────────────────────────

   Established by reading the live single-tender paths, not assumed:

     cash                 SETTLED. The cashier took the notes; the cashier is
                          the only authority cash has or can have. pos.js:1409
                          already refuses a tender below total.
     card                 SETTLED only with a terminal approval on the record.
                          pos.js:1381-1397 supplies cardAuthCode/cardRef from
                          `PosTerminals.payment.initiate` and only when it
                          returned `approved`.
     mpesa_till_manual    SETTLED. The customer paid the merchant's own M-PESA
                          Till directly; the money moved outside SOKONI and the
                          cashier attests a format-validated code
                          (pos.js:1802). This is the `recorded` kind of
                          Amendment A §A.7 — assertable by the cashier because
                          there is no other authority for it — and it stays
                          distinguishable from a payment WE initiated.
     anything else        NOT SETTLED at this point. Includes `qr`, whose real
                          confirmation is server-side in `completePOSQRPayment`
                          after `shared/intasend-verify`, and never reaches
                          this function.

   ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────

   It does not decide whether a SALE happened, does not touch payment state,
   and does not consult the network. It answers one question about a payInfo
   the till has already built. The multi-tender settlement authority
   (Amendment A) will eventually supply this answer from `settlementState`;
   until that is ratified and built, this reads the single-tender payInfo the
   till actually has.
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SPosReceiptGate = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Methods whose settlement authority is the cashier, and legitimately so. */
  const CASHIER_SETTLED = Object.freeze(['cash', 'mpesa_till_manual']);

  function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  /**
   * @param {object} payInfo  as built by pos.js payment.complete()
   * @param {object} [opts]   { total } — the sale total, when the caller has it
   * @returns {{ final:boolean, reason:string, slip:boolean }}
   *   final  may a FINAL SALE RECEIPT print
   *   slip   may a payment/transaction slip print instead (never a sale receipt)
   */
  function receiptEligibility(payInfo, opts) {
    const p = payInfo || {};
    const method = String(p.method || '').trim();
    if (!method) return { final: false, reason: 'No payment method on this transaction.', slip: false };

    /* ── SPLIT — final only if EVERY component is itself settled ───────────
       Checked first, because a split's `method` is 'split' and its parts are
       what decide it. The M-PESA leg of a split is currently unreachable
       (mpesa.sendSTK is retired, pos.js:1871), so in practice a split is
       cash-only — but the rule is written for the general case rather than
       for today's accident. */
    if (method === 'split') {
      const mpesaPart = _num(p.splitMpesa);
      if (mpesaPart > 0 && !p.mpesaRef) {
        return { final: false, slip: true,
          reason: 'The M-PESA part of this split is not confirmed yet.' };
      }
      return { final: true, slip: false, reason: 'Split settled.' };
    }

    /* ── CARD — a terminal approval must be ON THE RECORD ─────────────────
       pos.js only reaches complete() on `approved`, so the fields are present
       on every legitimate card sale. Requiring them here means a card payInfo
       assembled by some other path cannot inherit card's old free pass. */
    if (method === 'card') {
      const approved = !!(p.cardAuthCode || p.cardRef);
      return approved
        ? { final: true, slip: false, reason: 'Card approved by the terminal.' }
        : { final: false, slip: true, reason: 'No terminal approval on this card payment.' };
    }

    /* ── CASHIER-SETTLED ──────────────────────────────────────────────────
       A Till code must actually be present; the method name alone is not the
       attestation. pos.js validates its FORMAT before calling complete() — we
       require only that it survived to here. */
    if (CASHIER_SETTLED.indexOf(method) !== -1) {
      if (method === 'mpesa_till_manual' && !p.mpesaRef) {
        return { final: false, slip: true,
          reason: 'No M-PESA confirmation code recorded for this sale.' };
      }
      /* Cash short of the total is refused upstream (pos.js:1409). If one
         reaches here anyway, it is not a completed sale. */
      if (method === 'cash' && opts && Number.isFinite(Number(opts.total))) {
        if (_num(p.amountPaid) + 1e-9 < Number(opts.total)) {
          return { final: false, slip: true, reason: 'Cash tendered is less than the total.' };
        }
      }
      return { final: true, slip: false, reason: 'Settled at the till.' };
    }

    /* ── EVERYTHING ELSE ──────────────────────────────────────────────────
       Default DENY, and say which method it was. `qr` lands here: its real
       confirmation happens server-side and never reaches this function, so a
       till-side receipt for it would assert a payment nobody verified. */
    return { final: false, slip: true,
      reason: 'Payment by "' + method + '" is not confirmed at the till.' };
  }

  /**
   * The whole decision, merchant setting included.
   * autoPrint is a PREFERENCE about an eligible receipt — it can suppress a
   * final receipt, and it can never authorise one.
   */
  function shouldPrintFinal(payInfo, opts) {
    const e = receiptEligibility(payInfo, opts);
    const autoPrint = !!(opts && opts.autoPrint);
    return { print: e.final && autoPrint, eligibility: e };
  }

  return { CASHIER_SETTLED, receiptEligibility, shouldPrintFinal };
}));
