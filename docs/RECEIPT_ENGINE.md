# Receipt Engine

**Status:** Stable for production use. Payment-dependent fields deferred.
**Last verified:** 2026-07-19 against production (`mysokoni.co.ke`, Firebase edge 199.36.158.100)
**Related:** [[PRINT_COMPATIBILITY_MATRIX]] · [[SmartPOS]] · [[Payments]] · [[Orders]]

---

## Generators

| File | Role |
|---|---|
| `sokoni-receipt-engine.js` | ESC/POS byte stream + HTML builder — the canonical thermal path |
| `pos-receipt-engine.js` | POS on-screen digital receipt (`window.SokoniPosReceiptUI`) |
| `sokoni-label-engine.js` | Shipping / product labels — TSPL, ZPL, ESC/POS, HTML |
| `sokoni-pos-print.js`, `sokoni-pos-print-service.js` | Print orchestration and transport |
| `functions/email-templates.js` | Email receipts and invoices |
| `functions/etims.js` | KRA eTIMS fiscal receipts |

Paper widths: **58 mm = 32 columns**, **80 mm = 48 columns**.

### Namespace contract

`pos-receipt-engine.js` loads after `sokoni-receipt-engine.js` on POS pages. It must **merge** into
`window.SokoniReceiptEngine`, never replace it — a bare assignment destroys every ESC/POS method and
silently disables thermal printing. It also publishes `window.SokoniPosReceiptUI` for the on-screen
receipt. Both globals must be present after both scripts load; this is asserted by the post-deploy check.

---

## Text fitting

`_wrap(text, cols)` is the shared wrapping helper. It word-wraps, and **hard-breaks any single token
wider than the line** — without that, long SKUs and verification URLs had no break point, were pushed
out whole, and were clipped by `line()`.

`wrapLine(label, value)` wraps labelled identity fields with a hanging indent. The first row is
budgeted at `cols - label.length` so the label cannot push row one back over the limit.

`_wrap` is shared by item names, delivery address, delivery notes, warehouse note, footer, and
warranty text — all inherit the hard-break behaviour.

**Invariant:** no characters are lost and no printable line exceeds the paper width.
Verified at 58 mm and 80 mm across names up to 64 characters, item names up to 88 characters, and
unbroken tokens with no spaces.

> Measuring line width requires stripping ESC/POS control sequences **including `GS !` (`0x1D 0x21`)**.
> A stripper that misses it counts control bytes as printable and reports phantom overflows.

---

## Deferred Until Live Payment

These fields are **not implemented on purpose**. Each depends on data that does not exist until a real
transaction settles, or on architecture not yet built. None may be invented, stubbed, or filled with
placeholder values — a receipt is a financial document, and a fabricated reference is worse than an
absent one.

As of 2026-07-19 the platform has recorded **zero payments**, so none of these can be verified.

| Field | Why it cannot be verified yet | Event that will populate it | Where it belongs on the receipt |
|---|---|---|---|
| **Transaction ID** | No transaction has ever been written. The ID is minted by the payment pipeline, not the receipt engine; asserting a format now would be a guess. | First successful charge writing the payment document. | Header block, under the receipt number — it is the primary support/reconciliation key. |
| **IntaSend reference** | The provider's reference is returned in the settlement callback. No callback has been received against a real charge. Note the dashboard still points at the no-op `/webhookIntasend` rather than `/intasendWebhook` — this must be corrected before the reference can arrive at all. | First `intasendWebhook` delivery carrying the provider invoice/reference. | Payment block, beside the payment method and M-PESA reference. |
| **Service fee** | Only derivable from the payment flow. Deriving it in the receipt engine would create a second fee calculation competing with the commission engine — the platform permits exactly one authoritative table (`functions/commission-config.js`). | Payment record carrying the fee the commission engine actually applied. | Totals block, itemised above the grand total. |
| **Merchant earnings** | Net payout is settlement output, known only after fees, tax withholding, and any refund offsets are applied. It cannot be computed at print time. | Settlement run producing the merchant's net figure. | Merchant copy only — never the customer copy. |
| **Verification code** | Implies a receipt verification service that does not exist: no code issuance, no storage, no lookup endpoint. Printing a code nothing can validate is worse than printing none. | Requires the verification service to be built and approved; it is not payment-gated but architecture-gated. | Footer, beside the QR code, with the verification URL. |

### Also deferred (architecture, not payment)

Digital signatures, receipt hashes, and the receipt verification service. These require a design
decision on key custody and an approved verification endpoint. **Not approved for implementation.**

---

## Hardware compatibility

Thermal output is verified at the **byte-stream level only** — the generated ESC/POS is well-formed,
complete, and correctly fitted to 32 and 48 columns. **No claim is made about any specific printer
model.** Physical device validation remains outstanding. See [[PRINT_COMPATIBILITY_MATRIX]].

---

## Post-deploy verification

The receipt engine is served from `PRECACHE_STATIC` under the `CACHE_VERSION`-scoped cache. **Any change
to it requires a `CACHE_VERSION` bump in `service-worker.js`**, or installed POS terminals keep running
the old engine.

`/pos` is auth-gated and redirects unauthenticated sessions to `/pos-setup`. Assert the landed pathname
with an **exact match** — `/\/pos\b/` also matches `/pos-setup`, which has caught this project twice.
`buildReceiptBytes` takes `({ data }, { paperWidth })`; calling it with a flat object silently produces
a near-empty receipt and invalidates the test rather than the code.
