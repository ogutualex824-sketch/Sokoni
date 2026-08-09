'use strict';
/**
 * SOKONI eTIMS — Canonical Tax Engine (SINGLE SOURCE OF TRUTH)
 * ===========================================================================
 * PURE: no Firestore, no I/O, no clock, no side effects → deterministic and
 * fully unit-testable. This module converges the three previously-divergent VAT
 * implementations (functions/etims.js, functions/hub-etims.js, root etims.js)
 * onto ONE model so the same sale can never produce two different tax figures.
 *
 * Model (matches the DEPLOYED seller path, functions/etims.js calcLine/calcTotals):
 *   - Prices are VAT-INCLUSIVE.
 *   - Category A = standard-rated (default 16%): taxblAmt = net / (1 + rate);
 *     taxAmt = net − taxblAmt.
 *   - Category B = zero-rated: taxblAmt = net, taxAmt = 0.
 *   - Category C = exempt:     taxblAmt = 0,  taxAmt = 0.
 *   - Round HALF-UP to 2 dp at each monetary step (`r2`), identical to the
 *     deployed `_r2` so delegating from etims.js is byte-for-byte behaviour-
 *     preserving (proven by scripts/test-etims-tax-engine.js).
 *
 * The standard RATE and KRA category CODES are configuration (DEFAULTS below), so
 * the exact values can be confirmed against KRA's official spec WITHOUT touching
 * the math. Nothing here invents KRA protocol behaviour.
 *
 * @module etims-tax-engine
 * @version 1.0.0
 */

const DEFAULTS = Object.freeze({
  vatRate: 0.16,
  catStandard: 'A',
  catZero: 'B',
  catExempt: 'C',
  classCodeDefault: '57111500',
  /* inclusive=true  → prices already contain VAT (seller path, KRA VSCU default).
     inclusive=false → VAT is added on top of the price (legacy hub path).
     WHICH ONE KRA REQUIRES PER FLOW IS A KRA-SPEC DECISION — isolated here as a
     config point so both flows share ONE engine while the policy stays pending
     official validation. Do not hardcode a choice elsewhere. */
  inclusive: true,
});

/* Round half-up to 2dp — EXACTLY the deployed etims.js `_r2` (do not "improve" with
   EPSILON: it must match the live path bit-for-bit so convergence is behaviour-safe). */
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* Map a business VAT status to a KRA vat category code. */
function vatCategoryFor(vatStatus, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (vatStatus === 'registered' || vatStatus === 'standard' || vatStatus === 'vat') return cfg.catStandard;
  if (vatStatus === 'zero_rated' || vatStatus === 'zero')                            return cfg.catZero;
  return cfg.catExempt;   // exempt / unregistered / unknown → exempt (safest: no VAT claimed)
}

/* Compute a single invoice line. Returns the KRA line shape used by the submitters. */
function computeLine(item, vatStatus, config) {
  const cfg  = { ...DEFAULTS, ...(config || {}) };
  const qty  = Number(item.quantity) || 1;
  const prc  = Number(item.unitPrice) || 0;
  const dcRt = Number(item.discountRate) || 0;
  const sply = r2(qty * prc);
  const dcAmt = r2(sply * dcRt / 100);
  const net  = r2(sply - dcAmt);

  const cat = vatCategoryFor(vatStatus, cfg);
  const inclusive = cfg.inclusive !== false;
  let taxblAmt, taxAmt;
  if (cat === cfg.catStandard) {
    if (inclusive) { taxblAmt = r2(net / (1 + cfg.vatRate)); taxAmt = r2(net - taxblAmt); }
    else           { taxblAmt = net;                          taxAmt = r2(net * cfg.vatRate); }
  } else if (cat === cfg.catZero) { taxblAmt = net; taxAmt = 0; }
  else                            { taxblAmt = 0;   taxAmt = 0; }
  /* Inclusive: the price already holds the VAT, so the line total IS net.
     Exclusive: VAT is added, so the line total is net + tax. */
  const totAmt = inclusive ? net : r2(net + taxAmt);

  return {
    itemSeq:   item.seq || 1,
    itemClsCd: item.itemClassCode || cfg.classCodeDefault,
    itemNm:    String(item.name || 'Item').slice(0, 100),
    pkgUnitCd: 'NT', pkg: qty, qtyUnitCd: 'U', qty,
    prc, splyAmt: sply, dcRt, dcAmt, vatCatCd: cat, taxblAmt, taxAmt, totAmt,
  };
}

/* Aggregate line totals into the KRA A–E buckets + grand totals. */
function computeTotals(lines, config) {
  const t = { taxblAmtA:0, taxblAmtB:0, taxblAmtC:0, taxblAmtD:0, taxblAmtE:0,
              taxAmtA:0,   taxAmtB:0,   taxAmtC:0,   taxAmtD:0,   taxAmtE:0 };
  for (const l of lines) {
    switch (l.vatCatCd) {
      case 'A': t.taxblAmtA += l.taxblAmt; t.taxAmtA += l.taxAmt; break;
      case 'B': t.taxblAmtB += l.taxblAmt; break;
      case 'C': t.taxblAmtC += l.taxblAmt; break;
      case 'D': t.taxblAmtD += l.taxblAmt; t.taxAmtD += l.taxAmt; break;
      case 'E': t.taxblAmtE += l.taxblAmt; t.taxAmtE += l.taxAmt; break;
      default: break;
    }
  }
  const rounded = {};
  for (const [k, v] of Object.entries(t)) rounded[k] = r2(v);
  const totTaxblAmt = r2(rounded.taxblAmtA + rounded.taxblAmtB + rounded.taxblAmtC + rounded.taxblAmtD + rounded.taxblAmtE);
  const totTaxAmt   = r2(rounded.taxAmtA + rounded.taxAmtD + rounded.taxAmtE);
  const totAmt      = r2(lines.reduce((s, l) => s + l.totAmt, 0));
  return { ...rounded, totTaxblAmt, totTaxAmt, totAmt };
}

/* Human/reporting tax summary derived from the same totals. */
function summarize(totals, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  return {
    vatRate:      cfg.vatRate,
    taxableTotal: totals.totTaxblAmt,
    vatTotal:     totals.totTaxAmt,
    grossTotal:   totals.totAmt,
    byCategory: {
      standard:  { taxable: totals.taxblAmtA, vat: totals.taxAmtA },
      zeroRated: { taxable: totals.taxblAmtB, vat: 0 },
      exempt:    { taxable: totals.taxblAmtC, vat: 0 },
    },
  };
}

/* Whole-invoice compute: items[] (optional per-item vatStatus) → lines + totals + summary. */
function computeInvoice({ items = [], vatStatus = 'registered', config } = {}) {
  const cfg   = { ...DEFAULTS, ...(config || {}) };
  const lines = items.map((it, i) => computeLine({ seq: i + 1, ...it }, it.vatStatus || vatStatus, cfg));
  const totals = computeTotals(lines, cfg);
  return { lines, totals, taxSummary: summarize(totals, cfg) };
}

/* Credit note / return / partial refund: recompute the RETURNED quantities with the
   SAME engine and negate, so a refund's VAT is always consistent with the original
   sale (no independent, drift-prone refund math). */
function computeCreditNote({ items = [], vatStatus = 'registered', config } = {}) {
  const inv = computeInvoice({ items, vatStatus, config });
  const negNum = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = (typeof v === 'number') ? r2(-v) : v;
    return out;
  };
  return {
    lines: inv.lines.map((l) => ({
      ...l,
      splyAmt: r2(-l.splyAmt), dcAmt: r2(-l.dcAmt),
      taxblAmt: r2(-l.taxblAmt), taxAmt: r2(-l.taxAmt), totAmt: r2(-l.totAmt),
    })),
    totals: negNum(inv.totals),
    taxSummary: inv.taxSummary,   // rate/category context stays positive (informational)
  };
}

module.exports = {
  DEFAULTS, r2, vatCategoryFor,
  computeLine, computeTotals, summarize, computeInvoice, computeCreditNote,
};
