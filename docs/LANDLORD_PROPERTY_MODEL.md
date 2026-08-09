# Landlord property model — architecture options

**Date:** 2026-08-02 · **Status:** analysis only. No schema change, no migration.
**Recommendation:** **Option B**, and the measurement says decide now rather than later.

Related: [[Properties Data Source]] · [[Publication Contract]] · [[Platform Constitution]]

---

## 1. Measured production state

| collection | documents |
|---|---|
| `landlordData` | **0** |
| `landlordProperties` | **0** |
| `bnbListings` | **0** |
| `properties` / `propertyListings` | **0** |

Declared Firestore indexes touching `landlord*`, `bnb*` or `propert*`: **none**.

**Migration cost today is zero.** There is no data to move, no index to rebuild, no consumer to
coordinate with. Every month this is deferred, that stops being true — and the cost of Option A is
paid quietly, in write amplification, long before it is paid loudly, at the 1 MiB ceiling.

## 2. Measured read and write paths

`landlordData` appears in **exactly two places** in the entire repository:

| location | role |
|---|---|
| `firestore.rules:1493` | the rule |
| `landlord.html:873` | the write |

**There is no reader. Anywhere.** Not `landlord.html` itself, not `admin.html`, not any Cloud
Function, not any other page.

```js
function getData(){  return JSON.parse(localStorage.getItem("sokoniLandlordProperties")) || []; }
function saveData(d){
  localStorage.setItem("sokoniLandlordProperties", JSON.stringify(d));   // ← authority
  setDoc(doc(db,'landlordData',uid), {uid, properties:d, updatedAt}, {merge:true});  // ← write-only mirror
}
```

So today: **localStorage is the authority and Firestore is a write-only mirror nothing reads back.**
Three further problems fall out of that shape:

1. **The whole array is rewritten on every save.** Editing one property's rent rewrites every property
   the landlord owns. Write amplification is O(n) per edit.
2. **The uid comes from `localStorage.sokoniUser`, not Firebase Auth.** If that key is absent or stale
   the mirror silently does not happen — `if(!uid) return;` inside a `catch(){}`.
3. **A landlord's properties are invisible to moderation.** The admin Properties pane still reads
   `sokoniLandlordProperties` from its own browser, so nothing a landlord creates can be reviewed.

There is also a second local-only key, `sokoniProperties_listings`, with no Firestore counterpart at
all.

## 3. The options

### Option A — keep `landlordData/{uid}` with `properties: []`

| | |
|---|---|
| **Scalability** | One document per landlord. At ~1 KB per property, roughly **1,000 properties before the 1 MiB document limit** — fine per landlord, but the ceiling is real and arrives without warning. |
| **Query cost** | Cannot query properties. Every filter — by city, by rent, by status — must load **every landlord document** and filter in memory. An admin list is a full collection scan. |
| **Write amplification** | **O(n) per edit.** Changing one field rewrites the whole array, and two concurrent edits by the same landlord lose one of them silently (`setDoc` with `merge` replaces the array wholesale). |
| **Indexing** | Not indexable. Firestore cannot index inside an array of maps for range queries. |
| **Moderation** | **No per-property status is possible.** A property cannot be approved, rejected or suspended individually without rewriting its landlord's whole document. |
| **Ownership** | Clear — the document key *is* the owner. This is Option A's one genuine strength. |
| **Backward compat** | Nothing to change. Also nothing to gain: no reader exists. |

### Option B — a `landlordProperties` collection, one document per property

| | |
|---|---|
| **Scalability** | Unbounded. Standard collection. |
| **Query cost** | `where('landlordUid','==',uid)`, `where('status','==','pending')`, `orderBy('createdAt')` — all cheap and paginable. The admin queue becomes a query instead of a scan. |
| **Write amplification** | **O(1).** One property, one document. Concurrent edits to different properties cannot collide. |
| **Indexing** | Ordinary composite indexes. Two would be needed (`landlordUid+createdAt`, `status+createdAt`) — and the index registry governance already exists for that. |
| **Moderation** | **Per-property `status`, identical to `bnbListings`.** The same `_decideProp` path shipped in Properties Commit 2 works with a collection swap. |
| **Ownership** | `landlordUid` field, enforceable in rules exactly as `bnbListings` enforces `hostUid`. |
| **Backward compat** | `landlord.html` changes from one `setDoc` of an array to per-property writes. **Zero documents exist, so nothing is migrated.** |

### Option C — fold rentals into `bnbListings`

| | |
|---|---|
| **Scalability** | Same as B. |
| **Query cost** | Same as B, plus a `listingType` discriminator on every query. |
| **Write amplification** | O(1). |
| **Indexing** | Every existing `bnbListings` index needs `listingType` added, or queries return the wrong product type. |
| **Moderation** | One queue for both — **genuinely attractive**, and the Algolia index is already generically named `sokoni_properties`. |
| **Ownership** | `hostUid` would have to mean both "host" and "landlord". |
| **Backward compat** | **Breaks the create rule.** `bnbListings` requires `hasAll(['id','name','type','location','price','phone','hostUid'])` and `bnb.html` reads `pricePerNight`. A monthly rental has `rent`, not `pricePerNight`, and no nightly semantics. The rule and every consumer would need widening. |

## 4. Recommendation — Option B

**A short-stay booking and a monthly tenancy are different products with different lifecycles**: nightly
price vs monthly rent, per-night availability vs occupancy, guest bookings vs tenancy agreements. C
merges two lifecycles into one collection and one rule to gain a shared moderation queue — a queue
that can be shared anyway, because moderation reads a projection, not the collection.

Option B gets C's real benefits without its cost:

- one document per property, queryable and individually moderatable
- the `_decideProp` write path from Properties Commit 2 works with a collection swap
- rentals can be projected into the same `sokoni_properties` Algolia index as `bnbListings`, giving
  one search surface without one storage shape
- ownership enforced in rules the same way `bnbListings` already enforces `hostUid`

Option A should be ruled out regardless of what replaces it: **no per-property moderation** is
disqualifying for a platform that reviews listings, and it is not fixable without leaving the shape.

## 5. Migration cost

**Today: effectively zero.**

| step | cost |
|---|---|
| create `landlordProperties` rules | mirror the `bnbListings` block |
| add 2 composite indexes | via the existing index registry |
| `landlord.html` — per-property writes | ~30 lines; `saveData()` splits into create/update/delete |
| admin pane — read + moderate | reuses `listenBnbListings` and `_decideProp` verbatim |
| **data migration** | **none — 0 documents exist** |
| **backfill** | **none** |
| **consumer coordination** | **none — `landlordData` has no reader** |

The only thing that grows with delay is the number of landlord documents that would later need
splitting, and the number of consumers that would need coordinating.

## 6. What this document does not do

No schema is changed, no collection created, no rule edited, no data moved. `landlordData` and
`sokoniLandlordProperties` are untouched and the admin Properties pane still reads the localStorage
key — **so Properties remains incomplete by the completion rule**, and deliberately so until this
recommendation is accepted or replaced.
