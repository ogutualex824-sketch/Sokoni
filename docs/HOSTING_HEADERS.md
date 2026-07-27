# Hosting Headers — Ordering Contract

**Status:** Authoritative
**Applies to:** `firebase.json` → `hosting.headers`
**Last verified against production:** 2026-07-25

JSON has no comments, so this file is where the rules that govern
`firebase.json` live. Read it before editing the `headers` array.

---

## Rule 1 — The LAST matching rule wins

Firebase Hosting applies **every** rule whose `source` matches the request path. When
two matching rules set the **same header key**, the one that appears **later in the
array** wins.

This is the opposite of what the file used to assume, and it was silently breaking
things.

### Proof

`/service-worker.js` had its own rule setting `Cache-Control: no-cache, no-store,
must-revalidate`. It sat *above* the generic `**/*.@(js|css)` rule. Production served:

```
$ curl -sI https://mysokoni.co.ke/service-worker.js | grep -i cache-control
Cache-Control: public, max-age=3600, must-revalidate
```

The generic rule won. The service worker was browser-cached for an hour despite an
explicit rule forbidding it — the same failure class as the earlier Cloudflare SW
cache incident.

### Consequence

**The array must read generic → specific.** Broad defaults at the top, narrow
overrides at the bottom.

> Adding a specific rule **above** a generic one that sets the same key is a silent
> no-op. It will look correct in review and do nothing in production. Put it
> **below**.

A rule that sets a key **no other matching rule sets** is order-independent. The final
`**` block (CSP, HSTS, `X-Frame-Options`, …) is safe wherever it sits because nothing
else sets those keys — it stays last by convention only.

---

## Rule 2 — `cleanUrls: true` means `**/*.html` matches nothing

Hosting is configured with `cleanUrls: true`, so live requests are `/profile`,
`/wallet`, `/shop/kass-shop` — **never** `/profile.html`. A rule with
`"source": "**/*.html"` therefore matches no real request.

The site-wide HTML `no-store` rule was written that way and had never applied to a
single page. Everything fell through to Firebase's default `max-age=3600`, cached at a
shared edge. Measured 2026-07-25, before the fix:

| path | status | `Cache-Control` served |
|---|---|---|
| `/profile` | 200 | `max-age=3600` — `X-Cache: HIT` |
| `/seller` | 200 | `max-age=3600` |
| `/minishop` | 200 | `max-age=3600` |
| `/wallet` | 200 | `no-store, private` — had a hand-written extensionless twin |
| `/orders` | 404 | `no-store` — Firebase's default for errors, not our rule |

Only the nine pages that someone had hand-written an extensionless twin for were ever
covered.

### Consequence

The document default is now `"source": "**"`, with the asset rules **below** it
overriding for `js`/`css`/images. That is the only pattern that reaches extensionless
page URLs.

The default value is **`no-cache, must-revalidate`**, not `no-store`. The distinction
is deliberate and worth understanding before changing it:

| directive | stored? | served without asking origin? |
|---|---|---|
| `no-store` | no | never — full transfer every navigation |
| `no-cache` | yes | no — always revalidated, so a match returns `304` with no body |

Both are always fresh. `no-cache` is fresh **and** cheap, because an unchanged page
costs a conditional request instead of a full transfer — which matters on Kenyan
mobile networks where these pages are mostly read.

`no-cache` is safe here only because of a structural property: **every page on SOKONI
is a user-agnostic shell.** All member data is fetched client-side through
authenticated Cloud Functions, so the HTML a shared cache stores is identical for
every viewer and contains nothing private. Pages that reach authentication or payment
state are still explicitly `no-store, private` in the private-pages block.

> If a page is ever added that renders user data into its HTML at the origin, the
> default is **not** sufficient. Add it to the private-pages block in the same commit.

When adding a rule for a page, add **both** forms — `@(name)` *and* `@(name).html` —
as the existing `login` / `checkout` / `profile` rules do. The `.html` form is not
dead weight: it still covers direct-file access and any future config where
`cleanUrls` is off.

---

## Current order

Do not reorder without re-reading Rule 1.

| # | source | purpose |
|---|---|---|
| 0 | `**` | document default — `no-cache, must-revalidate` |
| 1 | `**/*.@(js\|css)` | 1 h browser cache, no CDN cache |
| 2 | `**/*.@(jpg\|jpeg\|gif\|png\|svg\|ico\|webp\|woff2\|woff\|ttf)` | 30 d |
| 3–4 | `/service-worker.js`, `/firebase-messaging-sw.js` | **must stay below #1** — the exact pair that regressed |
| 5–12 | individual JS files, `version.json`, `manifest.json`, assetlinks | per-file overrides |
| 13–18 | `login` / `signup` / `admin` / `superadmin` / `checkout` / `payments` / `wallet` / `financial-os` / `finos` / `profile` / `seller` | private pages — `no-store, private`, several `noindex` |
| 19–21 | `/profile/**`, `/shop/**`, `/@**` | prerendered public pages — `public, max-age=300, s-maxage=600, stale-while-revalidate=86400` |
| 22 | `**` | security headers (CSP, HSTS, Permissions-Policy, …) |

Rules 19–21 are served by Cloud Functions, not static files — see
[[PUBLIC_PAGE_PRERENDER]]. Their `Cache-Control` is set **identically** in the function
and here, deliberately: it removes any dependence on whether Hosting config or a
function-set header wins, which is not something to leave to chance in the request path
of the storefront.

`/profile` (the private dashboard) and `/profile/**` (public prerendered profiles) are
different pages with opposite policies. Rule 18 matches the single segment `profile`
only; rule 19 matches deeper paths. Do not merge them.

---

## Verifying a change

Header rules only take effect on deploy. After deploying:

```bash
for p in "" profile seller wallet service-worker.js sokoni-ui.js \
         "profile/SOME_REAL_UID" "shop/SOME_REAL_HANDLE"; do
  printf "%-28s %s\n" "/$p" \
    "$(curl -sI "https://mysokoni.co.ke/$p" | grep -i '^cache-control' | tr -d '\r')"
done
```

Expected:

| path | expected |
|---|---|
| `/` | `no-cache, must-revalidate` |
| `/profile`, `/seller`, `/wallet` | `no-store, private` |
| `/service-worker.js` | `no-cache, no-store, must-revalidate` ← the regression check |
| `/sokoni-ui.js` | `public, max-age=3600, must-revalidate` |
| `/profile/{uid}`, `/shop/{handle}` | `public, max-age=300, …` |

Note that hosting deploys the **working tree**, not `HEAD` — see
[[DEPLOYMENT]] and the clean-worktree rule before deploying.

---

Related: [[PUBLIC_PAGE_PRERENDER]] · [[DEPLOYMENT]] · [[ARCHITECTURE]] · [[SECURITY]] · [[CHANGELOG]]
