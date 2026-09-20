# Shop Employment → Till Authority — Decision Record

**Decided 2026-09-20 · read-only adjudication · repair authorized, NOT YET IMPLEMENTED · NOT DEPLOYED**

**Question.** What is the authoritative employment/assignment signal for POS till authorization, and
does the shipped implementation conform to it?

Found while mapping mechanism #7's surface for the employment-termination design in
[[ADR-035-employment-and-identity-binding]]. It is **not** part of that design. Three different
things are in play and this record keeps them apart:

```
hrStaff employment   ≠   shopEmployees assignment   ≠   POS till authorization
```

This record does **not** reopen [[EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION]], which asks a different
question — whether `shopEmployees` or `workspaceMemberships` is the employee **store**. Here the
store is not in dispute; the **activity predicate over it** is.

---

## OBSERVED

```
WRITER   index.js:5663 (acceptShopInvite)     active: true      no status field
REMOVAL  shop-employees.js:488                active: false     no status field
                                              + removedAt, removedBy   (soft)

READERS
  shop-employees.js:138  resolveShopAccess      e.active === false → 'inactive'
  shop-employees.js:272  getMyShopWorkspaces    e.active === false → skip
  merchant-identity.js:212  resolveActor        _employmentActive(emp)
  merchant-identity.js:64      → reads rec.status ONLY, and `if (!st) return true`

MONEY PATH
  pos-zero-friction.js:444  → resolveActor → the sale is refused only on !ok
```

The shipped predicate's own comment reads *"Absent status is treated as active only for records that
predate the field."* **No writer has ever written the field**, so every record predates it. The
comment describes a migration that never happened and reads as a safeguard.

## PROVEN

1. **`shop-employees.js` declares itself the authority and names the field.** Its header: *"the ONE
   contract for 'who works at this shop'"*, with the predicate stated verbatim —
   > `believed iff shopId matches, uid matches, **active !== false**, role is a known shop role, AND
   > shopOwnerId === the shop's actual owner from shops/{shopId}`

   and it exports *"the internal contract used by other authorities"*.

2. **The contract was certified on `active`.** `scripts/test-shop-employee-authority.js:282` —
   **`C4  a removed employee is refused`** — seeds `active: false` and asserts `permission-denied`
   against `resolveShopAccess`. Precisely the scenario `resolveActor` permits.

3. **The divergence post-dates the contract.** `0d1acdf` (**2026-08-16**) created
   `shop-employees.js`, its message requiring that a record *"be active"*. `_employmentActive`
   entered `merchant-identity.js` in `2f4fc20` (**2026-09-15**), a month later.

4. **The divergence is not ignorance of the contract.** `resolveActor` cites `shop-employees.js`
   **four times in comments** — adopting its canonical key, quoting its header, naming its
   `legacyEmployeeDocId`, deferring to its `SHOP_ROLES` — then reimplements the predicate.
   `merchant-identity.js` **imports only** `firebase-functions` and `firebase-admin`; it never
   requires the contract module.

5. **It implements four of the five conditions**, substituting `_employmentActive(status)` for
   `active !== false`.

6. **`{active:false}` reads as active.** Established by executing the predicate **extracted from
   shipped source**, with controls; a failed extraction aborts rather than paraphrasing.

7. **`status` has no writer and no sibling model.** `ACTIVE_EMPLOYMENT = ['active','approved',
   'enabled']` appears nowhere else as an employment vocabulary.

8. **Latent.** Production `shopEmployees` = **0** (2026-09-20, positive-controlled against
   `users` 100 / `shops` 3). The 2026-09-06 census agreed but predates this branch; this is
   re-measured, not inherited.

## UNPROVEN

- **Whether `status` was intended for a future lifecycle.** No evidence either way. With no writer,
  no vocabulary sibling and no documentation, "deliberate future contract" is **unsupported**, not
  disproven.
- **Origin hypothesis, unevidenced and not load-bearing:** `status` *is* a real field — on `shops`,
  not on `shopEmployees` (`shop-employees.js:211` reads `shopData.status !== 'suspended'`). The
  predicate may have been written against the shop-shaped record. Recorded so a later reader does
  not rediscover it as new; nothing below depends on it.
- Anything requiring runtime execution against deployed functions. This measured **data and source**,
  not a deployed invocation.

## INTENDED AUTHORITY

> **`shopEmployees.active !== false`, as one condition of the five-part corroborated predicate owned
> by `shop-employees.js`.**

This is **not** inferred from `active` being the field that happens to get written — that reasoning
was explicitly excluded, because a writer can be as wrong as a reader. It rests on four independent
artifacts: the module declaring itself the contract **and naming the field**; a certification suite
pinning the removal case; the commit that created the module requiring *"be active"*; and the
divergent reader citing that same module four times while calling it zero times.

## CONFORMANCE

> **DIVERGES.**

`resolveActor` reimplements a contract it was written to consume, and drops the one condition that
revokes access. `removeShopEmployee` returns `{ok: true, active: false}` to an owner while the till
gate still admits the person — the failure is **silent on the surface where it matters**.

## REQUIRED REPAIR

> **The till employment arm must consume the existing `shop-employees.js` authority instead of
> maintaining a private employment predicate.**

**The repair boundary is deliberately NOT "teach `_employmentActive` to read `active`."** Changing
`rec.status` to `rec.active` fixes the symptom and leaves the cause: two predicates over one
collection, and the next reader free to write a third. The adjudication established the duplication
itself as the defect.

**Delegation versus import is NOT decided here.** That is a repair-design question, and it is
constrained by what must survive:

| must be preserved | why |
|---|---|
| `servedBy` | receipt attribution — the Sales Control Centre displays it |
| `capabilities` | the role ceiling, narrowed by `restrictions` |
| `restrictions` | owner-withdrawn capabilities |
| the **owner arm**, unchanged | see below |

**The owner arms must NOT be unified.** `resolveActor` requires `uid === shopId`;
`resolveShopAccess` uses the `ownerId | sellerUid | ownerUid` union. Repairing the **employee** arm
must not silently converge the **owner** arm. That is separate work with its own evidence
requirement.

`_employmentActive` and `ACTIVE_EMPLOYMENT` are exported from `merchant-identity.js` but have **no
consumer outside their own file** — verified. Their removal regresses nothing.

**Migration: none.** Zero production records. This is the cheapest the repair will ever be, and the
only moment it needs no backfill.

### The repair must certify, at minimum

```
1  an ACTIVE employee remains authorized on the till path
2  an active:false employee is REFUSED by the till path
3  the canonical five-part shop-employees.js predicate remains authoritative
4  owner authorization is unchanged
5  capabilities / restrictions / servedBy outputs are unchanged
6  no private `status` employment vocabulary remains in the repaired employee arm
7  legacy shopEmployees/{uid} behaviour stays within the existing contract boundary
8  the zero-record production state requires no migration
9  scripts/test-shop-employee-authority.js remains green
```

**Prove the repaired POS path, not merely `resolveShopAccess`.** The defect exists precisely because
two consumers disagree; certifying the consumer that was already correct would prove nothing about
the one that was not.

**Sabotage must demonstrate that restoring the private `status` predicate reopens the defect.** A
repair whose certification stays green when the defect is reintroduced has certified nothing.

## CONTRACT-CONFORMANCE BEHAVIOUR CHANGE — `shopId` must match

**Recorded 2026-09-20, before the repair was committed.** This is a **behaviour change**, not an
incidental implementation detail, and it is written down here rather than left to be discovered in a
diff.

Adopting the canonical predicate means adopting **all five** of its conditions as the contract states
them. The private copy in `resolveActor` did not merely differ on `active` — it was also **more
permissive about `shopId`**:

```
REMOVED (the private copy)
  if (emp.shopId !== undefined && _s(emp.shopId, 64) !== shopId) → refuse
      an ABSENT shopId was TOLERATED and the record still believed
      comparison ran on _s(): <>"'& stripped, truncated to 64, trimmed

ADOPTED (the contract, shop-employees.js)
  if (String(e.shopId || '') !== String(shopId)) → 'shopId mismatch'
      an ABSENT shopId is a MISMATCH and the record is refused
      comparison is a plain String() equality
```

### What changes

A `shopEmployees` record carrying **no `shopId` field** was previously believed by the till arm and
is now refused. The same applies to a record whose `shopId` only matched *after* `_s()` stripped
`<>"'&` from it.

### Why this is conformance, not scope creep

The contract's own wording is *"believed iff **shopId matches**, uid matches, active !== false, role
is a known shop role, and shopOwnerId === the shop's actual owner"*. A record that names no shop does
not match one. Keeping the tolerance would have meant consuming the authority on four conditions and
retaining a private exception on the fifth — the same defect this repair exists to remove, one clause
smaller.

`resolveShopAccess` and `getMyShopWorkspaces` have enforced the strict form since `0d1acdf`. The
repair makes the till agree with them; it does not invent a new rule.

### Blast radius

```
sole writer  index.js:5663 (acceptShopInvite)  ALWAYS writes shopId
production   shopEmployees = 0  (2026-09-20, positive-controlled)
```

So no record is affected, and none can be: the only path that creates one writes the field. As with
the `active` repair itself, the zero-record state is what makes this safe to adopt now rather than
something to stage behind a compatibility window.

### What it does NOT change

Owner authorization on either arm, capabilities, restrictions, `servedBy`, the refusal vocabulary
surfaced to callers, or the legacy `shopEmployees/{uid}` boundary. Certified in
`scripts/test-till-employment-authority.js` §2b (attribution pinned field by field) and §4 (owner
arm), with the owner-arm code delta verified at **zero lines**.

## OUT OF SCOPE

```
hrStaff employment · employment termination · ADR-035 mechanisms #5/#7
owner-arm ownership convergence
the client-create firestore.rules permission 0d1acdf recorded as "harmless but untidy"
legacy shopEmployees/{uid} migration — deferred by the contract itself
the shopEmployees vs workspaceMemberships store question — EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION
```

## DEPLOYMENT

**No deployment authorization.** Functions and Cloud Run remain frozen under the Artifact Registry
forensics notice. This record authorizes a repair slice, not a release.

---

*Evidence: CHANGELOG entries (111) and this record. Related: [[ADR-035-employment-and-identity-binding]] ·
[[EMPLOYEE_AUTHORITY_CONVERGENCE_DECISION]] · [[ADR-013-pos-write-authority]]*
