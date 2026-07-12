# SOKONI — Infrastructure Report (CB-01 · CB-04)

**Date:** 2026-07-12 · **Evidence-based. Nothing marked complete without verification.**

---

# ✅ CB-01 — Cloud Run / Deployment — **PASS**

| Metric | Value |
|---|---|
| Deployed Cloud Functions | **1,410** |
| Runtime-exported (`Object.keys(require('./index.js'))`) | **1,410** |
| **Orphans** (deployed, not in source) | **0** |
| **Undeployed** (in source, not deployed) | **0** |
| CI gate `deployment-integrity.js --ci` | ✅ **exit 0** |

### Deployed by trigger type (all 1,410 accounted for)

| Trigger type | Count |
|---|---|
| Callable | **982** |
| Scheduled | **158** |
| Firestore triggers | **231** (created 95 · updated 80 · deleted 49 · written 7) |
| HTTPS | **37** |
| Storage | **2** |
| **Total** | **1,410** ✅ |

**Dispatchers:** 13 domain dispatchers all deployed and exported.
**Deployment failures:** none. **Deployment count matches runtime exports exactly.**

### ⚠️ Capacity Watch (not a blocker)
**1,410 CFs vs a 1,350 soft budget**; Cloud Run ceiling ~1,500 → **headroom ≈ 90**. Architectural signal only; deployment safety is governed by the integrity gate, which passes. See `CAPACITY_WATCH.md`.

**CB-01 verdict: PASS.** Quota is sufficient; every function type is deployed; source and production are in exact sync.

---

# 🔴 CB-04 — Redis — **FINDING: 6 of 8 consumers cannot reach Redis**

## The evidence

**`REDIS_URL` resolves to a private RFC1918 address** → Memorystore is **VPC-only**. A Cloud Function **cannot** reach it without a **Serverless VPC Access connector**.

**Only 2 modules declare `vpcConnector: 'sokoni-redis-connector'`:**

| Module | Uses Redis | `vpcConnector` | Can reach Redis? |
|---|---|---|---|
| `redis-layer.js` | ✔ | ✅ | **YES** |
| `redis-integrations.js` | ✔ | ✅ | **YES** |
| `redis-jobs.js` | ✔ | ❌ | **NO** |
| `pos-peripherals.js` | ✔ (rate limiter) | ❌ | **NO** |
| `reliability-engine.js` | ✔ | ❌ | **NO** |
| `release-readiness.js` | ✔ | ❌ | **NO** |
| `async-job-handlers.js` | ✔ | ❌ | **NO** |
| `index.js` | ✔ | ❌ | **NO** |

## What happens instead (the fallback, verified)

`redis-service.js` latches a module-level `_fallback` flag:
```js
function _getClient() {
  if (_fallback) return null;                       // permanent for the instance
  const url = REDIS_URL.value();
  if (!url) { _fallback = true; return null; }
  ...
  retryStrategy(attempts) { if (attempts > 5) { _fallback = true; return null; } }
}
```
For a function with **no VPC connector**, the connection can **never** succeed → after 5 attempts `_fallback` latches **true for the life of the instance** → every subsequent Redis call returns `null`.

## Is it a *silent* fallback? — **Partly. This is better than feared.**

| Surface | Behaviour without Redis | Assessment |
|---|---|---|
| **Rate limiting** (`redis-rate-limiter.js:195`) | **Designed, explicit fallback.** Security-sensitive actions are enforced via **Firestore** instead; non-security high-volume actions pass through. Returns `{ fallback: true }`. | ✅ **Not silent.** Deliberate, documented, does **not** fail open on security actions. |
| **Low-level `RateLimitService`** (`redis-service.js:425`) | `if (!r) return { allowed: true, fallback: true }` — **fails OPEN**. | ⚠️ Safe **only** because callers use the wrapper. **Any direct caller of `RateLimitService` silently loses rate limiting.** |
| **Caching** | Returns `null` → every read falls through to **Firestore**. | 🔴 **Silent.** Correctness is unaffected, but **cost and latency are not** — the cache is simply off. |
| **Queue processing** (`redis-jobs.js`) | Redis unreachable. | 🔴 **Requires runtime verification** — a queue backed by an unreachable store may be non-functional, not merely degraded. |

## 💰 Billing impact (directly relevant to Billing Optimization)
With caching **off** in 6 modules, reads that should be served from Redis are hitting **Firestore** on every call. **This is real, ongoing, avoidable spend** — and it is invisible, because the fallback is silent.

## Classification (per CB-04)

| Class | Modules | Action |
|---|---|---|
| **REQUIRED** (must reach Redis to function) | `redis-jobs.js` (queue), `redis-layer.js` ✅, `redis-integrations.js` ✅ | Attach the connector to **`redis-jobs.js`**. Verify the queue actually drains. |
| **OPTIONAL** (degrades gracefully, but costs money) | `pos-peripherals.js`, `reliability-engine.js`, `index.js` (caching + rate limiting) | Attach the connector **only if** the cache-hit saving exceeds the connector's hourly cost. **Measure first.** |
| **UNUSED / diagnostic** | `release-readiness.js` (health reporting) | Leave as-is. Its Redis check will correctly report "unavailable". |

## Remediation (exact)
1. Add to the function options in **`redis-jobs.js`** (and any module classified REQUIRED):
   ```js
   vpcConnector: 'sokoni-redis-connector',
   vpcConnectorEgressSettings: 'PRIVATE_RANGES_ONLY',
   ```
2. **Deploy targeted**, then verify a real Redis round-trip (SET/GET) from that function — **do not accept "no error" as proof**, because the fallback returns `null` without erroring.
3. **Instrument the fallback.** A latched `_fallback` must emit a **structured log + alert**, otherwise Redis being down is indistinguishable from Redis being absent. **This is the core CB-04 requirement — "no silent fallback" — and it is currently unmet.**
4. Re-audit: assert every REQUIRED consumer has the connector.

## CB-04 verdict: 🔴 **NOT COMPLETE**
- ✅ Redis-enabled functions **audited** and classified Required / Optional / Unused.
- ✅ Rate limiting does **not** fail open on security actions (verified).
- 🔴 **6 of 8 consumers cannot reach Redis** — VPC connector missing.
- 🔴 **The fallback IS silent for caching** (no log, no alert) — CB-04 explicitly forbids this.
- ⏳ Rate limiting / caching / session / queue **not verified against a live Redis** — requires deploy + round-trip test.

---

## Effort estimate

| Task | Effort |
|---|---|
| Attach connector to REQUIRED modules + targeted deploy | **30 min** |
| Live Redis round-trip verification (SET/GET per module) | **30 min** |
| Add fallback logging + alert policy (kills the silent failure) | **1 h** |
| Measure cache-hit benefit vs connector cost for OPTIONAL modules | **2 h** |

Related: [[CAPACITY_WATCH]] · [[deployment-integrity-report]] · [[RELEASE_v1.0.0_STATUS]]
