# SOKONI Store — operator census and build (2026-10-01)

Related: [[sokoni-first-party-store]] · [[PROVENANCE_GAP_MERCHANT_IDENTITY]] · [[BUSINESS_WALLET_ARCHITECTURE]] · [[Payments]] · [[Authentication]] · [[Marketplace]]

**Status (updated 2026-10-01, second pass):** owner resolved both open items — see
*Owner resolutions*. Built and certified hermetically on `feat/first-party-store-operator-on-a545818`
(functions) and `hosting/first-party-store-operator-on-54b72cc` (hosting). **NOT deployed.**
**Operator record NOT written** — run `scripts/infra/set-first-party-store-operator.js --apply`
after deploy, with the owner's authorisation.

## Owner decisions (binding, 2026-10-01)

1. The SOKONI Store stays **owned** by its company account `vbaSOKL4h8WWGqa6Xfi1eLaEPnS2`
   (Bravilex International Co. Limited). Chain: `shops/STR_147f5ce11b424ec4bb892519`
   (`firstParty:true`, `ownerId` = company, **no `sellerUid`**) → `businesses/SOK-XX2338`
   (`SOKONI_FIRST_PARTY_STORE`). Ownership is not changed.
2. `D5Ql2EYr95bt79IpcGTmOMTK0P83` (alexochieng3030@gmail.com) is the store's **only operator**.
   Every other account — admins and superAdmins included — sees *"Access denied — the SOKONI Store
   is operated by its owner"* and can do nothing on the store. Admin claims grant nothing.
3. The store gets its **own wallet on the company account**; the operator's personal wallet
   (KASS SHOP funds) must never receive store money.
4. `+254705726803` = store contact phone **and** store payout number. The payout number must be set
   by the operator through the PIN-protected flow — never written by an agent.

## Census answers (read-only; functions tree `a545818`, live list = 1,723 names, exact match)

### 1. Which of 526f330's server pieces exist here, and live

| 526f330 piece | on a545818 | live |
|---|---|---|
| `first-party-store.js`, `first-party-store-admin.js` | absent | — |
| `sokoniStoreGetContext / Provision / SaveProfile / SetAvailability / UpsertProduct / DeleteProduct` | absent | **none live** |
| commission exemption + `sellerBilling` skip (edits inside `functions/index.js` payment rails) | absent | not live |
| `merchant-identity.js` admin first-party branch | absent | n/a |
| `admin-os.js` `firstPartyStore` finance block, `finos-utils.js` class | absent | n/a |

526f330's model is also **superseded by the data**: it provisions a `_platform` shop. Production's
store is `STR_147f…` owned by the company uid. Nothing of 526f330 is live, so every store callable
in this slice is **NEW**. Also absent on a545818: `store-identity.js`, `business-type.js`,
`first-party-shop.js`, `first-party-business.js`, `settlement-destination.js` (they live on other
lineages: c102b0a, 7150c00, 29c0e2e). This slice does not port them; its gate resolves the same
chain with the canonical resolver that **is** here (`tenant-identity.resolveMerchantIdForOwner`).

### 2. How merchant-v2 resolves the merchant context today

- **Shop:** `merchant-v2.html resolveShop()` reads `shops/{uid}` (else `shopEmployees/{uid}.shopOwnerId`),
  then calls **`merchantIdentity({shopId})`** (`shop-employees.js` → `resolveShopAccess`).
  `resolveShopAccess` arms, in order: **owner** (`ownerId||sellerUid||ownerUid === uid`),
  **corroborated employee**, **platform admin by claims** (any admin, ANY shop, all capabilities).
- **Business:** `resolveMerchantContext` (`procurement.js`) → `tenant-identity` for the caller's
  own business, or `_assertMerchantAuthority` → `merchant-authority.assertMerchantAccess`, which
  **passes every admin for any merchantId**.
- **An operator acting for a business they do not own** has no path today: the operator is neither
  owner nor employee of the store. Before this slice the ONLY way in was the admin arm — which
  also let *every* admin in. That is the hole the owner decision closes.

### 3. Wallet authority and revenue routing

- **Creators of `wallets/{uid}`:** `wallet-engine._ensureWallet` (v2 shape; called by
  `walletV2Dashboard` etc. for the **caller's own uid**), `wallet._ensureWallet` (v1 shape,
  caller's own uid), and **any settlement credit** (`order-settlement.js` `t.set(…, {merge:true})`
  auto-creates). There is no callable that creates a wallet for *another* account.
- **Store revenue on THIS lineage:** `order-settlement.settleOrder` credits
  `wallets/{order.sellerUid || order.sellerId}`. Store orders carry `sellerUid = SOK-XX2338`, so a
  store sale settles into **`wallets/SOK-XX2338`** — a business-id-keyed document in the PERSONAL
  collection that no one can sign in as, and **not** `wallets/vbaSOKL4…`. It would **not fail** for a
  missing wallet (set-merge creates it); it would **land somewhere no withdrawal path reads**.
- On the release/loyaltyDispatch-archive lineage (`29c0e2e`), `settlement-destination.js` routes to
  **`businessWallets/SOK-XX2338`** instead. Which of the two the live `onOrderStatusChange` runs is
  **not established here** (production functions are a union of lineages — diff the live archive).
- **Neither lineage credits `wallets/vbaSOKL4…`.** Creating it (owner decision 3) gives the store a
  wallet on the company account, but **no settlement path feeds it**. → **Owner decision needed:**
  which document is "the store's wallet" for revenue (see *Needs the owner*).
- **RESOLVED (owner + coordinator, 2026-10-01):** the coordinator read the **LIVE `onOrderStatusChange`
  archive** (built 2026-09-29T20:37Z): `order-settlement.js:94 sellerId = order.sellerUid || order.sellerId`,
  then `wallets/{sellerId}` (lines 136/236). **Live store revenue lands in `wallets/SOK-XX2338`.**
  Owner decision: **that document IS the store wallet.** `wallets/vbaSOKL4…` is NOT created (nothing
  would ever credit it); `wallets/SOK-XX2338` is NOT pre-created (the first settled sale creates it).

### 4. Payout-destination authority live today

- **There is no stored payout / withdrawal destination anywhere on this lineage.** The M-Pesa number
  is typed **per withdrawal** into `requestSellerPayout({amount, method, accountNumber, pin, …})`
  (`wallet.js`, live). No callable saves a destination; no field holds one.
- `requestSellerPayout` is **caller-scoped**: it debits `wallets/{request.auth.uid}` only.
- **The PIN is advisory there:** `_assessPayoutRisk` routes a missing/wrong PIN to *review*, it
  does not refuse. `_assertPinOk` (wallet-engine) **fails open** when no `pinHash` is set; PIN is
  `sha256(pin + walletUid)`, set only for the caller's own wallet by `walletV2SetPin`.
- The company wallet does not exist and so has **no PIN**; nobody can sign in as the company to set one.
- **Consequence:** the "existing PIN-protected payout-destination flow" the decision refers to does
  not exist. An operator-scoped variant "reusing the same checks" would be a **new money-out
  authority** on the frozen wallet backend (registered `BUSINESS-WALLET-EXTERNAL-PAYOUT-AUTHORITY`,
  recorded not built). **Not built in this slice.** The workspace reports the destination as
  *unavailable* and offers no path to set it.
- **RESOLVED (owner, 2026-10-01): BUILD it, HELD.** `sokoniStoreSetPayoutDestination` +
  `sokoniStorePayoutRequest` — operator-only, operator's own PIN required and fail-closed, ONE
  server-stored destination equal to the operator's verified Auth phone, requests created in
  `requestSellerPayout`'s exact shape and paid ONLY by the existing `adminProcessPayout` path.
  Ships dark behind `firstPartyStoreConfig/payouts.enabled`. See *Money-safety review*.

### 5. merchant-identity provenance gap on a545818

- `f194c02` (the registering commit) is **NOT an ancestor** of a545818.
- a545818's `index.js` registers **neither** `employeeSaleAuthorize` nor `adminLinkMerchantAccounts`
  (both **live**); it requires only `shared/merchant-identity` (the basename twin).
- So **the gap is OPEN on this lineage**: the 09-22 resolution applies to the release lineage
  (`ship/catalogue-port-on-live` / `release/comms-on-live`), not here. A full
  `--only functions` deploy from this tree would delete both live callables.
- **This slice does not touch `functions/merchant-identity.js`** (526f330 did). Scoped
  `--only functions:NAME` deploys of the names below do not reopen the gap.

### 6. Shop-profile save path for the contact phone

- `saveShopProfile` (`kasshop.js`, live) resolves **the caller's owned shop** (`_ownedShop(uid)`
  by `sellerUid/ownerUid/ownerId`) and on update **backfills `sellerUid: uid`**. Called by the
  operator it would edit **KASS SHOP**; pointed at the store it would stamp the operator as the
  store's seller — breaking the certified identity. **Never route the store through it.**
- This slice adds `sokoniStoreSaveProfile`, which sanitises with kasshop's **own** allowlist
  (`kasshop._internal.cleanProfile`, a read-only export seam — no kasshop behaviour changes),
  normalises the phone to E.164, and writes `shops/{storeId}` in a transaction that re-proves
  `firstParty`, `ownerId` and the absence of `sellerUid`.

## Owner resolutions (2026-10-01, second pass)

1. **Store wallet = `wallets/SOK-XX2338`** — proven from the live `onOrderStatusChange` archive.
   `sokoniStoreGetWallet` reads exactly that document; absent → *"No store sale has settled yet"*
   (`state: 'no-sale-settled-yet'`, balance `null`, never 0). The one-off **no longer creates any
   wallet**; the company-account wallet plan is withdrawn.
2. **Operator payout path built, HELD** behind a server-only flag (below). The owner lifts the
   wallet freeze for this path only, after the money-safety review.

## What was built

### Functions (`C:/temp/sok-store-fn`)

| File | Change |
|---|---|
| `functions/first-party-store-operator.js` | **new** — chain resolver + `assertStoreOperator` gate (returns the record, incl. the server-only destination) + `isStoreOperatorFor` |
| `functions/first-party-store-workspace.js` | **new** — 5 operator-only read/profile callables; wallet = `wallets/{businessId}` |
| `functions/first-party-store-payout.js` | **new** — `sokoniStoreSetPayoutDestination`, `sokoniStorePayoutRequest` (HELD) |
| `functions/shop-employees.js` | `resolveShopAccess`: for a `firstParty` shop the admin arm is replaced by the operator record |
| `functions/kasshop.js` | `_internal` read-only seam (profile allowlist) |
| `functions/wallet.js` | `_internal` read-only seam: `payoutEvent`, `eatDay`, `getPayoutConfig` (no behaviour change) |
| `functions/wallet-engine.js` | `_internal` read-only seam: `assertPinOk` (no behaviour change) |
| `functions/index.js` | 7 exports by name |
| `scripts/infra/set-first-party-store-operator.js` | **one-off**, dry-run default, writes ONLY the operator record with `create()` |

**The operator record** — `firstPartyStoreOperators/{storeId}` =
`{storeId, businessId, ownerUid, operatorUids:[uid], decision, setBy, createdAt}` plus, once the
operator sets it, `payoutDestination: {msisdn, setAt, setBy}`. Server-only (no rules match, no
wildcard → clients default-denied). Must agree with the live chain or it grants nothing.

**Callables (all operator-gated; none accepts a shopId / businessId / uid / destination):**
`sokoniStoreGetContext`, `sokoniStoreSaveProfile`, `sokoniStoreListProducts`,
`sokoniStoreListOrders`, `sokoniStoreGetWallet`, `sokoniStoreSetPayoutDestination`,
`sokoniStorePayoutRequest`. Refusals carry a stable `details.reason`.

### The payouts flag

**`firstPartyStoreConfig/payouts` → `{ enabled: true }`** (Firestore, server-only collection — no
rules match, so no client, admin or otherwise, can read or write it; set it from the Firebase
console or an Admin-SDK script). **Absent, or anything other than boolean `true` (e.g. the string
`"true"`) = OFF.** While OFF both payout callables refuse with `store-payouts-not-enabled`, and the
workspace shows *"Store withdrawals are awaiting owner approval"* with both buttons disabled.

### Hosting (`C:/temp/sok-store-web`)

- AdminOS and Super Admin sidebars: **SOKONI Store** → `merchant-v2.html?store=sokoni`.
- `?store=sokoni`: the merchant shell does not boot; `sokoni-store-workspace.js` asks
  `sokoniStoreGetContext` first and renders the workspace or Access denied (zero further calls).
- Workspace: store wallet balance (or *"No store sale has settled yet"*), payout number masked to
  the last 3 or *"Not set"*, **Set payout number** and **Withdraw** forms with a PIN field
  (`type=password`, numeric). Success is shown only after the server confirms.

## Money-safety review checklist — what the owner verifies before flipping the flag

Every money-out invariant, where it is enforced, and the test that proves it
(`scripts/test-sokoni-first-party-store.js`, section P; emulator `scripts/test-sokoni-store-payout-emulator.js`):

| # | Invariant | Enforced in | Proven by |
|---|---|---|---|
| 1 | Only the named operator — admin/superAdmin claims grant nothing | `assertStoreOperator` (server-only record ∧ live chain) | P1, A4–A8, B1–B5 |
| 2 | Signed in + App Check | `onCall({enforceAppCheck:true})` | P1b (auth); App Check = deploy config |
| 3 | Flag OFF by default; only boolean `true` enables | `_flagOn` reads `firstPartyStoreConfig/payouts` | P2, P2b, P22; rules suite (client cannot write it) |
| 4 | PIN REQUIRED, fail-closed: no PIN set → refuse | `_assertOperatorPin` checks `pinHash` BEFORE the verifier (which passes a PIN-less wallet) | P3 (sabotage: removing the check turns P3 red) |
| 5 | Wrong PIN → refuse (not review); attempt counter + lock at the cap | wallet-engine `_assertPinOk` (reused, unchanged) | P5, P5b |
| 6 | PIN is the OPERATOR's own (`sha256(pin+operatorUid)`) | `_assertOperatorPin(db, gate.uid, …)` | P3–P5 |
| 7 | Destination = the operator's VERIFIED Firebase Auth phone, read server-side (not the token) | `sokoniStoreSetPayoutDestination` → `getAuth().getUser(uid).phoneNumber` | P6, P6b, P7, P9 |
| 8 | ONE fixed destination; the request takes no number from the client | request reads `gate.record.payoutDestination` only | P8, P11 |
| 9 | Amount integer KES ≥ 100 (pipeline minimum) | request handler | P16 |
| 10 | Amount ≤ store balance, read INSIDE the transaction | `runTransaction` reads `wallets/SOK-XX2338` | P15; E2 (concurrency, emulator) |
| 11 | Reserve (balance −, pendingPayout +) and request create in ONE transaction | same transaction | P13; E3 (atomic refusal, emulator) |
| 12 | Idempotent: `pout_<requestId>` claimed with a transactional `create()`; replay reserves nothing | transaction `get` + `create` | P14; E1 (5 concurrent, emulator) |
| 13 | Velocity cap = sellers' (`config/payouts.maxPayoutsPerDay`, live value **20**) | wallet.js `getPayoutConfig` + `eatDay` | P18 |
| 14 | Request shape == `requestSellerPayout`'s, field for field | `t.create(reqRef, …)` | P19 (keys derived from wallet.js source) |
| 15 | No second execution rail: no gateway call, never marks paid, no instant mode | module has no IntaSend / adapter / settle code; `status:'pending'`, `mode:'review'` | P20 |
| 16 | Paid / rejected / refunded ONLY by the existing admin path, keyed on `payout.sellerUid` | wallet.js `adminProcessPayout`, `_settlePayoutPaid`, `_refundPayout` (unchanged) | P21; E4 |
| 17 | Operator's personal wallet never debited | request touches only `wallets/{businessId}` | P13b |
| 18 | Frozen store wallet → refuse | request handler | P18b |
| 19 | Full audit: who, when, amount, destination last 3, request id; refusals of a mismatched destination too | `firstPartyStoreAudit` (server-only) | P9c, P17 |
| 20 | Clients see only the last 3 digits of the destination | `_destinationOf`, responses | G4, P9, P13c |

**Before flipping the flag the owner must verify (live, read-only unless stated):**
1. The deployed `adminProcessPayout` is the 45a837d paid-state-guarded build and still keys on
   `payout.sellerUid` (diff the live archive — `wallet.js` on a545818 is what this was built against).
2. **Live `config/payouts.autoB2C` is `false` (read 2026-10-01).** So approving a store request
   leaves it `approved` for MANUAL disbursement, and *paid* needs an `externalReference` +
   attestation. If `autoB2C` is ever turned on, approval sends B2C to `accountNumber` immediately.
3. **The operator's wallet has NO PIN today (read 2026-10-01: `pinSet:false`).** Set it through the
   existing wallet Security flow (`walletV2SetPin`) first; until then both callables refuse `pin-not-set`.
4. The operator's Auth phone ends **…803** (read 2026-10-01) — it must still be +254705726803.
5. `wallets/SOK-XX2338` exists (a store sale has settled) and its balance matches `settlements/*`
   for store orders.
6. The rules suite (`scripts/test-first-party-store-operator-rules.js`) has been RUN and is green
   (the flag and operator docs are client-denied).
7. Then set `firstPartyStoreConfig/payouts = { enabled: true }` — a deliberate owner act.

## Deploy list (not deployed)

| Function | Kind | Why |
|---|---|---|
| `sokoniStoreGetContext` | **NEW** | workspace gate + context |
| `sokoniStoreSaveProfile` | **NEW** | contact phone / profile |
| `sokoniStoreListProducts` | **NEW** | read |
| `sokoniStoreListOrders` | **NEW** | read |
| `sokoniStoreGetWallet` | **NEW** | read `wallets/SOK-XX2338` |
| `sokoniStoreSetPayoutDestination` | **NEW, HELD** | dark until the flag is set |
| `sokoniStorePayoutRequest` | **NEW, HELD** | dark until the flag is set |
| `merchantIdentity` | REBUILT (live) | carve-out: admins lose the store via merchant-v2's identity call |
| `inviteShopEmployee`, `listShopEmployees`, `listShopInvites`, `removeShopEmployee` | REBUILT (live) | carve-out: admins cannot manage store staff |
| `merchantAdjustStock` | REBUILT (live) | carve-out: admins cannot adjust store stock |

**Not rebuilt:** `requestSellerPayout`, `adminProcessPayout`, `walletV2*` — `wallet.js` and
`wallet-engine.js` change only by an additive `_internal` seam that only the new callables read.

**Lineage caveat:** diff each REBUILT function's live archive against a545818 first. Deploy
**scoped** (`--only functions:NAME,…`) — a full deploy from this tree deletes
`employeeSaleAuthorize` / `adminLinkMerchantAccounts` (provenance gap above). Functions FIRST, then hosting.

**Index:** `orders(sellerUid ASC, createdAt DESC)` is in `firestore.indexes.json`; confirm deployed.

## Admin paths this slice does NOT close (need their own slices or a rules change)

- **Rules:** `shops/{id}` `allow update: if isAdmin()` — any admin client can edit the store doc;
  `wallets/{uid}` readable by any admin (so the store balance is visible to admins via the SDK);
  `products` admin update. Needed (not edited here): deny client admin writes where
  `resource.data.firstParty == true`. The rules suite reports these as KNOWN-GAP.
- `merchant-authority.assertMerchantAccess` admin bypass (procurement / Supply on `SOK-XX2338`).
- `minishop.js`, `minishop-v3.js`, `minishop-campaigns.js` carry their own `_assertShopOwner`.
- `adminProcessPayout` is (by design) any admin: an admin approves/rejects store withdrawals the
  same way they do sellers' — the money-out decision stays two-person (operator requests, admin pays).

## Needs the owner

1. Run the one-off after deploy: dry run, then `--apply` with `--operator-uid
   D5Ql2EYr95bt79IpcGTmOMTK0P83 --expect-email alexochieng3030@gmail.com`.
2. Set the operator's wallet PIN, then work through the money-safety checklist, then set the flag.
3. Rules change above, if admins must be locked out at the database layer too.

## One-off dry run — 2026-10-01 (read-only, production, nothing written) — revised script

```
store (shops/)            STR_147f5ce11b424ec4bb892519  firstParty:true  ownerId vbaSOKL4…  sellerUid (absent)
business (businesses/)    SOK-XX2338  SOKONI_FIRST_PARTY_STORE
operator                  D5Ql2EYr95bt79IpcGTmOMTK0P83  alexochieng3030@gmail.com  verified, not disabled, phone …803
firstPartyStoreOperators/STR_147f…   BEFORE (absent)   PLAN create
wallets/SOK-XX2338                    (absent) — the store wallet; created by the first settled sale
```

Additional read-only facts (same session): operator wallet exists, `pinSet:false`, not locked, not
frozen; `config/payouts` = `{autoB2C:false, maxPayoutsPerDay:20}`; `firstPartyStoreConfig/payouts` absent (flag OFF).
