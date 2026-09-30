# Home — Picked For You, Edit Interests, New Arrivals and the daily grids, in sync with the catalogue

**Date:** 2026-09-30 · **Surface:** `index.html` (Home) · **Lineage:** hosting candidate on `hosting/home-picked-for-you-on-2f3bb6f`, descending from the live hosting commit `2f3bb6f` (v645) · **Status:** **DEPLOYED 2026-09-30 09:32Z** as `d55c112` (owner said "deploy"), Hosting v646 `sokoni-20260930093216-v646`; artefacts `12edf13`; rollback version `6f7202bd5dd81d84`. Follow-up `sokoni-recommendations.js` App Check wait+retry **DEPLOYED 10:36Z as tree b108ae3 (hosting content = 85699a0), Hosting v647**; served file byte-identical to 85699a0; two earlier attempts were machine-state false blocks (peer WebKit orphans: suite timeouts, then node --check out-of-memory in the syntax gate). Real-browser recommendation cards with valid App Check remain UNDEMONSTRATED (headless Chromium is App-Check throttled).
**Suite:** `node scripts/test-home-picked-for-you.js` (39 / 0, real `index.html` in Chromium through the page harness) · registered as a required hosting predeploy suite.
**Related:** [[RELEASE_GATE_LIVE_CATALOGUE]] · [[HOMEPAGE_FEED_SCALING]] · [[HOME_PERFORMANCE_INVESTIGATION]] · [[Marketplace]]

---

## 1 · What the owner asked

> "edit interests in picked for you in home page does nothing fix it and everything around it make sure new arrivals work all product work and are all in sync with the inventory for everything" · "even feed should show 6 on home page"

## 2 · Census — what was actually broken (measured live, read-only, 2026-09-30)

| # | Observation on `mysokoni.co.ke` | Cause in code |
|---|---|---|
| 1 | **Edit Interests did nothing** for a returning visitor: after the click the picker's `innerHTML` length was **0**. | The inline handler toggled the container and called `InspIQ.renderPicker()`, which **empties the container when `hasInterests()` is true** — i.e. for exactly the person pressing Edit. `renderPickerEdit()` existed and was never wired to the button. |
| 2 | For a fresh visitor the button toggled the picker but every early tap could throw: `InspIQ` is **lazy-loaded** by `sokoni-lazy.js` on the first interaction, so at the moment of the first click the global did not exist yet. | No readiness contract in the lazy loader; the handler assumed the module. |
| 3 | **Picked For You (SokoniRecs) never rendered** — `#sk-recs-foryou` had 0 children on every visit, console: `[SokoniRecs] module not loaded — recommendations skipped`. | Its loader ran at `DOMContentLoaded` and bailed because the module is lazy-loaded and arrives later. |
| 4 | Console on every home visit: `[RT] products: Missing or insufficient permissions.` | `realtime.js` (injected on every page by `security.js`) attached a **second** products listener beside the canonical `SokoniDB.listenProducts`, before the App Check token existed. When it did succeed it re-rendered the Trending grid with a different visibility rule. (The earlier "needs an index" reading was wrong: the failure code is permission-denied; the `orderBy(documentId())` query needs no composite index.) |
| 5 | New Arrivals rendered 20 cards once and **never again**: `displayNewArrivals` returned on every later call once built, so a stock change, a sell-out or a seller's delete delivered by the live listener reached Trending but not New Arrivals. | One-shot deferral guard; no re-render path. |
| 6 | New Arrivals applied **no listing rule** (Trending applies `SokoniSellability.isPubliclyListed`), and sorted `uploadedAt` with `new Date(obj)` → **NaN** for the one live product whose `uploadedAt` is a Firestore Timestamp object (96 of 97 are numbers). | Missing predicate; shape-blind sort. |
| 7 | **Fastest Selling, Big Discounts, Today's Picks**: markup present, `display:none`, functions defined — **never called from anywhere** (no caller exists in git history). 81 of 97 live products have `sold > 0`. | Dead code paths. |
| 8 | A product the catalogue no longer returned was preserved **forever** as "local-only" on Home (the warm cache resurrected it on the next visit). | `_homeMergeFirestore` ignored the listener's authority stamp that `category.html` already obeys. |
| 9 | Trending could show a **previous render's rows under the current one**: `displayProducts` appends its second batch at idle, and a newer render (live snapshot) in between did not cancel the older batch. Proven in the harness (demo rows appended under the real catalogue). | No render token. |
| 10 | The "See all" link in Recommended never rendered: it was concatenated onto the return value of `_attachPcardDelegation` (undefined). `#recommendedContainer` does not exist on today's `index.html`, so this is dormant. | Expression bug. |

Live catalogue shape (public `/api/catalogue`, 97 products): all carry numeric `stock`; 86 carry no `status`; 1 `outOfStock:true`; 1 `stock ≤ 0`; 96 numeric `uploadedAt`, 1 Timestamp object; 11 have `createdAt`.

## 3 · What changed (hosting only — no Functions, no rules, no indexes)

| File | Change |
|---|---|
| `sokoni-lazy.js` | **Readiness contract.** `window.SokoniLazy = { load, whenLoaded(src), isLoaded(src) }`; each lazy script settles a promise on its `onload`/`onerror` and dispatches `sokoni:lazy-loaded {src, ok}`; `sokoni:lazy-complete` when the whole list has settled. A failed load settles `false` so no waiter hangs. |
| `inspiq.js` | `toggleEditor(containerId)`: open → close; closed → `renderPickerEdit` when `hasInterests()`, else `renderPicker`; maintains `aria-expanded` on `#inspiqEditBtn`. `applyPick` / `applyPickEdit` render the **home widget** on the home page (`renderHome`) instead of the infinite feed. **`HOME_LIMIT` 10 → 6** (owner). |
| `index.html` | The button is `#inspiqEditBtn` (`aria-controls`, `aria-expanded`, 32px min height) and calls `sokoniToggleInterests(this)`, which loads InspIQ on demand (`SokoniLazy.load()` + `whenLoaded('inspiq.js')`, disabled + `aria-busy` while loading, honest failure text if the module never arrives) and then `InspIQ.toggleEditor`. The recommendations loader **waits** for `sokoni-recommendations.js` via the same helper (`sokoniWhenLazyModule`, bounded poll fallback for an older cached loader) and asks for **6** items. The catalogue listener forwards `meta` to `_homeMergeFirestore`. |
| `script.js` | `_deferHomeGrid(sectionId, gridId, render)`: one deferral (IntersectionObserver 800px margin, idle fallback) for every home grid; **once built, every later call re-renders** it. `_listedForHome` (= `isPubliclyListed`, fail-open when the module is missing) and `_productTime` (number / ISO string / Date / Timestamp / `{_seconds}` / id fallback). New Arrivals, Fastest Selling, Big Discounts, Today's Picks all use it; the daily sections require **listed AND sellable** (`_sellableForHome`) instead of the bare `outOfStock` flag; Today's Picks shuffles a stably ordered pool so a snapshot cannot reorder it. `_renderHomeProductGrids()` is the single list of grids, called at boot and on every snapshot. `displayRecommendedProducts` keeps its six ids across snapshots and renders the "See all" link. `_homeMergeFirestore(fsProducts, meta)` obeys the delivery authority: only a `fresh` read may drop a row the catalogue no longer returns, and never the signed-in seller's own unsynced row. `displayProducts` carries a render token so a stale deferred batch can no longer append under a newer render. |
| `sokoni-db.js` | Sets `window.__sokoniCatalogueModule = true` at module evaluation (it is THE catalogue listener). |
| `realtime.js` | `_listenProducts` stands down when the canonical module is present — checked at attach time and again on every delivery (the module can arrive after an early auth event), detaching itself. Remains a fallback where the module never loaded. |
| `sokoni-recommendations.js` | Products query bounded to the newest 200 by document id (was the whole collection); product candidates filtered by `SokoniSellability.availabilityOf(d).sellable` (fail-open without the module). |
| `scripts/lib/page-harness.js` | Query snapshots now carry `metadata: { fromCache:false, hasPendingWrites:false }` like the SDK, so the canonical listener's callback can run under the harness. |
| `scripts/predeploy-browser-suites.js` | `test-home-picked-for-you.js` added to the required release suites. |

### The rule these changes converge on

> A home grid never decides sellability itself. Listing is `SokoniSellability.isPubliclyListed`; what a card says (badge, overlay, disabled buttons) is `SokoniSellability.availabilityOf`; what a delivery may remove is the listener's authority stamp. The grids re-render on every snapshot, so they cannot disagree with each other or with the inventory for longer than one delivery.

## 4 · Proof (candidate tree)

| Check | Result |
|---|---|
| `test-home-picked-for-you.js` — 16 source-contract checks + real `index.html` in Chromium: fresh visitor 390px (picker toggles; picks → home widget ≤6; recommendations widget renders after the lazy load, ≤6, no bail-out warning; no `[RT] products` listener; New Arrivals newest-first with the Timestamp-shaped date in its true place; archived product nowhere; depleted product shown **Out of Stock**; Fastest Selling excludes stock 0 / archived / flagged; Today's Picks sellable only; Big Discounts hidden without price history; no horizontal overflow), returning visitor 1280px (**Edit opens the editor pre-selected with the saved interests**, closes on second press, Update My Feed rewrites interests and re-renders ≤6), live sync (a fresh delivery removes a deleted product from every grid and re-marks a sold-out one; an unconfirmed delivery removes nothing; Today's Picks stable across identical snapshots; zero page errors) | **39 / 0** |
| `test-cart-browser-certification.js` (product card → cart) | 52 / 0 |
| `test-sellability-contract.js` | 74 / 0 |
| `test-home-logo-routing.js` | 31 / 0 (2 unproven, pre-existing) |
| `predeploy-syntax-gate.js` | PASS — 1,794 files, 453 inline blocks |
| `perf-guard.js` | PASS (one pre-existing WARN on `posStartupScripts`, no POS file touched) |
| `predeploy-browser-suites.js` (the hosting deploy hook) | **EXECUTED 33 / 33**, including the new suite — packet `docs/release-gates/hosting-preflight-home-picked-for-you.json` |

Not proven here: behaviour against production Firestore (App Check) — the harness shims the SDK. The live post-deploy smoke (`scratchpad/home-smoke2.js` pattern) must show: recommendations widget children > 0, no `[SokoniRecs] module not loaded`, no `[RT] products` warning, Edit Interests opening the editor for a visitor with saved interests, Fastest Selling visible.

## 4b · Live verification after deploy (cache-busted, signed-out Chromium)

| Check | Observed |
|---|---|
| `version.json` | commit `d55c112`, v646, dirtyWorkingTree false |
| Served files vs candidate | inspiq.js, sokoni-lazy.js, script.js, sokoni-recommendations.js, realtime.js, sokoni-db.js **byte-identical**; `/` carries the 4 new markers (`/index.html` is a 301 to `/`) |
| Edit Interests (visitor with saved interests) | a click renders the editor (picker innerHTML 8,425 chars; was 0 before) |
| Picked For You | SokoniRecs widget rendered on both personas; InspIQ feed **6** cards for the returning visitor |
| Fastest Selling | `display:block` (was permanently hidden) |
| Console | no `[RT] products` warning, no `module not loaded` warning |
| Caveat | headless Chromium is App-Check-throttled (403), so the recs widget showed its empty state there and the catalogue came through the `/api/catalogue` fallback; a real browser session is needed to see recs cards. Playwright's own click timed out on "element is not stable" (the section animates); a programmatic click worked. |

## 4c · Real-browser App Check verification (2026-09-30 10:5xZ, headed Chrome, automation fingerprint off) — a NEW finding

| Check | Observed |
|---|---|
| App Check | `__sokoniAppCheckState` = **`exchanged`** — a valid token; zero throttling lines. This is the real-browser session the headless smoke could not provide. |
| Recommendations request path | both reads **failed with `failed-precondition`: "The query requires an index"** — for `products` and for `mechanics`. The console link decodes to an index on `collectionGroups/products` ordered by **`__name__` DESCENDING**. The retry (also denied, same reason) is not a token problem. Widget shows the empty state. |
| Home catalogue listener | console order: `http-fallback-ok` (97) → `read-ok` (97) → `read-ok` again ~11 s later. The catalogue reached Home through the **`/api/catalogue` HTTP fallback**, not the Firestore listener. The canonical `SokoniDB.listenProducts` uses the same `orderBy(documentId(), 'desc'), limit(200)` shape, so it hits the same missing index — a `failed-precondition` is not in its transient-retry list, so it fails once and stays silent. |
| Consequence | Home renders the catalogue, but **live inventory updates do not reach it**: the fallback is one-shot and CDN-cacheable (≤120 s). The re-render-on-snapshot work in this slice is correct and idle until the listener can attach. This pre-dates this slice (the earlier census saw `[RT] products: query requires an index` in a headed run and I wrongly reclassified it later from a headless, App-Check-denied run as permission-denied). |
| Status | **Recommendation cards in a real browser: NOT demonstrated** — blocked by the index, not by App Check. |

**Fix options (not applied — owner decision):**
1. **Client query change, no index:** `orderBy(documentId())` ascending (implicit, needs no index) + `limitToLast(200)` returns the newest 200 (ids are Date.now()-style) in both `onSnapshot` and `getDocs`. One-line change in `sokoni-db.js` and `sokoni-recommendations.js`; hosting-only candidate; certifiable in the harness and in a headed Chrome run.
2. **Index deploy:** add `{collectionGroup: products, fields: [{fieldPath: __name__, order: DESCENDING}]}` (and `mechanics`) to `firestore.indexes.json` and deploy `--only firestore:indexes` — a separate gate with its own authorization; the indexes file is split/governed (`scripts/reconcile-indexes.js`, `verify-index-governance.js`) and a non-interactive indexes deploy can drop indexes absent from the file.

Option 1 is the smaller blast radius and removes a whole failure class; option 2 keeps the query as written. Either way the fix must be certified in a **headed** browser with a valid token, since that is the only environment that reaches the index check.

## 4d · Option 1 (ascending `__name__` + `limitToLast`) — BUILT, CERTIFIED AGAINST REAL FIRESTORE, **FALSIFIED**, REVERTED (2026-09-30 11:2xZ)

Owner authorized option 1. The two-file change was made (`sokoni-db.js`: `orderBy(documentId()), limitToLast(cap)` + `.reverse()`; `sokoni-recommendations.js`: `orderBy(documentId()), limitToLast(_CAP)`), parsed, and then served **in place of the live files** to a headed Chrome session on the live origin (Playwright route interception, read-only) that held a **valid App Check token** (`exchanged`, persistent profile, attempt 1).

| Run | App Check | Listener events | Recommendations |
|---|---|---|---|
| Live baseline (attempt 2 attested) | exchanged | `listener-attached → failed-precondition: The query requires an index → http-fallback-ok:97 → read-ok:97` | 0 cards, "requires an index" for products and mechanics |
| **Candidate files served (db:1, recs:1)** | exchanged | **identical**: `listener-attached → failed-precondition: The query requires an index → http-fallback-ok:97 → read-ok:97` | **identical**: 0 cards, "requires an index" |

**Why:** Firestore executes `limitToLast(n)` by reversing every `orderBy` direction server-side and applying `limit(n)`, so an ascending `__name__` + `limitToLast` query is served as `__name__` **DESCENDING** — the very index this project lacks. The form is index-equivalent to the one it replaced. Both source files were reverted; the tree is back at the certified commit. No deploy, no index, no rules change.

**A second premise fell in the same census.** Only **11 of 97** live product ids are `Date.now()`-style; 86 are hand-labelled (`VP97`, `TC101`, `QATEST100`, `F17`…). `orderBy(__name__)` was therefore never "newest first" for this catalogue — lexicographic order puts `VP97` first, which is what Trending shows today. Any `__name__`-based "newest 200" is wrong for this data even with an index.

**Index-free alternatives, with the facts each depends on (owner decision, not applied):**

| Form | Needs | Live coverage | Risk |
|---|---|---|---|
| `orderBy('uploadedAt', 'desc'), limit(200)` | the built-in single-field index (exists for every field) | **97 / 97** products carry `uploadedAt` (96 numbers, 1 Timestamp) | a product **without** the field is omitted by Firestore. Writers: `seller.js` and `seller-wiring.js` stamp `Date.now()`; `functions/profile-engine.js` writes `data.uploadedAt \|\| null` (null still sorts, first); POS-side creators (`pos-marketplace-sync.js`, `pos-retail.js`) stamp `createdAt`, not `uploadedAt` — a POS-created product may be invisible to this query. Mixed number/Timestamp values sort by type (Timestamps first under desc). |
| `limit(200)` with no `orderBy` | nothing | all 97 (under the cap) | implicit `__name__` ascending: past 200 products the **newest** are the ones dropped |
| `orderBy('updatedAt', 'desc')` | built-in | 92 / 97 | 5 live products omitted today |
| option 2: index `products` + `mechanics` on `__name__` DESC | an indexes deploy | n/a | governance surface; and it would perpetuate an ordering that is not "newest" for 86 / 97 ids |

The honest "newest first" key for this catalogue is `uploadedAt`, which is what New Arrivals already sorts by client-side; making the server query use it means every product writer must stamp it (a small writer census + one server-side default) — that is a slice of its own, not a two-line query swap.

## 4e · The authorized ordering repair — `uploadedAt` (candidate, NOT deployed)

Owner-authorized after [[PRODUCT_TIMESTAMP_WRITER_CENSUS]]: readers order by `uploadedAt` desc (limit 200, built-in single-field index, no composite); merchant-v2, sokoni-inventory and seller-wiring stamp or preserve it so no future product is created without the ordering key and no sign-in can rewrite it. Server authority for the value is explicitly **not** part of this slice. Certification: `scripts/test-product-uploadedat-authority.js` (34 / 0) plus the regression suites listed in the CHANGELOG entry. The Home listener finding (§4c) is untouched by this slice: once the listener attaches without the index error, the live-update path exists again, but whether Home should keep the HTTP fallback as primary is its own decision.

Known and recorded, not hidden: `QATEST100` carries a Timestamp-typed `uploadedAt` (all others are numbers) and therefore sorts first under `desc` by Firestore type order. It is a QA row; repairing its type is a production data write and is not authorized here.

## 5 · Performance and security

- **Performance:** no new synchronous script. The three previously hidden daily sections now render, but only when they approach the viewport or at idle (same deferral as New Arrivals), so the load window is unchanged. Recommendations now read ≤200 product docs instead of the whole collection. One failing Firestore listener per home visit is gone.
- **Security:** no rules, no Functions, no new write. Interests remain client-side preferences in `localStorage`. All rendering goes through the existing escaped card builder; the new inline handler contains no user data.

## 6 · Rollback

Hosting-only: re-release the current live version (`6f7202bd5dd81d84`, commit `2f3bb6f`). No data migration.

## 7 · Deploy, when authorized (not now)

From `C:/temp/sok-home` at the authorized commit, clean, after re-reading `version.json` (must still be `2f3bb6f`; a descendant → rebase; a non-ancestor → re-port): `firebase deploy --only hosting --project sokoni-aeb26 -m "home picked-for-you + inventory sync <commit>"`. One deploy at a time; never `--force`; the browser gate needs both `node_modules` junctions and no peer browser suite running. Verify cache-busted as in §4.

## 4f · Headed-Chrome verification of `82d8ce0` in a CLEAN window (2026-09-30 13:57–13:59Z) — PASSED

Executed by a runner that acquired the browser lock **by the preflight's exit code inside the same process** (READY twice, 20 s apart: free physical 766 MB, 0 orphans, no peer run), after an earlier attempt was discarded as provisional because the window closed between detection and use. Log: `docs/release-gates/headed-82d8ce0-clean.txt`.

| | Live baseline (files as served today) | **Candidate `82d8ce0`** (`sokoni-db.js` + `sokoni-recommendations.js` served in place on the live origin) |
|---|---|---|
| App Check | `exchanged` (valid token) | `exchanged` |
| Catalogue listener | `listener-attached → failed-precondition: The query requires an index → http-fallback-ok:97 → read-ok:97` (HTTP fallback is the catalogue) | **`listener-attached → snapshot:102 (fromCache:false) → read-ok:102`** — the Firestore listener delivers, no fallback needed |
| Recommendations | 0 cards, "requires an index" ×2 | **6 cards**, no errors |
| Trending order | `VP97, VP96, VP95, VP100` (lexicographic ids) | `QATEST100` (Timestamp-typed, known), then `1784796275236, 1784762904410, 1784762785525` (newest first) |
| Live hosting pointer before / after | `b108ae3` / `b108ae3` | unchanged — nothing deployed |
| Home browser suite (`test-home-picked-for-you.js`) in the same window | — | 39 / 0 |

Note: the listener returns **102** documents where `/api/catalogue` returns 97 — the API applies the server-side listing filter, the client applies `isPubliclyListed` after delivery, so Home renders the same listed set either way. Recorded, not a defect of this slice.

Still separate: server authority for `uploadedAt`; the inventory gate's pre-existing failures ([[TEST_ENVIRONMENT_PREFLIGHT]] §7). **Deployment is not authorized.**
