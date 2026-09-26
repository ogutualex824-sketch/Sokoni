# Creator Hub — Film & Media Marketplace

**Status:** BUILT, TESTED, **NOT DEPLOYED** · **Readiness: BLOCKED** (see §13)
**Branch:** `feat/creator-hub` · **Base:** `a38b31a` · **Date:** 2026-09-26
**Owner decisions (2026-09-26):** adopt `entertainmentListings` as the film catalogue ·
frozen money paths may be changed and committed (not deployed) · full vertical, staged ·
**Creator PPV = SOKONI 30 % / creator pool 70 % of NET (gross − IntaSend fee)** — supersedes the
first slice's "gross − fee − ppv 15 %" (§17).

Related: [[CREATOR_HUB_OWNERSHIP_MAP]] · [[Marketplace]] · [[Payments]] · [[PAYMENT_ARCHITECTURE_UNIFICATION]] ·
[[WITHDRAWAL_ENGINE_CHANGE_PLAN]] · [[WALLET_FREEZE_ACCEPTANCE]] · [[AdminOS]] · [[docs/API]] · [[docs/SECURITY]]

---

## 1. What it is

A real marketplace vertical for films, series, documentaries, short films, music videos,
theatre and educational films — **inside the Entertainment hub** (no new hub), discoverable
through the canonical browse registry (`category.js` → `creator`). Four connected parts:

1. **Publishing** — creator identity, film drafts, private master upload, review workflow.
2. **Purchase & access** — the existing IntaSend rail, a server-priced `film_access` purpose,
   a durable per-purchase entitlement.
3. **Protected playback** — short-lived signed grants, session limits, a moving masked
   watermark, tamper reporting, revocation.
4. **Royalties** — versioned integer-basis-point agreements, an append-only ledger, quarterly
   settlement, release into the one canonical wallet, withdrawal on the existing payout rail.

Nothing parallel was built: no second payment system, wallet, payout provider, refund rail,
seller identity, or admin application. The audit and the reuse decision for every primitive is
[[CREATOR_HUB_OWNERSHIP_MAP]].

## 2. Architecture

```
creator.html / creator-studio.html          admin-os.html › Creator Hub (sokoni-aos-creator.js)
        │ creatorDispatch {op}                        │ adminOsDispatch {op: creatorAdmin*}
        ▼                                             ▼
functions/creator-hub.js  ── pure rules ──►  shared/creator-royalty.js      (money)
        │                                    shared/creator-publishing.js   (catalogue, playback)
        │                                    shared/creator-watermark.js    (watermark)
        ├─ payment-purposes  film_access pricer ──► createPaymentIntent ──► initiateSTKPush
        ├─ entitlement-adapters film_access ──► entitlement-engine (entitlements/{ref})
        ├─ creatorOnFilmPayment  (payments/{ref} → terminal paid)  ──► activate + accrueRoyalty
        ├─ onFilmRefundProcessed (called by financial-os refund finalizers)
        └─ Firestore: entertainmentListings · creators · royalty* · content* · playback*
           Storage:   creator-masters/{uid}/{film}/{upload}  (no client read)
                      creator-public/{uid}/**                (posters, avatars, trailers)
```

The pure modules hold every rule and are proven in isolation; `creator-hub.js` is I/O only.
`creator-publishing.js` and `creator-watermark.js` are UMD and served as
`sokoni-creator-rules.js` / `sokoni-watermark.js` — byte-identical copies
(`scripts/sync-creator-shared.js`, asserted by the publishing suite).

## 3. Data model

| Collection | Key | Writer | Client read |
|---|---|---|---|
| `entertainmentListings` | filmId | CF (`creatorHub:true`) | public when `status=='active'`; owner; admin |
| `creators` | uid | CF | public when `ACTIVE`; self; admin |
| `creatorPrivate` | uid | CF | self; admin |
| `creatorMedia` | filmId | CF | **none** |
| `royaltyAgreements/{film}/versions` | version | CF | film owner; admin |
| `royaltyParticipations` | `{uid}_{film}_v{n}` | CF (at lock) | the participant; film owner; admin |
| `contentEntitlements` | paymentRef | engine adapter | buyer; admin |
| `contentAccess` | `{uid}_{film}` | engine adapter | buyer; admin |
| `royaltyAccruals` | `acc_{ref}` | CF | film owner; admin |
| `royaltyLedger` | deterministic (§6) | CF | the participant; film owner; admin |
| `royaltyReversals` | refundId | CF | admin |
| `royaltyPeriods` | `YYYY-Qn` | CF | admin |
| `royaltyStatements` | `{period}_{uid}` | CF | the participant; admin |
| `royaltyDistributions` | `dist_{period}` | CF | admin |
| `playbackSessions` / `playbackAudit` / `playbackRate` | — | CF | admin / admin / none |
| `creatorExceptions` · `creatorPayoutHolds` | — | CF | admin |
| `entertainmentListingSecrets` | listingId | CF (legacy stream URLs) | none |
| `config/creatorHub` | — | CF (super admin) | none |

**Every client write is denied** (`firestore.rules` → `firestore.rules.build`). A film document
never carries a media URL or path. Six composite indexes were added (`firestore.indexes.json`).

## 4. Publishing workflow

```
creator:  DRAFT → SUBMITTED            REJECTED → DRAFT            APPROVED → PUBLISHED
admin:    SUBMITTED → UNDER_REVIEW | REJECTED     UNDER_REVIEW → APPROVED | REJECTED
          APPROVED → PUBLISHED | SUSPENDED        PUBLISHED ⇄ SUSPENDED
```

- No creator path reaches `APPROVED`; `PUBLISHED` is reachable by a creator only from `APPROVED`
  (asserted exhaustively over the transition table).
- **Submit** requires: creator `ACTIVE`, title/subcategory/poster/whole-KES price, a verified
  master, and a royalty split totalling exactly 100%.
- **Approve** locks the draft split as **v1** in the same transaction.
- A draft is editable only in `DRAFT`/`REJECTED`; the master is **create-only** in Storage, so
  an approved film cannot be silently swapped.
- Legacy `publishEntertainmentListing` / `purchaseEntertainment` refuse Creator films.

Creator identity: `creators/{uid}` (`PENDING → ACTIVE | REJECTED`, `ACTIVE ⇄ SUSPENDED`), admin-
approved. Private contact lives in `creatorPrivate`. There is no payout information on a creator
— payouts use the wallet's own payout details.

## 5. Payment & entitlement flow

```
buyer ─ createPaymentIntent({purpose:'film_access', filmId, phone})
        └─ pricer (server): kill switch · film PUBLISHED · creator ACTIVE · not own film ·
           not already entitled · licensed in buyer's declared country · KES ·
           amount = film.priceCents  → paymentIntents/{ref}  (metadata has NO sellerUid)
buyer ─ initiateSTKPush({phone, ref, amount = intent amount})
IntaSend ─ webhookIntasend: claim txn sets COMPLETE + providerReport{value, net_amount, charges, currency}
        └─ film_access branch returns BEFORE commissionLedger and the seller wallet credit
payments/{ref} → terminal paid ─ creatorOnFilmPayment
        ├─ engine.activate → entitlements/{ref} + contentEntitlements/{ref} + contentAccess/{uid}_{film}
        └─ accrueRoyalty → royaltyAccruals + royaltyLedger  (exactly once)
page    ─ polls catalog.get until viewer.access.status == ACTIVE   (never grants itself)
```

**Why the webhook branch exists.** Without it the webhook would credit
`sellerUid || merchantUid || payData.uid`: the film intent has no `sellerUid`, so the **buyer**
would be credited; with one, the creator would receive the full net instantly, bypassing the
split and the quarterly hold. A second guard in the credit branch refuses `film_access` even if
the early branch's intent read fails.

**Kill switch.** `config/creatorHub.purchasesEnabled` defaults to **false**. It must stay false
until the webhook change is deployed — the old webhook would credit the payer.

**Rentals.** `rentalDays` (1–30) rides on the server-minted intent; the adapter sets
`expiresAtMs`. An expired rental may be rented again.

**Refunds** use the canonical online rail (`fosSubmitRefund` / `fosApproveRefund`). For a film
payment the rail now attributes buyer = payer and debits no seller; after finalisation it calls
`onFilmRefundProcessed`: reversal ledger rows (never deletion), full refund revokes access,
partial refund keeps it (a price adjustment). A refund before accrual tombstones the accrual so a
later retry cannot recognise the refunded sale.

## 6. Royalty model

- **Agreement:** participants `{participantId, participantType, uid, displayName, legalRef, bps}`.
  Integer basis points (10000 = 100%), each `0 < bps ≤ 10000`, Σ ≤ 10000 for a draft and
  **= 10000 to lock**. One person may hold two different roles; the same uid in the same role
  twice is refused. Every participant needs a SOKONI uid — the only payable destination.
- **Versions:** a split change is a new version. Locking (admin only) is **never back-dated**:
  `effectiveFrom = max(now, previous.effectiveFrom + 1)`; the previous version becomes
  `SUPERSEDED` with `effectiveUntil`. Revenue uses the version in force when the payment was
  recognised; historical ledger rows keep their version.
- **Pool (§17):** `net = gross − providerFee − tax`; SOKONI `= floor(net × 3000 / 10000)`;
  `pool = net − SOKONI` (so SOKONI + pool = net exactly; a sub-cent remainder stays with the
  creators). The only rate input is `shared/creator-commercial.js` (`creator_ppv_v1`);
  `commission-config.js` is not read. Tax/levy = 0 (no policy recorded). The provider fee is IntaSend's reported
  `charges`, else `value − net_amount`; **if neither is reported the accrual is WITHHELD** and
  an AdminOS exception opens — the fee is never assumed to be 0. A super admin may attest the
  fee from the IntaSend dashboard (audited, only before recognition).
- **Allocation:** largest remainder — Σ shares equals the pool to the cent (2,000 random cases).
- **Separate buckets (§27):** `PARTICIPANT_ROYALTY`, `PLATFORM_COMMISSION`, `PROVIDER_FEE`,
  `TAX_LEVY`. Creator money is never SOKONI revenue, commission, seller proceeds or buyer balance.

## 7. Royalty ledger (append-only)

| Entry | Id | Claim |
|---|---|---|
| Accrual summary | `acc_{paymentRef}` | `create()` — the exactly-once claim |
| Participant earning | `earn_{ref}_v{version}_{participantId}` | `create()` |
| Commission / fee | `platform_commission_{ref}` · `provider_fee_{ref}` | `create()` |
| Reversal | `rev_{refundId}_{originalEntryId}` | `create()` + `royaltyReversals/{refundId}` claim |

Every row carries content, payment, version, participant, gross basis, deductions, pool, bps,
amount (integer cents), currency, period and status. **Replay** → `alreadyAccrued`;
**8 concurrent accruals** → exactly one (transactional fake with buffered commit and
`create()` preconditions).

## 8. Quarterly settlement & withdrawal

Periods are calendar quarters in **East Africa Time** (`2026-Q3`).

```
OPEN ─(after quarter end)→ CALCULATED ─(different admin)→ APPROVED ─(distribute)→ PAYABLE ─→ CLOSED
```

- **Calculate** (admin, only after the quarter ends; previous quarter must be settled): one
  statement per participant = Σ earnings − Σ reversals + carry-in → whole-KES `releaseKes`,
  the sub-shilling remainder and any reversal debt carried forward (never a negative credit,
  never a claw-back from a wallet).
- **Approve** must be a different admin from the calculator (super admin override needs a
  written reason).
- **Distribute** (per statement, one transaction): `create()` on
  `walletTransactions/{uid}_{period}_royalty` + `wallets/{uid}.balance += releaseKes` +
  statement released. Resumable, replay-safe, reconciles a lost statement write without
  re-crediting; participants under a **payout hold** are skipped until released.
- A sale whose quarter is already calculated is recognised in the open quarter (`recognisedLate`);
  a refund's reversal always lands in the open quarter — a frozen statement is never rewritten.
- **Withdrawal** is the existing `requestSellerPayout → payoutRequests → IntaSend B2C` path; a
  payout is marked paid only on provider confirmation. It enforces the balance, idempotency
  key, velocity and risk rules already. Minimum KES 100; Kenyan M-PESA/bank destinations only.

Dashboard buckets: **Accrued** (open quarter) · **Pending settlement** (calculated/approved) ·
**Released to wallet = available for withdrawal** · **Reversed** · carried. "Withdrawn" is the
wallet's payout history — royalty shillings are not a separate balance once released (no
parallel wallet).

## 9. Playback security

- `playback.authorize`: entitlement ACTIVE and unexpired (from `contentEntitlements`, not the
  pointer), film PUBLISHED, ≤ 2 concurrent live sessions, ≤ 30 authorisations/hour → a **10-minute
  V4 signed URL** to the private master, never stored, never in HTML.
- Heartbeat every 30 s; a revoked/expired entitlement ends the session. An expired URL is renewed
  for the same session and playback resumes.
- Risk flags (≥ 4 devices/24 h, ≥ 3 networks/1 h — hashed, coarse) are logged, not blocked.
- **Watermark:** server-built payload of masked identifiers only (first name · masked email or
  phone · 10-char session code · entitlement fragment · UTC minute), drawn over the video on a
  canvas that moves every 20 s, plus a faint forensic tile grid; the positions are a deterministic
  function of the session code so a leaked recording can be traced to a session. Native
  fullscreen and PiP are disabled; the container goes fullscreen so the overlay stays on.
  Removing or hiding the overlay pauses playback and reports the tamper.
- **Honest limits:** the watermark is an overlay, not burned into pixels; devtools can hide it,
  and a camera pointed at a screen defeats every web control. Nothing here is "copy-proof".
  DRM (Widevine/FairPlay) and per-session forensic encoding are not implemented.

## 10. AdminOS

`admin-os.html › Creator Hub` (`sokoni-aos-creator.js`, ops via `adminOsDispatch`):
creators (approve / reject / suspend / reinstate, payout hold / release) · film review queue
(start review, approve + lock v1, reject, publish, suspend, reinstate, detail with agreements and
accruals — never a media location) · agreement lock · ledger search · quarters (calculate,
approve, distribute, close, statements) · exceptions (retry accrual, attest fee) · playback
security events · entitlement revocation · config (purchases kill switch, hosted checkout switch,
IntaSend method capability with evidence — super admin). Every handler re-checks `admin-claim`;
admin actions are written to `adminAudit`. **AdminOS is the only Creator control plane** — full
authority map and legacy-page findings: [[CREATOR_PAYMENT_ARCHITECTURE]] §5–6.

## 11. Payment methods & currency — what is and is not claimed

- The page shows **"Payment methods available at checkout"**: M-PESA (STK) plus every hosted
  method a Super Admin has recorded **LIVE_AND_PROVEN with evidence** in
  `config/intasendCapability` — and only while the hosted switch is on. The free-text
  `config/creatorHub.checkoutMethods` list is retired (it named methods with no evidence).
- Hosted checkout (`initiateHostedCheckout`) is committed, shares the STK reservation
  (`paymentAttempts/{ref}`) and webhook, and refuses to open while nothing is proven. **No hosted
  method is proven today.** Method matrix, provider actions and the STK single-flight repair:
  [[CREATOR_PAYMENT_ARCHITECTURE]].
- **KES only.** The payment core (STK payload, `payments`, entitlement engine) settles KES;
  pricing in another currency would price in one currency and settle another (§9 of the brief
  forbids it). The currency is bound on the intent and reconciled against the provider's
  reported currency at accrual.
- **Country availability** is an explicit content rule (`worldwide` / allow-list / deny-list).
  A restricted title refuses a buyer whose declared profile country is unknown. The country is
  the user's declared profile value — **not** a geo-IP control.

## 12. Tests

| Suite | Result | Proves |
|---|---|---|
| `test-creator-royalty.js` | **94/0** | agreement invariants, versions, **30/70 of net (examples A 144/336, B 291/679, C withheld)**, rounding at the minimum unit, exact allocation, ids, EAT quarters, release/carry, reversal convergence, purity |
| `test-creator-publishing.js` | **104/0** | film + **verification** state machines (exhaustive), field contracts (last-4 only), KES, owned assets, availability, playback decision, watermark PII, three byte-identical hosting copies |
| `test-creator-hub.js` | **234/0** | server end to end on a transactional fake: purchase, entitlement, accrual, 8-way concurrency, refunds, quarterly settlement, **verification**, **rights attestation**, **viewer library / progress / devices**, **analytics (aggregates, owner-scoped)**, **guest checkout**, AdminOS guard sweep, wiring |
| `test-creator-callback.js` | **64/0** | the REAL `webhookIntasend` executed on BASE and BRANCH: base credits the buyer (positive control); branch film → royalty only, 30 % of net, replay-safe, second exit proven by logs; marketplace / POS / subscription / top-up stores identical to base; commission authority separation |
| `test-refund-exactly-once.js` | **103/0** | the REAL refund functions executed on BASE and BRANCH: base 2–3 refunds per request (positive control); branch exactly one provider call under success, transient failure, 5xx/429/throw, race, re-approval; seller debited once, buyer never |
| `run-creator-rules.js` → `test-creator-rules.js` | **105/0** | served Firestore + Storage rules on a private-port emulator, with an allow-all **counterproof** |
| `test-creator-ui.js` | **55/0** | Chromium: AdminOS module (incl. verification), UI ↔ server op parity, **pricing section rendered = server split**, page contracts |
| `sabotage-creator-hub.js` | **47/47 CAUGHT** (expected case, 0 missed) | 22 original + 15 money (callback, commission, refund) + 10 security (identity, verification, anonymous, cross-creator/buyer, watch-time, rules) |

## 13. Readiness — **BLOCKED**

| # | Blocker | Why it blocks "live" |
|---|---|---|
| B1 | **No deployment authorised**, and the functions deploy is independently blocked (Artifact Registry notice, merchant-identity provenance gap, foreign uncommitted files in `functions/` on the main tree) | nothing here runs in production |
| B2 | **Deploy ordering**: `webhookIntasend` + `financial-os` must be live **before** `purchasesEnabled` opens | the old webhook credits the payer; the old refund rail double-refunds |
| B3 | **Firestore rules release**: the source monolith is over the size limit; the served `.build` must be released via the Rules REST path per [[RULES_RECONCILIATION]] | Creator collections are default-deny until then |
| B4 | **Egress economics** — direct GCS delivery, unlimited re-watch | a popular film could cost more in egress than SOKONI's 30 % |
| B5 | **No transcoding / adaptive streaming / CDN** | large masters on mobile data |
| B6 | **Signed URLs in production** need `iam.serviceAccounts.signBlob` — UNPROVEN | playback and verification review links fail closed |
| B7 | **IntaSend fee reporting** on STK callbacks — UNPROVEN | every accrual withheld until a fee is attested |
| B8 | **Refund provider contract**: the adapter posts `/api/v1/payment/chargeback/ {api_ref}`; the field-proven contract is `/api/v1/chargebacks/ {invoice_id}` (ADR-032) | the refund call may not reach IntaSend at all |
| B9 | **Guest checkout = DECISION_REQUIRED** (§24): Anonymous Auth is platform-wide | flag stays OFF |
| B10 | Feature-proposal evidence (§15) not supplied | `ROADMAP.md` v2.0 policy |

## 14. UNPROVEN (stated, not assumed)

- Firestore's own contention behaviour (the fake proves the code's claim discipline, not Firestore's).
- IntaSend callback fields (`charges`, `net_amount`, `value`, `currency`) on the live account.
- Multi-method hosted checkout on the live account; any non-KES settlement.
- V4 signed-URL signing in production; playback of large masters on real devices.
- Egress cost per view (estimated USD 0.12–0.20/GB at list prices — measure before opening).
- Participant consent to a split — **DECISION_REQUIRED** (§20): the rights owner attests; participants do not sign.
- Refund claw-back: the refund debit writes `wallets.availableCents` while seller earnings live in
  `availableBalance`/`withdrawableBalance` — refunds do not reduce seller earnings (pre-existing, FinOS decision).
- Hot-counter sharding (10 shards) under real load; analytics "unique viewers" is per film, not de-duplicated across films.
- Watermark legibility after re-encoding by a pirate; forensic trace procedure.
- Declared-country accuracy for licence restrictions.
- Payout to non-Kenyan destinations (not supported by the existing rail).

## 15. Proposal record (docs/FEATURE_PROPOSAL_TEMPLATE.md)

**Proposed by:** founder (owner-commissioned 2026-09-26) · **Status:** Under review.
Sections 1 (user problem + evidence), 4 (business impact) and 7 (success metrics) **require
evidence the owner holds** and are left for the owner — none is invented here.
**Effort:** built in one slice (4 stages). **Infrastructure cost:** Storage for masters, egress
per view (B4), two Cloud Run services (`creatorDispatch`, `creatorOnFilmPayment`) plus larger
`adminOsDispatch`. **Rollback:** close `purchasesEnabled`; suspend films in AdminOS; entitlements
and the ledger are append-only and remain for audit. **Alternatives considered:** `products` +
`isDigital` (rejected — client-writable, public), a new hub (rejected — strategy), a royalty
sub-wallet (rejected — parallel wallet). **Dependencies:** B1–B7.

## 16. Deployment requirements (when authorised — in this order)

1. Resolve B1; deploy **`webhookIntasend`** (two film exits + `providerReport`), **`financial-os`**
   (`_executeRefund`, `fosResolveRefund`) and `payment-adapters`; verify a non-film payment
   still credits exactly as before (re-run `test-creator-callback.js` against the deploy tree).
2. Release rules via the Rules REST path from a reconciled `.build`; deploy `storage.rules`;
   deploy the 6 indexes and wait for `READY`.
3. Grant `signBlob` to the functions runtime SA (B6); deploy `creatorDispatch`,
   `creatorOnFilmPayment`, `adminOsDispatch` (redeploy — new ops), `createPaymentIntent`
   (purpose registry), `initiateSTKPush` untouched.
4. Hosting from the latest commit (guard enforced): `creator.html`, `creator-studio.html`,
   `sokoni-creator-rules.js`, `sokoni-watermark.js`, `sokoni-aos-creator.js`, `admin-os.html`,
   `category.*`, `entertainment.html`.
5. Run `probe-intasend-capability.js`; record verified methods in AdminOS › Config.
6. One KES-1-class live purchase end to end (fee reported? entitlement? accrual? refund?) before
   opening `purchasesEnabled`.
7. Verify live: `curl -s "https://mysokoni.co.ke/creator.html?cb=$RANDOM" | grep creatorDispatch`
   and `version.json`.

## 17. Commercial policy — Creator 30 / 70 of net (2026-09-26)

`functions/shared/creator-commercial.js` is the ONE Creator commercial authority
(`creator_ppv_v1`: `domain=creator`, `productType=pay_per_view`, `basis=NET_OF_PROVIDER_FEE`,
`sokoniCommissionBps=3000`, `creatorPoolBps=7000`; frozen; a policy not summing to 10000 is refused
at load). `commission-config.js` is byte-identical to base — marketplace stays **5 %**, the legacy
`ppv` 15 % is read by no Creator path, and mutating either cannot move the other (proven both ways).

| Example | Gross | Fee | Net | SOKONI 30 % | Creator pool 70 % |
|---|---|---|---|---|---|
| A | 500 | 20 | 480 | 144 | 336 |
| B | 1,000 | 30 | 970 | 291 | 679 |
| C | 500 | *unreported* | — | NOT FINALIZED | NOT FINALIZED (exception opened) |

Participant shares apply **inside** the pool only.

## 18. Payment-callback audit (executed)

`scripts/lib/webhook-harness.js` runs the real `webhookIntasend` from any tree on the
transactional fake (no network). On base `a38b31a` a film payment credits the **buyer** KES 412
and books a marketplace commission row. On this branch: no wallet / walletTransactions /
commissionLedger / ledger write; the royalty accrual books SOKONI 145.50 = 30 % of 485 and the
pool 339.50; replay = one allocation. Two exits: the early branch (intent purpose) and a second
exit on resolved attribution before the commission code — the suite proves from the logs which
fired, including when the early intent read fails. Marketplace, POS till, subscription and wallet
top-up produce stores identical to base (only timing/PIN noise measured on base itself is masked;
money documents are never masked).

## 19. Refund audit — P0 (executed)

Base, real code, fake gateway: an admin refund of a plain STK payment sent **two** IntaSend
refunds with nothing failing (finalize threw on the missing `fosTransactions` doc → the catch
reset the request to `approved` → approval re-executed); a dropped connection → 2; submit racing
approval → 3; a 503 retried blind → 2. The first slice's fix removed one trigger only.

Fix (canonical rail, no Creator rail): `_executeRefund` — one path for both entry points, lock
`pending|approved|failed → processing + executionId` before the ONLY provider call; outcome
classified (2xx settle · definitive 4xx → `failed` · throw/5xx/408/429 → `outcome_unknown`,
never re-executable); `_settleRefund` exactly once, guarded by executionId; a failed settlement
after provider success → `provider_succeeded`; side effects isolated. `fosResolveRefund` (super
admin + IntaSend evidence) is the only way out of `outcome_unknown` / `provider_succeeded` and
never calls the provider. payRef refunds take the seller from the intent, never the payer.
**Provider idempotency: none available** — exactly-once is enforced locally.

## 20. Rights-owner attestation (participant consent — DECISION_REQUIRED)

No business policy authorises making participant consent a blocking requirement, so it was not
added. Every split version instead stores a versioned rights-owner attestation
(`rights-attestation-v1`: text, uid, time) and `participantConsent: NOT_REQUIRED_BY_POLICY`;
saving without the attestation is refused. Versioning is unchanged (§6).

## 21. Creator verification

`creatorVerifications/{uid}` — one application per creator keyed by the authenticated uid.
States NOT_APPLIED · DRAFT · SUBMITTED · UNDER_REVIEW · MORE_INFORMATION_REQUIRED · APPROVED ·
REJECTED · SUSPENDED; creator and admin transitions are disjoint (no creator path into
APPROVED / UNDER_REVIEW). Identity = document type + **last 2–4 characters only**; documents in
the existing private `kyc-documents/{uid}/` storage, hashed at attach and at submit so a swap
after submission is flagged to the reviewer; 5-minute signed review links; events subcollection
records every transition with actor and reason (creators see reasons, not reviewers).
**Source of truth:** `creatorVerifications.status`. `creators.verification` is a projection written
only by `creatorAdminVerificationDecision` (approve → VERIFIED + ACTIVE; suspend → UNVERIFIED +
SUSPENDED). AdminOS › Creator Hub › Verification; Studio › "Apply for Creator Verification".

## 22. Viewer dashboard & creator analytics

`creator.html?view=library`: My Films, Continue Watching, purchase history (active / expired /
revoked), devices (8-char hashes) with sign-out, account settings and password reset — own
records only. Heartbeats carry position/duration; watch time credits only real elapsed time
(capped), completion counts once, unique viewers use a create-once marker. `creator.analytics`:
views, unique viewers, completed views, watch time, average watch, page views, purchases,
conversion (purchases per page view), gross, fees, SOKONI commission, pool, settlement status —
owner's films only, aggregates only. Hot counters are sharded (10) under `filmStats/{film}/shards`.

## 23. Pricing & Monetisation page

`subscriptions.html` (the canonical "SOKONI Monetisation & Pricing" page) gains a Creator
Pay-Per-View section rendered only from `sokoni-creator-commercial.js` (byte-identical to the
server authority): fee first, then 30 % / 70 %, participants from the pool, quarterly settlement,
not immediately withdrawable, refunds reverse. Its worked example is verified in Chromium to equal
the server split. (The page's older hand-written rate table disagrees with `commission-config` in
places — pre-existing, not changed here.)

## 24. Guest (anonymous) checkout — DECISION_REQUIRED

The rail binds an anonymous uid correctly and `linkWithCredential` keeps the same uid, so the
upgrade copies nothing. But nothing uses Anonymous Auth today, and enabling it lets anonymous
tokens satisfy **740** `isAuthed()` references in the served rules, **39** storage auth checks and
**74** function modules with auth-only guards. Built behind `config/creatorHub.guestCheckoutEnabled`
(default OFF, super admin): the pricer refuses anonymous buyers unless on (read from the auth
record), `creatorDispatch` limits anonymous tokens to catalogue / playback / library, and the page
offers "Create your SOKONI account" (link, then email verification) after the entitlement is ACTIVE.
Recovery if the guest clears the browser before linking: none automated (support only) — UNPROVEN.

## 25. Preview enforcement (2026-09-26)

`previewSeconds = N` now controls playback; storing it is no longer the whole feature.

- **Separate rendition.** The creator uploads a PREVIEW file (`creator-previews/{uid}/{filmId}/{uploadId}`,
  create-only, no client read — same posture as masters; `film.previewUploadTarget` / `film.attachPreview`
  verify the stored object). A non-entitled viewer's grant (`playback.preview`) signs ONLY that file; the
  master is signed only by `playback.authorize`, which requires an ACTIVE entitlement. No preview file → no
  preview (the master is never cut or used as a preview).
- **Server ledger.** `creatorPreviewGrants/{uid}_{filmId}` (server-only) holds seconds watched (monotonic,
  clamped to N), a 30-minute wall-clock window and a 6-grant cap, decided in the same transaction that
  signs. A reload resumes where the viewer was; it cannot restart the allowance.
- **Client guard.** `attachPreviewGuard` (shared `creator-publishing.js`, served as
  `sokoni-creator-rules.js`) stops the player at N, pulls a seek past N back, refuses play after N.
- `previewSeconds` outside 1–600 (0, negative, fractional, text, huge) → 0 → entitlement required.
- Entitled viewers get the full film with no preview limit; a revoked entitlement loses full playback and the
  running session ends on its next heartbeat. **Not DRM; not copy-proof** (screen recording is possible).
- Proof: `scripts/test-creator-preview.js` — server, simulated guard, and a real `<video>` in Chromium.

## 26. Dashboard figures, defined (`royalty.mine` → `figures`)

| Figure | Definition | Authority |
|---|---|---|
| Total earned | every royalty ledger EARN minus REVERSAL, all quarters ("—" if the read was truncated) | `royaltyLedger` |
| Pending | open quarter + quarters CALCULATED / APPROVED — not withdrawable | ledger × `royaltyPeriods` |
| Released | what closed quarters released to the wallet | `royaltyStatements` |
| Available for withdrawal | the wallet balance (may include other SOKONI earnings — labelled) | `wallets.balance` |
| Withdrawn | payouts `paid` / `settled_manually` only | `payoutRequests` |
| Pending withdrawal | payouts reserved and in flight | `payoutRequests` |
| Being confirmed | `outcome_unknown` payouts — neither withdrawn nor available | `payoutRequests` |

Failed, rejected and reversed payouts count as nothing.

## 27. Search

Creator films are not in the Algolia / Typesense indexes; Firestore (`entertainmentListings`, `creatorHub` +
`status == 'active'`) is their ONE search authority. `search.html` renders Algolia's answer, then folds in
Firestore's films via `mergeCreatorFilms` (films only, de-duplicated, skipped if the query changed). No second
index. Unpublished / suspended / deleted films cannot match (`scripts/test-creator-search.js`). Live Algolia
behaviour UNPROVEN (no deploy).

## 28. Governance, refunds, oversight (AdminOS)

- **Dual control.** Calculate → approve → distribute: approve refuses the calculator (existing); distribute
  now refuses the APPROVER. A Super Admin approver may override only with a written reason, recorded in
  `adminAudit` (`royalty_distribute_override`).
- **Refund review.** AdminOS › Creator Hub › Refunds lists `fosRefundQueue` cases (payment identity, amount,
  reason, state, provider outcome, OUTCOME_UNKNOWN, audit history, film flag from the server-minted intent).
  Approve / reject call `fosApproveRefund`; resolve calls `fosResolveRefund` (Super Admin + evidence). No second
  refund lifecycle. **Lineage note:** `reviewRefundCase` / `refundExecution` live on
  `slice/realtime-control-plane` (B9.32C), not on this branch — convergence happens at merge, not by porting.
- **Oversight.** AdminOS › Creator Hub › Oversight: creators by state, verification queue, published films,
  purchases, gross, provider fees, SOKONI 30 %, creator pool 70 %, refunds, released royalty, participant
  payouts (withdrawn / pending / outcome_unknown). Aggregates only; a capped read shows "—".
- **No self-review.** An admin cannot decide their own verification application or change their own creator
  account state.
- **Withdrawal forms.** `sokoni-payout-intent.js`: one idempotency key per (user, amount, destination),
  shared across tabs, reused on reload / retry, released only on a definitive answer. Wired into
  `provider-dashboard.html` (was `'po_'+Date.now()`) and `wallet.html`.
