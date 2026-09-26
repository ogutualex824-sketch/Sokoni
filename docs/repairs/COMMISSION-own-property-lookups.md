# Commission authority — inherited property names are not rate keys

**Branch:** `commission-config/own-property-lookups` (from main line `45bcc44`) · **NOT landed, NOT deployed**
**Related:** [[COMMISSION-browser-rates-parity]] · `functions/commission-config.js` (the one rate authority)

## Defect: measured before any change, not inferred

The rate tables are plain object literals read with bare `TABLE[k]`. That also finds **inherited** names:
`constructor` resolves to Object's constructor and `__proto__` to `Object.prototype`, both truthy. I probed every
exported resolver:

| resolver | `constructor` / `__proto__` | `prototype` / an unknown key |
|---|---|---|
| `resolveRate` (category), and `categoryForHub` through it | **`{category:'constructor', matched:true}` with no `pct`** | `default`, 5% ✓ |
| `resolveMarketplaceRate` (plan) | **throws** (`reading 'rateFraction'`) | default plan `free`, 15% ✓ |
| `resolvePosRate` | already `hasOwnProperty`-guarded ✓ | ✓ |
| `applyPlanAdjustment`, `isMarketplaceSellerSale`, `planRolloutEnabled` | safe ✓ | ✓ |

**The category defect is the serious one, and it is client-reachable.** `webhookIntasend` prices commission on
`payData.meta?.category`, and that `meta` is stored from the caller's own payment request (`meta: meta || {}`).
With category `constructor`:
- `calculateCommission` returned commission **NaN** at rate `undefined`.
- The webhook's `commissionCents ? … : 0` recorded **`sokoniCut 0` and `providerNet` = the whole sale**.
- **Nothing threw**, so nothing reached `commissionReviewQueue`.
- `computeSettlement` planned commission 0 and credited the seller **100%** of the gross.

A plan id of `constructor` failed closed instead: it threw, and the webhook queues a throw for review.

**Production: never exercised.** A read-only check of 27 `payments` and 12 `commissionLedger` rows found categories
`product`, `default`, `subscription`, `hair-beauty`, `dj`, `electrical`, and one undefined. None is an inherited name.

## The repair (server authority only)

One helper, `_own(table, key)` (`Object.prototype.hasOwnProperty.call`), is used for the two unguarded reads:
- `resolveRate`: both `RATES` and `ALIASES`;
- `resolveMarketplaceRate`: `MARKETPLACE_TIER_ALIASES`.

An inherited name is now simply an **unknown key**, and gets the authorised fallback: the category default or the
default plan.

What did not change:
- **No table and no rate changed.**
- **No browser file changed.**
- **The rates snapshot is unchanged**, and `--check` still passes text and answers.

## Evidence — `scripts/test-commission-own-property.js`

The suite contains no rate literal: every expectation derives from the authority. The pre-repair resolver is loaded
privately from git (`45bcc44`) as the equivalence baseline.

| part | proves |
|---|---|
| X | **all 12** names `Object.prototype` carries (not just the two reported) resolve as unknown on `resolveRate`, `categoryForHub` and `resolveMarketplaceRate`, with no throw; POS stays guarded |
| E | the **real engine**: category `constructor` / `__proto__` → a finite commission at the category default; the webhook's own `sokoniCut` formula records 500 of KES 10,000, not 0; settlement keeps the commission; plan `constructor` / `__proto__` → the default plan at 15%, no throw |
| Q | **52** legitimate category keys, aliases, unknown and empty inputs, and **19** plan inputs resolve **identically** to the pre-repair resolver; `resolvePosRate` is identical; the tables (`RATES`, `ALIASES`, `MARKETPLACE_PLAN_RATES`, `POS_PLAN_RATES`, minimum, default plan) are byte-identical |
| M | the KES 10 minimum still sets the commission below the 15% crossover; POS is still priced at the till authority's rate |

| tree | result |
|---|---|
| repaired | **20 / 0** |
| old (`45bcc44` export) | **9 / 11 FAIL**: exactly X1–X3 and E1–E4 (NaN commission; `sokoniCut 0`; the whole KES 10,000 to the payee; seller credited 100%; plan lookup throws). It passes only the controls, POS, equivalence and minimum |

**Regressions: none.**

Commission suites, old vs new, identical tallies:

| suite | result |
|---|---|
| parity | 16/0 |
| plan-ladder | 44/0 |
| money chain | 43/0 |
| 5% agreement | 58/0 |
| lane separation | 22/0 |
| invoice | 52/0 |
| settlement authority | 53/0 |
| POS lane | 92/0 |
| POS rail | 80/0 |
| POS sale | 78/0 |

The pre-existing failures are unchanged: 48h destinations 84/3 and balance UI 37/2.

R1–R5 and RES-1, with production rules loaded and nothing skipped:

| suite | result |
|---|---|
| R1 | 39/0 |
| R2 | 26/0 |
| R3 | 21/0 |
| R4 | 33/0 |
| R5 | 32/0 |
| RES-1 option 1 | 23/0 |
| double credit | 66/0 |
| refund | 55/0 |
| escrow | 13/0 |
| RES-1 | GREEN |
| RES-1b | GREEN |
| quote authority | 128/0 |

Predeploy syntax, require-closure, single-source and settled-case gates all pass.

## Found, not changed

- **The browser mirror has the same inherited-name read.** `sokoni-commission-rates.js` `resolve()` uses
  `RATES[k] ? k : (ALIASES[k] || null)`. It is display-only, and browser changes were excluded from this unit. The fix
  belongs in the generator template, as a separate unit.
- **`webhookIntasend` passes `sellerId: payData.uid`, the payer's uid, into `calculateCommission`.** It was observed
  while tracing the call path and not investigated here. It is recorded for the finance/wallet evidence pass.
