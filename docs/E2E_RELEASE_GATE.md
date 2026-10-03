# E2E release gate — application → approval → category → dashboard → … → payout

Related: [[Authentication]] · [[Payments]] · [[Orders]] · [[Marketplace]] · [[SmartPOS]] · [[APPROVAL_REMEDIATION_CENSUS]] · [[C3_CLEANUP_MANIFEST_CORRECTION]]

**Owner rule (2026-10-03):** "E2E complete" is ONE release gate. Nothing is called E2E-ready until **every hard stop**
below is true and evidenced. A suite that could not run (for example, memory below the floor) is **not** a pass.
The browser golden path needs **≥ 700 MB** free RAM; every other test and deploy needs ≥ 512 MB.

There is ONE authoritative record per stage. There are no parallel "almost equivalent" approval, payment, category,
wallet or settlement systems.

Status vocabulary: **observed** (evidence linked) · **built** (code + tests, not deployed) · **open** · **blocked** (reason).

## 1 · Hard stops

| # | Hard stop | Owner | Status | Evidence / blocker |
|---|---|---|---|---|
| H1 | Approval assigns the category **inside** the authoritative approval transaction (idempotent; no approved-but-uncategorized active state) | f3 built · sokoni-5b review | built | `feat/admit-category-atomic-on-4da5b61` @ f4bd2ab: admit = category stamp + capability activation (approvedAt) in ONE txn; applicationDecide resolves the category server-side (never the request), freezes it on the decision, refuses unresolved; projectProvider stamps it in the activation write. 30/0, 8 mutants. NOT deployed. |
| H2 | Shave 'n' Trims regression: approve → category `salon` → active → appointment_shop dashboard → no cleanup rule suppresses it | f3 built · sokoni-5b merge | built | `fix/cleanup-ids-real-providers-on-451acee` @ ac23d2a: admitted barber → VALID / AVAILABLE / provider-dashboard + bookedHours·staff·pos; suspended → loses it. gate 28/0, mutations 9/0. Browser half waits on RAM. |
| H3 | Test-account cleanup exceptions removed; identity never decides dashboard access | f3 built · sokoni-5b merge | built | same branch: cleanup copy = manifest minus the 6 records (34 → 28); the synthetic probe stays claimed. NOT deployed. |
| H4 | Payout P0 hotfix: ONE shared predicate `withdrawals === true` (exactly) on request · retry · pending processor · scheduler · admin payout, against the DEPLOYED function revisions; reconciliation stays ungated (it moves no money); verify the active revision after deploy | sokoni-2f (built) · f3 deploys | built — PARTIAL | `fix/payout-gate-p0-on-live` @ 1b19557 (tree C:/temp/sok-2f-pgate); 41-line gate-only diff vs the live archives. Scope: requestSellerPayout, processPayoutRetries, processPendingPayouts, autoScheduledPayouts, initiateSellerPayout; reconcilePayouts excluded. Evidence: docs/release-gates/payout-gate-p0-hotfix.md. Deploy order: FIRST (owner, confirmed directly 2026-10-04), then rules → providerDispatch → bookingDispatch. **Pre-flight 2026-10-04 (read-only): all 5 live generations + serving revisions MATCH 2f's rollback targets, 100% traffic each; platformConfig/withdrawals ABSENT, so the gate is CLOSED on arrival.** **GAP vs the owner's H4:** `adminProcessPayout` (admin approve → auto-B2C) and `providerRequestPayout` (providerDispatch) are NOT gated by this unit. The owner listed admin payout explicitly, so H4 stays open until both carry the same predicate. |
| H5 | 14 commercial fallbacks explicitly classified; no generic 5% fallback; unknown category never becomes 5% | sokoni-2f | built | r2 7ee5efc / commercial-fn 7813272: default row removed; unknown → category_unpriced before payment, HELD + flagged after (5b f26c80a); locked table applied. test-commission-categories-owner 8/0. NOT deployed. |
| H6 | Restricted categories (vape, alcohol, tobacco/nicotine, adult) refused **server-side** | sokoni-2f | built | ONE module shared/restricted-categories.js → category_restricted; never a commission row. NOT deployed. |
| H7 | Webhook dependency 2016051 reconciled where that webhook is deployed | sokoni-5b | open | |
| H8 | Webhook deploy guard actually EXECUTES and refuses an unscoped deploy (banner in the log) | deploy owner | open | |
| H9 | PIN + settlement tests genuinely execute (incl. the emulator-backed ones) | sokoni-5b / f3 | blocked | test-booking-pin-release needs the emulator; RAM below the floor |
| H10 | Full browser golden path at ≥ 700 MB free | f3 + b2 | blocked | RAM |
| H11 | All deliberate security breaks pass (§3) | all | open | |
| H12 | Every proposed production function compared with its exact LIVE revision (archive diff) | each deployer | open | |
| H13 | Active Firebase rules + active function revisions re-verified after every deploy | each deployer | open | |
| H14 | Production smoke completes with no unexplained differences | f3 | open | |

## 2 · Release matrix

| Area | Required proof | Owner |
|---|---|---|
| Application | Applicant can create/submit the correct application | 5b |
| Approval | A real admin can approve | 5b |
| Category | Approval assigns the correct category (H1) | 5b |
| Authorization | Applicant cannot self-approve | 5b + f3 rules |
| Authorization | Applicant cannot forge approved / decidedBy / category / capability | f3 rules (P0 hotfix: appDecisionKeys, providerApprovalKeys incl. `business`) |
| Revocation | Revoked/suspended provider loses capability | 5b (predicate INACTIVE) + f3 rules (P0-F) |
| Dashboard | Approved provider reaches the correct dashboard for its category (§5 question) | 5b workspace + b2 hosting |
| Dashboard isolation | Shop-only areas stay inaccessible without shop capability | 5b workspace |
| Category isolation | Provider cannot activate an unapproved category | 5b + f3 rules |
| Public catalogue | Only approved/active providers appear | 2f search + 5b |
| Service editor | Provider manages only approved services | b2 / owner of the editor |
| Rate card | Provider sets allowed rates | b2 |
| Snapshot | Historical booking price/rate cannot change retrospectively | 2f (commissionSnapshot) + 5b |
| Lead | Customer can submit an enquiry | b2 |
| Messages | Lead becomes an operational conversation (server-created; pre-claim closed, 1225780) | b2 + f3 rules |
| Quote | Provider creates a quote | b2 / 2f |
| Quote integrity | Customer cannot tamper with quote total/version | 2f |
| Quote acceptance | Exact quote version required | 2f |
| Booking | Accepted quote creates the correct booking | 5b |
| Payment | IntaSend payment is authoritative | 5b |
| Webhook | Duplicate/replayed webhook is idempotent | 5b |
| Commission | SOKONI's record decides the commission category | 2f |
| Unknown category | After payment, an unresolved category → hold + flag, never silently paid | 2f + 5b |
| Restricted category | Vape / alcohol / tobacco / adult → refused (H6) | 2f |
| Wallet | Provider wallet = actual settled amount (business wallet, exact cents) | 5b |
| PIN | Completion requires a server-validated PIN | 5b + f3 (rentals) |
| Duplicate completion | Cannot release twice | 5b |
| Settlement | Uses the actual held amount + booking snapshot | 5b + 2f |
| Receipt | One authoritative receipt (transaction-receipts) | 2f |
| Receipt mutation | Provider/customer cannot rewrite a receipt | f3 rules |
| Payout | Withdrawals require exactly `superAdmin.withdrawals === true` (H4) | payout owner |
| Payout retry / scheduler / admin | None can bypass the gate (H4) | payout owner |
| Reconciliation | Inspects/flags without moving money | payout owner |
| Reviews | Review tied to a completed transaction | b2 |
| Audit | Approval / payment / settlement / payout actions auditable | all |
| AdminOS | Correct application/provider/category/payment records visible | b2 / e3 |
| Super Admin | Same canonical records, broader authority | b2 / e3 |
| Restricted provider | Suspended/revoked account cannot use provider capabilities | 5b + f3 rules |
| Direct URLs | Unauthorized dashboard routes refused server-side | 5b workspace |
| Browser | Full golden path at ≥ 700 MB free (H10) | f3 + b2 |
| Production comparison | Candidate behaviour reconciled against live (H12) | each deployer |

## 3 · Deliberate breaks (must stay closed)

| Break | Attempt | Expected |
|---|---|---|
| A · Self-approval | Applicant changes own status → approved | REFUSED; no capability; no dashboard |
| B · Forged category | Applicant writes `salon` / `artist_creator` (or any `business` field) | REFUSED (rules P0-4 + server) |
| C · Forged payment | Browser claims payment succeeded | No hold release, no wallet credit, no receipt |
| D · Payout bypass | `withdrawals` = missing · false · "true" · 1 · {} · unreadable, on EVERY money-moving path | ALL closed; only `withdrawals === true` opens |

## 4 · Commercial rules (owner, LOCKED 2026-10-03)

| Category | Rule |
|---|---|
| Fashion · Furniture · Books · Appliances · Beauty products · Shoes | 15% |
| Car Hub | 2% |
| Laundry | 5% |
| Hair & Beauty services | 5% |
| DJ | the existing entertainment-booking rate |
| Vape · Alcohol · Tobacco/nicotine · Adult | REFUSED |

**No generic 5% fallback.** An unknown category never silently becomes 5%. After money has been received, an unresolved
classification is **held + flagged**, never silently paid.

## 5 · Open owner question

The workspace authority (`business-workspace.js`, owner routes 2026-09-28) sends service categories to
**provider-dashboard.html** with a category profile: `salon` → **appointment_shop** (calls, booked hours, staff,
products, inventory, POS); `artist_creator` → **entertainment**. Shops and food go to **merchant-v2.html**. The 2026-10-03
gate text says "MerchantV2 dashboard". Does that supersede the 09-28 route for service providers, or does it mean the
one merchant shell generally? Until answered, the 09-28 authority stands (nav fix 2f53984 follows it).

## 6 · Final architecture

Application → Admin approval + category → server capability → dashboard → service → lead → quote → booking → IntaSend
payment → verified webhook → money held → service/delivery → server PIN → settlement → (commission | provider wallet) →
receipt · payout gate.
