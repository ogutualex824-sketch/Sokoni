# Provider Lifecycle & Discovery Contract

**Status:** GOVERNANCE — architectural direction ratified 2026-07-28. Documents the *target* rules
for how every provider/business/service (a DJ, mechanic, doctor, lawyer, retailer, or a
brand-new merchant) moves from registration to discovery, booking, and settlement. Differences
between categories are driven by **configuration**, never by separate onboarding, publication,
booking, or search systems.

This is a **contract**, not a claim of completion. Each rule below carries its *current
enforcement status* from the universality audit (2026-07-28), per [[project_release_validation_standard]]
(Engineering Complete ≠ Production Proven). The gaps become a future **Onboarding & Discovery
Convergence** program — opened only after the [[BOOKING_CONVERGENCE]] observation window, and only
for gaps a read-only audit *proves* exist (never rebuild what already works).

## Status legend
- **ENFORCED** — verified in code today.
- **PARTIAL** — holds within the provider-services domain but not platform-wide, or partially wired.
- **DIRECTION** — the target; not yet built/verified.
- **UNVERIFIED** — plausibly present; needs the future audit to confirm.

## The canonical lifecycle

```
Register → Review → Approve → Publish → Index → Searchable → Bookable → Earn → Wallet → Withdrawal
```

Every seller, business, and provider follows this one lifecycle. Category-specific behavior
(slot duration, working hours, cancellation policy, commission rate, required fields) is
configuration on top of it — not a parallel pipeline.

---

## Rule 1 — Single onboarding pipeline
"List on SOKONI" and "Register My Business" MUST converge into one canonical onboarding flow.
- Users never create duplicate applications.
- Users always resume where they left off.
- Awaiting-approval users see application status (never a dead end, never a restart).
- Approved providers are taken directly to their dashboard, not back through onboarding.

**Status: UNVERIFIED / DIRECTION.** Whether the two entry points already share a backend is the
first question the future audit must answer. No duplicate-application or resume guarantee is proven today.

## Rule 2 — Single publication authority
`providerPublish` is the ONLY component allowed to publish a provider.
- Publishing creates/updates the canonical registry **and** all required public artifacts in one
  atomic action.
- There is no separate manual publish step after approval.

**Status: LARGELY ENFORCED.** `providerPublish` (`functions/provider-onboarding.js`) atomically writes
`providers/{uid}` (registry), `providerProfiles/{uid}` (public profile), availability, `providerSettings`,
`providerNotifications`, and the `{provider:true}` booking claim. **UNVERIFIED:** whether an admin approval
step *triggers* `providerPublish`, or publishing is currently self-service — the future audit's Q2.

## Rule 3 — Single discovery authority
Public search reads from ONE canonical published-provider source. No parallel search indexes or
independent provider lists.

**Status: PARTIAL.** Provider-services search reads the canonical `providerProfiles`
(`status=='active' && searchable==true`) — one source, no drift. **NOT platform-wide:** healthcare
(`healthAppointments`/health providers), venues (`venueBookings`), and events (`eventOrders`) maintain
their own provider lists/collections. Cross-hub discovery convergence is future work.

## Rule 4 — Visibility vs. availability (distinct axes)
- **Visible = published.**
- **Bookable = published AND status ∈ {active, approved} AND `acceptsBookings == true`.**
- **Offline / busy / on-vacation / closed** providers remain **discoverable** but are **not bookable**
  (profile, services, ratings visible; booking button disabled or shows next-available slot).
- **Suspended / banned / draft / unpublished** providers are **neither discoverable nor bookable**.

**Status: bookable half ENFORCED; visibility states DIRECTION.** The booking precondition is enforced
server-side at `bookingCreateService` (the activation gate, 2026-07-28: rejects non-active or
non-`acceptsBookings` providers before any write). The richer *visible-but-not-bookable* states
(offline/busy/vacation/closed with next-available surfacing) are not yet modelled — today availability is
closer to binary. Search must never conflate "not currently bookable" with "hidden."

## Rule 5 — Automatic synchronization
Changes to provider status, profile, services, or availability propagate to discovery automatically.
No manual indexing or publishing steps after approval.

**Status: PARTIAL.** Provider self-edits already propagate to the registry (name/category/fee), and
availability writes flow through the canonical `normalizeAvailabilityConfig`. **UNVERIFIED:** whether
*every* profile/service/category edit auto-refreshes discovery, and whether online/offline status updates
availability without a manual step — the future audit's Q3/Q4.

## Rule 6 — Single canonical provider identity
There MUST be exactly one canonical provider identity. Every feature references the same provider ID
and registry: **search, booking, wallet, settlement, reviews, ratings, analytics, notifications, admin,
availability.** No module maintains its own independent provider identity or publication state.

**Status: ENFORCED within provider-services; NOT across hubs.** In the provider-services domain every
surface keys on the same `providers/{uid}` identity (`providerBookings.providerId`, `providerPayouts`,
`wallets/{uid}`, `providerReviews.providerId`, `providerProfiles/{uid}`). **Gap:** healthcare, venue, and
event hubs carry their own provider/entity identities and publication state — the core reason cross-hub
convergence is a distinct future program. This rule is the guardrail that keeps expansion consistent.

---

## Future program: Onboarding & Discovery Convergence

Opened only after the booking observation window. Begins with a **read-only audit** answering the four
questions that determine real scope (implement only the gaps the audit proves — never rebuild what exists):

1. Do "List on SOKONI" and "Register My Business" already call the same backend? *(Rule 1)*
2. Does administrator approval already invoke `providerPublish`, or is there another publication path? *(Rule 2)*
3. Does every profile and service update automatically refresh discovery? *(Rule 5)*
4. Does search correctly distinguish *visible* providers from *currently available* ones? *(Rule 4)*

Governance: follows the reusable [[feedback_subsystem_convergence_template]] (target arch → phased
migration → measurable acceptance → telemetry-gated retirement). Related: [[BOOKING_CONVERGENCE]],
[[PUBLICATION_CONTRACT]], [[BOOKING_PAYMENT_CONTRACT]].
