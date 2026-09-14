# Merchant Onboarding Chain — browser → account → application → approval → shop → workspace

**Status:** repo chain REPAIRED and tested · **production chain still BROKEN — nothing here is deployed**
**Date:** 2026-09-07
**Related:** [[Marketplace]] · [[Authentication]] · [[Orders]] · [[Payments]] · [[SmartPOS]]

---

## The chain, as designed

```
browser → create account            auth / signup
      ↓
Start Selling                       sokoni-merchant-entry.js  (resolve → destination)
      ↓
seller intake wizard                onboarding-seller.html    (4 steps + Seller Agreement)
      ↓
applications/{uid}--merchant        sokoni-merchant-application.js   ← STAGE 2A · a REQUEST
      ↓                             status: pending_review, agreementAccepted: true
admin decision                      applicationDecide  (admin-os · admin · moderation · super-admin)
      ↓
projectSeller                       ← STAGE 2B · server-side, the ONLY writer of this transition
      ↓
shops/{shopId}   + sellers/{uid} + users.activeShopId + roles[] + Auth claim + trial + till
      ↓
merchant workspace                  MERCHANT_URL (production: /merchant-v2)
```

Two facts the whole design rests on:

* **Submission grants nothing.** `sokoni-merchant-application.js` writes exactly one document and
  no role, claim, shop or subscription. `firestore.rules` (`noAdminFields()`) would reject the
  alternative anyway.
* **Approval is the only thing that creates a shop**, it happens server-side, and it runs
  *before* the role is granted — so a shop that cannot be established means no role is handed
  out, rather than an "approved merchant with nowhere to sell from".

---

## What was broken, and is now fixed (in this repo)

### 1. No merchant could file an application at all — `onboarding-seller.html`

The page built a Firestore adapter and **never passed it**. `submit()` requires `fs` and throws
without it, so every submission ended in *"Not submitted — a firestore adapter is required."*

The module's own suite could not catch this: it injects its own adapter, so it exercised the
module perfectly while the only real call site was dead. `scripts/test-merchant-application.js`
**PART F** now reads every real call site statically and asserts it passes what `submit()`
requires. Proven by sabotage: removing `fs: adapter` turns the suite red (exit 1).

### 2. Every filed application was un-approvable — the Seller Agreement gate

`applicationDecide` refuses to approve unless `agreementAccepted === true`
(`failed-precondition`). `hub-register.js` (the *provider* intake) wrote it;
`sokoni-merchant-application.js` (the *merchant* intake) never did.

So even with #1 fixed, the outcome would have been: merchant applies → sees "pending review"
forever → reviewer clicks Approve → error they cannot clear from the dashboard → **no shop, ever.**

Now:

* `AGREEMENT_VERSION` is shared with `hub-register.js` — one acknowledgement, one version string.
* The acknowledgement is a **precondition of building the document**: no acknowledgement, no
  application. Refusing loudly at submit time is the only way the merchant learns now rather than
  discovering it as an approval that never comes.
* Strict `=== true`. `'yes'`, `1`, `'true'`, `{}`, `[]` are all refused (PART E).
* `agreementVerifiedAt` / `agreementVerifiedVersion` are server-stamped and now in `FORBIDDEN`, so
  a client cannot make an unacknowledged application look verified.
* A resubmission must re-acknowledge **at the current version** — a stale acceptance of
  superseded terms does not carry forward.
* `onboarding-seller.html` shows both commission lanes and the KES 10 minimum (read from the
  generated schedule, never typed), gates the submit button, and reads the checkbox **at submit
  time** — not cached from an earlier step.

### 3. Admin OS could not approve anybody — `admin-os.html`

Admin OS had 21 panes and **no Applications view**. An operator living in the console could see
products and orders but could not approve the merchant who would create them, and could not see
who was waiting. Approval existed only in `admin.html`, `moderation.html` and `super-admin.html`.

Added: **Applications & Approvals** — approve / reject / suspend / request-info / reconcile,
through the same `applicationList` + `applicationDecide` + `applicationReconcile` the other three
surfaces use, so the four cannot disagree. Notably:

* the *"approved, not published"* filter — approved with `projectionStatus !== 'applied'`, i.e. a
  merchant with a role and **no shop**, which is invisible in every other view;
* the toast reports **what the server says it wrote** (`receipt.writes[].shopId`); an approval whose
  projection did not report a shop is *not* celebrated;
* the Seller Agreement refusal is translated into the action that fixes it ("use Request info"),
  because it is the commonest refusal and its remedy is not obvious;
* a failed read renders *"Could not load applications — this is not 'no applications'"*, never an
  empty table.

### 4. Admin OS could not see shops, sellers or employees

Added **Shops & Sellers** plus three `_h`-only handlers in `functions/admin-os.js` — no new Cloud
Run service, they ride `adminOsDispatch`:

| op | answers |
|---|---|
| `adminGetShops` | every shop, its owner, its origin (`application_approval` or not), and **ownerless** shops |
| `adminGetSellers` | every seller joined to its shop, flagging **`shopMissing`** — approved, nowhere to sell from |
| `adminGetShopDetail` | one shop whole: owner, `activeShopId` agreement, staff, and counts |

Two deliberate choices:

* **Employee rows are corroborated, not merely read.** `firestore.rules` lets any signed-in client
  create a `shopEmployees` document, so the collection contains rows nobody vetted. The same
  three-way check `listShopEmployees` applies (canonical key · known role · `shopOwnerId` matches
  the shop owner) is applied here, and failures are **shown as disputed**, not filtered away — an
  operator needs to see a forgery attempt.
* **Product counts are reported three ways** (`sellerUid`, `sellerId`, `shopId`). Ownership is
  enforced on `sellerUid` in the rules but the other two are queried elsewhere in this codebase.
  One number would be a guess about which field a shop's writers used; three are evidence, and a
  disagreement between them is itself the finding. See [[project_posretailsales_field_divergence]].

### 5. A failure wearing a success heading

The submitted-modal heading was fixed at *"📋 Application submitted"* while its body could read
*"Not submitted."* Heading and icon now move with the outcome.

---

## What is still broken, and cannot be fixed from here

**Production is `d592d8f` on `release/r1-pos-printer-fn` (v632). This working tree is
`release/multishop-checkout-certified`, whose `version.json` says `fa5082b` — BEHIND live.
Deploying hosting from here would roll production back.** See `scripts/deploy/guard-no-rollback.js`.

Measured on production 2026-09-07:

| Hop | Production today | Evidence |
|---|---|---|
| `sokoni-merchant-application.js` | **404** — absent from the `d592d8f` tree | `curl` + `git cat-file -e d592d8f:…` |
| `/onboarding-seller` | pre-2A build; writes only `onboardingCompleted`, a log nothing reads | 0 hits for `SokoniMerchantApplication` |
| "Start Selling" | `/offer` → *Sell products* → `seller.html` | live `sokoni-merchant-entry.js` |
| `seller.html` | self-mints `sellers/{uid}` + `businesses/{uid}` **client-side**, no application, no approval, no `shops/{shopId}`, no `activeShopId` | live source |
| `applicationDecide` / `List` / `Reconcile` / `applicationLifecycle` | **deployed** | `firebase functions:list` |
| `/super-admin`, `/moderation`, `/admin` | approval UI **live and wired** | live source |
| `admin-os.html` | no Applications pane | live source |

So on production **no merchant application can be filed, and none ever has been through this
path** — which matches the finding in [[project_store_identity_gate]] that the only applications
in production carry `role: driver`. The approval half is live and correct; the intake half is not
deployed.

### Deploy requirements

1. **Hosting** — from a tree at or ahead of live, never from this one:
   `sokoni-merchant-application.js` (currently 404), `onboarding-seller.html`, `admin-os.html`,
   `sokoni-aos.js`.
2. **Functions** — `adminOsDispatch` must be **redeployed** for `adminGetShops` /
   `adminGetSellers` / `adminGetShopDetail` to resolve. No new service is created; until then the
   dispatcher answers `not-found` and the Shops & Sellers pane says the read failed (it does not
   pretend the registry is empty). The Applications pane needs **no** functions deploy.
3. **Verify live** with a cache-buster and confirm `version.json` carries the deploy commit.

---

## Known debt surfaced while doing this

`sokoni-aos.js` calls **11 ops that have no backend at all** — neither whitelisted for
`adminOsDispatch` nor exported by `functions/index.js`:

`adminGetCampaigns` · `adminCreateCampaign` · `adminUpdateCampaignStatus` · `adminDeleteCampaign` ·
`adminSendEmailBlast` · `adminSendSMSBlast` · `adminGetCohortAnalysis` · `adminGetConversionFunnel` ·
`adminGetRetentionMetrics` · `adminGetWalletOperations` · `finosGetEscrowAccounts`

Each throws, is swallowed by its call site's `.catch(() => ({}))`, and renders as an empty state —
so Marketing, Cohort/Funnel/Retention, Wallet Ops and Escrow tell an operator *"there is nothing
here"* when the truth is *"this was never built"*. **Pre-existing; not introduced by this work.**
Held as a fixed baseline in `scripts/test-admin-os-wiring.js`, which fails if the list grows *or*
if an entry is fixed and left in it — so it can only shrink.

---

## Tests

| Suite | Result | What it protects |
|---|---|---|
| `scripts/test-merchant-application.js` | **54/0** | the 2A document; the agreement gate (PART E); **every real call site** (PART F) |
| `scripts/test-admin-os-wiring.js` *(new)* | **286/0** | nav ↔ pane ↔ loader ↔ backend, for every Admin OS section |
| `scripts/test-application-decision-authority.js` | **17/0** | approval authority — its two mutation controls now actually load |
| `scripts/test-start-selling-route.js` | 22/0 | entry routing |
| `scripts/test-merchant-route-gate.js` | 168/0 | merchant route gate |

Every detector above was **sabotage-verified** — the check was broken on purpose and the suite
went red by exit code, then was restored. One sabotage found a real hole: a conditional op string
(`_call(x ? "a" : "b")`) is invisible to a static reader, so deleting `adminGetShops` from the
dispatch whitelist still passed. Fixed on both sides — the call site now names its op as a
literal, and **check D0** fails any `_call` site that does not, because a dynamic site does not
fail an assertion, it *removes* assertions.

See [[feedback_syntax_is_not_a_postcondition]] · [[feedback_orphaned_binding_check]] ·
[[project_seller_approval_signal_divergence]] · [[project_merchant_entry_convergence]]

---

## Commission — the two lanes (owner ruling 2026-09-07)

| Your plan | Marketplace orders | In-shop POS / Till |
|---|---|---|
| Free | **15%** | 5% |
| Basic | **10%** | 5% |
| Pro | **5%** | 5% |
| Enterprise | **0%** | 5% |

A subscription buys a smaller cut of the orders SOKONI **provides**. It buys nothing on a sale the
merchant made at their own counter. Minimum KES 10 per sale, **except** where the plan's rate is 0%.

**Where it lives:** `functions/commission-config.js` only — `MARKETPLACE_PLAN_RATES` and
`POS_PLAN_RATES`. `scripts/verify-commission-single-source.js` fails the deploy if a second table
appears. Never copy either into `sub-billing.js` or into a client.

**How POS stays off the ladder:** the ladder is keyed on the **RAW** category
(`MARKETPLACE_SELLER_CATEGORIES`), not the resolved one, because `ALIASES.pos = 'marketplace'`
means a till sale *resolves to* the marketplace category. `pos` is deliberately absent from that
set. The alias must stay — it also decides the 48-hour settlement term (`_is48hCommission`).

**Client parity:** `sokoni-commission-rates.js` (generated) exposes `marketplacePct(plan)`,
`posPct()` and `isMarketplaceSellerSale()`. `test-marketplace-plan-ladder.js` PART H compares the
browser against the config for every plan spelling — this platform has already shipped a
"shown 3%, charged 5%" split, and under a ladder that error is 3x.

Regenerate the snapshot after ANY config change: `node scripts/build-commission-snapshot.js`.

### Open — needs an owner decision, not a guess

`subscriptions.html` advertises a **different four-plan ladder** — free / starter / pro / business
at **15 / 10 / 7 / 4** — in a vocabulary that does not correspond to the catalogue
(`seller_free` / `seller_basic` / `seller_pro` / `seller_enterprise`). Nothing in the repo says
which of its plans is which of ours. `starter` and `business` are therefore **not mapped**: they
fall to Free (15%), the fail-safe. Mapping `business -> seller_pro` would charge 5% where the
fail-safe is 15% — an undercharge decided by an assumption, and undercharging stays invisible until
reconciliation. **Someone must state the mapping**, and then the page's numbers should be read from
the snapshot rather than typed.

`merchant-v2.html` mentions commission in 5 places and does **not** load
`sokoni-commission-rates.js`. Same class of risk; it needs the snapshot and the two-lane copy.

## Approval completeness — what changed 2026-09-07

| Requirement | State |
|---|---|
| Till created **and ACTIVE** on approval | already correct — `mintSokoniTillCore`, `onExisting:'return'`, `status:'ACTIVE'` |
| Storefront created on approval | `shops/{shopId}` + `sellers/{uid}` (what `store.html` reads) — already correct |
| Business **directory** listing on approval | **FIXED** — `projectSeller` now writes `businesses/{uid}`; its only previous writer was the client-side wizard. Suspension retracts it. |
| Approved merchant lands on `merchant-v2` | **FIXED** — `MERCHANT_URL` was `/merchant` here while production already served `/merchant-v2` |
| Merchants ≠ service providers | **FIXED** — an explicit `type: 'seller'` now beats keyword guessing. A shop selling *health* or *legal* products was being projected into a provider registry and got no shop, no till, no storefront. |
| Agreement tick box | present on `onboarding-seller.html`, `seller.html`, `hub-register.js`; version synced across all three writers |

`verified` on `businesses/{uid}` is deliberately **not** set by approval — it drives a trust badge
and the homepage seller count, so it stays an explicit admin action.

## Still NOT built — do not read the above as covering these

* **Marketplace settlement split** (commission to SOKONI, remainder credited to the merchant's
  account). The rates are now correct; the **collection rail is not built** —
  `pos-commission-collection.js` reserves `_railRegistry = {}` marked "deliberately EMPTY: adding
  one is a commercial decision". Today commission is *recorded as payable*, not deducted.
* **Delivery split** (commission to SOKONI, remainder to the rider's wallet). See
  `project_delivery_pin_payout_track` and `project_rider_payout_double_rail`.
* **Buyer PIN generated on the order and required before release.** Open track.
* **Supply page → merchant-v2** and **Sales Control Centre (SCC)** convergence.
