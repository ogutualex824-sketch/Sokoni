'use strict';

/**
 * SOKONI PURCHASE GATE AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * Between "a guest wants this" and "a buyer owns it".
 *
 * A supplying domain — the streaming catalogue, a marketplace listing, a ticketed event —
 * says WHAT is for sale and at what price. This branch owns everything between that and a
 * confirmed purchase attached to a real account:
 *
 *     identity · buyer account · payment intent · IntaSend · provider confirmation ·
 *     purchase attachment
 *
 * It does NOT own entitlement. What a buyer may then watch, attend or download is the
 * consuming domain's question, and this module hands it a confirmed purchase reference
 * and stops.
 *
 * ── THE PRICE IS NEVER THE BROWSER'S ─────────────────────────────────────────
 * An offer is RESOLVED from a registered source, never accepted from a request. A browser
 * that could name the price could buy a thirty-day film for one shilling.
 *
 * No source is registered for `stream` on this branch, because the streaming catalogue
 * lives on another branch entirely. A stream purchase therefore REFUSES with
 * NO_OFFER_SOURCE rather than falling back to whatever the request carried. That refusal
 * is the correct behaviour and the honest one: the machinery is here, the catalogue is
 * not, and inventing a price to make the flow appear finished would be the worst possible
 * way to close the gap.
 *
 * ── NOTHING IS OWNED UNTIL THE PROVIDER SAYS SO ──────────────────────────────
 * A purchase reaches the consuming domain only from ATTACHED, and ATTACHED is reachable
 * only through PROVIDER_CONFIRMED. There is no path from a browser saying "it worked".
 */

const IDENTITY = require('./payment-identity-authority');

/* ── THE LIFE OF A PURCHASE ──────────────────────────────────────────────────── */
const STATE = Object.freeze({
  /* A guest has chosen something. No account, no money, no obligation. */
  SELECTED: 'SELECTED',
  /* Identity is being established — the conversion point. */
  IDENTITY_PENDING: 'IDENTITY_PENDING',
  /* A real buyer now owns this purchase-to-be. */
  BUYER_RESOLVED: 'BUYER_RESOLVED',
  /* SOKONI has created the authoritative intent; IntaSend has the amount. */
  INTENT_CREATED: 'INTENT_CREATED',
  /* The PROVIDER said the money moved. The only gateway to ownership. */
  PROVIDER_CONFIRMED: 'PROVIDER_CONFIRMED',
  /* Bound to the buyer, and only now may a consuming domain hear about it. */
  ATTACHED: 'ATTACHED',

  /* Ends. */
  ABANDONED: 'ABANDONED',
  REFUSED: 'REFUSED',
  FAILED: 'FAILED',
});

const ALLOWED = Object.freeze({
  [STATE.SELECTED]: Object.freeze([STATE.IDENTITY_PENDING, STATE.ABANDONED]),
  [STATE.IDENTITY_PENDING]: Object.freeze([STATE.BUYER_RESOLVED, STATE.REFUSED, STATE.ABANDONED]),
  [STATE.BUYER_RESOLVED]: Object.freeze([STATE.INTENT_CREATED, STATE.ABANDONED]),
  [STATE.INTENT_CREATED]: Object.freeze([STATE.PROVIDER_CONFIRMED, STATE.FAILED, STATE.ABANDONED]),
  [STATE.PROVIDER_CONFIRMED]: Object.freeze([STATE.ATTACHED]),
  /* A provider failure may be retried from a created intent — the money never moved. */
  [STATE.FAILED]: Object.freeze([STATE.INTENT_CREATED, STATE.ABANDONED]),
  /* Terminal. A purchase that could be re-attached could be delivered twice. */
  [STATE.ATTACHED]: Object.freeze([]),
  [STATE.ABANDONED]: Object.freeze([]),
  [STATE.REFUSED]: Object.freeze([]),
});

/** The one state from which a consuming domain may be told anything. */
const HANDOFF_STATE = STATE.ATTACHED;

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ── 1. WHERE AN OFFER COMES FROM ────────────────────────────────────────────
 *
 * A registry of domains that can answer "what is this, and what does it cost". A domain
 * registers a resolver; nothing else may name a price.
 *
 * Deliberately a registry rather than a switch: the supplying domains live on other
 * branches, and a switch here would either import them (impossible) or hardcode their
 * prices (unforgivable).
 */
const _sources = Object.create(null);

function registerOfferSource(kind, resolver) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return refuse('NO_KIND');
  if (typeof resolver !== 'function') return refuse('NO_RESOLVER');
  _sources[k] = resolver;
  return { ok: true, kind: k };
}

function offerSourceFor(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return refuse('NO_KIND');
  const r = _sources[k];
  if (!r) {
    /* NAMED, NOT GUESSED. The caller learns which domain has not registered, so the gap
       is actionable rather than a mysterious failure at checkout. */
    return refuse('NO_OFFER_SOURCE', k);
  }
  return { ok: true, kind: k, resolver: r };
}

/* Test seam and audit surface: which kinds can currently be sold. */
function registeredKinds() { return Object.keys(_sources).sort(); }
function _clearSources() { Object.keys(_sources).forEach((k) => { delete _sources[k]; }); }

/* ── 2. WHAT AN OFFER MUST LOOK LIKE ─────────────────────────────────────────
   Validated whatever the source, so a badly-behaved domain cannot introduce a price of
   zero, a negative duration or a floating-point amount. */
const MAX_DURATION_DAYS = 365;

function validateOffer(offer) {
  const o = isPlainObject(offer) ? offer : {};

  const kind = String(o.kind || '').trim().toLowerCase();
  if (!kind) return refuse('NO_KIND');

  const ref = String(o.ref || '').trim();
  if (!ref) return refuse('NO_REF');

  /* MINOR UNITS, INTEGER. A float price is refused rather than rounded: rounding is a
     decision about somebody's money and this is not the place to make it. */
  const minor = o.amountMinor;
  if (typeof minor !== 'number' || !Number.isInteger(minor)) return refuse('AMOUNT_NOT_MINOR_UNITS');
  if (minor <= 0) return refuse('AMOUNT_NOT_POSITIVE');

  const currency = String(o.currency || '').trim().toUpperCase();
  if (!currency) return refuse('NO_CURRENCY');

  /* Access duration, where the offer grants time-limited access. Absent is legitimate —
     a physical good is not rented — but zero or negative is a mistake. */
  let durationDays = null;
  if (o.durationDays !== undefined && o.durationDays !== null) {
    const d = Number(o.durationDays);
    if (!Number.isFinite(d) || !Number.isInteger(d)) return refuse('DURATION_NOT_INTEGER');
    if (d <= 0) return refuse('DURATION_NOT_POSITIVE');
    if (d > MAX_DURATION_DAYS) return refuse('DURATION_TOO_LONG', String(MAX_DURATION_DAYS));
    durationDays = d;
  }

  return {
    ok: true,
    offer: {
      kind, ref,
      amountMinor: minor,
      currency,
      durationDays,
      title: o.title ? String(o.title).slice(0, 200) : null,
      /* WHO IS OWED. Carried so settlement can find them; never used as an identity. */
      sellerId: o.sellerId ? String(o.sellerId) : null,
      creatorId: o.creatorId ? String(o.creatorId) : null,
      /* Recorded so a stored purchase can prove which offer it was made against. */
      offerVersion: o.offerVersion ? String(o.offerVersion) : null,
    },
  };
}

/**
 * THE PRICE MAY NEVER ARRIVE IN A REQUEST.
 *
 * Asserted against the raw request rather than trusted, because this is the single
 * highest-value thing a hostile buyer could send: a thirty-day film for one shilling.
 */
const REQUEST_MAY_NOT_CARRY = Object.freeze([
  'amountMinor', 'amount', 'price', 'priceMinor', 'total', 'totalMinor',
  'currency', 'durationDays', 'expiresAt', 'entitlement', 'entitled',
]);

function assertRequestNamesNoPrice(request) {
  const r = isPlainObject(request) ? request : {};
  const found = REQUEST_MAY_NOT_CARRY.filter((k) => Object.prototype.hasOwnProperty.call(r, k));
  if (found.length) return refuse('REQUEST_NAMES_ITS_OWN_TERMS', found.join(','));
  return { ok: true };
}

/* ── 3. THE MOVES ────────────────────────────────────────────────────────────── */
function canTransition(from, to) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!ALLOWED[f]) return refuse('UNKNOWN_STATE', f);
  if (!ALLOWED[t] && t !== '') return refuse('UNKNOWN_TARGET', t);
  if (ALLOWED[f].indexOf(t) === -1) return refuse('ILLEGAL_TRANSITION', f + ' -> ' + t);
  return { ok: true, from: f, to: t, terminal: ALLOWED[t].length === 0 };
}

/**
 * Is this purchase owned yet?
 *
 * The single question every consuming domain must ask, and the reason it is a function
 * rather than a field: a field can be written by anything that can write the document.
 */
function isOwned(purchase) {
  const p = isPlainObject(purchase) ? purchase : {};
  return p.state === STATE.ATTACHED &&
         !!p.buyerUid &&
         !!p.providerConfirmedAt &&
         !!p.providerRef;
}

/* ── 4. WHAT THE CONSUMING DOMAIN IS TOLD ────────────────────────────────────
 *
 * The handoff. Deliberately small: the reference, who owns it, what was bought, and the
 * provider's own confirmation identifiers.
 *
 * It carries NO entitlement, NO expiry and NO grant. Computing when access ends is the
 * consuming domain's decision from the duration it published — if this module issued an
 * expiry, there would be two authorities on when a film stops playing.
 */
function handoff(purchase) {
  const p = isPlainObject(purchase) ? purchase : {};

  if (!isOwned(p)) {
    /* THE GATE. Anything short of a confirmed, attached purchase is refused, and the
       reason names what is missing rather than a bare no. */
    const why = p.state !== STATE.ATTACHED ? 'NOT_ATTACHED'
      : !p.providerConfirmedAt ? 'NOT_PROVIDER_CONFIRMED'
      : !p.buyerUid ? 'NO_BUYER'
      : 'NO_PROVIDER_REFERENCE';
    return refuse('NOT_OWNED', why);
  }

  return {
    ok: true,
    purchase: {
      purchaseId: p.purchaseId || null,
      buyerUid: p.buyerUid,
      kind: p.offer && p.offer.kind,
      ref: p.offer && p.offer.ref,
      durationDays: (p.offer && p.offer.durationDays) || null,
      offerVersion: (p.offer && p.offer.offerVersion) || null,

      /* THE PROVIDER'S OWN WORDS. A consuming domain that wants to check for itself can. */
      providerRef: p.providerRef,
      providerConfirmedAt: p.providerConfirmedAt,
      /* What ACTUALLY paid, resolved from the confirmation — never from the checkout. */
      method: p.confirmedMethod || null,
    },
  };
}

/* Fields a handoff must never carry, asserted rather than promised. An entitlement in
   this payload would let a consuming domain skip its own authority. */
const HANDOFF_MAY_NOT_CARRY = Object.freeze([
  'entitlement', 'entitlementId', 'expiresAt', 'grant', 'accessToken',
  'playbackUrl', 'signedUrl', 'amountMinor', 'phone', 'email',
]);

/* ── 5. WHOSE PURCHASE IS IT ─────────────────────────────────────────────────
   A confirmation names a payer. Binding it to the wrong buyer is how one person's
   payment unlocks another person's library. */
function assertBuyerMatches(purchase, confirmedBuyerUid) {
  const p = isPlainObject(purchase) ? purchase : {};
  const c = String(confirmedBuyerUid || '').trim();
  if (!p.buyerUid) return refuse('PURCHASE_HAS_NO_BUYER');
  if (!c) return refuse('NO_CONFIRMED_BUYER');
  if (String(p.buyerUid) !== c) {
    return refuse('BUYER_MISMATCH', p.buyerUid + ' != ' + c);
  }
  return { ok: true, buyerUid: c };
}

module.exports = {
  STATE, ALLOWED, HANDOFF_STATE, MAX_DURATION_DAYS,
  REQUEST_MAY_NOT_CARRY, HANDOFF_MAY_NOT_CARRY,
  registerOfferSource, offerSourceFor, registeredKinds, _clearSources,
  validateOffer, assertRequestNamesNoPrice, canTransition, isOwned, handoff,
  assertBuyerMatches,
  /* Re-exported so a caller cannot reach for a different identity contract. */
  IDENTITY,
};
