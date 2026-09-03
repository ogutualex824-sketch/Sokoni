# Loyalty `verified`/`isVerified` gate — read-only trace and design

**Status:** 📋 READ-ONLY TRACE + DESIGN QUESTIONS. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · **Headline: no merchant can ever satisfy this gate — not usually, structurally.**
Neither the field it checks, nor the "correct" per-identity verification field, is ever written by
any code path in this repository.

---

## The complete chain

```
merchant lookup                 db.collection('merchants').doc(merchantId).get()
        ↓                       (functions/loyalty-enterprise.js:1185)
verified/isVerified condition   if (!merchant.verified && !merchant.isVerified) throw
        ↓                       (line 1188 — the exact line named)
allow / deny                    failed-precondition, "Merchant must be verified to join
        ↓                        loyalty network" (line 1189)
callers / UI                    loyalty-merchant.html:1007 — _call('joinLoyaltyNetwork', {...}),
        ↓                       routed through the real loyaltyDispatch CF (confirmed: line 640's
        ↓                       own comment, "All loyalty ops route through the single
        ↓                       loyaltyDispatch CF"). loyalty-merchant.html IS linked from real
        ↓                       navigation — sokoni-nav-engine.js:250, seller role, "🎁 Loyalty".
        ↓                       Not an orphan page.
whether any legitimate          NO. Not "rarely" - structurally never, established below.
merchant can satisfy it
```

## The exact gate

`functions/loyalty-enterprise.js:1180-1190`, `exports.joinLoyaltyNetwork`:

```js
const merchantSnap = await db.collection('merchants').doc(merchantId).get();
if (!merchantSnap.exists) throw new HttpsError('not-found', 'Merchant not found');
const merchant = merchantSnap.data();
if (!merchant.verified && !merchant.isVerified) {
  throw new HttpsError('failed-precondition', 'Merchant must be verified to join loyalty network');
}
```

## The real `merchants/{id}` schema — traced to its actual creator, not assumed

The canonical creator is `createBusiness` (`functions/business-bootstrap.js:1067-1069`), the
onboarding-v2 provisioning flow:

```js
batch.set(db.collection('merchants').doc(merchantId), {
  merchantId, name: businessName, ownerId: uid, adminUids: [uid], status: 'active', createdAt: now,
});
```

**This independently confirms the schema already given**: `merchantId`, `name`, `ownerId`,
`adminUids`, `status`, `createdAt`. **No `verified` or `isVerified` field, here or anywhere else.**

Exhaustive check, not a sample: `grep`'d every file touching `db.collection('merchants')`
(`business-bootstrap.js`, `crm.js`, `device-manager.js`, `loyalty-enterprise.js`,
`pos-zero-friction.js`, `task-queue.js`) for any write of `verified`/`isVerified` onto a merchant
document. **Zero matches, anywhere.** The only place either field name appears in the whole
`functions/` tree is the read at line 1188 itself.

---

## "A separate verification authority" — one exists, and it's equally empty

`functions/profile-engine.js` reads `db.collection('verifications').doc(uid)` (five call sites,
lines 107/196/252/395/495) and exposes a field named **`merchantVerified`** (different name again —
a *third* spelling, after `verified` and `isVerified`) as part of a per-**uid** verification record
covering multiple role types (the code iterates `Object.entries(verif)` for "verified types",
implying `riderVerified`/similar siblings exist in the same shape).

This is architecturally the *correct* place for this check to live — it's keyed by identity
(`uid`), and a merchant's owner is `merchant.ownerId`, so `verifications/{merchant.ownerId}
.merchantVerified` is a real, sensible bridge.

**But it is never written.** Every one of the five references above is a `.get()`. Grepped the
entire `functions/` tree for any `.set()`/`.update()`/`.add()` targeting `verifications` — **none
exist.** This matches the standing project memory note that this verification system's acceptance
sits at 0/12 — independently reconfirmed here at the write-path level, not just recalled.

**Consequence for the design question:** redirecting `joinLoyaltyNetwork` to check
`verifications/{merchant.ownerId}.merchantVerified` instead of `merchants.verified` would not fix
anything today — it would move the same "always false" condition onto a differently-named,
equally-unpopulated field. That's a more *correct* place to check, not yet a *working* one.

---

## What IS real, populated, and available — without being a verification signal

| candidate | collection.field | populated? | what it actually means |
|---|---|---|---|
| merchant status | `merchants.status` | ✅ always `'active'` at creation, by `createBusiness` | account exists and isn't (yet) deactivated — no identity check implied |
| business status | `businesses.status` | ✅ always `'active'` at creation (`business-bootstrap.js:1017`) — same document family, keyed by the same `merchantId`, written in the same batch | identical lifecycle semantics to merchant status, not a distinct signal |
| **onboarding completion** | `businesses.productionReady` | ✅ **genuinely computed and latched** — `business-bootstrap.js:1349-1389`: recomputed from real checklist state, then permanently stamped `true` once requirements are first met (explicitly described as intentionally latched, not re-derived every call) | closest thing in the schema to "this business is real and operational," but it is a **completion** signal, not an **identity-verification** signal — a merchant can be `productionReady` without anyone having checked who they are |
| loyalty feature flag | `featureFlags.loyalty` | ✅ written at creation, defaults **`false`** (`business-bootstrap.js:1085`) | a real per-merchant enablement flag that already exists in the schema — **not currently checked by `loyalty-merchant.html`** before calling `joinLoyaltyNetwork` (grepped, no reference found) — a second, disconnected gate sitting unused |

**None of these is "verified" by any reasonable reading of the word**, and the trace does not
recommend substituting any of them — consistent with the instruction not to reach for
`status === 'active'` merely because it would make the UI stop erroring.

---

## The three states the design must keep separate, as asked

- **retired** — no field observed anywhere in `merchants`/`businesses` encodes this today; not
  traced further in this pass (out of the requested scope, flagged as a gap).
- **unverified** — the honest current state of *every* merchant, since no verification of any kind
  is ever recorded.
- **active but not verified** — is, today, indistinguishable from "unverified," because `status`
  is set unconditionally at creation and never reflects an identity check. If a future design
  wants these to mean different things, `status` cannot be the only signal — it doesn't carry
  enough information to distinguish them.

---

## Design question, stated for a future decision — not answered here

> Should loyalty-network eligibility require **identity verification** (a real KYC-style check —
> which would mean building or activating the `verifications` write path, since it doesn't exist
> today), or **onboarding completion** (`productionReady`, which already works), or a **deliberate
> product decision to relax the gate** to something like the unused `featureFlags.loyalty`, with
> the understanding that none of these is "verified" in the sense the current error message
> claims?

This trace does not choose. It establishes, with evidence: the field checked today can never be
true; the "properly named" alternative can also never be true; and there are three different real,
populated, but semantically distinct signals already sitting in the schema that a decision could
reasonably choose from, each meaning something different.

## What this trace does NOT do

Does not change `loyalty-enterprise.js`, `business-bootstrap.js`, or any UI. Does not decide which
authority should gate `joinLoyaltyNetwork`. Does not trace a `retired` state (out of scope, flagged
as unexamined rather than assumed absent). Does not touch `C:/temp/sok-r1`.

## Related

`docs/adr/ADR-INVENTORYRECEIVEPO-disposition.md` (same evidence method: trace the real writer
before assuming what a reader expects) · standing project memory: Identity/Verification acceptance
0/12 — reconfirmed at the write-path level here, not merely recalled
