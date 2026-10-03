# release/marketing-functions-r2 — deploy manifest (DRAFT, nothing deployable yet)

Owner decision 2026-10-03: r2 is cut from the commercial line (one canonical commission table across the release).
**Status: NOT certified.** Owner sequence A → F must complete first (commercial base → Marketing (b2) → approval /
capability / PIN (5b) → live comparison per changed function → all tests incl. emulator settlement and browser E2E ≥ 700 MB
→ deploy).

## Webhook

`webhookIntasend: NOT DEPLOYED` (from r2). r2 CARRIES the webhook region of 5b's #4 `f0fca5c` (branch `feat/webhook-rental-hold-on-73c5e5e`, which contains #2 `f26c80a` = fast-forward of `cd2482b` on `fix/webhook-no-payer-credit-on-7428465`), 3-way merged against the LIVE webhook (`8574f5d`, 09-06 floor) — so r2 holds no stale copy — but the webhook SHIPS from 5b's tree. **Mechanical control:** `scripts/deploy/guard-r2-scope.js` is the FIRST predeploy hook in both `firebase.json` and `firebase.r2deploy.json` (relative form, executes); it ABORTS a bare/unscoped deploy and any webhook / own-tree function. Deploy only via `node scripts/deploy/r2-deploy.js <fn,...>`; accept only with `R2 SCOPE GUARD: PASS` in the log. Test: `scripts/test-r2-deploy-guard.js` (G1–G5).

## Never deployed from r2
| function | ships from | why |
|---|---|---|
| `webhookIntasend` (and every IntaSend webhook handler) | 5b — #2 `f26c80a` (`fix/webhook-no-payer-credit-on-7428465`, ff of `cd2482b`), then #4 `f0fca5c` (`feat/webhook-rental-hold-on-73c5e5e`) | 5b owns the webhook release (its Layer-B handler rows must run green on 5b's tree first). r2 carries a merged copy only so it holds no stale webhook; the guard refuses deploying it from r2 |
| `intasendWebhook` | — | its own P0-4 lifecycle gate |
| `processTypesenseQueue` | `fix/typesense-verified-badge-on-032e88e` (live 00023-yin) | already live from its own tree |
| `bookingDispatch` | `fix/bookingdispatch-paymentid-fulltree` ae4f084 (f3's queue) | full-copy rebuild, closure == live except booking.js |
| `applicationDecide`, `applicationReconcile`, `applicationLifecycle` | production (K13-A live) until 5b's stage (c) lands on r2 | r2's application-lifecycle.js has NO K13-A (_authoritativeDecision / SELF_DECISION absent) — deploying from r2 would reopen admin self-approval and status-only approval; refused by guard-r2-scope (G6) |
| `sportsDispatch`, `sportsFixtureReminders` | — (owner hold) | Sports is held: NOT DEPLOYED from r2 unless the owner approves; refused by guard-r2-scope (G6) |
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
