# SOKONI v1.0.0 — Release Dashboard

**Release Manager:** AI (evidence tracking) · **Last updated:** 2026-07-12 · **HEAD:** `c1d6b0b`

# 🔴 GO / NO-GO: **NO-GO**

**Unchanged.** GO status is **never** updated automatically — only when documented evidence satisfies the acceptance criteria for **every** Critical blocker.

**4 Critical blockers open. All 4 require an operator.** Engineering validation is complete; **no further code work is planned** unless a verified failure is found.

---

## Blocker board

| ID | Blocker | Owner | Status | Evidence | Risk | ETA | Dependencies | Updated |
|---|---|---|---|---|---|---|---|---|
| **CB-01** | Cloud Run / Deployment | Engineering | ✅ **CLOSED** | 1,410 deployed == 1,410 runtime-exported · orphans 0 · undeployed 0 · CI gate exit 0 · all trigger types accounted (982 callable / 158 scheduled / 231 triggers / 37 https / 2 storage) | — | Done | — | 2026-07-12 |
| **CB-02** | **Money Path** | **Operator** | 🔴 **PENDING OPERATOR VALIDATION** | **NONE — never executed** | **SEVERE.** 6 Critical money defects (P0-1…P0-6) found by static audit; 3 would have silently corrupted real money. Runtime correctness is **unproven** | **3–4 h** | Handset (M-PESA PIN) · test merchant · admin login · KES ~10 float | 2026-07-12 |
| **CB-03** | **Email Delivery** | **Operator** | 🔴 **PENDING OPERATOR VALIDATION** | API key valid (`SG.…`, real, in Secret Manager). **Delivery: NONE** | **HIGH.** If delivery fails, password-reset + verification break ⇒ users locked out | **2 h** | Gmail / Outlook / Apple / Yahoo test inboxes · SendGrid Activity access | 2026-07-12 |
| **CB-04** | **Redis** | Platform/SRE | 🟠 **PLAN READY — not implemented** | Evidence: `REDIS_URL` = private RFC1918 (VPC-only) · only 2 of 8 modules carry `vpcConnector` · `redis-service` latches `_fallback` **with no log** | **MEDIUM — cost + observability, NOT correctness.** Rate limiting falls back to Firestore (security intact); no deployed queue worker | **1 h** (fallback alerting) | Cloud Monitoring access | 2026-07-12 |
| **CB-05** | **Monitoring** | **Operator** | 🔴 **PENDING OPERATOR VALIDATION** | **NONE.** `gcloud` non-functional here (no Python); ADC stale (`invalid_client`) — Cloud Monitoring unreachable from dev | **HIGH.** An unfired alert is not an alert. A production incident could be invisible | **2 h** | Cloud Console access · verified notification channel | 2026-07-12 |

---

## Evidence required to close each blocker

| Blocker | Closes when |
|---|---|
| **CB-02** | Real **payment · refund · payout · settlement · dispute · subscription** each executed at minimum value, with **transaction IDs, Firestore docs, wallet + settlement entries, Cloud logs, notifications, screenshots**. Plus **N1–N12** negative tests — each asserting **exactly one ledger record, exactly one financial movement**. Runbook: `MONEY_PATH_VERIFICATION.md` |
| **CB-03** | **Inbox evidence** (screenshots) for: verification · password reset · receipt · merchant notification · provider notification — across Gmail/Outlook/Apple/Yahoo, with **SPF/DKIM/DMARC passing** in headers |
| **CB-04** | Fallback latch **logs + alerts** (no silent fallback) · queue confirmed unused · cache hit-rate **before/after** from real traffic · connector attached **only** where measured. Plan: `CB04_REDIS_REMEDIATION.md` |
| **CB-05** | A **real alert fired and the notification received** (screenshot) · **restore drill completed with RTO/RPO recorded**. Checklist: `CB05_MONITORING_CHECKLIST.md` |

---

## Closed / verified (do not re-litigate)

| Area | Evidence |
|---|---|
| Deployment Integrity | 1,410 == 1,410 · CI gate |
| Architecture | 0 duplicate exports · 13 dispatchers |
| Authentication | Browser E2E on live project · **zero 403s** · prod attests via reCAPTCHA v3 |
| Legal Compliance | **29/29** · universal gate in every flow · immutable audit |
| Financial Code Audit | **P0-1…P0-6 fixed** · V1 = 0 · both at-least-once trigger classes clean · **25/25** idempotency tests · CI ratchet verified both ways |
| Security Rules | Reviewed **4/5** · `SEC-F1` fixed (ledgers not client-writable) |

**Open non-Critical (tracked, not blocking):** `SEC-F2` chat-attachment read leak (HIGH) · 16 residual financial findings (none Critical) · subscription write split-brain (H2) · Capacity Watch (1,410 / ~1,500).

---

## Not verified — deliberately unscored

**Responsiveness · Accessibility (WCAG AA) · PWA · Search · Performance · Backup-restore · Market activation.**

These were **not tested**, therefore they carry **no score**. A fabricated score is worse than a missing one.

---

## Critical path to GO

```
CB-02 Money Path      ████████░░  3–4 h   ← the one that matters
CB-03 Email Delivery  ████░░░░░░  2 h
CB-05 Monitoring      ████░░░░░░  2 h     (independent — can run in parallel)
CB-04 Redis           ██░░░░░░░░  1 h     (fallback alerting only)
                                  ─────
                        ~8–10 h of operator work
```

**CB-02, CB-03 and CB-05 are independent** and can be executed in parallel by different operators.

---

## Release Manager rules of engagement

1. **GO/NO-GO does not move automatically.** It moves only on documented evidence meeting the acceptance criteria.
2. **After a verified item, recalculate only that section.** Unrelated scores are not touched.
3. **No new engineering work** unless a verified failure is discovered.
4. **Never fabricate evidence. Never assume success.** Absence of evidence is not evidence of correctness.

---

## Status summary

**The codebase is ready. The system has not been proven.**

Engineering has done what engineering can do: six Critical money defects found and fixed, deployment integrity provably exact, auth and legal verified, permanent CI gates in place. **What remains cannot be done by reading code** — it requires a phone, an inbox, and a live alert.

Related: [[RELEASE_v1.0.0_FINAL]] · [[MONEY_PATH_VERIFICATION]] · [[CB04_REDIS_REMEDIATION]] · [[CB05_MONITORING_CHECKLIST]] · [[INFRASTRUCTURE_REPORT]]
