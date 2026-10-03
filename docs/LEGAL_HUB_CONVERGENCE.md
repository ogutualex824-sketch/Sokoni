# Legal Hub Convergence

**Owner:** sokoni-b2 (claimed 2026-10-03 with sokoni-2f's agreement)
**Functions line:** `feat/legal-hub-on-9cab901`, built on sokoni-2f's `convergence/commercial-fn-on-ef1e992` @ `9cab901`
**Status:** IN PROGRESS. Nothing is deployed, and Legal Hub is **NOT user-ready**.

Related: [[LEGAL_INTEGRATION_STATUS]] · [[Payments]] · [[Bookings]] · [[TECH_HUB_CONVERGENCE]] · [[COMMISSION_COLLECTION_ARCHITECTURE]]

## Rule

Legal is a **provider category on shared rails**. There is no Legal booking engine, payment processor, wallet, commission or invoice system.

The economic path is:

1. Applicant books a lawyer or law firm.
2. A `providerBookings` record is created (`bookingCreateService`).
3. The buyer pays through IntaSend (`createPaymentIntent` → verified webhook) and the money is held.
4. The applicant gives the completion PIN (`settleOnPinRelease`).
5. Commission is calculated once by `finos-utils.calculateCommission`.
6. The net amount goes to the provider's wallet (`provider-ops._settlementWrites`).
7. Invoice, receipt and refund records are written by the shared financial-document authority (see gap F-1).

The owner locked verification on 2026-09-27 (`b24b052`, frozen). A provider is bookable only when:
- AdminOS has approved the application (`applicationDecide`), **and**
- a current Law Society of Kenya check shows the advocate Active, **and**
- the account is linked to `providers/{uid}`.

`legal-verification.eligibility` is that ONE predicate. Nothing in this programme edits it.

## Phase 0 — authority map (census 2026-10-03, tree `9cab901`)

| Operation | Today | Authority to converge on | Status |
|---|---|---|---|
| Directory | `getLegalProviders`, filtered by `LV.eligibility` | same, plus taxonomy filters (L1) | **FIXED L1** (server) |
| Lawyer application | `registerLegalProvider` → `applications/legal_{uid}` | same, typed `lawyer` | **FIXED L2** (server) |
| Law-firm application | none (free-text `firmName`) | same record, `entityType:'firm'`, typed `law_firm` | **FIXED L2** (server) |
| Applicant profile / needs-info | no update path existed (registration stranded a provider) | `legalDispatch` ops `legalMyProfile` / `legalUpdateProfile` / `legalResubmitApplication` | **FIXED L2** (server) |
| Approval / LSK | AdminOS `applicationDecide` + `legalAdmin*` ops | unchanged (frozen) | PRE-EXISTING, canonical |
| Booking | `bookLegalConsultation` → `legalConsultations`; no money; bypassed `bookingGate` | `bookingCreateService` → `providerBookings` | **FIXED L4** (server): the old engine refuses (`LEGAL_BOOKING_MOVED`) and writes nothing |
| Payment | none | `createPaymentIntent` → IntaSend | OPEN (L4) |
| PIN / settlement / wallet | none for Legal; the shared pipeline is hub-agnostic | `settleOnPinRelease` → `_settlementWrites` | **PROVEN L4** in-process: KES 5,000 → 250 commission → 4,750 to `wallets/{uid}`, once |
| Commission | client-side 5% stored only in localStorage, plus an off-platform Paybill; the Firestore write is denied | generic `services` 5% lane (2f confirmed); no `commission-config` change | OPEN (L4: retire the client path) |
| Availability | Pro Dashboard writes `availabilityStatus` (denied by rules) | `ent-availability` / `availability.js` callables | OPEN (L5) |
| Reviews | `rateLegalProvider` on `legalConsultations` | `reputation.repSubmitReview` on a completed `providerBooking` | OPEN (L4) |
| Invoice / receipt | none; `financialDocuments` is written only by the Daraja callback (now deleted) | shared financial-document authority (gap F-1, platform-wide) | OPEN |
| Search | `lawyers` are deindexed (`discovery-eligibility.js:35`) | existing search sync, gated by eligibility | OPEN |
| Provider activation gate | reported missing | `bookingCreateService` and `loadCalendar`, two independent layers | **PROVEN, pre-existing** (`test-booking-provider-gate.js` 8/0) |

## L1 — one taxonomy

- `functions/shared/legal-taxonomy.js` is THE list: six groups × five services, labels exactly as the owner brief.
- `sokoni-legal-taxonomy.js` is **generated** by `node scripts/build-legal-taxonomy.js`. Never hand-edit it. `--check` fails when it is stale.
  - The hosting assembly takes this file WHOLE.
- **Legacy profiles keep their `specializations`.** These map one-to-one only: family, employment, debt recovery, IP, mediation, litigation→litigation-support, conveyancing→sale & purchase, drafting→custom documents.
  - `criminal_law`, `immigration`, `tax_law`, `property_law`, `corporate_law`, `notary` and `other` map to **nothing**. An advocate is never listed under an area they did not choose.
- Directory filters: `practiceArea`, `practiceGroup`, `entityType`. They run in memory over the eligible set, so no new index is needed. An unknown id returns nothing.

## L2 — lawyer vs law firm

There is ONE identity record (`legalProviders/{uid}`) and ONE review item (`applications/legal_{uid}`). Two types are stamped on both: `entityType` and `applicationType`.

- **Lawyer:** a person, identified by name and LSK admission number.
- **Law firm:**
  - Applies through its **responsible advocate**, the account holder. That advocate's LSK verification is the firm's, so the frozen eligibility predicate holds unchanged.
  - Firm data is admin-reviewed, never a credential: registration number, description, offices, and a declared team.
  - The team is stored as `teamDeclared` with `teamVerified:false`, and is **never shown as verified**.
- **Self-service edits** are allowed for public profile facts: bio, county, languages, online, practice areas, fee, experience, phone, and the firm's description, offices and team.
- **Protected fields:** name, licence number, firm name, entity type, registration number, status, verification and rating. Changing any of them is a re-verification through AdminOS. The op refuses and **changes nothing**.
- **Needs information:** when AdminOS chooses `request_info`, the applicant sees the reviewer's reason (`legalMyProfile`) and resubmits (`legalResubmitApplication`). The application can only move `info_requested` → `pending`, never to approved.
- **Public projection:**
  - An unrated provider gets `rating:null` (never 0, never a default 5).
  - It never carries the licence number or phone.

## L4 — Legal consultation on the canonical rails (server)

- `LEGAL_BOOKING_ENABLED = true`. This is the "one reviewed change" that b24b052's header reserved. The eligibility predicate is unchanged.
- **The projection opens booking exactly while eligible.** `providers/{uid}` has `acceptsBookings / searchable / isPublic / available = eligibility().bookable`. The `legal_consult_{uid}` rate card is active only while eligible **and** priced (fee > 0). A lapsed LSK check, a suspension or a quarantine closes all of it.
- **A fee edit** (`legalUpdateProfile`) re-prices the rate card server-side, in cents. It never opens booking by itself.
- **Commission:** no Legal lane. The generic provider lane is `RATES.services` 5% (= `RATES.legal`). sokoni-2f agreed. `commission-config` is untouched.
- **Retired:** `bookLegalConsultation` refuses with `LEGAL_BOOKING_MOVED` and writes nothing. The history reads stay.
- **Proven** (`test-legal-booking-chain.js` 9/0, sabotage 5/5):
  - approval alone stays closed;
  - approval + LSK Active opens booking;
  - the booking uses the server price, ignoring the client price;
  - PIN settlement happens once, with a no-op on the second release;
  - suspension closes it.
- **Fixture, not proof:** `paid_held` stands in for the verified IntaSend webhook's effect. `createPaymentIntent(service_booking)` plus the webhook for a Legal booking is **UNPROVEN** here.
- `test-legal-verification.js`: 3 rows moved from the old contract (booking closed; the money-less engine accepting eligible advocates) to the new one. The row count is unchanged (93 server rows pass).

### Deploy set and order (when authorized)

`legal-verification.js` is bundled by **providerDispatch** (via `ent-availability`, the booking gate), **adminOsDispatch** (LSK ops), **applicationLifecycle** (the approval projection) and the Legal callables. The flip takes effect only where the new file is deployed.

1. **Functions:**
   - providerDispatch, inside sokoni-5b's ONE provider-functions release (carries this file);
   - adminOsDispatch, under the rebuild rule agreed with 5b (live archive + both hunks);
   - applicationLifecycle;
   - registerLegalProvider, getLegalProviders, getLegalProvider, bookLegalConsultation (now a refusal), legalDispatch.
2. **Hosting L3, immediately after.** Live `legal-hub.html` still calls `bookLegalConsultation`. Between the two deploys it shows the honest "refresh and book again" refusal. Never ship hosting first: the new booking flow needs the flip.
3. **Re-projection:** an advocate approved before L4 keeps `acceptsBookings:false` until the next projection (an LSK re-record or an admin decision). Re-project eligible advocates with `applicationReconcile` or a recorded re-check after deploy. Do not bulk-edit `providers`.

## Open — owner decisions

1. Do criminal law, immigration and tax join the public taxonomy? Today the brief's 30 services exclude them, and legacy advocates carrying them are not filtered under any new area.
2. Firm team verification: should each declared advocate get their own LSK check before the firm storefront lists them? Until decided, the team is private.

## Slice plan (remaining)

| Slice | Content | Lands in |
|---|---|---|
| L3 hosting | Legal Hub page: taxonomy groups and filters; registration wizard with Lawyer vs Law firm; applicant panel (status, reviewer reason, resubmit); **cards with no buttons** → storefront; no fake ratings, prices or analytics; retire localStorage flows | combined Hosting release |
| L4 booking | Legal rate cards on `providerServices` (with a `legalArea`); `bookingCreateService` for Legal; retire `bookLegalConsultation` / `legalConsultations` / client commission; flip `LEGAL_BOOKING_ENABLED` in ONE reviewed change; PIN, settlement and wallet via the shared pipeline; reviews via `repSubmitReview` | sokoni-5b's providerDispatch release + `legalDispatch` |
| L5 availability | Legal dashboard edits the canonical availability callables; `availabilityStatus` client write retired | providerDispatch release |
| L6 storefronts | `lawyer.html` / firm storefront on `getLegalProvider`: services, rates, availability, reviews, share, book | Hosting |
| L7 AdminOS / Super Admin | Legal panel: lawyer vs firm filter, practice areas, bookings, financial view (read-only) | adminOsDispatch (rebuild rule with 5b) |
| L8 orders / refunds | Legal bookings in Orders via the existing `orders/{bookingId}` mirror; refund = canonical request → approval | shared |

## Tests

| Suite | Result |
|---|---|
| `scripts/test-legal-profile.js` | 14/0 (BASE=9cab901 fails, T-0) |
| `scripts/sabotage-legal-profile.js` | 6/6 caught |
| `scripts/test-booking-provider-gate.js` | 8/0, 2 mutations caught |
| `scripts/test-legal-verification.js` (server rows) | 93 pass on this tree = 93 on base |
| `scripts/test-legal-compliance.js` | 47/0 |
| `scripts/verify-legal-dispatch.js` | PASS |
| Browser suites (`test-legal-verification` Chromium part, `test-legal-in-app`) | **UNRUN**: memory floor, and no playwright in the worktree |
| Rules / emulator | **UNRUN** |


## Status board — end of pass 2026-10-03 (nothing deployed; Legal Hub NOT user-ready)

**Functions** `feat/legal-hub-on-9cab901`: c9f54aa · 0e216a3 · 5fd4d8a · a353116 · f7d4467 (+ CHANGELOG fixes).
**Hosting** `hosting/legal-hub-on-38d2d60`: 541ea2f · b2a3025 · ef5f608 · 194b649 · f7ae6f4.

| Area | State | Evidence |
|---|---|---|
| One taxonomy (6 × 5) | **FIXED** | test-legal-profile T1–T3; generated browser copy checked with `--check` |
| Lawyer vs law-firm application | **FIXED** | R1–R5 (server); R1 web wizard |
| Needs info → resubmit; reviewer reason shown | **FIXED** | U3; R2 web |
| Self-service profile; identity and verification protected | **FIXED** | U1, U2 |
| AdminOS: lawyer/firm, practice areas, type filter | **FIXED** | A1 (server), AO1 (web) |
| AdminOS approve / reject / suspend / LSK record | PRE-EXISTING (b24b052) | test-legal-verification, 93 server rows |
| Directory: eligible only, no fakes, buttonless cards → storefront | **FIXED** | P1, P2; W1–W6 |
| Storefront (lawyer + firm) | **FIXED** (data + booking entry) | S1, S2 |
| Booking on providerBookings, server price | **FIXED** | C1–C3 |
| PIN settlement: 5% once → business wallet | **PROVEN** in-process (shared pipeline) | C4, C5 |
| Suspended / unapproved provider not bookable | **PROVEN** (pre-existing, two layers) | test-booking-provider-gate 8/0 |
| Suspension closes booking + search | **FIXED** | C8, C9 |
| Retired money-less engine (bookLegalConsultation) | **FIXED** | C6; W6 |
| Rate cards per practice area | **FIXED** | C10; PD1 |
| Search via the canonical providers gate | **PROVEN** | C9 |
| Client: My legal bookings, PIN, message, refund request | **FIXED** (read-only on canonical) | A1 web |
| Fake "log case 5% + Paybill" tab; fake pro dashboard | **FIXED** (retired) | A2 web |
| createPaymentIntent + IntaSend webhook for a Legal booking | **UNPROVEN** | `paid_held` fixture only |
| All account-enabled IntaSend methods | **UNPROVEN / not built here** | owned by the IntaSend convergence (2f) |
| Invoices / receipts for provider bookings | **NOT BUILT, platform-wide** | `financialDocuments` only written by the deleted Daraja callback |
| Large matters: quote → booking | **FIXED** (single payment) | capability line d377b28 (legal → QUOTE_REQUEST + DIRECT_BOOKING, A-8); storefront "Request a quote" + My quote requests (Q1). Multi-stage MILESTONES are still NOT BUILT |
| Availability single write path | **NOT BUILT** | provider-dashboard writes `providerAvailability` from the client (rules allow non-healthcare) |
| Firm team verification | **BLOCKED** (owner decision) | team kept private |
| Reschedule / no-show / provider-cancel | **PRE-EXISTING gap** in the shared booking engine | — |
| Browser / emulator proof | **UNRUN** | memory floor (free memory < 512 MB); no playwright in the worktrees |

### Category matrix (all 30 services)

Every service of the six groups is the same row, because Legal providers and services are keyed by taxonomy id and none has a category-specific path:

| Category | Public | Provider | Application | Booking | AdminOS | Super Admin |
|---|---|---|---|---|---|---|
| each of the 30 taxonomy services | ✔ group + area filters (W4) | ✔ rate-card `legalArea` (C10, PD1) | ✔ practice-area picker (R1) | ✔ via rate card → `bookingCreateService` | ✔ practice areas column (AO1) | ✔ registry + per-service coverage, read-only (SA1) |

### Gaps and owners

| # | Gap | Owner |
|---|---|---|
| G-1 | Invoices and receipts for provider-booking payments (platform-wide) | owner decision → 2f (financial documents) |
| G-2 | Legal payment-intent + webhook proof; IntaSend method coverage | 2f (IntaSend convergence) |
| G-3 | Free-plan service cap counts the auto consultation card | OWNER decision, 2f recommends (a): exclude createdBy legal-verification from the count; 2f implements on commercial-fn if chosen |
| G-4 | Criminal / immigration / tax in the taxonomy | owner |
| G-5 | Firm team per-advocate LSK verification | owner |
| G-6 | Availability: one server write path for provider-dashboard | 5b (provider shell) / b2 |
| G-7 | ~~Super Admin Legal view~~ **FIXED** (5966cd6, read-only) | b2 |
| G-8 | Milestone billing for MULTI-STAGE legal projects (single quoted engagements work: d377b28 + a086a44) | owner decision (new authority) |
| G-9 | Rules / emulator proof (`legalProviders` and `providerServices.legalArea`, which is server-written only) | f3 (combined rules) |

### Release order (when authorized)

1. **Functions in sokoni-5b's ONE provider release.** It carries:
   - `legal-verification.js` @ a353116 and `shared/legal-taxonomy.js`;
   - `provider-ops.js` with the `legalArea` hunks (merged with the Tech `_techProfile` hunks).
2. **Then:**
   - adminOsDispatch (rebuild rule: live archive + 5b 2de50e0 + b2 hunks);
   - applicationLifecycle;
   - registerLegalProvider, getLegalProviders, getLegalProvider, bookLegalConsultation (refusal), legalDispatch.
3. **Re-project eligible advocates.** Use an LSK re-record or `applicationReconcile`. No bulk edits.
4. **The combined Hosting release.** It includes `hosting/legal-hub-on-38d2d60`. Never ship it before step 1.


## Owner decisions applied (2026-10-03, second pass)

| Decision | State | Where / evidence |
|---|---|---|
| Invoices/receipts required, platform-wide | **IMPLEMENTED on server + screens; runtime UNPROVEN** | 2f receipts contract v2 (65e85d1, bb341b1). Booking hooks 8c99f62 (C12–C17, driving the REAL webhook hold). Buyer receipts.html + provider Finance → Receipts (hosting a726c0d, RC1–RC2). AdminOS receipts = 2f d38a79a |
| All enabled IntaSend methods, server-returned; webhook is the authority | **PARTIAL** | the method IntaSend reports is recorded (5b 525fd9f → receipt.method, "—" when null). A server-returned enabled-methods list and the Legal checkout proof are **BLOCKED** (2f IntaSend convergence; emulator below the memory floor) |
| Criminal / immigration / tax as separately configured services | **IMPLEMENTED** | L10 a08a749: SPECIALIST list, request → AdminOS confirm (audited), confirmed-only public, rate cards only once confirmed (SP0–SP3, C11) |
| Verify each advocate individually | **IMPLEMENTED** | L11 858c885: firm team = accepted AND individually eligible members (FM1–FM4) |
| Milestones not this release; model ready | **DESIGNED** | receipt events reserve milestoneId (2f); one quote = one booking = one payment |
| Free plan: auto consultation not counted | **IMPLEMENTED** | 2f 965c46d (cherry-picked 0649fc2); C10 runs on the FREE plan |
| Availability server-authoritative | **IMPLEMENTED for the provider dashboard; rules HELD** | hosting 547bf51 (AV1W); server proof AV1–AV3 (3 independent overlap layers). Rules deny-hunk HELD by f3 until e3 ports the Merchant V2 shop schedule to kasshop.setShopAvailability (2f decision) |
| Security rules / emulator | **BLOCKED** | f3 combined rules; memory floor |

**Legal Hub remains NOT USER-READY.** The emulator, the browser runs and the real IntaSend Legal checkout proof have not run.
