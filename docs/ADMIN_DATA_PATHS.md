# Admin OS — Data-Path Classification (Phase 3 migration ledger)

**Rule:** no admin module reads Firestore directly; every operational read goes
`AdminAPI → adminOsDispatch → Cloud Function → Firestore`. This ledger classifies
**every** data-access primitive in the admin client so "every data path is
documented" is machine-checkable, not a claim.

Regenerate the raw inventory any time:

```
node scripts/audit-admin-data-paths.js
```

Legend: ✅ **Migrated** (via AdminAPI) · 🟡 **Exception** (documented, allowed) ·
❌ **Must migrate** (direct Firestore read of operational data).

_Snapshot: 2026-08-02 — 155 occurrences (admin.html + admin-api.js)._

---

## Direct Firestore reads (the operational data paths)

| Function | Primitive(s) | Collection | Status | Target |
|---|---|---|---|---|
| `_admLoadMpesa` | (migrated) | payments | ✅ Migrated | `AdminAPI.payments` |
| `renderOverview` / `_ccRenderRows` | (migrated) | overview/payments/payoutRequests/finance | ✅ Migrated | `AdminAPI.*` |
| `renderPayouts` | onSnapshot,collection,query,orderBy | payoutRequests | ❌→✅ this pass | `AdminAPI.payoutRequests` |
| `loadSupportQueue` | getDocs,collection,query,orderBy | supportTickets | ❌→✅ this pass | `AdminAPI.supportTickets` |
| `renderDriverApps` | getDocs,collection,query,where | drivers/driverApplications | ❌ Must migrate | needs `adminGetDrivers` |
| `renderTeamPane` | getDocs,collection,query,where | platformEmployees/platformInvites | ❌ Must migrate | needs `adminGetTeam` |
| `_syncBillingFromFirestore` | getDocs,collection,query,orderBy | bookingFees/commissionLedger | ❌ Must migrate | fold into `AdminAPI.finance` |
| `_subTabSwitch` | getDocs,collection,query,where,orderBy (×10) | contentFlags + hub sub-tabs | ❌ Must migrate | per-subtab endpoints |
| `startUsersListener` | collection | users (via SokoniDB) | 🟡 Exception* | see note |

\* `startUsersListener`/`SokoniDB.listen*` (users/providers/products) are **gated on
`sokoniAdminReady`**, which force-refreshes the token and confirms the admin claim
before attaching (admin.html), and carry retry logic. They are live-listener
exceptions retained for real-time panes. **Direction:** migrate to `AdminAPI` +
polling when live-refresh isn't essential; until then they are documented
exceptions, not silent direct reads.

---

## localStorage (101) — classification

| Category | Functions | Status |
|---|---|---|
| **Admin auth / PIN / pattern / session** | `_getHash`,`_tryUnlock`,`changePin`,`changePassword`,`saveNewPattern`,`_checkFirstRunSetup`,`_checkSessionTimeout`,`lockAdmin`,`_refreshSession`,`_patDraw` | 🟡 Exception — local gate state, never business data |
| **UI preferences** | `toggleDarkMode`,`showPane`,`renderPane`,`loadSettings`,`toggleSetting` | 🟡 Exception — UI prefs (explicitly allowed) |
| **Admin cost/tax bookkeeping** | `loadFinData`,`addCost`,`deleteCost`,`recordTaxPayment`,`deleteTaxPayment`,`renderWHT`,`seedDemoCosts` | 🟡 Exception (interim) — hand-entered; no canonical collection yet. **Direction:** move to `adminCosts`/`taxPayments` collections so Finance reconciles them too |
| **Demo seeds (gated `_demoAllowed`, OFF in prod)** | `seedProducts`,`seedApps`,`seedDemoCosts`,`clearDemo`,`reseedDemo` | 🟡 Exception — never runs in production; candidate for removal |
| **Business-data-as-source (legacy)** | `loadAll`,`renderFinance`(P&L),`recordCharge`,`saveComm`,`sendBroadcast`,`createPromo`,`createFlashSale`,`previewBc`,`_syncListingApproval`(cache),`_mergeFirestore*` | ❌ Must migrate — read from canonical via AdminAPI; localStorage kept only as an offline cache, never the source |

`sessionStorage` (11) — all admin session/timeout state → 🟡 Exception.

---

## Migration order (by risk/value)

**Sequencing rule:** migrate a pane only AFTER the AdminAPI pattern is browser-
confirmed on the already-migrated panes (Overview + Payments). Converting a
working live pane before that risks trading "working" for "broken" — the opposite
of production-grade. `renderPayouts` in particular is tied to the wallet-QA money
path, so it moves only once confirmed.

1. **Browser-confirm** Overview + Payments render live (gates the rest).
2. `renderPayouts` → `AdminAPI.payoutRequests` (field-map `id/reference/sellerName/createdAtMs`; keep approve/reject via `adminProcessPayout`; re-fetch after each action).
3. `loadSupportQueue` — **blocked on a canonical decision:** it reads `support_tickets` (snake_case) via a *separate unauthenticated app*, while the contract reads `supportTickets` (camelCase). **Both are currently empty (0 docs)** — no data-loss — but pick one canonical name before wiring.
4. `renderDriverApps`, `renderTeamPane` (add `adminGetDrivers`, `adminGetTeam`).
5. `_syncBillingFromFirestore` → consume `AdminAPI.finance.reconciliation` (single source).
6. `_subTabSwitch` hub sub-tabs (per-domain endpoints).
7. Cost/tax bookkeeping → canonical collections, reconciled by Finance.
8. Retire demo seeds; drop legacy business-data localStorage sources.

## Finance single source of truth

`adminGetFinance` now returns a `reconciliation` block (30d) — the ONLY totals any
dashboard/report should render: `grossRevenue, productRevenue, serviceRevenue,
commission (product+service), gatewayFees, refunds, walletFloat, pendingWithdrawals,
completedWithdrawals, netPlatformRevenue`. Verified against Firestore. **Caveat:**
`gatewayFees` needs `payments.netAmount`; current payment records omit it, so it
reports 0 (honest, not fabricated) until the webhook persists the net.

**Definition of done (Phase 3):** every row here is ✅ or 🟡, none ❌; the audit
script (`scripts/audit-admin-data-paths.js`) is wired into predeploy as a
regression tripwire.
