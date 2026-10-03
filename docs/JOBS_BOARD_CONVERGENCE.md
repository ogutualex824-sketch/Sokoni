# Jobs Board Convergence

Related: [[Marketplace]] · [[Notifications]] · [[Search]] · `docs/RULES_COMBINED_CANDIDATE.md` · [[Education]] (cross-link, sokoni-5b)

**Status (2026-10-03): J1 BUILT, NOT DEPLOYED. Not user-ready.** Security hotfix first, product second (owner order).

## What already exists (census, live hosting 72dca56)

- `jobs.html` is the seeker side and `job-post.html` the employer side. Both use `sokoni-jobs.js`, which calls
  `servicesDispatch` with an `op` field.
- Server: `functions/jobs.js`, reached through `services-dispatch.js`. Live revision `servicesdispatch-00011-hoc`,
  deployed 2026-09-09. Its archive is saved at `C:/temp/live-archives/servicesDispatch-1787386112368503/`.
- Its whole require closure (`services-dispatch`, `jobs`, `healthcare-hub`, `security-identity`, `hr-payroll`,
  `b2b-wholesale`, `property-hub`) is **byte-identical** to this branch's base `ca55f8b`, so J1 changes only
  `jobs.js` inside that closure.
- **This is not the Work/Job Engine** (garage job cards, construction work orders). Never merge the two, and never
  alias the bare word `job` in the commission config (sokoni-2f kept it out).

## Owner decisions (2026-10-03)

| Topic | Decision |
|---|---|
| Release order | Rules hotfix first (3 live holes), then the product build |
| Commission | Jobs 0% (explicit fixed row, sokoni-2f `f1510b3`); freelance/gig aliases included |
| Freelance gigs | A `freelance-gig` job type on this one board. The old `digital.html` gig data is not imported (its wallet and escrow were fake) |
| Pricing | Built unpriced. Basic posting is free. Paid features are admin-configurable and OFF until prices are set |
| Candidates | Applying is always free |

## J1 — application state machine + vacancy hardening (`functions/jobs.js`)

```
pending → reviewing → shortlisted → interview → offer → offer_accepted → hired
terminal: rejected · withdrawn · offer_declined · closed · hired
```

**Employer:**
- Moves an application only along the table above, from its current state.
- A stale `expectedVersion` is refused, so two tabs can't both move the same application.
- A rejection needs a reason.
- `hired` is reachable only after the applicant accepts the offer.

**Applicant:**
- `withdrawApplication` works from any non-terminal stage up to an open offer.
- `respondToJobOffer` accepts or declines an open offer.

**Every change** is one transaction that writes:
- the new status;
- `statusVersion + 1`;
- an audit event in `jobApplications/{id}/events` (from, to, actor uid and role, reason, job/employer/applicant ids,
  timestamp);
- an in-app notification to the other party.

The notification uses the document shape `notify.js` writes to `notifications`, with `targetUid`, which is what
`sokoni-notif-engine` reads. Its id is deterministic per (application, version), so a retry can't notify twice.
`getApplicationHistory` lets the applicant, employer or an admin read the trail.

**closeJob** closes the `pending` / `reviewing` / `shortlisted` applications and notifies those applicants. It re-reads
each application in its own transaction. Interviews and offers in progress stay with the employer. A closed vacancy
cannot be re-opened by extending its date.

**Vacancy hardening (live defects fixed):**
- Five `HttpsError`s were thrown with no message.
- `updateJob` stored `expiresAt` raw from the client, so a vacancy could stay open for ever. Expiry is now 1–90 days.
- Salary was never validated. Now it must be a whole KES amount from 0 to 100 M, and min ≤ max is checked against the
  stored value.
- `getJob` returned closed or expired jobs to anyone. It now returns not-found to anyone but the employer or an admin.
- The employer's own views counted toward `viewCount`.
- An employer could apply to its own vacancy.
- The CV link may now only be `https:`.
- Each application snapshots the job title, company name and job type.

**Why in-app notifications only:** adding `notify.js` (push/SMS) would widen `servicesDispatch`'s deployed closure to
a module with its own live lineage. Push and SMS come once `notify.js` is cleared for that deploy.

**Tests:** `scripts/test-jobs-lifecycle.js` passes 52/0. Six sabotages each fail named rows:
any-transition, owner check, getJob leak, raw expiry, audit event, hire without acceptance.

## J2 — moderation (backend; ships ATOMICALLY with AdminOS Jobs)

```
draft → pending_review → active (= Published) → paused → closed → archived
pending_review → changes_requested → (employer edits + resubmits) → pending_review
pending_review | changes_requested → rejected
```

**Employer:** `createJob` creates a **draft**, or goes to `pending_review` with `submit:true`. It never creates
`active`. Other employer ops: `submitJob`, `pauseJob`, and `resumeJob` (only if previously approved and not expired).
Editing title, description, requirements, type or category on a Published or Paused vacancy sends it **back to review**,
which blocks bait-and-switch. Salary, location and closing-date edits stay live. Rejected and archived vacancies cannot
be edited.

**Admin (`adminModerateJob`):** approve, request_changes, reject, pause, restore, close, archive, feature, unfeature.
- A reason is **required** for request_changes, reject, pause and close; the employer is told why.
- `restore` works only on a vacancy that was previously approved and has not expired.
- **Featured is its own attribute.** Only a Published vacancy can be featured, and any vacancy that leaves Published is
  unfeatured.
- Every action writes `jobs/{id}/moderation` and `adminAudit` (hub `jobs`), and sends an in-app notification to
  the employer.

**AdminOS reads:**
- `adminListJobs {status}`: the queue, including the employer and the full text.
- `adminGetJob`: the vacancy with its applications, counts by status and the moderation trail ("opening a job shows
  its applications").

**Expiry:** the `jobsExpirySweep` scheduled function (new, hourly, maxInstances 1) closes Published and Paused vacancies
past their closing date (`closedReason: 'expired'`, unfeatured, trail row). It is idempotent, and is what removes
expired jobs from search (J3 drops non-active jobs from the index).

**Tests:** `scripts/test-jobs-moderation.js` passes 42/0. Seven sabotages each fail named rows: employer publishes,
admin check removed, reason optional, no re-review, restore unapproved, feature anything, sweep no-op. J1 is updated for
the submit-and-approve flow (53/0), and its six sabotages are still caught.

**Release:** J2 ships ATOMICALLY with the AdminOS Jobs section. Turning on review before the admin UI exists would stop
every vacancy from publishing. The deploy adds `jobsExpirySweep` alongside `servicesDispatch`.

## Live rule holes (verified on served f259c0b5)

1. Client job create/update.
2. Client application create (a victim's application could be blocked, or applications forged).
3. Seeker profiles readable by any signed-in user (CV link leak).

The fix is on the hotfix candidate `33b2ae4` and the combined candidate `94ea7c6`. **EMULATOR PENDING** (memory floor).

## Next slices

- **J2:** publication states (draft → pending_review → published → paused → closed → archived), the moderation queue,
  featured as its own attribute, and an expiry sweep. Ships WITH the AdminOS Jobs section; switching on review before
  the admin UI exists would stop every job from publishing.
- **J3:** search. Canonical field names for the index (`postedAt` / `featured` / `expiresAt` / `type`), and skip
  `closed` and expired jobs. KASS `search_jobs` field fix.
- **J4:** messages contract for sokoni-b2. Anchor on `jobId + applicationId + employerUid + seekerUid`, all derived by
  the server. Today `job_application` lists only the applicant as a party and takes participants from the client.
- **J5:** hosting. Status chips and actions in `jobs.html` / `job-post.html`, the freelance-gig filter, `sw-register.js`,
  the employer workspace in merchant-v2, and the candidate dashboard.
- **Later:** CV upload, interviews as records, employer verification (reusing business-apply and AdminOS Applications),
  paid products (unpriced), and the Education self-reported skills link.

## Deploy notes

- Scoped `--only functions:servicesDispatch`, from a tree passing the functions lineage gate.
- Diff the live archive above: only `jobs.js` may differ within the closure.
- The hosting changes for the new statuses must ship with or after this function. The old employer UI still sends
  `reviewing` / `shortlisted` / `rejected` / `hired`, and the new server refuses a rejection without a reason and a hire
  without an accepted offer. Ship J5 hosting together.

## Release unit (as of 2026-10-03) — nothing deployed

| Part | Branch @ commit | Tests |
|---|---|---|
| Rules hotfix (FIRST) | sok-caprules `firestore.rules.hotfix-jobs` @ 33b2ae4 | zz-test-jobs-rules **EMULATOR PENDING** |
| Jobs server J1+J2 (+ e3 asks) | functions/jobs-on-ca55f8b @ d922713 | lifecycle 55/0, moderation 50/0, 15 mutants |
| AdminOS Jobs + candidate pages | hosting/jobs-adminos-on-72dca56 @ a3de2ef | aos 17/0, pages 21/0 |
| Employer workspace (sokoni-e3) | hosting/jobs-employer-on-bc9a48c @ 04c0d19 | 56/0 incl. 14 negative controls |
| Jobs messages (sokoni-b2) | messages.js feat/tech-taxonomy-on-13f74f3 @ 8aaa868 + hosting 4ef3301 / a51215b (must carry job_application in SokoniInbox TX_TYPES) | 8/0, 7/7 mutations |
| Search J3 | f3 background agent (in progress) | — |

Deferred: a cursor / page op beyond `hasMore` (listMyJobs 200, getEmployerApplications 500); business-keyed employers
(businessId + staff roles); CV upload; interviews as first-class records; employer verification; paid products
(unpriced, owner).
