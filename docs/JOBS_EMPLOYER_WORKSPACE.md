# Jobs Employer Workspace (merchant-v2)

Related: [[JOBS_BOARD_CONVERGENCE]] (server, on `functions/jobs-on-ca55f8b`) · [[MERCHANT_ROUTE_MATRIX]] ·
[[NAVIGATION_CONTRACT]] · [[Notifications]] · [[Marketplace]]

**Status (2026-10-03): BUILT on the hosting chain (`hosting/jobs-employer-on-bc9a48c`, base `bc9a48c`). NOT deployed.
Browser certification QUEUED (RAM floor).** This is slice J5's employer half.

## Release note (read first)

- **Deploy together:** server `d922713` (the tip of `functions/jobs-on-ca55f8b`) **and** these pages. That tip carries:
  - J1 `ffa2c47` and J2 moderation `a515270`;
  - `855c8c1`, which stamps `terminalAt`;
  - `be4e1b7`: `jobsCapabilities`, `listMyJobs`, `getEmployerApplications` and `pausedByRole`;
  - `d922713`: exact `hasMore`, state labels and `listCaps`.

  The page still works against an older server (see Feature detection). Two behaviours exist only from a given
  commit: the server-side refusal to resume an admin pause (from `be4e1b7`), and an exact "more exist" signal (from
  `d922713`). The old employer
  UI (`job-post.html` / `sokoni-jobs.js`) moves applications without a reason or expected version, and the new server
  refuses a rejection without a reason and a hire without an accepted offer.
- **Order:** the Jobs rules hotfix (`33b2ae4`, or the combined candidate `94ea7c6`) ships **first**. J2 itself ships
  atomically with the AdminOS Jobs section (see [[JOBS_BOARD_CONVERGENCE]]); turning on review before an admin can
  approve would stop every vacancy from publishing.
- **Messaging needs sokoni-b2's J4 in the SAME release.** "Message applicant" requires **`4ef3301` or `a51215b` plus
  server `8aaa868` in the same release**:
  - `4ef3301` is on `hosting/techhub-on-chain`.
  - `a51215b` is on `hosting/legal-hub-on-38d2d60`, the line the assembly takes `provider-dashboard.html` from.
  - Either one has `messages.html` handling `?tx=job_application` and `SokoniInbox.TX_TYPES` including
    `job_application`.
  - The server is `messages.js` @ `8aaa868` (b2's capability tip is `427f3fb`).

  **This tree's `messages.html` has no `tx` / `txId` handling and its `sokoni-inbox.js` has no `openForTransaction`**,
  so on this tree alone the button lands on a messages page that ignores the parameters.
- **Nothing deploys without the owner.** The hosting deploy must descend from the live hosting commit and carry the
  hosting-chain fixes; see the hosting assembly manifest.

## Layout

The owner's layout lives in the shell. These are routes and modules, not a separate dashboard. There are eleven routes
in a new **Jobs** sidebar group (`MORE_GROUPS` key `jobs`, tier `more`, each in exactly one group):

| Route id | Sidebar name | View | Source of everything on it |
|---|---|---|---|
| `jobs-overview` | Jobs Overview | overview | `listMyJobs` + `getEmployerApplications` |
| `jobs` | Jobs | jobs | job list; `createJob` / `updateJob` / `submitJob` / `pauseJob` / `resumeJob` / `closeJob` |
| `jobs-applications` | Applications | applications | `getEmployerApplications`, `updateApplicationStatus`, `getApplicationHistory` |
| `jobs-candidates` | Candidates | candidates | derived from the applications (no candidate database) |
| `jobs-interviews` | Interviews | interviews | applications with status `interview` |
| `jobs-offers` | Job Offers | offers | applications with `offer` / `offer_accepted` / `offer_declined` |
| `jobs-messages` | Job Messages | messages | none: it explains that conversations open per application, and links to Applications |
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

Every call goes through `ctx.dispatch({op, …})`, which is `_callable('servicesDispatch')`, the same App Check path
every merchant callable uses. Shapes are from `d922713:functions/jobs.js`.

| Op | Request | Response | Errors the page shows verbatim |
|---|---|---|---|
| `jobsCapabilities` | none (no auth) | `{contract:'jobs-j2', moderation:true, applicationStates, jobStates, applicationStateLabels, jobStateLabels, employerTransitions, jobTypes, listCaps:{listMyJobs:200, getEmployerApplications:500}}` | |
| `listMyJobs` | none | `{jobs:[{jobId, title, companyName, category, type, location, salaryMin, salaryMax, salaryCurrency, postedAt, expiresAt, applicationCount, viewCount, featured, status, statusLabel, moderationReason, pausedByRole, approvedAt, closedReason, description, requirements}], hasMore}` (exact: limit+1); limit 200 | |
| `getEmployerApplications` | none | `{applications:[{id, jobId, jobTitle, seekerUid, coverLetter, cvUrl, status, statusLabel, statusVersion, appliedAt, updatedAt, seekerProfile}], hasMore}` (exact: limit+1); limit 500, one query | |
| `createJob` | `title, description, requirements, category, type, location, salaryMin, salaryMax, expiresInDays?, submit` (J2 only) | `{jobId, job:{…, status}}`; status is `draft`, or `pending_review` when `submit:true` | `invalid-argument` (title, description, type, category, salary, expiry) |
| `updateJob` | `jobId` plus only the changed fields | `{success, status, backToReview}` | `failed-precondition` "This vacancy can no longer be edited." |
| `submitJob` / `pauseJob` / `resumeJob` | `{jobId}` | `{success, status}` | `failed-precondition`, e.g. `A vacancy that is "Draft" cannot be paused.`, or on an admin pause `SOKONI paused this vacancy: <reason>. Only SOKONI can restore it.` |
| `closeJob` | `{jobId}` | `{success, closedApplications}` | |
| `getJobApplications` (old-server fallback) | `{jobId}` | `{applications:[{id, jobId, seekerUid, coverLetter, cvUrl, status, statusLabel, statusVersion, appliedAt, updatedAt, seekerProfile:{name, headline, skills, location}\|null}]}` | |
| `updateApplicationStatus` | `{applicationId, status, reason, expectedVersion}` | `{success, status, statusVersion}` | `aborted` "This application was updated elsewhere…", `invalid-argument` reason < 3 chars, `failed-precondition` illegal move |
| `getApplicationHistory` | `{applicationId}` | `{applicationId, status, label, statusVersion, events:[{from, to, label, actorRole, reason, at}]}` | |

**Fallback reads, used only when the server answers "Unknown services operation":** `listMyJobs` unknown → a direct
read of `jobs where employerUid == uid` (limit 50, through the shell's read-only `_q`; the rules allow it in any status).
`getEmployerApplications` unknown → one `getJobApplications` per vacancy, four at a time. Any other failure is shown
as an error. It is never silently swapped for the fallback. Callable
timestamps arrive as `{_seconds, _nanoseconds}` and Firestore reads arrive as `Timestamp`; the module reads both.

Fields the employer view uses on `jobs`: `status`, `statusLabel`, `moderationReason`, `pausedByRole`, `featured`, `approvedAt`, `closedReason`,
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
| paused | Edit, Resume (only if `approvedAt` is set, the vacancy has not expired and `pausedByRole` is not `admin`), Close, Applications |
| closed | Applications |
| rejected, archived | none |

- **Re-review warning.** On an active or paused vacancy, saving a change to the title, description, requirements, type
  or category first shows "Editing these fields sends the job back for review; it will be hidden until approved". The
  save only happens on "Save and send for review". After saving, `backToReview` is reflected ("went back to review").
  Salary, location and closing-date edits save without a warning.
- Close asks first, then shows the server's `closedApplications` count.
- **Featured** is a badge only. No control names feature, promote or boost.

**Feature detection.** The page calls `jobsCapabilities` once.
- **It answers** (`be4e1b7`+): its `employerTransitions` is the runtime source for the application buttons; the
  source-copied table is only the fallback. `moderation:true` means J2 mode, with Submit, Pause and Resume available.
- **The dispatcher answers "Unknown services operation"** (an older server): the "Valid ops:" list in that refusal is
  read as a non-contract hint. If `submitJob` is listed, the page uses J2 mode (`a515270`) with the fallback table.
  Otherwise, including when there is no list at all, it assumes J1: one "Post vacancy" button, labelled as going live
  immediately, with no submit flag, Pause or Submit.
- **Any other failure** (network, internal, an answer with no contract): the form is withheld, with the reason and a
  retry. Nothing is guessed.

The page no longer sends the `{op:''}` probe.

**Labels.** On a current server, labels come from `jobsCapabilities.jobStateLabels` and `applicationStateLabels`. A
state the server leaves unlabelled is shown exactly as stored. The copied `JOB_LABEL` / `APP_LABEL` tables are used
**only** on the old-server path: `a515270` and `ffa2c47` return no labels from capabilities (`listMyJobs` /
`getJobApplications` `statusLabel` is used first where present). "Closed — expired" stays a page label for
`closedReason: 'expired'`.

**Partial lists.** `hasMore` is exact (the server reads limit+1). When it is true, the page shows "Showing the first N
vacancies — more exist" or "Showing the first N applications — more exist". Every count derived from that list, in
Overview tiles, the Analytics funnel and the per-vacancy columns, is shown as **"N+"** and never as an exact total.
When `hasMore` is false, counts are exact. Older servers send no `hasMore`. For them, a list that fills its cap (from
`listCaps`, else 200 / 500, or 100 per vacancy and 50 on the direct read) is treated as possibly partial, also with
"N+". Server counters (`viewCount`, `applicationCount`) are exact per vacancy and carry no "+".

**Honest surfaces.**
- Wallet and Products say "Not available yet". Pricing is unpriced and switched off (owner); posting is free and
  applying is always free.
- **Messaging (J4).** Every application card has "Message applicant".
  - If `window.SokoniInbox.openForTransaction` exists, the button calls it with exactly `('job_application', applicationId)`.
  - Otherwise it navigates to `/messages.html?tx=job_application&txId=<encodeURIComponent(applicationId)>`.
  - **Only the application id is sent.** The server derives the parties (`jobId + applicationId + employerUid +
    seekerUid`). No seekerUid, phone, email or name leaves the page. There is no WhatsApp, mailto or tel hand-off.
  - Both paths navigate the top-level document to `messages.html`, which leaves the merchant shell (the route contract
    says destinations open in-shell). This was accepted as instructed. An in-shell `messages` route opened on the
    conversation would be the follow-up.
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

- `node scripts/test-merchant-jobs-workspace.js`: **56/0**. 42 rows plus 14 negative controls, each of which fails its
  named row:
  - N1, an illegal transition button on the runtime path, fails A1.
  - N1b, an illegal transition in the fallback table, fails A1b (the matrix on `a515270`).
  - N2, `expectedVersion` omitted, fails A3.
  - N3, 0 for an unknown count, fails H3.
  - N4, a "Publish" button, fails J2.
  - N5, a feature toggle, fails J5.
  - N6, `moderationReason` unescaped, fails S3.
  - N7, a seekerUid sent to `openForTransaction`, fails M1.
  - N8, a phone appended to the fallback URL, fails M2.
  - N9, the id not encoded in the fallback URL, fails M2.
  - N10, Resume shown on a SOKONI pause (`pausedByRole` ignored), fails J8.
  - N11, the `jobsCapabilities` transitions ignored, fails D1.
  - N12, an exact count shown while `hasMore` is true, fails P1.
  - N13, the copied label table used on a current server, fails T2.
- Partial-list and label rows (d922713):
  - P1: the real handler is given 201 vacancies and returns 200 with `hasMore`. The page shows the banner, the job
    tiles read "N+" (Drafts "200+"), and with `hasMore` false there is no "+" and no banner.
  - P2: given 501 applications, it returns 500 with `hasMore`. The banner shows on Overview, Analytics and
    Applications; Applications reads "500+", and every Analytics tile and cell reads "N+".
  - T1: changed capability labels are what the chips, the filter and the tiles show.
  - T2: a state the server leaves unlabelled is shown raw, not from the copied table.
  - T3: `a515270` and `ffa2c47` use the copied tables (Published / Interview / Not selected).
  - D5: `be4e1b7` (no `hasMore`, no labels) gives exact counts below the cap, with labels from `statusLabel`.
- Detection and read rows:
  - D1: a server table changed to pending→[shortlisted] shows only Shortlist, and no `{op:''}` probe is sent.
  - D2: the current server makes exactly one `listMyJobs` and one `getEmployerApplications` call, with no direct read and no
    per-vacancy calls.
  - D3: on `a515270`, the op-list hint gives J2 mode, the direct read runs once, and there is one
    `getJobApplications` per vacancy.
  - D4: an unknown op with no list gives J1; a transport failure withholds the form.
- J8: Resume follows `pausedByRole`, not `moderationReason`, and the server's refusal is shown verbatim.
- The messaging rows use an application id that needs encoding (`job 1_s/6?&#x=1`). M1 checks that the button is
  enabled on every card, that the call is exactly two arguments, and that no server call or page navigation happens.
  M2 checks that the URL equals the expected one and carries only the `tx` and `txId` keys.
- `855c8c1` (`terminalAt`, applicant-side `rejectionReason`) changes nothing the employer page reads.
- Fixtures: `scripts/fixtures/jobs-workspace-server.json`, produced by `node scripts/gen-jobs-workspace-fixtures.js`.
  It runs the **real** handlers of `d922713`, `be4e1b7`, `a515270` and `ffa2c47` `functions/jobs.js` in memory, using the module-stub harness
  of `a515270:scripts/test-jobs-moderation.js`. It also lifts the server's `EMPLOYER_TRANSITIONS` / `STATUS_LABEL` /
  `JOB_LABEL` tables, so the legal-button matrix is compared against the server, not against the page's copy. To
  regenerate after a server change, all four commits must be in the local object store. The `hasMore` fixtures
  (`versions.d922713.big`) come from 201 vacancies and 501 applications created through the real handlers. The JSON is
  written compact.
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
    against the emulator with d922713.

## Open items

- **sokoni-f3 (server):**
  1. **Done in `be4e1b7`:** `pausedByRole`, so an admin pause cannot be resumed by the employer; `jobsCapabilities`;
     `listMyJobs`; `getEmployerApplications`. All four are consumed here.
  2. **Done in `d922713`:** exact `hasMore`, state labels and `listCaps`, all consumed here.
  3. Still open: a cursor, so an employer above the caps can page through the rest. Today the page can only say
     that more exist.
  4. Business-keyed employers (jobs keyed to a business, not the poster's uid) are a later server slice. No bridge was
     invented here.
- **sokoni-b2 (messages):**
  - Wired, pending b2's release: hosting `4ef3301` or `a51215b`, plus server `8aaa868`.
  - Consider an in-shell conversation view for merchant-v2, so messaging does not leave the shell.
  - The conversation window runs 30 days from `terminalAt` (`855c8c1`). Once a window has closed, the button still
    opens `messages.html`, and b2's page owns that refusal.
- **sokoni-5b (MODULES):** if Jobs should be enabled per business, add a `jobs` capability to the server-resolved
  merchant capabilities (`merchantIdentity`). The page would then gate the Jobs group with `can('jobs')` instead of
  showing it to every owner. Hand-off text: *"Add MODULES key `jobs` (employer workspace). Default ON for owners;
  employees OFF unless granted. Reason: the Jobs server authorizes by uid, so an employee session posts as itself."*
