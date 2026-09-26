'use strict';
/**
 * SOKONI — CANONICAL DISPUTE IDENTITY
 * functions/dispute-identity.js
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 * One dispute, four vocabularies. createDispute wrote `buyerId`/`sellerId`; the served rules check
 * `uid`/`buyerUid`/`sellerUid` (so no rule ever matched a real dispute); impact.js queries
 * `sellerUid`; wallet.js queries `sellerId`; the email trigger addresses `customerId`, a field no
 * dispute carries; automation reads `dispute.type` where the field is `reason`. And the ownership
 * check accepted only `buyerId`/`userId`/`customerId` — while ALL 10 production orders carry
 * `buyerUid`/`uid` and NONE of those three — so no real buyer could open a dispute.
 *
 * ── THE CANONICAL NAMES ─────────────────────────────────────────────────────────────────
 * A dispute carries exactly:   buyerUid · sellerUid · shopId · reason
 * — the names the ORDERS already use in production (10/10 carry buyerUid and sellerUid) and the
 * names the served rules already check. The writer converges on the rules, not the reverse.
 * No dispute is ever written with buyerId / sellerId / uid / customerId / type again. Production
 * holds ZERO disputes (measured 2026-09-26), so there is no legacy document to migrate or to read.
 *
 * ── ONE BUYER, BY PRECEDENCE — never "any field that matches" ───────────────────────────
 * Orders were written by several writers, so an ORDER's buyer may be named in any of these fields,
 * and they can DISAGREE: after the KASS account merge, pre-merge orders carry uid = the DEPRECATED
 * account and buyerUid = the canonical one. "Any field matches" would let the deprecated account
 * act as the buyer. So the buyer is resolved to ONE uid, most-authoritative field first:
 *     buyerUid → buyerId → userId → customerId → uid
 * The seller likewise:  sellerUid → sellerId → vendorId
 * (Order data is NOT rewritten — this reads the aliases the orders actually carry.)
 */

const BUYER_FIELDS = Object.freeze(['buyerUid', 'buyerId', 'userId', 'customerId', 'uid']);
const SELLER_FIELDS = Object.freeze(['sellerUid', 'sellerId', 'vendorId']);

const _first = (o, fields) => {
  for (const f of fields) {
    const v = o && o[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};

/** The order's buyer: ONE uid, by precedence. null when the order names no buyer. */
function orderBuyerUid(order) { return _first(order, BUYER_FIELDS); }

/** The order's seller: ONE uid, by precedence. null when the order names no seller. */
function orderSellerUid(order) { return _first(order, SELLER_FIELDS); }

/** Is `uid` the buyer of this order? Exactly one identity qualifies. */
function isOrderBuyer(order, uid) {
  const b = orderBuyerUid(order);
  return !!uid && !!b && b === String(uid);
}

module.exports = { BUYER_FIELDS, SELLER_FIELDS, orderBuyerUid, orderSellerUid, isOrderBuyer };
