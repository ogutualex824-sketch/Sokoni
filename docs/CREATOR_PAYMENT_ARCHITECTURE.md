# Creator Hub — payment architecture & AdminOS control plane

**Status:** branch `feat/creator-hub`, **NOT DEPLOYED**. Two standing acceptance criteria govern
every Creator Hub change (owner, 2026-09-26):

1. **Creator purchases offer every method the SOKONI IntaSend account actually supports** — not
   M-PESA only, and never a method merely because its name is in code.
2. **AdminOS is the only Creator Hub control plane** (`admin-os.html` · `sokoni-aos.js` /
   `sokoni-aos-creator.js` · `adminOsDispatch`). Super Admin is an authorization level inside
   AdminOS, enforced on the server. `admin.html` receives no Creator functionality.

Related: [[CREATOR_HUB]], [[PAYOUT_OUTCOME_UNKNOWN]], [[Payments]], [[AdminOS]].

## 1. The shape

```
Creator Hub (creator.html) ── createPaymentIntent(film_access)  →  paymentIntents/{ref}   (server price, KES)
     │                                                              the ONE payment identity
     ├── M-PESA STK           initiateSTKPush ─┐
     └── IntaSend hosted      initiateHostedCheckout ─┤  paymentAttempts/{ref}  (ONE reservation per ref,
         checkout (proven                              │   create()/transaction BEFORE any gateway call;
         methods only)                                 │   first rail to reserve owns the reference)
                                                       ▼
                                     payments/{ref} PENDING  →  webhookIntasend (api_ref = ref)
                                                       ▼
                                     payments/{ref} COMPLETE  →  creatorOnFilmPayment trigger
                                                       ├── contentEntitlements (once)
                                                       └── royalty accrual, creator_ppv_v1 30/70 of NET (once)
```

No Creator-specific rail exists: film purchases use the platform STK rail and the platform hosted
checkout, one reservation model (`pos-qr.js` P2 → `hosted-checkout.js` → now `initiateSTKPush`),
one webhook. Marketplace commission (5 %) is untouched; the Creator policy stays 30 % / 70 % of net.

## 2. STK single-flight (repaired)

**Defect (executed):** two concurrent `initiateSTKPush` calls → 2 gateway requests, same `api_ref`,
no reservation — `payments/{ref}` was written only after IntaSend answered. Present on base SOKONI.

**Fix:** `functions/shared/stk-single-flight.js` (pure decision + converge-wait) and a
`paymentAttempts/{ref}` transaction in `initiateSTKPush` before the gateway. The gateway call and
its classification now use the shared `shared/stk-gateway.js` (same module `pos-qr.js` uses).

| Existing state | New gateway attempt | Caller gets |
|---|---|---|
| no attempt | **1** | the checkout id |
| RESERVED / GATEWAY_REQUESTED (someone sending) | **0** | the winner's result (waits ≤ 12 s), else "in progress" |
| GATEWAY_ACCEPTED, payment PENDING < 10 min | **0** | the same checkout id |
| GATEWAY_ACCEPTED, payment PENDING > 10 min | **1**, by transactional reacquisition (attemptNo+1) | new checkout id |
| payment COMPLETE | **0** | `alreadyPaid` |
| payment FAILED / CANCELLED | **1** | new checkout id |
| GATEWAY_REJECTED (4xx) | **1** | new checkout id |
| OUTCOME_UNKNOWN, unreconciled | **0** | `unavailable` — "check your phone" |
| OUTCOME_UNKNOWN, provider said FAILED | **1** | new checkout id |
| OUTCOME_UNKNOWN, buyer cancelled | **0** | a buyer cancel is not provider evidence |
| unrecognised state | **0** | fail closed |
| hosted checkout owns the reference | **0** | one rail per reference |

OUTCOME_UNKNOWN = 5xx, timeout, unreadable body, or 2xx without a checkout id. The attempt is held
and `payments/{ref}` is written PENDING so IntaSend's callback (keyed on `api_ref = ref`) can still
settle it; COMPLETE ends it, FAILED releases it. The config check now runs before the reservation,
so a misconfigured function cannot strand one.

**Residual:** an attempt stuck in RESERVED / GATEWAY_REQUESTED (crash mid-call) is never re-sent
and has no admin action; the buyer starts a new purchase (new intent = new reference).

## 3. IntaSend method matrix

IntaSend exposes **no read-only "enabled methods" endpoint** (developers.intasend.com/llms.txt,
checked 2026-09-26). Capability is therefore recorded as **evidence** in `config/intasendCapability`
by a Super Admin in AdminOS (`creatorAdminPaymentCapability`, `shared/payment-capability.js`).
Only `LIVE_AND_PROVEN` entries with an evidence reference are offered, and only while the hosted
switch is on; `initiateHostedCheckout` refuses outright when nothing is proven, and refuses a named
method that is not proven.

Classification today (**nothing has been proven for the hosted checkout**):

| Method | Provider capability proven? | Creator UI | Backend | Payment identity | Webhook | Entitlement | Royalty | Refund |
|---|---|---|---|---|---|---|---|---|
| **M-PESA (STK)** | **LIVE AND PROVEN** for the platform STK rail (production STK payments); film_access on it **COMMITTED BUT UNPROVEN** (not deployed) | "Pay with M-PESA" | `initiateSTKPush` + single-flight | `paymentIntents/{ref}` | `webhookIntasend` | trigger, once (tested) | 30/70 of net, once (tested) | `fosResolveRefund` → IntaSend chargeback (**P0 fixed, executed**) |
| M-PESA (hosted page) | PROVIDER CAPABILITY UNKNOWN | only if proven | `initiateHostedCheckout` | same ref | same webhook (hosted-rail doc settled: executed) | same | same | same rail; provider behaviour for hosted invoices UNPROVEN |
| CARD-PAYMENT | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, **PRESENT BUT DISABLED** | same | same | same | same | card chargeback semantics **UNPROVEN** |
| GOOGLE-PAY | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |
| APPLE-PAY | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |
| PESALINK | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |
| BANK-ACH | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |
| COOP_B2B | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |
| BITCOIN | PROVIDER CAPABILITY UNKNOWN | only if proven | hosted, PRESENT BUT DISABLED | same | same | same | same | UNPROVEN |

Nothing in this table says "all IntaSend methods are supported" or "hosted checkout is live".

**Readiness (executed, no provider call):** each of the 8 known methods, and a brand-new identifier
(`MPESA-XB`), becomes offerable on the hosted checkout **by the capability record alone** — recorded
LIVE_AND_PROVEN with evidence → the catalog lists it and `initiateHostedCheckout` forwards it. No code
change: the known list is not a ceiling; a well-formed IntaSend identifier is accepted by the record, a
malformed one is refused, and a non-listed method is forwarded only once proven
(`scripts/test-creator-completion.js`).

**Read-only evidence (2026-09-26, owner-authorized option A — `GET /api/v1/invoices/?state=COMPLETE`):**
28 COMPLETE invoices, **all `M-PESA`**, latest `08QXNLZ` (2026-09-14). No other method was ever
observed. This is historical evidence for M-PESA on the existing collection rail only — it does not
prove hosted-page M-PESA, and absence does not make any other method UNSUPPORTED. Production
`config/intasendCapability` does not exist (its writer is not deployed). **HOSTED INTASEND METHODS:
UNPROVEN LIVE.**

### Contract corrections made from IntaSend's own reference (no provider call)

- **Method identifiers.** The enum is `M-PESA, PESALINK, CARD-PAYMENT, GOOGLE-PAY, APPLE-PAY,
  BITCOIN, BANK-ACH, COOP_B2B`. The committed list spelled `GOOGLE_PAY` / `APPLE_PAY` and omitted
  `PESALINK` — the capability probe would have reported those as REFUSED (400) when they were
  merely misspelled. Fixed: one list, owned by `payment-capability.js`.
- **Auth header.** The docs name `X-IntaSend-Public-API-Key`; the vendored SDK (intasend-node
  1.1.2) sends `INTASEND_PUBLIC_API_KEY`. Neither is field-verified; the request now sends both
  (public key only — never the secret), plus `public_key` in the body.
- **Not changed, out of scope:** `sokoni-pos-tender.js:329-333` (POS) uses the same wrong
  spellings and maps `COOP_B2B` to "PesaLink". Recorded for the POS owner.

### Provider action required to prove any hosted method — NOT TAKEN

| Option | Endpoint | Auth | Creates a real invoice? | Proves |
|---|---|---|---|---|
| **A (recommended first)** `scripts/probe-intasend-invoice-methods.js --i-authorize-a-read-only-provider-call` | `GET /api/v1/invoices/?state=COMPLETE` | secret key (Bearer) | **NO** — read-only | methods that have **taken real money** on the account (evidence `completed_invoice`). Absence proves nothing. |
| B `scripts/probe-intasend-capability.js --live --i-understand-this-creates-invoices` | `POST /api/v1/checkout/` per method (+1 open) | public key | **YES — up to 9 real, unpaid invoices** | the account **accepts** a session for that method today |

```
PROVIDER CALL REQUIRED: YES (to prove any hosted method)
REAL INVOICE CREATION:  NO for option A · YES for option B
```

Hosted checkout also needs the `INTASEND_PUBLIC_KEY` secret before it can run at all.

## 4. Hosted checkout audit (`functions/hosted-checkout.js`)

| Concern | Finding | Evidence |
|---|---|---|
| Public-key requirement | public-key flow; secret never sent; both header spellings | `test-hosted-checkout` |
| Server authentication | `req.auth` required; caller must own the intent | ✓ |
| Amount authority | the INTENT's amount/currency; client amount ignored | ✓ |
| Payment identity | the intent ref = `api_ref` = `payments/{ref}` = reservation id | ✓ |
| paymentAttempts | `create()` before the gateway; one rail per reference with STK (both directions + racing: 1 request) | `test-hosted-checkout`, `test-stk-single-flight` |
| Capability gate | refuses unless ≥ 1 method LIVE_AND_PROVEN with evidence; a named method must be proven | ✓ (new) |
| Callback / completion | hosted-rail `payments` doc settled by the real `webhookIntasend`; replay → one allocation | `test-creator-callback` (`filmHosted`) |
| Entitlement | granted only on COMPLETE; redirect / URL grants nothing | `test-creator-callback`, `test-creator-hub` |
| Royalty | 30/70 of net; exact participant split; replay → alreadyAccrued | `test-creator-callback` |
| Refund | same `payRef` → `fosResolveRefund` → chargeback; provider behaviour for card **UNPROVEN** | `test-refund-exactly-once` (rail-agnostic) |
| Duplicate / concurrent click | retry → same session; 2 concurrent → 1 request; 5xx/throw → OUTCOME_UNKNOWN held | ✓ |
| Unsupported method | UNSUPPORTED / unknown name refused before any request | ✓ (new) |
| **Webhook payload shape for hosted invoices** | **UNPROVEN** — the harness uses the STK callback shape | — |

## 5. AdminOS Creator control census (re-run 2026-09-26)

Every Creator control is in **AdminOS** (`admin-os.html` › Creator Hub, `sokoni-aos-creator.js`; payouts in
AdminOS › Financial › Payouts, `sokoni-aos.js`). Server authority is the handler's own check
(`AC.isAdmin` / `AC.isSuperAdmin`, `token.superAdmin === true`) — hiding a button is never the control.
Audit: `adminAudit` (creator-hub), `payoutResolutions` + `statusHistory` (wallet), `finosAudit` (refunds).

| Function | UI (AdminOS) | Server authority | Admin | Super Admin | Audit |
|---|---|---|---|---|---|
| Creator verification | Creator › Verification | `creatorAdminVerifications` · `…VerificationDetail` · `…VerificationDecision` | review + decide (never own application) | — | `adminAudit` + `creatorVerifications/{uid}/events` |
| Creator approval | Creator › Creators | `creatorAdminSetState` → ACTIVE | yes (never own account) | — | `adminAudit` |
| Creator suspension | Creator › Creators | `creatorAdminSetState` → SUSPENDED (reason required) | yes | — | `adminAudit` |
| Film moderation | Creator › Films & review | `creatorAdminFilms` · `…FilmDetail` · `…FilmTransition` | yes | — | `adminAudit` |
| Publishing approval | Creator › Films & review | `creatorAdminFilmTransition` (approve → publish) | yes | — | `adminAudit` |
| Royalty configuration | Creator › Films & review | `creatorAdminLockAgreement` | yes | — | `adminAudit` |
| Royalty settlement | Creator › Royalty settlement | `creatorAdminCalculatePeriod` → `…ApprovePeriod` (≠ calculator) → `…Distribute` (≠ approver) → `…ClosePeriod` · `…Statements` | yes, **three different admins** | override with written reason | `adminAudit` (+ `royalty_distribute_override`) |
| Payout review | Financial › Payouts | `adminProcessPayout` (wallet.js) | approve / reject / manual settle with attestation | — | `statusHistory` |
| Outcome-unknown payout | Financial › Payouts › Outcome unknown | `adminResolvePayoutOutcome` | read only | **resolve, with IntaSend evidence** | `payoutResolutions/{rid}` |
| Refund review | Creator › Refunds | `creatorAdminRefundCases` (read) · `fosApproveRefund` · `fosResolveRefund` | approve / reject | **resolve unknown outcome, with evidence** | `finosAudit` |
| Entitlement revocation | Creator › Playback security | `creatorAdminRevokeEntitlement` (reason required) | yes | — | `adminAudit` |
| Creator oversight | Creator › Oversight | `creatorAdminOverview` | read | — | read-only |
| Creator analytics | Creator › Oversight (aggregates) · creators see their own in Studio | `creatorAdminOverview` · `creator.analytics` | read | — | read-only |
| Payment-method capability | Creator › Config | `creatorAdminPaymentCapability` | read | **record, with evidence** | `adminAudit` |
| Commercial policy / config | Creator › Config | `creatorAdminConfig` (purchases, hosted, guest checkout); the 30/70 policy is code (`creator-commercial.js`) | read | **write** | `adminAudit` |

Executed (`scripts/test-creator-adminos-authority.js`): every `creatorAdmin*` op refuses an anonymous caller
and an ordinary user when invoked directly; Super-Admin writes refuse a plain admin; a forged `"true"` claim
is refused; the AdminOS op list equals the server handler set.

**Remaining Creator function outside AdminOS: NONE.**

## 6. Legacy admin pages

Scanned for Creator ops, collections and money controls (`admin.html`, `super-admin.html`,
`superadmin.html`; detector positive-controlled on `sokoni-aos-creator.js`: 39 hits):

- **No Creator-specific control** on any legacy page. The suite fails if one is added.
- `admin.html:5590-5609` — withdrawal **approve / reject** (`adminProcessPayout`). Platform payout
  rail, which Creator royalty withdrawals also use. **Mark for migration to AdminOS.** It cannot
  bypass the server: `adminProcessPayout` refuses approve/reject/mark-paid on
  `outcome_unknown`.
- `super-admin.html:1760-1815` — payout ops (`adminPayoutOps`, `adminProcessPayout`). Same rail,
  same server rules. **Mark for migration.**
- `super-admin.html` / `superadmin.html` exist as separate Super Admin applications, which
  contradicts "Super Admin is an AdminOS persona". Re-scanned 2026-09-26: they contain **no Creator
  functionality** — no verification, settlement, refund, royalty or outcome-unknown resolution; only the
  generic platform payout ops above. Nothing Creator-specific to migrate; **mark the apps for platform
  migration**, not touched here.
- `finos-admin.html:1007-1022` and `fos-admin.html:484-494` — legacy platform refund approval
  (`fosApproveRefund`), the same server authority AdminOS now uses; a Creator film refund reaches it too.
  Generic platform functionality — **mark for migration**, not deleted.
- Routing scan (all admin-style pages, terms: creator · film · royalty · verification · payout · refund ·
  settlement · analytics · content moderation): Creator-specific controls exist ONLY in `admin-os.html`
  (`sokoni-aos-creator.js`). `minishop-admin.html` "Promotion Creator" and `legal.html` "royalty-free
  licence" are unrelated wording.
