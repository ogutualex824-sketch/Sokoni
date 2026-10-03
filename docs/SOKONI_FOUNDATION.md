# SOKONI Foundation — public page and Banking Hub pane

> Status (2026-10-01): **hosting built, NOT deployed.** The callables the page depends on are mostly
> **not deployed** either. The page is written to degrade honestly until they are.
> Related: [[FINANCIAL_PARTNER_WORKSPACE]] · [[FINANCIAL_PARTNER_INTAKE]] · [[Payments]] · [[vol-13-foundation]]

## What the donor sees

`foundation.html` + `foundation.js` (no inline handlers, one delegated listener per section):

1. **Why it matters** — short copy. No impact numbers.
2. **Donation wizard** (`#donate`)
   - Step 1: amount, free entry, whole shillings, KES 10–100,000. A wrong amount is refused with a message;
     it is never clamped or replaced. Quick picks fill the box. `?amount=` pre-fills only when valid.
   - Step 2: programme (from `impactGetCampaigns`, `?programme=<id>` pre-selects it — this is what every
     "Support this work" button uses) and purpose. Copy: *"A purpose is your preference; Foundation funds are
     unrestricted unless a programme says otherwise."* No tax-deductibility claim.
   - Step 3: anonymous toggle; sign-in required (link to `login.html?redirect=…` keeps amount + programme).
   - Step 4: review, M-Pesa number → pledge → intent → STK push → "Confirming your payment…".
   - A "Continue your donation" button appears while the wizard is off-screen and in progress.
3. **Stories & testimonials** — `listPublished` (`donation_wizard`, 6 per page, cursor "Load more"). Images lazy,
   videos `preload="none"` with `poster`. "Read story" expands. Rows with `programmeId` get **Support this work**.
   Empty → "Share your SOKONI Foundation story". Failure → neutral "not available right now". No sample cards.
4. **Testimonial wizard** (`#share`) — signed-in; title, story, optional programme, display preference
   (full / first name / anonymous), town or county, up to 4 files (≤1 video). Explicit consent boxes: publish
   (required), show name, show photos/videos. **My stories** lists `listMine` with status words and a
   **Withdraw consent** button (confirm first).
5. **Transparency** — `impactGetPublicDashboard` balance under the label **"Foundation account — being
   reconciled"** (live figures include pre-fix unbacked checkout mints). Programmes show raised/goal.
   `recentActivity` is never rendered, so no donor identities appear. Failure → `—`.
6. **Partners & contact** — links to `banking.html#saccos`, `#accounts`, `#microfinance`, `#advisers`; `contact.html`.

## Donation flow and authorities

```
amount/programme/purpose ─► impactPledgeDonation({amount, requestId, programmeId?, purpose, anonymous})
                               │  requestId = crypto.randomUUID(), kept in sessionStorage keyed to the
                               │  exact details, so a retry reuses it (server: alreadyPledged, same pledgeId)
                               ▼  client stops if r.amount !== entered amount
                            createPaymentIntent({purpose:'donation', pledgeId}) ─► {ref:'DON_<pledgeId>', amount}
                               ▼  client stops if intent.amount !== pledge amount
                            SokoniIntaSend.initiateSTKPush(phone, intent.amount, intent.ref, {...})   (existing helper)
                               ▼
                            impactGetMyPledge({pledgeId}) every 3 s, at most 40 times (~2 min)
                               completed → "Thank you … Receipt <receiptId>"   (the ONLY success path)
                               review    → "We're checking this payment" (keeps polling)
                               failed    → retry offered; refunded → stated
                               timeout   → "We'll confirm shortly" + Check again
```

- The **server** decides amount, pledge state, receipt and totals. The client never says "thank you" before
  `status === 'completed'`.
- Storage: **no localStorage**. sessionStorage holds only `sk_foundation_donation_request` (`{sig, rid}`), cleared
  on completion or a failed payment.
- Payment reuse: the same `SokoniIntaSend.initiateSTKPush` used by `sokoni-book-service.js`. Its
  `waitForConfirmation` is **not** used — it writes a commission record; the pledge status is the authority here.

## Testimonial media

Uploaded **before** `submitTestimonial` to Firebase Storage `foundation-media/{uid}/{random}.{ext}` via
`window.SokoniUpload` (`sokoni-upload.js`): images compressed to WebP ≤1600 px; video uploaded as-is
(MP4/WebM/MOV ≤80 MB). If any upload fails: *"Photos/videos can't be uploaded right now — you can send your story
as text"* and a **Send my story as text** button. The server receives storage **paths**, not URLs.

## Banking Hub (`banking.html` + `banking-hub.js`)

- Category panes render `financialPartnerDispatch publicDirectory`, **lazily on first open**:

| Pane | Institution types |
|---|---|
| loans | BUSINESS_FINANCE, BANK, MICROFINANCE, DIGITAL_LENDER |
| accounts | BANK |
| saccos | SACCO |
| insurance | INSURER |
| investments | INVESTMENT, FINANCIAL_ADVISER |
| mpesa | PAYMENT_PROVIDER |
| forex | FOREX |
| microfinance | MICROFINANCE |
| chamas | CHAMA |
| digital | DIGITAL_LENDER |
| advisers (new) | ACCOUNTANT, FINANCIAL_ADVISER |
| foundation (new) | 3 latest `banking_hub` stories, Donate, Share your story |

- Card: name, type, services, county, https-only website (`rel="noopener noreferrer"`), fixed badge
  **"Listed by SOKONI"** (never verified / licensed / CBK-approved), **Promoted** only when `promoted === true`,
  DIGITAL_LENDER caution *"Check the lender's CBK licence before borrowing"*, **Contact** (`submitEnquiry`, signed-in,
  consent box) and **View profile** (`publicProfile`; registration shown as *self-declared — not checked by SOKONI*).
- Empty: *"No <category> listed yet — Are you a <category>? Apply to be listed"* →
  `business-apply.html?offer=financial&category=<TYPE>`. Failure: *"The directory isn't available right now"*.
- Removed: `sokoni-banking-pro.js` is no longer loaded (file kept; still listed in the service-worker precache).
  Its wallet/dashboard/BNPL/merchant/invoices/payments/notifications/admin panes, tiles and bell rendered
  localStorage figures. Honest tiles now link to `wallet.html` (wallet and payment history — it has no hash
  route), `financial-os.html`, and the loans pane for merchant finance.
- USSD banner kept, labelled **"External — dial from your phone"**. Deep links: `banking.html#saccos` etc.

## 2026-10-03 updates (NOT deployed)

- **Transparency is verified-only.** "Verified donations received" = `balance.verified`, "Verified donations
  available" = `balance.available` (verified − reserved). `requiresReconciliation` appears only as "Still being
  reconciled: KES n (not counted as received)" when > 0. An answer without a numeric `verified` (the older,
  mixed shape) renders `—` and shows the "being reconciled" badge; `totalReceived` is never shown publicly.
- **Story media:** `contentType` `video/mp4` → `<video preload="none" poster=thumbUrl>`; images `<img loading=lazy>`.
- **Checkout donation is a separate payment.** checkout.html no longer adds the donation to the order total (the
  server-quoted total had silently replaced it — buyers were shown a donation they were never charged for).
  `impactCheckoutDonate` now records a pledge `CHK_<orderId>`; only when it answers `ok` + `status:'pledged'`
  does the success overlay show "Complete your KES n donation" → `foundation.html?pledge=<id>`.
- **`?pledge=<id>`** (PLG_/CHK_): signed-in; `impactGetMyPledge` must return the caller's pledge with status
  `pledged`; the wizard skips `impactPledgeDonation` and runs `createPaymentIntent({purpose:'donation', pledgeId})`
  → STK → the same bounded poll. Other states are explained, never paid twice.
- **Banking Hub trust markers:** "Registration reviewed by SOKONI" only when `registrationReviewed === true`
  (server tooltip via title + aria-describedby + visually-hidden text), "Featured" only when `featured === true`,
  licence line only from `licenceVerification`. "Listed by SOKONI" stays. See [[FINANCIAL_PARTNER_WORKSPACE]].

## Not deployed / unproven

- Callables: `impactPledgeDonation`, `impactGetMyPledge`, `foundationContentDispatch`, `financialPartnerDispatch`
  (publicDirectory/publicProfile/submitEnquiry), and the `donation` purpose of `createPaymentIntent` are **not live**.
  `impactGetPublicDashboard` and `impactGetCampaigns` are live.
- **Storage rules for `foundation-media/` are not deployed** — uploads are expected to fail until they are; the
  text-only path covers it.
- Browser suite `scripts/test-banking-hub.js` is written (backend fully mocked via `page.route`) but **not run**.
- Static suite: `scripts/test-foundation-page.js`.
