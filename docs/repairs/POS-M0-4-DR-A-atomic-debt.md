# M0-4-DR-A — A POS sale and its commission debt commit together, or not at all

**Status:** built on the POS lineage 2026-09-28, first on `97b5d76`, then rebased onto `b12405d` (the
`webhookSmartpos` retirement) and fully re-certified on the rebased tree. **Not deployed.**
**Related:** [[FINANCIAL_CORE_ARCHITECTURE]] (M0-1 debt authority, M0-4-DR), [[POS-M0-4a-attempt-sweep]],
[[POS-0b-checkout-integrity]].

## The invariant

> Every completed commission-bearing Till / Quick Charge transaction, in any business category, has exactly one
> authoritative POS commission debt (`posCommissionLiabilities/poscomm_<saleId>`), or is explicitly unreconciled.

This unit enforces the first half for the two server sale paths that create debts. The second half, the
reconciliation of sales committed before this change, is M0-4-DR-R.

## Why

The census (2026-09-28) found that both server paths wrote the debt **after** the sale committed, best-effort:
- **`posCompleteCheckout`:**
  - the sale committed in the stock transaction;
  - the debt was written in the completion step, inside a `try/catch` that only logged;
  - completion then marked the idempotency key complete, so **a same-key retry never repaired a missing debt**;
  - the debt's `soldAtMs` was `Date.now()` at completion, not the sale's own time.
- **`recordPOSSale`:** the same post-commit best-effort write. Its replay re-ensured the debt only if the client retried.
- **Evidence on the old tree (`97b5d76`, and again on `b12405d`):** a debt write that fails, or a debt that cannot be planned, leaves a **completed sale with
  no debt**. Stock moves, and the claim and sale exist (suite C-3, C-4, R-2, R-3 red on the old tree).

## What changed

- **`functions/pos-commission-rail.js`:** the one debt authority, with no second schema.
  - `buildDebt(record, business, createdAtMs)` is **pure**. The debt comes only from the planned sale record (the sale's
    own gross, rail/custody, `soldAtMs`, saleId and merchant) and the business resolved for it. It never reads prices,
    category configuration, merchant settings, payment status or customer state.
  - `prepareSaleDebt(db, record)` runs **before** the sale transaction. It validates, resolves the business (a read),
    and returns the refs plus debt plus ledger projection, or `none` for a custodial or zero sale.
  - `applySaleDebtInTxn(t, plan, debtSnap, ledgerSnap)` runs **inside** the caller's transaction, after the caller has read the
    refs in its read phase. It makes create-only writes of the debt and its ledger projection.
  - `recordSaleLiability` is unchanged in behaviour and now builds through `buildDebt`. It remains for the replay re-ensure and
    for M0-4-DR-R.
- **`posCompleteCheckout`** (`functions/pos-zero-friction.js`):
  - **The sale's own facts are fixed before the transaction:**
    - `soldAtMs = now`, now stored on the sale;
    - `collectionRoute`, computed once by `_collectionRouteFor(payments)` (platform configuration plus "all cash is in the drawer", never a
      payment outcome), stored on the sale and reused by completion.
  - **Debt:** the debt is planned before the transaction, read in phase 1, and **created in phase 3 with the sale and receipt**.
  - **Refusal:** if the debt cannot be planned, the sale is refused (`unavailable`) and any payment claim is released.
  - **Completion:** the post-commit best-effort debt write is removed.
- **`recordPOSSale`** (`functions/pos-retail-engine.js`):
  - the debt is planned before the one M0-2 transaction;
  - its refs are read after the claim check and before the stock helper;
  - it is created in the same commit as the claim, sale and receipt;
  - the post-commit block is removed;
  - the replay re-ensure stays as defence in depth.
- **Unchanged:** payment confirmation and every payment authority; the till gate (still OFF); wallets; collection;
  `recordPOSSale`'s `TILL_DIRECT` custody (a flagged question for a later unit); custodial sales (still no debt).

## Evidence

- **`scripts/test-m04dr-a-atomic-debt.js`** (real handlers, Firestore emulator, failures **injected** at the exact write):
  - **16/0 new vs 9/7 old**, on `97b5d76` and again, in a fresh complete run, on the rebased base `b12405d`.
    (One rebased attempt was cut short by a machine out-of-memory condition before the category block ran;
    it was discarded, not counted.)
  - Old reds, all the defect: C-3 / R-2 (debt write fails, sale kept, stock moved); C-4 / R-3 (debt unplannable, sale kept); C-2 /
    C-7 (debt dated by completion, sale carries no time).
  - The custodial, late-failure, race and category controls pass on both trees.
- **Categories:**
  - 107 distinct categories are parsed at run time from the repository's own category sources: the bootstrap type defaults, the storefront
    category map, the hub category lists and the launch-targets doc.
  - Each gets a real sale that produces exactly one debt, owned by its own business, through one rate, rail, amount and schema.
  - Category was already uniform before this unit; the gap was atomicity, not a category fork.
- **Mutants:** 9 of 9 caught (all nine re-run on the rebased tree):
  - debt not in the transaction (either path);
  - planning failure tolerated (either path);
  - sale time not stored;
  - builder dated by the clock;
  - custodial sale gets a debt;
  - ledger projection skipped;
  - not create-only (caught indirectly: the injection hooks create).
- Earlier units and floor: CHANGELOG 171.

## Boundaries

- **Not here:**
  - M0-4-DR-R (reconciliation of pre-change sales without a debt);
  - SmartPOS, POS QR, C2B Till, Till QR, layaway/stored value convergence (their own units);
  - FC-1 and M0-4b;
  - the `webhookSmartpos` retirement (its own unit, committed as `b12405d`, this unit's base).
- **Not deployed.**
