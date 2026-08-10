# MiniShop / KassShop — Claim Contract v1

Related: [[MiniShop]] · [[Authentication]] · [[Canonical Collections]] · [[Publication Contract]]

**Status:** engineering complete, **production proof pending** (device reload check).
**Owner of truth:** `shops/{shopId}.sellerUid`.

---

## 1. The one question

> Which shop does this **authenticated Firebase UID** own?

Everything else — the handle, the config, the storefront URL, the buttons — is downstream of
that. Ownership is never read from `localStorage`, `sessionStorage`, an `isClaimed` flag, a
`claimedShop` key, `minishopConfig` alone, `shopHandles` alone, or a URL parameter. Those are
caches and projections; a cache can be stale, cleared, or written by a previous account.

`sellerUid` is queried **first and by name**. A shop reached by document id must still name the
caller as its owner before it counts.

---

## 2. Three states — and LOADING is not UNCLAIMED

| State | Meaning | UI |
|---|---|---|
| `LOADING` | Auth or Firestore has not answered yet, **or** reads failed | neutral label — **never** a Claim button |
| `OWNER` | a shop names this uid as `sellerUid` | Shop Live (handle) / Set up storefront (no handle yet) |
| `UNCLAIMED` | reads **succeeded** and no shop names this uid | Claim Shop |

The distinction that matters: **an unknown answer is not a negative answer.** A seller who owns a
shop must never be invited to claim it again because the resolver could not reach Firestore.

Observable at runtime as `window.__miniShopState`:

```js
{ mode, shopId, ownerUid, handle, claimed, authUid, resolvedAt }
```

`authUid` is the uid the ownership question was actually asked with. When a seller reports "it
says unclaimed", the first useful fact is whether the resolver was asking about *them*.

---

## 3. Bootstrap ordering

```
onAuthStateChanged (event)  →  uid
        ↓
window.firebaseDB present    →  Firestore
        ↓
shops where sellerUid == uid →  ownership
        ↓
minishopConfig/{shopId}.handle  or  shopHandles where uid == uid  →  handle
```

**No timers.** A `setTimeout(resolve, 700)` cannot know when Auth is ready; on a cold mobile
start restoration routinely takes longer, and the resolver concluded "unclaimed" before there was
anyone to ask about — then never asked again.

Four ordering rules, each of which was a real defect:

1. **A `null` user is not an answer.** `onAuthStateChanged` fires immediately on subscribe with
   `null` while restoration is in flight, then again with the real user. Stay subscribed.
2. **Attach when Auth appears, not when the resolver is called.** `firebase.js` publishes
   `window.firebaseAuth` from an ES module, so it is usually absent when the shell's inline block
   runs.
3. **Auth can be ready before Firestore.** Wait for the database too, or a session latches
   LOADING forever.
4. **A failed read is not an empty read.** Count read failures; nothing-found *with* failures is
   UNKNOWN → LOADING.

---

## 4. Claim write — `claimMinishopHandle`

Guarantees:

- **Never creates a shop.** No shop with `sellerUid == uid` → `not-found`. A claim that minted a
  shop would split the seller's products, orders and settlement across two identities.
- **Transactional.** The handle reservation and the config write are one operation. The previous
  read-then-batch let two sellers both pass the existence check, with the second `set` silently
  overwriting the first — both reporting success.
- **Idempotent, and repairing.** Re-claiming your own handle succeeds and re-asserts
  `minishopConfig/{shopId}`, so a claim whose config write was lost is fixed rather than reported
  "already yours" forever.
- **Refuses a handle that points at a different shop on your own account** rather than repointing
  it.

Writes:

| Document | Fields |
|---|---|
| `shopHandles/{handle}` | `shopId`, `uid`, `handle`, `createdAt` |
| `minishopConfig/{shopId}` | `handle`, `shopId`, `ownerUid`, `updatedAt` (merge) |

Returns `{ success, handle, shopId, ownerUid, url }`.

**No fake success.** The client shows `@handle claimed!` only when `success === true` and the
server returned a handle — and it uses the **server's** handle, not the text still in the input.
Otherwise: *"Claim failed — your shop was not saved."*

---

## 5. Tests

| Suite | Run | Proves |
|---|---|---|
| `test-minishop-claim-persistence.js` | `npm run test:claim:persistence` | claim survives page destruction, a cleared cache and late Auth; another seller's shop is not mine; denied reads never render Claim |
| `test-minishop-claim-write.js` | `npm run test:claim:write` | the handler never creates a shop, is idempotent, repairs a lost config, refuses a concurrent claim (Firestore fake) |
| `test-minishop-claim-firestore.js` | `npm run test:claim:firestore` | the same handler against the **real** transaction engine, with genuine concurrent contention |

The third suite exists because the claim's most important property is a *concurrency* property,
and a hand-written fake is the weakest possible place to prove one — a bug in my model of
Firestore would hide a bug in the code. It fires six simultaneous claims for one free handle,
then repeats a four-way race ten more times, and requires exactly one winner each time whose
stored `uid` matches the caller who was told they won. **Needs JDK 21** — `firebase-tools` refuses
to start its emulators below that.

The persistence suite asserts `shopId`, `ownerUid` and `mode` **only**. It deliberately does not
assert a button, a CSS class, an ARIA attribute or a `localStorage` key — none of those are
evidence that anything persisted.

> Both suites must run with `serviceWorkers: 'block'`. The SOKONI service worker takes control
> ~2s into the page and serves gstatic from its own cache, which Playwright's `route()` does not
> intercept — so a stubbed Firestore silently becomes the real SDK partway through a run. That
> made the suite alternate between pass and fail while measuring its own service worker.

---

## 6. Device acceptance — NOT YET SIGNED OFF

Run on a real phone, signed in as a seller who owns a shop:

1. **Claim** a handle → the toast appears **only after** the write succeeds, and the diagnostic
   line reads `Claim: SAVED (<handle>)`.
2. **Reload** the page → still owner mode. No Claim button. Same Shop ID and Owner UID.
3. **Force-quit and reopen** the PWA → same result.
4. **Sign out and back in** → same shop resolves, same `shopId`.

Until steps 1–4 are observed on a device, this contract is **engineering complete, not production
proven** — see [[Release Validation Standard]].

**Still unproven:** the security rules for `shopHandles` and `minishopConfig`. The admin SDK
bypasses rules, so the emulator suite proves the handler, not the authorization around it.
`firebase.json` declares no Firestore rules file, so the emulator defaults to allow-all — wiring
rules into the emulator is the next step for that gap.

---

## 7. Temporary diagnostic

The merchant shell renders a seller-only readout beneath the storefront entry:

```
Shop ID: <id>  ·  Owner UID: <uid>  ·  Claim: SAVED (<handle>) | NOT CLAIMED (shop owned) | NO SHOP | RESOLVING
```

It is a **readout** of `window.__miniShopState`, never a source of truth. Remove once §6 is
signed off.
