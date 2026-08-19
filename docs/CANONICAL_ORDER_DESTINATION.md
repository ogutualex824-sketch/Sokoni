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
