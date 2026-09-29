# Smart Customer Search

**Status:** committed locally on `slice/c4-convergence`. Not deployed, not pushed.
**Date:** 2026-09-30
**Related:** [[COMMERCE_CONVERGENCE_CENSUS]] · [[PAYMENT_LABEL_AUTHORITY]] · [[SmartPOS]] · [[Loyalty]]

## What the owner asked for

> "you just type number it guess correctly or maybe giving options"
> "Type → recognize → suggest → select → save if new → attach to sale"
> "customer resolution, ownership, duplicate prevention, canonical phone normalization, and sale attachment should all remain server-authoritative"

The same box accepts a phone number, a name or part of one, or a customer code.

## One authority

There is one customer store, `posCustomers`, and it is owned by the shop through `sellerId`. The shop's scope is
`functions/pos-customer-scope.js`, which is the same predicate `posCompleteCheckout` already enforces when a sale
names a customer.

- There is **no** Till, Quick Charge or CRM customer store.
- `pos-crm-pro` records (id `${sellerId}_2547…`) and older records in any phone form are found by the full number.
  They are indexed the first time they are touched, and are never duplicated.

| Callable | Does | Gate |
|---|---|---|
| `posCustomerSearch({shopId, q})` | Returns up to 8 of this shop's customers matching the phone prefix, name word prefix or customer code, and says which one matched (`matchedBy`). | This shop's till staff (`loyalty-points.assertTillStaff`) |
| `posCustomerSave({shopId, phone, name})` | Finds the customer, or creates one per (shop, number). An existing customer is never renamed. | Same |
| `posCustomerCard({shopId, customerId})` | Returns purchases, lifetime spend and last purchase, all from `posCustomers`. SOKONI points come from the canonical `loyaltyAccounts`. | Same, plus `getOwned` (another shop's customer answers `not-found`) |

All three are exported in `functions/index.js`, next to `posLookupCustomer`.

### Recognising a customer

- **Phone normalisation.** Every phone form resolves to one key, `2547XXXXXXXX`: 0722376801, 0722 376 801,
  +254722376801, 254722376801 and 722376801. The key comes from the one existing normaliser (wallet-engine, reached
  through `loyalty-points.normalize`). The bare 9-digit form only gains a leading 0 before it is normalised.
- **Search keys.** `searchKeys` holds what a cashier types:
  - `p:` plus the national number from 3 digits upwards;
  - `n:` plus each name word from 2 letters upwards;
  - `c:` plus the customer code.

  A suggestion is therefore one indexed query: `sellerId == shop` AND `searchKeys array-contains term`.
- **No silent picks.** Only one exact full-number match is returned as `suggested` ("Customer found ✓"). A partial
  number, a name or a code always returns a list to choose from. The UI never attaches anyone without a tap, or an
  Enter on the single suggestion.

### What stays private

- Phones leave the server masked, as `0722 ••• •801`.
- Record ids are **opaque**: `${shopId}_c` plus 24 hex characters of sha256 over the shop and the number. An id spelled
  from the number would have un-masked it. This was found by test SC6 and fixed.
- **Residual risk:** the hash has no secret, so a staff member could brute-force it offline to recover a number.
  That same staff member can already type the number. Records written by the legacy `pos-crm-pro` keep their
  number-bearing ids.

### Attaching a customer to a sale

- The till sends only `customer: {id}`.
- `posCompleteCheckout` already refuses a customer from another shop.
- The sale record now takes the customer's **name and phone from the shop's own record** (`custOnFile`), never from
  what the caller typed. The sale transaction's existing update writes purchases, spend and last purchase.

### SOKONI points on the customer card

The card reports one of three states:

| State | Meaning | Shown as |
|---|---|---|
| `member` | The buyer has a SOKONI account | The balance |
| `none` | No SOKONI account on this number | "No account" |
| `unavailable` | The account could not be read | `—` (never an invented 0) |

When the cashier typed the whole number, the UI hands it to the existing SOKONI points box. That box looks the buyer up
on the server. Spending points is unchanged: the P2b buyer OTP.

## Surfaces

- **merchant-v2 Sell** (`sokoni-merchant-sell.js`): a "Customer (optional)" box above the points box.
  - Suggestions render as full-width 48px rows, and only that list repaints, so the field keeps its focus.
  - Unknown number: "New customer on 0799 ••• •456?" → name → Save, which attaches the customer.
  - Attached: a card with purchases, lifetime spend, last purchase and ⭐ SOKONI points, plus a Change button.
- **pos-checkout.html**: the same behaviour on the existing `#cust-input`.
  - Enter takes the one suggestion. Otherwise Enter runs the QR / member-id `lookupCustomer` as before.

## Indexes (deploy item)

`firestore.indexes.json` gains `posCustomers (sellerId ASC, searchKeys CONTAINS)`. Search needs this index in
production.

## Evidence

| Suite | Result |
|---|---|
| `scripts/test-smart-customer-search.js` (server) | 12/0 |
| `scripts/test-smart-customer-sell-browser.js` (Chromium, 390px and 1280px) | 8/0 |
| `scripts/test-smart-customer-poscheckout-browser.js` (Chromium) | 6/0, stable across 3 repeats |
| Mutation controls | 15/15 caught (10 server, 5 UI), files restored byte-identical |

## Not done — recorded, not hidden

- **Quick Charge** (`sokoni-merchant-till.js`) does not yet attach a customer. Its sale is a payment intent, not a
  `posRetailSales` record. Counting its purchase against the customer means a change on the webhook money path, so it
  is its own slice.
- **No migration.** Existing customers without `searchKeys` are found by their full number only, until they are first
  touched. They are not found by name before that. A backfill would be a production data write and needs owner
  authorisation.
- **Legacy `merchantId`-only records.** Records carrying only `merchantId` (no `sellerId`) are not found by `findOwned`.
  The same limit already applies to the existing lookup.
- **Not deployed.** Needs a functions deploy (3 new callables, `pos-zero-friction`), the index and hosting — each only on
  explicit owner authorisation.
