# SOKONI Store — operator census and build (2026-10-01)

Related: [[sokoni-first-party-store]] · [[PROVENANCE_GAP_MERCHANT_IDENTITY]] · [[BUSINESS_WALLET_ARCHITECTURE]] · [[Payments]] · [[Authentication]] · [[Marketplace]]

**Status:** built and certified hermetically on `feat/first-party-store-operator-on-a545818`
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

## What was built

### Functions (`C:/temp/sok-store-fn`)

| File | Change |
|---|---|
| `functions/first-party-store-operator.js` | **new** — chain resolver + `assertStoreOperator` gate + `isStoreOperatorFor` |
| `functions/first-party-store-workspace.js` | **new** — 5 operator-only callables |
| `functions/shop-employees.js` | `resolveShopAccess`: for a `firstParty` shop the admin arm is replaced by the operator record |
| `functions/kasshop.js` | `_internal` export seam (read-only reuse of the profile allowlist) |
| `functions/index.js` | 5 exports by name |
| `scripts/infra/set-first-party-store-operator.js` | **one-off**, dry-run default, `create()`-only |

**The operator record** — `firstPartyStoreOperators/{storeId}` =
`{storeId, businessId, ownerUid, operatorUids:[uid], decision, setBy, createdAt}`. Server-only
(no rules match, no wildcard → clients default-denied). Must agree with the live chain or it grants
nothing. Not on the shop doc (public read, admin-writable), not a claim, not `operatorEmail`.

**Callables (all operator-gated; none accepts a shopId/businessId/uid):**
`sokoniStoreGetContext`, `sokoniStoreSaveProfile`, `sokoniStoreListProducts`,
`sokoniStoreListOrders`, `sokoniStoreGetWallet`. Refusal: `permission-denied`,
`details.reason = 'not-store-operator'`; a broken chain is `failed-precondition` with its reason.

**Money:** no commission, subscription, settlement, wallet-credit or payout code changed.
`order-settlement`, `settlement-engine`, `wallet`, `wallet-engine`, `commission` untouched.

### Hosting (`C:/temp/sok-store-web`)

- AdminOS (`admin-os.html`) and Super Admin (`super-admin.html`) sidebars: a **SOKONI Store** entry
  → `merchant-v2.html?store=sokoni`. `sokoni-aos.js` untouched.
- `merchant-v2.html?store=sokoni`: the merchant shell does **not boot** (no `shops/{uid}` read, no
  `merchantIdentity`, no module mounts — so no KASS SHOP data and no flash). `sokoni-store-workspace.js`
  asks the server (`sokoniStoreGetContext`) and renders either the workspace or the Access-denied
  panel. A denied caller triggers **no** further store call.

## Deploy list (not deployed)

| Function | Kind | Why |
|---|---|---|
| `sokoniStoreGetContext` | **NEW** | workspace gate + context |
| `sokoniStoreSaveProfile` | **NEW** | contact phone / profile |
| `sokoniStoreListProducts` | **NEW** | read |
| `sokoniStoreListOrders` | **NEW** | read |
| `sokoniStoreGetWallet` | **NEW** | read |
| `merchantIdentity` | REBUILT (live) | carve-out: admins lose the store via merchant-v2's identity call |
| `inviteShopEmployee`, `listShopEmployees`, `listShopInvites`, `removeShopEmployee` | REBUILT (live) | carve-out: admins cannot manage store staff |
| `merchantAdjustStock` | REBUILT (live) | carve-out: admins cannot adjust store stock |

**Lineage caveat — required before any REBUILT name ships:** production functions are a union of
lineages. Download each REBUILT function's live archive and diff it against a545818
([[reference_functions_lineage_gate]]). Deploy **scoped** (`--only functions:NAME,…`) — a full deploy
from this tree deletes `employeeSaleAuthorize` / `adminLinkMerchantAccounts` (gap above).
Other consumers of `resolveShopAccess` (`salesGet*`, pickup-location, shop-offers) pick up the
carve-out only when they are next rebuilt.

**Index:** `orders(sellerUid ASC, createdAt DESC)` is in `firestore.indexes.json`; confirm it is
deployed before `sokoniStoreListOrders` is relied on.

## Admin paths this slice does NOT close (need their own slices or a rules change)

- **Rules:** `shops/{id}` `allow update: if isAdmin()` — any admin client can edit the store doc
  directly; `wallets/{uid}` readable by any admin; `products` admin update. Needed rule (not edited
  here — `firestore.rules` is out of scope): deny client admin writes when
  `resource.data.firstParty == true` (Admin SDK is unaffected). `scripts/test-first-party-store-operator-rules.js`
  reports these as KNOWN-GAP and flips to PASS once closed.
- `merchant-authority.assertMerchantAccess` admin bypass (procurement / Supply on `SOK-XX2338`).
- `minishop.js`, `minishop-v3.js`, `minishop-campaigns.js` carry their own `_assertShopOwner`.
- AdminOS generic moderation (users, products, orders) remains platform-wide by design.

## Needs the owner

1. **Which wallet receives store revenue.** Settlement lands in `wallets/SOK-XX2338` (this lineage)
   or `businessWallets/SOK-XX2338` (release lineage) — never in `wallets/vbaSOKL4…`. Either route
   settlement to the company wallet (a money-path change: own slice + money-safety gate) or name
   one of the existing landing documents as the store wallet.
2. **The payout number.** No PIN-protected destination flow exists; the payout PIN is advisory and
   fails open without a PIN. Setting `+254705726803` needs a new, operator-scoped, fail-closed
   money-out authority (PIN on the store wallet, bound per transaction) — a frozen-backend decision.
3. **Run the one-off** after deploy: dry run, then `--apply` with `--operator-uid
   D5Ql2EYr95bt79IpcGTmOMTK0P83 --expect-email alexochieng3030@gmail.com`.
4. **Rules change** above, if admins must be locked out at the database layer too.
