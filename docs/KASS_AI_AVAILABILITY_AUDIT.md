# KASS AI — provenance and production-availability audit

**Status:** 📋 READ-ONLY AUDIT — root cause found. No code changed, no deploy run.
**Date:** 2026-09-03 · **Classification: BROKEN IN PRODUCTION** (not unbuilt, not undeployed, not
a routing/entitlement gap).

---

## The chain, traced end to end

```
KASS AI (customer-facing "SOKONI's marketplace AI")
  source        functions/index.js:1617-2114 (exports.sokoniChat) + kass-widget.js (frontend)
                 + functions/kass-knowledge.js, kass-memory.js, kass-modes.js, kass-corpus.js
  entry point    kass-widget.js, loaded on 104 pages including the homepage (lazy-loaded)
  route          POST /api/chat  →  firebase.json hosting rewrite  →  function "sokoniChat", us-central1
  backend fn     exports.sokoniChat (onRequest) — state ACTIVE, last updated 2026-08-22T08:06:52Z
  secret/config  ANTHROPIC_API_KEY — EXISTS in Secret Manager (created 2026-06-08)
  entitlement    NONE — any authenticated user (auth_token required); not premium-gated
  production     BROKEN — see below
```

A second, separate KASS surface exists for admins:

```
KASS AI (admin agent, "SOKONI Admin AI Agent")
  source        functions/index.js:855-2114 region (exports.kass)
  entry point    admin.html's embedded panel (window.kassSend, correctly wired)
  route          direct fetch to https://us-central1-sokoni-aeb26.cloudfunctions.net/kass (no hosting rewrite)
  backend fn     exports.kass (onRequest) — state ACTIVE, last updated 2026-08-22T07:32:58Z
  secret/config  same ANTHROPIC_API_KEY
  entitlement    admin custom claim (decodedToken.admin === true) + MFA enforced
  production     zero real requests in 30d — untested empirically, but shares the same
                 exhausted account, so almost certainly fails identically if invoked (inference,
                 not measured — flagged as such)
```

---

## What is NOT the problem

- **Not unbuilt.** `sokoniChat` is a complete, non-trivial implementation: knowledge retrieval,
  session memory, mode detection, tool-calling (cancel order, wishlist, booking), behavioural
  personalisation, injection-detection logging.
- **Not undeployed.** `gcloud functions describe sokoniChat` returns `state: ACTIVE`.
- **Not a routing gap.** Live production probes against `https://mysokoni.co.ke/api/chat`:
  - `GET` → `405 {"error":"Method not allowed"}` — exact match to the code's method guard.
  - `POST` with no `auth_token` → `401 {"error":"Authentication required to use KASS AI."}` —
    exact match to `functions/index.js:1642`.
  Both prove the hosting rewrite reaches the correct function and the correct code path executes.
- **Not a missing secret.** `ANTHROPIC_API_KEY` exists in Secret Manager and is attached to both
  functions' `secrets` config.
- **Not an entitlement gate.** No premium/plan check exists on the customer-facing path — every
  signed-in user is allowed to call it.
- **Not a frontend-pointing-at-a-retired-backend problem for the widget people actually see.**
  `kass-widget.js` (104 pages, including the homepage) correctly `fetch()`s `/api/chat`.

## What IS the problem

**The Anthropic account behind `ANTHROPIC_API_KEY` has exhausted its credit balance.** Every real
production call fails with:

```
BadRequestError: 400 {"type":"error","error":{"type":"invalid_request_error",
"message":"Your credit balance is too low to access the Anthropic API. Please go to
Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Cegam6E92Hym4WHerEs9G"}
  at APIError.generate (/workspace/node_modules/@anthropic-ai/sdk/error.js:41:20)
  ...
  at async /workspace/index.js:2086:23
```
(captured verbatim from `run.googleapis.com/stderr`, `sokonichat` service, 2026-09-03T13:26:50Z)

The code correctly catches this (`functions/index.js:2110-2112`) and returns
`{"error":"KASS is temporarily unavailable. Please try again in a moment."}` — **this is the exact
"unavailable" message the product surfaces.** It is not a bug in that catch block; it is doing
precisely what it should when the upstream API is unreachable for billing reasons.

**This is not new or transient.** The identical error was captured at four widely-spaced points
across the 30-day retention window: 2026-08-04, 2026-08-19, 2026-09-03T06:18, and 2026-09-03T13:26.
The outage has been ongoing for at least a month (30 days is the limit of what Cloud Logging
retains — it may be older).

**Real-world impact, measured:** of 14 total real requests to `sokoniChat` in the 30-day window,
**10 (71%) returned `500`** from this exact cause. The other real responses were `405`/`401`
(method/auth guard hits, not AI attempts).

---

## A separate, secondary, currently-inert defect found along the way

The six full-page role assistants — `kass-executive.html`, `kass-manager.html`, `kass-finance.html`,
`kass-seller.html`, `kass-support.html`, `kass-developer.html` — all call:
```js
const sokoniChat = firebase.app().functions('us-central1').httpsCallable('sokoniChat');
```
This is the **wrong invocation method**. `httpsCallable()` is for `onCall`-type functions;
`sokoniChat` is an `onRequest` HTTP function with a hand-rolled body/response shape
(`{messages, auth_token}` in, `{response, results, actions}` or `{error}` out) — not the Callable
wire protocol. This call would fail regardless of the Anthropic billing state.

**This is not currently affecting real users.** Only 3 of the 6 pages are linked at all
(`vision-2030.html`, for `-executive`/`-finance`/`-seller`), and `vision-2030.html` itself is
referenced only from `service-worker.js`'s precache list — not from any real in-app navigation
(`sokoni-nav-engine.js` has zero references to any `kass-*.html` page). All six are effectively
unreachable from the live product today. Flagged for the release-stack ledger, not fixed here —
per the "do not rebuild because it says unavailable" instruction, and because it's not the cause
of what a real user would see.

---

## Classification

| surface | classification |
|---|---|
| `sokoniChat` (customer widget, 104 pages) | **BROKEN IN PRODUCTION** — built, deployed, correctly routed, correctly entitled; fails on every real call due to exhausted third-party API billing |
| `kass` (admin agent) | **BUILT + DEPLOYED, availability unverified** — correctly wired, zero real traffic in 30d to confirm either way, shares the same likely-exhausted account |
| six `kass-*.html` role pages | **PARTIALLY DEPLOYED / BROKEN** (wrong invocation protocol) **+ effectively unreachable** (not linked from real navigation) |

## What this means for "do we rebuild it"

**No rebuild is indicated.** The fix for the surface real users hit (`sokoniChat`) is not a code
change — the code is doing the right thing — it is a **billing action**: top up or resolve the
Anthropic account's credit balance behind `ANTHROPIC_API_KEY`. That is outside this session's scope
(no payment/billing action was taken or is proposed here). Once credits are restored, the existing
build should work as-is; re-verify with the same live-probe method used here before declaring it
fixed, since "the account now has credit" is a claim to verify, not assume.

The six role-page `httpsCallable` bug is real and independent of the billing issue, but low
priority given zero real reachability — added to the release-stack ledger as a fix-when-convenient
item, not urgent.

## What was not checked

- Whether the Anthropic account has since been topped up (this is a point-in-time reading,
  2026-09-03T13:26Z being the most recent captured failure).
- Full end-to-end success of an authenticated real user's message (would require a real ID token
  and would incur real Anthropic cost even if credits were restored — not attempted).
- The `kass` admin function's actual behavior under load — zero real invocations in the measured
  window means this is inferred from shared configuration, not observed.
