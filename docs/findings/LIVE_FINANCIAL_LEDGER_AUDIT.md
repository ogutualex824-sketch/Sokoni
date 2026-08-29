# Second-pass audit — LIVE transaction and ledger evidence

**Read-only. No code, config, rates, rules, IAM, indexes, provider settings, wallets, production data
or deployment configuration changed. Nothing deployed. No rates chosen.**
2026-08-28 · evidence read from live Firestore via the REST API · follows `694a9a9`

Every claim is labelled **PROVEN LIVE** (read from a production document), **PROVEN IN CODE**,
**INFERRED**, or **UNPROVEN**.

---

## THE HEADLINE — the category rate table has never priced a live transaction

**PROVEN LIVE.** Every commission entry in production is **5%**, and 5% is the *fallback*.

```
commissionLedger, 11 documents sampled
  commissionPct : { "5": 11 }          <- every entry, without exception
  source        : { "webhookIntasend": 11 }
  category      : { product: 8, hair-beauty: 1, subscription: 1, default: 1 }
```

**None of those category labels exists in the authority.** `functions/commission-config.js` keys are
`marketplace`, `services`, `subscriptions`, `food_delivery`, … — verified: `RATES.product` false,
`ALIASES.product` false. An unmatched category resolves to `RATES.default = { pct: 5 }`.

So the 3-vs-5 contradiction is resolved, and neither side was quite right:

* **`marketplace: 3` is real but never reached.** Nothing in production asks for the category
  `marketplace`. The 3% rate has, on this evidence, never priced a transaction.
* **The live 5% is not a policy decision.** It is the default arm, reached because the caller's
  category vocabulary and the authority's vocabulary do not intersect.

This is the **third instance of the same defect class** in this one file's history, and the first two
are documented in its own comments: `calculateCommission` called without its `db` argument charged
everything 10% for its whole life; the FinOS category table settled at 0% for its whole life. Now a
category *string* that matches no key silently yields `default`. **In each case the table looked
authoritative and was not consulted.**

### A live revenue error follows directly

**PROVEN LIVE.** One ledger entry carries `category: "subscription"` charged at **5%**. The authority
has `subscriptions` (plural) at **100% — full amount is platform revenue**. Singular does not match
plural, so it fell to `default`. That transaction paid out **95% as `providerNet` on money that
policy says is entirely SOKONI's**.

The same trap is live for every other near-miss label.

---

## Findings by question

| # | question | status | evidence |
|---|---|---|---|
| 1 | commission on a live POS sale | **PROVEN LIVE: none via the ledger** | 0 of 11 ledger docs have a POS source |
| 2 | commission on a live marketplace order | **PROVEN LIVE: 5%** | all 11 docs, `source: webhookIntasend` |
| 5 | do POS and marketplace share one calculation? | **PROVEN IN CODE: yes** | `ALIASES.pos = 'marketplace'`; `pos-zero-friction.js:167` calls the same `calculateCommission` |
| 6 | live POS commission — reconcile 3 vs 5 | **RESOLVED** | authority 3% never reached; live default 5%; POS absent from the ledger entirely |
| 7 | live marketplace commission | **PROVEN LIVE: 5% (default arm)** | above |
| 10 | does the hardcoded `0.88` affect live money? | **UNPROVEN** | no delivery/rider ledger entry was sampled; the literal is real (`finos.js:59`, `finos-router.js:183`) but its live exercise is not shown |
| 17 | can `platform-core` rates charge money? | **INFERRED: no** | its values are written into registry docs and rendered by `email-triggers.js:98`; no charging consumer found. Not proven absent |
| 18 | duplicated / competing authorities | **PROVEN IN CODE** | see below |

### Duplicated and competing authorities — PROVEN IN CODE

1. **The commission block is duplicated inside `functions/index.js`** — once near `:6792`, once near
   `:7910`, same logic, and they write **different `source` values**: `"intasend_webhook"` versus
   `"webhookIntasend"`. Live data shows only `webhookIntasend`, so the two copies are not both
   exercised, or one is dead. Either way the same money rule exists twice in one file.
2. **Two writers with two schemas target `commissionLedger`.** The `sellerPayments` trigger at
   `index.js:4732` writes `{sellerUid, hub, grossAmount, commissionPct, fixedFee, commissionKES,
   totalOwed}`. The webhook writes `{uid, category, serviceTotal, sokoniCut, providerNet,
   checkoutId, ref, providerName}`. **No live document carries the first shape.** `admin-os.js:650`
   already compensates — `x.sokoniCut != null ? x.sokoniCut : x.commission` — which is a reporting
   layer papering over a schema split in the canonical collection.
3. **`platform-core.js`** carries hub `config.commissionRate` values that disagree with the authority
   (healthcare 8 vs 5, vehicles 2 vs flat KES 2000).
4. **The rider share** is the literal `0.88` in two modules, decoupled from `hub: { pct: 12 }`.

### POS financial posting is inconsistent — PROVEN LIVE

Three `posRetailSales` documents, same merchant:

```
CoJjrqRIc5RtJPVGOX17   grandTotal 3500   NO commission field
XmovY1eWnrbQydz4Nqzd   grandTotal 3500   HAS commission (map) + financialError + financialPosting
d8JnUACuDyAHmmqCAR9E   grandTotal  380   NO commission field
```

Some POS sales carry a commission object and a financial posting; others carry neither; one records
a `financialError`. **UNPROVEN:** whether the absent ones were never posted, posted elsewhere, or
failed silently.

### Seller payment record — PROVEN LIVE

The sampled `sellerPayments` document is `{hub, amount: 1, sellerUid, status: completed,
isTest: true, mpesaCode, checkoutId, orderId}` — the KES 1 sandbox STK from earlier in this
workstream. It carries **no commission field**. **UNPROVEN:** the production (non-test) marketplace
credit path, and whether IntaSend settlements write here at all.

### Operator overrides — PROVEN LIVE

`revenueConfig` contains **exactly one** document: `plan_adjustments`, `enabled: false`, `plans: {}`.
There is no live commission-rate override. The 5% therefore cannot be explained as operator policy.

---

## Still UNPROVEN after this pass

Refund commission reversal · cancellation reversal · failed-delivery/return reversal · seller
withdrawal path · rider withdrawal path · rider fee calculation and credit · delivery-fee
calculation and whether free delivery is shop-controlled · per-flow idempotency keys and ledger
entries for every transition · whether `platform-core` rates can charge.

These need transaction-level tracing with a known reference id through each collection, which is a
third pass. **I will not infer them.**

---

## A. Current production financial model

One collection rail is exercised: **IntaSend → `webhookIntasend` → `commissionLedger` +
`providerNet`**, every entry at the **default 5%**. POS sales land in `posRetailSales` with
inconsistent commission posting and **do not reach `commissionLedger`**. Seller proceeds appear in
`sellerPayments` from the Daraja/STK path. The category rate table exists, is enforced against
duplication, and is **not reached by any live caller**.

## B. Desired POS vs marketplace model

One policy engine, two transaction classes — as you framed it:

```
commissionPolicy
  ├── pos.shop_sale        (own rate; today aliased to marketplace)
  └── marketplace.online   (own rate; today unreachable)
```

Not two engines. The single-authority design and its drift guard already support this; what is
missing is a **category vocabulary contract** between callers and the authority, because that is the
layer that actually failed.

## C. Historical authority to restore — recommendation: NONE as-is

The original package schedule was **absolute** (`free 15%`, `business 4%`), removed in `a58afc2`
because against a 3% base those rates *raise* commission. Restoring it would take a free-tier seller
from an intended 3% — or a live 5% — to 15%. The built mechanism is **relative plan adjustment**
(`deltaPct` / `discountPct`, capped), operator-switched, no deploy.

## D. Seller marketplace-price strategy — options only, nothing chosen

Your "shop price ≠ marketplace price, computed transparently" model is compatible with the current
engine and does not require touching commission rates. Options: (i) seller sets a target net and the
platform derives a recommended price; (ii) seller sets the marketplace price directly with the
computed net shown; (iii) a policy band constraining divergence from shop price. All three keep the
rate fixed and move the *price*, which is the honest lever — a seller absorbing cost through price
is legitimate; a seller silently altering their commission rate is not.

## E. Rider economics — options only

Bind the rider share to the authority (`riderPct = 100 - hub.pct`) so the split cannot desynchronise,
or make both sides explicit fields of one policy object. Today they are two numbers in three files.

## F. Fraud / markup protections required

Marketplace price bands with server-side enforcement · commission computed **server-side from the
authoritative price**, never from a client-supplied amount · a category **allow-list** that rejects
unknown labels instead of silently charging `default` · reversal parity so a refund cannot return
more than was captured.

## G. Files / functions requiring modification (when authorised)

`functions/commission-config.js` (add `pos`; decide the `product`/`subscription` vocabulary) ·
`functions/index.js` (~`:6792` and ~`:7910` duplicate blocks; `:4732` schema) ·
`functions/finos-utils.js` (`calculateCommission` category resolution) ·
`functions/finos.js` + `functions/finos-router.js` (`0.88`) · `functions/platform-core.js` (rates) ·
`functions/admin-os.js` (reporting compensation) · `scripts/verify-commission-single-source.js`
(extend to catch *unreachable* categories, not just duplicate tables).

## H. Tests and certification gates before implementation

1. **A category-coverage gate**: every category string any caller can emit must resolve to an
   explicit rate, and an unknown label must **fail loudly**, not fall to `default`. This single gate
   would have caught the live defect.
2. Before/after effective-rate proof per category, including `MIN_COMMISSION_KES` and the default arm.
3. A POS sale and a marketplace sale priced in one run, proving independence.
4. Refund reversal returning both proceeds and commission, net drift zero.
5. Rider split proven to sum to 100 after any `hub` change.
6. `verify-commission-single-source` green **without** a new allow-list entry added to silence it.
7. Live reconciliation before deploy, per the existing release-path gates.
