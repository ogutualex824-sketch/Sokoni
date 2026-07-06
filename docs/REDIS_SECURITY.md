# SOKONI Redis Security Architecture

**Security Domain:** Section 8 — Redis Security  
**Version:** v2.0  
**Date:** 2026-07-07  
**Previous:** v1.0 (Security 6.0, 2026-06-28)  
**Score:** 8/10 — Grade B+  

---

## Overview

SOKONI uses Redis as a secondary, non-authoritative store. Firestore is always the source of truth. Redis provides: low-latency cache, session tracking, distributed locks, rate-limit counters, inventory reservation, the event bus, and the job queue.

All Redis access goes through `functions/redis-service.js`. No Cloud Function writes directly to Redis using raw `ioredis` calls — all writes go through the service layer which enforces the security controls below.

**v2.0 additions covered in this document:**
- Rate limiter middleware (`redis-rate-limiter.js`) — enforcement, fail-open, audit logging
- Offline queue (`sokoni-redis.js`) — storage strategy, what is and is not stored
- Queue worker job handlers (`redis-jobs.js`) — external API credential handling
- Firestore event triggers (`redis-integrations.js`) — safe failure guarantee

---

## 1. Transport Security

**TLS enforced when using `rediss://` (Redis SSL).**

The connection is established in `redis-service.js`:

```javascript
tls: url.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
```

- `rejectUnauthorized: true` — refuses connections with untrusted or expired TLS certificates.
- `REDIS_URL` is stored in Firebase Secret Manager (`functions:secrets:set REDIS_URL`).
- Never stored in source code, `.env` files checked into version control, or Cloud Logging.

**Production requirement:** `REDIS_URL` must use the `rediss://` scheme (TLS), not `redis://`. Enforced by deployment checklist in [[REDIS_ARCHITECTURE]].

---

## 2. Authentication

Redis is configured with an AUTH password at the managed Redis provider level (Redis Labs / Google Cloud Memorystore). The AUTH credential is embedded in the connection URL:

```
rediss://:PASSWORD@hostname:port
```

- Password is stored in Firebase Secret Manager as `REDIS_URL`.
- Never logged or exposed in Cloud Function output.
- The ioredis client sends AUTH automatically from the URL on each connection.
- Password rotation: update the secret, redeploy functions — no code change required.

---

## 3. Key Namespace Enforcement

All Redis keys must begin with the `sokoni:` namespace prefix. This is enforced at two levels:

**Level 1 — Construction:** The `_k(...parts)` helper in `redis-service.js` automatically prepends `sokoni:` when building keys.

**Level 2 — Write guard:** The `secureSet()` security-hardened write function validates:
1. Key starts with `sokoni:`
2. Key length ≤ 256 characters
3. Key does not match any DENIED_KEY_PATTERNS (see §5)

Any key failing validation is **rejected with a thrown error** — the write never reaches Redis.

**Full key schema:**

| Pattern | Purpose |
|---|---|
| `sokoni:cache:*` | Generic application cache |
| `sokoni:session:{uid}:{sid}` | Individual session data |
| `sokoni:sessions:{uid}` | SET of all session IDs for a user |
| `sokoni:lock:{resource}` | Distributed lock token |
| `sokoni:presence:{role}:{uid}` | Live presence record |
| `sokoni:presenceIdx:{role}` | SET of live UIDs per role |
| `sokoni:dashboard:{shopId}:{metric}` | Dashboard counter |
| `sokoni:payment:{orderId}` | Payment coordination state |
| `sokoni:pos:{shopId}:{terminalId}` | POS terminal state |
| `sokoni:pos:ch:{shopId}` | POS pub/sub channel |
| `sokoni:inv:lock:{productId}:{variantId}` | Inventory reservation |
| `sokoni:stream:{name}` | Redis Stream (event bus) |
| `sokoni:queue:{name}` | Job queue (Sorted Set) |
| `sokoni:rate:{action}:{identifier}` | Rate-limit counter |
| `sokoni:stats:*` | Internal operational counters |

---

## 4. TTL Enforcement

All cache entries have a mandatory TTL. Indefinite keys are blocked:

```javascript
// From secureSet() in redis-service.js
if (!ttlSeconds || ttlSeconds <= 0)
  throw new Error('[Redis Security] TTL is required — no indefinite cache entries');
if (ttlSeconds > 2_592_000)
  throw new Error('[Redis Security] TTL exceeds max: 30 days');
```

**TTL constants:**

| Key Type | TTL | Rationale |
|---|---|---|
| Presence | 90s | Must expire faster than 55s heartbeat; 35s grace |
| Session (default) | 24h | Standard web session |
| Session (remember me) | 30 days | Extended authenticated session (max allowed) |
| Search cache | 5 min | Fresh enough for UX; short enough for inventory accuracy |
| Dashboard counters | 60s | Soft real-time; Firestore is authoritative |
| AI responses | 1h | Expensive to generate; prompt drift unlikely in 1h |
| POS terminal state | 1h | One shift of inactivity |
| Payment coordination | 15 min | STK push/webhook window |
| Rate-limit (short) | 60s | Auth, OTP windows |
| Rate-limit (medium) | 15 min | Payments, checkout windows |
| Rate-limit (long) | 1h | AI, search windows |
| Job queue entries | No TTL (Sorted Set score) | Dequeued by worker; cleared naturally |
| Stream entries | MAXLEN ~10,000 (ring buffer) | Oldest events auto-trimmed |

---

## 5. Sensitive Pattern Blocklist

The `secureSet()` function blocks keys that match patterns associated with secrets:

```javascript
const DENIED_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /apikey/i,
  /token.*plain/i,
  /private_key/i,
];
```

Any attempt to store a key matching these patterns:
1. Is logged with `severity: WARNING` to Cloud Logging (key name only — not the value).
2. Throws an error — the write is aborted.
3. The attempted key name is included in the log for investigation.

**Principle:** No plaintext secrets are ever written to Redis. Session tokens stored in Redis are opaque session IDs — the raw credential (e.g. Firebase ID token) never touches Redis.

---

## 6. Value Size Guard

Oversized values can cause Redis memory exhaustion and latency spikes. `secureSet()` enforces:

```javascript
const MAX_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB
```

If a value exceeds 2 MB, the write is rejected. Callers must paginate or use Cloud Storage for large blobs (e.g. AI-generated documents, receipt PDFs).

---

## 7. PII Redaction Before Caching

AI responses and search results may reflect user-entered text containing PII. The `redactForCache()` function scrubs before caching:

| Pattern | Replacement |
|---|---|
| KRA PIN (`A` + 9 digits) | `[KRA-PIN]` |
| Kenyan phone (`+254`/`07xx`/`01xx xxxxxxxx`) | `[PHONE]` |
| Email address | `[EMAIL]` |
| Payment card (13–19 consecutive digits) | `[CARD]` |

This is applied in `redis-jobs.js` `handleAI()` before calling `CacheService.aiSet()`:

```javascript
const safe = redactForCache(aiResponse);
await CacheService.aiSet(promptHash, safe);
```

---

## 8. Session Security

Redis session records (`sokoni:session:{uid}:{sid}`) contain only:

| Field | Type | Notes |
|---|---|---|
| `uid` | Firebase UID | Opaque identifier, not personal data |
| `role` | string | `buyer`, `seller`, `cashier`, `admin`, etc. |
| `deviceInfo.ua` | truncated UA | First 200 chars only |
| `deviceInfo.platform` | string | `navigator.platform` |
| `createdAt` | Unix timestamp | — |
| `lastSeen` | Unix timestamp | — |

**Never stored in session:** name, phone, email, payment methods, KYC documents, raw ID token, passwords.

---

## 9. Rate Limiter Security (v2.0)

`functions/redis-rate-limiter.js` adds distributed rate limiting to Cloud Functions.

### Enforcement model

```
Request arrives
      │
      ▼
isFallback()? → YES → return { allowed: true, fallback: true } (fail open)
      │ NO
      ▼
RateLimitService.check(identifier, action, maxRequests, windowSeconds)
      │
      ├── allowed: true  → return { allowed, remaining }
      │
      └── allowed: false → log warning to Cloud Logging → throw HttpsError('resource-exhausted')
```

**Fail-open when Redis unavailable:** Rate limits are advisory — they protect against sustained abuse, not individual requests. Failing open during a Redis outage is safer than blocking legitimate users. Critical security limits (auth, OTP) have their own Firestore-based brute-force protection that operates independently of Redis.

### Identifier Selection

| Profile | Key By | Rationale |
|---|---|---|
| `auth`, `otp`, `search`, `webhook` | IP address | Unauthenticated endpoints; keying by UID would fail before auth |
| All others | Firebase UID | Post-auth endpoints; UID is more precise than IP (shared IP) |

IP is extracted with trust-chain priority: `x-forwarded-for → x-real-ip → connection.remoteAddress`. Only the first (leftmost) IP from `x-forwarded-for` is used — subsequent hops are untrusted.

### Audit Trail

On limit violation, Cloud Logging receives:
```json
{
  "severity": "WARNING",
  "message": "[rate-limiter] Limit exceeded",
  "action": "payment",
  "identifier": "uid_xyz",
  "count": 6,
  "maxRequests": 5,
  "windowSeconds": 60,
  "uid": "uid_xyz",
  "ip": "41.89.xx.xx"
}
```

These logs feed the rate-limit violations panel in `redis-monitor.html`.

### Currently Wired

| Function | Action | Limit |
|---|---|---|
| `posRegisterPeripheral` | `pos` | 600/min per UID |
| `posUpdateCustomerDisplay` | `pos` | 600/min per UID |

---

## 10. Offline Queue Security (v2.0)

`SokoniRedis.offline` (client SDK) stores unsynced operations in IndexedDB when the device is offline.

### What Is Stored

| Field | Stored in IndexedDB? |
|---|---|
| `type` (e.g. `pos_cart_sync`) | Yes |
| Cart items (product IDs, quantities, prices) | Yes |
| `shopId`, `terminalId` | Yes |
| Order totals | Yes |

### What Is Never Stored

| Data | Reason |
|---|---|
| Payment card numbers | PCI DSS — never on client storage |
| M-Pesa PIN | Never leaves IntaSend SDK |
| Customer phone (full) | Partial only (last 4 digits for receipt) |
| Firebase ID token | Not needed for offline sync |
| Session credentials | Session lives in sessionStorage/Redis, not IDB |

### localStorage Fallback

If IndexedDB is unavailable, a ring buffer of up to 100 items is stored in localStorage. The ring buffer contains the same non-sensitive operational data. It is cleared when items are flushed.

### Replay Integrity

Offline queue items are replayed via the same authenticated CF calls as live operations. Redis CF calls require a valid Firebase ID token — offline-queued items do not bypass authentication.

---

## 11. Queue Worker Security (v2.0)

`functions/redis-jobs.js` dispatches jobs to external APIs (SendGrid, FCM, Africa's Talking, Anthropic). Security controls:

| Control | Implementation |
|---|---|
| API credentials | All in Firebase Secret Manager (`SENDGRID_API_KEY`, `AT_API_KEY`, `AT_USERNAME`, `ANTHROPIC_API_KEY`) |
| Input validation | Each handler validates required fields before calling external API |
| Max recipients (SMS) | Hard cap: 20 recipients per SMS job to prevent bulk-send abuse |
| Max message length (SMS) | Hard cap: 918 chars (3 GSM segments) |
| AI PII redaction | `redactForCache()` applied before storing AI response |
| Dead-letter | Failed jobs written to Firestore `redisJobDeadLetter` — never silently discarded |
| Audit log | All processed jobs written to `redisJobAudit` (Firestore) |
| External API errors | Non-2xx responses are logged with severity ERROR; no stack trace in the log (no secret leakage) |

---

## 12. Event Trigger Security (v2.0)

`functions/redis-integrations.js` runs as Firestore triggers — not callable by external parties.

**Safe failure guarantee:** Every handler is wrapped in `_safeRedis(name, fn)`:

```javascript
async function _safeRedis(name, fn) {
  try {
    await fn();
  } catch (err) {
    _log('ERROR', `Redis sync failed: ${name}`, { error: err.message });
    // Error is swallowed — Firestore write succeeds regardless
  }
}
```

This means a Redis security error (e.g. blocked key write, TTL missing) will never roll back a Firestore write. The trigger is "fire and forget" — Redis is updated opportunistically.

Trigger functions cannot be called by external clients (they are `onDocumentCreated`/`onDocumentUpdated`, not `onCall`).

---

## 13. No Sensitive Data in Redis — Comprehensive List

The following data types are **never** stored in Redis under any circumstance:

| Data Type | Lives In |
|---|---|
| Orders | Firestore `orders` |
| Payment records | Firestore `payments` |
| Inventory counts (authoritative) | Firestore `products` |
| Customer names, phones, emails | Firestore `users` |
| Seller profiles / KYC docs | Firestore `users` / Cloud Storage |
| Financial records / ledger | Firestore `ledger` |
| Audit logs | Firestore `securityAuditLog` |
| Firebase ID tokens | Never persisted (memory only) |
| M-Pesa credentials | Firebase Secret Manager |
| Payment card numbers | Never on server (tokenised by IntaSend) |
| Passwords | Firebase Auth (not visible to platform) |

---

## 14. Failover Safety

When Redis is unavailable, `isFallback()` returns `true` and every service function silently returns a safe default:

| Service | Fallback Behaviour |
|---|---|
| CacheService | Cache miss → Firestore read |
| SessionService | `null` → caller re-authenticates |
| RateLimitService | `{ allowed: true }` — fail open |
| LockService | `false` → caller uses optimistic Firestore transaction |
| PresenceService | Returns empty list — all users appear offline |
| PaymentService | `null` state — payment orchestrator uses own Firestore FSM |
| QueueService | `push` logs error and returns `{ fallback: true }` — job is not enqueued |

**Implication for queuing:** If Redis is down, jobs pushed via `QueueService.push` are silently dropped. Callers that must guarantee delivery should write directly to Firestore (e.g. `redisJobDeadLetter` or a dedicated collection) when `fallback: true` is returned.

---

## 15. Known Gaps and Roadmap

| Gap | Severity | Mitigation | Roadmap |
|---|---|---|---|
| No at-rest encryption at the application layer | Medium | TLS in transit; Redis provider may offer at-rest encryption (Upstash: AES-256, Memorystore: CMEK) | v3.0 — evaluate provider-side CMEK |
| Redis audit access not wired into `securityAuditLog` | Low | Cloud Logging captures all CF invocations; rate-limiter logs violations explicitly | v3.0 — async audit write from `secureSet()` for critical namespaces (session, payment) |
| `secureSet()` not applied to all write paths | Low | All writes use TTL; key namespace enforced by `_k()` helper on all paths | v3.0 — migrate remaining direct `SET` calls |
| No per-namespace Redis ACL | Low | Single AUTH credential; Upstash namespace isolation equivalent; all writes validated by service layer | v3.0 — evaluate Redis ACL if multi-tenant isolation becomes a requirement |
| QueueService silently drops jobs when Redis is down | Medium | Callers can check `fallback: true` and write to Firestore; dead-letter documents guarantee visibility | v3.0 — automatic Firestore fallback queue when Redis is unavailable |
| Rate limiter wired to 2/30+ CFs | Low | Payment orchestrator has own `_rateLimit`; remaining CFs have low abuse surface | Ongoing — wire `checkRateLimit` to high-value CFs as identified |

---

## 16. Security Checklist

- [x] TLS via `rediss://` with `rejectUnauthorized: true`
- [x] AUTH credential in Secret Manager (not source code)
- [x] All keys namespaced with `sokoni:` (enforced by `_assertSafeKey`)
- [x] All TTLs enforced via `secureSet()` — no indefinite cache entries
- [x] Sensitive key pattern blocklist (password, secret, apikey, token.*plain, private_key)
- [x] Max value size guard (2 MB)
- [x] PII redaction before caching AI responses (`redactForCache`)
- [x] No PII in session records (opaque refs + timestamps only)
- [x] Graceful fallback when Redis unavailable (`isFallback` pattern)
- [x] Rate limiter fails open — platform never blocked by Redis unavailability
- [x] Rate limit violations logged to Cloud Logging with action + identifier
- [x] Offline queue stores only non-sensitive operational data
- [x] Queue job handlers validate inputs before calling external APIs
- [x] External API credentials in Secret Manager (SENDGRID, AT, ANTHROPIC)
- [x] Dead-letter queue for failed jobs (Firestore `redisJobDeadLetter`)
- [x] Event triggers wrapped in `_safeRedis` — cannot break Firestore writes
- [ ] Application-layer audit log for Redis writes (roadmap v3.0)
- [ ] Per-namespace Redis ACL (roadmap v3.0)
- [ ] Automatic Firestore fallback for QueueService when Redis unavailable (roadmap v3.0)

---

*See [[REDIS_ARCHITECTURE]] [[Security Stack]] [[Session Security]] [[Platform Core]]*

*SOKONI AI Security Engineering Team — 2026-07-07*
