# B1 — Production-only Cloud Functions: release disposition

> # ✅ **B1 = RESOLVED — human disposition received 2026-09-10**
>
> **Outcome: ZERO deletions this release. The production function surface is left untouched.**
>
> Ten production-only exports were identified. Eight are protected. The two Terminal V1s are
> proven retirement candidates but are recorded as **RETIREMENT-READY, NOT RETIRED** — by
> explicit decision, they are *not* deleted either, so that the live function surface stays
> unchanged until a deployment plan is finalized.
>
> B1 never passed on the strength of the two V1s, and does not now. It is resolved because a
> human made the call on all ten, and the call was **protect everything for now**.

**Date:** 2026-09-10
**Subject tree:** `release/multishop-checkout-certified` @ `c6a1e68`
**Measurement status:** CLOSED — this document is the *disposition*, not a re-measurement.
**Actions taken:** none. Nothing deleted, nothing deployed, nothing pushed.

---

## Accepted disposition (human, 2026-09-10)

| Set | Decision |
|---|---|
| The 5 Daraja functions — `darajaSTKPush`, `darajaSTKCallback`, `validateDarajaCredentials`, `sendTestSTKPush`, `webhookMpesa` | **KEEP / PROTECT** for now |
| `expireBoosts`, `pickupHandover` | **PROTECT** until lineage is reconciled |
| `posSendPurchaseOrder` | **PROTECT** until live obsolescence is proven |
| `posInitiateTerminalPaymentV1`, `posCancelTerminalPaymentV1` | **RETIREMENT-READY — do not delete yet.** Safest release posture: leave the production function surface untouched until the deployment plan is final |

**Consequence:** B1 contributes **no** deletions and **no** function-surface changes to this
release. There is no B1 deploy list. The ten stay exactly as they are.

### Evidence re-verified against the committed tip

The original citations were read from the **working tree**, which is dirty
(`functions/index.js` carries 18 uncommitted lines). All six load-bearing citations were
therefore re-checked against committed `HEAD` (`c6a1e68`) and are **identical** there:
lines 6176, 6252, 12638, 12640, 11549 and 8793. The B1 evidence is valid for the RC tip, not
merely for one machine's working copy.

The uncommitted 18 lines add three *new* exports (`posGateStatus`, `posSettleCommission`,
`posCommissionReminder`) and do not alter any of the ten. See
[[B3_CLEAN_PROVENANCE_GATE]] — they are a B3 finding, not a B1 one.

Related: [[RELEASE_GO_NOGO_de79337]] · [[UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS]] ·
[[ADR-018-legacy-retirement-graph]] · [[RELEASE_STACK_LEDGER]]

---

## 0. Loyalty boundary — DECLARED CLEAN

Loyalty was **out of bounds** for this slice and was **not crossed**.

* No Loyalty function appears in the ten-function set. Verified by name against the set:
  zero matches for `loyal*`.
* Loyalty is **not** in any B1 deploy or retirement list.
* Loyalty was **not** used as collateral for any reconciliation.
* No Loyalty file was modified, refactored, exported, deleted, renamed, or test-changed.
  `functions/loyalty-dispatch.js` and `functions/loyalty-enterprise.js` were **read only**,
  solely to confirm no Loyalty export collides with the set.

No B1 operation required a Loyalty touch, so no `BLOCKED — LOYALTY BOUNDARY` stop was raised.
This boundary continues to bind any successor slice, including the fingerprint/device work.

---

## 1. Evidence status — what is proven, and by whom

Two different kinds of evidence appear below. They are **not** interchangeable.

| Kind | Source | Strength |
|---|---|---|
| **Production-only membership** — that these ten are live in production and absent from / diverged from the RC deploy set | The closed B1 measurement, inherited | Accepted as CLOSED for this decision |
| **In-tree corroboration** — callers, exports, successors, lineage | Verified directly in `c6a1e68` for this document | Reproducible from the file/line citations |

**Not verified here:** live production state. No production query was run for this disposition.
Per `MEMORY.md`, production is `d592d8f`/v632 on `release/r1-pos-printer-fn` — **a different
lineage from this tree**. Any statement below about what production *currently runs* is
inherited from the closed measurement, not re-observed. This distinction is the reason eight
functions cannot be dispositioned by this document alone.

---

## 2. RETIREMENT-READY (not retired) — 2 functions

### `posInitiateTerminalPaymentV1`, `posCancelTerminalPaymentV1`

**Technical status: SAFE TO RETIRE.** All four conditions hold.
**Release disposition: DO NOT DELETE YET** — held by the accepted human disposition above, so
the production function surface stays untouched until the deployment plan is finalized.

| Condition | Evidence |
|---|---|
| Successors exist | `posInitiateTerminalPayment`, `posCancelTerminalPayment` defined in `functions/pos-terminal-live.js:385,550` |
| Successors are exported | Re-exported **by name** in `functions/index.js:12638,12640` — satisfies the `module.exports`-rebind orphan hazard |
| Successors are live | Inherited from the closed measurement |
| Zero served-client references to the V1 names | Whole-repo search excluding `functions/`: **zero hits**. Not one HTML page, client module, or config references either V1 name |

The V1 bodies still sit in the RC tree at `functions/index.js:6176` and `:6252`.

> ### ⚠️ Do NOT generalize this conclusion
>
> This four-condition pattern is what makes these two safe. **It has not been established for
> any of the other eight.** The presence of a newer-looking sibling name is not a successor
> proof; an unreferenced name in this tree is not an unreferenced name in production.

---

## 3. PROTECTED — 8 functions

### 3.1 `darajaSTKPush` — PROTECT: live dependants

Three live served-client callers in this tree:

* `merchant-v2.html:2487` — `callStk: _callable('darajaSTKPush')`
* `pos.js:1856` — `httpsCallable(functions, 'darajaSTKPush')`
* `sokoni-mpesa.js:289` — `httpsCallable(getFunctions(fbApp), 'darajaSTKPush')`

This is the POS and merchant STK collection path. Removal breaks live money-in.

**To unblock:** not a retirement candidate. Retire only behind a proven migration of all three
callers, owned by an authorized payment slice.

---

### 3.2 `darajaSTKCallback` — PROTECT: live dependants + **externally registered**

The strongest protection in the set. This endpoint's URL is **published to sellers as the
callback they register with Safaricom**:

* `payments.html:432,651,652` — "Copy Callback URL", shown as
  `https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback`
* `seller.html:6882,6883` — same URL, seller-facing copy button

It is also hardcoded as the callback target inside the functions themselves —
`functions/index.js:3779` (from `darajaSTKPush`) and `functions/index.js:4698`
(from `sendTestSTKPush`).

**The URL is held by third parties we do not control.** Sellers have already registered it in
their own Safaricom portals. Deleting the endpoint silently strands every payment confirmation
for every seller who registered it — money taken, never confirmed. Repo-side reference counting
cannot see those registrations.

**To unblock:** never by code search. Requires a seller-registration migration, externally
coordinated. Matches the standing boundary in [[project_daraja_retirement_boundary]] —
*external registration blocks removal*.

---

### 3.3–3.5 The Daraja set — `validateDarajaCredentials`, `sendTestSTKPush`, `webhookMpesa`

**Disposition: PROTECT — joint human decision required. Keep the three together.**

These three are dispositioned as **one unit**, never individually.

| Function | Live served-client callers found in this tree |
|---|---|
| `validateDarajaCredentials` | `pos.js:1984`, `payments.html:1295` |
| `sendTestSTKPush` | `payments.html:1049`, `payments.html:1308` |
| `webhookMpesa` | none in HTML/JS — **by design**: `onRequest` + `invoker:"public"` + Safaricom IP allowlist (`functions/index.js:8793`, allowlist at `:8790`). Its callers are external |

> ### 📌 Correction to the B1 brief's premise
>
> The brief framed these three as *legacy* and cautioned against removing them "merely because
> they are legacy." **The in-tree evidence is stronger than that framing.** Two of the three have
> live served-client callers right now, and the third is an externally-invoked webhook.
>
> This does not weaken the protection — it **strengthens** it. "Legacy" understates the case.
> These are not dormant remnants awaiting a cleanup decision; two are wired into the seller
> Daraja-setup UI and one is a public payment webhook.

`sendTestSTKPush` posts to the same `darajaSTKCallback` URL (`functions/index.js:4698`) that
§3.2 protects, which couples this set to the pair above — the reason they travel together.

`webhookMpesa` shares the `webhookIdempotency` `create()` set-if-not-exists rail with
`webhookIntasend`/`webhookStripe`/`webhookSmartpos` (`functions/index.js:7997`). Removing one
member of that family is a change to a shared payment-idempotency surface.

**To unblock:** a single human decision covering all three at once, taken with the IntaSend
migration owner. **Not** three independent calls.

---

### 3.6 `expireBoosts` — PROTECT: reconcile lineage first

**Absent from this RC tree entirely** — zero occurrences anywhere under `functions/`.

Recovery exists on the production lineage:

* `release/r1-pos-printer-fn:functions/index.js:9993` — `exports.expireBoosts = onSchedule(`
* `release/r1-pos-printer-fn:functions/entitlement-adapters.js:363` — the engine it drives
  (`engine.revoke()` clears the entitlement)
* **Not present on `main`.**

A scheduled function. Its absence from this tree is a **lineage gap, not a retirement** — the
RC simply does not carry it. It is live in production and doing work (boost expiry / entitlement
revocation) that nothing in this tree replaces.

**To unblock:** establish provenance and obsolescence first. **Do not reconstruct it and do not
silently copy it into this RC** — that would manufacture a third lineage on top of the two that
already diverge.

---

### 3.7 `pickupHandover` — PROTECT: reconcile lineage first

**Absent from this RC tree entirely** — zero occurrences anywhere under `functions/`.

Recovery exists on the production lineage:

* `release/r1-pos-printer-fn:functions/delivery-complete.js:305` — `exports.pickupHandover = onCall(`
* `release/r1-pos-printer-fn:functions/index.js:11928` — re-exported by name
* `release/r1-pos-printer-fn:functions/delivery-complete.js:453` — carries a `_pickupHash`,
  i.e. it participates in delivery-completion integrity
* **Not present on `main`.**

Same class as §3.6, and higher risk: this sits on the delivery-completion path, adjacent to
the completion-trust and payout rails.

**To unblock:** same as §3.6 — provenance and obsolescence first, no reconstruction, no silent copy.

---

### 3.8 `posSendPurchaseOrder` — PROTECTED / UNPROVEN OBSOLESCENCE

**Deliberately retired from the RC source on 2026-09-03** (ADR-018), and the retirement is
guarded: five suites assert it stays retired via
`!/^exports\.posSendPurchaseOrder\s*=/m` — `scripts/test-auto-reorder-slice-f.js:217`,
`test-draft-reconciliation-slice-g.js:315`, `test-po-approval-send-slice-c.js:308`,
`test-po-convergence-slice-b.js:272`, `test-procurement-merchant-authority.js:292`.

The retirement rationale on record (`functions/index.js:11549`, `functions/pos-retail.js:204`)
is unusually strong: zero code-level callers, plus **zero Cloud Logging invocation entries
across the full ~30-day retention window**, against a control query (`poscompletecheckout`,
122 entries same window) proving the logging pipe was not silently empty. Superseded by
`procurement.sendPurchaseOrder`, which has real callers (`inventory.html`, `pos-suppliers.js`).

**It nonetheless stays PROTECTED.** Two gaps remain between that record and a production deletion:

1. **A monitoring window is not reachability.** Thirty days of silence is evidence of disuse,
   not proof of unreachability. A quarterly or seasonal procurement path would not appear.
2. **Production provenance is unestablished.** The retirement was *committed to source*, never
   deployed. The live function is therefore from a different lineage, and no one has confirmed
   the deployed blob matches the source that was reasoned about. The repo's only remaining
   references are tests asserting non-revival — **those prove nothing about live callers.**

**To unblock:** confirm the deployed blob's provenance, and confirm the successor's behaviour
actually covers the retired path in production. Only then is deletion a source-consistent act
rather than a bet.

---

## 4. The protection list, in one table

| # | Function | Class | Why protected | Unblocked by |
|---|---|---|---|---|
| 1 | `darajaSTKPush` | Live dependants | 3 live callers: `merchant-v2.html:2487`, `pos.js:1856`, `sokoni-mpesa.js:289` | Proven caller migration, payment slice |
| 2 | `darajaSTKCallback` | Live dependants + external | URL published to sellers for Safaricom registration (`payments.html:432/651/652`, `seller.html:6882`) | Seller-registration migration; never code search |
| 3 | `validateDarajaCredentials` | Daraja set — joint | Live callers `pos.js:1984`, `payments.html:1295` | One joint decision on all three |
| 4 | `sendTestSTKPush` | Daraja set — joint | Live callers `payments.html:1049,1308`; posts to the protected callback | One joint decision on all three |
| 5 | `webhookMpesa` | Daraja set — joint | Public webhook, Safaricom IP allowlist; shares `webhookIdempotency` rail | One joint decision on all three |
| 6 | `expireBoosts` | Lineage | Absent from RC; lives at `r1-pos-printer-fn:index.js:9993`; drives entitlement revoke | Provenance + obsolescence; no reconstruction |
| 7 | `pickupHandover` | Lineage | Absent from RC; lives at `r1-pos-printer-fn:delivery-complete.js:305`; on delivery-completion integrity path | Provenance + obsolescence; no reconstruction |
| 8 | `posSendPurchaseOrder` | Unproven obsolescence | Source-retired 2026-09-03 but **never deployed**; live blob provenance unconfirmed; 30-day window ≠ reachability | Deployed-blob provenance + successor behaviour in production |

---

## 5. What was NOT done

* ❌ No function deleted, from source or from production.
* ❌ No deploy list created. No deploy. No push.
* ❌ `expireBoosts` / `pickupHandover` **not** reconstructed, copied, or cherry-picked into this RC.
* ❌ No IntaSend payment code touched — `payment-adapters.js`, `pos-intasend-initiation.js`,
  `pos-collection-proof.js`, wallet/ledger, commission, `onPaymentIntentPaid`, marketplace
  payment flows and card-payment work were all left alone.
* ❌ No Loyalty touch of any kind (§0).
* ❌ No unrelated code modified. This slice added one document and one CHANGELOG entry.

## 6. Next

B1 is **closed for this release** with zero deletions. It is not a standing approval to delete
later: each of the ten still carries the unblock conditions in §4, and the two V1s need a
finalized deployment plan before their retirement is executed.

Priority order from here: **B1 (done) → B3 clean provenance/push gate → Fingerprint Phase 0
audit → device/peripheral convergence → P58E hardware certification → final release gates.**
Every one of those slices continues to respect the Loyalty boundary in §0 and must preserve the
deployed device-security fixes.

See [[B3_CLEAN_PROVENANCE_GATE]] for the next gate's verdict.
