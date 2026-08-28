# Finding — `shopEmployees` self-escalation defeats the POS employment authority

**Opened:** 2026-08-28 · **Severity: P1** · **Status: OPEN, present in the SERVED ruleset**
**Demonstrated**, not inferred: `scripts/test-shopemployees-authority.js`, emulator-backed against
served ruleset `f1c4e35b-bcc2-418b-b7a3-8990c1c8dad0`.

Related: `docs/findings/STAFF_AWARE_AUTHORITY_SPEC.md` ·
`docs/findings/STAFF_AWARE_ATTEMPT_1_REJECTED.md` · [[project-employee-attribution-audit]]

---

## The rule is asymmetric

```
match /shopEmployees/{empUid} {
  allow create: if isAdmin() || (isAuthed() && request.resource.data.shopOwnerId == request.auth.uid);
  allow update: if isAdmin() || (isAuthed() && resource.data.shopOwnerId == request.auth.uid);
}
```

`create` constrains the **NEW** value. `update` constrains only the **OLD** one. Nothing stops an
update from *changing* `shopOwnerId` to a victim.

## Demonstrated escalation — two steps, any authenticated user

Explicit non-admin claims (`admin:false, superAdmin:false`), ground truth read back with rules
disabled:

```
step 1  create shopEmployees/attacker  { shopOwnerId: attacker }   -> ALLOWED (legitimate: my shop)
step 2  update it to { shopOwnerId: ownerA, role: manager, status: active } -> ALLOWED  *** ***
step 3  stored: shopOwnerId="ownerA"  role="manager"  status="active"
```

`resolveActor(uid=attacker, shopId=ownerA)` then matches: `shopEmployees/{uid}.shopOwnerId ===
shopId`, employment active, role known. **The attacker is an active manager of a shop they have no
relationship to.**

Reading the rule suggested this was safe — an attacker "cannot select a victim's shopOwnerId". That
reading was **wrong**, and only the direct test found it. Client-writable is not automatically
attacker-writable, but neither is a guarded `create` sufficient when `update` is not guarded too.

## What it grants today

`resolveActor` is the deployed POS employment authority:

| consumer | effect of the escalation |
|---|---|
| `merchantIdentity` callable | returns the victim shop's identity, `servedBy`, and capabilities |
| `merchant-identity.js:213` sale attribution | requires the `sell` capability — a forged manager has it |
| `posCompleteCheckout` | manual-discount authorisation: a forged **manager** may grant discounts |

## Consequence for the staff-aware guard

**`shopEmployees` cannot be elevated into the shared authorization primitive as it stands.** Doing
so would import this escalation into the five cashier-facing callables. The `update` rule must
constrain the new value as well, e.g.

```
allow update: if isAdmin() || (isAuthed()
               && resource.data.shopOwnerId == request.auth.uid
               && request.resource.data.shopOwnerId == resource.data.shopOwnerId);
```

Not implemented here — rules changes are production-affecting and are not authorized. Note the
compiled-rules size ceiling before attempting it.

---

## SEPARATE, LARGER FINDING — the sell-authority fix is NOT on the live lineage

`2e78f59` ("posCompleteCheckout authorizes the caller against the merchant") added
`_assertSellAuthority(auth, merchantId)` → `authorizeActor(uid, merchantId, 'pos.sell')`. Its own
message describes the defect it closed: *"an authenticated user with no relationship to a merchant
recorded a KES 400 sale against it under their own uid and moved its stock 50 -> 48."*

**That commit exists only on `audit/employee-attribution`.** It is NOT an ancestor of `de20ba1` and
NOT of live `12c6676`; `_assertSellAuthority` and `authorizeActor` appear **nowhere** in the live
tree.

So on the live lineage `posCompleteCheckout` has **no sale-level merchant authorization**:
`_assertAuth` only proves a uid exists, and `resolveActor` is consulted **only when a manual
discount is present** — a zero-discount sale proceeds with no employment check at all.

This corroborates, from a second direction, the already-recorded fact that `posCompleteCheckout` is
unbound. The new information is that **a fix was written, tested, and never landed.**

Landing it is an owner decision — it changes the POS financial path and belongs to the same
sequencing discipline as the rest of this workstream.
