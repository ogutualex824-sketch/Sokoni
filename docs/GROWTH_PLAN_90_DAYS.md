# SOKONI 90-Day Growth Plan — v1.2

**Period:** 2026-06-25 → 2026-09-23  
**Goal:** Grow to trusted marketplace with measurable buyer/seller satisfaction and sustainable GMV growth

---

## Guiding Principle

> Every initiative in this plan must be justified by evidence from real user behaviour.  
> Build nothing that production data does not ask for.

---

## Phase A: Foundation (Days 1–30)

**Goal:** Establish quality baselines. Identify the single biggest lever.

### Week 1–2: Instrument and observe
- [ ] Monitor daily ops report — confirm payment success rate ≥ 90%
- [ ] Run `getMarketplaceQualityReport` — record baseline health score
- [ ] Run `getSearchInsights` after 1 week — identify first zero-result terms
- [ ] Monitor `reliability-center.html` — confirm uptime ≥ 99%
- [ ] Review first batch of feedback submissions in `/admin-feedback`

### Week 3: First interventions
- [ ] Email all sellers with quality score < 50 — personalised listing improvement prompt
- [ ] Add top 10 zero-result terms as Algolia synonyms
- [ ] Fix any Critical or High priority bugs from feedback triage

### Week 4: Review
- [ ] Complete 30-day review using `docs/30_DAY_REVIEW_TEMPLATE.md`
- [ ] Identify top 3 drop-off points from `getFunnelMetrics`
- [ ] Decide go/no-go for Phase B feature work

**Phase A success criteria:**
- Marketplace health score ≥ 70
- Payment success rate ≥ 90% for 2 consecutive weeks
- Zero Critical open bugs
- Funnel baseline established

---

## Phase B: Conversion & Retention (Days 31–60)

**Goal:** Reduce the biggest funnel drop-off identified in Phase A.

### Conversion improvements (implement only those backed by Phase A data)

| Initiative | Trigger condition | Effort |
|-----------|------------------|--------|
| Pre-fill checkout form from profile | `checkoutStarted → paymentAttempted` < 70% | Low |
| Add delivery estimate to cart | Cart → checkout drop-off identified | Medium |
| Surface recently viewed on store page | Session depth < 2 pages | Low (already built) |
| Wishlist reminder notifications | Wishlist size > 0 but no purchase | Medium |

### Seller success improvements

| Initiative | Trigger condition | Effort |
|-----------|------------------|--------|
| Auto-email quality tips to sellers weekly | Avg quality score < 70 | Low |
| Seller performance weekly digest | Any active seller | Medium |
| Enforce min 1 photo on new listings | > 20% listings have no photo | Low |

### Retention features (already built — wire to pages)

| Feature | Action |
|---------|--------|
| Recently viewed strip | Add `<div id="recently-viewed-strip">` to `store.html` and `product.html` |
| Saved searches | Wire "Save this search" button on `search.html` results |
| Price alerts | Wire "Alert me" button on `product.html` when price drops |

**Phase B success criteria:**
- Largest funnel drop-off improved by ≥ 10 percentage points
- At least 100 active price alerts set
- Seller quality score average ≥ 65

---

## Phase C: Growth & Community (Days 61–90)

**Goal:** Build features that grow GMV and seller retention based on Phase B evidence.

### Only proceed with items that Phase B data supports

#### Candidate 1: Loyalty & Rewards (score 22/25 in ROADMAP)
**Start if:** Repeat buyer rate < 25% AND Phase A/B shows > 30% of orders from returning buyers
**What to build:** Points on purchase, redeem on next order, seller bonus points for high ratings
**Effort:** 3–4 weeks

#### Candidate 2: Wallet & Seller Payouts (score 21/25)
**Start if:** > 50 active sellers AND seller payout requests appearing in feedback
**What to build:** Seller balance tracking, automated weekly payout, buyer wallet for refunds
**Effort:** 4–5 weeks

#### Candidate 3: Jobs Marketplace (score 18/25)
**Start if:** > 20 job-related searches per week in `getSearchInsights`
**What to build:** Extend `jobs.html` — employer dashboard, CV upload, application tracking
**Effort:** 2–3 weeks

#### Candidate 4: Cart Abandonment Recovery (conditional)
**Start if:** Cart → checkout drop-off > 50% in `getFunnelMetrics`
**What to build:** `emailOnCartAbandoned` CF (24h trigger), `onCartCreated` Firestore trigger
**Effort:** 1–2 weeks

---

## Evidence Gates

No Phase C work begins without:

| Gate | Threshold | Source |
|------|-----------|--------|
| Payment success rate | ≥ 90% for 4 consecutive weeks | `scheduledDailyOpsReport` |
| Uptime | ≥ 99% for 30 days | `getReliabilityMetrics` |
| Open Critical bugs | 0 | `/admin-feedback` |
| Conversion funnel baseline | 30d of data | `getFunnelMetrics` |
| Marketplace health score | ≥ 75 | `getMarketplaceQualityReport` |

---

## KPI Dashboard

Track these weekly:

| KPI | Baseline (now) | 30-day target | 90-day target |
|-----|---------------|--------------|--------------|
| GMV (monthly, KES) | TBD | +20% | +100% |
| Active sellers | TBD | +30% | +100% |
| Active buyers | TBD | +50% | +200% |
| Payment success rate | TBD | ≥ 90% | ≥ 93% |
| Cart → Paid rate | TBD | ≥ 35% | ≥ 45% |
| Marketplace health score | TBD | ≥ 75 | ≥ 85 |
| Avg listing quality score | TBD | ≥ 65 | ≥ 75 |
| Search zero-result rate | TBD | < 15% | < 8% |
| Repeat buyer rate | TBD | ≥ 15% | ≥ 25% |

**Source for all KPIs:** `/business-kpi`, `/reliability-center`, `/admin-feedback`, `getMarketplaceQualityReport`, `getSearchInsights`

---

## What This Plan Deliberately Excludes

| Feature | Reason for exclusion |
|---------|---------------------|
| Blockchain / NFT | No user demand signal |
| Livestream shopping | High complexity, no demand signal |
| New hub categories | Existing hubs underutilised — depth before breadth |
| Desktop app / mobile app | Web platform sufficient for now |
| AI chatbot | AI assistant already exists; improve it before adding new AI surface |

---

## Review Schedule

| Review | Date | Trigger |
|--------|------|---------|
| 30-day soft launch review | ~2026-07-25 | Phase A complete |
| Phase B go/no-go | ~2026-08-01 | 30-day review passed gates |
| 90-day growth review | ~2026-09-23 | Quarterly OKR review |
| v1.3 sprint planning | ~2026-09-01 | Phase B evidence collected |

---

*This plan will be revised at each review point based on real production data. Estimates and targets are directional, not commitments.*
