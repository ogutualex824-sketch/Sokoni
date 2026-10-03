# Merchant v2 — target architecture (receipts, POS, workspace)

**Status:** TARGET, recorded deliberately. **Nothing here is built.** It exists so the remaining
messaging / location / release gates can be closed without anyone inventing a parallel POS or a
second receipt model in the meantime.

Related: [[CANONICAL_ORDER_DESTINATION]] · [[MESSAGES_PLATFORM_CENSUS]] · [[MERCHANT_SHELL_CAPABILITY]]

---

## 1. Merchant v2 is the workspace; POS Setup is advanced configuration

```
approval → shop setup → MERCHANT V2  ← the operating workspace
                          Dashboard · Orders · Sell/POS · Messages · Inventory
                          Customers · Payments · Delivery · Receipts · Analytics
                             ↓
                    Print / Share / WhatsApp / Delivery
```

**`pos-setup.html` stops being a doorway.** An approved merchant with an active shop sells from v2
immediately. POS Setup becomes **Settings → POS & Terminals**: printer pairing, terminal
registration, multiple tills, receipt templates, cashier permissions, payment-terminal config, test
prints, diagnostics, offline testing, advanced tax/receipt settings.

Configuration is for merchants who need it, not a toll gate for merchants who don't.

## 2. Receipt identity — one record, reconcilable

Every receipt carries enough to reconcile it, whether the sale began online or at the counter:

```
receiptId  orderId  transactionId  createdAt
sellerUid  shopId   terminalId?    paymentMethod  fulfillmentType
```

`terminalId` is present only where a terminal exists — absent for a phone sale, and **not**
fabricated.

### The timestamp rule

**The stored timestamp is the SERVER's and is immutable. The device clock is display only.**

A phone clock is user-settable and must never be the authority on a financial record. The UI
formats local time for the merchant; the receipt, order, payment, POS sale and delivery record all
carry the *same* server timestamp, so the same sale never appears at two different times in two
different views.

This mirrors what `merchantAdjustStock` already does — `serverTimestamp()` written inside the
transaction alongside the value it timestamps.

## 3. Sell → receipt, in one surface

Sell captures items, discount, payment method, cash received and change, and fulfilment — pickup or
delivery — without leaving v2. On completion it shows the receipt id and server time, with **Print**
and **Share** side by side (as the order sheet already does), plus View Order / Send Receipt /
Start New Sale.

**Delivery capture feeds the canonical destination, not a POS-only address model.** That is the
whole reason this document exists: the destination contract
([[CANONICAL_ORDER_DESTINATION]]) is **still unresolved**, and building a POS location form now
would add an eleventh spelling to the ten already measured.

> **Blocked until the destination census runs.** POS may read an existing destination; it must not
> write one.

## 4. P58E should be owned by the shell, not an iframe

The printer connection belongs to the v2 shell's device layer, so a merchant can
**sell → pay → change → pickup/delivery → complete → print → share → sell again** without a page
change.

**Today v2 frames POS**, and an iframe cannot share a GATT handle without a native rebuild. That is
already recorded as the expected cause if the P58E device check fails across
`v2 → POS → Orders → Analytics → POS` ([[RUNBOOK_p58e_and_pos_device_checks]]). This is the
architectural reason to eventually render POS natively — not a reason to start now.

## 5. Sequencing — what must close first

```
1  messaging authority        DONE   51/0 code, not deployed
2  history scoping            DONE   21/0 rules (emulator), not released
3  canonical destination      BLOCKED — data census not yet run
4  messaging Function release  one coherent deploy
5  premium Messages UI
6  receipts + native POS       ← this document
```

**Nothing in section 3 may be built before item 3 closes.** A beautiful POS location form on top of
ten competing destination fields would be the most expensive mistake available here.

## 6. Explicitly NOT a licence to

- create a second POS, a second receipt model, or a POS-only address schema
- write any new destination field
- trust the device clock for a stored financial timestamp
- make POS Setup a prerequisite for selling
- render a receipt total that was not produced by the same server authority as the order

## Header chrome: profile menu

The shell header carries the shared avatar → account dropdown → role switcher, mounted from `sokoni-profile-menu.js` (the same module `shared-header.js` injects on every other page). Authority, API and certification: [[SHARED_PROFILE_MENU]].

## Availability: the schedule saves through the server (2026-10-03)

Availability is **server-authoritative** (owner rule). The Merchant V2 schedule editor (`#availability`, built in
`6775b09`) used to write `providerAvailability/{uid}` and `shops/{uid}.openingHours/hours` **from the browser**. Its
SAVE now goes to **`kasshop.setShopAvailability`** (owned by sokoni-2f, `convergence/commercial-fn-on-ef1e992`) via
the shell's `_callable()` (same App Check path as every other merchant callable). The UI is unchanged.

| | Before | After |
|---|---|---|
| Save | `setDoc(providerAvailability/{uid})` + `updateDoc(shops/{uid})` | `_callable('setShopAvailability')({ schedule: { hours, overrides } })` (+ `shopId` for an employee) |
| Who decides the shop | `S.uid` (the browser) | server: owner from auth, employee via `shopId` + `manageAvailability` |
| `shops/{id}.openingHours` | human string (`formatWeek`) | the SAME structured object as `providerAvailability.hours` (server, same transaction) |
| Overrides | merged (a removed date could survive) | REPLACED by the server (a removed date stops applying) |
| Failure | toast; shop-record write could half-succeed | honest message, form stays unsaved, **no fallback write — ever** |
| Load | direct `getDoc(providerAvailability/{uid})` | unchanged (rules govern reads) |

- "Saved" is shown only after the callable **resolves with `success: true`**.
- Not available (`not-found` / `internal` / `unavailable` / offline, or the pre-schedule 2026-09-09 build answering
  `No availability fields supplied.`) → *"Couldn't save — the schedule service isn't available yet. Nothing was changed."*
- Client preflight mirrors the server's limits (≤6 periods a day, ≤120 dates, dates from 31 days ago to 400 days ahead).
  An out-of-range date **blocks** the save with its name — never silently pruned, because the server replaces the map.
- Proof: `scripts/test-merchant-availability-server-save.js` (token-aware static scan of every merchant file, VM run of
  the real save code, contract cross-check against 2f's source, negative control `--control=reinsert-setdoc`).

**DEPLOY PRECONDITION (hard):** requires functions: setShopAvailability live (verify with a functions list before the hosting deploy).
It must be the **schedule-capable** build from 2f's functions release. On 2026-10-03 the listed `setShopAvailability`
is the 2026-09-09 build (`setshopavailability-00003-fab`, live switches only): a name in the list is necessary but
NOT sufficient — confirm the deployed revision carries `schedule`. Order: 2f functions release (lineage gate + owner
go-ahead) → this hosting change → f3's rules deny on client `providerAvailability` writes.

**Gaps handed to 2f / follow-ups (not fixed here):**
- `shops/{id}.hours` (the human-readable copy the old client wrote) is no longer refreshed by any merchant save; the
  server writes only `openingHours` (structured). Any reader of `shops.hours` as text sees the last pre-cutover value.
- The editor still READS `providerAvailability/{S.uid}` — correct for an owner; an employee session reads its own uid's
  document (pre-existing). `getShopAvailability` (settings mode) is the server read that resolves the owner.
- Override fields other than `closed` / `periods` / `label` are not kept by the server; the editor never edits any.
- `availability-manager.html` and `provider-dashboard.html` still write `providerAvailability` from the browser —
  provider/booking surfaces, outside Merchant V2; their own slice.

Related: [[SHOP_AVAILABILITY_AUTHORITY]] · [[AVAILABILITY_CERT_ACCEPTANCE]]

### Availability → paid service bookings: locked prerequisite and regression plan (owner, 2026-10-03)

Availability is a **locked prerequisite for certifying paid service bookings**. Sequence (each step gates the next):

1. This schedule-editor change (merchant-v2 saves via `setShopAvailability`) — built, not deployed.
2. 2f's functions release carrying the schedule-capable `setShopAvailability` (lineage gate + owner go-ahead), **then**
   this hosting change. Precondition: requires functions: setShopAvailability live (verify with a functions list before the hosting deploy).
3. Verify availability is server-authoritative: f3's rules deny on client `providerAvailability` writes is live.
4. The booking regression below. 2f's booking side (commercial-fn `8d127ab`): `booking-service._prepareSlot` consults
   `kasshop.verdictFor` at the slot's instant (not taking orders, closed date, temporary closure, canonical hours);
   slot locks are taken in the booking transaction.

**QUEUED runtime suite — `scripts/test-availability-booking-regression.js`** (written, NOT run: needs Auth + Firestore +
Functions emulators). It **refuses** (exit 2) unless every emulator host is localhost, the project is `demo-*`, and no
`GOOGLE_APPLICATION_CREDENTIALS` is set (refusal verified 2026-10-03 with no env and with a production project id).

| Row | Asserts | Note |
|---|---|---|
| R1 | provider B → `setShopAvailability({ shopId: A, schedule })` is `permission-denied`, A's document unchanged | |
| R2 | a direct browser write to `providerAvailability` is rejected (403) | **BLOCKED until f3's rules deny is loaded** (`SOKONI_F3_RULES_DENY=<commit>` + the rule present) — never a pass before then |
| R3 | two concurrent bookings of one slot → exactly one succeeds, exactly one slot lock | |
| R4 | booking on a closed date / during a temporary closure (both set via the callable) → refused | `CLOSED_DATE` / `TEMPORARILY_CLOSED` |
| R5 | schedule saved via the callable is what `verdictFor` uses: inside hours books, outside is `out-of-range`; re-saving moves the gate | |
| PC | positive control: a plain in-hours booking succeeds | if it fails, R3–R5 are BLOCKED (fixture), not pass/fail |

Exit: 0 pass · 1 fail · 2 refused · 3 blocked rows only. Fixture is a salon with a fee-0 service. **Paid Education and
electronics receipts stay OFF** (owner) — the suite never enables or test-enables them.
