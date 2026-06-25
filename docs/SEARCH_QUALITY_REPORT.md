# SOKONI Search Quality Report — v1.2

**Date:** 2026-06-25  
**Infrastructure:** Algolia (primary) + Typesense (secondary) + `searchQueryLog` (custom signals)

---

## 1. Current Search Architecture

| Layer | Purpose | Status |
|-------|---------|--------|
| Algolia (primary) | Full-text product search, relevance ranking, typo tolerance | ✅ Live |
| `sokoni-search-pro.js` | Frontend search orchestration, voice, Swahili NLP | ✅ Live |
| `algolia-analytics.js` | Event logging: search, click, conversion, no_results | ✅ Live |
| `getSearchInsights` CF | Aggregated analytics for admin — **new v1.2** | ✅ Deployed |
| `recordSearchQuery` CF | Lightweight custom search signal log | ✅ Deployed v1.2 |
| `getZeroResultTerms` CF | Quick no-result term list for merchandising | ✅ Deployed v1.2 |
| `searchQueryLog` collection | Daily aggregate of query signals | ✅ New v1.2 |

---

## 2. Known Zero-Result Categories

These are the most likely search patterns to return zero results on a new platform with limited catalogue depth. They should be monitored via `getZeroResultTerms` weekly.

**Predicted zero-result patterns:**
- Hyper-local searches: "bricks Kisumu", "maize Eldoret" — too location-specific
- Misspellings without Algolia synonyms: "fone" (phone), "jerikeni" (jerrycan), "suruali" (trousers)
- Service searches on a product-first platform: "electrician", "plumber" — redirect to services hub
- Very new categories not yet seeded: "AR glasses", "drone parts"

**Action:** After 2 weeks of live traffic, run `getZeroResultTerms` and set up Algolia synonyms for the top 20 terms. Cost: ~1 hour.

---

## 3. Search Relevance Signals

The existing Algolia setup should be configured to rank by:

| Signal | Weight | Source |
|--------|--------|--------|
| Product title match | High | Algolia `searchableAttributes` |
| Trending score | High | `productStats.trendingScore` synced by `algolia-sync.js` |
| Sales count | Medium | `productStats.salesTotal` |
| Photo count | Medium | `product.images.length` |
| Quality score | Medium | Computed by `getListingQualityReport` — add to Algolia object |
| Seller verification | Low-medium | `seller.isVerified` |
| Listing age | Low | Freshness boost for new listings (<14d) |

**Recommendation:** Wire `getListingQualityReport` score into the Algolia index object via `algolia-sync.js` so quality is a ranking signal. Low-quality listings surface lower.

---

## 4. Swahili and Kenyan Search Patterns

`sokoni-search-pro.js` includes Swahili NLP. Priority synonym mappings to confirm work correctly:

| Swahili | English |
|---------|---------|
| simu | phone, mobile |
| nguo | clothes, clothing |
| chakula | food, groceries |
| nyumba | house, property, home |
| gari | car, vehicle |
| dawa | medicine, healthcare |
| kazi | job, work, employment |
| pesa | money, payment |

**Testing:** Search each Swahili term post-launch and verify relevant results surface.

---

## 5. Popular Filter Usage (to track)

Expected high-use filters:
- Price range (KES 100–500, 500–2000, 2000–10000)
- Category
- Location / Nairobi county
- Condition (new / used)
- Verified sellers only

Track via `algolia-analytics.js` `filter_use` events. After 30 days, surface the top 3 filters prominently in the search UI.

---

## 6. High-Converting Search Patterns

These are hypotheses to validate with `getSearchInsights.topConverting` after 30d:
- Brand + product type: "Samsung phone" → high intent
- "Cheap [product]" → price-sensitive, high cart rate if listing is competitive
- Category browsing: "shoes", "clothes" → low convert, high volume
- Problem-solving: "water pump Nairobi" → high intent, service + product

---

## 7. Search Performance Targets

| Metric | Target | Track With |
|--------|--------|-----------|
| Zero-result rate | < 10% | `getSearchInsights.summary.noResultSearches` |
| Click-through rate | ≥ 35% | `getSearchInsights.summary.clickThroughRate` |
| Search-to-purchase rate | ≥ 5% | `getSearchInsights.summary.conversionRate` |
| Avg results per query | ≥ 8 | Algolia dashboard |
| Query response time | < 200ms | Algolia dashboard |

---

## 8. 30-Day Action Plan

| Week | Action |
|------|--------|
| 1 | Deploy `recordSearchQuery` — begin populating `searchQueryLog` |
| 2 | Run `getZeroResultTerms` — identify first batch of no-result queries |
| 3 | Add top 20 zero-result terms as Algolia synonyms |
| 4 | Review `getSearchInsights.topConverting` — promote best-converting categories |
| Ongoing | Weekly `getZeroResultTerms` review — add synonyms, seed missing categories |
