# Identity → Seller → Shop → Analytics census

> **Status:** static census COMPLETE · runtime census NOT RUN · no repair made.
> **Scope:** deliberately separate from the inventory-writer freeze
> ([[LAUNCH_TODO]] §1–2c). Nothing here touches a writer, a gate, or a deploy.
> Related: [[LAUNCH_READINESS]] (*Engineering Complete ≠ Production Proven*).

## The target shape

```
ONE authenticated user
  ├── buyer role
  └── seller role
        └── activeShopId
              ├── Shop / MiniShop   ├── Inventory   ├── Analytics
              ├── Products          └── POS
```

The job is **not** "fix the seller page". It is: *restore one canonical
profile → seller → shop identity, and make every private seller surface resolve from
it.* A new role or a second shop document created to make a page render is not a fix —
it is a fourth competing identity model.

---

## What the static census can prove without touching production

Three structural divergences are visible in the source. They do not depend on any
account's data, and each is sufficient on its own to produce the reported symptoms.

### 1. "Seller" is read from nine different signals

| signal | read at |
|---|---|
| `users/{uid}.roles[]` | `profile.html:5521`, `seller-analytics.html:333`, `business-analytics.html:340` |
| `users/{uid}.role` (string) | `seller-fulfilment.html:268`, `script.js:3489` |
| `isSeller` | `index.html:3809`, `script.js:3489` |
| `registeredAs` | `index.html:3809`, `script.js:3641` |
| `sellerActive` / `storeName` | `script.js:3489` |
| `claims.seller` | Firestore rules, `sokoni-merchant-diag.js` |
| `claims.role === 'seller'` | `functions/pos-retail-engine.js:47`, `functions/analytics-engine.js:90` |
| `claims.roles[].includes` | `functions/pos-qr.js:34` |
| `claims.sellerVerified` | `functions/pos-retail-engine.js:47` |

**Consequence:** a seller can be present in one signal and absent in another
indefinitely, with nothing reporting the disagreement. *"The seller role disappeared"*
is far more likely to be **inconsistent** than **missing** — which is why the repair is
reconciliation, not `roles.push('seller')`.

### 2. `activeShopId` has three sources and no agreed precedence

```
window.SokoniShell.activeShopId   in-memory, set from SokoniBranch   merchant.html:1953
localStorage.activeShopId         persisted                          merchant.html:1956
claims.shopId                     the SIGNED value
```

`pos-completeness.html:524` and `pos-kds.html:261` both resolve
`localStorage.getItem('activeShopId') || r.claims.shopId` — **the cache outranks the
signed claim.** `merchant.html:2177` already warns in-comment that this value survives an
account switch. That is a complete, documented path for a shop to appear under a stale
identity, with no data corruption required.

### 3. `shops` is addressed in two key spaces, with three ownership fields

| addressing | used by |
|---|---|
| `shops/{sellerUid}` — doc id **is** the uid | `functions/account-status.js:59`, `functions/etims.js:517` |
| `shops/{activeShopId}` — doc id is a **branch** id | `functions/analytics-engine.js:83`, `functions/finance-os-sprint43.js:28` |

Ownership is asserted three ways: doc-id `== uid`, `ownerId == uid`
(`finance-os-sprint43.js:31`), and `sellerUid == uid` (`merchant.html:2004`).

**And the analytics key is a third thing again.** The server aggregates under
`shopId: <sellerUid>` (`functions/index.js:3169`, `:3201`, `:3382`) while the client
passes the **branch** id as the shop dimension (`sokoni-analytics-engine.js:77`).

> This is the mechanism behind *"shops/{id} is populated but minishopConfig/{id} is only
> partially populated"* and *"analytics is under another key"*. Shop and Analytics are not
> disagreeing about a **number** — they are keyed by **different identifiers**. No amount
> of recomputing figures will make them converge.

---

## Runtime census — READ-ONLY, not yet run

Extended `sokoni-merchant-diag.js` (already loaded by `profile.html`, `seller.html`,
`seller-analytics.html`, `inventory.html` and six more) with an `identityBlock` that
traces the chain on a real signed-in device. Every call is a `getDoc`; it creates
nothing and repairs nothing, **by construction**.

It reports, and flags divergence in:

```
auth.uid → claims → users/{uid}.roles[] (RAW, undeduped) / .role / .sellerUid
        → activeShopId (all three sources, and which one wins)
        → shops/{uid} and shops/{activeShopId}  — exists? owned by me?
        → minishopConfig/{uid} and /{activeShopId} — exists? field count?
        → analytics scope key vs session shop scope
```

Deliberate details:

- **The roles array is printed raw**, not de-duplicated — *"two buyer roles"* is invisible
  through a `Set`.
- **A denied read returns `undefined`, not `null`.** Permission-denied is an *unanswered
  question*, never evidence of absence. The module already had this discipline; the
  identity block keeps it.
- **Identity runs before the product census**, because a product count taken against the
  wrong scope reads as *"no products"* when the truth is *"not my shop"*.
- `EXPECTED_PHONE` was hardcoded to a previous sprint's account and would have reported a
  correct sign-in as **"WRONG ACCOUNT — the workspace is missing"**. It is now overridable
  via `window.SOKONI_DIAG_ACCOUNT` and degrades to informational when undeclared — a
  diagnostic that is confidently wrong is worse than one that is silent.

### To run it

Sign in as the affected account on `mysokoni.co.ke`, open any merchant surface
(`/profile`, `/seller`, `/seller-analytics`, `/inventory`), and read the
`[Merchant] … diagnostics` console group. `window._md.identity` holds the structured
result. Optionally set `window.SOKONI_DIAG_ACCOUNT = '<phone-or-email>'` first.

**This has not been run.** The identity block is unexercised until it executes against a
signed-in session — this environment cannot authenticate that account (phone OTP, App
Check, no test credential), which is the same constraint that created this module.

---

## The canonical model — now a rule

Recorded as **[[ADR#ADR-0018 — One identity]]**. The invariant the census checks:

```
auth.uid === users/{uid}.sellerUid          and    shops/{activeShopId} owned by auth.uid
```

Three corrections the codebase forced on that statement — each would otherwise have
produced a check that fails for every account on the platform:

| stated | actual | consequence |
|---|---|---|
| `shops.ownerUid` | no such field — `sellerUid` \| `ownerId` \| doc-id | check all three, in `_ownedShop`'s order |
| `users/{uid}.activeShopId` | **does not exist anywhere** | a decision to implement, reported `UNKNOWN` |
| role written as `roles[]` | creation writes `role: 'seller'` **string** | sellers invisible to array readers |

That third row is the strongest single explanation for a *"missing"* seller role.
`functions/automation-engine.js:277` auto-approves a seller by setting
`users/{uid}.role = 'seller'` plus `sellerEnabled: true`, while `profile.html:5521`,
`seller-analytics.html:333` and `business-analytics.html:340` all read `roles[]`. The role
is not missing — it was **written in a shape those surfaces never read**. It is a
creation-rule defect, which is exactly where the fix belongs.

### The role defect is PATH-DEPENDENT, and a canonical granter already exists

Tracing every writer of seller role state onto `users/{uid}` sharpens the finding
considerably. It is not "the creation path uses the wrong shape" — it is that **whether
your seller role is visible depends on which approval path ran.**

| path | writes | visible to `roles[]` readers |
|---|---|---|
| `functions/application-lifecycle.js:886` `grantAccountRole` | `roles: arrayUnion(key)` **+** `registeredAs.{key}` | ✅ **canonical** |
| `functions/index.js:272` (admin), `:5265` | `role` string **+** `roles: arrayUnion` | ✅ |
| `functions/automation-engine.js:277` `auto_approve_seller` | `role:'seller'` + `sellerEnabled` **only** | ❌ bypass |
| `onboarding-seller.html:469` | `role:'seller'` string | ❌ bypass (client) |
| `sokoni-wap-definitions.js:426` | `role:'seller'` string | ❌ bypass (client) |

`grantAccountRole` is unambiguously the intended granter: it holds a `ROLE_KEY` map and
**throws** on an unmapped role rather than — in its own words — treating it as *"a problem
to be smoothed over"*. Three paths bypass it.

> **The same architectural shape as the inventory work.** A canonical writer exists; other
> paths write the same state directly and diverge from it. `sokoni-wap-definitions.js`
> appears in *both* findings — quarantined for writing canonical stock from the browser
> (§2b of [[LAUNCH_TODO]]), and here for granting a role outside the canonical granter. One
> file, one habit, two subsystems.

**Consequence for the repair:** re-granting the role by hand fixes one profile and leaves
the next auto-approval to reproduce it. Invariant **I8** therefore attributes the *granter*
from the residue left on the profile — `roles[]` + `registeredAs.seller` means canonical;
`sellerEnabled` without `roles[]` means `automation-engine`; a bare `role` string means a
client write. That turns the authenticated run into a diagnosis of **which path to fix**,
not merely whether the account is broken.

Note also: `functions/universal-onboarding.js:194` writes `roles: arrayUnion(role)` to
`accounts/{uid}` — a **different collection** from `users/{uid}`. Recorded, not chased; it
is a separate convergence question.

**The canonical shop resolver already exists too.** `functions/kasshop.js:74 _ownedShop()` resolves
by ownership field (`sellerUid → ownerUid → ownerId`), scoped by uid, deterministic on
ties, and explicitly *"never consults a document id, a cached shop, or a handle."* The
convergence work is routing other surfaces **onto** it — not writing a fourth resolver.

### Invariants the census now checks

| id | statement | note |
|---|---|---|
| I1 | `users/{uid}.sellerUid === auth.uid` | `UNKNOWN` if unset — absent is not wrong |
| I2 | `shops/{uid}` owned by auth.uid | reports **which** field carried ownership |
| I3 | `activeShopId` resolves to a shop this uid owns | the stale-identity check |
| I4 | the signed claim outranks the localStorage cache | today it does not, by construction |
| I5 | the seller role agrees across profile · claims · cache | `UNKNOWN` when no signal says seller |
| I6 | `users/{uid}.roles` has no duplicates | merge residue → deduplicate, don't add |
| I7 | `users/{uid}.activeShopId` is the canonical home | **`UNKNOWN` — field does not exist yet** |
| I8 | the seller role was granted by the canonical path | attributes the **granter** from profile residue |

`PASS` / `FAIL` / `UNKNOWN` are kept strictly apart. A denied read reported as `FAIL`
invents a defect; reported as `PASS` hides one. Both are worse than recording that the
question went unanswered — so a run with zero failures and open unknowns is explicitly
**not** a clean bill of health.

### Expected values for KASS

From the merge record (2026-08-05/06) — a **prediction to verify**, not a finding:

```
auth.uid = users/{uid}.sellerUid = shop owner = D5Ql2EYr95bt79IpcGTmOMTK0P83
handle                                        = kassshop
deprecated, historical/linked only             = xrH21J5GFbW8PluCZ2ny5nIuf602
```

If `activeShopId` returns `xrH…` or a branch id, that is I3/I4 — the cache-outranks-claim
path — and the repair is precedence, not a new shop.

## Repair plan — gated on the census, not started

No repair should begin until the runtime census answers all four questions. The order
matters: each step's correctness depends on the previous one's answer.

1. **Establish the canonical identity.** Which uid owns the shop, per `shops.sellerUid` /
   `ownerId` / doc-id? That answer — not the UI — defines the seller.
2. **Reconcile the role signals** to whatever the Role Authority work made canonical
   (claims are the client authority). Deduplicate `roles[]`. Do **not** set the false
   signals true; that makes the divergence permanent instead of removing it.
3. **Collapse `activeShopId` to one source of truth**, with the signed claim outranking
   the cache — reversing today's `localStorage || claims.shopId` precedence.
4. **Converge the key space** so `shops`, `minishopConfig` and the analytics aggregate key
   address the same identifier. This is the largest item and the one that actually makes
   Shop and Analytics agree.
5. Only then align the routes.

### Acceptance test

```
AUTH UID = profile owner = sellerUid = shop owner = activeShopId owner

Merchant shell · Dashboard · Inventory · POS · Products
MiniShop control · Shop analytics · Order analytics     → all resolve MY shop
Public MiniShop                                         → same shop, public projection
Buyer role                                              → still available
Duplicate buyer role                                    → reconciled
Missing seller role                                     → restored from canonical ownership
Admin identity                                          → never substituted for seller identity
```

### Boundaries

- **Never merge analytics by copying figures between profiles.** Reconcile the scope keys
  and let analytics re-derive from canonical commerce data. A dashboard made to agree by
  transcription is contradicted by the next POS sale, refund or inventory change.
- **`sold` vs `soldCount` stays a separate analytics-convergence item** ([[LAUNCH_TODO]]
  §2b). It was found by the inventory-writer sweep and must not be silently "fixed" while
  repairing identity — mixing them makes both sets of evidence unreadable.
- **RC freeze.** Steps 3 and 4 are architectural. Under the RC change policy they are
  flagged for confirmation, not executed. The census and this document are evidence
  gathering, which the freeze permits.
