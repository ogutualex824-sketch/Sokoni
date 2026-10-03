# bookingDispatch — client paymentId hotfix, full-copy rebuild (2026-10-03)

Owner decision 2026-10-03: **full-copy rebuild**, all five safety checks executed; the three-check shortcut is rejected.

## What changes
`bookingCreate` (inside `bookingDispatch`) no longer accepts a client-supplied `paymentId`. The old check marked a venue
booking **paid** if *any* of the caller's terminal payments covered the total — without creating its `venueSettlements`
row, so the venue owner was never paid. A venue booking is now paid only through its own intent
(`venue_booking` → verified webhook → `venueOnBookingPayment`). Production `bookings` = 0 documents at census time.

## Exact live version captured
`bookingDispatch` — gen `1787386103968834`, ACTIVE, updated `2026-09-09T06:01:19Z`.
Local copy: `C:/temp/live-archives/bookingDispatch-1787386103968834`. Re-check immediately before launch; if it moved, STOP.

## Full working tree
Base `e67cd0c` — the full tree `processTypesenseQueue` was deployed from on 2026-10-03 (all five gates ran).
Changes on top (commit `e08f579`):
- `functions/booking.js` — the fix (only intended behaviour change).
- `functions/notify.js` — **pinned to the LIVE bytes**. The base tree's newer `notify.js` adds an SMS phone fallback
  (booking SMS would start reaching users that production silently skips) — an unintended behaviour change.
- `scripts/test-booking-payment-auth.js` — the fix's test.

## Live vs proposed — behaviour comparison
`bookingDispatch` transitive require closure (entry `booking-dispatch.js`):

| | count |
|---|---|
| live closure | 16 |
| candidate closure | 15 |
| byte-identical | 14 |
| differs | `booking.js` (the fix) |
| only in live | `shared/constants.js` — used only by the removed client-paymentId code |
| only in candidate | none |

- `index.js` bookingDispatch wiring: identical.
- `package-lock.json` resolves `firebase-admin 13.10.0`, `firebase-functions 7.2.5`, `@google-cloud/firestore 7.11.6`,
  `google-auth-library 9.15.1` identically (the explicit `google-auth-library` entry only pins an already-resolved version).
- Environment: deploy with the LIVE archive `.env` values; verify with `scripts/infra/env-parity-check.js bookingdispatch`.

## Five safety checks — executed on this tree
| gate | result |
|---|---|
| `gate-functions-require-closure` | PASS — entrypoint graph closes from a clean checkout of HEAD |
| `predeploy-syntax-gate` | PASS — 1938 JS files, 441 inline blocks parse |
| `verify-commission-single-source` | PASS — one commission table |
| `verify-delivery-engine-sync` | PASS (5ed76ec286fc) |
| `predeploy-payout-gate` | PASS — 0 mismatches |

## Tests and deliberate breaks
`scripts/test-booking-payment-auth.js` — **8/8**: invented reference, another customer's payment, unpaid, refunded,
cheaper payment replayed, the caller's own genuine payment (the hole), overpayment → all refused
(`client_payment_not_accepted`, booking stays `awaiting`); no paymentId → awaiting.
**Mutant:** the same test against the LIVE `booking.js` FAILS on every forgery case — the hole is real in production.

## Deploy (f3, one deploy at a time)
Config `firebase.bkdeploy.json` (relative hooks, `.env` ignored; untracked, copy of the processTypesenseQueue config).
`npx firebase deploy --config firebase.bkdeploy.json --project sokoni-aeb26 --only functions:bookingDispatch --non-interactive`
— accept only with every gate banner in the log. After: env parity, download the new live archive and diff it against
this tree, smoke (`bookingCreate` with a paymentId → booking `awaiting`, note `client_payment_not_accepted`), restore
`.env`, remove the junction. Rollback anchor: the serving revision recorded before launch (rollback by name, Ready first).
