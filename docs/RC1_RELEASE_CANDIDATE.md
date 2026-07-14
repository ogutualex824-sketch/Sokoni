# SOKONI — Phase 0 Release Candidate 1 (RC1)

**Date:** 2026-07-14 · **Release ref (HEAD):** `011a766` · **Branch:** `main`
**Standard:** evidence-based. A workflow not exercised with real users, real data, or real hardware
is classified **Pending Physical/Operational Validation**, never "complete." (The missing-index
finding is why.)

> ## RECOMMENDATION: **READY FOR PHASE 0 PILOT (Release Candidate 1)**
> Engineering is release-quality and the coordinated hosting deploy is live-verified. **Do NOT
> promote to General Availability** until the four explicit conditions in §9 are satisfied (physical
> auth on iPhone Safari + PWA, KASS physical validation, one real Legal Hub advocate lifecycle,
> and the infrastructure dependencies). RC1 is now under **change freeze** — see §0.

---

## 0. RC1 change freeze

The codebase at `011a766` is Release Candidate 1. From now, a change may land **only** if it is a:
critical production defect · security vulnerability · data-integrity issue · financial-correctness
issue · deployment blocker · documented regression. Everything else → **v1.1 backlog**. No feature
work, no architectural refactoring.

---

## 1. Merge integrity report

| Check | Result | Evidence |
|---|---|---|
| No unmerged branches with production fixes | **PASS** | Only 7 `dependabot/*` dependency-bump branches (setup-node, google-github-actions, anthropic sdk 0.110/0.111, nodemailer 9.0.3, playwright 1.61.1) — routine maintenance, not product fixes → v1.1 backlog. Stale local `worktree-agent-a5d8200809766995f` is **0 commits ahead** of `main` (fully contained; safe to delete) |
| No real merge-conflict markers | **PASS** | `git grep '^<<<<<<<|^>>>>>>>'` = 0 (the ~68 `=======` hits are decorative comment banners) |
| No conflicting route definitions | **PASS** | `firebase.json` single hosting target (`public:"."`); `cleanUrls:true`; no duplicate rewrites |
| No duplicate implementations (commission) | **PASS** | one authoritative engine — `verify-commission-single-source.js` predeploy gate passed on the CF deploy |
| No partially-deployed features | **1 KNOWN non-blocking delta** | Hosting reflects content `76d21a7` (live-verified). Commit `011a766` (`security.js` — consent-banner FAB positioning, UI polish, **not** a blocker) is committed but not yet on hosting. Rides the final pre-pilot coordinated deploy. Not redeployed now to avoid churn against active parallel edits during freeze |
| No stale Service Worker assets | **PASS** | local == live `CACHE_VERSION = sokoni-20260714-pos-router-v74` |
| No missing Firestore indexes | **PASS** | 332 composite deployed incl. **7 legal** (the 4 previously-missing were fixed in `3362211`); no `FAILED_PRECONDITION` expected |
| No missing/incorrect rules | **PASS** | `firestore.rules` + `firestore.rules.sokoni-ops` compiled successfully on deploy; legal collections CF-only |
| No pending database migrations | **PASS** | no Firestore schema migration outstanding. `scripts/migrations/{algolia,typesense}-migrate.js` are **search-backend** provisioning tools (run when Algolia/Typesense secrets land — see §5), not schema migrations |
| Working tree | clean at time of audit | (parallel process commits intermittently; re-verify immediately before the final deploy) |

**Verdict:** merge integrity is clean. One non-blocking hosting delta (`security.js`) to sweep in
the final pre-pilot deploy.

---

## 2. Production inventory

Legend: **IMPL** implemented · **DEPL** deployed to prod · **VERIF** automated/static/emulator
verified · **PHYS** physically verified on real device · **OPS** operationally exercised with real
users/data · **DEP** blocked on an external dependency.

| Subsystem | IMPL | DEPL | VERIF | PHYS | OPS | Notes / gate |
|---|---|---|---|---|---|---|
| Marketplace (buyer app, cart, checkout) | ✅ | ✅ | ✅ | ❌ | ⏳ | pages 200; checkout CF path verified; live purchase = OPS pending |
| SmartPOS | ✅ | ✅ | ✅ | ❌ | ⏳ | `smartPosDispatch` live; POS UIs served; hardware/printer = PHYS pending |
| Wallet | ✅ | ✅ | ✅ | n/a | ⏳ | emulator: single debit/credit under concurrency; sellerId server-derived |
| Payments (M-Pesa/IntaSend) | ✅ | ✅ | ➖ | ❌ | ⏳ | IntaSend live key configured; **one live STK in pilot** = OPS gate |
| Escrow | ✅ | ✅ | ✅ | n/a | ⏳ | release charges nothing / fail-closed (forensic audit) |
| Seller Dashboard | ✅ | ✅ | ✅ | ❌ | ⏳ | routing fixes live (`95eb6fd`,`3d33f13`); real-seller flow = OPS |
| Buyer App | ✅ | ✅ | ✅ | ❌ | ⏳ | see Marketplace |
| KASS (AI concierge) | ✅ | ✅ | ✅ | ❌ | ⏳ | widget live (SW v74); **iPhone Safari + PWA = PHYS gate** (§4) |
| Legal Hub | ✅ | ✅ | ✅ | ❌ | ⏳ | P1 fixes live-verified; **real-advocate lifecycle = OPS gate** (§4) |
| Authentication (`auth.mysokoni.co.ke`) | ✅ | ✅ | ✅ | ❌ | ⏳ | domain+SSL+CSP verified; **iPhone Safari+PWA interactive = PHYS gate** (§4) |
| Notifications (email/in-app) | ✅ | ✅ | ➖ | ❌ | ⏳ | CFs present; push/SMS = **DEP** (FCM token flow / SMS secret) |
| Analytics | ✅ | ✅ | ➖ | ❌ | ⏳ | dashboards served; live-data accuracy = OPS |
| Reports | ✅ | ✅ | ➖ | ❌ | ⏳ | report CFs present; real-data = OPS |
| Printer Framework | ✅ | ✅ | ➖ | ❌ | ⏳ | integrated; **physical printer pairing = PHYS gate** |
| Cloud Functions | ✅ | ⚠️ | ✅ | n/a | ⏳ | core live (`smartPosDispatch` etc.); **a subset of newer CFs is DEP on Cloud Run CPU quota** (§5) |
| Firestore Rules | ✅ | ✅ | ✅ | n/a | ✅ | compiled + deployed both DBs; CF-only writes verified |
| Firestore Indexes | ✅ | ✅ | ✅ | n/a | ✅ | 332 composite incl. 7 legal; re-listed from deployed project |

**Reading:** every subsystem is Implemented + Deployed + automated-Verified. **None is Physically
Verified**, and Operational readiness is Pending for all user-facing flows until exercised with
real users/data in the pilot. Rules + Indexes are the only fully operationally-ready items.

---

## 3. Release evidence

| Artifact | Evidence |
|---|---|
| Hosting deploy | `firebase deploy --only hosting` → "Deploy complete!" (3488 files); `/legal-hub` live-verified on `mysokoni.co.ke` + `web.app` (markers 3, banner, retry); pages 200 |
| Cloud Functions | `smartPosDispatch(us-central1)` "Successful update operation"; commission single-source predeploy gate passed |
| Firestore Indexes | `firebase firestore:indexes` re-list = 7 legal composite incl. `status+rating` |
| Firestore Rules | compiled successfully (default + sokoni-ops) during deploy |
| Financial integrity | real-Firestore emulator 8/8 (one mutation per duplicate scenario) — `FINANCIAL_FORENSIC_AUDIT.md` |
| Auth domain | HTTP 200, `ssl_verify_result=0`, Google Trust Services cert, CSP `frame-src` incl. `auth.mysokoni.co.ke` |
| Service Worker | local == live `v74` |
| Booking idempotency | `legal-hub.js` deterministic `lc_<key>` + transaction; emulator attack 7/7 |

**No screenshots, demo data, or mock responses are used as production evidence.** Items lacking
production evidence are marked Pending (§4).

---

## 4. Remaining external gates — physical & operational (track separately from engineering)

| Gate | Type | Owner | Status |
|---|---|---|---|
| iPhone Safari — Google Sign-In (interactive, session, refresh, logout, re-login, `getRedirectResult`, no redirect loop, no ITP storage partition) | PHYS | QA/operator | **PENDING** |
| iPhone PWA (installed) — authentication (redirect flow) | PHYS | QA/operator | **PENDING** |
| KASS on iPhone Safari | PHYS | QA/operator | **PENDING** |
| KASS on iPhone PWA | PHYS | QA/operator | **PENDING** |
| VoiceOver (iOS) accessibility validation | PHYS | QA/operator | **PENDING** |
| TalkBack (Android) accessibility validation | PHYS | QA/operator | **PENDING** |
| Legal Hub full lifecycle with ≥1 **real advocate** (discovery→booking→confirm/fail/retry→dashboards→rating→notifications) | OPS | operator + QA | **PENDING** (no real advocate onboarded; not validated on demo data) |

These require evidence from physical devices or real operational data and **cannot** be closed from
the engineering environment.

---

## 5. Infrastructure dependencies (operational, not software defects)

| Dependency | Impact if unmet | Owner | Status |
|---|---|---|---|
| Cloud Run CPU quota increase | A subset of newer Cloud Functions cannot deploy until granted | Account owner / GCP | **PENDING** (`project_pending_functions_quota`) |
| Redis VPC connector | Redis-backed caching/rate-limit falls back (fallback-safe) | DevOps | **PENDING** |
| `SENDGRID_API_KEY` (production) | Transactional email delivery | Account owner | **PENDING** (placeholder) |
| eTIMS production credentials | KRA e-invoicing in production | Finance/ops | **PENDING** |

None is a code defect; each is an external provisioning task tracked for the pilot window.

---

## 6. Operational readiness — pilot package

### 6.1 Merchant onboarding guide (condensed)
1. Create merchant account; **confirm the `sellerId` custom claim / `posRole` is set** — wallet,
   CRM, and cross-tenant safety all key off `auth.token.sellerId`.
2. Verify the merchant sees **only their own** wallet/CRM data (cross-tenant guard is live).
3. Complete SmartPOS setup guide; pair printer (physical check).
4. Run one real low-value STK checkout end-to-end → confirm receipt + one commission-ledger entry.
5. Confirm sign-in on the merchant's **actual device** (ties to §4).
6. Share support channel (§6.8) + pilot feedback link.

### 6.2 Cashier quick-start
- Open shift → confirm float. Scan/search item → cart → checkout → tender (cash / M-Pesa STK).
- Wallet: top-up / deduct / refund require manager role; refunds show a Retry if registration fails.
- Offline: sales queue locally and sync on reconnect (verify the sync indicator clears).
- Close shift → EOD report/print.

### 6.3 Admin operations
- Admin OS: monitor payments, disputes, settlements, KPIs. Approve legal providers in `legal-admin`.
- Watch commission ledger 1:1 with paid orders; investigate any `sync_failed` bookings.

### 6.4 Incident response
1. Detect (monitoring §6.7 / merchant report). 2. Classify severity (Critical→Low, §8).
3. Contain (feature-off / kill-switch where available). 4. Communicate to affected merchants.
5. Fix-forward (RC1 freeze permits blocker fixes only) or **rollback** (§6.5). 6. Post-incident note.

### 6.5 Rollback plan
- **Hosting/SW:** Firebase console → Hosting → release history → Rollback (serves prior
  `CACHE_VERSION`; clients pick it up on next navigation).
- **Cloud Functions:** `git checkout <prev> -- functions/ && firebase deploy --only functions:<name>`.
  sellerId change is backward-compatible (prefer fix-forward).
- **Auth domain:** revert `authDomain` to `sokoni-aeb26.firebaseapp.com`, bump `CACHE_VERSION`,
  redeploy hosting (both domains already authorized).
- **Indexes:** additive-only — **never roll back by deleting** (unused indexes are harmless).
- **Rules:** `git checkout <prev> -- firestore.rules && firebase deploy --only firestore:rules`.

### 6.6 Backup verification
- Firestore **PITR** enabled (prior deployment record). Before pilot: confirm PITR window in console
  and perform one test export (`gcloud firestore export`) to a bucket; verify object count > 0.

### 6.7 Monitoring checklist (first 72h) — see `RELEASE_PACKAGE_PHASE0.md` §7 for the full list
Auth success rate (iOS redirect loops) · STK→callback→order-state 1:1 · no duplicate wallet/ledger
rows · CF error rate <1% · index state READY / no `FAILED_PRECONDITION` · Legal Hub real-provider
render + `sync_failed` rate · SW version == release · supplier balances (R-D).

### 6.8 Support escalation *(operator to populate real contacts — placeholders, not fabricated)*
L1 pilot support _TBD_ · L2 on-call engineer _TBD_ · L3 Firebase owner (founder,
ogutualex824@gmail.com) · Payments/IntaSend liaison _TBD_ · Security incident lead _TBD_.

---

## 7. Final risk register

| # | Risk | Sev | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| R-1 | Google Sign-In fails on iPhone Safari/PWA (ITP, redirect) | **High** | Login blocked for iOS users | config verified (same-site authDomain, popup/redirect logic); **§4 physical test** required; rollback authDomain | QA/operator | Open — gate |
| R-2 | KASS unusable on iPhone (Safari/PWA) | Medium | Degraded assist on iOS | §4 physical test; widget auth-gate fixed | QA/operator | Open — gate |
| R-3 | Legal Hub lifecycle unproven on real data | Medium | Booking/dashboard gaps surface only with real advocate | onboard ≥1 advocate + run §4 OPS lifecycle; indexes fixed | operator | Open — gate |
| R-4 | Subset of CFs undeployable (Cloud Run quota) | Medium | Some newer features offline | request quota increase | account owner | Open — DEP |
| R-5 | Email delivery down (no prod SendGrid key) | Medium | Transactional emails drop | set `SENDGRID_API_KEY`; SMTP fallback configured | account owner | Open — DEP |
| R-6 | Supplier double-debit via `approveAndPayInvoice` double-click | Low–Med | Real KES over-debit | backlog R1 (deterministic marker); disable-on-submit interim; monitor `procurementPayments` | eng | Backlog |
| R-7 | `security.js` consent-fix not yet on hosting | Low | Minor FAB-position glitch | sweep in final pre-pilot deploy | eng | Open — non-blocking |
| R-8 | Parallel-contributor commit lands mid-pilot-deploy | Low | Hosting drifts from HEAD | re-verify clean tree immediately before final deploy | eng | Managed |
| R-9 | Redis connector absent | Low | Cache/rate-limit fallback (safe) | provision VPC connector | DevOps | Open — DEP |
| R-10 | eTIMS prod credentials absent | Low | No live KRA e-invoicing | provision secrets | finance/ops | Open — DEP |

No **Critical** open risks. All High/Medium items are gated behind the §9 conditions or are external
dependencies.

---

## 8. Known limitations & technical debt (v1.1 backlog — do not fix during freeze)

Residual financial V2=10/V3=4 (all `onCall`, none Critical) · `approveAndPayInvoice` R1 ·
`subscription-os.js` racy claim · POS inventory defense-in-depth · Legal Hub L-3…L-6 ·
Daraja-integrated SmartPOS merchant commission (v1.1) · 216 pre-existing TODO/FIXME · one
production-neutralized dev banner (`legal-hub.html:5077`).

---

## 9. Phase 0 recommendation

**READY FOR PHASE 0 PILOT (Release Candidate 1).**

Explicit conditions before broader rollout / GA:
1. Complete physical authentication testing on **iPhone Safari** and **iPhone PWA**.
2. Complete **KASS physical validation** on iPhone (Safari + PWA).
3. Onboard **≥1 real Legal Hub advocate** and execute the **full consultation lifecycle**.
4. Complete infrastructure dependencies: **Cloud Run quota, Redis connector, SendGrid production
   key, eTIMS secrets** (§5).

**Do not promote to General Availability until all four are satisfied.** Maintain the evidence-based
standard that surfaced the missing indexes: any workflow not exercised with real users, real data,
or real hardware stays **Pending Physical/Operational Validation** — not complete.

---
*Companion documents: `RELEASE_PACKAGE_PHASE0.md` (rollback/monitoring/onboarding detail),
`LEGAL_HUB_V1_CERTIFICATION.md` §10 (Legal Hub phased validation), `FINANCIAL_FORENSIC_AUDIT.md`
(financial evidence), `RESIDUAL_FINANCIAL_FINDINGS.md` (V2/V3 register).*
