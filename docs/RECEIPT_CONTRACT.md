# The Universal SOKONI Receipt Contract

**Status:** LOCKED · **Module:** `sokoni-receipt.js` → `window.SokoniReceiptDoc`
**Certification:** `scripts/test-receipt-contract.js` — 113/0
**Deployed:** no. Nothing in this contract is live yet.

Related: [[CANONICAL_ORDER_DESTINATION]] · [[MERCHANT_V2_TARGET_ARCHITECTURE]] · [[SmartPOS]] · [[Payments]]

---

## One renderer, no exceptions

Every receipt SOKONI produces comes through `SokoniReceiptDoc.render()`:

| state | covered |
|---|---|
| owner sale | ✅ |
| employee sale | ✅ |
| pickup | ✅ |
| delivery | ✅ |
| online order | ✅ (same shape) |
| shop with **no logo** | ✅ |
| sample / test receipt | ✅ |
| P58E paper output | ✅ |

There is **no production renderer plus a separate development one.** The moment
those exist they drift, and the branded document you tested stops being the one the
customer receives. A sample receipt differs from a real one by *exactly one notice
block* — asserted structurally, not by eye.

## Mandatory on every receipt

- SOKONI branding
- the SOKONI QR
- shop logo when available, **shop name always**
- shop contact where configured
- receipt / order number
- **server-authoritative** date and time
- `Served by:` when it is knowable
- items, quantities, prices, totals
- payment details
- delivery / pickup where applicable
- `Powered by SOKONI`
- `Bravilex International Co. Limited`
- a customer-facing path back **into SOKONI**

## The rules that are not negotiable

### Served by is authoritative or absent

An **employee** sale names the employee, and the owner appears **nowhere on it**. A
receipt crediting the owner for a sale an employee rang up is a false record, and it
is precisely the record a shift dispute turns on.

A nameless employee does **not** fall through to the shop owner — the line is omitted
and a warning is raised. An unrecognised role is refused rather than printed.

`servedBy` is supplied by the shell from the authenticated session. The Sell screen
passes it straight through and never synthesises it.

> **OPEN:** no shell currently populates `ctx.servedBy` from a staff record. Until the
> merchant identity authority lands, real receipts will omit the line. The contract is
> correct; the *source* is not yet wired.

### No logo is not a broken logo

Without an uploaded logo the identity block emits a **wordmark** whose text is the
shop name, with the SOKONI mark still present:

```
         SOKONI
     Mama Njeri Shop
```

Never an empty frame, never a broken-image icon. Most merchants have no logo on day
one, and a receipt that looks broken makes the shop look broken. A shop with no name
at all falls back to the SOKONI wordmark.

### The QR is functional, and carries nothing sensitive

```
https://mysokoni.co.ke/payment-receipt.html?ref={receiptNo}
```

**Exactly** the URL `functions/payment-trust.js:83` and `functions/fulfilment-scan.js:142`
already build. A third spelling of the customer receipt surface would be the same
defect as a twelfth spelling of a delivery destination, so the constant is *asserted
against those two files* rather than trusted.

It encodes the receipt number and nothing else. That number is already printed in full
on the paper the customer holds, so the QR discloses nothing the receipt does not — and
a photographed receipt must never leak a phone number, a uid, an amount, a token or an
address to whoever scans the picture.

**No receipt number → no QR.** One pointing nowhere is worse than none: the customer
scans it, lands on an error, and concludes SOKONI is broken.

### Time comes from the server

The device only *formats* it. A receipt with no server time prints `Time not recorded`.
The device clock appears **nowhere** — including the copyright year, which is omitted
rather than guessed.

### It never invents

Every conditional line is ABSENT when its data is absent: no logo, no email, no KRA
PIN, no terminal, no `Served by`. A terminal id prints only when a real terminal
exists — a phone sale has none, and printing one puts a fiction on a tax-adjacent
document.

**KRA PIN:** `shops/{uid}` has no tax field today (see `firestore.rules` — the updatable
set is name/phone/email/address/city/…). It is read from a supplied tax profile and
omitted otherwise. Never invented, never stored as a receipt-only copy.

### Two equal codes: SOKONI and KRA eTIMS (2026-09-29)

Every receipt carries **two codes of equal size, side by side**: the SOKONI verify code on the left and the
**KRA eTIMS** code on the right (`closing.qr` and `closing.kraQr`).

- **The KRA code is printed only from a real eTIMS response**, meaning an `https` URL on a `kra.go.ke` host
  (`etims.qrUrl` / `etimsQrUrl`, checked by `isKraEtimsUrl`).
- Anything else shows **`eTIMS pending`** in the same-size slot:
  - no eTIMS record;
  - a SOKONI URL;
  - a look-alike host such as `kra.go.ke.evil.example`;
  - **every sample**.

  A synthetic KRA code would be a forged tax document.
- **eTIMS invoice number:** `eTIMS Inv: <no>` joins the reference lines, but only when KRA issued one.
- **On paper** the two codes are drawn into **one raster image** (ESC/POS `GS v 0`) that fits the printable band
  exactly: **384 dots at 58mm, 576 at 80mm**. A caption line sits under each half. A caller with no canvas gets
  the two codes one under the other.
- **`toText(doc, { qrSentinel: true })`** places a single marker line (`QR_SENTINEL`) where the pair goes, so an
  adapter can draw real images in its place.

## Two adapters, one composition

**The phone is canonical. The P58E is optional physical output.** A merchant with no
printer has a complete receipt, and nobody opens POS Setup before they can sell.

| | phone / Share | P58E paper |
|---|---|---|
| call | `toText(doc)` | `toText(doc, { cols: 32, ascii: true })` |
| characters | `❤` `·` `—` `©` kept | transliterated to ASCII |
| width | flexible | 32 cols (58mm) / 42 (80mm) |
| long names | reflow | reflow, never truncate |
| QR url | whole line | whole line |

A truncated product name is a *different product*, and a merchant reconciling stock
cannot tell which one was sold — so names reflow. The QR url is never hard-wrapped: a
split url is not tappable in WhatsApp, which is where most of these receipts go.

## The grid

```
PRODUCT             QTY   AMOUNT
--------------------------------
Milk                  2      240
Bread                 1       80
Sugar                 1      150
--------------------------------
TOTAL                        470
```

Amounts right-aligned to a single column, qty right-aligned, product takes the rest.

## Sample and test receipts

Identical branding, clearly marked:

```
  SAMPLE / TEST - NOT A SALES
             RECORD
--------------------------------
             SOKONI
        Mama Njeri Shop
```

No generic "TEST RECEIPT" branding replacing SOKONI, no unbranded development
receipt, no fake merchant, no missing QR, no missing `Powered by SOKONI`.

## Why not `window.SokoniReceipt`

That global is **already taken**. `pos-checkout.html`, `pos-marketplace.html` and
`pos-printer.js` all call `.print()` / `.doc()` on it, and this module has neither.
Claiming the name would have broken POS printing on any page loading both — and the
page would have looked perfectly healthy right up until a merchant pressed Print.

## Certification

`node scripts/test-receipt-contract.js` — **113 passed, 0 failed**, covering all seven
states with negative controls throughout (a check that cannot fail proves nothing).

Two defects the suite caught in its own runs:

- a plain `.trim()` on the composed text was eating the leading spaces of the first
  line, flattening `SOKONI` to the left margin on **every single receipt**;
- index-based block lookup broke the moment a sample receipt prepended a notice
  block — every index shifted by one and it reported a missing logo on a receipt that
  had one. Blocks are now looked up by type.

## Not yet done

- `ctx.servedBy` is not populated from any staff/owner record — see the OPEN note above.
- Merchant identity authority (logo, shopName, businessName, phone, email, address,
  town, KRA PIN) is not populated at approval/setup.
- The phone presentation adapter (the polished digital receipt) is specified here but
  not built; only the text adapter exists. The POS Setup page presents the text adapter plus the two drawn codes.
- **Paper:** `PosPrintService` prints this document only on request (`context.useDoc`, used by the POS Setup test
  print). Every other caller still prints the older `_buildSaleReceipt` layout. The print host
  (`sokoni-print-host-listener.js`) passes a rendered `doc` that the service does not read today.
- No producer of `etims.qrUrl` exists yet, so every receipt currently shows `eTIMS pending`.
- Nothing is deployed.
