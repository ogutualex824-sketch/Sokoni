# Font Awesome — self-hosted

**Status:** implemented, gate-certified, **not yet deployed**
**Date:** 2026-08-27
**Version pinned:** Font Awesome Free **6.5.1**

---

## Why this changed

Font Awesome was loaded render-blocking from `cdnjs.cloudflare.com` in the `<head>` of
**104 pages**. Every one of those pages therefore had a third-party origin sitting in front
of its own first paint: a cdnjs outage, a slow TLS handshake, or a rate-limit stalled the
page before a single pixel appeared.

This was not hypothetical. Measured against production on 2026-08-27, `cdnjs.cloudflare.com`
returned **HTTP 503** repeatedly under load while `mysokoni.co.ke` itself was serving
normally at ~1.1 s.

Self-hosting removes the extra DNS lookup, TCP connect and TLS handshake to a foreign origin,
and removes an external dependency from the critical rendering path of nearly every page on
the platform.

> **This did not make the stylesheet non-blocking.** It is still render-blocking, by choice —
> deferring it would flash un-styled icon boxes on 104 pages. What changed is *who* the page
> waits on: SOKONI, not a third party.

---

## What is served

```
assets/vendor/fontawesome/6.5.1/
├── css/all.min.css                    102,641 bytes
└── webfonts/
    ├── fa-solid-900.woff2             156,496      ├── fa-solid-900.ttf         419,720
    ├── fa-regular-400.woff2            25,452      ├── fa-regular-400.ttf        68,004
    ├── fa-brands-400.woff2            117,372      ├── fa-brands-400.ttf        207,972
    └── fa-v4compatibility.woff2         4,792      └── fa-v4compatibility.ttf    10,832
```

The stylesheet is **byte-identical** to the published 6.5.1 build
(`sha256 c22cfb6520a7fdbb738632834019acf47c78b1279462c0eb4cb83bae83ecb5a7`), pinned in the
test suite so a silent swap for a different build fails the gate.

`.ttf` files are vendored for faithfulness but cost real users **nothing**: `all.min.css`
lists `woff2` first in every `src`, so a browser that supports woff2 never requests the ttf.

### The reference

```html
<link rel="stylesheet" href="/assets/vendor/fontawesome/6.5.1/css/all.min.css">
```

Root-absolute on purpose — a relative href would 404 for pages served under a path prefix
such as `/shop/{handle}` (see [[MiniShop]]).

---

## Caching

No service worker change was needed. `service-worker.js` already routes
`woff`/`woff2`/`ttf`/`eot` to **Cache First** in `STATIC_CACHE`, so each face is fetched once
and served from cache thereafter. The fonts are deliberately **not** precached at install —
adding ~1 MB to the install step would slow first load for every user to benefit the few
pages using a given face. See [[Service Worker]].

---

## Content Security Policy

`cdnjs.cloudflare.com` was removed from **`style-src`** and **`font-src`** in `firebase.json`,
because nothing loads a stylesheet or a font from cdnjs any more.

It **remains in `script-src`**, and must: `qrcodejs` and `pdf.js` still load from cdnjs
(`pos-modules.js`, `sokoni-legal-certificate.js`, `sokoni-print-engine.js`, `pos-ai.js`).
Removing it there would break POS QR printing and the AI PDF reader. The `preconnect` to
cdnjs in `security.js` is likewise still correct for those scripts.

See [[Security]].

---

## Verification

`node scripts/test-fontawesome-selfhost.js` — **16 passed, 0 failed**.

The suite carries a **negative control**: a scan that matches nothing looks identical to a
clean tree, so it separately asserts the scanner can find the *local* href and aborts if it
cannot. It was proved by targeted sabotage, each case checked by exit code:

| Sabotage | Result |
|---|---|
| plant a cdnjs Font Awesome reference | exit 1, 1 failure |
| tamper with the vendored stylesheet | exit 1, 1 failure |
| delete a font file the CSS requires | exit 1, 1 failure |
| restore cdnjs to `font-src` | exit 1, 1 failure |
| remove the vendored directory | exit 1 |

**Browser-verified** under the real CSP on a local server: `/cart` and `/` load **6 Font
Awesome faces**, glyph advance width **88 px vs 65 px fallback** (so the glyphs genuinely
draw, not merely 200), **zero CSP violations**, fonts fetched from origin.

`pos.html` shows no Font Awesome — confirmed against `a9d8dec` that it never referenced it.

---

## Related

[[Service Worker]] · [[Security]] · [[MiniShop]] · [[Startup Performance]] · [[SmartPOS]]
