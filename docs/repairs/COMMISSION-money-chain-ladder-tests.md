# Commission ladder — the money-chain suite asserted a retired policy

**Branch:** `commission-ladder/test-authority` (from main line `4c1ae2d`) · **NOT landed** · **test-only: no production file changes**
**Related:** [[Commission]] · `functions/commission-config.js` (the one rate authority)

## Diagnosis (2026-09-26): the 7 failures of `test-post-pin-money-chain.js`

Each failure was traced through the **real** resolver, using the suite's own fixture:
label/plan → `calculateCommission` lane → rate source → commission → ledger destinations.

| label | plan | resolved plan | rate | source | commission → | remainder → |
|---|---|---|---|---|---|---|
| marketplace | seller_free / basic / pro / enterprise | free / professional / business / enterprise | 15 each | `MARKETPLACE_PLAN_RATES` | `platform:revenue` | `seller:{id}` |
| product (the live checkout category) | seller_basic | professional | 15 | `MARKETPLACE_PLAN_RATES` | `platform:revenue` | `seller:{id}` |
| pos | any | — | 5 | `default_table` (via `ALIASES.pos`) | `platform:revenue` | `seller:{id}` |

The KES 10 minimum holds: a KES 50 marketplace sale is charged KES 10.

**The authority** (`commission-config.js`, owner decision 2026-09-22) is a flat 15% on every marketplace plan, with a
KES 10 minimum; POS is 5%. That decision superseded the 2026-09-13 packages (16/12/8/4), which superseded the
15/10/5/0 ladder the suite hard-coded.

| failure | classification |
|---|---|
| B1 ×3: basic 10%, pro 5%, enterprise 0% | **Test expectation wrong** (fixture/test defect); **historical policy ≠ current** (versioning). The resolver chooses the right plan, rate and source. |
| B2 ×3: remainder 9,000 / 9,500 / 10,000 | Same test defect, cascading from B1. Ledger destinations are correct (B4–B6 pass). |
| F1: "a plan change moves the settled amount" | **Test defect**: the premise is the retired ladder. Under the flat policy a plan change must *not* move the amount. |

**Common defect: one.** The suite hard-coded a retired ladder. None of the 7 is a production-logic, classification or
financial-chain defect.

## The repair (test-only)

- **B:** every expectation is derived from `CC.resolveMarketplaceRate(tier)` and `MIN_COMMISSION_KES`; there are no
  rate literals.
  - **B0** asserts the policy's **shape**: every plan is priced identically.
  - **B0b** asserts that every legacy `seller_*` id is a **recognised** plan, not the unknown-plan fallback.
- **F1** keeps its purpose, which is proving the plan fixture reaches the engine, by watching the **resolved plan**.
  **F1b** asserts that the plan does not move the amount.
- **E4 (new) guards the alias hazard.** In this engine POS is not priced by `POS_PLAN_RATES`: it resolves through
  `ALIASES.pos` to `RATES.marketplace.pct`. The till path uses `resolvePosRate`. Both numbers are 5 today, by
  coincidence. E4 asserts that the engine's POS rate equals the till authority's rate on every plan. The alias is
  **not** removed, because it also decides the 48-hour settlement term; that is a separate decision.

## Evidence — the new assertions catch the drifts they exist for

Each tree is a full `git archive` export of `4c1ae2d`.

| tree | old suite | new suite |
|---|---|---|
| clean | 32 passed / 7 failed | **43 / 0** |
| **S1**: retired 15/10/5/0 ladder reintroduced | **39 / 0: it approves the retired ladder** | fails **B0, F1b** |
| **S2**: `RATES.marketplace` 5 → 15 (POS follows the alias) | 9 failed, mixed with ladder noise | fails exactly **E2, E3, E4** |

`verify-commission-single-source` passes. The other commission suites are unchanged, because only this test file
changed.

## Found, not changed: separate units

- **`test-marketplace-plan-ladder.js`: 14 pre-existing failures.** Most are the same retired-ladder pinning:
  - A1–A3: 10/5/0, Enterprise 0%.
  - A4: assumes the KES 10 minimum dominates a small sale, which is true at 5% and not at 15%.
  - B1: its fallback labels.
  - G1: the same premise as F1.

  **H2 and H5 may be a real client defect.** The browser snapshot returns `undefined` for every plan spelling while
  the server returns 15. This needs its own diagnosis.
- **`test-commission-48h-destinations.js` (3) and `test-commission-balance-ui.js` (2).** These are pre-existing and
  unrelated to rates (payment-destination verification, STK endpoints, UI gating).
- **The POS alias** is a latent production-logic finding: two rate authorities agree only by value. E4 now guards it.
  Retiring the alias is a separate decision, because it also governs the 48-hour settlement term.
- **Deployment state (versioning).** Per the 2026-09-19 record, production still charges the deployed rate. 15% is
  this lineage's authorised target; promoting it is a separate commercial and deploy decision.
