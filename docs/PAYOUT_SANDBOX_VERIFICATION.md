# Payout Sandbox Verification — Release Gate

Prove the full instant-payout chain in the **IntaSend sandbox** before enabling
`{ enabled: true, autoB2C: true }` in production. Every stage is observable via the
structured logs (`_plog`) and the payout record — **no manual DB edits, no manual
status changes**. The webhook must complete everything.

Related: [[project_wallet_payout_b2c]] · [[Payments]] · [[Wallet]]

---

## 0. Pre-requisites

1. **Sandbox mode**: set the functions env `INTASEND_SANDBOX=true` (the B2C helper
   switches to `https://sandbox.intasend.com`). Confirm `INTASEND_PRIVATE_KEY` is a
   **sandbox** key and the sandbox **send-money (B2C) wallet is funded**.
2. **IntaSend dashboard → Webhooks**: URL = `https://…/webhookIntasend`, challenge set
   to the value in `INTASEND_WEBHOOK_CHALLENGE`, events include transfers/B2C.
3. **Config** (`config/payouts`): start conservative.
   ```json
   { "enabled": true, "autoB2C": true, "instantLimit": 5000,
     "requirePin": true, "holdNewSellersDays": 7, "dailyLimit": 50000, "scheduledAbove": 0 }
   ```
4. Use a **verified sandbox seller** with a wallet balance, a set PIN, no open dispute,
   account older than `holdNewSellersDays`.

---

## 1. Run ONE sandbox withdrawal and verify every stage

Trigger a real withdrawal from the app (Wallet → Withdraw → enter amount ≤ instantLimit
→ PIN). Then confirm each stage below. The `correlationId` (== the payout `requestId`,
`pout_…`) threads everything — grep logs by it.

| # | Stage | How to verify (no edits) |
|---|-------|--------------------------|
| 1 | Seller requests | `_plog` line `stage:"requested"`/`"risk"`; payout doc created |
| 2 | Available → Pending | `wallets/{uid}`: `balance` ↓, `pendingPayout` ↑ by amount |
| 3 | Risk = Instant | `_plog stage:"risk"` shows `mode:"instant", reasons:[]`; doc `mode:"instant"` |
| 4 | B2C request succeeds | `_plog stage:"b2c_ok"`; no `b2c_failed`/`b2c_retry` |
| 5 | `intasendRef` stored | payout doc `intasendRef` set; `b2cResponse` present |
| 6 | Webhook reaches us | log `[webhookIntasend] raw payload: …`; `_plog stage:"webhook_received"` |
| 7 | Processing → Paid | `_plog stage:"paid"`; doc `status:"paid"` (set by the **webhook**, not by hand) |
| 8 | Pending decreases | `wallets/{uid}.pendingPayout` ↓ back by amount (balance already debited at request) |
| 9 | Transaction history | `walletTransactions/{uid}_{reqId}_payout` exists, `type:"payout"`, `status:"completed"` |
| 10 | Dashboard updates | `walletV2Dashboard` returns updated `pendingPayout`, `todayPaid`, `monthPaid` |
| 11 | In-app notification | notification delivered (type `payout_paid`) |
| 12 | SMS delivered | seller receives the SMS (via `notify.js`) |
| 13 | Analytics record | `payoutMetrics/{today}`: `paid`↑, latency sample; `getPayoutAnalytics` reflects it |
| 14 | Reconcile ignores paid | after 30 min, `reconcilePayouts` does NOT flag it (terminal state skipped) |

### Live monitoring commands

```bash
# All structured stages for one payout (replace REQ = the pout_… id)
gcloud logging read 'resource.labels.service_name=~"requestsellerpayout|webhookintasend|processpayoutretries" AND textPayload:"REQ"' \
  --project sokoni-aeb26 --freshness=1h --limit=50 --format="value(timestamp,textPayload)"

# The raw webhook payload as IntaSend actually sent it
gcloud logging read 'resource.labels.service_name="webhookintasend" AND textPayload:"raw payload"' \
  --project sokoni-aeb26 --freshness=1h --limit=10 --format="value(timestamp,textPayload)"

# The payout record (status, intasendRef, statusHistory, webhookEvents)
#   → read payoutRequests/REQ in the Firebase console, or via the REST API.
```

### ⚠️ The one thing to watch: webhook field shape
`finalizeB2CPayoutFromWebhook` matches the payout by **`api_ref` (== our reqId)** or
**`intasendRef` (tracking_id)**, and reads **`state`**. If the sandbox `raw payload`
log shows different field names (e.g. status under a different key, or the ref only in
`invoice.invoice_id`), **that's the adaptation point** — send the raw payload and the
matcher/state extraction gets a one-line adjust. Until stage 7 flips to `paid`
*by the webhook*, the gate is NOT passed.

---

## 2. Verify retry behaviour (transient vs permanent)

- **Transient**: simulate by pointing at an unreachable sandbox base or forcing a 5xx →
  expect `_plog stage:"b2c_retry"`, doc `status:"retry_scheduled"` with `retryAt` +
  `retryCount`, then `processPayoutRetries` (every 5 min) re-runs with exponential
  backoff (2→4→8→16 min, cap 30), max 4 tries, then Failed + refund.
- **Permanent**: withdraw to a clearly invalid/unregistered number → expect
  `_plog stage:"b2c_failed" kind:"permanent"`, doc `status:"failed"`, funds **refunded**
  to the wallet (balance restored, pendingPayout released). No retries.

---

## 3. Production rollout ladder

1. Sandbox stages 1–14 + retry all green → enable in **production** with `instantLimit: 5000`.
2. Monitor several days: `getPayoutAnalytics` — `instantSuccessRate` high, `reconciliationExceptions` ≈ 0, `avgPayoutSeconds` sane, `reversed` ≈ 0.
3. Raise `instantLimit` → 10000 → 20000 gradually. **Never** all-amounts on day one.
4. Keep admin review for anything above the limit or flagged (already the default path).

**Do not enable production flags until §1 stage 7 (Paid set by the webhook) and §2 both pass.**
