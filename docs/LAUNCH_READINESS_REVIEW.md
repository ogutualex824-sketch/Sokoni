# SOKONI — Launch Readiness Review

**Prepared for:** Board of Directors, Bravilex International Co. Limited
**Date:** 2026-07-20
**Reviewer:** Independent engineering review
**Question put:** Should SOKONI launch to the public tomorrow?

---

# DECISION: **NO LAUNCH**

Not because the platform is unfinished — it is substantially built, and much of it is good — but
because of one fact that overrides every other consideration:

> **The code running in production today is not the code that has been reviewed and repaired.**
> `git status` reports **212 commits ahead of origin/main.** Nothing from this engineering cycle has
> been pushed or deployed.

Every defect corrected in the past cycle — payments discoverability, authorization, booking,
navigation — is repaired **only on a local workstation**. Production is running the code that
contains all of them.

A launch tomorrow would ship the broken versions.

---

## The four findings that individually justify NO LAUNCH

### CRITICAL 1 — No payment has ever been proven to succeed

**Evidence:** `initiateSTKPush` is deployed and live. Repository conformance work against the
vendored IntaSend SDK corrected the auth header (`Token` → `Bearer`) and a missing
`method: 'M-PESA'` field. The provider then returned **"Invalid api token"** against a live key on
the live host. That was traced to a merchant-account condition, not code.

**No M-PESA transaction has ever completed end to end.**

For a marketplace whose entire purpose is taking money, this is disqualifying on its own. Launching
means the first real customer is the first live test.

### CRITICAL 2 — No administrator exists, and none can be created

**Evidence:** `bootstrapAdminClaim` gates on `token.email === "admin@mysokoni.co.ke"`. Phone
sign-in carries no `email` claim, so a phone-authenticated owner can never satisfy it. It also
grants only `admin`, never `superAdmin` — while every function that can grant `superAdmin` requires
the caller to already hold it. A repo-wide search confirms **nothing has ever written that claim.**

Consequence: no moderation, no refunds, no user management, no incident response. **If something
goes wrong after launch, nobody can intervene.**

Fixed locally (`8f38864`). Not deployed.

### CRITICAL 3 — Products are not discoverable

**Evidence:** The indexer wrote products to `products_index`; the live search engine reads
`sokoni_products`. Separately, seller uploads never wrote a top-level `status`, while every
retrieval path filters `where('status','==','active')` — and a Firestore equality filter never
matches an absent field.

Either defect alone makes an uploaded product invisible. Both are present.

Fixed locally (`a5201c0`), and the fix **only affects new uploads**. Existing products additionally
require a status backfill and an Algolia reindex, neither of which has been run.

**A marketplace where merchants upload goods no customer can find has no product.**

### CRITICAL 4 — Authorization guards that deny everyone

**Evidence:** Eleven modules guarded on `token.isAdmin` — a claim nothing in the codebase sets.
24 guards evaluated false for **every** caller including legitimate administrators, returning a
correct-looking `permission-denied`.

Separately, 29 of 45 booking-domain handlers threw `ReferenceError: request is not defined` on
their first line — the entire provider-availability and venue-booking surface, dead since
2026-07-11.

Both fixed locally (`ab1dd7e`, `5c3cdae`). **Neither deployed.**

---

## HIGH severity — not individually blocking, collectively serious

| # | Finding | Evidence |
|---|---|---|
| H1 | **112 exported Cloud Functions are not deployed** | 1,421 exported in `index.js`; 1,460 deployed; 112 exported names absent from the deployed set |
| H2 | **Legal Hub returns 403 from Google Frontend** | All 9 callables plus `deviceHeartbeat` — missing Cloud Run `allUsers` invoker. A Firebase redeploy does not restore it |
| H3 | **POS provisioning fails at the first step** | `bootstrapDevice` throws; root cause unconfirmed. Diagnostics and a preflight now exist (`74138b7`, `c8596b5`) but are undeployed |
| H4 | **125 pages unreachable from anywhere** | Navigation audit across all 323 pages; 9 pages have no exit at all |
| H5 | **No live merchant has completed activation** | KASS Vapes activation blocked on the missing admin claim |
| H6 | **Admin SDK credentials revoked** | `invalid_client`. No operator tooling can run — including the backfills the fixes above depend on |

## MEDIUM

- `admin-os.html` ships with no client-side auth gate. It is a launcher — no callables, no Firestore
  access — so this is surface disclosure of the admin tool inventory, not data exposure. Firestore
  rules and server guards remain the enforcement.
- 149 of 323 pages have no confidently assigned workspace; Explore, breadcrumbs and global search
  would inherit that gap.
- `sellerName` is denormalised onto products at creation and never backfilled; `store.html:471`
  matches storefronts by **string equality**, so a merchant rename detaches their own products.

## LOW

- Homepage at ~14s load after optimisation; `demo-seed.js` (140 KB) still shipped though
  production-guarded.
- Duplicate `premium.css` injection makes page-level CSS edits silently ineffective across 75 pages.

---

## Scores

These are **engineering judgement, not measurement.** Where a number cannot be evidenced it is
marked as such. A precise-looking score on an unmeasured dimension would be the same false
confidence this review exists to prevent.

| Dimension | Score | Basis |
|---|---|---|
| Engineering | 55 / 100 | Substantial, well-structured; undermined by undeployed state |
| Security | 60 / 100 | Rules and claims model sound; no admin exists; guards were denying everyone |
| **Financial** | **20 / 100** | **No payment has ever succeeded. Nothing else in this row matters** |
| Operational | 25 / 100 | No admin, no working operator tooling, no incident response path |
| Performance | *not measured* | No load test at any scale has been run |
| UX | 65 / 100 | Mobile layouts verified on 3 devices; navigation has 125 unreachable pages |
| Accessibility | *not measured* | No WCAG audit performed |
| Compliance | 55 / 100 | ODPC Data Processor registration ISSUED (No. 630-8669-F056, valid to 28 Jul 2028); platform compliance assessment tracked separately in docs/ODPC_COMPLIANCE_CERTIFICATION.md |
| Maintainability | 70 / 100 | Strong test coverage added; registry and audit tooling now exist |

**Overall launch score: 40 / 100.**

---

## What would change the decision

In dependency order. Each is a prerequisite for the next.

1. **Restore Admin SDK credentials** — `node functions/scripts/doctor.js` currently reports
   `NOT READY`. Install Python 3 then `gcloud auth application-default login`, or use a
   service-account key.
2. **Push and deploy the 212 commits.** Until this happens nothing else on this list is real.
3. **Provision the first administrator** and verify admin routes at runtime.
4. **Run the status backfill and the Algolia reindex.** Confirm a known product — "Peach Grape" —
   appears in global search, on the storefront, and in category listings.
5. **Complete one live M-PESA transaction end to end.** Until a real shilling moves, payments are
   unproven regardless of code quality.
6. **Complete one POS activation on a real device.**
7. **Restore the Legal Hub Cloud Run invoker bindings.**

Steps 1–5 are the launch gate. Steps 6–7 can follow a limited launch.

---

## A note on method

This review distinguishes throughout between:

- **Runtime verified** — observed executing against the live project
- **Repository verified** — proven by reading code, not by execution
- **Not verified** — neither

Most fixes from the recent cycle are **repository verified only**, because runtime certification
requires an authenticated session that has not been available. That distinction is why this review
recommends NO LAUNCH even though the defect list is shorter than it was: fixing a defect and proving
it fixed are different things, and only the second protects a customer.

Several findings in earlier internal notes were **wrong and have been corrected here** — notably
that gcloud was absent (it is installed but crippled by a missing Python) and that no beta Cloud
Functions were deployed (they are live). Where the record was wrong, the correction is stated rather
than quietly overwritten.

---

## Recommendation to the Board

**Do not launch tomorrow.**

The engineering position is stronger than it looks — the defects found are specific, understood, and
mostly already fixed. The obstacle is not unknown risk. It is that **the repairs have not left the
workstation, and the platform's core commercial function has never once been demonstrated to work.**

A launch that takes a customer's money and cannot complete the payment, cannot show them the
product, and has no administrator able to intervene is not a soft launch. It is an incident with
customers attached.

**Recommended path:** clear steps 1–5 above, then re-review. On current evidence that is days of
work, not months.
