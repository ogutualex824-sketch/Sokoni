# Landing — Hosting `2f3bb6f`: shell-gate consumer + Complete Application surface, DEPLOYED (owner-authorized)

**Deployed 2026-09-30T03:07:38Z** — Hosting release `1790737658252000`, version **`6f7202bd5dd81d84`**, from `C:/temp/sok-host-gate` at `2f3bb6f` (clean), `firebase deploy --only hosting`. Rollback: version `3cbdf961791900b8` (FINALIZED, available). **Packet:** `docs/release-gates/hosting-landing-shell-gate-consumer.json`. Server side: `providerdispatch-00050-rur` unchanged. Rules unchanged (`b87c94e4`). No function updated. Kasindi not read, not written.

## 1 · The attempt that stopped first, and why

The first attempt aborted in the live line's hosting predeploy chain at `scripts/predeploy-browser-suites.js` (the hook added by `df470e1`: 32 required release suites must execute, fail closed). 31 executed clean; `test-approval-primitive.js` crashed loading `functions/pos-staff-ops.js` → `firebase-functions/logger`. Cause: my hosting worktree had a root `node_modules` junction but **no `functions/node_modules`**. The CLI surfaced the hook's exit 1 as a cross-spawn `ENOENT` (a Windows reinterpretation, not a missing file). Production untouched; the regenerated `service-worker.js` / `version.json` were reverted so the candidate stayed byte-identical. After the junction was added the hook reported **32 / 32 EXECUTED**, the quick preflight was re-run (live still `49e0f3a`, no version in CREATED, tree clean at `2f3bb6f`, markers 404), and the same candidate was deployed. Nothing in the candidate changed between the attempts.

## 2 · Verification (cache-busted)

| Check | Observed |
|---|---|
| Live pointer | `version.json` commit **`2f3bb6f`**, branch `hosting/shell-gate-consumer-on-49e0f3a`, cacheVersion `-v645`, dirtyWorkingTree false |
| Three previously missing paths | `/complete-application` **200**, `/sokoni-complete-application.js` **200**, `/sokoni-business-workspace.js` **200** |
| Byte identity, served vs candidate | consumer `98e516ef0e07…` = candidate; module `3f681de25d85…` = candidate; page `9cf6ecb4a69f…` = candidate |
| `provider-dashboard.html` loads the consumer | the script tag is present in the served page |
| Markers | page carries `data-ca-state="boot"`; consumer carries `REAPPLICATION_REQUIRED` |
| Signed-out behaviour (live Chromium, automation fingerprint off) | `/complete-application` → `data-ca-state="signed_out"`, sign-in note rendered, **zero Firestore requests**, no console errors, no horizontal overflow at 390 px |
| Other surfaces | `/provider-dashboard` 200, `/agreement-acknowledge` 200 |
| Hosting files | 865 (864 + the new page; the three JS/HTML files were among 6 uploads with the regenerated artefacts) |
| Rules / Functions | ruleset `b87c94e4` unchanged; `providerdispatch-00050-rur` still serving; no function updated in the last 40 minutes |
| Rollback | `3cbdf961791900b8` FINALIZED, available |

## 3 · Signed-in behaviour — what is and is not live evidence

Valid-provider-unchanged, REAPPLICATION_REQUIRED → completion surface, and refused-provider notice were **not exercised on production**: each needs a real provider browser session (App Check + a signed `provider` claim), and the only such account in scope is Kasindi's, which is excluded. They are proven on this exact tree in Chromium against the deployed dispatcher code (`c7e26b6`): 21 / 0. Stated as harness evidence.

## 4 · What is now live for users

A provider holding the `provider` claim who opens the dashboard now receives the server's derived approval state. A held account (Kasindi's and Langa'ta mamafua's class) is sent to `/complete-application`; a valid provider sees no change; a refused provider sees the explanation. Buyers, sellers on `merchant-v2`, shop homes and the onboarding path are unchanged by this release (DJ Bvmbxno, holding no claim, is still sent to onboarding by the dashboard's own guard, as before).

## 5 · Repository state

Live hosting lineage is now `2f3bb6f` on `hosting/shell-gate-consumer-on-49e0f3a`; any future hosting candidate must descend from it. Peer session sokoni-45 has recorded that its own hosting branch diverges from live as of this release and will merge `2f3bb6f` before any hosting deploy of its own. Release artefacts committed on the candidate branch.

Related: [[HOSTING_PREFLIGHT_SHELL_GATE_CONSUMER]] · [[LANDING_PROVIDERDISPATCH_SHELL_GATE]] · [[COMPLETE_APPLICATION_SHELL_GATE]]
