# Authorization Review — Money-Touching Handlers · 2026-07-17

**Bug class:** a handler that checks **authentication** ("someone is logged in") but not
**authorization** ("this caller is entitled to act on *this* resource").

**Why this was run:** `posProcessRefund` had exactly this defect — it called `_assertAuth()`, which
only asserts a session exists. There was no role gate and no membership check, so **any
authenticated user who knew a `saleId` could refund it**. The one comparison present measured the
*client-supplied* `merchantId` against the sale's own `merchantId`, which an attacker simply
supplies correctly. Fixed 2026-07-17 in `6d941f7`. This sweep looks for the same shape elsewhere.

**Method.** Brace-matched every `onCall` / `_h` handler body across `functions/*.js`; kept only
those that **write** to a money- or privilege-bearing collection (`wallets`, `posWallets`,
`walletTransactions`, `payments`, `posRefunds`, `commissionLedger`, `settlements`, `payouts`,
`escrows`, `ledger`, `posRetailSales`, `subscriptions`, `posGiftCards`, `wholesaleLedger`,
`procurementPayments`, `posStaff`); then flagged any lacking an entitlement check. Read-only.

## Result: **0 confirmed vulnerabilities**

19 raw candidates → 5 after correcting the scanner → **0 real** after manual verification.

### Scanner corrections made before reporting

| Gap | Effect | Fix |
|---|---|---|
| `_assertAdmin` missing from the authorization keyword list | 14 admin-gated handlers in `commission.js` (`approveWithdrawal`, `processSettlement`, …) looked unguarded | added `_assertAdmin` and related helpers |
| No concept of **self-service** scope | Handlers spending from the caller's *own* wallet looked unguarded | added a self-scoped detector |

`commission.js` `_assertAdmin` was additionally checked for the historical **async-bypass** defect
(a non-awaited async guard silently passing). It is **synchronous** and throws directly, so calling
it without `await` is correct. No bypass.

### The 5 verified candidates — all false positives

| Handler | Why it is safe |
|---|---|
| `wallet-engine.js:299` `walletV2Send` | `senderUid = _requireAuth(request)`. The client supplies only recipient phone + amount; funds always leave the **caller's own** wallet. The uid *is* the authorization |
| `wallet-engine.js:1239` `walletV2PayViaQR` | `payerUid = _requireAuth(request)` — same self-service pattern |
| `wallet-engine.js:1471` `walletV2EscrowCreate` | `buyerUid = _requireAuth(request)` — same |
| `business-bootstrap.js:719` `validateDeviceAccess` | Writes only `rateLimits`; `posStaff` is a **read** query. Flagged because the scanner saw the collection name and a `.set()` in the same body. It is also a pre-authorization endpoint by design — it is what *establishes* authorization — and is itself rate-limited 5/uid/5min |
| `pos-crm-pro.js:194` `deductWallet` | See below — an intentional asymmetry, not a hole |

## One design asymmetry — for owner confirmation, not a defect

Within `pos-crm-pro.js`, the three customer-wallet operations differ:

| Handler | Role gate |
|---|---|
| `topUpWallet` | `_requireRole(auth, 'manager')` |
| `refundToWallet` | `_requireRole(auth, 'manager')` |
| **`deductWallet`** | **none — authenticated only** |

**Assessment: defensible, probably correct.** `deductWallet` is the checkout path — a *cashier*
must be able to take payment from a customer's wallet during a sale, so requiring manager rank
would break normal trading. Money-**in** (top-up) and money-**back** (refund) are the higher-risk
directions and are correctly gated.

Cross-tenant abuse is not possible: since `cbade53`, `sellerId` is **server-derived** from the
caller's token claim, so a cashier can only ever touch their own merchant's customer wallets.

**Recommend confirming the intent** and adding a comment recording it, so a future reviewer does
not "fix" the asymmetry and break checkout. No code change proposed during RC1.

## Conclusion

After the RC1 refund fix, the authorization posture of the money-touching surface is **sound**. No
handler was found that mutates money or privilege without an entitlement check appropriate to its
role. The one remaining asymmetry is explained by the checkout use case and is protected by
server-derived tenancy.

**Standing note for future sweeps:** authorization checks take many shapes — a role ladder, an
admin assert, a membership query, an ownership comparison, or simply deriving the subject from
`auth.uid`. A keyword scan will over-report all of them. Verify the execution path before
reporting, per the false-positive policy.
