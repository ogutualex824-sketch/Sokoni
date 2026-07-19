# Brand-Scoped Payment Enforcement — Transitional Policy

**Status:** accepted for the Phase 0 pilot · **Stage:** 1B · **Recorded:** 19 July 2026

Related: [[Payments]] · [[SmartPOS]] · [[Authentication]]

## The compatibility path (and its expiry)

`initiateSTKPush` resolves the brand from `paymentIntents/{ref}` and applies that brand's
compliance policy. Three cases:

| Intent state | Behaviour | Why |
|---|---|---|
| brand is a known id | Apply that brand's policy | Canonical |
| brand is **unknown** | **REJECT** + audit | An unrecognised brand must never become a way past the gate |
| brand is **absent** | Treat as SOKONI | **Transitional — see below** |
| no intent at all | Unchanged (Stage 1a) | SOKONI's existing behaviour |

> ### ⚠ The absent-brand fallback is transitional
>
> **Existing SOKONI payment intents without a brand are interpreted as SOKONI purely for
> backward compatibility.** It exists solely so live marketplace payments are not disrupted
> during migration.
>
> **It is not the long-term enforcement model, and no future brand may rely on it.**
> A brand that depends on this fallback is, by definition, unenforced.

It is not a bypass today: `paymentIntents` has no Firestore rule, so it is default-deny and
Admin-SDK-only. A client cannot create or edit an intent, so a missing brand is a **server-side
omission to fix**, not an attacker's choice. Every occurrence logs `STK_INTENT_NO_BRAND`.

## Stage 2 migration

1. **Every KASS payment intent carries `brand: "kass"` at creation.** Non-negotiable — the gate
   is inert without it.
2. All new intent writers include an explicit `brand`.
3. SOKONI writers updated to `brand: "sokoni"` when practical.
4. **Measure adoption** via `STK_NO_AUTHORITY` and `STK_INTENT_NO_BRAND` in Cloud Logging.
5. When `STK_INTENT_NO_BRAND` reaches zero and stays there, **remove the fallback** and switch
   to strict fail-closed for any intent missing a brand.

Step 4 is the gate for step 5. Removing the fallback before the log is quiet would reject live
payments — the outcome the fallback exists to prevent.

## What is *not* covered

**SOKONI's mixed catalogue.** SOKONI is not a restricted storefront, so its adult categories
(`vape`, `alcohol`, `tobacco`, `adult`, `nicotine` — see `functions/brands.js`) are flagged but
**not enforced at payment**. Enforcing them requires the server to derive a product's category
from the trusted product record rather than client input, and that is separate later work.

Recorded so it is not mistaken for coverage: today, a SOKONI adult-category purchase passes
without a server-side age check.

## Invariants

- Bravilex International Co. Limited is the legal seller of record for **every** brand. Brands
  cannot carry `legalName`, `registrationNumber` or a KRA PIN — asserted in `scripts/test-brands.js`.
- KASS gates the whole storefront, not per product: every category it sells is restricted, so
  there is no basket that should pass and no category label to be trusted.
- A failure of a required check is a **refusal**, never an allow.
