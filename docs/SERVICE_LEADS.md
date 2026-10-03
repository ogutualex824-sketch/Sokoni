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

## Not in this slice

- **AdminOS lead visibility:** slice 4Q.
- **Status system messages in lead conversations:** a new trigger, which is its own deploy unit.
- **Notifications to the provider** on a new lead: uses the existing notifications authority. Not wired yet.
