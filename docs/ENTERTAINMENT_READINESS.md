# Entertainment Hub — Whole-Hub Readiness (2026-09-27)

Related: [[ENTERTAINMENT_HUB]] · [[EVENTS_OPERATIONS]] · [[CREATOR_HUB]] · [[INTEGRATIONS_CONTROL_CENTER]] ·
[[ETIMS_CERTIFICATION_READINESS]] · [[Payments]] · [[Authentication]]

Branch `feat/creator-hub`, base `3806e7e`. **Not deployed.** KRA provider protocol **DEFERRED** by the owner
(external dependency: KRA's OSCU / VSCU specification is not in the repository; credit notes must originate
from the same eTIMS solution as the original invoice, so none is invented here).

This sweep started from a four-part inventory (UI surfaces · server & admin authorities · money paths ·
lineage / communications / search / notifications). Every finding below was re-verified in code before it was
fixed or classified.

---

## 1. Authority map

| User surface | Server authority | Data authority | AdminOS control | Super Admin control | Audit | Tests |
|---|---|---|---|---|---|---|
| `entertainment.html` (Hub entry — **owns nothing**) | — (routes only) | — | — | — | — | readiness, ops-browser (walk) |
| `event-hub.html` (buyer) | `event-hub` callables, `payment-intents`, `event-refunds` | `events`, `eventTicketTiers`, `eventOrders`, `eventTickets` | Entertainment › Investigate / Trace | — | `eventOpsAudit`, `adminAudit` | event-*, ops-browser |
| `event-manager.html` (organizer / staff) | `event-hub`, `event-ops`, `event-sales` (`eventOpsDispatch`) | + `eventSales`, `eventStaff`, `eventAdmissions` | Entertainment › Staff & gate, Receivables | fee attest | `eventOpsAudit` | event-ops, sales, identity |
| organizer application | `applicationDecide` → `application-lifecycle` | `applications`, **`applicationDecisions`** (server-only), `legalAcceptances` | Applications | — | `adminAudit`, `legalAuditLog` | decision-authority, agreements, rules |
| `creator.html` / `creator-studio.html` | `creatorDispatch` (creator-hub) | `creators`, `entertainmentListings`, `contentAccess`, royalty ledger | Creator Hub panel | config, fee attest, distribution override | `adminAudit` | creator-* |
| `venue-booking.html` / `venue-manager.html` | `bookingDispatch` (booking + venue-booking) | `venues`, `venueBookings`, `venueBlockouts` | Entertainment › Venues & artists (**booking_venue**) | — | `adminAudit` | readiness, rules |
| Artists & services | provider marketplace (`services.html`, provider onboarding) | `providers` registry | Providers | — | — | (provider suites) |
| `entertainment-integrations.html` | `entIntegrationStatus` (caller-only) | read-only | Entertainment › **Organizer integrations**; AdminOS › Integrations `?hub=entertainment` | integration write surface (`sokoni-gcp-admin`, superAdmin) | — | integrations |
| Refunds | `event-refunds` → **financial-os** (canonical) | `eventRefundRequests`, `fosRefundQueue` | Refund requests / Refund queue (**server-priced** cancelled-event refund) | `fosResolveRefund` (evidence) | `adminAudit` | refunds |
| Payouts | `wallet.requestSellerPayout` (canonical) | `wallets`, `payouts` | Wallet / payouts | `adminResolvePayoutOutcome` (evidence) | `payoutResolutions` | (wallet suites) |
| Fiscal (KRA) | `event-fiscal` → `etims` | `eventFiscal`, `eventFiscalReversals`, `etims*` | Entertainment › Fiscal (KRA) | fiscal / credit-note resolve (evidence) | `adminAudit` | credit-notes, transmission |

## 2. AdminOS capability matrix

Every row is enforced by the server named; nothing is UI-only. **Super Admin** is the `superAdmin` custom claim
(Auth, server-minted — `grantPlatformRole` lets only an existing super admin grant `admin` / `superAdmin`). A
`isSuperAdmin: true` in request data or in a Firestore document grants nothing: every guard reads the token.
**Moderators hold no Entertainment capability** — none has been assigned, and every `eventAdmin*` /
`entAdmin*` / `creatorAdmin*` handler requires the admin claim.

| Capability | AdminOS location | Ordinary admin | Super admin | Moderator |
|---|---|---|---|---|
| Event (organizer) applications / approval | Applications (`applicationDecide`) | decide; approve requires the organizer agreements | same | — |
| Creator approval (account state) | Creator Hub (`creatorAdminSetState`) | yes (not own account); suspension hides published films | same | — |
| Creator verification | Creator Hub (`creatorAdminVerification*`) | yes (no self-review) | same | — |
| Ticket oversight | Entertainment › Investigate / Trace / Staff & gate | read, PIN shown `••••`, PIN lookups audited, revoke staff | same | — |
| Event settlement | Entertainment › Settlements | read | **attest provider fee** (evidence) | — |
| Creator settlement | Creator Hub › Royalties | calculate / approve / distribute (dual control) | override the distribution dual control (with reason) | — |
| Refund review | Entertainment › Refund requests; FinOS | approve / reject (`fosApproveRefund`) | same | — |
| Cancelled-event refund | Entertainment › Refund queue (`eventAdminRefundCancelled`) | submit — **amount from the payment record** | same | — |
| Refund execution oversight | FinOS | view | **resolve an unknown provider outcome** (evidence) | — |
| Payout oversight | Wallet › Payouts | view / manual mark (never for an unknown outcome) | **resolve an unknown outcome** (evidence) | — |
| Fiscal / KRA | Entertainment › Fiscal (KRA) | retry a definitive failure | **resolve unknown invoice / credit-note outcome** (evidence, only as NOT_ACCEPTED) | — |
| Integrations | AdminOS › Integrations (`?hub=entertainment`); Entertainment › Organizer integrations | read status | integration authority changes (`sokoni-gcp-admin`) | — |
| Venue / listing moderation | Entertainment › Venues & artists | approve / suspend / restore (canonical `venues` + legacy) | same | — |
| Communications oversight | — | **UNPROVEN** — SOKONI Connect is owner-frozen for Entertainment | — | — |
| Marketing moderation | — | **not built** — promo codes are organizer / marketing-staff scoped; no AdminOS moderation surface | — | — |
| User / support cases | AdminOS › Users / Support (platform) | yes | yes | platform moderator scope |

## 3. Payment matrix (category-scoped — never one global rate)

| Surface | Rail | Authority | Commission | Status |
|---|---|---|---|---|
| Creator (film PPV / rental) | IntaSend STK (hosted only when proven) | `priceFilmAccess` (film doc) → `film_access` intent → royalty ledger | **30 % SOKONI / 70 % rights holder** (`shared/creator-commercial.js`, Creator only) | GREEN |
| Events — online | IntaSend STK / hosted | `purchaseTickets` (tier price, whole shillings) → `event_ticket` intent → `event-settlement` | **3 %** of net (`event_tickets`) | GREEN |
| Events — Quick Sale cash / card / M-PESA | cash · organizer card terminal (external ref **required**) · IntaSend | `event-sales` (server-priced lines) | 3 % (door: receivable) | GREEN (door-only receivable collection: see gaps) |
| Online marketplace | IntaSend | marketplace lane | **15 %** | unchanged by this slice |
| POS / Till | till rail | POS lane | **5 %** | unchanged |
| Quick Charge services | POS lane | POS lane | **5 %** | unchanged |
| Venue bookings | **none** | `venue-booking` (price computed, not collected) | — | **UNPROVEN** — UI now says so |
| Legacy performer "deposit" | — | — | — | **REMOVED** (credited the payer's own wallet) |

## 4. Blockers found and fixed in this slice

| # | Class | Finding | Fix |
|---|---|---|---|
| S1 | SECURITY | Any user could self-mint an **event organizer** by writing `users.roles:['event_organizer']` (client-writable); event-hub trusted it | `requireOrganizer` reads the Auth **claim**; rules forbid adding server roles to `roles`; `publishEvent` re-checks (a suspended organizer cannot publish) |
| S2 | SECURITY | **Forged application approval**: applicant writes `status:'approved'` + `decidedBy:<a real admin uid>` (admin uids are public); trigger honoured it; reconcile would re-grant it | `applicationDecide` writes a server-only `applicationDecisions/{id}`; trigger and reconcile require it; rules forbid decisive status / decision fields from applicants |
| S3 | SECURITY | Every signed-in user could list every event's promo codes | read: admin only (codes are validated server-side) |
| S4 | SECURITY / PII | Legacy `entArtists` / `entVenues` / `entEvents` / `entReviews` public — phones, emails, pending & suspended records; client-writable prices / payment refs / status | client surface retired: owner + admin read, no browser writes; search sources moved to canonical `events` / `venues` |
| S5 | SECURITY | Venue owners could lift their own suspension and rewrite rating / reviewCount (rules and `venueUpdate`) | rules + server guard; suspension is an AdminOS decision (`booking_venue`) |
| S6 | SECURITY | Unlimited ratings on any listing, incl. Creator Hub films | one per viewer, only with access |
| S7 | SECURITY | Super admin (`superAdmin` claim) locked out of creator KYC documents | storage rule accepts the canonical claim |
| M1 | MONEY | Performer "Book Now" deposit: browser-priced STK with no intent → credited the **payer's** wallet; client chose provider + rate | removed from the Hub (the only Entertainment caller); the platform webhook fallback is listed below |
| M2 | MONEY | Buyers could call `fosSubmitRefund` directly for an event ticket (skipping eligibility, penalty, gate suspension) | event-ticket refunds enter only via the wizard or the AdminOS op |
| M3 | MONEY | AdminOS cancelled-event refund sent a **UI-supplied amount** | `eventAdminRefundCancelled`: amount from the payment record |
| M4 | MONEY | A retained refund penalty was never released (stranded) | released on the kept penalty |
| M5 | MONEY | Organizer could cancel after the event (refunds out of SOKONI's funds) | organizer cancel refused once started; admin decision |
| M6 | MONEY | Promo `maxUses` checked outside the transaction (over-redemption) | re-checked in the transaction's read phase |
| M7 | MONEY | Purchase idempotency key global (another buyer's order returned) | namespaced by buyer |
| M8 | MONEY | Fractional / NaN tier prices; percent promos left fractional totals | whole shillings enforced; promo rounded |
| U1 | USER-FACING | Hub entry ran on mock performers, fake LIVE stories, static bundles, localStorage bookings, success before server; never showed real events | rebuilt as a canonical entry point |
| U2 | USER-FACING | `venue-booking.html` threw on load; said "confirmed" for pending requests | boots; server status drives the wording; honest about payment |
| U3 | USER-FACING | `venue-manager.html` create / save called unexported callables; blocks invisible / undeletable | `bookingDispatch`; blocks read where they are written |
| U4 | USER-FACING | Organizer application could never be submitted (rules refused its `role` key) | key removed (`type` resolves the role) |
| U5 | USER-FACING | Suspended creators' films stayed listed / searchable | visibility follows the creator's state |
| U6 | USER-FACING | "KES 0" for unknown organizer figures; event-hub "Profile" → login; organizer link never shown; no My Tickets deep link | fixed |
| U7 | USER-FACING | `entertainment-terms.html` had no profile menu; legacy `ent-organizer.html` validated tickets from the client | shared header; legacy page redirects to Event Manager |
| A1 | AGREEMENTS | Acceptance records rewritable (merge) — time / signature / IP of the original could be replaced | write-once (`create`), repeat acceptance returns `unchanged` |
| A2 | ADMINOS | Canonical venues had no AdminOS control; organizer integration status had no AdminOS caller | `booking_venue` moderation; Organizer integrations tab |
| G17 | RELEASE GATE | `etims-release-gate.js` silently read **production** and passed on 0 records | fixture by default (positive controls), explicit `--live --project --env`, read-only, NO_DATA ≠ PASS |

## 5. Remaining — NOT fixed here, and why

| Class | Item | Why not here / next step |
|---|---|---|
| KRA DEFERRED | KRA credit-note spec, cmcKey, signing, credit-note endpoint; sandbox | owner deferral (external) |
| MONEY BLOCKER (platform) | `webhookIntasend`: a no-intent STK payment's seller falls back to the **payer** (`payData.uid`) and the rate to a client-chosen category | shared payment code, served from a commit no branch contains; Entertainment no longer calls it. Needs the Stage-1b "intent required" flip on the canonical payment lineage |
| MONEY (policy) | Door-only organizers: the 3 % receivable is only netted from online releases | owner decision on collection (invoice / wallet debit) |
| MONEY (platform) | provider-confirmed amount never reconciled to the intent | webhook lineage |
| MONEY (design) | Quick Sale card references are operator-attested, not provider-verified | accepted residual |
| MONEY (control) | admin refunds auto-execute on one admin (no dual control) | canonical refund authority unchanged by instruction |
| UNPROVEN | venue bookings have no payment rail | honest in the UI; product decision |
| UNPROVEN | SOKONI Connect for buyer↔organizer / organizer↔staff | owner-frozen authority amendment |
| GAP | no notifications for Creator Hub purchases / verification decisions or venue bookings | canonical `notify.js` types to register |
| GAP | Typesense events: status `live` vs secured-key filter `active`; `cancelled` not skipped | platform search infrastructure |
| GAP | organizers self-publish (no admin pre-moderation) | product decision; admin cancel + trace exist |
| GAP | creator legal gate dark-launched (`legalConfig/enforcement.creator`) | super admin flips it |
| LINEAGE | branch lacks 581 live commits; POS commission authority diverges; `commission-config` (9) / `finos-utils` (7) / `commission-collection` (4) have no chosen version; `wallet.js` frozen yet changed | owner canonical-version decisions + convergence |
| LINEAGE / SECURITY | the onboarding self-mint fix (`1171a16` / `e5ced91`) is **not on this branch**: deploying its `universal-onboarding.js` would regress production | must converge before any functions deploy from this branch |

## 6. Results (this slice)

| Area | Suites | Result |
|---|---|---|
| Events | ops 55 · sales 46 · refunds **61** · settlement **99** · admin **68** · notifications 17 · identity 75 · credit notes 71 · transmission 43 | GREEN |
| Readiness | `test-entertainment-readiness` **45** (new; positive control: every detector fires on the old page) | GREEN |
| Applications / agreements | decision authority **21** (incl. A8 real-admin forgery, A9 status swap, A10 demoted decider, 3 mutation controls) · legal compliance **47** · entertainment agreements 25 · merchant application 54 · provider agreement 27 | GREEN |
| Rules | entertainment **145** (with allow-all counterproof) · creator + storage **134** · connect 37 · delivery 22 · employment 26 / 40 · follow 40 · healthcare 33 · payment destination 26 · returns 20 · stories 24 · workspace 12 | GREEN |
| Rules — BASELINE | `test-landlord-rules` 25 / 3 — **identical 3 failures on HEAD's ruleset** (landlord self-approval / unit / tenant charge; not Entertainment) | BASELINE |
| Browser (real pages) | real-module walk **280** (Hub as visitor at 6 widths, click-through to Event Hub, unavailable state, legacy links, venue booking boot) · Entertainment browser **230** | GREEN |
| Creator | hub 260 · authority 19 · callback 78 · completion 66 · preview 46 · publishing 104 · royalty 94 · search 18 · ui 64 · withdrawal 21 | GREEN |
| Money | refund approval gate 50 · refund matrix 24 · refund exactly-once 103 · financial engine 21 · financial idempotency 25 · payout idempotency 11 · payout outcome unknown 62 · booking 16 / 10 / 11 / 15 / 19 · entitlement 24 · free entitlement 100 | GREEN |
| Money — BASELINE | `test-refund-authority-convergence` harness error in its POS role-table parser (files untouched) | BASELINE |
| AdminOS / integrations | wiring 316 · render 43 · integrations 36 · registry 65 · console CERTIFIED · console 68 · status 45 · parity 26 · probes 85 | GREEN |
| eTIMS / search | audit 6 · lifecycle 16 · tax 22 · commission invoice 52 · merchant tax 95 / 220 · release gate 16 (fixture) + gate test **18** · firestore search 23 · pipeline 15 · publication contract 36 | GREEN |
| Sabotage | `sabotage-event-ops.js`: **119 / 119 caught**, 0 missed, 0 crashed (26 new `[ready]`); integrations console 41 / 41; governance 8 / 8 | GREEN |

```
PRODUCTION DEPLOYMENT: 0
PROVIDER CALLS:        0
PRODUCTION WRITES:     0
PRODUCTION READS:      0 (this slice)
```
