# Homepage Feed Scaling — Mitigation + Tracked Technical Debt

**Status:** Emergency mitigation **VERIFIED IN CODE / AWAITING PRODUCTION DEVICE VALIDATION**
(2026-07-27, live SW v144). NOT closed — see §5. Scalable architecture TRACKED, not yet built.
**Owner area:** Homepage catalogue feed · [[ARCHITECTURE]] · [[Marketplace]]
**Related defect (separate):** `inspiq.js` / `feeds.html` unbounded infinite-scroll — see "Priority after" below.

---

## 1. What happened

The homepage subscribed to the **entire `products` collection** with no cap
(`onSnapshot(collection(db,'products'))` in `sokoni-db.js`). The Firestore SDK
retained every document — many still carrying **base64 image blobs** inline — in
the mobile renderer heap, and `_homeMergeFirestore` re-serialized the whole array
to `localStorage` on **every** snapshot. As the catalogue grew the heap saturated
on load; **scrolling** then forced layout/paint + lazy-image decode and tipped the
renderer into an out-of-memory crash. On iPhone Chrome/WebKit this presents as the
tab process dying and "Can't open this page" on reopen (same class as the Android
"Aw-Snap" renderer-OOM sentinel).

The listener was deliberately uncapped because **boosting is client-side**
(`sokoniAds` in `localStorage`, floated by `isProductBoosted`) — a naive server
`limit` could drop a boosted product that fell outside the capped set.

## 2. Mitigation shipped (this is a bleed-stop, NOT the final design)

| Change | File | Effect |
|---|---|---|
| Bound home listener to **newest 200** via `orderBy(documentId(),'desc'), limit(200)` (ids are `Date.now()` timestamps → newest-first, built-in `__name__` index, no composite index) | `sokoni-db.js` `listenProducts` | Caps SDK retention + array size |
| Filtered category/seller paths → plain `limit(200)` (index-safe, no `orderBy`) | `sokoni-db.js` | Caps filtered subscriptions |
| Warm-cache slice **60 items**, **base64 stripped** (data: URIs are rejected on render anyway; measured 15.5 MB → 39 KB) | `script.js` `_homeMergeFirestore` | Keeps `localStorage` at 0.76% of quota; no `QuotaExceededError` |
| Honest `SokoniDB.countProducts()` server count aggregate (1 RPC, no docs read), fetched once at idle | `sokoni-db.js` + `script.js` labels | "N+ products" reflects the true catalogue, not the capped 200 |

**Deploys:** OOM fix `552bca5` (live in SW v143 bundle). Hardening `bc6d61f`.

## 3. Behavioral changes introduced by the cap (documented on purpose)

- **Very old boosted products** (created before the newest 200) fall outside the
  fetched set and will **not float** on the homepage. In practice boosts are
  purchased on active/recent listings, so this is an edge case — but it is a real
  narrowing of behavior, not a no-op.
- **Per-category cap** applies a plain `limit(200)` in `__name__` (oldest-id-first)
  order — a category with >200 items returns an arbitrary 200, not the newest.
- **KASS chat "find X"** searches the 60-item warm slice (misses older products);
  it links out to full category search. Convenience-only, tracked separately.
- **No functional storefront regression:** homepage **search** → `search.html`
  (Algolia/Typesense/Firestore), **category** → per-category Firestore listener,
  **product detail** → `getDoc` by id. All bypass the capped array — verified.

## 4. Target architecture (the real fix — replaces the fixed cap)

The "newest 200" assumption ties **product visibility to product age**. Remove that
dependency:

1. **Server-side ranking determines the feed** — not client-side sort over a loaded
   array.
2. **Boosted products injected by the ranking service regardless of age** — retires
   the client-side `sokoniAds` boost hack that forced the no-limit design.
3. **Realtime subscriptions cover only the visible window** — not the whole feed.
4. **Pagination loads additional pages on demand** — incremental fetches instead of
   one live listener over everything.

At that point the emergency cap is deleted, not raised. Raising the limit as the
marketplace grows is explicitly **not** the plan.

## 5. Close criteria for the homepage OOM defect

Engineering + code-inferred checks are ✅ (bounded listener live, no search/category/
product-detail regression, warm cache < quota). The defect is closeable **only after
on-device validation on a real iPhone**:

- [ ] Scroll continuously for 3–5 minutes.
- [ ] Open several product pages and return repeatedly.
- [ ] Leave the app, reopen Chrome, and continue browsing.
- [ ] Reload the homepage multiple times.
- [ ] Chrome no longer exits or shows "Can't open this page."
- [ ] Repeat the same in Safari — both browsers remain stable.

Per [[RELEASE_ACCEPTANCE]] discipline: engineering-complete ≠ production-proven.
These device checks are not markable from the build environment.

## 6. Priority after homepage is confirmed stable

1. **Fix `inspiq.js` / `feeds.html` infinite-scroll OOM** — same memory class,
   different page: unbounded, non-virtualized, infinitely-refilling append with an
   unthrottled scroll fallback. **Build this as a reusable pagination module, not a
   one-off patch** (see below).
2. **Paginated feed architecture** — remove the fixed-cap dependency (§4.3, §4.4).
3. **Server-ranked feed + boost injection** — boosts appear regardless of creation
   date (§4.1, §4.2).

### 6a. Build one shared feed module, don't fix this twice

The homepage and `feeds.html` have the **same** scalability problem (unbounded live
feed → renderer OOM). Fix it once: a single reusable module owning **pagination +
virtualization (visible-window realtime) + ranking/boost injection**, consumed by
both the homepage feed and `inspiq.js`/`feeds.html`. This keeps feed behavior
consistent across SOKONI (one place for ranking, boost rules, page size, windowing)
and avoids solving virtualization separately per surface. Treat the `inspiq.js` fix
(priority 1) as the **first consumer** that establishes the module, not a throwaway
patch — the homepage cap (§2) is then retired by migrating it onto the same module
(§4), not by raising the limit. Aligns with [[project_platform_constitution]]
"extend don't rebuild / canonical engines".
