# Performance Measurement Standard

**Status:** Sprint 1A complete · 2026-08-01
**Tool:** `scripts/perf-probe.js` · **History:** `docs/perf-history.json`
**Rule:** a metric may gate a deploy only after it has demonstrated reliability *in that run*.

---

## Why this exists

The previous probe reported TBT of **538, 439, 1082, 920, 766 and 667 ms for the same page**. That
spread is wider than any optimisation could produce, so every "improvement" measured with it was
unfalsifiable. Optimising against it would have been guesswork with a number attached.

## What the variance actually was

Measured, not assumed:

| Condition | TBT median | range | **CV** |
|---|---|---|---|
| Production, unthrottled CPU | 769 ms | 356–1892 | **54.6%** |
| Production, CPU 4× pinned | 8069 ms | 6824–8780 | **9.9%** |

Host CPU contention was most of it. But pinning CPU alone was not enough:

| Samples (production, CPU pinned) | LCP CV | CLS CV | INP CV |
|---|---|---|---|
| 5 runs | 4.4% | 26.6% | 34.1% |
| 9 runs | **16.6%** | **30.4%** | **59.4%** |

**More samples made it worse.** That is the signature of drift, not sampling error — a longer run
spans more change in conditions nobody controls. No amount of averaging fixes a moving baseline.

Measuring production over the internet folds three variances together: the page's, the network's, and
the production server's. So the comparison instrument serves the working tree from **localhost** with
emulated network conditions and pinned CPU. What remains is the page's own behaviour — the only thing
an optimisation can change.

| Metric | CV production | CV local+pinned |
|---|---|---|
| CLS | 26.6% NOISY | **0.8%** |
| INP | 34.1% NOISY | **5.0%** |
| LCP | 16.6% INDICATIVE | **5.4%** |
| TBT | 15.2% INDICATIVE | **5.9%** |

Measuring the real production experience is a **different job** (field/RUM data). Conflating the two
is how a probe ends up unable to answer either.

---

## Reliability classification

Every metric is scored by coefficient of variation **across the runs of that invocation**:

| CV | Grade | Use |
|---|---|---|
| < 10% | **AUTHORITATIVE** | may fail a deploy gate |
| < 25% | **INDICATIVE** | report and track; never gate |
| ≥ 25% | **NOISY** | not reported as a result |

A metric is not trusted because it is convenient — it earns its grade each run. `--gate` skips
anything below AUTHORITATIVE, so a flaky metric can never block a deploy, and a gate that cries wolf
never gets disabled out of frustration.

### Reliability is not validity

The most important caveat in this document. While building the probe, the local server omitted
`Content-Length`, so every byte metric was counted as zero — reported with **CV 0%**, the strongest
possible reliability score, and completely wrong.

**A metric can be perfectly repeatable and still measure the wrong thing, and the CV cannot detect
it.** Reliability is necessary, not sufficient. Known validity limits:

- **`jsKB`/`totalKB` are UNCOMPRESSED** locally (~2.4 MB) vs gzipped in production (~1.5 MB). Use them
  as a ratchet on source size, not as transfer size.
- **`fsReads` counts Firestore channel opens**, not documents. The network layer cannot see document
  counts; calling it "reads" would overstate the precision.
- **Absolute timings are 4× slow** by design (CPU throttle). They compare; they do not predict.

---

## Fixed conditions

Changing any of these invalidates comparison with history, which is why every saved entry records
them:

| | |
|---|---|
| CPU | 4× throttle (mid-range Android) |
| Network | 10 Mbps down / 3 Mbps up / 40 ms latency |
| Viewport | 393 × 852, DPR 3, touch, mobile |
| Settle | 4000 ms after `load` |
| Source | local working tree (`PERF_BASE` overrides) |

## Budgets

| Metric | Target | Source |
|---|---|---|
| CLS | ≤ 0.10 | Core Web Vitals "good" |
| LCP | ≤ 2500 ms | Core Web Vitals "good" |
| INP | ≤ 200 ms | Core Web Vitals "good" |
| Longest task | ≤ 100 ms | no task > 100 ms where practical |
| JS payload | ratchet | seeded from baseline, not an invented round number |
| Firestore reads | ratchet | seeded from baseline |

Payload and read budgets are ratchets rather than fixed targets: **a budget nobody has ever met gets
ignored.** They fail only when a number rises above what has already been achieved.

---

## Usage

```bash
node scripts/perf-probe.js                       # 5 runs, all pages, saves history
node scripts/perf-probe.js --runs 7 --compare    # more samples + diff vs previous
node scripts/perf-probe.js --page home --gate    # fail on an AUTHORITATIVE breach
PERF_BASE=https://mysokoni.co.ke node scripts/perf-probe.js   # noisy production run
```

Authenticated pages need a session fixture:

```bash
PERF_USER=qa@… PERF_PASS='…' node scripts/perf-auth-fixture.js
PERF_AUTH_STATE=.perf-auth.json node scripts/perf-probe.js --page checkout
```

`.perf-auth.json` is a **live session** — gitignored, never committed, deleted after use. Without it,
checkout reports **BLOCKED**: never PASS, never FAIL. *A page that could not be measured is not a page
that is fast.*

---

## Between-run drift — why within-run CV is not enough

The CV classification above measures variance **between the samples of one invocation**. It is blind
to drift **between invocations**. Measured 2026-08-01 on **identical code**, five consecutive runs:

```
TBT   10642 -> 11579 -> 12438 -> 13087 -> 13115      (+23%)
```

Every one was AUTHORITATIVE at 5–9% CV internally. The host was simply getting slower — thermal
throttling and accumulated load.

**This caused a real mistake.** A layout fix that reduced `sokoni-layout.js` self-time by 34%
(3392 ms → 2237 ms, confirmed by CPU profile) was reverted because total TBT looked 9% worse — when the
baseline had moved further than the effect being measured. The revert was unsound; so was the verdict
that prompted it.

### The fix: `scripts/perf-ab.js`

Measure A and B **alternately inside one invocation** (A,B / B,A …). Drift applies to both arms
equally, so absolutes still wander but the **paired delta** stays valid.

```bash
node scripts/perf-ab.js --a HEAD --b working --pairs 6
node scripts/perf-ab.js --a HEAD --b HEAD              # null control
```

Two calibrations were needed to make even that trustworthy, both found by running the **null control**
(A and B pointing at identical trees):

1. **Balanced pair count.** An odd count leaves one arm measured first once more than the other.
   Pairs are now forced even.
2. **A discarded warm-up.** The first load of an invocation is the coldest, and whichever arm takes it
   is penalised. This alone produced a `4/4 consistent` 4.3% LCP difference between *identical* trees —
   a confident false positive. One throwaway load per arm absorbs it.

### Noise floor on this host (null control, calibrated)

| Metric | Floor |
|---|---|
| LCP / TBT / loadMs | **±5–9%** |
| worstTask | ±4% |
| CLS / longTasks | ±1.6% |

**Believe a timing result only if it exceeds ~10%, or wins in n/n pairs.** Re-run the null control
whenever the hardware or environment changes: the floor is a property of the machine, not of the tool.

### Practical consequence

The CPU profile (`scripts/perf-profile.js`) is the more reliable guide for this class of work, because
self-time attribution is not subject to this drift. Use the profile to choose *what* to change, and the
paired A/B to confirm the change was worth keeping.


---

## Baseline — 2026-08-01 (local, pinned, 5 runs)

| page | LCP | CLS | INP | longest task | tasks | JS (uncomp.) | fsReads |
|---|---|---|---|---|---|---|---|
| home | 6536 | **0.133** | 144 | 1356 | 36 | 2.4 MB | 4 |
| search | — | — | — | 1120 | 18 | 2.4 MB | 0 |
| category | 3568 | 0.002 | 64 | 804 | 24 | 2.5 MB | 2 |
| product | 2764 | 0.002 | 24 | 767 | 17 | 2.3 MB | 0 |
| checkout | BLOCKED — needs auth fixture | | | | | | |

### What this says about Sprint 1B

- **Homepage CLS is 0.133 and still over budget.** The pre-paint header reservation removed one shift;
  another remains. My earlier claim that CLS was "halved" was measured on the *noisy* instrument and
  should not be relied on — the mechanism was verified structurally, but the size of the win was not.
- **Every page exceeds the 100 ms longest-task budget by 7–13×** (767–1356 ms). This is the largest
  and most consistent finding, and the correct first target for Sprint 1B.
- **INP already passes** everywhere (24–144 ms).
- **JS is ~2.4 MB uncompressed on every page**, barely varying — evidence that the payload is a shared
  bundle problem, not a per-page one, so route-level splitting should pay off broadly.

Related: [[PLATFORM_CONSTITUTION]] · [[ADMIN_OS_CONVERGENCE]]

---

## Optimisation log

Every entry records the protocol outcome, including the rejections — a discarded
optimisation is evidence about where the cost *isn't*, and re-attempting it later is waste.

### 1. `sokoni-layout.js` ResizeObserver scope — **DISCARDED** (2026-08-01)

**Hypothesis.** `init()` observed `document.documentElement` *and* `document.body`, so every image
and lazy section that grew the page re-ran a full `_measure` — which both reads layout
(`getComputedStyle` on `:root`, several `offsetHeight`) and writes it (`_stackFabs` sets
`style.bottom`, `_applyZIndex` sets `z-index`). A measure/write loop during load. Nothing `_measure`
computes depends on document height, so the change narrowed observation to the registered chrome.

**Attribution:** confirmed. `sokoni-layout.js` self-time share fell 12.1% → 10.4%.

**Paired A/B (6 pairs, warm-up discarded):**

| metric | delta | consistency | verdict |
|---|---|---|---|
| tbt | −3.5% | 4/6 | below ±5–9% floor |
| lcp | −0.4% | 3/6 | noise |
| longTasks | −1.6% | 3/6 | at ±1.6% floor |
| worstTask | +5.5% | 2/6 | noise |

**Decision: discarded.** Nothing exceeded the noise floor and nothing won at n/n. The reasoning is
sound and the script really does get cheaper, but the whole-page effect is unmeasurable — so by
protocol rule 4 it is not retained.

**What this tells us.** Removing ~430 ms of self-time from the single largest actionable script moved
the page by less than the noise floor. That is strong evidence the startup cost is **not** concentrated
in any one module, and that micro-optimising individual functions will not pay. `(program)` — V8 parse
and compile — is 57–62% of sampled CPU, with ~2.4 MB of JavaScript shared across nearly every route.

**Therefore the next work should be structural, not local:** staged boot (critical → after-paint →
idle/interaction) and route-based bundle splitting, which attack parse/compile volume rather than
shaving execution inside already-loaded code.
---

## Sprint 2 correction — parse/compile is NOT the bottleneck

Sprint 1B closed with a hypothesis: `(program)` is 57–62% of sampled CPU, therefore V8 **parse and
compile** of ~2.4 MB of shared JavaScript dominates startup, therefore route-based bundle splitting is
the highest-value work.

**That hypothesis was wrong, and measuring it directly is what showed it.**

`(program)` in a V8 CPU profile is not compile time. It is everything without JS frames on the stack —
including the browser's own style and layout work. Reading it as "parse/compile" was an inference, not
a measurement.

`scripts/perf-profile.js` now reports Chrome's `Performance.getMetrics` directly:

| page | JS delivered | **V8 compile** | script execute | **layout** | **style recalc** | total task |
|---|---|---|---|---|---|---|
| home | 3080 KB / 89 files | **97 ms (2%)** | 4034 ms | **6950 ms** | **10547 ms** | 27461 ms |
| product | 2383 KB / 70 files | **75 ms (3%)** | 2331 ms | 1301 ms | 914 ms | 6525 ms |

Compile is **75–97 ms**. On the homepage, **style recalculation and layout are 64% of total task
time** — style recalc alone (10.5 s) is more than twice all JavaScript execution.

### What this changes

- **Route-based bundle splitting will not fix startup CPU.** Splitting 3 MB into route bundles saves
  roughly 97 ms of compile. It remains worth doing for network transfer, memory and cache efficiency —
  but it must not be sold as the startup-CPU fix, because it is not.
- **The homepage's real cost is CSS × DOM.** 10.5 s of style recalculation points at selector
  complexity multiplied by node count, and/or repeated forced synchronous layout. That is the target.
- **Product page is a different shape entirely** (execute 36%, style+layout 34%), so per-page
  attribution matters — a single platform-wide theory was always going to mislead.

### `sokoni-layout.js` — re-tested and still discarded

The earlier rejection was suspect: the A/B harness measured TBT/LCP/CLS only, none of which can see
browser layout work, so a change that reduces layout thrash could have been rejected on metrics blind
to its benefit. `layoutMs`/`styleMs` were added to `perf-ab.js` and the change re-tested:

| metric | delta | consistency | floor |
|---|---|---|---|
| layoutMs | −0.2% | 3/6 | ±2% |
| styleMs | −0.5% | 3/6 | ±2% |
| tbt | −0.7% | 4/6 | ±5–9% |

Nothing above the floor on the metrics that *could* have shown it. **Discard confirmed** — this time
without the "wrong instrument" caveat.

### Noise floor, extended

| Metric | Floor |
|---|---|
| layoutMs / styleMs | **±2%** ← tightest, best discriminators |
| scriptMs | ±3% |
| LCP / TBT / loadMs | ±5–9% |
| worstTask | **±30%** — effectively unusable as a single-run signal |
| compileMs | ±15% relative (tiny absolute: ~30 ms) |

`layoutMs` and `styleMs` should be the primary metrics for the next sprint, since they are both the
dominant cost and the most sensitive.

### Recommended Sprint 2 (revised)

1. **Style/layout attribution on the homepage** — which selectors and which DOM mutations drive
   10.5 s of recalculation. Chrome tracing (`disabled-by-default-devtools.timeline`) gives per-recalc
   attribution.
2. **Reduce forced synchronous layout** — read/write batching in the modules that measure and then
   immediately mutate.
3. **Bundle splitting** — retained, but re-scoped honestly to transfer/memory rather than startup CPU.

---

## Sprint 2 Phase 1 — Homepage style/layout attribution (deliverable)

Tool: `scripts/perf-render.js` · Data: `docs/perf-render-home.json` · 3 runs, CPU 4×, local tree.

### Stability first

| Aggregate | Median | CV | Grade |
|---|---|---|---|
| Style recalculation | **10133 ms** | **0.9%** | AUTHORITATIVE |
| Layout | **6289 ms** | **0.9%** | AUTHORITATIVE |

Runs: style `[10133, 10238, 10007]`, layout `[6394, 6263, 6289]`.

**Attribution is roughly an order of magnitude more stable than aggregate timing** (CV 0.9% vs the
±5–9% floor on LCP/TBT/loadMs). Decisions should be driven by attribution and confirmed by A/B — not
the reverse.

### Ranked: forced synchronous style/layout, by call site

Script wrote the DOM then immediately read geometry, forcing the browser to flush. **5310 ms across 12
call sites** — the actionable subset, because each has a named culprit and a known remedy.

| # | Call site | Cost | Calls | Share |
|---|---|---|---|---|
| 1 | `_measure @ sokoni-layout.js:151` | **1598 ms** | 12 | **30%** |
| 2 | `_update @ shared-header.js:2306` | 1003 ms | 2 | 19% |
| 3 | `(anon) @ sokoni-performance.js:125` | 995 ms | 14 | 19% |
| 4 | `publishHeaderHeight @ shared-header.js:2392` | 612 ms | 2 | 12% |
| 5 | `(anon) @ sokoni-layout.js:236` | 451 ms | 2 | 8% |
| 6 | `injectDesktopBellBadge @ sokoni-ui-extras.js:159` | 265 ms | 2 | 5% |
| 7 | `headerZ @ sokoni-sheet.js:339` | 192 ms | 4 | 4% |
| 8–12 | `promote`, `_bnavHeight`, `_writeSafeAreaVars`, recaptcha, `_showBanner` | 194 ms | 14 | 4% |

**Top 3 = 68% of all forced work.**

### Ranked: invalidation reasons

| Count | Reason | Node |
|---|---|---|
| 1512 | Added to layout | `#text` |
| 1139 | Related style rule | `SPAN` |
| 856 | Related style rule | `DIV` |
| 723 | Style changed | `#text` |
| **684** | **@keyframes rule change** | `A` |
| **578** | **Animation** | `::before` |
| **544** | **Animation** | `DIV.kebs-badge.kebs-unverified` |
| 473 | Style rule change | `SPAN` |
| **405** | **Animation** | `::after` |

**~2200 invalidations are animation-driven** — `@keyframes` on anchors, `::before`/`::after`
pseudo-elements, and one specific badge (`kebs-badge kebs-unverified`). Animating a property that is
not `transform`/`opacity` invalidates style on every frame, for every matching element.

### Worst individual events

Style recalcs and layouts of 418–794 ms each, one touching **3615 objects** with only 488 dirty —
a document-wide invalidation doing 7× more work than needed.

### What this corrects

The earlier `sokoni-layout.js` attempt targeted the **right function** (`_measure`, now confirmed as
the single largest forced-layout site at 30%) but the **wrong mechanism**: it narrowed the
ResizeObserver's scope, when the cost is the read/write interleaving *inside* `_measure` — it reads
`getComputedStyle` and `offsetHeight`, then writes `style.bottom` and `z-index`, then reads again.
Changing what triggers it does not stop the flush; batching the reads before the writes would.

That is Phase 2's first task, and it now has a specific, measurable target rather than a hypothesis.

### Recommended Phase 2 order (by evidence)

1. **`_measure` read/write batching** — 1598 ms, 30% of forced work, single function.
2. **`shared-header.js` `_update` + `publishHeaderHeight`** — 1615 ms combined, 31%.
3. **`sokoni-performance.js:125`** — 995 ms across 14 calls; a performance module that is itself the
   third-largest cost is worth deferring wholesale.
4. **Animation audit** — move `@keyframes` to `transform`/`opacity` only; `kebs-badge` is a named,
   contained starting point.

Each change goes through the A/B protocol against `layoutMs`/`styleMs` (±2% floor), which are both the
dominant cost and the most sensitive available metrics.

---

## Sprint 2 Phase 2 Task 1 — `_measure()` read/write restructure — **REJECTED**

**Target chosen on authoritative evidence:** `_measure @ sokoni-layout.js:151`, the largest forced
synchronous style/layout site on the homepage — 1598 ms across 12 invocations, 30% of all forced work,
attribution CV 0.9%.

### What was changed

1. **Strict read → mutate phases.** `_applyZIndex` was writing `style.zIndex` inside the read phase
   during bottom-nav auto-detection; deferred to a mutate phase. Verified: no layout read occurs after
   the first write.
2. **Dirty-checked custom-property writes.** `_propagate` wrote all ten `:root` custom properties on
   every pass regardless of change. Since `setProperty` on `:root` invalidates style for every element
   consuming the variable, twelve passes meant twelve document-wide invalidations, most of them
   writing an identical value.

The dirty-check was verified correct in isolation: identical values suppressed, changed values always
applied, final state always equal to the last attempted write.

### Paired A/B result (6 pairs, ±2% floor on style/layout)

| metric | delta | consistency | verdict |
|---|---|---|---|
| **styleMs** | **+10.4%** | 1/6 | **regression** |
| **layoutMs** | **+9.8%** | 2/6 | **regression** |
| tbt | +6.8% | 1/6 | regression |
| loadMs | +6.7% | 1/6 | regression |

Wrong direction, far outside the floor, consistent across pairs. **Rejected and reverted.**

### Why — and this is the durable lesson

`shared-header.js` **also writes `--sk-header-h`.**

The dirty-check assumes the writer owns the property. It does not. `sokoni-layout.js` caches "I wrote
110px", `shared-header.js` then writes a different value, and the cache is now stale: layout.js
believes the DOM already holds its value and stops correcting it. Elements settle at the wrong offsets
and generate *more* invalidation than the redundant writes ever cost.

This was not merely a failed optimisation — it was a **correctness bug**, and it happened to be
detectable only because style/layout were being measured directly. Against TBT alone it would have
looked like ordinary noise.

> **Rule: never dirty-check a shared CSS custom property.** Caching a write is only safe where
> ownership is exclusive. `--sk-header-h` has at least two writers, which also explains why it was
> observed changing 100px → 110px during load in the earlier CLS investigation.

### What remains viable

The two halves were tested together, which was a protocol error on my part — one isolated change, one
isolated measurement. The **read/write phase separation** (deferring `_applyZIndex`) is independently
correct, carries no ownership assumption, and is untested on its own. It remains a candidate and should
be measured alone.

The redundant-write problem is real but needs a different remedy: either establish exclusive ownership
of `--sk-header-h` (one writer, others read), or verify the live value with `getComputedStyle` before
skipping — which reintroduces a read and probably costs more than it saves.

**Recommended next target:** `shared-header.js` `_update` + `publishHeaderHeight` (1615 ms combined,
31% of forced work). The ownership conflict found here suggests these two modules are already fighting
over the same property, so consolidating that ownership may fix both the correctness hazard and a
share of the cost.

---

## Sprint 2 Phase 2 Task 2 — Remove ORPHAN properties — **REJECTED (performance)**

**Candidate.** Four `:root` custom properties written on every measurement pass and read by nobody:
`--sk-content-pad-bottom`, `--sk-keyboard-h`, `--sk-tab-bar-h`, `--sk-viewport-w`.

**Verification of "no readers"** — this was the entire safety argument, so it was attacked rather than
assumed. Across every `.js`/`.html`/`.css` file, the only mentions are this module's own writes, the
default declarations in `sokoni-tokens.css` (a default is not a reader), and documentation. No
dynamically-constructed `var(--sk-…)` references exist anywhere. Confirmed: zero consumers.

**Change.** Removed three of the four writes, cutting `_propagate` from 10 `setProperty` calls to 6.
`--sk-keyboard-h` was deliberately kept: it is written from the `visualViewport` handler on keyboard
open/close, not on every pass, so it carries no load-time cost and remains a useful hook.

**Paired A/B (6 pairs):**

| metric | delta | consistency | floor | verdict |
|---|---|---|---|---|
| styleMs | −0.6% | 3/6 | ±2% | below floor |
| layoutMs | −1.0% | 3/6 | ±2% | below floor |
| tbt | −1.8% | 5/6 | ±5–9% | below floor |

**Rejected and reverted.** No measurable benefit.

### The valuable part: the assumed mechanism was wrong

The hypothesis was that *every* `setProperty` on `:root` invalidates style for the whole document.
Removing 40% of those writes should then have been clearly visible. It was not — the effect is
indistinguishable from zero.

**Blink scopes custom-property invalidation to elements that actually reference the property.** A
variable with zero readers therefore costs approximately nothing to write. The write is wasteful in
the ordinary sense — dead code — but it is not a *style-invalidation* cost.

This also explains, retrospectively, why the earlier dirty-check idea was doubly wrong: it was not
merely unsafe (shared ownership), it was solving a problem that does not exist at the scale assumed.
The 10% regression it caused came entirely from the stale-cache correctness bug, not from any saving
it failed to deliver.

**Corrected model:** the cost of `:root` custom properties is proportional to the number of elements
that *consume* them, not the number of properties written. Optimising here means reducing consumers or
narrowing scope — not reducing writes.

### Note on scope discipline

These writes are genuinely dead and removing them is defensible on hygiene grounds. That is a
*different* justification from the one tested, and folding it in under a failed performance claim
would misrepresent the evidence. The revert stands; removing dead writes can be proposed separately
and judged on maintainability criteria, where it does not need to clear a performance floor.

---

## Sprint 2 Phase 2 Task 3 — `_measure()` read/write batching — **REJECTED (prediction validated)**

Category B (mechanism-backed): Chrome's trace attributed 1598 ms of forced synchronous style/layout
directly to `_measure`, so unlike the previous two experiments this rested on measurement, not
inference.

### A prediction registered before measuring

Static analysis of the call path found that the **only** write inside `_measure` (excluding
`_propagate`, which is already the terminal mutate step) is `_applyZIndex` in the bottom-nav
auto-detect branch. `_stackFabs` is not in this path. That branch is guarded by
`!_registry.bottomNav`, so it runs **at most once per page lifetime**.

**Prediction: no measurable effect.** Batching can remove at most *one* forced flush per page, not the
twelve the trace counts.

### Result

| metric | delta | consistency | floor | verdict |
|---|---|---|---|---|
| styleMs | −1.2% | 4/6 | ±2% | below floor |
| layoutMs | −0.2% | 4/6 | ±2% | below floor |
| tbt | −1.3% | 3/6 | ±5–9% | below floor |

**Prediction confirmed. Rejected and reverted.**

This is a materially stronger epistemic position than the previous two rejections: the null result was
*predicted in advance from a model*, rather than discovered and then explained.

### What the validated model now says

If within-function batching cannot help, and reducing invocation count cannot help (the
ResizeObserver experiment cut `_measure` self-time 34% with no whole-page effect), then the 1598 ms is
**not caused by `_measure` at all**.

`_measure` runs on `requestAnimationFrame`, so during load it is frequently the *first code to ask for
geometry* after other modules have mutated the DOM. The browser flushes at that moment, and the trace
charges the flush to whoever asked — not to whoever dirtied.

> **`_measure` is a victim of attribution, not a cause.** It pays for style and layout work that other
> modules made necessary.

That explains all three failures coherently: every attempt optimised the function being *charged*
rather than the code doing the *dirtying*.

### Consequence for the roadmap

Forced-layout attribution identifies **where the bill lands**, which is not the same as where the cost
originates. For a first-reader-after-mutation pattern, the actionable target is the **mutation
schedule**, not the reader.

This is an evidence-based argument for **staged boot** — and for the right reason this time. Not to
reduce parse/compile (measured at 97 ms, negligible), and not to spread execution, but to reduce *how
much DOM mutation happens during the load window at all*, so that the first reader has less to flush.

**Recommended next: Phase 4 staged boot**, with the hypothesis stated as: deferring non-critical DOM
construction out of the load window reduces the style/layout work that any subsequent reader must
flush. Validate on `styleMs`/`layoutMs` against the ±2% floor, as always.

Remaining forced-layout sites (`shared-header.js` `_update` 1003 ms, `sokoni-performance.js:125`
995 ms) should be re-profiled *after* staged boot, since they are likely subject to the same
attribution effect and may shrink or move without being touched.

