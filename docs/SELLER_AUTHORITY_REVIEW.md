# Seller authority — `projectSeller` and `getSellerRestriction`

**Read-only.** Nothing modified, nothing applied, nothing deployed. Shared tree untouched.

# Both items resolve to decisions, not engineering — and one corrects my earlier advice

---

## 1 · `projectSeller` — ⚠️ REQUIRES_HUMAN_DECISION

**It is not a duplicate path. Production has no seller-shop provisioning at all.**

Production `c4013d1` dispatches an approved application by role:

```
driver | rider          → projectDriver
legal                   → projectLegal
ROLE_PROFILES[role]     → projectRoleProfile     ← { mechanic, landlord, tenant } ONLY
DELEGATED_ROLES[role]   → delegated
otherwise               → projectProvider
```

**`ROLE_PROFILES` contains no `seller` entry.** An approved seller therefore falls through to
`projectProvider` and receives a `providers/{uid}` document.

```
collection('shops')   in c4013d1: 0        in candidate: 1
collection('sellers') in c4013d1: 0        in candidate: 1
```

That matches the recorded state of the merchant onboarding chain — *apply→approve→shop built
in-repo, production intake never shipped*. `projectSeller` **is** that missing capability.

### 🔴 But it contradicts the canonical shop ownership contract

`functions/kasshop.js`, which owns shop identity in production, states the rule explicitly:

```
line 29:  Ownership is ALWAYS `shops/{shopId}.sellerUid === request.auth.uid`.
          Never `shopId === uid`.
```

`projectSeller` derives:

```js
const shopId = declared || String(uid);      // ← the disclaimed form
```

When an application declares no `shopId`, it creates a shop **whose id is the uid** — precisely
the shape `kasshop` says is never canonical. Ownership resolution would still function, because
`projectSeller` writes both `ownerId` and `sellerUid`, and `kasshop` resolves by *querying*
`shops where sellerUid == uid`. But `kasshop` also records a live hazard in mixing conventions:

> *"a document matched on a legacy field may carry a DIFFERENT `sellerUid`"*

So this is not a merge decision. **Two questions belong to you:**

1. Should approval provision a shop at all — shipping the never-shipped intake?
2. If so, what is the canonical `shopId` when the application declares none? The `uid` fallback
   conflicts with the stated contract, and picking one silently would be inventing shop identity
   policy.

**Not adopted. Not modified.**

---

## 2 · `getSellerRestriction` — 🔴 FROZEN (correcting my earlier advice)

I previously told you this was the one export resolvable under the current freeze. **That was
wrong**, and the correction matters more than the item.

```
functions/commission-collection.js
  exports:  sweepCommissionDue · getCommissionBalance · getSellerRestriction
  d6655bd:  ABSENT      d592d8f: ABSENT      c6a1e68: present
  all three deployed in production
```

`getSellerRestriction` is not a standalone seller-authority function. It ships inside a
**commission module**, alongside two exports already classified wallet/ledger-protected.
Exporting it means exporting from a frozen module. Its own body carries no money markers, but
separability is a property of the module, not the function.

**So the count is 7 of 7 frozen, not 6 of 7.** There is no index-export work available under
the current freeze.

**A second finding:** `commission-collection.js` exists in **neither production lineage**, yet
all three of its exports run in production. Another instance of the provenance gap — production
executing code no lineage in this tree contains. It belongs with the export-governance work,
not to a seller slice.

---

## Verdict

```
projectSeller           REQUIRES_HUMAN_DECISION — conflicts with the canonical shopId contract
getSellerRestriction    FROZEN — commission module; my earlier "actionable" call was wrong
index exports actionable under the freeze:  0 of 7   (previously reported 1 of 7)

files changed           NONE
production deployed     NO
production mutated      NO
shared tree             UNCHANGED — 235 entries
```

### What this means for the critical path

The seller-authority track produced two decisions and zero engineering work, which is the
correct outcome rather than a disappointing one — both items were genuinely blocked and the
alternative was to guess at shop-identity policy or export from a frozen module.

**The freeze carve-out decision is now the only thing on the critical path.** It gates all
seven exports, the Daraja resolution, `fa5082b` multi-shop checkout, and — indirectly —
`projectSeller`, since shipping seller-shop provisioning without settling `shopId` policy would
put two identity conventions into the same collection.
