# ADR-035 — Employment and identity binding

**Status:** Accepted · **not implemented** · 2026-09-20 · **amended 2026-09-20** (§2 resolver
shape + `via` taxonomy, after a read-only authority trace; §8 records a finding this ADR does not
repair) · **2a decided 2026-09-20** — platform admin eligible, taxonomy frozen at four values ·
**§6 amended 2026-09-20** — twelve events, explicit system actor, deterministic event keys ·
**§5/§6 amended 2026-09-20** — `changedVia` gains `invitee`; hrStaff.status renamed
`employmentStatus`; establishment produces pending+null; invite_revoked reconsidered and affirmed ·
**§4 decided 2026-09-20** — uniqueness is a `create()`d occupancy claim, deleted on termination;
rebind is two-claim atomic; reinstatement re-acquires and may fail
**Supersedes nothing. Constrains:** `functions/hr-payroll.js`, `hrStaff`, and any future AdminOS
employee surface.
**Depends on:** [[ADR-001]] (authorization comes from claims, never from a Firestore field),
[[ADR-008]] (measure production before changing code), [[ADR-024]] (workforce directory write
boundary).

---

## Context

Payroll authorization is now organization-scoped in both directions — requested `merchantId`
(`f4de0c1`) and record-anchored (`ef2ce4c`). What remains unanswered is narrower and harder:

> **What establishes that a particular authenticated human is the employee a payroll record
> represents?**

Measured in production on 2026-09-20, nothing does:

```
hrStaff.uid              written `null` at creation, updated by nothing   (1 occurrence in the module)
hrStaff                  0 documents          hrAttendance   0
hrPayrollRuns            0 documents          hrPayslips     0
hrLeaves                 0 documents          hrTraining     0
shopEmployees            0 documents          shopInvites    0
posStaff                 9 documents, all role=owner      — de-authorized by ADR-017/ADR-020
workspaceMemberships     2 documents, both role=owner     — commission/cash-count only
auth claims              3 users hold admin; ZERO hold manager
```

**There is not one non-owner employee record anywhere on the platform.** So this ADR decides a
contract, not a migration: there is no legacy data whose shape could constrain it.

Three existing structures were considered and rejected as the employment authority:

| structure | why not |
|---|---|
| auth claims | a claim is a *role*, not employment. It records no start date, salary, or employer. |
| `posStaff` | branch access. ADR-017/ADR-020 removed it from the set that authorizes workforce actions; population is not authority. |
| `workspaceMemberships` | workspace membership, deliberately isolated to commission and cash-count handlers. |

---

## Decision

### 1. The business is the employing organization

```
businesses/{businessId}          ← the employer (SOK-XXXXXX; SOKONI's own is SOK-XX2338)
        │
        │ owner employs
        ▼
   employment record
        │
        └── optional operational assignment → shop / branch
```

A shop such as KASS Shop may be the **operational context** of an employment — where the person
works — without becoming the employment authority. The employer is the business.

### 2. Two authorities, not one

`merchant-authority.assertMerchantAccess` grants on `ownerId` **or** `adminUids[]` **or** a
platform-admin claim, and returns a single verdict. That is correct for "may this caller act for
this organization" and **insufficient here**, because this ADR requires owner and admin to differ:

| capability | owner | business admin | platform admin |
|---|---|---|---|
| **employ** — establish the relationship | ✅ | ❌ | ✅ |
| **rebind `uid`** | ✅ | ❌ | ✅ |
| **suspend** | ✅ | ❌ | ✅ |
| **unemploy / terminate** | ✅ | ❌ | ✅ |
| **reinstate** | ✅ | ❌ | ✅ |
| grant leave | ✅ | ✅ *(if granted)* | ✅ |
| edit record (position, department, salary) | ✅ | ✅ *(if granted)* | ✅ |
| manage attendance / leave / training | ✅ | ✅ *(if granted)* | ✅ |
| view employment history | ✅ | ✅ | ✅ |

An admin's operational capabilities are **granted**, not inherited. Presence in `adminUids[]` must
not by itself confer the owner's authority to establish, suspend, terminate or reinstate an
employment relationship — those five acts change whether a person is employed and whether they are
paid.

**FORBIDDEN:** overloading `assertMerchantAccess` with a mode flag, or reading `ownerId` inline in a
payroll handler.

> **Why the distinction matters:** editing an employee is not the same act as establishing that
> someone is employed. The second decides who receives money.

#### One resolver, several narrow assertions

**AMENDED 2026-09-20.** An earlier draft of this ADR required the owner primitive to live *beside*
`merchant-authority.js`. A read-only trace showed that would produce a **seventh** organization-
authority implementation — the repo already carries six — and that the correct shape is already in
the codebase. `shop-employees.js` solved the identical problem:

```
resolveShopAccess(uid, shopId) → { role, via, shopOwnerId }
assertShopAccess(uid, shopId)  → wrapper over role
assertShopOwner(uid, shopId)   → filters on `via`, NOT a second lookup
```

`merchant-authority.assertMerchantAccess` already computes the same distinction across four
separable arms — platform claim, self, `ownerId`, `adminUids` — and **discards it**: every arm
returns the same bare string. That, not a missing check, is why it cannot express owner-vs-admin.

The decision is therefore **one authority resolver, several narrow assertions, all inside
`merchant-authority.js`**:

```
resolveMerchantAccess(auth, requested) → { merchantId, via }
        │
        ├── assertMerchantAccess()   unchanged signature, unchanged return
        └── assertMerchantOwner()    filters on `via`
```

`assertMerchantAccess` keeps its exact contract so `procurement.js` and the twelve payroll call
sites are untouched. **FORBIDDEN:** a seventh implementation, and changing
`assertMerchantAccess`'s return type.

#### The `via` taxonomy, and the `self` boundary

This is contractual, not an implementation detail.

| `via` | granted because | employment authority |
|---|---|---|
| `owner` | `businesses/{merchantId}.ownerId == uid`, **document read** | ✅ eligible |
| `admin` | `adminUids[]` contains uid | ❌ not eligible |
| `self` | `merchantId === auth.uid`, **no document read at all** | ❌ **never eligible** |
| `platform` | `token.admin` **or** `token.superAdmin` — the two are **not** distinguished | ✅ eligible · **ratified 2026-09-20** |

**The `self` arm is the one that matters.** The shipped primitive returns on `merchantId === uid`
*before reading any document*, so it cannot confirm the organization exists. That is correct and
deliberate for access — it preserves the one production business still keyed by its owner's uid —
and **wrong for employment**: inherited blindly it would let any authenticated user establish
employment in an "organization" that is nothing but their own uid, minting `hrStaff` records under
it.

**Therefore:** the employment owner resolver must require `businesses/{merchantId}` to **exist**
before establishing, rebinding, suspending, terminating or reinstating. Ownership of an
organization that was never created is not ownership.

#### 2a — platform-admin employment authority · **DECIDED 2026-09-20**

**A platform administrator MAY perform all five owner-only employment acts**, and **`admin` and
`superAdmin` carry the same authority** — one bypass, no fifth taxonomy value. The ✅ in the
capability table is **ratified**, and the `via` taxonomy is **frozen at four values**.

Decided on house precedent. Two existing owner-only gates already admit platform admins, and the
closest analogue governs staff management — nearly the same act:

```js
// shop-employees.js — "Owner (or platform admin) only — for staff management."
if (r.via !== 'owner' && r.via !== 'admin') throw permission-denied;

// shared/errors.js assertOwner — "Admins bypass ownership check."
const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;
```

Both also treat `admin` and `superAdmin` identically, so the non-distinction is a codebase-wide
convention rather than an oversight in `merchant-authority`. Diverging here would have made payroll
the single exception, which is how parallel authority models start.

**The asymmetry was weighed and did not change the answer.** Shop staff management grants *access*;
employment establishment creates a *salary obligation*. That is a real difference, and it is
answered by §6 rather than by refusing the act: **every employment event records `changedBy` and a
`reason`**, so a platform-actor act is distinguishable from an owner's act after the fact. The
control is the audit record, not the refusal.

> **Consequence, stated plainly:** a SOKONI platform administrator can create a salary obligation
> inside a merchant's organization. Production holds three such principals, two of whom also hold
> `superAdmin`. This is accepted deliberately, and it is the reason mechanism #4 — employment
> history — is not optional.

### 3. `hrStaff.uid` means an accepted binding, never an assertion

`hrStaff.uid` is **the Firebase Auth uid of the human this employment record pays**. It is set only
by an act the employee participated in.

**FORBIDDEN:** an owner setting `uid` to an arbitrary value they typed. That is an assertion about
who gets paid, made by the party paying. Binding is **two-sided**: the organization invites, the
holder of the account accepts. Knowing an employee number is not proof of being that employee.

Consequence: `uid: null` is a legitimate, expected state. A record with `uid: null` is a real
employment record that simply has no account attached yet — it is **PENDING**, not broken.

### 4. Uniqueness

```
one uid        →  many organizations          ✅  permitted and intended
one org + uid  →  at most ONE active record   ✅  invariant
```

Today `hrStaff` is keyed `${merchantId}_${employeeNumber}`, so uniqueness is per **employee
number**, not per person: the same human may hold two active records in one organization under two
numbers, and with `uid` unset nothing can detect it.

#### DECIDED 2026-09-20 — a uniqueness claim, created and deleted transactionally

```
employmentUidClaims/{businessId}_{uid}
```

**Why a claim is NECESSARY, not stylistic.** `acceptEmploymentInvite` reads exactly two documents —
`employmentInvites/{token}` and `hrStaff/{staffId}`. That read set already makes **same-invite
replay** safe by contention. It does **nothing** for this invariant: two employments in the same
business (`E001`, `E002`) invited to the same address and accepted concurrently read **disjoint**
documents, so nothing contends and **both commit**. The claim is the only document those two
transactions would share.

**`create()`, never `get()` + `set()`.** `a621ba7` left the diagnosis in `finos-utils.js`: a
pre-check outside the transaction, a transaction that reads nothing, and therefore no contention —
*"eight concurrent callers, eight rows, zero reported duplicates. A returned `duplicate: true` is
not evidence; the ledger state is."* The same shape is in production in at least eight modules. A
loser catches `already-exists` (gRPC code 6); **anything else is re-raised** — a failed write must
never read as success.

#### The claim is an EXISTENCE ASSERTION, and nothing else

```
claim exists  →  this (businessId, uid) currently has an ACTIVE employment binding
claim absent  →  that uid is available in that business
```

**FORBIDDEN:** a `status`, `released`, `active` or any other mutable field on the claim. The
moment it carries state it stops being a claim and becomes a second, smaller authority on employment
— and a wrongly-written `released` would silently permit a duplicate. `create()`'s entire value is
that **existence is the answer**.

**The claim records OCCUPANCY, never HISTORY.** It is not an audit record and must never be read as
one; `employmentEvents` remains the sole historical authority (§6).

#### Lifecycle — create and delete inside the state transition

| operation | claim operation |
|---|---|
| accept invitation | `create` |
| terminate an active employment | `delete` |
| rehire through a new invitation | `create` |
| revoke a **pending** invitation | none — nothing was ever bound |
| uid rebind | `delete` old **+** `create` new, atomically |
| reinstate a terminated employment | `create` |
| a failed claim `create` | the **entire** transaction fails |
| a failed new-uid claim during rebind | the old binding and old claim are **retained** |

A failed `create()` means no uid binding, no event, no accepted invitation — nothing partial.

#### uid_rebound is a TWO-CLAIM transition, in one transaction

```
old claim exists  ─┐
staff.uid = old   ─┼─ ONE transaction ─→  delete old claim
new claim ABSENT  ─┘                      create new claim
                                          update staff.uid
                                          emit uid_rebound
```

**FORBIDDEN:** deleting the old claim unless the new one can be established in the same transaction.
A rebind that released the employee's existing identity and then failed would leave them bound to
nothing while their old uid became claimable by someone else. The transaction **fails closed** if
`{businessId}_{newUid}` already exists.

#### Reinstatement RE-ACQUIRES, and may legitimately fail

Termination releases the claim, so a terminated employment holds no reservation. Reinstatement must
`create` the claim again, and fails if another active employment has taken it meanwhile.

```
E001 / UID-A  →  terminated        claim released
E002 / UID-A  →  accepted, active  claim taken by E002
E001 / UID-A  →  reinstate         FAILS — E002 holds it
```

**That is not an edge case to be smoothed over.** It follows directly from *one organization, at most
one active employment per uid*. A terminated employee does **not** hold an eternal reservation on
their uid.

#### Deliberately outside mechanism #1

**Who may terminate, rebind or reinstate.** Those authority rules belong to the mechanism ordering
already established (§2, and mechanisms #5/#7), and must not be invented inside the uniqueness gate.
Mechanism #1 supplies the invariant; it does not decide who may trigger the transitions that move it.

#### Proof plan — emulator-backed, because the question IS contention

The in-process harness in `test-employment-invites.js` **serialises transactions** and says so. It
cannot reproduce a race. The core proof must run against the Firestore emulator with genuinely
concurrent transactions, following `scripts/test-order-claim-race.js`:

> *"A test that calls the claim twice in sequence proves nothing about a race … Every claim below is
> fired with `Promise.all` against a live emulator — no mocks, no stubs, no simulated ordering."*

At minimum:

1. 10 concurrent accepts, different pending employments, same business + uid → **exactly one** active
2. same uid across **different** businesses → both succeed
3. termination releases the claim
4. a new employment can then acquire the released claim
5. concurrent rehire/acceptance, same business + uid → exactly one active
6. reinstatement colliding with another active employment → fails
7. rebind to an unused uid → succeeds
8. concurrent rebind/acceptance targeting the same new uid → exactly one succeeds
9. a failed claim `create` produces **zero** employment mutation and **zero** employment event
10. same-invite replay remains safe
11. claim state after every scenario matches active-employment occupancy exactly

**Final assertions must inspect FIRESTORE STATE**, never a returned `{ duplicate: true }` or an
error value. The money-path harness's own finding is the reason: eight callers each reported success
while the ledger held eight rows.

### 5. Two axes, never one status

Employment lifecycle and current work state are **different facts** and must not share a field.
Leave and suspension do not end employment; termination does.

```
employmentStatus :  pending  →  active  →  terminated
workStatus       :  working  |  on_leave  |  suspended
```

So an employee is describable as `employmentStatus: active` + `workStatus: on_leave`, and later
`active` + `suspended`, without either state pretending the employment ended.

```
EMPLOYMENT
    │
    ├── PENDING ──accept──▶ ACTIVE
    │                         │
    │                         ├── working    → shop access ✓
    │                         ├── on_leave   → shop access ✗ ──scheduled end──▶ working ✓
    │                         └── suspended  → shop access ✗ ──lifted─────────▶ working ✓
    │
    └── TERMINATED  → shop access ✗   ──reinstate──▶ ACTIVE / working
                      record + payroll history RETAINED
```

`workStatus` is meaningful **only** while `employmentStatus == 'active'`. A terminated record's
`workStatus` is not consulted.

#### The field is named `employmentStatus` in the CODE too — AMENDED 2026-09-20

`hrStaff` currently carries a field called `status`, and `addStaffMember` writes
**`status: 'active', uid: null`** — a state this model says cannot exist, since `active` is the
payable state and nothing is bound to pay. `runPayroll` selects `where('status','==','active')` and
**never consults `uid`**, so an employment record with no identity is payable today. `hrStaff` is
empty in production, so nothing has exercised it.

The contract and the code will use **one name**. Keeping `status` while the ADR says
`employmentStatus` is the `employeeNo` / `employeeNumber` defect again — a field the writer and the
reader spell differently — which is where this whole sequence began.

**Establishment produces `employmentStatus: 'pending'`, `workStatus: null`, `uid: null`.** The
`active + uid: null` birth path is eliminated, not merely deprecated.

Traced blast radius — **four consumers, no rules, no indexes, no other writer**:

```
functions/hr-payroll.js:592    runPayroll          where('status','==','active')   payability
functions/hr-payroll.js:1261   getStaffDashboard   where('status','==','active')   active count
hr-payroll.html:1067           s.status === 'active'                               a badge
hr-payroll.html:1528           s.status !== 'inactive'                             the active filter
```

That last line tests `'inactive'`, **a value no writer has ever written** — so the field's
vocabulary is already incoherent between writer and reader. The rename surfaces that; leaving the
name alone would preserve it.

**FORBIDDEN:** repairing payroll's payability rule while making this change. Mechanism #3 changes
the state establishment CREATES; whether `on_leave` or `suspended` are payable, and whether
`runPayroll` should consult `uid` at all, is §Open 6 and belongs to mechanism #6.

#### Owner actions

| action | employment | work | active roster | record kept |
|---|---|---|---|---|
| **Employ** | `pending` → `active` on acceptance | `working` | yes | yes |
| **Give leave** | `active` | `on_leave` | yes | yes |
| **Suspend** | `active` | `suspended` | no | yes |
| **Unemploy / terminate** | `terminated` | n/a | no | yes |
| **Reinstate** | `active` | `working` | yes | yes |
| **Rebind uid** | unchanged | unchanged | unchanged | yes **+ audit** |

**FORBIDDEN:** physically deleting an employment record, or a payslip, attendance, leave or training
record, for any of these actions. The active-employee list *excludes*; it never *destroys*. Former
Employees and Employment History retain everything. A January, February and March payslip must not
outlive the record that explains them.

**FORBIDDEN:** setting `uid = null` to make someone unavailable. The uid is the identity binding;
availability is `workStatus`. Clearing the binding would destroy the link between a human and the
payslips already issued to them.

#### Shop access is a backend predicate

```
CanAccessShop(caller, employee) =
      employee.employmentStatus == 'active'
    ∧ employee.workStatus       == 'working'
    ∧ employee.uid              == caller.uid
    ∧ the shop assignment is valid for this employment
```

**The disappearing dropdown is a UI consequence, never the control.** A hidden control is a
convenience for the honest; the server must refuse the endpoint regardless of what the browser
renders. Per [[feedback_firestore_rules_do_not_secure_callables]] this predicate has to be enforced
in the callable, not only in rules, and per [[ADR-013]] the client expresses intent while the server
establishes authority.

| state | uid bound | dropdown | shop access |
|---|---|---|---|
| active / working | yes | visible | **allowed** |
| active / on_leave | yes | hidden | denied |
| active / suspended | yes | hidden | denied |
| leave period ends | yes | visible again | restored |
| suspension lifted | yes | visible | restored |
| terminated | binding retained, access revoked | hidden | denied |

#### Leave is time-aware; suspension is not

Scheduled leave carries a window (`hrLeaves` already stores `startDate` / `endDate`) and
**restores itself** when the window closes — no manual re-enable for ordinary leave. Suspension has
**no automatic restoration**; it ends only by a deliberate act. If scheduled suspension is wanted
later, it reuses the same window mechanism.

> **Open — and consequential (§Open 5).** Whether `workStatus` is **stored** and swept, or
> **derived** at read time from the leave window. A stored value that a missed sweep never flips
> locks a returning employee out, or — worse — leaves a departed one in. A derived value is always
> correct but costs a leave read on every access check. The repo has precedent for the swept form
> (attendance is swept hourly to `AUTO_CLOCKED_OUT`), which is precisely why the failure mode is
> known rather than hypothetical.

#### Payroll eligibility is a conjunction, never a uid check

```
eligible = record exists
         ∧ record.merchantId       == the authorized organization
         ∧ record.employmentStatus == 'active'
         ∧ record.uid             != null
         ∧ (workStatus policy — see below)
```

**FORBIDDEN:** treating "has a uid" as eligibility.

> **Open — policy, not mechanism (§Open 6).** Whether `on_leave` and `suspended` remain payable.
> These are employment-policy questions with legal weight in Kenya, and this ADR does not decide
> them. Note that `hrLeaves` already carries a leave-type vocabulary including `unpaid`, so a
> paid/unpaid distinction has a home; suspension has none yet.

**Verified, not assumed:** the shipped `runPayroll` selects
`.where('merchantId','==',merchantId).where('status','==','active')`. The two-axis model renames
that field to `employmentStatus`, so **that query must change** — a one-line change, with **zero
migration cost**: `hrStaff` holds 0 documents. Recorded here because renaming a field a live query
depends on is exactly the kind of silent breakage this ADR exists to prevent.

### 6. Employment history is its own record

**AMENDED 2026-09-20.** A first draft listed seven events and no system actor. A read-only design
pass found three gaps: `suspend` and `give leave` were owner actions in §5 with no event in §6;
scheduled leave ends with no human performing it; and an auto-id cannot make a retry idempotent.

Current employment state cannot answer "who suspended this employee, when, and why" — a document
holds the present, not the sequence.

#### The record

```
employmentEvents/{staffId}_{eventKey}

  businessId       SOK-XXXXXX      never parsed out of the key
  staffId          {merchantId}_{employeeNumber}

  event            one of the TWELVE below

  previousUid      string | null   populated on uid_rebound
  newUid           string | null

  previousStatus   { employmentStatus, workStatus } | null
  newStatus        { employmentStatus, workStatus } | null

  actorType        'human' | 'system'
  changedBy        uid | null      null ONLY when actorType is 'system'
  changedVia       'owner' | 'platform' | 'system'

  reason           REQUIRED, non-empty

  at               serverTimestamp()
  ts               Date.now()
```

#### Twelve events — every lifecycle transition is its own event

```
employment_established     invite_sent       invite_accepted     invite_revoked
uid_rebound
leave_granted              leave_ended
employment_suspended       suspension_lifted
employment_terminated      employment_reinstated
record_edited
```

**`record_edited` is reserved for ordinary employment DATA** — position, department, grossSalary,
startDate, phone, email. **FORBIDDEN:** absorbing a lifecycle transition into it. An auditor asking
*"who suspended this employee?"* or *"when did the leave start and end?"* must not have to infer the
answer from which fields happened to change inside a generic edit.

#### previousStatus / newStatus carry BOTH axes

```
salary edit    { active, working }   → { active, working }      identical, and that is correct
leave granted  { active, working }   → { active, on_leave }
suspended      { active, working }   → { active, suspended }
terminated     { active, suspended } → { terminated, null }
```

Recording both axes is what makes the transition unambiguous; a single status field could not
distinguish a suspension from a termination.

#### The system actor is explicit, never a fake uid

Scheduled leave restores itself (§5), so `leave_ended` has no human performer. **FORBIDDEN:**
writing a sentinel such as `"system"` into `changedBy`, which is a Firebase uid field. The actor
is structured instead:

| transition | actorType | changedBy | changedVia |
|---|---|---|---|
| owner suspends | `human` | owner uid | `owner` |
| platform admin terminates | `human` | platform uid | `platform` |
| **invitee accepts their own invitation** | `human` | **invitee uid** | **`invitee`** |
| scheduled leave completes | `system` | `null` | `system` |

```
actorType 'human'  → changedVia ∈ { owner, platform, invitee }   changedBy REQUIRED
actorType 'system' → changedVia === 'system'                     changedBy MUST be null
```

#### `invitee` — AMENDED 2026-09-20, and why it is not `system`

Acceptance is performed by the **employee**, who is none of owner, platform or system. Recording it
as `system` would be false twice over: a human caused it, and their uid is right there in
`request.auth.uid`. The value separates **who acted** from **how that actor was authorized for that
particular transition** — an invitee is authorized for exactly one transition, on exactly one
employment, by holding the invited identity.

> **TWO VOCABULARIES, DELIBERATELY DIFFERENT. Do not merge them.**
> `resolveMerchantAccess` returns `via ∈ { owner, admin, self, platform }` — **frozen at four**
> (§2) — and it never returns `invitee`: there is no organization-authority arm for an invitee,
> because accepting an invitation is not organization authority.
> The history's `changedVia ∈ { owner, platform, invitee, system }` is a different set that merely
> overlaps. `admin` and `self` are absent from it because neither may cause an employment
> transition at all; `invitee` and `system` are absent from the resolver because neither is a way
> of being authorized for an organization.

For the transitions the resolver does decide, `changedVia` is **not re-derived from the token** —
it is the `via` that `resolveMerchantAccess` already returned. The authority layer decides it once;
the history records what was decided. A scheduled suspension end, if ever added, reuses the same
system actor.

#### Mechanism #3 consumes exactly four of the twelve — AMENDED 2026-09-20

| event | before | after | actor |
|---|---|---|---|
| `employment_established` | — | `pending` / `null` | owner \| platform |
| `invite_sent` | `pending` / `null` | `pending` / `null` | owner \| platform |
| `invite_accepted` | `pending` / `null` | `active` / `working` + bound uid | **invitee** |
| `invite_revoked` | `pending` / `null` | `terminated` / `null` | owner \| platform |

The other eight remain unconsumed; they belong to mechanisms #1, #5 and #7.

**`invite_revoked` was RECONSIDERED on 2026-09-20 and AFFIRMED.** The objection was fair — the
evidence proves an *invitation* can be revoked, not that a *pending employment relationship* should
end — and two alternatives were weighed: leaving the record `pending` (which re-creates the
never-closing record this decision exists to prevent, unless something else closes it), and adding
a fourth `employmentStatus: 'revoked'` (which widens a three-value axis and every consumer of it).
**Neither was adopted.** If product later needs a distinct revoked state, or direct resurrection of
a pending employment, that is a deliberate future amendment — not something introduced
opportunistically while implementing #3.

> **KNOWN PRE-#1 GAP, recorded deliberately.** Mechanism #3 does **not** enforce the
> `(businessId, uid)` uniqueness invariant of §4. `invite_accepted` binds a uid without checking
> whether that uid already holds an active employment in the same organization, so two active
> records for one person in one business are reachable until mechanism #1 lands. This is a stated
> gap, not an oversight: enforcing it inside #3 would pull #1's uniqueness mechanism — claim
> document versus transactional query, still undecided — into the binding gate.

#### Idempotency lives in the document id

**FORBIDDEN:** an auto-id, and `get()` + `set()` to establish uniqueness. An auto-id makes every
retry a new row; a get/set claim loses races — eight concurrent calls once produced eight ledger rows
([[project_idempotency_claim_must_be_create]]). The transition's identity IS the key:

```
{staffId}_employment_established
{staffId}_invite_accepted
{staffId}_uid_rebound_{transitionId}
{staffId}_leave_{leaveId}_granted        {staffId}_leave_{leaveId}_ended
{staffId}_suspension_{suspensionId}_started   {staffId}_suspension_{suspensionId}_lifted
```

Events that can legitimately recur are discriminated by the id of the thing they act on, never by a
counter. Written with `create()`, or `set()` **inside the same transaction as the state change**
so the record and its event land together or not at all — the `bookingEvents` pattern, which
returns `{ ref, payload }` rather than writing, exists for exactly this.

#### Reads: a callable for the organization, a rule for the employee

**FORBIDDEN:** an owner read arm in Firestore rules. `resource.data.businessId == request.auth.uid`
is the `merchantId == auth.uid` mistake again — it holds for exactly one production business.
Organization history is read through a **callable** that calls `assertMerchantAccess` first.

The rule grants writes to nobody and a narrow self-read:

```
create, update, delete : false            server-only, Admin SDK
read                   : isAdmin()
                         || resource.data.newUid == request.auth.uid
```

**Never `previousUid`.** A person whose binding was replaced would otherwise keep reading the
employment's future history. Events before `invite_accepted` carry no `newUid` and are therefore
admin-only by construction — correct, because there is no employee yet.

#### Retention

**Indefinite. Deletion forbidden, including for administrators.** A history that can be pruned is
weaker than the records it witnesses. `adminLog` permits `allow delete: if isSuperAdmin()`; that
precedent is **not** followed here, for the same reason 2a's platform authority is backed by an audit
record rather than a refusal.

#### Two rules on rebinding

* a detached uid **does not** become a second employee merely by being detached;
* a new uid **must not** already hold an active employment in the same organization (§4).

**FORBIDDEN:** inferring history from the current `hrStaff` document, and writing history from the
client.

> **Known constraint (§Open 4a).** Useful history queries — `businessId` + `at desc`, `staffId`
> + `at desc` — need **two new composite indexes** in a file that already holds 408, and index
> deploys are independently contested. Mechanism #4 can be built and certified without them; it
> cannot be *exercised against production* until that is settled separately.

### 7. AdminOS is where employees are managed

```
AdminOS ▸ Business ▸ Employees
                       ├── Active
                       ├── Pending        (invited, not yet accepted)
                       ├── Former
                       ├── Employee profiles
                       ├── Roles & permissions
                       └── Employment history
```

Per [[feedback_adminos_canonical_workspace]], no new admin UI elsewhere. POS, attendance, leave,
training and payroll **consume** the employment relationship; none of them mints employee
identities.

---

### 8. A finding this ADR deliberately does NOT repair

The same trace found that `crm.assertMerchantOwner` — **misnamed: it accepts `adminUids` too, so
no merchant-level owner-only authority exists anywhere today** — carries the exact fail-open that
`merchant-authority.js` was written in August to replace:

```js
if (data.ownerId !== uid && data.adminUids && !data.adminUids.includes(uid)) throw …
```

Executed against both shapes:

```
adminUids present, stranger  → throws  true
adminUids ABSENT,  stranger  → throws  undefined   ← NON-OWNER GRANTED
control: owner                → throws  false
```

With `adminUids` absent the middle conjunct is `undefined`, the condition is falsy, and a stranger
is admitted. Twelve call sites. It reads `merchants`, the collection this ADR's authority module
explicitly forbids as an independent authority. **Currently latent** — all 8 production `merchants`
documents carry `adminUids` and `business-bootstrap` always writes it — exactly as
`merchant-authority.js`'s own header predicted on 2026-08-28: *"latent only because every existing
merchant happens to carry the field."* The consolidation it describes never happened.

**FORBIDDEN:** repairing this inside the Gate 3 owner primitive. It is a separate security and
adoption-gap repair with its own evidence and its own certification; bundling it would make the
change compound and the resulting proof ambiguous. Recorded here so the naming discrepancy is not
rediscovered as a new finding. See [[project_merchant_authority_adoption_gap]].

---

## What this ADR does **not** decide

Deliberately left open, because each is a mechanism choice that deserves its own evidence:

1. **The uniqueness mechanism** — **DECIDED** (§4): an existence-only claim at
   `employmentUidClaims/{businessId}_{uid}`, `create()`d on binding and deleted on
   termination, with two-claim atomic rebind and re-acquiring reinstatement. **Ready for
   implementation design**; the proof must be emulator-backed, because the question is
   contention.
2. **The owner-authority primitive's naming** only. Shape decided (one resolver returning `via`,
   inside `merchant-authority.js`); semantics decided (**2a**, above). **Ready for implementation
   design.**
3. **The invite/acceptance transport** — whether `shopInvites` (0 documents, one writer,
   `acceptShopInvite`) is reused or a payroll-specific path is built (§3).
4. **The history collection's identity** — settled in §6 as amended: `employmentEvents`, keyed
   `{staffId}_{eventKey}`, twelve events, explicit system actor, server-only writes, indefinite
   retention. **(4a)** the two composite indexes it needs remain blocked on the separate index
   question. **Ready for implementation design.**
5. **`workStatus` stored-and-swept vs derived-from-window** (§5). The failure modes differ and
   both are real; neither is obviously right.
6. **Whether `on_leave` and `suspended` remain payable** (§5) — employment policy, with legal
   weight, and not a decision an authorization repair may make by accident.
7. **Where the shop-assignment lives** (§5, §1) — the employment record, a separate assignment
   record, or the existing `posStaff` branch row, which ADR-017/ADR-020 de-authorized for
   workforce decisions and which this ADR does not rehabilitate.

**No implementation is authorized by this ADR.** It freezes the contract so those four can be
decided on evidence rather than discovered mid-patch.

---

## Consequences

**Good.** Payroll eligibility becomes a stated conjunction instead of an accident of which fields
happen to be populated. `uid: null` stops being a latent defect and becomes a named state. The
owner/admin split makes "who may decide that someone gets paid" a different, narrower permission
than "who may edit an employee". Termination stops threatening financial history.

**Costly.** Three of the six `hr*` Firestore rules currently grant a self-read arm on fields no
writer writes — `hrAttendance.uid`, `hrPayslips.staffUid`, `hrLeaves.uid`. They are dead today and
stay dead until §3 lands; repairing them before an identity exists would change nothing observable.
That repair is sequenced **after** this contract, not before it.

**Good, second order.** Shop access stops being "does a uid exist" and becomes a question about
current employment state, which is the same question payroll asks. One fact, two consumers.

**Accepted risk.** A two-sided binding means an organization cannot unilaterally complete an
employment record, so onboarding takes two parties and two steps. That is the point: the alternative
is an employer naming, unchallenged, the account that receives a salary.

---

## Evidence

Production census 2026-09-20 (read-only, `admin.firestore().count()`); `functions/hr-payroll.js` at
`ef2ce4c`; `functions/merchant-authority.js`; `firestore.rules`.
Certification in force: `test-payroll-merchant-authority.js` 96/0,
`test-payroll-record-authority.js` 66/0, `test-payroll-staff-contract.js` 27/0.

Related: [[project_workforce_authority_convergence]], [[project_merchant_authority_adoption_gap]],
[[project_sokoni_store_first_party_identity]], [[ADR-013]] (POS write authority).
