# SOKONI Weekly Operations Report

**Week:** [YYYY-MM-DD] → [YYYY-MM-DD]  
**Prepared by:** Ops Team  
**Distribution:** devops@mysokoni.co.ke

---

## Executive Summary

> One paragraph: was the week stable? Any notable events — traffic spikes, payment issues, incidents? Overall sentiment: smooth / mixed / challenging.

---

## 1. Platform Stability

| Metric | This Week | Last Week | Trend |
|--------|-----------|-----------|-------|
| Uptime % | | | ↑ / ↓ / → |
| Avg Firestore latency (ms) | | | |
| P95 Firestore latency (ms) | | | |
| CF error rate | | | |
| Health check failures | | | |

**Source:** `/reliability-center` → `getReliabilityMetrics({ hours: 168 })`

---

## 2. Commerce Metrics

| Metric | This Week | Last Week | Change |
|--------|-----------|-----------|--------|
| Total orders | | | |
| Paid orders | | | |
| Payment success rate | | | |
| Failed payments | | | |
| GMV (KES) | | | |
| New sellers | | | |
| New buyers | | | |

**Source:** `/business-kpi` → `getBusinessMetrics({ period: "weekly" })`

---

## 3. Conversion Funnel

| Step | Count | Rate vs Prev Step |
|------|-------|-------------------|
| Add to Cart | | — |
| Checkout Started | | % |
| Orders Paid | | % |

**Notable:** [Any drop-off worth investigating?]

**Source:** `getFunnelMetrics({ days: 7 })`

---

## 4. Email & Notifications

| Metric | Value |
|--------|-------|
| Emails sent | |
| Email failures | |
| Failure rate | |
| Email queue depth (current) | |

**Source:** `getOpsStatus()` + emailLogs Firestore collection

---

## 5. Security Events

| Event | Count | vs Last Week |
|-------|-------|-------------|
| CSP violations (7d) | | |
| Failed payments (7d) | | |
| Open bug reports | | |

**Action required:** [Yes/No — describe if yes]

**Source:** `getSecuritySummary()` + weekly security email report

---

## 6. User Feedback Summary

| Priority | New This Week | Resolved | Pending |
|----------|--------------|----------|---------|
| Critical | | | |
| High | | | |
| Medium | | | |
| Low | | | |

**Top bug themes:** [Summarize top 3 bug categories]  
**Top feature requests:** [Summarize top 3 feature requests]

**Source:** `/admin-feedback` → `getFeedbackItems()`

---

## 7. Infrastructure Cost Signals

| Signal | Status | Action |
|--------|--------|--------|
| Email queue depth | | |
| Firestore index utilisation (190/200) | | |
| Health snapshot storage (30d rolling) | | |
| Scheduled CF count | | |

**Cost recommendations:** [Any optimisations observed from real usage data this week]

---

## 8. Incidents

| # | Date | Duration | Impact | Resolution |
|---|------|----------|--------|------------|
| | | | | |

*No incidents this week.* (if applicable)

---

## 9. Actions from Last Week

| Action | Owner | Status |
|--------|-------|--------|
| | | Done / In Progress / Blocked |

---

## 10. Actions for Next Week

| Action | Owner | Priority |
|--------|-------|----------|
| | | High / Medium / Low |

---

## 11. v1.1 Feature Readiness Signal

> Based on this week's data, are we ready to begin a v1.1 feature sprint?

Checklist:
- [ ] Payment success rate ≥ 90% for 2 consecutive weeks
- [ ] No open Critical feedback items
- [ ] Uptime ≥ 99% this week
- [ ] No unresolved security incidents
- [ ] Conversion funnel baseline established (3+ weeks of data)

**Recommendation:** [Start v1.1 / Not yet — reason]

---

*This report is generated weekly. Daily ops data available at [mysokoni.co.ke/ops-dashboard](https://mysokoni.co.ke/ops-dashboard).*
