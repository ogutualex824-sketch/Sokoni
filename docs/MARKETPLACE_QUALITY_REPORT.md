# SOKONI Marketplace Quality Report — v1.2

**Date:** 2026-06-25  
**CF:** `getMarketplaceQualityReport` (admin callable)

---

## 1. Quality Framework

Marketplace quality is tracked on 7 dimensions:

| Dimension | Detection Method | Impact |
|-----------|-----------------|--------|
| Missing product photos | `images.length === 0` | Reduces CTR by ~75% |
| Missing descriptions | `description === ""` | Reduces conversion |
| Potential duplicates | Same seller + same title | Wastes catalogue space |
| Outdated listings | Listed >30d, no views in 60d | Hurts search freshness |
| Category price outliers | IQR-based anomaly detection | Confuses buyers |
| Abandoned listings | Active but no recent activity | Unfulfillable orders |
| Missing titles | `name === ""` | Prevents indexing |

---

## 2. Overall Health Score Interpretation

| Score | Rating | Action |
|-------|--------|--------|
| 90–100 | Excellent | Monitor weekly |
| 75–89  | Good | Fix outliers, email sellers |
| 60–74  | Needs attention | Active seller outreach |
| < 60   | Poor | Enforce minimum quality standards |

Run `getMarketplaceQualityReport` weekly via the admin console. Target: ≥ 80 within 60 days of launch.

---

## 3. Issue Resolution Playbook

### Missing Photos
**Trigger:** `issues.missingImages.count > 0`  
**Action:**
1. Email each affected seller using `sendBroadcastEmail` with personalised listing link
2. Message: "Your listing '[product name]' has no photo and is receiving very few views. Add a photo to appear in search results."
3. If no photo added in 7 days → de-list automatically (future: `qualityFlag = "no_photo"`)

### Missing Descriptions
**Trigger:** `issues.missingDescriptions.count > 0`  
**Action:**
1. Same email flow as photos
2. Provide a description prompt: "Describe the colour, size, condition, and key features"

### Potential Duplicates
**Trigger:** `issues.potentialDuplicates.count > 0`  
**Action:**
1. Flag for manual review by moderation team
2. Contact seller: "We noticed you may have listed this item more than once"
3. Keep the higher-quality listing, archive duplicates

### Outdated Listings
**Trigger:** `issues.outdatedListings.count > 0`  
**Action:**
1. Email seller: "Your listing hasn't been viewed in 60 days — refresh it or re-list to improve visibility"
2. Auto-archive after 90 days with no views (implement in v1.3)

### Category Price Outliers
**Trigger:** `issues.categoryOutliers.count > 0`  
**Action:**
1. Flag for admin review
2. Contact seller with pricing guidance: "Products in this category are typically priced KES X–Y. Your listing is priced significantly outside this range."
3. Use `flagLowQualityListing` CF to mark for review

### Abandoned Listings
**Trigger:** `issues.abandonedListings.count > 0`  
**Action:**
1. Check if seller account is still active
2. Email seller: "You have active listings but we haven't seen any activity recently. Are you still selling on SOKONI?"
3. De-activate listings after 90 days of seller inactivity

---

## 4. Quality Enforcement Phases

### Phase 1 (Now — Soft enforcement)
- Run quality report weekly
- Email sellers with issues
- No automatic de-listing

### Phase 2 (v1.3 — After 30-day launch data)
- Minimum 1 photo required for new listings (enforce at upload)
- Minimum 20-character description required
- Auto-archive listings with zero views in 90 days

### Phase 3 (v1.4)
- Quality score visible to buyers ("Listing quality badge")
- Search ranking penalises listings with score < 40
- Seller dashboard shows quality score per listing

---

## 5. Seller Communication Templates

**Template: Missing Photo**
> Subject: Add a photo to your listing — [product name]  
> "Hi [seller name], your listing '[product name]' has no photo. Products without photos receive 75% fewer views on SOKONI. Add a clear photo now to start appearing in search results. [Edit listing →]"

**Template: Low Quality Score**
> Subject: Improve your listings for more sales  
> "Hi [seller name], we noticed some of your listings could be improved. Products with complete information (photos, descriptions, and accurate pricing) sell 3× faster. See what needs attention: [Seller Success Center →]"

---

## 6. Quality Metrics to Track Monthly

| Metric | Target |
|--------|--------|
| % listings with photos | ≥ 90% |
| % listings with description (>50 chars) | ≥ 85% |
| % listings with quality score ≥ 60 | ≥ 80% |
| Duplicate listings | < 2% |
| Outdated listings (>90d no views) | < 10% |
| Marketplace health score | ≥ 80 |
