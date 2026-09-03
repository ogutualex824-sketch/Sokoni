# Which IntaSend webhook is actually live — resolved from production logs

**Status:** 📋 READ-ONLY. Cloud Logging reads only. No code, no config, no dashboard setting
changed. Q1 of the ordering set for the SOKONI Till/QR gate
(`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md`).
**Date:** 2026-09-03

**This corrects, not repeats, a characterization in the prior trace.** That document called
`intasendWebhook`/`webhookIntasend` "two near-identical exported functions" and left which one is
authoritative "out of scope." Both halves of that were wrong: they are not near-identical (one is
2.5x longer and materially more capable), and live evidence settles the authority question
decisively. See the correction note added to that document.

---

## The documentation was split, so it was not trusted

A repo-wide search found the two names asserted as "the registered one" in different documents,
written at different times, contradicting each other:

- **Naming `webhookIntasend`**: `docs/WEBHOOK.md`, `docs/API.md`, `docs/GO_LIVE_CHECKLIST.md`,
  `docs/PAYOUT_SANDBOX_VERIFICATION.md`, `docs/INTASEND_WEBHOOK_AUDIT.md`,
  `docs/PRODUCTION_READINESS.md`, `docs/ARCHITECTURE_ACTIVATION.md`, `ARCHITECTURE.md`.
- **Naming/planning a move to `intasendWebhook`**: `DISASTER_RECOVERY_PLAYBOOK.md`,
  `docs/WEBHOOK_FIX_RUNBOOK.md`, `docs/RIDER_EARNINGS_AUTHORITY.md` (*"production webhook is
  repointed to `/intasendWebhook`. This work therefore gates that change."* — a stated dependency
  on a repoint that this evidence shows never completed, or was reverted).
- **`scripts/certify-payment.js`** — a ready-made read-only diagnostic script, built for exactly
  this question — asserts in its own header comment: *"`webhookIntasend` -> appends to
  `webhookPayments` and nothing else. No order, no ledger, no settlement."* **This is checked
  below and found to be stale** — current `webhookIntasend` does none of that; it does
  everything, including things `intasendWebhook` does not.

Given the split, the question was resolved from **production evidence**, not from any of these
documents, per the standing rule to verify rather than trust prior documentation.

## Source comparison — not "near-identical," and not what the diagnostic script assumed

Both functions extracted to isolated bodies and measured directly (not estimated):

| | `intasendWebhook` (`functions/index.js:6918`) | `webhookIntasend` (`functions/index.js:8028`) |
|---|---|---|
| body length | 254 lines | **624 lines** |
| challenge verify, B2C payout, wallet top-up, `payments/{ref}` transactional COMPLETE claim | yes | yes |
| commission ledger (`commissionLedger/{apiRef}`) | yes | yes |
| **seller wallet credit** (`creditWalletTxn` / direct `wallets/{uid}.balance` increment for bookings) | **no** | **yes** — with an explicit idempotency guard (`walletCreditedAt`) |
| **marketplace order finalisation** (`_finalizeMarketplacePayment`, `posReceipts/{apiRef}`, seller `clickAndCollect` signal, `packageRequests` delivery dispatch) | **no** | **yes** |
| **service booking creation** (`bookings/{apiRef}` + buyer/provider notifications) | **no** | **yes** |
| subscription activation | yes (writes `subscriptions/{uid}` only) | yes, **plus** `materialiseEntitlements(...)` — with a comment describing a real, already-fixed incident: *"the seller UI reads `users/{uid}.subscription.seller`... this path never invoked... showed a 10-product limit to a merchant who had paid for 100."* |
| entitlement shadow-comparison | no | yes |

**`webhookIntasend` is a strict superset of `intasendWebhook`'s functionality, plus real
incident fixes `intasendWebhook` never received.** It is the newer, actively-maintained one,
despite the naming making it look like the "second" or lesser-named variant.

## Production evidence — 30-day Cloud Run logs, both services

Cloud Run service names confirmed (`gcloud run services list`): `intasendwebhook` and
`webhookintasend`.

| | `intasendwebhook` | `webhookintasend` |
|---|---|---|
| POST requests, last 30d | 18 | 57 |
| HTTP status breakdown | **18× `401 Unauthorized`** | 47× `200 OK`, 10× `400` (missing `api_ref` — a valid response for non-payment payload shapes) |
| "raw payload" log lines (only logged once the challenge check passes) | **zero** | present — real IntaSend B2C payout status payloads observed verbatim: `{"file_id":"Y5QZM55","tracking_id":"...","status":"Completed"/"Processing payment"/"Sending payment",...}` |

**Every single request `intasendwebhook` received in 30 days failed the challenge check.** Not
some — all of them. No payload was ever logged, because the code only logs the payload after the
challenge passes. This is not "occasionally misconfigured" — it has never once successfully
authenticated a request in the entire retained log window.

**`webhookintasend` received real, successfully-authenticated IntaSend traffic** — visibly a real
B2C send-money status sequence, the exact shape `finalizeB2CPayoutFromWebhook` is built to parse.

## Conclusion

**`webhookIntasend` (`functions/index.js:8028`, Cloud Run service `webhookintasend`) is the
actual, currently-configured, production IntaSend webhook endpoint.** `intasendWebhook` is not
receiving valid, correctly-challenged traffic from IntaSend — whatever hits it (18 requests, all
401) is not IntaSend's dashboard calling it correctly, and it is also the functionally
incomplete one of the pair.

This settles Q1 for the SOKONI Till/QR gate: **any new Till/QR payment flow must integrate with
`webhookIntasend`'s logic** (or a shared module both could call, if the pair is ever converged) —
not `intasendWebhook`, and not by assuming either name from its label.

## What this does NOT do

Does not change either function. Does not touch the IntaSend dashboard. Does not converge or
delete either handler — that decision (keep both? retire `intasendWebhook`? extract shared logic?)
is separate, future work, out of scope for the Till/QR gate. Does not correct the stale
`certify-payment.js` comment or the split documentation set (`WEBHOOK_FIX_RUNBOOK.md`,
`RIDER_EARNINGS_AUTHORITY.md`'s stated dependency, etc.) — flagged here, not fixed. Does not
touch `firestore.rules` or any payment code. Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SOKONI_TILL_QR_PAYMENT_TRACE.md` (corrected by this finding — see its dated note) ·
`scripts/certify-payment.js` (its endpoint-discriminator comment is stale; the tool's actual
Firestore-based check — presence of `webhookReceivedAt` — remains valid evidence, since *both*
functions write that field, but its assumption about which endpoint is "the no-op" is wrong)
