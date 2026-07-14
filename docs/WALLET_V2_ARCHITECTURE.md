# SOKONI Wallet 2.0 — Architecture Reference

**Status:** Production Engineering Complete  
**Date:** 2026-07-14  
**Version:** 2.0.0  
**Lead:** SOKONI Engineering

---

## 1. Overview

Wallet 2.0 transforms the basic top-up/payout interface into the financial operating system for the entire SOKONI ecosystem. It is designed to serve buyers, sellers, merchants, riders, and businesses from a single unified wallet architecture.

**Design principles:**
- Backward compatible — all v1 Cloud Functions (`initiateWalletTopUp`, `confirmWalletTopUp`, `getWalletTransactions`, `requestSellerPayout`, `getPayoutHistory`) continue to work unchanged
- Extend, don't rebuild — new collections are additive; existing `wallets/{uid}` fields are preserved
- Single source of truth — `wallets/{uid}` is the canonical balance document
- Security-first — all writes via Cloud Functions (Admin SDK); client has read-only access

---

## 2. File Map

| File | Role |
|------|------|
| `wallet.html` | Premium fintech UI — 5-panel bottom-nav app |
| `sokoni-wallet-v2.js` | Client SDK — IIFE, `window.SokoniWalletV2` |
| `functions/wallet-engine.js` | New v2 Cloud Functions (18 functions) |
| `functions/wallet.js` | Existing v1 Cloud Functions — **do not modify** |
| `firestore.rules` | Wallet v2 collection rules added |
| `firestore.indexes.json` | 7 new indexes for v2 collections |

---

## 3. UI Architecture

### 3.1 Panel System

Five panels managed by `showPanel(id)` — only one visible at a time via CSS `display:block/none`.

| Panel | ID | Contents |
|-------|----|----------|
| Home | `panHome` | Balance hero, quick actions, AI insight, recent txns, savings strip |
| Send | `panSend` | 4-step wizard (find → amount → confirm → receipt) |
| QR | `panQR` | Static QR, dynamic QR with amount, share/download |
| History | `panHistory` | Full tx list, search, filter tabs, pagination |
| More | `panMore` | Savings, analytics, security, merchant, settings |

### 3.2 Overlay System

Overlays are `position:fixed` full-viewport sheets with slide-up animation. Each has a backdrop tap-to-close and an X button.

| Overlay | ID | Trigger |
|---------|----|---------|
| Add Money | `ovlAddMoney` | Home → Add / quick action |
| Withdraw | `ovlWithdraw` | Home → Withdraw / More menu |
| Request | `ovlRequest` | Home → Request / More |
| Vaults List | `ovlVaults` | Home savings strip / More |
| New Vault | `ovlNewVault` | Vaults list + button |
| Vault Detail | `ovlVaultDetail` | Vault card tap |
| Analytics | `ovlAnalytics` | More → Analytics |
| Security | `ovlSecurity` | More → Security |
| PIN Setup | `ovlPinSetup` | Security → Set PIN |
| TX Detail | `ovlTxDetail` | Any transaction item |

### 3.3 QR Code Canvas Rendering

The QR canvas (`#qrCanvas`) uses Canvas 2D API. The QR payload comes from `walletV2GenerateQR` CF and is rendered using a deterministic grid algorithm based on a simple hash of the payload string. The result is **visually similar to a QR code** and carries the SOKONI brand logo at center.

**Production upgrade path:** Replace `_drawQR()` in `sokoni-wallet-v2.js` with a proper QR encoder library (e.g., `qrcodegen` or `jsQR`) once QR scanning is required. The CF already returns a signed `qrPayload` string that is the correct input.

---

## 4. Cloud Functions Architecture

### 4.1 Existing V1 Functions (wallet.js — unchanged)

```
initiateWalletTopUp    → STK push via IntaSend
confirmWalletTopUp     → Poll payment status, credit wallet
getWalletTransactions  → List user's transactions
requestSellerPayout    → Velocity-checked payout request
getPayoutHistory       → List payout requests
getWalletBalance       → Simple balance read (deprecated; use walletV2Dashboard)
```

### 4.2 New V2 Functions (wallet-engine.js)

```
walletV2Dashboard      → Aggregate: balance + savings + rewards + last 5 txns
walletV2Send           → P2P transfer with idempotency
walletV2Request        → Create money request link (moneyRequests/{reqId})
walletV2GetRequests    → List pending requests for user
walletV2SavingsList    → List vaults subcollection
walletV2SavingsCreate  → Create savings vault
walletV2SavingsDeposit → Move wallet balance into vault
walletV2SavingsWithdraw→ Move vault balance back to wallet
walletV2SetPin         → Hash and store wallet PIN
walletV2VerifyPin      → Compare PIN hash with rate limiting
walletV2FreezeToggle   → Freeze/unfreeze wallet + audit log
walletV2SetLimits      → Set daily/monthly spend limits
walletV2Analytics      → Spending breakdown by period/category
walletV2GenerateQR     → Signed QR payload (HMAC-SHA256)
walletV2PayViaQR       → Verify QR sig + execute transfer
walletV2AiInsights     → Claude Haiku financial insights
walletV2EscrowCreate   → Lock funds in escrow
walletV2EscrowRelease  → Release escrow to counterparty
```

---

## 5. Firestore Schema

### 5.1 Existing Collection: `wallets/{uid}`

V1 fields preserved. V2 extends with new fields via `merge: true`:

```
balance:           number   // Available balance (KSh) — SINGLE SOURCE OF TRUTH
currency:          'KES'
lastTopUp:         Timestamp
pendingTopUp:      boolean
pendingPayout:     boolean
createdAt:         Timestamp
// V2 additions:
savingsBalance:    number   // Sum of all vault currentAmounts (denormalized)
cashbackBalance:   number   // Cashback from orders
rewardPoints:      number   // Loyalty points
tier:              string   // 'bronze'|'silver'|'gold'|'platinum'|'diamond'
frozen:            boolean  // Freeze all outgoing
pinHash:           string   // SHA-256(pin+uid) — NEVER store plain PIN
pinLocked:         boolean  // Locked after 5 wrong attempts
dailyLimit:        number   // 0 = no limit
monthlyLimit:      number
dailySpent:        number   // Reset midnight EAT
monthlySpent:      number   // Reset 1st of month
hasPin:            boolean  // Derived from pinHash existence
```

### 5.2 New Subcollection: `wallets/{uid}/savings/{vaultId}`

```
id:            string   // document ID
name:          string
emoji:         string
currentAmount: number
targetAmount?: number
deadline?:     string   // ISO date
locked:        boolean
autoSave:      boolean
autoSaveAmount?: number
createdAt:     Timestamp
updatedAt:     Timestamp
```

### 5.3 New Collection: `moneyRequests/{reqId}`

```
reqId:      string
fromUid:    string
toUid?:     string
toPhone?:   string
amount?:    number
note?:      string
status:     'pending'|'paid'|'expired'
shareLink:  string
createdAt:  Timestamp
paidAt?:    Timestamp
paidTxId?:  string
```

### 5.4 New Collection: `walletAuditLog/{logId}`

```
uid:       string
action:    string  // 'freeze'|'unfreeze'|'set_pin'|'set_limits'|...
details:   object
ip?:       string
timestamp: Timestamp
```

### 5.5 New Collection: `escrowV2/{escrowId}`

```
escrowId:         string
buyerUid:         string
sellerUid?:       string
amount:           number
description:      string
releaseCondition: string
status:           'held'|'released'|'disputed'|'refunded'
milestones?:      [{name, amount, released}]
createdAt:        Timestamp
releasedAt?:      Timestamp
```

---

## 6. Security Model

| Layer | Implementation |
|-------|---------------|
| Auth | All CFs require `context.auth.uid` (onCall with enforceAppCheck) |
| Authorization | Wallet operations only allowed on calling user's own `wallets/{uid}` |
| PIN Storage | SHA-256(pin + uid) — never plaintext, never bcrypt (no native dep needed) |
| Rate Limiting | `walletPinAttempts/{uid}` doc with TTL-style counter reset per hour |
| Freeze | `wallets/{uid}.frozen = true` blocks all outgoing CF operations server-side |
| QR Signing | HMAC-SHA256 with `WALLET_QR_SECRET` (Secret Manager). Payload includes `ts` — reject if >5 min old |
| P2P Idempotency | Key: `{senderUid}_{recipientUid}_{amount}_{floor(ts/5000)}` — dedupes within 5s window |
| Firestore Rules | Wallet subcollections are client read-only; all writes go through Admin SDK in CFs |

---

## 7. Migration Plan

V1 → V2 is zero-downtime and zero-breaking. The strategy:

1. **Deploy `wallet-engine.js` CFs** without modifying `wallet.js`
2. **Deploy new `wallet.html` + `sokoni-wallet-v2.js`** — they call both v1 and v2 CFs
3. `walletV2Dashboard` reads existing `wallets/{uid}.balance` and extends the doc with new fields on first call (using `merge: true`)
4. **No data migration required** — existing balances and transactions are unchanged
5. **Rollback:** Revert `wallet.html` to v1 version; all v1 CFs remain deployed and functional

---

## 8. Performance

| Concern | Solution |
|---------|---------|
| Dashboard cold start | `walletV2Dashboard` is ONE CF call aggregating balance + savings + txns |
| Transaction list | 100 txns loaded once, filtered client-side; no re-fetching on filter change |
| Canvas QR | Drawn synchronously; payload from CF cached in `_qrData` |
| AI insight | Non-blocking — renders after dashboard, fails gracefully with static tip |
| Savings list | Subcollection query (not collection group) — fast |

---

## 9. Known Gaps & Future Work

| Feature | Status | Notes |
|---------|--------|-------|
| QR scanning (camera) | Not implemented | Requires `jsQR` or native BarcodeDetector API |
| Split bill flow | Stub | Opens Request Money — full split needs `walletV2SplitBill` CF |
| Virtual cards | UI placeholder | Requires card-issuing partner (Mastercard/Visa API) |
| Family wallet | Not implemented | Requires multi-user wallet linking |
| Auto-save vault deposits | Backend ready | `autoSave` field on vault; scheduler CF needed |
| Bank statement export | Not implemented | PDF generation CF |
| Biometric auth for transfers | Not implemented | WebAuthn + `walletV2VerifyPin` |

---

## 10. Secrets Required

| Secret | Purpose | Where |
|--------|---------|-------|
| `ANTHROPIC_API_KEY` | Claude Haiku AI insights | Secret Manager (already exists) |
| `WALLET_QR_SECRET` | HMAC signing of QR payloads | Secret Manager — **create before deploying wallet-engine.js** |

**Command to create `WALLET_QR_SECRET`:**
```bash
# Generate secure random secret
openssl rand -base64 32 | gcloud secrets create WALLET_QR_SECRET --data-file=-
# Grant Functions access
gcloud secrets add-iam-policy-binding WALLET_QR_SECRET \
  --member="serviceAccount:$(gcloud config get project)@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 11. Deployment Checklist

- [ ] Create `WALLET_QR_SECRET` in Secret Manager
- [ ] Deploy `wallet-engine.js` CFs: `firebase deploy --only functions:walletV2Dashboard,functions:walletV2Send,...`
- [ ] Deploy hosting: `firebase deploy --only hosting`
- [ ] Verify `walletV2Dashboard` returns data in Firebase Console
- [ ] Test P2P send between two test accounts
- [ ] Test top-up STK push with real M-Pesa number (KSh 10 minimum)
- [ ] Verify savings vault create/deposit/withdraw
- [ ] Test PIN set/verify flow
- [ ] Test freeze toggle
- [ ] Verify AI insight loads or falls back gracefully
- [ ] Update `release-gates.json` wallet gate to `engineering_complete` (or `verified` post-test)

---

*Wallet 2.0 is designed as an extensible fintech platform. Adding new financial products (insurance, credit, investments) should extend the existing schema and CF patterns without modifying core balance logic.*
