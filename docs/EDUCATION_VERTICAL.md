# Education vertical — authority map, decisions and status

Owner: sokoni-5b · Opened 2026-10-03 · **Nothing in this document is deployed.**

Related: [[Authentication]] · [[Payments]] · [[Marketplace]] · [[FOOD_HUB_GATE1_APPROVAL]] · [[COMMISSION_COLLECTION_ARCHITECTURE]]

## 1. Census (2026-10-03, read-only)

The live vertical is one page, `education.html` + `sokoni-education.js`, backed by nine callables in
`functions/education.js` (`courses`, `courseEnrollments`, `courseProgress`, `courseReviews`; client writes denied).

| Finding | Where | Disposition |
|---|---|---|
| Body "Sign Out" under the search box navigated mid-sign-out and skipped `window.sokoniSignOut` | `education.html:591`, `sokoni-education.js:192` | **Removed** (E1 hosting `131c1eb`) |
| Paid enrolment debited `wallets/{uid}.balance` with no ledger, no instructor credit, no commission | `education.js` `enrollCourse` | **Refused server-side** until IntaSend (E1 functions `aea1cdb`, base = live archive `de6888b`) |
| Missing / negative course price enrolled for free | same | **Refused** (`aea1cdb`) |
| `createCourse` said "submitted for review" while saving a draft; no client submits; no admin publish UI | `education.js`, `sokoni-education.js` | Toast made honest (`131c1eb`); lifecycle is E2 |
| "Teach on SOKONI" open to every signed-in user | `education.html` | E2 (instructor identity = approved teacher/institution) |
| Lessons are synthetic; progress self-attested; no live video | `sokoni-education.js` | E3 / E4 |
| Applications split across four surfaces; hub-register plan picker is a label | `hub-register.js`, onboarding pages | **E1 applications** (below) |
| Orphan `education/{docId}`: client-writable, no writer, three live triggers feed Typesense | served rules ~1835; `ts_education_on{Create,Update,Delete}` | Rules closed on the combined candidate (f3 `d692e54`); guard test `786ee07`; trigger deletion + index purge = separate owner-gated change |

## 2. Owner decisions (2026-10-03)

- **Commission:** 5 % paid by the teacher / institution, once per sale; the learner pays the listed price. Set in the ONE
  catalogue by sokoni-2f (`RATES.education`, commercial-fn `539795c`). Never hard-coded.
- **Live classes:** LiveKit; the server mints a per-learner join token only after verified entitlement.
- **Paid enrolment:** OFF until it runs through IntaSend (verified webhook → held → settlement).
- **Applicant types:** teacher (`tutor`), institution (`school`, `online-course`), enterprise = a company **buying**
  training (`education-enterprise`). Learner = an instant profile, never an application.
- **Minors:** guardian **account** links. Unverified learners get free self-paced learning only.
- **Driving schools** stay with Car Hub (sokoni-f3); Education never adds a second category.

## 3. E1 — who the applicant is

| Form category | Server type | Record | Provider? | Approval requires |
|---|---|---|---|---|
| `tutor` | teacher | `providers` + `education.type` | yes | `details.subjects` |
| `school`, `online-course` | institution | `providers` + `education.type` | yes | `details.registrationNo` |
| `education-enterprise` | enterprise | `educationEnterprises/{uid}` | **no** (no role, no claim) | `details.companyRegNo` + valid KRA PIN |
| — | learner | `learnerProfiles/{uid}` | no | nothing (instant) |

- The type is derived in `application-lifecycle.js` from the category id; a client field cannot change it.
- `applicationDecide` refuses an incomplete approval **before writing** (`EDUCATION_APPLICATION_INCOMPLETE`);
  `applyDecision` refuses on every other path (`blocked_incomplete` + `missing[]`). "Request info" is the change path.
- Intake questions live in `hub-register.js` `CAT_QUESTIONS` (f3's intake line); `test-education-intake.js` reads the
  server's `EDUCATION_REQUIRED` so the two cannot drift.

## 4. Learner profile + guardian links

Callable `educationLearner` (`functions/education-learner.js`): `load`, `save`, `guardianCode`, `guardianConfirm`,
`guardianRevoke`.

- Age is a **server fact only**: `users.ageVerified` (adult check) → `verified_adult`; an active `guardianLinks`
  record → `guardian_linked`; otherwise `unverified` (free self-paced only).
- `learnerAccess(db, uid)` is the ONE predicate every later gate (live, tutoring, messaging, paid) calls.
- A guardian link needs a single-use 8-character code (48 h, `create()` claim) confirmed by an **age-verified adult**
  account; never self-linked; revocable by either side or an admin (`educationAudit`).
- Guardian identity is never returned to the learner, never indexed, never visible to teachers.

## 5. Collections and rules

| Collection | Writer | Client read | Client write |
|---|---|---|---|
| `educationEnterprises/{uid}` | applicationLifecycle | owner, admin | false |
| `learnerProfiles/{uid}` | educationLearner | owner, admin | false |
| `guardianLinks`, `guardianCodes`, `educationAudit` | educationLearner | admin | false |
| `education/{docId}` (orphan) | none | as served | **false** |

Rules hunks are owned by sokoni-f3 on the combined candidate (`rules/capability-decisions-on-f20be7d`). **EMULATOR PENDING.**

## 6. Security implications

- Closes three live defects: the wallet-burning paid enrolment, free enrolment on a bad price, and the client-writable
  search-injection path through `education/{docId}`.
- No browser value decides an applicant's type, a learner's age, a guardian, or paid access.
- New callables use App Check and authentication; every refusal is tested to write nothing.

## 7. Performance implications

- `learnerAccess` costs two reads (user + one indexed `guardianLinks` query, `limit(1)`); a composite index on
  `guardianLinks (learnerUid, status)` is required before deploy.
- No new triggers. The approval path adds at most one write per provider record.

## 8. Tests

| Suite | Result | Base |
|---|---|---|
| `test-education-e1.js` (hosting) | 11/0, sabotage 5/5 | 72dca56 fails 7 |
| `test-education-paid-enrol-off.js` | 9/0, sabotage 2/2 | de6888b fails 5 |
| `test-education-applications.js` | 21/0, sabotage 6/6 | cbbce0c fails 17 |
| `test-education-intake.js` (hosting) | 17/0, sabotage 4/4 | 74474f3 fails 11 |
| `test-education-single-source.js` | 8/0 on the candidate rules | served rules fail 3 |
| `test-education-learner.js` | 27/0, sabotage 8/8 | new module |
| Rules emulator, browser suites | **UNPROVEN** — free memory below the 512 MB floor | — |

## 9. Deployment requirements (none performed)

1. Functions first, each scoped `--only functions:<name>` from its own tree:
   `enrollCourse` (`aea1cdb`, alone on its live base; Daraja removal is NOT mixed in),
   `applicationLifecycle` + `applicationDecide` (`feat/education-applications-on-cbbce0c`, carrying Food Gate 1),
   `educationLearner` (new).
2. Rules from the combined candidate after the emulator passes.
3. Hosting (`131c1eb`, `d824b58`) through the one hosting assembly, after functions.
4. Composite index `guardianLinks (learnerUid ASC, status ASC)`.
5. Separately, owner-gated: delete `ts_education_*` triggers and purge `sokoni_education`.

## 10. Roadmap

E1 applications ✔ (built) → learner profile ✔ (server built; UI next) → E2 four dashboards (enterprise never inherits
the provider dashboard) → courses + storefronts → live classes + ONE booking object → enterprise staff training →
IntaSend paid enrolment → platform receipts → 5 % settlement → business wallet → AdminOS / Super Admin Education →
break certification → deploy → education-table retirement.
