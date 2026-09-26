# Production payment lineage map

**Status:** STOPPED at step 1 — 2026-09-26. Map complete; **no convergence branch created, nothing
merged**. The serving payment functions run **mutually contradictory versions of the same money
modules**, so no single release composition can preserve every function's serving behaviour; choosing
between them is an authority decision (several are commercial), not a merge resolution.
Related: [[CREATOR_HUB_PORT_BASELINE]], [[PRODUCTION_WALLET_LINEAGE_RECONCILIATION]],
[[PROVENANCE_GAP_MERCHANT_IDENTITY]].

## Method (read-only, reproducible)

1. `gcloud functions describe <fn> --gen2 --region us-central1` → `buildConfig.source.storageSource`;
   `gcloud storage cp gs://gcf-v2-sources-24799054989-us-central1/<fn>/function-source.zip` (read-only).
2. `scripts/payment-lineage-map.js <deployedRoot> 618aadd 61912dd 4770c5c` — finds the file that
   DEFINES each function inside its archive, computes that file's transitive relative-`require`
   closure, and compares every file by git blob against the named trees.
3. `scripts/payment-lineage-semantic-diff.js <deployedRoot> <lineage.json>` — for every file two
   serving functions load with different bytes, parses each version (`@babel/parser`) and compares ASTs
   with locations/comments stripped: comment-only vs real code, and which top-level declarations differ.

## Serving source archives

| Function (last deploy) | Archive sha256 (16) | Files | Defined in | Defining-file blob → introduced by |
|---|---|---|---|---|
| `webhookIntasend` (2026-09-06) | `ede9cc16436893b3` | 406 | `index.js` | `2d2751b` → `bb88891` |
| `initiateSTKPush` (2026-09-14) | `8275c27d774a62c5` | 401 | `index.js` | `1744f15` → `76571a1` |
| `createPaymentIntent` (2026-08-29) | `8e654cbb740c330a` | 383 | `payment-intents.js` | `72b0357` → `5995248` (index `7d115bc`) |
| `fosSubmitRefund` + `fosApproveRefund` (2026-08-31) | `dcb3d3788e44ac01` (same archive) | 315 | `financial-os.js` | `d0db437` → `da3f9e4` |
| `adminOsDispatch` (2026-09-01) | `e871db0e505b9497` | 321 | `admin-os-dispatch.js` | `admin-os.js` `58828de` → `18cfe7f` |
| `requestSellerPayout` (2026-08-22) | `6a312842a32f4265` | 379 | `wallet.js` | `5b558d4` → `33031f2` (index `d6655bd`) |

No generated build artefacts are in the archives beyond `package.json` / lock files; `node_modules` is
installed at build time and is **not** compared here (a dependency-version difference is therefore
UNPROVEN, not excluded). One unresolved require in every index-defined closure:
`auth-policy.js → ../sokoni-verify-policy.js` (a path outside `functions/`, absent from the archive).

## Closure vs trees (files identical / different / absent)

| Function | Closure | `618aadd` release/comms-on-live | `61912dd` ship/catalogue-port-on-live | `4770c5c` candidate |
|---|---|---|---|---|
| `webhookIntasend` | 349 | 302 / 26 / 21 | 305 / 24 / 20 | 258 / 79 / 12 |
| `initiateSTKPush` | 345 | 258 / 59 / 28 | 261 / 57 / 27 | 293 / 52 / 0 |
| `createPaymentIntent` | 11 | 9 / 1 / 1 | 9 / 1 / 1 | 2 / 8 / 1 |
| `fosSubmitRefund` / `fosApproveRefund` | 5 | 1 / 4 / 0 | 1 / 4 / 0 | 0 / 5 / 0 |
| `adminOsDispatch` | 2 | 0 / 2 / 0 | 0 / 2 / 0 | 0 / 2 / 0 |
| `requestSellerPayout` | 13 | 12 / 1 / 0 (`notify.js`) | **13 / 0 / 0** | 7 / 6 / 0 |

Two modules in the serving webhook's closure exist in **none** of the compared trees:
`pos-intasend-initiation.js`, `pos-business-day-gate.js`.

Where each serving source lives: `bb88891` → `release/functions-reconciled`, `integration/rc-converged`,
`release/payments-reconciled` (+4) · `76571a1` → `feat/integrations-control-center`,
`feat/business-wallet-authority` (+15) · `7d115bc` → `fix/commission-subsystem-converge`,
`fix/seller-commission-48h-obligation` (+2) · `da3f9e4` → **only** `design/f5-fos-settlement` ·
`18cfe7f` → `feat/adminos-convergence`, `origin/main` (+6) · `33031f2` → both release branches.
The best branch in the repository carries 6 of the 11 sources (payment + hosting + provenance).

## The blocker — production runs contradictory money code

Files loaded by two or more serving functions: **338**. Of those, **50** differ in bytes between serving
archives, and **49 of the 50 are real code differences** (only 1 is comment/format-only).
Money / authority modules among them:

| Module | Code variants in production | Who runs which | Top-level declarations that differ |
|---|---|---|---|
| `commission-config.js` | **4** | webhook · STK · refunds · payouts — each different | `RATES`, `ALIASES`, `FIXED_RATE_CATEGORIES`, `isFixedRateCategory`, exports |
| `payment-intents.js` | 3 | webhook · STK · `createPaymentIntent` | `createPaymentIntent` |
| `payment-purposes.js` | 3 | webhook · STK · `createPaymentIntent` | `PURPOSES`, `validateOrderLines`, exports |
| `finos-utils.js` | 3 | webhook · STK+payouts · refunds | `calculateCommission`, `intasendB2C` |
| `notify.js` | 3 | webhook · STK · payouts | `advanceOrder`, `orderAdvance`, … |
| `financial-os.js` | 2 | webhook+STK · refunds | `_processFOSTransaction`, `fosSubmitRefund`, `fosApproveRefund`, … |
| `payment-adapters.js` | 2 | webhook+STK+payouts · refunds | `IntaSendAdapter`, keep-alive agent |
| `commission-collection.js` | 2 | webhook+STK · `createPaymentIntent` | `settleConfirmedPayment`, `computeOutstandingKES` |
| `order-settlement.js` | 2 | webhook · STK | `settleOrder`, `_platformFundedDiscountCents` |
| `index.js` | 2 | webhook · STK | 84 declarations |
| `admin-os.js` / `admin-os-dispatch.js` | 2 | webhook+STK · `adminOsDispatch` | `_adminCapabilityAllows`, `adminGetAuditLogs`, `_OPTS` |
| `commission.js`, `pos-qr.js` | 2 | webhook · STK | `commissionDispatch`, `generatePOSPaymentQR` |

**Concrete example — the commission rate table (`RATES`, parsed, not grepped):**

| Serving function | `marketplace` | `hub` | `pos` |
|---|---|---|---|
| `webhookIntasend` (charges commission) | **5 %** | **12 %** | 5 % |
| `initiateSTKPush` | 5 % | 12 % | absent |
| `fosSubmitRefund` / `fosApproveRefund` (reverses it) | **3 %** | **8 %** | absent |
| `requestSellerPayout` | 3 % | 12 % | absent |

The function that charges commission and the function that reverses it on refund run different rate
tables today. A single composition must pick one table for all of them; picking is a **commercial
authorization**, not a merge. The same holds for the other 48 real differences (each needs a reviewed
"which version is canonical" decision).

## Conclusion against the slice's stop conditions

| Stop condition | Met? |
|---|---|
| serving behaviour cannot be reconstructed (as ONE composition) | **yes** — 49 shared files have ≥2 serving behaviours |
| a merge would require inventing authority | **yes** — e.g. which commission table, which `createPaymentIntent`, which refund `financial-os` |
| byte/behavioural equivalence cannot be demonstrated for all functions at once | **yes** — by construction, for every conflicting file |

## What the next slice needs (owner decisions, then engineering)

1. **Per-module canonical-version decisions**, money modules first — for each of the 13 rows above, the
   owner (commercial rows: `commission-config`, `finos-utils.calculateCommission`,
   `commission-collection`) chooses which serving behaviour is canonical, in writing.
2. Only then: build the convergence branch from `618aadd`, import each chosen version as its own reviewed
   change, and prove each serving function **behaviourally** against the chosen version (byte-equivalence
   is impossible for the functions whose version was not chosen — they will change, deliberately).
3. Independently of Creator Hub, the rate mismatch between the charging and refunding functions is a
   **live money inconsistency** worth its own ticket.
