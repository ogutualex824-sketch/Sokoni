# Production wallet lineage reconciliation

**Status:** 2026-09-26, read-only. **`wallet.js` was not modified.** Related:
[[PRODUCTION_PAYMENT_LINEAGE_MAP]], [[WALLET_FREEZE_ACCEPTANCE]], [[PAYOUT_OUTCOME_UNKNOWN]].

## Serving vs release

| | Blob | Introduced by |
|---|---|---|
| Serving `wallet.js` (in the `requestSellerPayout`, `initiateSTKPush`, `createPaymentIntent` archives) | `5b558d43a3…` | `33031f2` (2026-08-03) |
| `release/comms-on-live` `618aadd` | identical | — |
| `ship/catalogue-port-on-live` `61912dd` | identical | — |
| Candidate `4770c5c` | differs (+342 / −100 vs `111dbd7`) | Creator payout repair (`61098e9`, `4770c5c`) |
| Serving `wallet.js` in the `fosSubmitRefund` / `adminOsDispatch` archives | `7331b27ea6…` → `7f60746` (older) | refunds/AdminOS were deployed from an older tree; they do not export payout callables |

**`requestSellerPayout`'s full closure (13 files)** is byte-identical to `61912dd` (13/13); against
`618aadd` it differs only in `notify.js` (payout notifications). So the frozen wallet authority itself
is already reproduced by the release lineage.

## Does convergence need a wallet change?

No — the serving wallet is already on both release branches. **Creator Hub does** (not part of
convergence): the candidate's `wallet.js` carries the payout `outcome_unknown` repair
(`_markOutcomeUnknown`, `adminResolvePayoutOutcome`, `processPayoutRetries` retired to a parker,
`adminProcessPayout` refusals, `_settlePayoutPaid` / `_refundPayout` terminal guards) and the dedupe
ownership check. Those are money-affecting changes to a frozen file and require a separate
**wallet-freeze acceptance** slice; they were not applied here.

| Candidate change | Money impact | Needs freeze release |
|---|---|---|
| ambiguous B2C → `outcome_unknown` (no resend) | removes a double-payout path | yes |
| legacy `retry_scheduled` parked, never re-sent | same | yes |
| `adminResolvePayoutOutcome` (Super Admin + evidence) | new settlement path, exactly-once | yes |
| settle refuses `rejected/failed/reversed`; refund treats `settled_manually/reversed` terminal | removes double-outcome paths | yes |
| dedupe hit must be the caller's payout | refuses a cross-account key | yes |

Evidence for these (local): `test-payout-outcome-unknown.js` 62/0 (W1–W3E), `test-withdrawal-browser.js`
23/0, sabotage mutations in `sabotage-creator-hub.js` (payout + gaps groups) all CAUGHT.
