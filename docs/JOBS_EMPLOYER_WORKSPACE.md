# Jobs Employer Workspace (merchant-v2)

Related: [[JOBS_BOARD_CONVERGENCE]] (server, on `functions/jobs-on-ca55f8b`) · [[MERCHANT_ROUTE_MATRIX]] ·
[[NAVIGATION_CONTRACT]] · [[Notifications]] · [[Marketplace]]

**Status (2026-10-03): BUILT on the hosting chain (`hosting/jobs-employer-on-bc9a48c`, base `bc9a48c`). NOT deployed.
Browser certification QUEUED (RAM floor).** This is slice J5's employer half.

## Release note (read first)

- **Deploy together:** server `a515270` (J2 moderation, which carries J1 `ffa2c47`) **and** these pages. The old employer
  UI (`job-post.html` / `sokoni-jobs.js`) moves applications without a reason or expected version, and the new server
  refuses a rejection without a reason and a hire without an accepted offer.
- **Order:** the Jobs rules hotfix (`33b2ae4`, or the combined candidate `94ea7c6`) ships **first**. J2 itself ships
  atomically with the AdminOS Jobs section (see [[JOBS_BOARD_CONVERGENCE]]); turning on review before an admin can
  approve would stop every vacancy from publishing.
- **Nothing deploys without the owner.** The hosting deploy must descend from the live hosting commit and carry the
  hosting-chain fixes; see the hosting assembly manifest.

## Layout

The owner's layout lives in the shell. These are routes and modules, not a separate dashboard. There are eleven routes
in a new **Jobs** sidebar group (`MORE_GROUPS` key `jobs`, tier `more`, each in exactly one group):

| Route id | Sidebar name | View | Source of everything on it |
|---|---|---|---|
| `jobs-overview` | Jobs Overview | overview | job list + `getJobApplications` |
| `jobs` | Jobs | jobs | job list; `createJob` / `updateJob` / `submitJob` / `pauseJob` / `resumeJob` / `closeJob` |
| `jobs-applications` | Applications | applications | `getJobApplications`, `updateApplicationStatus`, `getApplicationHistory` |
| `jobs-candidates` | Candidates | candidates | derived from the applications (no candidate database) |
| `jobs-interviews` | Interviews | interviews | applications with status `interview` |
| `jobs-offers` | Job Offers | offers | applications with `offer` / `offer_accepted` / `offer_declined` |
| `jobs-messages` | Job Messages | messages | none (a disabled control; see below) |
| `jobs-company` | Company | company | `shops/{uid}` name, the same source `createJob` uses |
| `jobs-wallet` | Jobs Wallet | wallet | none ("Not available yet") |
| `jobs-products` | Jobs Products | products | none ("Not available yet") |
| `jobs-analytics` | Jobs Analytics | analytics | job counters (`viewCount`, `applicationCount`) + loaded applications |

The ids are `jobs-`-prefixed because `products`, `messages`, `analytics` and `offers` already exist as shop routes. The
names say "Job…" or "Jobs…" wherever they would otherwise collide in the ⌘K palette.

All eleven routes mount one module, `sokoni-merchant-jobs.js` (`SokoniMerchantJobs.mount(host, ctx)`, with `ctx.view`).
The module keeps one store per signed-in uid, so moving between the routes does not refetch. The shell builds the
module context in `_jobsCtx(view)` in `merchant-v2.html`.

## Server contract consumed (shapes read from the code, not guessed)

Every write goes through `ctx.dispatch({op, …})`, which is `_callable('servicesDispatch')`, the same App Check path
every merchant callable uses.

| Op | Request | Response | Errors the page shows verbatim |
|---|---|---|---|
| `createJob` | `title, description, requirements, category, type, location, salaryMin, salaryMax, expiresInDays?, submit` (J2 only) | `{jobId, job:{…, status}}`; status is `draft`, or `pending_review` when `submit:true` | `invalid-argument` (title, description, type, category, salary, expiry) |
| `updateJob` | `jobId` plus only the changed fields | `{success, status, backToReview}` | `failed-precondition` "This vacancy can no longer be edited." |
| `submitJob` / `pauseJob` / `resumeJob` | `{jobId}` | `{success, status}` | `failed-precondition`, e.g. `A vacancy that is "Draft" cannot be paused.` |
| `closeJob` | `{jobId}` | `{success, closedApplications}` | |
| `getJobApplications` | `{jobId}` | `{applications:[{id, jobId, seekerUid, coverLetter, cvUrl, status, statusLabel, statusVersion, appliedAt, updatedAt, seekerProfile:{name, headline, skills, location}\|null}]}` | |
| `updateApplicationStatus` | `{applicationId, status, reason, expectedVersion}` | `{success, status, statusVersion}` | `aborted` "This application was updated elsewhere…", `invalid-argument` reason < 3 chars, `failed-precondition` illegal move |
| `getApplicationHistory` | `{applicationId}` | `{applicationId, status, label, statusVersion, events:[{from, to, label, actorRole, reason, at}]}` | |

The one read that is not a callable is the employer's own vacancies: `jobs where employerUid == uid`, limit 50, through
the shell's read-only `_q`. The rules allow an employer to read its own jobs in any status (sokoni-f3). Callable
timestamps arrive as `{_seconds, _nanoseconds}` and Firestore reads arrive as `Timestamp`; the module reads both.

Fields the employer view uses on `jobs`: `status`, `moderationReason`, `featured`, `approvedAt`, `closedReason`,
`expiresAt`, `applicationCount`, `viewCount`, salary, type, category and location.

## Behaviour

**Applications.** The page shows only the legal buttons for the current status (the server's `EMPLOYER_TRANSITIONS`):

| From | Buttons |
|---|---|
| `pending` | Mark under review, Shortlist, Reject |
| `reviewing` | Shortlist, Reject |
| `shortlisted` | Invite to interview, Reject |
| `interview` | Make offer, Reject |
| `offer` | Reject |
| `offer_accepted` | Mark hired |

The terminal statuses (`hired`, `rejected`, `withdrawn`, `offer_declined`, `closed`) show no move buttons.

Other application rules:
- Reject needs a reason. The page blocks an empty one, and the server's own refusal of a short one is shown word for word.
- Every move sends `expectedVersion`, which is the server's `statusVersion`.
- On `aborted`, the card says "This application changed — reload" and the page refetches that vacancy's applications.

**Vacancies (J2).**
- New vacancy: the form has "Save draft" (`submit:false`) and "Submit for review" (`submit:true`). There is never a
  "Publish" button, and the result is labelled with the status the server returned.
- Labels: Draft, Pending review, Changes requested, Published, Paused, Closed (or "Closed — expired" when `closedReason`
  is `expired`), Archived, Rejected. An unknown status is shown as stored.
- `moderationReason` is shown, escaped, on changes requested, rejected, admin pause and admin close.
- Buttons by status:

| Status | Buttons |
|---|---|
| draft | Edit, Submit for review, Close |
| pending_review | Edit, Close |
| changes_requested | Edit, Submit for review, Close |
| active | Edit, Pause, Close, Applications |
| paused | Edit, Resume (only if `approvedAt` is set, the vacancy has not expired and it is not an admin pause), Close, Applications |
| closed | Applications |
| rejected, archived | none |

- **Re-review warning.** On an active or paused vacancy, saving a change to the title, description, requirements, type
  or category first shows "Editing these fields sends the job back for review; it will be hidden until approved". The
  save only happens on "Save and send for review". After saving, `backToReview` is reflected ("went back to review").
  Salary, location and closing-date edits save without a warning.
- Close asks first, then shows the server's `closedApplications` count.
- **Featured** is a badge only. No control names feature, promote or boost.

**Feature detection (fallback to ffa2c47).** The page sends `{op:''}` once; the dispatcher refuses it and lists every
valid op (`services-dispatch.js` :68-72), and no handler runs.
- `submitJob` is listed: J2 mode.
- It is not listed: J1 mode. There is one "Post vacancy" button, labelled as going live immediately, and no submit
  flag, Pause or Submit is shown.
- The list can't be read: the form is withheld, with the reason and a retry.

Pause, Resume and Submit each appear only when their op is listed.

**Honest surfaces.**
- Wallet and Products say "Not available yet". Pricing is unpriced and switched off (owner); posting is free and
  applying is always free.
- Messages, and every application card, carry a disabled "Messaging for applications is coming". There is no WhatsApp,
  mailto or tel hand-off. `SokoniInbox.openForTransaction` does not exist on this tree; sokoni-b2 is shipping it.
- Counts are derived only from what the page loaded. Unknown is "—", never 0. An account with no vacancies shows a real
  "0". With more than 50 vacancies, totals are withheld rather than shown as partial counts.

**Gating.** Merchant-v2 has no per-module capability gate on this tree: routes are role- and context-declared, and the
only capability check is `can('sell')`. The Jobs server authorizes by uid (`employerUid`). So:
- the workspace opens for the signed-in owner;
- a staff sign-in, where the server-resolved `servedBy.role` is not the owner, is told that hiring runs from the owner's
  account, and **no call is made**. Otherwise it would post vacancies under the employee's own uid.

Nothing is gated on business category in the page. If the owner wants Jobs per business, that is a MODULES key on the
server (hand-off below).

## Tests

- `node scripts/test-merchant-jobs-workspace.js`: **34/0**. 28 rows plus 6 negative controls, each of which fails its
  named row:
  - N1, an illegal transition button, fails A1.
  - N2, `expectedVersion` omitted, fails A3.
  - N3, 0 for an unknown count, fails H3.
  - N4, a "Publish" button, fails J2.
  - N5, a feature toggle, fails J5.
  - N6, `moderationReason` unescaped, fails S3.
- Fixtures: `scripts/fixtures/jobs-workspace-server.json`, produced by `node scripts/gen-jobs-workspace-fixtures.js`.
  It runs the **real** handlers of `a515270` and `ffa2c47` `functions/jobs.js` in memory, using the module-stub harness
  of `a515270:scripts/test-jobs-moderation.js`. It also lifts the server's `EMPLOYER_TRANSITIONS` / `STATUS_LABEL` /
  `JOB_LABEL` tables, so the legal-button matrix is compared against the server, not against the page's copy. To
  regenerate after a server change, both commits must be in the local object store.
- `scripts/test-mv2-1-sidebar.js` 14/0. R3 now expects the headings Sales / Operations / Commerce / Growth / Back office
  / Jobs.
- `scripts/test-merchant-routes.js` 65/0, `test-route-native-sec-contract` 33/0, `test-merchant-v2-panels` 20/0,
  `test-module-tokens` 11/0, `test-merchant-exit-contract` 18/0, `test-merchant-entry` 59/0.
- These fail identically on base `bc9a48c` and are **not caused by this slice**:
  - `test-merchant-capability` 44/2. Its "exactly 12 / only 2 withheld" pins were already stale: the base has 14 and 4,
    and the Jobs routes add 11 withheld-in-v1 rows by design.
  - `test-merchant-shell-callables` 18/1 (`resolveMerchantContext` missing).
- **QUEUED (browser, RAM floor):**
  - `test-merchant-v2-modules`, `test-merchant-route-gate`, `test-merchant-visual-gate`;
  - a 390px pass of the eleven Jobs routes: no horizontal scroll, buttons touchable, an authenticated owner session
    against the emulator with a515270.

## Open items

- **sokoni-f3 (server):**
  1. An employer can `resumeJob` an **admin**-paused vacancy. The server only checks `approvedAt` and expiry, and the
     page hides Resume when `moderationReason` is set. The fix needs a pause-origin field.
  2. A `getEmployerApplications` op (one call instead of one per vacancy) and a `listMyJobs` op would replace the
     fan-out and the direct read.
  3. Keep the dispatcher's "Valid ops:" message format, or add a `jobsCapabilities` op; feature detection reads it.
  4. Business-keyed employers (jobs keyed to a business, not the poster's uid) are a later server slice. No bridge was
     invented here.
- **sokoni-b2 (messages):** J4. When `job_application` is a real transaction type with server-derived parties
  (`jobId + applicationId + employerUid + seekerUid`), replace the disabled button with
  `SokoniInbox.openForTransaction('job_application', applicationId)`.
- **sokoni-5b (MODULES):** if Jobs should be enabled per business, add a `jobs` capability to the server-resolved
  merchant capabilities (`merchantIdentity`). The page would then gate the Jobs group with `can('jobs')` instead of
  showing it to every owner. Hand-off text: *"Add MODULES key `jobs` (employer workspace). Default ON for owners;
  employees OFF unless granted. Reason: the Jobs server authorizes by uid, so an employee session posts as itself."*
