# SOKONI Phase 0 — Merchant Onboarding & Soft Launch Operations Playbook

**Status:** Active  
**Started:** 2026-06-25  
**Goal:** 25 verified anchor sellers · 500+ quality listings · 6 ready categories · platform health ≥ 80%

---

## Overview

Phase 0 is not a development sprint. It is a marketplace operations exercise.

The platform is feature-complete. Every tool needed to onboard, review, and launch merchants is live. The work now is to recruit the right sellers, verify their stores meet quality standards, and ensure the buyer experience is excellent before marketing spend increases.

**Success looks like:** a buyer opens SOKONI, searches for anything in 6 categories, finds real products from real local businesses, and completes a purchase without confusion or friction.

---

## Phase 1 — Anchor Seller Execution

### Target

| Metric | Target | Minimum |
|--------|--------|---------|
| Verified sellers | 25 | 25 |
| Products per seller | 20+ | 10 |
| Total live listings | 500–1,000 | 500 |
| Ready categories | 6 | 6 |
| Store completeness average | 80%+ | 75% |
| Listing quality average | 80%+ | 75% |

### Seller Recruitment Priority

Recruit anchor sellers in this order:

1. **Grocery & FMCG** — highest daily purchase frequency; drives repeat visits
2. **Fashion & Clothing** — high local supply in Nairobi; large product catalogue
3. **Electronics** — high AOV; builds platform trust if well-curated
4. **Beauty & Personal Care** — strong female buyer segment; repeat purchase
5. **Home & Kitchen** — broad appeal; good photography opportunity
6. **Health & Wellness** — growing demand; differentiates from price-only platforms

Do not open categories with fewer than 3 active sellers until supply is ready.

### Seller Onboarding Checklist

Each seller must complete before approval:

- [ ] Business name filled in
- [ ] Logo uploaded (min 200×200px, square, clean background)
- [ ] Cover/banner image uploaded (min 1200×400px)
- [ ] Business description ≥ 50 words (clear, no grammatical errors)
- [ ] Phone number verified (Kenyan format)
- [ ] M-Pesa / payment method configured
- [ ] Delivery settings configured (area, fee, lead time)
- [ ] Minimum 20 active product listings
- [ ] No placeholder products ("Test Product", "Product 1", "Coming Soon")
- [ ] Store Completeness Score ≥ 80%
- [ ] Listing Quality average ≥ 80%

**Do not approve a store below 80% completeness. Quality at launch defines buyer trust forever.**

### Product Listing Standards

Each listing must meet:

- [ ] Real product name (specific, not generic)
- [ ] Product description ≥ 30 words
- [ ] At least 1 clear product image (no watermarks, no blurry photos)
- [ ] Correct category assignment
- [ ] Price that matches market rate (no KES 1 placeholders)
- [ ] Stock availability accurate
- [ ] Delivery method selected

### Admin Workflow

Use **Merchant Pipeline** (`merchant-pipeline.html`) to manage every seller:

1. **Submitted** — seller has created a profile; review store completeness score
2. **In Review** — open their seller page; check each criterion manually
3. **Needs Changes** — use "Request Changes" button; write specific actionable feedback
4. **Approved** — use "Approve" button; seller becomes verified; badge appears on listings

Review cycle: 24–48 hours per application. Communicate status via admin notes.

---

## Phase 2 — Category Readiness

A category is **launch-ready** when it has:

| Criterion | Minimum |
|-----------|---------|
| Active sellers | 3+ |
| Live listings | 50+ |
| Average listing quality | 75%+ |
| Average product images | ≥ 1 per listing |
| Zero-result search rate | ≤ 15% |

### Category Tracking

Track each category weekly in the [[WEEKLY_OPERATIONS_REPORT]] template.

Categories that fail minimum thresholds:
- Are **not** featured on the homepage
- Are **not** promoted in any marketing
- Are flagged as "Coming Soon" in the category browser

### Category Promotion Ladder

| Stage | Criteria met | Display |
|-------|-------------|---------|
| Hidden | 0–2 criteria | Not shown to buyers |
| Preview | 3 criteria | Shown with "New" badge, no promotion |
| Live | All criteria | Featured on homepage, eligible for promotion |
| Featured | 5+ sellers, 100+ listings, 85%+ quality | Homepage hero slot |

---

## Phase 3 — Merchant Success Reviews

After each seller is approved, schedule a 7-day review:

**Day 7 checks:**
- Products viewed ≥ 10 times?
- Add-to-cart events ≥ 1?
- Any purchases?
- Images quality acceptable? (Check for blurry, dark, or watermarked photos)
- Descriptions readable and accurate?
- Any buyer complaints or refund requests?

**If performance is poor, identify the root cause:**
- Few views → category placement or search indexing issue
- Views but no cart adds → price or description problem
- Cart adds but no purchase → delivery fee or payment friction
- Purchases but returns → product description mismatch

**Generate recommendations** using the existing Store Completeness and Listing Quality scores. Do not create new features — use what is live.

---

## Phase 4 — Buyer Experience Review

### Daily Buyer Review (10 minutes)

Open SOKONI as a new buyer (incognito mode). Check:

**Homepage:**
- [ ] Featured products are real, high-quality, in-stock
- [ ] No empty category sections visible
- [ ] Hero stats show real numbers (hides when below thresholds)
- [ ] Search bar is prominent

**Search:**
- [ ] Search "groceries" — returns real products
- [ ] Search "phone" — returns relevant results
- [ ] Search a Swahili term — returns relevant results
- [ ] Check zero-result pages — do they suggest alternatives?

**Category browse:**
- [ ] Each featured category has ≥ 10 products visible
- [ ] Products have real images, prices, and descriptions
- [ ] No placeholder or test listings visible

**Product page:**
- [ ] Images load fast
- [ ] Description is readable on mobile
- [ ] "Add to Cart" works
- [ ] Seller information is visible
- [ ] Delivery info is clear

**Checkout:**
- [ ] Cart total is correct
- [ ] M-Pesa STK push triggers correctly
- [ ] Order confirmation email is received

**If anything feels incomplete or empty → content improvement first, not code change.**

---

## Phase 5 — Launch Dashboard

The **Launch Readiness dashboard** (`launch-readiness.html`) auto-tracks all 8 go-live criteria from live Firestore data.

### Criteria and Thresholds

| Criterion | Target | Blocker if missed? |
|-----------|--------|--------------------|
| Verified sellers | ≥ 25 | Yes |
| Live listings | ≥ 500 | Yes |
| Ready categories | ≥ 6 | Yes |
| Listing quality avg | ≥ 80% | Yes |
| Payment success rate | ≥ 90% | Yes |
| Search zero-result rate | ≤ 10% | No — improve over time |
| Critical bugs | 0 | Yes |
| Platform health | ≥ 80% | No — improve over time |

**Do not advance to marketing until all "Blocker" criteria are green.**

### Weekly Dashboard Review

Every Monday, check Launch Readiness dashboard with the team. Record the score in the weekly report. Track week-on-week progress.

---

## Phase 6 — First 30 Days Monitoring

### Daily Metrics (5-minute check)

Check the following each morning in the Ops Dashboard (`ops-dashboard.html`):

- New seller registrations (should be growing)
- New listings added (should be growing)
- Orders placed (track first purchase date)
- Payment success rate (alert if below 90%)
- Any Cloud Function errors in Firebase Console
- Any customer support messages (reply within 4 hours)

### Weekly Metrics

- New vs returning buyers
- Most searched terms (check for zero-result patterns)
- Most viewed categories
- Conversion funnel: views → cart adds → purchases
- Average order value
- Any repeat purchases (positive signal)
- Seller satisfaction (any complaints or dropouts?)

### 30-Day Review

At end of Day 30, produce a full report covering:

1. Total sellers, listings, categories live
2. Total orders, GMV, payment success rate
3. Top-performing categories and sellers
4. Zero-result search terms (each one is a gap to fill)
5. Buyer drop-off points in checkout
6. Platform health score trend
7. Any incidents (outages, payment failures, fraud)
8. Recommendation: Hold / Expand marketing / Scale infrastructure

---

## Phase 7 — Success Criteria for Marketing Expansion

Do not increase marketing spend until **all** of these are true:

| Condition | Status needed |
|-----------|--------------|
| Verified sellers | ≥ 25 |
| Quality listings | ≥ 500 |
| Healthy categories | ≥ 6 (≥ 3 sellers, ≥ 50 listings each) |
| Payment success rate | ≥ 95% |
| Critical bugs in production | 0 |
| Merchant satisfaction | No active complaints in last 7 days |
| Platform health score | ≥ 80% |

When all conditions are met, advance to Phase 1 of the Growth Playbook:
- Social media launch campaign
- Referral program activation
- First paid promotions (Google, Facebook, Instagram)
- Press/media outreach

---

## Weekly Operations Report Template

Use this template every Monday. File at `docs/ops-reports/WEEK_N_REPORT.md`.

```
# SOKONI Weekly Operations Report — Week N (YYYY-MM-DD)

## Headline Numbers
- Verified sellers: X / 25
- Live listings: X / 500
- Ready categories: X / 6
- Launch readiness score: X%
- Orders this week: X
- GMV this week: KES X

## Seller Onboarding Progress
- Applications received: X
- Approved this week: X
- Pending review: X
- Sent back for changes: X

## Category Readiness
| Category | Sellers | Listings | Quality | Status |
|----------|---------|----------|---------|--------|
| Grocery  | 0       | 0        | —       | ❌ Not ready |
| Fashion  | 0       | 0        | —       | ❌ Not ready |
| ...      |         |          |         |        |

## Buyer Experience Observations
(3–5 bullet points from daily buyer reviews)

## Platform Health
- Payment success rate: X%
- Zero-result search rate: X%
- Cloud Function errors: X
- Platform health score: X%

## Operational Risks
(Ranked list of top risks)

## Highest-Priority Action This Week
(Single most important action that will most advance the launch goal)
```

---

## Escalation Protocol

| Event | Action | Escalate to |
|-------|--------|-------------|
| Payment failure rate > 10% | Alert immediately; check IntaSend status | Founder |
| Cloud Function errors > 20/hour | Check Firebase Console for root cause | Engineering |
| Buyer complaint about fraud | Suspend seller immediately; investigate | Founder |
| Seller profile contains fake products | Remove listings; send warning; second offence = ban | Admin |
| Platform health score drops below 70% | Halt marketing; diagnose; fix | Engineering |
| Critical bug in checkout | Activate maintenance mode if needed; hotfix | Engineering |

---

## Key Admin Tools

| Tool | URL | Purpose |
|------|-----|---------|
| Merchant Pipeline | `merchant-pipeline.html` | Track all sellers through onboarding |
| Launch Readiness | `launch-readiness.html` | 8-criteria go-live dashboard |
| Platform Health | `platform-health.html` | 5-dimension health scores |
| Ops Dashboard | `ops-dashboard.html` | Daily operational metrics |
| Reliability Center | `reliability-center.html` | Infrastructure monitoring |
| Businesses Directory | `businesses.html` | Browse all registered businesses |
| Admin Portal | `admin.html` | RBAC management, moderation, verification |

---

## Quality Standards Summary

**SOKONI is a quality marketplace, not a quantity marketplace.**

We would rather launch with 25 excellent stores than 100 mediocre ones.

Every seller who is live on SOKONI is a statement about our standards.

Every listing with a blurry photo or a vague description makes a buyer less likely to trust the next seller.

Enforce standards completely. Approve nothing below 80% completeness.

The buyer's first experience defines whether they return.

---

*Phase 0 Operations Playbook — SOKONI v1.0 — 2026-06-25*  
*Related: [[launch-readiness]] [[merchant-pipeline]] [[CATEGORY_READINESS]] [[ANCHOR_SELLER_PROGRAM]]*
