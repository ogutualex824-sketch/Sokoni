# `intasendWebhook` Retirement — Repository-Wide Census

**Date:** 2026-09-14 · **Branch:** `release/multishop-checkout-certified` · **Base:** `98059f8`
**Status:** READ-ONLY census. **No code changed. Nothing deployed. No function deleted.**

Related: [[P3A_CENSUS_INTASEND_POS_ASSOCIATION]] · [[INTASEND_WEBHOOK_ENDPOINT_RESOLUTION]] ·
[[INTASEND_WEBHOOK_AUDIT]] · [[project_two_intasend_webhooks_diverge]] · [[Payments]]

---

## 0. A correction to the P3-A census, stated first

P3-A's census said `intasendWebhook` had **"never received one"** callback in 180 days. That
measurement filtered Cloud Logging on the `raw payload` line — which the handler writes **after**
the challenge gate. It therefore measured *callbacks that authenticated*, not *requests received*.

**Measured properly, `intasendWebhook` received 49 requests in 180 days.** The conclusion is
unchanged and in fact strengthened, but the earlier phrasing was wrong and is corrected here
rather than quietly restated.

---

## 1. Production traffic — the decisive comparison

Both Cloud Run services, 180 days, every HTTP request regardless of outcome:

| | `intasendWebhook` | `webhookIntasend` (live) |
|---|---|---|
| `157.245.201.212` — **IntaSend's server** | **never, not once** | **14 × 200**, 10 × 400 |
| `197.237.85.87` (Kenya) | 33 × 401 POST, 14 × 405 GET | 5 × 401 POST, 1 × 405 GET `curl/8.19.0` |
| `197.237.21.106` (Kenya) | 2 × 401 POST | 2 × 401 POST |
| **Successful (2xx) responses** | **ZERO** | 14 |

**This is stronger evidence than "no traffic".** The question is not whether the endpoint is quiet
— it is whether an external system depends on it. The external system that matters is IntaSend,
and IntaSend's server has **provably never called `intasendWebhook`**, while calling
`webhookIntasend` successfully fourteen times.

Every request `intasendWebhook` did receive came from the same two Kenyan addresses that also
probe the live handler and get 401s — one of them identifying as `curl/8.19.0`. Those are the
runbook commands in this repository (`docs/WEBHOOK_FIX_RUNBOOK.md` lines 116, 122, 169 and
`DISASTER_RECOVERY_PLAYBOOK.md:371` are literally `curl -X POST …/intasendWebhook`). **The only
thing calling this endpoint is our own documentation.**

The `405`s are `GET` requests — a browser or a probe opening the URL, not a webhook.

---

## 2. It has never written anything in production

`intasendWebhook` and `webhookIntasend` tag their writes differently — `source: "intasend_webhook"`
(3 sites) versus `source: "webhookIntasend"` (6 sites). That divergence is a **fingerprint**.

| Query on production Firestore | `source: "intasend_webhook"` | `source: "webhookIntasend"` |
|---|---:|---:|
| `commissionLedger` | **0** | **10** |
| `subscriptionAuditLog` | **0** | **1** |

The right-hand column is the **positive control**: the same query, same mechanism, returning
non-zero. Without it, "0" would be indistinguishable from a broken query. The zero is a real zero.

This agrees with the log evidence by an independent route: a `401` returns **before any write**, so
a handler that has only ever returned 401/405 cannot have written — and nothing in the database
bears its mark.

---

## 3. It is a strict subset — enumerated, not hand-checked

`intasendWebhook` is **260 lines**; `webhookIntasend` is **786**.

Collections enumerated **mechanically** from each handler's body:

```
intasendWebhook : commissionLedger, commissionReviewQueue, paymentIntents,
                  payments, subscriptionAuditLog, subscriptions

webhookIntasend : ALL OF THE ABOVE, plus
                  bookings, clickAndCollect, deliveryPins, orders,
                  packageRequests, posReceipts, sellers,
                  walletTransactions, wallets
```

**Collections unique to `intasendWebhook`: NONE.**
**Helper functions unique to `intasendWebhook`: NONE.**

With comments stripped, **10 of 144 functional lines** differ, and every one is accounted for:

* four are identical logic with a different log tag (`[intasendWebhook]` vs `[webhookIntasend]`);
* one is `if (!snap.exists) { res.status(200).send("OK"); return; }` — unique only because
  **P3-A deliberately changed that line in `webhookIntasend`** to add the POS QR association;
* four are the `source: "intasend_webhook"` provenance tag discussed above;
* one is a commission-write error log.

**There is no behaviour in `intasendWebhook` that `webhookIntasend` does not have.**

---

## 4. Impact assessment against each named area

| Area | Affected by removing `intasendWebhook`? | Why |
|---|---|---|
| IntaSend online payments | **No** | IntaSend calls `webhookIntasend`; the claim transaction, commission and intent handling are all present there |
| POS QR association (P3-A) | **No** | P3-A is wired into `webhookIntasend` only, by design |
| P1 verification | **No** | P1 queries IntaSend directly from `completePOSQRPayment`; it never depends on a callback |
| Refunds | **No** | `initiateRefund` is a separate callable; neither handler touches it |
| Wallet payments / top-ups | **No** | `_finalizeWalletTopUp` is a shared module-level helper called by BOTH; `webhookIntasend` additionally credits seller wallets, which `intasendWebhook` cannot |
| Reconciliation | **No** | `payment-reconciliation.js:53` names it only in a comment listing intent readers |
| Webhook retries / idempotency | **No** | Both use the same transactional claim on `payments/{apiRef}`; the live one keeps it |

**B2C payouts deserve their own note.** Both handlers call `finalizeB2CPayoutFromWebhook`, under a
comment reading *"the docs disagreed on which webhook IntaSend hits, so BOTH webhooks now settle
B2C — whichever URL is registered, a confirmation reconciles."* That was a **deliberate hedge
against not knowing which endpoint was live.** The census resolves the uncertainty the hedge
existed for, so removing the unused half does not remove the capability — it removes a duplicate
of it.

---

## 5. External-registration risk: the actual finding

No external registration **exists**. But the repository **ships eight instructions to create one**:

| Location | What it says |
|---|---|
| `functions/package.json:60` | `"webhook_url": "Register https://…/intasendWebhook as your IntaSend webhook URL"` |
| `docs/GO_LIVE_CHECKLIST.md:74` | "IS-5 — Webhook URL confirmed: …/intasendWebhook" |
| `DISASTER_RECOVERY_PLAYBOOK.md:161` | "Webhook URL (…/intasendWebhook) **is registered**" |
| `DISASTER_RECOVERY_PLAYBOOK.md:371` | `curl -X POST …/intasendWebhook` |
| `docs/WEBHOOK_FIX_RUNBOOK.md:116, 122, 169` | three `curl -X POST …/intasendWebhook` |
| `INFRA_CHECKLIST.md:123` | `…sokoni-**app**.cloudfunctions.net/intasendWebhook` — **a different project**, stale |

`functions/package.json:60` is the sharp one: a registration instruction shipped **inside a
package manifest**, where nobody looks for prose.

**Two documents state an active intention to repoint production AT this endpoint:**

* `docs/RIDER_EARNINGS_AUTHORITY.md:35` — *"production webhook is repointed to `/intasendWebhook`.
  **This work therefore gates that change.**"*
* `scripts/certify-payment.js:196` — *"Repoint it at /intasendWebhook and re-run this trace."*

These do not create a dependency today, but they are exactly the mechanism that produced the D3
deadlock: **published instructions become third-party registrations, and a registration cannot be
revoked from this repository.** Removing the handler while these stand invites someone to point
production at a URL that no longer answers.

**They must be part of the gate, not a follow-up.** D1 removed Daraja's callback URLs and left the
instructions telling merchants to register them; the Daraja UI gate had to come back and finish it.

---

## 6. A name collision that would break a careless removal

`functions/pos-terminal-live.js` defines **`_intasendWebhook`** at line 971, dispatched from line
938. It is **unrelated**: a POS card-terminal vendor driver operating on
`posTerminalTransactions`, reading `{invoice_id, state, charges, net_amount}`. It is not an export,
not a webhook endpoint, and not part of this retirement.

A name-based sweep would delete it. **It must be asserted untouched.**

---

## 7. Deployment and client surfaces

| Surface | Reference | Disposition |
|---|---|---|
| `functions/package.json:10` | `deploy:payment` npm script names it | remove from the script |
| `deploy-batches.ps1:33` | deploy batch list | remove |
| `scripts/batch_deploy.sh:72` | deploy batch list | remove |
| `scripts/deploy/functions-allowlist.js` | **not present** | nothing to do |
| `sokoni-endpoints.js:37` | client endpoint registry entry | remove — and note **no HTML file loads this file at all** |
| `.fnlist.txt:1312` | stale July artefact | leave; it is a cache, not a source |

---

## 8. Attribution

| File | State |
|---|---|
| `functions/index.js` | **DIRTY +109/−5** — another agent's four hunks; requires content-marker hunk isolation with mixed-hunk detection |
| `functions/package.json` | clean |
| `deploy-batches.ps1` | clean |
| `scripts/batch_deploy.sh` | clean |
| `sokoni-endpoints.js` | clean |
| `functions/pos-terminal-live.js` | clean — **and must stay untouched** |

---

## 9. Verdict and proposed scope

Every test the gate set has been met:

```
zero successful requests, ever                    ✔  49 requests, all 401/405
IntaSend's server never called it                 ✔  157.245.201.212 → webhookIntasend only
zero production writes                            ✔  0 fingerprinted docs, positive control 11
zero unique collections                           ✔  strict subset, enumerated
zero unique helpers                               ✔
zero unique behaviour                             ✔  10/144 lines: log tags + P3-A + provenance
no external registration                          ✔  by IP evidence, not by repo search
```

**Proposed removal:** `exports.intasendWebhook` from `functions/index.js`; its entries in
`functions/package.json`, `deploy-batches.ps1`, `scripts/batch_deploy.sh`, `sokoni-endpoints.js`;
and **all eight registration instructions**, including the two documents that plan to repoint
production at it.

**Explicitly preserved:** `webhookIntasend` (byte-identical apart from P3-A's authorized
association), `verifyIntasendPayment`, `_finalizeWalletTopUp` and every other shared helper,
`functions/pos-terminal-live.js`'s unrelated `_intasendWebhook`, all Daraja inbound handlers, and
every historical payment record.

**Repository retirement is not production deletion.** The deployed `intasendWebhook` Cloud Run
service stays until a separate, explicitly authorized action removes it — the same boundary D1 and
entry 65 established.
