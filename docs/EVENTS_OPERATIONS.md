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

## 3. Ticket security matrix

| Control | Implementation | Proven by |
|---|---|---|
| PIN format | 8 chars from a 32-char alphabet (no 0/O/1/I), `XXXX-XXXX`, `crypto.randomInt` — ~1.1 × 10¹² values | `test-event-ops` (1,000 PINs, no repeats) |
| PIN at rest | `HMAC-SHA256(SOKONI_HMAC_KEY, "evtpin|eventId|PIN")` on the ticket; raw PIN only in `eventTicketSecrets` (rules: **nobody** reads, admins included) | ops · rules (emulator + counterproof) |
| Event binding | the hash includes the eventId; a PIN from event A never matches event B | ops; sabotage `[pin]` |
| Uniqueness per event | `eventTicketPins/{eventId}_{hash}` via `create()` inside the issuing transaction — a collision retries | ops |
| Missing key | fails CLOSED in Cloud Functions (`K_SERVICE` / `FUNCTION_TARGET`); the in-repo test key is local only | ops (new) + sabotage |
| Who sees a PIN | the buyer (`getMyTickets`); the selling cashier / organizer / manager for walk-in tickets (`eventSaleTickets`); **never** AdminOS, audit rows, notices or logs | ops · sales · admin · notifications · browser |
| Guessing | 10 wrong PINs / 10 min per staff member **and** 200 per event, transactional counters; even a correct PIN is refused while locked | ops; sabotage |
| Double admission | admission transaction + `eventAdmissions/{ticketId}` `create()`; 8 concurrent gates → exactly one | ops; sabotage (all three layers removed together) |
| Refund in flight | REQUESTED / APPROVED / REFUNDED tickets are refused at the gate | ops · refunds |
| Admin PIN identity lookup | the server hashes (event + PIN) and reads the index; returns the ticket only; the PIN is not echoed, kept in page state or audited; every lookup (hit or miss) is audited | admin · browser; sabotage |
| QR | optional convenience; shares the admission record with the PIN | ops |

---

## 4. Staff matrix

| Role | Quick Sale | Own sales | All sales | PIN admission | Marketing / promo | Staff mgmt | Finance | Money movement |
|---|---|---|---|---|---|---|---|---|
| Organizer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | wallet only, via the existing payout rail |
| Manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Cashier | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
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
- **UNDECIDED (owner):** penalty or fee retention on refunds. The truncated brief ended at "5. EVENT ORGANIZER REFUND
  POLICY … ○ Not permit". Today every refund is full.

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
| `test-event-ops.js` | 51 / 0 | PIN, staff, admission, lockouts, concurrency, fail-closed key |
| `test-event-sales.js` | 46 / 0 | cash / card / IntaSend-at-till, inventory race, netting |
| `test-event-refunds.js` | 52 / 0 | policy, 18 reasons, `decide()`, wizard submit / compensate, reject / revoke |
| `test-event-settlement.js` | 84 / 0 | activation, HELD / release / refund, fee attestation |
| `test-event-admin.js` | 62 / 0 | guard, search, credential stripping, PIN identity, trace, staff, queues |
| `test-event-notifications.js` | 17 / 0 | notices, 523-order cancel (500-write cap enforced + counterproof), cancel race |
| `test-entertainment-agreements.js` | 25 / 0 | catalogue, signing, approval gate |
| `test-entertainment-registry.js` | 65 / 0 | categories, lifecycle, AdminOS wiring |
| `run-entertainment-rules.js` | 75 / 0 | served rules on a private-port emulator; every denial counterproofed under allow-all |
| `test-event-ops-browser.js` | 154 / 0 | real pages + real server logic incl. Quick Sale add/reduce and both M-PESA journeys, 360 · 390 · 768 · 1024 · 1280 · 1440 px |
| `test-entertainment-browser.js` | 230 / 0 | Entertainment pages incl. legal gate |
| `test-creator-hub` · `-completion` · `-ui` · `-callback` · `-adminos-authority` | 260 · 66 · 64 · 78 · 19 / 0 | Creator Hub incl. M-PESA-only fail-closed checkout |
| `test-admin-os-wiring.js` | 316 / 0 | AdminOS registry |
| **`sabotage-event-ops.js`** | see §11 | 33 planted attacks |

**Browser defects found and fixed:**

- A re-mounted section stacked click listeners, so one "Admit" tap fired two admissions.
- A bare `1fr` grid, and `.aos-main` without `min-width:0`, let wide tables widen the page on phones. Removing the
  AdminOS fix fails the 360/390 checks.
- The AdminOS panels' shared CSS classes were undefined.

---

## 11. Sabotage

`node scripts/sabotage-event-ops.js` plants 33 attacks across 8 groups: pin, staff, sales, refund, admin, notify,
rules and browser. For each attack it runs the suite that owns the control, requires the **expected** case to go red,
restores the file byte-for-byte, and then proves the tree is green again.

**33 / 33 CAUGHT** (0 missed, 0 crashed, 0 no-anchor). All 7 suites were green after restore, and every sabotaged file is byte-identical to HEAD.

- The first run MISSED "AdminOS keeps the searched PIN on the page": removing two of the three protective layers is
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
  (existing secret);
- the new rules blocks and indexes;
- hosting for `event-manager.html`, `event-hub.html`, `admin-os.html`, `entertainment-terms.html`,
  `sokoni-event-ops.js`, `sokoni-event-refund-reasons.js` and `sokoni-aos-entertainment.js`.

**Blocked by:** the live-lineage convergence (gap 1), the legal wording (gap 4), and the Artifact Registry notice in
`CLAUDE.md` for any function rebuild. No migration is needed: new collections only, and existing tickets receive no PIN
retroactively. A backfill is an owner decision.
