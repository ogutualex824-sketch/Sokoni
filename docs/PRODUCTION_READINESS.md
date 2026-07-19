# SOKONI — Production Readiness

**Canonical production status. Supersedes ad-hoc status claims elsewhere.**

**Last updated:** 2026-07-19
**Assessment:** **NO-GO**
**Blocking reason:** No invited user has ever activated an account, and no real payment has ever completed. Both are operator actions.

Evidence classes used throughout: **VERIFIED** (read from code or measured against production) · **INFERRED** (reasoned, not observed) · **UNKNOWN** (not tested).

> **Standing rule — [[RELEASE_VALIDATION_STANDARD]].** Engineering Complete ≠ Production Proven.
> Nothing below is marked verified on the strength of a successful deploy command. A deploy
> proves upload, not behaviour.

---

## 1. Platform status

| Layer | Status | Evidence |
|---|---|---|
| Hosting | **LIVE** | `sokoni-aeb26`, apex `mysokoni.co.ke` → `199.36.158.100`. VERIFIED |
| Service Worker | **v86** | Root-identity read + write guards active. VERIFIED |
| Cloud Functions | **1,446 deployed** | `firebase functions:list`, 2026-07-19. VERIFIED |
| Firestore rules | **Deployed** | Money collections CF-only. VERIFIED |
| Authentication | Working | Google / Facebook / Phone / Email |
| Email pipeline | **Repaired, unproven** | SendGrid 202s; zero emails sent since the click-tracking fix. UNKNOWN in the wild |
| Payments | **NEVER EXERCISED** | **Zero payments have ever completed.** VERIFIED |
| Wallet credits | **NOT WIRED** | No payment path credits any wallet. VERIFIED by elimination |
| Receipts | Written on payment success | Never produced by a real payment. UNKNOWN |
| Notifications | Wired to payment success | Never fired. UNKNOWN |

### The deployment trap

**Being exported from `functions/index.js` is NOT deployment.** Seven whole clusters are exported and **zero deployed** (VERIFIED 2026-07-19):

| Cluster | Exported | Deployed |
|---|---|---|
| `org*` | 32 | 0 |
| `sfos*` (Financial OS) | 24 | 0 |
| `walletV2*` | 18 | 0 |
| `wf*` (workforce identity) | 18 | 0 |
| `kass*` (memory/knowledge) | 11 | 0 |
| `profile*` | 10 | 0 |
| `device*` (device trust) | 8 | 0 |

`profile.html` and `account-centre.html` are live and call functions that return `not-found`.

**`PENDING_FUNCTIONS.txt` is 92% wrong** — it lists 187 as quota-blocked; 172 of those are deployed. Do not plan from it. Always re-run `firebase functions:list`.

---

## 2. Completed audits

| Audit | Date | Outcome |
|---|---|---|
| Wallet / Financial Engine / Receipts | 2026-07-19 | 22 of 49 capabilities wired; unit collision found |
| Identity / Seller / Customer | 2026-07-19 | 7 of 38 wired; 5 seller defects root-caused |
| Mobility / AI / Enterprise / Security | 2026-07-19 | 4 HIGH security findings; deployment trap found |
| Client financial files | 2026-07-19 | Commission guard blind spot found |
| Fixed-position layout conflicts | 2026-07-19 | FAB `!important` cascade mapped |
| Media / storage cost | 2026-07-19 | 13.79 MB removable, measured |

---

## 3. Security findings

### Fixed and deployed

| ID | Finding | Fix |
|---|---|---|
| — | **`receipts` world-readable with customer PII.** `allow read: if true`; docs carry `customer.name`, `customer.phone`, guessable ids (`receiptId == paymentId ==` client-supplied ref, unvalidated). The "public verification endpoint" justifying it does not exist — `/receipt/` 404s. | CF-only read |
| H-1 | **GPS spoofing.** `gipLocations` create validated coordinate ranges but never bound `uid`, while update did. Any authed user could create a location doc for an arbitrary asset. | `uid` bound on create |
| H-4 | **Forgeable webhook signatures.** `wh.secret \|\| 'sk_placeholder'` — a constant published in source. A signature from a public constant is worse than none. | Fail closed |
| — | Click tracking rewrote Firebase auth links through an uncertificated domain, breaking every activation and leaking `oobCode` over http | Disabled; auth mail can never be tracked |

### Open

| ID | Finding | Severity | Owner |
|---|---|---|---|
| H-2 | **Fraud-report abuse.** Any authed user can raise anyone's `riskScore` by 20/call. No rate limit, no dedup, no self-bind. ~5 calls suppress a competitor. `sasos-fraud.js:297-342` | HIGH | Engineering |
| H-3 | **Driver GPS + PII readable by any signed-in user.** `rideDrivers` `allow read: if isAuthed()`. `deliveryLocations:1209` already has the viewers-scoped fix; never applied here. ODPC exposure | HIGH | **Product decision** — ride matching may depend on driver discovery |
| — | Merchant ID/KRA PIN collected into `localStorage` and synced to `userSync/{uid}/kv/` as plaintext PII, with a false "review within 24-48 hrs" promise and no admin surface consuming it. `seller.js:1564-1582` | HIGH | ODPC review |
| — | Enforced CSP allows `script-src 'unsafe-inline'`; the strict policy is Report-Only | MEDIUM | Engineering |
| — | Content moderation fails **open** (`media-engine.js:171`); API gateway rate limiting fails open (`api-gateway.js:183`) | MEDIUM | Engineering |
| — | App Check console enforcement **PENDING** (`GO_LIVE_CHECKLIST.md:56` FB-6). Code flags ≠ live enforcement | MEDIUM | Operator |

### Clean

**No committed secrets** anywhere, including full git history. Money collections (`payments`, `commissionLedger`, `ledger`, `sfos*`) are `allow write: if false`. Admin checks use custom claims, never client data. Storage has default-deny.

---

## 4. Financial findings

| Finding | Status |
|---|---|
| **Wallet unit collision.** `finos-utils.js` worked in cents and incremented `balance` by `amountCents`; `wallet.js:88` renders that field as whole KES. A KES 500 credit would display **KSh 50,000**, and the sufficiency check passed against it. | **FIXED 2026-07-19.** Audited live first: all 3 `wallets/` docs zero — no migration needed. Fixed while free |
| **No payment credits any wallet.** All five `payments/{id}` triggers plus `intasendWebhook` touch zero wallet docs | **OPEN** — by design until units were canonical; now unblocked |
| **Payment-success chain never fired.** `emailOnPaymentSuccess` was `onDocumentCreated` on a doc created `PENDING`, testing `'completed'` against a stored `'COMPLETE'` | **FIXED** — now fires on the transition, exactly-once via `finosIdempotency` |
| **Commission guard blind spot.** `verify-commission-single-source.js` passes while `driver.html`, `growth-dashboard.html`, `seller.js`, `admin.html` hardcode 12% / 8% / 5% against a canonical 3%. It detects duplicate *tables*, not inline arithmetic. Display figures only — no merchant mischarged | **OPEN** |
| **`reconcileLedger` cannot fail.** Sums `−x` and `+x` per entry and asserts zero — tautological. Ledger integrity is unverified | **OPEN** |
| **Payroll net pay wrong for every employee.** NHIF bands predate SHIF/SHA entirely; NSSF limits are Year-2. `approvePayrollRun` is a status flip — bank details never decrypted | **OPEN** |
| **Financial trust boundary: 58 of 105 monetary fields are CLIENT AUTHORITATIVE (55%).** Three root patterns, not 105 bugs. Full matrix: [[FINANCIAL_TRUST_ENGINE]] | **OPEN — systemic.** Remediation is code-and-rules with no data to unwind, true only until the first payment |
| **eTIMS client-triggered filing.** Client can create an order with `status:completed`; the deployed trigger files to live KRA using a client-supplied `sellerUid`. **Gate holds:** `etims.js:778` requires an active `etimsProfiles` doc, and production has **0** (runtime-verified 2026-07-19) | **LATENT** — arms on first eTIMS onboarding |
| **Rider earnings are client-supplied.** `navigation.js:563` reads `earnings` from `request.data` and credits it to the wallet with no server-side validation. A rider can claim any amount. Design: [[RIDER_EARNINGS_AUTHORITY]] | **OPEN — HIGH.** Gates the IntaSend repoint |
| **Riders are never paid.** `navSubmitPOD` omits `amount`; `processDriverEarning` drops it behind `.catch(() => {})`. `rider-nav.html:485` uses the broken path; `navCompleteTrip` is correct | **OPEN** — one call site |
| Four parallel payout stacks; four ledger collections never cross-reconciled; three escrow collections | **OPEN** — architectural debt |

---

## 5. Operator blockers

These cannot be resolved from the repository.

| # | Blocker | Impact |
|---|---|---|
| **1** | **IntaSend production webhook points at `/webhookIntasend`** — which ACKs 200 *before* verifying and writes one log row. The real processor is **`/intasendWebhook`** (HMAC + transactional claim + commission ledger) | **No payment can reach `COMPLETE`.** Every downstream chain — receipt, email, notification, commission, wallet — is unreachable. **The single highest-value action available to the platform** |
| **2** | **No merchant has activated.** The activation blocker is fixed and deployed; needs one new invitation sent and clicked | Onboarding unproven end-to-end |
| **3** | **No seller test credentials.** Five reported seller defects were root-caused from source but never verified at runtime | Authenticated certification impossible |
| **4** | **Router DNS resolves the apex to a decommissioned cPanel origin** (`217.20.124.84`, LiteSpeed) that 404s every path and is still renewing a certificate for `mysokoni.co.ke` | Intermittent 404s for anyone behind that resolver |
| **5** | **SPF decision.** `46.165.235.143` is authorised in the live SPF record. Removing it as a "legacy IP" would break outbound mail | Blocks legacy cleanup |
| **6** | App Check console enforcement pending | Security posture unproven |

---

## 6. Known risks

- **`ETIMS_ENV=production`** in `functions/.env` — any eTIMS wiring hits **live KRA**. Sandbox first.
- **POS sales are never fiscalized.** The eTIMS client is production-grade but triggers only on marketplace `orders`.
- **Demo data before pilot** — `mechanics.html:435` `DEMO_MECHS`, `sokoni-carhub-pro.js:152`. Same pattern as the DEMO_LAWYERS blocker: fake verified providers are a trust and legal exposure.
- **Seller discounts cannot reach buyers.** Flash sales and promo codes sync to `userSync/{uid}` which `firestore.rules:479` scopes to that user alone. A data-model contradiction, not a wiring gap — every seller discount feature is inert by construction.
- **Redis layer is effectively dead** — one consumer; VPC connector still absent.
- **`seller.html` is 410 KB with three navigation routers.** High regression surface.

---

## 7. Go / No-Go

**NO-GO.**

Two conditions set by the Product Owner remain unmet, and neither is engineering-blocked:

1. A real invited user has successfully activated an account. **Not done.**
2. At least one real production payment has completed end-to-end. **Not done — and structurally impossible until operator blocker #1 is cleared.**

Everything downstream of payment — receipt generation, customer and merchant email, notifications, commission, wallet credit, settlement, analytics — is **built and idempotent but has never executed against real money.** It is verified by construction and simulation, not by production evidence.

---

## 8. Next engineering priorities

Ordered by irreversibility, not by value.

| # | Item | Effort | Why this order |
|---|---|---|---|
| 1 | **H-2 fraud-report abuse** — durable rate limit + review queue instead of direct score writes | M | Actively exploitable today |
| 2 | **H-3 driver privacy** — needs the discovery-model decision first | S after decision | ODPC exposure |
| 3 | **Rider pay** — add `amount` at `navigation.js:395` | **S** | Riders are unpaid right now |
| 4 | **Payroll SHIF/NSSF rates** (calculation only, not disbursement) | S | Net pay wrong for every employee |
| 5 | **Credit wallets on payment success** | M | Now safe — units canonical |
| 6 | **Commission guard blind spot** — teach it to detect inline arithmetic, then fix the call sites | M | A guard that passes falsely is worse than none |
| 7 | **Deployment reconciliation** — classify the 150 undeployed as ACTIVE / OBSOLETE / QUOTA-BLOCKED / UNREFERENCED | M | Deploy one at a time; quota ceiling is real |
| 8 | **Seller defects** — `_sdmLock` (`seller.html:4983`), `auth.js:50` guard, analytics role check, KRA grid | S each | Needs credentials to verify safely |

---

## 9. Regression suites

| Suite | Checks | Guards |
|---|---|---|
| `scripts/test-root-identity.js` | 21 | The homepage can only be read or written as the homepage |
| `scripts/test-seller-dashboard.js` | 22 | Every dashboard tile resolves at every viewport |
| `scripts/verify-commission-single-source.js` | — | One commission table — **but blind to inline arithmetic** |

Both new suites were proven to catch their regressions by injecting the defect and confirming failure.

---

## Related

[[RECEIPT_ENGINE]] · [[CANONICAL_ONBOARDING_SCHEMA]] · [[PRINT_COMPATIBILITY_MATRIX]] · [[PLATFORM_CONSTITUTION]] · [[RELEASE_VALIDATION_STANDARD]]
