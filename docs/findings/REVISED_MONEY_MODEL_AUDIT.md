# Fourth pass — audit for the revised money model

**Read-only. No code, rules, IAM, indexes, payment providers or deploy configuration modified.
Nothing deployed. No rates chosen. No implementation.**
2026-08-28 · builds on `694a9a9`, `158d42a`, `29e2deb`

Covers only what the first three passes did not. The commission authority, the category
fallthrough, the ledger orphaning and the wallet-linkage gap are established there and not repeated.

---

## FINDING 1 — the 48-hour mechanism is NOT deployed. PROVEN

`functions/commission-collection.js` **does not exist** in live `61f468e`, nor in this RC. It lives
on five branches — `feat/fresh-session-appcheck-gate`, `fix/commission-subsystem-converge`,
`fix/algolia-batch-poisoning`, `fix/landlord-entry-authz`, `chore/remove-hosting-workflow` — from
commit `7d115bc`, *"seller 5% 48-hour receivable — obligation lifecycle + C2B-confirmed collection"*.
The desktop working copy additionally carries **uncommitted modifications**.

**There is nothing in production to "move away from".** The daily settlement gate is a first
implementation, not a replacement. That is good news for the migration and it changes the framing of
the work.

## FINDING 2 — even if deployed, it would govern ZERO rows. PROVEN LIVE

```
commissionLedger where billingModel == 'PER_SALE_48H'   ->  0 documents
```

The sweep matches on that field **and only that field** — deliberately, to avoid retroactively
making old rows overdue. The field is stamped at creation by `index.js onSellerPaymentCreated`. But
pass two established that **no live ledger row carries that writer's schema at all**: every live row
comes from `webhookIntasend`.

So the obligation lifecycle and the path that actually moves money are **disconnected by
construction**.

**This is the fourth instance of one defect class in this subsystem**, and the pattern is now the
most important finding of the whole audit series:

| # | authority | why it never applied |
|---|---|---|
| 1 | FinOS category table | `calculateCommission` called without its `db` argument — 0% for its whole life |
| 2 | hub/category rates | everything charged the hardcoded 10% fallback |
| 3 | `RATES.marketplace` 3% | live callers emit `product`, which matches no key → `default` 5% |
| 4 | 48-hour obligation lifecycle | keyed on `billingModel`, stamped by a writer that produces no live rows |

Each was carefully built, internally coherent, and **not on the path the money takes**. Any new
design — daily gate included — must be validated by *observing live documents move through it*, not
by reading it.

## FINDING 3 — the existing design already embodies two of the stated principles

From `7d115bc`'s own header:

* **Immutable recorded economics** — *"it never re-computes `commissionPct`, `commissionKES`,
  `grossAmount` or `totalOwed` … the figures charged at the time of sale are immutable; the lifecycle
  moves around them."* This is precisely the "reversals reference the original transaction's recorded
  economics" rule.
* **Restriction rather than blanket blocking** — the state machine is
  `DUE → REMINDED → OVERDUE → RESTRICTED → CLEAR`, with `getSellerRestriction` as a separate query
  and penalty as **fail-closed configuration** with no default rate anywhere in the file.
* **No second ledger** — it extends `commissionLedger` rather than creating a parallel record.

**So the daily morning gate is largely a RE-TIMING of an existing lifecycle** — `DUE_HOURS 48` /
`REMINDER_HOURS 46` become a daily boundary — plus the linkage fix. It is not a rebuild, and
rebuilding it would discard three properties that are hard to get right and already correct.

## FINDING 4 — free-delivery control exists, but the live value is not a boolean. PROVEN LIVE

```
shops/D5Ql2EYr95bt79…   freeDelivery = ""      delivery = false
deliveryConfig / deliveryPricing / shippingConfig   ALL EMPTY
```

Shop-level control exists as `shops.freeDelivery` and `shops.delivery`. The only live shop has
`freeDelivery` set to the **empty string** — not `true`, not `false`.

The requirement is *"delivery is charged unless the shop explicitly offers free delivery."* An empty
string is **not an explicit offer**, but whether the code treats it as "charge" or "free" depends on
the comparison used — `!== false` reads it as free, `=== true` reads it as charged. **UNPROVEN**
which is used. This is the same silent-default hazard as the commission `default` arm, sitting on
the delivery line.

---

## Proposed canonical economic record

One immutable row per completed transaction, carrying every id needed to reverse it:

```
transactionEconomics/{id}
  transactionType   POS_SHOP_SALE | MARKETPLACE_ORDER | SUBSCRIPTION | DELIVERY
  rail              DARAJA | INTASEND
  refs              orderId · checkoutId · paymentId · commissionId
                    walletTransactionId · payoutId          <- all six, always
  gross             amount, currency
  entitlements      seller · rider · platform            (must sum to gross)
  rateProvenance    category · rate · source of that rate · engine version
  idempotencyKey
  reversals[]       each referencing THIS row, never recomputing
```

Two properties, both answering proven defects: an unknown category **fails closed** rather than
pricing money, and every wallet movement can be traced to the transaction that caused it — which
pass three proved is impossible today for `earning_settlement` rows.

### Rail and type separation

```
POS_SHOP_SALE      Daraja      5% commission per completed sale
MARKETPLACE_ORDER  IntaSend    marketplace schedule; seller + rider economics held separately
SUBSCRIPTION       —           platform revenue (today misclassified to 5% — pass two)
```

`ALIASES.pos = 'marketplace'` is the single line that currently prevents this.

### Daily settlement gate

```
completed sale ─► economics row (accrued)
                    │
   daily boundary ──┴─► obligation = Σ unsettled accruals for that merchant
                          │  shows the merchant the exact underlying sales
                          ▼
                     STK request ─► payment confirmed ─► obligation settled
                          │
                          └─ failure shows the REASON; grace policy governs
                             restriction, per-obligation, never a blanket account block
```

Re-times `7d115bc`'s `DUE/REMINDED/OVERDUE/RESTRICTED/CLEAR` to a daily boundary and keeps its
fail-closed penalty configuration.

---

## Affected files, functions and collections

`functions/commission-config.js` (transaction types; kill the `pos` alias) ·
`functions/finos-utils.js` (`calculateCommission` resolution; fail closed) ·
`functions/index.js` (~`:6792` / ~`:7910` duplicate blocks; `:4732` writer; `onSellerPaymentCreated`
stamping) · `functions/commission-collection.js` (**not on live** — re-time, do not rebuild) ·
`functions/finos.js` + `functions/finos-router.js` (`0.88`) · `functions/platform-core.js` (second
rate table) · `functions/admin-os.js` (reporting compensation) · wallet writers producing
`earning_settlement`.
Collections: `commissionLedger` · `walletTransactions` · `wallets` · `payoutRequests` ·
`sellerPayments` · `posRetailSales` · `shops` (delivery) · `revenueConfig`.

## Migration requirements

1. Backfill or accept: six of six live ledger rows are orphaned and cannot be reconciled to an order.
   Decide explicitly whether they are test rows to be excluded or data to be repaired.
2. `walletTransactions` linkage must exist **before** daily collection or returns go live — otherwise
   the obligation and the reversal can disagree about what is owed.
3. A cutover field like `billingModel` must be stamped by **the writer that actually produces live
   rows**, or it repeats Finding 2 exactly.

## Invariants to enforce

Entitlements sum to gross · unknown category is an error, never a rate · unknown delivery setting is
"charged", never "free" · reversals reference recorded economics · every money movement idempotent
and linked · one authority, extended — never a parallel ledger.

## Certification gates before implementation

1. Category-coverage gate — unknown label fails closed; proven by sabotage.
2. Linkage gate — every wallet movement carries source ref + idempotency key.
3. Orphan gate — no ledger row without an order document (six of six fail today).
4. Reversal parity — refund reverses seller *and* commission *and* rider by reference; cannot exceed
   capture.
5. Split integrity — platform + rider + seller = gross.
6. **Live-path gate** — prove the new authority governs a **real** transaction by observing a live
   document traverse it. Given four consecutive authorities that never applied, this is the gate that
   matters most.
7. POS and marketplace priced in one run, proven independent.
8. Existing release-path gates: single-source guard green without new allow-list entries, live
   reconciliation before deploy.

## Out of scope — do not touch

The deployed tenant-authority release and the shopEmployees anchor rule; the frozen wallet backend.
