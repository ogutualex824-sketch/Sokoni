# Connected Workspace — final certification

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **NOT deployed** (hosting live is `be7c676`; functions deploys stay gated by the merchant-identity provenance gap).
Programme: [[ADMINOS_NAVIGATION_CERTIFICATION]] (D, E) → verification (V1–V3) → [[COMMUNICATIONS_CENSUS_C1]] (C1–C6). Related: [[INTEGRATIONS_CONTROL_CENTER]], [[Authentication]], [[Orders]].

## What was certified

One authoritative SOKONI operational workspace, with external providers as connected rails:

```
                   ┌─────────────────────┐
                   │      AdminOS        │  admin-os.html — the canonical workspace
                   │ canonical workspace │  Super Admin links to it; nothing duplicates it
                   └──────────┬──────────┘
                              │
      ┌──────────────┬────────┼────────┬──────────────┐
      ↓              ↓        ↓        ↓              ↓
 Verification    Support   Email    Connect       Operations
 #applications/  #support  #comms/  #comms/       #integrations
 verification              email    connect
      │              │        │        │
      └──────────────┴────────┴────────┘
                     │  shared records, linked by STABLE ID (sokoni-record-links.js)
      ┌──────────────┼──────────────┐
      ↓              ↓              ↓
   SendGrid    Africa's Talking   SOKONI Connect
   outbound ✓  SMS ✓              webrtc ✓
   events ✓    delivery reports ✓ pstn ✗ (not provisioned)
   inbound mail ✗ (DMARC only)   inbound SMS ✗ · voice ✗
```

| Slice | Commit | Delivered | Suite | Result |
|---|---|---|---|---|
| A–A3 | `a51f268` `5750f8f` `9d1d5f2` | production sidebar imported; shell opt-out; mobile rule reuse | — | in D/E suites |
| B | `65d3d2e` | one scrolling nav, accessible drawer, `aria-current` | `test-adminos-sidebar-a11y` | 34 / 0 |
| C1–C2 | `d007402` `94935b1` | hierarchy, `#section/tab`, Super Admin reachability | `test-adminos-nav-coverage` | 32 / 0 |
| D | `3f437f7` | one primary path, bell canonical, responsive | `test-adminos-single-navigation`, `test-adminos-shell-final` | 22 / 0 · 48 / 0 |
| E | `cdf9403` | navigation ledger on the landed tree | — | ledger |
| V1 | `8450711` `9a9b55c` | ONE reviewer (`sokoni-verification-review.js`) at `#applications/verification`; applicant page made lawful; duplicates retired to redirects | `test-verification-convergence`, `test-verification-rules` | 29 / 0 · 22 / 0 |
| V2 | `73204b6` | server ticket `context {applicationId?, requestId?, verificationId?}`; ticket ↔ record both ways; `crmSupportTickets` untouched | `test-ticket-context`, `test-support-context` | 18 / 0 · 19 / 0 |
| V3 | `18f19d9` | video verification as a contextual action on eligible records, ONE Connect path, evidence not verdict | `test-video-verification-actions`, `test-connect-authority` | 18 / 0 · 856 / 0 |
| C1 | `895cd7d` | communications census, read-only | — | ledger |
| C2 | `ba3c854` | email workspace: outbound real, inbound NOT provisioned, no reply control | `test-email-workspace` | 24 / 0 |
| C3 | `b48d367` | SendGrid by lane; DMARC-only inbound entry; card keeps configuration / capability / workspace apart | `test-integration-comms-lanes`, parity, console, evidence, disagreement, census | 59 / 0 · 26 / 0 · 119 / 0 · 69 / 0 · 21 / 0 · PASSED |
| C4 | `402a34f` | Africa's Talking by lane; SMS workspace delivery evidence | `test-sms-workspace` | 16 / 0 |
| C5 | `c52a5dd` `449abc3` | the support number has one source, fails closed | `test-support-phone` | 9 / 0 |
| C6 | `872c8f4` | every app reaches the same record by stable id | `test-record-links` | 21 / 0 |

Runner: `node scripts/certify-connected-workspace.js [--json docs/release-gates/connected-workspace.json]` — runs every
suite above one at a time and refuses the whole if any did not end green (floors, not equality).

## The thirteen constraints, and where each is proven

| Constraint | Held by |
|---|---|
| `integrationProbeLatest` untouched | `test-integration-comms-lanes` B (no touched file names it; `admin-os.js` still the only writer) |
| No synthetic inbound observations | `sendgrid-inbound-parse` has no executor and no stage-support row (D2 control plants one and is caught); AT delivery reports are provider callbacks only |
| REFUSED BY DESIGN ≠ UNKNOWN | lanes suite B: `sendgrid` `requires_secret_binding` vs inbound lane `null` on the same resolver; console renders REFUSED BY DESIGN vs NOT PROBED |
| `no_safe_probe` is a declaration | unchanged executor table; `test-integration-disagreement` 21 / 0 |
| `requires_secret_binding` ≠ observed evidence | lanes suite: both secrets present → `credentialState: configured`, `health: unknown` |
| Connect evidence is not the verdict | `test-video-verification-actions`; reviewer approve path is badge-first, never from a session outcome |
| Server authorization authoritative | `test-verification-rules` (served ruleset), `test-ticket-context` (handler refuses malformed context), support lookup owner-only |
| No localStorage admin authority | V1a removed `verification_requests`/local paths; `test-verification-convergence` static checks |
| No fabricated support number | `test-support-phone` C (empty config → no digit anywhere) |
| No fabricated email inbound capability | `test-email-workspace` I (zero reply controls; not-provisioned from the server answer) and the C3 inbound entry |
| No fabricated SendGrid / AT capabilities | lanes suite A4: voice/USSD and inbound SMS negations are DERIVED (no caller, no receiver) |
| No production deploy | none performed; every CHANGELOG entry says so; `version.json` untouched by these slices |
| Profile/role-authority chain NOT imported into D | `f4dcb5b` not cherry-picked; recorded as its own slice |

## Honest boundaries (what "certified" does not mean)

- **Functions are not deployed.** Live `adminCreateSupportTicket` drops `context`; live AdminOS is `be7c676` with none of this UI. Certified = the branch behaves as specified under hermetic suites, not that production does.
- **Connect certified ≠ a call works.** ICE connected is not media flowing; no TURN is provisioned.
- **Inbound mail does not exist.** The workspace says so. Building it needs an Inbound Parse host for a human address, a signed receiver, a thread store keyed by Message-ID, and in-thread reply headers.
- **Sabotage suites were not run** for the integrations console (they edit source in place in a repo other agents write).
- **The KEEP artifact-registry checkpoint** is unrelated to these slices and unchanged.

## Open items for the owner

1. `+254 722 376 801` "Call us" line on `contact.html` / `index.html`: no configured authority — promote into `company-identity.js` or remove.
2. Hub pages carry placeholder-looking `tel:` numbers (`car-hub`, `food-rider`, `healthcare`, `legal`); reported by `test-support-phone` each run.
3. Customer notification on an admin ticket reply (`support_reply` type exists; `adminResolveSupportTicket` never notifies) — a functions change; natural `deepLink` is `support.html?ticket=<id>`.
4. Profile menu / role-authority chain (`e7dd99e → 68497f7 → f4dcb5b → 8814a86`) — its own slice.
5. SOKONI Store button needs the `526f330` backend port.
6. Users can self-write `isVerified` / `verifiedTier` on their own `users/{uid}` (FINDING D4 in `test-verification-rules`); badge authority is `verifications/{uid}`, unaffected, but the field is misleading.
7. `smsStats` counts are bounded reads (500 / 200); the card labels them; a true total needs an aggregate.

## Re-running

One Chromium suite at a time on the 6 GB host. `node scripts/certify-connected-workspace.js --json docs/release-gates/connected-workspace.json`.
Every suite is hermetic (fake host `sokoni-cert.test`, other origins aborted, compat Firebase stub); none can reach production.
