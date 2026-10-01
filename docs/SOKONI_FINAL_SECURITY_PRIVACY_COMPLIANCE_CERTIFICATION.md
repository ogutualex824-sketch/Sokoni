# SOKONI — Security, Privacy, Compliance & Operations Certification (engineering self-assessment)

**Status: PRE-DEPLOYMENT — NOT CERTIFIED.** Repairs are written, tested and committed on branches, but
**none is deployed** as of 2026-10-01. Under the certification rule (code fix + automated test +
integration test + production verification + observability + rollback path + documentation), every
item below stays **UNPROVEN in production** until its deploy is verified live. This is an internal
engineering assessment. It is **not** an official regulatory certification and it does not certify
SOKONI as "fully secure" or "fully compliant".

**Related:** [[SECURITY_PRIVACY_GAP_CENSUS_2026-10-01]] · [[ODPC_COMPLIANCE_CERTIFICATION]] ·
[[BLUE_GREEN_RECOVERY]] · [[PASSWORD_RESET_25_MINUTES]] · [[THIRD_PARTY_LICENSES]]

**Labels:**
- **PASS:** proven in production.
- **FIXED:** code and tests are done, not deployed.
- **FAIL:** a defect is open with no fix written.
- **UNPROVEN:** there is not enough evidence either way.
- **N/A:** does not apply.

## A–F. Baseline

| Item | Value |
|---|---|
| A. Baseline (live hosting) | `72dca56`, v649, unchanged on 2026-10-01 |
| B. Final commit | not yet; see the repair branches below |
| C. Live hosting version | `be7183e87a95c14a` (live release), commit 72dca56 |
| D. Function revisions (sample) | applicationLifecycle 00007-nox · sokoniChat 00058-hal · webhookIntasend 00068-del · finaliseExpiredDeletions 00005-sof · getErrorLog 00007-fik · processEmailQueue 00044-yos — 1,723 functions in all |
| E. Firestore rules | served `b87c94e4`. Storage rules `182624f3` |
| F. Composite indexes | 416 live, all READY. The repo has 408; 8 exist only live |

## Repair branches (all pushed, none deployed)

| Branch | Surface | Contents |
|---|---|---|
| `port/password-reset-25m-on-shell-gate` | named functions | 25-minute reset (2 new functions) · getErrorLog → errorLog · marketing fail-closed + `emailUnsubscribe` + posSendSMS admin-only · updateEmailPreferences hardened + consent rows · erasure (no-index query, purge 1.1.0, honest outcome) · data-rights intake limits · shared fail-closed limiter |
| `port/booking-pin-on-shell-gate` | `functions:providerDispatch` | providerPublish gated by admin approval · priced plans not self-activatable |
| `hosting/trust-integrity-on-union` | hosting | fabrications and fake contacts removed · reset page · signup consent · fail-closed legal gate · canonical notices · cookie control · DNT/GPC · a11y · licences · recover.js · ops-center escaping · /email-preferences |
| `hosting/admin-failures-on-chain` | hosting (merged by sokoni-aa) | AdminOS + Super Admin Failures view |
| sokoni-32 `rules/capability-decisions-on-f20be7d` @51cbbf1 | Firestore rules | includes this programme's verification write:false and jobs precedence fix (emulator 16/0 vs served 10/6) |
| sokoni-70 `fix/kass-auth-budget-on-e521e03` @adde663 | `functions:sokoniChat` | chat auth bypass + AI cost caps (sokoni-70's) |

## G–Y. Findings and status

| # | Area | Status | Evidence |
|---|---|---|---|
| G | API inventory | UNPROVEN | 1,723 functions, ingress ALLOW_ALL; ~60% of callables enforce App Check (census). No machine-readable per-endpoint inventory yet. |
| H | Rate limits | FIXED for reset + data-rights intake; FAIL elsewhere | New fail-closed `shared/durable-limit.js` (tests: reset 25/0, intake 7/0). The shared limiters still fail open, and only ~42 of 1,678 callables reference a limiter. |
| I | Identity / UID containment | FIXED (verification badge, jobs — in sokoni-32's rules release) · FAIL, evidence handed to sokoni-32 (conversations, accountProfiles and deliveryRiders: safe as proposed; deliveries, orders and users: safe with adjustment, ≈ +1.5 KB) · POS cross-tenant with sokoni-70 | Census 1. Writer census across 402 refs with positive controls (scratchpad rules-census). Owner decision: whether  stays sender-writable. |
| J | 25-minute password reset | FIXED | `test-password-reset-25m` 25/0: 24m59s works, 25m01s refused; sabotage fails it. Residual: native 1-hour codes via direct API (config). |
| K | Rider approval | FAIL — owned by sokoni-27 | Wording, agreement and revocation findings handed over; none fixed on any branch. |
| L | Provider approval / publication | FIXED | `test-provider-publish-gate` 19/0. Counterproof on live code: self-publish → active + claim; enterprise plan on a fake ref → 5% commission. |
| M | Consent persistence | FIXED (signup, email marketing) · UNPROVEN (cookie choice is browser-only) | `test-signup-consent` 23/0 · `test-email-consent` 26/0 |
| N | Data deletion | FIXED | `test-erasure-finalise` 10/0. The live code reproduces the production FAILED_PRECONDITION. Backlog 0. Self-cancel during the grace period is still open. |
| O | Data rights | FIXED (intake) | The enum fix is already live. Intake App Check, limits and pseudonymised IP are in `test-rights-intake` 7/0. |
| P | Logging | PARTIAL | Logs are flowing (490/500 JSON). There is no deployment-version or trace field, and 1,048 `console.*` calls. |
| Q | Alert delivery | FAIL / UNPROVEN | The P95 alert fires on everything (threshold in the wrong unit). The fix is prepared, but the change was **denied by the permission system** and needs the owner. Five policies can never fire. Delivery has not been tested. |
| R | AdminOS failure view | FIXED | `hosting/admin-failures-on-chain` 7383ca5, `test-admin-failures` 37/0. Browser suites are queued. |
| S | Super Admin failure view | FIXED | same module and test |
| T | Accessibility | PARTIAL | Contrast token 6.25:1, labels, zoom and alt text fixed (`test-trust-integrity` §F). 969 onclick handlers on non-controls remain. No keyboard-only browser run yet. |
| U | Third-party SDKs / licences | PARTIAL | `docs/THIRD_PARTY_LICENSES.md`, Font Awesome licence. Nine Firebase SDK versions and 16 scripts without SRI remain. |
| V | Legal / policy | PARTIAL | Canonical notice links and the cookie-settings control are done. **Owner decisions are open** (see below). |
| W | Blue-green / rollback | FIXED tooling · UNPROVEN drill | `recover.js` was verified read-only against production: it refused a rollback to a revision whose image is deleted and passed a recent one. The hosting drill needs a deploy window. |
| X | Performance | UNPROVEN | No before/after measurements yet. Census: home page ~19 s on a phone-like profile; recommendations index missing. |
| Y | Remaining UNPROVEN | — | Everything marked FIXED, until it is deployed and verified live. Also the browser suites, the alert delivery test and the rollback drill. |

## Owner decisions blocking certification

1. Data Controller registration. The certificate registers a Data Processor only, while the privacy notice names the Data Controller.
2. Named DPO.
3. Age verification method (18+ is self-declared today).
4. KYC document retention period.
5. Real main phone number (`+254 800 SOKONI` is a placeholder).
6. The P95 alert threshold change, which was denied by the permission system and must be run or authorized by the owner.
7. One consented test notification to the alert channel.
8. The hosting rollback drill window.
9. Hiding the PayPal, Chipper, MTN and EcoCash checkout options, which have no payment rail.
10. A consent design for merchant SMS marketing.
11. Least-privilege policy for platform admins acting inside merchant shops.

## Deployment order (when the shared queue allows; one deploy at a time; RAM floor 512 MB)

1. Functions, one named set at a time, each after a fresh live-archive diff:
   - the security set from `port/password-reset-25m-on-shell-gate`;
   - providerDispatch with the booking-PIN trio;
   - sokoni-70's sokoniChat.
2. Rules: sokoni-32's single combined release.
3. Hosting, in order:
   - the queued union `hosting/pos-stk-plus-earn-on-72dca56`;
   - sokoni-aa's chain, including the Failures view;
   - sokoni-32's B2;
   - `hosting/trust-integrity-on-union`, merged on top of them.
4. After each deploy:
   - verify live (`version.json` and function revisions);
   - rerun the adversarial checks against production;
   - update this document from FIXED to PASS only where verified.
