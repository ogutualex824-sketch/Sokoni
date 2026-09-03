# Order PIN / Dispatch Authorization — trace against the existing system

**Status:** 📋 READ-ONLY TRACE. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · **Headline: this is not a new feature. A mature, security-conscious version
of exactly this already exists, mid-rollout, in three layers — and it already implements the core
safety property you're asking for: PIN verification is separated from money release, by design,
proven in production for one of the two events.**

Do not design a new system on top of this without reading it first — that would recreate the
"two systems that had never met" pattern found repeatedly elsewhere this session (procurement,
messaging, inventory).

---

## What already exists — three layers, traced in full

### Layer 1 — the vulnerability this was built to close (now fixed, documented in the fix itself)

`functions/delivery-complete.js`'s own header records the *old*, unsafe path: the rider's own
client compared the typed PIN against `data.proofPin` — a plaintext value **the rider's own client
had already fetched** — then the rider's client wrote `orders/{id}.status = 'delivered'` directly
(permitted by the then-rules), which triggered a real wallet credit. *"So the rider authorised
their own payout, and the PIN was decoration."* This is exactly the failure mode your message
opens with concern about — it already happened here, and was already fixed.

### Layer 2 — `functions/delivery-complete.js`, **PHASE 1, LIVE AND ENFORCING TODAY**

This is the **completion** event — your "customer provides completion PIN" step, already built and
already the authoritative path:

- `completeDeliveryWithPin` — the rider submits the buyer's PIN. Server-side only: assignment
  checked before the PIN (so the endpoint can't be used as a PIN oracle by a stranger), PIN format
  validated, **fails closed if the HMAC secret is missing** (no guessable fallback — the shadow
  layer below is allowed a fallback because it authorizes nothing; this function authorizes money,
  so it isn't), constant-time hash comparison, **5-attempt lockout** (`MAX_ATTEMPTS`,
  `resource-exhausted` once exceeded — your "PIN_LOCKED" state, already implemented).
- `buyerConfirmDelivery` — a fallback when the buyer can't produce the PIN, restricted to the buyer
  themselves, with an explicit anti-self-dealing check (a rider who is also the order's buyer is
  refused).
- **The exact safety property you're asking for is already proven here, not merely intended**: PIN
  verification writes `orders.status = 'delivered'` inside a transaction. It does **not** touch a
  wallet. The header comment states this deliberately: *"The credit is NOT performed here... the
  existing rail is already exactly-once... This changes WHO can cause the first `delivered`
  transition, not what happens after it."*
- **Traced the credit itself**, not taken on the comment's word: `functions/index.js`'s
  `onOrderStatusChange` (an `orders/{orderId}` update trigger, separate function, separate
  concern) watches for the transition and credits the rider via a **deterministic**
  `walletTransactions/{riderUid}_{orderId}_delivery` document inside its own transaction — the
  same doc id every time a given order's delivery is processed, which is what makes a retry
  exactly-once rather than a double-credit.

**This already is your invariant**, proven for the completion event:
```
PIN VERIFIED (rider_pin or buyer_confirmation)
    → orders.status = 'delivered'   (delivery-complete.js — no money)
    → onOrderStatusChange fires     (index.js — separate trigger, separate function)
    → walletTransactions/{rider}_{order}_delivery credited, exactly once
```

### Layer 3 — `functions/delivery-pin.js`, **PHASE 0, SHADOW — not yet authoritative**

This is where your "dispatch PIN" idea already lives, unfinished:

- `deliveryPinOnAccept` — fires when a `packageRequests/{id}` document transitions into
  `driver_accepted`. Generates a 6-digit PIN server-side, stores only an **HMAC hash** on the
  package request (never plaintext — a document the assigned rider has full read access to), and
  the plaintext goes to a **separate** `deliveryPins/{orderId}` collection with **no Firestore rule
  at all** (deny-by-default — not even the buyer can read it directly; `getMyDeliveryPin` is the
  only path, and it proves buyer identity and explicitly refuses the rider).
- `deliveryVerifyShadow` — **the two-stage split you're proposing already exists as a documented
  concept in this exact file**: *"Two-PIN stage: 'pickup' (seller handover → custody) or 'delivery'
  (money release). Shadow verifies the Phase-0 deliveryPin for both **until distinct pickup/
  delivery codes land at cutover**."* That sentence is this feature, already scoped, already named,
  not yet built.
- Explicitly labeled shadow: *"DOES NOT gate delivery completion or any payout... this only
  observes, so we can prove the new verification pipeline is reliable on production data before
  enforcing it."* Its own attempt counter is deliberately **separate** from the completion path's
  (`deliveryShadowAttempts` vs `deliveryVerifyAttempts`) specifically so shadow telemetry traffic
  can never exhaust the real lockout budget.

---

## Mapping your proposed contract onto what's already there

| your design | what exists today | gap |
|---|---|---|
| 4-digit PIN | **6-digit** (`_gen6()`, `deliveryPinVersion: 6`) | a real difference — 4 digits is materially weaker (10,000 vs 1,000,000 combinations) even behind a keyed HMAC; not something to silently narrow |
| server-generated | ✅ exactly this, both layers | — |
| stored hashed, not plaintext | ✅ HMAC-SHA256, keyed by a secret (`SOKONI_HMAC_KEY`), on the document a rider can read; plaintext lives in a **separate, unreadable-by-any-client** collection | — |
| single-use / attempt-limited | ✅ completion layer: 5-attempt lockout, `resource-exhausted`. Shadow layer: its own separate counter, deliberately not gating anything yet | — |
| bound to orderId, bound to assigned rider | ✅ both layers check `assigned === uid` before touching the PIN at all — "checked before the PIN so a stranger cannot use this endpoint as a PIN oracle," in the code's own words | — |
| never accepted from client as an authority value | ✅ — verification is server-side HMAC comparison in both layers; the client can send a guess, never assert a result | — |
| **SELLER ACCEPTS ORDER → seller reveals PIN to assigned rider** | **does not exist.** Searched for a distinct seller-acceptance event, separate from rider assignment — none found. The real trigger is `claimAvailableDelivery`, a **rider-initiated claim from an available-delivery pool** (`driver_accepted`), not a seller approving a specific rider | this is the largest real gap — your contract assumes a seller-mediated handoff; the live dispatch model is pool-claim-based. This is an architecture question, not an implementation detail, and isn't answered by anything traced here |
| dispatch PIN → starts ride, no payout; separate completion PIN → releases money | **conceptually identical to what Phase 0's comment already states as the plan** ("distinct pickup/delivery codes... at cutover") — but not yet built. Both stages currently verify against the **same single hash**, and only the delivery stage's shadow result is even recorded (`wouldAllow`) — pickup-stage shadow verification exists in code but issues no state transition of any kind, real or shadow-flagged, today | this is the actual remaining work — not a new system, a cutover of an already-scoped plan |
| PIN invalidated if rider/order assignment changes | not verified in this pass — not traced; genuinely open, not assumed either way |

---

## Certification status, checked not assumed

- `scripts/test-delivery-pin-buyer-path.js` — **run this pass: 20/20 passing**, including *"no
  audit entry carries the PIN value"* and *"'No PIN yet' is an answer, not a failure."*
- `scripts/test-delivery-authorization.js`, `scripts/test-delivery-sequence.js` — both require a
  live Firestore emulator, unavailable in this environment (same limitation hit earlier this
  session with `test-chat-history-boundary.js`) — **could not run, not claimed as passing.**
- `functions/delivery-complete.js` itself exposes `exports._h` specifically *"so the test suite can
  exercise the same functions the callables use, not a reimplementation"* — the certification
  discipline this session has been building toward is already the house style here.

---

## What this trace recommends, without deciding it

**This should not become a new "Order PIN / Dispatch Authorization" system designed from a blank
page.** The safety architecture you're describing — PIN proves presence/authorization, a *separate*
state transition follows, an *independent, already-proven* settlement trigger decides money, never
the PIN handler itself — is not a recommendation to adopt here. **It is the existing, live,
certified design of the completion half of this exact feature.** The real next decision is narrower:

1. Does the **pool-claim dispatch model** (`claimAvailableDelivery`) get replaced or extended with
   a seller-mediated acceptance step, or does "dispatch authorization" mean something else inside
   the existing pool-claim flow (e.g., a pickup-custody proof, which is what Phase 0's own
   "pickup" stage name already suggests, rather than a seller hand-picking a rider)?
2. If distinct pickup/delivery codes are built (completing Phase 0's stated plan), does the pickup
   stage get its **own** lockout/audit/hash infrastructure, or does it reuse
   `delivery-complete.js`'s already-proven pattern directly (recommended — it's already certified,
   already fail-closed, already exactly the shape needed)?
3. 4 digits vs. the existing 6 — a real security tradeoff to decide explicitly, not silently narrow.

## What this trace does NOT do

Does not design a dispatch-authorization callable. Does not decide the seller-acceptance question.
Does not verify "invalidated if rider/order assignment changes." Does not touch
`functions/delivery-pin.js`, `functions/delivery-complete.js`, or any other file.
Does not touch `C:/temp/sok-r1`.

## Related

standing project memory: `project_delivery_pin_payout_track` ("settlement gates on PROOF; PIN at
creation; pickup handover LIVE — no UI yet") and `project_rider_payout_double_rail` (FIXED) — both
independently corroborated by this trace, at the source level rather than by recollection.
