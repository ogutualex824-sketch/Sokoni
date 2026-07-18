# Performance Stabilization Sprint — Closure Report

**Date:** 2026-07-18
**Outcome:** Closed. **No RC1 code change recommended.**
**Companion:** [[MEASUREMENT_VALIDITY_CORRECTION]]

---

## Result

The sprint produced **no confirmed performance defect meeting RC1 freeze criteria**. Its lasting
output is corrected measurement infrastructure and the first valid baseline the platform has had.

Four findings reported during the sprint were withdrawn. All four were artifacts of how
measurement was taken, not of application behaviour:

| Reported | Actual |
|---|---|
| SmartPOS ~85 aborted requests | Navigation cancellation `/pos` → `/pos-setup`. Real figure: **4**. |
| 10 SmartPOS modules missing (escalated P0) | Measured on `/pos-setup`. All **9 modules LIVE 5/5 runs**. |
| SmartPOS 3 MB heap anomaly | `/pos-setup` is a small page. Real figure: **15.5 MB**, post-GC sd **0.0**. |
| SmartPOS TBT 1106 ms defect | Cold-start only. Warm: **211 ms**. |

---

## Baseline v2 — cold and warm

3 sessions/page, cold load then 2 warm reloads in the same context. Median values.

| Page | Cold FCP | Cold LCP | Cold TBT | Warm FCP | Warm LCP | **Warm TBT** | Heap c/w |
|---|---|---|---|---|---|---|---|
| Home | 1444 | 1956 | 2532 | 1112 | 1352 | **755** | 25/18 MB |
| Search | 636 | 852 | 524 | 352 | 696 | **31** | 15/27 MB |
| Orders | 520 | 1900 | 381 | 160 | 1304 | **34** | 17/19 MB |
| Inventory | 672 | 1008 | 323 | 152 | 1220 | **0** | 13/18 MB |
| SmartPOS | 1620 | 3000 | 1098 | 576 | 2008 | **211** | 13/19 MB |

Cold-start penalty (cold ÷ warm TBT): Search 16.9×, Orders 11.2×, SmartPOS 5.2×, Home 3.4×.

### What this changes

**SmartPOS is healthy.** Warm TBT 211 ms, 4 failed requests, stable heap. A POS terminal is opened
once at the start of trading and kept open, so warm is its representative state. It pays cold start
once per device per day.

**Home is the platform's worst page.** Warm TBT **755 ms** — 3.6× the next worst page and 3.8× the
200 ms "good" threshold — and the only page whose cold-start penalty is small, meaning the cost is
structural rather than first-visit. Home is also the highest-traffic surface on the platform: every
visitor pays it, on every visit, warm or cold.

This inverts the sprint's original priority order, which was built on the invalid baseline.

---

## Where SmartPOS cold-start time goes

CPU profile, 10 s sample on `/pos`: 8641 ms idle, 2818 ms `(program)` (parse/compile of 880 KB
across 95 scripts). Attributable JS self-time ~1.6 s, concentrated in few functions — **not** spread
across the 95 scripts:

| Cost | Source |
|---|---|
| 607 ms | `recaptcha__en.js` (third-party, App Check) |
| 340 ms | `_buildSignals` — canvas + WebGL + AudioContext fingerprinting, `sokoni-zero-trust.js:105` |
| 130 ms | `_writeSafeAreaVars`, `sokoni-form-engine.js` |
| 96 ms | `_measure`, `sokoni-layout.js` |
| 56 ms | `_pad`, `security.js` |

`_getOrCreateDeviceId` caches the fingerprint in `localStorage`, so the 340 ms is by design a
first-visit cost. "Defer the 95 scripts" was never the correct fix.

---

## Harness defects fixed

Both defects made wrong numbers look trustworthy. Neither was in application code.

**1. Unasserted measurement subject.** v1 never compared `page.url()` to the requested path, so
RBAC-gated pages were measured as their redirect target and labelled with the requested page's
name — 5 of 9 rows invalid, every one an authenticated page. **Low variance disguised it:** `/pos`
reported sd=2 across 5 runs because it consistently measured the same wrong page.

**2. Cold-start-only measurement.** v1 built a fresh context per run, so it measured empty cache and
empty `localStorage` exclusively — systematically the worst case. Defensible for a page visited
once; wrong for a POS terminal.

`perf-baseline-v2.js` asserts the landed URL, discards off-target runs, reports `UNMEASURED` naming
the redirect target, and measures cold and warm in one session.

**Standing rule:** any browser-based measurement must assert its final URL and state whether it is
cold or warm before its output is used as evidence. A metric attributed to a page that was never
loaded is not a weak measurement — it is a fabricated one.

---

## Measuring gated pages

`/pos` is **not** auth-gated. `pos.html:28-36` redirects on two `localStorage` keys —
`sokoni_setup_complete` and `sokoni_merchant_id` — with no Firebase involvement. Seeding those two
keys via `addInitScript` unblocks it entirely. No credentials required.

`/wallet`, `/checkout`, `/seller`, `/admin` route through `auth-guard.js`, which calls
`signInWithEmailAndPassword` (`auth-guard.js:206`). A seeded flag will not survive
`onAuthStateChanged`; these need a real test account, and `/admin` additionally needs elevated
claims. **Still unmeasured.** Recommendation: defer past RC1, and exclude `/admin` — minting admin
claims for a performance harness crosses the [[feedback_security_layers]] boundary for a number
that is not urgently needed.

---

## Open items (none blocking)

1. **Home warm TBT 755 ms** — the sprint's only surviving performance signal, on the highest-traffic
   page. Not yet root-caused; no profile has been run against Home. Highest-value next investigation.
2. **Warm loads show more failed requests than cold** (Home 5→15, Search 6→21). Not yet a finding —
   most likely `reload()` cancelling in-flight requests, the same navigation-cancellation mechanism
   that produced the withdrawn 85-abort claim. **Must be verified before being reported**, given
   that history.
3. **Authenticated surfaces unmeasured** — see above.
4. **Desktop-only measurement.** All figures are desktop Chromium on a developer connection. A
   mid-range Android on Kenyan mobile data will be materially worse; treat every number as a floor.

---

## Governance

No application code was modified during this sprint. Changes were limited to documentation,
comments, and the measurement harness. `scripts/verify-firebase-config.js` passes. The authorized
3-page charset pilot was **not executed** — its premise was disproven before any file was edited;
filed to [[PHASE1_POST_PILOT_BACKLOG]] as P1-CHARSET with expected performance gain stated as zero.
