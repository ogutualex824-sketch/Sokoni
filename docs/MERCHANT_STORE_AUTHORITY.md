# Store Authority Census — Stage 1

> Regenerate: `node scripts/census-store-authority.js --md > docs/MERCHANT_STORE_AUTHORITY.md`
> Read-only. No UI, no repairs, no backfill, no deployment.

Handoff: [[MERCHANT_2D2_QUEUE]]. Companions: [[MERCHANT_2D2_AUTHORITY_CENSUS]] · [[MERCHANT_MARKETING_AUTHORITY]] · [[MERCHANT_CUSTOMERS_AUTHORITY]]

## Per-capability

| capability | exported | authenticates | merchant identity | client shopId | shop doc corroborates | verdict |
|---|---|---|---|---|---|---|
| `claimMinishopHandle` | yes | _requireAuth | RESOLVED server-side: shops where sellerUid == uid, limit 1 | not accepted at all | yes — the shop query IS the ownership proof | **SAFE** |
| `saveMinishopConfig` | yes | _requireAuth | client-supplied shopId, then VERIFIED | verified by _assertShopOwner(shopId, uid) | yes — shops/{shopId}.sellerUid must equal uid | **SAFE** |
| `getMinishopAnalytics` | yes | _requireAuth | client-supplied shopId, then VERIFIED | verified by _assertShopOwner | yes | **SAFE** |
| `generateMinishopShareCard` | yes | _requireAuth | client-supplied shopId, then VERIFIED | verified by _assertShopOwner | yes | **SAFE** |
| `getMyMinishop` | yes | _requireAuth | RESOLVED server-side: shops where sellerUid == uid | not accepted | yes | **SAFE** |
| `followShop` | yes | _requireAuth | n/a — a follow is a BUYER action | accepted, and verified to EXIST (not owned) inside the transaction | the SHOP must exist (checked in-transaction); ownership is correctly not required | **SAFE** |

- **`claimMinishopHandle`** — Takes only a handle. It never accepts a shopId, and it never creates a shop: if no shop names this uid the claim is refused with not-found. The reservation is a transaction, so two concurrent claims cannot both succeed, and a handle already held by another uid is already-exists. A handle held by this seller but pointing at a different shop is failed-precondition rather than silently repointed.
- **`saveMinishopConfig`** — A client-supplied shopId that is verified against the shop document is not a trusted client scope — it is a lookup key. It also refuses PROTECTED_FIELDS, so config can never write ownership, financial identity, platform standing or server-maintained counters.
- **`getMinishopAnalytics`** — Owner-asserted read. See the rules finding below: the client-SDK path to the same collection is dead, so this callable is the only way in — which is fine, but is a fact the surface must rely on rather than a fallback.
- **`generateMinishopShareCard`** — Same pattern.
- **`getMyMinishop`** — Self-scoped by construction; returns shopId: null for an account with no shop rather than guessing one.
- **`followShop`** — Allowing non-owners is INTENTIONAL and right: following is what a shopper does, and the follow record is keyed shopFollowers/{shopId}_{uid} with uid from auth, so a caller can only ever create or remove their own. HARDENED in Stage 1B — the shop is now proved to exist inside the transaction before anything is written, and shopFollowers is CF-only in firestore.rules so the relationship cannot be changed outside this function. See below for what the two defects were.

## Is a browser-supplied `shopId` trusted anywhere?

**No.** Two shapes appear, and only one of them involves a client at all:

1. **Resolved** — `claimMinishopHandle` and `getMyMinishop` never accept a `shopId`. They query
   `shops where sellerUid == uid` and use the document's own id. An account with no shop gets
   `not-found` / `shopId: null`, never a guess.
2. **Supplied then verified** — `saveMinishopConfig`, `getMinishopAnalytics` and
   `generateMinishopShareCard` accept a `shopId` and immediately call `_assertShopOwner`:

```js
const snap = await _db().collection('shops').doc(shopId).get();
if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
if (snap.data().sellerUid !== uid) throw new HttpsError('permission-denied', 'You do not own this shop.');
```

A supplied id that must be proved against the shop document before use is a **lookup key**,
not a trusted scope. This is the pattern the Marketing and Customers censuses found missing
elsewhere, and here it is present.

| scenario | outcome |
|---|---|
| SELLER_A → SHOP_B (theirs) | allowed |
| SELLER_A → SHOP_C (another seller's) | `permission-denied` |
| SELLER_A → a shopId that does not exist | `not-found` |
| an account with no shop, resolved path | `not-found` / `shopId: null` — no shop is created |

## The three ownership spellings — asked, not assumed

The instruction was not to "fix" these because they are ugly, but to establish whether each is
a legitimate writer-specific representation or a genuine authority conflict. Within the Store
domain the answer is clear, and it is **both**:

### `sellerUid` — the Store domain's single, consistent authority

Every Store path uses it: `_assertShopOwner`, `claimMinishopHandle`'s resolve query,
`getMyMinishop`, `minishop-v3`'s promotions. There is **no conflict inside Store** — it is one
field, used one way. Nothing needs changing here.

### `ownerId` — a different domain's spelling, and a real functional consequence

`analytics-engine`, `merchant-inventory`, `logistics-plus` and `finance-os` read `ownerId`.
That is not merely inconsistent naming: a shop document written by one of those subsystems
with `ownerId` and no `sellerUid` is **invisible to `claimMinishopHandle`**, whose resolve
query filters on `sellerUid` alone. The merchant is told *"No shop found for your account.
Please register as a seller first"* while owning a shop.

So this one **is** an authority conflict, but it belongs to shop *provisioning*, not to Store.
Store is the place it becomes visible, not the place to fix it. Recorded for the shop-identity
convergence rather than patched here.

### `ownerUid` — write-only in Store, and a dead rule elsewhere

`claimMinishopHandle` writes `ownerUid` into `minishopConfig`, and nothing in Store reads it
back. Separately, `firestore.rules` gates `minishopAnalytics` reads on
`resource.data.ownerUid` — and a repo-wide search finds **no writer of that field on
`minishopAnalytics`**. The client-SDK read path is therefore dead; `getMinishopAnalytics`
works only because it uses the Admin SDK with `_assertShopOwner`.

This is now the **fourth** instance of a rule gating on a field nothing writes —
`shopEmployees.sellerUid` (fixed), `disputes.sellerUid`, `posCustomers.sellerId` (fixed), and
now `minishopAnalytics.ownerUid`. Worth treating as a pattern rather than four coincidences.

## `followShop` — what is intended, and what is not

> **Status: hardened in Stage 1B.** Both problems below are closed — the shop is proved to
> exist inside the transaction, and `shopFollowers` is CF-only in the rules. Kept here because
> the reasoning is what makes the fix reviewable.

**Intended, and correct:** a non-owner may follow. Following is a shopper's action, and the
record is keyed `shopFollowers/{shopId}_{uid}` with `uid` taken from auth — so a caller can
only ever create or remove their own follow. That part needs no change.

**Problem 1 — the shop is never proved to exist.** `followShop` accepts any `shopId` string
and writes `minishopConfig/{shopId}` with `{ merge: true }`. A merge write to a missing document *creates* it, so any authenticated caller can
create arbitrary publicly-readable `minishopConfig` documents carrying a `followerCount`.

**Problem 2 — the counter can be desynchronised, and inflated without limit.** These two facts
sit in different files and are harmless apart:

- `followShop` decides idempotency by reading the follow document: `const alreadyFollowing = followerSnap.exists`, and only increments when it is absent.
- `firestore.rules` lets the client delete that same document directly: (delete rule not matched — re-check)

Together they form a loop a single account can run repeatedly:

```
followShop({shopId, follow:true})   → followerCount + 1, follow doc created
client deleteDoc(shopFollowers/…)   → follow doc gone, counter NOT decremented
followShop({shopId, follow:true})   → "not already following" → followerCount + 1 again
```

`followerCount` is displayed as a business figure, so this is a fabricated-metric path as well
as a data-integrity one — and it works against **any** shop, not only the caller's own.

Worth noting what is already right: `followerCount` **is** protected from the config writer — `PROTECTED_FIELDS` lists it as a server-maintained counter, so `saveMinishopConfig` cannot set it. The counter is guarded against the owner and left open to the follower path.

## What `claimMinishopHandle` writes, and who can change it after

| document | written | read | client write |
|---|---|---|---|
| `shopHandles/{handle}` | `{shopId, uid, handle, createdAt}` | `allow read: if true` (public — storefront resolution) | **none** — no rule permits it |
| `minishopConfig/{shopId}` | `{handle, shopId, ownerUid, updatedAt}` merged | `allow read: if true` (public storefront) | **none** directly; `saveMinishopConfig` writes it under `_assertShopOwner` and cannot touch `PROTECTED_FIELDS` |

Both are CF-only for writes, which is the right shape. The one caveat is the one above:
`followShop` also merges into `minishopConfig`, and it is the only path that writes there
without proving anything about the shop.

## Classification

| classification | capabilities |
|---|---|
| **SAFE** | `claimMinishopHandle`, `saveMinishopConfig`, `getMinishopAnalytics`, `generateMinishopShareCard`, `getMyMinishop`, `followShop` |
| **SAFE AFTER HARDENING** | — |
| **CLIENT-SCOPE / UNSAFE** | — |
| **BLOCKED** | — |
| **NEW AUTHORITY REQUIRED** | — |

### What Stage 2 may build on

Storefront identity (`getMyMinishop`, `claimMinishopHandle`), configuration
(`saveMinishopConfig`), analytics (`getMinishopAnalytics`) and the share card — all five are
server-decided and need nothing first. That is a coherent Store surface on its own.

### What must not go in yet

- **A follower count**, until the desync loop is closed. Showing a figure a single account can
  inflate without limit is the fabricated-metric rule, not a cosmetic concern.
- **Anything that assumes a shop exists because `minishopConfig/{shopId}` does** — that
  document can be created by `followShop` for a shopId nobody owns.

### Recorded for other stages, not fixed here

- `ownerId`-only shop documents are invisible to `claimMinishopHandle` → shop-identity
  convergence, not Store.
- `minishopAnalytics` rules gate on `ownerUid`, which nothing writes → the fourth instance of
  that pattern.

## Shop profile → storefront (2026-09-29)

The shop details wizard exists twice:
- **merchant-v2 › Shop details › Details** (`sokoni-merchant-shop-profile.js`) is the merchant surface.
- **seller.html "Create My Shop"** is kept for reference.

Both save through one authority, `saveShopProfile` (`functions/kasshop.js`). The server owns what reaches the public
storefront. Related: [[Marketplace]] · [[Payments]].

**Steps.** These are seller.html's five steps, with every field restored on reload. seller.html's reload lost seven of
them.

| Step | Fields | Where it lives |
|---|---|---|
| Identity | banner, accent colour (`#rrggbb`), logo, name, tagline, story, seller type; the SOKONI category is **read-only** | `shops/{id}` (images in `seller-assets/{uid}/…`) |
| Permits | KRA PIN, SBP, BRS numbers, plus KRA / SBP / BRS / fire / health **documents** | `shops/{id}/private/compliance` (owner-only); files in `kyc-documents/{uid}/…` (owner + admin read) |
| Shop setup | city, presence, address, Maps link, phone, email, website, six socials incl. LinkedIn; the opening hours are shown and edited in **Availability** (one timetable) | `shops/{id}`; hours in `providerAvailability/{uid}` |
| Delivery | method, usual time, delivery areas (15 standard plus your own), free-delivery threshold, packaging note, return policy (+ custom wording) | `shops/{id}` |
| Go live | real-data preview, readiness checklist, storefront link, announcement, reply time | extras in `minishopConfig/{id}` via `saveMinishopConfig` |

**Values are validated by the server.** A failing value is dropped and returned in `invalid`; an authority field is
returned in `ignored`.
- **Choice fields** accept only their codes.
- **Links:** images must be https; website and Maps links must be http(s). `javascript:` and `data:` are refused.
- **Socials** are stored as handles, even when a full URL is pasted.
- **themeColor** must be a hex colour.
- **freeDelivery** must be whole shillings.
- **Permit paths** must sit in the caller's own `kyc-documents` folder.

**The storefront projection.** `getMinishopPublic` resolves `minishopConfig` first and the shop document only to fill
gaps, so a profile saved only on the shop was hidden behind any older config. After every save, `_syncStorefront`
rebuilds the storefront copy from the canonical shop:
- tagline, description (= about), contact, logo, cover (= banner), brandColor (= accent);
- socials, where a cleared handle is deleted;
- location (address + city), also written to `shops.location`, which the storefront reads first;
- delivery areas and delivery policy (method + time + packaging);
- policies (returns).

The free-delivery threshold is **not** shown to buyers: no checkout path applies it. Delivery **fees** are SOKONI's
checkout quote (RES-1), not a seller setting.

**Storefront changes:**
- LinkedIn is shown.
- A "Returns & Refunds" block is added.
- Delivery areas render as a list.
- Every social and website link must be http(s) before it becomes an `href`. A stored `javascript:` website was a
  clickable script.

**Owner only.** A staff session sees "Owner only". `saveShopProfile` resolves the shop from the caller's own uid.

**Known, not changed here:** merchant-v2 Availability's `avSave` writes a formatted **string** into
`shops/{uid}.openingHours`. The server's shape is an object. The storefront reads `providerAvailability` first, so it
is unaffected. This is fixed in the Availability slice.
