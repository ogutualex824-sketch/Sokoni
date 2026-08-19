# Canonical order destination — contract proposal

**Status:** **PROPOSED. Not implemented, not written anywhere, not deployed.**
Step **A** of the location/fulfilment build order. Nothing proceeds to B (buyer saved
locations) until this is decided and the data census below has run.

Supersedes the open question in [[DELIVERY_DESTINATION_BLOCKER]].

---

## 1. The census got worse, not better

The blocker recorded **eight** spellings from a partial code census. Tracing what dispatch and
rider surfaces actually **consume** found **two more** that were never listed:

| consumer | address fields read | geometry fields read |
|---|---|---|
| `functions/dispatch.js` | `deliveryAddress`, `dropoffAddress` | `dropoffLat/Lng`, `deliveryCoords` |
| `functions/sokoni-dispatch.js` | `deliveryAddress` | `dropoffLat/Lng`, **`dropLat/dropLng`** |
| `functions/navigation.js` | `deliveryAddress` | **`deliveryLat/deliveryLng`** |
| `functions/sokoni-logistics.js` | `dropoffAddress` | `dropoffLat/Lng` |
| `sokoni-gip-dispatch.js` | `dropoffAddress` | `dropoffLat/Lng` |
| `driver.html` | `deliveryAddress`, `dropoffAddress`, `address`, `deliveryLocation` | `dropoffLat/Lng`, `deliveryCoords` |
| `seller-delivery.html` | `deliveryAddress`, `dropoffAddress` | — |

`dropLat/dropLng` and `deliveryLat/deliveryLng` are **new to this census**. Any decision taken
from the eight-field list would have been made on an incomplete picture — which is the argument
for measuring before deciding, not after.

## 2. What the evidence points at

Counting consumers rather than preferences:

| candidate | consumers reading it | on a critical path? |
|---|---|---|
| **`deliveryAddress`** | **5** | rider display, receipts, email |
| `dropoffAddress` | 5 | rider job, logistics |
| **`dropoffLat` / `dropoffLng`** | **5** | **proof-of-delivery GPS validation** |
| `deliveryCoords` | 3 | only ever a *fallback* (`dropoffLat \|\| deliveryCoords?.lat`) |
| `dropLat/dropLng`, `deliveryLat/deliveryLng` | 1 each | single-consumer outliers |
| `address`, `deliveryLocation` | 1 (driver.html) | last-resort fallbacks |

Two things make this more than a popularity contest:

1. **`dropoffLat/Lng` sits on the proof-of-delivery path** (`dispatch.js:327-328`), the check that
   decides whether a delivery was genuinely completed at the customer's location. Whatever is
   canonical must be what *that* reads, or the strongest consumer keeps hedging.
2. **The order writer already emits the pair.** `functions/index.js:2834-2842` writes
   `deliveryAddress` **and** `dropoffLat`/`dropoffLng` (plus `deliveryCoords`, derived from the same
   two variables). So the proposal below requires **no consumer to change** — it names what the
   system already does most of, and retires the rest.

### Proposed canonical shape

```
orders/{id}
  fulfilmentType : 'delivery' | 'pickup'      ← one vocabulary, one field
  destination : {                              ← present iff fulfilmentType === 'delivery'
    label            string   'Home' | 'Office' | free text
    building         string
    unit             string   house / apartment
    street           string
    area             string
    town             string
    instructions     string   'Use the main gate'
    lat              number
    lng              number
    formatted        string   the single human-readable line
  }
```

with **`deliveryAddress`, `dropoffLat`, `dropoffLng` written alongside as a compatibility
projection** of `destination`, so every existing consumer keeps working unchanged while new code
reads the structured object.

**One writer owns both.** The projection is never written independently of `destination`; that is
what stops them drifting the way the current eight did.

## 3. What must be proven before this is decided

**Nothing here is agreed yet, because the code census cannot answer the question that matters:
which fields does production actually contain?**

`scripts/census-order-destination-data.js` measures exactly that — read-only, prints **no buyer
PII**, only which fields are populated:

```powershell
$env:SOKONI_CERT_MERCHANT_EMAIL='<approved seller>'
$env:SOKONI_CERT_MERCHANT_PASSWORD='<password>'
node scripts/census-order-destination-data.js
```

Headed browser and a real seller, for the same reason the certification needs them: Firestore is
App Check gated.

It reports, per field, **present %** and **sole-source count** — the number of orders where that
field was the *only* destination present. **A field with a non-zero sole-source count cannot be
retired without losing data**, and that single number is what turns this proposal into a decision.

It also reports:

- how many delivery orders carry **no geometry at all** (the `packageRequests` path writes
  `deliveryCoords: null` and no lat/lng, so this is expected to be non-zero)
- how many carry **no address text**
- which **fulfilment key** production actually uses — `fulfillmentType`, `fulfilmentType`,
  `deliveryMethod` all appear in code, and the canonical field cannot be chosen without knowing

**If the seller has zero readable orders the census exits UNPROVEN, not PASS.** A canonical
decision must not be made from an empty sample.

## 4. Sequence — unchanged, and B does not start early

```
A  canonical contract        ← here. proposal + data census. NOT decided.
B  buyer saved locations         needs A's shape
C  POS delivery/pickup flow      needs A + B
D  cash / balance / change        independent of A — can proceed in parallel
E  delivery receipt + P58E        needs A and C
F  online checkout convergence    needs A
G  rider / dispatch consumption   needs A
H  premium Messages               independent of A — can proceed in parallel
```

**D and H are the only branches that do not depend on the destination contract**, so they are the
only ones that can start before it is decided.

## 5. Standing rules until A is decided

- **No new destination field is written anywhere** — not by POS, not by checkout, not by the Sell
  module. The order-share feature already follows this: it *reads* a destination and includes
  nothing when there is none.
- **No consumer gains another `a || b` hedge.** Each one makes convergence harder and hides the
  divergence from anyone reading a single call site.
- **Pickup orders never carry a destination**, and no surface invents one for them.

---

# PRODUCTION EVIDENCE — census run 2026-08-19

Real approved seller, headed browser, App Check **attested** (the backend answered a world-readable
read before anything was counted).

```
orders sampled 9    delivery 5 · pickup 1 · fulfilment unstated 3

ADDRESS      deliveryAddress 100%   address 100%
             dropoffAddress 0%  deliveryLocation 0%  destination 0%
GEOMETRY     ALL NINE SPELLINGS 0%
SOLE SOURCE  0 for every field
FULFILMENT   fulfillmentType 6   ·   deliveryMethod 3
```

## What this settles

**Nine of the eleven measured spellings are simply not present in production.** Only
`deliveryAddress` and `address` carry data, both at 100%, and **no field is ever a sole source** —
so on this evidence nothing would be lost by consolidating.

**Geometry is entirely absent.** Every coordinate spelling is 0%. The `dropoffLat`/`dropoffLng` pair
that `dispatch.js` reads on the **proof-of-delivery path** is never populated on these orders. That
reframes the earlier proposal: the compatibility projection was going to preserve a field that
production does not actually contain. **Coordinates are not a field to preserve — they are a
capability to add**, which is exactly why the canonical model treats `lat`/`lng` as first-class
rather than something to reconstruct from an address later.

**Two fulfilment vocabularies are live at once** — `fulfillmentType` (6) and `deliveryMethod` (3) —
and 3 orders state neither. The canonical `type` field must be written by one authority, and the
migration must read both.

## What it does NOT settle — and why nothing is retired yet

**Nine orders, one seller.** Enough to design against, nowhere near enough to prove every historical
order shares this shape. `deliveryAddress` and `address` therefore stay as **compatibility
projections** until a broader census covers more sellers. Retiring a field on a 9-order sample would
be exactly the reasoning this whole exercise exists to avoid.

## A census bug, found by the reader and fixed

The first run reported *"delivery orders with NO geometry at all: 8"* against a sample containing
only **5** delivery orders. That was wrong, and it was mine.

The top line bucketed orders three ways — pickup / stated-delivery / unstated — while the gap
counter used `!pickup`, which sweeps **stated delivery *and* unstated together**: 5 + 3 = 8. The
number was arithmetically explicable but described a different population than its label claimed.

Fixed by reporting the buckets separately, because they mean different things: a **stated** delivery
with no geometry is a *data gap*; an order with **no fulfilment type at all** is a *classification
gap* and may not be a delivery. Pickup orders carrying a destination are now counted too.

An **arithmetic self-check** was added: the buckets must sum to the sample, and each gap count must
sit within its own bucket. Nothing caught the original discrepancy — a reader had to notice 8 > 5.

**This does not change the design conclusion** (geometry is 0% under any bucketing) but it does
change the **migration gate**, which needs to know precisely how many records of each kind exist.

## Canonical model — frozen for design, not yet implemented

```
destination {
  type          pickup | delivery      ← one vocabulary; migration reads both existing keys
  label         Home | Work | Shop | Other
  recipientName
  phone
  building
  unit                                 house / apartment number
  street
  area                                 estate / area
  town
  instructions
  formatted                            the single human-readable line
  lat, lng                             FIRST-CLASS, not reconstructed
  placeId                              when available
}
```

`deliveryAddress` and `address` continue to be written as projections. **No new spelling is
introduced.** Pickup carries no destination.
