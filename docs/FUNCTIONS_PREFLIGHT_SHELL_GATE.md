# Functions preflight — the shell gate's server authority (`providerDispatch`) — READ ONLY; deployment NOT authorized

**Date:** 2026-09-29/30 · **Packet:** `docs/release-gates/functions-preflight-shell-gate.json` · **Scope:** what a release of `024aff0` / `6269be5` would require on the Functions side, whether the two named blockers actually block it, and what else it would change. Nothing deployed. Production read-only (function describes, one source archive).

## 1 · Which function the shell gate needs

The workspace authority is served as the `businessWorkspace` / `workspaceHome` ops of **one** callable: `providerDispatch` (`functions/provider-dispatch.js` merges `business-workspace._h`). The completion page and the dashboard consumer call nothing else. `applicationDecide` / `applicationLifecycle` are **not** part of this release (Kasindi's repair runs the c4 handler locally; the deployed lifecycle stays as censused).

## 2 · The two blockers, examined on evidence

**Self-mint hotfix.** The standing note said this lineage lacks `1171a16` and a Functions deploy would reopen the P0. Checked on `slice/c4-capability-consumer`:

- `functions/universal-onboarding.js` **does not import Firebase Auth and mints no claim**; the only `setCustomUserClaims` text is inside the comment that explains the removal. The fix reached this lineage as **`537d17e`** ("P0 port — 1171a16 onto feat/creator-hub"), a third port; neither `e5ced91` nor `1171a16` is an ancestor, which is why a cherry-pick check said "does not apply" — it is already applied.
- The fix's own static suite runs green here: `scripts/test-claim-minter-allowlist.js` **21 / 0** ("nothing in the whole functions tree mints a merchant claim").
- Independently, `universal-onboarding.js` is **not in the require closure of `providerDispatch`** at all (98 files; listed in the packet), so a scoped deploy of that function cannot touch the onboarding rail either way.
- **Verdict: not a blocker for this release.** The memory note is corrected.

**merchant-identity provenance gap.** `employeeSaleAuthorize` / `adminLinkMerchantAccounts` are live but unregistered by this branch's `functions/index.js` (detector output confirms). A **blanket** `firebase deploy --only functions` would delete them. A **scoped** `--only functions:providerDispatch` does not delete unregistered functions (proven on the 2026-09-22 POS deploy). `merchant-identity.js` is in the closure and loads normally. **Verdict: blocks blanket deploys, not this scoped one.**

## 3 · What production runs today, and what the redeploy would change

| | Deployed `providerDispatch` | This line |
|---|---|---|
| Built / archive | function updated 2026-09-09T06:02Z; **source archive uploaded 2026-08-22** (`gs://gcf-v2-sources-…/providerDispatch/function-source.zip#1787386174474483`) | tip `6269be5` |
| Require closure | **23 files** | **98 files** |
| Ops (`ROUTES`) | 59 | 64 — **added:** `providerDirectory`, `providerRequestShop`, `healthcareWorkspace`, **`businessWorkspace`**, **`workspaceHome`**; removed: none |
| `business-workspace.js` | **absent** — production has no `businessWorkspace` op today; the live dashboard's call fails and the consumer leaves the sidebar untouched by design | present, with the gate |
| Of the 23 modules production runs | — | **12 changed** (`availability`, `booking-payment-sweep`, `booking-service`, `commission-config`, `finos-utils`, `legal-agreements`, `notify`, `provider-dispatch`, `provider-onboarding`, `provider-ops`, `sms-service`, `subscription-core`), 11 identical; **54 modules new** to that function's closure |

**The honest consequence:** a scoped redeploy of `providerDispatch` does not ship "the shell gate"; it ships the **c4 lineage of all 59 existing provider ops** plus five new ones. Booking, availability, onboarding, subscription and notification behaviour behind those ops would move from the 22 August code to this line's — including entertainment-convergence changes the owner has kept undeployed. That is a lineage jump for one function, not a surgical release. The preflight makes this visible; it does not resolve it.

## 4 · Gates run read-only on this tree

| Gate | Result |
|---|---|
| `gate-functions-require-closure.js` | PASS — entrypoint graph closes from a clean checkout |
| `verify-commission-single-source.js` | PASS |
| `verify-delivery-engine-sync.js` | PASS |
| `predeploy-payout-gate.js` | exit 0 |
| `predeploy-syntax-gate.js` | PASS on this tree earlier today (1,788 files) |
| `functions-allowlist.js providerDispatch` | not blocked; prints `firebase deploy --only functions:providerDispatch` and never runs it |
| `test-claim-minter-allowlist.js` | 21 / 0 |

## 5 · Hosting side (separate gate, same rule as before)

The completion path needs three files on the **live hosting line** (`ec452fb`, my worktree `C:/temp/sok-reack`): `complete-application.html`, `sokoni-complete-application.js`, and the updated `sokoni-business-workspace.js` consumer. Dependencies already served live: `hub-register.js`, `sokoni-commission-rates.js`, `firebase.js`, `sokoni-auth-state.js`, `sokoni-legal.css`. **One dependency gap:** the live `hub-register.js` has **no agreement acknowledgement** (the c4 one has the agreement modal), so a fresh application filed through the live intake arrives unacknowledged; the completion surface then shows the acknowledge step (`/agreement-acknowledge`, live) before SOKONI can decide it. Acceptable, but it means two steps for the applicant until `hub-register.js` is ported. Hosting must not ship the consumer before the function that answers it, or every provider dashboard would see a failed call (harmless by design, but pointless).

## 6 · Options for the owner (the preflight recommends none of them tonight)

1. **Scoped `providerDispatch` redeploy from this line** — clears both named blockers, but ships the c4 lineage of 59 ops (§3). Needs its own behaviour census of the 12 changed modules against the deployed versions before anyone can call it safe.
2. **Port the shell gate onto the lineage production already runs** (the 22 Aug archive's modules): add `business-workspace.js` + `shared/*` + the two ops to that closure and deploy from there — a surgical release, but the R1/R2 capability model, C1 category stamps and `application-lifecycle.js` dependencies would have to come with it (the gate reads them), which is most of the c4 line anyway.
3. **Hold**, as the owner said; the census population stays misrouted meanwhile.

Whichever is chosen: deploy from a committed, clean tree; re-run `gcloud functions describe providerDispatch` immediately before; verify live with a signed-in provider account you own (not Kasindi) that `businessWorkspace` answers with `approval.state`; rollback = the previous revision (`providerdispatch-…`, listed in the packet) via the Cloud Run revision, never `run services update`.

Related: [[COMPLETE_APPLICATION_SHELL_GATE]] · [[PROVENANCE_GAP_MERCHANT_IDENTITY]] · [[project_onboarding_selfmint_live]]
