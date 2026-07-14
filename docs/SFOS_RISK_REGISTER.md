# SFOS Risk Register

**System:** SOKONI Financial Operating System (SFOS)
**Version:** 1.0
**Register Date:** 2026-07-14
**Owner:** CTO
**Review Cycle:** Monthly during Phase 0 Pilot; quarterly thereafter
**Format:** ISO 31000 / COSO ERM adapted for fintech

---

## Risk Scoring Matrix

| Likelihood \ Impact | 1 — Negligible | 2 — Minor | 3 — Moderate | 4 — Major | 5 — Critical |
|---|---|---|---|---|---|
| 5 — Almost Certain | 5 | 10 | 15 | 20 | 25 |
| 4 — Likely | 4 | 8 | 12 | 16 | 20 |
| 3 — Possible | 3 | 6 | 9 | 12 | 15 |
| 2 — Unlikely | 2 | 4 | 6 | 8 | 10 |
| 1 — Rare | 1 | 2 | 3 | 4 | 5 |

**Risk appetite threshold:** Score ≥ 12 requires immediate mitigation plan and executive awareness.

---

## Risk Register

---

### RISK-001 — Firestore Transaction Timeout Under High Load

| Field | Value |
|---|---|
| **Category** | Technical |
| **Description** | `runTransaction` in SFOS transfer and escrow-lock functions has a 30-second timeout in the Firebase SDK. Under high concurrent load, contention on the same `sfosIdentity/{uid}` or `wallets/{uid}` document can cause repeated retries and eventual transaction failure (Firebase retries 5 times by default). A user may see a failed transfer when the underlying state is ambiguous. |
| **Likelihood** | 3 — Possible (low traffic now; increases as user base grows) |
| **Impact** | 4 — Major (failed financial transaction; possible user complaint / chargeback) |
| **Risk Score** | **12** |
| **Current Controls** | Double-entry ledger makes partial writes visible; `_writeAuditLog` captures the attempt; `sfosTransactions` is only written after the balance transaction commits |
| **Residual Risk** | 8 — Moderate |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Implement idempotency keys so retried requests return the original result rather than a new attempt. (2) Monitor Cloud Monitoring `firestore/document_write_count` and `firestore/transaction_conflict_count` metrics. (3) Shard high-traffic wallet documents if contention metrics exceed 10/min per UID. |
| **Review Date** | 2026-08-14 |

---

### RISK-002 — IntaSend API Downtime (Single Point of Failure for M-Pesa)

| Field | Value |
|---|---|
| **Category** | Technical / External |
| **Description** | All M-Pesa STK push and B2C payouts for SFOS wallet top-ups and merchant withdrawals route through the IntaSend API. If IntaSend experiences an outage, all real-money deposits and withdrawals halt. SFOS internal transfers (wallet-to-wallet) continue, but no new funds can enter or leave the platform. |
| **Likelihood** | 3 — Possible (IntaSend has had historical incidents; Safaricom Daraja also has its own scheduled maintenance windows) |
| **Impact** | 5 — Critical (revenue stop; merchant cashflow disruption; brand damage) |
| **Risk Score** | **15** |
| **Current Controls** | IntaSend provides webhook callbacks; SFOS holds transaction in `PENDING` state until callback confirms; no funds are moved until confirmation |
| **Residual Risk** | 9 — Moderate |
| **Owner** | Engineering / Finance |
| **Mitigation Action** | (1) Register a direct Safaricom Daraja API account as a fallback (noted in project_mpesa_intasend.md as flagged). (2) Implement a circuit-breaker pattern: if IntaSend fails 3 consecutive STK requests in 5 minutes, surface a user-facing banner and queue deposits for retry. (3) Add IntaSend status endpoint polling to the SOKONI status page. (4) Establish an SLA with IntaSend covering incident notification time. |
| **Review Date** | 2026-08-14 |

---

### RISK-003 — Firebase Cloud Function Invocation Quota Exhaustion

| Field | Value |
|---|---|
| **Category** | Technical / Infrastructure |
| **Description** | Cloud Functions Gen2 run on Cloud Run. The project already has 23 pending CFs blocked by Cloud Run CPU quota (project_pending_functions_quota.md). If SFOS traffic spikes during a promotion or viral event, the combined invocation rate across all SOKONI functions could hit the per-project Cloud Run concurrent request quota, causing SFOS functions to queue and eventually return 429 or 503 errors. |
| **Likelihood** | 3 — Possible (quota is already partially blocked) |
| **Impact** | 4 — Major (financial transactions rejected; user trust impact) |
| **Risk Score** | **12** |
| **Current Controls** | SFOS functions use `minInstances: 0` (cost-efficient at low traffic); App Check filters bot traffic |
| **Residual Risk** | 6 — Low-Moderate |
| **Owner** | Engineering / DevOps |
| **Mitigation Action** | (1) File a Cloud Run CPU quota increase request with Google Cloud before Phase 1 launch. (2) Implement request queuing for non-time-sensitive SFOS operations (rewards update, audit log) so that the critical payment path is prioritised. (3) Set `maxInstances` on SFOS transfer functions to reserve capacity. (4) Configure Cloud Monitoring alerting at 70% quota utilisation. |
| **Review Date** | 2026-08-14 |

---

### RISK-004 — Firestore Write Volume Quota / Cost Spike

| Field | Value |
|---|---|
| **Category** | Technical / Financial |
| **Description** | Every SFOS transfer writes at least 6 Firestore documents: 2 ledger entries (debit/credit), 1 transaction record, 1 sfosIdentity update (velocity), 1 legacy wallets update, and 1 audit log entry. At scale, a 10,000-transactions/day volume generates 60,000+ writes/day. The free tier covers 20,000 writes/day; beyond that costs accumulate. A DDoS or abuse scenario could cause a cost spike even with App Check active. |
| **Likelihood** | 2 — Unlikely (App Check filters most abuse; authenticated users are required) |
| **Impact** | 3 — Moderate (unexpected Firebase billing; potential service throttle) |
| **Risk Score** | **6** |
| **Current Controls** | App Check enforces attestation; Firebase billing alerts can be set; velocity limits reduce per-user write amplification |
| **Residual Risk** | 3 — Low |
| **Owner** | Engineering / Finance |
| **Mitigation Action** | (1) Set Firebase billing budget alerts at KES 5,000/month increments. (2) Batch non-critical writes (rewards, analytics) using Firestore batched writes. (3) Monitor `firestore/write_ops_count` in Cloud Monitoring. |
| **Review Date** | 2026-10-14 |

---

### RISK-005 — CBK Regulatory Change Requiring New Escrow Structure

| Field | Value |
|---|---|
| **Category** | Regulatory |
| **Description** | The Central Bank of Kenya could amend the National Payment System Act or issue a new Payment Services Regulation requiring that customer float funds be held in a separate, named trust account at a licensed bank rather than on-platform in Firestore balances. This would require a structural change to the SFOS settlement and escrow architecture. |
| **Likelihood** | 2 — Unlikely in Phase 0; increases as transaction volume makes SOKONI a licensed PSP |
| **Impact** | 5 — Critical (requires re-architecture of sfosEscrow, merchant settlement, and banking relationships) |
| **Risk Score** | **10** |
| **Current Controls** | Settlement engine routes to Bravilex entity (canonical MoR per project_settlement_engine.md); escrow model documented |
| **Residual Risk** | 6 — Low-Moderate |
| **Owner** | Legal / CTO |
| **Mitigation Action** | (1) Legal to monitor CBK gazette notices and consultation papers. (2) Architecture the sfosEscrow collection so that the `bankAccount` field can be populated and the settlement CF can direct funds to an external bank account without a full rewrite. (3) Engage a CBK-licensed banking partner (e.g., KCB, Equity) for trust account before exceeding the PSP licensing threshold. |
| **Review Date** | 2026-10-14 |

---

### RISK-006 — Staff Error Causing Bulk Reversal or Data Corruption

| Field | Value |
|---|---|
| **Category** | Operational |
| **Description** | An admin or engineer with Firebase Console access could accidentally run a bulk update against `sfosIdentity` or `wallets` collections (e.g., a misconfigured script that zeros all balances, or a mistaken `deleteCollection` call). The Admin SDK bypasses Firestore rules, so no rule-based safety net applies. |
| **Likelihood** | 2 — Unlikely (small engineering team; console access is restricted) |
| **Impact** | 5 — Critical (financial data corruption; unable to reconstruct balances if ledger also affected) |
| **Risk Score** | **10** |
| **Current Controls** | `sfosLedger` is append-only (no delete rules on client side); Point-in-Time Recovery (PITR) is enabled on the Firestore database (confirmed in project_full_deployment.md) |
| **Residual Risk** | 4 — Low |
| **Owner** | CTO / Engineering |
| **Mitigation Action** | (1) Enable PITR on the Firestore database and verify the 7-day recovery window monthly. (2) Implement a two-person authorisation policy for any bulk Admin SDK script: one engineer writes, a second engineer reviews and triggers. (3) Add a `protectedCollections` list to the SOKONI ops runbook: `sfosLedger`, `sfosAuditLog`, `sfosTransactions` — never delete, always backup before batch update. (4) Maintain a nightly export to Cloud Storage using Firestore managed export. |
| **Review Date** | 2026-08-14 |

---

### RISK-007 — AI Forecast CF (Claude Haiku) Unavailability

| Field | Value |
|---|---|
| **Category** | Technical / External |
| **Description** | The SFOS financial health and AI forecast Cloud Functions call the Anthropic API (Claude Haiku) using `ANTHROPIC_API_KEY`. If the Anthropic API is unavailable, or the API key is revoked/expired, these functions will fail. If the forecast CF is called in the critical path (e.g., before approving a high-value transfer), this could block legitimate transactions. |
| **Likelihood** | 2 — Unlikely (Anthropic API has high availability; API key rotation is managed) |
| **Impact** | 3 — Moderate (AI features unavailable; transaction could be blocked if AI is in critical path) |
| **Risk Score** | **6** |
| **Current Controls** | `ANTHROPIC_API_KEY` is in Secret Manager; the forecast CF is separate from the transfer CF |
| **Residual Risk** | 2 — Low |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Ensure AI forecast is never in the synchronous critical path for any financial transaction — it must be advisory/async only. (2) Wrap all Anthropic API calls in try/catch with a graceful fallback (return `{ forecast: null, confidence: 0, source: 'UNAVAILABLE' }`). (3) Add `ANTHROPIC_API_KEY` to the secrets rotation schedule (every 90 days). |
| **Review Date** | 2026-10-14 |

---

### RISK-008 — Crypto Randomness Failure for walletId Generation

| Field | Value |
|---|---|
| **Category** | Technical / Security |
| **Description** | `_genWalletId()` uses `crypto.randomBytes(8)` to seed an 8-character alphanumeric wallet ID. In a theoretical but extremely unlikely scenario, the OS entropy pool at function cold start could be depleted on a newly spun Cloud Run container, causing `crypto.randomBytes` to block or return low-entropy values. This could lead to wallet ID collisions or predictable IDs if the entropy pool is not properly seeded by the kernel. |
| **Likelihood** | 1 — Rare (Cloud Run containers run on hardened GCP VMs with proper entropy sources; `/dev/urandom` is always non-blocking on Linux kernel ≥ 3.17) |
| **Impact** | 4 — Major (wallet ID collision = two users share one ID; predictable IDs = account enumeration attack) |
| **Risk Score** | **4** |
| **Current Controls** | 5-attempt collision check with Firestore query; `_genId` uses both timestamp and 5 random bytes; Node.js 22 uses the kernel CSPRNG |
| **Residual Risk** | 2 — Low |
| **Owner** | Engineering |
| **Mitigation Action** | (1) The 5-attempt collision check is the correct defence; verify it is also in place for `_genId` used in transaction IDs. (2) Consider adding a UUID v4 suffix to wallet IDs if the platform scales to >1M wallets where `SOK-XXXXXXXX` (36^8 ≈ 2.8 trillion combinations) remains adequate but collision probability increases. (3) No immediate action required. |
| **Review Date** | 2026-12-14 |

---

### RISK-009 — Redis Infrastructure Unavailability

| Field | Value |
|---|---|
| **Category** | Technical / Infrastructure |
| **Description** | The Redis Infrastructure Layer (project_redis_layer.md) is planned for rate limiting and session caching. SFOS functions that depend on Redis for per-user rate limiting will need to handle Redis connection failures gracefully. If Redis goes down and the fallback is to allow all requests, the rate limit control is lost. If the fallback is to deny all requests, legitimate users are blocked. |
| **Likelihood** | 2 — Unlikely (Redis is not yet in production for SFOS; risk materialises post-GA) |
| **Impact** | 3 — Moderate (either rate limit bypass or legitimate user lockout depending on fail-open vs fail-closed policy) |
| **Risk Score** | **6** |
| **Current Controls** | Redis is not yet in the SFOS critical path; fallback is App Check + velocity limits only |
| **Residual Risk** | 4 — Low-Moderate (post-Redis integration) |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Design the Redis rate-limit middleware with a fail-open policy for SFOS (allow the request, log the Redis failure) rather than fail-closed, because a Redis outage should not prevent legitimate financial transactions. (2) Deploy Redis with replication (at minimum a primary + one replica). (3) Configure a Cloud Monitoring alert for Redis connection pool exhaustion. (4) VPC connector must be in place before Redis is on the SFOS critical path (noted as pending in project_redis_live.md). |
| **Review Date** | 2026-09-14 |

---

### RISK-010 — Cloud Run CPU Quota Exhaustion Causing CF Cold-Start Delays

| Field | Value |
|---|---|
| **Category** | Technical / Infrastructure |
| **Description** | Firebase Gen2 Cloud Functions run on Cloud Run. The project has already hit CPU quota limits (project_pending_functions_quota.md — 23 CFs blocked). If SFOS functions experience cold starts during traffic surges, the first invocation after idle could take 3–8 seconds to initialise (loading `firebase-admin`, `firebase-functions`, and the `sfos-engine.js` module). For payment functions, this latency is user-visible. |
| **Likelihood** | 3 — Possible (quota is partially exhausted; cold starts are always possible at `minInstances: 0`) |
| **Impact** | 3 — Moderate (user-visible latency; potential client timeout if > 10 seconds) |
| **Risk Score** | **9** |
| **Current Controls** | `sfos-engine.js` is a single module (no dynamic imports); Node.js 22 has faster startup than Node.js 16; module-level initialisations are minimal |
| **Residual Risk** | 6 — Low-Moderate |
| **Owner** | Engineering / DevOps |
| **Mitigation Action** | (1) Set `minInstances: 1` on `sfosTransfer` and `sfosEscrowLock` (the two most latency-sensitive functions) to eliminate cold starts on the critical payment path. (2) File the Cloud Run CPU quota increase request (noted as pending). (3) Consider lazy initialisation of the Anthropic client (only load it in the forecast function, not at module scope in sfos-engine.js). |
| **Review Date** | 2026-08-14 |

---

### RISK-011 — Firestore 200-Index Limit Approaching

| Field | Value |
|---|---|
| **Category** | Technical / Infrastructure |
| **Description** | The SOKONI production Firestore database is approaching its composite index limit. Project memory notes the use of a second Firestore database (`sokoni-ops`) at the 200-index limit (project_firestore_index_architecture.md). If SFOS queries require additional composite indexes (e.g., for new reporting queries, risk-score filtering, or the new `sfosIdempotency` collection) and the index count is already near the ceiling, new function deployments that need those indexes will fail. |
| **Likelihood** | 3 — Possible (197 indexes confirmed in RC1 hardening sprint; 3 remaining in primary DB) |
| **Impact** | 3 — Moderate (new SFOS features blocked; reporting queries fail; developer velocity drops) |
| **Risk Score** | **9** |
| **Current Controls** | Index management rule in CLAUDE.md: never drop indexes, only add; second DB (`sokoni-ops`) at 200-limit boundary; `firestore.indexes.json` is source of truth |
| **Residual Risk** | 6 — Low-Moderate |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Do not add any composite index to the primary Firestore database without first confirming the current count via `firebase firestore:indexes --project sokoni`. (2) Route all new SFOS administrative queries (reporting, audit export, risk analytics) to the `sokoni-ops` secondary database. (3) Contact Firebase support to request an index quota increase for the primary database before Phase 1. (4) Evaluate whether any existing SFOS indexes can be covered by collection-group queries to reduce composite index count. |
| **Review Date** | 2026-08-14 |

---

### RISK-012 — Velocity Counter Race Condition Leading to Limit Bypass

| Field | Value |
|---|---|
| **Category** | Technical / Security / Financial |
| **Description** | The `_velocityCheck` function reads `dailySpent` and `monthlySpent` from `sfosIdentity`, checks the amount against the limit, and then `_updateVelocity` writes the incremented value in a separate operation. These two operations are not wrapped in a Firestore `runTransaction`. A user making two simultaneous transfer requests (e.g., from two browser tabs or two devices) could both pass the velocity check with the same stale `dailySpent` value, each spending up to the full daily limit for a combined total of 2× the intended limit. |
| **Likelihood** | 3 — Possible (dual-device usage is common; a motivated fraudster would exploit this) |
| **Impact** | 4 — Major (user exceeds intended KES 50,000/day limit; platform absorbs the overrun if funded by escrow) |
| **Risk Score** | **12** |
| **Current Controls** | The balance itself is protected by `runTransaction` (the user cannot overdraft); daily limit bypass means they can transact more than intended but only up to their actual wallet balance |
| **Residual Risk** | 6 — Low-Moderate (post-fix) |
| **Owner** | Engineering |
| **Mitigation Action** | Merge the `_velocityCheck` and `_updateVelocity` calls into a single `runTransaction` block on `sfosIdentity`. This is tracked as SEC-001 in the security audit and is a P1 item for the v1.1 Engine Hardening sprint. |
| **Review Date** | 2026-08-14 |

---

### RISK-013 — Idempotency Gap Causing Duplicate Transactions on Retry

| Field | Value |
|---|---|
| **Category** | Technical / Financial |
| **Description** | If a client submits a transfer request and the Cloud Function times out (or the client loses connectivity) before receiving a response, the client will retry. Because SFOS does not yet persist and check an idempotency key, the second request will create a new transaction with a new `txId`, effectively sending the amount twice. The user's balance will be debited twice; the recipient will receive two credits. |
| **Likelihood** | 3 — Possible (mobile network drops are common in Kenya; CF cold starts can cause timeout) |
| **Impact** | 4 — Major (financial loss for sender; reconciliation complexity; potential fraud vector) |
| **Risk Score** | **12** |
| **Current Controls** | Balance floor in `runTransaction` prevents overdraft (the second transfer will fail if the balance is insufficient after the first); audit log captures both transactions |
| **Residual Risk** | 6 — Low-Moderate (post-fix) |
| **Owner** | Engineering |
| **Mitigation Action** | Implement server-side idempotency key checking using the `sfosIdempotency` collection (Firestore rule already added in this sprint). Key derivation: `SHA-256(uid + clientRef + amount + toId + day)`. Store the key atomically within the transfer `runTransaction`. This is tracked as SEC-002 and is a P1 item for the v1.1 Engine Hardening sprint. |
| **Review Date** | 2026-08-14 |

---

### RISK-014 — No Step-Up MFA for High-Value Transactions

| Field | Value |
|---|---|
| **Category** | Security / Regulatory |
| **Description** | SFOS does not currently require a second authentication factor for transactions above any threshold. A user whose Firebase session token is stolen (e.g., via XSS on a third-party app, or a compromised device) could transfer up to KES 50,000/day without any additional challenge. CBK guidelines increasingly require strong authentication for electronic funds transfers. |
| **Likelihood** | 2 — Unlikely (App Check + Firebase Auth token expiry provides a baseline; session theft is non-trivial) |
| **Impact** | 5 — Critical (full wallet drained; user harm; regulatory sanction) |
| **Risk Score** | **10** |
| **Current Controls** | Firebase ID tokens expire after 1 hour and must be refreshed; `_riskScore` flags unusual activity; `sfosRiskEvents` captures anomalies; velocity limits bound maximum loss |
| **Residual Risk** | 4 — Low (with risk score controls) |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Implement a PIN re-entry challenge (`sfosIdentity.pinHash` already stores the PIN hash) for transfers above KES 10,000. (2) Wire the Security 6.0 TOTP/Passkey MFA into SFOS before GA. (3) Add a `highValueThreshold` field to `sfosIdentity` so the threshold can be adjusted per user (lower for bronze tier). |
| **Review Date** | 2026-09-14 |

---

### RISK-015 — Merchant Settlement Delay Causing Float Mismatch

| Field | Value |
|---|---|
| **Category** | Financial / Operational |
| **Description** | The SFOS merchant settlement flow holds funds in `sfosEscrow` after a marketplace sale and releases them on delivery confirmation or after a dispute window. If the settlement CF fails silently (fire-and-forget pattern noted in project codebase_fixes.md), the escrow funds remain locked but the merchant's balance is not credited. Over time this creates a mismatch between the platform float (total escrow balance) and what merchants are owed. |
| **Likelihood** | 3 — Possible (fire-and-forget CF failures are a documented pattern in the codebase) |
| **Impact** | 4 — Major (merchant revenue locked; trust damage; potential regulatory complaint) |
| **Risk Score** | **12** |
| **Current Controls** | `sfosAuditLog` captures settlement attempts; `sfosEscrow` status field tracks PENDING / RELEASED / DISPUTED; manual reconciliation is possible via audit log |
| **Residual Risk** | 6 — Low-Moderate |
| **Owner** | Engineering / Finance |
| **Mitigation Action** | (1) Ensure the merchant settlement CF is not fire-and-forget: it must await the Firestore write and throw `HttpsError` on failure. (2) Implement a Cloud Scheduler job that scans `sfosEscrow` documents with `status == 'PENDING'` and `releasedAt < now - 48h` and alerts operations. (3) Add a reconciliation report to the Admin OS that compares total escrow balances against merchant receivables daily. |
| **Review Date** | 2026-08-14 |

---

### RISK-016 — SENDGRID_API_KEY Placeholder Blocking Email Notifications

| Field | Value |
|---|---|
| **Category** | Operational |
| **Description** | Project memory (project_email_system.md) notes that `SENDGRID_API_KEY` still needs a real value. SFOS sends email notifications for wallet top-ups, transfer confirmations, and daily/monthly limit changes. If the key is a placeholder, all email confirmations fail silently. Users will not receive transaction confirmation emails, which is a CBK consumer protection requirement for electronic fund transfers. |
| **Likelihood** | 4 — Likely (key is confirmed as placeholder in project memory) |
| **Impact** | 2 — Minor (transactions still complete; only notification delivery fails) |
| **Risk Score** | **8** |
| **Current Controls** | Push notifications and in-app notifications are separate from email; transaction records in `sfosTransactions` are authoritative |
| **Residual Risk** | 4 — Low |
| **Owner** | Engineering / Operations |
| **Mitigation Action** | Replace the SENDGRID_API_KEY placeholder with a live key in Secret Manager before Phase 0 Pilot goes live. Verify by triggering a test transfer and confirming the email is received. This is a blocker for CBK compliance on email confirmations. |
| **Review Date** | 2026-07-21 |

---

### RISK-017 — Algolia / Search Engine Exposing Financial Data

| Field | Value |
|---|---|
| **Category** | Security / Data Protection |
| **Description** | The Enterprise Search Platform (project_enterprise_search.md) indexes platform content. If any SFOS collection is accidentally included in the Algolia index (e.g., a misconfigured Firestore-to-Algolia sync function), financial records including wallet balances, phone numbers, and transaction amounts could be exposed via Algolia's search API — which has its own access control model independent of Firestore rules. |
| **Likelihood** | 2 — Unlikely (SFOS collections are not expected to be indexed) |
| **Impact** | 5 — Critical (mass PII and financial data leak; DPA 2019 breach; CBK incident report required) |
| **Risk Score** | **10** |
| **Current Controls** | Algolia index configuration is separate from SFOS; SFOS collections are not in the search architecture documentation |
| **Residual Risk** | 2 — Low |
| **Owner** | Engineering |
| **Mitigation Action** | (1) Add `sfos*` and `wallets` to an explicit blocklist in the Algolia sync configuration. (2) Review all Firestore-triggered functions that write to external indexes and confirm SFOS collections are excluded. (3) Add this check to the security gate checklist for every new search index addition. |
| **Review Date** | 2026-10-14 |

---

## Risk Summary Dashboard

| Risk ID | Title | Score | Priority | Owner | Status |
|---|---|---|---|---|---|
| RISK-001 | Firestore transaction timeout under high load | 12 | P1 | Engineering | Monitoring |
| RISK-002 | IntaSend API downtime | 15 | P0 | Engineering / Finance | Mitigation planning |
| RISK-003 | Firebase CF quota exhaustion | 12 | P1 | Engineering / DevOps | Quota request pending |
| RISK-004 | Firestore write cost spike | 6 | P3 | Engineering / Finance | Billing alerts set |
| RISK-005 | CBK escrow regulation change | 10 | P2 | Legal / CTO | Legal monitoring |
| RISK-006 | Staff error — bulk reversal / data corruption | 10 | P2 | CTO / Engineering | PITR enabled; runbook needed |
| RISK-007 | Claude Haiku API unavailability | 6 | P3 | Engineering | Graceful fallback needed |
| RISK-008 | Crypto randomness failure for wallet ID | 4 | P3 | Engineering | Collision check present |
| RISK-009 | Redis unavailability | 6 | P2 | Engineering | Pre-integration; VPC pending |
| RISK-010 | CF cold-start latency | 9 | P2 | Engineering / DevOps | minInstances to be set |
| RISK-011 | Firestore 200-index limit | 9 | P1 | Engineering | 197 used; 3 remaining |
| RISK-012 | Velocity counter race condition | 12 | P1 | Engineering | v1.1 Engine Hardening |
| RISK-013 | Idempotency gap — duplicate transactions | 12 | P1 | Engineering | v1.1 Engine Hardening |
| RISK-014 | No MFA for high-value transactions | 10 | P1 | Engineering | Security 6.0 sprint |
| RISK-015 | Merchant settlement delay / float mismatch | 12 | P1 | Engineering / Finance | Scheduler job needed |
| RISK-016 | SENDGRID_API_KEY placeholder | 8 | P1 | Engineering / Ops | Replace before pilot |
| RISK-017 | Search engine exposing financial data | 10 | P2 | Engineering | Blocklist to be added |

---

## P0 and P1 Action Items (Immediate)

| ID | Action | Owner | Due |
|---|---|---|---|
| RISK-002 | Evaluate Daraja direct fallback; contact IntaSend for SLA | Engineering / Finance | 2026-07-28 |
| RISK-011 | Confirm current index count; file quota increase request | Engineering | 2026-07-21 |
| RISK-012 | Merge velocity check into runTransaction (v1.1 sprint) | Engineering | 2026-08-14 |
| RISK-013 | Implement sfosIdempotency key check in sfosTransfer (v1.1 sprint) | Engineering | 2026-08-14 |
| RISK-014 | Implement PIN re-entry for transfers > KES 10,000 | Engineering | 2026-09-14 |
| RISK-015 | Audit settlement CF for fire-and-forget; add scheduler reconciliation | Engineering | 2026-08-14 |
| RISK-016 | Replace SENDGRID_API_KEY with live key in Secret Manager | Engineering / Ops | 2026-07-21 |
| RISK-001 | Add idempotency (also addresses retry timeout ambiguity) | Engineering | 2026-08-14 |
| RISK-003 | File Cloud Run CPU quota increase request | DevOps | 2026-07-21 |

---

*This register is a living document. All risks should be reviewed at the monthly engineering steering meeting. Risk owners are responsible for updating status and residual risk after mitigation actions are completed.*

*Next full register review: 2026-08-14*
