# SFOS Architecture — SOKONI Financial Operating System

**Version:** 1.0  
**Date:** 2026-07-14  
**Status:** Production  
**Author:** SOKONI Engineering  

---

## Table of Contents

1. [System Overview](#1-system-overview)  
2. [Data Flow Architecture](#2-data-flow-architecture)  
3. [Firestore Schema](#3-firestore-schema)  
4. [Ledger Architecture](#4-ledger-architecture)  
5. [Wallet Engine](#5-wallet-engine)  
6. [Cloud Functions Architecture](#6-cloud-functions-architecture)  
7. [Security Architecture](#7-security-architecture)  
8. [UX Architecture](#8-ux-architecture)  
9. [Mobile Implementation Notes](#9-mobile-implementation-notes)  
10. [API Contracts](#10-api-contracts)  
11. [Database Indexes](#11-database-indexes)  
12. [Migration Plan](#12-migration-plan)  
13. [Rollback Plan](#13-rollback-plan)  
14. [Performance Optimisation](#14-performance-optimisation)  
15. [Testing Strategy](#15-testing-strategy)  
16. [Deployment Checklist](#16-deployment-checklist)  
17. [Production Readiness Report](#17-production-readiness-report)  
18. [Scalability Report](#18-scalability-report)  
19. [Technical Documentation Index](#19-technical-documentation-index)  
20. [Risk Assessment](#20-risk-assessment)  
21. [Future Roadmap](#21-future-roadmap)

---

## 1. System Overview

### 1.1 What SFOS Is

The SOKONI Financial Operating System (SFOS) is the enterprise-grade financial layer that sits on top of the existing Wallet 2.0 engine. It adds financial identity, a double-entry immutable ledger, escrow, merchant settlement, group wallets, rewards, and AI-powered analytics without replacing or breaking any existing functionality.

### 1.2 Principles

- **Backward compatible**: every Wallet v1 and v2 CF continues to work unchanged.
- **Additive only**: SFOS adds new collections and CFs; it never deletes or mutates legacy data structures.
- **Zero trust**: every CF asserts auth, App Check, and role before touching data.
- **Immutability**: all ledger entries are append-only. Corrections are compensating entries.
- **Single source of truth**: `wallets/{uid}.balance` is the authoritative balance. Ledger sums must equal it at all times.

### 1.3 File Inventory

| File | Role |
|------|------|
| `functions/wallet.js` | v1 CFs (legacy, unchanged) |
| `functions/wallet-engine.js` | v2 CFs (Wallet 2.0) |
| `functions/sfos-engine.js` | SFOS CFs (new) |
| `sokoni-wallet-v2.js` | Wallet 2.0 client SDK |
| `sfos-core.js` | SFOS client SDK |
| `wallet.html` | Wallet 2.0 UI |
| `sfos-wallet.html` | SFOS full UI |

### 1.4 Service Boundaries

```
┌──────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                           │
│   sfos-wallet.html  ←→  sfos-core.js (window.SFOSCore)  │
│   wallet.html       ←→  sokoni-wallet-v2.js              │
└──────────────────────────────┬───────────────────────────┘
                               │  Firebase Functions (HTTPS Callable)
                               │  App Check enforced on all calls
┌──────────────────────────────▼───────────────────────────┐
│                  FUNCTION LAYER                           │
│   sfos-engine.js   │   wallet-engine.js   │  wallet.js   │
│   (SFOS CFs)       │   (v2 CFs)           │  (v1 CFs)    │
└──────────────────────────────┬───────────────────────────┘
                               │  Firestore Admin SDK
                               │  runTransaction() for all mutations
┌──────────────────────────────▼───────────────────────────┐
│                  DATA LAYER (Firestore)                   │
│                                                           │
│  wallets/{uid}           sfosLedger/{entryId}             │
│  wallets/{uid}/savings   sfosIdentity/{uid}               │
│  moneyRequests           sfosEscrow/{escrowId}            │
│  walletAuditLog          sfosGroups/{groupId}             │
│  escrowV2                sfosRewards/{uid}                │
│  sfosAnalytics           sfosRisk/{uid}                   │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow Architecture

### 2.1 P2P Send Flow

```
User → sfos-core.js.executeSend()
  → sfosRiskCheck (CF)           ← velocity check, fraud pattern
  → walletV2Send (CF)
      → runTransaction() {
          assert sender balance ≥ amount
          assert daily/monthly limit not exceeded
          assert wallet not frozen
          debit  wallets/{sender}.balance
          credit wallets/{recipient}.balance
          append sfosLedger/{debit-entry}
          append sfosLedger/{credit-entry}
          update wallets/{sender}.dailySpend
        }
      → notify recipient (CF-side)
  → sfos-core.js updates UI balances
  → sfos-core.js prepends tx row
```

### 2.2 Savings Vault Flow

```
User → depositToVault(vaultId, amount)
  → walletV2SavingsDeposit (CF)
      → runTransaction() {
          assert balance ≥ amount
          debit  wallets/{uid}.balance
          credit wallets/{uid}/savings/{vaultId}.balance
          append sfosLedger (type: savings-deposit)
        }
  → sfos-core.js reloads vault grid
```

### 2.3 Escrow Flow

```
Buyer → sfosEscrowCreate (CF)
  → runTransaction() {
      debit  wallets/{buyer}.balance
      create sfosEscrow/{escrowId} { status: held, milestones: [] }
      append sfosLedger (type: escrow-hold)
    }

Buyer/Admin → sfosEscrowRelease (CF)
  → runTransaction() {
      assert sfosEscrow status = held
      assert caller = buyer or admin
      credit wallets/{seller}.balance
      update sfosEscrow.status = released
      append sfosLedger (type: escrow-release)
    }
```

### 2.4 Merchant Settlement Flow

```
sfosMerchantDashboard → aggregate orders revenue
sfosMerchantSettle    → runTransaction() {
  credit wallets/{merchant}.balance
  create sfosSettlement/{id}
  append sfosLedger (type: settlement)
  debit  sfosFloat account
}
```

---

## 3. Firestore Schema

### 3.1 `wallets/{uid}` (existing, extended by SFOS)

| Field | Type | Description |
|-------|------|-------------|
| `balance` | number | Main wallet balance (KES, always ≥ 0) |
| `currency` | string | Always `"KES"` |
| `frozen` | boolean | Whether wallet accepts debits |
| `pinHash` | string | SHA-256(PIN + uid) — set by walletV2SetPin |
| `pinSet` | boolean | Whether PIN has been configured |
| `dailyLimit` | number | Maximum daily debit (default 50,000) |
| `monthlyLimit` | number | Maximum monthly debit (default 500,000) |
| `dailySpend` | number | Rolling spend for current day (UTC) |
| `monthlySpend` | number | Rolling spend for current calendar month |
| `dailyResetAt` | Timestamp | UTC midnight of current day |
| `savingsTotal` | number | Sum of all savings vault balances |
| `escrowTotal` | number | Sum of all open escrow holds |
| `v2` | boolean | True once Wallet 2.0 migration is done |
| `sfos` | boolean | True once SFOS identity is created |
| `createdAt` | Timestamp | First wallet creation |
| `updatedAt` | Timestamp | Last balance mutation |

### 3.2 `wallets/{uid}/savings/{vaultId}`

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Vault display name (max 50 chars) |
| `balance` | number | Current vault balance (KES) |
| `target` | number | Savings goal (0 = no target) |
| `locked` | boolean | If true, cannot withdraw before deadline |
| `deadline` | Timestamp | Unlock date for locked vaults |
| `autoSave` | boolean | Whether auto-deposit is enabled |
| `autoSaveAmount` | number | KES to auto-deposit per period |
| `autoSavePeriod` | string | `"daily"` / `"weekly"` / `"monthly"` |
| `color` | string | Hex color for progress ring UI |
| `createdAt` | Timestamp | Creation time |
| `updatedAt` | Timestamp | Last deposit or withdrawal |

### 3.3 `sfosIdentity/{uid}`

| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Firebase Auth UID (= document ID) |
| `displayName` | string | Resolved display name |
| `phone` | string | E.164 phone (254XXXXXXXXX) |
| `email` | string | Auth email |
| `avatarInitial` | string | Single uppercase letter |
| `tier` | string | `"Bronze"` / `"Silver"` / `"Gold"` / `"Platinum"` |
| `kyc.level` | string | `"Basic"` / `"Verified"` / `"Enhanced"` |
| `kyc.idVerified` | boolean | ID document verified |
| `kyc.selfieVerified` | boolean | Liveness check passed |
| `kyc.businessVerified` | boolean | Business registration verified |
| `rewardPoints` | number | Current loyalty points balance |
| `lifetimeSpend` | number | Cumulative KES spent through SFOS |
| `createdAt` | Timestamp | Identity creation |
| `updatedAt` | Timestamp | Last update |

### 3.4 `sfosLedger/{entryId}`

The immutable double-entry ledger. No document in this collection may ever be modified after creation.

| Field | Type | Description |
|-------|------|-------------|
| `entryId` | string | Auto-generated ID (= document ID) |
| `type` | string | Entry type — see entry type table below |
| `debitUid` | string | UID of debited wallet (or `"PLATFORM"`) |
| `creditUid` | string | UID of credited wallet (or `"PLATFORM"`) |
| `amount` | number | KES amount (always positive) |
| `currency` | string | Always `"KES"` |
| `description` | string | Human-readable label |
| `metadata` | map | Type-specific data (orderId, vaultId, etc.) |
| `idempotencyKey` | string | Prevents duplicate entries |
| `balanceAfterDebit` | number | Snapshot of debit wallet balance after |
| `balanceAfterCredit` | number | Snapshot of credit wallet balance after |
| `createdAt` | Timestamp | Entry creation (server timestamp) |
| `reversedBy` | string | Entry ID of compensating entry if reversed |

**Ledger Entry Types:**

| type | Meaning |
|------|---------|
| `p2p-send` | P2P transfer between users |
| `topup` | M-Pesa to wallet top-up |
| `withdrawal` | Wallet to M-Pesa withdrawal |
| `order-payment` | Checkout payment |
| `order-refund` | Refund to buyer |
| `savings-deposit` | Move from balance to vault |
| `savings-withdraw` | Move from vault to balance |
| `escrow-hold` | Lock funds in escrow |
| `escrow-release` | Release escrow to recipient |
| `settlement` | Merchant settlement payout |
| `commission` | Platform commission deducted |
| `reward-credit` | Loyalty points converted to KES |
| `fee` | Transaction fee |
| `reversal` | Compensating entry (errors only) |

### 3.5 `sfosEscrow/{escrowId}`

| Field | Type | Description |
|-------|------|-------------|
| `escrowId` | string | Document ID |
| `buyerUid` | string | Payer UID |
| `sellerUid` | string | Recipient UID |
| `amount` | number | Total held amount (KES) |
| `released` | number | Amount released so far |
| `status` | string | `"held"` / `"partial"` / `"released"` / `"disputed"` |
| `description` | string | Escrow purpose |
| `milestones` | array | Array of `{ id, title, amount, status }` |
| `ledgerEntryId` | string | ID of the escrow-hold ledger entry |
| `expiresAt` | Timestamp | Auto-expire (90 days by default) |
| `createdAt` | Timestamp | Creation time |
| `releasedAt` | Timestamp | Full release time |

### 3.6 `sfosGroups/{groupId}`

| Field | Type | Description |
|-------|------|-------------|
| `groupId` | string | Document ID |
| `name` | string | Group/chama name |
| `description` | string | Purpose |
| `createdBy` | string | Founder UID |
| `members` | array | Array of `{ uid, role, joinedAt }` |
| `balance` | number | Group wallet balance (KES) |
| `contributionAmount` | number | Regular contribution amount |
| `contributionPeriod` | string | `"monthly"` / `"weekly"` |
| `nextContributionAt` | Timestamp | Next scheduled contribution date |
| `totalContributed` | number | Lifetime contributions |
| `createdAt` | Timestamp | Group creation |

### 3.7 `sfosRewards/{uid}`

| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Document ID = user UID |
| `totalPoints` | number | Current points balance |
| `lifetimePoints` | number | All-time points earned |
| `tier` | string | Bronze / Silver / Gold / Platinum |
| `tierUpdatedAt` | Timestamp | Last tier change |
| `history` | subcollection | See sfosRewards/{uid}/history/{id} |
| `updatedAt` | Timestamp | Last points change |

### 3.8 `sfosRisk/{uid}`

CF-only read/write. Not accessible by client rules.

| Field | Type | Description |
|-------|------|-------------|
| `uid` | string | Document ID |
| `velocityWindow` | array | Last 10 transaction timestamps |
| `flaggedPatterns` | array | Detected anomaly codes |
| `riskScore` | number | 0-100 risk score |
| `lastChecked` | Timestamp | Last risk evaluation |
| `frozenByRisk` | boolean | Frozen by automated risk engine |

---

## 4. Ledger Architecture

### 4.1 Double-Entry Bookkeeping

Every value transfer in SFOS creates exactly two ledger entries: a debit on one account and a credit on another. The sum of all debits always equals the sum of all credits (accounting equation).

```
sfosLedger entries for KES 500 P2P send (Alice → Bob):

Entry 1: { type: p2p-send, debitUid: aliceUid,  creditUid: bobUid,      amount: 500 }
Entry 2: { type: fee,      debitUid: aliceUid,   creditUid: "PLATFORM",  amount: 2.50 }
         (fee only if applicable)
```

### 4.2 Immutability Guarantees

- **No update**: Firestore rules deny all `update` and `delete` operations on `sfosLedger`.
- **Server timestamp**: `createdAt` is always a `FieldValue.serverTimestamp()` — never client-supplied.
- **Balance snapshot**: `balanceAfterDebit` and `balanceAfterCredit` are written inside the same `runTransaction` as the balance mutation, ensuring they are consistent.
- **Reversals**: Errors are corrected with a new compensating entry, not by modifying the original. The original entry's `reversedBy` field is updated (append-only field update allowed).

### 4.3 Reconciliation

The daily reconciliation job (`sfosReconcile` CF) verifies:
```
for each uid:
  sum(sfosLedger where creditUid = uid) 
  - sum(sfosLedger where debitUid = uid)
  = wallets/{uid}.balance
```

Discrepancies above KES 0.01 trigger an alert to `ops-alerts@mysokoni.co.ke`.

---

## 5. Wallet Engine

### 5.1 sfosTransact — The Universal Engine

`sfosTransact` is the single CF that all SFOS financial mutations should route through. It:
1. Verifies auth and App Check.
2. Looks up both wallets in one read batch.
3. Validates amount, limits, freeze, KYC level, and risk score.
4. Executes a `runTransaction` with both balance changes and two ledger entries.
5. Triggers post-transaction hooks (notify, analytics update, reward evaluation).

All other money CFs (`walletV2Send`, `sfosEscrowCreate`, etc.) are domain-specific wrappers that call `sfosTransact` internally with appropriate parameters.

### 5.2 Idempotency

Every mutation CF accepts an optional `idempotencyKey`. If the same key is submitted within 5 seconds, the CF returns the original result without executing the operation again. This prevents duplicate charges from network retries.

```
idempotencyKey = `${uid}:${cfName}:${amount}:${Date.now() / 5000 | 0}`
```

### 5.3 Transaction Guarantees

All mutations use Firestore's `runTransaction()`:
- **Atomicity**: both balance changes succeed or both fail.
- **Consistency**: balance constraints (≥ 0, ≤ limit) are checked inside the transaction.
- **Isolation**: Firestore's serialisable isolation prevents race conditions.
- **Durability**: writes are committed to at least two regions before success is returned.

---

## 6. Cloud Functions Architecture

### 6.1 sfos-engine.js CFs

| Export | Trigger | Purpose | Timeout | Memory |
|--------|---------|---------|---------|--------|
| `sfosIdentityGet` | onCall | Load or create SFOS identity | 10s | 256MB |
| `sfosWalletGet` | onCall | Full wallet state (balance, limits, escrow, savings) | 10s | 256MB |
| `sfosTransact` | onCall | Universal transaction engine | 30s | 512MB |
| `sfosEscrowCreate` | onCall | Lock funds in escrow | 30s | 512MB |
| `sfosEscrowRelease` | onCall | Release escrow to recipient | 30s | 512MB |
| `sfosGroupCreate` | onCall | Create a group/chama wallet | 15s | 256MB |
| `sfosGroupGet` | onCall | Load group wallet state | 10s | 256MB |
| `sfosMerchantDashboard` | onCall | Merchant financial KPIs | 20s | 256MB |
| `sfosMerchantSettle` | onCall | Trigger merchant settlement | 30s | 512MB |
| `sfosRewardsGet` | onCall | Load loyalty rewards + history | 10s | 256MB |
| `sfosRewardsRedeem` | onCall | Convert points to wallet credit | 30s | 512MB |
| `sfosFinancialHealth` | onCall | Financial health score (0-100) | 20s | 256MB |
| `sfosNetWorth` | onCall | Net worth breakdown | 15s | 256MB |
| `sfosAnalyticsDetailed` | onCall | Spending analytics by period | 20s | 512MB |
| `sfosAiForecast` | onCall | Claude Haiku AI spending forecast | 30s | 512MB |
| `sfosRiskCheck` | onCall | Real-time risk assessment | 10s | 256MB |
| `sfosReconcile` | onSchedule | Daily ledger reconciliation | 540s | 1GB |

### 6.2 wallet-engine.js CFs (v2, unchanged)

All 18 existing CFs are unchanged. `sfos-engine.js` delegates to them rather than duplicating logic.

### 6.3 Dependency Graph

```
sfos-wallet.html
  └─ sfos-core.js (SFOSCore)
       ├─ sfosIdentityGet        → sfos-engine.js
       ├─ sfosWalletGet          → sfos-engine.js → walletV2Dashboard (fallback)
       ├─ walletV2Send           → wallet-engine.js → sfosTransact (internal)
       ├─ sfosEscrowCreate       → sfos-engine.js → sfosTransact (internal)
       ├─ walletV2SavingsDeposit → wallet-engine.js
       ├─ sfosFinancialHealth    → sfos-engine.js → sfosLedger (aggregate)
       ├─ sfosAiForecast         → sfos-engine.js → Anthropic API
       └─ sfosRiskCheck          → sfos-engine.js → sfosRisk/{uid}
```

### 6.4 Performance Targets

| CF | P50 | P95 | P99 |
|----|-----|-----|-----|
| `sfosWalletGet` | 120ms | 300ms | 600ms |
| `walletV2Send` | 200ms | 500ms | 1200ms |
| `sfosFinancialHealth` | 300ms | 800ms | 1500ms |
| `sfosAiForecast` | 800ms | 2000ms | 4000ms |
| `sfosRiskCheck` | 80ms | 200ms | 400ms |

---

## 7. Security Architecture

### 7.1 Authentication Chain

Every CF call must pass all four gates before touching data:

```
1. Firebase App Check       — rejects bot traffic (ReCaptchaV3)
2. Firebase Auth            — rejects unauthenticated calls
3. Role assertion           — CF checks token claims for role-gated ops
4. Resource ownership       — CF verifies caller owns the resource
```

### 7.2 PIN Security

- PIN is a 4-digit numeric string.
- Stored as `SHA-256(pin + uid)` — never in plaintext.
- Rate-limited to 5 attempts per hour via `walletPinAttempts/{uid}`.
- After 5 failures: wallet is auto-frozen and `walletAuditLog` entry created.
- PIN changes require current PIN verification first.

### 7.3 Wallet Freeze

- Set via `walletV2FreezeToggle` CF only — client cannot write `frozen` directly.
- When frozen: all debit operations (send, pay, withdraw, deposit-to-vault) return `permission-denied`.
- `sfosRiskCheck` can auto-freeze when risk score exceeds threshold.
- Freeze/unfreeze is always written to `walletAuditLog` with caller UID and timestamp.

### 7.4 Velocity Limits

Daily and monthly limits are enforced inside the Firestore `runTransaction`:
- `dailySpend + amount > dailyLimit` → reject.
- Reset via `walletV2ResetDailySpend` scheduled CF (runs at 00:00 UTC).
- P2P send additionally checks the risk engine.

### 7.5 Risk Engine (`sfosRiskCheck`)

Evaluates:
- Transaction amount relative to account history (z-score).
- Velocity: number of sends in the last 60 minutes.
- Recipient: new recipient not seen before + large amount.
- Time: unusual sending hours.
- Geography: if location data is available, cross-border flag.

Returns: `{ level: 'LOW' | 'MEDIUM' | 'HIGH', reasons: [] }`.

HIGH → transaction blocked server-side.  
MEDIUM → client shows warning overlay, user must confirm.

### 7.6 Firestore Security Rules

All SFOS collections follow the principle of least privilege:

```
sfosLedger  — read: owner (debitUid or creditUid); write: DENY all (CF only)
sfosIdentity — read: owner; write: DENY (CF only)
sfosEscrow  — read: buyer or seller; write: DENY (CF only)
sfosRisk    — read/write: DENY all (CF only, Admin SDK only)
sfosGroups  — read: members; write: DENY (CF only)
sfosRewards — read: owner; write: DENY (CF only)
```

---

## 8. UX Architecture

### 8.1 Panel System

`sfos-wallet.html` uses a single-page panel architecture:
- All panels rendered in DOM at page load (no routing, no network requests to switch panels).
- Only one `.sfos-panel` has class `active` at any time.
- `SFOSCore.showPanel(id)` manages the transition.
- Panels load their data lazily on first activation (not at init time).

### 8.2 Overlay System

Overlays are modal drawers that animate in from the bottom:
- `SFOSCore.openOverlay(id)` adds class `open`.
- `SFOSCore.closeOverlay(id)` removes class `open`.
- ESC key listener is attached globally.
- Background tap on `.sfos-overlay-backdrop` also closes.

### 8.3 Design Tokens

```css
--bg:       #050505   /* page background */
--sur:      #0d0d0d   /* surface level 1 */
--sur2:     #141414   /* surface level 2 */
--sur3:     #1a1a1a   /* surface level 3 */
--bor:      #1e1e1e   /* border default */
--g:        #71ff00   /* SOKONI accent (Volt Green) */
--g-dim:    #4db800   /* dimmed accent */
--txt:      #e8e8e8   /* primary text */
--sub:      #888888   /* secondary text */
--red:      #ef4444   /* destructive / error */
--amber:    #f59e0b   /* warning */
--blue:     #3b82f6   /* informational */
--radius:   16px      /* standard card radius */
--nav-h:    68px      /* bottom nav height */
--header-h: 64px      /* top bar height */
```

### 8.4 Canvas Elements

Two canvas visualisations are used:

**Health Gauge** (`_drawHealthGauge`):
- Semi-circle gauge, 180° arc.
- Background track: `#1e1e1e`.
- Progress arc: `hsl(score*1.2, 90%, 52%)` — red at 0, green at 100.
- Score label centred in arc.
- Grade label below score in accent green.

**Vault Progress Ring** (`_drawProgressRing`):
- Full-circle ring, starts at 12 o'clock.
- Background: `#1a1a1a`.
- Progress: vault colour (default `#71ff00`).
- Percentage text centred.

### 8.5 Accessibility

- All interactive elements have `aria-label` or visible text label.
- Focus trap active when overlays are open.
- Minimum touch target: 44×44px.
- Minimum input font size: 16px (prevents iOS zoom).
- Color is never the sole differentiator (icons accompany color coding).
- `aria-hidden="true"` set on closed overlays.
- `aria-pressed` on freeze toggle button.

---

## 9. Mobile Implementation Notes

### 9.1 Viewport

```html
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
```

`viewport-fit=cover` is required for safe-area insets on iPhone notch/Dynamic Island.

### 9.2 Safe Area Insets

Bottom navigation must account for home indicator on iOS:
```css
.sfos-bottom-nav {
  padding-bottom: env(safe-area-inset-bottom, 12px);
}
```

### 9.3 Offline Handling

SFOS does not run fully offline (financial data must be authoritative). However:
- `sfos-core.js` caches the last `getWalletState()` result in module state.
- If a CF call fails, the UI shows the last known balance with a "Data may be outdated" badge.
- QR codes generated offline (static QR from stored payload) remain valid for 15 minutes.

### 9.4 Performance on Low-end Devices

- All CF calls are parallelised with `Promise.allSettled()` at init.
- Canvas animations use `requestAnimationFrame`.
- `_countUp` animation uses `requestAnimationFrame` with cubic ease-out.
- No synchronous blocking operations in the module.

---

## 10. API Contracts

### 10.1 `sfosIdentityGet`

**Input:** `{}` (no params)  
**Output:**
```json
{
  "uid": "string",
  "displayName": "string",
  "phone": "254XXXXXXXXX",
  "email": "string",
  "avatarInitial": "A",
  "tier": "Bronze | Silver | Gold | Platinum",
  "kyc": {
    "level": "Basic | Verified | Enhanced",
    "idVerified": false,
    "selfieVerified": false,
    "businessVerified": false
  },
  "rewardPoints": 1250,
  "lifetimeSpend": 45000,
  "createdAt": "Timestamp"
}
```

### 10.2 `sfosWalletGet`

**Input:** `{}` (no params)  
**Output:**
```json
{
  "balance": 12500.00,
  "savingsTotal": 8000.00,
  "escrowTotal": 2000.00,
  "currency": "KES",
  "frozen": false,
  "pinSet": true,
  "dailyLimit": 50000,
  "monthlyLimit": 500000,
  "dailySpend": 1200,
  "monthlySpend": 15000,
  "rewardPoints": 1250
}
```

### 10.3 `walletV2Send`

**Input:**
```json
{
  "toPhone": "254712345678",
  "amount": 500,
  "note": "Lunch",
  "idempotencyKey": "optional-string"
}
```
**Output:**
```json
{
  "txId": "string",
  "amount": 500,
  "toName": "Bob",
  "newBalance": 12000.00,
  "ledgerEntryId": "string",
  "createdAt": "Timestamp"
}
```

### 10.4 `sfosRiskCheck`

**Input:**
```json
{
  "amount": 5000,
  "toUid": "string | null"
}
```
**Output:**
```json
{
  "level": "LOW | MEDIUM | HIGH",
  "score": 23,
  "reasons": [],
  "blocked": false
}
```

### 10.5 `sfosFinancialHealth`

**Input:** `{}`  
**Output:**
```json
{
  "score": 74,
  "grade": "B",
  "factors": [
    { "name": "Savings Habit",     "score": 80, "color": "#71ff00" },
    { "name": "Spending Control",  "score": 70, "color": "#f59e0b" },
    { "name": "Account Activity",  "score": 90, "color": "#71ff00" },
    { "name": "KYC Level",         "score": 60, "color": "#f59e0b" }
  ],
  "tips": ["string"]
}
```

### 10.6 `sfosAiForecast`

**Input:** `{}`  
**Output:**
```json
{
  "predictedSpend": 18500,
  "savingsOpportunity": 3200,
  "insights": [
    {
      "text": "Your food spending is 40% above your 3-month average.",
      "action": "Set Food Budget",
      "actionUrl": "/sfos-wallet.html#sfos_limits"
    }
  ],
  "generatedAt": "Timestamp",
  "model": "claude-haiku-4-5"
}
```

### 10.7 `sfosEscrowCreate`

**Input:**
```json
{
  "toUid": "string",
  "amount": 5000,
  "description": "Website development",
  "milestones": [
    { "title": "Design", "amount": 2000 },
    { "title": "Development", "amount": 3000 }
  ]
}
```
**Output:**
```json
{
  "escrowId": "string",
  "status": "held",
  "amount": 5000,
  "createdAt": "Timestamp"
}
```

---

## 11. Database Indexes

All indexes are additive — no existing indexes are modified or dropped.

### 11.1 sfosLedger Indexes

```json
{ "collectionGroup": "sfosLedger",
  "fields": [
    { "fieldPath": "debitUid",  "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```
*Query: load user's debit history sorted by time*

```json
{ "collectionGroup": "sfosLedger",
  "fields": [
    { "fieldPath": "creditUid", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```
*Query: load user's credit history sorted by time*

```json
{ "collectionGroup": "sfosLedger",
  "fields": [
    { "fieldPath": "debitUid",  "order": "ASCENDING" },
    { "fieldPath": "type",      "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```
*Query: filter ledger by type for a user*

### 11.2 sfosEscrow Indexes

```json
{ "collectionGroup": "sfosEscrow",
  "fields": [
    { "fieldPath": "buyerUid", "order": "ASCENDING" },
    { "fieldPath": "status",   "order": "ASCENDING" },
    { "fieldPath": "createdAt","order": "DESCENDING" }
  ]
}
```

```json
{ "collectionGroup": "sfosEscrow",
  "fields": [
    { "fieldPath": "sellerUid","order": "ASCENDING" },
    { "fieldPath": "status",   "order": "ASCENDING" },
    { "fieldPath": "createdAt","order": "DESCENDING" }
  ]
}
```

### 11.3 sfosIdentity Indexes

```json
{ "collectionGroup": "sfosIdentity",
  "fields": [
    { "fieldPath": "phone", "order": "ASCENDING" }
  ]
}
```
*Query: lookup identity by phone for P2P recipient resolution*

### 11.4 Savings Subcollection Indexes

```json
{ "collectionGroup": "savings",
  "fields": [
    { "fieldPath": "autoSave",  "order": "ASCENDING" },
    { "fieldPath": "nextAutoAt","order": "ASCENDING" }
  ]
}
```
*Query: scheduled CF finds vaults due for auto-deposit*

---

## 12. Migration Plan

See [[SFOS_MIGRATION]] for the detailed migration guide.

### Summary

| Phase | What | Risk |
|-------|------|------|
| 0 | Current state — wallet.js + wallet-engine.js live | None |
| 1 | Deploy sfos-engine.js; batch-create sfosIdentity | Low |
| 2 | Deploy sfos-wallet.html at `/sfos-wallet.html` | Low |
| 3 | Route new transactions through sfosTransact | Medium |
| 4 | Full cutover, retire wallet.html | Medium |

---

## 13. Rollback Plan

### Phase 1 Rollback

Remove `sfos-engine.js` exports from `functions/index.js`. All existing wallet CFs are untouched. Deployed sfos* CF containers are deleted via `firebase functions:delete`.

### Phase 2 Rollback

Revert `sfos-wallet.html` to pre-deploy version (git revert). DNS / hosting configuration unchanged — `wallet.html` remains primary.

### Phase 3 Rollback

If `sfosTransact` causes issues:
1. Revert the order/checkout engine to call `walletV2Send` directly.
2. SFOS ledger entries from the bad period are labelled with `metadata.rollbackPeriod: true`.
3. A compensating entry is written for any double-credited amounts.

### Data Rollback (Never)

`wallets/{uid}.balance` mutations are never rolled back by deleting documents. All corrections use compensating ledger entries. This is an accounting standard, not a technical limitation.

---

## 14. Performance Optimisation

### 14.1 Firestore Read Minimisation

- `sfosWalletGet` reads exactly one document: `wallets/{uid}`.
- `sfosIdentityGet` reads exactly one document: `sfosIdentity/{uid}`, and creates it on first call (merge write).
- Analytics aggregations use a denormalised `sfosAnalytics/{uid}` summary doc updated by CF triggers, not real-time aggregation queries.
- Transaction history is paginated: 20 items per page, cursor-based.

### 14.2 CF Cold Start Mitigation

- All CFs use min-instance: 1 for frequently called endpoints.
- `sfosWalletGet` and `sfosRiskCheck` are the most latency-sensitive and get min-instance: 2.
- Lazy Firebase imports in `sfos-core.js` avoid browser SDK loading at init — only imported when first CF call is made.

### 14.3 Client-Side Caching

- Module-level `_walletState` and `_identity` cache avoid redundant CF calls within a session.
- `_cfCache` reuses `httpsCallable` references (saves re-importing on every call).
- Panel data is loaded once on first activation; manual pull-to-refresh triggers reload.

### 14.4 Batching at Init

```javascript
await Promise.allSettled([loadIdentity(), getWalletState()]);
```

Both init calls run in parallel — reducing first meaningful paint from ~800ms to ~400ms on a fast connection.

---

## 15. Testing Strategy

### 15.1 Unit Tests

Targets in `sfos-core.js`:
- `_esc()` — XSS encoding for 20+ attack vectors.
- `_fmt()` — boundary values: 0, 0.01, 999999.99, -1 (expect 0).
- `_relativeTime()` — Timestamp, Date, ISO string, invalid input.
- `_txIcon()` — all known types return valid shape.
- `_drawProgressRing()` — pct < 0 clamps to 0, pct > 1 clamps to 1.

### 15.2 Integration Tests (`scripts/sfos-test.js`)

1. Auth-gated redirect: unauthenticated call → expect redirect.
2. `sfosIdentityGet` — creates identity on first call, returns same data on second.
3. `walletV2Send` — send KES 10 between two test accounts, verify both ledger entries.
4. `sfosEscrowCreate` then `sfosEscrowRelease` — verify balance delta matches.
5. `sfosRiskCheck` HIGH threshold — send extremely large amount, expect `blocked: true`.
6. Idempotency: repeat `walletV2Send` with same key within 5s, expect single debit.

### 15.3 E2E Tests (Playwright)

- Load `sfos-wallet.html` with test Firebase project.
- Verify `sfosReady` event fires within 3 seconds.
- Navigate all 7 panels via bottom nav.
- Complete a P2P send flow end-to-end.
- Create and deposit to a savings vault.
- Toggle wallet freeze and verify balance locked.

### 15.4 Load Tests

- 1,000 concurrent `sfosWalletGet` calls → P99 < 800ms.
- 100 concurrent `walletV2Send` calls → zero double-charges (idempotency verified).
- `sfosReconcile` on 50,000 user dataset → completes within 300 seconds.

---

## 16. Deployment Checklist

### 16.1 Secrets (Secret Manager)

- [ ] `ANTHROPIC_API_KEY` — for sfosAiForecast
- [ ] `WALLET_QR_SECRET` — for QR HMAC signing
- [ ] `SENDGRID_API_KEY` — for post-transaction email notifications
- [ ] `LOYALTY_HMAC_SECRET` — for offline QR loyalty tokens

### 16.2 Cloud Functions

- [ ] Deploy `sfos-engine.js` exports via `firebase deploy --only functions`
- [ ] Verify all 17 SFOS CFs appear in Firebase Console
- [ ] Set min-instances: `sfosWalletGet:2`, `sfosRiskCheck:2`, all others: 1
- [ ] Confirm App Check enforcement is active on all new CFs

### 16.3 Firestore

- [ ] Deploy updated `firestore.rules` with SFOS collection rules
- [ ] Deploy `firestore.indexes.json` with all 8 new SFOS indexes
- [ ] Verify indexes build successfully (can take 10–30 minutes)
- [ ] Run `scripts/sfos-migrate-identities.js` for existing users

### 16.4 Hosting

- [ ] Deploy `sfos-wallet.html` and `sfos-core.js`
- [ ] Verify page loads at `https://mysokoni.co.ke/sfos-wallet.html`
- [ ] Check CSP headers allow Firebase SDK CDN origin
- [ ] Verify cleanUrls rewrites work

### 16.5 Monitoring

- [ ] Set up Cloud Monitoring alert: CF error rate > 1% → PagerDuty
- [ ] Set up Firestore alert: `sfosLedger` write failures → immediate alert
- [ ] Set up daily reconciliation failure alert
- [ ] Add SFOS dashboard to ops monitoring panel

---

## 17. Production Readiness Report

| Gate | Requirement | Status |
|------|-------------|--------|
| Security | All CFs auth-gated | Required |
| Security | App Check enforced | Required |
| Security | Ledger immutability rules deployed | Required |
| Security | XSS protection on all innerHTML | DONE (sfos-core.js) |
| Data | SFOS indexes deployed | Required |
| Data | Reconciliation CF scheduled | Required |
| Data | Existing wallets migrated | Required |
| Performance | Cold start < 1s on P95 | Required |
| Performance | Init loads in < 2s on 4G | Required |
| Testing | Integration tests pass | Required |
| Testing | E2E P2P send tested | Required |
| Operations | Ops monitoring dashboard | Required |
| Operations | Runbook for freeze/risk escalation | Required |

---

## 18. Scalability Report

### 18.1 Firestore at Scale

Firestore scales horizontally without configuration. Key considerations:

- **Hot documents**: `wallets/{uid}` is written on every transaction. At 10 TPS per user this is within Firestore's 1 write/second/document limit per Firestore's design — each wallet is only hot for one user.
- **High-write collections**: `sfosLedger` writes increase linearly with transactions. Firestore auto-shards based on document ID; using auto-IDs ensures even distribution.
- **Aggregation**: real-time aggregation queries (`sum of sfosLedger`) do not scale to millions of documents. Solution: denormalised `sfosAnalytics/{uid}` summary docs updated by CF triggers.

### 18.2 Cloud Functions at Scale

- Gen2 CFs auto-scale to thousands of concurrent instances.
- Memory: financial CFs use 512MB to accommodate `runTransaction` retries.
- Min-instances prevent cold starts for critical paths.
- Concurrency: each Gen2 CF instance handles up to 1,000 concurrent requests.

### 18.3 Platform Scale Projections

| Users | Daily Txns | Ledger Entries/Day | Firestore Cost/Month |
|-------|-----------|-------------------|---------------------|
| 10,000 | 50,000 | 100,000 | ~$50 |
| 100,000 | 500,000 | 1,000,000 | ~$500 |
| 1,000,000 | 5,000,000 | 10,000,000 | ~$5,000 |

At 1M users, Algolia or BigQuery should replace Firestore for analytics aggregations.

---

## 19. Technical Documentation Index

| Document | Path | Purpose |
|----------|------|---------|
| This document | `docs/SFOS_ARCHITECTURE.md` | Authoritative SFOS architecture |
| Migration Guide | `docs/SFOS_MIGRATION.md` | Step-by-step v1→SFOS migration |
| Roadmap | `docs/SFOS_ROADMAP.md` | Future development plan |
| Wallet v2 Architecture | `docs/WALLET_V2_ARCHITECTURE.md` | Wallet 2.0 design |
| Platform Constitution | `docs/PLATFORM_CONSTITUTION.md` | 26 canonical engines |
| Security Architecture | `docs/SECURITY_ARCHITECTURE.md` | Zero-trust security stack |
| Changelog | `docs/CHANGELOG.md` | All releases |
| Firestore Schema | `docs/FIRESTORE_SCHEMA.md` | All collections |
| API Reference | `docs/API_REFERENCE.md` | All CF contracts |

---

## 20. Risk Assessment

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Double-spend race condition | Low | Critical | `runTransaction()` + idempotency keys |
| 2 | Ledger entry missing (CF crash mid-tx) | Low | High | Reconciliation CF catches within 24h |
| 3 | sfosAiForecast API timeout | Medium | Low | Falls back to static tips; not blocking |
| 4 | Firestore index limit reached (200) | Medium | High | Use sokoni-ops secondary DB; never drop indexes |
| 5 | M-Pesa webhook delivers duplicate | Medium | High | Idempotency key on all topup CFs |
| 6 | XSS via malicious displayName | Low | High | `_esc()` applied to all innerHTML; textContent used where possible |
| 7 | PIN brute force | Low | High | 5-attempt lockout + wallet auto-freeze |
| 8 | CF quota exhaustion | Medium | Medium | Cloud Run CPU quota increase in queue |
| 9 | SFOS ledger inconsistency after rollback | Low | Critical | Compensating entries; never delete ledger |
| 10 | CBK regulatory action on unlicensed P2P | Medium | Critical | Legal review; stay within existing M-Pesa PSP scope |

---

## 21. Future Roadmap

See [[SFOS_ROADMAP]] for the full roadmap.

### Technology Evolution

| Year | Milestone | Technology |
|------|-----------|------------|
| 2026 | SFOS live | Firebase, Claude Haiku |
| 2027 | Cards programme | Partnership with licensed issuer |
| 2027 | CBK sandbox | Direct CBK API integration |
| 2028 | Banking licence | Core banking system integration |
| 2029 | Cross-border | ISO 20022 SWIFT/RTGS integration |

---

*This document is the single authoritative reference for SFOS architecture. It must be updated whenever the architecture changes. All major changes require an Architecture Review Gate approval before implementation.*

*Related: [[SFOS_MIGRATION]] | [[SFOS_ROADMAP]] | [[WALLET_V2_ARCHITECTURE]] | [[PLATFORM_CONSTITUTION]]*
