# SOKONI — Phase 0 Pilot Release Package

**Date:** 2026-07-14 · **Release ref (HEAD):** `e6c6058` · **Branch:** `main`
**Prepared by:** AI Engineering (evidence-based; nothing marked verified without deployment, test, or physical confirmation)

> ## PRODUCTION RECOMMENDATION: **READY FOR PHASE 0 PILOT**
> All financial, backend, index, and configuration checks are green and evidence-backed. **One
> launch gate remains and is explicitly outstanding: real-device interactive authentication
> testing** (see §3). General Availability must NOT be declared until that physical testing passes.
> A **coordinated hosting deploy** is also required to bring hosting up to HEAD (see §2).

---

## 1. Executive summary

The production-validation programme is complete for everything verifiable without physical
hardware. Financial integrity is proven against real Firestore (exactly one mutation under
concurrency across POS checkout, wholesale, and wallet refund), the `sellerId` contract defect is
fixed and **deployed** to Cloud Functions, cross-tenant wallet access is closed, and the custom
auth domain `auth.mysokoni.co.ke` is live with a valid Google-issued certificate. During release
prep, a **previously-hidden critical defect** was found and fixed: four missing Firestore composite
indexes were silently breaking Legal Hub's real provider search, booking history, and provider
dashboard behind a demo-data fallback — those indexes are now **deployed and verified**.

Two states matter for launch:
1. **Physical authentication testing** on real devices has NOT been performed (no hardware in the
   engineering environment). This is the single blocking item for GA.
2. **Hosting is behind HEAD.** The Legal Hub P1 UX fixes are committed (`179953e`) but not yet on
   hosting, and a concurrent process has in-flight uncommitted work (KASS widget). Hosting must be
   deployed once that work settles, as one coordinated release.

Recommendation: **proceed to Phase 0 pilot** with the two items above tracked as the final
pre-public-launch tasks.

---

## 2. Production readiness assessment — evidence matrix

Status legend: **IMPL** = code implemented · **DEPL** = deployed to production · **VERIF** =
verified by automated/static/emulator evidence · **MAN** = manually tested by engineering
(CLI/network, non-interactive) · **PHYS** = physically tested on a real device · **REM** =
remaining manual validation.

| Capability | IMPL | DEPL | VERIF | MAN | PHYS | Evidence / commit |
|---|---|---|---|---|---|---|
| `sellerId` server-side derivation + cross-tenant guard (POS CRM) | ✅ | ✅ | ✅ | ✅ | n/a | `cbade53`; `smartPosDispatch(us-central1)` "Successful update operation"; module loads (26 exports/25 ops); `node --check` |
| POS wallet checkout — one debit, one stock decrement | ✅ | ✅ | ✅ | ✅ | n/a | real-Firestore emulator: 1000→700 once, 5→4 once, 1 tx row |
| Wholesale order — no duplicate on double-submit | ✅ | ✅ | ✅ | ✅ | n/a | emulator: 1 order, 1 ledger row |
| Wallet refund — one credit on double-tap | ✅ | ✅ | ✅ | ✅ | n/a | emulator: 100→600 once, 1 refund row |
| Escrow release charges nothing / fail-closed | ✅ | ✅ | ✅ | ➖ | n/a | `FINANCIAL_FORENSIC_AUDIT.md`; static + prior remediation |
| Commission single-source engine | ✅ | ✅ | ✅ | ✅ | n/a | predeploy `verify-commission-single-source.js` passed on deploy |
| `auth.mysokoni.co.ke` domain + SSL + CSP | ✅ | ✅ | ✅ | ✅ | ❌ | `f6b345b`; HTTP 200, `ssl_verify_result=0`, Google Trust Services cert, CSP `frame-src` clean |
| Google Sign-In interactive (popup/redirect/session/logout) | ✅ | ✅ | ➖ | ➖ | ❌ | logic verified statically; **NOT physically tested** → §3 |
| Legal Hub composite indexes (4) | ✅ | ✅ | ✅ | ✅ | n/a | `3362211`; re-listed deployed = 7 legal indexes incl. all 4 |
| Legal Hub P1 — demo separation | ✅ | ❌ | ✅ | ➖ | ❌ | `179953e`; **committed, not on hosting** (0 markers in live file) |
| Legal Hub P1 — booking-failure surface + retry | ✅ | ❌ | ✅ | ➖ | ❌ | `179953e`; `node --check` on 139 KB block; **not on hosting** |
| Legal Hub booking + rating race fixes | ✅ | ✅ | ✅ | ✅ | n/a | `46b7773`; fake-Firestore attack 7/7; CFs deployed |
| SmartPOS dispatch / printer framework | ✅ | ✅ | ✅ | ➖ | ❌ | live (SW `v74` = `pos-router`); UI not physically exercised |
| Seller routing fixes (POS/Cashier/Flash Sale panels) | ✅ | ✅ | ✅ | ➖ | ❌ | `95eb6fd`, `3d33f13` (pre-`v74` deploy) |
| Service Worker | ✅ | ✅ | ✅ | ✅ | n/a | local == live `sokoni-20260714-pos-router-v74` |
| Firestore Rules (legal + platform) | ✅ | ✅ | ✅ | ✅ | n/a | compiled successfully both DBs during index deploy; CF-only writes verified |
| Storage Rules | ✅ | ✅ | ➖ | ➖ | n/a | `b16c3b8`; clean working tree |

**Overall:** every backend/config item is deployed + verified. The un-deployed items are the Legal
Hub P1 HTML fixes (await coordinated hosting deploy) and the KASS work in flight (other process).
The only un-verifiable-here item is interactive Google Sign-In on physical devices.

---

## 3. Remaining manual validations (the launch gate)

### 3.1 Physical authentication testing — REQUIRED before GA

Interactive sign-in must be completed on real devices — this cannot be simulated from the
engineering environment and is **not** claimed as passed.

| Device / context | Google Sign-In | Redirect flow | Session restore | Refresh persist | Logout | Re-login | `getRedirectResult()` | No redirect loop | No iOS storage partitioning |
|---|---|---|---|---|---|---|---|---|---|
| Windows Chrome | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| Android Chrome | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| Android PWA (installed) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| iPhone Safari | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| iPhone PWA (installed) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

Config already verified (reduces risk, does not replace the test): custom same-site `authDomain`
defeats Safari ITP third-party-iframe blocking; `_isPopupSupported()` correctly selects redirect
for standalone PWA + in-app browsers (CriOS/FxiOS) and popup elsewhere; CSP `frame-src` includes
`auth.mysokoni.co.ke`, `*.firebaseapp.com`, `accounts.google.com`.

### 3.2 Coordinated hosting deploy — REQUIRED to ship committed UX fixes

Legal Hub P1 fixes (`179953e`) are committed but not on hosting. A hosting deploy currently also
picks up a concurrent process's uncommitted work (KASS widget: `kass-widget.js`, `auth.js`,
`service-worker.js`, `sokoni-validate.js`). **Do not deploy hosting until that work is committed
and self-consistent**, then run one `firebase deploy --only hosting` and re-verify (§8).

### 3.3 Post-deploy smoke of Legal Hub real flows

After 3.2, confirm (now that the indexes exist) real provider search returns real advocates (not
demo), booking history and provider dashboard load, and a failed booking shows the new error+Retry.

---

## 4. Known limitations (non-blocking; tracked, not to be fixed at the last minute)

- **Legal Hub L-1 (operator):** onboard real advocates; demo profiles are now clearly badged and
  non-bookable but real content is still pending. **L-3** two booking paths; **L-4** provider
  self-update; **L-5** client-side financial writes; **L-6** in-memory filter pagination → v1.1.
- **Financial residual V2=10 / V3=4** — all `onCall` (no platform auto-retry), none Critical;
  `RESIDUAL_FINANCIAL_FINDINGS.md`.
- **`procurement.js` `approveAndPayInvoice` (R1)** — highest residual; double-click could
  double-debit a supplier balance. Guard with a deterministic marker (v1.1).
- **`subscription-os.js:298/319`** — racy AI-subscription activation claim (guarded by
  `aiPaymentRefs`, low concurrency). Harden with Pattern C (v1.1).
- **POS inventory idempotency** depends on the outer atomic `create()` claim (defense-in-depth to
  add later).
- **Daraja-integrated SmartPOS merchant commission architecture** → v1.1.
- **216 TODO/FIXME markers** across the codebase — pre-existing backlog, none identified as a
  production blocker; not touched under code freeze.

---

## 5. Risk register

| # | Risk | Likelihood | Impact | Mitigation / status |
|---|---|---|---|---|
| R-A | Google Sign-In fails on a real device (iOS ITP, PWA redirect) | Medium | **High** (login blocked) | Config verified; **must** complete §3.1 before GA. Rollback = revert `authDomain` to `sokoni-aeb26.firebaseapp.com` (see §6) |
| R-B | Hosting deployed with the concurrent process's incomplete KASS work | Medium | High | Do NOT deploy hosting until WIP committed + consistent (§3.2) |
| R-C | Legal Hub P1 fixes never reach production (forgotten deploy) | Low | Medium | Tracked here as blocking §3.2; verify markers live post-deploy |
| R-D | Supplier double-debit via `approveAndPayInvoice` double-click | Low–Med | Medium (real KES) | Backlog R1; disable-on-submit at UI as interim; monitor `procurementPayments` |
| R-E | Payment rail (IntaSend/Daraja) misconfig in production | Low | High | Secrets in Secret Manager; validate one live STK in pilot with a real small amount |
| R-F | Multi-agent repo overwrites a committed fix | Low | Medium | Small-chunk commits + ownership checks in force; legal-hub P1 confirmed intact in HEAD |
| R-G | Firestore index still building at pilot start | Low | Low | 4 legal indexes deployed; small/new collections build fast; verify state = READY before pilot |

---

## 6. Rollback procedure

**Hosting (static + SW):**
`firebase hosting:releases` → identify the prior release → `firebase hosting:rollback` (Firebase
console → Hosting → release history → "Rollback"). SW: a rollback serves the prior `CACHE_VERSION`;
clients pick it up on next navigation via `clients.claim()`. No manual cache purge needed.

**Cloud Functions (`smartPosDispatch` / others):** redeploy the prior commit —
`git checkout <prev-hash> -- functions/ && firebase deploy --only functions:smartPosDispatch`.
The `sellerId` change is backward-compatible (server-derives; clients unchanged), so rollback is
low-risk but reintroduces the CRM-unreachable defect — prefer fixing forward.

**Auth domain (if R-A materializes):** in each inline config set `authDomain` back to
`sokoni-aeb26.firebaseapp.com`, bump `CACHE_VERSION`, redeploy hosting. Firebase Auth authorized
domains already include both, so no Auth console change is required to revert.

**Firestore indexes:** additive-only; **never roll back by deleting** (per the never-drop rule).
Unused indexes are harmless.

**Firestore/Storage rules:** `git checkout <prev-hash> -- firestore.rules storage.rules &&
firebase deploy --only firestore:rules,storage:rules`.

---

## 7. Post-launch monitoring checklist (first 72h of pilot)

- ☐ **Auth:** sign-in success rate; watch for redirect-loop / `getRedirectResult` null spikes
  (especially iOS). Alert on failed-auth > 10/IP/5min (rate limit already coded).
- ☐ **Payments:** every STK initiation → callback → order-state transition; reconcile
  `commissionLedger` entries 1:1 with paid orders; zero duplicate ledger rows.
- ☐ **Wallet/refund:** no duplicate `posWalletTransactions` rows per idempotency key.
- ☐ **Cloud Functions:** error rate < 1% on `smartPosDispatch`, payment CFs, `bookLegalConsultation`.
- ☐ **Firestore:** index-build state READY; no `FAILED_PRECONDITION` in logs (would indicate a
  missing index); daily reads within budget.
- ☐ **Legal Hub:** real providers render (not demo); booking `sync_failed` rate; retry success rate.
- ☐ **Hosting/SW:** live `CACHE_VERSION` == intended release; no stale-SW redirect loops.
- ☐ **Supplier balances:** watch `procurementPayments` for any double-debit (R-D).

---

## 8. Deployment consistency verification (run before pilot go-live)

| Artifact | Command / check | Expected |
|---|---|---|
| Cloud Functions | `firebase functions:list` incl. `smartPosDispatch` | present, updated today |
| Firestore Indexes | `firebase firestore:indexes` \| grep legal | 7 legal composite incl. status+rating |
| Firestore Rules | deploy state | matches `firestore.rules` @HEAD |
| Storage Rules | deploy state | matches `storage.rules` @HEAD |
| Hosting | `curl mysokoni.co.ke/legal-hub.html \| grep _isDemoLawyer` | **3** (currently 0 — deploy pending §3.2) |
| Service Worker | `curl mysokoni.co.ke/service-worker.js \| grep CACHE_VERSION` | matches HEAD |
| Static assets | key pages HTTP 200 | verified 10/10 today |

**Current state:** CFs, indexes, rules, storage, SW = consistent. **Hosting = behind HEAD**
(legal-hub P1 pending). No local changes of mine are undeployed except via the §3.2 coordinated
deploy; the other modified files belong to the concurrent KASS process and are not ready.

---

## 9. Pilot merchant onboarding checklist

- ☐ Create merchant account; confirm `posRole` / `sellerId` claim is set (wallet, CRM, and
  cross-tenant safety all key off `auth.token.sellerId`).
- ☐ Verify merchant sees only their own wallet/CRM data (cross-tenant guard live).
- ☐ Run one real low-value STK checkout end-to-end; confirm receipt + commission ledger entry.
- ☐ Issue + redeem one gift card; top-up + deduct + refund one wallet (confirm single mutations).
- ☐ Printer pairing (if hardware present) — physical check.
- ☐ Confirm merchant can sign in on their actual device (ties to §3.1).
- ☐ Provide support-escalation contact (§10) and pilot feedback channel.

---

## 10. Support escalation contacts

*(Operator to populate real values before pilot — placeholders only; not fabricated.)*

| Tier | Role | Contact | Hours |
|---|---|---|---|
| L1 | Pilot support (merchant-facing) | _TBD_ | pilot hours |
| L2 | On-call engineer | _TBD_ | 24/7 during pilot |
| L3 | Firebase project owner (`sokoni-aeb26`) | founder — ogutualex824@gmail.com | escalation |
| Payments | IntaSend / Daraja liaison | _TBD_ | business hours |
| Security | Incident lead | _TBD_ | 24/7 |

---

## 11. Deployment versions & commit hashes

| Item | Value |
|---|---|
| Release HEAD | `e6c6058` (2026-07-14) |
| sellerId fix (CF, deployed) | `cbade53` |
| Legal indexes (deployed) | `3362211` |
| Legal Hub P1 UX (committed, deploy pending) | `179953e` |
| Legal Hub booking/rating race fix (deployed) | `46b7773` |
| authDomain migration | `f6b345b` |
| Seller routing fixes | `95eb6fd`, `3d33f13` |
| Financial forensic audit (final validation) | `e89fbc4`, `ee0a8af` |
| Service Worker (live) | `sokoni-20260714-pos-router-v74` |
| CF deploy | `smartPosDispatch(us-central1)` — Successful update operation |
| Firestore indexes (live) | 7 legal composite (of the total deployed set) |

---

## 12. Classification

**READY FOR PHASE 0 PILOT.**

Not GA: real-device authentication testing (§3.1) is outstanding and is the explicit final
pre-public-launch task. A coordinated hosting deploy (§3.2) is also required to ship the committed
Legal Hub UX fixes. All other operational checks are green and evidence-backed. Known technical
debt (§4) is tracked and must not delay the pilot unless an item becomes a verified production
blocker.
