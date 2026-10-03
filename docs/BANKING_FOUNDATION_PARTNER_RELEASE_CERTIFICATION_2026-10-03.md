# Banking · Foundation · Partner · Promotion · Registration · Media — Release Certification (2026-10-03)

> **NOT DEPLOYED. FOUNDATION BALANCE NOT TRUSTED UNTIL RECONCILIATION/FIX IS LIVE. ALL REGISTRATIONS/APPLICATIONS REQUIRE ADMINOS APPROVAL.**
> **DEPLOYMENT QUEUED — MEMORY BELOW 512 MB** (observed 110–520 MB, 180 MB at report time).
> Supersedes the evidence table in [[BANKING_HUB_FOUNDATION_CERTIFICATION_2026-10-01]].
> Related: [[SOKONI_FOUNDATION]] · [[FINANCIAL_PARTNER_WORKSPACE]] · [[FOUNDATION_MEDIA_PIPELINE]] · [[Payments]] · [[AdminOS]]
> Classes: **PASS** (executed test, in code) · **UNPROVEN** (not executed, or not live) · **REVIEW** (owner decision). Nothing here is live.

## 1. Financial reconciliation report

**Census (2026-10-03, read-only, production Firestore REST).** Positive control: `orders` and `products` returned documents through the same reader.

| Collection | Documents |
|---|---|
| foundationDonations | **0** |
| impactLedger | **0** |
| impactBalance | **0** (no `current` doc) |
| foundationStats | **0** |
| impactDisbursements | **0** |
| impactCampaigns | **0** |

- Affected records: **0**.
- Verified paid: 0 · unverified: 0 · failed: 0 · refunded: 0 · held: 0.
- **Final trusted balance: KES 0 (verified).**
- The contamination risk was **latent**, not realised. However, the live `impactCheckoutDonate` (00007-seh, pre-fix) still mints "completed" records if called, so live is still exposed until the Foundation functions deploy.

**Gate (code).**
- `available = impactBalance.verifiedBalance − reservedKES`.
- `verifiedBalance` is written only by:
  - sokoni-5b's verified donation webhook (`ea47d87`), or
  - a two-admin reconciliation whose proposal was checked against IntaSend via the shared `intasendCollectionStatus` (`349bf9d`, ported byte-identical).
- If IntaSend is unreachable, the confirming admin must explicitly acknowledge it.
- Missing `verifiedBalance` = 0, so payouts are **blocked**.
- The public page shows verified money only. Unverified money appears only as "still being reconciled".

## 2. Partner commercial report
**Prices** (owner launch prices). These live ONLY in `functions/commercial-entitlements.js` (sha256 `5c2eb235…`, ported byte-identical into sokoni-5b's payment tree).

| Plan | Price | Notes |
|---|---|---|
| Starter | 2,500 / 30 days | |
| Growth | 5,000 / 30 days | |
| Pro | 10,000 / 30 days | |
| Enterprise | from 25,000 | custom; not self-serve |

**Entitlements.**
- Capabilities and limits per plan. Products: 20 / 50 / 100; team: 2 / 5 / 15.
- Free base: 10 products, 1 team member.
- Analytics only on Growth and up.
- An unknown or expired plan falls back to the base, never "everything".
- A plan never buys a review marker.

**Multi-entitlement architecture.**
- Marketplace plan: `subscriptions/{uid}` (untouched).
- Partner plan: `entitlements/{owner}__partner`.
- Campaigns: `promotionCampaigns/{ref}`.
- Receipts: `commercialFulfilments/{ref}`.
- All of these coexist (test C1/D1/E1).

**Payment path.**
1. `createPaymentIntent` with purpose `partner_subscription`. The server checks eligibility (approved listing, owner) and computes the price (`34e0a95`).
2. Payment through IntaSend STK.
3. Verified webhook (`0721389`) calls `fulfilPartnerSubscription`. Reads come first; it is idempotent on the intent ref and re-checks the amount against the confirmed GROSS. A mismatch goes to review.

**Renewal / cancellation.**
- Renewal extends from the current expiry.
- Changing plan starts the new plan from the switch date; the screen warns about this.
- There is no auto-renewal: each purchase covers 30 days, so cancelling means not renewing.
- Refunds go through the refund authority. **REVIEW:** a partner refund writer is not built.

## 3. Promotion report

| Product | Price |
|---|---|
| Listing Boost | KES 300/day (1–30 days) |
| Boost, 7 days | 1,500 |
| Category Featured, 7 days | 5,000 |
| Homepage Spotlight, 7 days | 12,000 |

**Lifecycle.** Payment → verified webhook → `fulfilPromotion` → campaign `active`, dated. The campaign goes to `review` instead (paid, not serving) when:
- the amount mismatches, or
- the listing is not approved at payment time.

An admin can **stop** a campaign (reason required). History is kept.

**Serving.**
- The directory lists approved listings only, so a suspended or withdrawn listing stops serving automatically.
- Caps per placement: category 30, featured 6, homepage 3.
- Campaigns are marked "Promoted" / "Featured"; promotion never vouches for a listing.
- Free admin-granted promotion requests remain available.
- **UNPROVEN/REVIEW:** the Homepage Spotlight placement is not yet rendered on the home page; the home page belongs to sokoni-32's site-speed lane. A refund on stop goes through the refund authority (not built).

## 4. Banking report

| Destination | Rail |
|---|---|
| M-PESA | `intasend_b2c`, via the proven `finos-utils.intasendB2C` |
| Till / PayBill | `intasend_b2b`, IntaSend send-money provider MPESA-B2B (TillNumber / PayBill + account_reference) |
| Bank | `intasend_pesalink`, provider PESALINK with bank_code |
| Any destination | `manual` only when explicitly chosen; record + a second admin confirms |

**Bank catalogue.** `impactBankCodes` fetches `/send-money/bank-codes/ke/` and caches it, never hard-coded. An outage keeps the previous list. A bank not in the list is refused.

**Validation.** `/send-money/validate-account/` is called before payout:
- invalid → refused
- unavailable → REQUIRES_REVIEW; the super-admin must acknowledge it.

**Approval chain.**
- Initiator → different approver → super-admin authorizer.
- Authorizing **claims** the request (processing + reservation) in a transaction, so a double submission yields ONE transfer.
- A `requestId` idempotency key is mandatory.

**Reconciliation.**
- `/send-money/status/` decides: Completed → debit, Failed → release.
- The ledger is debited only on provider completion.
- Refunds use the same chain and post a reversal.

**UNPROVEN:** the PESALINK, MPESA-B2B, validate-account, bank-codes and send-money status contracts have never been run against SOKONI's IntaSend account. A sandbox run is owed (owner credentials). Only MPESA-B2C is proven on this platform.

## 5. Registration report
**Application lifecycle** (sokoni-27's `applicationLifecycle`; K13-A/B live): submitted → under_review → approved | rejected | info_requested | suspended. Only the admin callable `applicationDecide` changes an application's status. The directory projection (`financialProviders`) is written only by the lifecycle.

**AdminOS Applications queue.**
- Existing: list, approve, reject, suspend, request info, reconcile.
- New, via `applicationReview`: claim / take-over / release, internal notes, archive (a view state), audit history.
- It never writes applications or decisions.

**Badge: "Registration reviewed by SOKONI"** (owner tooltip).
- Granted only by an admin-approved registration review (approved | rejected | needs_information); it can be revoked.
- It never comes from self-declared fields or from payment.

**Licence.**
- A separate admin record of an independent check against the issuing authority's register.
- The source is required; "uploaded document" is refused.
- A past expiry shows as **expired**.

**Gating.** Both markers are shown only while the listing is approved.

## 6. Media report
**Pipeline.** Upload (private) → `foundationMediaProcess` in a separate `media-worker` codebase.
- Validation: magic bytes → ffprobe (codec, duration, resolution, size).
- Video → H.264 ≤1280 px with faststart; image → WebP ≤1600 px with EXIF removed; JPEG thumbnail.
- Records go UPLOADED → PROCESSING → READY | FAILED | REJECTED and are written only by the worker.

**Publish.**
- Refused unless every file is READY.
- Publishes the derivative copy plus its thumbnail, never the original.
- Revocation deletes the public copies.

**Size limits.** Upload cap 80 MB video / 15 MB image, kept until the worker is proven in Cloud.

**Approval.**
- Stories and testimonials: DRAFT → REVIEW → APPROVED → PUBLISHED → ARCHIVED, inside the Foundation authority.
- An author cannot approve their own story.
- Consent is explicit and durable; a participant can withdraw it.

## 7. AdminOS report
Both AdminOS and Super Admin use the same shared modules (no `admin.html`):
- **Foundation** (5 tabs): overview with recorded / verified / requires-reconciliation / reserved / available; donations; send support with rails, bank picker and review acknowledgement; stories with processing state; reconciliation (classify, propose, confirm, IntaSend evidence).
- **Partner registrations:** approve / needs information / reject, revoke, licence check.
- **Partner plans & promotions:** entitlements, campaigns, fulfilments, stop campaign, promotion requests.
- **Payout approvals, Failures:** unchanged.
- **Applications:** review tools, on the union hosting tree.

## 8. Security report
**Client trust eliminated.** The server resolves owner, plan, price, campaign, programme, amount, bank, destination, status, approval and verification.

**Ownership checks.**
- Partner ops: listing must be approved; owner, manager or officer role.
- Pledges and stories are caller-scoped.
- Staff are bound to one partner.

**Authorization.** Admin claim required. Super-admin only for authorizing payouts. Two different admins are required for:
- payout approval vs. authorization
- confirming a manual payout
- reconciliation propose vs. confirm
- approving a story an admin wrote

**Idempotency.** Create-once IDs on:
- pledges, payouts (`requestId`), commercial fulfilments (intent ref), campaigns, members (phone), testimonials
- the webhook ledger (`DON_<invoiceId>`)

**Audit.** `adminActions` / `adminAudit` / story `transitions` / disbursement `auditLog` record: review decisions, badge granted/revoked, licence checks, promotion grants/stops, reconciliation, payouts, publish, and application review actions.

## 9. Test report (all executed; node; in-memory Firestore fake unless stated)

| Suite | Result | Sabotages caught (named assertion) |
|---|---|---|
| test-foundation-reconciliation | 13/0 | A1+E1 (recorded money spent), C1 (same-admin confirm), D1 (public shows recorded), P1 (amount check removed) |
| test-foundation-disbursements | 29/0 | I4 (unlisted bank accepted), I8 (review bypass); counterproof on 3a38f35 |
| test-foundation-content | 29/0 | C3 (self-approve), G4 (approved filter), E1-3 (media guard), M1/M3 (READY gate) |
| test-foundation-media-worker | 42/0 incl. **11 REAL ffmpeg 9.0.1 runs** | — |
| test-impact-foundation-guards / -checkout-pledge | 8/0 · 12/0 | counterproofs on original code |
| test-financial-partner-workspace | 51/0 | approval gate, self-verify, D2/T1 (badge before review), T3 (expiry ignored) |
| test-commercial-entitlements | 18/0 | A1 (browser price), E2 (unapproved listing serves), F1 (unknown plan = everything) |
| test-application-review | 7/0 | B1 (exclusive claim) |
| sokoni-5b: commercial intent / settle, donation settle, status helper | 10/0 · 12/0 · 19/0 · 8/0 | reported by sokoni-5b |
| AdminOS: foundation / partner regs / commercial / payout / failures / nav | 125/0 · 34/0 · 36/0 · 43/0 · 37/0 · 3/0 | S1–S7 (15b, 16d, 14b+3d, 15q, 18b/c/f, 5f, 6c/6d) |
| Public / partner pages: partner page / foundation page / intake / app-review UI / checkout / earn chain | 30/0 · 55/0 · 35/0 · 16/0 · 58/58 · 75/0 | B4, C1, 6e, R5, F9b-d |
| test-functions-hooks-execute / test-hosting-ignores-rules | 8/0 · 33/0 | — |
| **UNPROVEN** | Storage rules emulator suite (19 cases) **not run** (RAM) · any real-browser run · IntaSend sandbox for PesaLink/B2B/validate/status · media worker in Cloud | |
| **REVIEW** | partner/promotion refund writer · Homepage Spotlight rendering | |
| **CLOSED IN CODE (peer, owner-ordered)** | POS `pos.js` SIMULATED_ fallback removed by sokoni-b2 (hosting/intasend-card-wizard-on-72dca56 @ a436e12, NOT deployed); proper routing via sokoni-pos-stk.js owed on the union | |

## 10. Git report (all pushed to origin)

| Branch | Tip | Scope |
|---|---|---|
| `feat/foundation-on-3a38f35` | 8aedd10 | impact.js (gate, reconciliation, rails, refunds), foundation-content.js, intasend-send-money.js, shared/intasend-status.js, media-worker codebase, storage.rules, firebase.json (2 codebases), indexes |
| `feat/financial-partner-workspace-on-9012d90` | a64296e | financialPartnerDispatch, commercial-entitlements.js, application-review.js, indexes (on sokoni-27's lifecycle tree) |
| `hosting/banking-foundation-on-f13a912` | 6717106 | foundation.html/.js, banking.html + banking-hub.js, partner dashboard, checkout donation fix, AdminOS Applications review tools |
| `hosting/admin-failures-on-chain` | 6fe4e12 | AdminOS / Super Admin modules (merges via the AdminOS chain) |
| sokoni-5b | 34e0a95 · 0721389 · ea47d87 · 349bf9d · intasend-client-lock | intent purposes, settle handlers, verifiedBalance writer, status helper, client lock |

Every commit was staged file by file after `git status --short`; no stash, reset or foreign staging.

## 11. Deployment report

**PRECONDITION (2026-10-03):** both functions trees still export the 5 retired Daraja functions; sokoni-b2's rewritten guard-functions-safety (chore/remove-daraja-code-on-6e7bfe2 @ 093fd4f) BLOCKS such trees. CHERRY-PICK (never merge the branch — it sits on 6e7bfe2, a different lineage) the self-contained commit 093fd4f into `feat/financial-partner-workspace-on-9012d90` and `feat/foundation-on-3a38f35` then check: `node scripts/deploy/guard-functions-safety.js` passes, no identifier references a removed name (AST check), all gate scripts and suites green — before step 1 / step 3.
 (one deploy at a time; named scopes only; RAM ≥ 512 MB; live-archive diff per function first; never a bare `--only functions` — there are now 2 codebases)
1. **Partner tree** (`feat/financial-partner-workspace-on-9012d90`):
   - sokoni-27's `applicationLifecycle` first (owner authorization)
   - indexes
   - `functions:financialPartnerDispatch`, `functions:applicationReview`
2. **Firestore rules:** `financialProviders` readable when approved or by its owner; write false. The new collections need no match block (default deny); confirm there is no catch-all.
3. **Foundation tree** (`feat/foundation-on-3a38f35`, includes the security set):
   - indexes, then: `impactCheckoutDonate`, `impactPledgeDonation`, `impactGetMyPledge`, `impactUpdateCampaign`, `impactRecordMarketplaceContribution`, `impactInitiateDisbursement`, `impactApproveDisbursement`, `impactAuthorizeDisbursement`, `impactRefreshDisbursementStatus`, `impactRecordManualDisbursement`, `impactCancelDisbursement`, `impactAdminFoundationData`, `impactReconcileFoundation`, `impactBankCodes`, `impactGetPublicDashboard`, `foundationContentDispatch`, `foundationStoryMediaGuard`
   - then `functions:media-worker:foundationMediaProcess`
4. **sokoni-5b lane:** `createPaymentIntent` (donation + partner_subscription + promotion_purchase), then `webhookIntasend` settle (donation + commercial), after their completion-PIN step and within the webhook containment rules.
5. **Storage rules** (`--only storage` from the Foundation tree), after the emulator suite passes. Then verify the `firebase.storage` release pointer.
6. **Hosting:**
   - sokoni-b2's / union hosting, which carries the live till fix `ec71c3c`
   - then `hosting/banking-foundation-on-f13a912`, rebased on the live tip and merged with the trust branch and sokoni-5b's client lock
   - then the AdminOS chain, including `hosting/admin-failures-on-chain`

**Live verification after each step.**
- `gcloud functions describe`: revision Ready, 100% traffic, archive equals the tree.
- `version.json` matches the commit, checked with a cache-buster.
- Directory and profile, signed out: approved rows only, badge only when reviewed.
- KES 10 donation: `DON_` + `DONFEE_` ledger entries and verifiedBalance increase; a replay is a no-op; a failed payment gives no credit.
- KES 2,500 Starter purchase: entitlement created once; the marketplace subscription is unchanged.
- KES 100 M-PESA payout through three admins: debited only after IntaSend reports Completed.
- **IntaSend sandbox:** PesaLink, Till and PayBill payouts, validate-account, bank-codes.
- A test video goes READY; publishing serves the derivative; archiving makes the URL 404.
- Re-fetch the deployed Firestore and Storage rulesets and diff them against the candidates.

## 12. Owner authorization 2026-10-03 — progress

**Applications (read-only production census, positive control on products):** 13 applications — 9 approved, 1 rejected, 3 pending; 0 `applicationDecisions` records. All 9 approvals carry `decidedBy` and were decided **2026-07-24 … 2026-09-03, before the K13-B gate went live (2026-10-01 02:10Z)** — legacy approvals, not post-gate bypasses. **No application was approved after the gate without a server-recorded decision.** `financialProviders`: **0 listings** (none can exist without an approved application). Submission ≠ approval holds on the live code path (K13-A/B). REVIEW: whether to back-fill decision records for the 9 legacy approvals.

**SmartPOS M-PESA (owner-authorized fix):** `hosting/pos-stk-route-on-a436e12` @ 99e1177 (on sokoni-b2's a436e12, which removed the SIMULATED_ path). `pos.js` sendSTK now runs through the existing IntaSend POS rail (`SokoniPosStk` → posInitiateIntasendPayment → posCheckPaymentStatus); the sale completes only on the server's 'completed' status; no simulated path anywhere; split sales prompt for the M-PESA portion and no longer leak split metadata. Tests: pos-mpesa-intasend 9/0 (2 sabotages caught), daraja-leftovers 19/0. **OPEN (POS lane):** `posCompleteCheckout` (pos-zero-friction.js) accepts an `mpesa` payment line without reading `posPaymentStatus` — the client gate is not a server guarantee; the server check belongs to the POS convergence chain.

**Deploys:** none yet — free memory 180–395 MB (< 512 MB floor) and sokoni-b2 holds the slot. Foundation gate goes first when RAM allows: lineage diff of each live archive, then `impactCheckoutDonate` (stops false completion) + pledge/status reads, then sokoni-5b's donation intent + webhook, then verify verifiedBalance = 0 and a KES 10 end-to-end donation.

## 13. Owner assignment 2026-10-03 — SmartPOS server completion (separate P0 gate, NOT part of Foundation)

| Field | Value |
|---|---|
| OWNER | **POS workstream** |
| AUTHORITY | `posCompleteCheckout` |
| FILE / SEAM | `functions/pos-zero-friction.js` |
| PRIORITY | **P0 payment-integrity** |
| DEPENDENCY | IntaSend confirmed payment record (`posPaymentStatus/{ref}`, written only by the webhook) |
| STATUS | **OPEN — owner assigned** |

**Invariant.** A SmartPOS sale completes ONLY after the server verifies a confirmed IntaSend payment bound to the merchant, the amount, the payment reference and the sale key. Inventory, receipt and settlement happen only after that. Every other case fails closed: missing, unconfirmed, wrong merchant, wrong amount, wrong reference, or replayed.

**Acceptance tests (minimum):**
- SP-01 confirmed IntaSend payment → sale completes
- SP-02 missing payment record → refused
- SP-03 unconfirmed payment → refused
- SP-04 wrong merchant → refused
- SP-05 wrong amount → refused
- SP-06 wrong payment reference → refused
- SP-07 wrong sale key → refused
- SP-08 replayed payment → no second completion
- SP-09 fake / SIMULATED reference → refused
- SP-10 browser says success but provider record absent → refused

**Boundaries.** The POS owner does not modify the webhook security repair or the Foundation payout work. The browser-side SmartPOS fix (99e1177 / 863f0f6) is **not** the complete repair until this server gate is proven.

## 14. Finance + POS money-integrity repair (owner P0, 2026-10-03) — built, NOT deployed

Lanes: **sokoni-pos** (SmartPOS server) and **sokoni-finance-os** (Finance OS payouts), worked by this session at the owner's instruction ("you fix it"); kept on separate branches, never folded into Foundation.

**C. SmartPOS server payment (sokoni-pos)** — `fix/pos-server-payment-gate-on-3357619` @ e534623, on the certified POS line (3357619, which descends from live ee37437; it already required an IntaSend intent and webhook status for the same shop and sale key, plus a spent-once claim).

Gaps closed:
- **Partial payment:** the live webhook marks a POS prompt `completed` without comparing the paid amount to the requested amount. The gate now settles on the **provider-confirmed** amount (`confirmedAmountKES`); if that is absent, the sale is refused.
- **Currency:** KES only.
- **Closed tender list** {cash, mpesa, card, wallet}: `bank`, `mpesa_till_manual`, `gift_card` etc. used to count toward the tendered total unproven.
- **STK prompts:** an STK prompt can only settle an `mpesa` line.

Evidence:
- `test-pos-payment-gate-unit.js` 17/0: 3 sabotages caught, and the base fails 5.
- POS-01…POS-15 added to the emulator suite — **NOT RUN** (512 MB gate).
- certify-pos-payment-ownership: 40 pass, plus 5 T5 failures that are identical on the base (pre-existing).

Checklist:
- [x] server authority identified
- [x] payment record required
- [x] sale binding
- [x] merchant binding
- [x] provider amount
- [x] KES
- [x] verified IntaSend state
- [x] no SIMULATED reference
- [x] no browser-only success
- [x] replay
- [x] duplicate callback (terminal guard in the webhook)
- [ ] emulator proof
- [ ] real POS browser proof
- [ ] production revision

**B. Finance OS payout (sokoni-finance-os)** — `hosting/finos-payout-authority-on-72dca56` @ ea6493e.

Facts (read-only):
- `payouts` is the retired FinOS ledger: **0 docs**; both of its creators refuse.
- The live ruleset f259c0b5 already DENIES client writes to it (one read-only match, no catch-all).
- Real payouts are `payoutRequests` (7) via `adminProcessPayout`.

The browser completion write, its form and the row button are removed. The page points to AdminOS → Payments.

Evidence: `test-finos-payout-authority.js` 6/0 (FO-13 is also green against the live ruleset); the live page fails 3.

Checklist:
- [x] existing payout authority identified
- [x] browser completion write removed
- [x] direct Firestore completion denied (live rules)
- [x] wrong seller / amount / destination: payoutRequests are server-owned (read-only rules)
- [ ] emulator proof
- [ ] browser proof
- [ ] production revision

**OPEN, owner decision** (wallet engine is FROZEN):
- manual Mark Paid is single-admin attestation (`settled_manually`), not provider confirmation or a second admin (FO-04/05)
- webhook COMPLETED/REVERSED on rejected/failed payouts can release or credit twice (FO-06/09)

**A. Banking Hub fake wallet** — `hosting/banking-foundation-on-f13a912` @ 5e7e2a9.
- `sokoni-banking-pro.js` is deleted and loaded by no page.
- No browser-stored balance.
- Balances link to wallet.html / financial-os.html.
- service-worker.js is untouched (the entry is in the never-read PRECACHE_STATIC).
- Evidence: `test-banking-no-fake-wallet.js` 5/0 (the live tree fails A1).

Checklist:
- [x] fake wallet removed
- [x] no local balance authority
- [x] no browser-created transaction
- [x] authoritative source identified
- [x] empty state (no balance shown)
- [ ] reload/device and browser mutation proof (real browser)

**NOT DEPLOYED. FOUNDATION BALANCE NOT TRUSTED UNTIL RECONCILIATION/FIX IS LIVE. ALL REGISTRATIONS/APPLICATIONS REQUIRE ADMINOS APPROVAL.**
