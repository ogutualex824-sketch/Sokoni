/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI POS — MIXED BASKET (pure)
   sokoni-pos-basket.js

   One basket, three kinds of line:

       USB Flash Disk        800     catalogue · product
       Printing x 10         200     catalogue · service
       Scanning x 2          100     catalogue · service
       Passport assistance   750     quick charge · custom service
       ─────────────────────────
       TOTAL               1,850

   A cyber cafe sells a flash disk and prints ten pages in the same
   transaction. To the cashier it is one sale. To reconciliation it is three
   different things, and this module is what keeps them distinguishable.

   ── IT DOES NOT PRICE THE SALE ─────────────────────────────────────────────

   The total here is for the CASHIER'S EYES. The authoritative figure comes
   from `pos_service_sale` → `shared/pos-service-pricing.js`, which re-reads
   every catalogue price from posProducts and re-checks the quick-charge
   ceiling against the merchant's own settings. A basket total that disagreed
   with the server's would be a display bug; a basket total the server TRUSTED
   would be the B1 defect all over again, from the till instead of the browser.

   `toPricingRequest()` is the seam: it emits exactly the `lines[]` shape that
   pricer already accepts, and deliberately emits NO total.

   ── THIS SLICE STOPS BEFORE THE MONEY ──────────────────────────────────────

   Nothing here creates a payment intent, takes a tender or marks anything
   paid. The basket is prepared and totalled; the live-money path
   (completeMultiTender → server sale record → IntaSend → webhookIntasend) is
   a separate, separately certified slice.

   ── BACKWARD COMPATIBLE ────────────────────────────────────────────────────

   pos.js's existing `state.cartItems` lines carry no `source` and no `kind`.
   They are catalogue PRODUCTS — that is all the till could add until now — so
   an absent source reads as 'catalogue' and an absent kind as 'product'. Every
   line already in a live till keeps its meaning.
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SPosBasket = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SOURCE = Object.freeze({ CATALOGUE: 'catalogue', QUICK: 'quick_charge' });
  const KIND   = Object.freeze({ PRODUCT: 'product', SERVICE: 'service' });

  /* ── Classification ─────────────────────────────────────────────────────
     Absent means the old shape, which was always a catalogue product. */
  function sourceOf(line) {
    return (line && line.source === SOURCE.QUICK) ? SOURCE.QUICK : SOURCE.CATALOGUE;
  }
  function kindOf(line) {
    if (!line) return KIND.PRODUCT;
    if (line.kind === KIND.SERVICE) return KIND.SERVICE;
    if (line.kind === KIND.PRODUCT) return KIND.PRODUCT;
    /* A quick charge with no kind is a custom SERVICE charge — it is work
       done, not stock moved. Stated rather than inferred, because the
       distinction drives revenue classification. */
    if (sourceOf(line) === SOURCE.QUICK) return KIND.SERVICE;
    /* Fall back to the catalogue's own discriminator, matching
       shared/pos-service-pricing.js exactly: absent trackStock is a PRODUCT. */
    return line.trackStock === false ? KIND.SERVICE : KIND.PRODUCT;
  }
  const isQuick   = (l) => sourceOf(l) === SOURCE.QUICK;
  const isService = (l) => kindOf(l) === KIND.SERVICE;
  const isProduct = (l) => kindOf(l) === KIND.PRODUCT;

  /** What the cashier is told this line is. */
  function labelFor(line) {
    if (isQuick(line)) return 'Custom service charge';
    return isService(line) ? 'Service' : 'Product';
  }

  /* ── Money (display only) ───────────────────────────────────────────────
     Integer cents, converted once, for the same reason money-authority.js
     gives. Math.round(x * 100), never Math.round(x) * 100. */
  function toCents(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function qtyOf(line) {
    const q = (line && (line.qty !== undefined && line.qty !== null && line.qty !== ''))
      ? Math.round(Number(line.qty)) : 1;
    return Number.isFinite(q) && q > 0 ? q : 0;
  }
  function lineCents(line) {
    return toCents(line && line.price) * qtyOf(line);
  }

  /**
   * Subtotal in cents. DISPLAY ONLY — see the header.
   * Tax and discount are deliberately NOT computed here: pos.js already owns
   * those (cart.getTax, cart.getDiscountAmount) and a second implementation
   * would drift from the one the till has always used.
   */
  function subtotalCents(lines) {
    return (lines || []).reduce((s, l) => s + lineCents(l), 0);
  }

  /* ── Grouping for the till display ──────────────────────────────────────
     Products first, then services, then custom charges — the order a cashier
     reads a receipt in, and the order that keeps ad-hoc charges visible at the
     bottom rather than buried between catalogue lines. */
  function groups(lines) {
    const all = lines || [];
    const g = [
      { key: 'products', label: 'Products',        lines: all.filter((l) => isProduct(l) && !isQuick(l)) },
      { key: 'services', label: 'Services',        lines: all.filter((l) => isService(l) && !isQuick(l)) },
      { key: 'custom',   label: 'Custom charges',  lines: all.filter(isQuick) },
    ];
    return g.filter((x) => x.lines.length)
            .map((x) => Object.assign(x, { subtotalCents: subtotalCents(x.lines) }));
  }

  /** Counts by source/kind — what reconciliation and reporting need. */
  function census(lines) {
    const all = lines || [];
    return {
      total:        all.length,
      products:     all.filter((l) => isProduct(l) && !isQuick(l)).length,
      services:     all.filter((l) => isService(l) && !isQuick(l)).length,
      quickCharges: all.filter(isQuick).length,
      isMixed: all.some((l) => isProduct(l) && !isQuick(l)) &&
               all.some((l) => isService(l) || isQuick(l)),
    };
  }

  /* ── Quick charge ───────────────────────────────────────────────────────
     A described, cashier-attributed, one-off charge. Everything the server
     will re-check is checked here too, so the cashier is told immediately —
     but the SERVER remains authoritative for all of it.

     THE CEILING IS NOT DUPLICATED. This module holds no limit of its own: a
     frontend that knew the number would become a second authority for it, and
     the two would drift the first time a merchant's setting changed. The
     server refuses what is over the line; the UI can pass a merchant-supplied
     figure through purely to warn EARLY, and says so. */
  function validateQuickCharge(d, opts) {
    d = d || {};
    const problems = [];
    const description = String(d.description == null ? '' : d.description).trim();
    if (!description) problems.push('Say what the charge is for.');
    if (description.length > 140) problems.push('That description is too long.');

    const cents = toCents(d.amountKES);
    if (!(cents > 0)) problems.push('Enter an amount greater than zero.');

    const q = qtyOf({ qty: d.qty === undefined ? 1 : d.qty });
    if (!(q > 0)) problems.push('Quantity must be at least 1.');

    /* Advisory only, and only when the caller supplies the merchant's own
       figure. Absent, nothing is asserted — silence here is NOT approval. */
    const ceiling = opts && Number(opts.advisoryCeilingCents);
    if (Number.isFinite(ceiling) && ceiling > 0 && cents * q > ceiling) {
      problems.push('That is above this till\'s limit — the server will refuse it.');
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Build a quick-charge basket line.
   * `cashierUid` is required: an unattributed custom charge is a figure nobody
   * can be asked about later, and pos_service_sale attributes it server-side
   * regardless — recording it here keeps the till's own record honest.
   */
  function quickChargeLine(d, cashierUid) {
    const v = validateQuickCharge(d);
    if (!v.ok) throw new Error(v.problems[0]);
    if (!cashierUid) throw new Error('A quick charge must be attributed to a cashier.');
    const qty = d.qty === undefined ? 1 : qtyOf({ qty: d.qty });
    return {
      /* Prefixed so it can never collide with a posProducts id, and unique so
         two different custom charges in one basket do not merge the way two
         scans of the same product do. */
      id: 'qc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: String(d.description).trim(),
      price: Number(d.amountKES),
      qty,
      unit: String(d.unit || '').trim() || null,
      source: SOURCE.QUICK,
      kind: KIND.SERVICE,
      authorizedBy: String(cashierUid),
      customerPhone: d.customerPhone ? String(d.customerPhone).trim() : null,
      /* No taxRate. The till's tax settings apply to catalogue lines whose
         rate the catalogue declares; inventing one for an ad-hoc charge would
         put a tax figure on the receipt that nothing authorised. */
    };
  }

  /* ── The seam to the server ─────────────────────────────────────────────
     Exactly the `lines[]` shape shared/pos-service-pricing.js accepts. No
     total is emitted — the server computes it, and a total sent from here
     would be a number the server had to decide whether to trust. */
  function toPricingRequest(lines) {
    return (lines || []).map((l) => (
      isQuick(l)
        ? { description: l.name, unitPriceKES: Number(l.price), qty: qtyOf(l),
            unit: l.unit || undefined }
        : { itemId: l.id, qty: qtyOf(l),
            /* A counter-priced catalogue service carries the cashier's figure;
               a fixed one does not, and the server ignores it either way. */
            ...(l.variablePrice === true ? { unitPriceKES: Number(l.price) } : {}) }
    ));
  }

  /** Formatting helper, so the till and the console agree on one style. */
  function fmtKES(cents) {
    return 'KES ' + ((Number(cents) || 0) / 100)
      .toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return {
    SOURCE, KIND,
    sourceOf, kindOf, isQuick, isService, isProduct, labelFor,
    toCents, qtyOf, lineCents, subtotalCents,
    groups, census,
    validateQuickCharge, quickChargeLine,
    toPricingRequest, fmtKES,
  };
}));
