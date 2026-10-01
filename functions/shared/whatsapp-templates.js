'use strict';
/**
 * SOKONI — WhatsApp template registry (owner 2026-10-01)
 * =====================================================
 * The ONLY templates SOKONI may send over the WhatsApp Cloud API. A send names a template that must exist
 * here; the parameters must be exactly the declared keys. The server picks the template from a real
 * event and resolves the recipient — a browser never chooses either (the SMS-template hole must not be
 * reproduced on WhatsApp).
 *
 * Each entry MUST match the template the owner creates and Meta approves in WhatsApp Manager:
 *   name      — the template name, identical
 *   lang      — the approved language code
 *   category  — authentication | utility | marketing (Meta billing + rules differ)
 *   params    — body variables {{1}}..{{n}} IN ORDER
 *   secret    — true for codes (OTP / completion PIN): parameters are passed to Meta and NEVER stored,
 *               logged or queued anywhere (sokoni-70's constraint from the completion-PIN work)
 *   button    — 'copy_code' for authentication templates: Meta requires the code again as the button param
 *
 * Owner policy (2026-10-01): ALL transactional messages may use WhatsApp, server-triggered only.
 */
const TEMPLATES = Object.freeze({
  /* authentication — codes; secret */
  completion_pin:             { lang: 'en', category: 'authentication', params: ['code'], secret: true, button: 'copy_code' },
  otp_code:                   { lang: 'en', category: 'authentication', params: ['code'], secret: true, button: 'copy_code' },

  /* utility — orders & payments */
  order_confirmation:         { lang: 'en', category: 'utility', params: ['name', 'orderRef', 'amountKES'] },
  payment_received:           { lang: 'en', category: 'utility', params: ['name', 'amountKES', 'paymentRef'] },
  payment_failed:             { lang: 'en', category: 'utility', params: ['name', 'paymentRef'] },
  order_ready:                { lang: 'en', category: 'utility', params: ['name', 'orderRef'] },
  order_completed:            { lang: 'en', category: 'utility', params: ['name', 'orderRef'] },

  /* utility — delivery */
  delivery_started:           { lang: 'en', category: 'utility', params: ['name', 'orderRef'] },
  delivery_arriving:          { lang: 'en', category: 'utility', params: ['name', 'orderRef', 'eta'] },

  /* utility — refunds */
  refund_pending:             { lang: 'en', category: 'utility', params: ['name', 'orderRef', 'amountKES'] },
  refund_processed:           { lang: 'en', category: 'utility', params: ['name', 'orderRef', 'amountKES'] },

  /* utility — sellers */
  seller_new_order:           { lang: 'en', category: 'utility', params: ['shopName', 'orderRef', 'amountKES'] },
  seller_return_request:      { lang: 'en', category: 'utility', params: ['shopName', 'orderRef'] },

  /* utility — bookings */
  booking_confirmation:       { lang: 'en', category: 'utility', params: ['name', 'service', 'when'] },
  booking_reminder:           { lang: 'en', category: 'utility', params: ['name', 'service', 'when'] },
  booking_cancelled:          { lang: 'en', category: 'utility', params: ['name', 'service', 'when'] },

  /* utility — invoices & receipts */
  invoice_issued:             { lang: 'en', category: 'utility', params: ['name', 'invoiceRef', 'amountKES'] },
  foundation_donation_receipt:{ lang: 'en', category: 'utility', params: ['name', 'amountKES', 'receiptRef'] },
});

function get (name) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, name) ? TEMPLATES[name] : null;
}

module.exports = { TEMPLATES, get };
