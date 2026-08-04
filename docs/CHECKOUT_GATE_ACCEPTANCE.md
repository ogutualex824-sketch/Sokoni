# Checkout Production Gate — Go/No-Go Acceptance Record

**Purpose:** the canonical baseline for the authoritative-checkout + payment path. Complete this the moment the production gate closes (one real end-to-end order). Every future release that touches checkout, delivery pricing, dispatch, settlement, or payments is measured against THIS record.

**Status:** ☐ NOT YET COMPLETED — fill in when the production reference transaction passes. RC is NOT exited; `v1.0.0` NOT tagged.

### Gate execution log
- **2026-08-04 — Step 1 DONE:** `darajaSTKPush` deployed to production (`us-central1`, Gen2 callable) from commit `fdb4a8f` — "Successful update operation". Authoritative delivery-pricing path now live; behaviourally inert until a merchant has a `deliveryConfig`. Exact Cloud Run revision not captured from this environment (gcloud unauthed) — **record it from the console** for the fast-rollback row. Rollback available now: tag `gate-authoritative-delivery` + revert `e02ac98` + redeploy.
- **2026-08-04 — Step 2 DONE:** Kass Shop `deliveryConfig` applied to **`sellers/xrH21J5GFbW8PluCZ2ny5nIuf602`** ("KASS SHOP", `businesses/SOK-GL58F7`, `ownerId`=same UID) — distance mode, baseFee 100, perKm 20, freeAbove 3000, enabled; read back to confirm. NOTE: the initially-supplied `BIZ-14FBA564CF7A8617` did not exist in `businesses/`; the correct seller was resolved by name match ("KASS SHOP", active) and its Firebase-UID `sellers` doc (what checkout reads). Config-read-at-checkout is confirmed live in Step 3 (the real order).
- **Step 3 — PENDING (human-only):** one real order (M-Pesa PIN + rider accept/pickup/deliver) → verify the table below → sign. **This is the only remaining RC-exit action; it cannot be automated.**
- **2026-08-04 — RIDER PROVISIONING PROVEN DISPATCHABLE (via real production flow).** Onboarded the owner test rider (`alexochieng3030` / uid `D5Ql2…`, motorbike KMGQ 748T) end-to-end through the REAL UI: apply in `driver.html` (photo-exempt owner account) → admin approve → deployed `projectDriver` created `rideDrivers`+`drivers`+`driverVerification` → go online. Verified read-only: `rideDrivers.status=active`, `isOnline=true`, in the dispatch candidate set (`rideDrivers where isOnline==true` = 1). This closes the last technical uncertainty before the live order. **Three real bugs found + fixed en route** (all committed/deployed): duplicate driver applications (re-entrancy lock), a reject-of-duplicate downgrading an active rider (recovered by re-approval; server guard → R1.1), and go-online writing a script-scoped `isOnline` that never reached `rideDrivers.isOnline` (base-handler direct write). `driverVerification.documentsMissing` = ID/DL/vehicleType (expected — owner photo-exemption + the `vehicleType→'moto'` collapse gap, both R1.1).
- **2026-08-04 — GATE HOSTING DEPLOY DONE:** deployed to production hosting from clean tree at commit `a6cb72b` (SW bump committed after as `6105567`). Bundle = nav correctness fixes + minishop button + temporary rider photo-exception. All predeploy guards passed (guard-no-rollback, cooldown, SW bump, version.json, syntax gate, perf-guard, base64, inventory). **Verified live:** `mysokoni.co.ke/version.json` → commit `a6cb72b`; `mysokoni.co.ke/driver` serves `_photoExempt` (exception live). Enables browser-based rider provisioning (photo-exempt for the owner test account) ahead of the live order.
- **2026-08-04 — PRE-GATE FINDING (delivery/dispatch readiness, read-only trace):** the paid→delivery→dispatch chain is **NOT automatic (Case B).** (1) **No `deliveries` job doc is created** by payment — neither `verifyIntasendPayment` (`index.js:2457`) nor `darajaSTKCallback` (`index.js:3559`) writes `deliveries`/`packageRequests`; the order simply reaches `status:"paid"`. (2) **Dispatch is not triggered by payment.** The only automatic rider logic, `_autoAssignRider` (`index.js:2931`), fires **only** on the order transition to `"confirmed"`, which requires a **manual seller "Accept"** (`seller-fulfilment.html:405` → `orderAdvance`/`notify.js:680` paid→confirmed → `onOrderStatusChange` `index.js:2877`). It patches rider fields onto the **order doc** (`assignedDriverUid`, `status:"rider_assigned"`), it does **not** create a `deliveries` job. The canonical cascade dispatcher `dispatchDelivery` (`dispatch.js:84`) operates on `packageRequests`, is **manual-only** (`dispatch.html:412`), and checkout never creates a `packageRequests` doc — two disconnected dispatch subsystems. (3) With `rideDrivers` empty, `_autoAssignRider` **silently early-returns** (`index.js:2949`) — order stays `"confirmed"`, unassigned, no error/flag. (4) Rider provisioning IS canonical: `projectDriver` (`application-lifecycle.js:458`) creates `rideDrivers`+`drivers` on driver-application **approval** (offline); go-online `driver.html:2612` then sets `isOnline:true` — but it uses `.update()` with an empty `.catch(){}`, so **go-online silently no-ops if the rider was never approved**. **Gate implication:** the rider step CANNOT close by payment alone. Achievable within RC via the ORDER-BASED path IF the gate accepts order-doc assignment as "dispatch": provision a rider through the real app→approval→online flow **and** the seller manually Accepts the paid order. A canonical `deliveries` pipeline + automatic paid→dispatch is **post-RC architecture** (do NOT build during RC; do NOT hand-write `rideDrivers`). Owner to decide the gate's "dispatch" definition before the live order.
- **2026-08-04 — Rider provisioning chain VERIFIED FUNCTIONAL (never exercised).** Code trace (7 checks) confirms app→approval→projectDriver→go-online works end-to-end: `driver.html` submit → `SokoniDB.saveApplication` injects the signed-in `uid` (`sokoni-db.js:84`) → `applications/{id}` → `resolveRole` maps `type:'driver'/hub:'delivery'`→`driver` (`application-lifecycle.js:189`) → admin **`applicationDecide`** (deployed, admin UI wired: `admin.html:3543`, `super-admin.html:1322`) runs `projectDriver` → creates `rideDrivers/{uid}` (`status:'active', isOnline:false`) + `drivers/{uid}` + grants role → `driver.html` go-online sets `isOnline:true` → dispatchable. **Prod data:** 0 driver applications ever; `applications`=5 (3 pending/2 approved non-driver — general machinery proven); `drivers`/`rideDrivers`/`driverVerification` all EMPTY. Non-breaking gaps: (i) `vehicleType` always collapses to `'moto'` — `buildIntakePatch` never maps the wizard `vehicle`/`category` (harmless for KMGQ748T, a real motorbike; wrong for car/van riders — post-RC fix); (ii) role-vocab split `'rider'`(approval) vs `'driver'`(go-online), benign (readers check both). **Precondition:** applicant must be authenticated at submit (else `blocked_no_uid`). **Conclusion:** to close the gate's rider step, run the REAL flow for the rider account (sign in → apply → admin approve → go online), then place the order and have the seller Accept it. No hand-writing needed.
**Related:** `docs/PRODUCTION_CHECKOUT_VALIDATION.md` (evidence + §5 human checklist), [[project_delivery_pricing_authority]], [[project_release_validation_standard]], [[project_dispatch_system]].

---

## Acceptance table

| Item | Evidence | Result |
|---|---|---|
| **darajaSTKPush revision** | Cloud Functions/Run revision ID: `__________` | ☐ |
| **Delivery config version** | Merchant UID: `__________` · config hash/values: `__________` | ☐ |
| **Reference transaction** | Order ID: `__________` | ☐ |
| **Payment (charged once)** | M-Pesa receipt: `__________` · gateway ref (IntaSend/Daraja): `__________` | ☐ |
| **Order created once** | single `orders/{orderId}` (no duplicate) | ☐ |
| **Delivery fee authoritative** | server-computed; `pricingSource=server_recomputed`; no `delivery_fee_unverified` for this merchant | ☐ |
| **Dispatch** | assigned rider UID: `__________` → accept → pickup → complete | ☐ |
| **Settlement (once)** | Settlement ID `settlements/{orderId}`: `__________` | ☐ |
| **Merchant net** | credited exactly the net (KES): `__________` | ☐ |
| **Commission (once)** | recorded once (KES/cents): `__________` | ☐ |
| **Wallet reconciliation** | seller `wallets/{uid}.balance` Δ == net; balanced `ledger/{orderId}_*` | ☐ Pass |
| **Reports** | Admin OS → Payments/Reports/Bookings reflect the txn | ☐ Pass |
| **Rollback tag** | `gate-authoritative-delivery` → `cb802d5` (revert commit `e02ac98`) | ☐ |
| **Date/time** | UTC: `__________` · EAT: `__________` | ☐ |
| **Approved by** | Owner: `__________` (signature/initials) | ☐ Go / ☐ No-Go |

---

## RC exit criteria (all must be true to lift the freeze)
☐ `darajaSTKPush` deployed · ☐ Kass Shop `deliveryConfig` applied · ☐ one complete live customer order · ☐ acceptance checklist fully passed (table above) · ☐ this record signed · ☐ Release Baseline established (below).

## Exception process (critical issue found during the live run)
1. **Record** the issue here (Lessons section). 2. **Decide: Go / Rollback / Fix & Restart RC.** 3. If a code change is required, **increment the RC** (RC1 → RC2). 4. **Re-run** the required validation (`qa-dispatch-settlement-e2e` + any harness for the touched area) and **repeat** this acceptance process. This preserves the signed-baseline integrity while allowing a response to real production findings.

## Verification method
- **Financial exactly-once** was proven pre-gate empirically (14/14, `qa-dispatch-settlement-e2e` against the real `settleOrder`). This record confirms the SAME properties hold on the live reference transaction, not just the emulator.
- **No-Go** if any row fails → follow the rollback procedure in `docs/PRODUCTION_CHECKOUT_VALIDATION.md §4b` (revision rebind / git-revert `e02ac98` / restore config), then re-run.

## Lessons / Regression Notes
_Capture anything observed during the live production run — this makes the record a living operational reference, not just an approval. Note it even if the gate passed._

- **Latency:** STK prompt arrival: `____` · webhook→paid: `____` · settle→wallet: `____`
- **Delivery timing:** dispatch→accept: `____` · pickup→complete: `____`
- **Payment timing / retries:** `____`
- **Operator observations:** `____`
- **UI friction (customer / rider / merchant):** `____`
- **Anything worth remembering for future releases:** `____`

## Release Baseline (record on Go — this is the certified lineage anchor)
On a signed **Go**, this becomes the platform **Release Baseline**. Capture:

| Baseline field | Value |
|---|---|
| Release Candidate version (SW `cacheVersion`) | `__________` |
| Production function revision(s) — `darajaSTKPush` (+ others changed) | `__________` |
| Service Worker version | `__________` |
| Acceptance date/time (UTC + EAT) | `__________` |
| Reference transaction (Order ID) | `__________` |
| Acceptance document version (this file's commit SHA) | `__________` |

**Change-record rule:** every future payment/checkout change MUST reference this baseline in its change record — creating a clear lineage from the certified release to each subsequent update — and MUST re-run `qa-dispatch-settlement-e2e` + re-verify the acceptance rows before deploy.

## Post-record
Then the roadmap proceeds — Merchant Growth (first-successful-sale as the primary activation milestone) → Multi-wallet → eTIMS (when the KRA spec lands).
