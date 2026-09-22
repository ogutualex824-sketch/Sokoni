# Notification-path bypass — migration backlog

**Status:** ASSESSED. **No code changed.** No migration authorized.
**Date:** 2026-09-22
**Measured by:** `node scripts/audit-communication-anchors.js`

Related: [[SOKONI_COMMUNICATION_ENGINE]]

---

## What this is, precisely

Seven modules write the in-app `notifications` collection **directly**, through a local
`_notify` helper, instead of calling `notify.js`.

**This is notification-path fragmentation, not communication-transport fragmentation** — a
correction to how it was first described. They do **not** bypass push, SMS or email routing,
because they never enter that pipeline at all. They send nothing.

What they do bypass:

| Bypassed | Consequence |
|---|---|
| notification preferences | a user who muted a category still gets the in-app row |
| quiet hours | irrelevant in practice — an in-app row makes no sound |
| deduplication | a retried Cloud Function can write the row twice |
| the `notifyLog` audit record | the send is not in the audit trail |
| the business anchor | the row could not join a timeline (**now fixed for two of them**) |

---

## The seven, measured

| Module | `_notify` calls | Anchored? | Legitimate anchor available? |
|---|---|---|---|
| `automation-engine.js` | 14 | **yes** (162) | partly — see below |
| `sub-billing.js` | 8 | no | **no** — subscription is not an approved anchor |
| `sub-engine.js` | 6 | no | **no** — same |
| `financial-os.js` | 5 | **yes** (162) | yes, via `metadata.orderId` / `bookingId` |
| `loyalty.js` | 4 | no | **no** — loyalty is not an approved anchor |
| `franchise-engine.js` | 3 | no | **no** — a franchise application is not one either |
| `installments.js` | 3 | no | possibly — an installment plan usually has an order |

Two were wired in (162), additively: the anchor is recorded on the row they already write, and
**no send path was added and no routing changed**.

---

## The finding that matters more than the count

**Four of the five remaining have no approved business anchor at all.**

`sub-billing`, `sub-engine`, `loyalty` and `franchise-engine` notify about subscriptions,
points and applications. None of those is one of the six approved anchors
(`order`, `inquiry`, `booking`, `delivery`, `supply`, `support`), and none of them should be
forced into one.

> A notification about a loyalty tier is genuinely context-free with respect to the business
> relationships the timeline is built on. Anchoring it to "the last order this person placed"
> would raise a coverage number and file a real communication under a relationship it has
> nothing to do with — where somebody would later read it as evidence.

So the honest ceiling is not 100%. **The correct end state leaves these outside the unified
business timeline**, recorded as unanchored, which is what they are.

`installments.js` is the one genuine candidate: an installment plan is usually tied to an
order. It is not wired because nobody has confirmed that `plan.orderId` is populated in
practice, and this backlog does not guess.

---

## Why nothing was migrated

These are **money-, subscription- and loyalty-adjacent paths**. Converting a local `_notify`
into `notify.notify()` is not a refactor: it changes what the user receives, because the engine
applies preferences, quiet hours, dedupe and channel routing that the local helper does not.
A subscription-expiry notice that currently always appears in-app could start being suppressed
by a preference nobody realised applied to it.

That is a **behaviour change to live revenue paths** and needs its own slice, its own owner
decision, and its own before/after evidence.

---

## THE MIGRATION GATE

**This table is the gate.** No module moves from a local `_notify` to the engine until every
row is answered with the evidence named — not with an argument that it is probably fine.

| Question | Required evidence |
|---|---|
| What business relationship does this notification describe? | A canonical anchor, or a stated finding that none exists |
| Is that anchor present at the call site? | Code path **and** production data evidence — a field that exists in the schema but is empty in practice is not present |
| Does the engine preserve existing recipients? | Before/after comparison, per notification type |
| Does suppression change? | Before/after evidence — which preference category it lands in, and whether that suppression is intended |
| Does dedupe change? | Before/after evidence — whether the engine's key would collapse notifications that are currently distinct |
| Does notification count change? | A measured baseline, per type, before the change |
| Does user-visible behaviour change? | Regression or end-to-end evidence |
| Can rollback be demonstrated? | A rollback procedure that has been exercised, not described |

The first two rows decide whether a migration is even *possible*. The remaining six decide
whether it is *safe*.

**`sub-billing` and `installments` carry the most weight here**, because these are not
cosmetic notifications — they sit in revenue-related user flows. A subscription-expiry notice
that currently always appears in-app could start being suppressed by a preference nobody
realised applied to it, and the first person to notice would be a merchant whose till stopped.

Until the table is answered, the modules stay as they are, and the coverage number stays
honestly low.

---

## Current position

```
Engine callers passing an anchor : 3 of 13   (23%)
Local in-app writers             : 7 modules, 43 calls
  …anchored additively           : 2  (automation-engine, financial-os)
  …no approved anchor exists     : 4  (sub-billing, sub-engine, loyalty, franchise-engine)
  …candidate, unconfirmed        : 1  (installments)
```

**23% with known boundaries is more trustworthy than 100% obtained by inventing
relationships.**
