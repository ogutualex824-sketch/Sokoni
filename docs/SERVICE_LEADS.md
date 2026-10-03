# Service Leads & Quotes

Tech Hub slice 4F (2026-10-03, sokoni-b2). Related: [[Tech Hub Convergence]], [[Capability Engine]], [[Bookings]], [[Payments]], [[Messages]].

**Status: built on `feat/tech-taxonomy-on-13f74f3`, NOT deployed.**

## Why it exists

Before this slice, SOKONI had no lead or quote authority for services:
- the `enquiries` / `calls` modules were marked available with nothing behind them;
- `priceType:'quotation'` was only a label;
- bookingCreateService could not book a negotiated price;
- "Message provider" before a booking had no transaction for a conversation to hang on.

The only per-customer quote pattern in the codebase is `constructRFQs` / `constructQuotations`, which is construction-only and client-written.

The `techLeads` and `homeServiceLeads` collections are **not** canonical. They were browser-written, admin-read stubs, and the Tech / Home pages no longer write them.

## The authority

| Item | Value |
|---|---|
| Collection | `serviceLeads/{leadId}`, **server-written only**. No rules block exists, so default deny applies. Every read goes through callables. |
| Code | `functions/service-leads.js`, routed by `providerDispatch` |
| Conversation | transaction type `service_lead` (messages.js). Parties: `customerUid` and `providerId`. |
| Booking | `bookingCreateService({ leadId, … })` books an ACCEPTED quote at the quoted price. |

### Document

```
customerUid, providerId, serviceId|null, message, repairDetails|null,
status, quote|null, bookingId|null, history[{at, by, event}],
monetization: { status: 'not_configured' | …, note }, createdAt, updatedAt
quote = { amountCents, currency:'KES', serviceId, description, durationMins, serviceMode, notes,
          validUntil (ms), version, sentAt }
```

## Lifecycle (server state machine)

```
created ──(provider opens)──▶ viewed ──▶ quote_sent ──▶ quote_accepted ──(bookingCreateService{leadId})──▶ converted
   │                            │            │  ▲
   │                            │            │  └── clarification_requested ◀── (customer asks)
   │                            ▼            ▼
   └──────────────▶ declined (provider)   quote_declined (customer)
any open state ──(customer)──▶ closed
```

| Op | Who | Allowed from | Result |
|---|---|---|---|
| `leadCreate` | customer | — | `created`. The provider must be active/approved and hold the `leads` module (QUOTE_REQUEST capability). |
| `leadListMine` | customer | — | the caller's leads |
| `leadListForProvider` | provider | — | the provider's leads. Requires `assertModule(leads)`. |
| `leadMarkViewed` | provider | created | `viewed` |
| `leadDecline` | provider | created, viewed, clarification_requested | `declined` |
| `leadSendQuote` | provider | created, viewed, clarification_requested, quote_sent | `quote_sent` (version + 1) |
| `leadRespond` accept | customer | quote_sent (not expired) | `quote_accepted` |
| `leadRespond` decline | customer | quote_sent | `quote_declined` |
| `leadRespond` clarify | customer | quote_sent | `clarification_requested` |
| `leadClose` | customer | any open state | `closed` |
| `bookingCreateService{leadId}` | customer | quote_accepted (not expired) | booking at `quote.amountCents`; lead → `converted` in the SAME transaction |

## Rules

1. **Server prices, browser asks.**
   - The quote amount is set by the provider's callable and validated: integer cents, 1 to KES 10,000,000.
   - The booking reads the price from the lead, never from the request.
   - A quote can only be re-sent while the customer has not accepted it.
2. **One conversion.** The lead flips to `converted` with the booking id in the booking's own transaction. A second `bookingCreateService{leadId}` is refused.
3. **Bound to its parties.**
   - Only the lead's customer can accept or close.
   - Only its provider can view, quote or decline.
   - A wrong party gets `permission-denied` before any state is read back.
4. **Capability-gated.**
   - A provider without an AVAILABLE `leads` module (no valid approval with QUOTE_REQUEST, or suspended) cannot receive leads or quote.
   - The quote's `serviceMode` must be a granted service-mode capability.
5. **Abuse limits.**
   - At most 3 open leads per customer per provider.
   - At most 20 leads created per customer per 24 h.
   - Text is bounded and stripped.
6. **Lead monetization: NOT CONFIGURED.**
   - No lead fee exists in commission-config or anywhere in SOKONI.
   - Every lead records `monetization: { status: 'not_configured', note: 'Lead monetization not configured' }`, and nothing is charged.
   - Charging later needs an owner decision and a payment path. It is never a percentage invented here.

## G7 — lead & quote lifecycle (Marketing Hub E2E, 2026-10-03)

The brief's lifecycles run on **this** engine. There is no second lead store, and every stored status above stays valid. Related: [[Marketing Hub]] · [[Work Engine]] · [[Payments]].

### New stored statuses

- `qualified` (provider)
- `quote_requested` (customer, or `leadCreate{requestQuote:true}`)
- `lost` (provider)

The pre-quote set is `PRE_QUOTE` = created · viewed · qualified · quote_requested · clarification_requested.

### Derived stages

`leadStage()` and `quoteStage()` compute the stages on the server. Every list carries them as `stage` and `quoteStage`. The browser never derives them.

| Lead stage | From |
|---|---|
| new / contacted / qualified / quote_requested / quote_sent | created / viewed / qualified / quote_requested / quote_sent |
| negotiating | clarification_requested |
| won | quote_accepted, converted |
| lost | declined, quote_declined, lost |
| cancelled | closed (customer) |
| expired | a quote past `validUntil`, or a pre-quote lead idle for 30 days (`LIMITS.leadTtlDays`) |

| Quote stage | From |
|---|---|
| draft | `quoteDraft`, which only the provider's view carries |
| sent / customer_viewed | `quote.viewedVersion === quote.version` after `leadViewQuote` |
| negotiating | clarification_requested |
| accepted | quote_accepted, converted |
| declined | quote_declined |
| expired | past `validUntil` |
| cancelled | withdrawn (`quote.cancelledAt`), or the lead was declined, lost or closed |

### New ops

All are `providerDispatch` routes.

| Op | Who | Allowed from | Result |
|---|---|---|---|
| `leadQualify` | provider | created, viewed | `qualified` |
| `leadRequestQuote` | customer | created, viewed, qualified | `quote_requested` |
| `leadSaveQuoteDraft` | provider | PRE_QUOTE, quote_sent | stores `quoteDraft` and leaves the status unchanged. Never shown to the customer and never bookable. |
| `leadSendQuote` | provider | PRE_QUOTE, quote_sent | `quote_sent` (version + 1). Consumes the draft. |
| `leadViewQuote` | customer | quote_sent | stamps `viewedVersion`. Idempotent per version, with no duplicate event. |
| `leadWithdrawQuote` | provider | quote_sent, clarification_requested | lead goes back to `qualified`. The quote is stamped `cancelledAt` and can never be accepted. |
| `leadMarkLost` | provider | PRE_QUOTE, quote_sent | `lost` (optional reason) |
| `leadDecline` | provider | PRE_QUOTE | `declined` |
| `leadRespond` accept | customer | quote_sent | **requires `quoteVersion`** equal to the current version, else `LEAD_QUOTE_CHANGED`. Freezes `acceptedQuote`. |

An expired (idle) lead refuses progress with `LEAD_EXPIRED`. Decline, lost, close, re-quote and view stay allowed. An expired lead no longer counts toward the 3-open limit.

### Itemised quote

```
quote = { amountCents (= total), currency, serviceId, quantity, unitRateCents, subtotalCents,
          adjustments[{label, amountCents≠0}] (≤5), taxes[{label, ratePct 0<r≤30, amountCents}] (≤3), taxCents,
          breakdown[{type: line|adjustment|tax, label, amount}],   // sums to amountCents
          scope, description, notes, durationMins, serviceMode,
          paymentTerms { code:'paid_on_booking_held_until_pin', text, note },
          serviceHub, serviceCategory, serviceSnapshot,              // marketing-services.bookingSnapshot
          validUntil, version, sentAt, viewedVersion?, viewedAt?, cancelledAt? }
lead.acceptedQuote = frozen copy of the accepted quote + acceptedAt
```

- **Total:** the server computes it as quantity × rate + adjustments + the stated taxes, with taxes charged on the net amount.
  - A legacy `amountCents`-only request is a 1× quote.
  - When the quote is itemised, a client `amountCents` is only a check. A mismatch returns `QUOTE_TOTAL_MISMATCH`.
- **Taxes:** VAT and other taxes are **never inferred**. Only a tax the provider states is added.
- **Payment terms:** they are fixed to the one money path SOKONI runs:
  1. booked;
  2. paid through IntaSend, confirmed by the verified webhook;
  3. held;
  4. released by the customer's completion PIN.

  The provider can add a note but cannot choose other terms.
- **Marketing services:** a quote for a marketing service needs the server marketing approval for that category, from the decision record via `marketing-authority`. Otherwise it returns `MKT_SERVICE_NOT_APPROVED`.
- **Acceptance locks the terms.** `quoteForBooking` prices from `acceptedQuote` (with a fallback to `quote` for leads accepted earlier). The booking's `pricingSnapshot.breakdown` carries the quote lines when they sum to the price.

### Evidence

| Suite | Result | Sabotage |
|---|---|---|
| `scripts/test-lead-lifecycle.js` (G1–G10) | 11/0 | 8/8 |
| `scripts/test-service-leads.js` | 14/0 | — |
| `scripts/test-service-leads-web.js` (hosting) | 14/0 | — |
| `scripts/test-merchant-mktpro.js` (merchant-v2) | 10/0 | 7/7 |

**NOT proven here:** a real browser run (memory floor) or a live lead → quote → booking → IntaSend payment.

## Not in this slice

- **AdminOS lead visibility:** slice 4Q.
- **Status system messages in lead conversations:** a new trigger, which is its own deploy unit.
- **Notifications to the provider** on a new lead: uses the existing notifications authority. Not wired yet.
