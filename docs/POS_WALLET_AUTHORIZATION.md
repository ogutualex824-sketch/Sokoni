# Buyer wallet authorization at POS — protocol

**Date:** 2026-09-02
**Status:** DESIGN. Not implemented, not deployed.
**Enforced by:** `functions/money-authority.js` → `planWalletPayment()`
**Certified by:** `scripts/test-money-authority.js` (79/0)

---

## The requirement

> The buyer pays from their own SOKONI wallet at a merchant's till, and **the buyer's PIN
> never passes through the cashier, the POS device, or any merchant-controlled surface.**

This is why the existing POS `method: 'wallet'` path cannot simply be repointed. It debits
`posWallets/{posCustomerId}` — merchant-issued store credit — **unilaterally, with no buyer
authorization at all**. Correct for store credit the merchant issued; a serious defect
against a buyer's real wallet.

## The protocol

```
CASHIER                     SERVER                        BUYER (own device)
   │                           │                                │
   ├─ requestWalletCharge ────►│                                │
   │   {buyerHandle, amount}   │                                │
   │                           ├─ resolve buyer                 │
   │                           ├─ create walletAuthorizations/  │
   │                           │    {id, buyerUid, amountMinor, │
   │                           │     merchantId, expiresAt,     │
   │                           │     status:'pending'}          │
   │                           ├──── push notification ────────►│
   │◄── {authId, status:pending}                                │
   │                           │                                │
   │   [POS shows "waiting"]   │◄──── approveWalletCharge ──────┤
   │                           │      {authId, PIN}             │
   │                           │  verify PIN server-side        │
   │                           │  status -> 'approved'          │
   │                           │                                │
   ├─ posCompleteCheckout ────►│                                │
   │   {payments:[{method:'sokoni_wallet', authId}]}            │
   │                           ├─ planWalletPayment()           │
   │                           ├─ ONE transaction:              │
   │                           │    consume authorization       │
   │                           │    debit wallet                │
   │                           │    record sale                 │
   │                           │    commission + net credit     │
   │◄── paid ──────────────────┤                                │
```

**The PIN travels only from the buyer's own authenticated session to the server.** The
cashier holds an `authId` — a reference to a permission, not a credential.

## What `planWalletPayment()` already enforces

| property | why |
|---|---|
| authorization must exist | an unauthorised charge is refused outright |
| `authorization.buyerUid === buyerUid` | an authorization from another buyer cannot be redirected |
| `authorization.amountMinor === amount.minorUnits` | **an authorization names the exact amount it permits** — otherwise a KES 100 approval could settle a KES 10,000 charge |
| `expiresAtMs > nowMs` | an approval left open is not a standing licence |
| `consumed !== true` | single-use; a replayed authorization is refused |
| balance checked **after** authorization | an unauthorised caller learns nothing about whether a stranger's wallet is funded |
| insufficient balance **declines entirely** | no debit, no sale, no commission, no partial capture |

The ordering of the last two is deliberate and tested: a request that is both unauthorised
*and* unaffordable reports the **authorization** failure, never the balance.

## Server-side obligations not covered by the pure core

The pure module cannot enforce these; the callable that wraps it must:

1. **PIN verification is server-side only.** The buyer's device sends the PIN over TLS to
   `approveWalletCharge`; it is compared against `pinHash` (already present on wallet
   documents) and never returned, logged, or exposed to the merchant.
2. **Consume the authorization inside the same transaction as the debit.** If consumption is
   a separate write, two concurrent checkouts can both observe `consumed: false`. Consumption
   and debit must be one atomic act — the same shape as the existing
   `posPaymentClaims/{ref}.create()` single-spend guard, which is already certified.
3. **Rate-limit and lock PIN attempts.** `walletPinAttempts` and `pinLocked` already exist
   in the wallet schema and must gate this path.
4. **The merchant must not learn the balance.** A decline says *declined*, never *the buyer
   has KES 340*.
5. **Resolution of `buyerHandle` → uid must not be an enumeration oracle.** "No such wallet"
   and "wallet not enabled" should be indistinguishable to the cashier.

## Open decisions

| # | decision |
|---|---|
| **D-W2** | Approval channel: in-app push + PIN, or an STK-style prompt where available? |
| D-W3 | Authorization lifetime — how long may a pending approval stand? |
| D-W4 | May a buyer approve on the merchant's device if it is *their own* logged-in session? (Recommended: **no** — it reintroduces the merchant surface) |
| D1 | The wallet freeze must be lifted, or this built alongside — it debits `wallets/{uid}` |

## Status

Nothing here is implemented. `planWalletPayment()` exists as a **pure, unwired function**
with no Firestore access, certified at the boundaries. No callable calls it, no document is
written, and `wallets/{uid}` is untouched.
