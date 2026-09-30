# Admin Updates Centre — census (2026-10-01; decisions A–C and the server slice added the same day)

Related: [[AdminOS]] · [[Super Admin]] · [[Release]] · [[RELEASE_ROADMAP]] · [[RELEASE_STATE]] · [[Service Worker]] · [[PWA]] · [[Observability]] · [[Authentication]]

**Owner ask (lightly translated):** "In AdminOS and Super Admin there should be an Updates page that shows app
fixes and bugs written in order, that can be used to see updates, fixes, deployed things and committed things, and
should show how many people have downloaded SOKONI and how many have updated it."

**Tree:** `hosting/admin-updates-center-on-54b72cc` @ `54b72cc` (hosting chain tip, descends from live).
**Method:** read-only source census of this tree. The served Firestore ruleset was NOT fetched; every rules statement
below is **repo-only evidence** (`firestore.rules`, plus `firestore.rules.live` / `.served-current` where noted).

---

## Verdict

| Question | Answer |
|---|---|
| Can a browser read what is live? | **Yes** — `/version.json` (hosting only) + the page's own service worker (`GET_VERSION`). |
| Can a browser read the changelog? | **No** — `hosting.ignore` carries `**/*.md`; `docs/**` and `scripts/**` are ignored too. A generated artefact is needed → `functions/data/release-log.json`, served admin-only by `adminReleaseLog` (decision A). |
| Is there a Firestore record of deploys / releases? | **No.** No `releases`, `deploys`, `deployments`, `releaseLog`, `appVersions` collection is written or read anywhere (client or `functions/`). `platformEvents` carries no deploy events. |
| Is there ANY canonical source of installs / downloads? | **No.** |
| Is there ANY canonical source of "how many updated to the live build"? | **No.** |

So the Updates centre shows **Live now** and the **Release log** from real sources, and renders every install/update
metric as **"— · Not measured yet"** with its reason. Unknown is not zero (CLAUDE.md, UI Data Integrity).

---

## a) Release / deploy / commit data a browser can read today

| Source | Served? | What it holds | Notes |
|---|---|---|---|
| `/version.json` | Yes. Own header block: `no-cache, no-store, must-revalidate`, CDN no-store | `commit`, `commitShort`, `branch`, `buildTime`, `cacheVersion`, `environment`, `dirtyWorkingTree`, `dirtyPaths` | Written by `scripts/generate-version.js` in hosting predeploy step 4 from git + `service-worker.js`. **Hosting only** — it says nothing about functions or rules deploys. The committed copy in a tree is the *last* generation, not necessarily this tree's commit. |
| `service-worker.js` `CACHE_VERSION` | Yes (`no-cache`) | `sokoni-<stamp>-vNNN` | The SW answers `{type:'GET_VERSION'}` on a MessageChannel with its `CACHE_VERSION` (`service-worker.js` message handler). That is the exact build a given browser is running. |
| `window.sokoniBuildInfo()` (`sw-register.js`) | Yes | running vs deployed `vNNN`, `stale` flag | Exists; infers the running build from `caches.keys()`. The Updates centre asks the controller directly instead (exact string, not a cache-name guess). |
| `diagnostics.html`, `?diag=version` badge (`sokoni-version-badge.js`) | Yes | per-device running vs deployed | User-facing diagnostics; not in either admin sidebar. |
| `CHANGELOG.md` | **No** (`**/*.md` ignored) | 774 `## ` entries | Needs a build-time artefact. |
| `docs/release-gates/*.json`, `docs/RELEASE_STATE.md`, `docs/RELEASE_ROADMAP.md` | **No** (`docs/**` ignored) | gate verdicts, release state | Not readable from a browser. |
| Firestore `releases` / `deploys` / `deployments` / `releaseLog` / `appVersions` | — | — | **Do not exist.** grep of client + `functions/`: zero writers, zero readers. |
| Firestore `platformEvents` | admin-readable (repo rule: `allow read: if isAdmin()`) | domain events | No deploy/release event type is published. |

## b) Install / update data

| Signal | Where | Who writes | Stored where | Admin-readable? (repo rules) | Aggregate? | Usable as an install/update count? |
|---|---|---|---|---|---|---|
| `appinstalled` event | `sw-register.js` (≈L792), `index.html` (≈L2850) | client | **nowhere** — hides the install banner, shows a toast, asks for notification permission | n/a | n/a | **No** — nothing recorded |
| `beforeinstallprompt` | `sw-register.js` (≈L680) | client | `localStorage` (`sokoniInstallDismissed`, `sokoniInstallVer`) | n/a | n/a | **No** — per-browser convenience state, never a source |
| `display-mode: standalone` / `navigator.standalone` | `sw-register.js`, `sokoni-sw-telemetry.js` | client | only inside telemetry beacons (below) | — | — | **No** |
| Device registration `deviceRegister` (callable, `functions/device-engine.js`; fired once per browser session from `firebase.js` `_registerSession()` on sign-in, and from `account-centre.html`) | server (callable) | server | `userDevices/{uid}_{deviceId}`: `uid, deviceId, userAgent, ipHash, platform, browser, deviceName, deviceType, city, country, firstSeenAt, lastActiveAt, isActive, isTrusted, loginCount` | **No rule** in `firestore.rules` / `.live` / `.served-current` → default deny to clients. Readable only via the user's own `deviceList` callable. | **None** (no count callable) | **No** — it records *signed-in browsers*, not installs; **no app version, no `cacheVersion`, no standalone flag**; `deviceId` is a localStorage id, so a cleared browser re-registers as a new device. |
| SmartPOS `registerDevice` / `deviceHeartbeat` (`functions/device-manager.js`) | server | server | `posDevices/{deviceId}` incl. `appVersion` | rule exists (`posDevices`) | `adminGetPosDevices` (AdminOS SmartPOS panel) | **No** — merchant POS terminals only, not SOKONI app installs. Already surfaced in AdminOS → SmartPOS; not duplicated. |
| SW lifecycle telemetry (`sokoni-sw-telemetry.js`, loaded by `sw-register.js`) → `POST /api/diag` → `routeDiag` (`functions/route-diag.js`) | client beacon, **unauthenticated** | server (sanitised) | `routeDiagnostics` (auto-id, 30-day TTL): `event` (`sw_install_*`, `sw_update_applied`, `sw_version_mismatch`…), `cacheVersion`, `buildCommit`, `displayMode`… | **No rule** → default deny to clients | none | **No** — anomaly/lifecycle beacons from a public endpoint: not one row per device, forgeable, rate-limited per IP, TTL'd. `sokoni-version-badge.js` records the diag collections measured EMPTY on 2026-08-23. |
| Push: `users/{uid}.fcmToken` / `fcmPlatform` / `fcmUpdatedAt` (`firebase.js` ≈L1170); `pushTokens/{uid}` (`sokoni-inbox.js`) | client | client | user doc field; `pushTokens` has **no rule** (client write denied) | — | none | **No** — push opt-in per account, client-written, not an install or a build |
| Android TWA (`docs/ANDROID_RELEASE.md`, package `ke.co.mysokoni.app`) | Play Console | Google | Play Console | not exported to SOKONI | — | **No** — publication status not recorded in the repo; Play statistics are not readable by a browser |
| Google Analytics / GTM (CSP allows it) | third party | — | — | — | — | **No** — not canonical, not an admin-readable aggregate |

**Conclusion (b): no canonical install or update source exists.** Every candidate is either not recorded, client-
written, unreadable by an admin, or measures something else (sessions, POS terminals, push opt-in, anomalies).

## c) Existing admin surfaces — extend, don't duplicate

| Surface | What it shows | Overlap |
|---|---|---|
| AdminOS sections (`sokoni-aos.js`: dashboard … workflows) | ops data | none show build/release |
| AdminOS Tools → `platform-health.html`, `reliability-center.html`, `launch-readiness.html` | service health, readiness | no version.json / changelog |
| Super Admin → Platform Overview | `getPlatformHealthScores` KPIs, service pills | no build/release |
| Super Admin → Emergency → cache controls | kill switches | no version display |
| `diagnostics.html` | *this device* vs server build | user-facing, not admin, not a release log |

Nothing existing shows releases or the live build to an admin, so the Updates centre is **new**, built once, mounted
into both consoles through their existing routers. It reuses the SW's own `GET_VERSION` answer and the existing
`window.sokoniCheckForUpdates()` (sw-register.js) for "Update this browser" rather than a second update path.

---

## Owner decisions (2026-10-01) — binding

| | Decision | How it is implemented |
|---|---|---|
| **A** | The release log is **admin-only**, served by a server call — nothing public. (33 of 775 entries describe security defects.) | `release-log.json` removed from the hosting root (`git rm`). `scripts/build-release-log.js` now writes **`functions/data/release-log.json`**, bundled with the functions source (`functions/**` is hosting-ignored — it cannot be served by hosting even by accident). Served only by the admin callable **`adminReleaseLog`**. The module has no `/release-log.json` reference left. |
| **B** | Build the install/update counting server slice. Counts come only from its canonical aggregate; unknown renders "—/Not measured yet", never 0; installs before it ships are never back-filled or estimated. | `appInstallReport` → `appInstalls/{installId}`; `scheduledAppInstallStats` (every 6 h) → `appInstallMetrics/summary` via `count()`; read by `adminGetAppInstallStats`. `since` = the earliest `firstSeenAt` ever received — the counter's start; nothing before it exists or is estimated. |
| **C** | **No rules change.** Writes through the Admin SDK in functions; reads through admin-checked callables; the database's default-deny covers client access. | See "No rules change — why it holds" below. No index change either. |

### No rules change — why it holds

* **`appInstalls`** and **`appInstallMetrics`** have **no `match` block** in `firestore.rules` and there is no top-level
  `/{document=**}` catch-all (the only `{document=**}` is scoped under `/tenants/{tenantId}`). Firestore rules are
  default-deny, so **every client read and write of both collections is refused** — for anonymous callers, users,
  admins and super admins alike. Only the Admin SDK (functions) touches them, and it bypasses rules by design.
* **Why not `platformMetrics/appInstalls`** (the name first proposed): repo `firestore.rules` gives `platformMetrics`
  `allow read: if isModerator(); allow write: if isAdmin();` — an admin **browser** could overwrite the canonical figure,
  and moderators could read it outside the admin callable. A server-only figure needs a rule-less path, so the aggregate
  lives at `appInstallMetrics/summary`. (Repo-only evidence: the served ruleset was not fetched in this slice.)
* Reads by people go only through `adminReleaseLog` / `adminGetAppInstallStats`, which check the admin claim server-side.
* **No composite index.** Every aggregate query is one single-field filter — `installed == true`, `standalone == true`,
  `lastSeenAt >= t`, `cacheVersion == live` — plus one single-field `orderBy('firstSeenAt').limit(1)` for `since`. All are
  served by Firestore's automatic single-field indexes. `firestore.indexes.json` is untouched. (The emulator does not
  enforce composite indexes, so this is asserted by the node suite: every query it records is single-field.)

---

## What was built

### Functions (`feat/admin-updates-fn-on-a545818`, on `a545818`) — `functions/app-release-metrics.js`, all four NEW

| Function | Kind | Guard | What it does |
|---|---|---|---|
| `adminReleaseLog` | onCall | `assertAdmin` (`functions/shared/errors.js` — auth + `admin`/`superAdmin` claim → `unauthenticated` / `permission-denied`), `enforceAppCheck: true` (same options as `admin-os.js` callables) | Pages the bundled log: `limit` ≤ 100 (default 40), opaque cursor `o:<n>`, `type` / `status` (`live` · `deployed` · `not-deployed` · `committed`) / `q` filters, optional `liveCommit` (from `/version.json`) so "Live now" is decided by the same rule as the UI. Missing bundle → `unavailable`, never an empty list. Lazy `require('./data/release-log.json')` — not loaded at cold start of the other functions sharing `index.js`. |
| `appInstallReport` | onCall, **no sign-in** | `enforceAppCheck: true` (the `logClientDiagnostic` shape); rate limit via **existing** `redis-rate-limiter.js` `queryRateLimit`, key `appInstall:<installId>:<sha256(ip) 16 hex>`, 12/h | Validates `{installId (UUID v4), event: install\|checkin, cacheVersion /^sokoni-\d{14}-v\d+$/, standalone bool, platform enum}`. In a transaction: first sight → **`create()`** (`firstSeenAt`, `lastSeenAt`, `lastSeenDay`, `firstCacheVersion`, `cacheVersion`, `standalone`, `platform`, `installed`, `installedAt` only for `install`); later → one `update` per Nairobi day (`lastSeenAt`, `lastSeenDay`, `cacheVersion`, `standalone`); `installed`/`installedAt` set at most once. **No uid, no IP, no UA string stored.** Write failure → `{ok:false}`, no detail. |
| `scheduledAppInstallStats` | onSchedule `every 6 hours` (Africa/Nairobi) | server | Reads the live `cacheVersion` from **`https://mysokoni.co.ke/version.json` over HTTPS (5 s timeout, regex-validated)**; `count()`s; writes `appInstallMetrics/summary` `{computedAt, devices, total, standalone, active7, active30, onLive, behind, liveCacheVersion, liveError, since}` with `set()` (whole replace). Live build unreadable → `onLive`/`behind` **null** + `liveError`, never 0. |
| `adminGetAppInstallStats` | onCall | `assertAdmin`, `enforceAppCheck: true` | Returns the summary (timestamps as ISO; any missing/malformed figure → null) or **`{ state: 'not-computed-yet' }`**. |

Definitions the UI shows verbatim: **total** = devices that reported `appinstalled`; **standalone** = last report from the
installed app (covers iOS, which fires no `appinstalled`); **active7/30** = `lastSeenAt` within 7/30 days; **onLive** =
last report on the live build; **behind** = `devices − onLive` (last report on any other build — exact by definition and
includes devices not seen recently); **devices** = every device that ever reported (browser tab or installed app).

**Known limits (render, don't hide):** clearing site data mints a new `installId` (counted as a new device); only devices
whose owner granted consent report; a device reports only while a service worker controls the page; iOS gives no install
event; Play Store downloads remain unmeasured (Play Developer Reporting API = separate slice). The rate limiter fails
**open** when Redis is unavailable (the `default` action is not in its durable-fallback set, and `redis-rate-limiter.js`
records Redis as currently unreachable) — the per-install day key is then the only write bound, and **App Check is the
only barrier against minting many installIds**. No per-IP-only cap was added: Kenyan mobile carriers put many devices
behind one CGNAT address. `appInstalls` has no TTL policy — retention is an owner/privacy item.

### Hosting (`hosting/admin-updates-center-on-54b72cc`, on `54b72cc`)

* `sokoni-admin-updates.js` + `sokoni-admin-updates.css` — ONE module, mounted by
  * AdminOS: `#aosNav` Overview → **Updates** (`data-section="updates"`), `#panel-updates`, loader `_loadUpdates()` in
    `sokoni-aos.js`; deep link **`admin-os.html#updates`** (validated by the existing `_parseRoute`). Mount passes the
    console's canonical `_call` (the two names are not in `_ADMIN_OS_OPS`, so they are called directly by name).
  * Super Admin: `#saNav` Overview → **Updates**, `#panel-updates`, `SA.nav('updates')` → `SA.loadUpdates()`;
    **`super-admin.html#updates`** opens it. Mount passes `SA._fns.httpsCallable(name)`.
* **Live now** (version.json + this browser's SW) — unchanged.
* **Installs & updates** — reads `adminGetAppInstallStats`. `not-computed-yet`, an undeployed callable
  (`not-found` / `unavailable` / `internal`), a refusal, or a null figure → **"—" + "Not measured yet" + the reason**.
  A number is rendered ONLY when the aggregate carries one (a canonical `0` is a 0), with "Since <date>" and
  "Computed <stamp>". Play Store downloads stay unmeasured.
* **Release log** — paged from `adminReleaseLog` (40 per page, "Show N more" follows the server cursor; search is
  debounced and filtered server-side; the live commit is sent so "Proven live now" works across pages). While the
  callable is not deployed: **"Release log is served to admins by the server — not available yet"** — never an empty
  list as if there were no releases. A refusal is reported as a refusal.
* **Client reporter `sokoni-install-report.js`** — injected by `sw-register.js` through its existing `_mods` list
  (one line; no SW registration or caching logic touched). Generates/stores `installId` in localStorage (convenience,
  not a source), sends `install` on `appinstalled` and `checkin` at most once per Nairobi day (one attempt, success or
  not) with the SW's `CACHE_VERSION` (via `GET_VERSION`) and the standalone flag. Transport: `window.firebaseApp` +
  `getFunctions(…, 'us-central1')` (the path `sokoni-async.js` / `sokoni-crash-sentinel.js` use for
  `logClientDiagnostic`; App Check from `firebase.js`), else the compat default app (App Check from
  `sokoni-appcheck.js`), else nothing. Silent no-op when offline, uncontrolled by a SW, framed, or the callable is
  absent. Never blocks load, never throws.
* `scripts/build-release-log.js` → `functions/data/release-log.json` (same parser; see decision A). Committed in BOTH
  trees; the copy that ships is the one in the tree functions are deployed from, built from THAT tree's CHANGELOG.

### Consent gate — status

* **Authority:** `window.SokoniConsent` (`security.js`), per the privacy programme (sokoni-4d). The reporter subscribes
  with **`SokoniConsent.onChange`** (current state immediately, then every change) — not `onGrant` — so a withdrawal
  stops it. It never reads the consent storage keys itself.
* **Fail closed:** a page without `SokoniConsent` never reports. `_enabled` is re-checked immediately before the send
  (after the SW answers), so a deny between scheduling and sending wins.
* **Honest limits:** the decision is stored **client-side only** (no server-side consent record yet), and the banner is
  a **single accept/reject** with no per-category (analytics vs marketing) choice yet. When the privacy programme makes
  it durable and category-based, `SokoniConsent` remains the entry point (with a category argument) — this file changes
  only its one `onChange` call.
* **Coverage consequence:** only pages that load `security.js` can report. Pages without it are silent by design.

### Status honesty in the log

Every entry is **Committed** (it is in the deployed tree's changelog). **Live now** only when the entry records a
deployment (`claim: deployed`) of the exact commit `/version.json` reports. "Changelog says deployed" is the changelog's
claim, never proof. The log reflects the CHANGELOG of the tree **functions** were deployed from; it cannot prove which
earlier entries are live, so it does not claim it.

### Keeping the log fresh — RELEASE-OWNER ACTION (firebase.json is out of bounds here)

Add to `functions.predeploy`: `node "$RESOURCE_DIR/../scripts/build-release-log.js" --check` (refuse a stale log) —
or the builder without `--check` to regenerate. Until then `scripts/test-release-log.js` fails whenever `CHANGELOG.md`
changes without a regeneration. The two trees' `functions/data/release-log.json` differ (different CHANGELOG lineages)
and will conflict on merge — regenerate, never hand-merge.

### Deploy order (owner-gated; nothing deployed)

1. Functions, **by name**: `adminReleaseLog`, `appInstallReport`, `scheduledAppInstallStats`,
   `adminGetAppInstallStats` (all NEW). Cloud Scheduler job is created by the deploy.
2. Hosting (this branch). Before step 1 the page shows the "not available yet" / "Not measured yet" states, which is
   correct and safe; the reporter's calls fail silently (one attempt per device per day).
3. Re-read the Artifact Registry notice in `CLAUDE.md` before any functions deploy.

---

## Certification

| Suite | Tree | Kind | Result |
|---|---|---|---|
| `scripts/test-app-release-metrics.js` | functions | node — validation, admin refusal, day key, create()-not-set(), rate-limit key, aggregate math (fake count), single-field queries, not-computed-yet, paging, exports by name | **86 / 0** (mutations create→set and not-computed-yet→0 are caught) |
| `scripts/test-app-release-metrics-emulator.mjs` | functions | emulator — concurrent first sight, real transactions, real `count()`, client default-deny for both collections, stats callable | **written, NOT run** |
| `scripts/test-release-log.js` | both | node — parser, staleness, admin-only placement, negative control | **41 / 0** in each tree |
| `scripts/test-admin-updates-static.js` | hosting | node — wiring, callable-only data path, no public log, DOM-shim render with stubbed callables (not-computed-yet / absent / refused / computed / paging), negative controls | **63 / 0** (mutation unknown→"0" caught: 6 failures) |
| `scripts/test-install-report.js` | hosting | node — consent gate (absent / false / grant→deny / once a day / re-grant), payload, silent no-ops, sw-register untouched otherwise | **22 / 0** (fail-open mutation caught) |
| `scripts/test-admin-updates-center.js` | hosting | **browser (QUEUED — browser hold)** — both consoles, stubbed callables (deployed + absent), measured vs neutral metrics, no `/release-log.json` request, overflow, keyboard, deep links, fabricated-"0" negative control | not run |
