# SOKONI — Production Stabilization Report

**Date:** 2026-07-13 · **Origin build:** `7c398e2` · **Status:** 🔴 **NOT LIVE TO USERS**

> Only what was directly observed is recorded here. Nothing is claimed as perfect.

---

## 🔴 BLOCKER — production is still serving stale code

The Cloudflare cache was **not purged**. Every fix in this report is deployed to the
Firebase origin but is **not reaching users**.

| File | Origin | Production | |
|---|---|---|---|
| `splash.js` | 15,911 | 24,695 | ❌ stale |
| `script.js` | 190,390 | 189,063 | ❌ stale |
| `scroll-top.js` | 4,097 | 3,418 | ❌ stale |
| `sw-register.js` | 36,029 | 33,963 | ❌ stale |
| `sokoni-footer.js` | 21,503 | 20,228 | ❌ stale |
| `sokoni-ui.js` | 45,065 | 43,887 | ❌ stale |
| `security.js` | 34,802 | 34,824 | ❌ stale |
| `sokoni-mobile-fixes.css` | 15,470 | 13,415 | ❌ stale |
| `sokoni-responsive.css` | 31,002 | 30,292 | ❌ stale |
| `style.css` | 368,356 | 367,389 | ❌ stale |
| `mobile.css` | 153,912 | 153,497 | ❌ stale |
| `shared-header.js` | 76,447 | 76,447 | ✅ fresh (`cf=BYPASS`) |
| `service-worker.js` | 29,254 | 29,254 | ✅ fresh (`cf=BYPASS`) |

**11 of 13 stale.** `cf-cache-status: HIT`, `age: 44,974s`.

**Why a redeploy will not fix it:** Cloudflare's *already-cached* entries retain their
old `max-age=604800` header. They keep serving for up to **7 days** no matter what we
deploy. The corrected headers only apply to responses fetched fresh from origin.

**Required (operator, ~10s):** Cloudflare Dashboard → Caching → Configuration →
**Purge Everything**. Only the two files that already carried `CDN-Cache-Control:
no-store` are getting through — which is exactly why they are the only fresh ones.

Permanent fix already deployed in `firebase.json`: `**/*.@(js|css)` now sends
`Cache-Control: public, max-age=3600, must-revalidate` + `CDN-Cache-Control: no-store`.
After this one purge, the problem cannot recur.

---

## Coverage — what was actually tested

| Target | How | Real device? |
|---|---|---|
| **Desktop Chrome** | installed Chrome, driven live | ✅ **real browser** |
| **Desktop Edge** | installed Edge, driven live | ✅ **real browser** |
| iPhone Safari | **WebKit engine** (Safari's own) @ 393×852 | ❌ **engine only** |
| iPad Safari | **WebKit engine** @ 820×1180 | ❌ **engine only** |
| Android Chrome | Chromium @ 412×915 | ❌ **engine only** |

**I did not test on physical devices.** I have no iPhone, iPad, or Android handset.
WebKit is Safari's *rendering engine*, which is why it caught a Safari-only bug (below)
— but it is **not iOS**. Not covered and **not claimed**: safe-area insets on a real
notch, momentum scrolling, iOS viewport resize on keyboard open, Home-screen PWA mode,
real touch input, real network conditions.

**Those five device checks remain outstanding and must be done by a human on hardware.**

---

## Verified on the origin build

Across 7 pages × 5 targets:

| Criterion | Observed |
|---|---|
| Single splash screen | ✅ **1 root, 0 stuck** (Chrome, Edge, WebKit, Android) |
| No horizontal scrolling | ✅ **0px** on every target |
| No overlapping floating layers | ✅ **FAB collisions: 0** everywhere |
| Consent links clickable | ✅ clickable **with 44px hit area** |
| Back-to-top after scrolling | ✅ appears, **46×46**, clickable |
| KASS / WhatsApp / scroll-top independent | ✅ back-to-top on **left rail**, KASS on **right** |
| Header stable | ✅ present on all 7 real pages |
| Footer stable | ✅ **1** universal footer, **0** legacy |
| JS errors | ✅ **NONE** in Chrome, Edge **and WebKit** |
| Working promo codes | ⚠️ **partially verified — see below** |

---

## Defects found and fixed this sprint

### 1. Floating-layer priority (found by SCREENSHOT, not by assertions)
The notification prompt rendered **on top of the welcome modal**, covering its
"Maybe later" link. Fixing that exposed the next one: the welcome modal fired at ~11s
**over the privacy/cookie consent banner**. Obscuring a consent notice is a compliance
problem, not a cosmetic one.

Replaced pairwise patching with one explicit chain:
`consent (legally required) → welcome → notification opt-in`.
Verified in real Chrome across all three phases: **0 overlaps**.

### 2. Safari-only TypeError on CHECKOUT
```
TypeError: null is not an object (evaluating 'this.nextElementSibling.style')
    at onerror (checkout:1237), (checkout:1352)
```
The IntaSend trust badge's `onerror` dereferenced a fallback `<span>` that **exists in
the markup but had not been parsed yet** when the handler fired. WebKit fails the S3
image fast enough to hit the race; Chromium does not. **This threw on Safari and never
on Chrome.** Guarded in all 5 occurrences. Post-fix: **0 app JS errors in WebKit**.

### 3. help.html shipped a duplicate back-to-top
`.hlp-back-top` (pinned `right:20px`) duplicated the global button and **collided with
the KASS FAB**. Removed; the global one works and sits on the left rail.

### 4. Brand
10 more raster logos rendered from JS → `sokoni-icon.svg` (the welcome modal's logo was
**visibly broken** in the first screenshot — a bag icon plus a clipped text fragment).
4 × "Welcome to Sokoni" → "Welcome to **SOKONI**".
Deliberately left raster: invoice print pipeline, OG/social scrapers, favicons, push icons —
SVG is invalid or unreliable in all of those.

### 5. Two bugs I introduced and caught
A `node -e` heredoc silently stripped every string quote in a block it wrote, producing
`getElementById(_sokoniPrivacyBanner)` and `!== none` — **syntactically valid** JavaScript
referencing undefined identifiers. `node --check` passed while the welcome modal threw at
runtime and never appeared. Rewritten and grep-audited for the whole damage class.

An earlier gate tested `offsetParent !== null` — which is **always null for
`position:fixed`**, and both layers are fixed. The check reported "not visible" for
elements plainly on screen. All gates now test rect + display + visibility + opacity.

---

## ⚠️ Remaining issues — open and unverified

1. **Cloudflare not purged.** Users are on ~7-day-old JavaScript. **Nothing above is live.**
2. **Promo codes — only partially verified.** The `_esc` `SyntaxError` that killed the
   entire inline block is **gone** (served file: 0 × `const _esc`, 0 JS errors where there
   was previously a hard parse failure). But `cart.html` is `data-require-auth="true"` and
   redirects to `/login`, so I **could not exercise apply-a-code end-to-end** without an
   authenticated session. **Operator must confirm** with a real login: valid code applies a
   discount, invalid code is rejected.
3. **No physical-device testing.** The five device checks are outstanding.
4. **One transient observation not reproduced:** WebKit/iPad reported 172px horizontal
   scroll on a single render, then measured 0px on every retry. Cause unknown. Logged
   rather than dismissed.
5. **`cart` and `checkout` have no `#sk-top-nav`** — they redirect to `/login`, which is an
   auth layout by design. Not a defect, but the header is genuinely absent there.

---

## Honest bottom line

**The origin build is materially better and I can evidence that.** Zero horizontal scroll,
one splash, no FAB collisions, clickable consent, a working back-to-top, and zero JS errors
in three engines including Safari's.

**But it is not what your users are running, and I have not seen it on a phone.**
Until Cloudflare is purged, this report describes a build nobody can reach.
