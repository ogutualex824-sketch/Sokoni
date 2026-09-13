'use strict';
/**
 * WHO THE BUYER IS PAYING.
 *
 * Every customer-facing transaction surface must name the shop the buyer is
 * buying from, and name SOKONI as the platform handling it — shop first,
 * platform second. This module is the ONE place that decides what that shop is
 * called, so the M-PESA narrative, the checkout page and anything added later
 * cannot drift into three different answers.
 *
 * THE AUTHORITY CHAIN, and why it is not negotiable:
 *
 *   products/{id}.sellerUid   proves who owns the product   (the ONLY ownership
 *                             authority — order.sellerUid is BUYER-written)
 *   shops/{sellerUid}.name    is what that seller is called
 *
 * Both are read SERVER-side. A shop name supplied by the cashier, the browser,
 * the URL, localStorage, sessionStorage or payment metadata is never consulted,
 * because a buyer-facing identity that the buyer's own client can influence
 * proves nothing about who receives the money.
 *
 * FAIL CLOSED. If the shop cannot be resolved — no seller, several sellers, or a
 * shop with no name — this returns `resolved: false` and NO name. It must never
 * fall back to a uid, a shop id, a payment ref or "SOKONI Merchant". Telling a
 * buyer they are paying KASS SHOP when the transaction belongs to another shop
 * is worse than telling them nothing, and a technical identifier shown as a
 * merchant name is how that starts.
 */

/** Gateway narrative fields are short and the buyer reads this on a phone. */
const MAX_NAME = 60;

/** The canonical display name on a shops/{uid} document, or null. */
function displayNameOf(shop) {
  if (!shop || typeof shop !== 'object') return null;
  /* store.html resolves a storefront heading as `name || storeName`; the same
     precedence is used here so the buyer sees at checkout what they saw on the
     storefront. businessName is the older spelling, kept for un-migrated shops. */
  const raw = shop.name || shop.storeName || shop.businessName || null;
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_NAME) : null;
}

function unresolved(reason) {
  return { v: 1, resolved: false, name: null, sellerUid: null, authority: 'unresolved', reason };
}

/**
 * Resolve the shop identity for a basket.
 *
 * @param {string[]} sellerUids  distinct sellerUids, from products/{id}.sellerUid
 * @param {object}   shopState   sellerUid -> shops/{uid} document (already read
 *                               by the basket pricer; no extra Firestore reads)
 * @returns {{v,resolved,name,sellerUid,authority,reason}}
 */
function resolveMerchantIdentity(sellerUids, shopState) {
  const uids = [...new Set((Array.isArray(sellerUids) ? sellerUids : []).filter(Boolean))];

  if (uids.length === 0) return unresolved('no_seller_resolved');
  /* A multi-seller basket has no single merchant to name. Naming one of them
     would be a lie about the other; naming "SOKONI" would hide both. Neither
     rail can produce this today (the marketplace purpose refuses multi-seller
     baskets outright), so this is a guard, not a live case. */
  if (uids.length > 1) return unresolved('multiple_sellers');

  const sellerUid = uids[0];
  const name = displayNameOf(shopState && shopState[sellerUid]);
  if (!name) return unresolved('shop_has_no_name');

  return { v: 1, resolved: true, name, sellerUid, authority: `shops/${sellerUid}.name`, reason: null };
}

/**
 * The one buyer-facing string SOKONI controls on the M-PESA prompt.
 *
 * The PIN dialog itself belongs to Safaricom and cannot be styled, branded or
 * laid out by us — this narrative is the whole of our influence over what the
 * buyer reads on the handset. It previously carried the payment REF
 * ("SOKONI: SKN-1234…"), which tells the buyer nothing about who is being paid.
 *
 * ── WHY THE AMOUNT IS NOT IN HERE ────────────────────────────────────────────
 * Safaricom's dialog already renders "Pay Ksh <amount> to …" itself, from the
 * figure in the request. Repeating it would spend the few characters we own on
 * something the buyer is already reading, and a second amount that ever
 * disagreed with the authoritative one would be worse than no amount at all.
 * What the buyer cannot otherwise tell is WHO they are paying. That is what this
 * string is for.
 *
 * ── WHY IT DEGRADES FROM THE RIGHT ───────────────────────────────────────────
 * Gateways truncate. The order is therefore SHOP, then platform, then corporate
 * identity: if the field is clipped the buyer still reads the shop name, which is
 * the part that answers "am I paying the right person?". Losing "a product of
 * Bravilex" off the end costs nothing; losing the shop name would cost the whole
 * purpose of the string.
 */

/** Identity lines, longest first. `budget` picks the longest one that survives. */
const SUFFIX = Object.freeze({
  /* The buyer's own checkout. They chose the shop, so the shop leads. */
  online: [
    ' · Powered by SOKONI · a product of Bravilex',
    ' · Powered by SOKONI · Bravilex',
    ' · Powered by SOKONI',
    ' · SOKONI',
  ],
  /* At a till the buyer is standing in the shop and already knows where they
     are; what reassures them is that the rail handling their money is a named
     platform, not an anonymous paybill. */
  till: [
    ' Till · Powered by SOKONI · a product of Bravilex',
    ' Till · Powered by SOKONI · Bravilex',
    ' Till · Powered by SOKONI',
    ' Till · SOKONI',
  ],
});

/* Generous by gateway standards and deliberately not a guess at Safaricom's own
   limit: the point of the ladder above is that we degrade on OUR terms before
   anybody else truncates on theirs. */
const MAX_NARRATIVE = 100;

function narrativeFor(identity, opts) {
  const channel = (opts && opts.channel) === 'till' ? 'till' : 'online';
  /* Unresolved means we could not prove who receives the money. Naming a shop we
     are not sure about is the one failure this module exists to prevent, so the
     buyer gets the platform and its owner and no merchant claim at all. */
  if (!identity || !identity.resolved || !identity.name) {
    return 'SOKONI · a product of Bravilex';
  }
  const name = identity.name;
  for (const suffix of SUFFIX[channel]) {
    if (name.length + suffix.length <= MAX_NARRATIVE) return name + suffix;
  }
  /* A shop name long enough to crowd out every suffix keeps the name: the buyer
     needs to know who they are paying more than they need our branding. */
  return name.slice(0, MAX_NARRATIVE);
}

module.exports = {
  displayNameOf, resolveMerchantIdentity, narrativeFor,
  MAX_NAME, MAX_NARRATIVE, SUFFIX,
};
