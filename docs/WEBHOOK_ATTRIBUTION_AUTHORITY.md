# webhookIntasend financial attribution — trace, design and implementation (Q6)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core). COMMITTED · STACKED.
NOT ON R1 · NOT DEPLOYED.** This is the D1 fix — the first change to an already-live payment
function in the Till/QR programme. Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-03

**Target:** `docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` D1 — `webhookIntasend` (confirmed the live
IntaSend endpoint, Q1 — re-verified below, unchanged) sources financial attribution
(`sellerUid`, `providerId`, `orderId`, `items`) from `payments/{ref}.meta`, which
`initiateSTKPush` writes **verbatim from the client's own request argument**, never
cross-checked against `paymentIntents/{ref}.metadata` — the server-derived record every
`payment-purposes.js` pricer exists specifically to produce.

---

## 1. Trace — the exact chain, re-verified this pass

`functions/index.js:6521` (`initiateSTKPush`) writes `payments/{ref}`: `meta: meta || {}` where
`meta` is `request.data.meta`, unmodified since Q1/Q3. `functions/index.js:8028`
(`webhookIntasend`, re-confirmed as the live endpoint below) is the ONLY consumer of that field
for money-moving decisions. Every read site, traced exhaustively this pass (line numbers as of
this commit):

| line | reads | used for |
|---|---|---|
| 8151 | `payData.meta?.category` | commission-rate lookup (`calculateCommission`) |
| 8219 | `payData.meta?.category === "subscription"` | whether to skip wallet credit |
| 8228 | `payData.meta?.type === "booking"` | legacy booking-earner routing |
| 8229-8230 | `payData.meta?.providerId`, `payData.meta?.sellerUid` | **wallet-credit destination** |
| 8318 (`_pm`) | `.sellerUid`, `.orderId`, `.hub`, `.sellerName`, `.address`, `.fulfillmentType`, `.items`, `.buyerName`, `.serviceDesc` | `_finalizeMarketplacePayment` call, `posReceipts/{apiRef}`, `sellers/{sellerUid}/clickAndCollect`, `packageRequests` delivery dispatch, notifications |
| 8521 (`m`) | `.type`, `.providerId`, `.providerName`, `.serviceDesc`, `.category` | legacy `bookings/{apiRef}` creation |

**The one branch already safe:** subscription activation (line 8570 onward) reads
`paymentIntents/{intentRef}.planId`/`.uid` directly — never `payData.meta`. This is the pattern
every other consumer above should follow and does not.

**`_finalizeMarketplacePayment` (line 3910), re-checked:** its own single-shop guard
(`_lineSellers.length > 1` → refuse) checks that an order's *line items* agree with each other.
It does **not** independently verify the `sellerUid` it is handed against `orders/{orderId}`'s
own recorded seller — confirmed again this pass, unchanged from Q3's finding. Whatever
`sellerUid` this function receives is trusted for wallet-credit and order-finalisation purposes.

**Re-verification of Q1 (still the live endpoint):** `webhookIntasend` (624 lines) remains a
strict superset of the unused `intasendWebhook` (254 lines) — wallet crediting, marketplace
finalisation, receipts, delivery dispatch, booking creation, subscription activation all exist
only in `webhookIntasend`. Nothing in this session touched IntaSend's dashboard configuration or
either function's route, so Q1's live Cloud Logging evidence (18/18 vs 47×200+10×400 over 30
days) stands unchanged. **`intasendWebhook` is not modified in this slice** — the trace found no
reason to.

---

## 2. A live-evidence finding that changed the design: commission `category` is OUT OF SCOPE

D1's own text names `meta.category` alongside `sellerUid`/`orderId` as client-tainted. Before
touching it, `functions/commission-config.js` was checked (it was not re-read in Q1-Q5):

- `RATES` is keyed by names like `marketplace`, `digital_products`, `services`, `events` —
  **not** by `payment-purposes.js`'s registry keys (`product_order`, `digital_download`,
  `service_booking`, `event_ticket`, `pos_till_sale`).
- `ALIASES` maps the **legacy, ad-hoc strings clients actually send** (`product`, `pos`,
  `restaurant`, `digital`, …) to the `RATES` keys — verified against live evidence documented
  in that file itself: *"all 11 live commissionLedger rows carry category `"product"` and
  commissionPct 5… mapping it deliberately is what makes the 5% intentional rather than
  incidental."*
- **None of `payment-purposes.js`'s registry keys appear in `ALIASES`.** Switching `category`'s
  source from `payData.meta?.category` to `intent.purpose` would silently resolve every
  non-subscription category to `RATES.default` (5%) — coincidentally correct for marketplace
  orders (5% either way) but **wrong for `digital_download` (should be 10%, `digital_products`)
  and every other category with a rate that differs from the default**. That is a silent
  commission-rate regression on live money, discovered by checking rather than assumed safe.

**Decision:** `category` stays sourced from `payData.meta?.category || "default"`, **unchanged,
out of scope for Q6.** Reconciling `payment-purposes.js`'s purpose vocabulary with
`commission-config.js`'s rate vocabulary is real, separate work — logged as a new item below,
not fixed here. This is a deliberate, evidence-based scoping decision, not an oversight.

## 3. What Q6 actually fixes: WHO is paid and WHAT resource is finalised — not the rate

Scoped to the fields where a mismatch misroutes money or mutates the wrong resource:
`sellerUid` (wallet-credit destination + order finalisation), `providerId` (booking-earner
routing — see "already-dead branch" below), `orderId` (which order is finalised, which stock
moves), `items` (server-priced lines, when the pricer already validated them), and — new with
Q5 — `sokoniTillId`/`shopId`/`branchId`/`merchantUid` for `pos_till_sale`.

**Deliberately deferred, unchanged:** `hub`, `sellerName`, `buyerName`, `address`,
`fulfillmentType`, `serviceDesc`, `providerName` — none of these exist in any
`payment-purposes.js` pricer's `metadata` today (they are cosmetic/logistics fields, not
money-routing ones), so closing them would mean extending several pricers' schemas — real,
separate, additive work, not bundled into this already-large slice. `address`/`fulfillmentType`
affect delivery *logistics*, not *payment authority* (the amount charged already accounts for
delivery fee server-side, in the pricer, before any of this); a tampered delivery address is a
real but different-class problem from a misrouted wallet credit, and is not what D1 was about.

## 4. `_isBooking`/`type==='booking'` — confirmed already-dead for the intent-backed flow

`functions/booking-payment-sweep.js`'s `holdServiceBookingPayment` (called at
`webhookIntasend` line 8150, **before** any of the code this slice touches) keys on
`paymentIntents/{intentRef}`, and returns `true` — which makes the webhook return immediately —
for any payment whose intent has `purpose: 'service_booking'`. So the legacy
`payData.meta?.type === "booking"` branch (lines 8228, 8521) is **unreachable today for any
booking that has a `service_booking` intent** — it only still matters for whatever legacy
`type:'booking'` traffic predates that intent (if any remains). Fixed anyway, for consistency and
defence in depth, at zero behavioural risk: when an intent's `metadata.type` is present it is
used; otherwise the exact legacy string is used, unchanged.

## 5. A genuine, newly-confirmed gap this fix closes: `pos_till_sale` has no attribution path at all

Traced concretely: for a `pos_till_sale` payment (Q5), the wallet-credit block's existing formula
— `payData.meta?.sellerUid || payData.uid` — has no `sellerUid` (till sales don't use that field;
the merchant is `till.merchantUid`, stored in `intent.metadata.merchantUid`). For the **dynamic
QR** flow this accidentally resolves correctly today (`payData.uid` is the cashier, and Q5's
authorization rule already requires the cashier's uid to equal `till.merchantUid`) — but for the
**permanent Till QR** flow, `payData.uid` is the **buyer** (whoever calls `createPaymentIntent`
next in that flow), so the existing formula would credit the *buyer's own wallet* with the sale
proceeds instead of the merchant's — confirmed by tracing the call chain, not merely by
inspection of the formula. This is exactly why the user's own suggested ordering put Q6
immediately after Q5: Q5's guarantee (client cannot establish `merchantUid`) does not survive to
a real credit without this fix.

---

## 6. Design — one shared, independently-certifiable attribution resolver

**New file: `functions/payment-attribution.js`.** A pure merge function
(`mergeAttribution({intent, legacyMeta})`, no Firestore) plus a thin I/O wrapper
(`resolveFinancialAttribution(db, {intentRef, legacyMeta})`) that loads
`paymentIntents/{intentRef}` once and delegates the decision to the pure function — the exact
methodology `functions/sokoni-qr-authority.js` (Q5) already established, reused rather than
reinvented, so `scripts/test-webhook-attribution.js` can certify the decision logic without an
emulator, the same way `scripts/test-sokoni-qr-payment.js` and `scripts/test-money-authority.js`
already do.

```
mergeAttribution({ intent, legacyMeta })
  intent has .metadata?
    YES -> { source:'intent',
             sellerUid:     m.sellerUid    || null,
             providerId:    m.providerId   || null,
             orderId:       m.orderId      || null,
             items:         Array.isArray(m.items) ? m.items : null,
             type:          m.type         || null,
             sokoniTillId:  m.sokoniTillId || null,   -- NEVER read from legacyMeta, ever
             shopId:        m.shopId       || null,   -- NEVER read from legacyMeta, ever
             branchId:      m.branchId     || null,   -- NEVER read from legacyMeta, ever
             merchantUid:   m.merchantUid  || null }  -- NEVER read from legacyMeta, ever
    NO  -> { source:'legacy_meta',
             sellerUid: legacyMeta.sellerUid || null, providerId: legacyMeta.providerId || null,
             orderId:   legacyMeta.orderId   || null, items: (legacy items, unchanged),
             type:      legacyMeta.type      || null,
             sokoniTillId: null, shopId: null, branchId: null, merchantUid: null }
             -- BYTE-IDENTICAL to today's behaviour for every not-yet-migrated caller (D2).
             -- Till-identity fields are NEVER populated from legacyMeta under any condition —
             -- there is no legacy Till flow to preserve compatibility with, so this is a hard
             -- floor, not a staged fallback (see §7's "missing/invalid intent" certification).
```

`webhookIntasend` calls this **once**, immediately after `payData = existing`, and reuses the
result everywhere §1's table lists — reducing the function to reading `attribution.*` instead of
`payData.meta.*` at each of those sites, and shadowing `_pm`/`m`'s `sellerUid`/`orderId`/`items`/
`type`/`providerId` fields with the resolved values via `{ ...payData.meta, sellerUid: attribution.sellerUid, ... }`-shaped local copies — so every downstream line that already reads
`_pm.sellerUid` etc. (receipts, `clickAndCollect`, delivery dispatch, notifications) gets the
authoritative value with no further changes, keeping the diff to an already-live 624-line
function as small as the fix allows.

**Wallet-credit destination, corrected formula:**
```js
const _isBooking = attribution.type === 'booking' || attribution.type === 'service-booking';
const _sellerId  = (_isBooking && attribution.providerId)
  ? attribution.providerId
  : (attribution.sellerUid || attribution.merchantUid || payData.uid);
```
`attribution.merchantUid` is the new fallback this slice adds — closing §5's gap. The final
fallback to `payData.uid` is **unchanged, pre-existing** behaviour (POS-cash-style flows where
the caller's own uid already is the seller) — not something Q6 introduces or removes.

**"Missing/invalid intent → no wallet credit to the wrong party" — how this is actually true:**
Q6 does not add a new refusal path to the webhook (which would risk failing a legitimate,
already-paid transaction closed). Instead it is true **by construction**: Till-identity fields
are populated *exclusively* from a verified `pos_till_sale` intent (§ above) and never from
client-suppliable `legacyMeta` — so a payment with no valid Till intent simply has no
`merchantUid` to credit as a Till sale, and falls through to the pre-existing, harmless default
(the payer's own uid, per the formula above) rather than to any attacker-chosen party. No
existing, already-working category's behaviour is touched, and D2's remaining unmigrated callers
are unaffected — matching the same "stage, don't break" discipline `initiateSTKPush`'s own
Stage 1a/1b already established in this exact codebase.

---

## 7. Certification — `scripts/test-webhook-attribution.js`

Same pure-core methodology as Q5 (`scripts/test-sokoni-qr-payment.js`) — no Firestore, no
emulator, no network. Certifies `mergeAttribution` directly.

Mapped explicitly against the user's certification list:

| requirement | how certified |
|---|---|
| valid webhook → correct intent → correct Till/merchant → correct amount → fan-out occurs | `mergeAttribution` with a real `pos_till_sale`-shaped intent resolves `merchantUid`/`shopId`/`branchId`/`sokoniTillId` correctly; amount is untouched by this slice (already enforced pre-webhook by `initiateSTKPush`, unmodified) — fan-out wiring verified by code inspection (§6), not re-tested (the fan-out itself — `creditWalletTxn`, `commissionLedger`, idempotency transaction — is pre-existing and untouched). |
| tampered client metadata → ignored/rejected | with a valid intent present, hostile `legacyMeta.sellerUid`/`orderId`/`providerId`/`sokoniTillId`/`merchantUid` are all proven ignored — the returned attribution matches the intent, never the tampered legacy fields. |
| wrong merchant → denied | Till-identity fields proven to NEVER populate from `legacyMeta` under any circumstance, intent present or not — the strongest form of "denied": there is no code path where a client-chosen merchant reaches `_sellerId`. |
| wrong amount → denied/pending, per the existing contract | out of scope for this file — already enforced, unmodified, by `initiateSTKPush`'s Stage 1a/1b (`functions/index.js:6561-6692`), verified present and untouched by this slice's diff. |
| replayed webhook → no duplicate financial effect | the transactional COMPLETE-claim and every `walletCreditedAt`/`.create()` idempotency guard are pre-existing and untouched by this slice's diff (verified by inspection of the diff, not re-tested — nothing here introduces new state). |
| different payment reference → independent evaluation | `mergeAttribution` is a pure function of its own two arguments — no shared/global state, certified directly by calling it twice with different fixtures and observing independent results. |
| missing/invalid intent → no wallet credit to a wrong party, no Till attribution | proven: `mergeAttribution({intent:null, legacyMeta})` and `mergeAttribution({intent:{no metadata}, legacyMeta})` both return `sokoniTillId/shopId/branchId/merchantUid: null` unconditionally — certified for `legacyMeta` fixtures that DO try to smuggle these fields in, proving they're dropped, not merely absent by coincidence. |

Plus a **negative control** and a **sabotage control** (a weakened copy of `mergeAttribution`
with the "Till fields never come from legacyMeta" guard removed, proven to wrongly leak a
hostile `legacyMeta.merchantUid` through — the same methodology Q5's sabotage control used).

---

## 8. New finding, logged separately — commission category/purpose vocabulary mismatch

Appended to `docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` as **D4**: `payment-purposes.js`'s registry
keys have no corresponding entry in `commission-config.js`'s `ALIASES`, so any purpose relying on
`intent.purpose` for its commission category (were it ever wired that way) would silently
resolve to the 5% default rather than its correct rate. Not exploitable today (category is not
sourced from `intent.purpose` anywhere, per §2's decision) — logged so nobody wires it that way
later without seeing this.

---

## What this slice does NOT do

Does not change `intasendWebhook` (confirmed still unnecessary). Does not change `category`/
commission-rate derivation (§2 — deliberately out of scope, evidence-based). Does not change
`initiateSTKPush`'s amount enforcement, the webhook's transactional idempotency claim, or any
`walletCreditedAt`/`.create()` guard. Does not extend any `payment-purposes.js` pricer's schema
to carry `hub`/`sellerName`/`buyerName`/`address`/`fulfillmentType`/`serviceDesc` (deferred, §3).
Does not build the buyer-facing payment page, `/pay/q/**`, or any POS-paid-transition signal for
`pos_till_sale` (still Q7's job — `_holdServiceBookingPayment`-style handling for Till sales does
not exist yet, deliberately). Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D1 target, D4 new finding) ·
`docs/SOKONI_TILL_QR_IMPLEMENTATION.md` (Q5, the `pos_till_sale` metadata shape this slice
consumes) · `docs/INTASEND_WEBHOOK_ENDPOINT_RESOLUTION.md` (Q1, re-verified §1) ·
`functions/payment-attribution.js` (new) · `functions/index.js` (`webhookIntasend`,
`_finalizeMarketplacePayment`, `initiateSTKPush` — read, only `webhookIntasend` modified) ·
`functions/commission-config.js`, `functions/finos-utils.js` (`calculateCommission` — read, not
modified, the basis for §2's scoping decision) · `functions/booking-payment-sweep.js`
(`holdServiceBookingPayment` — read, not modified, the basis for §4's finding) ·
`scripts/test-webhook-attribution.js` (certification)
