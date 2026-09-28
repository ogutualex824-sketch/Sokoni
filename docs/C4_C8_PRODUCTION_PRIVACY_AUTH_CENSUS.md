# C4/C8 — Production privacy & KASS-auth census (read-only)

**Date:** 2026-09-28 · **Method:** read-only. Nothing was written or deployed. Related: [[KASS]] · [[Search]] ·
[[Security]] · [[C4_PRODUCTION_BASELINE]]

**Sources of evidence:**
- **Served rules:** Firestore default `6c67a34d-bb07-4fd5-8934-32d6b547a276`. It was re-confirmed as served on
  2026-09-28 via the rules releases API (unchanged since 2026-09-22T20:19:30Z).
- **Deployed functions:** each one's OWN source archive, read at its pinned generation:

| Function | Live revision |
|---|---|
| `catalogue` | `catalogue-00007-pef` |
| `sokoniChat` | `sokonichat-00058-hal` |
| `getMinishopPublic` | `getminishoppublic-00011-now` |
| `getAlgoliaSearchKey` | `getalgoliasearchkey-00029-jus` |
| `getTypesenseSearchKey` | `gettypesensesearchkey-00025-sul` |
| `smartPosDispatch` / `applicationLifecycle` | the archives preserved by the 2026-09-28 C4a baseline check |

**Live hosting:** `be7c676` (`firebase.json` rewrites: `/api/catalogue` → `catalogue`, `/api/chat` → `sokoniChat`).

The branch `firestore.rules` is NOT what production serves. Every rule below is the SERVED text.

## Findings

| # | Finding | Live? | Severity | Evidence |
|---|---|---|---|---|
| 1 | **KASS public chat accepts any non-empty token.** `/api/chat` only rejects a MISSING `auth_token`. An invalid or garbage token makes `_verifyKassToken` return `null`, and the request continues as a guest with every read tool. The code comment says "Require auth". | **LIVE** | High (AI cost and abuse surface; the auth intent is not enforced) | `sokoniChat` `index.js:1657-1669`, `:1308-1314` |
| 2 | **`book_stay` writes a booking priced by the AI.** `totalPrice = pricePerNight × nights`, where `pricePerNight` is the model's tool input, and it is returned to the user as the booking total. It requires a real login. The live "Pay Now" link (`wallet.html?bookingId=`) does **not** read `bookingId`, so no proven charge uses it. Whatever else consumes `bookings.totalPrice` is UNDETERMINED. | **LIVE** | High (money-data integrity) | `sokoniChat` `index.js:1609-1620`; `be7c676:wallet.html` (no `bookingId` reference) |
| 3 | The KASS prompt hard-codes "SOKONI takes 12%; seller keeps 88%", while the same file's analytics say marketplace orders are charged 3%. | **LIVE** | Medium (false financial statements) | `sokoniChat` `index.js:1874` vs `:710` |
| 4 | **The admin KASS `approve_seller` still sets a seller active or suspended directly**: a second approval authority, admin + MFA only. The branch fixed this (C8); production has not. | **LIVE** | Medium | `sokoniChat` bundle `index.js:587-592` |
| 5 | **`businesses/{bizId}` is publicly readable** (`allow read: if true`). The owner may update `category`, `phone` and `email` on it. | **LIVE** | Medium, and it blocks the shop-category authority: the category must not stay owner-writable | served rules `:1652-1662` |
| 6 | The deployed POS writer stores `pairingToken`, `apiPublicKey`, `posCode` and `storeCode` on the public `businesses/{merchantId}`. **Mitigation:** `pairDevice` checks ownership or staff (`_assertMerchantAccess`) BEFORE comparing the token, so the token is a second factor, not an authority. | **LIVE** | Low (defence-in-depth leak) | `business-bootstrap.js:993-1012`, `:1103-1127`, `:103-127` |
| 7 | The deployed approval (`applicationLifecycle`) writes nothing to `businesses`. The branch's `projectSeller` phone/email copy is NOT live. | n/a | — | the LC archive has no `collection('businesses')` |
| 8 | **`shops`, `sellers`, `products` and `stores` are all `allow read: if true`.** `providers` is readable by ANY signed-in user. `getMinishopPublic`'s blacklist (`sellerUid`, `bankDetails`, `taxPin`) is therefore moot: those fields, if stored on `shops/{id}`, are directly readable. | **LIVE** | UNDETERMINED until the field census (below) | served rules `:595`, `:1061`, `:1118`, `:213-215`, `:3852` |
| 9 | `/api/catalogue` returns whole product docs (only `_syncedAt` and base64 images are stripped), with no shop-status check. It exposes nothing beyond the public `products` rule. | **LIVE** | Tied to #8 (whether `costPrice` / `wholesalePrice` are stored) | `catalogue` `index.js:7250-7290` |
| 10 | **Every GUEST Algolia search key includes `sokoni_users`.** The deployed users sync indexes every non-private account (buyers included): display name, username, bio, avatar, role, city, county, join date. Firestore `users` is owner/admin-only, so the index bypasses that boundary. Email and phone are NOT indexed. | **LIVE** | Medium (user enumeration / privacy) | `algolia-secured-keys.js:41-67`, `:171-176`; `algolia-indexer.js:908-935`; `algoliaSync_users_*` deployed |
| 11 | Typesense: guests are excluded from `sokoni_users`, but signed-in buyers are not. The `sellers` transformer stores `phone` (unsearchable but returned; no `exclude_fields` on the keys). Whether the live Typesense cluster holds these documents is UNDETERMINED (not queried). | **LIVE code** | Low (shop contact phone) | `typesense-secured-keys.js:52-56`; `typesense-client.js:938` |

## Not determined, and why

- **Which sensitive fields live `businesses` / `shops` / `sellers` / `products` documents actually carry.**
  - An unauthenticated REST read was refused for ALL four, **including `products`, whose served rule is
    `allow read: if true`**. That positive control shows the refusal is App Check enforcement on raw REST, not
    privacy: a browser on the site holds an App Check token and is bounded only by the rules above.
  - A field-NAME-only census with the maintainer's read-only IAM token was **blocked by the session's safety
    classifier**. It needs the owner's explicit go-ahead.
- Whether any consumer other than the (non-reading) wallet uses `bookings.totalPrice`.
- The Typesense cluster's contents, and which engine `searchConfig/settings` makes primary.

## Consequences for the plan (owner sequence, 2026-09-28)

1. **KASS auth** (#1): fix before any KASS commerce. Define guest capabilities explicitly; an invalid token must be
   refused, not downgraded.
2. **KASS booking price** (#2): `listing → canonical price → availability → total`; the model may pick a listing,
   never set a price.
3. **Shop category authority**: #5 means the category is currently owner-writable on `businesses`. The new authority
   must also close that write path, in the served lineage.
4. Privacy: #10 (guest keys must not include `sokoni_users`) needs no data read to fix. #8 / #9 wait on the field
   census.
