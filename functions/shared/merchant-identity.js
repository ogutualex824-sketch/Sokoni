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
 * ── WHY THE AMOUNT IS IN HERE ────────────────────────────────────────────────
 * An earlier revision left it out, reasoning that Safaricom's dialog renders
 * "Pay Ksh <amount> to …" itself and that repeating it would spend the few
 * characters we own on something the buyer is already reading. SOKONI decided
 * otherwise, and the decision stands: a person approving money should be ASKED,
 * in words, for a stated figure — "Please approve a payment of KES 4,566" — not
 * handed a bare merchant string. The amount here is always the server-validated
 * one, so it cannot disagree with what is actually charged.
 *
 * ── WHY IT DEGRADES FROM THE RIGHT ───────────────────────────────────────────
 * Gateways truncate. The ladder therefore sheds OUR branding first, then shortens
 * the courtesy, and only drops the amount when the shop's own name has consumed
 * the whole line — so a clipped field still reads as the shop asking for a sum,
 * which is the part that answers "am I paying the right person, the right
 * amount?". Losing "a product of Bravilex" off the end costs nothing.
 */

/* ── SYMBOLS THE HANDSET CAN ACTUALLY DRAW ───────────────────────────────────
   The prompt is rendered by the SIM toolkit, not by a browser. Characters in the
   Basic Multilingual Plane have a real chance of appearing; anything above
   U+FFFF — which is where 🛍️ 💰 📲 and most colour emoji live — needs a
   surrogate pair the toolkit generally cannot draw, and arrives as boxes or
   garbles the line. A garbled PAYMENT prompt is not a cosmetic problem: it is
   the moment a buyer decides whether to trust the transaction.

   So the mark used here is BMP, and `sanitiseForHandset` below REMOVES anything
   astral no matter where it came from. The full colour-emoji treatment belongs
   on the in-app panel, which is a browser and can draw it. */
const MARK = '✔';           /* ✔ — BMP, widely drawable */
const DOT = ' · ';          /* · — Latin-1 */

/**
 * Strip what the handset cannot render, so a payment prompt can never be
 * corrupted by a character somebody added upstream in good faith.
 */
function sanitiseForHandset(s) {
  return String(s == null ? '' : s)
    /* Astral plane: emoji, most pictographs. Surrogate pairs, unrenderable by the toolkit. */
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    /* Variation selectors, ZWJ and keycaps left behind once the emoji itself is gone. */
    .replace(/[\uFE00-\uFE0F\u200D\u20E3]/g, '')
    /* Control characters. Written as escapes on purpose: a literal NUL in this file would
       make git call it binary and hide every future change to payment copy from review. */
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const kes = (n) => 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-KE');

/**
 * ONE CHANNEL FOR POS AND TILL, deliberately.
 *
 * A SmartPOS sale and a till sale are the same event to the person paying:
 * they are standing in the shop, being served, and are asked to approve an
 * amount. Giving the two rails separate copy would let them drift until the same
 * customer, in the same shop, reads two different things depending on which
 * device the attendant happened to pick up. `pos` therefore RESOLVES to `till`
 * rather than getting a format of its own.
 */
function channelOf(raw) {
  const c = String(raw || '').toLowerCase();
  return (c === 'till' || c === 'pos' || c === 'smartpos' || c === 'terminal') ? 'till' : 'online';
}

/* Each ladder runs longest-first and the first line that fits is used, so the
   buyer gets the most informative version their shop name leaves room for. */
function lines(channel, name, amount) {
  const here = channel === 'till' ? name + ' Till' : name;
  /* THE ASK IS THE LAST THING TO GO. A buyer approving money should be ASKED, in words, for a
     stated figure — "Please approve a payment of KES 4,566" — not handed a bare total. So the
     ladder sheds our branding first, then shortens the courtesy, and only drops the amount when
     the shop's own name has consumed the whole line. */
  const askFull = amount ? 'Please approve a payment of ' + amount : 'Please approve this payment';
  const askShort = amount ? 'Please approve ' + amount : 'Please approve';
  return [
    MARK + ' ' + here + DOT + askFull + DOT + 'Powered by SOKONI, a product of Bravilex',
    MARK + ' ' + here + DOT + askFull + DOT + 'Powered by SOKONI' + DOT + 'Bravilex',
    MARK + ' ' + here + DOT + askFull + DOT + 'Powered by SOKONI',
    here + DOT + askFull + DOT + 'Powered by SOKONI',
    here + DOT + askFull + DOT + 'SOKONI',
    here + DOT + askShort + DOT + 'SOKONI',
    here + DOT + (amount || '') + DOT + 'SOKONI',
    here + DOT + 'SOKONI',
    here,
  ];
}

/* Generous by gateway standards and deliberately not a guess at Safaricom's own
   limit: the point of the ladder is that we degrade on OUR terms before anybody
   else truncates on theirs. */
const MAX_NARRATIVE = 100;

/**
 * @param {object} identity  from resolveMerchantIdentity
 * @param {object} [opts]    { channel: 'online'|'till'|'pos', amountKES }
 */
function narrativeFor(identity, opts) {
  const o = opts || {};
  const channel = channelOf(o.channel);
  const amount = (Number(o.amountKES) > 0) ? kes(o.amountKES) : null;

  /* Unresolved means we could not prove who receives the money. Naming a shop we
     are not sure about is the one failure this module exists to prevent, so the
     buyer gets the platform, its owner, the amount they are approving — and no
     merchant claim at all. */
  if (!identity || !identity.resolved || !identity.name) {
    const base = amount
      ? MARK + ' SOKONI' + DOT + 'Please approve a payment of ' + amount + DOT + 'a product of Bravilex'
      : 'SOKONI' + DOT + 'a product of Bravilex';
    return sanitiseForHandset(base).slice(0, MAX_NARRATIVE);
  }

  const name = sanitiseForHandset(identity.name);
  for (const line of lines(channel, name, amount)) {
    const clean = sanitiseForHandset(line);
    if (clean.length <= MAX_NARRATIVE) return clean;
  }
  /* A shop name long enough to crowd out every line keeps the name: the buyer
     needs to know who they are paying more than they need our branding. */
  return name.slice(0, MAX_NARRATIVE);
}

module.exports = {
  displayNameOf, resolveMerchantIdentity, narrativeFor,
  sanitiseForHandset, channelOf,
  MAX_NAME, MAX_NARRATIVE, MARK,
};
