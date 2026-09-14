# Merchant Loyalty Continuity — Requirement + Pre-Implementation Audit

**Status:** REQUIREMENT RECORDED · audit partially done · **nothing implemented**
**Date:** 2026-08-27
**Related:** [[MANUAL_TILL_ORDER_CONTRACT]] · [[MULTISHOP_CHECKOUT_AUDIT]]

---

## 1. The requirement

> **Merchant loyalty migration is a continuity requirement. Existing customer loyalty balances
> earned under a merchant's prior system must not be silently forfeited when the merchant joins
> SOKONI. Migration must preserve the customer's recognised balance and allow subsequent
> earning to continue under the SOKONI loyalty system.**

Stated as the rule: **joining SOKONI changes where a customer's loyalty record is managed; it
does not reset the customer's accumulated entitlement.**

This follows from the platform's positioning — SOKONI is the commerce layer connecting existing
shops to customers, not a demand that merchants discard working business systems. A merchant
who must tell loyal customers "your points are gone" has been given a reason not to join.

## 2. ⚠️ This is NOT greenfield — the machinery exists

| Collection | References | Role |
|---|---|---|
| `loyaltyAccounts` | 51 | the customer balance |
| `loyaltyLedger` | 32 | **append-only movement record** |
| `loyaltyMerchantConfigs` | 18 | per-merchant rules |
| `loyaltyCampaigns` | 4 | campaigns |
| `loyaltyGiftCards` | 5 | gift cards |
| `loyaltyCheckoutIdempotency` | 4 | duplicate protection at checkout |
| `loyaltyTransactions` | 3 | — |

**Do not build a points system.** `functions/loyalty.js`, `loyalty-enterprise.js` and
`loyalty-dispatch.js` already exist.

### The ledger already has the shape migration needs

A `loyaltyLedger` entry carries:

```
uid · loyaltyId · type · merchantId · points · bonusPoints · amountKES
balanceBefore · balanceAfter · description · idempotencyKey · createdAt
```

`loyaltyAccounts.balance` is maintained alongside via increment, and every movement records
`balanceBefore`/`balanceAfter`.

> **Therefore migration must be a LEDGER ENTRY, not a balance overwrite.**
> A new `type: 'migration'` (or similar) with provenance and an idempotency key satisfies every
> constraint the requirement names — preserved balance, no double credit, attributable history,
> continued earning — using machinery that already exists and is already idempotent.

Writing a number into `loyaltyAccounts.balance` directly would destroy the audit trail the
ledger exists to provide, and would make a re-run silently double-credit.

## 3. What the migration must satisfy

| # | Constraint | How the existing ledger serves it |
|---|---|---|
| 1 | Existing points preserved | opening-balance entry, `balanceBefore: 0 → balanceAfter: N` |
| 2 | Customer not credited twice | `idempotencyKey` — already enforced |
| 3 | Historical points attributable | `type`, `merchantId`, `description`, provenance fields |
| 4 | Future earning continues normally | no change — subsequent entries behave as today |
| 5 | Merchant can reconcile old vs migrated | the ledger entry is the reconciliation record |
| 6 | Redemption rules preserved or explicitly migrated | `loyaltyMerchantConfigs` — **needs audit** |
| 7 | Customer identity linked correctly | **the hardest part — see §4** |

**No migration/import path currently exists.** A search for `loyaltyMigration` /
`importPoints` / `migratePoints` / `openingBalance` / `legacyBalance` found nothing in the
loyalty modules. That gap is real; the surrounding machinery is not.

## 4. 🔴 OPEN — audit required before any implementation

**Do not assume a prior system's points schema matches SOKONI's.** The Nivas → SOKONI mapping
must be audited, not inferred.

- [ ] **Identity linkage.** How is a Nivas customer matched to a SOKONI `uid`? Phone number is
      the likely key — and [[reference_user_phone_storage]] records that SOKONI stores
      `phoneNumber`, not `phone`. A mismatch here credits the wrong person.
- [ ] **Authoritative starting balance.** Does the prior system have its own ledger, or only a
      balance? A balance-only source cannot be reconciled after the fact.
- [ ] **Point valuation.** Are a Nivas point and a SOKONI point worth the same? If not,
      migration involves a conversion rate — which is a **commercial decision**, not a mapping.
- [ ] **Redemption rules.** Do prior redemption terms survive, or convert to
      `loyaltyMerchantConfigs`? Customers may hold expectations formed under the old terms.
- [ ] **Expiry.** Did prior points expire? Do migrated points inherit that, or start fresh?
- [ ] **Scope.** Are migrated points spendable only at that merchant, or platform-wide? This is
      the biggest commercial question in the list.
- [ ] **Customers with no SOKONI account.** Held pending signup, or not migrated?

## 5. What this does NOT change

The manual-Till contract · the commission lifecycle · the STK path · any existing loyalty
behaviour for merchants already on SOKONI.

**Nothing implemented. §4 must be audited and the commercial questions answered first.**
