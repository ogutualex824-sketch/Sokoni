# Merchant Onboarding Checklist

**Phase:** Phase 0 — Market Activation  
**Use:** Operations team uses this to review every new seller before marking them live  
**Version:** 1.0

---

## Overview

Every seller must complete all 7 required steps before appearing in search results or category pages.

The Store Completeness Score in the seller dashboard tracks this automatically. Operations team performs a final human review before marking a store verified.

---

## Required Checklist (7 items — 100 points total)

### 1. Business Logo (15 points)
- [ ] Logo uploaded (PNG or JPG)
- [ ] Minimum size: 200 × 200px
- [ ] Clear background or solid colour preferred
- [ ] Not a blurry screenshot
- [ ] Represents the actual business (not a stock image)

**How to verify:** Go to Admin → Businesses → [seller] → View Store → check logo display

---

### 2. Store Cover Banner (10 points)
- [ ] Banner image uploaded
- [ ] Minimum width: 1200px (wider is better)
- [ ] Not stretched or pixelated
- [ ] Shows what the store sells (not just a generic coloured rectangle)

**How to verify:** Visit the seller's store page

---

### 3. Business Description (15 points)
- [ ] Description written (minimum 50 words)
- [ ] States what they sell
- [ ] States their location (county / area)
- [ ] States operating hours if relevant
- [ ] Free of spelling errors and ALL CAPS abuse

**How to verify:** Admin → Businesses → [seller] → Description field

---

### 4. Minimum 20 Products (25 points)
- [ ] At least 20 active product listings
- [ ] All with prices
- [ ] All with at least 1 photo
- [ ] Products in the correct categories
- [ ] Titles are descriptive (not "item 1", "item 2")

**How to verify:** Admin → Businesses → [seller] → Products tab → count active listings

---

### 5. Payment Details Configured (15 points)
- [ ] M-Pesa number entered (primary method for most sellers)
- [ ] OR bank account details added
- [ ] Phone number verified and working

**How to verify:** Admin → Businesses → [seller] → Payment settings. Do not approve a store without this — orders cannot complete.

---

### 6. Delivery Settings Configured (10 points)
- [ ] At least one delivery option selected
- [ ] Delivery fee stated OR "Buyer arranges" selected
- [ ] Estimated delivery time stated
- [ ] Coverage area specified (Nairobi only? Nationwide? Specific counties?)

**How to verify:** Admin → Businesses → [seller] → Delivery settings tab

---

### 7. Store Identity Verified (10 points)
- [ ] Seller has been contacted by phone or WhatsApp
- [ ] Real name confirmed
- [ ] Business location confirmed
- [ ] Seller has been briefed on platform rules
- [ ] No prohibited items found in initial product review

**How to verify:** Operations team direct contact. Mark `verified: true` in Firestore only after direct confirmation.

---

## Rejection Criteria

Do not approve a store if any of the following are true:

| Issue | Action |
|-------|--------|
| No logo | Send back with specific instructions |
| Less than 10 products after 14 days | Pause and contact seller |
| Blurry or watermarked product photos | Reject specific products; request replacements |
| No payment method | Store cannot go live; contact seller |
| Description is just a phone number | Send back with instructions |
| Seller unreachable for 7 days | Mark as dormant; do not activate |
| Prohibited items found | Remove items; issue formal warning; strike system |

---

## Completion Score Bands

| Score | Status | Action |
|-------|--------|--------|
| 100% | Store Ready | Human review → activate |
| 85–99% | Nearly Complete | Contact seller with specific missing items |
| 60–84% | In Progress | Follow up weekly |
| Below 60% | Incomplete | Follow up; offer onboarding call |

---

## Post-Activation Actions

After marking a store live:
- [ ] Send welcome WhatsApp: "Your store is now live on SOKONI! Share this link with your customers: [store URL]"
- [ ] Add to anchor seller tracking sheet
- [ ] Schedule 7-day check-in (are their products selling? Any issues?)
- [ ] Add them to the seller WhatsApp support group
- [ ] Record onboarding date for commission-free period tracking

---

## Links

- [[ANCHOR_SELLER_PROGRAM]] — recruitment and incentives
- [[MARKETPLACE_QUALITY_STANDARDS]] — listing quality standards
- [[CATEGORY_LAUNCH_TARGETS]] — category inventory goals
