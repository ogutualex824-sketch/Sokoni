# Entertainment Hub — architecture and completion report

**Status:** 2026-09-26, branch `feat/creator-hub`. Implemented and certified locally.
**FUNCTION DEPLOYMENT 0 · HOSTING DEPLOYMENT 0 · RULE DEPLOYMENT 0 · PROVIDER CALLS 0 · PRODUCTION WRITES 0.**

Related: [[ENTERTAINMENT_CATEGORY_MATRIX]], [[CREATOR_HUB]], [[CREATOR_PAYMENT_ARCHITECTURE]],
[[CANONICAL_MONEY_VERSION_DECISIONS]], [[PRODUCTION_COMMISSION_MISMATCH]],
[[REFUND_AUTHORITY_CONVERGENCE]], [[DECISION_ANONYMOUS_CREATOR_PURCHASE]].

This slice made the existing work converge. It did not rewrite it:

- Creator Hub, the entitlement engine, the payment intents, hosted checkout, the payment-capability
  authority, the fos* refund authority, application-lifecycle / role-authority and AdminOS were all
  **reused**.
- New code exists only where a chain was broken:
  - event ticket payment and settlement;
  - organizer approval;
  - the category registry;
  - AdminOS › Entertainment;
  - the profile menus.

## Architecture

```
                              SOKONI
                                │
                        Entertainment Hub
          (functions/shared/entertainment-registry.js — one list)
                                │
     ┌──────────┬───────────────┼───────────────┬──────────────┐
  Creator    Streaming        Events         Performers       Venues
  30/70      Creator type     3 % net        provider rate    no payment
     │          │               │               │               │
 film_access  film_access   event_ticket   service_booking   enquiry
     │          │               │
     └──── createPaymentIntent (server price) ── STK / hosted (proven only)
                                │
               webhookIntasend → payments/{ref} COMPLETE
             (film_access + event_ticket are SELF-SETTLING: no generic credit)
                                │
                   entitlement-engine.activate — exactly once
                 ┌──────────────┴──────────────┐
          royalty ledger                event settlement
          (quarterly, dual control)     (held → event end + 24 h → wallet)
                 └──────────────┬──────────────┘
                     fos* refund authority (C)
                                │
         AdminOS: Creator Hub panel · Entertainment panel · Applications
                  (Admin / Super Admin, server-checked; nothing in admin.html)
```

## B. Commercial policy matrix

The authority is `functions/shared/commercial-policy.js`. It holds **no rates**. Each policy points at
the authority that owns its rate. `scripts/test-event-settlement.js` proves the values resolve, and that
an unmapped Entertainment category is **refused**: there is no global Entertainment rate.

| Transaction / category | Commission | Basis | Rate authority |
|---|---:|---|---|
| Creator Hub (and Streaming) | 30 % SOKONI / 70 % creator | net of provider fee | `shared/creator-commercial.CREATOR_PPV` (3000 / 7000 bps) |
| Online marketplace sale | 15 % | gross | `commission-config.MARKETPLACE_PLAN_RATES` (flat) |
| POS / Till | 5 % | gross | `commission-config.POS_PLAN_RATES` |
| Quick Charge (a POS line) | 5 % | gross | the POS lane |
| Events | 3 % per ticket | net of provider fee | `commission-config.RATES.event_tickets` |
| Legacy Entertainment PPV | 15 % | gross | `commission-config.RATES.ppv` — **closed, no payment rail** |
| Other hubs / marketplaces | their own configured rate | — | `commission-config` |

Owner rates recorded 2026-09-26 in [[CANONICAL_MONEY_VERSION_DECISIONS]]. **Production does not yet
charge these uniformly:** nine serving versions of `commission-config` exist
([[PRODUCTION_COMMISSION_MISMATCH]]).

## C. Application → approval → dashboard

| Category | Application | Approval authority | Granted | Dashboard |
|---|---|---|---|---|
| Creator | `creator-studio.html` | AdminOS › Creator Hub | `creators/{uid}.state = ACTIVE` | `creator-studio.html` |
| Streaming | as Creator | as Creator | as Creator | `creator-studio.html` |
| Events | `event-manager.html` intake (new) | AdminOS › Applications → `applicationDecide` | `users.roles += event_organizer` + claim (new) | `event-manager.html` (the notice links it) |
| Performers | `provider-onboarding.html` | AdminOS › Applications | provider claim + provider profile | `provider-dashboard.html` |
| Venues | `ent-organizer.html` (pending) | AdminOS › Entertainment | `status: active` | `venue-manager.html` |

## D. Role matrix

| Role (canonical) | Apply | Own dashboard | Content | Sales | Wallet | Refund | Messages | Calls | AdminOS |
|---|---|---|---|---|---|---|---|---|---|
| Viewer / buyer | — | — | — | own purchases & tickets | own | request (fos*) | `messages.html` | per SOKONI Connect | no |
| Creator (`creators.state ACTIVE`) | Creator Studio | Creator Studio | films incl. Streaming | per-film sales, royalties | royalties → `wallets.balance` | reversal automatic | menu link | not wired in dashboard | no |
| Event organizer (`event_organizer`) | Event Manager intake | Event Manager | events, tiers, promo codes | orders, check-in, analytics | settlement → `wallets.balance` after the event | cancel → admin refund queue | menu link | not wired | no |
| Performer / service provider (`provider`) | provider onboarding | Provider Dashboard | services | bookings | provider wallet | provider rail | contact customer | not wired | no |
| Venue owner (`entVenues.uid`) | venue listing | Venue Manager | venues | booking requests | — (no payment) | n/a | booking request | no | no |
| Admin (`admin`) | — | AdminOS | moderate | inspect | inspect | approve refunds | inspect | — | yes |
| Super Admin (`superAdmin`) | — | AdminOS | + fee attestation, Creator config, payment capability | — | dual-control override | + resolve outcome-unknown | — | — | yes (elevated) |

An ordinary admin is refused every super-admin op, and a plain user is refused every
`eventAdmin*` / `entAdmin*` / `creatorAdmin*` op. Both are proven by the suites.

## E. Payment matrix (IntaSend)

The authority is `shared/payment-capability.js`. Production has **no `config/intasendCapability`**
(read-only, 2026-09-26), so every hosted method is `PROVIDER_CAPABILITY_UNKNOWN` and hosted checkout
stays **closed**. The new `getCheckoutMethods` read returns the same gate, so pages never offer a method
the server would refuse.

| Method | Status | Offered to buyers |
|---|---|---|
| M-PESA (STK rail) | LIVE — 28 COMPLETE production invoices, all M-PESA (read-only probe) | yes |
| CARD-PAYMENT | PROVIDER_CAPABILITY_UNKNOWN | no |
| GOOGLE-PAY | PROVIDER_CAPABILITY_UNKNOWN | no |
| APPLE-PAY | PROVIDER_CAPABILITY_UNKNOWN | no |
| PESALINK | PROVIDER_CAPABILITY_UNKNOWN | no |
| BANK-ACH | PROVIDER_CAPABILITY_UNKNOWN | no |
| BITCOIN | PROVIDER_CAPABILITY_UNKNOWN | no |
| COOP_B2B | PROVIDER_CAPABILITY_UNKNOWN | no |

A method becomes offerable only when a super admin records it LIVE_AND_PROVEN with evidence **and**
`config/hostedCheckout` enables the purpose (`film_access`, `event_ticket`).

## F. Refund matrix (Entertainment only — the generic merchant refund work is untouched)

| Category | Refundable | Rail | Effect | Exactly once |
|---|---|---|---|---|
| Creator film | per Creator policy | fos* → `creator-hub.onFilmRefundProcessed` | royalty REVERSAL rows; entitlement revoked on full | `royaltyReversals` claim |
| Streaming | as Creator | as Creator | as Creator | as Creator |
| Event ticket (full) | yes — cancelled events via the AdminOS refund queue; buyer request via fos* | fos* → `event-settlement.onEventRefundProcessed` → `engine.revoke` | tickets refunded, order refunded, HELD settlement → REFUNDED, commission reversed | entitlement ledger revoke is idempotent |
| Event ticket (partial) | recorded | same hook | `eventExceptions/partial_refund_*` for a human; tickets untouched | — |
| Event ticket after organizer paid | recorded | same hook | `eventExceptions/refund_after_release_*`; **no silent wallet debit** | — |
| Venues / legacy PPV | n/a | — | no payment exists | — |

No parallel refund rail was created. Both hooks are additive calls in `financial-os._afterRefundSettled`
and never change the refund's own status.

## G. AdminOS matrix

| Operation | Op | Authority |
|---|---|---|
| Entertainment overview | `eventAdminOverview` | admin |
| Events list / cancel | `eventAdminEvents` / `cancelEvent` | admin (cancelEvent now accepts boolean-claim admins) |
| Ticket settlements | `eventAdminSettlements` | admin |
| Attest an unreported provider fee | `eventAdminAttestFee` | **super admin** + evidence; one-shot |
| Refund queue (cancelled events) | `eventAdminRefundQueue` → `fosSubmitRefund` | admin; canonical refund authority |
| Event exceptions | `eventAdminExceptions` | admin |
| Venue / artist moderation | `entAdminListings`, `entAdminSetListingStatus` | admin; reason required except for approve; audited |
| Category + commercial-policy matrix | `entAdminMatrix` | admin (read-only) |
| Organizer applications | `applicationList` / `applicationDecide` (filter "Event organizers") | admin |
| Creator Hub (verification, films, royalties, refunds, config, capability) | `creatorAdmin*` (26 ops) | admin; config / capability / fee attest super admin |

Audit: every write lands in `adminAudit` with `performedBy`, `target`, `before`, `after`, `reason` and
`createdAt`. Creator rows now also carry `createdAt`, so they appear in the Audit Center.

## H. Dashboard matrix

| Dashboard | Category | Tier | Profile menu | Finance | Analytics | Content | Communications |
|---|---|---|---|---|---|---|---|
| `creator-studio.html` | Creator, Streaming | EQUIPPED | shared header (scroll-capped) | royalties / wallet / statements | yes | films | menu links |
| `event-manager.html` | Events | PREMIUM | **new** widget | payout figure; settlement per order (organizer-readable) | yes | events, tiers, promo | menu links |
| `provider-dashboard.html` | Performers | EQUIPPED | widget, **now also on mobile** | wallet, withdraw | plan-gated | services | contact customer |
| `venue-manager.html` | Venues | PREMIUM | **new** widget | — | stats | venues | booking requests |

The PREMIUM / EQUIPPED tier is **declared per category**. Plan-driven feature gating *inside* a
dashboard is not implemented, except the provider plan's server-side analytics gate (see L).

## I. Responsive certification

`scripts/test-entertainment-browser.js` runs real Chromium at 360, 390, 768, 1024, 1280 and 1440 px on
five surfaces: event-hub pay panel, event-manager (applicant + organizer), venue-manager,
provider-dashboard and the AdminOS Entertainment panel. Result: **230 / 0**.

- **No horizontal overflow, measured against the device width.** An earlier version of the check
  compared against the layout viewport and passed vacuously. Fixing it exposed two pre-existing
  overflows, now fixed:
  - Event Manager at 360 px rendered about 709 px wide;
  - Venue Manager rendered about 442 px wide.
- **Profile icon and menu:**
  - The icon is on-screen.
  - The menu opens fully inside the viewport: bottom sheet at 600 px and below, flips up or left when
    needed.
  - Sign Out is present and works.
  - Escape closes the menu.
  - No admin link is offered.
- **Pay panel:** on-screen at every width, and M-PESA is always offered.

Not browser-proven: the shared-header account popup on Creator Studio. The CSS cap is applied, but that
page was not driven in Chromium. **UNPROVEN.**

## J. Test results

| Suite | Result |
|---|---|
| `test-event-settlement.js` (incl. real-webhook differential + base positive control) | 84 / 0 |
| `test-entertainment-registry.js` | 65 / 0 |
| `test-entertainment-browser.js` | 230 / 0 |
| `run-entertainment-rules.js` (served rules + counterproof) | 28 / 0 |
| `run-creator-rules.js` | 127 / 0 |
| Creator: hub 260 · callback 78 · completion 66 · ui 64 · publishing 104 · preview 46 · search 18 · withdrawal 21 · royalty 94 · AdminOS authority 19 | all 0 failed |
| Refund authority matrix 24 · refund exactly-once 103 · STK single-flight 66 · payout outcome-unknown 62 | all 0 failed |
| Role authority 30 · application decision 17 · admin-claim 32 · AdminOS wiring 316 · render 43 · dashboard-profile core | all 0 failed |
| `test-provider-verification-decision.js` | **BASELINE FAILURE**: crashes in its own `firebase-functions/params` stub (`defineString`); files untouched since `545afdc` |
| Repository-wide regression (predeploy gates) | **NOT RUN — UNPROVEN** |

## K. Security / sabotage

`scripts/sabotage-entertainment.js` plants 29 attacks. Each one must turn its owning suite red, on the
case that names it. After the run, every sabotaged file must be byte-identical to HEAD and all four
suites must be green again.

**First run: 26 CAUGHT, 1 MISSED, 2 CRASHED.** All three were weak tests, not weak code:

- The ownership attack was refused by the intent **replay** guard, never reaching the pricer's own check.
  The test now attacks a fresh order.
- A replayed release was stopped by a second guard: the deterministic wallet-transaction id `create()`.
  That made the test crash instead of fail.
- The refund-after-release test dereferenced a null document.

After fixing the tests, all three were re-planted: **CAUGHT**.

**Final: 29 / 29 CAUGHT, 0 MISSED, 0 CRASHED, 0 NO-ANCHOR. Tree byte-identical; post-restore suites
green.**

| Group | Attacks (all caught) |
|---|---|
| Money | event ticket no longer self-settling (buyer credited) · commission on GROSS · events at the PPV rate · unreported fee assumed zero |
| Release | cancelled event pays the organizer · open refund ignored · status guard removed · paid before the event |
| Refund | refund-after-release ignored · partial refund revokes all tickets |
| Pricing | another buyer's order · client amount trusted · already-paid order re-quoted |
| Expiry | PENDING payment expired · late payment not re-reserved |
| AdminOS | fee attestation downgraded to admin · overview open · moderation open · approve active · no reason |
| Roles | event_organizer → provider fallback · rejection keeps the claim · orphan category |
| Payment | hosted methods for a purpose never enabled · legacy paid PPV reopened |
| Rules (emulator) | client mints entTickets · venue created active · cross-organizer settlement read |
| Browser | profile menu horizontal fit removed |

## L. Remaining gaps

| # | Severity | Where | Gap | Smallest next fix |
|---|---|---|---|---|
| 1 | **P0 (live)** | `functions/universal-onboarding.js` `onbActivateRole` (production) | any signed-in user self-mints role claims; `finance` passes the ADE admin guard. **No evidence of use** (0 accountProfiles, 0 ade_rules) | deploy hotfix `1171a16` (`hotfix/onboarding-selfmint-live`): `--only functions:onboardingDispatch` — needs the owner's "deploy" |
| 2 | High | whole branch | not on the live lineage; production runs 9 `commission-config` versions | owner picks canonical versions ([[CANONICAL_MONEY_VERSION_DECISIONS]]), then a convergence branch |
| 3 | High (commercial) | `commission-config` `services` 15 % | the brief says "Quick Charge / service provider 5 %"; code applies 5 % to POS Quick Charge lines only, and provider **bookings** stay at the provider hub's rate | owner to state whether 5 % covers all provider bookings; one line in `commission-config`, proven by the policy matrix test |
| 4 | Medium | Entertainment dashboards | SOKONI Connect (in-app buyer ↔ organizer / creator messaging, calls, video) not wired; menus link `messages.html` only | mount the Connect surface for the `event_organizer` / `creator` roles through `connect-authority` |
| 5 | Medium | dashboards | PREMIUM / EQUIPPED is declared, not enforced by plan | gate dashboard sections on the server-read subscription (provider pattern) |
| 6 | Medium | `sokoni-aos.js:2123/2147/2163` vs `admin-os.js:228` | platform-settings saves send `{settings}` but the server needs `{category, updates}`; the commission and payout forms would write values nothing reads | make those two forms read-only views (policy matrix / wallet config); fix general settings to `{category:'general', updates}` |
| 7 | Medium | Events | partial refunds and refunds after release are manual exceptions | an owner policy for post-release recovery (`refundRecoveryDebt` exists) |
| 8 | Low | Streaming | on-demand only; live broadcast not implemented | a live-streaming provider decision |
| 9 | Low | Venues | booking requests carry no payment | a venue booking purpose, if owner wants paid holds |
| 10 | Low | payment methods | only M-PESA proven; no capability record in production | super admin records proven methods with evidence (AdminOS › Creator Hub › payment capability) |
| 11 | Low | anonymous first purchase | Anonymous Auth stays disabled (platform decision pending) | [[DECISION_ANONYMOUS_CREATOR_PURCHASE]] |
| 12 | Low | `creator-hub.js` accrual | `taxCents: 0` hard-coded (pre-existing) | a tax authority decision |
| 13 | Low | `test-provider-verification-decision.js` | baseline harness crash | add `defineString` to its params stub |

## M. Deployment status

```
FUNCTION DEPLOYMENT: 0
HOSTING DEPLOYMENT:  0
RULE DEPLOYMENT:     0
PROVIDER CALLS:      0
PRODUCTION WRITES:   0
```

Production reads performed, all read-only:

- function and archive metadata;
- counts of Entertainment collections;
- `commissionRules`, `revenueConfig`, `accountProfiles`, `ade_rules`, capability config.

**Deploy readiness:**

- **Hotfix `1171a16`:** ready on the live lineage, awaiting the owner's "deploy".
- **This branch:** NOT deployable yet (see L-2), and the Artifact Registry notice applies to any
  function rebuild.
