# Marketing › Offers — one offer store, one wizard per type

**Status:** U7c1 implemented on 2026-09-29 (branch `slice/c4-category-matrix`). **Not deployed.**
**Offers are not yet applied at checkout or the till:** that is U7c2.

Related: [[CATALOGUE_CAPABILITY_MATRIX]] · [[PACKAGES_AND_BUNDLES]] · [[OFFER_PERSISTENCE_ARCHITECTURE]] · [[OFFER_PERSISTENCE_P1_P4_DECISIONS]] · [[Payments]]

## Where it lives

Marketing is a **primary** merchant-v2 destination. Its tabs are **Offers**, Campaigns, Promotions and Ads, and Offers comes first.

The old sidebar entries **Offers** and **Flash Sale** are gone. Their links still work through aliases:

| Old link | Opens |
|---|---|
| `#offers` | Marketing › Offers |
| `#flash-sale` | Marketing › Offers, with a new flash sale open |
| `#promotions` | Marketing › Promotions |

## The one store

Offers are written to **`shopOffers`**, and only through the callables `shopOfferUpsert` and `shopOfferList` (`functions/shop-offers.js`). This store was certified in GATE P (`11933e3`) and was never wired into merchant-v2 until U7c1. The server:

- **derives ownership.** The payload's `shopId` and `sellerUid` are ignored.
- **requires the `discount` capability.** Owners and managers hold it; cashiers, inventory staff and support do not.
- **is idempotent on the studio's `draftToken`.** A retried save lands on the same offer.
- **refuses a cross-shop write.** The check runs against the stored document, not the payload.

**Drafts may be incomplete.** They save without a percent, amount or price. This is safe because a draft can never price a basket: `isLive` accepts only live or active offers, and the charge path reaches offers only through `resolve()`. Publishing still requires every field.

The old native flash module (`sokoni-merchant-flash.js` → `mktFlashSales`) is no longer loaded. It was never reachable: its route was an iframe of `seller.html#flash`. It resolved products against the POS mirror, and nothing that charges a customer ever read it.

## The wizards

Every template has its own controls, listed in `WIZARDS` in `sokoni-merchant-offers.js`. A template's payload carries only the fields its own sections own. Switching type therefore never leaves a stale field behind: a flash sale switched to buy-X-get-Y sends no percent.

| Template | Type | Controls |
|---|---|---|
| Flash sale | percentage | products, sale price (percent, or the price for a single product), start/end (end required), sales limit, per-customer limit, terms |
| Meal deal | bundle | items from the menu with quantities, price, days/hours and calendar, dates, limit, delivery/pickup, terms |
| Package / Stay package / Service package | bundle | items with quantities, price, dates, limit, terms |
| Percentage off | percentage | percent, products (optional), dates, conditions, stacking, terms |
| Buy X get Y | buyXgetY | products (required), buy/get quantities, most free per order, dates, conditions |
| Happy hour | percentage | percent, products (optional), days and hours (required) with calendar, conditions |
| Coupon | fixed | amount, dates, conditions, stacking |
| Spend and save | spendAndSave | minimum spend, amount off, dates, conditions, stacking |
| Free delivery | freeDelivery | minimum order, dates |
| Free gift | freeItem | the free item, minimum order, dates, limit |

**Products and items come from the shop's own catalogue** (`listProducts`), shown with live price and stock:

- A package shows its complete sets, from `SokoniPackageStock`.
- Archived products are never offered.
- Nothing can be typed in by hand: the old `window.prompt` path is gone.

**Other behaviour:**

- **Drafts:** "Save draft" persists an unfinished offer. The Drafts filter lists drafts, and "Continue draft" resumes one. A draft can also be published straight from the list.
- **Status:** derived the same way the resolver judges an offer. Possible values are live, scheduled (starts later), outside hours, ended (past its end), draft and archived. "End offer" archives an offer.
- **Back:** the editor pushes a history entry. The on-screen Back and the phone's Back both return to the list without leaving Marketing. A changed offer that was never saved is offered as a draft first.
- **Preview:** priced by the promotion model, over the chosen catalogue items at their current prices. With nothing chosen there is no preview; the old made-up sample basket is gone.

## Known limits (open)

- **Not applied at payment.** `resolveOfferForCharge` is still not called by checkout, the till or Quick Charge. That is **U7c2**, which will also show the discount in the cart and the till and record redemptions.
- **The sales limit counts redemptions, not units.** `usageFor` counts redemption records, so "stop after N sales" means N orders.
- **No per-branch targeting yet.** `locations` exists on the record but no wizard sets it.
- **Only one fulfilment channel can be targeted.** The field is one channel (delivery or pickup) or blank; the server compares a single string.
- **Campaign types** (product, service, event, seasonal, referral, loyalty, reactivation and profile campaigns) belong to Marketing › Campaigns. They are distribution, not price rules, and are not offer wizards.
