# SOKONI Redis Security Architecture

**Security Domain:** Section 8 — Redis Security
**Version:** Security 6.0
**Date:** 2026-06-28
**Score:** 7/10 — Grade B

---

## Overview

SOKONI uses Redis as a secondary, non-authoritative store. Firestore is always the source of truth. Redis provides: low-latency cache, session tracking, distributed locks, rate-limit counters, inventory reservation, and the event bus.

All Redis access goes through `functions/redis-service.js`. No Cloud Function writes directly to Redis using raw `ioredis` calls — all go through the service layer which enforces the security controls below.

---

## 1. Transport Security

**TLS enforced when using `rediss://` (Redis SSL).**

The connection is established in `redis-service.js`:

```js
tls: url.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
```

- `rejectUnauthorized: true` — refuses connections with untrusted or expired TLS certificates.
- `REDIS_URL` is stored in Firebase Secret Manager and injected via `functions/.env` at deploy time.
- Never stored in source code.

**Requirement for production:** `REDIS_URL` must use the `rediss://` scheme (TLS) rather than `redis://`. This is enforced by deployment checklist.

---

## 2. Authentication

Redis is configured with AUTH password at the managed Redis provider level (Redis Labs / Upstash / Cloud Memorystore). The AUTH credential is embedded in the connection URL:

```
rediss://:PASSWORD@hostname:port
```

- Password is stored in Firebase Secret Manager as `REDIS_URL`.
- Never logged or exposed in Cloud Function output.
- The ioredis client sends AUTH automatically from the URL.

---

## 3. Key Namespace Enforcement

All Redis keys must begin with the `sokoni:` namespace prefix. This is enforced by:

1. The `_k(...parts)` helper in `redis-service.js` which automatically prepends `sokoni:`.
2. The `secureSet()` security-hardened write function (Security 6.0) which validates that the key starts with `sokoni:` before writing.

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

Keys not matching this schema are rejected by the `_assertSafeKey()` function before writing.

---

## 4. TTL Enforcement (No Unlimited Cache)

All cache entries have a mandatory TTL. Indefinite keys are blocked:

```js
// Security 6.0: TTL required; max 30 days
if (!ttlSeconds || ttlSeconds <= 0) throw new Error('[Redis Security] TTL is required');
if (ttlSeconds > 2_592_000) throw new Error('[Redis Security] TTL exceeds max: 30 days');
```

**TTL constants (from `redis-service.js`):**

| Key Type | TTL | Rationale |
|---|---|---|
| Presence | 90s | Must expire faster than 60s heartbeat; 30s grace |
| Session (default) | 24h | Standard session lifetime |
| Session (remember me) | 30 days | Extended authenticated session |
| Search cache | 5 min | Fresh enough for UX; short enough for inventory accuracy |
| Dashboard counters | 60s | Soft real-time; Firestore authoritative |
| AI responses | 1h | Expensive to generate; stable prompt → stable response |
| POS terminal state | 1h | One shift of inactivity |
| Payment coordination | 15 min | STK push/webhook window |
| Rate-limit (short) | 60s | Auth, OTP |
| Rate-limit (medium) | 15 min | Payments, checkout |
| Rate-limit (long) | 1h | AI, search |

---

## 5. Sensitive Pattern Blocklist

The `secureSet()` function blocks keys that match patterns associated with secrets:

```js
const DENIED_KEY_PATTERNS = [
  /password/i, /secret/i, /apikey/i, /token.*plain/i, /private_key/i,
];
```

Any attempt to store a key matching these patterns:
1. Is logged with severity `WARNING` to Cloud Logging.
2. Throws an error — the write is aborted.
3. The attempted key name is included in the log (not the value).

**Design principle:** No plaintext secrets are ever written to Redis. Tokens in cache (e.g., session IDs) are always opaque references — the actual session data lives in Firestore.

---

## 6. Value Size Guard

Oversized values can cause Redis memory exhaustion. The `secureSet()` function enforces:

```js
const MAX_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB
```

If a value exceeds 2 MB, the write is rejected with an error. Callers must paginate or use Cloud Storage for large blobs.

---

## 7. PII Redaction Before Caching

AI responses and search results may reflect user-entered text containing PII. The `redactForCache()` function (Security 6.0) scrubs before caching:

| Pattern | Replacement |
|---|---|
| KRA PIN (`Axxxxxxxxx`) | `[KRA-PIN]` |
| Kenyan phone (`+254/07xx xxxxxxxx`) | `[PHONE]` |
| Email address | `[EMAIL]` |
| Payment card (13–19 digits) | `[CARD]` |

Usage:
```js
const { redactForCache } = require('./redis-service');
const safeResponse = redactForCache(aiOutput);
await secureSet(_k('cache', 'ai', hash), safeResponse, TTL.AI);
```

---

## 8. No PII in Session Data

Redis session tokens store only the session ID reference (`sokoni:session:{uid}:{sid}`). The session record in Redis contains:

- `uid` — Firebase UID (not PII; an opaque identifier)
- `role` — numeric role level (0–5)
- `deviceId` — SHA-256 hash of device fingerprint (not raw fingerprint)
- `createdAt`, `lastSeen` — Unix timestamps
- `ipHash` — SHA-256 of the client IP (not plaintext IP)

Sensitive data (name, phone, email, payment methods, KYC docs) is never written to Redis.

---

## 9. Fallback Safety

When Redis is unavailable, all service functions silently return safe defaults:

- Cache misses → Firestore read (slower but authoritative)
- Rate-limit checks → fail open (allow request; log miss)
- Distributed locks → optimistic Firestore transaction
- Presence → degrade gracefully (show as offline)

This is enforced by `isFallback()` checks at the top of every service method. The Cloud Function caller never sees a Redis connection error — only a slower response.

---

## 10. Audit Access to Redis

Redis access is not currently integrated with `securityAuditLog` (Security 6.0 gap — Section 8 Grade B vs A). The mitigation:

1. All writes go through `redis-service.js` methods — there is one chokepoint to add audit logging.
2. Redis provider (Upstash/Redis Labs) logs all commands at the infrastructure level.
3. Suspicious patterns (unusual key access) trigger security alerts at the Redis provider dashboard.

**Roadmap (v7.0):** Add async audit logging to `secureSet()` for critical key namespaces (session, payment, rate).

---

## 11. Known Gaps

| Gap | Severity | Mitigation |
|---|---|---|
| No at-rest encryption at the application layer | Medium | TLS in transit; Redis provider may offer at-rest encryption (Upstash: AES-256) |
| Redis audit access not in `securityAuditLog` | Low | Provider-level logging; one chokepoint in `redis-service.js` |
| `secureSet()` not yet used for all write paths | Low | Existing writes use TTL; key namespace enforced by `_k()` helper |
| No Redis ACL per data type | Low | Single AUTH credential; Upstash namespace isolation equivalent |

---

## 12. Security Checklist

- [x] TLS via `rediss://` with `rejectUnauthorized: true`
- [x] AUTH credential in Secret Manager (not source code)
- [x] All keys namespaced with `sokoni:`
- [x] All TTLs enforced (no indefinite cache entries)
- [x] Sensitive key pattern blocklist (`secureSet`)
- [x] Max value size guard (2 MB)
- [x] PII redaction before caching AI responses
- [x] No PII in session records (opaque refs only)
- [x] Graceful fallback when Redis unavailable
- [ ] Application-layer audit log for Redis writes (roadmap v7.0)
- [ ] Per-namespace Redis ACL (roadmap v7.0)

---

*See [[Security]] [[Redis Infrastructure Layer v1.0]] [[Session Security]] [[Platform Core]]*

*SOKONI AI Security Engineering Team — 2026-06-28*
