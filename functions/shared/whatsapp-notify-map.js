'use strict';
/**
 * notify type → approved WhatsApp template (owner 2026-10-01: all transactional, server-triggered only)
 * ================================================================================================
 * PURE: no Firestore, no clock, no network. notify.js asks ONE question — "may THIS notification go by
 * WhatsApp, and with exactly which template parameters?" — and this module answers it or returns null.
 *
 * WHATSAPP REPLACES AN SMS, NEVER ADDS ONE. Only types that already carry an smsTemplate are listed here:
 * notify.js tries WhatsApp at the moment it would have sent that SMS, and sends the SMS only if WhatsApp
 * was not accepted. A type absent from this map keeps its exact current behaviour.
 *
 * PARAMETERS COME FROM THE CALLER'S EXISTING SMS vars (sms-service.js TEMPLATES) — the same values the SMS
 * would have carried — plus the account name the server read. Nothing is rewritten into a different
 * meaning: an amount that is not a plain KES figure is left undefined, the sender refuses it (BAD_PARAM),
 * and the message goes by SMS. Fail closed means "fall back", never "send something approximate".
 *
 * Template names and parameter keys MUST match shared/whatsapp-templates.js (test M1 enforces it).
 */

/* 'KES 1,200' | '1200' | 1200 → '1,200'. Anything else → undefined (the template says "KES {{n}}"). */
function kes (v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(/^(?:KES|KSh|Ksh)?\s*([\d,]+(?:\.\d{1,2})?)$/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-KE', { maximumFractionDigits: 2 }) : undefined;
}
const str = (v) => (v == null || v === '' ? undefined : String(v));

const MAP = Object.freeze({
  otp:                  { template: 'otp_code',           params: (v) => ({ code: str(v.code) }) },
  phone_verification:   { template: 'otp_code',           params: (v) => ({ code: str(v.code) }) },
  payment_verification: { template: 'otp_code',           params: (v) => ({ code: str(v.code) }) },
  order_placed:         { template: 'order_confirmation', params: (v, n) => ({ name: n, orderRef: str(v.orderId), amountKES: kes(v.total) }) },
  payment_success:      { template: 'payment_received',   params: (v, n) => ({ name: n, amountKES: kes(v.amount), paymentRef: str(v.ref) }) },
  payment_failed:       { template: 'payment_failed',     params: (v, n) => ({ name: n, paymentRef: str(v.ref) }) },
  refund_processed:     { template: 'refund_processed',   params: (v, n) => ({ name: n, orderRef: str(v.orderId), amountKES: kes(v.amount) }) },
  order_dispatched:     { template: 'delivery_started',   params: (v, n) => ({ name: n, orderRef: str(v.orderId) }) },
  order_delivered:      { template: 'order_completed',    params: (v, n) => ({ name: n, orderRef: str(v.orderId) }) },
});

/** resolve(type, vars, name) → { template, params } | null (null = this type never goes by WhatsApp). */
function resolve (type, vars, name) {
  const e = Object.prototype.hasOwnProperty.call(MAP, type) ? MAP[type] : null;
  if (!e) return null;
  return { template: e.template, params: e.params(vars || {}, str(name) || 'there') };
}

/* The name the template greets: the account's own display name, trimmed to one plain line. */
function displayName (u) {
  const raw = u && (u.displayName || u.name || u.firstName);
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 60);
  return s || undefined;
}

module.exports = { MAP, resolve, kes, displayName };
