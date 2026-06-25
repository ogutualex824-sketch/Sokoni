# Anchor Seller Program

**Phase:** Phase 0 — Market Activation  
**Goal:** Recruit 25–50 anchor sellers before public marketing  
**Owner:** Marketplace Operations  
**Status:** Active

---

## Objective

Build the supply side of the marketplace before driving buyer traffic.

A marketplace with empty shelves cannot convert buyers. The anchor seller program ensures every major category has real, high-quality inventory before advertising begins.

---

## Target

| Metric | Minimum | Target |
|--------|---------|--------|
| Active sellers onboarded | 25 | 50 |
| Products per seller | 20 | 40+ |
| Categories with meaningful inventory | 8 | 11 |
| Average listing quality score | 75 | 90+ |
| Sellers with verified stores | 80% | 100% |

---

## Recruitment Approach

### Priority Sources

1. **WhatsApp seller groups** — Nairobi business groups, Jua Kali, electronics traders
2. **Facebook Marketplace** — active sellers already posting products
3. **Instagram business accounts** — fashion, beauty, food sellers in Kenya
4. **Physical markets** — Gikomba, Toi Market, Ngara, Moi Avenue, Westlands
5. **Personal network** — founders, investors, friends who sell anything
6. **Referrals** — every onboarded seller gets a referral incentive

### Incentive Structure

| Action | Incentive |
|--------|-----------|
| Complete onboarding (100% score) | 90 days zero commission |
| First 10 anchor sellers | 180 days zero commission |
| Refer another seller who completes onboarding | 30 additional commission-free days |
| Achieve 5-star rating in first 30 days | SOKONI Verified badge |

Zero commission removes the main objection for early sellers.

---

## Onboarding Flow

### Step 1 — Outreach
- Introduce SOKONI and the anchor seller opportunity
- Emphasise: free to list, zero commission for 90 days, Kenya-specific
- Send the seller registration link: `/seller.html`

### Step 2 — Guided Setup
- Walk through the store setup wizard (5 steps)
- Ensure they complete all 7 readiness checks (Store Completeness Score = 100%)

### Step 3 — Product Upload
- Minimum 20 products before the store is considered live
- Each product must have:
  - [ ] Clear, well-lit photo (minimum 1, ideally 3+)
  - [ ] Accurate title (include brand, size, key specs)
  - [ ] Full description (min 50 words)
  - [ ] Correct category and subcategory
  - [ ] Price in KES
  - [ ] Stock quantity
  - [ ] Delivery option selected

### Step 4 — Quality Review
- Operations team reviews each new store before marking it live
- Use the Marketplace Quality Scanner in Admin to flag issues
- Reject incomplete stores and give specific feedback

### Step 5 — Activation
- Mark store as `verified: true` in Firestore
- Send welcome WhatsApp message with their store link
- Add to the anchor seller tracking sheet

---

## Seller Store Requirements

Every anchor seller must complete all 7 before going live:

| # | Requirement | Why |
|---|-------------|-----|
| 1 | Business logo (PNG/JPG, min 200×200px) | Builds trust; blank logo = amateur |
| 2 | Store banner (min 1200×400px) | First impression on store page |
| 3 | Business description (min 50 words) | SEO + buyer confidence |
| 4 | At least 20 products | Category coverage; buyer needs choice |
| 5 | Payment details (M-Pesa or bank) | Orders cannot complete without this |
| 6 | Delivery settings | Buyers need to know how they receive goods |
| 7 | Identity verified | Platform integrity; reduces fraud |

---

## Tracking

Use the weekly activation report to track:
- Sellers in outreach (contacted, not yet registered)
- Sellers registered (account created, setup incomplete)
- Sellers active (100% completeness, at least 20 products)
- Sellers live (verified, visible to buyers)

---

## Do Not Onboard

Reject or pause any seller who:
- Sells prohibited items (counterfeit goods, unlicensed medicines, weapons)
- Cannot provide a real business location
- Cannot be reached via phone or WhatsApp within 48 hours
- Has less than 10 products after 7 days of reminders

A marketplace with bad sellers is worse than a marketplace with few sellers.

---

## Links

- [[CATEGORY_LAUNCH_TARGETS]] — minimum inventory per category
- [[MERCHANT_ONBOARDING_CHECKLIST]] — step-by-step seller setup
- [[MARKETPLACE_QUALITY_STANDARDS]] — listing quality criteria
- [[SOFT_LAUNCH_CRITERIA]] — go/no-go thresholds before advertising
