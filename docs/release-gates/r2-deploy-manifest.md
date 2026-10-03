# release/marketing-functions-r2 — deploy manifest (DRAFT, nothing deployable yet)

Owner decision 2026-10-03: r2 is cut from the commercial line (one canonical commission table across the release).
**Status: NOT certified.** Owner sequence A → F must complete first (commercial base → Marketing (b2) → approval /
capability / PIN (5b) → live comparison per changed function → all tests incl. emulator settlement and browser E2E ≥ 700 MB
→ deploy).

## Never deployed from r2
| function | ships from | why |
|---|---|---|
| `webhookIntasend` (and every IntaSend webhook handler) | 5b — `fix/webhook-commission-category-on-73c5e5e` cd2482b (#2), then `feat/webhook-rental-hold-on-73c5e5e` 2016051 (#4) | r2 lacks `shared/commission-category-source.js` and `rental-payment-hold.js`; deploying it from r2 would roll back the server-side commission-category fix, the rental hold and the rental receipt |
| `intasendWebhook` | — | its own P0-4 lifecycle gate |
| `processTypesenseQueue` | `fix/typesense-verified-badge-on-032e88e` (live 00023-yin) | already live from its own tree |
| `bookingDispatch` | `fix/bookingdispatch-paymentid-fulltree` ae4f084 (f3's queue) | full-copy rebuild, closure == live except booking.js |
| any function not listed in "Candidate scope" below | — | scoped deploys only; a function absent from this list is out of scope, not retired |

`firebase deploy` WITHOUT `--only functions:<names>` is forbidden for this tree.

## Candidate scope (to be fixed by the live comparison, step D)
To be filled per function with: live generation · live archive path · closure diff vs r2 · every live-only behaviour
preserved or deliberately retired (documented).
Expected members (not final): providerDispatch (provider-ops: PIN port + settlement authority), bookingCreateService
path, createPaymentIntent (rental_booking / rfq_quote snapshots), myTransactionReceipts + providerLedger,
requestSellerPayout + processPayoutRetries + processPendingPayouts + autoScheduledPayouts + initiateSellerPayout
(the ONE withdrawal gate), sub-billing reads.

## Hard stops (owner)
- the candidate can compute Marketing at 15% → no deploy;
- emulator settlement tests not run → no deploy;
- browser tests run below 700 MB → invalid;
- live-vs-proposed comparison incomplete, or any unexplained difference → no deploy.
