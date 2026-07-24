# Search Fallback Architecture — v1.0

**Date:** 2026-07-23
**Status:** Engineering complete · pending production verification (see §7)
**Owner module:** `sokoni-firestore-search.js`
**Related:** [[SEARCH_QUALITY_REPORT]] · [[Enterprise Search Platform]] · [[Commerce Lifecycle]] · [[PLATFORM_CONSTITUTION]]

---

## 1. Why this layer exists

Search on SOKONI is served by Algolia. Firestore is the system of record. When
those two disagree — and they disagree whenever the index is stale, unbackfilled
or unreachable — a buyer must still be able to find stock that is live in
Firestore.

The reported failure: a seller (Kass Vapes) listed products (e.g. *Cool Mint*)
that were visible on the store page but returned **no results** on
`search.html`, for the product name and for the store name alike.

Four independent defects produced that outcome. Each alone was enough.

| # | Defect | Effect |
|---|--------|--------|
| 1 | `search.html` policy: *"Algolia 0 hits → empty state, NEVER fall through"* | A stale/degraded index rendered "No results" over stock that exists |
| 2 | `sokoni-search-engine.js` returns `{ fallback: true, totalHits: 0 }` when it has no secured key | Indistinguishable from a genuine miss under defect 1 |
| 3 | Fallback queries carried no `where()` clause on rule-gated collections | Firestore **denied the entire list query**; services, providers, properties, propertyListings, vehicles, digitalJobs and healthProviders silently returned nothing |
| 4 | No collection in the fallback held stores | A shop was unfindable by name under any spelling |

Plus a fifth inside the engine's own fallback: it used the **compat** SDK
(`firebase.firestore()`, never loaded — `firebase.js` initialises the modular
SDK) and matched names with `startAt(q).endAt(q)`, an exact-equality range
against an original-case field, so a lower-cased query could never equal
`"Cool Mint"`.

---

## 2. Query path (revised)

```
search.html  doSearch(q)
   │
   ├─ Path A  Algolia  (sokoni-search-engine.js)
   │     ├─ hits > 0 ..................... render, done
   │     └─ hits == 0 OR fallback:true ... continue  ◀── policy change
   │
   ├─ Path B  Typesense  (sokoni-typesense-engine.js)
   │     └─ hits == 0 or unavailable ..... continue
   │
   └─ Path C  Firestore  (sokoni-firestore-search.js)  ◀── new implementation
```

`fallback: true` on the engine response is the explicit degraded-mode signal;
Path A now reads it rather than inferring health from a hit count.

---

## 3. `sokoni-firestore-search.js`

One implementation, two consumers: the `search.html` page module (ESM import)
and `sokoni-search-engine.js::_firestoreFallback` (dynamic import). The header
autocomplete in `shared-header.js` uses it as its last resort before the bare
"search for X" shortcut. Nothing else duplicates collection specs or link
mapping.

### 3.1 Rule-aware queries

Each collection spec carries a `guard` returning the `where()` constraints
`firestore.rules` requires. This is **not** an optimisation: Firestore rejects a
list query it cannot prove is safe, so an unguarded query on a status-gated
collection is denied outright, not merely slow.

| Collection | Guard | Rule source |
|---|---|---|
| `products`, `sellers`, `bnbListings`, `entEvents`, `entVenues`, `mechanics`, `lawyers` | none — `allow read: if true` | firestore.rules |
| `services`, `properties`, `vehicles`, `digitalJobs` | `status in ['active','published']` | firestore.rules |
| `propertyListings`, `healthProviders` | `status == 'active'` | firestore.rules |
| `providers` | `status in ['active','approved']` | firestore.rules |
| `applications` | **removed** — read is admin/owner only, a buyer could never list it | firestore.rules |
| `shops` | **not queried** — no rule exists for `/shops`, so a list query is denied. `sellers/{uid}` is the readable copy `store.html` already falls back to | firestore.rules |

### 3.2 Match strategy

1. **Indexed lookup** — `searchableTerms array-contains <token>`, then a
   `nameLower` prefix range. Both run on automatic single-field indexes; no
   composite index is required, so this cannot fail on a cold project.
   Available only on **unguarded** collections: pairing `array-contains` with a
   status filter would demand a composite index the project does not carry.
2. **Bounded scan (cached)** — products predating the `indexProductCreate`
   trigger have no `searchableTerms` at all, and no non-product collection is
   indexed. A capped scan per collection (150–400 docs) makes those findable.
   Cached for 10 minutes per session, so the cost is paid once per collection,
   not once per keystroke.
3. **Pass 1 — AND** — every token must appear. `"cool mint"` narrows `"mint"`.
4. **Pass 2 — relaxed** — only when pass 1 is empty: keep rows matching at least
   one meaningful (≥3 char) token, rank by tokens matched. This is what lets
   `"kass shop"` still find *Kass Vapes*. It re-uses the already-fetched
   documents, so it costs **zero** extra reads and can never dilute a strict
   match.

### 3.2b Variant attributes (2026-07-24)

Seller-declared variants — `colors`, `sizes`, `storage`, `weights`, `volumes`,
`materials` — are searchable through **both** paths above:

* **Indexed** — `functions/search-terms.js` folds every variant value into
  `searchableTerms`, so `array-contains 'black'` hits the automatic index with
  no composite index and no extra read. Variant values are indexed at a
  **minimum length of 1**, unlike the text fields' 2-character floor, which
  would silently drop the sizes `S`, `M` and `L`. A number-then-unit value also
  contributes its parts, so `256 gb` matches a product stored as `256GB`.
* **Scan** — the fields are in the products spec's `fields` list and in `KEEP`,
  so a product the trigger never touched still matches offline and from the
  warm localStorage catalogue.

The localStorage catalogue key moved to `sokoni_fs_catalogue_v2`: a v1 payload
was slimmed before `KEEP` carried these fields, so serving one would make
variant queries silently miss until the entry aged out.

See also [[Commerce Lifecycle]] for the write side, and
`npm run check:variants` for the parity gate that stops the browser schema and
the Cloud Functions key list from drifting.

### 3.3 Visibility contract

Mirrors `realtime.js::_isVisibleProduct`, the platform rule: a listing is hidden
only when it **explicitly** says so — `isVisible === false`, `suspended === true`,
or a status of `archived` / `deleted` / `hidden` / `removed` / `banned`.
**Absent status means visible**, because most live products carry no status
field; a `status === 'active'`-only rule would hide the catalogue.

---

## 4. Read budget

| Situation | Firestore reads |
|---|---|
| Algolia healthy, hits > 0 | 0 |
| Algolia zero-hit, first query of session | ≤ ~2,400 (all collections, capped), then cached |
| Subsequent queries in the same session | ~0 — served from the 10-minute scan cache |
| Per keystroke | 0 extra (debounced 200 ms, cache-served) |

The scan caps are deliberate ceilings, not estimates. `invalidateScanCache(col)`
drops a collection's cache after a write that must be immediately findable.

---

## 5. Security

- No rule was changed or relaxed. The fix makes queries **conform** to existing
  rules instead of being denied by them.
- No new client trust: results are read-only and rendered through the existing
  escaped-render path in `search.html` (`escHtml` on every field).
- Hidden/soft-deleted/suspended listings are filtered client-side **and** remain
  protected by rules on the collections that gate reads.
- `store.html?id=` and `product.html?id=` links are `encodeURIComponent`-escaped
  at construction.

---

## 6. Testing

`scripts/test-firestore-search.js` — offline, no credentials, no network.
Run: `npm run test:search`.

The stub SDK reproduces the two production behaviours that hid the bug:
a rule-gated list query without its guard **throws permission-denied**, and
documents carry `searchableTerms` only when the trigger wrote them.

14 assertions, currently 14 PASS — including the reported failure (`cool mint`),
store lookup (`kass vapes`), the relaxed pass (`kass shop`), AND semantics,
soft-delete invisibility, rule-gated collections, tab scoping and cache
behaviour.

This test caught a real defect during development: the indexed path was being
denied on `providers` because it omitted the rule guard.

---

## 6b. What live tracing found (2026-07-23, post-deploy)

Two further defects sat **upstream** of everything in §1, in the Algolia client
itself. Both predate this work and both meant Algolia never reached an index:

1. `search()` passed `_fetch` the caller's raw `opts` instead of its normalised
   ones. Every caller on `search.html` omits `facets`, so `_fetch` threw
   `Cannot read properties of undefined (reading 'length')` **before any request
   was sent** — Algolia "failed" on every query regardless of index health.
2. `multiSearch()` posted `requests[].params` as a JSON object. Algolia's
   `/1/indexes/*/queries` requires a URL-encoded **string** and answered
   `400 Expecting a string (near 1:40)` every time.

With both fixed, Algolia now answers `Invalid Application-ID or API key`. The
`getAlgoliaSearchKey` CF is healthy (returns a 1,256-char secured key for app
`FF2WSTR4YC`), so the `ALGOLIA_SEARCH_KEY` secret holds a value Algolia rejects.
**Algolia is not serving search today**; the Firestore path carries all traffic.

Other live findings, not fixed here:

- `sellers` is **empty in production** and `/shops` has **no rule**, so no store
  document is readable. A shop-name query still returns that shop's goods via
  `sellerName` / `businessName` on the products, but a dedicated store row is
  impossible until one of those two is addressed. `store.html` is affected the
  same way (its `shops/{uid}` read is denied, and the `sellers` fallback is empty).
- The secured key applies `filters: 'status:active OR status:published'`. Once
  the key is valid, products whose `status` is absent will be filtered out of
  Algolia results even though the platform treats absent status as visible —
  the same mismatch this module avoids on the Firestore side.

## 7. Production verification — DONE (2026-07-23)

Verified in a real browser (Playwright, headed — headless fails App Check
attestation and every Firestore read is denied, which is a harness limitation,
not a product defect) against `https://mysokoni.co.ke` after deploy:

| Query | Results |
|---|---|
| `cool mint` | 3 — both COOL MINT products + a related e-liquid |
| `kass` / `kass vapes` | 12 — the seller's full catalogue |
| `vape` | 19 |
| `mint` | 5 |
| `toyota`, `plumber` | 0 — no matching listings exist in those collections |

No `permission-denied` warnings for any collection. Tab counts populate
(`All 12 / Products 12`). Businesses stays 0 for the reason in §6b.

## 7b. Latency — profiled and fixed

Correct results arrived 15.5s after navigation because the paths ran in series,
slowest and least useful first. Profiled on the live site:

| Stage | Cold cost |
|---|---|
| Algolia attempt (incl. engine's own Firestore fallback) | 4.1s |
| Typesense (unreachable) | 1.6s |
| Firestore (this module), cold | 1.7s |
| Firestore, warm (scan cache) | 0.7s |

Changes: Firestore runs **in parallel** with Algolia and is consulted **before**
Typesense; per-session circuit breakers skip an engine that has already thrown;
`skipFirestoreFallback` stops the engine duplicating reads the page repeats; the
`?q=` bootstrap wait dropped from 3s to 800ms.

Result: median cold **7.7s** (12.8 / 7.6 / 7.7 across three fresh contexts),
typed queries **1.5–2.0s**. What remains is page load plus Firebase/App Check
initialisation before the first Firestore read can succeed — platform-wide, and
the next thing to attack if search latency matters more.

## 8. Superseded verification checklist

Per [[Release Validation Standard]], the above is **Engineering Complete**, not
Production Proven. To close:

1. Deploy hosting, hard-reload (service-worker cache version bumped to
   `sokoni-20260723-app-shell-v100`).
2. On `search.html`, search `cool mint` and `kass` — expect results and a
   console line `[SOKONI Search] Algolia returned 0 hits … falling through`
   confirming which path answered.
3. Confirm no `Missing or insufficient permissions` warnings remain in the
   console for any collection.
4. Separately establish whether Algolia is degraded at all: check whether
   `getAlgoliaSearchKey` returns a key. If it does not, the Firestore path is
   now carrying **all** search traffic — acceptable but not the intended
   steady state, and the index backfill / `ALGOLIA_ADMIN_KEY` secret should be
   resolved.
5. If products are missing `searchableTerms`, run
   `node scripts/backfill-search-terms.js --apply` to restore the indexed path.
