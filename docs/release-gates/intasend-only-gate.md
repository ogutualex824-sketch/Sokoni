# IntaSend-Only Payment Gate

Evidence for the owner's end state: every SOKONI-mediated payment goes through IntaSend, Daraja is not an active rail,
and no browser manufactures a paid or completed state. Measured 2026-10-03. Related: [[Payments]], [[SmartPOS]],
[[Orders]], [[Daraja Retirement]].

**Status: NOT CLEAN.** Production must not be called migrated yet. Functions deploys continue, each with an explicit
`--only functions:<name>,…` allow-list, never a blanket deploy.

## How to measure

```
node scripts/intasend-only-gate.js <tree>          # human-readable
node scripts/intasend-only-gate.js <tree> --json   # for tables
```

Read-only. It strips comments, then reports:

| Class | Meaning |
|---|---|
| ACTIVE | executable Daraja: an export, a callable name, a Safaricom endpoint, Daraja config, the C2B module, Daraja setup copy |
| FABRICATED | client code that invents a payment: a `SIMULATED_` reference, or a timer that announces payment or writes `paid` |
| OLD_GUARD | `scripts/deploy/guard-functions-safety.js` still protects Daraja, a separate migration condition |
| BLANKET | a script that runs `firebase deploy` for functions without `--only` |

`initiateSTKPush` is IntaSend (a generic name) and is counted as allowed. Comments, docs and test fixtures are history.

## The gate

| Item | Status | Evidence |
|---|---|---|
| Till uses IntaSend | Open | Live `till.html` still calls `darajaSTKPush`, which is not deployed. Fixed on sokoni-2f's union `hosting/pos-stk-plus-earn-on-72dca56` (`sokoni-pos-stk.js`), not deployed. |
| Merchant Dashboard uses IntaSend | Open | Same as the till: `merchant-v2.html` fixed on the union, not deployed. |
| Marketplace checkout uses IntaSend | M-Pesa done; card built | M-Pesa is live: `createCheckoutSession` prices, IntaSend's form collects, `verifyIntasendPayment` confirms server-to-server. Card on `hosting/intasend-card-wizard-on-72dca56` (5aa9fe3), not deployed. |
| SmartPOS M-Pesa | Built | `hosting/pos-stk-route-on-a436e12` (99e1177, sokoni-2f) routes `sendSTK` through the IntaSend POS rail; the invented `SIMULATED_` sale is removed (a436e12). Not deployed. Server gap: `posCompleteCheckout` does not read `posPaymentStatus` for M-Pesa lines (POS lane). |
| All SOKONI payment intents resolve to IntaSend | Partial | `createPaymentIntent` purposes go to IntaSend. BnB, car hire, car tracking, healthcare, legal, digital, delivery and rent have no server-priced IntaSend purpose. Delivery and landlord call IntaSend from the browser with a client amount. |
| `webhookIntasend` is the authoritative confirmation | Partial | Two IntaSend webhooks still diverge; a callback with no state writes FAILED (open). Marketplace confirms through `verifyIntasendPayment`. |
| No browser can fabricate a successful payment | Fixed in code, live until deploy | Live: BnB (4-second "Payment confirmed!"), landlord (3-second "Payment Confirmed!" and rent `paid:true`), POS (`SIMULATED_`). All removed on the card branch (265b1f7, a436e12), not deployed. Landlord's IntaSend path still writes local rent `paid:true` on the browser's COMPLETE event (client-trusted). |
| No active Daraja STK path | Production yes, source no | No Daraja function exists in production: four deleted 2026-10-03, three never deployed. Source: only my two branches are clean of Daraja server code. |
| Old Daraja guard removed from active code | Open | Rewritten on 093fd4f and 3a2e150. Still the old guard in 10 of 17 trees below. |
| Queued deployment tree checked | Not clean | `sok-home2` (the merchant functions deploy) has the old guard and Daraja exports. Its deploy is scoped, so it cannot recreate Daraja. |
| Each agent tree checked | Done, all not clean | Table below. |
| Every functions deploy uses an explicit allow-list | Agreed | 0 blanket deploy scripts in any tree. sokoni-2f and sokoni-5b deploy scoped. |
| No blanket `firebase deploy` | Agreed | Until every tree carries the removal. |
| Production deployment only after clean evidence | Not met | — |

## Trees

Columns count files. Functions = Daraja server code; Website = Daraja in pages or scripts.

| Tree | Commit | Branch | Functions | Website | Fabricated | Old guard | Result |
|---|---|---|---|---|---|---|---|
| sok-card | 3a2e150 | `hosting/intasend-card-wizard-on-72dca56` | 0 | 2 | 0 | no | not clean |
| sok-nodaraja | 093fd4f | `chore/remove-daraja-code-on-6e7bfe2` | 0 | 9 | 3 | no | not clean |
| sok-home2 | 6e7bfe2 | `hosting/uploadedat-on-2bcdae2` | 2 | 9 | 3 | yes | not clean |
| sok-finpartner | 2b8e602 | `feat/financial-partner-on-f66f2c1` | 2 | 9 | 3 | yes | not clean |
| sok-k13b | f66f2c1 | `hotfix/k13b-lifecycle-decision-authority` | 2 | 9 | 3 | yes | not clean |
| sok-posstk | 20b92fa | `hosting/pos-stk-plus-earn-on-72dca56` | 2 | 7 | 3 | yes | not clean |
| sok-parcel-fn2 | 7091029 | `feat/parcel-rail-fn-on-5a0935e` | 2 | 3 | 2 | no | not clean |
| sok-reports-fn | c85621d | `feat/community-reports-fn-on-7091029` | 2 | 3 | 2 | no | not clean |
| sok-settle | 9a0f67f | `fix/settle-gate-on-oosc-00065` | 2 | 9 | 3 | yes | not clean |
| sok-found | 8aedd10 | `feat/foundation-on-3a38f35` | 2 | 9 | 3 | no | not clean |
| sok-fhost | 6717106 | `hosting/banking-foundation-on-f13a912` | 2 | 7 | 3 | yes | not clean |
| sok-fpw2 | a64296e | `feat/financial-partner-workspace-on-9012d90` | 2 | 9 | 3 | yes | not clean |
| sok-conv-fn | 6be1561 | `convergence/commercial-fn-on-ef1e992` | 2 | 3 | 0 | no | not clean |
| sok-whdraft | b026856 | `draft/b1-webhook-gate-on-68811e1` | 2 | 0 | 0 | no | not clean |
| sok-media | ab1a5db | `feat/foundation-media-worker-on-3b56f40` | 2 | 9 | 3 | no | not clean |
| sok-mv2lazy | eed285a | `hosting/mv2-lazy-modules-on-6e7bfe2` | 2 | 9 | 3 | yes | not clean |
| sok-aos-head | d223415 | `hosting/aos-head-defer-on-95425eb` | 2 | 9 | 3 | yes | not clean |

`sok-nodaraja` is the server-only removal, so its website files are untouched; `sok-card` carries both.

## Convergence rules

- **Server code:** each tree takes a **cherry-pick of 093fd4f only**, never a merge of its branch, which sits on a
  hosting-line tree. Then: the guard passes, no AST reference to a removed name remains, and the gates are green.
- **Website code:** the card branch is the reference. sokoni-2f's union fixes the till and merchant dashboard;
  `scripts/test-daraja-leftovers.js` only lets its pending list shrink.
- **Another agent's tree:** never edited blindly. Each owner converges at its own deploy.

## Certification state (owner, 2026-10-03)

| Unit | State |
|---|---|
| sokoni-e3 parcel tree | GREEN locally |
| sokoni-e3 reports tree | GREEN locally |
| card-method branch (5aa7711 + port) | GREEN locally |
| parcel IntaSend method recording | GREEN locally |
| **SOKONI estate** | **NOT CERTIFIED** |
| **Production** | **NO DEPLOYMENT** |

Local green is not a release. Each still needs the estate-level gate, an exact deploy scope, the 512 MB prerequisite and the
remaining payment-security work. Convergence means copying only the approved repairs into each tree, preserving ownership,
re-running the tree-local gate, then the estate-level gate. The lawyer test on the a545818 line stays recorded as
pre-existing drift: never fixed by changing the test or the role model; re-run and classify when that line takes the
role update. Website Daraja hits stay separate: clean server trees are not edited to remove non-server references.

## Progress since the first measurement

- **sok-parcel-fn2** (sokoni-e3): Daraja removal hand-ported onto the 5a0935e line (8d64df0); functions/ CLEAN, guard PASS.
  093fd4f does not cherry-pick onto that line (9 conflicts, no guard file), hence the hand port.
- **fix/payment-method-from-provider-on-5a0935e** (sokoni-b2) @ f9e596d: card-method fix (Gates 8/12) plus that port; functions/
  CLEAN, guard PASS, executed method test 6/0. Ships alone: `--only functions:verifyIntasendPayment`.
- **sok-reports-fn** (sokoni-e3) @ cd293bb: same hand port; functions/ CLEAN, guard PASS, AST 0 references (positive control 29),
  their moderation/takedown/gateway work byte-for-byte intact. Pre-existing jest failure on that lineage, not from the port:
  `application-lifecycle.test.js:132` expects Lawyer → legal; the a545818 line predates the Roles Phase 2 vocabulary (lineage drift).
- **sok-parcel-fn2** e61c73e: confirmParcelPayment records the provider method (5aa7711 mapping), KES only; matrix 17/17.
- LEGACY_INACTIVE cleanups found: `functions/financial-engine.js` has no caller since `darajaSTKCallback` went; four historical
  `certify-*` scripts still reference `mpesa-c2b.js`.

## Open items and owners

| Item | Owner |
|---|---|
| Server-priced IntaSend purposes for BnB, car hire, car tracking, healthcare, legal, digital, delivery, rent | Payments, functions slice |
| `posCompleteCheckout` must read `posPaymentStatus` for M-Pesa lines | POS lane |
| One authoritative IntaSend webhook; stateless callback must not write FAILED | Webhook containment |
| Landlord's client-trusted COMPLETE writes local rent `paid:true` | Property hub |
| Server: card orders recorded as `paymentMethod: "mpesa"` by `verifyIntasendPayment` | Payments, functions slice |
| Card proven enabled on the SOKONI IntaSend account (the probe creates real invoices) | Owner consent |
