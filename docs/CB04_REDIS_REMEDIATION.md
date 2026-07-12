# CB-04 — Redis Remediation Plan

**Owner:** Platform / SRE · **Status:** PLAN READY — not implemented · **Last updated:** 2026-07-12
**Scope discipline:** touches only Redis wiring. **No unrelated module is modified.**

---

## ⚠️ Severity correction (evidence-driven)

My previous report implied six *functions* were broken. That was **wrong**, and the correction **lowers** the severity.

**`vpcConnector` is a per-FUNCTION option.** Three of the six "consumers" export **zero functions** — they are **libraries**:

| Module | Exported functions | Reality |
|---|---:|---|
| `redis-jobs.js` | **0** | Library (Cache/Queue services) |
| `async-job-handlers.js` | **0** | Library |
| `release-readiness.js` | **0** | Library / diagnostic |

**A library cannot carry a connector.** The connector belongs to whichever *deployed function* calls it. So the real remediation surface is only:

| Module | Deployed fns | Redis use |
|---|---:|---|
| **`index.js`** | **86** | `checkRateLimit`, `redis-layer` (cache) |
| **`pos-peripherals.js`** | **7** | `checkRateLimit` |
| `reliability-engine.js` | 9 | No confirmed Redis call path |

### Nothing is broken. It is degraded.
- **Rate limiting** — `redis-rate-limiter.js:195` **deliberately** falls back to **Firestore** for security-sensitive actions and returns `{fallback:true}`. **Security is intact.**
- **Caching** — returns `null`, reads fall through to Firestore. **Correct, but slower and more expensive.**
- **Queue** — `redis-jobs.js` has **0 deployed functions**, so there is no deployed queue worker. **Nothing is silently failing to drain.**

**Revised classification: CB-04 is a COST + OBSERVABILITY issue, not a correctness or security failure.**

---

## Per-module plan

### M1 · `index.js` — 86 deployed functions
| | |
|---|---|
| **Purpose** | Core platform CFs (auth, orders, payments, KASS, admin) |
| **Redis use** | `checkRateLimit` (security) + `redis-layer` cache |
| **Traffic** | **Highest on the platform** |
| **Impact without Redis** | Rate limiting → Firestore fallback (**works**). Cache → **off** ⇒ extra Firestore reads on every cached path |
| **Connector required?** | ⚠️ **MEASURE FIRST — do not attach blindly.** Attaching to 86 functions adds connector throughput cost + cold-start latency to *every* one. It may cost **more** than the Firestore reads it saves |
| **Rollback** | Remove `vpcConnector` from the function options, redeploy. No data change |
| **Deployment plan** | **Pilot on 2–3 highest-read functions only.** Targeted deploy. Compare cost/latency for 48 h before any wider rollout |
| **Verification** | Real `SET`/`GET` round-trip from inside the function + cache-hit rate before/after |

### M2 · `pos-peripherals.js` — 7 deployed functions
| | |
|---|---|
| **Purpose** | POS peripheral operations |
| **Redis use** | `checkRateLimit` only |
| **Traffic** | Low–medium (POS devices) |
| **Impact without Redis** | Rate limiting via Firestore fallback — **functional** |
| **Connector required?** | ❌ **NO.** Small surface, security preserved by the Firestore fallback. Connector cost is not justified |
| **Rollback** | n/a (no change) |
| **Deployment plan** | **No change.** Record the decision |
| **Verification** | Confirm `{fallback:true}` appears in logs (proves the fallback path is exercised and *visible*) |

### M3 · `reliability-engine.js` — 9 deployed functions
| | |
|---|---|
| **Purpose** | Reliability / health |
| **Redis use** | **No confirmed call path** — flagged by a filename match only |
| **Connector required?** | ❌ **NO** — pending a 5-minute confirmation that no Redis call exists |
| **Deployment plan** | **No change** |

### M4–M6 · `redis-jobs.js` · `async-job-handlers.js` · `release-readiness.js`
| | |
|---|---|
| **Purpose** | Libraries (Cache/Queue services, diagnostics) |
| **Deployed functions** | **0** |
| **Connector required?** | ❌ **NOT APPLICABLE** — a library cannot declare `vpcConnector` |
| **Action** | **None.** The connector belongs to the calling function (M1/M2), not the library |
| **⚠️ Follow-up** | `redis-jobs.js` exposes a **QueueService with no deployed worker**. Confirm the queue is genuinely **UNUSED**. If any code enqueues jobs that nothing drains, that is a *separate* finding — raise it, do not fix it here |

---

## 🔴 THE ACTUAL CB-04 REQUIREMENT: kill the silent fallback

CB-04 says **"No silent fallback."** That is the part that is genuinely **unmet**, and it is **independent of any connector decision**.

`redis-service.js` latches `_fallback = true` and returns `null` **forever** with **no log and no alert**. Redis being *down* is therefore indistinguishable from Redis being *absent* — you cannot tell whether the cache is working.

### Fix (small, surgical, Redis-only)
1. In `redis-service.js`, when `_fallback` latches, emit a **structured error log once per instance**:
   ```js
   logger.error('[redis] FALLBACK LATCHED — Redis unreachable; cache disabled for this instance', {
     reason, url_host: <host only>, function: process.env.K_SERVICE,
   });
   ```
2. Add a Cloud Monitoring **log-based alert** on that signal → notification channel.
3. Expose `isFallback()` in the health endpoint so `release-readiness` reports Redis state truthfully.

**This is the highest-value CB-04 action and it does not require a single VPC connector.**

---

## Cache-hit rate reporting (as requested)

**Cannot be reported yet — and I will not invent numbers.**

- **Before:** cache-hit rate is **0%** in every non-connector function *by construction* (the client is `null`; no request ever reaches Redis). Not a measurement — a certainty.
- **After:** requires (a) the fallback instrumentation above, and (b) a hit/miss counter in `CacheService`.

**Sequence:** instrument → deploy → collect 48 h → *then* decide connectors on real numbers.

---

## Acceptance criteria for CB-04

- [ ] Fallback latch emits a structured log + alert fires (**no silent fallback**)
- [ ] `redis-jobs` QueueService confirmed **UNUSED**, or raised as a separate finding
- [ ] Cache hit/miss instrumented; **before/after** rates reported from real traffic
- [ ] Connector attached **only** where measurement justifies it (pilot first)
- [ ] Verified by a real `SET`/`GET` round-trip — **"no error" is NOT proof** (the fallback returns `null` without erroring)

## Effort
| Task | Effort |
|---|---|
| Fallback logging + alert (**the actual requirement**) | **1 h** |
| Confirm queue unused / `reliability-engine` no-Redis | **30 min** |
| Cache hit/miss instrumentation | **1 h** |
| Pilot connector on 2–3 functions + 48 h measurement | **1 h + wait** |

Related: [[INFRASTRUCTURE_REPORT]] · [[RELEASE_DASHBOARD]]
