# Events, Ticketing & Event Staff Operations

**Status:** 2026-09-27, branch `feat/creator-hub`, commits `6faeb14` (P1) → `cdfea1e` (P2) → `cdc6529` (P3) →
`2634470` (P4) → `23fe685` (P5) → `f1278ea` (P6) → P7 (tests, sabotage, docs). Implemented and certified locally.

**FUNCTION DEPLOYMENT 0 · HOSTING DEPLOYMENT 0 · RULE DEPLOYMENT 0 · PROVIDER CALLS 0 · PRODUCTION WRITES 0.**

Related: [[ENTERTAINMENT_HUB]], [[ENTERTAINMENT_CATEGORY_MATRIX]], [[CREATOR_HUB]], [[REFUND_AUTHORITY_CONVERGENCE]],
[[Payments]], [[Events]], [[Authentication]].

This slice runs an event day end to end on SOKONI:

- the organizer sells online and at the door;
- temporary staff sell and admit people;
- buyers get a PIN, not a QR they must scan;
- a buyer can ask for a refund through a guided wizard;
- AdminOS can investigate any ticket and trace its money.

Every piece reuses an existing authority: the entitlement engine, the payment intents, the fos* refund authority,
`legal-agreements`, `notify` and AdminOS. **No second payment or refund rail was created.**

---

## 1. Architecture

| Module | Role |
|---|---|
| `functions/event-ops.js` | PIN issue / hash / verify, temporary staff (invite → accept → revoke / expiry), PIN admission, `eventOpsDispatch` |
| `functions/event-sales.js` | cashier Quick Sale (cash · card on the organizer's terminal · IntaSend through the canonical intent), door-sale commission receivables, sales + finance reads |
| `functions/event-refunds.js` + `functions/shared/event-refund-reasons.js` | refund policy, the reason catalogue, the server-side `decide()`, the wizard's quote / submit; hands the request to `financial-os` (`fosSubmitRefund` handler) as the buyer |
| `functions/event-settlement.js` | payment activation → tickets + PINs; settlement HELD → release (nets door commission) → wallet; refund processed / rejected hooks; confirmation notice |
| `functions/event-admin.js` | AdminOS investigation, financial trace, staff / admissions / refund-request / receivable oversight (`eventAdmin*`, merged into `adminOsDispatch`) |
| `functions/event-hub.js` | public events, purchase (capacity transactional), cancel (chunked, transactional flip, buyer notices), organizer dashboard from settlements |
| `sokoni-event-ops.js` | event-day workspace UI (Quick Sale · PIN Admission · Staff · Sales · Finance · refund policy) |
| `event-manager.html` / `event-hub.html` | organizer + staff workspace / buyer tickets, refund wizard, share-link landing |
| `sokoni-aos-entertainment.js` | AdminOS › Entertainment (Investigate · Staff & gate · Refund requests · Receivables + the earlier tabs) |

Event-bus shape: payment webhook → `payments/{ref}` → `eventOnTicketPayment` → entitlement engine `activate` →
tickets `valid` + PINs + settlement HELD + commission row → `event_ticket_confirmed`.
A refund goes fos* → `onEventRefundProcessed` / `onEventRefundRejected`.

---

## 2. Event category matrix

| Category | Application | Approval | Agreements (versioned, signed) | Dashboard | Payment | Refund | Staff | AdminOS |
|---|---|---|---|---|---|---|---|---|
| **Events & Ticketing** | `event-manager.html` intake → `applications` (`event_organizer`) | AdminOS › Applications; **gated on `legalAcceptances`** | organizer agreement · ticketing & refund obligations · staff & cash handling · commission (3 %) · settlement · data processing | `event-manager.html` | `event_ticket` (M-PESA STK) · cash · organizer card terminal | policy + wizard → fos* | cashier · admission · marketing · manager (temporary) | Entertainment panel |
| **Creator / Streaming** | `creator-studio.html` | AdminOS › Creator Hub | creator content · ownership declaration · royalty settlement (30/70) · data processing — enforced for NEW creators (dark-launched: `legalConfig/enforcement.creator`) | `creator-studio.html` | `film_access` | Creator policy | — | Creator Hub panel |
| **Venues** | `ent-organizer.html` (pending) | AdminOS › Entertainment | venue listing | `venue-manager.html` | none | n/a | — | Entertainment panel |
| **Performers & Artists** | provider onboarding | AdminOS › Applications | provider set (existing) | provider dashboard | `service_booking` | provider authority | — | Applications |

---

## 3. Ticket identity and security (revised 2026-09-27, commit `e5970e9`)

Every ticket has **two identities**:

- **Ticket number `SK-EVT-YYYY-NNNNNN`:** the permanent identity, used on receipts, for support and in AdminOS. It is
  random within the year, unique via `eventTicketNumbers/{number}`, and immutable.
- **PIN `NNNN`:** the event-day admission credential. Staff type it; no scanner is needed.

The 8-character PIN of the first build is replaced by a 4-digit PIN (owner brief). The PIN is drawn **independently**
of the ticket number: it is never the ticket number's last 4 digits and never a truncated hash. The two are tied only
visually, printed together on one ticket.

| Control | Implementation | Proven by |
|---|---|---|
| PIN format | exactly 4 digits, `crypto.randomInt` (no `Math.random`); 20,000 draws cover the whole 0000–9999 space | `test-event-ops` |
| PIN at rest | `HMAC-SHA256(SOKONI_HMAC_KEY, "evtpin\|eventId\|PIN")` on the ticket; raw PIN only in `eventTicketSecrets` (rules: **nobody** reads it, admins included) | ops · rules (emulator + counterproof) |
| Event binding | the hash includes the eventId. The same 4 digits on another event are a different credential: each admits only its own ticket | identity; sabotage `[pin]` |
| **Uniqueness within the event** | only 10,000 values exist, so collisions are routine. Free PINs are **chosen by reading** candidate index docs in the issuing transaction's read phase (`allocateIdentities`), then confirmed with `create()`. Never create-and-hope: a `create()` conflict is ALREADY_EXISTS, which Firestore does not retry, so it would fail a paid sale | identity: 300 tickets → 300 distinct; forced collision skipped; 12 checkouts forced onto one candidate → 12 distinct; 12 **concurrent** issuers (18 transaction runs = real contention) → committed PINs never shared, losers only ABORTED (retryable) |
| Never recycled | a PIN stays reserved for the event's whole life, so it can't pass to another ticket after the event | by construction (index never deleted) |
| Capacity | at most **8,000 tickets per event**, enforced when ticket types are configured. So a *paid* order never meets an exhausted space. A full 10,000 space refuses allocation cleanly, and a paid order there is recorded as an exception, never ticketed without a PIN | identity |
| **Lifetime** | ISSUED (before the admission window) → ACTIVE (window: 12 h before the start until 12 h after the end, overridable per event) → CONSUMED (admitted once) · EXPIRED (after the window) · SUSPENDED (refund in flight) · INVALID (refunded / void / cancelled event) | identity · ops · refunds |
| QR path | the optional SOKONI QR obeys the **same** lifetime (`admissibleReason`) and shares the one admission record | identity (refunded + expired refused by QR) |
| One-time admission | admission transaction + `eventAdmissions/{ticketId}` `create()`: 8 concurrent gates → exactly one; the second gets ALREADY_ADMITTED | ops; sabotage |
| **Guessing** | a 4-digit space is small. **5** wrong PINs / 10 min per staff member **and** 100 per event (distributed guessing), with transactional counters; even a correct PIN is refused while locked. Crossing a limit writes a security event (`event_pin_lockout`, no PIN in it). A guess never reveals whether the PIN exists at another event | ops; sabotage |
| Who sees a PIN | the buyer (`getMyTickets`); the selling cashier / organizer / manager for walk-in tickets (`eventSaleTickets`); **never** AdminOS (shown `••••`), audit rows, notices or logs. A refunded ticket shows no PIN and no QR | ops · sales · admin · identity · browser |
| Missing key | fails CLOSED in Cloud Functions; the in-repo test key is local only | ops + sabotage |
| Admin PIN identity lookup | the server hashes (event + PIN) and reads the index; returns the ticket only; every lookup audited | admin · browser; sabotage |

| **Ticket-number confirmation** (owner decision, `2c365df`) | a PIN alone never admits. CHECK TICKET shows the PIN's ticket **number**, event, type and status. Staff confirm that the attendee's ticket carries that number, then CONFIRM ADMISSION. The server **refuses** an admission without the confirmed number, and refuses one whose number ≠ the PIN's ticket; that mismatch counts against the guessing limits and is audited (`event_admission_mismatch`). "Doesn't match" (`eventAdmissionMismatch`) records the same. The admission record carries `confirmation: 'ticket_number'`. The QR path is unchanged: its 128-bit token names one ticket | identity (8 checks) · browser (button disabled until confirmed; Doesn't match) · sabotage `[confirm]` 4/4 |

**Residual risk (inherent in 4 digits, stated rather than hidden):**

- A random 4-digit guess matches *some* valid ticket with probability *issued ÷ 10,000*: 20 % for 2,000 tickets.
- The throttle stops enumeration by staff accounts. It cannot stop a person at the gate reciting a random PIN.
- **Control now built in (enforced):** the attendee must present the ticket whose number the PIN resolves to, and
  staff confirm it before the server admits. A recited random PIN resolves to *someone else's* ticket number, which
  the stranger cannot show.
- **What the server cannot do:** see the physical ticket. The number comparison is the staff member's recorded act. The
  server enforces that it happened, and that it names exactly the PIN's ticket.
- **Large events:** events above 8,000 tickets will use a **6-digit mode** (owner decision; not built — §12). The
  4-digit namespace is not stretched.

### SOKONI QR vs KRA fiscal QR

| | SOKONI TICKET QR | KRA / FISCAL |
|---|---|---|
| Content | `sokoni-ticket:<ticketId>:<token>` (random 128-bit token) — never the PIN, a payment secret or personal data | only what KRA returned for the sale's eTIMS invoice: QR image (https only), receipt number, verification link |
| When | every valid ticket (online, cash, card, M-PESA at the till) | only when KRA **accepted** the invoice (CONFIRMED) |
| Otherwise | hidden for refunded / suspended tickets | the fiscal STATUS in words: *Pending fiscal confirmation* · *delayed — SOKONI is reconciling* · *organizer not registered for eTIMS* · *free ticket* |
| Drawn by | `sokoni-qr.js`, locally (no network, no paid scanning service) | never drawn by SOKONI; a non-https KRA value is never rendered as an image or link |

- **Fiscal authority:** `functions/event-fiscal.js`. It writes one record per **paid** sale (online, cashier M-PESA,
  cash, card) in the sale's own transaction, and submits it after commit through the **existing**
  `etims.generateForOrder`, with the organizer as seller, **queued**. `etimsProcessQueue`, which holds the eTIMS
  secrets, transmits and retries.
- **The `etims.js` change is additive:** `submitNow:false` plus an exported `requeueInvoice` that its own resubmit
  callable now uses. Existing callers are unchanged.
- **Separate states:** payment, ticket, admission and fiscal are independent. `PAYMENT=COMPLETE · TICKET=ISSUED ·
  FISCAL=PENDING` is a valid ticket.
- **Failure handling:** a failure goes to **AdminOS › Entertainment › Fiscal (KRA)**, with an audited retry through
  the same paths.
- **Refunds:** a refund marks the record CREDIT_NOTE_REQUIRED when an invoice exists. The credit note itself is
  issued through the eTIMS lifecycle, not faked here.
- **Nothing fabricated:** no KRA QR, receipt number, control-unit number, signature or confirmation is ever produced
  by SOKONI.

### Fiscal state machine and credit notes (credit-note slice)

**Authorities, audited before changing anything:**

| Authority | File / function | Status |
|---|---|---|
| Event sale | `eventOrders` (online, `event-hub.purchaseTickets`) · `eventSales` (door, `event-sales.quickSale`) | canonical, unchanged |
| Ticket | `eventTickets` (`event-ops.issueCredentials` via activation / door sale) | canonical, unchanged |
| Payment | `payments/{ref}` + `paymentIntents/{ref}` (`payment-intents`, webhook) | canonical, untouched |
| Fiscal record | `eventFiscal/{saleKey}` (`event-fiscal.recordSale`) → `etimsInvoices/{id}` (`etims.generateForOrder`) | extended (one vocabulary); the original is **immutable** after a refund |
| Refund case | `eventRefundRequests/{orderId}` (`event-refunds` wizard; `event-settlement` for AdminOS refunds) | extended (amounts, penalty, policy version, admission and fiscal status) |
| Refund execution | `financial-os` `fosSubmitRefund` → admin approval → provider → `_afterRefundSettled` → `event-settlement.onEventRefundProcessed` | canonical, **untouched** |
| Refund policy / penalty | `events.refundPolicy` (`event-refunds.setPolicy` / `amountsFor`) | penalty **added** (owner decision) |
| KRA / eTIMS adapter | sale: `etims.submitToKra` via `etimsProcessQueue` · credit note: `etims-lifecycle.applyLifecycleOp` → `creditNotes` → `etimsTransmissionQueue` → `etims-kra-adapter` (**`SPEC_LOADED=false`**) | reused; credit-note transmission not implemented platform-wide |
| AdminOS Fiscal | `event-admin` `eventAdminFiscal` / `FiscalRetry` / `CreditNoteRetry` / `CreditNoteResolve` + panel tab | completed |

**One vocabulary:**
- `fiscalStatus`:
  - `FISCAL_NOT_REQUIRED`, with a reason: `ORGANIZER_NOT_REGISTERED`, `FREE_TICKET` or `NO_FISCAL_RECORD`;
  - `FISCAL_PENDING`;
  - `FISCAL_ACCEPTED`;
  - `FISCAL_FAILED`.
- Credit note: `CREDIT_NOTE_REQUIRED → CREDIT_NOTE_PENDING → CREDIT_NOTE_ACCEPTED`, with two other outcomes from PENDING:
  - `CREDIT_NOTE_FAILED`: a definitive rejection; retry is allowed on the same credit note.
  - `CREDIT_NOTE_OUTCOME_UNKNOWN`: a timeout, a 5xx, or a "000" without a reference. There is no blind retry; a super
    admin resolves it **only** as "not accepted", with evidence, and it can then be retried.

**Linkage:** refund case → refund settled by the canonical authority → `eventFiscalReversals/{executionId}`.

- **Execution identity:** `executionId = sha256("evtcn|<fiscalRecordId>|<refundCaseId>")`. That is one credit note per
  (fiscal record, refund case), never a clock, random or client identifier.
- **Linked, never overwritten:** the reversal links to the original, which is never written.
- **Build:** it is built on `etims-lifecycle` with `idempotencyKey = executionId`, so the `creditNotes` document ID is
  deterministic.
- **Amount:** it reverses **the approved principal only**, never the penalty, gross, commission or provider fee.
- **Waiting:** while the original invoice is not accepted, the credit note waits in REQUIRED. The existing 15-minute
  sweep executes it once the original is accepted.
- **Provider answers:** they enter through **one server-only function** (`recordCreditNoteOutcome`). It is not a
  callable, not an AdminOS form, and no field anywhere accepts a receipt or reference.

**Penalties** (owner decision: the event refund policy is the commercial authority):
- The organizer sets `penalty {type: fixed | percent, value}`. It is shown before purchase and locked after the first
  sale.
- It applies to buyer-driven reasons only (change of plans, no-show). A cancelled or changed event, and payment errors,
  are always refunded in full.
- The canonical refund authority is asked for the principal (gross − penalty).
- On settlement the tickets are refunded, and the organizer's settlement is recomputed on the kept penalty: the provider
  fee stays deducted, and the 3% is re-based on what was kept.

**External gate — UNPROVEN, not hidden:**
- There has been no KRA call. The sale invoice path has never run against KRA sandbox.
- **Credit-note transmission to KRA does not exist anywhere on the platform yet.** `etims-kra-adapter` has
  `SPEC_LOADED=false`, so every credit note queues as `blocked_pending_spec`, which AdminOS shows.
- CREDIT_NOTE_ACCEPTED is reachable in tests only through the server ingress, fed simulated provider answers.
- Closing this needs two things:
  - the KRA credit-note payload mapped in `etims-kra-adapter.js` (the only file to change);
  - a drainer that calls `recordCreditNoteOutcome`.
- Both then need certification in the eTIMS sandbox with a registered organizer.

### Final gates (this slice)

| Gate | Result |
|---|---|
| Ticket number authority | GREEN — SK-EVT-YYYY-NNNNNN, indexed, immutable across replays |
| 4-digit PIN authority | GREEN — server-generated, `crypto.randomInt`, independent of the ticket number |
| PIN uniqueness | GREEN — read-phase allocation; concurrency and forced-collision proofs |
| PIN one-time use | GREEN — concurrent admissions → exactly one |
| Event-day expiry | GREEN — ISSUED / ACTIVE / CONSUMED / EXPIRED, on the PIN and QR paths |
| Brute-force protection | GREEN — 5 per staff / 100 per event per 10 min + security event |
| 4-digit stranger-guess resistance | GREEN — server-enforced ticket-number confirmation; mismatches counted + audited (was: design decision) |
| Online ticket verification | GREEN — the gate cashier checks and admits an online ticket by PIN (browser) |
| Quick Sale ticket verification | GREEN — Check ticket mode reuses the canonical admission screen and authority |
| Cash / card / M-PESA ticket accountability | GREEN — every ticket has its own number and PIN; mixed cart 2 + 3 → 5 distinct |
| SOKONI QR | GREEN — local, no PIN inside, hidden when unusable |
| KRA fiscal QR | GREEN (logic) / 🟡 **UNPROVEN** — shown only as KRA returned it; no KRA call made (sandbox certification is the next slice) |
| KRA reconciliation | GREEN — pending / failed / not-registered / credit-note queue + audited retry |
| Fiscal state machine | GREEN — one vocabulary (FISCAL_NOT_REQUIRED / PENDING / ACCEPTED / FAILED), server-authoritative |
| Credit-note lifecycle | GREEN — REQUIRED → PENDING → ACCEPTED / FAILED / OUTCOME_UNKNOWN on `etims-lifecycle`, idempotent (deterministic execution id), evidence-gated resolution |
| Refund → fiscal linkage | GREEN — refund case (amounts, penalty, policy version, admission + fiscal status) → credit note for the approved principal, linked to the immutable original |
| AdminOS Fiscal | GREEN — sale + credit-note states, retry where safe, evidence resolution (super admin), trace incl. `fiscal_reversal` |
| Security / sabotage | GREEN — forged payloads refused (rules + callables); 71 / 71 attacks caught |
| Real KRA/eTIMS sandbox | 🟡 **UNPROVEN** — no KRA call; credit-note transmission to KRA not implemented platform-wide (`etims-kra-adapter` spec pending) |
| Refunded ticket invalidation | GREEN — PIN and QR refused; no PIN / QR shown |
| Admission / refund separation | GREEN — refund suspends admission; admitted ≠ no-show (refund suite) |
| AdminOS ticket investigation | GREEN — number, sale, payment ref, buyer, cashier, admission / refund / fiscal status; PIN `••••` |
| Browser / mobile UI | GREEN — 360–1440 px, see §10 |
| Regression | GREEN — §10 |
| Sabotage | §11 |
| Production deployment | 🔴 **NOT YET — 0** |

---

## 4. Staff matrix

| Role | Quick Sale | Own sales | All sales | PIN admission | Marketing / promo | Staff mgmt | Finance | Money movement |
|---|---|---|---|---|---|---|---|---|
| Organizer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | wallet only, via the existing payout rail |
| Manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Cashier | ✓ | ✓ | ✗ | ✓ *(check + admit a ticket by PIN — owner brief 2026-09-27)* | ✗ | ✗ | ✗ | ✗ |
| Admission | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Marketing | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Platform admin (AdminOS) | ✗ | — | read | read | ✗ | **revoke** (reason, audited) | read / trace | ✗ |

These are assignments, not employment. `eventStaff/{eventId}_{uid}` is re-read on every call, so revocation and
expiry take effect immediately.

- Access cannot outlive the event by more than **48 h**.
- An invitation is accepted only by the **verified** email the organizer invited.
- No capability touches withdrawals, payout destinations, refund approval, commission, ownership or another event.

---

## 5. Money matrix

| Channel | Who holds the cash | SOKONI commission | Settlement | Organizer paid |
|---|---|---|---|---|
| Online (M-PESA STK) | SOKONI | 3 % of (gross − provider fee), `commercial-policy.event_ticket` | `eventSettlements/{ref}` HELD → RELEASED 24 h after the event | wallet credit (whole shillings; remainder recorded) — net of any outstanding door commission |
| Cashier → IntaSend at the till | SOKONI | same | same (the order IS the sale) | same |
| Cash at the door | organizer | 3 % of gross → `eventCommissionReceivables` OUTSTANDING | `ORGANIZER_COLLECTED` | n/a — the receivable is **netted oldest-first** from the next online release |
| Card on the organizer's terminal | organizer | same as cash | same | same; reference required and unique per organizer + provider |
| Unreported provider fee | SOKONI | none booked | `FEE_UNREPORTED` — releases nothing | after super-admin attestation with evidence |

### Quick Sale: adding and reducing tickets

Each ticket type has − / quantity / + controls, and the cashier can also type a quantity.

- The quantity is bounded by **the tickets left** and the server's **50-per-line** limit; − is disabled at 0 and + at
  the maximum.
- **Clear tickets** empties the cart, and a summary line shows what is in it ("2 × VIP · 1 × Regular").
- After each sale the cart empties and **tickets left is re-read from the server**.
- Changing the cart mints a new idempotency key, because a different cart is a different sale.
- An **M-PESA** cart with two ticket types is blocked and explained. The till M-PESA sale is one order through the
  canonical intent, so it takes one ticket type.
- The server re-checks every limit inside the sale transaction. The UI bounds only stop the cashier building a cart
  that would be refused.

### M-PESA

| Journey | Path | Proven by |
|---|---|---|
| Buyer online | `purchaseTickets` (seat hold) → `createPaymentIntent('event_ticket')` (server price) → `initiateSTKPush` (owner + amount checked against the intent) → IntaSend webhook → `payments/{ref}` → `eventOnTicketPayment` → tickets + PINs | `test-event-ops-browser` (real pages, real purchase / intent / activation; provider edge simulated) |
| Cashier at the till | `eventQuickSale` (intasend) → order = sale → same intent → STK to the **buyer's** number → same webhook / activation → sale COMPLETED, PINs to the cashier | `test-event-sales` (real `createPaymentIntent`) + `test-event-ops-browser` |
| Creator films | `film_access` intent → STK | `test-creator-hub` / `test-creator-completion` (M-PESA offered when nothing else is proven) |

- M-PESA by STK is its own rail and is **not** gated by the hosted-checkout capability record. Card, Apple Pay, Google
  Pay and other methods appear only when a Super Admin records them LIVE_AND_PROVEN with evidence.
- Film purchases additionally need `config/creatorHub.purchasesEnabled`, a Super Admin switch.
- **Unproven:** a real handset STK round trip on this branch. No provider call was made.

- **Validation:** amounts are server-priced, and a client price is ignored.
- **Door-sale checks:** cash must cover the total; the card amount must equal the total.
- **Inventory:** decremented in the sale transaction, never negative; the event capacity is enforced.
- **Idempotency:** the sale key is claimed with `create()` and bound to the cashier.
- **Pending card sales** expire after 30 min and release their seats.

---

## 6. Refund matrix

| Reason basis | Examples | Eligibility (server `decide()`) | Rail |
|---|---|---|---|
| organizer | event cancelled · postponed · venue changed · performer missing | cancelled → YES (even under "no refunds"); otherwise REVIEW; "cancelled" claimed on a live event → NO | fos* (admin approves) |
| policy | cannot attend · change of plans | only `before_cutoff`, before the deadline, no ticket admitted | fos* |
| no_show | did not attend | event allows it · after the event ends · within **14 days** · no ticket admitted | fos* |
| payment | duplicate purchase · wrong amount · payment issue | duplicate needs a real earlier paid order → REVIEW; others REVIEW | fos* |
| other | explained (≥15 chars, 3 words, no placeholders) | REVIEW | fos* |

- **Wizard flow:** reason → reason-specific questions → server eligibility (amount, policy, deadline, ticket and admission
  status) → submit. An ineligible request is explained and **cannot be sent**, and there is no one-click refund.
- **Refund states:** tickets go REQUESTED → REFUNDED, or back to NONE when rejected. A REQUESTED ticket is refused at
  the gate.
- **Request record:** `eventRefundRequests/{orderId}` stores the policy snapshot, reason, answers, amount, commission and
  provider fee.
- **The refund policy** is required to publish, and locks after the first sale.
- **Door sales** (cash or card) are refunded **offline** by the organizer; SOKONI has no rail for them.
- **Penalty (decided 2026-09-27, built in the credit-note slice):** the organizer's policy may keep a fixed amount or
  1–50 % on buyer-driven refunds (change of plans, no-show). It is shown before purchase and locked after the first
  sale. Organizer-side and payment reasons are always refunded in full. The wizard shows gross, fee and refund amount.
- **Refund case:** each case records gross, penalty, refund principal, policy version, admission states and the fiscal
  status at request time. AdminOS cancellation refunds get a case too.

---

## 7. Agreement matrix

| Role | Agreements | Version | Where signed | Enforced |
|---|---|---|---|---|
| `event_organizer` | event-organizer-agreement · event-ticketing-refund-obligations · event-staff-cash-handling · commission-agreement · payment-settlement-terms · data-processing-agreement (+ Professional Declaration) | v1.0 | Event Manager intake (`SokoniLegalGate`) | **server:** `applicationDecide` refuses approval without `complianceFor(uid, 'event_organizer')` |
| `creator` | creator-content-agreement · content-ownership-declaration · royalty-settlement-terms · data-processing-agreement | v1.0 | Creator Studio | new creators, dark-launched via `legalConfig/enforcement.creator` |
| `venue_owner` | venue-listing-agreement | v1.0 | venue listing | catalogue only |

The agreement text is `entertainment-terms.html` v1.0. It is explicitly **pending legal review**, and the owner must
approve the wording before deploy.

---

## 8. AdminOS matrix (Events)

| Operation | Op | Authority |
|---|---|---|
| Investigate: event · ticket · ticket number · order · sale · buyer · cashier · card reference · PIN identity | `eventAdminInvestigate` | admin; PIN lookups audited |
| Financial trace: Event → Tickets → Sale → Payment → Commission → Receivable → Organizer proceeds → Refund → Payout | `eventAdminTrace` | admin; each stage `observed` / `empty` / `n/a` with its owning record |
| Staff, invitations; admin revoke | `eventAdminStaff` / `eventAdminRevokeStaff` | admin; revoke needs a reason, audited |
| Admissions + wrong-PIN counters | `eventAdminAdmissions` | admin |
| Wizard refund requests | `eventAdminRefundRequests` | admin (approval stays in the fos* queue) |
| Door-sale commission receivables | `eventAdminReceivables` | admin |
| Overview · events / cancel · settlements · fee attestation · cancelled-event refund queue · exceptions | earlier `eventAdmin*` ops | admin; attestation super admin |

- **Row sanitisation:** every row leaves the server with pin, pinHash, token and qrData dropped, and phones and emails
  masked.
- **Deploy dependency:** `adminOsDispatch` binds the existing `SOKONI_HMAC_KEY`. Without that binding, the PIN lookup
  fails closed in production.

---

## 9. Notifications, communications, marketing

- **`event_ticket_confirmed`:** sent after the first activation only, and at issue for free orders. It never carries
  the PIN; it says "open My Tickets". No notice goes out for cashier walk-in orders.
- **`event_cancelled`:** one per online buyer order, deduplicated. The large-event cancel works: before this fix, one
  batch and the 500-write cap made it impossible.
- **`event_refund_update`:** sent when a request is received.
- **`event_staff_invite`:** an in-app notice when the email already has an account. The organizer's response is
  identical either way, so invitations cannot be used to probe which emails exist.
- **`organizer_approved`:** the type was missing before this slice, so approved organizers were never told.
- **Share link:** `/event-hub.html?event=<id>[&promo=CODE]` with copy and WhatsApp share. The code is prefilled, never
  applied; the server still validates it. There is no tracking pixel and no invented reach figure. Redemptions count
  on the promo code.
- **Connect (buyer ↔ organizer, organizer ↔ staff): NOT BUILT.** The Connect authority (C1/C2) and Comms are
  **owner-frozen**. An `eventOrder` anchor needs an `ANCHOR_TYPES` entry and a Connect anchor resolver, which is an
  authority amendment. It needs an owner decision.

---

## 10. Test results

| Suite | Result | Kind |
|---|---|---|
| `test-event-ops.js` | 55 / 0 | 4-digit PIN, staff (cashier checks tickets), admission, 5-per-staff lockout + security event, concurrency, fail-closed key |
| **`test-event-ticket-identity.js`** (new) | **75 / 0** | ticket number + 4-digit PIN authority, uniqueness under forced collision and real concurrency, 10,000-space exhaustion, 8,000 ceiling, lifetime (PIN + QR), mixed cart, SOKONI QR, fiscal via the REAL eTIMS path, reconciliation, AdminOS `••••` |
| `test-event-sales.js` | 46 / 0 | cash / card / IntaSend-at-till, inventory race, netting |
| `test-event-refunds.js` | 53 / 0 | policy, 18 reasons, `decide()`, wizard submit / compensate, reject / revoke |
| `test-event-settlement.js` | 84 / 0 | activation, HELD / release / refund, fee attestation |
| **`test-event-credit-notes.js`** (new) | **71 / 0** | fiscal state machine; refunds A–I (full, fixed + % penalty, no-show, cancellation bulk, after admission, after organizer paid, with / without fiscal record); no fake credit note (unregistered, no record, unpaid, expired, rejected, not approved, mismatched partial); idempotency (replay, 3 concurrent, refresh, AdminOS retry); provider outcomes (timeout, 5xx, rejection, 000-without-reference, accepted, terminal); forged payloads; original immutable; display; AdminOS trace |
| `test-event-admin.js` | 66 / 0 | guard (11 ops), search, credential stripping, PIN identity, trace incl. fiscal stage, staff, queues |
| `test-event-notifications.js` | 17 / 0 | notices, 523-order cancel (500-write cap enforced + counterproof), cancel race |
| `test-entertainment-agreements.js` | 25 / 0 | catalogue, signing, approval gate |
| `test-entertainment-registry.js` | 65 / 0 | categories, lifecycle, AdminOS wiring |
| `run-entertainment-rules.js` | 98 / 0 | served rules on a private-port emulator; every denial counterproofed under allow-all |
| `test-event-ops-browser.js` | 200 / 0 | real pages + real server logic incl. Quick Sale add/reduce, both M-PESA journeys, ticket cards (number, PIN, SOKONI QR, genuine KRA receipt), Show / Print / Send, Quick Sale Check ticket for an online ticket, AdminOS `••••` + Fiscal tab, 360 · 390 · 768 · 1024 · 1280 · 1440 px |
| `test-entertainment-browser.js` | 230 / 0 | Entertainment pages incl. legal gate |
| `test-creator-hub` · `-completion` · `-ui` · `-callback` · `-adminos-authority` | 260 · 66 · 64 · 78 · 19 / 0 | Creator Hub incl. M-PESA-only fail-closed checkout |
| `test-admin-os-wiring.js` | 316 / 0 | AdminOS registry |
| `test-etims-audit` · `-lifecycle` · `-tax-engine` · `test-commission-invoice` · `test-merchant-tax` | 6 · 16 · 22 · 52 · 95 / 0 | eTIMS unchanged by the additive `etims.js` interface correction |
| **`sabotage-event-ops.js`** | see §11 | 71 planted attacks |
| `test-refund-approval-gate` · `-authority-matrix` · `-exactly-once` (canonical refund authority) | 50 · 24 · 103 / 0 | no regression — `financial-os` untouched |
| `test-refund-authority-convergence.js` | **BASELINE harness error** | outside scope — §12 row 16 |

**Browser defects found and fixed:**

- A re-mounted section stacked click listeners, so one "Admit" tap fired two admissions.
- A bare `1fr` grid, and `.aos-main` without `min-width:0`, let wide tables widen the page on phones. Removing the
  AdminOS fix fails the 360/390 checks.
- The AdminOS panels' shared CSS classes were undefined.
- **Sale-complete cards showed "Fiscal status unavailable" for every gate sale.** The server returns the fiscal
  state per SALE, but the card read it per ticket. Fixed; a sabotage attack now guards it.

---

## 11. Sabotage

`node scripts/sabotage-event-ops.js` plants **50** attacks across 10 groups: pin, identity, fiscal, staff, sales,
refund, admin, notify, rules and browser. For each attack it runs the suite that owns the control, requires the **expected** case to go red,
restores the file byte-for-byte, and then proves the tree is green again.

**71 / 71 CAUGHT** (credit-note slice).

- **Full run:** 70 caught and 1 missed, with 0 crashed and 0 no-anchor. All 9 suites were green after restore, and
  every sabotaged file was byte-identical to its pre-run content (sha-256). The restore check is now independent of
  what is committed.
- **The miss:** "an unknown outcome retried blindly" removed only the explicit UNKNOWN refusal. The general "only a
  FAILED credit note is retried" rule still refused the retry. The attack now removes both layers, and the
  `[credit]` group re-ran 16/16 caught.
- **Before this slice:** 54 / 54. The confirmation hardening added 4 `[confirm]` attacks, all caught.

- **Full run** (`e5970e9`): 45 caught, 2 missed, 2 crashed, 0 no-anchor. All 8 suites were green after restore, and the
  tree was byte-identical.
- **Crashes:** the two crashed attacks (PIN derived from the ticket number; create-and-hope) *did* break the suite,
  but as an uncaught exception. A crash is not a detection, so those sections now report failures as FAIL lines.
- **Misses:**
  - "a pending sale shown as CONFIRMED" hit the *unsubmitted* branch, which no test reached.
  - "free tickets fiscalised" removed a guard no current flow reaches (defence in depth).
  - Both guards are now tested directly.
  - A second attack covers the *queued invoice* branch.
- **Re-run** (`239b2f3`): identity 6/6 and fiscal 7/7 caught, suites green, tree byte-identical. The other 37 attacks'
  code and tests are unchanged since the full run.

- Earlier, the first run MISSED "AdminOS keeps the searched PIN on the page": removing two of the three protective layers is
  still safe.
- The attack is now all three layers together.
- A PIN retained only in closure memory is not observable from the page; that is recorded here, not hidden.

---

## 12. Known gaps / technical debt

| # | Severity | Gap | Next step |
|---|---|---|---|
| 1 | High | Branch not on the live lineage (see [[ENTERTAINMENT_HUB]] L-2) | owner's canonical-version decisions, then convergence |
| 2 | Medium | Buyer ↔ organizer and organizer ↔ staff Connect | owner authorizes a Connect / Comms authority amendment (`eventOrder` anchor) |
| 3 | Medium | Refund penalty / fee retention UNDECIDED | owner decision; `decide()` + the wizard quote are the single place to apply it |
| 4 | Medium | Agreement wording is v1.0, pending legal review | owner / legal approval before deploy |
| 5 | Medium | Door-sale refunds are offline | a policy for recording them (they would reverse the receivable) |
| 6 | Low | `cancelEvent`: an order paid after the pending-refund query stays `paid` (release is still refused because the event is cancelled) | sweep `paid` orders of cancelled events into the refund queue |
| 7 | Low | Creator agreement enforcement is dark-launched | super admin flips `legalConfig/enforcement.creator` |
| 8 | Low | Rules `isAdmin()` reads `token.admin` / `superAdmin`, while `admin-claim.js` also accepts `isAdmin` | a platform-wide claim decision (not Events-specific) |
| 9 | ~~Medium~~ **CLOSED `2c365df`** | 4-digit PIN density (a random guess matches a valid ticket with probability issued ÷ 10,000) | server-enforced ticket-number confirmation (§3) |
| 10 | Medium | Events above **8,000 tickets** cannot be configured (4-digit ceiling, kept as an invariant) | **decided:** a 6-digit PIN mode for large events — per-event `pinDigits` chosen before the first sale, its own ceiling, same allocator. Not built |
| 11 | High (release gate) | **KRA live path UNPROVEN on this branch:** invoices are created and queued through the real `etims.js`; no KRA call was made. The KRA-accepted state is simulated with the fields `submitToKra` writes | **next slice:** eTIMS sandbox certification (`ETIMS_ENV=sandbox`, a registered sandbox taxpayer) — needs the owner's go-ahead and sandbox credentials |
| 12 | ~~Medium~~ **BUILT (credit-note slice)** | Credit-note lifecycle | refund → the original stays immutable → CREDIT_NOTE_REQUIRED → `etims-lifecycle` credit note (idempotent) → PENDING → ACCEPTED / FAILED / OUTCOME_UNKNOWN, linked to the original (§3) |
| 15 | High (external gate) | **KRA credit-note transmission is not implemented platform-wide:** `etims-kra-adapter` has `SPEC_LOADED=false`; credit notes queue as `blocked_pending_spec` and nothing drains `etimsTransmissionQueue` | map the credit-note payload in `etims-kra-adapter.js`, add a drainer that calls `event-fiscal.recordCreditNoteOutcome`, then eTIMS sandbox certification |
| 16 | Low (baseline, outside scope) | `test-refund-authority-convergence.js` harness error (§7b parses the `merchant-identity.js` / `workforce-identity.js` POS role tables) | pre-existing; neither file is touched by the Events slices |
| 13 | Low | Organizer not registered for eTIMS → tickets say so (NOT_REGISTERED) | **decided:** keep this. SOKONI does **not** substitute itself as the fiscal seller and never manufactures an organizer receipt. "SOKONI invoices on behalf of the organizer" is a separate commercial / legal decision and implementation |
| 14 | Low | Existing tickets from the 8-character build | none exist outside tests (never deployed); no migration |

---

## 13. Deployment

```
FUNCTION DEPLOYMENT: 0
HOSTING DEPLOYMENT:  0
RULE DEPLOYMENT:     0
PROVIDER CALLS:      0
PRODUCTION WRITES:   0
```

**When deployed, this needs:**

- the functions `eventOpsDispatch`, `eventOnTicketPayment` and `adminOsDispatch`, all bound to `SOKONI_HMAC_KEY`
  (existing secret), plus the event-hub callables and `eventExpireUnpaidOrders` (fiscal sweep). The eTIMS
  `etimsProcessQueue` is unchanged and already holds the eTIMS secrets;
- the new rules blocks and indexes;
- hosting for `event-manager.html`, `event-hub.html`, `admin-os.html`, `entertainment-terms.html`,
  `sokoni-event-ops.js`, `sokoni-event-refund-reasons.js`, `sokoni-event-ticket.js`, `sokoni-qr.js` and
  `sokoni-aos-entertainment.js`.

**Onboarding self-mint hotfix (brief §23):** already its own deployment. `1171a16` was deployed alone on
2026-09-26 (`functions:onboardingDispatch`, revision `onboardingdispatch-00006-reg`) and verified live. Nothing from
this slice is bundled with it, and this branch is not deployed because that hotfix is safe.

**Blocked by:** the live-lineage convergence (gap 1), the legal wording (gap 4), and the Artifact Registry notice in
`CLAUDE.md` for any function rebuild. No migration is needed: new collections only, and existing tickets receive no PIN
retroactively. A backfill is an owner decision.
