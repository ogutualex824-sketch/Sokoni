# SOKONI Till identity — design (Q2 of the Till/QR gate)

**Status:** 📋 DESIGN ONLY. No collection created, no code written. Answers the seven questions
posed for Q2; does not implement any of them. Q1 (`docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md`)
is resolved; this does not depend on redoing it.
**Date:** 2026-09-03 · Builds on `docs/SOKONI_TILL_QR_PAYMENT_TRACE.md`'s finding that a Till
identity is the one genuinely net-new component — every other piece already exists to be joined.

---

## Grounding facts, checked before designing anything

- **`shops/{uid}`** (`firestore.rules:1435`) — the shop document id **is the seller's own uid**.
  Today's model is one shop per seller account, not a `shopId` independent of `uid`. "Multi-shop
  checkout" (`functions/multishop-checkout-quote.js`) means a **buyer's** basket spanning several
  **different sellers'** shops in one payment — not one merchant owning several shops. This
  resolves Q2.1 concretely rather than by assumption.
- **`branchId`** already exists as a real, used concept one level below shop
  (`posUpsertProduct`'s `branchId`, defaulting to `merchantId + '-main'` when absent) — the
  existing precedent for "a merchant might have more than one physical point of sale under one
  shop."
- **No sequence-counter pattern exists anywhere in `functions/`** — every human-facing id in this
  codebase (`RCP-`, `ORD-POS-`, `SKN` refs) is timestamp+random, not an incrementing counter.
  This is deliberate elsewhere (avoids Firestore hot-document contention on high-frequency writes
  like orders), but Till creation is **rare** (a handful of events per merchant, ever) — the
  contention concern that rules out a counter for orders does not apply here.
- **One shared platform IntaSend account** (established in the Q1-preceding trace) — no
  per-merchant IntaSend sub-account exists or was found implied anywhere.
- **The immutable-identity + status-lifecycle pattern is already this codebase's house style** —
  `delivery-pin.js`/`delivery-complete.js`/`seller-handover.js` (this session's own prior work)
  all use exactly this shape: an identity is minted once, never mutated, and a separate `status`
  field carries the lifecycle. The Till design below follows the same convention deliberately,
  not as a new invention.

---

## Q1 — One shop, one Till, or multiple?

**One ACTIVE Till per (shop, branch) as the v1 default — not a hard one-per-shop rule.**

Given `shops/{uid}` is 1:1 with the seller account today, "one Till per shop" and "one Till per
merchant" are the same statement in v1. But keying the Till to `(shopId, branchId)` rather than
`shopId` alone costs nothing now and avoids re-keying later: a merchant who later opens a second
physical counter (already a real concept via `branchId`) gets a second Till scoped to that
branch, without a schema migration. `branchId` defaults to `${shopId}-main` when a merchant has
only one counter, so v1 usage is indistinguishable from "one Till per shop."

**Enforcement:** at most one Till with `status: 'ACTIVE'` per `(shopId, branchId)` pair — checked
transactionally at issuance (see Q4). A `DISABLED` or `RETIRED` Till does not block a new one for
the same branch; it is simply no longer the one a fresh QR would be minted against.

## Q2 — Can a Till move between shops?

**No.** `shopId` and `merchantUid` are part of the Till's identity, not a mutable pointer — set
once at creation, never reassigned. This is the direct consequence of "immutable once issued"
(the user's own stated preference) applied literally: if a Till could be re-pointed at a
different shop, every historical payment intent that carried that `sokoniTillId` would silently
change whose sale it was retroactively describing. If a business changes hands, the correct
operation is **retire the old Till, issue a new one** for the new owner — not a transfer.

## Q3 — What happens when a shop is retired?

**All of that shop's Tills move to `RETIRED`, cascaded, not left `ACTIVE` on a shop that no
longer trades.** This must be a side effect of shop retirement, not something a Till itself
detects — the Till has no independent signal that its shop was retired unless something tells it.
Concretely: whatever function retires/deactivates a `shops/{uid}` document is the one that must
also transition every `sokoniTills` document with that `shopId` to `RETIRED` in the same
operation (or a triggered follow-up), for the same reason `onOrderStatusChange`-style triggers
exist elsewhere in this codebase — a state change with a real consequence needs an authoritative,
server-side propagation path, not a hope that every future reader checks the shop's status
independently.

**Historical payment intents and payments already reference the Till by its immutable id (Q2) and
are untouched** — a `RETIRED` Till does not retroactively invalidate or hide the sales it already
processed. It only stops being a valid target for a *new* payment intent (see Q3 of the ordering,
`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md`'s next gate).

## Q4 — How is the Till identifier generated?

**Shop-scoped sequence, minted transactionally, formatted for humans:** `SK-{SHOPCODE}-{NNNN}`
(matching the user's own `SK-KASS-0001` example) as a **display label**, with the Firestore
document id being that same string (human-readable ids are already this codebase's convention for
low-frequency, human-facing identities — `receipts/{paymentId}` display labels, `SKN` refs).

- `SHOPCODE` — derived once from the shop's own name/handle at first Till issuance for that shop
  (sanitised, uppercased, truncated — the same `_san`-style sanitisation already used throughout
  `pos-qr.js`), stored on the shop or on the first Till so every subsequent Till for that shop
  reuses the identical code rather than re-deriving it and risking drift.
- `NNNN` — a **per-shop** counter, not a global one. Global sequence counters are the contention
  pattern this codebase already avoids for high-frequency writes; a per-shop counter for an
  event this rare (a handful of Tills per merchant, ever) has no contention problem at all, and
  gives the human-readable, incrementing numbering the user asked for (`0001`, `0002`, ...).
  Minted inside the SAME transaction that enforces Q1's "at most one ACTIVE per branch" check —
  read the shop's counter doc, read for an existing ACTIVE Till on this branch, and only if both
  checks pass, increment the counter and create the Till document, all atomically. This is the
  exact shape `claimAvailableDelivery`'s first-claim-wins transaction (already proven, earlier
  this session) already uses for a different resource.
- The **internal** `sokoniTillId` (the field every payment intent actually references) can be
  this same human-readable string directly — there is no reason for a second, opaque internal id
  here the way `pos-qr.js`'s payment *transaction* ids need to be opaque (Q5 covers why the QR
  token itself must still be opaque, which is a separate concern from the Till's own identifier).

## Q5 — How is the Till authenticated when a QR is scanned?

**Not by trusting the QR's contents — by the same signed-opaque-token pattern already proven in
`pos-qr.js`, applied to the Till instead of a transaction.** The QR encodes only an opaque,
HMAC-signed reference (`https://mysokoni.co.ke/pay/q/{signedRef}`), never the `sokoniTillId`,
shop name, or amount in cleartext-modifiable form. Server-side resolution:

```
signedRef  →  verify HMAC (reuses pos-qr.js's _sign()/timingSafeEqual pattern)
           →  sokoniTills/{sokoniTillId}  (the Till this signature was minted for)
           →  status === 'ACTIVE'?  (a DISABLED/RETIRED Till's QR must fail closed, not silently resolve)
           →  shopId, merchantUid  (read from the Till document, never from the QR itself)
```

For the **permanent** merchant QR (mode 1): the signed reference is the Till's own id, minted
once at Till creation and printed once — scanning it always resolves to the same Till, and the
buyer supplies the amount on the payment page (server still owns the actual charge amount from
whatever the buyer enters, validated at the `paymentIntents` stage, not trusted from the QR).

For the **dynamic POS QR** (mode 2, the prioritised one): the signed reference is a **payment
intent's** id, not the Till's directly — the intent itself carries `sokoniTillId` as one of its
resolved, server-derived fields (see Q3 of the payment-flow ordering, next gate). Scanning
resolves intent → Till → shop, in one hop, with the Till's `ACTIVE` status re-checked at
resolution time (not just at intent-creation time) so a Till disabled mid-transaction fails the
scan rather than completing a payment for a shop that has just been taken offline.

## Q6 — How is the IntaSend collection configuration associated?

**Not per-Till, in v1 — inherited from the single platform account, with the field present for
when that changes.** The Q1-preceding trace confirmed no per-merchant IntaSend sub-account exists
anywhere in this codebase today; `payment-config.resolveCollectionRoute()` was found named as the
existing routing seam. `intasendCollectionAccount` on the Till document should therefore be a
**pointer, not a credential** — either `null`/a constant meaning "the one platform account," or,
if `resolveCollectionRoute()` already supports naming a route, the route identifier it expects.
**The Till never stores an API key or secret of its own** — collection credentials stay exactly
where they already live (`INTASEND_PRIVATE_KEY`, Secret Manager), unchanged by this design. This
field exists so that if SOKONI ever does introduce per-merchant sub-accounts, the Till identity
does not need a schema migration to carry it — but nothing in the current architecture requires
building that now.

## Q7 — Can a Till be disabled without deleting historical payments?

**Yes, by construction, not by a rule that needs to be remembered.** Because Q2 makes
`sokoniTillId` immutable on every payment intent/payment it touches, and Q3's cascade only ever
writes `status`, never deletes or rewrites a Till document, disabling (or retiring) a Till is
purely a `status` transition on the `sokoniTills/{id}` document itself. No payment, intent,
receipt, or ledger entry references anything that changes — they hold a copy of the Till's
identity fields at the time they were created (matching how `payment-purposes.js`'s
`service_booking` pricer already uses an immutable snapshot rather than a live re-read, for the
identical reason: a later change to the source-of-truth record must not retroactively alter a
figure or an identity a past transaction already relied on).

---

## Proposed schema — `sokoniTills/{sokoniTillId}`

```
sokoniTillId        string   the doc id itself, e.g. "SK-KASS-0001" — human-readable, immutable
shopId               string   == shops/{uid}'s uid — immutable (Q2)
branchId             string   defaults to `${shopId}-main` (Q1) — immutable
merchantUid          string   == shopId today; kept as its own field so a future shop/merchant
                               split (see Q1's caveat) does not require renaming this one
status               string   'ACTIVE' | 'DISABLED' | 'RETIRED'  — the ONLY mutable field (Q7)
currency             string   'KES' — immutable, matches every other payment surface traced
qrVersion            number   starts at 1; bumped only if the signing scheme itself changes
                               (e.g. HMAC key rotation), NOT on every re-print
intasendCollectionAccount  string|null   routing pointer only, never a credential (Q6)
createdAt            timestamp
createdBy            string   uid of whoever issued it (merchant self-service, or admin)
sequenceNumber        number   the NNNN this Till consumed from its shop's counter (Q4) — kept
                               for audit even though it is embedded in the id string
statusHistory         array    { status, at, by } — append-only, so a DISABLED->ACTIVE reversal
                               is visible, not silently overwritten
```

`shopTillCounters/{shopId}` (or a field on the shop document itself) holds the per-shop counter
and the derived `SHOPCODE`, read+incremented only inside the Till-issuance transaction (Q4).

---

## What this design does NOT do

Does not create the `sokoniTills` collection. Does not write any Cloud Function. Does not decide
the exact shop-retirement trigger's file/location (flagged as "whatever function retires a shop"
— that function was not identified in this pass; identifying it is implementation work, not
design). Does not touch `firestore.rules`. Does not implement Q3 of the flow ordering (payment
intent attachment to a Till) — that is the next gate. Not deployed. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` (the existing-authority trace this design sits on top of) ·
`docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1, resolved first) · `functions/pos-qr.js` (the
signed-opaque-token pattern reused for Q5, not its `posPayments`/completion path — explicitly
excluded per instruction) · `firestore.rules:1435` (`shops/{uid}`, the grounding fact for Q1/Q2)
