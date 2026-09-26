'use strict';
/**
 * The payment-provider fee, from what IntaSend REPORTED on the payment.
 *
 *   charges                         → the fee, when IntaSend reports it
 *   value − net_amount              → the fee, when both are reported
 *   otherwise                       → UNKNOWN (cents: null)
 *
 * An unknown fee is never assumed to be zero: every consumer that settles money on a
 * NET_OF_PROVIDER_FEE basis must withhold settlement until the fee is known or attested.
 * Shared by Creator Hub royalty accrual and Event ticket settlement so the two cannot drift.
 */
function providerFee(payment) {
  const rep = (payment && payment.providerReport) || {};
  const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const charges = rep.charges == null ? null : toCents(rep.charges);
  if (charges != null && charges >= 0) return { cents: charges, source: 'provider_charges' };
  const value = rep.value == null ? null : toCents(rep.value);
  const net = rep.netAmount == null ? null : toCents(rep.netAmount);
  if (value != null && net != null && value >= net) return { cents: value - net, source: 'provider_value_minus_net' };
  return { cents: null, source: 'unreported' };
}

module.exports = { providerFee };
