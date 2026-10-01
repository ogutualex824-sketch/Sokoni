# Banking Hub + SOKONI Foundation — Certification & Deploy Queue (2026-10-01)

> **Status: BUILT AND TESTED IN CODE — NOT DEPLOYED. DEPLOYMENT QUEUED — MEMORY BELOW 512 MB** (observed 110–522 MB).
> Related: [[FINANCIAL_PARTNER_WORKSPACE]] · [[SOKONI_FOUNDATION]] · [[FINANCIAL_PARTNER_LISTING]] · [[Payments]] · [[AdminOS]]
> Classification per item: **PASS** (executed test, in code) · **UNPROVEN** (not executed / not live) · **REVIEW** (owner decision). Nothing below is live until separately verified.

## A. Banking Hub audit (before)
- Ten category panes were static "Not available yet" placeholders.
- Wallet, finance dashboard, BNPL, merchant finance, invoices, payment history, notifications and the "Admin" pane were **fake**, stored in localStorage. The wallet even had a "Quick Demo Deposit" button.
- The hero figures were invented: 18+ banks, KES 500M+, 12,000+.
- **After** (`hosting/banking-foundation-on-f13a912`):
  - The invented figures are removed.
  - Category panes list REAL approved partners from `financialPartnerDispatch.publicDirectory`, each marked "Listed by SOKONI", never "verified" or "licensed".
  - New panes: Accountants & Advisers, and SOKONI Foundation.
  - The fake tools are removed; My Wallet links to `wallet.html` and Finance to `financial-os.html`.
  - The real USSD codes stay, labelled **External**.
  - Empty categories invite providers to apply.

## B. Foundation audit (before)
- `impact.js` is live, with 26 functions and its own `impactLedger` / `impactBalance`.
- Live defects:
  - The checkout donation **mints** a "completed" donation and a ledger credit with no payment.
  - An admin can type in a campaign's public `raised` figure.
  - An admin can credit 1% of a typed-in order total to the ledger with no money behind it.
  - Disbursement posts to a 404 endpoint, has no claim (a double pay is possible), and marks completed on the initiate response.
- There was no Foundation page (deleted 07-14), no admin view, and no stories.

## C. Authority map
| Concern | Authority (single) | Owner |
|---|---|---|
| Who is a financial partner | `financialProviders/{uid}` via `applicationLifecycle` (`financial-partner-listing.js`, 13 INSTITUTION_TYPES) | sokoni-27 |
| Partner workspace (members, products, registration, team, enquiries, promotion requests, directory) | `financialPartnerDispatch` | sokoni-4d |
| Donation pledge | `impactPledgeDonation` / `impactCheckoutDonate` (pledge only, no ledger) | sokoni-4d |
| Donation payment | `createPaymentIntent` purpose `donation` (1d4eef0) → existing STK helper → `webhookIntasend` → `foundation-donation-settle.js` (d39a0fc) | sokoni-70 |
| Foundation ledger | `impactLedger` + `impactBalance/current` (`_writeLedgerEntry`) — the only Foundation money record | existing |
| Disbursements + refunds | `impactInitiate/Approve/AuthorizeDisbursement` + `impactRefreshDisbursementStatus` + `impactRecordManualDisbursement` + `impactCancelDisbursement` | sokoni-4d |
| Stories / testimonials / Media House | `foundationContentDispatch` + `foundationStoryMediaGuard` (Foundation-owned approval, shared state names) | sokoni-4d |
| Reports about published content (future) | `tsReportContent` (targetType foundation_story/media) | sokoni-aa, on request |
| Admin UI | AdminOS + Super Admin shared modules — never legacy admin.html | sokoni-4d / sokoni-aa chain |

## D. Branches and commits
| Branch | Tip | Contents |
|---|---|---|
| `feat/foundation-on-3a38f35` (functions, storage) | 3b56f40 | `foundation-content.js`; impact.js guards + disbursement rebuild + refunds; `storage.rules` Foundation paths; indexes |
| `feat/financial-partner-workspace-on-9012d90` (functions) | 6ab7dcf | `financialPartnerDispatch` (13 category sidebars, directory, promotion requests); on sokoni-27's lifecycle tree |
| `hosting/banking-foundation-on-f13a912` | 7e5017a | foundation.html/.js, banking.html + banking-hub.js, partner dashboard (incl. Promote), partner intake (sokoni-27) |
| `hosting/admin-failures-on-chain` | b35c9f6 | AdminOS/SA: SOKONI Foundation section, Partner registrations, Payout approvals, Failures |
| sokoni-70 `fix/b1-product-intent-on-7d115bc` / `fix/completion-pin-seam-on-f076c64` | 1d4eef0 / d39a0fc | donation intent + verified completion |

## E. Existing authorities reused
`impactLedger`/`impactBalance`/`_writeLedgerEntry`, `finos-utils.intasendB2C` (proven send-money contract), `createPaymentIntent` + `webhookIntasend`, `sokoni-intasend.js initiateSTKPush`, `impactCampaigns` (programmes), `adminActions` audit, `shared/durable-limit.js`, `financial-partner-listing.js` validators, AdminOS shared-module pattern.

## F. New authorities (only where none existed)
`foundationContentDispatch` (no story authority existed), `financialPartnerDispatch` (no partner workspace existed), `financialPromotions` (admin-granted, unpaid placements — the existing `purchaseFeaturedListing` is forgeable and was NOT reused).

## G–Q. Evidence
| # | Area | Test (executed) | Result | Class |
|---|---|---|---|---|
| G | Donation flow — pledge, never mint | test-impact-checkout-pledge | 12/0 + counterproof on c7e26b6 | PASS |
| G | Pledge tags / own status / no fabricated raised / no unbacked credit | test-impact-foundation-guards | 8/0 + counterproof on 3a38f35 | PASS |
| G | Payment intent + verified completion (sokoni-70) | settle 19/0 (4 mutants), intent 16/0 | reported by sokoni-70 | PASS (theirs) |
| H | Partner workspace, 13 categories, roles, consent, directory, promotion | test-financial-partner-workspace | 44/0; sabotages (approval gate, self-verify) caught | PASS |
| H | Partner page contract | test-financial-partner-page | 11/0; escape sabotage caught (3, 3b) | PASS |
| H | Partner intake (sokoni-27) | test-financial-partner-intake | 35/0 | PASS |
| I | Foundation ledger: debits only on confirmation; refunds reverse | test-foundation-disbursements | 19/0 + counterproof (original debits on initiate) | PASS |
| J | Disbursement: 3 people, claim, reserve, M-PESA settle, manual two-person, refund | same suite | 19/0 | PASS |
| J | IntaSend send-money **status** contract (`/send-money/status/`) | — | not exercised live | UNPROVEN |
| K/L | AdminOS + Super Admin Foundation section | test-admin-foundation | 75/0; 4 sabotages caught (5g/6, 7b/7d, 5m, 3b/3c) | PASS |
| K/L | Sibling admin suites | payout approvals 43/0 · partner registrations 16/0 (innerHTML sabotage caught) · failures 37/0 | PASS |
| M/N | Stories, Media House, consent, media tokens | test-foundation-content | 26/0; sabotages (author approve, approved filter via G4, media guard) caught | PASS |
| N | Public Foundation page + Banking Hub static contract | test-foundation-page | 38/0; 6 sabotages caught (F7, F6b/F6c, B2, B1, F4, F7b) | PASS |
| — | Banking Hub browser suite (WebKit) | test-banking-hub (rewritten) | NOT RUN (RAM) | UNPROVEN |
| — | Storage rules emulator suite (19 cases incl. uid 'admin') | test-foundation-storage-rules | NOT RUN (RAM) | UNPROVEN |
| — | Real-browser / App Check / layout on any new page | — | not run | UNPROVEN |
| O | Security: forged paid / amount / ledger / balance / disbursement complete / published / verified / partner approved / cross-partner / duplicate payment, disbursement, refund | covered across the suites above (named assertions) | PASS in code |
| P | Audit: transitions + adminActions for stories, disbursements, promotions, registrations | asserted in content, disbursement, workspace suites | PASS |
| Q | Reconciliation | daily ledger-vs-balance job exists (circular); **pre-fix checkout mints contaminate the live balance** | REVIEW |

## Known gaps / owner decisions (REVIEW)
1. **Live balance contamination.** Until the pledge fix is deployed, live checkout donations are recorded as "completed" with no money. Before trusting the balance or paying anything out, decide how to reconcile those records: flag them or reverse them.
2. **Paid partner plans and paid promotion are NOT built.**
   - Subscriptions are stored per user (`subscriptions/{uid}`), so a merchant who is also a partner would overwrite one subscription with the other.
   - `subActivate` has the open get()+set() claim defect.
   - No partner pricing exists.
   - Needed from you: prices, plus a slice that keys subscriptions per hub.
3. **Bank, till and paybill payouts have no automated rail** (no PesaLink or B2B integration anywhere). They are recorded manually and confirmed by a second admin. Automating them is a new IntaSend provider slice.
4. A **"Registration reviewed by SOKONI" public marker** is your call. Today the public profile always shows registration as self-declared.
5. **Video transcoding** does not exist. Uploads are capped instead (80 MB, MP4/WebM/MOV).
6. **Breaking change:** the removed banking.html tabs (wallet, dashboard, bnpl, merchant, invoices, payments, notifs, admin) now deep-link to Loans.

## T. Exact deployment queue (dependency order; one deploy at a time; named scopes only; RAM ≥ 512 MB; live-archive diff per function first)
1. **Functions — partner tree** (`feat/financial-partner-workspace-on-9012d90`, after sokoni-27 deploys their `applicationLifecycle` from the same tree with owner authorization):
   - `firebase deploy --only firestore:indexes` from that tree (additive; check the file is a superset of the live indexes)
   - `--only functions:financialPartnerDispatch`
2. **Firestore rules** (sokoni-aa's community unit): `financialProviders` readable when listingStatus == 'approved' or by the owner; write false. The partner workspace collections need no rule.
3. **Functions — Foundation tree** (`feat/foundation-on-3a38f35`, which includes the security set):
   - indexes first
   - then `impactCheckoutDonate`, `impactPledgeDonation`, `impactGetMyPledge`, `impactUpdateCampaign`, `impactRecordMarketplaceContribution`, `impactInitiateDisbursement`, `impactApproveDisbursement`, `impactAuthorizeDisbursement`, `impactRefreshDisbursementStatus`, `impactRecordManualDisbursement`, `impactCancelDisbursement`, `impactAdminFoundationData`, `foundationContentDispatch`, `foundationStoryMediaGuard`
   - and the security-set names already queued on the parent branch
4. **sokoni-70's lane:** `createPaymentIntent` (donation purpose), then the `webhookIntasend` completion, after their completion-PIN step and within the webhook containment rules.
5. **Storage rules** (`storage.rules` from the Foundation tree): `--only storage`, after the emulator suite passes. Then verify the `firebase.storage` release pointer.
6. **Hosting:**
   - the union `20b92fa` first (the live till fix)
   - then `hosting/banking-foundation-on-f13a912`, rebased on whatever is live and merged with the trust branch
   - then sokoni-aa's AdminOS chain, which merges `hosting/admin-failures-on-chain`

## U. Live verification checklist (after each step)
- `gcloud functions describe` each name: revision Ready, serving 100%, archive = this tree.
- `curl https://mysokoni.co.ke/version.json` matches the hosting commit; open `foundation.html` and `banking.html` with a cache-buster.
- Signed-out directory call returns approved listings only, every row "Listed by SOKONI".
- A KES 10 sandbox/real donation: pledge → STK → the pledge reads `completed` with a receipt only after the webhook; ledger has `DON_` and `DONFEE_` entries; a replay is a no-op.
- A failed or abandoned payment leaves no credit.
- A test story: submit → approve (second admin) → publish → visible below the wizard → archive → its media URL returns 404.
- A KES 100 M-PESA disbursement through three admins: ledger debited only after IntaSend reports Completed.
- Fetch the deployed firestore and storage rulesets and diff them against the candidates.

**DEPLOYMENT QUEUED — MEMORY BELOW 512 MB**
