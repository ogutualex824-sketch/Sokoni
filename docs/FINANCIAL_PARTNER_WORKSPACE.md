# Financial Partner Workspace

> Status (2026-10-01): **built, tested (31/0), NOT deployed.** Branch `feat/financial-partner-workspace`.
> Related: [[Banking Hub]] · [[SOKONI Foundation]] · [[Authentication]] · [[AdminOS]] · [[Application Lifecycle]]

## What it is
After SOKONI approves a financial partner — a **bank, SACCO, chama, microfinance institution, insurer,
forex bureau or accountant** — they land on `financial-partner-dashboard.html`. The left sidebar shows
the tools their category needs; the server decides which.

| Category | Sidebar tools | Register label | Catalogue label | Regulators offered |
|---|---|---|---|---|
| Bank | Overview, Registration, Clients, Products, Enquiries, Team, Public profile | Clients | Products | CBK |
| SACCO | same | Members | Products | SASRA, Commissioner for Co-operative Development |
| Chama | same | Members | Plans | Registrar of Societies, State Dept for Social Protection, Not yet registered |
| Microfinance | same | Clients | Products | CBK — MFB, CBK — DCP |
| Insurance | same | Policyholders | Policies | IRA |
| Forex bureau | Overview, Registration, Rates, Enquiries, Team, Public profile (**no register**) | — | Rates (buy/sell) | CBK |
| Accountant | same as bank | Clients | Services | ICPAK, KRA (tax agent) |

## Authority (who decides what)
* **Who is a partner:** `financialProviders/{uid}.listingStatus == 'approved'`, written by the approval
  lifecycle (sokoni-27's `financial_partner` slice). This module **reads it, never writes it**.
  Suspending a listing closes the workspace on the next call.
* **Workspace data:** `financialPartners/{partnerUid}` (profile, registration) and subcollections
  `members`, `products`, `team`, `audit`; `financialPartnerStaff/{staffUid}`; `financialEnquiries/{id}`.
  **Client SDK access is denied** (no rules match = deny); the callable `financialPartnerDispatch` is the
  only door.
* **Registration verification:** a partner can submit only → `under_review`. Only an administrator
  (`adminReviewRegistration`) sets `verified` / `rejected`; the public profile shows "verified" only then,
  otherwise "self-declared". Every review writes `adminActions`.

## Roles inside one partner
| Role | Can |
|---|---|
| owner (the approved account) | everything |
| manager | everything except team changes and registration |
| officer | register (list / add / edit / suspend — **never delete**) and enquiries |

Staff are added by email (they need a SOKONI account); one person works for at most one partner.

## Member / client register
* Fields: name, phone (Kenyan, normalised to `2547…`/`2541…`), member number, joined date, status
  (active / suspended / exited), short note. **No national ID, no DOB, no balances** (data minimisation).
* The partner must attest the person consented; the attestation is stored on the record.
* Phone is the unique key per partner — enforced by `create()` (never get+set), so a duplicate is refused.
* CSV/paste import: ≤200 rows per call, per-row result.
* Delete = erasure (record removed; the audit trail keeps only the id — no names or phones in audit).

## Enquiries
Signed-in Banking Hub users contact an approved partner; consent to share contact details is required.
Limits: 10/day per user, 3/day per user+partner (fail-closed limiter `shared/durable-limit.js`).

## Callable `financialPartnerDispatch` (ops)
Partner: `getWorkspace`, `updateProfile`, `submitRegistration`, `listMembers`, `addMember`, `importMembers`,
`updateMember`, `deleteMember`, `listProducts`, `saveProduct`, `listEnquiries`, `updateEnquiry`, `listTeam`,
`addTeamMember`, `removeTeamMember`. Public: `publicProfile` (rate-limited per client), `submitEnquiry`.
Admin: `adminListRegistrations`, `adminReviewRegistration`. App Check enforced. Partner writes: 300/hour.

## Data integrity
Counts are Firestore `count()` aggregates; a count that cannot be read is `null` and renders `—`, never `0`.
Rates/prices are shown as entered by the partner ("as you advertise it").

## Indexes (firestore.indexes.json)
`members (status ASC, createdAt DESC)` · `financialEnquiries (partnerUid, createdAt DESC)` ·
`financialEnquiries (partnerUid, status, createdAt DESC)` · `financialEnquiries (partnerUid, status)`.

## Deploy (queued — RAM floor 512 MB; one deploy at a time)
1. Indexes: `firebase deploy --only firestore:indexes` (additive) — before the function.
2. `firebase deploy --only functions:financialPartnerDispatch` (new name; live-archive diff N/A).
3. Hosting: page + JS ported onto the current live hosting line.
4. Depends on sokoni-27's lifecycle slice writing `financialProviders/{uid}` and mapping
   `WORKSPACE_HUBS.financial_partner → financial-partner-dashboard.html`.

## Known limitations / next
* AdminOS "Partner registrations" view (calls `adminListRegistrations` / `adminReviewRegistration`) —
  goes on sokoni-aa's AdminOS chain.
* Licence document upload not included (needs a Storage path + rules); registration is number-based.
* No money moves through this workspace (no contributions/balances) — any chama/SACCO money feature must
  go through IntaSend and the payment authority.
