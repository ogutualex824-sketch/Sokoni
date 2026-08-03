# Wallet Backend v1.0 — Freeze Acceptance Record

**Purpose:** the auditable evidence that the wallet backend money paths were proven in
production before `wallet-backend-v1.0-frozen` was tagged. No tag until every section
below is **PASS** with the live IDs attached.

**Rule after freeze:** no changes to ledger, payout, transfer, reconciliation, webhook, or
balance-calculation logic except critical security or production bug fixes. Everything else
is Phase-2 (frontend/UX).

---

## Automated suites (CI + pre-freeze gate) — GREEN

| Suite | Command | Result |
|---|---|---|
| Payout reconciliation (0 mismatches) | `node scripts/reconcile-payouts.js` | ✅ PASS |
| Wallet reconciliation report | `node scripts/wallet-reconciliation-report.js` | ✅ PASS |
| B2C webhook classification (12) | `node scripts/test-b2c-webhook-classification.js` | ✅ PASS |
| Claimable transfer invariants (16) | `node scripts/test-claimable-transfers.js` | ✅ PASS |
| Freeze gate (composes all + live proofs) | `node scripts/wallet-freeze-gate.js` | ⛔ RED until live proofs below |

Already proven with real money (earlier this cycle):
- **Withdraw (wallet → M-Pesa):** payout `pout_xrH2…1785746119` → gateway `Completed` → PAID; M-Pesa ref `d5fe8a68`; reconcile 0 mismatches. **PASS**
- **Top-up (M-Pesa → wallet), latency build:** tx `wtop_msd2pvz9_jzwl85`, invoice `Y72N8X5`; STK `method:'M-PESA'` → `PENDING` → completed; +10 exactly once; reconcile clean. **PASS**

---

## 1. Registered wallet → wallet   — Result: ⬜ PENDING

| Field | Value |
|---|---|
| Live transfer ID (`txOut`) | `____` |
| Sender UID | `____` |
| Receiver UID | `____` |
| Ledger debit ID (`snd_…`) | `____` |
| Ledger credit ID (`rcv_…`) | `____` |
| Transfer document ID | `____` |
| Sender balance before → after | `____ → ____` |
| Receiver balance before → after | `____ → ____` |

## 2. Claimable transfer (send to unregistered)   — Result: ⬜ PENDING

| Field | Value |
|---|---|
| claimableTransfer ID (`clm_…`) | `____` |
| SMS provider message ID | `____` |
| Escrow amount | `____` |
| Sender debit ledger ID (`snd_…`, `pending_claim`) | `____` |
| Recipient wallet unchanged? | `____` |
| Sender balance before → after | `____ → ____` |

## 3. Claim flow   — Result: ⬜ PENDING

| Field | Value |
|---|---|
| Recipient UID | `____` |
| Phone verification timestamp | `____` |
| Claim timestamp | `____` |
| Credit ledger ID (`rcv_…`) | `____` |
| Escrow status = `claimed`? | `____` |
| Replay attempt result (must be no-op) | `____` |

## 4. Idempotency (double-approve payout)   — Result: ⬜ PENDING

| Field | Value | Expected |
|---|---|---|
| Payout ID | `____` | — |
| Number of approve clicks | `____` | 2 |
| Gateway request count | `____` | 1 |
| Gateway reference | `____` | 1 |
| B2C reference | `____` | 1 |
| Ledger debits created | `____` | 1 |

---

## Final reconciliation — signed

Run `node scripts/wallet-reconciliation-report.js` and `node scripts/reconcile-payouts.js`.

| Check | Result |
|---|---|
| Wallet balances reconcile (no negatives / structural) | ⬜ |
| Ledger conservation (claimable invariants 16/16) | ⬜ |
| Negative balances = 0 | ⬜ |
| Duplicate transfers = 0 | ⬜ |
| Duplicate payouts = 0 | ⬜ |
| Orphan ledger rows = 0 | ⬜ |
| Claimable expiry (none past-expiry pending) | ⬜ |
| Replay protection (idempotency/regression suites) | ⬜ |

---

## Freeze record — fill at tag time

| Field | Value |
|---|---|
| Commit hash | `____` |
| Deployment ID / revision | `____` |
| Date / time (EAT) | `____` |
| Reconciliation hash (`sha256:` from the report) | `____` |
| Tag | `wallet-backend-v1.0-frozen` |

> Tag command (run ONLY when every section above is PASS):
> `git tag -a wallet-backend-v1.0-frozen -m "Wallet backend v1.0 frozen — see docs/WALLET_FREEZE_ACCEPTANCE.md"`
