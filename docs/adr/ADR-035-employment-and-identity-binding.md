# ADR-035 — Employment and identity binding

**Status:** Accepted · **not implemented** · 2026-09-20 · **amended 2026-09-20** (§2 resolver
shape + `via` taxonomy, after a read-only authority trace; §8 records a finding this ADR does not repair)
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
| `platform` | `token.admin` or `token.superAdmin` | ⚠️ must be explicitly defined — see below |

**The `self` arm is the one that matters.** The shipped primitive returns on `merchantId === uid`
*before reading any document*, so it cannot confirm the organization exists. That is correct and
deliberate for access — it preserves the one production business still keyed by its owner's uid —
and **wrong for employment**: inherited blindly it would let any authenticated user establish
employment in an "organization" that is nothing but their own uid, minting `hrStaff` records under
it.

**Therefore:** the employment owner resolver must require `businesses/{merchantId}` to **exist**
before establishing, rebinding, suspending, terminating or reinstating. Ownership of an
organization that was never created is not ownership.

> **Open — platform-admin employment semantics (§Open 2a).** The capability table above records
> platform admin as ✅ for the five owner-only acts. That is the *provisional* reading and it is
> now explicitly under question: a platform admin establishing employment decides who a merchant
> pays. Note also that `merchant-authority` does not currently distinguish `admin` from
> `superAdmin` — both take the same bypass — so if the answer differs between them, the taxonomy
> needs a fifth value. **Until this is decided, the ✅ in that table is not ratified.**

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

**Open — to be decided before implementation:** whether the invariant is enforced by a **uniqueness
claim document** keyed `${businessId}_${uid}`, created with `create()` so contention fails rather
than overwrites, or by a **query inside a transaction**. Per
[[project_idempotency_claim_must_be_create]] a claim must be `create()`, never `get()` + `set()`;
eight concurrent calls against a get/set claim produced eight rows. The transaction form must read
before it writes.

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

Current employment state cannot answer "who rebound this uid, when, and why" — a document holds the
present, not the sequence. A dedicated append-only history is required, capturing at minimum:

```
businessId · employeeId · event · previousUid · newUid · changedBy · timestamp · reason
```

Events: `employment_established`, `invite_sent`, `invite_accepted`, `invite_revoked`,
`uid_rebound`, `record_edited`, `employment_terminated`.

**FORBIDDEN:** inferring history from the current `hrStaff` document, and writing history from the
client. Rebinding a uid is a sensitive identity operation and must be observable after the fact.

Two rules on rebinding:

* a detached uid **does not** become a second employee merely by being detached;
* a new uid **must not** already hold an active employment in the same organization (§4).

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

1. **The uniqueness mechanism** — claim document vs transactional query (§4).
2. **The owner-authority primitive's naming**, and **(2a)** whether a platform admin may perform
   the five owner-only employment acts — and whether `admin` and `superAdmin` differ (§2). The
   *shape* is now decided: one resolver returning `via`, inside `merchant-authority.js`.
3. **The invite/acceptance transport** — whether `shopInvites` (0 documents, one writer,
   `acceptShopInvite`) is reused or a payroll-specific path is built (§3).
4. **The history collection's identity** — name, key shape, rules, retention (§6).
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
