# 21F-2b-MESSAGES-PARTICIPANT-AUTHORITY

> **CLOSED on the release line. THE HOLE IS LIVE IN PRODUCTION.** The authority repair
> predates this gate (`bcf9df7`, certified 51/0); this gate established that production
> does **not** have it, proved the repair holds under real concurrency, and fixed two
> concurrency defects it found. Certified by
> `scripts/test-messages-participant-concurrency.js` (**26/0**, real Firestore engine)
> and `scripts/test-messages-participant-authority.js` (**51/0**). **No deployment** —
> Step 22 is separate and ungranted.

## A correction I owe the record

I reported this as an **unfixed** defect when scoping the conversation-layer work. That
was wrong, and it came from reading `docs/MESSAGES_PARTICIPANT_ANCHORING.md`, which says
"Participants are whatever the client says they are" and is stamped *"Status: INSPECTION.
Nothing changed."* That document was accurate when written and was never updated after
`bcf9df7` repaired the thing it describes. **A document that records a defect rots the
moment the defect is fixed**, and it rotted into a false statement about the release line.
It now carries a header pointing here.

The underlying claim was not entirely wrong, though — it was wrong about the *lineage*.

## What is actually true, per lineage

| | release line (`HEAD`) | **production** |
|---|---|---|
| participants | derived from the transaction | **taken from `req.data`** |
| caller check | must be a party **named by the transaction** | only that the caller **named themselves** |
| `PARTY_FIELDS` / `_partiesOf` | present | **0 occurrences** |

Evidence: the manifest records the deployed copy as byte-identical to merge-base
`adb619f`, and `git show adb619f:functions/messages.js` shows
`const { …, participantUids, … } = req.data` with `participantUids.includes(uid)` as the
only guard, and no `PARTY_FIELDS`.

**So in production today, a caller can name an arbitrary uid and have it recorded as a
conversation participant.** Naming yourself is not entitlement, and the production build
still treats it as such. This is a deploy-blocking finding, not a repo finding.

## Step 1–2: which transactions can name their own parties

`PARTY_FIELDS` covers **8 of the 17** anchors. The other 9 are refused with
`failed-precondition` rather than defaulted, because an empty participant list would
create a conversation nobody can read — a different bug, not a fix.

`scripts/deploy/census-conversation-party-fields.js` reads the table from the module
itself and `TX_COLLECTIONS` from the source, so neither can drift from this census, then
looks for uid-shaped fields in every writer of each anchor collection:

```
8 covered · 0 refused-with-candidates · 9 refused-with-nothing   (of 17 anchors)
```

**Nothing is being wrongly refused.** All 9 refused collections have **no writer at all**
— not in `functions/`, and not client-side (grep positive-controlled against `orders` 87
files, `bookings` 11, `supportTickets` 3). There is no transaction to anchor to.

**One anchor points at the wrong collection.** `TX_COLLECTIONS.rfq → 'rfqs'`, but RFQs are
written to **`b2bRFQs`** (`sokoni-b2b.js:142`), localStorage-first with a Firestore mirror.
So the `rfq` anchor could never have resolved. Recorded, **not fixed** — B2B is
localStorage-only and must not be routed yet, and changing `TX_COLLECTIONS` is a change to
the messaging contract that deserves its own gate.

→ `21F-2b-RFQ-ANCHOR-COLLECTION`.

## Step 8: what the concurrency test found

The authority suite runs on an **in-memory double**, which has no contention to
reproduce. The repair moved a *read that decides what gets written* into the create path,
and two parties pressing the button at the same instant is the normal case — so it was
measured on a real engine.

Eight concurrent opens by three parties reported:

```
before:  8 created, 0 existing      after:  1 created, 7 existing
         (exactly ONE conversation document in both cases)
```

**This was never a duplicate-conversation defect.** One document, correct participants.
It was two other things:

1. **`isNew` was declared outside the transaction callback and never reset.** The callback
   re-runs on retry, so an attempt that set it true and then lost the race left it true —
   the function returned `existing:false` to a caller that created nothing, and logged a
   creation that did not happen. A contract lie and an observability lie.
2. **The conversation document was written with `t.set()`, which overwrites.** Two
   attempts that both passed the read would each write it — the `get()`+`set()` shape this
   platform has a standing rule against (`a621ba7`). Now `t.create()`: the loser fails,
   retries, sees the document and takes the existing path.

The per-user index writes stay `t.set()` **deliberately** — they are idempotent and
identical between racers, and `create()` there would fail a legitimate retry.

**Participant derivation is unchanged by this gate.**

## Certification

`scripts/test-messages-participant-concurrency.js` — **26/0**, refuses to run without
`FIRESTORE_EMULATOR_HOST` because an in-memory double would pass trivially.

* eight concurrent opens → one document, one id for every caller, **one creator**;
* the participant set is the transaction's parties and identical for every caller;
* each party gets **exactly one** inbox item, not one per concurrent call;
* a stranger racing the parties is refused `permission-denied` and leaves no inbox entry;
* a **forged `participantUids` array is inert** — not merely also-checked, ignored;
* **SABOTAGE** on the same engine under identical load: check-then-act outside a
  transaction yields **8 documents versus 1**.

The in-memory double in the authority suite gained a `create()` that **refuses an existing
document** — a double that behaved like `set()` would have hidden the property under test,
and the suite would have gone green on a lie.

## Regression

```
messages-participant-authority 51/0 · messages-participant-concurrency 26/0 (real engine)
merchant-messages 64/0 · merchant-messages-ui 195/0 · sokoni-conversation-layer 23/0
functions-reconciliation 97/0 · functions-implementation 70/0 · release-contract 54/0
authority-frozen 26/0 · idempotency-claims 19/0 · index.js loads, 1748 exports
```

## Scope held

`a6c000a` was treated as a frozen starting point and **not modified retroactively**. The
WhatsApp census was not reopened; the 26-region authority freeze is untouched; the
Premium Provider Dashboard and card restructuring were not started; no POS/Till/Payments
capability was made client-authoritative.

## Still open

1. **Production is unrepaired.** The participant hole is live and can only be closed by a
   deployment, which is Step 22 and ungranted.
2. **`21F-2b-RFQ-ANCHOR-COLLECTION`** — the `rfq` anchor names a collection nothing writes.
3. **`21F-2b-CONVERSATION-DATA-PROJECTION`** — most surfaces still cannot *start* a
   conversation, because their records carry a phone and a name but no counterparty uid.
4. **`21F-2b-SOKONI-INBOX-RETIREMENT`** — `sokoni-inbox.js` is a second, non-functional
   conversation model whose client writes the rules block.

Related: [[B931_GATE_SOKONI_CONVERSATION_LAYER]] · [[MESSAGES_PARTICIPANT_ANCHORING]] ·
[[B931_REPAIR_QUEUE]]
