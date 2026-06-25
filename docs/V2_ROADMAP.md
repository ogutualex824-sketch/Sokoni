# SOKONI v2.0 Roadmap — Market Leadership Program

**Status:** Active  
**Period:** 2026-06-25 onwards  
**Guiding principle:** Build less, but build what users prove they need.

---

## What Changed from v1.x to v2.0

v1.x was a feature-building sprint. The platform went from 0 to production infrastructure
in approximately 90 days: 160+ Cloud Functions, 192 Firestore indexes, 130+ HTML pages,
full analytics, monitoring, seller tools, search, email, notifications, and print.

v2.0 is different. The feature count is frozen. The mission is:

> Make the existing platform perform well for real users.

Every engineering decision from v2.0 onward must answer the question:
**"What evidence from production justifies building this?"**

---

## v2.0 Operating Framework

### 1. Feature gate

No new feature without a completed `docs/FEATURE_PROPOSAL_TEMPLATE.md`.

### 2. Performance gate

No new page or function that violates `docs/PERFORMANCE_BUDGET.md`.

### 3. Cost gate

Monthly cost review against `docs/COST_GOVERNANCE.md`.
No new scheduled function without justifying the invocation cost.

### 4. Scale gate

No architectural change before the thresholds in `docs/SCALING_TRIGGERS.md` are crossed.

---

## v2.0 Priorities (Now — Day 90)

These do not require a Feature Proposal. They are operational work:

| Priority | Source | Status |
|----------|--------|--------|
| Establish all KPI baselines | `platform-health.html` | Start Day 1 |
| Run `getMarketplaceQualityReport` weekly | `/admin-feedback` | Start Day 1 |
| Email sellers with quality score < 50 | `getListingQualityReport` | Start Week 2 |
| Add top 10 zero-result terms as Algolia synonyms | `getZeroResultTerms` | Start Week 2 |
| Triage all open feedback bugs | `/admin-feedback` | Start Day 1 |
| Complete 30-day review | `docs/30_DAY_REVIEW_TEMPLATE.md` | Day 30 |

---

## v2.1 Candidate Pool (Day 30–90, evidence-gated)

These features are scored and ranked. None starts until evidence gates are verified.

### Scoring criteria (each 1–5, max 25)

- **Revenue impact:** Direct GMV or commission contribution
- **User demand:** Evidence from search, feedback, or funnel data
- **Effort inverse:** 5 = easy (1 week), 1 = hard (4+ weeks)
- **Strategic value:** Competitive positioning, retention, moat
- **Cost inverse:** 5 = cheap, 1 = expensive to operate

---

### Tier 1 — Build if evidence gate met (Score ≥ 19)

#### Loyalty & Rewards (Score: 21/25)
| Criterion | Score | Notes |
|-----------|-------|-------|
| Revenue impact | 5 | Industry average +25% repeat purchase rate |
| User demand | 3 | No signal yet — grows if repeat buyer rate < 25% |
| Effort inverse | 3 | 3–4 weeks |
| Strategic value | 5 | Creates switching cost — strongest retention mechanism |
| Cost inverse | 5 | Points = virtual currency, marginal Firestore cost |

**Evidence gate:** Repeat buyer rate < 25% after 60 days of production data  
**Build trigger:** Run `getPlatformHealthScores` buyer score; if < 70 AND repeat rate < 25%, start  
**What to build:**
- Points on purchase (10 points per KES 100 spent)
- Tier badges (Bronze / Silver / Gold)
- Redeem on checkout (100 points = KES 10 discount)
- Seller bonus points for 5-star fulfilment

**Rollback:** Points system is additive — can be hidden without data migration

---

#### Cart Abandonment Recovery (Score: 20/25)
| Criterion | Score | Notes |
|-----------|-------|-------|
| Revenue impact | 4 | 10–15% recovery rate is industry average |
| User demand | 4 | Any cart→paid rate < 35% is evidence |
| Effort inverse | 4 | 1 week (1 CF + email template) |
| Strategic value | 4 | Converts existing intent, not new acquisition |
| Cost inverse | 4 | ~50 emails/day at launch |

**Evidence gate:** Cart → paid rate < 35% (from `getFunnelMetrics` after 30 days)  
**Build trigger:** Run `getFunnelMetrics`; if cart→paid < 35%, this is the highest-ROI fix  
**What to build:**
- `emailOnCartAbandoned` CF — Firestore trigger on `carts/{uid}`, 24h delay
- Reuse existing email template system
- Unsubscribe link (CAN-SPAM / GDPR compliance)

**Rollback:** Disable the Firestore trigger — no data migration needed

---

### Tier 2 — Build if Phase B evidence gate met (Score 16–19)

#### Wallet & Seller Payouts (Score: 19/25)
| Criterion | Score | Notes |
|-----------|-------|-------|
| Revenue impact | 5 | Keeps money in ecosystem; float revenue potential |
| User demand | 3 | No signal yet — grows if sellers request payouts |
| Effort inverse | 2 | 4–5 weeks + compliance review |
| Strategic value | 5 | Once sellers rely on wallet, churn drops sharply |
| Cost inverse | 4 | Firestore-only at low volume |

**Evidence gate:** > 50 active sellers AND seller payout requests appear in feedback  
**Compliance note:** M-Pesa disbursement API requires business verification  
**What to build:** Seller balance ledger, weekly automated payout, buyer refund wallet

---

#### Jobs Marketplace (Score: 17/25)
| Criterion | Score | Notes |
|-----------|-------|-------|
| Revenue impact | 3 | Job post fees, featured listings |
| User demand | 2+ev | Check `getSearchInsights` for job/kazi terms |
| Effort inverse | 3 | 2–3 weeks |
| Strategic value | 4 | New audience acquisition (job seekers) |
| Cost inverse | 5 | Static listings, low compute |

**Evidence gate:** > 20 job-related searches/week in `getSearchInsights`  
**What to build:** Extend `jobs.html` — employer dashboard, CV upload, application tracking

---

### Tier 3 — Post-Phase C, minimum 90 days data (Score < 16)

These features are not blocked forever — they become candidates when evidence arrives.

| Feature | Score | Block reason |
|---------|-------|-------------|
| QR Code Ecosystem | 15 | No user demand signal yet |
| Education Hub | 14 | Jobs must prove service-marketplace pattern first |
| Insurance Marketplace | 12 | Requires insurance partner agreements |
| Government Services | 12 | Requires e-government API access agreement |

---

## Features That Are Permanently Excluded

These will not be considered regardless of demand:

| Feature | Reason |
|---------|--------|
| Blockchain / NFT | No legitimate business case for marketplace context |
| Livestream shopping | High complexity; adjacent platform (YouTube/TikTok) already exists |
| AI chatbot (new) | AI assistant already deployed; improve depth before new surface |
| Second mobile app | Web platform is sufficient; mobile app is operational overhead |
| Multi-region Firestore | Not needed until 50,000+ MAU (see SCALING_TRIGGERS.md) |

---

## What Defines v2.0 Success

By Day 90 (2026-09-23), success looks like:

| KPI | Target | Measurement |
|-----|--------|------------|
| Platform health score | ≥ 80 | `getPlatformHealthScores` |
| Marketplace health score | ≥ 75 | Score dimension |
| Seller success score | ≥ 70 | Score dimension |
| Buyer satisfaction score | ≥ 75 | Score dimension |
| Operational health score | ≥ 85 | Score dimension |
| Payment success rate | ≥ 93% for 60 days | `scheduledDailyOpsReport` |
| Zero unresolved Critical bugs | 0 | `/admin-feedback` |
| Listing quality avg score | ≥ 70 | `getListingQualityReport` |
| Zero-result search rate | < 10% | `getSearchInsights` |

If all targets are met by Day 90, commission Tier 1 features (Loyalty + Cart Abandonment).

---

## Decision Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-06-25 | Froze feature count at v1.2 feature level | Platform has sufficient features; focus shifts to quality |
| 2026-06-25 | Introduced Feature Proposal governance | Prevent engineering effort on unvalidated features |
| 2026-06-25 | Ranked Loyalty #1 and Cart Abandonment #2 | Highest evidence-adjusted ROI for repeat purchase growth |

---

*This document is reviewed monthly. Scores and gates are updated based on production evidence.*
