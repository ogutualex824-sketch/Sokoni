# Till Approval Automation — trace, corrections, design and implementation

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core). COMMITTED · STACKED.
NOT ON R1 · NOT DEPLOYED.** Part 1 of the "Till Approval Automation + Unified Dashboard Profile"
workstream. Production remains `d592d8f`/v632, untouched.
**Date:** 2026-09-04

---

## 1. Corrections to the brief — traced, not assumed

Three-agent parallel research pass over `functions/*.js` and `docs/*.md`. Several premises in the
original request did not hold up under inspection; recorded here so the design below is traceable
to what actually exists, not to the framing that prompted it.

- **The "broken second step" is real, but on a different collection.** `verificationRequests/{id}`
  is the "Get SOKONI Verified" trust-badge flow (`verification.html`/`verification-admin.html`) —
  unrelated to becoming a seller. It genuinely has the described flaw (five sequential, unguarded
  `await` writes; `status:'approved'` commits before a later write to `verifications/{uid}` can
  fail, with the error swallowed for a third write). Not the merchant/shop approval path.
- **The real merchant/shop approval is `applicationDecide` → `applyDecision` in
  `functions/application-lifecycle.js`**, operating on `applications/{appId}`. It has the *same
  class* of gap, self-documented rather than silent: `projectSeller` (a batch: `shops/{id}` +
  `sellers/{uid}` + `users/{uid}`) can succeed while a later step (`grantAccountRole`,
  `startSellerFreeTrial`) throws; the catch stamps `projectionStatus:'failed'` onto the
  already-committed `status:'approved'` document rather than rolling it back. **This is the
  correct, evidenced hook point** — not `verificationRequests`.
- **No canonical `sellerUid → shopId → branchId` resolver exists anywhere in this branch.**
  `shops/{uid}` being 1:1 keyed by the seller's own uid is reconfirmed (three independent
  sources). `${shopId}-main` is the established `branchId` default (already used by
  `sokoni-till.js` itself and `posUpsertProduct`), but it is a repeated inline convention, not a
  shared function — there is nothing to "not hard-code KASS identifiers into" beyond this
  convention, which was already generic.
- **`functions/merchant-identity.js` does not exist on this branch** (confirmed directly, not
  just via the research agent) — it exists only on an unmerged branch, `release/merchant-identity`.
  `functions/pos-zero-friction.js`'s current (already-dirty, pre-existing, not-mine) working-tree
  state `require`s it and would fail to load as-is — unrelated to this slice, not touched, noted
  only so it isn't mistaken for something this work depends on.
- **The "KASS Shop canonical identity verification... convergence" framing does not check out as
  described.** No doc frames it that way. What is real: KASS Shop has a confirmed production
  identity (`shopId D5Ql2EYr95bt79IpcGTmOMTK0P83`) — sufficient for this design, which never
  branches on shop identity at all (see §3).
- **`mintSokoniTill`'s transaction logic was not separately exported** — only reachable via the
  `onCall` wrapper, which requires `request.auth` and would throw `unauthenticated` if called from
  a server-triggered context with no caller. Refactored (§3) rather than duplicated.

---

## 2. The hook point, traced in full

```
applicationDecide (onCall, admin) ─┐
applicationLifecycle (Firestore trigger, applications/{appId}) ─┼─→ applyDecision(appId, app, opts)
applicationReconcile (onCall, admin, repair/replay) ─┘
                                        │
                                        ├─ projectSeller(db, app, uid, approved)
                                        │    → batch: shops/{id} + sellers/{uid} + users/{uid}
                                        │    → returns { ..., shopId, sellerUid, activeShopId }
                                        │      when approved; { id, action:'suspended'|'none' }
                                        │      (NO shopId field) when not approved
                                        │
                                        ├─ grantAccountRole(...)   — role-authority.js, unchanged
                                        ├─ startSellerFreeTrial(...) — unchanged, same guard shape
                                        └─ ⭐ Till issuance — NEW, this slice, same guard shape
```

`applyDecision` is called from three separate entry points, all of which can legitimately reach
the seller-approval branch — the **Firestore trigger in particular can re-fire** for the same
document (retries, replays), which is exactly why idempotency had to be a first-class,
certified property rather than an assumption.

---

## 3. Design

### 3a. `mintSokoniTillCore` — extracted, not duplicated

`functions/sokoni-till.js`'s `mintSokoniTill` (onCall) had its entire transaction body extracted
into a plain, exported async function, `mintSokoniTillCore({shopId, branchId, actorUid,
onExisting, source})`. `mintSokoniTill` is now a thin wrapper — auth/ownership checks only, then
one call — **behaviourally byte-identical to before the refactor** (`onExisting` defaults to
`'throw'`, matching the original always-conflict behaviour; re-certified, see §5).

Exported via `exports._internal = { mintSokoniTillCore }`, following this codebase's own existing
convention for server-to-server calls (`functions/subscription-authority.js`'s
`_internal.materialiseEntitlements`, already called this exact way from `webhookIntasend`).

### 3b. The idempotency decision, extracted as a pure, certified function

`functions/sokoni-qr-authority.js` gained `decideTillAllocation({hasActiveTill, onExisting})` →
`{action: 'mint'|'return_existing'|'throw_conflict'}`. `mintSokoniTillCore`'s transaction now
calls this instead of an inline if/else — the exact safety property the whole feature depends on
("a repeat approval converges on the existing Till, never mints a second one") is a pure function
call, directly certifiable with Node, no Firestore or emulator needed (see §5). This mirrors the
same pure-core/I-O-wrapper split every prior Till/QR slice (Q5-Q8) already used.

### 3c. The hook itself — `application-lifecycle.js`

Added immediately after the existing `startSellerFreeTrial` block in `applyDecision`, matching
its exact guard shape and reasoning verbatim:

```js
if (approved && role === 'seller') {
  const shopWrite = receipt.writes.find((w) => w && w.shopId);
  if (shopWrite && shopWrite.shopId) {
    try {
      const { mintSokoniTillCore } = require('./sokoni-till')._internal;
      const till = await mintSokoniTillCore({
        shopId: shopWrite.shopId,
        branchId: `${shopWrite.shopId}-main`,
        actorUid: uid,
        onExisting: 'return',
        source: 'application_approval',
      });
      receipt.till = { sokoniTillId: till.sokoniTillId, created: till.created };
    } catch (tillErr) {
      logger.error('[appLifecycle] Till issuance failed (recoverable)', { ... });
      receipt.till = { error: ... };
    }
  }
}
```

**Why this reads as "correct canonical shopId/branchId/sellerUid, no hardcoding":**
`shopWrite.shopId` is `projectSeller`'s **own resolved value** — the exact same identity every
other registry write in this approval (shops, sellers, users, the free trial) already uses. KASS
Shop, or any other shop, reaches this code through the identical, generic path; nothing here
names a specific merchant. `branchId` uses the established `${shopId}-main` convention, matching
`sokoni-till.js`'s own default and `posUpsertProduct`'s precedent — not invented for this slice.

**Why an inactive/rejected/suspended application cannot mint a Till, by construction, twice
over:** `projectSeller`'s non-approved branch returns `{collection:'shops', id:shopId,
action:'suspended'|'none'}` — note the field name is `id`, not `shopId`. `receipt.writes.find(w
=> w && w.shopId)` therefore finds nothing for that branch, so the Till block's own `if
(shopWrite && shopWrite.shopId)` guard fails closed — **in addition to** the outer `if (approved
&& role === 'seller')` gate. Two independent reasons the same failure mode can't occur, not one.

**Why a Till-issuance failure never undoes an approval already granted:** wrapped in its own
try/catch, matching `startSellerFreeTrial`'s documented reasoning exactly ("a failure here is
reported, never a reason to undo an approval that already granted the role and activated the
shop") — the error is recorded on `receipt.till.error`, logged, and `applyDecision` continues to
its normal success path. `applicationList`'s existing dashboard-facing surfacing of
`projectionReceipt` picks this up automatically; nothing new needed there.

### 3d. Secret binding — a real deployment dependency, not optional

`mintSokoniTillCore` calls `QR_SIGNING_SECRET.value()` (same secret name `sokoni-till.js` already
declares). Firebase Functions v2 only populates that env var for a function whose own deployment
config lists it in `secrets: [...]`. **All three entry points that can reach `applyDecision`'s
seller branch** (`applicationDecide`, `applicationLifecycle`, `applicationReconcile`) had
`secrets: [QR_SIGNING_SECRET]` added to their option objects — verified missing before, confirmed
present after (`grep secrets: functions/application-lifecycle.js`). `applicationList` (read-only,
never calls `applyDecision`) was deliberately left unchanged. This follows the exact
`defineSecret()`-declared-in-multiple-files pattern already established platform-wide
(`ALGOLIA_ADMIN_KEY` across a dozen files) — re-declaring the same secret name in a second file is
this codebase's own convention, not a new one.

---

## 4. What this slice does NOT do

Does not touch `verificationRequests`/`verification-admin.html` (the *actual* place the "approved
but subsequent write failed" defect the brief described lives — real, evidenced, but a separate,
unrelated feature; not fixed here, not in scope). Does not build a canonical
`sellerUid→shopId→branchId` resolver as a new shared utility — reuses the existing inline
convention exactly as `sokoni-till.js` already did. Does not touch `role-authority.js`,
`seller-trial.js`, `grantAccountRole`, or any other existing entitlement in `applyDecision` — only
adds one new, independently-guarded block. Does not touch `merchant-v2.html`, the profile
dropdown, or `provider-dashboard.html` — those are Parts 2-5 of this workstream, separate slices.
Not deployed. Does not touch `C:/temp/sok-r1`.

---

## 5. Certification

**Method:** pure-core, Node-only — `decideTillAllocation` added to
`scripts/test-sokoni-qr-payment.js` (the same file certifying every other Q5-Q8 Till/QR pure-core
decision), now **81/81** (was 74/74 after Q8; +5 for the idempotency-decision matrix, +2 for a
dedicated third sabotage control on this exact function). A live Firestore-transaction-level
integration test was investigated and found infeasible without a running emulator — confirmed
directly: `firebase-admin`'s `admin.firestore` accessor cannot be monkey-patched from a plain
Node script (`admin.firestore()` throws `app/no-app` regardless of reassignment, since the SDK
guards it via its own namespace internals, not a plain reassignable property) — so, consistent
with every prior Q5-Q8 slice's own methodology, the I/O wrapper (`mintSokoniTillCore`,
the `applyDecision` hook) is certified by careful code-path tracing and re-verified syntax checks,
not a fabricated "ran a live test" claim.

| requirement | how certified |
|---|---|
| approval creates Till automatically | §3c code trace — the hook fires unconditionally for `approved && role==='seller'` with a real `shopId` |
| repeated approval does not create another Till | `decideTillAllocation({hasActiveTill:true, onExisting:'return'})` → `return_existing`, certified directly + sabotage control |
| correct canonical shopId/branchId/sellerUid | §3c — `shopId` is `projectSeller`'s own resolved value (not re-derived, not client-suppliable, not hardcoded); `branchId` is the established `${shopId}-main` convention |
| inactive/retired merchant cannot mint one | §3c — double-guarded: `approved` boolean AND `shopWrite.shopId` presence (absent for the suspended/rejected branch by construction, field-name-verified) |
| KASS Shop resolves its Till | generic path, no shop-specific branch exists anywhere in this code — KASS Shop (`D5Ql2EYr95bt79IpcGTmOMTK0P83`) reaches Till issuance the identical way any other approved shop does |
| existing `mintSokoniTill` onCall behaviour unchanged | `scripts/test-sokoni-qr-payment.js`'s full 81/81 re-run clean; the wrapper's `onExisting` defaults to `'throw'`, matching pre-refactor behaviour exactly |

Merchant V2 reading its own Till, permanent/dynamic QR resolution, and "no client-supplied
merchant identity can redirect the Till" are **Part 2's** certification gates (the Till & QR page)
— Part 1 only issues the identity; nothing yet reads it from a merchant-facing surface.

## Related

`functions/application-lifecycle.js` (`applyDecision`, `projectSeller` — read in full, the hook
added) · `functions/sokoni-till.js` (`mintSokoniTillCore` extracted, `mintSokoniTill` now a thin
wrapper) · `functions/sokoni-qr-authority.js` (`decideTillAllocation`, new) ·
`docs/SOKONI_TILL_IDENTITY_DESIGN.md` (Q2, the Till schema this reuses unmodified) ·
`scripts/test-sokoni-qr-payment.js` (certification, 81/81)
