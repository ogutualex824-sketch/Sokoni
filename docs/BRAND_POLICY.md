# Brand Architecture — SOKONI × Bravilex

**Status:** Mandatory · enforced by `scripts/verify-company-identity.js`
**Version:** 2.0 · **Date:** 2026-07-18
**Supersedes:** v1.0 (2026-07-11), which permitted Bravilex *only* in legal/tax/settlement
positions and forbade "Powered by Bravilex" outright.

## The architecture

**Bravilex International Co. Limited** is the corporate parent. **SOKONI** is its flagship
consumer marketplace. Both are real, and the platform should say so — the previous policy
hid the parent entirely, which is not how a group brand works.

The governing principle is **SOKONI-first, Bravilex-attributed**:

> A customer is *using SOKONI*. They may *see that SOKONI is a Bravilex company*.
> They must never be asked to *transact with Bravilex*.

That last line is the whole rule. Attribution is a statement of ownership; it is not a
change of counterparty. A user who tops up a wallet, pays at checkout, or reads a receipt
must understand — without ambiguity — that the product, the balance and the money are
**SOKONI's**.

## Layer model

| Layer | Brand shown | Bravilex may appear as |
|-------|-------------|------------------------|
| **Corporate** — About, Careers, Contact, Investor, press, proposals, PDF letterheads | **Bravilex-led** | Full corporate identity: logo, wordmark, ecosystem banner |
| **Product** — Checkout, Wallet, Buyer/Merchant Dashboard, Receipts, Product pages, POS | **SOKONI** | *Subtle corporate attribution only* (see below) |
| **Legal** — contracts, tax invoices, terms, privacy, regulatory filings | Full legal identity | `Bravilex International Co. Limited` as the issuing/contracting entity |
| **Settlement** — collection accounts, payouts | Backend only | Never client-side; always masked (`••••0001`) |

## Permitted attribution strings (product surfaces)

These are the **only** forms allowed on product surfaces. Use them verbatim, from
`CompanyIdentity` — never hand-typed:

| String | Token | Placement |
|--------|-------|-----------|
| `Powered by Bravilex` | `poweredByBravilex` | Footer, splash, about panels |
| `Operated by Bravilex International Co. Limited` | `operatedBy` | Legal footer line |
| `A Bravilex Company` | `aBravilexCompany` | Footer, corporate lockups |

Attribution must be **visually subordinate**: smaller than the SOKONI mark, lower contrast,
never in the primary header slot, never in a call-to-action.

## Still forbidden (guard-enforced `BRAND_FORBIDDEN`)

Attribution never becomes **substitution**. Bravilex must not appear as the actor,
counterparty, or product name in a transaction:

`Bravilex Payment Confirmed` · `Paid to Bravilex` · `Bravilex Received Payment` ·
`Bravilex Wallet` · `Bravilex Balance` · `Bravilex Credits` · `Bravilex Checkout` ·
`Bravilex Earnings` · `Bravilex Sales` · `Bravilex Orders` · `Bravilex Settlements` ·
`Subscribed via Bravilex` · `Bravilex Subscription`

**Why these specific strings and not "Powered by Bravilex":** each one names Bravilex as the
party the user is transacting *with*. "Powered by" names the party the product is built
*by*. The first misleads about who holds the money; the second is ordinary corporate
attribution. A user reading `Bravilex Wallet` could reasonably believe their balance sits
with a company they have no relationship with — that is a consumer-protection problem, not
a branding preference. That is the line the guard enforces, and it does not move.

## Canonical strings (from `CompanyIdentity` — `sokoni-company.js`)

- `brand` = **SOKONI** — the product, always.
- `legalName` = **Bravilex International Co. Limited** — contracts, tax, JSON-LD `legalName`.
- `poweredBy` = **"Powered by SOKONI"** — the *product* statement (unchanged).
- `poweredByBravilex` = **"Powered by Bravilex"** — the *corporate* attribution (new in v2.0).
- `operatedBy` = **"Operated by Bravilex International Co. Limited"**.
- `aBravilexCompany` = **"A Bravilex Company"** (new in v2.0).

JSON-LD: `name` must remain `SOKONI`; `legalName` carries Bravilex. Unchanged from v1.0 —
structured data describes the *product* to search engines.

## Assets

Brand assets live in `assets/branding/`. Colour tokens are in
`assets/branding/brand-tokens.css`, **measured** from the master artwork rather than
eyeballed. Pages must reference the central assets — never copy a logo into a page
directory.

**Current asset status:** the logo PNGs in `assets/branding/extracted/` are **temporary
production assets**, cropped at native resolution from a presentation mockup that has no
alpha channel. They are not upscaled and not auto-vectorised, because both would degrade
the artwork. They are to be replaced when original vector artwork is available. All *new*
decorative assets (dividers, badges, ribbons, UI graphics) are authored as native SVG.

Related: [[COMPANY_IDENTITY_DEPENDENCY_MAP]] · [[ENTERPRISE_SETTLEMENT_ARCHITECTURE]] · [[BRANDING_GUIDELINES]]
