# SOKONI RC1 — Production Reports

**Date:** 2026-07-18 12:11 EAT · **Release ref:** `f8cfdcf` · **Target:** `https://mysokoni.co.ke`
**Method:** `scripts/rc1-production-verify.js --pin 104.21.51.71 --dns 8.8.8.8` — resolver-independent,
read-only, executed against live production.

**Overall: 40 PASS · 0 FAIL · 11 PENDING** *(re-verified 2026-07-18 after resolver convergence)*

## Status by area

| Area | Status |
|---|---|
| Infrastructure | **PASS** |
| Application | **PASS** |
| Security | **PASS** |
| Composite indexes | **PASS** |
| **DNS propagation** | **CONDITIONAL** — authoritative correct, public resolvers converged, some ISP caches stale until TTL expiry |

*The original run below recorded 39/1/11; the single FAIL was the intermittent stale answer from
8.8.8.8, which has since cleared. Both runs are retained as the evidence trail.*

| Area | PASS | FAIL | PENDING |
|---|---|---|---|
| Infrastructure | 12 | 1 | 0 |
| Authentication | 4 | 0 | 4 |
| Marketplace | 6 | 0 | 0 |
| Merchant | 9 | 0 | 0 |
| Security | 2 | 0 | 3 |
| Performance | 5 | 0 | 1 |
| Payments | 1 | 0 | 3 |

> **Evidence rule applied throughout.** PENDING means *not directly observed*. No PENDING item has
> been upgraded by inference. Absence of failure is not evidence of success.

---

# 1. Infrastructure Report

## Status: **OPERATIONAL** — one time-bounded external condition

### Verified

| Check | Evidence |
|---|---|
| DNS delegated to Cloudflare | `anuj.ns.cloudflare.com`, `nina.ns.cloudflare.com` authoritative |
| DNS resolves | `104.21.51.71`, `172.67.176.242` via 8.8.8.8 |
| TLS handshake | HTTP 200 |
| SSL — chain verifies | `Verify return code: 0 (ok)` |
| SSL — hostname matches | `CN=mysokoni.co.ke` |
| SSL — expiry | 66 days remaining |
| **SSL — issued to our infrastructure** | **Google Trust Services WE1** |
| **Origin is expected stack** | `server=cloudflare` → Firebase/GFE, HTTP 200 |
| www subdomain | HTTP 200 |
| `auth.mysokoni.co.ke` | HTTP 200 |
| HSTS | `max-age=15552000` |
| CSP present + allows auth domain | `frame-src` includes `auth.mysokoni.co.ke` |

### UPDATE 2026-07-18 — resolvers converged; suite now **40 PASS · 0 FAIL · 11 PENDING**

Re-verified after the legacy-origin redirect was deployed.

| Resolver | Answer | State |
|---|---|---|
| Cloudflare authoritative (`anuj`/`nina`) | `104.21.51.71` / `172.67.176.242` | ✅ correct |
| `1.1.1.1` | `104.21.51.71` | ✅ **converged** |
| `8.8.8.8` | `172.67.176.242` | ✅ **converged** (no longer intermittent) |
| Local ISP resolver | `217.20.124.84` | ⚠️ still stale |

The earlier intermittent FAIL on 8.8.8.8 has cleared. Remaining stale resolution is confined to
individual ISP recursive caches and will expire with their TTLs.

**DNS Propagation status: CONDITIONAL.** Authoritative DNS is correct; major public recursive
resolvers have converged; a small number of ISP caches may temporarily continue serving the stale
record until TTL expiry. This is an **external cache-propagation condition, not an infrastructure
misconfiguration** — the Cloudflare zone contains no record for `217.20.124.84`.

### Legacy-origin redirect — retained as best-effort HTTP fallback only

A permanent redirect was deployed on the legacy LiteSpeed host
(`public_html/.htaccess` → `https://mysokoni.co.ke/$1`). Measured behaviour:

| Request to `217.20.124.84` | Result |
|---|---|
| `http://mysokoni.co.ke/` | **301** → `https://mysokoni.co.ke/` ✅ |
| `http://mysokoni.co.ke/test` | **301** → `https://mysokoni.co.ke/test` ✅ (path preserved) |
| `https://mysokoni.co.ke/` | **404 LiteSpeed** ❌ |
| `https://mysokoni.co.ke/test` | **404 LiteSpeed** ❌ |

**It is explicitly NOT the primary mitigation, for two measured reasons:**

1. **Port 443 is unhandled.** The rule appears to exclude HTTPS to avoid an infinite loop —
   correct logic, since it targets `https://` on the same hostname — leaving HTTPS requests to 404.
2. **The redirect target is the same hostname.** Simulating a stale-resolver client with both
   ports pinned to the legacy IP produced: `http://` → 301 → `https://mysokoni.co.ke/` → **404**.
   The user is returned to a hostname their resolver still maps to the legacy origin.

**HSTS compounds this:** we serve `max-age=15552000`, so any returning visitor who has previously
loaded the site over HTTPS goes straight to 443 and never reaches the HTTP redirect at all.

**Decision on record:** a cross-hostname redirect (e.g. to `sokoni-aeb26.web.app`) was considered
and **rejected** — public resolvers have converged, the residual population is small and shrinking,
and pointing at a different hostname introduces avoidable risk to authentication, cookies and UX
for a condition that resolves itself. The `.htaccess` redirect is retained as a harmless
best-effort fallback for HTTP clients.

### Original finding — stale recursive DNS cache (not a configuration fault)

`dns.google` intermittently returns the legacy origin `217.20.124.84`. Repeated queries alternate
between Cloudflare IPs and the legacy address.

**Root cause established by authoritative query — the zone is clean:**

| Source | Answer |
|---|---|
| `anuj.ns.cloudflare.com` (authoritative) | `104.21.51.71` only |
| `nina.ns.cloudflare.com` (authoritative) | `172.67.176.242` only |
| `8.8.8.8` (recursive) | Cloudflare IPs **or** `217.20.124.84`, PoP-dependent |

`217.20.124.84` does not exist in the Cloudflare zone. The stale answers originate in Google
Public DNS PoPs that have not yet expired their pre-migration cache.

**Impact:** until those TTLs expire, a proportion of users will resolve to the decommissioned
LiteSpeed host and receive a 404. This is an **intermittent partial outage**, time-bounded and not
correctable from our side.

**Action: none.** Editing DNS would treat cache expiry as a configuration defect. Monitor only.

### Deployment state

Hosting, Cloud Functions and Firestore rules all deployed and serving. Service Worker live at
`sokoni-20260714-ios-safari-p0-v77`.

### Firestore indexes

**376 composite indexes live.** 21 deployed across three additive rounds (351 → 372 local).
Every round omitted `--force`; Firebase reported 4 deployed-only indexes plus 1 field override it
would delete with the flag and **skipped them each time** — nothing was dropped.

All I-1…I-4 pilot-critical shapes are served. Audit candidates **262 → 230**. READY confirmed via
Firebase Console.

---

# 2. Security Report

## Status: **SOUND** — no unresolved defects; runtime behaviour pending

### Verified in production

| Check | Evidence |
|---|---|
| HSTS | `max-age=15552000` |
| CSP | present, includes `auth.mysokoni.co.ke` in `frame-src` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `SAMEORIGIN` |
| TLS issuer | Google Trust Services (not a foreign origin) |

### Defects fixed and deployed this cycle

| Defect | Resolution |
|---|---|
| **Refund authorization** — `_assertAuth` checked authentication only; any authenticated user knowing a `saleId` could refund it | `_assertRefundAuthority`: manager/owner rank **and** merchant membership. IDOR closed |
| **Manager PIN client-forgeable** — verified against IndexedDB, so a cashier could approve their own refunds/voids | Server-first via `validateDeviceAccess`; high-risk ops refuse the offline fallback |
| **Cross-tenant wallet access** — `sellerId` accepted from the client | Server-derived from the auth token claim (`cbade53`) |
| **Refund non-idempotent** — random `refundId`, so a double-tap refunded twice | Deterministic id + in-transaction existence check |

### Audits completed

- **Authorization review** — 19 raw candidates → 5 → **0 confirmed vulnerabilities**. Two scanner
  corrections made before reporting (`_assertAdmin` unrecognised; no self-service concept).
  `_assertAdmin` re-checked against the historical async-bypass class: synchronous, throws
  directly, no bypass.
- **Transaction integrity** — 3 candidates → 2 confirmed (T-1, T-2), 1 false positive. Both
  formally deferred to Phase 1; neither is pilot-blocking.
- **Phantom Cloud Functions** — 24 broken by dispatcher consolidation, 54 deployment-blocked
  (quota), 5 genuinely dead.

### Documented intentional decisions

`deductWallet` has no manager gate while `topUpWallet` / `refundToWallet` do. Deliberate: deduction
is the checkout path a cashier must use; money-in and money-back are the risky directions. Recorded
in-code with the four safety conditions.

### PENDING — not observed

RBAC runtime enforcement · audit-log writes · secret scanning (covered by CI, not re-run here).
Each requires an authenticated production session.

---

# 3. Performance Report

## Status: **GOOD**

| Metric | Observed | Threshold |
|---|---|---|
| Landing page latency | **74–82 ms** | < 3000 ms |
| Landing page weight | **204 KB** | < 900 KB |
| Search | 660 ms · 53 KB | — |
| Checkout | 545 ms · 151 KB | — |
| Merchant dashboard | 947 ms | — |
| POS | 1015 ms | — |
| POS checkout | 544 ms | — |
| Accounting | 434 ms | — |
| Static asset caching | `public, max-age=3600, must-revalidate` | present |
| Service Worker | `v77`, serving | present |
| PWA manifest | HTTP 200 | present |

Cloudflare CDN fronting Firebase Hosting; landing page served in under 100 ms.

**Index impact:** the 21 new composite indexes remove `FAILED_PRECONDITION` from the wallet,
sales, accounting, reporting and incremental-sync paths. Those queries could not previously
execute at all.

**PENDING:** mobile responsiveness — requires a real viewport/device.

---

# 4. Production Readiness Report

## Verified by direct production evidence (PASS) — 39

**Infrastructure (12)** — DNS delegation · DNS resolution · TLS handshake · SSL chain · SSL
hostname · SSL expiry · **SSL issuer = Google Trust Services** · **origin = Firebase/GFE** ·
www subdomain · `auth.mysokoni.co.ke` reachable · HSTS · CSP incl. auth domain.

**Authentication (4)** — auth domain reachable · `authDomain` correctly configured · login page
serves · Google Sign-In control renders.

**Marketplace (6)** — landing · search · categories · product page · cart · checkout, all HTTP 200.

**Merchant (9)** — dashboard · POS · POS checkout · inventory · accounting · staff · reports ·
onboarding, all HTTP 200 · **accounting routed via `smartPosDispatch`** (retired callable names
absent, confirming fix `5773607` is live).

**Security (2)** — `X-Content-Type-Options: nosniff` · `X-Frame-Options: SAMEORIGIN`.

**Performance (5)** — Service Worker · PWA manifest · cache headers · latency · page weight.

**Payments (1)** — refund workflow server-side: authorization + idempotency + reads-before-writes,
12/12 on real Firestore.

**Firestore indexes** — 376 live; all I-1…I-4 shapes served; READY confirmed via Console.

## Awaiting interactive or hardware validation (PENDING) — 11

**None of these has been upgraded by inference.**

| # | Item | Why it cannot be claimed |
|---|---|---|
| 1 | Interactive Google Sign-In (desktop) | requires a real browser session |
| 2 | Google Sign-In — iPhone Safari | requires physical device |
| 3 | Google Sign-In — installed PWA | requires physical device |
| 4 | Session persistence / token refresh / logout | requires an authenticated session |
| 5 | RBAC runtime enforcement | server-side; needs an authenticated session |
| 6 | Audit-log writes | needs an authenticated transaction |
| 7 | Secret scanning of served JS | covered by the CI gate, not re-run here |
| 8 | Mobile responsiveness | requires a real viewport/device |
| 9 | Live M-PESA / IntaSend STK | requires a real low-value transaction |
| 10 | Receipt printing | requires physical hardware |
| 11 | Settlement received by merchant | manual payout for the pilot; `executeSettlement` intentionally unwired |

**Additionally not verified by execution:** the I-1…I-4 query paths. Index *presence* is confirmed
three independent ways (live listing, Console, audit resolution); query *execution* against
production was not possible from the engineering environment (`invalid_client` — no Admin
credentials). Recorded as **PENDING**, not PASS.

## Known limitations entering the pilot

- **DNS cache window** — intermittent 404s for users on resolvers still holding the stale record.
  Time-bounded; no action available.
- **Settlement is manual** — merchant paid manually against the settlement preview.
- **Staff invitations unavailable** — `wf*` functions blocked by the Cloud Run quota. Workaround:
  `createBusiness` seeds the owner directly; `setStaffPin` rides the deployed dispatcher.
- **T-1 / T-2** — confirmed transaction-ordering defects, formally deferred to Phase 1. Neither is
  on the pilot path (warehouse transfer, provider booking).
- **5 dead flows** — returns, pickup verification, rent payment, M-PESA fallback, legacy wizard.
- **230 non-pilot index candidates** — outside the trading path, unverified.

## Risk register — top items

| Risk | Sev | Mitigation |
|---|---|---|
| Google Sign-In fails on a real iOS device | **High** | config verified (same-site authDomain defeats ITP; popup/redirect logic sound); requires physical test |
| DNS cache window causes intermittent 404s | Medium | time-bounded; monitor; no action |
| Live M-PESA behaves differently than expected | Medium | verify with one real low-value transaction before merchant trades |
| Reporting query fails on an unindexed shape | Low | all pilot-critical shapes served; 230 non-pilot candidates remain |

## Recommendation: **CONDITIONAL GO**

Every layer that can be verified from the engineering environment is verified by direct production
evidence: infrastructure, DNS, TLS **including issuer**, serving infrastructure, application
availability, security headers, performance, and Firestore index readiness. The merchant trading
path — onboarding, catalogue, wallet, checkout, refund, accounting — is deployed, index-backed and
server-side verified.

**Go is not claimable** because 11 checkpoints require a browser session, physical hardware, or a
real transaction. Under the standing rule, they remain PENDING.

**Conditions to satisfy before the first merchant trades:**

1. **Interactive Google Sign-In on a real device** (iPhone Safari + installed PWA at minimum) —
   the highest-severity open risk; login is the entry point to everything.
2. **One live low-value M-PESA transaction** end to end, confirming payment, receipt and ledger.
3. **One physical receipt print** on the merchant's actual hardware.
4. **Exercise the I-1…I-4 paths** with a real merchant account — confirms the indexes serve real
   queries, which could not be proven from the engineering environment.

**Conditions to satisfy before broader rollout:**

5. **DNS cache window fully expired** — no recursive resolver returning `217.20.124.84`.
   *Status 2026-07-18: authoritative correct; `1.1.1.1` and `8.8.8.8` converged; residual limited
   to individual ISP caches. Monitor only — make no further infrastructure change unless the
   condition persists beyond the expected DNS cache lifetime, which would indicate a genuine
   misconfiguration rather than propagation.*
6. Cloud Run quota granted, restoring staff invitations (`wf*`).
7. Settlement automated, or manual payout formally operationalised with an owner.

**Not blocking:** T-1/T-2, the 5 dead flows, and the 230 non-pilot index candidates — all
documented, none on the pilot trading path.

---

*All findings derive from observed production behaviour. Nothing is inferred. Items lacking direct
evidence are marked PENDING and are named explicitly above.*
