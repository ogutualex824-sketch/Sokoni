# 6b — SmartPOS cash converges on posCompleteCheckout

**Status:** built on the POS lineage (base `072e03d`, 6a) 2026-09-29. **Not deployed.**
**Related:** [[POS-6a-checkout-authority]], [[FINANCIAL_CORE_ARCHITECTURE]], [[POS_CHECKOUT_CONVERGENCE_DESIGN]],
[[POS-M0-4-DR-A-atomic-debt]], [[POS-M0-4-DR-R-reconciliation]], [[SECURITY]], [[ROADMAP]].

## The invariant

> **One physical sale = one server sale.** A SmartPOS sale exists when `posCompleteCheckout` says so, and only then.
> The server prices the cart from canonical `products`, proves the merchant, moves canonical stock and records the
> commission debt in one transaction, and issues the receipt. The till never writes a sale on its own authority.

## What was wrong (census, `072e03d`)

SmartPOS (`pos.js`) finished a sale on the device and had three writers:
- the local IndexedDB sale;
- `_posSyncCanonicalStock`, a client push of the stock delta to canonical `products/{id}`;
- a client-written `posTransactions` document, which the `mirrorPosTransactionToRetail` trigger copied into
  `posRetailSales` under the till's own `TXN-…` id.

As a result there was **no commission debt**, no server price or tender judgement, and a sale identity beside the
checkout's `ps_…`.

### Tender census (precondition, recorded before the build)

| Surface | Tenders | 6b |
|---|---|---|
| Merchant Sell | cash; M-PESA/card without a reference (already refused) | unchanged |
| `pos-v2.html` | cash only | unchanged |
| `pos.js` (SmartPOS) | cash, M-PESA STK, manual Till, card terminal, split, QR | **cash only**; the rest are shown unavailable |
| `pos-checkout.html` | cash, wallet, M-PESA with a reference, card without a reference (already refused), split lines, `loyalty_full` (already refused), **gift_card** | gift_card **newly refused** → Step 10 |

`gift_card` in `pos-checkout.html` used `pos-loyalty-engine.js` `redeemGiftCard`, a **client-only** IndexedDB balance
with a swallowed Firestore update. It debited that balance **before** the sale was asked for, and the server skipped
every non-confirmable method. So a client could declare any gift-card value paid. Production has 0 `giftCards` and 0
`posGiftCards`. Owner decision (Option 1): refuse now. Stored value becomes its own authority at **Step 10**
(🟢 approved, not built — see [[ROADMAP]]).

## What changed

### Server — `functions/pos-zero-friction.js`
- **Tender allowlist** `{ cash, mpesa, card, wallet }` runs right after the dry-run return, **before** the 6a merchant
  proof and any idempotency claim. `gift_card`, `mpesa_till`, `manual_till`, `split`, `qr`, an unknown method or a
  missing method is refused with `invalid-argument`, and nothing is claimed, sold, moved or owed. M-PESA and card still
  need a **confirmed** payment (unchanged), and the wallet is still debited in the transaction.
- **A non-finite confirmed amount is refused** with its own reason (`!isFinite(confirmedAmount) || …`). This is defence
  in depth: `assertConfirmable` currently normalises a missing amount to `null`, and `Number(null)` is 0, which is
  already refused as insufficient.
- **Typed refusals inside the stock transaction.** `Insufficient stock` is now `failed-precondition` and a vanished
  product is `not-found`, instead of plain `Error`s that surfaced as `internal`. An offline till can then tell a
  refusal (never retried) from an outage (retried). The messages are unchanged.

### Server — `functions/pos-retail-mirror.js`
After the 6a `ps_` guard, the trigger **writes nothing**. `posTransactions` is now a projection written after the
server decided. Mirroring it would turn one sale into two, the second with no stock and no debt. The trigger stays
deployed under its name, and the mapper is kept for the records it already produced.

### Client — `pos-converged-sale.js` (new, UMD, pure plus injected I/O)
- `tenderCheck`: cash only. Every other tender is refused **with a reason**, and the gift-card wording is the owner's.
- `resolveLines`: every line must be canonical: `marketplaceId`, or `source:'canonical'` (whose local id is the
  canonical id). Otherwise the sale is refused with **PRODUCT_NOT_CANONICAL** before it starts.
- `resolveScope`: the shop comes from Firestore through `SokoniMerchantData.resolveShopId` and is cached **per uid**.
  Offline, only the same uid's cache is used; no cache and no network means no sale ("connect once").
- `buildPayload`: `SokoniMerchantData.buildSale` with **saleToken = the local txn id**, so the idempotency key is
  fixed at the moment of sale. Every retry, sync and replay carries the same key.
- `submit`: **ACCEPTED** (a server `saleId`), **SYNC_REJECTED** (`invalid-argument`, `failed-precondition`,
  `permission-denied`, `not-found`, `out-of-range`), or **LOCAL_PENDING** (anything else, including an answer without
  a `saleId`).
  - The reasons are PRICE_CHANGED, STOCK_UNAVAILABLE, TENDER_REFUSED, PRODUCT_NOT_CANONICAL, NOT_AUTHORISED and
    REFUSED.
  - `SokoniMerchantData.completeSale` is **not** used, because it collapses the error code this split needs. The
    payload authority (`buildSale`) is reused unchanged.
- `settleQueued` / `applyOutcome`:
  - ACCEPTED records `canonicalSaleId`;
  - SYNC_REJECTED marks the till record failed and **gives the local stock back**;
  - LOCAL_PENDING throws, so the existing engine retries with the same key;
  - an already-settled record is never re-settled;
  - the compat projection is queued only after the decision.
- `reversalBlock`: accepted and pending sales cannot be voided or refunded on the till. A rejected sale has nothing to
  reverse. A pre-6b sale is unchanged.

### Client — wiring
- **`pos.js`:**
  - `setMethod`, `process()` and `complete()` all gate the tender. `complete()` is the choke point every tender path
    reaches.
  - `_convergedDecide` asks the server **before** the till saves anything. A refusal records nothing locally.
  - An ACCEPTED sale takes the **server's** receipt number.
  - Sale and rollback stock movements use `converged:` reasons.
  - The queued item (the projection, or the `converged_sale`) is the **last** saga write.
  - A receipt prints only for an ACCEPTED sale. A LOCAL_PENDING sale shows "pending confirmation".
  - Void and refund are held at the dialogs and at `_processVoid` / `_processRefund`.
- **`pos-db.js`:** a `converged:` movement changes local stock only: no `_posSyncCanonicalStock` push and no
  `SokoniSync.stockChanged` event.
- **`pos-sync.js`:** a new `converged_sale` route settles through `posCompleteCheckout` via `settleQueued`, branched
  before the document-write path.
- **`pos.html`:**
  - loads `sokoni-merchant-data.js` and `pos-converged-sale.js` before `pos-sync.js`;
  - M-PESA, M-PESA Till, Card, Split and QR show **Unavailable**. QR no longer opens a collection; `pos-qr.js` itself
    is untouched.
- **`pos-checkout.html` (caller-side only):** the button reads **"Gift Card — Unavailable"** with the owner's
  explanation. The button, the scanner, `confirmGiftCard` and `_processGiftCard` return before any lookup or redeem.
  `pos-loyalty-engine.js` is unchanged.

## What the till shows

| Outcome | Till record | Stock | Receipt |
|---|---|---|---|
| ACCEPTED | `serverStatus: ACCEPTED`, `canonicalSaleId` | local −qty (the server moved canonical) | server number, printed |
| LOCAL_PENDING (offline / no answer) | `serverStatus: LOCAL_PENDING`, queued `converged_sale` | local −qty | not until confirmed |
| → settled ACCEPTED | as above | unchanged | reprint from Orders |
| → SYNC_REJECTED | `status: failed`, `serverReason` | local stock returned | none |
| Refused online | **nothing** | nothing | none: the error says nothing was charged |

## Known limitations (deliberate, each its own item)
- **Void and refund of a converged sale** are held. Wiring the till to the server refund authority is later work.
- **Customer and loyalty** stay local; no customer is sent (see [[FINANCIAL_CORE_ARCHITECTURE]] FC-7).
- **Tax-inclusive prices** send `taxTotal: 0`, because the server adds tax on top. The tax policy is a separate repair
  (0b R3).
- **Legacy queue items.** A pre-6b `transaction` item still in a device's queue writes `posTransactions`, but no longer
  becomes a `posRetailSales` row (the mirror is a no-op). No historical reconstruction, per the owner's decision.
- **Crash window.** If the call reaches the server, the server commits, and the till loses both the answer and its own
  IndexedDB write, the sale exists only on the server. DR-R and reconciliation are the backstop.
- **A persistently failing transient sync** goes to the existing DLQ after 8 attempts.
- **`pos.js` orchestration** is asserted statically and modelled in the suite, and `PosDB.adjustStock` is executed in
  WebKit. A full SmartPOS page run on a device is **UNPROVEN**.

## Deployment (not authorized)
This needs the functions (`posCompleteCheckout`, `mirrorPosTransactionToRetail`) **and** hosting from the same lineage.
Hosting alone would run a cash-only till against the deployed checkout, which has no allowlist and throws untyped
stock errors. Functions alone would stop the mirror while the deployed till still relies on it. Blocked in any case by
M0-6 and the CLAUDE.md Artifact Registry notice.

## Certification
`scripts/test-pos-6b-smartpos-cash.js` (emulator + WebKit):

| Check | Result |
|---|---|
| This suite, new tree | **45/0** (3 complete runs; an earlier run with WebKit BLOCKED is not counted) |
| This suite, old tree `072e03d` with the new client module | 24/21; every failure for the right reason; both controls pass |
| Mutants, one per safeguard | **21/21 killed**. M1 re-admits `gift_card` and the gift-card sale completes with stock and debt |
| `test-pos-6a-checkout-authority` after the N-1 inversion | 28/0 ×3; the corrected N-1 fails on the old tree ("MIRRORED") |
| Floor, 135 suites, old vs new | no summary-line difference; log differences explained |

**Sections:**
- **T** — tender, including an explicit gift_card case;
- **S** — one physical sale: online, replay, offline→sync, duplicate sync, timeout, mirror, cross-merchant key, forged
  merchant, stock, price, not-canonical, classification;
- **C** — scope;
- **R** — reversal hold;
- **W** — wiring (static);
- **B** — `PosDB.adjustStock` in WebKit.

**6a tripwire (owner-authorized):** N-1 now proves that an ordinary id is **not** mirrored. N-2 (the `ps_` refusal) still
passes, but it no longer isolates the `ps_` guard, because the no-op mirror also yields no row. The guard stays in code.
Full evidence: CHANGELOG (174).
