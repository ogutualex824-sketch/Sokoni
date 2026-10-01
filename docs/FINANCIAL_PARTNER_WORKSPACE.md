# Financial Partner Workspace

> Status (2026-10-01): **built, tested, NOT deployed.** Functions: `feat/financial-partner-workspace-on-9012d90` (on sokoni-27's financial_partner lineage). Hosting: `hosting/financial-partner-dashboard-on-2c4b8a4`.
> Related: [[FINANCIAL_PARTNER_LISTING]] · [[FINANCIAL_PARTNER_INTAKE]] · [[Banking Hub]] · [[SOKONI Foundation]] · [[AdminOS]] · [[Application Lifecycle]]

## What it is
After SOKONI approves a financial partner — a **bank, SACCO, chama, microfinance institution, insurer, financial adviser, investment firm,
forex bureau or accountant** — they land on `financial-partner-dashboard.html`. The left sidebar shows
the tools their category needs; the server decides which.

Keyed by the ONE enum, `functions/financial-partner-listing.js` **INSTITUTION_TYPES** (written by the approval lifecycle).

| institutionType | Register label | Catalogue label | Regulators offered |
|---|---|---|---|
| BANK | Clients | Products | CBK |
| SACCO | Members | Products | SASRA, Commissioner for Co-operative Development |
| CHAMA | Members | Plans | Registrar of Societies, State Dept for Social Protection, Not yet registered |
| MICROFINANCE | Clients | Products | CBK — MFB, CBK — DCP |
| INSURER | Policyholders | Policies | IRA |
| FOREX | — (**no register**) | Rates (buy/sell) | CBK |
| ACCOUNTANT | Clients | Services | ICPAK, KRA (tax agent) |
| FINANCIAL_ADVISER | Clients | Services | CMA, IRA, Not regulated |
| INVESTMENT | Clients | Products | CMA, RBA |
| OTHER | Clients | Services | Other regulator, Not regulated |

Sidebar for all except FOREX: Overview · Registration · register · catalogue · Enquiries · Team · Public profile.
An unknown type is refused (`UNKNOWN_CATEGORY`), never guessed.

## Authority (who decides what)
* **Who is a partner:** `financialProviders/{uid}.listingStatus == 'approved'` (else `withdrawn`), created only by the approval lifecycle (sokoni-27's `financial_partner` slice). Withdrawal closes the workspace on the next call.
* **Public profile edits:** written to `financialProviders/{uid}` — **EDITABLE_KEYS only** (description ≤300, services from SERVICES, county, website, businessEmail, businessPhone) through the same `validateDescriptive()` the approval projection uses, with `listingStatus` re-checked inside the transaction. An invalid field is refused by name, never dropped silently. Name and institution type are identity (new application). Note: a re-approval rebuilds the listing from the application, replacing earlier dashboard edits. Branches and hours stay on `financialPartners/{uid}`.
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
4. Order: functions (sokoni-27's lifecycle + this callable, same tree) → rules (financialProviders read) → hosting.

## Page notes
* The page does **not** load `sokoni-role-authority.js`: its `guardPage()` would send managers/officers (no `financial_partner` claim) to the application form. Access is decided per call by the server.
* `WORKSPACE_HUBS.financial_partner` (sokoni-27) routes approved owners here from the earn page and business-apply.

## Known limitations / next
* AdminOS "Partner registrations" view (calls `adminListRegistrations` / `adminReviewRegistration`) —
  goes on sokoni-aa's AdminOS chain.
* Licence document upload not included (needs a Storage path + rules); registration is number-based.
* No money moves through this workspace (no contributions/balances) — any chama/SACCO money feature must
  go through IntaSend and the payment authority.
