# Hosting preflight — shell-gate consumer + Complete Application surface on the live line (`49e0f3a`) — READ ONLY; deployment NOT authorized

**Date:** 2026-09-30 · **Candidate:** worktree `C:/temp/sok-host-gate` (mine), branch `hosting/shell-gate-consumer-on-49e0f3a`, tip **`2f3bb6f`** = live `49e0f3a` + one commit · **Packet:** `docs/release-gates/hosting-preflight-shell-gate-consumer.json`. Server side already live: `providerDispatch` revision `providerdispatch-00050-rur` ([[LANDING_PROVIDERDISPATCH_SHELL_GATE]]). This is the consumer that makes it act.

## 1 · Lineage

Live hosting: `49e0f3a` (`feat/d2-rider-portal-on-ec452fb`, v644, built 2026-09-30T00:11Z; Hosting release `1790727624889000`, version `3cbdf961791900b8`, released 00:20Z by another session). The candidate is that commit plus `2f3bb6f`; `git merge-base --is-ancestor 49e0f3a 2f3bb6f` → yes; rollback guard: "contains live — allowing". The peer worktree holding the live branch is untouched.

## 2 · Exactly what Hosting would ship (4 files)

| File | Change | sha256 (candidate) | Identical to the capability line |
|---|---|---|---|
| `provider-dashboard.html` | **+2 lines** only: a comment and `<script src="sokoni-business-workspace.js" defer></script>` after `sokoni-provider.js` | — | n/a (live page, minimal edit) |
| `sokoni-business-workspace.js` | new on the live line — the consumer (redirects REAPPLICATION_REQUIRED to the server-named route; creates the notice box if the page has none) | `98e516ef0e07…` | yes |
| `complete-application.html` | new | `9cf6ecb4a69f…` | yes |
| `sokoni-complete-application.js` | new | `3f681de25d85…` | yes |

Not shipped (hosting ignore): `scripts/**` test files. No functions, no rules, no other page.

## 3 · Proof

| Check | Result |
|---|---|
| `test-complete-application-browser.js` run **in the candidate tree against the DEPLOYED function code** (`FUNCTIONS_DIR=C:/temp/sok-pd-cand/functions`, i.e. `c7e26b6`, with the real dispatcher handlers answering the dashboard's boot ops) | **21 / 0**: six accounts render per the server's state; intake CTA opens the existing HubRegister modal; select_among_pending withdraws one; **the live `provider-dashboard.html` redirects a REAPPLICATION_REQUIRED provider to `/complete-application`, keeps a VALID provider on the dashboard (`data-ws-state` AVAILABLE), and shows a REFUSED provider the server's explanation in a notice box**; signed-out note; 390 px |
| same suite on the capability line | 21 / 0 |
| capability line regressions after the consumer change | sidebar-browser 90 / 0 · projection-browser 29 / 0 · shell gate 22 / 0 |
| Hosting gates on the candidate | rollback guard allow · cooldown allow · commission single-source PASS · perf-guard PASS · base64 PASS · gate-inventory skipped (no inventory file) · money-toast PASS |
| `predeploy-syntax-gate.js` (run in the candidate tree) | **PASS** — 1,794 JavaScript files and 453 inline script blocks parse cleanly |
| Live dependencies served | `hub-register.js`, `sokoni-commission-rates.js`, `sokoni-auth-state.js`, `firebase.js`, `sokoni-legal.css`, `/agreement-acknowledge` all 200 |
| Post-deploy markers | `/complete-application`, `/sokoni-complete-application.js`, `/sokoni-business-workspace.js` are **404 today** |
| Worktree | clean at `2f3bb6f` |

## 4 · What changes for users when this ships — stated plainly

- Providers who reach `provider-dashboard.html` (the role authority admits only a signed `provider` claim) get a server answer for the first time. **Held accounts are sent to `/complete-application`**: on the census population that is Kasindi and Langa'ta mamafua (invalid legacy, claim held) and any status-only provider holding the claim; DJ Bvmbxno holds no claim and is already sent to onboarding by the live dashboard. Valid providers see no change. Refused (King Bruce) sees the explanation.
- The dashboard's own boot behaviour is unchanged; the consumer runs beside it.
- **Not covered by this slice:** sellers on `merchant-v2` and shop homes still route on role/status in the live shell — the gate for those needs the merchant surface to consult the authority (a later slice).
- Fresh applicants through the live `hub-register.js` intake arrive unacknowledged and take the acknowledgement step on the completion surface (known, from the earlier preflight).

## 5 · Rollback

Re-release Hosting version `3cbdf961791900b8` (the current live). Because the candidate is additive plus one script tag, rolling back removes the redirect and the three new paths.

## 6 · Deploy, when authorized (not now)

From `C:/temp/sok-host-gate` at `2f3bb6f`, clean, after re-reading `version.json` (must still be `49e0f3a`; if it moved to a descendant, rebase; if to a non-ancestor, re-port), one deploy at a time: `firebase deploy --only hosting --project sokoni-aeb26 -m "shell-gate consumer 2f3bb6f"`. Verify cache-busted: `version.json` commit `2f3bb6f`; the three new paths 200 with markers (`data-ca-state="boot"`, `SokoniCompleteApplication`, `REAPPLICATION_REQUIRED`); `provider-dashboard.html` contains the script tag; `/agreement-acknowledge` still 200; Hosting releases +1; Rules and Functions untouched (Hosting-only command). Syntax gate result recorded in the CHANGELOG line for this candidate.

Related: [[LANDING_PROVIDERDISPATCH_SHELL_GATE]] · [[COMPLETE_APPLICATION_SHELL_GATE]] · [[HOSTING_PREFLIGHT_REACK_SURFACE]]
