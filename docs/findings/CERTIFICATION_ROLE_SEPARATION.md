# Certification invariant — three role models, three separate bodies of evidence

**Locked 2026-08-28.** Not a documentation preference. Results from one model must never be
substituted for another, and a green result in one does not license a claim about another.

Related: `docs/TENANT_ISOLATION_BASELINE_SNIPPET.md` ·
`docs/findings/SHOPEMPLOYEES_ESCALATION.md` · `docs/findings/STAFF_AWARE_AUTHORITY_SPEC.md`

---

## Why this exists

The live certification was run with KASS and WOODLANDS as the two "tenants". Both hold
`admin:true, superAdmin:true`. `assertMerchantAccess` bypasses on those claims before any
ownership lookup, so **every** cross-tenant call from either account returns ALLOWED —
correctly. A KASS -> `SOK-WDLNDS` call returning `{empty:true, days:30}` was briefly read as a
boundary breach; it was the administrator bypass working as designed.

The fixture had been built on the assumption that KASS and WOODLANDS were two ordinary
merchant principals. They never were. The earlier baseline did not expose this because every
call failed on IAM or a missing index before reaching the guard — the defects masked the
fixture defect.

---

## 1. Administrator certification

Principals: KASS (`alexochieng3030@gmail.com`), WOODLANDS (`ogutualex824@gmail.com`) — both
`admin:true, superAdmin:true`.

**Can establish:** authenticated callable reachability · the App Check transport works · the
administrator bypass behaves correctly · the callable executes against the requested merchant.

**Cannot establish:** tenant isolation for ordinary users. Nothing about non-admin denial.

## 2. Merchant-owner certification — the tenant-isolation claim

Requires a principal with **`admin != true` AND `superAdmin != true`**, owning the merchant
under test, with **no administrative relationship to the comparison merchant**.

```
CERT PRINCIPAL -> SOK-CERT01     ALLOWED + real payload
CERT PRINCIPAL -> SOK-WDLNDS     DENIED functions/permission-denied   <- THE evidence
```

The second line is the live tenant-boundary evidence. The comparison merchant may be owned by
an administrator — what matters is the **caller's** authority, and that the comparison merchant
belongs to a different principal.

**Six preconditions, proven before any call:** principal authenticated · `admin` not true ·
`superAdmin` not true · tested merchant's `ownerId` is that principal · principal absent from
the comparison merchant's `adminUids` · comparison merchant owned by a different principal.

## 3. Employee / cashier certification

A third model entirely: `shops/{ownerUid}` + `shopEmployees.shopOwnerId`, resolved by
`merchant-identity.resolveActor`, covering the five cashier-facing POS callables.

**Never interchange** its principals, merchants or results with models 1 or 2. A cashier is not
an owner; an owner is not a platform admin; `posStaff` is not `shopEmployees`.

---

## Prohibited shortcuts

* **Do not remove or alter anyone's `admin`/`superAdmin` claims to manufacture a test
  condition.** That mutates real privileges on a real account to make a test pass.
* **Do not use WOODLANDS as the "ordinary" second tenant.** It is an administrator principal.
* **Do not weaken the criteria to fit the fixture.** An OTHER-TENANT call that RESOLVES — even
  with `{}` or `{empty:true}` — is an authorization failure, because the request was accepted.

## Current status

| model | status |
|---|---|
| administrator path | verified live: reachable, App Check transport correct, bypass behaves |
| merchant-owner isolation | **UNPROVEN at the live boundary** — no non-admin principal existed |
| employee / cashier | emulator-certified 49/0; live boundary not attempted |

The platform holds **4 businesses owned by exactly 2 users, both superadmins**, so no
non-admin owner could be nominated. A dedicated ordinary account must be created through the
normal signup UI; its password is never handled here.
