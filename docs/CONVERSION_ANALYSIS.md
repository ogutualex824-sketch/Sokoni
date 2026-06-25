# SOKONI Conversion Analysis — v1.2

**Date:** 2026-06-25  
**Scope:** Full buyer journey from Homepage to Successful Payment

---

## 1. The Complete Funnel

| Step | Event | Tracking | Status |
|------|-------|----------|--------|
| Homepage load | — | Implicit (pageview) | Passive |
| Product discovered | `search` / `click` | `algolia-analytics.js` | ✅ Active |
| Product viewed | `recordProductView` | `product-analytics.js` | ✅ Active |
| Add to Cart | `addToCart` | `category.js` → `recordFunnelEvent` | ✅ Wired v1.1 |
| Checkout Started | `checkoutStarted` | `checkout.html` → `recordFunnelEvent` | ✅ Wired v1.1 |
| Payment Attempted | `paymentAttempted` | `checkout.html` → `recordFunnelEvent` | ✅ Wired v1.2 |
| Payment Success | Order `status=paid` | `orders` Firestore collection | ✅ Native |

All four measurable funnel steps are now instrumented. The `getFunnelMetrics` CF aggregates them daily.

---

## 2. Identified Drop-Off Points

### Drop-off 1: Homepage → Product View (Discovery)
**Hypothesis:** Buyers who arrive on the homepage do not immediately find relevant products.

**Evidence signals to watch:**
- Algolia search CTR (target: ≥40%)
- Homepage bounce rate via `recordProductView` call count vs session count
- Zero-result search terms (now tracked in `searchQueryLog`)

**Recommended action:**
- Surface trending and recently added products on homepage
- Improve category navigation — ensure top 6 categories are visible without scrolling
- A/B test: featured product banner vs category grid as first above-fold element

---

### Drop-off 2: Product View → Add to Cart (Persuasion)
**Hypothesis:** Buyers viewing products are not converting because of trust gaps or missing information.

**Evidence signals to watch:**
- Per-product: `viewsTotal` high, `salesTotal` = 0 → listing quality issue
- `getListingQualityReport` results: avg quality score below 70 = systemic problem
- `no_results` search events followed by quick session exit

**Recommended action:**
- Run `getListingQualityReport` for all active sellers; contact sellers whose avg score < 50
- Enforce minimum photo requirement (1 photo) for new listings
- Add "you may also like" product row to increase session depth
- Verify trust badges (✅ KEPS cert, seller rating) are visible above the fold on product page

---

### Drop-off 3: Add to Cart → Checkout Started (Friction)
**Hypothesis:** Cart to checkout is a significant drop-off because buyers add items speculatively.

**Benchmark target:** Cart → Checkout ≥ 60%

**Recommended action:**
- Add cart abandonment recovery: email reminder after 24h (requires `emailOnCartAbandoned` trigger — Phase 2 of v1.2 if data shows this is a top drop-off)
- Reduce steps from cart to checkout: current flow requires navigating to cart.html → checkout.html; consider inline mini-cart with direct checkout CTA
- Show delivery estimate on cart page (reduces uncertainty)

---

### Drop-off 4: Checkout Started → Payment Attempted (Completion)
**Hypothesis:** Mandatory form fields (name, phone, address) cause abandonment if geolocation fails or form is frustrating.

**Benchmark target:** Checkout → Payment ≥ 75%

**Evidence signals to watch:**
- `checkoutStarted` vs `paymentAttempted` count delta from `getFunnelMetrics`
- CSP violations during checkout (could break payment modals)
- M-Pesa STK push timeout rate from `sokoni-mpesa.js`

**Recommended action:**
- Pre-fill name/phone from user profile for authenticated users
- Make address field optional (use GPS location as default)
- Show clear STK push instructions above the confirm button
- Add a "test with KES 1" flow for first-time buyers (trust-building)

---

### Drop-off 5: Payment Attempted → Successful Payment
**Benchmark target:** Payment success ≥ 90%

**Evidence signals to watch:**
- `orders.status = failed` vs `status = paid` ratio (from `scheduledDailyOpsReport`)
- IntaSend error codes in function logs
- M-Pesa STK push "timeout" vs "cancelled" vs "insufficient funds" error breakdown

**Recommended action:**
- Add retry prompt with clear message on payment failure
- Display M-Pesa balance insufficiency message (if returned by API) instead of generic error
- Add card payment as explicit fallback when M-Pesa fails

---

## 3. Page Performance Issues

**Slow pages to investigate (no load-time data yet — pending instrumentation):**
- `checkout.html` — loads many deferred scripts; measure Time to Interactive
- `store.html` — product grid with images; check Largest Contentful Paint
- `product.html` — should be fast but verify trust panel CF call latency

**Recommended instrumentation:**
Add `performance.mark` calls at key render points and report via `SokoniObservability`.

---

## 4. Conversion Benchmarks

| Metric | Industry Avg | SOKONI Target | Track From |
|--------|-------------|--------------|------------|
| Add to Cart rate (visitors) | 3–8% | 5% | `getFunnelMetrics` |
| Cart → Checkout | 25–40% | 60% | `getFunnelMetrics` |
| Checkout → Paid | 55–75% | 75% | `getFunnelMetrics` |
| Overall visitor → purchase | 1–4% | 3% | Cross-reference analytics |
| Payment success | 85–95% | 90% | `scheduledDailyOpsReport` |

These benchmarks are e-commerce industry averages. SOKONI targets are set conservatively for a new platform.

---

## 5. Data Availability Timeline

| Data point | Available from | Baseline established |
|------------|---------------|---------------------|
| Cart events | v1.1 (Jun 2025) | ~3 weeks after launch |
| Checkout events | v1.1 | ~3 weeks |
| Payment attempts | v1.2 (now) | ~3 weeks |
| Product views | v1.0 | Available now |
| Search events | v1.0 (Algolia) | Available now |

**First conversion report:** run `getFunnelMetrics({ days: 30 })` after 3 weeks of live traffic.

---

## 6. Quick Wins (Implement in v1.2)

| Action | Effort | Impact |
|--------|--------|--------|
| Pre-fill checkout form from profile | Low | Reduces drop-off 4 |
| Enforce minimum 1 photo for new listings | Low | Reduces drop-off 2 |
| Add recently viewed strip on store page | Low (sokoni-retention.js) | Increases session depth |
| Email sellers with quality score < 50 | Low | Reduces drop-off 2 |
| Add delivery estimate to cart page | Medium | Reduces drop-off 3 |
