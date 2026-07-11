# Customer-Facing Brand Policy — SOKONI

**Status:** Mandatory · enforced by `scripts/verify-company-identity.js`
**Date:** 2026-07-11

## Rule

The customer-facing brand is **always SOKONI**. **Bravilex International Co. Ltd** is the legal owner and settlement entity — customers, merchants, riders, and service providers experience the platform as **SOKONI**.

| Layer | Shown as |
|-------|----------|
| Customer-facing brand (payments, wallet, checkout, subscriptions, notifications, dashboards) | **SOKONI** |
| Legal entity / contracts / tax / accounting / compliance | Bravilex International Co. Limited |
| Settlement / collection account | Bravilex International Co. Ltd (backend, masked `••••0001`) |

## Where Bravilex IS permitted (only these)
- **Legal footer:** "Operated by Bravilex International Co. Limited" / "A product of Bravilex …".
- **KRA tax invoices/receipts:** issuer legal name = Bravilex (required by KRA; brand header stays SOKONI).
- **Backend settlement account:** `settlement-account.js` (never client-side, always masked in UI).
- **JSON-LD:** `legalName` field only — `name` must be `SOKONI`.

## Never (guard-enforced `BRAND_FORBIDDEN`)
`Bravilex Payment Confirmed` · `Paid to Bravilex` · `Bravilex Received [Payment]` · `Bravilex Wallet` · `Bravilex Balance` · `Bravilex Credits` · `Bravilex Checkout` · `Bravilex Earnings/Sales/Orders/Settlements` · `Subscribed via Bravilex` · `Bravilex Subscription` · `Powered by Bravilex` (footer must read "Operated by …").

## Canonical strings (from CompanyIdentity)
- `poweredBy` = **"Powered by SOKONI"** (brand statement).
- `operatedBy` = **"Operated by Bravilex International Co. Limited"** (legal line).
- Payment confirmations already read "✅ SOKONI — Payment Confirmed", wallet is "SOKONI Wallet", etc.

## Compliance status (2026-07-11 audit)
- Payment confirmations, checkout, wallet, subscriptions, notifications, emails, SMS: **already SOKONI-branded** — no Bravilex in any brand position.
- Fixed: seller footer "Powered by" → "Operated by"; JSON-LD `name` Bravilex → SOKONI+`legalName` (flashsale, services, careers, contact, driver); canonical `poweredBy` → "Powered by SOKONI"; email/etims receipt footer `poweredBy` → `operatedBy`.
- Guard (`node scripts/verify-company-identity.js`) now fails CI on any brand-position Bravilex: ✅ passing across 813 files.

Related: [[COMPANY_IDENTITY_DEPENDENCY_MAP]] · [[ENTERPRISE_SETTLEMENT_ARCHITECTURE]]
