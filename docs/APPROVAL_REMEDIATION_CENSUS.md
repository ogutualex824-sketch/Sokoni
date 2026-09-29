# Approval Remediation / Reapplication — census (READ ONLY; nothing written)

**Date:** 2026-09-29T22:30:49Z · **Production project** `sokoni-aeb26` · **Script:** `scripts/census-approval-remediation.js` · **Packet:** `docs/release-gates/approval-remediation-census.json` (rows for every non-buyer account; buyer-only accounts counted, not listed) · **Digest** over all rows: `fc1c154f92a3373271be41213dd811221f129d4b14bae7f4c9bc76070867240b`. Nothing was changed: no status, suspended, searchable, isPublic, roles, claims, applications, classifications, dashboards or wallets. King Bruce's landed refusal ([[LANDING_KINGBRUCE_REFUSE]]) appears here as evidence of the REFUSED state, not as a mutation.

## 1 · Population and partition

Population = every uid seen in Auth (77), `users` (85), `providers` (11), `sellers` (8), `businesses` (12), `shops` (3) or `applications.uid` (13 applications) → **91 accounts**, plus **2 business directory records with no account** (`businesses/SOK-84YM4L` "Rider" and `SOK-RAH2MR` "FRED", ownerId `uid2` / `uid1` — synthetic; both already in the cleanup manifest).

**Validity test** (the deployed trigger's own): an approved application whose `decidedBy` is a *resolvable Auth account holding admin or superAdmin*, **not the applicant itself**, and whose role approves the kind of registry record present (a driver application does not approve a seller record); or a `providers.approvalDecision` approve by `admin_decision`.

| State | Count | Accounts |
|---|---|---|
| **BUYER_ONLY** | **64** | no registry record, no application, roles ⊆ {buyer}. 14 have no Auth account (users doc only), 5 have no users doc (Auth only). Two carry something extra and are noted, not remediated: `WEbAS5cV…` roles buyer+rider (driver track), `zPYdnpHf…` admin claim. |
| **VALIDLY_APPROVED** (protected) | **5** | DG wines and spirits, Latomi gadgets, Julian's Closet, Hometown Movers kenya, k Riss — each an application approved by admin account `D5Ql2EYr…`, provider `approvedAt` from that projection. |
| **INVALID_LEGACY** | **3** | Kasindi holdings limited; Langa'ta mamafua; KASS SHOP (`D5Ql2EYr…`). |
| **NO_APPROVAL_EVIDENCE** | **17** | 10 live by status only, 3 registry stubs not live, 3 role-without-registry (+ 1 counted under live: see table). |
| **PENDING_APPLICATION** | **1** | Heights Creations. |
| **REFUSED** | **1** | King Bruce. |

## 2 · Categories 3–6 — the evidence, account by account

### INVALID_LEGACY — an approval artefact exists, no decision passes the authority test

| Account | Evidence | Routed to a provider/business dashboard now | Public | Application path | Preserve |
|---|---|---|---|---|---|
| **Kasindi holdings limited** `WLt0Voww…` | `applications/PRVMS7IACKG` approved, `decidedBy "reindex"` → unresolvable account; provider `approvedAt` 2026-07-30 with no admin decision; stray `sellers` stub | yes (provider role + claim, status active) | **yes** | re-decide the existing application after acknowledgement ([[KASINDI_REPAIR_CENSUS]], tomorrow) | `decidedBy "reindex"` @ 2026-07-30T15:11:12Z; `approvedAt` |
| **Langa'ta mamafua** `H7p6ktBH…` | `applications/e0cOABIkbtu2Vb1suG5y` approved, `decidedBy "founder-decision-2026-08-01"` → a label, not an account; provider `approvedAt` 2026-08-01 with no admin decision. **Already classified `cleaning` by the R3 landing** (which accepted `approvedAt` as evidence); the c4 resolver routes it AVAILABLE. | yes | **yes** | re-decide the existing application (agreement state to check) | `decidedBy "founder-decision-2026-08-01"`; `approvedAt` 2026-08-01T06:14:23Z; the R3 category stamp |
| **KASS SHOP** `D5Ql2EYr…` (the admin account) | seller, business ×3 (one retired), shop all live by status with **no approvedAt / no decision**; three **driver** applications decided **by itself** (2 approved, 1 rejected) — self-decided, and for another role. 50 products, 10 orders, 8 wallet tx. | yes | no | fresh seller/business decision needed; the driver approvals are for another role | the three self-decided driver decisions (2026-08-04) |

### NO_APPROVAL_EVIDENCE — live by status alone, or role/stub without evidence

| Account | Subtype | Evidence | Routed now | Public | Path |
|---|---|---|---|---|---|
| **DJ Bvmbxno** `AiJp5yzT…` | live_status_only | provider active, no approvedAt, no application; 4 bookings · 1 service · 3 wallet tx | yes | **yes** | fresh application (owner: no decision yet; reapplication path) |
| **KASS SHOP** `xrH21J5G…` (second account of that name) | live_status_only | seller active, no evidence; roles seller+driver; **32 wallet tx** | yes | **yes** | fresh application |
| **John wa Pork** `Bxd4Lc4D…` | live_status_only | seller active, no evidence | yes | **yes** | fresh application |
| **Maina Groceries** `zewfgP9O…` | live_status_only | seller active, no evidence; in cleanup manifest (3 records) | yes | **yes** | cleanup manifest, else fresh |
| **Shave 'n' Trims** `13iuLZx6…` | live_status_only | provider active, no evidence; synthetic, in cleanup manifest | yes | **yes** | cleanup manifest ([[ADJUDICATION_SIX_UNRESOLVED]]) |
| **SOKONI Store** `vbaSOKL4…` | live_status_only | business `SOK-XX2338` active + shop `STR_147f…` (no status); first-party identity ([[project_sokoni_store_first_party_identity]]) | yes | no | owner decision (first-party) |
| **WOODLANDS** `uwpD5gx3…` (admin+superAdmin account "Kaspa") | live_status_only | business `SOK-WDLNDS` active, no evidence | yes | no | fresh business decision |
| **Merchant A Traders** `MERCHANT…`, **Shop B Traders** ×2 `SELLER_A…`, **ZZ Probe Shop** `EmV3RXLm…` | live_status_only | synthetic ids / probe; businesses `SOK-LZMNWQ`, `SOK-UHE9XA`, `SOK-ALM49S`, shop; all in the cleanup manifest | yes | no | cleanup manifest |
| `TuOa5Ju5…` (phone-number name), **Enock Kiptoo korir** `LDBKlzIU…`, **Manu** `FVolUQUw…` | registry_stub_not_live | `sellers/{uid}` with no status (branches-only stubs); roles buyer / buyer / buyer+seller | no / no / yes (Manu: seller role) | no | fresh application if they want to sell; otherwise stubs |
| `MtexojeA…` (no name; cleanup manifest), **RC Seller** `oXrgbq2o…` (seller **claim**), **T.M.M & Partners Advocates** `ZrG4N8SE…` (merchant role) | role_without_registry | a provider/seller role or claim with **no** registry record and **no** application | yes (role/claim routes) | no | fresh application; RC Seller's claim is a self-mint residue |

### PENDING_APPLICATION

**Heights Creations** `28vznyvn…` — provider `pending`; **three** undecided applications (`NlEgs7EL…`, `PRVMUH8GVC0`, `PRVMUHCGRFH`), none acknowledged; roles buyer only; not routed, not public. Path: continue the existing pending application (duplicates to resolve in the queue, not by deletion here).

### REFUSED

**King Bruce** `aOdQxmUG…` — `providers.approvalDecision` refuse by `D5Ql2EYr…` (22:16Z today); status suspended, delisted; users doc still carries roles buyer+merchant+provider (the live shell would still route on the role — flagged `refused_but_role_or_status`). Path: fresh application if the person ever applies.

## 3 · The five specific questions

1. **Routed to a provider/business dashboard without valid approval: 18 accounts** (+ King Bruce by role only). Definition used: the live shell routes on a provider/seller role or claim or a live registry status, never on approval evidence — so every non-buyer account except the five valid ones and the three stubs.
2. **Publicly searchable without valid approval: 7** — Kasindi, Langa'ta mamafua, DJ Bvmbxno, KASS SHOP (`xrH21J5G…`), John wa Pork, Maina Groceries, Shave 'n' Trims.
3. **Reusable/completable application vs fresh:** reusable **4** (Kasindi, Langa'ta mamafua re-decide; Heights continue; KASS SHOP `D5Ql…` has applications but for another role) · fresh **18**.
4. **Historical decisions to preserve (never overwrite): 9 accounts** — the five valid decisions (protected anyway), Kasindi `"reindex"`, Langa'ta `"founder-decision-2026-08-01"`, KASS SHOP's three self-decided driver decisions, King Bruce's refuse. With `priorDecisions` preservation ([[KASINDI_REPAIR_PRECONDITIONS]]) a re-decision keeps each on the document.
5. **Explicitly protected from remediation: 5** — DG Wine, Latomi, Julian's Closet, Hometown Movers, k Riss (`protectedFromRemediation: true` in the packet).

## 4 · Findings beyond the partition

- **Langa'ta mamafua is a second Kasindi.** Its approval is a label, not an account, yet R3 stamped it `cleaning` and the resolver already routes it AVAILABLE. The classification landing was correct under the evidence model of the time (`approvedAt` trusted); under the authority test it needs the same repair path as Kasindi (acknowledgement → fresh decision with preservation), and its category stamp should survive that.
- **Self-decided approvals exist**: the admin account approved its own three driver applications. Allowed by the rules (`isAdmin`), but "owner ≠ authority" ([[reference_slice_index]]); the remediation authority should refuse `decidedBy === applicant`.
- **18 of the 27 non-buyer accounts touch the cleanup manifest** (digest `028299e7…`): remediation and cleanup must not both act on the same record; cleanup candidates are excluded from the reapplication surface until the owner decides which slice owns them.
- The live shell's routing by **role/claim alone** (3 role_without_registry accounts, King Bruce's residual roles) means a server-derived approval state must also gate the shell, not only the registry records.

## 5 · Next (design, not yet authorized to write)

The reapplication transition the owner specified: server-derived state (`VALID_APPROVAL · INVALID_LEGACY_APPROVAL · NO_APPROVAL · REAPPLICATION_REQUIRED · PENDING_APPROVAL · APPROVED · REFUSED`) computed from exactly the evidence above → a `reapplicationRequired` server operation callable only for accounts failing the evidence gate, preserving history → the "Complete your business application" surface on the existing application schema and agreement version → the same admin authority decides → projection; approval ≠ classification; buyers excluded; cleanup-manifest records excluded pending the owner's slice decision. No production writes until the whole slice is tested and each identity is individually manifested.

Related: [[MANIFEST_APPROVAL_DECISION_DJ_KINGBRUCE]] · [[C3_IDENTITY_CLASSIFICATION_CENSUS]] · [[CAPABILITY_AUTHORITY_READ_MODEL]]
