# Earn with SOKONI — application → AdminOS decision → granted dashboard (2026-09-30)

**Owner ask:** "fix earn with sokoni page and make sure it is connected to the adminos and super admin hence should be able to grant the correct dashboard according to the application — connect the whole ecosystem … most work is done, just implementation."
**Surfaces:** `opportunity.html` (Earn with SOKONI), `business-apply.html`, `sokoni-role-authority.js`, `admin-os.html` + `sokoni-aos.js`, `index.html` (home card).
**Suite:** `scripts/test-earn-application-chain.js` (75 / 0, sabotage 6 / 6).
**Related:** [[Authentication]] · [[ROLE_AUTHORITY_AUDIT]] · [[ADMIN_OS_CONVERGENCE]] · [[CANONICAL_ONBOARDING_SCHEMA]] · [[PROVIDER_LIFECYCLE_CONTRACT]] · [[PROFILE_BUYER_VIEW]] · [[MERCHANT_DASHBOARD_FACTS]]

## 1. The chain, as it now runs

```
Earn card / chooser ──► existing intake page ──► applications/{id}  (status pending | pending_review)
                                                     │
AdminOS › Applications (admin or super admin) ──► applicationDecide ──► server decision record
                                                     │                  + adminAudit row
                                                     ▼
                                     applyDecision: registry record + users.roles + claim
                                                     │
Earn page "Your applications" / business-apply ──► SokoniRoleAuthority.hubFor(role) ──► the workspace
```

Nothing on the earn page writes an application itself and nothing client-side grants anything. The one
decision path is an administrator in AdminOS. The dashboard link is produced only by `hubFor()`, which
answers only for a role present in the signed ID token.

## 2. What was wrong (census, 2026-09-30)

- The page's "Quick Application" opened `wa.me/…` and then printed "Application sent! We'll be in touch within 24hrs." Nothing was filed, so no admin could ever review it.
- Its cards pointed at eight hubs, two of them the same page (Delivery Rider / Delivery Driver → `driver.html`).
  - Affiliate and Event Promoter had no application at all.
  - Seller went to `seller.html`, whose unapproved route (`onboarding-seller.html`) files no application.
- The provider workspace route sent unapproved providers to `provider-onboarding.html`. Its `providerPublish` step self-publishes and self-claims with no admin decision, a known live P0 in the 09-28 production check.
- Approved providers who switched role landed on `providers.html`, the public directory of other providers.
- AdminOS, the canonical admin workspace, had no applications view. Review happened only on the legacy `admin.html`, `super-admin.html` and `moderation.html` pages.
- The hero advertised "KES 45K+ top earners / month", and the earnings table read as fact. No data source backs either.

## 3. What changed

| Where | Change |
|---|---|
| `opportunity.html` | Ten cards, each opening an EXISTING intake that files `applications/*`: rider → `onboarding-driver.html`; mechanic → `HubRegister.open({hub:'car',category:'mechanic'})`; seller → `business-apply.html?offer=products`; service provider / freelancer / property agent / event promoter → `business-apply.html?offer=services&category=…&label=…`; landlord → `onboarding-landlord.html`; health or legal → `onboarding-professional.html`; affiliate → `referral.html`, stated as "no application needed". The WhatsApp form is replaced by a chooser built from the same list that opens the chosen application. A signed-in visitor sees **Your applications** with real statuses; approved rows open the dashboard through `hubFor()`. The hero count is derived from the cards; earnings are labelled estimates. |
| `business-apply.html` | `?offer=` preselects the choice after the real status loads. `?category=` / `?label=` become the application's `category` / `categoryLabel`, fields the shared `PROFILE_FIELDS` allow-list already accepts. They are a reviewer label, never a role, status or claim, and the shared `FORBIDDEN` filter still strips those (executed in the suite). Approved sides show "Open your shop workspace" / "Open your provider dashboard". |
| `sokoni-role-authority.js` | `WORKSPACE_HUBS.provider` changed from `providers.html` to `provider-dashboard.html`. `APPLICATION_ROUTES.seller` / `.provider` changed to `business-apply.html?offer=products|services`. Rider and landlord keep their own intakes. |
| `admin-os.html` + `sokoni-aos.js` | New **Applications** module (People group), for admins and super admins alike. It filters by status, including "approved, not live", and by role, including "unresolved". Actions: approve, reject, ask for info, suspend, publish now. Reads go through `applicationList`, decisions through `applicationDecide`, repairs through `applicationReconcile`. There is no direct Firestore access. An administrator's own application is shown but cannot be decided. Refusals and partial projections are never shown as success. |
| `index.html` | Home card says "10 ways to earn" with the new list. |

Legacy `admin.html` / `super-admin.html` / `moderation.html` are **untouched**. This follows the standing rule that AdminOS is the one admin workspace and legacy surfaces are reference-only.

## 4. Security — the approval chain in production (K13)

Measured read-only on 2026-09-30 against the **serving** artefacts:

- **Served rules** `b87c94e4`: an applicant may write `status`, `decidedBy` and `requestedRole` on their own application, because none of the three is in `noAdminFields()`.
- **Serving `applicationLifecycle`** (source blob `b1f10fa`, byte-identical closure to the K13-B base `055e509`):
  - It accepts a decision if the uid *named* in `decidedBy` holds an admin claim.
  - `grantAccountRole` keeps `admin: 'admin'` / `staff: 'staff'` and calls `setCustomUserClaims`.
  - So an applicant who knows an admin uid can approve themselves into any role, including `admin`.
- **Admin uids are discoverable.** Three distinct `decidedBy` uids sit on decided applications that their applicants can read.
- **No exploitation evidence.** No application declares a privileged role, and there are no `application_unauthorised_decision` alerts. The three admin-claim holders were all created June–July 2026 with no application behind them. Positive control: 13 applications and 77 Auth users were read.
- **The fix already exists and is not deployed.**
  - K13-A `7df7817`: `applicationDecide` writes `applicationDecisions/{appId}` before the application, and reconcile applies only an authoritative decision.
  - K13-B `f66f2c1`: the trigger requires that record, and the decider must be an admin who is not the applicant.
  - K13-C `ad183b0`: rules; its compiled-size gate is still open.
  - Re-verified today: both function parents equal the live archives across all 10 closure files. K13-A 11/0, K13-B 8/0, and both counterproofs reproduce the defect on production code.
  - `applicationDecisions` has no client rule (default deny) and `adminAudit` is admin-read-only on the served rules.
- **Why the Applications module needs no K13 wait.** It calls `applicationDecide`, the same callable K13-A hardens, so it is correct before and after that deploy. The older `admin.html` lawyer / firm / health-facility buttons write `status` without `decidedBy`, so the live trigger already refuses them. K13 introduces no regression there.
- **Never deploy `applicationLifecycle` from a hosting-line tree.** This worktree carries the older 1,368-line copy **without** `decisionAuthority`. Deploying it would reopen the hole entirely.

## 5. Not in this slice (stated, not hidden)

- **Server notification wording** for approved riders still says "merchant … is now live" (`role === 'driver'` check vs the canonical `rider`). This is a functions change on the lifecycle lineage and would ride with the K13-B file.
- **`agreementAccepted` is not enforced server-side.** The primitives refuse without it, but `applicationDecide` does not check.
- **`providerPublish` self-publish** stays live until its own functions slice. This slice only stops *routing* applicants into it.
- **K13-C rules**: `business-apply` writes `status: 'pending_review'` and `complete-application.html` writes `status: 'withdrawn'`. The K13-C rule text must admit both, or it will break these intakes. Verify before that release.
- **Property agents** are filed as `provider` (category `property-agent`). The existing `property-agent-dashboard.html` is not a canonical workspace and is not mapped.

## 6. Manual test checklist

1. Signed out: `/opportunity` shows ten cards and no "Your applications" panel. Every card opens its intake, and the chooser opens the same intake.
2. Signed in with no applications: the panel says "You have not applied for anything yet."
3. Apply as Freelancer: `business-apply` opens with **Services** preselected. After submit, the application shows `category: freelancer`, `categoryLabel: Freelancer`, `status: pending_review`.
4. AdminOS › Applications: the application appears under "In review", role Provider, label Freelancer.
   - Approve it. The toast reads "Approved — role and workspace granted", and the row moves to Approved / Live.
   - Your own application shows disabled buttons.
5. Back on `/opportunity` as the applicant, the row shows **Approved**, and "Open your dashboard" goes to `provider-dashboard.html` after the one-time token refresh.
6. Unapproved provider opening `provider-dashboard.html` is redirected to `business-apply.html?offer=services`.
