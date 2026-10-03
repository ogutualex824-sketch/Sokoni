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
| Booking | `bookLegalConsultation` → `legalConsultations`; no money; bypasses `bookingGate` | `bookingCreateService` → `providerBookings` | OPEN (L4) |
| Payment | none | `createPaymentIntent` → IntaSend | OPEN (L4) |
| PIN / settlement / wallet | none for Legal; the shared pipeline is hub-agnostic | `settleOnPinRelease` → `_settlementWrites` | OPEN (L4, flag flip) |
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
