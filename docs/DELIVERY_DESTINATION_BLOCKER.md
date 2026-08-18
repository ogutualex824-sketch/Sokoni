# Delivery Destination — Architecture Blocker

**Status:** OPEN — **blocks any new write of a delivery destination, including from POS.**
**Nothing in this document has been changed in code. It is a trace, not a fix.**

Related: [[MERCHANT_SHELL_CAPABILITY]] · [[CANONICAL_COLLECTIONS]] · [[ODPC_COMPLIANCE]] ·
[[MERCHANT_2D2_QUEUE]] · [[DELIVERY_PIN_PAYOUT]]

---

## 0. The decision this document exists to hold

POS is being extended toward creating delivery orders. The obvious next step — have POS write the
customer's delivery destination — **must not be taken yet.**

There is no canonical order-destination authority. There are at least **eight** spellings in live
code, the two server write paths disagree, the dispatch consumer hedges between two of them, and
the privacy purge spec knows about only four of them in only one of the two collections involved.
Adding a ninth representation from POS would not be a feature; it would deepen a defect that
already reaches customer privacy and delivery proof.

> This is exactly the kind of blocker worth discovering **before** merchants start creating
> delivery orders rather than after.

---

## 1. What is actually written today (measured)

### 1a. The order writer stores the same destination three times

`functions/index.js:2834-2842` — the paid-order document:

```js
deliveryAddress: deliveryAddress || "",
…
dropoffLat:      _dLat || null,
dropoffLng:      _dLng || null,
deliveryCoords:  (_dLat != null && _dLng != null) ? { lat: _dLat, lng: _dLng } : null,
```

`dropoffLat/dropoffLng` and `deliveryCoords` are **derived from the same two variables** and written
side by side. One destination, three fields, no declared authority among them, and nothing that
keeps them consistent through any later update. Whichever a future writer touches, the other two
go stale silently.

### 1b. A second write path drops the geometry entirely

`functions/index.js:8170` — the `packageRequests` document created on the payment path:

```js
deliveryAddress: _pm.address || _pm.deliveryAddress || "", deliveryCoords: null,
```

No `dropoffLat`, no `dropoffLng`, `deliveryCoords` hard-coded to `null`, and the address sourced
from `_pm.address` — an **additional** spelling — before falling back to `deliveryAddress`.

**An order created through this path has a destination string and no destination geometry at all.**
A rider routing from coordinates gets nothing.

`functions/pos-marketplace-sync.js:250-268` creates the *same* `packageRequests/DEL{orderId}`
document on `status === 'ready'` with the same shape — `deliveryAddress: order.deliveryAddress ||
order.address || ''`, and again **no coordinates whatsoever**. So the POS-adjacent path is already
creating delivery records with an address and zero geometry.

### 1c. The dispatch consumer hedges — which is the proof nobody knows

`functions/dispatch.js:327-328`, inside proof-of-delivery validation:

```js
dropoffLat: delivery.dropoffLat || delivery.deliveryCoords?.lat,
dropoffLng: delivery.dropoffLng || delivery.deliveryCoords?.lng,
```

A consumer that reads two spellings with `||` is a consumer that **cannot rely on either**. This is
not a cosmetic hedge: it sits on the path that decides whether a delivery was genuinely completed
at the customer's location. A destination the writer put in a third spelling makes this validation
fall through to `undefined`, and a GPS proof compared against `undefined` is not a proof.

### 1d. Customer-facing email reads different fields in different templates

`functions/email-triggers.js` — `:344` and `:853` read `dropoffAddress`; `:685` reads
`deliveryAddress`. Two emails about the same delivery source the destination from two different
fields.

### 1e. The rider-facing job uses a third vocabulary again

`sokoni-gip-dispatch.js:138-141` — `dropoffLat`, `dropoffLng`, `dropoffAddress`.

### The spellings, counted

| spelling | shape | seen in |
|---|---|---|
| `deliveryAddress` | string | order writer, packageRequests, POS sync, email, payment-trust, api-gateway |
| `dropoffAddress` | string | email templates, GIP rider job |
| `address` | string | payment path `_pm.address`, POS sync fallback |
| `deliveryCoords` | `{lat,lng}` | order writer, dispatch fallback, orders |
| `dropoffLat` / `dropoffLng` | scalars | order writer, dispatch, GIP rider job |
| `dropoffCoords` | `{lat,lng}` | present in code |
| `dropoff` | `{lat,lng,address}` | test suite, mock data |
| `deliveryLocation` | — | present in code |

### NOT a destination — do not conflate

`deliveryLocations/{riderId}` is **the rider's live GPS**, not the customer's destination. Confirmed
from `firestore.rules:1823` — the document is keyed by `riderId`, written by that rider
(`request.auth.uid == riderId`), and read by the rider, admins, and an explicit `viewers` list
written by the dispatch CF. It is a tracking mirror. Anything that treats it as the delivery
destination is wrong twice over: wrong data, and a privacy boundary crossed.

---

## 2. Why this is a blocker and not a cleanup task

### 2a. Firestore rules cannot settle it

Rules can validate a field they are told to expect. They cannot decide which of eight spellings is
authoritative, and they cannot reconcile two documents in two collections written by two code paths.
Adding rule validation now would freeze the ambiguity into the security layer, and the ruleset has
**1,693 bytes free** against the compiled ceiling — there is no room to encode eight spellings
defensively even if that were the right move.

### 2b. It already reaches ODPC compliance — a live finding

`functions/account-purge-spec.js:44` anonymises the `orders` collection and redacts exactly four
destination fields:

```js
redact: { buyerName: 'Deleted User', buyerPhone: null, phone: null, deliveryName: null,
          deliveryAddress: null, deliveryCoords: null, dropoffLat: null, dropoffLng: null }
```

Two consequences, both measured:

1. **The other spellings are not redacted.** `dropoffAddress`, `dropoff{}`, `deliveryLocation` and
   `address` are absent from the list. A destination stored under any of them survives an account
   deletion.
2. **`packageRequests` does not appear in the purge spec at all.** A grep for `packageRequests`
   across `functions/account-purge-spec.js` returns nothing — yet §1b shows that document is
   created with `buyerName`, `buyerPhone`, `buyerUid` **and** `deliveryAddress`.

**A deleted customer's name, phone number and home address remain in `packageRequests`.** That is a
data-subject-erasure gap under the registration already held (`630-8669-F056`), and it exists
*because* the destination lives in more than one place under more than one name.

### 2c. Delivery proof is downstream of it

§1c puts a destination-field mismatch directly on the proof-of-delivery path. This is the same
subsystem where the rider-payout and delivery-PIN work is already open. Adding a new destination
representation from POS before this is settled risks writing a destination the proof validator
cannot see.

---

## 3. The required sequence — POS writes come LAST

```
  1. existing order writer      index.js:2834  +  index.js:8170
            │                   (two paths that already disagree)
            ▼
  2. Firestore                  what is actually stored, per collection,
            │                   on real orders — orders AND packageRequests
            ▼
  3. dispatch consumers         dispatch.js, sokoni-dispatch.js, navigation.js,
            │                   sokoni-logistics.js, email-triggers.js
            ▼
  4. rider consumers            GIP job shape, rider app, proof validation
            │
            ▼
  5. DECIDE the canonical order-destination representation   ← the actual gate
            │                   one address field, one geometry field, one shape
            ▼
  6. document it                docs/CANONICAL_COLLECTIONS.md + this file
            │
            ▼
  7. rules / security review    validate the ONE representation; extend the ODPC
            │                   purge spec to cover it AND packageRequests
            ▼
  8. POS READS it               POS may display a destination it did not author
            │
            ▼
  9. POS may create / update it
```

**POS is at step 8 at the earliest. It is currently being asked to act at step 9.**

### Until step 5 is decided

- **POS must not write any delivery destination field.** Not a new spelling, and not one of the
  existing eight — picking one of eight without authority is still authoring a convention.
- **POS may read** an existing destination for display, tolerating absence with a neutral state
  (`—`, `No address on file`) and never an invented or defaulted address.
- **No new consumer may add another `a || b` hedge.** Each one makes the eventual convergence
  harder and hides the divergence from anyone reading a single call site.

---

## 4. What is NOT claimed here

Stated plainly, because this document will be used to justify *not* building something:

- **No canonical representation is proposed.** Choosing one is step 5 and requires the writer →
  Firestore → dispatch → rider trace to be run against **real order documents**. This document
  traces the *code*; it has not read production data.
- **The eight spellings are a code census, not a data census.** How many real orders actually carry
  each field is unmeasured. Some spellings may be dead.
- **The ODPC gap in §2b is derived from the purge spec's own contents**, not from an executed purge.
  It should be confirmed by running the purge worker against a test account that has a
  `packageRequests` document.
- **No claim that dispatch is broken today.** The hedge in §1c works for the paths that write
  `dropoffLat`. It is fragile, not failing.
