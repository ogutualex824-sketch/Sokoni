# Marketplace Quality Standards

**Phase:** Phase 0 — Market Activation  
**Purpose:** Define what makes a good listing; used by quality scanners and ops team  
**Target:** Average listing quality score ≥ 80 across all active listings

---

## Why Quality Matters

A low-quality marketplace trains buyers to expect low quality. One bad experience (blurry photo, wrong category, misleading description) is enough for a buyer to never return.

Quality is not optional. It is the product.

---

## Listing Quality Score (0–100)

Each listing is scored automatically by the Marketplace Quality Scanner (Cloud Function: `runMarketplaceQualityScan`).

### Scoring Breakdown

| Dimension | Points | Criteria |
|-----------|--------|----------|
| Photos | 30 | Has photo (10), multiple photos (10), not blurry/placeholder (10) |
| Title | 20 | Descriptive (10), not ALL CAPS (5), not too short (<10 chars = 0) (5) |
| Description | 20 | Present (10), ≥50 words (5), no placeholder text (5) |
| Price | 15 | Price set and > 0 (15) |
| Category | 10 | Category and subcategory both set (10) |
| Stock | 5 | Stock quantity > 0 (5) |

**Total: 100 points**

---

## Acceptable Listing (Score ≥ 80)

A listing scoring 80+ must have:
- At least 1 clear, relevant photo
- A title with the product name and a key attribute (brand, size, material, model)
- A description of at least 50 words
- A correct price
- The correct category

---

## Common Quality Issues and Fixes

### Blurry Images
**Problem:** Product photo is out of focus, has shadows, or is a screenshot from WhatsApp  
**Fix:** Seller must retake photo in natural light, on a clean background. Phone cameras are fine — execution matters.  
**Admin action:** Flag listing; send seller a photo guide

### Duplicate Listings
**Problem:** Same product listed 3, 5, 10 times with slightly different titles to game search  
**Fix:** Merge into one listing with variants (colour, size)  
**Admin action:** Remove duplicates; warn seller; strike on repeat

### Missing Description
**Problem:** Description is blank, or just "good product", or copy-pasted from WhatsApp  
**Fix:** Seller must write a real description. Min 50 words.  
**Admin action:** Unpublish listing until fixed

### Missing Price
**Problem:** Price is 0, blank, or "contact for price"  
**Fix:** All prices must be set before a listing is active  
**Admin action:** Auto-unpublish listings with price = 0

### Wrong Category
**Problem:** Electronics listed under Fashion; Cars listed under Services  
**Fix:** Move listing to correct category. Edit subcategory.  
**Admin action:** Correct and notify seller

### Misleading Title
**Problem:** "iPhone 15 Pro Max" for a phone case; "Brand New" for a clearly used item  
**Fix:** Correct title; warn seller  
**Admin action:** Strike + 7-day review period

### Inactive Store
**Problem:** Store has not had any activity (no login, no order updates) for 30 days  
**Fix:** Contact seller; if no response in 7 days, mark store as inactive  
**Admin action:** Hide store from search; send WhatsApp message

---

## Strike System

| Strike | Action |
|--------|--------|
| 1st strike | Warning message via platform notification |
| 2nd strike | 7-day suspension of that listing |
| 3rd strike | 30-day store suspension |
| 4th strike | Permanent account review by operations |

Strikes reset after 90 days of good behaviour.

---

## Auto-Flagging Rules

The quality scanner runs daily and flags listings that:

| Condition | Flag |
|-----------|------|
| Score < 50 | 🔴 Low Quality — unpublished |
| Score 50–79 | 🟡 Needs Improvement — visible but not featured |
| No update in 60 days | ⏸️ Stale — reviewed for accuracy |
| Price unchanged for 180 days | 📋 Price Review — prompted to confirm |
| 0 views in 30 days | 📉 No Traction — seller notified with tips |

---

## Category-Specific Rules

### Food & Groceries
- No food listings without photos of the actual product
- Expiry dates must be visible or stated
- Weight/volume must be stated
- "Home-cooked" food must comply with county health rules

### Healthcare & Medicines
- No prescription drug listings without a licensed pharmacy profile
- No diagnostic or treatment claims in descriptions
- No "herbal cures for [disease name]" listings
- Practitioners must have their qualifications in their profile

### Electronics
- "New" must mean sealed in original packaging
- "Refurbished" must state who refurbished it and what warranty applies
- "Used" must honestly state any defects

### Fashion
- No altered/misleading photos (filters that change colour are flagged)
- Size must be stated — if seller uses non-standard sizing, a measurement guide is required

---

## Prohibited Items (Zero Tolerance)

Items that result in immediate removal and account review:

- Counterfeit goods (fake Apple, Nike, Louis Vuitton etc.)
- Prescription medication without pharmacy licence
- Weapons (including unlicensed knives marketed as weapons)
- Wildlife products
- Stolen goods (any listing that appears to be from theft)
- Adult content
- MLM recruitment listings disguised as product listings

---

## Links

- [[ANCHOR_SELLER_PROGRAM]] — seller recruitment
- [[MERCHANT_ONBOARDING_CHECKLIST]] — per-seller verification
- [[CATEGORY_LAUNCH_TARGETS]] — how many listings per category
- [[SOFT_LAUNCH_CRITERIA]] — overall quality threshold before advertising
