# Initiative — Home Rendering Optimization

**Status:** OPEN · Post-Pilot. **Not RC1.**
**Opened:** 2026-07-18
**Predecessor:** [[HOME_PERFORMANCE_INVESTIGATION]] (accepted) · [[PERFORMANCE_SPRINT_CLOSURE]]

---

## Goal

Reduce persistent warm Home TBT by **reducing rendering cost, not JavaScript execution**.

The objective is structural rendering efficiency. Script reduction is explicitly *not* the target —
the accepted evidence shows JavaScript is the third-largest cost, and optimizing it would chase the
smaller number.

---

## Accepted starting evidence (desktop, RC1 sprint)

| Cost | Measurement |
|---|---|
| RecalcStyle | **3527 ms** (314 recalcs) |
| Layout | **2699 ms** (291 passes) |
| Script | 1811 ms |
| GC | 399 ms |
| DOM | 3128 elements · 8898 nodes · 475 listeners |
| Warm TBT | 755 ms median (3.8× the 200 ms threshold) |

Style + layout is **3.4× JavaScript execution**. Cold-start penalty is only 3.4×, the smallest on
the platform — the cost is structural, not first-visit.

Largest single verified win, by browser-side ablation: `sokoni-sheet.js:343 promote()`, **−271 ms
TBT (~18%)**. It is the easiest slice, **not** the bottleneck. The remaining ~82% is diffuse
DOM-size pressure with no single lever.

---

## MANDATORY GATE — mobile-first re-investigation

**No optimization may be implemented until the complete investigation is repeated on mobile.**

Desktop findings are accepted as engineering evidence but **must not be used alone to prioritize
this work.**

Required conditions:

- Mid-range Android hardware (real device, not emulation alone)
- Mobile CPU throttling
- Mobile network simulation
- Real touch interaction
- Warm merchant session

The desktop ranking is a hypothesis for mobile, not a conclusion. Style and layout over a
3128-element DOM will scale differently under a mobile CPU than script parsing does, so the
ranking itself may reorder. **Re-derive the ranking from mobile evidence before selecting any fix.**

---

## Investigation scope

- DOM complexity and DOM size
- CSS selector cost
- Layout invalidation
- Style recalculation
- Rendering architecture
- Component lifecycle
- Fixed-position scanning
- Virtualization opportunities
- Progressive rendering
- Deferred off-screen UI

---

## Candidate items carried forward

Each is **unproven at mobile scale** and must be re-verified against mobile evidence before action.

| Item | Desktop evidence | Risk |
|---|---|---|
| `promote()` full-document scan — `getComputedStyle` on 1081 elements to find 13 `position:fixed` (98.8% wasted), interleaved with `getBoundingClientRect` | −271 ms TBT ablated | **Medium** — guarantees full-screen sheets layer above the header; a wrong narrowing renders modals *behind* it, visible on checkout and auth |
| DOM size — 3128 elements, 206 product-ish nodes | Drives items 1 and 2 in the ranking | Structural; likely the highest-value target |
| `_writeSafeAreaVars` (`sokoni-form-engine.js:247`) — forced sync layout, ~303 ms per call, 2× per load | 606 ms self-time | Low–Medium |
| 16 registered intervals incl. `kass-widget.js:152` @60 ms, `recaptcha` @100 ms | Not dominant in the measured window | Unproven contributor |
| 475 registered event listeners | Not isolated | Unproven contributor |

---

## Constraints

- Preserve the intentional single-pass, no-polling design documented at `sokoni-sheet.js:332`
  ("No polling, no MutationObserver on the whole document, no scroll listener").
- Modal/sheet layering behaviour must not change. Which elements get promoted stays identical;
  only the cost of deciding may change.
- **Expected LCP benefit: none.** LCP on Home is hero/image-bound. Do not justify this work on LCP.
- Every change verified with the ablation harness plus manual modal-layering checks on checkout and
  auth flows.

---

## Known gaps to close

1. **Service Worker, Hero and Search were not separately attributable** with the RC1 instrumentation.
   Needs a different approach.
2. **Ablation was 2 runs per arm.** Directional, not precise. Re-run at higher N on mobile.
3. All RC1 figures are desktop Chromium on a developer connection. Treat every number as a floor.

---

## Definition of done

- Mobile-first investigation complete, ranking re-derived from mobile evidence.
- Largest **verified** mobile bottleneck addressed — not the easiest.
- Warm Home TBT measurably reduced on mid-range Android, verified with the URL-asserting cold+warm
  harness (`scripts/perf-baseline.js`).
- No regression in modal/sheet layering on checkout or auth.
- Documentation updated per [[PLATFORM_CONSTITUTION]].
