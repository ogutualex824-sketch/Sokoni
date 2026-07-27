# App Check Denial Investigation Plan

Repo-specific plan to explain SOKONI's intermittent App Check denials — the
403s that forced the provider-directory resilience work and that surface as
"Security verification failed" on real pages. **Static prep**: it maps the
implementation and specifies exactly which metrics answer which question, so
data collection is targeted rather than dashboard-spelunking. No runtime
verdicts are recorded here.

Related: [[APP_CHECK]] · [[AUTH_VALIDATION_PLAN]] · [[feedback-intermittent-state]] · [[project-appcheck]]

---

## The finding that changes the whole approach

**App Check's server-side metrics cannot answer the questions as posed.**

The requested breakdown — by **browser, platform, app/PWA version, origin,
auth state** — does **not exist** in App Check's native metrics. App Check only
knows two dimensions:

- **which service** was called (`firestore`, `storage`, …), and
- **the verdict**: Verified / Unverified (no token) / Invalid (bad token) /
  Outdated-client.

It has no visibility into the *client* that failed. So:

| Question | Answerable from App Check metrics? |
|---|---|
| How many requests were denied, per service, over time | **Yes** (server-side) |
| What fraction of requests were denied | **Yes** (server-side) |
| Which browsers / platforms / versions / origins fail | **No** — needs client-side instrumentation |
| Request-denial-rate vs **user-impact-rate** | **No** — user identity/count isn't in App Check metrics |
| Denials **per affected user over time** | **No** — same reason |

**Conclusion:** the high-value half of this investigation requires adding a
**client-side denial beacon** first. Pulling Monitoring dashboards now gives the
volume shape but not the "who/what," which is where the actionable answer lives
(unsupported client vs misconfig vs bot). The plan below builds both halves.

---

## Where App Check is initialised (two parallel paths — audit both)

| Path | File | Detail |
|---|---|---|
| Modular SDK | [firebase.js](../firebase.js) L111 | `initializeAppCheck(app, { provider: ReCaptchaV3Provider('6Lf93Tkt…'), isTokenAutoRefreshEnabled: true })` |
| Compat SDK | [sokoni-appcheck.js](../sokoni-appcheck.js) L50 | `firebase.appCheck().activate(new firebase.appCheck.ReCaptchaV3Provider(SITE_KEY), true)` |

**Same reCAPTCHA v3 site key** in both: `6Lf93TktAAAAAIqCj8l3YM3dIoS1MIXpilsdnsxj`.

Audit item: a page that loads **both** the module and the compat script inits
App Check twice. Confirm no double-activation conflict (the `[DEFAULT] app
already exists with different options` error seen on `legal-hub.html` is the
adjacent Firebase-app double-init; check whether App Check has the analogous
issue on mixed-SDK pages).

---

## What App Check protects (enforcement observed live, 2026-07)

| Service | Enforcement | Effect when the token is missing/invalid |
|---|---|---|
| `firestore.googleapis.com` | **ENFORCED** | Every read/write 403s → the dominant user-visible failure |
| `firebasestorage.googleapis.com` | **ENFORCED** | Uploads/downloads 403 |
| `identitytoolkit.googleapis.com` | UNENFORCED | Sign-in unaffected (see [[AUTH_VALIDATION_PLAN]]) |
| dataconnect / ml / maps-backend | UNENFORCED | n/a |

So denials manifest as **Firestore/Storage 403s**, not auth failures — which is
why intermittent App Check looks like "data won't load" or "page is broken,"
not "can't sign in."

---

## Where denials are caught / surfaced (client)

| Site | File:line | Behaviour |
|---|---|---|
| Token exchange probe | [firebase.js](../firebase.js) L150–156 | `getAppCheckToken` → sets `window.__sokoniAppCheckState = 'exchanged' \| 'rejected'`; on reject logs **"Security verification failed. Please refresh and try again."** |
| State signal | [firebase.js](../firebase.js) L127/138 | `__sokoniAppCheckState` = `pending \| disabled \| exchanged \| rejected`; `__sokoniAppCheckReady` promise |
| Compat probe | [sokoni-appcheck.js](../sokoni-appcheck.js) L66–82 | one-shot; localhost prints detail, production prints the generic message |
| Firestore read failure | [firebase.js](../firebase.js) L773 | `onAuthStateChanged: Firestore unreachable` — the auth path's denial branch |
| Provider directory | [sokoni-providers.js](../sokoni-providers.js) | `degrade()` + `fromCache` + 8s read timeout — the resilience layer already built for exactly this |

`window.__sokoniAppCheckState` is the **single existing client signal** and is
the natural hook for the beacon below.

---

## Denial-category hypotheses (from the implementation)

Rank for investigation; each maps to a distinct fix:

1. **reCAPTCHA v3 fails for the client** — headless/bots (expected), or a real
   browser reCAPTCHA hiccup (intermittent). Explains the "same session succeeds
   then 403s" signature in [[feedback-intermittent-state]].
2. **First-load race** — a Firestore read fires before the token is exchanged
   (`__sokoniAppCheckState` still `pending`). Bounded now by the resilience
   layer, but still a denial in the metrics.
3. **Token-refresh lag** — `isTokenAutoRefreshEnabled` refreshes, but a read in
   the refresh gap 403s. Intermittent by nature.
4. **Throttle after 403** — once App Check 403s, the SDK backs off (observed:
   `appCheck/throttled … 24h`). One early failure suppresses the client for a
   long window → inflates *request* denials for *few* users.
5. **Site-key origin registration** — if `mysokoni.co.ke` (and `*.web.app`, PWA
   scope) aren't all registered for the reCAPTCHA key, those origins fail
   wholesale. Check the reCAPTCHA admin console domain list.
6. **Unsupported/outdated client** — old WebView/browser without the SDK
   requirements → App Check verdict "Outdated client."

Hypotheses 4 vs 6 are exactly the request-rate-vs-user-impact divergence you
flagged: (4) is few users × many denials; (6) is many users × few denials.

---

## Part A — Server-side volume (available once cloud access is restored)

Pull from **Firebase Console → App Check → APIs** (per-service time series) and
/or **Cloud Monitoring** (`firebaseappcheck.googleapis.com` metrics; confirm the
exact metric type in Metrics Explorer — verified vs unverified request counts
per service). Dimensions available: **service × verdict × time**.

Compute:
- **Request denial rate** = unverified+invalid / total, per service, per day.
- Denial **trend** — step change (config/deploy) vs steady (compatibility).
- Correlate spikes with hosting deploy timestamps (`docs/release-gates/*.json`).

This answers *how much* and *when*, not *who*.

---

## Part B — Client denial beacon (build this to get the real answer)

App Check can't tell you the client, so instrument it. At the `rejected` branch
([firebase.js](../firebase.js) L153) emit one beacon per denial:

```js
// on __sokoniAppCheckState = 'rejected'
navigator.sendBeacon('/appcheck-denial', JSON.stringify({
  ts: Date.now(),
  ua: navigator.userAgent,          // → browser + platform (parse server-side)
  platform: navigator.platform,
  appVersion: window.SOKONI_VERSION, // PWA/app version (from version.json)
  origin: location.origin,           // mysokoni.co.ke vs *.web.app vs PWA scope
  standalone: window.matchMedia('(display-mode: standalone)').matches, // PWA?
  authed: !!(window.firebaseAuth && window.firebaseAuth.currentUser),   // auth state
  reason: 'appcheck/fetch-status-error',
}));
```

Sink options (pick per privacy posture): a lightweight CF → BigQuery, or
Google Analytics event (already loaded — `G-QT32H65TJS`), or a rate-capped
Firestore collection. **Must be rate-capped** (hypothesis 4: throttled clients
retry) so the beacon itself doesn't amplify the signal it measures.

Then compute — the three cuts, each telling a different story:
- **Request denial rate** — beacons / total requests (join with Part A).
- **User-impact rate** — `distinct(userOrDeviceId with ≥1 denial) / distinct(all)`.
- **Denials per affected user over time** — the [[feedback-intermittent-state]]
  discriminator: a single bad moment vs a sustained broken experience.

Break every cut by `browser · platform · appVersion · origin · standalone ·
authed`. That is the matrix that separates unsupported-client from misconfig
from bot.

---

## Execution order (once access is restored)

1. **Part A first** — 30 minutes of Monitoring gives the volume shape and
   whether it's a step (config) or steady (compat) problem. Cheap, immediate.
2. If the shape is ambiguous (it usually is for intermittent), **ship the
   Part B beacon**, let it collect 24–48h, then compute the three cuts.
3. Cross-check hypothesis 5 (origin registration) directly in the reCAPTCHA
   admin console — it's a 5-minute check that can explain a whole origin's
   denials without any metrics.
4. Record findings with the Gate model; fixes prioritised by **user-impact
   rate**, not request rate.

**Do not** infer client breakdown from Part A alone — it isn't in the data, and
guessing is the failure mode this plan exists to prevent.

## Existing assets

- `scripts/verify-appcheck.js` — guards that debug-token assignment is
  localhost-gated and no token UUID is committed; reuse as the config-drift check.
- `scripts/probe-provider-directory.js` — the debug-token browser harness;
  reuse to reproduce a denial deterministically for beacon testing.
