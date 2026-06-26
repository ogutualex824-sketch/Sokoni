# SOKONI Merchant Outreach Materials — Week 1

**Goal:** First approved merchant live with ≥20 quality listings within 7 days.  
**Method:** Warm outreach first. Cold outreach second. Never pitch before understanding their current selling problem.

---

## WHO TO APPROACH FIRST

Do not start with cold outreach. Start with people you already know who sell anything.

**Tier 1 — Warm (approach today):**
- Business owners in your phone contacts
- WhatsApp group members who post products for sale
- Instagram accounts you personally follow that sell goods
- Friends or family who run any kind of trading business

**Tier 2 — Semi-warm (approach this week):**
- Businesses you've bought from personally in Nairobi
- Market stall owners in CBD, Westlands, Kilimani, Karen, Ngong Road
- Facebook Marketplace sellers with consistent posting history
- Jiji.co.ke sellers with multiple active listings (approach them directly)

**Tier 3 — Cold (Week 2+):**
- Walk-in outreach to physical shops
- Business WhatsApp groups
- Instagram hashtag prospecting (#NairobiShopping, #KenyaMade, #NairobiSeller)

---

## TARGET CATEGORIES — WEEK 1

Fill these 3 categories first. They have the most local supply and highest buyer demand:

1. **Fashion & Clothing** — easiest to photograph, high listing volume possible
2. **Beauty & Personal Care** — strong seller community on Instagram already
3. **Electronics & Phones** — high intent buyers, lots of local resellers

---

## OUTREACH MESSAGES

### WhatsApp Message — Warm Contact (Kenyan English)

> Hi [Name]! 👋
>
> I saw you're selling [product/category] — your stuff looks great.
>
> I'm building a marketplace called SOKONI and we're looking for quality sellers to be among the first on the platform before we open to the public.
>
> It's free to join. You get your own online store, your customers pay via M-Pesa, and people searching for [product] on SOKONI will find you directly.
>
> Would you be open to a quick 15-minute call this week? I'll set up your store for free and show you how it works.

---

### WhatsApp Message — Semi-Warm (Bought From Them Before)

> Hi [Name]! 👋
>
> I bought [product] from you a while back — really good quality.
>
> I'm working on a marketplace platform called SOKONI and we're inviting a small number of quality sellers to be founding merchants before we go public.
>
> Free storefront. M-Pesa payments built in. Customers find you by searching, no WhatsApp catalogue needed.
>
> Happy to set everything up for you — takes about 30 minutes. Would that interest you?

---

### Instagram DM — To Sellers You've Spotted

> Hi! I came across your page and your [products] look really quality.
>
> I'm building a marketplace called SOKONI — we're a Kenyan platform focused on connecting real local businesses with buyers. M-Pesa payments, your own storefront, customers find you on search.
>
> We're onboarding a small group of founding sellers before the public launch. It's free and I'll personally help you set up your store.
>
> Would you be open to a quick call? 🙏

---

### SMS / Text — When You Have Their Number But No WhatsApp

> Hi [Name], this is [Your Name]. I'd like to invite you to be one of the first sellers on SOKONI, a new Kenyan online marketplace. Free storefront, M-Pesa payments. Happy to set it up for you. Can we talk this week?

---

## THE PITCH CALL — WHAT TO SAY

**Duration:** 15 minutes max. Do not oversell. Let the platform speak.

**Opening (2 minutes):**
- "How do you currently sell? WhatsApp? Instagram? Both?"
- "What's the main challenge — getting new customers, managing orders, payments?"

**The pitch (3 minutes):**
- "SOKONI is a marketplace where Kenyan buyers search for products like yours. You get your own store page, they pay you via M-Pesa, and you manage orders from one place."
- "We're bringing on founding merchants before the public launch — so you'll be visible early when there's less competition."
- "It's completely free to join."

**The demo (5 minutes):**
- Open sokoni.co.ke on your phone
- Show the category they sell in
- Open a live seller's store page if available (or merchant-pipeline to show the setup)
- Show the checkout flow — "buyers pay via M-Pesa STK push, money goes straight to you"

**The close (5 minutes):**
- "I can set up your store right now on this call — takes 20–30 minutes."
- OR "Let me send you the link to register and I'll help you through it this afternoon."
- Get their commitment to a specific time, not a vague "I'll check it out."

---

## ONBOARDING WALKTHROUGH — FOR EACH SELLER

Use this checklist during or after the call:

### Step 1 — Account Creation
- [ ] Go to `sokoni.co.ke/seller.html`
- [ ] Create account with their phone number (Firebase Auth)
- [ ] Confirm email if prompted

### Step 2 — Business Profile
- [ ] Business name (real trading name)
- [ ] Category (choose the correct one)
- [ ] Description — at least 2 sentences about what they sell (help them write it)
- [ ] Phone number (their M-Pesa number)

### Step 3 — Logo & Banner
- [ ] Logo: square, clean background, at least 200×200px
   - If they have a WhatsApp profile photo, that works as a starting point
   - If not, take a square photo of their signage or product
- [ ] Banner: wide photo, 1200×400px — a flat lay of their products works

### Step 4 — Payment
- [ ] M-Pesa number configured in payment settings
- [ ] Walk them through the test checkout flow

### Step 5 — Delivery
- [ ] Delivery area (Nairobi only at first — or Kenya-wide if they can manage it)
- [ ] Delivery fee (suggest KES 150–250 for CBD, KES 300–400 for outskirts)
- [ ] Lead time (same day / next day / 2–3 days)

### Step 6 — Products (minimum 20)
- [ ] Help them list their first 5 products on the call
- [ ] Real product name (not "Product 1")
- [ ] Real price matching what they charge on WhatsApp
- [ ] 1–3 clear photos per product (natural light, clean background preferred)
- [ ] Description: what it is, size/variant, why a buyer would want it
- [ ] Correct category
- [ ] Accurate stock quantity

### Step 7 — Review
- [ ] Check Store Completeness Score in merchant-pipeline.html
- [ ] Score ≥80% → Approve
- [ ] Score <80% → Send specific feedback on what's missing

---

## AFTER APPROVAL — SELLER ACTIVATION MESSAGE

Send this to every approved seller:

> Congratulations! 🎉
>
> Your store is now live on SOKONI.
>
> Here's your store link: sokoni.co.ke/seller.html?uid=[their_uid]
>
> Share this with your WhatsApp contacts and on Instagram — tell them you're now on SOKONI and they can order directly and pay via M-Pesa.
>
> Keep adding products whenever you have new stock. The more listings you have, the more buyers find you.
>
> If you need anything, message me directly. We want your first order to happen this week. 💪

---

## WEEK 1 DAILY SCHEDULE

| Day | Action |
|-----|--------|
| Mon | Contact 10 warm prospects. Target 3 call bookings. |
| Tue | Run 3 calls. Aim to start at least 2 onboarding sessions. |
| Wed | Complete onboarding for 2 sellers. Help them reach 20 listings. |
| Thu | Review stores on merchant-pipeline.html. Approve qualifying stores. Request changes from others. |
| Fri | Follow up with sellers who need changes. Begin cold outreach for Week 2 pipeline. |
| Weekend | Check platform daily. Fix any issues merchants report. |

---

## HANDLING OBJECTIONS

**"I'm already selling fine on WhatsApp / Instagram."**
> "That's exactly the problem we solve — your current customers already know you. SOKONI gets you in front of new buyers who are searching for what you sell right now and have no idea you exist."

**"How much does it cost?"**
> "It's free to list. We take a small commission only when you make a sale — so we only make money when you make money."

**"What if I don't know how to use it?"**
> "I'll set it up with you right now. 30 minutes and your store is live."

**"I'm busy, let me check it later."**
> "Completely fine. Can we book 30 minutes specifically for Thursday or Friday? I'll call you and we'll do it together."

**"I don't trust online payments."**
> "The payment goes directly to your M-Pesa. SOKONI never holds your money. The buyer pays, M-Pesa confirms, order is placed, you deliver."

---

*SOKONI Merchant Outreach Materials — v1.0 — 2026-06-25*
