# Daraja STK — binding the client-supplied `sellerUid` to real sell authority

**Status:** implemented, certified, **NOT DEPLOYED**
**Branch:** `chore/adopt-entitlements-index`
**Step:** 1 of 2 in the payment-rail separation (Step 2 = enforce POS-only Daraja at the backend)

---

## The defect

`darajaSTKPush` ([functions/index.js](../../functions/index.js)) opened with:

```js
if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
const { sellerUid, phone, amount, orderId, description, hub, items } = request.data;
```

That is **authentication, not authorization**. `sellerUid` arrived from the client and was never
checked against the caller, yet everything downstream spends it as if it named the caller's own
merchant:

| Line of the handler | What it does with the *claimed* `sellerUid` |
|---|---|
| pricing loop | reads and prices that merchant's catalogue, rejects cross-seller carts |
| `delivery_fee_mismatch` / `delivery_fee_unverified` | **writes** `auditLogs` rows stamped `merchantId: sellerUid` |
| `payment_amount_mismatch` | **writes** an `auditLogs` row stamped `sellerUid` |
| `shopSettings/{sellerUid}` | reads that merchant's live Daraja consumer key, secret, passkey, shortcode |
| STK push | sends an M-Pesa prompt to a **caller-chosen phone**, `BusinessShortCode`/`PartyB` = that merchant's shortcode |

So any signed-in user could name any merchant and drive that merchant's collection rail: STK
prompts to arbitrary phone numbers under a shortcode they do not own, plus audit rows attributed to
a merchant who never acted. Verified before the fix: `assertMerchantAccess|_assertSellAuthority|
authorizeActor|assertMerchantOperator` matched **0 times** anywhere in the handler.

There is **no separation between the two rails today — not even by convention.** An earlier
reading of this workstream held that every `darajaSTKPush` caller is a POS surface sending its own
uid. **That is false**, and the correction changes what Step 2 costs.

`sokoni-mpesa.js` is not a POS file. It is a shared `SokoniMpesa.pay()` helper, and it is loaded by
ten consumer pages and called from eight of them, where the caller is a **buyer** paying a
**different** seller:

| Surface | `hub` sent | Caller is |
|---|---|---|
| [bnb.html](../../bnb.html) | `bnb` | buyer |
| [car-rental.html](../../car-rental.html) / [car-hub.html](../../car-hub.html) | `car` | buyer |
| [delivery.html](../../delivery.html) | `delivery` | buyer |
| [digital.html](../../digital.html) (2 sites) | `digital` | buyer |
| [healthcare.html](../../healthcare.html) | `healthcare` | buyer |
| [landlord.html](../../landlord.html) | `property` | buyer |
| [legal-hub.html](../../legal-hub.html) | `legal` | buyer |
| [pos.js](../../pos.js), [merchant-v2.html](../../merchant-v2.html), [till.html](../../till.html) | `pos` | the merchant |

[checkout.html](../../checkout.html), [legal.html](../../legal.html) and
[payments.html](../../payments.html) also load the helper.

The handler compounds this: every record it persists defaults to `hub: hub || "marketplace"`, so
the Daraja rail currently **labels itself marketplace** — the exact opposite of the intended
separation.

## The fix

One guard, placed immediately after argument validation and **before the rate-limit read**, so an
outsider is refused before any read or write is attributed to the merchant they named:

```js
const { _assertSellAuthority: _assertDarajaSellAuthority } =
  require('./pos-zero-friction')._internal;
await _assertDarajaSellAuthority(request.auth, String(sellerUid),
  'initiate an M-Pesa payment for this merchant');
```

### Why this authority and not a new one

It is the **same** authority `posCompleteCheckout` already enforces. A copy would drift, and the
union-of-two-models reasoning inside `_assertSellAuthority` is exactly the part that must not be
re-derived by hand. It accepts:

1. platform `admin` / `superAdmin` claims;
2. `shops/{uid}` + `shopEmployees` with the `sell` capability (`merchant-identity` model);
3. `businesses/{id}.ownerId` (the shared merchant-ownership primitive);
4. an **active** `posStaff` row for that merchant.

Requiring `sellerUid === auth.uid` instead would have locked out every employee-operated till —
ordinary selling cashiers live in `shopEmployees`, POS-native merchants in `businesses`/`posStaff`.
A `posStaff`-only guard was already written and **rejected by test** earlier in this workstream for
precisely that reason. See [[project_employee_attribution_audit]].

### Wiring

`_assertSellAuthority` was module-local. It is now exported from
[functions/pos-zero-friction.js](../../functions/pos-zero-friction.js) as `_internal`, mirroring
`merchant-identity.js`. It is **not** a callable: `firebase-functions` discovers endpoints from
`index.js`'s exports, and `index.js` re-exports the eight `posZF` callables by name — never this
object — so nothing new is deployed as a function.

The `require` is **lazy, inside the handler**, because `pos-zero-friction` calls `getFirestore()` at
module scope and must keep loading after `admin.initializeApp()`. The module is already in cache by
request time, so it costs nothing. `index.js` already uses in-handler requires for
`payment-config` and `shared/delivery-engine.js`.

## Blast radius — UNVERIFIED THIS SESSION, and it is not small if the premise is wrong

**This is the open risk on Step 1 and it must be settled before deployment.**

The claim that the path is inert rests on a **code comment** recording a 2026-07-22 audit
(`shopSettings`: 0 documents, `posPayments`: 0 rows) and the retirement of the surfaces that wrote
those credentials (`payments.html`, `pos.js`, `seller.html`). **It has not been re-verified.** This
session has no gcloud identity and no `GOOGLE_APPLICATION_CREDENTIALS`, so live Firestore could not
be read. A five-week-old comment is not evidence.

The two outcomes are very different:

- **If `shopSettings` is still empty** — every one of the eight consumer surfaces above already
  fails with `not-found: Daraja credentials not configured`. They are **already dead CTAs**. The
  guard then changes only the error text, and Step 1 is free.
- **If any seller has configured Daraja since July** — the guard **refuses those buyers**, because a
  buyer legitimately has no sell authority over the seller they are paying. That is a live
  regression on eight consumer payment paths.

**Required before deploy:** count `shopSettings` documents and `posPayments` rows in production.
One read settles it.

Whatever that read says, the hole is worth closing **before** anything re-enables this path. Its
successor, `payment-config.js → resolveCollectionRoute()` (`CENTRAL_MOR`), inherits the same
binding.

Two further consequences, stated rather than discovered later:

1. A solo seller with Daraja credentials but **no** `shops/{uid}`, **no** `businesses/{uid}` and no
   staff row would now be refused. Any migration that re-populates `shopSettings` must create the
   corresponding merchant record too.
2. **Step 1 pre-empts part of Step 2.** Requiring sell authority means a marketplace or services
   buyer can no longer use the Daraja rail at all — which is the rail separation the user asked
   for, arriving early and as a side effect rather than as a decision. The two steps are therefore
   **coupled and must ship together**, and the migration of those eight consumer surfaces to
   IntaSend is a commercial decision for the user, not something to be absorbed silently here.

## Certification

`scripts/cert-daraja-sell-authority.js` — **45 passed, 0 failed, 0 inconclusive**.

It invokes the **real exported callable** (`darajaSTKPush.run({ data, auth })`) against a Firestore
emulator. It does not re-implement the guard.

**How a pass is distinguished from a denial.** An authorized caller is *not* expected to succeed —
it is expected to get **past** the guard and fail later at the credential stage, with a message
asserted to be **not** authorization-shaped. Without that negative control a completely broken
handler would score 100%. No Daraja network call is ever reached: every case terminates at or before
the `shopSettings` lookup.

| Group | Cases |
|---|---|
| Positive controls (first) | owner via `shops/{uid}`; active cashier via `shopEmployees`; platform admin; owner via `businesses.ownerId`; active `posStaff` |
| The defect | outsider names A; outsider names B; A's owner names B; B's owner names A; A's cashier names B; unknown merchant id |
| Revoked access | terminated cashier; suspended `posStaff` — resolution is at call time, not from a cached session |
| Missing authentication | no `auth` object; `auth` with no `uid` |
| Ordering | outsider **with line items and a mismatched delivery fee** — the exact shape that produced merchant-attributed `auditLogs` rows — refused with zero mutation |
| Shared authority | the guard resolves from `pos-zero-friction._internal`, no second authority is defined inline, and it precedes the rate-limit read |
| Preserved behaviour | server pricing authority, delivery recompute, oversell guard, cross-seller cart guard, order dedup, rate limit, `enforceAppCheck: true`, collection-route stamping |

Every denial also asserts **zero mutation** across `auditLogs`, `posPayments`, `shopSettings`,
`products`. "It threw" is not enough: a handler throwing for an unrelated reason scores identically.

### Sabotage — 4 / 4 caught

`scripts/sabotage-daraja-authority.js`. Each mutation **changes behaviour**; the verdict is the
certification's own summary line, and `functions/index.js` is restored and **verified by hash**.

| # | Mutation | Result |
|---|---|---|
| S1 | guard deleted outright (the pre-fix state) | CAUGHT — 12 failures |
| S2 | guard binds the caller to *themselves*, not to the named merchant | CAUGHT — 7 failures |
| S3 | a second, local always-allow authority replaces the shared one | CAUGHT — 12 failures |
| S4 | guard moved *after* the merchant-attributed pricing work | CAUGHT — 3 failures |

The four failure counts differ, which is the point: the assertions discriminate between *kinds* of
breakage rather than failing as a block. The baseline is asserted green first — a red baseline would
make every mutation look caught.

### Regressions (unchanged)

| Suite | Result |
|---|---|
| `cert-pos-checkout-authority.js` | 24 passed, 0 failed |
| `cert-pos-cashier-callables.js` | 49 passed, 0 failed |
| `test-commission-domain-separation.js` | 103 passed, 0 failed |
| `test-ledger-settlement-state.js` | 32 passed, 0 failed |
| `npm run predeploy` | exit 0 |

## Not in scope of this step

- **`sendTestSTKPush`** was inspected and has **no equivalent hole**: it derives the merchant from
  `request.auth.uid`, never from the payload, and restricts the target to the seller's own
  registered phone. It does, however, lack `enforceAppCheck` — noted, not changed here.
- **Step 2** — enforcing POS-only Daraja at the backend rather than by convention.
- The `hair-beauty` commission category remains deliberately fail-closed.

## Deployment

**None.** Certified and committed only. Deployment is a separate, explicitly authorized step.

Related: [[project_pos_authority_root]] · [[project_tenant_boundary_merchantid]] ·
[[project_collection_route_two_rails]] · [[project_merchant_owned_payments]] ·
[[feedback_never_infer_authz_from_client_writer]]
