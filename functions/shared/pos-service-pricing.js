'use strict';
/**
 * SOKONI POS — SERVICE BASKET PRICING (pure core)
 * functions/shared/pos-service-pricing.js
 *
 * A till should not care whether it is selling a phone charger, ten printed
 * pages, a haircut, a car wash or a government application. They are all a
 * priced line on one sale. This module prices that basket.
 *
 * ── NO NEW COLLECTION ───────────────────────────────────────────────────────
 *
 * A service is a `posProducts` row with `trackStock: false` — a shape pos.js
 * already understands (pos.js:3104 excludes them from low-stock alerts). It
 * carries a `unit` ("page", "document", "session") and may be marked
 * `variablePrice`. Inventing a `posServices` collection would fork the
 * catalogue, and every reader — search, reports, receipts, the marketplace
 * sync — would have to learn about the second one.
 *
 * ── THE THREE PRICE SOURCES, NEVER CONFLATED ────────────────────────────────
 *
 * This is the whole integrity property of the module. Every line records WHERE
 * its figure came from, and the three are distinguishable forever after:
 *
 *   catalogue     the server read the price from posProducts. The cashier
 *                 chose an item; they did not choose an amount.
 *   variable      the item is marked variablePrice (typing, repairs,
 *                 consultancy) so the cashier names the unit price, bounded.
 *   quick_charge  no catalogue item at all — a described, one-off charge.
 *
 * A reconciliation that cannot tell a catalogue price from a keyed-in one
 * cannot answer "did the cashier overcharge?", which is the question a till
 * exists to make answerable.
 *
 * ── WHY A CASHIER MAY NAME A PRICE AT ALL ───────────────────────────────────
 *
 * Everywhere else on this rail the server derives the amount and the CLIENT is
 * refused — because there the client is the BUYER, and a buyer naming their own
 * price is the B1 defect. Here the client is the MERCHANT'S OWN AUTHORIZED
 * OPERATOR charging their own customer. That is the same trust boundary
 * `priceTillSale` already uses (sokoni-qr-authority.js:240): the cashier's price
 * entry is the existing authority, not a new one.
 *
 * It is still BOUNDED, ATTRIBUTED and LABELLED. Bounded by a per-merchant
 * ceiling so a mistyped 50000 cannot leave the till; attributed to the cashier
 * uid so it is answerable; labelled `quick_charge` so it is never mistaken for
 * a catalogue figure.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 *
 * No Firestore, no network, no clock. The caller loads the catalogue and the
 * merchant's limits and passes them in. Same discipline as money-authority.js,
 * and for the same reason: a money path cannot be certified while it is
 * entangled with writes.
 */

/* Provider floor/ceiling — mirrors payment-purposes so this cannot mint an
   intent the gateway will refuse. */
const MIN_KES = 1;
const MAX_KES = 150000;

/* A quick charge is a keyed-in figure. Absent an explicit merchant setting it
   is capped hard, because the safe default for "how much may a cashier invent"
   is not "as much as the gateway allows". A merchant who needs more raises it
   deliberately. */
const DEFAULT_QUICK_CHARGE_MAX_CENTS = 2000000;   /* KES 20,000 — PER BASKET, all quick-charge lines together */

const MAX_LINES = 100;
const MAX_QTY   = 9999;

function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const _san = (v, max) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);

/* Inlined rather than required from shared/business-scope.js so this module
   stays dependency-free and therefore trivially pure. The two must agree; a
   test asserts they do, against the real module. */
function _mayTrade(scope, kind) {
  if (kind === 'product') return !!(scope && scope.sellsProducts);
  if (kind === 'service') return !!(scope && scope.providesServices);
  return false;
}

/**
 * Price one basket.
 *
 * @param {object}   o
 * @param {Array}    o.lines        [{ itemId?, qty?, unitPriceKES?, description? }]
 * @param {object}   o.catalogue    { [itemId]: posProductsDoc } — caller-loaded
 * @param {string}   o.callerUid    who is operating the till
 * @param {string}   o.merchantUid  who owns it
 * @param {object}  [o.limits]      { quickChargeEnabled, quickChargeMaxCents }
 * @param {object}  [o.scope]       from shared/business-scope.js. When supplied,
 *                                  each line is checked against what this
 *                                  business is APPROVED to trade. Omitted ⇒ not
 *                                  enforced, so existing callers are unchanged.
 * @returns {{ amountCents, lines, counts }}
 */
function priceServiceBasket({ lines, catalogue, callerUid, merchantUid, limits, scope }) {
  /* ── Trust boundary. Same one priceTillSale enforces. A basket whose prices
     are partly cashier-named is only meaningful from the till's own operator;
     from anyone else it is a stranger naming what they will pay. ── */
  if (!callerUid || !merchantUid || String(callerUid) !== String(merchantUid)) {
    throw _err('permission-denied', 'Not authorized to sell on this till.');
  }

  if (!Array.isArray(lines) || !lines.length) throw _err('invalid-argument', 'The basket is empty.');
  if (lines.length > MAX_LINES) throw _err('invalid-argument', 'Too many line items.');

  const cat = catalogue || {};
  const quickEnabled  = !(limits && limits.quickChargeEnabled === false);
  const quickMaxCents = Math.max(0, Math.round(
    Number(limits && limits.quickChargeMaxCents) || DEFAULT_QUICK_CHARGE_MAX_CENTS));

  const out = [];
  const counts = { catalogue: 0, variable: 0, quick_charge: 0 };
  let subtotalCents = 0;
  /* The quick-charge ceiling is a PER-BASKET cap on the SUM of keyed-in figures. It used to be
     checked per line, so 100 lines of KES 20,000 (KES 2,000,000) passed a KES 20,000 limit:
     the cap bounded one typo, not the amount a cashier could invent on one sale. */
  let quickTotalCents = 0;

  lines.forEach((raw, i) => {
    const line = raw || {};
    /* ABSENT qty defaults to 1; an explicit 0 is REFUSED.
       `Number(line.qty) || 1` collapsed the two, so a line the cashier had
       zeroed out charged for one of it — the customer pays for something the
       till was told to drop. Absent and zero are different statements and the
       `||` idiom cannot tell them apart. */
    const qty = (line.qty === undefined || line.qty === null || line.qty === '')
      ? 1
      : Math.round(Number(line.qty));
    if (!Number.isFinite(qty) || !(qty >= 1 && qty <= MAX_QTY)) {
      throw _err('invalid-argument', `Line ${i + 1}: quantity must be between 1 and ${MAX_QTY}.`);
    }

    const itemId = _san(line.itemId, 120);

    /* ── QUICK CHARGE ─────────────────────────────────────────────────────
       No catalogue item. The cashier describes it and names the amount. */
    if (!itemId) {
      if (!quickEnabled) throw _err('permission-denied', 'Quick charge is disabled on this till.');
      /* A quick charge is NOT scoped to products or services, because it is
         neither — it is a described one-off (a delivery fee, a government
         application, a callout). Demanding service scope would stop a shop
         charging for delivery; demanding product scope is nonsense. What it
         DOES require is that the business be approved to trade at all, so a
         suspended account cannot keep billing through the free-text field. */
      if (scope && !scope.isTrading) {
        throw _err('permission-denied', 'This business is not currently approved to take payments.');
      }

      const description = _san(line.description, 140);
      /* A charge nobody can identify later is a hole in the books, so the
         description is REQUIRED rather than defaulted to "Service". */
      if (!description) throw _err('invalid-argument', `Line ${i + 1}: a quick charge needs a description.`);

      const unitCents = Math.round(Number(line.unitPriceKES) * 100);
      if (!Number.isFinite(unitCents) || unitCents <= 0) {
        throw _err('invalid-argument', `"${description}" needs a valid amount.`);
      }
      const lineCents = unitCents * qty;
      quickTotalCents += lineCents;
      if (quickTotalCents > quickMaxCents) {
        throw _err('failed-precondition',
          `Quick charges on this sale total KES ${(quickTotalCents / 100).toLocaleString()}, over this till's quick-charge limit of KES ${(quickMaxCents / 100).toLocaleString()} per sale.`);
      }

      subtotalCents += lineCents;
      counts.quick_charge++;
      out.push({
        itemId: null, name: description, unit: _san(line.unit, 24) || null,
        qty, unitCents, lineCents,
        priceSource: 'quick_charge',
        /* Attribution rides on the LINE, not just the sale, because a basket
           may mix catalogue and keyed-in figures and only some of them are
           anybody's judgement call. */
        authorizedBy: String(callerUid),
      });
      return;
    }

    /* ── CATALOGUE ITEM ───────────────────────────────────────────────────── */
    const item = cat[itemId];
    if (!item) throw _err('not-found', `Line ${i + 1}: this item is no longer in the catalogue.`);
    if (item.active === false) throw _err('failed-precondition', `"${item.name || itemId}" is no longer offered.`);

    const name = _san(item.name, 140) || itemId;
    const unit = _san(item.unit, 24) || null;

    let unitCents;
    let priceSource;

    if (item.variablePrice === true) {
      /* The merchant has declared this one priced at the counter — a repair
         quote, an hour of consultancy. The cashier names it, bounded by the
         same ceiling a quick charge gets, because it is the same act. */
      const named = Math.round(Number(line.unitPriceKES) * 100);
      if (!Number.isFinite(named) || named <= 0) {
        throw _err('invalid-argument', `"${name}" is priced at the counter — enter an amount.`);
      }
      if (named * qty > quickMaxCents) {
        throw _err('failed-precondition',
          `"${name}" exceeds this till's counter-pricing limit of KES ${(quickMaxCents / 100).toLocaleString()}.`);
      }
      unitCents = named;
      priceSource = 'variable';
      counts.variable++;
    } else {
      /* THE SERVER'S OWN FIGURE. `line.unitPriceKES` is IGNORED here — not
         validated against, ignored. A fixed-price item whose price could be
         overridden by the request is not a fixed-price item. */
      unitCents = Math.round(Number(item.price) * 100);
      if (!Number.isFinite(unitCents) || unitCents <= 0) {
        throw _err('failed-precondition', `"${name}" has no price set.`);
      }
      priceSource = 'catalogue';
      counts.catalogue++;
    }

    /* ── SCOPE. A business bills only what it was APPROVED to trade.
       A services-only provider must not start selling stock by posting a
       product row, and a products-only shop must not bill for labour it was
       never approved to provide — the two have different tax and consumer
       treatment, and a business that quietly does both leaves SOKONI unable to
       report what it actually earned.

       `trackStock` is the discriminator already in the catalogue: a stocked
       row is a PRODUCT, an unstocked row is a SERVICE. Enforced only when a
       scope is supplied, so callers that predate it are unaffected. ── */
    if (scope) {
      const kind = item.trackStock === false ? 'service' : 'product';
      if (!_mayTrade(scope, kind)) {
        throw _err('permission-denied',
          kind === 'service'
            ? `"${name}" is a service, and this business is not approved to provide services.`
            : `"${name}" is a product, and this business is not approved to sell products.`);
      }
    }

    const lineCents = unitCents * qty;
    subtotalCents += lineCents;
    out.push({
      itemId, name, unit, qty, unitCents, lineCents, priceSource,
      /* A counter-priced line is a judgement call and is attributed. A
         catalogue line is not — attributing it would imply the cashier chose
         the figure when the catalogue did. */
      authorizedBy: priceSource === 'variable' ? String(callerUid) : null,
      trackStock: item.trackStock !== false,
    });
  });

  if (!(subtotalCents > 0)) throw _err('failed-precondition', 'This sale has no payable amount.');
  const kes = subtotalCents / 100;
  if (kes < MIN_KES || kes > MAX_KES) {
    throw _err('failed-precondition', 'Amount is outside the payable range.');
  }

  return { amountCents: subtotalCents, lines: out, counts };
}

module.exports = {
  priceServiceBasket,
  MIN_KES, MAX_KES, MAX_LINES, MAX_QTY,
  DEFAULT_QUICK_CHARGE_MAX_CENTS,
};
