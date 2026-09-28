# Shop Availability Authority

> 2026-09-29 · availability completion **A1** · related: [[Marketplace]] · [[Orders]] · [[SmartPOS]] · [[Authentication]]

**One authority. One evaluator. Many consumers.** "Is this shop open right now, and when does that change?" has
exactly one answer in SOKONI.

```
merchant-v2 › Availability (sokoni-merchant-availability.js)
        │  setShopAvailability  (owner, or staff with manageAvailability)
        ▼
shops/{id}                      acceptingOrders · online · delivery · pickup · temporaryClosure
                                availabilityMode · timezone · ordersWhenClosed · openingHours (object)
providerAvailability/{owner}    hours · overrides
        │
        ▼
functions/shared/shop-hours.js  ── THE evaluator (pure, UMD) ──  /sokoni-shop-hours.js (byte-identical copy)
        │
        ├── kasshop.effectiveForShop / getShopAvailability / publicShopState
        ├── getMinishopPublic → storefront badge + Hours & Availability (sokoni-minishop.js)
        ├── merchant-v2 preview ("this is how customers see your shop")
        ├── sokoni-availability-model.js adapters (product listing view)
        └── createCheckoutSession → availability-enforce (temporary closure · orders while closed)
```

## The verdict

| status | meaning | example headline |
|---|---|---|
| `open` | inside a period (or no timetable, but online) | Open now · Closes at 6:00 PM |
| `closing_soon` | ≤ 30 min left in the current stretch | Closing soon · Closes in 15 min |
| `break` | opened today, reopens later today | On a break · Reopens at 2:00 PM |
| `closed` | outside hours, or a closed special date | Closed · Opens tomorrow at 8:00 AM |
| `temporarily_closed` | the owner closed it until a time (it lifts by itself) | Temporarily closed · Reopens today at 4:00 PM |
| `offline` | the live switch: not taking orders / offline | Not taking orders right now |
| `appointment` | by-appointment business; the booking engine decides slots | By appointment |

**Precedence:** temporary closure → offline → appointment → special date → weekly hours.

**Special dates** (`overrides`) take one of three forms: `{closed:true}`, `{closed:false}` (open all day), or
`{periods:[…]}` (special hours). Each may carry a `label` such as "Mashujaa Day".

**Periods:** several per day, where the gaps are breaks; back-to-back periods count as one stretch. `close <= open`
runs past midnight, and the previous day's tail is honoured.

**Timezone:** the shop's IANA zone (`shops.timezone`, default `Africa/Nairobi`).

The pre-2026-09-29 `reason` codes are kept for compatibility: `within_hours`, `special_hours`, `no_schedule`,
`outside_hours` (also during a break), `closed_today`, `offline`, plus the new `temporarily_closed` and
`appointment_only`.

## Who may change it

| Actor | Rights |
|---|---|
| Owner | everything |
| Manager | `manageAvailability` is in the manager ceiling (merchant-identity); the owner can **withdraw** it per manager (`restrictions`) |
| Cashier / inventory / support | read-only |
| Former employee, stranger | refused (`NOT_AUTHORISED`) |

Healthcare schedules are refused here (`HEALTHCARE_OWNED`); they have their own authority.

## Rules

- **Discovery ≠ availability.** A closed shop stays discoverable. The shop discovery gate
  (`business-category.shopEligibility`) answers "may the public find it"; this authority answers "can it operate
  now".
- **Checkout re-checks on the server:**
  - a temporary closure refuses new orders;
  - `ordersWhenClosed:false` refuses orders outside hours;
  - the default stays ON (orders accepted and prepared when the shop opens).
- **The client never decides.** The storefront and the preview render the evaluator's verdict and words
  (`headline`). `scripts/build-shop-hours.js --check` fails on drift between the two copies.
- **No display strings as data.** `shops.openingHours` is the same object as `providerAvailability.hours`. A legacy
  string is ignored by every reader.

## A2 — recorded, not done

- **Pickup and delivery hours, and order / booking cutoffs.** Only on/off switches exist today.
- **Bookings convergence:**
  - `booking-service._prepareSlot` reads the legacy `providerAvailability.schedule`, the `overrides/{date}`
    subcollection and `isOnVacation`;
  - it does not read `hours`, the `overrides` map or the shop's live state;
  - `provider-dashboard.html` writes that legacy store;
  - `availability-manager.html` calls three undefined functions.
- **KASS "is it open?"** must use `publicShopState`, never free text.
- **Product page:** show the shop's status, from the same verdict.
- **Rules:** neither ruleset validates the shape of `hours` / `overrides`. The branch `shops` rule dropped the served
  `timezone` allowance. This belongs to shop discovery stage 3 (rules).
- **`payment-purposes.validateOrderLines`** reads a `shopState` collection nothing writes, so its availability check
  always passes.
