'use strict';
/* ============================================================================
   MEMBERSHIP OFFER — a gym publishes membership offers IN ITS PROVIDER SERVICES (owner decision 2026-10-03)
   ----------------------------------------------------------------------------
   A membership offer is an ordinary providerServices/{serviceId} record (the gym's existing services list) with:
     serviceKind  'membership'      — NEW field; no kind/type field existed (priceType is a pricing MODE, not a kind)
     periodCount  integer 1..60     — number of months
     periodUnit   'month'           — the only unit decided (membership-settlement slices months)
     price        integer CENTS     — the EXISTING field, written by provider-ops `_cents` exactly as for any service
   plus the existing providerId / name / active / removedAt / priceType.

   PURE. No Firestore, no firebase-admin. Used by:
     • fitness-membership-create.js — validateMembershipOffer() on the server-read record before a membership is created
     • provider-ops (sokoni-5b's providerDispatch reconciliation release) — applyToServiceWrite() hook in the writers,
       isMembershipOffer() in bookingCreateService. NOT wired on this branch (docs/FITNESS_MEMBERSHIP_ATTENDANCE.md §10).

   Money: price is already integer cents (provider-ops `_cents`; booking-service prices `Math.round(Number(svc.price))`).
   This validator REFUSES rather than coerces: a non-integer, missing, zero or negative price is not an offer. It must be
   WHOLE SHILLINGS within payment-purposes MIN_KES..MAX_KES, because priceFor rounds to KES and holdMembershipPayment
   requires paid KES × 100 === priceCents — a cents remainder would park every payment in payment_review.
   ============================================================================ */

const KIND = 'membership';
const PERIOD_UNIT = 'month';
const MIN_PERIODS = 1;
const MAX_PERIODS = 60;
const MIN_PRICE_CENTS = 1 * 100;          /* payment-purposes MIN_KES */
const MAX_PRICE_CENTS = 150000 * 100;     /* payment-purposes MAX_KES */
const PRICE_TYPES = Object.freeze(['fixed']);   /* absent is read as fixed; 'hourly' / 'quotation' are not a membership */

const REASONS = Object.freeze({
  missing: 'Membership offer not found.',
  not_membership: 'This service is not a membership offer.',
  inactive: 'This membership offer is not available.',
  no_provider: 'This membership offer has no provider.',
  bad_title: 'This membership offer has no name.',
  bad_period: 'A membership must run for a whole number of months between 1 and 60.',
  bad_unit: 'Memberships are sold in months.',
  bad_price_type: 'A membership must have a fixed price.',
  bad_price: 'A membership must have a fixed price in whole shillings (KES 1 – 150,000).',
  bad_kind: 'Unknown service kind.',
});
const no = (reason) => ({ ok: false, reason, message: REASONS[reason] });

const isMembershipOffer = (doc) => !!(doc && doc.serviceKind === KIND);

function _title(v) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * validateMembershipOffer(doc) → { ok:true, providerId, priceCents, periodCount, periodUnit, title }
 *                              | { ok:false, reason, message }
 * `doc` is the SERVER-READ providerServices record. Nothing from a request is ever passed in.
 */
function validateMembershipOffer(doc) {
  if (!doc || typeof doc !== 'object') return no('missing');
  if (!isMembershipOffer(doc)) return no('not_membership');
  if (doc.active === false || doc.removedAt) return no('inactive');
  if (typeof doc.providerId !== 'string' || !doc.providerId) return no('no_provider');
  const title = _title(doc.name);
  if (!title) return no('bad_title');
  if ((doc.periodUnit == null ? PERIOD_UNIT : doc.periodUnit) !== PERIOD_UNIT) return no('bad_unit');
  const n = doc.periodCount;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_PERIODS || n > MAX_PERIODS) return no('bad_period');
  if (doc.priceType != null && !PRICE_TYPES.includes(doc.priceType)) return no('bad_price_type');
  if (doc.pricing && typeof doc.pricing === 'object' && Object.keys(doc.pricing).length) return no('bad_price_type');  /* rate cards price slots, not memberships */
  const p = doc.price;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < MIN_PRICE_CENTS || p > MAX_PRICE_CENTS || p % 100 !== 0) return no('bad_price');
  return { ok: true, providerId: doc.providerId, priceCents: p, periodCount: n, periodUnit: PERIOD_UNIT, title };
}

/**
 * Writer hook for provider-ops (sokoni-5b's providerDispatch release — NOT wired on this branch).
 *   mode     'create' (providerAddService) | 'update' (providerUpdateService) | 'duplicate' (providerDuplicateService)
 *   input    the request data `d` as the writer received it (ignored for 'duplicate': the copy keeps the source's kind)
 *   existing null on create; the current record on update; the SOURCE record on duplicate
 *   out      the object the writer is about to write — the full new doc (create/duplicate) or the update patch.
 *            MUTATED: serviceKind / periodCount / periodUnit / priceType are set on it. `price` stays the writer's own
 *            `_cents` output; nothing here touches money.
 * → { ok:true } | { ok:false, reason, message } — on ok:false the writer throws invalid-argument with `message`.
 * The RESULTING record (existing ⊕ patch on update) is validated whenever it is a membership, so a provider can never
 * save a membership offer that the purchase path would refuse (price 0 / cents remainder / 61 months / quotation).
 * A membership's priceType is always 'fixed' (providerAddService defaults an absent priceType to 'quotation').
 * Editing an offer NEVER changes a membership already created from it: the membership holds its own snapshot.
 */
function applyToServiceWrite(mode, input, existing, out) {
  const d = mode === 'duplicate' ? {} : (input || {});
  const prev = existing || {};
  if (d.serviceKind !== undefined && d.serviceKind !== KIND && d.serviceKind !== null && d.serviceKind !== '') return no('bad_kind');
  let kind;
  if (mode === 'create') kind = d.serviceKind === KIND ? KIND : null;
  else if (mode === 'update') kind = d.serviceKind !== undefined ? (d.serviceKind === KIND ? KIND : null) : (prev.serviceKind === KIND ? KIND : null);
  else if (mode === 'duplicate') kind = prev.serviceKind === KIND ? KIND : null;
  else return no('bad_kind');

  if (kind !== KIND) {
    if (d.periodCount !== undefined || d.periodUnit !== undefined) return no('not_membership');
    if (mode === 'update' && prev.serviceKind === KIND) out.serviceKind = null;     /* explicit un-kind of an offer */
    return { ok: true };
  }
  if (d.periodUnit !== undefined && d.periodUnit !== PERIOD_UNIT) return no('bad_unit');
  out.serviceKind = KIND;
  out.periodUnit = PERIOD_UNIT;
  out.priceType = 'fixed';
  const rawN = mode === 'duplicate' ? prev.periodCount : d.periodCount;
  if (rawN !== undefined) out.periodCount = typeof rawN === 'number' ? rawN : (String(rawN).trim() === '' ? NaN : Number(rawN));
  const merged = mode === 'update' ? Object.assign({}, prev, out) : out;
  const v = validateMembershipOffer(Object.assign({}, merged, { active: true, removedAt: null }));
  return v.ok ? { ok: true } : v;
}

module.exports = {
  KIND, PERIOD_UNIT, MIN_PERIODS, MAX_PERIODS, MIN_PRICE_CENTS, MAX_PRICE_CENTS, REASONS,
  isMembershipOffer, validateMembershipOffer, applyToServiceWrite,
};
