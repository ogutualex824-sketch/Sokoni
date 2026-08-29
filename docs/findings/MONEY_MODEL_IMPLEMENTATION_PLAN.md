# Money model — implementation plan (files, functions, collections, gates)

**Plan only. No code written, nothing deployed, no rates changed.**
2026-08-28 · rests on `694a9a9` · `158d42a` · `29e2deb` · `efae6ea` · `9658154`

## Locked commercial decisions

1. **`commissionLedger` remains the single writable financial commission authority.** No second
   writable ledger. Economic references become **fields on the authoritative record**; anything else
   is a read-only projection.
2. **POS/shop = Daraja, exactly 5%, no KES 10 minimum** unless a minimum fee is separately
   authorised and *named* as such.
3. Marketplace = IntaSend, own seller/delivery/rider economics.
4. Delivery chargeable unless `shops.freeDelivery === true`.
5. Independent marketplace/shop pricing; commission computed from recorded economics, never
   bypassable by pricing.
6. Durable linkage on every financial record.
7. Refunds reverse recorded economics.
8. Unknown category fails closed.
9. Daily settlement is a **new** mechanism; the 48h system is not a migration target.
10. Merchant V2 may enforce the approved restriction lifecycle.
11. **Do not restore the old package commissions** — the fourth audit established that mechanism was
    never the live pricing authority. Build explicit and authoritative, do not resurrect unreachable
    historical logic.

---

## THREE BLOCKERS FOUND WHILE PRICING THE PLAN

### B1 — the linkage fix requires modifying the FROZEN wallet backend

`walletTransactions.earning_settlement` is written by **`functions/wallet.js:1753`**, and `wallet.js`
is under tag **`wallet-backend-v1.0-frozen`** (freeze record `20163a1`). Decision 6 cannot be
implemented without touching it.

This is the exception clause — *"unless the implementation audit proves a required dependency"*. It
is proven. **Explicit authorisation to modify the frozen wallet backend is required before step 2,
and it should be a narrow, separately certified change.**

### B2 — the sweep is aggregate, so "add transactionId" is the wrong fix

`wallet.js:1753` sits inside **`sweepEarningsToWallet`**, which moves a lump sum between balance
buckets:

```js
availableBalance:    FieldValue.increment(-backCents),
withdrawableBalance: FieldValue.increment(+…),
t.set(walletTransactions/{uid}_earnsettle_{Date.now()}, { type:'earning_settlement', … })
```

It aggregates many earnings, so a single `transactionId` on it would be false. **Corrects my own
earlier framing.** The rule must be:

* the **earning credit** — where `availableBalance` is first increased — carries
  `transactionId` + idempotency key;
* the **sweep** carries the *set* it moved (id list or a settlement batch id), so the aggregate stays
  reconcilable to its parts.

**Prerequisite:** locate the writer that first credits `availableBalance`. Not yet identified —
`sweepEarningsToWallet` is downstream of it.

### B3 — shop-level free delivery is inert, and a competing entitlement exists

No consumer reads `shops.freeDelivery` to price delivery. The only references are
`seller.html:2744/3067/3131`, which **write and display it as a store setting**. `deliveryConfig`,
`deliveryPricing` and `shippingConfig` are all empty collections.

Separately, `functions/loyalty-enterprise.js:44-48` grants `freeDelivery: true` to **diamond and
platinum loyalty tiers** — a customer entitlement, unrelated to the shop setting.

So decision 4 is **not** "fix a comparison"; it is "build the delivery pricing path", and the design
must state precedence between a shop offering free delivery and a customer whose tier already grants
it. Two sources, one outcome — decide which wins, or whether either suffices.

---

## Step plan

### Step 1 — decisions (no code)
B1 authorisation; shop-vs-loyalty free-delivery precedence; confirm no minimum fee for POS.

### Step 2 — financial linkage *(blocked on B1)*
* `functions/wallet.js` — earning credit carries `transactionId` + idempotency key; sweep carries its
  source set. **Frozen file; narrow change; own certification.**
* `functions/commissionLedger` writers — `functions/index.js` (~`:6792`, ~`:7910` duplicates, and the
  `:4732` trigger): stamp `orderId`, `checkoutId`, `paymentId`, `walletTransactionId`, `payoutId`.
* Collections: `walletTransactions`, `commissionLedger`, `wallets`, `payoutRequests`.

### Step 3 — transaction types and rails
* `functions/commission-config.js` — add explicit `POS_SHOP_SALE`, `MARKETPLACE_ORDER`,
  `SUBSCRIPTION`, `DELIVERY`; **remove `pos` from `ALIASES`** (line ~88); map live vocabulary
  (`product`, `hair-beauty`, `subscription`) explicitly or reject it.
* `functions/finos-utils.js` — `calculateCommission`: unknown category raises
  `COMMISSION_CATEGORY_UNRESOLVED` instead of returning `RATES.default`.
* **`functions/finos-utils.js:563`** — `commissionCents = Math.max(commissionCents, CC.MIN_COMMISSION_KES * 100)`
  becomes conditional: the floor must **not** apply to `POS_SHOP_SALE` (decision 2). Single site.
* `functions/pos-zero-friction.js:167` — pass `POS_SHOP_SALE`.
* De-duplicate the two `index.js` commission blocks into one helper.

### Step 4 — delivery *(scope corrected by B3)*
Build the pricing path: `shops.freeDelivery === true` → free; anything else → charge. Decide
precedence against `loyalty-enterprise.js` tier `freeDelivery`. Record `deliveryCharged` and
`freeDeliveryReason` on the economic record.

### Step 5 — daily obligation
New mechanism. Reuse `7d115bc`'s proven properties — immutable recorded economics, fail-closed
penalty config, `DUE/REMINDED/OVERDUE/RESTRICTED/CLEAR`, no second ledger — re-timed to a daily
boundary. **Key it off a field stamped by the writer that actually produces live rows**, or it
repeats the `PER_SALE_48H` zero-coverage failure exactly.

### Step 6 — Merchant V2 morning gate
Reads obligation state; STK Push; failure shows the reason; restriction is per-obligation, never an
unconditional account lock.

### Step 7 — returns
Reverse by reference to `transactionId`. Depends on step 2.

### Step 8 — live-trace certification
Below.

---

## Certification gates

| # | gate | asserts |
|---|---|---|
| 1 | **Coverage metric** — live rows with `recordedRate.source == 'default'`, target **0** | build FIRST; would have caught all four historical failures |
| 2 | Category coverage | unknown label → `COMMISSION_CATEGORY_UNRESOLVED`, no money moves, nothing written; proven by sabotage |
| 3 | Linkage | every earning credit carries `transactionId` + idempotency key; every sweep reconciles to its parts |
| 4 | No **new** orphans | (the six existing rows are preserved evidence, excluded) |
| 5 | Split integrity | seller + rider + platform + sellerNet == gross, asserted at write |
| 6 | POS exactness | KES 97 POS sale charges **4.85**, not 10 — the decision-2 regression test |
| 7 | Independence | POS and marketplace priced in one run, moving independently |
| 8 | Reversal parity | refund reverses seller, commission and rider by reference; cannot exceed capture |
| 9 | Replay safety | double-delivery at every money boundary, asserted on effects and timestamps |
| 10 | **Live trace** | a real transaction of each type observed traversing rail → commission → ledger → wallet → obligation, read from live documents |
| 11 | Existing release gates | single-source guard green **without** new allow-list entries; live reconciliation before deploy |

Gate 10 is the one the audits exist to justify: **code existing ≠ authority reached ≠ money traversed
it.** Four authorities passed source review and never applied.

## Untouched

Deployed tenant-authority release; `shopEmployees` anchor rule. `wallet.js` untouched **until B1 is
authorised**.
