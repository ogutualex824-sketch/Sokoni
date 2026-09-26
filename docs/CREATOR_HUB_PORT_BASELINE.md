# Creator Hub port — Phase 0 baseline (read-only)

**Status:** **STOPPED at Phase 0 — 2026-09-26.** No port branch created, nothing ported, nothing
deployed. The live payment authority is not held by any single branch, so no port target can
preserve it. Related: [[CREATOR_HUB]], [[CREATOR_PAYMENT_ARCHITECTURE]],
[[PROVENANCE_GAP_MERCHANT_IDENTITY]], [[REFUND_AUTHORITY_CONVERGENCE]].

All evidence below is read-only: git ancestry, the served `version.json`, Cloud Run revision
metadata, and the deployed function source archives (`gcf-v2-sources-…`), byte-identified against
the repository with `git hash-object` + `git log --all --find-object`.

## Source

| | |
|---|---|
| Source commit | `4770c5c` (`feat/creator-hub`, clean) |
| Candidate history | `61098e9` payout outcome_unknown · `23e5fa4` STK single-flight + method authority · `7fc0643` completion · `4770c5c` gap closure (+ the Creator commits since base `a38b31a`) |

## The live release lineage (hosting)

| Fact | Evidence |
|---|---|
| Served hosting | `be7c676`, branch `ship/catalogue-port-on-live`, built 2026-09-22T14:45:59Z (`https://mysokoni.co.ke/version.json`) |
| Descendants of `be7c676` | `ship/catalogue-port-on-live` tip `61912dd` (+16, worktree `C:/temp/sok-host-port`, **5 uncommitted files — another agent**) · `release/comms-on-live` tip `618aadd` (+17, worktree `C:/temp/sok-commsport`, clean). They diverge from each other at `be7c676`. |
| `111dbd7` owning ancestor | yes — in both release branches |
| `f194c02` provenance registration | yes — in both release branches; **not** in `4770c5c` |
| Merge base candidate ↔ `111dbd7` | `3dcf572` (2026-08-13) — 579 live commits not in the candidate, 483 candidate commits not in live |
| Served storage rules | ruleset `182624f3…` (2026-07-27) == `111dbd7:storage.rules` byte-for-byte |

## The live PAYMENT authority (functions) — the blocker

Production functions are deployed per function, from different trees. The payment functions this
release touches were deployed **before** live hosting and from **different** source commits:

| Function (last deploy) | Deployed file → introduced by | in `release/comms-on-live` | in `ship/catalogue-port-on-live` | in `4770c5c` |
|---|---|---|---|---|
| `webhookIntasend` (09-06) | `index.js` → `bb88891` | **no** | **no** | **no** |
| `initiateSTKPush` (09-14) | `index.js` → `76571a1` | **no** | **no** | yes |
| `createPaymentIntent` (08-29) | `index.js` → `7d115bc` | **no** | **no** | **no** |
| `fosSubmitRefund` / `fosApproveRefund` (08-31) | `financial-os.js` → `da3f9e4` | **no** | **no** | **no** |
| `adminOsDispatch` (09-01) | `admin-os.js` → `18cfe7f` | **no** | **no** | **no** |
| `requestSellerPayout` (08-22) | `index.js` → `d6655bd` · `wallet.js` → `33031f2` | yes | yes | `wallet.js` yes, `index.js` no |

The `webhookIntasend` body itself differs: deployed 39,785 B (sha1 `3e35f1d9…`) · both release
branches 33,064 B (`2a6ed3e1…`) · candidate 51,373 B (`e31347a3…`).

Where the missing sources live: `bb88891` → `release/functions-reconciled`, `integration/rc-converged`,
`release/payments-reconciled` (+4) · `76571a1` → `feat/integrations-control-center`,
`feat/business-wallet-authority` (+15) · `7d115bc` → `fix/commission-subsystem-converge`,
`fix/seller-commission-48h-obligation` (+2) · `da3f9e4` → **only** `design/f5-fos-settlement` ·
`18cfe7f` → `feat/adminos-convergence`, `origin/main` (+6).

**Coverage:** of the 11 sources that make up the live payment + hosting + provenance state, the best
branch in the repository carries **6**. No branch carries all of them.

## Consequence

Porting Creator Hub onto `release/comms-on-live` or `ship/catalogue-port-on-live` fixes hosting,
provenance and storage rules — but a later deploy of `webhookIntasend`, `createPaymentIntent`,
`fos*Refund` or `adminOsDispatch` from that port would **replace the serving payment code with
different code**: the same rollback class that disqualified `4770c5c`. The Creator webhook exits
cannot be "integrated into the live webhook authority" on a base that does not contain the live
webhook.

## Sensitive files (for any future port)

`functions/index.js` (webhook, STK, intents), `functions/financial-os.js` (refunds, authority C),
`functions/wallet.js` (frozen; payouts), `functions/admin-os.js` + `functions/admin-os-dispatch.js`,
`functions/payment-intents.js`, `functions/payment-adapters.js`, Creator frontend
(`creator*.html`, `sokoni-aos-creator.js`, `sokoni-creator-*.js`, `sokoni-payout-intent.js`,
`search.html`, `wallet.html`, `provider-dashboard.html`), `storage.rules`.

**Wallet freeze:** `wallet-backend-v1.0-frozen` — the deployed `wallet.js` (`33031f2`) is in both
release branches; the candidate's `wallet.js` adds the payout repair and must not replace it
casually.

## What must be decided before Phase 1 can start

A **production functions composition** decision — which tree is the release source for the payment
functions — made by the owner, not inferred here (the earlier finding stands: *"no canonical
single-lineage composition has been established"*). Either:

1. **Converge the payment lineages first**: bring `bb88891`, `7d115bc`, `da3f9e4`, `18cfe7f`,
   `76571a1` into one release branch (each is its own reviewed merge), prove it byte-matches every
   serving payment function, THEN port Creator Hub onto it; or
2. **Declare the release branch authoritative** and accept, function by function and in writing,
   that deploying it replaces the serving payment code (a deliberate rollback decision per function).

Until then: DEPLOYMENT = BLOCKED, PORT = NOT STARTED.
