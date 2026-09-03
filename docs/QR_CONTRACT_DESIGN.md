# QR defects — intended contract per defect (read-only)

**Status:** 📋 READ-ONLY CONTRACT DESIGN. No code changed, no route added, no encoder swapped,
nothing deployed. Builds on r1's own trace (`docs/defects/DEFECT-qr-receipt-404.md` at `8fc3673`,
read but not modified — `C:/temp/sok-r1` untouched), independently re-verified live, and pushed one
level deeper on each of the three questions the user asked, per instruction: **do not treat as one
QR rewrite — three separate contracts.**

---

## 1. POS receipt — the fix is not just a URL, and repointing to `payment-receipt.html` is not yet safe

**r1's trace correctly found the route is missing** (confirmed live again just now:
`/receipt/TESTID123` → 404) and correctly declined to pick a fix, flagging three options without
data to choose between them. This pass adds the missing data — and it changes the answer.

### What `payment-receipt.html` actually is

Its own code comment (lines 237-266) documents a 2026-07-19 fix: it now calls
`verifyTrustReceipt` (`functions/payment-trust.js:302`), described as *"the canonical verifier."*
Traced that function directly:

```
functions/payment-trust.js:306
  const snap = await db.collection('posReceipts').doc(_sanitize(receiptNo)).get();
```

It reads **`posReceipts`**, Admin-SDK-mediated (bypasses the rule that correctly blocks a stranger
from reading a receipt directly), returns a **thin public projection** (receiptNo, merchantName,
date, total, paymentMethod) with full detail gated to the buyer/seller/admin. This is a genuinely
well-built, already-live pattern — not something to rebuild.

### Whether it's appropriate for a POS sale — checked, not assumed

`recordPOSSale` (`functions/pos-retail-engine.js:253`, the function whose QR is broken) writes its
sale to **`fdb.collection('posSales').doc()`** — confirmed by direct read, and confirmed
`functions/pos-retail-engine.js` **never writes to `posReceipts` anywhere** (zero matches,
repo-wide grep). So even if the QR URL were repointed to `/payment-receipt?ref={receiptId}` today,
`verifyTrustReceipt` would look for that ID in `posReceipts`, find nothing, and the customer would
see "Receipt not found" — a different failure, not a fix.

**Who does correctly write `posReceipts`:** `functions/pos-zero-friction.js:961` —
`db.collection('posReceipts').doc(saleId).set({...receipt, ...})`, inside `posCompleteCheckout`.
Its own comment (line 722) states this rail was deliberately built to connect a till sale to
`posRetailSales`, `posDaily`, **and** `posReceipts` together, because the older path "wrote
posRetailSales, posDaily and posReceipts and STOPPED" with no financial trace downstream.

**This is the same two-rail split already established in this session's project memory (ADR-013):**
`posCompleteCheckout` (server-authoritative Rail 1) vs. the legacy till path (`recordPOSSale`,
Rail 2). `payment-receipt.html`/`verifyTrustReceipt` is the correct, appropriate destination —
**for Rail 1 sales.** It is not yet appropriate for `recordPOSSale`'s sales, because Rail 2 never
produces the record the verifier reads.

### The contract, stated

> A POS receipt QR must resolve to `payment-receipt.html?ref={id}`, and the `{id}` must be a
> document that actually exists in `posReceipts` at scan time.

Two ways to satisfy that, not decided here:
- **(a)** Fix only the rail that already writes `posReceipts` correctly (`posCompleteCheckout`) to
  also emit the working QR URL, and treat `recordPOSSale`'s broken QR as a symptom of Rail 2 being
  the thing ADR-013 already recommends migrating away from — not a URL bug to patch in isolation.
- **(b)** Make `recordPOSSale` also write a `posReceipts` document (or a compatible bridge) before
  it can safely point at the same verifier.
Both are real; picking one is implementation, out of scope here.

---

## 2. "eTIMS verification" is two different needs, not one — neither has a canonical consumer page yet

r1's trace grouped `/verify/doc/{n}` and `/verify/inv/{n}` as one "eTIMS" defect. Read closer, they
are not the same document type:

| URL | Generator | What it actually is | Confirmed by |
|---|---|---|---|
| `/verify/doc/{docNumber}` | `hub-etims.js:160` `buildDocumentHtml` | a **hub operational document** (pickup/warehouse receipt) | the generated HTML's own footer, verbatim: *"OPERATIONAL DOCUMENT — NOT A TAX INVOICE"* (line 301) |
| `/verify/inv/{invoiceNumber}` | `hub-etims.js:312` `buildHubInvoiceHtml` | a genuine **Tax Invoice** for a selling hub, with VAT-category line items (`taxCategory`, `lineVat`) | document `<title>Tax Invoice ${invoiceNumber}</title>` (line 330), full VAT breakdown per line |

`invoiceNumber` is a **SOKONI-internal sequential number** (`` `${prefix}-INV-${year}-${seq}` ``,
line 523), generated locally and *then* submitted to KRA's SDC API as `invcNo` (line 603) — not a
number KRA hands back. There is no evidence either page is meant to point at a KRA-hosted public
verification portal; the invoice-building code stores `kraResp` (line 649, the KRA API's own
response) alongside the invoice record, which is exactly the shape a `verifyTrustReceipt`-style
thin verifier would need to confirm a document's authenticity server-side.

**No canonical consumer page exists for either today** — confirmed by search: no `verify.html`,
no `/verify` route, no callable named anything like `verifyHubDocument`/`verifyHubInvoice`.

### The contract, stated

> Both need their own thin, Admin-SDK-mediated verifier, following the exact pattern
> `verifyTrustReceipt` already proves: look up the stored document, reject if voided/cancelled,
> return a minimal public projection (document number, hub/merchant name, date, total — and for
> the tax invoice, presumably the VAT total, since that's the point of a tax-verification QR),
> full detail gated to an authenticated party. Two pages, two callables, one proven pattern — not
> a KRA-hosted redirect, based on what's actually stored (`kraResp` is retained for exactly this).

Which collection each document type is actually persisted to (needed to write the real verifier)
was not traced in this pass — the contract is established; the storage lookup is the next read-only
step if this is picked up.

---

## 3. Product label QR — encode a full URL, matching this codebase's own established convention

r1's trace correctly identified the placeholder is not a real encoder (an LCG-seeded fake) and that
a real one (`qrcodejs`, loaded by `loadQRLib()` right next to the fake one) is already available
but unused by the label template. It also correctly flagged the payload itself is wrong — a bare
product id, not something a scanning phone can open.

**Precedent already exists in this exact codebase for what a QR should encode.**
`payment-receipt.html` generates its *own* QR (for reprint/display) encoding
`const receiptUrl = location.href;` — **the full page URL**, not a bare reference. `qrcodejs` is
already proven working there (confirmed: `payment-receipt.html` is one of 11 files in this repo
using `new QRCode(...)`/`qrcodejs` successfully).

`product.html` confirmed live at `/product?id={id}` → **200** (re-verified this pass), and reads
the id via `new URLSearchParams(location.search).get('id')` (also accepts `?product=` as an alias).

### The contract, stated

> The product label QR should encode `https://mysokoni.co.ke/product?id={productId}` — a full,
> scannable URL to the real, live product page — generated with the already-loaded `qrcodejs`
> encoder, not the placeholder. This matches the one convention this codebase has already
> established for QR payloads (full URL, not bare id), rather than inventing a new one.

---

## What this document does NOT do

Does not change `pos-modules.js`'s label template, `pos-retail-engine.js`'s receipt URL,
`hub-etims.js`'s verify URLs, or any hosting rewrite. Does not decide option (a) vs (b) for the
receipt rail question. Does not identify the storage collection for hub documents/invoices (the
next read-only step for defect 2, if picked up). Does not touch `C:/temp/sok-r1`.

## Related

`docs/defects/DEFECT-qr-receipt-404.md` (r1, `8fc3673` — the original trace this extends) ·
project memory: ADR-013 two-rail POS split (`posCompleteCheckout` vs. legacy till) — this document
finds the same split reaches the receipt-verification layer, not just checkout/pricing
