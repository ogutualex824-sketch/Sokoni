# CB-05 — Monitoring Validation Checklist

**Owner:** Operator / SRE · **Status:** PENDING OPERATOR VALIDATION · **Last updated:** 2026-07-12

> **Why an operator must do this:** `gcloud` is non-functional in the dev environment (missing Python runtime) and Application Default Credentials are stale (`invalid_client`). **Cloud Monitoring cannot be reached or configured from here.** Every item below requires the Cloud Console or a working `gcloud`.
>
> **An alert that has never fired is not a working alert.** Configuration is not evidence — **delivery** is.

---

## Section A — Notification channels (do this first; everything depends on it)

| # | Check | Evidence to capture |
|---|---|---|
| A1 | Notification channel exists (email / SMS / Slack / PagerDuty) | Screenshot of the channel list |
| A2 | Channel is **verified** (Google requires confirmation) | "Verified" status shown |
| A3 | Channel is attached to **every** policy in Section B | Policy → channel mapping |
| A4 | **Send a test notification** from the channel config | **Screenshot of the received message** |

**A4 is the gate.** If a test notification does not arrive, nothing below can be trusted.

---

## Section B — Alert policies

For each: confirm the policy **exists**, is **enabled**, has a sane **threshold**, and is **wired to a verified channel**.

| # | Alert | Condition (suggested) | Why it matters |
|---|---|---|---|
| B1 | **Payment failures** | `intasendWebhook` / `darajaSTKCallback` error-rate > 5% over 5 min | Money silently failing |
| B2 | **Payment webhook silence** | **0 invocations** of the payment webhooks in 60 min during trading hours | A dead webhook looks identical to "no sales" |
| B3 | **Authentication failures** | `identitytoolkit` error-rate spike / 403 surge | Lockout or attack |
| B4 | **Function error rate** | Any CF > 5% errors over 5 min | Broad regression |
| B5 | **Scheduler health** | Any of the **158 scheduled functions** fails, or fails to run | Silent job death |
| B6 | **Quota** | Cloud Run services > **90%** of the regional limit (**1,410 / ~1,500 today**) | Deploys start failing |
| B7 | **Firestore** | Read/write rate anomaly; sustained cost spike | Runaway loop / missing cache |
| B8 | **Redis fallback latched** *(after CB-04)* | Log-based alert on `[redis] FALLBACK LATCHED` | **The "no silent fallback" requirement** |
| B9 | **Ledger anomaly** | Duplicate `commissionLedger` id, or ledger writes ≠ payment count | Last line of defence behind P0-2…P0-6 |

---

## Section C — LIVE ALERT TEST (mandatory — this is the actual CB-05 gate)

**Configuration is not evidence. Trip a real alert.**

| # | Step | Evidence |
|---|---|---|
| C1 | Pick the **safest** policy to trip (recommend **B4** function error-rate, on a **non-financial** test function) | Policy name |
| C2 | Deliberately induce the condition (e.g. call a test function that throws N times) | Timestamp + logs |
| C3 | Confirm the alert **fires** in Cloud Monitoring | Screenshot of the incident |
| C4 | Confirm the notification **is received** on the channel | **Screenshot of the email/SMS** |
| C5 | Confirm the incident **auto-resolves** when the condition clears | Resolution screenshot |
| C6 | Record **time-to-notify** (fire → received) | Duration |

**❌ Do NOT trip a payment alert to test.** Use a non-financial function.

---

## Section D — Backups & restore drill

| # | Check | Evidence |
|---|---|---|
| D1 | Firestore **PITR / scheduled backups** are enabled | Config screenshot |
| D2 | A backup exists **within the last 24 h** | Backup listing with timestamp |
| D3 | **RESTORE DRILL** — restore to a **scratch** project/database | Restore job ID + completion |
| D4 | Verify restored data integrity (spot-check orders/wallets/ledger) | Doc counts before vs after |
| D5 | Record **RTO** (time to restore) and **RPO** (data-loss window) | Measured values |

**D3 is the one that counts.** *"Backups are enabled"* is **not** a restore capability — **an untested backup is a hypothesis.**

---

## Section E — Scheduler health (158 deployed scheduled functions)

| # | Check | Evidence |
|---|---|---|
| E1 | All 158 scheduled jobs are **ENABLED** | Scheduler listing |
| E2 | Each has run **within its expected interval** | Last-run timestamps |
| E3 | **No job has been failing silently** | Error counts per job |
| E4 | Confirm `sasosResetMonthlyUsage` (P0-6 fix) is healthy | Last run + result |

---

## Acceptance criteria — CB-05 is COMPLETE only when

- [ ] **A4** test notification received
- [ ] **B1–B9** policies exist, enabled, wired to a verified channel
- [ ] **C4** a **real alert fired and the notification was received** (screenshot)
- [ ] **D3** restore drill completed; **RTO/RPO recorded**
- [ ] **E3** no scheduled job failing silently

**Until C4 and D3 have evidence, CB-05 remains NO-GO.**

## Effort
| Task | Effort |
|---|---|
| A + B (verify/create channels + policies) | 1 h |
| **C — live alert test** | **30 min** |
| **D — restore drill** | **1 h** |
| E — scheduler sweep | 30 min |

Related: [[RELEASE_DASHBOARD]] · [[CB04_REDIS_REMEDIATION]]
