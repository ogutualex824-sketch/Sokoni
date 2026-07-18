# Home Page — CPU Performance Investigation

**Date:** 2026-07-18
**Scope:** Measurement only. **No application code was modified.**
**Verdict:** Does not qualify for RC1. **Fix after pilot.**
**Companion:** [[PERFORMANCE_SPRINT_CLOSURE]] · [[MEASUREMENT_VALIDITY_CORRECTION]]

---

## Why Home was targeted

The corrected baseline (v2, cold + warm, URL-asserted) identified Home as the platform's worst
page on warm Total Blocking Time:

| Page | Cold TBT | **Warm TBT** | Cold penalty |
|---|---|---|---|
| **Home** | 2532 | **755** | 3.4× |
| SmartPOS | 1098 | 211 | 5.2× |
| Orders | 381 | 34 | 11.2× |
| Search | 524 | 31 | 16.9× |
| Inventory | 323 | 0 | n/a |

Home carries the smallest cold-start penalty on the platform, meaning its cost is **structural
rather than first-visit** — it does not wash out on repeat visits. It is also the highest-traffic
surface: every visitor pays it, every time.

---

## Root cause ranking

**This is a rendering problem, not a JavaScript problem.** That inverts the working assumption the
investigation began with.

| Rank | Cause | Cost | Evidence |
|---|---|---|---|
| 1 | **Style recalculation** | **3527 ms** | 314 recalcs over a 3128-element DOM |
| 2 | **Layout** | **2699 ms** | 291 layout passes |
| 3 | Script execution | 1811 ms | 77 scripts |
| 4 | Garbage collection | 399 ms | — |
| 5 | Parse/compile `(program)` | 3516 ms | cold-dominated; largely absent warm |

Style + layout = **6226 ms, 3.4× JavaScript execution time.** Optimizing JS targets the
third-largest cost. Source: CDP `Performance.getMetrics`, warm load.

---

## Flamegraph summary

9-second warm window: 4511 ms idle · 3516 ms `(program)` · 399 ms GC · 152 ms
`getBoundingClientRect`.

Owned JS self-time:

| ms | Function | Location |
|---|---|---|
| 606 | `_writeSafeAreaVars` | `sokoni-form-engine.js:247` |
| 513 | `_update` | `shared-header.js:2109` |
| 251 | anonymous | `sokoni-performance.js:122` |
| ~250 | assorted | `recaptcha__en.js` |
| 86 | `_initKeyboardDetect` | `sokoni-layout.js:264` |
| 86 | `save` | `scroll-memory.js:10` |
| 76 | `_pad` | `security.js:622` |

19 long tasks, 2769 ms total, longest 435 ms.

---

## CPU allocation by contributor

**Measured:** reCAPTCHA ~250 ms · `sokoni-layout.js` 151 ms · `scroll-memory.js` 94 ms ·
`security.js` 80 ms · `script.js` (product rendering) 61 ms · `firebase-firestore.js` 55 ms ·
`sokoni-sheet.js` 44 ms · `sokoni-float.js` 28 ms · `firebase-app.js` 5 ms.

**Not observed on Home warm:** Zero Trust (`_buildSignals` appears on `/pos`, not here), Cloud
Functions, Analytics, Advertising, Wallet, Notifications.

**Not separately attributable** with this instrumentation: Service Worker, Hero, Search. Recorded
as a gap rather than as zero.

**Images:** already well handled — 52 of 53 lazy-loaded.

**Background polling:** 16 intervals registered. Aggressive periods: `kass-widget.js:152` @60 ms,
`recaptcha__en.js:289` @100 ms, @200 ms, @400 ms, `shared-header.js:2035` @500 ms. These did not
dominate the measured window, but a 60 ms interval is 16 wakeups/second for the life of the tab.
Worth review post-pilot; not a proven contributor to warm TBT.

---

## Hypothesis verification

| Hypothesis | Verdict |
|---|---|
| Repeated initialization | **No.** `promote()` runs once; `_writeSafeAreaVars` twice. |
| Duplicate listeners | **No duplicates**, but 475 listeners registered (50 `load`, 26 `error`, 25 `click`). |
| Duplicate rendering | Not observed. |
| Synchronous layout | **Confirmed.** `promote()` interleaves `getComputedStyle` and `getBoundingClientRect` reads document-wide. |
| Unnecessary work | **Confirmed.** `promote()` calls `getComputedStyle` on 1081 elements to find 13 that are `position:fixed` — 98.8% wasted. |
| Third-party libraries | reCAPTCHA ~250 ms + a 100 ms interval. Required by App Check; out of scope under security governance. |
| Oversized bundles / parsing | 77 scripts. Significant cold, largely amortized warm. |
| Long-running timers | Present (above), not dominant in this window. |
| Expensive security routines | `security.js` `_pad` 76 ms. Minor. |

---

## Largest optimization opportunity — measured by ablation

`sokoni-sheet.js:343 promote()`. Quantified by neutralizing its document scan **in the browser
only** (no repo change), 2 runs per arm:

| Metric | Baseline | `promote()` neutralized | Delta |
|---|---|---|---|
| TBT | 1471 ms | 1200 ms | **−271 ms** |
| RecalcStyle | 3527 ms | 3216 ms | −311 ms |
| Layout | 2699 ms | 2488 ms | −211 ms |
| Script | 1811 ms | 1680 ms | −131 ms |

**~271 ms TBT, ~18% of total — real and verified, and not the whole problem.** 1200 ms of TBT
persists without it. The remainder is diffuse: 3128 DOM elements, 321 style recalcs, 291 layout
passes.

**Expected LCP benefit: none.** LCP is image/hero-bound here; the ablation did not move it.

### Risk assessment — **Medium**

`promote()` is a z-index correctness mechanism ensuring full-screen sheets layer above the header.
A wrong narrowing produces modals rendering **behind** the header — a visible functional bug on
checkout and auth flows.

A safe fix preserves behaviour and only narrows the scan: skip subtrees that cannot contain fixed
elements, or test the cheap `el.style.position` before the expensive computed read. It must not
change which elements get promoted.

- **Files affected:** `sokoni-sheet.js` only.
- **Rollback:** single-file revert.
- **Verification:** the ablation harness plus manual modal-layering checks on checkout and auth.

Note the author deliberately avoided polling here — `sokoni-sheet.js:332` documents "No polling, no
MutationObserver on the whole document, no scroll listener." The single-pass design is intentional
and should be preserved.

---

## RC1 qualification

**Does not qualify.** The freeze admits: critical production defect · security vulnerability ·
data-integrity issue · financial-correctness issue · deployment blocker · documented regression.
A performance improvement on a functioning page is none of these.

## Recommendation — **fix after pilot**

The largest verified win is 271 ms of a 1471 ms problem, on a page that works, at Medium risk to
modal layering during a pilot in which checkout must not break.

The engineering principle — remove the largest verified bottleneck, not the easiest — argues
**against** shipping this now. The largest bottleneck is diffuse style/layout cost driven by DOM
size. `promote()` is the easiest 18% of it, not the bottleneck itself. Addressing DOM size and
style-recalc pressure is the higher-value work, and it is too large for a freeze.

---

## Caveats

1. **Ablation is 2 runs per arm.** Directionally solid, not a precise estimate.
2. **Ablation baseline TBT (1471 ms) runs higher than the 3-session median (755 ms).** Treat the
   *relative* delta as the finding, not the absolute figure.
3. **Desktop Chromium on a developer connection.** On a mid-range Android over Kenyan mobile data,
   style and layout over 3128 elements will cost considerably more. This strengthens the case for
   attacking DOM size post-pilot rather than shaving 271 ms now.
4. **Service Worker, Hero and Search were not separately attributed.** Closing that needs different
   instrumentation.
