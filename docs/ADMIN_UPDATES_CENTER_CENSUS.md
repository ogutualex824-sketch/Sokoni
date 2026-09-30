# Admin Updates Centre — census (2026-10-01)

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
| Can a browser read the changelog? | **No** — `hosting.ignore` carries `**/*.md`; `docs/**` and `scripts/**` are ignored too. A generated artefact is needed → `release-log.json`. |
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

## What was built (hosting only)

* `sokoni-admin-updates.js` + `sokoni-admin-updates.css` — ONE module, mounted by
  * AdminOS: `#aosNav` Overview → **Updates** (`data-section="updates"`), `#panel-updates`, loader `_loadUpdates()` in
    `sokoni-aos.js`; deep link **`admin-os.html#updates`** (validated by the existing `_parseRoute`).
  * Super Admin: `#saNav` Overview → **Updates**, `#panel-updates`, `SA.nav('updates')` → `SA.loadUpdates()`;
    **`super-admin.html#updates`** now opens it (init honours a `#section` hash only when a native sidebar button for
    it exists — otherwise Platform Overview, as before). It is a NATIVE Super Admin section, so
    `test-adminos-nav-coverage` S1 counts it as covered.
* Sections: **Live now** (version.json + this browser's SW) · **Installs & updates** (neutral state + reasons) ·
  **Release log** (search, type filter, status filter, 40 per page, newest first, files and commits on disclosure).
* `scripts/build-release-log.js` → `release-log.json` at the site root (served; not hosting-ignored).
  * `type` from the title's **leading word only** (`fix`/`hotfix`/`fixed` → fix, `feat` → feat, `docs`, `test`,
    `DEPLOYED` → deploy record; everything else `other`).
  * `claim` from the **heading only** (`NOT deployed` → not-deployed, `deployed` → deployed, else null).
  * `commits`: 7–10 or 40 hex in the heading (16-hex hosting version ids and bare numbers excluded).
  * No `generatedAt`: output is a pure function of `CHANGELOG.md` (`sourceSha256` recorded).
* **Status honesty in the UI:** every entry is **Committed** (it is in the deployed tree's changelog). **Live now** is
  shown ONLY when the entry records a deployment (`claim: deployed`) of the exact commit `/version.json` reports.
  "Changelog says deployed" is shown as the changelog's claim, never as proof. The log reflects the CHANGELOG of the
  tree that was deployed; it cannot prove from the browser which earlier entries are live (ancestry is not visible to
  a browser), so it does not claim it.

### Security implication — OWNER DECISION BEFORE DEPLOY

`release-log.json` is a static hosting file: **anyone** can fetch `/release-log.json`. The AdminOS / Super Admin claim
gates protect the consoles, not the file. It republishes CHANGELOG titles and summaries that `**/*.md` keeps off the
site today — including security-defect write-ups (33 of 775 entries match bypass / forge / privilege / token-type
terms, some describing defects recorded as OPEN). Options:

1. Accept public release notes (then consider trimming entries that describe open defects).
2. Serve the log admin-only: an `adminGetReleaseLog` callable (claims-checked) or a Storage object behind an
   admin-only rule. The module fetches through a single `fetchJson()`, so only the URL/transport changes.
3. Publish a trimmed, title-only log.

Not decided in this slice. Until decided, **do not deploy this branch's `release-log.json`**.

### Keeping the log fresh — OWNER / RELEASE-OWNER ACTION

`firebase.json` is out of bounds for this slice. Add to `hosting.predeploy` (after `generate-version.js`):

```
node scripts/build-release-log.js
```

Until then `scripts/test-release-log.js` fails whenever `CHANGELOG.md` changes without a regeneration.

---

## NEXT SLICE — measure installs and updates (server; NOT built)

Goal: two honest numbers — **installed devices** and **devices on the live build** — plus "behind".

1. **Callable `appInstallReport`** (App Check enforced, rate-limited per uid/IP like `logClientDiagnostic`):
   * input `{ installId, event: 'installed'|'launch', displayMode, cacheVersion }` — `installId` a random id minted
     on first standalone launch; the server validates shape, caps lengths, and allowlists `displayMode`.
   * writes **server-side only** `appInstalls/{installId}`: `firstSeenAt`, `lastSeenAt`, `installedAt` (only from an
     `appinstalled` event or first `standalone` launch), `displayMode`, `lastCacheVersion`, `platform` (from UA),
     `uid` (if signed in), `expiresAt` (e.g. 180 days after `lastSeenAt`, TTL).
   * client: `sw-register.js` calls it on `appinstalled`, and at most once per day per install on a standalone launch
     (the "version heartbeat"). Never a direct Firestore write — client-written counts are not canonical, and rules
     would have to open a write path.
2. **Aggregate**: scheduled function (hourly) writes `platformMetrics/appInstalls`:
   `{ installed: count(), activeLast30d, onLive: count(lastCacheVersion == live), behind, measuredAt, liveCacheVersion }`
   using `count()` aggregation queries (one read per 1,000 index entries), with `liveCacheVersion` taken from the
   deployed `version.json`. Needs a composite index on `appInstalls (lastCacheVersion, lastSeenAt)`.
3. **Rules**: `match /platformMetrics/{id} { allow read: if isAdmin(); allow write: if false; }` and
   `appInstalls` default-deny (no client rule). → `firestore.rules` change, owner-gated.
4. **UI**: give each `INSTALL_METRICS` entry a `source` pointing at `platformMetrics/appInstalls`; render
   `measuredAt` next to each figure; keep "— · Not measured yet" when the doc is absent or unreadable.
5. **Caveats to render, not hide:** installs before the slice ships are invisible (the count starts at deploy); iOS
   fires no `appinstalled` (first standalone launch is the only signal); a cleared browser mints a new `installId`.
   Play Store downloads need the Play Developer Reporting API server-side — separate slice.

---

## Certification

| Suite | Kind | Result |
|---|---|---|
| `scripts/test-release-log.js` | node — parser contract, staleness, negative control | see CHANGELOG 2026-10-01 |
| `scripts/test-admin-updates-static.js` | node — wiring, one data path, DOM-shim render, negative control, CSS tokens | see CHANGELOG 2026-10-01 |
| `scripts/test-admin-updates-center.js` | **browser (QUEUED — browser hold)** — both consoles, live facts, order, neutral metrics, 390/768/1280 overflow, keyboard, deep links, fabricated-"0" negative control | not run |
