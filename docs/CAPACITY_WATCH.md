# SOKONI — Capacity Watch (Cloud Functions / Cloud Run)

**Classification:** 🟡 **Architectural warning — NOT a deployment blocker.**
**Owner:** Platform / SRE · **Opened:** 2026-07-12 · **Review cadence:** monthly, and before any sprint that adds functions.

---

## Current position

| Metric | Value |
|---|---|
| **Canonical CF count** (runtime enumeration) | **1,410** |
| Soft budget (architectural warning) | **1,350** — ⚠️ exceeded by **60** |
| Hard budget (guard fails the build) | 1,480 — headroom **70** |
| Cloud Run service ceiling (observed) | ~1,500 — headroom **~90** |
| Region | `us-central1` (single-region) |
| Generation | Gen 2 (Cloud Run backed) — **1 function = 1 Cloud Run service** |

**Deployment safety is unaffected.** It is governed solely by `scripts/deployment-integrity.js`
(`deployed == runtime-exported`), which currently **PASSES** (1,410 == 1,410). Exceeding the soft
budget does **not** block a deploy and must not be reported as a deployment failure.

---

## Why this was invisible until now

The previous inventory used a **static regex** export scan, which reported **1,264** — comfortably
under the 1,350 soft budget. It could not see dynamically-generated exports (the `algoliaSync`,
`searchSync` and `ts_` trigger factories, ~147 functions).

**The same measurement error that invented 147 phantom orphans was also concealing a real capacity
signal.** Runtime enumeration is now canonical, and the true figure (1,410) is above budget.

> This is the value of the correction: we did not just remove a false blocker — we surfaced a true one.

---

## What to monitor

| Signal | Where | Trigger for action |
|---|---|---|
| **Cloud Run quota** (services per region) | GCP Console → IAM & Admin → Quotas → *Cloud Run Admin API* | Usage > 90% of limit |
| **Function growth rate** | `scripts/verify-architecture.js` (canonical count each CI run) | Any sprint adding > 20 net functions |
| **Regional limits** | Single-region (`us-central1`) — all eggs in one basket | Consider multi-region before ~1,450 |
| **Headroom** | `1500 − canonical count` | **< 50 → freeze new standalone functions** |
| **Hard budget** | `verify-architecture.js` fails at 1,480 | Build failure = consolidation is mandatory |

---

## Expansion headroom

At **~90 services** of headroom, roughly **4–5 more feature sprints** of the recent size can land
before the ceiling is reached. This is *not* urgent, but it *is* finite.

## Mitigations (in order of preference)

1. **Dispatcher consolidation** — the proven pattern here: N onCall ops → 1 Cloud Run service.
   13 domain dispatchers already exist. **Every new callable op should join an existing dispatcher
   rather than become a standalone function.** This is already the standing architectural rule.
2. **Retire genuinely-dead functions** — e.g. the 7 `obs*` callables (superseded by
   `platformInfraDispatch`) *once* invocation metrics prove they are unused. **They are currently
   `UNKNOWN` and must not be deleted.** Removing them would reclaim 7 services.
3. **Multi-region** — spread services across regions to escape the per-region ceiling. Larger change;
   consider only if 1 and 2 are exhausted.
4. **Raise the quota** — request a Cloud Run services-per-region increase from GCP.

---

## Policy

- ✅ Exceeding the **soft** budget → **Capacity Watch** (this document). Warn, track, plan. **Do not block deploys.**
- 🔴 Exceeding the **hard** budget (1,480) → guard **fails**; consolidation required before deploying.
- 📌 **Default for new work:** extend an existing domain dispatcher. Do **not** create standalone
  callables without an explicit architectural reason.

Related: [[deployment-safety-checklist]] · [[deployment-integrity-report]] · [[DISPATCHER_REGISTRY]]
