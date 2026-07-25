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

When adding a rule for a page, add **both** forms — `@(name)` *and* `@(name).html` —
as the existing `login` / `checkout` / `profile` rules do. The `.html` form is not
dead weight: it still covers direct-file access and any future config where
`cleanUrls` is off.

---

## Current order

Do not reorder without re-reading Rule 1.

| # | source | purpose |
|---|---|---|
| 0 | `**` | document default — `no-cache, no-store, must-revalidate` |
| 1 | `**/*.@(js|css)` | 1 h browser cache, no CDN cache |
| 2 | `**/*.@(jpg\|jpeg\|gif\|png\|svg\|ico\|webp\|woff2\|woff\|ttf)` | 30 d immutable-ish |
| 3–4 | `/service-worker.js`, `/firebase-messaging-sw.js` | **must stay below #1** — the exact pair that regressed |
| 5–12 | individual JS files, `version.json`, `manifest.json`, assetlinks | per-file overrides |
| 13–18 | `login` / `signup` / `admin` / `superadmin` / `checkout` / `payments` / `wallet` / `financial-os` / `finos` / `profile` / `seller` | private pages — `no-store, private`, several `noindex` |
| 19 | `**` | security headers (CSP, HSTS, Permissions-Policy, …) |

---

## Performance note

Making the document default `no-store` trades edge caching for deploy freshness on
**public** pages too (`/`, `/shop/**`, category and product pages), which were
previously served from the edge with `max-age=3600`.

That matches the project's declared intent — the dead `**/*.html` rule had always said
`no-store`. If origin load becomes a problem, the correct follow-up is `no-cache` for
public pages only: the response is still stored, but revalidated via `ETag`, so
browsers get a 304 instead of a full transfer and freshness is preserved. That is a
policy change and should be made deliberately, not as a side effect of a fix.

---

## Verifying a change

Header rules only take effect on deploy. After deploying:

```bash
for p in profile seller wallet service-worker.js sokoni-ui.js; do
  printf "%-22s %s\n" "$p" \
    "$(curl -sI https://mysokoni.co.ke/$p | grep -i '^cache-control' | tr -d '\r')"
done
```

Expected: `profile` and `seller` → `no-store, private`; `wallet` → `no-store, private`;
`service-worker.js` → `no-cache, no-store, must-revalidate`; `sokoni-ui.js` →
`public, max-age=3600, must-revalidate`.

Note that hosting deploys the **working tree**, not `HEAD` — see
[[DEPLOYMENT]] and the clean-worktree rule before deploying.

---

Related: [[DEPLOYMENT]] · [[ARCHITECTURE]] · [[SECURITY]] · [[CHANGELOG]]
