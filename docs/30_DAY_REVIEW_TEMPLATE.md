# SOKONI 30-Day Soft Launch Review

**Launch Date:** [YYYY-MM-DD]  
**Review Date:** [YYYY-MM-DD]  
**Review Author:** [Name]

---

## Executive Summary

> 3–5 sentences. Was the launch stable? What worked well? What surprised you? What is the single most important thing to fix or build next?

---

## 1. Platform Stability (30 Days)

| Metric | Value | Assessment |
|--------|-------|------------|
| Overall uptime | % | ✅ / ⚠ / 🚨 |
| Total health snapshots | count | |
| Degraded events | count | |
| Down events | count | |
| Average Firestore latency | ms | |
| P95 Firestore latency | ms | |

**Source:** `getReliabilityMetrics({ hours: 720 })`

---

## 2. Commerce Performance (30 Days)

| Metric | Value | Benchmark |
|--------|-------|-----------|
| Total orders | | — |
| Paid orders | | — |
| GMV (KES) | | — |
| Average Order Value | KES | — |
| Active buyers | | — |
| Active sellers | | — |
| Payment success rate | % | ≥ 90% |
| Cart → Checkout rate | % | ≥ 60% |
| Checkout → Paid rate | % | ≥ 75% |

**Source:** `getBusinessMetrics({ period: "monthly" })` + `getFunnelMetrics({ days: 30 })`

---

## 3. Top Categories (Real Demand Signal)

| Rank | Category | Orders | GMV (KES) | Signal |
|------|----------|--------|-----------|--------|
| 1 | | | | Confirmed demand |
| 2 | | | | Confirmed demand |
| 3 | | | | Emerging |
| 4 | | | | Emerging |
| 5 | | | | Low |

**Implication for v1.1:** Which categories should be featured? Which hubs need investment?

---

## 4. Customer Feedback Analysis

### Volume by Type

| Type | Count | Resolved | Avg Priority |
|------|-------|----------|-------------|
| Bug reports | | | |
| Feature requests | | | |
| Page ratings | | | |
| Incorrect listings | | | |

### Top Bugs (by frequency)

| Bug | Reports | Status | Impact |
|-----|---------|--------|--------|
| | | | |

### Top Feature Requests (by frequency)

| Feature Request | Votes | User Impact | Build in v1.1? |
|----------------|-------|-------------|----------------|
| | | | Yes / No / Later |

### Average Page Rating
___/5 across ___ ratings

---

## 5. Seller Feedback

> Summary from admin-feedback items where type = bug or feature from sellers (uid patterns or self-identified in message).

- What is the most common seller complaint?
- What tools are sellers missing?
- Are sellers uploading products consistently?
- Are sellers receiving and fulfilling orders?

---

## 6. Security Review

| Event | 30-Day Count | Severity | Action |
|-------|-------------|----------|--------|
| CSP violations | | | |
| Failed payments | | | |
| Auth anomalies | | | |
| Abuse reports | | | |

**No security incidents:** [Yes/No]  
**Security posture after 30 days:** [Normal / Needs hardening]

---

## 7. Infrastructure Costs (Estimate)

| Resource | 30-Day Usage | Estimated Cost (KES) |
|---------|-------------|---------------------|
| Cloud Functions | | |
| Firestore | | |
| Cloud Storage | | |
| SendGrid | | |
| Algolia | | |
| Firebase Hosting | | |
| **Total** | | |

**Cost per order:** KES ___  
**Cost per active user:** KES ___  
**Sustainable at current GMV:** Yes / No

---

## 8. Feature Adoption

| Feature | Users Who Used It | Notes |
|---------|-----------------|-------|
| Product trust panel | | |
| Search (Algolia) | | |
| Notifications | | |
| SmartPOS | | |
| Healthcare bookings | | |
| Car hub | | |

---

## 9. What Worked Well

1.
2.
3.

---

## 10. What Did Not Work as Expected

| Item | Expected | Actual | Root Cause | Fix |
|------|---------|--------|------------|-----|
| | | | | |

---

## 11. v1.1 Priorities — Evidence-Based

Based on 30 days of real production data:

### Priority 1 — [Feature Name]
- **Evidence:** [Data point from feedback / orders / funnel]
- **User impact:** [How many users affected / how directly]
- **Revenue impact:** [Estimated GMV uplift or cost reduction]
- **Complexity:** [Low / Medium / High]
- **Estimated effort:** [days / weeks]

### Priority 2 — [Feature Name]
- **Evidence:**
- **User impact:**
- **Revenue impact:**
- **Complexity:**

### Priority 3 — [Feature Name]
- **Evidence:**
- **User impact:**
- **Revenue impact:**
- **Complexity:**

### Deprioritised vs. original roadmap (with reason)
| Feature | Planned | Actual priority | Reason for change |
|---------|---------|-----------------|-------------------|
| Loyalty & Rewards | Tier 1 | | |
| Wallet | Tier 1 | | |
| Jobs | Tier 1 | | |

---

## 12. Go/No-Go for v1.1 Sprint

| Gate | Status | Notes |
|------|--------|-------|
| Payment success rate ≥ 90% (2 weeks) | ✅ / ❌ | |
| No open Critical bugs | ✅ / ❌ | |
| Uptime ≥ 99% past week | ✅ / ❌ | |
| Conversion baseline established | ✅ / ❌ | |
| No unresolved security incidents | ✅ / ❌ | |

**Decision:** ✅ GO — Begin v1.1 sprint  
**OR:** ❌ NO-GO — Reason: ___

---

*This review synthesises data from `ops-dashboard`, `business-kpi`, `reliability-center`, `admin-feedback`, and the automated daily/weekly reports sent to devops@mysokoni.co.ke.*
