# RESOLVED — Homepage desktop scroll (closed by hardware observation 2026-08-26)

> ## 🟢 RESOLVED — the page scrolls on real hardware
> 
> The founder confirmed first-hand: **"HOME PAGE WORKS AND SCROLLS NOW."** A real person
> scrolling real hardware is the observation this track was explicitly held open for, and
> the docs own rule is that a hardware observation OVERRIDES a headless result.
> 
> **Corroborated in served bytes** (not just asserted): live `mysokoni.co.ke` at `3bb63bd` /
> v559 serves `sokoni-responsive.css` with the axis-split fix present —
> `overscroll-behavior-x: contain` and `overscroll-behavior-y: contain` as separate longhands,
> the broad `[class*="hscroll"]` shorthand that blocked vertical wheel chaining gone.
> 
> **Honest limits of this closure:**
> 1. The scroll owner was **never isolated in the test environment** — the failure never
>    reproduced headlessly at 1440/1280/1024. So this is closed by *behaviour no longer
>    failing on hardware*, NOT by a root cause proven in a rig. If it regresses, we do not
>    have a root-cause lock; re-open with `docs/homepage-scroll-probe.js` at the failing point.
> 2. The axis-split (`4bb9e4c`/v558) is the plausible fix and is confirmed live, but causation
>    was not isolated — the earlier note called it necessary-but-maybe-not-sufficient. The
>    hardware report now says the current live page scrolls; that is what closes it.
> 
> **No further `overscroll-behavior` changes** on the basis of the old observation — the old
> observation is resolved. This does not automatically close mobile/tablet physical scrolling
> unless a remaining acceptance criterion requires it separately.
> 
> Everything below is the preserved investigation history. Not deleted — a resolved record
> whose history is intact is worth more than one edited to look clean.

---
# OPEN — Homepage desktop scroll failure

**Status:** 🔴 **OPEN** — real desktop scroll failure.
The original `overscroll-behavior` defect is **confirmed and corrected**, but it is
**insufficient to explain the reported hardware behaviour.**

**Opened:** 2026-08-26
**Reported:** desktop `index.html` reaches the Sokoni Hubs / Tickys area and will not
continue scrolling to the footer, nor reliably back up.

---

## RETRACTED: the earlier PASS

An earlier result recorded index desktop scroll as **PASS at 1440 / 1280 / 1024**.

**That evidence is invalid and is withdrawn.** The measurement was taken on a page state
that does **not contain the section the report is about**. It is not a partial result — it
was the wrong page. A green run against a DOM missing the region under investigation proves
nothing about that region.

Real-hardware observation overrides a headless result. If the page will not scroll for a
person, it is not green.

---

## What IS established

### The overscroll defect was real — and its fix stays

`sokoni-responsive.css` applied `overscroll-behavior: contain` (**both axes**) via the broad
selector `[class*="hscroll"]`, in a rule sitting **outside every media query**. It matched
`.hubs-hscroll-wrap` / `.hubs-hscroll-section` — a 1709px region — so vertical wheel could not
chain to the document.

Confirmed by computed values before/after. The fix (splitting by axis intent) **remains in
place**: it was a genuine defect, and it additionally corrected a chat-list regression the
first version of the fix introduced.

**It is simply not the whole story.**

### Architectural lesson, kept

A rule living in a *responsive* stylesheet is not necessarily responsive-scoped. A broad
selector plus a shorthand property is how one rule silently reaches unrelated desktop
surfaces — and the same shorthand was wrong for two different interaction models in opposite
directions.

---

## What the diagnostics rule OUT

All four candidate causes came back negative in the test environment:

| Case | Finding |
|---|---|
| **A** document not scrollable | **No** — `scrollHeight` 10193 vs `clientHeight` 900; `html`/`body` `overflow-y: visible`; no `max-height`; `body` `position: static` |
| **B** wheel intercepted | **No** — document moved 1200px with the cursor over Hubs |
| **C** nested vertical scroller | **None exist** anywhere on the page |
| **D** JS preventing wheel/touch | **No** — 13 wheel/touch/scroll listeners, **0** non-passive, **0** calling `preventDefault()` or `stopPropagation()` |

`html` and `body` both compute `overscroll-behavior-y: auto`.

---

## Why the environment cannot settle it

**"Tickys" does not exist in `index.html`.** An initial grep reported 4 matches; those were
`s-ticky` inside `position: sticky`. Corrected.

The local environment **403s on App Check**, so data-driven sections never populate. Walking
the DOM downward from Hubs gives: `skh-section` (Car Hub), `qlinks-section`, Services,
Healthcare Hub, Earn Today, Featured Sellers — **no Tickys**.

So the region in the report either renders from data this environment cannot load, or is named
differently in source. **A scroll owner cannot be isolated in a section that is not on the
page under test.**

---

## Next step — one browser observation, not another automated probe

With the cursor directly over the point where scrolling stops:

```js
(() => {
  const x = innerWidth / 2, y = innerHeight / 2;
  let el = document.elementFromPoint(x, y);
  const out = [];
  while (el) {
    const s = getComputedStyle(el);
    out.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 120),
      overflowY: s.overflowY, overflow: s.overflow, position: s.position,
      height: s.height, maxHeight: s.maxHeight, overscrollY: s.overscrollBehaviorY });
    el = el.parentElement;
  }
  console.table(out);
})();
```

**And the one question that splits the problem:**

> Does scrolling stop at the same vertical position when the cursor is over ordinary
> blank/background space?

- **Yes** → page-level issue: layout height, or a fixed overlay covering the region.
- **No, only over Hubs/Tickys** → section/component-level interception.

Either answer chooses the next investigation without guessing.

---

## Explicitly NOT to be done

**Do not change `overscroll-behavior` again until the physical observation exists.** The
original shorthand was legitimately serving two different interaction models; iterating on it
until a hardware test happens to pass risks breaking chat/message scrolling to make the
homepage work.

The correct fix is whichever element is actually preventing the document from scrolling —
which is not yet identified.

---

## Scope

This is tracked **separately** from the admin certification programme. The 35/35 shell
controls, the denial invariant, and Platform navigation results say **nothing** about the
homepage scroll and must not be cited as if they did.

Production HOLD, staged Firestore indexes, the Kass end-to-end proof, and the real
admin/non-admin session gates are all unaffected and unchanged.

---

## LEAD KILLED (2026-08-26) — the `overflow: auto hidden` hypothesis is dead

The earlier lead proposed that `.hubs-hscroll-section` / `.hubs-hscroll-wrap` compute
`overflow-y: hidden`, and that **"with real data loaded the grid gains more children"**,
making `scrollHeight > clientHeight` so the wheel is swallowed.

**The premise is false.** The wrap is a **static grid of 24 `<a>` children** with inline
`display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px`, and
contains **no `<script>`, no `<template>`, and no injection site**. It never gains children
from data. Measured: section `scrollHeight 1708 / clientHeight 1708`; wrap `1618 / 1618`.
The containers cannot trap, here or in production.

This also **retires the "region not on the page under test" rationale for Hubs**: the Hubs
region renders identically in this environment and in production. (A separately-named
"Tickys" region still does not appear anywhere in source — `grep -i ticky` across all
HTML/JS/JSON returns nothing but `position: sticky`.)

**Do not act on the `overflow: auto hidden` rule.** Changing it now would be another
wrong-component fix.

---

## Real-input testing: no failure reproduces at 1440 / 1280 / 1024

Re-tested with `page.mouse.wheel()`, which dispatches through Chromium's real input
pipeline (CDP `Input.dispatchMouseEvent`) and therefore **does** honour `overscroll-behavior`
and scroll chaining — unlike a dispatched `WheelEvent`, which is why the earlier synthetic
result was correctly distrusted.

| Width | Wheel over Hubs | Wheel over background | Bottom |
|---|---|---|---|
| 1440 | +4000 | +4000 | reached, footer visible |
| 1280 | +4000 | +4000 | reached, footer visible |
| 1024 | +4000 | +4000 | reached, footer visible |

Identical movement over the carousel and over page background at every width.

### Three measurement artifacts found and corrected

Recorded because each one nearly became a false finding:

1. **`scroll-behavior: smooth` computes on both `html` and `body`.** `window.scrollTo()`
   therefore **animates**. Sampling `scrollY` 500 ms later caught it mid-flight and produced
   a false *"CANNOT reach bottom — y=5574 of 10447"*. Given 3 s it reaches the bottom.
   **Any future scroll test on this page must settle, not sleep.**
2. **A premature `settle()`** returned as soon as two samples matched — which happens
   *before* a smooth animation starts. A reset appeared complete when it had not begun, and
   a later probe measured **-1500** (scrolling *upward*). Now requires four consecutive equal
   samples plus a minimum elapsed time.
3. **`max` read after `y`.** The document grows ~243 px on first reaching the bottom (lazy
   content), so a single pass always lands "short by 243". A **uniform** 243 shortfall across
   three independent widths was an instrument signature, not three defects. Now confirmed
   over two passes.

---

## Status: still OPEN — the failure is not reproducible in this environment

The defect is real (reported on hardware) but does **not** reproduce headlessly at desktop
widths with real input events. The remaining difference between environments is data-driven
content this environment cannot load (App Check 403), **not** the Hubs region.

### The one observation that still decides it

Paste **`docs/homepage-scroll-probe.js`** into the browser console on the page where
scrolling actually fails, then:

1. cursor over Hubs/Tickys, scroll down
2. `__sokoniMark("over-hubs")`
3. cursor over ordinary background, scroll down
4. `__sokoniMark("over-background")`
5. try scrolling back UP
6. `__sokoniReport()`

It classifies the outcome itself and prints the ancestor chain, so the answer does not
depend on interpreting the symptom:

| Verdict | Meaning |
|---|---|
| **A** | component scroll ownership — names the element and class |
| **B** | document-level (`HTML`/`BODY` traps) |
| **C** | downward wheel STALLED with no trapping ancestor — page/layout or lazy content |
| **D** | scrolls down but will not scroll back up |
| **E** | a covering/capturing layer — names it |
| **INCONCLUSIVE** | did not reach the bottom, but the wheel never stalled — keep scrolling at the failing point |

#### The probe is validated, not just written

It was run against controls before being handed over, because a diagnostic that cannot
fail — or that cries defect on a healthy page — wastes the one reproduction we have:

| Control | Expected | Result |
|---|---|---|
| Healthy local page | must NOT claim a defect | **INCONCLUSIVE** |
| `html/body{overflow:hidden}` | document-level | **B** |
| Full-viewport fixed overlay z=100000 | covering layer | **E** |

Two defects in the probe were caught by those controls and fixed:

- It first reported *"stops 4682px short"* on a page that scrolls perfectly, because
  **"furthest reached" cannot distinguish "the user stopped scrolling" from "the page
  refused to scroll."** It now requires **dead downward wheel events** (input that produced
  no movement) before claiming C.
- It called a trapping `<html>` *"component scroll ownership"*, which would have sent the
  fix to the wrong layer. `HTML`/`BODY` now classify as document-level.

**Reminder carried in the probe output:** `scroll-behavior: smooth` is active on this page,
so readings must be taken after motion STOPS, never on a fixed delay. That artifact already
produced one false "cannot reach bottom".

**No CSS has been changed.** Nothing is modified until this observation names the scroll owner.
