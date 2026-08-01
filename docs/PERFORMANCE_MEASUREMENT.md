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
