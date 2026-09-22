# Communications live-lineage port — dependency manifest

> **Base:** `111dbd7` (`ship/catalogue-port-on-live`) · **Worktree:** `C:/temp/sok-commsport`
> (`release/comms-on-live`) · **Source:** `feat/integrations-control-center`
> **Built:** 2026-09-22, from the require graph — not from the commit list.
>
> Related: [[PROVENANCE_GAP_MERCHANT_IDENTITY]] · [[SOKONI_CONNECT]] · [[SOKONI_COMMUNICATION_ENGINE]]

The source branch is **+436 / −579** against live. Porting it wholesale would drag hundreds of
unrelated changes across. This manifest is the closure of what Communications actually needs,
computed by walking `require()` edges from the production entry points and classifying every
file reached against the live tree.

**A clean git merge is not evidence of a valid Functions port.** The previous attempt merged
`index.js` cleanly and still produced a tree whose requires did not resolve. The closure is
computed against the *target*, not the source.

## Entry points seeded

```
connect-calls.js · connect-dispatch.js · connect-notify.js
communication-send.js · communication-timeline.js · messages.js
```

27 files reached, no unresolved edges.

## LIVE ALREADY — identical, nothing to do (5)

`company-identity.js` · `email-service.js` · `email-templates.js` · `sms-service.js` ·
`sokoni-at.js`

## PORT REQUIRED — absent from live (15)

**Connect server foundation**
`shared/connect-authority.js` · `shared/connect-call-surface.js` · `shared/connect-consent.js` ·
`connect-calls.js` · `connect-dispatch.js` · `connect-notify.js`

**Communication engine**
`shared/communication-envelope.js` · `shared/communication-router.js` ·
`shared/communication-providers.js` · `shared/communication-templates.js` ·
`communication-send.js` · `communication-timeline.js`

**Outbox server half**
`shared/message-identity.js`

**Video entitlement foundation** — reached only via `connect-calls.js → capability-authority.js`
`capability-authority.js` · `healthcare-plans.js`

> `healthcare-plans.js` arrives as a **transitive dependency of `capability-authority.js`**, not as
> healthcare work. It is required at module top level, so omitting it is a `MODULE_NOT_FOUND` at
> deploy time — the exact failure the previous attempt hit.

## DROPPED — reached only through changes Communications does not own (2)

| File | Why it appeared | Why it is dropped |
|---|---|---|
| `order-advance-authority.js` | required by the **feature branch's** `notify.js` | live `notify.js` does not require it, and the Communications hunk does not add it |
| `shop-employees.js` | same | same |

Both vanish from the closure once `notify.js` is ported as a **minimal hunk** rather than a whole
file. This is the difference between a 17-file and a 15-file port, and it is entirely a
consequence of not copying files wholesale.

## CONFLICTS — present live, and different (5)

Each was resolved by asking the only question that matters: **does Communications require this
change, or did it arrive from another feature that happens to share the branch?**

| File | Δ lines | Decision | Evidence |
|---|---|---|---|
| `delivery-authority.js` | 12 | **PRESERVE LIVE** | the diff adds `authorizeHandover` (seller-handover work). Communications uses only `resolveActor` and `RIDER_FIELDS`; live's `resolveActor({ uid, token, delivery, order })` signature and all three field lists are **identical** |
| `subscription-core.js` | 51 | **PRESERVE LIVE** | the diff adds the `merchantSubscriptions` canonical store — subscription work that **changes commission rates**. `capability-authority.js` calls exactly one member, `subCore.resolveSubscription`, which live exports |
| `subscription-catalog.js` | 151 | **PRESERVE LIVE** | `capability-authority.js` calls exactly one member, `catalog.entitlementFor`, which live exports |
| `notify.js` | 143 | **MINIMAL HUNK** | Communications owns only the optional business-anchor fields (`anchorType`/`anchorId`) and the `shared/communication-envelope` validation. Everything else is other features' drift |
| `messages.js` | 523 | **MINIMAL HUNK** | Communications owns only the outbox idempotency: the `MSGID` require, the `clientMessageId` parameter, the derived document id, `batch.create()`, and the `accepted`/`duplicate` response |

Three of five conflicts resolve to **preserve live** — the port modifies two live files, not five.

## index.js

Treated as an **integration point, not a source of truth**. Only the registrations the
Communications callables need are added. The file is not merged wholesale, because it is the one
file that decides what a deploy ships.

The merchant-identity registration at `index.js:11511-11512` is **already present in the base**
and must be left exactly as found — see [[PROVENANCE_GAP_MERCHANT_IDENTITY]]. That is how the
provenance gate closes, and a wholesale merge of `index.js` from the feature branch would
**undo it**.

## Hosting surfaces (separate from the server closure)

`sokoni-outbox.js` · `sokoni-connect-call.js` · `sokoni-comms-console.js` ·
`sokoni-support-contact.js` · `sokoni-connect-client.js` · `connect.html` ·
and the mounted pages `delivery-tracking.html`, `seller-delivery.html`, `store.html`,
`my-orders.html`, `support.html`, `status.html`.

Each is classified the same way at port time; a page that exists live is edited by hunk, never
replaced, so unrelated live work on it survives.

## Verification required ON THE PORTED TREE

No feature-branch result may be reused as evidence. The port must independently produce:

```
require closure · index.js load · function-registration-provenance
connect authority · communication engine · contract shapes
delivery anchor · delivery mount · seller delivery · shop inquiry · shop boundary
outbox · outbox Firestore · rules · health honesty
AdminOS wiring/render/security · capability consumers · subscription consistency
deployment guard · working tree clean
```

Plus a **live-file preservation check**: the production-sensitive surfaces
(`functions/index.js`, `firestore.rules`, auth/payment modules, existing HTML entry points,
deployment guards) are diffed base-vs-port and every modification classified. Anything
Communications does not own must read **unchanged**.
